// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { evidenceAnchorRankingTail, evidenceRankOrder } from "../postgres.js";

const BASE = {
  spansTable: "scce.evidence_spans",
  statusCondition: "evidence.status='promoted'",
  accessCondition: "(evidence.information_label->>'exportClass' = 'public')",
  titleMatch: "(cardinality($6::text[]) > 0 AND evidence.source_name <> '')",
  titleExact: "(cardinality($6::text[]) > 0 AND evidence.source_title = array_to_string($6::text[], ' '))",
  sourceKindExclusion: "(cardinality($5::text[]) = 0 OR provenance.source_kind <> ALL($5::text[]))",
  forceClassExclusion: "(cardinality($7::text[]) = 0 OR provenance.force_class <> ALL($7::text[]))",
  limitParameter: "$2",
  openingBlockPrior: true
};
const DEPRIORITIZED = "(cardinality($5::text[]) > 0 AND provenance.source_kind = ANY($5::text[]))";

const excluding = () => evidenceAnchorRankingTail(BASE);
const partitioning = () => evidenceAnchorRankingTail({ ...BASE, sourceKindDeprioritized: DEPRIORITIZED });

/** Every fenced ranking block in the statement: `SELECT hits.id` up to the `OFFSET 0` that closes it. */
function fencedBlocks(sql: string): string[] {
  const blocks: string[] = [];
  let cursor = sql.indexOf("SELECT hits.id");
  while (cursor >= 0) {
    const fence = sql.indexOf("OFFSET 0", cursor);
    expect(fence).toBeGreaterThan(cursor);
    blocks.push(sql.slice(cursor, fence));
    cursor = sql.indexOf("SELECT hits.id", fence);
  }
  return blocks;
}

/** One pass: the fenced ranking, the provenance lateral and the LIMIT that bounds it. */
function firstPassBody(sql: string): string {
  const start = sql.indexOf("SELECT hits.id");
  const limit = sql.indexOf("LIMIT $2", start);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(limit).toBeGreaterThan(start);
  return sql.slice(start, limit + "LIMIT $2".length);
}

describe("source-kind frontier partition", () => {
  /**
   * The reason this is a partition and not an ORDER BY key.
   *
   * `provenance_json` averages 58,509 bytes per span, and the rank fence exists to keep it out of the sort that
   * ranks the whole frontier. A leading ORDER BY key reading the source kind would have put that detoast back for
   * every candidate. The tier is decided by which pass admitted the row, and travels as a narrow integer.
   */
  it("reads no provenance below any rank fence, and ranks no candidate by a wide column", () => {
    const blocks = fencedBlocks(partitioning());
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      expect(block).not.toContain("provenance_json");
      expect(block).not.toContain("source_kind");
      expect(block).not.toContain("LIMIT");
    }
  });

  /**
   * The preservation property, stated against the SQL rather than against a fixture: the admitted pass IS the
   * exclusion query, character for character. Whatever rows it returned, in whatever order, it still returns.
   */
  it("runs the exclusion query unchanged as its first pass", () => {
    expect(firstPassBody(partitioning())).toBe(firstPassBody(excluding()));
  });

  it("gives the deprioritized pass the same ranking and the complementary predicate", () => {
    const sql = partitioning();
    const blocks = fencedBlocks(sql);
    expect(blocks[1]).toBe(blocks[0]);
    expect(sql).toContain(DEPRIORITIZED);
    expect(sql.indexOf(BASE.sourceKindExclusion)).toBeLessThan(sql.indexOf(DEPRIORITIZED));
    // Both passes are bounded, and the union is bounded again, so the deprioritized rows can only occupy slots
    // the admitted pass left empty.
    expect((sql.match(/LIMIT \$2/gu) ?? [])).toHaveLength(3);
  });

  it("leads the returned order with the tier, so the outer sort cannot re-interleave the passes", () => {
    const order = partitioning().slice(partitioning().lastIndexOf("ORDER BY"));
    expect(order.split(",").map(key => key.trim())[0]).toBe("ORDER BY top.source_kind_rank ASC");
    // ...and the rest of the order is the one the ranking lane states, unchanged.
    expect(order).toContain(evidenceRankOrder({ rank: "top.", score: "top.", row: "top.", openingBlockPrior: true }));
  });

  it("emits the exclusion shape unchanged when no kind is deprioritized", () => {
    const sql = excluding();
    expect(sql).not.toContain("source_kind_rank");
    expect(sql).not.toContain("UNION ALL");
    expect(fencedBlocks(sql)).toHaveLength(1);
  });
});
