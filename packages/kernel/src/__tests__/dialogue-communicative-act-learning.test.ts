// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { dialogueRequestActObservations, induceTranscriptTurns } from "../dialogue-communicative-act-learning.js";
import {
  classifyRequestCommunicativeAct,
  compileRequestCommunicativeActModel,
  requestCommunicativeActModelFromPatterns,
  requestCommunicativeActPatterns
} from "../request-communicative-act.js";
import { DIALOGUE_ACT_IDS } from "../dialogue-pragmatics.js";

// Two speakers alternate; the annotation types recur at the head of a line and occur nowhere else.
const TRANSCRIPT = [
  "ay. the feed reads high",
  "we watched it climb all morning",
  "bee. it has read high since the change",
  "that was the week of the shutdown",
  "ay. we checked the valve",
  "we know that it looked clean enough",
  "bee. the valve was the only change",
  "we left the rest of the run alone",
  "ay. nothing else moved",
  "that is all we have looked at",
  "bee. nothing else moved at all",
  "we can see that it matches the log",
  "ay. what is the melting point of the alloy",
  "we could not find the table",
  "bee. four hundred and twenty degrees by the table",
  "that entry is very old",
  "ay. and the boiling point of the alloy",
  "it must be in the same table",
  "bee. two thousand nine hundred degrees by the table",
  "that entry is older still"
].join("\n");

describe("dialogue communicative act learning", () => {
  it("induces the transcript's own speaker annotation and strips it from the speech", () => {
    const induction = induceTranscriptTurns(TRANSCRIPT);
    expect(induction.markers).toEqual(["ay", "bee"]);
    expect(induction.turns).toHaveLength(10);
    expect(induction.turns[0]!.surface).toBe("the feed reads high\nwe watched it climb all morning");
    expect(induction.turns[1]!.speakerId).toBe("bee");
    expect(induction.speakerChangeRate).toBe(1);
  });

  it("refuses a document whose induced markers never alternate", () => {
    const notes = Array.from({ length: 12 }, (_, index) => `note. item ${index} of the list`).join("\n");
    const report = dialogueRequestActObservations([notes]);
    expect(report.documentsRejectedForNoAlternation + (report.documentsSegmented === 0 ? 1 : 0)).toBeGreaterThan(0);
    expect(report.observations.length).toBe(0);
  });

  it("compiles observations whose act ids survive the pattern round trip", () => {
    const report = dialogueRequestActObservations([TRANSCRIPT]);
    expect(report.adjacentPairs).toBeGreaterThan(0);
    const model = compileRequestCommunicativeActModel(report.observations);
    const classIds = Object.keys(model.classCounts);
    expect(classIds.length).toBeGreaterThanOrEqual(2);
    expect(model.classCounts[DIALOGUE_ACT_IDS.neutral]).toBeGreaterThan(0);
    const patterns = requestCommunicativeActPatterns(model, {
      profileId: "profile.dialogue.act",
      updatedAt: 7,
      makeId: value => `pattern.${JSON.stringify(value).length}.${String(JSON.stringify(value)).split("").reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7)}`
    });
    expect(patterns.length).toBeGreaterThan(0);
    const hydrated = requestCommunicativeActModelFromPatterns(patterns);
    expect(hydrated).toBeDefined();
    expect(Object.keys(hydrated!.classCounts).sort()).toEqual(classIds.sort());
    const classification = classifyRequestCommunicativeAct("the feed reads high", hydrated);
    expect(classification.status).toBe("active");
  });

  it("reports inert without a compiled model, which is what blocks the conversational binding", () => {
    expect(classifyRequestCommunicativeAct("the feed reads high", undefined).status).toBe("inert_unconfigured");
  });

  // The turn-reuse axis must measure reuse, not turn length: a long turn covers more of the corpus's unit mass.
  it("does not call a long generic turn reused, and does call a short quoted one reused", () => {
    const common = Array.from({ length: 120 }, (_, i) => `com${i}`);
    const lines: string[] = [];
    const longGeneric = new Set<string>();
    const shortQuoted = new Set<string>();
    for (let round = 0; round < 24; round++) {
      // A long turn made only of the corpus's own commonest units, answered out of the same common pool.
      const longHead = Array.from({ length: 20 }, (_, i) => common[(round * 7 + i) % common.length]!).join(" ");
      const longTail = Array.from({ length: 20 }, (_, i) => common[(round * 7 + 20 + i) % common.length]!).join(" ");
      lines.push(`ay. ${longHead}`, longTail);
      lines.push(`bee. ${common[(round * 11) % common.length]} ${common[(round * 13 + 3) % common.length]}`, common[(round * 17 + 5) % common.length]!);
      longGeneric.add(`${longHead}\n${longTail}`);
      // A short turn carrying units the corpus barely uses, answered by quoting them back.
      const rare = Array.from({ length: 2 + (round % 3) }, (_, i) => `zeta${round}x${i}`).join(" ");
      lines.push(`ay. ${rare}`, `kappa${round}`);
      lines.push(`bee. ${rare}`, `kappa${round} lambda${round}`);
      shortQuoted.add(`${rare}\nkappa${round}`);
    }
    const report = dialogueRequestActObservations([lines.join("\n")]);
    const reused = new Set(report.observations.filter(row => row.continuation!.replyDrawsOnTurn).map(row => row.requestText));
    expect([...shortQuoted].filter(text => reused.has(text)).length).toBe(shortQuoted.size);
    expect([...longGeneric].filter(text => reused.has(text)).length).toBe(0);
  });
});
