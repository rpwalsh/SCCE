// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CORPUS_ROLE_IDS,
  createCorpusRegistry,
  languageMemoryEligibleCorpora,
  languageMemoryHydrationPlan
} from "../corpus-registry.js";
import {
  measureLanguagePopulationSupport,
  selectLanguagePopulation,
  type LanguagePopulationSupport
} from "../language-population-selection.js";
import { trainKneserNey } from "../kneser-ney.js";
import { TURN_REQUIREMENT_DIMENSIONS, type TurnRequirementField } from "../turn-requirements.js";

function field(overrides: Partial<Record<string, number>>): TurnRequirementField {
  const base = Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS.map(dimension => [dimension, 0]));
  return {
    ...base,
    ...overrides,
    confidence: 1,
    requiredFeatures: [],
    prohibitedFeatures: []
  } as unknown as TurnRequirementField;
}

const registry = createCorpusRegistry();

// Two populations in one registry: a document lane the evidence graph reads, and a conversational lane it never does.
describe("one database, two populations", () => {
  it("holds a document population and a conversational population at once", () => {
    const roleScoped = languageMemoryEligibleCorpora(registry, "role-scoped").map(entry => entry.sourceSystem);
    expect(roleScoped).toContain("wikipedia");
    expect(roleScoped).toContain("dialogue");
  });

  it("lets a turn of any kind hydrate the conversational population, which grants wording and never authority", () => {
    const unscoped = languageMemoryHydrationPlan(registry, {}, "unscoped").map(entry => entry.sourceSystem);
    expect(unscoped).toContain("wikipedia");
    expect(unscoped).toContain("dialogue");
    const dialogue = registry.find(entry => entry.corpusRoleId === CORPUS_ROLE_IDS.dialogue);
    expect(dialogue?.graphEvidenceEligible).toBe(false);
  });

  it("never lets the dialogue population into the evidence graph", () => {
    const dialogue = registry.find(entry => entry.corpusRoleId === CORPUS_ROLE_IDS.dialogue);
    expect(dialogue?.enabled).toBe(true);
    expect(dialogue?.graphEvidenceEligible).toBe(false);
  });

  it("makes the dialogue population reachable through role-scoped hydration", () => {
    const plan = languageMemoryHydrationPlan(registry, {}, "role-scoped")
      .filter(item => registry.some(entry => entry.sourceSystemId === item.sourceSystemId && entry.corpusRoleId === CORPUS_ROLE_IDS.dialogue));
    expect(plan.map(item => item.sourceSystem)).toEqual(["dialogue"]);
  });
});

describe("population selection reads turn state", () => {
  const encyclopedic = CORPUS_ROLE_IDS.encyclopedic;

  it("hydrates the factual population for a source-bound turn", () => {
    const selection = selectLanguagePopulation({
      requirementField: field({ dialogueDependence: 0.2, sourceDependence: 0.8, externalTruthAuthority: 0.7 }),
      authorityPriorRoleId: encyclopedic,
      registry
    });
    expect(selection.selectedCorpusRoleId).toBe(encyclopedic);
    expect(selection.conversationDisplaced).toBe(false);
    expect(selection.reasonId).toBe("population.authority_prior");
    expect(selection.quantities.conversationDisplacement).toBeLessThan(0);
  });

  it("hydrates the dialogue population for a conversation-bound turn", () => {
    const support: LanguagePopulationSupport[] = [
      { corpusRoleId: CORPUS_ROLE_IDS.dialogue, sourceSystem: "dialogue", perplexity: 40, modelIds: ["m-dialogue"] },
      { corpusRoleId: CORPUS_ROLE_IDS.interactionCorrection, sourceSystem: "corrections", perplexity: 900, modelIds: ["m-corr"] }
    ];
    const selection = selectLanguagePopulation({
      requirementField: field({ dialogueDependence: 0.8, sourceDependence: 0.1, externalTruthAuthority: 0.05 }),
      authorityPriorRoleId: encyclopedic,
      registry,
      support
    });
    expect(selection.selectedCorpusRoleId).toBe(CORPUS_ROLE_IDS.dialogue);
    expect(selection.conversationDisplaced).toBe(true);
    expect(selection.reasonId).toBe("population.conversation_displaced.measured_support");
    expect(selection.status).toBe("active");
    expect(selection.quantities.conversationDisplacement).toBeGreaterThan(0);
  });

  it("reports the deciding quantities and the models, not just the id", () => {
    const selection = selectLanguagePopulation({
      requirementField: field({ dialogueDependence: 0.9, sourceDependence: 0.2, externalTruthAuthority: 0.1 }),
      authorityPriorRoleId: encyclopedic,
      registry,
      support: [
        { corpusRoleId: CORPUS_ROLE_IDS.dialogue, sourceSystem: "dialogue", perplexity: 40, modelIds: ["m-dialogue"] },
        { corpusRoleId: CORPUS_ROLE_IDS.interactionCorrection, sourceSystem: "corrections", perplexity: 900, modelIds: ["m-corr"] }
      ]
    });
    expect(selection.consideredSourceSystems).toEqual(["corrections", "dialogue"]);
    expect(selection.quantities.dialogueDependence).toBe(0.9);
    expect(selection.quantities.supportByRole[String(CORPUS_ROLE_IDS.dialogue)]).toBe(40);
    expect(selection.quantities.supportMargin).toBe(860);
    expect(selection.hydratedModelIds).toEqual(["m-dialogue"]);
    expect(selection.authorityPriorRoleId).toBe(encyclopedic);
  });

  it("refuses to report active when more than one displaced population is unmeasured", () => {
    const selection = selectLanguagePopulation({
      requirementField: field({ dialogueDependence: 0.9, sourceDependence: 0.1, externalTruthAuthority: 0.1 }),
      authorityPriorRoleId: encyclopedic,
      registry
    });
    expect(selection.status).toBe("inert_unconfigured");
    expect(selection.reasonId).toBe("population.conversation_displaced.no_resident_support");
    expect(selection.selectedCorpusRoleId).toBe(encyclopedic);
  });

  it("decides from turn state alone: identical text, opposite populations", () => {
    const support: LanguagePopulationSupport[] = [
      { corpusRoleId: CORPUS_ROLE_IDS.dialogue, sourceSystem: "dialogue", perplexity: 40, modelIds: ["m-dialogue"] },
      { corpusRoleId: CORPUS_ROLE_IDS.interactionCorrection, sourceSystem: "corrections", perplexity: 900, modelIds: ["m-corr"] }
    ];
    const sourceBound = selectLanguagePopulation({
      requirementField: field({ dialogueDependence: 0.2, sourceDependence: 0.9, externalTruthAuthority: 0.8 }),
      authorityPriorRoleId: encyclopedic,
      registry,
      support
    });
    const conversationBound = selectLanguagePopulation({
      requirementField: field({ dialogueDependence: 0.9, sourceDependence: 0.2, externalTruthAuthority: 0.1 }),
      authorityPriorRoleId: encyclopedic,
      registry,
      support
    });
    expect(sourceBound.selectedCorpusRoleId).toBe(encyclopedic);
    expect(conversationBound.selectedCorpusRoleId).toBe(CORPUS_ROLE_IDS.dialogue);
  });

  // The failure to guard: structurally legal, encyclopedia-shaped output.
  it("never realizes a conversation-bound turn from a population the evidence graph reads", () => {
    const selection = selectLanguagePopulation({
      requirementField: field({ dialogueDependence: 0.9, sourceDependence: 0.1, externalTruthAuthority: 0.05 }),
      authorityPriorRoleId: encyclopedic,
      registry,
      support: [
        // The document population is offered, and offered as the better-supporting one.
        { corpusRoleId: encyclopedic, sourceSystem: "wikipedia", perplexity: 1, modelIds: ["m-wiki"] },
        { corpusRoleId: CORPUS_ROLE_IDS.dialogue, sourceSystem: "dialogue", perplexity: 500, modelIds: ["m-dialogue"] }
      ]
    });
    expect(selection.consideredSourceSystems).not.toContain("wikipedia");
    expect(selection.consideredSourceSystems).not.toContain("gutenberg");
    expect(selection.selectedCorpusRoleId).toBe(CORPUS_ROLE_IDS.dialogue);
  });

  it("selects a realizer population and never returns an authority", () => {
    const selection = selectLanguagePopulation({
      requirementField: field({ dialogueDependence: 0.9, sourceDependence: 0.1, externalTruthAuthority: 0.05 }),
      authorityPriorRoleId: encyclopedic,
      registry,
      support: [{ corpusRoleId: CORPUS_ROLE_IDS.dialogue, sourceSystem: "dialogue", perplexity: 40, modelIds: ["m"] }]
    });
    expect(Object.keys(selection)).not.toContain("requestedAuthority");
    expect(Object.keys(selection)).not.toContain("truthState");
    // The resolved authority is carried through untouched, as the prior it was.
    expect(selection.authorityPriorRoleId).toBe(encyclopedic);
  });

  it("is deterministic across restart: same state, same selection", () => {
    const build = () => selectLanguagePopulation({
      requirementField: field({ dialogueDependence: 0.8, sourceDependence: 0.1, externalTruthAuthority: 0.05 }),
      authorityPriorRoleId: encyclopedic,
      registry: createCorpusRegistry(),
      support: [{ corpusRoleId: CORPUS_ROLE_IDS.dialogue, sourceSystem: "dialogue", perplexity: 40, modelIds: ["m-dialogue"] }]
    });
    expect(JSON.stringify(build())).toEqual(JSON.stringify(build()));
  });
});

describe("population support is measured, not declared", () => {
  const dialogueCorpus = [
    "who is there",
    "nay answer me stand and unfold yourself",
    "long live the king",
    "what is it you would see",
    "i think i hear them stand ho who is there",
    "why do you speak so faintly speak again",
    "i pray you tell me what you know",
    "and so say i and so say all of us"
  ].join("\n");
  const documentCorpus = [
    "the city is the capital and largest settlement of the region",
    "the region is bounded to the north by the mountain range",
    "the population of the province was recorded in the national census",
    "the university was founded in the nineteenth century",
    "the river rises in the highlands and flows to the sea",
    "the province is divided into districts for administrative purposes",
    "the national census recorded the population of the capital",
    "the mountain range forms the northern boundary of the province"
  ].join("\n");

  const dialogueModel = trainKneserNey(dialogueCorpus, { order: 3 });
  const documentModel = trainKneserNey(documentCorpus, { order: 3 });
  const populations = [
    { corpusRoleId: CORPUS_ROLE_IDS.dialogue, sourceSystem: "dialogue", modelId: "m-dialogue", model: dialogueModel },
    { corpusRoleId: CORPUS_ROLE_IDS.encyclopedic, sourceSystem: "wikipedia", modelId: "m-wiki", model: documentModel }
  ];

  // Held out of both corpora.
  const heldOutConversational = "speak again i pray you what is it you would say";
  const heldOutDocument = "the census recorded the population of the northern districts of the province";

  it("supports conversational text better from the dialogue population", () => {
    const support = measureLanguagePopulationSupport(populations, heldOutConversational);
    const dialogue = support.find(row => row.corpusRoleId === CORPUS_ROLE_IDS.dialogue)!;
    const document = support.find(row => row.corpusRoleId === CORPUS_ROLE_IDS.encyclopedic)!;
    expect(dialogue.perplexity).toBeLessThan(document.perplexity);
  });

  it("supports document text better from the document population", () => {
    const support = measureLanguagePopulationSupport(populations, heldOutDocument);
    const dialogue = support.find(row => row.corpusRoleId === CORPUS_ROLE_IDS.dialogue)!;
    const document = support.find(row => row.corpusRoleId === CORPUS_ROLE_IDS.encyclopedic)!;
    expect(document.perplexity).toBeLessThan(dialogue.perplexity);
  });

  it("routes each held-out text to the population that measurably supports it", () => {
    const conversational = selectLanguagePopulation({
      requirementField: field({ dialogueDependence: 0.8, sourceDependence: 0.1, externalTruthAuthority: 0.05 }),
      authorityPriorRoleId: CORPUS_ROLE_IDS.encyclopedic,
      registry,
      support: measureLanguagePopulationSupport(populations, heldOutConversational)
    });
    expect(conversational.selectedCorpusRoleId).toBe(CORPUS_ROLE_IDS.dialogue);
    expect(conversational.status).toBe("active");
  });
});
