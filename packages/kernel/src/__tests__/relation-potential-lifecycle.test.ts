// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { fitRelationPotential, type RelationPotentialExample, type RelationPotentialFeatures } from "../relation-potential.js";
import {
  assertPromotableRelationPotentialArtifact,
  describeRelationPotentialCapability,
  validateRelationPotentialAgainstIdentity,
  type RelationPotentialHoldoutRow
} from "../relation-potential-lifecycle.js";

function features(provenance: number, sourceAgreement: number): RelationPotentialFeatures {
  return {
    compatibility: 0.5,
    provenance,
    temporalFit: 1,
    modalityAgreement: 0,
    recurrence: 0,
    utility: 0.5,
    sourceAgreement,
    contradiction: 0
  };
}

function rows(count: number, positive: boolean): RelationPotentialExample[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${positive ? "p" : "n"}${index}`,
    features: positive ? features(0.9, 0.9) : features(0.1, 0.1),
    label: positive ? 1 : 0
  }));
}

const datasets = {
  coefficientTraining: [...rows(40, true), ...rows(40, false)],
  calibrationFit: [...rows(20, true), ...rows(20, false)].map(row => ({ ...row, id: `c${row.id}` })),
  evaluationHoldout: [...rows(20, true), ...rows(20, false)].map(row => ({ ...row, id: `h${row.id}` }))
};

const holdout: RelationPotentialHoldoutRow[] = datasets.evaluationHoldout.map(row => ({
  ...row,
  baseTransitionWeight: row.label === 1 ? 0.4 : 0.4
}));

describe("relation-potential artifact lifecycle", () => {
  const model = fitRelationPotential(datasets, { iterations: 4000 });

  it("grades the model against the constant identity could estimate, not against a held-out oracle", () => {
    const validation = validateRelationPotentialAgainstIdentity(model, holdout, "dataset", 0.5);
    expect(validation.fittedAuroc).toBeGreaterThan(0.5);
    expect(validation.identityAuroc).toBe(0.5);
    expect(validation.oracleHoldoutBaseRateBrier).toBeGreaterThan(0);
    expect(validation.scoredTransitionOrderingAuroc).toBeGreaterThan(validation.identityTransitionOrderingAuroc);
    expect(validation.beatsIdentity).toBe(true);
  });

  it("refuses to promote an artifact that did not beat identity", () => {
    const validation = validateRelationPotentialAgainstIdentity(model, holdout, "dataset", 0.5);
    expect(() => assertPromotableRelationPotentialArtifact({
      modelId: model.modelId,
      model,
      lifecycle: "fitted",
      validation,
      trainingWindow: {},
      createdAt: 0
    })).toThrow(/only a validated artifact may be promoted/u);
    expect(() => assertPromotableRelationPotentialArtifact({
      modelId: model.modelId,
      model,
      lifecycle: "validated",
      validation: { ...validation, beatsIdentity: false },
      trainingWindow: {},
      createdAt: 0
    })).toThrow(/did not beat identity/u);
    expect(() => assertPromotableRelationPotentialArtifact({
      modelId: model.modelId,
      model,
      lifecycle: "validated",
      validation,
      trainingWindow: {},
      createdAt: 0
    })).not.toThrow();
  });

  it("reports active only with a promoted artifact in hand", () => {
    expect(describeRelationPotentialCapability({ artifact: "untrained" }).status).toBe("inert_unconfigured");
    expect(describeRelationPotentialCapability({ artifact: "fitted" }).status).toBe("inert_unconfigured");
    expect(describeRelationPotentialCapability({ artifact: "validated" }).status).toBe("inert_unconfigured");
    const promoted = describeRelationPotentialCapability({
      artifact: "promoted",
      record: { modelId: model.modelId, model, lifecycle: "promoted", trainingWindow: {}, createdAt: 0 }
    });
    expect(promoted.status).toBe("active");
    expect(promoted.artifactId).toBe(model.modelId);
  });
});
