import { describe, expect, it, vi } from "vitest";

import { createRuntimeGraphRetrieval } from "../runtime-graph-retrieval.js";
import { createClock, createHasher } from "../primitives.js";
import type { ScceKernelDeps } from "../storage.js";
import type {
  EvidenceSpan,
  GraphEdge,
  GraphNode,
  GraphSlice,
  Hyperedge
} from "../types.js";

describe("runtime hot graph retrieval", () => {
  it("walks two resident hops and includes routed hyperedge members without exposing evidence", async () => {
    const seed = graphNode("node:clock", ["sym:clock"], ["evidence:clock"]);
    const mechanism = graphNode("node:mechanism", ["sym:mechanism"]);
    const pressure = graphNode("node:pressure", ["sym:pressure"]);
    const beyondRadius = graphNode("node:beyond", ["sym:beyond"]);
    const tide = graphNode("node:tide", ["sym:tide"]);
    const graph = graphSlice(
      [seed, mechanism, pressure, beyondRadius, tide],
      [
        graphEdge("edge:one", seed, mechanism, 0.9),
        graphEdge("edge:two", mechanism, pressure, 0.8),
        graphEdge("edge:three", pressure, beyondRadius, 0.95)
      ],
      [graphHyperedge("hyperedge:clock-tide", [seed, tide], 0.85, ["evidence:clock"])]
    );
    const evidence = evidenceSpan("evidence:clock");
    const fixture = runtimeFixture(graph, [evidence]);

    const result = await fixture.runtime.graphForText("clock", {
      sourceAnchoringRequired: false,
      residentOnly: true
    });

    expect(result.graph.nodes.map(node => String(node.id))).toEqual(expect.arrayContaining([
      "node:clock",
      "node:mechanism",
      "node:pressure",
      "node:tide"
    ]));
    expect(result.graph.nodes.map(node => String(node.id))).not.toContain("node:beyond");
    expect(result.graph.edges.map(edge => String(edge.id))).toEqual(expect.arrayContaining([
      "edge:one",
      "edge:two"
    ]));
    expect(result.graph.edges.map(edge => String(edge.id))).not.toContain("edge:three");
    expect(result.graph.hyperedges.map(edge => String(edge.id))).toContain("hyperedge:clock-tide");
    expect(result.graph.query.radius).toBe(2);
    expect(result.evidence).toEqual([]);
    expect(fixture.searchEvidence).not.toHaveBeenCalled();
    expect(fixture.getSlice).toHaveBeenCalledTimes(1);
  });

  it("enforces hard resident-query and per-node branch caps", async () => {
    const seeds = Array.from({ length: 24 }, (_, index) =>
      graphNode(`node:seed:${index}`, ["sym:clock"])
    );
    const firstHopEdgeNodes = seeds.flatMap((_, seedIndex) =>
      Array.from({ length: 8 }, (_, branchIndex) =>
        graphNode(`node:edge-hop:${seedIndex}:${branchIndex}`, [`sym:edge-hop-${seedIndex}-${branchIndex}`])
      )
    );
    const firstHopHyperNodes = seeds.flatMap((_, seedIndex) =>
      Array.from({ length: 8 }, (_, branchIndex) =>
        graphNode(`node:hyper-hop:${seedIndex}:${branchIndex}`, [`sym:hyper-hop-${seedIndex}-${branchIndex}`])
      )
    );
    const secondHopNodes = [...firstHopEdgeNodes, ...firstHopHyperNodes].map((_, index) =>
      graphNode(`node:second-hop:${index}`, [`sym:second-hop-${index}`])
    );
    const firstHopEdges = seeds.flatMap((seed, seedIndex) =>
      firstHopEdgeNodes
        .slice(seedIndex * 8, seedIndex * 8 + 8)
        .map((target, branchIndex) => graphEdge(
          `edge:first:${seedIndex}:${branchIndex}`,
          seed,
          target,
          1 - branchIndex * 0.01
        ))
    );
    const secondHopEdges = [...firstHopEdgeNodes, ...firstHopHyperNodes].map((source, index) =>
      graphEdge(`edge:second:${index}`, source, secondHopNodes[index]!, 0.9)
    );
    const hyperedges = seeds.map((seed, seedIndex) =>
      graphHyperedge(
        `hyperedge:${seedIndex}`,
        [
          seed,
          ...firstHopHyperNodes.slice(seedIndex * 8, seedIndex * 8 + 8)
        ],
        0.95
      )
    );
    const graph = graphSlice(
      [...seeds, ...firstHopEdgeNodes, ...firstHopHyperNodes, ...secondHopNodes],
      [...firstHopEdges, ...secondHopEdges],
      hyperedges
    );
    const fixture = runtimeFixture(graph);

    const result = await fixture.runtime.graphForText("clock", {
      sourceAnchoringRequired: false,
      residentOnly: true
    });

    expect(result.graph.nodes).toHaveLength(96);
    expect(result.graph.edges.length).toBeLessThanOrEqual(192);
    expect(result.graph.hyperedges.length).toBeLessThanOrEqual(48);
    const firstSeedTargets = new Set([
      ...result.graph.edges
        .filter(edge => String(edge.source) === "node:seed:0" || String(edge.target) === "node:seed:0")
        .map(edge => String(edge.source) === "node:seed:0" ? String(edge.target) : String(edge.source)),
      ...result.graph.hyperedges
        .filter(edge => edge.memberNodeIds.some(id => String(id) === "node:seed:0"))
        .flatMap(edge => edge.memberNodeIds.map(String).filter(id => id !== "node:seed:0"))
    ]);
    expect(firstSeedTargets.size).toBeLessThanOrEqual(8);
    expect(result.evidence).toEqual([]);
  });
});

function runtimeFixture(graph: GraphSlice, evidence: EvidenceSpan[] = []) {
  const getSlice = vi.fn(async () => graph);
  const getEvidenceBatch = vi.fn(async () => evidence);
  const searchEvidence = vi.fn(async () => {
    throw new Error("resident creative graph retrieval must not search evidence");
  });
  const storage = {
    graph: { getSlice },
    evidence: { getEvidenceBatch, searchEvidence }
  } as unknown as ScceKernelDeps["storage"];
  const failures: string[] = [];
  const runtime = createRuntimeGraphRetrieval({
    deps: { storage },
    clock: createClock({ fixedTime: 1_000 }),
    hasher: createHasher(),
    candidates: undefined as never,
    failures,
    cacheMs: 60_000,
    kernelTrace: () => undefined,
    sourceAnchorSemanticFramesCached: async () => []
  });
  return { runtime, failures, getSlice, getEvidenceBatch, searchEvidence };
}

function graphSlice(nodes: GraphNode[], edges: GraphEdge[], hyperedges: Hyperedge[]): GraphSlice {
  return {
    nodes,
    edges,
    hyperedges,
    bounded: true,
    query: {}
  };
}

function graphNode(id: string, features: string[], evidenceIds: string[] = []): GraphNode {
  return {
    id: id as GraphNode["id"],
    typeId: "dimension:concept" as GraphNode["typeId"],
    representation: {},
    alpha: 0.7,
    evidenceIds: evidenceIds as GraphNode["evidenceIds"],
    features,
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function graphEdge(
  id: string,
  source: GraphNode,
  target: GraphNode,
  potential: number
): GraphEdge {
  return {
    id: id as GraphEdge["id"],
    source: source.id,
    target: target.id,
    relationId: "relation:associated" as GraphEdge["relationId"],
    alpha: potential,
    weight: potential,
    temporalScope: { validFrom: 1 },
    evidenceIds: [],
    createdAt: 1,
    updatedAt: 1,
    metadata: {}
  };
}

function graphHyperedge(
  id: string,
  members: GraphNode[],
  potential: number,
  provenanceRefs: string[] = []
): Hyperedge {
  return {
    id: id as Hyperedge["id"],
    relationId: "relation:co-occurs" as Hyperedge["relationId"],
    memberNodeIds: members.map(node => node.id),
    weightVector: { alpha: potential },
    temporalScope: { validFrom: 1 },
    provenanceRefs,
    createdAt: 1,
    updatedAt: 1
  };
}

function evidenceSpan(id: string): EvidenceSpan {
  return {
    id: id as EvidenceSpan["id"],
    sourceId: "source:test" as EvidenceSpan["sourceId"],
    sourceVersionId: "source-version:test" as EvidenceSpan["sourceVersionId"],
    chunkId: "chunk:test" as EvidenceSpan["chunkId"],
    contentHash: "content:test" as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: 16,
    charStart: 0,
    charEnd: 16,
    text: "source evidence",
    textPreview: "source evidence",
    languageHints: {},
    scriptHints: {},
    trustVector: {},
    provenance: {},
    features: ["sym:clock"],
    status: "promoted",
    alpha: 0.8,
    observedAt: 1
  };
}
