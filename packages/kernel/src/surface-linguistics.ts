import { createStringMemo } from "./pure-memo.js";

export const SENTENCE_BOUNDARY_SYMBOLS = [
  ".",
  "!",
  "?",
  "\u3002",
  "\uff01",
  "\uff1f",
  "\u061f",
  "\u06d4",
  "\u0964",
  "\u0965",
  "\u1362",
  "\u104b"
] as const;

const SENTENCE_BOUNDARIES = new Set<string>(SENTENCE_BOUNDARY_SYMBOLS);

export function isSentenceBoundarySymbol(value: string): boolean {
  return SENTENCE_BOUNDARIES.has(value);
}

export function splitSurfaceSentences(text: string): string[] {
  const out: string[] = [];
  let current = "";
  const chars = [...text.replace(/\u0000/g, " ").normalize("NFC")];
  const push = () => {
    const clean = collapseSurfaceWhitespace(current);
    if (clean) out.push(clean);
    current = "";
  };
  for (let index = 0; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (char === "\n" || char === "\r") {
      push();
      continue;
    }
    current += char;
    if (!isSentenceBoundarySymbol(char)) continue;
    const next = chars[index + 1] ?? "";
    if ((!next || isSurfaceWhitespace(next) || sentenceBoundaryMayOmitWhitespace(chars, index))
      && shouldCloseSentence(chars, index)) push();
  }
  push();
  return out;
}

function sentenceBoundaryMayOmitWhitespace(chars: readonly string[], index: number): boolean {
  const boundary = chars[index] ?? "";
  if (!boundary) return false;
  if (boundary !== ".") return true;
  const previous = chars[index - 1] ?? "";
  const next = chars[index + 1] ?? "";
  return /\p{Letter}/u.test(previous)
    && /\p{Letter}/u.test(next)
    && previous.toLocaleLowerCase() === previous.toLocaleUpperCase()
    && next.toLocaleLowerCase() === next.toLocaleUpperCase();
}

export function ensureSurfaceSentence(text: string, boundary = ""): string {
  const clean = collapseSurfaceWhitespace(text);
  if (!clean) return "";
  const last = [...clean].at(-1) ?? "";
  return isSentenceBoundarySymbol(last) || !isSentenceBoundarySymbol(boundary)
    ? clean
    : `${clean}${boundary}`;
}

export function stripTerminalSentenceBoundary(text: string): string {
  const clean = collapseSurfaceWhitespace(text);
  const chars = [...clean];
  const last = chars.at(-1) ?? "";
  return isSentenceBoundarySymbol(last) ? chars.slice(0, -1).join("").trimEnd() : clean;
}

/**
 * Canonical answer-surface normalization: NFC, ASCII-whitespace collapse,
 * then consecutive-boundary-glyph collapse. Extracted verbatim from
 * mouth.ts's `tidySurface` (which now delegates here) -- this is the exact
 * space in which mouth's source-excerpt verification compares answers to
 * evidence text, exported so answer plans can build multi-sentence windows
 * that are verifiable substrings BY CONSTRUCTION instead of re-joined
 * cleaned fragments that no longer match the source. Any change here
 * changes excerpt verification; keep the two in lockstep by keeping
 * exactly one implementation.
 */
export function tidySurfaceText(text: string): string {
  return tidySurfaceTextMemo(text);
}

/**
 * 13.9% of one profiled turn was spent re-deriving this for strings it had
 * already normalized. The transform is pure, so the repeat work is pure
 * waste; see pure-memo.ts for why the cache is bounded on two axes.
 */
const tidySurfaceTextMemo = createStringMemo(computeTidySurfaceText, {
  maxEntries: 4096,
  maxKeyChars: 8192,
  maxTotalChars: 4_000_000
});

/** Exposed for tests: the uncached transform, and the memo's counters. */
export const tidySurfaceTextMemoStats = (): ReturnType<typeof tidySurfaceTextMemo.stats> => tidySurfaceTextMemo.stats();

function computeTidySurfaceText(text: string): string {
  const collapsed: string[] = [];
  let pending = false;
  for (const char of text.normalize("NFC")) {
    if (char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v") {
      pending = collapsed.length > 0;
      continue;
    }
    if (pending) collapsed.push(" ");
    pending = false;
    collapsed.push(char);
  }
  const base = collapsed.join("").trim();
  let out = "";
  for (const char of base) {
    const previous = out[out.length - 1] ?? "";
    if (isSentenceBoundarySymbol(char) && previous === char) continue;
    if ((char === ":" || char === ";" || char === "," || char === "،" || char === "、") && previous === char) continue;
    out += char;
  }
  return out;
}

/**
 * A surface that is one cased-alphabetic word of two or fewer letters
 * ("It", "He") is never a complete answer -- it is what a truncated
 * subject extraction looks like (verified live: a sealed-eval question
 * answered exactly "It"). Structural, not a word list: digits ("42"),
 * uncased scripts (a single CJK character is a complete word), and any
 * surface with a second unit or a third letter are all non-degenerate.
 * Shared by mouth admissibility and kernel candidate selection so a
 * degenerate candidate loses at ranking time, letting a real
 * evidence-plan candidate win instead of leaving the turn empty.
 */
export function isDegenerateBareSurface(text: string): boolean {
  const clean = collapseSurfaceWhitespace(text);
  if (!clean) return true;
  const units = clean.split(" ");
  if (units.length !== 1) return false;
  const unit = units[0] ?? "";
  const cased = [...unit].filter(char => char.toLocaleLowerCase() !== char.toLocaleUpperCase());
  if (!cased.length) return false;
  return [...unit].filter(char => !isSentenceBoundarySymbol(char)).length <= 2;
}

/**
 * Structural completeness of a prose surface, with zero language-specific
 * word lists: every sentence opens with something a sentence can open
 * with in a cased script (uppercase, digit, opening punctuation; uncased
 * scripts are exempt by construction), quotes and parentheses balance,
 * and the surface ends at a sentence boundary. These are exactly the
 * shapes stitching failures take (verified live: `Leonard Nimoy as Mr.
 * "Where No Man."` fails on quote balance, an image-caption tail fails on
 * its lowercase opener) -- while a well-formed COMPOSED sentence passes,
 * which is the point: this gates surface quality, never wording freedom.
 */
export function structurallyCompleteSurface(text: string): boolean {
  const clean = collapseSurfaceWhitespace(text);
  if (!clean) return false;
  const chars = [...clean];
  const last = chars.at(-1) ?? "";
  if (!isSentenceBoundarySymbol(last) && last !== "\"" && last !== "'" && last !== "”" && last !== "’") return false;
  let parens = 0;
  let quotes = 0;
  for (const char of chars) {
    if (char === "(") parens++;
    else if (char === ")") parens = parens - 1;
    else if (char === "\"") quotes++;
    if (parens < 0) return false;
  }
  if (parens !== 0 || quotes % 2 === 1) return false;
  for (const sentence of splitSurfaceSentences(clean)) {
    const first = [...sentence][0] ?? "";
    const cased = first.toLocaleLowerCase() !== first.toLocaleUpperCase();
    if (cased && first !== first.toLocaleUpperCase()) return false;
  }
  return true;
}

export function collapseSurfaceWhitespace(text: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of text.replace(/\u0000/g, " ").normalize("NFC")) {
    if (isSurfaceWhitespace(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += char;
  }
  return out.trim();
}

export function surfaceUnits(text: string): string[] {
  const units: string[] = [];
  let current = "";
  for (const char of text.replace(/\u0000/g, " ").normalize("NFKC").toLocaleLowerCase()) {
    if (isSurfaceUnitChar(char)) {
      current += char;
      continue;
    }
    if (current) units.push(current);
    current = "";
  }
  if (current) units.push(current);
  return units.filter(Boolean);
}

export function surfaceWords(text: string): string[] {
  const words: string[] = [];
  let current = "";
  for (const char of text.replace(/\u0000/g, " ").normalize("NFKC")) {
    if (isSurfaceUnitChar(char) || char === "'" || char === "\u2019") {
      current += char;
      continue;
    }
    if (current) words.push(current);
    current = "";
  }
  if (current) words.push(current);
  return words.filter(Boolean);
}

export function hasCasedLetter(value: string): boolean {
  for (const char of value) {
    if (!isSurfaceLetter(char)) continue;
    if (char.toLocaleLowerCase() !== char.toLocaleUpperCase()) return true;
  }
  return false;
}

export function hasUppercaseLetter(value: string): boolean {
  for (const char of value) {
    if (!isSurfaceLetter(char)) continue;
    if (char.toLocaleLowerCase() === char.toLocaleUpperCase()) continue;
    if (char === char.toLocaleUpperCase()) return true;
  }
  return false;
}

export function hasUncasedNonLatinLetter(value: string): boolean {
  for (const char of value) {
    if (!isSurfaceLetter(char)) continue;
    if (char.toLocaleLowerCase() !== char.toLocaleUpperCase()) continue;
    if (!/\p{Script=Latin}/u.test(char)) return true;
  }
  return false;
}

export function isSurfaceLetter(char: string): boolean {
  return char.toLocaleLowerCase() !== char.toLocaleUpperCase() || /\p{Letter}/u.test(char);
}

export function isSurfaceUnitChar(char: string): boolean {
  return /\p{Letter}|\p{Number}/u.test(char) || char === "_";
}

function isSurfaceWhitespace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v" || /\p{Separator}/u.test(char);
}

function shouldCloseSentence(chars: readonly string[], boundaryIndex: number): boolean {
  const boundary = chars[boundaryIndex] ?? "";
  if (boundary !== ".") return true;
  if (isSingleLetterInitial(chars, boundaryIndex)) return false;
  if (isTitleCaseAbbreviation(chars, boundaryIndex)) return false;
  return true;
}

/**
 * A two-letter title-case token before a period, followed by a capitalized
 * continuation, is an abbreviation ("Lt. Commander", "Dr. Mark", "Mr.
 * Spock"), not a sentence end -- splitting there produced excerpt windows
 * truncated mid-title (verified live: "Chief Engineer Lt." as a complete
 * "sentence"). Structural, not a word list: the shape (exactly two
 * letters, initial capital, lowercase second letter, capitalized next
 * word) is what Latin-script abbreviated titles look like in any
 * language, two-letter capitalized words that genuinely END a sentence
 * are vanishingly rare, and all-caps acronyms ("NBC.") keep closing
 * because their second letter is not lowercase.
 */
function isTitleCaseAbbreviation(chars: readonly string[], boundaryIndex: number): boolean {
  const previous = previousSurfaceToken(chars, boundaryIndex);
  const letters = [...previous];
  if (letters.length !== 2) return false;
  const first = letters[0] ?? "";
  const second = letters[1] ?? "";
  if (first.toLocaleLowerCase() === first.toLocaleUpperCase() || first !== first.toLocaleUpperCase()) return false;
  if (second.toLocaleLowerCase() === second.toLocaleUpperCase() || second !== second.toLocaleLowerCase()) return false;
  const next = nextVisibleChar(chars, boundaryIndex + 1);
  if (!next || !isSurfaceLetter(next)) return false;
  return next.toLocaleLowerCase() !== next.toLocaleUpperCase() && next === next.toLocaleUpperCase();
}

function isSingleLetterInitial(chars: readonly string[], boundaryIndex: number): boolean {
  const previous = previousSurfaceToken(chars, boundaryIndex);
  if (!previous || [...previous].length !== 1) return false;
  if (!isSurfaceLetter(previous)) return false;
  const next = nextVisibleChar(chars, boundaryIndex + 1);
  return !next || isOpeningPunctuation(next) || isSurfaceLetter(next) || /\p{Number}/u.test(next);
}

function previousSurfaceToken(chars: readonly string[], boundaryIndex: number): string {
  let token = "";
  for (let index = boundaryIndex - 1; index >= 0; index--) {
    const char = chars[index] ?? "";
    if (isSurfaceUnitChar(char)) {
      token = `${char}${token}`;
      continue;
    }
    break;
  }
  return token;
}

function nextVisibleChar(chars: readonly string[], startIndex: number): string | undefined {
  for (let index = startIndex; index < chars.length; index++) {
    const char = chars[index] ?? "";
    if (isSurfaceWhitespace(char) || isOpeningPunctuation(char)) continue;
    return char;
  }
  return undefined;
}

function isOpeningPunctuation(char: string): boolean {
  return char === "\"" || char === "'" || char === "\u2018" || char === "\u201c" || char === "\u00ab" || char === "(" || char === "[" || char === "{";
}
