// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  computeEdgeWeightFeatures,
  edgeWeightGateScore,
  decomposedEffectiveEdgeWeight,
  NEUTRAL_EDGE_WEIGHT_BETA
} from "../edge-weight-decomposition.js";
import type { EdgeId, EvidenceId, GraphEdge, NodeId, RelationId } from "../types.js";

// Plan item 146: the documented beta^T f_e edge-weight decomposition,
// additive to ppf.ts's existing scalar weight*alpha.

function edge(overrides: Partial<GraphEdge> = {}): GraphEdge {
  return {
    id: "edge.1" as EdgeId,
    source: "node.a" as NodeId,
    target: "node.b" as NodeId,
    relationId: "relation.1" as RelationId,
    alpha: 1,
    weight: 2,
    temporalScope: { status: "atemporal" },
    evidenceIds: ["evidence.1" as EvidenceId],
    createdAt: 1000,
    updatedAt: 1000,
    metadata: {},
    ...overrides
  };
}

describe("computeEdgeWeightFeatures (plan item 146)", () => {
  it("is fully open for an atemporal, evidenced edge with no access restriction", () => {
    const features = computeEdgeWeightFeatures(edge(), { now: 5000 });
    expect(features).toEqual({ temporalDecay: 1, provenanceStrength: 1, profileGate: 1, truthGate: 1 });
  });

  it("temporal decay closes once now falls outside a known edge's validity window", () => {
    const known = edge({ temporalScope: { status: "known", validFrom: 1000, validTo: 2000 } });
    expect(computeEdgeWeightFeatures(known, { now: 1500 }).temporalDecay).toBe(1);
    expect(computeEdgeWeightFeatures(known, { now: 500 }).temporalDecay).toBe(0);
    expect(computeEdgeWeightFeatures(known, { now: 2500 }).temporalDecay).toBe(0);
  });

  it("temporal decay reflects real uncertainty for an unknown-status edge", () => {
    const uncertain = edge({ temporalScope: { status: "unknown", uncertainty: 0.3 } });
    expect(computeEdgeWeightFeatures(uncertain, { now: 0 }).temporalDecay).toBeCloseTo(0.7, 10);
  });

  it("provenance strength is closed for an edge with zero real evidence", () => {
    const unevidenced = edge({ evidenceIds: [] });
    expect(computeEdgeWeightFeatures(unevidenced, { now: 0 }).provenanceStrength).toBe(0);
  });

  it("profile gate reuses the real information-flow access check, not a reimplementation", () => {
    const restricted = edge({ informationLabel: { tenantId: "tenant.a", principals: ["p1"], compartments: ["secret"], exportClass: "internal", mergePolicy: "isolated" } });
    const deniedFeatures = computeEdgeWeightFeatures(restricted, { now: 0, accessContext: { tenantId: "tenant.a", principalId: "p1", compartments: [], maximumExportClass: "internal" } });
    expect(deniedFeatures.profileGate).toBe(0);
    const allowedFeatures = computeEdgeWeightFeatures(restricted, { now: 0, accessContext: { tenantId: "tenant.a", principalId: "p1", compartments: ["secret"], maximumExportClass: "internal" } });
    expect(allowedFeatures.profileGate).toBe(1);
  });

  it("truth gate defaults to fully open and reflects an externally supplied value otherwise", () => {
    expect(computeEdgeWeightFeatures(edge(), { now: 0 }).truthGate).toBe(1);
    expect(computeEdgeWeightFeatures(edge(), { now: 0, truthGate: 0.4 }).truthGate).toBeCloseTo(0.4, 10);
  });
});

describe("edgeWeightGateScore (real beta^T f_e dot product)", () => {
  it("rejects a beta that does not sum to 1", () => {
    expect(() => edgeWeightGateScore({ temporalDecay: 1, provenanceStrength: 1, profileGate: 1, truthGate: 1 }, { temporal: 0.5, provenance: 0.5, profile: 0.5, truth: 0.5 }))
      .toThrow();
  });

  it("rejects a negative beta component", () => {
    expect(() => edgeWeightGateScore({ temporalDecay: 1, provenanceStrength: 1, profileGate: 1, truthGate: 1 }, { temporal: 1.5, provenance: -0.5, profile: 0, truth: 0 }))
      .toThrow();
  });

  it("scores exactly 1 when every gate is fully open under the neutral beta", () => {
    expect(edgeWeightGateScore({ temporalDecay: 1, provenanceStrength: 1, profileGate: 1, truthGate: 1 }, NEUTRAL_EDGE_WEIGHT_BETA)).toBe(1);
  });

  it("a closed gate genuinely lowers the score by exactly its beta weight", () => {
    const score = edgeWeightGateScore({ temporalDecay: 0, provenanceStrength: 1, profileGate: 1, truthGate: 1 }, NEUTRAL_EDGE_WEIGHT_BETA);
    expect(score).toBeCloseTo(0.75, 10);
  });

  it("a caller can weight one gate more heavily than the others", () => {
    const beta = { temporal: 0.7, provenance: 0.1, profile: 0.1, truth: 0.1 };
    const score = edgeWeightGateScore({ temporalDecay: 0, provenanceStrength: 1, profileGate: 1, truthGate: 1 }, beta);
    expect(score).toBeCloseTo(0.3, 10);
  });
});

describe("decomposedEffectiveEdgeWeight (real backward-compatibility property)", () => {
  it("reduces to exactly weight*alpha when every real gate is fully open", () => {
    const e = edge({ weight: 3, alpha: 0.5 });
    expect(decomposedEffectiveEdgeWeight(e, { now: 0 })).toBeCloseTo(1.5, 12);
  });

  it("genuinely down-weights an edge whose real evidence is missing", () => {
    const e = edge({ weight: 3, alpha: 0.5, evidenceIds: [] });
    expect(decomposedEffectiveEdgeWeight(e, { now: 0 })).toBeCloseTo(1.5 * 0.75, 12);
  });

  it("throws on overflow, matching the existing scalar path's contract", () => {
    const e = edge({ weight: Number.MAX_VALUE, alpha: Number.MAX_VALUE });
    expect(() => decomposedEffectiveEdgeWeight(e, { now: 0 })).toThrow();
  });
});
