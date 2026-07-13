import { canonicalStringify, createHasher } from "./primitives.js";
import {
  PATCH_TRANSACTION_SCOPE,
  createPatchTransactionPlan,
  hashPatchContent,
  type PatchContentHash,
  type PatchOperationInput,
  type PatchTransactionPlan
} from "./patch-transaction.js";
import type { FileArtifact, Hasher } from "./types.js";
import type { ProgramGraph } from "./types.js";
import { validateProgramGraphHydration } from "./program-runtime.js";
import {
  TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY,
  UNUSED_TYPE_IMPORT_REPAIR_FAMILY,
  canonicalTypeScriptCodeFixIdentity,
  canonicalTypeScriptCompilerCommandIdentity,
  canonicalTypeScriptDiagnosticIdentity,
  isUnusedTypeImportRemovalRequest,
  verifyExactTypeScriptCodeActionTransformation,
  verifyExactUnusedTypeImportRemoval,
  type ExactProgramTextChange
} from "./program-repair-kernel.js";

export const WORKSPACE_REVISION_SCHEMA = "yopp.workspace-revision.v1" as const;
export const WORKSPACE_PLAN_GENERATION_SCHEMA = "yopp.workspace-plan-generation.v1" as const;
export const WORKSPACE_PATCH_SCORE_SCHEMA = "yopp.workspace-patch-score.v1" as const;
export const WORKSPACE_PATCH_SCORE_OBJECTIVE = "quality.patch.provisional.v1" as const;
export const WORKSPACE_PROGRAM_PROPOSAL_TRACE_SCHEMA = "scce.workspace-program-proposal.trace.v1" as const;

export type WorkspaceTextEncoding = "utf-8";
export type WorkspaceLineEnding = "lf" | "crlf" | "none" | "mixed";
export type WorkspaceValidationCheckId = "compiler" | "typecheck" | "tests";

export interface WorkspaceRevisionFileInput {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly role: FileArtifact["role"];
}

export interface WorkspaceRevisionFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly byteLength: number;
  readonly contentHash: PatchContentHash;
  readonly mediaType: string;
  readonly role: FileArtifact["role"];
}

/**
 * A complete, content-addressed view of one committed workspace revision.
 * `complete: true` is what makes absence in `files` usable as create evidence.
 */
export interface WorkspaceRevisionSnapshot {
  readonly schemaVersion: typeof WORKSPACE_REVISION_SCHEMA;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly complete: true;
  readonly files: readonly WorkspaceRevisionFile[];
  readonly revisionHash: PatchContentHash;
}

export interface WorkspaceProposedFile {
  readonly artifact: FileArtifact;
  /** Null means create and therefore requires proof of absence in the complete snapshot. */
  readonly expectedBaseContentHash: PatchContentHash | null;
}

export interface WorkspaceDeletionProposal {
  readonly path: string;
  readonly expectedBaseContentHash: PatchContentHash;
}

export interface WorkspacePatchProposalAssessment {
  readonly assessmentId: string;
  readonly evidenceIds: readonly string[];
  readonly requestedBehaviorCoverage: number;
  readonly dependencyConsistency: number;
  readonly architecturalFit: number;
  readonly explanationAccuracy: number;
  readonly fabricatedBehavior: number;
}

export interface WorkspacePatchValidationPlan {
  readonly validatorId: string;
  readonly checks: readonly WorkspaceValidationCheckId[];
}

export interface WorkspacePatchQualityFeatures {
  readonly requestedBehaviorCoverage: number;
  readonly exactSourceFit: number;
  readonly dependencyConsistency: number;
  readonly regressionProtection: number;
  readonly architecturalFit: number;
  readonly locality: number;
  readonly validationPlanQuality: number;
  readonly rollbackSafety: number;
  readonly explanationAccuracy: number;
  readonly testWeakening: number;
  readonly staleSourceRisk: number;
  readonly fabricatedBehavior: number;
  readonly unrelatedChangeRate: number;
}

export interface WorkspacePatchScoreTrace {
  readonly schemaVersion: typeof WORKSPACE_PATCH_SCORE_SCHEMA;
  readonly objectiveId: typeof WORKSPACE_PATCH_SCORE_OBJECTIVE;
  readonly status: "provisional-uncalibrated";
  readonly features: WorkspacePatchQualityFeatures;
  readonly weightedTerms: Readonly<Record<keyof WorkspacePatchQualityFeatures, number>>;
  readonly score: number;
  readonly externalResultsOutrankScore: true;
  readonly decisionPrecedence: readonly ["execution-receipt", "test-results", "typecheck-results", "compiler-results", "q-patch-provisional"];
  readonly assessmentId: string;
  readonly evidenceIds: readonly string[];
}

export interface GenerateWorkspacePatchPlanInput {
  readonly snapshot: WorkspaceRevisionSnapshot;
  readonly expectedRevisionId: string;
  readonly expectedRevisionHash: PatchContentHash;
  readonly proposedFiles: readonly WorkspaceProposedFile[];
  readonly deletions?: readonly WorkspaceDeletionProposal[];
  /** Every non-test changed path must be explicitly in this source-grounded scope. */
  readonly requestedPaths: readonly string[];
  readonly assessment: WorkspacePatchProposalAssessment;
  readonly validationPlan: WorkspacePatchValidationPlan;
}

export interface WorkspacePatchSafetyTrace {
  readonly snapshotComplete: true;
  readonly verifiedRevisionId: string;
  readonly verifiedRevisionHash: PatchContentHash;
  readonly exactBaseHashPaths: readonly string[];
  readonly provenAbsentCreatePaths: readonly string[];
  readonly utf8ValidatedPaths: readonly string[];
  readonly preservedLineEndingPaths: readonly string[];
  readonly regressionTestPaths: readonly string[];
  readonly protectedExistingTestPaths: readonly string[];
  readonly unrelatedChangePaths: readonly string[];
}

export interface WorkspacePatchPlanGenerationResult {
  readonly schemaVersion: typeof WORKSPACE_PLAN_GENERATION_SCHEMA;
  readonly workspaceId: string;
  readonly revisionId: string;
  readonly revisionHash: PatchContentHash;
  readonly plan: PatchTransactionPlan;
  readonly scoreTrace: WorkspacePatchScoreTrace;
  readonly safety: WorkspacePatchSafetyTrace;
  readonly validationPlan: WorkspacePatchValidationPlan;
  readonly authorization: {
    readonly required: true;
    readonly granted: false;
    readonly capabilityId: "workspace.patch.apply";
  };
  readonly execution: {
    readonly state: "not_executed";
    readonly receipt: null;
  };
  readonly rollbackScope: typeof PATCH_TRANSACTION_SCOPE;
}

export interface WorkspaceCodingRequest {
  readonly requestId: string;
  readonly text: string;
  readonly requestedPaths: readonly string[];
  /** Evidence already attached to the program planner input; owner text is not evidence. */
  readonly evidenceIds: readonly string[];
}

export interface WorkspaceProgramProposalTrace {
  readonly schemaVersion: typeof WORKSPACE_PROGRAM_PROPOSAL_TRACE_SCHEMA;
  readonly source: "program-graph-full-file";
  readonly requestId: string;
  readonly requestHash: PatchContentHash;
  readonly programId: string;
  readonly sourcePlanIds: readonly string[];
  readonly evidenceIds: readonly string[];
  readonly requestedPaths: readonly string[];
  readonly derivedDependencyPaths: readonly string[];
  readonly selectedArtifactPaths: readonly string[];
  readonly regressionTestPaths: readonly string[];
  readonly verifiedParentDirectoryPaths: readonly string[];
  readonly hydrationValidated: true;
  readonly fullFileMaterialized: true;
}

export interface GenerateWorkspaceProgramPatchPlanInput {
  readonly snapshot: WorkspaceRevisionSnapshot;
  readonly expectedRevisionId: string;
  readonly expectedRevisionHash: PatchContentHash;
  readonly request: WorkspaceCodingRequest;
  readonly program: ProgramGraph;
  /** Existing regular directory paths verified by the filesystem adapter; root is "". */
  readonly existingDirectoryPaths: readonly string[];
  /** Create leaves observed absent by a live lstat after ProgramGraph emission. */
  readonly verifiedAbsentPaths: readonly string[];
  readonly validationPlan: WorkspacePatchValidationPlan;
}

export interface WorkspaceProgramPatchPlanGenerationResult extends WorkspacePatchPlanGenerationResult {
  readonly programProposalTrace: WorkspaceProgramProposalTrace;
}

export function createWorkspaceRevisionSnapshot(
  input: {
    readonly workspaceId: string;
    readonly revisionId: string;
    readonly files: readonly WorkspaceRevisionFileInput[];
  },
  hasher: Hasher = createHasher()
): WorkspaceRevisionSnapshot {
  const workspaceId = requiredId(input.workspaceId, "workspace id");
  const revisionId = requiredId(input.revisionId, "workspace revision id");
  const files = input.files.map(file => {
    const path = validateWorkspacePath(file.path);
    const bytes = new Uint8Array(file.bytes);
    const mediaType = requiredId(file.mediaType, `media type for ${path}`);
    return {
      path,
      bytes,
      byteLength: bytes.byteLength,
      contentHash: hashPatchContent(bytes, hasher),
      mediaType,
      role: file.role
    } satisfies WorkspaceRevisionFile;
  }).sort((left, right) => compareCanonical(left.path, right.path));
  rejectDuplicatePaths(files.map(file => file.path), "workspace revision");
  const payload = revisionManifest({ workspaceId, revisionId, files });
  const snapshot: WorkspaceRevisionSnapshot = {
    schemaVersion: WORKSPACE_REVISION_SCHEMA,
    workspaceId,
    revisionId,
    complete: true,
    files,
    revisionHash: hashCanonical(payload, hasher)
  };
  return freezeSnapshot(snapshot);
}

/**
 * Produces a reviewable exact-byte transaction. It does not authorize, validate,
 * execute, or claim success for that transaction.
 */
export function generateWorkspacePatchPlan(
  input: GenerateWorkspacePatchPlanInput,
  hasher: Hasher = createHasher()
): WorkspacePatchPlanGenerationResult {
  return generateWorkspacePatchPlanInternal(input, hasher, new Set(), new Set());
}

function generateWorkspacePatchPlanInternal(
  input: GenerateWorkspacePatchPlanInput,
  hasher: Hasher,
  verifiedNonBehavioralPaths: ReadonlySet<string>,
  verifiedDiagnosticRepairPaths: ReadonlySet<string>
): WorkspacePatchPlanGenerationResult {
  const snapshot = verifyWorkspaceRevisionSnapshot(input.snapshot, hasher);
  if (input.expectedRevisionId !== snapshot.revisionId || input.expectedRevisionHash !== snapshot.revisionHash) {
    throw new Error(`stale workspace revision: expected ${input.expectedRevisionId}/${input.expectedRevisionHash}, received ${snapshot.revisionId}/${snapshot.revisionHash}`);
  }
  const requestedPaths = new Set(input.requestedPaths.map(validateWorkspacePath));
  if (requestedPaths.size === 0) throw new Error("workspace patch generation requires at least one requested path");
  validateAssessment(input.assessment);
  const validationPlan = normalizeValidationPlan(input.validationPlan);

  const currentByPath = new Map(snapshot.files.map(file => [file.path, file]));
  const proposalPaths = input.proposedFiles.map(item => validateWorkspacePath(item.artifact.path));
  const deletionPaths = (input.deletions ?? []).map(item => validateWorkspacePath(item.path));
  rejectDuplicatePaths([...proposalPaths, ...deletionPaths], "workspace proposal");

  const operations: PatchOperationInput[] = [];
  const exactBaseHashPaths: string[] = [];
  const provenAbsentCreatePaths: string[] = [];
  const utf8ValidatedPaths: string[] = [];
  const preservedLineEndingPaths: string[] = [];
  const regressionTestPaths: string[] = [];
  const regressionTests: Array<{ path: string; content: string }> = [];
  const protectedExistingTestPaths = snapshot.files.filter(file => isProtectedTestFile(file.path, file.role)).map(file => file.path);
  const unrelatedChangePaths: string[] = [];
  const behaviorChangePaths: string[] = [];

  for (const proposal of input.proposedFiles) {
    const artifact = proposal.artifact;
    const path = validateWorkspacePath(artifact.path);
    assertArtifactContentHash(artifact, hasher);
    const current = currentByPath.get(path);
    const assertionPath = isAssertionPath(path);
    if (assertionPath && artifact.role !== "test") throw new Error(`assertion path must be emitted with test role: ${path}`);
    if (artifact.role === "test" && !assertionPath) throw new Error(`regression test artifact must use an assertion path: ${path}`);
    const proposedIsTest = assertionPath && artifact.role === "test";

    if (proposal.expectedBaseContentHash === null) {
      if (current) throw new Error(`creation target is not absent in workspace revision: ${path}`);
      const content = validateProposedText(path, artifact.content, artifact.mediaType);
      if (lineEndingOf(content) === "mixed") throw new Error(`mixed line endings are not supported for created file: ${path}`);
      operations.push({ kind: "create", path, content });
      provenAbsentCreatePaths.push(path);
      utf8ValidatedPaths.push(path);
      if (proposedIsTest) {
        assertActiveRegressionTest(path, content);
        regressionTestPaths.push(path);
        regressionTests.push({ path, content });
      }
      else if (artifact.role === "source" && !verifiedNonBehavioralPaths.has(path)) behaviorChangePaths.push(path);
      if (!requestedPaths.has(path) && !proposedIsTest) unrelatedChangePaths.push(path);
      continue;
    }

    if (!current) throw new Error(`replacement base is absent from workspace revision: ${path}`);
    assertExpectedBase(path, proposal.expectedBaseContentHash, current);
    if (isProtectedTestFile(current.path, current.role) || proposedIsTest) {
      throw new Error(`test weakening rejected: existing assertion file is immutable: ${path}`);
    }
    if (isTestControlPath(path)) throw new Error(`test weakening rejected: existing test-control file is immutable: ${path}`);
    const currentText = decodeExactUtf8(current.bytes, path, current.mediaType);
    const proposedText = validateProposedText(path, artifact.content, artifact.mediaType);
    const content = assertExactReplacementLineEndings(path, currentText, proposedText);
    assertPackageTestScriptsPreserved(path, currentText, content);
    if (content === currentText) continue;
    operations.push({ kind: "replace", path, baseContentHash: current.contentHash, content });
    exactBaseHashPaths.push(path);
    utf8ValidatedPaths.push(path);
    if (lineEndingOf(currentText) !== "none") preservedLineEndingPaths.push(path);
    if ((artifact.role === "source" || current.role === "source") && !verifiedNonBehavioralPaths.has(path)) behaviorChangePaths.push(path);
    if (!requestedPaths.has(path)) unrelatedChangePaths.push(path);
  }

  for (const deletion of input.deletions ?? []) {
    const path = validateWorkspacePath(deletion.path);
    const current = currentByPath.get(path);
    if (!current) throw new Error(`deletion base is absent from workspace revision: ${path}`);
    assertExpectedBase(path, deletion.expectedBaseContentHash, current);
    if (isProtectedTestFile(current.path, current.role) || isTestControlPath(path)) {
      throw new Error(`test weakening rejected: assertion or test-control file cannot be deleted: ${path}`);
    }
    decodeExactUtf8(current.bytes, path, current.mediaType);
    operations.push({ kind: "delete", path, baseContentHash: current.contentHash });
    exactBaseHashPaths.push(path);
    utf8ValidatedPaths.push(path);
    if (current.role === "source") behaviorChangePaths.push(path);
    if (!requestedPaths.has(path)) unrelatedChangePaths.push(path);
  }

  if (operations.length === 0) throw new Error("workspace patch proposal contains no material change");
  if (unrelatedChangePaths.length > 0) {
    throw new Error(`unrelated workspace changes rejected: ${uniqueSorted(unrelatedChangePaths).join(", ")}`);
  }
  if (behaviorChangePaths.length > 0 && regressionTestPaths.length === 0) {
    throw new Error(`behavior change requires a newly created regression test: ${uniqueSorted(behaviorChangePaths).join(", ")}`);
  }
  if (behaviorChangePaths.length > 0) {
    assertRegressionTestsExerciseBehavior(regressionTests, uniqueSorted(behaviorChangePaths));
  }
  if (behaviorChangePaths.length > 0 && !validationPlan.checks.includes("tests")) {
    throw new Error("behavior change validation plan must include tests");
  }
  const diagnosticRepairChanges = operations
    .map(operation => operation.path)
    .filter(path => verifiedDiagnosticRepairPaths.has(path));
  const typeOnlySourceChanges = operations
    .map(operation => operation.path)
    .filter(path => verifiedNonBehavioralPaths.has(path) && !verifiedDiagnosticRepairPaths.has(path));
  if (typeOnlySourceChanges.length > 0 && !validationPlan.checks.includes("typecheck")) {
    throw new Error(`type-only source repair validation plan must include typecheck: ${uniqueSorted(typeOnlySourceChanges).join(", ")}`);
  }
  if (diagnosticRepairChanges.length > 0
    && !(["compiler", "typecheck", "tests"] as const).every(check => validationPlan.checks.includes(check))) {
    throw new Error(`compiler diagnostic repair validation plan must include compiler, typecheck, and tests: ${uniqueSorted(diagnosticRepairChanges).join(", ")}`);
  }

  const plan = createPatchTransactionPlan({ operations }, hasher);
  const expectedValidationChecks = expectedChecksFor(
    operations,
    input.proposedFiles,
    verifiedNonBehavioralPaths,
    verifiedDiagnosticRepairPaths
  );
  const validationPlanQuality = fractionCovered(expectedValidationChecks, validationPlan.checks);
  const features: WorkspacePatchQualityFeatures = {
    requestedBehaviorCoverage: input.assessment.requestedBehaviorCoverage,
    exactSourceFit: 1,
    dependencyConsistency: input.assessment.dependencyConsistency,
    // A proposed test is inspectable evidence, not an executed regression result.
    regressionProtection: 0,
    architecturalFit: input.assessment.architecturalFit,
    locality: 1,
    validationPlanQuality,
    rollbackSafety: 1,
    explanationAccuracy: input.assessment.explanationAccuracy,
    testWeakening: 0,
    staleSourceRisk: 0,
    fabricatedBehavior: input.assessment.fabricatedBehavior,
    unrelatedChangeRate: 0
  };
  const scoreTrace = scoreWorkspacePatchProposal(features, {
    assessmentId: input.assessment.assessmentId,
    evidenceIds: input.assessment.evidenceIds
  });

  return deepFreeze({
    schemaVersion: WORKSPACE_PLAN_GENERATION_SCHEMA,
    workspaceId: snapshot.workspaceId,
    revisionId: snapshot.revisionId,
    revisionHash: snapshot.revisionHash,
    plan,
    scoreTrace,
    safety: {
      snapshotComplete: true,
      verifiedRevisionId: snapshot.revisionId,
      verifiedRevisionHash: snapshot.revisionHash,
      exactBaseHashPaths: uniqueSorted(exactBaseHashPaths),
      provenAbsentCreatePaths: uniqueSorted(provenAbsentCreatePaths),
      utf8ValidatedPaths: uniqueSorted(utf8ValidatedPaths),
      preservedLineEndingPaths: uniqueSorted(preservedLineEndingPaths),
      regressionTestPaths: uniqueSorted(regressionTestPaths),
      protectedExistingTestPaths: uniqueSorted(protectedExistingTestPaths),
      unrelatedChangePaths: []
    },
    validationPlan,
    authorization: { required: true, granted: false, capabilityId: "workspace.patch.apply" },
    execution: { state: "not_executed", receipt: null },
    rollbackScope: PATCH_TRANSACTION_SCOPE
  } satisfies WorkspacePatchPlanGenerationResult);
}

/**
 * Structurally converts a caller-trusted, hydrated ProgramGraph into the strict
 * full-file proposal consumed by the one exact-byte planner. It never interprets
 * request prose as file content: every proposed byte must already exist in a
 * ProgramGraph artifact with exact-base repair lineage.
 *
 * This pure kernel boundary does not authenticate the caller's lineage or evidence,
 * prove semantic correctness, or prove that the linked candidate test executed.
 */
export function generateWorkspacePatchPlanFromProgramGraph(
  input: GenerateWorkspaceProgramPatchPlanInput,
  hasher: Hasher = createHasher()
): WorkspaceProgramPatchPlanGenerationResult {
  const snapshot = verifyWorkspaceRevisionSnapshot(input.snapshot, hasher);
  const requestId = requiredId(input.request.requestId, "coding request id");
  const requestText = input.request.text?.trim();
  if (!requestText) throw new Error("coding request text is required");
  const requestedPaths = uniqueSorted(input.request.requestedPaths.map(validateWorkspacePath));
  if (requestedPaths.length === 0) throw new Error("coding request requires at least one requested path");
  const requestEvidenceIds = uniqueSorted(input.request.evidenceIds.map(value => requiredId(value, "coding request evidence id")));
  if (requestEvidenceIds.length === 0) throw new Error("coding request requires source-bound program evidence");
  const existingDirectoryPaths = new Set(input.existingDirectoryPaths.map(value => value === "" ? "" : validateWorkspacePath(value)));
  if (!existingDirectoryPaths.has("")) throw new Error("workspace program proposal requires a verified workspace root directory");
  const verifiedAbsentPaths = new Set(input.verifiedAbsentPaths.map(validateWorkspacePath));

  const hydration = input.program.hydration;
  if (!hydration) throw new Error("workspace program proposal requires a hydration contract");
  const hydrationCheck = validateProgramGraphHydration(input.program);
  if (!hydrationCheck.valid) {
    throw new Error(`workspace program proposal hydration is invalid: ${hydrationCheck.diagnostics.join(", ") || "unknown"}`);
  }
  if (hydration.program.programId !== input.program.id) throw new Error("workspace program proposal hydration belongs to a different program");

  const programEvidenceIds = uniqueSorted(hydration.program.provenanceEvidenceIds.map(value => requiredId(value, "program provenance evidence id")));
  const programEvidence = new Set(programEvidenceIds);
  const unboundEvidence = requestEvidenceIds.filter(id => !programEvidence.has(id));
  if (unboundEvidence.length > 0) {
    throw new Error(`coding request evidence is not bound to the program graph: ${unboundEvidence.join(", ")}`);
  }

  const hydrationFiles = new Map(hydration.files.map(file => [file.path, file]));
  const emissions = new Map(hydration.emissions.map(emission => [emission.filePath, emission]));
  rejectDuplicatePaths(input.program.files.map(file => validateWorkspacePath(file.path)), "program graph artifacts");
  if (hydration.files.length !== input.program.files.length || hydration.emissions.length !== input.program.files.length) {
    throw new Error("workspace program proposal hydration file set does not match the ProgramGraph");
  }
  for (const artifact of input.program.files) {
    assertArtifactContentHash(artifact, hasher);
    const hydrated = hydrationFiles.get(artifact.path);
    const emission = emissions.get(artifact.path);
    if (!hydrated || String(hydrated.contentHash) !== String(artifact.contentHash)) {
      throw new Error(`program hydration file identity is stale: ${artifact.path}`);
    }
    if (!emission || String(emission.contentHash) !== String(artifact.contentHash)) {
      throw new Error(`program emission identity is stale: ${artifact.path}`);
    }
  }

  const requested = new Set(requestedPaths);
  const snapshotPaths = new Set(snapshot.files.map(file => file.path));
  const programByPath = new Map(input.program.files.map(artifact => [artifact.path, artifact]));
  const dependencyPaths = programArtifactDependencyClosure(requestedPaths, programByPath, hydrationFiles);
  const repairActionPaths = programRepairActionClosure(input.program, requestedPaths);
  const selectedArtifacts = input.program.files.filter(artifact =>
    dependencyPaths.has(artifact.path) || repairActionPaths.has(artifact.path) || isLinkedProgramRegressionTest({
      artifact,
      snapshotPaths,
      dependencyPaths,
      artifacts: programByPath,
      hydrationFiles
    })
  );
  const selectedPaths = new Set(selectedArtifacts.map(artifact => artifact.path));
  const missingPaths = requestedPaths.filter(path => !selectedPaths.has(path));
  if (missingPaths.length > 0) {
    const available = uniqueSorted(input.program.files.map(artifact => artifact.path)).slice(0, 32);
    throw new Error(`program graph did not materialize requested full-file artifacts: ${missingPaths.join(", ")}; available: ${available.join(", ")}`);
  }
  if (selectedArtifacts.length === 0) throw new Error("program graph produced no applicable full-file artifacts");

  const snapshotByPath = new Map(snapshot.files.map(file => [file.path, file]));
  const missingParentPaths = selectedArtifacts
    .filter(artifact => !snapshotByPath.has(artifact.path))
    .map(artifact => parentWorkspacePath(artifact.path))
    .filter(parent => !existingDirectoryPaths.has(parent));
  if (missingParentPaths.length > 0) {
    throw new Error(`program graph create parent directory is not present: ${uniqueSorted(missingParentPaths).join(", ")}`);
  }
  const unverifiedAbsentPaths = selectedArtifacts
    .filter(artifact => !snapshotByPath.has(artifact.path) && !verifiedAbsentPaths.has(artifact.path))
    .map(artifact => artifact.path);
  if (unverifiedAbsentPaths.length > 0) {
    throw new Error(`program graph create target lacks live absence proof: ${uniqueSorted(unverifiedAbsentPaths).join(", ")}`);
  }
  const unchangedRequestedPaths = requestedPaths.filter(path => {
    const artifact = programByPath.get(path);
    const current = snapshotByPath.get(path);
    if (!artifact || !current) return false;
    const currentText = decodeExactUtf8(current.bytes, path, current.mediaType);
    const proposedText = validateProposedText(path, artifact.content, artifact.mediaType);
    return proposedText === currentText && !isCompilerRepairDiagnosticRequest(input.program, path, repairActionPaths);
  });
  if (unchangedRequestedPaths.length > 0) {
    throw new Error(`program graph did not materially change requested full-file artifacts: ${unchangedRequestedPaths.join(", ")}`);
  }
  assertRepairLineageForSelectedArtifacts(input.program, selectedArtifacts, snapshotByPath, hasher);
  const verifiedRepairPaths = verifiedNonBehavioralProgramRepairPaths(
    input.program,
    selectedArtifacts,
    snapshotByPath,
    requestText,
    hasher
  );
  const verifiedNonBehavioralPaths = new Set([
    ...verifiedRepairPaths.typeOnly,
    ...verifiedRepairPaths.compilerDiagnostic
  ]);
  const proposedFiles: WorkspaceProposedFile[] = selectedArtifacts.map(artifact => ({
    artifact,
    expectedBaseContentHash: snapshotByPath.get(artifact.path)?.contentHash ?? null
  }));
  const coverage = requestedPaths.filter(path => selectedPaths.has(path)).length / requestedPaths.length;
  const evidenceCoverage = requestEvidenceIds.filter(id => programEvidence.has(id)).length / requestEvidenceIds.length;
  const blueprintMetrics = programBlueprintMetrics(input.program);
  const planningScopePaths = uniqueSorted(selectedArtifacts.filter(artifact => artifact.role !== "test").map(artifact => artifact.path));
  const assessmentId = `workspace-program-assessment:${hasher.digestHex(canonicalStringify({
    requestId,
    programId: input.program.id,
    requestedPaths,
    planningScopePaths,
    artifacts: selectedArtifacts.map(artifact => [artifact.path, artifact.contentHash]),
    evidenceIds: requestEvidenceIds
  })).slice(0, 32)}`;
  const planResult = generateWorkspacePatchPlanInternal({
    snapshot,
    expectedRevisionId: input.expectedRevisionId,
    expectedRevisionHash: input.expectedRevisionHash,
    proposedFiles,
    requestedPaths: planningScopePaths,
    assessment: {
      assessmentId,
      evidenceIds: requestEvidenceIds,
      requestedBehaviorCoverage: coverage * (1 - blueprintMetrics.unbackedSynthesisRisk),
      dependencyConsistency: hydration.dependencies.some(dependency => dependency.missing) ? 0 : 1,
      architecturalFit: blueprintMetrics.sourceCoupling * (1 - blueprintMetrics.unbackedSynthesisRisk),
      explanationAccuracy: evidenceCoverage * (1 - blueprintMetrics.unbackedSynthesisRisk),
      fabricatedBehavior: blueprintMetrics.unbackedSynthesisRisk
    },
    validationPlan: input.validationPlan
  }, hasher, verifiedNonBehavioralPaths, verifiedRepairPaths.compilerDiagnostic);
  const sourcePlanIds = uniqueSorted(hydration.emissions.map(emission => requiredId(emission.sourcePlanId, "program source plan id")));
  const regressionTestPaths = uniqueSorted(selectedArtifacts.filter(artifact => artifact.role === "test" && isAssertionPath(artifact.path)).map(artifact => artifact.path));
  return deepFreeze({
    ...planResult,
    programProposalTrace: {
      schemaVersion: WORKSPACE_PROGRAM_PROPOSAL_TRACE_SCHEMA,
      source: "program-graph-full-file",
      requestId,
      requestHash: hashCanonical({
        requestId,
        text: requestText,
        requestedPaths,
        evidenceIds: requestEvidenceIds,
        revisionId: snapshot.revisionId,
        revisionHash: snapshot.revisionHash
      }, hasher),
      programId: input.program.id,
      sourcePlanIds,
      evidenceIds: requestEvidenceIds,
      requestedPaths,
      derivedDependencyPaths: uniqueSorted([...dependencyPaths].filter(path => !requested.has(path))),
      selectedArtifactPaths: uniqueSorted(selectedArtifacts.map(artifact => artifact.path)),
      regressionTestPaths,
      verifiedParentDirectoryPaths: uniqueSorted(selectedArtifacts.filter(artifact => !snapshotByPath.has(artifact.path)).map(artifact => parentWorkspacePath(artifact.path))),
      hydrationValidated: true,
      fullFileMaterialized: true
    }
  } satisfies WorkspaceProgramPatchPlanGenerationResult);
}

function parentWorkspacePath(workspacePath: string): string {
  const index = workspacePath.lastIndexOf("/");
  return index < 0 ? "" : workspacePath.slice(0, index);
}

function programArtifactDependencyClosure(
  roots: readonly string[],
  artifacts: ReadonlyMap<string, FileArtifact>,
  hydrationFiles: ReadonlyMap<string, { readonly path: string; readonly imports: readonly string[] }>
): Set<string> {
  const selected = new Set<string>(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    const sourcePath = queue.shift()!;
    const hydrated = hydrationFiles.get(sourcePath);
    if (!hydrated) continue;
    for (const specifier of hydrated.imports) {
      const target = resolveProgramImportArtifact(sourcePath, specifier, artifacts);
      if (!target || selected.has(target)) continue;
      selected.add(target);
      queue.push(target);
    }
  }
  return selected;
}

function isLinkedProgramRegressionTest(input: {
  artifact: FileArtifact;
  snapshotPaths: ReadonlySet<string>;
  dependencyPaths: ReadonlySet<string>;
  artifacts: ReadonlyMap<string, FileArtifact>;
  hydrationFiles: ReadonlyMap<string, { readonly path: string; readonly imports: readonly string[] }>;
}): boolean {
  const { artifact } = input;
  if (artifact.role !== "test" || !isAssertionPath(artifact.path) || input.snapshotPaths.has(artifact.path)) return false;
  if (!isActiveRegressionTestContent(artifact.content)) return false;
  const hydrated = input.hydrationFiles.get(artifact.path);
  const linkedPaths = new Set<string>();
  for (const specifier of hydrated?.imports ?? []) {
    const target = resolveProgramImportArtifact(artifact.path, specifier, input.artifacts);
    if (target !== undefined && input.dependencyPaths.has(target)) linkedPaths.add(target);
  }
  return linkedPaths.size > 0 && regressionTestExercisesBehavior(artifact.path, artifact.content, linkedPaths);
}

function programBlueprintMetrics(program: ProgramGraph): { sourceCoupling: number; unbackedSynthesisRisk: number } {
  const metadata = program.nodes.find(node => node.kind === "implementation_blueprint")?.metadata;
  if (!isRecord(metadata)) return { sourceCoupling: 0, unbackedSynthesisRisk: 1 };
  const sourceCoupling = typeof metadata.sourceCoupling === "number" && Number.isFinite(metadata.sourceCoupling)
    ? Math.max(0, Math.min(1, metadata.sourceCoupling))
    : 0;
  const unbackedSynthesisRisk = typeof metadata.unbackedSynthesisRisk === "number" && Number.isFinite(metadata.unbackedSynthesisRisk)
    ? Math.max(0, Math.min(1, metadata.unbackedSynthesisRisk))
    : 1;
  return { sourceCoupling, unbackedSynthesisRisk };
}

function assertRepairLineageForSelectedArtifacts(
  program: ProgramGraph,
  artifacts: readonly FileArtifact[],
  snapshotByPath: ReadonlyMap<string, WorkspaceRevisionFile>,
  hasher: Hasher
): void {
  const transformations = programRepairTransformations(program);
  for (const artifact of artifacts) {
    if (artifact.role === "test") continue;
    const current = snapshotByPath.get(artifact.path);
    const baseText = current ? decodeExactUtf8(current.bytes, artifact.path, current.mediaType) : undefined;
    if (baseText === artifact.content) continue;
    const baseArtifactHash = baseText === undefined ? null : `sha256_${hasher.digestHex(baseText)}`;
    const lineage = transformations.find(record => record.path === artifact.path
      && record.baseContentHash === baseArtifactHash
      && record.outputArtifactId === artifact.artifactId
      && record.outputContentHash === artifact.contentHash);
    if (!lineage) {
      throw new Error(`program graph replacement lacks verified repair lineage from exact base bytes: ${artifact.path}`);
    }
    if (!Array.isArray(lineage.operationIds)
      || lineage.operationIds.length === 0
      || lineage.operationIds.some(id => typeof id !== "string" || !id.trim())) {
      throw new Error(`program graph repair lineage has no canonical operations: ${artifact.path}`);
    }
    if (current) {
      const evidence = Array.isArray(lineage.evidence) ? lineage.evidence.filter(isRecord) : [];
      if (!evidence.some(record => record.path === artifact.path && record.contentHash === baseArtifactHash)) {
        throw new Error(`program graph repair lineage is not bound to source evidence: ${artifact.path}`);
      }
    } else {
      const creation = lineage.creation;
      if (!isRecord(creation)
        || creation.baseState !== "absent"
        || typeof creation.absencePrecondition !== "string"
        || !creation.absencePrecondition.endsWith(`:${artifact.path}`)
        || !/^sha256:[0-9a-f]{64}:/u.test(creation.absencePrecondition)) {
        throw new Error(`program graph source create lacks compiler-snapshot absence lineage: ${artifact.path}`);
      }
    }
  }
}

function verifiedNonBehavioralProgramRepairPaths(
  program: ProgramGraph,
  artifacts: readonly FileArtifact[],
  snapshotByPath: ReadonlyMap<string, WorkspaceRevisionFile>,
  requestText: string,
  hasher: Hasher
): { typeOnly: ReadonlySet<string>; compilerDiagnostic: ReadonlySet<string> } {
  const transformations = programRepairTransformations(program);
  const typeOnly = new Set<string>();
  const compilerDiagnostic = new Set<string>();
  for (const artifact of artifacts) {
    const current = snapshotByPath.get(artifact.path);
    const before = current ? decodeExactUtf8(current.bytes, artifact.path, current.mediaType) : "";
    const sourceArtifactHash = current ? `sha256_${hasher.digestHex(before)}` : null;
    const transformation = transformations.find(record => record.path === artifact.path
      && record.baseContentHash === sourceArtifactHash
      && record.outputArtifactId === artifact.artifactId
      && record.outputContentHash === artifact.contentHash);
    if (!transformation || !Array.isArray(transformation.operations) || transformation.operations.length !== 1) continue;
    const repairOperation = transformation.operations[0];
    if (!isRecord(repairOperation)) continue;
    const preconditions = contractRecords(repairOperation.preconditions);
    const postconditions = contractRecords(repairOperation.postconditions);
    if (repairOperation.repairFamilyId === UNUSED_TYPE_IMPORT_REPAIR_FAMILY) {
      if (artifact.role !== "source" || !current || sourceArtifactHash === null) continue;
      const verified = verifyExactUnusedTypeImportRemoval({ before, after: artifact.content, hasher });
      if (!verified
        || !isUnusedTypeImportRemovalRequest(requestText, verified.binding)
        || repairOperation.kind !== "delete"
        || repairOperation.startLine !== verified.line
        || repairOperation.endLine !== verified.line
        || !hasContract(preconditions, "repair.precondition.exact_source_content_hash", sourceArtifactHash)
        || !hasContract(preconditions, "repair.precondition.exact_type_import_declaration_hash", verified.declarationHash)
        || !hasContract(preconditions, "repair.precondition.local_binding_unreferenced", verified.binding)
        || !hasContract(postconditions, "repair.postcondition.type_import_declaration_absent", verified.declarationHash)
        || !hasContract(postconditions, "repair.postcondition.all_unrelated_bytes_preserved", "exact_single_line_deletion")
        || !hasContract(postconditions, "repair.postcondition.typecheck_required", "typecheck")) continue;
      typeOnly.add(artifact.path);
      continue;
    }
    if (repairOperation.repairFamilyId === TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY) {
      assertVerifiedTypeScriptCodeActionLineage({
        program,
        artifact,
        before,
        sourceArtifactHash,
        snapshotByPath,
        repairOperation,
        preconditions,
        postconditions,
        hasher
      });
      compilerDiagnostic.add(artifact.path);
    }
  }
  return { typeOnly, compilerDiagnostic };
}

function programRepairTransformations(program: ProgramGraph): Record<string, unknown>[] {
  const transformations: Record<string, unknown>[] = [];
  for (const node of program.nodes) {
    if (node.kind !== "program_repair_full_file_materialization"
      || !isRecord(node.metadata)
      || node.metadata.schema !== "scce.program_repair.full_file_lineage.v1"
      || !Array.isArray(node.metadata.transformations)) continue;
    for (const transformation of node.metadata.transformations) {
      if (isRecord(transformation)) transformations.push(transformation);
    }
  }
  return transformations;
}

function programRepairActionClosure(program: ProgramGraph, requestedPaths: readonly string[]): Set<string> {
  const requested = new Set(requestedPaths);
  const transformations = programRepairTransformations(program);
  const selectedActionIds = new Set<string>();
  for (const transformation of transformations) {
    const operations = Array.isArray(transformation.operations) ? transformation.operations.filter(isRecord) : [];
    for (const operation of operations) {
      if (operation.repairFamilyId !== TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY) continue;
      const diagnostic = operation.diagnosticEvidence;
      const codeFix = operation.codeFixEvidence;
      const diagnosticPath = isRecord(diagnostic) && typeof diagnostic.path === "string" ? diagnostic.path : transformation.path;
      if (requested.has(String(diagnosticPath)) || requested.has(String(transformation.path))) {
        if (isRecord(codeFix) && typeof codeFix.codeFixIdentity === "string") selectedActionIds.add(codeFix.codeFixIdentity);
      }
    }
  }
  const paths = new Set<string>();
  for (const transformation of transformations) {
    const operations = Array.isArray(transformation.operations) ? transformation.operations.filter(isRecord) : [];
    if (operations.some(operation => {
      const codeFix = operation.codeFixEvidence;
      return operation.repairFamilyId === TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY
        && isRecord(codeFix)
        && typeof codeFix.codeFixIdentity === "string"
        && selectedActionIds.has(codeFix.codeFixIdentity);
    }) && typeof transformation.path === "string") paths.add(transformation.path);
  }
  return paths;
}

function isCompilerRepairDiagnosticRequest(program: ProgramGraph, requestPath: string, actionPaths: ReadonlySet<string>): boolean {
  if (actionPaths.size === 0) return false;
  return programRepairTransformations(program).some(transformation => {
    if (typeof transformation.path !== "string" || !actionPaths.has(transformation.path)) return false;
    const operations = Array.isArray(transformation.operations) ? transformation.operations.filter(isRecord) : [];
    return operations.some(operation => {
      if (operation.repairFamilyId !== TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY) return false;
      const diagnostic = operation.diagnosticEvidence;
      return isRecord(diagnostic) && diagnostic.path === requestPath;
    });
  });
}

function contractRecords(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function hasContract(records: readonly Record<string, unknown>[], id: string, value: string): boolean {
  return records.some(record => record.id === id && record.value === value);
}

function hasSingleContract(records: readonly Record<string, unknown>[], id: string, value: string): boolean {
  const matches = records.filter(record => record.id === id);
  return matches.length === 1 && matches[0]?.value === value;
}

function assertVerifiedTypeScriptCodeActionLineage(input: {
  program: ProgramGraph;
  artifact: FileArtifact;
  before: string;
  sourceArtifactHash: string | null;
  snapshotByPath: ReadonlyMap<string, WorkspaceRevisionFile>;
  repairOperation: Record<string, unknown>;
  preconditions: readonly Record<string, unknown>[];
  postconditions: readonly Record<string, unknown>[];
  hasher: Hasher;
}): void {
  const reject = (reason: string): never => {
    throw new Error(`program graph compiler repair lineage is invalid for ${input.artifact.path}: ${reason}`);
  };
  const textChanges = exactTextChanges(input.repairOperation.textChanges);
  const isCreate = input.sourceArtifactHash === null;
  if (!textChanges || input.repairOperation.kind !== (isCreate ? "create" : "replace")) {
    return reject("exact replacement text-change evidence is missing");
  }
  const diagnostic = input.repairOperation.diagnosticEvidence;
  if (!isRecord(diagnostic)) return reject("compiler diagnostic evidence is missing");
  const diagnosticCode = diagnostic.code;
  const diagnosticStart = diagnostic.start;
  const diagnosticLength = diagnostic.length;
  const diagnosticCategory = diagnostic.category;
  const diagnosticMessage = diagnostic.message;
  const carriedDiagnosticIdentity = diagnostic.diagnosticIdentity;
  const diagnosticPath = typeof diagnostic.path === "string" ? diagnostic.path : input.artifact.path;
  const diagnosticSnapshot = input.snapshotByPath.get(diagnosticPath);
  if (!diagnosticSnapshot) return reject("diagnostic source artifact is absent from the exact workspace revision");
  const diagnosticBefore = decodeExactUtf8(diagnosticSnapshot.bytes, diagnosticPath, diagnosticSnapshot.mediaType);
  if (typeof diagnosticCode !== "number" || !Number.isSafeInteger(diagnosticCode) || diagnosticCode <= 0
    || typeof diagnosticStart !== "number" || !Number.isSafeInteger(diagnosticStart) || diagnosticStart < 0
    || typeof diagnosticLength !== "number" || !Number.isSafeInteger(diagnosticLength) || diagnosticLength < 0
    || diagnosticStart + diagnosticLength > diagnosticBefore.length
    || typeof diagnosticCategory !== "string" || !diagnosticCategory.trim()
    || typeof diagnosticMessage !== "string" || !diagnosticMessage.trim()
    || typeof carriedDiagnosticIdentity !== "string" || !carriedDiagnosticIdentity.trim()) {
    reject("diagnostic evidence is malformed or outside the exact source artifact");
  }
  const compiler = input.repairOperation.compilerContext;
  if (!isRecord(compiler)) return reject("compiler context is missing");
  const compilerVersion = compiler.version;
  const compilerOptionsHash = compiler.compilerOptionsHash;
  const compilerOptionsSource = compiler.compilerOptionsSource;
  if (typeof compilerVersion !== "string" || !compilerVersion.trim()
    || typeof compilerOptionsHash !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(compilerOptionsHash)
    || compilerOptionsSource !== "source_observed_tsc_project"
    || compiler.sourceFileBoundary !== "workspace_snapshot_and_typescript_standard_library"
    || !Array.isArray(compiler.configDiagnosticCodes)
    || compiler.configDiagnosticCodes.length > 0) {
    reject("compiler context is malformed or carries configuration diagnostics");
  }
  const codeFix = input.repairOperation.codeFixEvidence;
  if (!isRecord(codeFix)) return reject("code-fix evidence is missing");
  const fixName = codeFix.fixName;
  const fixDescription = codeFix.description;
  const fixId = codeFix.fixId;
  const carriedCodeFixIdentity = codeFix.codeFixIdentity;
  if (typeof fixName !== "string" || !fixName.trim()
    || typeof fixDescription !== "string" || !fixDescription.trim()
    || typeof carriedCodeFixIdentity !== "string" || !carriedCodeFixIdentity.trim()
    || fixId !== undefined && (typeof fixId !== "string" || !fixId.trim())) {
    reject("code-fix evidence is malformed");
  }
  const actionFileChanges = exactActionFileChanges(codeFix.fileChanges);
  const actionFileChange = actionFileChanges?.find(change => change.path === input.artifact.path);
  if (actionFileChanges && (!actionFileChange
    || actionFileChange.isNewFile !== isCreate
    || actionFileChange.baseContentHash !== input.sourceArtifactHash
    || canonicalStringify(actionFileChange.textChanges) !== canonicalStringify(textChanges))) {
    reject("atomic code-fix file-change evidence is missing or inconsistent");
  }
  if (actionFileChanges) {
    for (const fileChange of actionFileChanges) {
      const current = input.snapshotByPath.get(fileChange.path);
      const before = current ? decodeExactUtf8(current.bytes, fileChange.path, current.mediaType) : "";
      const baseHash = current ? `sha256_${input.hasher.digestHex(before)}` : null;
      const output = input.program.files.find(file => file.path === fileChange.path);
      if (fileChange.isNewFile === Boolean(current)
        || fileChange.baseContentHash !== baseHash
        || !output
        || !verifyExactTypeScriptCodeActionTransformation({ before, after: output.content, textChanges: fileChange.textChanges })) {
        reject(`atomic code-fix file set is stale or incomplete at ${fileChange.path}`);
      }
    }
  }
  if (!verifyExactTypeScriptCodeActionTransformation({ before: input.before, after: input.artifact.content, textChanges })) {
    reject("exact text changes do not reproduce the proposed artifact");
  }
  const verifiedDiagnosticCode = diagnosticCode as number;
  const verifiedDiagnosticStart = diagnosticStart as number;
  const verifiedDiagnosticLength = diagnosticLength as number;
  const verifiedDiagnosticCategory = diagnosticCategory as string;
  const verifiedDiagnosticMessage = diagnosticMessage as string;
  const verifiedCompilerVersion = compilerVersion as string;
  const verifiedCompilerOptionsHash = compilerOptionsHash as string;
  const verifiedFixName = fixName as string;
  const verifiedFixDescription = fixDescription as string;

  const compilerCommand = compiler.compilerCommand;
  if (!isRecord(compilerCommand)) return reject("source-observed compiler command provenance is missing");
  const commandExecutable = compilerCommand.executable;
  const commandArgs = compilerCommand.args;
  const commandCwd = compilerCommand.cwd;
  const commandSourcePath = compilerCommand.sourcePath;
  const commandSourceContentHash = compilerCommand.sourceContentHash;
  if (typeof commandExecutable !== "string" || !commandExecutable.trim()
    || !Array.isArray(commandArgs) || commandArgs.some(arg => typeof arg !== "string" || !arg || arg.includes("\u0000"))
    || typeof commandCwd !== "string" || !commandCwd.trim()
    || typeof commandSourcePath !== "string" || !commandSourcePath.trim()
    || typeof commandSourceContentHash !== "string" || !/^sha256_[0-9a-f]{64}$/u.test(commandSourceContentHash)) {
    reject("source-observed compiler command provenance is malformed");
  }
  const verifiedCommand = {
    executable: commandExecutable as string,
    args: commandArgs as string[],
    cwd: commandCwd as string,
    sourcePath: commandSourcePath as string,
    sourceContentHash: commandSourceContentHash as string
  };
  const commandSourceDirectory = verifiedCommand.sourcePath.includes("/")
    ? verifiedCommand.sourcePath.slice(0, verifiedCommand.sourcePath.lastIndexOf("/"))
    : ".";
  const commandSourceArtifact = input.program.files.find(file => file.path === verifiedCommand.sourcePath);
  if (verifiedCommand.cwd !== commandSourceDirectory
    || input.program.build.command !== verifiedCommand.executable
    || input.program.build.cwd !== verifiedCommand.cwd
    || input.program.build.args.length !== verifiedCommand.args.length
    || input.program.build.args.some((arg, index) => arg !== verifiedCommand.args[index])
    || !commandSourceArtifact
    || String(commandSourceArtifact.contentHash) !== verifiedCommand.sourceContentHash
    || verifiedCommand.sourceContentHash !== `sha256_${input.hasher.digestHex(commandSourceArtifact.content)}`) {
    reject("source-observed compiler command is stale or not bound to the ProgramGraph build lane");
  }
  const compilerCommandIdentity = canonicalTypeScriptCompilerCommandIdentity(verifiedCommand, input.hasher);
  if (!hasSingleContract(input.preconditions, "repair.precondition.compiler_command_identity", compilerCommandIdentity)
    || !hasSingleContract(input.preconditions, "repair.precondition.compiler_command_source_content_hash", verifiedCommand.sourceContentHash)) {
    reject("compiler-command identity or source-content precondition is missing or stale");
  }

  const diagnosticIdentity = canonicalTypeScriptDiagnosticIdentity({
    path: diagnosticPath,
    diagnostic: {
      code: verifiedDiagnosticCode,
      category: verifiedDiagnosticCategory,
      start: verifiedDiagnosticStart,
      length: verifiedDiagnosticLength,
      message: verifiedDiagnosticMessage
    },
    compilerVersion: verifiedCompilerVersion,
    compilerOptionsHash: verifiedCompilerOptionsHash
  }, input.hasher);
  if (carriedDiagnosticIdentity !== diagnosticIdentity
    || !hasSingleContract(input.preconditions, "repair.precondition.typescript_diagnostic_identity", diagnosticIdentity)) {
    reject("diagnostic identity is missing, stale, or non-canonical");
  }
  const codeFixIdentity = canonicalTypeScriptCodeFixIdentity({
    diagnosticIdentity,
    codeFix: {
      fixName: verifiedFixName,
      description: verifiedFixDescription,
      ...(typeof fixId === "string" ? { fixId } : {}),
      ...(actionFileChanges ? { fileChanges: actionFileChanges } : { textChanges })
    }
  }, input.hasher);
  if (carriedCodeFixIdentity !== codeFixIdentity
    || !hasSingleContract(input.preconditions, "repair.precondition.typescript_code_fix_identity", codeFixIdentity)) {
    reject("code-fix identity is missing, stale, or non-canonical");
  }

  const tsconfigPath = compiler.tsconfigPath;
  const tsconfigContentHash = compiler.tsconfigContentHash;
  if (typeof tsconfigPath !== "string" || !tsconfigPath.trim()
    || typeof tsconfigContentHash !== "string" || !/^sha256_[0-9a-f]{64}$/u.test(tsconfigContentHash)) {
    reject("tsconfig path/hash provenance is missing or incoherent");
  }
  const configPath = tsconfigPath as string;
  const expectedConfigHash = tsconfigContentHash as string;
  if (!hasSingleContract(input.preconditions, "repair.precondition.tsconfig_content_hash", expectedConfigHash)) {
    reject("tsconfig content-hash precondition is missing or stale");
  }
  const configArtifact = input.program.files.find(file => file.path === configPath);
  if (!configArtifact
    || String(configArtifact.contentHash) !== expectedConfigHash
    || expectedConfigHash !== `sha256_${input.hasher.digestHex(configArtifact.content)}`) {
    reject(`tsconfig content hash is stale for ${configPath}`);
  }

  const textChangeHash = `sha256_${input.hasher.digestHex(canonicalStringify(textChanges))}`;
  const outputContentHash = `sha256_${input.hasher.digestHex(input.artifact.content)}`;
  const exactBaseContract = input.sourceArtifactHash === null
    ? input.preconditions.filter(record => record.id === "repair.precondition.target_absent_in_compiler_snapshot"
      && typeof record.value === "string"
      && record.value.endsWith(`:${input.artifact.path}`)
      && /^sha256:[0-9a-f]{64}:/u.test(record.value)).length === 1
    : hasSingleContract(input.preconditions, "repair.precondition.exact_source_content_hash", input.sourceArtifactHash);
  const createdArtifact = input.repairOperation.createdArtifact;
  const classificationValid = input.sourceArtifactHash !== null
    ? createdArtifact === undefined || createdArtifact === null
    : isRecord(createdArtifact)
      && createdArtifact.mediaType === input.artifact.mediaType
      && createdArtifact.role === input.artifact.role;
  if (!exactBaseContract
    || !classificationValid
    || !hasSingleContract(input.preconditions, "repair.precondition.compiler_options_hash", verifiedCompilerOptionsHash)
    || !hasSingleContract(input.postconditions, "repair.postcondition.exact_text_changes_applied", textChangeHash)
    || !hasSingleContract(input.postconditions, "repair.postcondition.exact_output_content_hash", outputContentHash)
    || !hasSingleContract(input.postconditions, "repair.postcondition.compiler_diagnostic_recheck_required", `TS${verifiedDiagnosticCode}`)
    || !hasSingleContract(input.postconditions, "repair.postcondition.typecheck_required", "typecheck")
    || !hasSingleContract(input.postconditions, "repair.postcondition.tests_required", "tests")) {
    reject("required exact-source or validation contracts are missing or stale");
  }
}

function exactTextChanges(value: unknown): ExactProgramTextChange[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const changes: ExactProgramTextChange[] = [];
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.start !== "number"
      || typeof item.length !== "number"
      || typeof item.newText !== "string") return undefined;
    changes.push({ start: item.start, length: item.length, newText: item.newText });
  }
  return changes;
}

function exactActionFileChanges(value: unknown): Array<{
  path: string;
  isNewFile: boolean;
  baseContentHash: string | null;
  textChanges: ExactProgramTextChange[];
}> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) return undefined;
  const changes: Array<{
    path: string;
    isNewFile: boolean;
    baseContentHash: string | null;
    textChanges: ExactProgramTextChange[];
  }> = [];
  const paths = new Set<string>();
  for (const item of value) {
    if (!isRecord(item)
      || typeof item.path !== "string" || !item.path.trim()
      || typeof item.isNewFile !== "boolean"
      || item.baseContentHash !== null && (typeof item.baseContentHash !== "string" || !/^sha256_[0-9a-f]{64}$/u.test(item.baseContentHash))) return undefined;
    const textChanges = exactTextChanges(item.textChanges);
    if (!textChanges || paths.has(item.path)) return undefined;
    paths.add(item.path);
    changes.push({ path: item.path, isNewFile: item.isNewFile, baseContentHash: item.baseContentHash as string | null, textChanges });
  }
  return changes.sort((left, right) => left.path.localeCompare(right.path));
}

function resolveProgramImportArtifact(
  sourcePath: string,
  specifier: string,
  artifacts: ReadonlyMap<string, FileArtifact>
): string | undefined {
  if (!(specifier.startsWith("./") || specifier.startsWith("../"))) return undefined;
  const baseParts = sourcePath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (baseParts.length === 0) return undefined;
      baseParts.pop();
    } else baseParts.push(part);
  }
  const resolved = baseParts.join("/");
  const candidates = [resolved];
  const extension = /\.[^/.]+$/u.exec(resolved)?.[0];
  const stem = extension ? resolved.slice(0, -extension.length) : resolved;
  for (const suffix of [".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"]) candidates.push(`${stem}${suffix}`);
  for (const suffix of ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"]) candidates.push(`${resolved}${suffix}`);
  return candidates.find(candidate => artifacts.has(candidate));
}

export function scoreWorkspacePatchProposal(
  features: WorkspacePatchQualityFeatures,
  provenance: { readonly assessmentId: string; readonly evidenceIds: readonly string[] }
): WorkspacePatchScoreTrace {
  for (const [name, value] of Object.entries(features)) boundedUnit(value, name);
  const assessmentId = requiredId(provenance.assessmentId, "patch assessment id");
  const weightedTerms: Record<keyof WorkspacePatchQualityFeatures, number> = {
    requestedBehaviorCoverage: 0.22 * features.requestedBehaviorCoverage,
    exactSourceFit: 0.17 * features.exactSourceFit,
    dependencyConsistency: 0.14 * features.dependencyConsistency,
    regressionProtection: 0.12 * features.regressionProtection,
    architecturalFit: 0.10 * features.architecturalFit,
    locality: 0.09 * features.locality,
    validationPlanQuality: 0.07 * features.validationPlanQuality,
    rollbackSafety: 0.05 * features.rollbackSafety,
    explanationAccuracy: 0.04 * features.explanationAccuracy,
    testWeakening: -1.00 * features.testWeakening,
    staleSourceRisk: -0.65 * features.staleSourceRisk,
    fabricatedBehavior: -0.55 * features.fabricatedBehavior,
    unrelatedChangeRate: -0.35 * features.unrelatedChangeRate
  };
  const score = Object.values(weightedTerms).reduce((sum, value) => sum + value, 0);
  return deepFreeze({
    schemaVersion: WORKSPACE_PATCH_SCORE_SCHEMA,
    objectiveId: WORKSPACE_PATCH_SCORE_OBJECTIVE,
    status: "provisional-uncalibrated",
    features: { ...features },
    weightedTerms,
    score,
    externalResultsOutrankScore: true,
    decisionPrecedence: ["execution-receipt", "test-results", "typecheck-results", "compiler-results", "q-patch-provisional"],
    assessmentId,
    evidenceIds: uniqueSorted(provenance.evidenceIds.map(value => requiredId(value, "patch assessment evidence id")))
  });
}

function verifyWorkspaceRevisionSnapshot(snapshot: WorkspaceRevisionSnapshot, hasher: Hasher): WorkspaceRevisionSnapshot {
  if (snapshot.schemaVersion !== WORKSPACE_REVISION_SCHEMA || snapshot.complete !== true) {
    throw new Error("workspace patch generation requires a complete supported workspace revision");
  }
  requiredId(snapshot.workspaceId, "workspace id");
  requiredId(snapshot.revisionId, "workspace revision id");
  const paths = snapshot.files.map(file => validateWorkspacePath(file.path));
  rejectDuplicatePaths(paths, "workspace revision");
  for (const file of snapshot.files) {
    if (!(file.bytes instanceof Uint8Array)) throw new Error(`workspace revision bytes are missing: ${file.path}`);
    if (file.byteLength !== file.bytes.byteLength) throw new Error(`workspace revision byte length is stale: ${file.path}`);
    const actual = hashPatchContent(file.bytes, hasher);
    if (actual !== file.contentHash) throw new Error(`stale workspace content hash for ${file.path}: expected ${file.contentHash}, found ${actual}`);
  }
  const expectedRevisionHash = hashCanonical(revisionManifest(snapshot), hasher);
  if (expectedRevisionHash !== snapshot.revisionHash) {
    throw new Error(`stale workspace revision hash: expected ${snapshot.revisionHash}, found ${expectedRevisionHash}`);
  }
  return snapshot;
}

function revisionManifest(input: Pick<WorkspaceRevisionSnapshot, "workspaceId" | "revisionId" | "files">): unknown {
  return {
    schemaVersion: WORKSPACE_REVISION_SCHEMA,
    workspaceId: input.workspaceId,
    revisionId: input.revisionId,
    complete: true,
    files: [...input.files]
      .sort((left, right) => compareCanonical(left.path, right.path))
      .map(file => ({
        path: file.path,
        byteLength: file.byteLength,
        contentHash: file.contentHash,
        mediaType: file.mediaType,
        role: file.role
      }))
  };
}

function assertArtifactContentHash(artifact: FileArtifact, hasher: Hasher): void {
  validateProposedText(artifact.path, artifact.content, artifact.mediaType);
  const expected = `sha256_${hasher.digestHex(artifact.content)}`;
  if (String(artifact.contentHash) !== expected) {
    throw new Error(`proposed artifact content hash is invalid for ${artifact.path}: expected ${expected}, found ${artifact.contentHash}`);
  }
}

function assertExpectedBase(path: string, expected: PatchContentHash, current: WorkspaceRevisionFile): void {
  if (expected !== current.contentHash) {
    throw new Error(`stale workspace base hash for ${path}: expected ${expected}, current ${current.contentHash}`);
  }
}

function validateProposedText(path: string, content: string, mediaType: string): string {
  if (typeof content !== "string") throw new Error(`proposed file does not contain complete UTF-8 text: ${path}`);
  if (content.includes("\u0000") || isBinaryMediaType(mediaType)) throw new Error(`binary file is not supported by workspace patch generation: ${path}`);
  const bytes = new TextEncoder().encode(content);
  const roundTrip = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  if (roundTrip !== content) throw new Error(`unsupported text encoding for proposed file: ${path}`);
  if (lineEndingOf(content) === "mixed") throw new Error(`mixed line endings are not supported for proposed file: ${path}`);
  return content;
}

function decodeExactUtf8(bytes: Uint8Array, path: string, mediaType: string): string {
  if (isBinaryMediaType(mediaType) || bytes.includes(0)) throw new Error(`binary file is not supported by workspace patch generation: ${path}`);
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error(`unsupported text encoding for workspace file: ${path}`);
  }
  const encoded = new TextEncoder().encode(text);
  if (!equalBytes(encoded, bytes)) throw new Error(`workspace file does not round-trip as exact UTF-8: ${path}`);
  return text;
}

function assertExactReplacementLineEndings(path: string, current: string, proposed: string): string {
  const currentEnding = lineEndingOf(current);
  if (currentEnding === "mixed") throw new Error(`mixed current line endings cannot be safely replaced: ${path}`);
  if (currentEnding === "none") return proposed;
  if (lineEndingOf(proposed) !== currentEnding) {
    throw new Error(`replacement must carry exact ${currentEnding} bytes; line-ending conversion is not permitted after artifact hashing: ${path}`);
  }
  return proposed;
}

function lineEndingOf(text: string): WorkspaceLineEnding {
  let lf = 0;
  let crlf = 0;
  let bareCr = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === "\r") {
      if (text[index + 1] === "\n") {
        crlf += 1;
        index += 1;
      } else bareCr += 1;
    } else if (text[index] === "\n") lf += 1;
  }
  if (bareCr > 0 || lf > 0 && crlf > 0) return "mixed";
  if (crlf > 0) return "crlf";
  if (lf > 0) return "lf";
  return "none";
}

function assertPackageTestScriptsPreserved(path: string, before: string, after: string): void {
  if (!(path === "package.json" || path.endsWith("/package.json"))) return;
  let beforePackage: unknown;
  let afterPackage: unknown;
  try {
    beforePackage = JSON.parse(before);
    afterPackage = JSON.parse(after);
  } catch {
    throw new Error(`package manifest patch must remain valid JSON: ${path}`);
  }
  const beforeScripts = testScripts(beforePackage);
  const afterScripts = testScripts(afterPackage);
  if (canonicalStringify(beforeScripts) !== canonicalStringify(afterScripts)) {
    throw new Error(`test weakening rejected: existing test scripts are immutable in generated plans: ${path}`);
  }
}

function testScripts(value: unknown): Record<string, string> {
  if (!isRecord(value) || !isRecord(value.scripts)) return {};
  const out: Record<string, string> = {};
  for (const [name, command] of Object.entries(value.scripts)) {
    if ((name === "test" || name.startsWith("test:") || name.endsWith(":test")) && typeof command === "string") out[name] = command;
  }
  return out;
}

function normalizeValidationPlan(input: WorkspacePatchValidationPlan): WorkspacePatchValidationPlan {
  const validatorId = requiredId(input.validatorId, "patch validator id");
  const checks = uniqueSorted(input.checks);
  if (checks.length === 0) throw new Error("workspace patch validation plan requires at least one check");
  if (checks.some(check => check !== "compiler" && check !== "typecheck" && check !== "tests")) {
    throw new Error("workspace patch validation plan contains an unsupported check");
  }
  return deepFreeze({ validatorId, checks: checks as WorkspaceValidationCheckId[] });
}

function expectedChecksFor(
  operations: readonly PatchOperationInput[],
  proposed: readonly WorkspaceProposedFile[],
  verifiedNonBehavioralPaths: ReadonlySet<string> = new Set(),
  verifiedDiagnosticRepairPaths: ReadonlySet<string> = new Set()
): WorkspaceValidationCheckId[] {
  const roles = new Set(proposed.map(item => item.artifact.role));
  const changedPaths = operations.map(operation => operation.path);
  if (changedPaths.some(path => verifiedDiagnosticRepairPaths.has(path))) return ["compiler", "typecheck", "tests"];
  if (changedPaths.length > 0
    && changedPaths.every(path => verifiedNonBehavioralPaths.has(path))
    && !roles.has("config")) return ["typecheck"];
  if (roles.has("source") || roles.has("config") || operations.some(operation => operation.kind === "delete")) return ["compiler", "typecheck", "tests"];
  return ["tests"];
}

function fractionCovered(expected: readonly string[], actual: readonly string[]): number {
  const values = new Set(actual);
  return expected.length === 0 ? 1 : expected.filter(value => values.has(value)).length / expected.length;
}

function validateAssessment(assessment: WorkspacePatchProposalAssessment): void {
  requiredId(assessment.assessmentId, "patch assessment id");
  for (const evidenceId of assessment.evidenceIds) requiredId(evidenceId, "patch assessment evidence id");
  boundedUnit(assessment.requestedBehaviorCoverage, "requestedBehaviorCoverage");
  boundedUnit(assessment.dependencyConsistency, "dependencyConsistency");
  boundedUnit(assessment.architecturalFit, "architecturalFit");
  boundedUnit(assessment.explanationAccuracy, "explanationAccuracy");
  boundedUnit(assessment.fabricatedBehavior, "fabricatedBehavior");
}

function validateWorkspacePath(value: string): string {
  if (!value || value !== value.trim() || value.includes("\u0000") || value.includes("\\")) throw new Error(`invalid workspace path: ${JSON.stringify(value)}`);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new Error(`workspace path must be relative: ${value}`);
  if (value.normalize("NFC") !== value || value.split("/").some(part => part === "" || part === "." || part === "..")) {
    throw new Error(`workspace path is unsafe: ${value}`);
  }
  return value;
}

function isProtectedTestFile(path: string, role: FileArtifact["role"]): boolean {
  return role === "test" || isAssertionPath(path);
}

function isAssertionPath(path: string): boolean {
  return /(^|\/)(?:__tests__|tests?|spec)(?:\/|$)/i.test(path) || /\.(?:test|spec)\.[^/]+$/i.test(path);
}

function isTestControlPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return /^(?:vitest|jest|mocha|ava|playwright|cypress)\.config\./i.test(name) || /^(?:pytest\.ini|tox\.ini)$/i.test(name);
}

function assertActiveRegressionTest(path: string, content: string): void {
  if (!content.trim()) throw new Error(`regression test proposal is empty: ${path}`);
  const neutralized = /(?:\bit|\btest|\bdescribe)\s*\.\s*(?:skip|todo)\b|@pytest\.mark\.skip\b|\bunittest\.skip\b|\bpending\s*\(/u;
  if (neutralized.test(content)) throw new Error(`test weakening rejected: regression test is skipped or neutralized: ${path}`);
  if (!isActiveRegressionTestContent(content)) {
    throw new Error(`regression test proposal must register a test and assert behavior: ${path}`);
  }
}

function assertRegressionTestsExerciseBehavior(
  tests: readonly { path: string; content: string }[],
  behaviorPaths: readonly string[]
): void {
  for (const test of tests) {
    if (regressionTestExercisesBehavior(test.path, test.content, new Set(behaviorPaths))) return;
  }
  throw new Error(`regression test proposal must import and assert behavior from a changed source artifact: ${behaviorPaths.join(", ")}`);
}

function regressionTestExercisesBehavior(testPath: string, content: string, behavior: ReadonlySet<string>): boolean {
  const executable = stripCommentsAndStrings(content);
  const imports = sourceImportsWithBindings(content);
  for (const imported of imports) {
    const target = resolveWorkspaceImportPath(testPath, imported.specifier, behavior);
    if (!target) continue;
    for (const binding of imported.bindings) {
      const escaped = escapeRegex(binding);
      const expectUsesBinding = new RegExp(`\\bexpect\\s*\\(\\s*(?:await\\s+)?${escaped}(?:\\s*\\(|\\b)`, "u").test(executable);
      const assertUsesBinding = new RegExp(`\\bassert(?:\\.[A-Za-z_$][\\w$]*)?\\s*\\([^\\n;]*\\b${escaped}(?:\\s*\\(|\\b)`, "u").test(executable);
      if (expectUsesBinding || assertUsesBinding) return true;
    }
  }
  return false;
}

function sourceImportsWithBindings(content: string): Array<{ specifier: string; bindings: string[] }> {
  const imports: Array<{ specifier: string; bindings: string[] }> = [];
  const pattern = /^\s*import\s+(?:type\s+)?(.+?)\s+from\s+["']([^"']+)["']\s*;?/gmu;
  for (const match of content.matchAll(pattern)) {
    const clause = match[1]?.trim() ?? "";
    const specifier = match[2] ?? "";
    const bindings: string[] = [];
    const named = /\{([^}]+)\}/u.exec(clause)?.[1];
    if (named) {
      for (const item of named.split(",")) {
        const parts = item.trim().split(/\s+as\s+/u);
        const binding = parts[1] ?? parts[0];
        if (binding && /^[A-Za-z_$][\w$]*$/u.test(binding)) bindings.push(binding);
      }
    }
    const namespace = /\*\s+as\s+([A-Za-z_$][\w$]*)/u.exec(clause)?.[1];
    if (namespace) bindings.push(namespace);
    const defaultBinding = clause.split(",", 1)[0]?.trim();
    if (defaultBinding && /^[A-Za-z_$][\w$]*$/u.test(defaultBinding)) bindings.push(defaultBinding);
    imports.push({ specifier, bindings: uniqueSorted(bindings) });
  }
  return imports;
}

function resolveWorkspaceImportPath(sourcePath: string, specifier: string, candidates: ReadonlySet<string>): string | undefined {
  if (!(specifier.startsWith("./") || specifier.startsWith("../"))) return undefined;
  const baseParts = sourcePath.split("/").slice(0, -1);
  for (const part of specifier.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (baseParts.length === 0) return undefined;
      baseParts.pop();
    } else baseParts.push(part);
  }
  const resolved = baseParts.join("/");
  const extension = /\.[^/.]+$/u.exec(resolved)?.[0];
  const stem = extension ? resolved.slice(0, -extension.length) : resolved;
  const paths = [resolved, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"].map(suffix => `${stem}${suffix}`)];
  return paths.find(path => candidates.has(path));
}

function isActiveRegressionTestContent(content: string): boolean {
  const executable = stripCommentsAndStrings(content);
  const registersTest = /(?:^|[;{}]\s*)(?:it|test)\s*\(/mu.test(executable);
  const assertsBehavior = /\bexpect\s*\(|\bassert(?:\.[A-Za-z_$][\w$]*)?\s*\(|\bthrow\s+new\s+Error\s*\(/mu.test(executable);
  return registersTest && assertsBehavior;
}

function stripCommentsAndStrings(content: string): string {
  let result = "";
  let state: "code" | "line-comment" | "block-comment" | "single-quote" | "double-quote" | "template" = "code";
  for (let index = 0; index < content.length; index += 1) {
    const current = content[index]!;
    const next = content[index + 1];
    if (state === "code") {
      if (current === "/" && next === "/") {
        result += "  ";
        index += 1;
        state = "line-comment";
      } else if (current === "/" && next === "*") {
        result += "  ";
        index += 1;
        state = "block-comment";
      } else if (current === "'") {
        result += " ";
        state = "single-quote";
      } else if (current === '"') {
        result += " ";
        state = "double-quote";
      } else if (current === "`") {
        result += " ";
        state = "template";
      } else result += current;
      continue;
    }
    if (state === "line-comment") {
      result += current === "\n" || current === "\r" ? current : " ";
      if (current === "\n" || current === "\r") state = "code";
      continue;
    }
    if (state === "block-comment") {
      if (current === "*" && next === "/") {
        result += "  ";
        index += 1;
        state = "code";
      } else result += current === "\n" || current === "\r" ? current : " ";
      continue;
    }
    if (current === "\\") {
      result += " ";
      if (next !== undefined) {
        result += next === "\n" || next === "\r" ? next : " ";
        index += 1;
      }
      continue;
    }
    const closes = state === "single-quote" && current === "'"
      || state === "double-quote" && current === '"'
      || state === "template" && current === "`";
    result += current === "\n" || current === "\r" ? current : " ";
    if (closes) state = "code";
  }
  return result;
}

function isBinaryMediaType(mediaType: string): boolean {
  const value = mediaType.toLocaleLowerCase();
  if (value.startsWith("text/")) return false;
  if (value.includes("json") || value.includes("xml") || value.includes("yaml") || value.includes("javascript") || value.includes("typescript")) return false;
  return value.startsWith("image/") || value.startsWith("audio/") || value.startsWith("video/") || value === "application/octet-stream" || value.includes("zip") || value.includes("pdf");
}

function boundedUnit(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`workspace patch feature ${name} must be within [0, 1]`);
}

function requiredId(value: string, label: string): string {
  const clean = value?.trim();
  if (!clean || clean.includes("\u0000")) throw new Error(`${label} is required`);
  return clean;
}

function rejectDuplicatePaths(paths: readonly string[], label: string): void {
  const seen = new Set<string>();
  for (const path of paths) {
    if (seen.has(path)) throw new Error(`${label} contains duplicate path: ${path}`);
    seen.add(path);
  }
}

function hashCanonical(value: unknown, hasher: Hasher): PatchContentHash {
  return `sha256:${hasher.digestHex(canonicalStringify(value))}`;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) if (left[index] !== right[index]) return false;
  return true;
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueSorted<T extends string>(values: readonly T[]): T[] {
  return [...new Set(values)].sort(compareCanonical);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function freezeSnapshot(snapshot: WorkspaceRevisionSnapshot): WorkspaceRevisionSnapshot {
  for (const file of snapshot.files) Object.freeze(file);
  Object.freeze(snapshot.files);
  return Object.freeze(snapshot);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    if (ArrayBuffer.isView(value)) return value;
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
