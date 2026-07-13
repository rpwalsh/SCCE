import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import {
  GRAPH_QUALITY_CLASS_IDS,
  QUESTION_EDGE_DECISION_IDS,
  buildQuestionCognitiveFabric,
  normalizeRawGraphEdgeToCognitiveEdges,
  scoreGraphEdgeQuality,
  toJsonValue,
  type BrainImportLedgerRecord,
  type BrainShardProvenanceClass,
  type GraphEdgeQuality,
  type JsonValue,
  type QuestionEdgeDecision,
  type QuestionEdgeDecisionId,
  type ScceStorage
} from "@scce/kernel";
import { streamScce2ConceptGraph } from "./concept-graph-stream.js";
import { streamScce2NgramState, type Scce2NgramStreamItem } from "./ngram-stream.js";
import { readScce2LanguageProfile, safeStat, type Scce2LanguageProfileShard, type Scce2ProfileFileEvidence } from "./scce2-ingest-manifest.js";

export type V2ArtifactKind =
  | "v2_stream_corpus"
  | "v2_stream_lookup"
  | "v2_concept_graph_v8"
  | "v2_language_profile"
  | "v2_ngram_model"
  | "v2_ngram_shard"
  | "v2_manifest"
  | "unknown";

export type V2ArtifactImportDecision =
  | "import_graph_prior"
  | "import_language_profile_prior"
  | "import_ngram_prior"
  | "route_to_stream_corpus_ingestor"
  | "inspect_only"
  | "skip_or_quarantine";

export interface V2ArtifactInspectionOptions {
  maxDepth?: number;
  maxFiles?: number;
  hashWorkExtentBytes?: number;
  maxHashBytesPerFile?: number;
}

export interface V2ArtifactRecord {
  path: string;
  relativePath: string;
  size: number;
  kind: V2ArtifactKind;
  detectedSchema?: string;
  headerSignature?: string;
  recordCountEstimate?: number;
  sourceHash?: string;
  hashStatus: "computed" | "omitted" | "failed";
  importDecision: V2ArtifactImportDecision;
  destinationTables: string[];
  memoryRole: "corpus_source_memory" | "learned_graph_prior" | "learned_language_prior" | "learned_program_prior" | "manifest" | "unknown";
  forceClass: BrainShardProvenanceClass;
  reason: string;
  warnings: string[];
}

export interface V2ArtifactInspection {
  schema: "scce.v2Artifacts.inspect.v1";
  rootPath: string;
  totals: {
    files: number;
    bytes: number;
    byKind: Record<string, number>;
    byMemoryRole: Record<string, number>;
    byForceClass: Record<string, number>;
    byImportDecision: Record<string, number>;
  };
  files: V2ArtifactRecord[];
  graphMemory: V2ArtifactRecord[];
  languageMemory: V2ArtifactRecord[];
  corpusSourceMemory: V2ArtifactRecord[];
  quarantinedOrUnknown: V2ArtifactRecord[];
  warnings: string[];
}

export interface V2StreamInspection {
  schema: "scce.v2Stream.inspect.v1";
  path: string;
  files: V2ArtifactRecord[];
  corpusFiles: V2ArtifactRecord[];
  lookupFiles: V2ArtifactRecord[];
  status: "stream_corpus_and_lookup_present" | "stream_corpus_present_lookup_missing" | "stream_lookup_present_corpus_missing" | "stream_artifacts_missing";
  importRoute: "wiki_stream_ingestor" | "unavailable";
  destinationTables: string[];
  warnings: string[];
}

export interface V2StreamTopicInspection {
  schema: "scce.v2StreamTopic.inspect.v1";
  topic: string;
  pathsChecked: string[];
  matches: Array<{ path: string; line?: number; offset?: number; pageId?: string; revisionId?: string; title: string; raw: string }>;
  status: "resolved_in_lookup" | "not_found" | "lookup_unavailable" | "compressed_lookup_requires_stream_resolver";
  warnings: string[];
}

export interface V2GraphShardInspection {
  schema: "scce.v2GraphShard.inspect.v1";
  path: string;
  artifact: V2ArtifactRecord;
  graph: {
    concepts: number;
    relations: number;
    sampleConcepts: Array<{ id: string; names: string[]; type?: string; domain?: string }>;
    sampleRelations: Array<{ subject: string; predicate: string; object: string; confidence?: number }>;
  };
  forceClass: "learned_concept_prior";
  destinationTables: string[];
  warnings: string[];
}

export interface V2ProfileInspection {
  schema: "scce.v2Profile.inspect.v1";
  path: string;
  artifact: V2ArtifactRecord;
  profile?: {
    sourceId?: string;
    shardId?: string;
    languageId?: string;
    script?: string;
    observedSymbolCount: number;
    observedTitleSymbolCount: number;
    phraseUnitCount: number;
    punctuationPatternCount: number;
    fileEvidenceCount: number;
  };
  qualityGate: {
    rawWikiMarkupScore: number;
    urlRefTemplatePollutionScore: number;
    titleOnlyRatio: number;
    excerptProvenanceAvailability: number;
    cleanTextAvailability: number;
    directSourceSpanAvailability: number;
    recommendedImportClass: "learned_language_prior" | "profile_excerpt_evidence" | "quarantine_profile_excerpts";
  };
  destinationTables: string[];
  forceClasses: BrainShardProvenanceClass[];
  warnings: string[];
}

export interface V2NgramInspection {
  schema: "scce.v2Ngram.inspect.v1";
  path: string;
  artifact: V2ArtifactRecord;
  summary: {
    totalUnigrams: number;
    vocabularySize: number;
    orders: Array<{ order: number; contexts: number; continuations: number }>;
    interpolationWeights?: { w2: number; w3: number; w4: number; w5: number; w6: number };
  };
  examples: Array<{ order: number; history: string[]; symbol: string; count: number; modelId: string; forceClass: BrainShardProvenanceClass }>;
  destinationTables: string[];
  warnings: string[];
}

export interface HydrationStatusInspection {
  schema: "scce.hydrate.status.v1";
  statusFile?: string;
  statusFileFound: boolean;
  status?: JsonValue;
  activeBrain?: JsonValue;
  recentLedger?: JsonValue;
  tableCounts?: Record<string, number>;
  warnings: string[];
}

export interface V2TopicInspection {
  schema: "scce.v2Topic.inspect.v1";
  topic: string;
  question?: string;
  exactMatch: boolean;
  fuzzyMatch: boolean;
  nodeCount: number;
  topLabels: string[];
  topRelations: V2TopicRelationInspection[];
  answerGradeEdgeCount: number;
  weakFragmentEdgeCount: number;
  categoryEdgeCount: number;
  noisyEdgeCount: number;
  topAnswerGradeRelations: V2TopicRelationInspection[];
  topRejectedRelations: Array<V2TopicRelationInspection & { reasonIds: string[] }>;
  questionShapeId?: string;
  questionRequestedSlotIds: string[];
  questionCognitiveEdgeCount: number;
  questionSelectedEdgeCount: number;
  questionSupportMass: number;
  questionMissingRequestedSlots: string[];
  questionSelectedTopicSenseId?: string;
  questionDecisionPreview?: QuestionEdgeDecision;
  topQuestionFits: V2TopicQuestionFitInspection[];
  questionRejectedFits: V2TopicQuestionFitInspection[];
  directEvidenceCount: number;
  learnedGraphPriorCount: number;
  profileExcerptCount: number;
  languagePriorCount: number;
  relevanceGateDecisionPreview: QuestionEdgeDecisionId;
  warnings: string[];
}

export interface V2TopicRelationInspection {
  edgeId: string;
  relationId: string;
  subject: string;
  predicate: string;
  object: string;
  weight?: number;
  alpha?: number;
  forceClass?: string;
  quality?: GraphEdgeQuality;
}

export interface V2TopicQuestionFitInspection {
  cognitiveEdgeId: string;
  rawEdgeId: string;
  subject: string;
  predicate: string;
  object: string;
  requestedSlotId: string;
  relationRoleId: string;
  topicSenseId: string;
  finalQuestionFit: number;
  decision: QuestionEdgeDecision;
  reasonIds: string[];
}

interface DiscoveredFile {
  path: string;
  relativePath: string;
  size: number;
}

interface HashBudget {
  remaining: number;
  maxFileBytes: number;
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FILES = 20000;
const DEFAULT_HASH_WORK_EXTENT_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_HASH_BYTES_PER_FILE = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 4096;
const MAX_UNCOMPRESSED_LOOKUP_SCAN_BYTES = 64 * 1024 * 1024;
const MAX_COMPRESSED_LOOKUP_SCAN_BYTES = 2 * 1024 * 1024 * 1024;
const PYTHON_BZ2_LOOKUP_SEARCH = [
  "import bz2,sys",
  "path=sys.argv[1]",
  "needle=sys.argv[2].casefold()",
  "limit=int(sys.argv[3])",
  "seen=0",
  "found=0",
  "with bz2.open(path,'rt',encoding='utf-8',errors='replace') as f:",
  "  for lineno,line in enumerate(f,1):",
  "    seen += len(line.encode('utf-8','ignore'))",
  "    if needle in line.casefold():",
  "      sys.stdout.write(str(lineno)+'\\t'+line[:2000].replace('\\n','')+'\\n')",
  "      found += 1",
  "      if found >= 32: break",
  "    if limit > 0 and seen >= limit:",
  "      sys.stderr.write('scan_limit_reached\\n')",
  "      break"
].join("\n");

export async function inspectV2Artifacts(rootPath: string, options: V2ArtifactInspectionOptions = {}): Promise<V2ArtifactInspection> {
  const root = path.resolve(rootPath);
  const files = await discoverFiles(root, options);
  const budget: HashBudget = {
    remaining: Math.max(0, options.hashWorkExtentBytes ?? DEFAULT_HASH_WORK_EXTENT_BYTES),
    maxFileBytes: Math.max(0, options.maxHashBytesPerFile ?? DEFAULT_MAX_HASH_BYTES_PER_FILE)
  };
  const records: V2ArtifactRecord[] = [];
  const warnings: string[] = [];
  for (const file of files.files) records.push(await inspectV2ArtifactFile(root, file, budget));
  warnings.push(...files.warnings);
  return {
    schema: "scce.v2Artifacts.inspect.v1",
    rootPath: root,
    totals: {
      files: records.length,
      bytes: records.reduce((sum, file) => sum + file.size, 0),
      byKind: countBy(records.map(file => file.kind)),
      byMemoryRole: countBy(records.map(file => file.memoryRole)),
      byForceClass: countBy(records.map(file => file.forceClass)),
      byImportDecision: countBy(records.map(file => file.importDecision))
    },
    files: records,
    graphMemory: records.filter(file => file.memoryRole === "learned_graph_prior"),
    languageMemory: records.filter(file => file.memoryRole === "learned_language_prior" || file.memoryRole === "learned_program_prior"),
    corpusSourceMemory: records.filter(file => file.memoryRole === "corpus_source_memory"),
    quarantinedOrUnknown: records.filter(file => file.memoryRole === "unknown" || file.importDecision === "skip_or_quarantine"),
    warnings
  };
}

export async function inspectV2Stream(streamPath: string, options: V2ArtifactInspectionOptions = {}): Promise<V2StreamInspection> {
  const inspected = await inspectV2Artifacts(streamPath, options);
  const corpusFiles = inspected.files.filter(file => file.kind === "v2_stream_corpus");
  const lookupFiles = inspected.files.filter(file => file.kind === "v2_stream_lookup");
  const status = corpusFiles.length && lookupFiles.length
    ? "stream_corpus_and_lookup_present"
    : corpusFiles.length
      ? "stream_corpus_present_lookup_missing"
      : lookupFiles.length
        ? "stream_lookup_present_corpus_missing"
        : "stream_artifacts_missing";
  return {
    schema: "scce.v2Stream.inspect.v1",
    path: path.resolve(streamPath),
    files: inspected.files,
    corpusFiles,
    lookupFiles,
    status,
    importRoute: corpusFiles.length ? "wiki_stream_ingestor" : "unavailable",
    destinationTables: corpusFiles.length ? ["sources", "source_versions", "evidence_spans", "graph_nodes", "graph_edges", "ingestion_checkpoints"] : [],
    warnings: inspected.warnings
  };
}

export async function inspectV2StreamTopic(topic: string, candidatePaths: string[], options: { maxLookupBytes?: number } = {}): Promise<V2StreamTopicInspection> {
  const pathsChecked: string[] = [];
  const matches: V2StreamTopicInspection["matches"] = [];
  const warnings: string[] = [];
  for (const candidate of candidatePaths.map(item => path.resolve(item))) {
    const s = await safeStat(candidate);
    if (!s) {
      warnings.push(`missing stream lookup candidate: ${candidate}`);
      continue;
    }
    if (s.isDirectory()) {
      const inspected = await inspectV2Artifacts(candidate, { maxDepth: 4, maxFiles: 2000, hashWorkExtentBytes: 0, maxHashBytesPerFile: 0 });
      for (const file of inspected.files.filter(item => item.kind === "v2_stream_lookup")) {
        const child = await inspectStreamLookupFile(topic, file.path, options.maxLookupBytes);
        pathsChecked.push(...child.pathsChecked);
        matches.push(...child.matches);
        warnings.push(...child.warnings);
      }
      continue;
    }
    const child = await inspectStreamLookupFile(topic, candidate, options.maxLookupBytes);
    pathsChecked.push(...child.pathsChecked);
    matches.push(...child.matches);
    warnings.push(...child.warnings);
  }
  const compressed = pathsChecked.some(item => lowerBase(item).endsWith(".bz2"));
  return {
    schema: "scce.v2StreamTopic.inspect.v1",
    topic,
    pathsChecked,
    matches,
    status: matches.length ? "resolved_in_lookup" : compressed ? "compressed_lookup_requires_stream_resolver" : pathsChecked.length ? "not_found" : "lookup_unavailable",
    warnings
  };
}

export async function inspectV2GraphShard(filePath: string, options: { maxBytes?: number; sampleLimit?: number } = {}): Promise<V2GraphShardInspection> {
  const absolute = path.resolve(filePath);
  const file = await fileForPath(absolute);
  const artifact = await inspectV2ArtifactFile(path.dirname(absolute), file, { remaining: 0, maxFileBytes: 0 });
  const sampleLimit = Math.max(1, options.sampleLimit ?? 12);
  const sampleConcepts: V2GraphShardInspection["graph"]["sampleConcepts"] = [];
  const sampleRelations: V2GraphShardInspection["graph"]["sampleRelations"] = [];
  const summary = await streamScce2ConceptGraph(
    absolute,
    async (id, concept) => {
      if (sampleConcepts.length < sampleLimit) {
        sampleConcepts.push({
          id,
          names: namesOf(concept.names).slice(0, 5),
          type: concept.type,
          domain: concept.domain
        });
      }
    },
    async relation => {
      if (sampleRelations.length < sampleLimit) {
        sampleRelations.push({
          subject: relation.subject,
          predicate: relation.predicate,
          object: relation.object,
          confidence: relation.confidence
        });
      }
    },
    { maxBytes: options.maxBytes }
  );
  return {
    schema: "scce.v2GraphShard.inspect.v1",
    path: absolute,
    artifact,
    graph: {
      concepts: summary.concepts,
      relations: summary.relations,
      sampleConcepts,
      sampleRelations
    },
    forceClass: "learned_concept_prior",
    destinationTables: ["source_versions", "graph_nodes", "graph_edges", "graph_hyperedges", "scce2_import_ledger"],
    warnings: summary.warnings
  };
}

export async function inspectV2Profile(filePath: string): Promise<V2ProfileInspection> {
  const absolute = path.resolve(filePath);
  const file = await fileForPath(absolute);
  const artifact = await inspectV2ArtifactFile(path.dirname(absolute), file, { remaining: 0, maxFileBytes: 0 });
  const profile = await readScce2LanguageProfile(absolute);
  const quality = qualityGateForProfile(profile);
  const profileSummary = profile ? {
    sourceId: profile.sourceId,
    shardId: profile.shardId,
    languageId: profile.languageId,
    script: profile.script,
    observedSymbolCount: topCount(profile.tokenizationProfile?.observedSymbols ?? profile.tokenizationProfile?.observedTokens),
    observedTitleSymbolCount: topCount(profile.tokenizationProfile?.observedTitleTokens),
    phraseUnitCount: topCount(profile.documentationPatterns) + topCount(profile.examplePatterns),
    punctuationPatternCount: topCount(profile.syntaxProfile?.punctuation),
    fileEvidenceCount: profile.fileEvidence?.length ?? 0
  } : undefined;
  return {
    schema: "scce.v2Profile.inspect.v1",
    path: absolute,
    artifact,
    profile: profileSummary,
    qualityGate: quality,
    destinationTables: ["source_versions", "language_units", "language_patterns", "semantic_frames", "ngram_observations", "scce2_import_ledger"],
    forceClasses: quality.recommendedImportClass === "quarantine_profile_excerpts" ? ["learned_language_prior"] : ["learned_language_prior", quality.recommendedImportClass],
    warnings: profile ? profileQualityWarnings(quality) : ["profile file did not decode as SCCE2 language profile"]
  };
}

export async function inspectV2Ngram(filePath: string, options: { maxBytes?: number; sampleLimit?: number } = {}): Promise<V2NgramInspection> {
  const absolute = path.resolve(filePath);
  const file = await fileForPath(absolute);
  const artifact = await inspectV2ArtifactFile(path.dirname(absolute), file, { remaining: 0, maxFileBytes: 0 });
  const sampleLimit = Math.max(1, options.sampleLimit ?? 16);
  const examples: V2NgramInspection["examples"] = [];
  const forceClass = artifact.forceClass;
  const modelId = ngramModelIdFromPath(absolute);
  const summary = await streamScce2NgramState(
    absolute,
    async (item: Scce2NgramStreamItem) => {
      if (examples.length < sampleLimit) examples.push({ ...item, modelId, forceClass });
    },
    { maxBytes: options.maxBytes }
  );
  return {
    schema: "scce.v2Ngram.inspect.v1",
    path: absolute,
    artifact,
    summary: {
      totalUnigrams: summary.totalUnigrams,
      vocabularySize: summary.vocabularySize,
      orders: summary.orders,
      interpolationWeights: summary.interpolationWeights
    },
    examples,
    destinationTables: ["source_versions", "ngram_models", "ngram_observations", "language_units", "language_patterns", "scce2_import_ledger"],
    warnings: summary.warnings
  };
}

export async function inspectHydrationStatus(storage: ScceStorage, options: { statusFile?: string } = {}): Promise<HydrationStatusInspection> {
  const warnings: string[] = [];
  const status = options.statusFile ? await readJsonOrNull<JsonValue>(options.statusFile) : undefined;
  if (options.statusFile && status === undefined) warnings.push(`status file not found or not readable: ${options.statusFile}`);
  const activeBrain = await storage.brainImports.active().catch(error => {
    warnings.push(`active brain lookup failed: ${messageOf(error)}`);
    return undefined;
  });
  const recentLedger = await storage.brainImports.listLedger({ limit: 16 }).catch(error => {
    warnings.push(`ledger lookup failed: ${messageOf(error)}`);
    return undefined;
  });
  const tableCounts = await maybeTableCounts(storage, [
    "scce2_import_ledger",
    "source_versions",
    "evidence_spans",
    "graph_nodes",
    "graph_edges",
    "graph_hyperedges",
    "language_units",
    "language_patterns",
    "ngram_models",
    "ngram_observations",
    "semantic_frames"
  ], warnings);
  return {
    schema: "scce.hydrate.status.v1",
    statusFile: options.statusFile,
    statusFileFound: Boolean(status),
    status,
    activeBrain: activeBrain ? toJsonValue(activeBrain) : undefined,
    recentLedger: recentLedger ? toJsonValue(recentLedger.map(summarizeLedgerRecord)) : undefined,
    tableCounts,
    warnings
  };
}

export async function inspectV2Topic(storage: ScceStorage, topic: string, options: { question?: string } = {}): Promise<V2TopicInspection> {
  const pg = asPostgresLike(storage);
  const warnings: string[] = [];
  if (!pg) {
    return emptyTopicInspection(topic, ["topic inspection requires PostgreSQL adapter"]);
  }
  const query = `%${topic}%`;
  const nodeRows = await pg.query<{ id: string; representation_json: unknown; alpha: number; metadata_json: unknown }>(
    `SELECT id, representation_json, alpha, metadata_json FROM ${pg.table("graph_nodes")} WHERE representation_json::text ILIKE $1 OR metadata_json::text ILIKE $1 ORDER BY alpha DESC LIMIT 64`,
    [query]
  ).catch(error => {
    warnings.push(`graph node topic lookup failed: ${messageOf(error)}`);
    return [];
  });
  const edgeRows = await pg.query<{ id: string; relation_id: string; weight: number; alpha: number; metadata_json: unknown }>(
    `SELECT id, relation_id, weight, alpha, metadata_json FROM ${pg.table("graph_edges")} WHERE metadata_json::text ILIKE $1 OR relation_id ILIKE $1 ORDER BY weight DESC, alpha DESC LIMIT 128`,
    [query]
  ).catch(error => {
    warnings.push(`graph edge topic lookup failed: ${messageOf(error)}`);
    return [];
  });
  const evidenceRows = await pg.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${pg.table("evidence_spans")} WHERE text_content ILIKE $1 OR text_preview ILIKE $1`,
    [query]
  ).catch(error => {
    warnings.push(`evidence topic lookup failed: ${messageOf(error)}`);
    return [];
  });
  const directEvidenceRows = await pg.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${pg.table("evidence_spans")} WHERE (text_content ILIKE $1 OR text_preview ILIKE $1) AND provenance_json::text ILIKE '%direct_evidence%'`,
    [query]
  ).catch(error => {
    warnings.push(`direct evidence topic lookup failed: ${messageOf(error)}`);
    return [];
  });
  const profileEvidenceRows = await pg.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${pg.table("evidence_spans")} WHERE (text_content ILIKE $1 OR text_preview ILIKE $1) AND provenance_json::text ILIKE '%profile_excerpt_evidence%'`,
    [query]
  ).catch(error => {
    warnings.push(`profile excerpt topic lookup failed: ${messageOf(error)}`);
    return [];
  });
  const languageRows = await pg.query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM ${pg.table("language_units")} WHERE unit_text ILIKE $1 OR metadata_json::text ILIKE $1`,
    [query]
  ).catch(error => {
    warnings.push(`language topic lookup failed: ${messageOf(error)}`);
    return [];
  });
  const topicLower = topic.toLocaleLowerCase();
  const relations = edgeRows.map(row => relationFromMetadata(row.id, row.relation_id, row.metadata_json, row.weight, row.alpha)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  const answerGradeRelations = relations.filter(row => row.quality?.answerGrade);
  const weakFragmentRelations = relations.filter(row => row.quality?.classId === GRAPH_QUALITY_CLASS_IDS.weakFragment);
  const categoryRelations = relations.filter(row => row.quality?.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation);
  const noisyRelations = relations.filter(row => row.quality?.classId === GRAPH_QUALITY_CLASS_IDS.noisyMarkup);
  const rejectedRelations = relations.filter(row => !row.quality?.answerGrade);
  const labels = unique([...topLabelsFromNodeRows(nodeRows), ...relations.flatMap(row => [row.subject, row.object])]).slice(0, 32);
  const exactMatch = labels.some(label => label.toLocaleLowerCase() === topicLower);
  const fuzzyMatch = exactMatch || labels.some(label => label.toLocaleLowerCase().includes(topicLower) || topicLower.includes(label.toLocaleLowerCase()));
  const directEvidenceCount = Number(directEvidenceRows[0]?.count ?? 0);
  const profileExcerptCount = Number(profileEvidenceRows[0]?.count ?? 0);
  const languagePriorCount = Number(languageRows[0]?.count ?? 0);
  const learnedGraphPriorCount = nodeRows.length + edgeRows.length;
  const answerGradeEdgeCount = answerGradeRelations.length;
  const weakFragmentEdgeCount = weakFragmentRelations.length;
  const categoryEdgeCount = categoryRelations.length;
  const noisyEdgeCount = noisyRelations.length;
  const question = options.question?.trim() || undefined;
  const questionEdges = question ? relations.flatMap(row => normalizeRawGraphEdgeToCognitiveEdges({
    rawEdgeId: row.edgeId,
    relationId: row.relationId,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    alphaSupport: row.alpha,
    ppfSupport: row.alpha,
    supportMass: Math.max(row.weight ?? 0, row.alpha ?? 0, row.quality?.semanticQuality ?? 0),
    forceClass: row.forceClass ?? "unknown_prior",
    semanticQuality: row.quality?.semanticQuality ?? 0,
    graphQuality: row.quality,
    selectedTopic: topic,
    requestText: question
  })) : [];
  const cognitiveFabric = question ? buildQuestionCognitiveFabric(questionEdges, question) : undefined;
  const questionFitRows: V2TopicQuestionFitInspection[] = questionEdges
    .map(row => ({
      cognitiveEdgeId: row.fit.cognitiveEdgeId,
      rawEdgeId: row.fit.rawEdgeId,
      subject: row.cognitiveEdge.subjectRef,
      predicate: row.cognitiveEdge.sourceDerivedLabels.predicate,
      object: row.cognitiveEdge.objectRef,
      requestedSlotId: row.fit.requestedSlotId,
      relationRoleId: row.fit.relationRoleId,
      topicSenseId: row.fit.topicSenseId,
      finalQuestionFit: row.fit.finalQuestionFit,
      decision: row.fit.decision,
      reasonIds: row.fit.reasonIds
    }))
    .sort((left, right) => right.finalQuestionFit - left.finalQuestionFit || left.subject.localeCompare(right.subject));
  const selectedQuestionIds = new Set(cognitiveFabric?.selectedFits.map(fit => fit.cognitiveEdgeId) ?? []);
  return {
    schema: "scce.v2Topic.inspect.v1",
    topic,
    question,
    exactMatch,
    fuzzyMatch,
    nodeCount: nodeRows.length,
    topLabels: labels.slice(0, 16),
    topRelations: relations.slice(0, 16),
    answerGradeEdgeCount,
    weakFragmentEdgeCount,
    categoryEdgeCount,
    noisyEdgeCount,
    topAnswerGradeRelations: answerGradeRelations
      .sort((left, right) => (right.quality?.semanticQuality ?? 0) - (left.quality?.semanticQuality ?? 0) || (right.weight ?? 0) - (left.weight ?? 0))
      .slice(0, 16),
    topRejectedRelations: rejectedRelations
      .sort((left, right) => (right.quality?.semanticQuality ?? 0) - (left.quality?.semanticQuality ?? 0) || (right.weight ?? 0) - (left.weight ?? 0))
      .slice(0, 16)
      .map(row => ({ ...row, reasonIds: row.quality?.reasonIds ?? [] })),
    questionShapeId: cognitiveFabric?.questionShapeId,
    questionRequestedSlotIds: cognitiveFabric?.requestedSlotIds ?? [],
    questionCognitiveEdgeCount: questionEdges.length,
    questionSelectedEdgeCount: cognitiveFabric?.selectedFits.length ?? 0,
    questionSupportMass: cognitiveFabric?.supportMass ?? 0,
    questionMissingRequestedSlots: cognitiveFabric?.missingRequestedSlots ?? [],
    questionSelectedTopicSenseId: cognitiveFabric?.selectedTopicSenseId,
    questionDecisionPreview: cognitiveFabric?.decision,
    topQuestionFits: questionFitRows.filter(row => selectedQuestionIds.has(row.cognitiveEdgeId)).slice(0, 16),
    questionRejectedFits: questionFitRows.filter(row => !selectedQuestionIds.has(row.cognitiveEdgeId)).slice(0, 16),
    directEvidenceCount,
    learnedGraphPriorCount,
    profileExcerptCount,
    languagePriorCount,
    relevanceGateDecisionPreview: directEvidenceCount > 0
      ? QUESTION_EDGE_DECISION_IDS.directEvidence
      : answerGradeEdgeCount > 0
        ? QUESTION_EDGE_DECISION_IDS.requestedSupport
        : weakFragmentEdgeCount + categoryEdgeCount > 0
          ? QUESTION_EDGE_DECISION_IDS.weakGraphOnly
        : languagePriorCount > 0 || profileExcerptCount > 0
          ? QUESTION_EDGE_DECISION_IDS.languageOnlyRejected
          : QUESTION_EDGE_DECISION_IDS.insufficientSupport,
    warnings
  };
}

export function classifyV2ArtifactPath(filePath: string, header?: string): Pick<V2ArtifactRecord, "kind" | "importDecision" | "destinationTables" | "memoryRole" | "forceClass" | "reason"> {
  const parts = pathParts(filePath);
  const base = lowerBase(filePath);
  const lower = filePath.toLocaleLowerCase();
  const headerText = header?.toLocaleLowerCase() ?? "";
  if (base === "manifest.json" || base.endsWith(".manifest.json") || base.endsWith(".stats.json") || headerText.includes("scce.brainshardmanifest") || headerText.includes("learnedlanguageprofilemanifest")) {
    return {
      kind: "v2_manifest",
      importDecision: "inspect_only",
      destinationTables: ["source_versions", "scce2_import_ledger"],
      memoryRole: "manifest",
      forceClass: "unknown_prior",
      reason: base.endsWith(".stats.json")
        ? "shard stats record import provenance and row estimates; it is not factual memory"
        : "manifest records import provenance and section planning; it is not factual memory"
    };
  }
  if (isConceptGraphPath(parts, base, headerText)) {
    return {
      kind: "v2_concept_graph_v8",
      importDecision: "import_graph_prior",
      destinationTables: ["source_versions", "graph_nodes", "graph_edges", "graph_hyperedges", "scce2_import_ledger"],
      memoryRole: "learned_graph_prior",
      forceClass: "learned_concept_prior",
      reason: "SCCE2 V8 concept graph shards hydrate learned graph priors for alpha and PPF navigation"
    };
  }
  if (isLanguageProfilePath(parts, base, headerText)) {
    return {
      kind: "v2_language_profile",
      importDecision: "import_language_profile_prior",
      destinationTables: ["source_versions", "language_units", "language_patterns", "semantic_frames", "ngram_observations", "scce2_import_ledger"],
      memoryRole: "learned_language_prior",
      forceClass: "learned_language_prior",
      reason: "language profile shards shape surface behavior; profile excerpts are never external direct evidence"
    };
  }
  if (isNgramPath(parts, base, headerText)) {
    const program = isCodeNgramPath(parts, base);
    return {
      kind: parts.includes("shards") || base.endsWith(".jsonl") ? "v2_ngram_shard" : "v2_ngram_model",
      importDecision: "import_ngram_prior",
      destinationTables: ["source_versions", "ngram_models", "ngram_observations", "language_units", "language_patterns", "scce2_import_ledger"],
      memoryRole: program ? "learned_program_prior" : "learned_language_prior",
      forceClass: program ? "learned_program_prior" : "learned_language_prior",
      reason: "n-gram artifacts provide observed symbol continuation statistics, not factual claims"
    };
  }
  if (isStreamLookupPath(parts, base, headerText)) {
    return {
      kind: "v2_stream_lookup",
      importDecision: "route_to_stream_corpus_ingestor",
      destinationTables: ["sources", "source_versions", "evidence_spans", "ingestion_checkpoints"],
      memoryRole: "corpus_source_memory",
      forceClass: "unknown_prior",
      reason: "stream lookup maps titles/pages to corpus offsets so evidence spans can point to source text"
    };
  }
  if (isStreamCorpusPath(parts, base, headerText)) {
    return {
      kind: "v2_stream_corpus",
      importDecision: "route_to_stream_corpus_ingestor",
      destinationTables: ["sources", "source_versions", "evidence_spans", "ingestion_checkpoints"],
      memoryRole: "corpus_source_memory",
      forceClass: "unknown_prior",
      reason: "stream corpus is source memory and must hydrate as source versions plus retrievable spans"
    };
  }
  return {
    kind: "unknown",
    importDecision: "skip_or_quarantine",
    destinationTables: [],
    memoryRole: "unknown",
    forceClass: "unknown_prior",
    reason: "unrecognized v2 artifact; not eligible to become factual knowledge"
  };
}

async function inspectV2ArtifactFile(root: string, file: DiscoveredFile, budget: HashBudget): Promise<V2ArtifactRecord> {
  const header = await readHeader(file.path);
  const classified = classifyV2ArtifactPath(file.path, header);
  const hash = await hashFileIfAllowed(file.path, file.size, budget);
  const detectedSchema = detectedSchemaFromHeader(header);
  return {
    path: file.path,
    relativePath: path.relative(root, file.path) || path.basename(file.path),
    size: file.size,
    ...classified,
    detectedSchema,
    headerSignature: headerSignature(header),
    recordCountEstimate: recordCountEstimate(classified.kind, header),
    sourceHash: hash.hash,
    hashStatus: hash.status,
    warnings: hash.warning ? [hash.warning] : []
  };
}

async function discoverFiles(rootPath: string, options: V2ArtifactInspectionOptions): Promise<{ files: DiscoveredFile[]; warnings: string[] }> {
  const root = path.resolve(rootPath);
  const rootStat = await stat(root).catch(() => undefined);
  if (!rootStat) return { files: [], warnings: [`missing path: ${root}`] };
  if (rootStat.isFile()) return { files: [{ path: root, relativePath: path.basename(root), size: rootStat.size }], warnings: [] };
  const files: DiscoveredFile[] = [];
  const warnings: string[] = [];
  const maxDepth = Math.max(0, options.maxDepth ?? DEFAULT_MAX_DEPTH);
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const visit = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || files.length >= maxFiles) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      warnings.push(`cannot read directory ${dir}: ${messageOf(error)}`);
      return;
    }
    for (const entry of entries) {
      if (files.length >= maxFiles) {
        warnings.push(`file discovery stopped at ${maxFiles} files under ${root}`);
        return;
      }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".git" || entry.name === "node_modules" || entry.name === "dist" || entry.name === "coverage") continue;
        await visit(full, depth + 1);
      } else if (entry.isFile()) {
        const s = await stat(full).catch(() => undefined);
        if (s) files.push({ path: full, relativePath: path.relative(root, full), size: s.size });
      }
    }
  };
  await visit(root, 0);
  return { files: files.sort((a, b) => a.relativePath.localeCompare(b.relativePath)), warnings };
}

async function fileForPath(filePath: string): Promise<DiscoveredFile> {
  const s = await stat(filePath);
  return { path: filePath, relativePath: path.basename(filePath), size: s.size };
}

async function readHeader(filePath: string): Promise<string> {
  const info = await safeStat(filePath);
  if (!info?.isFile()) return "";
  const max = Math.min(MAX_HEADER_BYTES, info.size);
  if (max <= 0) return "";
  const handle = await import("node:fs/promises").then(fs => fs.open(filePath, "r")).catch(() => undefined);
  if (!handle) return "";
  try {
    const buffer = Buffer.alloc(max);
    const result = await handle.read(buffer, 0, max, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

async function hashFileIfAllowed(filePath: string, size: number, budget: HashBudget): Promise<{ status: "computed" | "omitted" | "failed"; hash?: string; warning?: string }> {
  if (budget.maxFileBytes <= 0 || budget.remaining <= 0 || size > budget.maxFileBytes || size > budget.remaining) {
    return { status: "omitted", warning: "source hash omitted by bounded hash work extent" };
  }
  try {
    const hash = createHash("sha256");
    await new Promise<void>((resolve, reject) => {
      const stream = createReadStream(filePath);
      stream.on("data", chunk => hash.update(chunk));
      stream.on("error", reject);
      stream.on("end", resolve);
    });
    budget.remaining = Math.max(0, budget.remaining - size);
    return { status: "computed", hash: hash.digest("hex") };
  } catch (error) {
    return { status: "failed", warning: `source hash failed: ${messageOf(error)}` };
  }
}

async function inspectStreamLookupFile(topic: string, filePath: string, maxBytes: number | undefined): Promise<V2StreamTopicInspection> {
  const absolute = path.resolve(filePath);
  const info = await safeStat(absolute);
  const warnings: string[] = [];
  if (!info?.isFile()) return { schema: "scce.v2StreamTopic.inspect.v1", topic, pathsChecked: [absolute], matches: [], status: "lookup_unavailable", warnings: [`missing lookup file: ${absolute}`] };
  if (lowerBase(absolute).endsWith(".bz2")) {
    const compressed = await inspectCompressedStreamLookupFile(topic, absolute, maxBytes ?? MAX_COMPRESSED_LOOKUP_SCAN_BYTES);
    return { ...compressed, warnings: [...compressed.warnings, ...warnings] };
  }
  const bound = Math.min(maxBytes ?? MAX_UNCOMPRESSED_LOOKUP_SCAN_BYTES, MAX_UNCOMPRESSED_LOOKUP_SCAN_BYTES);
  if (info.size > bound) warnings.push(`lookup scan bounded at ${bound} bytes for ${absolute}`);
  const text = await readBoundedText(absolute, Math.min(info.size, bound));
  const topicLower = topic.toLocaleLowerCase();
  const matches: V2StreamTopicInspection["matches"] = [];
  const lines = text.split("\n");
  let byteOffset = 0;
  for (let index = 0; index < lines.length && matches.length < 32; index++) {
    const line = lines[index] ?? "";
    if (line.toLocaleLowerCase().includes(topicLower)) {
      const parsed = parseLookupLine(line);
      matches.push({ path: absolute, line: index + 1, offset: parsed.offset, pageId: parsed.pageId, revisionId: parsed.revisionId, title: parsed.title, raw: line.slice(0, 600) });
    }
    byteOffset += Buffer.byteLength(line) + 1;
    void byteOffset;
  }
  return { schema: "scce.v2StreamTopic.inspect.v1", topic, pathsChecked: [absolute], matches, status: matches.length ? "resolved_in_lookup" : "not_found", warnings };
}

async function inspectCompressedStreamLookupFile(topic: string, filePath: string, maxBytes: number): Promise<V2StreamTopicInspection> {
  const command = await pythonCommand();
  if (!command) {
    return {
      schema: "scce.v2StreamTopic.inspect.v1",
      topic,
      pathsChecked: [filePath],
      matches: [],
      status: "compressed_lookup_requires_stream_resolver",
      warnings: ["compressed lookup requires Python bz2 support; no Python launcher found"]
    };
  }
  const args = command.command === "py"
    ? ["-3", "-c", PYTHON_BZ2_LOOKUP_SEARCH, filePath, topic, String(Math.max(0, maxBytes))]
    : ["-c", PYTHON_BZ2_LOOKUP_SEARCH, filePath, topic, String(Math.max(0, maxBytes))];
  const result = await runBuffered(command.command, args, 512 * 1024);
  const warnings: string[] = [];
  if (result.stderr.includes("scan_limit_reached")) warnings.push(`compressed lookup scan bounded at ${maxBytes} decompressed bytes for ${filePath}`);
  if (result.code !== 0) {
    warnings.push(`compressed lookup search exited ${result.code}: ${result.stderr.trim().slice(0, 400)}`);
    return { schema: "scce.v2StreamTopic.inspect.v1", topic, pathsChecked: [filePath], matches: [], status: "compressed_lookup_requires_stream_resolver", warnings };
  }
  const matches: V2StreamTopicInspection["matches"] = [];
  for (const line of result.stdout.split("\n")) {
    if (!line.trim()) continue;
    const tab = line.indexOf("\t");
    const lineNo = tab >= 0 ? Number(line.slice(0, tab)) : undefined;
    const raw = tab >= 0 ? line.slice(tab + 1) : line;
    const parsed = parseLookupLine(raw);
    matches.push({ path: filePath, line: Number.isFinite(lineNo) ? lineNo : undefined, offset: parsed.offset, pageId: parsed.pageId, revisionId: parsed.revisionId, title: parsed.title, raw: raw.slice(0, 600) });
  }
  return {
    schema: "scce.v2StreamTopic.inspect.v1",
    topic,
    pathsChecked: [filePath],
    matches,
    status: matches.length ? "resolved_in_lookup" : "not_found",
    warnings
  };
}

async function pythonCommand(): Promise<{ command: string } | undefined> {
  const candidates = [
    { command: "py", args: ["-3", "--version"] },
    { command: "python", args: ["--version"] },
    { command: "python3", args: ["--version"] }
  ];
  for (const candidate of candidates) {
    const result = await runBuffered(candidate.command, candidate.args, 4096).catch(() => undefined);
    if (result?.code === 0) return { command: candidate.command };
  }
  return undefined;
}

async function runBuffered(command: string, args: string[], maxOutputBytes: number): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const append = (chunks: Buffer[], currentBytes: number, chunk: Buffer | Uint8Array | string): number => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - currentBytes);
      if (remaining > 0) chunks.push(buffer.subarray(0, Math.min(buffer.length, remaining)));
      return currentBytes + Math.min(buffer.length, remaining);
    };
    child.stdout?.on("data", chunk => {
      stdoutBytes = append(stdout, stdoutBytes, chunk);
    });
    child.stderr?.on("data", chunk => {
      stderrBytes = append(stderr, stderrBytes, chunk);
    });
    child.on("error", error => {
      resolve({ code: 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: messageOf(error) });
    });
    child.on("close", code => {
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") });
    });
  });
}

async function readBoundedText(filePath: string, maxBytes: number): Promise<string> {
  const handle = await import("node:fs/promises").then(fs => fs.open(filePath, "r"));
  try {
    const buffer = Buffer.alloc(Math.max(0, maxBytes));
    const result = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, result.bytesRead).toString("utf8");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function parseLookupLine(line: string): { offset?: number; pageId?: string; revisionId?: string; title: string } {
  const trimmed = line.trim();
  if (!trimmed) return { title: "" };
  const tabParts = trimmed.split("\t");
  const colonParts = trimmed.split(":");
  const parts = tabParts.length > colonParts.length ? tabParts : colonParts;
  const numeric = parts.map(part => Number(part)).map(value => Number.isFinite(value) ? value : undefined);
  const title = parts.slice(Math.min(2, parts.length - 1)).join(parts === tabParts ? "\t" : ":").trim() || parts[parts.length - 1]?.trim() || trimmed;
  return {
    offset: numeric.find(value => value !== undefined),
    pageId: parts.find(part => part.trim() && Number.isFinite(Number(part)))?.trim(),
    revisionId: parts.length > 2 && Number.isFinite(Number(parts[1])) ? parts[1]?.trim() : undefined,
    title
  };
}

function qualityGateForProfile(profile: Scce2LanguageProfileShard | undefined): V2ProfileInspection["qualityGate"] {
  if (!profile) return { rawWikiMarkupScore: 0, urlRefTemplatePollutionScore: 0, titleOnlyRatio: 0, excerptProvenanceAvailability: 0, cleanTextAvailability: 0, directSourceSpanAvailability: 0, recommendedImportClass: "quarantine_profile_excerpts" };
  const excerpts = profile.fileEvidence?.map(item => item.excerpt ?? "").filter(Boolean) ?? [];
  const text = excerpts.join("\n").slice(0, 200000);
  const markup = scoreMarkers(text, ["{{", "}}", "[[", "]]", "|", "==", "<ref", "</ref"]);
  const pollution = scoreMarkers(text, ["http://", "https://", "{{", "<ref", "infobox", "cite"]);
  const evidence = profile.fileEvidence ?? [];
  const exact = evidence.filter(hasExactProfileSourceSpan).length;
  const sourced = evidence.filter(hasProfileSourceIdentity).length;
  const titleTokens = topCount(profile.tokenizationProfile?.observedTitleTokens);
  const observedTokens = topCount(profile.tokenizationProfile?.observedSymbols ?? profile.tokenizationProfile?.observedTokens);
  const titleOnlyRatio = observedTokens > 0 ? clamp01(titleTokens / Math.max(1, observedTokens)) : titleTokens ? 1 : 0;
  const clean = text ? clamp01(1 - Math.max(markup, pollution)) : 0;
  return {
    rawWikiMarkupScore: markup,
    urlRefTemplatePollutionScore: pollution,
    titleOnlyRatio,
    excerptProvenanceAvailability: evidence.length ? sourced / evidence.length : 0,
    cleanTextAvailability: clean,
    directSourceSpanAvailability: evidence.length ? exact / evidence.length : 0,
    recommendedImportClass: exact > 0 ? "profile_excerpt_evidence" : markup > 0.15 || pollution > 0.08 ? "quarantine_profile_excerpts" : "learned_language_prior"
  };
}

function hasProfileSourceIdentity(item: Scce2ProfileFileEvidence): boolean {
  return Boolean(item.sourceVersionId || item.originalSourceVersionId || item.uri || item.canonicalUri || item.sourceUri || item.originalSourceUri || item.url || item.revisionId || item.contentHash);
}

function hasExactProfileSourceSpan(item: Scce2ProfileFileEvidence): boolean {
  if (!hasProfileSourceIdentity(item)) return false;
  const hasRange = validRange(item.byteRange) || validRange(item.charRange) || validRange(item.originalByteRange) || validRange(item.originalCharRange);
  const hasStartEnd = numberPair(item.byteStart, item.byteEnd) || numberPair(item.charStart, item.charEnd);
  return hasRange || hasStartEnd;
}

function validRange(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(Number(value[0])) && Number.isFinite(Number(value[1])) && Number(value[1]) > Number(value[0]);
}

function numberPair(start: unknown, end: unknown): boolean {
  return Number.isFinite(Number(start)) && Number.isFinite(Number(end)) && Number(end) > Number(start);
}

function profileQualityWarnings(quality: V2ProfileInspection["qualityGate"]): string[] {
  const warnings: string[] = [];
  if (quality.directSourceSpanAvailability === 0) warnings.push("profile excerpts have no exact source/span coverage and cannot become direct evidence");
  if (quality.recommendedImportClass === "quarantine_profile_excerpts") warnings.push("profile excerpt material is dirty or under-provenanced; import only safe language statistics");
  return warnings;
}

function scoreMarkers(text: string, markers: string[]): number {
  if (!text) return 0;
  let hits = 0;
  const lower = text.toLocaleLowerCase();
  for (const marker of markers) {
    let index = lower.indexOf(marker.toLocaleLowerCase());
    while (index >= 0) {
      hits++;
      index = lower.indexOf(marker.toLocaleLowerCase(), index + marker.length);
    }
  }
  return clamp01(hits / Math.max(1, Math.floor(text.length / 80)));
}

function isConceptGraphPath(parts: string[], base: string, header: string): boolean {
  if (base.endsWith(".v8") && (base.startsWith("shard-") || base.endsWith("concept-graph.v8") || base === "wiki-concept-graph.v8")) return true;
  return header.includes("SCCECGV8") || (parts.includes("brain-shards") && base.endsWith(".v8"));
}

function isLanguageProfilePath(parts: string[], base: string, header: string): boolean {
  if (base.endsWith(".profile.json") || (base.startsWith("language-shard-") && base.endsWith(".json"))) return true;
  return header.includes("learnedlanguageprofileshard") || header.includes("tokenizationprofile") || parts.includes("language-profiles");
}

function isNgramPath(parts: string[], base: string, header: string): boolean {
  if (header.includes("SCCEV8")) return true;
  if (parts.includes("ngram")) return true;
  return [
    "prose.bin",
    "prose.v8",
    "code.bin",
    "code.v8",
    "hexagram-prose.bin",
    "hexagram-prose.v8",
    "hexagram-code.bin",
    "hexagram-code.v8",
    "ngram.bin",
    "ngram.v8",
    "hexagram.bin",
    "hexagram.v8"
  ].includes(base);
}

function isCodeNgramPath(parts: string[], base: string): boolean {
  return base.includes("code") || parts.includes("code") || parts.includes("program");
}

function isStreamCorpusPath(parts: string[], base: string, header: string): boolean {
  const hasWiki = parts.includes("wiki-stream") || base.includes("enwiki") || base.includes("pages-articles") || base.includes("multistream");
  if (base.endsWith(".xml.bz2") && hasWiki) return true;
  if (base.includes("streamfile") || base.includes("corpus-stream")) return true;
  return header.includes("<mediawiki") || header.includes("<page>");
}

function isStreamLookupPath(parts: string[], base: string, header: string): boolean {
  const lookupName = base.includes("lookup") || base.includes("index") || base.includes("offset") || base.includes("title");
  const wikiIndex = base.includes("enwiki") && base.includes("index");
  const streamPart = parts.includes("wiki-stream") || parts.includes("stream") || parts.includes("lookup");
  if ((lookupName || wikiIndex) && (streamPart || base.endsWith(".idx") || base.endsWith(".txt") || base.endsWith(".jsonl") || base.endsWith(".bz2"))) return true;
  return header.includes("pageId") && header.includes("offset") || header.includes("title") && header.includes("revision");
}

function detectedSchemaFromHeader(header: string): string | undefined {
  const trimmed = header.trimStart();
  if (!trimmed.startsWith("{")) return undefined;
  try {
    const parsed = JSON.parse(trimmed.slice(0, Math.max(1, trimmed.lastIndexOf("}") + 1))) as Record<string, unknown>;
    return typeof parsed.schema === "string" ? parsed.schema : undefined;
  } catch {
    return undefined;
  }
}

function headerSignature(header: string): string | undefined {
  if (!header) return undefined;
  const visible = header
    .slice(0, 64)
    .split("")
    .map(ch => {
      const code = ch.charCodeAt(0);
      return code >= 32 && code <= 126 ? ch : ".";
    })
    .join("");
  return visible.trim() || undefined;
}

function recordCountEstimate(kind: V2ArtifactKind, header: string): number | undefined {
  if (!header) return undefined;
  if (kind === "v2_language_profile") {
    try {
      const parsed = JSON.parse(header.slice(0, Math.max(1, header.lastIndexOf("}") + 1))) as Scce2LanguageProfileShard;
      return (parsed.fileEvidence?.length ?? 0) + topCount(parsed.tokenizationProfile?.observedSymbols ?? parsed.tokenizationProfile?.observedTokens);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function namesOf(names: unknown): string[] {
  if (names instanceof Set) return [...names].map(String);
  if (Array.isArray(names)) return names.map(String);
  if (typeof names === "string") return [names];
  return [];
}

function topCount(items: unknown): number {
  return Array.isArray(items) ? items.length : 0;
}

function pathParts(filePath: string): string[] {
  return path.normalize(filePath).split(path.sep).map(part => part.toLocaleLowerCase()).filter(Boolean);
}

function lowerBase(filePath: string): string {
  return path.basename(filePath).toLocaleLowerCase();
}

function ngramModelIdFromPath(filePath: string): string {
  return path.basename(filePath).replaceAll(".", "-").toLocaleLowerCase();
}

function countBy(values: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

async function readJsonOrNull<T>(filePath: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(filePath, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function asPostgresLike(storage: ScceStorage): { query<T>(sql: string, params?: unknown[]): Promise<T[]>; table(name: string): string } | undefined {
  const candidate = storage as unknown as { query?<T>(sql: string, params?: unknown[]): Promise<T[]>; table?(name: string): string };
  return candidate.query && candidate.table ? { query: candidate.query.bind(candidate), table: candidate.table.bind(candidate) } : undefined;
}

async function maybeTableCounts(storage: ScceStorage, tableNames: string[], warnings: string[]): Promise<Record<string, number> | undefined> {
  const pg = asPostgresLike(storage);
  if (!pg) return undefined;
  const counts: Record<string, number> = {};
  for (const table of tableNames) {
    try {
      const rows = await pg.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM ${pg.table(table)}`);
      counts[table] = Number(rows[0]?.count ?? 0);
    } catch (error) {
      warnings.push(`count failed for ${table}: ${messageOf(error)}`);
    }
  }
  return counts;
}

function emptyTopicInspection(topic: string, warnings: string[]): V2TopicInspection {
  return {
    schema: "scce.v2Topic.inspect.v1",
    topic,
    exactMatch: false,
    fuzzyMatch: false,
    nodeCount: 0,
    topLabels: [],
    topRelations: [],
    answerGradeEdgeCount: 0,
    weakFragmentEdgeCount: 0,
    categoryEdgeCount: 0,
    noisyEdgeCount: 0,
    topAnswerGradeRelations: [],
    topRejectedRelations: [],
    questionRequestedSlotIds: [],
    questionCognitiveEdgeCount: 0,
    questionSelectedEdgeCount: 0,
    questionSupportMass: 0,
    questionMissingRequestedSlots: [],
    topQuestionFits: [],
    questionRejectedFits: [],
    directEvidenceCount: 0,
    learnedGraphPriorCount: 0,
    profileExcerptCount: 0,
    languagePriorCount: 0,
    relevanceGateDecisionPreview: QUESTION_EDGE_DECISION_IDS.insufficientSupport,
    warnings
  };
}

function summarizeLedgerRecord(row: BrainImportLedgerRecord): JsonValue {
  const nodeIds = Array.isArray(row.nodeIds) ? row.nodeIds : [];
  const evidenceIds = Array.isArray(row.evidenceIds) ? row.evidenceIds : [];
  const warnings = Array.isArray(row.warnings) ? row.warnings : [];
  return toJsonValue({
    id: row.id,
    importRunId: row.importRunId,
    brainVersion: row.brainVersion,
    sectionId: row.sectionId,
    sectionKind: row.sectionKind,
    forceClass: row.forceClass,
    sourcePath: row.sourcePath ?? null,
    fileHash: row.fileHash ?? null,
    shardHash: row.shardHash ?? null,
    sourceVersionId: row.sourceVersionId ?? null,
    rowCounts: row.rowCounts,
    nodeIdCount: nodeIds.length,
    evidenceIdCount: evidenceIds.length,
    warningCount: warnings.length,
    importedAt: row.importedAt
  });
}

function topLabelsFromNodeRows(rows: Array<{ representation_json: unknown; metadata_json: unknown }>): string[] {
  const labels: string[] = [];
  for (const row of rows) {
    labels.push(...stringsFromUnknown(row.representation_json).slice(0, 4));
    labels.push(...stringsFromUnknown(row.metadata_json).slice(0, 2));
  }
  return unique(labels.filter(item => item.length > 1)).slice(0, 32);
}

function stringsFromUnknown(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringsFromUnknown);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const preferred = ["label", "name", "title", "id", "subject", "predicate", "object", "source", "target"];
    const out: string[] = [];
    for (const key of preferred) out.push(...stringsFromUnknown(record[key]));
    return out;
  }
  return [];
}

function relationFromMetadata(edgeId: string, relationId: string, metadata: unknown, weight?: number, alpha?: number): V2TopicRelationInspection | undefined {
  if (!metadata || typeof metadata !== "object") return undefined;
  const record = metadata as Record<string, unknown>;
  const relation = record.relation && typeof record.relation === "object" ? record.relation as Record<string, unknown> : record;
  const subject = firstString(relation, ["subject", "source", "from"]);
  const predicate = firstString(relation, ["predicate", "relation", "type"]);
  const object = firstString(relation, ["object", "target", "to"]);
  if (!subject || !predicate || !object) return undefined;
  const forceClass = typeof record.forceClass === "string" ? record.forceClass : typeof record.provenanceClass === "string" ? record.provenanceClass : undefined;
  const quality = scoreGraphEdgeQuality({ edgeId, relationId, subject, predicate, object, weight, alpha, forceClass });
  return { edgeId, relationId, subject, predicate, object, weight, alpha, forceClass, quality };
}

function firstString(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
