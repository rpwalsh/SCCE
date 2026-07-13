import type {
  ContentHash,
  EvidenceId,
  JsonValue,
  NodeId,
  SourceId,
  SourceVersionId
} from "./types.js";

export type BrainShardProvenanceClass =
  | "direct_evidence"
  | "profile_excerpt_evidence"
  | "learned_language_prior"
  | "learned_concept_prior"
  | "learned_program_prior"
  | "unknown_prior";

export interface BrainShardSourceRef {
  namespace: string;
  canonicalUri: string;
  sourceId?: SourceId;
  sourceVersionId?: SourceVersionId;
  contentHash?: ContentHash;
  mediaType?: string;
  byteLength?: number;
  observedAt?: number;
  trust?: number;
  metadata?: JsonValue;
}

export interface BrainShardGraphShard {
  shardId: string;
  snapshotPath: string;
  format?: "scce2_concept_v8" | "scce2_concept_json" | "unknown";
  statsPath?: string;
  pages?: number;
  triples?: number;
  concepts?: number;
  relations?: number;
  byteLength?: number;
  exportedAt?: string;
  readable: boolean;
  error?: string;
  metadata: JsonValue;
}

export interface BrainShardLanguageShard {
  shardId: string;
  profilePath: string;
  pages?: number;
  chars?: number;
  byteLength?: number;
  script?: string;
  languageId?: string;
  confidence?: number;
  observedSymbols?: number;
  titleSymbols?: number;
  punctuationPatterns?: number;
  linePatterns?: number;
  fileEvidence?: number;
  readable: boolean;
  error?: string;
  metadata: JsonValue;
}

export interface BrainShardNgramStateInfo {
  stateId: string;
  path: string;
  format: "scce2_binary" | "scce2_v8" | "scce2_json" | "unknown";
  forceClass?: BrainShardProvenanceClass;
  byteLength: number;
  readable: boolean;
  maxOrder?: number;
  vocabularySize?: number;
  totalUnigrams?: number;
  orders?: Array<{ order: number; contexts: number; continuations: number }>;
  error?: string;
  metadata: JsonValue;
}

export interface BrainShardPriorSectionInfo {
  sectionId: string;
  path: string;
  sectionKind: "brain_bundle" | "primitives" | "templates" | "mouth" | "ngram_shard" | "wiki_stream" | "unknown";
  forceClass: BrainShardProvenanceClass;
  byteLength: number;
  readable: boolean;
  sha256?: string;
  error?: string;
  metadata: JsonValue;
}

export interface BrainShardManifest {
  schema: "scce.brainShardManifest.v3";
  sourceSystem: string;
  sourceId?: string;
  rootPath: string;
  observedAt: number;
  graph?: {
    manifestPath?: string;
    createdAt?: string;
    pagesTrained?: number;
    triplesTotal?: number;
    errors?: number;
    shardCount: number;
    shards: BrainShardGraphShard[];
  };
  language?: {
    manifestPath?: string;
    languageId?: string;
    createdAt?: string;
    pagesTrained?: number;
    charsTrained?: number;
    errors?: number;
    shardCount: number;
    shards: BrainShardLanguageShard[];
  };
  ngramStates: BrainShardNgramStateInfo[];
  priorSections: BrainShardPriorSectionInfo[];
  sourceRefs: BrainShardSourceRef[];
  warnings: string[];
  metadata: JsonValue;
}

export interface BrainShardInspection {
  manifest: BrainShardManifest;
  totalBytes: number;
  importable: {
    graphShards: number;
    languageShards: number;
    ngramStates: number;
    directEvidenceSpans: number;
    profileExcerptEvidenceSpans: number;
    learnedLanguagePriors: number;
    learnedConceptPriors: number;
  };
  warnings: string[];
}

export interface BrainShardImportOptions {
  graphShardLimit?: number;
  languageShardLimit?: number;
  ngramStateLimit?: number;
  ngramObservationLimit?: number;
  graphRelationLimit?: number;
  graphConceptLimit?: number;
  fileEvidenceLimitPerShard?: number;
  trust?: number;
  alpha?: number;
  importDirectEvidence?: boolean;
  importLearnedPriors?: boolean;
  maxStateBytes?: number;
  v8DecodeWorkExtentBytes?: number;
  hashWorkExtentBytes?: number;
  maxHashBytesPerFile?: number;
  heapCheckpointMb?: number;
  stopFile?: string;
  onStatus?: (status: JsonValue) => Promise<void> | void;
  now?: number;
  provenanceClass?: BrainShardProvenanceClass;
}

export interface BrainShardImportCounters {
  sourceVersions: number;
  directEvidenceSpans: number;
  profileExcerptEvidenceSpans?: number;
  graphNodes: number;
  graphEdges: number;
  graphHyperedges: number;
  languageUnits: number;
  languagePatterns: number;
  ngramStates: number;
  ngramObservations: number;
  skipped: number;
}

export interface BrainShardImportWarning {
  path?: string;
  shardId?: string;
  code: string;
  message: string;
}

export interface BrainShardImportResult {
  manifest: BrainShardManifest;
  counters: BrainShardImportCounters;
  importRunId?: string;
  activeBrainVersion?: string;
  sourceVersionIds: SourceVersionId[];
  evidenceIds: EvidenceId[];
  nodeIds: NodeId[];
  warnings: BrainShardImportWarning[];
  stopped?: boolean;
  stopReason?: string;
}

export interface BrainShardReader {
  inspect(rootPath: string): Promise<BrainShardInspection>;
  readManifest(rootPath: string): Promise<BrainShardManifest>;
}

export interface BrainShardImporter extends BrainShardReader {
  import(rootPath: string, options?: BrainShardImportOptions): Promise<BrainShardImportResult>;
}
