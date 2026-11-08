// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { compileLanguageConstructionPatterns, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
  type DurableLanguageConstructionBundle, type SourceBoundLanguageConstructionTrainingSet } from "./language-construction-memory.js";
import { realizeLearnedSurface, CONVERSATION_INTERNAL_PROVENANCE_METHOD_ID,
  type ConversationTurnSurface, type LearnedRealization, type SurfaceMeaningPlan } from "./language-construction.js";
import { creativeSourceSurfaceGroupKey, type CreativeSourceCorrespondence } from "./creative-source-correspondence.js";
import { creativeEventCompatibilityModelsFromPatterns, type CreativeEventCompatibilityModel, type CreativeRequestFrame } from "./creative-event-compatibility.js";
import { canonicalStringify } from "./primitives.js";
import type { EvidenceSpan, Hasher } from "./types.js";
import type { DurableCreativeEventConstruction } from "./language-construction-memory.js";
import type { LanguagePatternRecord } from "./storage.js";
import { CREATIVE_SOURCE_UTTERANCE_RECIPE_ID, CREATIVE_SOURCE_REFERENCE_UTTERANCE_RECIPE_ID, CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID } from "./language-training-recipe.js";
import { sourceReferencePropertiesForSpan, type OwnedSourceReferenceBindings, type SourceReferenceProperty } from "./source-reference-bindings.js";
import { normalizeCanonicalSurface } from "./normalization-contract.js";

export const CREATIVE_SOURCE_UTTERANCE_RECIPE = CREATIVE_SOURCE_UTTERANCE_RECIPE_ID;

interface UtteranceRole {
  requestRoleId: string;
  slotIndex: number;
  occurrenceIndex: number;
  startCodePoint: number;
  endCodePoint: number;
}

export interface CreativeSourceUtterance {
  bindingId: string;
  profileId: string;
  requestFrameId: string;
  sourceVersionId: string;
  request: CreativeSourceCorrespondence["request"];
  reply: CreativeSourceCorrespondence["reply"];
  eventIds: readonly string[];
  roles: readonly UtteranceRole[];
  requestRoles: readonly { requestRoleId: string; startCodePoint: number; endCodePoint: number; reference?: SourceReferenceProperty;
    surfaceAcquisition?: { recipe: typeof CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID; occurrenceCount: number } }[];
  referencePatternIds: readonly string[];
}

const utterancesByModel = new WeakMap<CreativeEventCompatibilityModel, Map<string, readonly CreativeSourceUtterance[]>>();
const ownedUtterances = new WeakMap<CreativeSourceUtterance, string>();

/** Declared human turn bounds and witnessed role occurrences supply the complete speech construction. */
export function creativeSourceUtterances(model: CreativeEventCompatibilityModel, profileId: string, hasher: Hasher): readonly CreativeSourceUtterance[] {
  if (model.reliability !== "source_observed" || !model.sourceObservations?.length) return [];
  const cached = utterancesByModel.get(model)?.get(profileId);
  if (cached) return cached;
  const groups = new Map<string, CreativeSourceCorrespondence[]>();
  for (const row of model.sourceObservations) {
    if (row.request.evidenceId !== row.reply.evidenceId) continue;
    const key = canonicalStringify([row.requestFrameId, row.sourceId, row.sourceVersionId, row.request, row.reply]);
    const rows = groups.get(key) ?? [];
    rows.push(row);
    groups.set(key, rows);
  }
  const utterances: CreativeSourceUtterance[] = [];
  for (const rows of groups.values()) {
    const first = rows[0]!;
    const byRange = new Map<string, { requestRoleId: string; requestStart: number; requestEnd: number; start: number; end: number }>();
    let ambiguous = false;
    for (const row of rows) for (const binding of row.bindings) {
      const key = `${binding.eventStart}:${binding.eventEnd}`;
      const previous = byRange.get(key);
      if (previous && (previous.requestRoleId !== binding.requestRoleId || previous.requestStart !== binding.requestStart || previous.requestEnd !== binding.requestEnd)) ambiguous = true;
      byRange.set(key, { requestRoleId: binding.requestRoleId, requestStart: binding.requestStart, requestEnd: binding.requestEnd,
        start: binding.eventStart, end: binding.eventEnd });
    }
    let ranges = [...byRange.values()].sort((a, b) => a.start - b.start || a.end - b.end);
    const referencePatternIds = model.sourceReferencePatternIds ?? [];
    const referenceDocuments = (model.sourceReferenceBindings ?? []).filter(document => document.profileId === profileId
      && document.sourceId === first.sourceId && document.sourceVersionId === first.sourceVersionId);
    const referenceOccurrences = referenceDocuments.flatMap(document => document.occurrences);
    const requestOrigin = referenceOccurrences.find(occurrence => occurrence.evidenceId === first.request.evidenceId)?.evidenceCharStart ?? 0;
    const replyOrigin = referenceOccurrences.find(occurrence => occurrence.evidenceId === first.reply.evidenceId)?.evidenceCharStart ?? 0;
    const requestRoles = [...new Map(ranges.map(range => [range.requestRoleId, range])).values()]
      .sort((a, b) => a.requestStart - b.requestStart || a.requestEnd - b.requestEnd || a.requestRoleId.localeCompare(b.requestRoleId));
    const roleBindings: CreativeSourceUtterance["requestRoles"][number][] = [];
    const acquired = model.sourceSurfaceBindings?.get(creativeSourceSurfaceGroupKey(first)) ?? [];
    for (const role of requestRoles) {
      const properties = sourceReferencePropertiesForSpan({ documents: referenceDocuments, sourceVersionId: first.sourceVersionId,
        startCodePoint: requestOrigin + first.request.start + role.requestStart, endCodePoint: requestOrigin + first.request.start + role.requestEnd });
      if (properties.length > 1) ambiguous = true;
      const reference = properties.length === 1 && properties[0]!.complete ? properties[0] : undefined;
      const surfaceBinding = acquired.find(binding => binding.requestRoleId === role.requestRoleId
        && binding.requestStart === role.requestStart && binding.requestEnd === role.requestEnd);
      roleBindings.push({ requestRoleId: role.requestRoleId, startCodePoint: role.requestStart, endCodePoint: role.requestEnd,
        ...(reference ? { reference } : surfaceBinding ? { surfaceAcquisition: { recipe: CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID,
          occurrenceCount: surfaceBinding.occurrences.length } } : {}) });
      if (!reference && surfaceBinding) {
        ranges = ranges.filter(range => range.requestRoleId !== role.requestRoleId);
        ranges.push(...surfaceBinding.occurrences.map(occurrence => ({ requestRoleId: role.requestRoleId,
          requestStart: role.requestStart, requestEnd: role.requestEnd, start: occurrence.start, end: occurrence.end })));
      }
      if (!reference) continue;
      const declared = reference.occurrences.filter(occurrence => occurrence.evidenceId === first.reply.evidenceId
        && occurrence.propertySpan!.start >= replyOrigin + first.reply.start && occurrence.propertySpan!.end <= replyOrigin + first.reply.end);
      if (!declared.length) { ambiguous = true; continue; }
      ranges = ranges.filter(range => range.requestRoleId !== role.requestRoleId);
      ranges.push(...declared.map(occurrence => ({ requestRoleId: role.requestRoleId, requestStart: role.requestStart, requestEnd: role.requestEnd,
        start: occurrence.propertySpan!.start - replyOrigin, end: occurrence.propertySpan!.end - replyOrigin })));
    }
    ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    if (ambiguous || !ranges.length || ranges.some((range, index) => range.start < first.reply.start || range.end > first.reply.end
      || (index > 0 && range.start < ranges[index - 1]!.end))) continue;
    const occurrences = new Map<string, number>();
    const roles = ranges.map(range => {
      const occurrenceIndex = occurrences.get(range.requestRoleId) ?? 0;
      occurrences.set(range.requestRoleId, occurrenceIndex + 1);
      return { requestRoleId: range.requestRoleId, slotIndex: requestRoles.findIndex(role => role.requestRoleId === range.requestRoleId), occurrenceIndex,
        startCodePoint: range.start - first.reply.start, endCodePoint: range.end - first.reply.start };
    });
    const surfaceAcquired = roleBindings.some(role => role.surfaceAcquisition);
    const material = { recipe: surfaceAcquired ? CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID
      : referencePatternIds.length ? CREATIVE_SOURCE_REFERENCE_UTTERANCE_RECIPE_ID : CREATIVE_SOURCE_UTTERANCE_RECIPE,
      profileId, requestFrameId: first.requestFrameId, sourceVersionId: first.sourceVersionId, request: first.request, reply: first.reply, roles,
      ...(referencePatternIds.length || surfaceAcquired ? { referencePatternIds, requestRoles: roleBindings.map(({ reference, ...role }) => ({ ...role,
        ...(reference ? { reference: { patternId: reference.patternId, referentId: reference.referentId, propertyId: reference.propertyId, basis: reference.basis } } : {}) })) } : {}) };
    const utterance = { bindingId: `source.creative.utterance.${hasher.digestHex(canonicalStringify(material))}`, profileId,
      requestFrameId: first.requestFrameId, sourceVersionId: first.sourceVersionId, request: first.request, reply: first.reply,
      eventIds: [...new Set(rows.map(row => row.eventId))].sort(), roles, requestRoles: roleBindings, referencePatternIds };
    ownedUtterances.set(utterance, canonicalStringify(utterance));
    utterances.push(utterance);
  }
  utterances.sort((a, b) => a.bindingId.localeCompare(b.bindingId));
  const byProfile = utterancesByModel.get(model) ?? new Map<string, readonly CreativeSourceUtterance[]>();
  byProfile.set(profileId, utterances);
  utterancesByModel.set(model, byProfile);
  return utterances;
}

export function compileCreativeSourceUtterancePatterns(input: {
  patterns: readonly LanguagePatternRecord[]; events: readonly DurableCreativeEventConstruction[];
  eventBundles: readonly DurableLanguageConstructionBundle[];
  profileId: string; evidence: readonly EvidenceSpan[]; hasher: Hasher; updatedAt: number;
  referenceBindings?: readonly OwnedSourceReferenceBindings[];
}): { patterns: LanguagePatternRecord[]; candidateCount: number; rejectionCodes: string[];
  prerequisitesByModelId: ReadonlyMap<string, { recipe: typeof CREATIVE_SOURCE_UTTERANCE_RECIPE_ID | typeof CREATIVE_SOURCE_REFERENCE_UTTERANCE_RECIPE_ID | typeof CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID; requests: Array<{ requestFrameId: string; patternIds: string[] }> }> } {
  const models = creativeEventCompatibilityModelsFromPatterns(input.patterns, input);
  const sets: Array<SourceBoundLanguageConstructionTrainingSet & { acquisitionStatus: "source_observed" }> = models.flatMap(model => creativeSourceUtterances(model, input.profileId, input.hasher)
    .map(utterance => ({ bindingId: utterance.bindingId, acquisitionStatus: "source_observed" as const, observations: [{
      sourceVersionId: utterance.sourceVersionId, evidenceId: utterance.reply.evidenceId,
      surfaceStartCodePoint: utterance.reply.start, surfaceEndCodePoint: utterance.reply.end,
      antecedent: { startCodePoint: utterance.request.start, endCodePoint: utterance.request.end },
      roles: utterance.roles.map(({ slotIndex, occurrenceIndex, startCodePoint, endCodePoint }) => ({ slotIndex, occurrenceIndex, startCodePoint, endCodePoint }))
    }] })));
  const results = [...compileLanguageConstructionPatterns({ sets, profileId: input.profileId, evidence: input.evidence,
    hasher: input.hasher, updatedAt: input.updatedAt, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE })];
  const compiled = results.flatMap(result => result.status === "compiled" ? [result] : []);
  const rejectionCodes = results.flatMap(result => result.status === "rejected" ? result.issues.map(issue => issue.code) : []);
  const patternByBinding = new Map(compiled.map(result => [result.bundle.bindingId, result.pattern.id]));
  const eventPatternByEvent = new Map(input.eventBundles.flatMap(bundle => (bundle.creativeEvents ?? []).map(event => [event.id, bundle.id] as const)));
  const prerequisitesByModelId = new Map<string, { recipe: typeof CREATIVE_SOURCE_UTTERANCE_RECIPE_ID | typeof CREATIVE_SOURCE_REFERENCE_UTTERANCE_RECIPE_ID | typeof CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID; requests: Array<{ requestFrameId: string; patternIds: string[] }> }>();
  for (const model of models) {
    const byFrame = new Map<string, Set<string>>();
    for (const utterance of creativeSourceUtterances(model, input.profileId, input.hasher)) {
      const patternId = patternByBinding.get(utterance.bindingId);
      if (!patternId) continue;
      const ids = byFrame.get(utterance.requestFrameId) ?? new Set<string>();
      ids.add(patternId);
      for (const id of utterance.referencePatternIds) ids.add(id);
      for (const id of utterance.eventIds) { const page = eventPatternByEvent.get(id); if (page) ids.add(page); }
      byFrame.set(utterance.requestFrameId, ids);
    }
    if (byFrame.size) prerequisitesByModelId.set(model.id, { recipe: model.reliability === "source_observed" && model.surfaceBindingRecipe
      ? CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID : model.reliability === "source_observed" && model.sourceReferencePatternIds?.length
        ? CREATIVE_SOURCE_REFERENCE_UTTERANCE_RECIPE_ID : CREATIVE_SOURCE_UTTERANCE_RECIPE_ID,
      requests: [...byFrame].map(([requestFrameId, ids]) => ({ requestFrameId, patternIds: [...ids].sort() })).sort((a, b) => a.requestFrameId.localeCompare(b.requestFrameId)) });
  }
  return { patterns: compiled.map(result => result.pattern), candidateCount: sets.length, rejectionCodes, prerequisitesByModelId };
}

export function realizeCreativeSourceUtterance(input: {
  utterance: CreativeSourceUtterance; bundles: readonly DurableLanguageConstructionBundle[]; frame: CreativeRequestFrame;
  requestText: string; ownerTurnId: string; turns: readonly ConversationTurnSurface[]; semanticPlanId: string; hasher: Hasher;
  cycleConsistencyByConstructionId?: ReadonlyMap<string, number>;
}): { realization: LearnedRealization; bundle: DurableLanguageConstructionBundle; exampleId: string; sourceSurface: string } | undefined {
  const { utterance } = input;
  if (!ownedUtterances.has(utterance) || ownedUtterances.get(utterance) !== canonicalStringify(utterance)) return undefined;
  const bundle = input.bundles.find(bundle => bundle.bindingId === utterance.bindingId && bundle.targetProfileId === utterance.profileId);
  if (!bundle || !input.frame.sourceActivationIds.includes(utterance.requestFrameId)) return undefined;
  const example = bundle.sourceExamples.find(example => example.sourceVersionId === utterance.sourceVersionId && example.evidenceId === utterance.reply.evidenceId
    && example.evidenceContentHash === utterance.reply.contentHash && example.surfaceStartCodePoint === utterance.reply.start && example.surfaceEndCodePoint === utterance.reply.end
    && example.antecedent?.startCodePoint === utterance.request.start && example.antecedent.endCodePoint === utterance.request.end
    && example.antecedent.surface === utterance.request.surface && example.roles.length === utterance.roles.length && !example.nullRoles.length);
  if (!example) return undefined;
  const points = [...input.requestText];
  const slots: SurfaceMeaningPlan["slots"][number][] = [];
  const occurrencesByRequestRole = new Map<string, string[]>();
  for (const [slotIndex, role] of example.roles.entries()) {
    const source = utterance.roles.find(source => source.slotIndex === role.slotIndex && source.occurrenceIndex === role.occurrenceIndex
      && source.startCodePoint === role.startCodePoint && source.endCodePoint === role.endCodePoint);
    const argument = source ? input.frame.arguments.find(argument => argument.roleId === source.requestRoleId) : undefined;
    if (!source || !argument || argument.span.charStart < 0 || argument.span.charEnd > points.length
      || points.slice(argument.span.charStart, argument.span.charEnd).join("") !== argument.span.text) return undefined;
    const binding = utterance.requestRoles.find(binding => binding.requestRoleId === source.requestRoleId);
    if (!binding) return undefined;
    const originalValue = [...utterance.request.surface].slice(binding.startCodePoint, binding.endCodePoint).join("");
    const changed = normalizeCanonicalSurface(originalValue) !== normalizeCanonicalSurface(argument.span.text);
    if (changed && !binding.reference?.complete && !binding.surfaceAcquisition) return undefined;
    const id = `source.utterance.slot.${input.hasher.digestHex(canonicalStringify([input.semanticPlanId, example.id, role.occurrenceId, argument.id]))}`;
    slots.push({ roleId: role.roleId, occurrenceId: role.occurrenceId, variants: [changed ? { id, profileKey: bundle.targetProfileId, surface: argument.span.text, evidenceIds: [],
      conversationInternalLicence: { schema: CONVERSATION_INTERNAL_PROVENANCE_METHOD_ID, variantId: id, slotIndex, conversationId: "conversation.current",
        sourceTurnId: input.ownerTurnId, startCodePoint: argument.span.charStart, endCodePoint: argument.span.charEnd } }
      : { id, profileKey: bundle.targetProfileId, surface: role.surface, evidenceIds: [example.evidenceId] }] });
    const occurrences = occurrencesByRequestRole.get(source.requestRoleId) ?? [];
    occurrences.push(role.occurrenceId);
    occurrencesByRequestRole.set(source.requestRoleId, occurrences);
  }
  if (input.frame.arguments.some(argument => !occurrencesByRequestRole.has(argument.roleId))) return undefined;
  const intentionalRepetitions = [...occurrencesByRequestRole.entries()].filter(([, occurrenceIds]) => occurrenceIds.length > 1)
    .map(([requestRoleId, occurrenceIds]) => ({ id: `source.utterance.repetition.${input.hasher.digestHex(canonicalStringify([example.id, requestRoleId, occurrenceIds]))}`, occurrenceIds }));
  const result = realizeLearnedSurface({ hasher: input.hasher, conversationTurns: input.turns,
    constructions: bundle.constructions.filter(construction => construction.sourceExampleIds.includes(example.id)), formClasses: bundle.formClasses,
    cycleConsistencyByConstructionId: input.cycleConsistencyByConstructionId,
    plan: { id: `source.utterance.realization.${input.hasher.digestHex(canonicalStringify([input.semanticPlanId, example.id]))}`,
      profileKey: bundle.targetProfileId, roleSignature: [...new Set(slots.map(slot => slot.roleId))], slots, intentionalRepetitions } });
  return result.status === "realized" ? { realization: result.realization, bundle, exampleId: example.id, sourceSurface: example.surface } : undefined;
}
