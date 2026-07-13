import { describe, expect, it } from "vitest";
import { planQuestionSlots, type QuestionSlotFactInput } from "../question-slot-planner.js";
import {
  ANSWER_ROLE_IDS,
  ANSWER_SLOT_IDS,
  GRAPH_QUALITY_CLASS_IDS,
  GRAPH_SLOT_IDS,
  QUESTION_SLOT_REASON_IDS,
  QUESTION_TYPE_IDS,
  RELATION_ROLE_IDS
} from "../question-routing-ids.js";

describe("QuestionSlotPlanner", () => {
  it("keeps Einstein identity/contribution core ahead of advisors and dates", () => {
    const plan = planQuestionSlots({
      questionText: "Who was Albert Einstein?",
      selectedTopic: "Albert Einstein",
      facts: [
        fact("einstein:field", "Albert Einstein", "fields", "physics", { relationRoleId: RELATION_ROLE_IDS.graphCompactAttribute, finalQuestionFit: 0.72 }),
        fact("einstein:relativity", "Albert Einstein", "developed", "a single model of spacetime to explain the universe", { relationRoleId: RELATION_ROLE_IDS.graphExplanatoryPath, finalQuestionFit: 0.82 }),
        fact("einstein:advisor", "Albert Einstein", "doctoral advisor", "Alfred Kleiner", { finalQuestionFit: 0.61 }),
        fact("einstein:born", "Albert Einstein", "born", "1879 in Ulm", { finalQuestionFit: 0.58 }),
        fact("einstein:died", "Albert Einstein", "died", "1955 in Princeton", { finalQuestionFit: 0.55 })
      ]
    });

    const core = plan.selectedAnswerCore.map(row => row.factKey);
    expect(core).toContain("einstein:field");
    expect(core).toContain("einstein:relativity");
    expect(core).not.toContain("einstein:advisor");
    expect(core).not.toContain("einstein:born");
    expect(core).not.toContain("einstein:died");
    expect(plan.selectedContext.map(row => row.factKey)).toContain("einstein:advisor");
  });

  it("does not reject Ada's long copula contribution edge", () => {
    const plan = planQuestionSlots({
      questionText: "Who was Ada Lovelace and what was her contribution to computer science?",
      selectedTopic: "Ada Lovelace",
      facts: [
        fact("ada:role", "Ada Lovelace", "occupation", "mathematician", { relationRoleId: RELATION_ROLE_IDS.graphCompactAttribute, finalQuestionFit: 0.7 }),
        fact("ada:bernoulli", "Ada Lovelace", "is", "credited with developing an algorithm that would enable the engine to calculate a sequence of Bernoulli numbers", {
          relationRoleId: RELATION_ROLE_IDS.graphExplanatoryPath,
          requestedSlotId: GRAPH_SLOT_IDS.explanatoryPath,
          finalQuestionFit: 0.78
        }),
        fact("ada:engine", "Analytical Engine", "is", "a mechanical computer designed by Charles Babbage", { relationRoleId: RELATION_ROLE_IDS.graphContextRelation, finalQuestionFit: 0.5 })
      ]
    });

    expect(plan.questionTypeId).toBe(QUESTION_TYPE_IDS.contribution);
    expect(plan.selectedAnswerCore.map(row => row.factKey)).toContain("ada:bernoulli");
    expect(plan.rejected.map(row => row.factKey)).not.toContain("ada:bernoulli");
  });

  it("uses only character/cast relations as Star Trek answer core", () => {
    const plan = planQuestionSlots({
      questionText: "Who are the main characters in Star Trek?",
      selectedTopic: "Star Trek",
      facts: [
        fact("trek:composer", "Star Trek The Original Series", "theme_music_composer", "Alexander Courage", { graphQualityClassId: GRAPH_QUALITY_CLASS_IDS.catalogNavigation, finalQuestionFit: 0.52 }),
        fact("trek:episodes", "Star Trek", "episodes", "79", { finalQuestionFit: 0.5 }),
        fact("trek:producer", "Star Trek", "producer", "Gene Roddenberry", { finalQuestionFit: 0.55 }),
        fact("trek:spock", "Star Trek", "character", "Spock", { relationRoleId: RELATION_ROLE_IDS.graphRequestMembership, finalQuestionFit: 0.78 }),
        fact("trek:kirk", "Star Trek", "cast", "James T. Kirk", { relationRoleId: RELATION_ROLE_IDS.graphRequestMembership, finalQuestionFit: 0.74 })
      ]
    });

    const core = plan.selectedAnswerCore.map(row => row.factKey);
    expect(plan.questionTypeId).toBe(QUESTION_TYPE_IDS.collectionMember);
    expect(core).toEqual(expect.arrayContaining(["trek:spock", "trek:kirk"]));
    expect(core).not.toEqual(expect.arrayContaining(["trek:composer", "trek:episodes", "trek:producer"]));
  });

  it("reads inverse category membership as collection members", () => {
    const plan = planQuestionSlots({
      questionText: "Who are the characters in Star Trek?",
      selectedTopic: "Star Trek",
      facts: [
        fact("trek:title:the", "star trek", "of", "the", {
          graphQualityClassId: GRAPH_QUALITY_CLASS_IDS.weakFragment,
          relationRoleId: RELATION_ROLE_IDS.graphRequestMembership,
          finalQuestionFit: 0.73
        }),
        fact("trek:kirk:category", "James T. Kirk", "in-category", "Star Trek the Original Series characters", {
          graphQualityClassId: GRAPH_QUALITY_CLASS_IDS.catalogNavigation,
          relationRoleId: RELATION_ROLE_IDS.graphRequestMembership,
          finalQuestionFit: 0.62
        }),
        fact("trek:spock:category", "Spock", "in-category", "Star Trek the Original Series characters", {
          graphQualityClassId: GRAPH_QUALITY_CLASS_IDS.catalogNavigation,
          relationRoleId: RELATION_ROLE_IDS.graphRequestMembership,
          finalQuestionFit: 0.62
        })
      ]
    });

    const core = plan.selectedAnswerCore.map(row => row.factKey);
    expect(core).toEqual(expect.arrayContaining(["trek:kirk:category", "trek:spock:category"]));
    expect(core).not.toContain("trek:title:the");
  });

  it("does not treat a topic-repeating category label as a collection member", () => {
    const plan = planQuestionSlots({
      questionText: "Who are the characters in Star Trek?",
      selectedTopic: "Star Trek",
      facts: [
        fact("trek:category-label", "Star Trek", "in-category", "Star Trek the Original Series characters", {
          graphQualityClassId: GRAPH_QUALITY_CLASS_IDS.catalogNavigation,
          relationRoleId: RELATION_ROLE_IDS.graphRequestMembership,
          finalQuestionFit: 0.78
        }),
        fact("trek:spock", "Star Trek", "character", "Spock", {
          relationRoleId: RELATION_ROLE_IDS.graphRequestMembership,
          finalQuestionFit: 0.78
        })
      ]
    });

    expect(plan.selectedAnswerCore.map(row => row.factKey)).toContain("trek:spock");
    expect(plan.selectedAnswerCore.map(row => row.factKey)).not.toContain("trek:category-label");
    expect(plan.rejected.find(row => row.factKey === "trek:category-label")?.reasonIds).toContain(QUESTION_SLOT_REASON_IDS.collectionFragment);
  });

  it("keeps relativity senses separated", () => {
    const plan = planQuestionSlots({
      questionText: "What is relativity?",
      selectedTopic: "relativity",
      facts: [
        fact("relativity:physics", "general relativity", "is", "a classical field theory of gravitation and spacetime", {
          topicSenseId: "topic_sense.physics",
          relationRoleId: RELATION_ROLE_IDS.graphExplanatoryPath,
          finalQuestionFit: 0.76
        }),
        fact("relativity:physics-context", "special relativity", "concerns", "space and time for inertial observers", {
          topicSenseId: "topic_sense.physics",
          relationRoleId: RELATION_ROLE_IDS.graphExplanatoryPath,
          finalQuestionFit: 0.72
        }),
        fact("relativity:linguistic", "linguistic relativity", "in-category", "anthropological linguistics", {
          topicSenseId: "topic_sense.linguistic",
          graphQualityClassId: GRAPH_QUALITY_CLASS_IDS.catalogNavigation,
          finalQuestionFit: 0.58
        })
      ]
    });

    const selectedSenses = new Set(plan.selectedAnswerCore.map(row => row.topicSenseId));
    expect(selectedSenses.size).toBe(1);
    expect([...selectedSenses][0]).toBe("topic_sense.physics");
    expect(plan.rejected.find(row => row.factKey === "relativity:linguistic")?.reasonIds).toContain(QUESTION_SLOT_REASON_IDS.senseMixed);
  });

  it("prefers exact-topic definition facts over subtype senses", () => {
    const plan = planQuestionSlots({
      questionText: "What is anarchism?",
      selectedTopic: "anarchism",
      facts: [
        fact("anarchism:definition", "anarchism", "is", "a political philosophy opposing coercive authority", {
          topicSenseId: "topic_sense.requested",
          relationRoleId: RELATION_ROLE_IDS.graphExplanatoryPath,
          finalQuestionFit: 0.58
        }),
        fact("collectivist:definition", "Collectivist Anarchism", "a", "socialist doctrine in which workers own and manage production", {
          topicSenseId: "topic_sense.subtype",
          relationRoleId: RELATION_ROLE_IDS.graphExplanatoryPath,
          finalQuestionFit: 0.72
        })
      ]
    });

    expect(plan.selectedAnswerCore.map(row => row.factKey)).toContain("anarchism:definition");
    expect(plan.rejected.find(row => row.factKey === "collectivist:definition")?.reasonIds).toContain(QUESTION_SLOT_REASON_IDS.senseMixed);
  });

  it("does not allow raw language/profile priors to become answer core", () => {
    const plan = planQuestionSlots({
      questionText: "Who was Ada Lovelace?",
      selectedTopic: "Ada Lovelace",
      facts: [
        fact("ada:profile", "Ada Lovelace", "profile excerpt", "Ada Lovelace was a mathematician", { forceClass: "profile_excerpt_evidence", finalQuestionFit: 0.84 }),
        fact("ada:ngram", "Ada Lovelace", "phrase prior", "was a mathematician", { forceClass: "learned_language_prior", finalQuestionFit: 0.9 }),
        fact("ada:graph", "Ada Lovelace", "occupation", "mathematician", { relationRoleId: RELATION_ROLE_IDS.graphCompactAttribute, finalQuestionFit: 0.76 })
      ]
    });

    expect(plan.selectedAnswerCore.map(row => row.factKey)).toEqual(["ada:graph"]);
    expect(plan.rejected.map(row => row.factKey)).toContain("ada:ngram");
  });

  it("fills meaning slots from graph roles without English lexeme buckets", () => {
    const plan = planQuestionSlots({
      questionText: "Quien fue Ada Lovelace y cual fue su aporte?",
      selectedTopic: "Ada Lovelace",
      facts: [
        fact("ada:identidad", "Ada Lovelace", "ocupacion", "matematica", {
          relationRoleId: RELATION_ROLE_IDS.graphCompactAttribute,
          upstreamRoleId: ANSWER_ROLE_IDS.identity,
          finalQuestionFit: 0.72
        }),
        fact("ada:aporte", "Ada Lovelace", "anoto", "el motor analitico de Charles Babbage", {
          relationRoleId: RELATION_ROLE_IDS.graphExplanatoryPath,
          upstreamRoleId: ANSWER_ROLE_IDS.contribution,
          requestedSlotId: GRAPH_SLOT_IDS.explanatoryPath,
          finalQuestionFit: 0.8
        })
      ]
    });

    expect(plan.selectedAnswerCore.map(row => row.factKey)).toEqual(expect.arrayContaining(["ada:identidad", "ada:aporte"]));
    expect(plan.filledCoreSlots).toEqual(expect.arrayContaining([ANSWER_SLOT_IDS.roleOrField, ANSWER_SLOT_IDS.contribution]));
  });

  it("generalizes contribution planning to synthetic entities from graph roles", () => {
    const plan = planQuestionSlots({
      questionText: "Quem foi Zeta Nadir e qual foi seu aporte ao mapa solar?",
      selectedTopic: "Zeta Nadir",
      facts: [
        fact("zeta:role", "Zeta Nadir", "funcao", "cartografa de plasma", {
          relationRoleId: RELATION_ROLE_IDS.graphCompactAttribute,
          upstreamRoleId: ANSWER_ROLE_IDS.identity,
          finalQuestionFit: 0.72
        }),
        fact("zeta:atlas", "Zeta Nadir", "sincronizou", "o atlas solar com leituras de vento de tres observatorios", {
          relationRoleId: RELATION_ROLE_IDS.graphExplanatoryPath,
          upstreamRoleId: ANSWER_ROLE_IDS.contribution,
          requestedSlotId: GRAPH_SLOT_IDS.explanatoryPath,
          finalQuestionFit: 0.82
        }),
        fact("zeta:date", "Zeta Nadir", "data", "1901", {
          finalQuestionFit: 0.41
        }),
        fact("zeta:background", "Mapa Solar", "arquivo", "colecao tecnica", {
          relationRoleId: RELATION_ROLE_IDS.graphContextRelation,
          upstreamRoleId: ANSWER_ROLE_IDS.backgroundRelation,
          finalQuestionFit: 0.5
        })
      ]
    });

    const core = plan.selectedAnswerCore.map(row => row.factKey);
    expect(plan.questionTypeId).toBe(QUESTION_TYPE_IDS.contribution);
    expect(core).toEqual(expect.arrayContaining(["zeta:role", "zeta:atlas"]));
    expect(core).not.toContain("zeta:date");
    expect(core).not.toContain("zeta:background");
  });
});

function fact(
  factKey: string,
  subject: string,
  predicate: string,
  object: string,
  overrides: Partial<QuestionSlotFactInput> = {}
): QuestionSlotFactInput {
  return {
    factKey,
    subject,
    predicate,
    object,
    relationId: overrides.relationId ?? `relation:${factKey}`,
    forceClass: overrides.forceClass ?? "learned_concept_prior",
    score: overrides.score ?? 0.74,
    support: overrides.support ?? 0.82,
    alphaSupport: overrides.alphaSupport ?? 0.66,
    ppfSupport: overrides.ppfSupport ?? 0.58,
    semanticQuality: overrides.semanticQuality ?? 0.78,
    graphQualityClassId: overrides.graphQualityClassId,
    answerGrade: overrides.answerGrade ?? true,
    requestedSlotId: overrides.requestedSlotId,
    relationRoleId: overrides.relationRoleId,
    topicSenseId: overrides.topicSenseId ?? "topic_sense.primary",
    finalQuestionFit: overrides.finalQuestionFit ?? 0.66,
    upstreamRoleId: overrides.upstreamRoleId,
    alphaRhetoricalCentrality: overrides.alphaRhetoricalCentrality ?? 0.6
  };
}
