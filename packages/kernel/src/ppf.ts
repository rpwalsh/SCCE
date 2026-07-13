import type { GraphEdge, GraphNode, NodeId, RelationId } from "./types.js";
import { normalizeVector } from "./primitives.js";
import { chernoffInformation, subspaceDriftEntropy } from "./causal-math.js";
import { csrFromCoo, csrMatVec, csrTranspose, stochasticNormalizeRows, type CooEntry } from "./alpha-layer/sparse.js";

/**
 * Direction is a property of a relation, not a coefficient invented by the walk.
 * A learned inverse is represented by its own relation and edges; it never causes
 * this module to synthesize reverse transitions.
 */
export type RelationTransitionPolicy =
  | { relationId: RelationId | string; direction: "directed" }
  | { relationId: RelationId | string; direction: "reversible"; reverseWeightScale?: number }
  | { relationId: RelationId | string; direction: "learned_inverse"; inverseRelationId: RelationId | string };

export interface PersonalizedRandomWalkWithRestartInput {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  personalization: readonly { nodeId: NodeId; weight: number }[];
  relationPolicies: readonly RelationTransitionPolicy[];
  /** Probability of following an edge. Must be in [0, 1). Defaults to 0.85. */
  continuationProbability?: number;
  /** Probability of restarting from the personalization vector. Must be in (0, 1]. */
  restartProbability?: number;
  maxIterations?: number;
  tolerance?: number;
}

export interface PersonalizedRandomWalkDiagnostics {
  algorithm: "personalized_random_walk_with_restart";
  solver: "sparse_power_iteration" | "dense_linear_system_reference";
  iterations: number;
  converged: boolean;
  residualL1: number;
  massSum: number;
  chernoff: number;
  sde: ReturnType<typeof subspaceDriftEntropy>;
  danglingNodes: number;
  continuationProbability: number;
  restartProbability: number;
  /** @deprecated Use continuationProbability. */
  damping: number;
  transitionNonZero: number;
  transitionShape: [number, number];
  transitionMaterialized: boolean;
  danglingPolicy: "personalization";
  relationPolicyCounts: { directed: number; reversible: number; learnedInverse: number };
  relationPolicies: Array<{
    relationId: string;
    direction: RelationTransitionPolicy["direction"];
    reverseWeightScale?: number;
    inverseRelationId?: string;
  }>;
  explicitReverseTransitions: number;
  syntheticReverseTransitions: 0;
  transitionContributionTrace?: Array<{
    from: NodeId;
    to: NodeId;
    probability: number;
    stationarySourceMass: number;
    continuedMass: number;
  }>;
  restartContributionTrace?: Array<{ nodeId: NodeId; teleportMass: number; restartedMass: number }>;
  transitionTraceTruncated?: boolean;
  traceInterpretation?: "final_fixed_point_contributions";
}

export interface PersonalizedRandomWalkResult {
  rank: Array<{ nodeId: NodeId; mass: number }>;
  /** Populated only by the bounded dense reference solver. */
  transition: number[][];
  teleport: number[];
  diagnostics: PersonalizedRandomWalkDiagnostics;
}

interface PreparedInput {
  ids: NodeId[];
  index: Map<NodeId, number>;
  policies: Map<string, RelationTransitionPolicy>;
  teleport: number[];
  continuationProbability: number;
  restartProbability: number;
  maxIterations: number;
  tolerance: number;
  relationPolicyCounts: PersonalizedRandomWalkDiagnostics["relationPolicyCounts"];
}

export function createPersonalizedRandomWalkWithRestart() {
  return {
    rank: personalizedRandomWalkWithRestart,
    rankDetailed: personalizedRandomWalkWithRestartDetailed,
    denseReference: personalizedRandomWalkWithRestartDenseReference
  };
}

/**
 * Query-conditioned PageRank-family diffusion:
 * r_(k+1) = restart * v + continuation * P^T r_k.
 */
export function personalizedRandomWalkWithRestart(
  input: PersonalizedRandomWalkWithRestartInput
): Array<{ nodeId: NodeId; mass: number }> {
  return personalizedRandomWalkWithRestartDetailed(input).rank;
}

/**
 * Sparse power iteration over a directed, nonnegative, row-stochastic operator.
 * Dangling rows transition to the normalized personalization distribution.
 */
export function personalizedRandomWalkWithRestartDetailed(
  input: PersonalizedRandomWalkWithRestartInput
): PersonalizedRandomWalkResult {
  const prepared = prepareInput(input);
  const { ids, index, teleport, continuationProbability, restartProbability, maxIterations, tolerance } = prepared;
  const n = ids.length;
  if (n === 0) return emptyResult(prepared, "sparse_power_iteration");

  const entries: CooEntry[] = [];
  let explicitReverseTransitions = 0;
  for (const edge of input.edges) {
    const source = index.get(edge.source)!;
    const target = index.get(edge.target)!;
    const weight = effectiveEdgeWeight(edge);
    if (weight === 0) continue;
    entries.push({ row: source, col: target, value: weight });
    const policy = prepared.policies.get(String(edge.relationId))!;
    if (policy.direction === "reversible" && source !== target) {
      const reverseWeight = weight * (policy.reverseWeightScale ?? 1);
      if (!Number.isFinite(reverseWeight)) throw new RangeError(`reverse transition weight overflow for relation ${String(edge.relationId)}`);
      if (reverseWeight > 0) {
        entries.push({ row: target, col: source, value: reverseWeight });
        explicitReverseTransitions++;
      }
    }
  }

  const adjacency = csrFromCoo(n, n, entries);
  const danglingNodes = countDanglingRows(adjacency);
  const transition = stochasticNormalizeRows(adjacency, teleport);
  const transitionT = csrTranspose(transition);
  let mass = teleport.slice();
  let residualL1 = Number.POSITIVE_INFINITY;
  let chernoff = 0;
  let sde = subspaceDriftEntropy({ previous: mass, current: mass });
  let iterations = 0;

  for (let iteration = 0; iteration < maxIterations; iteration++) {
    const walked = csrMatVec(transitionT, mass);
    const next = teleport.map((value, i) => restartProbability * value + continuationProbability * (walked[i] ?? 0));
    assertFiniteVector(next, "diffusion mass");
    const normalized = normalizeVector(next);
    residualL1 = l1Distance(normalized, mass);
    chernoff = chernoffInformation(normalized, mass).information;
    sde = subspaceDriftEntropy({ previous: mass, current: normalized });
    mass = normalized;
    iterations = iteration + 1;
    if (residualL1 <= tolerance) break;
  }

  return {
    rank: ranked(ids, mass),
    transition: [],
    teleport,
    diagnostics: {
      algorithm: "personalized_random_walk_with_restart",
      solver: "sparse_power_iteration",
      iterations,
      converged: residualL1 <= tolerance,
      residualL1,
      massSum: sum(mass),
      chernoff,
      sde,
      danglingNodes,
      continuationProbability,
      restartProbability,
      damping: continuationProbability,
      transitionNonZero: transition.values.length,
      transitionShape: [transition.rows, transition.cols],
      transitionMaterialized: false,
      danglingPolicy: "personalization",
      relationPolicyCounts: prepared.relationPolicyCounts,
      relationPolicies: diagnosticPolicies(prepared.policies),
      explicitReverseTransitions,
      syntheticReverseTransitions: 0,
      ...sparseContributionTrace(ids, transition, mass, teleport, continuationProbability, restartProbability)
    }
  };
}

/**
 * Independent small-graph oracle. It constructs a dense transition matrix and
 * solves (I - continuation * P^T)r = restart * v with pivoted elimination.
 * It intentionally does not use the sparse construction or iteration helpers.
 */
export function personalizedRandomWalkWithRestartDenseReference(
  input: PersonalizedRandomWalkWithRestartInput,
  options: { maxNodes?: number } = {}
): PersonalizedRandomWalkResult {
  const prepared = prepareInput(input);
  const { ids, index, teleport, continuationProbability, restartProbability, tolerance } = prepared;
  const n = ids.length;
  const maxNodes = options.maxNodes ?? 128;
  if (!Number.isInteger(maxNodes) || maxNodes < 1) throw new RangeError("maxNodes must be a positive integer");
  if (n > maxNodes) throw new RangeError(`dense reference is limited to ${maxNodes} nodes; received ${n}`);
  if (n === 0) return emptyResult(prepared, "dense_linear_system_reference", true);

  const adjacency = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  let explicitReverseTransitions = 0;
  for (const edge of input.edges) {
    const source = index.get(edge.source)!;
    const target = index.get(edge.target)!;
    const weight = effectiveEdgeWeight(edge);
    adjacency[source]![target] = (adjacency[source]![target] ?? 0) + weight;
    const policy = prepared.policies.get(String(edge.relationId))!;
    if (policy.direction === "reversible" && source !== target) {
      const reverseWeight = weight * (policy.reverseWeightScale ?? 1);
      if (!Number.isFinite(reverseWeight)) throw new RangeError(`reverse transition weight overflow for relation ${String(edge.relationId)}`);
      if (reverseWeight > 0) {
        adjacency[target]![source] = (adjacency[target]![source] ?? 0) + reverseWeight;
        explicitReverseTransitions++;
      }
    }
  }

  let danglingNodes = 0;
  const transition = adjacency.map(row => {
    const rowSum = sum(row);
    if (rowSum === 0) {
      danglingNodes++;
      return teleport.slice();
    }
    return row.map(value => value / rowSum);
  });
  const system = Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, col) => (row === col ? 1 : 0) - continuationProbability * (transition[col]?.[row] ?? 0))
  );
  const rhs = teleport.map(value => restartProbability * value);
  const solved = solveDenseLinearSystem(system, rhs);
  if (solved.some(value => value < -1e-13)) throw new Error("dense reference produced materially negative stationary mass");
  const mass = normalizeVector(solved.map(value => Math.max(0, value)));
  assertFiniteVector(mass, "dense reference mass");
  const fixedPoint = teleport.map((value, target) => {
    let walked = 0;
    for (let source = 0; source < n; source++) walked += (transition[source]?.[target] ?? 0) * (mass[source] ?? 0);
    return restartProbability * value + continuationProbability * walked;
  });
  const residualL1 = l1Distance(fixedPoint, mass);

  return {
    rank: ranked(ids, mass),
    transition,
    teleport,
    diagnostics: {
      algorithm: "personalized_random_walk_with_restart",
      solver: "dense_linear_system_reference",
      iterations: 1,
      converged: residualL1 <= Math.max(tolerance, 1e-12),
      residualL1,
      massSum: sum(mass),
      chernoff: chernoffInformation(mass, teleport).information,
      sde: subspaceDriftEntropy({ previous: teleport, current: mass }),
      danglingNodes,
      continuationProbability,
      restartProbability,
      damping: continuationProbability,
      transitionNonZero: transition.reduce((count, row) => count + row.filter(value => value !== 0).length, 0),
      transitionShape: [n, n],
      transitionMaterialized: true,
      danglingPolicy: "personalization",
      relationPolicyCounts: prepared.relationPolicyCounts,
      relationPolicies: diagnosticPolicies(prepared.policies),
      explicitReverseTransitions,
      syntheticReverseTransitions: 0,
      ...denseContributionTrace(ids, transition, mass, teleport, continuationProbability, restartProbability)
    }
  };
}

interface LegacyPerronFrobeniusInput {
  nodes: readonly GraphNode[];
  edges: readonly GraphEdge[];
  personalization: readonly { nodeId: NodeId; weight: number }[];
  damping?: number;
  iterations?: number;
  tolerance?: number;
  relationPolicies?: readonly RelationTransitionPolicy[];
}

/** @deprecated Use createPersonalizedRandomWalkWithRestart. */
export function createPersonalizedPerronFrobenius() {
  return { rank: personalizedPerronFrobenius, rankDetailed: personalizedPerronFrobeniusDetailed };
}

/** @deprecated Use personalizedRandomWalkWithRestart. */
export function personalizedPerronFrobenius(input: LegacyPerronFrobeniusInput): Array<{ nodeId: NodeId; mass: number }> {
  return personalizedPerronFrobeniusDetailed(input).rank;
}

/** @deprecated Use personalizedRandomWalkWithRestartDetailed. */
export function personalizedPerronFrobeniusDetailed(input: LegacyPerronFrobeniusInput): PersonalizedRandomWalkResult {
  return personalizedRandomWalkWithRestartDetailed({
    nodes: input.nodes,
    edges: input.edges,
    personalization: input.personalization,
    relationPolicies: input.relationPolicies ?? directedPoliciesFor(input.edges),
    continuationProbability: input.damping,
    maxIterations: input.iterations,
    tolerance: input.tolerance
  });
}

function prepareInput(input: PersonalizedRandomWalkWithRestartInput): PreparedInput {
  const continuationProbability = resolveContinuationProbability(input);
  const restartProbability = 1 - continuationProbability;
  const maxIterations = input.maxIterations ?? 100;
  const tolerance = input.tolerance ?? 1e-10;
  if (!Number.isInteger(maxIterations) || maxIterations < 1) throw new RangeError("maxIterations must be a positive integer");
  if (!Number.isFinite(tolerance) || tolerance <= 0) throw new RangeError("tolerance must be finite and greater than zero");

  const ids = input.nodes.map(node => node.id);
  const index = new Map<NodeId, number>();
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (index.has(id)) throw new Error(`duplicate graph node id: ${String(id)}`);
    index.set(id, i);
  }

  const policies = new Map<string, RelationTransitionPolicy>();
  const relationPolicyCounts = { directed: 0, reversible: 0, learnedInverse: 0 };
  for (const policy of input.relationPolicies) {
    const relationId = String(policy.relationId);
    if (!relationId) throw new Error("relation policy id must not be empty");
    if (policies.has(relationId)) throw new Error(`duplicate relation policy: ${relationId}`);
    if (policy.direction === "reversible") {
      const scale = policy.reverseWeightScale ?? 1;
      if (!Number.isFinite(scale) || scale <= 0) throw new RangeError(`reverseWeightScale must be finite and greater than zero for relation ${relationId}`);
      relationPolicyCounts.reversible++;
    } else if (policy.direction === "learned_inverse") {
      if (!String(policy.inverseRelationId) || String(policy.inverseRelationId) === relationId) {
        throw new Error(`learned inverse policy for ${relationId} must name a distinct inverse relation`);
      }
      relationPolicyCounts.learnedInverse++;
    } else {
      relationPolicyCounts.directed++;
    }
    policies.set(relationId, policy);
  }

  for (const edge of input.edges) {
    if (!index.has(edge.source)) throw new Error(`edge ${String(edge.id)} has unknown source node ${String(edge.source)}`);
    if (!index.has(edge.target)) throw new Error(`edge ${String(edge.id)} has unknown target node ${String(edge.target)}`);
    validateNonnegativeFinite(edge.weight, `edge ${String(edge.id)} weight`);
    validateNonnegativeFinite(edge.alpha, `edge ${String(edge.id)} alpha`);
    if (!policies.has(String(edge.relationId))) throw new Error(`missing direction policy for relation ${String(edge.relationId)}`);
    effectiveEdgeWeight(edge);
  }

  const personalization = new Array<number>(ids.length).fill(0);
  for (const item of input.personalization) {
    const at = index.get(item.nodeId);
    if (at === undefined) throw new Error(`personalization names unknown node ${String(item.nodeId)}`);
    validateNonnegativeFinite(item.weight, `personalization weight for ${String(item.nodeId)}`);
    personalization[at] = (personalization[at] ?? 0) + item.weight;
    if (!Number.isFinite(personalization[at])) throw new RangeError(`personalization weight overflow for ${String(item.nodeId)}`);
  }
  if (ids.length > 0 && sum(personalization) <= 0) {
    throw new RangeError("personalization must contain positive mass for at least one graph node");
  }
  const teleport = normalizeVector(personalization);

  return {
    ids,
    index,
    policies,
    teleport,
    continuationProbability,
    restartProbability,
    maxIterations,
    tolerance,
    relationPolicyCounts
  };
}

function resolveContinuationProbability(input: PersonalizedRandomWalkWithRestartInput): number {
  const continuation = input.continuationProbability;
  const restart = input.restartProbability;
  if (continuation !== undefined && (!Number.isFinite(continuation) || continuation < 0 || continuation >= 1)) {
    throw new RangeError("continuationProbability must be finite and in [0, 1)");
  }
  if (restart !== undefined && (!Number.isFinite(restart) || restart <= 0 || restart > 1)) {
    throw new RangeError("restartProbability must be finite and in (0, 1]");
  }
  if (continuation !== undefined && restart !== undefined && Math.abs(continuation + restart - 1) > 1e-12) {
    throw new RangeError("continuationProbability and restartProbability must sum to one");
  }
  return continuation ?? (restart === undefined ? 0.85 : 1 - restart);
}

function directedPoliciesFor(edges: readonly GraphEdge[]): RelationTransitionPolicy[] {
  return [...new Set(edges.map(edge => String(edge.relationId)))]
    .sort()
    .map(relationId => ({ relationId, direction: "directed" as const }));
}

function diagnosticPolicies(policies: ReadonlyMap<string, RelationTransitionPolicy>): PersonalizedRandomWalkDiagnostics["relationPolicies"] {
  return [...policies.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([relationId, policy]) => policy.direction === "reversible"
      ? { relationId, direction: policy.direction, reverseWeightScale: policy.reverseWeightScale ?? 1 }
      : policy.direction === "learned_inverse"
        ? { relationId, direction: policy.direction, inverseRelationId: String(policy.inverseRelationId) }
        : { relationId, direction: policy.direction });
}

function effectiveEdgeWeight(edge: GraphEdge): number {
  const weight = edge.weight * edge.alpha;
  if (!Number.isFinite(weight)) throw new RangeError(`effective weight overflow for edge ${String(edge.id)}`);
  return weight;
}

function validateNonnegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${name} must be finite and nonnegative`);
}

function countDanglingRows(matrix: ReturnType<typeof csrFromCoo>): number {
  let count = 0;
  for (let row = 0; row < matrix.rows; row++) if ((matrix.rowPtr[row] ?? 0) === (matrix.rowPtr[row + 1] ?? 0)) count++;
  return count;
}

function sparseContributionTrace(
  ids: readonly NodeId[],
  transition: ReturnType<typeof stochasticNormalizeRows>,
  mass: readonly number[],
  teleport: readonly number[],
  continuationProbability: number,
  restartProbability: number,
  limit = 512
): Pick<PersonalizedRandomWalkDiagnostics, "transitionContributionTrace" | "restartContributionTrace" | "transitionTraceTruncated" | "traceInterpretation"> {
  const rows: NonNullable<PersonalizedRandomWalkDiagnostics["transitionContributionTrace"]> = [];
  for (let source = 0; source < transition.rows && rows.length < limit; source++) {
    for (let at = transition.rowPtr[source] ?? 0; at < (transition.rowPtr[source + 1] ?? 0) && rows.length < limit; at++) {
      const target = transition.colIdx[at];
      if (target === undefined || !ids[source] || !ids[target]) continue;
      const probability = transition.values[at] ?? 0;
      const stationarySourceMass = mass[source] ?? 0;
      rows.push({
        from: ids[source]!,
        to: ids[target]!,
        probability,
        stationarySourceMass,
        continuedMass: continuationProbability * probability * stationarySourceMass
      });
    }
  }
  return {
    transitionContributionTrace: rows,
    restartContributionTrace: ids.map((nodeId, index) => ({
      nodeId,
      teleportMass: teleport[index] ?? 0,
      restartedMass: restartProbability * (teleport[index] ?? 0)
    })).filter(row => row.teleportMass > 0).slice(0, limit),
    transitionTraceTruncated: transition.values.length > rows.length,
    traceInterpretation: "final_fixed_point_contributions"
  };
}

function denseContributionTrace(
  ids: readonly NodeId[],
  transition: readonly (readonly number[])[],
  mass: readonly number[],
  teleport: readonly number[],
  continuationProbability: number,
  restartProbability: number,
  limit = 512
): Pick<PersonalizedRandomWalkDiagnostics, "transitionContributionTrace" | "restartContributionTrace" | "transitionTraceTruncated" | "traceInterpretation"> {
  const rows: NonNullable<PersonalizedRandomWalkDiagnostics["transitionContributionTrace"]> = [];
  const nonzero = transition.reduce((count, row) => count + row.filter(value => value > 0).length, 0);
  for (let source = 0; source < transition.length && rows.length < limit; source++) {
    for (let target = 0; target < transition.length && rows.length < limit; target++) {
      const probability = transition[source]?.[target] ?? 0;
      if (!(probability > 0) || !ids[source] || !ids[target]) continue;
      const stationarySourceMass = mass[source] ?? 0;
      rows.push({
        from: ids[source]!,
        to: ids[target]!,
        probability,
        stationarySourceMass,
        continuedMass: continuationProbability * probability * stationarySourceMass
      });
    }
  }
  return {
    transitionContributionTrace: rows,
    restartContributionTrace: ids.map((nodeId, index) => ({
      nodeId,
      teleportMass: teleport[index] ?? 0,
      restartedMass: restartProbability * (teleport[index] ?? 0)
    })).filter(row => row.teleportMass > 0).slice(0, limit),
    transitionTraceTruncated: nonzero > rows.length,
    traceInterpretation: "final_fixed_point_contributions"
  };
}

function solveDenseLinearSystem(matrix: readonly (readonly number[])[], rhs: readonly number[]): number[] {
  const n = matrix.length;
  const augmented = matrix.map((row, i) => [...row, rhs[i] ?? 0]);
  for (let pivotColumn = 0; pivotColumn < n; pivotColumn++) {
    let pivotRow = pivotColumn;
    for (let row = pivotColumn + 1; row < n; row++) {
      if (Math.abs(augmented[row]?.[pivotColumn] ?? 0) > Math.abs(augmented[pivotRow]?.[pivotColumn] ?? 0)) pivotRow = row;
    }
    if (Math.abs(augmented[pivotRow]?.[pivotColumn] ?? 0) <= 1e-15) throw new Error("dense reference system is numerically singular");
    if (pivotRow !== pivotColumn) [augmented[pivotColumn], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[pivotColumn]!];
    const pivot = augmented[pivotColumn]?.[pivotColumn] ?? 0;
    for (let column = pivotColumn; column <= n; column++) augmented[pivotColumn]![column] = (augmented[pivotColumn]?.[column] ?? 0) / pivot;
    for (let row = 0; row < n; row++) {
      if (row === pivotColumn) continue;
      const factor = augmented[row]?.[pivotColumn] ?? 0;
      if (factor === 0) continue;
      for (let column = pivotColumn; column <= n; column++) {
        augmented[row]![column] = (augmented[row]?.[column] ?? 0) - factor * (augmented[pivotColumn]?.[column] ?? 0);
      }
    }
  }
  return augmented.map(row => row[n] ?? 0);
}

function assertFiniteVector(vector: readonly number[], name: string): void {
  if (vector.some(value => !Number.isFinite(value))) throw new RangeError(`${name} contains a non-finite value`);
}

function ranked(ids: readonly NodeId[], mass: readonly number[]): Array<{ nodeId: NodeId; mass: number }> {
  return ids
    .map((nodeId, i) => ({ nodeId, mass: mass[i] ?? 0 }))
    .sort((a, b) => b.mass - a.mass || String(a.nodeId).localeCompare(String(b.nodeId)));
}

function l1Distance(left: readonly number[], right: readonly number[]): number {
  let total = 0;
  for (let i = 0; i < Math.max(left.length, right.length); i++) total += Math.abs((left[i] ?? 0) - (right[i] ?? 0));
  return total;
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function emptyResult(
  input: PreparedInput,
  solver: PersonalizedRandomWalkDiagnostics["solver"],
  transitionMaterialized = false
): PersonalizedRandomWalkResult {
  return {
    rank: [],
    transition: [],
    teleport: [],
    diagnostics: {
      algorithm: "personalized_random_walk_with_restart",
      solver,
      iterations: 0,
      converged: true,
      residualL1: 0,
      massSum: 0,
      chernoff: 0,
      sde: subspaceDriftEntropy({ previous: [], current: [] }),
      danglingNodes: 0,
      continuationProbability: input.continuationProbability,
      restartProbability: input.restartProbability,
      damping: input.continuationProbability,
      transitionNonZero: 0,
      transitionShape: [0, 0],
      transitionMaterialized,
      danglingPolicy: "personalization",
      relationPolicyCounts: input.relationPolicyCounts,
      relationPolicies: diagnosticPolicies(input.policies),
      explicitReverseTransitions: 0,
      syntheticReverseTransitions: 0
    }
  };
}
