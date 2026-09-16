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
});
