// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { JsonValue } from "./types.js";

export type TypedDiscourseEpistemicState = "supported" | "uncertain" | "contradicted";
export type TypedDiscourseUnitRole = "answer" | "support" | "caveat";

/** A typed claim already admitted by cognition; no surface wording is used for planning. */
export interface TypedDiscourseClaim {
  readonly id: string;
  readonly relationId: string;
  readonly forceClass: string;
  readonly support: number;
  readonly activation: number;
  readonly score: number;
  readonly contradiction?: number;
  readonly answerGrade?: boolean;
  readonly finalQuestionFit?: number;
  readonly questionSlotScore?: number;
  readonly pathScore?: number;
  readonly bridgeValue?: number;
  readonly roleScore?: number;
}

export interface TypedDiscourseUnit {
  readonly claimId: string;
  readonly relationId: string;
  readonly index: number;
  readonly role: TypedDiscourseUnitRole;
  readonly epistemicState: TypedDiscourseEpistemicState;
}

export interface TypedDiscoursePlan {
  readonly units: readonly TypedDiscourseUnit[];
  readonly admittedClaimIds: readonly string[];
  readonly excludedClaimIds: readonly string[];
  readonly audit: JsonValue;
}

/**
 * Orders admitted claims into a bounded meaning plan. Relation order is a
 * source-derived sequence of relation IDs; scores only break ties within that
 * sequence. Contradiction and uncertainty remain explicit unit roles.
 */
export function planTypedDiscourse(input: {
  readonly claims: readonly TypedDiscourseClaim[];
  readonly relationOrder?: readonly string[];
  readonly maxSupportPoints: number;
  readonly maxCaveats: number;
}): TypedDiscoursePlan {
  const relationRanks = new Map(input.relationOrder?.map((relationId, index) => [relationId, index]) ?? []);
  // Activation and route score decide which supported claim to say first;
  // they are not evidence. A highly activated unsupported node must never be
  // promoted into factual discourse merely because the graph visited it.
  const eligible = input.claims.filter(claim => claim.id && claim.support > 0);
  const ineligible = input.claims.filter(claim => !eligible.includes(claim));
  const stateOf = (claim: TypedDiscourseClaim): TypedDiscourseEpistemicState => {
    if ((claim.contradiction ?? 0) >= 0.5 || /contradict/iu.test(claim.forceClass)) return "contradicted";
    if (/underdeterm|unknown|uncertain|prior/iu.test(claim.forceClass)) return "uncertain";
    return "supported";
  };
  const rank = (claim: TypedDiscourseClaim): [number, number, number, number, number, number, string, string] => [
    relationRanks.get(claim.relationId) ?? Number.MAX_SAFE_INTEGER,
    -(claim.pathScore ?? 0),
    -(claim.bridgeValue ?? 0),
    -(claim.questionSlotScore ?? 0),
    -(claim.finalQuestionFit ?? 0),
    -Math.max(claim.support, claim.activation, claim.score),
    claim.relationId,
    claim.id
  ];
  const compare = (left: TypedDiscourseClaim, right: TypedDiscourseClaim): number => {
    const a = rank(left);
    const b = rank(right);
    for (let index = 0; index < a.length; index += 1) {
      const leftValue = a[index]!;
      const rightValue = b[index]!;
      if (leftValue === rightValue) continue;
      return leftValue < rightValue ? -1 : 1;
    }
    return 0;
  };
  const unique = [...new Map(eligible.map(claim => [claim.id, claim])).values()];
  const supported = unique.filter(claim => stateOf(claim) === "supported").sort(compare);
  const uncertain = unique.filter(claim => stateOf(claim) === "uncertain").sort(compare);
  const contradicted = unique.filter(claim => stateOf(claim) === "contradicted").sort(compare);
  const answer = supported.find(claim => claim.answerGrade) ?? supported[0] ?? uncertain[0] ?? contradicted[0];
  const support = supported.filter(claim => claim !== answer).slice(0, Math.max(0, Math.floor(input.maxSupportPoints)));
  const caveats = [...uncertain.filter(claim => claim !== answer), ...contradicted.filter(claim => claim !== answer)].slice(0, Math.max(0, Math.floor(input.maxCaveats)));
  const selected = [answer, ...support, ...caveats].filter((claim): claim is TypedDiscourseClaim => Boolean(claim));
  const selectedIds = new Set(selected.map(claim => claim.id));
  const units = selected.map((claim, index) => ({
    claimId: claim.id,
    relationId: claim.relationId,
    index,
    role: claim === answer ? "answer" as const : caveats.includes(claim) ? "caveat" as const : "support" as const,
    epistemicState: stateOf(claim)
  }));
  return Object.freeze({
    units: Object.freeze(units),
    admittedClaimIds: Object.freeze(selected.map(claim => claim.id)),
    excludedClaimIds: Object.freeze(input.claims.filter(claim => !selectedIds.has(claim.id)).map(claim => claim.id)),
    audit: {
      source: "typed-discourse-plan",
      relationOrder: [...(input.relationOrder ?? [])],
      maxSupportPoints: Math.max(0, Math.floor(input.maxSupportPoints)),
      maxCaveats: Math.max(0, Math.floor(input.maxCaveats)),
      eligibleClaimCount: unique.length,
      admittedClaimCount: selected.length,
      excludedClaimCount: ineligible.length + Math.max(0, unique.length - selected.length),
      epistemicStates: units.map(unit => [unit.claimId, unit.epistemicState])
    }
  });
}
