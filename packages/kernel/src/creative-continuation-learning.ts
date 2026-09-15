// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement.

import {
  CALIBRATION_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  CREATIVE_PREFERENCE_FEATURE_SCHEMA,
  buildCreativePreferenceModels,
  creativePreferenceObservationPair,
  creativePreferenceScore,
  type CalibrationObservationRecord,
  type CreativePreferenceFeatureVector,
  type CreativePreferenceModel,
  type CalibrationModelSet
} from "./calibration-spine.js";
import { canonicalStringify, clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { DialogueMemoryStore } from "./storage.js";
import type { JsonValue } from "./types.js";

/** A turn-local offer record. It is deliberately outside the pairwise
 * calibration id so merely offering a candidate can never train a preference
 * model. The outcome route uses this record to recover only candidates that
 * were actually present in the original decision. */
export const CREATIVE_CONTINUATION_OFFER_CALIBRATION_ID = "candidate.creative_continuation_offer" as const;
export const CREATIVE_CONTINUATION_OFFER_SCHEMA = "scce.creative_continuation.offer.v1" as const;
export const CREATIVE_CONTINUATION_DECISION_SCHEMA = "scce.creative_continuation.decision.v1" as const;

export interface CreativeContinuationDecision {
  schema: typeof CREATIVE_CONTINUATION_DECISION_SCHEMA;
  state: CreativeContinuationState;
  offered: CreativeContinuationCandidate[];
  selectedCandidateId: string;
  selectedContinuationCandidateId?: string;
}

/** A typed, language-neutral state key for a creative continuation decision. */
export interface CreativeContinuationState {
  schema: "scce.creative_continuation_state.v1";
  conversationId: string;
  turnId: string;
  discourseStateId: string;
  semanticFrameId: string;
  languageId: string;
  goalId?: string;
}

/** The structural identity of a continuation, independent of its realized text. */
export interface CreativeContinuationCandidate {
  candidateId: string;
  structureId: string;
  continuationModeId: string;
  semanticOperatorId: string;
  features: CreativePreferenceFeatureVector;
  selectedOutputHash?: string;
}

export interface CreativeContinuationPreferenceInput {
  state: CreativeContinuationState;
  preferred: CreativeContinuationCandidate;
  rejected: CreativeContinuationCandidate;
  preferenceKind?: "accepted_rejected" | "corrected_original";
  sourceTraceId?: string;
  sourceRecordId: string;
  preferenceId?: string;
  createdAt?: number;
}

export interface CreativeContinuationPolicy {
  schema: "scce.creative_continuation_policy.v1";
  ownerScopeId: string;
  modelSet: CalibrationModelSet;
  observations: number;
  statePreferences: ReadonlyMap<string, ReadonlyMap<string, CreativeStructuralSupport>>;
}

export interface CreativeStructuralSupport {
  preferred: number;
  rejected: number;
}

export interface CreativeContinuationScore {
  candidate: CreativeContinuationCandidate;
  score: number;
  baseScore: number;
  ownerAdjustment: number;
  source: "bootstrap" | "pairwise_preference";
}

/** Projects the real invention construct into opaque structural identities.
 * The realized proposal is used only for an output hash; no surface text is
 * persisted in the preference record. */
export function creativeContinuationCandidateFromConstruct(input: {
  construct: {
    id: string;
    artifactKindIds: readonly string[];
    basisEvidenceIds: readonly string[];
    basisPriorIds: readonly string[];
    supportScore: number;
    noveltyScore: number;
    riskScore: number;
    proposalSurface: string;
    trace: JsonValue;
  };
  candidateIndex: number;
  hasher?: { digestHex(value: string): string };
}): CreativeContinuationCandidate {
  const trace = record(input.construct.trace);
  const realization = record(trace.proposalRealization);
  const structuralPlan = record(trace.structuralSemanticPlan);
  const eventKinds = Array.isArray(structuralPlan.events)
    ? structuralPlan.events.map(event => record(event).kind ?? record(event).eventId ?? null).filter((value): value is string => typeof value === "string")
    : [];
  const hashValue = input.hasher?.digestHex.bind(input.hasher) ?? ((value: string) => createHasher().digestHex(value));
  const programGraphId = typeof trace.programGraphId === "string" ? trace.programGraphId : undefined;
  const sourceBundleIds = Array.isArray(structuralPlan.sourceBundleIds)
    ? structuralPlan.sourceBundleIds.filter((value): value is string => typeof value === "string")
    : [];
  const selectedGraphEdgeIds = stringArray(trace.selectedGraphEdgeIds);
  const selectedLanguagePriorIds = stringArray(trace.selectedLanguagePriorIds);
  const hasStructuralSignals = Boolean(
    structuralPlan.id
    || programGraphId
    || sourceBundleIds.length
    || eventKinds.length
    || selectedGraphEdgeIds.length
    || selectedLanguagePriorIds.length
  );
  const structuralSignature = {
    artifactKindIds: [...input.construct.artifactKindIds].sort(),
    basisPriorIds: [...input.construct.basisPriorIds].sort(),
    programGraphId: programGraphId ?? null,
    semanticPlanId: typeof structuralPlan.id === "string" ? structuralPlan.id : null,
    sourceBundleIds: sourceBundleIds.sort(),
    eventKinds,
    selectedGraphEdgeIds,
    selectedLanguagePriorIds,
    // A planner that supplied no typed structural handle still gets a stable
    // opaque identity for this construct; otherwise every such candidate
    // would collapse into one preference bucket.
    fallbackConstructId: hasStructuralSignals ? null : input.construct.id
  };
  const structureId = `creative.structure.${hashValue(canonicalStringify(toJsonValue(structuralSignature))).slice(0, 32)}`;
  const continuationModeId = `creative.mode.${hashValue(String(realization.path ?? structuralPlan.id ?? "")).slice(0, 24)}`;
  const semanticOperatorId = `creative.operator.${hashValue(canonicalStringify(toJsonValue({
    selectedGraphEdgeIds: structuralSignature.selectedGraphEdgeIds,
    selectedLanguagePriorIds: structuralSignature.selectedLanguagePriorIds,
    eventKinds
  }))).slice(0, 24)}`;
  const features = creativeFeaturesFromConstruct(input.construct);
  return {
    candidateId: `creative:${input.construct.id}:${input.candidateIndex}`,
    structureId,
    continuationModeId,
    semanticOperatorId,
    features,
    selectedOutputHash: hashValue(input.construct.proposalSurface)
  };
}

export function creativeContinuationDecision(input: {
  state: CreativeContinuationState;
  offered: readonly CreativeContinuationCandidate[];
  selectedCandidateId: string;
}): CreativeContinuationDecision {
  const selected = input.offered.find(candidate => candidate.candidateId === input.selectedCandidateId);
  return {
    schema: CREATIVE_CONTINUATION_DECISION_SCHEMA,
    state: input.state,
    offered: [...input.offered],
    selectedCandidateId: input.selectedCandidateId,
    ...(selected ? { selectedContinuationCandidateId: selected.candidateId } : {})
  };
}

export async function persistCreativeContinuationOffer(input: {
  store: Pick<DialogueMemoryStore, "putCalibrationObservation">;
  decision: CreativeContinuationDecision;
  sourceRecordId?: string;
  sourceTraceId?: string;
  createdAt?: number;
}): Promise<CalibrationObservationRecord> {
  validateState(input.decision.state);
  const record: CalibrationObservationRecord = {
    schema: "scce.calibration.observation.v1",
    id: `creative.offer.${hash(canonicalStringify({ state: input.decision.state, selected: input.decision.selectedCandidateId }))}`,
    calibrationId: CREATIVE_CONTINUATION_OFFER_CALIBRATION_ID,
    subsystemId: "subsystem.candidate",
    taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
    rawScore: 0,
    outcome: false,
    finalOutcome: "offered",
    sourceTraceId: input.sourceTraceId,
    sourceRecordId: input.sourceRecordId ?? input.decision.state.turnId,
    metadata: toJsonValue({
      schema: CREATIVE_CONTINUATION_OFFER_SCHEMA,
      decision: input.decision
    }),
    createdAt: input.createdAt ?? Date.now()
  };
  await input.store.putCalibrationObservation(record);
  return record;
}

export function creativeContinuationDecisionFromObservation(row: CalibrationObservationRecord): CreativeContinuationDecision | undefined {
  if (row.calibrationId !== CREATIVE_CONTINUATION_OFFER_CALIBRATION_ID) return undefined;
  const metadata = record(row.metadata);
  if (metadata.schema !== CREATIVE_CONTINUATION_OFFER_SCHEMA) return undefined;
  return creativeContinuationDecisionFromJson(metadata.decision);
}

export function creativeContinuationDecisionFromJson(value: JsonValue | undefined): CreativeContinuationDecision | undefined {
  const decision = record(value);
  if (decision.schema !== CREATIVE_CONTINUATION_DECISION_SCHEMA) return undefined;
  const state = parseState(decision.state);
  if (!state || !Array.isArray(decision.offered) || typeof decision.selectedCandidateId !== "string") return undefined;
  const offered = decision.offered.map(parseCandidate).filter((candidate): candidate is CreativeContinuationCandidate => Boolean(candidate));
  if (offered.length !== decision.offered.length || !offered.some(candidate => candidate.candidateId === decision.selectedCandidateId)) return undefined;
  return {
    schema: CREATIVE_CONTINUATION_DECISION_SCHEMA,
    state,
    offered,
    selectedCandidateId: decision.selectedCandidateId,
    ...(typeof decision.selectedContinuationCandidateId === "string" ? { selectedContinuationCandidateId: decision.selectedContinuationCandidateId } : {})
  };
}

function creativeFeaturesFromConstruct(input: {
  supportScore: number;
  noveltyScore: number;
  riskScore: number;
  trace: JsonValue;
}): CreativePreferenceFeatureVector {
  const trace = record(input.trace);
  return {
    constraintCoverage: metric(trace.constraintCoverage, input.supportScore),
    graphCoherence: metric(trace.graphCoherence, input.supportScore),
    novelty: metric(trace.novelty, input.noveltyScore),
    languageRealizability: metric(trace.languageRealizability, 0),
    usefulness: metric(trace.usefulness, input.supportScore),
    risk: metric(trace.risk, input.riskScore),
    repetition: metric(trace.repetition, 0),
    unsupportedFactualAssertion: metric(trace.unsupportedFactualAssertion, 0)
  };
}

function metric(value: JsonValue | undefined, fallback: number): number {
  return clamp01(typeof value === "number" && Number.isFinite(value) ? value : fallback);
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string").sort()
    : [];
}

export const CREATIVE_CONTINUATION_PREFERENCE_SCHEMA = "scce.creative_continuation.preference.v1" as const;

/**
 * Persists a real owner preference as two ordinary creative calibration rows,
 * enriched with typed discourse/semantic context and structural identities.
 * The output surface is represented only by its caller-supplied hash.
 */
export async function persistCreativeContinuationPreference(input: {
  store: Pick<DialogueMemoryStore, "putCalibrationObservation">;
  preference: CreativeContinuationPreferenceInput;
}): Promise<CalibrationObservationRecord[]> {
  validateState(input.preference.state);
  validateCandidate(input.preference.preferred);
  validateCandidate(input.preference.rejected);
  const preference = input.preference;
  const preferenceKind = preference.preferenceKind ?? "accepted_rejected";
  const pairId = preference.preferenceId ?? continuationPreferenceId(preference);
  const rows = creativePreferenceObservationPair({
    pairId,
    preferred: preference.preferred,
    rejected: preference.rejected,
    preferenceKind,
    sourceTraceId: preference.sourceTraceId,
    sourceRecordId: preference.sourceRecordId,
    createdAt: preference.createdAt
  });
  const enriched = rows.map((row, index) => {
    const candidate = index === 0 ? preference.preferred : preference.rejected;
    const role = index === 0 ? "preferred" : "rejected";
    return {
      ...row,
      metadata: toJsonValue({
        schema: "scce.creative_preference.observation.v1",
        featureSchemaId: CREATIVE_PREFERENCE_FEATURE_SCHEMA.id,
        pairId,
        role,
        candidateId: candidate.candidateId,
        preferenceKind,
        features: candidate.features,
        continuation: {
          schema: CREATIVE_CONTINUATION_PREFERENCE_SCHEMA,
          state: preference.state,
          candidate: {
            candidateId: candidate.candidateId,
            structureId: candidate.structureId,
            continuationModeId: candidate.continuationModeId,
            semanticOperatorId: candidate.semanticOperatorId,
            features: candidate.features,
            selectedOutputHash: candidate.selectedOutputHash ?? null
          }
        }
      })
    } satisfies CalibrationObservationRecord;
  });
  for (const row of enriched) await input.store.putCalibrationObservation(row);
  return enriched;
}

/** Reloads only this owner's scoped structural preferences after process restart. */
export async function loadCreativeContinuationPolicy(input: {
  store: Pick<DialogueMemoryStore, "listCalibrationObservations">;
  state: CreativeContinuationState;
  limit?: number;
  createdAt?: number;
}): Promise<CreativeContinuationPolicy> {
  validateState(input.state);
  const observations = await input.store.listCalibrationObservations({
    calibrationId: CALIBRATION_IDS.creativeCandidatePreference,
    taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
    limit: Math.max(1, Math.min(10_000, Math.floor(input.limit ?? 5_000)))
  });
  const scoped = observations.filter(row => continuationObservationState(row)?.conversationId === input.state.conversationId);
  const models = buildCreativePreferenceModels({
    observations: scoped,
    minPairs: 1,
    createdAt: input.createdAt
  });
  const modelSet: CalibrationModelSet = {
    schema: "scce.calibration.model_set.v1",
    id: `creative.continuation.model_set.${hash(canonicalStringify({ state: input.state, model: modelHash(models[CALIBRATION_TASK_CLASS_IDS.creativeGeneration]) }))}`,
    models: {},
    creativePreferenceModels: models,
    observationCount: scoped.length,
    createdAt: input.createdAt ?? Date.now()
  };
  const stateKey = continuationStateKey(input.state);
  const stateSupport = new Map<string, CreativeStructuralSupport>();
  const contextSupport = new Map<string, CreativeStructuralSupport>();
  const contextKey = continuationSemanticContextKey(input.state);
  for (const row of scoped) {
    const parsed = continuationObservation(row);
    if (!parsed) continue;
    const parsedStateKey = continuationStateKey(parsed.state);
    const parsedContextKey = continuationSemanticContextKey(parsed.state);
    if (parsedContextKey !== contextKey) continue;
    addSupport(contextSupport, parsed.candidate, parsed.role);
    if (parsedStateKey === stateKey) addSupport(stateSupport, parsed.candidate, parsed.role);
  }
  const statePreferences = new Map<string, ReadonlyMap<string, CreativeStructuralSupport>>();
  statePreferences.set(stateKey, stateSupport);
  statePreferences.set(contextKey, contextSupport);
  return {
    schema: "scce.creative_continuation_policy.v1",
    ownerScopeId: input.state.conversationId,
    modelSet,
    observations: scoped.length,
    statePreferences
  };
}

/** Scores a fresh candidate set using durable owner feedback for the typed state. */
export function rankCreativeContinuations(input: {
  state: CreativeContinuationState;
  candidates: readonly CreativeContinuationCandidate[];
  policy?: CreativeContinuationPolicy;
}): CreativeContinuationScore[] {
  validateState(input.state);
  const stateKey = continuationStateKey(input.state);
  const support = input.policy?.statePreferences.get(stateKey);
  const contextSupport = input.policy?.statePreferences.get(continuationSemanticContextKey(input.state));
  return input.candidates
    .map(candidate => {
      validateCandidate(candidate);
      const base = creativePreferenceScore({
        features: candidate.features,
        modelSet: input.policy?.modelSet,
        taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration
      });
      const structural = support?.get(structureKey(candidate)) ?? contextSupport?.get(structureKey(candidate));
      const mode = support?.get(modeKey(candidate)) ?? contextSupport?.get(modeKey(candidate));
      const operator = support?.get(operatorKey(candidate)) ?? contextSupport?.get(operatorKey(candidate));
      const net = (structural?.preferred ?? 0) - (structural?.rejected ?? 0);
      const modeNet = (mode?.preferred ?? 0) - (mode?.rejected ?? 0);
      const operatorNet = (operator?.preferred ?? 0) - (operator?.rejected ?? 0);
      // Explicit owner feedback is a bounded adjustment. It can change a
      // continuation choice, while the learned feature model still supplies
      // the cold-start and generalization score.
      const ownerAdjustment = 0.8 * Math.tanh(net) + 0.3 * Math.tanh(modeNet) + 0.2 * Math.tanh(operatorNet);
      return {
        candidate,
        score: base.score + ownerAdjustment,
        baseScore: base.score,
        ownerAdjustment,
        source: base.source
      } satisfies CreativeContinuationScore;
    })
    .sort((left, right) => right.score - left.score || left.candidate.candidateId.localeCompare(right.candidate.candidateId));
}

function continuationPreferenceId(input: CreativeContinuationPreferenceInput): string {
  return `creative.preference.${hash(canonicalStringify({
    state: input.state,
    sourceRecordId: input.sourceRecordId,
    preferred: input.preferred.candidateId,
    rejected: input.rejected.candidateId
  }))}`;
}

function continuationStateKey(state: CreativeContinuationState): string {
  return canonicalStringify({
    conversationId: state.conversationId,
    discourseStateId: state.discourseStateId,
    semanticFrameId: state.semanticFrameId,
    languageId: state.languageId,
    goalId: state.goalId ?? null
  });
}

function continuationSemanticContextKey(state: CreativeContinuationState): string {
  return canonicalStringify({
    conversationId: state.conversationId,
    semanticFrameId: state.semanticFrameId,
    languageId: state.languageId,
    goalId: state.goalId ?? null
  });
}

function addSupport(
  support: Map<string, CreativeStructuralSupport>,
  candidate: CreativeContinuationCandidate,
  role: "preferred" | "rejected"
): void {
  for (const key of [structureKey(candidate), modeKey(candidate), operatorKey(candidate)]) {
    const current = support.get(key) ?? { preferred: 0, rejected: 0 };
    current[role] += 1;
    support.set(key, current);
  }
}

function structureKey(candidate: CreativeContinuationCandidate): string {
  return `structure:${candidate.structureId}`;
}

function modeKey(candidate: CreativeContinuationCandidate): string {
  return `mode:${candidate.continuationModeId}`;
}

function operatorKey(candidate: CreativeContinuationCandidate): string {
  return `operator:${candidate.semanticOperatorId}`;
}

function continuationObservationState(row: CalibrationObservationRecord): CreativeContinuationState | undefined {
  return continuationObservation(row)?.state;
}

function continuationObservation(row: CalibrationObservationRecord): {
  state: CreativeContinuationState;
  candidate: CreativeContinuationCandidate;
  role: "preferred" | "rejected";
} | undefined {
  const metadata = record(row.metadata);
  if (metadata.schema !== "scce.creative_preference.observation.v1") return undefined;
  const continuation = record(metadata.continuation);
  if (continuation.schema !== CREATIVE_CONTINUATION_PREFERENCE_SCHEMA) return undefined;
  const state = parseState(continuation.state);
  const candidate = parseCandidate(continuation.candidate);
  const role = metadata.role === "preferred" || metadata.role === "rejected" ? metadata.role : undefined;
  return state && candidate && role ? { state, candidate, role } : undefined;
}

function parseState(value: JsonValue | undefined): CreativeContinuationState | undefined {
  const row = record(value);
  if (row.schema !== "scce.creative_continuation_state.v1") return undefined;
  if (![row.conversationId, row.turnId, row.discourseStateId, row.semanticFrameId, row.languageId].every(item => typeof item === "string" && item.length > 0)) return undefined;
  return {
    schema: "scce.creative_continuation_state.v1",
    conversationId: row.conversationId as string,
    turnId: row.turnId as string,
    discourseStateId: row.discourseStateId as string,
    semanticFrameId: row.semanticFrameId as string,
    languageId: row.languageId as string,
    ...(typeof row.goalId === "string" ? { goalId: row.goalId } : {})
  };
}

function parseCandidate(value: JsonValue | undefined): CreativeContinuationCandidate | undefined {
  const row = record(value);
  if (![row.candidateId, row.structureId, row.continuationModeId, row.semanticOperatorId].every(item => typeof item === "string" && item.length > 0)) return undefined;
  const featureRecord = record(row.features);
  const featureIds = CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds;
  if (featureIds.some(id => typeof featureRecord[id] !== "number")) return undefined;
  return {
    candidateId: row.candidateId as string,
    structureId: row.structureId as string,
    continuationModeId: row.continuationModeId as string,
    semanticOperatorId: row.semanticOperatorId as string,
    features: normalizeFeatures(featureRecord),
    ...(typeof row.selectedOutputHash === "string" ? { selectedOutputHash: row.selectedOutputHash } : {})
  };
}

function validateState(state: CreativeContinuationState): void {
  if (state.schema !== "scce.creative_continuation_state.v1") throw new Error("creative continuation state schema is invalid");
  if (![state.conversationId, state.turnId, state.discourseStateId, state.semanticFrameId, state.languageId].every(value => typeof value === "string" && value.length > 0)) {
    throw new Error("creative continuation state requires scoped typed ids");
  }
}

function validateCandidate(candidate: CreativeContinuationCandidate): void {
  if (![candidate.candidateId, candidate.structureId, candidate.continuationModeId, candidate.semanticOperatorId].every(value => typeof value === "string" && value.length > 0)) {
    throw new Error("creative continuation candidate requires structural ids");
  }
}

function normalizeFeatures(value: Record<string, JsonValue>): CreativePreferenceFeatureVector {
  return {
    constraintCoverage: clamp01(number(value.constraintCoverage)),
    graphCoherence: clamp01(number(value.graphCoherence)),
    novelty: clamp01(number(value.novelty)),
    languageRealizability: clamp01(number(value.languageRealizability)),
    usefulness: clamp01(number(value.usefulness)),
    risk: clamp01(number(value.risk)),
    repetition: clamp01(number(value.repetition)),
    unsupportedFactualAssertion: clamp01(number(value.unsupportedFactualAssertion))
  };
}

function number(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function record(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function modelHash(model: CreativePreferenceModel | undefined): string | null {
  return model?.modelHash ?? null;
}

function hash(value: string): string {
  return createHasher().digestHex(value).slice(0, 32);
}
