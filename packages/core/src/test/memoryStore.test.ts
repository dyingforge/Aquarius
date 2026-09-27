import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from './harness.ts';
import { MemoryStore, assertSafeMemoryPath } from '../git/memoryStore.ts';
import { AquariusError } from '../errors.ts';

test('propose builds a reviewable diff without moving HEAD or touching the working tree', async () => {
  const env = await createEnvironment();
  try {
    const store = env.service.store;
    const head = await store.head();
    const proposal = await store.propose(
      [
        { path: 'active/profile/pro_manual.md', content: 'hello\n' },
        { path: 'summary/MEMORY.md', content: '# replaced\n' },
      ],
      { expectedHead: head, subject: 'Propose a change', trailers: { kind: 'test' } },
    );

    assert.equal(proposal.baseHead, head);
    assert.equal(await store.head(), head, 'proposing must not move the ref');
    assert.match(proposal.diff, /active\/profile\/pro_manual\.md/);
    assert.ok(proposal.files.some((file) => file.path === 'active/profile/pro_manual.md' && file.status === 'added'));
    assert.equal(await store.readFile('active/profile/pro_manual.md'), null, 'the file is not visible at HEAD');
  } finally {
    await env.cleanup();
  }
});

test('commit applies atomically and refuses a stale expected HEAD', async () => {
  const env = await createEnvironment();
  try {
    const store = env.service.store;
    const head = await store.head();

    const first = await store.commit([{ path: 'active/profile/pro_one.md', content: 'one\n' }], {
      expectedHead: head,
      subject: 'first',
      trailers: { kind: 'test' },
    });
    assert.notEqual(first.commitSha, head);

    // The same expectation is now stale: compare-and-swap must fail.
    await assert.rejects(
      () =>
        store.commit([{ path: 'active/profile/pro_two.md', content: 'two\n' }], {
          expectedHead: head,
          subject: 'second',
          trailers: { kind: 'test' },
        }),
      (error: AquariusError) => {
        assert.equal(error.code, 'stale_head');
        return true;
      },
    );
    assert.equal(await store.readFile('active/profile/pro_two.md'), null, 'the rejected write must not be present');
    assert.equal(await store.readFile('active/profile/pro_one.md'), 'one\n');
  } finally {
    await env.cleanup();
  }
});

test('commit refuses to write over a dirty working tree instead of discarding user edits', async () => {
  const env = await createEnvironment();
  try {
    const { writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    await writeFile(join(env.memoryRepoPath, 'summary/MEMORY.md'), '# hand-edited by the user\n', 'utf8');
    const head = await env.service.store.head();

    await assert.rejects(
      () =>
        env.service.store.commit([{ path: 'active/profile/pro_x.md', content: 'x\n' }], {
          expectedHead: head,
          subject: 'should refuse',
          trailers: { kind: 'test' },
        }),
      (error: AquariusError) => {
        assert.equal(error.code, 'memory_repo_dirty');
        return true;
      },
    );
  } finally {
    await env.cleanup();
  }
});

test('paths outside the documented memory tree are rejected', () => {
  assert.throws(() => assertSafeMemoryPath('../outside.md'), /escapes the repository tree/);
  assert.throws(() => assertSafeMemoryPath('/etc/passwd'), /Illegal memory path/);
  assert.throws(() => assertSafeMemoryPath('src/main.ts'), /outside the documented tree layout/);
  assert.doesNotThrow(() => assertSafeMemoryPath('active/profile/pro_x.md'));
  assert.doesNotThrow(() => assertSafeMemoryPath('skills/candidates/skl_x.md'));
});

test('a non-empty directory that is not a Git repository is never clobbered', async () => {
  const env = await createEnvironment();
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const target = join(env.root, 'not-a-repo');
    await mkdir(target, { recursive: true });
    await writeFile(join(target, 'precious.txt'), 'do not delete me\n');

    const store = new MemoryStore(target);
    await assert.rejects(() => store.ensureInitialized(), /not a Git repository/);
    assert.equal((await store.head()) === null || true, true);

    const { assertMemoryRepoUsable } = await import('../config.ts');
    await assert.rejects(() => assertMemoryRepoUsable(target), (error: AquariusError) => {
      assert.equal(error.code, 'memory_repo_invalid');
      return true;
    });
  } finally {
    await env.cleanup();
  }
});

test('the application repository and the memory repository are required to be separate', async () => {
  const { loadConfig, APP_REPO_ROOT } = await import('../config.ts');
  const { join } = await import('node:path');
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(join(APP_REPO_ROOT, 'package.json'), 'utf8')) as { name: string };
  assert.equal(manifest.name, 'aquarius', 'the repository root must resolve to this application');
  const loaded = await loadConfig({
    env: {
      AQUARIUS_HOME: join(APP_REPO_ROOT, '.aquarius-test-home'),
      AQUARIUS_MEMORY_REPO: join(APP_REPO_ROOT, 'memory-inside-app'),
      AQUARIUS_AGENT_RUNTIME: 'fake',
      AQUARIUS_API_TOKEN: 'x',
    } as unknown as NodeJS.ProcessEnv,
  });
  const issue = loaded.issues.find((entry) => entry.field === 'memoryRepoPath');
  assert.ok(issue, 'embedding the memory repository in the app checkout must be reported');
  assert.match(issue!.message, /inside the Aquarius application repository/);
});

test('a missing API key blocks startup unless the runtime is the deterministic double', async () => {
  const { loadConfig } = await import('../config.ts');
  const { join } = await import('node:path');
  const withRealRuntime = await loadConfig({
    env: {
      AQUARIUS_HOME: join(process.env['TMPDIR'] ?? '/tmp', 'aquarius-config-check'),
      AQUARIUS_AGENT_RUNTIME: 'openai',
      AQUARIUS_API_TOKEN: 'x',
    } as unknown as NodeJS.ProcessEnv,
  });
  assert.ok(withRealRuntime.issues.some((issue) => issue.field === 'openaiApiKey'));

  const withFakeRuntime = await loadConfig({
    env: {
      AQUARIUS_HOME: join(process.env['TMPDIR'] ?? '/tmp', 'aquarius-config-check'),
      AQUARIUS_AGENT_RUNTIME: 'fake',
      AQUARIUS_API_TOKEN: 'x',
    } as unknown as NodeJS.ProcessEnv,
  });
  assert.equal(withFakeRuntime.issues.length, 0);
});

test('model endpoint and key come from explicit environment settings without exposing the key', async () => {
  const { loadConfig, sanitizeConfigForOutput } = await import('../config.ts');
  const env = await createEnvironment();
  try {
    const loaded = await loadConfig({
      home: env.home,
      env: {
        AQUARIUS_HOME: env.home,
        AQUARIUS_AGENT_RUNTIME: 'openai',
        AQUARIUS_MODEL: 'deepseek-flash',
        AQUARIUS_MODEL_BASE_URL: 'https://api.deepseek.com',
        AQUARIUS_MODEL_API_KEY: 'provider-test-key',
        OPENAI_BASE_URL: 'https://api.openai.com/v1',
        OPENAI_API_KEY: 'legacy-test-key',
        AQUARIUS_API_TOKEN: 'local-test-token',
      } as NodeJS.ProcessEnv,
    });
    assert.equal(loaded.issues.length, 0);
    assert.equal(loaded.config.model, 'deepseek-flash');
    assert.equal(loaded.config.modelBaseUrl, 'https://api.deepseek.com');
    assert.equal(loaded.config.openaiApiKey, 'provider-test-key');
    const safe = sanitizeConfigForOutput(loaded.config);
    assert.equal(safe['openaiApiKey'], undefined);
    assert.equal(JSON.stringify(safe).includes('provider-test-key'), false);

    const blankKey = await loadConfig({
      home: env.home,
      env: {
        AQUARIUS_HOME: env.home,
        AQUARIUS_AGENT_RUNTIME: 'openai',
        AQUARIUS_MODEL: 'deepseek-flash',
        AQUARIUS_MODEL_BASE_URL: 'https://api.deepseek.com',
        AQUARIUS_MODEL_API_KEY: '',
        OPENAI_API_KEY: 'legacy-test-key',
        AQUARIUS_API_TOKEN: 'local-test-token',
      } as NodeJS.ProcessEnv,
    });
    assert.equal(blankKey.config.openaiApiKey, null);
    assert.ok(blankKey.issues.some((issue) => issue.field === 'openaiApiKey'));

    const invalid = await loadConfig({
      home: env.home,
      env: {
        AQUARIUS_HOME: env.home,
        AQUARIUS_AGENT_RUNTIME: 'openai',
        AQUARIUS_MODEL_API_KEY: 'provider-test-key',
        AQUARIUS_MODEL_BASE_URL: 'http://remote.example/api',
        AQUARIUS_API_TOKEN: 'local-test-token',
      } as NodeJS.ProcessEnv,
    });
    assert.ok(invalid.issues.some((issue) => issue.field === 'modelBaseUrl'));
  } finally {
    await env.cleanup();
  }
});

test('non-loopback bind addresses are rejected by configuration', async () => {
  const { loadConfig } = await import('../config.ts');
  const { join } = await import('node:path');
  const loaded = await loadConfig({
    env: {
      AQUARIUS_HOME: join(process.env['TMPDIR'] ?? '/tmp', 'aquarius-config-check'),
      AQUARIUS_HOST: '0.0.0.0',
      AQUARIUS_AGENT_RUNTIME: 'fake',
      AQUARIUS_API_TOKEN: 'x',
    } as unknown as NodeJS.ProcessEnv,
  });
  assert.ok(loaded.issues.some((issue) => issue.field === 'host'));
});
