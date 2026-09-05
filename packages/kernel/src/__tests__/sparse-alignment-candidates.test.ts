// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  compileSparseAlignmentCandidateSupports,
  createHasher,
  rankEvidenceForAlignment,
  sparseAlignmentCandidatesForUnit,
  type SparseAlignmentTargetIndex,
  type EvidenceId,
  type GraphNode,
  type Hyperedge,
  type NodeId,
  type SourceVersionId
} from "../index.js";

describe("sparse typed-incidence alignment candidates", () => {
  const hasher = createHasher();

  it("builds exact, evidence, and structural support with bounded surface degree", () => {
    const lattice = buildSurfaceLattice({
      documentId: "document.ada",
      sourceVersionId: "source-version.ada" as SourceVersionId,
      text: "Ada built engine",
      evidenceIds: ["evidence.ada" as EvidenceId],
      hasher
    });
    const nodes = [
      graphNode("node.ada", "Ada"),
      graphNode("node.engine", "engine")
    ];
    const compiled = compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes,
      hyperedges: [relationHyperedge()],
      maxCandidateDegree: 3,
      hasher
    });
    const support = compiled.supports[0]!;
    const adaUnit = lattice.units.find(unit =>
      unit.surface === "Ada" && unit.proposalSources.includes("lexical"))!;
    const adaTarget = compiled.targetIndex.targets.find(target =>
      String(target.participantNodeId) === "node.ada")!;
    const candidates = sparseAlignmentCandidatesForUnit(support, adaUnit.id);
    const exact = candidates.find(candidate => candidate.graphTargetId === adaTarget.id);

    expect(exact?.supportKinds).toContain("exact_observable_anchor");
    expect(exact?.supportKinds).toContain("shared_exact_evidence");
    expect(exact?.sharedEvidenceIds).toEqual(["evidence.ada"]);
    expect(exact?.sourceCoordinates).toMatchObject({
      byteStart: 0,
      byteEnd: 3,
      codePointStart: 0,
      codePointEnd: 3
    });
    expect(candidates.some(candidate =>
      candidate.supportKinds.includes("typed_incidence_structure")
      && candidate.graphTargetKind === "relation")).toBe(true);
    expect(support.rows.every(row => row.candidateIds.length <= 3)).toBe(true);
    expect(support.candidates.length).toBeLessThanOrEqual(lattice.units.length * 3);
    expect(support.audit).toMatchObject({
      maximumObservedDegree: 3,
      candidatesOutsideSupportHaveZeroMass: true,
      denseMatrixMaterialized: false,
      memoryBound: "O(|S|*3)"
    });
  });

  it("is byte-stable under graph, hyperedge, and node ordering", () => {
    const lattice = buildSurfaceLattice({
      documentId: "document.replay",
      sourceVersionId: "source-version.replay" as SourceVersionId,
      text: "Ada built engine",
      evidenceIds: ["evidence.ada" as EvidenceId],
      hasher
    });
    const first = compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes: [graphNode("node.ada", "Ada"), graphNode("node.engine", "engine")],
      hyperedges: [relationHyperedge(), zeroArityHyperedge()],
      maxCandidateDegree: 4,
      hasher
    });
    const second = compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes: [graphNode("node.engine", "engine"), graphNode("node.ada", "Ada")],
      hyperedges: [zeroArityHyperedge(), relationHyperedge()],
      maxCandidateDegree: 4,
      hasher
    });

    expect(second.incidenceGraph.id).toBe(first.incidenceGraph.id);
    expect(second.targetIndex.id).toBe(first.targetIndex.id);
    expect(second.supports).toEqual(first.supports);
  });

  it("does not create candidates without anchor, evidence, context, or structure", () => {
    const lattice = buildSurfaceLattice({
      documentId: "document.unrelated",
      sourceVersionId: "source-version.unrelated" as SourceVersionId,
      text: "unrelated",
      evidenceIds: ["evidence.unrelated" as EvidenceId],
      hasher
    });
    const compiled = compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes: [graphNode("node.ada", "Ada")],
      hyperedges: [relationHyperedge()],
      hasher
    });

    expect(compiled.supports[0]!.candidates).toEqual([]);
    expect(compiled.supports[0]!.rows.every(row =>
      sparseAlignmentCandidatesForUnit(compiled.supports[0]!, row.surfaceUnitId).length === 0
    )).toBe(true);
  });

  // Plan item 107: candidate memory must scale O(|S|*K_Pi), not O(|S|*|G|)
  // -- grow the graph by 40x (adding target nodes/hyperedges sharing no
  // evidence or surface form with the document) while holding the lattice
  // and K_Pi fixed, and prove the candidate count and materialized-pair
  // fraction do not grow with |G|.
  it("candidate memory does not scale with graph size on a large synthetic document", () => {
    const lattice = buildSurfaceLattice({
      documentId: "document.scale",
      sourceVersionId: "source-version.scale" as SourceVersionId,
      text: "Ada built engine",
      evidenceIds: ["evidence.ada" as EvidenceId],
      hasher
    });
    const relevantNodes = [graphNode("node.ada", "Ada"), graphNode("node.engine", "engine")];
    const relevantHyperedges = [relationHyperedge()];

    const small = compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes: relevantNodes,
      hyperedges: relevantHyperedges,
      maxCandidateDegree: 4,
      hasher
    });

    const unrelatedNodeCount = 2_000;
    const unrelatedNodes = Array.from({ length: unrelatedNodeCount }, (_, index) =>
      graphNode(`node.unrelated.${index}`, `unrelated-term-${index}`));
    const unrelatedHyperedges = Array.from({ length: unrelatedNodeCount / 2 }, (_, index) =>
      unrelatedHyperedge(index, unrelatedNodes[index * 2]!.id, unrelatedNodes[index * 2 + 1]!.id));
    const large = compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes: [...relevantNodes, ...unrelatedNodes],
      hyperedges: [...relevantHyperedges, ...unrelatedHyperedges],
      maxCandidateDegree: 4,
      hasher
    });

    const smallSupport = small.supports[0]!;
    const largeSupport = large.supports[0]!;

    // |G| grew ~2000x (target index targets scale with node/hyperedge
    // count); the candidate set for the exact same document must not.
    expect(large.targetIndex.targets.length).toBeGreaterThan(small.targetIndex.targets.length * 100);
    expect(largeSupport.candidates.length).toBe(smallSupport.candidates.length);
    expect(largeSupport.candidates.length).toBeLessThanOrEqual(lattice.units.length * 4);
    expect(largeSupport.rows.every(row => row.candidateIds.length <= 4)).toBe(true);

    // The dense O(|S|*|G|) baseline the audit records for comparison must
    // grow with |G| even though the real materialized candidate set does
    // not -- proving the sparse implementation diverges from the dense
    // bound rather than secretly matching it.
    const smallAudit = smallSupport.audit as { densePairCount: number; materializedPairFraction: number };
    const largeAudit = largeSupport.audit as { densePairCount: number; materializedPairFraction: number };
    expect(largeAudit.densePairCount).toBeGreaterThan(smallAudit.densePairCount * 100);
    expect(largeAudit.materializedPairFraction).toBeLessThan(smallAudit.materializedPairFraction / 100);
  });

  it("never silently truncates exact anchors to satisfy a row-degree budget", () => {
    const lattice = buildSurfaceLattice({
      documentId: "document.duplicate-anchor",
      sourceVersionId: "source-version.duplicate-anchor" as SourceVersionId,
      text: "Ada",
      evidenceIds: ["evidence.ada" as EvidenceId],
      hasher
    });
    const duplicateNode = graphNode("node.ada.alias", "Ada");
    const hyperedge = relationHyperedge();
    hyperedge.participantPorts.push(
      port("port.ada.alias", "role.opaque.3", "node.ada.alias")
    );
    hyperedge.memberNodeIds.push(duplicateNode.id);

    expect(() => compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes: [graphNode("node.ada", "Ada"), duplicateNode],
      hyperedges: [hyperedge],
      maxCandidateDegree: 1,
      hasher
    })).toThrow(/exact alignment anchors exceed row degree/iu);
  });
});

function graphNode(id: string, representation: string): GraphNode {
  return {
    id: id as NodeId,
    typeId: "dimension.fixture" as GraphNode["typeId"],
    representation,
    alpha: 1,
    evidenceIds: ["evidence.ada" as EvidenceId],
    features: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function relationHyperedge(): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: "hyperedge.built" as Hyperedge["id"],
    relationId: "relation.built" as Hyperedge["relationId"],
    participantPorts: [
      port("port.ada", "role.opaque.1", "node.ada"),
      port("port.engine", "role.opaque.2", "node.engine")
    ],
    memberNodeIds: ["node.ada" as NodeId, "node.engine" as NodeId],
    qualifiers: {},
    modality: {},
    evidenceIds: ["evidence.ada" as EvidenceId],
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: ["evidence.ada"],
    createdAt: 1,
    updatedAt: 1
  };
}

function unrelatedHyperedge(index: number, leftNodeId: NodeId, rightNodeId: NodeId): Hyperedge {
  // Deliberately does NOT reuse the shared port() fixture helper, which
  // hardcodes evidenceIds to "evidence.ada" -- these ports need their own,
  // genuinely distinct evidence so the scaling test's unrelated graph
  // material cannot accidentally match the lattice via shared_exact_evidence.
  const evidenceId = `evidence.unrelated.${index}` as EvidenceId;
  return {
    schema: "scce.hyperedge.v2",
    id: `hyperedge.unrelated.${index}` as Hyperedge["id"],
    relationId: `relation.unrelated.${index}` as Hyperedge["relationId"],
    participantPorts: [
      {
        portId: `port.unrelated.${index}.left`,
        roleId: "role.opaque.1",
        nodeId: leftNodeId,
        valueKind: "observable.string",
        realization: "observed",
        evidenceIds: [evidenceId]
      },
      {
        portId: `port.unrelated.${index}.right`,
        roleId: "role.opaque.2",
        nodeId: rightNodeId,
        valueKind: "observable.string",
        realization: "observed",
        evidenceIds: [evidenceId]
      }
    ],
    memberNodeIds: [leftNodeId, rightNodeId],
    qualifiers: {},
    modality: {},
    evidenceIds: [evidenceId],
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: [String(evidenceId)],
    createdAt: 1,
    updatedAt: 1
  };
}

function zeroArityHyperedge(): Hyperedge {
  return {
    ...relationHyperedge(),
    id: "hyperedge.state" as Hyperedge["id"],
    relationId: "relation.state" as Hyperedge["relationId"],
    participantPorts: [],
    memberNodeIds: []
  };
}

function port(
  portId: string,
  roleId: string,
  nodeId: string
): Hyperedge["participantPorts"][number] {
  return {
    portId,
    roleId,
    nodeId: nodeId as NodeId,
    valueKind: "observable.string",
    realization: "observed",
    evidenceIds: ["evidence.ada" as EvidenceId]
  };
}

describe("alignment span selection", () => {
  it("covers a corroborated hyperedge from two source versions before spending the budget on one dense page", () => {
    const span = (id: string, sourceVersionId: string) => ({ id, sourceVersionId });
    const evidence = [span("e1", "v1"), span("e2", "v1"), span("e3", "v1"), span("e4", "v2"), span("e5", "v3")];
    const targets = [
      { hyperedgeId: "h.shared", evidenceIds: ["e1", "e4"] },
      { hyperedgeId: "h.other", evidenceIds: ["e2", "e5"] },
      { hyperedgeId: "h.dense.1", evidenceIds: ["e3", "e2"] },
      { hyperedgeId: "h.dense.2", evidenceIds: ["e3", "e1"] },
      { hyperedgeId: "h.dense.3", evidenceIds: ["e3", "e2"] }
    ];
    const index = { targets } as unknown as SparseAlignmentTargetIndex;
    const chosen = rankEvidenceForAlignment({ evidence, targetIndex: index, limit: 2 }).map(row => row.id);
    expect(new Set(chosen.map(id => evidence.find(row => row.id === id)!.sourceVersionId)).size).toBe(2);
    expect(chosen).toContain("e4");
    const four = rankEvidenceForAlignment({ evidence, targetIndex: index, limit: 4 }).map(row => row.id);
    expect(four).toEqual(expect.arrayContaining(["e1", "e4", "e2", "e5"]));
    expect(rankEvidenceForAlignment({ evidence, targetIndex: index, limit: 9 })).toHaveLength(5);
  });
});
