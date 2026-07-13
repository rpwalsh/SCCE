import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

export type LanguageControlSeverity = "fail" | "warn";

export interface LanguageControlIssue {
  path: string;
  line: number;
  ruleId: string;
  severity: LanguageControlSeverity;
  excerpt: string;
}

export interface LanguageControlScanResult {
  root: string;
  scannedFiles: number;
  issueCount: number;
  failed: boolean;
  issues: LanguageControlIssue[];
  ignored: string[];
}

export interface LanguageControlScanOptions {
  root?: string;
  dirs?: string[];
  maxIssues?: number;
}

const DEFAULT_DIRS = [
  "packages/kernel/src",
  "packages/core/src",
  "packages/adapters-node/src",
  "packages/cli/src"
];

const IGNORED_SEGMENTS = new Set([
  "node_modules",
  "dist",
  "coverage",
  "__tests__",
  "fixtures",
  "locales",
  "localization",
  "docs"
]);

const BOUNDARY_COMPATIBILITY_FILES = new Set([
  "packages/kernel/src/legacy-detail-signal-adapter.ts"
]);

const CONTROL_WORDS = [
  "brief",
  "normal",
  "detailed",
  "stepwise",
  "concise",
  "technical",
  "plain",
  "creative",
  "poem",
  "translate",
  "summarize",
  "rewrite",
  "explain",
  "style",
  "tone",
  "verbosity"
];

const DETAIL_DISPLAY_WORDS = [
  "brief",
  "normal",
  "detailed",
  "stepwise"
];

const UNFINISHED_MARKERS = [
  "TODO",
  "FIXME",
  "stub",
  "placeholder implementation",
  "not implemented",
  "fake success"
];

const BLOCKED_TERMS = [
  fromCodes([121, 111, 108, 111]),
  `${fromCodes([115, 101, 115, 115, 105, 111, 110])}_${fromCodes([121, 111, 108, 111])}`,
  `${fromCodes([116, 111, 107, 101, 110])} ${fromCodes([98, 117, 100, 103, 101, 116])}`,
  `${fromCodes([112, 114, 111, 109, 112, 116])} ${fromCodes([98, 117, 100, 103, 101, 116])}`,
  `${fromCodes([99, 111, 110, 116, 101, 120, 116])} ${fromCodes([98, 117, 100, 103, 101, 116])}`,
  `${fromCodes([114, 97, 103])} ${fromCodes([98, 117, 100, 103, 101, 116])}`,
  `${fromCodes([108, 108, 109])} ${fromCodes([98, 117, 100, 103, 101, 116])}`,
  fromCodes([110, 101, 117, 114, 97, 108]),
  `${fromCodes([109, 111, 100, 101, 108])} weight`,
  `${fromCodes([116, 114, 97, 110, 115, 102, 111, 114, 109, 101, 114])} weight`,
  `${fromCodes([110, 101, 117, 114, 97, 108])} parameter`,
  `${fromCodes([101, 109, 98, 101, 100, 100, 105, 110, 103])} weight`
];

export async function scanLanguageControlHygiene(options: LanguageControlScanOptions = {}): Promise<LanguageControlScanResult> {
  const root = path.resolve(options.root ?? process.cwd());
  const dirs = options.dirs ?? DEFAULT_DIRS;
  const maxIssues = options.maxIssues ?? 500;
  const issues: LanguageControlIssue[] = [];
  const ignored: string[] = [];
  let scannedFiles = 0;

  for (const dir of dirs) {
    const absolute = path.resolve(root, dir);
    if (!absolute.startsWith(root)) continue;
    const exists = await existsPath(absolute);
    if (!exists) {
      ignored.push(relativePath(root, absolute));
      continue;
    }
    for await (const file of walkSourceFiles(root, absolute, ignored)) {
      scannedFiles++;
      const text = await readFile(file, "utf8");
      scanFile(root, file, text, issues, maxIssues);
      if (issues.length >= maxIssues) break;
    }
    if (issues.length >= maxIssues) break;
  }

  return {
    root,
    scannedFiles,
    issueCount: issues.length,
    failed: issues.some(issue => issue.severity === "fail"),
    issues,
    ignored
  };
}

async function* walkSourceFiles(root: string, dir: string, ignored: string[]): AsyncGenerator<string> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(dir, entry.name);
    const rel = relativePath(root, absolute);
    if (shouldIgnorePath(rel)) {
      ignored.push(rel);
      continue;
    }
    if (entry.isDirectory()) {
      yield* walkSourceFiles(root, absolute, ignored);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts") && entry.name !== "language-control-hygiene.ts") yield absolute;
  }
}

function scanFile(root: string, file: string, text: string, issues: LanguageControlIssue[], maxIssues: number): void {
  const rel = relativePath(root, file);
  const lines = splitLines(text);
  for (let index = 0; index < lines.length && issues.length < maxIssues; index++) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (containsAny(line, BLOCKED_TERMS)) pushIssue(issues, rel, index + 1, "blocked_term", "fail", line);
    if (containsAny(line, UNFINISHED_MARKERS)) pushIssue(issues, rel, index + 1, "unfinished_marker", "fail", line);
    if (looksLikePromptStringRouter(line)) pushIssue(issues, rel, index + 1, "prompt_text_router", "fail", line);
    if (looksLikeDisplayBranch(line)) pushIssue(issues, rel, index + 1, "display_string_branch", "fail", line);
    if (looksLikeLegacyDetailSignalFlow(line)) pushIssue(issues, rel, index + 1, "legacy_detail_signal_runtime", "fail", line);
    if (looksLikeRegexCorrectionParser(line)) pushIssue(issues, rel, index + 1, "regex_correction_parser", "fail", line);
    if (looksLikeRuntimeOperationLabel(line)) pushIssue(issues, rel, index + 1, "operation_display_label", "fail", line);
    if (looksLikeLooseSectionClassifier(line)) pushIssue(issues, rel, index + 1, "loose_section_classifier", "fail", line);
    if (looksLikeCannedSurface(line)) pushIssue(issues, rel, index + 1, "runtime_canned_surface", "fail", line);
    if (looksLikeRuntimeSurfaceFallback(line)) pushIssue(issues, rel, index + 1, "runtime_surface_fallback", "fail", line);
  }
}

function looksLikePromptStringRouter(line: string): boolean {
  const lower = line.toLocaleLowerCase();
  const stringRouter = lower.includes(".includes(") || lower.includes(".startsWith(") || lower.includes(".endsWith(");
  const regexRouter = lower.includes(".match(") || lower.includes(".search(") || lower.includes(".test(") || lower.includes("new regexp");
  if (!(stringRouter || regexRouter)) return false;
  if (!(lower.includes("prompt") || lower.includes("input") || lower.includes("request") || lower.includes("text"))) return false;
  return containsControlLiteral(lower);
}

function looksLikeDisplayBranch(line: string): boolean {
  const lower = line.toLocaleLowerCase();
  if (looksLikeTypeOrSchemaDeclaration(lower)) return false;
  if (!(lower.includes("if (") || lower.includes("case ") || lower.includes(" ? ") || lower.trimStart().startsWith("? "))) return false;
  if (lower.includes("construct")) return false;
  if (DETAIL_DISPLAY_WORDS.some(word => containsRuntimeLiteral(lower, word))) return true;
  if (!(lower.includes("detail") || lower.includes("style") || lower.includes("surface") || lower.includes("operation") || lower.includes("action"))) return false;
  return containsControlLiteral(lower);
}

function looksLikeLegacyDetailSignalFlow(line: string): boolean {
  const lower = line.toLocaleLowerCase();
  if (looksLikeTypeOrSchemaDeclaration(lower)) return false;
  if (!lower.includes("legacydetailsignal")) return false;
  return lower.includes("input.detaillevel")
    || lower.includes("correctioninfluence.detaillevel")
    || lower.includes(":")
    || lower.includes("=");
}

function looksLikeRegexCorrectionParser(line: string): boolean {
  const lower = line.toLocaleLowerCase();
  const regexRouter = lower.includes(".match(") || lower.includes(".search(") || lower.includes(".test(") || lower.includes("new regexp");
  if (!regexRouter) return false;
  return lower.includes("feedback") || lower.includes("correction") || lower.includes("owner");
}

function looksLikeRuntimeSurfaceFallback(line: string): boolean {
  const lower = line.toLocaleLowerCase();
  if (!lower.includes("fallback")) return false;
  return lower.includes("answer") || lower.includes("message") || lower.includes("surface") || lower.includes("speech");
}

function looksLikeRuntimeOperationLabel(line: string): boolean {
  const lower = line.toLocaleLowerCase();
  return lower.includes("operation(") && containsControlLiteral(lower);
}

function containsControlLiteral(lowerLine: string): boolean {
  return CONTROL_WORDS.some(word => containsRuntimeLiteral(lowerLine, word));
}

function containsRuntimeLiteral(lowerLine: string, word: string): boolean {
  return lowerLine.includes(`"${word}"`)
    || lowerLine.includes(`'${word}'`)
    || lowerLine.includes(`/${word}`)
    || lowerLine.includes(`${word}/`);
}

function looksLikeLooseSectionClassifier(line: string): boolean {
  const lower = line.toLocaleLowerCase();
  if (!(lower.includes(".includes(") || lower.includes(".startsWith(") || lower.includes(".endsWith("))) return false;
  if (!(lower.includes("lower") || lower.includes("normalized") || lower.includes("name") || lower.includes("path"))) return false;
  return lower.includes("\"code\"") || lower.includes("'code'") || lower.includes("\"model\"") || lower.includes("'model'");
}

function looksLikeCannedSurface(line: string): boolean {
  const trimmed = line.trim();
  const lower = trimmed.toLocaleLowerCase();
  if (!(lower.includes("candidate(") || lower.includes("answer =") || lower.includes("message:"))) return false;
  const firstQuote = firstQuoteIndex(trimmed);
  if (firstQuote < 0) return false;
  const quoted = quotedStringAt(trimmed, firstQuote);
  if (!quoted) return false;
  const profileKey = quoted.startsWith("surface.") || quoted.startsWith("validation.") || quoted.startsWith("inspect.");
  if (profileKey) return false;
  return countWords(quoted) >= 3;
}

function looksLikeTypeOrSchemaDeclaration(lowerLine: string): boolean {
  const trimmed = lowerLine.trimStart();
  return trimmed.startsWith("export type ")
    || trimmed.startsWith("type ")
    || trimmed.startsWith("| ")
    || trimmed.startsWith("source:")
    || trimmed.startsWith("role:")
    || trimmed.startsWith("kind:");
}

function pushIssue(issues: LanguageControlIssue[], file: string, line: number, ruleId: string, severity: LanguageControlSeverity, excerpt: string): void {
  issues.push({ path: file, line, ruleId, severity, excerpt: excerpt.trim().slice(0, 240) });
}

function shouldIgnorePath(rel: string): boolean {
  if (BOUNDARY_COMPATIBILITY_FILES.has(rel.split(path.sep).join("/"))) return true;
  const parts = rel.split(path.sep).flatMap(part => part.split("/"));
  if (parts.some(part => IGNORED_SEGMENTS.has(part))) return true;
  return rel.endsWith(".test.ts") || rel.endsWith(".spec.ts") || rel.includes("fixture");
}

async function existsPath(value: string): Promise<boolean> {
  try {
    await stat(value);
    return true;
  } catch {
    return false;
  }
}

function containsAny(value: string, needles: readonly string[]): boolean {
  const lower = value.toLocaleLowerCase();
  return needles.some(needle => lower.includes(needle.toLocaleLowerCase()));
}

function firstQuoteIndex(value: string): number {
  const single = value.indexOf("'");
  const double = value.indexOf("\"");
  if (single < 0) return double;
  if (double < 0) return single;
  return Math.min(single, double);
}

function quotedStringAt(value: string, start: number): string | undefined {
  const quote = value[start];
  if (quote !== "\"" && quote !== "'") return undefined;
  let out = "";
  let escaped = false;
  for (let i = start + 1; i < value.length; i++) {
    const ch = value[i] ?? "";
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === quote) return out;
    out += ch;
  }
  return undefined;
}

function countWords(value: string): number {
  let words = 0;
  let inWord = false;
  for (const ch of value) {
    const word = isWordChar(ch);
    if (word && !inWord) words++;
    inWord = word;
  }
  return words;
}

function isWordChar(ch: string): boolean {
  if (!ch) return false;
  if (ch === "_" || ch === "-") return true;
  const cp = ch.codePointAt(0) ?? 0;
  if (cp >= 48 && cp <= 57) return true;
  return ch.toLocaleLowerCase() !== ch.toLocaleUpperCase();
}

function splitLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const ch of text) {
    if (ch === "\r") continue;
    if (ch === "\n") {
      lines.push(current);
      current = "";
    } else current += ch;
  }
  lines.push(current);
  return lines;
}

function relativePath(root: string, value: string): string {
  return path.relative(root, value).split(path.sep).join("/");
}

function fromCodes(codes: readonly number[]): string {
  return String.fromCharCode(...codes);
}
