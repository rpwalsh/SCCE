// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createSegmentationAdjacencyQuery, SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, type SegmentationAdjacencyFactors } from "../segmentation-adjacency-factors.js";
import { decodeSegmentationAdjacencyFactors, encodeSegmentationAdjacencyFactors } from "../segmentation-adjacency-storage.js";

const limits = { maxBytes: 1024 * 1024, maxNodes: 10000, maxArcs: 10000 };
const graph = (arcs: SegmentationAdjacencyFactors["arcs"], nodeCount = 5): SegmentationAdjacencyFactors => ({ schema: SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, nodeCount, arcs });

describe("bounded ordered segmentation graph storage", () => {
  it("preserves every ordered parallel arc and Float64 energy, with identical adjacency probabilities", () => {
    const original = graph([[2, 4, 1.25], [0, 1, -0], [1, 2, 1e-323], [0, 1, 0], [1, 3, -1.5], [3, 4, 1.25], [0, 4, 9]]);
    const packed = encodeSegmentationAdjacencyFactors(original, limits.maxBytes);
    const decoded = decodeSegmentationAdjacencyFactors(packed, limits);
    expect(decoded).toEqual(original);
    original.arcs.forEach((arc, index) => expect(Object.is(decoded.arcs[index]![2], arc[2])).toBe(true));
    const bearing = new Set(original.arcs.map((_, index) => index));
    expect([...createSegmentationAdjacencyQuery(decoded, bearing).pairs()])
      .toEqual([...createSegmentationAdjacencyQuery(original, bearing).pairs()]);
    expect(encodeSegmentationAdjacencyFactors(decoded, limits.maxBytes)).toEqual(packed);
  });

  it("grows linearly without dropping alternatives or imposing a corpus-size cap", () => {
    const make = (count: number) => graph(Array.from({ length: count }, (_, index) => [index, index + 1, index % 3 / 4] as const), count + 1);
    const small = encodeSegmentationAdjacencyFactors(make(2000), limits.maxBytes);
    const largeGraph = make(4000), large = encodeSegmentationAdjacencyFactors(largeGraph, limits.maxBytes);
    expect(large.length).toBeLessThan(small.length * 2.01);
    expect(large.length).toBeLessThan(JSON.stringify(largeGraph).length / 3);
    expect(decodeSegmentationAdjacencyFactors(large, limits)).toEqual(largeGraph);
  });

  it("supports exact sparse safe-integer coordinates without allocating by node count", () => {
    const end = Number.MAX_SAFE_INTEGER - 1;
    const original = graph([[end - 1, end, 0], [0, end, -0]], end + 1);
    expect(decodeSegmentationAdjacencyFactors(encodeSegmentationAdjacencyFactors(original, 256), { maxBytes: 256, maxNodes: Number.MAX_SAFE_INTEGER, maxArcs: 2 })).toEqual(original);
    expect(decodeSegmentationAdjacencyFactors(encodeSegmentationAdjacencyFactors(graph([], 1), 32), limits)).toEqual(graph([], 1));
  });

  it("checks encoded and reconstructed budgets before allocating a graph", () => {
    const packed = encodeSegmentationAdjacencyFactors(graph([[0, 4, 0]]), 128);
    expect(() => encodeSegmentationAdjacencyFactors(graph([[0, 4, 0]]), packed.length - 1)).toThrow();
    for (const bounded of [{ ...limits, maxBytes: packed.length - 1 }, { ...limits, maxArcs: 0 }, { ...limits, maxNodes: 4 }, { ...limits, maxBytes: Infinity }]) {
      expect(() => decodeSegmentationAdjacencyFactors(packed, bounded)).toThrow();
    }
  });

  it("rejects truncated, noncanonical, ambiguous and trailing encodings", () => {
    const packed = encodeSegmentationAdjacencyFactors(graph([[0, 4, 0]]), 128);
    for (let length = 0; length < packed.length; length++) expect(() => decodeSegmentationAdjacencyFactors(packed.slice(0, length), limits)).toThrow();
    const version = packed.slice(); version[4] = 2;
    const energyRef = packed.slice(); energyRef[energyRef.length - 1] = 1;
    const nonminimal = new Uint8Array([...packed.slice(0, 5), 0x85, 0, ...packed.slice(6)]);
    const unused = encodeSegmentationAdjacencyFactors(graph([[0, 1, 0], [1, 4, 1]]), 128); unused[unused.length - 1] = 0;
    const duplicate = encodeSegmentationAdjacencyFactors(graph([[0, 1, 0], [1, 4, 1]]), 128); duplicate.set(duplicate.slice(8, 16), 16);
    for (const corrupt of [version, energyRef, nonminimal, unused, duplicate, new Uint8Array([...packed, 0])]) {
      expect(() => decodeSegmentationAdjacencyFactors(corrupt, limits)).toThrow();
    }
  });
});
