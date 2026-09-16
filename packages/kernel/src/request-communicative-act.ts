// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { calibrated } from "./calibrations/prod-calibrations.js";
import { DEFAULT_USER_STYLE_PROFILE, DIALOGUE_ACT_IDS, type DialogueActId, type UserStyleProfile } from "./dialogue-pragmatics.js";
import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";
import { requestFeatures } from "./request-requirement-learning.js";
import type { LanguagePatternRecord } from "./storage.js";
import type { JsonValue } from "./types.js";

export const REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA = "scce.request_communicative_act_pattern.v1";
export const REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM = "request_communicative_act";

/** Continuation axes a recorded conversation measures for a turn; a live outcome observation carries none. */
export interface RequestCommunicativeActContinuation {
  floorReturned: boolean;
  replyDrawsOnTurn: boolean;
}

/** One owner request joined to the response it received and the owner's outcome on that response. */
export interface RequestCommunicativeActObservation {
  requestText: string;
  responseEvidenceCount: number;
  accepted?: boolean;
  rejected?: boolean;
  corrected?: boolean;
  continuation?: RequestCommunicativeActContinuation;
}

/** The outcome signature an act class is induced from; new axes extend the inventory without an enum. */
export interface RequestCommunicativeActSignature {
  accepted: true;
  evidenceBearing: boolean;
  continuation?: RequestCommunicativeActContinuation;
}

export interface RequestCommunicativeActModel {
  schema: "scce.request_communicative_act_model.v1";
  classCounts: Record<DialogueActId, number>;
  features: Map<string, { surface: string; anchor: string; counts: Record<DialogueActId, number> }>;
}

export type RequestCommunicativeActStatus = "active" | "bypassed_not_applicable" | "inert_unconfigured" | "disabled_explicitly" | "failed";

export interface RequestCommunicativeActClassification {
  schema: "scce.request_communicative_act_classification.v1";
  status: RequestCommunicativeActStatus;
  actId: DialogueActId;
  matchedPatternIds: string[];
  /** Log posterior odds of the selected act over the neutral act; zero when neutral is selected. */
  logOddsOverNeutral: number;
  classIds: DialogueActId[];
}

export function requestCommunicativeActIdForSignature(signature: RequestCommunicativeActSignature): DialogueActId {
  // An accepted evidence-bearing response is exactly what the neutral source-lookup act already produces.
  if (signature.evidenceBearing) return DIALOGUE_ACT_IDS.neutral;
  return `actshape.${fnv1a(canonicalStringify({ schema: "scce.request_act_signature.v1", ...signature }))}`;
}

/** Counts request n-gram presence per induced act class; only accepted outcomes say what a request wanted. */
export function compileRequestCommunicativeActModel(observations: readonly RequestCommunicativeActObservation[]): RequestCommunicativeActModel {
  const classCounts: Record<DialogueActId, number> = {};
  const features: RequestCommunicativeActModel["features"] = new Map();
  for (const observation of observations) {
    if (observation.accepted !== true || observation.rejected === true || observation.corrected === true) continue;
    const actId = requestCommunicativeActIdForSignature({
      accepted: true,
      evidenceBearing: observation.responseEvidenceCount > 0,
      ...(observation.continuation ? { continuation: observation.continuation } : {})
    });
    classCounts[actId] = (classCounts[actId] ?? 0) + 1;
    const seen = new Set<string>();
    for (const feature of requestFeatures(observation.requestText)) {
      if (seen.has(feature.key)) continue;
      seen.add(feature.key);
      const row = features.get(feature.key) ?? { surface: feature.surface, anchor: feature.anchor, counts: {} };
      row.counts[actId] = (row.counts[actId] ?? 0) + 1;
      features.set(feature.key, row);
    }
  }
  return { schema: "scce.request_communicative_act_model.v1", classCounts, features };
}

export function requestCommunicativeActPatterns(
  model: RequestCommunicativeActModel,
  input: { profileId: string; updatedAt: number; makeId(representation: JsonValue): string }
): LanguagePatternRecord[] {
  const total = Object.values(model.classCounts).reduce((sum, count) => sum + count, 0);
  return [...model.features.entries()]
    .map(([key, row]) => ({ key, row, support: Object.values(row.counts).reduce((sum, count) => sum + count, 0) }))
    .sort((left, right) => right.support - left.support || left.key.localeCompare(right.key))
    // Cost bound on persisted rows, matching the request-control hydration limit.
    .slice(0, 2048)
    .map(({ key, row, support }) => ({
      id: input.makeId(toJsonValue({ schema: REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA, profileId: input.profileId, key })),
      profileId: input.profileId,
      patternKind: "discourse" as const,
      support: clamp01(support / Math.max(1, total)),
      entropy: normalizedEntropy(Object.values(row.counts)),
      patternJson: toJsonValue({
        schema: REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,
        sourceSystem: REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM,
        matchMode: "unicode_token_ngram",
        learnedFrameOrPatternId: key,
        surface: row.surface,
        anchor: row.anchor,
        actCounts: row.counts,
        classCounts: model.classCounts
      }),
      evidenceIds: [],
      updatedAt: input.updatedAt
    }));
}

/** A promoted artifact needs a contrast: at least two observed classes, one of them neutral. */
export function requestCommunicativeActModelFromPatterns(patterns: readonly LanguagePatternRecord[]): RequestCommunicativeActModel | undefined {
  const rows = patterns.filter(pattern => record(pattern.patternJson).schema === REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA);
  const latest = rows.reduce((max, pattern) => Math.max(max, pattern.updatedAt), Number.NEGATIVE_INFINITY);
  const current = rows.filter(pattern => pattern.updatedAt === latest);
  if (!current.length) return undefined;
  const classCounts = countRecord(record(current[0]!.patternJson).classCounts);
  if (Object.keys(classCounts).length < 2 || !classCounts[DIALOGUE_ACT_IDS.neutral]) return undefined;
  const features: RequestCommunicativeActModel["features"] = new Map();
  for (const pattern of current) {
    const json = record(pattern.patternJson);
    if (typeof json.learnedFrameOrPatternId !== "string" || typeof json.surface !== "string" || typeof json.anchor !== "string") continue;
    features.set(json.learnedFrameOrPatternId, { surface: json.surface, anchor: json.anchor, counts: countRecord(json.actCounts) });
  }
  return { schema: "scce.request_communicative_act_model.v1", classCounts, features };
}

/** Bernoulli naive Bayes over the request's matched n-grams; O(request length) against a hydrated model. */
export function classifyRequestCommunicativeAct(
  requestText: string,
  model: RequestCommunicativeActModel | undefined,
  options: { status?: "disabled_explicitly" | "failed" } = {}
): RequestCommunicativeActClassification {
  const neutral = (status: RequestCommunicativeActStatus, matchedPatternIds: string[] = [], classIds: DialogueActId[] = []): RequestCommunicativeActClassification => ({
    schema: "scce.request_communicative_act_classification.v1",
    status,
    actId: DIALOGUE_ACT_IDS.neutral,
    matchedPatternIds,
    logOddsOverNeutral: 0,
    classIds
  });
  if (options.status) return neutral(options.status);
  if (!model) return neutral("inert_unconfigured");
  const classIds = Object.keys(model.classCounts).sort();
  const matched = [...new Set(requestFeatures(requestText).map(feature => feature.key))].filter(key => model.features.has(key));
  if (!matched.length) return neutral("bypassed_not_applicable", [], classIds);
  const pseudoCount = calibrated("request_act.feature_pseudo_count");
  const scores = new Map<DialogueActId, number>();
  for (const actId of classIds) {
    const classCount = model.classCounts[actId]!;
    let score = Math.log(classCount);
    for (const key of matched) {
      score += Math.log(((model.features.get(key)!.counts[actId] ?? 0) + pseudoCount) / (classCount + 2 * pseudoCount));
    }
    scores.set(actId, score);
  }
  const neutralScore = scores.get(DIALOGUE_ACT_IDS.neutral)!;
  const winner = classIds.reduce((best, actId) => scores.get(actId)! > scores.get(best)! ? actId : best, DIALOGUE_ACT_IDS.neutral as DialogueActId);
  // Cost bound on the traced id list.
  const matchedPatternIds = matched.slice(0, 64);
  return {
    schema: "scce.request_communicative_act_classification.v1",
    status: "active",
    actId: winner,
    matchedPatternIds,
    logOddsOverNeutral: scores.get(winner)! - neutralScore,
    classIds
  };
}

/**
 * The dialogue-state patch for a classified act. A weight this conversation already learned for the act wins;
 * otherwise the act's weight is set so its logit over the neutral weight equals the classifier's log-odds.
 */
export function requestCommunicativeActStatePatch(
  classification: RequestCommunicativeActClassification,
  profile: Partial<UserStyleProfile> | undefined
): { communicativeActId: DialogueActId; communicativeActWeights: Record<DialogueActId, number> } | undefined {
  if (classification.status !== "active" || classification.actId === DIALOGUE_ACT_IDS.neutral) return undefined;
  const weights = { ...(profile?.communicativeActWeights ?? DEFAULT_USER_STYLE_PROFILE.communicativeActWeights ?? {}) };
  if (weights[classification.actId] === undefined) {
    const neutralWeight = weights[DIALOGUE_ACT_IDS.neutral] ?? DEFAULT_USER_STYLE_PROFILE.communicativeActWeights![DIALOGUE_ACT_IDS.neutral]!;
    weights[DIALOGUE_ACT_IDS.neutral] = neutralWeight;
    weights[classification.actId] = sigmoid(logit(neutralWeight) + classification.logOddsOverNeutral);
  }
  return { communicativeActId: classification.actId, communicativeActWeights: weights };
}

function normalizedEntropy(counts: readonly number[]): number {
  const total = counts.reduce((sum, count) => sum + count, 0);
  const occupied = counts.filter(count => count > 0);
  if (total <= 0 || occupied.length <= 1) return 0;
  const entropy = occupied.reduce((sum, count) => sum - (count / total) * Math.log(count / total), 0);
  return clamp01(entropy / Math.log(occupied.length));
}

function logit(value: number): number {
  const p = Math.min(1 - Number.EPSILON, Math.max(Number.EPSILON, value));
  return Math.log(p / (1 - p));
}

function sigmoid(value: number): number {
  return 1 / (1 + Math.exp(-value));
}

function countRecord(value: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, count] of Object.entries(record(value))) {
    if (typeof count === "number" && Number.isFinite(count) && count > 0) out[key] = count;
  }
  return out;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function fnv1a(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
