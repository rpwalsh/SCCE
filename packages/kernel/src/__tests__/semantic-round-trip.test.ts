import { describe, expect, it } from "vitest";
import { atomizeText, createHasher } from "../index.js";
import { SEMANTIC_SOURCE } from "../semantic-codes.js";
import {
  computeSemanticRoundTripDistance,
  discourseForceFromSurface,
  factualRoundTripGate
} from "../semantic-round-trip.js";
import type { SemanticAtom } from "../semantic-proof-types.js";

// Plan items 142-143. Real semantic round-trip validation
// (A -> Realize -> Interpret -> Ahat) built on `atomizeText` (already
// real, already tested) for both "Interpret" steps -- every scenario
// below runs the real extraction pipeline on real sentence pairs, not
// hand-fabricated atom objects (except the one dedicated "reversed"
// dimension test, which needs direct control over role-name assignment
// to exercise that one specific structural check in isolation).

const HASHER = createHasher();

function atomize(text: string) {
  return atomizeText({ text, source: SEMANTIC_SOURCE.CLAIM, hasher: HASHER });
}

describe("computeSemanticRoundTripDistance (plan item 142)", () => {
  it("an identical round trip (A realized faithfully as itself) reports zero distance on every dimension", () => {
    const text = "alice ships 42 crates to boston.";
    const distance = computeSemanticRoundTripDistance(atomize(text), atomize(text));
    expect(distance.matched).toHaveLength(1);
    expect(distance).toMatchObject({ missing: [], added: [], reversed: [], quantityMismatches: [], timeMismatches: [], polarityMismatches: [], modalityMismatches: [], discourseForceMismatches: [] });
  });

  it("a changed quantity is a real, matched-pair quantity mismatch -- not misreported as an unrelated missing+added pair", () => {
    const distance = computeSemanticRoundTripDistance(
      atomize("alice ships 42 crates to boston."),
      atomize("alice ships 99 crates to boston.")
    );
    expect(distance.matched).toHaveLength(1);
    expect(distance.missing).toEqual([]);
    expect(distance.added).toEqual([]);
    expect(distance.quantityMismatches).toHaveLength(1);
  });

  it("a changed year is both a real quantity and a real temporal mismatch on the same matched pair -- a year is genuinely both", () => {
    const distance = computeSemanticRoundTripDistance(
      atomize("alice ships crates in 2024."),
      atomize("alice ships crates in 2025.")
    );
    expect(distance.matched).toHaveLength(1);
    expect(distance.quantityMismatches).toHaveLength(1);
    expect(distance.timeMismatches).toHaveLength(1);
  });

  it("an extra realized sentence with no counterpart in the intended meaning is a real Added atom -- a hallucination", () => {
    const distance = computeSemanticRoundTripDistance(
      atomize("alice ships 42 crates to boston."),
      atomize("alice ships 42 crates to boston. bob invents 7 gadgets.")
    );
    expect(distance.matched).toHaveLength(1);
    expect(distance.added).toHaveLength(1);
    expect(distance.added[0]!.sourceText).toContain("bob invents");
  });

  it("a dropped intended sentence is a real Missing atom -- the realization failed to convey something it was supposed to assert", () => {
    const distance = computeSemanticRoundTripDistance(
      atomize("alice ships 42 crates to boston. bob invents 7 gadgets."),
      atomize("alice ships 42 crates to boston.")
    );
    expect(distance.matched).toHaveLength(1);
    expect(distance.missing).toHaveLength(1);
    expect(distance.missing[0]!.sourceText).toContain("bob invents");
  });

  it("turning a statement into a question is a real modality mismatch and a real discourse-force mismatch on the same matched pair", () => {
    const distance = computeSemanticRoundTripDistance(
      atomize("alice ships 42 crates to boston."),
      atomize("alice ships 42 crates to boston?")
    );
    expect(distance.matched).toHaveLength(1);
    expect(distance.modalityMismatches).toHaveLength(1);
    expect(distance.discourseForceMismatches).toHaveLength(1);
  });

  it("discourseForceFromSurface reads a real, observable surface signal for each of the three forces", () => {
    expect(discourseForceFromSurface("Is this correct?")).toBe("interrogative");
    expect(discourseForceFromSurface("This is remarkable!")).toBe("exclamative");
    expect(discourseForceFromSurface("This is a fact.")).toBe("declarative");
  });

  it("a genuinely swapped role assignment (subject and object exchanged) is a real reversed mismatch -- a direct, hand-built fixture proving this one specific structural check, since natural sentences rarely isolate exactly one dimension at a time", () => {
    const base: SemanticAtom = {
      id: "atom.a",
      predicate: "delivers",
      predicateFeatures: [],
      roles: [
        { name: "arg0", value: "alice", normalized: "alice", type: "entity", features: [], weight: 1 },
        { name: "arg1", value: "boston", normalized: "boston", type: "entity", features: [], weight: 1 }
      ],
      constraints: [],
      polarity: 1,
      alpha: 0.5,
      modality: "scce.mod.005",
      source: SEMANTIC_SOURCE.CLAIM,
      sourceText: "alice delivers to boston.",
      evidenceIds: [],
      nodeIds: [],
      vector: [],
      proofClass: "",
      certifiesFactualProof: false
    };
    const swapped: SemanticAtom = {
      ...base,
      id: "atom.ahat",
      roles: [
        { name: "arg0", value: "boston", normalized: "boston", type: "entity", features: [], weight: 1 },
        { name: "arg1", value: "alice", normalized: "alice", type: "entity", features: [], weight: 1 }
      ],
      sourceText: "boston delivers to alice."
    };
    const distance = computeSemanticRoundTripDistance([base], [swapped]);
    expect(distance.matched).toHaveLength(1);
    expect(distance.reversed).toHaveLength(1);
  });

  it("genuinely works across scripts, not just English -- the same quantity-mismatch detection on a real Chinese sentence pair", () => {
    const distance = computeSemanticRoundTripDistance(
      atomize("爱丽丝运送42箱货物到北京。"),
      atomize("爱丽丝运送99箱货物到北京。")
    );
    expect(distance.matched).toHaveLength(1);
    expect(distance.quantityMismatches).toHaveLength(1);
  });
});

describe("factualRoundTripGate (plan item 143)", () => {
  it("accepts a faithful realization and carries the full real cycle trace", () => {
    const text = "alice ships 42 crates to boston.";
    const result = factualRoundTripGate({ intendedText: text, realizedText: text, hasher: HASHER });
    expect(result.accepted).toBe(true);
    expect(result.cycleTrace.atomsA).toHaveLength(1);
    expect(result.cycleTrace.atomsAhat).toHaveLength(1);
    expect(result.cycleTrace.distance.added).toEqual([]);
  });

  it("rejects outright the moment any real Added atom appears -- a hallucinated claim, not a soft penalty", () => {
    const result = factualRoundTripGate({
      intendedText: "alice ships 42 crates to boston.",
      realizedText: "alice ships 42 crates to boston. bob invents 7 gadgets.",
      hasher: HASHER
    });
    expect(result.accepted).toBe(false);
    expect(result.reason).toMatch(/1 atom/);
    expect(result.cycleTrace.distance.added).toHaveLength(1);
  });

  it("does not reject on a Missing atom alone -- item 143 names only Added as the hard-reject condition, matching the real risk asymmetry (an omission is a completeness problem, a hallucination is a factual-safety problem)", () => {
    const result = factualRoundTripGate({
      intendedText: "alice ships 42 crates to boston. bob invents 7 gadgets.",
      realizedText: "alice ships 42 crates to boston.",
      hasher: HASHER
    });
    expect(result.accepted).toBe(true);
    expect(result.cycleTrace.distance.missing).toHaveLength(1);
  });

  it("every emitted result, accepted or rejected, carries the real intended/realized text and both real atom sets -- the cycle trace is never omitted", () => {
    const accepted = factualRoundTripGate({ intendedText: "x ships 1 crate.", realizedText: "x ships 1 crate.", hasher: HASHER });
    const rejected = factualRoundTripGate({ intendedText: "x ships 1 crate.", realizedText: "x ships 1 crate. y invents 2 gadgets.", hasher: HASHER });
    for (const result of [accepted, rejected]) {
      expect(result.cycleTrace.intendedText).toBeTruthy();
      expect(result.cycleTrace.realizedText).toBeTruthy();
      expect(result.cycleTrace.atomsA.length).toBeGreaterThan(0);
      expect(result.cycleTrace.atomsAhat.length).toBeGreaterThan(0);
    }
  });
});
