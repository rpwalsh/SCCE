// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createGraphTargetGeometry } from "../graph-target-geometry.js";
import type { SparseAlignmentTarget } from "../sparse-alignment-candidates.js";

const target = (id: string, hyperedgeId: string, relationNodeId: string, kind = "participant"): SparseAlignmentTarget =>
  ({ id, kind, relationNodeId, hyperedgeId, relationId: `relation.${hyperedgeId}` }) as unknown as SparseAlignmentTarget;

describe("graph target geometry", () => {
  // A chain: e1 shares node n2 with e2, e2 shares n3 with e3, e3 shares n4 with e4.
  const targets = [
    target("t1", "e1", "n1"),
    target("t2", "e1", "n2"),
    target("t3", "e2", "n2"),
    target("t4", "e2", "n3"),
    target("t5", "e3", "n3"),
    target("t6", "e3", "n4"),
    target("t7", "e4", "n4"),
    target("t8", "e4", "n5"),
    target("t9", "far", "unrelated")
  ];

  it("keeps the short-range answers exactly as they were", () => {
    const geometry = createGraphTargetGeometry(targets);
    expect(geometry.distance(targets[0]!, targets[0]!)).toBe(0);
    // Same relation node, same role.
    expect(geometry.distance(targets[1]!, targets[2]!)).toBe(0.2);
    // Different relation nodes in one hyperedge.
    expect(geometry.distance(targets[0]!, targets[1]!)).toBe(0.25);
  });

  it("separates what the four-case lookup could not", () => {
    const geometry = createGraphTargetGeometry(targets);
    // t3 is two hops from t1 along the chain and t5 is four; both were exactly 1 under the four-case lookup,
    // which is what left the transport nothing to prefer between a near relation and an unrelated one.
    const near = geometry.distance(targets[0]!, targets[2]!);
    const far = geometry.distance(targets[0]!, targets[4]!);
    expect(near).toBeLessThan(1);
    expect(far).toBeLessThan(1);
    expect(near).toBeLessThan(far);
  });

  it("calls a pair unrelated when the walk cannot reach it", () => {
    const geometry = createGraphTargetGeometry(targets);
    expect(geometry.distance(targets[0]!, targets[8]!)).toBe(1);
  });

  it("reports what the walk did, so a degenerate metric is visible rather than assumed", () => {
    const geometry = createGraphTargetGeometry(targets);
    geometry.distance(targets[0]!, targets[2]!);
    const audit = geometry.audit();
    expect(audit.targets).toBe(targets.length);
    expect(audit.walks).toBeGreaterThan(0);
    expect(audit.resolvedBeyondOneHop).toBeGreaterThan(0);
  });

  it("is bounded by its radius rather than by the size of the graph", () => {
    const narrow = createGraphTargetGeometry(targets, 1);
    // One hop of reach: two hops along the chain is already out of sight, and says so rather than guessing.
    expect(narrow.distance(targets[0]!, targets[2]!)).toBe(1);
  });
});
