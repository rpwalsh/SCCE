// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalStringify, codeLanguageForPath, createPatchTransactionPlan, hashPatchContent, type ProgramDiagnostic, type RepairOperation } from "@scce/kernel";
import { createClangCodeMouthPorts } from "./clang-code-mouth-ports.js";
import { createTypeScriptCodeMouthPorts, type CodeMouthPorts, type CodeMouthVerification } from "./code-mouth.js";
import type { LearnedCodeProposer, LearnedCodeCorpusAvailability } from "./learned-code-proposer.js";
import { checkerDiagnostics, createTreeSitterCodeMouthPorts } from "./tree-sitter-code-mouth-ports.js";
import { runStructuredWorkspaceValidation, type StructuredPatchValidationPolicy, type StructuredPatchValidationProvider, type StructuredWorkspaceValidationEvidence } from "./structured-patch-validation.js";
import { executeWorkspacePatchTransaction } from "./workspace-patch-transaction.js";

export interface WorkspaceCodeMouthOptions {
  workspaceRoot: string;
  targetPath: string;
  learnedProposer?: LearnedCodeProposer;
  log?: (message: string) => void;
  /** Host-owned commands, shared with the workspace patch transaction lane. */
  projectValidation?: { policy: StructuredPatchValidationPolicy; provider?: StructuredPatchValidationProvider };
}

export interface WorkspaceCodeMouthPorts extends CodeMouthPorts {
  projectVerification(): WorkspaceApplicationVerification | undefined;
  corpusAvailability(): LearnedCodeCorpusAvailability | undefined;
}

/** CLI and HTTP select the same language ports and optional complete-application gate. */
export function createWorkspaceCodeMouthPorts(options: WorkspaceCodeMouthOptions): WorkspaceCodeMouthPorts {
  containedPath(options.workspaceRoot, options.targetPath);
  if (options.projectValidation && !options.projectValidation.policy.commands.some(command => command.checkIds?.some(check => check === "compiler" || check === "typecheck"))) throw new Error("workspace code validation requires a compiler or typecheck command");
  let projectVerification: WorkspaceApplicationVerification | undefined;
  let behavioralFailure: { observationId: string } | undefined;
  const language = codeLanguageForPath(options.targetPath);
  const ports = language === "typescript"
    ? createTypeScriptCodeMouthPorts(options)
    : language === "c" || language === "cpp" || /\.(m|mm)$/iu.test(options.targetPath)
      ? createClangCodeMouthPorts(options)
      : createTreeSitterCodeMouthPorts(options);
  return {
    ...ports,
    propose: input => {
      return ports.propose({ ...input, context: { ...input.context, ...(behavioralFailure ? { behavioralFailure } : {}) } });
    },
    projectVerification: () => projectVerification,
    corpusAvailability: () => language ? options.learnedProposer?.corpusAvailability?.(language) : undefined,
    apply: async operations => {
      const rollback = await applyWorkspaceRepairOperations(options.workspaceRoot, operations);
      const previousFailure = behavioralFailure;
      projectVerification = undefined;
      behavioralFailure = undefined;
      return async () => { await rollback(); projectVerification = undefined; behavioralFailure = previousFailure; };
    },
    ...(options.projectValidation ? { verify: async (targetPath?: string) => {
      const target = targetPath ?? options.targetPath;
      try { projectVerification = await verifyWorkspaceApplication(options, target); }
      catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        projectVerification = { buildSucceeded: false, testsRun: false, testsSucceeded: false, diagnostics: [{
          id: "workspace.validation.unavailable", class: "unknown", path: target, message, raw: message, confidence: 1
        }] };
      }
      behavioralFailure = projectVerification.buildSucceeded && projectVerification.testsRun && !projectVerification.testsSucceeded && projectVerification.projectEvidence
        ? { observationId: hashPatchContent(canonicalStringify(projectVerification.projectEvidence)) } : undefined;
      return projectVerification;
    } } : {})
  };
}

export interface WorkspaceApplicationVerification extends CodeMouthVerification {
  projectEvidence?: StructuredWorkspaceValidationEvidence;
}

async function verifyWorkspaceApplication(options: WorkspaceCodeMouthOptions, targetPath: string): Promise<WorkspaceApplicationVerification> {
  const validation = options.projectValidation!;
  const result = await runStructuredWorkspaceValidation({ workspaceRoot: options.workspaceRoot, ...validation });
  const commands = result.evidence.commands;
  const passed = (command: typeof commands[number]) => command.code === 0 && !command.timedOut && !command.outputLimitExceeded;
  const buildCommands = commands.filter(command => command.checkIds.some(check => check === "compiler" || check === "typecheck"));
  const tests = commands.filter(command => command.checkIds.includes("tests"));
  const testsExpected = validation.policy.commands.some(command => command.checkIds?.includes("tests"));
  const failures: ProgramDiagnostic[] = commands.filter(command => !passed(command)).flatMap(command =>
    checkerDiagnostics(command, targetPath, codeLanguageForPath(targetPath) ?? "unknown", options.workspaceRoot).map(diagnostic => ({
      ...diagnostic,
      class: command.checkIds.includes("tests") ? "runtime" as const : diagnostic.class,
      patternId: `workspace.command.${command.index}.${diagnostic.patternId ?? diagnostic.class}`
    })));
  return {
    buildSucceeded: buildCommands.length > 0 && buildCommands.every(passed),
    testsRun: tests.length > 0,
    testsSucceeded: testsExpected ? tests.length > 0 && tests.every(passed) && result.ok : result.ok,
    diagnostics: failures,
    projectEvidence: result.evidence
  };
}

/** One source revision supplies every range; the existing transaction owns containment, CAS and rollback. */
async function applyWorkspaceRepairOperations(workspaceRoot: string, operations: readonly RepairOperation[]): Promise<() => Promise<void>> {
  const grouped = new Map<string, RepairOperation[]>();
  for (const operation of operations) {
    if (operation.kind !== "replace" || operation.startLine === undefined || operation.content === undefined) throw new Error(`unsupported workspace repair operation: ${operation.kind}`);
    const relative = containedPath(workspaceRoot, operation.path);
    const normalized = relative.split(path.sep).join("/");
    grouped.set(normalized, [...(grouped.get(normalized) ?? []), operation]);
  }
  const before = new Map<string, string>();
  const after = new Map<string, string>();
  for (const [relative, edits] of grouped) {
    const absolute = path.resolve(workspaceRoot, relative);
    const original = await readFile(absolute, "utf8");
    before.set(relative, original);
    const starts = [0];
    for (let index = 0; index < original.length; index++) if (original[index] === "\n") starts.push(index + 1);
    let next = original;
    let previousStart = starts.length + 1;
    for (const edit of [...edits].sort((a, b) => b.startLine! - a.startLine!)) {
      const start = edit.startLine!;
      const end = edit.endLine ?? start;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start || end > starts.length || end >= previousStart) throw new Error("repair ranges are invalid or overlap");
      const from = starts[start - 1]!;
      const following = starts[end];
      const to = following === undefined ? original.length : following - (original[following - 2] === "\r" ? 2 : 1);
      const newline = /\r?\n/u.exec(original.slice(from))?.[0] ?? /\r?\n/u.exec(original)?.[0] ?? "\n";
      next = next.slice(0, from) + edit.content!.split(/\r?\n/u).join(newline) + next.slice(to);
      previousStart = start;
    }
    after.set(relative, next);
  }
  const plan = createPatchTransactionPlan({ operations: [...after].map(([relative, content]) => ({ kind: "replace", path: relative, baseContentHash: hashPatchContent(before.get(relative)!), content })) });
  await executeWorkspacePatchTransaction({ workspaceRoot, plan });
  return async () => {
    await executeWorkspacePatchTransaction({ workspaceRoot, plan: createPatchTransactionPlan({ operations: [...before].map(([relative, content]) => ({ kind: "replace", path: relative, baseContentHash: hashPatchContent(after.get(relative)!), content })) }) });
  };
}

function containedPath(workspaceRoot: string, target: string): string {
  const relative = path.relative(path.resolve(workspaceRoot), path.resolve(workspaceRoot, target));
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) throw new Error("repair path escapes workspace");
  return relative;
}
