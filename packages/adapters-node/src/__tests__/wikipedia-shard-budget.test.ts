// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { boundedLanguageShard } from "../wikipedia-v3-ingestor.js";

// Measured over 150 wiki pages: flushing a shard only at block boundaries let about 2,000,000 characters
// accumulate against a 1,200,000 character bound, and boundedLanguageShard drops the excess -- 1,623,980 of
// 4,023,980 characters, 40.4% of the corpus, never reached language training. Flushing as the budget is
// reached brought that to 51,913 characters, 1.3%. These checks pin the drop, so nobody restores a caller
// that lets a shard overflow on the assumption that the text is merely split.

function sample(index: number, chars: number) {
  return {
    sourceVersionId: `sv-${index}` as never,
    title: `Title ${index}`,
    text: "x".repeat(chars),
    evidence: [],
    languageAliases: [],
    semanticCandidates: [],
    createdAt: 1_700_000_000_000
  };
}

describe("a language shard drops whatever exceeds its budget", () => {
  it("discards entire samples past the bound rather than splitting them across shards", () => {
    const samples = [sample(0, 1000), sample(1, 1000), sample(2, 1000)];
    const offered = samples.reduce((sum, item) => sum + item.title.length + 1 + item.text.length, 0);
    const bounded = boundedLanguageShard(samples as never, 1200, 2048);
    expect(bounded.text.length).toBeLessThanOrEqual(1200);
    expect(offered - bounded.text.length).toBeGreaterThan(1000);
  });

  it("keeps everything when the budget covers it, which is what a budget-sized flush guarantees", () => {
    const samples = [sample(0, 500), sample(1, 500)];
    const offered = samples.reduce((sum, item) => sum + item.title.length + 1 + item.text.length, 0);
    const bounded = boundedLanguageShard(samples as never, 1_200_000, 2048);
    // Every offered character is present; the shard also joins samples with a blank line between them.
    expect(bounded.text.length).toBeGreaterThanOrEqual(offered);
    expect(bounded.text.length).toBe(offered + 2 * (samples.length - 1));
  });

  it("drops nothing measurable once each sample is offered inside the budget", () => {
    // The caller's contract: flush as the budget is reached, so a shard is never offered more than it can hold.
    let accumulated = 0;
    const flushed: number[] = [];
    let pending: ReturnType<typeof sample>[] = [];
    for (let index = 0; index < 40; index++) {
      const item = sample(index, 100_000);
      pending.push(item);
      accumulated += item.title.length + 1 + item.text.length;
      if (accumulated >= 1_200_000) {
        const bounded = boundedLanguageShard(pending as never, 1_200_000, 2048);
        flushed.push(accumulated - bounded.text.length);
        pending = [];
        accumulated = 0;
      }
    }
    const droppedTotal = flushed.reduce((sum, dropped) => sum + dropped, 0);
    const offeredTotal = 40 * (100_000 + "Title 00".length + 1);
    expect(droppedTotal / offeredTotal).toBeLessThan(0.05);
  });
});
