// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * Code as a surface the language memory can learn, rather than prose extracted from code.
 *
 * The corpus lane previously reduced a source file to its comments plus its identifiers split into words, so the
 * only thing a model ever observed was English. Nothing could compose `foo(bar)` because no token sequence of
 * that shape was ever seen. These are the projection and its inverse: a formal-language token stream trained the
 * same way prose is trained, and a rendering back to the observed source text.
 *
 * Language-neutral by construction. No keyword list, no per-language grammar: identifiers, numbers, delimited
 * literals, and punctuation are lexical categories every formal language shares, and everything a specific
 * language means by them is left to be learned from its own corpus.
 */

/** Line boundary, carried as a symbol so line structure is learnable rather than lost to whitespace. */
export const CODE_LINE_SYMBOL = "⏎";
export const CODE_SOURCE_SYMBOL = "\u001ecode-source.v2";
const CODE_WHITESPACE_PREFIX = "\u001ecode-whitespace:";
const CODE_ESCAPED_SYMBOL_PREFIX = "\u001ecode-symbol:";
export const CODE_SURFACE_RECIPE_ID = "scce.code_source_surface.v2" as const;

/** Brackets pair the same way in every formal language that has them; this is structure, not vocabulary. */
const OPENING_BRACKETS: ReadonlyMap<string, string> = new Map([["(", ")"], ["[", "]"], ["{", "}"]]);
const CLOSING_BRACKETS: ReadonlySet<string> = new Set([")", "]", "}"]);

/** Punctuation that always stands alone: grouping and separation never fuse into a longer operator. */
const SOLO_PUNCTUATION: ReadonlySet<string> = new Set(["(", ")", "[", "]", "{", "}", ",", ";"]);

const IDENTIFIER_START = /[\p{ID_Start}_$\\]/u;
const IDENTIFIER_PART = /[\p{ID_Continue}$]/u;
const DIGIT = /\p{Number}/u;
const OPERATOR_CHARACTER = /[!%&*+\-/:<=>?^|~.@#]/u;
const QUOTES: ReadonlySet<string> = new Set(["\"", "'", "`"]);

/**
 * One source text to the symbol stream the n-gram lane trains on.
 *
 * A delimited literal is one symbol so a model learns where literals go without memorising their contents;
 * an operator run is one symbol so `=>` and `::` are single units rather than a pair the model must re-derive.
 */
export function codeSurfaceTokens(text: string, maxTokens = Number.POSITIVE_INFINITY): string[] {
  const characters = [...text];
  const tokens: string[] = [CODE_SOURCE_SYMBOL];
  let index = 0;
  while (index < characters.length && tokens.length < maxTokens) {
    const character = characters[index]!;
    if (character === "\n") {
      tokens.push(CODE_LINE_SYMBOL);
      index += 1;
      continue;
    }
    if (/\s/u.test(character)) {
      let end = index + 1;
      while (end < characters.length && characters[end] !== "\n" && /\s/u.test(characters[end]!)) end += 1;
      tokens.push(CODE_WHITESPACE_PREFIX + JSON.stringify(characters.slice(index, end).join("")));
      index = end;
      continue;
    }
    if (QUOTES.has(character)) {
      const literal = readDelimitedLiteral(characters, index);
      tokens.push(literal.token);
      index = literal.next;
      continue;
    }
    if (IDENTIFIER_START.test(character)) {
      let end = index + 1;
      while (end < characters.length && IDENTIFIER_PART.test(characters[end]!)) end += 1;
      tokens.push(characters.slice(index, end).join(""));
      index = end;
      continue;
    }
    if (DIGIT.test(character)) {
      let end = index + 1;
      while (end < characters.length && /[\p{Letter}\p{Number}._]/u.test(characters[end]!)) end += 1;
      tokens.push(characters.slice(index, end).join(""));
      index = end;
      continue;
    }
    if (SOLO_PUNCTUATION.has(character)) { tokens.push(character); index += 1; continue; }
    if (OPERATOR_CHARACTER.test(character)) {
      let end = index + 1;
      while (end < characters.length && OPERATOR_CHARACTER.test(characters[end]!)) end += 1;
      tokens.push(characters.slice(index, end).join(""));
      index = end;
      continue;
    }
    tokens.push(character === CODE_LINE_SYMBOL ? CODE_ESCAPED_SYMBOL_PREFIX + JSON.stringify(character) : character);
    index += 1;
  }
  if (index < characters.length) throw new RangeError("code surface token budget does not cover the complete source");
  return tokens;
}

/** The canonical compiler performs lexical projection once over this complete source surface. */
export function codeTrainingSurface(text: string, maxTokens = Number.POSITIVE_INFINITY): string {
  if (Number.isFinite(maxTokens)) codeSurfaceTokens(text, maxTokens);
  return text;
}

export function codeTokenWhitespace(token: string): string | undefined {
  if (!token.startsWith(CODE_WHITESPACE_PREFIX)) return undefined;
  try {
    const whitespace: unknown = JSON.parse(token.slice(CODE_WHITESPACE_PREFIX.length));
    return typeof whitespace === "string" && /^\s+$/u.test(whitespace) ? whitespace : undefined;
  } catch { return undefined; }
}

export function codeTokenIsLayout(token: string): boolean {
  return token === CODE_SOURCE_SYMBOL || token === CODE_LINE_SYMBOL || codeTokenWhitespace(token) !== undefined;
}

/**
 * Symbols back to source text.
 *
 * Annotated streams retain their observed whitespace; unannotated lexical arrays retain the existing token API.
 */
export function renderCodeTokens(tokens: readonly string[], indent = "", indentation: "preserve" | "replace" = "preserve"): string {
  const observed = tokens.includes(CODE_SOURCE_SYMBOL) || tokens.some(token => codeTokenWhitespace(token) !== undefined);
  if (observed) {
    const text = tokens.map(token => token === CODE_SOURCE_SYMBOL ? "" : token === CODE_LINE_SYMBOL ? "\n"
      : codeTokenWhitespace(token) ?? (token.startsWith(CODE_ESCAPED_SYMBOL_PREFIX) ? JSON.parse(token.slice(CODE_ESCAPED_SYMBOL_PREFIX.length)) as string : token)).join("");
    if (indentation === "preserve") return text;
    const lines = text.split("\n");
    const observedIndent = lines.find(line => line.trim())?.match(/^[\t ]*/u)?.[0] ?? "";
    return lines.map(line => line.trim() ? indent + (line.startsWith(observedIndent) ? line.slice(observedIndent.length) : line) : line).join("\n");
  }
  const lines: string[] = [];
  let current = "";
  for (const token of tokens) {
    if (token === CODE_LINE_SYMBOL) { lines.push(current); current = ""; continue; }
    current = current.length === 0 ? token : `${current}${codeTokenSeparator(current, token)}${token}`;
  }
  lines.push(current);
  return lines.map(line => (line.trim() ? `${indent}${line}` : line)).join("\n");
}

function codeTokenSeparator(left: string, right: string): string {
  const previous = left.slice(-1);
  if (CLOSING_BRACKETS.has(right) || right === "," || right === ";") return "";
  if (previous === "(" || previous === "[") return "";
  if (right === "(" && (IDENTIFIER_PART.test(previous) || previous === ")" || previous === "]")) return "";
  if (right === "[" && (IDENTIFIER_PART.test(previous) || previous === ")" || previous === "]")) return "";
  if (right === "." || previous === ".") return "";
  return " ";
}

function readDelimitedLiteral(characters: readonly string[], start: number): { token: string; next: number } {
  const quote = characters[start]!;
  let index = start + 1;
  while (index < characters.length) {
    const character = characters[index]!;
    if (character === "\\") { index += 2; continue; }
    if (character === quote) { index += 1; break; }
    if (character === "\n" && quote !== "`") break;
    index += 1;
  }
  return { token: characters.slice(start, index).join(""), next: Math.max(index, start + 1) };
}

export interface CodeBracketBalance {
  /** Brackets still open, outermost first; empty means the span closes everything it opened. */
  open: string[];
  /** True when a closing bracket appeared with no matching opener in this span. */
  underflow: boolean;
}

/** Bracket state of a token run. The one structural property worth checking before a compiler is spent on it. */
export function codeBracketBalance(tokens: readonly string[]): CodeBracketBalance {
  const open: string[] = [];
  let underflow = false;
  for (const token of tokens) {
    const closes = OPENING_BRACKETS.get(token);
    if (closes) { open.push(closes); continue; }
    if (!CLOSING_BRACKETS.has(token)) continue;
    if (open[open.length - 1] === token) open.pop();
    else underflow = true;
  }
  return { open, underflow };
}

/** The identifiers in a token run, in first-seen order: what a request or a diagnostic is actually naming. */
export function codeIdentifierTokens(tokens: readonly string[], limit = 256): string[] {
  const out: string[] = [];
  for (const token of tokens) {
    if (codeTokenIsLayout(token) || !IDENTIFIER_START.test([...token][0] ?? "")) continue;
    if (out.includes(token)) continue;
    out.push(token);
    if (out.length >= limit) break;
  }
  return out;
}

/**
 * Comment prose in a source file, for the documentation lane.
 *
 * Only the two delimited C-family forms are recognised, because they are unambiguous wherever they occur and
 * absent everywhere else. `#` is deliberately not treated as a comment: it opens a preprocessor directive in C,
 * an attribute in Rust, and a comment in Python, and guessing between them silently deletes real code.
 */
export function codeCommentProse(text: string, limit = 512): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/gu)) {
    const cleaned = match[0]
      .replace(/^\/\*+|\*+\/$/gu, "")
      .replace(/^[ \t]*(?:\/\/|\*)[ \t]?/gmu, "")
      .trim();
    if (cleaned) out.push(cleaned);
    if (out.length >= limit) break;
  }
  return out;
}
