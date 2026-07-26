import { clamp01, createHasher, entropy, toJsonValue } from "./primitives.js";
import { dominantScriptId, segmentUnicodeSurfaceV2 } from "./unicode-segmentation-v2.js";
import type { EvidenceId, Hasher, JsonValue, SourceVersionId } from "./types.js";

export const SURFACE_LATTICE_SCHEMA = "scce.surface_lattice.v1" as const;

export type SurfaceLatticeUnitKind =
  | "code_point"
  | "surface_segment"
  | "lexical"
  | "numeric"
  | "quote"
  | "code_symbol"
  | "line"
  | "sentence_like"
  | "paragraph"
  | "repeated_sequence";

export type SurfaceLatticeEdgeKind =
  | "sequence"
  | "contains"
  | "recurs_with";

export interface SurfaceBoundaryEvidence {
  positionCodePoint: number;
  bootstrapBoundaryProbability: number;
  features: {
    whitespaceAdjacent: number;
    punctuationAdjacent: number;
    lineBreakAdjacent: number;
    scriptTransition: number;
    structuralBoundary: number;
    localTransitionEntropy: number;
    repeatedContextSupport: number;
  };
}

export interface SurfaceLatticeUnit {
  id: string;
  kind: SurfaceLatticeUnitKind;
  surface: string;
  normalized: string;
  utf16Start: number;
  utf16End: number;
  codePointStart: number;
  codePointEnd: number;
  scriptId: string;
  recurrenceCount: number;
  entropy: number;
  predictability: number;
  leftContextSketch: string[];
  rightContextSketch: string[];
  boundaryBefore: SurfaceBoundaryEvidence;
  boundaryAfter: SurfaceBoundaryEvidence;
  evidenceIds: string[];
  sourceVersionId?: string;
}

export interface SurfaceLatticeEdge {
  id: string;
  fromUnitId: string;
  toUnitId: string;
  kind: SurfaceLatticeEdgeKind;
  weight: number;
}

export interface SurfaceLattice {
  schema: typeof SURFACE_LATTICE_SCHEMA;
  id: string;
  documentId: string;
  sourceVersionId?: string;
  evidenceIds: string[];
  textHash: string;
  units: SurfaceLatticeUnit[];
  edges: SurfaceLatticeEdge[];
  audit: JsonValue;
}

export interface SurfaceLatticeBuildOptions {
  documentId: string;
  text: string;
  sourceVersionId?: SourceVersionId | string;
  evidenceIds?: readonly (EvidenceId | string)[];
  hasher?: Hasher;
  maxUnits?: number;
  maxEdges?: number;
}

interface CandidateUnit {
  kind: SurfaceLatticeUnitKind;
  surface: string;
  utf16Start: number;
  utf16End: number;
  codePointStart: number;
  codePointEnd: number;
}

export function buildSurfaceLattice(options: SurfaceLatticeBuildOptions): SurfaceLattice {
  const hasher = options.hasher ?? createHasher();
  const maxUnits = Math.max(64, Math.floor(options.maxUnits ?? 4096));
  const maxEdges = Math.max(64, Math.floor(options.maxEdges ?? 8192));
  const text = options.text.replace(/\u0000/g, " ");
  const model = segmentUnicodeSurfaceV2(text, hasher);
  const evidenceIds = (options.evidenceIds ?? []).map(String).sort();
  const sourceVersionId = options.sourceVersionId === undefined ? undefined : String(options.sourceVersionId);
  const codePointIndexByUtf16 = buildUtf16ToCodePointIndex(text);
  const transitionEntropyByPosition = localTransitionEntropyByPosition(text);
  const normalizedCounts = new Map<string, number>();

  const candidates = [
    ...codePointCandidates(text, codePointIndexByUtf16),
    ...surfaceSegmentCandidates(model.surfaceSegments),
    ...lexicalCandidates(model.lexicalSegments),
    ...regexSpanCandidates(text, codePointIndexByUtf16, "numeric", /[+-]?(?:\d+(?:[.,:]\d+)*|\d*\.\d+)%?/gu),
    ...quoteSpanCandidates(text, codePointIndexByUtf16),
    ...regexSpanCandidates(text, codePointIndexByUtf16, "code_symbol", /[$_\p{Letter}][$_\p{Letter}\p{Number}]{1,64}/gu),
    ...lineCandidates(text, codePointIndexByUtf16),
    ...paragraphCandidates(text, codePointIndexByUtf16),
    ...sentenceLikeCandidates(text, codePointIndexByUtf16),
    ...repeatedSequenceCandidates(text, model.lexicalSegments)
  ];

  for (const candidate of candidates) {
    const key = recurrenceKey(candidate);
    normalizedCounts.set(key, (normalizedCounts.get(key) ?? 0) + 1);
  }

  const units: SurfaceLatticeUnit[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates.sort(compareCandidateUnits)) {
    if (units.length >= maxUnits) break;
    if (!candidate.surface) continue;
    const identity = `${candidate.kind}\u0001${candidate.codePointStart}\u0001${candidate.codePointEnd}\u0001${candidate.surface}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const normalized = normalizeSurface(candidate.surface);
    const recurrenceCount = normalizedCounts.get(recurrenceKey(candidate)) ?? 1;
    const before = boundaryEvidenceAt({
      text,
      positionCodePoint: candidate.codePointStart,
      structuralBoundary: structuralBoundaryAt(candidate.codePointStart, candidate.codePointEnd, text, codePointIndexByUtf16),
      transitionEntropyByPosition,
      repeatedContextSupport: recurrenceCount
    });
    const after = boundaryEvidenceAt({
      text,
      positionCodePoint: candidate.codePointEnd,
      structuralBoundary: structuralBoundaryAt(candidate.codePointStart, candidate.codePointEnd, text, codePointIndexByUtf16),
      transitionEntropyByPosition,
      repeatedContextSupport: recurrenceCount
    });
    units.push({
      id: `surface_unit.${hasher.digestHex(JSON.stringify([
        SURFACE_LATTICE_SCHEMA,
        options.documentId,
        candidate.kind,
        candidate.codePointStart,
        candidate.codePointEnd,
        candidate.surface
      ])).slice(0, 32)}`,
      kind: candidate.kind,
      surface: candidate.surface,
      normalized,
      utf16Start: candidate.utf16Start,
      utf16End: candidate.utf16End,
      codePointStart: candidate.codePointStart,
      codePointEnd: candidate.codePointEnd,
      scriptId: dominantScriptId(candidate.surface),
      recurrenceCount,
      entropy: entropy([...frequency([...candidate.surface]).values()]),
      predictability: clamp01(Math.log1p(recurrenceCount) / 8),
      leftContextSketch: contextSketch(model.lexicalSegments, candidate.codePointStart, "left"),
      rightContextSketch: contextSketch(model.lexicalSegments, candidate.codePointEnd, "right"),
      boundaryBefore: before,
      boundaryAfter: after,
      evidenceIds,
      ...(sourceVersionId ? { sourceVersionId } : {})
    });
  }

  const edges = latticeEdges(units, hasher, maxEdges);
  const countsByKind = new Map<SurfaceLatticeUnitKind, number>();
  for (const unit of units) countsByKind.set(unit.kind, (countsByKind.get(unit.kind) ?? 0) + 1);
  return {
    schema: SURFACE_LATTICE_SCHEMA,
    id: `surface_lattice.${hasher.digestHex(JSON.stringify([
      SURFACE_LATTICE_SCHEMA,
      options.documentId,
      sourceVersionId,
      evidenceIds,
      hasher.digestHex(text)
    ])).slice(0, 32)}`,
    documentId: options.documentId,
    ...(sourceVersionId ? { sourceVersionId } : {}),
    evidenceIds,
    textHash: hasher.digestHex(text),
    units,
    edges,
    audit: toJsonValue({
      builder: "kernel.surface_lattice.v1",
      inputUtf16Length: text.length,
      inputCodePoints: [...text].length,
      candidateUnits: candidates.length,
      persistedUnits: units.length,
      persistedEdges: edges.length,
      unitCapReached: candidates.length > units.length,
      edgeCapReached: edges.length >= maxEdges,
      unitsByKind: Object.fromEntries([...countsByKind.entries()].sort((a, b) => a[0].localeCompare(b[0]))),
      boundaryEstimator: {
        id: "bootstrap_surface_lattice_boundary_v1",
        status: "bootstrap_calibratable_features",
        note: "features are persisted for later calibration; punctuation/space are evidence, not mandatory grammar"
      }
    })
  };
}

function buildUtf16ToCodePointIndex(text: string): number[] {
  const index = new Array<number>(text.length + 1).fill(0);
  let codePoint = 0;
  let utf16 = 0;
  for (const char of text) {
    index[utf16] = codePoint;
    utf16 += char.length;
    codePoint += 1;
    index[utf16] = codePoint;
  }
  for (let i = 1; i < index.length; i++) if (index[i] === 0 && i > 0) index[i] = index[i - 1]!;
  return index;
}

function codePointAtUtf16(indexByUtf16: readonly number[], utf16: number): number {
  const bounded = Math.max(0, Math.min(indexByUtf16.length - 1, utf16));
  return indexByUtf16[bounded] ?? 0;
}

function utf16AtCodePoint(text: string, codePoint: number): number {
  let utf16 = 0;
  let current = 0;
  for (const char of text) {
    if (current >= codePoint) return utf16;
    utf16 += char.length;
    current += 1;
  }
  return text.length;
}

function codePointCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  const out: CandidateUnit[] = [];
  let utf16 = 0;
  let codePoint = 0;
  for (const char of text) {
    if (!/\s/u.test(char)) {
      out.push({
        kind: "code_point",
        surface: char,
        utf16Start: utf16,
        utf16End: utf16 + char.length,
        codePointStart: codePoint,
        codePointEnd: codePoint + 1
      });
    }
    utf16 += char.length;
    codePoint += 1;
  }
  void indexByUtf16;
  return out;
}

function surfaceSegmentCandidates(segments: ReturnType<typeof segmentUnicodeSurfaceV2>["surfaceSegments"]): CandidateUnit[] {
  return segments
    .filter(segment => segment.kind !== "whitespace" && segment.surface.length > 0)
    .map(segment => ({
      kind: "surface_segment" as const,
      surface: segment.surface,
      utf16Start: segment.utf16Start,
      utf16End: segment.utf16End,
      codePointStart: segment.codePointStart,
      codePointEnd: segment.codePointEnd
    }));
}

function lexicalCandidates(segments: ReturnType<typeof segmentUnicodeSurfaceV2>["lexicalSegments"]): CandidateUnit[] {
  return segments.map(segment => ({
    kind: "lexical" as const,
    surface: segment.surface,
    utf16Start: segment.utf16Start,
    utf16End: segment.utf16End,
    codePointStart: segment.codePointStart,
    codePointEnd: segment.codePointEnd
  }));
}

function regexSpanCandidates(
  text: string,
  indexByUtf16: readonly number[],
  kind: SurfaceLatticeUnitKind,
  regex: RegExp
): CandidateUnit[] {
  const out: CandidateUnit[] = [];
  for (const match of text.matchAll(regex)) {
    const surface = match[0];
    if (!surface) continue;
    const start = match.index ?? 0;
    const end = start + surface.length;
    out.push({
      kind,
      surface,
      utf16Start: start,
      utf16End: end,
      codePointStart: codePointAtUtf16(indexByUtf16, start),
      codePointEnd: codePointAtUtf16(indexByUtf16, end)
    });
  }
  return out;
}

function quoteSpanCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  const openers = new Map<string, string>([["\"", "\""], ["'", "'"], ["“", "”"], ["‘", "’"], ["「", "」"], ["『", "』"]]);
  const out: CandidateUnit[] = [];
  for (const [open, close] of openers) {
    let cursor = 0;
    while (cursor < text.length) {
      const start = text.indexOf(open, cursor);
      if (start < 0) break;
      const end = text.indexOf(close, start + open.length);
      if (end < 0 || end === start) break;
      const utf16End = end + close.length;
      const surface = text.slice(start, utf16End);
      if (surface.length <= 512) {
        out.push({
          kind: "quote",
          surface,
          utf16Start: start,
          utf16End,
          codePointStart: codePointAtUtf16(indexByUtf16, start),
          codePointEnd: codePointAtUtf16(indexByUtf16, utf16End)
        });
      }
      cursor = utf16End;
    }
  }
  return out;
}

function lineCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  return structuralSpanCandidates(text, indexByUtf16, "line", /\r?\n/u);
}

function paragraphCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  return structuralSpanCandidates(text, indexByUtf16, "paragraph", /\r?\n\s*\r?\n/u);
}

function structuralSpanCandidates(
  text: string,
  indexByUtf16: readonly number[],
  kind: SurfaceLatticeUnitKind,
  separator: RegExp
): CandidateUnit[] {
  const out: CandidateUnit[] = [];
  let start = 0;
  for (const match of text.matchAll(new RegExp(separator.source, `${separator.flags.includes("u") ? "u" : ""}g`))) {
    const end = match.index ?? 0;
    pushStructuralCandidate(out, text, indexByUtf16, kind, start, end);
    start = end + match[0].length;
  }
  pushStructuralCandidate(out, text, indexByUtf16, kind, start, text.length);
  return out;
}

function pushStructuralCandidate(
  out: CandidateUnit[],
  text: string,
  indexByUtf16: readonly number[],
  kind: SurfaceLatticeUnitKind,
  start: number,
  end: number
): void {
  const surface = text.slice(start, end).trim();
  if (!surface) return;
  const leading = text.slice(start, end).search(/\S/u);
  const utf16Start = start + Math.max(0, leading);
  const utf16End = utf16Start + surface.length;
  out.push({
    kind,
    surface,
    utf16Start,
    utf16End,
    codePointStart: codePointAtUtf16(indexByUtf16, utf16Start),
    codePointEnd: codePointAtUtf16(indexByUtf16, utf16End)
  });
}

function sentenceLikeCandidates(text: string, indexByUtf16: readonly number[]): CandidateUnit[] {
  const out: CandidateUnit[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    const terminal = /[\p{Sentence_Terminal};]/u.test(char);
    if (!terminal) continue;
    const end = i + char.length;
    pushStructuralCandidate(out, text, indexByUtf16, "sentence_like", start, end);
    start = end;
  }
  if (!out.length) pushStructuralCandidate(out, text, indexByUtf16, "sentence_like", 0, text.length);
  return out;
}

function repeatedSequenceCandidates(text: string, segments: ReturnType<typeof segmentUnicodeSurfaceV2>["lexicalSegments"]): CandidateUnit[] {
  const counts = new Map<string, number>();
  const occurrences = new Map<string, Array<{ start: number; end: number }>>();
  for (let width = 2; width <= 4; width++) {
    for (let index = 0; index <= segments.length - width; index++) {
      const window = segments.slice(index, index + width);
      const key = window.map(segment => segment.normalized).join("\u0001");
      counts.set(key, (counts.get(key) ?? 0) + 1);
      const bucket = occurrences.get(key) ?? [];
      if (bucket.length < 16) bucket.push({ start: index, end: index + width });
      occurrences.set(key, bucket);
    }
  }
  const out: CandidateUnit[] = [];
  for (const [key, count] of counts) {
    if (count < 2) continue;
    for (const occurrence of occurrences.get(key) ?? []) {
      const first = segments[occurrence.start];
      const last = segments[occurrence.end - 1];
      if (!first || !last) continue;
      out.push({
        kind: "repeated_sequence",
        surface: text.slice(first.utf16Start, last.utf16End),
        utf16Start: first.utf16Start,
        utf16End: last.utf16End,
        codePointStart: first.codePointStart,
        codePointEnd: last.codePointEnd
      });
    }
  }
  return out;
}

function contextSketch(
  lexical: ReturnType<typeof segmentUnicodeSurfaceV2>["lexicalSegments"],
  codePointPosition: number,
  direction: "left" | "right"
): string[] {
  const nearby = direction === "left"
    ? lexical.filter(segment => segment.codePointEnd <= codePointPosition).slice(-3)
    : lexical.filter(segment => segment.codePointStart >= codePointPosition).slice(0, 3);
  return nearby.map(segment => segment.normalized);
}

function boundaryEvidenceAt(input: {
  text: string;
  positionCodePoint: number;
  structuralBoundary: number;
  transitionEntropyByPosition: ReadonlyMap<number, number>;
  repeatedContextSupport: number;
}): SurfaceBoundaryEvidence {
  const chars = [...input.text];
  const left = chars[input.positionCodePoint - 1] ?? "";
  const right = chars[input.positionCodePoint] ?? "";
  const whitespaceAdjacent = left && right ? Number(/\s/u.test(left) || /\s/u.test(right)) : 1;
  const punctuationAdjacent = Number(isPunctuation(left) || isPunctuation(right));
  const lineBreakAdjacent = Number(left === "\n" || right === "\n" || left === "\r" || right === "\r");
  const scriptTransition = left && right && !/\s/u.test(left) && !/\s/u.test(right) && dominantScriptId(left) !== dominantScriptId(right) ? 1 : 0;
  const localTransitionEntropy = clamp01((input.transitionEntropyByPosition.get(input.positionCodePoint) ?? 0) / 4);
  const repeatedContextSupport = clamp01(Math.log1p(input.repeatedContextSupport) / 6);
  const bootstrapBoundaryProbability = clamp01(
    0.06
    + whitespaceAdjacent * 0.34
    + punctuationAdjacent * 0.18
    + lineBreakAdjacent * 0.2
    + scriptTransition * 0.08
    + input.structuralBoundary * 0.18
    + localTransitionEntropy * 0.08
    + repeatedContextSupport * 0.06
  );
  return {
    positionCodePoint: input.positionCodePoint,
    bootstrapBoundaryProbability,
    features: {
      whitespaceAdjacent,
      punctuationAdjacent,
      lineBreakAdjacent,
      scriptTransition,
      structuralBoundary: input.structuralBoundary,
      localTransitionEntropy,
      repeatedContextSupport
    }
  };
}

function structuralBoundaryAt(startCodePoint: number, endCodePoint: number, text: string, indexByUtf16: readonly number[]): number {
  const startUtf16 = utf16AtCodePoint(text, startCodePoint);
  const endUtf16 = utf16AtCodePoint(text, endCodePoint);
  const before = text.slice(Math.max(0, startUtf16 - 2), startUtf16);
  const after = text.slice(endUtf16, Math.min(text.length, endUtf16 + 2));
  void indexByUtf16;
  return Number(/\n\s*$/u.test(before) || /^\s*\n/u.test(after));
}

function localTransitionEntropyByPosition(text: string): Map<number, number> {
  const chars = [...text];
  const pairCounts = new Map<string, number>();
  for (let index = 0; index < chars.length - 1; index++) {
    const key = `${charClass(chars[index]!)}\u0001${charClass(chars[index + 1]!)}`;
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
  }
  const out = new Map<number, number>();
  for (let position = 1; position < chars.length; position++) {
    const window: number[] = [];
    for (let offset = -4; offset <= 4; offset++) {
      const left = chars[position + offset - 1];
      const right = chars[position + offset];
      if (!left || !right) continue;
      window.push(pairCounts.get(`${charClass(left)}\u0001${charClass(right)}`) ?? 1);
    }
    out.set(position, entropy(window));
  }
  return out;
}

function latticeEdges(units: readonly SurfaceLatticeUnit[], hasher: Hasher, maxEdges: number): SurfaceLatticeEdge[] {
  const edges: SurfaceLatticeEdge[] = [];
  const byKind = new Map<SurfaceLatticeUnitKind, SurfaceLatticeUnit[]>();
  for (const unit of units) {
    const bucket = byKind.get(unit.kind) ?? [];
    bucket.push(unit);
    byKind.set(unit.kind, bucket);
  }
  for (const [kind, items] of byKind) {
    const sorted = [...items].sort((a, b) => a.codePointStart - b.codePointStart || a.codePointEnd - b.codePointEnd);
    for (let i = 0; i < sorted.length - 1 && edges.length < maxEdges; i++) {
      pushEdge(edges, hasher, sorted[i]!.id, sorted[i + 1]!.id, "sequence", kind === "lexical" ? 0.92 : 0.72);
    }
  }
  const lexical = units.filter(unit => unit.kind === "lexical");
  const containers = units.filter(unit => unit.kind === "line" || unit.kind === "sentence_like" || unit.kind === "paragraph" || unit.kind === "repeated_sequence");
  for (const container of containers) {
    for (const unit of lexical) {
      if (edges.length >= maxEdges) break;
      if (unit.codePointStart >= container.codePointStart && unit.codePointEnd <= container.codePointEnd && unit.id !== container.id) {
        pushEdge(edges, hasher, container.id, unit.id, "contains", 0.8);
      }
    }
  }
  const recurring = new Map<string, SurfaceLatticeUnit[]>();
  for (const unit of units.filter(item => item.recurrenceCount > 1 && item.kind !== "code_point")) {
    const bucket = recurring.get(`${unit.kind}\u0001${unit.normalized}`) ?? [];
    bucket.push(unit);
    recurring.set(`${unit.kind}\u0001${unit.normalized}`, bucket);
  }
  for (const items of recurring.values()) {
    const sorted = [...items].sort((a, b) => a.codePointStart - b.codePointStart);
    for (let i = 0; i < sorted.length - 1 && edges.length < maxEdges; i++) {
      pushEdge(edges, hasher, sorted[i]!.id, sorted[i + 1]!.id, "recurs_with", clamp01(Math.log1p(sorted.length) / 6));
    }
  }
  return edges;
}

function pushEdge(
  edges: SurfaceLatticeEdge[],
  hasher: Hasher,
  fromUnitId: string,
  toUnitId: string,
  kind: SurfaceLatticeEdgeKind,
  weight: number
): void {
  edges.push({
    id: `surface_edge.${hasher.digestHex(JSON.stringify([fromUnitId, toUnitId, kind])).slice(0, 32)}`,
    fromUnitId,
    toUnitId,
    kind,
    weight: clamp01(weight)
  });
}

function recurrenceKey(candidate: CandidateUnit): string {
  return `${candidate.kind}\u0001${normalizeSurface(candidate.surface)}`;
}

function normalizeSurface(surface: string): string {
  return surface.normalize("NFC").toLowerCase().replace(/\s+/gu, " ").trim();
}

function compareCandidateUnits(left: CandidateUnit, right: CandidateUnit): number {
  return left.codePointStart - right.codePointStart
    || left.codePointEnd - right.codePointEnd
    || unitKindRank(left.kind) - unitKindRank(right.kind)
    || left.surface.localeCompare(right.surface);
}

function unitKindRank(kind: SurfaceLatticeUnitKind): number {
  return [
    "paragraph",
    "line",
    "sentence_like",
    "repeated_sequence",
    "quote",
    "numeric",
    "code_symbol",
    "lexical",
    "surface_segment",
    "code_point"
  ].indexOf(kind);
}

function frequency(symbols: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const symbol of symbols) out.set(symbol, (out.get(symbol) ?? 0) + 1);
  return out;
}

function isPunctuation(value: string): boolean {
  return Boolean(value && /\p{Punctuation}/u.test(value));
}

function charClass(value: string): string {
  if (!value) return "boundary";
  if (/\s/u.test(value)) return "space";
  if (/\p{Number}/u.test(value)) return "number";
  if (/\p{Punctuation}/u.test(value)) return "punctuation";
  return dominantScriptId(value);
}
