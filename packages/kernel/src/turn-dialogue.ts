import { canonicalStringify, toJsonValue } from "./primitives.js";
import {
  realizeDialogueResponse,
  type DialogueAnswerGraphLike,
  type DialoguePragmaticsResult,
  type UserStyleProfile
} from "./dialogue-pragmatics.js";
import type { CalibrationModelSet } from "./calibration-spine.js";
import { planStreamRhythm, type StreamRhythmPlan } from "./stream-rhythm.js";
import type { EvidenceSpan, JsonValue, TurnResult } from "./types.js";

const TURN_DIALOGUE_STATUS_IDS = {
  ready: "turn.status.4d2a1e9b",
  unsupported: "turn.status.b71c30f4"
} as const;

const TURN_DIALOGUE_ROLE_IDS = {
  answer: "turn.role.0fb8a61d",
  boundary: "turn.role.a46e2c19",
  artifact: "turn.role.5c2d7a03"
} as const;

const TURN_DIALOGUE_ACTION_IDS = {
  artifact: "turn.action.2b5f1d8c"
} as const;

export interface TurnDialogueBridge {
  schema: "scce.turn_dialogue_bridge.v1";
  conversationId: string;
  turnId: string;
  answerGraphHash: string;
  answerGraph: DialogueAnswerGraphLike;
  pragmatics: DialoguePragmaticsResult;
  streamPlan: StreamRhythmPlan;
  trace: JsonValue;
}

export function buildTurnDialogueBridge(input: {
  requestText: string;
  result: TurnResult;
  conversationId: string;
  turnId?: string;
  targetLanguage?: string;
  userStyleProfile?: UserStyleProfile;
  calibrationModels?: CalibrationModelSet;
  calibrationTaskClass?: string;
}): TurnDialogueBridge {
  const turnId = input.turnId ?? String(input.result.episodeId);
  const answerGraph = answerGraphFromTurnResult(input.result);
  const answerGraphHash = hashText(canonicalStringify(answerGraph));
  const pragmatics = realizeDialogueResponse({
    requestText: input.requestText,
    conversationId: input.conversationId,
    turnId,
    targetLanguage: input.targetLanguage,
    answerGraph,
    candidateTexts: [input.result.answer],
    calibrationModels: input.calibrationModels,
    calibrationTaskClass: input.calibrationTaskClass,
    statePatch: input.userStyleProfile ? { userStyleProfile: input.userStyleProfile } : undefined
  });
  const streamPlan = planStreamRhythm({ policyDecision: pragmatics.policyDecision, answerGraph, finalText: pragmatics.finalText });
  return {
    schema: "scce.turn_dialogue_bridge.v1",
    conversationId: input.conversationId,
    turnId,
    answerGraphHash,
    answerGraph,
    pragmatics,
    streamPlan,
    trace: toJsonValue({
      source: "turn-dialogue.bridge",
      episodeId: String(input.result.episodeId),
      assistantForce: input.result.assistantForce ?? null,
      evidenceCount: input.result.evidence.length,
      selectedActionIds: pragmatics.policyDecision.selectedActionIds
    })
  };
}

function answerGraphFromTurnResult(result: TurnResult): DialogueAnswerGraphLike {
  const claimId = `turn.claim.${hashText(result.answer).slice(0, 16)}`;
  const supportLinks = result.evidence.map(span => ({
    claimId,
    evidenceId: String(span.id),
    sourceRef: sourceRefFromEvidence(span),
    forceClass: result.assistantForce ?? result.epistemicForce
  }));
  const unsupported = result.assistantForce === "insufficient_support" || (!result.evidence.length && result.epistemicForce !== "proved" && result.epistemicForce !== "observed");
  return {
    id: `turn.answer_graph.${hashText(canonicalStringify({ episodeId: result.episodeId, answer: result.answer, evidence: supportLinks.map(link => link.evidenceId) })).slice(0, 24)}`,
    statusId: unsupported ? TURN_DIALOGUE_STATUS_IDS.unsupported : TURN_DIALOGUE_STATUS_IDS.ready,
    claims: result.answer.trim() ? [{
      id: claimId,
      roleId: TURN_DIALOGUE_ROLE_IDS.answer,
      surface: result.answer,
      certified: !unsupported && supportLinks.length > 0
    }] : [],
    supportLinks,
    caveats: unsupported ? [{
      id: `turn.caveat.${hashText(result.answer).slice(0, 16)}`,
      roleId: TURN_DIALOGUE_ROLE_IDS.boundary,
      text: result.answer || "[scce:turn.answer.unselected]"
    }] : [],
    actions: result.constructGraph.artifacts.map((artifact, index) => ({
      id: `${TURN_DIALOGUE_ACTION_IDS.artifact}.${index}`,
      roleId: TURN_DIALOGUE_ROLE_IDS.artifact,
      affectedFiles: [artifact.path],
      evidenceSpanIds: result.evidence.map(span => String(span.id))
    })),
    uncertainty: {
      unsupported,
      missingEvidenceCount: supportLinks.length ? 0 : unsupported ? 1 : 0,
      contradictionCount: Math.max(0, Math.ceil(result.entailment.contradiction)),
      gapCount: result.learningNeeds.length
    }
  };
}

function sourceRefFromEvidence(span: EvidenceSpan): { path?: string; lineStart?: number; lineEnd?: number } | undefined {
  const provenance = objectRecord(span.provenance);
  const path = stringValue(provenance.path) ?? stringValue(provenance.sourcePath) ?? stringValue(provenance.uri) ?? stringValue(provenance.canonicalUri);
  const lineStart = numberValue(provenance.lineStart) ?? numberValue(provenance.line);
  const lineEnd = numberValue(provenance.lineEnd);
  return path ? { path, lineStart, lineEnd } : undefined;
}

function objectRecord(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function stringValue(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function numberValue(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
