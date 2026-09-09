// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LanguageGenerationFrame, LanguageGenerationTerm } from "./language-memory-runtime.js";
import type { SemanticRealizationContract } from "./semantic-answer-construct.js";

/**
 * Project a cognition-owned SemanticRealizationContract into the lower-level language-generation frame schema.
 *
 * Candidate generation does not own Mouth's discourse/style/evidence-layout policy; it only needs the same
 * semantic anchors language-memory generation consumes once Mouth has built a SurfacePlan. Keeping this
 * projection contract-shaped avoids duplicating Mouth's private hash-keyed slot matching while still giving
 * generateFromLanguageMemory real proposition atoms and relation/value anchors instead of starving the
 * generation pool with contextSymbols alone.
 */
export function languageGenerationFramesFromContract(
  contract: SemanticRealizationContract,
  options: {
    targetLanguage?: string;
    targetScript?: string;
    styleProfileId?: string;
    registerVector?: readonly number[];
    detailProfileId?: string;
  } = {}
): LanguageGenerationFrame[] {
  const fact = contract.sourceFact;
  const evidenceIds = contract.evidenceIds;
  const pointId = `semantic-contract:${fact.relationId || "relation"}:${fact.sourceNodeId}:${fact.targetNodeId}`;
  const requiredTerms: LanguageGenerationTerm[] = [
    fact.subject ? { id: `${pointId}:term:subject`, text: fact.subject, weight: 0.96, source: fact.sourceNodeId || "semantic-contract" } : undefined,
    ...contract.requiredRelationUnits.filter(Boolean).map((text, index) => ({
      id: `${pointId}:term:relation:${index}`,
      text,
      weight: 0.94,
      source: fact.relationId || "semantic-contract"
    })),
    fact.object ? { id: `${pointId}:term:object`, text: fact.object, weight: 1, source: fact.targetNodeId || "semantic-contract" } : undefined
  ].filter((term): term is LanguageGenerationTerm => Boolean(term?.text));

  const propositionAtoms: NonNullable<LanguageGenerationFrame["propositionAtoms"]>[number][] = [];
  if (fact.subject) propositionAtoms.push({
    id: `${pointId}:atom:subject`,
    text: fact.subject,
    kind: "entity",
    weight: 0.96,
    source: fact.sourceNodeId || "semantic-contract",
    evidenceIds
  });
  if (fact.predicate) propositionAtoms.push({
    id: `${pointId}:atom:predicate`,
    text: fact.predicate,
    kind: "claim",
    weight: 0.94,
    source: fact.relationId || "semantic-contract",
    evidenceIds
  });
  if (fact.object) propositionAtoms.push({
    id: `${pointId}:atom:object`,
    text: fact.object,
    kind: "surface",
    weight: 1,
    source: fact.targetNodeId || "semantic-contract",
    evidenceIds
  });

  return [{
    id: `${pointId}:frame`,
    pointId,
    role: "answer",
    force: contract.epistemicForce,
    propositionAtoms,
    requiredTerms,
    semanticFrameIds: [],
    realizationConstraints: {
      schema: "scce.semantic_realization_frame.v1",
      relationId: fact.relationId,
      requestedSlotId: contract.requestedSlotId ?? null,
      boundValues: contract.boundValues,
      sourceNodeId: fact.sourceNodeId,
      targetNodeId: fact.targetNodeId
    },
    ...(options.targetLanguage ? { targetLanguage: options.targetLanguage } : {}),
    ...(options.targetScript ? { targetScript: options.targetScript } : {}),
    ...(options.styleProfileId ? { styleProfileId: options.styleProfileId } : {}),
    ...(options.registerVector ? { registerVector: options.registerVector } : {}),
    ...(options.detailProfileId ? { detailProfileId: options.detailProfileId } : {}),
    ordering: { index: 0, relation: "linear", weight: 1 }
  }];
}
