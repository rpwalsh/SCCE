import { describe, expect, it } from "vitest";
import { createAlphaLayer, relationStrength } from "../alpha.js";
import type { GraphEdge, GraphNode } from "../types.js";

describe("alpha relation normalization", () => {
  it("derives order-invariant empirical quantile thresholds from active relation strengths", () => {
    const fixture = graphFixture([0.18, 0.34, 0.51, 0.72, 0.93]);
    const layer = createAlphaLayer();
    const forward = layer.buildTrace({ ...fixture, activeNodeIds: fixture.nodes.map(node => String(node.id)), now: 1_000 });
    const reversed = layer.buildTrace({ ...fixture, edges: [...fixture.edges].reverse(), activeNodeIds: fixture.nodes.map(node => String(node.id)), now: 1_000 });

    expect(forward.normalization).toEqual({
      schema: "scce.alpha_normalization.v1",
      mode: "empirical_quantiles",
      method: "hyndman_fan_type_7",
      configuredAlpha: null,
      quantileProbabilities: [0.2, 0.4, 0.6, 0.8],
      sample: expect.objectContaining({ count: 5, uniqueCount: 5 })
    });
    expect(forward.thresholds).toEqual(reversed.thresholds);
    expect(forward.alpha).toBe(forward.thresholds.visible);
    expect(forward.normalization).toEqual(reversed.normalization);
    expect(relationStates(forward)).toEqual(relationStates(reversed));
  });

  it("reports empty and degenerate samples without pretending they were calibrated", () => {
    const empty = createAlphaLayer().buildTrace({ nodes: [], edges: [], activeNodeIds: [], now: 1_000 });
    expect(empty.normalization).toEqual({
      schema: "scce.alpha_normalization.v1",
      mode: "empty_sample",
      method: "neutral_empty_sample_fallback",
      configuredAlpha: null,
      quantileProbabilities: null,
      sample: { count: 0, uniqueCount: 0, minimum: null, median: null, maximum: null }
    });
    expect(empty.thresholds).toEqual({ virtual: 0.2, visible: 0.4, bonded: 0.6, structural: 0.8 });
    expect(empty.relations).toEqual([]);

    const fixture = graphFixture([0.5, 0.5, 0.5]);
    const degenerate = createAlphaLayer().buildTrace({ ...fixture, activeNodeIds: fixture.nodes.map(node => String(node.id)), now: 1_000 });
    expect(degenerate.normalization?.mode).toBe("degenerate_sample");
    expect(degenerate.normalization?.method).toBe("degenerate_anchor_interpolation");
    expect(degenerate.normalization?.sample).toEqual(expect.objectContaining({ count: 3, uniqueCount: 1 }));
    expect(degenerate.alpha).toBe(degenerate.normalization?.sample.median);
    expect(degenerate.relations).toHaveLength(3);
    expect(degenerate.relations.every(relation => relation.state === "visible")).toBe(true);

    const zeroFixture = graphFixture([0]);
    const zero = createAlphaLayer().buildTrace({ ...zeroFixture, activeNodeIds: zeroFixture.nodes.map(node => String(node.id)), now: 1_000 });
    expect(zero.normalization?.mode).toBe("degenerate_sample");
    expect(zero.alpha).toBe(0);
    expect(zero.relations).toEqual([]);
  });

  it("strictly validates and traces an explicitly configured alpha", () => {
    const fixture = graphFixture([0.2, 0.5, 0.9]);
    const trace = createAlphaLayer({ alpha: 0.25 }).buildTrace({
      ...fixture,
      activeNodeIds: fixture.nodes.map(node => String(node.id)),
      now: 1_000
    });

    expect(trace.alpha).toBe(0.25);
    expect(trace.thresholds).toEqual({ virtual: 0.0625, visible: 0.25, bonded: 0.5, structural: 0.9375 });
    expect(trace.normalization).toEqual({
      schema: "scce.alpha_normalization.v1",
      mode: "configured",
      method: "configured_legacy_threshold_transform",
      configuredAlpha: 0.25,
      quantileProbabilities: null,
      sample: expect.objectContaining({ count: 3, uniqueCount: 3 })
    });

    for (const alpha of [Number.NaN, Number.POSITIVE_INFINITY, 0, 1, -0.1, 0.6]) {
      expect(() => createAlphaLayer({ alpha })).toThrow(RangeError);
    }
  });

  it("uses a dimension-normalized interaction instead of a collapsing raw product", () => {
    const balanced = relationStrength({
      compatibility: 0.5,
      provenance: 0.5,
      temporalFit: 0.5,
      modalityAgreement: 0.5,
      recurrence: 0.5,
      utility: 0.5,
      contradictionPenalty: 0
    });
    expect(balanced).toBeCloseTo(0.5, 12);
    expect(balanced).not.toBeCloseTo(0.5 ** 6, 12);

    expect(relationStrength({
      compatibility: 0.5,
      provenance: 0.5,
      temporalFit: 0.5,
      modalityAgreement: 0.5,
      recurrence: 0.5,
      utility: 0.5,
      contradictionPenalty: 1
    })).toBe(0);
  });

  it("consumes edge weight and alpha once and leaves missing utility neutral", () => {
    const fixture = graphFixture([0.64]);
    fixture.edges[0]!.alpha = 0.25;
    fixture.edges[0]!.weight = 0.64;
    const trace = createAlphaLayer().buildTrace({
      ...fixture,
      activeNodeIds: fixture.nodes.map(node => String(node.id)),
      now: 1_000
    });
    const factors = trace.relations[0]?.factors;
    expect(factors).toBeDefined();
    expect(factors?.compatibility).toBe(0.64);
    expect(factors?.provenance).toBe(0.25);
    expect(factors?.utility).toBe(1);

    fixture.edges[0]!.metadata = { utility: 0.4, modalityAgreement: 0.7 };
    const explicit = createAlphaLayer().buildTrace({
      ...fixture,
      activeNodeIds: fixture.nodes.map(node => String(node.id)),
      now: 1_000
    });
    expect(explicit.relations[0]?.factors.utility).toBe(0.4);
    expect(explicit.relations[0]?.factors.modalityAgreement).toBe(0.7);
  });
});

function relationStates(trace: ReturnType<ReturnType<typeof createAlphaLayer>["buildTrace"]>): Record<string, string> {
  const entries: Array<[string, string]> = trace.relations.map(relation => [relation.id, relation.state]);
  return Object.fromEntries(entries.sort((left, right) => left[0].localeCompare(right[0])));
}

function graphFixture(strengthControls: readonly number[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = Array.from({ length: strengthControls.length + 1 }, (_, index) => ({
    id: `node:${index}` as never,
    typeId: "dimension:test" as never,
    representation: { index },
    alpha: 1,
    evidenceIds: [],
    features: [`node:${index}`],
    createdAt: 1_000,
    updatedAt: 1_000,
    metadata: {}
  }));
  const edges: GraphEdge[] = strengthControls.map((control, index) => ({
    id: `edge:${index}` as never,
    source: nodes[index]!.id,
    target: nodes[index + 1]!.id,
    relationId: `relation:${index}` as never,
    alpha: control,
    weight: control,
    temporalScope: { validFrom: 1_000 },
    evidenceIds: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    metadata: {}
  }));
  return { nodes, edges };
}
