// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LearnedConstruction, LearnedFormClass, SurfaceMeaningPlan } from "./language-construction.js";
import { languageConstructionOccurrenceId, languageConstructionRoleId, type DurableLanguageConstructionBundle } from "./language-construction-memory.js";
import { sourceRelationConstructionBindingId } from "./graph-surface-alignment.js";
import { canonicalStringify } from "./primitives.js";
import { collapseSurfaceWhitespace } from "./surface-linguistics.js";
import type { EvidenceSpan, Hasher } from "./types.js";
import type { SemanticAnswerFact } from "./mouth-source-facts.js";

/** Binds the existing graph-role slots only when one proof owner contains every requested argument. */
export function factConstructionMeaningPlan(input: {
  fact: Pick<SemanticAnswerFact, "sourceNodeId" | "relationId" | "targetNodeId" | "subject" | "predicate" | "object">;
  bundle: DurableLanguageConstructionBundle;
  construction: LearnedConstruction;
  profileKey: string;
  evidence: readonly EvidenceSpan[];
  proofEvidenceIds: readonly string[];
  support: number;
  hasher: Hasher;
}): { plan: SurfaceMeaningPlan; formClasses: LearnedFormClass[]; factSlotCount: number } | undefined {
  const { bundle, construction, fact, hasher } = input;
  if (construction.profileKey !== bundle.targetProfileId || !bundle.constructions.some(value => value.id === construction.id)
    || bundle.bindingId !== fact.relationId && bundle.bindingId !== sourceRelationConstructionBindingId(hasher, bundle.sourceProfileId, fact.predicate)) return undefined;
  const factSlots = [{ slotIndex: 0, semanticId: fact.sourceNodeId, surface: fact.subject },
    { slotIndex: 1, semanticId: fact.relationId, surface: fact.predicate }, { slotIndex: 2, semanticId: fact.targetNodeId, surface: fact.object }];
  const normalize = (surface: string) => collapseSurfaceWhitespace(surface).trim().toLocaleLowerCase();
  if (!input.evidence.some(owner => input.proofEvidenceIds.includes(String(owner.id))
    && factSlots.every(slot => normalize(slot.surface).length > 0 && normalize(owner.text).includes(normalize(slot.surface))))) return undefined;
  const slotByRoleId = new Map(factSlots.map(slot => [languageConstructionRoleId(hasher, bundle.bindingId, slot.slotIndex), slot]));
  const occurrenceSlotIndexes = new Map<string, number>();
  for (const example of bundle.sourceExamples) for (const role of [...example.roles, ...example.nullRoles]) {
    const previous = occurrenceSlotIndexes.get(role.occurrenceId);
    if (previous !== undefined && previous !== role.slotIndex) return undefined;
    occurrenceSlotIndexes.set(role.occurrenceId, role.slotIndex);
  }
  const formClasses = bundle.formClasses.filter(value => value.constructionId === construction.id);
  const formClassByOccurrence = new Map(formClasses.map(value => [value.occurrenceId, value.id]));
  const seen = new Set<number>(), slots: Array<SurfaceMeaningPlan["slots"][number]> = [];
  const id = (prefix: string, material: unknown) => `${prefix}.${hasher.digestHex(canonicalStringify([prefix, material])).slice(0, 24)}`;
  for (const occurrence of construction.roleOccurrences) {
    if (occurrence.realization !== "spoken") return undefined;
    const slotIndex = occurrenceSlotIndexes.get(occurrence.occurrenceId), slot = slotByRoleId.get(occurrence.roleId);
    const formClassId = formClassByOccurrence.get(occurrence.occurrenceId);
    if (slotIndex === undefined || !slot || slot.slotIndex !== slotIndex || seen.has(slotIndex) || !formClassId
      || occurrence.occurrenceId !== languageConstructionOccurrenceId(hasher, bundle.bindingId, slotIndex, 0)) return undefined;
    seen.add(slotIndex);
    slots.push({ roleId: occurrence.roleId, occurrenceId: occurrence.occurrenceId, variants: [{
      id: id("variant", [bundle.id, construction.id, fact.relationId, slot.semanticId, slot.surface]), profileKey: input.profileKey,
      surface: slot.surface, evidenceIds: [...input.proofEvidenceIds], support: input.support, formClassId }] });
  }
  if (seen.size !== factSlots.length) return undefined;
  return { formClasses, factSlotCount: factSlots.length, plan: {
    id: id("plan", [bundle.id, construction.id, fact.sourceNodeId, fact.relationId, fact.targetNodeId, input.proofEvidenceIds]),
    profileKey: input.profileKey, roleSignature: factSlots.map(slot => languageConstructionRoleId(hasher, bundle.bindingId, slot.slotIndex)), slots } };
}
