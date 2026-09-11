// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { assistantForceDecision, unresolvedObligationCount } from "../assistant-force.js";
import { answerCoversRequest, requestUnitSharesStem } from "../local-evidence-runtime.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/** Aboutness is the title's; answerhood is the sentence's. The relation asked about must be carried by the sentence that names the subject. */
describe("answerhood gate", () => {
  const apollo = span("evidence:apollo", "Apollo 11", "unused");

  it("requires the relation asked about, not only the subject, once the closed class is learned", () => {
    const units = ["commanded", "apollo"];
    const songs = "The Apollo 11 landing is referenced in the songs Armstrong, Aldrin and Collins by the Byrds.";
    const lodging = "Lodging near Cape Canaveral was reported as being booked months ahead for the launch.";
    const eagle = "Commander Neil Armstrong and lunar module pilot Buzz Aldrin landed the Apollo Lunar Module Eagle on July 20, 1969.";
    const commander = "Neil Armstrong was the commander of Apollo 11.";
    expect(answerCoversRequest([songs], apollo, units, "Who commanded Apollo 11?", { relationRequired: true })).toBe(false);
    expect(answerCoversRequest([lodging], apollo, units, "Who commanded Apollo 11?", { relationRequired: true })).toBe(false);
    // Apollo does not name Apollo 11: the numeric qualifier must be in the sentence too.
    expect(answerCoversRequest([eagle], apollo, units, "Who commanded Apollo 11?", { relationRequired: true })).toBe(false);
    expect(answerCoversRequest([commander], apollo, units, "Who commanded Apollo 11?", { relationRequired: true })).toBe(true);
    const project = "The effort to land a man on the Moon already had a name: Project Apollo.";
    const landing = "Apollo 11 was the American spaceflight that first landed humans on the Moon, on July 20, 1969.";
    expect(answerCoversRequest([project], apollo, ["apollo", "land", "moon"], "When did Apollo 11 land on the Moon?", { relationRequired: true })).toBe(false);
    expect(answerCoversRequest([landing], apollo, ["apollo", "land", "moon"], "When did Apollo 11 land on the Moon?", { relationRequired: true })).toBe(true);
  });

  it("binds the relation to the subject in the sentence itself, not to the article title", () => {
    const einstein = span("evidence:einstein", "Albert Einstein", "unused");
    const units = ["albert", "einstein", "born"];
    const lead = "Albert Einstein was born in Ulm, in the Kingdom of Württemberg in the German Empire, on 14 March 1879.";
    const eduard = "Their son Eduard was born in Zurich in July 1910.";
    expect(answerCoversRequest([lead], einstein, units, "When was Albert Einstein born?", { relationRequired: true })).toBe(true);
    expect(answerCoversRequest([eduard], einstein, units, "When was Albert Einstein born?", { relationRequired: true })).toBe(false);
  });

  it("resolves an anaphoric answering sentence from the one sentence before it in the same span, real corpus shape", () => {
    // Verbatim shape of the live regression: the commander sentence never restates "Apollo 11", the lead sentence
    // immediately before it does. Rejecting the commander sentence here is what made "Who commanded Apollo 11?"
    // answer empty on the live brain even though the corpus states it plainly.
    const article = span(
      "evidence:apollo-live",
      "Apollo 11",
      "'Apollo 11' (July 16-24, 1969) was the fifth crewed flight in the United States Apollo program and the first spaceflight to land humans on the Moon. Commander Neil Armstrong and Lunar Module Pilot Edwin \"Buzz\" Aldrin landed the Lunar Module 'Eagle' on July 20 at 20:17 UTC, and Armstrong became the first person to step onto the surface."
    );
    const units = ["commanded", "apollo"];
    const commanderSentence = "Commander Neil Armstrong and Lunar Module Pilot Edwin \"Buzz\" Aldrin landed the Lunar Module 'Eagle' on July 20 at 20:17 UTC, and Armstrong became the first person to step onto the surface.";
    expect(answerCoversRequest([commanderSentence], article, units, "Who commanded Apollo 11?", { relationRequired: true })).toBe(true);
  });

  it("does not widen past a sentence naming a different subject, real corpus shape", () => {
    // Verbatim shape of the Eduard regression this replaced: the sentence immediately before Eduard's birth is about
    // a different son (Hans Albert), so "Einstein" is still not one sentence back and the answer stays rejected.
    const article = span(
      "evidence:einstein-live",
      "Albert Einstein",
      "Einstein and Maric married in January 1903. In May 1904, their son Hans Albert was born in Bern, Switzerland. Their son Eduard was born in Zurich in July 1910."
    );
    const units = ["albert", "einstein", "born"];
    const eduardSentence = "Their son Eduard was born in Zurich in July 1910.";
    expect(answerCoversRequest([eduardSentence], article, units, "When was Albert Einstein born?", { relationRequired: true })).toBe(false);
  });

  it("keeps the quota when no learned closed class can tell scaffolding from relation", () => {
    const vega = span("evidence:vega", "Armand Vega", "unused");
    const sentence = "The calculating apparatus was designed and refined by the pioneering mathematician Armand Vega.";
    expect(answerCoversRequest([sentence], vega, ["what", "armand", "vega", "known"], "What was Armand Vega known for?")).toBe(true);
  });

  it("tolerates inflection when matching the relation", () => {
    expect(requestUnitSharesStem("commanded", "commander")).toBe(true);
    expect(requestUnitSharesStem("land", "landed")).toBe(true);
    expect(requestUnitSharesStem("develop", "developing")).toBe(true);
    expect(requestUnitSharesStem("born", "byrds")).toBe(false);
    expect(requestUnitSharesStem("moon", "months")).toBe(false);
  });

  it("counts unresolved obligations from the proof boundaries and withholds certification over them", () => {
    expect(unresolvedObligationCount(["underdetermined-obligations:34", "missing-role:1a2b", "source-excerpt-exact"])).toBe(35);
    expect(unresolvedObligationCount([])).toBe(0);
    const evidenceIds = ["evidence:apollo" as EvidenceId];
    const certified = assistantForceDecision({ requestedAuthority: "factual", epistemicForce: "proved", proofVerdict: "scce.verdict.002", evidenceIds, directEvidenceIds: evidenceIds, support: 0.9, unresolvedObligations: 0 });
    const open = assistantForceDecision({ requestedAuthority: "factual", epistemicForce: "proved", proofVerdict: "scce.verdict.002", evidenceIds, directEvidenceIds: evidenceIds, support: 0.9, unresolvedObligations: 2 });
    expect(certified.force).toBe("certified_fact");
    expect(open.force).toBe("source_grounded_answer");
    expect(open.reasonIds).toContain("assistant_force.unresolved_obligations");
  });
});

function span(id: string, title: string, text: string): EvidenceSpan {
  return {
    id: id as EvidenceId,
    sourceVersionId: `${id}:v1` as SourceVersionId,
    text,
    textPreview: text,
    status: "promoted",
    alpha: 0.9,
    provenance: { uri: `fixture://${id}`, title, sourceVersionId: `${id}:v1`, byteRange: [0, text.length], charRange: [0, text.length], metadata: { title } }
  } as unknown as EvidenceSpan;
}
