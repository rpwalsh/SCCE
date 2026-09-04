// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { existsSync } from "node:fs";
import { isCompilerRepairProposal, proposeCompilerOwnedRepair } from "./code-mouth-compiler-proposer.js";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import {
  createBoundedDebugSession,
  createHasher,
  planDebugAttempt,
  recordDebugAttempt,
  type BoundedDebugSession,
  type DebugLoopDecision,
  type ProgramDiagnostic,
  type RepairOperation,
  type WordingRealizerPort
} from "@scce/kernel";
import { extractNodeSourceCodeFacts } from "./code-graph.js";
import { runProcess } from "./document.js";

/**
 * The code mouth: retrieve (code-graph facts) -> propose (a realizer constrained to the
 * workspace's own symbols) -> apply -> compile/typecheck gate -> bounded retry loop
 * (bounded-autonomous-debugging decides continue/stop). Only a patch that passes the
 * gate survives; anything else is rolled back: it compiles, or it refuses.
 */

export interface CodeMouthContext {
  targetPath: string;
  targetText: string;
  symbols: string[];
  imports: string[];
  language: string;
}

export interface CodeMouthProposal {
  operations: RepairOperation[];
  surface: string;
}

export interface CodeMouthVerification {
  /** False when no test command ran, so a caller never reads silence as a passing suite. */
  testsRun?: boolean;
  buildSucceeded: boolean;
  testsSucceeded: boolean;
  diagnostics: ProgramDiagnostic[];
}

export interface CodeMouthPorts {
  retrieve: (targetPath: string) => Promise<CodeMouthContext>;
  propose: (input: { request: string; context: CodeMouthContext; diagnostics: readonly ProgramDiagnostic[]; attempt: number }) => Promise<CodeMouthProposal | undefined>;
  apply: (operations: readonly RepairOperation[]) => Promise<() => Promise<void>>;
  verify: (targetPath?: string) => Promise<CodeMouthVerification>;
  /** Fixes the compiler offered on the last proposal, when it declined to choose between them. */
  offeredCandidates?: () => Array<{ diagnosticCode: number; fixName: string; codeFixIdentity: string }>;
}

export interface CodeMouthResult {
  outcome: "resolved" | "no_proposal" | "awaiting_selection" | "stopped" | "budget_exhausted";
  attempts: number;
  finalDiagnostics: ProgramDiagnostic[];
  appliedOperations: RepairOperation[];
  decision?: DebugLoopDecision;
  reason: string;
  /** Fixes the compiler owns for this file when more than one answers the request; the caller chooses. */
  candidates?: Array<{ diagnosticCode: number; fixName: string; codeFixIdentity: string }>;
}

export async function runCodeMouth(input: {
  request: string;
  targetPath: string;
  ports: CodeMouthPorts;
  maxAttempts?: number;
  maxWallClockMs?: number;
  log?: (message: string) => void;
}): Promise<CodeMouthResult> {
  const log = input.log ?? (() => undefined);
  const hasher = createHasher();
  let session: BoundedDebugSession = createBoundedDebugSession({ maxAttempts: input.maxAttempts ?? 3, maxWallClockMs: input.maxWallClockMs ?? 180_000, maxMutatedFiles: 4 }, Date.now());
  const context = await input.ports.retrieve(input.targetPath);
  const offered = () => (input.ports.offeredCandidates?.() ?? []);
  let diagnostics: ProgramDiagnostic[] = (await input.ports.verify(input.targetPath)).diagnostics;
  let applied: RepairOperation[] = [];
  let decision: DebugLoopDecision | undefined;
  for (let attempt = 1; attempt <= session.budget.maxAttempts; attempt++) {
    // Only this file's diagnostics are this edit's to answer; repo-wide failures elsewhere made the proposer return the file unchanged.
    const targetDiagnostics = diagnosticsForTarget(diagnostics, input.targetPath);
    const proposal = await input.ports.propose({ request: input.request, context, diagnostics: targetDiagnostics, attempt });
    if (!proposal || !proposal.operations.length) {
      const candidates = offered();
      // The compiler has fixes but more than one answers the request: choosing for the owner would be a guess.
      if (candidates.length) {
        return { outcome: "awaiting_selection", attempts: attempt - 1, finalDiagnostics: diagnostics, appliedOperations: applied, decision, candidates, reason: `the compiler offers ${candidates.length} fixes for this file; choose one to apply` };
      }
      return { outcome: "no_proposal", attempts: attempt - 1, finalDiagnostics: diagnostics, appliedOperations: applied, decision, reason: "no proposer produced a patch; enable a realization provider (constrained decoding or a local model server) or provide a diagnostic-bound request" };
    }
    const check = planDebugAttempt(session, diagnostics, proposal.operations, hasher);
    if (!check.permitted) return { outcome: "budget_exhausted", attempts: attempt - 1, finalDiagnostics: diagnostics, appliedOperations: applied, decision, reason: check.reason };
    log(`attempt ${attempt}: ${proposal.operations.map(operation => `${operation.kind} ${path.basename(operation.path)}`).join(", ")}`);
    const rollback = await input.ports.apply(proposal.operations);
    const verification = await input.ports.verify(input.targetPath);
    const recorded = recordDebugAttempt(session, {
      now: Date.now(),
      diagnosticsBefore: diagnostics,
      operations: proposal.operations,
      mutatedPaths: [...new Set(proposal.operations.map(operation => operation.path))],
      buildSucceeded: verification.buildSucceeded,
      testsSucceeded: verification.testsSucceeded,
      diagnosticsAfter: verification.diagnostics,
      hasher
    });
    session = recorded.session;
    decision = recorded.decision;
    if (patchResolvedTarget({ before: diagnostics, after: verification.diagnostics, targetPath: input.targetPath, mutatedPaths: proposal.operations.map(operation => operation.path) }) && verification.testsSucceeded) {
      applied = [...applied, ...proposal.operations];
      return {
        outcome: "resolved",
        attempts: attempt,
        finalDiagnostics: verification.diagnostics,
        appliedOperations: applied,
        decision,
        reason: verification.testsRun === false
          ? "the compiler accepted the patch; no test suite was run"
          : "the compiler accepted the patch and the tests passed"
      };
    }
    await rollback();
    diagnostics = verification.diagnostics;
    log(`attempt ${attempt} rejected by the gate (${verification.diagnostics.length} diagnostics); decision ${decision.outcome}: ${decision.reason}`);
    if (decision.outcome !== "continue") return { outcome: "stopped", attempts: attempt, finalDiagnostics: diagnostics, appliedOperations: applied, decision, reason: decision.reason };
  }
  return { outcome: "budget_exhausted", attempts: session.attempts.length, finalDiagnostics: diagnostics, appliedOperations: applied, decision, reason: "attempt budget exhausted" };
}

/**
 * The project file that owns a path: the nearest tsconfig walking up from the file to the workspace root.
 * A workspace-root project in a monorepo usually references packages rather than including their sources,
 * so typechecking it neither covers the file being edited nor finishes quickly.
 */
export function nearestProjectFile(root: string, targetPath?: string): string | undefined {
  if (!targetPath) return undefined;
  const absoluteRoot = path.resolve(root);
  let directory = path.dirname(path.resolve(absoluteRoot, targetPath));
  for (let depth = 0; depth < 24; depth++) {
    const candidate = path.join(directory, "tsconfig.json");
    if (existsSync(candidate)) return candidate;
    if (path.resolve(directory) === absoluteRoot) return undefined;
    const parent = path.dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
  return undefined;
}

/** The diagnostics that belong to the file being edited. Pure. */
export function diagnosticsForTarget(diagnostics: readonly ProgramDiagnostic[], targetPath: string): ProgramDiagnostic[] {
  const target = targetPath.replace(/\\/gu, "/").toLocaleLowerCase();
  return diagnostics.filter(diagnostic => {
    const file = String(diagnostic.path ?? "").replace(/\\/gu, "/").toLocaleLowerCase();
    return Boolean(file) && (file.endsWith(target) || target.endsWith(file));
  });
}

/**
 * The gate an edit can actually satisfy: every diagnostic in the files it touched is gone, and it
 * introduced none anywhere else. Pre-existing failures elsewhere in the project are not this edit's
 * to fix, and were never evidence against it. Pure.
 */
export function patchResolvedTarget(input: {
  before: readonly ProgramDiagnostic[];
  after: readonly ProgramDiagnostic[];
  targetPath: string;
  mutatedPaths: readonly string[];
}): boolean {
  const touched = new Set([input.targetPath, ...input.mutatedPaths].map(value => value.replace(/\\/gu, "/").toLocaleLowerCase()));
  const inTouched = (diagnostic: ProgramDiagnostic) => {
    const file = String(diagnostic.path ?? "").replace(/\\/gu, "/").toLocaleLowerCase();
    return [...touched].some(value => file.endsWith(value) || value.endsWith(file));
  };
  if (input.after.some(inTouched)) return false;
  const beforeIds = new Set(input.before.map(diagnostic => diagnostic.id));
  return !input.after.some(diagnostic => !beforeIds.has(diagnostic.id));
}

/** tsc output line -> ProgramDiagnostic. Pure. */
export function parseTscDiagnostics(output: string, root: string): ProgramDiagnostic[] {
  const out: ProgramDiagnostic[] = [];
  const re = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/u;
  for (const line of output.split(/\r?\n/u)) {
    const match = re.exec(line.trim());
    if (!match) continue;
    const [, file, lineText, column, code, message] = match;
    out.push({ raw: line.trim(), confidence: 0.95, id: `${code}:${file}:${lineText}:${column}`, class: code === "TS1005" || code === "TS1109" || code === "TS1127" ? "syntax" : "type", patternId: code, path: path.resolve(root, file!), line: Number(lineText), column: Number(column), message: message! });
  }
  return out;
}

/** Real ports for a TypeScript workspace: code-graph retrieval, realizer-backed proposals masked to workspace symbols, file apply with rollback, tsc gate. */
export function createTypeScriptCodeMouthPorts(input: {
  workspaceRoot: string;
  tsconfigPath?: string;
  realizer?: WordingRealizerPort;
  tscCommand?: { command: string; args: string[] };
  log?: (message: string) => void;
}): CodeMouthPorts {
  const root = path.resolve(input.workspaceRoot);
  const hasher = createHasher();
  let offeredCandidates: Array<{ diagnosticCode: number; fixName: string; codeFixIdentity: string }> = [];
  return {
    offeredCandidates: () => offeredCandidates,
    async retrieve(targetPath) {
      const absolute = path.resolve(root, targetPath);
      const text = await readFile(absolute, "utf8").catch(() => "");
      const facts = extractNodeSourceCodeFacts({ absolutePath: absolute, uri: path.relative(root, absolute).replace(/\\/g, "/"), mediaType: "text/typescript", text, sha256: hasher.digestHex(text), hasher });
      return {
        targetPath: absolute,
        targetText: text,
        symbols: [...new Set([...(facts?.declarations.map(item => item.name) ?? []), ...(text.match(/\b[A-Za-z_$][A-Za-z0-9_$]*\b/gu) ?? [])])].slice(0, 2000),
        imports: facts?.imports.map(item => item.moduleSpecifier) ?? [],
        language: "typescript"
      };
    },
    async propose({ request, context, diagnostics, attempt }) {
      // Native first: a fix TypeScript itself owns needs no model, and the model lane is optional.
      const compilerRepair = await proposeCompilerOwnedRepair({
        workspaceRoot: root,
        targetPath: context.targetPath,
        targetText: context.targetText,
        requestText: request,
        attempt,
        imports: context.imports,
        ...(() => { const project = input.tsconfigPath ?? nearestProjectFile(root, context.targetPath); return project ? { tsconfigPath: project } : {}; })()
      });
      if (isCompilerRepairProposal(compilerRepair)) {
        input.log?.(`attempt ${attempt}: compiler code action ${compilerRepair.fixName} for TS${compilerRepair.diagnosticCode}`);
        return { operations: compilerRepair.operations, surface: compilerRepair.surface };
      }
      if (compilerRepair) {
        input.log?.(`compiler offers ${compilerRepair.candidates.length} fix(es) for this file; name one (for example its TS code) to apply it`);
        offeredCandidates = compilerRepair.candidates;
      }
      if (!input.realizer) return undefined;
      const facts = [
        { subject: "request", predicate: "asks", object: request, evidenceIds: ["request"] },
        { subject: path.basename(context.targetPath), predicate: "contains", object: context.targetText.slice(0, 24_000), evidenceIds: ["source"] },
        { subject: path.basename(context.targetPath), predicate: "exports", object: context.symbols.slice(0, 64).join(" "), evidenceIds: ["code-graph"] },
        ...diagnostics.slice(0, 6).map((diagnostic, index) => ({ subject: `diagnostic ${index + 1}`, predicate: "says", object: `${diagnostic.message} (line ${diagnostic.line ?? "?"})`, evidenceIds: [diagnostic.id] }))
      ];
      const surfaces = await input.realizer.realize({ requestText: request, facts, targetLanguage: "typescript", targetScript: "Latn", maxSentences: 40, closedClassWords: TYPESCRIPT_CLOSED_CLASS });
      const code = surfaces.map(surface => surface.replace(/\s+$/u, "")).filter(surface => surface.trim())[0];
      if (!code || code === context.targetText.replace(/\s+$/u, "")) return undefined;
      const lineCount = context.targetText.split("\n").length;
      const operation: RepairOperation = { id: `op:${attempt}:rewrite`, risk: 0.5, kind: "replace", path: context.targetPath, startLine: 1, endLine: lineCount, content: code, reason: `attempt ${attempt}: whole-file rewrite from the realizer` };
      return { operations: [operation], surface: code };
    },
    async apply(operations) {
      const originals = new Map<string, string>();
      for (const operation of operations) {
        const current = originals.get(operation.path) ?? await readFile(operation.path, "utf8").catch(() => "");
        if (!originals.has(operation.path)) originals.set(operation.path, current);
        const lines = current.split("\n");
        let next: string;
        if (operation.kind === "replace" && operation.startLine) {
          const start = operation.startLine - 1, end = (operation.endLine ?? operation.startLine) - 1;
          next = [...lines.slice(0, start), ...(operation.content ?? "").split("\n"), ...lines.slice(end + 1)].join("\n");
        } else if (operation.kind === "delete" && operation.startLine) {
          next = [...lines.slice(0, operation.startLine - 1), ...lines.slice((operation.endLine ?? operation.startLine))].join("\n");
        } else {
          next = current + (operation.content ?? "");
        }
        await writeFile(operation.path, next, "utf8");
      }
      return async () => { for (const [file, text] of originals) await writeFile(file, text, "utf8"); };
    },
    async verify(targetPath?: string) {
      const tsconfig = input.tsconfigPath ?? nearestProjectFile(root, targetPath) ?? path.join(root, "tsconfig.json");
      const localTsc = path.join(root, "node_modules", "typescript", "bin", "tsc");
      const tsc = existsSync(localTsc) ? localTsc : createRequire(import.meta.url).resolve("typescript/bin/tsc");
      const command = input.tscCommand ?? { command: process.execPath, args: [tsc, "--noEmit", "-p", tsconfig] };
      const result = await runProcess(command.command, command.args, { cwd: root, timeoutMs: 180_000 });
      const diagnostics = parseTscDiagnostics(`${result.stdout}\n${result.stderr}`, root);
      if (result.code !== 0 && !diagnostics.length) {
        // The gate itself failed to run: report that as a build failure rather than a clean bill.
        diagnostics.push({ id: "tsc:unavailable", class: "syntax", message: `typecheck did not run: ${(result.stderr || result.stdout || "").trim().slice(0, 300)}`, raw: (result.stderr || result.stdout || "").trim().slice(0, 300), confidence: 1 });
      }
      // No test command has run here, so nothing about tests is claimed: the typecheck is the whole proof.
      return { buildSucceeded: result.code === 0 && diagnostics.length === 0, testsSucceeded: true, testsRun: false, diagnostics };
    }
  };
}

/** TypeScript's own closed class -- keywords and punctuation the decoder may emit besides workspace symbols. Not natural language. */
const TYPESCRIPT_CLOSED_CLASS = ["export", "function", "const", "let", "return", "if", "else", "for", "of", "while", "new", "class", "interface", "type", "import", "from", "async", "await", "string", "number", "boolean", "void", "undefined", "null", "true", "false", "=>", "=", "===", "!==", "+", "-", "*", "/", "%", "<", ">", "<=", ">=", "&&", "||", "!", "?", ":", ";", ",", ".", "(", ")", "{", "}", "[", "]", "readonly", "this", "throw", "try", "catch", "map", "filter", "length", "push", "join", "split", "slice", "reverse"];
