// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { compileOpaqueRoleModel } from "../opaque-role-induction.js";
import { compileRelationPromotionModel } from "../relation-promotion.js";
import { compileRoleSurfaceOrderModel, ROLE_SURFACE_ORDER_MODEL_SCHEMA } from "../role-surface-order.js";
import type { StructuredSemanticCandidate } from "../structured-semantic-candidate.js";
import type { SourceId, SourceVersionId } from "../types.js";
import { canonicalTemporalCoordinates } from "../canonical-temporal.js";

describe("role-surface-order model", () => {
  it("compiles a schema-stamped model whose id is deterministic under candidate input order", () => {
    const candidates = corpus(240);
    const promotionModel = compileRelationPromotionModel({ candidates });
    const opaqueRoleModel = compileOpaqueRoleModel({ candidates, promotionModel });
    const original = compileRoleSurfaceOrderModel({ candidates, promotionModel, opaqueRoleModel });
    const shuffled = compileRoleSurfaceOrderModel({
      candidates: [...candidates].reverse(),
      promotionModel,
      opaqueRoleModel
    });

    expect(original.schema).toBe(ROLE_SURFACE_ORDER_MODEL_SCHEMA);
    expect(original.id).toMatch(/^role_surface_order\.[a-f0-9]{40}$/u);
    expect(original.promotionModelId).toBe(promotionModel.id);
    expect(original.opaqueRoleModelId).toBe(opaqueRoleModel.id);
    expect(shuffled.id).toBe(original.id);
    expect(shuffled.semanticRoles).toEqual(original.semanticRoles);
    expect(shuffled.surfacePositions).toEqual(original.surfacePositions);
  });

  it("only promoted relations contribute occurrences", () => {
    const candidates = corpus(240);
    const promotionModel = compileRelationPromotionModel({ candidates });
    const opaqueRoleModel = compileOpaqueRoleModel({ candidates, promotionModel });
    const promotedSeedIds = new Set(promotionModel.decisions
      .filter(decision => decision.promoted)
      .map(decision => decision.relationSeedId));
    expect(promotedSeedIds.size).toBeGreaterThan(0);

    const model = compileRoleSurfaceOrderModel({ candidates, promotionModel, opaqueRoleModel });
    for (const row of model.semanticRoles) expect(promotedSeedIds.has(row.relationSeedId)).toBe(true);
    for (const row of model.surfacePositions) expect(promotedSeedIds.has(row.relationSeedId)).toBe(true);

    const unpromoted = compileRoleSurfaceOrderModel({
      candidates,
      promotionModel: { ...promotionModel, decisions: promotionModel.decisions.map(decision => ({ ...decision, promoted: false })) },
      opaqueRoleModel
    });
    expect(unpromoted.semanticRoles).toEqual([]);
    expect(unpromoted.surfacePositions).toEqual([]);
  });

  it("gives every distribution full Laplace-smoothed support over its alphabet", () => {
    const candidates = corpus(240);
    const promotionModel = compileRelationPromotionModel({ candidates });
    const opaqueRoleModel = compileOpaqueRoleModel({ candidates, promotionModel });
    const model = compileRoleSurfaceOrderModel({ candidates, promotionModel, opaqueRoleModel });

    expect(model.semanticRoles.length).toBeGreaterThan(0);
    for (const distribution of model.semanticRoles) {
      expect(distribution.probabilities.length).toBeGreaterThan(0);
      for (const row of distribution.probabilities) {
        // Laplace smoothing: nothing in the alphabet gets zero mass, and no
        // single entry may claim certainty.
        expect(row.probability).toBeGreaterThan(0);
        expect(row.probability).toBeLessThan(1);
      }
      const mass = distribution.probabilities.reduce((sum, row) => sum + row.probability, 0);
      expect(mass).toBeGreaterThan(0);
      expect(mass).toBeLessThanOrEqual(1.000001);
      expect(distribution.independentSourceCount).toBeGreaterThan(0);
    }

    expect(model.surfacePositions.length).toBeGreaterThan(0);
    for (const distribution of model.surfacePositions) {
      // Position alphabet always includes the explicit unrealized state plus
      // the eight position buckets -- absence is a real modeled state, never
      // silently dropped.
      const states = distribution.probabilities.map(row => row.state);
      expect(states).toContain("unrealized");
      for (let bucket = 0; bucket < 8; bucket++) expect(states).toContain(`bucket.${bucket}`);
      for (const row of distribution.probabilities) {
        expect(row.probability).toBeGreaterThan(0);
        expect(row.probability).toBeLessThan(1);
      }
      expect(distribution.repeatProbability).toBeGreaterThan(0);
      expect(distribution.repeatProbability).toBeLessThan(1);
    }
  });

  it("gives an omitted participant unrealized-position mass instead of a position bucket", () => {
    const candidates = corpus(240).map((candidate, index) =>
      index % 2 === 0
        ? {
          ...candidate,
          participants: candidate.participants.map((port, portIndex) =>
            portIndex === 1 ? { ...port, realization: "omitted" as const } : port)
        }
        : candidate);
    const promotionModel = compileRelationPromotionModel({ candidates });
    const opaqueRoleModel = compileOpaqueRoleModel({ candidates, promotionModel });
    const model = compileRoleSurfaceOrderModel({ candidates, promotionModel, opaqueRoleModel });

    // Some role's position distribution must now put dominant mass on the
    // explicit "unrealized" state -- the omitted ports all belong to one
    // port family, so at least one role sees mostly-unrealized occurrences.
    const unrealizedDominant = model.surfacePositions.some(distribution => {
      const unrealized = distribution.probabilities.find(row => row.state === "unrealized");
      return unrealized !== undefined
        && distribution.probabilities.every(row => row.state === "unrealized" || row.probability <= unrealized.probability);
    });
    expect(unrealizedDominant).toBe(true);
  });

  it("keeps the audit's separated-conditioning claims accurate", () => {
    const candidates = corpus(240);
    const promotionModel = compileRelationPromotionModel({ candidates });
    const opaqueRoleModel = compileOpaqueRoleModel({ candidates, promotionModel });
    const model = compileRoleSurfaceOrderModel({ candidates, promotionModel, opaqueRoleModel });

    expect(model.audit).toMatchObject({
      learner: "kernel.role_surface_order.separated_empirical_fields.v1",
      semanticRoleConditioning: ["relation", "graph_context"],
      surfacePositionConditioning: ["role", "relation", "discourse_context"],
      semanticIdentityUsesPosition: false,
      unrealizedStateExplicit: true,
      repeatedStateExplicit: true
    });
    // Semantic-role identity must be conditioned on graph context only --
    // never discourse context -- and surface position on discourse context.
    // The distribution keys prove the separation structurally.
    for (const row of model.semanticRoles) expect(row.graphContextId).toMatch(/^context\.[a-f0-9]{24}$/u);
    for (const row of model.surfacePositions) expect(row.discourseContextId).toMatch(/^context\.[a-f0-9]{24}$/u);
  });
});

function corpus(count: number): StructuredSemanticCandidate[] {
  return Array.from({ length: count }, (_, index) => {
    const first = index % 2 === 0;
    const valueKinds = first
      ? ["anchor_surface", "target_ref"]
      : ["date_surface", "time_context"];
    return {
      schema: "scce.semantic_candidate.v2",
      id: `candidate.${index}`,
      kind: first ? "link" : "date",
      channel: "source_declared_structured",
      relationSeedId: first ? "relation_seed.first" : "relation_seed.second",
      sourceId: `source.${index}` as SourceId,
      sourceVersionId: `version.${index}` as SourceVersionId,
      participants: valueKinds.map((valueKind, port) => ({
        portId: `provisional.${port}`,
        value: `${valueKind}.${index}`,
        valueKind,
        realization: "observed" as const
      })),
      qualifiers: { discourseStream: `stream.${index % 7}` },
      evidenceIds: [],
      temporalCoordinates: canonicalTemporalCoordinates({ observedTime: index }),
      support: 1,
      provenance: {
        exactEvidenceIds: [],
        extractionChannel: "source_declared_structured",
        anchors: [],
        assumptions: [],
        transformations: [],
        alternativeInterpretations: [],
        sourceIndependence: {
          independentSourceCount: 1,
          dependencyGroupIds: [`source.${index}`],
          estimate: 1
        },
        producer: { modelId: "fixture", snapshotId: "fixture.snapshot" },
        admissionState: "proposed",
        normalizationContractId: "fixture.normalization",
        participantIdentityIds: []
      }
    };
  });
}
