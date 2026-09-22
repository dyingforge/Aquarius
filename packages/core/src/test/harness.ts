import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, appendFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AquariusService } from '../service.ts';
import type { AquariusConfig } from '../config.ts';
import type { AgentRuntime } from '../agents/runtime.ts';
import { FakeAgentRuntime } from '../agents/fakeRuntime.ts';
import { DEFAULT_TIME_ZONE } from '../util/time.ts';

/**
 * Test harness.
 *
 * Every test gets a throwaway home directory: its own SQLite database, its own
 * memory Git repository and its own Codex source tree. The agent runtime defaults
 * to the deterministic double, so the whole pipeline can be exercised without a
 * network call — the real Agents SDK runtime is exercised separately by the
 * optional smoke test.
 */

export interface TestEnvironment {
  root: string;
  home: string;
  memoryRepoPath: string;
  databasePath: string;
  codexSessionsDir: string;
  codexArchivedDir: string;
  codexSessionIndex: string;
  skillInstallDir: string;
  config: AquariusConfig;
  service: AquariusService;
  runtime: AgentRuntime;
  cleanup(): Promise<void>;
}

export interface CreateEnvironmentOptions {
  runtime?: AgentRuntime;
  apiToken?: string;
  activeSessionQuietSeconds?: number;
  timeZone?: string;
  scheduleEnabled?: boolean;
  skillInstallDir?: string;
  redactionExtraPatterns?: string[];
}

export async function createEnvironment(options: CreateEnvironmentOptions = {}): Promise<TestEnvironment> {
  const root = await mkdtemp(join(tmpdir(), 'aquarius-test-'));
  const home = join(root, 'home');
  const memoryRepoPath = join(root, 'memory-repo');
  const databasePath = join(home, 'aquarius.db');
  const codexSessionsDir = join(root, 'codex', 'sessions');
  const codexArchivedDir = join(root, 'codex', 'archived_sessions');
  const codexSessionIndex = join(root, 'codex', 'session_index.jsonl');
  const skillInstallDir = options.skillInstallDir ?? join(root, 'codex', 'skills');

  for (const dir of [home, codexSessionsDir, codexArchivedDir, skillInstallDir]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(codexSessionIndex, '');

  const config: AquariusConfig = {
    home,
    configPath: join(home, 'config.json'),
    databasePath,
    memoryRepoPath,
    host: '127.0.0.1',
    port: 0,
    model: 'fake-deterministic-v1',
    agentRuntime: 'fake',
    openaiApiKey: null,
    tracing: false,
    apiToken: options.apiToken ?? 'test-token',
    apiTokenId: 'tok_test',
    sources: { codexSessionsDir, codexArchivedDir, codexSessionIndex },
    skillInstallDir,
    redactionExtraPatterns: options.redactionExtraPatterns ?? [],
    budgets: {
      runTimeoutMs: 5_000,
      maxTurns: 8,
      maxToolCalls: 16,
      maxOutputTokens: 8_000,
      maxSessionsPerBatch: 25,
    },
    schedule: {
      enabled: options.scheduleEnabled ?? true,
      hour: 3,
      minute: 0,
      timeZone: options.timeZone ?? DEFAULT_TIME_ZONE,
    },
    activeSessionQuietSeconds: options.activeSessionQuietSeconds ?? 0,
    reviewTtlMinutes: 30,
    logLevel: 'error',
  };

  const runtime = options.runtime ?? new FakeAgentRuntime({ model: config.model });
  const service = await AquariusService.createForTest({ config, runtime });
  await service.bootstrap();

  return {
    root,
    home,
    memoryRepoPath,
    databasePath,
    codexSessionsDir,
    codexArchivedDir,
    codexSessionIndex,
    skillInstallDir,
    config,
    service,
    runtime,
    async cleanup(): Promise<void> {
      await service.stop();
      await rm(root, { recursive: true, force: true });
    },
  };
}

export interface CodexSessionFixture {
  /** Directory inside the sessions tree; defaults to today's date layout. */
  dir?: string;
  sessionId: string;
  cwd?: string;
  threadSource?: string | null;
  parentThreadId?: string | null;
  forkedFromId?: string | null;
  cliVersion?: string;
  userMessages?: string[];
  assistantMessages?: string[];
  developerMessages?: string[];
  toolResults?: { name: string; callId?: string; output: string }[];
  complete?: boolean;
  /** Raw extra JSONL lines appended verbatim (used for unknown event types). */
  extraLines?: string[];
  /** Write a final partial line to simulate a file being written right now. */
  truncateTail?: boolean;
  model?: string;
}

let ordinalCounter = 0;
let clockOffset = 0;

function nextOrdinal(): number {
  ordinalCounter += 1;
  return ordinalCounter;
}

function nextTimestamp(): string {
  clockOffset += 1_000;
  return new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + clockOffset).toISOString();
}

/** Builds a Codex-shaped JSONL session file, matching the observed record layout. */
export function buildCodexSessionLines(fixture: CodexSessionFixture): string[] {
  const lines: string[] = [];
  const push = (type: string, payload: Record<string, unknown>): void => {
    lines.push(JSON.stringify({ timestamp: nextTimestamp(), ordinal: nextOrdinal(), type, payload }));
  };

  push('session_meta', {
    session_id: fixture.sessionId,
    id: fixture.sessionId,
    timestamp: nextTimestamp(),
    cwd: fixture.cwd ?? '/tmp/project',
    originator: 'codex_cli',
    cli_version: fixture.cliVersion ?? '0.154.0',
    source: 'cli',
    thread_source: fixture.threadSource ?? 'user',
    model_provider: 'openai',
    ...(fixture.parentThreadId ? { parent_thread_id: fixture.parentThreadId } : {}),
    ...(fixture.forkedFromId ? { forked_from_id: fixture.forkedFromId } : {}),
    base_instructions: { text: 'You are Codex.' },
  });
  push('event_msg', { type: 'task_started' });
  push('turn_context', { cwd: fixture.cwd ?? '/tmp/project', model: fixture.model ?? 'gpt-5', timezone: 'Asia/Shanghai' });
  push('world_state', { state: 'ok' });

  for (const text of fixture.developerMessages ?? []) {
    push('response_item', {
      type: 'message',
      id: `msg_dev_${nextOrdinal()}`,
      role: 'developer',
      content: [{ type: 'input_text', text }],
    });
  }
  for (const text of fixture.userMessages ?? []) {
    push('response_item', {
      type: 'message',
      id: `msg_user_${nextOrdinal()}`,
      role: 'user',
      content: [{ type: 'input_text', text }],
    });
  }
  for (const text of fixture.assistantMessages ?? []) {
    push('response_item', {
      type: 'message',
      id: `msg_asst_${nextOrdinal()}`,
      role: 'assistant',
      content: [{ type: 'output_text', text }],
    });
  }
  for (const tool of fixture.toolResults ?? []) {
    const callId = tool.callId ?? `call_${nextOrdinal()}`;
    push('response_item', {
      type: 'custom_tool_call',
      id: `ctc_${callId}`,
      call_id: callId,
      name: tool.name,
      input: '{}',
    });
    push('response_item', {
      type: 'custom_tool_call_output',
      id: `ctco_${callId}`,
      call_id: callId,
      output: [{ type: 'input_text', text: tool.output }],
    });
  }
  push('response_item', {
    type: 'reasoning',
    id: `rs_${nextOrdinal()}`,
    summary: [],
    content: null,
    encrypted_content: 'not-persisted',
  });
  for (const line of fixture.extraLines ?? []) lines.push(line);
  if (fixture.complete !== false) push('event_msg', { type: 'task_complete' });
  return lines;
}

/** Writes a session file and returns its path. */
export async function writeCodexSession(
  root: string,
  fixture: CodexSessionFixture & { baseDir?: string },
): Promise<string> {
  const relativeDir = fixture.dir ?? '2026/01/01';
  const directory = join(fixture.baseDir ?? join(root, 'codex', 'sessions'), relativeDir);
  await mkdir(directory, { recursive: true });
  const path = join(directory, `rollout-2026-01-01T00-00-00-${fixture.sessionId}.jsonl`);
  const lines = buildCodexSessionLines(fixture);
  const body = `${lines.join('\n')}\n${fixture.truncateTail ? '{"timestamp":"2026-01-01T00:00:00.000Z","ordinal":9999,"type":"response_item","payload":{"type":"mess' : ''}`;
  await writeFile(path, body, 'utf8');
  return path;
}

export async function appendCodexSession(path: string, fixture: CodexSessionFixture): Promise<void> {
  await appendFile(path, `${buildCodexSessionLines(fixture).join('\n')}\n`, 'utf8');
}

export async function writeCodexIndex(root: string, entries: { id: string; threadName: string }[]): Promise<void> {
  const path = join(root, 'codex', 'session_index.jsonl');
  await writeFile(
    path,
    `${entries.map((entry) => JSON.stringify({ id: entry.id, thread_name: entry.threadName, updated_at: new Date().toISOString() })).join('\n')}\n`,
    'utf8',
  );
}

/** Ages a file so the "still being written" check does not defer it. */
export async function ageFile(path: string, seconds = 600): Promise<void> {
  const when = new Date(Date.now() - seconds * 1000);
  await utimes(path, when, when);
}

export async function readRepoFile(env: TestEnvironment, relativePath: string, commit?: string): Promise<string | null> {
  return env.service.store.readFile(relativePath, commit);
}

export async function listRepoFiles(env: TestEnvironment, commit?: string): Promise<string[]> {
  return env.service.store.listTreeFiles(commit);
}

export async function listWorkingFiles(env: TestEnvironment, subdirectory = ''): Promise<string[]> {
  const out: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(directory, entry.name), relative);
      else out.push(relative);
    }
  };
  await walk(join(env.memoryRepoPath, subdirectory), subdirectory);
  return out.sort();
}

export async function readWorkingFile(env: TestEnvironment, relativePath: string): Promise<string | null> {
  try {
    return await readFile(join(env.memoryRepoPath, relativePath), 'utf8');
  } catch {
    return null;
  }
}

export function commitMessages(env: TestEnvironment): Promise<string[]> {
  return (async () => {
    const commits = await env.service.store.log({ limit: 50 });
    return commits.map((commit) => commit.subject);
  })();
}
