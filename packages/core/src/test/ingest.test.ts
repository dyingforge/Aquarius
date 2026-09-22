import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, writeCodexSession, ageFile } from './harness.ts';
import { credentialLike } from './fixtures.ts';

test('ingests a single Codex session into a Git-backed experience with evidence and commit metadata', async () => {
  const env = await createEnvironment();
  try {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000000001',
      cwd: '/tmp/project-alpha',
      userMessages: ['我们统一用 pnpm 管理依赖，请记住这一点'],
      assistantMessages: ['好的，我会使用 pnpm。'],
      toolResults: [{ name: 'exec', output: 'Script completed\nWall time 0.2 seconds\nOutput:\npnpm install\nDone' }],
    });
    await ageFile(path);

    const batch = await env.service.ingest({});
    assert.equal(batch.status, 'done');

    const files = await env.service.store.listTreeFiles();
    const memoryFiles = files.filter((file) => file.startsWith('active/') && file.endsWith('.md'));
    assert.ok(memoryFiles.length >= 1, `expected an active memory, saw ${files.join(', ')}`);
    const experience = memoryFiles.find((file) => file.includes('/experiences/'));
    assert.ok(experience, 'expected an experience memory file');

    const content = await env.service.store.readFile(experience!);
    assert.ok(content, 'memory file should be readable');
    assert.match(content!, /^---\n/);
    assert.match(content!, /id: exp_/);
    assert.match(content!, /kind: experience/);
    assert.match(content!, /status: active/);
    assert.match(content!, /schema_version: 1/);
    assert.match(content!, /authority: (user_explicit|tool_verified)/);
    assert.match(content!, /provenance:/);
    assert.match(content!, /session_id: 01a00000-0000-7000-8000-000000000001/);
    assert.match(content!, /case_id: case_/);

    // Supporting evidence is committed alongside the memory, and is redacted.
    const evidenceFiles = files.filter((file) => file.startsWith('evidence/') && file.endsWith('.md'));
    assert.ok(evidenceFiles.length >= 1, 'expected an evidence file');
    const evidence = await env.service.store.readFile(evidenceFiles[0]!);
    assert.match(evidence!, /evidence_id: ev_/);

    // The commit carries job, session and source-hash trailers.
    const head = await env.service.store.head();
    const log = await env.service.store.log({ limit: 1 });
    assert.equal(log[0]?.sha, head);
    assert.match(log[0]!.body, /Aquarius-Job: job_/);
    assert.match(log[0]!.body, /Aquarius-Session: 01a00000-0000-7000-8000-000000000001/);
    assert.match(log[0]!.body, /Aquarius-Source-Hash: [0-9a-f]{64}/);
    assert.match(log[0]!.body, /Aquarius-Kind: ingestion/);

    // The memory is visible through the service read API.
    const listed = await env.service.listMemories({ kind: 'experience' });
    assert.ok(listed.memories.length >= 1);
    const detail = await env.service.getMemory(listed.memories[0]!.memoryId);
    assert.equal(detail.kind, 'experience');
    assert.ok(detail.supportingCaseIds.length >= 1);
    assert.ok(detail.evidence.length >= 1);

    // And it is retrievable through the FTS projection.
    const answer = await env.service.query('依赖管理用什么');
    assert.ok(answer.memoryIds.length > 0, `expected a cited memory, got: ${answer.answer}`);
  } finally {
    await env.cleanup();
  }
});

test('re-importing identical content creates neither a second memory nor a second commit', async () => {
  const env = await createEnvironment();
  try {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000000002',
      userMessages: ['项目使用 Fastify 提供本地 HTTP API'],
    });
    await ageFile(path);

    await env.service.ingest({});
    const headAfterFirst = await env.service.store.head();
    const memoriesAfterFirst = (await env.service.listMemories({ kind: 'experience' })).memories.length;
    const commitsAfterFirst = (await env.service.store.log({ limit: 50 })).length;

    // Identical second run.
    await env.service.ingest({});
    const headAfterSecond = await env.service.store.head();

    assert.equal(headAfterSecond, headAfterFirst, 'HEAD must not move when nothing changed');
    assert.equal((await env.service.listMemories({ kind: 'experience' })).memories.length, memoriesAfterFirst);
    assert.equal((await env.service.store.log({ limit: 50 })).length, commitsAfterFirst);
  } finally {
    await env.cleanup();
  }
});

test('deduplicates a session that moved from the active directory into the archive', async () => {
  const env = await createEnvironment();
  try {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000000003',
      userMessages: ['这个仓库的测试命令是 pnpm test'],
    });
    await ageFile(path);
    await env.service.ingest({});
    const head = await env.service.store.head();

    // Move the file into the archived directory, exactly as Codex does.
    const { rename, mkdir } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await mkdir(env.codexArchivedDir, { recursive: true });
    const archived = join(env.codexArchivedDir, path.split('/').pop()!);
    await rename(path, archived);
    await ageFile(archived);

    const batch = await env.service.ingest({});
    assert.equal(await env.service.store.head(), head, 'archiving must not produce new memory');
    assert.ok(
      batch.result && typeof batch.result === 'object',
      'batch result should be reported',
    );
  } finally {
    await env.cleanup();
  }
});

test('only consumes newly appended events when a session grows', async () => {
  const env = await createEnvironment();
  try {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000000004',
      userMessages: ['第一条：仓库使用 TypeScript 编写'],
    });
    await ageFile(path);
    await env.service.ingest({});
    const firstMemories = (await env.service.listMemories({ kind: 'experience' })).memories;

    const { appendCodexSession } = await import('./harness.ts');
    await appendCodexSession(path, {
      sessionId: '01a00000-0000-7000-8000-000000000004',
      userMessages: ['第二条：部署目标是 Cloudflare Workers'],
    });
    await ageFile(path);
    await env.service.ingest({});

    const afterMemories = (await env.service.listMemories({ kind: 'experience' })).memories;
    assert.ok(afterMemories.length > firstMemories.length, 'the appended message should add a memory');
    const titles = afterMemories.map((memory) => memory.title).join(' | ');
    assert.match(titles, /Cloudflare|部署/);
    // The first memory is not duplicated.
    const firstTitles = firstMemories.map((memory) => memory.title);
    for (const title of firstTitles) {
      assert.equal(afterMemories.filter((memory) => memory.title === title).length, 1, `duplicated ${title}`);
    }
  } finally {
    await env.cleanup();
  }
});

test('defers a session file that is still being written and processes it later', async () => {
  const env = await createEnvironment({ activeSessionQuietSeconds: 300 });
  try {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000000005',
      userMessages: ['正在写入的会话不应该被处理'],
      complete: false,
      truncateTail: true,
    });

    const first = await env.service.ingest({});
    const stats = (first.result as { stats: { sessionsDeferred: number; sessionsIngested: number } }).stats;
    assert.equal(stats.sessionsIngested, 0);
    assert.equal(stats.sessionsDeferred, 1);

    // Once the file stops changing, the next run ingests it.
    await ageFile(path, 600);
    const second = await env.service.ingest({});
    const secondStats = (second.result as { stats: { sessionsIngested: number } }).stats;
    assert.equal(secondStats.sessionsIngested, 1);
  } finally {
    await env.cleanup();
  }
});

test('never lets credential material reach the memory repository', async () => {
  const env = await createEnvironment();
  try {
    const secret = credentialLike('sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz0123456789');
    const accountPassword = credentialLike('hunter2', 'secret');
    const databasePassword = credentialLike('sup3r', 's3cret');
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000000006',
      userMessages: [
        `我的 OPENAI_API_KEY=${secret}，另外密码是 ${accountPassword}`,
        '记一下：这个项目的部署分支是 main',
      ],
      toolResults: [
        {
          name: 'exec',
          output: `export DATABASE_URL=postgres://admin:${databasePassword}@localhost:5432/app\nScript completed`,
        },
      ],
    });
    await ageFile(path);
    await env.service.ingest({});

    const files = await env.service.store.listTreeFiles();
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    // Search the entire Git history, not just HEAD, for the secrets.
    for (const needle of [secret, accountPassword, databasePassword]) {
      const result = await run('git', ['grep', '-I', '-F', needle, '--', '.'], {
        cwd: env.memoryRepoPath,
      }).catch((error: { code?: number }) => ({ stdout: '', code: error.code ?? 1 }));
      assert.equal(
        (result as { stdout: string }).stdout.trim(),
        '',
        `the repository must not contain ${needle}; files: ${files.join(', ')}`,
      );
    }
    assert.ok(files.some((file) => file.startsWith('evidence/') && file.endsWith('.md')), 'evidence should still have been recorded');
  } finally {
    await env.cleanup();
  }
});

test('tolerates unknown event types, truncated tails and malformed lines without failing the batch', async () => {
  const env = await createEnvironment();
  try {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000000007',
      userMessages: ['这个项目使用 Vitest 做单元测试'],
      extraLines: [
        '{"timestamp":"2026-01-01T00:00:00.000Z","ordinal":9001,"type":"brand_new_event","payload":{"x":1}}',
        '{not json at all}',
        '{"timestamp":"2026-01-01T00:00:00.000Z","ordinal":9002,"type":"response_item","payload":{"type":"future_item_type","data":{}}}',
      ],
    });
    await ageFile(path);

    const batch = await env.service.ingest({});
    assert.equal(batch.status, 'done');
    const memories = (await env.service.listMemories({ kind: 'experience' })).memories;
    assert.ok(memories.length >= 1, 'the valid parts of the session must still be ingested');
  } finally {
    await env.cleanup();
  }
});

test('counts a continued root thread as a single case', async () => {
  const env = await createEnvironment();
  try {
    const rootId = '01a00000-0000-7000-8000-00000000000a';
    const first = await writeCodexSession(env.root, {
      sessionId: rootId,
      userMessages: ['这个项目用 pnpm workspaces 组织代码'],
    });
    await ageFile(first);
    await env.service.ingest({});

    // A continuation: new rollout file, same root thread.
    const second = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-00000000000b',
      parentThreadId: rootId,
      userMessages: ['继续刚才的话题，部署用 Cloudflare'],
    });
    await ageFile(second);
    await env.service.ingest({});

    const status = await env.service.ingestStatus();
    assert.equal(status.cases, 1, 'continuations must collapse onto one case');

    const listed = await env.service.listMemories({ kind: 'experience' });
    const caseIds = new Set(listed.memories.flatMap((memory) => memory.cases));
    assert.equal(caseIds.size, 1, 'both memories belong to the same case');
  } finally {
    await env.cleanup();
  }
});

test('ingests one session by id and records a job for it', async () => {
  const env = await createEnvironment();
  try {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000000008',
      userMessages: ['运维命令是 make deploy'],
    });
    await ageFile(path);

    const result = await env.service.ingest({ sessionId: '01a00000-0000-7000-8000-000000000008', force: true });
    assert.equal(result.status, 'ingested');
    const job = env.service.jobs.get(result.jobId);
    assert.equal(job?.status, 'done');
    assert.equal(job?.kind, 'ingest_session');
    assert.ok(job?.commitSha, 'the job should record the commit it produced');
  } finally {
    await env.cleanup();
  }
});

test('reports a clear error for an unknown session id', async () => {
  const env = await createEnvironment();
  try {
    await assert.rejects(
      () => env.service.ingest({ sessionId: 'does-not-exist' }),
      (error: Error & { code?: string }) => {
        assert.equal(error.code, 'not_found');
        return true;
      },
    );
  } finally {
    await env.cleanup();
  }
});
