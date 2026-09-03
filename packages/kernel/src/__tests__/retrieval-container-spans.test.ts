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
