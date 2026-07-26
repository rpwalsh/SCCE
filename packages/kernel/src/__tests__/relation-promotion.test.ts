import { describe, expect, it } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import {
  compileRelationPromotionModel,
  relationPromotionDecision
} from "../relation-promotion.js";
import { graphFromStructuredSemanticCandidates } from "../typed-ingest.js";
import type { StructuredSemanticCandidate } from "../structured-semantic-candidate.js";
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
        valueKind
      })),
      qualifiers: {},
      evidenceIds: [`evidence.${index}` as EvidenceId],
      support: 1,
      provenance: {}
    };
  });
}
