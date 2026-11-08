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
  roles?: readonly { slotIndex: number; occurrenceIndex: number; startCodePoint: number; endCodePoint: number }[];
}

export interface PreparedConversationalFramePair {
  readonly pair: DialogueTurnPair;
  readonly unit: ConversationalSpanUnit;
  readonly line: { start: number; end: number };
  readonly linePoints: readonly string[];
  readonly segments: readonly UnicodeSurfaceSegment[];
  readonly requestUnits: readonly string[];
  readonly requestSegments: readonly UnicodeSurfaceSegment[];
  readonly requestPositions?: ReadonlyMap<string, readonly number[]>;
}

/** Exact source segmentation is shared by both frame-counting passes. */
export function prepareConversationalFramePairs(units: readonly ConversationalSpanUnit[], pairs: readonly DialogueTurnPair[]): PreparedConversationalFramePair[] {
  const prepared: PreparedConversationalFramePair[] = [];
  for (const pair of pairs) {
    const unit = units[pair.documentIndex];
    if (!unit) continue;
    const line = { start: pair.reply.startCodePoint, end: pair.reply.endCodePoint };
    const surface = unit.points.slice(line.start, line.end).join("");
    const segments = unicodeLexicalSegments(surface);
    if (segments.length < 2) continue;
    const requestSegments = unicodeLexicalSegments(pair.requestText);
    const requestUnits = requestSegments.map(segment => segment.normalized);
    const requestPositions = unit.transcriptTurns ? new Map<string, number[]>() : undefined;
    if (requestPositions) for (const [index, word] of requestUnits.entries()) {
      const positions = requestPositions.get(word) ?? [];
      positions.push(index);
      requestPositions.set(word, positions);
    }
    prepared.push({ pair, unit, line, linePoints: [...surface], segments, requestUnits, requestSegments, requestPositions });
  }
  return prepared;
}

/** Complete lexical-segment boundaries preserve the segmenter's surface-local normalization. */
export function walkConversationalFrames(pairs: readonly PreparedConversationalFramePair[], hasher: Hasher, visit: (occurrence: ConversationalFrameOccurrence) => void): void {
  for (const { pair, unit, line, linePoints, segments, requestUnits, requestSegments, requestPositions } of pairs) {
    if (requestPositions) {
      const roles = copiedRequestRoles(linePoints, segments, [...pair.requestText], requestSegments, requestPositions);
      if (roles && roles.length > 1) {
        let previous = 0;
        const form: Array<string | { slot: number }> = [];
        for (const role of roles) {
          form.push(linePoints.slice(previous, role.startCodePoint).join(""), { slot: role.slotIndex });
          previous = role.endCodePoint;
        }
        form.push(linePoints.slice(previous).join(""));
        const literalUnits = segments.filter(segment => !roles.some(role => segment.codePointStart >= role.startCodePoint && segment.codePointEnd <= role.endCodePoint)).length;
        if (literalUnits) visit({ frameKey: hasher.digestHex(JSON.stringify(form)).slice(0, 24), spanIndex: pair.documentIndex,
          evidenceId: String(unit.span.id), sourceVersionId: unit.sourceVersionId, lineStart: line.start, lineEnd: line.end,
          slotStartInLine: roles[0]!.startCodePoint, slotEndInLine: roles.at(-1)!.endCodePoint, literalUnits,
          filler: JSON.stringify(roles.map(role => linePoints.slice(role.startCodePoint, role.endCodePoint).join(""))), roles,
          antecedent: { startCodePoint: pair.request.startCodePoint, endCodePoint: pair.request.endCodePoint } });
      }
    }
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

/** Maximal copied runs have one source owner. Repeated reply uses share that owner's role. */
function copiedRequestRoles(reply: readonly string[], segments: readonly UnicodeSurfaceSegment[], request: readonly string[], source: readonly UnicodeSurfaceSegment[], positions: ReadonlyMap<string, readonly number[]>) {
  const runs: Array<{ startCodePoint: number; endCodePoint: number; sourceStart: number; sourceEnd: number }> = [];
  for (let first = 0; first < segments.length;) {
    let longest = 0;
    const owners: number[] = [];
    for (const start of positions.get(segments[first]!.normalized) ?? []) {
      let length = 0;
      while (first + length < segments.length && start + length < source.length
        && segments[first + length]!.normalized === source[start + length]!.normalized) length++;
      while (length && reply.slice(segments[first]!.codePointStart, segments[first + length - 1]!.codePointEnd).join("")
        !== request.slice(source[start]!.codePointStart, source[start + length - 1]!.codePointEnd).join("")) length--;
      if (length > longest) { longest = length; owners.length = 0; }
      if (length && length === longest) owners.push(start);
    }
    if (!longest) { first++; continue; }
    // Ambiguous source occurrences are never assigned a position by a tie-break.
    if (owners.length !== 1) return undefined;
    const start = owners[0]!;
    runs.push({ startCodePoint: segments[first]!.codePointStart, endCodePoint: segments[first + longest - 1]!.codePointEnd,
      sourceStart: source[start]!.codePointStart, sourceEnd: source[start + longest - 1]!.codePointEnd });
    first += longest;
  }
  const owners = [...new Map(runs.map(run => [`${run.sourceStart}:${run.sourceEnd}`, run])).values()].sort((a, b) => a.sourceStart - b.sourceStart);
  if (owners.some((owner, index) => index > 0 && owner.sourceStart < owners[index - 1]!.sourceEnd)) return undefined;
  const counts = new Map<number, number>();
  return runs.map(run => {
    const slotIndex = owners.findIndex(owner => owner.sourceStart === run.sourceStart && owner.sourceEnd === run.sourceEnd);
    const occurrenceIndex = counts.get(slotIndex) ?? 0; counts.set(slotIndex, occurrenceIndex + 1);
    return { slotIndex, occurrenceIndex, startCodePoint: run.startCodePoint, endCodePoint: run.endCodePoint };
  });
}
