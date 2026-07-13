import { createHash } from "node:crypto";

export const PATCH_PLAN_SCHEMA = "yopp.patch-transaction-plan.v1" as const;
export const WORKSPACE_PATCH_REQUEST_SCHEMA = "yopp.workspace-patch-request.v1" as const;
export const WORKSPACE_PATCH_RESPONSE_SCHEMA = "yopp.workspace-patch-response.v1" as const;
export const DEFAULT_PATCH_VALIDATION_POLICY_ID = "trusted-host-pnpm-validate.v1" as const;

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
  workspace: { id: string; rootPath: string };
  sources: unknown[];
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
    validation: { validatorId: string; evidenceHash: PatchHash } | null;
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
  const expected = hashCanonical({ schemaVersion: PATCH_PLAN_SCHEMA, operations });
  if (planHash !== expected) throw new Error(`patch plan content does not match planHash; expected ${expected}`);
  return { schemaVersion: PATCH_PLAN_SCHEMA, operations, planHash };
}

export function parseWorkspaceStatus(value: unknown): WorkspaceStatusResponse {
  const input = record(value, "workspace status");
  const workspace = record(input.workspace, "workspace status workspace");
  return {
    workspace: { id: nonEmptyString(workspace.id, "workspace id"), rootPath: nonEmptyString(workspace.rootPath, "workspace rootPath") },
    sources: array(input.sources, "workspace sources")
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
  const expectedReceiptHash = hashCanonical({ schemaVersion: "yopp.patch-transaction-receipt.v1", transactionScope, planHash, validation, mutations });
  if (receiptHash !== expectedReceiptHash) throw new Error(`workspace patch receipt content does not match receiptHash; expected ${expectedReceiptHash}`);
  return {
    schemaVersion: WORKSPACE_PATCH_RESPONSE_SCHEMA,
    workspaceId: nonEmptyString(input.workspaceId, "workspace patch workspaceId"),
    validationPolicyId: nonEmptyString(input.validationPolicyId, "workspace patch validationPolicyId"),
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

function parseValidationReceipt(value: unknown): { validatorId: string; evidenceHash: PatchHash } | null {
  if (value === null) return null;
  const input = exactRecord(value, "patch validation receipt", ["validatorId", "evidenceHash"]);
  return { validatorId: nonEmptyString(input.validatorId, "validation validatorId"), evidenceHash: patchHash(input.evidenceHash, "validation evidenceHash") };
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
  const expectedMutationHash = hashCanonical(payload);
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
    const content = string(input.content, `patch operation ${index} content`);
    const afterContentHash = patchHash(input.afterContentHash, `patch operation ${index} afterContentHash`);
    if (afterContentHash !== hashText(content)) throw new Error(`patch operation ${index} content hash does not match afterContentHash`);
    return { kind, path, beforeContentHash: null, afterContentHash, content };
  }
  if (kind === "replace") {
    const content = string(input.content, `patch operation ${index} content`);
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

function hashText(value: string): PatchHash {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}

function hashCanonical(value: unknown): PatchHash {
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
