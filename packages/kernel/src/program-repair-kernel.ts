import type { ArtifactId, BuildTestResult, ContentHash, FileArtifact, Hasher, JsonValue, ProgramGraph } from "./types.js";
import { canonicalStringify, clamp01, createHasher, featureSet, toJsonValue, weightedJaccard } from "./primitives.js";
import { createProgramHydrationContract, hydrationSummary, validateProgramGraphHydration } from "./program-runtime.js";

export type DiagnosticClass = "syntax" | "type" | "dependency" | "runtime" | "contract" | "security" | "unknown";
export type RepairOperationKind = "create" | "insert" | "replace" | "delete" | "move" | "dependency" | "config" | "repair.op.diagnostic_note";

export const UNUSED_TYPE_IMPORT_REPAIR_FAMILY = "repair.family.typescript.unused_type_import.v1" as const;
export const TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY = "repair.family.typescript.code_action.v1" as const;
export type ProgramRepairFamilyId = typeof UNUSED_TYPE_IMPORT_REPAIR_FAMILY | typeof TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY;
export interface SupportedProgramRepairFamilyDescriptor {
  id: ProgramRepairFamilyId;
  requestSyntax: string;
  sourceLanguages: readonly string[];
  mutationClass: "program.mutation.type_only_compile_hygiene" | "program.mutation.compiler_diagnostic_repair";
  requiredValidationChecks: readonly ("compiler" | "typecheck" | "tests")[];
  limitations: readonly string[];
}
export const SUPPORTED_PROGRAM_REPAIR_FAMILIES: readonly SupportedProgramRepairFamilyDescriptor[] = Object.freeze([{
  id: UNUSED_TYPE_IMPORT_REPAIR_FAMILY,
  requestSyntax: "remove unused type import <local-binding>",
  sourceLanguages: Object.freeze(["typescript"]),
  mutationClass: "program.mutation.type_only_compile_hygiene",
  requiredValidationChecks: Object.freeze(["typecheck"] as const),
  limitations: Object.freeze([
    "one requested existing module",
    "one single-line type-only import declaration",
    "the request must name the local binding",
    "the binding must have no other source occurrence",
    "runtime imports and mixed import declarations are unsupported"
  ])
}, {
  id: TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY,
  requestSyntax: "a request selecting one official TypeScript code fix for one existing requested module",
  sourceLanguages: Object.freeze(["typescript"]),
  mutationClass: "program.mutation.compiler_diagnostic_repair",
  requiredValidationChecks: Object.freeze(["compiler", "typecheck", "tests"] as const),
  limitations: Object.freeze([
    "one requested existing module",
    "one compiler diagnostic with one explicitly selected official TypeScript CodeFixAction",
    "the selected action may replace multiple existing files or create bounded source files as one atomic transaction",
    "ambiguous code actions and command-bearing code actions are unsupported",
    "the output is recomputed from exact text spans and remains unexecuted"
  ])
}]);
const UNUSED_TYPE_IMPORT_DIAGNOSTIC_PATTERN_ID = "diagnostic.typescript.unused_type_import.v1";
const UNUSED_TYPE_IMPORT_PRECONDITION_IDS = [
  "repair.precondition.exact_source_content_hash",
  "repair.precondition.exact_type_import_declaration_hash",
  "repair.precondition.local_binding_unreferenced"
] as const;
const UNUSED_TYPE_IMPORT_POSTCONDITION_IDS = [
  "repair.postcondition.type_import_declaration_absent",
  "repair.postcondition.all_unrelated_bytes_preserved",
  "repair.postcondition.typecheck_required"
] as const;

export interface DiagnosticPattern {
  id: string;
  class: DiagnosticClass;
  pattern: RegExp;
  confidence?: number;
  symbolGroup?: number;
}

export interface ProgramDiagnostic {
  id: string;
  class: DiagnosticClass;
  patternId?: string;
  path?: string;
  line?: number;
  column?: number;
  symbol?: string;
  message: string;
  raw: string;
  confidence: number;
  confidenceStatus?: "compiler-observation-identity-not-patch-success-probability" | "provisional-uncalibrated";
}

export interface RepairOperation {
  id: string;
  kind: RepairOperationKind;
  path: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  packageName?: string;
  reason: string;
  risk: number;
  riskStatus?: "provisional-uncalibrated";
  repairFamilyId?: ProgramRepairFamilyId;
  preconditions?: Array<{ id: string; value: string }>;
  postconditions?: Array<{ id: string; value: string }>;
  textChanges?: ExactProgramTextChange[];
  diagnosticEvidence?: TypeScriptCodeActionDiagnosticEvidence;
  codeFixEvidence?: TypeScriptCodeActionFixEvidence;
  compilerContext?: TypeScriptCodeActionCompilerContext;
  createdArtifact?: {
    mediaType: string;
    role: FileArtifact["role"];
  };
}

export interface ExactProgramTextChange {
  start: number;
  length: number;
  newText: string;
}

export interface TypeScriptCodeActionDiagnosticEvidence {
  path?: string;
  code: number;
  category: string;
  start: number;
  length: number;
  message: string;
  diagnosticIdentity: string;
}

export interface TypeScriptCodeActionFixEvidence {
  fixName: string;
  description: string;
  fixId?: string;
  codeFixIdentity: string;
  fileChanges?: TypeScriptCodeActionFileChangeEvidence[];
}

export interface TypeScriptCodeActionFileChangeEvidence {
  path: string;
  isNewFile: boolean;
  baseContentHash: string | null;
  textChanges: ExactProgramTextChange[];
}

export interface TypeScriptCodeActionCompilerContext {
  version: string;
  tsconfigPath: string;
  tsconfigContentHash: string;
  compilerOptionsHash: string;
  compilerOptionsSource: string;
  configDiagnosticCodes: number[];
  sourceFileBoundary?: "workspace_snapshot_and_typescript_standard_library";
  compilerCommand: {
    executable: string;
    args: string[];
    cwd: string;
    sourcePath: string;
    sourceContentHash: string;
  };
}

export interface TypeScriptCodeActionRepairTransformation {
  /** The exact source artifact carrying the selected compiler diagnostic. */
  path: string;
  baseArtifactId: string;
  baseContentHash: string;
  snapshotHash?: string;
  diagnostic: TypeScriptCodeActionDiagnosticEvidence;
  codeFix: {
    fixName: string;
    description: string;
    fixId?: string;
    codeFixIdentity: string;
    /** Legacy single-target shape retained for serialized compatibility. */
    textChanges?: ExactProgramTextChange[];
    /** Canonical atomic action shape. */
    fileChanges?: Array<TypeScriptCodeActionFileChangeEvidence & {
      baseArtifactId?: string | null;
      mediaType?: string;
      role?: FileArtifact["role"];
    }>;
  };
  compiler: TypeScriptCodeActionCompilerContext;
}

export interface VerifiedUnusedTypeImportRemoval {
  familyId: typeof UNUSED_TYPE_IMPORT_REPAIR_FAMILY;
  binding: string;
  moduleSpecifier: string;
  line: number;
  declarationHash: string;
  preconditionIds: string[];
  postconditionIds: string[];
}

export interface RepairPatchSet {
  id: string;
  diagnostics: ProgramDiagnostic[];
  operations: RepairOperation[];
  affectedFiles: string[];
  sourceEvidence: Array<{ path: string; artifactId: string; contentHash: string }>;
  rollbackPlan: Array<{ path: string; restoreContentHash: string; strategyId: string }>;
  unsupportedFields: string[];
  approvalRequired: boolean;
  estimatedRisk: number;
  confidence: number;
  explanation: string[];
  audit: JsonValue;
}

export interface RepairPlan {
  id: string;
  programId: string;
  attemptsAllowed: number;
  selectedPatchSet?: RepairPatchSet;
  patchSets: RepairPatchSet[];
  buildCommand: ProgramGraph["build"];
  testCommand: ProgramGraph["test"];
  validationPlan: Array<{ id: string; command: ProgramGraph["build"]; commandSource: string; expectedFiles: string[] }>;
  riskList: Array<{ id: string; severity: "info" | "warning" | "error"; path?: string; reason: string }>;
  dryRunPatchArtifact: JsonValue;
  transaction: {
    reads: string[];
    writes: string[];
    approvalGate: boolean;
  };
  audit: JsonValue;
}

export interface MaterializedProgramRepair {
  program: ProgramGraph;
  changedPaths: string[];
  trace: JsonValue;
}

/**
 * Materializes a selected, source-bound repair as complete file artifacts. The
 * result is still a proposal: it neither touches a workspace nor claims that
 * build or test validation succeeded.
 */
export function materializeProgramRepair(input: {
  program: ProgramGraph;
  build?: BuildTestResult;
  stdout?: string;
  stderr?: string;
  requestText?: string;
  patchSetId?: string;
  hasher?: Hasher;
  maxAttempts?: number;
  diagnosticPatterns?: readonly DiagnosticPattern[];
}): MaterializedProgramRepair {
  const hasher = input.hasher ?? createHasher();
  const repairPlan = createProgramRepairKernel({
    hasher,
    maxAttempts: input.maxAttempts,
    diagnosticPatterns: input.diagnosticPatterns
  }).plan({
    program: input.program,
    build: input.build,
    stdout: input.stdout,
    stderr: input.stderr,
    requestText: input.requestText
  });
  const patchSet = input.patchSetId
    ? repairPlan.patchSets.find(candidate => candidate.id === input.patchSetId)
    : repairPlan.selectedPatchSet;
  if (!patchSet) {
    throw new Error(input.patchSetId
      ? "program repair patch set is not part of the internally recomputed repair plan"
      : "program repair plan has no selected patch set");
  }
  return materializeSelectedRepairPatchSet({
    program: input.program,
    repairPlan,
    patchSet,
    hasher
  });
}

/**
 * Materializes one compiler-produced TypeScript CodeFixAction. Complete output
 * bytes are never accepted: they are recomputed here from exact base artifacts
 * and bounded, non-overlapping text spans before entering the common repair lane.
 */
export function materializeTypeScriptCodeActionRepair(input: {
  program: ProgramGraph;
  transformations: readonly TypeScriptCodeActionRepairTransformation[];
  requestText: string;
  hasher?: Hasher;
}): MaterializedProgramRepair {
  const hasher = input.hasher ?? createHasher();
  if (input.transformations.length !== 1) {
    throw new Error("TypeScript code-action repair requires exactly one atomic compiler action");
  }
  const transformation = input.transformations[0]!;
  const diagnosticArtifact = input.program.files.find(file => file.path === transformation.path);
  if (!diagnosticArtifact
    || String(diagnosticArtifact.artifactId) !== transformation.baseArtifactId
    || String(diagnosticArtifact.contentHash) !== transformation.baseContentHash
    || String(diagnosticArtifact.contentHash) !== `sha256_${hasher.digestHex(diagnosticArtifact.content)}`) {
    throw new Error(`TypeScript code-action repair base artifact is stale: ${transformation.path}`);
  }
  if (!isTypeScriptSource(diagnosticArtifact)) {
    throw new Error(`TypeScript code-action repair requires an owned TypeScript source artifact: ${transformation.path}`);
  }
  const diagnostic = validateTypeScriptDiagnostic(transformation.diagnostic, diagnosticArtifact.content);
  const compiler = validateTypeScriptCompilerContext(transformation.compiler, input.program, hasher);
  const fileChanges = normalizeTypeScriptActionFileChanges(transformation, input.program, hasher);
  if (fileChanges.some(change => change.isNewFile) && !/^sha256:[0-9a-f]{64}$/u.test(transformation.snapshotHash ?? "")) {
    throw new Error("TypeScript code-action create requires an exact compiler snapshot hash");
  }
  const diagnosticIdentity = canonicalTypeScriptDiagnosticIdentity({
    path: diagnosticArtifact.path,
    diagnostic,
    compilerVersion: compiler.version,
    compilerOptionsHash: compiler.compilerOptionsHash
  }, hasher);
  if (diagnostic.diagnosticIdentity !== diagnosticIdentity) {
    throw new Error("TypeScript code-action diagnostic identity is not canonical for its exact source span");
  }
  const usesAtomicFileChanges = Boolean(transformation.codeFix.fileChanges?.length);
  const codeFix = {
    fixName: requiredRepairString(transformation.codeFix.fixName, "TypeScript code-fix name"),
    description: requiredRepairString(transformation.codeFix.description, "TypeScript code-fix description"),
    ...(transformation.codeFix.fixId ? { fixId: transformation.codeFix.fixId } : {}),
    ...(usesAtomicFileChanges
      ? {
        fileChanges: fileChanges.map(change => ({
          path: change.path,
          isNewFile: change.isNewFile,
          baseContentHash: change.baseContentHash === null ? null : canonicalIdentityContentHash(change.baseContentHash),
          textChanges: change.textChanges
        }))
      }
      : { textChanges: fileChanges[0]!.textChanges })
  };
  const codeFixIdentity = canonicalTypeScriptCodeFixIdentity({
    diagnosticIdentity,
    codeFix
  }, hasher);
  if (transformation.codeFix.codeFixIdentity !== codeFixIdentity) {
    throw new Error(`TypeScript code-action identity is not canonical for its diagnostic and exact text changes: expected ${codeFixIdentity}, found ${transformation.codeFix.codeFixIdentity}`);
  }
  const compilerCommandIdentity = canonicalTypeScriptCompilerCommandIdentity(compiler.compilerCommand, hasher);
  const codeFixEvidence: TypeScriptCodeActionFixEvidence = {
    fixName: codeFix.fixName,
    description: codeFix.description,
    ...(codeFix.fixId ? { fixId: codeFix.fixId } : {}),
    codeFixIdentity,
    ...(usesAtomicFileChanges ? {
      fileChanges: fileChanges.map(change => ({
        path: change.path,
        isNewFile: change.isNewFile,
        baseContentHash: change.baseContentHash,
        textChanges: change.textChanges
      }))
    } : {})
  };
  const repairOperations = fileChanges.map(change => {
    const textChangeHash = `sha256_${hasher.digestHex(canonicalStringify(change.textChanges))}`;
    const outputContentHash = `sha256_${hasher.digestHex(change.afterContent)}`;
    const sourcePrecondition = change.isNewFile
      ? { id: "repair.precondition.target_absent_in_compiler_snapshot", value: `${transformation.snapshotHash}:${change.path}` }
      : { id: "repair.precondition.exact_source_content_hash", value: change.baseContentHash! };
    return operation(
      change.isNewFile ? "create" : "replace",
      change.path,
      undefined,
      undefined,
      change.isNewFile ? change.afterContent : undefined,
      `Apply atomic official TypeScript code fix ${transformation.codeFix.fixName} for diagnostic TS${diagnostic.code}.`,
      change.isNewFile ? 0.22 : 0.14,
      hasher,
      undefined,
      {
        repairFamilyId: TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY,
        textChanges: change.textChanges,
        diagnosticEvidence: { ...diagnostic, diagnosticIdentity, path: diagnosticArtifact.path },
        codeFixEvidence,
        compilerContext: compiler,
        ...(change.isNewFile ? { createdArtifact: { mediaType: change.mediaType, role: change.role } } : {}),
        preconditions: [
          sourcePrecondition,
          { id: "repair.precondition.typescript_diagnostic_identity", value: diagnosticIdentity },
          { id: "repair.precondition.typescript_code_fix_identity", value: codeFixIdentity },
          { id: "repair.precondition.compiler_options_hash", value: compiler.compilerOptionsHash },
          { id: "repair.precondition.tsconfig_content_hash", value: compiler.tsconfigContentHash },
          { id: "repair.precondition.compiler_command_identity", value: compilerCommandIdentity },
          { id: "repair.precondition.compiler_command_source_content_hash", value: compiler.compilerCommand.sourceContentHash }
        ],
        postconditions: [
          { id: "repair.postcondition.exact_text_changes_applied", value: textChangeHash },
          { id: "repair.postcondition.exact_output_content_hash", value: outputContentHash },
          { id: "repair.postcondition.compiler_diagnostic_recheck_required", value: `TS${diagnostic.code}` },
          { id: "repair.postcondition.typecheck_required", value: "typecheck" },
          { id: "repair.postcondition.tests_required", value: "tests" }
        ]
      }
    );
  });
  const programDiagnostic: ProgramDiagnostic = {
    id: diagnosticIdentity,
    class: "type",
    patternId: "diagnostic.typescript.language_service.v1",
    path: diagnosticArtifact.path,
    line: lineForOffset(diagnosticArtifact.content, diagnostic.start),
    column: columnForOffset(diagnosticArtifact.content, diagnostic.start),
    message: diagnostic.message,
    raw: `TS${diagnostic.code}: ${diagnostic.message}`,
    confidence: 1,
    confidenceStatus: "compiler-observation-identity-not-patch-success-probability"
  };
  const patchSet = patchSetFor(input.program, [programDiagnostic], repairOperations, hasher);
  const repairPlanId = `repair_plan_${hasher.digestHex(canonicalStringify({
    programId: input.program.id,
    requestText: input.requestText,
    diagnosticIdentity,
    codeFixIdentity,
    patchSetId: patchSet.id
  })).slice(0, 32)}`;
  const repairPlan: RepairPlan = {
    id: repairPlanId,
    programId: input.program.id,
    attemptsAllowed: 1,
    selectedPatchSet: patchSet,
    patchSets: [patchSet],
    buildCommand: input.program.build,
    testCommand: input.program.test,
    validationPlan: validationPlanFor(input.program),
    riskList: riskListFor(patchSet),
    dryRunPatchArtifact: dryRunPatchArtifactFor(input.program, patchSet),
    transaction: {
      reads: ["blobs", "construct_graphs", "typescript_language_service"],
      writes: ["blobs", "construct_graphs", "self_rewrite_episodes", "self_rewrite_patches", "events"],
      approvalGate: true
    },
    audit: toJsonValue({
      schema: "scce.program_repair.typescript_code_action.v1",
      requestText: input.requestText,
      diagnosticIdentity,
      codeFixIdentity,
      affectedPaths: fileChanges.map(change => change.path),
      createPaths: fileChanges.filter(change => change.isNewFile).map(change => change.path),
      compilerSnapshotHash: transformation.snapshotHash ?? null,
      compiler,
      patchSetId: patchSet.id,
      scoringStatus: "provisional-uncalibrated",
      operationRisk: repairOperations.map(repairOperation => ({
        path: repairOperation.path,
        value: repairOperation.risk,
        status: repairOperation.riskStatus
      })),
      diagnosticConfidence: {
        value: programDiagnostic.confidence,
        status: programDiagnostic.confidenceStatus,
        patchSuccessProbability: null
      },
      validationState: "not_executed"
    })
  };
  return materializeSelectedRepairPatchSet({ program: input.program, repairPlan, patchSet, hasher });
}

function materializeSelectedRepairPatchSet(input: {
  program: ProgramGraph;
  repairPlan: RepairPlan;
  patchSet: RepairPatchSet;
  hasher: Hasher;
}): MaterializedProgramRepair {
  const { repairPlan, patchSet, hasher } = input;
  const sourceHydration = input.program.hydration;
  if (!sourceHydration) throw new Error("program repair materialization requires a hydrated ProgramGraph");
  const hydrationCheck = validateProgramGraphHydration(input.program);
  if (!hydrationCheck.valid || sourceHydration.program.programId !== input.program.id) {
    throw new Error(`program repair source hydration is invalid: ${hydrationCheck.diagnostics.join(", ") || "program identity mismatch"}`);
  }
  if (patchSet.unsupportedFields.length > 0) {
    throw new Error(`program repair cannot materialize unsupported diagnostics: ${patchSet.unsupportedFields.join(", ")}`);
  }
  const unsupportedOperations = patchSet.operations.filter(operation => operation.kind === "move" || operation.kind === "repair.op.diagnostic_note");
  if (unsupportedOperations.length > 0) {
    throw new Error(`program repair cannot materialize operations without exact file content: ${unsupportedOperations.map(operation => operation.id).join(", ")}`);
  }
  const byPath = new Map(input.program.files.map(file => [file.path, file]));
  if (sourceHydration.files.length !== input.program.files.length || sourceHydration.emissions.length !== input.program.files.length) {
    throw new Error("program repair hydration file set does not match the ProgramGraph");
  }
  const hydratedByPath = new Map(sourceHydration.files.map(file => [file.path, file]));
  const emittedByPath = new Map(sourceHydration.emissions.map(emission => [emission.filePath, emission]));
  for (const file of input.program.files) {
    const actualHash = `sha256_${hasher.digestHex(file.content)}`;
    if (String(file.contentHash) !== actualHash
      || String(hydratedByPath.get(file.path)?.contentHash ?? "") !== actualHash
      || String(emittedByPath.get(file.path)?.contentHash ?? "") !== actualHash) {
      throw new Error(`program repair source artifact identity is stale: ${file.path}`);
    }
  }
  const operationPaths = [...new Set(patchSet.operations.map(operation => operation.path))].sort();
  const affectedPaths = [...new Set(patchSet.affectedFiles)].sort();
  if (canonicalStringify(operationPaths) !== canonicalStringify(affectedPaths)) {
    throw new Error("program repair affected file set does not match its operations");
  }
  const evidencePaths = new Set(patchSet.sourceEvidence.map(source => source.path));
  const createdPaths = new Set(patchSet.operations.filter(operation => operation.kind === "create").map(operation => operation.path));
  const missingSourceEvidence = affectedPaths.filter(path => !createdPaths.has(path) && !evidencePaths.has(path));
  if (missingSourceEvidence.length > 0) {
    throw new Error(`program repair source evidence is missing for affected paths: ${missingSourceEvidence.join(", ")}`);
  }
  for (const source of patchSet.sourceEvidence) {
    const artifact = byPath.get(source.path);
    if (!artifact || String(artifact.artifactId) !== source.artifactId || String(artifact.contentHash) !== source.contentHash) {
      throw new Error(`program repair source evidence is stale: ${source.path}`);
    }
  }
  for (const operation of patchSet.operations) {
    if (operation.kind === "create") {
      if (byPath.has(operation.path)) throw new Error(`program repair create operation targets an owned artifact: ${operation.path}`);
      continue;
    }
    if (!byPath.has(operation.path)) throw new Error(`program repair operation is not bound to an owned full-file artifact: ${operation.path}`);
  }

  const materialized = applyVirtualRepair(input.program.files, patchSet, hasher);
  const materializedByPath = new Map(materialized.files.map(file => [file.path, file]));
  for (const operation of patchSet.operations) {
    const before = byPath.get(operation.path);
    const after = materializedByPath.get(operation.path);
    if (after) assertRepairOperationPostconditions(before, after, operation, hasher);
  }
  const materiallyChanged = materialized.changed.filter(path => materializedByPath.get(path)?.content !== byPath.get(path)?.content);
  if (materiallyChanged.length === 0 || materiallyChanged.length !== affectedPaths.length) {
    throw new Error("program repair produced no complete byte-level change for every affected path");
  }
  const changed = new Set(materiallyChanged);
  const files = materialized.files.map(file => {
    if (!changed.has(file.path)) return file;
    const digest = hasher.digestHex(file.content);
    return {
      ...file,
      artifactId: `repair_artifact_${digest.slice(0, 32)}` as ArtifactId,
      contentHash: `sha256_${digest}` as ContentHash
    };
  });
  const sourceEvidenceIds = sourceHydration.program.provenanceEvidenceIds;
  if (sourceEvidenceIds.length === 0) throw new Error("program repair materialization requires source-bound program provenance");
  const sourcePlanId = `program-repair:${repairPlan.id}:${patchSet.id}`;
  const materializedHydrationNodeId = `${sourcePlanId}:hydration`;
  const filesByPath = new Map(files.map(file => [file.path, file]));
  const inputArtifactPaths = new Set(input.program.files.map(file => file.path));
  const sourceHydrationNodeIds = new Set(
    input.program.nodes.filter(node => node.kind === "program_hydration_contract").map(node => node.id)
  );
  const graphWithoutHydration: Omit<ProgramGraph, "hydration"> = {
    ...input.program,
    id: `repair_program_${hasher.digestHex(JSON.stringify({ programId: input.program.id, patchSetId: patchSet.id, files: files.map(file => file.contentHash) })).slice(0, 32)}`,
    files,
    nodes: [
      ...input.program.nodes
        .filter(node => !sourceHydrationNodeIds.has(node.id))
        .map(node => {
          if (!node.id.startsWith("artifact:")) return node;
          const file = filesByPath.get(node.id.slice("artifact:".length));
          if (!file) return node;
          const metadata = typeof node.metadata === "object" && node.metadata !== null && !Array.isArray(node.metadata)
            ? node.metadata
            : {};
          return { ...node, metadata: toJsonValue({ ...metadata, contentHash: file.contentHash, mediaType: file.mediaType }) };
        }),
      ...files.filter(file => !inputArtifactPaths.has(file.path)).map(file => ({
        id: `artifact:${file.path}`,
        kind: `artifact:${file.role}`,
        label: file.path,
        metadata: toJsonValue({ contentHash: file.contentHash, mediaType: file.mediaType })
      })),
      {
        id: sourcePlanId,
        kind: "program_repair_full_file_materialization",
        label: sourcePlanId,
        metadata: toJsonValue({
          schema: "scce.program_repair.full_file_lineage.v1",
          repairPlanId: repairPlan.id,
          patchSetId: patchSet.id,
          changedPaths: materiallyChanged,
          transformations: materiallyChanged.map(path => {
            const before = byPath.get(path);
            const after = filesByPath.get(path)!;
            return {
              path,
              baseArtifactId: before?.artifactId ?? null,
              baseContentHash: before?.contentHash ?? null,
              outputArtifactId: after.artifactId,
              outputContentHash: after.contentHash,
              operationIds: patchSet.operations.filter(operation => operation.path === path).map(operation => operation.id),
              operations: patchSet.operations.filter(operation => operation.path === path).map(operation => ({
                id: operation.id,
                kind: operation.kind,
                startLine: operation.startLine ?? null,
                endLine: operation.endLine ?? null,
                risk: operation.risk,
                riskStatus: operation.riskStatus ?? "provisional-uncalibrated",
                repairFamilyId: operation.repairFamilyId ?? null,
                preconditions: operation.preconditions ?? [],
                postconditions: operation.postconditions ?? [],
                textChanges: operation.textChanges ?? [],
                diagnosticEvidence: operation.diagnosticEvidence ?? null,
                codeFixEvidence: operation.codeFixEvidence ?? null,
                compilerContext: operation.compilerContext ?? null,
                createdArtifact: operation.createdArtifact ?? null
              })),
              evidence: patchSet.sourceEvidence.filter(source => source.path === path),
              creation: before ? null : {
                baseState: "absent",
                absencePrecondition: patchSet.operations
                  .find(operation => operation.path === path)
                  ?.preconditions?.find(precondition => precondition.id === "repair.precondition.target_absent_in_compiler_snapshot")?.value ?? null
              }
            };
          })
        })
      }
    ],
    edges: [
      ...input.program.edges.filter(edge => edge.relation !== "hydrates_as"
        && !sourceHydrationNodeIds.has(edge.source)
        && !sourceHydrationNodeIds.has(edge.target)),
      ...materialized.changed.map(path => ({ source: sourcePlanId, target: `artifact:${path}`, relation: "materializes_full_file", weight: 1 }))
    ]
  };
  const materializedHydration = createProgramHydrationContract({
    program: graphWithoutHydration,
    sourcePlanId,
    evidenceIds: sourceEvidenceIds,
    risks: repairPlan.riskList.map(risk => risk.id)
  });
  return {
    program: {
      ...graphWithoutHydration,
      hydration: materializedHydration,
      nodes: [
        ...graphWithoutHydration.nodes,
        { id: materializedHydrationNodeId, kind: "program_hydration_contract", label: materializedHydration.schema, metadata: hydrationSummary(materializedHydration) }
      ],
      edges: [
        ...graphWithoutHydration.edges,
        { source: sourcePlanId, target: materializedHydrationNodeId, relation: "hydrates_as", weight: materializedHydration.valid ? 1 : 0.35 }
      ]
    },
    changedPaths: [...materiallyChanged].sort(),
    trace: toJsonValue({
      schema: "scce.program_repair.full_file_materialization.v1",
      sourceProgramId: input.program.id,
      programId: graphWithoutHydration.id,
      repairPlanId: repairPlan.id,
      patchSetId: patchSet.id,
      sourceEvidence: patchSet.sourceEvidence,
      changedPaths: [...materiallyChanged].sort(),
      mutatesRealWorkspace: false,
      validationState: "not_executed"
    })
  };
}

export function createProgramRepairKernel(options: { hasher?: Hasher; maxAttempts?: number; diagnosticPatterns?: readonly DiagnosticPattern[] } = {}) {
  const hasher = options.hasher ?? createHasher();
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const diagnosticPatterns = [unusedTypeImportDiagnosticPattern(), ...(options.diagnosticPatterns ?? [])];
  return {
    parseDiagnostics(input: { stdout?: string; stderr?: string; artifacts?: FileArtifact[] }): ProgramDiagnostic[] {
      return parseDiagnostics(input.stdout ?? "", input.stderr ?? "", input.artifacts ?? [], hasher, diagnosticPatterns);
    },

    plan(input: { program: ProgramGraph; build?: BuildTestResult; stdout?: string; stderr?: string; requestText?: string }): RepairPlan {
      const observedStdout = input.stdout ?? input.build?.build.stdout ?? "";
      const observedStderr = input.stderr ?? input.build?.build.stderr ?? "";
      const derivedDiagnostic = `${observedStdout}\n${observedStderr}`.trim()
        ? undefined
        : deriveUnusedTypeImportDiagnostic(input.program, input.requestText ?? "", hasher);
      const diagnostics = parseDiagnostics(
        derivedDiagnostic ?? observedStdout,
        observedStderr,
        input.program.files,
        hasher,
        diagnosticPatterns
      );
      const patchSets = buildPatchSets({ program: input.program, diagnostics, requestText: input.requestText ?? "", hasher });
      const selectedPatchSet = patchSets.sort((a, b) => b.confidence - a.confidence || a.estimatedRisk - b.estimatedRisk)[0];
      return {
        id: `repair_plan_${hasher.digestHex(JSON.stringify({ program: input.program.id, diagnostics: diagnostics.map(d => d.id), patchSets: patchSets.map(p => p.id) })).slice(0, 32)}`,
        programId: input.program.id,
        attemptsAllowed: maxAttempts,
        selectedPatchSet,
        patchSets,
        buildCommand: input.program.build,
        testCommand: input.program.test,
        validationPlan: validationPlanFor(input.program),
        riskList: riskListFor(selectedPatchSet),
        dryRunPatchArtifact: dryRunPatchArtifactFor(input.program, selectedPatchSet),
        transaction: {
          reads: ["blobs", "construct_graphs", "self_rewrite_episodes"],
          writes: ["blobs", "construct_graphs", "self_rewrite_episodes", "self_rewrite_patches", "events"],
          approvalGate: Boolean(selectedPatchSet?.approvalRequired)
        },
        audit: toJsonValue({
          diagnostics,
          selectedPatchSet: selectedPatchSet ? { id: selectedPatchSet.id, risk: selectedPatchSet.estimatedRisk, confidence: selectedPatchSet.confidence } : null,
          attemptsAllowed: maxAttempts,
          validationPlan: validationPlanFor(input.program),
          riskList: riskListFor(selectedPatchSet),
          dryRunPatchArtifact: dryRunPatchArtifactFor(input.program, selectedPatchSet)
        })
      };
    },

    applyVirtual(input: { files: FileArtifact[]; patchSet: RepairPatchSet }): { files: FileArtifact[]; changed: string[]; audit: JsonValue } {
      const result = applyVirtualRepair(input.files, input.patchSet);
      return { ...result, audit: toJsonValue({ patchSet: input.patchSet.id, changed: result.changed }) };
    }
  };
}

function applyVirtualRepair(
  files: readonly FileArtifact[],
  patchSet: RepairPatchSet,
  hasher: Hasher = createHasher()
): { files: FileArtifact[]; changed: string[] } {
  const byPath = new Map(files.map(file => [file.path, file]));
  const changed = new Set<string>();
  for (const op of patchSet.operations) {
    const file = byPath.get(op.path);
    if (op.kind === "create") {
      if (file || !op.createdArtifact || typeof op.content !== "string") continue;
      const digest = hasher.digestHex(op.content);
      byPath.set(op.path, {
        artifactId: `repair_artifact_${digest.slice(0, 32)}` as ArtifactId,
        path: op.path,
        mediaType: op.createdArtifact.mediaType,
        content: op.content,
        contentHash: `sha256_${digest}` as ContentHash,
        role: op.createdArtifact.role
      });
      changed.add(op.path);
    } else if (!file && op.kind !== "dependency" && op.kind !== "config") {
      continue;
    } else if (op.kind === "replace" && file) {
      const content = op.textChanges
        ? applyExactTextChanges(file.content, normalizeExactTextChanges(op.textChanges, file.content.length))
        : replaceLines(file.content, op.startLine ?? 1, op.endLine ?? op.startLine ?? 1, op.content ?? "");
      byPath.set(op.path, { ...file, content });
      changed.add(op.path);
    } else if (op.kind === "insert" && file) {
      byPath.set(op.path, { ...file, content: insertAtLine(file.content, op.startLine ?? 1, op.content ?? "") });
      changed.add(op.path);
    } else if (op.kind === "delete" && file) {
      byPath.set(op.path, { ...file, content: deleteLinesExact(file.content, op.startLine ?? 1, op.endLine ?? op.startLine ?? 1) });
      changed.add(op.path);
    } else if ((op.kind === "dependency" || op.kind === "config") && file) {
      byPath.set(op.path, { ...file, content: op.content ?? file.content });
      changed.add(op.path);
    }
  }
  return { files: [...byPath.values()], changed: [...changed] };
}

function parseDiagnostics(stdout: string, stderr: string, artifacts: readonly FileArtifact[], hasher: Hasher, patterns: readonly DiagnosticPattern[]): ProgramDiagnostic[] {
  const text = `${stdout}\n${stderr}`;
  const lines = text.split(/\r?\n/).filter(Boolean);
  const diagnostics: ProgramDiagnostic[] = [];
  const artifactPaths = artifacts.map(file => file.path);
  for (const raw of lines) {
    const loc = parseLocation(raw, artifactPaths);
    const matched = matchDiagnosticPattern(raw, patterns);
    const klass = matched?.class ?? diagnosticClassFromText(raw);
    if (klass === "unknown" && !loc) continue;
    const message = raw.length > 500 ? `${raw.slice(0, 497)}...` : raw;
    diagnostics.push({
      id: `diag_${hasher.digestHex(raw).slice(0, 24)}`,
      class: klass,
      patternId: matched?.patternId,
      path: loc?.path,
      line: loc?.line,
      column: loc?.column,
      symbol: matched?.symbol,
      message,
      raw,
      confidence: diagnosticConfidence(klass, loc, raw, matched?.confidence)
    });
  }
  return dedupeDiagnostics(diagnostics);
}

function diagnosticClassFromText(raw: string): DiagnosticClass {
  const lower = raw.toLocaleLowerCase();
  if (lower.includes("syntax")) return "syntax";
  if (lower.includes("type")) return "type";
  if (lower.includes("dependency") || lower.includes("module not found") || lower.includes("cannot find module")) return "dependency";
  if (lower.includes("runtime")) return "runtime";
  if (lower.includes("contract")) return "contract";
  if (lower.includes("security") || lower.includes("secret")) return "security";
  return "unknown";
}

function buildPatchSets(input: { program: ProgramGraph; diagnostics: ProgramDiagnostic[]; requestText: string; hasher: Hasher }): RepairPatchSet[] {
  if (!input.diagnostics.length) return [diagnosticNotePatch(input.program, "No diagnostics were present; preserve artifacts and request fresh verification.", input.hasher)];
  const ownedPaths = new Set(input.program.files.map(file => file.path));
  const byFile = new Map<string, ProgramDiagnostic[]>();
  for (const diag of input.diagnostics) {
    const path = diag.path && ownedPaths.has(diag.path) ? diag.path : nearestFile(input.program.files, diag);
    if (!path) continue;
    const bucket = byFile.get(path) ?? [];
    bucket.push(diag);
    byFile.set(path, bucket);
  }
  const patchSets: RepairPatchSet[] = [];
  for (const [path, diagnostics] of byFile) {
    const file = input.program.files.find(item => item.path === path);
    if (!file) continue;
    const operations = diagnostics.flatMap(diag => operationForDiagnostic(file, diag, input.requestText, input.hasher));
    if (!operations.length) {
      patchSets.push(diagnosticNotePatch(input.program, `Diagnostics in ${path} require human inspection.`, input.hasher, diagnostics));
      continue;
    }
    patchSets.push(patchSetFor(input.program, diagnostics, operations, input.hasher));
  }
  const dependencyDiagnostics = input.diagnostics.filter(diag => diag.class === "dependency");
  if (dependencyDiagnostics.length) {
    const packageFiles = input.program.files.filter(file => /package\.json|Cargo\.toml|pyproject\.toml|\.csproj$/u.test(file.path));
    for (const file of packageFiles) {
      const operations = dependencyDiagnostics.map(diag => dependencyRepair(file, diag, input.hasher)).filter((op): op is RepairOperation => Boolean(op));
      if (operations.length) patchSets.push(patchSetFor(input.program, dependencyDiagnostics, operations, input.hasher));
    }
  }
  return patchSets.length ? patchSets : [diagnosticNotePatch(input.program, "Diagnostics did not map to owned files.", input.hasher, input.diagnostics)];
}

function operationForDiagnostic(file: FileArtifact, diag: ProgramDiagnostic, requestText: string, hasher: Hasher): RepairOperation[] {
  if (diag.patternId === UNUSED_TYPE_IMPORT_DIAGNOSTIC_PATTERN_ID) {
    return unusedTypeImportRepair(file, diag, requestText, hasher);
  }
  if (diag.class === "syntax") return syntaxRepair(file, diag, hasher);
  if (diag.class === "type") return typeRepair(file, diag, requestText, hasher);
  if (diag.class === "contract") return contractRepair(file, diag, hasher);
  if (diag.class === "runtime") return runtimeRepair(file, diag, hasher);
  if (diag.class === "security") return securityRepair(file, diag, hasher);
  return [];
}

function unusedTypeImportRepair(file: FileArtifact, diag: ProgramDiagnostic, requestText: string, hasher: Hasher): RepairOperation[] {
  if (!isTypeScriptSource(file) || !diag.symbol || !isUnusedTypeImportRemovalRequest(requestText, diag.symbol)) return [];
  const candidate = unusedTypeImportCandidates(file.content, hasher)
    .find(item => item.line === diag.line && item.binding === diag.symbol);
  if (!candidate) return [];
  return [operation(
    "delete",
    file.path,
    candidate.line,
    candidate.line,
    undefined,
    `Remove source-proven unreferenced type-only import ${candidate.binding} from ${candidate.moduleSpecifier}.`,
    0.04,
    hasher,
    undefined,
    {
      repairFamilyId: UNUSED_TYPE_IMPORT_REPAIR_FAMILY,
      preconditions: [
        { id: UNUSED_TYPE_IMPORT_PRECONDITION_IDS[0], value: String(file.contentHash) },
        { id: UNUSED_TYPE_IMPORT_PRECONDITION_IDS[1], value: candidate.declarationHash },
        { id: UNUSED_TYPE_IMPORT_PRECONDITION_IDS[2], value: candidate.binding }
      ],
      postconditions: [
        { id: UNUSED_TYPE_IMPORT_POSTCONDITION_IDS[0], value: candidate.declarationHash },
        { id: UNUSED_TYPE_IMPORT_POSTCONDITION_IDS[1], value: "exact_single_line_deletion" },
        { id: UNUSED_TYPE_IMPORT_POSTCONDITION_IDS[2], value: "typecheck" }
      ]
    }
  )];
}

function syntaxRepair(file: FileArtifact, diag: ProgramDiagnostic, hasher: Hasher): RepairOperation[] {
  const line = diag.line ?? locateLikelyLine(file.content, diag);
  const current = lineText(file.content, line);
  const closeBalance = delimiterRepair(current);
  if (closeBalance) {
    return [operation("replace", file.path, line, line, `${current}${closeBalance}`, `Balance delimiters near syntax diagnostic: ${diag.message}`, 0.28, hasher)];
  }
  if (!current.trim() && closingForFile(file)) {
    return [operation("insert", file.path, line + 1, line + 1, closingForFile(file), `Close unterminated module after syntax diagnostic: ${diag.message}`, 0.34, hasher)];
  }
  return [operation("replace", file.path, line, line, current.trimEnd(), `Normalize syntax line near diagnostic: ${diag.message}`, 0.22, hasher)];
}

function typeRepair(file: FileArtifact, diag: ProgramDiagnostic, _requestText: string, hasher: Hasher): RepairOperation[] {
  const line = diag.line ?? locateLikelyLine(file.content, diag);
  const current = lineText(file.content, line);
  const symbol = diag.symbol;
  if (symbol) {
    const exportLine = file.mediaType.includes("typescript") || file.path.endsWith(".ts") || file.path.endsWith(".tsx")
      ? `const ${safeIdentifier(symbol)} = undefined as never;`
      : file.path.endsWith(".py")
        ? `${safeIdentifier(symbol)} = None`
        : "";
    if (exportLine) return [operation("insert", file.path, Math.max(1, line - 1), Math.max(1, line - 1), exportLine, `Introduce explicit symbol boundary for ${symbol}; caller remains visible for next verification.`, 0.48, hasher)];
  }
  const widened = widenStructuralAccess(current);
  if (widened !== current) {
    return [operation("replace", file.path, line, line, widened, `Guard structural property access from diagnostic: ${diag.message}`, 0.42, hasher)];
  }
  const converted = addExplicitConversion(current);
  if (converted !== current) {
    return [operation("replace", file.path, line, line, converted, `Add explicit conversion boundary for type diagnostic: ${diag.message}`, 0.46, hasher)];
  }
  return [operation("replace", file.path, line, line, current, `Keep type diagnostic localized for verification: ${diag.message}`, 0.55, hasher)];
}

function contractRepair(file: FileArtifact, diag: ProgramDiagnostic, hasher: Hasher): RepairOperation[] {
  const line = diag.line ?? locateLikelyLine(file.content, diag);
  const current = lineText(file.content, line);
  return current.trim()
    ? [operation("insert", file.path, line, line, contractGuardFor(file), `Add explicit contract guard for ${diag.message}`, 0.38, hasher)]
    : [operation("replace", file.path, line, line, current, `Contract diagnostic retained for focused review: ${diag.message}`, 0.5, hasher)];
}

function runtimeRepair(file: FileArtifact, diag: ProgramDiagnostic, hasher: Hasher): RepairOperation[] {
  const line = diag.line ?? locateLikelyLine(file.content, diag);
  const current = lineText(file.content, line);
  const guarded = addNullishGuard(current);
  if (guarded !== current) return [operation("replace", file.path, line, line, guarded, `Guard nullish runtime access: ${diag.message}`, 0.44, hasher)];
  if (current.trim()) return [operation("insert", file.path, line, line, boundCheckFor(file), `Add bounded runtime guard: ${diag.message}`, 0.4, hasher)];
  return [operation("replace", file.path, line, line, current, `Runtime diagnostic localized: ${diag.message}`, 0.52, hasher)];
}

function securityRepair(file: FileArtifact, diag: ProgramDiagnostic, hasher: Hasher): RepairOperation[] {
  const line = diag.line ?? locateLikelyLine(file.content, diag);
  const current = lineText(file.content, line);
  const redacted = current.replace(/(["'`])[^"'`]{8,}\1/g, "\"[REDACTED]\"");
  if (redacted !== current) return [operation("replace", file.path, line, line, redacted, `Redact sensitive literal near diagnostic: ${diag.message}`, 0.3, hasher)];
  return [operation("insert", file.path, line, line, securityCommentFor(file), `Surface security invariant near diagnostic: ${diag.message}`, 0.36, hasher)];
}

function dependencyRepair(file: FileArtifact, diag: ProgramDiagnostic, hasher: Hasher): RepairOperation | undefined {
  const pkg = diag.symbol;
  if (!pkg) return undefined;
  if (file.path.endsWith("package.json")) {
    const next = patchPackageJson(file.content, pkg);
    return operation("dependency", file.path, 1, lineCount(file.content), next, `Add or preserve dependency ${pkg} for diagnostic: ${diag.message}`, 0.5, hasher, pkg);
  }
  if (file.path.endsWith("Cargo.toml")) {
    const next = file.content.includes(`[dependencies]`) ? `${file.content.trimEnd()}\n${pkg} = "*"\n` : `${file.content.trimEnd()}\n\n[dependencies]\n${pkg} = "*"\n`;
    return operation("dependency", file.path, 1, lineCount(file.content), next, `Add dependency ${pkg}`, 0.54, hasher, pkg);
  }
  if (file.path.endsWith("pyproject.toml")) {
    return operation("dependency", file.path, 1, lineCount(file.content), `${file.content.trimEnd()}\n# dependency required: ${pkg}\n`, `Record dependency requirement ${pkg}`, 0.48, hasher, pkg);
  }
  return undefined;
}

function patchSetFor(program: ProgramGraph, diagnostics: ProgramDiagnostic[], operations: RepairOperation[], hasher: Hasher): RepairPatchSet {
  const affectedFiles = [...new Set(operations.map(op => op.path))];
  const sourceEvidence = affectedFiles.flatMap(path => {
    const file = program.files.find(item => item.path === path);
    return file ? [{ path: file.path, artifactId: String(file.artifactId), contentHash: String(file.contentHash) }] : [];
  });
  const sourceByPath = new Map(sourceEvidence.map(item => [item.path, item]));
  const rollbackPlan = affectedFiles.map(path => {
    const source = sourceByPath.get(path);
    return source
      ? { path, restoreContentHash: source.contentHash, strategyId: "repair.rollback.restore_original_artifact" }
      : { path, restoreContentHash: "absent", strategyId: "repair.rollback.delete_created_artifact" };
  });
  const unsupportedFields = diagnostics
    .filter(diag => diag.class === "unknown")
    .map(diag => diag.path ? `${diag.class}:${diag.path}` : diag.class);
  const estimatedRisk = clamp01(operations.reduce((sum, op) => sum + op.risk, 0) / Math.max(1, operations.length) + affectedFiles.length * 0.03);
  const diagnosticConfidence = diagnostics.reduce((sum, diag) => sum + diag.confidence, 0) / Math.max(1, diagnostics.length);
  const operationConfidence = clamp01(1 - estimatedRisk * 0.55);
  const confidence = clamp01(0.55 * diagnosticConfidence + 0.45 * operationConfidence);
  return {
    id: `patchset_${hasher.digestHex(JSON.stringify({ program: program.id, diagnostics: diagnostics.map(d => d.id), operations: operations.map(o => o.id) })).slice(0, 28)}`,
    diagnostics,
    operations,
    affectedFiles,
    sourceEvidence,
    rollbackPlan,
    unsupportedFields,
    approvalRequired: estimatedRisk > 0.45 || operations.some(op => op.kind === "dependency" || op.kind === "config"),
    estimatedRisk,
    confidence,
    explanation: [
      `${diagnostics.length} diagnostics mapped to ${affectedFiles.length} owned files`,
      `${operations.length} repair operations prepared`,
      `provisional_uncalibrated_confidence=${confidence.toFixed(3)}`,
      `provisional_uncalibrated_risk=${estimatedRisk.toFixed(3)}`
    ],
    audit: toJsonValue({
      scoringStatus: "provisional-uncalibrated",
      confidenceMeaning: "routing heuristic, not patch-success probability",
      affectedFiles,
      sourceEvidence,
      rollbackPlan,
      unsupportedFields,
      diagnostics: diagnostics.map(d => ({ id: d.id, class: d.class, path: d.path, line: d.line, confidenceStatus: d.confidenceStatus ?? "provisional-uncalibrated" })),
      operations
    })
  };
}

function validationPlanFor(program: ProgramGraph): RepairPlan["validationPlan"] {
  const expectedFiles = program.files.map(file => file.path);
  return [
    { id: `${program.id}:build`, command: program.build, commandSource: commandSourceId(program.build), expectedFiles },
    { id: `${program.id}:test`, command: program.test, commandSource: commandSourceId(program.test), expectedFiles }
  ];
}

function commandSourceId(command: { command: string }): string {
  return command.command === "source-derived" ? "program.validation.command.source_derived" : "program.validation.command.observed";
}

function riskListFor(patchSet: RepairPatchSet | undefined): RepairPlan["riskList"] {
  if (!patchSet) return [{ id: "repair.risk.no_patchset", severity: "warning", reason: "No patch set was selected." }];
  const risks: RepairPlan["riskList"] = [];
  if (patchSet.approvalRequired) risks.push({ id: "repair.risk.approval_required", severity: "warning", reason: "Patch set requires owner approval before mutation." });
  if (patchSet.estimatedRisk > 0.45) risks.push({ id: "repair.risk.estimated_high", severity: "warning", reason: `Estimated risk ${patchSet.estimatedRisk.toFixed(3)}.` });
  for (const op of patchSet.operations) if (op.kind === "dependency" || op.kind === "config") risks.push({ id: "repair.risk.config_or_dependency", severity: "warning", path: op.path, reason: op.reason });
  return risks.length ? risks : [{ id: "repair.risk.low", severity: "info", reason: "Patch set is source-local and dry-run only." }];
}

function dryRunPatchArtifactFor(program: ProgramGraph, patchSet: RepairPatchSet | undefined): JsonValue {
  return toJsonValue({
    schema: "scce.program_repair.dry_run_patch.v1",
    programId: program.id,
    patchSetId: patchSet?.id ?? null,
    affectedFiles: patchSet?.affectedFiles ?? [],
    operations: patchSet?.operations.map(op => ({
      id: op.id,
      kind: op.kind,
      path: op.path,
      startLine: op.startLine ?? null,
      endLine: op.endLine ?? null,
      reason: op.reason,
      risk: op.risk,
      riskStatus: op.riskStatus ?? "provisional-uncalibrated",
      repairFamilyId: op.repairFamilyId ?? null,
      preconditions: op.preconditions ?? [],
      postconditions: op.postconditions ?? [],
      textChanges: op.textChanges ?? [],
      diagnosticEvidence: op.diagnosticEvidence ?? null,
      codeFixEvidence: op.codeFixEvidence ?? null,
      compilerContext: op.compilerContext ?? null,
      createdArtifact: op.createdArtifact ?? null
    })) ?? [],
    rollbackPlan: patchSet?.rollbackPlan ?? [],
    sourceEvidence: patchSet?.sourceEvidence ?? [],
    mutatesRealWorkspace: false
  });
}

function diagnosticNotePatch(program: ProgramGraph, reason: string, hasher: Hasher, diagnostics: ProgramDiagnostic[] = []): RepairPatchSet {
  const diagnosticPath = diagnostics.find(diag => diag.path && program.files.some(file => file.path === diag.path))?.path;
  const operations = [operation("repair.op.diagnostic_note", diagnosticPath ?? program.files[0]?.path ?? "README.md", 1, 1, reason, reason, 0.18, hasher)];
  return patchSetFor(program, diagnostics, operations, hasher);
}

function operation(
  kind: RepairOperationKind,
  path: string,
  startLine: number | undefined,
  endLine: number | undefined,
  content: string | undefined,
  reason: string,
  risk: number,
  hasher: Hasher,
  packageName?: string,
  contract?: Pick<RepairOperation,
    "repairFamilyId" | "preconditions" | "postconditions" | "textChanges" | "diagnosticEvidence" | "codeFixEvidence" | "compilerContext" | "createdArtifact">
): RepairOperation {
  return {
    id: `repair_op_${hasher.digestHex(canonicalStringify({ kind, path, startLine, endLine, content, reason, packageName, contract })).slice(0, 24)}`,
    kind,
    path,
    startLine,
    endLine,
    content,
    packageName,
    reason,
    risk: clamp01(risk),
    riskStatus: "provisional-uncalibrated",
    ...contract
  };
}

interface UnusedTypeImportCandidate {
  binding: string;
  moduleSpecifier: string;
  line: number;
  declaration: string;
  declarationHash: string;
}

interface ExactLineRange {
  line: number;
  start: number;
  textEnd: number;
  end: number;
}

export function canonicalTypeScriptDiagnosticIdentity(input: {
  path: string;
  diagnostic: Pick<TypeScriptCodeActionDiagnosticEvidence, "code" | "category" | "start" | "length" | "message">;
  compilerVersion: string;
  compilerOptionsHash: string;
}, hasher: Hasher = createHasher()): string {
  return `typescript.diagnostic:${hasher.digestHex(stableIdentitySerialize({
    path: input.path,
    diagnostic: {
      code: input.diagnostic.code,
      category: input.diagnostic.category,
      start: input.diagnostic.start,
      length: input.diagnostic.length,
      message: input.diagnostic.message
    },
    compilerVersion: input.compilerVersion,
    compilerOptionsHash: input.compilerOptionsHash
  }))}`;
}

export function canonicalTypeScriptCodeFixIdentity(input: {
  diagnosticIdentity: string;
  codeFix: {
    fixName: string;
    description: string;
    fixId?: string;
    textChanges?: readonly ExactProgramTextChange[];
    fileChanges?: readonly TypeScriptCodeActionFileChangeEvidence[];
  };
}, hasher: Hasher = createHasher()): string {
  const actionChanges = input.codeFix.fileChanges && input.codeFix.fileChanges.length > 0
    ? {
      fileChanges: [...input.codeFix.fileChanges]
        .map(change => ({
          path: change.path,
          isNewFile: change.isNewFile,
          baseContentHash: change.baseContentHash === null ? null : canonicalIdentityContentHash(change.baseContentHash),
          textChanges: change.textChanges
        }))
        .sort((left, right) => left.path.localeCompare(right.path))
    }
    : { textChanges: input.codeFix.textChanges ?? [] };
  return `typescript.code_fix:${hasher.digestHex(stableIdentitySerialize({
    diagnosticIdentity: input.diagnosticIdentity,
    codeFix: {
      fixName: input.codeFix.fixName,
      description: input.codeFix.description,
      ...(input.codeFix.fixId ? { fixId: input.codeFix.fixId } : {}),
      ...actionChanges
    }
  }))}`;
}

function canonicalIdentityContentHash(value: string): string {
  const match = /^(?:sha256[:_])?([0-9a-f]{64})$/iu.exec(value);
  if (!match?.[1]) throw new Error(`TypeScript code-action base content hash is not SHA-256: ${value}`);
  return `sha256:${match[1].toLocaleLowerCase()}`;
}

export function canonicalTypeScriptCompilerCommandIdentity(input: TypeScriptCodeActionCompilerContext["compilerCommand"], hasher: Hasher = createHasher()): string {
  return `typescript.compiler_command:${hasher.digestHex(stableIdentitySerialize(input))}`;
}

export function canonicalTypeScriptCompilerOptionsHash(options: unknown, hasher: Hasher = createHasher()): string {
  return `sha256:${hasher.digestHex(stableIdentitySerialize(options))}`;
}

function stableIdentitySerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableIdentitySerialize).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .filter(key => record[key] !== undefined)
    .map(key => `${JSON.stringify(key)}:${stableIdentitySerialize(record[key])}`)
    .join(",")}}`;
}

function validateTypeScriptDiagnostic(
  value: TypeScriptCodeActionDiagnosticEvidence,
  source: string
): TypeScriptCodeActionDiagnosticEvidence {
  if (!Number.isSafeInteger(value.code) || value.code <= 0
    || !Number.isSafeInteger(value.start) || value.start < 0
    || !Number.isSafeInteger(value.length) || value.length < 0
    || value.start + value.length > source.length) {
    throw new Error("TypeScript code-action diagnostic span is outside the exact source artifact");
  }
  return {
    code: value.code,
    category: requiredRepairString(value.category, "TypeScript diagnostic category"),
    start: value.start,
    length: value.length,
    message: requiredRepairString(value.message, "TypeScript diagnostic message"),
    diagnosticIdentity: requiredRepairString(value.diagnosticIdentity, "TypeScript diagnostic identity")
  };
}

function validateTypeScriptCompilerContext(
  value: TypeScriptCodeActionCompilerContext,
  program: ProgramGraph,
  hasher: Hasher
): TypeScriptCodeActionCompilerContext {
  const compilerCommand = {
    executable: requiredRepairString(value.compilerCommand?.executable, "TypeScript compiler command executable"),
    args: [...(value.compilerCommand?.args ?? [])].map((arg, index) => requiredRepairString(arg, `TypeScript compiler command argument ${index}`)),
    cwd: requiredRepairString(value.compilerCommand?.cwd, "TypeScript compiler command cwd"),
    sourcePath: requiredRepairString(value.compilerCommand?.sourcePath, "TypeScript compiler command source path"),
    sourceContentHash: requiredRepairString(value.compilerCommand?.sourceContentHash, "TypeScript compiler command source content hash")
  };
  const tsconfigPath = requiredRepairString(value.tsconfigPath, "TypeScript config path");
  const tsconfigContentHash = requiredRepairString(value.tsconfigContentHash, "TypeScript config content hash");
  const context: TypeScriptCodeActionCompilerContext = {
    version: requiredRepairString(value.version, "TypeScript compiler version"),
    tsconfigPath,
    tsconfigContentHash,
    compilerOptionsHash: requiredRepairString(value.compilerOptionsHash, "TypeScript compiler-options hash"),
    compilerOptionsSource: requiredRepairString(value.compilerOptionsSource, "TypeScript compiler-options source"),
    configDiagnosticCodes: [...value.configDiagnosticCodes],
    sourceFileBoundary: value.sourceFileBoundary,
    compilerCommand
  };
  if (!/^sha256:[0-9a-f]{64}$/u.test(context.compilerOptionsHash)) {
    throw new Error("TypeScript compiler-options hash is not canonical SHA-256");
  }
  if (context.configDiagnosticCodes.some(code => !Number.isSafeInteger(code) || code <= 0)) {
    throw new Error("TypeScript code-action compiler context contains an invalid configuration diagnostic");
  }
  if (context.sourceFileBoundary !== "workspace_snapshot_and_typescript_standard_library") {
    throw new Error("TypeScript code-action compiler source boundary is not the exact workspace snapshot");
  }
  if (context.configDiagnosticCodes.length > 0) {
    throw new Error(`TypeScript code-action repair requires a valid compiler configuration: ${context.configDiagnosticCodes.join(", ")}`);
  }
  if (context.compilerOptionsSource !== "source_observed_tsc_project") {
    throw new Error("TypeScript code-action compiler options are not bound to a source-observed tsc project");
  }
  if (program.build.command !== compilerCommand.executable
    || program.build.cwd !== compilerCommand.cwd
    || program.build.args.length !== compilerCommand.args.length
    || program.build.args.some((arg, index) => arg !== compilerCommand.args[index])) {
    throw new Error("TypeScript code-action compiler command does not match the source-observed ProgramGraph build lane");
  }
  const commandSourceArtifact = program.files.find(file => file.path === compilerCommand.sourcePath);
  const commandSourceDirectory = compilerCommand.sourcePath.includes("/")
    ? compilerCommand.sourcePath.slice(0, compilerCommand.sourcePath.lastIndexOf("/"))
    : ".";
  if (!commandSourceArtifact
    || String(commandSourceArtifact.contentHash) !== compilerCommand.sourceContentHash
    || compilerCommand.sourceContentHash !== `sha256_${hasher.digestHex(commandSourceArtifact.content)}`
    || compilerCommand.cwd !== commandSourceDirectory) {
    throw new Error(`TypeScript code-action compiler command is not bound to an exact ProgramGraph artifact: ${compilerCommand.sourcePath}`);
  }
  const configArtifact = program.files.find(file => file.path === tsconfigPath);
  if (!configArtifact
    || String(configArtifact.contentHash) !== tsconfigContentHash
    || tsconfigContentHash !== `sha256_${hasher.digestHex(configArtifact.content)}`) {
    throw new Error(`TypeScript code-action compiler config is not bound to an exact ProgramGraph artifact: ${tsconfigPath}`);
  }
  return context;
}

interface NormalizedTypeScriptActionFileChange extends TypeScriptCodeActionFileChangeEvidence {
  baseArtifactId: string | null;
  afterContent: string;
  mediaType: string;
  role: FileArtifact["role"];
}

function normalizeTypeScriptActionFileChanges(
  transformation: TypeScriptCodeActionRepairTransformation,
  program: ProgramGraph,
  hasher: Hasher
): NormalizedTypeScriptActionFileChange[] {
  const supplied = transformation.codeFix.fileChanges?.length
    ? transformation.codeFix.fileChanges
    : transformation.codeFix.textChanges?.length
      ? [{
        path: transformation.path,
        isNewFile: false,
        baseArtifactId: transformation.baseArtifactId,
        baseContentHash: transformation.baseContentHash,
        textChanges: transformation.codeFix.textChanges
      }]
      : [];
  if (supplied.length === 0 || supplied.length > 32) {
    throw new Error("TypeScript code-action repair requires between 1 and 32 affected files");
  }
  const normalized: NormalizedTypeScriptActionFileChange[] = [];
  const seenPaths = new Set<string>();
  let totalTextChanges = 0;
  for (const suppliedChange of supplied) {
    const changePath = normalizeProgramRepairPath(suppliedChange.path);
    if (seenPaths.has(changePath)) throw new Error(`TypeScript code-action repair repeats an affected path: ${changePath}`);
    seenPaths.add(changePath);
    const current = program.files.find(file => file.path === changePath);
    const isNewFile = suppliedChange.isNewFile === true;
    if (isNewFile && current) throw new Error(`TypeScript code-action create target already exists: ${changePath}`);
    if (!isNewFile && !current) throw new Error(`TypeScript code-action replacement target is absent: ${changePath}`);
    if (isNewFile && !/\.(?:[cm]?[jt]s|[jt]sx)$/iu.test(changePath)) {
      throw new Error(`TypeScript code-action create target is not a supported source file: ${changePath}`);
    }
    const baseContent = current?.content ?? "";
    const baseContentHash = current ? String(current.contentHash) : null;
    const baseArtifactId = current ? String(current.artifactId) : null;
    if (current) {
      if (suppliedChange.baseContentHash !== baseContentHash
        || suppliedChange.baseArtifactId !== baseArtifactId
        || baseContentHash !== `sha256_${hasher.digestHex(baseContent)}`) {
        throw new Error(`TypeScript code-action repair base artifact is stale: ${changePath}`);
      }
    } else if (suppliedChange.baseContentHash !== null
      || suppliedChange.baseArtifactId !== undefined && suppliedChange.baseArtifactId !== null) {
      throw new Error(`TypeScript code-action create must carry a null base identity: ${changePath}`);
    }
    const textChanges = normalizeExactTextChanges(suppliedChange.textChanges, baseContent.length);
    totalTextChanges += textChanges.length;
    if (totalTextChanges > 128) throw new Error("TypeScript code-action repair exceeds 128 exact text changes");
    const afterContent = applyExactTextChanges(baseContent, textChanges);
    if (afterContent === baseContent) throw new Error(`TypeScript code-action repair produced no exact byte-level change: ${changePath}`);
    const mediaType = current?.mediaType ?? suppliedChange.mediaType ?? typeScriptRepairMediaType(changePath);
    const role = current?.role ?? suppliedChange.role ?? "source";
    if (current && (suppliedChange.mediaType !== undefined && suppliedChange.mediaType !== current.mediaType
      || suppliedChange.role !== undefined && suppliedChange.role !== current.role)) {
      throw new Error(`TypeScript code-action replacement changed artifact classification: ${changePath}`);
    }
    if (!current && role !== "source") {
      throw new Error(`TypeScript code-action create target must be a source artifact: ${changePath}`);
    }
    normalized.push({
      path: changePath,
      isNewFile,
      baseArtifactId,
      baseContentHash,
      textChanges,
      afterContent,
      mediaType,
      role
    });
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

function normalizeProgramRepairPath(value: string): string {
  if (!value || value.includes("\u0000") || /^[/\\]/u.test(value) || /^[A-Za-z]:/u.test(value)) {
    throw new Error(`TypeScript code-action path is not workspace-relative: ${value}`);
  }
  const parts = value.replace(/\\/gu, "/").split("/");
  if (parts.some(part => !part || part === "." || part === "..")) {
    throw new Error(`TypeScript code-action path is not normalized: ${value}`);
  }
  return parts.join("/");
}

function typeScriptRepairMediaType(filePath: string): string {
  return /\.(?:[cm]?ts|tsx)$/iu.test(filePath) ? "text/typescript" : "text/javascript";
}

function normalizeExactTextChanges(changes: readonly ExactProgramTextChange[], sourceLength: number): ExactProgramTextChange[] {
  if (changes.length === 0 || changes.length > 128) {
    throw new Error("TypeScript code-action repair requires between 1 and 128 exact text changes");
  }
  const normalized = changes.map(change => {
    if (!Number.isSafeInteger(change.start) || change.start < 0
      || !Number.isSafeInteger(change.length) || change.length < 0
      || change.start + change.length > sourceLength
      || typeof change.newText !== "string") {
      throw new Error("TypeScript code-action text change is outside the exact source artifact");
    }
    return { start: change.start, length: change.length, newText: change.newText };
  }).sort((left, right) => left.start - right.start || left.length - right.length || left.newText.localeCompare(right.newText));
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1]!;
    const current = normalized[index]!;
    if (current.start < previous.start + previous.length || current.start === previous.start) {
      throw new Error("TypeScript code-action text changes overlap or have ambiguous ordering");
    }
  }
  return normalized;
}

function applyExactTextChanges(source: string, changes: readonly ExactProgramTextChange[]): string {
  let output = source;
  for (const change of [...changes].sort((left, right) => right.start - left.start)) {
    output = output.slice(0, change.start) + change.newText + output.slice(change.start + change.length);
  }
  return output;
}

export function verifyExactTypeScriptCodeActionTransformation(input: {
  before: string;
  after: string;
  textChanges: readonly ExactProgramTextChange[];
}): boolean {
  try {
    const normalized = normalizeExactTextChanges(input.textChanges, input.before.length);
    return applyExactTextChanges(input.before, normalized) === input.after;
  } catch {
    return false;
  }
}

function requiredRepairString(value: string | undefined, label: string): string {
  if (!value || value !== value.trim() || value.includes("\u0000")) throw new Error(`${label} is required`);
  return value;
}

function lineForOffset(source: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset; index += 1) if (source[index] === "\n") line += 1;
  return line;
}

function columnForOffset(source: string, offset: number): number {
  const previousNewline = source.lastIndexOf("\n", Math.max(0, offset - 1));
  return offset - previousNewline;
}

export function isUnusedTypeImportRemovalRequest(requestText: string, binding?: string): boolean {
  const family = /\b(?:remove|delete)\s+(?:the\s+)?unused\s+(?:(?:type\s+import)|(?:import\s+type))\b/iu.test(requestText);
  return family && (!binding || containsIdentifier(requestText, binding));
}

/**
 * Verifies the complete before/after transform independently of repair metadata.
 * Only a single-line, type-only import whose local binding has no other source
 * occurrence is admitted; all bytes outside that exact line must be identical.
 */
export function verifyExactUnusedTypeImportRemoval(input: {
  before: string;
  after: string;
  binding?: string;
  line?: number;
  declarationHash?: string;
  hasher?: Hasher;
}): VerifiedUnusedTypeImportRemoval | undefined {
  const hasher = input.hasher ?? createHasher();
  const matches = unusedTypeImportCandidates(input.before, hasher).filter(candidate =>
    (!input.binding || candidate.binding === input.binding)
    && (!input.line || candidate.line === input.line)
    && (!input.declarationHash || candidate.declarationHash === input.declarationHash)
    && deleteLinesExact(input.before, candidate.line, candidate.line) === input.after
  );
  if (matches.length !== 1) return undefined;
  const match = matches[0]!;
  return {
    familyId: UNUSED_TYPE_IMPORT_REPAIR_FAMILY,
    binding: match.binding,
    moduleSpecifier: match.moduleSpecifier,
    line: match.line,
    declarationHash: match.declarationHash,
    preconditionIds: [...UNUSED_TYPE_IMPORT_PRECONDITION_IDS],
    postconditionIds: [...UNUSED_TYPE_IMPORT_POSTCONDITION_IDS]
  };
}

function deriveUnusedTypeImportDiagnostic(program: ProgramGraph, requestText: string, hasher: Hasher): string | undefined {
  if (!isUnusedTypeImportRemovalRequest(requestText)) return undefined;
  const matches = program.files.flatMap(file => {
    if (!isTypeScriptSource(file)) return [];
    return unusedTypeImportCandidates(file.content, hasher)
      .filter(candidate => isUnusedTypeImportRemovalRequest(requestText, candidate.binding))
      .map(candidate => ({ file, candidate }));
  });
  if (matches.length !== 1) return undefined;
  const { file, candidate } = matches[0]!;
  return `${file.path}:${candidate.line}:1 type scce.diagnostic.typescript.unused_type_import binding=${candidate.binding}`;
}

function unusedTypeImportDiagnosticPattern(): DiagnosticPattern {
  return {
    id: UNUSED_TYPE_IMPORT_DIAGNOSTIC_PATTERN_ID,
    class: "type",
    pattern: /scce\.diagnostic\.typescript\.unused_type_import\s+binding=([A-Za-z_$][\w$]*)/u,
    confidence: 0.99,
    symbolGroup: 1
  };
}

function unusedTypeImportCandidates(content: string, hasher: Hasher): UnusedTypeImportCandidate[] {
  const candidates: UnusedTypeImportCandidate[] = [];
  for (const range of exactLineRanges(content)) {
    const declaration = content.slice(range.start, range.textEnd);
    const parsed = parseTypeOnlyImportDeclaration(declaration);
    if (!parsed) continue;
    const withoutDeclaration = content.slice(0, range.start) + content.slice(range.end);
    if (containsIdentifier(withoutDeclaration, parsed.binding)) continue;
    candidates.push({
      ...parsed,
      line: range.line,
      declaration,
      declarationHash: `sha256_${hasher.digestHex(declaration)}`
    });
  }
  return candidates;
}

function parseTypeOnlyImportDeclaration(declaration: string): { binding: string; moduleSpecifier: string } | undefined {
  const defaultImport = /^\s*import\s+type\s+([A-Za-z_$][\w$]*)\s+from\s+(["'])([^"']+)\2\s*;?\s*$/u.exec(declaration);
  if (defaultImport) return { binding: defaultImport[1]!, moduleSpecifier: defaultImport[3]! };
  const namespaceImport = /^\s*import\s+type\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s+(["'])([^"']+)\2\s*;?\s*$/u.exec(declaration);
  if (namespaceImport) return { binding: namespaceImport[1]!, moduleSpecifier: namespaceImport[3]! };
  const namedImport = /^\s*import\s+type\s+\{\s*([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*,?\s*\}\s+from\s+(["'])([^"']+)\3\s*;?\s*$/u.exec(declaration);
  if (namedImport) return { binding: namedImport[2] ?? namedImport[1]!, moduleSpecifier: namedImport[4]! };
  const inlineTypeImport = /^\s*import\s+\{\s*type\s+([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?\s*,?\s*\}\s+from\s+(["'])([^"']+)\3\s*;?\s*$/u.exec(declaration);
  if (inlineTypeImport) return { binding: inlineTypeImport[2] ?? inlineTypeImport[1]!, moduleSpecifier: inlineTypeImport[4]! };
  return undefined;
}

function assertRepairOperationPostconditions(before: FileArtifact | undefined, after: FileArtifact, operation: RepairOperation, hasher: Hasher): void {
  if (!operation.repairFamilyId) return;
  if (operation.repairFamilyId === TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY) {
    const isCreate = operation.kind === "create";
    if (isCreate === Boolean(before)) {
      throw new Error(`program repair postconditions failed for ${operation.path}: base state is incoherent`);
    }
    const baseContent = before?.content ?? "";
    const textChanges = normalizeExactTextChanges(operation.textChanges ?? [], baseContent.length);
    const textChangeHash = `sha256_${hasher.digestHex(canonicalStringify(textChanges))}`;
    const outputContentHash = `sha256_${hasher.digestHex(after.content)}`;
    const diagnostic = operation.diagnosticEvidence;
    const codeFix = operation.codeFixEvidence;
    const compiler = operation.compilerContext;
    if (!diagnostic || !codeFix || !compiler) {
      throw new Error(`program repair postconditions failed for ${operation.path}: compiler evidence is incomplete`);
    }
    const diagnosticPath = diagnostic.path ?? operation.path;
    const diagnosticIdentity = canonicalTypeScriptDiagnosticIdentity({
      path: diagnosticPath,
      diagnostic,
      compilerVersion: compiler.version,
      compilerOptionsHash: compiler.compilerOptionsHash
    }, hasher);
    const evidenceFileChanges = codeFix.fileChanges;
    const actionFileChange = evidenceFileChanges?.find(change => change.path === operation.path);
    if (evidenceFileChanges && (!actionFileChange
      || actionFileChange.isNewFile !== isCreate
      || actionFileChange.baseContentHash !== (before ? String(before.contentHash) : null)
      || canonicalStringify(actionFileChange.textChanges) !== canonicalStringify(textChanges))) {
      throw new Error(`program repair postconditions failed for ${operation.path}: atomic action file-change evidence is incoherent`);
    }
    const codeFixIdentity = canonicalTypeScriptCodeFixIdentity({
      diagnosticIdentity,
      codeFix: {
        fixName: codeFix.fixName,
        description: codeFix.description,
        ...(codeFix.fixId ? { fixId: codeFix.fixId } : {}),
        ...(evidenceFileChanges ? { fileChanges: evidenceFileChanges } : { textChanges })
      }
    }, hasher);
    const compilerCommandIdentity = canonicalTypeScriptCompilerCommandIdentity(compiler.compilerCommand, hasher);
    const carriesConfigPath = Boolean(compiler.tsconfigPath);
    const carriesConfigHash = Boolean(compiler.tsconfigContentHash);
    const expectedConfigHash = compiler.tsconfigContentHash;
    const commandSourceDirectory = compiler.compilerCommand.sourcePath.includes("/")
      ? compiler.compilerCommand.sourcePath.slice(0, compiler.compilerCommand.sourcePath.lastIndexOf("/"))
      : ".";
    const exactBaseContract = before
      ? hasOperationContract(operation.preconditions, "repair.precondition.exact_source_content_hash", String(before.contentHash))
        && String(before.contentHash) === `sha256_${hasher.digestHex(before.content)}`
      : operation.preconditions?.some(precondition => precondition.id === "repair.precondition.target_absent_in_compiler_snapshot"
        && precondition.value.endsWith(`:${operation.path}`)
        && /^sha256:[0-9a-f]{64}:/u.test(precondition.value)) === true;
    const createClassificationValid = before
      ? operation.createdArtifact === undefined
      : operation.createdArtifact?.mediaType === after.mediaType
        && operation.createdArtifact.role === after.role
        && operation.content === after.content;
    if ((!isCreate && operation.kind !== "replace")
      || diagnostic.diagnosticIdentity !== diagnosticIdentity
      || codeFix.codeFixIdentity !== codeFixIdentity
      || !carriesConfigPath
      || !carriesConfigHash
      || compiler.compilerOptionsSource !== "source_observed_tsc_project"
      || compiler.compilerCommand.cwd !== commandSourceDirectory
      || !/^sha256_[0-9a-f]{64}$/u.test(compiler.compilerCommand.sourceContentHash)
      || !exactBaseContract
      || !createClassificationValid
      || applyExactTextChanges(baseContent, textChanges) !== after.content
      || !hasOperationContract(operation.preconditions, "repair.precondition.typescript_diagnostic_identity", diagnosticIdentity)
      || !hasOperationContract(operation.preconditions, "repair.precondition.typescript_code_fix_identity", codeFixIdentity)
      || !hasOperationContract(operation.preconditions, "repair.precondition.compiler_options_hash", compiler.compilerOptionsHash)
      || !hasOperationContract(operation.preconditions, "repair.precondition.tsconfig_content_hash", expectedConfigHash)
      || !hasOperationContract(operation.preconditions, "repair.precondition.compiler_command_identity", compilerCommandIdentity)
      || !hasOperationContract(operation.preconditions, "repair.precondition.compiler_command_source_content_hash", compiler.compilerCommand.sourceContentHash)
      || !hasOperationContract(operation.postconditions, "repair.postcondition.exact_text_changes_applied", textChangeHash)
      || !hasOperationContract(operation.postconditions, "repair.postcondition.exact_output_content_hash", outputContentHash)
      || !hasOperationContract(operation.postconditions, "repair.postcondition.compiler_diagnostic_recheck_required", `TS${diagnostic.code}`)
      || !hasOperationContract(operation.postconditions, "repair.postcondition.typecheck_required", "typecheck")
      || !hasOperationContract(operation.postconditions, "repair.postcondition.tests_required", "tests")) {
      throw new Error(`program repair postconditions failed for ${operation.path}`);
    }
    return;
  }
  if (operation.repairFamilyId !== UNUSED_TYPE_IMPORT_REPAIR_FAMILY) {
    throw new Error(`program repair operation has an unsupported repair family: ${operation.repairFamilyId}`);
  }
  if (!before) throw new Error(`program repair preconditions are invalid for ${operation.path}`);
  const declarationHash = contractValue(operation.preconditions, UNUSED_TYPE_IMPORT_PRECONDITION_IDS[1]);
  const binding = contractValue(operation.preconditions, UNUSED_TYPE_IMPORT_PRECONDITION_IDS[2]);
  const sourceHash = contractValue(operation.preconditions, UNUSED_TYPE_IMPORT_PRECONDITION_IDS[0]);
  if (sourceHash !== String(before.contentHash)
    || sourceHash !== `sha256_${hasher.digestHex(before.content)}`
    || operation.kind !== "delete"
    || operation.startLine !== operation.endLine
    || !declarationHash
    || !binding) {
    throw new Error(`program repair preconditions are invalid for ${operation.path}`);
  }
  const verified = verifyExactUnusedTypeImportRemoval({
    before: before.content,
    after: after.content,
    binding,
    line: operation.startLine,
    declarationHash,
    hasher
  });
  if (!verified
    || !UNUSED_TYPE_IMPORT_PRECONDITION_IDS.every(id => contractValue(operation.preconditions, id) !== undefined)
    || !UNUSED_TYPE_IMPORT_POSTCONDITION_IDS.every(id => contractValue(operation.postconditions, id) !== undefined)) {
    throw new Error(`program repair postconditions failed for ${operation.path}`);
  }
}

function hasOperationContract(items: readonly { id: string; value: string }[] | undefined, id: string, value: string): boolean {
  const matches = items?.filter(item => item.id === id) ?? [];
  return matches.length === 1 && matches[0]?.value === value;
}

function contractValue(items: readonly { id: string; value: string }[] | undefined, id: string): string | undefined {
  return items?.find(item => item.id === id)?.value;
}

function isTypeScriptSource(file: FileArtifact): boolean {
  return file.role === "source"
    && (file.mediaType.includes("typescript") || /\.(?:ts|tsx|mts|cts)$/iu.test(file.path));
}

function containsIdentifier(text: string, identifier: string): boolean {
  let offset = text.indexOf(identifier);
  while (offset >= 0) {
    const before = offset > 0 ? text[offset - 1]! : "";
    const after = text[offset + identifier.length] ?? "";
    if (!isIdentifierPart(before) && !isIdentifierPart(after)) return true;
    offset = text.indexOf(identifier, offset + identifier.length);
  }
  return false;
}

function isIdentifierPart(value: string): boolean {
  return Boolean(value) && /[\p{Letter}\p{Number}_$]/u.test(value);
}

function exactLineRanges(content: string): ExactLineRange[] {
  if (!content) return [];
  const ranges: ExactLineRange[] = [];
  let start = 0;
  let line = 1;
  while (start < content.length) {
    const newline = content.indexOf("\n", start);
    const end = newline < 0 ? content.length : newline + 1;
    const textEnd = newline < 0 ? content.length : newline > start && content[newline - 1] === "\r" ? newline - 1 : newline;
    ranges.push({ line, start, textEnd, end });
    start = end;
    line += 1;
  }
  return ranges;
}

function deleteLinesExact(content: string, startLine: number, endLine: number): string {
  const ranges = exactLineRanges(content);
  const first = ranges[Math.max(0, startLine - 1)];
  const last = ranges[Math.max(0, endLine - 1)];
  if (!first || !last || last.line < first.line) return content;
  return content.slice(0, first.start) + content.slice(last.end);
}

function matchDiagnosticPattern(raw: string, patterns: readonly DiagnosticPattern[]): { class: DiagnosticClass; patternId: string; symbol?: string; confidence?: number } | undefined {
  for (const pattern of patterns) {
    pattern.pattern.lastIndex = 0;
    const match = pattern.pattern.exec(raw);
    if (!match) continue;
    const symbol = pattern.symbolGroup === undefined ? undefined : match[pattern.symbolGroup];
    return {
      class: pattern.class,
      patternId: pattern.id,
      symbol,
      confidence: pattern.confidence
    };
  }
  return undefined;
}

function parseLocation(raw: string, paths: readonly string[]): { path: string; line?: number; column?: number } | undefined {
  for (const path of paths) {
    const escaped = escapeRegex(path);
    const match = new RegExp(`${escaped}[:(](\\d+)?[:,]?(\\d+)?`).exec(raw);
    if (match) return { path, line: match[1] ? Number.parseInt(match[1], 10) : undefined, column: match[2] ? Number.parseInt(match[2], 10) : undefined };
  }
  const generic = /([\p{Letter}\p{Number}_./\\-]+\.(?:ts|tsx|js|jsx|py|rs|cs|json|toml|css|html))[:(](\d+)?[:,]?(\d+)?/u.exec(raw);
  if (generic) return { path: generic[1]!.replace(/\\/g, "/"), line: generic[2] ? Number.parseInt(generic[2], 10) : undefined, column: generic[3] ? Number.parseInt(generic[3], 10) : undefined };
  return undefined;
}

function diagnosticConfidence(klass: DiagnosticClass, loc: { path: string; line?: number; column?: number } | undefined, raw: string, patternConfidence?: number): number {
  const classBase: Record<DiagnosticClass, number> = { syntax: 0.82, type: 0.76, dependency: 0.74, runtime: 0.68, contract: 0.72, security: 0.8, unknown: 0.25 };
  const base = patternConfidence ?? classBase[klass];
  const locBoost = loc?.path ? 0.12 : 0;
  const lineBoost = loc?.line ? 0.06 : 0;
  const rawPenalty = raw.length > 1000 ? 0.08 : 0;
  return clamp01(base + locBoost + lineBoost - rawPenalty);
}

function dedupeDiagnostics(diagnostics: ProgramDiagnostic[]): ProgramDiagnostic[] {
  const map = new Map<string, ProgramDiagnostic>();
  for (const diag of diagnostics) {
    const key = `${diag.class}:${diag.path}:${diag.line}:${diag.symbol}:${diag.message}`;
    const existing = map.get(key);
    if (!existing || diag.confidence > existing.confidence) map.set(key, diag);
  }
  return [...map.values()];
}

function nearestFile(files: readonly FileArtifact[], diag: ProgramDiagnostic): string | undefined {
  if (diag.path) {
    const diagFeatures = featureSet(diag.path, 128);
    return files
      .map(file => ({ path: file.path, score: weightedJaccard(diagFeatures, featureSet(file.path, 128)) }))
      .sort((a, b) => b.score - a.score)[0]?.path;
  }
  return files[0]?.path;
}

function locateLikelyLine(content: string, diag: ProgramDiagnostic): number {
  if (diag.line) return diag.line;
  const symbol = diag.symbol;
  if (!symbol) return 1;
  const lines = content.split(/\r?\n/);
  const index = lines.findIndex(line => line.includes(symbol));
  return index >= 0 ? index + 1 : 1;
}

function lineText(content: string, line: number): string {
  return content.split(/\r?\n/)[Math.max(0, line - 1)] ?? "";
}

function lineCount(content: string): number {
  return content.split(/\r?\n/).length;
}

function replaceLines(content: string, startLine: number, endLine: number, replacement: string): string {
  const lines = content.split(/\r?\n/);
  const start = Math.max(0, startLine - 1);
  const end = Math.max(start, endLine - 1);
  lines.splice(start, end - start + 1, ...replacement.split(/\r?\n/));
  return `${lines.join("\n")}${content.endsWith("\n") ? "\n" : ""}`;
}

function insertAtLine(content: string, line: number, insertion: string): string {
  const lines = content.split(/\r?\n/);
  const index = Math.max(0, Math.min(lines.length, line - 1));
  lines.splice(index, 0, ...insertion.split(/\r?\n/));
  return `${lines.join("\n")}${content.endsWith("\n") ? "\n" : ""}`;
}

function delimiterRepair(line: string): string {
  const pairs: Array<[string, string]> = [["(", ")"], ["[", "]"], ["{", "}"]];
  let suffix = "";
  for (const [open, close] of pairs) {
    const diff = countChar(line, open) - countChar(line, close);
    if (diff > 0) suffix += close.repeat(Math.min(3, diff));
  }
  return suffix;
}

function closingForFile(file: FileArtifact): string {
  if (file.path.endsWith(".ts") || file.path.endsWith(".tsx") || file.path.endsWith(".js") || file.path.endsWith(".jsx")) return "}";
  if (file.path.endsWith(".rs") || file.path.endsWith(".cs")) return "}";
  if (file.path.endsWith(".py")) return "";
  return "";
}

function widenStructuralAccess(line: string): string {
  if (line.includes("?.")) return line;
  return line.replace(/([\p{Letter}\p{Number}_$\]\)])\.([\p{Letter}_$][\p{Letter}\p{Number}_$]*)/gu, "$1?.$2");
}

function addExplicitConversion(line: string): string {
  if (line.includes("String(") || line.includes("Number(")) return line;
  return line.replace(/=\s*([^;]+);?$/, "= String($1);");
}

function addNullishGuard(line: string): string {
  if (line.includes("??") || line.includes("?.")) return line;
  return line.replace(/([\p{Letter}_$][\p{Letter}\p{Number}_$]*)\.([\p{Letter}_$][\p{Letter}\p{Number}_$]*)/gu, "$1?.$2");
}

function contractGuardFor(file: FileArtifact): string {
  if (file.path.endsWith(".ts") || file.path.endsWith(".tsx")) return "if (!input || typeof input !== \"object\") throw new Error(\"contract.invalid_input\");";
  if (file.path.endsWith(".py")) return "if input is None:\n    raise ValueError('contract.invalid_input')";
  if (file.path.endsWith(".rs")) return "if input.is_empty() { return Err(\"contract.invalid_input\".into()); }";
  return "/* contract.invalid_input */";
}

function boundCheckFor(file: FileArtifact): string {
  if (file.path.endsWith(".ts") || file.path.endsWith(".tsx") || file.path.endsWith(".js")) return "if (input.length > 1_000_000) throw new Error(\"runtime.bound_exceeded\");";
  if (file.path.endsWith(".py")) return "if len(input) > 1_000_000:\n    raise ValueError('runtime.bound_exceeded')";
  if (file.path.endsWith(".rs")) return "if input.len() > 1_000_000 { return Err(\"runtime.bound_exceeded\".into()); }";
  return "/* runtime.bound_exceeded */";
}

function securityCommentFor(file: FileArtifact): string {
  if (file.path.endsWith(".py")) return "# security.invariant.encrypted_config_required";
  return "// security.invariant.encrypted_config_required";
}

function patchPackageJson(content: string, pkg: string): string {
  try {
    const parsed = JSON.parse(content) as Record<string, unknown>;
    const deps = parsed.dependencies && typeof parsed.dependencies === "object" && !Array.isArray(parsed.dependencies)
      ? parsed.dependencies as Record<string, unknown>
      : {};
    deps[pkg] = typeof deps[pkg] === "string" ? deps[pkg] : "*";
    parsed.dependencies = deps;
    return `${JSON.stringify(parsed, null, 2)}\n`;
  } catch {
    return `${content.trimEnd()}\n/* dependency required: ${pkg} */\n`;
  }
}

function safeIdentifier(value: string): string {
  const cleaned = value.replace(/[^\p{Letter}\p{Number}_$]/gu, "_").replace(/^([^\p{Letter}_$])/u, "_$1");
  return cleaned || "value";
}

function countChar(value: string, char: string): number {
  return [...value].filter(c => c === char).length;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
