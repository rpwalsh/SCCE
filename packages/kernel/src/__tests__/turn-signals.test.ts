// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createTurnSignals } from "../turn-signals.js";
import { requestClosedClassWords, requestScaffoldingConstructions } from "../closed-class-words.js";
import { trainKneserNey } from "../kneser-ney.js";
import type { LanguagePatternRecord } from "../storage.js";
import type { TurnRequirementField } from "../turn-requirements.js";

function requirementField(): TurnRequirementField {
  return {
    externalTruthAuthority: 0,
    sourceDependence: 0,
    noveltyDemand: 0,
    inferentialDepth: 0,
    semanticPreservation: 0,
    surfaceTransformation: 0,
    executableArtifactDemand: 0,
    actionCommitment: 0,
    dialogueDependence: 0,
    uncertaintyTolerance: 0,
    formatConstraintStrength: 0,
    audienceAdaptation: 0,
    brevityDetailBalance: 0,
    temporalReasoningDemand: 0,
    causalReasoningDemand: 0,
    counterfactualDemand: 0,
    requiredFeatures: [],
    prohibitedFeatures: [],
    activatedFrameIds: [],
    activatedPatternIds: [],
    activatedPhraseUnitIds: [],
    activatedDialogueMoveIds: [],
    activatedConstructIds: [],
    confidence: 0,
    trace: {}
  };
}

describe("turn language state", () => {
  it("uses admitted request constructions when deriving the turn closed class", () => {
    const learnedOpener: LanguagePatternRecord = {
      id: "pattern.request.who",
      profileId: "profile.english",
      patternKind: "semantic_role",
      support: 0.9,
      entropy: 0.1,
      patternJson: {
        schema: "scce.request_requirement_pattern.v1",
        surface: "please",
        anchor: "start",
        selectedAuthority: "factual"
      },
      evidenceIds: [],
      updatedAt: 1
    };
    const direct = requestClosedClassWords({ requestText: "", authority: "factual", patterns: [learnedOpener] });
    expect(requestScaffoldingConstructions([learnedOpener], "factual")).toEqual([{ parts: [{ kind: "literal", surface: "please" }] }]);
    expect(direct.has("please")).toBe(true);
    const signals = createTurnSignals({
      requestText: "",
      authority: "factual",
      requirementField: requirementField(),
      models: [],
      patterns: [learnedOpener]
    });

    expect(signals.closedClassWords.has("please")).toBe(true);
    expect(signals.closedClassWords.has("ada")).toBe(false);
  });

  it("retains selected identity closed-class cues during a cold runtime fallback", () => {
    const signals = createTurnSignals({
      requestText: "What is the capital?",
      authority: "factual",
      requirementField: requirementField(),
      models: [],
      identityClosedClassWords: new Set(["what", "is", "the", "identity-only"]),
      patterns: [{
        id: "pattern.request.what-is",
        profileId: "profile.identity",
        patternKind: "semantic_role",
        support: 1,
        entropy: 0,
        patternJson: {
          schema: "scce.request_requirement_pattern.v1",
          surface: "what is",
          anchor: "start",
          selectedAuthority: "factual"
        },
        evidenceIds: [],
        updatedAt: 1
      }]
    });

    expect(signals.functionSymbols.has("the")).toBe(true);
    expect(signals.functionSymbols.has("identity-only")).toBe(true);
    expect(signals.closedClassWords.has("what")).toBe(true);
    expect(signals.closedClassWords.has("the")).toBe(true);
    expect(signals.closedClassWords.has("identity-only")).toBe(false);
  });

  it("does not let identity cues replace populated runtime language statistics", () => {
    const signals = createTurnSignals({
      requestText: "What is the capital?",
      authority: "factual",
      requirementField: requirementField(),
      models: [trainKneserNey("the capital is the capital and the capital is stable", { order: 2 })],
      identityClosedClassWords: new Set(["identity-only"]),
      patterns: []
    });

    expect(signals.functionSymbols.has("the")).toBe(true);
    expect(signals.functionSymbols.has("identity-only")).toBe(false);
  });
});
