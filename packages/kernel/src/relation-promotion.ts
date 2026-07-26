import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import type { StructuredSemanticCandidate } from "./structured-semantic-candidate.js";
import type { Hasher, JsonValue } from "./types.js";

export const RELATION_PROMOTION_MODEL_SCHEMA = "scce.relation_promotion_model.v1" as const;

export type RelationPromotionControlKind = "shuffled_relations" | "duplicate_only" | "random_repetition";

export interface RelationPromotionControlResult {
  kind: RelationPromotionControlKind;
  gainNats: number;
  recoveryGain: number;
  independentSourceCount: number;
  promoted: boolean;
}

export interface RelationPromotionDecision {
  relationSeedId: string;
  promoted: boolean;
  candidateCount: number;
  independentSourceCount: number;
  fitSourceIds: string[];
  holdoutSourceIds: string[];
  descriptionLength: {
    baselineHeldoutNats: number;
    relationHeldoutNats: number;
    relationModelNats: number;
    promotedDescriptionNats: number;
    gainNats: number;
  };
  recovery: {
    baselineProbability: number;
    relationProbability: number;
    gain: number;
  };
  controls: RelationPromotionControlResult[];
  reasons: string[];
}

export interface RelationPromotionModel {
  schema: typeof RELATION_PROMOTION_MODEL_SCHEMA;
  id: string;
  candidateIds: string[];
  fitSourceIds: string[];
  holdoutSourceIds: string[];
  decisions: RelationPromotionDecision[];
  audit: JsonValue;
}

interface RelationObservation {
  candidateId: string;
  relationSeedId: string;
  sourceId: string;
  signature: string;
}

interface Evaluation {
  gainNats: number;
  baselineHeldoutNats: number;
  relationHeldoutNats: number;
  relationModelNats: number;
  baselineRecoveryProbability: number;
  relationRecoveryProbability: number;
  recoveryGain: number;
  independentSourceCount: number;
}

const DIRICHLET_ALPHA = 0.5;
const MIN_INDEPENDENT_SOURCES = 4;
const MIN_FIT_SOURCES = 2;

/**
 * Compiles reusable relation identities from source-structured candidates.
 *
 * The data code is a Dirichlet-smoothed categorical code over canonical
 * participant/qualifier signatures. The null model uses the corpus-wide
 * signature distribution; M ⊕ r uses the relation-conditioned distribution.
 * The relation code is an explicit BIC-style two-part model code. Candidate
 * frequency within one source is collapsed before fitting, so duplication
 * cannot create independent evidence.
 */
export function compileRelationPromotionModel(input: {
  candidates: readonly StructuredSemanticCandidate[];
  hasher?: Hasher;
}): RelationPromotionModel {
  const hasher = input.hasher ?? createHasher();
  const observations = relationObservations(input.candidates);
  const relationSeedIds = [...new Set(observations.map(row => row.relationSeedId))].sort();
  const sourceIds = [...new Set(observations.map(row => row.sourceId))].sort();
  const split = sourceDisjointSplit(sourceIds, hasher);
  const fit = observations.filter(row => split.fit.has(row.sourceId));
  const holdout = observations.filter(row => split.holdout.has(row.sourceId));
  const signatureAlphabet = [...new Set(observations.map(row => row.signature))].sort();
  const decisions = relationSeedIds.map(relationSeedId => {
    const actual = evaluateRelation({
      relationSeedId,
      fit,
      holdout,
      relationSeedIds,
      signatureAlphabet
    });
    const sourceCount = new Set(observations
      .filter(row => row.relationSeedId === relationSeedId)
      .map(row => row.sourceId)).size;
    const fitSourceIds = uniqueSources(fit, relationSeedId);
    const holdoutSourceIds = uniqueSources(holdout, relationSeedId);
    const controls = controlResults({
      relationSeedId,
      observations,
      fit,
      holdout,
      relationSeedIds,
      signatureAlphabet,
      hasher
    });
    const reasons: string[] = [];
    if (sourceCount < MIN_INDEPENDENT_SOURCES) reasons.push("insufficient_independent_sources");
    if (fitSourceIds.length < MIN_FIT_SOURCES) reasons.push("insufficient_fit_sources");
    if (!holdoutSourceIds.length) reasons.push("missing_source_disjoint_holdout");
    if (!(actual.gainNats > 0)) reasons.push("nonpositive_heldout_description_length_gain");
    if (!(actual.recoveryGain > 0)) reasons.push("no_heldout_recovery_improvement");
    if (controls.some(control => control.promoted)) reasons.push("negative_control_induced_relation");
    const promoted = reasons.length === 0;
    return {
      relationSeedId,
      promoted,
      candidateCount: observations.filter(row => row.relationSeedId === relationSeedId).length,
      independentSourceCount: sourceCount,
      fitSourceIds,
      holdoutSourceIds,
      descriptionLength: {
        baselineHeldoutNats: actual.baselineHeldoutNats,
        relationHeldoutNats: actual.relationHeldoutNats,
        relationModelNats: actual.relationModelNats,
        promotedDescriptionNats: quantize(actual.relationHeldoutNats + actual.relationModelNats),
        gainNats: actual.gainNats
      },
      recovery: {
        baselineProbability: actual.baselineRecoveryProbability,
        relationProbability: actual.relationRecoveryProbability,
        gain: actual.recoveryGain
      },
      controls,
      reasons
    };
  });
  const canonical = {
    schema: RELATION_PROMOTION_MODEL_SCHEMA,
    candidateIds: [...new Set(input.candidates.map(candidate => candidate.id))].sort(),
    fitSourceIds: [...split.fit].sort(),
    holdoutSourceIds: [...split.holdout].sort(),
    decisions
  };
  return {
    ...canonical,
    id: `relation_promotion.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      compiler: "kernel.relation_promotion.heldout_description_length.v1",
      code: {
        null: "dirichlet_smoothed_corpus_signature_code",
        promoted: "dirichlet_smoothed_relation_signature_code",
        model: "bic_two_part_relation_code",
        dirichletAlpha: DIRICHLET_ALPHA
      },
      sourceDisjoint: true,
      occurrenceCollapsedWithinSource: true,
      minimumIndependentSources: MIN_INDEPENDENT_SOURCES,
      minimumFitSources: MIN_FIT_SOURCES,
      candidateCount: input.candidates.length,
      independentObservationCount: observations.length,
      promotedRelationCount: decisions.filter(decision => decision.promoted).length,
      rejectedRelationCount: decisions.filter(decision => !decision.promoted).length
    })
  };
}

export function relationPromotionDecision(
  model: RelationPromotionModel | undefined,
  relationSeedId: string
): RelationPromotionDecision | undefined {
  return model?.decisions.find(decision => decision.relationSeedId === relationSeedId);
}

function relationObservations(candidates: readonly StructuredSemanticCandidate[]): RelationObservation[] {
  const unique = new Map<string, RelationObservation>();
  for (const candidate of candidates) {
    if (!candidate.id || !candidate.relationSeedId || !candidate.sourceId) continue;
    const signature = candidateSignature(candidate);
    const key = canonicalStringify({
      relationSeedId: candidate.relationSeedId,
      sourceId: String(candidate.sourceId),
      signature
    });
    unique.set(key, {
      candidateId: candidate.id,
      relationSeedId: candidate.relationSeedId,
      sourceId: String(candidate.sourceId),
      signature
    });
  }
  return [...unique.values()].sort((left, right) =>
    left.sourceId.localeCompare(right.sourceId)
    || left.relationSeedId.localeCompare(right.relationSeedId)
    || left.signature.localeCompare(right.signature)
    || left.candidateId.localeCompare(right.candidateId));
}

function candidateSignature(candidate: StructuredSemanticCandidate): string {
  return canonicalStringify({
    arity: candidate.participants.length,
    ports: candidate.participants.map(participant => ({
      portId: participant.portId,
      valueKind: participant.valueKind
    })),
    qualifierShape: jsonShape(candidate.qualifiers)
  });
}

function jsonShape(value: JsonValue): JsonValue {
  if (value === null) return "null";
  if (Array.isArray(value)) return value.map(jsonShape);
  if (typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, jsonShape(value[key]!)]));
  }
  return typeof value;
}

function sourceDisjointSplit(sourceIds: readonly string[], hasher: Hasher): {
  fit: Set<string>;
  holdout: Set<string>;
} {
  if (sourceIds.length < MIN_INDEPENDENT_SOURCES) {
    return { fit: new Set(sourceIds), holdout: new Set() };
  }
  const ranked = sourceIds.map(sourceId => ({
    sourceId,
    rank: hasher.digestHex(`relation-promotion-holdout\u001f${sourceId}`)
  })).sort((left, right) => left.rank.localeCompare(right.rank) || left.sourceId.localeCompare(right.sourceId));
  const holdoutCount = Math.max(1, Math.floor(sourceIds.length / 4));
  const holdout = new Set(ranked.slice(0, holdoutCount).map(row => row.sourceId));
  return {
    fit: new Set(sourceIds.filter(sourceId => !holdout.has(sourceId))),
    holdout
  };
}

function evaluateRelation(input: {
  relationSeedId: string;
  fit: readonly RelationObservation[];
  holdout: readonly RelationObservation[];
  relationSeedIds: readonly string[];
  signatureAlphabet: readonly string[];
}): Evaluation {
  const targetFit = input.fit.filter(row => row.relationSeedId === input.relationSeedId);
  const targetHoldout = input.holdout.filter(row => row.relationSeedId === input.relationSeedId);
  const backgroundCounts = countsBySignature(input.fit);
  const relationCounts = countsBySignature(targetFit);
  const baselineHeldoutNats = negativeLogLikelihood(targetHoldout, backgroundCounts, input.signatureAlphabet.length);
  const relationHeldoutNats = negativeLogLikelihood(targetHoldout, relationCounts, input.signatureAlphabet.length);
  const relationModelNats = modelCodeNats(relationCounts, targetFit.length, input.signatureAlphabet.length);
  const recovery = recoveryProbabilities({
    targetRelationSeedId: input.relationSeedId,
    fit: input.fit,
    holdout: targetHoldout,
    relationSeedIds: input.relationSeedIds,
    signatureAlphabetSize: input.signatureAlphabet.length
  });
  return {
    gainNats: quantize(baselineHeldoutNats - relationHeldoutNats - relationModelNats),
    baselineHeldoutNats,
    relationHeldoutNats,
    relationModelNats,
    baselineRecoveryProbability: recovery.baseline,
    relationRecoveryProbability: recovery.relation,
    recoveryGain: quantize(recovery.relation - recovery.baseline),
    independentSourceCount: new Set(targetFit.map(row => row.sourceId)).size
  };
}

function controlResults(input: {
  relationSeedId: string;
  observations: readonly RelationObservation[];
  fit: readonly RelationObservation[];
  holdout: readonly RelationObservation[];
  relationSeedIds: readonly string[];
  signatureAlphabet: readonly string[];
  hasher: Hasher;
}): RelationPromotionControlResult[] {
  const shuffled = relabel(input.fit, input.relationSeedIds, row => {
    const current = input.relationSeedIds.indexOf(row.relationSeedId);
    return input.relationSeedIds[(current + 1) % Math.max(1, input.relationSeedIds.length)]!;
  });
  const randomRepetition = input.fit.map(row => ({
    ...row,
    signature: randomRepetitionSignature(row.sourceId, input.hasher)
  }));
  const randomRepetitionHoldout = input.holdout.map(row => ({
    ...row,
    signature: randomRepetitionSignature(row.sourceId, input.hasher)
  }));
  const randomRepetitionAlphabet = [...new Set([
    ...randomRepetition,
    ...randomRepetitionHoldout
  ].map(row => row.signature))].sort();
  const first = input.observations.find(row => row.relationSeedId === input.relationSeedId);
  const duplicate = first
    ? Array.from({ length: Math.max(MIN_INDEPENDENT_SOURCES, input.fit.length) }, (_, index) => ({
      ...first,
      candidateId: `${first.candidateId}.duplicate.${index}`
    }))
    : [];
  return [
    control("shuffled_relations", evaluateRelation({
      relationSeedId: input.relationSeedId,
      fit: shuffled,
      holdout: input.holdout,
      relationSeedIds: input.relationSeedIds,
      signatureAlphabet: input.signatureAlphabet
    })),
    control("duplicate_only", evaluateRelation({
      relationSeedId: input.relationSeedId,
      fit: duplicate,
      holdout: input.holdout,
      relationSeedIds: input.relationSeedIds,
      signatureAlphabet: input.signatureAlphabet
    })),
    control("random_repetition", evaluateRelation({
      relationSeedId: input.relationSeedId,
      fit: randomRepetition,
      holdout: randomRepetitionHoldout,
      relationSeedIds: input.relationSeedIds,
      signatureAlphabet: randomRepetitionAlphabet
    }))
  ];
}

function randomRepetitionSignature(sourceId: string, hasher: Hasher): string {
  const digest = hasher.digestHex(`relation-promotion-random-repetition\u001f${sourceId}`);
  return `random_control_signature.${Number.parseInt(digest.slice(0, 8), 16) % 3}`;
}

function relabel(
  observations: readonly RelationObservation[],
  relationSeedIds: readonly string[],
  select: (row: RelationObservation) => string
): RelationObservation[] {
  if (relationSeedIds.length < 2) return [];
  return observations.map(row => ({ ...row, relationSeedId: select(row) }));
}

function control(kind: RelationPromotionControlKind, evaluation: Evaluation): RelationPromotionControlResult {
  const promoted = evaluation.independentSourceCount >= MIN_INDEPENDENT_SOURCES
    && evaluation.gainNats > 0
    && evaluation.recoveryGain > 0;
  return {
    kind,
    gainNats: evaluation.gainNats,
    recoveryGain: evaluation.recoveryGain,
    independentSourceCount: evaluation.independentSourceCount,
    promoted
  };
}

function recoveryProbabilities(input: {
  targetRelationSeedId: string;
  fit: readonly RelationObservation[];
  holdout: readonly RelationObservation[];
  relationSeedIds: readonly string[];
  signatureAlphabetSize: number;
}): { baseline: number; relation: number } {
  if (!input.holdout.length || !input.fit.length || !input.relationSeedIds.length) {
    return { baseline: 0, relation: 0 };
  }
  const fitCounts = new Map(input.relationSeedIds.map(relationSeedId => [
    relationSeedId,
    input.fit.filter(row => row.relationSeedId === relationSeedId)
  ]));
  const priorDenominator = input.fit.length + DIRICHLET_ALPHA * input.relationSeedIds.length;
  let baseline = 0;
  let relation = 0;
  for (const row of input.holdout) {
    const weights = input.relationSeedIds.map(relationSeedId => {
      const examples = fitCounts.get(relationSeedId) ?? [];
      const prior = (examples.length + DIRICHLET_ALPHA) / priorDenominator;
      return {
        relationSeedId,
        prior,
        joint: prior * probability(
          row.signature,
          countsBySignature(examples),
          input.signatureAlphabetSize
        )
      };
    });
    const correct = weights.find(weight => weight.relationSeedId === input.targetRelationSeedId);
    const denominator = weights.reduce((sum, weight) => sum + weight.joint, 0);
    baseline += correct?.prior ?? 0;
    relation += denominator > 0 ? (correct?.joint ?? 0) / denominator : 0;
  }
  return {
    baseline: quantize(baseline / input.holdout.length),
    relation: quantize(relation / input.holdout.length)
  };
}

function countsBySignature(observations: readonly RelationObservation[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of observations) counts.set(row.signature, (counts.get(row.signature) ?? 0) + 1);
  return counts;
}

function negativeLogLikelihood(
  observations: readonly RelationObservation[],
  counts: ReadonlyMap<string, number>,
  alphabetSize: number
): number {
  return quantize(observations.reduce((sum, row) =>
    sum - Math.log(probability(row.signature, counts, alphabetSize)), 0));
}

function probability(signature: string, counts: ReadonlyMap<string, number>, alphabetSize: number): number {
  const total = [...counts.values()].reduce((sum, count) => sum + count, 0);
  const width = Math.max(1, alphabetSize);
  return ((counts.get(signature) ?? 0) + DIRICHLET_ALPHA)
    / (total + DIRICHLET_ALPHA * width);
}

function modelCodeNats(counts: ReadonlyMap<string, number>, sampleCount: number, alphabetSize: number): number {
  if (sampleCount <= 0) return 0;
  void counts;
  const categoricalDegreesOfFreedom = Math.max(0, alphabetSize - 1);
  const identityCode = Math.log1p(Math.max(1, alphabetSize));
  const parameterCode = 0.5 * categoricalDegreesOfFreedom * Math.log(Math.max(2, sampleCount));
  return quantize(identityCode + parameterCode);
}

function uniqueSources(observations: readonly RelationObservation[], relationSeedId: string): string[] {
  return [...new Set(observations
    .filter(row => row.relationSeedId === relationSeedId)
    .map(row => row.sourceId))].sort();
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
