import type { AquariusDatabase } from './database.ts';
import { nowIso } from '../util/time.ts';

export interface GitCommitRecord {
  commitSha: string;
  jobId: string | null;
  sessionId: string | null;
  sourceHash: string | null;
  kind: string;
  subject: string | null;
  filesChanged: number;
  createdAt: string;
  reconciled: boolean;
}

/**
 * The Git↔SQLite ledger.
 *
 * A commit is recorded here after the repository write succeeds. If the SQLite
 * update is the part that fails, the commit still exists in Git with its
 * `Aquarius-Job` trailer, and startup reconciliation rebuilds this table from
 * `git log` instead of losing the write.
 */
export class CommitStore {
  #db: AquariusDatabase;

  constructor(db: AquariusDatabase) {
    this.#db = db;
  }

  record(commit: {
    commitSha: string;
    jobId: string | null;
    sessionId: string | null;
    sourceHash: string | null;
    kind: string;
    subject: string | null;
    filesChanged: number;
  }): void {
    this.#db.run(
      `INSERT INTO git_commits (commit_sha, job_id, session_id, source_hash, kind, subject, files_changed, created_at, reconciled)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
       ON CONFLICT (commit_sha) DO UPDATE SET
         job_id = COALESCE(excluded.job_id, git_commits.job_id),
         session_id = COALESCE(excluded.session_id, git_commits.session_id),
         source_hash = COALESCE(excluded.source_hash, git_commits.source_hash),
         files_changed = excluded.files_changed,
         subject = excluded.subject`,
      [
        commit.commitSha,
        commit.jobId,
        commit.sessionId,
        commit.sourceHash,
        commit.kind,
        commit.subject,
        commit.filesChanged,
        nowIso(),
      ],
    );
  }

  findByJob(jobId: string): GitCommitRecord | null {
    const row = this.#db.get<{
      commit_sha: string;
      job_id: string | null;
      session_id: string | null;
      source_hash: string | null;
      kind: string;
      subject: string | null;
      files_changed: number;
      created_at: string;
      reconciled: number;
    }>('SELECT * FROM git_commits WHERE job_id = ? ORDER BY created_at DESC LIMIT 1', [jobId]);
    return row ? mapCommit(row) : null;
  }

  get(commitSha: string): GitCommitRecord | null {
    const row = this.#db.get<Parameters<typeof mapCommit>[0]>('SELECT * FROM git_commits WHERE commit_sha = ?', [
      commitSha,
    ]);
    return row ? mapCommit(row) : null;
  }

  list(limit = 100): GitCommitRecord[] {
    return this.#db
      .all<Parameters<typeof mapCommit>[0]>('SELECT * FROM git_commits ORDER BY created_at DESC LIMIT ?', [limit])
      .map(mapCommit);
  }

  knownShas(): Set<string> {
    return new Set(this.#db.all<{ commit_sha: string }>('SELECT commit_sha FROM git_commits').map((row) => row.commit_sha));
  }

  markReconciled(commitShas: string[]): void {
    if (commitShas.length === 0) return;
    this.#db.transaction(() => {
      for (const sha of commitShas) {
        this.#db.run('UPDATE git_commits SET reconciled = 1 WHERE commit_sha = ?', [sha]);
      }
    });
  }

  countUnreconciled(): number {
    const row = this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM git_commits WHERE reconciled = 0');
    return row?.count ?? 0;
  }

  total(): number {
    const row = this.#db.get<{ count: number }>('SELECT COUNT(*) AS count FROM git_commits');
    return row?.count ?? 0;
  }
}

function mapCommit(row: {
  commit_sha: string;
  job_id: string | null;
  session_id: string | null;
  source_hash: string | null;
  kind: string;
  subject: string | null;
  files_changed: number;
  created_at: string;
  reconciled: number;
}): GitCommitRecord {
  return {
    commitSha: row.commit_sha,
    jobId: row.job_id,
    sessionId: row.session_id,
    sourceHash: row.source_hash,
    kind: row.kind,
    subject: row.subject,
    filesChanged: row.files_changed,
    createdAt: row.created_at,
    reconciled: row.reconciled === 1,
  };
}
