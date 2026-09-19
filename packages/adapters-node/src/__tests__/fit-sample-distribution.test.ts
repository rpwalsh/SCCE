// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "@scce/kernel";
import { fitSampleSlot } from "../corpus-consolidation-run.js";

// The consolidation fit holds a bounded set of per-document statistics because they do not compress. The claim
// made for that bound was that the retained sample "spans the whole corpus rather than the first N read". That
// claim was asserted and not demonstrated, so this demonstrates it -- or fails.
//
// The selection is Algorithm R with the uniform draw replaced by a hash of the document id, so the same corpus
// read in the same order retains the same documents and replay holds.

const hasher = createHasher();

/** The retained set after streaming `total` documents into a reservoir of `size`, exactly as the pass does. */
function retainedPositions(total: number, size: number): number[] {
  const reservoir: number[] = [];
  for (let position = 0; position < total; position += 1) {
    const considered = position + 1;
    if (reservoir.length < size) {
      reservoir.push(position);
      continue;
    }
    const slot = fitSampleSlot(`document-${position}`, considered, hasher);
    if (slot < size) reservoir[slot] = position;
  }
  return reservoir;
}

describe("the consolidation fit sample", () => {
  it("keeps everything when the corpus is smaller than the sample", () => {
    expect(retainedPositions(120, 500).length).toBe(120);
  });

  it("keeps exactly the sample size once the corpus is larger", () => {
    expect(retainedPositions(10_000, 500).length).toBe(500);
  });

  it("spans the whole stream instead of favouring its start", () => {
    // THE CLAIM. If the draw were degenerate the reservoir would still hold the first 500 documents, and a
    // consolidation of a growing corpus would never see anything ingested after the first batch.
    const total = 10_000;
    const size = 500;
    const retained = retainedPositions(total, size);
    const deciles = new Array(10).fill(0);
    for (const position of retained) deciles[Math.floor((position / total) * 10)] += 1;

    // Every tenth of the corpus is represented.
    for (const count of deciles) expect(count).toBeGreaterThan(0);
    // And no tenth dominates: uniform would be 50 per decile, so this fails loudly on a start-biased draw
    // (which would put all 500 in the first decile) without demanding a perfectly flat histogram.
    for (const count of deciles) expect(count).toBeLessThan(size / 2);
    // The last decile is represented at all, which is the property a later consolidation depends on.
    expect(deciles[9]).toBeGreaterThan(0);
  });

  it("draws the same sample twice, because replay depends on it", () => {
    expect(retainedPositions(5_000, 250)).toEqual(retainedPositions(5_000, 250));
  });

  it("never returns a slot outside the stream considered so far", () => {
    for (const considered of [1, 2, 17, 999, 100_000]) {
      for (let index = 0; index < 50; index += 1) {
        const slot = fitSampleSlot(`document-${index}`, considered, hasher);
        expect(slot).toBeGreaterThanOrEqual(0);
        expect(slot).toBeLessThan(considered);
      }
    }
  });
});
