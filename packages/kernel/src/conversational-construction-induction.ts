// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { conversationalActBindingId } from "./conversational-act-binding.js";
import { dialogueTurnPairs, type DialogueTurnPair, type TranscriptTurn } from "./dialogue-communicative-act-learning.js";
import { DIALOGUE_ACT_IDS, type DialogueActId } from "./dialogue-pragmatics.js";
import { otsuThreshold } from "./language-identity.js";
import type { SourceBoundConstructionObservation, SourceBoundLanguageConstructionTrainingSet } from "./language-construction-memory.js";
import { requestCommunicativeActIdForSignature } from "./request-communicative-act.js";
import { prepareConversationalFramePairs, walkConversationalFrames, type ConversationalSpanUnit as SpanUnit, type ConversationalFrameOccurrence as FrameOccurrence } from "./conversational-frame-walk.js";
import type { EvidenceSpan, Hasher } from "./types.js";

/** One transcript, as the promoted evidence spans it was stored as. Each span is read on its own terms. */
export interface ConversationalConstructionDocument {
  sourceVersionId: string;
  profileId: string;
  /**
   * Exact persisted language-identity assignment for this profile.  Cross-document
   * acquisition may group profiles only when this verified owner is present and
   * equal; script similarity or a caller-provided language name is not authority.
   */
  languageIdentityId?: string;
  /**
   * Digest of the persisted identity record together with this exact
   * profile-to-identity assignment.  It lets a derived construction retain the
   * evidence for grouping without copying the identity payload into every row.
   */
  languageIdentityDigest?: string;
  spans: readonly EvidenceSpan[];
  /** Optional exact turn coordinates in the source document. */
  transcriptTurns?: readonly TranscriptTurn[];
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

/**
 * Induces conversational constructions from a dialogue corpus's own replies, keyed by the act the turn before
 * them was measured to be. The frame is anti-unification over what actually recurred: contiguous exchanged runs
 * and complete declared replies with independently owned request roles use the same source-bound compiler.
 * Repeated uses of one request span retain one role with separate occurrences; invariant copied symbols remain
 * literal form. Exact reply coordinates include all line breaks and punctuation. All three gates -- how much form the frame keeps outside its
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
      const completeTurns = document.transcriptTurns?.filter(turn => turn.startCodePoint >= span.charStart && turn.endCodePoint <= span.charEnd
        && (turn.supportingSourceRanges ?? []).every(range => range.startCodePoint >= span.charStart && range.endCodePoint <= span.charEnd));
      const retainedTurns = completeTurns?.filter(turn => turn.replyToTurnIndex === undefined || completeTurns.some(request => request.index === turn.replyToTurnIndex));
      const retainedIndexes = new Map(retainedTurns?.map((turn, index) => [turn.index, index] as const));
      const transcriptTurns = retainedTurns?.map((turn, index) => ({ ...turn, index,
        startCodePoint: turn.startCodePoint - span.charStart, endCodePoint: turn.endCodePoint - span.charStart,
        ...(turn.replyToTurnIndex !== undefined ? { replyToTurnIndex: retainedIndexes!.get(turn.replyToTurnIndex)! } : {}),
        ...(turn.supportingSourceRanges ? { supportingSourceRanges: turn.supportingSourceRanges.map(range => ({ ...range,
          startCodePoint: range.startCodePoint - span.charStart, endCodePoint: range.endCodePoint - span.charStart,
          ...(range.answerRange ? { answerRange: { startCodePoint: range.answerRange.startCodePoint - span.charStart,
            endCodePoint: range.answerRange.endCodePoint - span.charStart } } : {}) })) } : {})
      }));
      units.push({ span, points, sourceVersionId: document.sourceVersionId, profileId: document.profileId,
        ...(transcriptTurns ? { transcriptTurns } : {}) });
    }
  }

  const measured = dialogueTurnPairs(units.map(unit => unit.transcriptTurns
    ? { schema: "scce.dialogue_transcript.v1" as const, text: unit.span.text, turns: unit.transcriptTurns }
    : unit.span.text));
  const byAct = new Map<DialogueActId, DialogueTurnPair[]>();
  let neutralPairs = 0;
  for (const pair of measured.pairs) {
    const actId = requestCommunicativeActIdForSignature({
      accepted: true,
      evidenceBearing: pair.externallyFactual === true || pair.responseEvidenceCount > 0,
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
    const framePairs = prepareConversationalFramePairs(units, pairs);
    const counts = new Map<string, number>();
    walkConversationalFrames(framePairs, input.hasher, occurrence => {
      counts.set(occurrence.frameKey, (counts.get(occurrence.frameKey) ?? 0) + 1);
    });
    const frames = new Map<string, { fillers: Set<string>; families: Set<string>; literalUnits: number; occurrences: FrameOccurrence[] }>();
    walkConversationalFrames(framePairs, input.hasher, occurrence => {
      if ((counts.get(occurrence.frameKey) ?? 0) < 2) return;
      const frame = frames.get(occurrence.frameKey)
        ?? { fillers: new Set<string>(), families: new Set<string>(), literalUnits: occurrence.literalUnits, occurrences: [] };
      frame.fillers.add(occurrence.filler);
      frame.families.add(occurrence.sourceVersionId);
      frame.occurrences.push(occurrence);
      frames.set(occurrence.frameKey, frame);
    });
    counts.clear();
    // A copied symbol that never changes across this frame is form, not an independent request variable.
    // This matters for scripts whose reversible lexical units are graphemes rather than word runs.
    for (const frame of frames.values()) {
      if (!frame.occurrences.some(row => row.roles)) continue;
      const values = new Map<number, Set<string>>();
      for (const row of frame.occurrences) for (const role of row.roles ?? []) {
        const observed = values.get(role.slotIndex) ?? new Set<string>();
        observed.add(units[row.spanIndex]!.points.slice(row.lineStart + role.startCodePoint, row.lineStart + role.endCodePoint).join(""));
        values.set(role.slotIndex, observed);
      }
      const variable = [...values].filter(([, observed]) => observed.size > 1).map(([index]) => index).sort((a, b) => a - b);
      frame.occurrences = frame.occurrences.map(row => ({ ...row, roles: row.roles?.filter(role => variable.includes(role.slotIndex))
        .map(role => ({ ...role, slotIndex: variable.indexOf(role.slotIndex) })) }));
    }
    recurringFrames += frames.size;

    // A position the corpus never exchanged is literal, not a low-support slot: it is not a variable at all.
    const varying = [...frames.entries()].filter(([, frame]) => frame.fillers.size > 1 && frame.occurrences.every(row => !row.roles || row.roles.length > 0));
    varyingFrames += varying.length;
    // How much form a frame keeps outside its slot is what separates a scrap of a turn from a whole move.
    const sourceAligned = pairs.every(pair => units[pair.documentIndex]?.transcriptTurns !== undefined);
    // Exact request-to-reply role transfer already excludes identity slots and fragments in declared transcripts.
    const literalFloor = sourceAligned && varying.length
      ? Math.min(...varying.map(([, frame]) => frame.literalUnits))
      : otsuThreshold(varying.map(([, frame]) => frame.literalUnits));
    if (literalFloor === undefined) continue;
    literalFormFloor = literalFloor;
    // Diversity is measured over the moves, not over the scraps: a one-unit residue recurs on mass, not on form.
    const bodied = varying.filter(([, frame]) => frame.literalUnits >= literalFloor);
    bodiedFrames += bodied.length;
    const fillerFloor = sourceAligned && bodied.length ? Math.min(...bodied.map(([, frame]) => frame.fillers.size))
      : otsuThreshold(bodied.map(([, frame]) => frame.fillers.size));
    const familyFloor = sourceAligned && bodied.length ? Math.min(...bodied.map(([, frame]) => frame.families.size))
      : otsuThreshold(bodied.map(([, frame]) => frame.families.size));
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
        ...(row.antecedent ? { antecedent: row.antecedent } : {}),
        roles: row.roles ? [...row.roles] : [{ slotIndex: 0, occurrenceIndex: 0, startCodePoint: row.slotStartInLine, endCodePoint: row.slotEndInLine }]
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
      const key = `${row.evidenceId}${row.lineStart}${row.slotStartInLine}${JSON.stringify(row.roles ?? [])}`;
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
