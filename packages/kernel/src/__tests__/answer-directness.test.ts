// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { directAnswerSentences } from "../local-evidence-runtime.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/**
 * An answer that contains the fact is not the same as an answer that states it.
 *
 * Measured over the frozen baseline's own correct answers 2026-09-13: 37% of them reach the expected fact inside
 * their first 60 characters, against the reference model's 60%. The grader scores by substring containment, so a
 * passage whose second sentence holds the answer scores exactly like a sentence that gives it. "What is the
 * capital of Algeria?" was answered "With a population of over 47 million, Algeria is the tenth-most populous
 * country in Africa. Its capital and largest city is Algiers."
 */
describe("an answer leads with the sentence that was asked for", () => {
  const closedClass = new Set(["the", "of", "and", "in", "to", "a", "was", "is", "for", "as", "on", "that", "with", "by", "its"]);

  const ALGIERS = "Its capital and largest city is Algiers.";
  const POPULATION = "With a population of over 47 million, Algeria is the tenth-most populous country in Africa.";

  it("drops the sentences that carry none of the relation asked past the source", () => {
    expect(directAnswerSentences({
      sentences: [POPULATION, ALGIERS],
      evidence: [openingBlock("evidence:algeria", "Algeria", `${POPULATION} ${ALGIERS}`)],
      requestText: "What is the capital of Algeria?",
      planCoverageUnits: ["algeria", "capital"],
      closedClassWords: closedClass,
      functionSymbols: closedClass,
      nearDuplicate: false
    })).toEqual([ALGIERS]);
  });

  it("keeps every sentence when none of them leads", () => {
    // Nothing of the asked relation is stated by either sentence, so the carriage is equal and there is no head to
    // speak. The answer is what the ranker produced.
    const span = openingBlock("evidence:algeria-2", "Algeria", `${POPULATION} Algeria's territory has been a crossroads of cultures.`);
    const sentences = [POPULATION, "Algeria's territory has been a crossroads of cultures."];
    expect(directAnswerSentences({
      sentences,
      evidence: [span],
      requestText: "What is the capital of Algeria?",
      planCoverageUnits: ["algeria", "capital"],
      closedClassWords: closedClass,
      functionSymbols: closedClass,
      nearDuplicate: false
    })).toEqual(sentences);
  });

  it("keeps every sentence when the request asks about the source's own subject", () => {
    // The relation past the source's identity is empty, so there is nothing to lead on and a definitional answer
    // keeps the whole passage it always had.
    const span = openingBlock("evidence:algeria-3", "Algeria", `${POPULATION} ${ALGIERS}`);
    expect(directAnswerSentences({
      sentences: [POPULATION, ALGIERS],
      evidence: [span],
      requestText: "What is Algeria?",
      planCoverageUnits: ["algeria"],
      closedClassWords: closedClass,
      functionSymbols: closedClass,
      nearDuplicate: false
    })).toEqual([POPULATION, ALGIERS]);
  });

  it("never narrows a near-duplicate request, which is answered by restating what it quoted", () => {
    expect(directAnswerSentences({
      sentences: [POPULATION, ALGIERS],
      evidence: [openingBlock("evidence:algeria-4", "Algeria", `${POPULATION} ${ALGIERS}`)],
      requestText: "What is the capital of Algeria?",
      planCoverageUnits: ["algeria", "capital"],
      closedClassWords: closedClass,
      functionSymbols: closedClass,
      nearDuplicate: true
    })).toEqual([POPULATION, ALGIERS]);
  });

  it("keeps the passage when the shortened answer would not satisfy answerhood", () => {
    // The leading sentence carries the relation but names nothing of the subject and sits deep in the article, so
    // the gate refuses it alone. Narrowing must not convert an answer into a decline.
    const deep = midArticle(
      "evidence:einstein-deep",
      "Albert Einstein",
      "Their son Eduard was born in Zurich in July 1910. He studied at the university."
    );
    const sentences = ["He studied at the university.", "Their son Eduard was born in Zurich in July 1910."];
    const out = directAnswerSentences({
      sentences,
      evidence: [deep],
      requestText: "When was Albert Einstein born?",
      planCoverageUnits: ["albert", "einstein", "born"],
      closedClassWords: closedClass,
      functionSymbols: closedClass,
      nearDuplicate: false
    });
    expect(out).toEqual(sentences);
  });
});

/** A source's opening block: the offset that says it opens the document, which is what a titled lead is. */
function openingBlock(id: string, title: string, text: string): EvidenceSpan {
  return span(id, title, text, 0);
}

/** A chunk cut from the middle of an article: no titled lead to stand in for the subject. */
function midArticle(id: string, title: string, text: string): EvidenceSpan {
  return span(id, title, text, 8182);
}

function span(id: string, title: string, text: string, charStart: number): EvidenceSpan {
  return {
    id: id as EvidenceId,
    sourceVersionId: `${id}:v1` as SourceVersionId,
    text,
    textPreview: text,
    status: "promoted",
    alpha: 0.9,
    charStart,
    provenance: { uri: `fixture://${id}`, title, sourceVersionId: `${id}:v1`, byteRange: [0, text.length], charRange: [charStart, charStart + text.length], metadata: { title } }
  } as unknown as EvidenceSpan;
}
