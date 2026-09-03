import { readFile, writeFile } from "node:fs/promises";
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
  buildSucceeded: boolean;
  testsSucceeded: boolean;
  diagnostics: ProgramDiagnostic[];
}

export interface CodeMouthPorts {
  retrieve: (targetPath: string) => Promise<CodeMouthContext>;
  propose: (input: { request: string; context: CodeMouthContext; diagnostics: readonly ProgramDiagnostic[]; attempt: number }) => Promise<CodeMouthProposal | undefined>;
  apply: (operations: readonly RepairOperation[]) => Promise<() => Promise<void>>;
  verify: () => Promise<CodeMouthVerification>;
}

export interface CodeMouthResult {
  outcome: "resolved" | "no_proposal" | "stopped" | "budget_exhausted";
  attempts: number;
  finalDiagnostics: ProgramDiagnostic[];
  appliedOperations: RepairOperation[];
  decision?: DebugLoopDecision;
  reason: string;
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
  let diagnostics: ProgramDiagnostic[] = (await input.ports.verify()).diagnostics;
  let applied: RepairOperation[] = [];
  let decision: DebugLoopDecision | undefined;
  for (let attempt = 1; attempt <= session.budget.maxAttempts; attempt++) {
    const proposal = await input.ports.propose({ request: input.request, context, diagnostics, attempt });
    if (!proposal || !proposal.operations.length) {
      return { outcome: "no_proposal", attempts: attempt - 1, finalDiagnostics: diagnostics, appliedOperations: applied, decision, reason: "no proposer produced a patch; enable a realization provider (constrained decoding or ollama) or provide a diagnostic-bound request" };
    }
    const check = planDebugAttempt(session, diagnostics, proposal.operations, hasher);
    if (!check.permitted) return { outcome: "budget_exhausted", attempts: attempt - 1, finalDiagnostics: diagnostics, appliedOperations: applied, decision, reason: check.reason };
    log(`attempt ${attempt}: ${proposal.operations.map(operation => `${operation.kind} ${path.basename(operation.path)}`).join(", ")}`);
    const rollback = await input.ports.apply(proposal.operations);
    const verification = await input.ports.verify();
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
    if (verification.buildSucceeded && verification.testsSucceeded) {
      applied = [...applied, ...proposal.operations];
      return { outcome: "resolved", attempts: attempt, finalDiagnostics: verification.diagnostics, appliedOperations: applied, decision, reason: "patch compiled and passed the gate" };
    }
    await rollback();
    diagnostics = verification.diagnostics;
    log(`attempt ${attempt} rejected by the gate (${verification.diagnostics.length} diagnostics); decision ${decision.outcome}: ${decision.reason}`);
    if (decision.outcome !== "continue") return { outcome: "stopped", attempts: attempt, finalDiagnostics: diagnostics, appliedOperations: applied, decision, reason: decision.reason };
  }
  return { outcome: "budget_exhausted", attempts: session.attempts.length, finalDiagnostics: diagnostics, appliedOperations: applied, decision, reason: "attempt budget exhausted" };
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
  return {
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
      if (!input.realizer) return undefined;
      const facts = [
        { subject: "request", predicate: "asks", object: request, evidenceIds: ["request"] },
        { subject: path.basename(context.targetPath), predicate: "exports", object: context.symbols.slice(0, 64).join(" "), evidenceIds: ["code-graph"] },
        ...diagnostics.slice(0, 6).map((diagnostic, index) => ({ subject: `diagnostic ${index + 1}`, predicate: "says", object: `${diagnostic.message} (line ${diagnostic.line ?? "?"})`, evidenceIds: [diagnostic.id] }))
      ];
      const surfaces = await input.realizer.realize({ requestText: request, facts, targetLanguage: "typescript", targetScript: "Latn", maxSentences: 40, closedClassWords: TYPESCRIPT_CLOSED_CLASS });
      const code = surfaces.map(surface => surface.trim()).filter(Boolean)[0];
      if (!code) return undefined;
      const targetDiagnostic = diagnostics.find(diagnostic => diagnostic.path === context.targetPath && diagnostic.line);
      const operation: RepairOperation = targetDiagnostic
        ? { id: `op:${attempt}:replace`, risk: 0.5, kind: "replace", path: context.targetPath, startLine: targetDiagnostic.line, endLine: targetDiagnostic.line, content: code, reason: `attempt ${attempt}: replace diagnostic line` }
        : { id: `op:${attempt}:insert`, risk: 0.35, kind: "insert", path: context.targetPath, content: `\n${code}\n`, reason: `attempt ${attempt}: append proposal` };
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
    async verify() {
      const tsconfig = input.tsconfigPath ?? path.join(root, "tsconfig.json");
      const command = input.tscCommand ?? { command: process.execPath, args: [path.join(root, "node_modules", "typescript", "bin", "tsc"), "--noEmit", "-p", tsconfig] };
      const result = await runProcess(command.command, command.args, { cwd: root, timeoutMs: 180_000 });
      const diagnostics = parseTscDiagnostics(`${result.stdout}\n${result.stderr}`, root);
      return { buildSucceeded: result.code === 0 && diagnostics.length === 0, testsSucceeded: true, diagnostics };
    }
  };
}

/** TypeScript's own closed class -- keywords and punctuation the decoder may emit besides workspace symbols. Not natural language. */
const TYPESCRIPT_CLOSED_CLASS = ["export", "function", "const", "let", "return", "if", "else", "for", "of", "while", "new", "class", "interface", "type", "import", "from", "async", "await", "string", "number", "boolean", "void", "undefined", "null", "true", "false", "=>", "=", "===", "!==", "+", "-", "*", "/", "%", "<", ">", "<=", ">=", "&&", "||", "!", "?", ":", ";", ",", ".", "(", ")", "{", "}", "[", "]", "readonly", "this", "throw", "try", "catch", "map", "filter", "length", "push", "join", "split", "slice", "reverse"];
