import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";
import {
  DIALOGUE_ACTION_IDS,
  type DialogueAnswerGraphLike,
  type DialoguePolicyDecision
} from "./dialogue-pragmatics.js";
import type { JsonValue } from "./types.js";

export interface StreamSegmentPlan {
  id: string;
  roleId: string;
  priority: number;
  dependencies: readonly string[];
  evidenceRefs: readonly string[];
  canEmitBeforeFullCompletion: boolean;
}

export interface StreamRhythmPlan {
  schema: "scce.dialogue.stream_rhythm_plan.v1";
  id: string;
  policyDecisionId: string;
  segments: StreamSegmentPlan[];
  trace: JsonValue;
}

export const STREAM_ROLE_IDS = {
  lead: "stream.6f2e9c31",
  boundary: "stream.97ab401e",
  evidence: "stream.d460a23b",
  artifact: "stream.2b371a88",
  next: "stream.c8197f2a"
} as const;

export function planStreamRhythm(input: {
  policyDecision: DialoguePolicyDecision;
  answerGraph: DialogueAnswerGraphLike;
  finalText: string;
}): StreamRhythmPlan {
  const evidenceRefs = uniqueStrings(input.answerGraph.supportLinks.map(link => link.evidenceId));
  const segments: StreamSegmentPlan[] = [];
  const boundaryRequired = input.answerGraph.uncertainty.unsupported ||
    input.answerGraph.uncertainty.missingEvidenceCount > 0 ||
    input.policyDecision.selectedActionIds.includes(DIALOGUE_ACTION_IDS.boundary);
  const add = (roleId: string, priority: number, dependencies: readonly string[], canEmitBeforeFullCompletion: boolean, refs = evidenceRefs) => {
    segments.push({
      id: `stream_segment.${hashText(canonicalStringify({ roleId, priority, dependencies, refs, text: input.finalText.slice(0, 80) }))}`,
      roleId,
      priority: clamp01(priority),
      dependencies,
      evidenceRefs: refs,
      canEmitBeforeFullCompletion
    });
  };
  if (boundaryRequired) add(STREAM_ROLE_IDS.boundary, 0.96, [], true);
  add(STREAM_ROLE_IDS.lead, boundaryRequired ? 0.82 : 0.96, boundaryRequired ? [STREAM_ROLE_IDS.boundary] : [], !boundaryRequired);
  if (evidenceRefs.length) add(STREAM_ROLE_IDS.evidence, 0.62, [STREAM_ROLE_IDS.lead], false);
  if (input.policyDecision.selectedActionIds.includes(DIALOGUE_ACTION_IDS.artifact)) add(STREAM_ROLE_IDS.artifact, 0.78, [STREAM_ROLE_IDS.lead], true, input.answerGraph.actions.flatMap(action => action.evidenceSpanIds));
  if (input.policyDecision.selectedActionIds.includes(DIALOGUE_ACTION_IDS.nextStep)) add(STREAM_ROLE_IDS.next, 0.46, [STREAM_ROLE_IDS.lead], false);
  const ordered = segments.sort((left, right) => right.priority - left.priority || left.roleId.localeCompare(right.roleId));
  return {
    schema: "scce.dialogue.stream_rhythm_plan.v1",
    id: `stream_plan.${hashText(canonicalStringify({ policy: input.policyDecision.id, segments: ordered }))}`,
    policyDecisionId: input.policyDecision.id,
    segments: ordered,
    trace: toJsonValue({
      source: "stream-rhythm.plan",
      boundaryRequired,
      selectedActionIds: input.policyDecision.selectedActionIds
    })
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
