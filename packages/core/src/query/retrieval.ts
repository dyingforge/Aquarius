import type { ProjectionStore, MemoryIndexEntry, MemorySearchHit } from '../db/projectionStore.ts';
import type { MemoryRepository, MemorySnapshot } from '../memory/repository.ts';
import type { EvidenceFrontmatter, MemoryRecord } from '../memory/schema.ts';
import { buildSummary, type SummaryBundle } from '../memory/summary.ts';
import { sha256 } from '../util/fsx.ts';
import { nowIso } from '../util/time.ts';
import type { AgentRuntime } from '../agents/runtime.ts';
import type { LoadedMemory, RelatedMemory } from '../agents/contracts.ts';
import { createLogger } from '../util/logger.ts';

const log = createLogger('query');

export interface QueryResponse {
  question: string;
  answer: string;
  memoryIds: string[];
  citations: {
    memoryId: string;
    kind: string;
    title: string;
    path: string;
    authority: string;
    confidence: string;
    cases: string[];
  }[];
  uncertainty: 'none' | 'some' | 'high';
  insufficientEvidence: boolean;
  reason: string;
  notices: string[];
  head: string | null;
  runtime: 'openai' | 'fake';
  retrieved: number;
}

export interface IndexRebuildReport {
  head: string | null;
  entries: number;
  counts: Record<string, number>;
  parseErrors: string[];
}

/**
 * Rebuilds the SQLite FTS projection (and the summary files) from Git HEAD.
 *
 * The projection is disposable: deleting the database loses no memory, and this
 * method restores exactly the retrievable set that Git HEAD describes.
 */
export async function projectFromGit(input: {
  repository: MemoryRepository;
  projection: ProjectionStore;
  head?: string | null;
  /** When provided, the generated summary is returned for inclusion in a commit. */
  summary?: { generatedAt: string };
}): Promise<{ report: IndexRebuildReport; summary: SummaryBundle }> {
  const snapshot = await input.repository.snapshot(input.head);
  const entries: MemoryIndexEntry[] = snapshot.records.map((record) => toIndexEntry(record, snapshot.head));
  input.projection.replaceAll(entries, snapshot.head);
  input.projection.replaceCaseOutcomes(snapshot.outcomes);
  const summary = buildSummary({
    records: snapshot.records,
    evidence: snapshot.evidence,
    generatedAt: input.summary?.generatedAt ?? nowIso(),
    head: snapshot.head,
  });
  return {
    report: {
      head: snapshot.head,
      entries: entries.length,
      counts: input.projection.countByStatus(),
      parseErrors: snapshot.parseErrors,
    },
    summary,
  };
}

export function toIndexEntry(record: MemoryRecord, head: string | null): MemoryIndexEntry {
  const fm = record.frontmatter;
  const searchable = [
    fm.title,
    record.body,
    fm.tags.join(' '),
    fm.keywords.join(' '),
    fm.skill ? [fm.skill.purpose, fm.skill.triggers.join(' '), fm.skill.steps.join(' ')].join(' ') : '',
  ].join('\n');
  return {
    memoryId: fm.id,
    kind: fm.kind,
    status: fm.status,
    path: record.path,
    title: fm.title,
    body: searchable,
    tags: fm.tags,
    caseIds: fm.supporting_case_ids,
    authority: fm.authority,
    confidence: fm.confidence,
    sensitivity: fm.sensitivity,
    supersededBy: fm.superseded_by ?? null,
    validFrom: fm.valid_from ?? null,
    validTo: fm.valid_to ?? null,
    updatedAt: fm.updated_at,
    contentHash: sha256(searchable),
    commitSha: head,
  };
}

/**
 * Progressive retrieval: load the small summary, let FTS narrow the field, let
 * the query agent pick what is actually relevant, and only then load full memory
 * bodies plus the evidence behind them.
 */
export class RetrievalService {
  #repository: MemoryRepository;
  #projection: ProjectionStore;
  #runtime: AgentRuntime;
  #timeZone: string;

  constructor(deps: {
    repository: MemoryRepository;
    projection: ProjectionStore;
    runtime: AgentRuntime;
    timeZone: string;
  }) {
    this.#repository = deps.repository;
    this.#projection = deps.projection;
    this.#runtime = deps.runtime;
    this.#timeZone = deps.timeZone;
  }

  async ask(question: string, options: { limit?: number } = {}): Promise<QueryResponse> {
    const head = await this.#repository.head();
    const summary = await this.#repository.readSummaryFile('memory', head);
    const candidates = this.#projection.search(question, { limit: options.limit ?? 16 });

    const notices: string[] = [];
    if (this.#projection.count() === 0) {
      notices.push('The search index is empty; it may need `aquarius index rebuild`.');
    }
    if (summary.trim() === '') {
      notices.push('No memory summary exists at HEAD yet.');
    }

    if (candidates.length === 0) {
      const answer = await this.#runtime.answer({
        question,
        summary,
        memories: [],
        notices,
      });
      return {
        question,
        answer: answer.answer,
        memoryIds: [],
        citations: [],
        uncertainty: answer.uncertainty,
        insufficientEvidence: true,
        reason: answer.reason || 'No active memory matched the question.',
        notices,
        head,
        runtime: this.#runtime.mode,
        retrieved: 0,
      };
    }

    const selection = await this.#runtime.selectRelevant({
      question,
      summary,
      candidates: candidates.map(toRelatedMemory),
    });
    const byId = new Map(candidates.map((hit) => [hit.memoryId, hit]));
    const selected = selection.selected_memory_ids
      .map((id) => byId.get(id))
      .filter((hit): hit is MemorySearchHit => hit !== undefined);
    const chosen = selected.length > 0 ? selected : candidates.slice(0, 3);

    const memories = await this.loadMemories(chosen.map((hit) => hit.memoryId));
    const answer = await this.#runtime.answer({ question, summary, memories, notices });

    // Only memories that were actually used (and that we really loaded) are cited.
    const citedIds = answer.used_memory_ids.filter((id) => memories.some((memory) => memory.memoryId === id));
    const finalIds = citedIds.length > 0 ? citedIds : memories.map((memory) => memory.memoryId);
    const hitsById = new Map(chosen.map((hit) => [hit.memoryId, hit]));

    return {
      question,
      answer: answer.answer,
      memoryIds: finalIds,
      citations: finalIds.map((id) => {
        const hit = hitsById.get(id);
        return {
          memoryId: id,
          kind: hit?.kind ?? 'unknown',
          title: hit?.title ?? id,
          path: hit?.path ?? '',
          authority: hit?.authority ?? 'unknown',
          confidence: hit?.confidence ?? 'unknown',
          cases: hit?.caseIds ?? [],
        };
      }),
      uncertainty: answer.uncertainty,
      insufficientEvidence: answer.insufficient_evidence || finalIds.length === 0,
      reason: answer.reason,
      notices,
      head,
      runtime: this.#runtime.mode,
      retrieved: candidates.length,
    };
  }

  /** Loads full memory bodies plus the evidence behind their supporting cases. */
  async loadMemories(memoryIds: string[]): Promise<LoadedMemory[]> {
    const snapshot = await this.#repository.snapshot();
    const out: LoadedMemory[] = [];
    for (const memoryId of memoryIds) {
      const record = snapshot.byId.get(memoryId);
      if (!record) continue;
      if (record.frontmatter.status !== 'active') continue;
      const evidence = (record.frontmatter.supporting_case_ids ?? [])
        .flatMap((caseId) => snapshot.evidenceByCase.get(caseId) ?? [])
        .slice(0, 4)
        .map((file) => ({
          evidenceId: file.frontmatter.evidence_id,
          kind: file.frontmatter.kind,
          snippet: file.body.slice(0, 400),
        }));
      out.push({
        memoryId,
        kind: record.frontmatter.kind,
        title: record.frontmatter.title,
        body: record.body,
        tags: record.frontmatter.tags,
        authority: record.frontmatter.authority,
        confidence: record.frontmatter.confidence,
        caseIds: record.frontmatter.supporting_case_ids,
        evidence,
      });
    }
    return out;
  }

  async rebuildIndex(): Promise<IndexRebuildReport> {
    const { report } = await projectFromGit({ repository: this.#repository, projection: this.#projection });
    log.info('index rebuilt', { entries: report.entries });
    return report;
  }

  async listMemories(options: { kind?: string; status?: string; limit?: number } = {}): Promise<MemorySearchHit[]> {
    const rows = this.#projection.list({
      ...(options.kind ? { kind: options.kind as MemoryIndexEntry['kind'] } : {}),
      ...(options.status ? { status: options.status as MemoryIndexEntry['status'] } : {}),
      limit: options.limit ?? 100,
    });
    return rows.map((row) => ({
      memoryId: row.memory_id,
      kind: row.kind as MemoryIndexEntry['kind'],
      status: row.status as MemoryIndexEntry['status'],
      path: row.path,
      title: row.title,
      snippet: '',
      tags: JSON.parse(row.tags) as string[],
      caseIds: JSON.parse(row.case_ids) as string[],
      authority: row.authority as MemoryIndexEntry['authority'],
      confidence: row.confidence as MemoryIndexEntry['confidence'],
      sensitivity: row.sensitivity as MemoryIndexEntry['sensitivity'],
      updatedAt: row.updated_at,
      score: 0,
    }));
  }

  async getMemory(memoryId: string): Promise<{ record: MemoryRecord; evidence: EvidenceFrontmatter[] } | null> {
    const snapshot = await this.#repository.snapshot();
    const record = snapshot.byId.get(memoryId);
    if (!record) return null;
    const evidence = record.frontmatter.supporting_case_ids.flatMap((caseId) =>
      (snapshot.evidenceByCase.get(caseId) ?? []).map((file) => file.frontmatter),
    );
    return { record, evidence };
  }

  async snapshot(): Promise<MemorySnapshot> {
    return this.#repository.snapshot();
  }

  get timeZone(): string {
    return this.#timeZone;
  }
}

export function toRelatedMemory(hit: MemorySearchHit): RelatedMemory {
  return {
    memoryId: hit.memoryId,
    kind: hit.kind,
    status: hit.status,
    title: hit.title,
    snippet: hit.snippet,
    tags: hit.tags,
    authority: hit.authority,
    confidence: hit.confidence,
    caseIds: hit.caseIds,
  };
}
