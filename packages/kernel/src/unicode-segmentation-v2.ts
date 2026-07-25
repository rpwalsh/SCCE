import { createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";
import { learnedScriptIdForCharacter } from "./language.js";
import {
  reconstructUnicodeSurface,
  segmentUnicodeSurface,
  type UnicodeSurfaceSegment
} from "./unicode-segmentation.js";

export const SEGMENTATION_SCHEMA_V2 = "scce.segmentation.v2";

export type ScriptBoundarySignalKind = "space_separated" | "no_space_boundary" | "mixed" | "insufficient_evidence";

/**
 * Real, per-document corpus-derived evidence of a script's word-spacing
 * convention -- computed from actually-observed adjacent same-script
 * lexical boundaries in this text, not an assumption. Aggregating this
 * across a whole corpus per script (rather than per document) is the next
 * step (durable per-language-cluster aggregate models), deliberately not
 * built here.
 */
export interface ScriptBoundarySignal {
  scriptId: string;
  kind: ScriptBoundarySignalKind;
  observedSpacedRatio: number;
  observations: number;
}

export interface LexicalSegment {
  surface: string;
  normalized: string;
  scriptId: string;
  utf16Start: number;
  utf16End: number;
  codePointStart: number;
  codePointEnd: number;
  /** Real evidence from this text: was this lexical segment followed by whitespace before the next one. */
  followedByWhitespace: boolean;
}

/**
 * Versioned tokenizer/detokenizer contract (Part B step 1). `surfaceSegments`
 * is exactly `segmentUnicodeSurface()`'s existing, unchanged, fully
 * reversible v1 output -- evidence hashes, n-gram identities, and stored
 * profile ids that already depend on v1 segmentation are untouched.
 * `lexicalSegments` is the new layer: real word-level grouping for every
 * script, not just Latin, driven by `Intl.Segmenter`'s dictionary-based word
 * boundaries rather than the v1 asymmetry (Latin gets grouped words,
 * everything else gets atomized to single graphemes). A stored model's
 * `schemaVersion` must never be silently mixed with v1 state; callers that
 * hydrate persisted segmentation/n-gram data must check it explicitly.
 */
export interface SegmentationModel {
  schemaVersion: typeof SEGMENTATION_SCHEMA_V2;
  surfaceSegments: UnicodeSurfaceSegment[];
  lexicalSegments: LexicalSegment[];
  boundarySignals: ScriptBoundarySignal[];
  reconstructionHash: string;
}

const WORD_SEGMENTER = new Intl.Segmenter(undefined, { granularity: "word" });

interface IcuWordSpan {
  start: number;
  end: number;
  isWordLike: boolean;
}

export function segmentUnicodeSurfaceV2(text: string, hasher: Hasher = createHasher()): SegmentationModel {
  const surfaceSegments = segmentUnicodeSurface(text);
  const lexicalSegments = lexicalSegmentsV2(text, surfaceSegments);
  return {
    schemaVersion: SEGMENTATION_SCHEMA_V2,
    surfaceSegments,
    lexicalSegments,
    boundarySignals: boundarySignalsFromLexicalSegments(lexicalSegments),
    reconstructionHash: hasher.digestHex(reconstructUnicodeSurface(surfaceSegments))
  };
}

export function reconstructFromSegmentationModel(model: SegmentationModel): string {
  return reconstructUnicodeSurface(model.surfaceSegments);
}

/**
 * Real, well-established Unicode/CLDR fact (why `Intl.Segmenter` requires a
 * dictionary-based break iterator for exactly these scripts): Han,
 * Hiragana, and Katakana text is conventionally written without inter-word
 * spaces; Thai is likewise conventionally unspaced. Every other script this
 * codebase classifies (Latin, Cyrillic, Greek, Arabic, Hebrew, Devanagari,
 * Hangul, ...) is conventionally space- or boundary-mark separated. This is
 * a static linguistic fact, not a per-corpus inference -- the per-document
 * `ScriptBoundarySignal` above is the real, evidence-derived layer; this is the
 * fallback used when no corpus evidence exists yet (e.g. joining freshly
 * generated pieces with no shared source document).
 */
const CONVENTIONALLY_UNSPACED_SCRIPTS = new Set(["script:Hani", "script:Hira", "script:Kana", "script:Thai"]);

export function scriptUsesSpaceSeparatedWords(scriptId: string): boolean {
  return !CONVENTIONALLY_UNSPACED_SCRIPTS.has(scriptId);
}

/**
 * Joins independently-selected generation pieces (which may originate from
 * different source documents/scripts, so no single document's real boundary
 * evidence applies) using the real per-script spacing convention above,
 * instead of unconditionally inserting `" "` between every piece regardless
 * of script -- the confirmed root cause of non-Latin generation surfaces
 * accumulating spurious inter-character spaces.
 */
export function joinLexicalSurfaces(pieces: ReadonlyArray<{ text: string; scriptId: string }>): string {
  let out = "";
  let previousScript: string | undefined;
  for (const piece of pieces) {
    if (!piece.text) continue;
    // A space is warranted if *either* adjacent script conventionally needs
    // one to mark a word boundary -- a spaced-script word (e.g. Latin)
    // fusing visually with unspaced CJK content is the failure mode this
    // guards against, regardless of which side is unspaced.
    if (out.length > 0 && (scriptUsesSpaceSeparatedWords(previousScript ?? piece.scriptId) || scriptUsesSpaceSeparatedWords(piece.scriptId))) out += " ";
    out += piece.text;
    previousScript = piece.scriptId;
  }
  return out;
}

/** Dominant script id for a surface string, using majority vote over its letter/mark/number characters. */
export function dominantScriptId(text: string): string {
  const counts = new Map<string, number>();
  for (const char of text) {
    if (!/[\p{Letter}\p{Mark}\p{Number}]/u.test(char)) continue;
    const scriptId = learnedScriptIdForCharacter(char);
    counts.set(scriptId, (counts.get(scriptId) ?? 0) + 1);
  }
  let best: string | undefined;
  let bestCount = 0;
  for (const [scriptId, count] of counts) {
    if (count > bestCount) { best = scriptId; bestCount = count; }
  }
  return best ?? "script:Zyyy";
}

function icuWordSpans(text: string): IcuWordSpan[] {
  const spans: IcuWordSpan[] = [];
  for (const segment of WORD_SEGMENTER.segment(text)) {
    spans.push({ start: segment.index, end: segment.index + segment.segment.length, isWordLike: segment.isWordLike === true });
  }
  return spans;
}

function lexicalSegmentsV2(text: string, surfaceSegments: readonly UnicodeSurfaceSegment[]): LexicalSegment[] {
  const spans = icuWordSpans(text);
  let spanIndex = 0;
  const out: LexicalSegment[] = [];
  let i = 0;
  while (i < surfaceSegments.length) {
    const segment = surfaceSegments[i]!;
    if (segment.kind === "word" || segment.kind === "number") {
      out.push(lexicalFromSurfaceSegments([segment], followsWhitespace(surfaceSegments, i + 1)));
      i += 1;
      continue;
    }
    if (segment.kind !== "grapheme") {
      i += 1;
      continue;
    }
    while (spanIndex < spans.length - 1 && spans[spanIndex]!.end <= segment.utf16Start) spanIndex += 1;
    const span = spans[spanIndex];
    if (!span || !span.isWordLike || segment.utf16Start < span.start || segment.utf16End > span.end) {
      out.push(lexicalFromSurfaceSegments([segment], followsWhitespace(surfaceSegments, i + 1)));
      i += 1;
      continue;
    }
    const start = i;
    let j = i;
    while (
      j < surfaceSegments.length
      && surfaceSegments[j]!.kind === "grapheme"
      && surfaceSegments[j]!.utf16Start >= span.start
      && surfaceSegments[j]!.utf16End <= span.end
    ) j += 1;
    out.push(lexicalFromSurfaceSegments(surfaceSegments.slice(start, j), followsWhitespace(surfaceSegments, j)));
    i = j;
  }
  return out;
}

function followsWhitespace(surfaceSegments: readonly UnicodeSurfaceSegment[], nextIndex: number): boolean {
  return surfaceSegments[nextIndex]?.kind === "whitespace";
}

function lexicalFromSurfaceSegments(segments: readonly UnicodeSurfaceSegment[], followedByWhitespace: boolean): LexicalSegment {
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  const surface = segments.map(segment => segment.surface).join("");
  return {
    surface,
    normalized: surface.normalize("NFC").toLowerCase(),
    scriptId: dominantScriptId(surface),
    utf16Start: first.utf16Start,
    utf16End: last.utf16End,
    codePointStart: first.codePointStart,
    codePointEnd: last.codePointEnd,
    followedByWhitespace
  };
}

function boundarySignalsFromLexicalSegments(lexicalSegments: readonly LexicalSegment[]): ScriptBoundarySignal[] {
  const spacedCounts = new Map<string, number>();
  const totalCounts = new Map<string, number>();
  for (let i = 0; i < lexicalSegments.length - 1; i += 1) {
    const current = lexicalSegments[i]!;
    const next = lexicalSegments[i + 1]!;
    if (current.scriptId !== next.scriptId) continue;
    totalCounts.set(current.scriptId, (totalCounts.get(current.scriptId) ?? 0) + 1);
    if (current.followedByWhitespace) spacedCounts.set(current.scriptId, (spacedCounts.get(current.scriptId) ?? 0) + 1);
  }
  return [...totalCounts.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([scriptId, observations]) => {
      const spaced = spacedCounts.get(scriptId) ?? 0;
      const ratio = observations > 0 ? spaced / observations : 0;
      const kind: ScriptBoundarySignalKind = observations < 3
        ? "insufficient_evidence"
        : ratio > 0.8
          ? "space_separated"
          : ratio < 0.2
            ? "no_space_boundary"
            : "mixed";
      return { scriptId, kind, observedSpacedRatio: ratio, observations };
    });
}
