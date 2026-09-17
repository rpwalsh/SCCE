// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { evidenceAnchorRankingTail, evidenceRankOrder } from "../postgres.js";

const keys = (order: string) => order.split(",").map(key => key.trim());

const tail = (openingBlockPrior = true) => evidenceAnchorRankingTail({
  spansTable: "scce.evidence_spans",
  statusCondition: "evidence.status='promoted'",
  accessCondition: "(evidence.information_label->>'exportClass' = 'public')",
  titleMatch: "(cardinality($6::text[]) > 0 AND evidence.source_name <> '')",
  titleExact: "(cardinality($6::text[]) > 0 AND evidence.source_title = array_to_string($6::text[], ' '))",
  sourceKindExclusion: "(cardinality($5::text[]) = 0 OR provenance.source_kind <> ALL($5::text[]))",
  forceClassExclusion: "(cardinality($7::text[]) = 0 OR provenance.force_class <> ALL($7::text[]))",
  limitParameter: "$2",
  openingBlockPrior
});

/** The fenced ranking block: everything from `SELECT hits.id` up to the fence that ends it. */
const rankedBlock = (sql: string): string => {
  const start = sql.indexOf("SELECT hits.id");
  const fence = sql.indexOf("OFFSET 0", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(fence).toBeGreaterThan(start);
  return sql.slice(start, fence);
};

describe("anchor-posting ranking tail", () => {
  /**
   * Measured live 2026-09-16 on the production corpus: `evidence_spans.provenance_json` averages 58,509 bytes
   * per span, so evaluating the source-kind and force-class exclusions over the whole candidate frontier
   * detoasts it once per candidate. One group query over 4,186 candidates: 0.505s with the narrow columns
   * only, 4.69s once one provenance predicate joins the WHERE, and past the 8s statement timeout with both.
   * Ranking the narrow columns first and reading provenance only for the ranked prefix the LIMIT consumes
   * returned the identical 64 rows in 0.340s.
   */
  it("reads provenance_json only above the rank fence, never for every candidate", () => {
    const sql = tail();
    const ranked = rankedBlock(sql);
    const belowFence = (ranked.match(/provenance_json/gu) ?? []).length;
    const total = (sql.match(/provenance_json/gu) ?? []).length;
    // eslint-disable-next-line no-console
    console.log(`[cost] provenance_json reads below the rank fence: ${belowFence}; in the whole tail: ${total}`);
    expect(belowFence).toBe(0);
    expect(total).toBeGreaterThan(0);
  });

  it("bounds the provenance lateral by the same LIMIT that bounds the result", () => {
    const sql = tail();
    const lateral = sql.indexOf("provenance_json");
    const limit = sql.indexOf("LIMIT $2");
    expect(lateral).toBeGreaterThan(0);
    expect(limit).toBeGreaterThan(lateral);
    // No LIMIT may sit inside the fenced block: the fence is what makes the outer LIMIT bound the lateral.
    expect(rankedBlock(sql)).not.toContain("LIMIT");
  });

  it("keeps the cheap narrow predicates below the fence, where they shrink the sort", () => {
    const ranked = rankedBlock(tail());
    expect(ranked).toContain("evidence.status='promoted'");
    expect(ranked).toContain("information_label");
    expect(ranked).toContain("source_name");
    expect(ranked).toContain("source_title");
  });

  it("applies both exclusions before the LIMIT, so ranking still decides among admitted spans only", () => {
    const sql = tail();
    const kind = sql.indexOf("provenance.source_kind");
    const force = sql.indexOf("provenance.force_class");
    const limit = sql.indexOf("LIMIT $2");
    expect(kind).toBeGreaterThan(0);
    expect(force).toBeGreaterThan(0);
    expect(limit).toBeGreaterThan(kind);
    expect(limit).toBeGreaterThan(force);
  });

  it("ranks the fenced block and the returned rows by the same order", () => {
    const sql = tail();
    expect(sql).toContain(evidenceRankOrder({ rank: "", score: "hits.", row: "evidence.", openingBlockPrior: true }));
    expect(sql).toContain(evidenceRankOrder({ rank: "top.", score: "top.", row: "top.", openingBlockPrior: true }));
  });

  /**
   * Ranking first and filtering after returns the same rows as filtering first and ranking after only when the
   * order is total. Without a unique final key the sort is free to permute ties, so the two shapes could differ
   * on exactly the spans a tie decides -- and replay could differ from itself.
   */
  it("orders by a unique key last, so no tie is left for the sort to break", () => {
    for (const openingBlockPrior of [true, false]) {
      const order = keys(evidenceRankOrder({ rank: "", score: "hits.", row: "evidence.", openingBlockPrior }));
      expect(order[order.length - 1]).toBe("evidence.id ASC");
      const outer = keys(evidenceRankOrder({ rank: "top.", score: "top.", row: "top.", openingBlockPrior }));
      expect(outer[outer.length - 1]).toBe("top.id ASC");
    }
  });
});
