import { describe, expect, it } from "vitest";
import {
  KNESER_NEY_SCHEMA,
  kneserNeyProbability,
  predictKneserNey,
  trainKneserNey
} from "../index.js";

describe("compiled Kneser-Ney runtime indexes", () => {
  it("predicts from observed context and backoff successors without a vocabulary scan", () => {
    const symbols = [
      "alpha", "one",
      "alpha", "two",
      "alpha", "three",
      "beta", "four",
      ...Array.from({ length: 10_000 }, (_, index) => `rare-${index}`)
    ];
    const model = trainKneserNey(symbols, {
      order: 3,
      vocabularyLimit: 20_000
    });

    expect(model.schema).toBe(KNESER_NEY_SCHEMA);
    expect(model.vocabulary.length).toBeGreaterThan(10_000);
    expect(model.successorIndex.alpha).toEqual(expect.arrayContaining(["one", "two", "three"]));
    expect(Object.keys(model.backoffWeights).length).toBeGreaterThan(0);

    const predictions = predictKneserNey(model, ["alpha"], 8);
    expect(predictions.map(row => row.symbol)).toEqual(expect.arrayContaining(["one", "two", "three"]));
    expect(predictions.length).toBeLessThanOrEqual(8);
  });

  it("uses constant-time hydrated membership and rejects uncompiled model state", () => {
    const model = trainKneserNey(["a", "b", "a", "c"], { order: 2 });
    expect(kneserNeyProbability(model, ["a"], "b")).toBeGreaterThan(0);
    expect(kneserNeyProbability(model, ["a"], "never-observed")).toBeGreaterThan(0);

    const invalid = {
      ...model,
      schema: "scce.kneser_ney.v1",
      successorIndex: undefined
    };
    expect(() => predictKneserNey(invalid as never, ["a"], 4)).toThrow(
      "not compiled for bounded successor-index inference"
    );
  });
});
