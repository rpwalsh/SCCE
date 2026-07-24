export type UnicodeSurfaceSegmentKind =
  | "word"
  | "grapheme"
  | "number"
  | "punctuation"
  | "symbol"
  | "whitespace"
  | "control";

export type UnicodeBoundaryClassId =
  | "segment.boundary.word"
  | "segment.boundary.grapheme"
  | "segment.boundary.number"
  | "segment.boundary.punctuation"
  | "segment.boundary.symbol"
  | "segment.boundary.whitespace"
  | "segment.boundary.control";

export interface UnicodeSurfaceSegment {
  surface: string;
  normalized: string;
  kind: UnicodeSurfaceSegmentKind;
  boundaryClassId: UnicodeBoundaryClassId;
  utf16Start: number;
  utf16End: number;
  codePointStart: number;
  codePointEnd: number;
}

interface GraphemeSlice {
  surface: string;
  utf16Start: number;
  utf16End: number;
  codePointStart: number;
  codePointEnd: number;
}

const GRAPHEME_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/**
 * Produces an exact, reversible source segmentation. Unicode grapheme
 * boundaries are locale-independent; no script is mapped to a language or
 * locale. Latin letter/number runs retain their existing lexical-word shape.
 * Other writing systems remain as reversible grapheme symbols so unspaced
 * surfaces cannot collapse into one opaque token.
 */
export function segmentUnicodeSurface(text: string): UnicodeSurfaceSegment[] {
  if (!text) return [];
  const graphemes = graphemeSlices(text);
  const out: UnicodeSurfaceSegment[] = [];
  for (let index = 0; index < graphemes.length;) {
    const current = graphemes[index]!;
    if (isWhitespace(current.surface)) {
      const end = consumeWhile(graphemes, index + 1, row => isWhitespace(row.surface));
      out.push(combineSegment(graphemes.slice(index, end), "whitespace"));
      index = end;
      continue;
    }
    if (isControl(current.surface)) {
      out.push(segmentFromGrapheme(current, "control"));
      index += 1;
      continue;
    }
    if (isLatinWordGrapheme(current.surface)
      || isDecimalNumber(current.surface)
      || current.surface === "_" && isLatinWordContinuation(graphemes[index + 1]?.surface)) {
      const end = consumeLatinWord(graphemes, index);
      const rows = graphemes.slice(index, end);
      const kind = rows.every(row => isDecimalNumber(row.surface)) ? "number" : "word";
      out.push(combineSegment(rows, kind));
      index = end;
      continue;
    }
    if (isLetterOrMark(current.surface)) {
      out.push(segmentFromGrapheme(current, "grapheme"));
      index += 1;
      continue;
    }
    if (isPunctuation(current.surface)) {
      out.push(segmentFromGrapheme(current, "punctuation"));
      index += 1;
      continue;
    }
    out.push(segmentFromGrapheme(current, "symbol"));
    index += 1;
  }
  if (reconstructUnicodeSurface(out) !== text) {
    throw new Error("unicode segmentation violated reversible source coordinates");
  }
  return out;
}

export function unicodeSymbolSegments(text: string): UnicodeSurfaceSegment[] {
  return segmentUnicodeSurface(text)
    .filter(segment => segment.kind !== "whitespace" && segment.kind !== "control");
}

export function unicodeLexicalSegments(text: string): UnicodeSurfaceSegment[] {
  return segmentUnicodeSurface(text)
    .filter(segment => segment.kind === "word" || segment.kind === "grapheme" || segment.kind === "number");
}

export function reconstructUnicodeSurface(segments: readonly UnicodeSurfaceSegment[]): string {
  return segments.map(segment => segment.surface).join("");
}

function graphemeSlices(text: string): GraphemeSlice[] {
  const out: GraphemeSlice[] = [];
  let codePointStart = 0;
  for (const row of GRAPHEME_SEGMENTER.segment(text)) {
    const surface = row.segment;
    const codePointLength = [...surface].length;
    out.push({
      surface,
      utf16Start: row.index,
      utf16End: row.index + surface.length,
      codePointStart,
      codePointEnd: codePointStart + codePointLength
    });
    codePointStart += codePointLength;
  }
  return out;
}

function consumeWhile(
  rows: readonly GraphemeSlice[],
  start: number,
  predicate: (row: GraphemeSlice) => boolean
): number {
  let index = start;
  while (index < rows.length && predicate(rows[index]!)) index += 1;
  return index;
}

function consumeLatinWord(rows: readonly GraphemeSlice[], start: number): number {
  let index = start;
  while (index < rows.length) {
    const surface = rows[index]!.surface;
    if (isLatinWordGrapheme(surface) || isDecimalNumber(surface) || surface === "_") {
      index += 1;
      continue;
    }
    if (isApostrophe(surface)
      && index > start
      && index + 1 < rows.length
      && isLatinWordGrapheme(rows[index + 1]!.surface)) {
      index += 1;
      continue;
    }
    break;
  }
  return Math.max(start + 1, index);
}

function isLatinWordContinuation(surface: string | undefined): boolean {
  return Boolean(surface && (isLatinWordGrapheme(surface) || isDecimalNumber(surface)));
}

function segmentFromGrapheme(
  row: GraphemeSlice,
  kind: UnicodeSurfaceSegmentKind
): UnicodeSurfaceSegment {
  return {
    surface: row.surface,
    normalized: normalizedSymbol(row.surface),
    kind,
    boundaryClassId: boundaryClassFor(kind),
    utf16Start: row.utf16Start,
    utf16End: row.utf16End,
    codePointStart: row.codePointStart,
    codePointEnd: row.codePointEnd
  };
}

function combineSegment(
  rows: readonly GraphemeSlice[],
  kind: UnicodeSurfaceSegmentKind
): UnicodeSurfaceSegment {
  const first = rows[0]!;
  const last = rows[rows.length - 1]!;
  const surface = rows.map(row => row.surface).join("");
  return {
    surface,
    normalized: normalizedSymbol(surface),
    kind,
    boundaryClassId: boundaryClassFor(kind),
    utf16Start: first.utf16Start,
    utf16End: last.utf16End,
    codePointStart: first.codePointStart,
    codePointEnd: last.codePointEnd
  };
}

function normalizedSymbol(surface: string): string {
  return surface.normalize("NFC").toLowerCase();
}

function boundaryClassFor(kind: UnicodeSurfaceSegmentKind): UnicodeBoundaryClassId {
  return `segment.boundary.${kind}`;
}

function isLatinWordGrapheme(surface: string): boolean {
  return /\p{Script_Extensions=Latin}/u.test(surface)
    && /[\p{Letter}\p{Mark}]/u.test(surface);
}

function isLetterOrMark(surface: string): boolean {
  return /[\p{Letter}\p{Mark}]/u.test(surface);
}

function isDecimalNumber(surface: string): boolean {
  return /^\p{Decimal_Number}+$/u.test(surface);
}

function isWhitespace(surface: string): boolean {
  return /^\s+$/u.test(surface);
}

function isControl(surface: string): boolean {
  return /^\p{Control}+$/u.test(surface);
}

function isPunctuation(surface: string): boolean {
  return /^\p{Punctuation}+$/u.test(surface);
}

function isApostrophe(surface: string): boolean {
  return surface === "'" || surface === "\u2019";
}
