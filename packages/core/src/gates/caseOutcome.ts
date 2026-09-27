import { z } from 'zod';

/** 用户确认针对一次策略尝试的任务结果；来源证据本身不代表成功。 */
export const caseOutcomeSchema = z.object({
  outcome_id: z.string().min(4),
  case_id: z.string().min(4),
  strategy_id: z.string().min(4),
  attempt_id: z.string().min(1),
  result: z.enum(['success', 'failure', 'unknown']),
  rule_id: z.literal('user-confirmed-task-result-v1'),
  evidence_ids: z.array(z.string().min(4)).min(1).max(32),
  source_event_ids: z.array(z.string().min(1)).max(32),
  task_features: z.array(z.string().min(1).max(60)).max(16),
  recorded_by: z.string().min(1).max(120),
  recorded_at: z.string().min(10),
  supersedes: z.string().min(4).nullable(),
});
export type CaseOutcome = z.output<typeof caseOutcomeSchema>;

/** 矛盾的未撤销结果一律视为 unknown；修正必须显式指向旧结果。 */
export function effectiveCaseOutcome(outcomes: CaseOutcome[], caseId: string, strategyId: string): 'success' | 'failure' | 'unknown' {
  const matching = outcomes.filter((item) => item.case_id === caseId && item.strategy_id === strategyId);
  const superseded = new Set(matching.map((item) => item.supersedes).filter((id): id is string => id !== null));
  const current = matching.filter((item) => !superseded.has(item.outcome_id));
  if (current.length === 0) return 'unknown';
  const attempts = new Set(current.map((item) => item.attempt_id));
  if (attempts.size !== current.length) return 'unknown';
  if (current.every((item) => item.result === 'success')) return 'success';
  if (current.every((item) => item.result === 'failure')) return 'failure';
  return 'unknown';
}
