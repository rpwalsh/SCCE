// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { extractTemporalAnswerFromEvidence } from "../semantic-obligations.js";
import type { EvidenceSpan } from "../types.js";

function span(id: string, text: string): EvidenceSpan {
  return {
    id,
    sourceId: "source.academy",
    sourceVersionId: "source_version.academy",
    text,
    textPreview: text.slice(0, 120),
    charStart: 0,
    charEnd: text.length,
    alpha: 0.8,
    forceClass: "direct_evidence",
    metadata: {}
  } as unknown as EvidenceSpan;
}

describe("a temporal answer is read in the source's own order", () => {
  // Measured live 2026-09-13 on reference:academy-first-year. The span states the date in its eleventh sentence and a
  // broadcast clock time in its seventeenth; the turn answered "11:00".
  const academy = [
    "The Academy Awards, known as the Oscars, are awards for artistic and technical merit in film.",
    "The first Academy Awards presentation was held on May 16, 1929 at a private dinner function at the Hollywood Roosevelt Hotel.",
    "The ceremony ran for 15 minutes.",
    "For the second ceremony, the results were given to newspapers for publication at 11:00 pm on the night of the awards."
  ].join(" ");

  it("answers with the date the source states first, not with whichever pattern matched first", () => {
    expect(extractTemporalAnswerFromEvidence(
      "In what year was the first Academy Awards ceremony held?",
      [span("evidence.academy", academy)]
    )).toBe("May 16, 1929");
  });

  it("still reads a lead's two dates as the pair the source wrote them in", () => {
    const lead = "Albert Einstein (14 March 1879 - 18 April 1955) was a theoretical physicist, and the clock at 11:00 is not one of his dates.";
    expect(extractTemporalAnswerFromEvidence("When was Albert Einstein born?", [span("evidence.einstein", lead)])).toBe("14 March 1879");
    expect(extractTemporalAnswerFromEvidence("When did Albert Einstein die?", [span("evidence.einstein", lead)])).toBe("18 April 1955");
  });

  it("says nothing when the evidence carries no date at all", () => {
    expect(extractTemporalAnswerFromEvidence(
      "In what year was the first Academy Awards ceremony held?",
      [span("evidence.none", "The Academy Awards are awards for artistic and technical merit in film.")]
    )).toBeUndefined();
  });
});
