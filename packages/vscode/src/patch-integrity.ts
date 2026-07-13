import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { AppliedWorkspacePatch, ReviewedPatchPlan } from "./patch-protocol.js";

export const PATCH_TRANSACTION_SCOPE = "atomic-per-file-with-verified-transaction-rollback" as const;

export function verifyAppliedPatchMatchesPlan(
  applied: AppliedWorkspacePatch,
  plan: ReviewedPatchPlan
): AppliedWorkspacePatch {
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
  }
  return applied;
}

export async function verifyAppliedWorkspaceState(rootPath: string, plan: ReviewedPatchPlan): Promise<void> {
  const resolvedRoot = resolve(rootPath);
  const realRoot = await realpath(resolvedRoot);
  for (const operation of plan.operations) {
    const target = resolve(resolvedRoot, ...operation.path.split("/"));
    if (!isSameOrInside(resolvedRoot, target) || sameFileSystemPath(resolvedRoot, target)) {
      throw new Error(`post-apply verification target escapes the open workspace: ${operation.path}`);
    }
    if (operation.kind === "delete") {
      await verifyTargetAbsent(realRoot, target, operation.path);
      continue;
    }
    let realTarget: string;
    try {
      realTarget = await realpath(target);
    } catch (error) {
      if (isFileSystemError(error, "ENOENT")) throw new Error(`post-apply target is missing: ${operation.path}`);
      throw error;
    }
    if (!isSameOrInside(realRoot, realTarget) || sameFileSystemPath(realRoot, realTarget)) {
      throw new Error(`post-apply target resolves outside the open workspace: ${operation.path}`);
    }
    const bytes = await readFile(realTarget);
    const actualHash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
    if (actualHash !== operation.afterContentHash) {
      throw new Error(`post-apply content hash does not match the reviewed operation for ${operation.path}; expected ${operation.afterContentHash}, found ${actualHash}`);
    }
  }
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

async function verifyTargetAbsent(realRoot: string, target: string, workspacePath: string): Promise<void> {
  try {
    await lstat(target);
    throw new Error(`post-apply delete target still exists: ${workspacePath}`);
  } catch (error) {
    if (!isFileSystemError(error, "ENOENT")) throw error;
  }
  let parent = dirname(target);
  for (;;) {
    try {
      const realParent = await realpath(parent);
      if (!isSameOrInside(realRoot, realParent)) throw new Error(`post-apply delete target parent resolves outside the open workspace: ${workspacePath}`);
      return;
    } catch (error) {
      if (!isFileSystemError(error, "ENOENT")) throw error;
      const next = dirname(parent);
      if (next === parent) throw new Error(`could not verify a workspace parent for deleted target: ${workspacePath}`);
      parent = next;
    }
  }
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
