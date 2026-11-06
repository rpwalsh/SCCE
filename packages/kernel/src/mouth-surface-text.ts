// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { featureSet, weightedJaccard } from "./primitives.js";
import { isSentenceBoundarySymbol, splitSurfaceSentences as splitUnicodeSurfaceSentences, tidySurfaceText } from "./surface-linguistics.js";

const MINIMUM_REPEATED_TOKEN_SPAN = 8;

export function isLikelySentenceBoundary(value: string): boolean {
  return isSentenceBoundarySymbol(value);
}

function isLikelyInlineOnlyBoundary(value: string): boolean {
  return value === ":" || value === ";" || value === "," || value === "،" || value === "、";
}

export function isBoundaryGlyph(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    if (isWhitespaceChar(char)) continue;
    if (isLetterChar(char) || isDigitChar(char) || char === "_" || char === "-") return false;
  }
  return true;
}

/** Brackets are punctuation, not a language's grammar, so this reads the same in every script. An aside the
 *  caller judges to carry content stays; only an empty one is cut. Pure. */
export function withoutBracketedAsides(text: string, keep: (content: string) => boolean): string {
  const opens = new Map([["(", ")"], ["[", "]"], ["（", "）"], ["【", "】"]]);
  let out = "";
  let depth = 0;
  let aside = "";
  let opener = "";
  const closers: string[] = [];
  for (const char of text) {
    const close = opens.get(char);
    if (close) {
      if (depth === 0) { opener = char; aside = ""; }
      else aside += char;
      closers.push(close);
      depth++;
      continue;
    }
    if (depth > 0 && char === closers[closers.length - 1]) {
      closers.pop();
      depth--;
      if (depth === 0) { if (keep(aside)) out += opener + aside + char; }
      else aside += char;
      continue;
    }
    if (depth > 0) aside += char;
    else out += char;
  }
  return closeSpacingAfterCut(collapseWhitespace(out));
}

/** Cutting an aside leaves a space stranded before the punctuation that followed it. Pure. */
function closeSpacingAfterCut(text: string): string {
  const trailing = new Set([",", ".", ";", ":", "!", "?", ")", "]", "、", "。", "，", "；", "：", "！", "？"]);
  const chars = [...text];
  let out = "";
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (char === " " && trailing.has(chars[index + 1] ?? "")) continue;
    out += char;
  }
  return out;
}

export function normalizeEvidenceSentence(text: string): string {
  return removeEmptyLines(collapseWhitespace(text).trim());
}

export function stripOuterSurfaceBoundary(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isSurfaceBoundaryChar(value[start] ?? "")) start++;
  while (end > start && isSurfaceBoundaryChar(value[end - 1] ?? "")) end--;
  return value.slice(start, end);
}

function isSurfaceBoundaryChar(char: string): boolean {
  return isWhitespaceChar(char) || isLikelySentenceBoundary(char) || isLikelyInlineOnlyBoundary(char) || char === "\"" || char === "'";
}

export function removeEmptyLines(text: string): string {
  return splitLines(text)
    .map(line => line.trimEnd())
    .filter((line, index, lines) => line.trim() || (index > 0 && index < lines.length - 1 && lines[index - 1]?.trim()))
    .join("\n")
    .trim();
}

interface SurfaceTokenOffset {
  key: string;
  start: number;
  end: number;
}

function surfaceTokenOffsets(text: string): SurfaceTokenOffset[] {
  const rows: SurfaceTokenOffset[] = [];
  for (const match of text.matchAll(/[\p{Letter}\p{Mark}\p{Number}_]+/gu)) {
    const start = match.index;
    if (start === undefined) continue;
    rows.push({
      key: match[0].normalize("NFKC").toLocaleLowerCase(),
      start,
      end: start + match[0].length
    });
  }
  return rows;
}

export function collapseRepeatedTokenSpans(text: string): string {
  let current = tidySurface(text);
  for (let pass = 0; pass < 16; pass++) {
    const tokens = surfaceTokenOffsets(current);
    const repeated = longestRepeatedTokenSpan(tokens);
    if (!repeated) break;
    current = tidySurface(`${current.slice(0, repeated.start)} ${current.slice(repeated.end)}`);
  }
  return current;
}

function longestRepeatedTokenSpan(tokens: readonly SurfaceTokenOffset[]): { start: number; end: number } | undefined {
  if (tokens.length < MINIMUM_REPEATED_TOKEN_SPAN * 2) return undefined;
  const boundedTokens = tokens.slice(0, 4096);
  const priorBySequence = new Map<string, number[]>();
  let best: { tokenCount: number; start: number; end: number } | undefined;
  for (let later = 0; later + MINIMUM_REPEATED_TOKEN_SPAN <= boundedTokens.length; later++) {
    const sequenceKey = boundedTokens
      .slice(later, later + MINIMUM_REPEATED_TOKEN_SPAN)
      .map(token => token.key)
      .join("\u0001");
    const priors = priorBySequence.get(sequenceKey) ?? [];
    for (const earlier of priors) {
      if (earlier + MINIMUM_REPEATED_TOKEN_SPAN > later) continue;
      let tokenCount = MINIMUM_REPEATED_TOKEN_SPAN;
      while (
        earlier + tokenCount < later
        && later + tokenCount < boundedTokens.length
        && boundedTokens[earlier + tokenCount]!.key === boundedTokens[later + tokenCount]!.key
      ) tokenCount++;
      const candidate = {
        tokenCount,
        start: boundedTokens[later]!.start,
        end: boundedTokens[later + tokenCount - 1]!.end
      };
      if (!best || candidate.tokenCount > best.tokenCount
        || candidate.tokenCount === best.tokenCount && candidate.start < best.start) best = candidate;
    }
    priors.push(later);
    priorBySequence.set(sequenceKey, priors.slice(-16));
  }
  return best ? { start: best.start, end: best.end } : undefined;
}

const SURFACE_DELIMITER_PAIRS: ReadonlyMap<string, string> = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["\uff08", "\uff09"],
  ["\uff3b", "\uff3d"],
  ["\uff5b", "\uff5d"],
  ["\u3008", "\u3009"],
  ["\u300a", "\u300b"],
  ["\u300c", "\u300d"],
  ["\u300e", "\u300f"],
  ["\u3010", "\u3011"],
  ["\u3014", "\u3015"],
  ["\u3016", "\u3017"],
  ["\u3018", "\u3019"],
  ["\u301a", "\u301b"]
]);

const SURFACE_OPENING_BY_CLOSER: ReadonlyMap<string, string> = new Map(
  [...SURFACE_DELIMITER_PAIRS].map(([opening, closing]) => [closing, opening])
);

const SURFACE_CLOSING_DELIMITERS = new Set(SURFACE_OPENING_BY_CLOSER.keys());

const SURFACE_SENTENCE_TRAILING_CLOSERS = new Set([
  ...SURFACE_CLOSING_DELIMITERS,
  "\"",
  "'",
  "\u2019",
  "\u201d",
  "\u00bb",
  "\u203a"
]);

export function extentUnitHasTerminalBoundary(text: string): boolean {
  const chars = [...text.trimEnd()];
  while (chars.length && SURFACE_SENTENCE_TRAILING_CLOSERS.has(chars.at(-1) ?? "")) chars.pop();
  return isSentenceBoundarySymbol(chars.at(-1) ?? "");
}

export function surfaceCodePointLength(text: string): number {
  return [...text].length;
}

export function compactAnchorSurface(required: readonly string[], maxLength: number): string {
  const selected: string[] = [];
  for (const term of required) {
    const next = tidySurface([...selected, term].join(" "));
    if (surfaceCodePointLength(next) <= maxLength) selected.push(term);
  }
  return tidySurface(selected.join(" "));
}

export function compactWholeWordSurface(text: string, maxLength: number): string {
  const selected: string[] = [];
  for (const word of splitWhitespace(text)) {
    const next = [...selected, word].join(" ");
    if (surfaceCodePointLength(next) > maxLength) break;
    selected.push(word);
  }
  if (selected.length) return selected.join(" ");
  return "";
}

export function normalizeSurfaceEcho(text: string): string {
  return splitWhitespace(tidySurface(text))
    .map(stripOuterSurfaceBoundary)
    .map(value => value.toLocaleLowerCase())
    .filter(Boolean)
    .join(" ");
}

export function collapseEmptyBracketLead(text: string): string {
  return text.replace(/([([{\u3010\uff08])\s*[;,:\u3001\uff0c\uff1b]+\s*/gu, "$1");
}

export function collapseRepeatedSurfaceUnits(text: string): string {
  const symbols = splitWhitespace(tidySurface(text));
  if (symbols.length <= 1) return tidySurface(text);
  const out: string[] = [];
  for (const symbol of symbols) {
    const previous = out[out.length - 1];
    if (previous && previous.normalize("NFKC").toLocaleLowerCase() === symbol.normalize("NFKC").toLocaleLowerCase()) continue;
    out.push(symbol);
  }
  return out.join(" ");
}

export function collapseRepeatedSurfaceSequences(text: string): string {
  let symbols = splitWhitespace(tidySurface(text));
  if (symbols.length < 8) return tidySurface(text);
  let changed = true;
  while (changed) {
    changed = false;
    const maximum = Math.floor(symbols.length / 2);
    for (let width = maximum; width >= 4 && !changed; width--) {
      for (let start = 0; start + width * 2 <= symbols.length; start++) {
        const left = symbols.slice(start, start + width).map(repeatedSurfaceSymbolKey);
        const right = symbols.slice(start + width, start + width * 2).map(repeatedSurfaceSymbolKey);
        if (!left.every((symbol, index) => symbol && symbol === right[index])) continue;
        symbols = [...symbols.slice(0, start), ...symbols.slice(start + width)];
        changed = true;
        break;
      }
    }
  }
  return symbols.join(" ");
}

function repeatedSurfaceSymbolKey(value: string): string {
  return stripOuterSurfaceBoundary(value).normalize("NFKC").toLocaleLowerCase();
}

export function collapseRepeatedSentenceSegments(text: string): string {
  const segments = splitSurfaceSentences(text);
  if (segments.length <= 1) return tidySurface(text);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const segment of segments) {
    const clean = tidySurface(segment);
    if (!clean) continue;
    const key = clean.normalize("NFKC").toLocaleLowerCase();
    if (seen.has(key)) continue;
    const nearIndex = kept.findIndex(existing => nearDuplicateSentence(existing, clean));
    if (nearIndex >= 0) {
      if (clean.length > kept[nearIndex]!.length) kept[nearIndex] = clean;
      continue;
    }
    seen.add(key);
    kept.push(clean);
  }
  return tidySurface(kept.join(" "));
}

function nearDuplicateSentence(left: string, right: string): boolean {
  if (weightedJaccard(featureSet(left, 128), featureSet(right, 128)) > 0.78) return true;
  const leftSymbols = lexicalSurfaceSymbols(left);
  const rightSymbols = lexicalSurfaceSymbols(right);
  if (!leftSymbols.size || !rightSymbols.size) return false;
  let intersection = 0;
  for (const symbol of leftSymbols) if (rightSymbols.has(symbol)) intersection++;
  return intersection / Math.max(1, Math.min(leftSymbols.size, rightSymbols.size)) > 0.82;
}

function lexicalSurfaceSymbols(text: string): Set<string> {
  const units = new Set<string>();
  let current = "";
  const flush = () => {
    const clean = current.toLocaleLowerCase();
    if (clean.length >= 4) units.add(clean);
    current = "";
  };
  for (const char of text.normalize("NFKC")) {
    if (isLetterChar(char) || isDigitChar(char)) {
      current += char;
      continue;
    }
    flush();
  }
  flush();
  return units;
}

export function splitSurfaceSentences(text: string): string[] {
  return splitUnicodeSurfaceSentences(text);
  const segments: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    current += char;
    const next = text[index + 1] ?? "";
    if (isLikelySentenceBoundary(char) && (!next || isWhitespaceChar(next))) {
      segments.push(current);
      current = "";
    }
  }
  if (current.trim()) segments.push(current);
  return segments;
}

export function collapseRepeatedInlineBoundaries(text: string, sentenceBoundary: string, inline: readonly string[]): string {
  let out = "";
  let repeatedInline = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (inline.includes(char)) {
      const left = text[index - 1] ?? "";
      const right = text[index + 1] ?? "";
      if (isDigitChar(left) && isDigitChar(right)) {
        out += char;
        continue;
      }
      repeatedInline++;
      if (repeatedInline > 1) continue;
      out += char;
      continue;
    }
    if (!isWhitespaceChar(char) && !inline.includes(char)) {
      if (isLikelySentenceBoundary(char)) repeatedInline = 0;
    }
    if (isLikelySentenceBoundary(char) && out.endsWith(char)) continue;
    out += char;
  }
  return tidySurface(out);
}

export function repairSurfaceDelimiterBalance(text: string): string {
  const output: string[] = [];
  const openings: Array<{ char: string; outputIndex: number }> = [];
  for (const char of text) {
    if (SURFACE_DELIMITER_PAIRS.has(char)) {
      openings.push({ char, outputIndex: output.length });
      output.push(char);
      continue;
    }
    const expectedOpening = SURFACE_OPENING_BY_CLOSER.get(char);
    if (expectedOpening) {
      const activeOpening = openings.at(-1);
      if (!activeOpening || activeOpening.char !== expectedOpening) continue;
      while (output.length && isWhitespaceChar(output.at(-1) ?? "")) output.pop();
      output.push(char);
      openings.pop();
      continue;
    }
    if (isSentenceBoundarySymbol(char) || isLikelyInlineOnlyBoundary(char)) {
      while (output.length && isWhitespaceChar(output.at(-1) ?? "")) output.pop();
    }
    output.push(char);
  }
  if (!openings.length) return tidySurface(output.join(""));
  const unmatchedOpeningIndexes = new Set(openings.map(opening => opening.outputIndex));
  return tidySurface(output.filter((_char, index) => !unmatchedOpeningIndexes.has(index)).join(""));
}

export function isLetterChar(char: string): boolean {
  return char.toLocaleLowerCase() !== char.toLocaleUpperCase();
}

export function isDigitChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    if (char === "\r") continue;
    if (char === "\n") {
      lines.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  lines.push(current);
  return lines;
}

export function collapseWhitespace(text: string): string {
  const out: string[] = [];
  let pending = false;
  for (const char of text) {
    if (isWhitespaceChar(char)) {
      pending = out.length > 0;
      continue;
    }
    if (pending) out.push(" ");
    pending = false;
    out.push(char);
  }
  return out.join("");
}

// Delegates to the canonical implementation in surface-linguistics.ts so
// answer plans building excerpt windows normalize in the exact space this
// file's source-excerpt verification compares in. One implementation only.
export function tidySurface(text: string): string {
  return tidySurfaceText(text);
}

function collapseConsecutiveBoundaryGlyphs(text: string): string {
  let out = "";
  for (const char of text) {
    const previous = out[out.length - 1] ?? "";
    if (isLikelySentenceBoundary(char) && previous === char) continue;
    if (isLikelyInlineOnlyBoundary(char) && previous === char) continue;
    out += char;
  }
  return out;
}

export function splitWhitespace(text: string): string[] {
  const symbols: string[] = [];
  let current = "";
  for (const char of text) {
    if (isWhitespaceChar(char)) {
      if (current) {
        symbols.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) symbols.push(current);
  return symbols;
}

function isWhitespaceChar(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

export function containsSurface(text: string, surface: string): boolean {
  return text.normalize("NFKC").toLocaleLowerCase().includes(surface.normalize("NFKC").toLocaleLowerCase());
}
