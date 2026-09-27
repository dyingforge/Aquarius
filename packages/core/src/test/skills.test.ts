import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEnvironment as makeEnvironment, writeCodexSession, ageFile, type TestEnvironment } from './harness.ts';
import { FakeAgentRuntime } from '../agents/fakeRuntime.ts';
import type { AgentRuntime } from '../agents/runtime.ts';
import { AQUARIUS_SKILL_MARKER, validateSkillCandidate } from '../skills/service.ts';
import { credentialLike } from './fixtures.ts';
import { tryParseMemory } from '../memory/frontmatter.ts';
import { serializeRecord } from '../memory/repository.ts';
import { createRedactor } from '../security/redact.ts';
import { effectiveCaseOutcome } from '../gates/caseOutcome.ts';

/** 测试用的确定性替身，保留发布流程测试；真实质量结论仍须用真实运行时。 */
function createEnvironment(): Promise<TestEnvironment> {
  const fake = new FakeAgentRuntime();
  const runtime: AgentRuntime = {
    mode: 'openai',
    model: 'test-evaluator-stub',
    describe: () => ({ ...fake.describe(), mode: 'openai', model: 'test-evaluator-stub' }),
    extract: (input) => fake.extract(input),
    consolidate: (input) => fake.consolidate(input),
    selectRelevant: (input) => fake.selectRelevant(input),
    answer: (input) => fake.answer(input),
    synthesizeSkill: (input) => fake.synthesizeSkill(input),
    evaluateSkill: (input) => fake.evaluateSkill(input),
  };
  return makeEnvironment({ runtime, scheduleEnabled: false });
}

/**
 * Builds three independent cases with two distinct task features that all support
 * the same strategy, which is the documented precondition for a skill candidate.
 */
async function buildSkillEvidence(env: TestEnvironment, confirmOutcomes = true): Promise<void> {
  const sessions: [string, string, { name: string; output: string }][] = [
    ['01a00000-0000-7000-8000-000000000601', '以后每次发布前都先跑完整的 typecheck 和 lint 检查', { name: 'exec', output: 'Script completed\nnpm run typecheck && npm run lint' }],
    ['01a00000-0000-7000-8000-000000000602', '以后每次发布前都先跑完整的 typecheck 和 lint 检查', { name: 'exec', output: 'Script completed\nnpm run typecheck && npm run lint' }],
    ['01a00000-0000-7000-8000-000000000603', '以后每次发布前都先跑完整的 typecheck 和 lint 检查', { name: 'exec', output: 'Script completed\nnpm run typecheck && npm run lint' }],
  ];
  for (const [id, message, tool] of sessions) {
    const path = await writeCodexSession(env.root, { sessionId: id, userMessages: [message], toolResults: [tool] });
    await ageFile(path);
    await env.service.ingest({});
  }
  // Distinct task features per case, so the skill gate's feature diversity applies.
  const cases = env.service.sessions.listCases();
  const features = [['release'], ['release', 'ci'], ['release', 'ci', 'quality']];
  cases.forEach((caseRecord, index) => {
    env.service.sessions.setCaseTaskFeatures(caseRecord.caseId, features[index % features.length]!);
  });
  if (confirmOutcomes) {
    const snapshot = await env.service.repository.snapshot();
    for (const strategy of snapshot.records.filter((record) => record.frontmatter.kind === 'strategy' && record.frontmatter.status === 'active')) {
      for (const caseId of strategy.frontmatter.supporting_case_ids) {
        const caseEvidence = snapshot.evidenceByCase.get(caseId) ?? [];
        if (caseEvidence.length === 0) continue;
        await env.service.recordCaseOutcome({
          caseId,
          strategyId: strategy.frontmatter.id,
          attemptId: `release-${caseId}`,
          result: 'success',
          evidenceIds: [caseEvidence[0]!.frontmatter.evidence_id],
          expectedHead: await env.service.store.head(),
          recordedBy: 'tester',
        });
      }
    }
  }
  // Case features are what the skill gate measures diversity over, so evaluate
  // again once they are recorded.
  await env.service.evaluateSkillCandidates();
  await env.service.drainJobs(20);
  if (confirmOutcomes) {
    const snapshot = await env.service.repository.snapshot();
    for (const strategy of snapshot.records.filter((record) => record.frontmatter.kind === 'strategy' && record.frontmatter.status === 'active')) {
      await env.service.setSkillEvaluationSuite({
        expectedHead: await env.service.store.head(),
        suite: {
          strategy_id: strategy.frontmatter.id,
          version: 1,
          contract: 'release-checklist-v1',
          cases: [
            { id: 'release-pass', source_case_id: null, task: 'Prepare a production release', applicable: true, expected_actions: ['typecheck', 'lint'], tool_outcomes: { typecheck: 'pass', lint: 'pass' }, critical: true, requires_stop_on_failure: false },
            { id: 'draft-only', source_case_id: null, task: 'Review a draft without publishing', applicable: false, expected_actions: [], tool_outcomes: { typecheck: 'pass', lint: 'pass' }, critical: true, requires_stop_on_failure: false },
            { id: 'release-lint-fail', source_case_id: null, task: 'Prepare a production release with failing lint', applicable: true, expected_actions: ['typecheck', 'lint'], tool_outcomes: { typecheck: 'pass', lint: 'fail' }, critical: true, requires_stop_on_failure: false },
          ],
        },
      });
    }
    await env.service.drainJobs(20);
  }
}

async function findSkillCandidate(env: TestEnvironment): Promise<string> {
  const skills = await env.service.skills.list();
  const candidate = skills.find((skill) => skill.status === 'candidate');
  assert.ok(candidate, `expected a skill candidate, got ${JSON.stringify(skills.map((skill) => skill.skillId))}`);
  return candidate!.skillId;
}

test('static checks flag secrets, absolute paths, undeclared tools and duplicate names', () => {
  const redactor = createRedactor();
  const base = {
    name: 'release-checklist',
    purpose: 'Run the documented release checklist before every production release.',
    triggers: ['the user is about to release'],
    inputs: ['the release candidate'],
    outputs: ['a completed checklist'],
    steps: ['Run the checks', 'Report the result'],
    limitations: ['Only for production releases'],
    tool_dependencies: [],
    rationale: 'derived from three cases',
  };

  assert.equal(validateSkillCandidate({ draft: base, supportingCaseCount: 3, existingNames: [], redactor }).ok, true);

  const withSecret = validateSkillCandidate({
    draft: {
      ...base,
      steps: [credentialLike('export API_KEY=sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz0123456789')],
    },
    supportingCaseCount: 3,
    existingNames: [],
    redactor,
  });
  assert.ok(withSecret.flags.includes('contains_secret'));

  const withPath = validateSkillCandidate({
    draft: { ...base, steps: ['Read /Users/someone/private/notes.md first'] },
    supportingCaseCount: 3,
    existingNames: [],
    redactor,
  });
  assert.ok(withPath.flags.includes('absolute_local_path'));

  const undeclared = validateSkillCandidate({
    draft: { ...base, steps: ['Run bash deploy.sh'] },
    supportingCaseCount: 3,
    existingNames: [],
    redactor,
  });
  assert.ok(undeclared.flags.includes('undeclared_tool_dependency'));

  const executable = validateSkillCandidate({
    draft: { ...base, steps: ['Run this:\n```bash\nrm -rf /\n```'] },
    supportingCaseCount: 3,
    existingNames: [],
    redactor,
  });
  assert.ok(executable.flags.includes('executable_code'));

  const duplicate = validateSkillCandidate({
    draft: base,
    supportingCaseCount: 3,
    existingNames: ['release-checklist'],
    redactor,
  });
  assert.ok(duplicate.flags.includes('duplicate_name'));

  const tooFewCases = validateSkillCandidate({ draft: base, supportingCaseCount: 2, existingNames: [], redactor });
  assert.ok(tooFewCases.flags.includes('insufficient_cases'));
});

test('a strategy with three independent successful cases produces an installable skill candidate', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env);

    const queued = env.service.jobs.list({ kind: 'skill_synthesize', limit: 20 });
    assert.ok(queued.length >= 1, 'the skill gate should queue synthesis once the precondition holds');
    assert.ok(queued.some((job) => job.status === 'done'));

    const skillId = await findSkillCandidate(env);
    const view = await env.service.skills.view(skillId);

    // The candidate carries the documented fields.
    assert.ok(view.name.length > 2);
    assert.ok(view.purpose.length > 10);
    assert.ok(view.triggers.length >= 1);
    assert.ok(view.inputs.length >= 1);
    assert.ok(view.outputs.length >= 1);
    assert.ok(view.steps.length >= 1);
    assert.ok(view.limitations.length >= 1);
    assert.ok(view.relatedStrategyIds.length >= 1);
    assert.ok(view.relatedCaseIds.length >= 3, 'the candidate must cite its supporting cases');
    assert.equal(view.supportingCaseCount >= 3, true);
    assert.equal(view.status, 'candidate');

    // It lives in the candidate area of the tree and nothing was installed.
    const files = await env.service.store.listTreeFiles();
    assert.ok(files.some((file) => file.startsWith('skills/candidates/') && file.endsWith('.md')));
    assert.ok(!files.some((file) => file.startsWith('skills/published/') && file.endsWith('.md')));
    const { readdir } = await import('node:fs/promises');
    assert.deepEqual(await readdir(env.skillInstallDir), [], 'nothing may be installed before approval');
  } finally {
    await env.cleanup();
  }
});

test('two successful cases are not enough to trigger synthesis', async () => {
  const env = await createEnvironment();
  try {
    for (const id of ['01a00000-0000-7000-8000-000000000611', '01a00000-0000-7000-8000-000000000612']) {
      const path = await writeCodexSession(env.root, {
        sessionId: id,
        userMessages: ['以后每次发布前都先跑完整的 typecheck 和 lint 检查'],
        toolResults: [{ name: 'exec', output: 'Script completed\nnpm run typecheck' }],
      });
      await ageFile(path);
      await env.service.ingest({});
    }
    await env.service.drainJobs(20);

    const skills = await env.service.skills.list();
    assert.equal(skills.filter((skill) => skill.status === 'candidate').length, 0, 'two cases must not be enough');
    const jobs = env.service.jobs.list({ kind: 'skill_synthesize', limit: 10 });
    assert.equal(jobs.length, 0, 'no synthesis job should have been queued');
  } finally {
    await env.cleanup();
  }
});

test('ordinary user instructions and successful tool calls do not prove task success', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env, false);
    const candidates = (await env.service.skills.list()).filter((skill) => skill.status === 'candidate');
    assert.equal(candidates.length, 0);
    assert.equal(env.service.jobs.list({ kind: 'skill_synthesize', limit: 20 }).length, 0);
  } finally {
    await env.cleanup();
  }
});

test('a duplicate proposal under review does not reinforce an active strategy', async () => {
  const fake = new FakeAgentRuntime();
  let duplicateTarget: string | null = null;
  const runtime: AgentRuntime = {
    mode: 'fake', model: fake.model, describe: () => fake.describe(),
    extract: async (input) => {
      const result = await fake.extract(input);
      return duplicateTarget ? { ...result, observations: result.observations.map((item) => ({ ...item, sensitivity: 'sensitive' as const })) } : result;
    },
    consolidate: async (input) => duplicateTarget ? {
      operations: input.observations.map((item, index) => ({
        operation: 'duplicate' as const, observation_index: index, target_memory_id: duplicateTarget,
        reason: 'Same strategy', merged_title: null, merged_body: null, confidence: item.confidence,
      })), notes: '',
    } : fake.consolidate(input),
    selectRelevant: (input) => fake.selectRelevant(input), answer: (input) => fake.answer(input),
    synthesizeSkill: (input) => fake.synthesizeSkill(input), evaluateSkill: (input) => fake.evaluateSkill(input),
  };
  const env = await makeEnvironment({ runtime, scheduleEnabled: false });
  try {
    const message = '以后每次发布前都先跑完整的 typecheck 和 lint 检查';
    const first = await writeCodexSession(env.root, { sessionId: '01a00000-0000-7000-8000-000000000691', userMessages: [message] });
    await ageFile(first);
    await env.service.ingest({});
    const before = await env.service.repository.snapshot();
    const strategy = before.records.find((item) => item.frontmatter.kind === 'strategy' && item.frontmatter.status === 'active')!;
    duplicateTarget = strategy.frontmatter.id;
    const second = await writeCodexSession(env.root, { sessionId: '01a00000-0000-7000-8000-000000000692', userMessages: [message] });
    await ageFile(second);
    await env.service.ingest({});
    const after = await env.service.repository.snapshot();
    assert.deepEqual(after.byId.get(strategy.frontmatter.id)?.frontmatter.supporting_case_ids, strategy.frontmatter.supporting_case_ids);
    assert.ok(after.records.some((item) => item.frontmatter.kind === 'strategy' && item.frontmatter.status === 'candidate'));
  } finally {
    await env.cleanup();
  }
});

test('case outcomes are idempotent, corrections are append-only, and the projection rebuilds from Git', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env, false);
    const snapshot = await env.service.repository.snapshot();
    const strategy = snapshot.records.find((item) => item.frontmatter.kind === 'strategy' && item.frontmatter.status === 'active')!;
    const caseId = strategy.frontmatter.supporting_case_ids[0]!;
    const evidenceId = snapshot.evidenceByCase.get(caseId)![0]!.frontmatter.evidence_id;
    const input = { caseId, strategyId: strategy.frontmatter.id, attemptId: 'attempt-1', result: 'success' as const,
      evidenceIds: [evidenceId], recordedBy: 'tester' };
    const first = await env.service.recordCaseOutcome({ ...input, expectedHead: await env.service.store.head() });
    const head = await env.service.store.head();
    const repeated = await env.service.recordCaseOutcome({ ...input, expectedHead: head });
    assert.equal(repeated.outcome.outcome_id, first.outcome.outcome_id);
    assert.equal(await env.service.store.head(), head, 'repeat confirmation must not commit');
    const correction = await env.service.recordCaseOutcome({
      ...input, result: 'failure', supersedes: first.outcome.outcome_id,
      expectedHead: await env.service.store.head(),
    });
    assert.notEqual(correction.outcome.outcome_id, first.outcome.outcome_id);
    const updated = await env.service.repository.snapshot();
    assert.equal(effectiveCaseOutcome(updated.outcomes, caseId, strategy.frontmatter.id), 'failure');
    env.service.database.run('DELETE FROM case_outcomes');
    await env.service.rebuildIndex();
    assert.equal(env.service.projection.listCaseOutcomes(caseId).length, 2);
  } finally {
    await env.cleanup();
  }
});

test('a fake evaluation cannot authorize publication', async () => {
  const env = await makeEnvironment({ scheduleEnabled: false });
  try {
    await buildSkillEvidence(env);
    const skillId = await findSkillCandidate(env);
    const view = await env.service.skills.view(skillId);
    assert.equal(view.evaluation.status, 'insufficient_evidence');
    await assert.rejects(
      () => env.service.approveSkill({ skillId, expectedHead: env.service.projection.indexState().head, approvedBy: 'tester' }),
      (error: { code?: string }) => error.code === 'validation_failed',
    );
  } finally {
    await env.cleanup();
  }
});

test('editing a candidate invalidates its previously passing evaluation report', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env);
    const skillId = await findSkillCandidate(env);
    assert.equal((await env.service.skills.view(skillId)).evaluation.status, 'pass');
    const path = `skills/candidates/${skillId}.md`;
    const original = await env.service.store.readFile(path);
    const parsed = tryParseMemory(original!, path);
    assert.ok(parsed.ok);
    const changed = serializeRecord({
      frontmatter: { ...parsed.value!.frontmatter, title: `${parsed.value!.frontmatter.title} updated` },
      body: parsed.value!.body,
    });
    await env.service.store.commit([{ path, content: changed }], {
      expectedHead: await env.service.store.head(), subject: 'Edit candidate for test', trailers: { kind: 'test' },
    });
    await env.service.rebuildIndex();
    assert.equal((await env.service.skills.view(skillId)).evaluation.status, 'stale');
    await assert.rejects(
      () => env.service.approveSkill({ skillId, expectedHead: env.service.projection.indexState().head, approvedBy: 'tester' }),
      (error: { code?: string }) => error.code === 'validation_failed',
    );
  } finally {
    await env.cleanup();
  }
});

test('publishing requires explicit approval, commits to Git first, then installs a marked file', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env);
    const skillId = await findSkillCandidate(env);

    // Approval must be made against the HEAD the candidate was read from.
    await assert.rejects(
      () => env.service.approveSkill({ skillId, expectedHead: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', approvedBy: 'tester' }),
      (error: { code?: string }) => {
        assert.equal(error.code, 'stale_head');
        return true;
      },
    );

    const head = await env.service.store.head();
    const published = await env.service.approveSkill({ skillId, expectedHead: head, approvedBy: 'tester', note: 'looks useful' });
    assert.ok(published.commitSha);
    assert.equal(published.version, 1);

    // Git holds the published version; the installer projected it into the skills dir.
    const files = await env.service.store.listTreeFiles();
    assert.ok(files.some((file) => file.startsWith('skills/published/') && file.endsWith('.md')));
    const installed = await readFile(published.installPath, 'utf8');
    assert.ok(installed.includes(AQUARIUS_SKILL_MARKER), 'installed skills carry the managed marker');
    assert.ok(installed.includes(`aquarius_skill_id: ${skillId}`));
    assert.ok(installed.includes(`aquarius_commit: ${published.commitSha}`), 'the install records its source commit');

    // The publication record keeps the commit, path and hash for rollback.
    const record = env.service.projection.getSkillPublication(skillId);
    assert.equal(record?.status, 'installed');
    assert.equal(record?.commitSha, published.commitSha);
    assert.equal(record?.installPath, published.installPath);
    assert.ok(record?.fileHash);
    assert.equal(record?.approvedBy, 'tester');

    // And the approval itself is auditable.
    const approvals = env.service.reviews.list({ type: 'skill_approval', limit: 10 });
    assert.ok(approvals.some((review) => review.status === 'approved' && review.memoryIds.includes(skillId)));
  } finally {
    await env.cleanup();
  }
});

test('a flagged candidate is quarantined and cannot be published', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env);
    const skillId = await findSkillCandidate(env);

    // Force quarantine flags onto the candidate file, as the static checks would.
    const path = `skills/candidates/${skillId}.md`;
    const content = await env.service.store.readFile(path);
    assert.ok(content);
    const parsed = tryParseMemory(content!, path);
    assert.equal(parsed.ok, true);
    const flagged = serializeRecord({
      frontmatter: { ...parsed.value!.frontmatter, review_flags: ['absolute_local_path'] },
      body: parsed.value!.body,
    });
    await env.service.store.commit([{ path, content: flagged }], {
      expectedHead: await env.service.store.head(),
      subject: 'flag candidate for test',
      trailers: { kind: 'test' },
    });
    await env.service.rebuildIndex();

    const head = await env.service.store.head();
    await assert.rejects(
      () => env.service.approveSkill({ skillId, expectedHead: head, approvedBy: 'tester' }),
      (error: { code?: string }) => {
        assert.ok(error.code === 'forbidden' || error.code === 'validation_failed');
        return true;
      },
    );
  } finally {
    await env.cleanup();
  }
});

test('the installer never overwrites a skill it does not manage', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env);
    const skillId = await findSkillCandidate(env);
    const view = await env.service.skills.view(skillId);

    // Someone else's skill with the same name already exists.
    const foreign = join(env.skillInstallDir, view.name);
    await mkdir(foreign, { recursive: true });
    await writeFile(join(foreign, 'SKILL.md'), '---\nname: someone else\n---\n\nHand-written skill.\n', 'utf8');

    const head = await env.service.store.head();
    await assert.rejects(
      () => env.service.approveSkill({ skillId, expectedHead: head, approvedBy: 'tester' }),
      (error: { code?: string }) => {
        assert.equal(error.code, 'skill_install_conflict');
        return true;
      },
    );

    const foreignContent = await readFile(join(foreign, 'SKILL.md'), 'utf8');
    assert.match(foreignContent, /Hand-written skill/, 'the foreign file must be untouched');
  } finally {
    await env.cleanup();
  }
});

test('rejecting a candidate keeps it out of the published area', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env);
    const skillId = await findSkillCandidate(env);
    const head = await env.service.store.head();

    await env.service.rejectSkill({ skillId, reason: 'not reusable enough', resolvedBy: 'tester', expectedHead: head });

    const view = await env.service.skills.view(skillId);
    assert.equal(view.status, 'rejected');
    const files = await env.service.store.listTreeFiles();
    assert.ok(files.some((file) => file.startsWith('skills/retired/') && file.endsWith('.md')));
    assert.equal(env.service.projection.getSkillPublication(skillId), null);
  } finally {
    await env.cleanup();
  }
});

test('a failed attempt produces a reviewed revision; approval keeps the Skill ID and rollback creates v3', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env);
    const skillId = await findSkillCandidate(env);
    const head = await env.service.store.head();
    const first = await env.service.approveSkill({ skillId, expectedHead: head, approvedBy: 'tester' });
    const firstContent = await readFile(first.installPath, 'utf8');

    const view = await env.service.skills.view(skillId);
    const strategyId = view.relatedStrategyIds[0]!;
    const caseId = view.relatedCaseIds[0]!;
    const snapshot = await env.service.repository.snapshot();
    const prior = snapshot.outcomes.find((item) => item.strategy_id === strategyId && item.case_id === caseId)!;
    const suite = snapshot.evaluationSuites.find((item) => item.strategy_id === strategyId)!;
    await env.service.recordCaseOutcome({
      caseId, strategyId, attemptId: prior.attempt_id, result: 'failure',
      evidenceIds: prior.evidence_ids, supersedes: prior.outcome_id,
      expectedHead: await env.service.store.head(), recordedBy: 'tester',
    });
    await env.service.setSkillEvaluationSuite({
      expectedHead: await env.service.store.head(),
      suite: { ...suite, version: 2, cases: [...suite.cases, {
        id: 'release-stop-on-failure', source_case_id: null,
        task: 'Prepare a production release and stop if lint fails', applicable: true,
        expected_actions: ['typecheck', 'lint'], tool_outcomes: { typecheck: 'pass', lint: 'fail' },
        critical: true, requires_stop_on_failure: true,
      }] },
    });
    await env.service.drainJobs(20);
    const revisions = (await env.service.repository.snapshot()).records.filter((item) => item.frontmatter.revises_skill_id === skillId);
    assert.equal(revisions.length, 1);
    const candidateId = revisions[0]!.frontmatter.id;
    assert.equal(await readFile(first.installPath, 'utf8'), firstContent, 'v1 stays installed until approval');
    const report = await env.service.evaluateSkill({ skillId: candidateId });
    assert.equal(report.status, 'pass');
    const second = await env.service.approveSkill({ skillId: candidateId, expectedHead: await env.service.store.head(), approvedBy: 'tester' });
    assert.equal(second.skillId, skillId);
    assert.equal(second.version, 2);
    const secondContent = await readFile(second.installPath, 'utf8');
    assert.notEqual(secondContent, firstContent);
    assert.match(secondContent, /stop and report/i);

    const rollback = await env.service.rollbackSkill({
      skillId,
      expectedHead: await env.service.store.head(),
      requestedBy: 'tester',
    });
    assert.ok(rollback.commitSha);
    assert.equal(rollback.version, 3);

    const rolledBack = await readFile(rollback.installPath, 'utf8');
    assert.equal(
      rolledBack.includes('aquarius_commit:') && rolledBack.length,
      rolledBack.length,
      'the rolled-back install still carries Aquarius metadata',
    );
    const record = env.service.projection.getSkillPublication(skillId);
    assert.equal(record?.status, 'installed');
    assert.ok(record?.rollbackOf, 'the rollback records what it rolled back from');

    assert.ok(!rolledBack.includes('stop and report'), 'rollback restores the v1 behavior as a new version');
    env.service.database.run('DELETE FROM skill_publications');
    await env.service.rebuildIndex();
    assert.equal(env.service.projection.getSkillPublication(skillId)?.version, 3);
    assert.equal(env.service.projection.getSkillPublication(skillId)?.status, 'installed');
  } finally {
    await env.cleanup();
  }
});

test('retiring a skill removes only the Aquarius-managed install', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env);
    const skillId = await findSkillCandidate(env);
    const published = await env.service.approveSkill({
      skillId,
      expectedHead: await env.service.store.head(),
      approvedBy: 'tester',
    });
    const name = (await env.service.skills.view(skillId)).name;

    const retired = await env.service.retireSkill({
      skillId,
      expectedHead: await env.service.store.head(),
      requestedBy: 'tester',
    });
    assert.equal(retired.installPath, published.installPath);
    assert.equal(retired.removedDirectory, join(env.skillInstallDir, name));

    const { existsSync } = await import('node:fs');
    assert.equal(existsSync(published.installPath), false, 'the managed install is removed');
    assert.equal(existsSync(retired.removedDirectory!), false, 'the owned directory is removed');
    assert.equal((await env.service.skills.view(skillId)).status, 'retired');
  } finally {
    await env.cleanup();
  }
});

test('reconciliation reports installations whose file no longer matches', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env);
    const skillId = await findSkillCandidate(env);
    const published = await env.service.approveSkill({
      skillId,
      expectedHead: await env.service.store.head(),
      approvedBy: 'tester',
    });

    await writeFile(published.installPath, 'tampered\n', 'utf8');
    const verification = await env.service.skills.verifyInstallations();
    const entry = verification.find((item) => item.skillId === skillId);
    assert.equal(entry?.ok, false);
  } finally {
    await env.cleanup();
  }
});
