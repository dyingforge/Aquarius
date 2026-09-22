/**
 * Deterministic contradiction detection.
 *
 * "The project does not use Docker" and "the project uses Docker" are textually
 * almost identical but mean opposite things. Lexical similarity alone therefore
 * cannot be allowed to decide between "duplicate" and "conflict", so this check is
 * shared by the consolidation prompt's double *and* by the deterministic gate in
 * the ingestion pipeline: even if a model proposes `add` or `duplicate`, a
 * polarity mismatch against an existing memory still becomes a review instead of
 * an automatic overwrite.
 */

const NEGATION_MARKERS = [
  /(?:不|没|别|无需|不再|停止|禁止|放弃)/,
  /\b(?:not|never|no longer|stop|avoid|without|deprecated|disallow)\b/i,
];

export function hasNegation(text: string): boolean {
  return NEGATION_MARKERS.some((pattern) => pattern.test(text));
}

export interface ContradictionCheck {
  contradictory: boolean;
  reason: string;
}

/**
 * True when two statements describe the same subject but disagree on polarity.
 * `overlap` is the caller's lexical similarity score (0..1).
 */
export function looksContradictory(observationText: string, memoryText: string, overlap: number): ContradictionCheck {
  if (overlap < 0.3) {
    return { contradictory: false, reason: 'The statements are not about the same subject.' };
  }
  const observationNegated = hasNegation(observationText);
  const memoryNegated = hasNegation(memoryText);
  if (observationNegated === memoryNegated) {
    return { contradictory: false, reason: 'Both statements have the same polarity.' };
  }
  return {
    contradictory: true,
    reason: observationNegated
      ? 'The new statement negates a claim the existing memory makes.'
      : 'The existing memory negates what the new statement claims.',
  };
}
