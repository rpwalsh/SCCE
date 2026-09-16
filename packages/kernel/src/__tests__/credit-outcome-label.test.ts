// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  buildCognitiveCreditRecord,
  cognitiveCreditStageObservations,
  runtimeRewardTerms,
  CREDIT_OUTCOME_SOURCE_IDS,
  type CognitiveCreditTurnView,
  type CreditRuntimeSignals
} from "../cognitive-credit.js";
import { creditRewardClasses } from "../calibration-spine.js";

/**
 * Nine live episodes from scce3_runtime.calibration_observations on 2026-09-16, with the request and answer
 * conversation_turns recorded for them. Every one of these labelled `outcome = false`, including the Albania
 * turn that answered correctly and cited its source.
 */
const LIVE_EPISODES: ReadonlyArray<{
  episodeId: string;
  request: string;
  succeeded: boolean;
  obligationCount: number;
  unresolvedObligationCount: number;
  contradictionMass: number;
}> = [
  // Correct and cited: "Tirana is the capital and largest city in the country ... Source: Albania".
  { episodeId: "episode_00mu4liw97_ce5b7f2b129c_a1887e733b", request: "What is the capital of Albania?", succeeded: true, obligationCount: 56, unresolvedObligationCount: 11, contradictionMass: 0.15872814201094998 },
  { episodeId: "episode_00mu4me5no_b8b6a7fc065c_54de6260c3", request: "What is the capital of Albania?", succeeded: true, obligationCount: 56, unresolvedObligationCount: 11, contradictionMass: 0.15872814201094998 },
  { episodeId: "episode_00mu4mfudf_b8b6a7fc065c_2c91dfba0e", request: "What is the capital of Albania?", succeeded: true, obligationCount: 56, unresolvedObligationCount: 11, contradictionMass: 0.15872814201094998 },
  // Correct and cited: the Ada Lovelace lead, the one turn the old criterion ever admitted.
  { episodeId: "episode_00mu4mfvwh_b8b6a7fc065c_fbf368749b", request: "Who was Ada Lovelace?", succeeded: true, obligationCount: 49, unresolvedObligationCount: 0, contradictionMass: 0.28 },
  // Correct and specific: the program planner answer that names the reaching call path.
  { episodeId: "episode_00mu4mfl1k_b8b6a7fc065c_6ff05321b0", request: "What is the program planner?", succeeded: true, obligationCount: 62, unresolvedObligationCount: 1, contradictionMass: 0.1308147911996026 },
  // Wrong: a physics question answered with `CodeImplementationBlueprint.taskDecomposition` prose.
  { episodeId: "episode_00mu4me44d_b8b6a7fc065c_94ba94d5b3", request: "What is the melting point of tungsten?", succeeded: false, obligationCount: 10, unresolvedObligationCount: 5, contradictionMass: 0.5 },
  // Warmup filler: no evidence, nothing discharged.
  { episodeId: "episode_00mu4lh2vk_ce5b7f2b129c_b2fd0c19b1", request: "warmup two", succeeded: false, obligationCount: 3, unresolvedObligationCount: 3, contradictionMass: 0 },
  { episodeId: "episode_00mu4mcvvp_b8b6a7fc065c_b86c6f77e0", request: "warmup two", succeeded: false, obligationCount: 3, unresolvedObligationCount: 3, contradictionMass: 0 },
  { episodeId: "episode_00mu4k7von_91670657da87_cb728d560b", request: "warmup", succeeded: false, obligationCount: 8, unresolvedObligationCount: 8, contradictionMass: 0.17999999999999994 }
];

function signals(row: typeof LIVE_EPISODES[number]): CreditRuntimeSignals {
  return {
    spoke: true,
    withheld: false,
    replanned: false,
    revised: false,
    corrected: false,
    contradictionMass: row.contradictionMass,
    obligationCount: row.obligationCount,
    unresolvedObligationCount: row.unresolvedObligationCount,
    budgetExceededCount: 3,
    evidenceCount: 2
  };
}

function reward(row: typeof LIVE_EPISODES[number]): number {
  const values = Object.values(runtimeRewardTerms(signals(row)));
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

/** A turn view carrying one live episode's proof obligations, in the shape the runtime hands the builder. */
function turnView(overrides: Partial<CognitiveCreditTurnView> = {}): CognitiveCreditTurnView {
  return {
    episodeId: "episode_00mu4liw97_ce5b7f2b129c_a1887e733b",
    conversationId: "conversation.default",
    taskClass: "task.dialogue_outcome",
    requestedAuthority: "factual",
    answer: "Tirana is the capital and largest city in the country.",
    entailment: {
      claim: { id: "claim_1" },
      proof: { id: "proof_1" },
      contradiction: 0.15872814201094998,
      // 45 satisfied, 11 underdetermined: the live Albania shape.
      obligations: [
        ...Array.from({ length: 45 }, (_, index) => ({ id: `obligation.${index}`, status: "satisfied" })),
        ...Array.from({ length: 11 }, (_, index) => ({ id: `obligation.u${index}`, status: "underdetermined" }))
      ]
    },
    evidenceIds: ["evidence_span.1", "evidence_span.2"],
    createdAt: 1_789_586_862_681,
    ...overrides
  };
}

describe("credit ledger outcome label", () => {
  /**
   * The defect: `unresolvedObligationCount === 0` is a perfection test over a three-valued status, so the
   * Albania turn discharged 45 of its 56 obligations, answered correctly, cited its source -- and labelled
   * negative. 45 of 46 live episodes labelled negative and no supervised fit could run on them.
   */
  it("reads a turn's obligations as the ratio the proof engine itself scores, not as a zero-test", () => {
    const record = buildCognitiveCreditRecord(turnView());
    expect(record.outcome.signals.obligationCount).toBe(56);
    expect(record.outcome.signals.unresolvedObligationCount).toBe(11);
    expect(record.outcome.rewardTerms.obligationDischarge).toBeCloseTo(45 / 56, 6);
    expect(record.outcome.reward).toBeGreaterThan(0);
  });

  /** A single turn has no population to split against, so it reports the quantity and never a class. */
  it("never classifies a turn from the turn alone", () => {
    const record = buildCognitiveCreditRecord(turnView());
    expect(record.outcome.label).toBe("outcome.unknown");
    expect(record.outcome.source).toBe(CREDIT_OUTCOME_SOURCE_IDS.runtimeSignal);
    expect(record.outcome.supervised).toBe(false);
    expect(typeof record.outcome.reward).toBe("number");
    for (const row of cognitiveCreditStageObservations(record)) {
      expect((row.metadata as Record<string, unknown>).reward).toBe(record.outcome.reward);
    }
  });

  /** A turn that measured no obligation measured no quality; that is `absent`, not a zero score. */
  it("reports an absent reward rather than scoring a turn it never measured", () => {
    const none = buildCognitiveCreditRecord(turnView({ entailment: { claim: { id: "c" }, proof: { id: "p" }, obligations: [] } }));
    expect(none.outcome.reward).toBeNull();
    expect(none.outcome.source).toBe(CREDIT_OUTCOME_SOURCE_IDS.absent);

    const silent = buildCognitiveCreditRecord(turnView({ answer: "", withheld: { reason: "no_admissible_surface" } }));
    expect(silent.outcome.reward).toBe(0);
    expect(silent.outcome.signals.spoke).toBe(false);
  });

  /**
   * Every runtime motion on this instance is `disabled_explicitly` with zero ingested evidence -- a deployment
   * gate refusing network.search, not a replan. `Boolean(view.runtimeMotion)` reported 12 of 46 turns as having
   * replanned when none had.
   */
  it("calls a turn replanned only when a motion actually changed its basis", () => {
    for (const status of ["disabled_explicitly", "unavailable", "empty", "refused", "awaiting_consent", "failed"]) {
      const record = buildCognitiveCreditRecord(turnView({ runtimeMotion: { status, ingestedEvidenceCount: 0 } }));
      expect(record.outcome.signals.replanned).toBe(false);
    }
    const hydratedEmpty = buildCognitiveCreditRecord(turnView({ runtimeMotion: { status: "hydrated", ingestedEvidenceCount: 0 } }));
    expect(hydratedEmpty.outcome.signals.replanned).toBe(false);
    const hydrated = buildCognitiveCreditRecord(turnView({ runtimeMotion: { status: "hydrated", ingestedEvidenceCount: 3 } }));
    expect(hydrated.outcome.signals.replanned).toBe(true);
  });

  /**
   * The whole point of the lane: the live episodes must carry both classes, and the class boundary must come
   * from the reward distribution rather than from a declared cut.
   */
  it("splits the live episodes into both classes on their own reward distribution", () => {
    const rewards = new Map(LIVE_EPISODES.map(row => [row.episodeId, reward(row)]));
    const classes = creditRewardClasses(rewards);
    expect(classes).toBeDefined();
    expect(classes!.positive.size).toBeGreaterThan(0);
    expect(classes!.positive.size).toBeLessThan(rewards.size);

    // The newly positive turns are the ones that demonstrably succeeded; the wrong and empty ones stay out.
    for (const row of LIVE_EPISODES) {
      expect(classes!.positive.has(row.episodeId)).toBe(row.succeeded);
    }
  });

  /** A correct, cited turn must not rank below a turn that answered a physics question with unrelated prose. */
  it("ranks the turns that answered above the turns that did not", () => {
    const byId = new Map(LIVE_EPISODES.map(row => [row.episodeId, reward(row)]));
    const albania = byId.get("episode_00mu4liw97_ce5b7f2b129c_a1887e733b")!;
    const tungsten = byId.get("episode_00mu4me44d_b8b6a7fc065c_94ba94d5b3")!;
    const warmup = byId.get("episode_00mu4lh2vk_ce5b7f2b129c_b2fd0c19b1")!;
    expect(albania).toBeGreaterThan(tungsten);
    expect(albania).toBeGreaterThan(warmup);
    expect(Math.min(...LIVE_EPISODES.filter(row => row.succeeded).map(reward)))
      .toBeGreaterThan(Math.max(...LIVE_EPISODES.filter(row => !row.succeeded).map(reward)));
  });

  /** A degenerate population has no two-class structure, and the reader must say so rather than invent one. */
  it("declines to split a population that carries one class", () => {
    expect(creditRewardClasses(new Map([["a", 0.5], ["b", 0.5], ["c", 0.5], ["d", 0.5]]))).toBeUndefined();
    expect(creditRewardClasses(new Map([["a", 0.5], ["b", 0.6]]))).toBeUndefined();
  });
});
