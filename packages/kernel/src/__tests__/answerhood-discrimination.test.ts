// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { answerCoversRequest, evidenceDiscriminatesAskedRelation, requestRelationBeyondSourceIdentity } from "../local-evidence-runtime.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/**
 * An empty relation obligation is not a satisfied one.
 *
 * Measured live 2026-09-13 on the abstention workload: 44 of 59 unanswerable questions were answered with a
 * topically related corpus sentence. The gate meant to require the asked relation subtracted the request's named
 * anchors from its content units, and those anchors are the request's maximal content runs whenever the corpus
 * attests no identity for them -- so "Albert Einstein's dentist" was one run, the subtraction returned nothing to
 * require, and the article's own lead passed as the answer to who his dentist was.
 */
describe("answerhood discrimination", () => {
  // The language's own scaffolding, the shape deriveClosedClassWords returns from a hydrated model.
  const closedClass = new Set(["the", "of", "and", "in", "to", "a", "was", "is", "for", "as", "on", "that", "his", "with", "by"]);

  it("refuses a subject-only sentence when the request asks past what the source is about", () => {
    const einstein = openingBlock(
      "evidence:einstein-lead",
      "Albert Einstein",
      "'Albert Einstein' (14 March 1879 - 18 April 1955) was a German-born theoretical physicist best known for developing the theory of relativity. Einstein also made important contributions to quantum theory."
    );
    const lead = "'Albert Einstein' (14 March 1879 - 18 April 1955) was a German-born theoretical physicist best known for developing the theory of relativity.";
    const request = "Who was Albert Einstein's dentist?";
    const units = ["albert", "einstein's", "dentist"];
    expect(answerCoversRequest([lead], einstein, units, request, { relationRequired: true, languageClosedClassWords: closedClass })).toBe(false);
  });

  it("refuses when the caller's coverage units are already a subset of the subject", () => {
    // "Who won the 1998 FIFA World Cup?" reached the mouth as {fifa, world}: the request-scoped closed class had
    // already eaten "1998", so subtracting the subject left nothing at all and the tournament's own definition
    // answered who won one of them.
    const worldCup = openingBlock(
      "evidence:fifa-lead",
      "FIFA World Cup",
      "The 'FIFA World Cup' is an international association football competition among the senior men's national teams of the members of FIFA."
    );
    const definition = "The 'FIFA World Cup' is an international association football competition among the senior men's national teams of the members of FIFA.";
    const request = "Who won the 1998 FIFA World Cup?";
    expect(answerCoversRequest([definition], worldCup, ["fifa", "world"], request, { relationRequired: true, languageClosedClassWords: closedClass })).toBe(false);
  });

  it("still answers a request that asks about the source's own subject", () => {
    const alchemy = openingBlock(
      "evidence:alchemy-lead",
      "Alchemy",
      "In its Western form, alchemy is first attested in a number of pseudepigraphical texts written in Greco-Roman Egypt."
    );
    const sentence = "In its Western form, alchemy is first attested in a number of pseudepigraphical texts written in Greco-Roman Egypt.";
    expect(answerCoversRequest([sentence], alchemy, ["alchemy"], "What is alchemy?", { relationRequired: true, languageClosedClassWords: closedClass })).toBe(true);
  });

  it("leaves a non-empty relation obligation exactly as it was", () => {
    // The relation is present in the units, so nothing is re-derived and the sentence passes on the old rule.
    const einstein = openingBlock(
      "evidence:einstein-born",
      "Albert Einstein",
      "Albert Einstein was born in Ulm, in the Kingdom of Wuerttemberg in the German Empire, on 14 March 1879."
    );
    const lead = "Albert Einstein was born in Ulm, in the Kingdom of Wuerttemberg in the German Empire, on 14 March 1879.";
    expect(answerCoversRequest([lead], einstein, ["albert", "einstein", "born"], "When was Albert Einstein born?", { relationRequired: true, languageClosedClassWords: closedClass })).toBe(true);
  });

  it("is silent for a caller that cannot tell scaffolding from relation", () => {
    // No language closed class means no obligation can be read off the request, and the gate behaves as before.
    const einstein = openingBlock(
      "evidence:einstein-lead-2",
      "Albert Einstein",
      "'Albert Einstein' (14 March 1879 - 18 April 1955) was a German-born theoretical physicist."
    );
    const lead = "'Albert Einstein' (14 March 1879 - 18 April 1955) was a German-born theoretical physicist.";
    expect(answerCoversRequest([lead], einstein, ["albert", "einstein's", "dentist"], "Who was Albert Einstein's dentist?", { relationRequired: true })).toBe(true);
  });

  it("reads the asked relation off the source's own identity", () => {
    const einstein = openingBlock("evidence:einstein-id", "Albert Einstein", "unused");
    expect(requestRelationBeyondSourceIdentity("Who was Albert Einstein's dentist?", einstein, closedClass)).toEqual(["dentist"]);
    expect(requestRelationBeyondSourceIdentity("What was Albert Einstein's shoe size?", einstein, closedClass)).toEqual(["shoe", "size"]);
    expect(requestRelationBeyondSourceIdentity("Who was Albert Einstein?", einstein, closedClass)).toEqual([]);
    const mongolia = openingBlock("evidence:inner-mongolia", "2020 Inner Mongolia protests", "unused");
    expect(requestRelationBeyondSourceIdentity("What is the capital city of Mongolia?", mongolia, closedClass)).toEqual(["capital", "city"]);
    // The year is the whole question and the tournament's title does not carry it.
    const worldCup = openingBlock("evidence:fifa-id", "FIFA World Cup", "unused");
    expect(requestRelationBeyondSourceIdentity("Who won the 1998 FIFA World Cup?", worldCup, closedClass)).toEqual(["1998"]);
  });

  it("withholds a source summary that carries none of the asked relation", () => {
    const einstein = openingBlock("evidence:einstein-summary", "Albert Einstein", "unused");
    const summary = "Einstein also made important contributions to quantum theory. Born in the German Empire, Einstein moved to Switzerland in 1895.";
    expect(evidenceDiscriminatesAskedRelation(summary, einstein, "What was Albert Einstein's shoe size?", closedClass)).toBe(false);
    expect(evidenceDiscriminatesAskedRelation(summary, einstein, "Who was Albert Einstein?", closedClass)).toBe(true);
    const born = "Albert Einstein was born in Ulm on 14 March 1879.";
    expect(evidenceDiscriminatesAskedRelation(born, einstein, "When was Albert Einstein born?", closedClass)).toBe(true);
  });
});

/** A source's opening block: the offset that says it opens the document, which is what a titled lead is. */
function openingBlock(id: string, title: string, text: string): EvidenceSpan {
  return {
    id: id as EvidenceId,
    sourceVersionId: `${id}:v1` as SourceVersionId,
    text,
    textPreview: text,
    status: "promoted",
    alpha: 0.9,
    charStart: 0,
    provenance: { uri: `fixture://${id}`, title, sourceVersionId: `${id}:v1`, byteRange: [0, text.length], charRange: [0, text.length], metadata: { title } }
  } as unknown as EvidenceSpan;
}
