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

  it("bounds compiled per-context successor indexes to well under the full vocabulary size", () => {
    const words = Array.from({ length: 300 }, (_, i) => `word${i}`);
    const corpus = `alpha beta ${words.join(" ")} alpha beta gamma`;
    const model = trainKneserNey(corpus, { vocabularyLimit: 5000 });
    expect(model.vocabularySize).toBeGreaterThan(200);
    const successorLists = Object.values(model.successorIndex);
    expect(successorLists.length).toBeGreaterThan(0);
    for (const successors of successorLists) expect(successors.length).toBeLessThan(20);
  });

  it("strictly rejects an uncompiled model rather than silently falling back (compiled successor-index contract)", () => {
    const model = trainKneserNey("alpha beta gamma alpha beta delta alpha beta epsilon");
    const uncompiledModel = { ...model, successorIndex: undefined } as unknown as KneserNeyModel;
    expect(() => predictKneserNey(uncompiledModel, ["nonexistent", "context"], 8)).toThrow(
      "Kneser-Ney model is not compiled for bounded successor-index inference"
    );
  });

  it("keeps kneserNeyProbability correct (Set-based vocabulary membership matches array-based behavior)", () => {
    const model = trainKneserNey("alpha beta gamma alpha beta delta");
    const known = kneserNeyProbability(model, ["alpha"], "beta");
    const unknown = kneserNeyProbability(model, ["alpha"], "totally-unseen-symbol-xyz");
    expect(known).toBeGreaterThan(0);
    expect(unknown).toBeGreaterThan(0);
    expect(known).not.toBe(unknown);
  });

  it("predictKneserNey's scores match per-symbol kneserNeyProbability exactly (plan item L4)", () => {
    const model = trainKneserNey(
      "the quick fox jumps over the lazy dog the quick fox runs past the lazy cat the quick fox sleeps under the lazy tree"
    );
    for (const context of [["the", "quick", "fox"], ["the", "lazy"], ["over"], []]) {
      const predictions = predictKneserNey(model, context, 32);
      for (const prediction of predictions) {
        expect(prediction.probability).toBe(kneserNeyProbability(model, context, prediction.symbol));
      }
    }
  });

  it("still produces bounded, non-empty generation via continueBoundedProse after the candidate-set change", () => {
    const model = trainKneserNey(
      "the cat sat on the mat the cat ran to the door the cat slept by the fire the cat watched the rain"
    );
    const continuation = continueBoundedProse(model, ["the", "cat"], { generationExtent: 12, deterministicChoiceSeed: "test-seed", minSymbolsBeforeEos: 3 });
    expect(continuation.symbols.length).toBeGreaterThan(0);
    expect(continuation.text.length).toBeGreaterThan(0);
  });

  it("keeps 80-symbol generation wall-time bounded by observed candidates, not full vocabulary size (plan item L2)", () => {
    const pattern = "the quick fox jumps over the lazy dog and the quick fox runs past the lazy cat and the quick fox sleeps under the lazy tree and ";
    const repeatedCorpus = pattern.repeat(40);
    const smallVocabModel = trainKneserNey(repeatedCorpus);

    const filler = Array.from({ length: 15000 }, (_, i) => `fillerword${i}`).join(" ");
    const largeVocabModel = trainKneserNey(`${repeatedCorpus} ${filler}`, { vocabularyLimit: 20000 });
    expect(largeVocabModel.vocabularySize).toBeGreaterThan(smallVocabModel.vocabularySize * 50);

    const generateOnce = (model: KneserNeyModel) => {
      const start = performance.now();
      continueBoundedProse(model, ["the", "quick", "fox"], {
        generationExtent: 80,
        deterministicChoiceSeed: "benchmark-seed",
        minSymbolsBeforeEos: 40
      });
      return performance.now() - start;
    };
    const median = (model: KneserNeyModel) => {
      generateOnce(model); // warm up before measuring
      const samples = Array.from({ length: 5 }, () => generateOnce(model)).sort((a, b) => a - b);
      return samples[2]!;
    };
    const smallMedian = median(smallVocabModel);
    const largeMedian = median(largeVocabModel);

    // A 50x+ larger vocabulary (all unobserved filler, never a real successor
    // of the generated context) must not translate into a proportional
    // slowdown -- bounded successor-index generation costs roughly the same
    // regardless of how much unrelated filler vocabulary the model carries.
    // The absolute floor guards against sub-millisecond timer noise on a fast
    // machine, not a real perf assertion.
    expect(largeMedian).toBeLessThan(Math.max(50, smallMedian * 10));
  });
});
