import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { AquariusError, isAquariusError, type AquariusService, type ReviewDecision } from '@aquarius/core';
import { extractBearerToken, isLoopbackAddress, requireLocalAndAuthenticated } from './auth.ts';

const REVIEW_DECISIONS: ReviewDecision[] = ['adopt', 'merge', 'reject', 'temporal_change', 'forget'];

export interface AppOptions {
  service: AquariusService;
  logger?: boolean;
  /** Injected by tests to exercise the non-loopback rejection path. */
  remoteAddressOverride?: string;
}

function expectedHeadFrom(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const value = (body as { expectedHead?: unknown }).expectedHead;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw new AquariusError('validation_failed', 'expectedHead must be a string or null.');
  }
  return value;
}

function readField<T>(body: unknown, key: string, required = false): T | undefined {
  if (body === null || typeof body !== 'object') {
    if (required) throw new AquariusError('validation_failed', `Request body must be a JSON object with "${key}".`);
    return undefined;
  }
  const value = (body as Record<string, unknown>)[key];
  if (value === undefined || value === null) {
    if (required) throw new AquariusError('validation_failed', `Missing required field "${key}".`);
    return undefined;
  }
  return value as T;
}

/**
 * HTTP surface. The server is a thin transport: every route delegates to
 * {@link AquariusService}, and every write requires `expectedHead` so a decision
 * made against stale memory is rejected rather than applied.
 */
export function buildApp(options: AppOptions): FastifyInstance {
  const { service } = options;
  // `logger: false` already disables Fastify's own request logging; Aquarius emits
  // its own redacted structured log lines instead.
  const app = Fastify({
    logger: options.logger ?? false,
    bodyLimit: 1024 * 1024,
  });

  const authContext = { verifyToken: (token: string) => service.verifyToken(token) };

  app.addHook('onRequest', async (request: FastifyRequest) => {
    if (options.remoteAddressOverride && request.socket) {
      Object.defineProperty(request.socket, 'remoteAddress', {
        value: options.remoteAddressOverride,
        configurable: true,
      });
    }
    if (request.url.startsWith('/health')) return;
    requireLocalAndAuthenticated(request, authContext);
  });

  app.setErrorHandler((error: unknown, request, reply) => {
    if (isAquariusError(error)) {
      return reply.status(error.httpStatus).send({ error: error.toJSON() });
    }
    const statusCode = (error as { statusCode?: number }).statusCode;
    if (statusCode === 400) {
      return reply.status(400).send({
        error: { code: 'validation_failed', message: error instanceof Error ? error.message : String(error) },
      });
    }
    request.log.error({ err: error }, 'unhandled route error');
    return reply.status(500).send({
      error: { code: 'job_failed', message: 'Internal error. See the local service log for the redacted detail.' },
    });
  });

  app.get('/health', async (request) => {
    const health = await service.health();
    const authenticated = (() => {
      const token = extractBearerToken(request.headers.authorization);
      return token !== null && service.verifyToken(token);
    })();
    if (!authenticated) {
      // Unauthenticated loopback callers (launchd, probes) get a minimal view.
      return { status: health.status, version: health.version };
    }
    return health;
  });

  app.get('/v1/doctor', async () => service.doctor());

  app.get('/v1/config', async () => ({ config: service.configSummary(), issues: service.configIssues }));

  app.post('/v1/query', async (request) => {
    const question = readField<string>(request.body, 'question', true)!;
    const limit = readField<number>(request.body, 'limit');
    return service.query(question, limit !== undefined ? { limit } : {});
  });

  app.get('/v1/memories', async (request) => {
    const query = request.query as { kind?: string; status?: string; limit?: string };
    return service.listMemories({
      ...(query.kind ? { kind: query.kind } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.limit ? { limit: Number(query.limit) } : {}),
    });
  });

  app.get('/v1/memories/:memoryId', async (request) => {
    const { memoryId } = request.params as { memoryId: string };
    return service.getMemory(memoryId);
  });

  app.post('/v1/corrections/preview', async (request) => {
    const instruction = readField<string>(request.body, 'instruction', true)!;
    const requestedBy = readField<string>(request.body, 'requestedBy');
    return service.previewCorrection({ instruction, ...(requestedBy ? { requestedBy } : {}) });
  });

  app.post('/v1/corrections/:reviewId/confirm', async (request) => {
    const { reviewId } = request.params as { reviewId: string };
    const expectedHead = expectedHeadFrom(request.body);
    const requestedBy = readField<string>(request.body, 'requestedBy');
    return service.confirmCorrection({ reviewId, expectedHead, ...(requestedBy ? { requestedBy } : {}) });
  });

  app.post('/v1/ingestions', async (request) => {
    const sessionId = readField<string>(request.body, 'sessionId');
    const force = readField<boolean>(request.body, 'force');
    return service.ingest({ ...(sessionId ? { sessionId } : {}), ...(force !== undefined ? { force } : {}) });
  });

  app.get('/v1/ingestions/status', async () => service.ingestStatus());

  app.get('/v1/jobs', async (request) => {
    const query = request.query as { status?: string; kind?: string; limit?: string };
    return {
      jobs: service.jobs.list({
        ...(query.status ? { status: query.status as never } : {}),
        ...(query.kind ? { kind: query.kind as never } : {}),
        ...(query.limit ? { limit: Number(query.limit) } : {}),
      }),
    };
  });

  app.get('/v1/jobs/:jobId', async (request) => {
    const { jobId } = request.params as { jobId: string };
    const job = service.jobs.get(jobId);
    if (!job) throw new AquariusError('not_found', `Unknown job ${jobId}`);
    return job;
  });

  app.get('/v1/reviews', async (request) => {
    const query = request.query as { status?: string; type?: string; limit?: string };
    return {
      reviews: service.reviewService.list({
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.limit ? { limit: Number(query.limit) } : {}),
      }),
    };
  });

  app.get('/v1/reviews/:reviewId', async (request) => {
    const { reviewId } = request.params as { reviewId: string };
    return service.reviewService.view(reviewId);
  });

  app.post('/v1/reviews/:reviewId/resolve', async (request) => {
    const { reviewId } = request.params as { reviewId: string };
    const decision = readField<string>(request.body, 'decision', true)!;
    if (!REVIEW_DECISIONS.includes(decision as ReviewDecision)) {
      throw new AquariusError('validation_failed', `decision must be one of ${REVIEW_DECISIONS.join(', ')}`);
    }
    const expectedHead = expectedHeadFrom(request.body);
    const resolvedBy = readField<string>(request.body, 'resolvedBy');
    const note = readField<string>(request.body, 'note');
    const mergedBody = readField<string | null>(request.body, 'mergedBody');
    const mergedTitle = readField<string | null>(request.body, 'mergedTitle');
    const dryRun = readField<boolean>(request.body, 'dryRun');
    return service.resolveReview({
      reviewId,
      decision: decision as ReviewDecision,
      expectedHead,
      ...(resolvedBy ? { resolvedBy } : {}),
      ...(note ? { note } : {}),
      ...(mergedBody !== undefined ? { mergedBody } : {}),
      ...(mergedTitle !== undefined ? { mergedTitle } : {}),
      ...(dryRun !== undefined ? { dryRun } : {}),
    });
  });

  app.get('/v1/skills', async () => ({ skills: await service.skills.list() }));

  app.post('/v1/skills/evaluation-suites', async (request) => {
    const body = request.body as Record<string, unknown>;
    return service.setSkillEvaluationSuite({ suite: readField<Parameters<typeof service.setSkillEvaluationSuite>[0]['suite']>(body, 'suite', true)!, expectedHead: expectedHeadFrom(body) });
  });

  app.post('/v1/skills/:skillId/evaluate', async (request) => {
    const { skillId } = request.params as { skillId: string };
    return service.evaluateSkill({ skillId });
  });

  app.get('/v1/skills/:skillId/evaluation', async (request) => {
    const { skillId } = request.params as { skillId: string };
    const snapshot = await service.repository.snapshot();
    return { reports: snapshot.evaluationReports.filter((item) => item.candidate_id === skillId).sort((a, b) => b.created_at.localeCompare(a.created_at)) };
  });

  app.post('/v1/cases/:caseId/outcomes', async (request) => {
    const { caseId } = request.params as { caseId: string };
    const body = request.body as Record<string, unknown>;
    const strategyId = readField<string>(body, 'strategyId');
    const attemptId = readField<string>(body, 'attemptId');
    const result = readField<string>(body, 'result');
    const evidenceIds = readField<string[]>(body, 'evidenceIds');
    if (!strategyId || !attemptId || !['success', 'failure', 'unknown'].includes(result ?? '') || !Array.isArray(evidenceIds)) {
      throw new AquariusError('validation_failed', 'strategyId, attemptId, result and evidenceIds are required.');
    }
    return service.recordCaseOutcome({
      caseId,
      strategyId,
      attemptId,
      result: result as 'success' | 'failure' | 'unknown',
      evidenceIds,
      expectedHead: expectedHeadFrom(body),
      recordedBy: readField<string>(body, 'recordedBy') ?? 'local-user',
      supersedes: readField<string>(body, 'supersedes'),
    });
  });

  app.get('/v1/skills/:skillId', async (request) => {
    const { skillId } = request.params as { skillId: string };
    return service.skills.view(skillId);
  });

  app.post('/v1/skills/:skillId/approve', async (request) => {
    const { skillId } = request.params as { skillId: string };
    const expectedHead = expectedHeadFrom(request.body);
    const approvedBy = readField<string>(request.body, 'approvedBy') ?? 'local-user';
    const note = readField<string>(request.body, 'note');
    return service.approveSkill({ skillId, expectedHead, approvedBy, ...(note ? { note } : {}) });
  });

  app.post('/v1/skills/:skillId/reject', async (request) => {
    const { skillId } = request.params as { skillId: string };
    const expectedHead = expectedHeadFrom(request.body);
    const reason = readField<string>(request.body, 'reason') ?? 'rejected by user';
    const resolvedBy = readField<string>(request.body, 'resolvedBy') ?? 'local-user';
    return service.rejectSkill({ skillId, reason, resolvedBy, expectedHead });
  });

  app.post('/v1/skills/:skillId/rollback', async (request) => {
    const { skillId } = request.params as { skillId: string };
    const expectedHead = expectedHeadFrom(request.body);
    const requestedBy = readField<string>(request.body, 'requestedBy') ?? 'local-user';
    return service.rollbackSkill({ skillId, expectedHead, requestedBy });
  });

  app.post('/v1/skills/:skillId/retire', async (request) => {
    const { skillId } = request.params as { skillId: string };
    const expectedHead = expectedHeadFrom(request.body);
    const requestedBy = readField<string>(request.body, 'requestedBy') ?? 'local-user';
    return service.retireSkill({ skillId, expectedHead, requestedBy });
  });

  app.post('/v1/index/rebuild', async () => service.rebuildIndex());

  return app;
}

export { isLoopbackAddress };
