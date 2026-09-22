import { z } from 'zod';

/**
 * Structured I/O contracts for the four bounded agents. Every agent output is
 * validated with these schemas before any deterministic gate looks at it: a
 * model can propose, but only validated data can reach a gate.
 */

export const OBSERVATION_TYPES = ['experience', 'profile', 'strategy'] as const;
export type ObservationType = (typeof OBSERVATION_TYPES)[number];

export const observationSchema = z.object({
  type: z.enum(OBSERVATION_TYPES),
  title: z.string().min(3).max(160),
  body: z.string().min(3).max(2000),
  tags: z.array(z.string().min(1).max(40)).max(8).default([]),
  keywords: z.array(z.string().min(1).max(60)).max(16).default([]),
  /** `user_explicit` and `tool_verified` must be justified by the cited evidence. */
  authority: z.enum(['user_explicit', 'tool_verified', 'inferred']),
  confidence: z.enum(['high', 'medium', 'low']),
  confidence_reason: z.string().min(3).max(300),
  sensitivity: z.enum(['public', 'personal', 'sensitive']).default('public'),
  /** Event IDs from the sanitized session that this observation rests on. */
  evidence_event_ids: z.array(z.string().min(1)).min(1).max(32),
});
export type Observation = z.output<typeof observationSchema>;

export const extractorOutputSchema = z.object({
  summary: z.string().min(3).max(600),
  case_features: z.array(z.string().min(2).max(60)).max(8).default([]),
  observations: z.array(observationSchema).max(12).default([]),
});
export type ExtractorOutput = z.output<typeof extractorOutputSchema>;

export const CONSOLIDATION_OPERATIONS = [
  'add',
  'reinforce',
  'duplicate',
  'conflict',
  'temporal_change',
  'supersede',
  'noop',
] as const;
export type ConsolidationOperationName = (typeof CONSOLIDATION_OPERATIONS)[number];

export const consolidationOperationSchema = z.object({
  operation: z.enum(CONSOLIDATION_OPERATIONS),
  /** Index into the observation array the consolidator received. */
  observation_index: z.number().int().min(0),
  /** Required for every operation that touches an existing memory. */
  target_memory_id: z.string().min(3).nullable().default(null),
  reason: z.string().min(3).max(400),
  /** Optional merged text when strengthening an existing memory. */
  merged_title: z.string().min(3).max(160).nullable().default(null),
  merged_body: z.string().min(3).max(2000).nullable().default(null),
  confidence: z.enum(['high', 'medium', 'low']),
});
export type ConsolidationOperation = z.output<typeof consolidationOperationSchema>;

export const consolidatorOutputSchema = z.object({
  operations: z.array(consolidationOperationSchema).max(24).default([]),
  notes: z.string().max(1000).default(''),
});
export type ConsolidatorOutput = z.output<typeof consolidatorOutputSchema>;

export const selectionOutputSchema = z.object({
  selected_memory_ids: z.array(z.string().min(3)).max(12).default([]),
  reason: z.string().max(500).default(''),
});
export type SelectionOutput = z.output<typeof selectionOutputSchema>;

export const queryOutputSchema = z.object({
  answer: z.string().min(1).max(6000),
  /** Memory IDs actually used. Empty is allowed when evidence is missing. */
  used_memory_ids: z.array(z.string().min(3)).max(24).default([]),
  uncertainty: z.enum(['none', 'some', 'high']).default('none'),
  insufficient_evidence: z.boolean().default(false),
  reason: z.string().max(600).default(''),
});
export type QueryOutput = z.output<typeof queryOutputSchema>;

export const skillDraftSchema = z.object({
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
  tool_dependencies: z.array(z.string().min(1)).max(24).default([]),
  rationale: z.string().min(3).max(600),
});
export type SkillDraft = z.output<typeof skillDraftSchema>;

/** A candidate memory handed to the consolidator or the selector. */
export interface RelatedMemory {
  memoryId: string;
  kind: 'experience' | 'profile' | 'strategy' | 'skill';
  status: string;
  title: string;
  snippet: string;
  tags: string[];
  authority: string;
  confidence: string;
  caseIds: string[];
}

/** A memory resolved for answering, together with its supporting material. */
export interface LoadedMemory {
  memoryId: string;
  kind: 'experience' | 'profile' | 'strategy' | 'skill';
  title: string;
  body: string;
  tags: string[];
  authority: string;
  confidence: string;
  caseIds: string[];
  evidence: { evidenceId: string; kind: string; snippet: string }[];
}

/** Evidence handed to the extractor, already redacted. */
export interface EvidenceCandidate {
  evidenceId: string;
  eventId: string;
  kind: 'user_message' | 'tool_result';
  authority: 'user_explicit' | 'tool_verified';
  toolName: string | null;
  verified: boolean;
  snippet: string;
}
