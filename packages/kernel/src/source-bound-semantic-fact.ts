// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { EvidenceSpan } from "./types.js";
import type { RequestValueBinding, SemanticAnswerConstructFact, SemanticRealizationContract } from "./semantic-answer-construct.js";
import { surfaceContainsBoundValue } from "./surface-linguistics.js";

/** A typed source relation needs no invented spoken predicate. */
export function hasSourceBoundSemanticRelation(fact: {
  predicate?: unknown; relationId?: unknown; relationRoleId?: unknown; sourceVersionId?: unknown; evidenceIds?: unknown; forceClass?: unknown;
}): boolean {
  if (typeof fact.predicate === "string" && fact.predicate.length > 0) return true;
  return fact.predicate === "" && fact.forceClass === "direct_evidence"
    && typeof fact.relationId === "string" && fact.relationId.length > 0
    && typeof fact.relationRoleId === "string" && fact.relationRoleId.length > 0
    && typeof fact.sourceVersionId === "string" && fact.sourceVersionId.length > 0
    && Array.isArray(fact.evidenceIds) && fact.evidenceIds.length > 0
    && fact.evidenceIds.every(id => typeof id === "string" && id.length > 0);
}

/** Project the turn's resolved value through its current promoted source owners. */
export function requestValueBindingConstructFact(binding: RequestValueBinding | undefined, evidence: readonly EvidenceSpan[]): SemanticAnswerConstructFact | undefined {
  if (!binding?.value || !binding.subject || !binding.relationId || !binding.requestedRoleId) return undefined;
  const ids = new Set(binding.evidenceIds);
  const owners = evidence.filter(span => ids.has(String(span.id)) && span.status === "promoted");
  if (!ids.size || owners.length !== ids.size || !owners.every(span => surfaceContainsBoundValue(span.text, binding.value))) return undefined;
  const predicate = binding.relation ?? "";
  if (!predicate && (!binding.relationId || !binding.requestedRoleId
    || !owners.some(span => surfaceContainsBoundValue(span.text, binding.subject)))) return undefined;
  return {
    subject: binding.subject, predicate, object: binding.value,
    sourceNodeId: "", targetNodeId: "",
    relationId: binding.relationId ?? `local:temporal:relation:${predicate}`,
    forceClass: "direct_evidence", score: 1, activation: 1, overlap: 1, support: 1,
    evidenceIds: [...ids], sourceVersionId: String(owners[0]!.sourceVersionId),
    ...(binding.requestedRoleId ? { relationRoleId: binding.requestedRoleId, requestedSlotId: binding.requestedRoleId } : {}),
    questionSlotImportance: "core", answerGrade: true, finalQuestionFit: 1,
    certificationPower: 1, semanticQuality: 1, questionSlotScore: 1
  };
}

/** A bare role value must retain the same selected proposition and current source owners. */
export function currentSourceBoundRoleValueFact(input: {
  text: string; contract?: SemanticRealizationContract; facts: readonly SemanticAnswerConstructFact[]; evidence: readonly EvidenceSpan[];
}): SemanticAnswerConstructFact | undefined {
  const contract = input.contract;
  const fact = contract?.sourceFact;
  if (!contract || !fact || fact.predicate !== "" || !hasSourceBoundSemanticRelation(fact)
    || fact.requestedSlotId !== fact.relationRoleId || contract.requestedSlotId !== fact.requestedSlotId
    || input.text.trim() !== fact.object.trim()) return undefined;
  const identity = (row: SemanticAnswerConstructFact) => JSON.stringify([
    row.subject, row.predicate, row.object, row.relationId, row.relationRoleId, row.requestedSlotId, row.sourceVersionId, row.forceClass,
    [...new Set(row.evidenceIds ?? [])].sort()
  ]);
  if (!input.facts.some(selected => identity(selected) === identity(fact))) return undefined;
  const ids = new Set(fact.evidenceIds ?? []);
  if (contract.evidenceIds.length !== ids.size || contract.evidenceIds.some(id => !ids.has(id))
    || Object.keys(contract.boundValues).length !== 1 || contract.boundValues[fact.requestedSlotId!] !== fact.object) return undefined;
  const owners = input.evidence.filter(span => ids.has(String(span.id)) && span.status === "promoted"
    && String(span.sourceVersionId) === fact.sourceVersionId);
  return owners.length === ids.size && owners.every(span => surfaceContainsBoundValue(span.text, fact.object))
    && owners.some(span => surfaceContainsBoundValue(span.text, fact.subject)) ? fact : undefined;
}
