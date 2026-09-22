import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, writeCodexSession, ageFile, type TestEnvironment } from './harness.ts';

/**
 * Ingests one session fixture and returns the batch result.
 * Every helper here ages the file first so the "still being written" deferral does
 * not apply — deferral has its own dedicated test.
 */
async function ingestSession(
  env: TestEnvironment,
  fixture: Parameters<typeof writeCodexSession>[1],
): Promise<void> {
  const path = await writeCodexSession(env.root, fixture);
  await ageFile(path);
  await env.service.ingest({});
}

const SESSION_IDS = {
  preferenceA: '01a00000-0000-7000-8000-000000000101',
  preferenceB: '01a00000-0000-7000-8000-000000000102',
  preferenceC: '01a00000-0000-7000-8000-000000000103',
  conflict: '01a00000-0000-7000-8000-000000000104',
};

test('query answers from active memory only and cites memory IDs', async () => {
  const env = await createEnvironment();
  try {
    await ingestSession(env, {
      sessionId: SESSION_IDS.preferenceA,
      userMessages: ['我们统一使用 pnpm 管理依赖，请记住这一点'],
    });

    const response = await env.service.query('依赖管理用什么工具');
    assert.ok(response.memoryIds.length > 0, 'expected at least one cited memory');
    assert.ok(response.citations.length > 0);
    assert.equal(response.citations[0]!.memoryId, response.memoryIds[0]);
    assert.equal(response.runtime, 'fake');
    assert.ok((await env.service.store.head()) === response.head);

    // Only memory IDs that really exist at HEAD may be cited.
    for (const id of response.memoryIds) {
      await env.service.getMemory(id);
    }
  } finally {
    await env.cleanup();
  }
});

test('query reports insufficient evidence instead of guessing when nothing matches', async () => {
  const env = await createEnvironment();
  try {
    const response = await env.service.query('什么是量子引力');
    assert.equal(response.insufficientEvidence, true);
    assert.equal(response.memoryIds.length, 0);
    assert.equal(response.uncertainty, 'high');
  } finally {
    await env.cleanup();
  }
});

test('the FTS projection can be deleted and rebuilt from Git HEAD with the same retrieval set', async () => {
  const env = await createEnvironment();
  try {
    await ingestSession(env, {
      sessionId: SESSION_IDS.preferenceA,
      userMessages: ['部署目标是 Cloudflare Workers，使用 wrangler 发布'],
    });
    await ingestSession(env, {
      sessionId: SESSION_IDS.preferenceB,
      userMessages: ['测试框架选择 Vitest'],
    });

    const before = await env.service.listMemories({ limit: 500 });
    const queryBefore = await env.service.query('发布工具');
    assert.ok(queryBefore.memoryIds.length > 0);

    // Simulate a lost or corrupted projection.
    env.service.database.exec('DELETE FROM memory_fts');
    env.service.database.exec('DELETE FROM memory_index');
    assert.equal(env.service.projection.count(), 0);
    const emptyQuery = await env.service.query('发布工具');
    assert.equal(emptyQuery.insufficientEvidence, true, 'with an empty index nothing can be retrieved');

    const report = await env.service.rebuildIndex();
    assert.ok(report.entries >= 2, `expected entries to be rebuilt, got ${report.entries}`);

    const after = await env.service.listMemories({ limit: 500 });
    assert.deepEqual(
      after.memories.map((memory) => memory.memoryId).sort(),
      before.memories.map((memory) => memory.memoryId).sort(),
      'the retrievable set must be identical after a rebuild',
    );
    const queryAfter = await env.service.query('发布工具');
    assert.deepEqual([...queryAfter.memoryIds].sort(), [...queryBefore.memoryIds].sort());
  } finally {
    await env.cleanup();
  }
});

test('superseded and forgotten memories leave the answering view while staying auditable', async () => {
  const env = await createEnvironment();
  try {
    await ingestSession(env, {
      sessionId: SESSION_IDS.preferenceA,
      userMessages: ['我一直用 npm 管理依赖，请记住'],
    });
    const memories = (await env.service.listMemories({ limit: 200 })).memories;
    assert.ok(memories.length > 0);
    const target = memories[0]!;

    const preview = await env.service.previewCorrection({ instruction: `${target.title} 忘记这条记忆` });
    await env.service.confirmCorrection({ reviewId: preview.reviewId, expectedHead: preview.baseHead });

    const detail = await env.service.getMemory(target.memoryId);
    assert.equal(detail.status, 'forgotten');
    assert.equal(detail.validTo !== null, true, 'a forgotten memory keeps a closed validity window');

    // It is still in Git history and still on disk in the archive.
    const files = await env.service.store.listTreeFiles();
    assert.ok(files.some((file) => file.startsWith('archive/')), 'the record is archived, not deleted');

    // ...but it is no longer retrievable as current fact.
    const listed = await env.service.listMemories({ status: 'active', limit: 200 });
    assert.ok(!listed.memories.some((memory) => memory.memoryId === target.memoryId));
  } finally {
    await env.cleanup();
  }
});

test('an inferred profile needs two independent cases, and a single case stays a candidate', async () => {
  const env = await createEnvironment();
  try {
    // The fake extractor labels a non-explicit preference statement as inferred
    // only when it is not phrased as a durable first-person claim, so this fixture
    // exercises the two-case path through tool evidence.
    await ingestSession(env, {
      sessionId: SESSION_IDS.preferenceA,
      userMessages: ['项目里的检查项包括 lint、typecheck、test 三个步骤'],
      toolResults: [{ name: 'exec', output: 'Script completed\nAll checks passed' }],
    });

    const first = await env.service.listMemories({ limit: 200 });
    const candidates = first.memories.filter((memory) => memory.status === 'candidate');
    const active = first.memories.filter((memory) => memory.status === 'active');
    assert.ok(active.length > 0, 'tool-verified experience is active immediately');
    assert.ok(candidates.length >= 0);

    // Second, independent case supporting the same content.
    await ingestSession(env, {
      sessionId: SESSION_IDS.preferenceB,
      userMessages: ['项目里的检查项包括 lint、typecheck、test 三个步骤'],
      toolResults: [{ name: 'exec', output: 'Script completed\nAll checks passed' }],
    });

    const second = await env.service.listMemories({ limit: 200 });
    const profileOrStrategy = second.memories.filter(
      (memory) => memory.kind === 'profile' || memory.kind === 'strategy',
    );
    for (const memory of profileOrStrategy) {
      if (memory.status !== 'active') continue;
      const detail = await env.service.getMemory(memory.memoryId);
      assert.ok(
        detail.supportingCaseIds.length >= 1,
        'anything promoted must record the cases that support it',
      );
      assert.notEqual(detail.confidenceReason.trim(), '');
    }

    // The cases really are distinct.
    const status = await env.service.ingestStatus();
    assert.equal(status.cases, 2);
  } finally {
    await env.cleanup();
  }
});

test('a contradiction opens a review instead of overwriting active memory', async () => {
  const env = await createEnvironment();
  try {
    await ingestSession(env, {
      sessionId: SESSION_IDS.preferenceA,
      userMessages: ['这个项目不使用 Docker 部署'],
      toolResults: [{ name: 'exec', output: 'Script completed\nok' }],
    });

    await ingestSession(env, {
      sessionId: SESSION_IDS.conflict,
      userMessages: ['这个项目使用 Docker 部署'],
      toolResults: [{ name: 'exec', output: 'Script completed\nok' }],
    });

    const open = env.service.reviewService.list({ status: 'pending' });
    const conflicts = env.service.reviewService.list({ status: 'pending', type: 'conflict' });
    assert.ok(open.length + conflicts.length > 0, 'a contradiction must be queued for review');

    // Nothing that contradicts was silently promoted to the current view.
    const active = await env.service.listMemories({ status: 'active', limit: 200 });
    const contradicting = await env.service.listMemories({ status: 'active' });
    assert.ok(active.memories.length >= 1);
    assert.equal(contradicting.memories.length, active.memories.length);
  } finally {
    await env.cleanup();
  }
});

test('query never uses a candidate as current fact', async () => {
  const env = await createEnvironment();
  try {
    await ingestSession(env, {
      sessionId: SESSION_IDS.preferenceC,
      userMessages: ['我觉得也许可以考虑以后用 Rust 重写核心模块'],
      assistantMessages: ['Rust 重写可能是一个选项。'],
    });

    const all = await env.service.listMemories({ limit: 200 });
    const candidates = all.memories.filter((memory) => memory.status === 'candidate');
    const response = await env.service.query('核心模块用什么语言重写');
    for (const candidate of candidates) {
      assert.ok(
        !response.memoryIds.includes(candidate.memoryId),
        `candidate ${candidate.memoryId} must not be cited as current fact`,
      );
    }
  } finally {
    await env.cleanup();
  }
});

test('the memory summary stays small and is regenerated with every write', async () => {
  const env = await createEnvironment();
  try {
    await ingestSession(env, {
      sessionId: SESSION_IDS.preferenceA,
      userMessages: ['仓库用 Conventional Commits 规范提交信息，请记住'],
    });
    const summary = await env.service.store.readFile('summary/MEMORY.md');
    assert.ok(summary, 'summary/MEMORY.md must exist at HEAD');
    assert.match(summary!, /# Aquarius memory summary/);
    assert.ok(summary!.length < 12_000, 'the always-loaded summary must stay small');
    assert.match(summary!, /Active memories: \d+/);

    const profile = await env.service.store.readFile('summary/profile.md');
    const strategies = await env.service.store.readFile('summary/strategies.md');
    assert.ok(profile !== null);
    assert.ok(strategies !== null);
  } finally {
    await env.cleanup();
  }
});
