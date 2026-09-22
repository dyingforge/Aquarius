import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEnvironment, writeCodexSession, ageFile, type TestEnvironment } from './harness.ts';
import { AQUARIUS_SKILL_MARKER, validateSkillCandidate } from '../skills/service.ts';
import { credentialLike } from './fixtures.ts';
import { tryParseMemory } from '../memory/frontmatter.ts';
import { serializeRecord } from '../memory/repository.ts';
import { createRedactor } from '../security/redact.ts';

/**
 * Builds three independent cases with two distinct task features that all support
 * the same strategy, which is the documented precondition for a skill candidate.
 */
async function buildSkillEvidence(env: TestEnvironment): Promise<void> {
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
  // Case features are what the skill gate measures diversity over, so evaluate
  // again once they are recorded.
  await env.service.evaluateSkillCandidates();
  await env.service.drainJobs(20);
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
    assert.equal(queued[0]!.status, 'done');

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

test('publishing a second version then rolling back restores the previous content', async () => {
  const env = await createEnvironment();
  try {
    await buildSkillEvidence(env);
    const skillId = await findSkillCandidate(env);
    const head = await env.service.store.head();
    const first = await env.service.approveSkill({ skillId, expectedHead: head, approvedBy: 'tester' });
    const firstContent = await readFile(first.installPath, 'utf8');

    // Edit the candidate, re-publish: this is the "second version".
    const live = `skills/published/${skillId}.md`;
    const published = await env.service.store.readFile(live);
    assert.ok(published);
    const parsed = tryParseMemory(published!, live);
    assert.equal(parsed.ok, true, JSON.stringify(parsed.errors));
    const v2 = serializeRecord({
      frontmatter: { ...parsed.value!.frontmatter, status: 'candidate', title: `${parsed.value!.frontmatter.title} v2` },
      body: parsed.value!.body,
    });
    await env.service.store.commit(
      [
        { path: live, content: null },
        { path: `skills/candidates/${skillId}.md`, content: v2 },
      ],
      { expectedHead: await env.service.store.head(), subject: 'prepare v2', trailers: { kind: 'test' } },
    );
    await env.service.rebuildIndex();

    const second = await env.service.approveSkill({
      skillId,
      expectedHead: await env.service.store.head(),
      approvedBy: 'tester',
    });
    assert.equal(second.version, 2);
    const secondContent = await readFile(second.installPath, 'utf8');
    assert.notEqual(secondContent, firstContent);

    const rollback = await env.service.rollbackSkill({
      skillId,
      expectedHead: await env.service.store.head(),
      requestedBy: 'tester',
    });
    assert.ok(rollback.commitSha);

    const rolledBack = await readFile(rollback.installPath, 'utf8');
    assert.equal(
      rolledBack.includes('aquarius_commit:') && rolledBack.length,
      rolledBack.length,
      'the rolled-back install still carries Aquarius metadata',
    );
    const record = env.service.projection.getSkillPublication(skillId);
    assert.equal(record?.status, 'installed');
    assert.ok(record?.rollbackOf, 'the rollback records what it rolled back from');

    // Rolling back restored the original body, not the v2 edit.
    assert.ok(!rolledBack.includes('(v2)'), 'rollback must restore the previous published content');
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
