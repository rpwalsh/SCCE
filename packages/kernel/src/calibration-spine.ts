import { canonicalStringify, clamp01, featureSet, toJsonValue } from "./primitives.js";
import { buildCalibrationModel, calibratedScoreTrace, calibrateProbability, type CalibrationModel } from "./scoring/calibration.js";
import type { ScoreTrace } from "./scoring/score-trace.js";
import type { JsonValue } from "./types.js";

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
  alphaCacheInvalidation: "alpha.cache_invalidation"
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
  alpha: "subsystem.alpha"
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
}): CalibrationObservationRecord {
  const createdAt = input.createdAt ?? Date.now();
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
}): [CalibrationObservationRecord, CalibrationObservationRecord] {
  const createdAt = input.createdAt ?? Date.now();
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

export function calibrationObservationsFromDialogueOutcome(input: {
  result: DialogueCalibrationResult;
  outcome: DialogueCalibrationOutcome;
  taskClass?: string;
  createdAt?: number;
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
  const at = Number.isFinite(createdAt) ? createdAt : Date.now();
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
}): Record<string, CalibrationModel> {
  const minPoints = input.minPoints ?? 2;
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
      createdAt: input.createdAt
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
  const createdAt = input.createdAt ?? Date.now();
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
}): CalibrationModelSet {
  const createdAt = input.createdAt ?? Date.now();
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
  return {
    schema: "scce.calibration.model_set.v1",
    id: `calibration.model_set.${hashText(canonicalStringify({
      models: Object.keys(models).sort(),
      creativePreferenceModels: Object.values(creativePreferenceModels).map(model => model.modelHash).sort(),
      createdAt
    }))}`,
    models,
    creativePreferenceModels,
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
}): Promise<CalibrationModelSet> {
  const observations = await input.store.listCalibrationObservations({ limit: input.limit ?? 5000 });
  return buildCalibrationModelSet({
    observations,
    minPoints: input.minPoints,
    binCount: input.binCount,
    createdAt: input.createdAt
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
