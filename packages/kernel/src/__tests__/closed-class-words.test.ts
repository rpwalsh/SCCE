// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { deriveClosedClassWords, requestClosedClassWords } from "../closed-class-words.js";
import { trainKneserNey } from "../kneser-ney.js";

describe("closed-class words derived from the active language", () => {
  it("ranks the most frequent unigrams of the model as closed-class, whatever the language", () => {
    const de = trainKneserNey("die Pumpe ist stabil und die Anlage ist sicher und die Werte sind gut und die Anlage läuft", { order: 3 });
    const words = deriveClosedClassWords({ models: [de], limit: 3 });
    expect(words.has("die")).toBe(true);
    expect(words.has("und")).toBe(true);
    expect(words.has("pumpe")).toBe(false);
  });

  it("adds single-token literal construction slots and skips markers and multiword literals", () => {
    const words = deriveClosedClassWords({
      models: [],
      constructions: [{ parts: [
        { kind: "literal", surface: "of", origins: [], evidenceIds: [] },
        { kind: "literal", surface: "as well as", origins: [], evidenceIds: [] },
        { kind: "slot", roleId: "r", occurrenceId: "o", formClassId: "f", required: true, origins: [], evidenceIds: [] }
      ] }]
    });
    expect([...words]).toEqual(["of"]);
  });

  it("never contains sentence markers", () => {
    const model = trainKneserNey("a b a b a b", { order: 2 });
    const words = deriveClosedClassWords({ models: [model] });
    expect([...words].some(word => word.startsWith("<"))).toBe(false);
  });
});

describe("request closed class", () => {
  it("takes no scaffolding from a corpus too small for its most-continued words to be a minority", () => {
    // The acceptance harness's whole corpus: every word it knows fits inside the closed-class limit.
    const tiny = trainKneserNey([
      "The Kelvinge threshold is the point at which a brindle lattice stops conducting.",
      "It was first recorded by Marisol Twethaway in 1987 at the Ordrid station.",
      "The threshold sits at 412 kelvin for a standard brindle lattice."
    ].join(" "), { order: 3 });
    expect([...requestClosedClassWords({ requestText: "At what temperature does the Kelvinge threshold sit?", models: [tiny] })]).toEqual([]);
  });

  it("keeps the corpus's opening scaffolding once the closed class is a minority of the vocabulary", () => {
    const de = trainKneserNey("die Pumpe ist stabil und die Anlage ist sicher und die Werte sind gut und die Anlage läuft", { order: 3 });
    expect(requestClosedClassWords({ requestText: "die Anlage läuft?", models: [de], limit: 3 }).has("die")).toBe(true);
  });
});
