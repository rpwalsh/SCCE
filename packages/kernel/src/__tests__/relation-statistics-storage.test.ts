// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { decodeRelationStatistics, encodeRelationStatistics } from "../relation-statistics-storage.js";
import type { JsonValue } from "../types.js";

describe("relation statistic structural tables", () => {
  it("retains distinct sufficient statistics and source strings while sharing repeated structures", () => {
    const source = { evidenceId: "source.opaque.".repeat(8), surface: "한국어 A\u030a\u0000 🧭\\u0000", evidenceIds: ["α", "β"], optional: null };
    const logical = { observations: Array.from({ length: 100 }, (_, index) => ({ count: index, source, distribution: { positive: index / 100, negative: 1 - index / 100 } })) };
    const stored = encodeRelationStatistics(logical);
    const decoded = decodeRelationStatistics(JSON.parse(JSON.stringify(stored)));
    expect(decoded).toEqual(logical);
    expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(logical).length / 2);
    const rows = (decoded as { observations: { source: { surface: string } }[] }).observations;
    rows[0]!.source.surface = "changed";
    expect(rows[1]!.source.surface).toBe(source.surface);
  });
  it("preserves zero, negative zero, subnormal and exact finite numeric statistics", () => {
    const logical = [0, -0, Number.MIN_VALUE, 1 / 3, Number.MAX_VALUE];
    const decoded = decodeRelationStatistics(encodeRelationStatistics(logical)) as number[];
    logical.forEach((value, index) => expect(Object.is(decoded[index], value)).toBe(true));
  });
  it("rejects corrupt checksums, forward references, unknown fields, unreachable nodes and understated budgets", () => {
    const logical = { repeated: [{ value: "witness" }, { value: "witness" }] };
    const source = encodeRelationStatistics(logical);
    for (const mutate of [
      (row: any) => { row.digest = "0".repeat(64); },
      (row: any) => { row.nodes[0] = [0, [[row.nodes.length]]]; },
      (row: any) => { row.unknown = true; },
      (row: any) => { row.nodes.push([2, "unreachable"]); },
      (row: any) => { row.decodedValueCount--; }
    ]) { const changed = structuredClone(source); mutate(changed); expect(() => decodeRelationStatistics(changed)).toThrow("invalid relation"); }
    expect(() => decodeRelationStatistics(source, { maxDecodedBytes: 2 })).toThrow("invalid relation");
    expect(() => decodeRelationStatistics(source, { maxDecodedValues: 2 })).toThrow("invalid relation");
  });
  it("keeps complete independent non-repeated structures without changing their meaning", () => {
    const logical: JsonValue = { α: [null, true, false, "", [], {}], "__proto__": "inert string key", fields: { absent: null } };
    expect(decodeRelationStatistics(encodeRelationStatistics(logical))).toEqual(logical);
  });
});
