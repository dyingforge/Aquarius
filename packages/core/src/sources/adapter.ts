import type { RedactionFinding } from '../security/redact.ts';

/**
 * Session ingestion contract.
 *
 * Every agent source (Codex today, others later) is behind this interface. The
 * rest of Aquarius never sees a raw source file format: an adapter normalizes it
 * into `NormalizedSession`, which is the only shape the pipeline understands.
 */

export interface SourceCursor {
  cursorKey: string;
  value: string | null;
}

export interface SessionRef {
  source: string;
  sessionId: string;
  /** Best-effort root thread as reported by the source metadata. */
  rootThreadId: string | null;
  parentThreadId: string | null;
  forkedFromId: string | null;
  archived: boolean;
  path: string;
  threadSource: string | null;
  title: string | null;
  cwd: string | null;
  startedAt: string | null;
  updatedAt: string;
  mtimeMs: number;
  sizeBytes: number;
}

export type MessageRole = 'user' | 'assistant' | 'tool';

export interface NormalizedMessage {
  eventId: string;
  ordinal: number;
  role: MessageRole;
  text: string;
  timestamp: string;
}

export interface NormalizedToolResult {
  eventId: string;
  ordinal: number;
  callId: string | null;
  toolName: string;
  output: string;
  success: boolean;
  timestamp: string;
}

export interface SkippedEventSummary {
  type: string;
  count: number;
}

export interface NormalizedSessionMeta {
  sessionId: string;
  rootThreadId: string;
  parentThreadId: string | null;
  forkedFromId: string | null;
  threadSource: string | null;
  cwd: string | null;
  model: string | null;
  cliVersion: string | null;
  originator: string | null;
  archived: boolean;
  path: string;
  startedAt: string | null;
  endedAt: string | null;
  title: string | null;
}

export interface NormalizedSession {
  adapter: string;
  schemaVersion: number;
  meta: NormalizedSessionMeta;
  messages: NormalizedMessage[];
  toolResults: NormalizedToolResult[];
  skippedEvents: SkippedEventSummary[];
  eventIds: string[];
  /** sha256 of the raw source bytes. */
  sourceHash: string;
  lastOrdinal: number;
  /** True when the final line was cut off mid-write; the session is incomplete. */
  truncatedTail: boolean;
  /** True when the source signals that the session finished its task. */
  complete: boolean;
  /** Bytes of the source consumed to build this view. */
  byteLength: number;
}

export interface SanitizedSession extends NormalizedSession {
  redactionFindings: RedactionFinding[];
}

export interface SessionSourceAdapter {
  readonly source: string;
  readonly schemaVersion: number;
  /** Yields session references newer than the cursor. Must be cheap for unchanged files. */
  discover(cursor?: SourceCursor): AsyncIterable<SessionRef>;
  read(ref: SessionRef): Promise<NormalizedSession>;
  /** Optional index of thread titles used to label cases. */
  indexEntries?(): Promise<Map<string, { title: string | null; updatedAt: string | null }>>;
  /** Health check used by `doctor` and by the server bootstrap. */
  describeSource(): { paths: string[]; available: boolean };
}

export function summarizeSkipped(events: Map<string, number>): SkippedEventSummary[] {
  return [...events.entries()]
    .map(([type, count]) => ({ type, count }))
    .sort((a, b) => (a.type < b.type ? -1 : a.type > b.type ? 1 : 0));
}
