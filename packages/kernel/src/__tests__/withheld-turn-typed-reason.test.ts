// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { RUNTIME_WITHHELD_REASON_IDS, RUNTIME_WITHHELD_SURFACE_SCHEMA, withheldSurfaceForTurn, type TurnResult } from "../index.js";
import { clearCorpusIdentitySignals } from "../corpus-identity.js";
import { chatSession } from "./chat-session-fixture.js";

afterEach(() => clearCorpusIdentitySignals());

const TYPED_REASON_IDS = new Set<string>(Object.values(RUNTIME_WITHHELD_REASON_IDS));

function hasSpeech(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(String(text || ""));
}

// Live 2026-09-13 and offline at 75c2cdd: "fuck off" and "thanks" came back as the empty string with nothing on the
// result saying why. Silence with no record is indistinguishable from a crashed turn, for the user and the operator.
describe("a dialogue turn that admits no evidence", () => {
  it("never ends as an empty answer with no explanation", async () => {
    const session = chatSession();
    const first = await session.turn("who is albert einstein");
    expect(first.result.answer).toContain("theoretical physicist");
    expect(first.result.withheld, "an answered turn withholds nothing").toBeUndefined();

    for (const sparse of ["fuck off", "thanks", "no thats wrong"]) {
      const next = await session.turn(sparse);
      const withheld = next.result.withheld;
      expect(hasSpeech(next.result.answer) || Boolean(withheld), `${sparse}: empty answer and no withholding record`).toBe(true);
      if (hasSpeech(next.result.answer)) {
        expect(withheld, `${sparse}: a spoken turn must not also report withholding`).toBeUndefined();
        continue;
      }
      expect(withheld?.schema, sparse).toBe(RUNTIME_WITHHELD_SURFACE_SCHEMA);
      expect(TYPED_REASON_IDS.has(String(withheld?.reasonId)), `${sparse}: ${withheld?.reasonId}`).toBe(true);
      expect(withheld?.reasonId, sparse).toBe(RUNTIME_WITHHELD_REASON_IDS.noAdmittedEvidence);
      expect(withheld?.evidenceCount, sparse).toBe(0);
      expect(withheld?.entailmentVerdict, sparse).toBeTruthy();
      expect(withheld?.truthStateId, sparse).toBeTruthy();
      // The record names the component that would have had to speak and the state it was actually in.
      const act = withheld?.components.find(component => component.id === "request_communicative_act");
      expect(act, `${sparse}: no request_communicative_act status`).toBeDefined();
      expect(act?.status, sparse).toBe("inert_unconfigured");
      // A typed reason is data, never a reply: nothing in it is a sentence addressed to the user.
      expect(String(withheld?.reasonId).includes(" "), sparse).toBe(false);
    }
  }, 180_000);
});

describe("withheldSurfaceForTurn", () => {
  it("reports nothing for a turn that spoke, and the refusal reason for one that held admitted evidence", () => {
    const base = {
      answer: "",
      evidence: [],
      entailment: { verdict: "underdetermined" },
      epistemicForce: "unknown",
      learningNeeds: []
    } as unknown as TurnResult;
    expect(withheldSurfaceForTurn({ ...base, answer: "Ulm" } as TurnResult)).toBeUndefined();
    expect(withheldSurfaceForTurn(base)?.reasonId).toBe(RUNTIME_WITHHELD_REASON_IDS.noAdmittedEvidence);
    const withEvidence = { ...base, evidence: [{ id: "evidence:one" }] } as unknown as TurnResult;
    expect(withheldSurfaceForTurn(withEvidence)?.reasonId).toBe(RUNTIME_WITHHELD_REASON_IDS.surfaceRefused);
    expect(withheldSurfaceForTurn(withEvidence)?.evidenceCount).toBe(1);
  });
});
