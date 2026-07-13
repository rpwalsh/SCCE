import { describe, expect, it } from "vitest";
import { createIdFactory } from "../ids.js";
import { createTypedTemporalWalkEngine, powerWalkTransitionProbability, type PowerWalkParams } from "../powerwalk.js";
import { createClock, createHasher } from "../primitives.js";
import type { GraphEdge, GraphNode } from "../types.js";

describe("typed temporal second-order walk contract", () => {
  const clock = createClock({ fixedTime: 1_000, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "powerwalk-contract" });
  const typeId = ids.dimensionId("opaque-node-type");
  const relationId = ids.relationId("opaque-relation");
  const a = node("a");
  const b = node("b");
  const c = node("c");
  const ab = edge(a, b, 1_000);
  const bc = edge(b, c, 1_000);
  const ba = edge(b, a, 1_000);

  it("uses true p/q return, neighbor, and outward biases", () => {
    const params: PowerWalkParams = {
      p: new Map([[`${typeId}->${typeId}`, 2]]),
      q: new Map([[`${typeId}->${typeId}`, 4]]),
      lambda: new Map([[`${typeId}->${typeId}`, 0]]),
      epsilon: 0.01
    };
    const returned = powerWalkTransitionProbability({ previous: a, current: b, candidate: a, edge: ba, allEdges: [ab, bc, ba], params, now: 1_000 });
    const neighboring = powerWalkTransitionProbability({ previous: a, current: b, candidate: c, edge: bc, allEdges: [ab, bc, ba, edge(a, c, 1_000)], params, now: 1_000 });
    const outward = powerWalkTransitionProbability({ previous: a, current: b, candidate: c, edge: bc, allEdges: [ab, bc, ba], params, now: 1_000 });
    expect(returned.distance).toBe(0);
    expect(returned.bias).toBe(0.5);
    expect(neighboring.distance).toBe(1);
    expect(neighboring.bias).toBe(1);
    expect(outward.distance).toBe(2);
    expect(outward.bias).toBe(0.25);
  });

  it("uses an injected time and deterministic seed for multiple walks per node", () => {
    const engine = createTypedTemporalWalkEngine({ hasher });
    const params: PowerWalkParams = {
      p: new Map([[`${typeId}->${typeId}`, 1]]),
      q: new Map([[`${typeId}->${typeId}`, 1]]),
      lambda: new Map([[`${typeId}->${typeId}`, Math.log(2)]]),
      epsilon: 0.01
    };
    const first = engine.run([a, b, c], [ab, bc, ba], params, { now: 1_000, seed: "sealed-seed", walksPerNode: 3 });
    const replay = engine.run([a, b, c], [ab, bc, ba], params, { now: 1_000, seed: "sealed-seed", walksPerNode: 3 });
    expect(first.walks).toHaveLength(9);
    expect(replay.walks).toEqual(first.walks);
    expect(replay.transitionAudit).toEqual(first.transitionAudit);
    expect(replay.embeddings).toEqual(first.embeddings);
    expect(first.representation.method).toBe("positive_pointwise_mutual_information_with_seeded_sparse_projection");
    expect(first.cooccurrenceState.totalCount).toBeGreaterThan(0);
    expect(first.typePairWalkLengths[0]?.boundKind).toBe("exploration_heuristic");
    expect(first.typePairWalkLengths[0]?.rationale).toBe("bound_assumptions_not_established");
    expect(first.typePairWalkLengths[0]?.spectralGap).toBe(0);

    const fresh = powerWalkTransitionProbability({ current: a, candidate: b, edge: ab, allEdges: [ab], params, now: 1_000 });
    const oneDayOld = powerWalkTransitionProbability({ current: a, candidate: b, edge: ab, allEdges: [ab], params, now: 1_000 + 86_400_000 });
    expect(oneDayOld.decay).toBeCloseTo(fresh.decay / 2);
  });

  it("stops instead of taking an impossible zero-mass transition", () => {
    const engine = createTypedTemporalWalkEngine({ hasher });
    const zero = { ...ab, weight: 0 };
    const result = engine.run([a, b], [zero], undefined, { now: 1_000, seed: "zero-mass", walksPerNode: 1 });

    expect(result.walks).toEqual([[a.id], [b.id]].sort((left, right) => String(left[0]).localeCompare(String(right[0]))));
    expect(result.transitionAudit).toContainEqual(expect.objectContaining({ from: a.id, to: b.id, probability: 0, selected: false }));
  });

  it("is invariant to database row order for the same graph and seed", () => {
    const engine = createTypedTemporalWalkEngine({ hasher });
    const ac = edge(a, c, 1_000);
    const first = engine.run([a, b, c], [ab, ac, ba], undefined, { now: 1_000, seed: "row-order", walksPerNode: 2 });
    const reordered = engine.run([c, a, b], [ba, ac, ab], undefined, { now: 1_000, seed: "row-order", walksPerNode: 2 });

    expect(reordered.walks).toEqual(first.walks);
    expect(reordered.transitionAudit).toEqual(first.transitionAudit);
    expect(reordered.embeddings).toEqual(first.embeddings);
  });

  it("rejects invalid transition measures", () => {
    const engine = createTypedTemporalWalkEngine({ hasher });
    expect(() => engine.run([a, b], [{ ...ab, weight: Number.NaN }], undefined, { now: 1_000 })).toThrow("must be finite and non-negative");
  });

  function node(label: string): GraphNode {
    return { id: ids.nodeId(label), typeId, representation: label, alpha: 1, evidenceIds: [], features: [label], createdAt: 1_000, updatedAt: 1_000, metadata: {} };
  }

  function edge(source: GraphNode, target: GraphNode, updatedAt: number): GraphEdge {
    return {
      id: ids.edgeId({ source: source.id, target: target.id, relationId, provenanceHash: `${source.id}:${target.id}` }),
      source: source.id,
      target: target.id,
      relationId,
      alpha: 1,
      weight: 1,
      temporalScope: { validFrom: updatedAt },
      evidenceIds: [],
      createdAt: updatedAt,
      updatedAt,
      metadata: {}
    };
  }
});
