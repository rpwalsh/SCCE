import { hashPatchContent } from "./patch-transaction.js";
import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import { canonicalTypeScriptDiagnosticIdentity } from "./program-repair-kernel.js";
import type { Hasher, JsonValue } from "./types.js";
import type {
  WorkspaceAnswerActionGraph,
  WorkspaceProgramContext,
  WorkspaceSemanticProgramObservation
} from "./workspace-kernel-context.js";
import {
  createWorkspaceRevisionSnapshot,
  type WorkspaceCodingRequest,
  type WorkspacePatchValidationPlan,
  type WorkspaceRevisionFile,
  type WorkspaceRevisionSnapshot,
  type WorkspaceValidationCheckId
} from "./workspace-plan-generator.js";

export const WORKSPACE_TASK_CONSTRAINT_GRAPH_SCHEMA = "scce.workspace.task_constraint_graph.v1" as const;

export interface WorkspaceConstraintEvidenceSpan {
  readonly path: string;
  readonly contentHash: string;
  readonly start: number;
  readonly length: number;
  readonly end: number;
  readonly startLine: number;
  readonly startColumn: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly textHash: string;
}

export interface WorkspaceConstraintSemanticFile {
  readonly id: string;
  readonly path: string;
  readonly contentHash: string;
  readonly charLength: number;
  readonly compilerOwned: boolean;
  readonly observedTest: boolean;
  readonly span: WorkspaceConstraintEvidenceSpan;
}

export interface WorkspaceConstraintSemanticSymbol {
  readonly id: string;
  readonly declarationIds: readonly string[];
}

export interface WorkspaceConstraintSemanticDeclaration {
  readonly id: string;
  readonly fileId: string;
  readonly symbolId: string;
  readonly span: WorkspaceConstraintEvidenceSpan;
  readonly nameSpan: WorkspaceConstraintEvidenceSpan;
}

export interface WorkspaceConstraintSemanticReference {
  readonly id: string;
  readonly fileId: string;
  readonly targetSymbolId: string;
  readonly declarationOccurrence: boolean;
  readonly span: WorkspaceConstraintEvidenceSpan;
}

export interface WorkspaceConstraintSemanticImport {
  readonly id: string;
  readonly fileId: string;
  readonly targetFileId?: string;
  readonly span: WorkspaceConstraintEvidenceSpan;
  readonly moduleSpecifierSpan: WorkspaceConstraintEvidenceSpan;
  readonly bindings: readonly { readonly span: WorkspaceConstraintEvidenceSpan; readonly targetSymbolId?: string }[];
}

export interface WorkspaceConstraintSemanticCall {
  readonly id: string;
  readonly fileId: string;
  readonly targetSymbolId: string;
  readonly span: WorkspaceConstraintEvidenceSpan;
  readonly calleeSpan: WorkspaceConstraintEvidenceSpan;
}

export interface WorkspaceConstraintSemanticDiagnostic {
  readonly id: string;
  readonly compilerCode: number;
  readonly compilerCategory: number;
  readonly originIds: readonly string[];
  readonly messageHash: string;
  readonly rawMessageEvidence?: string;
  readonly span?: WorkspaceConstraintEvidenceSpan;
  readonly relatedEvidence?: readonly { readonly messageHash: string; readonly span?: WorkspaceConstraintEvidenceSpan }[];
}

export interface WorkspaceConstraintSemanticCommand {
  readonly id: string;
  readonly sourceFileId: string;
  readonly sourceNameEvidence: string;
  readonly rawCommandEvidence: string;
  readonly nameSpan: WorkspaceConstraintEvidenceSpan;
  readonly commandSpan: WorkspaceConstraintEvidenceSpan;
}

export interface WorkspaceConstraintSemanticProgram {
  readonly revisionHash: string;
  readonly config: {
    readonly id: string;
    readonly path: string;
    readonly contentHash: string;
    readonly compilerVersion?: string;
    readonly compilerOptionsHash?: string;
    readonly span: WorkspaceConstraintEvidenceSpan;
  };
  readonly files: readonly WorkspaceConstraintSemanticFile[];
  readonly symbols: readonly WorkspaceConstraintSemanticSymbol[];
  readonly declarations: readonly WorkspaceConstraintSemanticDeclaration[];
  readonly references: readonly WorkspaceConstraintSemanticReference[];
  readonly imports: readonly WorkspaceConstraintSemanticImport[];
  readonly calls: readonly WorkspaceConstraintSemanticCall[];
  readonly diagnostics: readonly WorkspaceConstraintSemanticDiagnostic[];
  readonly configOwnership: readonly {
    readonly id: string;
    readonly configId: string;
    readonly fileId: string;
    readonly configSpan: WorkspaceConstraintEvidenceSpan;
    readonly fileSpan: WorkspaceConstraintEvidenceSpan;
  }[];
  readonly commands: readonly WorkspaceConstraintSemanticCommand[];
  readonly testRelations: readonly {
    readonly id: string;
    readonly testFileId: string;
    readonly targetFileId?: string;
    readonly targetSymbolId?: string;
    readonly evidenceSpan: WorkspaceConstraintEvidenceSpan;
  }[];
}

export interface WorkspaceRequestedOutcomeConstraint {
  readonly id: string;
  readonly postconditionId: string;
  readonly affectedPath: string;
  readonly evidenceSpanIds: readonly string[];
}

export interface WorkspaceValidationCommandBinding {
  readonly id: string;
  readonly checkId: WorkspaceValidationCheckId;
  readonly commandId: string;
}

export interface BuildWorkspaceTaskConstraintGraphInput {
  readonly revision: WorkspaceRevisionSnapshot;
  readonly observation: WorkspaceSemanticProgramObservation<WorkspaceConstraintSemanticProgram>;
  readonly request: WorkspaceCodingRequest;
  readonly programContext?: Pick<WorkspaceProgramContext, "patchPlans">;
  readonly preservation?: WorkspaceAnswerActionGraph["preservation"];
  readonly requestedOutcomes?: readonly WorkspaceRequestedOutcomeConstraint[];
  readonly validationPlan: WorkspacePatchValidationPlan;
  readonly validationCommandBindings?: readonly WorkspaceValidationCommandBinding[];
}

export interface WorkspaceTaskConstraintNode {
  readonly id: string;
  readonly kindId: string;
  readonly subjectId: string;
  readonly path?: string;
  readonly evidenceSpanIds: readonly string[];
  readonly contentHashes: readonly string[];
  readonly metadata: JsonValue;
}

export interface WorkspaceTaskConstraintEdge {
  readonly id: string;
  readonly relationId: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly evidenceSpanIds: readonly string[];
}

export interface WorkspaceTaskUnresolvedConstraint {
  readonly id: string;
  readonly nodeId: string;
  readonly reasonId: string;
  readonly subjectIds: readonly string[];
  readonly path?: string;
  readonly evidenceSpanIds: readonly string[];
}

export interface WorkspaceTaskConstraintEvidenceRecord extends WorkspaceConstraintEvidenceSpan {
  readonly id: string;
}

export interface WorkspaceTaskConstraintGraph {
  readonly schema: typeof WORKSPACE_TASK_CONSTRAINT_GRAPH_SCHEMA;
  readonly id: string;
  readonly workspaceRevision: {
    readonly workspaceId: string;
    readonly revisionId: string;
    readonly revisionHash: string;
  };
  readonly analyzerRevision: {
    readonly analyzerId: string;
    readonly analyzerVersion: string;
    readonly semanticRevisionHash: string;
    readonly compilerContext: {
      readonly configPath: string;
      readonly configContentHash: string;
      readonly compilerVersion: string;
      readonly compilerOptionsHash: string;
    } | null;
  };
  readonly requestId: string;
  readonly nodes: readonly WorkspaceTaskConstraintNode[];
  readonly edges: readonly WorkspaceTaskConstraintEdge[];
  readonly evidenceSpans: readonly WorkspaceTaskConstraintEvidenceRecord[];
  readonly requestedOutcomeNodeIds: readonly string[];
  readonly protectedInvariantNodeIds: readonly string[];
  readonly affectedFileNodeIds: readonly string[];
  readonly affectedSymbolNodeIds: readonly string[];
  readonly diagnosticNodeIds: readonly string[];
  readonly dependencyNodeIds: readonly string[];
  readonly admissibleValidationCommandNodeIds: readonly string[];
  readonly unresolvedConstraints: readonly WorkspaceTaskUnresolvedConstraint[];
  readonly execution: { readonly state: "not_executed" };
  readonly audit: JsonValue;
}

export type WorkspaceTaskConstraintGraphIdentityInput = Omit<WorkspaceTaskConstraintGraph, "id">;

export function workspaceTaskConstraintEvidenceSpanId(
  span: WorkspaceConstraintEvidenceSpan,
  hasher: Hasher = createHasher()
): string {
  return `tc_span_${hasher.digestHex(canonicalStringify(canonicalSpan(span))).slice(0, 40)}`;
}

export function workspaceTaskConstraintGraphId(
  graph: WorkspaceTaskConstraintGraphIdentityInput,
  hasher: Hasher = createHasher()
): string {
  const payload = canonicalGraphPayload(graph);
  return `task_constraint_graph_${hasher.digestHex(canonicalStringify(payload)).slice(0, 40)}`;
}

/** Revalidates every content-addressed graph component and its revision cross-links. */
export function verifyWorkspaceTaskConstraintGraph(
  graph: WorkspaceTaskConstraintGraph,
  revision: WorkspaceRevisionSnapshot,
  hasher: Hasher = createHasher()
): void {
  const reconstructed = createWorkspaceRevisionSnapshot({
    workspaceId: revision.workspaceId,
    revisionId: revision.revisionId,
    files: revision.files.map(file => ({ path: file.path, bytes: file.bytes, mediaType: file.mediaType, role: file.role }))
  }, hasher);
  if (!revision.complete || reconstructed.revisionHash !== revision.revisionHash
    || graph.schema !== WORKSPACE_TASK_CONSTRAINT_GRAPH_SCHEMA
    || graph.execution.state !== "not_executed"
    || graph.workspaceRevision.workspaceId !== revision.workspaceId
    || graph.workspaceRevision.revisionId !== revision.revisionId
    || graph.workspaceRevision.revisionHash !== revision.revisionHash) {
    throw new Error("task constraint graph revision binding is invalid");
  }

  const revisionByPath = uniqueMap(revision.files, file => file.path, "revision path");
  const textByPath = new Map<string, string>();
  const evidenceById = uniqueMap(graph.evidenceSpans, evidence => evidence.id, "constraint evidence");
  for (const evidence of graph.evidenceSpans) {
    assertExactSpan(evidence, revisionByPath, textByPath);
    if (evidence.id !== workspaceTaskConstraintEvidenceSpanId(evidence, hasher)) {
      throw new Error("task constraint evidence identity is invalid");
    }
  }

  const nodeById = uniqueMap(graph.nodes, node => node.id, "constraint node");
  for (const node of graph.nodes) {
    if (!node.kindId || !node.subjectId || node.kindId.includes("\u0000") || node.subjectId.includes("\u0000")) {
      throw new Error("task constraint node identity fields are invalid");
    }
    if (node.path !== undefined) validateWorkspacePath(node.path);
    assertCanonicalStringArray(node.evidenceSpanIds, "constraint node evidence");
    assertCanonicalStringArray(node.contentHashes, "constraint node content hashes");
    for (const id of node.evidenceSpanIds) if (!evidenceById.has(id)) throw new Error("task constraint node evidence is absent");
    for (const hash of node.contentHashes) requiredHash(hash);
    const expected = opaqueId(hasher, "tc_node", node.kindId, node.subjectId, node.path ?? "", ...node.evidenceSpanIds, ...node.contentHashes);
    if (node.id !== expected) throw new Error("task constraint node identity is invalid");
  }

  const edgeById = uniqueMap(graph.edges, edge => edge.id, "constraint edge");
  for (const edge of graph.edges) {
    assertCanonicalStringArray(edge.evidenceSpanIds, "constraint edge evidence");
    if (!nodeById.has(edge.sourceId) || !nodeById.has(edge.targetId)) throw new Error("task constraint edge endpoint is absent");
    for (const id of edge.evidenceSpanIds) if (!evidenceById.has(id)) throw new Error("task constraint edge evidence is absent");
    const expected = opaqueId(hasher, "tc_edge", edge.relationId, edge.sourceId, edge.targetId, ...edge.evidenceSpanIds);
    if (edge.id !== expected) throw new Error("task constraint edge identity is invalid");
  }

  verifyIndexedNodes(graph.requestedOutcomeNodeIds, graph, nodeById, "scce.task.outcome.v1", "requested outcome");
  verifyIndexedNodes(graph.protectedInvariantNodeIds, graph, nodeById, "scce.task.invariant.protected_file.v1", "protected invariant");
  verifyIndexedNodes(graph.affectedFileNodeIds, graph, nodeById, "scce.program.file.v1", "affected file");
  verifyIndexedNodes(graph.affectedSymbolNodeIds, graph, nodeById, "scce.program.symbol.v1", "affected symbol");
  verifyIndexedNodes(graph.diagnosticNodeIds, graph, nodeById, "scce.program.diagnostic.v1", "diagnostic");
  verifyIndexedNodes(graph.admissibleValidationCommandNodeIds, graph, nodeById, "scce.task.validation.command.v1", "validation command");
  assertCanonicalStringArray(graph.dependencyNodeIds, "dependency index");
  for (const id of graph.dependencyNodeIds) {
    const node = nodeById.get(id);
    if (!node || !node.kindId.startsWith("scce.task.dependency.")) throw new Error("dependency index is invalid");
  }

  const unresolvedById = uniqueMap(graph.unresolvedConstraints, item => item.id, "unresolved constraint");
  void unresolvedById;
  for (const item of graph.unresolvedConstraints) {
    assertCanonicalStringArray(item.subjectIds, "unresolved subjects");
    assertCanonicalStringArray(item.evidenceSpanIds, "unresolved evidence");
    const node = nodeById.get(item.nodeId);
    if (!node || node.kindId !== "scce.constraint.unresolved.v1") throw new Error("unresolved constraint node is invalid");
    if (item.path !== undefined) validateWorkspacePath(item.path);
    for (const id of item.evidenceSpanIds) if (!evidenceById.has(id)) throw new Error("unresolved constraint evidence is absent");
    if (item.id !== opaqueId(hasher, "tc_unresolved", item.reasonId, item.nodeId)) {
      throw new Error("unresolved constraint identity is invalid");
    }
    if (metadataRecord(node.metadata).reasonId !== item.reasonId) throw new Error("unresolved constraint metadata is invalid");
  }

  const compiler = graph.analyzerRevision.compilerContext;
  if (compiler) {
    const config = revisionByPath.get(compiler.configPath);
    if (!config || config.contentHash !== requiredHash(compiler.configContentHash)
      || compiler.compilerVersion !== graph.analyzerRevision.analyzerVersion) {
      throw new Error("task constraint compiler context is invalid");
    }
    requiredHash(compiler.compilerOptionsHash);
  }
  if (graph.id !== workspaceTaskConstraintGraphId(graph, hasher)) throw new Error("task constraint graph identity is invalid");

  // Verify the decision-bearing indexes have the graph relations their names assert.
  const requests = graph.nodes.filter(node => node.kindId === "scce.task.request.v1");
  if (requests.length !== 1) throw new Error("task constraint request node is invalid");
  const requestId = requests[0]!.id;
  for (const id of graph.affectedFileNodeIds) requireEdge(graph, "scce.rel.task.affects_file.v1", requestId, id);
  for (const id of graph.requestedOutcomeNodeIds) requireEdge(graph, "scce.rel.task.requires_outcome.v1", requestId, id);
  for (const id of graph.admissibleValidationCommandNodeIds) requireEdge(graph, "scce.rel.task.request_requires_validation.v1", requestId, id);
  for (const id of graph.protectedInvariantNodeIds) {
    if (!graph.edges.some(edge => edge.relationId === "scce.rel.task.invariant_protects_file.v1" && edge.sourceId === id)) {
      throw new Error("protected invariant cross-link is absent");
    }
  }
  void edgeById;
}

/** Builds a constraint graph without interpreting request prose or mutating state. */
export function buildWorkspaceTaskConstraintGraph(
  input: BuildWorkspaceTaskConstraintGraphInput,
  hasher: Hasher = createHasher()
): WorkspaceTaskConstraintGraph {
  assertRevisionAndObservation(input);
  const program = input.observation.program;
  const hasCompilerVersion = typeof program.config.compilerVersion === "string" && program.config.compilerVersion.length > 0;
  const hasCompilerOptionsHash = typeof program.config.compilerOptionsHash === "string" && program.config.compilerOptionsHash.length > 0;
  if (hasCompilerVersion !== hasCompilerOptionsHash) throw new Error("semantic compiler context is incomplete");
  const compilerContext = hasCompilerVersion && hasCompilerOptionsHash
    ? {
      configPath: validateWorkspacePath(program.config.path),
      configContentHash: requiredHash(program.config.contentHash),
      compilerVersion: requiredId(program.config.compilerVersion!, "compilerVersion"),
      compilerOptionsHash: requiredHash(program.config.compilerOptionsHash!)
    }
    : null;
  if (compilerContext && compilerContext.compilerVersion !== input.observation.analyzer.version) {
    throw new Error("semantic compiler version does not match the analyzer revision");
  }
  const revisionByPath = new Map(input.revision.files.map(file => [file.path, file]));
  const semanticFileById = new Map(program.files.map(file => [file.id, file]));
  const semanticFileByPath = new Map(program.files.map(file => [file.path, file]));
  const symbolById = new Map(program.symbols.map(symbol => [symbol.id, symbol]));
  const evidenceById = new Map<string, WorkspaceTaskConstraintEvidenceRecord>();
  const textByPath = new Map<string, string>();

  const registerSpan = (span: WorkspaceConstraintEvidenceSpan): string => {
    assertExactSpan(span, revisionByPath, textByPath);
    const id = workspaceTaskConstraintEvidenceSpanId(span, hasher);
    if (!evidenceById.has(id)) evidenceById.set(id, { id, ...canonicalSpan(span) });
    return id;
  };
  for (const span of semanticSpans(program)) registerSpan(span);

  const nodes = new Map<string, WorkspaceTaskConstraintNode>();
  const edges = new Map<string, WorkspaceTaskConstraintEdge>();
  const unresolved: WorkspaceTaskUnresolvedConstraint[] = [];
  const requestedOutcomeNodeIds = new Set<string>();
  const protectedInvariantNodeIds = new Set<string>();
  const affectedFileNodeIds = new Set<string>();
  const affectedSymbolNodeIds = new Set<string>();
  const diagnosticNodeIds = new Set<string>();
  const dependencyNodeIds = new Set<string>();
  const validationCommandNodeIds = new Set<string>();

  const addNode = (spec: Omit<WorkspaceTaskConstraintNode, "id">): WorkspaceTaskConstraintNode => {
    const evidenceSpanIds = uniqueSorted(spec.evidenceSpanIds);
    for (const id of evidenceSpanIds) if (!evidenceById.has(id)) throw new Error(`task constraint node references unknown exact evidence: ${id}`);
    const contentHashes = uniqueSorted(spec.contentHashes.map(requiredHash));
    const id = opaqueId(hasher, "tc_node", spec.kindId, spec.subjectId, spec.path ?? "", ...evidenceSpanIds, ...contentHashes);
    const node: WorkspaceTaskConstraintNode = { ...spec, id, evidenceSpanIds, contentHashes };
    nodes.set(id, node);
    return node;
  };
  const addEdge = (relationId: string, sourceId: string, targetId: string, evidenceSpanIds: readonly string[] = []): WorkspaceTaskConstraintEdge => {
    if (!nodes.has(sourceId) || !nodes.has(targetId)) throw new Error("task constraint edge endpoint is absent");
    const exactEvidence = uniqueSorted(evidenceSpanIds);
    for (const id of exactEvidence) if (!evidenceById.has(id)) throw new Error(`task constraint edge references unknown exact evidence: ${id}`);
    const id = opaqueId(hasher, "tc_edge", relationId, sourceId, targetId, ...exactEvidence);
    const edge = { id, relationId, sourceId, targetId, evidenceSpanIds: exactEvidence };
    edges.set(id, edge);
    return edge;
  };
  const addUnresolved = (reasonId: string, subjectIds: readonly string[], path?: string, evidenceSpanIds: readonly string[] = []): void => {
    const exactEvidence = uniqueSorted(evidenceSpanIds);
    const subject = uniqueSorted(subjectIds);
    const node = addNode({
      kindId: "scce.constraint.unresolved.v1",
      subjectId: opaqueId(hasher, "tc_unresolved_subject", reasonId, path ?? "", ...subject),
      path,
      evidenceSpanIds: exactEvidence,
      contentHashes: exactEvidence.map(id => evidenceById.get(id)!.contentHash),
      metadata: toJsonValue({ reasonId, subjectIds: subject })
    });
    unresolved.push({ id: opaqueId(hasher, "tc_unresolved", reasonId, node.id), nodeId: node.id, reasonId, subjectIds: subject, path, evidenceSpanIds: exactEvidence });
  };

  const requestNode = addNode({
    kindId: "scce.task.request.v1",
    subjectId: requiredId(input.request.requestId, "requestId"),
    evidenceSpanIds: [],
    contentHashes: [],
    metadata: toJsonValue({ evidenceIds: uniqueSorted(input.request.evidenceIds), requestedPaths: uniqueSorted(input.request.requestedPaths) })
  });

  const affectedPaths = new Set<string>();
  for (const path of input.request.requestedPaths) affectedPaths.add(validateWorkspacePath(path));
  for (const plan of input.programContext?.patchPlans ?? []) {
    const taskNode = addNode({
      kindId: "scce.task.structured.v1",
      subjectId: requiredId(plan.workspaceTaskRecordId, "workspaceTaskRecordId"),
      evidenceSpanIds: [],
      contentHashes: [],
      metadata: toJsonValue({ plannerInputId: plan.plannerInputId, workspaceTaskId: plan.workspaceTaskId, evidenceIds: uniqueSorted(plan.evidenceSpanIds) })
    });
    addEdge("scce.rel.task.request_includes.v1", requestNode.id, taskNode.id);
    for (const path of plan.affectedFiles) affectedPaths.add(validateWorkspacePath(path));
  }
  for (const outcome of input.requestedOutcomes ?? []) affectedPaths.add(validateWorkspacePath(outcome.affectedPath));

  const fileNodeByPath = new Map<string, WorkspaceTaskConstraintNode>();
  const ensureFileNode = (workspacePath: string): WorkspaceTaskConstraintNode | undefined => {
    const path = validateWorkspacePath(workspacePath);
    const existing = fileNodeByPath.get(path);
    if (existing) return existing;
    const revisionFile = revisionByPath.get(path);
    if (!revisionFile) return undefined;
    const semantic = semanticFileByPath.get(path);
    const span = semantic?.span ?? revisionFullSpan(revisionFile, textByPath);
    const spanId = registerSpan(span);
    const node = addNode({
      kindId: "scce.program.file.v1",
      subjectId: semantic?.id ?? opaqueId(hasher, "tc_revision_file", path, revisionFile.contentHash),
      path,
      evidenceSpanIds: [spanId],
      contentHashes: [revisionFile.contentHash],
      metadata: toJsonValue({ roleId: `scce.file.role.${revisionFile.role}.v1`, semanticObserved: Boolean(semantic), compilerOwned: semantic?.compilerOwned ?? false })
    });
    fileNodeByPath.set(path, node);
    return node;
  };

  for (const path of [...affectedPaths].sort(compareCanonical)) {
    const fileNode = ensureFileNode(path);
    if (!fileNode) {
      addUnresolved("scce.constraint.reason.affected_path_absent.v1", [requestNode.id], path);
      continue;
    }
    affectedFileNodeIds.add(fileNode.id);
    addEdge("scce.rel.task.affects_file.v1", requestNode.id, fileNode.id, fileNode.evidenceSpanIds);
  }

  const outcomesByPath = new Map<string, WorkspaceRequestedOutcomeConstraint[]>();
  for (const outcome of input.requestedOutcomes ?? []) {
    const path = validateWorkspacePath(outcome.affectedPath);
    const evidenceSpanIds = uniqueSorted(outcome.evidenceSpanIds);
    for (const id of evidenceSpanIds) if (!evidenceById.has(id)) throw new Error(`requested outcome references unknown exact evidence: ${id}`);
    const outcomeNode = addNode({
      kindId: "scce.task.outcome.v1",
      subjectId: requiredId(outcome.id, "requested outcome id"),
      path,
      evidenceSpanIds,
      contentHashes: evidenceSpanIds.map(id => evidenceById.get(id)!.contentHash),
      metadata: toJsonValue({ postconditionId: requiredId(outcome.postconditionId, "postconditionId") })
    });
    requestedOutcomeNodeIds.add(outcomeNode.id);
    addEdge("scce.rel.task.requires_outcome.v1", requestNode.id, outcomeNode.id, evidenceSpanIds);
    const fileNode = ensureFileNode(path);
    if (fileNode) addEdge("scce.rel.task.outcome_targets_file.v1", outcomeNode.id, fileNode.id, evidenceSpanIds);
    if (evidenceSpanIds.length === 0) addUnresolved("scce.constraint.reason.outcome_evidence_missing.v1", [outcomeNode.id], path);
    const entries = outcomesByPath.get(path) ?? [];
    entries.push(outcome);
    outcomesByPath.set(path, entries);
  }
  for (const path of uniqueSorted(input.request.requestedPaths.map(validateWorkspacePath))) {
    if (!outcomesByPath.has(path)) addUnresolved("scce.constraint.reason.requested_postcondition_missing.v1", [requestNode.id], path, ensureFileNode(path)?.evidenceSpanIds ?? []);
  }

  const occurrenceSpansBySymbol = new Map<string, WorkspaceConstraintEvidenceSpan[]>();
  for (const declaration of program.declarations) appendMap(occurrenceSpansBySymbol, declaration.symbolId, declaration.nameSpan);
  for (const reference of program.references) appendMap(occurrenceSpansBySymbol, reference.targetSymbolId, reference.span);
  for (const call of program.calls) appendMap(occurrenceSpansBySymbol, call.targetSymbolId, call.calleeSpan);
  const symbolNodeById = new Map<string, WorkspaceTaskConstraintNode>();
  for (const symbol of program.symbols) {
    const spans = (occurrenceSpansBySymbol.get(symbol.id) ?? []).filter(span => affectedPaths.has(span.path));
    if (spans.length === 0) continue;
    const evidenceSpanIds = uniqueSorted(spans.map(registerSpan));
    const node = addNode({
      kindId: "scce.program.symbol.v1",
      subjectId: symbol.id,
      evidenceSpanIds,
      contentHashes: evidenceSpanIds.map(id => evidenceById.get(id)!.contentHash),
      metadata: toJsonValue({ declarationIds: uniqueSorted(symbol.declarationIds) })
    });
    symbolNodeById.set(symbol.id, node);
    affectedSymbolNodeIds.add(node.id);
    for (const path of uniqueSorted(spans.map(span => span.path))) {
      const fileNode = ensureFileNode(path);
      if (fileNode) addEdge("scce.rel.program.file_contains_symbol.v1", fileNode.id, node.id, evidenceSpanIds.filter(id => evidenceById.get(id)?.path === path));
    }
  }

  for (const diagnostic of program.diagnostics) {
    if (!diagnostic.span || !affectedPaths.has(diagnostic.span.path)) continue;
    const spanId = registerSpan(diagnostic.span);
    const fileNode = ensureFileNode(diagnostic.span.path);
    if (!fileNode) continue;
    let diagnosticIdentity: string | null = null;
    if (compilerContext && diagnostic.rawMessageEvidence !== undefined) {
      if (requiredHash(diagnostic.messageHash) !== hashPatchContent(diagnostic.rawMessageEvidence)) {
        throw new Error(`semantic diagnostic message evidence is stale: ${diagnostic.id}`);
      }
      diagnosticIdentity = canonicalTypeScriptDiagnosticIdentity({
        path: diagnostic.span.path,
        diagnostic: {
          code: diagnostic.compilerCode,
          category: compilerDiagnosticCategoryName(diagnostic.compilerCategory),
          start: diagnostic.span.start,
          length: diagnostic.span.length,
          message: diagnostic.rawMessageEvidence
        },
        compilerVersion: compilerContext.compilerVersion,
        compilerOptionsHash: compilerContext.compilerOptionsHash
      });
    }
    const node = addNode({
      kindId: "scce.program.diagnostic.v1",
      subjectId: diagnostic.id,
      path: diagnostic.span.path,
      evidenceSpanIds: [spanId],
      contentHashes: [diagnostic.span.contentHash, requiredHash(diagnostic.messageHash)],
      metadata: toJsonValue({
        compilerCode: diagnostic.compilerCode,
        compilerCategory: diagnostic.compilerCategory,
        originIds: uniqueSorted(diagnostic.originIds),
        diagnosticIdentity
      })
    });
    diagnosticNodeIds.add(node.id);
    addEdge("scce.rel.program.file_has_diagnostic.v1", fileNode.id, node.id, [spanId]);
    for (const [symbolId, spans] of occurrenceSpansBySymbol) {
      if (!spans.some(span => spansOverlap(span, diagnostic.span!))) continue;
      const symbolNode = symbolNodeById.get(symbolId);
      if (symbolNode) addEdge("scce.rel.program.diagnostic_intersects_symbol.v1", node.id, symbolNode.id, [spanId]);
    }
  }

  const configFileNode = ensureFileNode(program.config.path);
  const ownershipByFileId = new Map<string, Array<(typeof program.configOwnership)[number]>>();
  for (const ownership of program.configOwnership) appendMap(ownershipByFileId, ownership.fileId, ownership);
  for (const path of [...affectedPaths].sort(compareCanonical)) {
    const semanticFile = semanticFileByPath.get(path);
    if (!semanticFile) continue;
    const ownership = ownershipByFileId.get(semanticFile.id) ?? [];
    if (semanticFile.compilerOwned && ownership.length === 0) {
      addUnresolved("scce.constraint.reason.config_ownership_missing.v1", [ensureFileNode(path)!.id], path, ensureFileNode(path)!.evidenceSpanIds);
    }
    for (const relation of ownership) {
      if (relation.configId !== program.config.id || !configFileNode) continue;
      const evidenceSpanIds = uniqueSorted([registerSpan(relation.configSpan), registerSpan(relation.fileSpan)]);
      const dependency = addNode({
        kindId: "scce.task.dependency.config.v1",
        subjectId: relation.id,
        path,
        evidenceSpanIds,
        contentHashes: evidenceSpanIds.map(id => evidenceById.get(id)!.contentHash),
        metadata: toJsonValue({ configId: relation.configId, fileId: relation.fileId })
      });
      dependencyNodeIds.add(dependency.id);
      addEdge("scce.rel.task.file_requires_config.v1", ensureFileNode(path)!.id, dependency.id, evidenceSpanIds);
      addEdge("scce.rel.task.dependency_targets_file.v1", dependency.id, configFileNode.id, [registerSpan(relation.configSpan)]);
    }
  }

  for (const relation of program.testRelations) {
    const targetFile = relation.targetFileId ? semanticFileById.get(relation.targetFileId) : undefined;
    const targetSymbol = relation.targetSymbolId ? symbolNodeById.get(relation.targetSymbolId) : undefined;
    if (!targetSymbol && (!targetFile || !affectedPaths.has(targetFile.path))) continue;
    const testFile = semanticFileById.get(relation.testFileId);
    if (!testFile) continue;
    const testFileNode = ensureFileNode(testFile.path);
    if (!testFileNode) continue;
    const evidenceSpanId = registerSpan(relation.evidenceSpan);
    const dependency = addNode({
      kindId: "scce.task.dependency.test.v1",
      subjectId: relation.id,
      path: testFile.path,
      evidenceSpanIds: [evidenceSpanId],
      contentHashes: [relation.evidenceSpan.contentHash],
      metadata: toJsonValue({ testFileId: relation.testFileId, targetFileId: relation.targetFileId, targetSymbolId: relation.targetSymbolId })
    });
    dependencyNodeIds.add(dependency.id);
    addEdge("scce.rel.task.target_has_test_dependency.v1", targetSymbol?.id ?? ensureFileNode(targetFile!.path)!.id, dependency.id, [evidenceSpanId]);
    addEdge("scce.rel.task.dependency_targets_file.v1", dependency.id, testFileNode.id, [evidenceSpanId]);
  }

  const explicitlyRequestedPaths = new Set(input.request.requestedPaths.map(validateWorkspacePath));
  const protectedPaths = new Set(input.revision.files
    .filter(file => file.role === "test" && !explicitlyRequestedPaths.has(file.path))
    .map(file => file.path));
  for (const path of input.preservation?.protectedFilePaths ?? []) protectedPaths.add(validateWorkspacePath(path));
  for (const path of input.preservation?.protectedSourcePaths ?? []) protectedPaths.add(validateWorkspacePath(path));
  for (const path of [...protectedPaths].sort(compareCanonical)) {
    const fileNode = ensureFileNode(path);
    if (!fileNode) {
      addUnresolved("scce.constraint.reason.protected_path_absent.v1", [requestNode.id], path);
      continue;
    }
    const invariant = addNode({
      kindId: "scce.task.invariant.protected_file.v1",
      subjectId: opaqueId(hasher, "tc_protected", path, ...fileNode.contentHashes),
      path,
      evidenceSpanIds: fileNode.evidenceSpanIds,
      contentHashes: fileNode.contentHashes,
      metadata: toJsonValue({ sourceIds: [input.revision.files.find(file => file.path === path)?.role === "test" ? "scce.policy.revision_role_test.v1" : "scce.policy.workspace_preservation.v1"], protectedEvidenceIds: uniqueSorted(input.preservation?.protectedEvidenceSpanIds ?? []) })
    });
    protectedInvariantNodeIds.add(invariant.id);
    addEdge("scce.rel.task.invariant_protects_file.v1", invariant.id, fileNode.id, fileNode.evidenceSpanIds);
    if (affectedPaths.has(path)) addUnresolved("scce.constraint.reason.protected_target_conflict.v1", [invariant.id, fileNode.id], path, fileNode.evidenceSpanIds);
  }

  const commandById = new Map(program.commands.map(command => [command.id, command]));
  const bindingsByCheck = new Map<WorkspaceValidationCheckId, WorkspaceValidationCommandBinding[]>();
  for (const binding of input.validationCommandBindings ?? []) {
    requiredId(binding.id, "validation command binding id");
    if (!input.validationPlan.checks.includes(binding.checkId)) throw new Error(`validation command binding check is outside the validation plan: ${binding.checkId}`);
    const command = commandById.get(binding.commandId);
    if (!command) throw new Error(`validation command binding references an unobserved command: ${binding.commandId}`);
    const sourceFile = semanticFileById.get(command.sourceFileId);
    if (!sourceFile) throw new Error(`validation command source file is absent: ${binding.commandId}`);
    if (hashDigest(hashPatchContent(JSON.stringify(command.sourceNameEvidence))) !== hashDigest(command.nameSpan.textHash)
      || hashDigest(hashPatchContent(JSON.stringify(command.rawCommandEvidence))) !== hashDigest(command.commandSpan.textHash)) {
      throw new Error(`validation command evidence is not bound to its exact source span: ${binding.commandId}`);
    }
    const evidenceSpanIds = uniqueSorted([registerSpan(command.nameSpan), registerSpan(command.commandSpan)]);
    const commandNode = addNode({
      kindId: "scce.task.validation.command.v1",
      subjectId: command.id,
      path: sourceFile.path,
      evidenceSpanIds,
      contentHashes: [command.commandSpan.contentHash, hashPatchContent(command.rawCommandEvidence)],
      metadata: toJsonValue({
        bindingId: binding.id,
        checkId: binding.checkId,
        commandId: command.id,
        sourceSelector: `scripts.${command.sourceNameEvidence}`,
        commandHash: hashPatchContent(command.rawCommandEvidence)
      })
    });
    validationCommandNodeIds.add(commandNode.id);
    addEdge("scce.rel.task.request_requires_validation.v1", requestNode.id, commandNode.id, evidenceSpanIds);
    const bindings = bindingsByCheck.get(binding.checkId) ?? [];
    bindings.push(binding);
    bindingsByCheck.set(binding.checkId, bindings);
  }
  for (const check of uniqueSorted(input.validationPlan.checks) as WorkspaceValidationCheckId[]) {
    if (!(bindingsByCheck.get(check)?.length)) addUnresolved("scce.constraint.reason.validation_command_unbound.v1", [requestNode.id, check]);
  }

  const sortedNodes = [...nodes.values()].sort((left, right) => compareCanonical(left.id, right.id));
  const sortedEdges = [...edges.values()].sort((left, right) => compareCanonical(left.id, right.id));
  const sortedEvidence = [...evidenceById.values()].sort((left, right) => compareCanonical(left.id, right.id));
  const sortedUnresolved = [...unresolved].sort((left, right) => compareCanonical(left.id, right.id));
  const graphPayload: WorkspaceTaskConstraintGraphIdentityInput = {
    schema: WORKSPACE_TASK_CONSTRAINT_GRAPH_SCHEMA,
    workspaceRevision: {
      workspaceId: input.revision.workspaceId,
      revisionId: input.revision.revisionId,
      revisionHash: input.revision.revisionHash
    },
    analyzerRevision: {
      analyzerId: input.observation.analyzer.id,
      analyzerVersion: input.observation.analyzer.version,
      semanticRevisionHash: input.observation.semanticRevisionHash,
      compilerContext
    },
    requestId: input.request.requestId,
    nodes: sortedNodes,
    edges: sortedEdges,
    evidenceSpans: sortedEvidence,
    requestedOutcomeNodeIds: [...requestedOutcomeNodeIds].sort(compareCanonical),
    protectedInvariantNodeIds: [...protectedInvariantNodeIds].sort(compareCanonical),
    affectedFileNodeIds: [...affectedFileNodeIds].sort(compareCanonical),
    affectedSymbolNodeIds: [...affectedSymbolNodeIds].sort(compareCanonical),
    diagnosticNodeIds: [...diagnosticNodeIds].sort(compareCanonical),
    dependencyNodeIds: [...dependencyNodeIds].sort(compareCanonical),
    admissibleValidationCommandNodeIds: [...validationCommandNodeIds].sort(compareCanonical),
    unresolvedConstraints: sortedUnresolved,
    execution: { state: "not_executed" },
    audit: toJsonValue({
      requestTextUsed: false,
      workspaceRevisionHash: input.revision.revisionHash,
      semanticRevisionHash: input.observation.semanticRevisionHash,
      nodeCount: sortedNodes.length,
      edgeCount: sortedEdges.length,
      evidenceSpanCount: sortedEvidence.length,
      unresolvedConstraintCount: sortedUnresolved.length
    })
  };
  return { ...graphPayload, id: workspaceTaskConstraintGraphId(graphPayload, hasher) };
}

function assertRevisionAndObservation(input: BuildWorkspaceTaskConstraintGraphInput): void {
  const reconstructed = createWorkspaceRevisionSnapshot({
    workspaceId: input.revision.workspaceId,
    revisionId: input.revision.revisionId,
    files: input.revision.files.map(file => ({ path: file.path, bytes: file.bytes, mediaType: file.mediaType, role: file.role }))
  });
  if (input.revision.complete !== true || reconstructed.revisionHash !== input.revision.revisionHash) {
    throw new Error("task constraint graph requires an exact complete workspace revision");
  }
  const binding = input.observation.workspaceRevision;
  if (binding.workspaceId !== input.revision.workspaceId
    || binding.revisionId !== input.revision.revisionId
    || binding.revisionHash !== input.revision.revisionHash
    || input.observation.workspace.id !== input.revision.workspaceId) {
    throw new Error("semantic observation workspace revision does not match the task revision");
  }
  if (input.observation.semanticRevisionHash !== input.observation.program.revisionHash) {
    throw new Error("semantic observation analyzer revision is mismatched");
  }
  requiredId(input.observation.analyzer.id, "semantic analyzer id");
  requiredId(input.observation.analyzer.version, "semantic analyzer version");
  const revisionByPath = new Map(input.revision.files.map(file => [file.path, file]));
  for (const file of input.observation.program.files) {
    const revisionFile = revisionByPath.get(validateWorkspacePath(file.path));
    if (!revisionFile || hashDigest(revisionFile.contentHash) !== hashDigest(file.contentHash)) {
      throw new Error(`semantic observation file is outside or stale against the task revision: ${file.path}`);
    }
  }
  const configFile = revisionByPath.get(validateWorkspacePath(input.observation.program.config.path));
  if (!configFile || hashDigest(configFile.contentHash) !== hashDigest(input.observation.program.config.contentHash)) {
    throw new Error("semantic observation config is stale against the task revision");
  }
}

function semanticSpans(program: WorkspaceConstraintSemanticProgram): WorkspaceConstraintEvidenceSpan[] {
  return [
    program.config.span,
    ...program.files.map(file => file.span),
    ...program.declarations.flatMap(item => [item.span, item.nameSpan]),
    ...program.references.map(item => item.span),
    ...program.imports.flatMap(item => [item.span, item.moduleSpecifierSpan, ...item.bindings.map(binding => binding.span)]),
    ...program.calls.flatMap(item => [item.span, item.calleeSpan]),
    ...program.diagnostics.flatMap(item => [item.span, ...(item.relatedEvidence ?? []).map(evidence => evidence.span)].filter((span): span is WorkspaceConstraintEvidenceSpan => Boolean(span))),
    ...program.configOwnership.flatMap(item => [item.configSpan, item.fileSpan]),
    ...program.commands.flatMap(item => [item.nameSpan, item.commandSpan]),
    ...program.testRelations.map(item => item.evidenceSpan)
  ];
}

function assertExactSpan(
  span: WorkspaceConstraintEvidenceSpan,
  revisionByPath: ReadonlyMap<string, WorkspaceRevisionFile>,
  textByPath: Map<string, string>
): void {
  const path = validateWorkspacePath(span.path);
  const file = revisionByPath.get(path);
  if (!file || hashDigest(file.contentHash) !== hashDigest(requiredHash(span.contentHash))) throw new Error(`constraint evidence span is stale: ${path}`);
  const text = revisionText(file, textByPath);
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.length) || !Number.isSafeInteger(span.end)
    || span.start < 0 || span.length < 0 || span.end !== span.start + span.length || span.end > text.length) {
    throw new Error(`constraint evidence span is outside exact source: ${path}`);
  }
  if (hashDigest(hashPatchContent(text.slice(span.start, span.end))) !== hashDigest(requiredHash(span.textHash))) {
    throw new Error(`constraint evidence span text hash is stale: ${path}`);
  }
  const start = lineColumn(text, span.start);
  const end = lineColumn(text, span.end);
  if (span.startLine !== start.line || span.startColumn !== start.column || span.endLine !== end.line || span.endColumn !== end.column) {
    throw new Error(`constraint evidence span line coordinates are stale: ${path}`);
  }
}

function revisionFullSpan(file: WorkspaceRevisionFile, textByPath: Map<string, string>): WorkspaceConstraintEvidenceSpan {
  const text = revisionText(file, textByPath);
  const end = lineColumn(text, text.length);
  return {
    path: file.path,
    contentHash: file.contentHash,
    start: 0,
    length: text.length,
    end: text.length,
    startLine: 1,
    startColumn: 1,
    endLine: end.line,
    endColumn: end.column,
    textHash: hashPatchContent(text)
  };
}

function revisionText(file: WorkspaceRevisionFile, cache: Map<string, string>): string {
  const existing = cache.get(file.path);
  if (existing !== undefined) return existing;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  } catch {
    throw new Error(`task constraint evidence is not valid UTF-8 text: ${file.path}`);
  }
  cache.set(file.path, text);
  return text;
}

function canonicalGraphPayload(graph: WorkspaceTaskConstraintGraphIdentityInput): WorkspaceTaskConstraintGraphIdentityInput {
  return {
    schema: graph.schema,
    workspaceRevision: graph.workspaceRevision,
    analyzerRevision: graph.analyzerRevision,
    requestId: graph.requestId,
    nodes: [...graph.nodes].sort((left, right) => compareCanonical(left.id, right.id)),
    edges: [...graph.edges].sort((left, right) => compareCanonical(left.id, right.id)),
    evidenceSpans: [...graph.evidenceSpans].sort((left, right) => compareCanonical(left.id, right.id)),
    requestedOutcomeNodeIds: uniqueSorted(graph.requestedOutcomeNodeIds),
    protectedInvariantNodeIds: uniqueSorted(graph.protectedInvariantNodeIds),
    affectedFileNodeIds: uniqueSorted(graph.affectedFileNodeIds),
    affectedSymbolNodeIds: uniqueSorted(graph.affectedSymbolNodeIds),
    diagnosticNodeIds: uniqueSorted(graph.diagnosticNodeIds),
    dependencyNodeIds: uniqueSorted(graph.dependencyNodeIds),
    admissibleValidationCommandNodeIds: uniqueSorted(graph.admissibleValidationCommandNodeIds),
    unresolvedConstraints: [...graph.unresolvedConstraints].sort((left, right) => compareCanonical(left.id, right.id)),
    execution: graph.execution,
    audit: graph.audit
  };
}

function verifyIndexedNodes(
  ids: readonly string[],
  _graph: WorkspaceTaskConstraintGraph,
  nodeById: ReadonlyMap<string, WorkspaceTaskConstraintNode>,
  kindId: string,
  label: string
): void {
  assertCanonicalStringArray(ids, `${label} index`);
  for (const id of ids) if (nodeById.get(id)?.kindId !== kindId) throw new Error(`${label} index is invalid`);
}

function requireEdge(graph: WorkspaceTaskConstraintGraph, relationId: string, sourceId: string, targetId: string): void {
  if (!graph.edges.some(edge => edge.relationId === relationId && edge.sourceId === sourceId && edge.targetId === targetId)) {
    throw new Error("task constraint cross-link is absent");
  }
}

function assertCanonicalStringArray(values: readonly string[], label: string): void {
  if (values.some(value => typeof value !== "string" || !value || value.includes("\u0000"))
    || canonicalStringify(values) !== canonicalStringify(uniqueSorted(values))) {
    throw new Error(`${label} is not canonical`);
  }
}

function metadataRecord(value: JsonValue): Record<string, JsonValue> {
  if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("constraint metadata is invalid");
  return value as Record<string, JsonValue>;
}

function uniqueMap<T>(items: readonly T[], key: (item: T) => string, label: string): Map<string, T> {
  const result = new Map<string, T>();
  for (const item of items) {
    const id = key(item);
    if (result.has(id)) throw new Error(`duplicate ${label}`);
    result.set(id, item);
  }
  return result;
}

function lineColumn(text: string, position: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  for (let index = 0; index < position; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lineStart = index + 1;
    }
  }
  return { line, column: position - lineStart + 1 };
}

function compilerDiagnosticCategoryName(value: number): string {
  if (value === 0) return "warning";
  if (value === 1) return "error";
  if (value === 2) return "suggestion";
  if (value === 3) return "message";
  throw new Error(`unsupported compiler diagnostic category: ${value}`);
}

function canonicalSpan(span: WorkspaceConstraintEvidenceSpan): WorkspaceConstraintEvidenceSpan {
  return {
    path: span.path,
    contentHash: requiredHash(span.contentHash),
    start: span.start,
    length: span.length,
    end: span.end,
    startLine: span.startLine,
    startColumn: span.startColumn,
    endLine: span.endLine,
    endColumn: span.endColumn,
    textHash: requiredHash(span.textHash)
  };
}

function spansOverlap(left: WorkspaceConstraintEvidenceSpan, right: WorkspaceConstraintEvidenceSpan): boolean {
  if (left.path !== right.path || hashDigest(left.contentHash) !== hashDigest(right.contentHash)) return false;
  return left.start < right.end && right.start < left.end
    || left.length === 0 && left.start >= right.start && left.start <= right.end
    || right.length === 0 && right.start >= left.start && right.start <= left.end;
}

function appendMap<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const values = map.get(key) ?? [];
  values.push(value);
  map.set(key, values);
}

function opaqueId(hasher: Hasher, prefix: string, ...parts: string[]): string {
  return `${prefix}_${hasher.digestHex(parts.join("\u001f")).slice(0, 40)}`;
}

function requiredId(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.includes("\u0000")) throw new Error(`${label} is required`);
  return normalized;
}

function requiredHash(value: string): string {
  const match = /^(?:sha256[:_])([0-9a-f]{64})$/iu.exec(value);
  if (!match?.[1]) throw new Error(`task constraint evidence hash is invalid: ${value}`);
  return `sha256:${match[1].toLocaleLowerCase()}`;
}

function hashDigest(value: string): string {
  return requiredHash(value).slice("sha256:".length);
}

function validateWorkspacePath(value: string): string {
  if (!value || value !== value.trim() || value.includes("\u0000") || value.includes("\\")
    || value.startsWith("/") || /^[A-Za-z]:/u.test(value)
    || value.normalize("NFC") !== value || value.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error(`task constraint workspace path is invalid: ${value}`);
  }
  return value;
}

function uniqueSorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareCanonical);
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
