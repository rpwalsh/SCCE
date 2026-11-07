// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createHasher } from "../primitives.js";
import { dialogueTurnPairs, type TranscriptTurn } from "../dialogue-communicative-act-learning.js";
import { induceConversationalActConstructionTrainingSets, type ConversationalConstructionDocument } from "../conversational-construction-induction.js";
import { compileLanguageConstructionPattern } from "../language-construction-memory.js";
import * as frameWalk from "../conversational-frame-walk.js";
import * as segmentation from "../unicode-segmentation.js";
import { RUN_TRANSCRIPT_CORPUS, transcriptEvidence } from "./dialogue-transcript-corpus-fixture.js";

const hasher = createHasher();

/** Previous exhaustive source loop, retained only as an exact behavior/work reference. */
const exhaustive: typeof frameWalk.walkConversationalFrames = (pairs, hash, visit) => {
  for (const { pair, unit, line, linePoints, segments } of pairs) for (let first = 0; first < segments.length; first++) {
    for (let last = first; last < segments.length; last++) {
      const literalUnits = first + segments.length - 1 - last;
      if (literalUnits < 1) continue;
      const slotStart = segments[first]!.codePointStart;
      const slotEnd = segments[last]!.codePointEnd;
      const filler = linePoints.slice(slotStart, slotEnd).join("");
      const requestUnits = segmentation.unicodeLexicalSegments(pair.requestText).map(segment => segment.normalized);
      const fillerUnits = segmentation.unicodeLexicalSegments(filler).map(segment => segment.normalized);
      if (unit.transcriptTurns && !requestUnits.some((_word, start) => fillerUnits.every((word, index) => requestUnits[start + index] === word))) continue;
      const prefix = linePoints.slice(0, slotStart).join("");
      const suffix = linePoints.slice(slotEnd).join("");
      visit({ frameKey: hash.digestHex(`${prefix}\u0000${suffix}`).slice(0, 24), spanIndex: pair.documentIndex, evidenceId: String(unit.span.id),
        sourceVersionId: unit.sourceVersionId, lineStart: line.start, lineEnd: line.end, slotStartInLine: slotStart, slotEndInLine: slotEnd,
        literalUnits, filler, ...(unit.transcriptTurns ? { antecedent: { startCodePoint: pair.request.startCodePoint, endCodePoint: pair.request.endCodePoint } } : {}) });
    }
  }
};

function declaredDocuments() {
  const fillers = ["café-x 417.2", "東京 β", "שלום 42", "नमस्ते", "o’neal_x", "cafe\u0301 y"];
  const requests = fillers.map(filler => `repeat ${filler} then ${filler}.`.normalize("NFC"));
  const novel = Array.from({ length: 36 }, (_, index) => `novel${index}`).join(" ");
  const replies = fillers.map(filler => `acknowledged ${filler}; ${novel} continue when ready.`.normalize("NFC"));
  const fixture = transcriptEvidence(requests.map((request, index) => `${request}\n${replies[index]}`), hasher);
  fixture.documents.forEach((document, index) => {
    const request = requests[index]!;
    const reply = replies[index]!;
    const start = [...request].length + 1;
    document.transcriptTurns = [{ index: 0, speakerId: "requestor", startCodePoint: 0, endCodePoint: start - 1, surface: request },
      { index: 1, speakerId: "responder", startCodePoint: start, endCodePoint: start + [...reply].length, surface: reply,
        replyToTurnIndex: 0, commitmentScope: "conversation" }] satisfies TranscriptTurn[];
  });
  return fixture;
}

function measured(documents: readonly ConversationalConstructionDocument[]) {
  const units = documents.map(document => ({ span: document.spans[0]!, points: [...document.spans[0]!.text], sourceVersionId: document.sourceVersionId,
    profileId: document.profileId, transcriptTurns: document.transcriptTurns }));
  const pairs = dialogueTurnPairs(units.map(unit => ({ schema: "scce.dialogue_transcript.v1" as const, text: unit.span.text, turns: unit.transcriptTurns! }))).pairs;
  return { units, pairs };
}

describe("declared conversational frame request index", () => {
  it("segments request/reply once, shares both walks, and matches the exhaustive observations", () => {
    const fixture = declaredDocuments();
    const input = measured(fixture.documents);
    const segment = vi.spyOn(segmentation, "unicodeLexicalSegments");
    try {
      const pairs = frameWalk.prepareConversationalFramePairs(input.units, input.pairs);
      const beforeWalk = segment.mock.calls.length;
      expect(beforeWalk).toBe(pairs.length * 2);
      const actual: frameWalk.ConversationalFrameOccurrence[] = [];
      frameWalk.walkConversationalFrames(pairs, hasher, row => actual.push(row));
      frameWalk.walkConversationalFrames(pairs, hasher, () => undefined);
      expect(segment.mock.calls).toHaveLength(beforeWalk);
      for (const pair of pairs) expect(segment.mock.calls.filter(([text]) => text === pair.pair.requestText)).toHaveLength(1);
      const expected: frameWalk.ConversationalFrameOccurrence[] = [];
      const beforeExhaustive = segment.mock.calls.length;
      exhaustive(pairs, hasher, row => expected.push(row));
      expect(actual.length).toBeGreaterThan(0);
      expect(actual).toEqual(expected);
      expect(segment.mock.calls.length - beforeExhaustive).toBe(pairs.reduce((count, pair) => count + pair.segments.length * (pair.segments.length + 1) - 2, 0));
    } finally { segment.mockRestore(); }
  });

  it("preserves complete induction reports and compiled bundles for declared and unannotated sources", () => {
    for (const fixture of [declaredDocuments(), transcriptEvidence(RUN_TRANSCRIPT_CORPUS, hasher)]) {
      const input = { documents: fixture.documents, hasher };
      const actual = induceConversationalActConstructionTrainingSets(input);
      const compile = (report: typeof actual) => report.sets.map(set => compileLanguageConstructionPattern({ bindingId: set.bindingId,
        profileId: set.profileId, observations: set.observations, evidence: fixture.evidence, hasher, updatedAt: 1 }));
      const bundles = compile(actual);
      expect(actual.observations).toBeGreaterThan(0);
      expect(bundles.some(row => row.status === "compiled")).toBe(true);
      const old = vi.spyOn(frameWalk, "walkConversationalFrames").mockImplementation(exhaustive);
      try {
        const expected = induceConversationalActConstructionTrainingSets(input);
        expect(actual).toEqual(expected);
        expect(bundles).toEqual(compile(expected));
      } finally { old.mockRestore(); }
    }
  });

  it("retains exact normalized lexical units when slicing at complete segment boundaries", () => {
    for (const text of ["_name O’Neal café-x 417.2 end", "東京、שלום 42 नमस्ते", "a\u0301 \u0600عربي β 😀क्ष", "left a-b.c 00.4 right"]) {
      const points = [...text];
      const segments = segmentation.unicodeLexicalSegments(text);
      for (let first = 0; first < segments.length; first++) for (let last = first; last < segments.length; last++) {
        const filler = points.slice(segments[first]!.codePointStart, segments[last]!.codePointEnd).join("");
        expect(segmentation.unicodeLexicalSegments(filler).map(segment => segment.normalized)).toEqual(segments.slice(first, last + 1).map(segment => segment.normalized));
      }
    }
  });
});
