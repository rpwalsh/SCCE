import { describe, expect, it } from "vitest";
import {
  allocateTransportEvidence,
  buildSurfaceLattice,
  compileSparseAlignmentCandidateSupports,
  createHasher,
  solveSparseFusedUnbalancedTransport,
  type EvidenceId,
  type GraphNode,
  type Hyperedge,
  type NodeId,
  type SourceVersionId
} from "../index.js";

describe("transport evidence conservation", () => {
  const hasher = createHasher();

  it("partitions every transported cell across overlapping evidence exactly once", () => {
    const compiled = fixture();
    const support = {
      ...compiled.supports[0]!,
      candidates: compiled.supports[0]!.candidates.map(candidate => ({
        ...candidate,
        surfaceEvidenceIds: ["evidence.1", "evidence.2"],
        graphEvidenceIds: ["evidence.1", "evidence.2", "evidence.3"],
        sharedEvidenceIds: ["evidence.1", "evidence.2"]
      }))
    };
    const plan = solveSparseFusedUnbalancedTransport({
      support,
      targetIndex: compiled.targetIndex,
      hasher
    });
    const allocation = allocateTransportEvidence({ plan, support, hasher });

    expect(allocation.status).toBe("conserved");
    expect(allocation.conservationResidual).toBeLessThanOrEqual(1e-12);
    expect(allocation.totalAllocatedMass).toBeCloseTo(
      allocation.totalTransportMass,
      12
    );
    for (const cell of allocation.cells.filter(cell => cell.transportMass > 0)) {
      expect(cell.status).toBe("conserved");
      expect(cell.conditionalProbabilitySum).toBeCloseTo(1, 15);
      expect(cell.allocatedMass).toBeCloseTo(cell.transportMass, 15);
      expect(cell.shares).toHaveLength(3);
      expect(cell.shares.reduce((sum, share) =>
        sum + share.allocatedMass, 0)).toBeCloseTo(cell.transportMass, 15);
      expect(cell.shares.every(share =>
        share.allocatedMass < cell.transportMass)).toBe(true);
    }
    expect(allocation.audit).toMatchObject({
      allocationPolicyId: "scce.transport_evidence.shared_exact_bootstrap.v1",
      calibratedPosteriorClaimed: false,
      duplicatedTransportMass: false,
      unresolvedCellCount: 0
    });
  });

  it("marks positive mass without evidence unresolved instead of inventing provenance", () => {
    const compiled = fixture();
    const support = {
      ...compiled.supports[0]!,
      candidates: compiled.supports[0]!.candidates.map(candidate => ({
        ...candidate,
        surfaceEvidenceIds: [],
        graphEvidenceIds: [],
        sharedEvidenceIds: []
      }))
    };
    const plan = solveSparseFusedUnbalancedTransport({
      support,
      targetIndex: compiled.targetIndex,
      hasher
    });
    const allocation = allocateTransportEvidence({ plan, support, hasher });

    expect(allocation.status).toBe("unresolved_evidence");
    expect(allocation.unresolvedCandidateIds.length).toBeGreaterThan(0);
    expect(allocation.cells.some(cell =>
      cell.transportMass > 0
      && cell.status === "unresolved_evidence"
      && cell.shares.length === 0)).toBe(true);
  });

  function fixture() {
    const lattice = buildSurfaceLattice({
      documentId: "document.evidence-allocation",
      sourceVersionId: "source-version.evidence-allocation" as SourceVersionId,
      text: "Ada built engine",
      evidenceIds: ["evidence.1" as EvidenceId],
      hasher
    });
    return compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes: [node("node.ada", "Ada"), node("node.engine", "engine")],
      hyperedges: [hyperedge()],
      maxCandidateDegree: 4,
      hasher
    });
  }
});

function node(id: string, representation: string): GraphNode {
  return {
    id: id as NodeId,
    typeId: "dimension.fixture" as GraphNode["typeId"],
    representation,
    alpha: 1,
    evidenceIds: ["evidence.1" as EvidenceId],
    features: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function hyperedge(): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: "hyperedge.evidence-allocation" as Hyperedge["id"],
    relationId: "relation.evidence-allocation" as Hyperedge["relationId"],
    participantPorts: [
      port("port.ada", "role.opaque.1", "node.ada"),
      port("port.engine", "role.opaque.2", "node.engine")
    ],
    memberNodeIds: ["node.ada" as NodeId, "node.engine" as NodeId],
    qualifiers: {},
    modality: {},
    evidenceIds: ["evidence.1" as EvidenceId],
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: ["evidence.1"],
    createdAt: 1,
    updatedAt: 1
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
    evidenceIds: ["evidence.1" as EvidenceId]
  };
}
