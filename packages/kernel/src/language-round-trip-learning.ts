// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { computeSemanticRoundTripDistance, type SemanticRoundTripDistance } from "./semantic-round-trip.js";
import type { LanguageStructuralDelta } from "./language-state-delta.js";
import type { LanguageMemoryStore, LanguagePatternRecord } from "./storage.js";
import { canonicalStringify, clamp01, createHasher, toJsonValue } from "./primitives.js";
import type { EvidenceId, Hasher } from "./types.js";
import { atomizeText } from "./semantic-proof-system.js";
import { SEMANTIC_SOURCE } from "./semantic-codes.js";

export const LANGUAGE_ROUND_TRIP_DELTA_SCHEMA = "scce.language_round_trip_delta.v1" as const;

/** Opaque IDs for the dimensions measured by semantic-round-trip.ts. */
export const LANGUAGE_ROUND_TRIP_DIMENSION_IDS = {
  missing: "scce.round_trip.dimension.001",
  added: "scce.round_trip.dimension.002",
  reversed: "scce.round_trip.dimension.003",
  quantity: "scce.round_trip.dimension.004",
  temporal: "scce.round_trip.dimension.005",
  polarity: "scce.round_trip.dimension.006",
  modality: "scce.round_trip.dimension.007",
  discourseForce: "scce.round_trip.dimension.008"
} as const;

export type LanguageRoundTripDimensionId = typeof LANGUAGE_ROUND_TRIP_DIMENSION_IDS[keyof typeof LANGUAGE_ROUND_TRIP_DIMENSION_IDS];

export interface LanguageRoundTripDelta {
  schema: typeof LANGUAGE_ROUND_TRIP_DELTA_SCHEMA;
  pattern: LanguagePatternRecord;
  structuralDelta: LanguageStructuralDelta;
  mismatchDimensions: LanguageRoundTripDimensionId[];
  distance: SemanticRoundTripDistance;
  sourceTraceId?: string;
}

export interface LanguageRoundTripDeltaInput {
  profileId: string;
  intendedText: string;
  realizedText: string;
  distance?: SemanticRoundTripDistance;
  constructionId?: string;
  /** Optional typed context below the construction/profile identity. */
  contextKey?: string;
  evidenceIds?: readonly string[];
  sourceTraceId?: string;
  updatedAt: number;
  hasher?: Hasher;
}

/**
 * Turns an observed semantic cycle mismatch into a durable, source-derived
 * structural transition. The correction direction is realized -> intended:
 * the realized surface is the observed bad route and the intended surface is
 * the measured target a later selector should prefer.
 */
export function languageRoundTripDeltaFromMismatch(input: LanguageRoundTripDeltaInput): LanguageRoundTripDelta | undefined {
  const intendedText = input.intendedText.trim();
  const realizedText = input.realizedText.trim();
  if (!input.profileId.trim() || !intendedText || !realizedText) return undefined;
  const hasher = input.hasher ?? createHasher();
  const evidenceIds = [...new Set(input.evidenceIds ?? [])].slice(0, 128) as EvidenceId[];
  const sourceTraceId = input.sourceTraceId?.trim();
  // A cycle observed only in an unbound local string has no authority to
  // teach the shared language memory. Require durable evidence or a real
  // cycle trace before emitting a pattern.
  if (!evidenceIds.length && !sourceTraceId) return undefined;
  const distance = input.distance ?? computeSemanticRoundTripDistance(
    atomizeText({ text: intendedText, source: SEMANTIC_SOURCE.CLAIM, hasher }),
    atomizeText({ text: realizedText, source: SEMANTIC_SOURCE.CLAIM, hasher })
  );
  const mismatchDimensions = mismatchDimensionIds(distance);
  if (!mismatchDimensions.length) return undefined;
  const mismatchCount = mismatchDimensions.length;
  const denominator = Math.max(1, distance.matched.length + distance.missing.length + distance.added.length);
  const support = clamp01(0.5 + 0.5 * mismatchCount / denominator);
  const constructionId = input.constructionId?.trim();
  const contextKey = input.contextKey?.trim();
  // A round-trip sentence pair is a construction observation. Without the
  // typed construction identity it cannot be generalized safely: persisting
  // it as an unscoped surface delta would let one memorized sentence alter
  // unrelated realizations after restart.
  if (!constructionId) return undefined;
  const patternId = `pattern.round_trip.${hasher.digestHex(canonicalStringify({
    profileId: input.profileId,
    constructionId: constructionId ?? null,
    contextKey: contextKey ?? null,
    intendedText,
    realizedText,
    mismatchDimensions
  })).slice(0, 32)}`;
  const structuralDelta: LanguageStructuralDelta = {
    id: `${patternId}:structural-delta`,
    patternId,
    profileId: input.profileId,
    kind: "construction",
    surface: { from: realizedText, to: intendedText },
    grammatical: constructionId ? { ruleId: constructionId } : {},
    ...(contextKey ? { contextKey } : {}),
    semantic: {
      fromRoleId: "scce.round_trip.state.realized",
      toRoleId: "scce.round_trip.state.intended"
    },
    support,
    evidenceIds
  };
  const pattern: LanguagePatternRecord = {
    id: patternId,
    profileId: input.profileId,
    patternKind: "syntax",
    support,
    entropy: clamp01(1 - support),
    patternJson: toJsonValue({
      schema: LANGUAGE_ROUND_TRIP_DELTA_SCHEMA,
      constructionId: constructionId ?? null,
      contextKey: contextKey ?? null,
      sourceTraceId: sourceTraceId ?? null,
      evidenceIds,
      mismatchDimensions,
      semanticDelta: semanticDeltaCounts(distance),
      structuralDelta
    }),
    evidenceIds: structuralDelta.evidenceIds,
    updatedAt: input.updatedAt
  };
  return {
    schema: LANGUAGE_ROUND_TRIP_DELTA_SCHEMA,
    pattern,
    structuralDelta,
    mismatchDimensions,
    distance,
    ...(sourceTraceId ? { sourceTraceId } : {})
  };
}

/** Persist through the existing language-memory primitive so a cold hydration sees the delta. */
export async function persistLanguageRoundTripDelta(
  store: Pick<LanguageMemoryStore, "putLanguagePattern">,
  input: LanguageRoundTripDeltaInput | { delta: LanguageRoundTripDelta }
): Promise<LanguageRoundTripDelta | undefined> {
  const delta = "delta" in input
    ? input.delta
    : languageRoundTripDeltaFromMismatch(input);
  if (!delta) return undefined;
  await store.putLanguagePattern(delta.pattern);
  return delta;
}

function mismatchDimensionIds(distance: SemanticRoundTripDistance): LanguageRoundTripDimensionId[] {
  const dimensions: LanguageRoundTripDimensionId[] = [];
  if (distance.missing.length) dimensions.push(LANGUAGE_ROUND_TRIP_DIMENSION_IDS.missing);
  if (distance.added.length) dimensions.push(LANGUAGE_ROUND_TRIP_DIMENSION_IDS.added);
  if (distance.reversed.length) dimensions.push(LANGUAGE_ROUND_TRIP_DIMENSION_IDS.reversed);
  if (distance.quantityMismatches.length) dimensions.push(LANGUAGE_ROUND_TRIP_DIMENSION_IDS.quantity);
  if (distance.timeMismatches.length) dimensions.push(LANGUAGE_ROUND_TRIP_DIMENSION_IDS.temporal);
  if (distance.polarityMismatches.length) dimensions.push(LANGUAGE_ROUND_TRIP_DIMENSION_IDS.polarity);
  if (distance.modalityMismatches.length) dimensions.push(LANGUAGE_ROUND_TRIP_DIMENSION_IDS.modality);
  if (distance.discourseForceMismatches.length) dimensions.push(LANGUAGE_ROUND_TRIP_DIMENSION_IDS.discourseForce);
  return dimensions;
}

function semanticDeltaCounts(distance: SemanticRoundTripDistance): Record<string, number> {
  return {
    missing: distance.missing.length,
    added: distance.added.length,
    reversed: distance.reversed.length,
    quantity: distance.quantityMismatches.length,
    temporal: distance.timeMismatches.length,
    polarity: distance.polarityMismatches.length,
    modality: distance.modalityMismatches.length,
    discourseForce: distance.discourseForceMismatches.length
  };
}
