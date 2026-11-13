// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { EvidenceSpan } from "./types.js";
import { sourceSpanCompletionRangeCurrent } from "./source-owned-span-completion.js";
import { sourceRequestEditResponseForContract } from "./source-request-edit-program.js";
import type { RequestValueBinding, RequestValueResolver, SemanticAnswerConstructFact, SemanticRealizationContract } from "./semantic-answer-construct.js";
import { splitSurfaceSentences, surfaceContainsBoundValue, surfaceWords } from "./surface-linguistics.js";

export interface SourceOwnedValueResolverInput {
  id: string;
  relationId: string;
  requestedRoleId: string;
  resolveValue(requestText: string, evidence: readonly EvidenceSpan[]): string | undefined;
}

function longestSharedSurfaceRun(requestText: string, sourceSentence: string): { text: string; requestStart: number; length: number } | undefined {
  const requestWords = surfaceWords(requestText);
  const sourceWords = surfaceWords(sourceSentence);
  const requestKeys = requestWords.map(word => word.toLocaleLowerCase());
  const sourceKeys = sourceWords.map(word => word.toLocaleLowerCase());
  let best: { sourceStart: number; requestStart: number; length: number } | undefined;
  for (let requestStart = 0; requestStart < requestKeys.length; requestStart++) {
    for (let sourceStart = 0; sourceStart < sourceKeys.length; sourceStart++) {
      let length = 0;
      while (requestKeys[requestStart + length] !== undefined
        && requestKeys[requestStart + length] === sourceKeys[sourceStart + length]) length += 1;
      if (!length) continue;
      if (!best || length > best.length
        || (length === best.length && requestStart < best.requestStart)
        || (length === best.length && requestStart === best.requestStart && sourceStart < best.sourceStart)) {
        best = { sourceStart, requestStart, length };
      }
    }
  }
  if (!best || (best.length === 1 && best.requestStart > 0)) return undefined;
  return {
    text: sourceWords.slice(best.sourceStart, best.sourceStart + best.length).join(" "),
    requestStart: best.requestStart,
    length: best.length
  };
}

/**
 * Gives an evidence value extractor an explicit semantic role without trusting a bare value.
 * The value and a request-owned subject must occur in the same source sentence. The subject is
 * discovered as a contiguous Unicode surface run shared by the request and that sentence; no
 * language vocabulary or word-order table is embedded here.
 */
export function sourceOwnedValueResolver(input: SourceOwnedValueResolverInput): RequestValueResolver {
  return {
    id: input.id,
    resolve(requestText, evidence) {
      const value = input.resolveValue(requestText, evidence);
      if (!value) return undefined;
      for (const span of evidence) {
        if (span.status !== "promoted") continue;
        const sourceText = String(span.text || span.textPreview || "");
        const answeringSentences = splitSurfaceSentences(sourceText)
          .filter(sentence => surfaceContainsBoundValue(sentence, value));
        for (const sentence of answeringSentences) {
          const subject = longestSharedSurfaceRun(requestText, sentence);
          if (!subject?.text) continue;
          return {
            value,
            subject: subject.text,
            relation: "",
            relationId: input.relationId,
            requestedRoleId: input.requestedRoleId,
            evidenceIds: [String(span.id)]
          };
        }
      }
      return undefined;
    }
  };
}

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
  const valueCurrent = binding.sourceSpan ? sourceSpanCompletionRangeCurrent(binding, owners)
    : owners.some(span => surfaceContainsBoundValue(span.text, binding.value))
      && owners.every(span => surfaceContainsBoundValue(span.text, binding.value) || surfaceContainsBoundValue(span.text, binding.subject));
  if (!ids.size || owners.length !== ids.size || new Set(owners.map(span => String(span.sourceVersionId))).size !== 1 || !valueCurrent) return undefined;
  const predicate = binding.relation ?? "";
  // A declared source range may begin or end inside a word; its exact range proof owns the context.
  const subjectCurrent = binding.sourceSpan ? valueCurrent : owners.some(span => surfaceContainsBoundValue(span.text, binding.subject));
  if (!predicate && (!binding.relationId || !binding.requestedRoleId || !subjectCurrent)) return undefined;
  return {
    subject: binding.subject, predicate, object: binding.value,
    sourceNodeId: "", targetNodeId: "",
    relationId: binding.relationId ?? `local:temporal:relation:${predicate}`,
    forceClass: "direct_evidence", score: 1, activation: 1, overlap: 1, support: 1,
    evidenceIds: [...ids], sourceVersionId: String(owners[0]!.sourceVersionId),
    ...(binding.sourceSpan ? { sourceSpan: binding.sourceSpan } : {}),
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
    || (contract.responseProgram ? input.text !== sourceRequestEditResponseForContract(contract, input.evidence)
      : input.text.trim() !== fact.object.trim())) return undefined;
  const identity = (row: SemanticAnswerConstructFact) => JSON.stringify([
    row.subject, row.predicate, row.object, row.relationId, row.relationRoleId, row.requestedSlotId, row.sourceVersionId, row.forceClass,
    [...new Set(row.evidenceIds ?? [])].sort(), row.sourceSpan ? [row.sourceSpan.evidenceId,
      row.sourceSpan.contextStartCodePoint, row.sourceSpan.contextEndCodePoint, row.sourceSpan.valueStartCodePoint, row.sourceSpan.valueEndCodePoint] : null
  ]);
  if (!input.facts.some(selected => identity(selected) === identity(fact))) return undefined;
  const ids = new Set(fact.evidenceIds ?? []);
  if (contract.evidenceIds.length !== ids.size || contract.evidenceIds.some(id => !ids.has(id))
    || Object.keys(contract.boundValues).length !== 1 || contract.boundValues[fact.requestedSlotId!] !== fact.object) return undefined;
  const owners = input.evidence.filter(span => ids.has(String(span.id)) && span.status === "promoted"
    && String(span.sourceVersionId) === fact.sourceVersionId);
  const valueCurrent = fact.sourceSpan ? sourceSpanCompletionRangeCurrent({ ...fact, value: fact.object,
    requestedRoleId: fact.relationRoleId, evidenceIds: fact.evidenceIds ?? [] }, owners)
    : owners.some(span => surfaceContainsBoundValue(span.text, fact.object))
      && owners.every(span => surfaceContainsBoundValue(span.text, fact.object) || surfaceContainsBoundValue(span.text, fact.subject))
      && owners.some(span => surfaceContainsBoundValue(span.text, fact.subject));
  return owners.length === ids.size && valueCurrent ? fact : undefined;
}
