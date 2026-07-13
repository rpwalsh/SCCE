import { canonicalStringify, clamp01, createHasher, toJsonValue } from "./primitives.js";
import type {
  ChunkId,
  ContentHash,
  EdgeId,
  EvidenceId,
  EvidenceSpan,
  GraphEdge,
  GraphNode,
  JsonValue,
  KnownEventType,
  NodeId,
  ProgramConstructIntent,
  RelationId,
  SourceId,
  SourceVersionId
} from "./types.js";
import type { LearningNeed } from "./learning-loop.js";
import type { ProofClaim, ProofEvidenceRecord, ProofForceClass } from "./semantic-proof-engine.js";

export type WorkspaceCoreRecordType =
  | "WorkspaceEvidenceRecord"
  | "WorkspaceSymbolGraphRecord"
  | "WorkspaceImportGraphRecord"
  | "WorkspaceCapabilityRecord"
  | "WorkspaceCommandRecord"
  | "WorkspaceDocClaimRecord"
  | "WorkspaceContradictionRecord"
  | "WorkspaceGapRecord"
  | "WorkspaceTaskRecord"
  | "WorkspaceReplayEventRecord";

export interface WorkspaceCoreSourceRef {
  path: string;
  lineStart?: number;
  lineEnd?: number;
  evidenceSpanId?: string;
  contentHash?: string;
}

export interface WorkspaceCoreWorkspaceRef {
  id: string;
  corpusId: string;
  rootPath: string;
  rootUri?: string;
}

export interface WorkspaceCoreSourceFileInput {
  workspaceId?: string;
  corpusId?: string;
  path: string;
  absolutePath?: string;
  mediaType: string;
  contentHash?: string;
  modifiedTime?: number;
  byteLength?: number;
  evidenceIds?: string[];
  symbolIds?: string[];
  metadata?: JsonValue;
}

export interface WorkspaceCoreSymbolInput {
  id: string;
  name: string;
  kind: string;
  path: string;
  exported: boolean;
  defaultExport?: boolean;
  sourceRef?: WorkspaceCoreSourceRef;
  importedBy?: string[];
  mentionedByDocs?: string[];
  calledBy?: string[];
}

export interface WorkspaceCoreCommandInput {
  id: string;
  name: string;
  command: string;
  sourcePath: string;
  kind: string;
  sourceRef?: WorkspaceCoreSourceRef;
}

export interface WorkspaceCoreRouteInput {
  id: string;
  method: string;
  path: string;
  filePath: string;
  handlerHint?: string;
  sourceRef?: WorkspaceCoreSourceRef;
}

export interface WorkspaceCoreFindingInput {
  id: string;
  kind: string;
  severity: string;
  statement: string;
  sourceRefs: WorkspaceCoreSourceRef[];
  affectedFiles: string[];
  suggestedFix: string;
  confidence: number;
  metadata: JsonValue;
}

export interface WorkspaceCoreSummaryInput {
  body?: string;
  sourceRefs?: WorkspaceCoreSourceRef[];
  counts?: Record<string, number>;
}

export interface WorkspaceCoreMapInput {
  modules?: Array<{ path: string; languageId?: string; declarations?: number; imports?: number; exports?: number; roles?: string[]; sourceRefs?: WorkspaceCoreSourceRef[] }>;
}

export interface WorkspaceCoreAnalysisInput {
  schema?: string;
  rootPath: string;
  workspace: WorkspaceCoreWorkspaceRef;
  sources: WorkspaceCoreSourceFileInput[];
  summary?: WorkspaceCoreSummaryInput;
  map?: WorkspaceCoreMapInput;
  symbols: WorkspaceCoreSymbolInput[];
  commands: WorkspaceCoreCommandInput[];
  routes: WorkspaceCoreRouteInput[];
  gaps: WorkspaceCoreFindingInput[];
  contradictions: WorkspaceCoreFindingInput[];
  tasks: WorkspaceCoreFindingInput[];
  reports?: Partial<Record<string, string>>;
}

export interface WorkspaceCoreProvenance {
  workspaceId: string;
  corpusId: string;
  rootPath: string;
  analyzerId: string;
  analyzerVersion: string;
  originatingAnalyzerId: string;
  replayTraceId: string;
  sourcePath?: string;
  sourceHash?: string;
  evidenceSpanId?: string;
}

export interface WorkspaceCoreRecordBase {
  id: string;
  recordType: WorkspaceCoreRecordType;
  workspaceId: string;
  corpusId: string;
  sourcePath?: string;
  sourceHash?: string;
  sourceRef?: WorkspaceCoreSourceRef;
  kind: string;
  confidence: number;
  forceClass: ProofForceClass;
  provenance: WorkspaceCoreProvenance;
  analyzer: { id: string; version: string };
  replayTraceId: string;
  idempotencyKey: string;
  destinationStoreId: string;
  createdAt: number;
  updatedAt: number;
  metadata: JsonValue;
}

export interface WorkspaceEvidenceRecord extends WorkspaceCoreRecordBase {
  recordType: "WorkspaceEvidenceRecord";
  evidence: EvidenceSpan;
}

export interface WorkspaceSymbolGraphRecord extends WorkspaceCoreRecordBase {
  recordType: "WorkspaceSymbolGraphRecord";
  symbolId: string;
  symbolName: string;
  graphNode: GraphNode;
}

export interface WorkspaceImportGraphRecord extends WorkspaceCoreRecordBase {
  recordType: "WorkspaceImportGraphRecord";
  relationshipKind: "workspace.relation.imports_symbol" | "workspace.relation.exports_symbol";
  graphEdge: GraphEdge;
}

export interface WorkspaceCapabilityRecord extends WorkspaceCoreRecordBase {
  recordType: "WorkspaceCapabilityRecord";
  capabilityId: string;
  route: { method: string; path: string; filePath: string; handlerHint?: string };
  graphNode: GraphNode;
  proofEvidence?: ProofEvidenceRecord;
}

export interface WorkspaceCommandRecord extends WorkspaceCoreRecordBase {
  recordType: "WorkspaceCommandRecord";
  actionId: string;
  command: { name: string; command: string; sourcePath: string; kind: string };
  graphNode: GraphNode;
  proofEvidence?: ProofEvidenceRecord;
}

export interface WorkspaceDocClaimRecord extends WorkspaceCoreRecordBase {
  recordType: "WorkspaceDocClaimRecord";
  workspaceFindingId: string;
  proofClaim: ProofClaim;
  proofEvidence: ProofEvidenceRecord;
}

export interface WorkspaceContradictionRecord extends WorkspaceCoreRecordBase {
  recordType: "WorkspaceContradictionRecord";
  workspaceFindingId: string;
  proofClaim: ProofClaim;
  evidenceSpan: EvidenceSpan;
  severity: string;
  affectedFiles: string[];
}

export interface WorkspaceGapRecord extends WorkspaceCoreRecordBase {
  recordType: "WorkspaceGapRecord";
  workspaceFindingId: string;
  learningNeed: LearningNeed;
  affectedFiles: string[];
}

export interface WorkspaceProgramPlannerInput {
  id: string;
  workspaceTaskId: string;
  workspaceTaskRecordId?: string;
  affectedFiles: string[];
  sourceRefs: WorkspaceCoreSourceRef[];
  evidenceSpanIds: string[];
  programIntent: ProgramConstructIntent;
  provenance: WorkspaceCoreProvenance;
  idempotencyKey: string;
}

export interface WorkspaceTaskRecord extends WorkspaceCoreRecordBase {
  recordType: "WorkspaceTaskRecord";
  workspaceFindingId: string;
  programPlannerInput: WorkspaceProgramPlannerInput;
  affectedFiles: string[];
}

export interface WorkspaceReplayEventRecord extends WorkspaceCoreRecordBase {
  recordType: "WorkspaceReplayEventRecord";
  eventTypeId: KnownEventType;
  payload: JsonValue;
}

export type WorkspaceCoreRecord =
  | WorkspaceEvidenceRecord
  | WorkspaceSymbolGraphRecord
  | WorkspaceImportGraphRecord
  | WorkspaceCapabilityRecord
  | WorkspaceCommandRecord
  | WorkspaceDocClaimRecord
  | WorkspaceContradictionRecord
  | WorkspaceGapRecord
  | WorkspaceTaskRecord
  | WorkspaceReplayEventRecord;

export interface WorkspaceCoreRejectedRecord {
  id: string;
  recordType: WorkspaceCoreRecordType;
  reasonId: string;
  missingRequiredFields: string[];
  idempotencyKey: string;
  sourceRef?: WorkspaceCoreSourceRef;
  metadata: JsonValue;
}

export interface WorkspaceCoreHydrationContract {
  schema: "scce.workspace_core.hydration.v1";
  acceptedRecords: number;
  rejectedRecords: WorkspaceCoreRejectedRecord[];
  missingRequiredFields: Array<{ recordId: string; recordType: WorkspaceCoreRecordType; fields: string[] }>;
  destinationStores: Array<{ destinationStoreId: string; recordType: WorkspaceCoreRecordType; count: number }>;
  idempotencyKeys: string[];
  safeToHydrate: boolean;
}

export interface WorkspaceCoreMouthContext {
  schema: "scce.workspace_core.mouth_context.v1";
  evidence: EvidenceSpan[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  proofClaims: ProofClaim[];
  proofEvidence: ProofEvidenceRecord[];
  learningNeeds: LearningNeed[];
  programPlannerInputs: WorkspaceProgramPlannerInput[];
  contradictionRecordIds: string[];
  gapRecordIds: string[];
  taskRecordIds: string[];
  sourceRefs: WorkspaceCoreSourceRef[];
}

export interface WorkspaceCorePromotionResult {
  schema: "scce.workspace_core.promotion.v1";
  workspaceId: string;
  corpusId: string;
  analyzer: { id: string; version: string };
  replayTraceId: string;
  records: {
    evidence: WorkspaceEvidenceRecord[];
    symbols: WorkspaceSymbolGraphRecord[];
    relations: WorkspaceImportGraphRecord[];
    capabilities: WorkspaceCapabilityRecord[];
    commands: WorkspaceCommandRecord[];
    docClaims: WorkspaceDocClaimRecord[];
    contradictions: WorkspaceContradictionRecord[];
    gaps: WorkspaceGapRecord[];
    tasks: WorkspaceTaskRecord[];
    replayEvents: WorkspaceReplayEventRecord[];
  };
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  proof: { claims: ProofClaim[]; evidence: ProofEvidenceRecord[] };
  learning: { needs: LearningNeed[] };
  program: { plannerInputs: WorkspaceProgramPlannerInput[] };
  mouthContext: WorkspaceCoreMouthContext;
  contract: WorkspaceCoreHydrationContract;
  diagnostics: string[];
  safeToHydrate: boolean;
  createdAt: number;
}

export interface WorkspaceCorePromotionContext {
  workspace: WorkspaceCoreWorkspaceRef;
  sourceByPath: Map<string, WorkspaceCoreSourceFileInput>;
  replayTraceId: string;
  createdAt: number;
}

interface RecordBuild<T extends WorkspaceCoreRecord> {
  record?: T;
  rejected?: WorkspaceCoreRejectedRecord;
}

const ANALYZER_ID = "workspace.core_fusion";
const ANALYZER_VERSION = "phase12.source";
const DIRECT_EVIDENCE: ProofForceClass = "direct_evidence";
const UNKNOWN_PRIOR: ProofForceClass = "unknown_prior";
const LEARNED_CONCEPT_PRIOR: ProofForceClass = "learned_concept_prior";
const LEARNED_PROGRAM_PRIOR: ProofForceClass = "learned_program_prior";

const DESTINATIONS: Record<WorkspaceCoreRecordType, string> = {
  WorkspaceEvidenceRecord: "store.evidence_spans",
  WorkspaceSymbolGraphRecord: "store.graph_nodes",
  WorkspaceImportGraphRecord: "store.graph_edges",
  WorkspaceCapabilityRecord: "store.capabilities",
  WorkspaceCommandRecord: "store.actions",
  WorkspaceDocClaimRecord: "store.proof_claims",
  WorkspaceContradictionRecord: "store.contradictions",
  WorkspaceGapRecord: "store.learning_needs",
  WorkspaceTaskRecord: "store.program_planner_inputs",
  WorkspaceReplayEventRecord: "store.events"
};

export function promoteWorkspaceAnalysisToCoreRecords(input: WorkspaceCoreAnalysisInput): WorkspaceCorePromotionResult {
  const createdAt = Date.now();
  const ctx: WorkspaceCorePromotionContext = {
    workspace: input.workspace,
    sourceByPath: new Map(input.sources.map(source => [normalizePath(source.path), source])),
    replayTraceId: coreId("workspace.replay", input.workspace.id, input.rootPath, String(createdAt)),
    createdAt
  };
  const rejected: WorkspaceCoreRejectedRecord[] = [];
  const evidence = collectRecords(input, ctx, rejected, input.contradictions.concat(input.gaps, input.tasks).map(item => workspaceFindingToEvidenceSpan(item, ctx)));
  const symbolRecords = collectRecords(input, ctx, rejected, input.symbols.map(item => workspaceSymbolToGraphNode(item, ctx)));
  const relationRecords = collectRecords(input, ctx, rejected, [
    ...input.symbols.flatMap(symbol => (symbol.importedBy ?? []).map(importingPath => workspaceImportToGraphEdge({ symbol, importingPath, relationshipKind: "workspace.relation.imports_symbol" }, ctx))),
    ...input.symbols.filter(symbol => symbol.exported).map(symbol => workspaceImportToGraphEdge({ symbol, importingPath: symbol.path, relationshipKind: "workspace.relation.exports_symbol" }, ctx))
  ]);
  const capabilities = collectRecords(input, ctx, rejected, input.routes.map(item => workspaceRouteToCapabilityRecord(item, ctx)));
  const commands = collectRecords(input, ctx, rejected, input.commands.map(item => workspaceCommandToActionRecord(item, ctx)));
  const docClaims = collectRecords(input, ctx, rejected, input.contradictions.map(item => workspaceDocClaimRecord(item, ctx)));
  const contradictions = collectRecords(input, ctx, rejected, input.contradictions.map(item => workspaceContradictionToContradictionRecord(item, ctx)));
  const gaps = collectRecords(input, ctx, rejected, input.gaps.map(item => workspaceGapRecord(item, ctx)));
  const tasks = collectRecords(input, ctx, rejected, input.tasks.map(item => workspaceTaskRecord(item, ctx)));
  const replayEvents = collectRecords(input, ctx, rejected, reportEvents(input, ctx));
  const allRecords: WorkspaceCoreRecord[] = [
    ...evidence,
    ...symbolRecords,
    ...relationRecords,
    ...capabilities,
    ...commands,
    ...docClaims,
    ...contradictions,
    ...gaps,
    ...tasks,
    ...replayEvents
  ];
  const graph = {
    nodes: dedupeById([
      ...input.sources.map(source => sourceFileNode(source, ctx)),
      ...symbolRecords.map(item => item.graphNode),
      ...capabilities.map(item => item.graphNode),
      ...commands.map(item => item.graphNode),
      ...gaps.map(item => findingGraphNode(item)),
      ...contradictions.map(item => findingGraphNode(item)),
      ...tasks.map(item => findingGraphNode(item))
    ]),
    edges: dedupeById([
      ...relationRecords.map(item => item.graphEdge),
      ...symbolRecords.flatMap(item => sourceToRecordEdges(item, "workspace.relation.file_declares_symbol", ctx)),
      ...capabilities.flatMap(item => sourceToRecordEdges(item, "workspace.relation.file_declares_capability", ctx)),
      ...commands.flatMap(item => sourceToRecordEdges(item, "workspace.relation.file_declares_action", ctx)),
      ...contradictions.flatMap(item => sourceToRecordEdges(item, "workspace.relation.evidence_conflicts", ctx)),
      ...gaps.flatMap(item => sourceToRecordEdges(item, "workspace.relation.missing_support", ctx)),
      ...tasks.flatMap(item => sourceToRecordEdges(item, "workspace.relation.planner_candidate", ctx))
    ])
  };
  const proofClaims = dedupeById([
    ...docClaims.map(item => item.proofClaim),
    ...contradictions.map(item => item.proofClaim)
  ]);
  const proofEvidence = dedupeById([
    ...docClaims.map(item => item.proofEvidence),
    ...capabilities.flatMap(item => item.proofEvidence ? [item.proofEvidence] : []),
    ...commands.flatMap(item => item.proofEvidence ? [item.proofEvidence] : [])
  ]);
  const learningNeeds = dedupeById(gaps.map(item => item.learningNeed));
  const plannerInputs = dedupeById(tasks.map(item => item.programPlannerInput));
  const mouthContext = workspaceCoreFusionToMouthContext({
    evidence: evidence.map(item => item.evidence),
    graphNodes: graph.nodes,
    graphEdges: graph.edges,
    proofClaims,
    proofEvidence,
    learningNeeds,
    programPlannerInputs: plannerInputs,
    contradictions,
    gaps,
    tasks
  });
  const contract = hydrationContract(allRecords, rejected);
  return {
    schema: "scce.workspace_core.promotion.v1",
    workspaceId: input.workspace.id,
    corpusId: input.workspace.corpusId,
    analyzer: { id: ANALYZER_ID, version: ANALYZER_VERSION },
    replayTraceId: ctx.replayTraceId,
    records: { evidence, symbols: symbolRecords, relations: relationRecords, capabilities, commands, docClaims, contradictions, gaps, tasks, replayEvents },
    graph,
    proof: { claims: proofClaims, evidence: proofEvidence },
    learning: { needs: learningNeeds },
    program: { plannerInputs },
    mouthContext,
    contract,
    diagnostics: contract.missingRequiredFields.map(item => `${item.recordType}:${item.fields.join(",")}`),
    safeToHydrate: contract.safeToHydrate,
    createdAt
  };
}

export function workspaceFindingToEvidenceSpan(finding: WorkspaceCoreFindingInput, ctx: WorkspaceCorePromotionContext): RecordBuild<WorkspaceEvidenceRecord> {
  const sourceRef = primaryRef(finding);
  const missing = requiredFields({ workspaceId: ctx.workspace.id, corpusId: ctx.workspace.corpusId, sourcePath: sourceRef?.path, sourceRef: sourceRef ? "present" : undefined });
  const idempotencyKey = idempotency("WorkspaceEvidenceRecord", ctx.workspace.id, finding.id, sourceRef);
  if (!sourceRef || missing.length) return { rejected: rejectedRecord("WorkspaceEvidenceRecord", "workspace.reject.source_ref_required", missing, idempotencyKey, sourceRef, finding) };
  const span = evidenceSpanForFinding(finding, sourceRef, ctx);
  return {
    record: {
      ...baseRecord("WorkspaceEvidenceRecord", "workspace.evidence.finding", DIRECT_EVIDENCE, clamp01(finding.confidence), sourceRef, ctx, idempotencyKey, {
        workspaceFindingId: finding.id,
        findingKind: finding.kind,
        affectedFiles: finding.affectedFiles
      }),
      recordType: "WorkspaceEvidenceRecord",
      evidence: span
    }
  };
}

export function workspaceSymbolToGraphNode(symbol: WorkspaceCoreSymbolInput, ctx: WorkspaceCorePromotionContext): RecordBuild<WorkspaceSymbolGraphRecord> {
  const sourceRef = symbol.sourceRef ?? refFromSource(ctx, symbol.path);
  const missing = requiredFields({ workspaceId: ctx.workspace.id, corpusId: ctx.workspace.corpusId, sourcePath: sourceRef?.path, sourceRef: sourceRef ? "present" : undefined });
  const idempotencyKey = idempotency("WorkspaceSymbolGraphRecord", ctx.workspace.id, symbol.id, sourceRef);
  if (!sourceRef || missing.length) return { rejected: rejectedRecord("WorkspaceSymbolGraphRecord", "workspace.reject.symbol_source_ref_required", missing, idempotencyKey, sourceRef, symbol) };
  const graphNode = graphNodeFor({
    id: nodeId("workspace.symbol", ctx.workspace.id, symbol.id),
    typeId: "workspace.node.symbol",
    representation: {
      symbolId: symbol.id,
      symbolName: symbol.name,
      symbolKind: symbol.kind,
      exported: symbol.exported,
      defaultExport: Boolean(symbol.defaultExport),
      sourcePath: sourceRef.path
    },
    alpha: 0.72,
    evidenceIds: evidenceIdsFromRef(sourceRef),
    features: ["workspace", "symbol", symbol.kind, symbol.name, sourceRef.path],
    createdAt: ctx.createdAt,
    metadata: {
      importedBy: symbol.importedBy ?? [],
      mentionedByDocs: symbol.mentionedByDocs ?? [],
      calledBy: symbol.calledBy ?? []
    }
  });
  return {
    record: {
      ...baseRecord("WorkspaceSymbolGraphRecord", "workspace.graph.symbol", DIRECT_EVIDENCE, 0.88, sourceRef, ctx, idempotencyKey, { symbolId: symbol.id }),
      recordType: "WorkspaceSymbolGraphRecord",
      symbolId: symbol.id,
      symbolName: symbol.name,
      graphNode
    }
  };
}

export function workspaceImportToGraphEdge(input: { symbol: WorkspaceCoreSymbolInput; importingPath: string; relationshipKind?: WorkspaceImportGraphRecord["relationshipKind"] }, ctx: WorkspaceCorePromotionContext): RecordBuild<WorkspaceImportGraphRecord> {
  const relationshipKind = input.relationshipKind ?? "workspace.relation.imports_symbol";
  const sourceRef = input.symbol.sourceRef ?? refFromSource(ctx, input.symbol.path);
  const importingRef = refFromSource(ctx, input.importingPath) ?? sourceRef;
  const missing = requiredFields({ workspaceId: ctx.workspace.id, corpusId: ctx.workspace.corpusId, sourcePath: importingRef?.path, sourceRef: importingRef ? "present" : undefined });
  const idempotencyKey = idempotency("WorkspaceImportGraphRecord", ctx.workspace.id, input.symbol.id, input.importingPath, relationshipKind);
  if (!importingRef || missing.length) return { rejected: rejectedRecord("WorkspaceImportGraphRecord", "workspace.reject.relation_source_ref_required", missing, idempotencyKey, importingRef, input) };
  const sourceNode = relationshipKind === "workspace.relation.exports_symbol"
    ? nodeId("workspace.file", ctx.workspace.id, normalizePath(input.symbol.path))
    : nodeId("workspace.file", ctx.workspace.id, normalizePath(input.importingPath));
  const targetNode = nodeId("workspace.symbol", ctx.workspace.id, input.symbol.id);
  const graphEdge = graphEdgeFor({
    id: edgeId("workspace.relation", ctx.workspace.id, sourceNode, targetNode, relationshipKind),
    source: sourceNode,
    target: targetNode,
    relationId: relationshipKind,
    evidenceIds: evidenceIdsFromRef(importingRef),
    weight: relationshipKind === "workspace.relation.exports_symbol" ? 0.82 : 0.76,
    createdAt: ctx.createdAt,
    metadata: { symbolId: input.symbol.id, importingPath: normalizePath(input.importingPath), relationshipKind }
  });
  return {
    record: {
      ...baseRecord("WorkspaceImportGraphRecord", relationshipKind, DIRECT_EVIDENCE, 0.78, importingRef, ctx, idempotencyKey, { symbolId: input.symbol.id, importingPath: input.importingPath }),
      recordType: "WorkspaceImportGraphRecord",
      relationshipKind,
      graphEdge
    }
  };
}

export function workspaceRouteToCapabilityRecord(route: WorkspaceCoreRouteInput, ctx: WorkspaceCorePromotionContext): RecordBuild<WorkspaceCapabilityRecord> {
  const sourceRef = route.sourceRef ?? refFromSource(ctx, route.filePath);
  const idempotencyKey = idempotency("WorkspaceCapabilityRecord", ctx.workspace.id, route.id, route.path);
  const missing = requiredFields({ workspaceId: ctx.workspace.id, corpusId: ctx.workspace.corpusId, sourcePath: sourceRef?.path, sourceRef: sourceRef ? "present" : undefined });
  if (!sourceRef || missing.length) return { rejected: rejectedRecord("WorkspaceCapabilityRecord", "workspace.reject.route_source_ref_required", missing, idempotencyKey, sourceRef, route) };
  const capabilityId = coreId("workspace.capability.route", ctx.workspace.id, route.id);
  const graphNode = graphNodeFor({
    id: nodeId("workspace.capability", ctx.workspace.id, route.id),
    typeId: "workspace.node.capability",
    representation: { capabilityId, routePath: route.path, method: route.method, filePath: route.filePath, handlerHint: route.handlerHint ?? null },
    alpha: 0.74,
    evidenceIds: evidenceIdsFromRef(sourceRef),
    features: ["workspace", "route", route.method, route.path, route.filePath],
    createdAt: ctx.createdAt,
    metadata: { routeId: route.id }
  });
  return {
    record: {
      ...baseRecord("WorkspaceCapabilityRecord", "workspace.capability.route", DIRECT_EVIDENCE, 0.86, sourceRef, ctx, idempotencyKey, { routeId: route.id }),
      recordType: "WorkspaceCapabilityRecord",
      capabilityId,
      route: { method: route.method, path: route.path, filePath: route.filePath, handlerHint: route.handlerHint },
      graphNode,
      proofEvidence: proofEvidenceFromStructured({
        id: coreId("workspace.proof.route", ctx.workspace.id, route.id),
        forceClass: DIRECT_EVIDENCE,
        sourceRef,
        subjectId: capabilityId,
        relationId: "workspace.relation.exposes_route",
        objectId: route.path,
        text: route.path
      })
    }
  };
}

export function workspaceCommandToActionRecord(command: WorkspaceCoreCommandInput, ctx: WorkspaceCorePromotionContext): RecordBuild<WorkspaceCommandRecord> {
  const sourceRef = command.sourceRef ?? refFromSource(ctx, command.sourcePath);
  const idempotencyKey = idempotency("WorkspaceCommandRecord", ctx.workspace.id, command.id, command.name, command.command);
  const missing = requiredFields({ workspaceId: ctx.workspace.id, corpusId: ctx.workspace.corpusId, sourcePath: sourceRef?.path, sourceRef: sourceRef ? "present" : undefined });
  if (!sourceRef || missing.length) return { rejected: rejectedRecord("WorkspaceCommandRecord", "workspace.reject.command_source_ref_required", missing, idempotencyKey, sourceRef, command) };
  const actionId = coreId("workspace.action.command", ctx.workspace.id, command.id);
  const graphNode = graphNodeFor({
    id: nodeId("workspace.action", ctx.workspace.id, command.id),
    typeId: "workspace.node.action",
    representation: { actionId, commandName: command.name, command: command.command, sourcePath: command.sourcePath, kind: command.kind },
    alpha: 0.72,
    evidenceIds: evidenceIdsFromRef(sourceRef),
    features: ["workspace", "command", command.name, command.sourcePath],
    createdAt: ctx.createdAt,
    metadata: { commandId: command.id }
  });
  return {
    record: {
      ...baseRecord("WorkspaceCommandRecord", "workspace.action.command", DIRECT_EVIDENCE, 0.86, sourceRef, ctx, idempotencyKey, { commandId: command.id }),
      recordType: "WorkspaceCommandRecord",
      actionId,
      command: { name: command.name, command: command.command, sourcePath: command.sourcePath, kind: command.kind },
      graphNode,
      proofEvidence: proofEvidenceFromStructured({
        id: coreId("workspace.proof.command", ctx.workspace.id, command.id),
        forceClass: DIRECT_EVIDENCE,
        sourceRef,
        subjectId: actionId,
        relationId: "workspace.relation.exposes_command",
        objectId: command.name,
        text: command.command
      })
    }
  };
}

export function workspaceDocClaimToProofClaim(input: { workspaceFindingId: string; kind: string; statement: string; sourceRef: WorkspaceCoreSourceRef }, ctx: WorkspaceCorePromotionContext): ProofClaim {
  return {
    id: coreId("workspace.claim", ctx.workspace.id, input.workspaceFindingId, input.sourceRef.path),
    subject: { id: coreId("workspace.source", ctx.workspace.id, input.sourceRef.path), surface: input.sourceRef.path, kindId: "workspace.proof.subject.source" },
    relationId: `workspace.claim.${input.kind}`,
    object: { id: coreId("workspace.claim.object", input.statement), surface: input.statement, kindId: "workspace.proof.object.statement" },
    polarityId: "polarity.positive",
    modalityId: "modality.reported",
    requiredSourceBinding: true
  };
}

export function workspaceContradictionToContradictionRecord(finding: WorkspaceCoreFindingInput, ctx: WorkspaceCorePromotionContext): RecordBuild<WorkspaceContradictionRecord> {
  const sourceRef = primaryRef(finding);
  const idempotencyKey = idempotency("WorkspaceContradictionRecord", ctx.workspace.id, finding.id, sourceRef);
  const missing = requiredFields({ workspaceId: ctx.workspace.id, corpusId: ctx.workspace.corpusId, sourcePath: sourceRef?.path, sourceRef: sourceRef ? "present" : undefined });
  if (!sourceRef || missing.length) return { rejected: rejectedRecord("WorkspaceContradictionRecord", "workspace.reject.contradiction_source_ref_required", missing, idempotencyKey, sourceRef, finding) };
  const span = evidenceSpanForFinding(finding, sourceRef, ctx);
  const proofClaim = workspaceDocClaimToProofClaim({ workspaceFindingId: finding.id, kind: finding.kind, statement: finding.statement, sourceRef }, ctx);
  return {
    record: {
      ...baseRecord("WorkspaceContradictionRecord", "workspace.contradiction", DIRECT_EVIDENCE, clamp01(finding.confidence), sourceRef, ctx, idempotencyKey, { workspaceFindingId: finding.id }),
      recordType: "WorkspaceContradictionRecord",
      workspaceFindingId: finding.id,
      proofClaim,
      evidenceSpan: span,
      severity: finding.severity,
      affectedFiles: [...new Set(finding.affectedFiles)].sort()
    }
  };
}

export function workspaceGapToLearningNeed(finding: WorkspaceCoreFindingInput, ctx: WorkspaceCorePromotionContext): LearningNeed {
  const sourceRef = primaryRef(finding);
  const evidenceIds = sourceRef ? evidenceIdsFromRef(sourceRef).map(String) : [];
  return {
    id: coreId("workspace.learning_need", ctx.workspace.id, finding.id),
    gapId: finding.id,
    needKindId: `workspace.need.${finding.kind}`,
    requiredSourceKindIds: ["workspace.source.code", "workspace.source.documentation"],
    requiredEvidenceFieldIds: ["workspace.evidence.source_ref", "workspace.evidence.affected_file"],
    requiredCapabilityIds: ["workspace.capability.local_file_analysis"],
    acceptanceCriteriaIds: ["workspace.acceptance.source_backed", "workspace.acceptance.replay_visible"],
    maxRisk: 0.35,
    maxCost: 0.35,
    provenanceRequirementIds: ["workspace.provenance.source_span"],
    priority: clamp01(finding.confidence),
    trace: toJsonValue({ workspaceId: ctx.workspace.id, findingId: finding.id, evidenceIds, sourceRef })
  };
}

export function workspaceGapRecord(finding: WorkspaceCoreFindingInput, ctx: WorkspaceCorePromotionContext): RecordBuild<WorkspaceGapRecord> {
  const sourceRef = primaryRef(finding);
  const idempotencyKey = idempotency("WorkspaceGapRecord", ctx.workspace.id, finding.id, sourceRef);
  const missing = requiredFields({ workspaceId: ctx.workspace.id, corpusId: ctx.workspace.corpusId, sourcePath: sourceRef?.path, sourceRef: sourceRef ? "present" : undefined });
  if (!sourceRef || missing.length) return { rejected: rejectedRecord("WorkspaceGapRecord", "workspace.reject.gap_source_ref_required", missing, idempotencyKey, sourceRef, finding) };
  return {
    record: {
      ...baseRecord("WorkspaceGapRecord", "workspace.gap", DIRECT_EVIDENCE, clamp01(finding.confidence), sourceRef, ctx, idempotencyKey, { workspaceFindingId: finding.id }),
      recordType: "WorkspaceGapRecord",
      workspaceFindingId: finding.id,
      learningNeed: workspaceGapToLearningNeed(finding, ctx),
      affectedFiles: [...new Set(finding.affectedFiles)].sort()
    }
  };
}

export function workspaceTaskToProgramPlannerInput(task: WorkspaceCoreFindingInput, ctx: WorkspaceCorePromotionContext): WorkspaceProgramPlannerInput {
  const sourceRefs = uniqueRefs(task.sourceRefs);
  const evidenceSpanIds = sourceRefs.flatMap(ref => evidenceIdsFromRef(ref).map(String));
  const id = coreId("workspace.program_input", ctx.workspace.id, task.id);
  return {
    id,
    workspaceTaskId: task.id,
    affectedFiles: [...new Set(task.affectedFiles)].sort(),
    sourceRefs,
    evidenceSpanIds,
    programIntent: {
      artifactKindIds: ["program.artifact.patch_plan"],
      capabilityIds: ["program.capability.source_edit_plan"],
      constraints: ["program.constraint.source_backed", "program.constraint.no_unobserved_command"],
      provenanceEvidenceIds: evidenceSpanIds,
      metadata: toJsonValue({
        workspaceId: ctx.workspace.id,
        workspaceTaskId: task.id,
        findingKind: task.kind,
        affectedFiles: task.affectedFiles
      })
    },
    provenance: provenanceFor(ctx, primaryRef(task)),
    idempotencyKey: idempotency("WorkspaceTaskRecord", ctx.workspace.id, task.id, primaryRef(task))
  };
}

export function workspaceTaskRecord(task: WorkspaceCoreFindingInput, ctx: WorkspaceCorePromotionContext): RecordBuild<WorkspaceTaskRecord> {
  const sourceRef = primaryRef(task);
  const idempotencyKey = idempotency("WorkspaceTaskRecord", ctx.workspace.id, task.id, sourceRef);
  const missing = requiredFields({ workspaceId: ctx.workspace.id, corpusId: ctx.workspace.corpusId, sourcePath: sourceRef?.path, sourceRef: sourceRef ? "present" : undefined });
  if (!sourceRef || missing.length) return { rejected: rejectedRecord("WorkspaceTaskRecord", "workspace.reject.task_source_ref_required", missing, idempotencyKey, sourceRef, task) };
  const programPlannerInput = workspaceTaskToProgramPlannerInput(task, ctx);
  const base = baseRecord("WorkspaceTaskRecord", "workspace.task", DIRECT_EVIDENCE, clamp01(task.confidence), sourceRef, ctx, idempotencyKey, { workspaceFindingId: task.id });
  return {
    record: {
      ...base,
      recordType: "WorkspaceTaskRecord",
      workspaceFindingId: task.id,
      programPlannerInput: { ...programPlannerInput, workspaceTaskRecordId: base.id },
      affectedFiles: [...new Set(task.affectedFiles)].sort()
    }
  };
}

export function workspaceReportToReplayEvent(input: { reportKind: string; body: string }, ctx: WorkspaceCorePromotionContext): RecordBuild<WorkspaceReplayEventRecord> {
  const idempotencyKey = idempotency("WorkspaceReplayEventRecord", ctx.workspace.id, input.reportKind, digest(input.body));
  const sourceRef = { path: ctx.workspace.rootPath };
  return {
    record: {
      ...baseRecord("WorkspaceReplayEventRecord", "workspace.replay.report", UNKNOWN_PRIOR, 0.4, sourceRef, ctx, idempotencyKey, { reportKind: input.reportKind }),
      recordType: "WorkspaceReplayEventRecord",
      eventTypeId: "EvidenceLinked",
      payload: toJsonValue({
        reportKind: input.reportKind,
        bodyHash: digest(input.body),
        workspaceId: ctx.workspace.id,
        generatedBy: ANALYZER_ID
      })
    }
  };
}

export function workspaceCoreFusionToMouthContext(input: {
  evidence: EvidenceSpan[];
  graphNodes: GraphNode[];
  graphEdges: GraphEdge[];
  proofClaims: ProofClaim[];
  proofEvidence: ProofEvidenceRecord[];
  learningNeeds: LearningNeed[];
  programPlannerInputs: WorkspaceProgramPlannerInput[];
  contradictions: WorkspaceContradictionRecord[];
  gaps: WorkspaceGapRecord[];
  tasks: WorkspaceTaskRecord[];
}): WorkspaceCoreMouthContext {
  return {
    schema: "scce.workspace_core.mouth_context.v1",
    evidence: input.evidence,
    graphNodes: input.graphNodes,
    graphEdges: input.graphEdges,
    proofClaims: input.proofClaims,
    proofEvidence: input.proofEvidence,
    learningNeeds: input.learningNeeds,
    programPlannerInputs: input.programPlannerInputs,
    contradictionRecordIds: input.contradictions.map(item => item.id),
    gapRecordIds: input.gaps.map(item => item.id),
    taskRecordIds: input.tasks.map(item => item.id),
    sourceRefs: uniqueRefs([
      ...input.contradictions.flatMap(item => item.sourceRef ? [item.sourceRef] : []),
      ...input.gaps.flatMap(item => item.sourceRef ? [item.sourceRef] : []),
      ...input.tasks.flatMap(item => item.sourceRef ? [item.sourceRef] : [])
    ])
  };
}

function workspaceDocClaimRecord(finding: WorkspaceCoreFindingInput, ctx: WorkspaceCorePromotionContext): RecordBuild<WorkspaceDocClaimRecord> {
  const sourceRef = primaryRef(finding);
  const idempotencyKey = idempotency("WorkspaceDocClaimRecord", ctx.workspace.id, finding.id, sourceRef);
  const missing = requiredFields({ workspaceId: ctx.workspace.id, corpusId: ctx.workspace.corpusId, sourcePath: sourceRef?.path, sourceRef: sourceRef ? "present" : undefined });
  if (!sourceRef || missing.length) return { rejected: rejectedRecord("WorkspaceDocClaimRecord", "workspace.reject.claim_source_ref_required", missing, idempotencyKey, sourceRef, finding) };
  const proofClaim = workspaceDocClaimToProofClaim({ workspaceFindingId: finding.id, kind: finding.kind, statement: finding.statement, sourceRef }, ctx);
  return {
    record: {
      ...baseRecord("WorkspaceDocClaimRecord", "workspace.doc_claim", DIRECT_EVIDENCE, clamp01(finding.confidence), sourceRef, ctx, idempotencyKey, { workspaceFindingId: finding.id }),
      recordType: "WorkspaceDocClaimRecord",
      workspaceFindingId: finding.id,
      proofClaim,
      proofEvidence: proofEvidenceFromStructured({
        id: coreId("workspace.proof.doc_claim", ctx.workspace.id, finding.id),
        forceClass: DIRECT_EVIDENCE,
        sourceRef,
        subjectId: proofClaim.subject.id ?? proofClaim.id,
        relationId: proofClaim.relationId,
        objectId: proofClaim.object.id ?? coreId("workspace.claim.object", finding.statement),
        text: finding.statement
      })
    }
  };
}

function reportEvents(input: WorkspaceCoreAnalysisInput, ctx: WorkspaceCorePromotionContext): Array<RecordBuild<WorkspaceReplayEventRecord>> {
  const reports = input.reports ?? {};
  const out: Array<RecordBuild<WorkspaceReplayEventRecord>> = [];
  for (const key of Object.keys(reports).sort()) {
    const body = reports[key];
    if (typeof body !== "string" || !body) continue;
    out.push(workspaceReportToReplayEvent({ reportKind: key, body }, ctx));
  }
  return out;
}

function sourceFileNode(source: WorkspaceCoreSourceFileInput, ctx: WorkspaceCorePromotionContext): GraphNode {
  const path = normalizePath(source.path);
  return graphNodeFor({
    id: nodeId("workspace.file", ctx.workspace.id, path),
    typeId: "workspace.node.file",
    representation: {
      sourcePath: path,
      mediaType: source.mediaType,
      byteLength: source.byteLength ?? 0,
      contentHash: source.contentHash ?? null
    },
    alpha: 0.64,
    evidenceIds: (source.evidenceIds ?? []).map(item => item as EvidenceId),
    features: ["workspace", "file", path, source.mediaType],
    createdAt: ctx.createdAt,
    metadata: { absolutePath: source.absolutePath ?? null, modifiedTime: source.modifiedTime ?? null }
  });
}

function findingGraphNode(record: WorkspaceContradictionRecord | WorkspaceGapRecord | WorkspaceTaskRecord): GraphNode {
  return graphNodeFor({
    id: nodeId("workspace.finding", record.workspaceId, record.id),
    typeId: record.recordType === "WorkspaceContradictionRecord" ? "workspace.node.contradiction" : record.recordType === "WorkspaceGapRecord" ? "workspace.node.gap" : "workspace.node.task",
    representation: {
      recordId: record.id,
      workspaceFindingId: record.workspaceFindingId,
      kind: record.kind,
      affectedFiles: record.affectedFiles
    },
    alpha: record.recordType === "WorkspaceContradictionRecord" ? 0.84 : 0.72,
    evidenceIds: record.sourceRef ? evidenceIdsFromRef(record.sourceRef) : [],
    features: ["workspace", record.kind, record.recordType, ...record.affectedFiles],
    createdAt: record.createdAt,
    metadata: { recordType: record.recordType, confidence: record.confidence }
  });
}

function sourceToRecordEdges(record: WorkspaceCoreRecord, relationId: string, ctx: WorkspaceCorePromotionContext): GraphEdge[] {
  if (!record.sourcePath) return [];
  return [
    graphEdgeFor({
      id: edgeId("workspace.edge", ctx.workspace.id, relationId, record.sourcePath, record.id),
      source: nodeId("workspace.file", ctx.workspace.id, normalizePath(record.sourcePath)),
      target: nodeId("workspace.finding", record.workspaceId, record.id),
      relationId,
      evidenceIds: record.sourceRef ? evidenceIdsFromRef(record.sourceRef) : [],
      weight: clamp01(record.confidence),
      createdAt: ctx.createdAt,
      metadata: { recordId: record.id, recordType: record.recordType }
    })
  ];
}

function hydrationContract(records: readonly WorkspaceCoreRecord[], rejected: readonly WorkspaceCoreRejectedRecord[]): WorkspaceCoreHydrationContract {
  const missingRequiredFields = rejected.map(item => ({ recordId: item.id, recordType: item.recordType, fields: item.missingRequiredFields }));
  const byDestination = new Map<string, { destinationStoreId: string; recordType: WorkspaceCoreRecordType; count: number }>();
  for (const record of records) {
    const key = `${record.destinationStoreId}:${record.recordType}`;
    const current = byDestination.get(key) ?? { destinationStoreId: record.destinationStoreId, recordType: record.recordType, count: 0 };
    current.count++;
    byDestination.set(key, current);
  }
  return {
    schema: "scce.workspace_core.hydration.v1",
    acceptedRecords: records.length,
    rejectedRecords: [...rejected],
    missingRequiredFields,
    destinationStores: [...byDestination.values()].sort((a, b) => a.destinationStoreId.localeCompare(b.destinationStoreId) || a.recordType.localeCompare(b.recordType)),
    idempotencyKeys: records.map(item => item.idempotencyKey).sort(),
    safeToHydrate: rejected.length === 0 && unique(records.map(item => item.idempotencyKey)).length === records.length
  };
}

function collectRecords<T extends WorkspaceCoreRecord>(
  _input: WorkspaceCoreAnalysisInput,
  _ctx: WorkspaceCorePromotionContext,
  rejected: WorkspaceCoreRejectedRecord[],
  builds: Array<RecordBuild<T>>
): T[] {
  const records: T[] = [];
  for (const build of builds) {
    if (build.record) records.push(build.record);
    if (build.rejected) rejected.push(build.rejected);
  }
  return dedupeById(records);
}

function baseRecord(
  recordType: WorkspaceCoreRecordType,
  kind: string,
  forceClass: ProofForceClass,
  confidence: number,
  sourceRef: WorkspaceCoreSourceRef | undefined,
  ctx: WorkspaceCorePromotionContext,
  idempotencyKey: string,
  metadata: unknown
): Omit<WorkspaceCoreRecordBase, "recordType"> {
  const id = coreId(recordType, idempotencyKey);
  const sourcePath = sourceRef?.path ? normalizePath(sourceRef.path) : undefined;
  const sourceHash = sourceRef?.contentHash ?? (sourcePath ? ctx.sourceByPath.get(sourcePath)?.contentHash : undefined);
  return {
    id,
    workspaceId: ctx.workspace.id,
    corpusId: ctx.workspace.corpusId,
    sourcePath,
    sourceHash,
    sourceRef,
    kind,
    confidence: clamp01(confidence),
    forceClass,
    provenance: provenanceFor(ctx, sourceRef),
    analyzer: { id: ANALYZER_ID, version: ANALYZER_VERSION },
    replayTraceId: ctx.replayTraceId,
    idempotencyKey,
    destinationStoreId: DESTINATIONS[recordType],
    createdAt: ctx.createdAt,
    updatedAt: ctx.createdAt,
    metadata: toJsonValue(metadata)
  };
}

function evidenceSpanForFinding(finding: WorkspaceCoreFindingInput, sourceRef: WorkspaceCoreSourceRef, ctx: WorkspaceCorePromotionContext): EvidenceSpan {
  const text = finding.statement || finding.kind;
  const contentHash = (sourceRef.contentHash ?? digest([ctx.workspace.id, finding.id, text])) as ContentHash;
  const sourceVersionId = sourceVersionIdFor(ctx, sourceRef);
  return {
    id: (sourceRef.evidenceSpanId ?? coreId("workspace.evidence", ctx.workspace.id, finding.id, sourceRef.path)) as EvidenceId,
    sourceId: sourceIdFor(ctx, sourceRef),
    sourceVersionId,
    chunkId: chunkIdFor(ctx, sourceRef),
    contentHash,
    mediaType: "application/vnd.scce.workspace-finding+json",
    byteStart: 0,
    byteEnd: utf8Length(text),
    charStart: 0,
    charEnd: text.length,
    text,
    textPreview: text.slice(0, 240),
    languageHints: toJsonValue({ source: "workspace.finding" }),
    scriptHints: toJsonValue({ source: "workspace.finding" }),
    trustVector: toJsonValue({ analyzer: ANALYZER_ID, confidence: clamp01(finding.confidence), forceClass: DIRECT_EVIDENCE }),
    provenance: toJsonValue(provenanceFor(ctx, sourceRef)),
    features: featuresFromParts([finding.kind, finding.severity, ...finding.affectedFiles, sourceRef.path]),
    status: "promoted",
    alpha: 0.76,
    observedAt: ctx.createdAt
  };
}

function proofEvidenceFromStructured(input: { id: string; forceClass: ProofForceClass; sourceRef: WorkspaceCoreSourceRef; subjectId: string; relationId: string; objectId: string; text?: string }): ProofEvidenceRecord {
  return {
    id: input.id,
    forceClass: input.forceClass,
    sourceVersionId: sourceVersionIdFromRef(input.sourceRef),
    evidenceSpanId: input.sourceRef.evidenceSpanId,
    subject: { id: input.subjectId, kindId: "workspace.proof.subject" },
    relationId: input.relationId,
    object: { id: input.objectId, surface: input.objectId, kindId: "workspace.proof.object" },
    polarityId: "polarity.positive",
    modalityId: "modality.reported",
    text: input.text
  };
}

function graphNodeFor(input: {
  id: NodeId;
  typeId: string;
  representation: unknown;
  alpha: number;
  evidenceIds: EvidenceId[];
  features: string[];
  createdAt: number;
  metadata: unknown;
}): GraphNode {
  return {
    id: input.id,
    typeId: input.typeId as GraphNode["typeId"],
    representation: toJsonValue(input.representation),
    alpha: clamp01(input.alpha),
    evidenceIds: input.evidenceIds,
    features: featuresFromParts(input.features),
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    metadata: toJsonValue(input.metadata)
  };
}

function graphEdgeFor(input: {
  id: EdgeId;
  source: NodeId;
  target: NodeId;
  relationId: string;
  evidenceIds: EvidenceId[];
  weight: number;
  createdAt: number;
  metadata: unknown;
}): GraphEdge {
  return {
    id: input.id,
    source: input.source,
    target: input.target,
    relationId: input.relationId as RelationId,
    alpha: clamp01(input.weight),
    weight: clamp01(input.weight),
    temporalScope: { validFrom: input.createdAt },
    evidenceIds: input.evidenceIds,
    createdAt: input.createdAt,
    updatedAt: input.createdAt,
    metadata: toJsonValue(input.metadata)
  };
}

function provenanceFor(ctx: WorkspaceCorePromotionContext, sourceRef: WorkspaceCoreSourceRef | undefined): WorkspaceCoreProvenance {
  return {
    workspaceId: ctx.workspace.id,
    corpusId: ctx.workspace.corpusId,
    rootPath: ctx.workspace.rootPath,
    analyzerId: ANALYZER_ID,
    analyzerVersion: ANALYZER_VERSION,
    originatingAnalyzerId: "workspace.runtime",
    replayTraceId: ctx.replayTraceId,
    sourcePath: sourceRef?.path,
    sourceHash: sourceRef?.contentHash ?? (sourceRef?.path ? ctx.sourceByPath.get(normalizePath(sourceRef.path))?.contentHash : undefined),
    evidenceSpanId: sourceRef?.evidenceSpanId
  };
}

function rejectedRecord(recordType: WorkspaceCoreRecordType, reasonId: string, missingRequiredFields: string[], idempotencyKey: string, sourceRef: WorkspaceCoreSourceRef | undefined, metadata: unknown): WorkspaceCoreRejectedRecord {
  return {
    id: coreId("workspace.rejected", recordType, idempotencyKey),
    recordType,
    reasonId,
    missingRequiredFields,
    idempotencyKey,
    sourceRef,
    metadata: toJsonValue(metadata)
  };
}

function requiredFields(fields: Record<string, unknown>): string[] {
  const missing: string[] = [];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === "") missing.push(key);
  }
  return missing;
}

function primaryRef(finding: WorkspaceCoreFindingInput): WorkspaceCoreSourceRef | undefined {
  return uniqueRefs(finding.sourceRefs)[0];
}

function refFromSource(ctx: WorkspaceCorePromotionContext, filePath: string): WorkspaceCoreSourceRef | undefined {
  const source = ctx.sourceByPath.get(normalizePath(filePath));
  if (!source) return undefined;
  return { path: source.path, contentHash: source.contentHash, evidenceSpanId: source.evidenceIds?.[0] };
}

function evidenceIdsFromRef(ref: WorkspaceCoreSourceRef): EvidenceId[] {
  return ref.evidenceSpanId ? [ref.evidenceSpanId as EvidenceId] : [];
}

function sourceVersionIdFor(ctx: WorkspaceCorePromotionContext, ref: WorkspaceCoreSourceRef): SourceVersionId {
  return (sourceVersionIdFromRef(ref) ?? coreId("workspace.source_version", ctx.workspace.id, ref.path, ref.contentHash ?? "")) as SourceVersionId;
}

function sourceVersionIdFromRef(ref: WorkspaceCoreSourceRef): string | undefined {
  if (!ref.contentHash) return undefined;
  return coreId("workspace.source_version", ref.path, ref.contentHash);
}

function sourceIdFor(ctx: WorkspaceCorePromotionContext, ref: WorkspaceCoreSourceRef): SourceId {
  return coreId("workspace.source", ctx.workspace.id, ref.path) as SourceId;
}

function chunkIdFor(ctx: WorkspaceCorePromotionContext, ref: WorkspaceCoreSourceRef): ChunkId {
  return coreId("workspace.chunk", ctx.workspace.id, ref.path, ref.lineStart ?? 0, ref.lineEnd ?? 0) as ChunkId;
}

function nodeId(...parts: unknown[]): NodeId {
  return coreId(...parts) as NodeId;
}

function edgeId(...parts: unknown[]): EdgeId {
  return coreId(...parts) as EdgeId;
}

function idempotency(...parts: unknown[]): string {
  return coreId("workspace.idempotency", ...parts);
}

function coreId(...parts: unknown[]): string {
  return `wc_${digest(parts).slice(0, 48)}`;
}

function digest(value: unknown): string {
  return createHasher().digestHex(canonicalStringify(value));
}

function utf8Length(value: string): number {
  let bytes = 0;
  for (const ch of value) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp <= 0x7f) bytes += 1;
    else if (cp <= 0x7ff) bytes += 2;
    else if (cp <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}

function normalizePath(value: string): string {
  return value.split("\\").join("/").split("/").filter(Boolean).join("/");
}

function featuresFromParts(parts: readonly unknown[]): string[] {
  const out = new Set<string>();
  for (const part of parts) {
    const value = typeof part === "string" ? part : canonicalStringify(part);
    for (const symbol of symbols(value)) out.add(`sym:${symbol}`);
  }
  return [...out].sort().slice(0, 200);
}

function symbols(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const ch of value.normalize("NFKC").toLocaleLowerCase()) {
    if (symbolChar(ch)) current += ch;
    else if (current) {
      out.push(current);
      current = "";
    }
  }
  if (current) out.push(current);
  return out;
}

function symbolChar(ch: string): boolean {
  if (!ch) return false;
  const cp = ch.codePointAt(0) ?? 0;
  return cp === 95 || cp === 36 || cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && ch.trim() !== "";
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function uniqueRefs(refs: readonly WorkspaceCoreSourceRef[]): WorkspaceCoreSourceRef[] {
  const seen = new Map<string, WorkspaceCoreSourceRef>();
  for (const ref of refs) {
    const key = `${normalizePath(ref.path)}:${ref.lineStart ?? ""}:${ref.lineEnd ?? ""}:${ref.evidenceSpanId ?? ""}:${ref.contentHash ?? ""}`;
    if (!seen.has(key)) seen.set(key, { ...ref, path: normalizePath(ref.path) });
  }
  return [...seen.values()];
}

function dedupeById<T extends { id: string }>(records: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const record of records) if (!seen.has(record.id)) seen.set(record.id, record);
  return [...seen.values()].sort((a, b) => a.id.localeCompare(b.id));
}
