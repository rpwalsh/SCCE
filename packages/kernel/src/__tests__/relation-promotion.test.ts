import { describe, expect, it } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import {
  compileRelationPromotionModel,
  relationPromotionDecision
} from "../relation-promotion.js";
import { graphFromStructuredSemanticCandidates } from "../typed-ingest.js";
import { assertCanonicalHyperedge } from "../hyperedge.js";
import type { StructuredSemanticCandidate } from "../structured-semantic-candidate.js";
import { canonicalTemporalCoordinates } from "../canonical-temporal.js";
import type { EvidenceId, SourceId, SourceVersionId } from "../types.js";

describe("held-out relation promotion", () => {
  it("promotes source-independent relations only after real held-out compression and recovery", () => {
    const candidates = separableCandidates(80);
    const model = compileRelationPromotionModel({ candidates });

    expect(model.schema).toBe("scce.relation_promotion_model.v1");
    expect(model.fitSourceIds.length).toBeGreaterThan(0);
    expect(model.holdoutSourceIds.length).toBeGreaterThan(0);
    expect(model.decisions).toHaveLength(2);
    expect(model.decisions.every(decision =>
      decision.promoted
      && decision.descriptionLength.gainNats > 0
      && decision.recovery.gain > 0
      && decision.controls.every(control => !control.promoted))).toBe(true);
  });

  it("does not turn duplicated observations from one source into independent support", () => {
    const base = separableCandidates(2);
    const candidates = Array.from({ length: 200 }, (_, index) => ({
      ...base[index % base.length]!,
      id: `duplicate.${index}`,
      sourceVersionId: `version.${index}` as SourceVersionId
    }));
    const model = compileRelationPromotionModel({ candidates });

    expect(model.decisions.every(decision => !decision.promoted)).toBe(true);
    expect(model.decisions.every(decision =>
      decision.reasons.includes("insufficient_independent_sources"))).toBe(true);
  });

  it("keeps shuffled and random-repetition controls below the promotion boundary", () => {
    const model = compileRelationPromotionModel({ candidates: separableCandidates(120) });

    for (const decision of model.decisions) {
      expect(decision.controls.map(control => control.kind)).toEqual([
        "shuffled_relations",
        "duplicate_only",
        "random_repetition"
      ]);
      expect(decision.controls.every(control => !control.promoted)).toBe(true);
    }
  });

  it("marks candidate incidence as promoted only from the compiled model decision", () => {
    const candidates = separableCandidates(80);
    const model = compileRelationPromotionModel({ candidates });
    const hasher = createHasher();
    const ids = createIdFactory({
      clock: createClock({ fixedTime: 1 }),
      hasher,
      namespace: "relation-promotion-test"
    });
    const graph = graphFromStructuredSemanticCandidates({
      candidates: candidates.slice(0, 2),
      observedAt: 1,
      ids,
      hasher,
      relationPromotionModel: model
    });

    expect(relationPromotionDecision(model, candidates[0]!.relationSeedId)?.promoted).toBe(true);
    expect(graph.nodes.filter(node => node.features.some(feature => feature.startsWith("promoted-relation:")))).toHaveLength(2);
    expect(graph.edges.every(edge =>
      typeof edge.metadata === "object"
      && edge.metadata !== null
      && !Array.isArray(edge.metadata)
      && edge.metadata.promoted === true)).toBe(true);
  });

  it("materializes promoted relations with arbitrary observed and omitted ports", () => {
    const trained = separableCandidates(80);
    const model = compileRelationPromotionModel({ candidates: trained });
    const hasher = createHasher();
    const ids = createIdFactory({
      clock: createClock({ fixedTime: 1 }),
      hasher,
      namespace: "arbitrary-relation-test"
    });
    const observedAndOmitted: StructuredSemanticCandidate = {
      ...trained[0]!,
      id: "candidate.arbitrary",
      qualifiers: { validFrom: 10, validTo: 20, quantity: 3 },
      temporalCoordinates: canonicalTemporalCoordinates({
        observedTime: 100,
        eventTime: 15,
        validFrom: 10,
        validTo: 20,
        provenance: { parserModelId: "fixture.temporal" }
      }),
      participants: [
        trained[0]!.participants[0]!,
        {
          portId: "port.omitted",
          value: null,
          valueKind: "unrealized_participant",
          realization: "omitted"
        }
      ]
    };
    const zeroArity: StructuredSemanticCandidate = {
      ...trained[0]!,
      id: "candidate.zero-arity",
      participants: [],
      qualifiers: { eventState: "observed_without_participants" }
    };
    const graph = graphFromStructuredSemanticCandidates({
      candidates: [observedAndOmitted, zeroArity],
      observedAt: 1,
      ids,
      hasher,
      relationPromotionModel: model
    });

    expect(graph.hyperedges).toHaveLength(2);
    expect(graph.hyperedges[0]).toMatchObject({
      schema: "scce.hyperedge.v2",
      qualifiers: { validFrom: 10, validTo: 20, quantity: 3 },
      temporalScope: {
        schema: "scce.temporal_coordinates.v1",
        observedTime: 100,
        eventTime: 15,
        validFrom: 10,
        validTo: 20
      }
    });
    expect(graph.hyperedges[0]!.participantPorts).toHaveLength(2);
    expect(graph.hyperedges[0]!.memberNodeIds).toHaveLength(1);
    expect(graph.hyperedges[0]!.participantPorts[1]).toMatchObject({
      nodeId: null,
      realization: "omitted"
    });
    expect(graph.nodes.some(node =>
      node.metadata
      && typeof node.metadata === "object"
      && !Array.isArray(node.metadata)
      && node.metadata.portId === "port.omitted")).toBe(false);
    expect(graph.edges).toHaveLength(0);
    expect(graph.hyperedges[1]!.participantPorts).toEqual([]);
    expect(graph.hyperedges[1]!.memberNodeIds).toEqual([]);
    expect(() => assertCanonicalHyperedge({
      ...graph.hyperedges[0]!,
      memberNodeIds: []
    })).toThrow(/must equal observed participant-port node IDs/u);
  });
});

function separableCandidates(count: number): StructuredSemanticCandidate[] {
  return Array.from({ length: count }, (_, index) => {
    const first = index % 2 === 0;
    const kind = first ? "link" as const : "date" as const;
    const relationSeedId = first ? "relation_seed.first" : "relation_seed.second";
    const valueKinds = first
      ? ["anchor_surface", "target_ref"]
      : ["date_surface", "time_context"];
    return {
      schema: "scce.structured_semantic_candidate.v1",
      id: `candidate.${index}`,
      kind,
      relationSeedId,
      sourceId: `source.${index}` as SourceId,
      sourceVersionId: `version.${index}` as SourceVersionId,
      participants: valueKinds.map((valueKind, port) => ({
        portId: `port.${port}`,
        value: `${valueKind}.${index}`,
        valueKind,
        realization: "observed"
      })),
      qualifiers: {},
      evidenceIds: [`evidence.${index}` as EvidenceId],
      temporalCoordinates: canonicalTemporalCoordinates({ observedTime: index }),
      support: 1,
      provenance: {}
    };
  });
}
