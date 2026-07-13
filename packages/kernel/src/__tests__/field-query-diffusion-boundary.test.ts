import { describe, expect, it } from "vitest";
import { createAlphaFieldEngine, type GraphNode } from "../index.js";

describe("field query-diffusion boundary", () => {
  it("keeps activation empty when the query establishes no semantic seed", () => {
    const node = {
      id: "node:unrelated",
      typeId: "type:fixture",
      representation: { label: "quartz" },
      alpha: 1,
      evidenceIds: [],
      features: ["sym:quartz", "bi:quartz|mineral"],
      createdAt: 1,
      updatedAt: 1,
      metadata: {}
    } as unknown as GraphNode;

    const field = createAlphaFieldEngine().activate({
      text: "cobalt turbine",
      nodes: [node],
      edges: []
    });

    expect(field.seeds).toEqual([]);
    expect(field.ppf).toEqual([]);
    expect(field.active).toEqual([]);
  });
});
