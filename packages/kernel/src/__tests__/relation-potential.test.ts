import { describe, expect, it } from "vitest";
import { createEvaluationCondition } from "../evaluation-flags.js";
import { createEvaluationTrace, verifyEvaluationTrace } from "../evaluation-trace.js";
import { createAlphaFieldEngine } from "../field.js";
import {
  assertValidRelationPotentialModel,
  fitRelationPotential,
  projectGraphEdgeRelationPotential,
  scoreRelationPotential,
  type RelationPotentialExample,
  type RelationPotentialFitDatasets,
  type RelationPotentialFeatures,
  type RelationPotentialModel
} from "../relation-potential.js";
import type { GraphEdge, GraphNode } from "../types.js";

describe("calibrated evidence-conditioned relation potential", () => {
  const positive = features({ compatibility: 0.95, provenance: 0.9, temporalFit: 0.9, modalityAgreement: 0.9, recurrence: 0.8, utility: 0.8, sourceAgreement: 0.9, contradiction: 0.05 });
  const negative = features({ compatibility: 0.2, provenance: 0.2, temporalFit: 0.3, modalityAgreement: 0.2, recurrence: 0.1, utility: 0.2, sourceAgreement: 0.1, contradiction: 0.9 });
  const training: RelationPotentialExample[] = [
    { id: "p1", features: positive, label: 1 },
    { id: "p2", features: features({ ...positive, recurrence: 0.6 }), label: 1 },
    { id: "n1", features: negative, label: 0 },
    { id: "n2", features: features({ ...negative, temporalFit: 0.1 }), label: 0 }
  ];
  const calibrationFit: RelationPotentialExample[] = [
    { id: "cp", features: features({ ...positive, utility: 0.7 }), label: 1 },
    { id: "cn", features: features({ ...negative, compatibility: 0.3 }), label: 0 }
  ];
  const evaluationHoldout: RelationPotentialExample[] = [
    { id: "hp", features: features({ ...positive, provenance: 0.75 }), label: 1 },
    { id: "hn", features: features({ ...negative, contradiction: 0.8 }), label: 0 }
  ];

  it("fits deterministically on three disjoint folds and publishes only holdout metrics", () => {
    const first = fitRelationPotential(fitDatasets());
    const replay = fitRelationPotential(fitDatasets());
    expect(replay).toEqual(first);
    expect(first.modelId).toMatch(/^relation-potential:/u);
    expect(first.schema).toBe("scce.relation_potential.v2");
    expect(first.sampleCounts).toEqual({ coefficientTrainingCount: 4, calibrationFitCount: 2, evaluationHoldoutCount: 2 });
    expect(first.calibration.holdoutBrier).toBeGreaterThanOrEqual(0);
    expect(first.calibration.holdoutBrier).toBeLessThanOrEqual(1);
    expect(first.calibration.holdoutEce).toBeGreaterThanOrEqual(0);
    expect(first.calibration.holdoutEce).toBeLessThanOrEqual(1);
    expect(scoreRelationPotential(first, positive).calibrated).toBeGreaterThan(scoreRelationPotential(first, negative).calibrated);
  });

  it("enforces monotone positive features and contradiction pressure", () => {
    const model = fitRelationPotential(fitDatasets());
    for (const coefficient of Object.values(model.coefficients)) expect(coefficient).toBeGreaterThanOrEqual(0);
    expect(model.contradictionCoefficient).toBeGreaterThanOrEqual(0);
    const base = features({ ...positive, compatibility: 0.4, contradiction: 0.1 });
    expect(scoreRelationPotential(model, features({ ...base, compatibility: 0.8 })).uncalibrated).toBeGreaterThanOrEqual(scoreRelationPotential(model, base).uncalibrated);
    expect(scoreRelationPotential(model, features({ ...base, contradiction: 0.8 })).uncalibrated).toBeLessThanOrEqual(scoreRelationPotential(model, base).uncalibrated);
  });

  it("rejects invalid data instead of silently clamping it", () => {
    expect(() => fitRelationPotential({ ...fitDatasets(), coefficientTraining: [{ id: "only", features: positive, label: 1 }] })).toThrow(/coefficientTraining requires both labels/u);
    expect(() => fitRelationPotential({ ...fitDatasets(), calibrationFit: [{ id: "only-calibration", features: positive, label: 1 }] })).toThrow(/calibrationFit requires both labels/u);
    expect(() => fitRelationPotential({ ...fitDatasets(), evaluationHoldout: [{ id: "only-holdout", features: positive, label: 1 }] })).toThrow(/evaluationHoldout requires both labels/u);
    expect(() => scoreRelationPotential(fitRelationPotential(fitDatasets()), features({ ...positive, utility: 2 }))).toThrow(/within \[0, 1\]/u);
  });

  it("rejects observation reuse across folds and binds the independent holdout in the dataset hash", () => {
    expect(() => fitRelationPotential({
      ...fitDatasets(),
      evaluationHoldout: [calibrationFit[0]!, evaluationHoldout[1]!]
    })).toThrow(/datasets must be disjoint.*cp.*calibrationFit and evaluationHoldout/u);

    const first = fitRelationPotential(fitDatasets());
    const changedHoldout = fitRelationPotential({
      ...fitDatasets(),
      evaluationHoldout: [
        { ...evaluationHoldout[0]!, features: features({ ...evaluationHoldout[0]!.features, recurrence: 0.1 }) },
        evaluationHoldout[1]!
      ]
    });
    expect(changedHoldout.datasetHash).not.toBe(first.datasetHash);
    expect(changedHoldout.modelId).not.toBe(first.modelId);
    expect(changedHoldout.coefficients).toEqual(first.coefficients);
    expect(changedHoldout.calibration.slope).toBe(first.calibration.slope);
    expect(changedHoldout.calibration.intercept).toBe(first.calibration.intercept);
  });

  it("rejects serialized coefficient edits that retain an old model id", () => {
    const model = fitRelationPotential(fitDatasets());
    const edited = {
      ...model,
      coefficients: { ...model.coefficients, compatibility: model.coefficients.compatibility + 0.01 }
    } as RelationPotentialModel;
    expect(() => assertValidRelationPotentialModel(edited)).toThrow(/modelId does not match frozen model content/u);

    const editedHoldoutCount = {
      ...model,
      sampleCounts: { ...model.sampleCounts, evaluationHoldoutCount: model.sampleCounts.evaluationHoldoutCount + 1 }
    } as RelationPotentialModel;
    expect(() => assertValidRelationPotentialModel(editedHoldoutCount)).toThrow(/modelId does not match frozen model content/u);

    const editedHoldoutMetric = {
      ...model,
      calibration: {
        ...model.calibration,
        holdoutBrier: model.calibration.holdoutBrier > 0.5
          ? model.calibration.holdoutBrier - 0.01
          : model.calibration.holdoutBrier + 0.01
      }
    } as RelationPotentialModel;
    expect(() => assertValidRelationPotentialModel(editedHoldoutMetric)).toThrow(/modelId does not match frozen model content/u);
  });

  it("projects only bounded graph structure and audited typed numeric signals", () => {
    const edges = transitionEdges();
    const projected = projectGraphEdgeRelationPotential(edges[0]!, { edges, snapshotTime: 10 });
    expect(projected.schema).toBe("scce.graph_edge_relation_features.v1");
    expect(projected.features.modalityAgreement).toBe(1);
    expect(projected.features.contradiction).toBe(0);
    expect(Object.values(projected.features).every(value => value >= 0 && value <= 1)).toBe(true);
    expect(projected.featureSources.compatibility).toBe("edge.weight.saturating_nonnegative.v1");
    const invalid = { ...edges[0]!, metadata: { relationPotential: { contradiction: 2 } } };
    expect(() => projectGraphEdgeRelationPotential(invalid, { edges: [invalid], snapshotTime: 10 })).toThrow(/within \[0, 1\]/u);
  });

  it("changes production transition mass with a frozen model and removes exactly that scoring in the ablation", () => {
    const model = fitRelationPotential(fitDatasets());
    const nodes = transitionNodes();
    const edges = transitionEdges();
    const identity = createAlphaFieldEngine().activate({ text: "anchor", nodes, edges });
    const configured = createAlphaFieldEngine({ relationPotentialModel: model }).activate({ text: "anchor", nodes, edges });
    const condition = createEvaluationCondition({ conditionId: "no_relation_potential", seed: "fixture", clockIso: "2026-07-12T12:00:00.000Z" });
    const trace = createEvaluationTrace(condition, { traceId: "trace", runId: "run", questionId: "question" });
    const ablated = createAlphaFieldEngine({ relationPotentialModel: model }).activate({
      text: "anchor",
      nodes,
      edges,
      evaluation: { condition, trace }
    });

    const identityMass = massByNode(identity);
    const configuredMass = massByNode(configured);
    const ablatedMass = massByNode(ablated);
    expect(identityMass.get("node:good")).toBeCloseTo(identityMass.get("node:bad") ?? -1, 12);
    expect(configuredMass.get("node:good")).toBeGreaterThan(configuredMass.get("node:bad") ?? 1);
    expect(ablatedMass.get("node:good")).toBeCloseTo(identityMass.get("node:good") ?? -1, 12);
    expect(ablatedMass.get("node:bad")).toBeCloseTo(identityMass.get("node:bad") ?? -1, 12);
    expect(trace.events()).toContainEqual(expect.objectContaining({ event: "componentBypassed", component: "relation-potential", boundary: "field.relation-potential" }));
    expect(verifyEvaluationTrace(condition, trace.events()).valid).toBe(true);
    expect((configured.ppfDiagnostics as Record<string, unknown>).relationPotential).toMatchObject({ mode: "frozen_model", modelId: model.modelId, edgeCount: 2 });
    expect((ablated.ppfDiagnostics as Record<string, unknown>).relationPotential).toMatchObject({ mode: "identity_condition_disabled", modelId: model.modelId, edgeScores: [] });
  });

  function features(value: RelationPotentialFeatures): RelationPotentialFeatures {
    return value;
  }

  function fitDatasets(): RelationPotentialFitDatasets {
    return { coefficientTraining: training, calibrationFit, evaluationHoldout };
  }

  function transitionNodes(): GraphNode[] {
    return [
      node("node:source", ["sym:anchor"]),
      node("node:good", ["sym:favorable"]),
      node("node:bad", ["sym:adverse"])
    ];
  }

  function node(id: string, nodeFeatures: string[]): GraphNode {
    return {
      id,
      typeId: "type:fixture",
      representation: { conceptId: id },
      alpha: 1,
      evidenceIds: [],
      features: nodeFeatures,
      createdAt: 1,
      updatedAt: 10,
      metadata: {}
    } as unknown as GraphNode;
  }

  function transitionEdges(): GraphEdge[] {
    return [
      edge("edge:good", "node:good", { modalityAgreement: 1, contradiction: 0 }),
      edge("edge:bad", "node:bad", { modalityAgreement: 0, contradiction: 1 })
    ];
  }

  function edge(id: string, target: string, relationPotential: { modalityAgreement: number; contradiction: number }): GraphEdge {
    return {
      id,
      source: "node:source",
      target,
      relationId: "rel:fixture",
      alpha: 1,
      weight: 1,
      temporalScope: { validFrom: 0 },
      evidenceIds: ["evidence:fixture"],
      createdAt: 1,
      updatedAt: 10,
      metadata: { relationPotential }
    } as unknown as GraphEdge;
  }

  function massByNode(field: ReturnType<ReturnType<typeof createAlphaFieldEngine>["activate"]>): Map<string, number> {
    return new Map(field.ppf.map(row => [String(row.nodeId), row.mass]));
  }
});
