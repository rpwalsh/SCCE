import type { GraphEdge, InformationAccessContext } from "./types.js";
import { informationLabelAllowsRead } from "./information-flow.js";

/**
 * Plan item 146: the documented `beta^T f_e` edge-weight decomposition for
 * personalized Perron activation (`ppf.ts`), additive to the existing
 * scalar `weight*alpha` (still the default -- see `ppf.ts`'s optional
 * `edgeWeightFn` injection point). `f_e` is a real, bare-edge-grounded
 * feature vector built only from fields `GraphEdge` actually carries:
 *
 * - temporal decay, from the edge's own real `temporalScope` (0 once a
 *   `known`-status edge falls outside its `validFrom`/`validTo` window,
 *   `1 - uncertainty` for an `unknown`-status edge, 1 for `atemporal`).
 * - provenance strength, from the edge's own real `evidenceIds`: open (1)
 *   once at least one real evidence id backs the edge, closed (0) for an
 *   edge with none -- never fabricated from nothing.
 * - profile/access gating, reusing `information-flow.ts`'s real, already-
 *   tested `informationLabelAllowsRead` against the edge's own
 *   `informationLabel` -- never reimplemented here.
 *
 * The plan also names a "truth"/"proof" gate. No bare `GraphEdge` field
 * carries a per-edge truth or proof-verification score in this codebase
 * today (confirmed absent, same honesty precedent as plan item 155's
 * "Gate II", which this repo also does not define) -- it is accepted here
 * as an optional, externally-supplied `EdgeWeightGateContext.truthGate`
 * (e.g. from a caller holding real `proof-license-semiring.ts` state),
 * defaulting to fully open (1) rather than fabricating a bare-edge-derived
 * substitute.
 *
 * `beta` is constrained to a convex combination (nonnegative, summing to
 * 1) so the resulting gate score always stays within [0,1] and, critically,
 * reduces to *exactly* the existing `weight*alpha` behavior whenever every
 * gate is fully open -- the real backward-compatibility property this
 * module's tests verify directly.
 */

export interface EdgeWeightGateContext {
  now: number;
  /** External truth/proof-verification support, 0..1. Not derivable from a bare edge; defaults to 1 (fully open) when omitted. */
  truthGate?: number;
  accessContext?: InformationAccessContext;
}

export interface EdgeWeightFeatureVector {
  temporalDecay: number;
  provenanceStrength: number;
  profileGate: number;
  truthGate: number;
}

export interface EdgeWeightBeta {
  temporal: number;
  provenance: number;
  profile: number;
  truth: number;
}

/** An even convex combination: with every gate fully open, the score is exactly 1, matching the existing scalar `weight*alpha` behavior exactly. */
export const NEUTRAL_EDGE_WEIGHT_BETA: EdgeWeightBeta = { temporal: 0.25, provenance: 0.25, profile: 0.25, truth: 0.25 };

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function temporalDecayFeature(edge: GraphEdge, now: number): number {
  const scope = edge.temporalScope;
  if (scope.status === "atemporal") return 1;
  if (scope.status === "unknown") return clamp01(1 - scope.uncertainty);
  // "known" and the legacy status-less read-compatibility shape both carry validFrom/validTo.
  if (now < scope.validFrom) return 0;
  if (scope.validTo !== undefined && now > scope.validTo) return 0;
  return 1;
}

function provenanceStrengthFeature(edge: GraphEdge): number {
  return edge.evidenceIds.length > 0 ? 1 : 0;
}

function profileGateFeature(edge: GraphEdge, accessContext: InformationAccessContext | undefined): number {
  if (!edge.informationLabel) return 1;
  if (!accessContext) return 1;
  return informationLabelAllowsRead(edge.informationLabel, accessContext) ? 1 : 0;
}

export function computeEdgeWeightFeatures(edge: GraphEdge, context: EdgeWeightGateContext): EdgeWeightFeatureVector {
  return {
    temporalDecay: temporalDecayFeature(edge, context.now),
    provenanceStrength: provenanceStrengthFeature(edge),
    profileGate: profileGateFeature(edge, context.accessContext),
    truthGate: clamp01(context.truthGate ?? 1)
  };
}

/** The real `beta^T f_e` dot product. Throws if `beta` is not a valid convex combination -- a silently unnormalized beta could push the gate score, and therefore the resulting edge weight, outside [0,1] in a way callers would not expect. */
export function edgeWeightGateScore(features: EdgeWeightFeatureVector, beta: EdgeWeightBeta = NEUTRAL_EDGE_WEIGHT_BETA): number {
  const components = [beta.temporal, beta.provenance, beta.profile, beta.truth];
  if (components.some(component => !Number.isFinite(component) || component < 0)) {
    throw new RangeError("beta components must be finite and nonnegative");
  }
  const betaSum = components.reduce((total, component) => total + component, 0);
  if (Math.abs(betaSum - 1) > 1e-9) {
    throw new RangeError(`beta must be a convex combination (components summing to 1); received sum ${betaSum}`);
  }
  return clamp01(
    beta.temporal * features.temporalDecay
    + beta.provenance * features.provenanceStrength
    + beta.profile * features.profileGate
    + beta.truth * features.truthGate
  );
}

/** Drop-in replacement for `ppf.ts`'s internal scalar `weight*alpha` -- pass as `edgeWeightFn` to `personalizedRandomWalkWithRestart(Detailed)`/`personalizedRandomWalkWithRestartDenseReference`. */
export function decomposedEffectiveEdgeWeight(
  edge: GraphEdge,
  context: EdgeWeightGateContext,
  beta: EdgeWeightBeta = NEUTRAL_EDGE_WEIGHT_BETA
): number {
  const gate = edgeWeightGateScore(computeEdgeWeightFeatures(edge, context), beta);
  const weight = edge.weight * edge.alpha * gate;
  if (!Number.isFinite(weight)) throw new RangeError(`effective decomposed weight overflow for edge ${String(edge.id)}`);
  return weight;
}
