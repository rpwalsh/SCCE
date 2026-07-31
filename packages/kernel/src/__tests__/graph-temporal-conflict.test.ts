import { describe, expect, it } from "vitest";
import { conflictingGraphEdgeIntervals, knownGraphTemporalScope, unknownGraphTemporalScope } from "../graph-temporal.js";
import type { GraphEdge } from "../types.js";

// Plan items 169-170 live wiring.
describe("conflictingGraphEdgeIntervals", () => {
  function edge(id: string, source: string, target: string, relationId: string, scope: GraphEdge["temporalScope"]): GraphEdge {
    return {
      id: id as unknown as GraphEdge["id"],
      source: source as unknown as GraphEdge["source"],
      target: target as unknown as GraphEdge["target"],
      relationId: relationId as unknown as GraphEdge["relationId"],
      alpha: 0.8,
      weight: 0.8,
      temporalScope: scope,
      evidenceIds: [],
      createdAt: 0,
      updatedAt: 0,
      metadata: {}
    };
  }

  it("reports two peer edges with genuinely overlapping bounded intervals", () => {
    const left = edge("edge.left", "node.a", "node.b", "rel.employs", knownGraphTemporalScope(0, 10));
    const right = edge("edge.right", "node.a", "node.b", "rel.employs", knownGraphTemporalScope(5, 15));
    const conflicts = conflictingGraphEdgeIntervals([left, right]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.map(row => String(row.id)).sort()).toEqual(["edge.left", "edge.right"]);
  });

  it("does not report peer edges with disjoint (before/after) intervals", () => {
    const left = edge("edge.left", "node.a", "node.b", "rel.employs", knownGraphTemporalScope(0, 5));
    const right = edge("edge.right", "node.a", "node.b", "rel.employs", knownGraphTemporalScope(10, 15));
    expect(conflictingGraphEdgeIntervals([left, right])).toEqual([]);
  });

  it("does not report edges that are not peers (different source/target/relation)", () => {
    const left = edge("edge.left", "node.a", "node.b", "rel.employs", knownGraphTemporalScope(0, 10));
    const right = edge("edge.right", "node.c", "node.d", "rel.owns", knownGraphTemporalScope(5, 15));
    expect(conflictingGraphEdgeIntervals([left, right])).toEqual([]);
  });

  it("never fabricates a closed interval for an open-ended or unknown scope", () => {
    const left = edge("edge.left", "node.a", "node.b", "rel.employs", knownGraphTemporalScope(0, 10));
    const openEnded = edge("edge.open", "node.a", "node.b", "rel.employs", knownGraphTemporalScope(5));
    const unknown = edge("edge.unknown", "node.a", "node.b", "rel.employs", unknownGraphTemporalScope());
    expect(conflictingGraphEdgeIntervals([left, openEnded, unknown])).toEqual([]);
  });
});
