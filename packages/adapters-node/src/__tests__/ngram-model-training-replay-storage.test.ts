// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  captureKneserNeyTrainingReplay,
  createHasher,
  persistedKneserNey,
  toJsonValue,
  trainKneserNey
} from "@scce/kernel";
import {
  decodeNgramModelTrainingReplay,
  encodeNgramModelTrainingReplay,
  NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA
} from "../ngram-model-training-replay-storage.js";

describe("PostgreSQL Kneser-Ney training replay storage", () => {
  it("round-trips exact logical JSON while retaining only non-derivable query projection fields", () => {
    const hasher = createHasher();
    const symbols = Array.from({ length: 1200 }, (_, index) => `token.${index % 97}`);
    const model = trainKneserNey(symbols, { order: 6, discount: 0.75, vocabularyLimit: 64 });
    const logical = toJsonValue({
      profileId: "profile.fixture",
      sourceSystem: "fixture",
      sourceVersionId: "source.fixture",
      compact: { perplexity: 3.5 },
      model: persistedKneserNey(model)
    });
    const recipe = captureKneserNeyTrainingReplay({ symbols, model, vocabularyLimit: 64, hasher });
    const physical = encodeNgramModelTrainingReplay(logical, recipe) as Record<string, any>;
    expect(physical.profileId).toBe("profile.fixture");
    expect(physical.sourceSystem).toBe("fixture");
    expect(physical.sourceVersionId).toBe("source.fixture");
    expect(physical.compact).toEqual({ perplexity: 3.5 });
    expect(physical.model).toMatchObject({
      schema: NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA,
      totalUnigramCount: model.totalUnigramCount
    });
    expect(physical.model.continuationCountPairs.length).toBe(Object.keys(model.continuationCounts).length * 2);
    expect(physical.model.vocabularyPartition).toEqual({
      listed: "excluded",
      symbolIds: recipe.vocabulary.flatMap((symbol, id) => model.vocabulary.includes(symbol) ? [] : [id])
    });
    expect(physical.model).not.toHaveProperty("bigramCountTriples");
    expect(physical.model).not.toHaveProperty("counts");
    expect(decodeNgramModelTrainingReplay(JSON.parse(JSON.stringify(physical)))).toEqual(logical);
    expect(JSON.stringify(physical).length).toBeLessThan(JSON.stringify(logical).length);
  });

  it("stores the smaller retained side when vocabulary clipping excludes most source symbols", () => {
    const hasher = createHasher();
    const symbols = Array.from({ length: 300 }, (_, index) => `token.${index % 100}`);
    const model = trainKneserNey(symbols, { order: 4, discount: 0.75, vocabularyLimit: 3 });
    const logical = toJsonValue({ model: persistedKneserNey(model) });
    const recipe = captureKneserNeyTrainingReplay({ symbols, model, vocabularyLimit: 3, hasher });
    const physical = encodeNgramModelTrainingReplay(logical, recipe) as Record<string, any>;
    expect(physical.model.vocabularyPartition).toEqual({
      listed: "retained",
      symbolIds: recipe.vocabulary.flatMap((symbol, id) => model.vocabulary.includes(symbol) ? [id] : [])
    });
    expect(decodeNgramModelTrainingReplay(JSON.parse(JSON.stringify(physical)))).toEqual(logical);
  });

  it("round-trips an exact source token named __proto__ without changing its sufficient statistics", () => {
    const hasher = createHasher();
    const symbols = ["alpha", "__proto__", "beta", "alpha", "__proto__", "gamma"];
    const model = trainKneserNey(symbols, { order: 4, vocabularyLimit: 16 });
    const logical = toJsonValue({ model: persistedKneserNey(model) }) as Record<string, any>;
    expect(Object.hasOwn(logical.model.counts, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(logical.model.counts)).toBe(Object.prototype);
    const recipe = captureKneserNeyTrainingReplay({ symbols, model, vocabularyLimit: 16, hasher });
    const physical = encodeNgramModelTrainingReplay(logical, recipe);
    expect(decodeNgramModelTrainingReplay(JSON.parse(JSON.stringify(physical)))).toEqual(logical);
    expect(({} as Record<string, unknown>).alpha).toBeUndefined();
  });

  it("rejects a vocabulary partition that changes replay normalization", () => {
    const hasher = createHasher();
    const symbols = ["a", "b", "c", "a", "b", "d"];
    const model = trainKneserNey(symbols, { order: 4, vocabularyLimit: 3 });
    const logical = toJsonValue({ model: persistedKneserNey(model) });
    const recipe = captureKneserNeyTrainingReplay({ symbols, model, vocabularyLimit: 3, hasher });
    const physical = encodeNgramModelTrainingReplay(logical, recipe) as Record<string, any>;
    physical.model.vocabularyPartition = { listed: "retained", symbolIds: [] };
    expect(() => decodeNgramModelTrainingReplay(physical)).toThrow("invalid stored Kneser-Ney training replay");
  });

  it("leaves legacy or independently imported models unchanged", () => {
    const value = toJsonValue({ profileId: "legacy", model: { counts: { a: 1 } } });
    expect(encodeNgramModelTrainingReplay(value, undefined)).toBe(value);
    expect(decodeNgramModelTrainingReplay(value)).toBe(value);
  });

  it("rejects imported JSON that impersonates a reserved physical replay marker", () => {
    const hasher = createHasher();
    const symbols = ["a", "b", "a"];
    const model = trainKneserNey(symbols, { order: 2, vocabularyLimit: 8 });
    const logical = toJsonValue({ model: persistedKneserNey(model) });
    const recipe = captureKneserNeyTrainingReplay({ symbols, model, vocabularyLimit: 8, hasher });
    const physical = encodeNgramModelTrainingReplay(logical, recipe);
    expect(() => encodeNgramModelTrainingReplay(physical, undefined))
      .toThrow("invalid stored Kneser-Ney training replay");
    const legacy = JSON.parse(JSON.stringify(physical)) as Record<string, any>;
    legacy.model.schema = "scce.ngram_model_training_replay.storage.v1";
    expect(() => encodeNgramModelTrainingReplay(legacy, undefined))
      .toThrow("invalid stored Kneser-Ney training replay");
  });

  it("rejects a replay tape bound to a different expanded model", () => {
    const hasher = createHasher();
    const first = ["a", "b", "a"], second = ["a", "c", "a"];
    const firstModel = trainKneserNey(first, { order: 2, vocabularyLimit: 8 });
    const secondModel = trainKneserNey(second, { order: 2, vocabularyLimit: 8 });
    const recipe = captureKneserNeyTrainingReplay({ symbols: first, model: firstModel, vocabularyLimit: 8, hasher });
    const logical = toJsonValue({ model: persistedKneserNey(secondModel) });
    expect(() => encodeNgramModelTrainingReplay(logical, recipe)).toThrow("invalid stored Kneser-Ney training replay");
  });
});
