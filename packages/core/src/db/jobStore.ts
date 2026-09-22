import type { AquariusDatabase } from './database.ts';
import { nowIso } from '../util/time.ts';
import { newJobId } from '../util/ids.ts';

export type JobKind =
  | 'ingest_session'
  | 'ingest_batch'
  | 'correct_memory'
  | 'review_resolve'
  | 'skill_synthesize'
  | 'skill_publish'
  | 'skill_rollback'
  | 'index_rebuild'
  | 'reconcile';

export type JobTrigger = 'schedule' | 'catch_up' | 'manual' | 'startup' | 'post_ingest' | 'user';

export type JobStatus = 'queued' | 'running' | 'committing' | 'done' | 'failed' | 'skipped';

/**
 * Lower number runs first. User-initiated work always preempts background
 * consolidation, which is what keeps corrections responsive.
 */
export const JOB_PRIORITY = {
  user: 10,
  manual: 20,
  post_ingest: 30,
  background: 40,
} as const;

export interface JobRecord {
  jobId: string;
  kind: JobKind;
  trigger: JobTrigger;
  status: JobStatus;
  priority: number;
  source: string | null;
  sessionId: string | null;
  dayKey: string | null;
  payload: Record<string, unknown>;
  stats: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
  scheduledFor: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  nextAttemptAt: string | null;
  errorCode: string | null;
  error: string | null;
  commitSha: string | null;
  reconcileState: string | null;
}

interface JobRow {
  job_id: string;
  kind: string;
  trigger: string;
  status: string;
  priority: number;
  source: string | null;
  session_id: string | null;
  day_key: string | null;
  payload: string;
  stats: string;
  attempts: number;
  max_attempts: number;
  scheduled_for: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  next_attempt_at: string | null;
  error_code: string | null;
  error: string | null;
  commit_sha: string | null;
  reconcile_state: string | null;
}

function parseJson(value: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function toJob(row: JobRow): JobRecord {
  return {
    jobId: row.job_id,
    kind: row.kind as JobKind,
    trigger: row.trigger as JobTrigger,
    status: row.status as JobStatus,
    priority: row.priority,
    source: row.source,
    sessionId: row.session_id,
    dayKey: row.day_key,
    payload: parseJson(row.payload),
    stats: parseJson(row.stats),
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    scheduledFor: row.scheduled_for,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    nextAttemptAt: row.next_attempt_at,
    errorCode: row.error_code,
    error: row.error,
    commitSha: row.commit_sha,
    reconcileState: row.reconcile_state,
  };
}

export interface CreateJobInput {
  kind: JobKind;
  trigger: JobTrigger;
  priority: number;
  source?: string | null;
  sessionId?: string | null;
  dayKey?: string | null;
  payload?: Record<string, unknown>;
  maxAttempts?: number;
  scheduledFor?: string | null;
}

/** Persistent job queue. Retries are bounded; every transition is auditable. */
export class JobStore {
  #db: AquariusDatabase;

  constructor(db: AquariusDatabase) {
    this.#db = db;
  }

  create(input: CreateJobInput): JobRecord {
    const jobId = newJobId();
    const now = nowIso();
    this.#db.run(
      `INSERT INTO jobs (job_id, kind, trigger, status, priority, source, session_id, day_key, payload, stats,
                         attempts, max_attempts, scheduled_for, created_at, reconcile_state)
       VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?, '{}', 0, ?, ?, ?, NULL)`,
      [
        jobId,
        input.kind,
        input.trigger,
        input.priority,
        input.source ?? null,
        input.sessionId ?? null,
        input.dayKey ?? null,
        JSON.stringify(input.payload ?? {}),
        input.maxAttempts ?? 3,
        input.scheduledFor ?? null,
        now,
      ],
    );
    return this.get(jobId)!;
  }

  get(jobId: string): JobRecord | null {
    const row = this.#db.get<JobRow>('SELECT * FROM jobs WHERE job_id = ?', [jobId]);
    return row ? toJob(row) : null;
  }

  list(options: { status?: JobStatus; kind?: JobKind; limit?: number } = {}): JobRecord[] {
    const clauses: string[] = [];
    const params: (string | number)[] = [];
    if (options.status) {
      clauses.push('status = ?');
      params.push(options.status);
    }
    if (options.kind) {
      clauses.push('kind = ?');
      params.push(options.kind);
    }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(options.limit ?? 50);
    return this.#db
      .all<JobRow>(`SELECT * FROM jobs ${where} ORDER BY created_at DESC LIMIT ?`, params)
      .map(toJob);
  }

  /** Claims the highest-priority queued job that is due, in one transaction. */
  claimNext(now: Date = new Date()): JobRecord | null {
    const iso = now.toISOString();
    return this.#db.transaction(() => {
      const row = this.#db.get<JobRow>(
        `SELECT * FROM jobs
          WHERE status = 'queued' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
          ORDER BY priority ASC, created_at ASC
          LIMIT 1`,
        [iso],
      );
      if (!row) return null;
      this.#db.run(`UPDATE jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE job_id = ?`, [
        iso,
        row.job_id,
      ]);
      return toJob({ ...row, status: 'running', started_at: iso, attempts: row.attempts + 1 });
    });
  }

  markCommitting(jobId: string): void {
    this.#db.run(`UPDATE jobs SET status = 'committing', reconcile_state = 'awaiting_commit' WHERE job_id = ?`, [jobId]);
  }

  markDone(jobId: string, options: { commitSha?: string | null; stats?: Record<string, unknown> } = {}): void {
    this.#db.run(
      `UPDATE jobs SET status = 'done', finished_at = ?, commit_sha = COALESCE(?, commit_sha),
                        reconcile_state = 'ok', stats = COALESCE(?, stats)
       WHERE job_id = ?`,
      [nowIso(), options.commitSha ?? null, options.stats ? JSON.stringify(options.stats) : null, jobId],
    );
  }

  markSkipped(jobId: string, reason: string, stats?: Record<string, unknown>): void {
    this.#db.run(
      `UPDATE jobs SET status = 'skipped', finished_at = ?, error = ?, error_code = 'skipped', stats = COALESCE(?, stats)
       WHERE job_id = ?`,
      [nowIso(), reason, stats ? JSON.stringify(stats) : null, jobId],
    );
  }

  /** Records a failure. Retries are bounded and exponentially backed off. */
  markFailed(jobId: string, error: { code: string; message: string }): JobRecord | null {
    const job = this.get(jobId);
    if (!job) return null;
    if (job.attempts >= job.maxAttempts) {
      this.#db.run(
        `UPDATE jobs SET status = 'failed', finished_at = ?, error_code = ?, error = ? WHERE job_id = ?`,
        [nowIso(), error.code, error.message.slice(0, 2000), jobId],
      );
      return this.get(jobId);
    }
    const backoffSeconds = Math.min(900, 30 * 2 ** Math.max(0, job.attempts - 1));
    const nextAttempt = new Date(Date.now() + backoffSeconds * 1000).toISOString();
    this.#db.run(
      `UPDATE jobs SET status = 'queued', error_code = ?, error = ?, next_attempt_at = ? WHERE job_id = ?`,
      [error.code, error.message.slice(0, 2000), nextAttempt, jobId],
    );
    return this.get(jobId);
  }

  /** Requeues work interrupted by a restart so nothing is silently dropped. */
  recoverInFlight(): JobRecord[] {
    const rows = this.#db.all<JobRow>(`SELECT * FROM jobs WHERE status IN ('running', 'committing')`);
    const recovered: JobRecord[] = [];
    this.#db.transaction(() => {
      for (const row of rows) {
        const needsReconcile = row.status === 'committing' || row.commit_sha !== null;
        this.#db.run(
          `UPDATE jobs SET status = 'queued', reconcile_state = ?, next_attempt_at = NULL WHERE job_id = ?`,
          [needsReconcile ? 'check_git' : 'retry', row.job_id],
        );
        recovered.push(toJob({ ...row, status: 'queued', reconcile_state: needsReconcile ? 'check_git' : 'retry' }));
      }
    });
    return recovered;
  }

  listAwaitingReconcile(limit = 50): JobRecord[] {
    return this.#db
      .all<JobRow>(
        `SELECT * FROM jobs WHERE reconcile_state = 'check_git' OR (status = 'queued' AND reconcile_state = 'check_git')
          ORDER BY created_at ASC LIMIT ?`,
        [limit],
      )
      .map(toJob);
  }

  setReconcileState(jobId: string, state: string): void {
    this.#db.run('UPDATE jobs SET reconcile_state = ? WHERE job_id = ?', [state, jobId]);
  }

  setCommitSha(jobId: string, commitSha: string): void {
    this.#db.run('UPDATE jobs SET commit_sha = ? WHERE job_id = ?', [commitSha, jobId]);
  }

  /** Automatic batches already recorded for a natural day (idempotency guard). */
  countAutomaticBatchesForDay(dayKey: string): number {
    const row = this.#db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM jobs
        WHERE kind = 'ingest_batch' AND trigger IN ('schedule', 'catch_up') AND day_key = ?
          AND status IN ('queued', 'running', 'committing', 'done')`,
      [dayKey],
    );
    return row?.count ?? 0;
  }

  findByDayAndKind(dayKey: string, kind: JobKind): JobRecord | null {
    const row = this.#db.get<JobRow>(
      'SELECT * FROM jobs WHERE day_key = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
      [dayKey, kind],
    );
    return row ? toJob(row) : null;
  }

  stats(): Record<string, number> {
    const rows = this.#db.all<{ status: string; count: number }>('SELECT status, COUNT(*) AS count FROM jobs GROUP BY status');
    const out: Record<string, number> = {};
    for (const row of rows) out[row.status] = row.count;
    return out;
  }

  hasQueuedWork(): boolean {
    const row = this.#db.get<{ count: number }>(
      `SELECT COUNT(*) AS count FROM jobs WHERE status IN ('queued', 'running', 'committing')`,
    );
    return (row?.count ?? 0) > 0;
  }
}
