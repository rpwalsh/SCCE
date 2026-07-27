import { describe, expect, it } from "vitest";
import {
  atomizeText,
  compileRelationHypothesisModel,
  createHasher,
  inferRelationHypotheses
} from "../index.js";

const observations = [
  { sourceId: "source.a", symbols: ["alice", "builds", "boats"] },
  { sourceId: "source.b", symbols: ["bob", "builds", "houses"] },
  { sourceId: "source.c", symbols: ["carol", "builds", "bridges"] },
  { sourceId: "source.d", symbols: ["dara", "builds", "tools"] }
] as const;

describe("relation hypothesis posterior", () => {
  it("retains a normalized finite posterior instead of selecting by center, length, or rarity", () => {
    const model = compileRelationHypothesisModel({
      observations,
      hasher: createHasher()
    });
    const posterior = inferRelationHypotheses({
      symbols: ["builds", "alice", "boats"],
      model
    });

    expect(posterior[0]?.surface).toBe("builds");
    expect(posterior[0]?.index).toBe(0);
    expect(posterior).toHaveLength(3);
    expect(posterior.reduce((sum, row) => sum + row.posterior, 0)).toBeCloseTo(1, 9);
    expect(posterior.every(row => Number.isFinite(row.energy))).toBe(true);
  });

  it("is deterministic under source reduction order", () => {
    const hasher = createHasher();
    const left = compileRelationHypothesisModel({ observations, hasher });
    const right = compileRelationHypothesisModel({
      observations: [...observations].reverse(),
      hasher
    });

    expect(right).toEqual(left);
  });

  it("carries competing predicate hypotheses into semantic proof atoms", () => {
    const atoms = atomizeText({
      text: "alice builds boats. bob builds houses.",
      source: "claim",
      hasher: createHasher()
    });

    expect(atoms).toHaveLength(2);
    expect(atoms[0]?.predicateHypotheses?.length).toBeGreaterThan(1);
    expect(atoms[0]?.predicateHypotheses?.reduce(
      (sum, row) => sum + row.posterior,
      0
    )).toBeCloseTo(1, 9);
  });
});
