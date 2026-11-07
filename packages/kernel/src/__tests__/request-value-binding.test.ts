// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { compileRealizationContract, resolveRequestValueBinding, type RequestValueResolver } from "../semantic-answer-construct.js";
import { extractTemporalAnswerFromEvidence } from "../semantic-obligations.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/**
 * The turn resolves the request's value binding ONCE, against the evidence admitted for the request, and the
 * realization contract reads that binding rather than re-deriving it after selection has already narrowed the
 * evidence. Measured over `candidate.selected_evidence` against `kernel.turn.basis_answer` in the local traces:
 * of 1,675 turns that reached a basis answer, 267 had their selected evidence narrowed by the answer they had
 * already chosen -- and the first of them drops the Ada Lovelace lead span, which is the only span carrying the
 * value. Resolving after that narrowing is resolving from the evidence the wrong sentence left behind.
 */

const ADA_LEAD = "'Augusta Ada King, Countess of Lovelace' ( ; 10 December 1815 – 27 November 1852), also known as "
  + "'Ada Lovelace', was an English mathematician and writer chiefly known for work on Charles Babbage's proposed "
  + "mechanical general-purpose computer, the analytical engine.";
const ADA_BODY = "Lord Byron separated from his wife a month after Ada was born, and died when she was eight. "
  + "Although often ill in childhood, Lovelace pursued her studies assiduously.";

const REQUEST = "When was Ada Lovelace born?";

function span(id: string, text: string, charStart: number): EvidenceSpan {
  return {
    id: `evidence_span.${id}` as EvidenceId,
    sourceVersionId: `evidence_span.${id}:v1` as SourceVersionId,
    text,
    textPreview: text,
    status: "promoted",
    alpha: 0.72,
    charStart,
    features: [],
    provenance: {
      uri: "fixture://ada-lovelace",
      title: "Ada Lovelace",
      sourceVersionId: `evidence_span.${id}:v1`,
      byteRange: [0, text.length],
      charRange: [charStart, charStart + text.length],
      metadata: { title: "Ada Lovelace" }
    }
  } as unknown as EvidenceSpan;
}

const lead = span("ada_lead", ADA_LEAD, 0);
const body = span("ada_body", ADA_BODY, 4000);
const resolvers: RequestValueResolver[] = [{ id: "resolver.evidence_temporal", resolve: extractTemporalAnswerFromEvidence }];

describe("the request's value binding is resolved once, against the evidence admitted for the request", () => {
  it("resolves from the admitted pool and names exactly the spans the value occurs in", () => {
    const binding = resolveRequestValueBinding({ requestText: REQUEST, evidence: [lead, body], resolvers });
    expect(binding).toBeDefined();
    // Measured, not asserted against a literal: the value is the one the admitted pool carries, the spans named
    // are exactly the spans containing it, and the span the answer selection would have kept is not one of them.
    expect(binding!.evidenceIds).toEqual([String(lead.id)]);
    expect(String(lead.text).includes(binding!.value)).toBe(true);
    expect(String(body.text).includes(binding!.value)).toBe(false);
    // The contract compiled from this binding carries the same value; ranking and realization read one binding.
    const contract = compileRealizationContract(REQUEST, {
      subject: binding!.subject,
      predicate: binding!.relation!,
      object: binding!.value,
      sourceNodeId: "",
      targetNodeId: "",
      relationId: `local:temporal:relation:${binding!.relation!}`,
      forceClass: "direct_evidence",
      score: 1,
      activation: 1,
      overlap: 1,
      support: 1,
      evidenceIds: [...binding!.evidenceIds]
    });
    expect(Object.values(contract.boundValues).filter(Boolean)).toEqual([binding!.value]);
  });

  it("resolves nothing once selection has narrowed the pool to the span that does not carry the value", () => {
    // The 267 traced turns whose selected evidence the basis answer narrowed: this is the input the contract used
    // to be compiled from, and it is why the ranker could never have been supplied the value it needed.
    expect(resolveRequestValueBinding({ requestText: REQUEST, evidence: [body], resolvers })).toBeUndefined();
  });

  it("is inert when no resolver binds anything", () => {
    // Law 1: with no resolvable value there is no binding, and every downstream consumer sees exactly what it saw
    // before this existed. An empty resolver list and a resolver that declines must be indistinguishable.
    expect(resolveRequestValueBinding({ requestText: REQUEST, evidence: [lead, body], resolvers: [] })).toBeUndefined();
    expect(resolveRequestValueBinding({
      requestText: REQUEST,
      evidence: [lead, body],
      resolvers: [{ id: "resolver.declines", resolve: () => undefined }]
    })).toBeUndefined();
  });

  it("declines unattested resolver values and continues to a grounded resolver", () => {
    const resolvers: RequestValueResolver[] = [
      { id: "resolver.absent", resolve: () => "unattested" },
      { id: "resolver.grounded", resolve: () => "Ada Lovelace" }
    ];
    const binding = resolveRequestValueBinding({ requestText: REQUEST, evidence: [lead], resolvers });
    expect(binding?.resolverId).toBe("resolver.grounded");
    expect(binding?.evidenceIds).toEqual([String(lead.id)]);
    expect(resolveRequestValueBinding({ requestText: REQUEST, evidence: [lead], resolvers: resolvers.slice(0, 1) })).toBeUndefined();
  });

  it.each([
    ["16", "2016"],
    ["16", "16th"],
    ["1", "128"],
    ["1", "1.25"],
    ["1", "1/2"],
    ["1", "21:17"],
    ["1", "-1"],
    ["1", "\u22121"],
    ["q7", "q73"],
    ["\u0661", "\u0661\u0662"],
    ["\u0661", "\u0661\u066b\u0662"],
    ["\u043b\u0430\u043d", "\u043b\u0430\u043d\u0430"],
    ["\u4e59\u4e19", "\u7532\u4e59\u4e19"]
  ])("does not bind %s from the larger source value %s", (value, sourceValue) => {
    const evidence = [span("value", `\u03be ${sourceValue}.`, 0)];
    expect(resolveRequestValueBinding({
      requestText: "\u03be?",
      evidence,
      resolvers: [{ id: "resolver.typed", resolve: () => value }]
    })).toBeUndefined();
  });

  it.each(["16th", "seven-bit", "0 to 1", "\u0660 \u2192 \u0661", "\u043b\u0430\u043d", "\u7532\u4e59\u4e19", "\u{10400}\u{10401}"])("binds the complete source value %s and only its owning span", value => {
    const owner = span("owner", `\u03be (${value}).`, 0);
    const other = span("other", "\u03be q73.", 100);
    const binding = resolveRequestValueBinding({
      requestText: "\u03be?",
      evidence: [other, owner],
      resolvers: [{ id: "resolver.typed", resolve: () => value }]
    });
    expect(binding?.value).toBe(value);
    expect(binding?.evidenceIds).toEqual([String(owner.id)]);
  });
});
