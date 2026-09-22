import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, writeCodexSession, ageFile, type TestEnvironment } from '@aquarius/core/testing';
import { buildApp } from './app.ts';
import { extractBearerToken, isLoopbackAddress } from './auth.ts';
import type { FastifyInstance } from 'fastify';

const TOKEN = 'test-token';

async function withServer<T>(
  fn: (context: { env: TestEnvironment; app: FastifyInstance; request: (options: RequestOptions) => Promise<Response> }) => Promise<T>,
  options: { remoteAddressOverride?: string } = {},
): Promise<T> {
  const env = await createEnvironment({ apiToken: TOKEN });
  const app = buildApp({ service: env.service, ...options });
  await app.listen({ host: '127.0.0.1', port: 0 });
  const address = app.server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const base = `http://127.0.0.1:${address.port}`;

  const request = (requestOptions: RequestOptions): Promise<Response> =>
    fetch(`${base}${requestOptions.path}`, {
      method: requestOptions.method ?? 'GET',
      headers: {
        ...(requestOptions.token === null ? {} : { authorization: `Bearer ${requestOptions.token ?? TOKEN}` }),
        ...(requestOptions.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(requestOptions.body !== undefined ? { body: JSON.stringify(requestOptions.body) } : {}),
    });

  try {
    return await fn({ env, app, request });
  } finally {
    await app.close();
    await env.cleanup();
  }
}

interface RequestOptions {
  path: string;
  method?: 'GET' | 'POST';
  token?: string | null;
  body?: unknown;
}

test('token extraction and loopback detection cover the documented forms', () => {
  assert.equal(extractBearerToken('Bearer abc'), 'abc');
  assert.equal(extractBearerToken('bearer abc'), 'abc');
  assert.equal(extractBearerToken('Basic abc'), null);
  assert.equal(extractBearerToken(undefined), null);

  assert.equal(isLoopbackAddress('127.0.0.1'), true);
  assert.equal(isLoopbackAddress('::1'), true);
  assert.equal(isLoopbackAddress('::ffff:127.0.0.1'), true);
  assert.equal(isLoopbackAddress('192.168.1.10'), false);
  assert.equal(isLoopbackAddress(undefined), false);
});

test('health is reachable without a token but exposes only a minimal view', async () => {
  await withServer(async ({ request }) => {
    const anonymous = await request({ path: '/health', token: null });
    assert.equal(anonymous.status, 200);
    const minimal = (await anonymous.json()) as Record<string, unknown>;
    assert.equal(typeof minimal['status'], 'string');
    assert.equal(minimal['version'], '0.1.0');
    assert.equal(minimal['memoryRepo'], undefined, 'the anonymous view must not leak operational detail');

    const authenticated = await request({ path: '/health' });
    const full = (await authenticated.json()) as Record<string, unknown>;
    assert.ok(full['memoryRepo'], 'the authenticated view reports repository state');
    assert.ok(full['index']);
    assert.ok(full['schedule']);
  });
});

test('requests without a token are rejected', async () => {
  await withServer(async ({ request }) => {
    const response = await request({ path: '/v1/memories', token: null });
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: { code: string; actionable?: string } };
    assert.equal(body.error.code, 'unauthorized');
    assert.ok(body.error.actionable);
  });
});

test('requests with a wrong token are rejected', async () => {
  await withServer(async ({ request }) => {
    const response = await request({ path: '/v1/memories', token: 'not-the-token' });
    assert.equal(response.status, 401);
    assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'unauthorized');
  });
});

test('non-loopback callers are rejected even with a valid token', async () => {
  await withServer(
    async ({ request }) => {
      const response = await request({ path: '/v1/memories' });
      assert.equal(response.status, 403);
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'forbidden');
    },
    { remoteAddressOverride: '203.0.113.7' },
  );
});

test('the HTTP query contract matches the service contract exactly', async () => {
  await withServer(async ({ env, request }) => {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000002001',
      userMessages: ['我们统一使用 pnpm 管理依赖，请记住这一点'],
    });
    await ageFile(path);
    await env.service.ingest({});

    const http = await request({ path: '/v1/query', method: 'POST', body: { question: '依赖管理用什么' } });
    assert.equal(http.status, 200);
    const viaHttp = (await http.json()) as Record<string, unknown>;

    const viaService = await env.service.query('依赖管理用什么');
    assert.deepEqual(viaHttp, JSON.parse(JSON.stringify(viaService)) as Record<string, unknown>);
    assert.ok((viaHttp['memoryIds'] as string[]).length > 0);
  });
});

test('memory reads are available over HTTP with the same shape as the service', async () => {
  await withServer(async ({ env, request }) => {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000002002',
      userMessages: ['部署目标平台是 Cloudflare Workers'],
    });
    await ageFile(path);
    await env.service.ingest({});

    const list = await request({ path: '/v1/memories?kind=experience' });
    assert.equal(list.status, 200);
    const listed = (await list.json()) as { memories: { memoryId: string }[] };
    assert.ok(listed.memories.length >= 1);

    const one = await request({ path: `/v1/memories/${listed.memories[0]!.memoryId}` });
    assert.equal(one.status, 200);
    const detail = (await one.json()) as Record<string, unknown>;
    assert.equal(detail['memoryId'], listed.memories[0]!.memoryId);
    assert.ok(detail['provenance']);

    const missing = await request({ path: '/v1/memories/mem_does_not_exist' });
    assert.equal(missing.status, 404);
  });
});

test('confirmation endpoints require the HEAD the preview was built on', async () => {
  await withServer(async ({ env, request }) => {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000002003',
      userMessages: ['运行时版本固定为 Node 24'],
    });
    await ageFile(path);
    await env.service.ingest({});

    const listed = (await (await request({ path: '/v1/memories' })).json()) as { memories: { memoryId: string; title: string }[] };
    const target = listed.memories[0]!;

    const previewResponse = await request({
      path: '/v1/corrections/preview',
      method: 'POST',
      body: { instruction: `${target.title} 改成 Node 22` },
    });
    assert.equal(previewResponse.status, 200);
    const preview = (await previewResponse.json()) as { reviewId: string; baseHead: string };

    // Without a matching expectedHead the confirmation is refused.
    const stale = await request({
      path: `/v1/corrections/${preview.reviewId}/confirm`,
      method: 'POST',
      body: { expectedHead: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef' },
    });
    assert.equal(stale.status, 409);
    assert.equal(((await stale.json()) as { error: { code: string } }).error.code, 'stale_head');

    const confirmed = await request({
      path: `/v1/corrections/${preview.reviewId}/confirm`,
      method: 'POST',
      body: { expectedHead: preview.baseHead },
    });
    assert.equal(confirmed.status, 200);
    const applied = (await confirmed.json()) as { commitSha: string };
    assert.ok(applied.commitSha);
  });
});

test('malformed request bodies are rejected with a validation error', async () => {
  await withServer(async ({ request }) => {
    const missing = await request({ path: '/v1/query', method: 'POST', body: {} });
    assert.equal(missing.status, 422);
    assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'validation_failed');

    const wrongType = await request({ path: '/v1/reviews/x/resolve', method: 'POST', body: { decision: 'explode' } });
    assert.equal(wrongType.status, 422);

    const unknownReview = await request({ path: '/v1/reviews/rev_nope', token: TOKEN });
    assert.equal(unknownReview.status, 404);
  });
});

test('the doctor and config endpoints report readiness without leaking secrets', async () => {
  await withServer(async ({ request }) => {
    const doctor = (await (await request({ path: '/v1/doctor' })).json()) as {
      ok: boolean;
      checks: { name: string; status: string }[];
    };
    assert.equal(doctor.ok, true);
    assert.ok(doctor.checks.some((check) => check.name === 'auth'));

    const config = (await (await request({ path: '/v1/config' })).json()) as { config: Record<string, unknown> };
    assert.equal(config.config['apiToken'], undefined, 'the token must never be returned');
    assert.equal(config.config['hasApiToken'], true);
    assert.equal(config.config['openaiApiKey'], undefined);
  });
});

test('index rebuild is available over HTTP and restores the projection', async () => {
  await withServer(async ({ env, request }) => {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000002004',
      userMessages: ['代码风格使用 Prettier 默认配置'],
    });
    await ageFile(path);
    await env.service.ingest({});

    env.service.database.exec('DELETE FROM memory_fts');
    env.service.database.exec('DELETE FROM memory_index');

    const response = await request({ path: '/v1/index/rebuild', method: 'POST' });
    assert.equal(response.status, 200);
    const report = (await response.json()) as { entries: number; head: string };
    assert.ok(report.entries >= 1);
    assert.equal(env.service.projection.count(), report.entries);
  });
});

test('skill routes expose candidates and require an approval HEAD', async () => {
  await withServer(async ({ env, request }) => {
    const list = await request({ path: '/v1/skills' });
    assert.equal(list.status, 200);
    assert.deepEqual(((await list.json()) as { skills: unknown[] }).skills, []);

    const missing = await request({ path: '/v1/skills/skl_missing' });
    assert.equal(missing.status, 404);

    const approve = await request({
      path: '/v1/skills/skl_missing/approve',
      method: 'POST',
      body: { expectedHead: null, approvedBy: 'tester' },
    });
    assert.equal(approve.status, 404);
    void env;
  });
});

test('ingestion can be triggered and inspected over HTTP', async () => {
  await withServer(async ({ env, request }) => {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000002005',
      userMessages: ['本地服务端口是 8787'],
    });
    await ageFile(path);

    const response = await request({ path: '/v1/ingestions', method: 'POST', body: { force: true } });
    assert.equal(response.status, 200);
    const job = (await response.json()) as { jobId: string; status: string };
    assert.equal(job.status, 'done');

    const fetched = await request({ path: `/v1/jobs/${job.jobId}` });
    assert.equal(fetched.status, 200);
    const record = (await fetched.json()) as { status: string; commitSha: string | null };
    assert.equal(record.status, 'done');
    assert.ok(record.commitSha);

    const status = (await (await request({ path: '/v1/ingestions/status' })).json()) as {
      sessions: { ingested: number };
      schedule: { hour: number; timeZone: string };
    };
    assert.ok(status.sessions.ingested >= 1);
    assert.equal(status.schedule.hour, 3);
    assert.equal(status.schedule.timeZone, 'Asia/Shanghai');

    const unknown = await request({ path: '/v1/jobs/job_nope' });
    assert.equal(unknown.status, 404);
  });
});
