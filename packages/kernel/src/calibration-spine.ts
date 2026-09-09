// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, clamp01, createClock, featureSet, toJsonValue } from "./primitives.js";
import { buildCalibrationModel, calibratedScoreTrace, calibrateProbability, type CalibrationModel } from "./scoring/calibration.js";
import type { ScoreTrace } from "./scoring/score-trace.js";
import { TURN_REQUIREMENT_DIMENSIONS, type TurnRequirementField } from "./turn-requirements.js";
import type { Clock, JsonValue } from "./types.js";

export const CALIBRATION_IDS = {
  proofForceProved: "proof.force.proved",
  proofSupport: "proof.support",
  proofContradiction: "proof.contradiction",
  evidenceAlpha: "evidence.alpha",
  retrievalHybridRecall: "retrieval.hybrid_recall",
  candidateMass: "candidate.mass",
  creativeCandidatePreference: "candidate.creative_preference",
  creativeCandidatePreferenceModel: "candidate.creative_preference_model",
  mouthSurfaceFit: "mouth.surface_fit",
  mouthPreservation: "mouth.preservation",
  languageGenerationConfidence: "language.generation_confidence",
  dialoguePragmaticsScore: "dialogue.pragmatics_score",
  workspaceAnswerConfidence: "workspace.answer_confidence",
  codeRoleConfidence: "code.role_confidence",
  alphaVisibleBondedStructural: "alpha.visible_bonded_structural",
  alphaCacheInvalidation: "alpha.cache_invalidation",
  /** Plan item 129: translation.ts's own preservation/confidence score, calibrated against the real preservation-gate pass/fail outcome (item 125) instead of shipped as a bespoke ad hoc weighted sum. */
  translationPreservation: "translation.preservation",
  /** judge.ts's requirement-conditioned positive-quality softmax weights (its "logits"), previously a fixed 2026-07-12 hand-tuned bootstrap, now fit from real selected-candidate outcomes. */
  judgeRequirementWeights: "judge.requirement_weights"
} as const;

export type CalibrationId = typeof CALIBRATION_IDS[keyof typeof CALIBRATION_IDS];

export const CALIBRATION_SUBSYSTEM_IDS = {
  proof: "subsystem.proof",
  evidence: "subsystem.evidence",
  retrieval: "subsystem.retrieval",
  candidate: "subsystem.candidate",
  mouth: "subsystem.mouth",
  language: "subsystem.language",
  dialogue: "subsystem.dialogue",
  workspace: "subsystem.workspace",
  code: "subsystem.code",
  alpha: "subsystem.alpha",
  translation: "subsystem.translation"
} as const;

export const CALIBRATION_TASK_CLASS_IDS = {
  generalCognition: "task.general_cognition",
  reasoning: "task.reasoning",
  translation: "task.translation",
  dialogueOutcome: "task.dialogue_outcome",
  workspaceAnswer: "task.workspace_answer",
  codeAnswer: "task.code_answer",
  blindEval: "task.blind_eval",
  sourceBoundQa: "task.source_bound_qa",
  creativeGeneration: "task.creative_generation"
} as const;

export const CREATIVE_PREFERENCE_FEATURE_SCHEMA = {
  id: "scce.creative_preference.features.v1",
  featureIds: [
    "constraintCoverage",
    "graphCoherence",
    "novelty",
    "languageRealizability",
    "usefulness",
    "risk",
    "repetition",
    "unsupportedFactualAssertion"
  ]
} as const;

export type CreativePreferenceFeatureId = typeof CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds[number];

export interface CreativePreferenceFeatureVector {
  constraintCoverage: number;
  graphCoherence: number;
  novelty: number;
  languageRealizability: number;
  usefulness: number;
  risk: number;
  repetition: number;
  unsupportedFactualAssertion: number;
}

export const CREATIVE_BOOTSTRAP_COEFFICIENTS: Readonly<Record<CreativePreferenceFeatureId, number>> = {
  constraintCoverage: 0.28,
  graphCoherence: 0.22,
  novelty: 0.20,
  languageRealizability: 0.15,
  usefulness: 0.15,
  risk: -0.30,
  repetition: -0.20,
  unsupportedFactualAssertion: -0.50
};

export interface CreativePreferenceModel {
  schema: "scce.creative_preference_model.v1";
  id: string;
  taskClass: typeof CALIBRATION_TASK_CLASS_IDS.creativeGeneration;
  featureSchemaId: typeof CREATIVE_PREFERENCE_FEATURE_SCHEMA.id;
  featureIds: readonly CreativePreferenceFeatureId[];
  coefficients: Record<CreativePreferenceFeatureId, number>;
  l2: number;
  iterations: number;
  pairCount: number;
  trainingPairIds: string[];
  trainingRecordIds: string[];
  trainingLoss: number;
  modelHash: string;
  createdAt: number;
}

export interface CalibrationObservationRecord {
  schema: "scce.calibration.observation.v1";
  id: string;
  calibrationId: string;
  subsystemId: string;
  taskClass: string;
  rawScore: number;
  outcome: boolean;
  selectedOutputHash?: string;
  accepted?: boolean;
  rejected?: boolean;
  corrected?: boolean;
  unsupportedFactHit?: boolean;
  citationFailure?: boolean;
  userCorrectionDistance?: number;
  finalOutcome: string;
  sourceTraceId?: string;
  sourceRecordId?: string;
  metadata: JsonValue;
  createdAt: number;
}

export interface CalibrationModelSet {
  schema: "scce.calibration.model_set.v1";
  id: string;
  models: Record<string, CalibrationModel>;
  creativePreferenceModels?: Record<string, CreativePreferenceModel>;
  judgeRequirementModels?: Record<string, JudgeRequirementModel>;
  observationCount: number;
  createdAt: number;
}

export interface CalibratedRuntimeScore {
  raw: number;
  value: number;
  calibrated: boolean;
  calibrationId: string;
  taskClass: string;
  modelId?: string;
  scoreTrace?: ScoreTrace;
}

export interface DialogueCalibrationOutcome {
  id: string;
  responseHash: string;
  accepted?: boolean;
  rejected?: boolean;
  corrected?: boolean;
  correctionText?: string;
  failedConstraintRefs: readonly string[];
  scoreTraceRefs: readonly string[];
  createdAt: string;
}

export interface DialogueCalibrationResult {
  id: string;
  finalText: string;
  state: { turnId: string; activeTask?: string };
  policyDecision: { selectedActionIds: readonly string[] };
  selected: { candidateId: string; criticId?: string; score: number };
  criticResults: readonly PragmaticsCalibrationCritic[];
}

export interface PragmaticsCalibrationCritic {
  id: string;
  candidateId: string;
  components: {
    conversationalFit?: number;
    truthPreservation?: number;
    naturalRhythm?: number;
    clarity?: number;
    taskCompletion?: number;
  };
}

interface CalibrationObservationReader {
  listCalibrationObservations(query?: { calibrationId?: string; subsystemId?: string; taskClass?: string; sourceRecordId?: string; limit?: number }): Promise<CalibrationObservationRecord[]>;
}

export function calibrationObservationRecord(input: {
  calibrationId: string;
  subsystemId: string;
  taskClass: string;
  rawScore: number;
  outcome: boolean;
  selectedOutputHash?: string;
  accepted?: boolean;
  rejected?: boolean;
  corrected?: boolean;
  unsupportedFactHit?: boolean;
  citationFailure?: boolean;
  userCorrectionDistance?: number;
  finalOutcome?: string;
  sourceTraceId?: string;
  sourceRecordId?: string;
  metadata?: JsonValue;
  createdAt?: number;
  idSeed?: string;
  clock?: Clock;
}): CalibrationObservationRecord {
  const createdAt = resolveCreatedAt(input.createdAt, input.clock);
  const finalOutcome = input.finalOutcome ?? outcomeId({
    accepted: input.accepted,
    rejected: input.rejected,
    corrected: input.corrected,
    outcome: input.outcome
  });
  const idSeed = input.idSeed ?? canonicalStringify({
    calibrationId: input.calibrationId,
    subsystemId: input.subsystemId,
    taskClass: input.taskClass,
    rawScore: input.rawScore,
    outcome: input.outcome,
    selectedOutputHash: input.selectedOutputHash,
    sourceRecordId: input.sourceRecordId,
    createdAt
  });
  return {
    schema: "scce.calibration.observation.v1",
    id: `calibration.observation.${hashText(idSeed)}`,
    calibrationId: input.calibrationId,
    subsystemId: input.subsystemId,
    taskClass: input.taskClass,
    rawScore: clamp01(input.rawScore),
    outcome: input.outcome,
    selectedOutputHash: input.selectedOutputHash,
    accepted: input.accepted,
    rejected: input.rejected,
    corrected: input.corrected,
    unsupportedFactHit: input.unsupportedFactHit,
    citationFailure: input.citationFailure,
    userCorrectionDistance: input.userCorrectionDistance === undefined ? undefined : clamp01(input.userCorrectionDistance),
    finalOutcome,
    sourceTraceId: input.sourceTraceId,
    sourceRecordId: input.sourceRecordId,
    metadata: input.metadata ?? toJsonValue({}),
    createdAt
  };
}

export function creativePreferenceObservationPair(input: {
  pairId: string;
  preferred: { candidateId: string; features: CreativePreferenceFeatureVector; selectedOutputHash?: string };
  rejected: { candidateId: string; features: CreativePreferenceFeatureVector; selectedOutputHash?: string };
  preferenceKind?: "accepted_rejected" | "corrected_original";
  sourceTraceId?: string;
  sourceRecordId?: string;
  createdAt?: number;
  clock?: Clock;
}): [CalibrationObservationRecord, CalibrationObservationRecord] {
  const createdAt = resolveCreatedAt(input.createdAt, input.clock);
  const preferenceKind = input.preferenceKind ?? "accepted_rejected";
  const common = {
    calibrationId: CALIBRATION_IDS.creativeCandidatePreference,
    subsystemId: CALIBRATION_SUBSYSTEM_IDS.candidate,
    taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
    sourceTraceId: input.sourceTraceId,
    sourceRecordId: input.sourceRecordId,
    createdAt
  };
  const preferredFeatures = normalizeCreativeFeatures(input.preferred.features);
  const rejectedFeatures = normalizeCreativeFeatures(input.rejected.features);
  return [
    calibrationObservationRecord({
      ...common,
      rawScore: normalizeCreativeScore(creativeBootstrapScore(preferredFeatures)),
      outcome: true,
      accepted: preferenceKind === "accepted_rejected" ? true : undefined,
      corrected: preferenceKind === "corrected_original" ? true : undefined,
      selectedOutputHash: input.preferred.selectedOutputHash,
      finalOutcome: preferenceKind === "corrected_original" ? "outcome.corrected_preferred" : "outcome.accepted",
      idSeed: `${input.pairId}:preferred:${input.preferred.candidateId}`,
      metadata: creativePreferenceMetadata({
        pairId: input.pairId,
        role: "preferred",
        candidateId: input.preferred.candidateId,
        preferenceKind,
        features: preferredFeatures
      })
    }),
    calibrationObservationRecord({
      ...common,
      rawScore: normalizeCreativeScore(creativeBootstrapScore(rejectedFeatures)),
      outcome: false,
      rejected: true,
      selectedOutputHash: input.rejected.selectedOutputHash,
      finalOutcome: preferenceKind === "corrected_original" ? "outcome.corrected_original" : "outcome.rejected",
      idSeed: `${input.pairId}:rejected:${input.rejected.candidateId}`,
      metadata: creativePreferenceMetadata({
        pairId: input.pairId,
        role: "rejected",
        candidateId: input.rejected.candidateId,
        preferenceKind,
        features: rejectedFeatures
      })
    })
  ];
}

export function creativePreferenceModelSnapshotObservation(input: {
  model: CreativePreferenceModel;
  sourceTraceId?: string;
  sourceRecordId?: string;
  createdAt?: number;
}): CalibrationObservationRecord {
  const model = input.model;
  return calibrationObservationRecord({
    calibrationId: CALIBRATION_IDS.creativeCandidatePreferenceModel,
    subsystemId: CALIBRATION_SUBSYSTEM_IDS.candidate,
    taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
    rawScore: clamp01(1 / (1 + model.trainingLoss / Math.max(1, model.pairCount))),
    outcome: true,
    selectedOutputHash: model.modelHash,
    finalOutcome: "model.fitted_pairwise_preference",
    sourceTraceId: input.sourceTraceId,
    sourceRecordId: input.sourceRecordId,
    createdAt: input.createdAt ?? model.createdAt,
    idSeed: `${model.modelHash}:${input.sourceRecordId ?? "creative_preference_model"}`,
    metadata: toJsonValue({
      schema: "scce.creative_preference.model_snapshot.v1",
      modelSchema: model.schema,
      modelId: model.id,
      modelHash: model.modelHash,
      taskClass: model.taskClass,
      featureSchemaId: model.featureSchemaId,
      featureIds: model.featureIds,
      coefficients: model.coefficients,
      l2: model.l2,
      iterations: model.iterations,
      pairCount: model.pairCount,
      trainingPairIds: model.trainingPairIds,
      trainingRecordIds: model.trainingRecordIds,
      trainingLoss: model.trainingLoss
    })
  });
}

export function creativeBootstrapScore(features: CreativePreferenceFeatureVector): number {
  const normalized = normalizeCreativeFeatures(features);
  return CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds.reduce(
    (sum, featureId) => sum + CREATIVE_BOOTSTRAP_COEFFICIENTS[featureId] * normalized[featureId],
    0
  );
}

export function creativePreferenceScore(input: {
  features: CreativePreferenceFeatureVector;
  modelSet?: CalibrationModelSet;
  taskClass?: string;
}): {
  score: number;
  source: "bootstrap" | "pairwise_preference";
  modelId?: string;
  modelHash?: string;
  coefficients: Record<CreativePreferenceFeatureId, number>;
} {
  const taskClass = input.taskClass ?? CALIBRATION_TASK_CLASS_IDS.creativeGeneration;
  const model = creativePreferenceModelFor({ modelSet: input.modelSet, taskClass });
  const coefficients = model?.coefficients ?? { ...CREATIVE_BOOTSTRAP_COEFFICIENTS };
  return {
    score: creativeLinearScore(normalizeCreativeFeatures(input.features), coefficients),
    source: model ? "pairwise_preference" : "bootstrap",
    modelId: model?.id,
    modelHash: model?.modelHash,
    coefficients: { ...coefficients }
  };
}

// judge.ts's requirement-conditioned positive-quality weighting, learned from real turns instead of hand-tuned.
// Same term structure as the formulas judge.ts shipped on 2026-07-12 (one base coefficient per quality
// dimension, plus a slope coefficient per requirement feature that formula referenced) -- what's learned is
// the NUMBER on each term, not which requirement features matter to which dimension; that structure stays
// fixed so a realistic amount of live telemetry (tens to low hundreds of turns) is enough data to fit against.

export const JUDGE_REQUIREMENT_QUALITY_KEYS = [
  "truthSupport",
  "sourceFidelity",
  "requirementCoverage",
  "novelty",
  "semanticPreservation",
  "transformationQuality",
  "inferentialContinuity",
  "explanatoryPower",
  "executableCompleteness",
  "dialogueContinuity",
  "languageQuality",
  "usefulness",
  "coherence",
  "uncertaintyCalibration",
  "formatFit",
  "styleFit",
  "directness",
  "structure"
] as const;

export type JudgeRequirementQualityKey = typeof JUDGE_REQUIREMENT_QUALITY_KEYS[number];

interface JudgeRequirementTerm {
  paramId: string;
  dimension: JudgeRequirementQualityKey;
  featureId: string;
  bootstrap: number;
}

const JUDGE_REQUIREMENT_TERMS: readonly JudgeRequirementTerm[] = [
  { paramId: "truthSupport.base", dimension: "truthSupport", featureId: "base", bootstrap: 0.10 },
  { paramId: "truthSupport.externalTruthAuthority", dimension: "truthSupport", featureId: "externalTruthAuthority", bootstrap: 2.20 },
  { paramId: "sourceFidelity.base", dimension: "sourceFidelity", featureId: "base", bootstrap: 0.05 },
  { paramId: "sourceFidelity.sourceDependence", dimension: "sourceFidelity", featureId: "sourceDependence", bootstrap: 1.45 },
  { paramId: "sourceFidelity.externalTruthAuthority", dimension: "sourceFidelity", featureId: "externalTruthAuthority", bootstrap: 0.75 },
  { paramId: "requirementCoverage.base", dimension: "requirementCoverage", featureId: "base", bootstrap: 0.25 },
  { paramId: "requirementCoverage.averageRequirement", dimension: "requirementCoverage", featureId: "averageRequirement", bootstrap: 1.45 },
  { paramId: "novelty.base", dimension: "novelty", featureId: "base", bootstrap: 0.05 },
  { paramId: "novelty.noveltyDemand", dimension: "novelty", featureId: "noveltyDemand", bootstrap: 2.15 },
  { paramId: "semanticPreservation.base", dimension: "semanticPreservation", featureId: "base", bootstrap: 0.05 },
  { paramId: "semanticPreservation.semanticPreservation", dimension: "semanticPreservation", featureId: "semanticPreservation", bootstrap: 2.10 },
  { paramId: "transformationQuality.base", dimension: "transformationQuality", featureId: "base", bootstrap: 0.05 },
  { paramId: "transformationQuality.surfaceTransformation", dimension: "transformationQuality", featureId: "surfaceTransformation", bootstrap: 1.45 },
  { paramId: "transformationQuality.semanticPreservation", dimension: "transformationQuality", featureId: "semanticPreservation", bootstrap: 0.55 },
  { paramId: "inferentialContinuity.base", dimension: "inferentialContinuity", featureId: "base", bootstrap: 0.10 },
  { paramId: "inferentialContinuity.inferentialDepth", dimension: "inferentialContinuity", featureId: "inferentialDepth", bootstrap: 1.95 },
  { paramId: "explanatoryPower.base", dimension: "explanatoryPower", featureId: "base", bootstrap: 0.05 },
  { paramId: "explanatoryPower.inferentialDepth", dimension: "explanatoryPower", featureId: "inferentialDepth", bootstrap: 1.35 },
  { paramId: "explanatoryPower.causalReasoningDemand", dimension: "explanatoryPower", featureId: "causalReasoningDemand", bootstrap: 0.35 },
  { paramId: "executableCompleteness.base", dimension: "executableCompleteness", featureId: "base", bootstrap: 0.05 },
  { paramId: "executableCompleteness.executableArtifactDemand", dimension: "executableCompleteness", featureId: "executableArtifactDemand", bootstrap: 2.20 },
  { paramId: "executableCompleteness.actionCommitment", dimension: "executableCompleteness", featureId: "actionCommitment", bootstrap: 0.45 },
  { paramId: "dialogueContinuity.base", dimension: "dialogueContinuity", featureId: "base", bootstrap: 0.05 },
  { paramId: "dialogueContinuity.dialogueDependence", dimension: "dialogueContinuity", featureId: "dialogueDependence", bootstrap: 2.10 },
  { paramId: "languageQuality.base", dimension: "languageQuality", featureId: "base", bootstrap: 0.30 },
  { paramId: "languageQuality.audienceAdaptation", dimension: "languageQuality", featureId: "audienceAdaptation", bootstrap: 0.55 },
  { paramId: "usefulness.base", dimension: "usefulness", featureId: "base", bootstrap: 0.25 },
  { paramId: "usefulness.noveltyDemand", dimension: "usefulness", featureId: "noveltyDemand", bootstrap: 0.60 },
  { paramId: "usefulness.executableArtifactDemand", dimension: "usefulness", featureId: "executableArtifactDemand", bootstrap: 0.70 },
  { paramId: "coherence.base", dimension: "coherence", featureId: "base", bootstrap: 0.50 },
  { paramId: "coherence.inferentialDepth", dimension: "coherence", featureId: "inferentialDepth", bootstrap: 0.65 },
  { paramId: "uncertaintyCalibration.base", dimension: "uncertaintyCalibration", featureId: "base", bootstrap: 0.10 },
  { paramId: "uncertaintyCalibration.externalTruthAuthority", dimension: "uncertaintyCalibration", featureId: "externalTruthAuthority", bootstrap: 1.40 },
  { paramId: "uncertaintyCalibration.uncertaintyTolerance", dimension: "uncertaintyCalibration", featureId: "uncertaintyTolerance", bootstrap: 0.35 },
  { paramId: "formatFit.base", dimension: "formatFit", featureId: "base", bootstrap: 0.05 },
  { paramId: "formatFit.formatConstraintStrength", dimension: "formatFit", featureId: "formatConstraintStrength", bootstrap: 2.00 },
  { paramId: "styleFit.base", dimension: "styleFit", featureId: "base", bootstrap: 0.10 },
  { paramId: "styleFit.audienceAdaptation", dimension: "styleFit", featureId: "audienceAdaptation", bootstrap: 1.20 },
  { paramId: "directness.base", dimension: "directness", featureId: "base", bootstrap: 0.20 },
  { paramId: "directness.inverseBrevityDetailBalance", dimension: "directness", featureId: "inverseBrevityDetailBalance", bootstrap: 0.75 },
  { paramId: "structure.base", dimension: "structure", featureId: "base", bootstrap: 0.20 },
  { paramId: "structure.formatConstraintStrength", dimension: "structure", featureId: "formatConstraintStrength", bootstrap: 0.80 },
  { paramId: "structure.executableArtifactDemand", dimension: "structure", featureId: "executableArtifactDemand", bootstrap: 0.55 }
];

export function derivedJudgeRequirementFeatures(requirement: TurnRequirementField): Record<string, number> {
  const averageRequirement = mean([
    requirement.externalTruthAuthority,
    requirement.sourceDependence,
    requirement.noveltyDemand,
    requirement.inferentialDepth,
    requirement.semanticPreservation,
    requirement.executableArtifactDemand,
    requirement.dialogueDependence,
    requirement.formatConstraintStrength
  ]);
  const features: Record<string, number> = { base: 1, averageRequirement, inverseBrevityDetailBalance: 1 - clamp01(requirement.brevityDetailBalance) };
  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) features[dimension] = requirement[dimension];
  return features;
}

function judgeRequirementLogitsFromFeatures(features: Record<string, number>, coefficients: Readonly<Record<string, number>>): Record<JudgeRequirementQualityKey, number> {
  const logits: Record<string, number> = {};
  for (const key of JUDGE_REQUIREMENT_QUALITY_KEYS) logits[key] = 0;
  for (const term of JUDGE_REQUIREMENT_TERMS) {
    const coefficient = coefficients[term.paramId] ?? term.bootstrap;
    logits[term.dimension] = (logits[term.dimension] ?? 0) + coefficient * (features[term.featureId] ?? 0);
  }
  return logits as Record<JudgeRequirementQualityKey, number>;
}

function softmaxRecord<K extends string>(logits: Record<K, number>, keys: readonly K[]): Record<K, number> {
  const maxLogit = Math.max(...keys.map(key => logits[key]));
  const exponentials = keys.map(key => Math.exp(Math.max(-40, Math.min(40, logits[key] - maxLogit))));
  const total = exponentials.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(keys.map((key, index) => [key, total > 0 ? (exponentials[index] ?? 0) / total : 1 / keys.length])) as Record<K, number>;
}

export interface JudgeRequirementModel {
  schema: "scce.judge_requirement_model.v1";
  id: string;
  taskClass: string;
  coefficients: Record<string, number>;
  sampleCount: number;
  trainingLoss: number;
  modelHash: string;
  createdAt: number;
}

interface JudgeRequirementSample {
  requirementFeatures: Record<string, number>;
  qualityPositive: Record<JudgeRequirementQualityKey, number>;
  outcome: boolean;
}

function judgeRequirementSamplesFromObservations(observations: readonly CalibrationObservationRecord[]): JudgeRequirementSample[] {
  const samples: JudgeRequirementSample[] = [];
  const requirementFeatureIds = ["base", "averageRequirement", "inverseBrevityDetailBalance", ...TURN_REQUIREMENT_DIMENSIONS];
  for (const observation of observations) {
    if (observation.calibrationId !== CALIBRATION_IDS.judgeRequirementWeights) continue;
    const metadata = jsonRecord(observation.metadata);
    if (metadata.schema !== "scce.judge_requirement.observation.v1") continue;
    const requirementFeatures = numericRecordFromJson(metadata.requirementFeatures, requirementFeatureIds);
    const qualityPositive = numericRecordFromJson(metadata.qualityPositive, JUDGE_REQUIREMENT_QUALITY_KEYS);
    if (!requirementFeatures || !qualityPositive) continue;
    samples.push({ requirementFeatures, qualityPositive: qualityPositive as Record<JudgeRequirementQualityKey, number>, outcome: observation.outcome });
  }
  return samples;
}

function numericRecordFromJson(value: JsonValue | undefined, keys: readonly string[]): Record<string, number> | undefined {
  const row = jsonRecord(value);
  const entries = keys.map(key => [key, row[key]] as const);
  if (entries.some(([, item]) => typeof item !== "number" || !Number.isFinite(item))) return undefined;
  return Object.fromEntries(entries as Array<[string, number]>);
}

function judgeRequirementLoss(input: { samples: readonly JudgeRequirementSample[]; coefficients: Record<string, number>; l2: number }): number {
  if (!input.samples.length) return 0;
  const dataLoss = input.samples.reduce((sum, sample) => {
    const weights = softmaxRecord(judgeRequirementLogitsFromFeatures(sample.requirementFeatures, input.coefficients), JUDGE_REQUIREMENT_QUALITY_KEYS);
    const Q = JUDGE_REQUIREMENT_QUALITY_KEYS.reduce((total, key) => total + weights[key] * sample.qualityPositive[key], 0);
    const y = sample.outcome ? 1 : 0;
    const p = sigmoid(Q);
    const eps = 1e-6;
    return sum - (y * Math.log(Math.max(eps, p)) + (1 - y) * Math.log(Math.max(eps, 1 - p)));
  }, 0) / input.samples.length;
  const regularization = JUDGE_REQUIREMENT_TERMS.reduce((sum, term) => sum + input.l2 * (((input.coefficients[term.paramId] ?? term.bootstrap) - term.bootstrap) ** 2), 0);
  return dataLoss + regularization;
}

/**
 * Batch-fits judge.ts's requirement -> positive-quality-weight coefficients from real turns: for each turn,
 * the requirement field in force and the SELECTED candidate's quality vector, labeled by a real downstream
 * outcome (not the judge's own preference order -- that would just teach the model to imitate itself).
 * Regularized toward the 2026-07-12 bootstrap values (MAP shrinkage to a sane prior), not toward zero, since
 * zero is not a meaningful coefficient value for e.g. a quality dimension's base weight. Re-run on every
 * calibration model reload (see runtime-memory-control.ts's calibrationModelsCached), so this refits itself
 * from the live calibration_observations table on its own accord as real telemetry accumulates -- no separate
 * training job to run by hand.
 */
export function buildJudgeRequirementModels(input: {
  observations: readonly CalibrationObservationRecord[];
  minSamples?: number;
  l2?: number;
  iterations?: number;
  learningRate?: number;
  createdAt?: number;
  clock?: Clock;
}): Record<string, JudgeRequirementModel> {
  const samples = judgeRequirementSamplesFromObservations(input.observations);
  const minSamples = Math.max(1, input.minSamples ?? 24);
  if (samples.length < minSamples) return {};
  const l2 = Math.max(0, input.l2 ?? 0.01);
  const iterations = Math.max(1, Math.min(2_000, Math.floor(input.iterations ?? 320)));
  const learningRate = Math.max(1e-4, Math.min(1, input.learningRate ?? 0.15));
  const coefficients: Record<string, number> = Object.fromEntries(JUDGE_REQUIREMENT_TERMS.map(term => [term.paramId, term.bootstrap]));
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradient: Record<string, number> = Object.fromEntries(JUDGE_REQUIREMENT_TERMS.map(term => [term.paramId, 2 * l2 * ((coefficients[term.paramId] ?? term.bootstrap) - term.bootstrap)]));
    for (const sample of samples) {
      const weights = softmaxRecord(judgeRequirementLogitsFromFeatures(sample.requirementFeatures, coefficients), JUDGE_REQUIREMENT_QUALITY_KEYS);
      const Q = JUDGE_REQUIREMENT_QUALITY_KEYS.reduce((sum, key) => sum + weights[key] * sample.qualityPositive[key], 0);
      const error = sigmoid(Q) - (sample.outcome ? 1 : 0);
      for (const term of JUDGE_REQUIREMENT_TERMS) {
        const featureValue = sample.requirementFeatures[term.featureId] ?? 0;
        const dLdLogit = error * weights[term.dimension] * (sample.qualityPositive[term.dimension] - Q);
        gradient[term.paramId] = (gradient[term.paramId] ?? 0) + dLdLogit * featureValue;
      }
    }
    const decayedRate = learningRate / samples.length / Math.sqrt(1 + iteration / 40);
    for (const term of JUDGE_REQUIREMENT_TERMS) {
      coefficients[term.paramId] = finiteCoefficient((coefficients[term.paramId] ?? term.bootstrap) - decayedRate * (gradient[term.paramId] ?? 0));
    }
  }
  const trainingLoss = judgeRequirementLoss({ samples, coefficients, l2 });
  const createdAt = resolveCreatedAt(input.createdAt, input.clock, latestCreatedAt(input.observations));
  const modelBody = { taskClass: CALIBRATION_TASK_CLASS_IDS.generalCognition, coefficients, sampleCount: samples.length, trainingLoss };
  const modelHash = hashText(canonicalStringify(modelBody));
  const model: JudgeRequirementModel = {
    schema: "scce.judge_requirement_model.v1",
    id: `judge.requirement.model.${modelHash}`,
    taskClass: CALIBRATION_TASK_CLASS_IDS.generalCognition,
    coefficients,
    sampleCount: samples.length,
    trainingLoss,
    modelHash,
    createdAt
  };
  return { [CALIBRATION_TASK_CLASS_IDS.generalCognition]: model };
}

export function judgeRequirementModelFor(input: { modelSet?: CalibrationModelSet; taskClass?: string }): JudgeRequirementModel | undefined {
  if (!input.modelSet) return undefined;
  return input.modelSet.judgeRequirementModels?.[input.taskClass ?? CALIBRATION_TASK_CLASS_IDS.generalCognition];
}

/**
 * What judge.ts actually calls: bootstrap coefficients shrunk toward the learned model as real sample count
 * grows (continuous blend, no cliff at a threshold -- see blendTargetSamples), so a handful of early
 * observations nudge behavior slightly and a few hundred turns' worth converges toward the fitted model.
 * Falls back to pure bootstrap (blend 0) with no model at all, so cold-start behavior is unchanged from before
 * this existed.
 */
export function judgeRequirementWeights(input: {
  requirement: TurnRequirementField;
  modelSet?: CalibrationModelSet;
  taskClass?: string;
  blendTargetSamples?: number;
}): {
  weights: Record<JudgeRequirementQualityKey, number>;
  coefficients: Record<string, number>;
  learned: boolean;
  sampleCount: number;
  blend: number;
  modelId?: string;
} {
  const taskClass = input.taskClass ?? CALIBRATION_TASK_CLASS_IDS.generalCognition;
  const model = judgeRequirementModelFor({ modelSet: input.modelSet, taskClass });
  const sampleCount = model?.sampleCount ?? 0;
  const blendTargetSamples = Math.max(1, input.blendTargetSamples ?? 200);
  const blend = model ? clamp01(sampleCount / blendTargetSamples) : 0;
  const coefficients = Object.fromEntries(JUDGE_REQUIREMENT_TERMS.map(term => {
    const learnedValue = model?.coefficients[term.paramId];
    const value = typeof learnedValue === "number" && Number.isFinite(learnedValue)
      ? term.bootstrap + blend * (learnedValue - term.bootstrap)
      : term.bootstrap;
    return [term.paramId, value];
  }));
  const features = derivedJudgeRequirementFeatures(input.requirement);
  const weights = softmaxRecord(judgeRequirementLogitsFromFeatures(features, coefficients), JUDGE_REQUIREMENT_QUALITY_KEYS);
  return { weights, coefficients, learned: blend > 0, sampleCount, blend, modelId: model?.id };
}

export function judgeRequirementObservation(input: {
  requirement: TurnRequirementField;
  qualityPositive: Record<JudgeRequirementQualityKey, number>;
  outcome: boolean;
  sourceTraceId?: string;
  sourceRecordId?: string;
  createdAt?: number;
  clock?: Clock;
}): CalibrationObservationRecord {
  const requirementFeatures = derivedJudgeRequirementFeatures(input.requirement);
  return calibrationObservationRecord({
    calibrationId: CALIBRATION_IDS.judgeRequirementWeights,
    subsystemId: CALIBRATION_SUBSYSTEM_IDS.candidate,
    taskClass: CALIBRATION_TASK_CLASS_IDS.generalCognition,
    rawScore: mean(JUDGE_REQUIREMENT_QUALITY_KEYS.map(key => input.qualityPositive[key])),
    outcome: input.outcome,
    finalOutcome: input.outcome ? "outcome.positive" : "outcome.negative",
    sourceTraceId: input.sourceTraceId,
    sourceRecordId: input.sourceRecordId,
    createdAt: input.createdAt,
    clock: input.clock,
    metadata: toJsonValue({
      schema: "scce.judge_requirement.observation.v1",
      requirementFeatures,
      qualityPositive: input.qualityPositive
    })
  });
}

export function calibrationObservationsFromDialogueOutcome(input: {
  result: DialogueCalibrationResult;
  outcome: DialogueCalibrationOutcome;
  taskClass?: string;
  createdAt?: number;
  clock?: Clock;
}): CalibrationObservationRecord[] {
  const critic = selectedCritic(input.result);
  const outcome = outcomeBoolean(input.outcome);
  const finalOutcome = outcomeId(input.outcome);
  const unsupportedFactHit = hasRef(input.outcome.failedConstraintRefs, ["unsupported", "boundary", "truth"]);
  const citationFailure = hasRef(input.outcome.failedConstraintRefs, ["citation", "source", "evidence"]);
  const userCorrectionDistance = input.outcome.correctionText
    ? surfaceDistance(input.result.finalText, input.outcome.correctionText)
    : undefined;
  const createdAt = input.createdAt ?? Date.parse(input.outcome.createdAt);
  const at = Number.isFinite(createdAt) ? createdAt : resolveCreatedAt(undefined, input.clock);
  const common = {
    taskClass: input.taskClass ?? taskClassFromDialogue(input.result),
    outcome,
    selectedOutputHash: input.outcome.responseHash,
    accepted: input.outcome.accepted,
    rejected: input.outcome.rejected,
    corrected: input.outcome.corrected,
    unsupportedFactHit,
    citationFailure,
    userCorrectionDistance,
    finalOutcome,
    sourceTraceId: input.result.id,
    sourceRecordId: input.outcome.id,
    createdAt: at,
    metadata: toJsonValue({
      resultId: input.result.id,
      turnId: input.result.state.turnId,
      selectedActionIds: input.result.policyDecision.selectedActionIds,
      selectedCandidateId: input.result.selected.candidateId,
      selectedCriticId: input.result.selected.criticId,
      failedConstraintRefs: input.outcome.failedConstraintRefs,
      scoreTraceRefs: input.outcome.scoreTraceRefs
    })
  };
  const observations = [
    calibrationObservationRecord({
      ...common,
      calibrationId: CALIBRATION_IDS.dialoguePragmaticsScore,
      subsystemId: CALIBRATION_SUBSYSTEM_IDS.dialogue,
      rawScore: input.result.selected.score,
      idSeed: `${input.outcome.id}:dialogue:${input.result.selected.score}`
    }),
    calibrationObservationRecord({
      ...common,
      calibrationId: CALIBRATION_IDS.mouthSurfaceFit,
      subsystemId: CALIBRATION_SUBSYSTEM_IDS.mouth,
      rawScore: critic?.components.conversationalFit ?? input.result.selected.score,
      idSeed: `${input.outcome.id}:mouth.fit:${critic?.id ?? "none"}`
    }),
    calibrationObservationRecord({
      ...common,
      calibrationId: CALIBRATION_IDS.mouthPreservation,
      subsystemId: CALIBRATION_SUBSYSTEM_IDS.mouth,
      rawScore: critic?.components.truthPreservation ?? input.result.selected.score,
      idSeed: `${input.outcome.id}:mouth.preservation:${critic?.id ?? "none"}`
    }),
    calibrationObservationRecord({
      ...common,
      calibrationId: CALIBRATION_IDS.languageGenerationConfidence,
      subsystemId: CALIBRATION_SUBSYSTEM_IDS.language,
      rawScore: mean([
        critic?.components.naturalRhythm ?? input.result.selected.score,
        critic?.components.clarity ?? input.result.selected.score
      ]),
      idSeed: `${input.outcome.id}:language.generation:${critic?.id ?? "none"}`
    })
  ];
  if (common.taskClass === CALIBRATION_TASK_CLASS_IDS.workspaceAnswer) {
    observations.push(calibrationObservationRecord({
      ...common,
      calibrationId: CALIBRATION_IDS.workspaceAnswerConfidence,
      subsystemId: CALIBRATION_SUBSYSTEM_IDS.workspace,
      rawScore: mean([
        critic?.components.taskCompletion ?? input.result.selected.score,
        critic?.components.truthPreservation ?? input.result.selected.score
      ]),
      idSeed: `${input.outcome.id}:workspace.answer:${critic?.id ?? "none"}`
    }));
  }
  if (common.taskClass === CALIBRATION_TASK_CLASS_IDS.codeAnswer) {
    observations.push(calibrationObservationRecord({
      ...common,
      calibrationId: CALIBRATION_IDS.codeRoleConfidence,
      subsystemId: CALIBRATION_SUBSYSTEM_IDS.code,
      rawScore: critic?.components.taskCompletion ?? input.result.selected.score,
      idSeed: `${input.outcome.id}:code.role:${critic?.id ?? "none"}`
    }));
  }
  return observations;
}

export function buildCalibrationModelsById(input: {
  observations: readonly CalibrationObservationRecord[];
  minPoints?: number;
  binCount?: number;
  createdAt?: number;
  clock?: Clock;
}): Record<string, CalibrationModel> {
  const minPoints = input.minPoints ?? 2;
  const createdAt = resolveCreatedAt(
    input.createdAt,
    input.clock,
    latestCreatedAt(input.observations)
  );
  const groups = new Map<string, CalibrationObservationRecord[]>();
  for (const observation of input.observations) {
    const key = `${observation.calibrationId}|${observation.taskClass}`;
    groups.set(key, [...(groups.get(key) ?? []), observation]);
  }
  const models: Record<string, CalibrationModel> = {};
  for (const [key, observations] of groups) {
    if (observations.length < minPoints) continue;
    const [calibrationId, taskClass] = key.split("|");
    if (!calibrationId || !taskClass) continue;
    models[key] = buildCalibrationModel({
      id: `calibration.model.${hashText(key)}`,
      taskClass,
      points: observations.map(observation => ({ raw: observation.rawScore, outcome: observation.outcome })),
      binCount: input.binCount,
      createdAt
    });
  }
  return models;
}

export function buildCreativePreferenceModels(input: {
  observations: readonly CalibrationObservationRecord[];
  minPairs?: number;
  l2?: number;
  iterations?: number;
  learningRate?: number;
  createdAt?: number;
  clock?: Clock;
}): Record<string, CreativePreferenceModel> {
  const pairs = creativePreferencePairs(input.observations);
  if (pairs.length < Math.max(1, input.minPairs ?? 2)) return {};
  const l2 = Math.max(0, input.l2 ?? 0.015);
  const iterations = Math.max(1, Math.min(2_000, Math.floor(input.iterations ?? 320)));
  const learningRate = Math.max(1e-4, Math.min(1, input.learningRate ?? 0.18));
  const theta = CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds.map(featureId => CREATIVE_BOOTSTRAP_COEFFICIENTS[featureId]);
  const deltas = pairs.map(pair => CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds.map(
    featureId => pair.preferred.features[featureId] - pair.rejected.features[featureId]
  ));
  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradient = theta.map((coefficient, index) => 2 * l2 * coefficient);
    for (const delta of deltas) {
      const margin = dot(theta, delta);
      const error = sigmoid(margin) - 1;
      for (let index = 0; index < gradient.length; index++) {
        gradient[index] = (gradient[index] ?? 0) + error * (delta[index] ?? 0);
      }
    }
    const decayedRate = learningRate / deltas.length / Math.sqrt(1 + iteration / 40);
    for (let index = 0; index < theta.length; index++) {
      theta[index] = finiteCoefficient((theta[index] ?? 0) - decayedRate * (gradient[index] ?? 0));
    }
  }
  const coefficients = Object.fromEntries(CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds.map(
    (featureId, index) => [featureId, theta[index] ?? 0]
  )) as Record<CreativePreferenceFeatureId, number>;
  const trainingPairIds = pairs.map(pair => pair.pairId).sort();
  const trainingRecordIds = [...new Set(pairs.flatMap(pair => pair.recordIds))].sort();
  const trainingLoss = pairwisePreferenceLoss({ deltas, theta, l2 });
  const createdAt = resolveCreatedAt(
    input.createdAt,
    input.clock,
    latestCreatedAt(input.observations)
  );
  const modelBody = {
    taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
    featureSchemaId: CREATIVE_PREFERENCE_FEATURE_SCHEMA.id,
    coefficients,
    l2,
    iterations,
    trainingPairIds,
    trainingRecordIds,
    trainingLoss
  };
  const modelHash = hashText(canonicalStringify(modelBody));
  const model: CreativePreferenceModel = {
    schema: "scce.creative_preference_model.v1",
    id: `creative.preference.model.${modelHash}`,
    taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
    featureSchemaId: CREATIVE_PREFERENCE_FEATURE_SCHEMA.id,
    featureIds: [...CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds],
    coefficients,
    l2,
    iterations,
    pairCount: pairs.length,
    trainingPairIds,
    trainingRecordIds,
    trainingLoss,
    modelHash,
    createdAt
  };
  return { [CALIBRATION_TASK_CLASS_IDS.creativeGeneration]: model };
}

export function buildCalibrationModelSet(input: {
  observations: readonly CalibrationObservationRecord[];
  minPoints?: number;
  binCount?: number;
  createdAt?: number;
  clock?: Clock;
}): CalibrationModelSet {
  const createdAt = resolveCreatedAt(
    input.createdAt,
    input.clock,
    latestCreatedAt(input.observations)
  );
  const models = buildCalibrationModelsById({
    observations: input.observations,
    minPoints: input.minPoints,
    binCount: input.binCount,
    createdAt
  });
  const creativePreferenceModels = buildCreativePreferenceModels({
    observations: input.observations,
    minPairs: input.minPoints,
    createdAt
  });
  const judgeRequirementModels = buildJudgeRequirementModels({
    observations: input.observations,
    createdAt
  });
  return {
    schema: "scce.calibration.model_set.v1",
    id: `calibration.model_set.${hashText(canonicalStringify({
      models: Object.keys(models).sort(),
      creativePreferenceModels: Object.values(creativePreferenceModels).map(model => model.modelHash).sort(),
      judgeRequirementModels: Object.values(judgeRequirementModels).map(model => model.modelHash).sort(),
      createdAt
    }))}`,
    models,
    creativePreferenceModels,
    judgeRequirementModels,
    observationCount: input.observations.length,
    createdAt
  };
}

export async function loadCalibrationModelSet(input: {
  store: CalibrationObservationReader;
  limit?: number;
  minPoints?: number;
  binCount?: number;
  createdAt?: number;
  clock?: Clock;
}): Promise<CalibrationModelSet> {
  const observations = await input.store.listCalibrationObservations({ limit: input.limit ?? 5000 });
  return buildCalibrationModelSet({
    observations,
    minPoints: input.minPoints,
    binCount: input.binCount,
    createdAt: input.createdAt,
    clock: input.clock
  });
}

export function calibrationModelFor(input: {
  modelSet?: CalibrationModelSet;
  calibrationId: string;
  taskClass?: string;
}): CalibrationModel | undefined {
  if (!input.modelSet) return undefined;
  const exactKey = input.taskClass ? `${input.calibrationId}|${input.taskClass}` : undefined;
  if (exactKey && input.modelSet.models[exactKey]) return input.modelSet.models[exactKey];
  if (input.taskClass === CALIBRATION_TASK_CLASS_IDS.creativeGeneration) return undefined;
  return Object.entries(input.modelSet.models)
    .filter(([key]) => key.startsWith(`${input.calibrationId}|`))
    .sort((left, right) => right[1].createdAt - left[1].createdAt || left[0].localeCompare(right[0]))[0]?.[1];
}

export function creativePreferenceModelFor(input: {
  modelSet?: CalibrationModelSet;
  taskClass?: string;
}): CreativePreferenceModel | undefined {
  if (!input.modelSet || input.taskClass !== CALIBRATION_TASK_CLASS_IDS.creativeGeneration) return undefined;
  return input.modelSet.creativePreferenceModels?.[CALIBRATION_TASK_CLASS_IDS.creativeGeneration];
}

export function calibrateRuntimeScore(input: {
  raw: number;
  calibrationId: string;
  taskClass: string;
  modelSet?: CalibrationModelSet;
  fallbackModel?: CalibrationModel;
  meaning?: string;
  provenance?: string[];
  inputs?: string[];
}): CalibratedRuntimeScore {
  const raw = clamp01(input.raw);
  const model = input.fallbackModel ?? calibrationModelFor({ modelSet: input.modelSet, calibrationId: input.calibrationId, taskClass: input.taskClass });
  if (!model) {
    return {
      raw,
      value: raw,
      calibrated: false,
      calibrationId: input.calibrationId,
      taskClass: input.taskClass
    };
  }
  const value = calibrateProbability(raw, model);
  const scoreTrace = input.meaning ? calibratedScoreTrace({
    raw,
    model,
    meaning: input.meaning,
    provenance: input.provenance ?? ["calibration-spine.calibrateRuntimeScore"],
    inputs: [...(input.inputs ?? []), `calibrationId:${input.calibrationId}`]
  }) : undefined;
  return {
    raw,
    value,
    calibrated: true,
    calibrationId: input.calibrationId,
    taskClass: input.taskClass,
    modelId: model.id,
    scoreTrace
  };
}

function selectedCritic(result: DialogueCalibrationResult): PragmaticsCalibrationCritic | undefined {
  return result.criticResults.find(critic => critic.id === result.selected.criticId)
    ?? result.criticResults.find(critic => critic.candidateId === result.selected.candidateId);
}

function taskClassFromDialogue(result: DialogueCalibrationResult): string {
  const activeTask = `${result.state.activeTask ?? ""} ${result.policyDecision.selectedActionIds.join(" ")}`.toLocaleLowerCase();
  if (/code|src\/|patch|file|symbol/u.test(activeTask)) return CALIBRATION_TASK_CLASS_IDS.codeAnswer;
  if (/workspace|repo|project/u.test(activeTask)) return CALIBRATION_TASK_CLASS_IDS.workspaceAnswer;
  if (/creative|invent/u.test(activeTask)) return CALIBRATION_TASK_CLASS_IDS.creativeGeneration;
  return CALIBRATION_TASK_CLASS_IDS.dialogueOutcome;
}

function outcomeBoolean(outcome: DialogueCalibrationOutcome): boolean {
  if (outcome.accepted === true) return true;
  if (outcome.rejected === true || outcome.corrected === true) return false;
  return outcome.failedConstraintRefs.length === 0;
}

function outcomeId(input: { accepted?: boolean; rejected?: boolean; corrected?: boolean; outcome?: boolean }): string {
  if (input.accepted === true) return "outcome.accepted";
  if (input.corrected === true) return "outcome.corrected";
  if (input.rejected === true) return "outcome.rejected";
  return input.outcome ? "outcome.positive" : "outcome.unknown";
}

function hasRef(refs: readonly string[], needles: readonly string[]): boolean {
  const lower = refs.join("\n").toLocaleLowerCase();
  return needles.some(needle => lower.includes(needle));
}

function surfaceDistance(left: string, right: string): number {
  const a = new Set(featureSet(left, 200));
  const b = new Set(featureSet(right, 200));
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const value of a) if (b.has(value)) intersection++;
  const union = a.size + b.size - intersection;
  return union > 0 ? clamp01(1 - intersection / union) : 0;
}

function mean(values: readonly number[]): number {
  return values.length ? clamp01(values.reduce((sum, value) => sum + clamp01(value), 0) / values.length) : 0;
}

interface CreativePreferencePair {
  pairId: string;
  preferred: { features: CreativePreferenceFeatureVector };
  rejected: { features: CreativePreferenceFeatureVector };
  recordIds: string[];
}

function creativePreferencePairs(observations: readonly CalibrationObservationRecord[]): CreativePreferencePair[] {
  const grouped = new Map<string, Array<{
    observation: CalibrationObservationRecord;
    role: "preferred" | "rejected";
    features: CreativePreferenceFeatureVector;
  }>>();
  for (const observation of observations) {
    if (observation.calibrationId !== CALIBRATION_IDS.creativeCandidatePreference || observation.taskClass !== CALIBRATION_TASK_CLASS_IDS.creativeGeneration) continue;
    const metadata = jsonRecord(observation.metadata);
    if (metadata.schema !== "scce.creative_preference.observation.v1" || metadata.featureSchemaId !== CREATIVE_PREFERENCE_FEATURE_SCHEMA.id) continue;
    const pairId = typeof metadata.pairId === "string" ? metadata.pairId : "";
    const role = metadata.role === "preferred" || metadata.role === "rejected" ? metadata.role : undefined;
    const features = creativeFeaturesFromJson(metadata.features);
    if (!pairId || !role || !features) continue;
    if (role === "preferred" && !(observation.outcome || observation.accepted || observation.corrected)) continue;
    if (role === "rejected" && observation.outcome && observation.rejected !== true) continue;
    grouped.set(pairId, [...(grouped.get(pairId) ?? []), { observation, role, features }]);
  }
  const pairs: CreativePreferencePair[] = [];
  for (const [pairId, rows] of grouped) {
    const preferred = rows.filter(row => row.role === "preferred").sort(newestObservation)[0];
    const rejected = rows.filter(row => row.role === "rejected").sort(newestObservation)[0];
    if (!preferred || !rejected) continue;
    pairs.push({
      pairId,
      preferred: { features: preferred.features },
      rejected: { features: rejected.features },
      recordIds: [preferred.observation.id, rejected.observation.id]
    });
  }
  return pairs.sort((left, right) => left.pairId.localeCompare(right.pairId));
}

function creativePreferenceMetadata(input: {
  pairId: string;
  role: "preferred" | "rejected";
  candidateId: string;
  preferenceKind: "accepted_rejected" | "corrected_original";
  features: CreativePreferenceFeatureVector;
}): JsonValue {
  return toJsonValue({
    schema: "scce.creative_preference.observation.v1",
    featureSchemaId: CREATIVE_PREFERENCE_FEATURE_SCHEMA.id,
    pairId: input.pairId,
    role: input.role,
    candidateId: input.candidateId,
    preferenceKind: input.preferenceKind,
    features: input.features
  });
}

function normalizeCreativeFeatures(features: CreativePreferenceFeatureVector): CreativePreferenceFeatureVector {
  return {
    constraintCoverage: clamp01(features.constraintCoverage),
    graphCoherence: clamp01(features.graphCoherence),
    novelty: clamp01(features.novelty),
    languageRealizability: clamp01(features.languageRealizability),
    usefulness: clamp01(features.usefulness),
    risk: clamp01(features.risk),
    repetition: clamp01(features.repetition),
    unsupportedFactualAssertion: clamp01(features.unsupportedFactualAssertion)
  };
}

function creativeFeaturesFromJson(value: JsonValue | undefined): CreativePreferenceFeatureVector | undefined {
  const row = jsonRecord(value);
  const values = CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds.map(featureId => row[featureId]);
  if (values.some(item => typeof item !== "number" || !Number.isFinite(item))) return undefined;
  return normalizeCreativeFeatures(Object.fromEntries(CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds.map(
    (featureId, index) => [featureId, values[index] as number]
  )) as unknown as CreativePreferenceFeatureVector);
}

function creativeLinearScore(features: CreativePreferenceFeatureVector, coefficients: Readonly<Record<CreativePreferenceFeatureId, number>>): number {
  return CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds.reduce(
    (sum, featureId) => sum + finiteCoefficient(coefficients[featureId]) * features[featureId],
    0
  );
}

function normalizeCreativeScore(score: number): number {
  return clamp01((score + 1) / 2);
}

function pairwisePreferenceLoss(input: { deltas: readonly (readonly number[])[]; theta: readonly number[]; l2: number }): number {
  if (!input.deltas.length) return 0;
  const dataLoss = input.deltas.reduce((sum, delta) => sum + softplus(-dot(input.theta, delta)), 0);
  const regularization = input.l2 * input.theta.reduce((sum, coefficient) => sum + coefficient * coefficient, 0);
  return dataLoss + regularization;
}

function dot(left: readonly number[], right: readonly number[]): number {
  return left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
}

function sigmoid(value: number): number {
  if (value >= 0) {
    const exp = Math.exp(-value);
    return 1 / (1 + exp);
  }
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function softplus(value: number): number {
  if (value > 30) return value;
  if (value < -30) return Math.exp(value);
  return Math.log1p(Math.exp(value));
}

function finiteCoefficient(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-8, Math.min(8, value));
}

function resolveCreatedAt(createdAt: number | undefined, clock?: Clock, fallback?: number): number {
  if (typeof createdAt === "number" && Number.isFinite(createdAt)) return createdAt;
  if (typeof fallback === "number" && Number.isFinite(fallback)) return fallback;
  return (clock ?? createClock()).now();
}

function latestCreatedAt(observations: readonly CalibrationObservationRecord[]): number | undefined {
  const times = observations.map(observation => observation.createdAt).filter(Number.isFinite);
  return times.length ? Math.max(...times) : undefined;
}

function newestObservation(
  left: { observation: CalibrationObservationRecord },
  right: { observation: CalibrationObservationRecord }
): number {
  return right.observation.createdAt - left.observation.createdAt || left.observation.id.localeCompare(right.observation.id);
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue | undefined> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue | undefined> : {};
}

function hashText(text: string): string {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
