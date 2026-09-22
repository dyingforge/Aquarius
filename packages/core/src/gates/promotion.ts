import { AquariusError } from '../errors.ts';

/**
 * Deterministic gates.
 *
 * Models propose; these functions decide. Nothing here consults a model, and no
 * model can bypass these rules — that is the whole point of the split.
 */

export interface PromotionGateContext {
  kind: 'experience' | 'profile' | 'strategy';
  declaredAuthority: 'user_explicit' | 'tool_verified' | 'inferred';
  confidence: 'high' | 'medium' | 'low';
  sensitivity: 'public' | 'personal' | 'sensitive';
  /** Evidence actually cited, resolved from the sanitized session. */
  citedEvidence: { kind: 'user_message' | 'tool_result'; verified: boolean }[];
  /** Distinct root-thread cases supporting this memory, including the current one. */
  distinctSupportingCaseIds: string[];
  contradictingCaseIds: string[];
  /** True when another memory asserts the opposite and no user decision resolved it. */
  hasUnresolvedConflict: boolean;
  /** The user explicitly asked Aquarius to remember this. */
  userExplicitlyRequested: boolean;
}

export interface GateDecision {
  outcome: 'active' | 'candidate' | 'review' | 'reject';
  /** Authority after deterministic verification of the cited evidence. */
  effectiveAuthority: 'user_explicit' | 'tool_verified' | 'inferred';
  reasons: string[];
  reviewKind?: 'promotion' | 'conflict';
}

export const PROMOTION_RULES = {
  /** Inferred profile/strategy memories need this many independent cases. */
  minDistinctCasesForInferredPromotion: 2,
  /** Skill candidates need this many independent successful cases. */
  skillMinDistinctCases: 3,
  /** ...spread over at least this many distinct task features. */
  skillMinDistinctFeatures: 2,
  maxSupportingCases: 50,
} as const;

/**
 * Recomputes authority from the evidence rather than trusting the model's claim.
 * A model that labels an inference `user_explicit` cannot promote it, because the
 * cited evidence does not contain a user statement.
 */
export function verifyAuthority(
  declared: PromotionGateContext['declaredAuthority'],
  citedEvidence: PromotionGateContext['citedEvidence'],
): { authority: PromotionGateContext['declaredAuthority']; reason: string } {
  if (citedEvidence.length === 0) {
    return { authority: 'inferred', reason: 'No cited evidence could be resolved; authority downgraded to inferred.' };
  }
  if (citedEvidence.some((evidence) => evidence.kind === 'user_message')) {
    return { authority: 'user_explicit', reason: 'A cited user message states this directly.' };
  }
  if (citedEvidence.some((evidence) => evidence.kind === 'tool_result' && evidence.verified)) {
    return { authority: 'tool_verified', reason: 'A cited tool result verifies this.' };
  }
  return {
    authority: 'inferred',
    reason: `Declared ${declared} but no user statement or verified tool result was cited.`,
  };
}

/**
 * The memory gate from PLAN §6.
 *
 * - An experience may become active on one valid piece of evidence.
 * - An inferred profile or strategy needs two independent cases, high confidence
 *   and no unresolved conflict.
 * - An explicit user statement about their own profile or strategy skips the
 *   case threshold.
 * - Conflicts, low confidence and sensitive candidates go to review instead of
 *   silently entering the current view.
 */
export function applyPromotionGate(context: PromotionGateContext): GateDecision {
  const reasons: string[] = [];
  const verified = verifyAuthority(context.declaredAuthority, context.citedEvidence);
  reasons.push(verified.reason);

  if (context.citedEvidence.length === 0) {
    return {
      outcome: 'reject',
      effectiveAuthority: 'inferred',
      reasons: [...reasons, 'Rejected: an observation with no resolvable evidence is not storable.'],
    };
  }

  if (context.sensitivity === 'sensitive') {
    return {
      outcome: 'review',
      effectiveAuthority: verified.authority,
      reasons: [...reasons, 'Sensitive content is never promoted automatically; it waits for review.'],
      reviewKind: 'promotion',
    };
  }

  // An unresolved conflict blocks promotion for *every* kind of memory, including
  // experiences. Two mutually exclusive statements must never both be active.
  if (context.hasUnresolvedConflict || context.contradictingCaseIds.length > 0) {
    return {
      outcome: 'review',
      effectiveAuthority: verified.authority,
      reasons: [...reasons, 'Contradicting evidence exists; a human decision is required before promotion.'],
      reviewKind: 'conflict',
    };
  }

  if (context.kind === 'experience') {
    if (verified.authority === 'user_explicit' || verified.authority === 'tool_verified') {
      return {
        outcome: 'active',
        effectiveAuthority: verified.authority,
        reasons: [...reasons, 'A single valid evidence item is enough for an experience.'],
      };
    }
    return {
      outcome: 'candidate',
      effectiveAuthority: 'inferred',
      reasons: [...reasons, 'An inferred experience stays a candidate until it has direct evidence.'],
    };
  }

  // profile | strategy
  if (context.userExplicitlyRequested || verified.authority === 'user_explicit') {
    return {
      outcome: 'active',
      effectiveAuthority: 'user_explicit',
      reasons: [...reasons, 'The user stated this directly, so the case threshold does not apply.'],
    };
  }

  const distinctCases = new Set(context.distinctSupportingCaseIds).size;
  if (
    distinctCases >= PROMOTION_RULES.minDistinctCasesForInferredPromotion &&
    context.confidence === 'high'
  ) {
    return {
      outcome: 'active',
      effectiveAuthority: verified.authority,
      reasons: [
        ...reasons,
        `Promoted on ${distinctCases} independent cases with high confidence.`,
      ],
    };
  }

  if (context.confidence === 'low' || verified.authority === 'inferred') {
    return {
      outcome: 'review',
      effectiveAuthority: verified.authority,
      reasons: [
        ...reasons,
        `Only ${distinctCases} independent case(s) with ${context.confidence} confidence; queued for review instead of promotion.`,
      ],
      reviewKind: 'promotion',
    };
  }

  return {
    outcome: 'candidate',
    effectiveAuthority: verified.authority,
    reasons: [
      ...reasons,
      `Needs ${PROMOTION_RULES.minDistinctCasesForInferredPromotion} independent cases (currently ${distinctCases}).`,
    ],
  };
}

export interface SkillGateContext {
  strategyStatus: string;
  strategyKind: string;
  supportingCases: {
    caseId: string;
    features: string[];
    /** Successful, user- or tool-sourced evidence only. */
    successfulEvidenceCount: number;
  }[];
  hasUnresolvedConflict: boolean;
}

export interface SkillGateDecision {
  eligible: boolean;
  reasons: string[];
  distinctCases: number;
  distinctFeatures: number;
}

/** The skill-candidate precondition from PLAN §8. */
export function applySkillGate(context: SkillGateContext): SkillGateDecision {
  const reasons: string[] = [];
  if (context.strategyKind !== 'strategy') {
    return { eligible: false, reasons: ['Only strategies can back a skill.'], distinctCases: 0, distinctFeatures: 0 };
  }
  if (context.strategyStatus !== 'active') {
    return {
      eligible: false,
      reasons: ['The supporting strategy is not active, so no skill candidate is generated.'],
      distinctCases: 0,
      distinctFeatures: 0,
    };
  }
  if (context.hasUnresolvedConflict) {
    return {
      eligible: false,
      reasons: ['An unresolved conflict exists for this strategy.'],
      distinctCases: 0,
      distinctFeatures: 0,
    };
  }

  const distinctCaseIds = new Set(context.supportingCases.map((entry) => entry.caseId));
  const distinctFeatures = new Set(context.supportingCases.flatMap((entry) => entry.features).filter((f) => f !== ''));
  const casesWithSuccess = context.supportingCases.filter((entry) => entry.successfulEvidenceCount > 0).length;

  if (casesWithSuccess < PROMOTION_RULES.skillMinDistinctCases) {
    reasons.push(
      `Needs ${PROMOTION_RULES.skillMinDistinctCases} independent cases with successful user or tool evidence (currently ${casesWithSuccess}).`,
    );
  }
  if (distinctFeatures.size < PROMOTION_RULES.skillMinDistinctFeatures) {
    reasons.push(
      `Needs ${PROMOTION_RULES.skillMinDistinctFeatures} distinct task features (currently ${distinctFeatures.size}).`,
    );
  }
  if (distinctCaseIds.size < PROMOTION_RULES.skillMinDistinctCases) {
    reasons.push(`Distinct cases: ${distinctCaseIds.size}.`);
  }

  return {
    eligible: reasons.length === 0,
    reasons: reasons.length === 0 ? ['Gate satisfied.'] : reasons,
    distinctCases: distinctCaseIds.size,
    distinctFeatures: distinctFeatures.size,
  };
}

/** Guard used before a confirmation write. Callers pass the HEAD they previewed against. */
export function assertExpectedHead(expectedHead: string | null, actualHead: string | null): void {
  if (expectedHead !== actualHead) {
    throw new AquariusError('stale_head', 'The memory repository HEAD changed since this preview was generated.', {
      details: { expectedHead, actualHead },
      actionable: 'Regenerate the preview and confirm again.',
    });
  }
}
