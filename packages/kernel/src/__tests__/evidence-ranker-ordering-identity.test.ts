// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { localEvidenceAnswerClaimSurface, localEvidenceAnswerSurface, preferredLocalEvidenceAnswer, proposeSourceExactEvidenceAnswer } from "../local-evidence-runtime.js";
import { resolveRequestValueBinding } from "../semantic-answer-construct.js";
import { tidySurfaceText } from "../surface-linguistics.js";
import { primeLearnedAnswerUnitForms } from "../learned-answer-unit-forms.js";
import { sourceOwnedAnswerUnitForms } from "./fixtures/source-owned-answer-unit-forms.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/**
 * One source selector. The historical golden stays immutable; changed cases must satisfy explicit owned values.
 */

const here = fileURLToPath(new URL(".", import.meta.url));
const corpus = JSON.parse(readFileSync(join(here, "fixtures", "ranker-corpus.json"), "utf8")) as {
  spans: { id: string; title: string; alpha: number; text: string }[];
  requests: string[];
  closedClassWords: string[];
};
const snapshotPath = join(here, "fixtures", "ranker-ordering-snapshot.json");
const CLOSED_CLASS = new Set(corpus.closedClassWords);

// Typed selected-answer annotations, not request parsing rules or source-text changes.
const SEMANTIC_CASES = [
  { request: "When was Ada Lovelace born?", ownerIndex: 5, value: "10 December 1815", role: "date", forbidden: "Lord Byron separated" },
  { request: "When was David Mungoshi born?", ownerIndex: 4, value: "30 September 1949", role: "date", forbidden: "He learnt Zulu" },
  { request: "What is the SCG 004?", ownerIndex: 1, value: "sports car", role: "category", forbidden: "second model" },
  { request: "What is the Dolphin 15 Senior made of?", ownerIndex: 0, value: "fiberglass", role: "material", forbidden: "first built in 1964" }
];
const CHANGED_CASE_KEYS = new Set(SEMANTIC_CASES.flatMap(test => ["pool", `span${test.ownerIndex}`].map(pool => `${test.request} :: ${pool}`)));


function span(row: { id: string; title: string; alpha: number; text: string }): EvidenceSpan {
  return {
    id: row.id as EvidenceId,
    sourceVersionId: `${row.id}:v1` as SourceVersionId,
    text: row.text,
    textPreview: row.text,
    status: "promoted",
    alpha: row.alpha,
    charStart: 0,
    features: [],
    provenance: {
      uri: `fixture://${row.id}`,
      title: row.title,
      sourceVersionId: `${row.id}:v1`,
      byteRange: [0, row.text.length],
      charRange: [0, row.text.length],
      metadata: { title: row.title }
    }
  } as unknown as EvidenceSpan;
}

/** What the source-exact ranker's own ordering selected, with the score and source position it selected on. */
function proposalSelection(requestText: string, spans: readonly EvidenceSpan[]): unknown {
  const proposal = proposeSourceExactEvidenceAnswer({ requestText, selectedEvidence: spans, closedClassWords: CLOSED_CLASS });
  if (!proposal) return null;
  const audit = proposal.plan.audit as Record<string, unknown>;
  return {
    sentences: Object.values(proposal.plan.slotSurfaces).flat(),
    score: audit.proposalScore,
    index: audit.proposalSentenceIndex,
    nearDuplicate: audit.nearDuplicate,
    evidenceIds: audit.evidenceIds
  };
}

function measure(): Record<string, unknown> {
  const spans = corpus.spans.map(span);
  const measured: Record<string, unknown> = {};
  for (const requestText of corpus.requests) {
    // Each span alone, and the whole pool: cross-span source affinity only engages with siblings present.
    for (const [label, pool] of [["pool", spans] as const, ...spans.map((one, index) => [`span${index}`, [one]] as const)]) {
      measured[`${requestText} :: ${label}`] = {
        proposal: proposalSelection(requestText, pool)
      };
      const input = { requestText, selectedEvidence: pool, closedClassWords: CLOSED_CLASS };
      const planned = localEvidenceAnswerSurface(input);
      const proposed = proposeSourceExactEvidenceAnswer(input);
      expect(planned?.plan.slotSurfaces, `${requestText} :: ${label}`).toEqual(proposed?.plan.slotSurfaces);
      expect(planned?.plan.proofExcerpts, `${requestText} :: ${label}`).toEqual(proposed?.plan.proofExcerpts);
      expect(planned?.evidence.map(span => String(span.id)), `${requestText} :: ${label}`).toEqual(proposed?.evidence.map(span => String(span.id)));
    }
  }
  return measured;
}

describe("one source selection policy", () => {
  it("preserves unchanged historical proposals and gives the ordinary plan the same content and owners", () => {
    const measured = measure();
    const historical = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, { proposal: unknown }>;
    expect(Object.keys(measured).sort()).toEqual(Object.keys(historical).sort());
    expect(CHANGED_CASE_KEYS.size).toBe(8);
    const strictFormScores = new Map([
      ["When was Müjde Uzman born? :: pool", 8.15590361445783], ["When was Müjde Uzman born? :: span2", 8.15590361445783],
      ["Who designed the Dolphin 15 Senior? :: pool", 8.138333333333334], ["Who designed the Dolphin 15 Senior? :: span0", 8.138333333333334]
    ]);
    for (const [key, score] of strictFormScores) {
      const previous = historical[key]!.proposal as Record<string, unknown>;
      expect(measured[key]).toEqual({ proposal: { ...previous, score } });
    }
    const untaught = new Set(["Where did David Mungoshi teach? :: pool", "Where did David Mungoshi teach? :: span4"]);
    for (const key of untaught) {
      expect(JSON.stringify(historical[key])).toContain("novelist, actor, poet and teacher");
      expect(measured[key]).toEqual({ proposal: null });
    }
    const unchanged = (entries: Array<[string, unknown]>) => Object.fromEntries(entries.filter(([key]) => !CHANGED_CASE_KEYS.has(key) && !strictFormScores.has(key) && !untaught.has(key)));
    const recorded = Object.entries(historical).map(([key, row]): [string, unknown] => [key, { proposal: row.proposal }]);
    expect(unchanged(Object.entries(measured))).toEqual(unchanged(recorded));
  });

  it("answers Mungoshi's teaching location through morphology actually induced from its source", () => {
    const owner = span(corpus.spans[4]!);
    const teaching = sourceOwnedAnswerUnitForms(owner.text);
    expect(teaching.state.structuralDeltas?.some(delta => delta.surface.from === "teach" && delta.surface.to === "teaching")).toBe(true);
    teaching.prime();
    try {
      const selected = localEvidenceAnswerSurface({ requestText: "Where did David Mungoshi teach?", selectedEvidence: [owner], closedClassWords: CLOSED_CLASS, functionSymbols: CLOSED_CLASS });
      expect(selected).toBeDefined();
      const answer = localEvidenceAnswerClaimSurface(selected!);
      expect(answer).toBe("Mungoshi was a teacher for most of his life, and taught at various institutions, including the University of Zimbabwe.");
      expect(answer).not.toContain("novelist, actor, poet and teacher");
      expect(selected!.evidence.map(row => row.id)).toEqual([owner.id]);
      expect(tidySurfaceText(owner.text)).toContain(answer);
    } finally { primeLearnedAnswerUnitForms({ deltas: [], profileIds: new Set() }); }
  });

  it.each(SEMANTIC_CASES.flatMap(test => ["pool", "owner"].map(pool => ({ ...test, pool }))))(
    "answers $request from the selected $role and its source owner ($pool)", test => {
      const spans = corpus.spans.map(span);
      const owner = spans[test.ownerIndex]!;
      const evidence = test.pool === "pool" ? spans : [owner];
      const binding = resolveRequestValueBinding({ requestText: test.request, evidence,
        resolvers: [{ id: "fixture.selected_typed_answer", resolve: () => ({ subject: corpus.spans[test.ownerIndex]!.title,
          relation: test.role, value: test.value, evidenceIds: [String(owner.id)] }) }] });
      expect(binding).toMatchObject({ value: test.value, evidenceIds: [String(owner.id)] });
      const input = { requestText: test.request, selectedEvidence: evidence, closedClassWords: CLOSED_CLASS,
        functionSymbols: CLOSED_CLASS, boundValues: [binding!.value], boundValueEvidenceIds: new Set(binding!.evidenceIds) };
      const planned = localEvidenceAnswerSurface(input);
      const proposed = proposeSourceExactEvidenceAnswer(input);
      expect(planned).toBeDefined();
      expect(proposed).toBeDefined();
      expect(localEvidenceAnswerClaimSurface(planned!)).toContain(test.value);
      expect(localEvidenceAnswerClaimSurface(planned!)).not.toContain(test.forbidden);
      expect(planned!.plan.proofExcerpts).toEqual(proposed!.plan.proofExcerpts);
      expect(planned!.evidence.map(row => String(row.id))).toEqual([String(owner.id)]);
      expect(planned!.plan.proofExcerpts!.length).toBeGreaterThan(0);
      for (const excerpt of planned!.plan.proofExcerpts ?? []) {
        expect(excerpt.evidenceId).toBe(owner.id);
        expect(tidySurfaceText(owner.text)).toContain(excerpt.text);
      }
      const early = proposeSourceExactEvidenceAnswer({ requestText: test.request, selectedEvidence: evidence, closedClassWords: CLOSED_CLASS });
      expect(preferredLocalEvidenceAnswer(planned, early)).toBe(planned);
      expect(resolveRequestValueBinding({ requestText: test.request, evidence: evidence.filter(row => row.id !== owner.id),
        resolvers: [{ id: "fixture.selected_typed_answer", resolve: () => ({ value: test.value, evidenceIds: [String(owner.id)] }) }] })).toBeUndefined();
    });
});
