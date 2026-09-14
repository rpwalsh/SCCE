// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { languageGenerationFramesFromContract } from "../semantic-realization-frames.js";
import type { SemanticRealizationContract } from "../semantic-answer-construct.js";

function contract(): SemanticRealizationContract {
  return {
    sourceFact: {
      subject: "Apollo 11",
      predicate: "land",
      object: "20:17",
      sourceNodeId: "node.apollo11",
      targetNodeId: "node.2017",
      relationId: "relation.land",
      forceClass: "direct_evidence",
      score: 1,
      activation: 1,
      overlap: 1,
      support: 1,
      evidenceIds: ["evidence.apollo11"]
    },
    requestedSlotId: "slot.when",
    requiredAtoms: [],
    requiredRelationUnits: ["land"],
    boundValues: { "slot.when": "20:17" },
    evidenceIds: ["evidence.apollo11"],
    epistemicForce: "certified"
  };
}

describe("semantic realization frames", () => {
  it("projects subject, relation, and bound value into a real language-generation frame", () => {
    const frames = languageGenerationFramesFromContract(contract(), {
      targetLanguage: "language.en",
      targetScript: "script:Latn"
    });

    expect(frames).toHaveLength(1);
    expect(frames[0]?.propositionAtoms?.map(atom => atom.text)).toEqual([
      "Apollo 11",
      "land",
      "20:17"
    ]);
    expect(frames[0]?.requiredTerms?.map(term => term.text)).toEqual([
      "Apollo 11",
      "land",
      "20:17"
    ]);
    expect(frames[0]?.realizationConstraints).toMatchObject({
      schema: "scce.semantic_realization_frame.v1",
      relationId: "relation.land",
      requestedSlotId: "slot.when",
      boundValues: { "slot.when": "20:17" }
    });
    expect(frames[0]?.targetLanguage).toBe("language.en");
    expect(frames[0]?.targetScript).toBe("script:Latn");
  });
});
