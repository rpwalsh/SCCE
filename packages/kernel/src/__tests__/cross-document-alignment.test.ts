import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  compileCrossDocumentAlignmentModel,
  compileSparseAlignmentCandidateSupports,
  createHasher,
  solveSparseFusedUnbalancedTransport,
  type EvidenceId,
  type GraphNode,
  type Hyperedge,
  type NodeId,
  type SourceVersionId
} from "../index.js";

describe("cross-document canonical graph-region alignment", () => {
  const hasher = createHasher();

  it("collapses copy families and feeds projection consistency into a second solve", () => {
    const compiled = compileSparseAlignmentCandidateSupports({
      lattices: [
        lattice("doc.cross.a", "Ada built engine", "family.a", "evidence.cross.a"),
        lattice("doc.cross.a-copy", "Ada built engine", "family.a", "evidence.cross.copy"),
        lattice("doc.cross.b", "engine built by Ada", "family.b", "evidence.cross.b")
      ],
      nodes: [node("node.cross.ada", "Ada"), node("node.cross.engine", "engine")],
      hyperedges: [hyperedge()],
      maxCandidateDegree: 8,
      hasher
    });
    const firstPass = compiled.supports.map(support =>
      solveSparseFusedUnbalancedTransport({
        support,
        targetIndex: compiled.targetIndex,
        hasher
      }));
    const model = compileCrossDocumentAlignmentModel({
      supports: compiled.supports,
      plans: firstPass,
      targetIndex: compiled.targetIndex,
      hasher
    });

    expect(model.schema).toBe("scce.cross_document_alignment_consistency.v1");
    expect(model.projections).toHaveLength(3);
    expect(model.sourceFamilyIds).toEqual(["family.a", "family.b"]);
    expect(model.pairwiseDistances).toHaveLength(1);
    expect(model.estimates.length).toBeGreaterThan(0);
    expect(model.estimates.every(estimate =>
      estimate.totalFamilyCount === 2
      && Number.isFinite(estimate.incompatibilityCost)
      && Math.abs(estimate.familyCorrections.reduce(
        (sum, row) => sum + row.signedCorrection,
        0
      )) <= 1e-12)).toBe(true);
    expect(model.audit).toMatchObject({
      independentSourceFamilyCount: 2,
      copiedSourcesCollapsedByFamily: true
    });

    const corrected = compiled.supports.map(support =>
      solveSparseFusedUnbalancedTransport({
        support,
        targetIndex: compiled.targetIndex,
        crossDocumentAlignmentModel: model,
        hasher
      }));
    expect(corrected.every(plan =>
      plan.crossDocumentAlignmentModelId === model.id
      && plan.cells.every(cell => Number.isFinite(cell.crossDocumentCost))
      && plan.iterations.every(iteration =>
        Number.isFinite(iteration.crossDocument)))).toBe(true);
  });
});

function lattice(
  documentId: string,
  text: string,
  sourceFamilyId: string,
  evidenceId: string
) {
  return buildSurfaceLattice({
    documentId,
    sourceFamilyId,
    sourceVersionId: `source-version.${documentId}` as SourceVersionId,
    text,
    evidenceIds: [evidenceId as EvidenceId],
    hasher: createHasher()
  });
}

function node(id: string, representation: string): GraphNode {
  return {
    id: id as NodeId,
    typeId: "dimension.fixture" as GraphNode["typeId"],
    representation,
    alpha: 1,
    evidenceIds: [
      "evidence.cross.a" as EvidenceId,
      "evidence.cross.copy" as EvidenceId,
      "evidence.cross.b" as EvidenceId
    ],
    features: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function hyperedge(): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: "hyperedge.cross" as Hyperedge["id"],
    relationId: "relation.cross" as Hyperedge["relationId"],
    participantPorts: [
      port("port.cross.ada", "role.cross.ada", "node.cross.ada"),
      port("port.cross.engine", "role.cross.engine", "node.cross.engine")
    ],
    memberNodeIds: ["node.cross.ada" as NodeId, "node.cross.engine" as NodeId],
    qualifiers: {},
    modality: {},
    evidenceIds: [
      "evidence.cross.a" as EvidenceId,
      "evidence.cross.copy" as EvidenceId,
      "evidence.cross.b" as EvidenceId
    ],
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: ["evidence.cross.a", "evidence.cross.copy", "evidence.cross.b"],
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
    evidenceIds: [
      "evidence.cross.a" as EvidenceId,
      "evidence.cross.copy" as EvidenceId,
      "evidence.cross.b" as EvidenceId
    ]
  };
}
