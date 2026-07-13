import type {
  ContentHash,
  EvidenceId,
  Hasher,
  JsonValue,
  SourceId,
  SourceVersionId
} from "./types.js";
import { clamp01, entropy, featureSet, mean, toJsonValue, variance } from "./primitives.js";

export type IngestionLaneKind =
  | "bulk_corpus"
  | "search_learning"
  | "connector_memory"
  | "developer_intelligence"
  | "local_engineering_corpus";

export type CorpusAdapterId =
  | "wikimedia_dump"
  | "gutenberg_mirror"
  | "internet_archive_item"
  | "warc_stream"
  | "local_corpus"
  | "scce2_brain_shard"
  | "stack_exchange_dump"
  | "arxiv_bulk"
  | "openalex_dump";

export type DeveloperAdapterId =
  | "local_repo"
  | "github_repo"
  | "software_heritage"
  | "npm_registry"
  | "pypi_registry"
  | "crates_registry"
  | "nuget_registry"
  | "maven_registry"
  | "go_proxy"
  | "microsoft_learn"
  | "docs_git_repo"
  | "arxiv_oai"
  | "arxiv_api"
  | "openalex_api"
  | "semantic_scholar"
  | "crossref"
  | "pubmed"
  | "pmc_open_access";

export type SearchProviderId = "brave" | "bing" | "tavily" | "exa" | "serpapi" | "enterprise" | "local_index";
export type ConnectorAdapterId = "outlook" | "github" | "youtube" | "phone_transcript" | "local_file" | "drive" | "slack" | "teams";

export interface SourceObject {
  lane: IngestionLaneKind;
  adapterId: string;
  namespace: string;
  canonicalUri: string;
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  contentHash: ContentHash;
  mediaType: string;
  byteLength: number;
  bytes?: Uint8Array;
  text?: string;
  trust: number;
  observedAt: number;
  sourceKind: string;
  accessScope: "public" | "owner_private" | "shared" | "licensed" | "unknown";
  provenance: JsonValue;
  license: JsonValue;
  metadata: JsonValue;
}

export interface LearningNeedRef {
  id: string;
  gapKind: "freshness" | "source_discovery" | "field_gap" | "code_gap" | "paper_gap" | "connector_gap";
  objective: string;
  constraints: JsonValue;
  createdAt: number;
}

export interface CorpusManifest {
  id: string;
  adapterId: CorpusAdapterId;
  rootUri: string;
  sourceCount?: number;
  byteCount?: number;
  languages: string[];
  mediaTypes: string[];
  rateLimit: JsonValue;
  license: JsonValue;
  recommendedPlan: JsonValue;
}

export interface CorpusAdapter {
  id: CorpusAdapterId;
  inspect(input: { uri: string; options?: JsonValue }): Promise<CorpusManifest>;
  plan(input: { manifest: CorpusManifest; workExtent: JsonValue }): Promise<CorpusIngestPlan>;
  stream(input: CorpusStreamInput): AsyncIterable<SourceObject>;
}

export interface CorpusIngestPlan {
  id: string;
  lane: "bulk_corpus";
  adapterId: CorpusAdapterId;
  sourceRoot: string;
  concurrency: number;
  checkpointEvery: number;
  sourceVersionPolicy: "hash_bytes" | "commit_tree_blob" | "archive_record";
  produces: ObservationKind[];
  quarantine: boolean;
  audit: JsonValue;
}

export interface CorpusStreamInput {
  plan: CorpusIngestPlan;
  checkpoint?: JsonValue;
}

export interface SearchRequest {
  provider: SearchProviderId;
  learningNeed: LearningNeedRef;
  query: string;
  limit: number;
  domains?: string[];
  recencyDays?: number;
  languageHints?: string[];
}

export interface SearchResultLead {
  id: string;
  provider: SearchProviderId;
  title: string;
  uri: string;
  snippet: string;
  rank: number;
  evidenceStatus: "lead_only";
  fetched: false;
  metadata: JsonValue;
}

export interface SearchResultPage {
  request: SearchRequest;
  leads: SearchResultLead[];
  fetchedSourceObjects: [];
  audit: JsonValue;
}

export interface SearchAdapter {
  search(input: SearchRequest): Promise<SearchResultPage>;
}

export interface ConnectorObjectRef {
  connectorId: ConnectorAdapterId;
  objectId: string;
  uri: string;
  modifiedAt?: number;
  metadata: JsonValue;
}

export interface ConnectorSnapshot {
  ref: ConnectorObjectRef;
  sourceObject: SourceObject;
  privacy: {
    accessScope: SourceObject["accessScope"];
    ownerVisible: boolean;
    crossMemoryMergeAllowed: boolean;
  };
}

export interface ConnectorAdapter {
  id: ConnectorAdapterId;
  list(input: { cursor?: string; limit?: number; scope: JsonValue }): Promise<{ refs: ConnectorObjectRef[]; nextCursor?: string }>;
  fetch(ref: ConnectorObjectRef): Promise<ConnectorSnapshot>;
}

export type ObservationKind =
  | "language"
  | "document_structure"
  | "table"
  | "cell"
  | "measurement"
  | "formula"
  | "schema"
  | "time_series"
  | "figure"
  | "log_event"
  | "code"
  | "derived";

export type ObservationForceClass =
  | "direct_evidence"
  | "typed_source_observation"
  | "profile_excerpt_evidence"
  | "learned_language_prior"
  | "learned_concept_prior"
  | "learned_program_prior"
  | "derived_observation"
  | "unknown_prior";

export interface ObservationSourceRef {
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  evidenceIds: EvidenceId[];
}

export interface ObservationBase {
  id: string;
  kind: ObservationKind;
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  evidenceIds: EvidenceId[];
  confidence: number;
  provenance: JsonValue;
  metadata: JsonValue;
  sourceRef?: ObservationSourceRef;
  forceClass?: ObservationForceClass;
}

export interface LanguageObservation extends ObservationBase {
  kind: "language";
  role: "prose" | "dialogue" | "caption" | "note" | "comment" | "heading" | "explanation" | "readme" | "issue" | "instruction";
  text: string;
  languageHint?: string;
  scriptHint?: string;
  features: string[];
}

export interface DocumentStructureObservation extends ObservationBase {
  kind: "document_structure";
  structureKind: "section" | "heading" | "paragraph" | "reference" | "footnote" | "page" | "appendix";
  title?: string;
  ordinal?: number;
  pageRange?: [number, number];
  parentId?: string;
  textPreview?: string;
}

export interface TableObservation extends ObservationBase {
  kind: "table";
  datasetId: string;
  tableId: string;
  title?: string;
  sheet?: string;
  rowRange: [number, number];
  columnRange: [number, number];
  headers: string[];
}

export interface CellObservation extends ObservationBase {
  kind: "cell";
  datasetId: string;
  tableId: string;
  row: number;
  column: number;
  address?: string;
  header?: string;
  rawValue: JsonValue;
  displayValue: string;
  formulaRef?: string;
}

export interface MeasurementObservation extends ObservationBase {
  kind: "measurement";
  datasetId: string;
  tableId?: string;
  measurementId: string;
  value: number;
  unit?: string;
  tolerance?: number;
  timestamp?: string;
  sensor?: string;
  row?: number;
  column?: number;
}

export interface FormulaObservation extends ObservationBase {
  kind: "formula";
  datasetId: string;
  tableId: string;
  cellAddress: string;
  formula: string;
  dependencies: string[];
  computedValue: JsonValue;
}

export interface SchemaObservation extends ObservationBase {
  kind: "schema";
  datasetId: string;
  tableId: string;
  columns: ColumnProfile[];
  keyCandidates: string[];
  joinCandidates: Array<{ leftColumn: string; rightDataset?: string; rightTable?: string; rightColumn?: string; confidence: number }>;
}

export interface TimeSeriesObservation extends ObservationBase {
  kind: "time_series";
  datasetId: string;
  tableId?: string;
  seriesId: string;
  timestampColumn?: string;
  valueColumn: string;
  points: Array<{ t: string | number; value: number; provenanceRef?: string }>;
  unit?: string;
}

export interface FigureObservation extends ObservationBase {
  kind: "figure";
  figureId: string;
  caption?: string;
  page?: number;
  boundingBox?: { x: number; y: number; width: number; height: number };
  extractedLabels: string[];
}

export interface LogEventObservation extends ObservationBase {
  kind: "log_event";
  streamId: string;
  sequence: number;
  timestamp?: string;
  severity?: string;
  component?: string;
  message: string;
  attributes: Record<string, JsonValue>;
}

export interface CodeObservation extends ObservationBase {
  kind: "code";
  repoId?: string;
  filePath: string;
  language?: string;
  symbolGraph: JsonValue;
  dependencyGraph: JsonValue;
  testGraph?: JsonValue;
  buildGraph?: JsonValue;
  programGraph?: JsonValue;
}

export interface DerivedObservation extends ObservationBase {
  kind: "derived";
  derivedKind: "column_profile" | "aggregate" | "anomaly" | "unit_candidate" | "schema_candidate" | "forecast";
  derivedFromObservationIds: string[];
  claim: JsonValue;
  calculation: JsonValue;
}

export type Observation =
  | LanguageObservation
  | DocumentStructureObservation
  | TableObservation
  | CellObservation
  | MeasurementObservation
  | FormulaObservation
  | SchemaObservation
  | TimeSeriesObservation
  | FigureObservation
  | LogEventObservation
  | CodeObservation
  | DerivedObservation;

export type ColumnTypeCandidate = "numeric" | "categorical" | "datetime" | "text" | "boolean" | "identifier" | "mixed" | "unknown";

export interface ColumnProfile {
  name: string;
  index: number;
  typeCandidate: ColumnTypeCandidate;
  count: number;
  missingCount: number;
  distinctCount: number;
  min?: number;
  max?: number;
  mean?: number;
  variance?: number;
  quantiles?: { q25: number; q50: number; q75: number };
  topValues: Array<{ value: string; count: number }>;
  unitCandidates: string[];
  parseFailures: number;
  anomalyCandidates: Array<{ row: number; value: JsonValue; reason: string }>;
  naturalLanguageLikelihood: number;
}

export type DataGraphNodeKind =
  | "dataset"
  | "table"
  | "column"
  | "row"
  | "cell"
  | "unit"
  | "measurement"
  | "formula"
  | "derived_observation"
  | "log_event"
  | "log_stream"
  | "schema_candidate"
  | "join_candidate";

export type DataGraphEdgeKind =
  | "dataset_contains_table"
  | "table_has_column"
  | "table_has_row"
  | "row_has_cell"
  | "cell_has_value"
  | "cell_has_formula"
  | "column_has_unit"
  | "measurement_has_unit"
  | "measurement_observed_at"
  | "formula_depends_on_cell"
  | "derived_from_observations"
  | "stream_contains_log_event"
  | "log_event_has_component"
  | "log_event_has_severity"
  | "schema_candidate_for"
  | "join_candidate_between"
  | "document_mentions_dataset"
  | "paragraph_describes_table";

export interface ObservationRoute {
  observationId: string;
  observationKind: ObservationKind;
  durableStores: Array<"evidence" | "language_memory" | "data_graph" | "measurement_graph" | "unit_graph" | "schema_graph" | "computation_graph" | "program_graph" | "forecast_layer" | "event_graph">;
  forbiddenStores: Array<"language_memory" | "data_graph" | "program_graph">;
  graphNodeKinds: string[];
  graphEdgeKinds: string[];
  languageEligible: boolean;
  proofEligible: boolean;
  audit: JsonValue;
}

export interface ObservationContract {
  observationId: string;
  observationKind: ObservationKind;
  sourceRef: ObservationSourceRef;
  forceClass: ObservationForceClass;
  confidence: number;
  languageTraining: { eligible: boolean; blockedStores: string[]; reason: string };
  proofEligibility: { eligible: boolean; reason: string };
  graphIntent: { nodeKinds: string[]; edgeKinds: string[] };
  durableStores: ObservationRoute["durableStores"];
  forbiddenStores: ObservationRoute["forbiddenStores"];
  provenance: JsonValue;
}

export interface TabularProfileInput {
  datasetId: string;
  tableId: string;
  headers: string[];
  rows: Array<Array<string | number | boolean | null | undefined>>;
  sourceId: SourceId;
  sourceVersionId: SourceVersionId;
  evidenceIds: EvidenceId[];
  provenance: JsonValue;
  hasher: Hasher;
}

export interface TabularProfileResult {
  schema: SchemaObservation;
  measurements: MeasurementObservation[];
  derived: DerivedObservation[];
  languageObservations: LanguageObservation[];
  routes: ObservationRoute[];
}

export function routeObservation(observation: Observation): ObservationRoute {
  const stores = new Set<ObservationRoute["durableStores"][number]>(["evidence"]);
  const forbidden = new Set<ObservationRoute["forbiddenStores"][number]>();
  const nodes: string[] = [];
  const edges: string[] = [];
  let languageEligible = false;
  let proofEligible = true;

  switch (observation.kind) {
    case "language":
      stores.add("language_memory");
      nodes.push("semantic_frame_candidate");
      edges.push("span_expresses_frame");
      languageEligible = true;
      break;
    case "document_structure":
      nodes.push("document_section");
      edges.push("section_contains_span");
      if (observation.textPreview && likelyNaturalLanguage(observation.textPreview) > 0.35) stores.add("language_memory");
      languageEligible = Boolean(observation.textPreview && likelyNaturalLanguage(observation.textPreview) > 0.35);
      break;
    case "table":
      stores.add("data_graph");
      stores.add("schema_graph");
      forbidden.add("language_memory");
      nodes.push("dataset", "table", "column");
      edges.push("dataset_contains_table", "table_has_column");
      break;
    case "cell":
      stores.add("data_graph");
      nodes.push("cell");
      edges.push("row_has_cell", "cell_has_value");
      if (cellMayContainLanguage(observation)) {
        stores.add("language_memory");
        languageEligible = true;
      } else {
        forbidden.add("language_memory");
      }
      break;
    case "measurement":
      stores.add("measurement_graph");
      stores.add("unit_graph");
      stores.add("forecast_layer");
      forbidden.add("language_memory");
      nodes.push("measurement", "unit");
      edges.push("measurement_has_unit", "measurement_observed_at");
      break;
    case "formula":
      stores.add("computation_graph");
      stores.add("data_graph");
      forbidden.add("language_memory");
      nodes.push("formula");
      edges.push("cell_has_formula", "formula_depends_on_cell");
      break;
    case "schema":
      stores.add("schema_graph");
      stores.add("data_graph");
      forbidden.add("language_memory");
      nodes.push("schema_candidate", "column");
      edges.push("schema_candidate_for");
      break;
    case "time_series":
      stores.add("measurement_graph");
      stores.add("forecast_layer");
      forbidden.add("language_memory");
      nodes.push("measurement", "derived_observation");
      edges.push("measurement_observed_at", "derived_from_observations");
      break;
    case "figure":
      nodes.push("figure");
      edges.push("section_contains_span");
      if (observation.caption && likelyNaturalLanguage(observation.caption) > 0.35) {
        stores.add("language_memory");
        languageEligible = true;
      }
      break;
    case "log_event":
      stores.add("event_graph");
      forbidden.add("language_memory");
      nodes.push("log_stream", "log_event");
      edges.push("stream_contains_log_event");
      if (observation.component) edges.push("log_event_has_component");
      if (observation.severity) edges.push("log_event_has_severity");
      proofEligible = Boolean(observation.timestamp || observation.message);
      break;
    case "code":
      stores.add("program_graph");
      forbidden.add("data_graph");
      nodes.push("repo", "file", "symbol", "dependency", "program");
      edges.push("file_defines_symbol", "symbol_depends_on_symbol", "program_uses_dependency");
      break;
    case "derived":
      stores.add(observation.derivedKind === "forecast" ? "forecast_layer" : "data_graph");
      if (observation.derivedKind === "unit_candidate") stores.add("unit_graph");
      forbidden.add("language_memory");
      nodes.push("derived_observation");
      edges.push("derived_from_observations");
      proofEligible = observation.derivedFromObservationIds.length > 0;
      break;
  }

  return {
    observationId: observation.id,
    observationKind: observation.kind,
    durableStores: [...stores],
    forbiddenStores: [...forbidden],
    graphNodeKinds: nodes,
    graphEdgeKinds: edges,
    languageEligible,
    proofEligible,
    audit: toJsonValue({
      sourceVersionId: observation.sourceVersionId,
      evidenceIds: observation.evidenceIds,
      confidence: observation.confidence,
      provenance: observation.provenance
    })
  };
}

export function observationContract(observation: Observation): ObservationContract {
  const route = routeObservation(observation);
  const languageBlocked = route.forbiddenStores.includes("language_memory");
  const forceClass = observation.forceClass ?? (observation.kind === "derived" ? "derived_observation" : "typed_source_observation");
  return {
    observationId: observation.id,
    observationKind: observation.kind,
    sourceRef: observation.sourceRef ?? { sourceId: observation.sourceId, sourceVersionId: observation.sourceVersionId, evidenceIds: observation.evidenceIds },
    forceClass,
    confidence: observation.confidence,
    languageTraining: {
      eligible: route.languageEligible,
      blockedStores: languageBlocked ? ["language_memory"] : [],
      reason: route.languageEligible ? "typed observation carries language-bearing text" : languageBlocked ? "typed numeric, log, schema, formula, or program material is not raw language training" : "no language-bearing field selected"
    },
    proofEligibility: {
      eligible: route.proofEligible,
      reason: route.proofEligible ? "observation is anchored to source/evidence provenance" : "derived observation lacks source observation support"
    },
    graphIntent: { nodeKinds: route.graphNodeKinds, edgeKinds: route.graphEdgeKinds },
    durableStores: route.durableStores,
    forbiddenStores: route.forbiddenStores,
    provenance: observation.provenance
  };
}

export function profileTabularObservations(input: TabularProfileInput): TabularProfileResult {
  const columns = input.headers.map((raw, index) => profileColumn(input.rows, raw || `column_${index + 1}`, index));
  const schemaId = observationId(input.hasher, "schema", input.datasetId, input.tableId, columns.map(c => [c.name, c.typeCandidate, c.distinctCount]));
  const schema: SchemaObservation = {
    id: schemaId,
    kind: "schema",
    sourceId: input.sourceId,
    sourceVersionId: input.sourceVersionId,
    evidenceIds: input.evidenceIds,
    confidence: Math.min(0.98, 0.45 + columns.filter(c => c.typeCandidate !== "unknown").length / Math.max(1, columns.length) * 0.45),
    provenance: input.provenance,
    metadata: toJsonValue({ lane: "local_engineering_corpus", typed: true }),
    datasetId: input.datasetId,
    tableId: input.tableId,
    columns,
    keyCandidates: columns.filter(isLikelyKey).map(c => c.name),
    joinCandidates: []
  };

  const measurements: MeasurementObservation[] = [];
  const derived: DerivedObservation[] = [];
  const languageObservations: LanguageObservation[] = [];
  for (const column of columns) {
    if (column.typeCandidate === "numeric") {
      const unit = column.unitCandidates[0];
      const values = input.rows.map((row, rowIndex) => ({ value: parseNumeric(row[column.index]), rowIndex })).filter((item): item is { value: number; rowIndex: number } => typeof item.value === "number");
      for (const item of values.slice(0, 10000)) {
        measurements.push({
          id: observationId(input.hasher, "measurement", input.datasetId, input.tableId, column.name, item.rowIndex, item.value),
          kind: "measurement",
          sourceId: input.sourceId,
          sourceVersionId: input.sourceVersionId,
          evidenceIds: input.evidenceIds,
          confidence: 0.72,
          provenance: input.provenance,
          metadata: toJsonValue({ column: column.name, source: "typed_tabular_profile" }),
          datasetId: input.datasetId,
          tableId: input.tableId,
          measurementId: `${input.tableId}:${column.name}:${item.rowIndex}`,
          value: item.value,
          unit,
          row: item.rowIndex + 1,
          column: column.index + 1
        });
      }
      derived.push({
        id: observationId(input.hasher, "derived_column_profile", input.datasetId, input.tableId, column.name),
        kind: "derived",
        sourceId: input.sourceId,
        sourceVersionId: input.sourceVersionId,
        evidenceIds: input.evidenceIds,
        confidence: 0.74,
        provenance: input.provenance,
        metadata: toJsonValue({ derivedFrom: "column_profile", languageTraining: false }),
        derivedKind: "column_profile",
        derivedFromObservationIds: measurements.filter(m => m.tableId === input.tableId && m.column === column.index + 1).slice(0, 2000).map(m => m.id),
        claim: toJsonValue({ tableId: input.tableId, column: column.name, typeCandidate: column.typeCandidate, stats: column }),
        calculation: toJsonValue({ method: "single_pass_numeric_profile", aggregateIsDerivedEvidence: true })
      });
    }
    if (column.naturalLanguageLikelihood > 0.55) {
      for (let rowIndex = 0; rowIndex < input.rows.length; rowIndex++) {
        const text = String(input.rows[rowIndex]?.[column.index] ?? "").trim();
        if (!text || likelyNaturalLanguage(text) < 0.55) continue;
        languageObservations.push({
          id: observationId(input.hasher, "language_cell", input.datasetId, input.tableId, column.name, rowIndex, text.slice(0, 128)),
          kind: "language",
          sourceId: input.sourceId,
          sourceVersionId: input.sourceVersionId,
          evidenceIds: input.evidenceIds,
          confidence: 0.62,
          provenance: input.provenance,
          metadata: toJsonValue({ tableId: input.tableId, row: rowIndex + 1, column: column.index + 1, languageBearingCell: true }),
          role: "note",
          text,
          features: featureSet(text, 256)
        });
      }
    }
  }
  const observations: Observation[] = [schema, ...measurements, ...derived, ...languageObservations];
  return { schema, measurements, derived, languageObservations, routes: observations.map(routeObservation) };
}

export function classifyIngestionLane(input: { sourceKind?: string; adapterId?: string; mediaType?: string; uri?: string; learningNeed?: LearningNeedRef; accessScope?: SourceObject["accessScope"] }): IngestionLaneKind {
  if (input.learningNeed) return "search_learning";
  const sourceKind = normalizedControlId(input.sourceKind);
  const adapterId = normalizedControlId(input.adapterId);
  const mediaType = normalizedMediaType(input.mediaType);
  const extension = extensionFromUri(input.uri);
  if (input.accessScope === "owner_private" || sourceKind === "connector_memory" || CONNECTOR_ADAPTER_IDS.has(adapterId)) return "connector_memory";
  if (sourceKind === "developer_intelligence" || DEVELOPER_ADAPTER_IDS.has(adapterId) || DEVELOPER_MEDIA_TYPES.has(mediaType) || DEVELOPER_EXTENSIONS.has(extension)) return "developer_intelligence";
  if (sourceKind === "local_engineering_corpus" || LOCAL_ENGINEERING_MEDIA_TYPES.has(mediaType) || LOCAL_ENGINEERING_EXTENSIONS.has(extension)) return "local_engineering_corpus";
  return "bulk_corpus";
}

export function searchLeadToFetchPlan(lead: SearchResultLead, learningNeed: LearningNeedRef): JsonValue {
  return toJsonValue({
    leadId: lead.id,
    uri: lead.uri,
    learningNeed,
    snippetIsEvidence: false,
    requiredNextStep: "fetch_source_snapshot",
    quarantineBeforeUse: true
  });
}

export function assertSearchLeadIsNotEvidence(lead: SearchResultLead): void {
  if (lead.evidenceStatus !== "lead_only" || lead.fetched !== false) throw new Error(`search result ${lead.id} cannot be promoted directly as evidence`);
}

const CONNECTOR_ADAPTER_IDS = new Set<string>([
  "outlook",
  "github",
  "youtube",
  "phone_transcript",
  "local_file",
  "drive",
  "slack",
  "teams"
]);

const DEVELOPER_ADAPTER_IDS = new Set<string>([
  "local_repo",
  "github_repo",
  "software_heritage",
  "npm_registry",
  "pypi_registry",
  "crates_registry",
  "nuget_registry",
  "maven_registry",
  "go_proxy",
  "microsoft_learn",
  "docs_git_repo",
  "arxiv_oai",
  "arxiv_api",
  "openalex_api",
  "semantic_scholar",
  "crossref",
  "pubmed",
  "pmc_open_access"
]);

const DEVELOPER_MEDIA_TYPES = new Set<string>([
  "application/vnd.scce.source-repository",
  "application/vnd.scce.source-code-facts+json",
  "application/vnd.scce.source-repository-facts+json",
  "application/vnd.npm.package+json"
]);

const DEVELOPER_EXTENSIONS = new Set<string>([
  ".c",
  ".cc",
  ".clj",
  ".cljs",
  ".cpp",
  ".cs",
  ".css",
  ".fs",
  ".fsx",
  ".go",
  ".h",
  ".hpp",
  ".html",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".mjs",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx"
]);

const LOCAL_ENGINEERING_MEDIA_TYPES = new Set<string>([
  "text/csv",
  "text/tab-separated-values",
  "application/vnd.ms-excel",
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.scce.workbook+json",
  "application/vnd.scce.measurements+json",
  "application/vnd.scce.engineering-log"
]);

const LOCAL_ENGINEERING_EXTENSIONS = new Set<string>([
  ".csv",
  ".tsv",
  ".xls",
  ".xlsm",
  ".xlsx",
  ".log",
  ".cad",
  ".step",
  ".stp"
]);

function normalizedControlId(value: string | undefined): string {
  return (value ?? "").trim().toLocaleLowerCase();
}

function normalizedMediaType(value: string | undefined): string {
  const raw = (value ?? "").trim().toLocaleLowerCase();
  const semi = raw.indexOf(";");
  return semi >= 0 ? raw.slice(0, semi).trim() : raw;
}

function extensionFromUri(uri: string | undefined): string {
  const normalized = (uri ?? "").split("\\").join("/");
  const withoutQuery = normalized.split("?")[0]?.split("#")[0] ?? "";
  const slash = withoutQuery.lastIndexOf("/");
  const name = slash >= 0 ? withoutQuery.slice(slash + 1) : withoutQuery;
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLocaleLowerCase() : "";
}

function profileColumn(rows: TabularProfileInput["rows"], header: string, index: number): ColumnProfile {
  const values = rows.map(row => row[index]);
  const present = values.filter(value => value !== null && value !== undefined && String(value).trim() !== "");
  const numeric = present.map(parseNumeric);
  const numericValues = numeric.filter((value): value is number => typeof value === "number");
  const datetimes = present.filter(value => isDateLike(String(value))).length;
  const bools = present.filter(value => isBooleanLike(String(value))).length;
  const asText = present.map(value => String(value));
  const distinct = new Set(asText);
  const topValues = [...frequency(asText).entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16).map(([value, count]) => ({ value, count }));
  const unitCandidates = inferUnitCandidates(header, asText);
  const naturalLanguageLikelihood = Math.max(...asText.slice(0, 200).map(likelyNaturalLanguage), 0);
  const typeCandidate = chooseColumnType({ present: present.length, numeric: numericValues.length, datetimes, bools, distinct: distinct.size, naturalLanguageLikelihood });
  const sorted = [...numericValues].sort((a, b) => a - b);
  const m = numericValues.length ? mean(numericValues) : undefined;
  const v = numericValues.length ? variance(numericValues) : undefined;
  return {
    name: header.trim() || `column_${index + 1}`,
    index,
    typeCandidate,
    count: present.length,
    missingCount: values.length - present.length,
    distinctCount: distinct.size,
    min: sorted[0],
    max: sorted[sorted.length - 1],
    mean: m,
    variance: v,
    quantiles: sorted.length ? { q25: quantile(sorted, 0.25), q50: quantile(sorted, 0.5), q75: quantile(sorted, 0.75) } : undefined,
    topValues,
    unitCandidates,
    parseFailures: typeCandidate === "numeric" ? present.length - numericValues.length : 0,
    anomalyCandidates: numericValues.length > 8 && m !== undefined && v !== undefined ? numericAnomalies(values, m, Math.sqrt(Math.max(0, v))) : [],
    naturalLanguageLikelihood
  };
}

function chooseColumnType(input: { present: number; numeric: number; datetimes: number; bools: number; distinct: number; naturalLanguageLikelihood: number }): ColumnTypeCandidate {
  if (input.present === 0) return "unknown";
  const n = input.present;
  if (input.numeric / n > 0.92) return input.distinct === input.present && input.present > 12 ? "identifier" : "numeric";
  if (input.datetimes / n > 0.85) return "datetime";
  if (input.bools / n > 0.9) return "boolean";
  if (input.naturalLanguageLikelihood > 0.55) return "text";
  if (input.distinct <= Math.max(24, Math.sqrt(n) * 2)) return "categorical";
  if (input.numeric / n > 0.25 || input.datetimes / n > 0.25) return "mixed";
  return "text";
}

function parseNumeric(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/,/gu, "").trim();
  if (!/^[-+]?(\d+(\.\d*)?|\.\d+)(e[-+]?\d+)?$/iu.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isDateLike(value: string): boolean {
  if (!value.trim()) return false;
  if (/^\d{4}-\d{2}-\d{2}(?:[t\s]\d{2}:\d{2})?/iu.test(value)) return true;
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}/u.test(value)) return true;
  return false;
}

function isBooleanLike(value: string): boolean {
  return /^(0|1)$/u.test(value.trim());
}

function likelyNaturalLanguage(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length < 12) return 0;
  const letters = (trimmed.match(/\p{Letter}/gu) ?? []).length;
  const digits = (trimmed.match(/\p{Number}/gu) ?? []).length;
  const spaces = (trimmed.match(/\s/gu) ?? []).length;
  const sentenceMarks = (trimmed.match(/[.!?;:]/gu) ?? []).length;
  const symbols = trimmed.match(/[\p{Letter}\p{Number}_'-]+/gu) ?? [];
  const symbolEntropy = entropy([...frequency(symbols.map(symbol => symbol.toLowerCase())).values()]);
  const letterRatio = letters / Math.max(1, trimmed.length);
  const digitRatio = digits / Math.max(1, trimmed.length);
  const spaceRatio = spaces / Math.max(1, trimmed.length);
  const symbolScore = Math.min(1, symbols.length / 18);
  return clamp01(letterRatio * 0.35 + spaceRatio * 0.2 + symbolScore * 0.25 + Math.min(1, sentenceMarks / 2) * 0.1 + Math.min(1, symbolEntropy / 4) * 0.1 - digitRatio * 0.35);
}

function cellMayContainLanguage(cell: CellObservation): boolean {
  if (typeof cell.rawValue === "number" || typeof cell.rawValue === "boolean") return false;
  const headerSignal = cell.header ? likelyNaturalLanguage(cell.header.replace(/[_-]+/gu, " ")) * 0.35 : 0;
  return Math.max(likelyNaturalLanguage(cell.displayValue), headerSignal) > 0.55;
}

function isLikelyKey(column: ColumnProfile): boolean {
  return (column.typeCandidate === "identifier" || /(^id$|_id$|identifier|uuid|guid|serial|part|sku)/iu.test(column.name)) && column.distinctCount >= Math.max(1, column.count - column.missingCount - 1);
}

function inferUnitCandidates(header: string, samples: string[]): string[] {
  const units = new Set<string>();
  const headerUnits = header.match(/\b(psi|kpa|pa|bar|c|f|kg|g|mg|lb|oz|mm|cm|m|km|in|ft|hz|v|a|w|kw|rpm|sec|s|min|hr|ms)\b/giu) ?? [];
  for (const unit of headerUnits) units.add(unit.toLowerCase());
  for (const sample of samples.slice(0, 200)) {
    const match = sample.match(/[-+]?\d+(?:\.\d+)?\s*(psi|kpa|pa|bar|kg|g|mg|lb|mm|cm|m|km|in|ft|hz|v|a|w|kw|rpm|ms|sec|s|min|hr)\b/iu);
    if (match?.[1]) units.add(match[1].toLowerCase());
  }
  return [...units].slice(0, 8);
}

function numericAnomalies(values: Array<string | number | boolean | null | undefined>, m: number, sd: number): ColumnProfile["anomalyCandidates"] {
  if (sd <= 0) return [];
  const out: ColumnProfile["anomalyCandidates"] = [];
  for (let row = 0; row < values.length; row++) {
    const parsed = parseNumeric(values[row]);
    if (typeof parsed !== "number") continue;
    const z = Math.abs((parsed - m) / sd);
    if (z >= 4) out.push({ row: row + 1, value: toJsonValue(values[row]), reason: `z_score_${z.toFixed(2)}` });
    if (out.length >= 32) break;
  }
  return out;
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const a = sorted[base] ?? sorted[sorted.length - 1]!;
  const b = sorted[base + 1] ?? a;
  return a + rest * (b - a);
}

function frequency(values: string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const value of values) out.set(value, (out.get(value) ?? 0) + 1);
  return out;
}

function observationId(hasher: Hasher, ...parts: unknown[]): string {
  return `observation_${hasher.digestHex(JSON.stringify(parts)).slice(0, 40)}`;
}
