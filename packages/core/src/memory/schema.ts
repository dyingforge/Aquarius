import { z } from 'zod';

/**
 * The Markdown memory contract. Every persisted memory is a Markdown file with
 * YAML frontmatter that satisfies this schema — the validator is the only way a
 * record can enter the memory Git repository.
 */

export const SCHEMA_VERSION = 1;

export const MEMORY_KINDS = ['experience', 'profile', 'strategy', 'skill'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

/**
 * `active` is the only status that may be used as current fact when answering.
 * `candidate` waits for the deterministic promotion gate or for a user review.
 */
export const MEMORY_STATUSES = ['active', 'candidate', 'superseded', 'retired', 'forgotten', 'rejected'] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const ACTIVE_STATUS: MemoryStatus = 'active';

export const AUTHORITIES = ['user_explicit', 'tool_verified', 'inferred'] as const;
export type Authority = (typeof AUTHORITIES)[number];

export const CONFIDENCES = ['high', 'medium', 'low'] as const;
export type Confidence = (typeof CONFIDENCES)[number];

export const SENSITIVITIES = ['public', 'personal', 'sensitive'] as const;
export type Sensitivity = (typeof SENSITIVITIES)[number];

export const provenanceSchema = z.object({
  /** Session source, e.g. `codex`. */
  source: z.string().min(1),
  /** Adapter contract identifier, e.g. `codex-jsonl`. */
  adapter: z.string().min(1),
  session_id: z.string().min(1).optional(),
  root_thread_id: z.string().min(1).optional(),
  source_path: z.string().min(1).optional(),
  content_hash: z.string().min(1).optional(),
  event_ids: z.array(z.string().min(1)).max(64).default([]),
  case_id: z.string().min(1).optional(),
  captured_at: z.string().min(1).optional(),
});
export type Provenance = z.output<typeof provenanceSchema>;

export const skillSpecSchema = z.object({
  /** Kebab-case, unique among installed skills. */
  name: z
    .string()
    .min(3)
    .max(64)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'skill names are kebab-case'),
  purpose: z.string().min(10).max(400),
  triggers: z.array(z.string().min(2)).min(1).max(12),
  inputs: z.array(z.string().min(1)).min(1).max(12),
  outputs: z.array(z.string().min(1)).min(1).max(12),
  steps: z.array(z.string().min(3)).min(1).max(24),
  limitations: z.array(z.string().min(2)).min(1).max(12),
  /** Declared tool dependencies. An empty list is valid; an undeclared one is not. */
  tool_dependencies: z.array(z.string().min(1)).max(24).default([]),
  related_strategy_ids: z.array(z.string().min(1)).default([]),
  related_case_ids: z.array(z.string().min(1)).default([]),
  source_outcome_ids: z.array(z.string().min(4)).default([]),
});
export type SkillSpec = z.output<typeof skillSpecSchema>;

export const memoryFrontmatterSchema = z
  .object({
    id: z.string().min(4),
    kind: z.enum(MEMORY_KINDS),
    status: z.enum(MEMORY_STATUSES),
    schema_version: z.number().int().positive(),
    title: z.string().min(3).max(160),
    tags: z.array(z.string().min(1).max(48)).max(16).default([]),
    created_at: z.string().min(10),
    updated_at: z.string().min(10),
    valid_from: z.string().min(10).nullable().optional(),
    valid_to: z.string().min(10).nullable().optional(),
    authority: z.enum(AUTHORITIES),
    confidence: z.enum(CONFIDENCES),
    confidence_reason: z.string().min(3).max(400),
    supporting_case_ids: z.array(z.string().min(1)).default([]),
    contradicting_case_ids: z.array(z.string().min(1)).default([]),
    provenance: provenanceSchema,
    supersedes: z.array(z.string().min(1)).default([]),
    superseded_by: z.string().min(1).nullable().optional(),
    sensitivity: z.enum(SENSITIVITIES).default('public'),
    /** Non-empty means the record is quarantined for review and cannot be published. */
    review_flags: z.array(z.string().min(3)).default([]),
    skill: skillSpecSchema.optional(),
    skill_version: z.number().int().positive().optional(),
    revises_skill_id: z.string().min(4).optional(),
    base_commit_sha: z.string().min(7).optional(),
    base_content_hash: z.string().length(64).optional(),
    /** Search keywords the extractor wants indexed in addition to the body. */
    keywords: z.array(z.string().min(1).max(64)).max(32).default([]),
  })
  .superRefine((value, ctx) => {
    if (value.schema_version !== SCHEMA_VERSION) {
      ctx.addIssue({
        code: 'custom',
        path: ['schema_version'],
        message: `unsupported schema_version ${value.schema_version}; this build writes ${SCHEMA_VERSION}`,
      });
    }
    if (value.kind === 'skill' && !value.skill) {
      ctx.addIssue({ code: 'custom', path: ['skill'], message: 'kind=skill requires a `skill` block' });
    }
    if (value.kind !== 'skill' && value.skill) {
      ctx.addIssue({ code: 'custom', path: ['skill'], message: 'the `skill` block is only valid for kind=skill' });
    }
    if (value.revises_skill_id && (value.kind !== 'skill' || value.status !== 'candidate' || !value.base_commit_sha || !value.base_content_hash)) {
      ctx.addIssue({ code: 'custom', path: ['revises_skill_id'], message: 'a revision candidate requires a base commit and content hash' });
    }
    if (value.status === 'superseded' && !value.superseded_by) {
      ctx.addIssue({
        code: 'custom',
        path: ['superseded_by'],
        message: 'status=superseded requires superseded_by',
      });
    }
    if (value.valid_from && value.valid_to && value.valid_to < value.valid_from) {
      ctx.addIssue({ code: 'custom', path: ['valid_to'], message: 'valid_to must not precede valid_from' });
    }
    if (value.valid_to && value.status === 'active') {
      ctx.addIssue({
        code: 'custom',
        path: ['valid_to'],
        message: 'an active record must not have a closed validity window; close it with status=superseded',
      });
    }
    if (value.authority === 'inferred' && value.confidence === 'high' && value.supporting_case_ids.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['supporting_case_ids'],
        message: 'a high-confidence inferred record must cite at least one supporting case',
      });
    }
  });

export type MemoryFrontmatter = z.output<typeof memoryFrontmatterSchema>;

export interface MemoryRecord {
  frontmatter: MemoryFrontmatter;
  body: string;
  /** Repository-relative path of the file this record was read from. */
  path: string;
}

export interface EvidenceRecord {
  evidenceId: string;
  caseId: string;
  source: string;
  sessionId: string;
  rootThreadId: string;
  kind: 'user_message' | 'tool_result';
  authority: Authority;
  toolName?: string;
  verified: boolean;
  eventId?: string;
  ordinal?: number;
  snippet: string;
  sourceHash: string;
  createdAt: string;
}

export const evidenceFrontmatterSchema = z.object({
  evidence_id: z.string().min(4),
  case_id: z.string().min(3),
  schema_version: z.number().int().positive(),
  kind: z.enum(['user_message', 'tool_result']),
  authority: z.enum(AUTHORITIES),
  tool_name: z.string().optional(),
  verified: z.boolean().default(false),
  session_id: z.string().min(1),
  root_thread_id: z.string().min(1),
  event_id: z.string().optional(),
  ordinal: z.number().int().optional(),
  source: z.string().min(1),
  source_hash: z.string().min(1),
  created_at: z.string().min(10),
  sensitivity: z.enum(SENSITIVITIES).default('public'),
});

export type EvidenceFrontmatter = z.output<typeof evidenceFrontmatterSchema>;

export function isActive(record: { frontmatter: MemoryFrontmatter }): boolean {
  return record.frontmatter.status === ACTIVE_STATUS;
}

export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)';
    return `${path}: ${issue.message}`;
  });
}
