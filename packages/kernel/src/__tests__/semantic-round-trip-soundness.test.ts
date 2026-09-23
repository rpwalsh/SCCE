// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { factualRoundTripGate } from "../semantic-round-trip.js";
import { candidateIsVerifiedBoundValue, compileRealizationContract } from "../semantic-answer-construct.js";

// Real-parser companions to the supplied-atom acceptance tests. These mutation
// fixtures already appear in semantic-round-trip.test.ts; here their detected
// mismatches must actually reject output, rather than merely enter the trace.
describe("detected semantic corruption is an acceptance failure", () => {
  it.each([
    ["quantity", "alice ships 42 crates to boston.", "alice ships 99 crates to boston."],
    ["time", "alice ships crates in 2024.", "alice ships crates in 2025."],
    ["question", "alice ships 42 crates to boston.", "alice ships 42 crates to boston?"],
    ["Chinese quantity", "爱丽丝运送42箱货物到北京。", "爱丽丝运送99箱货物到北京。"]
  ])("rejects %s corruption although the parser matched the claim", (_name, intendedText, realizedText) => {
    const result = factualRoundTripGate({ intendedText: intendedText!, realizedText: realizedText! });
    expect(result.cycleTrace.distance.matched).toHaveLength(1);
    expect(result.cycleTrace.distance.added).toHaveLength(0);
    expect(result.accepted).toBe(false);
  });

  it.each(["alice ships 42 crates to boston.", "爱丽丝运送42箱货物到北京。"])("retains faithful output: %s", text => {
    expect(factualRoundTripGate({ intendedText: text, realizedText: text }).accepted).toBe(true);
  });

  it("retains the independent whole-fact omission contract", () => {
    const result = factualRoundTripGate({
      intendedText: "alice ships 42 crates to boston. bob invents 7 gadgets.",
      realizedText: "alice ships 42 crates to boston."
    });
    expect(result.accepted).toBe(true);
    expect(result.cycleTrace.distance.missing).toHaveLength(1);
  });

  it("does not mistake empty language output for a checked statement", () => {
    expect(factualRoundTripGate({ intendedText: "alice ships 42 crates to boston.", realizedText: "" }).accepted).toBe(false);
    expect(factualRoundTripGate({ intendedText: "", realizedText: "" }).accepted).toBe(false);
  });

  it("leaves exact bare-value answers on their existing separate path", () => {
    const contract = compileRealizationContract("When did Apollo 11 land?", {
      subject: "Apollo 11", predicate: "landed at", object: "20:17",
      sourceNodeId: "node.apollo", targetNodeId: "node.time", relationId: "relation.landing-time",
      forceClass: "direct_evidence", score: 1, activation: 1, overlap: 1, support: 1
    });
    expect(candidateIsVerifiedBoundValue("20:17", contract)).toBe(true);
    expect(candidateIsVerifiedBoundValue("20:18", contract)).toBe(false);
    expect(candidateIsVerifiedBoundValue("20:17 on Mars", contract)).toBe(false);
  });
});


describe("complete semantic coverage for full restatements", () => {
  it("rejects a dropped sentence only when complete coverage is required", () => {
    const texts = {
      intendedText: "alice ships 42 crates to boston. bob invents 7 gadgets.",
      realizedText: "alice ships 42 crates to boston."
    };
    expect(factualRoundTripGate(texts).accepted).toBe(true);
    const complete = factualRoundTripGate({ ...texts, requireComplete: true });
    expect(complete.accepted).toBe(false);
    expect(complete.cycleTrace.distance.missing).toHaveLength(1);
  });

  it("accepts an unchanged complete multi-sentence realization", () => {
    const text = "alice ships 42 crates to boston. bob invents 7 gadgets.";
    expect(factualRoundTripGate({ intendedText: text, realizedText: text, requireComplete: true }).accepted).toBe(true);
  });
});
