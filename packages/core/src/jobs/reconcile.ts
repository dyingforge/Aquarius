import type { MemoryStore } from '../git/memoryStore.ts';
import type { MemoryRepository } from '../memory/repository.ts';
import type { CommitStore } from '../db/commitStore.ts';
import type { JobStore } from '../db/jobStore.ts';
import type { ProjectionStore } from '../db/projectionStore.ts';
import { projectFromGit, type IndexRebuildReport } from '../query/retrieval.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('jobs:reconcile');

export interface ReconcileReport {
  gitCommits: number;
  recordedInSqlite: number;
  recoveredCommits: string[];
  repairedJobs: string[];
  index: IndexRebuildReport;
  head: string | null;
}

/**
 * Startup reconciliation.
 *
 * If the process died between "Git commit created" and "SQLite updated", the
 * authoritative side is Git: the commit carries an `Aquarius-Job` trailer, so the
 * missing database row is rebuilt from `git log`, the job is marked done, and the
 * projection is regenerated. SQLite can be rebuilt from Git; the reverse is not
 * possible, which is exactly why the write order is Git first.
 */
export async function reconcileFromGit(input: {
  store: MemoryStore;
  repository: MemoryRepository;
  commits: CommitStore;
  jobs: JobStore;
  projection: ProjectionStore;
}): Promise<ReconcileReport> {
  const head = await input.store.head();
  const commits = await input.store.log({ limit: 500 });
  const known = input.commits.knownShas();
  const recoveredCommits: string[] = [];

  for (const commit of commits) {
    const kind = commit.trailers['kind'];
    if (!kind) continue;
    if (known.has(commit.sha)) continue;
    input.commits.record({
      commitSha: commit.sha,
      jobId: commit.trailers['job'] ?? null,
      sessionId: commit.trailers['session'] ?? null,
      sourceHash: commit.trailers['source-hash'] ?? null,
      kind,
      subject: commit.subject,
      filesChanged: 0,
    });
    recoveredCommits.push(commit.sha);
  }

  const repairedJobs: string[] = [];
  for (const job of input.jobs.list({ limit: 200 })) {
    const recorded = input.commits.findByJob(job.jobId);
    if (recorded && (job.status === 'queued' || job.status === 'running' || job.status === 'committing')) {
      input.jobs.markDone(job.jobId, { commitSha: recorded.commitSha, stats: { reconciled: true } });
      input.jobs.setReconcileState(job.jobId, 'reconciled');
      repairedJobs.push(job.jobId);
    }
  }

  const { report } = await projectFromGit({ repository: input.repository, projection: input.projection });
  input.commits.markReconciled(recoveredCommits);

  log.info('reconciliation finished', {
    head: head?.slice(0, 12) ?? null,
    recoveredCommits: recoveredCommits.length,
    repairedJobs: repairedJobs.length,
    indexed: report.entries,
  });

  return {
    gitCommits: commits.length,
    recordedInSqlite: input.commits.total(),
    recoveredCommits,
    repairedJobs,
    index: report,
    head,
  };
}
