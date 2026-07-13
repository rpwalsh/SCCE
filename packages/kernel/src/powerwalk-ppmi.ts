import { stableVector } from "./primitives.js";
import type { Hasher, NodeId } from "./types.js";

export const POWERWALK_COOCCURRENCE_VERSION = "powerwalk.cooccurrence.v3" as const;
export const POWERWALK_REPRESENTATION_VERSION = "powerwalk.sparse-ppmi-projection.v1" as const;
export const POWERWALK_PARTITION_SCHEMA = "powerwalk.pair-hash-partition.v1" as const;

export interface PowerWalkCooccurrenceRow {
  nodeId: NodeId;
  contextNodeId: NodeId;
  count: number;
  distanceMean: number;
  weight: number;
}

export interface SparseCooccurrenceCount {
  nodeId: NodeId;
  contextNodeId: NodeId;
  count: number;
  distanceSum: number;
}

/**
 * Sufficient statistics for rebuilding PPMI after an incremental graph update.
 * Counts, rather than derived PPMI values, are retained because PMI changes when
 * any row or context marginal changes.
 */
export interface SparseCooccurrenceState {
  version: typeof POWERWALK_COOCCURRENCE_VERSION;
  window: number;
  partitionPolicyHash: string;
  totalCount: number;
  appliedSnapshotIds: string[];
  entries: SparseCooccurrenceCount[];
}

export interface PowerWalkPartitionIdentity {
  schema: typeof POWERWALK_PARTITION_SCHEMA;
  seed: string;
  validationFraction: number;
  policyHash: string;
  trainingHash: string;
  validationHash: string;
  splitHash: string;
}

export interface SparsePpmiDiagnostics {
  version: typeof POWERWALK_REPRESENTATION_VERSION;
  method: "positive_pointwise_mutual_information_with_seeded_sparse_projection";
  dimensions: number;
  projectionSeed: string;
  trainPairs: number;
  trainEvents: number;
  priorEvents: number;
  positivePpmiEntries: number;
  representedNodes: number;
  zeroContextNodes: number;
  validationPairs: number;
  validationEvents: number;
  validationPositiveCosineMean?: number;
  validationNegativeCosineMean?: number;
  validationCosineMargin?: number;
  validationHashCosineMargin?: number;
  validationLearnedVsHashMargin?: number;
  partitionPolicyHash: string;
  currentSplitHash: string;
  validationHash: string;
  priorStateDisposition: "not_provided" | "reused" | "reset_partition_mismatch";
  dataHash: string;
  modelHash: string;
  validationInterpretation: "not_available" | "held_out_pair_similarity_vs_hash_baseline";
}

export interface SparsePpmiFit {
  embeddings: Array<{ nodeId: NodeId; vector: number[] }>;
  state: SparseCooccurrenceState;
  diagnostics: SparsePpmiDiagnostics;
}

export interface SparsePpmiOptions {
  hasher: Hasher;
  dimensions?: number;
  projectionSeed?: string;
  window?: number;
  priorState?: SparseCooccurrenceState;
  snapshotId?: string;
  validation?: readonly PowerWalkCooccurrenceRow[];
  partition?: PowerWalkPartitionIdentity;
  partitionMismatch?: "reject" | "reset";
}

/**
 * Fit a sparse PPMI representation and reduce it with a deterministic sparse
 * signed projection. This is a representation learned from graph-walk context
 * counts; the hasher only defines the projection matrix and does not supply the
 * semantic features.
 */
export function fitSparsePpmiRepresentation(
  nodeIds: readonly NodeId[],
  training: readonly PowerWalkCooccurrenceRow[],
  options: SparsePpmiOptions
): SparsePpmiFit {
  const dimensions = clampInteger(options.dimensions ?? 64, 2, 512);
  const projectionSeed = options.projectionSeed ?? "powerwalk-ppmi";
  const window = clampInteger(options.window ?? options.priorState?.window ?? 4, 1, 64);
  for (const row of training) validateObservation(row);
  for (const row of options.validation ?? []) validateObservation(row);
  const partition = options.partition ?? callerSuppliedPartition(training, options.validation ?? [], options.hasher);
  validatePartitionIdentity(partition, training, options.validation ?? [], options.hasher);
  let priorState = options.priorState;
  let priorStateDisposition: SparsePpmiDiagnostics["priorStateDisposition"] = priorState ? "reused" : "not_provided";
  if (priorState && priorState.partitionPolicyHash !== partition.policyHash && options.partitionMismatch === "reset") {
    priorState = undefined;
    priorStateDisposition = "reset_partition_mismatch";
  }
  validatePriorState(priorState, window, partition.policyHash);

  const priorEntries = priorState?.entries ?? [];
  const snapshotId = options.snapshotId?.trim() || options.hasher.digestHex(JSON.stringify({
    schema: "powerwalk.training-snapshot.v1",
    partitionPolicyHash: partition.policyHash,
    splitHash: partition.splitHash
  }));
  const replayedSnapshot = priorState?.appliedSnapshotIds.includes(snapshotId) === true;
  const currentEntries = replayedSnapshot ? [] : training.map(toCountEntry);
  const mergedEntries = mergeCountEntries(priorEntries, currentEntries);
  const state = createSparseCooccurrenceState(mergedEntries, window, partition.policyHash, [
    ...(priorState?.appliedSnapshotIds ?? []),
    ...(replayedSnapshot ? [] : [snapshotId])
  ]);
  const rowMass = new Map<NodeId, number>();
  const contextMass = new Map<NodeId, number>();
  for (const entry of state.entries) {
    add(rowMass, entry.nodeId, entry.count);
    add(contextMass, entry.contextNodeId, entry.count);
  }

  const vectors = new Map<NodeId, number[]>();
  let positivePpmiEntries = 0;
  for (const entry of state.entries) {
    const rowTotal = rowMass.get(entry.nodeId) ?? 0;
    const contextTotal = contextMass.get(entry.contextNodeId) ?? 0;
    if (entry.count <= 0 || rowTotal <= 0 || contextTotal <= 0 || state.totalCount <= 0) continue;
    const ppmi = Math.max(0, Math.log((entry.count * state.totalCount) / (rowTotal * contextTotal)));
    if (!(ppmi > 0) || !Number.isFinite(ppmi)) continue;
    positivePpmiEntries++;
    const vector = vectors.get(entry.nodeId) ?? new Array<number>(dimensions).fill(0);
    projectSparseFeature(vector, String(entry.contextNodeId), ppmi, projectionSeed, options.hasher);
    vectors.set(entry.nodeId, vector);
  }

  const embeddings = nodeIds.map(nodeId => ({
    nodeId,
    vector: l2Normalize(vectors.get(nodeId) ?? new Array<number>(dimensions).fill(0))
  }));
  const embeddingMap = new Map(embeddings.map(row => [row.nodeId, row.vector]));
  const validation = options.validation ?? [];
  const validationMetrics = evaluateHeldOutPairSimilarity(embeddingMap, validation, state.entries, options.hasher, projectionSeed, dimensions);
  const representedNodes = embeddings.filter(row => squaredNorm(row.vector) > 0).length;
  const dataHash = options.hasher.digestHex(JSON.stringify({
    version: state.version,
    window: state.window,
    partitionPolicyHash: state.partitionPolicyHash,
    totalCount: state.totalCount,
    entries: state.entries
  }));
  const modelHash = options.hasher.digestHex(JSON.stringify({
    version: POWERWALK_REPRESENTATION_VERSION,
    dimensions,
    projectionSeed,
    partitionPolicyHash: partition.policyHash,
    validationHash: partition.validationHash,
    dataHash
  }));

  return {
    embeddings,
    state,
    diagnostics: {
      version: POWERWALK_REPRESENTATION_VERSION,
      method: "positive_pointwise_mutual_information_with_seeded_sparse_projection",
      dimensions,
      projectionSeed,
      trainPairs: currentEntries.length,
      trainEvents: sumCounts(currentEntries),
      priorEvents: priorState?.totalCount ?? 0,
      positivePpmiEntries,
      representedNodes,
      zeroContextNodes: embeddings.length - representedNodes,
      validationPairs: validation.filter(row => row.count > 0).length,
      validationEvents: sumCounts(validation),
      partitionPolicyHash: partition.policyHash,
      currentSplitHash: partition.splitHash,
      validationHash: partition.validationHash,
      priorStateDisposition,
      dataHash,
      modelHash,
      ...validationMetrics
    }
  };
}

/** Merge raw count state without freezing stale PMI values. */
export function mergeSparseCooccurrenceState(
  previous: SparseCooccurrenceState | undefined,
  observations: readonly PowerWalkCooccurrenceRow[],
  window = previous?.window ?? 4,
  snapshotId?: string,
  partitionPolicyHash = previous?.partitionPolicyHash ?? "powerwalk.partition.unspecified.v1"
): SparseCooccurrenceState {
  const normalizedWindow = clampInteger(window, 1, 64);
  validatePriorState(previous, normalizedWindow, partitionPolicyHash);
  for (const row of observations) validateObservation(row);
  const cleanSnapshotId = snapshotId?.trim();
  const replayedSnapshot = Boolean(cleanSnapshotId && previous?.appliedSnapshotIds.includes(cleanSnapshotId));
  return createSparseCooccurrenceState(
    mergeCountEntries(previous?.entries ?? [], replayedSnapshot ? [] : observations.map(toCountEntry)),
    normalizedWindow,
    partitionPolicyHash,
    [...(previous?.appliedSnapshotIds ?? []), ...(!replayedSnapshot && cleanSnapshotId ? [cleanSnapshotId] : [])]
  );
}

/**
 * Deterministically reserve whole node-context pairs for validation. A pair is
 * never present in both partitions, preventing count-level train/test leakage.
 */
export function splitCooccurrenceForValidation(
  rows: readonly PowerWalkCooccurrenceRow[],
  options: { hasher: Hasher; seed: string; validationFraction?: number }
): { training: PowerWalkCooccurrenceRow[]; validation: PowerWalkCooccurrenceRow[]; partition: PowerWalkPartitionIdentity } {
  const fraction = clamp(options.validationFraction ?? 0.2, 0, 0.5);
  const ranked = rows.filter(row => {
    validateObservation(row);
    return row.count > 0;
  }).map(row => ({
    row: { ...row },
    unit: hashUnit(options.hasher, `${options.seed}:${String(row.nodeId)}:${String(row.contextNodeId)}:split`)
  })).sort((left, right) => left.unit - right.unit || compareObservationRows(left.row, right.row));
  const training: PowerWalkCooccurrenceRow[] = [];
  const validation: PowerWalkCooccurrenceRow[] = [];
  for (const { row, unit } of ranked) {
    (fraction > 0 && unit < fraction ? validation : training).push(row);
  }
  // A tiny dataset can hash entirely into validation. Retain one deterministic
  // training pair so representation fitting remains defined; do not force a
  // validation pair because doing so would make assignments dataset-size based.
  if (training.length === 0 && validation.length > 0) {
    training.push(validation.pop()!);
  }
  return { training, validation, partition: partitionIdentity(training, validation, options.seed, fraction, options.hasher) };
}

function createSparseCooccurrenceState(entries: readonly SparseCooccurrenceCount[], window: number, partitionPolicyHash: string, appliedSnapshotIds: readonly string[]): SparseCooccurrenceState {
  const sorted = entries
    .filter(entry => entry.count > 0)
    .map(entry => ({ ...entry }))
    .sort(compareEntries);
  return {
    version: POWERWALK_COOCCURRENCE_VERSION,
    window,
    partitionPolicyHash,
    totalCount: sumCounts(sorted),
    appliedSnapshotIds: [...new Set(appliedSnapshotIds.filter(Boolean))].sort(),
    entries: sorted
  };
}

function mergeCountEntries(
  left: readonly SparseCooccurrenceCount[],
  right: readonly SparseCooccurrenceCount[]
): SparseCooccurrenceCount[] {
  const merged = new Map<string, SparseCooccurrenceCount>();
  for (const entry of [...left, ...right]) {
    if (!(entry.count > 0) || !Number.isFinite(entry.count)) continue;
    const key = pairKey(entry.nodeId, entry.contextNodeId);
    const existing = merged.get(key);
    if (existing) {
      existing.count += entry.count;
      existing.distanceSum += entry.distanceSum;
    } else {
      merged.set(key, { ...entry });
    }
  }
  return [...merged.values()].sort(compareEntries);
}

function projectSparseFeature(vector: number[], feature: string, value: number, seed: string, hasher: Hasher): void {
  // Three non-zero entries per source dimension form a sparse signed projection.
  // Lanes are independently salted and scaled to keep expected squared norm.
  const lanes = Math.min(3, vector.length);
  const scale = value / Math.sqrt(lanes);
  for (let lane = 0; lane < lanes; lane++) {
    const digest = hasher.digestHex(`${seed}:${feature}:${lane}`);
    const bucket = Number.parseInt(digest.slice(0, 8), 16) % vector.length;
    const sign = Number.parseInt(digest.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
    vector[bucket] = (vector[bucket] ?? 0) + sign * scale;
  }
}

function evaluateHeldOutPairSimilarity(
  embeddings: ReadonlyMap<NodeId, readonly number[]>,
  validation: readonly PowerWalkCooccurrenceRow[],
  training: readonly SparseCooccurrenceCount[],
  hasher: Hasher,
  seed: string,
  dimensions: number
): Pick<SparsePpmiDiagnostics, "validationPositiveCosineMean" | "validationNegativeCosineMean" | "validationCosineMargin" | "validationHashCosineMargin" | "validationLearnedVsHashMargin" | "validationInterpretation"> {
  const nodeIds = [...embeddings.keys()].sort((a, b) => String(a).localeCompare(String(b)));
  const knownPositivePairs = new Set([
    ...training.map(row => pairKey(row.nodeId, row.contextNodeId)),
    ...validation.map(row => pairKey(row.nodeId, row.contextNodeId))
  ]);
  const positives: number[] = [];
  const negatives: number[] = [];
  const hashPositives: number[] = [];
  const hashNegatives: number[] = [];
  for (const row of validation) {
    if (!(row.count > 0)) continue;
    const source = embeddings.get(row.nodeId);
    const context = embeddings.get(row.contextNodeId);
    if (!source || !context || squaredNorm(source) === 0 || squaredNorm(context) === 0) continue;
    positives.push(cosine(source, context));
    const candidates = nodeIds.filter(id => id !== row.nodeId
      && id !== row.contextNodeId
      && !knownPositivePairs.has(pairKey(row.nodeId, id))
      && squaredNorm(embeddings.get(id) ?? []) > 0);
    if (candidates.length === 0) continue;
    const index = Math.floor(hashUnit(hasher, `${seed}:${String(row.nodeId)}:${String(row.contextNodeId)}:negative`) * candidates.length);
    const negative = embeddings.get(candidates[Math.min(candidates.length - 1, index)]!);
    if (negative) {
      negatives.push(cosine(source, negative));
      const hashSource = stableVector([String(row.nodeId)], hasher, dimensions);
      hashPositives.push(cosine(hashSource, stableVector([String(row.contextNodeId)], hasher, dimensions)));
      hashNegatives.push(cosine(hashSource, stableVector([String(candidates[Math.min(candidates.length - 1, index)]!)], hasher, dimensions)));
    }
  }
  if (positives.length === 0 || negatives.length === 0 || hashPositives.length === 0 || hashNegatives.length === 0) return { validationInterpretation: "not_available" };
  const positiveMean = arithmeticMean(positives);
  const negativeMean = arithmeticMean(negatives);
  const learnedMargin = positiveMean - negativeMean;
  const hashMargin = arithmeticMean(hashPositives) - arithmeticMean(hashNegatives);
  return {
    validationPositiveCosineMean: positiveMean,
    validationNegativeCosineMean: negativeMean,
    validationCosineMargin: learnedMargin,
    validationHashCosineMargin: hashMargin,
    validationLearnedVsHashMargin: learnedMargin - hashMargin,
    validationInterpretation: "held_out_pair_similarity_vs_hash_baseline"
  };
}

function validatePriorState(state: SparseCooccurrenceState | undefined, window: number, partitionPolicyHash: string): void {
  if (!state) return;
  if (state.version !== POWERWALK_COOCCURRENCE_VERSION) throw new Error(`Unsupported PowerWalk co-occurrence state version: ${String(state.version)}`);
  if (state.window !== window) throw new Error(`PowerWalk co-occurrence window mismatch: prior=${state.window}, requested=${window}`);
  if (!/^[a-z0-9._:-]+$|^[a-f0-9]{64}$/u.test(state.partitionPolicyHash) || !state.partitionPolicyHash.trim()) throw new Error("PowerWalk prior partition policy hash is invalid");
  if (state.partitionPolicyHash !== partitionPolicyHash) throw new Error(`PowerWalk partition policy mismatch: prior=${state.partitionPolicyHash}, requested=${partitionPolicyHash}`);
  if (!Array.isArray(state.appliedSnapshotIds) || state.appliedSnapshotIds.some(id => typeof id !== "string" || id.trim().length === 0)) throw new Error("PowerWalk prior snapshot identities are invalid");
  for (const entry of state.entries) validateCountEntry(entry);
  if (state.totalCount !== sumCounts(state.entries)) throw new Error("PowerWalk prior totalCount does not match its entries");
}

function callerSuppliedPartition(
  training: readonly PowerWalkCooccurrenceRow[],
  validation: readonly PowerWalkCooccurrenceRow[],
  hasher: Hasher
): PowerWalkPartitionIdentity {
  return partitionIdentity(training, validation, "caller-supplied", 0, hasher);
}

function partitionIdentity(
  training: readonly PowerWalkCooccurrenceRow[],
  validation: readonly PowerWalkCooccurrenceRow[],
  seed: string,
  validationFraction: number,
  hasher: Hasher
): PowerWalkPartitionIdentity {
  const policyHash = hasher.digestHex(JSON.stringify({ schema: POWERWALK_PARTITION_SCHEMA, seed, validationFraction }));
  const trainingHash = observationRowsHash(training, hasher);
  const validationHash = observationRowsHash(validation, hasher);
  return {
    schema: POWERWALK_PARTITION_SCHEMA,
    seed,
    validationFraction,
    policyHash,
    trainingHash,
    validationHash,
    splitHash: hasher.digestHex(JSON.stringify({ schema: POWERWALK_PARTITION_SCHEMA, policyHash, trainingHash, validationHash }))
  };
}

function validatePartitionIdentity(
  identity: PowerWalkPartitionIdentity,
  training: readonly PowerWalkCooccurrenceRow[],
  validation: readonly PowerWalkCooccurrenceRow[],
  hasher: Hasher
): void {
  if (identity.schema !== POWERWALK_PARTITION_SCHEMA) throw new Error(`Unsupported PowerWalk partition schema: ${String(identity.schema)}`);
  const expected = partitionIdentity(training, validation, identity.seed, identity.validationFraction, hasher);
  if (identity.policyHash !== expected.policyHash || identity.trainingHash !== expected.trainingHash || identity.validationHash !== expected.validationHash || identity.splitHash !== expected.splitHash) {
    throw new Error("PowerWalk partition identity does not match the supplied training and validation rows");
  }
}

function observationRowsHash(rows: readonly PowerWalkCooccurrenceRow[], hasher: Hasher): string {
  return hasher.digestHex(JSON.stringify([...rows].map(row => ({ ...row })).sort(compareObservationRows)));
}

function toCountEntry(row: PowerWalkCooccurrenceRow): SparseCooccurrenceCount {
  const count = Math.max(0, Math.floor(row.count));
  return {
    nodeId: row.nodeId,
    contextNodeId: row.contextNodeId,
    count,
    distanceSum: Math.max(0, row.distanceMean) * count
  };
}

function compareEntries(a: SparseCooccurrenceCount, b: SparseCooccurrenceCount): number {
  return String(a.nodeId).localeCompare(String(b.nodeId)) || String(a.contextNodeId).localeCompare(String(b.contextNodeId));
}

function compareObservationRows(a: PowerWalkCooccurrenceRow, b: PowerWalkCooccurrenceRow): number {
  return String(a.nodeId).localeCompare(String(b.nodeId)) || String(a.contextNodeId).localeCompare(String(b.contextNodeId));
}

function pairKey(nodeId: NodeId, contextNodeId: NodeId): string {
  return `${String(nodeId)}\u001f${String(contextNodeId)}`;
}

function add(map: Map<NodeId, number>, key: NodeId, value: number): void {
  map.set(key, (map.get(key) ?? 0) + value);
}

function sumCounts(rows: readonly { count: number }[]): number {
  return rows.reduce((sum, row) => sum + Math.max(0, row.count), 0);
}

function squaredNorm(vector: readonly number[]): number {
  return vector.reduce((sum, value) => sum + value * value, 0);
}

function l2Normalize(vector: readonly number[]): number[] {
  const norm = Math.sqrt(squaredNorm(vector));
  return norm > 0 ? vector.map(value => value / norm) : [...vector];
}

function cosine(left: readonly number[], right: readonly number[]): number {
  const size = Math.max(left.length, right.length);
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < size; index++) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    dot += a * b;
    leftNorm += a * a;
    rightNorm += b * b;
  }
  return leftNorm > 0 && rightNorm > 0 ? dot / Math.sqrt(leftNorm * rightNorm) : 0;
}

function arithmeticMean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function hashUnit(hasher: Hasher, input: string): number {
  return Number.parseInt(hasher.digestHex(input).slice(0, 12), 16) / 0x1000000000000;
}

function clampInteger(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function validateObservation(row: PowerWalkCooccurrenceRow): void {
  if (!Number.isSafeInteger(row.count) || row.count < 0) throw new Error("PowerWalk co-occurrence count must be a non-negative safe integer");
  if (!Number.isFinite(row.distanceMean) || row.distanceMean < 0) throw new Error("PowerWalk co-occurrence distanceMean must be finite and non-negative");
  if (!Number.isFinite(row.weight) || row.weight < 0) throw new Error("PowerWalk co-occurrence weight must be finite and non-negative");
}

function validateCountEntry(entry: SparseCooccurrenceCount): void {
  if (!Number.isSafeInteger(entry.count) || entry.count < 0) throw new Error("PowerWalk prior count must be a non-negative safe integer");
  if (!Number.isFinite(entry.distanceSum) || entry.distanceSum < 0) throw new Error("PowerWalk prior distanceSum must be finite and non-negative");
}
