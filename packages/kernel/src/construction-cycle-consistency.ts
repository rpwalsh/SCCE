// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { atomizeText } from "./semantic-proof-system.js";
import { SEMANTIC_SOURCE } from "./semantic-codes.js";
import { computeSemanticRoundTripDistance } from "./semantic-round-trip.js";
import { languageRoundTripDeltaFromMismatch, type LanguageRoundTripDelta } from "./language-round-trip-learning.js";
import { calibrationObservationRecord, type CalibrationObservationRecord } from "./calibration-spine.js";
import { createHasher, clamp01, toJsonValue } from "./primitives.js";
import {
  realizeLearnedSurface,
  type LearnedConstruction,
  type LearnedFormClass,
  type LearnedRealization,
  type LearnedSurfaceResult,
  type SurfaceMeaningPlan
} from "./language-construction.js";
import type { DialogueMemoryStore } from "./storage.js";
import type { Hasher, JsonValue } from "./types.js";

export const CONSTRUCTION_CYCLE_CONSISTENCY_SCHEMA =
  "scce.construction_cycle_consistency.v1" as const;
export const CONSTRUCTION_CYCLE_CALIBRATION_ID =
  "calibration.language.construction_cycle.v1" as const;

export interface ConstructionCycleSemanticDelta {
  missing: number;
  added: number;
  reversed: number;
  quantityMismatches: number;
  timeMismatches: number;
  polarityMismatches: number;
  modalityMismatches: number;
  discourseForceMismatches: number;
  total: number;
}

export interface ConstructionCycleConsistencyOutcome {
  schema: typeof CONSTRUCTION_CYCLE_CONSISTENCY_SCHEMA;
  constructionId: string;
  planId: string;
  profileKey: string;
  sourceExampleIds: string[];
  evidenceIds: string[];
  intendedSurfaceHash: string;
  realizedSurfaceHash: string;
  semanticDelta: ConstructionCycleSemanticDelta;
  /** Typed source-derived correction emitted when the measured cycle drifts. */
  languageDelta?: LanguageRoundTripDelta;
  score: number;
  outcome: boolean;
  sourceTraceId?: string;
  sourceRecordId?: string;
  createdAt: number;
}

const hasher = createHasher();

/** Scores the real typed-meaning -> learned realization -> atom interpretation cycle. */
export function evaluateConstructionCycleConsistency(input: {
  construction: LearnedConstruction;
  realization: LearnedRealization;
  intendedSurface: string;
  sourceTraceId?: string;
  sourceRecordId?: string;
  /** Optional typed realization context below the construction/profile pair. */
  contextKey?: string;
  evidenceIds?: readonly string[];
  createdAt: number;
}): ConstructionCycleConsistencyOutcome {
  const intendedAtoms = atomizeText({ text: input.intendedSurface, source: SEMANTIC_SOURCE.CLAIM, hasher });
  const realizedAtoms = atomizeText({ text: input.realization.text, source: SEMANTIC_SOURCE.CLAIM, hasher });
  const distance = computeSemanticRoundTripDistance(intendedAtoms, realizedAtoms);
  const semanticDelta: ConstructionCycleSemanticDelta = {
    missing: distance.missing.length,
    added: distance.added.length,
    reversed: distance.reversed.length,
    quantityMismatches: distance.quantityMismatches.length,
    timeMismatches: distance.timeMismatches.length,
    polarityMismatches: distance.polarityMismatches.length,
    modalityMismatches: distance.modalityMismatches.length,
    discourseForceMismatches: distance.discourseForceMismatches.length,
    total: 0
  };
  semanticDelta.total = Object.entries(semanticDelta)
    .filter(([key]) => key !== "total")
    .reduce((sum, [, value]) => sum + Number(value), 0);
  const denominator = Math.max(1, intendedAtoms.length + realizedAtoms.length);
  const score = clamp01(1 - semanticDelta.total / denominator);
  const languageDelta = semanticDelta.total > 0
    ? languageRoundTripDeltaFromMismatch({
      profileId: input.construction.profileKey,
      intendedText: input.intendedSurface,
      realizedText: input.realization.text,
      distance,
      constructionId: input.construction.id,
      ...(input.contextKey ? { contextKey: input.contextKey } : {}),
      evidenceIds: input.evidenceIds ?? input.realization.evidenceIds,
      ...(input.sourceTraceId ? { sourceTraceId: input.sourceTraceId } : {}),
      updatedAt: input.createdAt,
      hasher
    })
    : undefined;
  return {
    schema: CONSTRUCTION_CYCLE_CONSISTENCY_SCHEMA,
    constructionId: input.construction.id,
    planId: input.realization.planId,
    profileKey: input.construction.profileKey,
    sourceExampleIds: [...input.construction.sourceExampleIds],
    evidenceIds: [...new Set([...(input.evidenceIds ?? []), ...input.realization.evidenceIds])],
    intendedSurfaceHash: `surface.${hasher.digestHex(input.intendedSurface).slice(0, 32)}`,
    realizedSurfaceHash: `surface.${hasher.digestHex(input.realization.text).slice(0, 32)}`,
    semanticDelta,
    ...(languageDelta ? { languageDelta } : {}),
    score,
    outcome: semanticDelta.total === 0,
    ...(input.sourceTraceId ? { sourceTraceId: input.sourceTraceId } : {}),
    ...(input.sourceRecordId ? { sourceRecordId: input.sourceRecordId } : {}),
    createdAt: input.createdAt
  };
}

export function constructionCycleCalibrationObservation(
  outcome: ConstructionCycleConsistencyOutcome
): CalibrationObservationRecord {
  return calibrationObservationRecord({
    calibrationId: CONSTRUCTION_CYCLE_CALIBRATION_ID,
    subsystemId: "language.construction",
    taskClass: "construction_cycle_consistency",
    rawScore: outcome.score,
    outcome: outcome.outcome,
    selectedOutputHash: outcome.realizedSurfaceHash,
    finalOutcome: outcome.outcome ? "cycle_consistent" : "cycle_delta",
    sourceTraceId: outcome.sourceTraceId,
    sourceRecordId: outcome.sourceRecordId,
    metadata: toJsonValue({
      schema: outcome.schema,
      constructionId: outcome.constructionId,
      planId: outcome.planId,
      profileKey: outcome.profileKey,
      sourceExampleIds: outcome.sourceExampleIds,
      evidenceIds: outcome.evidenceIds,
      intendedSurfaceHash: outcome.intendedSurfaceHash,
      realizedSurfaceHash: outcome.realizedSurfaceHash,
      semanticDelta: outcome.semanticDelta
    }),
    createdAt: outcome.createdAt,
    idSeed: `${outcome.constructionId}:${outcome.planId}:${outcome.realizedSurfaceHash}:${outcome.createdAt}`
  });
}

export async function persistConstructionCycleConsistency(
  store: Pick<DialogueMemoryStore, "putCalibrationObservation">,
  outcome: ConstructionCycleConsistencyOutcome
): Promise<CalibrationObservationRecord> {
  const observation = constructionCycleCalibrationObservation(outcome);
  await store.putCalibrationObservation(observation);
  return observation;
}

/** Loads prior observed cycle outcomes into the bounded prior used by construction selection. */
export async function constructionCycleScoresFromMemory(
  store: Pick<DialogueMemoryStore, "listCalibrationObservations">,
  limit = 2_000
): Promise<ReadonlyMap<string, number>> {
  const observations = await store.listCalibrationObservations({
    calibrationId: CONSTRUCTION_CYCLE_CALIBRATION_ID,
    limit: Math.max(1, Math.min(10_000, Math.floor(limit)))
  });
  return constructionCycleScoresFromObservations(observations);
}

/** Runs learned realization with the durable cycle prior already observed for each construction. */
export async function realizeLearnedSurfaceFromMemory(input: {
  store: Pick<DialogueMemoryStore, "listCalibrationObservations">;
  plan: SurfaceMeaningPlan;
  constructions: readonly LearnedConstruction[];
  formClasses: readonly LearnedFormClass[];
  hasher: Hasher;
}): Promise<LearnedSurfaceResult> {
  const cycleConsistencyByConstructionId = await constructionCycleScoresFromMemory(input.store);
  return realizeLearnedSurface({
    plan: input.plan,
    constructions: input.constructions,
    formClasses: input.formClasses,
    hasher: input.hasher,
    cycleConsistencyByConstructionId
  });
}

export function constructionCycleScoresFromObservations(
  observations: readonly CalibrationObservationRecord[]
): ReadonlyMap<string, number> {
  const totals = new Map<string, { sum: number; count: number }>();
  for (const observation of observations) {
    if (observation.calibrationId !== CONSTRUCTION_CYCLE_CALIBRATION_ID) continue;
    const metadata = recordOf(observation.metadata);
    const constructionId = typeof metadata.constructionId === "string" ? metadata.constructionId : undefined;
    if (!constructionId) continue;
    const row = totals.get(constructionId) ?? { sum: 0, count: 0 };
    row.sum += clamp01(observation.rawScore);
    row.count += 1;
    totals.set(constructionId, row);
  }
  return new Map([...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, row]) => [id, row.sum / row.count]));
}

export function constructionCycleSelectionScore(
  scores: ReadonlyMap<string, number> | undefined,
  constructionId: string
): number {
  return scores?.has(constructionId) ? clamp01(scores.get(constructionId)!) : 0.5;
}

function recordOf(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
