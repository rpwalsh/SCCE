import { describe, expect, it } from "vitest";
import {
  EVALUATION_CONDITION_IDS,
  assertValidEvaluationCondition,
  createEvaluationCacheKey,
  createEvaluationCondition,
  evaluationCacheKeyMaterial
} from "../evaluation-flags.js";

const CLOCK = "2026-07-12T12:00:00.000Z";

describe("sealed evaluation condition contract", () => {
  it("creates an immutable, distinct configuration for every required condition", () => {
    const configs = EVALUATION_CONDITION_IDS.map(conditionId => createEvaluationCondition({
      conditionId,
      seed: "sealed-seed",
      clockIso: CLOCK,
      scope: conditionId === "no_shard_router" ? "performance-recovery" : "answer-quality"
    }));
    expect(new Set(configs.map(config => config.configHash))).toHaveLength(EVALUATION_CONDITION_IDS.length);
    expect(new Set(configs.map(config => config.cacheNamespace))).toHaveLength(EVALUATION_CONDITION_IDS.length);
    for (const config of configs) {
      expect(Object.isFrozen(config)).toBe(true);
      expect(Object.isFrozen(config.flags)).toBe(true);
      expect(Object.isFrozen(config.disabledComponents)).toBe(true);
      expect(() => assertValidEvaluationCondition(config)).not.toThrow();
    }
  });

  it("hashes seed and injected clock into both config identity and cache isolation", () => {
    const first = condition({ seed: "a", clockIso: CLOCK });
    const repeat = condition({ seed: "a", clockIso: CLOCK });
    const anotherSeed = condition({ seed: "b", clockIso: CLOCK });
    const anotherClock = condition({ seed: "a", clockIso: "2026-07-12T12:00:01.000Z" });
    expect(first).toEqual(repeat);
    expect(first.configHash).not.toBe(anotherSeed.configHash);
    expect(first.configHash).not.toBe(anotherClock.configHash);
    expect(first.cacheNamespace).not.toBe(anotherSeed.cacheNamespace);
  });

  it("rejects label-only feature matrices and answer-quality shard-router ablations", () => {
    const valid = condition({ conditionId: "no_relation_potential" });
    const mislabeled = { ...valid, flags: { ...valid.flags, disableRelationPotential: false } };
    expect(() => assertValidEvaluationCondition(mislabeled)).toThrow(/feature matrix/u);
    expect(() => createEvaluationCondition({
      conditionId: "no_shard_router",
      seed: "sealed-seed",
      clockIso: CLOCK,
      scope: "answer-quality"
    })).toThrow(/performance-recovery/u);
  });

  it("includes every isolation identity in canonical cache material", () => {
    const config = condition({ conditionId: "full" });
    const identity = {
      brainHash: "brain-hash",
      corpusHash: "corpus-hash",
      sourceHash: "source-hash",
      buildHash: "build-hash",
      algorithmVersion: "graph-resolver-v1"
    };
    const material = evaluationCacheKeyMaterial(config, identity, "question:q1");
    expect(material).toMatchObject({
      ...identity,
      conditionId: "full",
      configHash: config.configHash,
      cacheNamespace: config.cacheNamespace,
      seed: "sealed-seed",
      clockIso: CLOCK,
      logicalKey: "question:q1"
    });
    expect(createEvaluationCacheKey(config, identity, "question:q1")).toMatch(new RegExp(`^${config.cacheNamespace}:[0-9a-f]{64}$`, "u"));
  });
});

function condition(overrides: Partial<Parameters<typeof createEvaluationCondition>[0]> = {}) {
  return createEvaluationCondition({
    conditionId: "full",
    seed: "sealed-seed",
    clockIso: CLOCK,
    ...overrides
  });
}
