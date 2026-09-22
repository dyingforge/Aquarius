import type { MemoryFrontmatter, MemoryKind, MemoryStatus } from './schema.ts';
import { monthKey, yearKey, DEFAULT_TIME_ZONE } from '../util/time.ts';

/**
 * Memory tree layout (PLAN §5). The path is derived from kind + status so that
 * "what the answering agent may read" is a property of the tree, not of a query:
 *
 *   summary/MEMORY.md, summary/profile.md, summary/strategies.md
 *   active/profile/…, active/experiences/YYYY/MM/…, active/strategies/…
 *   candidates/profile/…, candidates/strategies/…
 *   evidence/…, reviews/…, skills/{candidates,published,retired}/…, audit/…
 */

export const SUMMARY_FILES = {
  memory: 'summary/MEMORY.md',
  profile: 'summary/profile.md',
  strategies: 'summary/strategies.md',
} as const;

export const TREE_DIRECTORIES = [
  'summary',
  'active/profile',
  'active/experiences',
  'active/strategies',
  'candidates/profile',
  'candidates/strategies',
  'archive/profile',
  'archive/experiences',
  'archive/strategies',
  'evidence',
  'reviews',
  'skills/candidates',
  'skills/published',
  'skills/retired',
  'audit',
] as const;

export const REPO_README = 'README.md';

/** Statuses that leave the current view but stay readable for audit. */
const ARCHIVED_STATUSES: ReadonlySet<MemoryStatus> = new Set(['superseded', 'forgotten', 'retired', 'rejected']);

export function memoryPath(
  frontmatter: Pick<MemoryFrontmatter, 'id' | 'kind' | 'status' | 'created_at'>,
  timeZone: string = DEFAULT_TIME_ZONE,
): string {
  const { id, kind, status, created_at } = frontmatter;
  const createdAt = new Date(created_at);
  const day = Number.isNaN(createdAt.getTime()) ? new Date() : createdAt;

  if (kind === 'skill') return skillPath(id, status);

  const bucket: 'active' | 'candidates' | 'archive' =
    status === 'active' ? 'active' : ARCHIVED_STATUSES.has(status) ? 'archive' : 'candidates';

  switch (kind) {
    case 'experience': {
      const prefix = bucket === 'active' ? 'active/experiences' : `${bucket}/experiences`;
      return `${prefix}/${yearKey(day, timeZone)}/${monthKey(day, timeZone)}/${id}.md`;
    }
    case 'profile':
      return `${bucket}/profile/${id}.md`;
    case 'strategy':
      return `${bucket}/strategies/${id}.md`;
    default: {
      const exhaustive: never = kind;
      throw new Error(`Unsupported memory kind: ${String(exhaustive)}`);
    }
  }
}

/**
 * Skills live in their own lifecycle directories regardless of `status`, because
 * publication is a separate gate from memory promotion.
 */
export function skillPath(id: string, status: MemoryStatus | 'candidate'): string {
  switch (status) {
    case 'active':
      return `skills/published/${id}.md`;
    case 'retired':
    case 'forgotten':
      return `skills/retired/${id}.md`;
    case 'rejected':
      return `skills/retired/${id}.md`;
    default:
      return `skills/candidates/${id}.md`;
  }
}

export function evidencePath(caseId: string, evidenceId: string): string {
  return `evidence/${caseId}/${evidenceId}.md`;
}

export function reviewPath(reviewId: string): string {
  return `reviews/${reviewId}.md`;
}

export function auditPath(day: string, jobId: string): string {
  return `audit/${day}/${jobId}.md`;
}

export function isActivePath(path: string): boolean {
  return path.startsWith('active/') || path.startsWith('summary/');
}

export function isCandidatePath(path: string): boolean {
  return path.startsWith('candidates/') || path.startsWith('skills/candidates/');
}

export function isSkillPath(path: string): boolean {
  return path.startsWith('skills/');
}

/** Anything outside these prefixes is never readable by the query agent. */
export const QUERY_READABLE_PREFIXES = ['summary/', 'active/', 'evidence/'] as const;

export function isQueryReadablePath(path: string): boolean {
  return QUERY_READABLE_PREFIXES.some((prefix) => path.startsWith(prefix));
}

export function kindFromPath(path: string): MemoryKind | null {
  if (path.startsWith('active/profile/') || path.startsWith('candidates/profile/')) return 'profile';
  if (path.startsWith('active/experiences/') || path.startsWith('candidates/experiences/')) return 'experience';
  if (path.startsWith('active/strategies/') || path.startsWith('candidates/strategies/')) return 'strategy';
  if (path.startsWith('skills/')) return 'skill';
  return null;
}

export function repoReadme(): string {
  return `# Aquarius memory repository

This repository is the canonical source of truth for Aquarius long-term memory.
It is written only by the Aquarius service through validated, committed changes.

- \`summary/\` — small, always-loaded digests (\`MEMORY.md\`, \`profile.md\`, \`strategies.md\`)
- \`active/\` — memories that are currently true
- \`candidates/\` — memories that are not yet promoted, plus quarantined ones
- \`archive/\` — memories that left the current view (superseded, forgotten, retired, rejected)
- \`evidence/\` — redacted supporting evidence fragments referenced by memories
- \`reviews/\` — user decisions recorded as auditable files
- \`skills/\` — skill candidates, published skills and retired skills
- \`audit/\` — per-job ingestion and mutation audit records

Git history is for human audit and recovery only. It is never handed to a model.
`;
}
