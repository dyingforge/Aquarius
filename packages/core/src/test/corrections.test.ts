import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, writeCodexSession, ageFile, type TestEnvironment } from './harness.ts';
import { classifyCorrection } from '../corrections/service.ts';

async function ingest(env: TestEnvironment, sessionId: string, userMessages: string[]): Promise<void> {
  const path = await writeCodexSession(env.root, { sessionId, userMessages });
  await ageFile(path);
  await env.service.ingest({});
}

test('correction classification distinguishes the four documented kinds', () => {
  assert.equal(classifyCorrection('忘记这条记忆'), 'forget');
  assert.equal(classifyCorrection('这条记忆是错的'), 'correction');
  assert.equal(classifyCorrection('我现在改成用 pnpm 了'), 'temporal_change');
  assert.equal(classifyCorrection('补充一下，另外还用 Vitest'), 'content_edit');
});

test('a preview changes nothing until it is confirmed', async () => {
  const env = await createEnvironment();
  try {
    await ingest(env, '01a00000-0000-7000-8000-000000000301', ['部署分支是 develop']);
    const before = await env.service.store.head();
    const memory = (await env.service.listMemories({ limit: 50 })).memories[0]!;

    const preview = await env.service.previewCorrection({
      instruction: `${memory.title} 其实是 main 分支，我记错了`,
    });
    assert.equal(preview.baseHead, before);
    assert.ok(preview.memoryIds.includes(memory.memoryId));
    assert.match(preview.diff, /^[-+]/m, 'the preview must contain a real diff');
    assert.equal(await env.service.store.head(), before, 'a preview must not move HEAD');

    // Cancelling leaves the repository untouched.
    const stillThere = await env.service.getMemory(memory.memoryId);
    assert.equal(stillThere.status, 'active');
    assert.equal(await env.service.store.head(), before);
  } finally {
    await env.cleanup();
  }
});

test('confirming a correction commits it and immediately affects later queries', async () => {
  const env = await createEnvironment();
  try {
    await ingest(env, '01a00000-0000-7000-8000-000000000302', ['包管理器是 npm']);
    const memory = (await env.service.listMemories({ limit: 50 })).memories[0]!;

    const preview = await env.service.previewCorrection({
      instruction: `${memory.title} 这条记错了，应该是 pnpm`,
    });
    const applied = await env.service.confirmCorrection({ reviewId: preview.reviewId, expectedHead: preview.baseHead });
    assert.ok(applied.commitSha);
    assert.notEqual(applied.commitSha, preview.baseHead);

    const old = await env.service.getMemory(memory.memoryId);
    assert.equal(old.status, 'superseded', 'the corrected version is closed rather than rewritten');
    assert.ok(old.supersededBy, 'a correction records the replacement relationship');
    assert.equal(old.validTo !== null, true, 'the closed record keeps a validity window');

    const replacement = await env.service.getMemory(old.supersededBy!);
    assert.equal(replacement.status, 'active');
    assert.match(replacement.body, /pnpm/);
    assert.match(replacement.confidenceReason, /correction/i);

    // The new state is what queries see.
    const answer = await env.service.query('包管理器');
    assert.ok(answer.memoryIds.includes(replacement.memoryId));
    assert.ok(!answer.memoryIds.includes(memory.memoryId), 'the superseded version must not be used');
  } finally {
    await env.cleanup();
  }
});

test('a correction is refused when HEAD moved after the preview', async () => {
  const env = await createEnvironment();
  try {
    await ingest(env, '01a00000-0000-7000-8000-000000000303', ['CI 使用 GitHub Actions']);
    const memory = (await env.service.listMemories({ limit: 50 })).memories[0]!;
    const preview = await env.service.previewCorrection({ instruction: `${memory.title} 补充：只在 main 上运行` });

    // Something else writes in the meantime.
    await ingest(env, '01a00000-0000-7000-8000-000000000304', ['测试命令是 pnpm test']);

    await assert.rejects(
      () => env.service.confirmCorrection({ reviewId: preview.reviewId, expectedHead: preview.baseHead }),
      (error: { code?: string }) => {
        assert.equal(error.code, 'stale_head');
        return true;
      },
    );

    // And with a mismatched expectedHead that is not the preview base.
    const currentHead = await env.service.store.head();
    await assert.rejects(
      () => env.service.confirmCorrection({ reviewId: preview.reviewId, expectedHead: currentHead }),
      (error: { code?: string }) => {
        assert.equal(error.code, 'stale_head');
        return true;
      },
    );
  } finally {
    await env.cleanup();
  }
});

test('an expired preview cannot be confirmed', async () => {
  const env = await createEnvironment();
  try {
    await ingest(env, '01a00000-0000-7000-8000-000000000305', ['编辑器是 Neovim']);
    const memory = (await env.service.listMemories({ limit: 50 })).memories[0]!;
    const preview = await env.service.previewCorrection({ instruction: `${memory.title} 改成 VS Code` });

    // Expire it by hand, as if the TTL had passed.
    env.service.database.run('UPDATE reviews SET expires_at = ? WHERE review_id = ?', [
      new Date(Date.now() - 1_000).toISOString(),
      preview.reviewId,
    ]);

    await assert.rejects(
      () => env.service.confirmCorrection({ reviewId: preview.reviewId, expectedHead: preview.baseHead }),
      (error: { code?: string }) => {
        assert.equal(error.code, 'review_expired');
        return true;
      },
    );
    assert.equal(env.service.reviewService.list({ status: 'expired' }).length, 1);
  } finally {
    await env.cleanup();
  }
});

test('a correction preview with no matching memory reports a clear error', async () => {
  const env = await createEnvironment();
  try {
    await assert.rejects(
      () => env.service.previewCorrection({ instruction: '完全无关的删除请求 zzzz' }),
      (error: { code?: string }) => {
        assert.equal(error.code, 'not_found');
        return true;
      },
    );
  } finally {
    await env.cleanup();
  }
});

test('forget removes the memory from the current view without promising to erase history', async () => {
  const env = await createEnvironment();
  try {
    await ingest(env, '01a00000-0000-7000-8000-000000000306', ['我的家庭住址是某条私人信息']);
    const memory = (await env.service.listMemories({ limit: 50 })).memories[0]!;
    const preview = await env.service.previewCorrection({ instruction: `${memory.title} 忘记这条` });
    assert.match(preview.notes.join(' '), /Git history/, 'the preview must state what forget does not do');
    assert.equal(preview.type, 'forget');

    await env.service.confirmCorrection({ reviewId: preview.reviewId, expectedHead: preview.baseHead });
    const detail = await env.service.getMemory(memory.memoryId);
    assert.equal(detail.status, 'forgotten');

    // The old text is still in Git history, by design.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);
    const history = await run('git', ['log', '--all', '--format=%H', '-S', '家庭住址'], { cwd: env.memoryRepoPath });
    assert.ok(history.stdout.trim() !== '', 'the commit that introduced it remains in history');
  } finally {
    await env.cleanup();
  }
});
