import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment } from '../test/harness.ts';
import { OpenAIAgentRuntime } from './openaiRuntime.ts';

test('real runtime routes SDK requests to the configured provider endpoint', async () => {
  const env = await createEnvironment();
  const originalFetch = globalThis.fetch;
  let requestUrl: string | null = null;
  let authorization: string | null = null;
  try {
    globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const request = new Request(input, init);
      requestUrl = request.url;
      authorization = request.headers.get('authorization');
      return new Response(JSON.stringify({ error: { message: 'test endpoint reached', type: 'authentication_error' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch;

    const runtime = new OpenAIAgentRuntime({
      config: {
        ...env.config,
        agentRuntime: 'openai',
        model: 'deepseek-flash',
        modelBaseUrl: 'https://api.deepseek.com',
        openaiApiKey: 'provider-test-key',
      },
      readMemoryFile: async () => null,
    });
    const failure = await runtime.selectRelevant({ question: 'Which package manager?', summary: '', candidates: [] }).catch((error: unknown) => error);
    assert.ok(failure instanceof Error);
    assert.equal(requestUrl, 'https://api.deepseek.com/responses', failure.stack ?? failure.message);
    assert.equal(authorization, 'Bearer provider-test-key');
  } finally {
    globalThis.fetch = originalFetch;
    await env.cleanup();
  }
});
