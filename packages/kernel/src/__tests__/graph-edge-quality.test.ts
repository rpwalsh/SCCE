import { describe, expect, it } from "vitest";
import { scoreGraphEdgeQuality } from "../graph-edge-quality.js";
import { GRAPH_QUALITY_CLASS_IDS, GRAPH_QUALITY_REASON_IDS } from "../question-routing-ids.js";

describe("graph edge quality", () => {
  it("keeps compact semantic relations answer-grade", () => {
    const quality = scoreGraphEdgeQuality({
      edgeId: "edge.clean.field",
      relationId: "relation.person.field",
      subject: "Albert Einstein",
      predicate: "field",
      object: "physics",
      weight: 0.92,
      alpha: 0.7,
      forceClass: "learned_concept_prior"
    });

    expect(quality.classId).toBe(GRAPH_QUALITY_CLASS_IDS.answerGrade);
    expect(quality.answerGrade).toBe(true);
    expect(quality.semanticQuality).toBeGreaterThan(0.6);
  });

  it("demotes ultra-light predicate fragments", () => {
    const quality = scoreGraphEdgeQuality({
      edgeId: "edge.dirty.according",
      relationId: "relation.fragment",
      subject: "according",
      predicate: "to",
      object: "Albert Einstein's theory of relativity",
      weight: 1,
      alpha: 0.6,
      forceClass: "learned_concept_prior"
    });

    expect(quality.classId).toBe(GRAPH_QUALITY_CLASS_IDS.weakFragment);
    expect(quality.answerGrade).toBe(false);
    expect(quality.reasonIds).toContain(GRAPH_QUALITY_REASON_IDS.functionPredicate);
  });

  it("keeps compact contribution relations when endpoints are clean", () => {
    const quality = scoreGraphEdgeQuality({
      edgeId: "edge.ada.wrote",
      relationId: "relation.person.contribution",
      subject: "Ada Lovelace",
      predicate: "wrote",
      object: "notes about the Analytical Engine",
      weight: 0.88,
      alpha: 0.62,
      forceClass: "learned_concept_prior"
    });

    expect(quality.classId).toBe(GRAPH_QUALITY_CLASS_IDS.answerGrade);
    expect(quality.answerGrade).toBe(true);
    expect(quality.semanticQuality).toBeGreaterThan(0.58);
  });

  it("does not promote long fragment objects just because a topic is present", () => {
    const quality = scoreGraphEdgeQuality({
      edgeId: "edge.fragment.kept",
      relationId: "relation.fragment",
      subject: "Albert Einstein",
      predicate: "kept",
      object: "a long quoted biographical fragment with incidental context and multiple trailing pieces about unrelated surrounding article text",
      weight: 0.95,
      alpha: 0.7,
      forceClass: "learned_concept_prior"
    });

    expect(quality.answerGrade).toBe(false);
  });

  it("rejects low-information subjects even when the object mentions the topic", () => {
    const quality = scoreGraphEdgeQuality({
      edgeId: "edge.low.subject",
      relationId: "relation.fragment",
      subject: "the",
      predicate: "photo",
      object: "includes Albert Einstein as a visiting guest",
      weight: 1,
      alpha: 0.6,
      forceClass: "learned_concept_prior"
    });

    expect(quality.answerGrade).toBe(false);
    expect(quality.reasonIds).toContain(GRAPH_QUALITY_REASON_IDS.lowInformationSubject);
  });

  it("separates category navigation from answer-grade relations", () => {
    const quality = scoreGraphEdgeQuality({
      edgeId: "edge.category.medal",
      relationId: "relation.category",
      subject: "Murray Gell-Mann",
      predicate: "in-category",
      object: "Albert Einstein medal recipients",
      weight: 1,
      alpha: 0.6,
      forceClass: "learned_concept_prior"
    });

    expect(quality.classId).toBe(GRAPH_QUALITY_CLASS_IDS.catalogNavigation);
    expect(quality.answerGrade).toBe(false);
  });

  it("marks markup-heavy fragments as noisy", () => {
    const quality = scoreGraphEdgeQuality({
      edgeId: "edge.noisy.markup",
      relationId: "relation.fragment",
      subject: "{{Infobox scientist",
      predicate: "the",
      object: "[[Albert Einstein]] {{citation needed}}",
      weight: 1,
      alpha: 0.6,
      forceClass: "learned_concept_prior"
    });

    expect(quality.classId).toBe(GRAPH_QUALITY_CLASS_IDS.noisyMarkup);
    expect(quality.answerGrade).toBe(false);
    expect(quality.semanticQuality).toBeLessThan(0.2);
  });
});
