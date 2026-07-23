import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

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
  const source = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const emitted = new Set<string>();
  const reportPosition = (position: number, ruleId: string): void => {
    if (issues.length >= maxIssues) return;
    const line = source.getLineAndCharacterOfPosition(Math.max(0, position)).line;
    const key = `${ruleId}:${line}`;
    if (emitted.has(key)) return;
    emitted.add(key);
    pushIssue(issues, rel, line + 1, ruleId, "fail", lines[line] ?? "");
  };
  const reportNode = (node: ts.Node, ruleId: string): void => reportPosition(node.getStart(source, false), ruleId);

  for (let index = 0; index < lines.length && issues.length < maxIssues; index++) {
    const line = lines[index] ?? "";
    if (containsAny(line, BLOCKED_TERMS)) reportPosition(source.getPositionOfLineAndCharacter(index, 0), "blocked_term");
  }
  scanUnfinishedMarkers(text, source, reportPosition);

  const visit = (node: ts.Node): void => {
    if (issues.length >= maxIssues) return;
    if (ts.isCallExpression(node)) {
      if (isPromptTextRouter(node)) reportNode(node, "prompt_text_router");
      if (isRegexCorrectionParser(node)) reportNode(node, "regex_correction_parser");
      if (isRuntimeOperationLabel(node)) reportNode(node, "operation_display_label");
      if (isLooseSectionClassifier(node)) reportNode(node, "loose_section_classifier");
      if (isCannedCandidateCall(node)) reportNode(node, "runtime_canned_surface");
    }
    if (ts.isIfStatement(node) && isDisplayStringCondition(node.expression)) {
      reportNode(node.expression, "display_string_branch");
    }
    if (ts.isConditionalExpression(node) && isDisplayStringCondition(node.condition)) {
      reportNode(node.condition, "display_string_branch");
    }
    if (ts.isCaseClause(node) && ts.isSwitchStatement(node.parent.parent)
      && isDisplayStringCondition(node.expression, node.parent.parent.expression)) {
      reportNode(node.expression, "display_string_branch");
    }
    if (ts.isPropertyAssignment(node)) {
      if (isLegacyDetailSignalProperty(node)) reportNode(node, "legacy_detail_signal_runtime");
      if (isCannedSurfaceProperty(node)) reportNode(node, "runtime_canned_surface");
    }
    if (ts.isVariableDeclaration(node)) {
      if (isCannedAnswerDeclaration(node)) reportNode(node, "runtime_canned_surface");
      if (isRuntimeSurfaceFallback(node)) reportNode(node, "runtime_surface_fallback");
    }
    if (ts.isBinaryExpression(node) && isCannedAnswerAssignment(node)) reportNode(node, "runtime_canned_surface");
    ts.forEachChild(node, visit);
  };
  visit(source);
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

function isPromptTextRouter(node: ts.CallExpression): boolean {
  const access = propertyCall(node);
  if (!access || !containsControlLiteral(node.getText().toLocaleLowerCase())) return false;
  if (["includes", "startswith", "endswith", "match", "search"].includes(access.method)) {
    return hasRawTextSignal(access.receiver);
  }
  if (access.method !== "test" || !isInlineRegularExpression(access.receiver)) return false;
  return node.arguments.some(hasRawTextSignal);
}

function isDisplayStringCondition(condition: ts.Expression, selector?: ts.Expression): boolean {
  const lower = `${selector?.getText() ?? ""} ${condition.getText()}`.toLocaleLowerCase();
  if (!containsControlLiteral(lower) || lower.includes("construct")) return false;
  if (DETAIL_DISPLAY_WORDS.some(word => containsRuntimeLiteral(lower, word))) return true;
  return expressionIdentifiers(selector ?? condition).some(name =>
    ["detail", "style", "surface", "operation", "action"].some(signal => name.includes(signal))
  );
}

function isLegacyDetailSignalProperty(node: ts.PropertyAssignment): boolean {
  return propertyName(node.name) === "legacydetailsignal"
    && expressionIdentifiers(node.initializer).some(name => name.includes("detaillevel"));
}

function isRegexCorrectionParser(node: ts.CallExpression): boolean {
  const access = propertyCall(node);
  if (!access || !["match", "search", "test"].includes(access.method)) return false;
  if (access.method === "match" || access.method === "search") return hasCorrectionSignal(access.receiver);
  return node.arguments.some(hasCorrectionSignal);
}

function isRuntimeOperationLabel(node: ts.CallExpression): boolean {
  const called = callName(node.expression);
  return called === "operation" && containsControlLiteral(node.getText().toLocaleLowerCase());
}

function isLooseSectionClassifier(node: ts.CallExpression): boolean {
  const access = propertyCall(node);
  if (!access || !["includes", "startswith", "endswith"].includes(access.method)) return false;
  if (!expressionIdentifiers(access.receiver).some(name => ["lower", "normalized", "name", "path"].includes(name))) return false;
  return node.arguments.some(argument => {
    const value = staticString(argument)?.toLocaleLowerCase();
    return value === "code" || value === "model";
  });
}

function isCannedCandidateCall(node: ts.CallExpression): boolean {
  const called = callName(node.expression);
  if (!called.endsWith("candidate")) return false;
  return isCannedSurfaceLiteral(node.arguments[0]);
}

function isCannedAnswerDeclaration(node: ts.VariableDeclaration): boolean {
  return bindingName(node.name) === "answer" && isCannedSurfaceLiteral(node.initializer);
}

function isCannedAnswerAssignment(node: ts.BinaryExpression): boolean {
  if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false;
  return terminalExpressionName(node.left) === "answer" && isCannedSurfaceLiteral(node.right);
}

function isCannedSurfaceProperty(node: ts.PropertyAssignment): boolean {
  const name = propertyName(node.name);
  if (name === "answer") {
    return isCannedSurfaceLiteral(node.initializer) && enclosingCallableNames(node).some(isSurfaceCallableName);
  }
  if (name !== "message" || !isCannedSurfaceLiteral(node.initializer)) return false;
  if (isStructuredDiagnosticObject(node.parent)) return false;
  return enclosingCallableNames(node).some(isSurfaceCallableName);
}

function isRuntimeSurfaceFallback(node: ts.VariableDeclaration): boolean {
  const name = bindingName(node.name);
  if (!name.includes("fallback") || !node.initializer || !hasRawTextSignalInTree(node.initializer)) return false;
  return name.includes("surface") || name.includes("answer") || name.includes("message") || name.includes("speech")
    || enclosingCallableNames(node).some(isRuntimeSurfaceCallableName);
}

function isCannedSurfaceLiteral(node: ts.Expression | undefined): boolean {
  const value = staticString(node);
  if (!value) return false;
  if (value.startsWith("surface.") || value.startsWith("validation.") || value.startsWith("inspect.")) return false;
  if (!/\s/u.test(value) && /^[\p{L}\p{N}_-]+(?:[.:][\p{L}\p{N}_-]+){2,}$/u.test(value)) return false;
  return countWords(value) >= 3;
}

function isStructuredDiagnosticObject(node: ts.ObjectLiteralExpression): boolean {
  const names = new Set(node.properties
    .filter(ts.isPropertyAssignment)
    .map(property => propertyName(property.name)));
  return ["severity", "level", "passed", "evidence", "code", "category"].some(name => names.has(name));
}

function scanUnfinishedMarkers(text: string, source: ts.SourceFile, report: (position: number, ruleId: string) => void): void {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, text);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if ((token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia)
      && containsUnfinishedMarker(scanner.getTokenText())) {
      report(scanner.getTokenPos(), "unfinished_marker");
    }
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && containsUnfinishedMarker(node.text)) {
      report(node.getStart(source, false), "unfinished_marker");
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
}

function containsUnfinishedMarker(value: string): boolean {
  return UNFINISHED_MARKERS.some(marker => {
    const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(^|[^A-Za-z0-9_])${escaped}($|[^A-Za-z0-9_])`, "iu").test(value);
  });
}

function propertyCall(node: ts.CallExpression): { receiver: ts.Expression; method: string } | undefined {
  if (!ts.isPropertyAccessExpression(node.expression)) return undefined;
  return { receiver: node.expression.expression, method: node.expression.name.text.toLocaleLowerCase() };
}

function callName(expression: ts.LeftHandSideExpression): string {
  if (ts.isIdentifier(expression)) return expression.text.toLocaleLowerCase();
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text.toLocaleLowerCase();
  return "";
}

function staticString(node: ts.Expression | undefined): string | undefined {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}

function propertyName(name: ts.PropertyName): string {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text.toLocaleLowerCase();
  return name.getText().toLocaleLowerCase();
}

function bindingName(name: ts.BindingName): string {
  return ts.isIdentifier(name) ? name.text.toLocaleLowerCase() : "";
}

function terminalExpressionName(expression: ts.Expression): string {
  if (ts.isIdentifier(expression)) return expression.text.toLocaleLowerCase();
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text.toLocaleLowerCase();
  return "";
}

function hasRawTextSignal(expression: ts.Expression): boolean {
  if (ts.isIdentifier(expression)) return isRawTextName(expression.text);
  if (ts.isPropertyAccessExpression(expression)) return isRawTextName(expression.name.text);
  if (ts.isElementAccessExpression(expression)) return isRawTextName(staticString(expression.argumentExpression) ?? "");
  if (ts.isParenthesizedExpression(expression)) return hasRawTextSignal(expression.expression);
  return false;
}

function hasRawTextSignalInTree(node: ts.Node): boolean {
  let matched = false;
  const visit = (child: ts.Node): void => {
    if (matched) return;
    if (ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) {
      if (hasRawTextSignal(child)) matched = true;
      else if (ts.isCallExpression(child.parent) && child.parent.expression === child) visit(child.expression);
      return;
    }
    if (ts.isExpression(child) && hasRawTextSignal(child)) matched = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return matched;
}

function isRawTextName(value: string): boolean {
  const lower = value.toLocaleLowerCase();
  if (["prompt", "request", "text", "input", "normalized", "lower"].includes(lower)) return true;
  return lower.endsWith("text") && ["prompt", "request", "input", "owner", "query"].some(prefix => lower.startsWith(prefix));
}

function hasCorrectionSignal(node: ts.Node): boolean {
  return expressionIdentifiers(node).some(name => name.includes("feedback") || name.includes("correction"));
}

function expressionIdentifiers(node: ts.Node): string[] {
  const names: string[] = [];
  const visit = (child: ts.Node): void => {
    if (ts.isIdentifier(child)) names.push(child.text.toLocaleLowerCase());
    ts.forEachChild(child, visit);
  };
  visit(node);
  return names;
}

function isInlineRegularExpression(expression: ts.Expression): boolean {
  if (expression.kind === ts.SyntaxKind.RegularExpressionLiteral) return true;
  return ts.isNewExpression(expression) && callName(expression.expression) === "regexp";
}

function enclosingCallableNames(node: ts.Node): string[] {
  const names: string[] = [];
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current)) && current.name) {
      names.push(current.name.getText().toLocaleLowerCase());
    } else if ((ts.isFunctionExpression(current) || ts.isArrowFunction(current)) && current.parent) {
      if (ts.isVariableDeclaration(current.parent)) names.push(bindingName(current.parent.name));
      if (ts.isPropertyAssignment(current.parent)) names.push(propertyName(current.parent.name));
    }
  }
  return names;
}

function isSurfaceCallableName(name: string): boolean {
  return ["speak", "answer", "respond", "reply", "surface", "realiz", "emit", "mouth", "candidate", "focus"]
    .some(signal => name.includes(signal));
}

function isRuntimeSurfaceCallableName(name: string): boolean {
  return ["speak", "answer", "respond", "reply", "surface", "realiz", "emit", "mouth", "focus"]
    .some(signal => name.includes(signal));
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
