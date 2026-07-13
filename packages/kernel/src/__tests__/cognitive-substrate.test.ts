import { describe, expect, it } from "vitest";
import { buildCognitiveSubstrate, defaultGuardFlags, type TypedAnswerAction } from "../cognitive-substrate.js";

describe("cognitive substrate", () => {
  it("builds a typed answer object with guard flags from a bounded substrate", () => {
    const substrate = buildCognitiveSubstrate({
      answer: "A bounded explanation",
      force: "inferred",
      support: 0.76,
      recency: 0.6,
      sourceQuality: 0.8,
      pathStrength: 0.7,
      contradictionMass: 0.1,
      connectivity: 0.54,
      events: [{ id: "e-1", typeId: "observation", timestamp: 1, payload: { value: "alpha" } }],
      graph: {
        nodes: [{ id: "n-1", typeId: "concept", timestamp: 1 }],
        edges: [{ id: "e-2", source: "n-1", target: "n-1", relationId: "self", timestamp: 1, weight: 0.8, evidenceIds: ["span-1"] }]
      },
      rules: [{ id: "r-1", relationId: "self", weight: 0.8, scope: "local" }],
      spectralConnectivity: 0.54,
      compression: { rank: 2, factorCount: 3, note: "compact factorization" },
      inference: { depth: 2, bounded: true, reason: "bounded-inference" }
    });

    const answer = substrate.answer as TypedAnswerAction;
    expect(answer.kind).toBe("answer");
    expect(answer.guardFlags.requireEvidence).toBe(true);
    expect(answer.guardFlags.exposeContradiction).toBe(true);
    expect(answer.guardFlags.allowInference).toBe(true);
    expect(answer.score).toBeGreaterThan(0.5);
    expect(substrate.spectralConnectivity).toBeCloseTo(0.54, 5);
    expect(substrate.compression.rank).toBe(2);
    expect(defaultGuardFlags.allowCreative).toBe(false);
  });

  it("allows creative answers but still blocks certification by default", () => {
    const substrate = buildCognitiveSubstrate({
      answer: "A creative design",
      force: "invented",
      support: 0.24,
      recency: 0.4,
      sourceQuality: 0.3,
      pathStrength: 0.35,
      contradictionMass: 0.06,
      connectivity: 0.2,
      events: [],
      graph: { nodes: [], edges: [] },
      rules: [],
      spectralConnectivity: 0.2,
      compression: { rank: 1, factorCount: 1, note: "minimal" },
      inference: { depth: 1, bounded: true, reason: "guarded" },
      guardFlags: { allowCreative: true }
    });

    expect(substrate.answer.guardFlags.allowCreative).toBe(true);
    expect(substrate.answer.guardFlags.blockCertifiedFact).toBe(true);
    expect(substrate.answer.kind).toBe("action");
  });
});
