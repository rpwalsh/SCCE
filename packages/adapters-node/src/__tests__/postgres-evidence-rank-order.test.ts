// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { evidenceRankOrder } from "../postgres.js";

const keys = (order: string) => order.split(",").map(key => key.trim());

describe("anchor-posting rank order", () => {
  it("keeps the opening-block prior ahead of the score for a request that does not quote a source sentence", () => {
    const order = keys(evidenceRankOrder({ rank: "", score: "hits.", row: "evidence.", openingBlockPrior: true }));
    const opening = order.findIndex(key => key.startsWith("opening_block"));
    const score = order.findIndex(key => key.startsWith("hits.score"));
    expect(opening).toBeGreaterThanOrEqual(0);
    expect(opening).toBeLessThan(score);
  });

  it("drops the opening-block prior when the request quotes a source sentence", () => {
    // A cloze answers wherever its sentence sits. Ranking every document opening above BM25 hid the span that
    // carried 17 of the request's 18 adjacent bigrams behind openings carrying one of them.
    const order = keys(evidenceRankOrder({ rank: "", score: "hits.", row: "evidence.", openingBlockPrior: false }));
    expect(order.some(key => key.includes("opening_block"))).toBe(false);
    expect(order[0]).toBe("title_exact DESC");
    expect(order[1]).toBe("title_match DESC");
    expect(order[2]).toBe("hits.score DESC");
  });

  it("changes nothing but the opening-block key between the two forms", () => {
    const withPrior = keys(evidenceRankOrder({ rank: "top.", score: "top.", row: "top.", openingBlockPrior: true }));
    const without = keys(evidenceRankOrder({ rank: "top.", score: "top.", row: "top.", openingBlockPrior: false }));
    expect(withPrior.filter(key => !key.includes("opening_block"))).toEqual(without);
  });
});
