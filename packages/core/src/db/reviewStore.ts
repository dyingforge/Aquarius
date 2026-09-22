import type { AquariusDatabase } from './database.ts';
import { nowIso } from '../util/time.ts';
import { newReviewId } from '../util/ids.ts';
import { AquariusError } from '../errors.ts';

export type ReviewType = 'promotion' | 'conflict' | 'correction' | 'skill_approval' | 'skill_anomaly';
export type ReviewStatus = 'preview' | 'pending' | 'approved' | 'rejected' | 'applied' | 'expired' | 'superseded';

export interface ReviewRecord {
  reviewId: string;
  type: ReviewType;
  status: ReviewStatus;
  baseHead: string | null;
  memoryIds: string[];
  proposal: Record<string, unknown>;
  decision: Record<string, unknown> | null;
  decisionNote: string | null;
  resolvedBy: string | null;
  createdAt: string;
  expiresAt: string | null;
  resolvedAt: string | null;
  appliedCommit: string | null;
  appliedAt: string | null;
  dedupeKey: string | null;
  jobId: string | null;
}

interface ReviewRow {
  review_id: string;
  type: string;
  status: string;
  base_head: string | null;
  memory_ids: string;
  proposal: string;
  decision: string | null;
  decision_note: string | null;
  resolved_by: string | null;
  created_at: string;
  expires_at: string | null;
  resolved_at: string | null;
  applied_commit: string | null;
  applied_at: string | null;
  dedupe_key: string | null;
  job_id: string | null;
}

function parseJsonObject(value: string | null): Record<string, unknown> | null {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function parseJsonArray(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
  } catch {
    return [];
  }
}

function toReview(row: ReviewRow): ReviewRecord {
  return {
    reviewId: row.review_id,
    type: row.type as ReviewType,
    status: row.status as ReviewStatus,
    baseHead: row.base_head,
    memoryIds: parseJsonArray(row.memory_ids),
    proposal: parseJsonObject(row.proposal) ?? {},
    decision: parseJsonObject(row.decision),
    decisionNote: row.decision_note,
    resolvedBy: row.resolved_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    resolvedAt: row.resolved_at,
    appliedCommit: row.applied_commit,
    appliedAt: row.applied_at,
    dedupeKey: row.dedupe_key,
    jobId: row.job_id,
  };
}

/**
 * Correction previews, promotion/conflict reviews and skill approvals are all
 * review records. A review can be applied at most once — that invariant lives in
 * the conditional UPDATE in {@link markApplied}, not in caller discipline.
 */
export class ReviewStore {
  #db: AquariusDatabase;

  constructor(db: AquariusDatabase) {
    this.#db = db;
  }

  create(input: {
    type: ReviewType;
    status: ReviewStatus;
    baseHead: string | null;
    memoryIds: string[];
    proposal: Record<string, unknown>;
    expiresAt?: string | null;
    dedupeKey?: string | null;
    jobId?: string | null;
  }): { review: ReviewRecord; created: boolean } {
    const reviewId = newReviewId();
    const now = nowIso();
    if (input.dedupeKey) {
      const existing = this.findByDedupeKey(input.dedupeKey);
      if (existing) return { review: existing, created: false };
    }
    this.#db.run(
      `INSERT INTO reviews (review_id, type, status, base_head, memory_ids, proposal, created_at, expires_at, dedupe_key, job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (dedupe_key) DO NOTHING`,
      [
        reviewId,
        input.type,
        input.status,
        input.baseHead,
        JSON.stringify(input.memoryIds),
        JSON.stringify(input.proposal),
        now,
        input.expiresAt ?? null,
        input.dedupeKey ?? null,
        input.jobId ?? null,
      ],
    );
    const stored = this.get(reviewId) ?? (input.dedupeKey ? this.findByDedupeKey(input.dedupeKey) : null);
    if (!stored) {
      throw new AquariusError('job_failed', 'Failed to persist review record');
    }
    return { review: stored, created: stored.reviewId === reviewId };
  }

  get(reviewId: string): ReviewRecord | null {
    const row = this.#db.get<ReviewRow>('SELECT * FROM reviews WHERE review_id = ?', [reviewId]);
    return row ? toReview(row) : null;
  }

  findByDedupeKey(dedupeKey: string): ReviewRecord | null {
    const row = this.#db.get<ReviewRow>('SELECT * FROM reviews WHERE dedupe_key = ?', [dedupeKey]);
    return row ? toReview(row) : null;
  }

  list(options: { status?: ReviewStatus; statuses?: ReviewStatus[]; type?: ReviewType; limit?: number } = {}): ReviewRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.statuses && options.statuses.length > 0) {
      clauses.push(`status IN (${options.statuses.map(() => '?').join(', ')})`);
      params.push(...options.statuses);
    }
    if (options.type) {
      clauses.push('type = ?');
      params.push(options.type);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(options.limit ?? 100);
    return this.#db
      .all<ReviewRow>(`SELECT * FROM reviews ${where} ORDER BY created_at DESC LIMIT ?`, params)
      .map(toReview);
  }

  listOpen(): ReviewRecord[] {
    return this.list({ statuses: ['pending', 'preview'], limit: 200 });
  }

  isExpired(review: ReviewRecord, now: Date = new Date()): boolean {
    if (!review.expiresAt) return false;
    return new Date(review.expiresAt).getTime() <= now.getTime();
  }

  markExpired(reviewId: string): void {
    this.#db.run(`UPDATE reviews SET status = 'expired', resolved_at = ? WHERE review_id = ? AND status IN ('pending','preview')`, [
      nowIso(),
      reviewId,
    ]);
  }

  reject(reviewId: string, options: { note?: string; resolvedBy: string }): ReviewRecord {
    const result = this.#db.run(
      `UPDATE reviews SET status = 'rejected', resolved_at = ?, resolved_by = ?, decision_note = ?
       WHERE review_id = ? AND status IN ('pending','preview')`,
      [nowIso(), options.resolvedBy, options.note ?? null, reviewId],
    );
    if (result.changes === 0) throw new AquariusError('review_already_resolved', `Review ${reviewId} is no longer open.`);
    return this.get(reviewId)!;
  }

  /**
   * Applies a review exactly once. Returns false when another caller already
   * applied it, so callers must not proceed with the Git write in that case.
   */
  markApplied(
    reviewId: string,
    options: { commitSha: string; decision?: Record<string, unknown>; resolvedBy: string; note?: string },
  ): boolean {
    const result = this.#db.run(
      `UPDATE reviews SET status = 'applied', applied_commit = ?, applied_at = ?, resolved_at = ?, resolved_by = ?,
                          decision = ?, decision_note = ?
       WHERE review_id = ? AND status IN ('pending','preview','approved')`,
      [
        options.commitSha,
        nowIso(),
        nowIso(),
        options.resolvedBy,
        options.decision ? JSON.stringify(options.decision) : null,
        options.note ?? null,
        reviewId,
      ],
    );
    return result.changes === 1;
  }

  markApproved(reviewId: string, options: { resolvedBy: string; decision?: Record<string, unknown> }): ReviewRecord {
    const result = this.#db.run(
      `UPDATE reviews SET status = 'approved', resolved_at = ?, resolved_by = ?, decision = ?
       WHERE review_id = ? AND status IN ('pending','preview')`,
      [nowIso(), options.resolvedBy, options.decision ? JSON.stringify(options.decision) : null, reviewId],
    );
    if (result.changes === 0) {
      throw new AquariusError('review_already_resolved', `Review ${reviewId} is not open for approval.`);
    }
    return this.get(reviewId)!;
  }

  markSuperseded(reviewId: string, note: string): void {
    this.#db.run(`UPDATE reviews SET status = 'superseded', resolved_at = ?, decision_note = ? WHERE review_id = ? AND status IN ('pending','preview')`, [
      nowIso(),
      note,
      reviewId,
    ]);
  }

  countOpen(): number {
    const row = this.#db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM reviews WHERE status IN ('pending','preview')`);
    return row?.count ?? 0;
  }
}
