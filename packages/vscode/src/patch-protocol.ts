import { createHash } from "node:crypto";

export const PATCH_PLAN_SCHEMA = "yopp.patch-transaction-plan.v1" as const;
export const WORKSPACE_PATCH_REQUEST_SCHEMA = "yopp.workspace-patch-request.v1" as const;
export const WORKSPACE_PATCH_RESPONSE_SCHEMA = "yopp.workspace-patch-response.v1" as const;
export const WORKSPACE_CODING_PATCH_PLAN_REQUEST_SCHEMA = "scce.workspace-coding-patch-plan-request.v1" as const;
export const WORKSPACE_PLAN_GENERATION_SCHEMA = "yopp.workspace-plan-generation.v1" as const;
export const WORKSPACE_PROGRAM_PROPOSAL_TRACE_SCHEMA = "scce.workspace-program-proposal.trace.v1" as const;
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
  validationPlan: {
    validatorId: typeof DEFAULT_PATCH_VALIDATION_POLICY_ID;
    checks: Array<(typeof DEFAULT_PATCH_VALIDATION_CHECKS)[number]>;
  };
}

export interface WorkspaceCodingPatchPlanGeneration {
  schemaVersion: typeof WORKSPACE_PLAN_GENERATION_SCHEMA;
  workspaceId: string;
  revisionId: string;
  revisionHash: PatchHash;
  plan: ReviewedPatchPlan;
  scoreTrace: Record<string, unknown>;
  safety: Record<string, unknown>;
  validationPlan: {
    validatorId: typeof DEFAULT_PATCH_VALIDATION_POLICY_ID;
    checks: Array<(typeof DEFAULT_PATCH_VALIDATION_CHECKS)[number]>;
  };
  authorization: { required: true; granted: false; capabilityId: "workspace.patch.apply" };
  execution: { state: "not_executed"; receipt: null };
  rollbackScope: "atomic-per-file-with-verified-transaction-rollback";
  programProposalTrace: {
    schemaVersion: typeof WORKSPACE_PROGRAM_PROPOSAL_TRACE_SCHEMA;
    source: "program-graph-full-file";
    requestId: string;
    requestHash: PatchHash;
    programId: string;
    sourcePlanIds: string[];
    evidenceIds: string[];
    requestedPaths: string[];
    derivedDependencyPaths: string[];
    selectedArtifactPaths: string[];
    regressionTestPaths: string[];
    verifiedParentDirectoryPaths: string[];
    hydrationValidated: true;
    fullFileMaterialized: true;
  };
}

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

export function parseWorkspaceCodingPatchPlanGeneration(value: unknown): WorkspaceCodingPatchPlanGeneration {
  const input = exactRecord(value, "workspace coding patch plan generation", [
    "schemaVersion",
    "workspaceId",
    "revisionId",
    "revisionHash",
    "plan",
    "scoreTrace",
    "safety",
    "validationPlan",
    "authorization",
    "execution",
    "rollbackScope",
    "programProposalTrace"
  ]);
  const validationPlan = parseCodingValidationPlan(input.validationPlan);
  const authorization = exactRecord(input.authorization, "coding plan authorization", ["required", "granted", "capabilityId"]);
  if (authorization.required !== true || authorization.granted !== false) throw new Error("coding plan must be returned unauthorized");
  const execution = exactRecord(input.execution, "coding plan execution", ["state", "receipt"]);
  literal(execution.state, "not_executed", "coding plan execution state");
  if (execution.receipt !== null) throw new Error("coding plan must be returned unexecuted");
  const trace = exactRecord(input.programProposalTrace, "program proposal trace", [
    "schemaVersion",
    "source",
    "requestId",
    "requestHash",
    "programId",
    "sourcePlanIds",
    "evidenceIds",
    "requestedPaths",
    "derivedDependencyPaths",
    "selectedArtifactPaths",
    "regressionTestPaths",
    "verifiedParentDirectoryPaths",
    "hydrationValidated",
    "fullFileMaterialized"
  ]);
  if (trace.hydrationValidated !== true || trace.fullFileMaterialized !== true) throw new Error("coding plan is not a fully hydrated full-file proposal");
  return {
    schemaVersion: literal(input.schemaVersion, WORKSPACE_PLAN_GENERATION_SCHEMA, "coding plan generation schema"),
    workspaceId: boundedId(input.workspaceId, "coding plan workspaceId"),
    revisionId: boundedId(input.revisionId, "coding plan revisionId"),
    revisionHash: patchHash(input.revisionHash, "coding plan revisionHash"),
    plan: parseReviewedPatchPlan(input.plan),
    scoreTrace: record(input.scoreTrace, "coding plan scoreTrace"),
    safety: record(input.safety, "coding plan safety"),
    validationPlan,
    authorization: {
      required: true,
      granted: false,
      capabilityId: literal(authorization.capabilityId, "workspace.patch.apply", "coding plan authorization capabilityId")
    },
    execution: { state: "not_executed", receipt: null },
    rollbackScope: literal(input.rollbackScope, "atomic-per-file-with-verified-transaction-rollback", "coding plan rollbackScope"),
    programProposalTrace: {
      schemaVersion: literal(trace.schemaVersion, WORKSPACE_PROGRAM_PROPOSAL_TRACE_SCHEMA, "program proposal trace schema"),
      source: literal(trace.source, "program-graph-full-file", "program proposal trace source"),
      requestId: boundedId(trace.requestId, "program proposal trace requestId"),
      requestHash: patchHash(trace.requestHash, "program proposal trace requestHash"),
      programId: boundedId(trace.programId, "program proposal trace programId"),
      sourcePlanIds: boundedUniqueStrings(trace.sourcePlanIds, "program proposal trace sourcePlanIds", 4096),
      evidenceIds: boundedUniqueStrings(trace.evidenceIds, "program proposal trace evidenceIds", 4096),
      requestedPaths: boundedUniquePaths(trace.requestedPaths, "program proposal trace requestedPaths", 256),
      derivedDependencyPaths: boundedUniquePaths(trace.derivedDependencyPaths, "program proposal trace derivedDependencyPaths", 256),
      selectedArtifactPaths: boundedUniquePaths(trace.selectedArtifactPaths, "program proposal trace selectedArtifactPaths", 256),
      regressionTestPaths: boundedUniquePaths(trace.regressionTestPaths, "program proposal trace regressionTestPaths", 256),
      verifiedParentDirectoryPaths: boundedUniquePaths(trace.verifiedParentDirectoryPaths, "program proposal trace verifiedParentDirectoryPaths", 256, true),
      hydrationValidated: true,
      fullFileMaterialized: true
    }
  };
}

export function verifyWorkspaceCodingPatchPlanGeneration(
  result: WorkspaceCodingPatchPlanGeneration,
  request: WorkspaceCodingPatchPlanRequest
): WorkspaceCodingPatchPlanGeneration {
  if (result.workspaceId !== request.workspaceId) throw new Error("coding plan belongs to another workspace");
  if (result.programProposalTrace.requestId !== request.requestId) throw new Error("coding plan belongs to another request");
  if (!sameStrings(result.programProposalTrace.requestedPaths, request.requestedPaths)) throw new Error("coding plan requested paths do not match the submitted scope");
  if (result.validationPlan.validatorId !== request.validationPlan.validatorId || !sameStringSets(result.validationPlan.checks, request.validationPlan.checks)) {
    throw new Error("coding plan validation policy does not match the submitted request");
  }
  const selectedArtifacts = new Set(result.programProposalTrace.selectedArtifactPaths);
  for (const operation of result.plan.operations) {
    if (!selectedArtifacts.has(operation.path)) throw new Error(`coding plan operation is absent from the selected artifact trace: ${operation.path}`);
  }
  const expectedRequestHash = canonicalPatchHash({
    requestId: request.requestId,
    text: request.requestText,
    requestedPaths: request.requestedPaths,
    evidenceIds: result.programProposalTrace.evidenceIds,
    revisionId: result.revisionId,
    revisionHash: result.revisionHash
  });
  if (result.programProposalTrace.requestHash !== expectedRequestHash) throw new Error(`coding plan request trace does not match its content; expected ${expectedRequestHash}`);
  return result;
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

function parseCodingValidationPlan(value: unknown): WorkspaceCodingPatchPlanGeneration["validationPlan"] {
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
