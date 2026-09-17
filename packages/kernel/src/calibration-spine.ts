// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, clamp01, createClock, featureSet, toJsonValue } from "./primitives.js";
import { buildCalibrationModel, calibratedScoreTrace, calibrateProbability, calibrationBinFor, type CalibrationModel, type CalibrationPoint } from "./scoring/calibration.js";
import type { ScoreTrace } from "./scoring/score-trace.js";
import {
  COGNITIVE_OPERATOR_IDS,
  DEFAULT_COGNITIVE_OPERATOR_MODEL,
  TURN_REQUIREMENT_DIMENSIONS,
  type CognitiveOperatorActivationModel,
  type CognitiveOperatorId,
  type TurnRequirementField
} from "./turn-requirements.js";
import { otsuThreshold } from "./language-identity.js";
import type { CalibrationMeasurementState, Clock, JsonValue } from "./types.js";

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
  operatorOutcome: "operator.outcome",
  alphaVisibleBondedStructural: "alpha.visible_bonded_structural",
  alphaCacheInvalidation: "alpha.cache_invalidation",
  /** Plan item 129: translation.ts's own preservation/confidence score, calibrated against the real preservation-gate pass/fail outcome (item 125) instead of shipped as a bespoke ad hoc weighted sum. */
  translationPreservation: "translation.preservation",
  /** judge.ts's requirement-conditioned positive-quality softmax weights (its "logits"), previously a fixed 2026-07-12 hand-tuned bootstrap, now fit from real selected-candidate outcomes. */
  judgeRequirementWeights: "judge.requirement_weights",
  /** Stages of the two credit chains that had no declared id at all, so their deciding quantity was unobservable. */
  requirementFieldInference: "requirement.field_inference",
  requirementActivationSupport: "requirement.activation_support",
  proposalSelection: "proposal.selection",
  relationComposition: "relation.composition",
  answerFactBinding: "answer.fact_binding",
  /** The whole-turn credit record itself, carrying both chains. */
  turnCognitiveCredit: "turn.cognitive_credit"
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
  operator: "subsystem.operator",
  alpha: "subsystem.alpha",
  translation: "subsystem.translation",
  requirement: "subsystem.requirement",
  planner: "subsystem.planner",
  relation: "subsystem.relation",
  answer: "subsystem.answer",
  turn: "subsystem.turn"
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
  operatorRoutingModels?: Record<string, OperatorRoutingModel>;
  observationCount: number;
  createdAt: number;
}

export interface CalibratedRuntimeScore {
  raw: number;
  value: number;
  calibrated: boolean;
  measurement: CalibrationMeasurementState;
  calibrationId: string;
  taskClass: string;
  modelId?: string;
  /** A model that exists but did not measure this request; kept as provenance, never applied as a value. */
  unappliedModelId?: string;
  /** Training rows behind the applied bin, or behind the bin that was found and refused. */
  sampleCount?: number;
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
  state: { turnId: string; activeTask?: string; taskClassId?: string };
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

export interface OperatorRoutingModel {
  schema: "scce.operator_routing_model.v1";
  id: string;
  taskClass: string;
  intercepts: Record<string, number>;
  requirementWeights: Record<string, Record<string, number>>;
  activationThreshold: number;
  sampleCount: number;
  positiveCount: number;
  trainingLoss: number;
  modelHash: string;
  createdAt: number;
}

interface OperatorRoutingSample {
  requirement: Record<string, number>;
  activeOperatorIds: ReadonlySet<string>;
  outcome: boolean;
}

/**
 * Splits credit episodes into outcome classes on the reward distribution itself. The writer records a measured
 * reward per turn and no class, because one turn has no population; the boundary is Otsu's on the population a
 * reader holds, never a declared cut. Undefined when the rewards carry no two-class structure at all.
 */
export function creditRewardClasses(rewards: ReadonlyMap<string, number>): { threshold: number; positive: ReadonlySet<string> } | undefined {
  const values = [...rewards.values()];
  const threshold = otsuThreshold(values);
  if (threshold === undefined) return undefined;
  const positive = new Set([...rewards].filter(([, reward]) => reward >= threshold).map(([episodeId]) => episodeId));
  if (!positive.size || positive.size === rewards.size) return undefined;
  return { threshold, positive };
}

/**
 * Joins the two credit-ledger stage rows a turn already writes, on the episode id they share: the requirement
 * stage carries the inferred requirement field, the operator stage carries which operators actually ran, and
 * both carry the turn's measured reward. A grader's supervised label wins over the reward split where one exists.
 */
function operatorRoutingSamplesFromObservations(observations: readonly CalibrationObservationRecord[]): OperatorRoutingSample[] {
  const requirementByEpisode = new Map<string, Record<string, number>>();
  const operatorsByEpisode = new Map<string, { ids: Set<string>; outcome: boolean }>();
  const rewardByEpisode = new Map<string, number>();
  const supervisedByEpisode = new Map<string, boolean>();
  for (const observation of observations) {
    const metadata = jsonRecord(observation.metadata);
    if (metadata.schema !== "scce.cognitive_credit.stage_observation.v1") continue;
    const episodeId = typeof metadata.episodeId === "string" ? metadata.episodeId : "";
    if (!episodeId || metadata.reached !== true) continue;
    if (observation.calibrationId === CALIBRATION_IDS.requirementFieldInference) {
      const quantities = jsonRecord(metadata.decidingQuantities);
      const row: Record<string, number> = {};
      for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
        const value = quantities[dimension];
        if (typeof value === "number" && Number.isFinite(value)) row[dimension] = clamp01(value);
      }
      if (Object.keys(row).length === TURN_REQUIREMENT_DIMENSIONS.length) requirementByEpisode.set(episodeId, row);
      continue;
    }
    if (typeof metadata.reward === "number" && Number.isFinite(metadata.reward)) rewardByEpisode.set(episodeId, clamp01(metadata.reward));
    if (metadata.supervised === true) supervisedByEpisode.set(episodeId, observation.outcome);
    if (observation.calibrationId === CALIBRATION_IDS.operatorOutcome) {
      const ids = Array.isArray(metadata.ids) ? metadata.ids.filter((value): value is string => typeof value === "string") : [];
      operatorsByEpisode.set(episodeId, { ids: new Set(ids), outcome: observation.outcome });
    }
  }
  const classes = creditRewardClasses(rewardByEpisode);
  const samples: OperatorRoutingSample[] = [];
  for (const [episodeId, operators] of operatorsByEpisode) {
    const requirement = requirementByEpisode.get(episodeId);
    if (!requirement) continue;
    const supervised = supervisedByEpisode.get(episodeId);
    const outcome = supervised ?? (classes ? classes.positive.has(episodeId) : operators.outcome);
    samples.push({ requirement, activeOperatorIds: operators.ids, outcome });
  }
  return samples.sort((left, right) => Number(left.outcome) - Number(right.outcome));
}

function operatorRoutingLogit(input: {
  operatorId: string;
  requirement: Record<string, number>;
  intercepts: Record<string, number>;
  requirementWeights: Record<string, Record<string, number>>;
}): number {
  const weights = input.requirementWeights[input.operatorId] ?? {};
  let logit = input.intercepts[input.operatorId] ?? 0;
  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) logit += (weights[dimension] ?? 0) * (input.requirement[dimension] ?? 0);
  return finiteCoefficient(logit);
}

/**
 * The reward-labeled target, which is what keeps this a policy fit rather than the model imitating itself:
 * a turn that worked teaches "run what you ran", a turn that did not teaches the opposite. With a constant
 * label the two collapse, which is exactly why the class guard below refuses to produce a model.
 */
const operatorRoutingTarget = (wasActive: boolean, outcome: boolean): number => (wasActive === outcome ? 1 : 0);

/**
 * Fits the operator routing policy the directive names: every operator intercept -1.35 and every requirement
 * weight in DEFAULT_COGNITIVE_OPERATOR_MODEL was a bootstrap no caller could replace, so a human-written
 * executive function decided which cognitive operators ran on every turn for the life of the system.
 *
 * Regularized toward the bootstrap rather than toward zero, as buildJudgeRequirementModels is: zero is not a
 * meaningful intercept for an operator that should be off by default. Re-run on every calibration model
 * reload, so it refits itself from live calibration_observations on the existing 120s cache cycle with no
 * training job to run by hand and no database work on the response path.
 *
 * Returns no model, leaving the bootstrap in force as the cold-start prior, unless the episodes carry BOTH
 * outcome classes and at least one sample per free parameter. Neither is a tuned threshold: a logistic fit on
 * a constant label is not a fit, and fewer samples than parameters is not identifiable. Measured 2026-09-16,
 * every credit row in this instance is outcome=false, so this correctly declines to produce a model today.
 */
export function buildOperatorRoutingModels(input: {
  observations: readonly CalibrationObservationRecord[];
  l2?: number;
  iterations?: number;
  learningRate?: number;
  createdAt?: number;
  clock?: Clock;
}): Record<string, OperatorRoutingModel> {
  const samples = operatorRoutingSamplesFromObservations(input.observations);
  const operatorIds = Object.values(COGNITIVE_OPERATOR_IDS) as string[];
  const freeParameters = 1 + TURN_REQUIREMENT_DIMENSIONS.length;
  const positiveCount = samples.filter(sample => sample.outcome).length;
  if (samples.length < freeParameters) return {};
  if (positiveCount === 0 || positiveCount === samples.length) return {};
  const l2 = Math.max(0, input.l2 ?? 0.01);
  const iterations = Math.max(1, Math.min(2_000, Math.floor(input.iterations ?? 320)));
  const learningRate = Math.max(1e-4, Math.min(1, input.learningRate ?? 0.15));
  const bootstrapIntercepts: Record<string, number> = {};
  const bootstrapWeights: Record<string, Record<string, number>> = {};
  for (const operatorId of operatorIds) {
    bootstrapIntercepts[operatorId] = DEFAULT_COGNITIVE_OPERATOR_MODEL.intercepts[operatorId as CognitiveOperatorId] ?? 0;
    const shipped = DEFAULT_COGNITIVE_OPERATOR_MODEL.requirementWeights[operatorId as CognitiveOperatorId] ?? {};
    bootstrapWeights[operatorId] = Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS.map(dimension => [dimension, shipped[dimension] ?? 0]));
  }
  // Flat arrays, not records, through the descent: the record form allocated per operator per iteration and
  // cost 1667ms against the judge refit's 16ms on the same 5000-row window, which a cold turn would have paid.
  const operatorCount = operatorIds.length;
  const dimensionCount = TURN_REQUIREMENT_DIMENSIONS.length;
  const priorIntercept = Float64Array.from(operatorIds.map(operatorId => bootstrapIntercepts[operatorId] ?? 0));
  const priorWeight = new Float64Array(operatorCount * dimensionCount);
  const features = new Float64Array(samples.length * dimensionCount);
  const targets = new Float64Array(samples.length * operatorCount);
  for (let o = 0; o < operatorCount; o++) {
    for (let d = 0; d < dimensionCount; d++) priorWeight[o * dimensionCount + d] = bootstrapWeights[operatorIds[o]!]?.[TURN_REQUIREMENT_DIMENSIONS[d]!] ?? 0;
  }
  for (let s = 0; s < samples.length; s++) {
    const sample = samples[s]!;
    for (let d = 0; d < dimensionCount; d++) features[s * dimensionCount + d] = sample.requirement[TURN_REQUIREMENT_DIMENSIONS[d]!] ?? 0;
    for (let o = 0; o < operatorCount; o++) targets[s * operatorCount + o] = operatorRoutingTarget(sample.activeOperatorIds.has(operatorIds[o]!), sample.outcome);
  }
  const intercept = Float64Array.from(priorIntercept);
  const weight = Float64Array.from(priorWeight);
  const interceptGradient = new Float64Array(operatorCount);
  const weightGradient = new Float64Array(operatorCount * dimensionCount);
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let o = 0; o < operatorCount; o++) {
      interceptGradient[o] = 2 * l2 * (intercept[o]! - priorIntercept[o]!);
      for (let d = 0; d < dimensionCount; d++) {
        const index = o * dimensionCount + d;
        weightGradient[index] = 2 * l2 * (weight[index]! - priorWeight[index]!);
      }
    }
    for (let s = 0; s < samples.length; s++) {
      const featureBase = s * dimensionCount;
      for (let o = 0; o < operatorCount; o++) {
        const weightBase = o * dimensionCount;
        let logit = intercept[o]!;
        for (let d = 0; d < dimensionCount; d++) logit += weight[weightBase + d]! * features[featureBase + d]!;
        const error = sigmoid(logit) - targets[s * operatorCount + o]!;
        interceptGradient[o] = interceptGradient[o]! + error;
        for (let d = 0; d < dimensionCount; d++) weightGradient[weightBase + d] = weightGradient[weightBase + d]! + error * features[featureBase + d]!;
      }
    }
    const decayedRate = learningRate / samples.length / Math.sqrt(1 + iteration / 40);
    for (let o = 0; o < operatorCount; o++) {
      intercept[o] = finiteCoefficient(intercept[o]! - decayedRate * interceptGradient[o]!);
      for (let d = 0; d < dimensionCount; d++) {
        const index = o * dimensionCount + d;
        weight[index] = finiteCoefficient(weight[index]! - decayedRate * weightGradient[index]!);
      }
    }
  }
  const intercepts: Record<string, number> = {};
  const requirementWeights: Record<string, Record<string, number>> = {};
  for (let o = 0; o < operatorCount; o++) {
    intercepts[operatorIds[o]!] = intercept[o]!;
    requirementWeights[operatorIds[o]!] = Object.fromEntries(
      TURN_REQUIREMENT_DIMENSIONS.map((dimension, d) => [dimension, weight[o * dimensionCount + d]!])
    );
  }
  let trainingLoss = 0;
  const fittedActivations: number[] = [];
  for (const sample of samples) {
    for (const operatorId of operatorIds) {
      const p = sigmoid(operatorRoutingLogit({ operatorId, requirement: sample.requirement, intercepts, requirementWeights }));
      fittedActivations.push(p);
      const y = operatorRoutingTarget(sample.activeOperatorIds.has(operatorId), sample.outcome);
      trainingLoss -= y * Math.log(Math.max(1e-6, p)) + (1 - y) * Math.log(Math.max(1e-6, 1 - p));
    }
  }
  trainingLoss /= Math.max(1, samples.length * operatorIds.length);
  // The cut between "this operator runs" and "it does not" is where the fitted activations actually separate.
  const split = otsuThreshold(fittedActivations);
  const activationThreshold = typeof split === "number" && Number.isFinite(split)
    ? clamp01(split)
    : DEFAULT_COGNITIVE_OPERATOR_MODEL.activationThreshold;
  const createdAt = resolveCreatedAt(input.createdAt, input.clock, latestCreatedAt(input.observations));
  const modelBody = { taskClass: CALIBRATION_TASK_CLASS_IDS.generalCognition, intercepts, requirementWeights, activationThreshold, sampleCount: samples.length, trainingLoss };
  const modelHash = hashText(canonicalStringify(toJsonValue(modelBody as unknown as JsonValue)));
  const model: OperatorRoutingModel = {
    schema: "scce.operator_routing_model.v1",
    id: `operator.routing.model.${modelHash}`,
    taskClass: CALIBRATION_TASK_CLASS_IDS.generalCognition,
    intercepts,
    requirementWeights,
    activationThreshold,
    sampleCount: samples.length,
    positiveCount,
    trainingLoss,
    modelHash,
    createdAt
  };
  return { [CALIBRATION_TASK_CLASS_IDS.generalCognition]: model };
}

export function operatorRoutingModelFor(input: { modelSet?: CalibrationModelSet; taskClass?: string }): OperatorRoutingModel | undefined {
  if (!input.modelSet) return undefined;
  return input.modelSet.operatorRoutingModels?.[input.taskClass ?? CALIBRATION_TASK_CLASS_IDS.generalCognition];
}

/**
 * What the turn runtime passes to activateCognitiveOperators: the shipped bootstrap shrunk toward the fitted
 * policy as real episodes accumulate, with no cliff at a threshold. With no model at all this returns
 * DEFAULT_COGNITIVE_OPERATOR_MODEL unchanged, including its `uncalibrated_bootstrap` reliability, so nothing
 * reports itself calibrated on the strength of a fit that does not exist.
 */
export function operatorRoutingActivationModel(input: {
  modelSet?: CalibrationModelSet;
  taskClass?: string;
  blendTargetSamples?: number;
}): CognitiveOperatorActivationModel {
  const model = operatorRoutingModelFor({ modelSet: input.modelSet, taskClass: input.taskClass });
  if (!model) return DEFAULT_COGNITIVE_OPERATOR_MODEL;
  const blend = clamp01(model.sampleCount / Math.max(1, input.blendTargetSamples ?? 200));
  if (blend <= 0) return DEFAULT_COGNITIVE_OPERATOR_MODEL;
  const operatorIds = Object.values(COGNITIVE_OPERATOR_IDS) as CognitiveOperatorId[];
  const toward = (bootstrap: number, learned: number | undefined): number =>
    (typeof learned === "number" && Number.isFinite(learned) ? bootstrap + blend * (learned - bootstrap) : bootstrap);
  const intercepts = Object.fromEntries(operatorIds.map(operatorId => [
    operatorId,
    toward(DEFAULT_COGNITIVE_OPERATOR_MODEL.intercepts[operatorId] ?? 0, model.intercepts[operatorId])
  ])) as Record<CognitiveOperatorId, number>;
  const requirementWeights = Object.fromEntries(operatorIds.map(operatorId => {
    const shipped = DEFAULT_COGNITIVE_OPERATOR_MODEL.requirementWeights[operatorId] ?? {};
    const learned = model.requirementWeights[operatorId] ?? {};
    return [operatorId, Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS
      .map(dimension => [dimension, toward(shipped[dimension] ?? 0, learned[dimension])] as const)
      .filter(([, value]) => value !== 0))];
  })) as Record<CognitiveOperatorId, Partial<Record<typeof TURN_REQUIREMENT_DIMENSIONS[number], number>>>;
  return {
    schema: "scce.cognitive_operator.activation.v1",
    id: model.id,
    version: DEFAULT_COGNITIVE_OPERATOR_MODEL.version + 1,
    reliability: "calibrated",
    intercepts,
    requirementWeights,
    activationThreshold: clamp01(toward(DEFAULT_COGNITIVE_OPERATOR_MODEL.activationThreshold, model.activationThreshold))
  };
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

/**
 * A credit-ledger row, from either the whole-turn record or a stage row. Membership is decided by the schema,
 * never by whether a reward is present: 598 of the 1079 live credit rows predate the reward and carry only the
 * old constant-false boolean, so reading absence of a reward as "not a credit row" would keep exactly the rows
 * this resolution exists to exclude.
 */
function creditRowEpisode(observation: CalibrationObservationRecord): { episodeId: string; supervised: boolean } | undefined {
  const metadata = jsonRecord(observation.metadata);
  const stage = metadata.schema === "scce.cognitive_credit.stage_observation.v1";
  const turn = metadata.schema === "scce.cognitive_credit.record.v1";
  if (!stage && !turn) return undefined;
  const episodeId = typeof metadata.episodeId === "string" ? metadata.episodeId : "";
  if (!episodeId) return undefined;
  return { episodeId, supervised: (turn ? jsonRecord(metadata.outcome) : metadata).supervised === true };
}

/**
 * The outcome class a row belongs to for a per-quantity calibration, or `undefined` when nothing has measured
 * one. Two separate reasons a credit row has none, both measured on the live table:
 *
 * A runtime credit row's boolean is `label === positive` and `runtimeOutcome` only ever issues
 * `outcome.unknown`, so taking it as a negative reports an unlabelled turn as a measured failure: two turns
 * whose measured reward was 0.82 built twelve models and made every credit-observed id read a calibrated zero.
 *
 * Its reward is not the fix either, and this is law 3. A turn's reward is a property of the turn; whether
 * `proof.support` is well calibrated is a property of that support figure. All 83 live `proof.support` rows
 * are credit rows, so its only available label is the turn's reward, and splitting those rewards puts 17 rows
 * of raw support 0 in a bin with empirical 0.71 -- "zero proof support predicts a good turn" is true of this
 * instance and is not a calibration of proof support. The turn-level reward belongs to the turn-level fit, and
 * `operatorRoutingSamplesFromObservations` is where it is already consumed.
 *
 * A grader's verdict is an external judgement of the episode and keeps its boolean. Rows from writers outside
 * the credit ledger carry an outcome their own writer measured, and keep it untouched.
 */
function labelledOutcomes(observations: readonly CalibrationObservationRecord[]): Map<string, boolean | undefined> {
  const resolved = new Map<string, boolean | undefined>();
  for (const observation of observations) {
    const credit = creditRowEpisode(observation);
    resolved.set(observation.id, !credit || credit.supervised ? observation.outcome : undefined);
  }
  return resolved;
}

export function buildCalibrationModelsById(input: {
  observations: readonly CalibrationObservationRecord[];
  minPoints?: number;
  binCount?: number;
  createdAt?: number;
  clock?: Clock;
}): Record<string, CalibrationModel> {
  const minPoints = input.minPoints ?? 2;
  const outcomes = labelledOutcomes(input.observations);
  const createdAt = resolveCreatedAt(
    input.createdAt,
    input.clock,
    latestCreatedAt(input.observations)
  );
  const groups = new Map<string, CalibrationPoint[]>();
  for (const observation of input.observations) {
    const outcome = outcomes.get(observation.id);
    if (outcome === undefined) continue;
    const key = `${observation.calibrationId}|${observation.taskClass}`;
    groups.set(key, [...(groups.get(key) ?? []), { raw: observation.rawScore, outcome }]);
  }
  const models: Record<string, CalibrationModel> = {};
  for (const [key, points] of groups) {
    if (points.length < minPoints) continue;
    const [calibrationId, taskClass] = key.split("|");
    if (!calibrationId || !taskClass) continue;
    models[key] = buildCalibrationModel({
      id: `calibration.model.${hashText(key)}`,
      taskClass,
      points,
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
  const operatorRoutingModels = buildOperatorRoutingModels({
    observations: input.observations,
    createdAt
  });
  return {
    schema: "scce.calibration.model_set.v1",
    id: `calibration.model_set.${hashText(canonicalStringify({
      // Content, not the key list: two windows with the same keys and timestamp calibrated the same score
      // differently and shared an id, so the id could not name which model set decided an episode.
      models: Object.entries(models).sort(([left], [right]) => left.localeCompare(right)).map(([key, model]) => [key, model.bins.map(bin => [bin.lower, bin.upper, bin.confidence, bin.empirical, bin.count])]),
      creativePreferenceModels: Object.values(creativePreferenceModels).map(model => model.modelHash).sort(),
      judgeRequirementModels: Object.values(judgeRequirementModels).map(model => model.modelHash).sort(),
      operatorRoutingModels: Object.values(operatorRoutingModels).map(model => model.modelHash).sort(),
      createdAt
    }))}`,
    models,
    creativePreferenceModels,
    judgeRequirementModels,
    operatorRoutingModels,
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

export interface CalibrationModelMatch {
  model: CalibrationModel;
  /** `cross_task_class` means the model was fit on a different population than the one being asked about. */
  match: "exact" | "cross_task_class";
}

export function calibrationModelMatchFor(input: {
  modelSet?: CalibrationModelSet;
  calibrationId: string;
  taskClass?: string;
}): CalibrationModelMatch | undefined {
  if (!input.modelSet) return undefined;
  const exactKey = input.taskClass ? `${input.calibrationId}|${input.taskClass}` : undefined;
  const exact = exactKey ? input.modelSet.models[exactKey] : undefined;
  if (exact) return { model: exact, match: "exact" };
  if (input.taskClass === CALIBRATION_TASK_CLASS_IDS.creativeGeneration) return undefined;
  const sibling = Object.entries(input.modelSet.models)
    .filter(([key]) => key.startsWith(`${input.calibrationId}|`))
    .sort((left, right) => right[1].createdAt - left[1].createdAt || left[0].localeCompare(right[0]))[0]?.[1];
  return sibling ? { model: sibling, match: "cross_task_class" } : undefined;
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
  const found = input.fallbackModel
    ? { model: input.fallbackModel, match: input.fallbackModel.taskClass === input.taskClass ? "exact" as const : "cross_task_class" as const }
    : calibrationModelMatchFor({ modelSet: input.modelSet, calibrationId: input.calibrationId, taskClass: input.taskClass });
  const unmeasured = (measurement: CalibrationMeasurementState, sampleCount?: number): CalibratedRuntimeScore => ({
    raw,
    value: raw,
    calibrated: false,
    measurement,
    calibrationId: input.calibrationId,
    taskClass: input.taskClass,
    unappliedModelId: found?.model.id,
    sampleCount
  });
  if (!found) return unmeasured("unmeasured_no_model");
  // A fit on another task class has not measured this one, and an empty bin holds a prior, not a frequency.
  if (found.match === "cross_task_class") return unmeasured("unmeasured_task_class");
  const bin = calibrationBinFor(raw, found.model);
  if (!bin || bin.count <= 0) return unmeasured("unmeasured_score_region", bin?.count ?? 0);
  const value = calibrateProbability(raw, found.model);
  const scoreTrace = input.meaning ? calibratedScoreTrace({
    raw,
    model: found.model,
    meaning: input.meaning,
    provenance: input.provenance ?? ["calibration-spine.calibrateRuntimeScore"],
    inputs: [...(input.inputs ?? []), `calibrationId:${input.calibrationId}`]
  }) : undefined;
  return {
    raw,
    value,
    calibrated: true,
    measurement: "measured",
    calibrationId: input.calibrationId,
    taskClass: input.taskClass,
    modelId: found.model.id,
    sampleCount: bin.count,
    scoreTrace
  };
}

function selectedCritic(result: DialogueCalibrationResult): PragmaticsCalibrationCritic | undefined {
  return result.criticResults.find(critic => critic.id === result.selected.criticId)
    ?? result.criticResults.find(critic => critic.candidateId === result.selected.candidateId);
}

function taskClassFromDialogue(result: DialogueCalibrationResult): string {
  // Task class is a semantic routing result, not something inferred by
  // reparsing a surface string. The request/requirement lane writes this
  // opaque ID into dialogue state; absent that typed signal, keep the
  // conservative dialogue calibration bucket.
  return result.state.taskClassId?.trim() || CALIBRATION_TASK_CLASS_IDS.dialogueOutcome;
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
