// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { dropContainerSpans } from "../runtime-graph-retrieval.js";

const span = (id: string, sourceVersionId: string, charStart: number, charEnd: number) => ({ id, sourceVersionId, charStart, charEnd });

describe("dropContainerSpans", () => {
  it("drops a whole-article parent when two or more of its children are in the pool", () => {
    const pool = [span("p", "sv1", 0, 38000), span("c1", "sv1", 0, 4000), span("c2", "sv1", 4000, 8000), span("other", "sv2", 0, 3000)];
    expect(dropContainerSpans(pool).map(item => item.id)).toEqual(["c1", "c2", "other"]);
  });

  it("keeps a parent whose children are absent, and a span that merely overlaps", () => {
    const pool = [span("p", "sv1", 0, 38000), span("c1", "sv1", 0, 4000), span("tail", "sv1", 37000, 39000)];
    expect(dropContainerSpans(pool).map(item => item.id)).toEqual(["p", "c1", "tail"]);
  });
});

import { joinContiguousQuotationSpans } from "../runtime-graph-retrieval.js";

const chunk = (id: string, sourceVersionId: string, byteStart: number, text: string) => ({
  id, sourceVersionId, byteStart, byteEnd: byteStart + text.length, charStart: byteStart, charEnd: byteStart + text.length,
  text, textPreview: text.slice(0, 8), contentHash: `sha256_${id}`, features: [`sym:${id}`], provenance: { title: "T", uri: "u" }, alpha: 0.5
}) as never;

describe("joinContiguousQuotationSpans", () => {
  it("joins two contiguous spans of one source version into one byte-exact span", () => {
    const joined = joinContiguousQuotationSpans([chunk("b", "sv1", 9, "e house."), chunk("a", "sv1", 0, "It was th")], text => `h:${text}`);
    expect(joined).toHaveLength(1);
    const span = joined[0]! as unknown as { id: string; text: string; byteStart: number; byteEnd: number; charEnd: number; contentHash: string; features: string[]; provenance: { boundaryJoin: string[] } };
    expect(span.id).toBe("a");
    expect(span.text).toBe("It was the house.");
    expect([span.byteStart, span.byteEnd, span.charEnd]).toEqual([0, 17, 17]);
    expect(span.contentHash).toBe("h:It was the house.");
    expect(span.features).toEqual(["sym:a", "sym:b"]);
    expect(span.provenance.boundaryJoin).toEqual(["a", "b"]);
  });

  it("leaves spans alone when they are not contiguous or come from different sources", () => {
    const joined = joinContiguousQuotationSpans([chunk("a", "sv1", 0, "abc"), chunk("c", "sv1", 5, "def"), chunk("d", "sv2", 3, "ghi")], text => text);
    expect(joined.map(span => (span as { id: string }).id)).toEqual(["a", "c", "d"]);
  });
});
