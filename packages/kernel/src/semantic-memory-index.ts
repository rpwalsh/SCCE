import type { EvidenceId, EvidenceSpan, GraphNode, Hasher, JsonValue, NodeId, SourceVersionId } from "./types.js";
import { clamp01, cosineSimilarity, createHasher, featureSet, stableVector, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";
import { CALIBRATION_IDS, CALIBRATION_TASK_CLASS_IDS, calibrateRuntimeScore, type CalibrationModelSet } from "./calibration-spine.js";
import { evidenceRetrievalSurface } from "./evidence-retrieval-surface.js";
import { compileCorpusIndex, type CorpusIndex } from "./retrieval.js";

export type RetrievalIndexKind = "lexical" | "vector" | "graph" | "temporal" | "source" | "hybrid";

export interface LexicalPosting {
  term: string;
  evidenceId: EvidenceId;
  sourceVersionId: SourceVersionId;
  tf: number;
  positions: number[];
  alpha: number;
}

export interface VectorPosting {
  id: string;
  evidenceId?: EvidenceId;
  nodeId?: NodeId;
  vector: number[];
  alpha: number;
  features: string[];
  payload: JsonValue;
}

export interface MemoryShardPlan {
  id: string;
  kind: RetrievalIndexKind;
  partitionKey: string;
  postgresTable: string;
  rowsEstimated: number;
  residentSafetyBoundBytes: number;
  scanRowExtent: number;
  indexes: string[];
}

export interface RetrievalCandidate {
  id: string;
  evidenceId?: EvidenceId;
  nodeId?: NodeId;
  sourceVersionId?: SourceVersionId;
  score: number;
  lexical: number;
  vector: number;
  graph: number;
  temporal: number;
  alpha: number;
  features: string[];
  explanation: string[];
  payload: JsonValue;
}

export interface RetrievalQuery {
  text: string;
  features?: string[];
  vector?: number[];
  sourceVersionIds?: SourceVersionId[];
  nodeIds?: NodeId[];
  evidenceIds?: EvidenceId[];
  since?: number;
  until?: number;
  limit?: number;
  alphaFloor?: number;
}

export interface SemanticMemoryRetrievalPlan {
  id: string;
  query: RetrievalQuery;
  terms: string[];
  shards: MemoryShardPlan[];
  postgres: {
    preparedStatements: Array<{ name: string; sql: string; params: string[]; maxRows: number }>;
    transaction: "read_committed";
    cursorRows: number;
  };
  residentMemoryBytes: number;
  audit: JsonValue;
}

export interface HybridRetrievalResult {
  plan: SemanticMemoryRetrievalPlan;
  candidates: RetrievalCandidate[];
  selectedEvidenceIds: EvidenceId[];
  selectedNodeIds: NodeId[];
  diagnostics: JsonValue;
}

export interface InMemoryIndexSlice {
  schema: "scce.compiled_memory_slice.v1";
  postings: LexicalPosting[];
  postingsByTerm: ReadonlyMap<string, readonly LexicalPosting[]>;
  documentFrequency: ReadonlyMap<string, number>;
  vectors: VectorPosting[];
  vectorsById: ReadonlyMap<string, VectorPosting>;
  vectorIdsByFeature: ReadonlyMap<string, readonly string[]>;
  nodes: GraphNode[];
  nodesByVectorId: ReadonlyMap<string, GraphNode>;
  evidence: EvidenceSpan[];
  evidenceById: ReadonlyMap<string, EvidenceSpan>;
  topAlphaVectorIds: readonly string[];
  corpusIndex: CorpusIndex;
  fingerprint: string;
}

export function createSemanticMemoryIndex(options: { hasher?: Hasher; dimensions?: number; residentSafetyBoundBytes?: number } = {}) {
  const hasher = options.hasher ?? createHasher();
  const dimensions = Math.max(16, Math.min(512, Math.floor(options.dimensions ?? 64)));
  const residentSafetyBoundBytes = Math.max(4 * 1024 * 1024, options.residentSafetyBoundBytes ?? 96 * 1024 * 1024);
  const compiledSliceCache = new Map<string, InMemoryIndexSlice>();
  return {
    buildSlice(input: { evidence: EvidenceSpan[]; nodes?: GraphNode[] }): InMemoryIndexSlice {
      const fingerprint = sliceFingerprint(input, hasher);
      const cached = compiledSliceCache.get(fingerprint);
      if (cached) {
        compiledSliceCache.delete(fingerprint);
        compiledSliceCache.set(fingerprint, cached);
        return cached;
      }
      const postings = input.evidence.flatMap(span => postingsForEvidence(span));
      const postingsByTerm = groupBy(postings, posting => posting.term);
      for (const termPostings of postingsByTerm.values()) {
        termPostings.sort((left, right) =>
          right.alpha - left.alpha
          || String(left.evidenceId).localeCompare(String(right.evidenceId))
        );
      }
      const documentFrequency = new Map(
        [...postingsByTerm.entries()].map(([term, termPostings]) => [
          term,
          new Set(termPostings.map(posting => String(posting.evidenceId))).size
        ])
      );
      const vectors = [
        ...input.evidence.map(span => vectorForEvidence(span, hasher, dimensions)),
        ...(input.nodes ?? []).map(node => vectorForNode(node, hasher, dimensions))
      ];
      const vectorsById = new Map(vectors.map(vector => [vector.id, vector]));
      const vectorIdsByFeature = new Map<string, string[]>();
      for (const vector of vectors) {
        for (const feature of new Set(vector.features.slice(0, 1_024))) {
          const bucket = vectorIdsByFeature.get(feature) ?? [];
          bucket.push(vector.id);
          vectorIdsByFeature.set(feature, bucket);
        }
      }
      for (const ids of vectorIdsByFeature.values()) {
        ids.sort((left, right) =>
          (vectorsById.get(right)?.alpha ?? 0) - (vectorsById.get(left)?.alpha ?? 0)
          || left.localeCompare(right)
        );
      }
      const nodes = input.nodes ?? [];
      const slice: InMemoryIndexSlice = {
        schema: "scce.compiled_memory_slice.v1",
        postings,
        postingsByTerm,
        documentFrequency,
        vectors,
        vectorsById,
        vectorIdsByFeature,
        nodes,
        nodesByVectorId: new Map(nodes.map(node => [`vector:node:${String(node.id)}`, node])),
        evidence: input.evidence,
        evidenceById: new Map(input.evidence.map(span => [String(span.id), span])),
        topAlphaVectorIds: [...vectors]
          .sort((left, right) => right.alpha - left.alpha || left.id.localeCompare(right.id))
          .slice(0, 256)
          .map(vector => vector.id),
        corpusIndex: compileCorpusIndex(input.evidence, hasher),
        fingerprint
      };
      compiledSliceCache.set(fingerprint, slice);
      while (compiledSliceCache.size > 32) {
        const oldest = compiledSliceCache.keys().next().value;
        if (typeof oldest !== "string") break;
        compiledSliceCache.delete(oldest);
      }
      return slice;
    },

    plan(input: { query: RetrievalQuery; corpusRows?: { evidenceRows: number; nodeRows: number; edgeRows: number }; now?: number }): SemanticMemoryRetrievalPlan {
      const terms = [...new Set(symbolizeData(input.query.text).filter(term => term.length > 0))].slice(0, 128);
      const corpusRows = input.corpusRows ?? { evidenceRows: 1_000_000, nodeRows: 1_800_000, edgeRows: 9_000_000 };
      const shards = shardPlan({ terms, query: input.query, corpusRows, residentSafetyBoundBytes });
      const preparedStatements = preparedStatementsFor(input.query, terms, shards);
      const residentMemoryBytes = Math.min(residentSafetyBoundBytes, shards.reduce((sum, shard) => sum + shard.residentSafetyBoundBytes, 0));
      return {
        id: `retrieval_plan_${hasher.digestHex(JSON.stringify({ terms, query: input.query, shards: shards.map(s => s.id) })).slice(0, 32)}`,
        query: input.query,
        terms,
        shards,
        postgres: { preparedStatements, transaction: "read_committed", cursorRows: Math.max(500, Math.min(5000, Math.floor(residentMemoryBytes / 32768))) },
        residentMemoryBytes,
        audit: toJsonValue({ terms, corpusRows, residentSafetyBoundBytes, preparedStatements: preparedStatements.map(stmt => ({ name: stmt.name, maxRows: stmt.maxRows })) })
      };
    },

    search(input: { query: RetrievalQuery; slice: InMemoryIndexSlice; corpusRows?: { evidenceRows: number; nodeRows: number; edgeRows: number }; calibrationModels?: CalibrationModelSet; calibrationTaskClass?: string }): HybridRetrievalResult {
      const plan = this.plan({ query: input.query, corpusRows: input.corpusRows });
      const queryFeatures = input.query.features ?? featureSet(input.query.text, 1024);
      const queryVector = input.query.vector ?? stableVector(queryFeatures, hasher, dimensions);
      const limit = Math.max(1, Math.min(200, input.query.limit ?? 24));
      const candidateIds = memoryCandidateIds({
        query: input.query,
        terms: plan.terms,
        queryFeatures,
        slice: input.slice,
        maximum: Math.max(128, Math.min(1_024, limit * 12))
      });
      const lexicalScores = lexicalSearch(plan.terms, input.slice, candidateIds);
      const vectorScores = vectorSearch(queryVector, input.slice, candidateIds);
      const graphScores = graphPrior(input.query, input.slice, candidateIds);
      const candidates = mergeCandidates({
        lexicalScores,
        vectorScores,
        graphScores,
        candidateIds,
        slice: input.slice,
        query: input.query,
        queryFeatures,
        limit,
        calibrationModels: input.calibrationModels,
        calibrationTaskClass: input.calibrationTaskClass
      });
      const selected = candidates.slice(0, limit);
      return {
        plan,
        candidates: selected,
        selectedEvidenceIds: [...new Set(selected.map(candidate => candidate.evidenceId).filter((id): id is EvidenceId => Boolean(id)))],
        selectedNodeIds: [...new Set(selected.map(candidate => candidate.nodeId).filter((id): id is NodeId => Boolean(id)))],
        diagnostics: toJsonValue({
          sliceSchema: input.slice.schema,
          sliceFingerprint: input.slice.fingerprint,
          indexedVectors: input.slice.vectors.length,
          candidateVectors: candidateIds.size,
          boundedCandidateRatio: input.slice.vectors.length
            ? candidateIds.size / input.slice.vectors.length
            : 0,
          candidateCount: candidates.length,
          selectedCount: selected.length,
          top: selected.slice(0, 8).map(candidate => ({ id: candidate.id, score: candidate.score, explanation: candidate.explanation }))
        })
      };
    }
  };
}

function postingsForEvidence(span: EvidenceSpan): LexicalPosting[] {
  const symbols = symbolizeData(evidenceRetrievalSurface(span));
  const positions = new Map<string, number[]>();
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]!;
    const bucket = positions.get(symbol) ?? [];
    bucket.push(i);
    positions.set(symbol, bucket);
  }
  return [...positions.entries()].map(([term, pos]) => ({
    term,
    evidenceId: span.id,
    sourceVersionId: span.sourceVersionId,
    tf: pos.length / Math.max(1, symbols.length),
    positions: pos.slice(0, 128),
    alpha: span.alpha
  }));
}

function vectorForEvidence(span: EvidenceSpan, hasher: Hasher, dimensions: number): VectorPosting {
  const features = span.features.length ? span.features : featureSet(evidenceRetrievalSurface(span), 1024);
  return {
    id: `vector:evidence:${String(span.id)}`,
    evidenceId: span.id,
    vector: stableVector(features, hasher, dimensions),
    alpha: span.alpha,
    features,
    payload: toJsonValue({ sourceVersionId: span.sourceVersionId, preview: span.textPreview, status: span.status })
  };
}

function vectorForNode(node: GraphNode, hasher: Hasher, dimensions: number): VectorPosting {
  const features = node.features.length ? node.features : featureSet(JSON.stringify(node.representation), 1024);
  return {
    id: `vector:node:${String(node.id)}`,
    nodeId: node.id,
    vector: stableVector(features, hasher, dimensions),
    alpha: node.alpha,
    features,
    payload: toJsonValue({ typeId: node.typeId, evidenceIds: node.evidenceIds, metadata: node.metadata })
  };
}

function shardPlan(input: { terms: string[]; query: RetrievalQuery; corpusRows: { evidenceRows: number; nodeRows: number; edgeRows: number }; residentSafetyBoundBytes: number }): MemoryShardPlan[] {
  const termPartitions = Math.max(1, Math.min(64, Math.ceil(Math.sqrt(input.corpusRows.evidenceRows / 500000))));
  const vectorPartitions = Math.max(1, Math.min(128, Math.ceil(input.corpusRows.nodeRows / 250000)));
  const graphPartitions = Math.max(1, Math.min(128, Math.ceil(input.corpusRows.edgeRows / 1000000)));
  const lexicalRows = Math.min(input.corpusRows.evidenceRows, Math.max(1000, input.terms.length * 4000));
  const vectorRows = Math.min(input.corpusRows.nodeRows + input.corpusRows.evidenceRows, 50000);
  const graphRows = Math.min(input.corpusRows.edgeRows, input.query.nodeIds?.length ? input.query.nodeIds.length * 800 : 10000);
  return [
    {
      id: `shard:lexical:${termPartitions}`,
      kind: "lexical",
      partitionKey: "term_hash",
      postgresTable: "evidence_spans",
      rowsEstimated: lexicalRows,
      residentSafetyBoundBytes: Math.floor(input.residentSafetyBoundBytes * 0.28),
      scanRowExtent: lexicalRows,
      indexes: ["evidence_features_idx", "evidence_source_span_idx"]
    },
    {
      id: `shard:vector:${vectorPartitions}`,
      kind: "vector",
      partitionKey: "embedding_hnsw",
      postgresTable: "graph_nodes",
      rowsEstimated: vectorRows,
      residentSafetyBoundBytes: Math.floor(input.residentSafetyBoundBytes * 0.32),
      scanRowExtent: vectorRows,
      indexes: ["graph_nodes_embedding_hnsw_idx"]
    },
    {
      id: `shard:graph:${graphPartitions}`,
      kind: "graph",
      partitionKey: "source_node_hash",
      postgresTable: "graph_edges",
      rowsEstimated: graphRows,
      residentSafetyBoundBytes: Math.floor(input.residentSafetyBoundBytes * 0.22),
      scanRowExtent: graphRows,
      indexes: ["graph_edges_source_idx", "graph_edges_target_idx", "graph_edges_alpha_idx"]
    },
    {
      id: "shard:temporal",
      kind: "temporal",
      partitionKey: "observed_at",
      postgresTable: "source_versions",
      rowsEstimated: Math.max(1000, Math.ceil(input.corpusRows.evidenceRows * 0.02)),
      residentSafetyBoundBytes: Math.floor(input.residentSafetyBoundBytes * 0.1),
      scanRowExtent: 10000,
      indexes: ["source_versions_source_idx"]
    },
    {
      id: "shard:hybrid-rerank",
      kind: "hybrid",
      partitionKey: "candidate_id",
      postgresTable: "semantic_proofs",
      rowsEstimated: 512,
      residentSafetyBoundBytes: Math.floor(input.residentSafetyBoundBytes * 0.08),
      scanRowExtent: 512,
      indexes: ["semantic_proofs_claim_idx"]
    }
  ];
}

function preparedStatementsFor(query: RetrievalQuery, terms: string[], shards: MemoryShardPlan[]): SemanticMemoryRetrievalPlan["postgres"]["preparedStatements"] {
  const hasSourceFilter = Boolean(query.sourceVersionIds?.length);
  const hasTemporal = query.since !== undefined || query.until !== undefined;
  return shards.map(shard => {
    if (shard.kind === "lexical") {
      return {
        name: "retrieve_lexical_candidates",
        sql: `SELECT id, source_version_id, text_preview, features, alpha FROM evidence_spans WHERE features ?| $1${hasSourceFilter ? " AND source_version_id = ANY($2)" : ""}${hasTemporal ? " AND observed_at BETWEEN $3 AND $4" : ""} ORDER BY alpha DESC LIMIT ${shard.scanRowExtent}`,
        params: ["terms", ...(hasSourceFilter ? ["sourceVersionIds"] : []), ...(hasTemporal ? ["since", "until"] : [])],
        maxRows: shard.scanRowExtent
      };
    }
    if (shard.kind === "vector") {
      return {
        name: "retrieve_vector_candidates",
        sql: `SELECT id, representation, evidence_ids, features, alpha, embedding FROM graph_nodes WHERE embedding IS NOT NULL ORDER BY embedding <=> $1 LIMIT ${shard.scanRowExtent}`,
        params: ["queryVector"],
        maxRows: shard.scanRowExtent
      };
    }
    if (shard.kind === "graph") {
      return {
        name: "retrieve_graph_neighborhood",
        sql: `SELECT id, source, target, relation_id, alpha, weight, evidence_ids FROM graph_edges WHERE source = ANY($1) OR target = ANY($1) ORDER BY alpha DESC, weight DESC LIMIT ${shard.scanRowExtent}`,
        params: ["nodeIds"],
        maxRows: shard.scanRowExtent
      };
    }
    if (shard.kind === "temporal") {
      return {
        name: "retrieve_temporal_sources",
        sql: `SELECT source_version_id, canonical_uri, observed_at, trust, metadata FROM source_versions ORDER BY observed_at DESC LIMIT ${shard.scanRowExtent}`,
        params: [],
        maxRows: shard.scanRowExtent
      };
    }
    return {
      name: "retrieve_recent_proofs",
      sql: `SELECT id, claim_id, verdict, confidence, evidence_ids FROM semantic_proofs ORDER BY created_at DESC LIMIT ${shard.scanRowExtent}`,
      params: [],
      maxRows: shard.scanRowExtent
    };
  });
}

function lexicalSearch(
  terms: readonly string[],
  slice: InMemoryIndexSlice,
  candidateIds: ReadonlySet<string>
): Map<string, number> {
  const scores = new Map<string, number>();
  const totalDocs = Math.max(1, slice.evidence.length);
  for (const term of terms) {
    const df = slice.documentFrequency.get(term) ?? 1;
    const idf = Math.log(1 + (totalDocs - df + 0.5) / (df + 0.5));
    for (const posting of slice.postingsByTerm.get(term) ?? []) {
      const key = String(posting.evidenceId);
      if (!candidateIds.has(key) && !candidateIds.has(`vector:evidence:${key}`)) continue;
      const indexed = slice.corpusIndex.documentsById.get(key);
      const lengthNorm = indexed ? 1 / Math.sqrt(Math.max(1, indexed.length)) : 1;
      const score = posting.tf * idf * (0.6 + 0.4 * posting.alpha) * (1 + lengthNorm);
      scores.set(key, (scores.get(key) ?? 0) + score);
    }
  }
  return normalizeScoreMap(scores);
}

function vectorSearch(
  queryVector: readonly number[],
  slice: InMemoryIndexSlice,
  candidateIds: ReadonlySet<string>
): Map<string, number> {
  const scores = new Map<string, number>();
  for (const id of candidateIds) {
    const posting = slice.vectorsById.get(normalizeVectorId(id, slice));
    if (!posting) continue;
    const score = clamp01((cosineSimilarity(queryVector, posting.vector) + 1) / 2) * (0.55 + 0.45 * posting.alpha);
    scores.set(posting.id, score);
  }
  return normalizeScoreMap(scores);
}

function graphPrior(
  query: RetrievalQuery,
  slice: InMemoryIndexSlice,
  candidateIds: ReadonlySet<string>
): Map<string, number> {
  const scores = new Map<string, number>();
  const queryNodeIds = new Set((query.nodeIds ?? []).map(String));
  const queryEvidenceIds = new Set((query.evidenceIds ?? []).map(String));
  for (const id of candidateIds) {
    const node = slice.nodesByVectorId.get(id);
    if (!node) continue;
    const direct = queryNodeIds.has(String(node.id)) ? 1 : 0;
    const evidence = node.evidenceIds.some(id => queryEvidenceIds.has(String(id))) ? 0.8 : 0;
    const feature = query.features ? weightedJaccard(query.features, node.features) : 0;
    scores.set(`vector:node:${String(node.id)}`, clamp01(0.45 * direct + 0.28 * evidence + 0.22 * feature + 0.05 * node.alpha));
  }
  return normalizeScoreMap(scores);
}

function mergeCandidates(input: {
  lexicalScores: Map<string, number>;
  vectorScores: Map<string, number>;
  graphScores: Map<string, number>;
  candidateIds: ReadonlySet<string>;
  slice: InMemoryIndexSlice;
  query: RetrievalQuery;
  queryFeatures: string[];
  limit: number;
  calibrationModels?: CalibrationModelSet;
  calibrationTaskClass?: string;
}): RetrievalCandidate[] {
  const keys = new Set<string>([
    ...input.candidateIds,
    ...input.lexicalScores.keys(),
    ...input.vectorScores.keys(),
    ...input.graphScores.keys()
  ]);
  const alphaFloor = input.query.alphaFloor ?? 0;
  const candidates: RetrievalCandidate[] = [];
  for (const key of keys) {
    const lexical = input.lexicalScores.get(key) ?? 0;
    const vectorId = normalizeVectorId(key, input.slice);
    const vector = input.vectorScores.get(vectorId) ?? 0;
    const graph = input.graphScores.get(key) ?? 0;
    const evidenceId = key.startsWith("vector:evidence:") ? key.slice("vector:evidence:".length) : key;
    const evidence = input.slice.evidenceById.get(evidenceId);
    const node = input.slice.nodesByVectorId.get(vectorId);
    if (!evidence && !node) continue;
    const alpha = evidence?.alpha ?? node?.alpha ?? Math.max(lexical, vector, graph);
    if (alpha < alphaFloor) continue;
    const temporal = temporalFit(input.query, evidence);
    const featureFit = evidence ? weightedJaccard(input.queryFeatures, evidence.features) : node ? weightedJaccard(input.queryFeatures, node.features) : 0;
    const rawScore = clamp01(0.32 * lexical + 0.29 * vector + 0.2 * graph + 0.1 * temporal + 0.09 * alpha + 0.08 * featureFit);
    const calibrated = calibrateRuntimeScore({
      raw: rawScore,
      calibrationId: CALIBRATION_IDS.retrievalHybridRecall,
      taskClass: input.calibrationTaskClass ?? CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      modelSet: input.calibrationModels,
      inputs: ["semantic-memory-index", key]
    });
    const score = calibrated.value;
    insertRetrievalCandidate(candidates, {
      id: evidence ? String(evidence.id) : vectorId,
      evidenceId: evidence?.id,
      nodeId: node?.id,
      sourceVersionId: evidence?.sourceVersionId,
      score,
      lexical,
      vector,
      graph,
      temporal,
      alpha,
      features: evidence?.features ?? node?.features ?? [],
      explanation: [
        ...explanationFor({ lexical, vector, graph, temporal, alpha, featureFit }),
        `raw ${rawScore.toFixed(3)}`,
        ...(calibrated.calibrated ? [`calibrated ${score.toFixed(3)}`] : [])
      ],
      payload: evidence ? toJsonValue({ preview: evidence.textPreview, status: evidence.status, sourceVersionId: evidence.sourceVersionId }) : node ? toJsonValue({ representation: node.representation, metadata: node.metadata }) : {}
    }, input.limit);
  }
  return candidates;
}

function memoryCandidateIds(input: {
  query: RetrievalQuery;
  terms: readonly string[];
  queryFeatures: readonly string[];
  slice: InMemoryIndexSlice;
  maximum: number;
}): Set<string> {
  const candidates = new Set<string>();
  const add = (id: string) => {
    const canonical = id.startsWith("vector:evidence:")
      ? id.slice("vector:evidence:".length)
      : id;
    if (candidates.size < input.maximum) candidates.add(canonical);
  };
  for (const evidenceId of input.query.evidenceIds ?? []) add(String(evidenceId));
  for (const nodeId of input.query.nodeIds ?? []) add(`vector:node:${String(nodeId)}`);
  for (const term of input.terms) {
    for (const posting of input.slice.postingsByTerm.get(term) ?? []) {
      add(String(posting.evidenceId));
      if (candidates.size >= input.maximum) return candidates;
    }
  }
  for (const feature of input.queryFeatures) {
    for (const id of input.slice.vectorIdsByFeature.get(feature) ?? []) {
      add(id);
      if (candidates.size >= input.maximum) return candidates;
    }
  }
  const floor = Math.min(input.maximum, 64);
  for (const id of input.slice.topAlphaVectorIds) {
    if (candidates.size >= floor) break;
    add(id);
  }
  return candidates;
}

function normalizeVectorId(id: string, slice: InMemoryIndexSlice): string {
  if (slice.vectorsById.has(id)) return id;
  const evidenceVectorId = `vector:evidence:${id}`;
  return slice.vectorsById.has(evidenceVectorId) ? evidenceVectorId : id;
}

function insertRetrievalCandidate(
  candidates: RetrievalCandidate[],
  candidate: RetrievalCandidate,
  limit: number
): void {
  let low = 0;
  let high = candidates.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const current = candidates[middle]!;
    if (candidate.score > current.score
      || (candidate.score === current.score && (
        candidate.alpha > current.alpha
        || (candidate.alpha === current.alpha && candidate.id.localeCompare(current.id) < 0)
      ))) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  candidates.splice(low, 0, candidate);
  if (candidates.length > limit) candidates.pop();
}

function sliceFingerprint(
  input: { evidence: readonly EvidenceSpan[]; nodes?: readonly GraphNode[] },
  hasher: Hasher
): string {
  return hasher.digestHex(JSON.stringify({
    evidence: input.evidence.map(span => [
      String(span.id),
      String(span.sourceVersionId),
      String(span.contentHash),
      span.status,
      span.alpha
    ]),
    nodes: (input.nodes ?? []).map(node => [
      String(node.id),
      node.typeId,
      node.alpha,
      node.updatedAt
    ])
  }));
}

function groupBy<T>(
  values: readonly T[],
  keyFor: (value: T) => string
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyFor(value);
    const bucket = grouped.get(key) ?? [];
    bucket.push(value);
    grouped.set(key, bucket);
  }
  return grouped;
}

function temporalFit(query: RetrievalQuery, evidence: EvidenceSpan | undefined): number {
  if (!evidence || (query.since === undefined && query.until === undefined)) return 0.5;
  const since = query.since ?? Number.NEGATIVE_INFINITY;
  const until = query.until ?? Number.POSITIVE_INFINITY;
  return evidence.observedAt >= since && evidence.observedAt <= until ? 1 : 0;
}

function explanationFor(input: { lexical: number; vector: number; graph: number; temporal: number; alpha: number; featureFit: number }): string[] {
  const parts: string[] = [];
  if (input.lexical > 0.1) parts.push(`lexical ${input.lexical.toFixed(3)}`);
  if (input.vector > 0.1) parts.push(`vector ${input.vector.toFixed(3)}`);
  if (input.graph > 0.1) parts.push(`graph ${input.graph.toFixed(3)}`);
  if (input.temporal > 0.8) parts.push("temporal fit");
  if (input.alpha > 0.1) parts.push(`alpha ${input.alpha.toFixed(3)}`);
  if (input.featureFit > 0.1) parts.push(`feature fit ${input.featureFit.toFixed(3)}`);
  return parts.length ? parts : ["low confidence residual candidate"];
}

function normalizeScoreMap(scores: Map<string, number>): Map<string, number> {
  const max = Math.max(0, ...scores.values());
  if (max <= 0) return scores;
  return new Map([...scores.entries()].map(([key, value]) => [key, clamp01(value / max)]));
}
