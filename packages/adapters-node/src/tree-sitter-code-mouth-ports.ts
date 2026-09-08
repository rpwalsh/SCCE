// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Buffer } from "node:buffer";
import path from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { codeLanguageForPath, type ProgramDiagnostic, type RepairOperation } from "@scce/kernel";
import { languageIdForFilePath, parseRepositorySyntax, type TreeSitterLanguageId } from "./tree-sitter-syntax.js";
import type { CodeMouthContext, CodeMouthPorts, CodeMouthProposal, CodeMouthVerification } from "./code-mouth.js";
import type { LearnedCodeProposer } from "./learned-code-proposer.js";
import { findCodeVerifierForPath } from "./code-verifier-discovery.js";
import { runProcess } from "./document.js";

/**
 * The repair contract over a parser instead of a compiler.
 *
 * `runCodeMouth` needs a verifier, not a compiler: retrieve, propose, apply, verify, roll back what does not
 * pass. TypeScript and the C family have compiler ports, and every other language the corpus can be trained on
 * has had none -- not because the composition is language-specific, which it is not, but because nothing could
 * say whether a composition was valid.
 *
 * A grammar can say one thing, and it is worth having: whether the file still parses. Every grammar this system
 * already carries as WebAssembly answers that with no toolchain installed anywhere, which is what makes the lane
 * reach Python and JavaScript today rather than after a build environment is provisioned.
 *
 * What this gate does not do is bound the meaning of a program. A parse says a file is well formed, not that it
 * is well typed or that it does anything in particular, so `buildSucceeded` here is a strictly weaker claim than
 * the same field from a compiler port. It is reported as its own kind of evidence rather than dressed up as the
 * other, and a caller with a compiler for the language should prefer that port.
 */
export function createTreeSitterCodeMouthPorts(options: {
  workspaceRoot: string;
  /** The learned lane. Composition leads; there is no compiler-owned fallback, because there is no compiler. */
  learnedProposer?: LearnedCodeProposer;
  log?: (message: string) => void;
}): CodeMouthPorts {
  const root = path.resolve(options.workspaceRoot);
  const absolute = (relative: string): string => path.resolve(root, relative);

  return {
    async retrieve(targetPath: string): Promise<CodeMouthContext> {
      const targetText = await readFile(absolute(targetPath), "utf8").catch(() => "");
      return {
        targetPath,
        targetText,
        symbols: [...new Set(targetText.match(/[\p{Letter}_$][\p{Letter}\p{Number}_$]*/gu) ?? [])].slice(0, 2000),
        imports: [],
        language: codeLanguageForPath(targetPath) ?? languageIdForFilePath(targetPath) ?? "unknown"
      };
    },

    async propose(input): Promise<CodeMouthProposal | undefined> {
      const learned = await options.learnedProposer?.propose(input);
      return learned ? { ...learned, source: "learned_construction" } : undefined;
    },

    async apply(operations: readonly RepairOperation[]): Promise<() => Promise<void>> {
      const originals = new Map<string, string>();
      for (const operation of operations) {
        if (operation.kind !== "replace" || operation.startLine === undefined || operation.content === undefined) continue;
        const file = absolute(operation.path);
        const current = originals.get(file) ?? await readFile(file, "utf8").catch(() => "");
        if (!originals.has(file)) originals.set(file, current);
        // The file's own line ending, kept, on the same terms as the TypeScript port.
        const newline = current.includes("\r\n") ? "\r\n" : "\n";
        const lines = current.split(/\r?\n/u);
        const end = operation.endLine ?? operation.startLine;
        lines.splice(operation.startLine - 1, end - operation.startLine + 1, ...operation.content.split(/\r?\n/u));
        await writeFile(file, lines.join(newline), "utf8");
      }
      return async () => {
        for (const [file, text] of originals) await writeFile(file, text, "utf8");
      };
    },

    async verify(targetPath?: string): Promise<CodeMouthVerification> {
      if (!targetPath) return { testsRun: false, buildSucceeded: false, testsSucceeded: true, diagnostics: [] };
      // The strongest verifier this machine has for this language. A checker the language itself ships bounds
      // more than a grammar does -- scopes, arity, imports -- so it is preferred wherever it is installed, and
      // the grammar is what remains when nothing is.
      const checker = await findCodeVerifierForPath(targetPath);
      if (checker) {
        const file = absolute(targetPath);
        const result = await runProcess(checker.command, [...checker.checkArgs(file)], { cwd: root, timeoutMs: 120_000 });
        const diagnostics = checkerDiagnostics(result, targetPath, checker.languageId);
        options.log?.(`${checker.languageId} checked by ${checker.command} (${diagnostics.length} diagnostic(s))`);
        return { testsRun: false, buildSucceeded: result.code === 0 && !diagnostics.length, testsSucceeded: true, diagnostics };
      }
      const languageId = languageIdForFilePath(targetPath);
      if (!languageId) {
        // No grammar, no gate: saying a file is valid because nothing could check it is the one answer that
        // would make every guarantee in this lane meaningless.
        return {
          testsRun: false,
          buildSucceeded: false,
          testsSucceeded: true,
          diagnostics: [unverifiableDiagnostic(targetPath)]
        };
      }
      const text = await readFile(absolute(targetPath), "utf8").catch(() => "");
      const diagnostics = await parseDiagnostics({ targetPath, languageId, text });
      return { testsRun: false, buildSucceeded: diagnostics.length === 0, testsSucceeded: true, diagnostics };
    }
  };
}

/**
 * Where a grammar failed to parse, as diagnostics the repair loop already understands.
 *
 * One per error region rather than one per file, because the loop converges by watching a count fall and a
 * single boolean cannot tell it whether an edit helped.
 */
export async function parseDiagnostics(input: {
  targetPath: string;
  languageId: TreeSitterLanguageId;
  text: string;
}): Promise<ProgramDiagnostic[]> {
  const parsed = await parseRepositorySyntax({
    fileId: input.targetPath,
    languageId: input.languageId,
    text: input.text
  }).catch(() => undefined);
  if (!parsed) return [unverifiableDiagnostic(input.targetPath)];
  return parsed.errors.map(error => {
    const { line, column } = lineAndColumn(input.text, error.byteStart);
    return {
      id: `parse:${input.targetPath}:${error.kind}:${error.byteStart}:${error.grammarNodeType}`,
      class: "syntax" as const,
      patternId: `parse.${error.kind}`,
      path: input.targetPath,
      line,
      column,
      message: error.kind === "missing"
        ? `${input.languageId} grammar expected ${error.grammarNodeType} here`
        : `${input.languageId} grammar could not parse this region`,
      raw: error.grammarNodeType,
      confidence: 0.9,
      confidenceStatus: "compiler-observation-identity-not-patch-success-probability" as const
    };
  });
}

/**
 * A path, a line, an optional column and a message: the only shape every language's checker output shares.
 */
/**
 * The other shape, which Python and several others print: a quoted path on one line and the complaint below.
 * Read as a location plus whatever the checker last said, because the loop needs where and how many, and the
 * prose is for a person.
 */
const QUOTED_PATH_DIAGNOSTIC = new RegExp(String.raw`^\s*File\s+"[^"]+",\s*line\s+(\d+)`, "u");

const LOCATED_DIAGNOSTIC = new RegExp(
  String.raw`^(.*?)[:(](\d+)(?:[:,](\d+))?[:)]?\s*(.*)$`,
  "u"
);

/**
 * A discovered checker's output as diagnostics.
 *
 * Every language prints them differently and none of them prints them the way any other does, so what is read
 * here is the shape they share: a path, a line, and a message. A non-zero exit with nothing parseable is still a
 * failure -- reported as one diagnostic rather than silently as success, because a checker that failed for a
 * reason this code cannot read has not approved anything.
 */
function checkerDiagnostics(
  result: { code: number | null; stdout: string; stderr: string },
  targetPath: string,
  languageId: string
): ProgramDiagnostic[] {
  const out: ProgramDiagnostic[] = [];
  const text = `${result.stdout}\n${result.stderr}`;
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const quoted = QUOTED_PATH_DIAGNOSTIC.exec(trimmed);
    if (quoted) {
      const complaint = text.split(/\r?\n/u).map(row => row.trim()).filter(Boolean).pop() ?? trimmed;
      out.push({
        id: `${languageId}:${quoted[1]}:${complaint.slice(0, 48)}`,
        class: "syntax",
        patternId: `${languageId}.checker`,
        path: targetPath,
        line: Number(quoted[1]),
        message: complaint,
        raw: trimmed,
        confidence: 0.9,
        confidenceStatus: "compiler-observation-identity-not-patch-success-probability"
      });
      continue;
    }
    const located = LOCATED_DIAGNOSTIC.exec(trimmed);
    if (!located) continue;
    const message = (located[4] ?? "").trim();
    if (!message) continue;
    out.push({
      // Line, column and message identify a diagnostic; the path is already the file being checked.
      id: `${languageId}:${located[2]}:${located[3] ?? 0}:${message.slice(0, 48)}`,
      class: "syntax",
      patternId: `${languageId}.checker`,
      path: targetPath,
      line: Number(located[2]),
      ...(located[3] ? { column: Number(located[3]) } : {}),
      message,
      raw: trimmed,
      confidence: 0.9,
      confidenceStatus: "compiler-observation-identity-not-patch-success-probability"
    });
  }
  if (result.code !== 0 && !out.length) {
    out.push({
      id: `${languageId}:unreadable`,
      class: "unknown",
      path: targetPath,
      message: `${languageId} checker failed without output this system could read`,
      raw: text.trim().slice(0, 300),
      confidence: 1
    });
  }
  return out;
}

/** A byte offset as the line and column a repair site is expressed in. */
function lineAndColumn(text: string, byteOffset: number): { line: number; column: number } {
  const before = Buffer.from(text, "utf8").subarray(0, Math.max(0, byteOffset)).toString("utf8");
  const lines = before.split(/\r?\n/u);
  return { line: lines.length, column: (lines[lines.length - 1]?.length ?? 0) + 1 };
}

/** A file nothing could check is not a file that passed. */
function unverifiableDiagnostic(targetPath: string): ProgramDiagnostic {
  return {
    id: `parse:unavailable:${targetPath}`,
    class: "unknown",
    path: targetPath,
    message: "no grammar is available for this file, so nothing verified it",
    raw: targetPath,
    confidence: 1
  };
}
