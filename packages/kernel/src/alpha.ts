import type { AlphaFactors, AlphaNormalizationDiagnostics, AlphaRelation, AlphaRelationState, AlphaTrace, GraphEdge, GraphNode } from "./types.js";
import { clamp01, mean } from "./primitives.js";
import { laplacian } from "./math.js";

export type AlphaThresholds = AlphaTrace["thresholds"];

const EMPIRICAL_QUANTILE_PROBABILITIES = [0.2, 0.4, 0.6, 0.8] as const;
const EMPTY_SAMPLE_THRESHOLDS: Readonly<AlphaThresholds> = Object.freeze({ virtual: 0.2, visible: 0.4, bonded: 0.6, structural: 0.8 });

/**
 * Compatibility value for callers that inspect a layer before building a trace.
 * Runtime traces do not use it when an active relation-strength sample exists.
 */
export const DEFAULT_ALPHA = EMPTY_SAMPLE_THRESHOLDS.visible;

export function createAlphaLayer(options: { alpha?: number } = {}) {
  const configured = options.alpha === undefined ? undefined : configuredNormalization(options.alpha, []);
  const initial = configured ?? emptySampleNormalization();
  return {
    alpha: initial.alpha,
    thresholds: initial.thresholds,
    relationStrength,
    classify(strength: number): AlphaRelationState {
      return classifyRelation(strength, initial.thresholds);
    },
    buildTrace(input: {
      nodes: GraphNode[];
      edges: GraphEdge[];
      activeNodeIds: string[];
      previous?: AlphaTrace;
      externalRisk?: number;
      now?: number;
    }): AlphaTrace {
      const active = new Set(input.activeNodeIds);
      const candidates: Array<Omit<AlphaRelation, "state" | "visible" | "bonded">> = [];
      const now = input.now ?? graphSnapshotTime(input.edges);
      for (const edge of input.edges) {
        if (!active.has(edge.source) && !active.has(edge.target)) continue;
        const factors = edgeFactors(edge, now);
        const strength = relationStrength(factors);
        candidates.push({
          id: `${edge.source}:${edge.relationId}:${edge.target}`,
          source: edge.source,
          target: edge.target,
          relationId: edge.relationId,
          factors,
          strength,
          evidenceIds: edge.evidenceIds
        });
      }
      const strengthSample = candidates.map(relation => relation.strength);
      const normalization = options.alpha === undefined ? empiricalNormalization(strengthSample) : configuredNormalization(options.alpha, strengthSample);
      const { alpha, thresholds } = normalization;
      const relations: AlphaRelation[] = candidates.map(relation => {
        const state = classifyRelation(relation.strength, thresholds);
        return {
          ...relation,
          state,
          visible: state === "visible" || state === "bonded" || state === "structural",
          bonded: state === "bonded" || state === "structural"
        };
      });
      const visible = relations.filter(relation => relation.visible);
      const nodeIds = [...new Set(visible.flatMap(relation => [relation.source, relation.target]))].sort();
      const matrices = laplacian(nodeIds, visible.map(relation => ({ source: relation.source, target: relation.target, weight: relation.strength })));
      const pressure = mean(visible.map(relation => relation.strength));
      const contradiction = mean(visible.map(relation => relation.strength * relation.factors.contradictionPenalty));
      const bond = mean(visible.map(relation => stateRank(relation.state) / 4));
      const actionability = mean(visible.map(relation => relation.strength * relation.factors.utility));
      const risk = clamp01(mean(visible.map(relation => relation.factors.contradictionPenalty)) + (input.externalRisk ?? 0));
      const drift = driftFrom(input.previous, visible);
      const bondedLeakage = bondedLeakageFrom(visible);
      return {
        alpha,
        thresholds,
        normalization: normalization.diagnostics,
        relations: visible,
        adjacency: matrices.adjacency,
        laplacian: matrices.laplacian,
        normalizedLaplacian: matrices.normalizedLaplacian,
        surfaces: { pressure, contradiction, bond, risk, actionability, drift },
        contradictionMass: contradiction,
        bondedLeakage
      };
    }
  };
}

interface AlphaNormalization {
  alpha: number;
  thresholds: AlphaThresholds;
  diagnostics: AlphaNormalizationDiagnostics;
}

function empiricalNormalization(sample: readonly number[]): AlphaNormalization {
  const sorted = sample.map(clamp01).sort((left, right) => left - right);
  if (sorted.length === 0) return emptySampleNormalization();

  const uniqueCount = new Set(sorted).size;
  const sampleDiagnostics = summarizeSortedSample(sorted);
  if (uniqueCount === 1) {
    const value = sorted[0] ?? 0;
    const thresholds = degenerateThresholds(value);
    return {
      alpha: thresholds.visible,
      thresholds,
      diagnostics: {
        schema: "scce.alpha_normalization.v1",
        mode: "degenerate_sample",
        method: "degenerate_anchor_interpolation",
        configuredAlpha: null,
        quantileProbabilities: null,
        sample: sampleDiagnostics
      }
    };
  }

  const thresholds: AlphaThresholds = {
    virtual: quantileType7(sorted, EMPIRICAL_QUANTILE_PROBABILITIES[0]),
    visible: quantileType7(sorted, EMPIRICAL_QUANTILE_PROBABILITIES[1]),
    bonded: quantileType7(sorted, EMPIRICAL_QUANTILE_PROBABILITIES[2]),
    structural: quantileType7(sorted, EMPIRICAL_QUANTILE_PROBABILITIES[3])
  };
  return {
    alpha: thresholds.visible,
    thresholds,
    diagnostics: {
      schema: "scce.alpha_normalization.v1",
      mode: "empirical_quantiles",
      method: "hyndman_fan_type_7",
      configuredAlpha: null,
      quantileProbabilities: EMPIRICAL_QUANTILE_PROBABILITIES,
      sample: sampleDiagnostics
    }
  };
}

function configuredNormalization(alpha: number, sample: readonly number[]): AlphaNormalization {
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new RangeError("alpha must be a finite number strictly between 0 and 1");
  }
  const thresholds: AlphaThresholds = {
    virtual: alpha * alpha,
    visible: alpha,
    bonded: Math.sqrt(alpha),
    structural: 1 - alpha * alpha
  };
  if (!strictlyOrderedThresholds(thresholds)) {
    throw new RangeError("configured alpha must produce finite, strictly ordered thresholds: 0 < alpha^2 < alpha < sqrt(alpha) < 1 - alpha^2 <= 1");
  }
  return {
    alpha,
    thresholds,
    diagnostics: {
      schema: "scce.alpha_normalization.v1",
      mode: "configured",
      method: "configured_legacy_threshold_transform",
      configuredAlpha: alpha,
      quantileProbabilities: null,
      sample: summarizeSortedSample(sample.map(clamp01).sort((left, right) => left - right))
    }
  };
}

function emptySampleNormalization(): AlphaNormalization {
  return {
    alpha: EMPTY_SAMPLE_THRESHOLDS.visible,
    thresholds: { ...EMPTY_SAMPLE_THRESHOLDS },
    diagnostics: {
      schema: "scce.alpha_normalization.v1",
      mode: "empty_sample",
      method: "neutral_empty_sample_fallback",
      configuredAlpha: null,
      quantileProbabilities: null,
      sample: { count: 0, uniqueCount: 0, minimum: null, median: null, maximum: null }
    }
  };
}

function degenerateThresholds(value: number): AlphaThresholds {
  const x = clamp01(value);
  if (x === 0) return { virtual: 0, visible: 0, bonded: 0, structural: 0 };
  return {
    virtual: x / 2,
    visible: x,
    bonded: x + (1 - x) / 2,
    structural: x + (3 * (1 - x)) / 4
  };
}

/** Hyndman-Fan type 7 sample quantile (the default in R and NumPy's linear method). */
function quantileType7(sorted: readonly number[], probability: number): number {
  if (sorted.length === 0) throw new RangeError("quantile sample must not be empty");
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const fraction = position - lower;
  const lowerValue = sorted[lower] ?? sorted[0] ?? 0;
  const upperValue = sorted[upper] ?? lowerValue;
  return lowerValue + fraction * (upperValue - lowerValue);
}

function summarizeSortedSample(sorted: readonly number[]): AlphaNormalizationDiagnostics["sample"] {
  return {
    count: sorted.length,
    uniqueCount: new Set(sorted).size,
    minimum: sorted[0] ?? null,
    median: sorted.length === 0 ? null : quantileType7(sorted, 0.5),
    maximum: sorted[sorted.length - 1] ?? null
  };
}

function strictlyOrderedThresholds(thresholds: AlphaThresholds): boolean {
  return Number.isFinite(thresholds.virtual) &&
    Number.isFinite(thresholds.visible) &&
    Number.isFinite(thresholds.bonded) &&
    Number.isFinite(thresholds.structural) &&
    thresholds.virtual > 0 &&
    thresholds.virtual < thresholds.visible &&
    thresholds.visible < thresholds.bonded &&
    thresholds.bonded < thresholds.structural &&
    thresholds.structural <= 1;
}

function classifyRelation(strength: number, thresholds: AlphaThresholds): AlphaRelationState {
  const w = clamp01(strength);
  if (w <= 0) return "sketch";
  if (w >= thresholds.structural) return "structural";
  if (w >= thresholds.bonded) return "bonded";
  if (w >= thresholds.visible) return "visible";
  if (w >= thresholds.virtual) return "virtual";
  return "sketch";
}

export function relationStrength(factors: AlphaFactors): number {
  const supportFactors = [
    factors.compatibility,
    factors.provenance,
    factors.temporalFit,
    factors.modalityAgreement,
    factors.recurrence,
    factors.utility
  ].map(clamp01);
  if (supportFactors.some(value => value === 0)) return 0;

  // The geometric mean preserves interaction between independent factors while
  // avoiding the dimensional collapse of an unnormalised six-factor product.
  // Equal exponents are intentional: no calibrated importance weights exist in
  // this layer. Contradiction remains a separate survival multiplier.
  const interaction = Math.exp(mean(supportFactors.map(value => Math.log(value))));
  return clamp01(interaction * (1 - clamp01(factors.contradictionPenalty)));
}

function edgeFactors(edge: GraphEdge, now: number): AlphaFactors {
  const ageMs = Math.max(0, now - edge.updatedAt);
  const inValidityInterval = edge.temporalScope.validFrom <= now && (edge.temporalScope.validTo === undefined || now <= edge.temporalScope.validTo);
  const temporalFit = inValidityInterval ? Math.exp(-ageMs / (1000 * 60 * 60 * 24 * 90)) : 0;
  const metadata = edge.metadata as { contradiction?: unknown; modalityAgreement?: unknown; utility?: unknown };
  const contradictionPenalty = finiteFactor(metadata.contradiction, 0);
  return {
    // edge.weight and edge.alpha are consumed exactly once: relation
    // compatibility and provenance confidence respectively.
    compatibility: clamp01(edge.weight),
    provenance: clamp01(edge.alpha),
    temporalFit,
    modalityAgreement: finiteFactor(metadata.modalityAgreement, 1),
    recurrence: clamp01(Math.log2(2 + edge.evidenceIds.length) / 4),
    // Missing utility evidence is neutral, not a second use of edge.alpha.
    utility: finiteFactor(metadata.utility, 1),
    contradictionPenalty
  };
}

function finiteFactor(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : fallback;
}

function graphSnapshotTime(edges: readonly GraphEdge[]): number {
  return edges.reduce((latest, edge) => Math.max(latest, edge.updatedAt), 0);
}

function stateRank(state: AlphaRelationState): number {
  return state === "structural" ? 4 : state === "bonded" ? 3 : state === "visible" ? 2 : state === "virtual" ? 1 : 0;
}

function driftFrom(previous: AlphaTrace | undefined, relations: AlphaRelation[]): number {
  if (!previous) return 0;
  const old = new Map(previous.relations.map(relation => [relation.id, relation.strength]));
  const deltas = relations.map(relation => Math.abs(relation.strength - (old.get(relation.id) ?? 0)));
  return clamp01(mean(deltas));
}

function bondedLeakageFrom(relations: AlphaRelation[]): number {
  const bonded = relations.filter(relation => relation.bonded);
  if (relations.length === 0) return 0;
  const external = relations.filter(relation => !relation.bonded && relation.visible);
  return clamp01(external.reduce((sum, relation) => sum + relation.strength, 0) / Math.max(1e-9, bonded.reduce((sum, relation) => sum + relation.strength, 0) + 1));
}
