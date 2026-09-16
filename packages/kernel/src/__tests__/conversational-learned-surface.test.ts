// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { candidateCommitmentInventory, candidateCommitmentsLicensed } from "../candidate-commitment-inventory.js";
import { trainKneserNey } from "../kneser-ney.js";
import { DIALOGUE_CLOSED_CLASS, DIALOGUE_POPULATION, conversationalSession, type TraceRow } from "./conversational-session-fixture.js";

const TRAINED = trainKneserNey(DIALOGUE_POPULATION, { order: 3 });

// The same five zero-evidence conversational turns the hydration and displaced-factual checks are measured from.
const LEAD_TURNS = [
  "the pump feed reads high",
  "it started sometime last week",
  "we checked the valve already",
  "nothing else seemed to change",
  "that is all we have looked at so far"
];

const support = (trace: readonly TraceRow[], stage: string) =>
  [...trace].reverse().find(row => row.stage === stage)?.support ?? {};

/** A surface cut contiguously out of the request is the runtime-motion echo, not something the mouth composed. */
const isRequestSpan = (answer: string, request: string): boolean =>
  request.toLocaleLowerCase().includes(answer.toLocaleLowerCase().replace(/[.!?]+$/u, "").trim());

describe("a zero-evidence conversational turn composes a surface instead of echoing the request", () => {
  it("produces a conversation-licensed learned surface, and never an unlicensed one", async () => {
    const session = conversationalSession();
    const rows: Array<{ ask: string; answer: string; composed: boolean; trace: TraceRow[] }> = [];
    for (const ask of LEAD_TURNS) {
      const out = await session.turn(ask);
      rows.push({ ask, answer: out.result.answer, composed: !isRequestSpan(out.result.answer, ask), trace: out.trace });
    }

    // Nothing is ever admitted in this session, so every surface here speaks without documentary proof.
    const composed = rows.filter(row => row.composed);
    expect(composed.length).toBeGreaterThan(0);

    // The composed surface came from the conversational producer, not from some other lane.
    for (const row of composed) {
      const produced = support(row.trace, "mouth.conversation_memory.candidate") as { surface?: string | null };
      expect(produced.surface).toBe(row.answer);
    }

    // Every turn still speaks: the runtime-motion surface remains the fallback, never silence.
    for (const row of rows) expect(row.answer.trim()).not.toBe("");

    // And every surface, composed or echoed, commits the system to nothing it cannot license from this
    // conversation: a dialogue-shaped wording is speech, never a world claim.
    const conversationTurns = LEAD_TURNS.map((surface, turnIndex) => ({ turnId: `turn.${turnIndex}`, turnIndex, surface }));
    for (const row of rows) {
      const inventory = candidateCommitmentInventory({
        text: row.answer,
        evidenceTexts: [],
        conversationTurns,
        claimBases: [],
        closedClass: DIALOGUE_CLOSED_CLASS
      });
      expect(inventory.unlicensedUnits.map(unit => unit.surface)).toEqual([]);
      expect(candidateCommitmentsLicensed(inventory)).toBe(true);
      expect(inventory.authorityClassId).not.toBe("authority.grounded_factual");
    }
  }, 600_000);
});
