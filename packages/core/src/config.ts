import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chmod, stat } from 'node:fs/promises';
import { AquariusError } from './errors.ts';
import { ensureDir, exists, readTextIfExists, writeFileAtomic } from './util/fsx.ts';
import { DEFAULT_TIME_ZONE } from './util/time.ts';
import { newTokenId } from './util/ids.ts';
import { randomBytes } from 'node:crypto';

/** Application code repository root — the memory repository must live outside it. */
export const APP_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

export const SERVICE_VERSION = '0.1.0';

export interface AgentBudgets {
  /** Wall-clock cap for a single bounded agent run. */
  runTimeoutMs: number;
  maxTurns: number;
  maxToolCalls: number;
  maxOutputTokens: number;
  /** Cap on sessions digested in a single batch. */
  maxSessionsPerBatch: number;
}

export interface SourcePaths {
  codexSessionsDir: string;
  codexArchivedDir: string;
  codexSessionIndex: string;
}

export interface ScheduleConfig {
  enabled: boolean;
  hour: number;
  minute: number;
  timeZone: string;
}

export type AgentRuntimeMode = 'openai' | 'fake';

export interface AquariusConfig {
  home: string;
  configPath: string;
  databasePath: string;
  memoryRepoPath: string;
  host: string;
  port: number;
  model: string;
  agentRuntime: AgentRuntimeMode;
  openaiApiKey: string | null;
  tracing: boolean;
  apiToken: string;
  apiTokenId: string;
  sources: SourcePaths;
  skillInstallDir: string;
  redactionExtraPatterns: string[];
  budgets: AgentBudgets;
  schedule: ScheduleConfig;
  /** A session file touched more recently than this is considered still being written. */
  activeSessionQuietSeconds: number;
  reviewTtlMinutes: number;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

export interface ConfigIssue {
  field: string;
  message: string;
  actionable: string;
}

export interface LoadedConfig {
  config: AquariusConfig;
  issues: ConfigIssue[];
  /** True when the config file did not exist and defaults were materialized. */
  createdConfigFile: boolean;
}

interface RawConfigFile {
  databasePath?: string;
  memoryRepoPath?: string;
  host?: string;
  port?: number;
  model?: string;
  agentRuntime?: AgentRuntimeMode;
  tracing?: boolean;
  apiToken?: string;
  apiTokenId?: string;
  sources?: Partial<SourcePaths>;
  skillInstallDir?: string;
  redactionExtraPatterns?: string[];
  budgets?: Partial<AgentBudgets>;
  schedule?: Partial<ScheduleConfig>;
  activeSessionQuietSeconds?: number;
  reviewTtlMinutes?: number;
  logLevel?: AquariusConfig['logLevel'];
}

export interface LoadConfigOptions {
  home?: string;
  env?: NodeJS.ProcessEnv;
  /** Generate and persist an API token when the config has none (first start). */
  persistToken?: boolean;
}

function num(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function bool(value: string | undefined): boolean | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function str(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value;
}

const DEFAULT_BUDGETS: AgentBudgets = {
  runTimeoutMs: 120_000,
  maxTurns: 12,
  maxToolCalls: 24,
  maxOutputTokens: 16_000,
  maxSessionsPerBatch: 25,
};

/** Config keys that must never be echoed back to a client or a log line. */
const SECRET_KEYS = new Set(['apiToken', 'openaiApiKey']);

export function sanitizeConfigForOutput(config: AquariusConfig): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (SECRET_KEYS.has(key)) continue;
    out[key] = value;
  }
  out.hasApiToken = config.apiToken.length > 0;
  out.hasOpenAiApiKey = config.openaiApiKey !== null && config.openaiApiKey.length > 0;
  return out;
}

async function readConfigFile(path: string): Promise<RawConfigFile> {
  const text = await readTextIfExists(path);
  if (text === null) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('config root must be a JSON object');
    }
    return parsed as RawConfigFile;
  } catch (error) {
    throw new AquariusError('config_invalid', `Cannot parse ${path}: ${(error as Error).message}`, {
      actionable: `Fix or delete ${path} and start Aquarius again.`,
      cause: error,
    });
  }
}

/**
 * True when `child` is inside `parent`. Both are resolved first so that symlinked
 * homes (e.g. /tmp -> /private/tmp on macOS) compare correctly.
 */
export function isInsidePath(child: string, parent: string): boolean {
  const rel = resolve(child);
  const root = resolve(parent);
  if (rel === root) return true;
  return rel.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export async function loadConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const env = options.env ?? process.env;
  const home = resolve(str(env.AQUARIUS_HOME) ?? options.home ?? join(homedir(), '.aquarius'));
  const configPath = join(home, 'config.json');
  const file = await readConfigFile(configPath);
  const issues: ConfigIssue[] = [];

  const port = num(env.AQUARIUS_PORT) ?? file.port ?? 8787;
  const host = str(env.AQUARIUS_HOST) ?? file.host ?? '127.0.0.1';

  const memoryRepoPath = resolve(
    str(env.AQUARIUS_MEMORY_REPO) ?? file.memoryRepoPath ?? join(home, 'memory-repo'),
  );
  const databasePath = resolve(str(env.AQUARIUS_DB) ?? file.databasePath ?? join(home, 'aquarius.db'));

  const model = str(env.AQUARIUS_MODEL) ?? file.model ?? 'gpt-5';
  const agentRuntime =
    (str(env.AQUARIUS_AGENT_RUNTIME) as AgentRuntimeMode | undefined) ?? file.agentRuntime ?? 'openai';
  const openaiApiKey = str(env.OPENAI_API_KEY) ?? null;

  const sources: SourcePaths = {
    codexSessionsDir: resolve(
      str(env.AQUARIUS_CODEX_SESSIONS_DIR) ?? file.sources?.codexSessionsDir ?? join(homedir(), '.codex', 'sessions'),
    ),
    codexArchivedDir: resolve(
      str(env.AQUARIUS_CODEX_ARCHIVED_DIR) ??
        file.sources?.codexArchivedDir ??
        join(homedir(), '.codex', 'archived_sessions'),
    ),
    codexSessionIndex: resolve(
      str(env.AQUARIUS_CODEX_SESSION_INDEX) ??
        file.sources?.codexSessionIndex ??
        join(homedir(), '.codex', 'session_index.jsonl'),
    ),
  };

  const schedule: ScheduleConfig = {
    enabled: bool(env.AQUARIUS_SCHEDULE_ENABLED) ?? file.schedule?.enabled ?? true,
    hour: num(env.AQUARIUS_SCHEDULE_HOUR) ?? file.schedule?.hour ?? 3,
    minute: num(env.AQUARIUS_SCHEDULE_MINUTE) ?? file.schedule?.minute ?? 0,
    timeZone: str(env.AQUARIUS_TIMEZONE) ?? file.schedule?.timeZone ?? DEFAULT_TIME_ZONE,
  };

  const budgets: AgentBudgets = { ...DEFAULT_BUDGETS, ...file.budgets };

  let apiToken = str(env.AQUARIUS_API_TOKEN) ?? file.apiToken ?? null;
  let apiTokenId = file.apiTokenId ?? newTokenId();
  let createdConfigFile = false;
  if (apiToken === null) {
    if (options.persistToken) {
      apiToken = randomBytes(32).toString('base64url');
      createdConfigFile = true;
    } else {
      apiToken = '';
      issues.push({
        field: 'apiToken',
        message: 'No local API token is configured.',
        actionable: `Start the service once (it will generate a token in ${configPath}) or set AQUARIUS_API_TOKEN.`,
      });
    }
  }

  const config: AquariusConfig = {
    home,
    configPath,
    databasePath,
    memoryRepoPath,
    host,
    port,
    model,
    agentRuntime,
    openaiApiKey,
    tracing: bool(env.AQUARIUS_TRACING) ?? file.tracing ?? false,
    apiToken,
    apiTokenId,
    sources,
    skillInstallDir: resolve(
      str(env.AQUARIUS_SKILL_INSTALL_DIR) ?? file.skillInstallDir ?? join(homedir(), '.codex', 'skills'),
    ),
    redactionExtraPatterns:
      file.redactionExtraPatterns ?? (str(env.AQUARIUS_REDACTION_PATTERNS)?.split(';;') ?? []),
    budgets,
    schedule,
    activeSessionQuietSeconds:
      num(env.AQUARIUS_ACTIVE_SESSION_QUIET_SECONDS) ?? file.activeSessionQuietSeconds ?? 120,
    reviewTtlMinutes: num(env.AQUARIUS_REVIEW_TTL_MINUTES) ?? file.reviewTtlMinutes ?? 30,
    logLevel: (str(env.AQUARIUS_LOG_LEVEL) as AquariusConfig['logLevel'] | undefined) ?? file.logLevel ?? 'info',
  };

  collectIssues(config, issues);

  if (createdConfigFile) {
    const payload: RawConfigFile = {
      apiToken: config.apiToken,
      apiTokenId: config.apiTokenId,
      port: config.port,
      host: config.host,
      model: config.model,
      agentRuntime: config.agentRuntime,
      databasePath: config.databasePath,
      memoryRepoPath: config.memoryRepoPath,
      sources: config.sources,
      skillInstallDir: config.skillInstallDir,
      schedule: config.schedule,
      budgets: config.budgets,
      tracing: config.tracing,
      activeSessionQuietSeconds: config.activeSessionQuietSeconds,
      reviewTtlMinutes: config.reviewTtlMinutes,
      logLevel: config.logLevel,
    };
    await ensureDir(home, 0o700);
    await writeFileAtomic(configPath, `${JSON.stringify(payload, null, 2)}\n`, 0o600);
    await chmod(configPath, 0o600).catch(() => undefined);
  }

  return { config, issues, createdConfigFile };
}

function collectIssues(config: AquariusConfig, issues: ConfigIssue[]): void {
  if (config.agentRuntime === 'openai' && !config.openaiApiKey) {
    issues.push({
      field: 'openaiApiKey',
      message: 'OPENAI_API_KEY is required because the agent runtime is "openai".',
      actionable:
        'Export OPENAI_API_KEY, put it in the service environment, or set AQUARIUS_AGENT_RUNTIME=fake for a dry-run instance with no model calls.',
    });
  }

  if (config.agentRuntime !== 'openai' && config.agentRuntime !== 'fake') {
    issues.push({
      field: 'agentRuntime',
      message: `Unknown agent runtime "${String(config.agentRuntime)}".`,
      actionable: 'Use "openai" (real Agents SDK runtime) or "fake" (deterministic test double).',
    });
  }

  if (isInsidePath(config.memoryRepoPath, APP_REPO_ROOT)) {
    issues.push({
      field: 'memoryRepoPath',
      message: `The memory repository path ${config.memoryRepoPath} is inside the Aquarius application repository.`,
      actionable:
        'Application code and the runtime memory repository must stay separate. Set AQUARIUS_MEMORY_REPO to a path outside the app checkout.',
    });
  }

  if (isInsidePath(config.databasePath, APP_REPO_ROOT)) {
    issues.push({
      field: 'databasePath',
      message: `The SQLite path ${config.databasePath} is inside the Aquarius application repository.`,
      actionable: 'Set AQUARIUS_DB to a location outside the app checkout.',
    });
  }

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    issues.push({
      field: 'port',
      message: `Port ${config.port} is not a valid TCP port.`,
      actionable: 'Set AQUARIUS_PORT to a free port between 1 and 65535.',
    });
  }

  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && config.host !== '::1') {
    issues.push({
      field: 'host',
      message: `The local service refuses to bind ${config.host}; only loopback addresses are supported.`,
      actionable: 'Set AQUARIUS_HOST to 127.0.0.1. Aquarius is a single-user local service and never listens publicly.',
    });
  }

  if (config.model.trim() === '') {
    issues.push({
      field: 'model',
      message: 'No model snapshot is configured.',
      actionable: 'Set AQUARIUS_MODEL to a pinned OpenAI model id.',
    });
  }

  if (!Number.isInteger(config.schedule.hour) || config.schedule.hour < 0 || config.schedule.hour > 23) {
    issues.push({
      field: 'schedule.hour',
      message: `Schedule hour ${config.schedule.hour} is out of range.`,
      actionable: 'Set AQUARIUS_SCHEDULE_HOUR between 0 and 23.',
    });
  }

  for (const [name, pattern] of config.redactionExtraPatterns.entries()) {
    try {
      // eslint-disable-next-line no-new
      new RegExp(pattern);
    } catch (error) {
      issues.push({
        field: `redactionExtraPatterns[${name}]`,
        message: `Pattern "${pattern}" is not a valid regular expression: ${(error as Error).message}`,
        actionable: 'Fix or remove the pattern in the Aquarius config file.',
      });
    }
  }

  if (!isAbsolute(config.memoryRepoPath) || !isAbsolute(config.databasePath)) {
    issues.push({
      field: 'paths',
      message: 'Memory repository and database paths must be absolute.',
      actionable: 'Use absolute paths in the config file.',
    });
  }
}

/** Throws a single actionable error listing every blocking configuration problem. */
export async function requireUsableConfig(options: LoadConfigOptions = {}): Promise<LoadedConfig> {
  const loaded = await loadConfig(options);
  if (loaded.issues.length > 0) {
    const summary = loaded.issues.map((issue) => `  - ${issue.field}: ${issue.message} (${issue.actionable})`).join('\n');
    throw new AquariusError('config_missing', `Aquarius cannot start:\n${summary}`, {
      details: { issues: loaded.issues },
      actionable: 'Fix the listed configuration problems, then start Aquarius again.',
    });
  }
  return loaded;
}

/**
 * Validates that the memory repository location is usable: it either does not
 * exist yet (it will be initialized), or it exists and is a Git repository.
 * A non-empty directory that is not a repository is never clobbered.
 */
export async function assertMemoryRepoUsable(
  memoryRepoPath: string,
): Promise<'existing' | 'missing' | 'empty'> {
  if (!(await exists(memoryRepoPath))) return 'missing';
  const info = await stat(memoryRepoPath);
  if (!info.isDirectory()) {
    throw new AquariusError('memory_repo_invalid', `Memory repository path ${memoryRepoPath} is not a directory.`, {
      actionable: 'Point AQUARIUS_MEMORY_REPO at a directory.',
    });
  }
  if (await exists(join(memoryRepoPath, '.git'))) return 'existing';

  const { readdir } = await import('node:fs/promises');
  const entries = await readdir(memoryRepoPath);
  if (entries.length === 0) return 'empty';

  throw new AquariusError(
    'memory_repo_invalid',
    `Memory repository path ${memoryRepoPath} is a non-empty directory without a Git repository.`,
    {
      actionable:
        'Aquarius refuses to initialize a memory repository over existing files. Choose an empty directory or an existing Git repository.',
      details: { entries: entries.slice(0, 10) },
    },
  );
}
