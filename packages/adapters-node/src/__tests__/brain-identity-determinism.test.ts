// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { canonicalStringify, createHasher } from "@scce/kernel";

/**
 * Plan item 244. A brain's identity must be a function of what was ingested, not of the order the ingest happened to
 * assemble its own summary in. Two workers finishing in a different order produce the same counts written in a
 * different key order; canonical serialization is what makes those hash identically, and `JSON.stringify` is what
 * silently would not.
 */
const brainVersion = (seed: Record<string, unknown>): string =>
  `wikipedia:${createHasher().digestHex(canonicalStringify(seed)).slice(0, 32)}`;

describe("brain identity is canonical, not insertion-ordered", () => {
  it("hashes identically when the same counts are assembled in a different order", () => {
    const first = brainVersion({
      rootUri: "wikipedia://enwiki", dumpPath: "/dump.xml", indexPath: null,
      resumedFromOffset: 0, lastCheckpointOffset: 4096,
      pages: 120, evidence: 8_566, graphNodes: 4_201, graphEdges: 9_912,
      languageUnits: 512, languagePatterns: 64, ngramModels: 6,
      stoppedByHeapSafetyBound: false, stoppedByOwner: false, stopReason: null
    });
    // The same run, its summary object assembled by workers that finished in the opposite order.
    const second = brainVersion({
      stopReason: null, stoppedByOwner: false, stoppedByHeapSafetyBound: false,
      ngramModels: 6, languagePatterns: 64, languageUnits: 512,
      graphEdges: 9_912, graphNodes: 4_201, evidence: 8_566, pages: 120,
      lastCheckpointOffset: 4096, resumedFromOffset: 0,
      indexPath: null, dumpPath: "/dump.xml", rootUri: "wikipedia://enwiki"
    });

    expect(second).toBe(first);
  });

  it("changes when the ingest genuinely differs, so identity still means something", () => {
    const base = { rootUri: "wikipedia://enwiki", pages: 120, evidence: 8_566 };
    expect(brainVersion({ ...base, evidence: 8_567 })).not.toBe(brainVersion(base));
    expect(brainVersion({ ...base, pages: 121 })).not.toBe(brainVersion(base));
  });

  it("is not stable under JSON.stringify, which is why the ingestor no longer uses it", () => {
    const hasher = createHasher();
    const forward = hasher.digestHex(JSON.stringify({ pages: 1, evidence: 2 }));
    const reordered = hasher.digestHex(JSON.stringify({ evidence: 2, pages: 1 }));
    expect(reordered).not.toBe(forward);
  });
});
