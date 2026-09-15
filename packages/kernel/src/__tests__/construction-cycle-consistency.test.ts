// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  induceLearnedConstructions,
  realizeLearnedSurface,
  type AlignedSurfaceExample,
  type LearnedRealization,
  type SurfaceMeaningPlan
} from "../language-construction.js";
import { createInMemoryDialogueMemoryStore } from "../dialogue-learning.js";
import {
  constructionCycleCalibrationObservation,
  constructionCycleScoresFromMemory,
  evaluateConstructionCycleConsistency,
  persistConstructionCycleConsistency,
  realizeLearnedSurfaceFromMemory
} from "../construction-cycle-consistency.js";
import { createHasher } from "../primitives.js";

const HASHER = createHasher();
const PROFILE = "profile.opaque";
const ROLE_LEFT = "role.left";
const ROLE_RIGHT = "role.right";

describe("construction cycle consistency", () => {
  it("persists semantic delta and makes later construction selection causal", async () => {
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [
        example("source.good", "q7 rel 4 z9.", "q7", "z9"),
        example("source.bad", "q7 alt 4 z9.", "q7", "z9")
      ]
    });
    expect(learned.constructions).toHaveLength(2);
    const meaning = plan("plan.cycle", "q8", "z8");
    const baseline = realizeLearnedSurface({
      plan: meaning,
      constructions: learned.constructions,
      formClasses: learned.formClasses,
      hasher: HASHER
    });
    expect(baseline.status).toBe("realized");
    if (baseline.status !== "realized") throw new Error(baseline.rejection.code);

    const goodConstruction = learned.constructions.find(construction => construction.sequence.some(part => part.kind === "literal" && part.surface.includes("rel")));
    const badConstruction = learned.constructions.find(construction => construction.sequence.some(part => part.kind === "literal" && part.surface.includes("alt")));
    expect(goodConstruction).toBeDefined();
    expect(badConstruction).toBeDefined();
    const goodRealization = realizeFor(meaning, learned, goodConstruction!.id);
    const badRealization = realizeFor(meaning, learned, badConstruction!.id);

    const goodOutcome = evaluateConstructionCycleConsistency({
      construction: goodConstruction!,
      realization: goodRealization,
      intendedSurface: "q8 rel 4 z8.",
      sourceRecordId: "source.good",
      createdAt: 10
    });
    const badOutcome = evaluateConstructionCycleConsistency({
      construction: badConstruction!,
      realization: { ...badRealization, text: "q8 alt 99 z8." },
      intendedSurface: "q8 alt 4 z8.",
      sourceRecordId: "source.bad",
      createdAt: 11
    });
    expect(goodOutcome.outcome).toBe(true);
    expect(goodOutcome.semanticDelta.total).toBe(0);
    expect(badOutcome.outcome).toBe(false);
    expect(badOutcome.semanticDelta.total).toBeGreaterThan(0);
    expect(badOutcome.score).toBeLessThan(goodOutcome.score);

    const store = createInMemoryDialogueMemoryStore();
    await persistConstructionCycleConsistency(store, goodOutcome);
    await persistConstructionCycleConsistency(store, badOutcome);
    const scores = await constructionCycleScoresFromMemory(store);
    expect(scores.get(goodConstruction!.id)).toBe(goodOutcome.score);
    expect(scores.get(badConstruction!.id)).toBe(badOutcome.score);

    const goodSelected = await realizeLearnedSurfaceFromMemory({
      store,
      plan: meaning,
      constructions: learned.constructions,
      formClasses: learned.formClasses,
      hasher: HASHER
    });
    expect(goodSelected.status).toBe("realized");
    if (goodSelected.status !== "realized") throw new Error(goodSelected.rejection.code);
    expect(goodSelected.realization.constructionId).toBe(goodConstruction!.id);

    const reversedScores = new Map([[goodConstruction!.id, badOutcome.score], [badConstruction!.id, goodOutcome.score]]);
    const badSelected = realizeLearnedSurface({
      plan: meaning,
      constructions: learned.constructions,
      formClasses: learned.formClasses,
      hasher: HASHER,
      cycleConsistencyByConstructionId: reversedScores
    });
    expect(badSelected.status).toBe("realized");
    if (badSelected.status !== "realized") throw new Error(badSelected.rejection.code);
    expect(badSelected.realization.constructionId).toBe(badConstruction!.id);
  });

  it("retains the full observed cycle decomposition in calibration metadata", () => {
    const metadata = constructionCycleCalibrationObservation({
      schema: "scce.construction_cycle_consistency.v1",
      constructionId: "construction.opaque",
      planId: "plan.opaque",
      profileKey: PROFILE,
      sourceExampleIds: ["source.opaque"],
      evidenceIds: ["evidence.opaque"],
      intendedSurfaceHash: "surface.a",
      realizedSurfaceHash: "surface.b",
      semanticDelta: {
        missing: 0,
        added: 0,
        reversed: 0,
        quantityMismatches: 1,
        timeMismatches: 0,
        polarityMismatches: 0,
        modalityMismatches: 0,
        discourseForceMismatches: 0,
        total: 1
      },
      score: 0.5,
      outcome: false,
      createdAt: 12
    });
    expect(metadata.calibrationId).toBe("calibration.language.construction_cycle.v1");
    expect(metadata.metadata).toMatchObject({
      constructionId: "construction.opaque",
      semanticDelta: { quantityMismatches: 1, total: 1 }
    });
  });
});

function realizeFor(
  meaning: SurfaceMeaningPlan,
  learned: ReturnType<typeof induceLearnedConstructions>,
  constructionId: string
): LearnedRealization {
  const result = realizeLearnedSurface({
    plan: meaning,
    constructions: learned.constructions.filter(construction => construction.id === constructionId),
    formClasses: learned.formClasses,
    hasher: HASHER
  });
  if (result.status !== "realized") throw new Error(result.rejection.code);
  return result.realization;
}

function example(id: string, surface: string, left: string, right: string): AlignedSurfaceExample {
  const leftStart = surface.indexOf(left);
  const rightStart = surface.indexOf(right, leftStart + left.length);
  return {
    id,
    profileKey: PROFILE,
    surface,
    evidenceIds: [`evidence.${id}`],
    roleSpans: [
      { roleId: ROLE_LEFT, start: leftStart, end: leftStart + left.length, surface: left, evidenceIds: [`evidence.${id}.left`] },
      { roleId: ROLE_RIGHT, start: rightStart, end: rightStart + right.length, surface: right, evidenceIds: [`evidence.${id}.right`] }
    ]
  };
}

function plan(id: string, left: string, right: string): SurfaceMeaningPlan {
  return {
    id,
    profileKey: PROFILE,
    roleSignature: [ROLE_LEFT, ROLE_RIGHT],
    slots: [
      { roleId: ROLE_LEFT, variants: [{ id: `${id}.left`, profileKey: PROFILE, surface: left, evidenceIds: ["evidence.plan.left"] }] },
      { roleId: ROLE_RIGHT, variants: [{ id: `${id}.right`, profileKey: PROFILE, surface: right, evidenceIds: ["evidence.plan.right"] }] }
    ]
  };
}
