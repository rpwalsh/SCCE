// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { createTurnSignals } from "../turn-signals.js";
import { requestClosedClassWords, requestScaffoldingConstructions } from "../closed-class-words.js";
import { trainKneserNey } from "../kneser-ney.js";
import { clearCorpusIdentitySignals, corpusNamedIdentities, primeCorpusIdentitySignals } from "../corpus-identity.js";
import type { LanguagePatternRecord } from "../storage.js";
import type { TurnRequirementField } from "../turn-requirements.js";
import { readFileSync } from "node:fs";
import { deriveClosedClassWords } from "../closed-class-words.js";

afterEach(() => clearCorpusIdentitySignals());

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
  it("uses the selected language's measured canonical population while excluding unrelated style models", () => {
    const text = readFileSync(new URL("./fixtures/pride-and-prejudice-context-excerpt.txt", import.meta.url), "utf8");
    const model = trainKneserNey(text, { order: 3 });
    const population = { languageId: "language.measured", modelCount: 1, continuationCounts: model.continuationCounts };
    expect(deriveClosedClassWords({ continuationPopulation: population }).has("what")).toBe(true);
    expect(deriveClosedClassWords({ continuationPopulation: population }).has("is")).toBe(true);
    expect(deriveClosedClassWords({ continuationPopulation: population }).has("does")).toBe(false);
    const signals = createTurnSignals({
      requestText: "What is White Rabbit?", authority: "factual", requirementField: requirementField(),
      models: [trainKneserNey("Animalia copies book. Animalia copies book.", { order: 3 })],
      continuationPopulation: population,
      languageIdentityId: population.languageId,
      languageIdentityProfileCount: 1,
      identityClosedClassWords: new Set(["a", "and", "in", "of", "the", "to"]), patterns: []
    });
    expect(signals.functionSymbols.has("what")).toBe(true);
    expect(signals.functionSymbols.has("is")).toBe(true);
    expect(signals.functionSymbols.has("does")).toBe(false);
    expect(signals.closedClassWords.has("what")).toBe(true);
    expect(signals.closedClassWords.has("rabbit")).toBe(false);
    expect(signals.functionSymbols.has("animalia")).toBe(false);
  });

  it("does not accept a foreign or unbound population as the selected identity's function material", () => {
    const text = readFileSync(new URL("./fixtures/pride-and-prejudice-context-excerpt.txt", import.meta.url), "utf8");
    const model = trainKneserNey(text, { order: 3 });
    for (const languageIdentityId of [undefined, "language.other"]) {
      const signals = createTurnSignals({
        requestText: "What does White Rabbit carry?", authority: "factual", requirementField: requirementField(),
        models: [], continuationPopulation: { languageId: "language.measured", modelCount: 1, continuationCounts: model.continuationCounts },
        languageIdentityId, languageIdentityProfileCount: 1,
        identityClosedClassWords: new Set(["and"]), patterns: []
      });
      expect(signals.functionSymbols.has("and")).toBe(true);
      expect(signals.functionSymbols.has("what")).toBe(false);
      expect(signals.functionSymbols.has("does")).toBe(false);
    }
  });

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
        selectedAuthority: "factual",
        requestSpanRole: "control",
        requestUnitResponseCopyRecipe: "scce.request_unit_response_copy.v1",
        requestUnitResponseCopyAuthority: "factual",
        requestUnitResponseCopy: [{ unit: "please", supportedPairs: 2, copiedPairs: 0 }]
      },
      evidenceIds: [],
      updatedAt: 1
    };
    const direct = requestClosedClassWords({ requestText: "", authority: "factual", patterns: [learnedOpener] });
    expect(requestScaffoldingConstructions([learnedOpener], "factual")).toEqual([{ parts: [{ kind: "literal", surface: "please" }] }]);
    const classifierOnly = { ...learnedOpener, id: "pattern.request.topic", patternJson: {
      ...learnedOpener.patternJson as Record<string, unknown>, surface: "sailor", requestSpanRole: "content"
    } } as LanguagePatternRecord;
    expect(requestScaffoldingConstructions([learnedOpener, classifierOnly], "factual")).toEqual([{ parts: [{ kind: "literal", surface: "please" }] }]);
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

  it("does not promote a one-profile source vocabulary into the language closed class", () => {
    const model = trainKneserNey("Animalia copies book. Animalia copies book. Animalia is discussed in the book.", { order: 3 });
    const signals = createTurnSignals({
      requestText: "What is Animalia?",
      authority: "factual",
      requirementField: requirementField(),
      models: [model],
      identityClosedClassWords: new Set(),
      languageIdentityProfileCount: 1,
      patterns: []
    });

    expect(signals.functionSymbols.has("animalia")).toBe(false);
    expect(signals.closedClassWords.has("animalia")).toBe(false);
    primeCorpusIdentitySignals({
      closedClass: signals.functionSymbols,
      identities: new Set(["animalia"]),
      spread: new Map(),
      concentration: 0
    });
    expect(corpusNamedIdentities("What is Animalia?")).toEqual(["animalia"]);
  });
});
