import { POSTGRES_REQUIRED_TABLES } from "./storage.js";
import { canonicalStringify, toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

export type SourceCompletionPersistenceStatus = "source_only" | "planned" | "postgres_backed";

export type SourceCompletionFamilyId =
  | "scce2_import_runs"
  | "scce2_shard_sections"
  | "source_versions"
  | "evidence_spans"
  | "force_class_markers"
  | "graph_nodes"
  | "graph_edges"
  | "graph_hyperedges"
  | "graph_learning_reports"
  | "dialogue_state_records"
  | "language_units"
  | "language_patterns"
  | "ngram_observations"
  | "ngram_models"
  | "semantic_frames"
  | "translation_alignments"
  | "correction_rules"
  | "typed_observations"
  | "document_observations"
  | "table_observations"
  | "cell_observations"
  | "formula_observations"
  | "schema_observations"
  | "measurement_observations"
  | "time_series_observations"
  | "figure_observations"
  | "log_observations"
  | "code_observations"
  | "proof_verdicts"
  | "proof_traces"
  | "mouth_traces"
  | "walsh_surface_energy_traces"
  | "field_alpha_ppf_traces"
  | "learning_loop_records"
  | "program_graph_records"
  | "artifact_emission_records"
  | "developer_intelligence_records"
  | "workspace_core_records"
  | "workspace_runtime_records"
  | "source_only_runtime_turn_traces"
  | "runtime_outcome_records"
  | "model_state_markers"
  | "hydration_runs"
  | "hydration_dry_run_plans";

export interface SourceCompletionRecordFamily {
  familyId: SourceCompletionFamilyId;
  recordKindId: string;
  typeScriptTypes: string[];
  typeScriptTypeName: string;
  validationFunctionId: string;
  idempotencyKeyFields: string[];
  destinationStoreId: string;
  destinationTableId?: string;
  repositoryWriteAdapterId: string;
  repositoryReadAdapterId: string;
  inspectVisibilityId: string;
  replayVisibilityId: string;
  sourceProvenanceFields: string[];
  forceClassField?: string;
  dryRunHydrationPlanId: string;
  migrationSchemaSourceId?: string;
  requiredTraceIds: string[];
  requiredRuntimeFields: string[];
  persistenceStatus: SourceCompletionPersistenceStatus;
}

export interface SourceCompletionHydrationStep {
  familyId: SourceCompletionFamilyId;
  destinationStoreId: string;
  destinationTableId?: string;
  persistenceStatus: SourceCompletionPersistenceStatus;
  idempotencyKeyFields: string[];
  dryRunHydrationPlanId: string;
  inspectVisibilityId: string;
  replayVisibilityId: string;
  repositoryWriteAdapterId: string;
  repositoryReadAdapterId: string;
  sourceProvenanceFields: string[];
}

export interface SourceCompletionContract {
  schema: "scce.source_completion.contract.v2";
  id: string;
  families: SourceCompletionRecordFamily[];
  dryRunHydrationPlan: SourceCompletionHydrationStep[];
  diagnostics: string[];
  valid: boolean;
  audit: JsonValue;
}

export interface SourceCompletionValidationResult {
  valid: boolean;
  diagnostics: string[];
  missingFamilies: SourceCompletionFamilyId[];
  invalidFamilies: Array<{ familyId: SourceCompletionFamilyId; diagnostics: string[] }>;
}

export interface SourceCompletionRuntimeCounts {
  scce2ImportRecords?: number;
  scce2ShardSections?: number;
  sourceVersions?: number;
  evidenceSpans?: number;
  forceClasses?: number;
  graphNodes?: number;
  graphEdges?: number;
  graphHyperedges?: number;
  graphLearningReports?: number;
  dialogueStateRecords?: number;
  languageMemoryRecords?: number;
  languageUnits?: number;
  languagePatterns?: number;
  ngramObservations?: number;
  ngramModels?: number;
  semanticFrames?: number;
  translationAlignments?: number;
  correctionRules?: number;
  typedObservations?: number;
  documentObservations?: number;
  tableObservations?: number;
  cellObservations?: number;
  formulaObservations?: number;
  schemaObservations?: number;
  measurementObservations?: number;
  timeSeriesObservations?: number;
  figureObservations?: number;
  logObservations?: number;
  codeObservations?: number;
  workspaceCoreRecords?: number;
  workspaceRuntimeRecords?: number;
  proofTraces?: number;
  proofVerdicts?: number;
  mouthTraces?: number;
  walshSurfaceEnergyTraces?: number;
  fieldAlphaPpfTraces?: number;
  learningLoopRecords?: number;
  programArtifactRecords?: number;
  programGraphRecords?: number;
  artifactEmissionRecords?: number;
  developerIntelligenceRecords?: number;
  runtimeTurnTraces?: number;
  runtimeOutcomeRecords?: number;
  modelStateMarkers?: number;
  hydrationRuns?: number;
  hydrationDryRunPlans?: number;
}

export interface SourceCompletionHydrationRecord {
  familyId: SourceCompletionFamilyId | string;
  record: JsonValue;
  traceIds?: string[];
}

export interface SourceCompletionDryRunAcceptedRecord {
  familyId: SourceCompletionFamilyId;
  recordId: string;
  idempotencyKey: string;
  destinationStoreId: string;
  destinationTableId?: string;
  persistenceStatus: SourceCompletionPersistenceStatus;
  inspectVisibilityId: string;
  replayVisibilityId: string;
}

export interface SourceCompletionDryRunRejectedRecord {
  familyId: string;
  recordId?: string;
  reasonIds: string[];
  missingFields: string[];
}

export interface SourceCompletionIdempotencyConflict {
  familyId: SourceCompletionFamilyId;
  idempotencyKey: string;
  firstRecordId: string;
  duplicateRecordId: string;
}

export interface SourceCompletionHydrationPlan {
  schema: "scce.source_completion.hydration_plan.v1";
  id: string;
  acceptedRecords: SourceCompletionDryRunAcceptedRecord[];
  rejectedRecords: SourceCompletionDryRunRejectedRecord[];
  duplicateIdempotencyConflicts: SourceCompletionIdempotencyConflict[];
  destinationStoreCounts: Record<string, number>;
  destinationTableCounts: Record<string, number>;
  persistenceStatusCounts: Record<SourceCompletionPersistenceStatus, number>;
  estimatedWriteCountsByTable: Record<string, number>;
  warnings: string[];
  unsafeReasons: string[];
  safeToHydrate: boolean;
  audit: JsonValue;
}

export interface SourceCompletionPersistenceCrossCheck {
  valid: boolean;
  diagnostics: string[];
  postgresBackedFamilies: SourceCompletionFamilyId[];
  explicitNonPersistentFamilies: SourceCompletionFamilyId[];
}

export interface SourceCompletionInspectableRecord {
  kind: SourceCompletionFamilyId | string;
  id: string;
  traceId?: string;
  traceIds?: string[];
  value: JsonValue;
}

export interface SourceCompletionTraceLink {
  traceId: string;
  targetKind: SourceCompletionFamilyId | string;
  targetId: string;
  roleId: string;
}

export interface SourceCompletionInspectStore {
  records: SourceCompletionInspectableRecord[];
  links?: SourceCompletionTraceLink[];
}

export interface SourceCompletionInspectResult {
  schema: "scce.source_completion.inspect.v1";
  kind: string;
  id: string;
  found: boolean;
  value?: JsonValue;
  diagnostics: string[];
}

export interface SourceCompletionReplayResult {
  schema: "scce.source_completion.replay.v1";
  traceId: string;
  records: SourceCompletionInspectableRecord[];
  missingLinks: SourceCompletionTraceLink[];
  complete: boolean;
}

export interface SourceCompletionTraceCoverageSummary {
  schema: "scce.source_completion.trace_coverage.v1";
  traceIds: string[];
  linkCount: number;
  resolvedLinkCount: number;
  missingLinks: SourceCompletionTraceLink[];
  complete: boolean;
}

export const SOURCE_COMPLETION_FAMILY_IDS: SourceCompletionFamilyId[] = [
  "scce2_import_runs",
  "scce2_shard_sections",
  "source_versions",
  "evidence_spans",
  "force_class_markers",
  "graph_nodes",
  "graph_edges",
  "graph_hyperedges",
  "graph_learning_reports",
  "dialogue_state_records",
  "language_units",
  "language_patterns",
  "ngram_observations",
  "ngram_models",
  "semantic_frames",
  "translation_alignments",
  "correction_rules",
  "typed_observations",
  "document_observations",
  "table_observations",
  "cell_observations",
  "formula_observations",
  "schema_observations",
  "measurement_observations",
  "time_series_observations",
  "figure_observations",
  "log_observations",
  "code_observations",
  "proof_verdicts",
  "proof_traces",
  "mouth_traces",
  "walsh_surface_energy_traces",
  "field_alpha_ppf_traces",
  "learning_loop_records",
  "program_graph_records",
  "artifact_emission_records",
  "developer_intelligence_records",
  "workspace_core_records",
  "workspace_runtime_records",
  "source_only_runtime_turn_traces",
  "runtime_outcome_records",
  "model_state_markers",
  "hydration_runs",
  "hydration_dry_run_plans"
];

const POSTGRES_TABLES = new Set<string>(POSTGRES_REQUIRED_TABLES);

const FAMILY_DEFINITIONS: SourceCompletionRecordFamily[] = [
  family("scce2_import_runs", "scce2.import_run", ["BrainImportLedgerRecord"], "validateScce2ImportRunRecord", ["importRunId", "brainVersion", "rootPath"], "store.scce2_import_ledger", ["importRunId", "brainVersion", "rootPath"], { destinationTableId: "scce2_import_ledger", forceClassField: "forceClass" }),
  family("scce2_shard_sections", "scce2.shard_section", ["BrainImportLedgerRecord"], "validateScce2ShardSectionRecord", ["importRunId", "sectionId", "fileHash"], "store.scce2_import_ledger", ["importRunId", "sectionId", "sourcePath", "fileHash"], { destinationTableId: "scce2_import_ledger", forceClassField: "forceClass" }),
  family("source_versions", "source.version", ["SourceVersion"], "validateSourceVersion", ["sourceId", "sourceVersionId", "contentHash"], "store.source_versions", ["sourceId", "canonicalUri", "contentHash"], { destinationTableId: "source_versions" }),
  family("evidence_spans", "evidence.span", ["EvidenceSpan"], "validateEvidenceSpan", ["sourceVersionId", "chunkId", "byteStart", "byteEnd"], "store.evidence_spans", ["sourceId", "sourceVersionId", "contentHash", "byteStart", "byteEnd"], { destinationTableId: "evidence_spans", forceClassField: "forceClass" }),
  family("force_class_markers", "force.class_marker", ["BrainShardProvenanceClass"], "validateForceClassMarker", ["id", "forceClass"], "store.model_state", ["id", "forceClass", "sourceVersionId", "evidenceSpanId"], { destinationTableId: "model_state", forceClassField: "forceClass" }),
  family("graph_nodes", "graph.node", ["GraphNode"], "validateGraphNode", ["id", "typeId"], "store.graph_nodes", ["id", "evidenceIds", "metadata"], { destinationTableId: "graph_nodes", forceClassField: "forceClass" }),
  family("graph_edges", "graph.edge", ["GraphEdge"], "validateGraphEdge", ["id", "source", "target", "relationId"], "store.graph_edges", ["id", "source", "target", "evidenceIds"], { destinationTableId: "graph_edges", forceClassField: "forceClass" }),
  family("graph_hyperedges", "graph.hyperedge", ["Hyperedge"], "validateGraphHyperedge", ["id", "relationId", "memberNodeIds"], "store.graph_hyperedges", ["id", "memberNodeIds", "provenanceRefs"], { destinationTableId: "graph_hyperedges", forceClassField: "forceClass" }),
  plannedFamily("graph_learning_reports", "graph.learning_report", ["RuntimeGraphLearningReport"], "validateRuntimeGraphLearningReport", ["id", "schema", "trainingStatus"], "store.graph_learning_reports", ["id", "model", "linkPrediction"], { requiredTraceIds: ["graphLearningReportId"] }),
  plannedFamily("dialogue_state_records", "dialogue.state_record", ["DialogueState", "DialoguePolicyDecision", "DialoguePragmaticsResult"], "validateDialogueStateRecord", ["conversationId", "turnId"], "store.dialogue_memory", ["conversationId", "turnId", "userStyleProfile"], { requiredTraceIds: ["dialogueStateId"] }),
  family("language_units", "language.unit", ["LanguageUnitRecord"], "validateLanguageUnitRecord", ["id", "profileId", "sourceVersionId"], "store.language_units", ["id", "profileId", "sourceVersionId", "evidenceIds"], { destinationTableId: "language_units", forceClassField: "forceClass" }),
  family("language_patterns", "language.pattern", ["LanguagePatternRecord"], "validateLanguagePatternRecord", ["id", "profileId", "patternKind"], "store.language_patterns", ["id", "profileId", "evidenceIds"], { destinationTableId: "language_patterns", forceClassField: "forceClass" }),
  family("ngram_observations", "language.ngram_observation", ["NgramObservation"], "validateNgramObservation", ["id", "streamId", "order", "symbol"], "store.ngram_observations", ["id", "streamId", "sourceVersionId", "evidenceId"], { destinationTableId: "ngram_observations", forceClassField: "forceClass" }),
  family("ngram_models", "language.ngram_model", ["NgramModelRecord"], "validateNgramModelRecord", ["id", "streamId", "maxOrder"], "store.ngram_models", ["id", "streamId", "modelHash"], { destinationTableId: "ngram_models", forceClassField: "forceClass" }),
  family("semantic_frames", "language.semantic_frame", ["SemanticFrameRecord"], "validateSemanticFrameRecord", ["id", "frameHash"], "store.semantic_frames", ["id", "evidenceIds", "alpha"], { destinationTableId: "semantic_frames", forceClassField: "forceClass" }),
  family("translation_alignments", "language.translation_alignment", ["TranslationAlignmentRecord"], "validateTranslationAlignmentRecord", ["id", "sourceFrameId", "targetFrameId"], "store.translation_alignments", ["id", "sourceFrameId", "targetFrameId", "evidenceIds"], { destinationTableId: "translation_alignments", forceClassField: "forceClass" }),
  family("correction_rules", "correction.rule", ["CorrectionRuleRecord"], "validateCorrectionRuleRecord", ["id", "episodeId", "ruleKind"], "store.correction_rules", ["id", "episodeId", "provenanceJson"], { destinationTableId: "correction_rules" }),
  plannedFamily("typed_observations", "typed.observation", ["Observation"], "validateTypedObservation", ["id", "kind", "sourceVersionId"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceIds", "provenance"], { forceClassField: "forceClass" }),
  plannedFamily("document_observations", "typed.document_observation", ["DocumentObservation"], "validateDocumentObservation", ["id", "sourceVersionId", "documentKind"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceIds"], { forceClassField: "forceClass" }),
  plannedFamily("table_observations", "typed.table_observation", ["TableObservation"], "validateTableObservation", ["id", "sourceVersionId", "tableId"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceIds"], { forceClassField: "forceClass" }),
  plannedFamily("cell_observations", "typed.cell_observation", ["CellObservation"], "validateCellObservation", ["id", "sourceVersionId", "cellId"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceIds"], { forceClassField: "forceClass" }),
  plannedFamily("formula_observations", "typed.formula_observation", ["FormulaObservation"], "validateFormulaObservation", ["id", "sourceVersionId", "formulaId"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceIds"], { forceClassField: "forceClass" }),
  plannedFamily("schema_observations", "typed.schema_observation", ["SchemaObservation"], "validateSchemaObservation", ["id", "sourceVersionId", "schemaId"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceIds"], { forceClassField: "forceClass" }),
  plannedFamily("measurement_observations", "typed.measurement_observation", ["MeasurementObservation"], "validateMeasurementObservation", ["id", "sourceVersionId", "subjectId", "relationId"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceSpanId"], { forceClassField: "forceClass" }),
  plannedFamily("time_series_observations", "typed.time_series_observation", ["TimeSeriesObservation"], "validateTimeSeriesObservation", ["id", "sourceVersionId", "seriesId"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceIds"], { forceClassField: "forceClass" }),
  plannedFamily("figure_observations", "typed.figure_observation", ["FigureObservation"], "validateFigureObservation", ["id", "sourceVersionId", "figureId"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceIds"], { forceClassField: "forceClass" }),
  plannedFamily("log_observations", "typed.log_observation", ["LogEventObservation"], "validateLogObservation", ["id", "sourceVersionId", "componentId", "dateTime"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceSpanId"], { forceClassField: "forceClass" }),
  plannedFamily("code_observations", "typed.code_observation", ["CodeObservation"], "validateCodeObservation", ["id", "sourceVersionId", "filePath"], "store.typed_observation_projection", ["id", "sourceVersionId", "evidenceSpanId"], { forceClassField: "forceClass" }),
  family("proof_verdicts", "proof.verdict", ["SemanticProofEngineVerdict", "SemanticEntailmentResult"], "validateProofVerdictRecord", ["id", "claimId", "verdict"], "store.semantic_proofs", ["id", "claimId", "certifiedEvidenceIds"], { destinationTableId: "semantic_proofs" }),
  family("proof_traces", "proof.trace", ["SemanticProofResult", "ProofEvidenceRecord"], "validateProofTrace", ["id", "claimId", "verdict"], "store.semantic_proofs", ["id", "claimId", "candidateEvidence", "certifiedEvidenceIds"], { destinationTableId: "semantic_proofs", requiredTraceIds: ["proofTraceId"] }),
  plannedFamily("mouth_traces", "mouth.trace", ["SpokenOutput", "RealizationTrace", "SurfacePlan"], "validateMouthTrace", ["id", "selectedCandidateId", "planHash"], "store.mouth_traces", ["id", "evidenceRefs", "inspectRefs"], { requiredTraceIds: ["mouthTraceId"] }),
  plannedFamily("walsh_surface_energy_traces", "walsh.surface_energy_trace", ["SurfaceEnergyRanking", "SurfaceEnergyExplanation"], "validateWalshSurfaceEnergyTrace", ["id", "candidateId", "energy"], "store.walsh_surface_energy_traces", ["id", "candidateId", "components"], { requiredTraceIds: ["walshSurfaceEnergyTraceId"] }),
  family("field_alpha_ppf_traces", "field.alpha_ppf_trace", ["AlphaTraceRecord", "PpfCacheRecord"], "validateFieldAlphaPpfTrace", ["id", "graphHash", "traceKind"], "store.flow_cache", ["id", "graphHash", "traceJson"], { destinationTableId: "alpha_traces", requiredTraceIds: ["graphAlphaPpfSummaryId"] }),
  family("learning_loop_records", "learning.loop_record", ["LearningLoopResult", "LearningLoopRecord"], "validateLearningLoopRecord", ["id", "recordTypeId", "recordId"], "store.learning_needs", ["id", "episodeId", "provenance", "payloadHash"], { destinationTableId: "learning_needs", requiredTraceIds: ["learningTraceId"] }),
  family("program_graph_records", "program.graph_record", ["ProgramHydrationContract", "ProgramGraphRecord"], "validateProgramGraphRecord", ["id", "programId", "entrypointPath"], "store.construct_graphs", ["id", "programId", "provenanceEvidenceIds"], { destinationTableId: "construct_graphs", requiredTraceIds: ["programGraphId"] }),
  family("artifact_emission_records", "program.artifact_emission", ["ArtifactEmissionRecord"], "validateArtifactEmissionRecord", ["id", "programId", "filePath", "contentHash"], "store.emission_graphs", ["id", "programId", "filePath", "contentHash"], { destinationTableId: "emission_graphs", requiredTraceIds: ["artifactEmissionTraceId"] }),
  plannedFamily("developer_intelligence_records", "developer.intelligence_record", ["RepoSnapshot", "DeveloperIntelligenceHydrationContract"], "validateDeveloperIntelligenceRecord", ["id", "repositoryId", "sourceHash"], "store.developer_intelligence", ["id", "rootUri", "sourceHash", "sourceRef"], { requiredTraceIds: ["developerIntelligenceTraceId"] }),
  family("workspace_core_records", "workspace.core_record", ["WorkspaceCoreRecord", "WorkspaceCoreHydrationContract"], "validateWorkspaceCoreRecord", ["id", "workspaceId", "recordType"], "store.workspace_core", ["id", "workspaceId", "corpusId", "sourceRef"], { destinationTableId: "workspace_reports", requiredTraceIds: ["workspaceFusionTraceId"] }),
  family("workspace_runtime_records", "workspace.runtime_record", ["WorkspaceRecord", "WorkspaceSourceFileRecord", "WorkspaceReportRecord"], "validateWorkspaceRuntimeRecord", ["id", "workspaceId", "recordKind"], "store.workspace", ["id", "workspaceId", "rootUri", "sourceRefs"], { destinationTableId: "workspaces", requiredTraceIds: ["workspaceRuntimeTraceId"] }),
  plannedFamily("source_only_runtime_turn_traces", "runtime.source_only_turn_trace", ["ScceRuntimeTurnTrace"], "validateScceRuntimeTurnTrace", ["id", "turnId", "inputId", "constructId"], "store.runtime_turn_traces", ["id", "inputId", "evidenceIds", "sourceRefs"], { requiredTraceIds: ["turnId"] }),
  plannedFamily("runtime_outcome_records", "runtime.outcome_record", ["ScceRuntimeOutcomeResult"], "validateScceRuntimeOutcomeRecord", ["id", "target", "status"], "store.runtime_outcomes", ["id", "target", "calibrationPoints", "reversible"], { requiredTraceIds: ["outcomeId"] }),
  family("model_state_markers", "brain.model_state_marker", ["ModelState", "BrainImportSummary"], "validateModelStateMarker", ["id", "kind", "active"], "store.model_state", ["id", "kind", "activeImportRunIds"], { destinationTableId: "model_state" }),
  family("hydration_runs", "hydration.run", ["HydrationRunRecord"], "validateHydrationRunRecord", ["id", "runId", "contractId"], "store.events", ["id", "runId", "contractId"], { destinationTableId: "events", requiredTraceIds: ["hydrationTraceId"] }),
  plannedFamily("hydration_dry_run_plans", "hydration.dry_run_plan", ["SourceCompletionHydrationPlan"], "validateHydrationDryRunPlan", ["id", "contractId", "planHash"], "store.hydration_plans", ["id", "contractId", "acceptedRecords", "rejectedRecords"], { requiredTraceIds: ["hydrationDryRunTraceId"] })
];

export function sourceCompletionFamilyDefinitions(): SourceCompletionRecordFamily[] {
  return FAMILY_DEFINITIONS.map(item => ({ ...item, typeScriptTypes: [...item.typeScriptTypes], idempotencyKeyFields: [...item.idempotencyKeyFields], sourceProvenanceFields: [...item.sourceProvenanceFields], requiredTraceIds: [...item.requiredTraceIds], requiredRuntimeFields: [...item.requiredRuntimeFields] }));
}

export function createSourceCompletionContract(input: { counts?: SourceCompletionRuntimeCounts; families?: SourceCompletionRecordFamily[] } = {}): SourceCompletionContract {
  const families = input.families ?? sourceCompletionFamilyDefinitions();
  const dryRunHydrationPlan = families.map(item => ({
    familyId: item.familyId,
    destinationStoreId: item.destinationStoreId,
    destinationTableId: item.destinationTableId,
    persistenceStatus: item.persistenceStatus,
    idempotencyKeyFields: [...item.idempotencyKeyFields],
    dryRunHydrationPlanId: item.dryRunHydrationPlanId,
    inspectVisibilityId: item.inspectVisibilityId,
    replayVisibilityId: item.replayVisibilityId,
    repositoryWriteAdapterId: item.repositoryWriteAdapterId,
    repositoryReadAdapterId: item.repositoryReadAdapterId,
    sourceProvenanceFields: [...item.sourceProvenanceFields]
  }));
  const validation = validateSourceCompletionContract({ families, dryRunHydrationPlan });
  return {
    schema: "scce.source_completion.contract.v2",
    id: `source_completion_${hashText(canonicalStringify({ families: families.map(item => item.familyId), counts: input.counts ?? {}, version: 2 })).slice(0, 24)}`,
    families,
    dryRunHydrationPlan,
    diagnostics: validation.diagnostics,
    valid: validation.valid,
    audit: toJsonValue({
      familyCount: families.length,
      counts: input.counts ?? {},
      missingFamilies: validation.missingFamilies,
      invalidFamilies: validation.invalidFamilies,
      persistence: countBy(families.map(item => item.persistenceStatus))
    })
  };
}

export function validateSourceCompletionContract(input: Pick<SourceCompletionContract, "families" | "dryRunHydrationPlan">): SourceCompletionValidationResult {
  const diagnostics: string[] = [];
  const familyIds = new Set(input.families.map(item => item.familyId));
  const missingFamilies = SOURCE_COMPLETION_FAMILY_IDS.filter(id => !familyIds.has(id));
  const invalidFamilies: Array<{ familyId: SourceCompletionFamilyId; diagnostics: string[] }> = [];
  for (const id of missingFamilies) diagnostics.push(`source_completion.family_missing:${id}`);
  const planByFamily = new Map(input.dryRunHydrationPlan.map(item => [item.familyId, item]));
  for (const familyRecord of input.families) {
    const familyDiagnostics = validateFamily(familyRecord, planByFamily.get(familyRecord.familyId));
    if (familyDiagnostics.length) invalidFamilies.push({ familyId: familyRecord.familyId, diagnostics: familyDiagnostics });
    diagnostics.push(...familyDiagnostics);
  }
  const crossCheck = crossCheckSourceCompletionPersistence({ families: input.families });
  diagnostics.push(...crossCheck.diagnostics);
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    missingFamilies,
    invalidFamilies
  };
}

export function crossCheckSourceCompletionPersistence(input: {
  families: readonly SourceCompletionRecordFamily[];
  schemaTables?: readonly string[];
}): SourceCompletionPersistenceCrossCheck {
  const diagnostics: string[] = [];
  const schemaTables = new Set(input.schemaTables ?? [...POSTGRES_TABLES]);
  const postgresBackedFamilies: SourceCompletionFamilyId[] = [];
  const explicitNonPersistentFamilies: SourceCompletionFamilyId[] = [];
  for (const familyRecord of input.families) {
    const prefix = `source_completion.persistence:${familyRecord.familyId}`;
    if (familyRecord.persistenceStatus === "postgres_backed") {
      postgresBackedFamilies.push(familyRecord.familyId);
      if (!familyRecord.destinationTableId) diagnostics.push(`${prefix}:table_missing`);
      else if (!schemaTables.has(familyRecord.destinationTableId)) diagnostics.push(`${prefix}:table_not_in_schema:${familyRecord.destinationTableId}`);
      if (!familyRecord.migrationSchemaSourceId) diagnostics.push(`${prefix}:migration_schema_source_missing`);
      if (!familyRecord.repositoryWriteAdapterId) diagnostics.push(`${prefix}:write_adapter_missing`);
      if (!familyRecord.repositoryReadAdapterId) diagnostics.push(`${prefix}:read_adapter_missing`);
    } else {
      explicitNonPersistentFamilies.push(familyRecord.familyId);
      if (familyRecord.destinationTableId) diagnostics.push(`${prefix}:non_persistent_has_table`);
    }
  }
  return {
    valid: diagnostics.length === 0,
    diagnostics,
    postgresBackedFamilies,
    explicitNonPersistentFamilies
  };
}

export function validateSourceCompletionRecord(familyId: SourceCompletionFamilyId, record: JsonValue): { valid: boolean; diagnostics: string[] } {
  const familyRecord = FAMILY_DEFINITIONS.find(item => item.familyId === familyId);
  if (!familyRecord) return { valid: false, diagnostics: [`source_completion.record.unknown_family:${familyId}`] };
  const validation = validateHydrationRecord(familyRecord, record);
  return { valid: validation.reasonIds.length === 0, diagnostics: [...validation.reasonIds, ...validation.missingFields.map(field => `source_completion.record.field_missing:${familyId}:${field}`)] };
}

export function planHydration(input: readonly SourceCompletionHydrationRecord[] | { records: readonly SourceCompletionHydrationRecord[]; contract?: SourceCompletionContract }): SourceCompletionHydrationPlan {
  const records = hydrationPlanInputObject(input) ? input.records : input;
  const contract = hydrationPlanInputObject(input) ? input.contract ?? createSourceCompletionContract() : createSourceCompletionContract();
  const families = new Map<SourceCompletionFamilyId, SourceCompletionRecordFamily>(contract.families.map((item): [SourceCompletionFamilyId, SourceCompletionRecordFamily] => [item.familyId, item]));
  const acceptedRecords: SourceCompletionDryRunAcceptedRecord[] = [];
  const rejectedRecords: SourceCompletionDryRunRejectedRecord[] = [];
  const duplicateIdempotencyConflicts: SourceCompletionIdempotencyConflict[] = [];
  const seenKeys = new Map<string, SourceCompletionDryRunAcceptedRecord>();
  const warnings: string[] = [];

  for (const item of records) {
    const familyRecord = families.get(item.familyId as SourceCompletionFamilyId);
    if (!familyRecord) {
      rejectedRecords.push({ familyId: String(item.familyId), reasonIds: [`source_completion.hydration.unknown_family:${String(item.familyId)}`], missingFields: [] });
      continue;
    }
    const validation = validateHydrationRecord(familyRecord, item.record);
    const record = jsonRecord(item.record);
    const recordId = stringValue(record.id) ?? stringValue(record[familyRecord.idempotencyKeyFields[0] ?? "id"]);
    if (validation.reasonIds.length || validation.missingFields.length || !recordId) {
      rejectedRecords.push({ familyId: familyRecord.familyId, recordId, reasonIds: validation.reasonIds, missingFields: validation.missingFields });
      continue;
    }
    const idempotencyKey = idempotencyKeyFor(familyRecord, record);
    const duplicate = seenKeys.get(`${familyRecord.familyId}:${idempotencyKey}`);
    if (duplicate) {
      duplicateIdempotencyConflicts.push({ familyId: familyRecord.familyId, idempotencyKey, firstRecordId: duplicate.recordId, duplicateRecordId: recordId });
      rejectedRecords.push({ familyId: familyRecord.familyId, recordId, reasonIds: ["source_completion.hydration.duplicate_idempotency_key"], missingFields: [] });
      continue;
    }
    const accepted: SourceCompletionDryRunAcceptedRecord = {
      familyId: familyRecord.familyId,
      recordId,
      idempotencyKey,
      destinationStoreId: familyRecord.destinationStoreId,
      destinationTableId: familyRecord.destinationTableId,
      persistenceStatus: familyRecord.persistenceStatus,
      inspectVisibilityId: familyRecord.inspectVisibilityId,
      replayVisibilityId: familyRecord.replayVisibilityId
    };
    if (familyRecord.persistenceStatus !== "postgres_backed") warnings.push(`source_completion.hydration.non_persistent:${familyRecord.familyId}:${familyRecord.persistenceStatus}`);
    seenKeys.set(`${familyRecord.familyId}:${idempotencyKey}`, accepted);
    acceptedRecords.push(accepted);
  }

  const destinationStoreCounts = countBy(acceptedRecords.map(item => item.destinationStoreId));
  const destinationTableCounts = countBy(acceptedRecords.flatMap(item => item.destinationTableId ? [item.destinationTableId] : []));
  const persistenceStatusCounts = {
    source_only: acceptedRecords.filter(item => item.persistenceStatus === "source_only").length,
    planned: acceptedRecords.filter(item => item.persistenceStatus === "planned").length,
    postgres_backed: acceptedRecords.filter(item => item.persistenceStatus === "postgres_backed").length
  };
  const estimatedWriteCountsByTable = { ...destinationTableCounts };
  const unsafeReasons = [
    ...rejectedRecords.map(item => `source_completion.hydration.rejected:${item.familyId}:${item.recordId ?? "unidentified"}`),
    ...duplicateIdempotencyConflicts.map(item => `source_completion.hydration.duplicate:${item.familyId}:${item.idempotencyKey}`)
  ];
  const id = `hydration_plan_${hashText(canonicalStringify({ acceptedRecords, rejectedRecords, duplicateIdempotencyConflicts, destinationStoreCounts, destinationTableCounts })).slice(0, 32)}`;
  return {
    schema: "scce.source_completion.hydration_plan.v1",
    id,
    acceptedRecords,
    rejectedRecords,
    duplicateIdempotencyConflicts,
    destinationStoreCounts,
    destinationTableCounts,
    persistenceStatusCounts,
    estimatedWriteCountsByTable,
    warnings: uniqueStrings(warnings),
    unsafeReasons,
    safeToHydrate: unsafeReasons.length === 0,
    audit: toJsonValue({
      contractId: contract.id,
      recordCount: records.length,
      accepted: acceptedRecords.length,
      rejected: rejectedRecords.length,
      duplicateConflicts: duplicateIdempotencyConflicts.length
    })
  };
}

export function inspectRecord(kind: SourceCompletionFamilyId | string, id: string, store: SourceCompletionInspectStore): SourceCompletionInspectResult {
  const record = store.records.find(item => item.kind === kind && item.id === id);
  return {
    schema: "scce.source_completion.inspect.v1",
    kind: String(kind),
    id,
    found: Boolean(record),
    value: record?.value,
    diagnostics: record ? [] : [`source_completion.inspect.not_found:${String(kind)}:${id}`]
  };
}

export function replayTrace(traceId: string, store: SourceCompletionInspectStore): SourceCompletionReplayResult {
  const records = store.records.filter(item => item.id === traceId || item.traceId === traceId || item.traceIds?.includes(traceId));
  const links = (store.links ?? []).filter(item => item.traceId === traceId);
  const missingLinks = links.filter(link => !store.records.some(record => record.kind === link.targetKind && record.id === link.targetId));
  return {
    schema: "scce.source_completion.replay.v1",
    traceId,
    records,
    missingLinks,
    complete: missingLinks.length === 0
  };
}

export function summarizeTraceCoverage(store: SourceCompletionInspectStore): SourceCompletionTraceCoverageSummary {
  const traceIds = uniqueStrings([
    ...store.records.flatMap(item => [item.traceId, ...(item.traceIds ?? [])].filter(Boolean).map(String)),
    ...(store.links ?? []).map(item => item.traceId)
  ]);
  const links = store.links ?? [];
  const missingLinks = links.filter(link => !store.records.some(record => record.kind === link.targetKind && record.id === link.targetId));
  return {
    schema: "scce.source_completion.trace_coverage.v1",
    traceIds,
    linkCount: links.length,
    resolvedLinkCount: links.length - missingLinks.length,
    missingLinks,
    complete: missingLinks.length === 0
  };
}

function family(
  familyId: SourceCompletionFamilyId,
  recordKindId: string,
  typeScriptTypes: string[],
  validationFunctionId: string,
  idempotencyKeyFields: string[],
  destinationStoreId: string,
  sourceProvenanceFields: string[],
  options: Partial<Pick<SourceCompletionRecordFamily, "destinationTableId" | "forceClassField" | "requiredTraceIds">> = {}
): SourceCompletionRecordFamily {
  const destinationTableId = options.destinationTableId;
  return {
    familyId,
    recordKindId,
    typeScriptTypes,
    typeScriptTypeName: typeScriptTypes[0] ?? recordKindId,
    validationFunctionId,
    idempotencyKeyFields,
    destinationStoreId,
    destinationTableId,
    repositoryWriteAdapterId: `repository.write.${familyId}`,
    repositoryReadAdapterId: `repository.read.${familyId}`,
    inspectVisibilityId: `inspect.${familyId}`,
    replayVisibilityId: `replay.${familyId}`,
    sourceProvenanceFields,
    forceClassField: options.forceClassField,
    dryRunHydrationPlanId: `hydrate.dry_run.${familyId}`,
    migrationSchemaSourceId: destinationTableId ? `postgres.schema.${destinationTableId}` : undefined,
    requiredTraceIds: options.requiredTraceIds ?? [],
    requiredRuntimeFields: [...new Set(["id", ...idempotencyKeyFields, ...sourceProvenanceFields.slice(0, 1), ...(options.forceClassField ? [options.forceClassField] : [])])],
    persistenceStatus: "postgres_backed"
  };
}

function plannedFamily(
  familyId: SourceCompletionFamilyId,
  recordKindId: string,
  typeScriptTypes: string[],
  validationFunctionId: string,
  idempotencyKeyFields: string[],
  destinationStoreId: string,
  sourceProvenanceFields: string[],
  options: Partial<Pick<SourceCompletionRecordFamily, "forceClassField" | "requiredTraceIds">> = {}
): SourceCompletionRecordFamily {
  return {
    familyId,
    recordKindId,
    typeScriptTypes,
    typeScriptTypeName: typeScriptTypes[0] ?? recordKindId,
    validationFunctionId,
    idempotencyKeyFields,
    destinationStoreId,
    repositoryWriteAdapterId: `repository.write.planned.${familyId}`,
    repositoryReadAdapterId: `repository.read.planned.${familyId}`,
    inspectVisibilityId: `inspect.${familyId}`,
    replayVisibilityId: `replay.${familyId}`,
    sourceProvenanceFields,
    forceClassField: options.forceClassField,
    dryRunHydrationPlanId: `hydrate.dry_run.${familyId}`,
    requiredTraceIds: options.requiredTraceIds ?? [],
    requiredRuntimeFields: [...new Set(["id", ...idempotencyKeyFields, ...sourceProvenanceFields.slice(0, 1), ...(options.forceClassField ? [options.forceClassField] : [])])],
    persistenceStatus: familyId === "source_only_runtime_turn_traces" ? "source_only" : "planned"
  };
}

function validateFamily(familyRecord: SourceCompletionRecordFamily, plan: SourceCompletionHydrationStep | undefined): string[] {
  const diagnostics: string[] = [];
  const prefix = `source_completion.family:${familyRecord.familyId}`;
  if (!familyRecord.recordKindId) diagnostics.push(`${prefix}:record_kind_missing`);
  if (!familyRecord.typeScriptTypeName) diagnostics.push(`${prefix}:typescript_type_name_missing`);
  if (!familyRecord.typeScriptTypes.length) diagnostics.push(`${prefix}:typescript_type_missing`);
  if (!familyRecord.validationFunctionId) diagnostics.push(`${prefix}:validation_missing`);
  if (!familyRecord.idempotencyKeyFields.length) diagnostics.push(`${prefix}:idempotency_missing`);
  if (!familyRecord.destinationStoreId) diagnostics.push(`${prefix}:destination_missing`);
  if (!familyRecord.repositoryWriteAdapterId) diagnostics.push(`${prefix}:write_adapter_missing`);
  if (!familyRecord.repositoryReadAdapterId) diagnostics.push(`${prefix}:read_adapter_missing`);
  if (!familyRecord.inspectVisibilityId) diagnostics.push(`${prefix}:inspect_visibility_missing`);
  if (!familyRecord.replayVisibilityId) diagnostics.push(`${prefix}:replay_visibility_missing`);
  if (!familyRecord.sourceProvenanceFields.length) diagnostics.push(`${prefix}:provenance_missing`);
  if (!familyRecord.dryRunHydrationPlanId) diagnostics.push(`${prefix}:dry_run_missing`);
  if (!familyRecord.persistenceStatus) diagnostics.push(`${prefix}:persistence_status_missing`);
  if (familyRecord.persistenceStatus === "postgres_backed") {
    if (!familyRecord.destinationTableId) diagnostics.push(`${prefix}:destination_table_missing`);
    if (!familyRecord.migrationSchemaSourceId) diagnostics.push(`${prefix}:migration_schema_source_missing`);
  }
  if (!plan) diagnostics.push(`${prefix}:dry_run_plan_step_missing`);
  else {
    if (plan.destinationStoreId !== familyRecord.destinationStoreId) diagnostics.push(`${prefix}:dry_run_destination_mismatch`);
    if (plan.repositoryWriteAdapterId !== familyRecord.repositoryWriteAdapterId) diagnostics.push(`${prefix}:dry_run_write_adapter_mismatch`);
    if (plan.repositoryReadAdapterId !== familyRecord.repositoryReadAdapterId) diagnostics.push(`${prefix}:dry_run_read_adapter_mismatch`);
    if (plan.persistenceStatus !== familyRecord.persistenceStatus) diagnostics.push(`${prefix}:dry_run_persistence_mismatch`);
  }
  return diagnostics;
}

function validateHydrationRecord(familyRecord: SourceCompletionRecordFamily, value: JsonValue): { reasonIds: string[]; missingFields: string[] } {
  const record = jsonRecord(value);
  const missingFields = familyRecord.requiredRuntimeFields.filter(fieldId => record[fieldId] === undefined || record[fieldId] === null || record[fieldId] === "");
  const reasonIds: string[] = [];
  for (const fieldId of familyRecord.idempotencyKeyFields) {
    if (record[fieldId] === undefined || record[fieldId] === null || record[fieldId] === "") reasonIds.push(`source_completion.hydration.idempotency_field_missing:${fieldId}`);
  }
  if (familyRecord.forceClassField) {
    const forceClass = stringValue(record[familyRecord.forceClassField]);
    if (!forceClass) reasonIds.push(`source_completion.hydration.force_class_missing:${familyRecord.forceClassField}`);
    if (forceClass === "direct_evidence" && (!stringValue(record.sourceVersionId) || !stringValue(record.evidenceSpanId))) {
      reasonIds.push("source_completion.hydration.direct_evidence_requires_exact_source_span");
      if (!stringValue(record.sourceVersionId)) missingFields.push("sourceVersionId");
      if (!stringValue(record.evidenceSpanId)) missingFields.push("evidenceSpanId");
    }
  }
  return { reasonIds: uniqueStrings(reasonIds), missingFields: uniqueStrings(missingFields) };
}

function hydrationPlanInputObject(input: readonly SourceCompletionHydrationRecord[] | { records: readonly SourceCompletionHydrationRecord[]; contract?: SourceCompletionContract }): input is { records: readonly SourceCompletionHydrationRecord[]; contract?: SourceCompletionContract } {
  return !Array.isArray(input);
}

function idempotencyKeyFor(familyRecord: SourceCompletionRecordFamily, record: Record<string, JsonValue>): string {
  return familyRecord.idempotencyKeyFields.map(fieldId => `${fieldId}=${stableScalar(record[fieldId])}`).join("\u001f");
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string" && value) return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function stableScalar(value: JsonValue | undefined): string {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return canonicalStringify(value ?? null);
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort();
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
