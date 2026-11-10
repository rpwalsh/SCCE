// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { clamp01, createHasher, toJsonValue } from './primitives.js';
import { scoreBoundaryState, type BoundaryEstimatorState, type BoundaryFeatureVector } from './boundary-estimator.js';
import { encodeSegmentationAdjacencyFactors } from './segmentation-adjacency-storage.js';
import { SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, validateSegmentationAdjacencyFactors, type SegmentationAdjacencyFactors } from './segmentation-adjacency-factors.js';
import { constructionSourceExampleStorageJson as exactJson } from './construction-source-example-storage.js';
import type { SegmentationEnergyComponents, SegmentationForestBoundary, SegmentationForestUnit } from './segmentation-forest.js';
import type { Hasher } from './types.js';
import { createSourceBoundaryIntrinsicEvaluator } from './surface-lattice.js';
const MIN_PROBABILITY = 1e-9;
const quantize = (value: number): number => Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;

export const SEGMENTATION_SCORE_FACTORS_SCHEMA = "scce.segmentation_score_factors.v1" as const;
type ScoreState = [0, number, number, number] | [0, number, number, number, number] | [1, number];
type Variation = [0, number, number] | [1, number];
type Extra = [number, number, number, number, number];
export interface SegmentationScoreFactors {
  schema: typeof SEGMENTATION_SCORE_FACTORS_SCHEMA;
  nodeCount: number;
  estimator: BoundaryEstimatorState | null;
  sourceText: string;
  learned: number[][];
  repeated: number[];
  states: ScoreState[];
  baseRefs: number[];
  variations: Variation[];
  arcRefs: number[];
  extras: Extra[];
  expectedGraphDigest: string;
  digest: string;
}
export interface SegmentationScoreCaptureArc {
  unit: SegmentationForestUnit;
  anchorEnergy?: number;
  descriptionEnergy?: number;
  populationEnergy?: number;
  semanticContextEnergy?: number;
}
const INTRINSIC = ["whitespaceAdjacent", "punctuationAdjacent", "lineBreakAdjacent", "scriptTransition", "localTransitionEntropy"] as const;
const LEARNED = ["crossDocumentRecurrence", "predictiveCompressionGain", "stableSubstitutionSupport", "exactPhraseRecurrence", "constructionReuse"] as const;
const MAX_GRAPH_BYTES = 64 * 1024 * 1024;
const fail = (): never => { throw Error("invalid segmentation score factors"); };
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const clone = <T>(value: T): T => { try { return JSON.parse(exactJson(value)) as T; } catch { return fail(); } };
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function intern<T>(values: T[]) {
  const indices = new Map<string, number>();
  return (value: T): number => {
    const key = exactJson(value), previous = indices.get(key);
    if (previous !== undefined) return previous;
    const index = values.length; values.push(clone(value)); indices.set(key, index); return index;
  };
}
function graphDigest(graph: SegmentationAdjacencyFactors, hasher: Hasher): string {
  return hasher.digestHex(encodeSegmentationAdjacencyFactors(graph, MAX_GRAPH_BYTES));
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) { for (const member of Object.values(value)) freeze(member); Object.freeze(value); }
  return value;
}

/** Record frozen learned inputs; source-intrinsic features remain a pure source calculation. */
export function captureSegmentationScoreFactors(input: { graph: SegmentationAdjacencyFactors; arcs: readonly SegmentationScoreCaptureArc[];
  baseBoundaries: ReadonlyMap<number, SegmentationForestBoundary>; interiorCostPrefix: readonly number[]; estimator?: BoundaryEstimatorState;
  sourceText?: string; hasher?: Hasher }): SegmentationScoreFactors {
  const hasher = input.hasher ?? createHasher(), sourceText = input.sourceText ?? "", source = createSourceBoundaryIntrinsicEvaluator(sourceText);
  if (input.arcs.length !== input.graph.arcs.length) return fail();
  let estimator: BoundaryEstimatorState | null = null;
  if (input.estimator) { try { estimator = clone(input.estimator); } catch { estimator = null; } }
  const learned: number[][] = [], repeated: number[] = [], states: ScoreState[] = [], variations: Variation[] = [];
  const learnedRef = intern(learned), repeatedRef = intern(repeated), stateRef = intern(states), variationRef = intern(variations);
  const verified = new Map<string, boolean>();
  const boundaryRef = (boundary: SegmentationForestBoundary, position: number): number => {
    const probability = clampProbability(boundary.boundaryProbability), features = boundary.features;
    const point = boundary.positionCodePoint ?? source.graphemeCodePoints[position];
    if (estimator && features && natural(point) && point <= source.codePointCount
      && [...INTRINSIC, ...LEARNED, "repeatedContextSupport", "structuralBoundary"].every(key => finite(features[key as keyof BoundaryFeatureVector]))) {
      let key: string | undefined;
      try { key = exactJson([features, probability]); } catch { key = undefined; }
      let matches = key === undefined ? false : verified.get(key);
      if (matches === undefined) {
        try { matches = Object.is(clampProbability(scoreBoundaryState(estimator, features)), probability); } catch { matches = false; }
        verified.set(key!, matches);
      }
      const intrinsic = source.at(point);
      if (matches && INTRINSIC.every(name => Object.is(features[name], intrinsic[name]))) {
        const state: ScoreState = [0, learnedRef(LEARNED.map(name => features[name])), repeatedRef(features.repeatedContextSupport), features.structuralBoundary];
        if (point !== source.graphemeCodePoints[position]) state.push(point);
        return stateRef(state);
      }
    }
    return stateRef([1, probability]);
  };
  const baseRefs = Array.from({ length: input.graph.nodeCount }, (_, position) => boundaryRef(input.baseBoundaries.get(position)
    ?? { boundaryProbability: position === 0 || position === input.graph.nodeCount - 1 ? 1 : 0.5 }, position));
  const extras: Extra[] = [];
  const arcRefs = input.arcs.map((arc, ordinal) => {
    const [start, end] = input.graph.arcs[ordinal]!;
    if (arc.unit.graphemeStart !== start || arc.unit.graphemeEnd !== end) return fail();
    const ref = boundaryRef(end === input.graph.nodeCount - 1 ? { boundaryProbability: 1 } : arc.unit.boundaryAfter, end);
    const state = states[ref]!, base = states[baseRefs[end]!]!;
    const variation = state[0] === 0 && base[0] === 0 && state[1] === base[1] && state[4] === base[4]
      ? variationRef([0, state[2], state[3]]) : variationRef([1, ref]);
    const terms = [finiteEnergy(arc.anchorEnergy), finiteEnergy(arc.descriptionEnergy), finiteEnergy(arc.populationEnergy), finiteEnergy(arc.semanticContextEnergy)];
    if (terms.some(value => value !== 0)) extras.push([ordinal, ...terms.map(value => Object.is(value, -0) ? 0 : value)] as Extra);
    return variation;
  });
  const material = { schema: SEGMENTATION_SCORE_FACTORS_SCHEMA as typeof SEGMENTATION_SCORE_FACTORS_SCHEMA, nodeCount: input.graph.nodeCount, sourceText,
    estimator, learned, repeated, states, baseRefs, variations, arcRefs, extras, expectedGraphDigest: graphDigest(input.graph, hasher) };
  const recipe: SegmentationScoreFactors = { ...material, digest: hasher.digestHex(exactJson(material)) };
  const decoded = replaySegmentationScoreFactors(recipe, input.graph.arcs.map(([start, end]) => [start, end]), hasher);
  if (decoded.arcs.some((arc, i) => !Object.is(arc[2], input.graph.arcs[i]![2]))) return fail();
  return freeze(recipe);
}

function validated(value: unknown, topology: ReadonlyArray<readonly [number, number]>, hasher: Hasher): SegmentationScoreFactors {
  const recipe = clone(value) as SegmentationScoreFactors;
  if (!record(recipe) || Object.keys(recipe).sort().join(",") !== "arcRefs,baseRefs,digest,estimator,expectedGraphDigest,extras,learned,nodeCount,repeated,schema,sourceText,states,variations"
    || recipe.schema !== SEGMENTATION_SCORE_FACTORS_SCHEMA || !natural(recipe.nodeCount) || recipe.nodeCount < 1 || typeof recipe.digest !== "string"
    || typeof recipe.sourceText !== "string" || typeof recipe.expectedGraphDigest !== "string" || !Array.isArray(recipe.learned) || !Array.isArray(recipe.repeated)
    || !Array.isArray(recipe.states) || !Array.isArray(recipe.baseRefs) || recipe.baseRefs.length !== recipe.nodeCount || !Array.isArray(recipe.variations)
    || !Array.isArray(recipe.arcRefs) || recipe.arcRefs.length !== topology.length || !Array.isArray(recipe.extras)) return fail();
  const { digest, ...material } = recipe;
  if (hasher.digestHex(exactJson(material)) !== digest) return fail();
  const refs = (values: unknown, count: number): values is number[] => Array.isArray(values) && values.every(value => natural(value) && value < count);
  for (const vector of recipe.learned) if (!Array.isArray(vector) || vector.length !== 5 || !vector.every(finite)) return fail();
  if (!recipe.repeated.every(finite)) return fail();
  for (const state of recipe.states) {
    if (!Array.isArray(state)) return fail();
    if (state[0] === 1) { if (state.length !== 2 || !finite(state[1]) || state[1] !== clampProbability(state[1])) return fail(); }
    else if (state[0] !== 0 || (state.length !== 4 && state.length !== 5) || !natural(state[1]) || state[1] >= recipe.learned.length
      || !natural(state[2]) || state[2] >= recipe.repeated.length || !finite(state[3]) || state.length === 5 && !natural(state[4]) || !recipe.estimator) return fail();
  }
  if (!refs(recipe.baseRefs, recipe.states.length) || !refs(recipe.arcRefs, recipe.variations.length)) return fail();
  for (const variation of recipe.variations) {
    if (!Array.isArray(variation)) return fail();
    if (variation[0] === 1) { if (variation.length !== 2 || !natural(variation[1]) || variation[1] >= recipe.states.length) return fail(); }
    else if (variation[0] !== 0 || variation.length !== 3 || !natural(variation[1]) || variation[1] >= recipe.repeated.length || !finite(variation[2])) return fail();
  }
  let previous = -1;
  for (const extra of recipe.extras) {
    if (!Array.isArray(extra) || extra.length !== 5 || !natural(extra[0]) || extra[0] >= topology.length || extra[0] <= previous || !extra.slice(1).every(finite)) return fail();
    previous = extra[0];
  }
  return recipe;
}

/** No fitting, proposals or candidate search: just original source arithmetic and frozen scorer evaluation. */
export function replaySegmentationScoreFactors(value: unknown, topology: ReadonlyArray<readonly [number, number]>, hasher: Hasher = createHasher()): SegmentationAdjacencyFactors {
  const recipe = validated(value, topology, hasher), source = createSourceBoundaryIntrinsicEvaluator(recipe.sourceText), computed = new Map<string, number>();
  if (recipe.states.some(state => state[0] === 0) && source.graphemeCodePoints.length !== recipe.nodeCount) return fail();
  const score = (state: ScoreState, position: number): number => {
    if (state[0] === 1) return state[1];
    const point = state[4] ?? source.graphemeCodePoints[position];
    if (!natural(point) || point > source.codePointCount) return fail();
    const intrinsic = source.at(point), learned = recipe.learned[state[1]]!;
    const features: BoundaryFeatureVector = { whitespaceAdjacent: intrinsic.whitespaceAdjacent, punctuationAdjacent: intrinsic.punctuationAdjacent,
      lineBreakAdjacent: intrinsic.lineBreakAdjacent, scriptTransition: intrinsic.scriptTransition, structuralBoundary: state[3],
      localTransitionEntropy: intrinsic.localTransitionEntropy, repeatedContextSupport: recipe.repeated[state[2]]!,
      crossDocumentRecurrence: learned[0]!, predictiveCompressionGain: learned[1]!, stableSubstitutionSupport: learned[2]!, exactPhraseRecurrence: learned[3]!, constructionReuse: learned[4]! };
    const key = JSON.stringify(features), previous = computed.get(key); if (previous !== undefined) return previous;
    const probability = scoreBoundaryState(recipe.estimator!, features); computed.set(key, probability); return probability;
  };
  const base = recipe.baseRefs.map(ref => recipe.states[ref]!);
  const probabilities = new Map(base.map((state, position) => [position, clampProbability(score(state, position))]));
  const prefix = nonBoundaryCostPrefix(probabilities, recipe.nodeCount - 1), extras = new Map(recipe.extras.map(extra => [extra[0], extra]));
  const arcs = topology.map(([start, end], ordinal) => {
    if (!natural(start) || !natural(end) || start >= end || end >= recipe.nodeCount) return fail();
    const variation = recipe.variations[recipe.arcRefs[ordinal]!]!;
    let probability: number;
    if (variation[0] === 1) probability = score(recipe.states[variation[1]]!, end);
    else {
      const state = base[end]!; if (state[0] !== 0) return fail();
      const varied: ScoreState = [0, state[1], variation[1], variation[2]];
      if (state[4] !== undefined) varied.push(state[4]);
      probability = score(varied, end);
    }
    const extra = extras.get(ordinal);
    const energy = segmentationArcEnergy({ unit: { graphemeStart: start, graphemeEnd: end, boundaryAfter: { boundaryProbability: probability } }, interiorCostPrefix: prefix,
      graphemeCount: recipe.nodeCount - 1, anchorEnergy: extra?.[1], descriptionEnergy: extra?.[2], populationEnergy: extra?.[3], semanticContextEnergy: extra?.[4] }).total;
    return [start, end, energy] as const;
  });
  const graph: SegmentationAdjacencyFactors = { schema: SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, nodeCount: recipe.nodeCount, arcs };
  validateSegmentationAdjacencyFactors(graph);
  if (graphDigest(graph, hasher) !== recipe.expectedGraphDigest) return fail();
  return graph;
}

export function validateSegmentationScoreFactors(value: unknown, graph: SegmentationAdjacencyFactors, hasher: Hasher = createHasher()): asserts value is SegmentationScoreFactors {
  const decoded = replaySegmentationScoreFactors(value, graph.arcs.map(([start, end]) => [start, end]), hasher);
  if (decoded.nodeCount !== graph.nodeCount || decoded.arcs.some((arc, i) => !Object.is(arc[2], graph.arcs[i]![2]))) return fail();
}

/** Exact byte comparison against the durable adapter's two public wire shapes, including escaping and base64. */
export function segmentationScoreStorageWireSizes(graph: SegmentationAdjacencyFactors, recipe: SegmentationScoreFactors): { original: number; scored: number } {
  const original = encodeSegmentationAdjacencyFactors(graph, MAX_GRAPH_BYTES), topology = encodeSegmentationAdjacencyFactors({ ...graph, arcs: graph.arcs.map(([start, end]) => [start, end, 0]) }, MAX_GRAPH_BYTES);
  const oldShape = { schema: "scce.segmentation_graph.storage.v1", data: "x".repeat(Math.ceil(original.length / 3) * 4), digest: "0".repeat(64) };
  const newShape = { schema: "scce.segmentation_score_graph.storage.v1", topology: "x".repeat(Math.ceil(topology.length / 3) * 4), topologyDigest: "0".repeat(64), recipe: JSON.stringify(recipe) };
  const encoder = new TextEncoder();
  return { original: encoder.encode(JSON.stringify(oldShape)).byteLength, scored: encoder.encode(JSON.stringify(newShape)).byteLength };
}
/** Signed proof inputs must survive the existing memory JSON normalization unchanged. */
export function segmentationScoreFactorsCanonicalSafe(recipe: SegmentationScoreFactors): boolean {
  try { return exactJson(toJsonValue(recipe)) === exactJson(recipe); } catch { return false; }
}

export function segmentationArcEnergy(input: {
  unit: Pick<SegmentationForestUnit, "graphemeStart" | "graphemeEnd" | "boundaryAfter">;
  interiorCostPrefix: readonly number[];
  graphemeCount: number;
  anchorEnergy?: number;
  descriptionEnergy?: number;
  populationEnergy?: number;
  semanticContextEnergy?: number;
}): SegmentationEnergyComponents {
  const selectedEndProbability = input.unit.graphemeEnd === input.graphemeCount
    ? 1
    : clampProbability(input.unit.boundaryAfter.boundaryProbability);
  const internalStart = input.unit.graphemeStart + 1;
  const continuation = (input.interiorCostPrefix[input.unit.graphemeEnd] ?? 0)
    - (input.interiorCostPrefix[internalStart] ?? 0);
  const components = {
    boundary: -Math.log(selectedEndProbability),
    continuation,
    anchor: finiteEnergy(input.anchorEnergy),
    description: finiteEnergy(input.descriptionEnergy),
    population: finiteEnergy(input.populationEnergy),
    semanticContext: finiteEnergy(input.semanticContextEnergy)
  };
  return quantizeEnergy({
    ...components,
    total: Object.values(components).reduce((sum, value) => sum + value, 0)
  });
}

export function nonBoundaryCostPrefix(
  boundaryProbability: ReadonlyMap<number, number>,
  graphemeCount: number
): number[] {
  const prefix = new Array<number>(graphemeCount + 1).fill(0);
  for (let position = 0; position < graphemeCount; position += 1) {
    const cost = position === 0
      ? 0
      : -Math.log(clampProbability(1 - (boundaryProbability.get(position) ?? 0.5)));
    prefix[position + 1] = prefix[position]! + cost;
  }
  return prefix;
}

export function quantizeEnergy(energy: SegmentationEnergyComponents): SegmentationEnergyComponents {
  return {
    boundary: quantize(energy.boundary),
    continuation: quantize(energy.continuation),
    anchor: quantize(energy.anchor),
    description: quantize(energy.description),
    population: quantize(energy.population),
    semanticContext: quantize(energy.semanticContext),
    total: quantize(energy.total)
  };
}

export function clampProbability(value: number): number {
  return Math.min(1 - MIN_PROBABILITY, Math.max(MIN_PROBABILITY, clamp01(value)));
}

export function finiteEnergy(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) throw new Error("segmentation energy term must be finite");
  return value;
}
