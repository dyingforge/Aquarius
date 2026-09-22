import { createHash } from 'node:crypto';
import type {
  MessageRole,
  NormalizedMessage,
  NormalizedSession,
  NormalizedToolResult,
  SkippedEventSummary,
} from '../adapter.ts';
import { summarizeSkipped } from '../adapter.ts';

/**
 * Codex JSONL is a changing external format. Everything format-specific lives in
 * this file: unknown event types are counted and skipped, unparseable or
 * truncated trailing lines never fail a whole batch, and no other module reads
 * Codex event shapes directly.
 *
 * Observed record shape:
 *   { "timestamp": ISO, "ordinal": n, "type": "response_item", "payload": { "type": "...", ... } }
 */

export const CODEX_ADAPTER_NAME = 'codex-jsonl';
export const CODEX_SCHEMA_VERSION = 1;

export interface CodexParseCounters {
  unknownEventTypes: Map<string, number>;
  malformedLines: number;
}

export interface CodexParseResult {
  sessionId: string | null;
  parentThreadId: string | null;
  forkedFromId: string | null;
  threadSource: string | null;
  cwd: string | null;
  model: string | null;
  cliVersion: string | null;
  originator: string | null;
  startedAt: string | null;
  endedAt: string | null;
  messages: NormalizedMessage[];
  toolResults: NormalizedToolResult[];
  skippedEvents: SkippedEventSummary[];
  eventIds: string[];
  lastOrdinal: number;
  truncatedTail: boolean;
  complete: boolean;
  malformedLines: number;
}

interface JsonRecord {
  timestamp?: unknown;
  ordinal?: unknown;
  type?: unknown;
  payload?: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Concatenates the text blocks of a Codex content array. */
function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    const record = asRecord(block);
    if (!record) continue;
    const text = asString(record['text']) ?? asString(record['output_text']) ?? asString(record['input_text']);
    if (text) parts.push(text);
  }
  return parts.join('\n');
}

const INJECTION_PREFIXES = [
  '<app-context',
  '<recommended_plugins',
  '<environment_context',
  '<user_instructions',
  '<multi_agent_mode',
  '<permissions',
  '<sandbox',
  '<turn_context',
  '<skill',
  '<system',
];

/**
 * Codex desktop injects harness context as `role: "user"` messages. Those are
 * not user statements and must never become evidence about the user.
 */
export function isInjectedUserMessage(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith('<')) return false;
  const lower = trimmed.toLowerCase();
  if (INJECTION_PREFIXES.some((prefix) => lower.startsWith(prefix))) return true;
  // Harness blocks close with a matching tag inside the first ~2 lines and carry
  // no natural-language request of their own.
  return /^<[a-z][a-z0-9_-]*>[\s\S]*<\/[a-z][a-z0-9_-]*>\s*$/.test(trimmed);
}

const FAILURE_PATTERNS = [
  /script failed/i,
  /exited with code [1-9]/i,
  /exit code: [1-9]/i,
  /command failed/i,
  /\bENOENT\b/,
  /traceback \(most recent call last\)/i,
  /error: /i,
];

export function toolOutputLooksFailed(output: string): boolean {
  return FAILURE_PATTERNS.some((pattern) => pattern.test(output));
}

function eventIdFor(record: JsonRecord, payload: Record<string, unknown> | null, ordinal: number): string {
  const candidates = [asString(payload?.['id']), asString(payload?.['call_id']), asString(payload?.['event_id'])];
  for (const candidate of candidates) {
    if (candidate) return candidate;
  }
  return `${String(record.type ?? 'event')}:${ordinal}`;
}

/**
 * Parses a Codex JSONL session. Pure and total: it never throws.
 */
export function parseCodexSessionLines(raw: string): CodexParseResult {
  const unknownEventTypes = new Map<string, number>();
  const messages: NormalizedMessage[] = [];
  const toolResults: NormalizedToolResult[] = [];
  const eventIds: string[] = [];

  let sessionId: string | null = null;
  let parentThreadId: string | null = null;
  let forkedFromId: string | null = null;
  let threadSource: string | null = null;
  let cwd: string | null = null;
  let model: string | null = null;
  let cliVersion: string | null = null;
  let originator: string | null = null;
  let startedAt: string | null = null;
  let endedAt: string | null = null;
  let lastOrdinal = -1;
  let complete = false;
  let malformedLines = 0;
  let truncatedTail = false;

  const lines = raw.split('\n');
  const pendingCalls = new Map<string, string>();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.trim() === '') continue;

    let record: JsonRecord;
    try {
      record = JSON.parse(line) as JsonRecord;
    } catch {
      malformedLines += 1;
      // A partial final line is the normal shape of a session still being written.
      if (index === lines.length - 1 || (index === lines.length - 2 && (lines[lines.length - 1] ?? '').trim() === '')) {
        truncatedTail = true;
      }
      continue;
    }

    const type = asString(record.type) ?? 'unknown';
    const payload = asRecord(record.payload);
    const ordinal = asNumber(record.ordinal) ?? index;
    const timestamp = asString(record.timestamp) ?? new Date(0).toISOString();
    lastOrdinal = Math.max(lastOrdinal, ordinal);

    switch (type) {
      case 'session_meta': {
        if (!payload) break;
        sessionId = asString(payload['session_id']) ?? asString(payload['id']) ?? sessionId;
        parentThreadId = asString(payload['parent_thread_id']) ?? parentThreadId;
        forkedFromId = asString(payload['forked_from_id']) ?? forkedFromId;
        threadSource = asString(payload['thread_source']) ?? threadSource;
        cwd = asString(payload['cwd']) ?? cwd;
        cliVersion = asString(payload['cli_version']) ?? cliVersion;
        originator = asString(payload['originator']) ?? originator;
        startedAt = asString(payload['timestamp']) ?? startedAt;
        break;
      }
      case 'turn_context': {
        if (!payload) break;
        cwd = asString(payload['cwd']) ?? cwd;
        const candidateModel = asString(payload['model']) ?? asString(payload['model_name']);
        model = candidateModel ?? model;
        break;
      }
      case 'response_item': {
        if (!payload) {
          unknownEventTypes.set('response_item', (unknownEventTypes.get('response_item') ?? 0) + 1);
          break;
        }
        const itemType = asString(payload['type']) ?? 'unknown';
        const eventId = eventIdFor(record, payload, ordinal);
        switch (itemType) {
          case 'message': {
            const role = asString(payload['role']) ?? 'assistant';
            const text = contentText(payload['content']);
            if (role === 'developer' || role === 'system') break;
            if (text.trim() === '') break;
            if (role === 'user' && isInjectedUserMessage(text)) break;
            const mappedRole: MessageRole = role === 'user' ? 'user' : role === 'assistant' ? 'assistant' : 'tool';
            messages.push({ eventId, ordinal, role: mappedRole, text, timestamp });
            eventIds.push(eventId);
            break;
          }
          case 'custom_tool_call':
          case 'function_call':
          case 'local_shell_call': {
            const callId = asString(payload['call_id']) ?? asString(payload['id']);
            const name =
              asString(payload['name']) ?? asString(payload['tool_name']) ?? (itemType === 'local_shell_call' ? 'shell' : 'tool');
            if (callId) pendingCalls.set(callId, name);
            eventIds.push(eventId);
            break;
          }
          case 'custom_tool_call_output':
          case 'function_call_output': {
            const callId = asString(payload['call_id']);
            const toolName = (callId ? pendingCalls.get(callId) : null) ?? 'tool';
            const output = contentText(payload['output']) || asString(payload['output']) || '';
            toolResults.push({
              eventId,
              ordinal,
              callId,
              toolName,
              output,
              success: !toolOutputLooksFailed(output),
              timestamp,
            });
            eventIds.push(eventId);
            break;
          }
          case 'reasoning': {
            // Reasoning content is never stored, never sent to a model and never logged.
            break;
          }
          default: {
            unknownEventTypes.set(`response_item/${itemType}`, (unknownEventTypes.get(`response_item/${itemType}`) ?? 0) + 1);
          }
        }
        break;
      }
      case 'event_msg': {
        const itemType = asString(payload?.['type']) ?? 'unknown';
        if (itemType === 'task_complete' || itemType === 'turn_aborted') {
          complete = itemType === 'task_complete';
          endedAt = timestamp;
        }
        if (itemType !== 'task_started' && itemType !== 'item_completed' && itemType !== 'token_count' && itemType !== 'task_complete') {
          unknownEventTypes.set(`event_msg/${itemType}`, (unknownEventTypes.get(`event_msg/${itemType}`) ?? 0) + 1);
        }
        break;
      }
      case 'token_usage_record':
      case 'world_state':
      case 'compacted':
      case 'turn_aborted':
        break;
      default:
        unknownEventTypes.set(type, (unknownEventTypes.get(type) ?? 0) + 1);
    }
  }

  if (endedAt === null && messages.length > 0) {
    endedAt = messages[messages.length - 1]?.timestamp ?? null;
  }

  return {
    sessionId,
    parentThreadId,
    forkedFromId,
    threadSource,
    cwd,
    model,
    cliVersion,
    originator,
    startedAt,
    endedAt,
    messages,
    toolResults,
    skippedEvents: summarizeSkipped(unknownEventTypes),
    eventIds,
    lastOrdinal,
    truncatedTail,
    complete,
    malformedLines,
  };
}

export function codexSourceHash(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

/** Convenience wrapper used by the adapter and by tests. */
export function toNormalizedSession(input: {
  parsed: CodexParseResult;
  sourceHash: string;
  path: string;
  archived: boolean;
  fallbackSessionId: string;
  title: string | null;
  byteLength: number;
}): NormalizedSession {
  const { parsed } = input;
  const sessionId = parsed.sessionId ?? input.fallbackSessionId;
  const rootThreadId = parsed.forkedFromId ?? parsed.parentThreadId ?? sessionId;
  return {
    adapter: CODEX_ADAPTER_NAME,
    schemaVersion: CODEX_SCHEMA_VERSION,
    meta: {
      sessionId,
      rootThreadId,
      parentThreadId: parsed.parentThreadId,
      forkedFromId: parsed.forkedFromId,
      threadSource: parsed.threadSource,
      cwd: parsed.cwd,
      model: parsed.model,
      cliVersion: parsed.cliVersion,
      originator: parsed.originator,
      archived: input.archived,
      path: input.path,
      startedAt: parsed.startedAt,
      endedAt: parsed.endedAt,
      title: input.title,
    },
    messages: parsed.messages,
    toolResults: parsed.toolResults,
    skippedEvents: parsed.skippedEvents,
    eventIds: parsed.eventIds,
    sourceHash: input.sourceHash,
    lastOrdinal: parsed.lastOrdinal,
    truncatedTail: parsed.truncatedTail,
    complete: parsed.complete,
    byteLength: input.byteLength,
  };
}
