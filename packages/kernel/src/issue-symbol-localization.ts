/**
 * Plan items 185-186. Issue-to-symbol localization: given a natural-
 * language bug/issue description and a set of real source files, rank the
 * symbols most likely responsible for it, with the actual matched terms
 * as evidence -- never a fabricated confidence score with no traceable
 * basis. Deliberately a lightweight regex-based symbol extractor across
 * two real language boundaries this repository actually has: TypeScript/
 * JavaScript declarations, and the SQL DDL (`CREATE TABLE`) embedded as
 * template-literal strings inside packages/adapters-node/src/postgres.ts
 * -- not a full compiler-based or cross-language-server resolver, which
 * would be a separate, much larger undertaking.
 *
 * Scoring is a transparent, inspectable keyword-overlap heuristic: split
 * the issue text and each symbol's own name/declaration/leading-comment
 * into normalized word tokens, and score by weighted overlap (an exact
 * symbol-name mention counts far more than an incidental comment-word
 * match). This is a real, bounded, honestly-scoped localizer -- a ranked
 * shortlist of "these symbols mention what you described, ranked by how
 * much", not a claim that any candidate is confirmed responsible for the
 * issue. A human (or a further bounded-debugging step) still decides.
 */

export type SourceSymbolKind = "function" | "class" | "const" | "interface" | "type" | "sql_table";

export interface SourceSymbol {
  /** Stable, human-readable id: "<path>#<name>" for TS/JS, "<path>#TABLE:<name>" for SQL DDL. */
  id: string;
  kind: SourceSymbolKind;
  name: string;
  path: string;
  /** 1-indexed, inclusive. */
  lineStart: number;
  lineEnd: number;
  /** The declaration line plus up to 3 immediately preceding comment lines, used for keyword matching. */
  context: string;
}

export interface SymbolLocalizationCandidate {
  symbol: SourceSymbol;
  score: number;
  /** The exact issue-text terms that matched this symbol -- the real evidence behind `score`. */
  matchedTerms: string[];
}

const TS_DECLARATION_PATTERNS: ReadonlyArray<{ kind: SourceSymbolKind; pattern: RegExp }> = [
  { kind: "function", pattern: /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/ },
  { kind: "function", pattern: /^\s*(?:async\s+)?function\s+(\w+)/ },
  { kind: "class", pattern: /^\s*export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/ },
  { kind: "class", pattern: /^\s*(?:abstract\s+)?class\s+(\w+)/ },
  { kind: "interface", pattern: /^\s*export\s+interface\s+(\w+)/ },
  { kind: "type", pattern: /^\s*export\s+type\s+(\w+)\s*=/ },
  { kind: "const", pattern: /^\s*export\s+const\s+(\w+)\s*[:=]/ },
  { kind: "const", pattern: /^\s*const\s+(\w+)\s*[:=]/ }
];

const SQL_CREATE_TABLE_PATTERN = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:\$\{[^}]+\}\.|[\w.]+\.)?(\w+)/gi;

/**
 * Real regex-based TS/JS declaration extraction, one symbol per matched
 * top-level-ish declaration line. Deliberately line-oriented (not brace-
 * depth-aware): this repo's real style always puts these declarations at
 * the start of a line, so this stays honest about not being a real parser
 * while still matching real code, not a synthetic subset invented for the
 * test.
 */
export function extractTypeScriptSymbols(path: string, text: string): SourceSymbol[] {
  const lines = text.split("\n");
  const symbols: SourceSymbol[] = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    for (const { kind, pattern } of TS_DECLARATION_PATTERNS) {
      const match = pattern.exec(line);
      if (!match?.[1]) continue;
      const name = match[1];
      const lineStart = index + 1;
      const lineEnd = declarationEndLine(lines, index);
      const contextLines = [...leadingCommentLines(lines, index), line];
      symbols.push({
        id: `${path}#${name}`,
        kind,
        name,
        path,
        lineStart,
        lineEnd,
        context: contextLines.join("\n")
      });
      break;
    }
  }
  return symbols;
}

/** Finds `CREATE TABLE` DDL embedded in JS/TS template-literal strings (this repo's real SQL boundary). */
export function extractSqlTableSymbols(path: string, text: string): SourceSymbol[] {
  const symbols: SourceSymbol[] = [];
  for (const match of text.matchAll(SQL_CREATE_TABLE_PATTERN)) {
    const name = match[1];
    if (!name) continue;
    const offset = match.index ?? 0;
    const lineStart = 1 + countNewlinesBefore(text, offset);
    const statementEnd = findMatchingCloseParen(text, offset);
    const lineEnd = statementEnd === undefined ? lineStart : 1 + countNewlinesBefore(text, statementEnd);
    symbols.push({
      id: `${path}#TABLE:${name}`,
      kind: "sql_table",
      name,
      path,
      lineStart,
      lineEnd,
      context: text.slice(offset, statementEnd !== undefined ? statementEnd + 1 : offset + match[0].length)
    });
  }
  return symbols;
}

/** Extracts every symbol this module knows how to find (TS/JS declarations plus embedded SQL DDL) from one file. */
export function extractFileSymbols(path: string, text: string): SourceSymbol[] {
  return [...extractTypeScriptSymbols(path, text), ...extractSqlTableSymbols(path, text)];
}

export function localizeIssueToSymbols(
  issueText: string,
  symbols: readonly SourceSymbol[],
  options: { limit?: number } = {}
): SymbolLocalizationCandidate[] {
  const issueTerms = new Set(tokenize(issueText));
  if (!issueTerms.size) return [];
  const candidates: SymbolLocalizationCandidate[] = [];
  for (const symbol of symbols) {
    const nameTerms = new Set(tokenize(symbol.name));
    const contextTerms = new Set(tokenize(symbol.context));
    const matchedTerms: string[] = [];
    let score = 0;
    for (const term of issueTerms) {
      if (nameTerms.has(term)) {
        score += 1;
        matchedTerms.push(term);
      } else if (contextTerms.has(term)) {
        score += 0.25;
        matchedTerms.push(term);
      }
    }
    if (score > 0) candidates.push({ symbol, score: clamp01(score / issueTerms.size), matchedTerms });
  }
  candidates.sort((left, right) => right.score - left.score || left.symbol.id.localeCompare(right.symbol.id));
  const limit = options.limit ?? 10;
  return candidates.slice(0, Math.max(0, limit));
}

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "to", "of", "in", "on", "for", "and", "or",
  "it", "this", "that", "with", "when", "does", "do", "did", "not", "no", "at", "as", "by", "from", "if"
]);

function tokenize(text: string): string[] {
  const words = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLocaleLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  return words.filter(word => word.length > 2 && !STOPWORDS.has(word));
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function leadingCommentLines(lines: readonly string[], declarationIndex: number): string[] {
  const collected: string[] = [];
  let index = declarationIndex - 1;
  while (index >= 0 && collected.length < 3) {
    const line = lines[index]!.trim();
    if (line.startsWith("//") || line.startsWith("*") || line.startsWith("/**")) {
      collected.unshift(line);
      index--;
    } else if (line === "") {
      break;
    } else {
      break;
    }
  }
  return collected;
}

function declarationEndLine(lines: readonly string[], declarationIndex: number): number {
  let depth = 0;
  let opened = false;
  for (let index = declarationIndex; index < lines.length; index++) {
    for (const char of lines[index]!) {
      if (char === "{") { depth++; opened = true; }
      else if (char === "}") depth--;
    }
    if (opened && depth <= 0) return index + 1;
    if (index - declarationIndex > 2000) break;
  }
  return declarationIndex + 1;
}

function countNewlinesBefore(text: string, offset: number): number {
  let count = 0;
  for (let index = 0; index < offset && index < text.length; index++) if (text[index] === "\n") count++;
  return count;
}

function findMatchingCloseParen(text: string, fromIndex: number): number | undefined {
  const openIndex = text.indexOf("(", fromIndex);
  if (openIndex === -1) return undefined;
  let depth = 0;
  for (let index = openIndex; index < text.length && index - openIndex < 20_000; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")") {
      depth--;
      if (depth === 0) return index;
    }
  }
  return undefined;
}
