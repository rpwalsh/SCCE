// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { realizeSourceOwnedSurface } from "../source-owned-surface.js";

describe("source-owned surface realization", () => {
  it("withholds a multi-unit derivation when no single source owns it", () => {
    expect(realizeSourceOwnedSurface({ derivations: [["alpha", "beta"]] })).toEqual({
      text: "",
      trace: [],
      unresolvedBoundaries: 1,
      status: "unresolved",
      requiredAction: "try_alternate_derivation"
    });
  });

  it("returns the exact owning construction surface instead of concatenating units", () => {
    const source = "alpha\u2003beta";
    expect(realizeSourceOwnedSurface({
      derivations: [["alpha", "beta"]],
      sources: [{
        id: "construction.1",
        lane: "reversible_construction",
        text: source,
        evidenceIds: ["evidence.1"],
        sourceVersionId: "source-version.1"
      }]
    })).toEqual({
      text: source,
      trace: [{ sourceId: "construction.1", lane: "reversible_construction", unitCount: 2 }],
      unresolvedBoundaries: 0,
      status: "preserved_source_span",
      owner: {
        sourceId: "construction.1",
        lane: "reversible_construction",
        evidenceIds: ["evidence.1"],
        sourceVersionId: "source-version.1"
      }
    });
  });

  it("preserves a complete one-unit surface byte-for-byte", () => {
    const surface = "  exact\u00a0surface  ";
    expect(realizeSourceOwnedSurface({ derivations: [[surface]] }).text).toBe(surface);
  });
});
