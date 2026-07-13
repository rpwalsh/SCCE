import { clamp01, entropy as primitiveEntropy, mean } from "./primitives.js";
import { multiplyVector } from "./math.js";

export interface BayesUpdateResult {
  posterior: number;
  evidenceProbability: number;
  likelihood: number;
  prior: number;
  surprise: number;
}

export function bayesUpdate(input: { prior: number; likelihood: number; alternativeLikelihood?: number; evidenceProbability?: number }): BayesUpdateResult {
  const prior = clamp01(input.prior);
  const likelihood = clamp01(input.likelihood);
  const alternativeLikelihood = clamp01(input.alternativeLikelihood ?? (1 - likelihood));
  const evidenceProbability = Math.max(1e-12, clamp01(input.evidenceProbability ?? likelihood * prior + alternativeLikelihood * (1 - prior)));
  const posterior = clamp01((likelihood * prior) / evidenceProbability);
  return { posterior, evidenceProbability, likelihood, prior, surprise: -Math.log2(evidenceProbability) };
}

export function shannonEntropy(input: readonly number[]): { entropy: number; normalized: number; support: number } {
  const positive = input.map(value => Math.max(0, value));
  const support = positive.filter(value => value > 0).length;
  const entropy = primitiveEntropy(positive);
  const normalized = support > 1 ? clamp01(entropy / Math.log2(support)) : 0;
  return { entropy, normalized, support };
}

export function conductanceEquation(input: {
  weight: number;
  alpha: number;
  provenance: number;
  temporalFit: number;
  modalityAgreement: number;
  contradictionPenalty: number;
}): number {
  return clamp01(
    clamp01(input.weight) *
      clamp01(input.alpha) *
      clamp01(input.provenance) *
      clamp01(input.temporalFit) *
      clamp01(input.modalityAgreement) *
      (1 - clamp01(input.contradictionPenalty))
  );
}

export function heatDiffuse(input: {
  laplacian: readonly (readonly number[])[];
  current: readonly number[];
  eta?: number;
  steps?: number;
}): { values: number[]; energy: number; residual: number; stepSize: number; massDrift: number } {
  const laplacian = validatedDiffusionLaplacian(input.laplacian, input.current.length);
  const maximumDiagonal = Math.max(0, ...laplacian.map((row, index) => row[index] ?? 0));
  const maximumStableStep = maximumDiagonal > 0 ? 1 / maximumDiagonal : Number.POSITIVE_INFINITY;
  const eta = input.eta ?? Math.min(0.12, maximumStableStep);
  if (!Number.isFinite(eta) || eta <= 0 || eta > maximumStableStep + 1e-12) {
    throw new RangeError(`heat step must be in (0, ${maximumStableStep}] for this graph Laplacian`);
  }
  const steps = Math.max(1, Math.min(80, input.steps ?? 8));
  const initialMass = input.current.reduce((sum, value) => sum + value, 0);
  let values = input.current.map(finiteNumber);
  let residual = 0;
  for (let i = 0; i < steps; i++) {
    const delta = multiplyVector(laplacian, values);
    const next = values.map((value, index) => value - eta * (delta[index] ?? 0));
    residual = mean(next.map((value, index) => Math.abs(value - (values[index] ?? 0))));
    values = next;
  }
  return {
    values,
    energy: quadraticForm(laplacian, values),
    residual,
    stepSize: eta,
    massDrift: values.reduce((sum, value) => sum + value, 0) - initialMass
  };
}

export function wavePropagate(input: {
  laplacian: readonly (readonly number[])[];
  current: readonly number[];
  previous?: readonly number[];
  speed?: number;
  damping?: number;
  steps?: number;
}): { values: number[]; momentum: number; energy: number; speed: number; stabilityLimit: number } {
  const laplacian = validatedDiffusionLaplacian(input.laplacian, input.current.length);
  if (input.previous !== undefined && input.previous.length !== input.current.length) {
    throw new RangeError("wave previous/current vectors must have equal length");
  }
  const eigenvalueUpperBound = maxRowSum(laplacian);
  const stabilityLimit = eigenvalueUpperBound > 0 ? 2 / Math.sqrt(eigenvalueUpperBound) : Number.POSITIVE_INFINITY;
  const speed = input.speed ?? Math.min(0.18, stabilityLimit);
  if (!Number.isFinite(speed) || speed <= 0 || speed > stabilityLimit + 1e-12) {
    throw new RangeError(`wave speed must be in (0, ${stabilityLimit}] for this graph Laplacian`);
  }
  const damping = clamp01(input.damping ?? 0.08);
  const steps = Math.max(1, Math.min(24, input.steps ?? 3));
  let previous = (input.previous ?? input.current).map(finiteNumber);
  let current = input.current.map(finiteNumber);
  for (let i = 0; i < steps; i++) {
    const lap = multiplyVector(laplacian, current);
    const next = current.map((value, index) => (
      2 * value -
        (previous[index] ?? 0) -
        speed * speed * (lap[index] ?? 0) -
        damping * (value - (previous[index] ?? 0))
    ));
    previous = current;
    current = next;
  }
  const momentum = mean(current.map((value, index) => Math.abs(value - (previous[index] ?? 0))));
  const kineticEnergy = current.reduce((sum, value, index) => {
    const velocity = value - (previous[index] ?? 0);
    return sum + 0.5 * velocity * velocity;
  }, 0);
  return {
    values: current,
    momentum,
    energy: kineticEnergy + 0.5 * speed * speed * quadraticForm(laplacian, current),
    speed,
    stabilityLimit
  };
}

export function spectralPartition(input: {
  nodes: readonly string[];
  laplacian: readonly (readonly number[])[];
  iterations?: number;
}): {
  algebraicConnectivity: number;
  partitionEigengap: number;
  clusters: Array<{ id: string; nodeIds: string[]; mass: number }>;
  fiedler: Array<{ nodeId: string; value: number }>;
  converged: boolean;
  residual: number;
} {
  const nodes = [...input.nodes];
  const n = nodes.length;
  if (n === 0) return { algebraicConnectivity: 0, partitionEigengap: 0, clusters: [], fiedler: [], converged: true, residual: 0 };
  if (n === 1) return {
    algebraicConnectivity: 0,
    partitionEigengap: 0,
    clusters: [{ id: "cluster.0", nodeIds: nodes, mass: 1 }],
    fiedler: [{ nodeId: nodes[0] ?? "", value: 0 }],
    converged: true,
    residual: 0
  };
  const laplacian = validatedSymmetricMatrix(input.laplacian, n);
  const decomposition = jacobiEigenpairsSymmetric(laplacian, Math.max(8, Math.min(256, input.iterations ?? 80)) * n * n);
  if ((decomposition.pairs[0]?.value ?? 0) < -1e-8) {
    throw new RangeError("spectral partition requires a positive-semidefinite Laplacian");
  }
  const second = decomposition.pairs[1];
  if (!second) throw new Error("symmetric eigendecomposition did not produce a Fiedler pair");
  const vector = canonicalizeEigenvector(second.vector);
  const lv = multiplyVector(laplacian, vector);
  const algebraicConnectivity = Math.max(0, second.value);
  const residual = Math.sqrt(vector.reduce((sum, value, index) => {
    const difference = (lv[index] ?? 0) - algebraicConnectivity * value;
    return sum + difference * difference;
  }, 0));
  const third = decomposition.pairs[2];
  const partitionEigengap = third ? Math.max(0, third.value - second.value) : 0;
  const left = nodes.filter((_, index) => (vector[index] ?? 0) < 0);
  const right = nodes.filter((_, index) => (vector[index] ?? 0) >= 0);
  const clusters = [
    ...(left.length ? [{ id: "cluster.0", nodeIds: left, mass: left.length / n }] : []),
    ...(right.length ? [{ id: "cluster.1", nodeIds: right, mass: right.length / n }] : [])
  ];
  return {
    algebraicConnectivity,
    partitionEigengap,
    clusters,
    fiedler: nodes.map((nodeId, index) => ({ nodeId, value: vector[index] ?? 0 })),
    converged: decomposition.converged,
    residual
  };
}

export function proofPathSemiring(input: {
  paths: Array<{ conductances: readonly number[]; risks?: readonly number[]; contradiction?: number }>;
}): { maxProductSupport: number; sumProductSupport: number; minPlusRisk: number; contradictionMass: number; netAdmissibility: number; pathCount: number } {
  const products = input.paths.map(path => path.conductances.map(clamp01).reduce((product, value) => product * value, 1)).filter(value => value > 0);
  const maxProductSupport = products.length ? Math.max(...products) : 0;
  const sumProductSupport = products.length ? clamp01(1 - products.reduce((product, value) => product * (1 - value), 1)) : 0;
  const minPlusRisk = input.paths.length
    ? Math.min(...input.paths.map(path => (path.risks ?? []).map(clamp01).reduce((sum, value) => sum + value, 0)))
    : Number.POSITIVE_INFINITY;
  const contradictionMass = clamp01(input.paths.reduce((sum, path) => sum + clamp01(path.contradiction ?? 0), 0));
  return {
    maxProductSupport,
    sumProductSupport,
    minPlusRisk,
    contradictionMass,
    netAdmissibility: clamp01(sumProductSupport - contradictionMass),
    pathCount: products.length
  };
}

export function maxFlowMinCut(input: {
  nodes: readonly string[];
  edges: Array<{ source: string; target: string; capacity: number; id?: string }>;
  source: string;
  sink: string;
}): {
  maxFlow: number;
  cutCapacity: number;
  cutEdges: string[];
  sourcePartition: string[];
  sinkPartition: string[];
  sourceCapacity: number;
  normalizedFlowRatio: number;
  unmetFlowRatio: number;
} {
  const nodes = [...new Set(input.nodes)];
  const index = new Map(nodes.map((node, i) => [node, i]));
  const source = index.get(input.source);
  const sink = index.get(input.sink);
  if (source === undefined || sink === undefined || source === sink) return {
    maxFlow: 0,
    cutCapacity: 0,
    cutEdges: [],
    sourcePartition: [],
    sinkPartition: nodes,
    sourceCapacity: 0,
    normalizedFlowRatio: 0,
    unmetFlowRatio: 1
  };
  const n = nodes.length;
  const capacity = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  for (const edge of input.edges) {
    const i = index.get(edge.source);
    const j = index.get(edge.target);
    if (i === undefined || j === undefined || i === j) continue;
    capacity[i]![j] = (capacity[i]![j] ?? 0) + Math.max(0, edge.capacity);
  }
  const residual = capacity.map(row => [...row]);
  let maxFlow = 0;
  for (let guard = 0; guard < n * Math.max(1, input.edges.length); guard++) {
    const parent = bfsParent(residual, source, sink);
    if (!parent) break;
    let pathFlow = Number.POSITIVE_INFINITY;
    for (let v = sink; v !== source; v = parent[v] ?? source) {
      const u = parent[v] ?? source;
      pathFlow = Math.min(pathFlow, residual[u]?.[v] ?? 0);
    }
    if (!Number.isFinite(pathFlow) || pathFlow <= 0) break;
    for (let v = sink; v !== source; v = parent[v] ?? source) {
      const u = parent[v] ?? source;
      residual[u]![v] = (residual[u]?.[v] ?? 0) - pathFlow;
      residual[v]![u] = (residual[v]?.[u] ?? 0) + pathFlow;
    }
    maxFlow += pathFlow;
  }
  const reachable = reachableNodes(residual, source);
  const cutEdges = input.edges
    .filter(edge => reachable.has(index.get(edge.source) ?? -1) && !reachable.has(index.get(edge.target) ?? -1) && edge.capacity > 0)
    .map((edge, edgeIndex) => edge.id ?? `${edge.source}->${edge.target}:${edgeIndex}`);
  const sourcePartition = nodes.filter((_, i) => reachable.has(i));
  const sinkPartition = nodes.filter((_, i) => !reachable.has(i));
  const cutCapacity = input.edges
    .filter(edge => reachable.has(index.get(edge.source) ?? -1) && !reachable.has(index.get(edge.target) ?? -1))
    .reduce((sum, edge) => sum + Math.max(0, edge.capacity), 0);
  const sourceCapacity = input.edges.filter(edge => edge.source === input.source).reduce((sum, edge) => sum + Math.max(0, edge.capacity), 0);
  const normalizedFlowRatio = sourceCapacity > 0 ? clamp01(maxFlow / sourceCapacity) : 0;
  return {
    maxFlow,
    cutCapacity,
    cutEdges,
    sourcePartition,
    sinkPartition,
    sourceCapacity,
    normalizedFlowRatio,
    unmetFlowRatio: 1 - normalizedFlowRatio
  };
}

export function kirchhoffBalance(input: {
  nodes: readonly string[];
  flows: Array<{ source: string; target: string; amount: number }>;
}): { maxNodeImbalance: number; totalImbalance: number; nodeImbalance: Array<{ nodeId: string; imbalance: number }> } {
  const balance = new Map(input.nodes.map(node => [node, 0]));
  for (const flow of input.flows) {
    const amount = Math.max(0, flow.amount);
    balance.set(flow.source, (balance.get(flow.source) ?? 0) - amount);
    balance.set(flow.target, (balance.get(flow.target) ?? 0) + amount);
  }
  const rows = [...balance.entries()].map(([nodeId, value]) => ({ nodeId, imbalance: Math.abs(value) }));
  const totalFlow = Math.max(1e-9, input.flows.reduce((sum, flow) => sum + Math.max(0, flow.amount), 0));
  return {
    maxNodeImbalance: clamp01(Math.max(0, ...rows.map(row => row.imbalance)) / totalFlow),
    totalImbalance: clamp01(rows.reduce((sum, row) => sum + row.imbalance, 0) / Math.max(1e-9, totalFlow * 2)),
    nodeImbalance: rows.sort((left, right) => right.imbalance - left.imbalance || left.nodeId.localeCompare(right.nodeId)).slice(0, 16)
  };
}

export function settlePottsConsistency(input: {
  nodes: readonly string[];
  edges: Array<{ source: string; target: string; coupling: number; oppose?: boolean }>;
  fields?: Record<string, readonly number[]>;
  stateCount?: number;
  iterations?: number;
}): { energy: number; states: Array<{ nodeId: string; state: number }>; contradictionPressure: number } {
  const nodes = [...input.nodes];
  const stateCount = Math.max(2, Math.min(8, input.stateCount ?? 2));
  const index = new Map(nodes.map((node, i) => [node, i]));
  const states = nodes.map((_, indexValue) => indexValue % stateCount);
  const iterations = Math.max(1, Math.min(60, input.iterations ?? 16));
  for (let step = 0; step < iterations; step++) {
    for (let i = 0; i < nodes.length; i++) {
      let bestState = states[i] ?? 0;
      let bestEnergy = Number.POSITIVE_INFINITY;
      for (let candidate = 0; candidate < stateCount; candidate++) {
        const previous = states[i] ?? 0;
        states[i] = candidate;
        const energy = pottsEnergy(nodes, states, input.edges, input.fields, index);
        states[i] = previous;
        if (energy < bestEnergy) {
          bestEnergy = energy;
          bestState = candidate;
        }
      }
      states[i] = bestState;
    }
  }
  const energy = pottsEnergy(nodes, states, input.edges, input.fields, index);
  const opposing = input.edges.filter(edge => edge.oppose);
  const unresolvedOpposing = opposing.filter(edge => {
    const left = index.get(edge.source);
    const right = index.get(edge.target);
    return left !== undefined && right !== undefined && states[left] === states[right];
  });
  return {
    energy: clamp01((energy + input.edges.length) / Math.max(1, input.edges.length * 2)),
    states: nodes.map((nodeId, i) => ({ nodeId, state: states[i] ?? 0 })),
    contradictionPressure: opposing.length ? clamp01(unresolvedOpposing.length / opposing.length) : 0
  };
}

export function leastActionPath(input: {
  nodes: readonly string[];
  edges: Array<{ source: string; target: string; cost: number; id?: string }>;
  source: string;
  target: string;
}): { cost: number; nodeIds: string[]; edgeIds: string[]; reachable: boolean } {
  const nodes = [...new Set(input.nodes)];
  const dist = new Map(nodes.map(node => [node, Number.POSITIVE_INFINITY]));
  const prev = new Map<string, { node: string; edgeId: string }>();
  const unseen = new Set(nodes);
  dist.set(input.source, 0);
  while (unseen.size) {
    const current = [...unseen].sort((left, right) => (dist.get(left) ?? Number.POSITIVE_INFINITY) - (dist.get(right) ?? Number.POSITIVE_INFINITY) || left.localeCompare(right))[0];
    if (!current || !Number.isFinite(dist.get(current) ?? Number.POSITIVE_INFINITY)) break;
    unseen.delete(current);
    if (current === input.target) break;
    for (const edge of input.edges.filter(row => row.source === current)) {
      if (!unseen.has(edge.target)) continue;
      const alt = (dist.get(current) ?? 0) + Math.max(0, edge.cost);
      if (alt < (dist.get(edge.target) ?? Number.POSITIVE_INFINITY)) {
        dist.set(edge.target, alt);
        prev.set(edge.target, { node: current, edgeId: edge.id ?? `${edge.source}->${edge.target}` });
      }
    }
  }
  const cost = dist.get(input.target) ?? Number.POSITIVE_INFINITY;
  if (!Number.isFinite(cost)) return { cost: Number.POSITIVE_INFINITY, nodeIds: [], edgeIds: [], reachable: false };
  const nodeIds = [input.target];
  const edgeIds: string[] = [];
  for (let cursor = input.target; cursor !== input.source;) {
    const row = prev.get(cursor);
    if (!row) break;
    edgeIds.push(row.edgeId);
    cursor = row.node;
    nodeIds.push(cursor);
  }
  return { cost, nodeIds: nodeIds.reverse(), edgeIds: edgeIds.reverse(), reachable: true };
}

export function freeEnergyObjective(input: { error: number; complexity: number; utility: number; lambda?: number; gamma?: number }): number {
  const lambda = Math.max(0, input.lambda ?? 0.24);
  const gamma = Math.max(0, input.gamma ?? 0.32);
  return Math.max(0, clamp01(input.error) + lambda * Math.max(0, input.complexity) - gamma * clamp01(input.utility));
}

export function boltzmannDistribution(input: { energies: readonly number[]; temperature?: number }): number[] {
  if (!input.energies.length) return [];
  const temperature = Math.max(1e-6, input.temperature ?? 0.18);
  const finite = input.energies.map(value => Number.isFinite(value) ? value : 1e6);
  const minEnergy = Math.min(...finite);
  const weights = finite.map(energy => Math.exp(-(energy - minEnergy) / temperature));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return total > 0 ? weights.map(value => value / total) : weights.map(() => 1 / weights.length);
}

export function kalmanUpdate(input: {
  estimate: number;
  estimateVariance: number;
  measurement: number;
  measurementVariance: number;
  processVariance?: number;
}): { estimate: number; variance: number; gain: number; innovation: number } {
  const predictedVariance = Math.max(1e-9, input.estimateVariance + Math.max(0, input.processVariance ?? 0.01));
  const measurementVariance = Math.max(1e-9, input.measurementVariance);
  const gain = predictedVariance / (predictedVariance + measurementVariance);
  const innovation = clamp01(input.measurement) - clamp01(input.estimate);
  const estimate = clamp01(clamp01(input.estimate) + gain * innovation);
  const variance = Math.max(0, (1 - gain) * predictedVariance);
  return { estimate, variance, gain: clamp01(gain), innovation };
}

export function replicatorDynamicsStep(input: { weights: readonly number[]; fitness: readonly number[]; floor?: number }): number[] {
  if (!input.weights.length) return [];
  const floor = Math.max(0, input.floor ?? 1e-6);
  const weights = input.weights.map(value => Math.max(floor, value));
  const fitness = weights.map((_, index) => Math.max(floor, input.fitness[index] ?? 1));
  const averageFitness = Math.max(floor, fitness.reduce((sum, value, index) => sum + value * (weights[index] ?? 0), 0) / Math.max(floor, weights.reduce((sum, value) => sum + value, 0)));
  const next = weights.map((value, index) => value * ((fitness[index] ?? floor) / averageFitness));
  const total = next.reduce((sum, value) => sum + value, 0);
  return total > 0 ? next.map(value => value / total) : weights.map(() => 1 / weights.length);
}

export function regularizedCalibrationLoss(input: { predictions: readonly number[]; outcomes: readonly boolean[]; lambda?: number; weights?: readonly number[] }): number {
  const n = Math.min(input.predictions.length, input.outcomes.length);
  if (n === 0) return 0;
  const lambda = Math.max(0, input.lambda ?? 0.001);
  let loss = 0;
  for (let i = 0; i < n; i++) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, clamp01(input.predictions[i] ?? 0)));
    const y = input.outcomes[i] ? 1 : 0;
    loss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
  }
  const regularizer = lambda * (input.weights ?? input.predictions).reduce((sum, value) => sum + value * value, 0);
  return loss / n + regularizer;
}

function validatedDiffusionLaplacian(input: readonly (readonly number[])[], size: number): number[][] {
  const matrix = validatedSymmetricMatrix(input, size);
  for (let rowIndex = 0; rowIndex < size; rowIndex++) {
    const row = matrix[rowIndex] ?? [];
    const scale = Math.max(1, ...row.map(Math.abs));
    let rowSum = 0;
    for (let columnIndex = 0; columnIndex < size; columnIndex++) {
      const value = row[columnIndex] ?? 0;
      rowSum += value;
      if (columnIndex !== rowIndex && value > 1e-10 * scale) {
        throw new RangeError("diffusion requires a graph Laplacian with non-positive off-diagonal entries");
      }
    }
    if ((row[rowIndex] ?? 0) < -1e-10 * scale || Math.abs(rowSum) > 1e-9 * size * scale) {
      throw new RangeError("diffusion requires a graph Laplacian with zero row sums and non-negative diagonal");
    }
  }
  return matrix;
}

function validatedSymmetricMatrix(input: readonly (readonly number[])[], size: number): number[][] {
  if (input.length !== size || input.some(row => row.length !== size)) {
    throw new RangeError(`expected a ${size}x${size} matrix`);
  }
  const matrix = input.map(row => row.map(finiteNumber));
  const scale = Math.max(1, ...matrix.flat().map(Math.abs));
  for (let row = 0; row < size; row++) {
    for (let column = row + 1; column < size; column++) {
      if (Math.abs((matrix[row]?.[column] ?? 0) - (matrix[column]?.[row] ?? 0)) > 1e-10 * scale) {
        throw new RangeError("matrix must be symmetric");
      }
    }
  }
  return matrix;
}

function finiteNumber(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError("matrix and vector values must be finite");
  return value;
}

function quadraticForm(matrix: readonly (readonly number[])[], values: readonly number[]): number {
  if (!values.length) return 0;
  const product = multiplyVector(matrix.map(row => [...row]), values);
  const energy = values.reduce((sum, value, index) => sum + value * (product[index] ?? 0), 0);
  return Math.abs(energy) < 1e-12 ? 0 : energy;
}

function jacobiEigenpairsSymmetric(
  input: readonly (readonly number[])[],
  maximumRotations: number
): { pairs: Array<{ value: number; vector: number[] }>; converged: boolean } {
  const n = input.length;
  const matrix = input.map(row => [...row]);
  const vectors: number[][] = Array.from({ length: n }, (_, row) =>
    Array.from({ length: n }, (_, column) => row === column ? 1 : 0)
  );
  const tolerance = 1e-12 * Math.max(1, ...matrix.flat().map(Math.abs));
  let converged = n < 2;
  for (let rotation = 0; rotation < maximumRotations && n > 1; rotation++) {
    let p = 0;
    let q = 1;
    let largest = 0;
    for (let row = 0; row < n; row++) {
      for (let column = row + 1; column < n; column++) {
        const magnitude = Math.abs(matrix[row]?.[column] ?? 0);
        if (magnitude > largest) {
          largest = magnitude;
          p = row;
          q = column;
        }
      }
    }
    if (largest <= tolerance) {
      converged = true;
      break;
    }
    const app = matrix[p]?.[p] ?? 0;
    const aqq = matrix[q]?.[q] ?? 0;
    const apq = matrix[p]?.[q] ?? 0;
    const tau = (aqq - app) / (2 * apq);
    const tangent = (tau >= 0 ? 1 : -1) / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
    const cosine = 1 / Math.sqrt(1 + tangent * tangent);
    const sine = tangent * cosine;
    for (let index = 0; index < n; index++) {
      if (index === p || index === q) continue;
      const aip = matrix[index]?.[p] ?? 0;
      const aiq = matrix[index]?.[q] ?? 0;
      const nextP = cosine * aip - sine * aiq;
      const nextQ = sine * aip + cosine * aiq;
      matrix[index]![p] = nextP;
      matrix[p]![index] = nextP;
      matrix[index]![q] = nextQ;
      matrix[q]![index] = nextQ;
    }
    matrix[p]![p] = app - tangent * apq;
    matrix[q]![q] = aqq + tangent * apq;
    matrix[p]![q] = 0;
    matrix[q]![p] = 0;
    for (let row = 0; row < n; row++) {
      const vip = vectors[row]?.[p] ?? 0;
      const viq = vectors[row]?.[q] ?? 0;
      vectors[row]![p] = cosine * vip - sine * viq;
      vectors[row]![q] = sine * vip + cosine * viq;
    }
  }
  const pairs = Array.from({ length: n }, (_, column) => ({
    value: matrix[column]?.[column] ?? 0,
    vector: Array.from({ length: n }, (_, row) => vectors[row]?.[column] ?? 0)
  })).sort((left, right) => left.value - right.value);
  return { pairs, converged };
}

function canonicalizeEigenvector(values: readonly number[]): number[] {
  const pivot = values.reduce((best, value, index) =>
    Math.abs(value) > Math.abs(values[best] ?? 0) ? index : best, 0);
  const sign = (values[pivot] ?? 0) < 0 ? -1 : 1;
  return values.map(value => sign * value);
}

function maxRowSum(matrix: readonly (readonly number[])[]): number {
  return Math.max(0, ...matrix.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)));
}

function bfsParent(residual: number[][], source: number, sink: number): number[] | undefined {
  const parent = new Array<number>(residual.length).fill(-1);
  const queue = [source];
  parent[source] = source;
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q] ?? source;
    for (let v = 0; v < residual.length; v++) {
      if (parent[v] !== -1 || (residual[u]?.[v] ?? 0) <= 1e-12) continue;
      parent[v] = u;
      if (v === sink) return parent;
      queue.push(v);
    }
  }
  return undefined;
}

function reachableNodes(residual: number[][], source: number): Set<number> {
  const seen = new Set<number>([source]);
  const queue = [source];
  for (let q = 0; q < queue.length; q++) {
    const u = queue[q] ?? source;
    for (let v = 0; v < residual.length; v++) {
      if (seen.has(v) || (residual[u]?.[v] ?? 0) <= 1e-12) continue;
      seen.add(v);
      queue.push(v);
    }
  }
  return seen;
}

function pottsEnergy(nodes: readonly string[], states: readonly number[], edges: readonly { source: string; target: string; coupling: number; oppose?: boolean }[], fields: Record<string, readonly number[]> | undefined, index: Map<string, number>): number {
  let energy = 0;
  for (const edge of edges) {
    const left = index.get(edge.source);
    const right = index.get(edge.target);
    if (left === undefined || right === undefined) continue;
    const same = states[left] === states[right];
    const coupling = clamp01(edge.coupling);
    energy += edge.oppose ? (same ? coupling : -coupling) : (same ? -coupling : coupling);
  }
  for (const node of nodes) {
    const state = states[index.get(node) ?? 0] ?? 0;
    energy -= clamp01(fields?.[node]?.[state] ?? 0);
  }
  return energy;
}
