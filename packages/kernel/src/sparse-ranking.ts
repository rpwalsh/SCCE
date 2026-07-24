import { canonicalStringify, createClock, createHasher } from "./primitives.js";
import type { Clock, Hasher } from "./types.js";

const SPARSE_VECTOR_SCHEMA = "scce.sparse-vector.v1";
const BM25_SCHEMA = "scce.sparse-bm25.v1";
const FTRL_SCHEMA = "scce.ftrl-proximal-ranker.v1";
const DEFAULT_MAX_FEATURES = 4_096;
const DEFAULT_MAX_DOCUMENTS = 100_000;

declare const sparseFeatureIdBrand: unique symbol;

/**
 * Opaque, language-neutral identity for one typed feature. The source value is
 * deliberately not retained in the ID, so labels remain evidence metadata
 * rather than becoming a hand-authored ontology.
 */
export type SparseFeatureId = string & { readonly [sparseFeatureIdBrand]: true };

export interface SparseFeatureEntry {
  id: SparseFeatureId;
  value: number;
}

export interface SparseVector {
  schemaVersion: typeof SPARSE_VECTOR_SCHEMA;
  entries: SparseFeatureEntry[];
  l1Norm: number;
  squaredL2Norm: number;
}

export interface Bm25Parameters {
  k1: number;
  b: number;
}

export interface Bm25Document {
  id: string;
  features: SparseVector;
}

export interface Bm25DocumentState {
  id: string;
  length: number;
  features: SparseFeatureEntry[];
}

export interface Bm25DocumentFrequency {
  id: SparseFeatureId;
  documents: number;
}

export interface Bm25SparseIndexState {
  schemaVersion: typeof BM25_SCHEMA;
  parameters: Bm25Parameters;
  documentCount: number;
  averageDocumentLength: number;
  documentFrequency: Bm25DocumentFrequency[];
  documents: Bm25DocumentState[];
}

export interface Bm25TermContribution {
  featureId: SparseFeatureId;
  termFrequency: number;
  documentFrequency: number;
  inverseDocumentFrequency: number;
  queryWeight: number;
  contribution: number;
}

export interface Bm25DocumentScore {
  documentId: string;
  score: number;
  terms: Bm25TermContribution[];
}

export interface Bm25SparseIndex {
  score(documentId: string, query: SparseVector): Bm25DocumentScore | undefined;
  rank(query: SparseVector, limit?: number): Bm25DocumentScore[];
  snapshot(): Bm25SparseIndexState;
  serialize(): string;
}

export interface FtrlHyperparameters {
  alpha: number;
  beta: number;
  l1: number;
  l2: number;
}

export interface FtrlCoordinateState {
  id: SparseFeatureId;
  z: number;
  n: number;
}

export interface FtrlProximalRankerState {
  schemaVersion: typeof FTRL_SCHEMA;
  modelId: string;
  featureSchemaId: string;
  hyperparameters: FtrlHyperparameters;
  createdAt: number;
  updatedAt: number;
  examplesSeen: number;
  coordinates: FtrlCoordinateState[];
}

export interface SparseScoreContribution {
  featureId: SparseFeatureId;
  value: number;
  weight: number;
  contribution: number;
}

export interface SparseRankerScore {
  rawScore: number;
  probability: number;
  reliability: "uncalibrated";
  contributions: SparseScoreContribution[];
}

export interface FtrlProximalRanker {
  score(features: SparseVector): SparseRankerScore;
  update(input: { features: SparseVector; label: 0 | 1; weight?: number }): SparseRankerScore;
  updatePair(input: { preferred: SparseVector; rejected: SparseVector; weight?: number }): SparseRankerScore;
  snapshot(): FtrlProximalRankerState;
  serialize(): string;
}

export function createTypedSparseFeatureId(input: {
  familyId: string;
  value: unknown;
  hasher?: Hasher;
}): SparseFeatureId {
  const familyId = requireIdentity(input.familyId, "feature family");
  const digest = (input.hasher ?? createHasher()).digestHex(canonicalStringify({
    familyId,
    value: input.value
  }));
  return `sf_${digest}` as SparseFeatureId;
}

export function createSparseVector(
  entries: Iterable<{ id: SparseFeatureId; value: number }>,
  options: { maxFeatures?: number } = {}
): SparseVector {
  const maxFeatures = positiveInteger(options.maxFeatures ?? DEFAULT_MAX_FEATURES, "maxFeatures");
  const values = new Map<SparseFeatureId, number>();
  for (const entry of entries) {
    requireSparseFeatureId(entry.id);
    if (!Number.isFinite(entry.value)) throw new Error(`sparse feature ${entry.id} must be finite`);
    if (entry.value === 0) continue;
    const next = (values.get(entry.id) ?? 0) + entry.value;
    if (!Number.isFinite(next)) throw new Error(`sparse feature ${entry.id} overflowed`);
    if (next === 0) values.delete(entry.id);
    else values.set(entry.id, next);
    if (values.size > maxFeatures) throw new Error(`sparse vector exceeds ${maxFeatures} features`);
  }
  const normalized = [...values.entries()]
    .map(([id, value]) => ({ id, value }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    schemaVersion: SPARSE_VECTOR_SCHEMA,
    entries: normalized,
    l1Norm: normalized.reduce((sum, entry) => sum + Math.abs(entry.value), 0),
    squaredL2Norm: normalized.reduce((sum, entry) => sum + entry.value * entry.value, 0)
  };
}

export function subtractSparseVectors(left: SparseVector, right: SparseVector): SparseVector {
  assertSparseVector(left);
  assertSparseVector(right);
  return createSparseVector([
    ...left.entries,
    ...right.entries.map(entry => ({ id: entry.id, value: -entry.value }))
  ], { maxFeatures: left.entries.length + right.entries.length || 1 });
}

export function sparseDot(
  vector: SparseVector,
  weight: (featureId: SparseFeatureId) => number
): number {
  assertSparseVector(vector);
  return vector.entries.reduce((sum, entry) => sum + entry.value * finiteOrThrow(
    weight(entry.id),
    `weight for ${entry.id}`
  ), 0);
}

export function createBm25SparseIndex(
  documents: readonly Bm25Document[],
  options: Partial<Bm25Parameters> & { maxDocuments?: number } = {}
): Bm25SparseIndex {
  const maxDocuments = positiveInteger(options.maxDocuments ?? DEFAULT_MAX_DOCUMENTS, "maxDocuments");
  if (documents.length > maxDocuments) throw new Error(`BM25 index exceeds ${maxDocuments} documents`);
  const parameters = validateBm25Parameters({
    k1: options.k1 ?? 1.2,
    b: options.b ?? 0.75
  });
  const seen = new Set<string>();
  const states = documents.map(document => {
    const id = requireIdentity(document.id, "document");
    if (seen.has(id)) throw new Error(`duplicate BM25 document ${id}`);
    seen.add(id);
    assertSparseVector(document.features);
    const features = document.features.entries
      .filter(entry => entry.value > 0)
      .map(entry => ({ id: entry.id, value: entry.value }));
    return {
      id,
      length: features.reduce((sum, entry) => sum + entry.value, 0),
      features
    };
  }).sort((left, right) => left.id.localeCompare(right.id));
  const frequencies = new Map<SparseFeatureId, number>();
  for (const document of states) {
    for (const entry of document.features) {
      frequencies.set(entry.id, (frequencies.get(entry.id) ?? 0) + 1);
    }
  }
  return hydrateBm25Index({
    schemaVersion: BM25_SCHEMA,
    parameters,
    documentCount: states.length,
    averageDocumentLength: states.length
      ? states.reduce((sum, document) => sum + document.length, 0) / states.length
      : 0,
    documentFrequency: [...frequencies.entries()]
      .map(([id, count]) => ({ id, documents: count }))
      .sort((left, right) => left.id.localeCompare(right.id)),
    documents: states
  });
}

export function restoreBm25SparseIndex(serialized: string | Bm25SparseIndexState): Bm25SparseIndex {
  const state = typeof serialized === "string"
    ? JSON.parse(serialized) as Bm25SparseIndexState
    : serialized;
  validateBm25State(state);
  return hydrateBm25Index(copyBm25State(state));
}

export function createFtrlProximalRanker(options: {
  modelId: string;
  featureSchemaId: string;
  clock?: Clock;
  hyperparameters?: Partial<FtrlHyperparameters>;
  state?: FtrlProximalRankerState;
}): FtrlProximalRanker {
  const clock = options.clock ?? createClock();
  const state = options.state
    ? copyFtrlState(validateFtrlState(options.state))
    : newFtrlState(options, clock);
  if (state.modelId !== requireIdentity(options.modelId, "model")) {
    throw new Error(`FTRL state model ${state.modelId} does not match ${options.modelId}`);
  }
  if (state.featureSchemaId !== requireIdentity(options.featureSchemaId, "feature schema")) {
    throw new Error(`FTRL feature schema ${state.featureSchemaId} does not match ${options.featureSchemaId}`);
  }
  const coordinates = new Map<SparseFeatureId, FtrlCoordinateState>(
    state.coordinates.map(coordinate => [coordinate.id, { ...coordinate }])
  );

  const coordinateWeight = (featureId: SparseFeatureId): number => {
    const coordinate = coordinates.get(featureId);
    if (!coordinate) return 0;
    const { alpha, beta, l1, l2 } = state.hyperparameters;
    if (Math.abs(coordinate.z) <= l1) return 0;
    return -(coordinate.z - Math.sign(coordinate.z) * l1)
      / ((beta + Math.sqrt(coordinate.n)) / alpha + l2);
  };

  const score = (features: SparseVector): SparseRankerScore => {
    assertSparseVector(features);
    const contributions = features.entries.map(entry => {
      const weight = coordinateWeight(entry.id);
      return {
        featureId: entry.id,
        value: entry.value,
        weight,
        contribution: entry.value * weight
      };
    }).filter(entry => entry.contribution !== 0);
    const rawScore = contributions.reduce((sum, entry) => sum + entry.contribution, 0);
    return {
      rawScore,
      probability: sigmoid(rawScore),
      reliability: "uncalibrated",
      contributions
    };
  };

  const applyGradient = (features: SparseVector, multiplier: number): void => {
    if (!Number.isFinite(multiplier)) throw new Error("FTRL gradient multiplier must be finite");
    const { alpha } = state.hyperparameters;
    for (const feature of features.entries) {
      const gradient = multiplier * feature.value;
      if (gradient === 0) continue;
      const coordinate = coordinates.get(feature.id) ?? { id: feature.id, z: 0, n: 0 };
      const weight = coordinateWeight(feature.id);
      const nextN = coordinate.n + gradient * gradient;
      const sigma = (Math.sqrt(nextN) - Math.sqrt(coordinate.n)) / alpha;
      coordinate.z += gradient - sigma * weight;
      coordinate.n = nextN;
      coordinates.set(feature.id, coordinate);
    }
    state.examplesSeen += 1;
    state.updatedAt = clock.now();
  };

  return {
    score,
    update(input) {
      const sampleWeight = nonNegativeFinite(input.weight ?? 1, "sample weight");
      const before = score(input.features);
      if (sampleWeight === 0) return before;
      applyGradient(input.features, (before.probability - input.label) * sampleWeight);
      return score(input.features);
    },
    updatePair(input) {
      const sampleWeight = nonNegativeFinite(input.weight ?? 1, "sample weight");
      const difference = subtractSparseVectors(input.preferred, input.rejected);
      const before = score(difference);
      if (sampleWeight === 0) return before;
      applyGradient(difference, (before.probability - 1) * sampleWeight);
      return score(difference);
    },
    snapshot() {
      return {
        ...copyFtrlState(state),
        coordinates: [...coordinates.values()]
          .map(coordinate => ({ ...coordinate }))
          .sort((left, right) => left.id.localeCompare(right.id))
      };
    },
    serialize() {
      return canonicalStringify(this.snapshot());
    }
  };
}

export function restoreFtrlProximalRanker(
  serialized: string,
  options: { modelId: string; featureSchemaId: string; clock?: Clock }
): FtrlProximalRanker {
  return createFtrlProximalRanker({
    ...options,
    state: JSON.parse(serialized) as FtrlProximalRankerState
  });
}

function hydrateBm25Index(state: Bm25SparseIndexState): Bm25SparseIndex {
  validateBm25State(state);
  const documents = new Map(state.documents.map(document => [document.id, document]));
  const documentFrequency = new Map(state.documentFrequency.map(entry => [entry.id, entry.documents]));
  const postings = new Map<SparseFeatureId, Set<string>>();
  for (const document of state.documents) {
    for (const feature of document.features) {
      const ids = postings.get(feature.id) ?? new Set<string>();
      ids.add(document.id);
      postings.set(feature.id, ids);
    }
  }
  const score = (documentId: string, query: SparseVector): Bm25DocumentScore | undefined => {
    assertSparseVector(query);
    const document = documents.get(documentId);
    if (!document) return undefined;
    const values = new Map(document.features.map(feature => [feature.id, feature.value]));
    const terms = query.entries.flatMap(queryFeature => {
      if (queryFeature.value <= 0) return [];
      const termFrequency = values.get(queryFeature.id) ?? 0;
      if (termFrequency <= 0) return [];
      const frequency = documentFrequency.get(queryFeature.id) ?? 0;
      const inverseDocumentFrequency = Math.log(
        1 + (state.documentCount - frequency + 0.5) / (frequency + 0.5)
      );
      const lengthRatio = state.averageDocumentLength > 0
        ? document.length / state.averageDocumentLength
        : 0;
      const denominator = termFrequency + state.parameters.k1
        * (1 - state.parameters.b + state.parameters.b * lengthRatio);
      const contribution = inverseDocumentFrequency
        * (termFrequency * (state.parameters.k1 + 1) / denominator)
        * queryFeature.value;
      return [{
        featureId: queryFeature.id,
        termFrequency,
        documentFrequency: frequency,
        inverseDocumentFrequency,
        queryWeight: queryFeature.value,
        contribution
      }];
    });
    return {
      documentId,
      score: terms.reduce((sum, term) => sum + term.contribution, 0),
      terms
    };
  };
  const snapshot = () => copyBm25State(state);
  return {
    score,
    rank(query, limit = 20) {
      assertSparseVector(query);
      const boundedLimit = positiveInteger(limit, "BM25 result limit");
      const candidateIds = new Set<string>();
      for (const feature of query.entries) {
        for (const documentId of postings.get(feature.id) ?? []) candidateIds.add(documentId);
      }
      return [...candidateIds]
        .map(documentId => score(documentId, query))
        .filter((row): row is Bm25DocumentScore => row !== undefined && row.score > 0)
        .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId))
        .slice(0, boundedLimit);
    },
    snapshot,
    serialize() {
      return canonicalStringify(snapshot());
    }
  };
}

function newFtrlState(
  options: {
    modelId: string;
    featureSchemaId: string;
    hyperparameters?: Partial<FtrlHyperparameters>;
  },
  clock: Clock
): FtrlProximalRankerState {
  const timestamp = clock.now();
  return {
    schemaVersion: FTRL_SCHEMA,
    modelId: requireIdentity(options.modelId, "model"),
    featureSchemaId: requireIdentity(options.featureSchemaId, "feature schema"),
    hyperparameters: validateFtrlHyperparameters({
      alpha: options.hyperparameters?.alpha ?? 0.1,
      beta: options.hyperparameters?.beta ?? 1,
      l1: options.hyperparameters?.l1 ?? 0.1,
      l2: options.hyperparameters?.l2 ?? 1
    }),
    createdAt: timestamp,
    updatedAt: timestamp,
    examplesSeen: 0,
    coordinates: []
  };
}

function validateFtrlState(state: FtrlProximalRankerState): FtrlProximalRankerState {
  if (state.schemaVersion !== FTRL_SCHEMA) throw new Error(`unsupported FTRL schema ${String(state.schemaVersion)}`);
  requireIdentity(state.modelId, "model");
  requireIdentity(state.featureSchemaId, "feature schema");
  validateFtrlHyperparameters(state.hyperparameters);
  nonNegativeFinite(state.createdAt, "createdAt");
  nonNegativeFinite(state.updatedAt, "updatedAt");
  if (state.updatedAt < state.createdAt) throw new Error("updatedAt cannot precede createdAt");
  if (!Number.isSafeInteger(state.examplesSeen) || state.examplesSeen < 0) {
    throw new Error("examplesSeen must be a non-negative safe integer");
  }
  const ids = new Set<SparseFeatureId>();
  for (const coordinate of state.coordinates) {
    requireSparseFeatureId(coordinate.id);
    if (ids.has(coordinate.id)) throw new Error(`duplicate FTRL coordinate ${coordinate.id}`);
    ids.add(coordinate.id);
    finiteOrThrow(coordinate.z, `z for ${coordinate.id}`);
    nonNegativeFinite(coordinate.n, `n for ${coordinate.id}`);
  }
  return state;
}

function validateFtrlHyperparameters(parameters: FtrlHyperparameters): FtrlHyperparameters {
  if (!Number.isFinite(parameters.alpha) || parameters.alpha <= 0) throw new Error("FTRL alpha must be positive");
  if (!Number.isFinite(parameters.beta) || parameters.beta < 0) throw new Error("FTRL beta must be non-negative");
  if (!Number.isFinite(parameters.l1) || parameters.l1 < 0) throw new Error("FTRL l1 must be non-negative");
  if (!Number.isFinite(parameters.l2) || parameters.l2 < 0) throw new Error("FTRL l2 must be non-negative");
  return { ...parameters };
}

function validateBm25State(state: Bm25SparseIndexState): void {
  if (state.schemaVersion !== BM25_SCHEMA) throw new Error(`unsupported BM25 schema ${String(state.schemaVersion)}`);
  validateBm25Parameters(state.parameters);
  if (state.documentCount !== state.documents.length) throw new Error("BM25 document count does not match documents");
  nonNegativeFinite(state.averageDocumentLength, "averageDocumentLength");
  const documents = new Set<string>();
  const observedFrequencies = new Map<SparseFeatureId, number>();
  let totalDocumentLength = 0;
  for (const document of state.documents) {
    requireIdentity(document.id, "document");
    if (documents.has(document.id)) throw new Error(`duplicate BM25 document ${document.id}`);
    documents.add(document.id);
    nonNegativeFinite(document.length, `length for ${document.id}`);
    const features = createSparseVector(document.features);
    if (canonicalStringify(features.entries) !== canonicalStringify(document.features)) {
      throw new Error(`BM25 document ${document.id} features must be normalized and sorted`);
    }
    if (features.entries.some(feature => feature.value <= 0)) {
      throw new Error(`BM25 document ${document.id} contains non-positive features`);
    }
    const observedLength = features.entries.reduce((sum, feature) => sum + feature.value, 0);
    if (Math.abs(observedLength - document.length) > Number.EPSILON * Math.max(1, observedLength)) {
      throw new Error(`BM25 document ${document.id} length does not match features`);
    }
    totalDocumentLength += observedLength;
    for (const feature of features.entries) {
      observedFrequencies.set(feature.id, (observedFrequencies.get(feature.id) ?? 0) + 1);
    }
  }
  const declared = new Map<SparseFeatureId, number>();
  for (const frequency of state.documentFrequency) {
    requireSparseFeatureId(frequency.id);
    if (!Number.isSafeInteger(frequency.documents) || frequency.documents <= 0) {
      throw new Error(`invalid document frequency for ${frequency.id}`);
    }
    if (declared.has(frequency.id)) throw new Error(`duplicate document frequency ${frequency.id}`);
    declared.set(frequency.id, frequency.documents);
  }
  const expectedAverageLength = state.documentCount ? totalDocumentLength / state.documentCount : 0;
  if (Math.abs(expectedAverageLength - state.averageDocumentLength)
    > Number.EPSILON * Math.max(1, expectedAverageLength)) {
    throw new Error("BM25 average document length does not match documents");
  }
  const orderedDeclared = [...declared].sort(([left], [right]) => left.localeCompare(right));
  const orderedObserved = [...observedFrequencies].sort(([left], [right]) => left.localeCompare(right));
  if (canonicalStringify(orderedDeclared) !== canonicalStringify(orderedObserved)) {
    throw new Error("BM25 document frequencies do not match documents");
  }
}

function validateBm25Parameters(parameters: Bm25Parameters): Bm25Parameters {
  if (!Number.isFinite(parameters.k1) || parameters.k1 <= 0) throw new Error("BM25 k1 must be positive");
  if (!Number.isFinite(parameters.b) || parameters.b < 0 || parameters.b > 1) {
    throw new Error("BM25 b must be between zero and one");
  }
  return { ...parameters };
}

function assertSparseVector(vector: SparseVector): void {
  if (vector.schemaVersion !== SPARSE_VECTOR_SCHEMA) {
    throw new Error(`unsupported sparse vector schema ${String(vector.schemaVersion)}`);
  }
  const normalized = createSparseVector(vector.entries, {
    maxFeatures: Math.max(1, vector.entries.length)
  });
  if (canonicalStringify(normalized.entries) !== canonicalStringify(vector.entries)) {
    throw new Error("sparse vector entries must be normalized and sorted");
  }
}

function requireSparseFeatureId(value: string): asserts value is SparseFeatureId {
  if (!/^sf_[a-f0-9]{64}$/.test(value)) throw new Error(`invalid sparse feature ID ${value}`);
}

function requireIdentity(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${label} ID is required`);
  if (normalized.length > 256) throw new Error(`${label} ID exceeds 256 characters`);
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive safe integer`);
  return value;
}

function nonNegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be non-negative and finite`);
  return value;
}

function finiteOrThrow(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const z = Math.exp(-value);
    return 1 / (1 + z);
  }
  const z = Math.exp(value);
  return z / (1 + z);
}

function copyBm25State(state: Bm25SparseIndexState): Bm25SparseIndexState {
  return {
    schemaVersion: BM25_SCHEMA,
    parameters: { ...state.parameters },
    documentCount: state.documentCount,
    averageDocumentLength: state.averageDocumentLength,
    documentFrequency: state.documentFrequency.map(entry => ({ ...entry })),
    documents: state.documents.map(document => ({
      id: document.id,
      length: document.length,
      features: document.features.map(feature => ({ ...feature }))
    }))
  };
}

function copyFtrlState(state: FtrlProximalRankerState): FtrlProximalRankerState {
  return {
    schemaVersion: FTRL_SCHEMA,
    modelId: state.modelId,
    featureSchemaId: state.featureSchemaId,
    hyperparameters: { ...state.hyperparameters },
    createdAt: state.createdAt,
    updatedAt: state.updatedAt,
    examplesSeen: state.examplesSeen,
    coordinates: state.coordinates.map(coordinate => ({ ...coordinate }))
  };
}
