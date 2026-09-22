import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEnvironment, writeCodexSession, ageFile, type TestEnvironment } from './harness.ts';

async function ingest(
  env: TestEnvironment,
  sessionId: string,
  userMessages: string[],
  toolResults: { name: string; output: string }[] = [{ name: 'exec', output: 'Script completed\nok' }],
): Promise<void> {
  const path = await writeCodexSession(env.root, { sessionId, userMessages, toolResults });
  await ageFile(path);
  await env.service.ingest({});
}

/** Produces a contradiction and returns the open conflict review. */
async function createContradiction(env: TestEnvironment): Promise<{ reviewId: string; candidateId: string; targetId: string }> {
  await ingest(env, '01a00000-0000-7000-8000-000000000401', ['这个项目不使用 Docker 部署']);
  await ingest(env, '01a00000-0000-7000-8000-000000000402', ['这个项目使用 Docker 部署']);

  const reviews = env.service.reviewService.list({ status: 'pending', type: 'conflict' });
  assert.ok(reviews.length > 0, 'expected a conflict review');
  const view = await env.service.reviewService.view(reviews[0]!.reviewId);
  assert.ok(view.candidate, 'the review must expose the new candidate');
  assert.ok(view.target, 'the review must expose the memory it conflicts with');
  return { reviewId: reviews[0]!.reviewId, candidateId: view.candidate!.frontmatter.id, targetId: view.target!.frontmatter.id };
}

test('a conflict review exposes candidate, target and both evidence sides', async () => {
  const env = await createEnvironment();
  try {
    const { reviewId, candidateId, targetId } = await createContradiction(env);
    const view = await env.service.reviewService.view(reviewId);

    assert.notEqual(candidateId, targetId);
    assert.ok(view.supportingEvidence.length >= 1, 'supporting evidence must be shown');
    assert.ok(view.gateReasons.length >= 1, 'gate reasons must be shown');
    assert.ok((view.confidenceReason ?? '').length > 0);
    assert.equal(view.status, 'pending');

    // Neither version is silently active.
    const active = await env.service.listMemories({ status: 'active', limit: 100 });
    assert.ok(active.memories.some((memory) => memory.memoryId === targetId));
    assert.ok(!active.memories.some((memory) => memory.memoryId === candidateId), 'the candidate is not current fact');

    // Ordinary questions never get the candidate as fact.
    const answer = await env.service.query('部署方式是什么');
    assert.ok(!answer.memoryIds.includes(candidateId), 'a pending candidate must not be cited');
  } finally {
    await env.cleanup();
  }
});

test('a review decision shows the final diff before it is applied (dry run writes nothing)', async () => {
  const env = await createEnvironment();
  try {
    const { reviewId } = await createContradiction(env);
    const head = await env.service.store.head();

    const dry = await env.service.resolveReview({
      reviewId,
      decision: 'adopt',
      expectedHead: head,
      dryRun: true,
    });
    assert.equal(dry.dryRun, true);
    assert.equal(dry.commitSha, null);
    assert.ok(dry.memoryIds.length > 0);
    assert.equal(await env.service.store.head(), head, 'a dry run must not move HEAD');
    assert.equal(env.service.reviewService.list({ status: 'pending' }).length, 1, 'the review is still open');
  } finally {
    await env.cleanup();
  }
});

test('adopting a conflicting candidate retires the version it contradicts', async () => {
  const env = await createEnvironment();
  try {
    const { reviewId, candidateId, targetId } = await createContradiction(env);
    const head = await env.service.store.head();

    const applied = await env.service.resolveReview({ reviewId, decision: 'adopt', expectedHead: head });
    assert.ok(applied.commitSha);
    assert.equal(applied.memoryIds.includes(candidateId), true);

    const adopted = await env.service.getMemory(candidateId);
    assert.equal(adopted.status, 'active');
    assert.equal(adopted.authority, 'user_explicit', 'a user decision is recorded as the authority');

    const retired = await env.service.getMemory(targetId);
    assert.equal(retired.status, 'superseded');

    const review = env.service.reviews.get(reviewId);
    assert.equal(review?.status, 'applied');
    assert.equal(review?.resolvedBy, 'local-user');
    assert.ok(review?.appliedCommit, 'the applied commit must be recorded');
    assert.ok(review?.resolvedAt, 'the decision time must be recorded');
  } finally {
    await env.cleanup();
  }
});

test('a review cannot be applied twice', async () => {
  const env = await createEnvironment();
  try {
    const { reviewId } = await createContradiction(env);
    const head = await env.service.store.head();
    await env.service.resolveReview({ reviewId, decision: 'adopt', expectedHead: head });
    const newHead = await env.service.store.head();

    await assert.rejects(
      () => env.service.resolveReview({ reviewId, decision: 'adopt', expectedHead: newHead }),
      (error: { code?: string }) => {
        assert.equal(error.code, 'review_already_resolved');
        return true;
      },
    );
  } finally {
    await env.cleanup();
  }
});

test('a stale HEAD is refused for review decisions', async () => {
  const env = await createEnvironment();
  try {
    const { reviewId } = await createContradiction(env);
    await assert.rejects(
      () =>
        env.service.resolveReview({
          reviewId,
          decision: 'reject',
          expectedHead: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
        }),
      (error: { code?: string }) => {
        assert.equal(error.code, 'stale_head');
        return true;
      },
    );
  } finally {
    await env.cleanup();
  }
});

test('rejecting a conflict discards the candidate and records the decision', async () => {
  const env = await createEnvironment();
  try {
    const { reviewId, candidateId, targetId } = await createContradiction(env);
    await env.service.resolveReview({
      reviewId,
      decision: 'reject',
      expectedHead: await env.service.store.head(),
      note: 'the older memory is still correct',
    });

    const candidate = await env.service.getMemory(candidateId);
    assert.equal(candidate.status, 'rejected');
    const target = await env.service.getMemory(targetId);
    assert.equal(target.status, 'active', 'rejecting the candidate leaves the existing memory alone');

    const review = env.service.reviews.get(reviewId);
    assert.equal(review?.status, 'applied');
    assert.match(String(review?.decisionNote), /older memory/);
    const answer = await env.service.query('Docker 部署');
    assert.ok(!answer.memoryIds.includes(candidateId));
  } finally {
    await env.cleanup();
  }
});

test('merge keeps both sides in one memory and closes the duplicate', async () => {
  const env = await createEnvironment();
  try {
    const { reviewId, candidateId, targetId } = await createContradiction(env);
    await env.service.resolveReview({
      reviewId,
      decision: 'merge',
      expectedHead: await env.service.store.head(),
      mergedTitle: 'Deployment target decision',
      mergedBody: 'The project used Docker historically; the current setup does not use Docker.',
      note: 'merged after discussing both cases',
    });

    const merged = await env.service.getMemory(targetId);
    assert.equal(merged.status, 'active');
    assert.equal(merged.title, 'Deployment target decision');
    assert.match(merged.body, /historically/);
    assert.ok(merged.supportingCaseIds.length >= 2, 'a merge keeps the cases from both sides');

    const other = await env.service.getMemory(candidateId);
    assert.equal(other.status, 'superseded');
  } finally {
    await env.cleanup();
  }
});

test('a temporal-change decision closes the old validity window instead of pretending it was wrong', async () => {
  const env = await createEnvironment();
  try {
    const { reviewId, candidateId, targetId } = await createContradiction(env);
    await env.service.resolveReview({
      reviewId,
      decision: 'temporal_change',
      expectedHead: await env.service.store.head(),
      note: 'the setup changed over time',
    });

    const current = await env.service.getMemory(candidateId);
    assert.equal(current.status, 'active');
    assert.equal(current.validTo, null, 'the current version has an open validity window');

    const previous = await env.service.getMemory(targetId);
    assert.equal(previous.status, 'superseded');
    assert.ok(previous.validTo, 'the previous version keeps a closed validity window');
    assert.ok(
      previous.validFrom !== null && previous.validTo !== null && previous.validFrom <= previous.validTo,
      'the validity window must be ordered',
    );
  } finally {
    await env.cleanup();
  }
});

test('new contradicting evidence after a resolution opens a fresh review rather than overwriting', async () => {
  const env = await createEnvironment();
  try {
    const { reviewId } = await createContradiction(env);
    await env.service.resolveReview({ reviewId, decision: 'adopt', expectedHead: await env.service.store.head() });
    const openAfterResolution = env.service.reviewService.list({ status: 'pending' }).length;

    // The opposite claim arrives again, from a new case.
    await ingest(env, '01a00000-0000-7000-8000-000000000403', ['这个项目不使用 Docker 部署']);

    const open = env.service.reviewService.list({ status: 'pending' });
    assert.ok(
      open.length > openAfterResolution,
      'the new evidence must create a new review, not silently flip the decided memory',
    );
    const appliedDecisions = env.service.reviewService
      .list({ status: 'applied' })
      .filter((review) => review.decision !== null && JSON.stringify(review.decision).includes('adopt'));
    assert.ok(appliedDecisions.length >= 1, 'the earlier decision must stay recorded');
  } finally {
    await env.cleanup();
  }
});
