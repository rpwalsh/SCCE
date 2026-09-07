// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { CLANG_FIXIT_REPAIR_FAMILY, type ProgramDiagnostic, type RepairOperation } from "@scce/kernel";
import type { CodeMouthContext, CodeMouthPorts, CodeMouthProposal, CodeMouthVerification } from "./code-mouth.js";

/**
 * The same repair contract as the TypeScript port, over a different compiler.
 *
 * Nothing in runCodeMouth is TypeScript-specific: it retrieves a file, asks for a proposal, applies it, verifies,
 * and rolls back what does not build. The only language-bound part is which fixes the system is allowed to apply,
 * and the rule is identical here -- the compiler supplies the fix, this port only transcribes and verifies it.
 * Clang states its fixes machine-readably under -fdiagnostics-parseable-fixits as an exact range and replacement,
 * so a fix is applied verbatim or not at all; nothing is inferred about what the fix ought to be.
 *
 * A diagnostic offering more than one fix-it is left alone and reported. Choosing between compiler suggestions is a
 * judgement this port does not make, and silently taking the first would be exactly that judgement.
 */
export function createClangCodeMouthPorts(options: {
  workspaceRoot: string;
  compiler?: string;
  compilerArgs?: readonly string[];
  log?: (message: string) => void;
}): CodeMouthPorts {
  const root = path.resolve(options.workspaceRoot);
  const compiler = options.compiler ?? "clang";
  const baseArgs = [...(options.compilerArgs ?? ["-fsyntax-only"]), "-fdiagnostics-parseable-fixits"];
  const log = options.log ?? (() => {});
  let offered: Array<{ diagnosticCode: number; fixName: string; codeFixIdentity: string }> = [];

  const absolute = (relative: string): string => path.resolve(root, relative);

  const runCompiler = async (relativePath: string): Promise<{ stderr: string; code: number | null }> => {
    const target = absolute(relativePath);
    return new Promise(resolve => {
      const child = spawn(compiler, [...baseArgs, target], { cwd: root });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += String(chunk); });
      child.stdout.on("data", () => {});
      child.on("error", error => resolve({ stderr: String(error), code: -1 }));
      child.on("close", code => resolve({ stderr, code }));
    });
  };

  return {
    async retrieve(targetPath: string): Promise<CodeMouthContext> {
      const targetText = await readFile(absolute(targetPath), "utf8");
      return {
        targetPath,
        targetText,
        symbols: [...new Set(targetText.match(/[A-Za-z_][A-Za-z0-9_]*/gu) ?? [])].slice(0, 256),
        imports: (targetText.match(/^\s*#\s*include\s+[<"][^>"]+[>"]/gmu) ?? []).map(line => line.trim()),
        language: clangLanguageOf(targetPath)
      };
    },

    async propose(input): Promise<CodeMouthProposal | undefined> {
      const fixits = parseFixits(input.diagnostics);
      offered = fixits.map(fixit => ({
        diagnosticCode: 0,
        fixName: CLANG_FIXIT_REPAIR_FAMILY,
        codeFixIdentity: fixit.identity
      }));
      // Compared as the same filesystem means it, not as two strings. Clang reports the path with forward slashes
      // while path.resolve produces backslashes here, and Windows treats the two as one file with either case -- so
      // a raw equality check rejected the compiler's own fix for the very file it was asked about.
      const target = comparablePath(path.resolve(root, input.context.targetPath));
      const applicable = fixits.filter(fixit => comparablePath(path.resolve(fixit.file)) === target);
      if (applicable.length !== 1) {
        log(`clang offered ${applicable.length} fix-its for ${input.context.targetPath}; declining to choose`);
        return undefined;
      }
      const fixit = applicable[0]!;
      const lines = input.context.targetText.split(/\r?\n/);
      const line = lines[fixit.line - 1];
      if (line === undefined || fixit.startColumn < 1 || fixit.endColumn - 1 > line.length) return undefined;
      const repaired = `${line.slice(0, fixit.startColumn - 1)}${fixit.replacement}${line.slice(fixit.endColumn - 1)}`;
      if (repaired === line) return undefined;
      const operation: RepairOperation = {
        id: `repair.clang.${fixit.identity}`,
        kind: "replace",
        path: input.context.targetPath,
        startLine: fixit.line,
        endLine: fixit.line,
        content: repaired,
        reason: `clang supplied one fix-it for ${input.context.targetPath}:${fixit.line}:${fixit.startColumn}`,
        risk: 0.1,
        riskStatus: "provisional-uncalibrated"
      };
      return { operations: [operation], surface: repaired.trim() };
    },

    async apply(operations: readonly RepairOperation[]): Promise<() => Promise<void>> {
      const originals = new Map<string, string>();
      for (const operation of operations) {
        if (operation.kind !== "replace" || operation.startLine === undefined || operation.content === undefined) continue;
        const file = absolute(operation.path);
        if (!originals.has(file)) originals.set(file, await readFile(file, "utf8"));
        const text = await readFile(file, "utf8");
        const newline = text.includes("\r\n") ? "\r\n" : "\n";
        const lines = text.split(/\r?\n/);
        const end = operation.endLine ?? operation.startLine;
        lines.splice(operation.startLine - 1, end - operation.startLine + 1, operation.content);
        await writeFile(file, lines.join(newline), "utf8");
      }
      return async () => {
        for (const [file, text] of originals) await writeFile(file, text, "utf8");
      };
    },

    async verify(targetPath?: string): Promise<CodeMouthVerification> {
      if (!targetPath) return { testsRun: false, buildSucceeded: false, testsSucceeded: false, diagnostics: [] };
      const { stderr, code } = await runCompiler(targetPath);
      const diagnostics = parseClangDiagnostics(stderr);
      const buildSucceeded = code === 0 && diagnostics.length === 0;
      // No suite is configured for a bare translation unit, and a suite that never ran has not failed -- the same
      // reading the TypeScript port takes. `testsRun: false` is what keeps that honest: a caller can see that
      // silence here is an absent suite rather than a passing one, and never mistake one for the other.
      return { testsRun: false, buildSucceeded, testsSucceeded: true, diagnostics };
    },

    offeredCandidates: () => offered
  };
}

/** One spelling of a path, so two spellings of the same file compare equal on a case-insensitive filesystem. */
function comparablePath(value: string): string {
  return value.replace(/\\/gu, "/").toLocaleLowerCase();
}

function clangLanguageOf(targetPath: string): string {
  const extension = path.extname(targetPath).toLowerCase();
  if (extension === ".m" || extension === ".mm") return "objective-c";
  if (extension === ".c" || extension === ".h") return "c";
  return "cpp";
}

interface ClangFixit {
  file: string;
  line: number;
  startColumn: number;
  endColumn: number;
  replacement: string;
  identity: string;
}

/** `fix-it:"<file>":{line:col-line:col}:"replacement"` -- clang's own machine-readable statement of the fix. */
function parseFixits(diagnostics: readonly ProgramDiagnostic[]): ClangFixit[] {
  const out: ClangFixit[] = [];
  for (const diagnostic of diagnostics) {
    const match = /^fix-it:"([^"]+)":\{(\d+):(\d+)-(\d+):(\d+)\}:"(.*)"$/u.exec(diagnostic.raw.trim());
    if (!match) continue;
    const [, file, startLine, startColumn, endLine, endColumn, replacement] = match;
    // A fix-it spanning lines is not transcribable as one line replacement, so it is reported rather than guessed at.
    if (startLine !== endLine) continue;
    out.push({
      // Clang escapes the path inside the quoted field, so on Windows every separator arrives doubled. Resolving
      // that string produces a path that never equals the requested file and the fix is silently discarded.
      file: unescapeFixitText(file!),
      line: Number(startLine),
      startColumn: Number(startColumn),
      endColumn: Number(endColumn),
      replacement: unescapeFixitText(replacement ?? ""),
      identity: `${file}:${startLine}:${startColumn}-${endColumn}`
    });
  }
  return out;
}

/**
 * One left-to-right pass, because separate passes read their own output.
 *
 * Replacing `\n` and `\t` before collapsing `\\` corrupts every Windows path clang reports: the escaped form of
 * `Temp\tmp` is `Temp\\tmp`, and a `\t` rule applied first matches the second backslash and turns the directory
 * separator into a tab. The path then names no file, the fix is filtered out as belonging elsewhere, and the
 * compiler's own repair is discarded for a file it was reported against.
 */
function unescapeFixitText(value: string): string {
  return value.replace(/\\(.)/gsu, (_, character: string) =>
    character === "n" ? "\n" : character === "t" ? "\t" : character);
}

/** Clang writes one diagnostic per line as `file:line:col: severity: message`, with fix-its on their own lines. */
export function parseClangDiagnostics(stderr: string): ProgramDiagnostic[] {
  const out: ProgramDiagnostic[] = [];
  for (const raw of stderr.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("fix-it:")) {
      // The file this fix-it belongs to has to be carried on the diagnostic. The repair loop narrows diagnostics to
      // the file being edited before it asks for a proposal, so a fix-it with no path belongs to no file and is
      // discarded before the proposer ever sees it -- the compiler's own fix, dropped for want of an attribution.
      const fixitFile = /^fix-it:"([^"]+)":\{(\d+):/u.exec(line);
      out.push({
        id: `clang.fixit:${out.length}`,
        class: "syntax",
        ...(fixitFile ? { path: path.resolve(unescapeFixitText(fixitFile[1]!)), line: Number(fixitFile[2]) } : {}),
        message: line,
        raw: line,
        confidence: 0.95,
        confidenceStatus: "compiler-observation-identity-not-patch-success-probability"
      });
      continue;
    }
    const match = /^(.+?):(\d+):(\d+):\s+(error|warning|fatal error):\s+(.*)$/u.exec(line);
    if (!match) continue;
    const [, file, lineNumber, column, severity, message] = match;
    if (severity === "warning") continue;
    out.push({
      id: `clang:${file}:${lineNumber}:${column}`,
      class: "syntax",
      path: file,
      line: Number(lineNumber),
      column: Number(column),
      message: message ?? "",
      raw: line,
      confidence: 0.95,
      confidenceStatus: "compiler-observation-identity-not-patch-success-probability"
    });
  }
  return out;
}
