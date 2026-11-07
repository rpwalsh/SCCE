// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { DialogueTurnPair, TranscriptTurn } from "./dialogue-communicative-act-learning.js";
import { unicodeLexicalSegments, type UnicodeSurfaceSegment } from "./unicode-segmentation.js";
import type { EvidenceSpan, Hasher } from "./types.js";

export interface ConversationalSpanUnit {
  span: EvidenceSpan;
  points: string[];
  sourceVersionId: string;
  profileId: string;
  transcriptTurns?: readonly TranscriptTurn[];
}

export interface ConversationalFrameOccurrence {
  frameKey: string;
  spanIndex: number;
  evidenceId: string;
  sourceVersionId: string;
  lineStart: number;
  lineEnd: number;
  slotStartInLine: number;
  slotEndInLine: number;
  literalUnits: number;
  filler: string;
  antecedent?: { startCodePoint: number; endCodePoint: number };
}

export interface PreparedConversationalFramePair {
  readonly pair: DialogueTurnPair;
  readonly unit: ConversationalSpanUnit;
  readonly line: { start: number; end: number };
  readonly linePoints: readonly string[];
  readonly segments: readonly UnicodeSurfaceSegment[];
  readonly requestUnits: readonly string[];
  readonly requestPositions?: ReadonlyMap<string, readonly number[]>;
}

/** Exact source segmentation is shared by both frame-counting passes. */
export function prepareConversationalFramePairs(units: readonly ConversationalSpanUnit[], pairs: readonly DialogueTurnPair[]): PreparedConversationalFramePair[] {
  const prepared: PreparedConversationalFramePair[] = [];
  for (const pair of pairs) {
    const unit = units[pair.documentIndex];
    if (!unit) continue;
    const lines = replyLines(unit.points, pair.reply.startCodePoint, pair.reply.endCodePoint);
    if (lines.length !== 1) continue;
    const line = lines[0]!;
    const surface = unit.points.slice(line.start, line.end).join("");
    const segments = unicodeLexicalSegments(surface);
    if (segments.length < 2) continue;
    const requestUnits = unicodeLexicalSegments(pair.requestText).map(segment => segment.normalized);
    const requestPositions = unit.transcriptTurns ? new Map<string, number[]>() : undefined;
    if (requestPositions) for (const [index, word] of requestUnits.entries()) {
      const positions = requestPositions.get(word) ?? [];
      positions.push(index);
      requestPositions.set(word, positions);
    }
    prepared.push({ pair, unit, line, linePoints: [...surface], segments, requestUnits, requestPositions });
  }
  return prepared;
}

/** Complete lexical-segment boundaries preserve the segmenter's surface-local normalization. */
export function walkConversationalFrames(pairs: readonly PreparedConversationalFramePair[], hasher: Hasher, visit: (occurrence: ConversationalFrameOccurrence) => void): void {
  for (const { pair, unit, line, linePoints, segments, requestUnits, requestPositions } of pairs) {
    for (let first = 0; first < segments.length; first++) {
      const starts = requestPositions ? [...(requestPositions.get(segments[first]!.normalized) ?? [])] : undefined;
      for (let last = first; last < segments.length; last++) {
        if (starts) {
          let retained = 0;
          for (const start of starts) if (requestUnits[start + last - first] === segments[last]!.normalized) starts[retained++] = start;
          starts.length = retained;
          if (!retained) break;
        }
        const literalUnits = first + (segments.length - 1 - last);
        if (literalUnits < 1) continue;
        const slotStart = segments[first]!.codePointStart;
        const slotEnd = segments[last]!.codePointEnd;
        const filler = linePoints.slice(slotStart, slotEnd).join("");
        const prefix = linePoints.slice(0, slotStart).join("");
        const suffix = linePoints.slice(slotEnd).join("");
        visit({ frameKey: hasher.digestHex(`${prefix}\u0000${suffix}`).slice(0, 24), spanIndex: pair.documentIndex,
          evidenceId: String(unit.span.id), sourceVersionId: unit.sourceVersionId, lineStart: line.start, lineEnd: line.end,
          slotStartInLine: slotStart, slotEndInLine: slotEnd, literalUnits, filler,
          ...(unit.transcriptTurns ? { antecedent: { startCodePoint: pair.request.startCodePoint, endCodePoint: pair.request.endCodePoint } } : {}) });
      }
    }
  }
}

function replyLines(points: readonly string[], start: number, end: number): Array<{ start: number; end: number }> {
  const lines: Array<{ start: number; end: number }> = [];
  let lineStart = start;
  for (let index = start; index <= end; index++) {
    if (index !== end && points[index] !== "\n") continue;
    let lineEnd = index;
    while (lineEnd > lineStart && /\s/u.test(points[lineEnd - 1] ?? "")) lineEnd -= 1;
    while (lineStart < lineEnd && /\s/u.test(points[lineStart] ?? "")) lineStart += 1;
    if (lineEnd > lineStart) lines.push({ start: lineStart, end: lineEnd });
    lineStart = index + 1;
  }
  return lines;
}
