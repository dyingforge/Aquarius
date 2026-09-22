import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AquariusConfig } from '../config.ts';
import { AquariusError } from '../errors.ts';
import type { MemoryStore, FileChange } from '../git/memoryStore.ts';
import type { MemoryRepository } from '../memory/repository.ts';
import { serializeRecord } from '../memory/repository.ts';
import { skillPath } from '../memory/paths.ts';
import { tryParseMemory } from '../memory/frontmatter.ts';
import type { MemoryRecord } from '../memory/schema.ts';
import { SCHEMA_VERSION } from '../memory/schema.ts';
import type { SessionStore } from '../db/sessionStore.ts';
import type { JobStore } from '../db/jobStore.ts';
import type { ReviewStore } from '../db/reviewStore.ts';
import type { ProjectionStore, SkillPublicationRecord } from '../db/projectionStore.ts';
import type { CommitStore } from '../db/commitStore.ts';
import type { AgentRuntime } from '../agents/runtime.ts';
import type { Redactor } from '../security/redact.ts';
import { applySkillGate } from '../gates/promotion.ts';
import { projectFromGit } from '../query/retrieval.ts';
import { JOB_PRIORITY } from '../db/jobStore.ts';
import { ensureDir, exists, sha256, sha256OfFile } from '../util/fsx.ts';
import { nowIso } from '../util/time.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('skills');

/** Marker written into every SKILL.md Aquarius installs, so it never touches foreign files. */
export const AQUARIUS_SKILL_MARKER = 'aquarius_managed: true';

const KEBAB_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Folds an arbitrary name into the kebab-case identifier the contract requires.
 * Skill names are identifiers used as directory names, so they must be ASCII and
 * filesystem-safe; a fully non-Latin name falls back to a stable derived id.
 */
export function toKebabName(name: string, fallbackSeed?: string): string {
  const folded = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  if (folded.length >= 3 && KEBAB_NAME.test(folded)) return folded.slice(0, 64).replace(/-+$/, '');
  const seed = (fallbackSeed ?? name).replace(/[^\p{Letter}\p{Number}]+/gu, '');
  let hash = 0;
  for (const char of seed) hash = (hash * 31 + char.codePointAt(0)!) % 0xffffff;
  return `skill-${hash.toString(36)}`;
}

export interface SkillCandidateView {
  skillId: string;
  name: string;
  status: string;
  path: string;
  purpose: string;
  triggers: string[];
  inputs: string[];
  outputs: string[];
  steps: string[];
  limitations: string[];
  toolDependencies: string[];
  relatedStrategyIds: string[];
  relatedCaseIds: string[];
  supportingCaseCount: number;
  reviewFlags: string[];
  publication: SkillPublicationRecord | null;
  nameConflict: { path: string; managed: boolean } | null;
}

export interface SkillValidationResult {
  ok: boolean;
  flags: string[];
  reasons: string[];
}

const ABSOLUTE_PATH = /(^|[\s"'(=])\/(?:Users|home|root|var|etc|opt|tmp)\/[^\s"')]+/;
const HOME_PATH = /~\/[^\s"')]+/;
const SHELL_TOOL_NAMES = ['bash', 'sh', 'zsh', 'shell', 'exec', 'exec_command', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl', 'ssh', 'curl'];
const EXECUTABLE_HINT = /```(?:bash|sh|zsh|python|javascript|js|ts)\b/;

/**
 * Static, deterministic skill checks.
 *
 * Publication is a *format* gate, not a quality gate: PLAN §8 explicitly rules out
 * semantic evaluation or mandatory dry runs. What it does enforce is that nothing
 * with secrets, absolute machine paths or undeclared tool dependencies can be
 * published, and that a name collision is caught before install.
 */
export function validateSkillCandidate(input: {
  draft: {
    name: string;
    purpose: string;
    triggers: string[];
    inputs: string[];
    outputs: string[];
    steps: string[];
    limitations: string[];
    tool_dependencies: string[];
    rationale: string;
  };
  supportingCaseCount: number;
  existingNames: string[];
  redactor: Redactor;
}): SkillValidationResult {
  const flags: string[] = [];
  const reasons: string[] = [];
  const draft = input.draft;
  const flat = [
    draft.name,
    draft.purpose,
    ...draft.triggers,
    ...draft.inputs,
    ...draft.outputs,
    ...draft.steps,
    ...draft.limitations,
    ...draft.tool_dependencies,
    draft.rationale,
  ].join('\n');

  // Secrets and machine paths are unacceptable anywhere in the candidate, including
  // in the quoted provenance. Tool and code checks look only at the operative fields:
  // a rationale that quotes evidence must not be mistaken for an instruction.
  const operative = [draft.purpose, ...draft.triggers, ...draft.inputs, ...draft.outputs, ...draft.steps, ...draft.limitations].join('\n');

  const secretScan = input.redactor.redact(flat);
  if (secretScan.redacted) {
    flags.push('contains_secret');
    reasons.push(`Credential-shaped content detected (${secretScan.findings.map((finding) => finding.rule).join(', ')}).`);
  }
  if (ABSOLUTE_PATH.test(flat) || HOME_PATH.test(flat)) {
    flags.push('absolute_local_path');
    reasons.push('The candidate contains an absolute or home-relative machine path.');
  }
  if (EXECUTABLE_HINT.test(operative)) {
    flags.push('executable_code');
    reasons.push('The candidate embeds executable code, which the first version of skills does not allow.');
  }
  const mentionedShellTools = SHELL_TOOL_NAMES.filter((tool) => new RegExp(`\\b${tool}\\b`, 'i').test(operative));
  const declared = new Set(draft.tool_dependencies.map((tool) => tool.toLowerCase()));
  const undeclared = mentionedShellTools.filter((tool) => !declared.has(tool));
  if (undeclared.length > 0) {
    flags.push('undeclared_tool_dependency');
    reasons.push(`Undeclared tool dependencies: ${undeclared.join(', ')}.`);
  }
  if (input.existingNames.includes(draft.name)) {
    flags.push('duplicate_name');
    reasons.push(`A published skill named "${draft.name}" already exists.`);
  }
  if (input.supportingCaseCount < 3) {
    flags.push('insufficient_cases');
    reasons.push(`Only ${input.supportingCaseCount} supporting case(s).`);
  }
  if (!KEBAB_NAME.test(draft.name)) {
    flags.push('invalid_name');
    reasons.push(`Skill name "${draft.name}" is not a kebab-case identifier.`);
  }
  if (draft.steps.length === 0 || draft.outputs.length === 0 || draft.inputs.length === 0) {
    flags.push('missing_required_fields');
    reasons.push('Inputs, outputs and steps are all required.');
  }

  return { ok: flags.length === 0, flags, reasons };
}

/**
 * Skill lifecycle (PLAN §8).
 *
 * Candidates are generated automatically; publication never is. Approval must be
 * an explicit user action, and it lands in Git before the deterministic installer
 * copies anything into the Codex skills directory.
 */
export class SkillService {
  #config: AquariusConfig;
  #store: MemoryStore;
  #repository: MemoryRepository;
  #sessions: SessionStore;
  #jobs: JobStore;
  #reviews: ReviewStore;
  #projection: ProjectionStore;
  #commits: CommitStore;
  #runtime: AgentRuntime;
  #redactor: Redactor;

  constructor(deps: {
    config: AquariusConfig;
    store: MemoryStore;
    repository: MemoryRepository;
    sessions: SessionStore;
    jobs: JobStore;
    reviews: ReviewStore;
    projection: ProjectionStore;
    commits: CommitStore;
    runtime: AgentRuntime;
    redactor: Redactor;
  }) {
    this.#config = deps.config;
    this.#store = deps.store;
    this.#repository = deps.repository;
    this.#sessions = deps.sessions;
    this.#jobs = deps.jobs;
    this.#reviews = deps.reviews;
    this.#projection = deps.projection;
    this.#commits = deps.commits;
    this.#runtime = deps.runtime;
    this.#redactor = deps.redactor;
  }

  /**
   * Evaluates the skill-candidate precondition for the given memories and queues
   * synthesis for anything that qualifies. Safe to call repeatedly.
   */
  async evaluateCandidates(memoryIds: string[]): Promise<{ queued: { memoryId: string; jobId: string }[]; skipped: { memoryId: string; reasons: string[] }[] }> {
    const snapshot = await this.#repository.snapshot();
    const queued: { memoryId: string; jobId: string }[] = [];
    const skipped: { memoryId: string; reasons: string[] }[] = [];

    for (const memoryId of new Set(memoryIds)) {
      const record = snapshot.byId.get(memoryId);
      if (!record || record.frontmatter.kind !== 'strategy') continue;

      const supportingCases = record.frontmatter.supporting_case_ids.map((caseId) => {
        const caseRecord = this.#sessions.getCase(caseId);
        return {
          caseId,
          features: caseRecord?.taskFeatures ?? [],
          successfulEvidenceCount: this.#sessions
            .listEvidenceForCase(caseId, { limit: 100 })
            .filter((evidence) => evidence.verified || evidence.kind === 'user_message').length,
        };
      });

      const gate = applySkillGate({
        strategyStatus: record.frontmatter.status,
        strategyKind: record.frontmatter.kind,
        supportingCases,
        hasUnresolvedConflict:
          record.frontmatter.contradicting_case_ids.length > 0 || this.#hasOpenConflict(record.frontmatter.id),
      });

      if (!gate.eligible) {
        skipped.push({ memoryId, reasons: gate.reasons });
        continue;
      }
      if (await this.hasCandidateFor(record.frontmatter.id)) {
        skipped.push({ memoryId, reasons: ['A skill candidate or published skill already exists for this strategy.'] });
        continue;
      }

      const job = this.#jobs.create({
        kind: 'skill_synthesize',
        trigger: 'post_ingest',
        priority: JOB_PRIORITY.post_ingest,
        payload: { strategyMemoryId: record.frontmatter.id },
      });
      queued.push({ memoryId: record.frontmatter.id, jobId: job.jobId });
    }
    return { queued, skipped };
  }

  async hasCandidateFor(strategyMemoryId: string): Promise<boolean> {
    const snapshot = await this.#repository.snapshot();
    return snapshot.records.some(
      (record) =>
        record.frontmatter.kind === 'skill' &&
        record.frontmatter.status !== 'rejected' &&
        (record.frontmatter.skill?.related_strategy_ids ?? []).includes(strategyMemoryId),
    );
  }

  /** Runs SkillSynthesizerAgent and writes a candidate (never a published skill). */
  async generateCandidate(strategyMemoryId: string): Promise<{ skillId: string; path: string; reviewFlags: string[]; commitSha: string }> {
    const snapshot = await this.#repository.snapshot();
    const strategy = snapshot.byId.get(strategyMemoryId);
    if (!strategy || strategy.frontmatter.kind !== 'strategy') {
      throw new AquariusError('not_found', `Strategy ${strategyMemoryId} does not exist at HEAD.`);
    }

    const cases = strategy.frontmatter.supporting_case_ids.map((caseId) => {
      const caseRecord = this.#sessions.getCase(caseId);
      return {
        caseId,
        title: caseRecord?.title ?? null,
        features: caseRecord?.taskFeatures ?? [],
        evidence: this.#sessions
          .listEvidenceForCase(caseId, { limit: 6 })
          .filter((evidence) => evidence.verified || evidence.kind === 'user_message')
          .map((evidence) => ({
            kind: evidence.kind,
            tool: evidence.toolName,
            snippet: evidence.snippet.slice(0, 300),
          })),
      };
    });

    const existingNames = snapshot.records
      .filter((record) => record.frontmatter.kind === 'skill' && record.frontmatter.skill)
      .map((record) => record.frontmatter.skill!.name);

    const rawDraft = await this.#runtime.synthesizeSkill({
      strategy: {
        memoryId: strategy.frontmatter.id,
        kind: 'strategy',
        title: strategy.frontmatter.title,
        body: strategy.body,
        tags: strategy.frontmatter.tags,
        authority: strategy.frontmatter.authority,
        confidence: strategy.frontmatter.confidence,
        caseIds: strategy.frontmatter.supporting_case_ids,
        evidence: [],
      },
      cases,
      existingSkillNames: existingNames,
    });

    // Names are identifiers, so they are folded before validation: a model (or the
    // deterministic double) must never be able to produce an un-writable candidate.
    const draft = { ...rawDraft, name: toKebabName(rawDraft.name, strategy.frontmatter.title) };
    const validation = validateSkillCandidate({
      draft,
      supportingCaseCount: cases.length,
      existingNames,
      redactor: this.#redactor,
    });
    if (validation.flags.includes('contains_secret') || validation.flags.includes('duplicate_name')) {
      log.warn('skill candidate rejected by static checks', { strategy: strategyMemoryId, flags: validation.flags });
    }

    const head = await this.#store.head();
    const now = nowIso();
    const skillId = `skl_${strategy.frontmatter.id.slice(4, 18)}${Date.now().toString(36).slice(-4).toUpperCase()}`;
    const record: MemoryRecord = {
      frontmatter: {
        id: skillId,
        kind: 'skill',
        status: 'candidate',
        schema_version: SCHEMA_VERSION,
        title: `Skill: ${draft.name}`.slice(0, 160),
        tags: ['skill', ...strategy.frontmatter.tags].slice(0, 16),
        created_at: now,
        updated_at: now,
        valid_from: now,
        authority: 'inferred',
        confidence: cases.length >= 3 ? 'medium' : 'low',
        confidence_reason: `Synthesized from ${cases.length} independent case(s) supporting strategy ${strategy.frontmatter.id}.`,
        supporting_case_ids: strategy.frontmatter.supporting_case_ids,
        contradicting_case_ids: [],
        provenance: {
          source: 'aquarius',
          adapter: this.#runtime.mode,
          event_ids: [],
          case_id: cases[0]?.caseId,
          captured_at: now,
        },
        supersedes: [],
        sensitivity: 'public',
        review_flags: validation.flags,
        keywords: [draft.name, ...draft.triggers].slice(0, 16),
        skill: {
          name: draft.name,
          purpose: draft.purpose,
          triggers: draft.triggers,
          inputs: draft.inputs,
          outputs: draft.outputs,
          steps: draft.steps,
          limitations: draft.limitations,
          tool_dependencies: draft.tool_dependencies,
          related_strategy_ids: [strategy.frontmatter.id],
          related_case_ids: cases.map((caseRecord) => caseRecord.caseId),
        },
      },
      body: renderSkillBody(draft, strategy),
      path: '',
    };

    const path = skillPath(skillId, 'candidate');
    const writes: FileChange[] = [{ path, content: serializeRecord(record) }];
    const result = await this.#store.commit(writes, {
      expectedHead: head,
      subject: `Add skill candidate ${draft.name}`,
      body: [`Strategy: ${strategy.frontmatter.id}`, `Supporting cases: ${cases.length}`, `Static flags: ${validation.flags.join(', ') || 'none'}`].join('\n'),
      trailers: { kind: 'skill-candidate' },
    });

    this.#commits.record({
      commitSha: result.commitSha,
      jobId: null,
      sessionId: null,
      sourceHash: null,
      kind: 'skill-candidate',
      subject: `Add skill candidate ${draft.name}`,
      filesChanged: result.files.length,
    });

    // A flagged candidate is quarantined for review instead of being publishable.
    if (validation.flags.length > 0) {
      this.#reviews.create({
        type: 'skill_anomaly',
        status: 'pending',
        baseHead: result.commitSha,
        memoryIds: [skillId],
        proposal: {
          skillId,
          name: draft.name,
          flags: validation.flags,
          reasons: validation.reasons,
          strategyMemoryId: strategy.frontmatter.id,
        },
        expiresAt: null,
        dedupeKey: `skill_anomaly:${skillId}`,
        jobId: null,
      });
    }

    await projectFromGit({ repository: this.#repository, projection: this.#projection });
    log.info('skill candidate created', { skill: skillId, flags: validation.flags.length });
    return { skillId, path, reviewFlags: validation.flags, commitSha: result.commitSha };
  }

  async view(skillId: string): Promise<SkillCandidateView> {
    const snapshot = await this.#repository.snapshot();
    const record = snapshot.byId.get(skillId);
    if (!record || record.frontmatter.kind !== 'skill' || !record.frontmatter.skill) {
      throw new AquariusError('not_found', `Skill ${skillId} does not exist at HEAD.`);
    }
    const skill = record.frontmatter.skill;
    const conflict = await this.findInstalledConflict(skill.name);
    return {
      skillId,
      name: skill.name,
      status: record.frontmatter.status,
      path: record.path,
      purpose: skill.purpose,
      triggers: skill.triggers,
      inputs: skill.inputs,
      outputs: skill.outputs,
      steps: skill.steps,
      limitations: skill.limitations,
      toolDependencies: skill.tool_dependencies,
      relatedStrategyIds: skill.related_strategy_ids,
      relatedCaseIds: skill.related_case_ids,
      supportingCaseCount: record.frontmatter.supporting_case_ids.length,
      reviewFlags: record.frontmatter.review_flags,
      publication: this.#projection.getSkillPublication(skillId),
      nameConflict: conflict,
    };
  }

  list(): SkillCandidateView[] {
    return this.#projection
      .list({ kind: 'skill', limit: 200 })
      .map((row) => ({
        skillId: row.memory_id,
        name: (JSON.parse(row.tags) as string[]).includes('skill') ? row.memory_id : row.memory_id,
        status: row.status,
        path: row.path,
        purpose: row.title,
        triggers: [],
        inputs: [],
        outputs: [],
        steps: [],
        limitations: [],
        toolDependencies: [],
        relatedStrategyIds: [],
        relatedCaseIds: [],
        supportingCaseCount: (JSON.parse(row.case_ids) as string[]).length,
        reviewFlags: [],
        publication: this.#projection.getSkillPublication(row.memory_id),
        nameConflict: null,
      }));
  }

  /**
   * Publishes and installs a skill. The approval must be explicit: there is no
   * code path from an ingestion job to this method.
   */
  async approve(input: {
    skillId: string;
    expectedHead: string | null;
    approvedBy: string;
    note?: string;
  }): Promise<{ skillId: string; commitSha: string; installPath: string; version: number; fileHash: string }> {
    const snapshot = await this.#repository.snapshot();
    const record = snapshot.byId.get(input.skillId);
    if (!record || record.frontmatter.kind !== 'skill' || !record.frontmatter.skill) {
      throw new AquariusError('not_found', `Skill ${input.skillId} does not exist at HEAD.`);
    }
    if (record.frontmatter.status === 'active') {
      const publication = this.#projection.getSkillPublication(input.skillId);
      throw new AquariusError('conflict', `Skill ${input.skillId} is already published.`, {
        details: { publication },
      });
    }
    if (record.frontmatter.status !== 'candidate') {
      throw new AquariusError('conflict', `Skill ${input.skillId} is ${record.frontmatter.status} and cannot be published.`);
    }

    const currentHead = await this.#store.head();
    if (currentHead !== input.expectedHead) {
      throw new AquariusError('stale_head', 'Approval must be made against the HEAD the candidate was read from.', {
        details: { currentHead, expectedHead: input.expectedHead },
      });
    }

    const conflict = await this.findInstalledConflict(record.frontmatter.skill.name);
    if (conflict && !conflict.managed) {
      throw new AquariusError(
        'skill_install_conflict',
        `A non-Aquarius skill named "${record.frontmatter.skill.name}" already exists at ${conflict.path}.`,
        {
          actionable: 'Rename the skill candidate, or move the existing skill out of the way. Aquarius never overwrites foreign skills.',
          details: { path: conflict.path },
        },
      );
    }

    // Static publish gate: format, required fields, source cases, secrets, name conflict.
    const validation = validateSkillCandidate({
      draft: { ...record.frontmatter.skill, rationale: record.frontmatter.confidence_reason },
      supportingCaseCount: record.frontmatter.supporting_case_ids.length,
      existingNames: [],
      redactor: this.#redactor,
    });
    const blocking = validation.flags.filter((flag) => flag !== 'duplicate_name');
    if (blocking.length > 0) {
      throw new AquariusError('validation_failed', `Skill ${input.skillId} failed the static publish gate: ${validation.reasons.join(' ')}`, {
        details: { flags: blocking },
        actionable: 'Fix the candidate in Git, or reject it and generate a new one.',
      });
    }
    if (record.frontmatter.review_flags.length > 0) {
      throw new AquariusError('forbidden', `Skill ${input.skillId} is quarantined for review (${record.frontmatter.review_flags.join(', ')}).`, {
        actionable: 'Resolve the anomaly review first.',
      });
    }

    const published: MemoryRecord = {
      ...record,
      frontmatter: { ...record.frontmatter, status: 'active', updated_at: nowIso(), review_flags: [] },
    };
    const targetPath = skillPath(input.skillId, 'active');
    const writes: FileChange[] = [
      { path: record.path, content: null },
      { path: targetPath, content: serializeRecord(published) },
    ];

    const version = (this.#projection.getSkillPublication(input.skillId)?.version ?? 0) + 1;
    const result = await this.#store.commit(writes, {
      expectedHead: currentHead,
      subject: `Publish skill ${record.frontmatter.skill.name} v${version}`,
      body: [
        `Skill: ${input.skillId}`,
        `Approved by: ${input.approvedBy}`,
        input.note ? `Note: ${input.note}` : 'Note: (none)',
        `Supporting cases: ${record.frontmatter.supporting_case_ids.length}`,
      ].join('\n'),
      trailers: { kind: 'skill-publish' },
    });

    this.#commits.record({
      commitSha: result.commitSha,
      jobId: null,
      sessionId: null,
      sourceHash: null,
      kind: 'skill-publish',
      subject: `Publish skill ${record.frontmatter.skill.name} v${version}`,
      filesChanged: result.files.length,
    });
    this.#reviews.create({
      type: 'skill_approval',
      status: 'approved',
      baseHead: result.commitSha,
      memoryIds: [input.skillId],
      proposal: { skillId: input.skillId, name: record.frontmatter.skill.name, version, commitSha: result.commitSha },
      expiresAt: null,
      dedupeKey: `skill_approval:${input.skillId}:v${version}`,
      jobId: null,
    });
    await projectFromGit({ repository: this.#repository, projection: this.#projection });

    const previous = this.#projection.getSkillPublication(input.skillId);
    const install = await this.#install({
      skillId: input.skillId,
      name: record.frontmatter.skill.name,
      content: serializeRecord(published),
      commitSha: result.commitSha,
      version,
      approvedBy: input.approvedBy,
      previousCommitSha: previous?.commitSha ?? null,
    });

    return { skillId: input.skillId, commitSha: result.commitSha, ...install, version };
  }

  async reject(input: { skillId: string; reason: string; resolvedBy: string; expectedHead: string | null }): Promise<{ commitSha: string }> {
    const snapshot = await this.#repository.snapshot();
    const record = snapshot.byId.get(input.skillId);
    if (!record || record.frontmatter.kind !== 'skill') {
      throw new AquariusError('not_found', `Skill ${input.skillId} does not exist at HEAD.`);
    }
    const currentHead = await this.#store.head();
    if (currentHead !== input.expectedHead) {
      throw new AquariusError('stale_head', 'Rejection must be made against the current HEAD.', {
        details: { currentHead, expectedHead: input.expectedHead },
      });
    }
    const rejected: MemoryRecord = {
      ...record,
      frontmatter: { ...record.frontmatter, status: 'rejected', updated_at: nowIso(), confidence_reason: input.reason.slice(0, 400) },
    };
    const targetPath = skillPath(input.skillId, 'rejected');
    const result = await this.#store.commit(
      [
        { path: record.path, content: null },
        { path: targetPath, content: serializeRecord(rejected) },
      ],
      {
        expectedHead: currentHead,
        subject: `Reject skill candidate ${input.skillId}`,
        body: [`Rejected by: ${input.resolvedBy}`, `Reason: ${input.reason}`].join('\n'),
        trailers: { kind: 'skill-reject' },
      },
    );
    await projectFromGit({ repository: this.#repository, projection: this.#projection });

    for (const review of this.#reviews.list({ type: 'skill_approval', limit: 50 })) {
      if (review.memoryIds.includes(input.skillId) && (review.status === 'pending' || review.status === 'preview')) {
        this.#reviews.reject(review.reviewId, { note: input.reason, resolvedBy: input.resolvedBy });
      }
    }
    return { commitSha: result.commitSha };
  }

  /**
   * Rolls back to the previously published and installed version. Content is read
   * from the earlier commit, so Git stays the canonical source of the skill.
   */
  async rollback(input: { skillId: string; expectedHead: string | null; requestedBy: string }): Promise<{ commitSha: string; version: number; installPath: string }> {
    const publication = this.#projection.getSkillPublication(input.skillId);
    if (!publication || !publication.previousCommitSha) {
      throw new AquariusError('conflict', `Skill ${input.skillId} has no previous published version to roll back to.`);
    }
    const previousContent = await this.#store.readFile(skillPath(input.skillId, 'active'), publication.previousCommitSha);
    if (previousContent === null) {
      throw new AquariusError('conflict', `The previous version of ${input.skillId} is not present in Git history.`);
    }
    const parsed = tryParseMemory(previousContent, skillPath(input.skillId, 'active'));
    if (!parsed.ok || !parsed.value) {
      throw new AquariusError('validation_failed', `The previous version of ${input.skillId} does not satisfy the memory contract.`);
    }

    const currentHead = await this.#store.head();
    if (currentHead !== input.expectedHead) {
      throw new AquariusError('stale_head', 'Rollback must be made against the current HEAD.', {
        details: { currentHead, expectedHead: input.expectedHead },
      });
    }

    const restored: MemoryRecord = {
      ...parsed.value,
      frontmatter: { ...parsed.value.frontmatter, status: 'active', updated_at: nowIso() },
    };
    const result = await this.#store.commit(
      [{ path: skillPath(input.skillId, 'active'), content: serializeRecord(restored) }],
      {
        expectedHead: currentHead,
        subject: `Roll back skill ${publication.skillName} to v${publication.version - 1}`,
        body: [`Requested by: ${input.requestedBy}`, `Rolled back from: ${publication.commitSha ?? 'unknown'}`].join('\n'),
        trailers: { kind: 'skill-rollback' },
      },
    );
    const version = publication.version;
    const install = await this.#install({
      skillId: input.skillId,
      name: publication.skillName,
      content: serializeRecord(restored),
      commitSha: result.commitSha,
      version,
      approvedBy: input.requestedBy,
      previousCommitSha: publication.commitSha ?? null,
      rollbackOf: publication.commitSha ?? undefined,
    });
    return { commitSha: result.commitSha, version, installPath: install.installPath };
  }

  /**
   * Retires a published skill and removes only the Aquarius-managed install.
   * `installPath` is the SKILL.md path the publication record tracks; the
   * directory that was removed is reported separately.
   */
  async retire(input: {
    skillId: string;
    expectedHead: string | null;
    requestedBy: string;
  }): Promise<{ commitSha: string; installPath: string | null; removedDirectory: string | null }> {
    const snapshot = await this.#repository.snapshot();
    const record = snapshot.byId.get(input.skillId);
    if (!record || record.frontmatter.kind !== 'skill' || !record.frontmatter.skill) {
      throw new AquariusError('not_found', `Skill ${input.skillId} does not exist at HEAD.`);
    }
    const currentHead = await this.#store.head();
    if (currentHead !== input.expectedHead) {
      throw new AquariusError('stale_head', 'Retirement must be made against the current HEAD.');
    }
    const retired: MemoryRecord = {
      ...record,
      frontmatter: { ...record.frontmatter, status: 'retired', updated_at: nowIso(), valid_to: nowIso() },
    };
    const result = await this.#store.commit(
      [
        { path: record.path, content: null },
        { path: skillPath(input.skillId, 'retired'), content: serializeRecord(retired) },
      ],
      {
        expectedHead: currentHead,
        subject: `Retire skill ${record.frontmatter.skill.name}`,
        body: [`Requested by: ${input.requestedBy}`].join('\n'),
        trailers: { kind: 'skill-retire' },
      },
    );

    const directory = join(this.#config.skillInstallDir, record.frontmatter.skill.name);
    const publication = this.#projection.getSkillPublication(input.skillId);
    let removedDirectory: string | null = null;
    if (await this.#isManagedInstall(directory)) {
      await rm(directory, { recursive: true, force: true });
      removedDirectory = directory;
    }
    this.#projection.upsertSkillPublication({
      skillId: input.skillId,
      skillName: record.frontmatter.skill.name,
      version: publication?.version ?? 1,
      status: 'retired',
      commitSha: result.commitSha,
      previousCommitSha: publication?.commitSha ?? null,
      installPath: removedDirectory === null ? null : publication?.installPath ?? join(directory, 'SKILL.md'),
      fileHash: null,
      files: [],
      approvedBy: publication?.approvedBy ?? input.requestedBy,
      publishedAt: publication?.publishedAt ?? null,
      installedAt: publication?.installedAt ?? null,
      retiredAt: nowIso(),
      rollbackOf: null,
      message: `Retired by ${input.requestedBy}`,
    });
    await projectFromGit({ repository: this.#repository, projection: this.#projection });
    return {
      commitSha: result.commitSha,
      installPath: publication?.installPath ?? null,
      removedDirectory,
    };
  }

  // --- installer -------------------------------------------------------------

  /** Deterministic installer: copies one file into the Codex skills directory. */
  async #install(input: {
    skillId: string;
    name: string;
    content: string;
    commitSha: string;
    version: number;
    approvedBy: string;
    previousCommitSha: string | null;
    rollbackOf?: string;
  }): Promise<{ installPath: string; fileHash: string }> {
    const directory = join(this.#config.skillInstallDir, input.name);
    const installPath = join(directory, 'SKILL.md');
    const marker = `---\n${AQUARIUS_SKILL_MARKER}\naquarius_skill_id: ${input.skillId}\naquarius_commit: ${input.commitSha}\n---\n\n`;

    const previousPublication = this.#projection.getSkillPublication(input.skillId);
    if (await exists(directory)) {
      const managed = await this.#isManagedInstall(directory);
      if (!managed) {
        throw new AquariusError(
          'skill_install_conflict',
          `Refusing to install over ${directory}: it exists but is not managed by Aquarius.`,
          { actionable: 'Move or rename the existing skill directory, then retry.' },
        );
      }
    }
    await mkdir(directory, { recursive: true });
    await writeFile(installPath, marker + input.content, 'utf8');
    const fileHash = await sha256OfFile(installPath);

    this.#projection.upsertSkillPublication({
      skillId: input.skillId,
      skillName: input.name,
      version: input.version,
      status: 'installed',
      commitSha: input.commitSha,
      previousCommitSha: input.previousCommitSha ?? previousPublication?.commitSha ?? null,
      installPath,
      fileHash,
      files: [{ path: installPath, hash: fileHash }],
      approvedBy: input.approvedBy,
      publishedAt: previousPublication?.publishedAt ?? nowIso(),
      installedAt: nowIso(),
      retiredAt: null,
      rollbackOf: input.rollbackOf ?? null,
      message: `Installed v${input.version} from ${input.commitSha.slice(0, 12)}`,
    });
    log.info('skill installed', { skill: input.skillId, installPath });
    return { installPath, fileHash };
  }

  /** An install is ours only if SKILL.md carries the Aquarius marker. */
  async #isManagedInstall(directory: string): Promise<boolean> {
    const file = join(directory, 'SKILL.md');
    if (!(await exists(file))) return false;
    try {
      const content = await readFile(file, 'utf8');
      return content.includes(AQUARIUS_SKILL_MARKER);
    } catch {
      return false;
    }
  }

  /** Detects a name collision in the install directory, and whether it is ours. */
  async findInstalledConflict(name: string): Promise<{ path: string; managed: boolean } | null> {
    const directory = join(this.#config.skillInstallDir, name);
    if (!(await exists(directory))) return null;
    return { path: join(directory, 'SKILL.md'), managed: await this.#isManagedInstall(directory) };
  }

  /** Lists everything in the Codex skills directory so `doctor` can report on it. */
  async listInstallDirectory(): Promise<{ name: string; managed: boolean }[]> {
    try {
      await ensureDir(this.#config.skillInstallDir);
      const entries = await readdir(this.#config.skillInstallDir, { withFileTypes: true });
      const out: { name: string; managed: boolean }[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        out.push({
          name: entry.name,
          managed: await this.#isManagedInstall(join(this.#config.skillInstallDir, entry.name)),
        });
      }
      return out;
    } catch {
      return [];
    }
  }

  #hasOpenConflict(memoryId: string): boolean {
    return this.#reviews
      .list({ statuses: ['pending', 'preview'], limit: 100 })
      .some((review) => review.memoryIds.includes(memoryId));
  }

  /** Verifies on startup that what SQLite claims is installed really is. */
  async verifyInstallations(): Promise<{ skillId: string; ok: boolean; reason: string }[]> {
    const results: { skillId: string; ok: boolean; reason: string }[] = [];
    for (const publication of this.#projection.listSkillPublications()) {
      if (publication.status !== 'installed' || !publication.installPath) continue;
      if (!(await exists(publication.installPath))) {
        results.push({ skillId: publication.skillId, ok: false, reason: `Missing install at ${publication.installPath}` });
        continue;
      }
      const content = await readFile(publication.installPath, 'utf8');
      const hash = sha256(content);
      if (publication.fileHash && publication.fileHash !== hash) {
        results.push({ skillId: publication.skillId, ok: false, reason: 'Installed file hash does not match the recorded hash' });
        continue;
      }
      results.push({ skillId: publication.skillId, ok: true, reason: 'installed' });
    }
    return results;
  }
}

function renderSkillBody(
  draft: {
    name: string;
    purpose: string;
    triggers: string[];
    inputs: string[];
    outputs: string[];
    steps: string[];
    limitations: string[];
    tool_dependencies: string[];
    rationale: string;
  },
  strategy: MemoryRecord,
): string {
  return [
    `# ${draft.name}`,
    '',
    draft.purpose,
    '',
    '## When to use it',
    '',
    ...draft.triggers.map((trigger) => `- ${trigger}`),
    '',
    '## Inputs',
    '',
    ...draft.inputs.map((input) => `- ${input}`),
    '',
    '## Outputs',
    '',
    ...draft.outputs.map((output) => `- ${output}`),
    '',
    '## Steps',
    '',
    ...draft.steps.map((step, index) => `${index + 1}. ${step}`),
    '',
    '## Limitations',
    '',
    ...draft.limitations.map((limitation) => `- ${limitation}`),
    '',
    '## Tool dependencies',
    '',
    draft.tool_dependencies.length > 0 ? draft.tool_dependencies.map((tool) => `- ${tool}`).join('\n') : '_None._',
    '',
    '## Provenance',
    '',
    `- Derived from strategy \`${strategy.frontmatter.id}\`: ${strategy.frontmatter.title}`,
    `- Rationale: ${draft.rationale}`,
    `- Generated by Aquarius from validated session evidence. Declarative guidance only, no executable code.`,
    '',
  ].join('\n');
}
