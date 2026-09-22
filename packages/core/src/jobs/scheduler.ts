import type { AquariusConfig, ScheduleConfig } from '../config.ts';
import type { JobStore, JobRecord } from '../db/jobStore.ts';
import { JOB_PRIORITY } from '../db/jobStore.ts';
import type { ProjectionStore } from '../db/projectionStore.ts';
import { dayKey, lastDailyRun, nextDailyRun, zonedClock } from '../util/time.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('jobs:scheduler');

const LAST_AUTO_DAY_KEY = 'last_auto_ingest_day';
const LAST_AUTO_JOB_KEY = 'last_auto_ingest_job';

export interface SchedulerOptions {
  config: AquariusConfig;
  jobs: JobStore;
  projection: ProjectionStore;
  /** Called whenever a schedule or catch-up job is created. */
  onJobCreated?: (job: JobRecord, reason: 'schedule' | 'catch_up') => void;
}

export interface ScheduleDecision {
  created: boolean;
  reason: string;
  job: JobRecord | null;
  nextRunAt: string;
}

/**
 * Daily scheduling.
 *
 * Semantics live in the application, not in launchd: launchd only keeps the
 * process alive. That is what makes catch-up possible — the service compares the
 * last successful automatic batch for the natural day (Asia/Shanghai) against the
 * clock at startup and creates exactly one catch-up job if the window was missed.
 */
export class Scheduler {
  #config: AquariusConfig;
  #jobs: JobStore;
  #projection: ProjectionStore;
  #onJobCreated: ((job: JobRecord, reason: 'schedule' | 'catch_up') => void) | undefined;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: SchedulerOptions) {
    this.#config = options.config;
    this.#jobs = options.jobs;
    this.#projection = options.projection;
    this.#onJobCreated = options.onJobCreated;
  }

  get schedule(): ScheduleConfig {
    return this.#config.schedule;
  }

  /**
   * Decides whether an automatic batch is due right now, and creates it if so.
   * Idempotent per natural day: at most one automatic batch per calendar day.
   */
  createDueJob(now: Date = new Date(), trigger: 'schedule' | 'catch_up'): ScheduleDecision {
    const schedule = this.#config.schedule;
    const nextRunAt = nextDailyRun(now, schedule).toISOString();
    if (!schedule.enabled) {
      return { created: false, reason: 'Scheduling is disabled in the configuration.', job: null, nextRunAt };
    }

    const today = dayKey(now, schedule.timeZone);
    const lastAutoDay = this.#projection.getSchedulerState(LAST_AUTO_DAY_KEY);
    if (lastAutoDay === today) {
      return { created: false, reason: `An automatic batch already ran for ${today}.`, job: null, nextRunAt };
    }
    if (this.#jobs.countAutomaticBatchesForDay(today) > 0) {
      return {
        created: false,
        reason: `An automatic batch is already queued or running for ${today}.`,
        job: null,
        nextRunAt,
      };
    }

    const windowStart = lastDailyRun(now, schedule);
    if (trigger === 'catch_up' && now.getTime() < windowStart.getTime()) {
      return { created: false, reason: 'The scheduled window for today has not arrived yet.', job: null, nextRunAt };
    }

    const job = this.#jobs.create({
      kind: 'ingest_batch',
      trigger,
      priority: JOB_PRIORITY.background,
      dayKey: today,
      scheduledFor: windowStart.toISOString(),
      payload: { timeZone: schedule.timeZone, hour: schedule.hour, minute: schedule.minute },
    });
    this.#projection.setSchedulerState(LAST_AUTO_JOB_KEY, job.jobId);

    log.info('automatic ingestion job created', {
      job: job.jobId,
      trigger,
      day: today,
      missedByMinutes: trigger === 'catch_up' ? Math.round((now.getTime() - windowStart.getTime()) / 60_000) : 0,
    });
    this.#onJobCreated?.(job, trigger);
    return {
      created: true,
      reason:
        trigger === 'catch_up'
          ? `Scheduled time was missed; created a catch-up batch for ${today}.`
          : `Created the scheduled batch for ${today}.`,
      job,
      nextRunAt,
    };
  }

  /** Startup path: creates a catch-up job when the machine was off at the scheduled time. */
  catchUpIfMissed(now: Date = new Date()): ScheduleDecision {
    const decision = this.createDueJob(now, 'catch_up');
    if (!decision.created) log.debug('no catch-up needed', { reason: decision.reason });
    return decision;
  }

  /** Records that the day's automatic batch completed successfully. */
  markAutoDayComplete(day: string, jobId: string): void {
    this.#projection.setSchedulerState(LAST_AUTO_DAY_KEY, day);
    this.#projection.setSchedulerState(LAST_AUTO_JOB_KEY, jobId);
  }

  lastAutoDay(): string | null {
    return this.#projection.getSchedulerState(LAST_AUTO_DAY_KEY);
  }

  start(): void {
    if (this.#timer !== null) return;
    const schedule = this.#config.schedule;
    const arm = (): void => {
      const now = new Date();
      const next = nextDailyRun(now, schedule);
      const delay = Math.max(1_000, next.getTime() - now.getTime());
      this.#timer = setTimeout(() => {
        const decision = this.createDueJob(new Date(), 'schedule');
        log.info('scheduled batch tick', { created: decision.created, reason: decision.reason });
        arm();
      }, delay);
      this.#timer.unref?.();
      log.info('next scheduled batch', {
        at: next.toISOString(),
        local: `${zonedClock(next, schedule.timeZone).hour}:${String(schedule.minute).padStart(2, '0')}`,
        timeZone: schedule.timeZone,
      });
    };
    arm();
  }

  stop(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  describe(): { enabled: boolean; hour: number; minute: number; timeZone: string; nextRunAt: string; lastAutoDay: string | null } {
    return {
      enabled: this.#config.schedule.enabled,
      hour: this.#config.schedule.hour,
      minute: this.#config.schedule.minute,
      timeZone: this.#config.schedule.timeZone,
      nextRunAt: nextDailyRun(new Date(), this.#config.schedule).toISOString(),
      lastAutoDay: this.lastAutoDay(),
    };
  }
}
