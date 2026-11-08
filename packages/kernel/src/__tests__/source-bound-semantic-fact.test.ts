// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import { attachSourceBoundAnswerConstruct } from "../local-evidence-runtime.js";
import { compileRealizationContract, semanticAnswerConstructFacts, candidateIsVerifiedBoundValue, type RequestValueBinding } from "../semantic-answer-construct.js";
import { semanticAnswerConstructState } from "../mouth-source-facts.js";
import { currentSourceBoundRoleValueFact, requestValueBindingConstructFact } from "../source-bound-semantic-fact.js";
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

it("keeps ordinary predicate projections and rejects unowned or incomplete typed roles", () => {
  expect(requestValueBindingConstructFact({ ...binding, relation: "directs", value: "Mira Venn", requestedRoleId: "role.director" }, [source]))
    .toMatchObject({ predicate: "directs", object: "Mira Venn", relationRoleId: "role.director" });
  for (const invalid of [{ ...binding, subject: "Other observatory" }, { ...binding, relationId: undefined },
    { ...binding, requestedRoleId: undefined }, { ...binding, evidenceIds: ["evidence.foreign"] }]) {
    expect(requestValueBindingConstructFact(invalid, [source])).toBeUndefined();
  }
  expect(requestValueBindingConstructFact(binding, [{ ...source, status: "quarantined" }])).toBeUndefined();
});
