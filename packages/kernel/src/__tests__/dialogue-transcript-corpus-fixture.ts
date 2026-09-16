// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { ConversationalConstructionDocument } from "../conversational-construction-induction.js";
import type { SourceBoundConstructionObservation } from "../language-construction-memory.js";
import type { EvidenceSpan, Hasher } from "../types.js";

/** Training material, not engine input. Two speakers a transcript, each speech one line, in a play's layout. */
const SPEAKERS: ReadonlyArray<readonly [string, string]> = [
  ["ANNA", "BEN"],
  ["CARL", "DORA"],
  ["EVE", "FRED"],
  ["GWEN", "HUGO"],
  ["IRIS", "JUDE"],
  ["KATE", "LIAM"]
];

/** Reply shapes, each recurring across every transcript with a different unit exchanged into it. */
const SHAPES: ReadonlyArray<(filler: string) => string> = [
  filler => `yes it is ${filler}.`,
  filler => `i do not ${filler}.`,
  filler => `what ${filler}?`,
  filler => `no, ${filler}.`,
  filler => `it may be ${filler}.`,
  filler => `let us be ${filler}.`,
  filler => `how ${filler}?`,
  filler => `nothing but ${filler}.`
];

/** Four units a transcript exchanges into each of its shapes; no two transcripts share one. */
const FILLERS: ReadonlyArray<readonly string[]> = [
  ["here", "there", "gone", "done"],
  ["over", "settled", "broken", "missing"],
  ["ready", "finished", "open", "closed"],
  ["certain", "possible", "likely", "needful"],
  ["quiet", "early", "late", "loud"],
  ["true", "false", "plain", "strange"]
];

/**
 * A preamble whose own line openers repeat, but whose words also occur inside the speeches. The segmenter splits
 * both of its measured distributions with Otsu, so it needs line openers that are not annotations to split against.
 */
const PREAMBLE = [
  "it is not what it is",
  "it is not what it was",
  "is it not what it is",
  "is it not what it was",
  "what is it not it is",
  "what is it not it was"
];

export const TRANSCRIPT_CORPUS: readonly string[] = SPEAKERS.map(([first, second], document) => {
  const lines = [...PREAMBLE];
  const pool = FILLERS[document]!;
  for (let index = 0; index < SHAPES.length * pool.length; index++) {
    const shape = SHAPES[index % SHAPES.length]!;
    const filler = pool[Math.floor(index / SHAPES.length) % pool.length]!;
    lines.push(`${index % 2 === 0 ? first : second}. ${shape(filler)}`);
  }
  return lines.join("\n");
});

/** The corpus as the promoted evidence a trainer would have stored it as: one span per transcript, exact text. */
export function transcriptEvidence(
  documents: readonly string[],
  hasher: Hasher
): { documents: ConversationalConstructionDocument[]; evidence: EvidenceSpan[] } {
  const evidence: EvidenceSpan[] = [];
  const out: ConversationalConstructionDocument[] = [];
  for (let index = 0; index < documents.length; index++) {
    const text = documents[index]!.normalize("NFC");
    const sourceVersionId = `source_version.transcript.${index}`;
    const span = {
      id: `evidence.transcript.${index}`,
      sourceId: `source.transcript.${index}`,
      sourceVersionId,
      chunkId: `chunk.transcript.${index}`,
      contentHash: hasher.digestHex(text),
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd: Buffer.byteLength(text, "utf8"),
      charStart: 0,
      charEnd: [...text].length,
      text,
      status: "promoted",
      alpha: 1,
      observedAt: 0
    } as unknown as EvidenceSpan;
    evidence.push(span);
    out.push({ sourceVersionId, profileId: `language_profile.transcript.${index}`, spans: [span] });
  }
  return { documents: out, evidence };
}

/** Training material. Each shape recurs with a two-unit run exchanged, which no single-unit slot can align. */
const RUN_SHAPES: ReadonlyArray<(left: string, right: string) => string> = [
  (left, right) => `what do you ${left} ${right}?`,
  (left, right) => `i do not ${left} ${right}.`,
  (left, right) => `that is the ${left} ${right}.`,
  (left, right) => `let us not ${left} ${right} here.`
];

/** Two-unit runs a transcript exchanges into each shape; no two transcripts share one. */
const RUN_FILLERS: ReadonlyArray<ReadonlyArray<readonly [string, string]>> = [
  [["mean", "now"], ["say", "then"], ["hold", "here"], ["want", "there"]],
  [["know", "yet"], ["think", "so"], ["call", "back"], ["keep", "still"]],
  [["read", "aloud"], ["write", "down"], ["carry", "along"], ["leave", "behind"]],
  [["come", "near"], ["stand", "apart"], ["walk", "ahead"], ["wait", "outside"]],
  [["look", "away"], ["turn", "aside"], ["sit", "beside"], ["move", "along"]],
  [["ask", "again"], ["answer", "first"], ["speak", "plainly"], ["listen", "once"]]
];

/** The same transcript layout as TRANSCRIPT_CORPUS, but every reply varies a run of two units, never one. */
export const RUN_TRANSCRIPT_CORPUS: readonly string[] = SPEAKERS.map(([first, second], document) => {
  const lines = [...PREAMBLE];
  const pool = RUN_FILLERS[document]!;
  for (let index = 0; index < RUN_SHAPES.length * pool.length; index++) {
    const shape = RUN_SHAPES[index % RUN_SHAPES.length]!;
    const [left, right] = pool[Math.floor(index / RUN_SHAPES.length) % pool.length]!;
    lines.push(`${index % 2 === 0 ? first : second}. ${shape(left, right)}`);
  }
  return lines.join("\n");
});

/**
 * Training material, not engine input. The live corpus's boilerplate shape: a non-dialogue line whose only
 * invariant residue after anti-unification is bracket punctuation, with three one-unit fields varying inside it.
 */
export function bracketBoilerplateTrainingSet(hasher: Hasher): {
  profileId: string;
  evidence: EvidenceSpan[];
  observations: SourceBoundConstructionObservation[];
} {
  const evidence: EvidenceSpan[] = [];
  const observations: SourceBoundConstructionObservation[] = [];
  const profileId = "language_profile.transcript.0";
  for (let index = 0; index < FILLERS.length; index++) {
    const pool = FILLERS[index]!;
    const [left, middle, right] = [pool[0]!, pool[1]!, pool[2]!];
    const text = `${left} (${middle}) ${right}`.normalize("NFC");
    const id = `evidence.boilerplate.${index}`;
    const sourceVersionId = `source_version.boilerplate.${index}`;
    evidence.push({
      id,
      sourceId: `source.boilerplate.${index}`,
      sourceVersionId,
      chunkId: `chunk.boilerplate.${index}`,
      contentHash: hasher.digestHex(text),
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd: Buffer.byteLength(text, "utf8"),
      charStart: 0,
      charEnd: [...text].length,
      text,
      status: "promoted",
      alpha: 1,
      observedAt: 0
    } as unknown as EvidenceSpan);
    const middleStart = left.length + 2;
    const rightStart = middleStart + middle.length + 2;
    observations.push({
      sourceVersionId,
      evidenceId: id,
      surfaceStartCodePoint: 0,
      surfaceEndCodePoint: [...text].length,
      roles: [
        { slotIndex: 0, occurrenceIndex: 0, startCodePoint: 0, endCodePoint: left.length },
        { slotIndex: 1, occurrenceIndex: 0, startCodePoint: middleStart, endCodePoint: middleStart + middle.length },
        { slotIndex: 2, occurrenceIndex: 0, startCodePoint: rightStart, endCodePoint: rightStart + right.length }
      ]
    });
  }
  return { profileId, evidence, observations };
}
