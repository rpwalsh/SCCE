import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";
import { canonicalNormalizationContract } from "./normalization-contract.js";

export const SEGMENTATION_FOREST_SCHEMA = "scce.segmentation_forest.v2" as const;

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

export interface SegmentationEnergyComponents {
  boundary: number;
  continuation: number;
  anchor: number;
  description: number;
  population: number;
  semanticContext: number;
  total: number;
}

export interface SurfaceSegmentationPath {
  id: string;
  unitIds: string[];
  energy: number;
  energyTrace: SegmentationEnergyComponents;
  posterior: number;
}

export interface SegmentationBoundaryMarginal {
  positionGrapheme: number;
  boundaryProbability: number;
}

export interface SegmentationForestLimits {
  maxArcsPerCoordinate: number;
  maxTotalStates: number;
  maxOutgoingAlternatives: number;
  maxRetainedDerivations: number;
  maxResidualPosteriorMass: number;
  maxConstructionDepth: number;
}

export interface SegmentationForestResumeState {
  token: string;
  reasonIds: string[];
  nextDerivationRank: number;
  retainedPathIds: string[];
  fullPartitionLogZ: number;
  activePartitionLogZ: number;
}

export interface SurfaceSegmentationForest {
  schema: typeof SEGMENTATION_FOREST_SCHEMA;
  id: string;
  latticeId: string;
  estimatorId: string;
  normalizationContractId: string;
  graphemeCount: number;
  pathLimit: number;
  limits: SegmentationForestLimits;
  paths: SurfaceSegmentationPath[];
  partitionLogZ: number;
  activePartitionLogZ: number;
  retainedPosteriorMass: number;
  omittedPosteriorMass: number;
  prunedArcPosteriorMass: number;
  unretainedDerivationMass: number;
  boundaryMarginals: SegmentationBoundaryMarginal[];
  completion: "complete_within_limits" | "resumable";
  resumeState?: SegmentationForestResumeState;
  audit: JsonValue;
}

export interface SegmentationForestBuildInput {
  latticeId: string;
  estimatorId: string;
  units: readonly SegmentationForestUnit[];
  pathLimit?: number;
  limits?: Partial<SegmentationForestLimits>;
  anchorEnergyByUnitId?: Readonly<Record<string, number>>;
  descriptionEnergyByUnitId?: Readonly<Record<string, number>>;
  populationEnergyByUnitId?: Readonly<Record<string, number>>;
  semanticContextEnergyByUnitId?: Readonly<Record<string, number>>;
  normalizationContractId?: string;
  hasher?: Hasher;
}

interface PathState {
  unitIds: string[];
  energy: number;
  energyTrace: SegmentationEnergyComponents;
}

interface WeightedArc {
  unit: SegmentationForestUnit;
  energy: number;
  energyTrace: SegmentationEnergyComponents;
}

const MIN_PROBABILITY = 1e-9;
const DEFAULT_LIMITS: SegmentationForestLimits = {
  maxArcsPerCoordinate: 128,
  maxTotalStates: 262_144,
  maxOutgoingAlternatives: 64,
  maxRetainedDerivations: 16,
  maxResidualPosteriorMass: 0.05,
  maxConstructionDepth: 256
};

/**
 * Compiles a probability-normalized segmentation forest. The full partition and
 * boundary marginals are evaluated over every valid lattice arc. Operational
 * limits are then applied for k-best materialization, while all returned path
 * probabilities remain relative to the full partition.
 */
export function buildSegmentationForest(input: SegmentationForestBuildInput): SurfaceSegmentationForest {
  const hasher = input.hasher ?? createHasher();
  const normalizationContractId = input.normalizationContractId
    ?? canonicalNormalizationContract(hasher).id;
  const graphemeCount = input.units
    .filter(unit => unit.overlapClass === "base_partition")
    .reduce((maximum, unit) => Math.max(maximum, unit.graphemeEnd), 0);
  const requestedPathLimit = Math.max(1, Math.floor(
    input.pathLimit ?? input.limits?.maxRetainedDerivations ?? DEFAULT_LIMITS.maxRetainedDerivations
  ));
  const limits = normalizeLimits(input.limits, graphemeCount, requestedPathLimit);
  const boundaryProbability = boundaryProbabilityByPosition(input.units, graphemeCount);
  const interiorCostPrefix = nonBoundaryCostPrefix(boundaryProbability, graphemeCount);
  const allArcsByStart = new Map<number, WeightedArc[]>();

  for (const unit of input.units) {
    if (unit.overlapClass === "structure"
      || unit.graphemeStart < 0
      || unit.graphemeEnd <= unit.graphemeStart
      || unit.graphemeEnd > graphemeCount) {
      continue;
    }
    const energyTrace = segmentationArcEnergy({
      unit,
      interiorCostPrefix,
      graphemeCount,
      anchorEnergy: input.anchorEnergyByUnitId?.[unit.id],
      descriptionEnergy: input.descriptionEnergyByUnitId?.[unit.id],
      populationEnergy: input.populationEnergyByUnitId?.[unit.id],
      semanticContextEnergy: input.semanticContextEnergyByUnitId?.[unit.id]
    });
    const bucket = allArcsByStart.get(unit.graphemeStart) ?? [];
    bucket.push({ unit, energy: energyTrace.total, energyTrace });
    allArcsByStart.set(unit.graphemeStart, bucket);
  }
  for (const bucket of allArcsByStart.values()) bucket.sort(compareArcs);

  const fullForward = forwardPartition(allArcsByStart, graphemeCount);
  const fullPartitionLogZ = fullForward[graphemeCount]!;
  const fullBackward = backwardPartition(allArcsByStart, graphemeCount);
  const boundaryMarginals = compileBoundaryMarginals({
    arcsByStart: allArcsByStart,
    forward: fullForward,
    backward: fullBackward,
    partitionLogZ: fullPartitionLogZ,
    graphemeCount
  });

  const pruning = pruneArcs(allArcsByStart, graphemeCount, limits);
  const arcsByStart = pruning.arcsByStart;
  const activeForward = forwardPartition(arcsByStart, graphemeCount);
  const activePartitionLogZ = activeForward[graphemeCount]!;
  const statePathLimit = Math.max(1, Math.min(
    limits.maxRetainedDerivations,
    Math.floor((limits.maxTotalStates - 1) / Math.max(1, graphemeCount))
  ));
  const pathLimit = Math.max(1, Math.min(requestedPathLimit, statePathLimit));
  const kBest = compileKBest(arcsByStart, graphemeCount, pathLimit);
  const normalizedFullLogZ = finiteOrZero(fullPartitionLogZ);
  const paths = kBest.map(path => {
    const canonical = {
      latticeId: input.latticeId,
      normalizationContractId,
      unitIds: path.unitIds,
      energy: path.energy,
      energyTrace: path.energyTrace
    };
    return {
      id: `segmentation_path.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
      unitIds: path.unitIds,
      energy: path.energy,
      energyTrace: path.energyTrace,
      posterior: quantize(Number.isFinite(fullPartitionLogZ)
        ? Math.exp(-path.energy - fullPartitionLogZ)
        : 0)
    };
  });
  const retainedPosteriorMass = quantize(clamp01(
    paths.reduce((sum, path) => sum + path.posterior, 0)
  ));
  const activePosteriorMass = Number.isFinite(fullPartitionLogZ)
    && Number.isFinite(activePartitionLogZ)
    ? clamp01(Math.exp(activePartitionLogZ - fullPartitionLogZ))
    : 0;
  const prunedArcPosteriorMass = quantize(clamp01(1 - activePosteriorMass));
  const unretainedDerivationMass = quantize(clamp01(activePosteriorMass - retainedPosteriorMass));
  const omittedPosteriorMass = quantize(clamp01(1 - retainedPosteriorMass));
  const reasonIds = [
    ...(pruning.arcsPruned > 0 ? ["segmentation.limit.arcs"] : []),
    ...(pruning.depthPruned > 0 ? ["segmentation.limit.construction_depth"] : []),
    ...(statePathLimit < requestedPathLimit ? ["segmentation.limit.total_states"] : []),
    ...(pathLimit < requestedPathLimit ? ["segmentation.limit.retained_derivations"] : []),
    ...(omittedPosteriorMass > limits.maxResidualPosteriorMass
      ? ["segmentation.limit.residual_posterior_mass"]
      : [])
  ];
  const completion: SurfaceSegmentationForest["completion"] = reasonIds.length
    ? "resumable"
    : "complete_within_limits";
  const resumeCanonical = {
    latticeId: input.latticeId,
    estimatorId: input.estimatorId,
    normalizationContractId,
    requestedPathLimit,
    limits,
    reasonIds,
    nextDerivationRank: paths.length,
    retainedPathIds: paths.map(path => path.id),
    fullPartitionLogZ: quantize(normalizedFullLogZ),
    activePartitionLogZ: quantize(finiteOrZero(activePartitionLogZ))
  };
  const resumeState: SegmentationForestResumeState | undefined = completion === "resumable"
    ? {
      token: `segmentation_resume.${hasher.digestHex(JSON.stringify(resumeCanonical)).slice(0, 40)}`,
      reasonIds,
      nextDerivationRank: paths.length,
      retainedPathIds: paths.map(path => path.id),
      fullPartitionLogZ: quantize(normalizedFullLogZ),
      activePartitionLogZ: quantize(finiteOrZero(activePartitionLogZ))
    }
    : undefined;
  const canonical = {
    schema: SEGMENTATION_FOREST_SCHEMA,
    latticeId: input.latticeId,
    estimatorId: input.estimatorId,
    normalizationContractId,
    graphemeCount,
    pathLimit,
    limits,
    paths,
    partitionLogZ: quantize(normalizedFullLogZ),
    activePartitionLogZ: quantize(finiteOrZero(activePartitionLogZ)),
    retainedPosteriorMass,
    omittedPosteriorMass,
    prunedArcPosteriorMass,
    unretainedDerivationMass,
    boundaryMarginals,
    completion,
    ...(resumeState ? { resumeState } : {})
  };
  return {
    ...canonical,
    id: `segmentation_forest.${hasher.digestHex(JSON.stringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.segmentation_forest.v2",
      normalizationContractId,
      probabilityModel: "globally_normalized_energy",
      completeDagPartition: true,
      packedDynamicProgramming: true,
      exactForwardBackwardMarginals: true,
      pathPosteriorDenominator: "full_unpruned_partition",
      retainedAlternativesRenormalized: false,
      energyTermsTraced: [
        "boundary",
        "continuation",
        "anchor",
        "description",
        "population",
        "semanticContext"
      ],
      unexplainedArcCoefficients: false,
      candidateArcs: countArcs(allArcsByStart),
      activeArcs: countArcs(arcsByStart),
      arcsPruned: pruning.arcsPruned,
      constructionDepthArcsPruned: pruning.depthPruned,
      materializedStates: 1 + graphemeCount * pathLimit,
      returnedPaths: paths.length,
      omittedPosteriorMass,
      completion
    })
  };
}

/**
 * Deterministically resumes a bounded forest by rebuilding the same immutable
 * lattice with expanded materialization limits. The continuation token prevents
 * accidentally resuming a different forest or stale frontier.
 */
export function resumeSegmentationForest(input: {
  previous: SurfaceSegmentationForest;
  resumeToken: string;
  build: SegmentationForestBuildInput;
}): SurfaceSegmentationForest {
  if (input.previous.completion !== "resumable" || !input.previous.resumeState) {
    throw new Error("segmentation forest has no resumable state");
  }
  if (input.resumeToken !== input.previous.resumeState.token) {
    throw new Error("segmentation resume token mismatch");
  }
  if (input.build.latticeId !== input.previous.latticeId
    || input.build.estimatorId !== input.previous.estimatorId
    || (input.build.normalizationContractId
      && input.build.normalizationContractId !== input.previous.normalizationContractId)) {
    throw new Error("segmentation resume input does not match previous forest identity");
  }
  const resumed = buildSegmentationForest(input.build);
  const expanded = resumed.limits.maxArcsPerCoordinate >= input.previous.limits.maxArcsPerCoordinate
    && resumed.limits.maxTotalStates >= input.previous.limits.maxTotalStates
    && resumed.limits.maxOutgoingAlternatives >= input.previous.limits.maxOutgoingAlternatives
    && resumed.limits.maxRetainedDerivations >= input.previous.limits.maxRetainedDerivations
    && resumed.limits.maxResidualPosteriorMass <= input.previous.limits.maxResidualPosteriorMass
    && resumed.limits.maxConstructionDepth >= input.previous.limits.maxConstructionDepth;
  if (!expanded || resumed.paths.length < input.previous.paths.length) {
    throw new Error("segmentation resume must preserve or expand every materialization bound");
  }
  return resumed;
}

function normalizeLimits(
  input: Partial<SegmentationForestLimits> | undefined,
  graphemeCount: number,
  requestedPathLimit: number
): SegmentationForestLimits {
  return {
    maxArcsPerCoordinate: boundedInteger(
      input?.maxArcsPerCoordinate,
      1,
      4096,
      DEFAULT_LIMITS.maxArcsPerCoordinate
    ),
    maxTotalStates: boundedInteger(
      input?.maxTotalStates,
      graphemeCount + 1,
      10_000_000,
      Math.max(DEFAULT_LIMITS.maxTotalStates, graphemeCount + 1)
    ),
    maxOutgoingAlternatives: boundedInteger(
      input?.maxOutgoingAlternatives,
      1,
      4096,
      DEFAULT_LIMITS.maxOutgoingAlternatives
    ),
    maxRetainedDerivations: boundedInteger(
      input?.maxRetainedDerivations,
      1,
      1024,
      Math.max(DEFAULT_LIMITS.maxRetainedDerivations, requestedPathLimit)
    ),
    maxResidualPosteriorMass: Math.min(1, Math.max(
      0,
      input?.maxResidualPosteriorMass ?? DEFAULT_LIMITS.maxResidualPosteriorMass
    )),
    maxConstructionDepth: boundedInteger(
      input?.maxConstructionDepth,
      1,
      1_000_000,
      DEFAULT_LIMITS.maxConstructionDepth
    )
  };
}

function pruneArcs(
  allArcsByStart: ReadonlyMap<number, readonly WeightedArc[]>,
  graphemeCount: number,
  limits: SegmentationForestLimits
): {
  arcsByStart: Map<number, WeightedArc[]>;
  arcsPruned: number;
  depthPruned: number;
} {
  const arcsByStart = new Map<number, WeightedArc[]>();
  let arcsPruned = 0;
  let depthPruned = 0;
  const perCoordinateLimit = Math.min(
    limits.maxArcsPerCoordinate,
    limits.maxOutgoingAlternatives
  );
  for (let position = 0; position < graphemeCount; position += 1) {
    const all = [...(allArcsByStart.get(position) ?? [])];
    const depthLegal = all.filter(arc => {
      const legal = arc.unit.overlapClass === "base_partition"
        || arc.unit.graphemeEnd - arc.unit.graphemeStart <= limits.maxConstructionDepth;
      if (!legal) depthPruned += 1;
      return legal;
    });
    const mandatory = depthLegal.filter(arc => arc.unit.overlapClass === "base_partition");
    const alternatives = depthLegal.filter(arc => arc.unit.overlapClass !== "base_partition");
    const selected = uniqueArcs([
      ...mandatory,
      ...alternatives.slice(0, Math.max(0, perCoordinateLimit - mandatory.length))
    ]).sort(compareArcs);
    arcsPruned += all.length - selected.length;
    if (selected.length) arcsByStart.set(position, selected);
  }
  return { arcsByStart, arcsPruned, depthPruned };
}

function forwardPartition(
  arcsByStart: ReadonlyMap<number, readonly WeightedArc[]>,
  graphemeCount: number
): number[] {
  const forward = new Array<number>(graphemeCount + 1).fill(Number.NEGATIVE_INFINITY);
  forward[0] = 0;
  for (let position = 0; position < graphemeCount; position += 1) {
    if (!Number.isFinite(forward[position]!)) continue;
    for (const arc of arcsByStart.get(position) ?? []) {
      forward[arc.unit.graphemeEnd] = logAddExp(
        forward[arc.unit.graphemeEnd]!,
        forward[position]! - arc.energy
      );
    }
  }
  return forward;
}

function backwardPartition(
  arcsByStart: ReadonlyMap<number, readonly WeightedArc[]>,
  graphemeCount: number
): number[] {
  const backward = new Array<number>(graphemeCount + 1).fill(Number.NEGATIVE_INFINITY);
  backward[graphemeCount] = 0;
  for (let position = graphemeCount - 1; position >= 0; position -= 1) {
    for (const arc of arcsByStart.get(position) ?? []) {
      backward[position] = logAddExp(
        backward[position]!,
        -arc.energy + backward[arc.unit.graphemeEnd]!
      );
    }
  }
  return backward;
}

function compileBoundaryMarginals(input: {
  arcsByStart: ReadonlyMap<number, readonly WeightedArc[]>;
  forward: readonly number[];
  backward: readonly number[];
  partitionLogZ: number;
  graphemeCount: number;
}): SegmentationBoundaryMarginal[] {
  const boundaryMass = new Array<number>(input.graphemeCount + 1).fill(0);
  boundaryMass[0] = 1;
  if (Number.isFinite(input.partitionLogZ)) {
    for (let position = 0; position < input.graphemeCount; position += 1) {
      if (!Number.isFinite(input.forward[position]!)) continue;
      for (const arc of input.arcsByStart.get(position) ?? []) {
        const suffix = input.backward[arc.unit.graphemeEnd]!;
        if (!Number.isFinite(suffix)) continue;
        boundaryMass[arc.unit.graphemeEnd] = boundaryMass[arc.unit.graphemeEnd]!
          + Math.exp(input.forward[position]! - arc.energy + suffix - input.partitionLogZ);
      }
    }
  }
  return boundaryMass.map((probability, positionGrapheme) => ({
    positionGrapheme,
    boundaryProbability: quantize(clamp01(probability))
  }));
}

function compileKBest(
  arcsByStart: ReadonlyMap<number, readonly WeightedArc[]>,
  graphemeCount: number,
  pathLimit: number
): PathState[] {
  const kBest: PathState[][] = Array.from(
    { length: graphemeCount + 1 },
    () => [] as PathState[]
  );
  kBest[0] = [{
    unitIds: [],
    energy: 0,
    energyTrace: zeroEnergy()
  }];
  for (let position = 0; position <= graphemeCount; position += 1) {
    if (!kBest[position]!.length) continue;
    for (const arc of arcsByStart.get(position) ?? []) {
      const next = arc.unit.graphemeEnd;
      const candidates = [
        ...kBest[next]!,
        ...kBest[position]!.map(path => ({
          unitIds: [...path.unitIds, arc.unit.id],
          energy: quantize(path.energy + arc.energy),
          energyTrace: addEnergy(path.energyTrace, arc.energyTrace)
        }))
      ];
      candidates.sort(comparePathStates);
      kBest[next] = uniquePaths(candidates).slice(0, pathLimit);
    }
  }
  return kBest[graphemeCount]!;
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

function segmentationArcEnergy(input: {
  unit: SegmentationForestUnit;
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

function zeroEnergy(): SegmentationEnergyComponents {
  return {
    boundary: 0,
    continuation: 0,
    anchor: 0,
    description: 0,
    population: 0,
    semanticContext: 0,
    total: 0
  };
}

function addEnergy(
  left: SegmentationEnergyComponents,
  right: SegmentationEnergyComponents
): SegmentationEnergyComponents {
  return quantizeEnergy({
    boundary: left.boundary + right.boundary,
    continuation: left.continuation + right.continuation,
    anchor: left.anchor + right.anchor,
    description: left.description + right.description,
    population: left.population + right.population,
    semanticContext: left.semanticContext + right.semanticContext,
    total: left.total + right.total
  });
}

function quantizeEnergy(energy: SegmentationEnergyComponents): SegmentationEnergyComponents {
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

function uniqueArcs(arcs: readonly WeightedArc[]): WeightedArc[] {
  const seen = new Set<string>();
  return arcs.filter(arc => {
    if (seen.has(arc.unit.id)) return false;
    seen.add(arc.unit.id);
    return true;
  });
}

function compareArcs(left: WeightedArc, right: WeightedArc): number {
  return left.energy - right.energy
    || left.unit.graphemeEnd - right.unit.graphemeEnd
    || left.unit.id.localeCompare(right.unit.id);
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

function finiteEnergy(value: number | undefined): number {
  if (value === undefined) return 0;
  if (!Number.isFinite(value)) throw new Error("segmentation energy term must be finite");
  return value;
}

function boundedInteger(
  value: number | undefined,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return Math.max(minimum, Math.min(maximum, Math.floor(value ?? fallback)));
}

function countArcs(arcsByStart: ReadonlyMap<number, readonly WeightedArc[]>): number {
  return [...arcsByStart.values()].reduce((sum, arcs) => sum + arcs.length, 0);
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
