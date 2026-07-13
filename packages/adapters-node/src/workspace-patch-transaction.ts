import { constants } from "node:fs";
import {
  copyFile,
  link,
  lstat,
  open,
  readFile,
  realpath,
  rename,
  rm,
  unlink
} from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  createPatchMutationReceipt,
  createPatchTransactionReceipt,
  createPatchValidationReceipt,
  hashPatchContent,
  verifyPatchTransactionPlan,
  type PatchContentHash,
  type PatchMutationReceipt,
  type PatchTransactionPlan,
  type PatchTransactionReceipt,
  type PatchValidationReceipt,
  type StructuredPatchOperation
} from "@scce/kernel";

export type WorkspacePatchErrorCode =
  | "INVALID_PLAN"
  | "WORKSPACE_ESCAPE"
  | "SYMLINK_REFUSED"
  | "INVALID_TARGET"
  | "ASSERTION_FILE_PROTECTED"
  | "DRIFT_DETECTED"
  | "VALIDATION_FAILED"
  | "COMMIT_FAILED"
  | "ROLLBACK_FAILED";

export interface WorkspacePatchValidationView {
  readonly plan: PatchTransactionPlan;
  readFile(path: string): Promise<Uint8Array | undefined>;
  readText(path: string): Promise<string | undefined>;
}

export interface WorkspacePatchValidationResult {
  readonly ok: boolean;
  readonly validatorId: string;
  readonly evidence: unknown;
}

export interface WorkspacePatchRollbackReport {
  readonly attemptedPaths: readonly string[];
  readonly restoredPaths: readonly string[];
  readonly failures: readonly { readonly path: string; readonly message: string }[];
}

export class WorkspacePatchTransactionError extends Error {
  readonly code: WorkspacePatchErrorCode;
  readonly planHash?: PatchContentHash;
  readonly rollback: WorkspacePatchRollbackReport;

  constructor(input: {
    code: WorkspacePatchErrorCode;
    message: string;
    planHash?: PatchContentHash;
    cause?: unknown;
    rollback?: WorkspacePatchRollbackReport;
  }) {
    super(input.message, input.cause === undefined ? undefined : { cause: input.cause });
    this.name = "WorkspacePatchTransactionError";
    this.code = input.code;
    this.planHash = input.planHash;
    this.rollback = deepFreeze(input.rollback ?? { attemptedPaths: [], restoredPaths: [], failures: [] });
  }
}

export interface WorkspacePatchTransactionOptions {
  readonly workspaceRoot: string;
  readonly plan: PatchTransactionPlan;
  readonly validate?: (view: WorkspacePatchValidationView) => WorkspacePatchValidationResult | Promise<WorkspacePatchValidationResult>;
  /** Test-only deterministic failure seam. Production callers should omit it. */
  readonly testFailpoint?: (event: { readonly phase: "beforeApply" | "afterApply"; readonly operationIndex: number; readonly path: string }) => void | Promise<void>;
}

interface PreparedOperation {
  readonly index: number;
  readonly operation: StructuredPatchOperation;
  readonly targetPath: string;
  readonly backupPath: string;
  stagePath?: string;
}

interface AppliedOperation {
  readonly prepared: PreparedOperation;
  readonly receipt: PatchMutationReceipt;
}

/**
 * Applies a deterministic patch plan inside one canonical workspace root.
 *
 * Each create/delete/replace changes its target path atomically. Node does not
 * expose a portable multi-file rename transaction, so transaction scope is the
 * explicitly reported set of per-file mutations plus verified reverse-order
 * rollback if a later mutation fails.
 */
export async function executeWorkspacePatchTransaction(options: WorkspacePatchTransactionOptions): Promise<PatchTransactionReceipt> {
  try {
    verifyPatchTransactionPlan(options.plan);
  } catch (cause) {
    throw new WorkspacePatchTransactionError({ code: "INVALID_PLAN", message: errorMessage(cause), cause });
  }

  const root = await canonicalWorkspaceRoot(options.workspaceRoot, options.plan.planHash);
  const prepared: PreparedOperation[] = [];
  const applied: AppliedOperation[] = [];
  let validationReceipt: PatchValidationReceipt | undefined;

  try {
    for (let index = 0; index < options.plan.operations.length; index += 1) {
      const operation = options.plan.operations[index];
      if (!operation) throw new Error(`missing operation at index ${index}`);
      if (operation.kind !== "create" && isAssertionFile(operation.path)) {
        fail("ASSERTION_FILE_PROTECTED", `existing assertion file is immutable in a patch transaction: ${operation.path}`, options.plan.planHash);
      }
      const targetPath = await resolveSecureTarget(root, operation.path, operation.kind === "create", options.plan.planHash);
      await assertBaseState(targetPath, operation, options.plan.planHash);
      const entry: PreparedOperation = {
        index,
        operation,
        targetPath,
        backupPath: temporarySibling(targetPath, options.plan.planHash, index, "backup")
      };
      if (operation.kind !== "delete") {
        entry.stagePath = temporarySibling(targetPath, options.plan.planHash, index, "stage");
        const originalMode = operation.kind === "replace" ? (await lstat(targetPath)).mode & 0o777 : 0o600;
        await writeExclusiveSynced(entry.stagePath, operation.content, originalMode);
        const stagedHash = hashPatchContent(await readFile(entry.stagePath));
        if (stagedHash !== operation.afterContentHash) {
          fail("COMMIT_FAILED", `staged content hash mismatch for ${operation.path}`, options.plan.planHash);
        }
      }
      prepared.push(entry);
    }

    if (options.validate) {
      const result = await options.validate(createValidationView(root, options.plan, prepared));
      if (!result.ok) fail("VALIDATION_FAILED", `targeted validation failed: ${result.validatorId}`, options.plan.planHash);
      validationReceipt = createPatchValidationReceipt({ validatorId: result.validatorId, evidence: result.evidence });
    }

    // Recheck the whole compare-and-set immediately before the first mutation.
    for (const entry of prepared) {
      await resolveSecureTarget(root, entry.operation.path, entry.operation.kind === "create", options.plan.planHash);
      await assertBaseState(entry.targetPath, entry.operation, options.plan.planHash);
    }

    for (const entry of prepared) {
      // A per-operation check narrows the race window after earlier operations.
      await resolveSecureTarget(root, entry.operation.path, entry.operation.kind === "create", options.plan.planHash);
      await assertBaseState(entry.targetPath, entry.operation, options.plan.planHash);
      await options.testFailpoint?.({ phase: "beforeApply", operationIndex: entry.index, path: entry.operation.path });
      await applyPrepared(entry, options.plan.planHash);
      const receipt = createPatchMutationReceipt({
        planHash: options.plan.planHash,
        operationIndex: entry.index,
        operation: entry.operation,
        beforeContentHash: entry.operation.beforeContentHash,
        afterContentHash: entry.operation.afterContentHash
      });
      applied.push({ prepared: entry, receipt });
      await options.testFailpoint?.({ phase: "afterApply", operationIndex: entry.index, path: entry.operation.path });
    }

    await verifyCommitted(applied, options.plan.planHash);
    const receipt = createPatchTransactionReceipt({
      planHash: options.plan.planHash,
      validation: validationReceipt,
      mutations: applied.map(item => item.receipt)
    });
    await cleanupPrepared(prepared);
    return receipt;
  } catch (cause) {
    const rollback = await rollbackApplied(applied, options.plan.planHash);
    await cleanupPrepared(prepared);
    const originalCode = cause instanceof WorkspacePatchTransactionError ? cause.code : "COMMIT_FAILED";
    const code = rollback.failures.length > 0 ? "ROLLBACK_FAILED" : originalCode;
    throw new WorkspacePatchTransactionError({
      code,
      message: rollback.failures.length > 0
        ? `patch transaction failed and rollback was incomplete: ${errorMessage(cause)}`
        : errorMessage(cause),
      planHash: options.plan.planHash,
      cause,
      rollback
    });
  }
}

async function applyPrepared(entry: PreparedOperation, planHash: PatchContentHash): Promise<void> {
  const { operation, targetPath, backupPath } = entry;
  if (operation.kind === "create") {
    const stagePath = requiredStage(entry);
    try {
      await link(stagePath, targetPath); // exclusive: refuses a concurrent create
    } catch (cause) {
      fail("DRIFT_DETECTED", `create target appeared before commit: ${operation.path}`, planHash, cause);
    }
    // Keep the staged hard-link until the transaction either commits or rolls
    // back. That leaves no fallible async step between the target mutation and
    // recording it in the applied set.
    return;
  }

  if (operation.kind === "replace") {
    await copyFile(targetPath, backupPath, constants.COPYFILE_EXCL);
    const backupHash = hashPatchContent(await readFile(backupPath));
    if (backupHash !== operation.beforeContentHash) fail("DRIFT_DETECTED", `base drifted while backing up ${operation.path}`, planHash);
    await assertBaseState(targetPath, operation, planHash);
    await rename(requiredStage(entry), targetPath); // atomic replacement of this path
    entry.stagePath = undefined;
    return;
  }

  await rename(targetPath, backupPath); // atomic removal of this path
}

async function rollbackApplied(applied: readonly AppliedOperation[], planHash: PatchContentHash): Promise<WorkspacePatchRollbackReport> {
  const attemptedPaths: string[] = [];
  const restoredPaths: string[] = [];
  const failures: Array<{ path: string; message: string }> = [];
  for (const item of [...applied].reverse()) {
    const { prepared } = item;
    const { operation, targetPath, backupPath } = prepared;
    attemptedPaths.push(operation.path);
    try {
      if (operation.kind === "create") {
        await assertCurrentHash(targetPath, operation.afterContentHash, operation.path, planHash);
        await unlink(targetPath);
      } else if (operation.kind === "replace") {
        await assertCurrentHash(targetPath, operation.afterContentHash, operation.path, planHash);
        await rename(backupPath, targetPath);
        await assertCurrentHash(targetPath, operation.beforeContentHash, operation.path, planHash);
      } else {
        if (await pathExists(targetPath)) fail("ROLLBACK_FAILED", `delete rollback target is occupied: ${operation.path}`, planHash);
        await link(backupPath, targetPath);
        await unlink(backupPath);
        await assertCurrentHash(targetPath, operation.beforeContentHash, operation.path, planHash);
      }
      restoredPaths.push(operation.path);
    } catch (cause) {
      failures.push({ path: operation.path, message: errorMessage(cause) });
    }
  }
  return deepFreeze({ attemptedPaths, restoredPaths, failures });
}

async function verifyCommitted(applied: readonly AppliedOperation[], planHash: PatchContentHash): Promise<void> {
  for (const { prepared } of applied) {
    const { operation, targetPath } = prepared;
    if (operation.kind === "delete") {
      if (await pathExists(targetPath)) fail("COMMIT_FAILED", `deleted path still exists: ${operation.path}`, planHash);
    } else {
      await assertCurrentHash(targetPath, operation.afterContentHash, operation.path, planHash);
    }
  }
}

async function assertBaseState(targetPath: string, operation: StructuredPatchOperation, planHash: PatchContentHash): Promise<void> {
  if (operation.kind === "create") {
    if (await pathExists(targetPath)) fail("DRIFT_DETECTED", `create target already exists: ${operation.path}`, planHash);
    return;
  }
  await assertCurrentHash(targetPath, operation.beforeContentHash, operation.path, planHash);
}

async function assertCurrentHash(targetPath: string, expected: PatchContentHash, displayPath: string, planHash: PatchContentHash): Promise<void> {
  let stat;
  try {
    stat = await lstat(targetPath);
  } catch (cause) {
    fail("DRIFT_DETECTED", `expected file is missing: ${displayPath}`, planHash, cause);
  }
  if (stat.isSymbolicLink()) fail("SYMLINK_REFUSED", `symbolic-link target refused: ${displayPath}`, planHash);
  if (!stat.isFile()) fail("INVALID_TARGET", `patch target is not a regular file: ${displayPath}`, planHash);
  const actual = hashPatchContent(await readFile(targetPath));
  if (actual !== expected) fail("DRIFT_DETECTED", `content drift detected for ${displayPath}: expected ${expected}, found ${actual}`, planHash);
}

async function canonicalWorkspaceRoot(input: string, planHash: PatchContentHash): Promise<string> {
  let root: string;
  try {
    root = await realpath(resolve(input));
  } catch (cause) {
    fail("INVALID_TARGET", `workspace root cannot be resolved: ${input}`, planHash, cause);
  }
  const stat = await lstat(root);
  if (!stat.isDirectory()) fail("INVALID_TARGET", `workspace root is not a directory: ${root}`, planHash);
  return root;
}

async function resolveSecureTarget(root: string, workspacePath: string, allowMissingTarget: boolean, planHash: PatchContentHash): Promise<string> {
  const target = resolve(root, ...workspacePath.split("/"));
  const relativeTarget = relative(root, target);
  if (!relativeTarget || relativeTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || relativeTarget === ".." || isAbsolute(relativeTarget)) {
    fail("WORKSPACE_ESCAPE", `patch path escapes the workspace: ${workspacePath}`, planHash);
  }

  const parts = workspacePath.split("/");
  let cursor = root;
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (!part) fail("WORKSPACE_ESCAPE", `unsafe patch path: ${workspacePath}`, planHash);
    cursor = join(cursor, part);
    const targetSegment = index === parts.length - 1;
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) fail("SYMLINK_REFUSED", `symbolic-link path segment refused: ${workspacePath}`, planHash);
      if (!targetSegment && !stat.isDirectory()) fail("INVALID_TARGET", `patch parent is not a directory: ${workspacePath}`, planHash);
    } catch (cause) {
      if (isMissing(cause) && targetSegment && allowMissingTarget) break;
      if (cause instanceof WorkspacePatchTransactionError) throw cause;
      fail("INVALID_TARGET", `patch path cannot be resolved: ${workspacePath}`, planHash, cause);
    }
  }

  const canonicalParent = await realpath(dirname(target));
  const parentRelative = relative(root, canonicalParent);
  if (parentRelative === ".." || parentRelative.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(parentRelative)) {
    fail("WORKSPACE_ESCAPE", `resolved patch parent escapes the workspace: ${workspacePath}`, planHash);
  }
  return target;
}

function createValidationView(root: string, plan: PatchTransactionPlan, prepared: readonly PreparedOperation[]): WorkspacePatchValidationView {
  const byPath = new Map(prepared.map(item => [item.operation.path, item]));
  const read = async (workspacePath: string): Promise<Uint8Array | undefined> => {
    const staged = byPath.get(workspacePath);
    if (staged?.operation.kind === "delete") return undefined;
    if (staged?.stagePath) return new Uint8Array(await readFile(staged.stagePath));
    const target = await resolveSecureTarget(root, workspacePath, false, plan.planHash);
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("INVALID_TARGET", `validation read refused: ${workspacePath}`, plan.planHash);
    return new Uint8Array(await readFile(target));
  };
  return deepFreeze({
    plan,
    readFile: read,
    async readText(path: string) {
      const bytes = await read(path);
      return bytes === undefined ? undefined : Buffer.from(bytes).toString("utf8");
    }
  });
}

async function writeExclusiveSynced(filePath: string, content: string, mode: number): Promise<void> {
  const handle = await open(filePath, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function cleanupPrepared(prepared: readonly PreparedOperation[]): Promise<void> {
  await Promise.all(prepared.flatMap(item => [item.stagePath, item.backupPath]
    .filter((value): value is string => Boolean(value))
    .map(value => rm(value, { force: true }).catch(() => undefined))));
}

function temporarySibling(targetPath: string, planHash: PatchContentHash, index: number, suffix: "stage" | "backup"): string {
  const token = randomBytes(12).toString("hex");
  return join(dirname(targetPath), `.${basename(targetPath)}.yopp-${planHash.slice(7, 19)}-${index}-${token}.${suffix}`);
}

function requiredStage(entry: PreparedOperation): string {
  if (!entry.stagePath) throw new Error(`missing staged content for ${entry.operation.path}`);
  return entry.stagePath;
}

function isAssertionFile(path: string): boolean {
  return /(^|\/)(?:__tests__|tests?|spec)(?:\/|$)/i.test(path) || /\.(?:test|spec)\.[^/]+$/i.test(path);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (cause) {
    if (isMissing(cause)) return false;
    throw cause;
  }
}

function isMissing(cause: unknown): boolean {
  return typeof cause === "object" && cause !== null && "code" in cause && (cause as { code?: string }).code === "ENOENT";
}

function fail(code: WorkspacePatchErrorCode, message: string, planHash?: PatchContentHash, cause?: unknown): never {
  throw new WorkspacePatchTransactionError({ code, message, planHash, cause });
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
