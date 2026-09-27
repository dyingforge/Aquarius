import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { AquariusError } from '../errors.ts';
import {
  evidenceFrontmatterSchema,
  formatIssues,
  memoryFrontmatterSchema,
  type EvidenceFrontmatter,
  type MemoryFrontmatter,
  type MemoryRecord,
} from './schema.ts';

const DELIMITER = '---';

export interface FrontmatterDocument<T> {
  frontmatter: T;
  body: string;
}

/** Splits a `---`-delimited Markdown document. Returns null when there is no frontmatter. */
export function splitFrontmatter(text: string): { yamlSource: string; body: string } | null {
  const normalized = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  if (!normalized.startsWith(`${DELIMITER}\n`)) return null;
  const end = normalized.indexOf(`\n${DELIMITER}`, DELIMITER.length);
  if (end === -1) return null;
  const yamlSource = normalized.slice(DELIMITER.length + 1, end);
  let body = normalized.slice(end + DELIMITER.length + 1);
  if (body.startsWith('\n')) body = body.slice(1);
  return { yamlSource, body: body.replace(/\s+$/, '') };
}

function serializeDocument(frontmatter: Record<string, unknown>, body: string): string {
  const yamlSource = stringifyYaml(frontmatter, {
    lineWidth: 0,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
    sortMapEntries: false,
  }).replace(/\s+$/, '');
  const trimmedBody = body.replace(/\s+$/, '');
  return `${DELIMITER}\n${yamlSource}\n${DELIMITER}\n\n${trimmedBody}\n`;
}

export function serializeMemory(record: { frontmatter: MemoryFrontmatter; body: string }): string {
  return serializeDocument(orderFrontmatter(record.frontmatter), record.body);
}

/** Keeps a stable, human-friendly key order in the repository. */
function orderFrontmatter(frontmatter: MemoryFrontmatter): Record<string, unknown> {
  const ordered: Record<string, unknown> = {
    id: frontmatter.id,
    kind: frontmatter.kind,
    status: frontmatter.status,
    schema_version: frontmatter.schema_version,
    title: frontmatter.title,
    tags: frontmatter.tags,
    created_at: frontmatter.created_at,
    updated_at: frontmatter.updated_at,
    valid_from: frontmatter.valid_from ?? null,
    authority: frontmatter.authority,
    confidence: frontmatter.confidence,
    confidence_reason: frontmatter.confidence_reason,
    supporting_case_ids: frontmatter.supporting_case_ids,
    contradicting_case_ids: frontmatter.contradicting_case_ids,
    provenance: frontmatter.provenance,
    sensitivity: frontmatter.sensitivity,
  };
  if (frontmatter.valid_to) ordered.valid_to = frontmatter.valid_to;
  if (frontmatter.supersedes.length > 0) ordered.supersedes = frontmatter.supersedes;
  if (frontmatter.superseded_by) ordered.superseded_by = frontmatter.superseded_by;
  if (frontmatter.review_flags.length > 0) ordered.review_flags = frontmatter.review_flags;
  if (frontmatter.keywords.length > 0) ordered.keywords = frontmatter.keywords;
  if (frontmatter.skill) ordered.skill = frontmatter.skill;
  if (frontmatter.skill_version) ordered.skill_version = frontmatter.skill_version;
  if (frontmatter.revises_skill_id) ordered.revises_skill_id = frontmatter.revises_skill_id;
  if (frontmatter.base_commit_sha) ordered.base_commit_sha = frontmatter.base_commit_sha;
  if (frontmatter.base_content_hash) ordered.base_content_hash = frontmatter.base_content_hash;
  return ordered;
}

export interface ParseOutcome<T> {
  ok: boolean;
  value?: T;
  body?: string;
  errors: string[];
}

export function tryParseMemory(text: string, path: string): ParseOutcome<MemoryRecord> {
  const split = splitFrontmatter(text);
  if (!split) return { ok: false, errors: [`${path}: missing YAML frontmatter block`] };
  let data: unknown;
  try {
    data = parseYaml(split.yamlSource);
  } catch (error) {
    return { ok: false, errors: [`${path}: invalid YAML frontmatter (${(error as Error).message})`] };
  }
  const result = memoryFrontmatterSchema.safeParse(data);
  if (!result.success) return { ok: false, errors: formatIssues(result.error).map((issue) => `${path}: ${issue}`) };
  return { ok: true, value: { frontmatter: result.data, body: split.body, path }, body: split.body, errors: [] };
}

export function parseMemory(text: string, path: string): MemoryRecord {
  const outcome = tryParseMemory(text, path);
  if (!outcome.ok || !outcome.value) {
    throw new AquariusError('validation_failed', `Memory record failed validation:\n${outcome.errors.join('\n')}`, {
      details: { path, errors: outcome.errors },
      actionable: 'Fix the record in the memory repository, or rebuild the search index from Git.',
    });
  }
  return outcome.value;
}

export function serializeEvidence(evidence: EvidenceFrontmatter, body: string): string {
  const ordered: Record<string, unknown> = {
    evidence_id: evidence.evidence_id,
    case_id: evidence.case_id,
    schema_version: evidence.schema_version,
    kind: evidence.kind,
    authority: evidence.authority,
    session_id: evidence.session_id,
    root_thread_id: evidence.root_thread_id,
    source: evidence.source,
    source_hash: evidence.source_hash,
    created_at: evidence.created_at,
    sensitivity: evidence.sensitivity,
    verified: evidence.verified,
  };
  if (evidence.tool_name) ordered.tool_name = evidence.tool_name;
  if (evidence.event_id) ordered.event_id = evidence.event_id;
  if (evidence.ordinal !== undefined) ordered.ordinal = evidence.ordinal;
  return serializeDocument(ordered, body);
}

export function tryParseEvidence(text: string, path: string): ParseOutcome<{ frontmatter: EvidenceFrontmatter; body: string }> {
  const split = splitFrontmatter(text);
  if (!split) return { ok: false, errors: [`${path}: missing YAML frontmatter block`] };
  let data: unknown;
  try {
    data = parseYaml(split.yamlSource);
  } catch (error) {
    return { ok: false, errors: [`${path}: invalid YAML frontmatter (${(error as Error).message})`] };
  }
  const result = evidenceFrontmatterSchema.safeParse(data);
  if (!result.success) return { ok: false, errors: formatIssues(result.error).map((issue) => `${path}: ${issue}`) };
  return { ok: true, value: { frontmatter: result.data, body: split.body }, body: split.body, errors: [] };
}
