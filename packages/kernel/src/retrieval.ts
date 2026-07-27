import type { EvidenceSpan, GraphSlice, Hasher, JsonValue, RetrievalRole } from "./types.js";
import { clamp01, featureSet, mean, stableVector, symbolizeData, toJsonValue } from "./primitives.js";
import { featureScore, provisionalHeuristicScore, type ScoreTrace } from "./scoring/score-trace.js";
import { PROOF_GRAPH_KIND, SEMANTIC_VERDICT } from "./semantic-codes.js";
import { CALIBRATION_IDS, CALIBRATION_TASK_CLASS_IDS, calibrateRuntimeScore, type CalibrationModelSet } from "./calibration-spine.js";
import { evidenceRetrievalSurface } from "./evidence-retrieval-surface.js";

export interface CorpusIndex {
  schema: "scce.compiled_corpus_index.v1";
  documents: IndexedDocument[];
  documentsById: ReadonlyMap<string, IndexedDocument>;
  invertedIndex: ReadonlyMap<string, readonly string[]>;
  docFreq: Record<string, number>;
  avgLength: number;
  totalDocuments: number;
  topAlphaDocumentIds: string[];
  fingerprint: string;
}

export interface IndexedDocument {
  id: string;
  evidenceId: string;
  contentHash: string;
  sourceVersionId: string;
  length: number;
  symbols: string[];
  termFrequency: ReadonlyMap<string, number>;
  features: string[];
  vector: number[];
  alpha: number;
  status: string;
  preview: string;
  mediaType: string;
  languageHints: JsonValue;
  scriptHints: JsonValue;
  trustVector: JsonValue;
  provenance: JsonValue;
}

export interface HybridRecallResult {
  evidenceId: string;
  score: number;
  bm25: number;
  vector: number;
  graph: number;
  alpha: number;
  evidenceRole: RetrievalRole;
  reason: string;
  scoreTrace: ScoreTrace[];
}

export interface RetrievalPlan {
  query: string;
  queryFeatures: string[];
  recall: HybridRecallResult[];
  expansionFeatures: string[];
  graphSeeds: string[];
  audit: JsonValue;
}

const CORPUS_INDEX_CACHE_LIMIT = 32;
const corpusIndexCache = new Map<string, CorpusIndex>();

/**
 * Compiles a full corpus index (inverted index, doc frequencies, top-alpha
 * fallback ids, content fingerprint) from a set of evidence spans.
 * cachedCorpusIndex below caches the whole compiled result keyed by the
 * evidence set's own identity/status/alpha, so repeated hybridRecall()
 * calls against a recurring evidence pool (the common case across turns
 * in one conversation) never recompile it (Phase L finding).
 */
export function compileCorpusIndex(evidence: readonly EvidenceSpan[], hasher: Hasher): CorpusIndex {
  const documents = evidence.map(span => {
    const symbols = symbolizeData(evidenceRetrievalSurface(span));
    const termFrequency = new Map<string, number>();
    for (const symbol of symbols) termFrequency.set(symbol, (termFrequency.get(symbol) ?? 0) + 1);
    const features = span.features.slice(0, 256);
    return {
      id: String(span.id),
      evidenceId: String(span.id),
      contentHash: String(span.contentHash),
      sourceVersionId: String(span.sourceVersionId),
      length: symbols.length,
      symbols,
      termFrequency,
      features,
      vector: stableVector(features, hasher, 96),
      alpha: span.alpha,
      status: span.status,
      preview: span.textPreview,
      mediaType: span.mediaType,
      languageHints: span.languageHints,
      scriptHints: span.scriptHints,
      trustVector: span.trustVector,
      provenance: span.provenance
    };
  });
  const docFreq = new Map<string, number>();
  const inverted = new Map<string, string[]>();
  for (const doc of documents) {
    for (const symbol of doc.termFrequency.keys()) {
      docFreq.set(symbol, (docFreq.get(symbol) ?? 0) + 1);
      const bucket = inverted.get(symbol) ?? [];
      bucket.push(doc.evidenceId);
      inverted.set(symbol, bucket);
    }
  }
  const documentsById = new Map(documents.map(document => [document.evidenceId, document]));
  for (const bucket of inverted.values()) {
    bucket.sort((left, right) => {
      const leftAlpha = documentsById.get(left)?.alpha ?? 0;
      const rightAlpha = documentsById.get(right)?.alpha ?? 0;
      return rightAlpha - leftAlpha || left.localeCompare(right);
    });
  }
  const topAlphaDocumentIds = [...documents]
    .sort((left, right) => right.alpha - left.alpha || left.evidenceId.localeCompare(right.evidenceId))
    .slice(0, 256)
    .map(document => document.evidenceId);
  const fingerprint = hasher.digestHex(JSON.stringify(
    documents.map(document => [
      document.evidenceId,
      document.sourceVersionId,
      document.contentHash,
      document.status,
      document.alpha
    ])
  ));
  return {
    schema: "scce.compiled_corpus_index.v1",
    documents,
    documentsById,
    invertedIndex: inverted,
    docFreq: Object.fromEntries(docFreq),
    avgLength: mean(documents.map(doc => doc.length)),
    totalDocuments: documents.length,
    topAlphaDocumentIds,
    fingerprint
  };
}

export function hybridRecall(input: { query: string; evidence?: readonly EvidenceSpan[]; index?: CorpusIndex; graph?: GraphSlice; hasher: Hasher; limit?: number; calibrationModels?: CalibrationModelSet; calibrationTaskClass?: string }): RetrievalPlan {
  const compiled = input.index
    ? { index: input.index, cacheHit: false, precompiled: true }
    : cachedCorpusIndex(input.evidence ?? [], input.hasher);
  const index = compiled.index;
  const querySymbols = symbolizeData(input.query);
  const queryFeatures = featureSet(input.query, 512);
  const graphSignals = graphEvidenceSignals(input.graph);
  const queryVector = stableVector(queryFeatures, input.hasher, 96);
  const limit = Math.max(1, Math.min(200, input.limit ?? 80));
  const candidateIds = recallCandidateIds({
    index,
    querySymbols,
    graphSignals,
    maximum: Math.max(128, Math.min(1_024, limit * 8))
  });
  const recall: HybridRecallResult[] = [];
  for (const evidenceId of candidateIds) {
    const doc = index.documentsById.get(evidenceId);
    if (!doc) continue;
    const bm25Score = bm25(querySymbols, doc, index);
    const vectorScore = cosine(queryVector, doc.vector);
    const graphSignal = graphSignals.get(doc.evidenceId);
    const graphScore = graphSignal?.mass ?? 0;
    const alphaScore = doc.alpha * (doc.status === "promoted" ? 1 : 0.45);
    const evidenceRole = classifyEvidenceRole({ bm25Score, vectorScore, graphScore, alphaScore, doc, graphSignal });
    const rawScore = clamp01(0.38 * bm25Score + 0.24 * vectorScore + 0.22 * graphScore + 0.16 * alphaScore);
    const calibrated = calibrateRuntimeScore({
      raw: rawScore,
      calibrationId: CALIBRATION_IDS.retrievalHybridRecall,
      taskClass: input.calibrationTaskClass ?? CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      modelSet: input.calibrationModels,
      meaning: "calibrated hybrid recall score",
      provenance: ["retrieval.ts:hybridRecall"],
      inputs: ["bm25", "vector", "graph", "alpha", doc.evidenceId]
    });
    const score = calibrated.value;
    const scoreTrace: ScoreTrace[] = [
      featureScore({
        value: bm25Score,
        range: [0, 1],
        meaning: "bm25 lexical feature",
        inputs: ["bm25"],
        provenance: ["retrieval.ts:hybridRecall"]
      }),
      featureScore({
        value: vectorScore,
        range: [0, 1],
        meaning: "vector similarity feature",
        inputs: ["cosine"],
        provenance: ["retrieval.ts:hybridRecall"]
      }),
      featureScore({
        value: graphScore,
        range: [0, 1],
        meaning: "graph mass feature",
        inputs: ["graphEvidenceMass"],
        provenance: ["retrieval.ts:hybridRecall"]
      }),
      provisionalHeuristicScore({
        value: rawScore,
        range: [0, 1],
        meaning: "hybrid recall blend",
        inputs: ["bm25", "vector", "graph", "alpha"],
        provenance: ["retrieval.ts:hybridRecall"],
        failureModes: ["domain_shift", "embedding_mismatch", "graph_sparsity"]
      }),
      ...(calibrated.scoreTrace ? [calibrated.scoreTrace] : []),
      featureScore({
        value: roleConfidence(evidenceRole),
        range: [0, 1],
        meaning: "retrieval evidence role confidence",
        inputs: ["bm25", "vector", "graph", "alpha", "evidence-metadata"],
        provenance: ["retrieval.ts:classifyEvidenceRole"]
      })
    ];
    insertRecall(recall, {
      evidenceId: doc.evidenceId,
      score,
      bm25: bm25Score,
      vector: vectorScore,
      graph: graphScore,
      alpha: alphaScore,
      evidenceRole,
      reason: `bm25=${bm25Score.toFixed(3)} vector=${vectorScore.toFixed(3)} graph=${graphScore.toFixed(3)} alpha=${alphaScore.toFixed(3)} raw=${rawScore.toFixed(3)} calibrated=${calibrated.calibrated ? score.toFixed(3) : "none"} role=${evidenceRole}`,
      scoreTrace
    }, limit);
  }
  const expansionFeatures = expandFeatures(queryFeatures, recall, index);
  const graphSeeds = recall.filter(item => item.graph > 0 || item.alpha > 0.4).slice(0, 32).map(item => item.evidenceId);
  return {
    query: input.query,
    queryFeatures,
    recall,
    expansionFeatures,
    graphSeeds,
    audit: toJsonValue({
      indexSchema: index.schema,
      indexFingerprint: index.fingerprint,
      indexCacheHit: compiled.cacheHit,
      precompiledIndex: compiled.precompiled ?? false,
      indexedDocuments: index.totalDocuments,
      candidateDocuments: candidateIds.length,
      boundedCandidateRatio: index.totalDocuments
        ? candidateIds.length / index.totalDocuments
        : 0,
      recall: recall.slice(0, 20),
      expansionFeatures: expansionFeatures.slice(0, 64),
      graphSeeds
    })
  };
}

function queryExpansionFromKneserNey(input: { query: string; profile: JsonValue; limit?: number }): string[] {
  const kn = (input.profile as { kneserNey?: { topContinuation?: Array<[string, number]>; summary?: { topContinuations?: Array<{ symbol: string }> } } }).kneserNey;
  const base = new Set(symbolizeData(input.query));
  const continuation = [
    ...(kn?.summary?.topContinuations?.map(item => item.symbol) ?? []),
    ...(kn?.topContinuation?.map(item => item[0]) ?? [])
  ];
  return continuation.filter(symbol => !base.has(symbol) && symbol !== "<unk>" && symbol !== "</s>").slice(0, input.limit ?? 24);
}

function bm25(querySymbols: readonly string[], doc: IndexedDocument, index: CorpusIndex): number {
  const k1 = 1.2;
  const b = 0.75;
  let score = 0;
  for (const symbol of querySymbols) {
    const f = doc.termFrequency.get(symbol) ?? 0;
    if (!f) continue;
    const df = index.docFreq[symbol] ?? 0;
    const idf = Math.log(1 + (index.totalDocuments - df + 0.5) / (df + 0.5));
    const denom = f + k1 * (1 - b + b * doc.length / Math.max(1, index.avgLength));
    score += idf * ((f * (k1 + 1)) / denom);
  }
  return clamp01(score / Math.max(1, querySymbols.length));
}

interface GraphEvidenceSignal {
  mass: number;
  roles: Set<RetrievalRole>;
  relationIds: Set<string>;
}

function graphEvidenceSignals(graph: GraphSlice | undefined): Map<string, GraphEvidenceSignal> {
  const out = new Map<string, GraphEvidenceSignal>();
  if (!graph) return out;
  const add = (evidenceId: string, mass: number, roles: readonly RetrievalRole[], relationId?: string) => {
    const current = out.get(evidenceId) ?? { mass: 0, roles: new Set<RetrievalRole>(), relationIds: new Set<string>() };
    current.mass = Math.max(current.mass, mass);
    for (const role of roles) current.roles.add(role);
    if (relationId) current.relationIds.add(relationId);
    out.set(evidenceId, current);
  };
  for (const node of graph.nodes) {
    const roles = retrievalRolesFromStructuredRecord(node.typeId, node.metadata);
    for (const evidenceId of node.evidenceIds) add(String(evidenceId), node.alpha, roles);
  }
  for (const edge of graph.edges) {
    const roles = retrievalRolesFromStructuredRecord(edge.relationId, edge.metadata);
    for (const evidenceId of edge.evidenceIds) add(String(evidenceId), edge.alpha * edge.weight, roles, String(edge.relationId));
  }
  for (const hyperedge of graph.hyperedges) {
    const weight = typeof (hyperedge.weightVector as { alpha?: unknown }).alpha === "number" ? (hyperedge.weightVector as { alpha: number }).alpha : 0.25;
    const roles = retrievalRolesFromStructuredRecord(hyperedge.relationId, hyperedge.weightVector);
    for (const evidenceId of hyperedge.provenanceRefs) add(String(evidenceId), weight, roles, String(hyperedge.relationId));
  }
  return out;
}

function expandFeatures(queryFeatures: string[], recall: HybridRecallResult[], index: CorpusIndex): string[] {
  const counts = new Map<string, number>();
  for (const item of recall.slice(0, 12)) {
    const document = index.documentsById.get(item.evidenceId);
    if (!document) continue;
    for (const feature of document.features.slice(0, 128)) counts.set(feature, (counts.get(feature) ?? 0) + item.score);
  }
  const query = new Set(queryFeatures);
  return [...counts.entries()].filter(([feature]) => !query.has(feature)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 128).map(([feature]) => feature);
}

function cachedCorpusIndex(
  evidence: readonly EvidenceSpan[],
  hasher: Hasher
): { index: CorpusIndex; cacheHit: boolean; precompiled?: boolean } {
  const key = hasher.digestHex(JSON.stringify(evidence.map(span => [
    String(span.id),
    String(span.sourceVersionId),
    String(span.contentHash),
    span.status,
    span.alpha
  ])));
  const cached = corpusIndexCache.get(key);
  if (cached) {
    corpusIndexCache.delete(key);
    corpusIndexCache.set(key, cached);
    return { index: cached, cacheHit: true };
  }
  const index = compileCorpusIndex(evidence, hasher);
  corpusIndexCache.set(key, index);
  while (corpusIndexCache.size > CORPUS_INDEX_CACHE_LIMIT) {
    const oldest = corpusIndexCache.keys().next().value;
    if (typeof oldest !== "string") break;
    corpusIndexCache.delete(oldest);
  }
  return { index, cacheHit: false };
}

function recallCandidateIds(input: {
  index: CorpusIndex;
  querySymbols: readonly string[];
  graphSignals: ReadonlyMap<string, GraphEvidenceSignal>;
  maximum: number;
}): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (evidenceId: string) => {
    if (seen.has(evidenceId) || !input.index.documentsById.has(evidenceId)) return;
    seen.add(evidenceId);
    out.push(evidenceId);
  };
  for (const symbol of new Set(input.querySymbols)) {
    for (const evidenceId of input.index.invertedIndex.get(symbol) ?? []) {
      add(evidenceId);
      if (out.length >= input.maximum) return out;
    }
  }
  for (const evidenceId of input.graphSignals.keys()) {
    add(evidenceId);
    if (out.length >= input.maximum) return out;
  }
  const minimumCandidateFloor = Math.min(input.maximum, 64);
  for (const evidenceId of input.index.topAlphaDocumentIds) {
    if (out.length >= minimumCandidateFloor) break;
    add(evidenceId);
  }
  return out;
}

function insertRecall(
  recalls: HybridRecallResult[],
  candidate: HybridRecallResult,
  limit: number
): void {
  let low = 0;
  let high = recalls.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    const current = recalls[middle]!;
    if (candidate.score > current.score
      || (candidate.score === current.score && candidate.evidenceId.localeCompare(current.evidenceId) < 0)) {
      high = middle;
    } else {
      low = middle + 1;
    }
  }
  recalls.splice(low, 0, candidate);
  if (recalls.length > limit) recalls.pop();
}

function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? clamp01((dot / Math.sqrt(aa * bb) + 1) / 2) : 0;
}

function classifyEvidenceRole(input: { bm25Score: number; vectorScore: number; graphScore: number; alphaScore: number; doc: IndexedDocument; graphSignal?: GraphEvidenceSignal }): HybridRecallResult["evidenceRole"] {
  const structuredRoles = [
    ...retrievalRolesFromStructuredRecord(input.doc.mediaType, input.doc.provenance),
    ...retrievalRolesFromStructuredRecord(input.doc.mediaType, input.doc.trustVector),
    ...(input.graphSignal ? [...input.graphSignal.roles] : [])
  ];
  const structured = strongestStructuredRole(structuredRoles);
  if (structured) return structured;
  if (input.graphScore > 0.2 || input.alphaScore > 0.55 || input.vectorScore > 0.45) return "support";
  return "source_context";
}

function strongestStructuredRole(roles: readonly RetrievalRole[]): RetrievalRole | undefined {
  const rank: RetrievalRole[] = ["counterexample", "contradiction", "definition", "test_evidence", "code_symbol", "example", "support", "source_context"];
  return rank.find(role => roles.includes(role));
}

function retrievalRolesFromStructuredRecord(id: unknown, value: JsonValue | undefined): RetrievalRole[] {
  const roles = new Set<RetrievalRole>();
  const visit = (item: unknown, depth: number) => {
    if (depth > 3 || item === undefined || item === null) return;
    if (typeof item === "string") {
      const role = retrievalRoleFromStructuredId(item);
      if (role) roles.add(role);
      return;
    }
    if (Array.isArray(item)) {
      for (const entry of item.slice(0, 16)) visit(entry, depth + 1);
      return;
    }
    if (typeof item !== "object") return;
    const record = item as Record<string, unknown>;
    for (const key of [
      "retrievalRole",
      "evidenceRole",
      "role",
      "roleId",
      "relationRoleId",
      "proofGraphKind",
      "semanticVerdict",
      "verdict",
      "forceClass",
      "diagnosticKindId",
      "sourceRoleId",
      "mediaType",
      "kind",
      "typeId"
    ]) {
      visit(record[key], depth + 1);
    }
  };
  visit(id, 0);
  visit(value, 0);
  return [...roles];
}

function retrievalRoleFromStructuredId(value: string): RetrievalRole | undefined {
  if (isRetrievalRole(value)) return value;
  const normalized = value.toLocaleLowerCase();
  if (value === PROOF_GRAPH_KIND.COUNTEREXAMPLE || normalized.endsWith(".counterexample") || normalized.includes("counterexample")) return "counterexample";
  if (value === SEMANTIC_VERDICT.CONTRADICTED || normalized.endsWith(".contradicted") || normalized.includes("contradiction")) return "contradiction";
  if (normalized.includes("definition_or_classification") || normalized.includes("role_or_classification")) return "definition";
  if (normalized.includes("source.role.test") || normalized.includes("diagnostic.kind.test")) return "test_evidence";
  if (normalized.startsWith("text/") && (normalized.includes("typescript") || normalized.includes("javascript") || normalized.includes("python"))) return "code_symbol";
  if (normalized.includes("observation:code") || normalized.includes("code_file") || normalized.includes("source.role.implementation")) return "code_symbol";
  if (normalized.includes("surface.example") || normalized.endsWith(".example")) return "example";
  return undefined;
}

function isRetrievalRole(value: string): value is RetrievalRole {
  return value === "support" ||
    value === "contradiction" ||
    value === "definition" ||
    value === "example" ||
    value === "counterexample" ||
    value === "source_context" ||
    value === "code_symbol" ||
    value === "test_evidence";
}

function roleConfidence(role: RetrievalRole): number {
  if (role === "support") return 1;
  if (role === "definition") return 0.82;
  if (role === "code_symbol" || role === "test_evidence") return 0.78;
  if (role === "example") return 0.72;
  if (role === "contradiction") return 0.68;
  if (role === "counterexample") return 0.6;
  return 0.42;
}
