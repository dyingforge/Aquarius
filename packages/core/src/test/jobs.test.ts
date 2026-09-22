import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, writeCodexSession, ageFile } from './harness.ts';
import { JOB_PRIORITY } from '../db/jobStore.ts';
import { Scheduler } from '../jobs/scheduler.ts';
import { reconcileFromGit } from '../jobs/reconcile.ts';
import { dayKey, instantAtZonedTime, nextDailyRun, zonedClock } from '../util/time.ts';

test('the queue runs user work before background work', async () => {
  const env = await createEnvironment();
  try {
    env.service.jobs.create({ kind: 'index_rebuild', trigger: 'schedule', priority: JOB_PRIORITY.background });
    env.service.jobs.create({ kind: 'index_rebuild', trigger: 'manual', priority: JOB_PRIORITY.manual });
    env.service.jobs.create({ kind: 'index_rebuild', trigger: 'user', priority: JOB_PRIORITY.user });

    // Claim from the store directly to observe the documented ordering. The
    // environment's bootstrap catch-up job is also queued at background priority,
    // so the assertion is on priority order rather than on an exact trigger list.
    const claimed: { trigger: string; priority: number }[] = [];
    for (let index = 0; index < 4; index += 1) {
      const job = env.service.jobs.claimNext();
      if (job) claimed.push({ trigger: job.trigger, priority: job.priority });
    }

    assert.equal(claimed[0]?.trigger, 'user');
    assert.equal(claimed[1]?.trigger, 'manual');
    const priorities = claimed.map((entry) => entry.priority);
    assert.deepEqual(
      [...priorities].sort((a, b) => a - b),
      priorities,
      `jobs must be claimed in priority order, saw ${claimed.map((entry) => entry.trigger).join(', ')}`,
    );
    assert.equal(priorities[priorities.length - 1], JOB_PRIORITY.background);
  } finally {
    await env.cleanup();
  }
});

test('a failing job is retried a bounded number of times and then marked failed', async () => {
  const env = await createEnvironment();
  try {
    const job = env.service.jobs.create({
      kind: 'index_rebuild',
      trigger: 'manual',
      priority: JOB_PRIORITY.manual,
      maxAttempts: 3,
    });

    // Three claims: the first two are requeued with backoff, the third fails.
    for (let round = 0; round < 3; round += 1) {
      const claimed = env.service.jobs.claimNext();
      assert.ok(claimed, `round ${round} should claim the job`);
      const updated = env.service.jobs.markFailed(claimed!.jobId, { code: 'job_failed', message: 'boom' });
      assert.ok(updated);
      if (round < 2) {
        assert.equal(updated!.status, 'queued', `round ${round} should be requeued`);
        assert.ok(updated!.nextAttemptAt, 'a retry must be scheduled with a backoff time');
        // Clear the backoff so the next claim is due immediately.
        env.service.database.run('UPDATE jobs SET next_attempt_at = NULL WHERE job_id = ?', [job.jobId]);
      } else {
        assert.equal(updated!.status, 'failed');
        assert.equal(updated!.attempts, 3);
      }
    }
    const final = env.service.jobs.get(job.jobId);
    assert.equal(final?.attempts, 3);
    assert.equal(final?.status, 'failed');
  } finally {
    await env.cleanup();
  }
});

test('a damaged session does not stop the rest of the batch', async () => {
  const env = await createEnvironment();
  try {
    const good = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000001001',
      userMessages: ['这个仓库使用 monorepo 结构'],
    });
    await ageFile(good);

    // A session whose file cannot be read (removed between discovery and read).
    const broken = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000001002',
      userMessages: ['这条会话稍后会消失'],
    });
    await ageFile(broken);
    const { rm } = await import('node:fs/promises');
    await rm(broken);

    const batch = await env.service.ingest({});
    const stats = (batch.result as { stats: { sessionsScanned: number; sessionsIngested: number } }).stats;
    assert.ok(stats.sessionsIngested >= 1, 'the healthy session must still be ingested');
  } finally {
    await env.cleanup();
  }
});

test('scheduling targets 03:00 in the configured zone and creates at most one automatic batch per day', async () => {
  const env = await createEnvironment();
  try {
    const scheduler = new Scheduler({
      config: env.config,
      jobs: env.service.jobs,
      projection: env.service.projection,
    });

    // 03:00 Asia/Shanghai on an arbitrary day.
    const target = instantAtZonedTime({ year: 2026, month: 3, day: 4, hour: 3, minute: 0, second: 0 }, 'Asia/Shanghai');
    const clock = zonedClock(target, 'Asia/Shanghai');
    assert.equal(clock.hour, 3);
    assert.equal(clock.minute, 0);
    assert.equal(clock.day, 4);

    const next = nextDailyRun(new Date(target.getTime() - 60_000), { hour: 3, minute: 0, timeZone: 'Asia/Shanghai' });
    assert.equal(next.getTime(), target.getTime());

    const decision = scheduler.catchUpIfMissed(new Date(target.getTime() + 60_000));
    assert.equal(decision.created, true, 'the missed window must produce a catch-up job');
    assert.equal(decision.job?.trigger, 'catch_up');
    assert.equal(decision.job?.dayKey, dayKey(new Date(target.getTime() + 60_000), 'Asia/Shanghai'));

    // A second attempt on the same natural day must not create another batch.
    const again = scheduler.catchUpIfMissed(new Date(target.getTime() + 120_000));
    assert.equal(again.created, false);
    assert.match(again.reason, /already/i);

    // A natural day whose batch already completed is not repeated, and the next
    // natural day does get exactly one new automatic batch.
    const fresh = new Scheduler({ config: env.config, jobs: env.service.jobs, projection: env.service.projection });
    const tomorrow = new Date(target.getTime() + 24 * 60 * 60 * 1000);
    fresh.markAutoDayComplete(dayKey(new Date(target.getTime() + 60_000), 'Asia/Shanghai'), 'job_done');
    const nextDay = fresh.catchUpIfMissed(tomorrow);
    assert.equal(nextDay.created, true, 'the next natural day is due');
    assert.equal(nextDay.job?.dayKey, dayKey(tomorrow, 'Asia/Shanghai'));
    assert.equal(fresh.catchUpIfMissed(tomorrow).created, false, 'and only once');

    // Nothing at all happens when scheduling is disabled.
    const disabled = new Scheduler({
      config: { ...env.config, schedule: { ...env.config.schedule, enabled: false } },
      jobs: env.service.jobs,
      projection: env.service.projection,
    });
    assert.equal(disabled.catchUpIfMissed(tomorrow).created, false);
  } finally {
    await env.cleanup();
  }
});

test('a startup catch-up is recorded so the same day is not repeated', async () => {
  const env = await createEnvironment();
  try {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000001003',
      userMessages: ['构建命令是 pnpm build'],
    });
    await ageFile(path);

    // The bootstrap already created a catch-up job; run the queue to completion.
    await env.service.drainJobs(10);
    const state = await env.service.ingestStatus();
    assert.ok(state.lastAutomaticJob, 'the automatic job must be recorded');
    assert.equal(state.lastAutomaticJob?.status === 'done' || state.lastAutomaticJob?.status === 'skipped', true);

    const today = dayKey(new Date(), env.config.schedule.timeZone);
    assert.equal(env.service.projection.getSchedulerState('last_auto_ingest_day'), today);

    // A fresh bootstrap on the same day must not create a second automatic batch.
    const before = env.service.jobs.list({ kind: 'ingest_batch', limit: 50 }).length;
    const { reconcileFromGit } = await import('../jobs/reconcile.ts');
    await reconcileFromGit({
      store: env.service.store,
      repository: env.service.repository,
      commits: env.service.commits,
      jobs: env.service.jobs,
      projection: env.service.projection,
    });
    const decision = env.service.scheduler.catchUpIfMissed();
    assert.equal(decision.created, false);
    assert.equal(env.service.jobs.list({ kind: 'ingest_batch', limit: 50 }).length, before);
  } finally {
    await env.cleanup();
  }
});

test('reconciliation rebuilds a missing SQLite commit row from Git and repairs interrupted jobs', async () => {
  const env = await createEnvironment();
  try {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000001004',
      userMessages: ['测试命令是 pnpm vitest'],
    });
    await ageFile(path);
    const result = await env.service.ingest({ force: true });
    assert.ok(result.jobId);

    // Simulate "Git committed, SQLite update lost": drop the ledger row and leave
    // the job stuck in the committing state.
    env.service.database.run('DELETE FROM git_commits WHERE job_id = ?', [result.jobId]);
    env.service.database.run(
      `UPDATE jobs SET status = 'committing', reconcile_state = 'awaiting_commit', finished_at = NULL WHERE job_id = ?`,
      [result.jobId],
    );

    const report = await reconcileFromGit({
      store: env.service.store,
      repository: env.service.repository,
      commits: env.service.commits,
      jobs: env.service.jobs,
      projection: env.service.projection,
    });

    assert.ok(report.recoveredCommits.length >= 1, 'the commit must be recovered from Git history');
    const job = env.service.jobs.get(result.jobId);
    assert.equal(job?.status, 'done', 'the interrupted job must be finished by reconciliation');
    assert.equal(job?.reconcileState, 'reconciled');
    assert.ok(env.service.commits.findByJob(result.jobId), 'the ledger row is rebuilt');
    assert.ok(report.index.entries >= 1, 'the projection is rebuilt as part of reconciliation');

    // Repeated reconciliation is idempotent.
    const second = await reconcileFromGit({
      store: env.service.store,
      repository: env.service.repository,
      commits: env.service.commits,
      jobs: env.service.jobs,
      projection: env.service.projection,
    });
    assert.equal(second.recoveredCommits.length, 0);
    assert.equal(second.repairedJobs.length, 0);
  } finally {
    await env.cleanup();
  }
});

test('a job interrupted mid-flight is requeued on the next start', async () => {
  const env = await createEnvironment();
  try {
    const job = env.service.jobs.create({
      kind: 'index_rebuild',
      trigger: 'manual',
      priority: JOB_PRIORITY.manual,
    });
    env.service.jobs.claimNext();
    assert.equal(env.service.jobs.get(job.jobId)?.status, 'running');

    const recovered = env.service.jobs.recoverInFlight();
    assert.ok(recovered.some((entry) => entry.jobId === job.jobId));
    assert.equal(env.service.jobs.get(job.jobId)?.status, 'queued');
  } finally {
    await env.cleanup();
  }
});

test('the health report exposes the state an operator needs, including invalid files', async () => {
  const env = await createEnvironment();
  try {
    const path = await writeCodexSession(env.root, {
      sessionId: '01a00000-0000-7000-8000-000000001005',
      userMessages: ['数据库迁移用 drizzle'],
    });
    await ageFile(path);
    await env.service.ingest({});

    const health = await env.service.health();
    assert.equal(health.status, 'ok');
    assert.equal(health.runtime, 'fake');
    assert.equal(health.index.stale, false, 'ingestion leaves the index consistent with HEAD');
    assert.equal(health.memoryRepo.dirty, false);
    assert.deepEqual(health.memoryRepo.invalidFiles, []);
    assert.ok(health.schedule.nextRunAt);
    assert.equal(health.database.path.length > 0, true);

    // A hand-written invalid file is reported rather than silently ignored.
    await env.service.store.commit([{ path: 'active/profile/pro_broken.md', content: 'no frontmatter here\n' }], {
      expectedHead: await env.service.store.head(),
      subject: 'add a broken file',
      trailers: { kind: 'test' },
    });
    const degraded = await env.service.health();
    assert.deepEqual(degraded.memoryRepo.invalidFiles, ['active/profile/pro_broken.md']);

    const doctor = await env.service.doctor();
    assert.ok(doctor.checks.some((check) => check.name === 'memory-files' && check.status === 'warn'));
  } finally {
    await env.cleanup();
  }
});

test('doctor reports every dependency the service needs', async () => {
  const env = await createEnvironment();
  try {
    const report = await env.service.doctor();
    const names = report.checks.map((check) => check.name);
    for (const expected of [
      'service',
      'config',
      'source:codex',
      'database',
      'memory-repository',
      'model',
      'git',
      'auth',
      'bind',
      'search-index',
      'reviews',
      'schedule',
      'skills-directory',
      'memory-files',
    ]) {
      assert.ok(names.includes(expected), `doctor must report ${expected}; saw ${names.join(', ')}`);
    }
    assert.equal(report.ok, true, JSON.stringify(report.checks.filter((check) => check.status === 'fail')));
    assert.equal(report.version, '0.1.0');
  } finally {
    await env.cleanup();
  }
});

test('a single-session job ingests only that session, never the whole batch', async () => {
  // Scheduling off, so the bootstrap catch-up batch cannot interfere with the
  // assertion about what a single-session job does.
  const env = await createEnvironment({ scheduleEnabled: false });
  try {
    // Three discoverable sessions; only the one that is referenced may be digested.
    const paths = [
      await writeCodexSession(env.root, {
        sessionId: '01a00000-0000-7000-8000-000000001101',
        userMessages: ['这条会话不应该被单会话任务处理'],
      }),
      await writeCodexSession(env.root, {
        sessionId: '01a00000-0000-7000-8000-000000001102',
        userMessages: ['这条会话才是被指定的目标'],
      }),
      await writeCodexSession(env.root, {
        sessionId: '01a00000-0000-7000-8000-000000001103',
        userMessages: ['这条会话也不应该被单会话任务处理'],
      }),
    ];
    for (const path of paths) await ageFile(path);

    // Queue the job the way the API does, then let the worker execute it.
    env.service.jobs.create({
      kind: 'ingest_session',
      trigger: 'manual',
      priority: 90,
      payload: { sessionId: '01a00000-0000-7000-8000-000000001102', force: true },
    });
    await env.service.drainJobs(10);

    const sessions = env.service.sessions.listSessions({ limit: 50 });
    const ingested = sessions.filter((session) => session.status === 'ingested');
    assert.equal(ingested.length, 1, `exactly one session may be ingested, saw ${ingested.map((s) => s.sessionId).join(', ')}`);
    assert.equal(ingested[0]?.sessionId, '01a00000-0000-7000-8000-000000001102');

    const status = await env.service.ingestStatus();
    assert.equal(status.cases, 1, 'no case may be created for sessions that were not ingested');
  } finally {
    await env.cleanup();
  }
});
