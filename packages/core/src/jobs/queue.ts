import type { JobRecord, JobStore } from '../db/jobStore.ts';
import { createLogger, type Logger } from '../util/logger.ts';

const log = createLogger('jobs:queue');

export type JobHandler = (job: JobRecord, signal: AbortSignal) => Promise<void>;

export interface JobQueueOptions {
  jobs: JobStore;
  handler: JobHandler;
  /** How often to look for new work. */
  pollIntervalMs?: number;
  logger?: Logger;
}

/**
 * Single-writer job queue.
 *
 * Every Git write in Aquarius funnels through here: one job runs at a time, in
 * priority order. That is what makes "all Git writes go through one queue" a
 * property of the system rather than a convention. Manual and correction work
 * outranks background consolidation by priority number.
 */
export class JobQueue {
  #jobs: JobStore;
  #handler: JobHandler;
  #pollIntervalMs: number;
  #logger: Logger;
  #timer: NodeJS.Timeout | null = null;
  #running = false;
  #stopped = false;
  #idleResolvers: (() => void)[] = [];
  #currentJobId: string | null = null;

  constructor(options: JobQueueOptions) {
    this.#jobs = options.jobs;
    this.#handler = options.handler;
    this.#pollIntervalMs = options.pollIntervalMs ?? 1_000;
    this.#logger = options.logger ?? log;
  }

  /** Processes queued work until the queue is empty (used by tests and the CLI). */
  async drain(maxJobs = 100): Promise<number> {
    let processed = 0;
    while (processed < maxJobs) {
      const job = this.#jobs.claimNext();
      if (!job) break;
      await this.#execute(job);
      processed += 1;
    }
    return processed;
  }

  start(): void {
    if (this.#timer !== null) return;
    this.#stopped = false;
    this.#timer = setInterval(() => {
      void this.tick();
    }, this.#pollIntervalMs);
    this.#timer.unref?.();
    void this.tick();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer !== null) {
      clearInterval(this.#timer);
      this.#timer = null;
    }
  }

  async tick(): Promise<void> {
    if (this.#running || this.#stopped) return;
    const job = this.#jobs.claimNext();
    if (!job) {
      this.#notifyIdle();
      return;
    }
    await this.#execute(job);
  }

  async #execute(job: JobRecord): Promise<void> {
    this.#running = true;
    this.#currentJobId = job.jobId;
    const controller = new AbortController();
    const startedAt = Date.now();
    try {
      this.#logger.info('job started', { job: job.jobId, kind: job.kind, trigger: job.trigger, attempt: job.attempts });
      await this.#handler(job, controller.signal);
      const status = this.#jobs.get(job.jobId)?.status;
      if (status === 'running' || status === 'committing') {
        this.#jobs.markDone(job.jobId, { stats: { durationMs: Date.now() - startedAt } });
      }
      this.#logger.info('job finished', { job: job.jobId, kind: job.kind, durationMs: Date.now() - startedAt });
    } catch (error) {
      const code = (error as { code?: string }).code ?? 'job_failed';
      const updated = this.#jobs.markFailed(job.jobId, {
        code,
        message: error instanceof Error ? error.message : String(error),
      });
      this.#logger.warn('job failed', {
        job: job.jobId,
        kind: job.kind,
        code,
        attempts: updated?.attempts ?? job.attempts,
        status: updated?.status ?? 'unknown',
      });
    } finally {
      this.#running = false;
      this.#currentJobId = null;
    }
  }

  async waitForIdle(timeoutMs = 30_000): Promise<void> {
    if (!this.#jobs.hasQueuedWork() && !this.#running) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        resolve();
      }, timeoutMs);
      timer.unref?.();
      this.#idleResolvers.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  #notifyIdle(): void {
    if (this.#jobs.hasQueuedWork() || this.#running) return;
    const resolvers = this.#idleResolvers;
    this.#idleResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  get currentJobId(): string | null {
    return this.#currentJobId;
  }

  get busy(): boolean {
    return this.#running;
  }
}
