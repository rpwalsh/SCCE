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

export function ensureSurfaceSentence(text: string, boundary = "."): string {
  const clean = collapseSurfaceWhitespace(text);
  if (!clean) return "";
  const last = [...clean].at(-1) ?? "";
  return isSentenceBoundarySymbol(last) ? clean : `${clean}${isSentenceBoundarySymbol(boundary) ? boundary : "."}`;
}

export function stripTerminalSentenceBoundary(text: string): string {
  const clean = collapseSurfaceWhitespace(text);
  const chars = [...clean];
  const last = chars.at(-1) ?? "";
  return isSentenceBoundarySymbol(last) ? chars.slice(0, -1).join("").trimEnd() : clean;
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
  return true;
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
