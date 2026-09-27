import { randomUUID } from 'node:crypto';
import type {
  AgentRuntime,
  AgentRuntimeDescription,
  AnswerInput,
  ConsolidateInput,
  ExtractInput,
  EvaluateSkillInput,
  SelectInput,
  SynthesizeSkillInput,
} from './runtime.ts';
import type {
  ConsolidatorOutput,
  ExtractorOutput,
  Observation,
  QueryOutput,
  SelectionOutput,
  SkillDraft,
} from './contracts.ts';
import { lexicalOverlap, tokenizeForFts } from '../query/ftsText.ts';
import { deriveId } from '../util/ids.ts';
import { looksContradictory } from './contradiction.ts';
import type { SkillTrial } from '../skills/evaluation.ts';

/**
 * Deterministic agent double.
 *
 * It implements the same contracts as the OpenAI Agents SDK runtime using nothing
 * but lexical analysis, so the whole pipeline — ingestion, gates, Git writes,
 * retrieval, corrections, skills — can be exercised end-to-end without network
 * access or an API key. It is explicitly *not* a model: `doctor` reports the
 * runtime mode, and every run is stamped with mode `fake` so a dry-run instance
 * can never be mistaken for a real one.
 */

const PREFERENCE_MARKERS = [
  /我(?:更|还是)?(?:喜欢|偏好|倾向|习惯|通常|一般|总是|一直|不想|不喜欢|讨厌|避免)/,
  /(?:我们|团队)(?:都|一般|通常)(?:用|使用|按)/,
  /请(?:记住|注意)(?:我|我们)/,
  /\b(?:i|we)\s+(?:prefer|like|always|usually|never|avoid|hate)\b/i,
  /\b(?:my|our)\s+(?:preference|convention|rule|standard)\b/i,
  /\bdon't\s+(?:like|want)\b/i,
];

const PROCEDURE_MARKERS = [
  /(?:以后|之后|下次|每次|今后)(?:都)?(?:请|要|需要)/,
  // "以后每次…都…" and similar phrasings where the trigger and the obligation are
  // separated by a short clause.
  /(?:以后|之后|下次|今后)[^。！？]{0,12}?(?:都|请|要|需要|务必)/,
  /(?:务必|一定要|记得)(?:要)?/,
  /(?:流程|步骤|规范|约定)(?:是|如下|这样)/,
  /\bfrom now on\b/i,
  /\bevery time\b/i,
  /\bmake sure to\b/i,
  /\b(?:the|our) (?:workflow|process|convention|checklist) is\b/i,
];

const DURABLE_FACT_MARKERS = [
  /(?:我|我们)(?:是|用|在|负责|维护|使用|基于)/,
  /\b(?:i am|we are|i use|we use|my project|our stack)\b/i,
];

const TEMPORAL_MARKERS = [
  /(?:现在|如今|后来|改成|换成了|不再|之前)/,
  /\b(?:now|no longer|used to|switched to|changed to|these days)\b/i,
];

function matches(patterns: RegExp[], text: string): boolean {
  return patterns.some((pattern) => pattern.test(text));
}

/** Splits an evidence snippet into statement-sized units. */
export function splitStatements(text: string): string[] {
  return text
    .split(/\n{2,}|(?<=[。！？!?.;])\s+|\n(?=[-*#]|\d+\.)/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 8 && part.length <= 800)
    .slice(0, 6);
}

function keywordsOf(text: string, max = 8): string[] {
  const { words, cjk } = tokenizeForFts(text);
  const out = [...new Set([...cjk.flatMap((run) => (run.length > 1 ? [run] : [])), ...words])];
  return out
    .filter((token) => token.length >= 2)
    .sort((a, b) => b.length - a.length)
    .slice(0, max);
}

function clip(text: string, max: number): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max - 1)}…`;
}

export interface FakeRuntimeOptions {
  model?: string;
}

export class FakeAgentRuntime implements AgentRuntime {
  readonly mode = 'fake' as const;
  readonly model: string;

  constructor(options: FakeRuntimeOptions = {}) {
    this.model = options.model ?? 'fake-deterministic-v1';
  }

  describe(): AgentRuntimeDescription {
    return {
      mode: this.mode,
      model: this.model,
      tracing: false,
      toolPolicy: {
        memory_extractor: [],
        memory_consolidator: [],
        memory_query: ['read_memory', 'read_evidence'],
        skill_synthesizer: [],
        skill_evaluator: ['run_typecheck', 'run_lint'],
      },
    };
  }

  // --- MemoryExtractorAgent -------------------------------------------------

  async extract(input: ExtractInput): Promise<ExtractorOutput> {
    const observations: Observation[] = [];
    const featureBag = new Set<string>();

    for (const evidence of input.evidence) {
      if (evidence.kind === 'tool_result') {
        if (!evidence.verified) continue;
        const tool = evidence.toolName ?? 'tool';
        featureBag.add(`tool:${tool}`);
        observations.push({
          type: 'experience',
          title: clip(`${tool} executed successfully in this session`, 120),
          body: clip(
            `A ${tool} invocation completed successfully: ${evidence.snippet}`,
            600,
          ),
          tags: ['tool', tool],
          keywords: keywordsOf(evidence.snippet, 6),
          authority: 'tool_verified',
          confidence: 'high',
          confidence_reason: 'A successful tool result is directly verifiable evidence.',
          sensitivity: 'public',
          evidence_event_ids: [evidence.eventId],
        });
        continue;
      }

      for (const statement of splitStatements(evidence.snippet)) {
        const isPreference = matches(PREFERENCE_MARKERS, statement);
        const isProcedure = !isPreference && matches(PROCEDURE_MARKERS, statement);
        const isDurableFact = !isPreference && !isProcedure && matches(DURABLE_FACT_MARKERS, statement);
        const inferred = !isPreference && !isProcedure && !isDurableFact;

        const type = isPreference ? 'profile' : isProcedure ? 'strategy' : 'experience';
        for (const keyword of keywordsOf(statement, 4)) featureBag.add(keyword);

        observations.push({
          type,
          title: clip(statement.replace(/^[-*#\d.\s]+/, ''), 120),
          body: clip(statement, 800),
          tags: isPreference ? ['preference'] : isProcedure ? ['procedure'] : ['session'],
          keywords: keywordsOf(statement, 6),
          authority: inferred ? 'inferred' : 'user_explicit',
          confidence: inferred ? 'medium' : isDurableFact ? 'high' : 'high',
          confidence_reason: inferred
            ? 'Derived from a user statement without an explicit durable claim.'
            : 'The user stated this directly in the session.',
          sensitivity: /password|token|secret|key|密钥/i.test(statement) ? 'sensitive' : 'public',
          evidence_event_ids: [evidence.eventId],
        });
        break; // one observation per user message keeps the batch bounded
      }
    }

    const deduped = dedupeObservations(observations).slice(0, 8);
    return {
      summary: clip(
        `Session with ${input.evidence.length} evidence item(s) produced ${deduped.length} observation(s).`,
        400,
      ),
      case_features: [...featureBag].map((feature) => clip(feature, 60)).slice(0, 8),
      observations: deduped,
    };
  }

  // --- MemoryConsolidatorAgent ---------------------------------------------

  async consolidate(input: ConsolidateInput): Promise<ConsolidatorOutput> {
    const operations: ConsolidatorOutput['operations'] = [];

    for (const [index, observation] of input.observations.entries()) {
      const best = bestMatch(observation, input.related);
      if (!best) {
        operations.push({
          operation: 'add',
          observation_index: index,
          target_memory_id: null,
          reason: 'No related memory was found for this observation.',
          merged_title: null,
          merged_body: null,
          confidence: observation.confidence,
        });
        continue;
      }

      const target = best.memory;
      if (target.kind !== observation.type) {
        operations.push({
          operation: 'add',
          observation_index: index,
          target_memory_id: null,
          reason: `Closest memory ${target.memoryId} has a different kind (${target.kind}).`,
          merged_title: null,
          merged_body: null,
          confidence: observation.confidence,
        });
        continue;
      }

      const observationText = `${observation.title} ${observation.body}`;
      const targetText = `${target.title} ${target.snippet}`;
      const overlap = best.score;

      // Polarity is checked first: "X" and "not X" are near-identical textually but
      // must never be collapsed into a duplicate.
      const contradiction = looksContradictory(observationText, targetText, overlap);
      if (contradiction.contradictory) {
        operations.push({
          operation: 'conflict',
          observation_index: index,
          target_memory_id: target.memoryId,
          reason: contradiction.reason,
          merged_title: null,
          merged_body: null,
          confidence: observation.confidence,
        });
        continue;
      }

      if (overlap >= 0.85) {
        operations.push({
          operation: 'duplicate',
          observation_index: index,
          target_memory_id: target.memoryId,
          reason: 'The observation restates what the target already says.',
          merged_title: null,
          merged_body: null,
          confidence: observation.confidence,
        });
        continue;
      }

      if (overlap >= 0.35 && matches(TEMPORAL_MARKERS, observationText)) {
        operations.push({
          operation: 'temporal_change',
          observation_index: index,
          target_memory_id: target.memoryId,
          reason: 'The user describes a change over time rather than an error.',
          merged_title: null,
          merged_body: null,
          confidence: observation.confidence,
        });
        continue;
      }

      if (overlap >= 0.55) {
        const merged = mergeTexts(target.snippet, observation.body);
        operations.push({
          operation: 'reinforce',
          observation_index: index,
          target_memory_id: target.memoryId,
          reason: 'The observation adds detail to an existing memory from this case.',
          merged_title: target.title,
          merged_body: merged,
          confidence: 'high',
        });
        continue;
      }

      operations.push({
        operation: 'add',
        observation_index: index,
        target_memory_id: null,
        reason: `Closest memory ${target.memoryId} is only weakly related (${overlap.toFixed(2)}).`,
        merged_title: null,
        merged_body: null,
        confidence: observation.confidence,
      });
    }

    return {
      operations,
      notes: `Evaluated ${input.observations.length} observation(s) against ${input.related.length} related memory record(s).`,
    };
  }

  // --- MemoryQueryAgent -----------------------------------------------------

  async selectRelevant(input: SelectInput): Promise<SelectionOutput> {
    const scored = input.candidates
      .map((candidate) => ({
        candidate,
        score: lexicalOverlap(input.question, `${candidate.title} ${candidate.snippet} ${candidate.tags.join(' ')}`),
      }))
      .sort((a, b) => b.score - a.score);

    const selected = scored.filter((entry) => entry.score > 0).slice(0, 6);
    const fallback = selected.length === 0 ? scored.slice(0, 3) : selected;
    return {
      selected_memory_ids: fallback.map((entry) => entry.candidate.memoryId),
      reason: `Selected ${fallback.length} of ${input.candidates.length} candidates by lexical relevance.`,
    };
  }

  async answer(input: AnswerInput): Promise<QueryOutput> {
    if (input.memories.length === 0) {
      return {
        answer:
          'I do not have any active memory that answers this. Nothing has been promoted that covers the question, so I will not guess.',
        used_memory_ids: [],
        uncertainty: 'high',
        insufficient_evidence: true,
        reason: 'No active memory was retrieved for this question.',
      };
    }

    const lines = input.memories.map(
      (memory) => `- ${memory.title}: ${clip(memory.body, 300)} [${memory.memoryId}]`,
    );
    const notices = input.notices.length > 0 ? `\n\nNotes:\n${input.notices.map((n) => `- ${n}`).join('\n')}` : '';
    const uncertainty = input.notices.length > 0 ? 'some' : input.memories.some((m) => m.confidence !== 'high') ? 'some' : 'none';

    return {
      answer: `Based on current active memory:\n${lines.join('\n')}${notices}`,
      used_memory_ids: input.memories.map((memory) => memory.memoryId),
      uncertainty,
      insufficient_evidence: false,
      reason: `Answered from ${input.memories.length} active memory record(s).`,
    };
  }

  // --- SkillSynthesizerAgent ------------------------------------------------

  async synthesizeSkill(input: SynthesizeSkillInput): Promise<SkillDraft> {
    const name = uniqueSkillName(skillNameSeed(input.strategy.title), input.existingSkillNames);
    const evidenceSnippets = input.cases
      .flatMap((caseRecord) => caseRecord.evidence.map((item) => item.snippet))
      .map((snippet) => clip(snippet, 200))
      .slice(0, 6);

    return {
      name,
      purpose: clip(`Apply the "${input.strategy.title}" working strategy consistently.`, 380),
      triggers: [
        clip(input.strategy.title, 160),
        ...input.cases
          .flatMap((caseRecord) => caseRecord.features)
          .slice(0, 3)
          .map((feature) => clip(`Task mentions ${feature}`, 160)),
      ],
      inputs: ['The user request or task description', 'The relevant project context'],
      outputs: ['A result produced by following the recorded strategy steps'],
      steps: [
        `Confirm the task matches the trigger: ${clip(input.strategy.title, 120)}.`,
        clip(input.strategy.body, 400),
        ...(input.cases.some((item) => item.outcome === 'failure') ? ['If a required check fails, stop and report the failing check before release.'] : []),
        'Verify the outcome before reporting it, and state any assumption that was needed.',
      ],
      limitations: [
        'Only applies when the task matches the recorded trigger conditions.',
        `Derived from ${input.cases.length} observed cases and may not generalize further.`,
      ],
      // Declare the tools the evidence shows were actually used, so the static
      // publish gate does not have to quarantine an otherwise valid candidate.
      tool_dependencies: [
        ...new Set(
          input.cases
            .flatMap((caseRecord) => caseRecord.evidence.map((item) => item.tool))
            .filter((tool): tool is string => typeof tool === 'string' && tool !== ''),
        ),
      ].sort(),
      rationale: `Synthesized from ${input.cases.length} independent cases. Evidence: ${evidenceSnippets.join(' | ') || 'none provided'}`,
    };
  }

  async evaluateSkill(input: EvaluateSkillInput): Promise<SkillTrial> {
    const applicable = /release|发布/i.test(input.task.task) && !/draft|草稿|不要发布/i.test(input.task.task);
    const useSkill = Boolean(input.skillText && applicable && /typecheck/i.test(input.skillText) && /lint/i.test(input.skillText));
    const actions: SkillTrial['actions'] = useSkill ? ['typecheck', 'lint'] : [];
    return {
      use_skill: useSkill,
      actions,
      reported_failure: useSkill && actions.some((action) => input.task.tool_outcomes[action] === 'fail'),
      stops_on_failure: Boolean(useSkill && input.skillText && /stop and report/i.test(input.skillText)),
    };
  }
}

function dedupeObservations(observations: Observation[]): Observation[] {
  const byKey = new Map<string, Observation>();
  for (const observation of observations) {
    const key = `${observation.type}:${observation.title.toLowerCase()}`;
    if (!byKey.has(key)) byKey.set(key, observation);
  }
  return [...byKey.values()];
}

function bestMatch(
  observation: Observation,
  related: { memoryId: string; kind: string; title: string; snippet: string; tags: string[] }[],
): { memory: (typeof related)[number]; score: number } | null {
  let best: { memory: (typeof related)[number]; score: number } | null = null;
  const observationText = `${observation.title} ${observation.body} ${observation.keywords.join(' ')}`;
  for (const memory of related) {
    const score = lexicalOverlap(observationText, `${memory.title} ${memory.snippet} ${memory.tags.join(' ')}`);
    if (!best || score > best.score) best = { memory, score };
  }
  return best && best.score > 0 ? best : null;
}

function mergeTexts(existing: string, addition: string): string {
  const existingCompact = existing.replace(/\s+/g, ' ').trim();
  const additionCompact = addition.replace(/\s+/g, ' ').trim();
  if (existingCompact.includes(additionCompact)) return clip(existingCompact, 1900);
  return clip(`${existingCompact}\n\n${additionCompact}`, 1900);
}

/**
 * Prefers Latin words from the strategy title because skill names are kebab-case
 * identifiers; a fully non-Latin title falls back to a stable derived id.
 */
function skillNameSeed(title: string): string {
  const latin = (title.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((word) => word.length >= 3);
  if (latin.length > 0) return latin.slice(0, 4).join('-');
  return `strategy-${deriveId('sk', title).slice(3, 11).toLowerCase()}`;
}

function uniqueSkillName(base: string, existing: string[]): string {
  const safeBase = /^[a-z0-9]/.test(base) ? base : `skill-${base}`;
  const taken = new Set(existing);
  if (!taken.has(safeBase)) return safeBase.slice(0, 64);
  for (let index = 2; index < 50; index += 1) {
    const candidate = `${safeBase}-${index}`.slice(0, 64);
    if (!taken.has(candidate)) return candidate;
  }
  return `${safeBase}-${randomUUID().slice(0, 6)}`.slice(0, 64);
}
