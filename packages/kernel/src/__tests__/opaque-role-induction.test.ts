import { describe, expect, it } from "vitest";
import { compileOpaqueRoleModel, opaqueRoleId } from "../opaque-role-induction.js";
import { compileRelationPromotionModel } from "../relation-promotion.js";
import { compileRoleSurfaceOrderModel } from "../role-surface-order.js";
import type { StructuredSemanticCandidate } from "../structured-semantic-candidate.js";
import type { SourceId, SourceVersionId } from "../types.js";
import { canonicalTemporalCoordinates } from "../canonical-temporal.js";

describe("opaque role induction", () => {
  it("learns reusable opaque identities from source-disjoint port distributions", () => {
    const candidates = corpus(240);
    const promotionModel = compileRelationPromotionModel({ candidates });
    const model = compileOpaqueRoleModel({ candidates, promotionModel });
    const firstRelation = model.selections.find(selection =>
      selection.relationSeedId === "relation_seed.first");

    expect(model.schema).toBe("scce.opaque_role_model.v1");
    expect(firstRelation?.selectedClusterCount).toBe(2);
    expect(firstRelation?.mdlGainNats).toBeGreaterThan(0);
    expect(model.clusters.every(cluster => /^role\.[a-f0-9]{32}$/u.test(cluster.id))).toBe(true);
    expect(model.clusters.every(cluster => cluster.independentSourceCount >= 2)).toBe(true);
    expect(model.assignments.every(assignment => assignment.posterior.length > 0)).toBe(true);
  });

  it("does not make participant array position part of learned role identity", () => {
    const candidates = corpus(240);
    const promotionModel = compileRelationPromotionModel({ candidates });
    const original = compileOpaqueRoleModel({ candidates, promotionModel });
    const reordered = compileOpaqueRoleModel({
      candidates: candidates.map(candidate => ({
        ...candidate,
        participants: [...candidate.participants].reverse()
      })),
      promotionModel
    });
    const sample = candidates.find(candidate =>
      candidate.relationSeedId === "relation_seed.first")!;

    for (const port of sample.participants) {
      expect(opaqueRoleId(original, sample.id, port.portId))
        .toBe(opaqueRoleId(reordered, sample.id, port.portId));
    }
  });

  it("learns semantic role and surface position as separate probability fields", () => {
    const candidates = corpus(240);
    const promotionModel = compileRelationPromotionModel({ candidates });
    const opaqueRoleModel = compileOpaqueRoleModel({ candidates, promotionModel });
    const original = compileRoleSurfaceOrderModel({
      candidates,
      promotionModel,
      opaqueRoleModel
    });
    const reordered = compileRoleSurfaceOrderModel({
      candidates: candidates.map(candidate => ({
        ...candidate,
        participants: [...candidate.participants].reverse()
      })),
      promotionModel,
      opaqueRoleModel
    });

    expect(original.semanticRoles).toEqual(reordered.semanticRoles);
    expect(original.surfacePositions).not.toEqual(reordered.surfacePositions);
    expect(original.audit).toMatchObject({
      semanticIdentityUsesPosition: false,
      unrealizedStateExplicit: true,
      repeatedStateExplicit: true
    });
  });
});

function corpus(count: number): StructuredSemanticCandidate[] {
  return Array.from({ length: count }, (_, index) => {
    const first = index % 2 === 0;
    const valueKinds = first
      ? ["anchor_surface", "target_ref"]
      : ["date_surface", "time_context"];
    return {
      schema: "scce.structured_semantic_candidate.v1",
      id: `candidate.${index}`,
      kind: first ? "link" : "date",
      relationSeedId: first ? "relation_seed.first" : "relation_seed.second",
      sourceId: `source.${index}` as SourceId,
      sourceVersionId: `version.${index}` as SourceVersionId,
      participants: valueKinds.map((valueKind, port) => ({
        portId: `provisional.${port}`,
        value: `${valueKind}.${index}`,
        valueKind,
        realization: "observed"
      })),
      qualifiers: { discourseStream: `stream.${index % 7}` },
      evidenceIds: [],
      temporalCoordinates: canonicalTemporalCoordinates({ observedTime: index }),
      support: 1,
      provenance: {}
    };
  });
}
