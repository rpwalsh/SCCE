// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { compileLanguageConstructionPattern } from "../../language-construction-memory.js";
import { createLanguageAcquisitionEngine } from "../../language.js";
import { featureSet } from "../../primitives.js";
import type { ConstructGraph, EvidenceSpan, Hasher } from "../../types.js";
import type { IdFactory } from "../../ids.js";
import { sourceRelationConstructionBindingId } from "../../graph-surface-alignment.js";

export function sourceOwnedMouthTeaching(input: {
  ids: IdFactory; hasher: Hasher; evidence: EvidenceSpan; profileId: string;
  phrase: string; subject: string; predicate: string; object: string;
  examples?: readonly (readonly [string, string, string])[];
  render?: (slots: readonly string[]) => string;
  sourceDerivedBinding?: boolean;
}) {
  const relationId = `relation.teaching.${input.hasher.digestHex(input.predicate).slice(0, 12)}`;
  const examples = input.examples ?? [
    ["Annex", input.predicate, "reading-room lights to 20% after 8:00 p.m. for readers"],
    ["Atrium", input.predicate, "reading-room lights to 30% after 7:00 p.m. for visitors"]
  ];
  const lessons = examples.map((slots, index): EvidenceSpan => {
    const text = input.render?.(slots) ?? `${input.phrase}: ${slots.join(" ")}.`;
    const bytes = Buffer.from(text);
    const sourceVersionId = input.ids.sourceVersionId(bytes);
    const contentHash = input.ids.contentHash(bytes);
    const sourceId = input.ids.sourceId("fixture", `fixture://owned-teaching/${index}`);
    return {
      ...input.evidence, sourceId, sourceVersionId, contentHash,
      id: input.ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: bytes.length, spanHash: contentHash }),
      chunkId: input.ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: bytes.length, chunkHash: contentHash }),
      text, textPreview: text, byteStart: 0, byteEnd: bytes.length, charStart: 0, charEnd: [...text].length,
      features: featureSet(text, 128),
      provenance: { sourceSystem: "typed-teaching-fixture", provenanceClass: "direct_evidence", sourceVersionId, byteRange: [0, bytes.length], charRange: [0, [...text].length] }
    };
  });
  const compiled = compileLanguageConstructionPattern({
    bindingId: input.sourceDerivedBinding ? sourceRelationConstructionBindingId(input.hasher, input.profileId, input.predicate) : relationId,
    profileId: input.profileId, evidence: lessons, hasher: input.hasher, updatedAt: 7000,
    observations: lessons.map((lesson, index) => ({
      sourceVersionId: String(lesson.sourceVersionId), evidenceId: String(lesson.id),
      surfaceStartCodePoint: 0, surfaceEndCodePoint: [...lesson.text].length,
      roles: examples[index]!.map((surface, slotIndex) => {
        const startCodePoint = [...lesson.text.slice(0, lesson.text.indexOf(surface))].length;
        return { slotIndex, startCodePoint, endCodePoint: startCodePoint + [...surface].length,
          graphBinding: { relationId, roleId: `role.teaching.${slotIndex}`, valueKind: `value.teaching.${slotIndex}` } };
      })
    }))
  });
  if (compiled.status !== "compiled") throw new Error(`real teaching did not compile: ${JSON.stringify(compiled)}`);
  const corpus = [input.evidence.text, ...lessons.map(lesson => lesson.text)].join("\n");
  const profile = { ...createLanguageAcquisitionEngine({ idFactory: input.ids }).acquire({
    text: corpus, sourceVersionId: input.evidence.sourceVersionId, createdAt: 7000
  }), id: input.profileId };
  const fact = {
    subject: input.subject, predicate: input.predicate, object: input.object,
    sourceNodeId: `node.${input.hasher.digestHex(input.subject).slice(0, 12)}`,
    targetNodeId: `node.${input.hasher.digestHex(input.object).slice(0, 12)}`, relationId,
    forceClass: "direct_evidence", score: 0.96, activation: 0.94, overlap: 0.91, support: 0.95,
    sourceVersionId: String(input.evidence.sourceVersionId), evidenceIds: [String(input.evidence.id)],
    certificationPower: 1, semanticQuality: 0.95, answerGrade: true, finalQuestionFit: 0.91, questionSlotScore: 0.9
  };
  const semanticNode: ConstructGraph["nodes"][number] = {
    id: "construct:semantic-answer:owned-teaching", kind: "construct:semantic_answer", label: input.subject,
    metadata: {
      schema: "scce.semantic_answer_construct.v1", questionShapeId: "question.shape.owned-teaching",
      selectedSubject: input.subject, selectedFacts: [fact], activatedNeighborhood: [fact], selectedRelations: [relationId],
      answerSlots: [{ id: "slot.owned-teaching", relationIds: [relationId],
        factKeys: [[fact.subject, fact.predicate, fact.object, relationId].map(value => value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim()).join("\u0001")], support: fact.support, activation: fact.activation }],
      supportIds: [String(input.evidence.id)], forceId: "output.force.source_bound_answer", boundaryId: "output.force.source_bound",
      certificationBoundary: { directEvidenceCount: 1, evidenceSpanIds: [String(input.evidence.id)], sourceVersionIds: [String(input.evidence.sourceVersionId)], externalFactCertification: true }
    }
  };
  return { pattern: compiled.pattern, lessons, profile, semanticNode };
}
