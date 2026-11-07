// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { attachLearnedGraphPriorConstruct, displayPriorTerm } from "../learned-graph-prior-runtime.js";
import type { ConstructGraph, TurnResult } from "../types.js";

describe("learned graph prior surface spelling", () => {
  it.each([
    ["ada lovelace", "ada lovelace"],
    ["Mary Shelley", "Mary Shelley"],
    ["東京", "東京"]
  ])("preserves the observed graph surface for source binding: %s", (observed, expected) => {
    expect(displayPriorTerm(observed)).toBe(expected);
  });

  it("keeps an existing source-bound answer construct unchanged", () => {
    const construct: ConstructGraph = {
      id: "construct.fixture" as ConstructGraph["id"],
      episodeId: "episode.fixture" as ConstructGraph["episodeId"],
      forceVector: {},
      nodes: [{
        id: "construct.answer.fixture",
        kind: "construct:semantic_answer",
        label: "ada lovelace was born in london",
        metadata: { localEvidenceAnswer: true }
      }],
      edges: [],
      artifacts: []
    };

    const result = attachLearnedGraphPriorConstruct({
      construct,
      requestText: "where was ada lovelace born?",
      graph: { nodes: [], edges: [] },
      field: {} as TurnResult["field"],
      selectedEvidence: [],
      brainMarker: {},
      hasher: createHasher()
    });

    expect(result).toBe(construct);
    expect(result.nodes[0]?.label).toBe("ada lovelace was born in london");
  });
});
