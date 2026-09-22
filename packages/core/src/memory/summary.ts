import type { MemoryRecord } from './schema.ts';
import type { StoredEvidenceFile } from './repository.ts';
import { SUMMARY_FILES } from './paths.ts';
import { truncate } from '../util/fsx.ts';

/**
 * Progressive context loading, layer 1.
 *
 * `MEMORY.md` must stay small enough to load on every question, so it carries
 * counts, the highest-value active items and nothing else. Profile and strategy
 * digests are separate files with their own budgets.
 */

const MEMORY_MD_BUDGET = 6_000;
const DIGEST_BUDGET = 8_000;

export interface SummaryBundle {
  files: { path: string; content: string }[];
  counts: Record<string, number>;
  generatedAt: string;
}

function isActive(record: MemoryRecord): boolean {
  return record.frontmatter.status === 'active';
}

function byConfidenceThenRecency(a: MemoryRecord, b: MemoryRecord): number {
  const rank = { high: 0, medium: 1, low: 2 } as const;
  const diff = rank[a.frontmatter.confidence] - rank[b.frontmatter.confidence];
  if (diff !== 0) return diff;
  return (b.frontmatter.updated_at ?? '').localeCompare(a.frontmatter.updated_at ?? '');
}

function bullet(record: MemoryRecord, bodyLimit: number): string {
  const cases = record.frontmatter.supporting_case_ids.length;
  const caseNote = cases > 0 ? ` _(cases: ${cases})_` : '';
  const oneLine = truncate(record.body.replace(/\s+/g, ' ').trim(), bodyLimit);
  return `- **${record.frontmatter.title}** — ${oneLine}${caseNote} \`${record.frontmatter.id}\``;
}

function section(title: string, lines: string[]): string {
  if (lines.length === 0) return `## ${title}\n\n_None yet._\n`;
  return `## ${title}\n\n${lines.join('\n')}\n`;
}

function fit(budget: number, chunks: string[]): string[] {
  const out: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (used + chunk.length > budget) break;
    out.push(chunk);
    used += chunk.length;
  }
  return out;
}

export function buildSummary(input: {
  records: MemoryRecord[];
  evidence: StoredEvidenceFile[];
  generatedAt: string;
  head: string | null;
}): SummaryBundle {
  const active = input.records.filter(isActive);
  const profile = active.filter((record) => record.frontmatter.kind === 'profile').sort(byConfidenceThenRecency);
  const strategies = active.filter((record) => record.frontmatter.kind === 'strategy').sort(byConfidenceThenRecency);
  const experiences = active.filter((record) => record.frontmatter.kind === 'experience').sort(byConfidenceThenRecency);
  const candidates = input.records.filter(
    (record) => record.frontmatter.status === 'candidate' && record.frontmatter.kind !== 'skill',
  );

  const header = [
    '# Aquarius memory summary',
    '',
    `Generated: ${input.generatedAt}`,
    `HEAD: ${input.head ?? '(unborn)'}`,
    `Active memories: ${active.length} (profile ${profile.length}, strategy ${strategies.length}, experience ${experiences.length})`,
    `Pending candidates: ${candidates.length}`,
    '',
  ].join('\n');

  const body = [
    section('Profile', fit(MEMORY_MD_BUDGET / 3, profile.map((record) => bullet(record, 160)))),
    section('Strategies', fit(MEMORY_MD_BUDGET / 3, strategies.map((record) => bullet(record, 160)))),
    section('Recent experiences', fit(MEMORY_MD_BUDGET / 3, experiences.slice(0, 12).map((record) => bullet(record, 140)))),
  ].join('\n');

  const memoryMd = `${header}${body}`;
  const profileMd = [
    '# Active profile',
    '',
    `Generated: ${input.generatedAt}`,
    '',
    fit(DIGEST_BUDGET, profile.map((record) => `${bullet(record, 400)}\n`)).join('\n') || '_None yet._',
    '',
  ].join('\n');
  const strategiesMd = [
    '# Active strategies',
    '',
    `Generated: ${input.generatedAt}`,
    '',
    fit(DIGEST_BUDGET, strategies.map((record) => `${bullet(record, 400)}\n`)).join('\n') || '_None yet._',
    '',
  ].join('\n');

  return {
    files: [
      { path: SUMMARY_FILES.memory, content: memoryMd },
      { path: SUMMARY_FILES.profile, content: profileMd },
      { path: SUMMARY_FILES.strategies, content: strategiesMd },
    ],
    counts: {
      active: active.length,
      profile: profile.length,
      strategy: strategies.length,
      experience: experiences.length,
      candidate: candidates.length,
      evidence: input.evidence.length,
      total: input.records.length,
    },
    generatedAt: input.generatedAt,
  };
}
