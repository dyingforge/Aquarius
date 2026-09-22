import type { MemoryFrontmatter } from '../memory/schema.ts';
import { SCHEMA_VERSION } from '../memory/schema.ts';

/** Shared fixtures for the unit tests. */

export function canonicalJson(value: unknown): string {
  const walk = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(walk);
    if (input !== null && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input as Record<string, unknown>)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, item]) => [key, walk(item)]),
      );
    }
    return input;
  };
  return JSON.stringify(walk(value));
}

/** A valid frontmatter record used across the schema tests. */
export function stableFrontmatterSample(): Record<string, unknown> {
  return {
    id: 'pro_01M0000000000000000000000',
    kind: 'profile',
    status: 'active',
    schema_version: SCHEMA_VERSION,
    title: 'Prefers pnpm workspaces',
    tags: ['tooling'],
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-02T00:00:00.000Z',
    valid_from: '2026-01-01T00:00:00.000Z',
    authority: 'user_explicit',
    confidence: 'high',
    confidence_reason: 'The user stated this directly.',
    supporting_case_ids: ['case_01M0000000000000000000000'],
    contradicting_case_ids: [],
    provenance: { source: 'codex', adapter: 'codex-jsonl', event_ids: [], session_id: 'session-1' },
    sensitivity: 'public',
    keywords: ['pnpm'],
  };
}

export function frontmatterFor(overrides: Partial<MemoryFrontmatter>): Record<string, unknown> {
  return { ...stableFrontmatterSample(), ...overrides };
}

/**
 * Assembles a credential-shaped string at runtime.
 *
 * The redaction tests need inputs that genuinely match the credential patterns,
 * but a literal `sk-…`-style constant in the source is indistinguishable to a
 * secret scanner from a real leak — and it trips GitHub push protection. Building
 * the string from fragments keeps the fixtures realistic without putting a
 * secret-shaped literal into the repository.
 */
export function credentialLike(...parts: string[]): string {
  return parts.join('');
}
