// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { Hasher, ProgramGraph, RequestedAuthority } from "./types.js";
import { emittedProgramRuntimeForLanguage } from "./code-learning.js";
import { validateProgramGraphHydration } from "./program-runtime.js";
import { canonicalStringify } from "./primitives.js";

export interface ProgramLocalValidationProof {
  readonly programId: string;
  readonly ownerRequirementIds: readonly string[];
  readonly files: readonly { readonly path: string; readonly contentHash: string }[];
  readonly build: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
  readonly test: { readonly command: string; readonly args: readonly string[]; readonly cwd: string };
}

/** Proves that this exact owner-bound graph is the closed, dependency-free validation shape emitted by SCCE. */
export function validateOwnerProgramLocalValidation(input: {
  readonly program: ProgramGraph;
  /** The graph emitted earlier in this same turn from the current request and admitted owner IR. */
  readonly canonicalProgram?: ProgramGraph;
  readonly requestedAuthority: RequestedAuthority;
  readonly requestRequirementIds: readonly string[];
  readonly hasher: Hasher;
}): ProgramLocalValidationProof | undefined {
  const { program } = input;
  if (input.requestedAuthority !== "program") return undefined;
  if (!input.canonicalProgram) return undefined;
  if (canonicalStringify(program) !== canonicalStringify(input.canonicalProgram)) return undefined;
  const requestIds = [...new Set(input.requestRequirementIds)].sort(compare);
  const graphIds = [...new Set(program.hydration?.ownerRequirementIds ?? [])].sort(compare);
  if (!requestIds.length || graphIds.length !== requestIds.length || graphIds.some((id, index) => id !== requestIds[index])) return undefined;
  if (!validateProgramGraphHydration(program).valid) return undefined;

  const runtime = emittedProgramRuntimeForLanguage(program.language);
  if (program.packageManager !== runtime.commandName || program.entrypoint !== runtime.sourcePath) return undefined;
  const sourceFiles = program.files.filter(file => file.role === "source");
  const testFiles = program.files.filter(file => file.role === "test");
  const source = sourceFiles.find(file => file.path === runtime.sourcePath);
  const test = testFiles.find(file => file.path === runtime.testPath);
  if (sourceFiles.length !== 1 || testFiles.length !== 1 || !source || !test
    || program.files.some(file => !["source", "test", "config", "doc"].includes(file.role))) return undefined;
  if (new Set(program.files.map(file => file.path)).size !== program.files.length) return undefined;
  for (const file of program.files) {
    if (file.contentHash !== `sha256_${input.hasher.digestHex(file.content)}`) return undefined;
  }

  const expectedBuild = { command: runtime.commandName, args: [...runtime.syntaxCheckArgs, runtime.sourcePath], cwd: "." };
  const expectedTest = { command: runtime.commandName, args: [runtime.testPath], cwd: "." };
  if (!sameCommand(program.build, expectedBuild) || !sameCommand(program.test, expectedTest)) return undefined;
  return {
    programId: program.id,
    ownerRequirementIds: graphIds,
    files: program.files.map(file => ({ path: file.path, contentHash: file.contentHash })).sort((left, right) => compare(left.path, right.path)),
    build: expectedBuild,
    test: expectedTest
  };
}

function sameCommand(left: ProgramGraph["build"], right: ProgramGraph["build"]): boolean {
  return left.command === right.command
    && left.cwd === right.cwd
    && left.args.length === right.args.length
    && left.args.every((arg, index) => arg === right.args[index]);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
