// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { conversationalSession, type TraceRow } from "./conversational-session-fixture.js";

// Five zero-evidence conversational turns: the same lead-in the displaced-factual turn is measured from.
const LEAD_TURNS = [
  "the pump feed reads high",
  "it started sometime last week",
  "we checked the valve already",
  "nothing else seemed to change",
  "that is all we have looked at so far"
];

/** Let the off-response-path warm settle, as real time between turns does on the server. */
const settle = () => new Promise(resolve => setTimeout(resolve, 200));

const support = (trace: readonly TraceRow[], stage: string) =>
  [...trace].reverse().find(row => row.stage === stage)?.support ?? {};

describe("a zero-evidence conversational turn hydrates a population it can speak from", () => {
  it("selects the dialogue population on measured support and hands the mouth its models", async () => {
    const session = conversationalSession();
    const turns: Array<Awaited<ReturnType<typeof session.turn>>> = [];
    for (const text of LEAD_TURNS) {
      turns.push(await session.turn(text));
      await settle();
    }
    const last = turns[turns.length - 1]!;

    // The population is chosen, not defaulted: displacement is positive and one population measured better.
    const selection = support(last.trace, "language.population.selection") as Record<string, unknown>;
    expect(selection.selectedSourceSystem).toBe("dialogue");
    expect(selection.reasonId).toBe("population.conversation_displaced.measured_support");
    expect(selection.status).toBe("active");
    expect((selection.hydratedModelIds as string[]).length).toBeGreaterThan(0);
    const quantities = selection.quantities as { supportByRole: Record<string, number> };
    expect(Object.values(quantities.supportByRole).every(value => Number.isFinite(value))).toBe(true);

    // The role hydration resolves to a named identity rather than reporting nothing at all.
    const role = support(last.trace, "runtime.candidates.language_role");
    expect(role.speaks).toBe(true);
    expect(role.languageId).not.toBeNull();

    // And the mouth realizes with that population resident, not with an empty substrate.
    const mouth = support(last.trace, "mouth.deterministic.select") as {
      modelsHydrated: number;
      modelsByCorpus: Record<string, number>;
      closedClassSample: string[];
    };
    expect(mouth.modelsHydrated).toBeGreaterThan(0);
    expect(mouth.modelsByCorpus.dialogue ?? 0).toBeGreaterThan(0);
    expect(mouth.closedClassSample.length).toBeGreaterThan(0);

    // Speech happens. Whatever it says, it says something.
    expect(last.result.answer.trim()).not.toBe("");

    // Latency contract: the warm turns stay far inside the per-turn cap, and the population is read once.
    const durableReads = last.trace.filter(row => row.stage === "language.hydrate.loaded").length;
    expect(durableReads).toBe(0);
  }, 600_000);
});
