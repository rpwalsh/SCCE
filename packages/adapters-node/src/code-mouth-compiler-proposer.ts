// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { RepairOperation } from "@scce/kernel";
import { deriveTypeScriptCodeActionRepair, type TypeScriptCodeActionSnapshotFile } from "./typescript-code-actions.js";

const CONTENT_HASH = (content: string): `sha256:${string}` => `sha256:${createHash("sha256").update(content, "utf8").digest("hex")}`;

export interface CompilerRepairProposal {
  operations: RepairOperation[];
  surface: string;
  fixName: string;
  diagnosticCode: number;
}

export interface CompilerRepairCandidates {
  /** Fixes the compiler itself owns for this file, when the request does not name one. */
  candidates: Array<{ diagnosticCode: number; fixName: string; codeFixIdentity: string }>;
}

/**
 * A repair TypeScript itself derives: no model writes it and no model is needed
 * to check it, because the compiler both proposed the edit and owns the
 * diagnostic it answers. This is the native lane; a local model is optional and
 * only handles what the compiler has no fix for.
 */
export async function proposeCompilerOwnedRepair(input: {
  workspaceRoot: string;
  targetPath: string;
  targetText: string;
  requestText: string;
  attempt: number;
  imports?: readonly string[];
  tsconfigPath?: string;
}): Promise<CompilerRepairProposal | CompilerRepairCandidates | undefined> {
  const root = path.resolve(input.workspaceRoot);
  const absoluteTarget = path.resolve(root, input.targetPath);
  const relativeTarget = path.relative(root, absoluteTarget).replace(/\\/gu, "/");
  if (!relativeTarget || relativeTarget.startsWith("..")) return undefined;

  const files: TypeScriptCodeActionSnapshotFile[] = [];
  const add = async (relative: string, content?: string): Promise<void> => {
    if (files.some(file => file.path === relative)) return;
    const text = content ?? await readFile(path.resolve(root, relative), "utf8").catch(() => undefined);
    if (text === undefined) return;
    files.push({ path: relative, content: text, contentHash: CONTENT_HASH(text) });
  };

  const tsconfigRelative = input.tsconfigPath
    ? path.relative(root, path.resolve(root, input.tsconfigPath)).replace(/\\/gu, "/")
    : "tsconfig.json";
  await add("package.json");
  await add(tsconfigRelative);
  await add(relativeTarget, input.targetText);
  // Relative imports the target names: the compiler needs them to type the file it is fixing.
  for (const specifier of (input.imports ?? []).slice(0, 24)) {
    if (!specifier.startsWith(".")) continue;
    const base = path.resolve(path.dirname(absoluteTarget), specifier.replace(/\.js$/u, ""));
    for (const extension of [".ts", ".tsx", ".d.ts", "/index.ts"]) {
      const relative = path.relative(root, `${base}${extension}`).replace(/\\/gu, "/");
      if (relative.startsWith("..")) continue;
      await add(relative);
    }
  }
  // A project file usually extends a shared base; without the chain the compiler cannot bind the project.
  for (let depth = 0, current = tsconfigRelative; depth < 6; depth++) {
    const entry = files.find(item => item.path === current);
    if (!entry) break;
    let extendsPath: string | undefined;
    try {
      const parsed = JSON.parse(entry.content.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/(^|[^:])\/\/.*$/gmu, "$1")) as { extends?: unknown };
      extendsPath = typeof parsed.extends === "string" ? parsed.extends : undefined;
    } catch { break; }
    if (!extendsPath) break;
    const resolved = path.relative(root, path.resolve(path.dirname(path.resolve(root, current)), extendsPath.endsWith(".json") ? extendsPath : `${extendsPath}.json`)).replace(/\\/gu, "/");
    if (resolved.startsWith("..") || files.some(item => item.path === resolved)) break;
    await add(resolved);
    current = resolved;
  }
  // The symbols a fix may reach for live beside the file: its own directory is the bounded neighbourhood
  // the language service needs to offer an import, and it is what the project compiler would load anyway.
  const directory = path.dirname(path.resolve(root, relativeTarget));
  const siblings = await readdir(directory).catch(() => [] as string[]);
  let budget = 4_000_000;
  for (const entry of siblings.slice(0, 400)) {
    if (!/\.(ts|tsx|mts|cts)$/u.test(entry) || entry.endsWith(".d.ts")) continue;
    const relative = path.relative(root, path.join(directory, entry)).replace(/\\/gu, "/");
    if (relative === relativeTarget || files.some(item => item.path === relative)) continue;
    const stats = await stat(path.join(directory, entry)).catch(() => undefined);
    if (!stats || stats.size > budget) continue;
    budget -= stats.size;
    await add(relative);
    if (budget <= 0) break;
  }
  if (!files.some(file => file.path === tsconfigRelative)) return undefined;

  let repair;
  try {
    repair = deriveTypeScriptCodeActionRepair({
      rootPath: root.replace(/\\/gu, "/"),
      requestedPaths: [relativeTarget],
      requestText: input.requestText,
      files,
      compilerCommand: { executable: "tsc", args: ["-p", tsconfigRelative], cwd: ".", sourcePath: "package.json" }
    });
  } catch {
    // A snapshot the compiler cannot bind is not a failure of the turn; the model lane still applies.
    return undefined;
  }
  if (!repair) return undefined;

  const transformation = repair.transformations[0];
  if (!transformation) {
    const candidates = repair.selection.candidates
      .map(candidate => ({ diagnosticCode: candidate.diagnosticCode, fixName: candidate.fixName, codeFixIdentity: candidate.codeFixIdentity }))
      .slice(0, 8);
    return candidates.length ? { candidates } : undefined;
  }
  const lineCount = input.targetText.split("\n").length;
  return {
    operations: [{
      id: `op:${input.attempt}:compiler-fix`,
      risk: 0.1,
      kind: "replace",
      path: absoluteTarget,
      startLine: 1,
      endLine: lineCount,
      content: transformation.afterContent,
      reason: `compiler code action ${transformation.codeFix.fixName} for TS${transformation.diagnostic.code}`
    }],
    surface: transformation.afterContent,
    fixName: transformation.codeFix.fixName,
    diagnosticCode: transformation.diagnostic.code
  };
}

/** A proposal carries operations; a candidate list carries only what the compiler could offer. Pure. */
export function isCompilerRepairProposal(value: CompilerRepairProposal | CompilerRepairCandidates | undefined): value is CompilerRepairProposal {
  return Boolean(value && "operations" in value);
}
