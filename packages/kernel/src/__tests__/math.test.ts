import { describe, expect, it } from "vitest";
import { createAlphaLayer, createClock, createHasher, createIdFactory, personalizedPerronFrobenius } from "../index.js";
import type { GraphEdge, GraphNode } from "../types.js";

describe("SCCE math primitives", () => {
  it("uses stable content and semantic IDs", () => {
    const clock = createClock({ fixedTime: 1000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    expect(ids.sourceVersionId("abc")).toEqual(ids.sourceVersionId("abc"));
    expect(ids.sourceVersionId("abc")).not.toEqual(ids.sourceVersionId("abcd"));
    expect(ids.sourceId("local", "/a/b")).toEqual(ids.sourceId("local", "/a/b"));
    expect(ids.nodeId({ x: 1, y: 2 })).toEqual(ids.nodeId({ y: 2, x: 1 }));
  });

  it("builds alpha trace and PPF over graph evidence", () => {
    const clock = createClock({ fixedTime: 1000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const n1: GraphNode = { id: ids.nodeId("a"), typeId: ids.dimensionId("symbol"), representation: "a", alpha: 0.9, evidenceIds: [], features: ["sym:a"], createdAt: 1, updatedAt: 1, metadata: {} };
    const n2: GraphNode = { id: ids.nodeId("b"), typeId: ids.dimensionId("symbol"), representation: "b", alpha: 0.8, evidenceIds: [], features: ["sym:b"], createdAt: 1, updatedAt: 1, metadata: {} };
    const e: GraphEdge = { id: ids.edgeId({ source: n1.id, target: n2.id, relationId: ids.relationId("rel"), provenanceHash: "p" }), source: n1.id, target: n2.id, relationId: ids.relationId("rel"), alpha: 0.8, weight: 0.8, temporalScope: { validFrom: 1 }, evidenceIds: [], createdAt: 1, updatedAt: Date.now(), metadata: {} };
    const ppf = personalizedPerronFrobenius({ nodes: [n1, n2], edges: [e], personalization: [{ nodeId: n1.id, weight: 1 }] });
    const trace = createAlphaLayer().buildTrace({ nodes: [n1, n2], edges: [e], activeNodeIds: ppf.map(x => String(x.nodeId)) });
    expect(ppf[0]?.mass).toBeGreaterThan(0);
    expect(trace.relations.length).toBeGreaterThan(0);
    expect(trace.normalizedLaplacian.values.length).toBeGreaterThan(0);
  });
});
