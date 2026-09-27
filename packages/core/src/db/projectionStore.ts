import type { AquariusDatabase } from './database.ts';
import { nowIso } from '../util/time.ts';
import { augmentForIndex, buildMatchQuery } from '../query/ftsText.ts';
import type { Authority, Confidence, MemoryKind, MemoryStatus, Sensitivity } from '../memory/schema.ts';
import { createLogger } from '../util/logger.ts';
import type { CaseOutcome } from '../gates/caseOutcome.ts';

const log = createLogger('store:projection');

export interface MemoryIndexEntry {
  memoryId: string;
  kind: MemoryKind;
  status: MemoryStatus;
  path: string;
  title: string;
  body: string;
  tags: string[];
  caseIds: string[];
  authority: Authority;
  confidence: Confidence;
  sensitivity: Sensitivity;
  supersededBy: string | null;
  validFrom: string | null;
  validTo: string | null;
  updatedAt: string | null;
  contentHash: string;
  commitSha: string | null;
}

export interface MemorySearchHit {
  memoryId: string;
  kind: MemoryKind;
  status: MemoryStatus;
  path: string;
  title: string;
  snippet: string;
  tags: string[];
  caseIds: string[];
  authority: Authority;
  confidence: Confidence;
  sensitivity: Sensitivity;
  updatedAt: string | null;
  score: number;
}

export interface SkillPublicationRecord {
  skillId: string;
  skillName: string;
  version: number;
  status: 'published' | 'installed' | 'retired' | 'rolled_back';
  commitSha: string | null;
  previousCommitSha: string | null;
  installPath: string | null;
  fileHash: string | null;
  files: { path: string; hash: string }[];
  approvedBy: string | null;
  publishedAt: string | null;
  installedAt: string | null;
  retiredAt: string | null;
  rollbackOf: string | null;
  message: string | null;
}

interface IndexRow {
  memory_id: string;
  kind: string;
  status: string;
  path: string;
  title: string;
  authority: string;
  confidence: string;
  sensitivity: string;
  tags: string;
  case_ids: string;
  superseded_by: string | null;
  valid_from: string | null;
  valid_to: string | null;
  updated_at: string | null;
  content_hash: string;
  commit_sha: string | null;
}

function parseStringArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * The searchable projection of Git HEAD. It is a derived cache: it can always be
 * deleted and rebuilt from the memory repository, and it is never the source of
 * truth for a memory's content.
 */
export class ProjectionStore {
  #db: AquariusDatabase;

  constructor(db: AquariusDatabase) {
    this.#db = db;
  }

  replaceCaseOutcomes(outcomes: CaseOutcome[]): void {
    this.#db.transaction(() => {
      this.#db.run('DELETE FROM case_outcomes');
      const insert = this.#db.prepare(
        `INSERT INTO case_outcomes (outcome_id, case_id, strategy_id, attempt_id, result, rule_id, evidence_ids, source_event_ids, task_features, recorded_by, supersedes, recorded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const item of outcomes) {
        insert.run(item.outcome_id, item.case_id, item.strategy_id, item.attempt_id, item.result,
          item.rule_id, JSON.stringify(item.evidence_ids), JSON.stringify(item.source_event_ids), JSON.stringify(item.task_features), item.recorded_by, item.supersedes, item.recorded_at);
      }
    });
  }

  listCaseOutcomes(caseId: string): CaseOutcome[] {
    return this.#db.all<{
      outcome_id: string; case_id: string; strategy_id: string; attempt_id: string;
      result: CaseOutcome['result']; rule_id: CaseOutcome['rule_id']; evidence_ids: string; source_event_ids: string; task_features: string;
      recorded_by: string; supersedes: string | null; recorded_at: string;
    }>('SELECT * FROM case_outcomes WHERE case_id = ? ORDER BY recorded_at ASC', [caseId]).map((row) => ({
      outcome_id: row.outcome_id, case_id: row.case_id, strategy_id: row.strategy_id,
      attempt_id: row.attempt_id, result: row.result, rule_id: row.rule_id,
      evidence_ids: JSON.parse(row.evidence_ids) as string[], recorded_by: row.recorded_by,
      source_event_ids: JSON.parse(row.source_event_ids) as string[],
      task_features: JSON.parse(row.task_features) as string[],
      recorded_at: row.recorded_at, supersedes: row.supersedes,
    }));
  }

  /** Atomically swaps the whole projection. */
  replaceAll(entries: MemoryIndexEntry[], head: string | null): void {
    this.#db.transaction(() => {
      this.#db.run('DELETE FROM memory_index');
      this.#db.run('DELETE FROM memory_fts');
      const insertIndex = this.#db.prepare(
        `INSERT INTO memory_index (memory_id, kind, status, path, title, authority, confidence, sensitivity,
                                   tags, case_ids, superseded_by, valid_from, valid_to, updated_at, content_hash, commit_sha)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const insertFts = this.#db.prepare(
        `INSERT INTO memory_fts (memory_id, kind, status, title, body, tags) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const entry of entries) {
        insertIndex.run(
          entry.memoryId,
          entry.kind,
          entry.status,
          entry.path,
          entry.title,
          entry.authority,
          entry.confidence,
          entry.sensitivity,
          JSON.stringify(entry.tags),
          JSON.stringify(entry.caseIds),
          entry.supersededBy,
          entry.validFrom,
          entry.validTo,
          entry.updatedAt,
          entry.contentHash,
          entry.commitSha,
        );
        insertFts.run(
          entry.memoryId,
          entry.kind,
          entry.status,
          augmentForIndex(entry.title),
          augmentForIndex(entry.body),
          augmentForIndex(entry.tags.join(' ')),
        );
      }
      this.#db.run(
        `INSERT INTO index_state (id, head, rebuilt_at, memory_count, source) VALUES (1, ?, ?, ?, 'git')
         ON CONFLICT (id) DO UPDATE SET head = excluded.head, rebuilt_at = excluded.rebuilt_at,
                                        memory_count = excluded.memory_count, source = excluded.source`,
        [head, nowIso(), entries.length],
      );
    });
    log.info('search projection rebuilt', { entries: entries.length });
  }

  /**
   * Full-text search over active memories only — candidates, superseded and
   * retired records must never be retrieved as current fact.
   */
  search(question: string, options: { limit?: number; kinds?: MemoryKind[]; includeNonActive?: boolean } = {}): MemorySearchHit[] {
    const match = buildMatchQuery(question);
    if (match === null) return [];
    const limit = options.limit ?? 20;
    const clauses = ['memory_fts MATCH ?'];
    const params: (string | number)[] = [match];
    if (!options.includeNonActive) {
      clauses.push(`memory_index.status = 'active'`);
    }
    if (options.kinds && options.kinds.length > 0) {
      clauses.push(`memory_index.kind IN (${options.kinds.map(() => '?').join(', ')})`);
      params.push(...options.kinds);
    }
    params.push(limit);
    try {
      const rows = this.#db.all<IndexRow & { rank: number; body: string }>(
        `SELECT memory_index.*, memory_fts.body AS body, bm25(memory_fts, 4.0, 1.0, 0.5) AS rank
           FROM memory_fts
           JOIN memory_index ON memory_index.memory_id = memory_fts.memory_id
          WHERE ${clauses.join(' AND ')}
          ORDER BY rank ASC
          LIMIT ?`,
        params,
      );
      return rows.map((row) => ({
        memoryId: row.memory_id,
        kind: row.kind as MemoryKind,
        status: row.status as MemoryStatus,
        path: row.path,
        title: row.title,
        snippet: makeSnippet(row.body),
        tags: parseStringArray(row.tags),
        caseIds: parseStringArray(row.case_ids),
        authority: row.authority as Authority,
        confidence: row.confidence as Confidence,
        sensitivity: row.sensitivity as Sensitivity,
        updatedAt: row.updated_at,
        score: row.rank,
      }));
    } catch (error) {
      // A malformed MATCH expression must degrade to "no results", never break a query.
      log.warn('fts query failed', { message: (error as Error).message });
      return [];
    }
  }

  get(memoryId: string): IndexRow | null {
    return (
      this.#db.get<IndexRow>('SELECT * FROM memory_index WHERE memory_id = ?', [memoryId]) ?? null
    );
  }

  list(options: { kind?: MemoryKind; status?: MemoryStatus; statuses?: MemoryStatus[]; limit?: number } = {}): IndexRow[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.kind) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
      params.push(...options.statuses);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(options.limit ?? 200);
    return this.#db.all<IndexRow>(`SELECT * FROM memory_index ${where} ORDER BY COALESCE(updated_at, '') DESC LIMIT ?`, params);
  }

  countByStatus(): Record<string, number> {
    const rows = this.#db.all<{ status: string; count: number }>(
      'SELECT status, COUNT(*) AS count FROM memory_index GROUP BY status',
    );
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.count;
    return out;
  }

  count(): number {
    const row = this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM memory_index');
    return row?.count ?? 0;
  }

  indexState(): { head: string | null; rebuiltAt: string | null; memoryCount: number } {
    const row = this.#db.get<{ head: string | null; rebuilt_at: string | null; memory_count: number }>(
      'SELECT head, rebuilt_at, memory_count FROM index_state WHERE id = 1',
    );
    return {
      head: row?.head ?? null,
      rebuiltAt: row?.rebuilt_at ?? null,
      memoryCount: row?.memory_count ?? 0,
    };
  }

  // --- skill publications ----------------------------------------------------

  upsertSkillPublication(record: SkillPublicationRecord): void {
    this.#db.run(
      `INSERT INTO skill_publications (skill_id, skill_name, version, status, commit_sha, previous_commit_sha,
                                       install_path, file_hash, files, approved_by, published_at, installed_at,
                                       retired_at, rollback_of, message)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (skill_id) DO UPDATE SET
         skill_name = excluded.skill_name,
         version = excluded.version,
         status = excluded.status,
         commit_sha = excluded.commit_sha,
         previous_commit_sha = excluded.previous_commit_sha,
         install_path = excluded.install_path,
         file_hash = excluded.file_hash,
         files = excluded.files,
         approved_by = excluded.approved_by,
         published_at = excluded.published_at,
         installed_at = excluded.installed_at,
         retired_at = excluded.retired_at,
         rollback_of = excluded.rollback_of,
         message = excluded.message`,
      [
        record.skillId,
        record.skillName,
        record.version,
        record.status,
        record.commitSha,
        record.previousCommitSha,
        record.installPath,
        record.fileHash,
        JSON.stringify(record.files),
        record.approvedBy,
        record.publishedAt,
        record.installedAt,
        record.retiredAt,
        record.rollbackOf,
        record.message,
      ],
    );
  }

  getSkillPublication(skillId: string): SkillPublicationRecord | null {
    const row = this.#db.get<{
      skill_id: string;
      skill_name: string;
      version: number;
      status: string;
      commit_sha: string | null;
      previous_commit_sha: string | null;
      install_path: string | null;
      file_hash: string | null;
      files: string;
      approved_by: string | null;
      published_at: string | null;
      installed_at: string | null;
      retired_at: string | null;
      rollback_of: string | null;
      message: string | null;
    }>('SELECT * FROM skill_publications WHERE skill_id = ?', [skillId]);
    if (!row) return null;
    return {
      skillId: row.skill_id,
      skillName: row.skill_name,
      version: row.version,
      status: row.status as SkillPublicationRecord['status'],
      commitSha: row.commit_sha,
      previousCommitSha: row.previous_commit_sha,
      installPath: row.install_path,
      fileHash: row.file_hash,
      files: parseFiles(row.files),
      approvedBy: row.approved_by,
      publishedAt: row.published_at,
      installedAt: row.installed_at,
      retiredAt: row.retired_at,
      rollbackOf: row.rollback_of,
      message: row.message,
    };
  }

  listSkillPublications(): SkillPublicationRecord[] {
    return this.#db
      .all<{ skill_id: string }>('SELECT skill_id FROM skill_publications ORDER BY published_at DESC')
      .map((row) => this.getSkillPublication(row.skill_id))
      .filter((record): record is SkillPublicationRecord => record !== null);
  }

  findSkillByName(name: string): SkillPublicationRecord | null {
    const row = this.#db.get<{ skill_id: string }>(
      `SELECT skill_id FROM skill_publications WHERE skill_name = ? AND status IN ('published','installed') ORDER BY version DESC LIMIT 1`,
      [name],
    );
    return row ? this.getSkillPublication(row.skill_id) : null;
  }

  // --- scheduler + meta ------------------------------------------------------

  getSchedulerState(key: string): string | null {
    const row = this.#db.get<{ value: string }>('SELECT value FROM scheduler_state WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  setSchedulerState(key: string, value: string): void {
    this.#db.run(
      `INSERT INTO scheduler_state (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, nowIso()],
    );
  }

  getMeta(key: string): string | null {
    const row = this.#db.get<{ value: string }>('SELECT value FROM app_meta WHERE key = ?', [key]);
    return row?.value ?? null;
  }

  setMeta(key: string, value: string): void {
    this.#db.run(
      `INSERT INTO app_meta (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [key, value, nowIso()],
    );
  }

  // --- tokens ----------------------------------------------------------------

  upsertToken(record: { tokenId: string; label: string; tokenHash: string }): void {
    this.#db.run(
      `INSERT INTO api_tokens (token_id, label, token_hash, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (token_id) DO UPDATE SET label = excluded.label, token_hash = excluded.token_hash`,
      [record.tokenId, record.label, record.tokenHash, nowIso()],
    );
  }

  findTokenByHash(tokenHash: string): { tokenId: string; label: string; revokedAt: string | null } | null {
    const row = this.#db.get<{ token_id: string; label: string; revoked_at: string | null }>(
      'SELECT token_id, label, revoked_at FROM api_tokens WHERE token_hash = ?',
      [tokenHash],
    );
    return row ? { tokenId: row.token_id, label: row.label, revokedAt: row.revoked_at } : null;
  }

  touchToken(tokenId: string): void {
    this.#db.run('UPDATE api_tokens SET last_used_at = ? WHERE token_id = ?', [nowIso(), tokenId]);
  }

  listTokens(): { tokenId: string; label: string; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }[] {
    return this.#db
      .all<{ token_id: string; label: string; created_at: string; last_used_at: string | null; revoked_at: string | null }>(
        'SELECT token_id, label, created_at, last_used_at, revoked_at FROM api_tokens ORDER BY created_at ASC',
      )
      .map((row) => ({
        tokenId: row.token_id,
        label: row.label,
        createdAt: row.created_at,
        lastUsedAt: row.last_used_at,
        revokedAt: row.revoked_at,
      }));
  }
}

function parseFiles(value: string): { path: string; hash: string }[] {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => (item !== null && typeof item === 'object' ? (item as { path?: unknown; hash?: unknown }) : null))
      .filter((item): item is { path?: unknown; hash?: unknown } => item !== null)
      .map((item) => ({ path: String(item.path ?? ''), hash: String(item.hash ?? '') }))
      .filter((item) => item.path !== '');
  } catch {
    return [];
  }
}

/** One-line excerpt around the first substantive paragraph, for listings. */
export function makeSnippet(body: string, maxLength = 220): string {
  const compact = body
    .replace(/^#+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (compact.length <= maxLength) return compact;
  return `${compact.slice(0, maxLength - 1)}…`;
}
