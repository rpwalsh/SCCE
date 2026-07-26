import { describe, expect, it } from "vitest";
import {
  buildSurfaceLattice,
  compilePopulationOrderingModel,
  compileSparseAlignmentCandidateSupports,
  createHasher,
  populationOrderingExpectation,
  solveSparseFusedUnbalancedTransport,
  type EvidenceId,
  type GraphNode,
  type Hyperedge,
  type NodeId,
  type SourceVersionId
} from "../index.js";

describe("population-specific relative ordering", () => {
  const hasher = createHasher();

  it("learns opposing order distributions through one script-neutral path", () => {
    const compiled = compileSparseAlignmentCandidateSupports({
      lattices: [
        lattice("document.order.a", "Ada engine", "evidence.order.a"),
        lattice("document.order.b", "engine Ada", "evidence.order.b")
      ],
      nodes: [node("node.order.ada", "Ada"), node("node.order.engine", "engine")],
      hyperedges: [hyperedge()],
      maxCandidateDegree: 8,
      hasher
    });
    const supports = [
      {
        ...compiled.supports[0]!,
        populationPosterior: [{ populationId: "population.a", probability: 1 }]
      },
      {
        ...compiled.supports[1]!,
        populationPosterior: [{ populationId: "population.b", probability: 1 }]
      }
    ];
    const model = compilePopulationOrderingModel({ supports, hasher });
    const adaTarget = compiled.targetIndex.targets.find(target =>
      target.observableSurfaceKeys.includes("ada"))!;
    const engineTarget = compiled.targetIndex.targets.find(target =>
      target.observableSurfaceKeys.includes("engine"))!;
    const adaOrderKey = supports[0]!.candidates.find(candidate =>
      candidate.graphTargetId === adaTarget.id)!.graphOrderKey;
    const engineOrderKey = supports[0]!.candidates.find(candidate =>
      candidate.graphTargetId === engineTarget.id)!.graphOrderKey;
    const orderA = populationOrderingExpectation({
      model,
      populationPosterior: supports[0]!.populationPosterior,
      leftGraphOrderKey: adaOrderKey,
      rightGraphOrderKey: engineOrderKey
    });
    const orderB = populationOrderingExpectation({
      model,
      populationPosterior: supports[1]!.populationPosterior,
      leftGraphOrderKey: adaOrderKey,
      rightGraphOrderKey: engineOrderKey
    });

    expect(model.schema).toBe("scce.population_relative_order_model.v2");
    expect(orderA.source).toBe("population");
    expect(orderB.source).toBe("population");
    expect(orderA.location).toBeGreaterThan(0);
    expect(orderB.location).toBeLessThan(0);

    for (const support of supports) {
      const plan = solveSparseFusedUnbalancedTransport({
        support,
        targetIndex: compiled.targetIndex,
        populationOrderingModel: model,
        hasher
      });
      expect(plan.populationOrderingModelId).toBe(model.id);
      expect(plan.cells.every(cell => cell.orderingCost >= 0)).toBe(true);
      expect(plan.iterations.every(iteration =>
        Number.isFinite(iteration.ordering)
        && iteration.orderingComparisons >= 0)).toBe(true);
    }
  });
});

function lattice(documentId: string, text: string, evidenceId: string) {
  return buildSurfaceLattice({
    documentId,
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
      "evidence.order.a" as EvidenceId,
      "evidence.order.b" as EvidenceId
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
    id: "hyperedge.order" as Hyperedge["id"],
    relationId: "relation.order" as Hyperedge["relationId"],
    participantPorts: [
      port("port.order.ada", "role.order.ada", "node.order.ada"),
      port("port.order.engine", "role.order.engine", "node.order.engine")
    ],
    memberNodeIds: ["node.order.ada" as NodeId, "node.order.engine" as NodeId],
    qualifiers: {},
    modality: {},
    evidenceIds: [
      "evidence.order.a" as EvidenceId,
      "evidence.order.b" as EvidenceId
    ],
    weightVector: { alpha: 1 },
    temporalScope: {},
    provenanceRefs: ["evidence.order.a", "evidence.order.b"],
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
      "evidence.order.a" as EvidenceId,
      "evidence.order.b" as EvidenceId
    ]
  };
}
