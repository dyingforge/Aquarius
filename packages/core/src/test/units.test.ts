import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Redactor, createRedactor } from '../security/redact.ts';
import { buildMatchQuery, augmentForIndex, lexicalOverlap } from '../query/ftsText.ts';
import { applyPromotionGate, applySkillGate, verifyAuthority } from '../gates/promotion.ts';
import { memoryFrontmatterSchema, SCHEMA_VERSION } from '../memory/schema.ts';
import { tryParseMemory, serializeMemory } from '../memory/frontmatter.ts';
import { memoryPath, isQueryReadablePath } from '../memory/paths.ts';
import { canonicalJson, credentialLike, stableFrontmatterSample } from './fixtures.ts';

test('redaction replaces every credential shape without touching ordinary text', () => {
  const redactor = createRedactor();
  const cases: [string, string][] = [
    [credentialLike('sk-', 'proj-', 'abcdefghijklmnopqrstuvwxyz0123456789'), 'openai_key'],
    [credentialLike('AKIA', 'IOSFODNN7EXAMPLE'), 'aws_access_key_id'],
    [credentialLike('ghp_', 'abcdefghijklmnopqrstuvwxyz0123456789'), 'github_token'],
    [credentialLike('xoxb-', '123456789012-', 'abcdefghijklmnop'), 'slack_token'],
    [credentialLike('AIza', 'SyA', '1234567890abcdefghijklmnopqrstuv'), 'google_api_key'],
    [credentialLike('Authorization: Bearer ', 'abcdefghijklmnopqrstuvwxyz'), 'authorization_header'],
    [
      credentialLike('DATABASE_URL=postgres://user:', 'sup3rsecret', '@db.internal:5432/app'),
      'connection_string',
    ],
    [credentialLike('password=', 'correcthorsebatterystaple'), 'named_secret'],
    [credentialLike('密码是 ', 'hunter2secret'), 'named_secret_prose'],
  ];

  for (const [input, expectedRule] of cases) {
    const result = redactor.redact(input);
    assert.ok(result.redacted, `expected ${input} to be redacted`);
    assert.ok(
      result.findings.some((finding) => finding.rule === expectedRule),
      `expected rule ${expectedRule} for ${input}, saw ${result.findings.map((finding) => finding.rule).join(',')}`,
    );
  }

  const privateKey = credentialLike(
    '-----BEGIN RSA PRIVATE KEY-----',
    '\nMIIEowIBAAKCAQEA\n',
    '-----END RSA PRIVATE KEY-----',
  );
  assert.equal(redactor.containsSecret(privateKey), true);

  const harmless = 'The project uses pnpm workspaces and Fastify for the local API.';
  const untouched = redactor.redact(harmless);
  assert.equal(untouched.redacted, false);
  assert.equal(untouched.text, harmless);
});

test('redaction supports configured extra patterns', () => {
  const redactor = new Redactor(['INTERNAL-[0-9]{4}']);
  const result = redactor.redact('reference INTERNAL-4242 is confidential');
  assert.ok(result.redacted);
  assert.match(result.text, /\[REDACTED:custom:INTERNAL-\[0-9\]\{4\}\]/);
});

test('FTS query building quotes user input so FTS operators cannot be injected', () => {
  const query = buildMatchQuery('what about "nearest" OR * (drop)');
  assert.ok(query !== null);
  assert.ok(!query!.includes('('), 'parentheses must not survive into the MATCH expression');
  assert.ok(!/\bOR\s+OR\b/.test(query!));
  assert.ok(query!.includes('"nearest"'));
  assert.equal(buildMatchQuery('   '), null);
});

test('CJK text is augmented with bigrams so Chinese queries match', () => {
  const augmented = augmentForIndex('统一使用 pnpm 管理依赖');
  assert.ok(augmented.includes('统一'), 'the full CJK run is indexed');
  assert.ok(augmented.includes('一使') || augmented.includes('使用'), 'bigrams are indexed');
  const query = buildMatchQuery('依赖管理');
  assert.ok(query !== null);
  assert.equal(lexicalOverlap('依赖管理', augmented) > 0, true);
});

test('authority is recomputed from evidence rather than trusted from the model', () => {
  assert.equal(verifyAuthority('user_explicit', []).authority, 'inferred');
  assert.equal(verifyAuthority('user_explicit', [{ kind: 'tool_result', verified: true }]).authority, 'tool_verified');
  assert.equal(verifyAuthority('inferred', [{ kind: 'user_message', verified: false }]).authority, 'user_explicit');
});

test('gate: one valid evidence item is enough for an experience, but not for an inferred profile', () => {
  const experience = applyPromotionGate({
    kind: 'experience',
    declaredAuthority: 'user_explicit',
    confidence: 'high',
    sensitivity: 'public',
    citedEvidence: [{ kind: 'user_message', verified: false }],
    distinctSupportingCaseIds: ['case_1'],
    contradictingCaseIds: [],
    hasUnresolvedConflict: false,
    userExplicitlyRequested: false,
  });
  assert.equal(experience.outcome, 'active');
  assert.equal(experience.effectiveAuthority, 'user_explicit');

  const singleCaseProfile = applyPromotionGate({
    kind: 'profile',
    declaredAuthority: 'inferred',
    confidence: 'high',
    sensitivity: 'public',
    citedEvidence: [{ kind: 'user_message', verified: false }],
    distinctSupportingCaseIds: ['case_1'],
    contradictingCaseIds: [],
    hasUnresolvedConflict: false,
    userExplicitlyRequested: false,
  });
  assert.equal(singleCaseProfile.effectiveAuthority, 'user_explicit');
  assert.equal(singleCaseProfile.outcome, 'active', 'a user statement about themselves promotes immediately');

  const twoCaseInferred = applyPromotionGate({
    kind: 'strategy',
    declaredAuthority: 'inferred',
    confidence: 'high',
    sensitivity: 'public',
    citedEvidence: [{ kind: 'tool_result', verified: true }],
    distinctSupportingCaseIds: ['case_1', 'case_2'],
    contradictingCaseIds: [],
    hasUnresolvedConflict: false,
    userExplicitlyRequested: false,
  });
  assert.equal(twoCaseInferred.outcome, 'active');

  const oneCaseInferred = applyPromotionGate({
    kind: 'strategy',
    declaredAuthority: 'inferred',
    confidence: 'medium',
    sensitivity: 'public',
    citedEvidence: [{ kind: 'tool_result', verified: true }],
    distinctSupportingCaseIds: ['case_1'],
    contradictingCaseIds: [],
    hasUnresolvedConflict: false,
    userExplicitlyRequested: false,
  });
  assert.notEqual(oneCaseInferred.outcome, 'active', 'one case must not promote an inferred strategy');
});

test('gate: conflicts, sensitivity and missing evidence never auto-promote', () => {
  const base = {
    kind: 'profile' as const,
    declaredAuthority: 'inferred' as const,
    confidence: 'high' as const,
    citedEvidence: [{ kind: 'user_message' as const, verified: false }],
    distinctSupportingCaseIds: ['case_1', 'case_2'],
    hasUnresolvedConflict: false,
    userExplicitlyRequested: false,
  };
  assert.equal(applyPromotionGate({ ...base, sensitivity: 'public', contradictingCaseIds: ['case_9'] }).outcome, 'review');
  assert.equal(applyPromotionGate({ ...base, sensitivity: 'sensitive', contradictingCaseIds: [] }).outcome, 'review');
  assert.equal(
    applyPromotionGate({ ...base, sensitivity: 'public', contradictingCaseIds: [], hasUnresolvedConflict: true }).outcome,
    'review',
  );
  assert.equal(
    applyPromotionGate({ ...base, sensitivity: 'public', contradictingCaseIds: [], citedEvidence: [] }).outcome,
    'reject',
  );

  // A conflict blocks an experience too: two contradictory statements must never
  // both become active memory.
  const conflictingExperience = applyPromotionGate({
    kind: 'experience',
    declaredAuthority: 'user_explicit',
    confidence: 'high',
    sensitivity: 'public',
    citedEvidence: [{ kind: 'user_message', verified: false }],
    distinctSupportingCaseIds: ['case_1'],
    contradictingCaseIds: ['case_2'],
    hasUnresolvedConflict: true,
    userExplicitlyRequested: false,
  });
  assert.equal(conflictingExperience.outcome, 'review');
  assert.equal(conflictingExperience.reviewKind, 'conflict');
});

test('gate: skill candidates need three successful independent cases across two task features', () => {
  const cases = (count: number, features: string[][]): { caseId: string; features: string[]; successfulEvidenceCount: number }[] =>
    Array.from({ length: count }, (_, index) => ({
      caseId: `case_${index + 1}`,
      features: features[index] ?? [],
      successfulEvidenceCount: 1,
    }));

  const tooFew = applySkillGate({
    strategyStatus: 'active',
    strategyKind: 'strategy',
    supportingCases: cases(2, [['deploy'], ['deploy']]),
    hasUnresolvedConflict: false,
  });
  assert.equal(tooFew.eligible, false);

  const oneFeature = applySkillGate({
    strategyStatus: 'active',
    strategyKind: 'strategy',
    supportingCases: cases(3, [['deploy'], ['deploy'], ['deploy']]),
    hasUnresolvedConflict: false,
  });
  assert.equal(oneFeature.eligible, false, 'three cases sharing one feature is not enough');

  const eligible = applySkillGate({
    strategyStatus: 'active',
    strategyKind: 'strategy',
    supportingCases: cases(3, [['deploy'], ['migration'], ['deploy']]),
    hasUnresolvedConflict: false,
  });
  assert.equal(eligible.eligible, true);
  assert.equal(eligible.distinctCases, 3);
  assert.equal(eligible.distinctFeatures, 2);

  const unresolved = applySkillGate({
    strategyStatus: 'active',
    strategyKind: 'strategy',
    supportingCases: cases(3, [['deploy'], ['migration'], ['deploy']]),
    hasUnresolvedConflict: true,
  });
  assert.equal(unresolved.eligible, false);
});

test('memory frontmatter contract round-trips and rejects invalid records', () => {
  const sample = stableFrontmatterSample();
  const parsed = memoryFrontmatterSchema.safeParse(sample);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? '' : parsed.error.issues));

  const serialized = serializeMemory({ frontmatter: parsed.data!, body: 'Body text.' });
  const reparsed = tryParseMemory(serialized, 'active/profile/pro_x.md');
  assert.equal(reparsed.ok, true);
  assert.deepEqual(canonicalJson(reparsed.value!.frontmatter), canonicalJson(parsed.data!));

  // superseded without superseded_by is invalid.
  const broken = structuredClone(sample);
  broken.status = 'superseded';
  assert.equal(memoryFrontmatterSchema.safeParse(broken).success, false);

  // an active record may not carry a closed validity window.
  const closed = structuredClone(sample);
  closed.valid_to = closed.valid_from;
  assert.equal(memoryFrontmatterSchema.safeParse(closed).success, false);

  // kind=skill requires the skill block.
  const skillWithoutBlock = structuredClone(sample);
  skillWithoutBlock.kind = 'skill';
  assert.equal(memoryFrontmatterSchema.safeParse(skillWithoutBlock).success, false);

  // a different schema version is rejected.
  const futureVersion = structuredClone(sample);
  futureVersion.schema_version = SCHEMA_VERSION + 1;
  assert.equal(memoryFrontmatterSchema.safeParse(futureVersion).success, false);
});

test('memory paths keep archived and candidate records out of the answering view', () => {
  const base = { id: 'pro_x', kind: 'profile' as const, created_at: '2026-01-01T00:00:00.000Z' };
  assert.equal(memoryPath({ ...base, status: 'active' }), 'active/profile/pro_x.md');
  assert.equal(memoryPath({ ...base, status: 'candidate' }), 'candidates/profile/pro_x.md');
  assert.equal(memoryPath({ ...base, status: 'superseded' }), 'archive/profile/pro_x.md');
  assert.equal(memoryPath({ ...base, status: 'forgotten' }), 'archive/profile/pro_x.md');

  assert.equal(isQueryReadablePath('summary/MEMORY.md'), true);
  assert.equal(isQueryReadablePath('active/profile/pro_x.md'), true);
  assert.equal(isQueryReadablePath('candidates/profile/pro_x.md'), false);
  assert.equal(isQueryReadablePath('archive/profile/pro_x.md'), false);
  assert.equal(isQueryReadablePath('skills/published/skl_x.md'), false);
});
