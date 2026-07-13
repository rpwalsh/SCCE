import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";

export const PATCH_TRANSACTION_PLAN_SCHEMA = "yopp.patch-transaction-plan.v1" as const;
export const PATCH_TRANSACTION_RECEIPT_SCHEMA = "yopp.patch-transaction-receipt.v1" as const;
export const PATCH_TRANSACTION_SCOPE = "atomic-per-file-with-verified-transaction-rollback" as const;

export type PatchContentHash = `sha256:${string}`;
export type PatchOperationKind = "create" | "replace" | "delete";

export type PatchOperationInput =
  | { readonly kind: "create"; readonly path: string; readonly content: string }
  | { readonly kind: "replace"; readonly path: string; readonly baseContentHash: PatchContentHash; readonly content: string }
  | { readonly kind: "delete"; readonly path: string; readonly baseContentHash: PatchContentHash };

export type StructuredPatchOperation =
  | {
      readonly kind: "create";
      readonly path: string;
      readonly beforeContentHash: null;
      readonly afterContentHash: PatchContentHash;
      readonly content: string;
    }
  | {
      readonly kind: "replace";
      readonly path: string;
      readonly beforeContentHash: PatchContentHash;
      readonly afterContentHash: PatchContentHash;
      readonly content: string;
    }
  | {
      readonly kind: "delete";
      readonly path: string;
      readonly beforeContentHash: PatchContentHash;
      readonly afterContentHash: null;
    };

export interface PatchTransactionPlan {
  readonly schemaVersion: typeof PATCH_TRANSACTION_PLAN_SCHEMA;
  readonly operations: readonly StructuredPatchOperation[];
  readonly planHash: PatchContentHash;
}

export interface PatchValidationReceipt {
  readonly validatorId: string;
  readonly evidenceHash: PatchContentHash;
}

export interface PatchMutationReceipt {
  readonly schemaVersion: "yopp.patch-mutation-receipt.v1";
  readonly planHash: PatchContentHash;
  readonly operationIndex: number;
  readonly kind: PatchOperationKind;
  readonly path: string;
  readonly beforeContentHash: PatchContentHash | null;
  readonly afterContentHash: PatchContentHash | null;
  readonly mutationHash: PatchContentHash;
}

export interface PatchTransactionReceipt {
  readonly schemaVersion: typeof PATCH_TRANSACTION_RECEIPT_SCHEMA;
  readonly transactionScope: typeof PATCH_TRANSACTION_SCOPE;
  readonly planHash: PatchContentHash;
  readonly validation: PatchValidationReceipt | null;
  readonly mutations: readonly PatchMutationReceipt[];
  readonly receiptHash: PatchContentHash;
}

export function hashPatchContent(content: string | Uint8Array, hasher: Hasher = createHasher()): PatchContentHash {
  return asSha256(hasher.digestHex(content));
}

export function createPatchTransactionPlan(
  input: { readonly operations: readonly PatchOperationInput[] },
  hasher: Hasher = createHasher()
): PatchTransactionPlan {
  if (input.operations.length === 0) throw new Error("patch transaction requires at least one operation");
  const operations = input.operations.map(operation => normalizeOperation(operation, hasher));
  operations.sort((a, b) => compareCanonical(a.path, b.path) || compareCanonical(a.kind, b.kind));
  const paths = new Set<string>();
  for (const operation of operations) {
    if (paths.has(operation.path)) throw new Error(`patch transaction contains duplicate path: ${operation.path}`);
    paths.add(operation.path);
  }
  const payload = { schemaVersion: PATCH_TRANSACTION_PLAN_SCHEMA, operations };
  return deepFreeze({ ...payload, planHash: hashCanonical(payload, hasher) });
}

export function verifyPatchTransactionPlan(plan: PatchTransactionPlan, hasher: Hasher = createHasher()): void {
  if (plan.schemaVersion !== PATCH_TRANSACTION_PLAN_SCHEMA) throw new Error(`unsupported patch plan schema: ${plan.schemaVersion}`);
  const rebuilt = createPatchTransactionPlan({
    operations: plan.operations.map(operation => {
      if (operation.kind === "create") return { kind: "create", path: operation.path, content: operation.content };
      if (operation.kind === "replace") return { kind: "replace", path: operation.path, baseContentHash: operation.beforeContentHash, content: operation.content };
      return { kind: "delete", path: operation.path, baseContentHash: operation.beforeContentHash };
    })
  }, hasher);
  if (rebuilt.planHash !== plan.planHash || canonicalStringify(rebuilt.operations) !== canonicalStringify(plan.operations)) {
    throw new Error("patch transaction plan hash or derived content hashes are invalid");
  }
}

export function createPatchValidationReceipt(
  input: { readonly validatorId: string; readonly evidence: unknown },
  hasher: Hasher = createHasher()
): PatchValidationReceipt {
  const validatorId = input.validatorId.trim();
  if (!validatorId) throw new Error("patch validation receipt requires a validator id");
  return deepFreeze({ validatorId, evidenceHash: hashCanonical(input.evidence, hasher) });
}

export function createPatchMutationReceipt(
  input: {
    readonly planHash: PatchContentHash;
    readonly operationIndex: number;
    readonly operation: StructuredPatchOperation;
    readonly beforeContentHash: PatchContentHash | null;
    readonly afterContentHash: PatchContentHash | null;
  },
  hasher: Hasher = createHasher()
): PatchMutationReceipt {
  if (input.beforeContentHash !== input.operation.beforeContentHash || input.afterContentHash !== input.operation.afterContentHash) {
    throw new Error(`mutation receipt does not match the plan for ${input.operation.path}`);
  }
  const payload = {
    schemaVersion: "yopp.patch-mutation-receipt.v1" as const,
    planHash: input.planHash,
    operationIndex: input.operationIndex,
    kind: input.operation.kind,
    path: input.operation.path,
    beforeContentHash: input.beforeContentHash,
    afterContentHash: input.afterContentHash
  };
  return deepFreeze({ ...payload, mutationHash: hashCanonical(payload, hasher) });
}

export function createPatchTransactionReceipt(
  input: {
    readonly planHash: PatchContentHash;
    readonly validation?: PatchValidationReceipt;
    readonly mutations: readonly PatchMutationReceipt[];
  },
  hasher: Hasher = createHasher()
): PatchTransactionReceipt {
  const mutations = [...input.mutations];
  const indexes = mutations.map(item => item.operationIndex);
  if (indexes.some((value, index) => value !== index)) throw new Error("patch mutation receipts must be complete and ordered");
  if (mutations.some(item => item.planHash !== input.planHash)) throw new Error("patch mutation receipt belongs to another plan");
  const payload = {
    schemaVersion: PATCH_TRANSACTION_RECEIPT_SCHEMA,
    transactionScope: PATCH_TRANSACTION_SCOPE,
    planHash: input.planHash,
    validation: input.validation ?? null,
    mutations
  };
  return deepFreeze({ ...payload, receiptHash: hashCanonical(payload, hasher) });
}

function normalizeOperation(operation: PatchOperationInput, hasher: Hasher): StructuredPatchOperation {
  const path = validatePatchPath(operation.path);
  if (operation.kind === "create") {
    return { kind: "create", path, beforeContentHash: null, afterContentHash: hashPatchContent(operation.content, hasher), content: operation.content };
  }
  validateContentHash(operation.baseContentHash);
  if (operation.kind === "replace") {
    return {
      kind: "replace",
      path,
      beforeContentHash: operation.baseContentHash,
      afterContentHash: hashPatchContent(operation.content, hasher),
      content: operation.content
    };
  }
  return { kind: "delete", path, beforeContentHash: operation.baseContentHash, afterContentHash: null };
}

function validatePatchPath(value: string): string {
  if (!value || value !== value.trim() || value.includes("\u0000") || value.includes("\\")) throw new Error(`invalid patch path: ${JSON.stringify(value)}`);
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) throw new Error(`patch path must be workspace relative: ${value}`);
  const parts = value.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) throw new Error(`patch path contains an unsafe segment: ${value}`);
  if (value.normalize("NFC") !== value) throw new Error(`patch path must use NFC normalization: ${value}`);
  return value;
}

function validateContentHash(value: string): asserts value is PatchContentHash {
  if (!/^sha256:[0-9a-f]{64}$/.test(value)) throw new Error(`invalid SHA-256 content hash: ${value}`);
}

function asSha256(value: string): PatchContentHash {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("patch transaction hasher must return a lowercase SHA-256 hex digest");
  return `sha256:${value}`;
}

function hashCanonical(value: unknown, hasher: Hasher): PatchContentHash {
  return asSha256(hasher.digestHex(canonicalStringify(value)));
}

function compareCanonical(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
