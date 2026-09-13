// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher } from "./primitives.js";
import {
  assertValidRelationPotentialModel,
  scoreRelationPotential,
  type RelationPotentialExample,
  type RelationPotentialModel
} from "./relation-potential.js";
import type { CognitiveCapability, LearnedArtifactState } from "./cognitive-capability-manifest.js";
import { learnedCapabilityStatus } from "./cognitive-capability-manifest.js";

export const RELATION_POTENTIAL_VALIDATION_SCHEMA = "scce.relation_potential_validation.v1" as const;

export type RelationPotentialArtifactLifecycle = "fitted" | "validated" | "promoted" | "rejected";

/**
 * Held-out comparison against the exact thing the model replaces: the identity branch, which multiplies every
 * edge's alpha by one and therefore carries no per-edge information. The honest identity baseline is the best
 * constant predictor available to it, so the bar is the held-out base rate, not the literal 1.0 it emits.
 */
export interface RelationPotentialValidation {
  readonly schema: typeof RELATION_POTENTIAL_VALIDATION_SCHEMA;
  readonly validationId: string;
  readonly datasetIdentity: string;
  readonly holdoutCount: number;
  readonly holdoutPositiveCount: number;
  readonly fittedBrier: number;
  /** Brier of the literal 1.0 the identity branch emits. */
  readonly identityConstantOneBrier: number;
  /** Brier of the best constant an identity runtime could actually have estimated, from data the fit also saw. */
  readonly identityEstimatedPriorBrier: number;
  /** Brier of a constant set from the held-out labels themselves. An oracle: reported, never the gate. */
  readonly oracleHoldoutBaseRateBrier: number;
  /** Held-out ranking of the transition weight the field engine computes, identity's ordering and the scored one. */
  readonly identityTransitionOrderingAuroc: number;
  readonly scoredTransitionOrderingAuroc: number;
  readonly fittedAuroc: number;
  /** Identity assigns one value to every edge, so its discrimination is 0.5 by construction. Recorded, not assumed. */
  readonly identityAuroc: number;
  readonly beatsIdentity: boolean;
}

export interface RelationPotentialHoldoutRow extends RelationPotentialExample {
  /** What the field engine orders by with no model: weight * alpha, identity's own ordering. */
  readonly baseTransitionWeight: number;
}

export interface RelationPotentialArtifactRecord {
  readonly modelId: string;
  readonly model: RelationPotentialModel;
  readonly lifecycle: RelationPotentialArtifactLifecycle;
  readonly validation?: RelationPotentialValidation;
  readonly trainingWindow: Readonly<Record<string, number | string>>;
  readonly createdAt: number;
}

export interface RelationPotentialModelStore {
  /** The single promoted artifact, or undefined when none has been promoted. */
  readPromoted(): Promise<RelationPotentialArtifactRecord | undefined>;
  read(modelId: string): Promise<RelationPotentialArtifactRecord | undefined>;
  put(record: RelationPotentialArtifactRecord): Promise<void>;
  /** Refuses unless the stored record is `validated` and its validation beat identity on held-out data. */
  promote(input: { modelId: string; expectedCurrentModelId?: string }): Promise<void>;
  list(limit?: number): Promise<readonly RelationPotentialArtifactRecord[]>;
}

/**
 * Scores a held-out set the fit never saw and compares it against the identity it would replace, on both things
 * identity does: emit a constant, and leave the transition ordering at weight * alpha.
 *
 * `priorEstimate` must come from data the fit was allowed to see. A constant set from the held-out labels is an
 * oracle no deployable runtime could match; it is computed and reported, and it is not the gate.
 */
export function validateRelationPotentialAgainstIdentity(
  model: RelationPotentialModel,
  holdout: readonly RelationPotentialHoldoutRow[],
  datasetIdentity: string,
  priorEstimate: number
): RelationPotentialValidation {
  assertValidRelationPotentialModel(model);
  if (!Array.isArray(holdout) || holdout.length < 2) throw new Error("relation-potential validation requires at least two held-out examples");
  if (!Number.isFinite(priorEstimate) || priorEstimate <= 0 || priorEstimate >= 1) throw new Error("relation-potential validation requires a prior estimated from fitting data");
  const labels = holdout.map(row => row.label);
  const positives = labels.filter(label => label === 1).length;
  if (positives === 0 || positives === labels.length) throw new Error("relation-potential validation requires both label classes in the held-out set");
  const probabilities = holdout.map(row => scoreRelationPotential(model, row.features).calibrated);
  const fittedBrier = meanSquaredError(probabilities, labels);
  const identityEstimatedPriorBrier = meanSquaredError(labels.map(() => priorEstimate), labels);
  const fittedAuroc = auroc(probabilities, labels);
  const identityTransitionOrderingAuroc = auroc(holdout.map(row => row.baseTransitionWeight), labels);
  const scoredTransitionOrderingAuroc = auroc(holdout.map((row, index) => row.baseTransitionWeight * (probabilities[index] ?? 0)), labels);
  const beatsIdentity = fittedBrier < identityEstimatedPriorBrier
    && fittedAuroc > 0.5
    && scoredTransitionOrderingAuroc > identityTransitionOrderingAuroc;
  const body = {
    schema: RELATION_POTENTIAL_VALIDATION_SCHEMA,
    datasetIdentity,
    holdoutCount: labels.length,
    holdoutPositiveCount: positives,
    fittedBrier,
    identityConstantOneBrier: meanSquaredError(labels.map(() => 1), labels),
    identityEstimatedPriorBrier,
    oracleHoldoutBaseRateBrier: meanSquaredError(labels.map(() => positives / labels.length), labels),
    identityTransitionOrderingAuroc,
    scoredTransitionOrderingAuroc,
    fittedAuroc,
    identityAuroc: 0.5,
    beatsIdentity
  } as const;
  return Object.freeze({
    ...body,
    validationId: createHasher().digestHex(canonicalStringify({ modelId: model.modelId, ...body }))
  });
}

/** Mann-Whitney rank AUROC with tie correction; no sampling. */
export function auroc(scores: readonly number[], labels: readonly (0 | 1)[]): number {
  const order = scores
    .map((score, index) => ({ score, label: labels[index] ?? 0 }))
    .sort((left, right) => left.score - right.score);
  const ranks = new Array<number>(order.length).fill(0);
  for (let index = 0; index < order.length;) {
    let end = index;
    while (end + 1 < order.length && (order[end + 1]?.score ?? Number.NaN) === (order[index]?.score ?? Number.NaN)) end++;
    const shared = (index + end) / 2 + 1;
    for (let position = index; position <= end; position++) ranks[position] = shared;
    index = end + 1;
  }
  let positiveRankSum = 0;
  let positiveCount = 0;
  for (let index = 0; index < order.length; index++) {
    if (order[index]?.label === 1) { positiveRankSum += ranks[index] ?? 0; positiveCount++; }
  }
  const negativeCount = order.length - positiveCount;
  if (!positiveCount || !negativeCount) return 0.5;
  return (positiveRankSum - (positiveCount * (positiveCount + 1)) / 2) / (positiveCount * negativeCount);
}

function meanSquaredError(predictions: readonly number[], labels: readonly (0 | 1)[]): number {
  let total = 0;
  for (let index = 0; index < predictions.length; index++) total += ((predictions[index] ?? 0) - (labels[index] ?? 0)) ** 2;
  return total / predictions.length;
}

export function assertPromotableRelationPotentialArtifact(record: RelationPotentialArtifactRecord): void {
  if (record.lifecycle !== "validated") throw new Error(`relation-potential artifact ${record.modelId} is ${record.lifecycle}; only a validated artifact may be promoted`);
  if (!record.validation) throw new Error(`relation-potential artifact ${record.modelId} carries no validation record`);
  if (record.validation.schema !== RELATION_POTENTIAL_VALIDATION_SCHEMA) throw new Error("relation-potential validation schema mismatch");
  if (!record.validation.beatsIdentity) throw new Error(`relation-potential artifact ${record.modelId} did not beat identity on held-out data; promotion refused`);
}

/**
 * The manifest row. `active` is reachable only with a promoted artifact in hand, and the row carries the exact
 * model, dataset and validation identities that a trace must also show.
 */
export function describeRelationPotentialCapability(input: {
  readonly artifact: LearnedArtifactState;
  readonly record?: RelationPotentialArtifactRecord;
  readonly explicitlyDisabled?: boolean;
  readonly traced?: boolean;
  readonly note?: string;
}): CognitiveCapability {
  const status = learnedCapabilityStatus({ artifact: input.artifact, explicitlyDisabled: input.explicitlyDisabled });
  return Object.freeze({
    id: "relation-potential" as const,
    status,
    artifact: input.artifact,
    artifactId: input.record?.modelId ?? null,
    traced: input.traced ?? true,
    parameters: Object.freeze({
      modelId: input.record?.modelId ?? "none",
      datasetIdentity: input.record?.validation?.datasetIdentity ?? input.record?.model.datasetHash ?? "none",
      validationId: input.record?.validation?.validationId ?? "none"
    }),
    note: input.note ?? (status === "active"
      ? `promoted artifact ${input.record?.modelId ?? "unknown"} selected`
      : "no promoted relation-potential artifact; field engine returns identity")
  }) as CognitiveCapability;
}
