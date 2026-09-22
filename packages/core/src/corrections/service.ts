import type { AquariusConfig } from '../config.ts';
import { AquariusError } from '../errors.ts';
import type { MemoryStore, FileChange } from '../git/memoryStore.ts';
import type { MemoryRepository } from '../memory/repository.ts';
import { serializeRecord } from '../memory/repository.ts';
import { tryParseMemory } from '../memory/frontmatter.ts';
import { memoryPath } from '../memory/paths.ts';
import type { MemoryFrontmatter, MemoryRecord, MemoryStatus } from '../memory/schema.ts';
import type { ReviewStore, ReviewRecord } from '../db/reviewStore.ts';
import type { ProjectionStore } from '../db/projectionStore.ts';
import type { CommitStore } from '../db/commitStore.ts';
import { projectFromGit } from '../query/retrieval.ts';
import { lexicalOverlap } from '../query/ftsText.ts';
import { newMemoryId } from '../util/ids.ts';
import { minutesFromNow, nowIso } from '../util/time.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('corrections');

export type CorrectionType = 'correction' | 'temporal_change' | 'forget' | 'content_edit';

export interface CorrectionPreview {
  reviewId: string;
  type: CorrectionType;
  baseHead: string | null;
  memoryIds: string[];
  affected: {
    memoryId: string;
    path: string;
    change: 'update' | 'close' | 'replace' | 'forget';
    newStatus: MemoryStatus;
  }[];
  diff: string;
  diffStat: string;
  notes: string[];
  expiresAt: string;
}

export interface CorrectionConfirmation {
  reviewId: string;
  commitSha: string;
  previousHead: string | null;
  memoryIds: string[];
  diff: string;
}

const FORGET_MARKERS = [/忘记/, /\bforget\b/i, /不要再?记/, /删掉(?:这条|该)?记忆/, /\bremove (?:that|this) memory\b/i, /\bdelete (?:that|this)?\s*memory\b/i];
const TEMPORAL_MARKERS = [/现在(?:已经)?/, /改成/, /换成/, /不再/, /\bnow\b/i, /\bswitched to\b/i, /\bchanged to\b/i, /\bno longer\b/i];
const CORRECTION_MARKERS = [/错了/, /不对/, /并不/, /其实(?:是|不是)/, /是错的/, /\bwrong\b/i, /\bincorrect\b/i, /\bactually\b/i, /\bnot true\b/i];

export function classifyCorrection(instruction: string): CorrectionType {
  if (FORGET_MARKERS.some((pattern) => pattern.test(instruction))) return 'forget';
  if (CORRECTION_MARKERS.some((pattern) => pattern.test(instruction))) return 'correction';
  if (TEMPORAL_MARKERS.some((pattern) => pattern.test(instruction))) return 'temporal_change';
  return 'content_edit';
}

/**
 * Correction flow (PLAN §6).
 *
 * Preview builds the exact file writes in an isolated staging area and stores
 * them, but moves no ref: cancelling a preview leaves the repository untouched.
 * Confirmation re-checks the previewed HEAD with a compare-and-swap commit, so a
 * decision made against stale memory can never be applied.
 */
export class CorrectionService {
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

  /** Locates the memories a natural-language correction is about. */
  async locate(instruction: string, limit = 3): Promise<MemoryRecord[]> {
    const snapshot = await this.#repository.snapshot();
    const hits = this.#projection.search(instruction, { limit: 24, includeNonActive: true });
    const scored = hits
      .map((hit) => {
        const record = snapshot.byId.get(hit.memoryId);
        if (!record) return null;
        const score = lexicalOverlap(instruction, `${record.frontmatter.title} ${record.body} ${record.frontmatter.tags.join(' ')}`);
        return { record, score };
      })
      .filter((entry): entry is { record: MemoryRecord; score: number } => entry !== null)
      .sort((a, b) => b.score - a.score);

    const relevant = scored.filter((entry) => entry.score > 0);
    return (relevant.length > 0 ? relevant : scored).slice(0, limit).map((entry) => entry.record);
  }

  async preview(input: { instruction: string; requestedBy?: string }): Promise<CorrectionPreview> {
    const instruction = input.instruction.trim();
    if (instruction === '') {
      throw new AquariusError('validation_failed', 'A correction needs a natural-language instruction.');
    }
    const type = classifyCorrection(instruction);
    const targets = await this.locate(instruction);
    const head = await this.#store.head();
    const now = nowIso();
    const notes: string[] = [];

    if (targets.length === 0) {
      throw new AquariusError('not_found', 'No memory matches that correction.', {
        actionable: 'Rephrase using words that appear in the memory, or inspect memories with `aquarius memory list`.',
      });
    }

    const writes: FileChange[] = [];
    const affected: CorrectionPreview['affected'] = [];

    for (const target of targets) {
      switch (type) {
        case 'forget': {
          const forgotten: MemoryRecord = {
            ...target,
            frontmatter: { ...target.frontmatter, status: 'forgotten', valid_to: now, updated_at: now },
          };
          writes.push(...this.#writeFor(target, forgotten));
          affected.push({ memoryId: target.frontmatter.id, path: memoryPath(forgotten.frontmatter), change: 'forget', newStatus: 'forgotten' });
          notes.push(
            '`forget` removes the memory from the current view. It does not erase Git history — past commits still contain it.',
          );
          break;
        }
        case 'correction': {
          const replacement = this.#replacement(target, instruction, now);
          const closed: MemoryRecord = {
            ...target,
            frontmatter: {
              ...target.frontmatter,
              status: 'superseded',
              valid_to: now,
              updated_at: now,
              superseded_by: replacement.frontmatter.id,
            },
          };
          writes.push(...this.#writeFor(target, closed), ...this.#writeFor(null, replacement));
          affected.push(
            { memoryId: target.frontmatter.id, path: memoryPath(closed.frontmatter), change: 'close', newStatus: 'superseded' },
            { memoryId: replacement.frontmatter.id, path: memoryPath(replacement.frontmatter), change: 'replace', newStatus: 'active' },
          );
          break;
        }
        case 'temporal_change': {
          const replacement = this.#replacement(target, instruction, now, { supersedes: [target.frontmatter.id] });
          const closed: MemoryRecord = {
            ...target,
            frontmatter: {
              ...target.frontmatter,
              status: 'superseded',
              valid_to: now,
              updated_at: now,
              superseded_by: replacement.frontmatter.id,
            },
          };
          writes.push(...this.#writeFor(target, closed), ...this.#writeFor(null, replacement));
          affected.push(
            { memoryId: target.frontmatter.id, path: memoryPath(closed.frontmatter), change: 'close', newStatus: 'superseded' },
            { memoryId: replacement.frontmatter.id, path: memoryPath(replacement.frontmatter), change: 'update', newStatus: 'active' },
          );
          notes.push('The previous version keeps its validity window and is closed with `valid_to`, rather than being rewritten.');
          break;
        }
        case 'content_edit': {
          const edited: MemoryRecord = {
            ...target,
            body: `${target.body}\n\n${instruction}`.trim(),
            frontmatter: {
              ...target.frontmatter,
              updated_at: now,
              authority: 'user_explicit',
              confidence: 'high',
              confidence_reason: 'Updated by an explicit user correction.',
            },
          };
          writes.push(...this.#writeFor(target, edited));
          affected.push({ memoryId: target.frontmatter.id, path: memoryPath(edited.frontmatter), change: 'update', newStatus: 'active' });
          break;
        }
      }
    }

    const validated = this.#validateWrites(writes);
    const proposal = await this.#store.propose(validated, {
      expectedHead: head,
      subject: `Propose ${type} correction`,
      trailers: { kind: 'correction-preview' },
    });

    const expiresAt = minutesFromNow(this.#config.reviewTtlMinutes).toISOString();
    const { review } = this.#reviews.create({
      type: 'correction',
      status: 'preview',
      baseHead: head,
      memoryIds: affected.map((entry) => entry.memoryId),
      proposal: {
        instruction,
        type,
        requestedBy: input.requestedBy ?? 'local-user',
        writes: validated.map((change) => ({ path: change.path, content: change.content })),
        affected,
        notes,
      },
      expiresAt,
      dedupeKey: null,
    });

    log.info('correction previewed', { review: review.reviewId, type, memories: affected.length });

    return {
      reviewId: review.reviewId,
      type,
      baseHead: head,
      memoryIds: affected.map((entry) => entry.memoryId),
      affected,
      diff: proposal.diff,
      diffStat: proposal.diffStat,
      notes,
      expiresAt,
    };
  }

  /** Applies a previewed correction. Requires the HEAD the preview was built on. */
  async confirm(input: { reviewId: string; expectedHead: string | null; requestedBy?: string }): Promise<CorrectionConfirmation> {
    const review = this.#reviews.get(input.reviewId);
    if (!review) throw new AquariusError('not_found', `Unknown review ${input.reviewId}`);
    if (review.type !== 'correction') {
      throw new AquariusError('validation_failed', `Review ${input.reviewId} is a ${review.type} review, not a correction preview.`);
    }
    if (review.status !== 'preview' && review.status !== 'pending') {
      throw new AquariusError('review_already_resolved', `Review ${input.reviewId} is already ${review.status}.`);
    }
    if (this.#reviews.isExpired(review)) {
      this.#reviews.markExpired(review.reviewId);
      throw new AquariusError('review_expired', `Preview ${input.reviewId} expired before it was confirmed.`, {
        actionable: 'Run the correction again to get a fresh preview.',
      });
    }

    const currentHead = await this.#store.head();
    if (input.expectedHead !== review.baseHead) {
      throw new AquariusError('stale_head', 'The confirmation carried a different HEAD than the preview was built on.', {
        details: { previewHead: review.baseHead, expectedHead: input.expectedHead, currentHead },
        actionable: 'Preview the correction again.',
      });
    }
    if (currentHead !== review.baseHead) {
      throw new AquariusError('stale_head', 'Memory changed since the preview was generated.', {
        details: { previewHead: review.baseHead, currentHead },
        actionable: 'Preview the correction again against the new HEAD.',
      });
    }

    const writes = this.#writesFromProposal(review);
    const validated = this.#validateWrites(writes);
    const memoryIds = (review.proposal['affected'] as { memoryId: string }[] | undefined)?.map((entry) => entry.memoryId) ?? review.memoryIds;

    const result = await this.#store.commit(validated, {
      expectedHead: review.baseHead,
      subject: `Apply ${String(review.proposal['type'] ?? 'correction')} correction`,
      body: [
        `Instruction: ${String(review.proposal['instruction'] ?? '')}`,
        `Review: ${review.reviewId}`,
        `Affected: ${memoryIds.join(', ')}`,
        `Approved by: ${input.requestedBy ?? 'local-user'}`,
      ].join('\n'),
      trailers: { jobId: review.jobId ?? undefined, kind: 'correction' },
    });

    const applied = this.#reviews.markApplied(review.reviewId, {
      commitSha: result.commitSha,
      resolvedBy: input.requestedBy ?? 'local-user',
      decision: { appliedMemoryIds: memoryIds },
    });
    if (!applied) {
      throw new AquariusError('review_already_resolved', `Review ${review.reviewId} was already applied.`, {
        details: { commitSha: result.commitSha },
      });
    }

    this.#commits.record({
      commitSha: result.commitSha,
      jobId: review.jobId,
      sessionId: null,
      sourceHash: null,
      kind: 'correction',
      subject: `Apply ${String(review.proposal['type'] ?? 'correction')} correction`,
      filesChanged: result.files.length,
    });
    await projectFromGit({ repository: this.#repository, projection: this.#projection });

    log.info('correction applied', { review: review.reviewId, commit: result.commitSha.slice(0, 12) });
    return {
      reviewId: review.reviewId,
      commitSha: result.commitSha,
      previousHead: result.previousHead,
      memoryIds,
      diff: result.diff,
    };
  }

  #writesFromProposal(review: ReviewRecord): FileChange[] {
    const raw = review.proposal['writes'];
    if (!Array.isArray(raw)) {
      throw new AquariusError('validation_failed', `Review ${review.reviewId} has no staged writes.`);
    }
    return raw.map((entry) => {
      const item = entry as { path?: unknown; content?: unknown };
      if (typeof item.path !== 'string') throw new AquariusError('validation_failed', 'Staged write is missing a path.');
      return {
        path: item.path,
        content: item.content === null || item.content === undefined ? null : String(item.content),
      };
    });
  }

  /**
   * Round-trips every staged memory file through the schema validator, so an
   * invalid record can never reach a commit.
   */
  #validateWrites(writes: FileChange[]): FileChange[] {
    const validated: FileChange[] = [];
    for (const write of writes) {
      if (write.content === null) {
        validated.push(write);
        continue;
      }
      if (write.path.endsWith('.md') && !write.path.startsWith('evidence/') && !write.path.startsWith('audit/')) {
        const parsed = tryParseMemory(write.content, write.path);
        if (!parsed.ok) {
          throw new AquariusError('validation_failed', `Correction produced an invalid memory file:\n${parsed.errors.join('\n')}`, {
            details: { path: write.path, errors: parsed.errors },
          });
        }
      }
      validated.push(write);
    }
    return validated;
  }

  #writeFor(previous: MemoryRecord | null, record: MemoryRecord): FileChange[] {
    const changes: FileChange[] = [];
    const targetPath = memoryPath(record.frontmatter, this.#config.schedule.timeZone);
    if (previous && previous.path !== targetPath) changes.push({ path: previous.path, content: null });
    changes.push({ path: targetPath, content: serializeRecord(record) });
    return changes;
  }

  #replacement(
    target: MemoryRecord,
    instruction: string,
    now: string,
    options: { supersedes?: string[] } = {},
  ): MemoryRecord {
    const frontmatter: MemoryFrontmatter = {
      ...target.frontmatter,
      id: newMemoryId(target.frontmatter.kind),
      status: 'active',
      created_at: now,
      updated_at: now,
      valid_from: now,
      valid_to: null,
      authority: 'user_explicit',
      confidence: 'high',
      confidence_reason: 'Created by an explicit user correction.',
      supersedes: options.supersedes ?? [target.frontmatter.id],
      superseded_by: null,
    };
    return { frontmatter, body: instruction, path: '' };
  }
}
