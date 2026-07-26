import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type {
  SparseAlignmentCandidate,
  SparseAlignmentCandidateSupport
} from "./sparse-alignment-candidates.js";
import type { Hasher, JsonValue } from "./types.js";

export const POPULATION_ORDERING_MODEL_SCHEMA =
  "scce.population_relative_order_model.v1" as const;

export interface PopulationRelativeOrderEstimate {
  populationId: string;
  leftGraphTargetId: string;
  rightGraphTargetId: string;
  location: number;
  robustScale: number;
  observationWeight: number;
  observationCount: number;
}

export interface PopulationOrderingModel {
  schema: typeof POPULATION_ORDERING_MODEL_SCHEMA;
  id: string;
  trainingSupportIds: string[];
  estimates: PopulationRelativeOrderEstimate[];
  globalBackoff: PopulationRelativeOrderEstimate[];
  audit: JsonValue;
}

export interface PopulationOrderingExpectation {
  location: number;
  robustScale: number;
  supportedPosteriorMass: number;
  source: "population" | "global_backoff" | "unresolved";
}

interface OrderObservation {
  populationId: string;
  leftGraphTargetId: string;
  rightGraphTargetId: string;
  delta: number;
  weight: number;
}

export function compilePopulationOrderingModel(input: {
  supports: readonly SparseAlignmentCandidateSupport[];
  maxSurfaceNeighbors?: number;
  hasher?: Hasher;
}): PopulationOrderingModel {
  const hasher = input.hasher ?? createHasher();
  const maxSurfaceNeighbors = bounded(input.maxSurfaceNeighbors, 1, 32, 8);
  const observations = input.supports.flatMap(support =>
    orderingObservations(support, maxSurfaceNeighbors));
  const estimates = compileEstimates(observations);
  const globalBackoff = compileEstimates(observations.map(observation => ({
    ...observation,
    populationId: "population.__global__"
  })));
  const trainingSupportIds = [...new Set(input.supports.map(support => support.id))].sort();
  const canonical = {
    schema: POPULATION_ORDERING_MODEL_SCHEMA,
    trainingSupportIds,
    estimates,
    globalBackoff
  };
  return {
    ...canonical,
    id: `population_order.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.population_relative_order.source_exact_huber.v1",
      trainingSupportCount: trainingSupportIds.length,
      observationCount: observations.length,
      populationCount: new Set(estimates.map(estimate => estimate.populationId)).size,
      estimateCount: estimates.length,
      maxSurfaceNeighbors,
      languageLabelsUsed: false,
      traditionalGrammarLabelsUsed: false,
      sourceExactAnchorsOnly: true,
      calibratedConfidenceClaimed: false
    })
  };
}

export function populationOrderingExpectation(input: {
  model: PopulationOrderingModel;
  populationPosterior: readonly { populationId: string; probability: number }[];
  leftGraphTargetId: string;
  rightGraphTargetId: string;
}): PopulationOrderingExpectation {
  const byPopulation = new Map(input.model.estimates
    .filter(estimate =>
      estimate.leftGraphTargetId === input.leftGraphTargetId
      && estimate.rightGraphTargetId === input.rightGraphTargetId)
    .map(estimate => [estimate.populationId, estimate]));
  let supportedPosteriorMass = 0;
  let location = 0;
  let scale = 0;
  for (const component of input.populationPosterior) {
    const estimate = byPopulation.get(component.populationId);
    if (!estimate || component.probability <= 0) continue;
    supportedPosteriorMass += component.probability;
    location += component.probability * estimate.location;
    scale += component.probability * estimate.robustScale;
  }
  if (supportedPosteriorMass > 0) {
    return {
      location: location / supportedPosteriorMass,
      robustScale: Math.max(1e-6, scale / supportedPosteriorMass),
      supportedPosteriorMass,
      source: "population"
    };
  }
  const fallback = input.model.globalBackoff.find(estimate =>
    estimate.leftGraphTargetId === input.leftGraphTargetId
    && estimate.rightGraphTargetId === input.rightGraphTargetId);
  return fallback
    ? {
      location: fallback.location,
      robustScale: Math.max(1e-6, fallback.robustScale),
      supportedPosteriorMass: 0,
      source: "global_backoff"
    }
    : {
      location: 0,
      robustScale: 1,
      supportedPosteriorMass: 0,
      source: "unresolved"
    };
}

function orderingObservations(
  support: SparseAlignmentCandidateSupport,
  maxSurfaceNeighbors: number
): OrderObservation[] {
  const anchors = uniqueExactAnchors(support.candidates);
  const extent = Math.max(
    1,
    ...anchors.map(anchor => anchor.sourceCoordinates.codePointEnd)
  );
  const observations: OrderObservation[] = [];
  for (let left = 0; left < anchors.length; left++) {
    for (let right = left + 1;
      right < Math.min(anchors.length, left + 1 + maxSurfaceNeighbors);
      right++) {
      const first = anchors[left]!;
      const second = anchors[right]!;
      if (first.graphTargetId === second.graphTargetId
        || !surfaceCompatible(first, second)) continue;
      const delta = quantize((center(second) - center(first)) / extent);
      for (const population of support.populationPosterior) {
        if (population.probability <= 0) continue;
        observations.push({
          populationId: population.populationId,
          leftGraphTargetId: first.graphTargetId,
          rightGraphTargetId: second.graphTargetId,
          delta,
          weight: population.probability
        });
        observations.push({
          populationId: population.populationId,
          leftGraphTargetId: second.graphTargetId,
          rightGraphTargetId: first.graphTargetId,
          delta: -delta,
          weight: population.probability
        });
      }
    }
  }
  return observations;
}

function uniqueExactAnchors(
  candidates: readonly SparseAlignmentCandidate[]
): SparseAlignmentCandidate[] {
  const unique = new Map<string, SparseAlignmentCandidate>();
  for (const candidate of candidates) {
    if (!candidate.supportKinds.includes("exact_observable_anchor")) continue;
    const key = [
      candidate.sourceCoordinates.codePointStart,
      candidate.sourceCoordinates.codePointEnd,
      candidate.graphTargetId
    ].join("\u001f");
    const existing = unique.get(key);
    if (!existing || candidate.id.localeCompare(existing.id) < 0) {
      unique.set(key, candidate);
    }
  }
  return [...unique.values()].sort((left, right) =>
    center(left) - center(right)
    || left.graphTargetId.localeCompare(right.graphTargetId)
    || left.id.localeCompare(right.id));
}

function compileEstimates(
  observations: readonly OrderObservation[]
): PopulationRelativeOrderEstimate[] {
  const groups = new Map<string, OrderObservation[]>();
  for (const observation of observations) {
    const key = [
      observation.populationId,
      observation.leftGraphTargetId,
      observation.rightGraphTargetId
    ].join("\u001f");
    const existing = groups.get(key) ?? [];
    existing.push(observation);
    groups.set(key, existing);
  }
  return [...groups.values()].map(group => {
    const location = robustLocation(group);
    const totalWeight = group.reduce((sum, observation) => sum + observation.weight, 0);
    const robustScale = totalWeight > 0
      ? group.reduce((sum, observation) =>
        sum + observation.weight * Math.abs(observation.delta - location), 0)
        / totalWeight
      : 1;
    return {
      populationId: group[0]!.populationId,
      leftGraphTargetId: group[0]!.leftGraphTargetId,
      rightGraphTargetId: group[0]!.rightGraphTargetId,
      location: quantize(location),
      robustScale: quantize(Math.max(1e-6, robustScale)),
      observationWeight: quantize(totalWeight),
      observationCount: group.length
    };
  }).sort((left, right) =>
    left.populationId.localeCompare(right.populationId)
    || left.leftGraphTargetId.localeCompare(right.leftGraphTargetId)
    || left.rightGraphTargetId.localeCompare(right.rightGraphTargetId));
}

function robustLocation(observations: readonly OrderObservation[]): number {
  const totalWeight = observations.reduce(
    (sum, observation) => sum + observation.weight,
    0
  );
  if (totalWeight <= 0) return 0;
  let location = observations.reduce((sum, observation) =>
    sum + observation.weight * observation.delta, 0) / totalWeight;
  for (let iteration = 0; iteration < 8; iteration++) {
    const scale = Math.max(
      1e-3,
      observations.reduce((sum, observation) =>
        sum + observation.weight * Math.abs(observation.delta - location), 0)
        / totalWeight
    );
    let numerator = 0;
    let denominator = 0;
    for (const observation of observations) {
      const residual = Math.abs(observation.delta - location);
      const robustWeight = observation.weight * Math.min(1, 1.345 * scale
        / Math.max(1e-12, residual));
      numerator += robustWeight * observation.delta;
      denominator += robustWeight;
    }
    const next = denominator > 0 ? numerator / denominator : location;
    if (Math.abs(next - location) <= 1e-9) break;
    location = next;
  }
  return location;
}

function center(candidate: SparseAlignmentCandidate): number {
  return (candidate.sourceCoordinates.codePointStart
    + candidate.sourceCoordinates.codePointEnd) / 2;
}

function surfaceCompatible(
  left: SparseAlignmentCandidate,
  right: SparseAlignmentCandidate
): boolean {
  return left.sourceCoordinates.codePointEnd <= right.sourceCoordinates.codePointStart
    || right.sourceCoordinates.codePointEnd <= left.sourceCoordinates.codePointStart;
}

function bounded(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)));
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
