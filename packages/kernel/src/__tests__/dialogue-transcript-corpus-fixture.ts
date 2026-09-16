// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { ConversationalConstructionDocument } from "../conversational-construction-induction.js";
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
