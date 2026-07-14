import {
  TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY,
  canonicalTypeScriptCodeFixIdentity,
  canonicalTypeScriptDiagnosticIdentity,
  verifyExactTypeScriptCodeActionTransformation,
  type ExactProgramTextChange,
  type TypeScriptCodeActionCompilerContext
} from "./program-repair-kernel.js";
import {
  createPatchTransactionPlan,
  hashPatchContent,
  type PatchContentHash,
  type PatchTransactionPlan
} from "./patch-transaction.js";
import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";
import {
  WORKSPACE_TASK_CONSTRAINT_GRAPH_SCHEMA,
  verifyWorkspaceTaskConstraintGraph,
  type WorkspaceTaskConstraintEvidenceRecord,
  type WorkspaceTaskConstraintGraph,
  type WorkspaceTaskConstraintNode,
  type WorkspaceTaskUnresolvedConstraint
} from "./workspace-task-constraint-graph.js";
import { createWorkspaceRevisionSnapshot, type WorkspaceRevisionSnapshot } from "./workspace-plan-generator.js";

export const WORKSPACE_TRANSFORMATION_FAMILY_SELECTION_SCHEMA = "scce.workspace.transformation_family_selection.v1" as const;

export const WORKSPACE_TRANSFORMATION_REJECTION = Object.freeze({
  FAMILY_UNSUPPORTED: "scce.transformation.reject.family_unsupported.v1",
  FAMILY_EMPTY: "scce.transformation.reject.family_empty.v1",
  CANDIDATE_UNIVERSE_INCOMPLETE: "scce.transformation.reject.candidate_universe_incomplete.v1",
  CANDIDATE_SET_IDENTITY_INVALID: "scce.transformation.reject.candidate_set_identity_invalid.v1",
  SNAPSHOT_STALE: "scce.transformation.reject.snapshot_stale.v1",
  ANALYZER_STALE: "scce.transformation.reject.analyzer_stale.v1",
  GRAPH_UNRESOLVED: "scce.transformation.reject.graph_unresolved.v1",
  CANDIDATE_INVALID: "scce.transformation.reject.candidate_invalid.v1",
  DIAGNOSTIC_UNBOUND: "scce.transformation.reject.diagnostic_unbound.v1",
  DIAGNOSTIC_IDENTITY_INVALID: "scce.transformation.reject.diagnostic_identity_invalid.v1",
  CODE_FIX_IDENTITY_INVALID: "scce.transformation.reject.code_fix_identity_invalid.v1",
  COMPILER_PROVENANCE_INVALID: "scce.transformation.reject.compiler_provenance_invalid.v1",
  AFFECTED_FILE_UNBOUND: "scce.transformation.reject.affected_file_unbound.v1",
  AFFECTED_SYMBOL_UNBOUND: "scce.transformation.reject.affected_symbol_unbound.v1",
  PROTECTED_INVARIANT: "scce.transformation.reject.protected_invariant.v1",
  BASE_HASH_STALE: "scce.transformation.reject.base_hash_stale.v1",
  EXACT_EDIT_INVALID: "scce.transformation.reject.exact_edit_invalid.v1",
  AFTER_HASH_INVALID: "scce.transformation.reject.after_hash_invalid.v1",
  POSTCONDITION_UNBOUND: "scce.transformation.reject.postcondition_unbound.v1",
  CREATE_UNSUPPORTED: "scce.transformation.reject.create_unbound_to_revision_absence.v1",
  CANDIDATE_CONFLICT: "scce.transformation.reject.candidate_conflict.v1",
  CANDIDATE_AMBIGUITY: "scce.transformation.reject.candidate_ambiguity.v1",
  NO_ADMISSIBLE_FAMILY: "scce.transformation.reject.no_admissible_family.v1"
} as const);

export type WorkspaceTransformationRejectionId = typeof WORKSPACE_TRANSFORMATION_REJECTION[keyof typeof WORKSPACE_TRANSFORMATION_REJECTION];

export interface WorkspaceCompilerCodeActionTextChange extends ExactProgramTextChange {}

export interface WorkspaceCompilerCodeActionFileChange {
  readonly path: string;
  readonly isNewFile: boolean;
  readonly baseContentHash: string | null;
  readonly textChanges: readonly WorkspaceCompilerCodeActionTextChange[];
  readonly afterContent: string;
  readonly afterContentHash: string;
}

/** Structural projection of the compiler-owned adapter result. */
export interface WorkspaceCompilerCodeActionTransformation {
  readonly path: string;
  readonly baseContentHash: string;
  readonly diagnostic: {
    readonly code: number;
    readonly category: string;
    readonly start: number;
    readonly length: number;
    readonly message: string;
  };
  readonly codeFix: {
    readonly fixName: string;
    readonly description: string;
    readonly fixId?: string;
    readonly textChanges: readonly WorkspaceCompilerCodeActionTextChange[];
    readonly fileChanges: readonly WorkspaceCompilerCodeActionFileChange[];
  };
  readonly diagnosticIdentity: string;
  readonly codeFixIdentity: string;
  readonly afterContent: string;
  readonly afterContentHash: string;
  readonly compiler: TypeScriptCodeActionCompilerContext;
  readonly postconditionIds: readonly string[];
  readonly postconditionBindingId: string;
}

export interface WorkspaceCompilerAnalyzerBinding {
  readonly analyzerId: string;
  readonly analyzerVersion: string;
  readonly semanticRevisionHash: string;
  readonly configPath: string;
  readonly configContentHash: string;
  readonly compilerOptionsHash: string;
  readonly compilerCommand: {
    readonly identity: string;
    readonly executable: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly sourcePath: string;
    readonly sourceContentHash: string;
    readonly sourceSelector: string;
    readonly rawCommandHash: string;
  };
}

export interface WorkspaceCompilerTransformationFamily {
  readonly familyId: string;
  readonly candidateSetId: string;
  /** Hash emitted by the compiler adapter for the exact complete file set. */
  readonly snapshotHash: string;
  readonly analyzedSnapshotHash: string;
  readonly availableCandidateCount: number;
  readonly truncated: boolean;
  readonly complete: boolean;
  /** Exact semantic observation revision used to build the constraint graph. */
  readonly analyzer: WorkspaceCompilerAnalyzerBinding;
  readonly transformations: readonly WorkspaceCompilerCodeActionTransformation[];
}

export function canonicalTypeScriptCodeActionPostconditionIds(diagnosticCode: number): string[] {
  if (!Number.isSafeInteger(diagnosticCode) || diagnosticCode <= 0) throw new Error("invalid compiler diagnostic code");
  return [
    `typescript.diagnostic.${diagnosticCode}.code_fix_applied`,
    "workspace.after_bytes.exact",
    "workspace.atomic_action.file_set_bound",
    "workspace.requested_path.bound"
  ].sort(compareCanonical);
}

export function canonicalTypeScriptCodeActionPostconditionBindingId(
  codeFixIdentity: string,
  diagnosticCode: number,
  hasher: Hasher = createHasher()
): string {
  return `typescript.code_fix_postconditions:${hasher.digestHex(canonicalStringify({
    codeFixIdentity,
    postconditionIds: canonicalTypeScriptCodeActionPostconditionIds(diagnosticCode)
  }))}`;
}

export function canonicalWorkspaceCompilerCommandIdentity(
  command: Omit<WorkspaceCompilerAnalyzerBinding["compilerCommand"], "identity">,
  hasher: Hasher = createHasher()
): string {
  return `typescript.compiler_command:${hasher.digestHex(canonicalStringify({
    executable: command.executable,
    args: [...command.args],
    cwd: command.cwd,
    sourcePath: command.sourcePath,
    sourceContentHash: command.sourceContentHash,
    sourceSelector: command.sourceSelector,
    rawCommandHash: command.rawCommandHash
  }))}`;
}

export function canonicalWorkspaceCompilerCandidateSetId(
  family: Omit<WorkspaceCompilerTransformationFamily, "candidateSetId">,
  hasher: Hasher = createHasher()
): string {
  const candidates = family.transformations.map(transformation => ({
    diagnosticIdentity: transformation.diagnosticIdentity,
    codeFixIdentity: transformation.codeFixIdentity,
    postconditionBindingId: transformation.postconditionBindingId
  })).sort((left, right) => compareCanonical(left.codeFixIdentity, right.codeFixIdentity)
    || compareCanonical(left.diagnosticIdentity, right.diagnosticIdentity)
    || compareCanonical(left.postconditionBindingId, right.postconditionBindingId));
  return `typescript.candidate_set:${hasher.digestHex(canonicalStringify({
    familyId: family.familyId,
    snapshotHash: family.snapshotHash,
    analyzedSnapshotHash: family.analyzedSnapshotHash,
    availableCandidateCount: family.availableCandidateCount,
    truncated: family.truncated,
    complete: family.complete,
    analyzer: family.analyzer,
    candidates
  }))}`;
}

export interface SelectWorkspaceTransformationFamilyInput {
  readonly graph: WorkspaceTaskConstraintGraph;
  readonly revision: WorkspaceRevisionSnapshot;
  readonly families: readonly WorkspaceCompilerTransformationFamily[];
}

export interface WorkspaceVerifiedTransformationEdit {
  readonly id: string;
  readonly path: string;
  readonly beforeContentHash: PatchContentHash;
  readonly afterContentHash: PatchContentHash;
  readonly span: {
    readonly start: number;
    readonly length: number;
    readonly end: number;
    readonly beforeTextHash: PatchContentHash;
    readonly newTextHash: PatchContentHash;
  };
  readonly diagnosticNodeId: string;
  readonly diagnosticEvidenceSpanIds: readonly string[];
  readonly symbolNodeIds: readonly string[];
  readonly symbolEvidenceSpanIds: readonly string[];
  readonly expectedOutcomeNodeIds: readonly string[];
  readonly expectedPostconditionIds: readonly string[];
}

export interface WorkspaceSelectedTransformationFamily {
  readonly familyId: typeof TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY;
  readonly candidateId: string;
  readonly snapshotHash: PatchContentHash;
  readonly analyzerRevisionHash: string;
  readonly diagnosticIdentity: string;
  readonly codeFixIdentity: string;
  readonly diagnosticNodeId: string;
  readonly expectedOutcomeNodeIds: readonly string[];
  readonly expectedPostconditionIds: readonly string[];
  readonly edits: readonly WorkspaceVerifiedTransformationEdit[];
  readonly patchPlan: PatchTransactionPlan;
  readonly execution: { readonly state: "not_executed" };
}

export interface WorkspaceRejectedTransformationCandidate {
  readonly familyId: string;
  readonly candidateId: string;
  readonly reasonIds: readonly WorkspaceTransformationRejectionId[];
}

export interface WorkspaceUnresolvedTransformationOutcome {
  readonly outcomeNodeId: string | null;
  readonly postconditionId: string | null;
  readonly candidateIds: readonly string[];
  readonly evidenceSpanIds: readonly string[];
  readonly reasonIds: readonly string[];
}

export interface WorkspaceTransformationFamilySelection {
  readonly schema: typeof WORKSPACE_TRANSFORMATION_FAMILY_SELECTION_SCHEMA;
  readonly id: string;
  readonly graphId: string;
  readonly workspaceRevision: WorkspaceTaskConstraintGraph["workspaceRevision"];
  readonly analyzerRevision: WorkspaceTaskConstraintGraph["analyzerRevision"];
  readonly selected: WorkspaceSelectedTransformationFamily | null;
  readonly admissibleCandidateIds: readonly string[];
  readonly rejectedCandidates: readonly WorkspaceRejectedTransformationCandidate[];
  readonly graphUnresolvedConstraints: readonly WorkspaceTaskUnresolvedConstraint[];
  readonly unresolvedOutcomes: readonly WorkspaceUnresolvedTransformationOutcome[];
  readonly execution: { readonly state: "not_executed" };
}

interface SelectorContext {
  graph: WorkspaceTaskConstraintGraph;
  revision: WorkspaceRevisionSnapshot;
  textByPath: Map<string, string>;
  fileByPath: Map<string, WorkspaceRevisionSnapshot["files"][number]>;
  nodeById: Map<string, WorkspaceTaskConstraintNode>;
  evidenceById: Map<string, WorkspaceTaskConstraintEvidenceRecord>;
  affectedFileNodeByPath: Map<string, WorkspaceTaskConstraintNode>;
  protectedPaths: Set<string>;
  affectedSymbolNodes: WorkspaceTaskConstraintNode[];
  outcomes: Array<{ node: WorkspaceTaskConstraintNode; postconditionId: string }>;
  expectedSnapshotHash: PatchContentHash;
  hasher: Hasher;
}

interface EvaluatedCandidate {
  familyId: string;
  candidateId: string;
  reasonIds: Set<WorkspaceTransformationRejectionId>;
  selected?: WorkspaceSelectedTransformationFamily;
}

/**
 * Verifies compiler-owned exact transformations against a task graph and emits
 * an unexecuted patch plan. It does not interpret request prose or mutate state.
 */
export function selectWorkspaceTransformationFamily(
  input: SelectWorkspaceTransformationFamilyInput,
  hasher: Hasher = createHasher()
): WorkspaceTransformationFamilySelection {
  const context = selectorContext(input, hasher);
  const globalReasons = new Set<WorkspaceTransformationRejectionId>();
  if (input.graph.unresolvedConstraints.length > 0) globalReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.GRAPH_UNRESOLVED);

  const evaluated: EvaluatedCandidate[] = [];
  for (const family of input.families) {
    const familyReasons = new Set<WorkspaceTransformationRejectionId>();
    if (family.familyId !== TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY) familyReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.FAMILY_UNSUPPORTED);
    if (family.snapshotHash !== context.expectedSnapshotHash) familyReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.SNAPSHOT_STALE);
    if (!family.complete || family.truncated || family.availableCandidateCount !== family.transformations.length) {
      familyReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_UNIVERSE_INCOMPLETE);
    }
    try {
      const { candidateSetId: _candidateSetId, ...identityInput } = family;
      if (family.candidateSetId !== canonicalWorkspaceCompilerCandidateSetId(identityInput, hasher)) {
        familyReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_SET_IDENTITY_INVALID);
      }
    } catch {
      familyReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_SET_IDENTITY_INVALID);
    }
    if (!validAnalyzerBinding(context, family.analyzer)) familyReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.ANALYZER_STALE);
    if (family.transformations.length === 0) {
      familyReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.FAMILY_EMPTY);
      evaluated.push({ familyId: family.familyId, candidateId: family.candidateSetId, reasonIds: familyReasons });
      continue;
    }
    for (const transformation of family.transformations) {
      const candidate = evaluateCompilerCandidate(context, family, transformation);
      for (const reason of familyReasons) candidate.reasonIds.add(reason);
      for (const reason of globalReasons) candidate.reasonIds.add(reason);
      if (candidate.reasonIds.size > 0) candidate.selected = undefined;
      evaluated.push(candidate);
    }
  }
  if (evaluated.length === 0) globalReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.FAMILY_EMPTY);

  const admissible = evaluated.filter(item => item.reasonIds.size === 0 && item.selected);
  const planGroups = new Map<string, EvaluatedCandidate[]>();
  for (const candidate of admissible) {
    const planHash = candidate.selected!.patchPlan.planHash;
    const group = planGroups.get(planHash) ?? [];
    group.push(candidate);
    planGroups.set(planHash, group);
  }

  let selected: WorkspaceSelectedTransformationFamily | null = null;
  if (planGroups.size === 1 && globalReasons.size === 0) {
    const group = [...planGroups.values()][0]!;
    const lineages = uniqueSorted(group.map(candidate => candidate.candidateId));
    if (lineages.length === 1) {
      selected = [...group].sort((left, right) => compareCanonical(left.candidateId, right.candidateId))[0]!.selected!;
    } else {
      globalReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_AMBIGUITY);
      for (const candidate of admissible) {
        candidate.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_AMBIGUITY);
        candidate.selected = undefined;
      }
    }
  } else if (planGroups.size > 1) {
    const representatives = [...planGroups.values()].map(group => group[0]!.selected!);
    const reason = plansConflict(representatives)
      ? WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_CONFLICT
      : WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_AMBIGUITY;
    globalReasons.add(reason);
    for (const candidate of admissible) {
      candidate.reasonIds.add(reason);
      candidate.selected = undefined;
    }
  }
  if (!selected) globalReasons.add(WORKSPACE_TRANSFORMATION_REJECTION.NO_ADMISSIBLE_FAMILY);

  const rejectedCandidates = deduplicatedRejections(evaluated);
  const admissibleCandidateIds = uniqueSorted(evaluated
    .filter(item => item.reasonIds.size === 0 && item.selected)
    .map(item => item.candidateId));
  const unresolvedOutcomes = selected
    ? []
    : unresolvedOutcomesFor(context, evaluated, globalReasons);
  const identity = canonicalStringify({
    graphId: input.graph.id,
    workspaceRevisionHash: input.graph.workspaceRevision.revisionHash,
    analyzerRevisionHash: input.graph.analyzerRevision.semanticRevisionHash,
    selectedDiagnosticIdentity: selected?.diagnosticIdentity ?? null,
    selectedCodeFixIdentity: selected?.codeFixIdentity ?? null,
    selectedPlanHash: selected?.patchPlan.planHash ?? null,
    rejectedCandidates,
    unresolvedOutcomes
  });
  return {
    schema: WORKSPACE_TRANSFORMATION_FAMILY_SELECTION_SCHEMA,
    id: `transformation_selection_${hasher.digestHex(identity).slice(0, 40)}`,
    graphId: input.graph.id,
    workspaceRevision: input.graph.workspaceRevision,
    analyzerRevision: input.graph.analyzerRevision,
    selected,
    admissibleCandidateIds,
    rejectedCandidates,
    graphUnresolvedConstraints: input.graph.unresolvedConstraints,
    unresolvedOutcomes,
    execution: { state: "not_executed" }
  };
}

function selectorContext(input: SelectWorkspaceTransformationFamilyInput, hasher: Hasher): SelectorContext {
  if (input.graph.schema !== WORKSPACE_TASK_CONSTRAINT_GRAPH_SCHEMA || input.graph.execution.state !== "not_executed") {
    throw new Error("invalid task constraint graph");
  }
  const reconstructed = createWorkspaceRevisionSnapshot({
    workspaceId: input.revision.workspaceId,
    revisionId: input.revision.revisionId,
    files: input.revision.files.map(file => ({ path: file.path, bytes: file.bytes, mediaType: file.mediaType, role: file.role }))
  }, hasher);
  if (!input.revision.complete || reconstructed.revisionHash !== input.revision.revisionHash) throw new Error("invalid workspace revision");
  if (input.graph.workspaceRevision.workspaceId !== input.revision.workspaceId
    || input.graph.workspaceRevision.revisionId !== input.revision.revisionId
    || input.graph.workspaceRevision.revisionHash !== input.revision.revisionHash) {
    throw new Error("task graph revision mismatch");
  }
  verifyWorkspaceTaskConstraintGraph(input.graph, input.revision, hasher);
  const nodeById = uniqueMap(input.graph.nodes, node => node.id, "constraint node");
  const evidenceById = uniqueMap(input.graph.evidenceSpans, span => span.id, "constraint evidence");
  const fileByPath = uniqueMap(input.revision.files, file => file.path, "revision path");
  const textByPath = new Map<string, string>();
  for (const file of input.revision.files) {
    if (hashPatchContent(file.bytes, hasher) !== file.contentHash) throw new Error("revision content hash mismatch");
  }
  const affectedFileNodeByPath = new Map<string, WorkspaceTaskConstraintNode>();
  for (const id of input.graph.affectedFileNodeIds) {
    const node = requiredNode(nodeById, id, "scce.program.file.v1");
    if (!node.path || affectedFileNodeByPath.has(node.path)) throw new Error("invalid affected file constraint");
    affectedFileNodeByPath.set(node.path, node);
  }
  const affectedSymbolNodes = input.graph.affectedSymbolNodeIds.map(id => requiredNode(nodeById, id, "scce.program.symbol.v1"));
  const protectedPaths = new Set<string>();
  for (const id of input.graph.protectedInvariantNodeIds) {
    const invariant = requiredNode(nodeById, id, "scce.task.invariant.protected_file.v1");
    if (!invariant.path) throw new Error("invalid protected invariant");
    protectedPaths.add(invariant.path);
  }
  const outcomes = input.graph.requestedOutcomeNodeIds.map(id => {
    const node = requiredNode(nodeById, id, "scce.task.outcome.v1");
    return { node, postconditionId: metadataString(node, "postconditionId") };
  });
  for (const edge of input.graph.edges) {
    if (!nodeById.has(edge.sourceId) || !nodeById.has(edge.targetId)) throw new Error("constraint edge endpoint mismatch");
    for (const id of edge.evidenceSpanIds) if (!evidenceById.has(id)) throw new Error("constraint edge evidence mismatch");
  }
  return {
    graph: input.graph,
    revision: input.revision,
    textByPath,
    fileByPath,
    nodeById,
    evidenceById,
    affectedFileNodeByPath,
    protectedPaths,
    affectedSymbolNodes,
    outcomes,
    expectedSnapshotHash: compilerSnapshotHash(input.revision, hasher),
    hasher
  };
}

function validAnalyzerBinding(context: SelectorContext, analyzer: WorkspaceCompilerAnalyzerBinding): boolean {
  const graphAnalyzer = context.graph.analyzerRevision;
  const compiler = graphAnalyzer.compilerContext;
  if (!compiler
    || analyzer.analyzerId !== graphAnalyzer.analyzerId
    || analyzer.analyzerVersion !== graphAnalyzer.analyzerVersion
    || analyzer.semanticRevisionHash !== graphAnalyzer.semanticRevisionHash
    || analyzer.configPath !== compiler.configPath
    || analyzer.configContentHash !== compiler.configContentHash
    || analyzer.compilerOptionsHash !== compiler.compilerOptionsHash) return false;
  const command = analyzer.compilerCommand;
  const { identity: _identity, ...commandIdentityInput } = command;
  if (command.identity !== canonicalWorkspaceCompilerCommandIdentity(commandIdentityInput, context.hasher)) return false;
  const source = context.fileByPath.get(command.sourcePath);
  if (!source || source.contentHash !== command.sourceContentHash) return false;
  const matchingCommands = context.graph.admissibleValidationCommandNodeIds
    .map(id => context.nodeById.get(id))
    .filter((node): node is WorkspaceTaskConstraintNode => Boolean(node
      && node.kindId === "scce.task.validation.command.v1"
      && node.path === command.sourcePath
      && node.contentHashes.includes(command.sourceContentHash)
      && node.contentHashes.includes(command.rawCommandHash)
      && metadataValue(node, "commandHash") === command.rawCommandHash
      && metadataValue(node, "sourceSelector") === command.sourceSelector));
  return matchingCommands.length === 1;
}

function evaluateCompilerCandidate(
  context: SelectorContext,
  family: WorkspaceCompilerTransformationFamily,
  transformation: WorkspaceCompilerCodeActionTransformation
): EvaluatedCandidate {
  const candidateId = stableCandidateId(family.familyId, transformation, context.hasher);
  const result: EvaluatedCandidate = { familyId: family.familyId, candidateId, reasonIds: new Set() };
  try {
    const sourceFile = context.fileByPath.get(transformation.path);
    const sourceText = sourceFile ? revisionText(context, transformation.path) : undefined;
    if (!sourceFile || sourceText === undefined || transformation.baseContentHash !== sourceFile.contentHash) {
      result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.BASE_HASH_STALE);
    }
    if (!context.affectedFileNodeByPath.has(transformation.path)) {
      result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.AFFECTED_FILE_UNBOUND);
    }

    const diagnosticIdentity = canonicalTypeScriptDiagnosticIdentity({
      path: transformation.path,
      diagnostic: transformation.diagnostic,
      compilerVersion: transformation.compiler.version,
      compilerOptionsHash: transformation.compiler.compilerOptionsHash
    });
    if (diagnosticIdentity !== transformation.diagnosticIdentity) {
      result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.DIAGNOSTIC_IDENTITY_INVALID);
    }
    const codeFixIdentity = canonicalTypeScriptCodeFixIdentity({
      diagnosticIdentity: transformation.diagnosticIdentity,
      codeFix: {
        fixName: transformation.codeFix.fixName,
        description: transformation.codeFix.description,
        ...(transformation.codeFix.fixId ? { fixId: transformation.codeFix.fixId } : {}),
        textChanges: transformation.codeFix.textChanges,
        fileChanges: transformation.codeFix.fileChanges.map(change => ({
          path: change.path,
          isNewFile: change.isNewFile,
          baseContentHash: change.baseContentHash,
          textChanges: [...change.textChanges]
        }))
      }
    });
    if (codeFixIdentity !== transformation.codeFixIdentity) {
      result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.CODE_FIX_IDENTITY_INVALID);
    }

    const diagnosticNode = exactDiagnosticNode(context, transformation);
    if (!diagnosticNode) result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.DIAGNOSTIC_UNBOUND);
    const diagnosticSymbolNodeIds = diagnosticNode
      ? uniqueSorted(context.graph.edges
        .filter(edge => edge.relationId === "scce.rel.program.diagnostic_intersects_symbol.v1"
          && edge.sourceId === diagnosticNode.id
          && context.graph.affectedSymbolNodeIds.includes(edge.targetId))
        .map(edge => edge.targetId))
      : [];
    if (diagnosticSymbolNodeIds.length === 0) result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.AFFECTED_SYMBOL_UNBOUND);

    if (!validCompilerProvenance(context, family.analyzer, transformation)) {
      result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.COMPILER_PROVENANCE_INVALID);
    }
    const expectedPostconditions = uniqueSorted(context.outcomes.map(outcome => outcome.postconditionId));
    const derivedPostconditions = canonicalTypeScriptCodeActionPostconditionIds(transformation.diagnostic.code);
    const candidatePostconditions = uniqueSorted(transformation.postconditionIds);
    if (canonicalStringify(candidatePostconditions) !== canonicalStringify(derivedPostconditions)
      || transformation.postconditionBindingId !== canonicalTypeScriptCodeActionPostconditionBindingId(
        transformation.codeFixIdentity,
        transformation.diagnostic.code,
        context.hasher
      )
      || expectedPostconditions.length === 0
      || expectedPostconditions.some(id => !candidatePostconditions.includes(id))) {
      result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.POSTCONDITION_UNBOUND);
    }

    const seenPaths = new Set<string>();
    const operations: Array<{ kind: "replace"; path: string; baseContentHash: PatchContentHash; content: string }> = [];
    const verifiedEdits: WorkspaceVerifiedTransformationEdit[] = [];
    for (const fileChange of transformation.codeFix.fileChanges) {
      if (seenPaths.has(fileChange.path)) {
        result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.EXACT_EDIT_INVALID);
        continue;
      }
      seenPaths.add(fileChange.path);
      if (fileChange.isNewFile || fileChange.baseContentHash === null) {
        result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.CREATE_UNSUPPORTED);
        continue;
      }
      const beforeFile = context.fileByPath.get(fileChange.path);
      const before = beforeFile ? revisionText(context, fileChange.path) : undefined;
      if (!beforeFile || before === undefined || fileChange.baseContentHash !== beforeFile.contentHash) {
        result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.BASE_HASH_STALE);
        continue;
      }
      if (!context.affectedFileNodeByPath.has(fileChange.path)) {
        result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.AFFECTED_FILE_UNBOUND);
      }
      if (context.protectedPaths.has(fileChange.path)) {
        result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.PROTECTED_INVARIANT);
      }
      const normalizedChanges = normalizeChanges(fileChange.textChanges, before.length);
      if (!normalizedChanges
        || !verifyExactTypeScriptCodeActionTransformation({ before, after: fileChange.afterContent, textChanges: normalizedChanges })) {
        result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.EXACT_EDIT_INVALID);
        continue;
      }
      const afterHash = hashPatchContent(fileChange.afterContent, context.hasher);
      if (afterHash !== fileChange.afterContentHash) result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.AFTER_HASH_INVALID);

      const symbolBindings = symbolBindingsForPath(context, fileChange.path);
      if (symbolBindings.nodeIds.length === 0 || symbolBindings.evidenceSpanIds.length === 0) {
        result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.AFFECTED_SYMBOL_UNBOUND);
      }
      const diagnosticEvidenceSpanIds = diagnosticNode?.evidenceSpanIds ?? [];
      for (const change of normalizedChanges) {
        const payload = {
          path: fileChange.path,
          beforeContentHash: beforeFile.contentHash,
          afterContentHash: afterHash,
          start: change.start,
          length: change.length,
          newTextHash: hashPatchContent(change.newText, context.hasher),
          diagnosticNodeId: diagnosticNode?.id ?? "",
          symbolNodeIds: symbolBindings.nodeIds,
          expectedOutcomeNodeIds: context.outcomes.map(outcome => outcome.node.id)
        };
        verifiedEdits.push({
          id: `transformation_edit_${context.hasher.digestHex(canonicalStringify(payload)).slice(0, 40)}`,
          path: fileChange.path,
          beforeContentHash: beforeFile.contentHash,
          afterContentHash: afterHash,
          span: {
            start: change.start,
            length: change.length,
            end: change.start + change.length,
            beforeTextHash: hashPatchContent(before.slice(change.start, change.start + change.length), context.hasher),
            newTextHash: hashPatchContent(change.newText, context.hasher)
          },
          diagnosticNodeId: diagnosticNode?.id ?? "",
          diagnosticEvidenceSpanIds,
          symbolNodeIds: symbolBindings.nodeIds,
          symbolEvidenceSpanIds: symbolBindings.evidenceSpanIds,
          expectedOutcomeNodeIds: context.outcomes.map(outcome => outcome.node.id),
          expectedPostconditionIds: expectedPostconditions
        });
      }
      operations.push({ kind: "replace", path: fileChange.path, baseContentHash: beforeFile.contentHash, content: fileChange.afterContent });
    }
    if (transformation.codeFix.fileChanges.length === 0 || operations.length === 0) {
      result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.EXACT_EDIT_INVALID);
    }

    if (sourceText !== undefined && sourceFile) {
      const sourceChange = transformation.codeFix.fileChanges.find(change => change.path === transformation.path);
      const expectedAfter = sourceChange?.afterContent ?? sourceText;
      if (transformation.afterContent !== expectedAfter
        || transformation.afterContentHash !== hashPatchContent(expectedAfter, context.hasher)) {
        result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.AFTER_HASH_INVALID);
      }
    }

    if (result.reasonIds.size === 0 && diagnosticNode) {
      const patchPlan = createPatchTransactionPlan({ operations }, context.hasher);
      result.selected = {
        familyId: TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY,
        candidateId,
        snapshotHash: family.snapshotHash as PatchContentHash,
        analyzerRevisionHash: family.analyzer.semanticRevisionHash,
        diagnosticIdentity: transformation.diagnosticIdentity,
        codeFixIdentity: transformation.codeFixIdentity,
        diagnosticNodeId: diagnosticNode.id,
        expectedOutcomeNodeIds: context.outcomes.map(outcome => outcome.node.id),
        expectedPostconditionIds: expectedPostconditions,
        edits: verifiedEdits.sort(compareEdits),
        patchPlan,
        execution: { state: "not_executed" }
      };
    }
  } catch {
    result.reasonIds.add(WORKSPACE_TRANSFORMATION_REJECTION.CANDIDATE_INVALID);
  }
  return result;
}

function exactDiagnosticNode(
  context: SelectorContext,
  transformation: WorkspaceCompilerCodeActionTransformation
): WorkspaceTaskConstraintNode | undefined {
  const category = compilerDiagnosticCategoryCode(transformation.diagnostic.category);
  const messageHash = hashPatchContent(transformation.diagnostic.message, context.hasher);
  const matches = context.graph.diagnosticNodeIds
    .map(id => requiredNode(context.nodeById, id, "scce.program.diagnostic.v1"))
    .filter(node => {
      if (node.path !== transformation.path
        || metadataNumber(node, "compilerCode") !== transformation.diagnostic.code
        || category === undefined
        || metadataNumber(node, "compilerCategory") !== category
        || metadataValue(node, "diagnosticIdentity") !== transformation.diagnosticIdentity
        || !node.contentHashes.includes(messageHash)) return false;
      return node.evidenceSpanIds.some(id => {
        const span = context.evidenceById.get(id);
        return span?.path === transformation.path
          && span.start === transformation.diagnostic.start
          && span.length === transformation.diagnostic.length;
      });
    });
  return matches.length === 1 ? matches[0] : undefined;
}

function validCompilerProvenance(
  context: SelectorContext,
  analyzer: WorkspaceCompilerAnalyzerBinding,
  transformation: WorkspaceCompilerCodeActionTransformation
): boolean {
  const compiler = transformation.compiler;
  const config = context.fileByPath.get(compiler.tsconfigPath);
  const commandSource = context.fileByPath.get(compiler.compilerCommand.sourcePath);
  if (!config || config.contentHash !== compiler.tsconfigContentHash
    || !commandSource || commandSource.contentHash !== compiler.compilerCommand.sourceContentHash
    || compiler.configDiagnosticCodes.length > 0
    || compiler.compilerOptionsSource !== "source_observed_tsc_project"
    || compiler.sourceFileBoundary !== "workspace_snapshot_and_typescript_standard_library"
    || compiler.version !== analyzer.analyzerVersion
    || compiler.tsconfigPath !== analyzer.configPath
    || compiler.tsconfigContentHash !== analyzer.configContentHash
    || compiler.compilerOptionsHash !== analyzer.compilerOptionsHash
    || compiler.compilerCommand.executable !== analyzer.compilerCommand.executable
    || canonicalStringify(compiler.compilerCommand.args) !== canonicalStringify(analyzer.compilerCommand.args)
    || compiler.compilerCommand.cwd !== analyzer.compilerCommand.cwd
    || compiler.compilerCommand.sourcePath !== analyzer.compilerCommand.sourcePath
    || compiler.compilerCommand.sourceContentHash !== analyzer.compilerCommand.sourceContentHash) return false;
  const configNode = context.graph.nodes.find(node => node.kindId === "scce.program.file.v1" && node.path === compiler.tsconfigPath);
  if (!configNode || !configNode.contentHashes.includes(config.contentHash)) return false;
  for (const path of transformation.codeFix.fileChanges.map(change => change.path)) {
    const fileNode = context.affectedFileNodeByPath.get(path);
    if (!fileNode) return false;
    const dependencyIds = context.graph.edges
      .filter(edge => edge.relationId === "scce.rel.task.file_requires_config.v1" && edge.sourceId === fileNode.id)
      .map(edge => edge.targetId);
    if (!context.graph.edges.some(edge => edge.relationId === "scce.rel.task.dependency_targets_file.v1"
      && dependencyIds.includes(edge.sourceId)
      && edge.targetId === configNode.id)) return false;
  }
  return true;
}

function symbolBindingsForPath(context: SelectorContext, path: string): { nodeIds: string[]; evidenceSpanIds: string[] } {
  const nodeIds: string[] = [];
  const evidenceSpanIds: string[] = [];
  for (const node of context.affectedSymbolNodes) {
    const matchingEvidence = node.evidenceSpanIds.filter(id => context.evidenceById.get(id)?.path === path);
    if (matchingEvidence.length === 0) continue;
    nodeIds.push(node.id);
    evidenceSpanIds.push(...matchingEvidence);
  }
  return { nodeIds: uniqueSorted(nodeIds), evidenceSpanIds: uniqueSorted(evidenceSpanIds) };
}

function unresolvedOutcomesFor(
  context: SelectorContext,
  evaluated: readonly EvaluatedCandidate[],
  globalReasons: ReadonlySet<WorkspaceTransformationRejectionId>
): WorkspaceUnresolvedTransformationOutcome[] {
  const candidateIds = uniqueSorted(evaluated.map(item => item.candidateId));
  const reasonIds = uniqueSorted([
    ...globalReasons,
    ...evaluated.flatMap(item => [...item.reasonIds]),
    ...context.graph.unresolvedConstraints.map(item => item.reasonId)
  ]);
  if (context.outcomes.length === 0) {
    return [{ outcomeNodeId: null, postconditionId: null, candidateIds, evidenceSpanIds: [], reasonIds }];
  }
  return context.outcomes.map(outcome => ({
    outcomeNodeId: outcome.node.id,
    postconditionId: outcome.postconditionId,
    candidateIds,
    evidenceSpanIds: outcome.node.evidenceSpanIds,
    reasonIds
  }));
}

function deduplicatedRejections(evaluated: readonly EvaluatedCandidate[]): WorkspaceRejectedTransformationCandidate[] {
  const byKey = new Map<string, WorkspaceRejectedTransformationCandidate>();
  for (const candidate of evaluated) {
    if (candidate.reasonIds.size === 0) continue;
    const reasonIds = uniqueSorted([...candidate.reasonIds]);
    const key = `${candidate.familyId}\u0000${candidate.candidateId}\u0000${reasonIds.join("\u0000")}`;
    byKey.set(key, { familyId: candidate.familyId, candidateId: candidate.candidateId, reasonIds });
  }
  return [...byKey.values()].sort((left, right) => compareCanonical(left.familyId, right.familyId)
    || compareCanonical(left.candidateId, right.candidateId)
    || compareCanonical(left.reasonIds.join("\u0000"), right.reasonIds.join("\u0000")));
}

function plansConflict(plans: readonly WorkspaceSelectedTransformationFamily[]): boolean {
  for (let leftIndex = 0; leftIndex < plans.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < plans.length; rightIndex += 1) {
      for (const left of plans[leftIndex]!.edits) {
        for (const right of plans[rightIndex]!.edits) {
          if (left.path !== right.path) continue;
          const sameSpan = left.span.start === right.span.start && left.span.length === right.span.length;
          const overlap = left.span.length === 0 && right.span.length === 0
            ? left.span.start === right.span.start
            : left.span.start < right.span.end && right.span.start < left.span.end;
          if ((sameSpan || overlap) && left.span.newTextHash !== right.span.newTextHash) return true;
        }
      }
    }
  }
  return false;
}

function normalizeChanges(changes: readonly ExactProgramTextChange[], sourceLength: number): ExactProgramTextChange[] | undefined {
  const sorted = [...changes].sort((left, right) => left.start - right.start || left.length - right.length || compareCanonical(left.newText, right.newText));
  for (let index = 0; index < sorted.length; index += 1) {
    const change = sorted[index]!;
    if (!Number.isInteger(change.start) || !Number.isInteger(change.length)
      || change.start < 0 || change.length < 0 || change.start + change.length > sourceLength
      || typeof change.newText !== "string" || change.newText.includes("\u0000")) return undefined;
    const previous = sorted[index - 1];
    if (previous && (previous.start + previous.length > change.start
      || (previous.start === change.start && previous.length === 0 && change.length === 0))) return undefined;
  }
  return sorted.length > 0 ? sorted : undefined;
}

function revisionText(context: SelectorContext, path: string): string {
  const cached = context.textByPath.get(path);
  if (cached !== undefined) return cached;
  const file = context.fileByPath.get(path);
  if (!file) throw new Error("revision text path is absent");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
  context.textByPath.set(path, text);
  return text;
}

function compilerSnapshotHash(revision: WorkspaceRevisionSnapshot, hasher: Hasher): PatchContentHash {
  const value = [...revision.files]
    .sort((left, right) => compareCanonical(left.path, right.path))
    .map(file => `${file.path}\u0000${file.contentHash.slice("sha256:".length)}`)
    .join("\u0000");
  return hashPatchContent(value, hasher);
}

function stableCandidateId(familyId: string, transformation: WorkspaceCompilerCodeActionTransformation, hasher: Hasher): string {
  if (transformation.codeFixIdentity && !transformation.codeFixIdentity.includes("\u0000")) return transformation.codeFixIdentity;
  return `transformation_candidate_${hasher.digestHex(canonicalStringify({ familyId, transformation })).slice(0, 40)}`;
}

function compilerDiagnosticCategoryCode(value: string): number | undefined {
  if (value === "warning") return 0;
  if (value === "error") return 1;
  if (value === "suggestion") return 2;
  if (value === "message") return 3;
  return undefined;
}

function metadataString(node: WorkspaceTaskConstraintNode, key: string): string {
  const value = metadataValue(node, key);
  if (typeof value !== "string" || !value || value.includes("\u0000")) throw new Error("invalid constraint metadata string");
  return value;
}

function metadataNumber(node: WorkspaceTaskConstraintNode, key: string): number | undefined {
  const value = metadataValue(node, key);
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function metadataValue(node: WorkspaceTaskConstraintNode, key: string): unknown {
  if (!node.metadata || Array.isArray(node.metadata) || typeof node.metadata !== "object") return undefined;
  return (node.metadata as Record<string, unknown>)[key];
}

function requiredNode(nodes: Map<string, WorkspaceTaskConstraintNode>, id: string, kindId: string): WorkspaceTaskConstraintNode {
  const node = nodes.get(id);
  if (!node || node.kindId !== kindId) throw new Error("invalid constraint node reference");
  return node;
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

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCanonical);
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEdits(left: WorkspaceVerifiedTransformationEdit, right: WorkspaceVerifiedTransformationEdit): number {
  return compareCanonical(left.path, right.path)
    || left.span.start - right.span.start
    || left.span.length - right.span.length
    || compareCanonical(left.id, right.id);
}
