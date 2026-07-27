import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  compileSparseAlignmentCandidateSupports,
  createHasher,
  sparseAlignmentCandidatesForUnit,
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
