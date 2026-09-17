// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { conversationalActBindingId } from "./conversational-act-binding.js";
import { dialogueTurnPairs, type DialogueTurnPair } from "./dialogue-communicative-act-learning.js";
import { DIALOGUE_ACT_IDS, type DialogueActId } from "./dialogue-pragmatics.js";
import { otsuThreshold } from "./language-identity.js";
import type { SourceBoundConstructionObservation, SourceBoundLanguageConstructionTrainingSet } from "./language-construction-memory.js";
import { requestCommunicativeActIdForSignature } from "./request-communicative-act.js";
import { unicodeLexicalSegments } from "./unicode-segmentation.js";
import type { EvidenceSpan, Hasher } from "./types.js";

/** One transcript, as the promoted evidence spans it was stored as. Each span is read on its own terms. */
export interface ConversationalConstructionDocument {
  sourceVersionId: string;
  profileId: string;
  spans: readonly EvidenceSpan[];
}

export interface ConversationalActConstructionSet extends SourceBoundLanguageConstructionTrainingSet {
  actId: DialogueActId;
  profileId: string;
  constructionFrames: number;
  sourceVersionIds: string[];
}

export interface ConversationalConstructionInductionReport {
  schema: "scce.conversational_construction_induction.v1";
  documentsRead: number;
  spansRead: number;
  spansSegmented: number;
  adjacentPairs: number;
  /** Pairs whose act is the neutral evidence-bearing lookup shape, which this lane may never speak from. */
  neutralPairs: number;
  recurringFrames: number;
  varyingFrames: number;
  /** Otsu split of how many lexical units a varying frame keeps outside its slot: a scrap of a turn, or a move. */
  literalFormFloor: number;
  bodiedFrames: number;
  fillerDiversityFloor: number;
  sourceFamilyFloor: number;
  keptFrames: number;
  observations: number;
  sets: ConversationalActConstructionSet[];
}

/** One evidence span read as its own transcript, so every offset a frame records is exact within that span. */
interface SpanUnit {
  span: EvidenceSpan;
  points: string[];
  sourceVersionId: string;
  profileId: string;
}

interface FrameOccurrence {
  frameKey: string;
  spanIndex: number;
  evidenceId: string;
  sourceVersionId: string;
  /** Code-point range of the whole line the frame was measured in, within its own evidence span. */
  lineStart: number;
  lineEnd: number;
  slotStartInLine: number;
  slotEndInLine: number;
  /** Lexical units the line keeps outside the slot. The frame's own size, measured, not its character count. */
  literalUnits: number;
  filler: string;
}

/**
 * Induces conversational constructions from a dialogue corpus's own replies, keyed by the act the turn before
 * them was measured to be. The frame is anti-unification over what actually recurred: a line the corpus repeats
 * with one contiguous run of lexical units exchanged is form with a variable in it, and the exchanged run is the
 * variable. Requiring that run to be exactly one unit is what kept the frames to two symbols, because a whole
 * reply line only recurs verbatim when it is short. All three gates -- how much form the frame keeps outside its
 * slot, how many distinct fillers it was observed with, and how many independent source versions it spans -- are
 * Otsu splits of the corpus's own observed distributions, never declared numbers; and a frame that keeps no
 * lexical unit outside its slot is not retained: with nothing left over it is the identity, not a construction.
 *
 * The output is the `SourceBoundLanguageConstructionTrainingSet` shape `compileLanguageConstructionPattern`
 * already consumes, so the anti-unification, bundle and durability machinery is the relation lane's, unchanged;
 * only the alignment that feeds it is conversational instead of predicate-anchored.
 */
export function induceConversationalActConstructionTrainingSets(input: {
  documents: readonly ConversationalConstructionDocument[];
  hasher: Hasher;
  maxObservationsPerAct?: number;
}): ConversationalConstructionInductionReport {
  const units: SpanUnit[] = [];
  for (const document of input.documents) {
    for (const span of [...document.spans].sort((left, right) => left.charStart - right.charStart)) {
      const points = [...span.text];
      // The compiler re-slices the span by code point, so a span whose recorded range is not its own text cannot align.
      if (span.charEnd - span.charStart !== points.length) continue;
      units.push({ span, points, sourceVersionId: document.sourceVersionId, profileId: document.profileId });
    }
  }

  const measured = dialogueTurnPairs(units.map(unit => unit.span.text));
  const byAct = new Map<DialogueActId, DialogueTurnPair[]>();
  let neutralPairs = 0;
  for (const pair of measured.pairs) {
    const actId = requestCommunicativeActIdForSignature({
      accepted: true,
      evidenceBearing: pair.responseEvidenceCount > 0,
      continuation: pair.continuation
    });
    // The neutral act is the evidence-bearing lookup shape the factual lane already answers; this lane may not speak it.
    if (actId === DIALOGUE_ACT_IDS.neutral) { neutralPairs += 1; continue; }
    const list = byAct.get(actId) ?? [];
    list.push(pair);
    byAct.set(actId, list);
  }

  const sets: ConversationalActConstructionSet[] = [];
  let recurringFrames = 0;
  let varyingFrames = 0;
  let keptFrames = 0;
  let observationCount = 0;
  let literalFormFloor = 0;
  let bodiedFrames = 0;
  let fillerDiversityFloor = 0;
  let sourceFamilyFloor = 0;

  for (const [actId, pairs] of [...byAct.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const counts = new Map<string, number>();
    walkFrames(units, pairs, input.hasher, occurrence => {
      counts.set(occurrence.frameKey, (counts.get(occurrence.frameKey) ?? 0) + 1);
    });
    const frames = new Map<string, { fillers: Set<string>; families: Set<string>; literalUnits: number; occurrences: FrameOccurrence[] }>();
    walkFrames(units, pairs, input.hasher, occurrence => {
      if ((counts.get(occurrence.frameKey) ?? 0) < 2) return;
      const frame = frames.get(occurrence.frameKey)
        ?? { fillers: new Set<string>(), families: new Set<string>(), literalUnits: occurrence.literalUnits, occurrences: [] };
      frame.fillers.add(occurrence.filler);
      frame.families.add(occurrence.sourceVersionId);
      frame.occurrences.push(occurrence);
      frames.set(occurrence.frameKey, frame);
    });
    counts.clear();
    recurringFrames += frames.size;

    // A position the corpus never exchanged is literal, not a low-support slot: it is not a variable at all.
    const varying = [...frames.entries()].filter(([, frame]) => frame.fillers.size > 1);
    varyingFrames += varying.length;
    // How much form a frame keeps outside its slot is what separates a scrap of a turn from a whole move.
    const literalFloor = otsuThreshold(varying.map(([, frame]) => frame.literalUnits));
    if (literalFloor === undefined) continue;
    literalFormFloor = literalFloor;
    // Diversity is measured over the moves, not over the scraps: a one-unit residue recurs on mass, not on form.
    const bodied = varying.filter(([, frame]) => frame.literalUnits >= literalFloor);
    bodiedFrames += bodied.length;
    const fillerFloor = otsuThreshold(bodied.map(([, frame]) => frame.fillers.size));
    const familyFloor = otsuThreshold(bodied.map(([, frame]) => frame.families.size));
    if (fillerFloor === undefined || familyFloor === undefined) continue;
    fillerDiversityFloor = fillerFloor;
    sourceFamilyFloor = familyFloor;
    const kept = bodied
      .filter(([, frame]) => frame.fillers.size >= fillerFloor && frame.families.size >= familyFloor)
      .sort(([leftKey, left], [rightKey, right]) => (
        right.families.size - left.families.size
        || right.fillers.size - left.fillers.size
        || leftKey.localeCompare(rightKey)
      ));
    if (!kept.length) continue;
    keptFrames += kept.length;

    const observations = boundedObservations(kept, input.maxObservationsPerAct);
    if (!observations.length) continue;
    const profileId = dominantProfileId(observations, units);
    if (!profileId) continue;
    const sourceVersionIds = [...new Set(observations.map(row => row.sourceVersionId))].sort();
    observationCount += observations.length;
    sets.push({
      actId,
      profileId,
      bindingId: conversationalActBindingId(input.hasher, profileId, actId),
      constructionFrames: kept.length,
      sourceVersionIds,
      observations: observations.map(row => ({
        sourceVersionId: row.sourceVersionId,
        evidenceId: row.evidenceId,
        surfaceStartCodePoint: row.lineStart,
        surfaceEndCodePoint: row.lineEnd,
        roles: [{ slotIndex: 0, occurrenceIndex: 0, startCodePoint: row.slotStartInLine, endCodePoint: row.slotEndInLine }]
      } satisfies SourceBoundConstructionObservation))
    });
  }

  return {
    schema: "scce.conversational_construction_induction.v1",
    documentsRead: input.documents.length,
    spansRead: units.length,
    spansSegmented: measured.documentsSegmented,
    adjacentPairs: measured.pairs.length,
    neutralPairs,
    recurringFrames,
    varyingFrames,
    literalFormFloor,
    bodiedFrames,
    fillerDiversityFloor,
    sourceFamilyFloor,
    keptFrames,
    observations: observationCount,
    sets: sets.sort((left, right) => left.bindingId.localeCompare(right.bindingId))
  };
}

/** Round-robins the kept frames so a bundle carries many constructions rather than one construction's whole history. */
function boundedObservations(
  kept: ReadonlyArray<readonly [string, { occurrences: FrameOccurrence[] }]>,
  requested?: number
): FrameOccurrence[] {
  const limit = Math.max(1, Math.min(256, Math.floor(requested ?? 256)));
  const queues = kept.map(([, frame]) => [...frame.occurrences].sort((left, right) => (
    left.evidenceId.localeCompare(right.evidenceId)
    || left.lineStart - right.lineStart
    || left.slotStartInLine - right.slotStartInLine
  )));
  const out: FrameOccurrence[] = [];
  const seen = new Set<string>();
  for (let round = 0; out.length < limit; round++) {
    let advanced = false;
    for (const queue of queues) {
      const row = queue[round];
      if (!row) continue;
      advanced = true;
      const key = `${row.evidenceId}${row.lineStart}${row.slotStartInLine}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(row);
      if (out.length >= limit) break;
    }
    if (!advanced) break;
  }
  return out;
}

/** The transcript profile that supplied the most of this act's observations owns the bundle; ties go to the lower id. */
function dominantProfileId(observations: readonly FrameOccurrence[], units: readonly SpanUnit[]): string {
  const mass = new Map<string, number>();
  for (const row of observations) {
    const profileId = units[row.spanIndex]?.profileId;
    if (!profileId) continue;
    mass.set(profileId, (mass.get(profileId) ?? 0) + 1);
  }
  return [...mass.entries()]
    .sort(([leftId, left], [rightId, right]) => right - left || leftId.localeCompare(rightId))[0]?.[0] ?? "";
}

/**
 * Visits every one-slot frame the corpus's own replies present, the slot being any contiguous run of the line's
 * lexical units. The line is the transcript's own layout unit, so
 * the frame's literals are an exact contiguous region of one evidence span and need no re-normalization.
 */
function walkFrames(
  units: readonly SpanUnit[],
  pairs: readonly DialogueTurnPair[],
  hasher: Hasher,
  visit: (occurrence: FrameOccurrence) => void
): void {
  for (const pair of pairs) {
    const unit = units[pair.documentIndex];
    if (!unit) continue;
    const lines = replyLines(unit.points, pair.reply.startCodePoint, pair.reply.endCodePoint);
    // What this lane realizes is a whole conversational move, so a whole move is what it may generalize from:
    // a line lifted out of a longer speech is a fragment of one, and the corpus never used it as a turn.
    if (lines.length !== 1) continue;
    const line = lines[0]!;
    const surface = unit.points.slice(line.start, line.end).join("");
    const segments = unicodeLexicalSegments(surface);
    // A line of one lexical unit leaves no literal behind whatever the slot takes.
    if (segments.length < 2) continue;
    const linePoints = [...surface];
    for (let first = 0; first < segments.length; first++) {
      for (let last = first; last < segments.length; last++) {
        const literalUnits = first + (segments.length - 1 - last);
        // Nothing outside the slot leaves the identity, not a construction.
        if (literalUnits < 1) continue;
        const slotStart = segments[first]!.codePointStart;
        const slotEnd = segments[last]!.codePointEnd;
        const prefix = linePoints.slice(0, slotStart).join("");
        const suffix = linePoints.slice(slotEnd).join("");
        visit({
          frameKey: hasher.digestHex(`${prefix}\u0000${suffix}`).slice(0, 24),
          spanIndex: pair.documentIndex,
          evidenceId: String(unit.span.id),
          sourceVersionId: unit.sourceVersionId,
          lineStart: line.start,
          lineEnd: line.end,
          slotStartInLine: slotStart,
          slotEndInLine: slotEnd,
          literalUnits,
          filler: linePoints.slice(slotStart, slotEnd).join("")
        });
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
