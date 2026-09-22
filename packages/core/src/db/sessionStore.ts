import type { AquariusDatabase } from './database.ts';
import type { Authority } from '../memory/schema.ts';
import { nowIso } from '../util/time.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('store:sessions');

export type SessionStatus = 'discovered' | 'deferred' | 'pending' | 'ingested' | 'unchanged' | 'failed' | 'skipped';

export interface SessionRecord {
  source: string;
  sessionId: string;
  rootThreadId: string;
  threadSource: string | null;
  cwd: string | null;
  sourcePath: string;
  archived: boolean;
  contentHash: string | null;
  lastOffset: number;
  processedOffset: number;
  lastEventId: string | null;
  adapterSchemaVersion: number;
  status: SessionStatus;
  deferReason: string | null;
  caseId: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  lastIngestedAt: string | null;
  pendingEvents: number;
}

export interface CaseRecord {
  caseId: string;
  source: string;
  rootThreadId: string;
  primarySessionId: string;
  title: string | null;
  taskFeatures: string[];
  evidenceCount: number;
  verifiedEvidenceCount: number;
  userEvidenceCount: number;
  firstSeenAt: string;
  updatedAt: string;
}

export interface NewEvidence {
  evidenceId: string;
  caseId: string;
  source: string;
  sessionId: string;
  rootThreadId: string;
  kind: 'user_message' | 'tool_result';
  authority: Authority;
  toolName: string | null;
  verified: boolean;
  eventId: string | null;
  ordinal: number | null;
  snippet: string;
  sourceHash: string;
  createdAt: string;
}

export interface StoredEvidence extends NewEvidence {}

interface SessionRow {
  source: string;
  session_id: string;
  root_thread_id: string;
  thread_source: string | null;
  cwd: string | null;
  source_path: string;
  archived: number;
  content_hash: string | null;
  last_offset: number;
  processed_offset: number;
  last_event_id: string | null;
  adapter_schema_version: number;
  status: string;
  defer_reason: string | null;
  case_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  last_ingested_at: string | null;
  pending_events: number;
}

function toSession(row: SessionRow): SessionRecord {
  return {
    source: row.source,
    sessionId: row.session_id,
    rootThreadId: row.root_thread_id,
    threadSource: row.thread_source,
    cwd: row.cwd,
    sourcePath: row.source_path,
    archived: row.archived === 1,
    contentHash: row.content_hash,
    lastOffset: row.last_offset,
    processedOffset: row.processed_offset,
    lastEventId: row.last_event_id,
    adapterSchemaVersion: row.adapter_schema_version,
    status: row.status as SessionStatus,
    deferReason: row.defer_reason,
    caseId: row.case_id,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    lastIngestedAt: row.last_ingested_at,
    pendingEvents: row.pending_events,
  };
}

/** Sessions, event dedupe, cases and their evidence — all rebuildable runtime state. */
export class SessionStore {
  #db: AquariusDatabase;

  constructor(db: AquariusDatabase) {
    this.#db = db;
  }

  getSession(source: string, sessionId: string): SessionRecord | null {
    const row = this.#db.get<SessionRow>('SELECT * FROM sessions WHERE source = ? AND session_id = ?', [
      source,
      sessionId,
    ]);
    return row ? toSession(row) : null;
  }

  listSessions(options: { source?: string; status?: SessionStatus; limit?: number } = {}): SessionRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.source) {
      clauses.push('source = ?');
      params.push(options.source);
    }
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(options.limit ?? 500);
    return this.#db
      .all<SessionRow>(`SELECT * FROM sessions ${where} ORDER BY last_seen_at DESC LIMIT ?`, params)
      .map(toSession);
  }

  /** Sessions whose source file changed or that are waiting for a retry. */
  listSessionsNeedingWork(source: string, limit = 100): SessionRecord[] {
    return this.#db
      .all<SessionRow>(
        `SELECT * FROM sessions
          WHERE source = ? AND status IN ('discovered', 'pending', 'deferred', 'failed')
          ORDER BY COALESCE(last_ingested_at, first_seen_at) ASC
          LIMIT ?`,
        [source, limit],
      )
      .map(toSession);
  }

  /**
   * Links a session to its root thread. Continuations of the same thread must
   * collapse onto one root so that "independent case" counts stay honest.
   */
  resolveRootThread(source: string, sessionId: string, reportedRoot: string | null): string {
    const links = new Map<string, string>();
    for (const row of this.#db.all<{ session_id: string; root_thread_id: string }>(
      'SELECT session_id, root_thread_id FROM session_links WHERE source = ?',
      [source],
    )) {
      links.set(row.session_id, row.root_thread_id);
    }
    // If the parent already has a root, inherit it; otherwise the parent is a root itself.
    const candidate = reportedRoot ?? sessionId;
    const seen = new Set<string>();
    let current = candidate;
    while (seen.size < 64) {
      if (seen.has(current)) break;
      seen.add(current);
      const next = links.get(current);
      if (!next || next === current) break;
      current = next;
    }
    return current;
  }

  recordLink(
    source: string,
    sessionId: string,
    parentSessionId: string | null,
    forkedFromId: string | null,
    rootThreadId: string,
  ): void {
    this.#db.run(
      `INSERT INTO session_links (source, session_id, parent_session_id, forked_from_id, root_thread_id, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (source, session_id) DO UPDATE SET
         parent_session_id = excluded.parent_session_id,
         forked_from_id = excluded.forked_from_id,
         root_thread_id = excluded.root_thread_id,
         updated_at = excluded.updated_at`,
      [source, sessionId, parentSessionId, forkedFromId, rootThreadId, nowIso()],
    );
  }

  upsertSession(input: {
    ref: {
      source: string;
      sessionId: string;
      threadSource: string | null;
      cwd: string | null;
      path: string;
      archived: boolean;
    };
    rootThreadId: string;
    sizeOrOffset: number;
  }): SessionRecord {
    const existing = this.getSession(input.ref.source, input.ref.sessionId);
    const now = nowIso();
    if (!existing) {
      this.#db.run(
        `INSERT INTO sessions (
           source, session_id, root_thread_id, thread_source, cwd, source_path, archived, content_hash,
           last_offset, processed_offset, last_event_id, adapter_schema_version, status, defer_reason, case_id,
           first_seen_at, last_seen_at, last_ingested_at, pending_events
         ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, NULL, 1, 'discovered', NULL, NULL, ?, ?, NULL, 0)`,
        [
          input.ref.source,
          input.ref.sessionId,
          input.rootThreadId,
          input.ref.threadSource,
          input.ref.cwd,
          input.ref.path,
          input.ref.archived ? 1 : 0,
          input.sizeOrOffset,
          now,
          now,
        ],
      );
    } else {
      this.#db.run(
        `UPDATE sessions SET
           root_thread_id = ?, thread_source = ?, cwd = ?, source_path = ?, archived = ?, last_offset = ?, last_seen_at = ?
         WHERE source = ? AND session_id = ?`,
        [
          input.rootThreadId,
          input.ref.threadSource,
          input.ref.cwd,
          input.ref.path,
          input.ref.archived ? 1 : 0,
          input.sizeOrOffset,
          now,
          input.ref.source,
          input.ref.sessionId,
        ],
      );
    }
    return this.getSession(input.ref.source, input.ref.sessionId)!;
  }

  updateSessionState(
    source: string,
    sessionId: string,
    patch: {
      contentHash?: string | null;
      processedOffset?: number;
      lastEventId?: string | null;
      status?: SessionStatus;
      deferReason?: string | null;
      caseId?: string | null;
      lastIngestedAt?: string | null;
      pendingEvents?: number;
      adapterSchemaVersion?: number;
    },
  ): void {
    const sets: string[] = [];
    const params: (string | number | null)[] = [];
    const push = (column: string, value: string | number | null): void => {
      sets.push(`${column} = ?`);
      params.push(value);
    };
    if (patch.contentHash !== undefined) push('content_hash', patch.contentHash);
    if (patch.processedOffset !== undefined) push('processed_offset', patch.processedOffset);
    if (patch.lastEventId !== undefined) push('last_event_id', patch.lastEventId);
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.deferReason !== undefined) push('defer_reason', patch.deferReason);
    if (patch.caseId !== undefined) push('case_id', patch.caseId);
    if (patch.lastIngestedAt !== undefined) push('last_ingested_at', patch.lastIngestedAt);
    if (patch.pendingEvents !== undefined) push('pending_events', patch.pendingEvents);
    if (patch.adapterSchemaVersion !== undefined) push('adapter_schema_version', patch.adapterSchemaVersion);
    if (sets.length === 0) return;
    params.push(source, sessionId);
    this.#db.run(`UPDATE sessions SET ${sets.join(', ')} WHERE source = ? AND session_id = ?`, params);
  }

  /**
   * Records event fingerprints. Returns only the events that were not seen
   * before, which is what makes re-scanning an appended session idempotent.
   */
  recordEvents(
    source: string,
    sessionId: string,
    events: { eventId: string; eventHash: string; ordinal: number | null; eventType: string | null }[],
  ): { inserted: number; fresh: string[] } {
    let inserted = 0;
    const fresh: string[] = [];
    const now = nowIso();
    return this.#db.transaction(() => {
      for (const event of events) {
        const result = this.#db.run(
          `INSERT INTO events (source, session_id, event_id, event_hash, ordinal, event_type, created_at, incorporated)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0)
           ON CONFLICT (source, session_id, event_id) DO NOTHING`,
          [source, sessionId, event.eventId, event.eventHash, event.ordinal, event.eventType, now],
        );
        if (result.changes > 0) {
          inserted += 1;
          fresh.push(event.eventId);
        }
      }
      return { inserted, fresh };
    });
  }

  knownEventIds(source: string, sessionId: string): Set<string> {
    const rows = this.#db.all<{ event_id: string }>(
      'SELECT event_id FROM events WHERE source = ? AND session_id = ?',
      [source, sessionId],
    );
    return new Set(rows.map((row) => row.event_id));
  }

  markEventsIncorporated(source: string, sessionId: string, eventIds: string[]): void {
    if (eventIds.length === 0) return;
    this.#db.transaction(() => {
      for (const eventId of eventIds) {
        this.#db.run('UPDATE events SET incorporated = 1 WHERE source = ? AND session_id = ? AND event_id = ?', [
          source,
          sessionId,
          eventId,
        ]);
      }
    });
  }

  countEvents(source: string, sessionId: string): number {
    const row = this.#db.get<{ count: number }>(
      'SELECT COUNT(*) AS count FROM events WHERE source = ? AND session_id = ?',
      [source, sessionId],
    );
    return row?.count ?? 0;
  }

  // --- cases -----------------------------------------------------------------

  upsertCase(input: {
    caseId: string;
    source: string;
    rootThreadId: string;
    primarySessionId: string;
    title: string | null;
  }): CaseRecord {
    const now = nowIso();
    this.#db.run(
      `INSERT INTO cases (case_id, source, root_thread_id, primary_session_id, title, task_features,
                          evidence_count, verified_evidence_count, user_evidence_count, first_seen_at, updated_at)
       VALUES (?, ?, ?, ?, ?, '[]', 0, 0, 0, ?, ?)
       ON CONFLICT (source, root_thread_id) DO UPDATE SET
         primary_session_id = excluded.primary_session_id,
         title = COALESCE(excluded.title, cases.title),
         updated_at = excluded.updated_at`,
      [input.caseId, input.source, input.rootThreadId, input.primarySessionId, input.title, now, now],
    );
    return this.getCaseByRootThread(input.source, input.rootThreadId)!;
  }

  getCaseByRootThread(source: string, rootThreadId: string): CaseRecord | null {
    const row = this.#db.get<{
      case_id: string;
      source: string;
      root_thread_id: string;
      primary_session_id: string;
      title: string | null;
      task_features: string;
      evidence_count: number;
      verified_evidence_count: number;
      user_evidence_count: number;
      first_seen_at: string;
      updated_at: string;
    }>('SELECT * FROM cases WHERE source = ? AND root_thread_id = ?', [source, rootThreadId]);
    return row ? mapCase(row) : null;
  }

  getCase(caseId: string): CaseRecord | null {
    const row = this.#db.get<Parameters<typeof mapCase>[0]>('SELECT * FROM cases WHERE case_id = ?', [caseId]);
    return row ? mapCase(row) : null;
  }

  listCases(options: { limit?: number } = {}): CaseRecord[] {
    return this.#db
      .all<Parameters<typeof mapCase>[0]>('SELECT * FROM cases ORDER BY updated_at DESC LIMIT ?', [options.limit ?? 200])
      .map(mapCase);
  }

  addEvidence(evidence: NewEvidence[]): { inserted: number } {
    if (evidence.length === 0) return { inserted: 0 };
    return this.#db.transaction(() => {
      let inserted = 0;
      for (const item of evidence) {
        const result = this.#db.run(
          `INSERT INTO case_evidence (evidence_id, case_id, source, session_id, root_thread_id, kind, authority,
                                      tool_name, verified, event_id, ordinal, snippet, source_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (evidence_id) DO NOTHING`,
          [
            item.evidenceId,
            item.caseId,
            item.source,
            item.sessionId,
            item.rootThreadId,
            item.kind,
            item.authority,
            item.toolName,
            item.verified ? 1 : 0,
            item.eventId,
            item.ordinal,
            item.snippet,
            item.sourceHash,
            item.createdAt,
          ],
        );
        inserted += result.changes;
      }
      return { inserted };
    });
  }

  listEvidenceForCase(caseId: string, options: { limit?: number } = {}): StoredEvidence[] {
    return this.#db
      .all<Parameters<typeof mapEvidence>[0]>(
        `SELECT * FROM case_evidence WHERE case_id = ? ORDER BY COALESCE(ordinal, 0) ASC LIMIT ?`,
        [caseId, options.limit ?? 50],
      )
      .map(mapEvidence);
  }

  listEvidenceForCases(caseIds: string[], options: { limit?: number } = {}): Map<string, StoredEvidence[]> {
    const map = new Map<string, StoredEvidence[]>();
    if (caseIds.length === 0) return map;
    const placeholders = caseIds.map(() => '?').join(', ');
    const rows = this.#db.all<Parameters<typeof mapEvidence>[0]>(
      `SELECT * FROM case_evidence WHERE case_id IN (${placeholders}) ORDER BY COALESCE(ordinal, 0) ASC`,
      [...caseIds],
    );
    for (const row of rows) {
      const evidence = mapEvidence(row);
      const list = map.get(evidence.caseId) ?? [];
      if (list.length < (options.limit ?? 20)) list.push(evidence);
      map.set(evidence.caseId, list);
    }
    return map;
  }

  evidenceForSession(source: string, sessionId: string): StoredEvidence[] {
    return this.#db
      .all<Parameters<typeof mapEvidence>[0]>('SELECT * FROM case_evidence WHERE source = ? AND session_id = ?', [
        source,
        sessionId,
      ])
      .map(mapEvidence);
  }

  /** Recomputes per-case counters from the evidence table (never from a model's claim). */
  refreshCaseStats(caseId: string): CaseRecord | null {
    this.#db.run(
      `UPDATE cases SET
         evidence_count = (SELECT COUNT(*) FROM case_evidence WHERE case_id = ?),
         verified_evidence_count = (SELECT COUNT(*) FROM case_evidence WHERE case_id = ? AND verified = 1),
         user_evidence_count = (SELECT COUNT(*) FROM case_evidence WHERE case_id = ? AND kind = 'user_message'),
         updated_at = ?
       WHERE case_id = ?`,
      [caseId, caseId, caseId, nowIso(), caseId],
    );
    return this.getCase(caseId);
  }

  setCaseTaskFeatures(caseId: string, features: string[]): void {
    const unique = [...new Set(features.map((feature) => feature.trim()).filter((feature) => feature !== ''))].slice(0, 24);
    this.#db.run('UPDATE cases SET task_features = ?, updated_at = ? WHERE case_id = ?', [
      JSON.stringify(unique),
      nowIso(),
      caseId,
    ]);
  }

  caseCount(): number {
    const row = this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM cases');
    return row?.count ?? 0;
  }

  // --- cursors ---------------------------------------------------------------

  getCursor(source: string, cursorKey: string): string | null {
    const row = this.#db.get<{ value: string }>('SELECT value FROM source_cursors WHERE source = ? AND cursor_key = ?', [
      source,
      cursorKey,
    ]);
    return row?.value ?? null;
  }

  setCursor(source: string, cursorKey: string, value: string): void {
    this.#db.run(
      `INSERT INTO source_cursors (source, cursor_key, value, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (source, cursor_key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [source, cursorKey, value, nowIso()],
    );
  }

  logSummary(): void {
    log.debug('session store summary', { cases: this.caseCount() });
  }
}

export function mapCase(row: {
  case_id: string;
  source: string;
  root_thread_id: string;
  primary_session_id: string;
  title: string | null;
  task_features: string;
  evidence_count: number;
  verified_evidence_count: number;
  user_evidence_count: number;
  first_seen_at: string;
  updated_at: string;
}): CaseRecord {
  let taskFeatures: string[] = [];
  try {
    const parsed: unknown = JSON.parse(row.task_features);
    if (Array.isArray(parsed)) taskFeatures = parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    taskFeatures = [];
  }
  return {
    caseId: row.case_id,
    source: row.source,
    rootThreadId: row.root_thread_id,
    primarySessionId: row.primary_session_id,
    title: row.title,
    taskFeatures,
    evidenceCount: row.evidence_count,
    verifiedEvidenceCount: row.verified_evidence_count,
    userEvidenceCount: row.user_evidence_count,
    firstSeenAt: row.first_seen_at,
    updatedAt: row.updated_at,
  };
}

export function mapEvidence(row: {
  evidence_id: string;
  case_id: string;
  source: string;
  session_id: string;
  root_thread_id: string;
  kind: string;
  authority: string;
  tool_name: string | null;
  verified: number;
  event_id: string | null;
  ordinal: number | null;
  snippet: string;
  source_hash: string;
  created_at: string;
}): StoredEvidence {
  return {
    evidenceId: row.evidence_id,
    caseId: row.case_id,
    source: row.source,
    sessionId: row.session_id,
    rootThreadId: row.root_thread_id,
    kind: row.kind as 'user_message' | 'tool_result',
    authority: row.authority as Authority,
    toolName: row.tool_name,
    verified: row.verified === 1,
    eventId: row.event_id,
    ordinal: row.ordinal,
    snippet: row.snippet,
    sourceHash: row.source_hash,
    createdAt: row.created_at,
  };
}
