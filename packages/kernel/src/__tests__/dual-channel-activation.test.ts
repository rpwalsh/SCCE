import { describe, expect, it } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { computeDualChannelActivation, rankWithReservations } from "../dual-channel-activation.js";
import type { RelationTransitionPolicy } from "../ppf.js";
import type { GraphEdge, GraphNode, NodeId, RelationId } from "../types.js";

const SHARED_IDS = createIdFactory({ clock: createClock({ fixedTime: 1_000, stepMs: 1 }), hasher: createHasher(), deterministicReplay: true });

function graphNodes(nodeCount: number): GraphNode[] {
  return Array.from({ length: nodeCount }, (_, index): GraphNode => ({
    id: SHARED_IDS.nodeId(`node:${index}`),
    typeId: SHARED_IDS.dimensionId("test.node"),
    representation: `node:${index}`,
    alpha: 1,
    evidenceIds: [],
    features: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    metadata: {}
  }));
}

/** `label` keeps relation ids distinct across independently-built edge sets sharing one id factory (e.g. a "positive" set and a "contradiction" set) even when their edge shapes otherwise coincide. */
function graphEdges(nodes: readonly GraphNode[], label: string, rawEdges: Array<[number, number, number]>): {
  edges: GraphEdge[];
  relations: RelationId[];
} {
  const relations = rawEdges.map((_, index) => SHARED_IDS.relationId(`relation:${label}:${index}`));
  const edges = rawEdges.map(([source, target, weight], index): GraphEdge => ({
    id: SHARED_IDS.edgeId({ source: nodes[source]!.id, target: nodes[target]!.id, relationId: relations[index]!, provenanceHash: `edge:${label}:${index}` }),
    source: nodes[source]!.id,
    target: nodes[target]!.id,
    relationId: relations[index]!,
    alpha: 1,
    weight,
    temporalScope: { validFrom: 0 },
    evidenceIds: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    metadata: {}
  }));
  return { edges, relations };
}

function directedPolicies(relations: readonly RelationId[]): RelationTransitionPolicy[] {
  return relations.map(relationId => ({ relationId, direction: "directed" }));
}

describe("dual-channel activation (plan item 150): no signed-mass cancellation", () => {
  it("computes positive and contradiction mass as two entirely independent channels", () => {
    const nodes = graphNodes(3);
    const positive = graphEdges(nodes, "positive", [[0, 1, 1]]);
    const contradiction = graphEdges(nodes, "contradiction", [[0, 2, 1]]);
    const relationPolicies = [...directedPolicies(positive.relations), ...directedPolicies(contradiction.relations)];

    const result = computeDualChannelActivation({
      nodes,
      positiveEdges: positive.edges,
      contradictionEdges: contradiction.edges,
      personalization: [{ nodeId: nodes[0]!.id, weight: 1 }],
      relationPolicies
    });

    // Node 1 only receives positive mass; node 2 only receives
    // contradiction mass -- the two channels never leak into each other,
    // and neither is ever netted against the other into one scalar.
    expect(result.positiveMass.get(String(nodes[1]!.id))).toBeGreaterThan(0);
    expect(result.contradictionMass.get(String(nodes[1]!.id)) ?? 0).toBe(0);
    expect(result.contradictionMass.get(String(nodes[2]!.id))).toBeGreaterThan(0);
    expect(result.positiveMass.get(String(nodes[2]!.id)) ?? 0).toBe(0);
  });
});

describe("reservation constraints protect exact anchors, obligations, and contradictions (plan item 151)", () => {
  it("a node with real contradiction mass is reserved even with zero positive mass", () => {
    const nodes = graphNodes(2);
    const result = {
      positiveMass: new Map([[String(nodes[0]!.id), 0.9]]),
      contradictionMass: new Map([[String(nodes[1]!.id), 0.1]])
    };
    const ranked = rankWithReservations(result, { budget: 1 });
    const contradictoryNode = ranked.find(node => node.nodeId === String(nodes[1]!.id));
    expect(contradictoryNode).toBeDefined();
    expect(contradictoryNode?.reserved).toBe(true);
    expect(contradictoryNode?.reservationReasons).toContain("real_contradiction_mass");
  });

  it("exact anchors and open obligations are reserved regardless of positive mass", () => {
    const nodes = graphNodes(3);
    const result = {
      positiveMass: new Map([
        [String(nodes[0]!.id), 0.9],
        [String(nodes[1]!.id), 0.01],
        [String(nodes[2]!.id), 0.01]
      ]),
      contradictionMass: new Map<string, number>()
    };
    const ranked = rankWithReservations(result, {
      budget: 1,
      exactAnchorIds: [String(nodes[1]!.id)],
      obligationIds: [String(nodes[2]!.id)]
    });
    expect(ranked.map(node => node.nodeId)).toContain(String(nodes[1]!.id));
    expect(ranked.map(node => node.nodeId)).toContain(String(nodes[2]!.id));
  });
});

describe("adversarial: high-frequency fluent structures cannot wash out a low-frequency contradictory fact (plan item 152)", () => {
  it("a low-positive-mass contradictory node survives a tight budget dominated by high-positive-mass fluent nodes", () => {
    // Ten "fluent" nodes with high positive mass (simulating a
    // high-frequency, structurally-favored cluster) and one node with
    // trivial positive mass but real, nonzero contradiction mass (a rare
    // but genuine contradictory fact). A naive top-3-by-positive-mass cut
    // would exclude the contradictory node entirely.
    const fluentEntries: Array<[string, number]> = Array.from({ length: 10 }, (_, index) => [`fluent.${index}`, 0.9 - index * 0.01]);
    const positiveMass = new Map(fluentEntries);
    positiveMass.set("contradictory.fact", 0.001);
    const contradictionMass = new Map([["contradictory.fact", 0.35]]);

    const ranked = rankWithReservations(
      { positiveMass, contradictionMass },
      { budget: 3 }
    );

    const contradictoryNode = ranked.find(node => node.nodeId === "contradictory.fact");
    expect(contradictoryNode).toBeDefined();
    expect(contradictoryNode?.reserved).toBe(true);
    // The naive top-3 by positive mass alone would have been exactly the
    // three highest-scoring fluent nodes -- confirm the contradictory
    // fact's presence is due to reservation, not it accidentally ranking
    // in the top 3 on positive mass alone.
    const positiveOnlyTop3 = [...positiveMass.entries()]
      .sort((left, right) => right[1] - left[1])
      .slice(0, 3)
      .map(([nodeId]) => nodeId);
    expect(positiveOnlyTop3).not.toContain("contradictory.fact");
    expect(ranked.map(node => node.nodeId)).toContain("contradictory.fact");
  });
});
