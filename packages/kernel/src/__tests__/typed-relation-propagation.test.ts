import { describe, expect, it } from "vitest";
import { createCandidateEngine, proveClaim, typedRelationTraces, typedRelationsToProofRecords, type EvidenceSpan, type FieldState, type GraphNode, type Hyperedge, type ProofClaim, type SemanticEntailmentResult } from "../index.js";

describe("typed relation propagation", () => {
  it("keeps ordered direction, role ids, and value kinds when a promoted relation enters proof", () => {
    const evidence = sourceEvidence();
    const hyperedge = relationFixture(evidence.id);
    const nodes: GraphNode[] = [
      node("entity.subject", "Ada"),
      node("entity.object", "Ulm")
    ];
    const [trace] = typedRelationTraces([hyperedge]);
    expect(trace).toMatchObject({
      relationId: "relation.birth_place",
      direction: {
        fromPortId: "port.person",
        toPortId: "port.place",
        orientation: "ordered_observed_ports"
      },
      participants: [
        { portId: "port.person", roleId: "role.person", valueKind: "entity.person" },
        { portId: "port.place", roleId: "role.place", valueKind: "entity.place" }
      ]
    });

    const [record] = typedRelationsToProofRecords({ hyperedges: [hyperedge], nodes, evidence: [evidence] });
    expect(record).toMatchObject({
      relationId: "relation.birth_place",
      subject: { id: "entity.subject", roleId: "role.person", kindId: "entity.person" },
      object: { id: "entity.object", roleId: "role.place", kindId: "entity.place" }
    });
    const claim: ProofClaim = {
      id: "claim.birth_place",
      subject: { id: "entity.subject", roleId: "role.person", kindId: "entity.person" },
      relationId: "relation.birth_place",
      object: { id: "entity.object", roleId: "role.place", kindId: "entity.place" }
    };
    expect(proveClaim({ claim, candidateEvidence: [record!] }).verdict).toBe("certified");

    const reversed: ProofClaim = {
      ...claim,
      subject: { id: "entity.subject", roleId: "role.place", kindId: "entity.place" },
      object: { id: "entity.object", roleId: "role.person", kindId: "entity.person" }
    };
    expect(proveClaim({ claim: reversed, candidateEvidence: [record!] }).verdict).toBe("contradicted");
  });

  it("carries the same typed relation into live graph candidate scoring", () => {
    const evidence = sourceEvidence();
    const hyperedge = relationFixture(evidence.id);
    const candidate = createCandidateEngine().generate({
      requestText: "where was Ada born",
      entailment: entailmentFixture(evidence.id),
      evidence: [evidence],
      field: fieldFixture(),
      ccr: { accepted: false } as never,
      proofAnswer: "",
      learningNeeds: [],
      requestedAuthority: "reasoned",
      typedRelations: [hyperedge]
    }).candidates.find(row => row.kind === "graph-inference");
    expect(candidate?.typedRelations?.[0]).toMatchObject({
      relationId: "relation.birth_place",
      direction: { fromPortId: "port.person", toPortId: "port.place" },
      participants: [
        { roleId: "role.person", valueKind: "entity.person" },
        { roleId: "role.place", valueKind: "entity.place" }
      ]
    });
    expect(candidate?.scoreTrace?.[0]?.inputs).toEqual(expect.arrayContaining([
      "typedRelations", "orderedPortDirection", "participantRoleIds", "participantValueKinds"
    ]));
  });
});

function entailmentFixture(evidenceId: EvidenceSpan["id"]): SemanticEntailmentResult {
  return {
    claim: { id: "claim.fixture" as SemanticEntailmentResult["claim"]["id"], text: "where was Ada born", normalized: "where was ada born", features: ["where", "ada", "born"], polarity: 1 },
    verdict: "underdetermined",
    semanticVerdict: "underdetermined",
    force: "inferred",
    support: 0.8,
    contradiction: 0,
    faithfulnessLcb: 0.8,
    confidence: {} as SemanticEntailmentResult["confidence"],
    scores: {} as SemanticEntailmentResult["scores"],
    obligations: [],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    proof: { id: "proof.fixture" as SemanticEntailmentResult["proof"]["id"], claimId: "claim.fixture" as SemanticEntailmentResult["proof"]["claimId"], verdict: "inferred", confidence: {}, proofGraph: { nodes: [], edges: [] }, evidenceIds: [evidenceId], transformIds: [], scores: {}, validatorVersion: "fixture", createdAt: 1 },
    evidenceIds: [evidenceId],
    boundaries: []
  };
}

function fieldFixture(): FieldState {
  return {
    requestFeatures: [],
    seeds: [],
    active: [],
    ppf: [],
    alphaTrace: { surfaces: { pressure: 0, actionability: 0, drift: 0, risk: 0 } } as FieldState["alphaTrace"],
    causalMass: [{ nodeId: "entity.subject" as GraphNode["id"], mass: 0.8, reason: "fixture" }]
  };
}

function relationFixture(evidenceId: EvidenceSpan["id"]): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: "hyperedge.birth" as Hyperedge["id"],
    relationId: "relation.birth_place" as Hyperedge["relationId"],
    participantPorts: [
      { portId: "port.person", roleId: "role.person", nodeId: "entity.subject" as GraphNode["id"], valueKind: "entity.person", realization: "observed", evidenceIds: [evidenceId] },
      { portId: "port.place", roleId: "role.place", nodeId: "entity.object" as GraphNode["id"], valueKind: "entity.place", realization: "observed", evidenceIds: [evidenceId] }
    ],
    memberNodeIds: ["entity.subject", "entity.object"] as GraphNode["id"][],
    qualifiers: {},
    modality: {},
    evidenceIds: [evidenceId],
    weightVector: { alpha: 0.9 },
    temporalScope: {},
    provenanceRefs: [String(evidenceId)],
    createdAt: 1,
    updatedAt: 1
  };
}

function node(id: string, representation: string): GraphNode {
  return {
    id: id as GraphNode["id"],
    typeId: "dimension.entity" as GraphNode["typeId"],
    representation,
    alpha: 0.9,
    evidenceIds: [],
    features: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function sourceEvidence(): EvidenceSpan {
  return {
    id: "evidence.birth" as EvidenceSpan["id"],
    sourceId: "source.fixture" as EvidenceSpan["sourceId"],
    sourceVersionId: "version.fixture" as EvidenceSpan["sourceVersionId"],
    chunkId: "chunk.fixture" as EvidenceSpan["chunkId"],
    contentHash: "hash.fixture" as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: 24,
    charStart: 0,
    charEnd: 24,
    text: "Ada was born in Ulm.",
    textPreview: "Ada was born in Ulm.",
    languageHints: {},
    scriptHints: {},
    trustVector: { trust: 1 },
    provenance: { uri: "fixture://birth", contentHash: "hash.fixture", byteRange: [0, 24], forceClass: "direct_evidence", epistemicState: "promoted" },
    features: [],
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}
