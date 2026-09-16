// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { otsuThreshold } from "./language-identity.js";
import type { RequestCommunicativeActObservation } from "./request-communicative-act.js";
import { unicodeLexicalSegments } from "./unicode-segmentation.js";

/** One speech of a transcript, with the transcript's own speaker annotation removed. */
export interface TranscriptTurn {
  index: number;
  speakerId: string;
  surface: string;
}

export interface TranscriptTurnInduction {
  /** The speaker-annotation types this transcript's own layout carries, induced, never declared. */
  markers: readonly string[];
  markerCountFloor: number;
  markerExclusivityFloor: number;
  turns: readonly TranscriptTurn[];
  /** Share of adjacent turn pairs that change speaker. A transcript alternates; a numbered note list does not. */
  speakerChangeRate: number;
}

/**
 * A transcript marks who is speaking by repeating a small set of types at the head of a line, and those types
 * occur almost nowhere else. Both halves are counts over this document's own layout: how often a type opens a
 * line, and what share of its occurrences are line-opening. Each is split by Otsu, so no marker is named here
 * and the same measurement finds them in any script.
 */
export function induceTranscriptTurns(text: string): TranscriptTurnInduction {
  const lines = text.split(/\r?\n/);
  const lineOpening = new Map<string, number>();
  const anywhere = new Map<string, number>();
  const openers: Array<string | undefined> = [];
  for (const line of lines) {
    const segments = unicodeLexicalSegments(line);
    const opener = segments[0]?.normalized;
    openers.push(opener);
    if (opener === undefined) continue;
    lineOpening.set(opener, (lineOpening.get(opener) ?? 0) + 1);
    for (const segment of segments) anywhere.set(segment.normalized, (anywhere.get(segment.normalized) ?? 0) + 1);
  }
  const recurring = [...lineOpening.entries()].filter(([, count]) => count > 1);
  const countFloor = otsuThreshold(recurring.map(([, count]) => count));
  const exclusivityFloor = otsuThreshold(recurring.map(([type, count]) => count / (anywhere.get(type) ?? count)));
  if (countFloor === undefined || exclusivityFloor === undefined) {
    return { markers: [], markerCountFloor: 0, markerExclusivityFloor: 0, turns: [], speakerChangeRate: 0 };
  }
  const markers = new Set(
    recurring
      .filter(([type, count]) => count >= countFloor && count / (anywhere.get(type) ?? count) >= exclusivityFloor)
      .map(([type]) => type)
  );
  const turns = segmentTurns(lines, openers, markers);
  let changes = 0;
  for (let index = 1; index < turns.length; index++) {
    if (turns[index]!.speakerId !== turns[index - 1]!.speakerId) changes += 1;
  }
  return {
    markers: [...markers].sort(),
    markerCountFloor: countFloor,
    markerExclusivityFloor: exclusivityFloor,
    turns,
    speakerChangeRate: turns.length > 1 ? changes / (turns.length - 1) : 0
  };
}

/** The recorded continuation structure of one turn, measured against the corpus it was recorded in. */
export interface TurnContinuationSignature {
  /** The turn's own speaker takes the floor back on the turn after the reply. */
  floorReturned: boolean;
  /** The reply is built from units the turn itself supplied, below the corpus split of that share. */
  replyDrawsOnTurn: boolean;
}

export interface DialogueActObservationReport {
  schema: "scce.dialogue_act_observation_report.v1";
  documentsRead: number;
  documentsSegmented: number;
  documentsRejectedForNoAlternation: number;
  turns: number;
  adjacentPairs: number;
  observations: readonly RequestCommunicativeActObservation[];
  speakerChangeFloor: number;
  externalUnitFloor: number;
  continuationSurprisalFloor: number;
  /** How many observations landed in each measured signature cell, before any act id is derived. */
  signatureCells: Record<string, number>;
}

interface PairMeasurement {
  requestText: string;
  externalUnits: number;
  externalRate: number;
  rareUnits: number;
  surprisal: number;
  floorReturned: boolean;
}

/**
 * Turns a set of transcripts into request-act observations. Every axis is a count over the transcripts:
 * how much of the reply the conversation had not already supplied, how unexpected the reply's units are under
 * the corpus baseline, and whether the floor comes back to the speaker. Each continuous axis is split by the
 * Otsu of its own observed distribution, so nothing here is a declared number or a list of words.
 */
export function dialogueRequestActObservations(documents: readonly string[]): DialogueActObservationReport {
  const segmented: TranscriptTurnInduction[] = [];
  for (const document of documents) {
    const induction = induceTranscriptTurns(document);
    if (induction.turns.length > 1) segmented.push(induction);
  }
  const changeFloor = otsuThreshold(segmented.map(induction => induction.speakerChangeRate)) ?? 0;
  const alternating = segmented.filter(induction => induction.speakerChangeRate >= changeFloor);

  const corpusUnitCounts = new Map<string, number>();
  let corpusUnitTotal = 0;
  for (const induction of alternating) {
    for (const turn of induction.turns) {
      for (const unit of unitTypes(turn.surface)) {
        corpusUnitCounts.set(unit, (corpusUnitCounts.get(unit) ?? 0) + 1);
        corpusUnitTotal += 1;
      }
    }
  }

  // Where the corpus's own unit-rarity distribution splits: above it a unit is not part of the corpus routine.
  const unitSurprisalFloor = otsuThreshold(
    [...corpusUnitCounts.values()].map(count => -Math.log(count / Math.max(1, corpusUnitTotal)))
  ) ?? 0;

  const measurements: PairMeasurement[] = [];
  let turnCount = 0;
  for (const induction of alternating) {
    turnCount += induction.turns.length;
    for (let index = 0; index + 1 < induction.turns.length; index++) {
      const turn = induction.turns[index]!;
      const reply = induction.turns[index + 1]!;
      // A reply by the same speaker is a continuation of one turn, not the answer another turn drew out.
      if (reply.speakerId === turn.speakerId) continue;
      const replyUnits = unitTypes(reply.surface);
      const supplied = unitTypes(turn.surface);
      if (!replyUnits.size || !supplied.size) continue;
      let external = 0;
      let rare = 0;
      let surprisal = 0;
      for (const unit of replyUnits) {
        if (!supplied.has(unit)) external += 1;
        const probability = (corpusUnitCounts.get(unit) ?? 0) / Math.max(1, corpusUnitTotal);
        const unitSurprisal = probability > 0 ? -Math.log(probability) : -Math.log(1 / Math.max(1, corpusUnitTotal));
        if (unitSurprisal >= unitSurprisalFloor) rare += 1;
        surprisal += unitSurprisal;
      }
      measurements.push({
        requestText: turn.surface,
        externalUnits: external,
        externalRate: external / replyUnits.size,
        rareUnits: rare,
        surprisal: surprisal / replyUnits.size,
        floorReturned: induction.turns[index + 2]?.speakerId === turn.speakerId
      });
    }
  }

  const externalFloor = otsuThreshold(measurements.map(row => row.externalRate)) ?? 0;
  const surprisalFloor = otsuThreshold(measurements.map(row => row.surprisal)) ?? 0;
  const signatureCells: Record<string, number> = {};
  const observations = measurements.map(row => {
    const continuation: TurnContinuationSignature = {
      floorReturned: row.floorReturned,
      replyDrawsOnTurn: row.externalRate < externalFloor
    };
    // A reply the corpus routine does not supply committed to material from outside it: the count of the reply's
    // units above the corpus rarity split, credited only when the reply's mean surprisal clears its own split.
    const responseEvidenceCount = row.surprisal >= surprisalFloor ? row.rareUnits : 0;
    const cell = `${responseEvidenceCount > 0 ? "e1" : "e0"}.${continuation.floorReturned ? "f1" : "f0"}.${continuation.replyDrawsOnTurn ? "d1" : "d0"}`;
    signatureCells[cell] = (signatureCells[cell] ?? 0) + 1;
    return { requestText: row.requestText, responseEvidenceCount, accepted: true, continuation };
  });

  return {
    schema: "scce.dialogue_act_observation_report.v1",
    documentsRead: documents.length,
    documentsSegmented: alternating.length,
    documentsRejectedForNoAlternation: segmented.length - alternating.length,
    turns: turnCount,
    adjacentPairs: measurements.length,
    observations,
    speakerChangeFloor: changeFloor,
    externalUnitFloor: externalFloor,
    continuationSurprisalFloor: surprisalFloor,
    signatureCells
  };
}

function segmentTurns(
  lines: readonly string[],
  openers: ReadonlyArray<string | undefined>,
  markers: ReadonlySet<string>
): TranscriptTurn[] {
  const turns: TranscriptTurn[] = [];
  let speakerId: string | undefined;
  let held: string[] = [];
  const flush = () => {
    if (speakerId === undefined) return;
    const surface = held.join("\n").trim();
    if (surface) turns.push({ index: turns.length, speakerId, surface });
  };
  for (let index = 0; index < lines.length; index++) {
    const opener = openers[index];
    if (opener !== undefined && markers.has(opener)) {
      flush();
      speakerId = opener;
      held = [speechAfterMarker(lines[index]!)];
      continue;
    }
    if (speakerId !== undefined) held.push(lines[index]!);
  }
  flush();
  return turns;
}

/** The speaker annotation is the transcript's own markup, not speech: the line resumes at its next lexical unit. */
function speechAfterMarker(line: string): string {
  const segments = unicodeLexicalSegments(line);
  const resume = segments[1];
  if (!resume) return "";
  return [...line].slice(resume.codePointStart).join("");
}

function unitTypes(text: string): Set<string> {
  return new Set(unicodeLexicalSegments(text).map(segment => segment.normalized));
}
