import { describe, expect, it } from "vitest";
import { buildQuestionCognitiveFabric, normalizeRawGraphEdgeToCognitiveEdges, questionShapeIdFromText, requestedSlotsForQuestionShape } from "../question-cognitive-edge.js";
import {
  GRAPH_QUALITY_CLASS_IDS,
  GRAPH_QUALITY_CLASS_REASON_IDS,
  GRAPH_QUALITY_REASON_IDS,
  GRAPH_SLOT_IDS,
  QUESTION_EDGE_DECISION_IDS,
  RELATION_ROLE_IDS
} from "../question-routing-ids.js";

describe("question-shaped cognitive edge fabric", () => {
  it("derives different requested slots for different question shapes", () => {
    const compact = requestedSlotsForQuestionShape(questionShapeIdFromText("Ada?"));
    const expanded = requestedSlotsForQuestionShape(questionShapeIdFromText("How did Ada Lovelace's notes about the Analytical Engine connect mathematical notation, program structure, and later computing practice?"));

    expect(compact).not.toEqual(expanded);
    expect(compact).toContain(GRAPH_SLOT_IDS.compactAttribute);
    expect(expanded).toContain(GRAPH_SLOT_IDS.explanatoryPath);
    expect(expanded).toContain(GRAPH_SLOT_IDS.contextBridge);
  });

  it("salvages long copula contribution edges for contribution questions", () => {
    const edges = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.ada.bernoulli",
      relationId: "relation.fragment",
      subject: "Ada Lovelace",
      predicate: "is",
      object: "credited with developing an algorithm that would enable the engine to calculate a sequence of Bernoulli numbers",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.4,
      alphaSupport: 0.5,
      ppfSupport: 0.4,
      supportMass: 0.8,
      selectedTopic: "Ada Lovelace",
      requestText: "Who was Ada Lovelace and what was her contribution to computer science?"
    });

    expect(edges.some(edge => edge.cognitiveEdge.normalizationIds.includes("cognitive_edge.normalization.long_copula_salvage"))).toBe(true);
    expect(edges[0]?.fit.requestedSlotId).toBe(GRAPH_SLOT_IDS.explanatoryPath);
    expect(edges[0]?.fit.decision).toBe(QUESTION_EDGE_DECISION_IDS.requestedSupport);
  });

  it("decomposes compound topic labels into graph attribute edges", () => {
    const edges = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.einstein.compound",
      relationId: "relation.fragment",
      subject: "1955 Albert Einstein German-American physicist engineer",
      predicate: "and",
      object: "academic born 1879",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.48,
      alphaSupport: 0.4,
      ppfSupport: 0.35,
      supportMass: 0.7,
      selectedTopic: "Albert Einstein",
      requestText: "Who was Albert Einstein?"
    });

    expect(edges.some(edge => edge.cognitiveEdge.normalizationIds.includes("cognitive_edge.normalization.compound_label_decomposition"))).toBe(true);
    expect(edges.some(edge => edge.fit.requestedSlotId === GRAPH_SLOT_IDS.compactAttribute || edge.fit.requestedSlotId === GRAPH_SLOT_IDS.contextBridge)).toBe(true);
  });

  it("does not let clean Star Trek metadata answer a main-character question", () => {
    const metadata = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.trek.composer",
      relationId: "relation.infobox",
      subject: "Star Trek The Original Series",
      predicate: "theme_music_composer",
      object: "Alexander Courage",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.88,
      alphaSupport: 0.6,
      ppfSupport: 0.5,
      supportMass: 0.9,
      selectedTopic: "Star Trek",
      requestText: "Who are the main characters in Star Trek?"
    });

    const fabric = buildQuestionCognitiveFabric(metadata, "Who are the main characters in Star Trek?");
    expect(metadata[0]?.fit.decision).toBe(QUESTION_EDGE_DECISION_IDS.requestedSlotMissing);
    expect(fabric.decision).toBe(QUESTION_EDGE_DECISION_IDS.requestedSlotMissing);
    expect(fabric.selectedFits).toHaveLength(0);
  });

  it("allows partial character support when the requested slot is present", () => {
    const character = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.trek.character",
      relationId: "relation.cast",
      subject: "Star Trek",
      predicate: "character",
      object: "Spock",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.78,
      alphaSupport: 0.5,
      ppfSupport: 0.5,
      supportMass: 0.8,
      selectedTopic: "Star Trek",
      requestText: "Who are the main characters in Star Trek?"
    });

    const fabric = buildQuestionCognitiveFabric(character, "Who are the main characters in Star Trek?");
    expect(character[0]?.fit.requestedSlotId).toBe(GRAPH_SLOT_IDS.requestAlignedRelation);
    expect(fabric.selectedFits.length).toBeGreaterThan(0);
    expect([QUESTION_EDGE_DECISION_IDS.requestedSupport, QUESTION_EDGE_DECISION_IDS.partialSupport]).toContain(fabric.decision);
  });

  it("decomposes topic-compound character categories into character candidates", () => {
    const edges = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.trek.odo.category",
      relationId: "relation.category",
      subject: "Odo Star Trek",
      predicate: "in-category",
      object: "Star Trek Deep Space Nine characters",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.42,
      alphaSupport: 0.5,
      ppfSupport: 0.45,
      supportMass: 0.8,
      selectedTopic: "Star Trek",
      requestText: "Who are the main characters in Star Trek?"
    });

    expect(edges.some(edge => edge.cognitiveEdge.subjectRef === "Star Trek" && edge.cognitiveEdge.objectRef === "odo" && edge.fit.requestedSlotId === GRAPH_SLOT_IDS.requestAlignedRelation)).toBe(true);
  });

  it("does not decompose category object labels into member residue", () => {
    const edges = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.trek.category.label",
      relationId: "relation.category",
      subject: "Star Trek",
      predicate: "in-category",
      object: "Star Trek the Original Series characters",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.42,
      graphQuality: categoryQuality("edge.trek.category.label"),
      alphaSupport: 0.5,
      ppfSupport: 0.45,
      supportMass: 0.8,
      selectedTopic: "Star Trek",
      requestText: "Who are the main characters in Star Trek?"
    });

    const residue = new Set(["original", "series", "characters"]);
    expect(edges.some(edge => edge.cognitiveEdge.normalizationIds.includes("cognitive_edge.normalization.compound_label_decomposition") && residue.has(edge.cognitiveEdge.objectRef))).toBe(false);
  });

  it("does not let short cue drift turn work metadata into character support", () => {
    const edges = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.trek.work",
      relationId: "relation.work",
      subject: "David's Star Trek",
      predicate: "work",
      object: "included comic books and novels",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.76,
      alphaSupport: 0.56,
      ppfSupport: 0.5,
      supportMass: 0.8,
      selectedTopic: "Star Trek",
      requestText: "Who are the main characters in Star Trek?"
    });

    expect(edges[0]?.fit.relationRoleId).not.toBe(RELATION_ROLE_IDS.characterCast);
    expect(edges[0]?.fit.decision).toBe(QUESTION_EDGE_DECISION_IDS.requestedSlotMissing);
  });

  it("does not treat a cast announcement event as a main-character answer", () => {
    const edges = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.trek.cast-announced",
      relationId: "relation.event",
      subject: "Star Trek The Next Generation",
      predicate: "was",
      object: "announced on October 10 1986 and its cast in May 1987",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.72,
      alphaSupport: 0.56,
      ppfSupport: 0.5,
      supportMass: 0.8,
      selectedTopic: "Star Trek",
      requestText: "Who are the main characters in Star Trek?"
    });

    expect(edges[0]?.fit.relationRoleId).not.toBe(RELATION_ROLE_IDS.characterCast);
    expect(edges[0]?.fit.decision).toBe(QUESTION_EDGE_DECISION_IDS.requestedSlotMissing);
  });

  it("fills diverse requested slots before selecting duplicate high-fit category rows", () => {
    const category = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.einstein.category",
      relationId: "relation.category",
      subject: "Albert Einstein",
      predicate: "in-category",
      object: "academic staff of the university of zurich",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.42,
      graphQuality: categoryQuality("edge.einstein.category"),
      alphaSupport: 0.56,
      ppfSupport: 0.5,
      supportMass: 1,
      selectedTopic: "Albert Einstein",
      requestText: "Who was Albert Einstein?"
    });
    const field = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.einstein.field",
      relationId: "relation.person.field",
      subject: "Albert Einstein",
      predicate: "fields",
      object: "physics",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.82,
      alphaSupport: 0.56,
      ppfSupport: 0.5,
      supportMass: 1,
      selectedTopic: "Albert Einstein",
      requestText: "Who was Albert Einstein?"
    });

    buildQuestionCognitiveFabric([...category, ...field], "Who was Albert Einstein?");
    expect((field[0]?.fit.finalQuestionFit ?? 0)).toBeGreaterThan(category[0]?.fit.finalQuestionFit ?? 1);
  });

  it("separates relativity senses instead of blending catalog facts", () => {
    const physics = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.relativity.physics",
      relationId: "relation.physics",
      subject: "general relativity",
      predicate: "like",
      object: "electromagnetism is a classical field theory",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.7,
      alphaSupport: 0.5,
      ppfSupport: 0.45,
      supportMass: 0.8,
      selectedTopic: "relativity",
      requestText: "What is relativity?"
    });
    const linguistic = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: "edge.relativity.linguistic",
      relationId: "relation.linguistic",
      subject: "linguistic relativity",
      predicate: "in-category",
      object: "anthropological linguistics",
      forceClass: "learned_concept_prior",
      semanticQuality: 0.42,
      alphaSupport: 0.3,
      ppfSupport: 0.2,
      supportMass: 0.7,
      selectedTopic: "relativity",
      requestText: "What is relativity?"
    });

    expect(physics[0]?.fit.topicSenseId).toMatch(/^topic_sense\.[0-9a-f]+$/);
    expect(linguistic[0]?.fit.topicSenseId).toMatch(/^topic_sense\.[0-9a-f]+$/);
    expect(physics[0]?.fit.topicSenseId).not.toBe(linguistic[0]?.fit.topicSenseId);
  });
});

function categoryQuality(edgeId: string) {
  return {
    edgeId,
    classId: GRAPH_QUALITY_CLASS_IDS.catalogNavigation,
    semanticQuality: 0.42,
    predicateQuality: 0.5,
    subjectQuality: 0.98,
    objectQuality: 0.98,
    labelCleanliness: 0.96,
    fragmentScore: 0.02,
    relationTypeUsefulness: 0.54,
    categoryNavigationScore: 0.74,
    entityCentralitySupport: 0.89,
    sourceShardSupport: 1,
    answerGrade: false,
    reasonIds: [GRAPH_QUALITY_REASON_IDS.navigationShape, GRAPH_QUALITY_CLASS_REASON_IDS[GRAPH_QUALITY_CLASS_IDS.catalogNavigation]]
  };
}
