/**
 * Error taxonomy. Every error that can reach the CLI / HTTP surface carries a
 * stable `code` and an `httpStatus` so the API can map it without string matching.
 */

export type AquariusErrorCode =
  | 'config_invalid'
  | 'config_missing'
  | 'memory_repo_invalid'
  | 'memory_repo_dirty'
  | 'stale_head'
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'unauthorized'
  | 'forbidden'
  | 'review_expired'
  | 'review_already_resolved'
  | 'skill_not_approved'
  | 'skill_install_conflict'
  | 'source_unavailable'
  | 'agent_budget_exceeded'
  | 'job_failed'
  | 'not_implemented';

const HTTP_STATUS: Record<AquariusErrorCode, number> = {
  config_invalid: 500,
  config_missing: 500,
  memory_repo_invalid: 500,
  memory_repo_dirty: 409,
  stale_head: 409,
  validation_failed: 422,
  not_found: 404,
  conflict: 409,
  unauthorized: 401,
  forbidden: 403,
  review_expired: 409,
  review_already_resolved: 409,
  skill_not_approved: 409,
  skill_install_conflict: 409,
  source_unavailable: 503,
  agent_budget_exceeded: 504,
  job_failed: 500,
  not_implemented: 501,
};

export class AquariusError extends Error {
  readonly code: AquariusErrorCode;
  readonly httpStatus: number;
  readonly details: Record<string, unknown> | undefined;
  readonly actionable: string | undefined;

  constructor(
    code: AquariusErrorCode,
    message: string,
    options: { details?: Record<string, unknown>; actionable?: string; cause?: unknown } = {},
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AquariusError';
    this.code = code;
    this.httpStatus = HTTP_STATUS[code];
    this.details = options.details;
    this.actionable = options.actionable;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      message: this.message,
      ...(this.actionable ? { actionable: this.actionable } : {}),
      ...(this.details ? { details: this.details } : {}),
    };
  }
}

export function isAquariusError(value: unknown): value is AquariusError {
  return value instanceof AquariusError;
}

/** Raised when the caller's expected HEAD no longer matches the repository HEAD. */
export class StaleHeadError extends AquariusError {
  constructor(expected: string | null, actual: string | null) {
    super('stale_head', 'The memory repository HEAD changed since this proposal was created.', {
      details: { expectedHead: expected, actualHead: actual },
      actionable: 'Re-run the preview and confirm again against the new HEAD.',
    });
    this.name = 'StaleHeadError';
  }
}
