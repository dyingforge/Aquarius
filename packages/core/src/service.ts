import { join } from 'node:path';
import {
  SERVICE_VERSION,
  assertMemoryRepoUsable,
  loadConfig,
  sanitizeConfigForOutput,
  type AquariusConfig,
  type ConfigIssue,
} from './config.ts';
import { AquariusError } from './errors.ts';
import { AquariusDatabase, openAndMigrate } from './db/database.ts';
import { SessionStore } from './db/sessionStore.ts';
import { JobStore, JOB_PRIORITY, type JobRecord } from './db/jobStore.ts';
import { ReviewStore } from './db/reviewStore.ts';
import { ProjectionStore } from './db/projectionStore.ts';
import { CommitStore } from './db/commitStore.ts';
import { MemoryStore } from './git/memoryStore.ts';
import { MemoryRepository } from './memory/repository.ts';
import { AdapterRegistry } from './sources/registry.ts';
import { createRedactor, type Redactor } from './security/redact.ts';
import { configureLogging, createLogger } from './util/logger.ts';
import { AsyncMutex } from './util/mutex.ts';
import { sha256 } from './util/fsx.ts';
import { dayKey } from './util/time.ts';
import { BudgetedAgentRuntime, type AgentRuntime } from './agents/runtime.ts';
import { FakeAgentRuntime } from './agents/fakeRuntime.ts';
import { OpenAIAgentRuntime } from './agents/openaiRuntime.ts';
import { IngestService } from './pipeline/ingest.ts';
import { RetrievalService, type QueryResponse, type IndexRebuildReport } from './query/retrieval.ts';
import { CorrectionService, type CorrectionConfirmation, type CorrectionPreview } from './corrections/service.ts';
import { ReviewService, type ReviewDecision, type ReviewResolution } from './reviews/service.ts';
import { SkillService } from './skills/service.ts';
import { JobQueue } from './jobs/queue.ts';
import { Scheduler, type ScheduleDecision } from './jobs/scheduler.ts';
import { reconcileFromGit, type ReconcileReport } from './jobs/reconcile.ts';
import { isQueryReadablePath } from './memory/paths.ts';
import { gitVersion } from './git/git.ts';

const log = createLogger('service');

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  actionable?: string;
}

export interface DoctorReport {
  ok: boolean;
  version: string;
  checkedAt: string;
  checks: DoctorCheck[];
}

export interface HealthReport {
  status: 'ok' | 'degraded';
  version: string;
  runtime: 'openai' | 'fake';
  model: string;
  head: string | null;
  index: { head: string | null; rebuiltAt: string | null; entries: number; stale: boolean };
  database: { path: string; schemaVersion: number };
  memoryRepo: {
    path: string;
    head: string | null;
    commits: number;
    dirty: boolean;
    /** Files present at HEAD that do not satisfy the memory contract. */
    invalidFiles: string[];
  };
  jobs: Record<string, number>;
  queue: { busy: boolean; currentJobId: string | null };
  schedule: ReturnType<Scheduler['describe']>;
  openReviews: number;
  sources: { source: string; schemaVersion: number; paths: string[]; available: boolean }[];
}

export interface ServiceOptions {
  config: AquariusConfig;
  configIssues?: ConfigIssue[];
  /** Override the agent runtime, used by tests. */
  runtime?: AgentRuntime;
}

/**
 * Composition root.
 *
 * Everything the HTTP API and the CLI can do is a method here; the transport
 * layers hold no business logic. Write methods run inside the shared mutex, so
 * they cannot interleave with a queued ingestion job's Git write.
 */
export class AquariusService {
  readonly config: AquariusConfig;
  readonly configIssues: ConfigIssue[];
  readonly database: AquariusDatabase;
  readonly sessions: SessionStore;
  readonly jobs: JobStore;
  readonly reviews: ReviewStore;
  readonly projection: ProjectionStore;
  readonly commits: CommitStore;
  readonly store: MemoryStore;
  readonly repository: MemoryRepository;
  readonly adapters: AdapterRegistry;
  readonly redactor: Redactor;
  readonly runtime: AgentRuntime;
  readonly ingestion: IngestService;
  readonly retrieval: RetrievalService;
  readonly corrections: CorrectionService;
  readonly reviewService: ReviewService;
  readonly skills: SkillService;
  readonly queue: JobQueue;
  readonly scheduler: Scheduler;
  readonly mutex = new AsyncMutex();

  private constructor(options: ServiceOptions, database: AquariusDatabase) {
    this.config = options.config;
    this.configIssues = options.configIssues ?? [];
    this.database = database;
    this.sessions = new SessionStore(database);
    this.jobs = new JobStore(database);
    this.reviews = new ReviewStore(database);
    this.projection = new ProjectionStore(database);
    this.commits = new CommitStore(database);
    this.store = new MemoryStore(options.config.memoryRepoPath);
    this.repository = new MemoryRepository(this.store, { timeZone: options.config.schedule.timeZone });
    this.adapters = AdapterRegistry.fromConfig(options.config);
    this.redactor = createRedactor(options.config.redactionExtraPatterns);

    const baseRuntime =
      options.runtime ??
      (options.config.agentRuntime === 'fake'
        ? new FakeAgentRuntime({ model: options.config.model })
        : new OpenAIAgentRuntime({
            config: options.config,
            readMemoryFile: (path) =>
              isQueryReadablePath(path) ? this.store.readFile(path) : Promise.resolve(null),
          }));
    this.runtime = new BudgetedAgentRuntime(baseRuntime, options.config.budgets);

    this.ingestion = new IngestService({
      config: options.config,
      store: this.store,
      repository: this.repository,
      sessions: this.sessions,
      jobs: this.jobs,
      reviews: this.reviews,
      projection: this.projection,
      commits: this.commits,
      adapters: this.adapters,
      runtime: this.runtime,
      redactor: this.redactor,
      withCommitLock: (fn) => this.mutex.runExclusive(fn),
    });
    this.retrieval = new RetrievalService({
      repository: this.repository,
      projection: this.projection,
      runtime: this.runtime,
      timeZone: options.config.schedule.timeZone,
    });
    this.corrections = new CorrectionService({
      config: options.config,
      store: this.store,
      repository: this.repository,
      reviews: this.reviews,
      projection: this.projection,
      commits: this.commits,
    });
    this.reviewService = new ReviewService({
      config: options.config,
      store: this.store,
      repository: this.repository,
      reviews: this.reviews,
      projection: this.projection,
      commits: this.commits,
    });
    this.skills = new SkillService({
      config: options.config,
      store: this.store,
      repository: this.repository,
      sessions: this.sessions,
      jobs: this.jobs,
      reviews: this.reviews,
      projection: this.projection,
      commits: this.commits,
      runtime: this.runtime,
      redactor: this.redactor,
    });

    this.queue = new JobQueue({
      jobs: this.jobs,
      handler: (job, signal) => this.#handleJob(job, signal),
    });
    this.scheduler = new Scheduler({ config: options.config, jobs: this.jobs, projection: this.projection });
  }

  /**
   * Opens the database, initializes the memory repository when needed, and
   * verifies the token. Throws an actionable error rather than starting in a
   * half-usable state.
   */
  static async create(serviceOptions: ServiceOptions): Promise<AquariusService> {
    const { config, configIssues } = serviceOptions;
    if (configIssues && configIssues.length > 0) {
      throw new AquariusError(
        'config_missing',
        `Aquarius cannot start:\n${configIssues.map((issue) => `  - ${issue.field}: ${issue.message}`).join('\n')}`,
        { details: { issues: configIssues }, actionable: 'Fix the configuration and start Aquarius again.' },
      );
    }

    await assertMemoryRepoUsable(config.memoryRepoPath);
    const store = new MemoryStore(config.memoryRepoPath);
    const created = await store.ensureInitialized();
    if (created) log.info('memory repository initialized', { path: config.memoryRepoPath });

    const { database } = await openAndMigrate(config.databasePath);
    const service = new AquariusService(serviceOptions, database);
    service.#registerToken();
    return service;
  }

  /** Variant used by tests and dry-run tooling: no config validation, in-memory or temp paths. */
  static async createForTest(options: ServiceOptions & { database?: AquariusDatabase }): Promise<AquariusService> {
    await assertMemoryRepoUsable(options.config.memoryRepoPath);
    const store = new MemoryStore(options.config.memoryRepoPath);
    await store.ensureInitialized();
    const database = options.database ?? (await openAndMigrate(options.config.databasePath)).database;
    const service = new AquariusService(options, database);
    service.#registerToken();
    return service;
  }

  #registerToken(): void {
    if (this.config.apiToken === '') return;
    this.projection.upsertToken({
      tokenId: this.config.apiTokenId,
      label: 'local',
      tokenHash: sha256(this.config.apiToken),
    });
  }

  /** Verifies a presented bearer token without leaking timing information. */
  verifyToken(token: string): boolean {
    if (token === '' || this.config.apiToken === '') return false;
    const candidate = sha256(token);
    const expected = sha256(this.config.apiToken);
    let mismatch = candidate.length ^ expected.length;
    for (let index = 0; index < candidate.length; index += 1) {
      mismatch |= candidate.charCodeAt(index) ^ expected.charCodeAt(index);
    }
    const ok = mismatch === 0;
    if (ok && !this.database.closed) {
      const record = this.projection.findTokenByHash(candidate);
      if (record) this.projection.touchToken(record.tokenId);
    }
    return ok;
  }

  /** Startup work: reconcile Git↔SQLite, catch up the schedule, verify installs. */
  async bootstrap(): Promise<{
    reconcile: ReconcileReport;
    schedule: ScheduleDecision;
    skills: { skillId: string; ok: boolean; reason: string }[];
  }> {
    this.projection.setMeta('service_version', SERVICE_VERSION);
    this.projection.setMeta('agent_runtime', this.runtime.mode);

    const recovered = this.jobs.recoverInFlight();
    if (recovered.length > 0) log.warn('requeued interrupted jobs', { count: recovered.length });

    const reconcile = await reconcileFromGit({
      store: this.store,
      repository: this.repository,
      commits: this.commits,
      jobs: this.jobs,
      projection: this.projection,
    });
    const schedule = this.scheduler.catchUpIfMissed();
    const skillState = await this.skills.verifyInstallations();
    for (const entry of skillState) {
      if (!entry.ok) log.warn('skill installation check failed', { skill: entry.skillId, reason: entry.reason });
    }
    return { reconcile, schedule, skills: skillState };
  }

  start(): void {
    this.queue.start();
    this.scheduler.start();
  }

  async stop(): Promise<void> {
    this.queue.stop();
    this.scheduler.stop();
    this.database.close();
  }

  /** Processes queued work until the queue drains. Used by the CLI and by tests. */
  async drainJobs(maxJobs = 50): Promise<number> {
    return this.queue.drain(maxJobs);
  }

  // --- reads -----------------------------------------------------------------

  async query(question: string, options: { limit?: number } = {}): Promise<QueryResponse> {
    if (question.trim() === '') {
      throw new AquariusError('validation_failed', 'Ask a question with at least one non-space character.');
    }
    return this.retrieval.ask(question, options);
  }

  async listMemories(options: { kind?: string; status?: string; limit?: number } = {}): Promise<{
    memories: {
      memoryId: string;
      kind: string;
      status: string;
      title: string;
      path: string;
      authority: string;
      confidence: string;
      sensitivity: string;
      tags: string[];
      cases: string[];
      updatedAt: string | null;
    }[];
    counts: Record<string, number>;
    head: string | null;
  }> {
    const memories = await this.retrieval.listMemories(options);
    return {
      memories: memories.map((memory) => ({
        memoryId: memory.memoryId,
        kind: memory.kind,
        status: memory.status,
        title: memory.title,
        path: memory.path,
        authority: memory.authority,
        confidence: memory.confidence,
        sensitivity: memory.sensitivity,
        tags: memory.tags,
        cases: memory.caseIds,
        updatedAt: memory.updatedAt,
      })),
      counts: this.projection.countByStatus(),
      head: await this.store.head(),
    };
  }

  async getMemory(memoryId: string): Promise<{
    memoryId: string;
    kind: string;
    status: string;
    title: string;
    body: string;
    path: string;
    tags: string[];
    authority: string;
    confidence: string;
    confidenceReason: string;
    supportingCaseIds: string[];
    contradictingCaseIds: string[];
    supersedes: string[];
    supersededBy: string | null;
    provenance: Record<string, unknown>;
    sensitivity: string;
    keywords: string[];
    validFrom: string | null;
    validTo: string | null;
    createdAt: string;
    updatedAt: string;
    skill?: Record<string, unknown>;
    evidence: { evidenceId: string; kind: string; authority: string; verified: boolean; createdAt: string }[];
  }> {
    const found = await this.retrieval.getMemory(memoryId);
    if (!found) throw new AquariusError('not_found', `Memory ${memoryId} does not exist at HEAD.`);
    const fm = found.record.frontmatter;
    return {
      memoryId: fm.id,
      kind: fm.kind,
      status: fm.status,
      title: fm.title,
      body: found.record.body,
      path: found.record.path,
      tags: fm.tags,
      authority: fm.authority,
      confidence: fm.confidence,
      confidenceReason: fm.confidence_reason,
      supportingCaseIds: fm.supporting_case_ids,
      contradictingCaseIds: fm.contradicting_case_ids,
      supersedes: fm.supersedes,
      supersededBy: fm.superseded_by ?? null,
      provenance: fm.provenance as unknown as Record<string, unknown>,
      sensitivity: fm.sensitivity,
      keywords: fm.keywords,
      validFrom: fm.valid_from ?? null,
      validTo: fm.valid_to ?? null,
      createdAt: fm.created_at,
      updatedAt: fm.updated_at,
      ...(fm.skill ? { skill: fm.skill as unknown as Record<string, unknown> } : {}),
      evidence: found.evidence.map((item) => ({
        evidenceId: item.evidence_id,
        kind: item.kind,
        authority: item.authority,
        verified: item.verified,
        createdAt: item.created_at,
      })),
    };
  }

  // --- writes ----------------------------------------------------------------

  async ingest(options: { sessionId?: string; force?: boolean } = {}): Promise<{
    jobId: string;
    status: string;
    result: unknown;
  }> {
    if (options.sessionId) {
        const ref = await this.ingestion.findRef(options.sessionId);
        if (!ref) {
          throw new AquariusError('not_found', `Session ${options.sessionId} was not found in the configured sources.`, {
            actionable: 'Check AQUARIUS_CODEX_SESSIONS_DIR, or pass a session file path.',
          });
        }
        const job = this.jobs.create({
          kind: 'ingest_session',
          trigger: 'manual',
          priority: JOB_PRIORITY.manual,
          source: ref.source,
          sessionId: ref.sessionId,
          payload: { sessionId: ref.sessionId, force: options.force ?? true },
        });
        const result = await this.ingestion.ingestRef(ref, job, { force: options.force ?? true });
        if (result.status === 'failed') {
          this.jobs.markFailed(job.jobId, { code: 'job_failed', message: result.reason });
        } else {
          this.jobs.markDone(job.jobId, { commitSha: result.commitSha, stats: { sessions: 1 } });
        }
      if (result.memoryIds.length > 0) await this.skills.evaluateCandidates(result.memoryIds);
      return { jobId: job.jobId, status: result.status, result };
    }

    const day = dayKey(new Date(), this.config.schedule.timeZone);
    const job = this.jobs.create({
      kind: 'ingest_batch',
      trigger: 'manual',
      priority: JOB_PRIORITY.manual,
      dayKey: day,
      payload: { force: options.force ?? false },
    });
    const batch = await this.ingestion.runBatch(job, { force: options.force ?? false });
    this.jobs.markDone(job.jobId, {
      ...(batch.commitShas[0] ? { commitSha: batch.commitShas[0] } : {}),
      stats: batch.stats as unknown as Record<string, unknown>,
    });
    const written = batch.sessions.flatMap((session) => session.memoryIds);
    if (written.length > 0) await this.skills.evaluateCandidates(written);
    return { jobId: job.jobId, status: batch.status, result: batch };
  }

  /**
   * Previews build a diff in an isolated staging area and move no ref, so they run
   * outside the write lock: a preview stays responsive while a batch is running.
   */
  async previewCorrection(input: { instruction: string; requestedBy?: string }): Promise<CorrectionPreview> {
    return this.corrections.preview(input);
  }

  async confirmCorrection(input: {
    reviewId: string;
    expectedHead: string | null;
    requestedBy?: string;
  }): Promise<CorrectionConfirmation> {
    return this.mutex.runExclusive(() => this.corrections.confirm(input));
  }

  async resolveReview(input: {
    reviewId: string;
    decision: ReviewDecision;
    expectedHead: string | null;
    resolvedBy?: string;
    note?: string;
    mergedBody?: string | null;
    mergedTitle?: string | null;
    dryRun?: boolean;
  }): Promise<ReviewResolution> {
    return this.mutex.runExclusive(() => this.reviewService.resolve(input));
  }

  async approveSkill(input: {
    skillId: string;
    expectedHead: string | null;
    approvedBy: string;
    note?: string;
  }): Promise<{ skillId: string; commitSha: string; installPath: string; version: number; fileHash: string }> {
    return this.mutex.runExclusive(() => this.skills.approve(input));
  }

  async rejectSkill(input: {
    skillId: string;
    reason: string;
    resolvedBy: string;
    expectedHead: string | null;
  }): Promise<{ commitSha: string }> {
    return this.mutex.runExclusive(() => this.skills.reject(input));
  }

  async rollbackSkill(input: {
    skillId: string;
    expectedHead: string | null;
    requestedBy: string;
  }): Promise<{ commitSha: string; version: number; installPath: string }> {
    return this.mutex.runExclusive(() => this.skills.rollback(input));
  }

  async retireSkill(input: {
    skillId: string;
    expectedHead: string | null;
    requestedBy: string;
  }): Promise<{ commitSha: string; installPath: string | null; removedDirectory: string | null }> {
    return this.mutex.runExclusive(() => this.skills.retire(input));
  }

  /**
   * Re-evaluates the skill-candidate precondition. Called after ingestion, and
   * available to the API so a user can re-check after correcting case metadata.
   */
  async evaluateSkillCandidates(
    memoryIds?: string[],
  ): Promise<{ queued: { memoryId: string; jobId: string }[]; skipped: { memoryId: string; reasons: string[] }[] }> {
    return this.mutex.runExclusive(async () => {
      const ids =
        memoryIds ??
        (await this.repository.snapshot()).records
          .filter((record) => record.frontmatter.kind === 'strategy' && record.frontmatter.status === 'active')
          .map((record) => record.frontmatter.id);
      return this.skills.evaluateCandidates(ids);
    });
  }

  async rebuildIndex(): Promise<IndexRebuildReport> {
    return this.mutex.runExclusive(() => this.retrieval.rebuildIndex());
  }

  // --- operations ------------------------------------------------------------

  async ingestStatus(): Promise<{
    schedule: ReturnType<Scheduler['describe']>;
    lastAutomaticJob: JobRecord | null;
    sessions: { total: number; pending: number; deferred: number; ingested: number; failed: number };
    recentJobs: JobRecord[];
    cases: number;
    head: string | null;
  }> {
    const sessions = this.sessions.listSessions({ limit: 1000 });
    const lastAutoId = this.projection.getSchedulerState('last_auto_ingest_job');
    return {
      schedule: this.scheduler.describe(),
      lastAutomaticJob: lastAutoId ? this.jobs.get(lastAutoId) : null,
      sessions: {
        total: sessions.length,
        pending: sessions.filter((session) => session.status === 'pending' || session.status === 'discovered').length,
        deferred: sessions.filter((session) => session.status === 'deferred').length,
        ingested: sessions.filter((session) => session.status === 'ingested').length,
        failed: sessions.filter((session) => session.status === 'failed').length,
      },
      recentJobs: this.jobs.list({ limit: 20 }),
      cases: this.sessions.caseCount(),
      head: await this.store.head(),
    };
  }

  /** Dispatch for queued work. Everything here runs inside the write mutex. */
  async #handleJob(job: JobRecord, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new AquariusError('job_failed', 'Job was cancelled before it started.');
    switch (job.kind) {
      case 'ingest_session': {
        // A single-session job must ingest exactly that session; running the whole
        // batch here would silently digest every other discovered session too.
        const sessionId = job.payload['sessionId'] ?? job.sessionId;
        if (typeof sessionId !== 'string' || sessionId === '') {
          throw new AquariusError('validation_failed', 'ingest_session job is missing its sessionId.');
        }
        const ref = await this.ingestion.findRef(sessionId);
        if (!ref) {
          this.jobs.markSkipped(job.jobId, `Session ${sessionId} is no longer present in the configured sources.`);
          return;
        }
        const result = await this.ingestion.ingestRef(ref, job, { force: job.payload['force'] === true });
        if (result.status === 'failed') {
          throw new AquariusError('job_failed', result.reason);
        }
        this.jobs.markDone(job.jobId, {
          commitSha: result.commitSha,
          stats: { sessions: 1, memoriesWritten: result.memoryIds.length, reviewsOpened: result.reviewIds.length },
        });
        if (result.memoryIds.length > 0) await this.skills.evaluateCandidates(result.memoryIds);
        return;
      }
      case 'ingest_batch': {
        const batch = await this.ingestion.runBatch(job, {
          force: job.payload['force'] === true,
        });
        const written = batch.sessions.flatMap((session) => session.memoryIds);
        if (written.length > 0) {
          const evaluation = await this.skills.evaluateCandidates(written);
          if (evaluation.queued.length > 0) {
            this.jobs.markDone(job.jobId, {
              ...(batch.commitShas[0] ? { commitSha: batch.commitShas[0] } : {}),
              stats: { ...batch.stats, skillCandidatesQueued: evaluation.queued.length },
            });
            return;
          }
        }
        this.jobs.markDone(job.jobId, {
          ...(batch.commitShas[0] ? { commitSha: batch.commitShas[0] } : {}),
          stats: batch.stats as unknown as Record<string, unknown>,
        });
        if (batch.status === 'skipped') this.jobs.markSkipped(job.jobId, batch.reason, batch.stats as unknown as Record<string, unknown>);
        if ((job.kind === 'ingest_batch' && job.trigger === 'schedule') || job.trigger === 'catch_up') {
          this.scheduler.markAutoDayComplete(job.dayKey ?? dayKey(new Date(), this.config.schedule.timeZone), job.jobId);
        }
        return;
      }
      case 'skill_synthesize': {
        const strategyMemoryId = job.payload['strategyMemoryId'];
        if (typeof strategyMemoryId !== 'string') {
          throw new AquariusError('validation_failed', 'skill_synthesize job is missing strategyMemoryId.');
        }
        await this.skills.generateCandidate(strategyMemoryId);
        return;
      }
      case 'index_rebuild': {
        await this.retrieval.rebuildIndex();
        return;
      }
      case 'reconcile': {
        await reconcileFromGit({
          store: this.store,
          repository: this.repository,
          commits: this.commits,
          jobs: this.jobs,
          projection: this.projection,
        });
        return;
      }
      default: {
        throw new AquariusError('not_implemented', `Job kind ${job.kind} has no handler.`);
      }
    }
  }

  async health(): Promise<HealthReport> {
    const head = await this.store.head();
    const stats = await this.store.repositoryStats();
    const index = this.projection.indexState();
    const dirty = (await this.store.dirtyPaths()).length > 0;
    const stale = index.head !== head;
    const invalidFiles = (await this.repository.snapshot(head)).parseErrors.map((error) => error.split(':')[0] ?? error);
    return {
      status: stale || dirty ? 'degraded' : 'ok',
      version: SERVICE_VERSION,
      runtime: this.runtime.mode,
      model: this.runtime.model,
      head,
      index: { head: index.head, rebuiltAt: index.rebuiltAt, entries: index.memoryCount, stale },
      database: { path: this.database.path, schemaVersion: this.database.schemaVersion },
      memoryRepo: {
        path: this.store.repoPath,
        head,
        commits: stats.commits,
        dirty,
        invalidFiles: [...new Set(invalidFiles)],
      },
      jobs: this.jobs.stats(),
      queue: { busy: this.queue.busy, currentJobId: this.queue.currentJobId },
      schedule: this.scheduler.describe(),
      openReviews: this.reviews.countOpen(),
      sources: this.adapters.describe(),
    };
  }

  /** `doctor`: every dependency the service needs, with actionable failures. */
  async doctor(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];
    const push = (name: string, status: DoctorStatus, detail: string, actionable?: string): void => {
      checks.push(actionable ? { name, status, detail, actionable } : { name, status, detail });
    };

    push('service', 'ok', `Aquarius ${SERVICE_VERSION}`);

    if (this.configIssues.length === 0) {
      push('config', 'ok', `configuration loaded from ${this.config.configPath}`);
    } else {
      for (const issue of this.configIssues) {
        push(`config:${issue.field}`, 'fail', issue.message, issue.actionable);
      }
    }

    for (const adapter of this.adapters.describe()) {
      push(
        `source:${adapter.source}`,
        adapter.available ? 'ok' : 'warn',
        `${adapter.source}@${adapter.schemaVersion}: ${adapter.paths.join(', ')}`,
      );
    }

    // Confirms the configured Codex directories actually exist, so a typo is
    // reported here instead of silently ingesting nothing.
    const { exists } = await import('./util/fsx.ts');
    for (const [label, path] of [
      ['codex-sessions', this.config.sources.codexSessionsDir],
      ['codex-archived', this.config.sources.codexArchivedDir],
      ['codex-index', this.config.sources.codexSessionIndex],
    ] as const) {
      const present = await exists(path);
      push(
        label,
        present ? 'ok' : 'warn',
        present ? path : `${path} (missing)`,
        present ? undefined : 'Nothing will be ingested from this source until the path exists.',
      );
    }

    try {
      const { report } = await Promise.resolve({ report: { currentVersion: this.database.schemaVersion } });
      push('database', 'ok', `${this.config.databasePath} (schema v${report.currentVersion})`);
    } catch (error) {
      push('database', 'fail', (error as Error).message, 'Delete the database and rebuild the index from Git.');
    }

    try {
      const stats = await this.store.repositoryStats();
      push(
        'memory-repository',
        'ok',
        `${this.store.repoPath} (branch ${stats.branch}, ${stats.commits} commits, head ${stats.head?.slice(0, 12) ?? 'unborn'})`,
      );
      const dirty = await this.store.dirtyPaths();
      if (dirty.length > 0) {
        push('memory-repository:clean', 'warn', `uncommitted changes: ${dirty.slice(0, 3).join(', ')}`, 'Commit or discard them; Aquarius refuses to commit over a dirty tree.');
      }
      const storePath = join(this.store.repoPath);
      push('memory-repository:path', 'ok', `separate from the application checkout at ${storePath}`);
    } catch (error) {
      push('memory-repository', 'fail', (error as Error).message, 'Run the service once to initialize the repository.');
    }

    const runtime = this.runtime.describe();
    push(
      'model',
      this.config.agentRuntime === 'fake' ? 'warn' : 'ok',
      `runtime=${runtime.mode} model=${runtime.model} tracing=${runtime.tracing ? 'on' : 'off'}`,
      this.config.agentRuntime === 'fake'
        ? 'Dry-run mode: agent outputs come from a deterministic test double, not a model.'
        : undefined,
    );
    if (this.config.agentRuntime === 'openai' && !this.config.openaiApiKey) {
      push('model:credentials', 'fail', 'OPENAI_API_KEY is not set', 'Export OPENAI_API_KEY in the service environment.');
    } else if (this.config.agentRuntime === 'openai') {
      push('model:credentials', 'ok', 'OPENAI_API_KEY present (value never logged)');
    }

    const git = await gitVersion();
    push('git', git ? 'ok' : 'fail', git ?? 'git CLI not found', git ? undefined : 'Install Git and put it on PATH.');

    const tokenOk = this.config.apiToken !== '';
    push(
      'auth',
      tokenOk ? 'ok' : 'fail',
      tokenOk ? `local bearer token registered (${this.config.apiTokenId})` : 'no API token configured',
      tokenOk ? undefined : 'Start the service once to generate a token, or set AQUARIUS_API_TOKEN.',
    );
    push('bind', this.config.host === '127.0.0.1' ? 'ok' : 'fail', `${this.config.host}:${this.config.port}`);

    const snapshotForValidation = await this.repository.snapshot();
    if (snapshotForValidation.parseErrors.length > 0) {
      push(
        'memory-files',
        'warn',
        `${snapshotForValidation.parseErrors.length} file(s) at HEAD fail the memory contract`,
        `Fix them (or run \`aquarius index rebuild\` after fixing): ${snapshotForValidation.parseErrors.slice(0, 3).join(' | ')}`,
      );
    } else {
      push('memory-files', 'ok', `${snapshotForValidation.records.length} record(s) validated at HEAD`);
    }

    const index = this.projection.indexState();
    const head = await this.store.head();
    push(
      'search-index',
      index.head === head ? 'ok' : 'warn',
      `${index.memoryCount} entries, rebuilt ${index.rebuiltAt ?? 'never'}`,
      index.head === head ? undefined : 'The index is behind Git HEAD; run `aquarius index rebuild`.',
    );

    const openReviews = this.reviews.countOpen();
    push(
      'reviews',
      openReviews === 0 ? 'ok' : 'warn',
      `${openReviews} open review(s)`,
      openReviews === 0 ? undefined : 'Resolve them with `aquarius review list` and `aquarius review resolve`.',
    );

    const schedule = this.scheduler.describe();
    push(
      'schedule',
      schedule.enabled ? 'ok' : 'warn',
      `daily ${schedule.hour}:${String(schedule.minute).padStart(2, '0')} ${schedule.timeZone}, next ${schedule.nextRunAt}, last auto day ${schedule.lastAutoDay ?? 'never'}`,
    );

    const installs = await this.skills.listInstallDirectory();
    push(
      'skills-directory',
      'ok',
      `${this.config.skillInstallDir}: ${installs.length} skill(s), ${installs.filter((entry) => entry.managed).length} managed by Aquarius`,
    );

    return {
      ok: checks.every((check) => check.status !== 'fail'),
      version: SERVICE_VERSION,
      checkedAt: new Date().toISOString(),
      checks,
    };
  }

  configSummary(): Record<string, unknown> {
    return sanitizeConfigForOutput(this.config);
  }
}

export { loadConfig, configureLogging, SERVICE_VERSION };
export type { AquariusConfig };
