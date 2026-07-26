import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";
import { canonicalNormalizationContract } from "./normalization-contract.js";

export const SEGMENTATION_FOREST_SCHEMA = "scce.segmentation_forest.v1" as const;

export interface SegmentationForestBoundary {
  boundaryProbability: number;
}

export interface SegmentationForestUnit {
  id: string;
  kind: string;
  overlapClass: "base_partition" | "segmentation_alternative" | "structure";
  graphemeStart: number;
  graphemeEnd: number;
  recurrenceCount: number;
  predictability: number;
  boundaryBefore: SegmentationForestBoundary;
  boundaryAfter: SegmentationForestBoundary;
}

export interface SurfaceSegmentationPath {
  id: string;
  unitIds: string[];
  energy: number;
  posterior: number;
}

export interface SegmentationBoundaryMarginal {
  positionGrapheme: number;
  boundaryProbability: number;
}

export interface SurfaceSegmentationForest {
  schema: typeof SEGMENTATION_FOREST_SCHEMA;
  id: string;
  latticeId: string;
  estimatorId: string;
  normalizationContractId: string;
  graphemeCount: number;
  pathLimit: number;
  paths: SurfaceSegmentationPath[];
  partitionLogZ: number;
  retainedPosteriorMass: number;
  boundaryMarginals: SegmentationBoundaryMarginal[];
  audit: JsonValue;
}

interface PathState {
  unitIds: string[];
  energy: number;
}

interface WeightedArc {
  unit: SegmentationForestUnit;
  energy: number;
}

const MIN_PROBABILITY = 1e-9;

/**
 * Compiles a bounded k-best view over the complete segmentation DAG. The
 * partition function is calculated over every retained lattice arc, not only
 * over the returned paths, so retainedPosteriorMass exposes pruning loss.
 */
export function buildSegmentationForest(input: {
  latticeId: string;
  estimatorId: string;
  units: readonly SegmentationForestUnit[];
  pathLimit?: number;
  normalizationContractId?: string;
  hasher?: Hasher;
}): SurfaceSegmentationForest {
  const hasher = input.hasher ?? createHasher();
  const pathLimit = Math.max(1, Math.min(64, Math.floor(input.pathLimit ?? 8)));
  const normalizationContractId = input.normalizationContractId
    ?? canonicalNormalizationContract(hasher).id;
  const graphemeCount = input.units
    .filter(unit => unit.overlapClass === "base_partition")
    .reduce((maximum, unit) => Math.max(maximum, unit.graphemeEnd), 0);
  const boundaryProbability = boundaryProbabilityByPosition(input.units, graphemeCount);
  const interiorCostPrefix = nonBoundaryCostPrefix(boundaryProbability, graphemeCount);
  const arcsByStart = new Map<number, WeightedArc[]>();

  for (const unit of input.units) {
    if (unit.overlapClass === "structure"
      || unit.graphemeStart < 0
      || unit.graphemeEnd <= unit.graphemeStart
      || unit.graphemeEnd > graphemeCount) {
      continue;
    }
    const arc: WeightedArc = {
      unit,
      energy: segmentationArcEnergy(unit, interiorCostPrefix, graphemeCount)
    };
    const bucket = arcsByStart.get(unit.graphemeStart) ?? [];
    bucket.push(arc);
    arcsByStart.set(unit.graphemeStart, bucket);
  }
  for (const bucket of arcsByStart.values()) {
    bucket.sort((left, right) =>
      left.unit.graphemeEnd - right.unit.graphemeEnd
      || left.energy - right.energy
      || left.unit.id.localeCompare(right.unit.id));
  }

  const kBest: PathState[][] = Array.from(
    { length: graphemeCount + 1 },
    () => [] as PathState[]
  );
  kBest[0] = [{ unitIds: [], energy: 0 }];
  const logPartition = new Array<number>(graphemeCount + 1).fill(Number.NEGATIVE_INFINITY);
  logPartition[0] = 0;

  for (let position = 0; position <= graphemeCount; position += 1) {
    const arcs = arcsByStart.get(position) ?? [];
    if (arcs.length === 0) continue;
    for (const arc of arcs) {
      const next = arc.unit.graphemeEnd;
      logPartition[next] = logAddExp(logPartition[next]!, logPartition[position]! - arc.energy);
      if (kBest[position]!.length === 0) continue;
      const candidates = [
        ...kBest[next]!,
        ...kBest[position]!.map(path => ({
          unitIds: [...path.unitIds, arc.unit.id],
          energy: quantize(path.energy + arc.energy)
        }))
      ];
      candidates.sort(comparePathStates);
      kBest[next] = uniquePaths(candidates).slice(0, pathLimit);
    }
  }

  const partitionLogZ = finiteOrZero(logPartition[graphemeCount]!);
  const logBackward = new Array<number>(graphemeCount + 1).fill(Number.NEGATIVE_INFINITY);
  logBackward[graphemeCount] = 0;
  for (let position = graphemeCount - 1; position >= 0; position -= 1) {
    for (const arc of arcsByStart.get(position) ?? []) {
      logBackward[position] = logAddExp(
        logBackward[position]!,
        -arc.energy + logBackward[arc.unit.graphemeEnd]!
      );
    }
  }
  const boundaryMass = new Array<number>(graphemeCount + 1).fill(0);
  boundaryMass[0] = 1;
  if (Number.isFinite(logPartition[graphemeCount]!)) {
    for (let position = 0; position < graphemeCount; position += 1) {
      if (!Number.isFinite(logPartition[position]!)) continue;
      for (const arc of arcsByStart.get(position) ?? []) {
        const suffix = logBackward[arc.unit.graphemeEnd]!;
        if (!Number.isFinite(suffix)) continue;
        const posterior = Math.exp(
          logPartition[position]! - arc.energy + suffix - logPartition[graphemeCount]!
        );
        boundaryMass[arc.unit.graphemeEnd] = boundaryMass[arc.unit.graphemeEnd]! + posterior;
      }
    }
  }
  const boundaryMarginals = boundaryMass.map((probability, positionGrapheme) => ({
    positionGrapheme,
    boundaryProbability: quantize(clamp01(probability))
  }));
  const paths = kBest[graphemeCount]!.map(path => {
    const canonical = {
      latticeId: input.latticeId,
      normalizationContractId,
      unitIds: path.unitIds,
      energy: path.energy
    };
    return {
      id: `segmentation_path.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
      unitIds: path.unitIds,
      energy: path.energy,
      posterior: quantize(Math.exp(-path.energy - partitionLogZ))
    };
  });
  const retainedPosteriorMass = quantize(clamp01(paths.reduce((sum, path) => sum + path.posterior, 0)));
  const canonical = {
    schema: SEGMENTATION_FOREST_SCHEMA,
    latticeId: input.latticeId,
    estimatorId: input.estimatorId,
    normalizationContractId,
    graphemeCount,
    pathLimit,
    paths,
    partitionLogZ: quantize(partitionLogZ),
    retainedPosteriorMass,
    boundaryMarginals
  };
  return {
    ...canonical,
    id: `segmentation_forest.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.segmentation_forest.v1",
      normalizationContractId,
      completeDagPartition: true,
      packedDynamicProgramming: true,
      exactForwardBackwardMarginals: true,
      unexplainedArcCoefficients: false,
      candidateArcs: [...arcsByStart.values()].reduce((sum, arcs) => sum + arcs.length, 0),
      returnedPaths: paths.length
    })
  };
}

function boundaryProbabilityByPosition(
  units: readonly SegmentationForestUnit[],
  graphemeCount: number
): Map<number, number> {
  const out = new Map<number, number>([[0, 1], [graphemeCount, 1]]);
  for (const unit of units) {
    if (unit.overlapClass !== "base_partition") continue;
    out.set(unit.graphemeStart, clampProbability(unit.boundaryBefore.boundaryProbability));
    out.set(unit.graphemeEnd, clampProbability(unit.boundaryAfter.boundaryProbability));
  }
  return out;
}

function segmentationArcEnergy(
  unit: SegmentationForestUnit,
  interiorCostPrefix: readonly number[],
  graphemeCount: number
): number {
  const selectedEndProbability = unit.graphemeEnd === graphemeCount
    ? 1
    : clampProbability(unit.boundaryAfter.boundaryProbability);
  const internalStart = unit.graphemeStart + 1;
  const internalCost = (interiorCostPrefix[unit.graphemeEnd] ?? 0)
    - (interiorCostPrefix[internalStart] ?? 0);
  return quantize(-Math.log(selectedEndProbability) + internalCost);
}

function nonBoundaryCostPrefix(
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

function uniquePaths(paths: readonly PathState[]): PathState[] {
  const seen = new Set<string>();
  const out: PathState[] = [];
  for (const path of paths) {
    const key = path.unitIds.join("\u001f");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(path);
  }
  return out;
}

function comparePathStates(left: PathState, right: PathState): number {
  return left.energy - right.energy
    || left.unitIds.length - right.unitIds.length
    || left.unitIds.join("\u001f").localeCompare(right.unitIds.join("\u001f"));
}

function logAddExp(left: number, right: number): number {
  if (left === Number.NEGATIVE_INFINITY) return right;
  if (right === Number.NEGATIVE_INFINITY) return left;
  const maximum = Math.max(left, right);
  return maximum + Math.log(Math.exp(left - maximum) + Math.exp(right - maximum));
}

function clampProbability(value: number): number {
  return Math.min(1 - MIN_PROBABILITY, Math.max(MIN_PROBABILITY, clamp01(value)));
}

function finiteOrZero(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
