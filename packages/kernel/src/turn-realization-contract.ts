// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { calibrated } from "./calibrations/prod-calibrations.js";
import { jsonRecord, kernelString, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import {
  evidenceTopicMatchesRequest,
  isUnparsedMarkupText,
  requestContentEvidenceUnits,
  requestUnitSharesStem
} from "./local-evidence-runtime.js";
import type { MouthSemanticInput, SpokenOutput } from "./mouth.js";
import { createHasher } from "./primitives.js";
import {
  candidateSurvivesRealizationContract,
  type SemanticRealizationContract
} from "./semantic-answer-construct.js";
import { isStructuralResidueSurface } from "./structural-residue.js";
import { surfaceUnits } from "./surface-linguistics.js";
import type { TurnRequirementField } from "./turn-requirements.js";
import type { ConstructGraph, EvidenceSpan, GraphSnapshot, JsonValue, RequestedAuthority } from "./types.js";

export function typedSemanticInputForMouth(input: {
  construct: ConstructGraph;
  graph: GraphSnapshot;
  authority: MouthSemanticInput["authority"];
}): MouthSemanticInput | undefined {
  const nodes = (input.construct as unknown as {
    nodes?: Array<{ kind?: string; metadata?: JsonValue }>;
  }).nodes ?? [];
  const selectedFacts = nodes.flatMap(node => {
    if (node.kind !== "construct:semantic_answer") return [];
    const value = jsonRecord(node.metadata ?? {});
    return Array.isArray(value.selectedFacts)
      ? value.selectedFacts.map(jsonRecord)
      : [];
  });
  if (selectedFacts.length !== 1) return undefined;
  const fact = selectedFacts[0]!;
  const sourceNodeId = kernelString(fact.sourceNodeId);
  const targetNodeId = kernelString(fact.targetNodeId);
  const relationId = kernelString(fact.relationId);
  const subject = kernelString(fact.subject);
  const object = kernelString(fact.object);
  if (!sourceNodeId || !targetNodeId || !relationId || !subject || !object) {
    return undefined;
  }
  const matching = input.graph.hyperedges.filter(hyperedge =>
    String(hyperedge.relationId) === relationId
    && hyperedge.participantPorts.some(port =>
      String(port.nodeId ?? "") === sourceNodeId)
    && hyperedge.participantPorts.some(port =>
      String(port.nodeId ?? "") === targetNodeId));
  if (matching.length !== 1) return undefined;
  const hyperedge = matching[0]!;
  const sourcePorts = hyperedge.participantPorts.filter(port =>
    String(port.nodeId ?? "") === sourceNodeId
    && port.realization === "observed"
    && Boolean(port.roleId));
  const targetPorts = hyperedge.participantPorts.filter(port =>
    String(port.nodeId ?? "") === targetNodeId
    && port.realization === "observed"
    && Boolean(port.roleId));
  if (sourcePorts.length !== 1 || targetPorts.length !== 1) return undefined;
  const sourcePort = sourcePorts[0]!;
  const targetPort = targetPorts[0]!;
  const factEvidenceIds = Array.isArray(fact.evidenceIds)
    ? fact.evidenceIds
    : [];
  const evidenceIds = uniqueKernelStrings([
    ...factEvidenceIds.flatMap(value =>
      typeof value === "string" ? [value] : []),
    ...hyperedge.evidenceIds.map(String)
  ]);
  const sourceSlotId = `mouth.slot.graph.${sourceNodeId}.source`;
  const targetSlotId = `mouth.slot.graph.${targetNodeId}.target`;
  return {
    schema: "scce.mouth.semantic_input.v1",
    authority: input.authority,
    slots: [
      {
        id: sourceSlotId,
        roleId: String(sourcePort.roleId),
        value: subject,
        evidenceIds: evidenceIds as MouthSemanticInput["slots"][number]["evidenceIds"],
        sourceId: sourceNodeId
      },
      {
        id: targetSlotId,
        roleId: String(targetPort.roleId),
        value: object,
        evidenceIds: evidenceIds as MouthSemanticInput["slots"][number]["evidenceIds"],
        sourceId: targetNodeId
      }
    ],
    relations: [{
      id: `mouth.relation.graph.${hyperedge.id}`,
      relationId,
      sourceSlotId,
      targetSlotId,
      evidenceIds: evidenceIds as NonNullable<
        MouthSemanticInput["relations"]
      >[number]["evidenceIds"]
    }]
  };
}

/** A verified reasoned realization need not be a contiguous source quotation. */
export function reasonedRealizationPreservesContract(input: {
  requestedAuthority: RequestedAuthority;
  requirementField: Pick<TurnRequirementField, "sourceDependence" | "semanticPreservation" | "inferentialDepth" | "dialogueDependence">;
  spoken: Pick<SpokenOutput, "text" | "surfaceValid" | "evidenceRefs">;
  realizationContract?: SemanticRealizationContract;
  closedClassWords?: ReadonlySet<string>;
  hasher?: ReturnType<typeof createHasher>;
}): boolean {
  const { requirementField: field, realizationContract: contract, spoken } = input;
  if (input.requestedAuthority !== "reasoned" || !spoken.surfaceValid || !spoken.text.trim()) return false;
  // Explicit source-preserving tasks retain their exact-excerpt contract.
  const preservationFloor = calibrated("turn_requirements.source_preservation_floor");
  if (field.semanticPreservation >= preservationFloor || field.sourceDependence >= preservationFloor
    || field.sourceDependence >= Math.max(field.inferentialDepth, field.dialogueDependence)) return false;
  if (!contract?.evidenceIds.length
    || !contract.evidenceIds.every(id => spoken.evidenceRefs.some(ref => String(ref) === id))) return false;
  // The atomizer can miss an added clause when its vocabulary has no
  // learned relation for it. Do not let that blind spot widen this exception.
  const fact = contract.sourceFact;
  const licensedUnits = surfaceUnits([fact.subject, fact.predicate, fact.object].join(" ").toLocaleLowerCase());
  if (surfaceUnits(spoken.text.toLocaleLowerCase()).some(unit =>
    !input.closedClassWords?.has(unit)
    && !licensedUnits.some(licensed => requestUnitSharesStem(unit, licensed)))) return false;
  return candidateSurvivesRealizationContract(spoken.text, contract, input.hasher).survives;
}

export interface LearnedSurfaceRecoveryInput {
  learnedSurface: string;
  requestText: string;
  closedClassWords?: ReadonlySet<string>;
  realizationContract?: SemanticRealizationContract;
}

/** A surface that realizes nothing the request did not already say. */
export function learnedSurfaceRealizesNothing(input: Pick<LearnedSurfaceRecoveryInput, "learnedSurface" | "requestText" | "closedClassWords">): boolean {
  const requestUnits = surfaceUnits(input.requestText);
  return !surfaceUnits(input.learnedSurface).some(unit => !input.closedClassWords?.has(unit)
    && !requestUnits.some(requestUnit => requestUnitSharesStem(requestUnit, unit)));
}

/**
 * Whether a fallback may recite an admitted span verbatim, under the same admission primary selection applies:
 * mouth.ts refuses a surface that is unparsed markup, that the structural residue measure calls apparatus, or that
 * covers none of the request. A recitation is admission, so it answers to all three. The relation is deliberately
 * NOT required here: the contradiction lane exists for evidence that contradicts the request's premise, and that
 * premise is by construction absent from the evidence. Pure.
 */
export function recitedEvidenceAdmissibility(input: { surface: string; span: EvidenceSpan; requestText: string }):
  "admissible" | "markup" | "apparatus" | "uncovered" {
  if (isUnparsedMarkupText(input.surface)) return "markup";
  if (isStructuralResidueSurface(input.surface)) return "apparatus";
  if (!evidenceTopicMatchesRequest([input.surface], input.span, requestContentEvidenceUnits(input.requestText), input.requestText)) return "uncovered";
  return "admissible";
}

/** Request obligations a surface carries: each request content unit, plus each value the realization contract binds. */
export function surfaceRequestAdequacy(surface: string, input: Omit<LearnedSurfaceRecoveryInput, "learnedSurface">): { carried: number; owed: number } {
  const owedUnits = uniqueKernelStrings(surfaceUnits(input.requestText).filter(unit => !input.closedClassWords?.has(unit)));
  const units = surfaceUnits(surface);
  const boundValues = Object.values(input.realizationContract?.boundValues ?? {}).filter(Boolean);
  const normalized = surface.toLocaleLowerCase();
  return {
    carried: owedUnits.filter(unit => units.some(surfaceUnit => requestUnitSharesStem(unit, surfaceUnit))).length
      + boundValues.filter(value => normalized.includes(value.toLocaleLowerCase())).length,
    owed: owedUnits.length + boundValues.length
  };
}

/** Whether the learned surface must consult the source-bound realization before it is kept. */
export function learnedSurfaceConsultsSourceBound(input: LearnedSurfaceRecoveryInput & {
  preserved: boolean;
  learnedNotAnExcerpt: boolean;
}): boolean {
  const learned = input.learnedSurface.trim();
  if (!learned) return true;
  if (input.preserved) return false;
  if (input.learnedNotAnExcerpt) return true;
  const adequacy = surfaceRequestAdequacy(learned, input);
  return adequacy.carried < adequacy.owed;
}

/** A learned surface yields to a source-bound realization that contains it and carries more of the request. */
export function learnedSurfaceTruncatesSourceBound(input: LearnedSurfaceRecoveryInput & { sourceBound: string }): boolean {
  const learned = input.learnedSurface.trim();
  const sourceBound = input.sourceBound.trim();
  if (!learned || sourceBound.length <= learned.length || !sourceBound.includes(learned)) return false;
  return surfaceRequestAdequacy(sourceBound, input).carried > surfaceRequestAdequacy(learned, input).carried;
}

/** Learned dialogue intent can be source-independent without requesting novelty. */
export function sourceIndependentDialogueRequirements(field: Pick<TurnRequirementField,
  "sourceDependence" | "dialogueDependence" | "externalTruthAuthority" | "semanticPreservation"
>): boolean {
  return field.dialogueDependence > Math.max(field.externalTruthAuthority, field.sourceDependence, field.semanticPreservation);
}

/** A source-free dialogue surface belongs to its own authority lane. */
export function sourceIndependentDialogueSurfaceAcceptable(input: {
  requestedAuthority: RequestedAuthority;
  requirementField: Pick<TurnRequirementField,
    "sourceDependence" | "dialogueDependence" | "externalTruthAuthority" | "semanticPreservation"
  >;
  spoken: Pick<SpokenOutput, "text" | "surfaceValid" | "evidenceRefs">;
  selectedEvidenceCount: number;
}): boolean {
  return input.requestedAuthority === "reasoned"
    && input.selectedEvidenceCount === 0
    && input.spoken.surfaceValid
    && input.spoken.text.trim().length > 0
    && input.spoken.evidenceRefs.length === 0
    && sourceIndependentDialogueRequirements(input.requirementField);
}
