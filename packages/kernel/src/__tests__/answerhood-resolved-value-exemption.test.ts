// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { answerCoversRequest, localEvidenceAnswerSurface, requestContentEvidenceUnits } from "../local-evidence-runtime.js";
import { resolveRequestValueBinding, type RequestValueResolver } from "../semantic-answer-construct.js";
import { extractTemporalAnswerFromEvidence } from "../semantic-obligations.js";
import { splitSurfaceSentences, tidySurfaceText } from "../surface-linguistics.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/**
 * A surface carrying a value the turn RESOLVED for the request's relation answers the request whether or not it
 * repeats the relation word. Measured on the real Ada Lovelace lead: the sentence stating "10 December 1815" does
 * not contain "born" and the sentence containing "born" does not state the date, the two are four sentences apart,
 * and only document-adjacent rows are kept -- so before this the plan could answer wrongly or not at all, never
 * correctly. The same shape is in the corpus's David Mungoshi lead, which is why both are asserted.
 *
 * The exemption is scoped to a RESOLUTION, never to containment: the caller supplies values only for the spans
 * resolveRequestValueBinding verified the value occurs in, and only a request that resolved one supplies any. The
 * admission bound is asserted over the whole fixture corpus below rather than argued.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "fixtures", "ranker-corpus.json"), "utf8")) as {
  spans: { id: string; title: string; alpha: number; text: string }[];
  requests: string[];
  closedClassWords: string[];
};
const CLOSED_CLASS = new Set(corpus.closedClassWords);
const RESOLVERS: RequestValueResolver[] = [{ id: "resolver.evidence_temporal", resolve: extractTemporalAnswerFromEvidence }];

function makeSpan(row: { id: string; title: string; alpha: number; text: string }): EvidenceSpan {
  return {
    id: row.id as EvidenceId,
    sourceVersionId: `${row.id}:v1` as SourceVersionId,
    text: row.text,
    textPreview: row.text,
    status: "promoted",
    alpha: row.alpha,
    charStart: 0,
    features: [],
    provenance: { uri: `fixture://${row.id}`, title: row.title, sourceVersionId: `${row.id}:v1`, byteRange: [0, row.text.length], charRange: [0, row.text.length], metadata: { title: row.title } }
  } as unknown as EvidenceSpan;
}

const spanByTitle = (title: string) => makeSpan(corpus.spans.find(row => row.title === title)!);
const ADA = spanByTitle("Ada Lovelace");
const MUNGOSHI = spanByTitle("david mungoshi");

function planSentences(requestText: string, span: EvidenceSpan, withBinding: boolean): string[] {
  const binding = withBinding ? resolveRequestValueBinding({ requestText, evidence: [span], resolvers: RESOLVERS }) : undefined;
  const candidate = localEvidenceAnswerSurface({
    requestText,
    selectedEvidence: [span],
    closedClassWords: CLOSED_CLASS,
    boundValues: binding ? [binding.value] : [],
    boundValueEvidenceIds: new Set(binding?.evidenceIds ?? [])
  });
  return Object.values(candidate?.plan.slotSurfaces ?? {}).flat().map(String);
}

describe("a surface carrying the request's resolved value satisfies the relation obligation", () => {
  for (const [label, span, requestText] of [
    ["Ada Lovelace", ADA, "When was Ada Lovelace born?"] as const,
    ["David Mungoshi", MUNGOSHI, "When was David Mungoshi born?"] as const
  ]) {
    it(`answers ${label} with the sentence supplying the value instead of the one repeating the relation`, () => {
      const binding = resolveRequestValueBinding({ requestText, evidence: [span], resolvers: RESOLVERS });
      expect(binding).toBeDefined();
      const value = binding!.value;
      // Stated over measured quantities: the relation unit is whatever the request asks past its own subject, and
      // the losing sentence is the one carrying it without the value. Both are read off the span, not hardcoded.
      const sentences = splitSurfaceSentences(tidySurfaceText(span.text));
      const valueBearing = sentences.filter(sentence => sentence.includes(value));
      expect(valueBearing.length).toBe(1);
      const answered = planSentences(requestText, span, true);
      expect(answered.length).toBeGreaterThan(0);
      expect(answered.some(sentence => sentence.includes(value))).toBe(true);

      // Without the resolution the plan cannot reach that sentence at all: it answers with a sentence that carries
      // no value, or it refuses outright. Either way it never carries the value. This is the losing side kept.
      const unresolved = planSentences(requestText, span, false);
      expect(unresolved.some(sentence => sentence.includes(value))).toBe(false);
    });
  }

  it("refuses the same surface when the value was resolved against a different span", () => {
    const requestText = "When was Ada Lovelace born?";
    const binding = resolveRequestValueBinding({ requestText, evidence: [ADA], resolvers: RESOLVERS })!;
    const units = requestContentEvidenceUnits(requestText).filter(unit => !CLOSED_CLASS.has(unit));
    const lead = splitSurfaceSentences(tidySurfaceText(ADA.text)).find(sentence => sentence.includes(binding.value))!;
    // Scoping is the whole difference between a resolution and a coincidence: the plan passes values only for the
    // spans the binding names, so an unscoped caller gets the gate exactly as it was.
    expect(answerCoversRequest([lead], ADA, units, requestText, { relationRequired: true })).toBe(false);
    expect(answerCoversRequest([lead], ADA, units, requestText, { relationRequired: true, boundValues: [binding.value] })).toBe(true);
    expect(binding.evidenceIds).toEqual([String(ADA.id)]);
  });

  it("changes nothing for a request that resolves no value", () => {
    // The fabrication this gate exists for: a request whose relation no resolver binds. Nothing is supplied, so
    // nothing is exempted, and the article's own lead still cannot answer it.
    const requestText = "Who was Ada Lovelace's dentist?";
    expect(resolveRequestValueBinding({ requestText, evidence: [ADA], resolvers: RESOLVERS })).toBeUndefined();
    const units = requestContentEvidenceUnits(requestText).filter(unit => !CLOSED_CLASS.has(unit));
    for (const sentence of splitSurfaceSentences(tidySurfaceText(ADA.text))) {
      expect(answerCoversRequest([sentence], ADA, units, requestText, { relationRequired: true, boundValues: [] }))
        .toBe(answerCoversRequest([sentence], ADA, units, requestText, { relationRequired: true }));
    }
  });

  it("admits exactly the sentences that carry a resolved value, and refuses nothing it used to admit", () => {
    // The admission bound, asserted rather than argued, over every (request, span, sentence) triple the fixture
    // corpus of real promoted leads produces. Newly admitted must equal value-carrying, and never exceed it.
    const spans = corpus.spans.map(makeSpan);
    let considered = 0;
    let newlyAdmitted = 0;
    let newlyRefused = 0;
    let carriesResolvedValue = 0;
    for (const requestText of corpus.requests) {
      const units = requestContentEvidenceUnits(requestText).filter(unit => !CLOSED_CLASS.has(unit));
      for (const span of spans) {
        const binding = resolveRequestValueBinding({ requestText, evidence: [span], resolvers: RESOLVERS });
        const values = binding?.evidenceIds.includes(String(span.id)) ? [binding.value] : [];
        for (const sentence of splitSurfaceSentences(tidySurfaceText(span.text))) {
          if (sentence.length < 24) continue;
          considered += 1;
          const was = answerCoversRequest([sentence], span, units, requestText, { relationRequired: true });
          const now = answerCoversRequest([sentence], span, units, requestText, { relationRequired: true, boundValues: values });
          if (!was && now) newlyAdmitted += 1;
          if (was && !now) newlyRefused += 1;
          if (!was && values.some(value => sentence.includes(value))) carriesResolvedValue += 1;
        }
      }
    }
    expect(considered).toBeGreaterThan(100);
    expect(newlyRefused).toBe(0);
    // Carrying the value is necessary, never sufficient: the exemption lifts the relation obligation only, and the
    // subject obligation still refuses one of the three carriers here -- "When was the Sociedade Brasileira de
    // Belas Artes founded?" against the Müjde Uzman lead, a different source that happens to state the same date.
    // That is the cross-source fabrication the gate exists for, and it stays refused.
    expect(newlyAdmitted).toBeLessThan(carriesResolvedValue);
    // Measured 2026-09-16 on these fixtures: 304 triples, 74 admitted before, 76 after, 3 carriers. The counts are
    // pinned so a widening of the exemption cannot arrive quietly.
    expect(carriesResolvedValue).toBe(3);
    expect(newlyAdmitted).toBe(2);
  });
});
