import { AquariusError } from '../errors.ts';
import type { AgentBudgets } from '../config.ts';
import { createLogger, type Logger } from '../util/logger.ts';
import type {
  ConsolidatorOutput,
  EvidenceCandidate,
  ExtractorOutput,
  LoadedMemory,
  Observation,
  QueryOutput,
  RelatedMemory,
  SelectionOutput,
  SkillDraft,
} from './contracts.ts';
import type { CaseRecord } from '../db/sessionStore.ts';
import type { SanitizedSession } from '../sources/adapter.ts';
import type { EvaluationCase, SkillTrial } from '../skills/evaluation.ts';
import type { SkillSpec } from '../memory/schema.ts';

const log = createLogger('agents');

export interface ExtractInput {
  session: SanitizedSession;
  evidence: EvidenceCandidate[];
  caseTitle: string | null;
}

export interface ConsolidateInput {
  observations: Observation[];
  related: RelatedMemory[];
  caseId: string;
  caseFeatures: string[];
}

export interface SelectInput {
  question: string;
  summary: string;
  candidates: RelatedMemory[];
}

export interface AnswerInput {
  question: string;
  summary: string;
  memories: LoadedMemory[];
  /** Notices about unresolved conflicts or thin evidence, produced deterministically. */
  notices: string[];
}

export interface SynthesizeSkillInput {
  strategy: LoadedMemory;
  cases: {
    caseId: string;
    outcome?: 'success' | 'failure';
    title: string | null;
    features: string[];
    evidence: { kind: string; tool?: string | null; snippet: string }[];
  }[];
  existingSkillNames: string[];
  baselineSkill?: SkillSpec | null;
}

export interface EvaluateSkillInput {
  task: EvaluationCase;
  skillText: string | null;
}

export interface AgentRuntimeDescription {
  mode: 'openai' | 'fake';
  model: string;
  tracing: boolean;
  /** Tools each agent is allowed to use; the evaluator only receives isolated stubs. */
  toolPolicy: Record<string, string[]>;
}

export interface AgentRunMetric {
  agent: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  model: string;
  outcome: 'ok' | 'error' | 'budget_exceeded';
  errorCategory?: string;
}

/**
 * The complete surface through which Aquarius talks to a model. Agents never
 * receive a repository handle, a shell or a file path they could act on: the
 * runtime only ever returns validated proposals.
 */
export interface AgentRuntime {
  readonly mode: 'openai' | 'fake';
  readonly model: string;
  extract(input: ExtractInput): Promise<ExtractorOutput>;
  consolidate(input: ConsolidateInput): Promise<ConsolidatorOutput>;
  selectRelevant(input: SelectInput): Promise<SelectionOutput>;
  answer(input: AnswerInput): Promise<QueryOutput>;
  synthesizeSkill(input: SynthesizeSkillInput): Promise<SkillDraft>;
  evaluateSkill(input: EvaluateSkillInput): Promise<SkillTrial>;
  describe(): AgentRuntimeDescription;
}

export type MetricSink = (metric: AgentRunMetric) => void;

/**
 * Applies the per-run budgets from configuration to every agent call, so a
 * single slow or looping run can never hold the service hostage.
 */
export class BudgetedAgentRuntime implements AgentRuntime {
  readonly #inner: AgentRuntime;
  readonly #budgets: AgentBudgets;
  readonly #sink: MetricSink;
  readonly #logger: Logger;

  constructor(inner: AgentRuntime, budgets: AgentBudgets, sink?: MetricSink) {
    this.#inner = inner;
    this.#budgets = budgets;
    this.#sink = sink ?? defaultMetricSink;
    this.#logger = log;
  }

  get mode(): 'openai' | 'fake' {
    return this.#inner.mode;
  }

  get model(): string {
    return this.#inner.model;
  }

  describe(): AgentRuntimeDescription {
    return this.#inner.describe();
  }

  extract(input: ExtractInput): Promise<ExtractorOutput> {
    return this.#guarded('memory_extractor', () => this.#inner.extract(input));
  }

  consolidate(input: ConsolidateInput): Promise<ConsolidatorOutput> {
    return this.#guarded('memory_consolidator', () => this.#inner.consolidate(input));
  }

  selectRelevant(input: SelectInput): Promise<SelectionOutput> {
    return this.#guarded('memory_query.select', () => this.#inner.selectRelevant(input));
  }

  answer(input: AnswerInput): Promise<QueryOutput> {
    return this.#guarded('memory_query.answer', () => this.#inner.answer(input));
  }

  synthesizeSkill(input: SynthesizeSkillInput): Promise<SkillDraft> {
    return this.#guarded('skill_synthesizer', () => this.#inner.synthesizeSkill(input));
  }

  evaluateSkill(input: EvaluateSkillInput): Promise<SkillTrial> {
    return this.#guarded('skill_evaluator', () => this.#inner.evaluateSkill(input));
  }

  async #guarded<T>(agent: string, fn: () => Promise<T>): Promise<T> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#budgets.runTimeoutMs);
    try {
      const result = await fn();
      this.#record({
        agent,
        latencyMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
        model: this.#inner.model,
        outcome: 'ok',
      });
      return result;
    } catch (error) {
      const aborted =
        (error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError')) ||
        controller.signal.aborted;
      const code = aborted ? 'agent_budget_exceeded' : 'job_failed';
      this.#record({
        agent,
        latencyMs: Date.now() - startedAt,
        inputTokens: 0,
        outputTokens: 0,
        model: this.#inner.model,
        outcome: aborted ? 'budget_exceeded' : 'error',
        errorCategory: error instanceof Error ? error.name : 'unknown',
      });
      if (aborted) {
        throw new AquariusError(
          'agent_budget_exceeded',
          `Agent ${agent} exceeded its ${this.#budgets.runTimeoutMs}ms budget.`,
          {
            actionable: 'Raise the budget in the Aquarius config, or ingest a smaller batch.',
            cause: error,
          },
        );
      }
      throw error instanceof AquariusError
        ? error
        : new AquariusError(code, `Agent ${agent} failed: ${(error as Error).message}`, { cause: error });
    } finally {
      clearTimeout(timer);
    }
  }

  #record(metric: AgentRunMetric): void {
    this.#sink(metric);
    this.#logger.info('agent run', {
      agent: metric.agent,
      latencyMs: metric.latencyMs,
      model: metric.model,
      outcome: metric.outcome,
      ...(metric.errorCategory ? { errorCategory: metric.errorCategory } : {}),
    });
  }

  get budgets(): AgentBudgets {
    return this.#budgets;
  }
}

function defaultMetricSink(metric: AgentRunMetric): void {
  log.debug('agent metric', {
    agent: metric.agent,
    latencyMs: metric.latencyMs,
    outcome: metric.outcome,
  });
}

export function caseSummary(caseRecord: CaseRecord): string {
  return `case ${caseRecord.caseId} (${caseRecord.title ?? 'untitled'}), features: ${caseRecord.taskFeatures.join(', ') || 'none'}`;
}
