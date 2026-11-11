// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CandidateField } from "./candidate.js";
import {
  createDiscourseTurnObservationV2,
  interpretationAdjustmentSelectionForTypedCandidateV2,
  isDiscourseInterpretationAdjustmentV2,
  type DialogueCognitiveStateV2,
  type DiscourseInterpretationAdjustmentV2,
  type DiscoursePreselectionCandidateV2,
  type DiscourseTurnObservationV2
} from "./discourse-state.js";
import type { ConversationTurnSurface } from "./language-construction.js";
import { jsonRecord, kernelString, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import { createHasher, toJsonValue } from "./primitives.js";
import type { TurnRequirementField } from "./turn-requirements.js";
import type { EvidenceSpan, GraphSnapshot, JsonValue, TurnResult } from "./types.js";

/** The conversation's own turns, as surfaces. Kept in their own namespace: never projected into evidence ids. */
export function conversationTurnSurfacesFromMetadata(metadata: JsonValue | undefined): ConversationTurnSurface[] {
  const session = jsonRecord(jsonRecord(metadata).session);
  const sessionId = kernelString(session.sessionId);
  const rows = Array.isArray(session.recentTurns) ? session.recentTurns : [];
  if (!sessionId) return [];
  return rows
    .map((value, index): ConversationTurnSurface | undefined => {
      const record = jsonRecord(value as JsonValue);
      const surface = (kernelString(record.text) ?? "").trim();
      if (!surface) return undefined;
      const turnIndex = Number(record.turnIndex);
      return {
        turnId: kernelString(record.id) || `${sessionId}:${index}`,
        turnIndex: Number.isFinite(turnIndex) ? turnIndex : index,
        ...(kernelString(record.roleId) ? { roleId: kernelString(record.roleId) } : {}),
        surface
      };
    })
    .filter((turn): turn is ConversationTurnSurface => turn !== undefined)
    .sort((left, right) => left.turnIndex - right.turnIndex);
}

export function dialogueInterpretationAdjustmentsFromMetadata(
  metadata: JsonValue | undefined,
  previousState?: DialogueCognitiveStateV2,
  durableAdjustments: readonly DiscourseInterpretationAdjustmentV2[] = []
): DiscourseInterpretationAdjustmentV2[] {
  const dialogue = jsonRecord(jsonRecord(metadata).dialogue);
  const byId = new Map<string, DiscourseInterpretationAdjustmentV2>();
  for (const value of previousState?.interpretationAdjustments ?? []) {
    if (isDiscourseInterpretationAdjustmentV2(value)) byId.set(value.id, value);
  }
  for (const value of durableAdjustments) {
    if (isDiscourseInterpretationAdjustmentV2(value)) byId.set(value.id, value);
  }
  const incoming = Array.isArray(dialogue.interpretationAdjustments) ? dialogue.interpretationAdjustments : [];
  for (const value of incoming) {
    if (!isDiscourseInterpretationAdjustmentV2(value)) continue;
    byId.delete(value.id);
    byId.set(value.id, value);
  }
  return [...byId.values()].slice(-128);
}

export function typedDialoguePreselectionV2(input: {
  conversationId: string;
  turnId: string;
  turnIndex: number;
  roleId: string;
  surfaceHash: string;
  requirementField: TurnRequirementField;
  entailment: TurnResult["entailment"];
  graph: GraphSnapshot;
  selectedEvidence: readonly EvidenceSpan[];
  previousState?: DialogueCognitiveStateV2;
  hasher: ReturnType<typeof createHasher>;
}): {
  observation: DiscourseTurnObservationV2;
  candidates: DiscoursePreselectionCandidateV2[];
} {
  const selectedEvidenceIds = new Set(input.selectedEvidence.map(span => String(span.id)));
  const proofEvidenceIds = new Set(input.entailment.evidenceIds.map(String).filter(id => selectedEvidenceIds.has(id)));
  const roleIds = uniqueKernelStrings(input.requirementField.requiredFeatures.map(feature => feature.origin.semanticRoleId));
  const frameIds = uniqueKernelStrings(input.requirementField.activatedFrameIds);
  const previousByNodeId = new Map(
    (input.previousState?.referents ?? []).flatMap(referent => referent.nodeIds.map(nodeId => [String(nodeId), referent] as const))
  );
  const graphNodeById = new Map(input.graph.nodes.map(node => [String(node.id), node] as const));
  const previousByEvidenceId = new Map<string, DialogueCognitiveStateV2["referents"][number] | undefined>();
  for (const referent of input.previousState?.referents ?? []) {
    for (const evidenceId of referent.evidenceIds) {
      const key = String(evidenceId);
      const prior = previousByEvidenceId.get(key);
      if (prior && prior.id !== referent.id) previousByEvidenceId.set(key, undefined);
      else if (!previousByEvidenceId.has(key)) previousByEvidenceId.set(key, referent);
    }
  }
  const proofNodes = input.graph.nodes.filter(node => node.evidenceIds.some(id => proofEvidenceIds.has(String(id))));
  const evidenceById = new Map(input.selectedEvidence.map(span => [String(span.id), span]));
  const mappings = input.entailment.mappings.filter(mapping => mapping.evidenceIds.some(id => proofEvidenceIds.has(String(id))));
  const mentions = mappings.flatMap(mapping => {
    const evidenceIds = uniqueKernelStrings(mapping.evidenceIds.map(String).filter(id => proofEvidenceIds.has(id)));
    const candidateNodes = proofNodes.filter(node => node.evidenceIds.some(id => evidenceIds.includes(String(id))));
    if (!candidateNodes.length) return [];
    const candidateReferentIds = uniqueKernelStrings(candidateNodes.map(node => {
      const referent = previousByNodeId.get(String(node.id))
        ?? node.evidenceIds.map(id => previousByEvidenceId.get(String(id))).find((value): value is NonNullable<typeof value> => Boolean(value));
      return referent?.id ?? String(node.id);
    }));
    const sourceVersionIds = uniqueKernelStrings([
      ...mapping.sourceVersionIds.map(String),
      ...evidenceIds.map(id => String(evidenceById.get(id)?.sourceVersionId ?? ""))
    ]);
    return [{
      schema: "scce.discourse_mention.v2" as const,
      id: `disc2.preselection.mention.${input.hasher.digestHex(`${mapping.id}:${evidenceIds.join("|")}:${candidateReferentIds.join("|")}`).slice(0, 32)}`,
      sourceIdentityIds: uniqueKernelStrings([mapping.id, mapping.obligationId, ...evidenceIds, ...candidateReferentIds]),
      kindId: mapping.kind,
      surfaceHash: input.hasher.digestHex(mapping.claimText),
      semanticRoleIds: roleIds,
      requestedSlotIds: [mapping.obligationId],
      learnedFrameIds: frameIds,
      candidateNodeIds: uniqueKernelStrings(candidateNodes.map(node => String(node.id))),
      candidateReferentIds,
      scopeIds: sourceVersionIds
    }];
  });
  const observation = createDiscourseTurnObservationV2({
    conversationId: input.conversationId,
    turnId: input.turnId,
    turnIndex: input.turnIndex,
    roleId: input.roleId,
    surfaceHash: input.surfaceHash,
    learnedFrameIds: frameIds,
    requestedSlotIds: uniqueKernelStrings(mentions.flatMap(mention => mention.requestedSlotIds)),
    explicitAnchorNodeIds: uniqueKernelStrings(proofNodes.map(node => String(node.id))),
    scopeIds: uniqueKernelStrings(mentions.flatMap(mention => mention.scopeIds)),
    mentions
  }, input.hasher);
  const candidates: DiscoursePreselectionCandidateV2[] = [];
  for (const mention of mentions) {
    for (const referentId of mention.candidateReferentIds) {
      const nodeIds = mention.candidateNodeIds.filter(nodeId => {
        const referent = previousByNodeId.get(nodeId)
          ?? graphNodeById.get(nodeId)?.evidenceIds
            .map(id => previousByEvidenceId.get(String(id))).find((value): value is NonNullable<typeof value> => Boolean(value));
        return (referent?.id ?? nodeId) === referentId;
      });
      const proofForReferent = uniqueKernelStrings(proofNodes
        .filter(node => nodeIds.includes(String(node.id)))
        .flatMap(node => node.evidenceIds.map(String).filter(id => proofEvidenceIds.has(id))));
      if (!proofForReferent.length) continue;
      candidates.push({
        referentId,
        semanticRoleIds: [...mention.semanticRoleIds],
        requestedSlotIds: [...mention.requestedSlotIds],
        learnedFrameIds: [...mention.learnedFrameIds],
        scopeIds: [...mention.scopeIds],
        proofEvidenceIds: proofForReferent
      });
    }
  }
  return { observation, candidates };
}

export function typedDialogueTurnContextV2(candidates: readonly DiscoursePreselectionCandidateV2[]): Pick<DiscoursePreselectionCandidateV2, "semanticRoleIds" | "requestedSlotIds" | "learnedFrameIds" | "scopeIds"> {
  return {
    semanticRoleIds: uniqueKernelStrings(candidates.flatMap(context => context.semanticRoleIds)),
    requestedSlotIds: uniqueKernelStrings(candidates.flatMap(context => context.requestedSlotIds)),
    learnedFrameIds: uniqueKernelStrings(candidates.flatMap(context => context.learnedFrameIds)),
    scopeIds: uniqueKernelStrings(candidates.flatMap(context => context.scopeIds))
  };
}

export function preselectionReferentProofEvidenceIdsV2(candidates: readonly DiscoursePreselectionCandidateV2[]): string[][] {
  const byReferent = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const ids = byReferent.get(candidate.referentId) ?? new Set<string>();
    for (const id of candidate.proofEvidenceIds) ids.add(id);
    byReferent.set(candidate.referentId, ids);
  }
  return [...byReferent.values()].map(ids => [...ids].sort());
}

export function preferredDialogueEvidenceForAdjustments(
  candidates: readonly DiscoursePreselectionCandidateV2[],
  adjustments: readonly DiscourseInterpretationAdjustmentV2[]
): ReadonlySet<string> | undefined {
  if (!adjustments.length) return undefined;
  const context = typedDialogueTurnContextV2(candidates);
  const owners = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const ids = owners.get(candidate.referentId) ?? new Set<string>();
    for (const id of candidate.proofEvidenceIds) ids.add(id);
    owners.set(candidate.referentId, ids);
  }
  const ranked = [...owners].map(([referentId, evidenceIds]) => ({ evidenceIds, selection: interpretationAdjustmentSelectionForTypedCandidateV2({
    candidate: { referentId, ...context, proofEvidenceIds: [...evidenceIds] }, adjustments
  }) })).sort((left, right) => right.selection.delta - left.selection.delta);
  const first = ranked[0];
  return first && first.selection.delta > 0 && first.selection.delta > (ranked[1]?.selection.delta ?? 0)
    ? first.evidenceIds : undefined;
}

export function applyDialogueInterpretationAdjustmentsV2(input: {
  field: CandidateField;
  candidates: readonly DiscoursePreselectionCandidateV2[];
  adjustments: readonly DiscourseInterpretationAdjustmentV2[];
}): CandidateField {
  if (!input.adjustments.length || !input.candidates.length) return input.field;
  // A field candidate answers the whole request, so its typed context is the turn's, not one mention's source.
  const turnContext = typedDialogueTurnContextV2(input.candidates);
  let adjustedCount = 0;
  const candidates = input.field.candidates.map(candidate => {
    const evidenceIds = new Set(candidate.evidenceIds.map(String));
    const contexts = input.candidates.filter(context => context.proofEvidenceIds.some(id => evidenceIds.has(id)));
    const referentIds = uniqueKernelStrings(contexts.map(context => context.referentId));
    // A candidate carrying evidence for multiple typed referents is ambiguous;
    // leave it neutral rather than letting feedback choose among unresolved proof.
    if (referentIds.length !== 1) return candidate;
    const selection = interpretationAdjustmentSelectionForTypedCandidateV2({
      candidate: { referentId: referentIds[0]!, ...turnContext, proofEvidenceIds: uniqueKernelStrings(contexts.flatMap(context => context.proofEvidenceIds)) },
      adjustments: input.adjustments
    });
    if (!selection.delta) return candidate;
    adjustedCount++;
    return {
      ...candidate,
      selectionAdjustment: selection.delta,
      audit: toJsonValue({
        ...jsonRecord(candidate.audit),
        typedDialogueSelection: {
          referentId: referentIds[0],
          delta: selection.delta,
          adjustmentIds: selection.adjustmentIds,
          proofEvidenceIds: contexts.flatMap(context => context.proofEvidenceIds)
        }
      })
    };
  });
  return adjustedCount
    ? { ...input.field, candidates }
    : input.field;
}
