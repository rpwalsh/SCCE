import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
  canonicalPatchHash,
  type AppliedWorkspacePatch,
  type PatchHash,
  type ReviewedPatchPlan
} from "./patch-protocol.js";

export const PATCH_TRANSACTION_SCOPE = "atomic-per-file-with-verified-transaction-rollback" as const;

export interface WorkspacePhysicalBinding {
  resolvedRoot: string;
  realRoot: string;
  deviceId: string;
  fileId: string;
}

export function verifyAppliedPatchMatchesPlan(
  applied: AppliedWorkspacePatch,
  plan: ReviewedPatchPlan
): AppliedWorkspacePatch {
  if (applied.receipt.validation.validatorId !== applied.validationPolicyId) {
    throw new Error("patch receipt validation does not match the applied validation policy");
  }
  const expectedPlanHash = canonicalPatchHash({ schemaVersion: plan.schemaVersion, operations: plan.operations });
  if (plan.planHash !== expectedPlanHash) throw new Error(`reviewed patch plan content does not match planHash; expected ${expectedPlanHash}`);
  if (applied.receipt.planHash !== plan.planHash) {
    throw new Error("patch receipt belongs to a different reviewed plan");
  }
  if (applied.receipt.mutations.length !== plan.operations.length) {
    throw new Error(`patch receipt mutation count does not match the reviewed plan; expected ${plan.operations.length}, found ${applied.receipt.mutations.length}`);
  }
  for (let index = 0; index < plan.operations.length; index += 1) {
    const operation = plan.operations[index];
    const mutation = applied.receipt.mutations[index];
    if (!operation || !mutation) throw new Error(`patch receipt is missing reviewed operation ${index}`);
    if (mutation.operationIndex !== index) throw new Error(`patch receipt mutation ${index} has the wrong operation index`);
    if (mutation.planHash !== plan.planHash) throw new Error(`patch receipt mutation ${index} belongs to a different reviewed plan`);
    if (mutation.path !== operation.path) throw new Error(`patch receipt mutation ${index} path does not match the reviewed operation`);
    if (mutation.kind !== operation.kind) throw new Error(`patch receipt mutation ${index} kind does not match the reviewed operation`);
    if (mutation.beforeContentHash !== operation.beforeContentHash) {
      throw new Error(`patch receipt mutation ${index} before-content hash does not match the reviewed operation`);
    }
    if (mutation.afterContentHash !== operation.afterContentHash) {
      throw new Error(`patch receipt mutation ${index} after-content hash does not match the reviewed operation`);
    }
    const expectedMutationHash = canonicalPatchHash({
      schemaVersion: mutation.schemaVersion,
      planHash: mutation.planHash,
      operationIndex: mutation.operationIndex,
      kind: mutation.kind,
      path: mutation.path,
      beforeContentHash: mutation.beforeContentHash,
      afterContentHash: mutation.afterContentHash
    });
    if (mutation.mutationHash !== expectedMutationHash) {
      throw new Error(`patch receipt mutation ${index} content does not match mutationHash; expected ${expectedMutationHash}`);
    }
  }
  const expectedReceiptHash = canonicalPatchHash({
    schemaVersion: applied.receipt.schemaVersion,
    transactionScope: applied.receipt.transactionScope,
    planHash: applied.receipt.planHash,
    validation: applied.receipt.validation,
    mutations: applied.receipt.mutations
  });
  if (applied.receipt.receiptHash !== expectedReceiptHash) {
    throw new Error(`patch receipt content does not match receiptHash; expected ${expectedReceiptHash}`);
  }
  return applied;
}

export async function captureWorkspacePhysicalBinding(rootPath: string): Promise<WorkspacePhysicalBinding> {
  const resolvedRoot = resolve(rootPath);
  const direct = await lstat(resolvedRoot, { bigint: true });
  if (direct.isSymbolicLink()) throw new Error("the open workspace root must not be a symbolic link or junction");
  if (!direct.isDirectory()) throw new Error("the open workspace root is not a directory");
  const realRoot = await realpath(resolvedRoot);
  const physical = await lstat(realRoot, { bigint: true });
  if (!physical.isDirectory() || physical.isSymbolicLink()) throw new Error("the canonical open workspace root is not a physical directory");
  return {
    resolvedRoot,
    realRoot,
    deviceId: physical.dev.toString(),
    fileId: physical.ino.toString()
  };
}

export async function assertWorkspacePhysicalBinding(binding: WorkspacePhysicalBinding): Promise<void> {
  const current = await captureWorkspacePhysicalBinding(binding.resolvedRoot);
  assertSameWorkspacePhysicalBinding(binding, current);
}

export function assertSameWorkspacePhysicalBinding(expected: WorkspacePhysicalBinding, actual: WorkspacePhysicalBinding): void {
  if (
    !sameFileSystemPath(expected.resolvedRoot, actual.resolvedRoot)
    || !sameFileSystemPath(expected.realRoot, actual.realRoot)
    || expected.deviceId !== actual.deviceId
    || expected.fileId !== actual.fileId
  ) {
    throw new Error("the open workspace physical binding changed after patch review");
  }
}

export async function readVerifiedWorkspaceFile(
  binding: WorkspacePhysicalBinding,
  workspacePath: string,
  expectedHash: PatchHash,
  phase: "preview" | "post-apply"
): Promise<Buffer> {
  await assertWorkspacePhysicalBinding(binding);
  const target = workspaceTarget(binding, workspacePath, phase);
  const before = await inspectExistingPath(binding, target, workspacePath, phase);
  const bytes = await readFile(target);
  const after = await inspectExistingPath(binding, target, workspacePath, phase);
  if (before.realPath !== after.realPath || !sameIdentities(before.identities, after.identities)) {
    throw new Error(`${phase} target identity changed while reading: ${workspacePath}`);
  }
  const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}` as PatchHash;
  if (actualHash !== expectedHash) {
    throw new Error(`${phase} content hash does not match the reviewed operation for ${workspacePath}; expected ${expectedHash}, found ${actualHash}`);
  }
  await assertWorkspacePhysicalBinding(binding);
  return bytes;
}

export async function assertWorkspacePathAbsent(
  binding: WorkspacePhysicalBinding,
  workspacePath: string,
  phase: "preview" | "post-apply"
): Promise<void> {
  await assertWorkspacePhysicalBinding(binding);
  const target = workspaceTarget(binding, workspacePath, phase);
  const parentInspection = await inspectExistingPath(binding, dirname(target), workspacePath, phase, false);
  if (!parentInspection.leafIsDirectory) throw new Error(`${phase} target parent is not a directory: ${workspacePath}`);
  try {
    await lstat(target);
    throw new Error(`${phase} ${phase === "preview" ? "create target already exists" : "delete target still exists"}: ${workspacePath}`);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
  const parentAfter = await inspectExistingPath(binding, dirname(target), workspacePath, phase, false);
  if (!sameIdentities(parentInspection.identities, parentAfter.identities)) {
    throw new Error(`${phase} target parent identity changed while proving absence: ${workspacePath}`);
  }
  await assertWorkspacePhysicalBinding(binding);
}

export async function verifyReviewedWorkspaceState(binding: WorkspacePhysicalBinding, plan: ReviewedPatchPlan): Promise<void> {
  for (const operation of plan.operations) {
    if (operation.kind === "create") await assertWorkspacePathAbsent(binding, operation.path, "preview");
    else await readVerifiedWorkspaceFile(binding, operation.path, operation.beforeContentHash, "preview");
  }
}

export async function verifyAppliedWorkspaceState(root: string | WorkspacePhysicalBinding, plan: ReviewedPatchPlan): Promise<void> {
  const binding = typeof root === "string" ? await captureWorkspacePhysicalBinding(root) : root;
  for (const operation of plan.operations) {
    if (operation.kind === "delete") {
      await assertWorkspacePathAbsent(binding, operation.path, "post-apply");
      continue;
    }
    await readVerifiedWorkspaceFile(binding, operation.path, operation.afterContentHash, "post-apply");
  }
  await assertWorkspacePhysicalBinding(binding);
}

export function reviewedPatchIntegritySummary(plan: ReviewedPatchPlan): string {
  let creates = 0;
  let replaces = 0;
  let deletes = 0;
  for (const operation of plan.operations) {
    if (operation.kind === "create") creates += 1;
    else if (operation.kind === "replace") replaces += 1;
    else deletes += 1;
  }
  return [
    `Operations: create=${creates}, replace=${replaces}, delete=${deletes}`,
    `Rollback scope: ${PATCH_TRANSACTION_SCOPE}`
  ].join("\n");
}

interface PathIdentity {
  path: string;
  deviceId: string;
  fileId: string;
  size: string;
  modifiedNs: string;
}

interface InspectedPath {
  realPath: string;
  identities: PathIdentity[];
  leafIsDirectory: boolean;
}

async function inspectExistingPath(
  binding: WorkspacePhysicalBinding,
  target: string,
  workspacePath: string,
  phase: "preview" | "post-apply",
  requireFile = true
): Promise<InspectedPath> {
  const relativePath = relative(binding.resolvedRoot, target);
  const segments = relativePath === "" ? [] : relativePath.split(/[\\/]/u);
  const identities: PathIdentity[] = [];
  let current = binding.resolvedRoot;
  for (let index = 0; index <= segments.length; index += 1) {
    if (index > 0) current = resolve(current, segments[index - 1]!);
    let stats;
    try {
      stats = await lstat(current, { bigint: true });
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) throw new Error(`${phase} target is missing: ${workspacePath}`);
      throw error;
    }
    if (stats.isSymbolicLink()) throw new Error(`${phase} path contains a symbolic link or junction: ${workspacePath}`);
    if (index < segments.length && !stats.isDirectory()) throw new Error(`${phase} path ancestor is not a directory: ${workspacePath}`);
    identities.push({
      path: current,
      deviceId: stats.dev.toString(),
      fileId: stats.ino.toString(),
      size: stats.size.toString(),
      modifiedNs: stats.mtimeNs.toString()
    });
  }
  const leaf = await lstat(target, { bigint: true });
  if (requireFile && !leaf.isFile()) throw new Error(`${phase} target is not a regular file: ${workspacePath}`);
  const realPath = await realpath(target);
  if (!isSameOrInside(binding.realRoot, realPath)) {
    throw new Error(`${phase} target resolves outside the reviewed workspace: ${workspacePath}`);
  }
  return { realPath, identities, leafIsDirectory: leaf.isDirectory() };
}

function workspaceTarget(binding: WorkspacePhysicalBinding, workspacePath: string, phase: string): string {
  const target = resolve(binding.resolvedRoot, ...workspacePath.split("/"));
  if (!isSameOrInside(binding.resolvedRoot, target) || sameFileSystemPath(binding.resolvedRoot, target)) {
    throw new Error(`${phase} target escapes the reviewed workspace: ${workspacePath}`);
  }
  return target;
}

function sameIdentities(left: readonly PathIdentity[], right: readonly PathIdentity[]): boolean {
  return left.length === right.length && left.every((value, index) => {
    const other = right[index];
    return Boolean(other)
      && sameFileSystemPath(value.path, other!.path)
      && value.deviceId === other!.deviceId
      && value.fileId === other!.fileId
      && value.size === other!.size
      && value.modifiedNs === other!.modifiedNs;
  });
}

function sameFileSystemPath(left: string, right: string): boolean {
  const normalizedLeft = resolve(left);
  const normalizedRight = resolve(right);
  return process.platform === "win32"
    ? normalizedLeft.toLocaleLowerCase("en-US") === normalizedRight.toLocaleLowerCase("en-US")
    : normalizedLeft === normalizedRight;
}

function isSameOrInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return relativePath === "" || (!isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith("../") && !relativePath.startsWith("..\\"));
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === code;
}
