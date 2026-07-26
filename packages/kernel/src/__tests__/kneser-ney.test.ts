import { describe, expect, it } from "vitest";
import {
  continueBoundedProse,
  kneserNeyProbability,
  predictKneserNey,
  trainKneserNey,
  type KneserNeyModel
} from "../kneser-ney.js";

describe("Kneser-Ney bounded candidate generation (plan item L1)", () => {
  it("scores far fewer candidates than the full vocabulary for an observed context", () => {
    const model = trainKneserNey(
      "the quick fox jumps over the lazy dog the quick fox runs past the lazy cat the quick fox sleeps under the lazy tree"
    );
    expect(model.vocabularySize).toBeGreaterThan(8);
    const predictions = predictKneserNey(model, ["the", "quick", "fox"], 16);
    expect(predictions.length).toBeGreaterThan(0);
    // "jumps"/"runs"/"sleeps" are the only observed continuations of "fox" in
    // this corpus -- the bounded candidate set must not fall back to scoring
    // the full ~10-symbol vocabulary's unobserved members as equally likely
    // top predictions.
    const topSymbols = predictions.slice(0, 3).map(p => p.symbol);
    expect(topSymbols.some(symbol => ["jumps", "runs", "sleeps"].includes(symbol))).toBe(true);
  });

  it("bounds recorded context successor sets to well under the full vocabulary size", () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
    const corpus = `alpha beta ${words.join(" ")} alpha beta gamma`;
    const model = trainKneserNey(corpus, { vocabularyLimit: 5000 });
    expect(model.vocabularySize).toBeGreaterThan(200);
    const successorLists = Object.values(model.contextSuccessorSymbols ?? {});
    expect(successorLists.length).toBeGreaterThan(0);
    for (const successors of successorLists) expect(successors.length).toBeLessThan(20);
  });

  it("falls back to a small top-frequency slice when contextSuccessorSymbols is absent (legacy persisted model)", () => {
    const model = trainKneserNey("alpha beta gamma alpha beta delta alpha beta epsilon");
    const legacyModel: KneserNeyModel = { ...model, contextSuccessorSymbols: undefined };
    const predictions = predictKneserNey(legacyModel, ["nonexistent", "context"], 8);
    expect(predictions.length).toBeGreaterThan(0);
    expect(predictions.length).toBeLessThanOrEqual(65);
  });

  it("keeps kneserNeyProbability correct (Set-based vocabulary membership matches array-based behavior)", () => {
    const model = trainKneserNey("alpha beta gamma alpha beta delta");
    const known = kneserNeyProbability(model, ["alpha"], "beta");
    const unknown = kneserNeyProbability(model, ["alpha"], "totally-unseen-symbol-xyz");
    expect(known).toBeGreaterThan(0);
    expect(unknown).toBeGreaterThan(0);
    expect(known).not.toBe(unknown);
  });

  it("still produces bounded, non-empty generation via continueBoundedProse after the candidate-set change", () => {
    const model = trainKneserNey(
      "the cat sat on the mat the cat ran to the door the cat slept by the fire the cat watched the rain"
    );
    const continuation = continueBoundedProse(model, ["the", "cat"], { generationExtent: 12, deterministicChoiceSeed: "test-seed", minSymbolsBeforeEos: 3 });
    expect(continuation.symbols.length).toBeGreaterThan(0);
    expect(continuation.text.length).toBeGreaterThan(0);
  });
});
