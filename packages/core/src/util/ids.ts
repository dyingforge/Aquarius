import { createHash, randomBytes, randomUUID } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * ULID-compatible identifier: 48-bit millisecond timestamp + 80 bits of entropy,
 * Crockford base32, lexicographically sortable. Implemented locally to avoid a
 * dependency for ~20 lines of code.
 */
export function ulid(now: number = Date.now()): string {
  let timePart = '';
  let remaining = now;
  for (let i = 0; i < 10; i += 1) {
    timePart = CROCKFORD[remaining % 32]! + timePart;
    remaining = Math.floor(remaining / 32);
  }

  const bytes = randomBytes(10);
  let randomPart = '';
  for (let i = 0; i < 16; i += 1) {
    const byte = bytes[Math.floor(i / 2)]!;
    const nibble = i % 2 === 0 ? byte >> 4 : byte & 0x0f;
    randomPart += CROCKFORD[nibble % 32]!;
  }
  return timePart + randomPart;
}

export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

const KIND_PREFIX = {
  experience: 'exp',
  profile: 'pro',
  strategy: 'str',
  skill: 'skl',
} as const;

export type MemoryKindKey = keyof typeof KIND_PREFIX;

/** Memory IDs are prefixed by kind so that a bare ID in a transcript is self-describing. */
export function newMemoryId(kind: MemoryKindKey): string {
  return `${KIND_PREFIX[kind]}_${ulid()}`;
}

export function newCaseId(): string {
  return `case_${ulid()}`;
}

export function newReviewId(): string {
  return `rev_${ulid()}`;
}

export function newJobId(): string {
  return `job_${ulid()}`;
}

export function newEvidenceId(): string {
  return `ev_${ulid()}`;
}

export function newTokenId(): string {
  return `tok_${randomUUID()}`;
}

/**
 * Content-derived ID. Unlike {@link ulid} this is stable across runs, which is
 * what makes re-processing the same evidence idempotent: the same source event
 * always maps to the same evidence ID.
 */
export function deriveId(prefix: string, ...parts: string[]): string {
  const digest = createHash('sha256').update(parts.join('\u0000')).digest();
  let out = '';
  for (const byte of digest.subarray(0, 16)) {
    out += CROCKFORD[byte % 32]!;
  }
  return `${prefix}_${out}`;
}

/** Stable, filesystem-safe fragment for audit file names. */
export function slugify(input: string, maxLength = 60): string {
  const slug = input
    .normalize('NFKD')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  const trimmed = slug.slice(0, maxLength).replace(/-+$/g, '');
  return trimmed === '' ? 'untitled' : trimmed;
}
