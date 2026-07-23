import { createHash } from "node:crypto";

export const PATCH_PLAN_SCHEMA = "yopp.patch-transaction-plan.v1" as const;
export const WORKSPACE_PATCH_REQUEST_SCHEMA = "yopp.workspace-patch-request.v1" as const;
export const WORKSPACE_PATCH_RESPONSE_SCHEMA = "yopp.workspace-patch-response.v1" as const;
export const WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA = "scce.workspace-coding-patch-plan-request.v1" as const;
export const WORKSPACE_COMPILER_PATCH_PLAN_SCHEMA = "scce.workspace.compiler_patch_plan.v1" as const;
export const WORKSPACE_TRANSFORMATION_FAMILY_SELECTION_SCHEMA = "scce.workspace.transformation_family_selection.v1" as const;
export const WORKSPACE_TASK_CONSTRAINT_GRAPH_SCHEMA = "scce.workspace.task_constraint_graph.v1" as const;
export const TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY = "repair.family.typescript.code_action.v1" as const;
export const DEFAULT_PATCH_VALIDATION_POLICY_ID = "trusted-host-pnpm-validate.v1" as const;
export const DEFAULT_PATCH_VALIDATION_CHECKS = ["compiler", "typecheck", "tests"] as const;

export type PatchHash = `sha256:${string}`;
export type ReviewedPatchOperation =
  | { kind: "create"; path: string; beforeContentHash: null; afterContentHash: PatchHash; content: string }
  | { kind: "replace"; path: string; beforeContentHash: PatchHash; afterContentHash: PatchHash; content: string }
  | { kind: "delete"; path: string; beforeContentHash: PatchHash; afterContentHash: null };

export interface ReviewedPatchPlan {
  schemaVersion: typeof PATCH_PLAN_SCHEMA;
  operations: ReviewedPatchOperation[];
  planHash: PatchHash;
}

export interface WorkspaceStatusResponse {
  workspace: { id: string; rootPath: string; updatedAt: number };
  sources: Array<{ path: string }>;
}

export interface WorkspaceCodingPatchPlanRequest {
  schemaVersion: typeof WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA;
  workspaceId: string;
  expectedWorkspaceUpdatedAt: number;
  requestId: string;
  requestText: string;
  requestedPaths: string[];
  diagnosticCodes: number[];
  validationPlan: {
    validatorId: typeof DEFAULT_PATCH_VALIDATION_POLICY_ID;
    checks: Array<(typeof DEFAULT_PATCH_VALIDATION_CHECKS)[number]>;
  };
}

export interface WorkspaceCodingPatchPlanSelected {
  kind: "selected";
  schemaVersion: typeof WORKSPACE_COMPILER_PATCH_PLAN_SCHEMA;
  statusId: "scce.workspace.compiler_patch.selected.v1";
  workspaceId: string;
  revisionId: string;
  revisionHash: PatchHash;
  requestId: string;
  requestedPaths: string[];
  diagnosticCode: number;
  plan: ReviewedPatchPlan;
  validationPlan: {
    validatorId: typeof DEFAULT_PATCH_VALIDATION_POLICY_ID;
    checks: Array<(typeof DEFAULT_PATCH_VALIDATION_CHECKS)[number]>;
  };
  authorization: { required: true; granted: false; capabilityId: "workspace.patch.apply" };
  execution: { state: "not_executed"; receipt: null };
  selection: {
    familyId: typeof TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY;
    candidateId: string;
    diagnosticIdentity: string;
    codeFixIdentity: string;
  };
}

export interface WorkspaceCodingPatchPlanUnresolved {
  kind: "unresolved";
  schemaVersion: typeof WORKSPACE_COMPILER_PATCH_PLAN_SCHEMA | typeof WORKSPACE_TRANSFORMATION_FAMILY_SELECTION_SCHEMA;
  statusId: "scce.workspace.compiler_patch.unresolved.v1";
  workspaceId: string;
  revisionId: string;
  revisionHash: PatchHash;
  requestId: string;
  requestedPaths: string[];
  reasonIds: string[];
  execution: { state: "not_executed"; receipt: null };
}

export type WorkspaceCodingPatchPlanResult = WorkspaceCodingPatchPlanSelected | WorkspaceCodingPatchPlanUnresolved;

export interface PendingPatchApproval {
  ok: false;
  pendingApproval: { planId: string; capabilityId: string; fingerprint: string; reason: string; createdAt: number };
}

export interface AppliedWorkspacePatch {
  schemaVersion: typeof WORKSPACE_PATCH_RESPONSE_SCHEMA;
  workspaceId: string;
  validationPolicyId: string;
  receipt: {
    schemaVersion: "yopp.patch-transaction-receipt.v1";
    transactionScope: "atomic-per-file-with-verified-transaction-rollback";
    planHash: PatchHash;
    validation: { validatorId: string; evidenceHash: PatchHash };
    mutations: Array<{
      schemaVersion: "yopp.patch-mutation-receipt.v1";
      planHash: PatchHash;
      operationIndex: number;
      kind: "create" | "replace" | "delete";
      path: string;
      beforeContentHash: PatchHash | null;
      afterContentHash: PatchHash | null;
      mutationHash: PatchHash;
    }>;
    receiptHash: PatchHash;
  };
}

export type WorkspacePatchAttempt = PendingPatchApproval | AppliedWorkspacePatch;

export function parseReviewedPatchPlan(value: unknown): ReviewedPatchPlan {
  const input = exactRecord(value, "patch plan", ["schemaVersion", "operations", "planHash"]);
  literal(input.schemaVersion, PATCH_PLAN_SCHEMA, "patch plan schema");
  const planHash = patchHash(input.planHash, "patch plan hash");
  if (!Array.isArray(input.operations) || input.operations.length < 1 || input.operations.length > 256) throw new Error("patch plan must contain 1 through 256 operations");
  const operations = input.operations.map((value, index) => parseOperation(value, index));
  const paths = new Set<string>();
  for (const operation of operations) {
    if (paths.has(operation.path)) throw new Error(`patch plan contains duplicate path: ${operation.path}`);
    paths.add(operation.path);
  }
  const sortedPaths = operations.map(operation => operation.path).sort(compareCanonical);
  if (!operations.every((operation, index) => operation.path === sortedPaths[index])) throw new Error("patch plan operations are not in canonical path order");
  const expected = canonicalPatchHash({ schemaVersion: PATCH_PLAN_SCHEMA, operations });
  if (planHash !== expected) throw new Error(`patch plan content does not match planHash; expected ${expected}`);
  return { schemaVersion: PATCH_PLAN_SCHEMA, operations, planHash };
}

export function parseWorkspaceStatus(value: unknown): WorkspaceStatusResponse {
  const input = record(value, "workspace status");
  if (input.workspace === null) throw new Error("no durable Yopp workspace is initialized; initialize and ingest the open folder first");
  const workspace = record(input.workspace, "workspace status workspace");
  const sources = array(input.sources, "workspace sources").map((value, index) => {
    const source = record(value, `workspace source ${index}`);
    return { path: patchPath(source.path, `workspace source ${index} path`) };
  });
  if (new Set(sources.map(source => source.path)).size !== sources.length) throw new Error("workspace sources contain duplicate paths");
  return {
    workspace: {
      id: boundedId(workspace.id, "workspace id"),
      rootPath: nonEmptyString(workspace.rootPath, "workspace rootPath"),
      updatedAt: nonNegativeSafeInteger(workspace.updatedAt, "workspace updatedAt")
    },
    sources: sources.sort((left, right) => left.path.localeCompare(right.path))
  };
}

export function parseWorkspaceCodingPatchPlanResult(
  value: unknown,
  request: WorkspaceCodingPatchPlanRequest
): WorkspaceCodingPatchPlanResult {
  const input = record(value, "workspace coding patch plan result");
  if (input.schemaVersion === WORKSPACE_COMPILER_PATCH_PLAN_SCHEMA) {
    if (input.statusId === "scce.workspace.compiler_patch.selected.v1") return parseSelectedCompilerPlan(input, request);
    if (input.statusId === "scce.workspace.compiler_patch.unresolved.v1") return parseUnresolvedCompilerPlan(input, request);
    throw new Error("workspace compiler patch result status is unsupported");
  }
  if (input.schema === WORKSPACE_TRANSFORMATION_FAMILY_SELECTION_SCHEMA) {
    return parseUnresolvedTransformationSelection(input, request);
  }
  throw new Error("workspace coding patch result schema is unsupported");
}

function parseSelectedCompilerPlan(
  value: unknown,
  request: WorkspaceCodingPatchPlanRequest
): WorkspaceCodingPatchPlanSelected {
  const input = exactRecord(value, "selected workspace compiler patch plan", [
    "schemaVersion",
    "statusId",
    "workspaceId",
    "revisionId",
    "revisionHash",
    "constraintGraph",
    "selection",
    "plan",
    "validationPlan",
    "authorization",
    "execution"
  ]);
  literal(input.schemaVersion, WORKSPACE_COMPILER_PATCH_PLAN_SCHEMA, "selected compiler plan schema");
  literal(input.statusId, "scce.workspace.compiler_patch.selected.v1", "selected compiler plan status");
  const workspaceId = boundedId(input.workspaceId, "selected compiler plan workspaceId");
  if (workspaceId !== request.workspaceId) throw new Error("coding plan belongs to another workspace");
  const revisionId = boundedId(input.revisionId, "selected compiler plan revisionId");
  const revisionHash = patchHash(input.revisionHash, "selected compiler plan revisionHash");
  const plan = parseReviewedPatchPlan(input.plan);
  const validationPlan = parseCodingValidationPlan(input.validationPlan);
  if (validationPlan.validatorId !== request.validationPlan.validatorId || !sameStringSets(validationPlan.checks, request.validationPlan.checks)) {
    throw new Error("coding plan validation policy does not match the submitted request");
  }
  const authorization = parseAbsentPatchAuthorization(input.authorization);
  parseUnexecutedPlanState(input.execution, "selected compiler plan execution");

  const selection = record(input.selection, "selected compiler transformation selection");
  literal(selection.schema, WORKSPACE_TRANSFORMATION_FAMILY_SELECTION_SCHEMA, "compiler transformation selection schema");
  const selected = record(selection.selected, "selected compiler transformation");
  const familyId = literal(selected.familyId, TYPESCRIPT_CODE_ACTION_REPAIR_FAMILY, "selected compiler transformation family");
  const candidateId = boundedId(selected.candidateId, "selected compiler transformation candidateId");
  const diagnosticIdentity = boundedId(selected.diagnosticIdentity, "selected compiler diagnostic identity");
  const codeFixIdentity = boundedId(selected.codeFixIdentity, "selected compiler code-fix identity");
  const diagnosticNodeId = boundedId(selected.diagnosticNodeId, "selected compiler diagnostic nodeId");
  parseUnexecutedSelectionState(selected.execution, "selected compiler transformation execution");
  parseUnexecutedSelectionState(selection.execution, "compiler transformation selection execution");
  const selectedPlan = parseReviewedPatchPlan(selected.patchPlan);
  if (selectedPlan.planHash !== plan.planHash) throw new Error("selected compiler transformation contains a different patch plan");

  const graph = record(input.constraintGraph, "selected compiler constraint graph");
  literal(graph.schema, WORKSPACE_TASK_CONSTRAINT_GRAPH_SCHEMA, "selected compiler constraint graph schema");
  const graphId = boundedId(graph.id, "selected compiler constraint graph id");
  if (boundedId(selection.graphId, "compiler transformation selection graphId") !== graphId) {
    throw new Error("compiler transformation selection belongs to another constraint graph");
  }
  if (boundedId(graph.requestId, "selected compiler constraint graph requestId") !== request.requestId) {
    throw new Error("coding plan belongs to another request");
  }
  parseUnexecutedSelectionState(graph.execution, "selected compiler constraint graph execution");
  const graphRevision = exactRecord(graph.workspaceRevision, "selected compiler constraint graph workspace revision", ["workspaceId", "revisionId", "revisionHash"]);
  if (boundedId(graphRevision.workspaceId, "constraint graph workspaceId") !== workspaceId
    || boundedId(graphRevision.revisionId, "constraint graph revisionId") !== revisionId
    || patchHash(graphRevision.revisionHash, "constraint graph revisionHash") !== revisionHash) {
    throw new Error("coding plan constraint graph belongs to another workspace revision");
  }

  const nodes = array(graph.nodes, "selected compiler constraint graph nodes").map((node, index) => record(node, `constraint graph node ${index}`));
  const requestNodes = nodes.filter(node => node.kindId === "scce.task.request.v1" && node.subjectId === request.requestId);
  if (requestNodes.length !== 1) throw new Error("coding plan constraint graph request binding is invalid");
  const requestMetadata = record(requestNodes[0]!.metadata, "constraint graph request metadata");
  const requestedPaths = boundedUniquePaths(requestMetadata.requestedPaths, "constraint graph requestedPaths", 256);
  if (!sameStrings(requestedPaths, request.requestedPaths)) throw new Error("coding plan requested paths do not match the submitted scope");

  const diagnosticNodeIds = boundedUniqueStrings(graph.diagnosticNodeIds, "constraint graph diagnosticNodeIds", 4096);
  if (!diagnosticNodeIds.includes(diagnosticNodeId)) throw new Error("selected compiler diagnostic is absent from the constraint graph index");
  const diagnosticNode = nodes.find(node => node.id === diagnosticNodeId && node.kindId === "scce.program.diagnostic.v1");
  if (!diagnosticNode) throw new Error("selected compiler diagnostic node is absent from the constraint graph");
  const diagnosticMetadata = record(diagnosticNode.metadata, "selected compiler diagnostic metadata");
  if (boundedId(diagnosticMetadata.diagnosticIdentity, "selected compiler graph diagnostic identity") !== diagnosticIdentity) {
    throw new Error("selected compiler diagnostic identity does not match its constraint graph node");
  }
  const diagnosticCode = positiveSafeInteger(diagnosticMetadata.compilerCode, "selected compiler diagnostic code");
  if (!request.diagnosticCodes.includes(diagnosticCode)) throw new Error("selected compiler diagnostic code was not requested");

  return {
    kind: "selected",
    schemaVersion: WORKSPACE_COMPILER_PATCH_PLAN_SCHEMA,
    statusId: "scce.workspace.compiler_patch.selected.v1",
    workspaceId,
    revisionId,
    revisionHash,
    requestId: request.requestId,
    requestedPaths,
    diagnosticCode,
    plan,
    validationPlan,
    authorization,
    execution: { state: "not_executed", receipt: null },
    selection: { familyId, candidateId, diagnosticIdentity, codeFixIdentity }
  };
}

function parseUnresolvedCompilerPlan(
  value: unknown,
  request: WorkspaceCodingPatchPlanRequest
): WorkspaceCodingPatchPlanUnresolved {
  const input = exactRecord(value, "unresolved workspace compiler patch plan", [
    "schemaVersion",
    "statusId",
    "workspaceId",
    "revisionId",
    "revisionHash",
    "requestId",
    "requestedPaths",
    "reasonIds",
    "observedCompilerLaneCount",
    "selection",
    "plan",
    "execution"
  ]);
  literal(input.schemaVersion, WORKSPACE_COMPILER_PATCH_PLAN_SCHEMA, "unresolved compiler plan schema");
  literal(input.statusId, "scce.workspace.compiler_patch.unresolved.v1", "unresolved compiler plan status");
  const workspaceId = boundedId(input.workspaceId, "unresolved compiler plan workspaceId");
  if (workspaceId !== request.workspaceId) throw new Error("unresolved coding plan belongs to another workspace");
  const requestId = boundedId(input.requestId, "unresolved compiler plan requestId");
  if (requestId !== request.requestId) throw new Error("unresolved coding plan belongs to another request");
  const requestedPaths = boundedUniquePaths(input.requestedPaths, "unresolved compiler plan requestedPaths", 256);
  if (!sameStrings(requestedPaths, request.requestedPaths)) throw new Error("unresolved coding plan requested paths do not match the submitted scope");
  const reasonIds = boundedUniqueStrings(input.reasonIds, "unresolved compiler plan reasonIds", 256);
  if (reasonIds.length < 1) throw new Error("unresolved compiler plan must contain at least one reason ID");
  nonNegativeSafeInteger(input.observedCompilerLaneCount, "unresolved compiler plan observedCompilerLaneCount");
  if (input.selection !== null || input.plan !== null) throw new Error("unresolved compiler plan must not contain a selected transformation or patch plan");
  parseUnexecutedPlanState(input.execution, "unresolved compiler plan execution");
  return {
    kind: "unresolved",
    schemaVersion: WORKSPACE_COMPILER_PATCH_PLAN_SCHEMA,
    statusId: "scce.workspace.compiler_patch.unresolved.v1",
    workspaceId,
    revisionId: boundedId(input.revisionId, "unresolved compiler plan revisionId"),
    revisionHash: patchHash(input.revisionHash, "unresolved compiler plan revisionHash"),
    requestId,
    requestedPaths,
    reasonIds,
    execution: { state: "not_executed", receipt: null }
  };
}

function parseUnresolvedTransformationSelection(
  value: unknown,
  request: WorkspaceCodingPatchPlanRequest
): WorkspaceCodingPatchPlanUnresolved {
  const input = record(value, "unresolved compiler transformation selection");
  literal(input.schema, WORKSPACE_TRANSFORMATION_FAMILY_SELECTION_SCHEMA, "unresolved compiler transformation selection schema");
  if (input.selected !== null) throw new Error("a selected transformation must be returned in the compiler plan envelope");
  parseUnexecutedSelectionState(input.execution, "unresolved compiler transformation selection execution");
  const revision = exactRecord(input.workspaceRevision, "unresolved transformation workspace revision", ["workspaceId", "revisionId", "revisionHash"]);
  const workspaceId = boundedId(revision.workspaceId, "unresolved transformation workspaceId");
  if (workspaceId !== request.workspaceId) throw new Error("unresolved transformation belongs to another workspace");
  const reasonIds = new Set<string>();
  for (const [index, candidate] of array(input.rejectedCandidates, "unresolved transformation rejectedCandidates").entries()) {
    const item = record(candidate, `unresolved transformation rejected candidate ${index}`);
    for (const reason of boundedUniqueStrings(item.reasonIds, `unresolved transformation rejected candidate ${index} reasonIds`, 256)) reasonIds.add(reason);
  }
  for (const [index, constraint] of array(input.graphUnresolvedConstraints, "unresolved transformation graphUnresolvedConstraints").entries()) {
    const item = record(constraint, `unresolved transformation graph constraint ${index}`);
    reasonIds.add(boundedId(item.reasonId, `unresolved transformation graph constraint ${index} reasonId`));
  }
  for (const [index, outcome] of array(input.unresolvedOutcomes, "unresolved transformation unresolvedOutcomes").entries()) {
    const item = record(outcome, `unresolved transformation outcome ${index}`);
    for (const reason of boundedUniqueStrings(item.reasonIds, `unresolved transformation outcome ${index} reasonIds`, 256)) reasonIds.add(reason);
  }
  if (reasonIds.size < 1) throw new Error("unresolved compiler transformation must contain at least one reason ID");
  return {
    kind: "unresolved",
    schemaVersion: WORKSPACE_TRANSFORMATION_FAMILY_SELECTION_SCHEMA,
    statusId: "scce.workspace.compiler_patch.unresolved.v1",
    workspaceId,
    revisionId: boundedId(revision.revisionId, "unresolved transformation revisionId"),
    revisionHash: patchHash(revision.revisionHash, "unresolved transformation revisionHash"),
    requestId: request.requestId,
    requestedPaths: [...request.requestedPaths],
    reasonIds: [...reasonIds].sort(compareCanonical),
    execution: { state: "not_executed", receipt: null }
  };
}

export function parseWorkspacePatchAttempt(value: unknown): WorkspacePatchAttempt {
  const input = record(value, "workspace patch response");
  if (input.ok === false && input.pendingApproval !== undefined) {
    exactRecord(value, "pending workspace patch response", ["ok", "pendingApproval", "session"]);
    const pending = record(input.pendingApproval, "pending patch approval");
    return {
      ok: false,
      pendingApproval: {
        planId: nonEmptyString(pending.planId, "approval planId"),
        capabilityId: literal(pending.capabilityId, "workspace.patch.apply", "approval capabilityId"),
        fingerprint: hexDigest(pending.fingerprint, "approval fingerprint"),
        reason: nonEmptyString(pending.reason, "approval reason"),
        createdAt: finiteNumber(pending.createdAt, "approval createdAt")
      }
    };
  }
  exactRecord(value, "workspace patch response", ["schemaVersion", "workspaceId", "validationPolicyId", "receipt"]);
  literal(input.schemaVersion, WORKSPACE_PATCH_RESPONSE_SCHEMA, "workspace patch response schema");
  const receipt = exactRecord(input.receipt, "workspace patch receipt", ["schemaVersion", "transactionScope", "planHash", "validation", "mutations", "receiptHash"]);
  literal(receipt.schemaVersion, "yopp.patch-transaction-receipt.v1", "workspace patch receipt schema");
  const planHash = patchHash(receipt.planHash, "receipt planHash");
  const transactionScope = literal(receipt.transactionScope, "atomic-per-file-with-verified-transaction-rollback", "receipt transactionScope");
  const validation = parseValidationReceipt(receipt.validation);
  const mutations = array(receipt.mutations, "receipt mutations").map((value, index) => parseMutationReceipt(value, index, planHash));
  const receiptHash = patchHash(receipt.receiptHash, "receipt receiptHash");
  const expectedReceiptHash = canonicalPatchHash({ schemaVersion: "yopp.patch-transaction-receipt.v1", transactionScope, planHash, validation, mutations });
  if (receiptHash !== expectedReceiptHash) throw new Error(`workspace patch receipt content does not match receiptHash; expected ${expectedReceiptHash}`);
  const validationPolicyId = nonEmptyString(input.validationPolicyId, "workspace patch validationPolicyId");
  if (validation.validatorId !== validationPolicyId) throw new Error("workspace patch validation receipt does not match validationPolicyId");
  return {
    schemaVersion: WORKSPACE_PATCH_RESPONSE_SCHEMA,
    workspaceId: nonEmptyString(input.workspaceId, "workspace patch workspaceId"),
    validationPolicyId,
    receipt: {
      schemaVersion: "yopp.patch-transaction-receipt.v1",
      transactionScope,
      planHash,
      validation,
      receiptHash,
      mutations
    }
  };
}

export function parseSessionApproval(value: unknown): { approved: { planId: string; capabilityId: string } } {
  const input = exactRecord(value, "session approval response", ["approved", "session"]);
  const approved = record(input.approved, "approved plan");
  return {
    approved: {
      planId: nonEmptyString(approved.planId, "approved planId"),
      capabilityId: literal(approved.capabilityId, "workspace.patch.apply", "approved capabilityId")
    }
  };
}

function parseValidationReceipt(value: unknown): { validatorId: string; evidenceHash: PatchHash } {
  if (value === null) throw new Error("workspace patch response is missing its validation receipt");
  const input = exactRecord(value, "patch validation receipt", ["validatorId", "evidenceHash"]);
  return { validatorId: nonEmptyString(input.validatorId, "validation validatorId"), evidenceHash: patchHash(input.evidenceHash, "validation evidenceHash") };
}

function parseCodingValidationPlan(value: unknown): WorkspaceCodingPatchPlanSelected["validationPlan"] {
  const input = exactRecord(value, "coding plan validationPlan", ["validatorId", "checks"]);
  const checks = array(input.checks, "coding plan validationPlan checks").map((value, index) => {
    if (value !== "compiler" && value !== "typecheck" && value !== "tests") throw new Error(`coding plan validationPlan check ${index} is unsupported`);
    return value;
  });
  if (checks.length < 1 || checks.length > DEFAULT_PATCH_VALIDATION_CHECKS.length || new Set(checks).size !== checks.length) {
    throw new Error("coding plan validationPlan checks must contain one through three unique supported checks");
  }
  return {
    validatorId: literal(input.validatorId, DEFAULT_PATCH_VALIDATION_POLICY_ID, "coding plan validationPlan validatorId"),
    checks
  };
}

function parseAbsentPatchAuthorization(value: unknown): WorkspaceCodingPatchPlanSelected["authorization"] {
  const authorization = exactRecord(value, "coding plan authorization", ["required", "granted", "capabilityId"]);
  if (authorization.required !== true || authorization.granted !== false) throw new Error("coding plan must be returned unauthorized");
  return {
    required: true,
    granted: false,
    capabilityId: literal(authorization.capabilityId, "workspace.patch.apply", "coding plan authorization capabilityId")
  };
}

function parseUnexecutedPlanState(value: unknown, label: string): void {
  const execution = exactRecord(value, label, ["state", "receipt"]);
  literal(execution.state, "not_executed", `${label} state`);
  if (execution.receipt !== null) throw new Error(`${label} must not contain a receipt`);
}

function parseUnexecutedSelectionState(value: unknown, label: string): void {
  const execution = exactRecord(value, label, ["state"]);
  literal(execution.state, "not_executed", `${label} state`);
}

function parseMutationReceipt(value: unknown, index: number, expectedPlanHash: PatchHash): AppliedWorkspacePatch["receipt"]["mutations"][number] {
  const input = exactRecord(value, `patch mutation ${index}`, ["schemaVersion", "planHash", "operationIndex", "kind", "path", "beforeContentHash", "afterContentHash", "mutationHash"]);
  const schemaVersion = literal(input.schemaVersion, "yopp.patch-mutation-receipt.v1", `patch mutation ${index} schema`);
  const planHash = patchHash(input.planHash, `patch mutation ${index} planHash`);
  if (planHash !== expectedPlanHash) throw new Error(`patch mutation ${index} belongs to another plan`);
  const operationIndex = finiteNumber(input.operationIndex, `patch mutation ${index} operationIndex`);
  if (!Number.isSafeInteger(operationIndex) || operationIndex !== index) throw new Error(`patch mutation ${index} is not complete and ordered`);
  const kind = input.kind;
  if (kind !== "create" && kind !== "replace" && kind !== "delete") throw new Error(`patch mutation ${index} kind is unsupported`);
  const operationKind: "create" | "replace" | "delete" = kind;
  const path = patchPath(input.path, `patch mutation ${index} path`);
  const beforeContentHash = input.beforeContentHash === null ? null : patchHash(input.beforeContentHash, `patch mutation ${index} beforeContentHash`);
  const afterContentHash = input.afterContentHash === null ? null : patchHash(input.afterContentHash, `patch mutation ${index} afterContentHash`);
  if ((operationKind === "create" && beforeContentHash !== null) || (operationKind === "delete" && afterContentHash !== null) || (operationKind === "replace" && (beforeContentHash === null || afterContentHash === null))) {
    throw new Error(`patch mutation ${index} hashes do not match ${operationKind}`);
  }
  const mutationHash = patchHash(input.mutationHash, `patch mutation ${index} mutationHash`);
  const payload = { schemaVersion, planHash, operationIndex, kind: operationKind, path, beforeContentHash, afterContentHash };
  const expectedMutationHash = canonicalPatchHash(payload);
  if (mutationHash !== expectedMutationHash) throw new Error(`patch mutation ${index} content does not match mutationHash; expected ${expectedMutationHash}`);
  return { ...payload, mutationHash };
}

function parseOperation(value: unknown, index: number): ReviewedPatchOperation {
  const base = record(value, `patch operation ${index}`);
  const kind = base.kind;
  const keys = kind === "delete"
    ? ["kind", "path", "beforeContentHash", "afterContentHash"]
    : ["kind", "path", "beforeContentHash", "afterContentHash", "content"];
  const input = exactRecord(value, `patch operation ${index}`, keys);
  const path = patchPath(input.path, `patch operation ${index} path`);
  if (kind === "create") {
    if (input.beforeContentHash !== null) throw new Error(`patch operation ${index} create beforeContentHash must be null`);
    const content = patchContent(input.content, `patch operation ${index} content`);
    const afterContentHash = patchHash(input.afterContentHash, `patch operation ${index} afterContentHash`);
    if (afterContentHash !== hashText(content)) throw new Error(`patch operation ${index} content hash does not match afterContentHash`);
    return { kind, path, beforeContentHash: null, afterContentHash, content };
  }
  if (kind === "replace") {
    const content = patchContent(input.content, `patch operation ${index} content`);
    const beforeContentHash = patchHash(input.beforeContentHash, `patch operation ${index} beforeContentHash`);
    const afterContentHash = patchHash(input.afterContentHash, `patch operation ${index} afterContentHash`);
    if (afterContentHash !== hashText(content)) throw new Error(`patch operation ${index} content hash does not match afterContentHash`);
    return { kind, path, beforeContentHash, afterContentHash, content };
  }
  if (kind === "delete") {
    if (input.afterContentHash !== null) throw new Error(`patch operation ${index} delete afterContentHash must be null`);
    return { kind, path, beforeContentHash: patchHash(input.beforeContentHash, `patch operation ${index} beforeContentHash`), afterContentHash: null };
  }
  throw new Error(`patch operation ${index} kind is unsupported`);
}

function patchPath(value: unknown, label: string): string {
  const path = string(value, label);
  if (!path || path !== path.trim() || path.includes("\0") || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/u.test(path)) throw new Error(`${label} must be a normalized workspace-relative path`);
  if (path.split("/").some(part => !part || part === "." || part === "..") || path.normalize("NFC") !== path) throw new Error(`${label} contains an unsafe segment`);
  return path;
}

function patchContent(value: unknown, label: string): string {
  const content = string(value, label);
  if (content.includes("\0")) throw new Error(`${label} must not contain NUL bytes`);
  if (Buffer.from(content, "utf8").toString("utf8") !== content) throw new Error(`${label} must round-trip as exact UTF-8 text`);
  return content;
}

function boundedUniquePaths(value: unknown, label: string, maxItems: number, allowRoot = false): string[] {
  const values = array(value, label);
  if (values.length > maxItems) throw new Error(`${label} may contain at most ${maxItems} paths`);
  const paths = values.map((item, index) => allowRoot && item === "" ? "" : patchPath(item, `${label}[${index}]`));
  if (new Set(paths).size !== paths.length) throw new Error(`${label} contains duplicates`);
  return paths;
}

function boundedUniqueStrings(value: unknown, label: string, maxItems: number): string[] {
  const values = array(value, label);
  if (values.length > maxItems) throw new Error(`${label} may contain at most ${maxItems} values`);
  const strings = values.map((item, index) => boundedId(item, `${label}[${index}]`));
  if (new Set(strings).size !== strings.length) throw new Error(`${label} contains duplicates`);
  return strings;
}

function boundedId(value: unknown, label: string): string {
  const result = nonEmptyString(value, label).trim();
  if (result.includes("\0") || [...result].length > 256) throw new Error(`${label} must contain at most 256 characters without NUL bytes`);
  return result;
}

function nonNegativeSafeInteger(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isSafeInteger(result) || result < 0) throw new Error(`${label} must be a non-negative safe integer`);
  return result;
}

function positiveSafeInteger(value: unknown, label: string): number {
  const result = finiteNumber(value, label);
  if (!Number.isSafeInteger(result) || result <= 0) throw new Error(`${label} must be a positive safe integer`);
  return result;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameStringSets(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every(value => right.includes(value));
}

function compareCanonical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashText(value: string): PatchHash {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

export function canonicalPatchHash(value: unknown): PatchHash {
  return hashText(JSON.stringify(canonical(value)));
}

function canonical(value: unknown): unknown {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value.replace(/\0/gu, " ");
  if (typeof value === "number") return Number.isFinite(value) ? (Object.is(value, -0) ? 0 : value) : null;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value === "object") return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map(key => [key, canonical((value as Record<string, unknown>)[key])]));
  return String(value);
}

function exactRecord(value: unknown, label: string, keys: readonly string[]): Record<string, unknown> {
  const input = record(value, label);
  const expected = new Set(keys);
  const actual = Object.keys(input);
  if (actual.some(key => !expected.has(key)) || keys.some(key => !(key in input))) throw new Error(`${label} fields are invalid`);
  return input;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function string(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value;
}

function nonEmptyString(value: unknown, label: string): string {
  const result = string(value, label);
  if (!result.trim()) throw new Error(`${label} must not be empty`);
  return result;
}

function finiteNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}

function patchHash(value: unknown, label: string): PatchHash {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a lowercase SHA-256 content hash`);
  return value as PatchHash;
}

function hexDigest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

function literal<T extends string>(value: unknown, expected: T, label: string): T {
  if (value !== expected) throw new Error(`${label} must be ${expected}`);
  return expected;
}
