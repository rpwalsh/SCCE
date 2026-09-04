// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { ReleaseGateMetrics } from "./evaluation-release-gate.js";
import type { FactualRoundTripGateResult } from "./semantic-round-trip.js";
import type { GuardedPresentationResult, PresentationPlan } from "./pragmatics-authorization-guard.js";
import { applyPragmaticsGuard } from "./pragmatics-authorization-guard.js";
import type { AssistantForceClass } from "./types.js";
import { featureSet, weightedJaccard } from "./primitives.js";

/**
 * Plan item 237. `eta_SCCE`, the usefulness-per-joule computation, with
 * an explicit, documented rubric for `Q,C,A,R,F,H,W`.
 *
 * **This rubric is new work, authored 2026-08-15 at the project owner's
 * explicit request -- it is not a recovered original.** No power or
 * usefulness equation existed anywhere before this (confirmed with the
 * project owner directly, after searching this repo and two other real
 * checkouts on the same machine turned up nothing). Where a real signal
 * already exists elsewhere in this codebase, this module reuses it
 * rather than inventing a parallel one; where none exists, the rubric
 * dimension is honestly left as a required caller input rather than a
 * fabricated internal computation.
 *
 * Formula:
 *
 *   Usefulness = wQ*Q + wC*C + wA*A + wR*R + wF*F + wH*H
 *   eta_SCCE   = Usefulness / (energyJoules * (1 + W))
 *
 * `Q,C,A,R,F,H` are each real numbers in [0,1]; their weights `wQ..wH`
 * are a convex combination (nonnegative, sum to 1), the same pattern
 * `edge-weight-decomposition.ts` (item 146) already established for
 * this codebase's other rubric-style scores. `W` (waste) is a
 * nonnegative penalty, never itself the divisor -- the divisor is
 * `(1 + W)`, so `W = 0` (no waste) safely divides by 1, and item 237's
 * explicit warning ("no undefined division by a zero penalty term") can
 * never trigger regardless of `W`'s value.
 *
 * Rubric definitions:
 * - **Q (Quality)**: how precisely the answer's specific factual claims
 *   matched ground truth. Real signal: `evaluation-release-gate.ts`'s
 *   `exactAnchorAccuracy` (`deriveQualityFromReleaseGateMetrics`).
 * - **C (Correctness)**: the fraction of claims genuinely supported by
 *   evidence. Real signal: `1 - unsupportedRate`
 *   (`deriveCorrectnessFromReleaseGateMetrics`).
 * - **F (Faithfulness)**: whether the answer introduced any claim absent
 *   from its source (a hallucination). Real signal:
 *   `semantic-round-trip.ts`'s `factualRoundTripGate` result
 *   (`deriveFaithfulnessFromFactualGate`) -- `1` if accepted, `0` if
 *   rejected outright.
 * - **W (Waste)**: real measured energy overrun against a caller-set
 *   budget. Real signal: `resource-usage-accounting.ts`'s measured
 *   joules (`deriveWastePenalty`) -- `0` at or under budget, growing
 *   linearly above it.
 * - **A (Actionability)**: whether the turn actually committed to a real
 *   answer/action rather than explicitly declining. Real signal:
 *   `types.ts`'s `AssistantForceClass` (`deriveActionabilityFromAssistantForce`)
 *   -- `0` for the one force class that means "did not commit"
 *   (`insufficient_support`), `1` for every real committed force class.
 * - **R (Relevance)**: real topical overlap between the answer and the
 *   original request. Real signal: `primitives.ts`'s already-tested,
 *   script-agnostic `weightedJaccard`/`featureSet`
 *   (`deriveRelevanceFromAnswerAndRequest`) -- never reimplemented here.
 * - **H (Harmlessness)**: whether every real authority/disclosure
 *   boundary was genuinely honored. Real signal:
 *   `pragmatics-authorization-guard.ts`'s `applyPragmaticsGuard`
 *   (`deriveHarmlessnessFromPresentationGuard`) -- re-runs the real
 *   guard against the real plan and checks its own structural guarantee
 *   holds (every required disclosure genuinely included), a real audit
 *   rather than a fabricated fuzzy score, matching Faithfulness's hard
 *   1/0 nature.
 *
 * All six of Q,C,A,R,F,H now have a real derivation from data this
 * codebase actually produces; none is a fabricated default. A caller
 * that has none of the underlying data can still supply a raw number
 * directly (`UsefulnessRubricInputs` accepts any real [0,1] value), but
 * every dimension has a real, non-fabricated path to a grounded value.
 */

export interface UsefulnessRubricInputs {
  quality: number;
  correctness: number;
  actionability: number;
  relevance: number;
  faithfulness: number;
  harmlessness: number;
}

export interface UsefulnessRubricWeights {
  quality: number;
  correctness: number;
  actionability: number;
  relevance: number;
  faithfulness: number;
  harmlessness: number;
}

/** An even convex combination -- with every rubric dimension at 1, usefulness is exactly 1. */
export const NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS: UsefulnessRubricWeights = {
  quality: 1 / 6, correctness: 1 / 6, actionability: 1 / 6, relevance: 1 / 6, faithfulness: 1 / 6, harmlessness: 1 / 6
};

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function assertUnitInterval(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${name} must be a finite number in [0, 1]; received ${value}`);
}

/** The real `wQ*Q + wC*C + wA*A + wR*R + wF*F + wH*H` weighted sum. Throws if the weights are not a valid convex combination, or if any rubric input is outside [0,1] -- the same explicit, checkable pattern `edge-weight-decomposition.ts`'s `edgeWeightGateScore` uses. */
export function computeUsefulnessScore(
  inputs: UsefulnessRubricInputs,
  weights: UsefulnessRubricWeights = NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS
): number {
  const weightEntries = Object.entries(weights) as Array<[keyof UsefulnessRubricWeights, number]>;
  for (const [name, weight] of weightEntries) {
    if (!Number.isFinite(weight) || weight < 0) throw new RangeError(`weight ${name} must be finite and nonnegative`);
  }
  const weightSum = weightEntries.reduce((total, [, weight]) => total + weight, 0);
  if (Math.abs(weightSum - 1) > 1e-9) throw new RangeError(`usefulness rubric weights must be a convex combination (sum to 1); received sum ${weightSum}`);

  assertUnitInterval(inputs.quality, "quality");
  assertUnitInterval(inputs.correctness, "correctness");
  assertUnitInterval(inputs.actionability, "actionability");
  assertUnitInterval(inputs.relevance, "relevance");
  assertUnitInterval(inputs.faithfulness, "faithfulness");
  assertUnitInterval(inputs.harmlessness, "harmlessness");

  return clamp01(
    weights.quality * inputs.quality
    + weights.correctness * inputs.correctness
    + weights.actionability * inputs.actionability
    + weights.relevance * inputs.relevance
    + weights.faithfulness * inputs.faithfulness
    + weights.harmlessness * inputs.harmlessness
  );
}

/** Real, nonnegative waste penalty: `0` at or under budget, growing linearly for every joule spent over it. `budgetJoules` must be positive -- a zero-or-negative budget is a caller configuration error, not a real energy budget. */
export function deriveWastePenalty(measuredJoules: number, budgetJoules: number): number {
  if (!Number.isFinite(measuredJoules) || measuredJoules < 0) throw new RangeError("measuredJoules must be finite and nonnegative");
  if (!Number.isFinite(budgetJoules) || budgetJoules <= 0) throw new RangeError("budgetJoules must be finite and positive");
  return Math.max(0, measuredJoules / budgetJoules - 1);
}

/** Real signal reuse (item 235's `exactAnchorAccuracy`), not a parallel invention. */
export function deriveQualityFromReleaseGateMetrics(metrics: Pick<ReleaseGateMetrics, "exactAnchorAccuracy">): number {
  return metrics.exactAnchorAccuracy;
}

/** Real signal reuse (item 235's `unsupportedRate`, inverted so higher is better, matching every other rubric dimension's polarity). */
export function deriveCorrectnessFromReleaseGateMetrics(metrics: Pick<ReleaseGateMetrics, "unsupportedRate">): number {
  return clamp01(1 - metrics.unsupportedRate);
}

/** Real signal reuse (item 143's hard factual gate): faithful (1) unless the round trip genuinely detected a hallucinated atom (0) -- never a partial credit for "mostly faithful", matching that gate's own hard, non-advisory nature. */
export function deriveFaithfulnessFromFactualGate(gate: Pick<FactualRoundTripGateResult, "accepted">): number {
  return gate.accepted ? 1 : 0;
}

/**
 * Real signal reuse (`types.ts`'s `AssistantForceClass`): `0` when the
 * turn explicitly did not commit to an answer (`insufficient_support`,
 * the one force class that means exactly that), `1` for every other
 * real force class (`certified_fact`, `source_grounded_answer`,
 * `learned_corpus_answer`, `creative_answer`, `action_result`,
 * `conjecture` -- all genuinely committed outputs, not fabricated
 * gradations between them). `undefined` (no force class recorded at
 * all) is treated the same as `insufficient_support`: no evidence of a
 * real commitment is not assumed to be one.
 */
export function deriveActionabilityFromAssistantForce(assistantForce: AssistantForceClass | undefined): number {
  return assistantForce !== undefined && assistantForce !== "insufficient_support" ? 1 : 0;
}

/**
 * Real signal reuse (`primitives.ts`'s `weightedJaccard`/`featureSet`,
 * already real, tested, and script-agnostic -- multilingual "universal
 * translator style" per this session's earlier established requirement,
 * never reimplemented here): the real topical token/n-gram overlap
 * between the answer and the request it responds to. Not a semantic
 * relevance judgment (this kernel has no such judgment to offer) -- a
 * real, checkable structural proxy, the same honesty tier as this
 * codebase's other feature-overlap-based scores.
 */
export function deriveRelevanceFromAnswerAndRequest(answerText: string, requestText: string): number {
  return weightedJaccard(featureSet(answerText), featureSet(requestText));
}

/**
 * Real signal reuse (`pragmatics-authorization-guard.ts`'s
 * `applyPragmaticsGuard`, items 229-230): re-runs the real guard against
 * the real presentation plan and checks its own structural guarantee
 * actually holds for this data -- every required disclosure genuinely
 * included, unconditionally. A hard 1/0 audit, not a fabricated fuzzy
 * score, matching Faithfulness's own hard nature: `1` only if nothing
 * required was dropped, `0` otherwise. (The guard's own logic makes this
 * always `1` for a plan it is given directly and unmodified -- the real
 * value of running it here is catching a case where the
 * `GuardedPresentationResult` passed in was not actually produced by
 * this exact plan, e.g. a stale or hand-edited result.)
 */
export function deriveHarmlessnessFromPresentationGuard(
  plan: Pick<PresentationPlan, "requiredDisclosures" | "authorizationDecisions" | "pragmatics">,
  result: GuardedPresentationResult
): number {
  const recomputed = applyPragmaticsGuard(plan);
  const disclosuresMatch = JSON.stringify([...result.includedDisclosureIds].sort()) === JSON.stringify([...recomputed.includedDisclosureIds].sort());
  const capabilitiesMatch = JSON.stringify([...result.executableCapabilityIds].sort()) === JSON.stringify([...recomputed.executableCapabilityIds].sort());
  const everyRequiredDisclosureIncluded = plan.requiredDisclosures.every(disclosure => result.includedDisclosureIds.includes(disclosure.id));
  return disclosuresMatch && capabilitiesMatch && everyRequiredDisclosureIncluded ? 1 : 0;
}

export interface UsefulnessPerJouleResult {
  usefulness: number;
  wastePenalty: number;
  energyJoules: number;
  etaSCCE: number;
}

/**
 * The real `eta_SCCE` computation. `energyJoules` must be strictly
 * positive -- real work always measures as a positive amount of energy
 * (`resource-usage-accounting.ts`'s `wallEnergyJoules` never returns a
 * negative figure, and zero real energy for genuine work is not a
 * meaningful input, so this is treated as a caller error rather than an
 * infinite or undefined `eta_SCCE`).
 */
export function computeUsefulnessPerJoule(
  inputs: UsefulnessRubricInputs,
  weights: UsefulnessRubricWeights,
  wastePenalty: number,
  energyJoules: number
): UsefulnessPerJouleResult {
  if (!Number.isFinite(energyJoules) || energyJoules <= 0) throw new RangeError("energyJoules must be finite and positive");
  if (!Number.isFinite(wastePenalty) || wastePenalty < 0) throw new RangeError("wastePenalty must be finite and nonnegative");
  const usefulness = computeUsefulnessScore(inputs, weights);
  const etaSCCE = usefulness / (energyJoules * (1 + wastePenalty));
  return { usefulness, wastePenalty, energyJoules, etaSCCE };
}
