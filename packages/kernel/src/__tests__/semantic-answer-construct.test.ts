// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { candidateIsVerifiedBoundValue, candidateSurvivesRealizationContract, compileRealizationContract, type SemanticAnswerConstructFact } from "../semantic-answer-construct.js";

function fact(overrides: Partial<SemanticAnswerConstructFact>): SemanticAnswerConstructFact {
  return {
    subject: "Apollo 11",
    predicate: "landed on",
    object: "the Moon",
    sourceNodeId: "node:apollo11",
    targetNodeId: "node:moon",
    relationId: "edge:apollo11:moon",
    forceClass: "direct_evidence",
    score: 0.9,
    activation: 0.9,
    overlap: 0.9,
    support: 0.9,
    evidenceIds: ["evidence:apollo11"],
    ...overrides
  };
}

describe("compileRealizationContract", () => {
  it("derives requiredRelationUnits from the request, independently of the fact's own text", () => {
    const contract = compileRealizationContract("When did Apollo 11 land on the Moon?", fact({ object: "July 20, 1969" }));
    expect(contract.requiredRelationUnits.some(unit => unit.startsWith("land"))).toBe(true);
  });

  it("derives requiredAtoms from the fact's own well-formed text", () => {
    const contract = compileRealizationContract("When did Apollo 11 land on the Moon?", fact({ object: "July 20, 1969" }));
    expect(contract.requiredAtoms.length).toBeGreaterThan(0);
  });

  it("falls back to the fact's own predicate units when the request yields no relation units", () => {
    const contract = compileRealizationContract("", fact({}));
    expect(contract.requiredRelationUnits.length).toBeGreaterThan(0);
  });
});

describe("candidateSurvivesRealizationContract", () => {
  it("rejects a candidate that preserves the fact's own sentence but never answers the requested relation", () => {
    // The exact failure this contract exists to prevent: a sentence about Apollo 11 landing on the Moon,
    // fully faithful to its own meaning, that never states WHEN -- the thing the request actually asked.
    const contract = compileRealizationContract("When did Apollo 11 land on the Moon?", fact({ object: "July 20, 1969" }));
    const result = candidateSurvivesRealizationContract(
      "Apollo 11 was the first spaceflight to land humans on the Moon.",
      contract
    );
    expect(result.survives).toBe(false);
  });

  it("accepts a candidate that carries the subject, the relation, and the bound value", () => {
    const contract = compileRealizationContract(
      "When did Apollo 11 land on the Moon?",
      fact({ predicate: "landed on the Moon on", object: "July 20, 1969" }),
      undefined,
      // What the request corpus teaches as scaffolding for this request.
      new Set(["when", "did"])
    );
    const result = candidateSurvivesRealizationContract(
      "Apollo 11 landed on the Moon on July 20, 1969.",
      contract
    );
    expect(result.survives).toBe(true);
  });

  it("rejects a candidate that fabricates an assertion the fact never made", () => {
    const contract = compileRealizationContract("Where was Albert Einstein born?", fact({
      subject: "Albert Einstein",
      predicate: "was born in",
      object: "Ulm"
    }));
    const result = candidateSurvivesRealizationContract(
      "Albert Einstein was born in Ulm and later won the Nobel Prize in Chemistry.",
      contract
    );
    expect(result.survives).toBe(false);
  });

  it("rejects a bare bound value on its own, since it cannot restate the required relation unit", () => {
    // Real bug, confirmed live: "20:17" (a real, extracted, correct answer) failed the full sentence-shaped
    // survival check because it cannot lexically contain "land" -- exactly why candidateIsVerifiedBoundValue
    // exists as a separate, narrower check below, instead of this function being relaxed to accept it.
    const contract = compileRealizationContract("When did Apollo 11 land on the Moon?", fact({ object: "20:17" }));
    const result = candidateSurvivesRealizationContract("20:17", contract);
    expect(result.survives).toBe(false);
  });
});

describe("candidateIsVerifiedBoundValue", () => {
  it("accepts a bare value that exactly matches the fact's own bound object", () => {
    const contract = compileRealizationContract("When did Apollo 11 land on the Moon?", fact({ object: "20:17" }));
    expect(candidateIsVerifiedBoundValue("20:17", contract)).toBe(true);
  });

  it("rejects a value that does not match the fact's bound object", () => {
    const contract = compileRealizationContract("When did Apollo 11 land on the Moon?", fact({ object: "20:17" }));
    expect(candidateIsVerifiedBoundValue("21:45", contract)).toBe(false);
  });

  it("rejects a full sentence -- this check is scoped to the bare-value case only", () => {
    const contract = compileRealizationContract("When did Apollo 11 land on the Moon?", fact({ object: "20:17" }));
    expect(candidateIsVerifiedBoundValue("Apollo 11 landed on the Moon at 20:17.", contract)).toBe(false);
  });
});
