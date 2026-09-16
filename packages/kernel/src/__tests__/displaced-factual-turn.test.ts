// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { candidateCommitmentInventory, candidateCommitmentsLicensed } from "../candidate-commitment-inventory.js";
import { trainKneserNey } from "../kneser-ney.js";
import { DIALOGUE_POPULATION, conversationalSession } from "./conversational-session-fixture.js";

const TRAINED = trainKneserNey(DIALOGUE_POPULATION, { order: 3 });

// Five answered turns, which is where derivedContextContribution saturates dialogueDependence at 0.70.
const LEAD_TURNS = [
  "the pump feed reads high",
  "it started sometime last week",
  "we checked the valve already",
  "nothing else seemed to change",
  "that is all we have looked at so far"
];

const UNANSWERABLE = "What is the boiling point of tungsten?";

describe("an evidence-less factual question deep in a conversation asserts nothing", () => {
  it("emits no unsupported value at conversation depth six, whichever population realizes the wording", async () => {
    const session = conversationalSession();
    for (const text of LEAD_TURNS) await session.turn(text);
    const deep = await session.turn(UNANSWERABLE);

    // The turn is evidence-less by construction; nothing in this session was ever admitted.
    expect(deep.result.evidence).toHaveLength(0);

    // Population routing considered the dialogue corpus for this turn -- it is hydration-eligible, as it should be.
    const selection = deep.trace.find(row => row.stage === "language.population.selection");
    expect(String(JSON.stringify(selection?.support ?? {}))).toContain("dialogue");

    // The invariant: whichever population chose the wording granted no factual authority.
    // Measured at this depth: selectedSourceSystem=wikipedia, terminalRuntimeMotion=true, answer "point tungsten".
    // Silence is still an allowed outcome here (the safety floor), so this does not require a non-empty surface.
    const answer = deep.result.answer;
    expect(/\d/u.test(answer)).toBe(false);
    for (const fromPopulation of ["denmark", "copenhagen", "krone", "capital", "currency"]) {
      expect(answer.toLocaleLowerCase()).not.toContain(fromPopulation);
    }

    // And said at the commitment level, not as a word blacklist: every externally meaningful unit of whatever
    // was emitted is licensed by a turn of this conversation. A dialogue-shaped wording cannot smuggle a fact in.
    const conversationTurns = [...LEAD_TURNS, UNANSWERABLE].map((surface, turnIndex) => ({
      turnId: `turn.${turnIndex}`,
      turnIndex,
      surface
    }));
    const inventory = candidateCommitmentInventory({
      text: answer,
      evidenceTexts: [],
      conversationTurns,
      claimBases: [],
      models: [TRAINED]
    });
    expect(inventory.unlicensedUnits.map(unit => unit.surface)).toEqual([]);
    expect(candidateCommitmentsLicensed(inventory)).toBe(true);
  }, 600_000);
});
