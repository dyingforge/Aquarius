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
import { effectiveCaseOutcome } from '../gates/caseOutcome.ts';
import { projectFromGit } from '../query/retrieval.ts';
import { JOB_PRIORITY } from '../db/jobStore.ts';
import { ensureDir, exists, sha256, sha256OfFile } from '../util/fsx.ts';
import { nowIso } from '../util/time.ts';
import { createLogger } from '../util/logger.ts';
import { randomUUID } from 'node:crypto';
import { evaluationReportPath, evaluationSuitePath } from '../memory/paths.ts';
import { evaluationReportSchema, evaluationSuiteSchema, judgeEvaluation, passesEvaluationCase, type EvaluationReport, type EvaluationSuite } from './evaluation.ts';
import { deriveId } from '../util/ids.ts';

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
  nameConflict: { path: string; managed: boolean; ownerId?: string | null } | null;
  revisesSkillId: string | null;
  evaluation: { status: EvaluationReport['status'] | 'missing' | 'stale'; reportId: string | null; scope: string | null };
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
 * 本函数只检查格式和静态风险；发布还要通过独立评测门禁。
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
          features: caseRecord?.taskFeatures ?? snapshot.outcomes.find((item) => item.case_id === caseId && item.strategy_id === memoryId)?.task_features ?? [],
          hasConfirmedSuccess: effectiveCaseOutcome(snapshot.outcomes, caseId, record.frontmatter.id) === 'success',
        };
      });

      const gate = applySkillGate({
        strategyStatus: record.frontmatter.status,
        strategyKind: record.frontmatter.kind,
        supportingCases,
        hasUnresolvedConflict:
          record.frontmatter.contradicting_case_ids.length > 0 || this.#hasOpenConflict(record.frontmatter.id),
      });

      const baseline = snapshot.records.find((item) => item.frontmatter.kind === 'skill' && item.frontmatter.status === 'active' && item.frontmatter.skill?.related_strategy_ids.includes(memoryId));
      const newOutcomes = baseline ? snapshot.outcomes.filter((item) => item.strategy_id === memoryId &&
        (baseline.frontmatter.skill?.source_outcome_ids?.length
          ? !baseline.frontmatter.skill.source_outcome_ids.includes(item.outcome_id)
          : item.recorded_at > baseline.frontmatter.updated_at)) : [];

      if (!gate.eligible && !baseline) {
        skipped.push({ memoryId, reasons: gate.reasons });
        continue;
      }
      if (baseline && (record.frontmatter.status !== 'active' || gate.reasons.some((reason) => reason.includes('unresolved conflict')) || newOutcomes.length === 0)) {
        skipped.push({ memoryId, reasons: ['No new adjudicated outcome since publication.'] });
        continue;
      }
      if (await this.hasCandidateFor(record.frontmatter.id)) {
        skipped.push({ memoryId, reasons: ['An unresolved candidate already exists for this strategy.'] });
        continue;
      }
      if (this.#jobs.list({ kind: 'skill_synthesize', limit: 1000 }).some((job) =>
        (job.status === 'queued' || job.status === 'running') && job.payload['strategyMemoryId'] === record.frontmatter.id)) {
        skipped.push({ memoryId, reasons: ['A synthesis job is already queued for this strategy.'] });
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
        record.frontmatter.status === 'candidate' &&
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

    if (await this.hasCandidateFor(strategyMemoryId)) {
      throw new AquariusError('conflict', 'An unresolved skill candidate already exists for this strategy.');
    }
    const baseline = snapshot.records.find((item) => item.frontmatter.kind === 'skill' && item.frontmatter.status === 'active' && item.frontmatter.skill?.related_strategy_ids.includes(strategyMemoryId));
    if (baseline) {
      const newOutcomes = snapshot.outcomes.filter((item) => item.strategy_id === strategyMemoryId &&
        (baseline.frontmatter.skill?.source_outcome_ids?.length
          ? !baseline.frontmatter.skill.source_outcome_ids.includes(item.outcome_id)
          : item.recorded_at > baseline.frontmatter.updated_at));
      if (newOutcomes.length === 0) throw new AquariusError('validation_failed', 'Revision requires a new adjudicated task outcome.');
    }

    const cases = strategy.frontmatter.supporting_case_ids
      .filter((caseId) => {
        const result = effectiveCaseOutcome(snapshot.outcomes, caseId, strategyMemoryId);
        return result === 'success' || (baseline && snapshot.outcomes.some((item) => item.case_id === caseId && item.strategy_id === strategyMemoryId && item.result === 'failure'));
      })
      .map((caseId) => {
      const caseRecord = this.#sessions.getCase(caseId);
      return {
        caseId,
        outcome: effectiveCaseOutcome(snapshot.outcomes, caseId, strategyMemoryId) === 'success' ? 'success' as const : 'failure' as const,
        title: caseRecord?.title ?? null,
        features: caseRecord?.taskFeatures ?? snapshot.outcomes.find((item) => item.case_id === caseId && item.strategy_id === strategyMemoryId)?.task_features ?? [],
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

    const gate = applySkillGate({
      strategyStatus: strategy.frontmatter.status,
      strategyKind: strategy.frontmatter.kind,
      supportingCases: cases.map((item) => ({ caseId: item.caseId, features: item.features, hasConfirmedSuccess: item.outcome === 'success' })),
      hasUnresolvedConflict: strategy.frontmatter.contradicting_case_ids.length > 0 || this.#hasOpenConflict(strategyMemoryId),
    });
    if (!gate.eligible && !baseline) {
      throw new AquariusError('validation_failed', `Strategy ${strategyMemoryId} lacks confirmed successful cases: ${gate.reasons.join(' ')}`, {
        actionable: 'Record task outcomes for three independent cases and evaluate candidates again.',
      });
    }

    const existingNames = snapshot.records
      .filter((record) => record.frontmatter.kind === 'skill' && record.frontmatter.skill && record.frontmatter.id !== baseline?.frontmatter.id)
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
      baselineSkill: baseline?.frontmatter.skill ?? null,
    });

    // Names are identifiers, so they are folded before validation: a model (or the
    // deterministic double) must never be able to produce an un-writable candidate.
    const draft = { ...rawDraft, name: baseline?.frontmatter.skill?.name ?? toKebabName(rawDraft.name, strategy.frontmatter.title) };
    const validation = validateSkillCandidate({
      draft,
      supportingCaseCount: baseline ? Math.max(3, strategy.frontmatter.supporting_case_ids.length) : cases.length,
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
          related_case_ids: strategy.frontmatter.supporting_case_ids,
          source_outcome_ids: snapshot.outcomes.filter((item) => item.strategy_id === strategyMemoryId).map((item) => item.outcome_id),
        },
        ...(baseline ? {
          revises_skill_id: baseline.frontmatter.id,
          base_commit_sha: head!,
          base_content_hash: snapshot.fileHashes.get(baseline.path)!,
        } : {}),
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
    if (snapshot.evaluationSuites.some((item) => item.strategy_id === strategyMemoryId)) {
      this.#queueCandidateEvaluation(skillId);
    }
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
      revisesSkillId: record.frontmatter.revises_skill_id ?? null,
      evaluation: this.#evaluationState(snapshot, record),
    };
  }

  async list(): Promise<SkillCandidateView[]> {
    const snapshot = await this.#repository.snapshot();
    return Promise.all(snapshot.records.filter((record) => record.frontmatter.kind === 'skill' && record.frontmatter.skill)
      .map(async (record) => {
        const skill = record.frontmatter.skill!;
        return {
          skillId: record.frontmatter.id,
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
          publication: this.#projection.getSkillPublication(record.frontmatter.id),
          nameConflict: await this.findInstalledConflict(skill.name),
          revisesSkillId: record.frontmatter.revises_skill_id ?? null,
          evaluation: this.#evaluationState(snapshot, record),
        };
      }));
  }

  /** 安装投影丢失后，从 Git 版本和受管安装文件恢复其可查询状态。 */
  async rebuildPublicationProjection(): Promise<void> {
    const snapshot = await this.#repository.snapshot();
    for (const record of snapshot.records.filter((item) => item.frontmatter.kind === 'skill' && item.frontmatter.skill &&
      (item.frontmatter.status === 'active' || item.frontmatter.status === 'retired'))) {
      const skillId = record.frontmatter.id;
      const version = record.frontmatter.skill_version ?? 1;
      const existing = this.#projection.getSkillPublication(skillId);
      const history = await this.#store.fileHistory(record.path);
      const directory = join(this.#config.skillInstallDir, record.frontmatter.skill!.name);
      const installPath = join(directory, 'SKILL.md');
      const owned = await this.#isManagedInstall(directory) && await this.#installedOwner(directory) === skillId;
      const installed = owned ? await readFile(installPath, 'utf8') : null;
      const commitSha = installed?.match(/^aquarius_commit: (.+)$/m)?.[1]?.trim() ?? history[0] ?? null;
      const rawContent = await this.#store.readFile(record.path);
      const expectedInstall = commitSha && rawContent ? `---\n${AQUARIUS_SKILL_MARKER}\naquarius_skill_id: ${skillId}\naquarius_commit: ${commitSha}\n---\n\n${rawContent}` : null;
      const installedOk = owned && installed === expectedInstall;
      const fileHash = installedOk ? await sha256OfFile(installPath) : null;
      this.#projection.upsertSkillPublication({
        skillId,
        skillName: record.frontmatter.skill!.name,
        version,
        status: record.frontmatter.status === 'retired' ? 'retired' : installedOk ? 'installed' : 'published',
        commitSha,
        previousCommitSha: history[1] ?? null,
        installPath: installedOk ? installPath : null,
        fileHash,
        files: fileHash ? [{ path: installPath, hash: fileHash }] : [],
        approvedBy: existing?.approvedBy ?? null,
        publishedAt: existing?.publishedAt ?? null,
        installedAt: existing?.installedAt ?? null,
        retiredAt: existing?.retiredAt ?? null,
        rollbackOf: existing?.rollbackOf ?? null,
        message: `Rebuilt from Git Skill v${version}`,
      });
    }
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

    const targetId = record.frontmatter.revises_skill_id ?? input.skillId;
    const baseline = record.frontmatter.revises_skill_id ? snapshot.byId.get(targetId) : null;
    if (record.frontmatter.revises_skill_id) {
      const baseContent = await this.#store.readFile(skillPath(targetId, 'active'), record.frontmatter.base_commit_sha);
      if (!baseline || baseline.frontmatter.status !== 'active' || !baseline.frontmatter.skill ||
        baseline.frontmatter.skill.name !== record.frontmatter.skill.name || !baseContent ||
        sha256(baseContent) !== record.frontmatter.base_content_hash ||
        snapshot.fileHashes.get(baseline.path) !== record.frontmatter.base_content_hash) {
        throw new AquariusError('stale_head', 'The published Skill baseline changed after this revision was created.', {
          actionable: 'Generate and evaluate a revision against the current published version.',
        });
      }
    }

    const conflict = await this.findInstalledConflict(record.frontmatter.skill.name);
    const otherPublished = snapshot.records.find((item) => item.frontmatter.kind === 'skill' && item.frontmatter.status === 'active' &&
      item.frontmatter.id !== targetId && item.frontmatter.skill?.name === record.frontmatter.skill?.name);
    if (otherPublished) {
      throw new AquariusError('skill_install_conflict', `Another published Skill owns the name "${record.frontmatter.skill.name}".`, {
        actionable: 'Choose a distinct name or retire the other Skill before publishing.',
      });
    }
    if (conflict && (!conflict.managed || conflict.ownerId !== targetId)) {
      throw new AquariusError(
        'skill_install_conflict',
        `Skill name "${record.frontmatter.skill.name}" is owned by another installation at ${conflict.path}.`,
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

    const evaluation = this.#evaluationState(snapshot, record);
    if (evaluation.status !== 'pass') {
      throw new AquariusError('validation_failed', `Skill ${input.skillId} has no current passing quality evaluation (${evaluation.status}).`, {
        actionable: 'Register an independent evaluation suite, run the evaluation with the real runtime, and inspect the report before approving.',
        details: { evaluation },
      });
    }

    const published: MemoryRecord = {
      ...record,
      frontmatter: {
        ...record.frontmatter,
        id: targetId,
        status: 'active',
        skill_version: (baseline?.frontmatter.skill_version ?? this.#projection.getSkillPublication(targetId)?.version ?? 0) + 1,
        updated_at: nowIso(),
        review_flags: [],
        revises_skill_id: undefined,
        base_commit_sha: undefined,
        base_content_hash: undefined,
      },
    };
    const targetPath = skillPath(targetId, 'active');
    const writes: FileChange[] = [
      { path: record.path, content: null },
      { path: targetPath, content: serializeRecord(published) },
    ];

    const version = published.frontmatter.skill_version!;
    const previous = this.#projection.getSkillPublication(targetId);
    const result = await this.#store.commit(writes, {
      expectedHead: currentHead,
      subject: `Publish skill ${record.frontmatter.skill.name} v${version}`,
      body: [
        `Skill: ${targetId}`,
        ...(targetId !== input.skillId ? [`Revision candidate: ${input.skillId}`] : []),
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
      memoryIds: targetId === input.skillId ? [targetId] : [targetId, input.skillId],
      proposal: { skillId: targetId, candidateId: input.skillId, name: record.frontmatter.skill.name, version, commitSha: result.commitSha },
      expiresAt: null,
      dedupeKey: `skill_approval:${targetId}:v${version}`,
      jobId: null,
    });
    await projectFromGit({ repository: this.#repository, projection: this.#projection });

    const install = await this.#install({
      skillId: targetId,
      name: record.frontmatter.skill.name,
      content: serializeRecord(published),
      commitSha: result.commitSha,
      version,
      approvedBy: input.approvedBy,
      previousCommitSha: previous?.commitSha ?? null,
    });

    return { skillId: targetId, commitSha: result.commitSha, ...install, version };
  }

  /** 固定的任务集先入 Git；候选合成器读不到它。 */
  async setEvaluationSuite(input: { suite: EvaluationSuite; expectedHead: string | null }): Promise<{ commitSha: string; version: number }> {
    const snapshot = await this.#repository.snapshot();
    if (snapshot.head !== input.expectedHead) throw new AquariusError('stale_head', 'Evaluation suite update requires the current HEAD.');
    const checked = evaluationSuiteSchema.safeParse(input.suite);
    if (!checked.success) throw new AquariusError('validation_failed', `Invalid evaluation suite: ${checked.error.issues.map((item) => item.message).join('; ')}`, {
      actionable: 'Provide a versioned release-checklist suite with applicable, inapplicable, and failure cases.',
    });
    const suite = checked.data;
    const strategy = snapshot.byId.get(suite.strategy_id);
    if (!strategy || strategy.frontmatter.kind !== 'strategy') throw new AquariusError('not_found', 'Evaluation strategy does not exist.');
    const prior = snapshot.evaluationSuites.find((item) => item.strategy_id === suite.strategy_id);
    if (prior && suite.version !== prior.version + 1) {
      throw new AquariusError('validation_failed', 'Evaluation suite version must increase by one.');
    }
    if (!prior && suite.version !== 1) throw new AquariusError('validation_failed', 'First evaluation suite version must be 1.');
    if (suite.cases.some((item) => item.source_case_id && strategy.frontmatter.supporting_case_ids.includes(item.source_case_id))) {
      throw new AquariusError('validation_failed', 'Evaluation cases cannot reuse the strategy synthesis cases.');
    }
    const serialized = JSON.stringify(suite);
    if (this.#redactor.redact(serialized).redacted) {
      throw new AquariusError('validation_failed', 'Evaluation suite contains credential-shaped content.');
    }
    const committed = await this.#store.commit([{ path: evaluationSuitePath(suite.strategy_id), content: `${JSON.stringify(suite, null, 2)}\n` }], {
      expectedHead: snapshot.head,
      subject: `Register evaluation suite v${suite.version}`,
      trailers: { kind: 'skill-evaluation-suite' },
    });
    await projectFromGit({ repository: this.#repository, projection: this.#projection });
    for (const candidate of snapshot.records.filter((item) => item.frontmatter.kind === 'skill' &&
      item.frontmatter.status === 'candidate' && item.frontmatter.skill?.related_strategy_ids.includes(suite.strategy_id))) {
      this.#queueCandidateEvaluation(candidate.frontmatter.id);
    }
    return { commitSha: committed.commitSha, version: suite.version };
  }

  #queueCandidateEvaluation(skillId: string): void {
    if (this.#jobs.list({ kind: 'skill_evaluate', limit: 1000 }).some((job) =>
      (job.status === 'queued' || job.status === 'running') && job.payload['skillId'] === skillId)) return;
    this.#jobs.create({ kind: 'skill_evaluate', trigger: 'post_ingest', priority: JOB_PRIORITY.post_ingest, payload: { skillId } });
  }

  /** 候选和基线在完全相同的隔离任务输入上运行，报告写入 Git。 */
  async evaluate(input: { skillId: string }): Promise<EvaluationReport> {
    const snapshot = await this.#repository.snapshot();
    const candidate = snapshot.byId.get(input.skillId);
    if (!candidate || candidate.frontmatter.kind !== 'skill' || candidate.frontmatter.status !== 'candidate' || !candidate.frontmatter.skill) {
      throw new AquariusError('not_found', 'Skill candidate does not exist.');
    }
    const strategyId = candidate.frontmatter.skill.related_strategy_ids[0];
    const suite = snapshot.evaluationSuites.find((item) => item.strategy_id === strategyId);
    if (!suite) throw new AquariusError('validation_failed', 'No independent evaluation suite is registered.', {
      actionable: 'Register a release-checklist evaluation suite before running the candidate evaluation.',
    });
    if (suite.cases.some((item) => item.source_case_id && candidate.frontmatter.supporting_case_ids.includes(item.source_case_id))) {
      throw new AquariusError('validation_failed', 'Evaluation cases overlap candidate synthesis cases.');
    }
    const baselineId = candidate.frontmatter.revises_skill_id ?? null;
    const baseline = baselineId ? snapshot.byId.get(baselineId) : null;
    if (baselineId && (!baseline || baseline.frontmatter.status !== 'active')) {
      throw new AquariusError('validation_failed', 'Revision baseline is no longer active.');
    }
    const candidateText = await this.#store.readFile(candidate.path);
    const baselineText = baseline ? await this.#store.readFile(baseline.path) : null;
    if (!candidateText || (baseline && !baselineText)) throw new AquariusError('validation_failed', 'Evaluation source file is missing at HEAD.');
    if (this.#redactor.redact(candidateText).redacted || (baselineText && this.#redactor.redact(baselineText).redacted)) {
      throw new AquariusError('validation_failed', 'Evaluation source contains credential-shaped content and cannot be sent to a model.', {
        actionable: 'Remove the credential-shaped content from the Skill before evaluating it.',
      });
    }
    const results: EvaluationReport['cases'] = [];
    let failedRun = false;
    for (const fixture of suite.cases) {
      try {
        const baselineTrial = await this.#runtime.evaluateSkill({ task: fixture, skillText: baselineText });
        const candidateTrial = await this.#runtime.evaluateSkill({ task: fixture, skillText: candidateText });
        results.push({
          id: fixture.id,
          baseline: baselineTrial,
          candidate: candidateTrial,
          baseline_pass: passesEvaluationCase(fixture, baselineTrial),
          candidate_pass: passesEvaluationCase(fixture, candidateTrial),
          critical: fixture.critical,
        });
      } catch {
        failedRun = true;
        break;
      }
    }
    const now = nowIso();
    const report = evaluationReportSchema.parse({
      report_id: deriveId('eval', input.skillId, now, randomUUID()),
      candidate_id: input.skillId,
      candidate_hash: sha256(candidateText),
      baseline_skill_id: baselineId,
      baseline_commit_sha: candidate.frontmatter.base_commit_sha ?? null,
      baseline_hash: baselineText ? sha256(baselineText) : null,
      suite_hash: sha256(JSON.stringify(suite)),
      suite_version: suite.version,
      model: this.#runtime.model,
      runtime: this.#runtime.mode,
      contract: suite.contract,
      scope: 'controlled-tool-simulation; no real commands',
      budget: {
        max_turns: this.#config.budgets.maxTurns,
        max_output_tokens: this.#config.budgets.maxOutputTokens,
        run_timeout_ms: this.#config.budgets.runTimeoutMs,
      },
      status: failedRun ? 'insufficient_evidence' : judgeEvaluation(results, this.#runtime.mode),
      cases: results,
      created_at: now,
    });
    await this.#store.commit([{ path: evaluationReportPath(report.report_id), content: `${JSON.stringify(report, null, 2)}\n` }], {
      expectedHead: snapshot.head,
      subject: `Evaluate skill candidate ${input.skillId}`,
      trailers: { kind: 'skill-evaluation' },
    });
    await projectFromGit({ repository: this.#repository, projection: this.#projection });
    return report;
  }

  #evaluationState(snapshot: Awaited<ReturnType<MemoryRepository['snapshot']>>, candidate: MemoryRecord): SkillCandidateView['evaluation'] {
    const reports = snapshot.evaluationReports
      .filter((item) => item.candidate_id === candidate.frontmatter.id)
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
    const report = reports[0];
    if (!report) return { status: 'missing', reportId: null, scope: null };
    const suite = snapshot.evaluationSuites.find((item) => item.strategy_id === candidate.frontmatter.skill?.related_strategy_ids[0]);
    const baselineId = candidate.frontmatter.revises_skill_id ?? null;
    const baseline = baselineId ? snapshot.byId.get(baselineId) : null;
    const casesMatch = Boolean(suite) && report.cases.length === suite!.cases.length &&
      report.cases.every((item, index) => {
        const fixture = suite!.cases[index]!;
        return item.id === fixture.id && item.critical === fixture.critical &&
          item.candidate_pass === passesEvaluationCase(fixture, item.candidate) &&
          item.baseline_pass === passesEvaluationCase(fixture, item.baseline);
      });
    const stale = !suite || report.candidate_hash !== snapshot.fileHashes.get(candidate.path) ||
      report.suite_hash !== sha256(JSON.stringify(suite)) || report.baseline_skill_id !== baselineId ||
      report.baseline_commit_sha !== (candidate.frontmatter.base_commit_sha ?? null) ||
      report.baseline_hash !== (baseline ? snapshot.fileHashes.get(baseline.path) : null) ||
      (baseline && candidate.frontmatter.base_content_hash !== snapshot.fileHashes.get(baseline.path)) ||
      report.model !== this.#runtime.model || report.runtime !== this.#runtime.mode ||
      report.budget.max_turns !== this.#config.budgets.maxTurns ||
      report.budget.max_output_tokens !== this.#config.budgets.maxOutputTokens ||
      report.budget.run_timeout_ms !== this.#config.budgets.runTimeoutMs ||
      !casesMatch || report.status !== judgeEvaluation(report.cases, report.runtime) ||
      suite.cases.some((item) => item.source_case_id && candidate.frontmatter.supporting_case_ids.includes(item.source_case_id));
    return { status: stale ? 'stale' : report.runtime === 'fake' ? 'insufficient_evidence' : report.status, reportId: report.report_id, scope: report.scope };
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

    const version = publication.version + 1;
    const restored: MemoryRecord = {
      ...parsed.value,
      frontmatter: { ...parsed.value.frontmatter, status: 'active', skill_version: version, updated_at: nowIso() },
    };
    const result = await this.#store.commit(
      [{ path: skillPath(input.skillId, 'active'), content: serializeRecord(restored) }],
      {
        expectedHead: currentHead,
        subject: `Roll back skill ${publication.skillName} as v${version}`,
        body: [`Requested by: ${input.requestedBy}`, `Rolled back from: ${publication.commitSha ?? 'unknown'}`, `Restored source: ${publication.previousCommitSha}`].join('\n'),
        trailers: { kind: 'skill-rollback' },
      },
    );
    await projectFromGit({ repository: this.#repository, projection: this.#projection });
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
    if (await this.#isManagedInstall(directory) && await this.#installedOwner(directory) === input.skillId) {
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
      if (!managed || await this.#installedOwner(directory) !== input.skillId) {
        throw new AquariusError(
          'skill_install_conflict',
          `Refusing to install over ${directory}: it is not owned by this Aquarius Skill.`,
          { actionable: 'Move or rename the conflicting skill directory, then retry.' },
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

  async #installedOwner(directory: string): Promise<string | null> {
    try {
      const content = await readFile(join(directory, 'SKILL.md'), 'utf8');
      return content.match(/^aquarius_skill_id: (.+)$/m)?.[1]?.trim() ?? null;
    } catch {
      return null;
    }
  }

  /** Detects a name collision in the install directory, and whether it is ours. */
  async findInstalledConflict(name: string): Promise<{ path: string; managed: boolean; ownerId: string | null } | null> {
    const directory = join(this.#config.skillInstallDir, name);
    if (!(await exists(directory))) return null;
    return { path: join(directory, 'SKILL.md'), managed: await this.#isManagedInstall(directory), ownerId: await this.#installedOwner(directory) };
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
