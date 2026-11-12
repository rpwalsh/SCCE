// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  atomizeText,
  compileRelationHypothesisModel,
  createLanguageInductionEngine,
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

  it("keeps the complete posterior finite when a new surface was absent from training", () => {
    const model = compileRelationHypothesisModel({ observations, hasher: createHasher() });
    const posterior = inferRelationHypotheses({ symbols: ["erin", "builds", "towers"], model });

    expect(posterior[0]?.surface).toBe("builds");
    expect(posterior).toHaveLength(3);
    expect(posterior.every(row => Number.isFinite(row.posterior) && Number.isFinite(row.energy))).toBe(true);
    expect(posterior.reduce((sum, row) => sum + row.posterior, 0)).toBeCloseTo(1, 9);
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

  it("fits semantic posteriors from disjoint corpus context while retaining only current source factors", () => {
    const current = { id: "current", sourceFamilyId: "source.current", text: "erin builds towers." };
    const context = observations.map((row, index) => ({ id: `context.${index}`, sourceFamilyId: row.sourceId,
      text: `${row.symbols.join(" ")}.` }));
    const model = createLanguageInductionEngine({ hasher: createHasher() }).induce({
      documents: [current], relationContextDocuments: context
    });
    const factors = model.semanticInductionFactors!;

    expect(factors.documents.map(row => row.id)).toEqual(["current"]);
    expect(factors.sentences[0]!.symbols).toEqual(["erin", "builds", "towers"]);
    expect(factors.sentences[0]!.hypotheses[0]![0]).toBe(1);
    expect(model.relationHypothesisModel.sourceCount).toBe(1);
    expect((model.audit as { relationContextDocuments?: number }).relationContextDocuments).toBe(context.length);
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
