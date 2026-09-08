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
  type RepairOperation
} from "@scce/kernel";
import { extractNodeSourceCodeFacts } from "./code-graph.js";
import type { LearnedCodeProposer } from "./learned-code-proposer.js";
import { runProcess } from "./document.js";

/**
 * The code mouth: retrieve (code-graph facts) -> propose (compiler-owned code actions)
 * -> apply -> compile/typecheck gate -> bounded retry loop
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
  source?: CodeMouthProposalSource;
}

export interface CodeMouthVerification {
  /** False when no test command ran, so a caller never reads silence as a passing suite. */
  testsRun?: boolean;
  buildSucceeded: boolean;
  testsSucceeded: boolean;
  diagnostics: ProgramDiagnostic[];
}

/**
 * How a proposal was arrived at, so a caller never has to infer it from the patch.
 *
 * `learned_construction` is composed from the language corpus; `compiler_owned` is transcribed from a fix the
 * toolchain itself computed. Both are gated identically -- the distinction is authorship, not trust.
 */
export type CodeMouthProposalSource = "learned_construction" | "compiler_owned";

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
  /** Where each attempted proposal came from, in attempt order. An empty list means nothing was ever proposed. */
  proposalSources?: CodeMouthProposalSource[];
}

export async function runCodeMouth(input: {
  request: string;
  targetPath: string;
  ports: CodeMouthPorts;
  /**
   * Safety ceiling on iterations. Not a cost.
   *
   * Nothing here is metered -- no tokens, no calls, no money. The only thing an attempt actually spends is time,
   * and that is what `maxWallClockMs` bounds, because a person is waiting. Termination does not need a counter
   * either: every iteration either strictly reduces the diagnostics, which is bounded below by zero, or spends
   * one of a finite number of hypotheses about a state it may not then repeat. This exists so that a fault in
   * one of those guarantees cannot spin forever, and it is derived from the work when a caller says nothing.
   */
  maxAttempts?: number;
  maxWallClockMs?: number;
  log?: (message: string) => void;
}): Promise<CodeMouthResult> {
  const log = input.log ?? (() => undefined);
  const hasher = createHasher();
  const startedAt = Date.now();
  const maxWallClockMs = input.maxWallClockMs ?? 180_000;
  const context = await input.ports.retrieve(input.targetPath);
  const offered = () => (input.ports.offeredCandidates?.() ?? []);
  const startingDiagnostics = (await input.ports.verify(input.targetPath)).diagnostics;
  let diagnostics: ProgramDiagnostic[] = startingDiagnostics;
  // Roughly one hypothesis per diagnostic per candidate the proposer holds, which is what the search can try
  // before it has nothing further to say. A caller may set its own. Neither is a price.
  const iterationCeiling = Math.max(4, input.maxAttempts ?? startingDiagnostics.length * 8);
  let session: BoundedDebugSession = createBoundedDebugSession(
    { maxAttempts: iterationCeiling, maxWallClockMs, maxMutatedFiles: 4 },
    startedAt
  );
  // What has been accepted, and what stays accepted.
  //
  // Each of these strictly reduced what was wrong and introduced nothing, so undoing them because a later
  // hypothesis failed would hand back a file the loop had already improved. Three defects repaired to one is a
  // better file than three defects untouched, and it is the file a person working through them would have. The
  // guarantee is that the file never gets worse, not that the loop only ever finishes.
  let applied: RepairOperation[] = [];
  let decision: DebugLoopDecision | undefined;
  const proposalSources: CodeMouthProposalSource[] = [];
  // The loop's own count. A session is replaced whenever the state advances, so its length is how many
  // hypotheses have been tried against the current state and not how many turns the loop has taken.
  let iterations = 0;

  const finish = (outcome: CodeMouthResult["outcome"], reason: string): CodeMouthResult => ({
    outcome,
    attempts: iterations,
    finalDiagnostics: diagnostics,
    appliedOperations: applied,
    decision,
    proposalSources,
    reason: applied.length && outcome !== "resolved"
      ? `${reason}; kept ${applied.length} repair(s) taking this file from ${startingDiagnostics.length} to ${diagnostics.length} diagnostics`
      : reason
  });

  for (let attempt = 1; attempt <= iterationCeiling; attempt++) {
    if (Date.now() - startedAt >= maxWallClockMs) {
      return finish("stopped", `wall-clock bound of ${maxWallClockMs}ms reached`);
    }
    // Only this file's diagnostics are this edit's to answer; repo-wide failures elsewhere made the proposer return the file unchanged.
    const targetDiagnostics = diagnosticsForTarget(diagnostics, input.targetPath);
    iterations = attempt - 1;
    const proposal = await input.ports.propose({ request: input.request, context, diagnostics: targetDiagnostics, attempt });
    if (!proposal || !proposal.operations.length) {
      const candidates = offered();
      // The compiler has fixes but more than one answers the request: choosing for the owner would be a guess.
      if (candidates.length) {
        return { ...finish("awaiting_selection", `the compiler offers ${candidates.length} fixes for this file; choose one to apply`), candidates };
      }
      return finish("no_proposal", applied.length
        ? "the search has no further hypothesis for what remains"
        : "no proposer produced a patch; name a diagnostic or fix the compiler owns for this file");
    }
    if (proposal.source) proposalSources.push(proposal.source);
    const check = planDebugAttempt(session, diagnostics, proposal.operations, hasher);
    if (!check.permitted) return finish("budget_exhausted", check.reason);
    iterations = attempt;
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
    const mutatedPaths = proposal.operations.map(operation => operation.path);
    if (patchResolvedTarget({ before: diagnostics, after: verification.diagnostics, targetPath: input.targetPath, mutatedPaths }) && verification.testsSucceeded) {
      applied = [...applied, ...proposal.operations];
      diagnostics = verification.diagnostics;
      return finish("resolved", verification.testsRun === false
        ? "the compiler accepted the patch; no test suite was run"
        : "the compiler accepted the patch and the tests passed");
    }
    // Not finished, but strictly better: keep it and carry on from there. This is the only way a file with more
    // than one defect is repairable at all, because every step of a convergent sequence looks like a failure to
    // a gate that recognises only the last one.
    if (patchReducedDiagnostics({ before: diagnostics, after: verification.diagnostics, targetPath: input.targetPath, mutatedPaths })) {
      applied = [...applied, ...proposal.operations];
      log(`attempt ${attempt} kept: ${diagnostics.length} -> ${verification.diagnostics.length} diagnostics`);
      diagnostics = verification.diagnostics;
      // A kept step changes the state being worked on, so what failed against the old one is not evidence about
      // this one. Carrying it forward made one poor guess after real progress read as thrashing.
      session = createBoundedDebugSession(
        { maxAttempts: Math.max(1, iterationCeiling - attempt), maxWallClockMs, maxMutatedFiles: 4 },
        Date.now()
      );
      continue;
    }
    // Rolled back, so the file is as it was and so is what is wrong with it. Recording the rejected attempt's
    // diagnostics as current told the loop it was somewhere it had just undone.
    await rollback();
    log(`attempt ${attempt} rejected by the gate (${verification.diagnostics.length} diagnostics); decision ${decision.outcome}: ${decision.reason}`);
    if (session.attempts.length >= session.budget.maxAttempts) {
      session = createBoundedDebugSession(
        { maxAttempts: Math.max(1, iterationCeiling - attempt), maxWallClockMs, maxMutatedFiles: 4 },
        Date.now()
      );
    }
    // A stall is only a stall once there is nothing new to try. The heuristic measures progress across attempts,
    // but successive attempts against one state are competing hypotheses about it, and every one before the
    // right one makes no progress by construction. What protects this loop is exact: planDebugAttempt refuses a
    // patch already tried against this exact diagnostic state, and the proposer stops offering once its
    // candidates run out.
    const stalledWithHypothesesLeft = decision.outcome === "stopped_repeated_failure" && attempt < iterationCeiling;
    if (decision.outcome !== "continue" && !stalledWithHypothesesLeft) return finish("stopped", decision.reason);
  }
  return finish("budget_exhausted", `iteration ceiling of ${iterationCeiling} reached`);
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

/**
 * Whether an edit strictly reduced what is wrong, without breaking anything that was not.
 *
 * `patchResolvedTarget` asks whether the file is finished, and rolling back everything that does not finish it
 * makes a file with two defects unrepairable: fixing the first still leaves the second, so the first is undone,
 * and the loop can only ever converge on files that were one edit away. A draft of anything is dozens of edits
 * away. Progress is the weaker property a loop actually runs on -- fewer diagnostics in the files touched, and no
 * new diagnostic anywhere -- and a sequence of such steps is monotone, so it terminates.
 *
 * Keeping a partial repair is not the same as shipping one. The caller keeps these steps while it is still
 * converging and undoes all of them if it stops short, so the workspace is either fixed or untouched.
 */
export function patchReducedDiagnostics(input: {
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
  // Identity by kind, not by position.
  //
  // A diagnostic's id carries its line and column, and every repair moves them: fixing the first of three
  // misspellings shifts the other two, whose ids then look like diagnostics the edit introduced. A convergent
  // step was rejected for having caused exactly the errors it had just left alone. What an edit must not do is
  // introduce a kind of failure that was not already there, and that is what this compares.
  const beforeKinds = new Set(input.before.map(diagnosticKind));
  if (input.after.some(diagnostic => !beforeKinds.has(diagnosticKind(diagnostic)))) return false;
  return input.after.filter(inTouched).length < input.before.filter(inTouched).length;
}

/** What kind of thing went wrong, independent of where it now sits. */
function diagnosticKind(diagnostic: ProgramDiagnostic): string {
  return `${diagnostic.patternId ?? diagnostic.class}${diagnostic.message}`;
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

/** Real ports for a TypeScript workspace: code-graph retrieval, compiler-owned proposals, file apply with rollback, tsc gate. */
export function createTypeScriptCodeMouthPorts(input: {
  workspaceRoot: string;
  tsconfigPath?: string;
  tscCommand?: { command: string; args: string[] };
  /** The learned lane. Given one, composition is tried first and the compiler's own fix is the fallback. */
  learnedProposer?: LearnedCodeProposer;
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
      // Composition leads, but only on the first attempt.
      //
      // A learned proposal that does not build is rolled back and costs nothing but that attempt, so leading with
      // the general lane risks only a turn of the loop -- and it is the only order under which this system writes
      // code rather than relaying someone else's. Handing the rest of the budget back is what keeps that free:
      // where the compiler does own an exact fix, it still gets its chance to apply it.
      if (attempt === 1) {
        const learned = await input.learnedProposer?.propose({ request, context, diagnostics, attempt });
        if (learned) return { ...learned, source: "learned_construction" };
      }
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
        return { operations: compilerRepair.operations, surface: compilerRepair.surface, source: "compiler_owned" };
      }
      if (compilerRepair) {
        input.log?.(`compiler offers ${compilerRepair.candidates.length} fix(es) for this file; name one (for example its TS code) to apply it`);
        offeredCandidates = compilerRepair.candidates;
      }
      // Nothing the compiler owns: the learned lane's remaining compositions are what is left to try.
      if (attempt > 1) {
        const learned = await input.learnedProposer?.propose({ request, context, diagnostics, attempt });
        if (learned) return { ...learned, source: "learned_construction" };
      }
      return undefined;
    },
    async apply(operations) {
      const originals = new Map<string, string>();
      for (const operation of operations) {
        const current = originals.get(operation.path) ?? await readFile(operation.path, "utf8").catch(() => "");
        if (!originals.has(operation.path)) originals.set(operation.path, current);
        // The file's own line ending, kept. Splitting on "\n" alone leaves every other line of a CRLF file
        // carrying its carriage return while the replaced one loses it, so a one-token repair silently
        // returned a file with mixed endings -- a diff across the whole line, and not what was asked for.
        const newline = current.includes("\r\n") ? "\r\n" : "\n";
        const lines = current.split(/\r?\n/u);
        let next: string;
        if (operation.kind === "replace" && operation.startLine) {
          const start = operation.startLine - 1, end = (operation.endLine ?? operation.startLine) - 1;
          next = [...lines.slice(0, start), ...(operation.content ?? "").split(/\r?\n/u), ...lines.slice(end + 1)].join(newline);
        } else if (operation.kind === "delete" && operation.startLine) {
          next = [...lines.slice(0, operation.startLine - 1), ...lines.slice((operation.endLine ?? operation.startLine))].join(newline);
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
