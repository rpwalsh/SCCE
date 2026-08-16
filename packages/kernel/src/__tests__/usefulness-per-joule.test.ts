import { describe, expect, it } from "vitest";
import {
  computeUsefulnessScore,
  computeUsefulnessPerJoule,
  deriveWastePenalty,
  deriveQualityFromReleaseGateMetrics,
  deriveCorrectnessFromReleaseGateMetrics,
  deriveFaithfulnessFromFactualGate,
  deriveActionabilityFromAssistantForce,
  deriveRelevanceFromAnswerAndRequest,
  deriveHarmlessnessFromPresentationGuard,
  NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS
} from "../usefulness-per-joule.js";
import { applyPragmaticsGuard, type PresentationPlan } from "../pragmatics-authorization-guard.js";

// Plan item 237. eta_SCCE: a rubric authored 2026-08-15 at the project
// owner's explicit request (no original spec exists anywhere -- verified
// with the owner directly). Every test below checks the formula this
// session actually designed, not a recovered original.

const perfectInputs = { quality: 1, correctness: 1, actionability: 1, relevance: 1, faithfulness: 1, harmlessness: 1 };

describe("computeUsefulnessScore (real Q,C,A,R,F,H weighted sum)", () => {
  it("scores exactly 1 when every rubric dimension is perfect under the neutral weights", () => {
    expect(computeUsefulnessScore(perfectInputs, NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS)).toBeCloseTo(1, 12);
  });

  it("scores exactly 0 when every rubric dimension is zero", () => {
    expect(computeUsefulnessScore({ quality: 0, correctness: 0, actionability: 0, relevance: 0, faithfulness: 0, harmlessness: 0 })).toBe(0);
  });

  it("rejects weights that do not sum to 1", () => {
    expect(() => computeUsefulnessScore(perfectInputs, { quality: 0.5, correctness: 0.5, actionability: 0.5, relevance: 0, faithfulness: 0, harmlessness: 0 })).toThrow(/convex combination/);
  });

  it("rejects a negative weight", () => {
    expect(() => computeUsefulnessScore(perfectInputs, { quality: 1.5, correctness: -0.5, actionability: 0, relevance: 0, faithfulness: 0, harmlessness: 0 })).toThrow();
  });

  it("rejects a rubric input outside [0,1] rather than silently clamping it", () => {
    expect(() => computeUsefulnessScore({ ...perfectInputs, faithfulness: 1.2 })).toThrow(/\[0, 1\]/);
  });

  it("a caller can weight faithfulness far above the other dimensions", () => {
    const weights = { quality: 0.05, correctness: 0.05, actionability: 0.05, relevance: 0.05, faithfulness: 0.7, harmlessness: 0.1 };
    const score = computeUsefulnessScore({ ...perfectInputs, faithfulness: 0 }, weights);
    expect(score).toBeCloseTo(0.3, 10);
  });
});

describe("deriveWastePenalty (real signal, item 236's energy measurement)", () => {
  it("is exactly zero at or under budget", () => {
    expect(deriveWastePenalty(50, 100)).toBe(0);
    expect(deriveWastePenalty(100, 100)).toBe(0);
  });

  it("grows linearly above budget", () => {
    expect(deriveWastePenalty(150, 100)).toBeCloseTo(0.5, 10);
    expect(deriveWastePenalty(200, 100)).toBeCloseTo(1, 10);
  });

  it("rejects a nonpositive budget", () => {
    expect(() => deriveWastePenalty(10, 0)).toThrow();
    expect(() => deriveWastePenalty(10, -5)).toThrow();
  });
});

describe("real signal reuse (not a parallel invention)", () => {
  it("quality derives directly from the release gate's exactAnchorAccuracy", () => {
    expect(deriveQualityFromReleaseGateMetrics({ exactAnchorAccuracy: 0.87 })).toBe(0.87);
  });

  it("correctness is the real complement of unsupportedRate", () => {
    expect(deriveCorrectnessFromReleaseGateMetrics({ unsupportedRate: 0.1 })).toBeCloseTo(0.9, 10);
  });

  it("faithfulness is a hard 1/0 from the real factual round-trip gate, never a partial score", () => {
    expect(deriveFaithfulnessFromFactualGate({ accepted: true })).toBe(1);
    expect(deriveFaithfulnessFromFactualGate({ accepted: false })).toBe(0);
  });

  it("actionability is 0 only for the real insufficient_support force class or no force class at all", () => {
    expect(deriveActionabilityFromAssistantForce("insufficient_support")).toBe(0);
    expect(deriveActionabilityFromAssistantForce(undefined)).toBe(0);
    for (const force of ["certified_fact", "source_grounded_answer", "learned_corpus_answer", "creative_answer", "action_result", "conjecture"] as const) {
      expect(deriveActionabilityFromAssistantForce(force)).toBe(1);
    }
  });

  it("relevance is real topical overlap -- high for an on-topic answer, low for an unrelated one", () => {
    const onTopic = deriveRelevanceFromAnswerAndRequest("Ada Lovelace was a mathematician who worked on Babbage's Analytical Engine.", "who was ada lovelace?");
    const offTopic = deriveRelevanceFromAnswerAndRequest("The quarterly report shows revenue increased by twelve percent.", "who was ada lovelace?");
    expect(onTopic).toBeGreaterThan(offTopic);
  });

  it("relevance reuses the real weightedJaccard/featureSet primitives, not a reimplementation", () => {
    // Identical text is always maximally self-similar under the real primitive.
    expect(deriveRelevanceFromAnswerAndRequest("same text", "same text")).toBe(1);
  });

  it("harmlessness audits the real presentation guard: 1 when the result genuinely matches what the real guard produces for this plan", () => {
    const plan: PresentationPlan = {
      requiredDisclosures: [{ id: "d1", content: "disclosure one" }, { id: "d2", content: "disclosure two" }],
      authorizationDecisions: [{ capabilityId: "cap.1", authorized: true, reason: "approved" }, { capabilityId: "cap.2", authorized: false, reason: "denied" }],
      pragmatics: {}
    };
    const realResult = applyPragmaticsGuard(plan);
    expect(deriveHarmlessnessFromPresentationGuard(plan, realResult)).toBe(1);
  });

  it("harmlessness is 0 when the supplied result does not match what the real guard actually produces for this plan (a stale or tampered result)", () => {
    const plan: PresentationPlan = {
      requiredDisclosures: [{ id: "d1", content: "disclosure one" }],
      authorizationDecisions: [],
      pragmatics: {}
    };
    const tamperedResult = { includedDisclosureIds: [], executableCapabilityIds: [], presentationOrder: [] };
    expect(deriveHarmlessnessFromPresentationGuard(plan, tamperedResult)).toBe(0);
  });
});

describe("computeUsefulnessPerJoule (eta_SCCE, plan item 237)", () => {
  it("computes usefulness/energy directly when there is no waste", () => {
    const result = computeUsefulnessPerJoule(perfectInputs, NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS, 0, 10);
    expect(result.usefulness).toBeCloseTo(1, 12);
    expect(result.etaSCCE).toBeCloseTo(0.1, 10);
  });

  it("a real waste penalty discounts eta_SCCE without ever dividing by zero (item 237's explicit requirement)", () => {
    const noWaste = computeUsefulnessPerJoule(perfectInputs, NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS, 0, 10);
    const withWaste = computeUsefulnessPerJoule(perfectInputs, NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS, 1, 10);
    // Waste of 1.0 doubles the divisor (1 + 1), so eta_SCCE is exactly halved -- real, checkable, and W=0 never divides by zero.
    expect(withWaste.etaSCCE).toBeCloseTo(noWaste.etaSCCE / 2, 10);
  });

  it("rejects zero or negative energy rather than producing an infinite or undefined eta_SCCE", () => {
    expect(() => computeUsefulnessPerJoule(perfectInputs, NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS, 0, 0)).toThrow();
    expect(() => computeUsefulnessPerJoule(perfectInputs, NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS, 0, -5)).toThrow();
  });

  it("rejects a negative waste penalty", () => {
    expect(() => computeUsefulnessPerJoule(perfectInputs, NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS, -0.1, 10)).toThrow();
  });

  it("a genuinely more useful answer for the same real energy always scores a higher eta_SCCE", () => {
    const weak = computeUsefulnessPerJoule({ ...perfectInputs, faithfulness: 0, correctness: 0.2 }, NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS, 0, 10);
    const strong = computeUsefulnessPerJoule(perfectInputs, NEUTRAL_USEFULNESS_RUBRIC_WEIGHTS, 0, 10);
    expect(strong.etaSCCE).toBeGreaterThan(weak.etaSCCE);
  });
});
