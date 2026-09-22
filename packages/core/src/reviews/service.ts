import type { AquariusConfig } from '../config.ts';
import { AquariusError } from '../errors.ts';
import type { MemoryStore, FileChange } from '../git/memoryStore.ts';
import type { MemoryRepository } from '../memory/repository.ts';
import { serializeRecord } from '../memory/repository.ts';
import { memoryPath } from '../memory/paths.ts';
import { tryParseMemory } from '../memory/frontmatter.ts';
import type { MemoryRecord } from '../memory/schema.ts';
import type { ReviewStore, ReviewRecord } from '../db/reviewStore.ts';
import type { ProjectionStore } from '../db/projectionStore.ts';
import type { CommitStore } from '../db/commitStore.ts';
import { projectFromGit } from '../query/retrieval.ts';
import { nowIso } from '../util/time.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('reviews');

export type ReviewDecision = 'adopt' | 'merge' | 'reject' | 'temporal_change' | 'forget';

export interface ReviewView {
  reviewId: string;
  type: string;
  status: string;
  createdAt: string;
  expiresAt: string | null;
  memoryIds: string[];
  baseHead: string | null;
  candidate: MemoryRecord | null;
  target: MemoryRecord | null;
  supportingEvidence: { evidenceId: string; kind: string; snippet: string }[];
  contradictingEvidence: { evidenceId: string; kind: string; snippet: string }[];
  confidenceReason: string | null;
  proposedOperations: string[];
  gateReasons: string[];
  notes: string[];
}

export interface ReviewResolution {
  reviewId: string;
  decision: ReviewDecision;
  commitSha: string | null;
  diff: string;
  diffStat: string;
  memoryIds: string[];
  dryRun: boolean;
}

/**
 * Review queue (PLAN §6 / §8).
 *
 * Conflicts, low-confidence and sensitive candidates wait here, and none of them
 * is treated as current fact while a decision is open. Every decision shows the
 * final diff first, then applies it with the HEAD guard, then records the
 * approval — and a review can only ever be applied once.
 */
export class ReviewService {
  #config: AquariusConfig;
  #store: MemoryStore;
  #repository: MemoryRepository;
  #reviews: ReviewStore;
  #projection: ProjectionStore;
  #commits: CommitStore;

  constructor(deps: {
    config: AquariusConfig;
    store: MemoryStore;
    repository: MemoryRepository;
    reviews: ReviewStore;
    projection: ProjectionStore;
    commits: CommitStore;
  }) {
    this.#config = deps.config;
    this.#store = deps.store;
    this.#repository = deps.repository;
    this.#reviews = deps.reviews;
    this.#projection = deps.projection;
    this.#commits = deps.commits;
  }

  list(options: { status?: string; type?: string; limit?: number } = {}): ReviewRecord[] {
    return this.#reviews.list({
      ...(options.status ? { status: options.status as ReviewRecord['status'] } : { statuses: ['pending', 'preview'] }),
      ...(options.type ? { type: options.type as ReviewRecord['type'] } : {}),
      limit: options.limit ?? 50,
    });
  }

  async view(reviewId: string): Promise<ReviewView> {
    const review = this.#reviews.get(reviewId);
    if (!review) throw new AquariusError('not_found', `Unknown review ${reviewId}`);
    const snapshot = await this.#repository.snapshot();
    const proposal = review.proposal;
    const candidateId = typeof proposal['candidateMemoryId'] === 'string' ? proposal['candidateMemoryId'] : null;
    const targetId =
      typeof proposal['targetMemoryId'] === 'string'
        ? proposal['targetMemoryId']
        : (review.memoryIds[0] ?? null);
    const candidate = candidateId ? (snapshot.byId.get(candidateId) ?? null) : null;
    const target = targetId ? (snapshot.byId.get(targetId) ?? null) : null;

    const caseIds = target?.frontmatter.supporting_case_ids ?? candidate?.frontmatter.supporting_case_ids ?? [];
    const supportingEvidence = caseIds
      .flatMap((caseId) => snapshot.evidenceByCase.get(caseId) ?? [])
      .slice(0, 8)
      .map((file) => ({
        evidenceId: file.frontmatter.evidence_id,
        kind: file.frontmatter.kind,
        snippet: file.body.slice(0, 300),
      }));
    const contradictingCaseIds = target?.frontmatter.contradicting_case_ids ?? [];
    const contradictingEvidence = contradictingCaseIds
      .flatMap((caseId) => snapshot.evidenceByCase.get(caseId) ?? [])
      .slice(0, 8)
      .map((file) => ({
        evidenceId: file.frontmatter.evidence_id,
        kind: file.frontmatter.kind,
        snippet: file.body.slice(0, 300),
      }));

    const gate = Array.isArray(proposal['gate']) ? (proposal['gate'] as string[]) : [];
    return {
      reviewId: review.reviewId,
      type: review.type,
      status: review.status,
      createdAt: review.createdAt,
      expiresAt: review.expiresAt,
      memoryIds: review.memoryIds,
      baseHead: review.baseHead,
      candidate,
      target,
      supportingEvidence,
      contradictingEvidence,
      confidenceReason: target?.frontmatter.confidence_reason ?? candidate?.frontmatter.confidence_reason ?? null,
      proposedOperations: typeof proposal['operation'] === 'string' ? [proposal['operation']] : [],
      gateReasons: gate,
      notes:
        review.type === 'skill_approval' || review.type === 'skill_anomaly'
          ? ['Skill publication requires explicit approval; see `aquarius skill show`.']
          : [],
    };
  }

  /** Builds the writes for a decision. Pure: nothing is committed here. */
  #planDecision(input: {
    review: ReviewRecord;
    decision: ReviewDecision;
    note?: string;
    mergedBody?: string | null;
    mergedTitle?: string | null;
    snapshotHead: string | null;
  }): { writes: FileChange[]; memoryIds: string[] } {
    const { review, decision } = input;
    const proposal = review.proposal;
    const candidateId = typeof proposal['candidateMemoryId'] === 'string' ? proposal['candidateMemoryId'] : null;
    const targetId = typeof proposal['targetMemoryId'] === 'string' ? proposal['targetMemoryId'] : null;
    const writes: FileChange[] = [];
    const memoryIds: string[] = [];

    const addRecord = (record: MemoryRecord, previousPath?: string | null): void => {
      const targetPath = memoryPath(record.frontmatter, this.#config.schedule.timeZone);
      if (previousPath && previousPath !== targetPath) writes.push({ path: previousPath, content: null });
      writes.push({ path: targetPath, content: serializeRecord(record) });
      memoryIds.push(record.frontmatter.id);
    };

    const snapshotRecords = this.#snapshotCache;
    const candidate = candidateId ? (snapshotRecords.get(candidateId) ?? null) : null;
    const target = targetId
      ? (snapshotRecords.get(targetId) ?? null)
      : candidateId === null && review.memoryIds[0]
        ? (snapshotRecords.get(review.memoryIds[0]!) ?? null)
        : null;

    if (review.type === 'skill_approval' || review.type === 'skill_anomaly') {
      throw new AquariusError('validation_failed', 'Skill reviews are resolved with the skill commands, not `review resolve`.');
    }

    switch (decision) {
      case 'adopt': {
        const chosen = candidate ?? target;
        if (!chosen) throw new AquariusError('not_found', 'The reviewed memory no longer exists at HEAD.');
        const promoted: MemoryRecord = {
          ...chosen,
          frontmatter: {
            ...chosen.frontmatter,
            status: 'active',
            updated_at: nowIso(),
            review_flags: [],
            // The user reviewed the evidence and decided; that decision is the authority.
            authority: 'user_explicit',
            confidence: 'high',
            confidence_reason:
              input.note ??
              (target && candidate
                ? 'Adopted by explicit user review after conflicting evidence.'
                : 'Promoted by explicit user review.'),
            // The case that argued for this version now counts as support for it.
            ...supportAfterDecision(chosen),
          },
        };
        addRecord(promoted, chosen.path);
        if (candidate && target && candidate.frontmatter.id !== target.frontmatter.id) {
          const closed = closeRecord(target, nowIso(), promoted.frontmatter.id);
          addRecord(closed, target.path);
        }
        break;
      }
      case 'merge': {
        const base = target ?? candidate;
        if (!base) throw new AquariusError('not_found', 'Nothing to merge at HEAD.');
        const mergedCases = new Set([
          ...(target?.frontmatter.supporting_case_ids ?? []),
          ...(target?.frontmatter.contradicting_case_ids ?? []),
          ...(candidate?.frontmatter.supporting_case_ids ?? []),
          ...(candidate?.frontmatter.contradicting_case_ids ?? []),
        ]);
        const merged: MemoryRecord = {
          ...base,
          body: input.mergedBody ?? `${target?.body ?? ''}\n\n${candidate?.body ?? ''}`.trim(),
          frontmatter: {
            ...base.frontmatter,
            title: (input.mergedTitle ?? base.frontmatter.title).slice(0, 160),
            status: 'active',
            updated_at: nowIso(),
            authority: 'user_explicit',
            confidence: 'high',
            confidence_reason: input.note ?? 'Merged by explicit user review.',
            review_flags: [],
            supporting_case_ids: [...mergedCases].slice(0, 50),
            // A merge resolves the conflict, so nothing contradicts it any more.
            contradicting_case_ids: [],
          },
        };
        addRecord(merged, base.path);
        if (candidate && target && candidate.frontmatter.id !== target.frontmatter.id) {
          addRecord(closeRecord(candidate, nowIso(), merged.frontmatter.id), candidate.path);
        }
        break;
      }
      case 'temporal_change': {
        // The newer statement becomes the current version; the older one keeps its
        // validity window and is closed. This is a change over time, not an error.
        const current = candidate ?? target;
        if (!current) throw new AquariusError('not_found', 'Nothing to re-interpret at HEAD.');
        const previous = target && candidate && candidate.frontmatter.id !== target.frontmatter.id ? target : null;
        const promoted: MemoryRecord = {
          ...current,
          body: input.mergedBody ?? current.body,
          frontmatter: {
            ...current.frontmatter,
            status: 'active',
            updated_at: nowIso(),
            valid_from: current.frontmatter.valid_from ?? nowIso(),
            valid_to: null,
            superseded_by: null,
            authority: 'user_explicit',
            confidence: 'high',
            confidence_reason: input.note ?? 'Re-interpreted as a change over time by explicit user review.',
            review_flags: [],
            ...supportAfterDecision(current),
            supersedes: [...new Set([...current.frontmatter.supersedes, ...(previous ? [previous.frontmatter.id] : [])])],
          },
        };
        addRecord(promoted, current.path);
        if (previous) addRecord(closeRecord(previous, nowIso(), promoted.frontmatter.id), previous.path);
        break;
      }
      case 'forget': {
        const base = target ?? candidate ?? null;
        if (!base) throw new AquariusError('not_found', 'Nothing to forget at HEAD.');
        addRecord(closeRecord(base, nowIso(), null, 'forgotten'), base.path);
        if (candidate && target && candidate.frontmatter.id !== target.frontmatter.id) {
          writes.push({ path: candidate.path, content: null });
        }
        break;
      }
      case 'reject': {
        const base = candidate ?? target ?? null;
        if (base) {
          addRecord(
            {
              ...base,
              frontmatter: {
                ...base.frontmatter,
                status: 'rejected',
                updated_at: nowIso(),
                confidence_reason: input.note ?? base.frontmatter.confidence_reason,
              },
            },
            base.path,
          );
        }
        break;
      }
    }

    return { writes, memoryIds: [...new Set(memoryIds)] };
  }

  #snapshotCache = new Map<string, MemoryRecord>();

  async resolve(input: {
    reviewId: string;
    decision: ReviewDecision;
    expectedHead: string | null;
    resolvedBy?: string;
    note?: string;
    mergedBody?: string | null;
    mergedTitle?: string | null;
    dryRun?: boolean;
  }): Promise<ReviewResolution> {
    const review = this.#reviews.get(input.reviewId);
    if (!review) throw new AquariusError('not_found', `Unknown review ${input.reviewId}`);
    if (review.status === 'applied') {
      throw new AquariusError('review_already_resolved', `Review ${input.reviewId} was already applied.`, {
        details: { commitSha: review.appliedCommit },
      });
    }
    if (review.status !== 'pending' && review.status !== 'preview') {
      throw new AquariusError('review_already_resolved', `Review ${input.reviewId} is ${review.status}.`);
    }

    const currentHead = await this.#store.head();
    if (currentHead !== input.expectedHead) {
      throw new AquariusError('stale_head', 'Review decisions must be made against the HEAD they were read from.', {
        details: { currentHead, expectedHead: input.expectedHead, reviewBaseHead: review.baseHead },
        actionable: 'Reload the review and decide again.',
      });
    }

    const snapshot = await this.#repository.snapshot(currentHead);
    this.#snapshotCache = new Map(snapshot.records.map((record) => [record.frontmatter.id, record]));

    const { writes, memoryIds } = this.#planDecision({
      review,
      decision: input.decision,
      ...(input.note !== undefined ? { note: input.note } : {}),
      mergedBody: input.mergedBody ?? null,
      mergedTitle: input.mergedTitle ?? null,
      snapshotHead: currentHead,
    });
    const validated = validateWrites(writes);
    const proposal = await this.#store.propose(validated, {
      expectedHead: currentHead,
      subject: `Review ${input.decision}: ${review.reviewId}`,
      trailers: { kind: 'review-decision' },
    });

    if (input.dryRun) {
      return {
        reviewId: review.reviewId,
        decision: input.decision,
        commitSha: null,
        diff: proposal.diff,
        diffStat: proposal.diffStat,
        memoryIds,
        dryRun: true,
      };
    }

    const result = await this.#store.commit(validated, {
      expectedHead: currentHead,
      subject: `Review ${input.decision}: ${review.reviewId}`,
      body: [
        `Review: ${review.reviewId} (${review.type})`,
        `Decision: ${input.decision}`,
        input.note ? `Note: ${input.note}` : 'Note: (none)',
        `Affected memories: ${memoryIds.join(', ')}`,
        `Decided by: ${input.resolvedBy ?? 'local-user'}`,
      ].join('\n'),
      trailers: { jobId: review.jobId ?? undefined, kind: 'review-decision' },
    });

    if (input.decision === 'reject') {
      // A rejection still writes (the candidate is archived as rejected), so it goes
      // through the same single-application path as every other decision.
      const applied = this.#reviews.markApplied(review.reviewId, {
        commitSha: result.commitSha,
        resolvedBy: input.resolvedBy ?? 'local-user',
        ...(input.note !== undefined ? { note: input.note } : {}),
        decision: { decision: input.decision, memoryIds },
      });
      if (!applied) {
        throw new AquariusError('review_already_resolved', `Review ${review.reviewId} was applied concurrently.`, {
          details: { commitSha: result.commitSha },
        });
      }
    } else {
      const applied = this.#reviews.markApplied(review.reviewId, {
        commitSha: result.commitSha,
        resolvedBy: input.resolvedBy ?? 'local-user',
        ...(input.note !== undefined ? { note: input.note } : {}),
        decision: { decision: input.decision, memoryIds },
      });
      if (!applied) {
        throw new AquariusError('review_already_resolved', `Review ${review.reviewId} was applied concurrently.`, {
          details: { commitSha: result.commitSha },
        });
      }
    }

    this.#commits.record({
      commitSha: result.commitSha,
      jobId: review.jobId,
      sessionId: null,
      sourceHash: null,
      kind: 'review-decision',
      subject: `Review ${input.decision}: ${review.reviewId}`,
      filesChanged: result.files.length,
    });
    await projectFromGit({ repository: this.#repository, projection: this.#projection });
    log.info('review resolved', { review: review.reviewId, decision: input.decision });

    return {
      reviewId: review.reviewId,
      decision: input.decision,
      commitSha: result.commitSha,
      diff: result.diff,
      diffStat: result.diffStat,
      memoryIds,
      dryRun: false,
    };
  }

  countOpen(): number {
    return this.#reviews.countOpen();
  }
}

function closeRecord(
  record: MemoryRecord,
  now: string,
  supersededBy: string | null,
  status: 'superseded' | 'forgotten' = 'superseded',
): MemoryRecord {
  return {
    ...record,
    frontmatter: {
      ...record.frontmatter,
      status,
      valid_to: now,
      updated_at: now,
      superseded_by: supersededBy,
    },
  };
}

/**
 * When the user decides in favour of a version, the case that argued for it stops
 * being a contradiction and becomes support. Leaving it as "contradicting" would
 * keep the memory looking unresolved forever.
 */
function supportAfterDecision(record: MemoryRecord): Pick<MemoryRecord['frontmatter'], 'supporting_case_ids' | 'contradicting_case_ids'> {
  const supporting = new Set([...record.frontmatter.supporting_case_ids, ...record.frontmatter.contradicting_case_ids]);
  return { supporting_case_ids: [...supporting].slice(0, 50), contradicting_case_ids: [] };
}

function validateWrites(writes: FileChange[]): FileChange[] {
  for (const write of writes) {
    if (write.content === null) continue;
    if (!write.path.endsWith('.md')) continue;
    if (write.path.startsWith('evidence/') || write.path.startsWith('audit/') || write.path.startsWith('reviews/')) continue;
    if (!write.path.startsWith('active/') && !write.path.startsWith('candidates/') && !write.path.startsWith('archive/') && !write.path.startsWith('skills/')) {
      continue;
    }
    const parsed = tryParseMemory(write.content, write.path);
    if (!parsed.ok) {
      throw new AquariusError('validation_failed', `Review decision produced an invalid memory file:\n${parsed.errors.join('\n')}`, {
        details: { path: write.path, errors: parsed.errors },
      });
    }
  }
  return writes;
}
