import { z } from 'zod';

/** 首版使用受控工具替身评估声明式发布检查，不执行真实命令。 */
export const trialSchema = z.object({
  use_skill: z.boolean(),
  actions: z.array(z.enum(['typecheck', 'lint'])).max(4),
  reported_failure: z.boolean(),
  stops_on_failure: z.boolean(),
});
export type SkillTrial = z.output<typeof trialSchema>;

export const evaluationCaseSchema = z.object({
  id: z.string().min(3).max(80),
  source_case_id: z.string().min(4).nullable(),
  task: z.string().min(8).max(800),
  applicable: z.boolean(),
  expected_actions: z.array(z.enum(['typecheck', 'lint'])).max(2),
  tool_outcomes: z.object({ typecheck: z.enum(['pass', 'fail']), lint: z.enum(['pass', 'fail']) }),
  critical: z.boolean(),
  requires_stop_on_failure: z.boolean().default(false),
});
export type EvaluationCase = z.output<typeof evaluationCaseSchema>;

export const evaluationSuiteSchema = z.object({
  strategy_id: z.string().min(4),
  version: z.number().int().positive(),
  contract: z.literal('release-checklist-v1'),
  cases: z.array(evaluationCaseSchema).min(3).max(12),
}).superRefine((suite, ctx) => {
  if (!suite.cases.some((item) => item.applicable && item.tool_outcomes.typecheck === 'pass' && item.tool_outcomes.lint === 'pass')) {
    ctx.addIssue({ code: 'custom', message: 'suite needs a passing applicable task' });
  }
  if (!suite.cases.some((item) => !item.applicable)) ctx.addIssue({ code: 'custom', message: 'suite needs a non-applicable task' });
  if (!suite.cases.some((item) => item.applicable && Object.values(item.tool_outcomes).includes('fail'))) {
    ctx.addIssue({ code: 'custom', message: 'suite needs a failing tool outcome' });
  }
  if (new Set(suite.cases.map((item) => item.id)).size !== suite.cases.length) {
    ctx.addIssue({ code: 'custom', message: 'case IDs must be unique' });
  }
});
export type EvaluationSuite = z.output<typeof evaluationSuiteSchema>;

export const evaluationReportSchema = z.object({
  report_id: z.string().min(4),
  candidate_id: z.string().min(4),
  candidate_hash: z.string().length(64),
  baseline_skill_id: z.string().min(4).nullable(),
  baseline_commit_sha: z.string().min(7).nullable(),
  baseline_hash: z.string().length(64).nullable(),
  suite_hash: z.string().length(64),
  suite_version: z.number().int().positive(),
  model: z.string().min(1),
  runtime: z.enum(['openai', 'fake']),
  contract: z.literal('release-checklist-v1'),
  scope: z.literal('controlled-tool-simulation; no real commands'),
  budget: z.object({ max_turns: z.number().int().positive(), max_output_tokens: z.number().int().positive(), run_timeout_ms: z.number().int().positive() }),
  status: z.enum(['pass', 'fail', 'insufficient_evidence']),
  cases: z.array(z.object({
    id: z.string(),
    candidate: trialSchema,
    baseline: trialSchema,
    candidate_pass: z.boolean(),
    baseline_pass: z.boolean(),
    critical: z.boolean(),
  })),
  created_at: z.string().min(10),
});
export type EvaluationReport = z.output<typeof evaluationReportSchema>;

export function passesEvaluationCase(fixture: EvaluationCase, trial: SkillTrial): boolean {
  if (!fixture.applicable) return !trial.use_skill && trial.actions.length === 0;
  if (!trial.use_skill) return false;
  if (trial.actions.join(',') !== fixture.expected_actions.join(',')) return false;
  const hasFailure = fixture.expected_actions.some((action) => fixture.tool_outcomes[action] === 'fail');
  return trial.reported_failure === hasFailure && (!fixture.requires_stop_on_failure || trial.stops_on_failure);
}

/** 门禁在运行前固定，不能由被测模型修改阈值或自行宣布通过。 */
export function judgeEvaluation(cases: EvaluationReport['cases'], runtime: 'openai' | 'fake'): EvaluationReport['status'] {
  if (runtime === 'fake' || cases.length < 3) return 'insufficient_evidence';
  if (cases.some((item) => !item.candidate_pass && item.critical)) return 'fail';
  if (cases.some((item) => item.baseline_pass && !item.candidate_pass)) return 'fail';
  if (cases.some((item) => !item.candidate_pass)) return 'fail';
  if (!cases.some((item) => item.candidate_pass && !item.baseline_pass)) return 'fail';
  return 'pass';
}
