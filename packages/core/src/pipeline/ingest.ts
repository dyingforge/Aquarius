import { basename } from 'node:path';
import type { AquariusConfig } from '../config.ts';
import { AquariusError } from '../errors.ts';
import type { MemoryStore } from '../git/memoryStore.ts';
import type { MemoryRepository, MemorySnapshot } from '../memory/repository.ts';
import { serializeRecord } from '../memory/repository.ts';
import { evidencePath, auditPath, reviewPath, memoryPath } from '../memory/paths.ts';
import { serializeEvidence } from '../memory/frontmatter.ts';
import { buildSummary } from '../memory/summary.ts';
import type {
  EvidenceFrontmatter,
  MemoryFrontmatter,
  MemoryRecord,
  Authority,
  Confidence,
  Sensitivity,
} from '../memory/schema.ts';
import { SCHEMA_VERSION } from '../memory/schema.ts';
import type { CaseRecord, NewEvidence, SessionStore } from '../db/sessionStore.ts';
import { JOB_PRIORITY, type JobRecord, type JobStore } from '../db/jobStore.ts';
import type { ReviewStore } from '../db/reviewStore.ts';
import type { ProjectionStore } from '../db/projectionStore.ts';
import type { CommitStore } from '../db/commitStore.ts';
import type { AdapterRegistry } from '../sources/registry.ts';
import type { NormalizedSession, SanitizedSession, SessionRef } from '../sources/adapter.ts';
import { extractEvidence, sanitizeSession } from '../security/sanitizeSession.ts';
import type { RedactionFinding, Redactor } from '../security/redact.ts';
import type { AgentRuntime } from '../agents/runtime.ts';
import type { ConsolidationOperation, EvidenceCandidate, Observation, RelatedMemory } from '../agents/contracts.ts';
import { applyPromotionGate, PROMOTION_RULES, type GateDecision } from '../gates/promotion.ts';
import { looksContradictory } from '../agents/contradiction.ts';
import { lexicalOverlap } from '../query/ftsText.ts';
import { projectFromGit, toRelatedMemory } from '../query/retrieval.ts';
import { deriveId, newCaseId, newMemoryId, newReviewId, slugify } from '../util/ids.ts';
import { dayKey, nowIso } from '../util/time.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('pipeline:ingest');

/** Operation names that mutate an existing memory instead of adding one. */
const CHANGE_OPERATIONS: ReadonlySet<ConsolidationOperation['operation']> = new Set([
  'reinforce',
  'temporal_change',
  'supersede',
  'conflict',
]);

export interface IngestStats {
  sessionsScanned: number;
  sessionsIngested: number;
  sessionsUnchanged: number;
  sessionsDeferred: number;
  sessionsFailed: number;
  observations: number;
  memoriesWritten: number;
  reviewsOpened: number;
  commits: number;
  skippedEvents: { type: string; count: number }[];
  redactionRules: string[];
}

export interface SessionIngestResult {
  status: 'ingested' | 'unchanged' | 'deferred' | 'failed';
  source: string;
  sessionId: string;
  rootThreadId: string;
  caseId: string | null;
  commitSha: string | null;
  memoryIds: string[];
  reviewIds: string[];
  observations: number;
  reason: string;
  skippedEvents: { type: string; count: number }[];
  redactionRules: string[];
}

export interface BatchIngestResult {
  status: 'done' | 'skipped';
  reason: string;
  stats: IngestStats;
  sessions: SessionIngestResult[];
  commitShas: string[];
}

function emptyStats(): IngestStats {
  return {
    sessionsScanned: 0,
    sessionsIngested: 0,
    sessionsUnchanged: 0,
    sessionsDeferred: 0,
    sessionsFailed: 0,
    observations: 0,
    memoriesWritten: 0,
    reviewsOpened: 0,
    commits: 0,
    skippedEvents: [],
    redactionRules: [],
  };
}

interface RecordPlan {
  upserts: { record: MemoryRecord }[];
  reviews: {
    reviewId: string;
    type: 'promotion' | 'conflict';
    memoryIds: string[];
    proposal: Record<string, unknown>;
    dedupeKey: string;
  }[];
  evidenceFiles: { path: string; content: string }[];
  writtenMemoryIds: string[];
  observations: number;
}

/**
 * Codex session → validated Git memory.
 *
 * The pipeline is linear and single-writer: parse, redact, extract, consolidate,
 * gate, validate, commit, re-project. Agents only ever produce proposals; every
 * write below is decided by TypeScript.
 */
export class IngestService {
  #config: AquariusConfig;
  #store: MemoryStore;
  #repository: MemoryRepository;
  #sessions: SessionStore;
  #jobs: JobStore;
  #reviews: ReviewStore;
  #projection: ProjectionStore;
  #commits: CommitStore;
  #adapters: AdapterRegistry;
  #runtime: AgentRuntime;
  #redactor: Redactor;
  #withCommitLock: <T>(fn: () => Promise<T>) => Promise<T>;

  constructor(deps: {
    config: AquariusConfig;
    store: MemoryStore;
    repository: MemoryRepository;
    sessions: SessionStore;
    jobs: JobStore;
    reviews: ReviewStore;
    projection: ProjectionStore;
    commits: CommitStore;
    adapters: AdapterRegistry;
    runtime: AgentRuntime;
    redactor: Redactor;
    /**
     * Wraps the Git commit in the single-writer critical section. Agent calls,
     * parsing and validation stay outside it, so a long batch never blocks a
     * user-initiated correction from making progress.
     */
    withCommitLock?: <T>(fn: () => Promise<T>) => Promise<T>;
  }) {
    this.#withCommitLock = deps.withCommitLock ?? ((fn) => fn());
    this.#config = deps.config;
    this.#store = deps.store;
    this.#repository = deps.repository;
    this.#sessions = deps.sessions;
    this.#jobs = deps.jobs;
    this.#reviews = deps.reviews;
    this.#projection = deps.projection;
    this.#commits = deps.commits;
    this.#adapters = deps.adapters;
    this.#runtime = deps.runtime;
    this.#redactor = deps.redactor;
  }

  /** True when a user- or manually-triggered job is waiting to run. */
  #hasUrgentWork(): boolean {
    return this.#jobs
      .list({ status: 'queued', limit: 20 })
      .some((candidate) => candidate.priority < JOB_PRIORITY.background);
  }

  /** Discovers every session and ingests the ones that need work. */
  async runBatch(
    job: JobRecord,
    options: { force?: boolean; continueAfterPreemption?: boolean } = {},
  ): Promise<BatchIngestResult> {
    const stats = emptyStats();
    const results: SessionIngestResult[] = [];
    const commitShas: string[] = [];
    const limit = this.#config.budgets.maxSessionsPerBatch;

    let preempted = false;
    outer: for (const adapter of this.#adapters.list()) {
      for await (const ref of adapter.discover()) {
        if (stats.sessionsIngested >= limit) break outer;
        // User work outranks background consolidation: stop between sessions if
        // something more important is waiting, and continue in a follow-up job.
        if (job.priority >= JOB_PRIORITY.background && !options.continueAfterPreemption && this.#hasUrgentWork()) {
          preempted = true;
          break outer;
        }
        stats.sessionsScanned += 1;
        try {
          const result = await this.ingestRef(ref, job, { force: options.force ?? false });
          results.push(result);
          switch (result.status) {
            case 'ingested':
              stats.sessionsIngested += 1;
              break;
            case 'unchanged':
              stats.sessionsUnchanged += 1;
              break;
            case 'deferred':
              stats.sessionsDeferred += 1;
              break;
            case 'failed':
              stats.sessionsFailed += 1;
              break;
          }
          stats.observations += result.observations;
          stats.reviewsOpened += result.reviewIds.length;
          for (const rule of result.redactionRules) {
            if (!stats.redactionRules.includes(rule)) stats.redactionRules.push(rule);
          }
          for (const skipped of result.skippedEvents) {
            const existing = stats.skippedEvents.find((entry) => entry.type === skipped.type);
            if (existing) existing.count += skipped.count;
            else stats.skippedEvents.push({ ...skipped });
          }
          if (result.commitSha) {
            stats.commits += 1;
            stats.memoriesWritten += result.memoryIds.length;
            commitShas.push(result.commitSha);
          }
        } catch (error) {
          // One broken session must never stop the batch.
          stats.sessionsFailed += 1;
          log.warn('session ingestion failed', {
            session: ref.sessionId,
            error: error instanceof Error ? error.message : String(error),
          });
          results.push({
            status: 'failed',
            source: ref.source,
            sessionId: ref.sessionId,
            rootThreadId: ref.rootThreadId ?? ref.sessionId,
            caseId: null,
            commitSha: null,
            memoryIds: [],
            reviewIds: [],
            observations: 0,
            reason: error instanceof Error ? error.message : String(error),
            skippedEvents: [],
            redactionRules: [],
          });
        }
      }
    }

    if (preempted) {
      // Finish this batch and queue the remainder behind the user's work.
      const continuation = this.#jobs.create({
        kind: 'ingest_batch',
        trigger: 'post_ingest',
        priority: JOB_PRIORITY.background,
        dayKey: job.dayKey,
        payload: { ...job.payload, continueAfterPreemption: true },
      });
      log.info('batch preempted by user work', { job: job.jobId, continuation: continuation.jobId });
    }

    const anyIngested = stats.sessionsIngested > 0;
    return {
      status: anyIngested ? 'done' : 'skipped',
      reason: preempted
        ? `Ingested ${stats.sessionsIngested} session(s), then yielded to user work; the rest is queued as a follow-up batch.`
        : anyIngested
          ? `Ingested ${stats.sessionsIngested} session(s).`
          : `No session needed ingestion (${stats.sessionsUnchanged} unchanged, ${stats.sessionsDeferred} deferred, ${stats.sessionsFailed} failed).`,
      stats,
      sessions: results,
      commitShas,
    };
  }

  /** Ingests exactly one discovered session reference. */
  async ingestRef(ref: SessionRef, job: JobRecord, options: { force?: boolean } = {}): Promise<SessionIngestResult> {
    const adapter = this.#adapters.get(ref.source);
    if (!adapter) {
      throw new AquariusError('source_unavailable', `No adapter registered for source ${ref.source}`);
    }

    const rootThreadId = this.#sessions.resolveRootThread(ref.source, ref.sessionId, ref.rootThreadId);
    this.#sessions.recordLink(ref.source, ref.sessionId, ref.parentThreadId, ref.forkedFromId, rootThreadId);
    const existing = this.#sessions.upsertSession({
      ref: {
        source: ref.source,
        sessionId: ref.sessionId,
        threadSource: ref.threadSource,
        cwd: ref.cwd,
        path: ref.path,
        archived: ref.archived,
      },
      rootThreadId,
      sizeOrOffset: ref.sizeBytes,
    });

    const session = await adapter.read(ref);

    // A session that is still being written is deferred, never half-digested.
    if (!options.force) {
      const stillWriting = Date.now() - ref.mtimeMs < this.#config.activeSessionQuietSeconds * 1000;
      if (stillWriting && (!session.complete || session.truncatedTail)) {
        this.#sessions.updateSessionState(ref.source, ref.sessionId, {
          status: 'deferred',
          deferReason: 'source file is still being written',
          contentHash: session.sourceHash,
        });
        return this.#result(session, rootThreadId, 'deferred', {
          reason: 'Session file changed recently and still looks incomplete; it will be retried later.',
        });
      }
    }

    const knownEvents = this.#sessions.knownEventIds(ref.source, ref.sessionId);
    const newEventIds = session.eventIds.filter((eventId) => !knownEvents.has(eventId));
    if (existing.contentHash === session.sourceHash && newEventIds.length === 0) {
      this.#sessions.updateSessionState(ref.source, ref.sessionId, { status: 'unchanged' });
      return this.#result(session, rootThreadId, 'unchanged', { reason: 'Session content hash is unchanged.' });
    }

    const sanitized = sanitizeSession(session, this.#redactor);
    this.#sessions.updateSessionState(ref.source, ref.sessionId, {
      contentHash: session.sourceHash,
      adapterSchemaVersion: session.schemaVersion,
      lastEventId: session.eventIds[session.eventIds.length - 1] ?? null,
      processedOffset: session.byteLength,
    });

    const caseRecord = this.#sessions.upsertCase({
      caseId: this.#sessions.getCaseByRootThread(ref.source, rootThreadId)?.caseId ?? newCaseId(),
      source: ref.source,
      rootThreadId,
      primarySessionId: session.meta.sessionId,
      title: session.meta.title ?? (session.meta.cwd ? basename(session.meta.cwd) : null),
    });
    this.#sessions.updateSessionState(ref.source, ref.sessionId, { caseId: caseRecord.caseId });

    // Evidence comes only from redacted text and only from newly seen events.
    const freshEventIds = new Set(newEventIds);
    const allEvidence = extractEvidence({
      session: sanitized.session,
      caseId: caseRecord.caseId,
      evidenceIdFor: (sessionId, eventId, kind) => deriveId('ev', ref.source, sessionId, eventId, kind),
    });
    const freshEvidence = allEvidence.filter((item) => freshEventIds.has(item.eventId));

    const recorded = this.#sessions.recordEvents(
      ref.source,
      ref.sessionId,
      session.eventIds.map((eventId) => ({
        eventId,
        eventHash: deriveId('h', ref.source, ref.sessionId, eventId),
        ordinal: null,
        eventType: null,
      })),
    );

    if (freshEvidence.length === 0) {
      this.#sessions.markEventsIncorporated(ref.source, ref.sessionId, newEventIds);
      this.#sessions.updateSessionState(ref.source, ref.sessionId, {
        status: 'ingested',
        lastIngestedAt: nowIso(),
        pendingEvents: 0,
      });
      return this.#result(session, rootThreadId, 'unchanged', {
        reason:
          recorded.inserted === 0
            ? 'All events were already ingested.'
            : 'No new user statement or verified tool result worth remembering.',
        caseId: caseRecord.caseId,
        redactionRules: ruleNames(sanitized.findings),
      });
    }

    this.#sessions.addEvidence(freshEvidence.map((item) => this.#toStoredEvidence(item, caseRecord, session)));
    this.#sessions.refreshCaseStats(caseRecord.caseId);

    // 1. Extract bounded observations from the sanitized session.
    const extracted = await this.#runtime.extract({
      session: sanitized.session,
      evidence: freshEvidence,
      caseTitle: caseRecord.title,
    });

    // 2. Consolidate against the current view (active and candidate).
    const related = this.#relatedMemories(extracted.observations);
    const consolidated = await this.#runtime.consolidate({
      observations: extracted.observations,
      related,
      caseId: caseRecord.caseId,
      caseFeatures: extracted.case_features,
    });

    // 3. Deterministic gates decide what is written.
    const snapshot = await this.#repository.snapshot();
    const evidenceById = new Map(allEvidence.map((item) => [item.evidenceId, item]));
    const plan = this.#planWrites({
      observations: extracted.observations,
      operations: consolidated.operations,
      related,
      snapshot,
      caseRecord,
      session: sanitized.session,
      evidenceById,
    });

    const redactionRules = ruleNames(sanitized.findings);

    if (plan.upserts.length === 0 && plan.reviews.length === 0 && plan.evidenceFiles.length === 0) {
      this.#sessions.markEventsIncorporated(ref.source, ref.sessionId, newEventIds);
      this.#sessions.updateSessionState(ref.source, ref.sessionId, {
        status: 'ingested',
        lastIngestedAt: nowIso(),
        pendingEvents: 0,
      });
      return this.#result(session, rootThreadId, 'unchanged', {
        reason: 'Consolidation produced no memory changes.',
        caseId: caseRecord.caseId,
        redactionRules,
      });
    }

    if (extracted.case_features.length > 0) {
      this.#sessions.setCaseTaskFeatures(caseRecord.caseId, extracted.case_features);
    }

    // 4. One commit: memories, evidence, reviews, audit and the regenerated summary.
    const commitSha = await this.#commitPlan(job, sanitized.session, plan, caseRecord);

    // 5. The SQLite projection is rebuilt from the new HEAD.
    await projectFromGit({ repository: this.#repository, projection: this.#projection });

    this.#sessions.markEventsIncorporated(ref.source, ref.sessionId, newEventIds);
    this.#sessions.refreshCaseStats(caseRecord.caseId);
    this.#sessions.updateSessionState(ref.source, ref.sessionId, {
      status: 'ingested',
      lastIngestedAt: nowIso(),
      pendingEvents: 0,
      caseId: caseRecord.caseId,
    });
    this.#jobs.setCommitSha(job.jobId, commitSha);

    return this.#result(session, rootThreadId, 'ingested', {
      reason: `Wrote ${plan.upserts.length} memory file(s).`,
      caseId: caseRecord.caseId,
      commitSha,
      memoryIds: plan.writtenMemoryIds,
      reviewIds: plan.reviews.map((review) => review.reviewId),
      observations: extracted.observations.length,
      skippedEvents: session.skippedEvents,
      redactionRules,
    });
  }

  /** Locates a session reference by id or path, for the manual `ingest run` flow. */
  async findRef(sessionIdOrPath: string): Promise<SessionRef | null> {
    for (const adapter of this.#adapters.list()) {
      for await (const ref of adapter.discover()) {
        if (ref.sessionId === sessionIdOrPath || ref.path === sessionIdOrPath) return ref;
      }
    }
    return null;
  }

  // --- internals -------------------------------------------------------------

  #toStoredEvidence(evidence: EvidenceCandidate, caseRecord: CaseRecord, session: NormalizedSession): NewEvidence {
    return {
      evidenceId: evidence.evidenceId,
      caseId: caseRecord.caseId,
      source: 'codex',
      sessionId: session.meta.sessionId,
      rootThreadId: caseRecord.rootThreadId,
      kind: evidence.kind,
      authority: evidence.authority,
      toolName: evidence.toolName,
      verified: evidence.verified,
      eventId: evidence.eventId,
      ordinal: null,
      snippet: evidence.snippet,
      sourceHash: session.sourceHash,
      createdAt: nowIso(),
    };
  }

  #relatedMemories(observations: Observation[]): RelatedMemory[] {
    const query = observations.map((observation) => `${observation.title} ${observation.keywords.join(' ')}`).join(' ');
    if (query.trim() === '') return [];
    return this.#projection.search(query, { limit: 24, includeNonActive: true }).map(toRelatedMemory);
  }

  #planWrites(input: {
    observations: Observation[];
    operations: ConsolidationOperation[];
    related: RelatedMemory[];
    snapshot: MemorySnapshot;
    caseRecord: CaseRecord;
    session: NormalizedSession;
    evidenceById: Map<string, EvidenceCandidate>;
  }): RecordPlan {
    const plan: RecordPlan = { upserts: [], reviews: [], evidenceFiles: [], writtenMemoryIds: [], observations: 0 };
    const now = nowIso();
    const planned = new Map<string, MemoryRecord>();
    const citedEvidence = new Set<string>();
    const evidenceByEventId = new Map<string, EvidenceCandidate>();
    for (const candidate of input.evidenceById.values()) evidenceByEventId.set(candidate.eventId, candidate);

    const resolve = (memoryId: string | null): MemoryRecord | null =>
      memoryId === null ? null : (planned.get(memoryId) ?? input.snapshot.byId.get(memoryId) ?? null);

    for (const operation of input.operations) {
      const observation = input.observations[operation.observation_index];
      if (!observation) continue;
      plan.observations += 1;

      const cited = observation.evidence_event_ids
        .map((eventId) => evidenceByEventId.get(eventId))
        .filter((item): item is EvidenceCandidate => item !== undefined);
      for (const item of cited) citedEvidence.add(item.evidenceId);

      // "Duplicate of something that is no longer current" is not a no-op: the live
      // view does not contain this statement, so it is evaluated as new information.
      const duplicateTarget = resolve(operation.target_memory_id);
      const operationName =
        (operation.operation === 'duplicate' || operation.operation === 'noop') &&
        duplicateTarget?.frontmatter.status !== 'active'
          ? 'add'
          : operation.operation;

      const target = operationName === operation.operation ? duplicateTarget : null;
      const supportingCases = new Set<string>(target?.frontmatter.supporting_case_ids ?? []);
      supportingCases.add(input.caseRecord.caseId);

      const gate = applyPromotionGate({
        kind: observation.type,
        declaredAuthority: observation.authority,
        confidence: observation.confidence,
        sensitivity: observation.sensitivity,
        citedEvidence: cited.map((item) => ({ kind: item.kind, verified: item.verified, snippet: item.snippet })),
        claimText: observation.body,
        distinctSupportingCaseIds: [...supportingCases],
        contradictingCaseIds: target?.frontmatter.contradicting_case_ids ?? [],
        hasUnresolvedConflict: operationName === 'conflict' || this.#hasOpenConflict(target?.frontmatter.id ?? null),
        userExplicitlyRequested: isExplicitRememberRequest(cited),
      });

      // Deterministic contradiction guard.
      //
      // A model may propose `add`, `duplicate` or `noop` for a statement that
      // actually negates an existing memory — "we do not use Docker" looks almost
      // identical to "we use Docker". Textual similarity must never be able to
      // overwrite the current view, so the polarity check runs here, independent of
      // what the model said. Temporal changes and supersedes are excluded: those are
      // the legitimate ways a polarity change is recorded.
      if (
        operationName === 'add' ||
        operationName === 'duplicate' ||
        operationName === 'reinforce' ||
        operationName === 'noop'
      ) {
        const contradiction = this.#detectContradiction(observation, input.related, input.snapshot);
        if (contradiction) {
          const candidate = this.#buildRecord({
            observation,
            gate,
            status: 'candidate',
            target: null,
            id: candidateIdFor(observation),
            operation: { ...operation, operation: 'conflict' },
            caseRecord: input.caseRecord,
            session: input.session,
            cited,
            now,
          });
          plan.upserts.push({ record: candidate });
          planned.set(candidate.frontmatter.id, candidate);
          plan.writtenMemoryIds.push(candidate.frontmatter.id);
          plan.reviews.push({
            reviewId: newReviewId(),
            type: 'conflict',
            memoryIds: [candidate.frontmatter.id, contradiction.target.frontmatter.id],
            proposal: {
              kind: 'candidate_promotion',
              candidateMemoryId: candidate.frontmatter.id,
              targetMemoryId: contradiction.target.frontmatter.id,
              operation: 'conflict',
              observation,
              reason: `Deterministic polarity check: ${contradiction.reason}`,
              modelOperation: operation.operation,
              modelReason: operation.reason,
              gate: gate.reasons,
              caseId: input.caseRecord.caseId,
            },
            dedupeKey: `conflict:${contradiction.target.frontmatter.id}:${slugify(observation.title, 40)}:${input.caseRecord.caseId}`,
          });
          continue;
        }
      }

      // A duplicate whose target is still live is not worthless: the same statement
      // recurring in a *new* case is exactly what independent-case counting needs, so
      // it strengthens the existing memory instead of being dropped.
      if (operationName === 'duplicate' && target && gate.outcome === 'active') {
        const strengthened = this.#buildRecord({
          observation,
          gate,
          status: target.frontmatter.status === 'active' ? 'active' : 'candidate',
          target,
          operation: {
            ...operation,
            operation: 'reinforce',
            merged_title: target.frontmatter.title,
            merged_body: target.body,
          },
          caseRecord: input.caseRecord,
          session: input.session,
          cited,
          now,
        });
        plan.upserts.push({ record: strengthened });
        planned.set(strengthened.frontmatter.id, strengthened);
        plan.writtenMemoryIds.push(strengthened.frontmatter.id);
        continue;
      }

      if (operationName === 'noop' || (operationName === 'duplicate' && gate.outcome === 'reject')) continue;

      // Changing an existing profile/strategy without first-party evidence waits for a human.
      if (
        CHANGE_OPERATIONS.has(operation.operation) &&
        target !== null &&
        operation.operation !== 'reinforce' &&
        gate.effectiveAuthority === 'inferred'
      ) {
        plan.reviews.push({
          reviewId: newReviewId(),
          type: 'conflict',
          memoryIds: [target.frontmatter.id],
          proposal: {
            kind: 'temporal_or_conflict',
            operation: operation.operation,
            targetMemoryId: target.frontmatter.id,
            observation,
            reason: operation.reason,
            gate: gate.reasons,
            caseId: input.caseRecord.caseId,
          },
          dedupeKey: `conflict:${target.frontmatter.id}:${slugify(observation.title, 40)}:${input.caseRecord.caseId}`,
        });
        continue;
      }

      if (gate.outcome === 'reject') continue;

      if (gate.outcome === 'review') {
        // A review candidate is always a *separate* record: the observation has not
        // been accepted yet, so it must not take over the target's identity (which
        // would silently move an active memory into the candidate area).
        const candidate = this.#buildRecord({
          observation,
          gate,
          status: 'candidate',
          target: null,
          id: candidateIdFor(observation),
          operation,
          caseRecord: input.caseRecord,
          session: input.session,
          cited,
          now,
        });
        plan.upserts.push({ record: candidate });
        planned.set(candidate.frontmatter.id, candidate);
        plan.writtenMemoryIds.push(candidate.frontmatter.id);
        plan.reviews.push({
          reviewId: newReviewId(),
          type: gate.reviewKind === 'conflict' ? 'conflict' : 'promotion',
          memoryIds: [candidate.frontmatter.id, ...(target ? [target.frontmatter.id] : [])],
          proposal: {
            kind: 'candidate_promotion',
            candidateMemoryId: candidate.frontmatter.id,
            targetMemoryId: target?.frontmatter.id ?? null,
            operation: operation.operation,
            observation,
            reason: operation.reason,
            gate: gate.reasons,
            caseId: input.caseRecord.caseId,
          },
          dedupeKey: `promotion:${candidate.frontmatter.id}:${input.caseRecord.caseId}`,
        });
        continue;
      }

      if (gate.outcome === 'candidate') {
        const candidate = this.#buildRecord({
          observation,
          gate,
          status: 'candidate',
          target: null,
          id: candidateIdFor(observation),
          operation,
          caseRecord: input.caseRecord,
          session: input.session,
          cited,
          now,
        });
        plan.upserts.push({ record: candidate });
        planned.set(candidate.frontmatter.id, candidate);
        plan.writtenMemoryIds.push(candidate.frontmatter.id);
        continue;
      }

      // outcome === 'active'
      if (target && (operation.operation === 'temporal_change' || operation.operation === 'supersede')) {
        const closed: MemoryRecord = {
          ...target,
          frontmatter: { ...target.frontmatter, status: 'superseded', valid_to: now, updated_at: now },
        };
        const replacement = this.#buildRecord({
          observation,
          gate,
          status: 'active',
          target: null,
          operation,
          caseRecord: input.caseRecord,
          session: input.session,
          cited,
          now,
          supersedes: [closed.frontmatter.id],
        });
        closed.frontmatter.superseded_by = replacement.frontmatter.id;
        plan.upserts.push({ record: closed }, { record: replacement });
        planned.set(closed.frontmatter.id, closed);
        planned.set(replacement.frontmatter.id, replacement);
        plan.writtenMemoryIds.push(replacement.frontmatter.id);
        continue;
      }

      const record = this.#buildRecord({
        observation,
        gate,
        status: 'active',
        target: operation.operation === 'reinforce' ? target : null,
        operation,
        caseRecord: input.caseRecord,
        session: input.session,
        cited,
        now,
      });
      plan.upserts.push({ record });
      planned.set(record.frontmatter.id, record);
      plan.writtenMemoryIds.push(record.frontmatter.id);
    }

    // Evidence files are written only where they actually support a memory.
    for (const evidenceId of citedEvidence) {
      const candidate = input.evidenceById.get(evidenceId);
      if (!candidate) continue;
      const frontmatter: EvidenceFrontmatter = {
        evidence_id: candidate.evidenceId,
        case_id: input.caseRecord.caseId,
        schema_version: SCHEMA_VERSION,
        kind: candidate.kind,
        authority: candidate.authority,
        ...(candidate.toolName ? { tool_name: candidate.toolName } : {}),
        verified: candidate.verified,
        session_id: input.session.meta.sessionId,
        root_thread_id: input.caseRecord.rootThreadId,
        ...(candidate.eventId ? { event_id: candidate.eventId } : {}),
        source: 'codex',
        source_hash: input.session.sourceHash,
        created_at: now,
        sensitivity: 'public',
      };
      plan.evidenceFiles.push({
        path: evidencePath(input.caseRecord.caseId, candidate.evidenceId),
        content: serializeEvidence(frontmatter, candidate.snippet),
      });
    }

    // Drop writes that would not change the file on disk.
    const deduped = new Map<string, { record: MemoryRecord }>();
    for (const upsert of plan.upserts) {
      const previous = input.snapshot.byId.get(upsert.record.frontmatter.id);
      if (previous && serializeRecord(previous) === serializeRecord(upsert.record)) continue;
      deduped.set(upsert.record.frontmatter.id, upsert);
    }
    plan.upserts = [...deduped.values()];
    plan.writtenMemoryIds = [...new Set(plan.upserts.map((upsert) => upsert.record.frontmatter.id))];
    return plan;
  }

  #buildRecord(input: {
    observation: Observation;
    gate: GateDecision;
    status: 'active' | 'candidate';
    target: MemoryRecord | null;
    /** Explicit identity, used for review candidates so re-ingesting is idempotent. */
    id?: string;
    operation: ConsolidationOperation;
    caseRecord: CaseRecord;
    session: NormalizedSession;
    cited: EvidenceCandidate[];
    now: string;
    supersedes?: string[];
  }): MemoryRecord {
    const { observation, gate, target, now } = input;
    const kind = observation.type;
    const id = input.id ?? target?.frontmatter.id ?? newMemoryId(kind);
    const isReinforce = input.operation.operation === 'reinforce';

    const body = isReinforce
      ? (input.operation.merged_body ?? `${target?.body ?? ''}\n\n${observation.body}`).trim()
      : observation.body;
    const title = isReinforce ? (input.operation.merged_title ?? target?.frontmatter.title ?? observation.title) : observation.title;

    const supporting = new Set<string>(target?.frontmatter.supporting_case_ids ?? []);
    const contradicting = new Set<string>(target?.frontmatter.contradicting_case_ids ?? []);
    if (input.operation.operation === 'conflict') contradicting.add(input.caseRecord.caseId);
    else supporting.add(input.caseRecord.caseId);

    const authority: Authority = gate.effectiveAuthority;
    const confidence: Confidence = observation.confidence;
    const sensitivity: Sensitivity = observation.sensitivity;

    const frontmatter: MemoryFrontmatter = {
      id,
      kind,
      status: input.status,
      schema_version: SCHEMA_VERSION,
      title: title.slice(0, 160),
      tags: [...new Set([...(target?.frontmatter.tags ?? []), ...observation.tags])].slice(0, 16),
      created_at: target?.frontmatter.created_at ?? now,
      updated_at: now,
      valid_from: input.supersedes && input.supersedes.length > 0 ? now : (target?.frontmatter.valid_from ?? now),
      authority,
      confidence,
      confidence_reason: observation.confidence_reason.slice(0, 400),
      supporting_case_ids: [...supporting].slice(0, PROMOTION_RULES.maxSupportingCases),
      contradicting_case_ids: [...contradicting].slice(0, PROMOTION_RULES.maxSupportingCases),
      provenance: {
        source: 'codex',
        adapter: input.session.adapter,
        session_id: input.session.meta.sessionId,
        root_thread_id: input.caseRecord.rootThreadId,
        source_path: input.session.meta.path,
        content_hash: input.session.sourceHash,
        event_ids: input.cited.map((item) => item.eventId).slice(0, 32),
        case_id: input.caseRecord.caseId,
        captured_at: now,
      },
      supersedes: input.supersedes ?? target?.frontmatter.supersedes ?? [],
      sensitivity,
      review_flags: [],
      keywords: [...new Set([...(target?.frontmatter.keywords ?? []), ...observation.keywords])].slice(0, 32),
    };
    return { frontmatter, body, path: '' };
  }

  #hasOpenConflict(memoryId: string | null): boolean {
    if (!memoryId) return false;
    return this.#reviews
      .list({ statuses: ['pending', 'preview'], type: 'conflict', limit: 50 })
      .some((review) => review.memoryIds.includes(memoryId));
  }

  /** Finds an active memory whose polarity a new observation contradicts. */
  #detectContradiction(
    observation: Observation,
    related: RelatedMemory[],
    snapshot: MemorySnapshot,
  ): { target: MemoryRecord; reason: string } | null {
    const observationText = `${observation.title} ${observation.body}`;
    const candidates = related
      .map((memory) => {
        const record = snapshot.byId.get(memory.memoryId);
        if (!record || record.frontmatter.status !== 'active') return null;
        const score = lexicalOverlap(observationText, `${memory.title} ${memory.snippet} ${memory.tags.join(' ')}`);
        return { record, score };
      })
      .filter((entry): entry is { record: MemoryRecord; score: number } => entry !== null)
      .sort((a, b) => b.score - a.score);

    for (const candidate of candidates) {
      const check = looksContradictory(
        observationText,
        `${candidate.record.frontmatter.title} ${candidate.record.body}`,
        candidate.score,
      );
      if (check.contradictory) return { target: candidate.record, reason: check.reason };
    }
    return null;
  }

  async #commitPlan(
    job: JobRecord,
    session: SanitizedSession,
    plan: RecordPlan,
    caseRecord: CaseRecord,
  ): Promise<string> {
    const head = await this.#store.head();
    const snapshot = await this.#repository.snapshot(head);
    const { changes, records } = this.#repository.planRecordWrites({ snapshot, upserts: plan.upserts });

    const allChanges = new Map(changes.map((change) => [change.path, change]));
    for (const file of plan.evidenceFiles) allChanges.set(file.path, { path: file.path, content: file.content });
    for (const review of plan.reviews) {
      const path = reviewPath(review.reviewId);
      allChanges.set(path, { path, content: serializeReviewFile(review, caseRecord, session) });
    }

    const generatedAt = nowIso();
    const summary = buildSummary({ records, evidence: snapshot.evidence, generatedAt, head });
    for (const file of summary.files) allChanges.set(file.path, { path: file.path, content: file.content });

    const day = dayKey(new Date(), this.#config.schedule.timeZone);
    const audit = auditPath(day, job.jobId);
    allChanges.set(audit, { path: audit, content: serializeAuditFile({ job, session, plan, caseRecord }) });

    const subject = commitSubject(session, plan);
    const result = await this.#withCommitLock(() => this.#store.commit([...allChanges.values()], {
      expectedHead: head,
      subject,
      body: [
        `Job: ${job.jobId}`,
        `Session: ${session.meta.sessionId} (root thread ${caseRecord.rootThreadId})`,
        `Memories written: ${plan.writtenMemoryIds.length}`,
        `Reviews opened: ${plan.reviews.length}`,
      ].join('\n'),
      trailers: {
        jobId: job.jobId,
        sessionId: session.meta.sessionId,
        sourceHash: session.sourceHash,
        kind: 'ingestion',
      },
    }));

    this.#commits.record({
      commitSha: result.commitSha,
      jobId: job.jobId,
      sessionId: session.meta.sessionId,
      sourceHash: session.sourceHash,
      kind: 'ingestion',
      subject,
      filesChanged: result.files.length,
    });
    for (const review of plan.reviews) {
      this.#reviews.create({
        type: review.type,
        status: 'pending',
        baseHead: result.commitSha,
        memoryIds: review.memoryIds,
        proposal: { ...review.proposal, reviewId: review.reviewId, path: reviewPath(review.reviewId) },
        expiresAt: null,
        dedupeKey: review.dedupeKey,
        jobId: job.jobId,
      });
    }
    return result.commitSha;
  }

  #result(
    session: NormalizedSession,
    rootThreadId: string,
    status: SessionIngestResult['status'],
    extra: {
      reason: string;
      caseId?: string | null;
      commitSha?: string | null;
      memoryIds?: string[];
      reviewIds?: string[];
      observations?: number;
      skippedEvents?: { type: string; count: number }[];
      redactionRules?: string[];
    },
  ): SessionIngestResult {
    return {
      status,
      source: 'codex',
      sessionId: session.meta.sessionId,
      rootThreadId,
      caseId: extra.caseId ?? null,
      commitSha: extra.commitSha ?? null,
      memoryIds: extra.memoryIds ?? [],
      reviewIds: extra.reviewIds ?? [],
      observations: extra.observations ?? 0,
      reason: extra.reason,
      skippedEvents: extra.skippedEvents ?? session.skippedEvents,
      redactionRules: extra.redactionRules ?? [],
    };
  }
}

/**
 * Review candidates get a content-derived id: the same observation always maps to
 * the same candidate, so a repeated run rewrites the same file and reuses the same
 * review instead of piling up duplicates.
 */
export function candidateIdFor(observation: Observation): string {
  return deriveId('cnd', observation.type, observation.title.trim());
}

function ruleNames(findings: RedactionFinding[]): string[] {
  return findings.map((finding) => finding.rule);
}

function isExplicitRememberRequest(cited: EvidenceCandidate[]): boolean {
  return cited.some(
    (evidence) =>
      evidence.kind === 'user_message' &&
      /(?:请)?(?:记住|记一下|记下|保存(?:一下)?)|remember (?:this|that)/i.test(evidence.snippet),
  );
}

export function commitSubject(session: NormalizedSession, plan: Pick<RecordPlan, 'writtenMemoryIds' | 'reviews'>): string {
  const short = session.meta.sessionId.slice(0, 8);
  if (plan.reviews.length > 0 && plan.writtenMemoryIds.length > 0) {
    return `Digest session ${short}: ${plan.writtenMemoryIds.length} memory change(s), ${plan.reviews.length} review(s)`;
  }
  if (plan.reviews.length > 0) return `Digest session ${short}: ${plan.reviews.length} review(s)`;
  return `Digest session ${short}: ${plan.writtenMemoryIds.length} memory change(s)`;
}

export function serializeReviewFile(
  review: RecordPlan['reviews'][number],
  caseRecord: CaseRecord,
  session: NormalizedSession,
): string {
  return [
    '---',
    `review_id: ${review.reviewId}`,
    `type: ${review.type}`,
    'status: pending',
    `case_id: ${caseRecord.caseId}`,
    `session_id: ${session.meta.sessionId}`,
    `created_at: ${nowIso()}`,
    `dedupe_key: ${review.dedupeKey}`,
    '---',
    '',
    `# Review: ${review.type}`,
    '',
    'Inspect it with `aquarius review show <review-id>` and decide with `aquarius review resolve`.',
    'Until a decision is recorded, the affected memories are not used as current fact.',
    '',
    '```json',
    JSON.stringify(review.proposal, null, 2),
    '```',
    '',
  ].join('\n');
}

export function serializeAuditFile(input: {
  job: JobRecord;
  session: SanitizedSession;
  plan: RecordPlan;
  caseRecord: CaseRecord;
}): string {
  const { job, session, plan, caseRecord } = input;
  return [
    '---',
    `job_id: ${job.jobId}`,
    `kind: ${job.kind}`,
    `trigger: ${job.trigger}`,
    `session_id: ${session.meta.sessionId}`,
    `case_id: ${caseRecord.caseId}`,
    `root_thread_id: ${caseRecord.rootThreadId}`,
    `adapter: ${session.adapter}@${session.schemaVersion}`,
    `source_hash: ${session.sourceHash}`,
    `recorded_at: ${nowIso()}`,
    '---',
    '',
    `# Ingestion audit ${job.jobId}`,
    '',
    `- Memories written: ${plan.writtenMemoryIds.length}`,
    `- Reviews opened: ${plan.reviews.length}`,
    `- Events in source: ${session.eventIds.length}`,
    `- Skipped event types: ${
      session.skippedEvents.map((entry) => `${entry.type}×${entry.count}`).join(', ') || 'none'
    }`,
    `- Redaction rules triggered: ${
      session.redactionFindings.map((entry) => `${entry.rule}×${entry.count}`).join(', ') || 'none'
    }`,
    '',
    'No raw session content, model output or credential material is recorded here by design.',
    '',
  ].join('\n');
}

export function memoryFilesTouched(plan: RecordPlan): string[] {
  return plan.upserts.map((upsert) => memoryPath(upsert.record.frontmatter));
}
