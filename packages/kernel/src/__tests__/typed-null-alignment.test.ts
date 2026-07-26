import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  compileSparseAlignmentCandidateSupports,
  compileTypedNullCostModel,
  createHasher,
  solveSparseFusedUnbalancedTransport,
  type EvidenceId,
  type GraphNode,
  type Hyperedge,
  type NodeId,
  type SourceVersionId
} from "../index.js";

describe("typed null and implicit alignment", () => {
  const hasher = createHasher();

  it("learns typed dustbin costs and accounts for every surface and graph marginal", () => {
    const lattice = buildSurfaceLattice({
      documentId: "document.typed-null",
      sourceVersionId: "source-version.typed-null" as SourceVersionId,
      text: "Ada,",
      evidenceIds: ["evidence.typed-null" as EvidenceId],
      hasher
    });
    const compiled = compileSparseAlignmentCandidateSupports({
      lattices: [lattice],
      nodes: [node()],
      hyperedges: [hyperedge()],
      maxCandidateDegree: 8,
      hasher
    });
    const model = compileTypedNullCostModel({
      supports: compiled.supports,
      targetIndex: compiled.targetIndex,
      hasher
    });
    const plan = solveSparseFusedUnbalancedTransport({
      support: compiled.supports[0]!,
      targetIndex: compiled.targetIndex,
      typedNullCostModel: model,
      hasher
    });

    expect(model.schema).toBe("scce.typed_null_alignment_cost_model.v1");
    expect(model.calibrated).toBe(false);
    expect(plan.typedNullCostModelId).toBe(model.id);
    expect(plan.rowMarginals).toHaveLength(lattice.units.length);
    expect(plan.columnMarginals).toHaveLength(compiled.targetIndex.targets.length);

    for (const row of plan.rowMarginals) {
      expect(
        row.transportedMass + row.surfaceNullMass - row.overflowMass
      ).toBeCloseTo(row.targetMass, 11);
      expect(row.nullCost).toBeGreaterThan(0);
    }
    for (const column of plan.columnMarginals) {
      expect(
        column.transportedMass + column.graphImplicitMass - column.overflowMass
      ).toBeCloseTo(column.targetMass, 11);
      expect(column.implicitCost).toBeGreaterThan(0);
    }

    const omittedTarget = compiled.targetIndex.targets.find(target =>
      target.realization === "omitted")!;
    const omitted = plan.columnMarginals.find(column =>
      column.graphTargetId === omittedTarget.id)!;
    const observedTarget = compiled.targetIndex.targets.find(target =>
      target.realization === "observed")!;
    const observed = plan.columnMarginals.find(column =>
      column.graphTargetId === observedTarget.id)!;
    expect(omitted.implicitType).toBe("omitted_participant");
    expect(omitted.implicitCost).toBeLessThan(observed.implicitCost);
    expect(omitted.graphImplicitMass).toBeGreaterThan(0);
    expect(plan.audit).toMatchObject({
      typedNullCostModelId: model.id,
      typedNullCostModelCalibrated: false
    });
  });
});

function node(): GraphNode {
  return {
    id: "node.ada.typed-null" as NodeId,
    typeId: "dimension.fixture" as GraphNode["typeId"],
    representation: "Ada",
    alpha: 1,
    evidenceIds: ["evidence.typed-null" as EvidenceId],
    features: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function hyperedge(): Hyperedge {
  return {
    schema: "scce.hyperedge.v2",
    id: "hyperedge.typed-null" as Hyperedge["id"],
    relationId: "relation.typed-null" as Hyperedge["relationId"],
    participantPorts: [
      {
        portId: "port.observed",
        roleId: "role.opaque.observed",
        nodeId: "node.ada.typed-null" as NodeId,
        valueKind: "observable.string",
        realization: "observed",
        evidenceIds: ["evidence.typed-null" as EvidenceId]
      },
      {
        portId: "port.omitted",
        roleId: "role.opaque.omitted",
        nodeId: null,
        valueKind: "observable.string",
        realization: "omitted",
        evidenceIds: ["evidence.typed-null" as EvidenceId]
      }
    ],
    memberNodeIds: ["node.ada.typed-null" as NodeId],
    qualifiers: {},
    modality: {},
    evidenceIds: ["evidence.typed-null" as EvidenceId],
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: ["evidence.typed-null"],
    createdAt: 1,
    updatedAt: 1
  };
}
