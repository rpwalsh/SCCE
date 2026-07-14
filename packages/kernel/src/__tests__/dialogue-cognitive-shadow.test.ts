import { describe, expect, it } from "vitest";
import { projectProofBearingDialogueTurnV2 } from "../dialogue-cognitive-shadow.js";
import { resolveDiscourseStateV2 } from "../discourse-state.js";
import { dialogueCognitiveStateInteractionRecordV2 } from "../dialogue-cognitive-memory.js";
import { createHasher } from "../primitives.js";
import type { GraphSlice, TurnResult } from "../types.js";

describe("proof-bearing dialogue cognitive shadow projection", () => {
  it("projects only proof-selected evidence linked to a durable graph node", () => {
    const hasher = createHasher();
    const projection = projectProofBearingDialogueTurnV2({
      conversationId: "conversation.01",
      sessionId: "session.01",
      turnId: "turn.01",
      turnIndex: 1,
      roleId: "role.owner",
      surfaceHash: hasher.digestHex("opaque surface"),
      result: proofBearingResult(),
      graph: proofGraphSlice(),
      hasher
    });

    expect(projection.status).toBe("observed");
    if (projection.status !== "observed") return;
    expect(projection.observation.explicitAnchorNodeIds).toEqual(["node.01"]);
    expect(projection.observation.mentions).toHaveLength(1);
    expect(projection.observation.mentions[0]).toMatchObject({
      candidateNodeIds: ["node.01"],
      candidateReferentIds: ["node.01"]
    });
    expect(projection.observation.mentions[0]).not.toHaveProperty("span");
    expect(projection.observation.mentions[0]?.sourceIdentityIds).toEqual(expect.arrayContaining([
      "proof.01",
      "mapping.01",
      "evidence.01",
      "node.01"
    ]));
    expect(projection.referents).toEqual([expect.objectContaining({ id: "node.01", nodeIds: ["node.01"] })]);
    expect(projection.routeSignals).toEqual([expect.objectContaining({ mentionId: projection.observation.mentions[0]?.id, referentId: "node.01" })]);
    expect(projection.provenanceBindings).toEqual([expect.objectContaining({
      routeId: "proof.01",
      nodeIds: ["node.01"],
      evidenceIds: ["evidence.01"],
      sourceVersionIds: ["source.01"]
    })]);

    const resolution = resolveDiscourseStateV2({
      observation: projection.observation,
      referents: projection.referents,
      topics: projection.topics,
      routeSignals: projection.routeSignals,
      provenanceBindings: projection.provenanceBindings,
      hasher
    });
    expect(() => dialogueCognitiveStateInteractionRecordV2({ state: resolution.state, createdAt: 7, hasher })).not.toThrow();
    expect(JSON.stringify(resolution)).not.toContain("opaque surface");
  });

  it("returns not_observed instead of fabricating a referent when a proof graph node is absent", () => {
    const projection = projectProofBearingDialogueTurnV2({
      conversationId: "conversation.01",
      turnId: "turn.01",
      turnIndex: 1,
      roleId: "role.owner",
      surfaceHash: createHasher().digestHex("opaque surface"),
      result: proofBearingResult(),
      graph: { ...proofGraphSlice(), nodes: [] },
      hasher: createHasher()
    });

    expect(projection).toMatchObject({ status: "not_observed", reasonId: "proof_graph_node_missing" });
    expect(projection).not.toHaveProperty("observation");
  });

  it("returns not_observed when the chosen answer lacks a proof-certificate evidence receipt", () => {
    const result = proofBearingResult();
    result.proofCarryingAnswer = { citedSpanIds: [] };
    const projection = projectProofBearingDialogueTurnV2({
      conversationId: "conversation.01",
      turnId: "turn.01",
      turnIndex: 1,
      roleId: "role.owner",
      surfaceHash: createHasher().digestHex("opaque surface"),
      result,
      graph: proofGraphSlice(),
      hasher: createHasher()
    });

    expect(projection).toMatchObject({ status: "not_observed", reasonId: "proof_evidence_missing" });
  });
});

function proofBearingResult(): TurnResult {
  return {
    evidence: [{
      id: "evidence.01",
      sourceVersionId: "source.01",
      charStart: 0,
      charEnd: 8,
      text: "evidence",
      textPreview: "evidence",
      languageHints: {},
      scriptHints: {},
      trustVector: {},
      provenance: {},
      features: [],
      status: "promoted",
      alpha: 0.9,
      observedAt: 1
    }],
    field: {
      requestFeatures: [],
      seeds: [{ nodeId: "node.01", feature: "feature.01", weight: 0.9 }],
      active: [{ nodeId: "node.01", activation: 0.9 }],
      ppf: [{ nodeId: "node.01", mass: 0.8 }],
      alphaTrace: {} as never,
      causalMass: []
    },
    selectedCandidate: { id: "candidate.01", evidenceIds: ["evidence.01"] },
    proofCarryingAnswer: { citedSpanIds: ["evidence.01"] },
    entailment: {
      claim: { id: "claim.01", text: "", normalized: "", features: [], polarity: 1 },
      verdict: "entailed",
      semanticVerdict: "entailed",
      force: "observed",
      support: 0.9,
      contradiction: 0,
      faithfulnessLcb: 0.8,
      confidence: {} as never,
      scores: {} as never,
      obligations: [],
      mappings: [{
        id: "mapping.01",
        obligationId: "obligation.01",
        kind: "entity",
        status: "satisfied",
        claimText: "",
        relation: "exact",
        evidenceIds: ["evidence.01"],
        sourceVersionIds: ["source.01"],
        support: 0.9,
        contradiction: 0,
        audit: {}
      }],
      transforms: [],
      counterexamples: [],
      missing: [],
      proof: {
        id: "proof.01",
        claimId: "claim.01",
        verdict: "observed",
        confidence: {},
        proofGraph: { nodes: [], edges: [] },
        evidenceIds: ["evidence.01"],
        transformIds: [],
        scores: {},
        validatorVersion: "validator.01",
        createdAt: 1
      },
      evidenceIds: ["evidence.01"],
      boundaries: []
    }
  } as unknown as TurnResult;
}

function proofGraphSlice(): GraphSlice {
  return {
    nodes: [{
      id: "node.01",
      typeId: "dimension.01",
      representation: {},
      alpha: 0.9,
      evidenceIds: ["evidence.01"],
      features: [],
      createdAt: 1,
      updatedAt: 1,
      metadata: {}
    }],
    edges: [],
    hyperedges: [],
    bounded: true,
    query: { evidenceIds: ["evidence.01"] }
  } as unknown as GraphSlice;
}
