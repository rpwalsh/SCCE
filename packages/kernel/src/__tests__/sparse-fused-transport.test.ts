import { describe, expect, it } from "vitest";
import {
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

describe("sparse fused unbalanced graph-surface transport", () => {
  const hasher = createHasher();

  it("moves mass only on candidate support and reserves exact-anchor row mass", () => {
    const compiled = fixture();
    const support = compiled.supports[0]!;
    const plan = solveSparseFusedUnbalancedTransport({
      support,
      targetIndex: compiled.targetIndex,
      budget: {
        maxOuterIterations: 4,
        maxSinkhornIterations: 64,
        maxStructuralComparisons: 100_000
      },
      hasher
    });
    const candidateIds = new Set(support.candidates.map(candidate => candidate.id));
    const exactRows = new Set(support.candidates
      .filter(candidate => candidate.supportKinds.includes("exact_observable_anchor"))
      .map(candidate => candidate.surfaceUnitId));

    expect(plan.schema).toBe("scce.sparse_fused_unbalanced_transport.v1");
    expect(plan.globalOptimalityClaimed).toBe(false);
    expect(plan.cells.every(cell =>
      candidateIds.has(cell.candidateId)
      && Number.isFinite(cell.mass)
      && cell.mass >= 0)).toBe(true);
    expect(plan.cells).toHaveLength(support.candidates.length);
    for (const rowId of exactRows) {
      const target = plan.rowMarginals.find(row => row.surfaceUnitId === rowId)!;
      const exactMass = plan.cells.filter(cell =>
        cell.surfaceUnitId === rowId && cell.exactAnchor)
        .reduce((sum, cell) => sum + cell.mass, 0);
      expect(exactMass + 1e-12).toBeGreaterThanOrEqual(
        target.targetMass * plan.objective.exactAnchorRowMassFloor
      );
    }
    expect(plan.iterations.length).toBeGreaterThan(0);
    expect(plan.iterations.every(iteration =>
      Number.isFinite(iteration.objective)
      && Number.isFinite(iteration.surfaceMarginalResidual)
      && Number.isFinite(iteration.graphMarginalResidual))).toBe(true);
    expect(plan.audit).toMatchObject({
      cellsOutsideCandidateSupport: 0,
      denseMatrixMaterialized: false,
      localStructuralApproximation: true,
      globalOptimalityClaimed: false
    });
  });

  it("is deterministic and records bounded-work termination", () => {
    const compiled = fixture();
    const solve = () => solveSparseFusedUnbalancedTransport({
      support: compiled.supports[0]!,
      targetIndex: compiled.targetIndex,
      budget: {
        maxOuterIterations: 1,
        maxSinkhornIterations: 3,
        maxStructuralNeighbors: 2,
        maxStructuralComparisons: 1_000
      },
      hasher
    });
    const first = solve();
    const second = solve();

    expect(first).toEqual(second);
    expect(first.status).toBe("iteration_budget_exhausted");
    expect(first.iterations).toHaveLength(1);
    expect(first.iterations[0]!.sinkhornIterations).toBeLessThanOrEqual(3);
    expect(first.iterations[0]!.structuralComparisons).toBeLessThanOrEqual(1_000);
  });

  function fixture() {
    const lattice = buildSurfaceLattice({
      documentId: "document.transport",
      sourceVersionId: "source-version.transport" as SourceVersionId,
      text: "Ada built engine",
      evidenceIds: ["evidence.transport" as EvidenceId],
      hasher
    });
    return compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes: [
        node("node.ada", "Ada"),
        node("node.engine", "engine")
      ],
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
    evidenceIds: ["evidence.transport" as EvidenceId],
    features: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function hyperedge(): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: "hyperedge.transport" as Hyperedge["id"],
    relationId: "relation.transport" as Hyperedge["relationId"],
    participantPorts: [
      port("port.ada", "role.opaque.1", "node.ada"),
      port("port.engine", "role.opaque.2", "node.engine")
    ],
    memberNodeIds: ["node.ada" as NodeId, "node.engine" as NodeId],
    qualifiers: {},
    modality: {},
    evidenceIds: ["evidence.transport" as EvidenceId],
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: ["evidence.transport"],
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
    evidenceIds: ["evidence.transport" as EvidenceId]
  };
}
