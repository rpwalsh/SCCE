// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { attachSourceBoundAnswerConstruct } from "../local-evidence-runtime.js";
import { compileRealizationContract, semanticAnswerConstructFacts, candidateIsVerifiedBoundValue, resolveRequestValueBinding, type RequestValueBinding } from "../semantic-answer-construct.js";
import { extractTemporalAnswerFromEvidence } from "../semantic-obligations.js";
import { semanticAnswerConstructState } from "../mouth-source-facts.js";
import { currentSourceBoundRoleValueFact, requestValueBindingConstructFact, sourceOwnedValueResolver } from "../source-bound-semantic-fact.js";
import type { ConstructGraph, EvidenceSpan } from "../types.js";

const source = { id: "evidence.notes", sourceVersionId: "source.notes", status: "promoted", text: "Mira Venn directs Neralis observatory. Neralis observatory is located on Pelora island." } as EvidenceSpan;
const binding: RequestValueBinding = { subject: "Neralis observatory", value: "Pelora island", relationId: "relation.location",
  requestedRoleId: "role.place", resolverId: "resolver.acquired_source_construction", evidenceIds: [String(source.id)] };
const construct = { id: "construct.empty", episodeId: "episode.test", nodes: [], edges: [], artifacts: [], forceVector: {} } as unknown as ConstructGraph;
const hasher = createHasher();

it("preserves a typed role-only projection through attachment, both readers and the exact bound-value contract", () => {
  const fact = requestValueBindingConstructFact(binding, [source])!;
  const graph = attachSourceBoundAnswerConstruct({ construct, requestText: "Where is Neralis observatory located?", hasher, brainMarker: {}, facts: [fact], evidence: [source] });
  const facts = semanticAnswerConstructFacts(graph)!.facts;
  expect(facts).toMatchObject([{ subject: binding.subject, predicate: "", object: binding.value, relationId: binding.relationId,
    relationRoleId: binding.requestedRoleId, requestedSlotId: binding.requestedRoleId, evidenceIds: binding.evidenceIds, sourceVersionId: source.sourceVersionId }]);
  expect(semanticAnswerConstructState(graph)?.selectedFacts).toMatchObject(facts);
  const contract = compileRealizationContract("Where is Neralis observatory located?", facts[0]!);
  expect(contract.requestedSlotId).toBe("role.place");
  expect(contract.requiredAtoms).toEqual([]);
  expect(candidateIsVerifiedBoundValue("Pelora island", contract)).toBe(true);
  expect(currentSourceBoundRoleValueFact({ text: "Pelora island", contract, facts, evidence: [source] })).toBeDefined();
  const cases = [
    { text: "Mira Venn", contract, facts, evidence: [source] },
    { text: "Pelora island", contract: { ...contract, requestedSlotId: "role.director" }, facts, evidence: [source] },
    { text: "Pelora island", contract: { ...contract, boundValues: { "role.director": "Pelora island" } }, facts, evidence: [source] },
    { text: "Mira Venn", contract: { ...contract, sourceFact: { ...fact, object: "Mira Venn" }, boundValues: { "role.place": "Mira Venn" } }, facts, evidence: [source] },
    { text: "Pelora island", contract: { ...contract, sourceFact: { ...fact, subject: "Other observatory" } }, facts, evidence: [source] },
    { text: "Pelora island", contract: { ...contract, sourceFact: { ...fact, relationRoleId: "role.director" } }, facts, evidence: [source] },
    { text: "Pelora island", contract: { ...contract, sourceFact: { ...fact, relationId: "relation.director" } }, facts, evidence: [source] },
    { text: "Pelora island", contract, facts, evidence: [{ ...source, id: "evidence.foreign" as EvidenceSpan["id"] }] },
    { text: "Pelora island", contract, facts, evidence: [{ ...source, sourceVersionId: "source.other" as EvidenceSpan["sourceVersionId"] }] },
    { text: "Pelora island", contract, facts, evidence: [{ ...source, status: "quarantined" as const }] }
  ];
  for (const input of cases) expect(currentSourceBoundRoleValueFact(input)).toBeUndefined();
});

it("retains complete split participant owners through resolution, projection and realization", () => {
  const subject = { ...source, id: "evidence.subject" as EvidenceSpan["id"], text: "Neralis observatory." };
  const answer = { ...source, id: "evidence.answer" as EvidenceSpan["id"], text: "Pelora island." };
  const evidence = [subject, answer];
  const resolved = resolveRequestValueBinding({ requestText: "Where is Neralis observatory located?", evidence,
    resolvers: [{ id: binding.resolverId, resolve: () => ({ ...binding, evidenceIds: evidence.map(span => String(span.id)) }) }] })!;
  expect(resolved.evidenceIds).toEqual(evidence.map(span => String(span.id)));
  const fact = requestValueBindingConstructFact(resolved, evidence)!;
  expect(fact.evidenceIds).toHaveLength(2);
  const graph = attachSourceBoundAnswerConstruct({ construct, requestText: "Where is Neralis observatory located?",
    hasher, brainMarker: {}, facts: [fact], evidence });
  const contract = compileRealizationContract("Where is Neralis observatory located?", fact);
  const facts = semanticAnswerConstructFacts(graph)!.facts;
  expect(currentSourceBoundRoleValueFact({ text: binding.value, contract, facts, evidence })).toBeDefined();
  for (const changed of [[subject], [answer], [subject, { ...answer, sourceVersionId: "source.foreign" as EvidenceSpan["sourceVersionId"] }],
    [subject, { ...answer, status: "quarantined" as const }]]) {
    expect(requestValueBindingConstructFact(resolved, changed)).toBeUndefined();
    expect(currentSourceBoundRoleValueFact({ text: binding.value, contract, facts, evidence: changed })).toBeUndefined();
  }
});

it("keeps ordinary predicate projections and rejects unowned or incomplete typed roles", () => {
  expect(requestValueBindingConstructFact({ ...binding, relation: "directs", value: "Mira Venn", requestedRoleId: "role.director" }, [source]))
    .toMatchObject({ predicate: "directs", object: "Mira Venn", relationRoleId: "role.director" });
  for (const invalid of [{ ...binding, subject: "Other observatory" }, { ...binding, relationId: undefined },
    { ...binding, requestedRoleId: undefined }, { ...binding, evidenceIds: ["evidence.foreign"] }]) {
    expect(requestValueBindingConstructFact(invalid, [source])).toBeUndefined();
  }
  expect(requestValueBindingConstructFact(binding, [{ ...source, status: "quarantined" }])).toBeUndefined();
});

it("does not turn an untyped transcript date into a source-owned founding fact", () => {
  const transcript = { ...source, text: "When did Virgin Australia start operating?\nVirgin Australia commenced services on 31 August 2000 as Virgin Blue, with two aircraft on a single route." };
  const untyped: RequestValueBinding = { subject: "observatory", relation: "is", value: "31 August 2000",
    resolverId: "resolver.evidence_temporal", evidenceIds: [String(transcript.id)] };
  expect(requestValueBindingConstructFact(untyped, [transcript])).toBeUndefined();
  expect(requestValueBindingConstructFact({ ...untyped, relationId: "relation.founding" }, [transcript])).toBeUndefined();
  expect(requestValueBindingConstructFact({ ...untyped, requestedRoleId: "role.date" }, [transcript])).toBeUndefined();
  const raw = resolveRequestValueBinding({ requestText: "When was Neralis observatory founded?", evidence: [transcript],
    resolvers: [{ id: "resolver.evidence_temporal", resolve: extractTemporalAnswerFromEvidence }] });
  expect(raw).toMatchObject({ value: "31 August 2000", resolverId: "resolver.evidence_temporal", evidenceIds: [String(transcript.id)] });
  expect(raw?.relation).not.toBe("is");
  expect(requestValueBindingConstructFact(raw, [transcript])).toBeUndefined();
});

it("types an extracted value only when its source sentence also owns a request subject", () => {
  const transcript = { ...source, text: "When did Virgin Australia start operating?\nVirgin Australia commenced services on 31 August 2000 as Virgin Blue." };
  const resolver = sourceOwnedValueResolver({
    id: "resolver.evidence_temporal",
    relationId: "relation.temporal.event_time",
    requestedRoleId: "role.temporal.value",
    resolveValue: extractTemporalAnswerFromEvidence
  });
  const resolved = resolveRequestValueBinding({
    requestText: "When did Virgin Australia start operating?",
    evidence: [transcript],
    resolvers: [resolver]
  });
  expect(resolved).toMatchObject({
    subject: "Virgin Australia",
    relationId: "relation.temporal.event_time",
    requestedRoleId: "role.temporal.value",
    value: "31 August 2000",
    evidenceIds: [String(transcript.id)]
  });
  expect(requestValueBindingConstructFact(resolved, [transcript])).toMatchObject({
    subject: "Virgin Australia",
    predicate: "",
    object: "31 August 2000",
    relationId: "relation.temporal.event_time",
    relationRoleId: "role.temporal.value"
  });

  const unrelated = resolveRequestValueBinding({
    requestText: "When was Neralis observatory founded?",
    evidence: [transcript],
    resolvers: [resolver]
  });
  expect(unrelated).toBeUndefined();
});

it("projects source-owned roles without an English vocabulary", () => {
  const evidence = { ...source, text: "Neralis observatorio inició operaciones el día doce." };
  const resolver = sourceOwnedValueResolver({
    id: "resolver.fixture",
    relationId: "relation.fixture.event_time",
    requestedRoleId: "role.fixture.value",
    resolveValue: () => "día doce"
  });
  const resolved = resolveRequestValueBinding({
    requestText: "¿Cuándo inició Neralis observatorio?",
    evidence: [evidence],
    resolvers: [resolver]
  });
  expect(resolved).toMatchObject({ subject: "Neralis observatorio", value: "día doce" });
  expect(requestValueBindingConstructFact(resolved, [evidence])).toBeDefined();
});
