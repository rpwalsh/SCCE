import { canonicalStringify, clamp01, createClock, toJsonValue } from "./primitives.js";
import { provisionalHeuristicScore, type ScoreTrace } from "./scoring/score-trace.js";
import type {
  ConversationOutcomeRecord,
  DialogueMemoryStore,
  DialoguePolicyDecisionRecord,
  InteractionStateRecord,
  ResponseCandidateRecord,
  StylePreferenceSnapshot,
  TargetProfilePatternRecord,
  UserCorrectionRecord
} from "./storage.js";
import type { Clock, EvidenceId, JsonValue } from "./types.js";
import {
  DEFAULT_USER_STYLE_PROFILE,
  INTERACTION_FEATURE_IDS,
  type DialoguePolicyDecision,
  type DialoguePragmaticsResult,
  type DialoguePragmaticsCandidate,
  type DialogueState,
  type InteractionFeatureId,
  type PragmaticsCriticResult,
  type UserStyleProfile
} from "./dialogue-pragmatics.js";
import {
  CALIBRATION_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  buildCreativePreferenceModels,
  calibrationObservationsFromDialogueOutcome,
  creativePreferenceModelSnapshotObservation,
  creativePreferenceObservationPair,
  type CalibrationObservationRecord,
  type CreativePreferenceFeatureVector
} from "./calibration-spine.js";

export const TARGET_PROFILE_PATTERN_FAMILY_IDS = {
  rhythm: "tpf.16f4d90c",
  register: "tpf.73d201aa",
  politeness: "tpf.4ad8ce01",
  caveat: "tpf.c82d770a",
  turnShape: "tpf.1dcb90f7",
  codeSwitch: "tpf.e89a7c2b",
  correctionPreference: "tpf.a11be046"
} as const;

export interface DialoguePersistenceBatch {
  interactionState: InteractionStateRecord;
  policyDecision: DialoguePolicyDecisionRecord;
  responseCandidates: ResponseCandidateRecord[];
}

export interface DialoguePolicyLearningUpdate {
  schema: "scce.dialogue.policy_learning_update.v1";
  id: string;
  previousProfileHash: string;
  nextProfile: UserStyleProfile;
  nextProfileHash: string;
  scoreTrace: ScoreTrace[];
  snapshot: StylePreferenceSnapshot;
}

export interface DialogueOutcomeMemoryReplay {
  schema: "scce.dialogue.memory_replay.v1";
  conversationId: string;
  latestProfile?: UserStyleProfile;
  rejectedSurfaceHashes: string[];
  acceptedSurfaceHashes: string[];
  openOutcomeIds: string[];
}

export interface DialogueMemoryPragmaticsReplay {
  schema: "scce.dialogue.pragmatics_replay.v1";
  conversationId: string;
  turnId: string;
  answerGraphHash?: string;
  result: DialoguePragmaticsResult;
}

export interface DialogueCreativePreferencePair {
  pairId?: string;
  preferenceKind?: "accepted_rejected" | "corrected_original";
  preferred: {
    candidateId: string;
    features: CreativePreferenceFeatureVector;
    selectedOutputHash?: string;
  };
  rejected: {
    candidateId: string;
    features: CreativePreferenceFeatureVector;
    selectedOutputHash?: string;
  };
}

export function buildDialoguePersistenceBatch(input: {
  result: DialoguePragmaticsResult;
  answerGraphHash?: string;
  now?: number;
  clock?: Clock;
}): DialoguePersistenceBatch {
  const now = resolveNow(input.now, input.clock);
  const scoreTraceRefs = uniqueStrings(input.result.policyDecision.rankedActions.flatMap(action => action.scoreTrace.map(trace => trace.id)));
  return {
    interactionState: {
      id: `interaction_state.${hashText(canonicalStringify({ id: input.result.state.turnId, now }))}`,
      conversationId: input.result.state.conversationId,
      turnId: input.result.state.turnId,
      stateJson: toJsonValue(input.result.state),
      featureRefs: uniqueStrings(input.result.state.interactionFeatures.map(feature => feature.id)),
      signalRefs: uniqueStrings(input.result.state.interactionSignals.map(signal => signal.id)),
      createdAt: now
    },
    policyDecision: {
      id: input.result.policyDecision.id,
      conversationId: input.result.policyDecision.conversationId,
      turnId: input.result.policyDecision.turnId,
      decisionJson: toJsonValue(input.result.policyDecision),
      selectedActionIds: [...input.result.policyDecision.selectedActionIds],
      scoreTraceRefs,
      createdAt: now
    },
    responseCandidates: input.result.candidates.map(candidate => {
      const critic = input.result.criticResults.find(item => item.candidateId === candidate.id);
      return {
        id: `response_candidate.${hashText(canonicalStringify({ turn: input.result.state.turnId, candidate: candidate.id, text: candidate.text }))}`,
        conversationId: input.result.state.conversationId,
        turnId: input.result.state.turnId,
        candidateId: candidate.id,
        policyDecisionId: input.result.policyDecision.id,
        answerGraphHash: input.answerGraphHash,
        responseHash: hashText(candidate.text),
        responseText: candidate.text,
        criticScore: critic?.score ?? 0,
        scoreTraceRefs,
        createdAt: now
      };
    })
  };
}

export function conversationOutcomeFromPragmatics(input: {
  result: DialoguePragmaticsResult;
  promptText: string;
  answerGraphHash?: string;
  accepted?: boolean;
  rejected?: boolean;
  corrected?: boolean;
  correctionText?: string;
  requestedConstraintRefs?: readonly string[];
  satisfiedConstraintRefs?: readonly string[];
  failedConstraintRefs?: readonly string[];
  now?: Date;
  clock?: Clock;
}): ConversationOutcomeRecord {
  const createdAt = (input.now ?? new Date(resolveNow(undefined, input.clock))).toISOString();
  const selectedScoreTraceRefs = uniqueStrings(input.result.policyDecision.rankedActions.flatMap(action => action.scoreTrace.map(trace => trace.id)));
  return {
    id: `conversation_outcome.${hashText(canonicalStringify({ turn: input.result.state.turnId, response: input.result.selected.textHash, createdAt }))}`,
    conversationId: input.result.state.conversationId,
    turnId: input.result.state.turnId,
    promptHash: hashText(input.promptText),
    answerGraphHash: input.answerGraphHash,
    responseHash: input.result.selected.textHash,
    accepted: input.accepted,
    rejected: input.rejected,
    corrected: input.corrected,
    correctionText: input.correctionText,
    requestedConstraintRefs: input.requestedConstraintRefs ?? input.result.policyDecision.selectedActionIds,
    satisfiedConstraintRefs: input.satisfiedConstraintRefs ?? (input.result.selected.score >= 0.5 ? input.result.policyDecision.selectedActionIds : []),
    failedConstraintRefs: input.failedConstraintRefs ?? input.result.criticResults.flatMap(result => result.penalties.map(penalty => penalty.id)),
    scoreTraceRefs: selectedScoreTraceRefs,
    createdAt
  };
}

export function userCorrectionFromOutcome(input: {
  outcome: ConversationOutcomeRecord;
  correctionText: string;
  rejectedSurface?: string;
  acceptedSurface?: string;
  preferenceDelta?: JsonValue;
  now?: number;
  clock?: Clock;
}): UserCorrectionRecord {
  return {
    id: `user_correction.${hashText(canonicalStringify({ outcome: input.outcome.id, correction: input.correctionText }))}`,
    conversationId: input.outcome.conversationId,
    turnId: input.outcome.turnId,
    promptHash: input.outcome.promptHash,
    responseHash: input.outcome.responseHash,
    correctionText: input.correctionText,
    rejectedSurfaceHash: input.rejectedSurface ? hashText(input.rejectedSurface) : undefined,
    acceptedSurfaceHash: input.acceptedSurface ? hashText(input.acceptedSurface) : undefined,
    preferenceDeltaJson: input.preferenceDelta ?? toJsonValue({ sourceOutcomeId: input.outcome.id }),
    createdAt: resolveNow(input.now, input.clock)
  };
}

export function learnDialoguePolicyWeights(input: {
  profile?: UserStyleProfile;
  outcome: ConversationOutcomeRecord;
  learningRate?: number;
  now?: number;
  clock?: Clock;
}): DialoguePolicyLearningUpdate {
  const prior = cloneProfile(input.profile ?? DEFAULT_USER_STYLE_PROFILE);
  const learningRate = input.learningRate ?? 0.18;
  const features = featureVectorFromOutcome(input.outcome);
  const y = input.outcome.accepted ? 1 : input.outcome.rejected || input.outcome.corrected ? 0 : 0.5;
  const yHat = predictOutcome(prior, features);
  const next = cloneProfile(prior);
  for (const [featureId, x] of Object.entries(features)) {
    next.weights[featureId] = clamp01((next.weights[featureId] ?? 0.5) + learningRate * (y - yHat) * x);
  }
  if (input.outcome.rejected || input.outcome.corrected) {
    next.weights[INTERACTION_FEATURE_IDS.clarificationCost] = clamp01((next.weights[INTERACTION_FEATURE_IDS.clarificationCost] ?? 0.5) + learningRate * 0.5);
    next.weights[INTERACTION_FEATURE_IDS.hedgeAversion] = clamp01((next.weights[INTERACTION_FEATURE_IDS.hedgeAversion] ?? 0.5) + learningRate * 0.25);
  }
  if (input.outcome.accepted) {
    next.weights[INTERACTION_FEATURE_IDS.responseLead] = clamp01((next.weights[INTERACTION_FEATURE_IDS.responseLead] ?? 0.5) + learningRate * 0.12);
  }
  const nextHash = hashText(canonicalStringify(next));
  const now = resolveNow(input.now, input.clock);
  const scoreTrace = Object.entries(features).map(([featureId, value]) => provisionalHeuristicScore({
    value: clamp01(value),
    range: [0, 1],
    meaning: "dialogue outcome online update feature",
    inputs: [featureId, input.outcome.id, `target=${y}`, `prediction=${yHat.toFixed(4)}`],
    provenance: ["dialogue-learning.online_update"],
    failureModes: ["single_user_sparse_history", "uncalibrated_logistic_update"],
    idSeed: `${input.outcome.id}:${featureId}:${value}`
  }));
  const snapshot: StylePreferenceSnapshot = {
    id: `style_snapshot.${nextHash}`,
    conversationId: input.outcome.conversationId,
    profileHash: nextHash,
    profileJson: toJsonValue(next),
    sourceOutcomeIds: [input.outcome.id],
    createdAt: now
  };
  return {
    schema: "scce.dialogue.policy_learning_update.v1",
    id: `policy_learning.${hashText(canonicalStringify({ outcome: input.outcome.id, nextHash }))}`,
    previousProfileHash: hashText(canonicalStringify(prior)),
    nextProfile: next,
    nextProfileHash: nextHash,
    scoreTrace,
    snapshot
  };
}

export function targetProfilePatternRecord(input: {
  targetProfileId: string;
  patternFamilyId: string;
  patternJson: JsonValue;
  evidenceIds?: readonly EvidenceId[];
  alpha?: number;
  now?: number;
  clock?: Clock;
}): TargetProfilePatternRecord {
  const now = resolveNow(input.now, input.clock);
  return {
    id: `target_profile_pattern.${hashText(canonicalStringify({ target: input.targetProfileId, family: input.patternFamilyId, pattern: input.patternJson }))}`,
    targetProfileId: input.targetProfileId,
    patternFamilyId: input.patternFamilyId,
    patternJson: input.patternJson,
    evidenceIds: [...(input.evidenceIds ?? [])],
    alpha: clamp01(input.alpha ?? 0.5),
    createdAt: now,
    updatedAt: now
  };
}

export function replayDialogueOutcomeMemory(input: {
  conversationId: string;
  outcomes: readonly ConversationOutcomeRecord[];
  snapshots: readonly StylePreferenceSnapshot[];
}): DialogueOutcomeMemoryReplay {
  const latestSnapshot = [...input.snapshots].sort((left, right) => right.createdAt - left.createdAt)[0];
  return {
    schema: "scce.dialogue.memory_replay.v1",
    conversationId: input.conversationId,
    latestProfile: styleProfileFromJson(latestSnapshot?.profileJson),
    rejectedSurfaceHashes: uniqueStrings(input.outcomes.filter(outcome => outcome.rejected || outcome.corrected).map(outcome => outcome.responseHash)),
    acceptedSurfaceHashes: uniqueStrings(input.outcomes.filter(outcome => outcome.accepted).map(outcome => outcome.responseHash)),
    openOutcomeIds: input.outcomes.filter(outcome => outcome.failedConstraintRefs.length > 0).map(outcome => outcome.id)
  };
}

export async function persistDialogueBatch(store: DialogueMemoryStore, batch: DialoguePersistenceBatch): Promise<void> {
  await store.putInteractionState(batch.interactionState);
  await store.putPolicyDecision(batch.policyDecision);
  for (const candidate of batch.responseCandidates) await store.putResponseCandidate(candidate);
}

export async function latestDialogueStyleProfile(store: DialogueMemoryStore, conversationId: string): Promise<UserStyleProfile | undefined> {
  const snapshots = await store.listStyleSnapshots({ conversationId, limit: 1 });
  return styleProfileFromJson(snapshots[0]?.profileJson);
}

export async function latestDialoguePragmaticsFromMemory(store: DialogueMemoryStore, input: {
  conversationId: string;
  turnId?: string;
}): Promise<DialogueMemoryPragmaticsReplay | undefined> {
  const states = await store.listInteractionStates({ conversationId: input.conversationId, turnId: input.turnId, limit: 1 });
  const stateRecord = states[0];
  if (!stateRecord) return undefined;
  const turnId = input.turnId ?? stateRecord.turnId;
  const decisions = await store.listPolicyDecisions({ conversationId: input.conversationId, turnId, limit: 1 });
  const decisionRecord = decisions[0];
  if (!decisionRecord) return undefined;
  const state = dialogueStateFromJson(stateRecord.stateJson);
  const policyDecision = dialoguePolicyDecisionFromJson(decisionRecord.decisionJson);
  if (!state || !policyDecision) return undefined;
  const candidateRecords = await store.listResponseCandidates({ conversationId: input.conversationId, turnId, policyDecisionId: policyDecision.id, limit: 32 });
  const candidates = candidateRecords.map(recordToDialogueCandidate(policyDecision));
  const criticResults = candidateRecords.map(recordToCriticResult);
  const selectedRecord = [...candidateRecords].sort((left, right) => right.criticScore - left.criticScore || left.candidateId.localeCompare(right.candidateId))[0];
  const selectedCandidate = candidates.find(candidate => candidate.id === selectedRecord?.candidateId) ?? candidates[0];
  if (!selectedCandidate) return undefined;
  const selectedCritic = criticResults.find(critic => critic.candidateId === selectedCandidate.id);
  const answerGraphHash = selectedRecord?.answerGraphHash;
  const result: DialoguePragmaticsResult = {
    schema: "scce.dialogue.pragmatics_result.v1",
    id: `dialogue.pragmatics.replay.${hashText(canonicalStringify({ conversationId: input.conversationId, turnId, policy: policyDecision.id, candidate: selectedCandidate.id })).slice(0, 16)}`,
    state,
    policyDecision,
    candidates,
    criticResults,
    selected: {
      candidateId: selectedCandidate.id,
      criticId: selectedCritic?.id ?? "",
      textHash: hashText(selectedCandidate.text),
      score: selectedCritic?.score ?? selectedRecord?.criticScore ?? 0
    },
    finalText: selectedCandidate.text,
    evidenceIds: [],
    trace: toJsonValue({
      source: "dialogue-learning.memory_replay",
      interactionStateId: stateRecord.id,
      policyDecisionRecordId: decisionRecord.id,
      responseCandidateRecordIds: candidateRecords.map(record => record.id)
    })
  };
  return { schema: "scce.dialogue.pragmatics_replay.v1", conversationId: input.conversationId, turnId, answerGraphHash, result };
}

export async function persistDialogueOutcomeFromMemory(input: {
  store: DialogueMemoryStore;
  conversationId: string;
  turnId?: string;
  promptText: string;
  accepted?: boolean;
  rejected?: boolean;
  corrected?: boolean;
  correctionText?: string;
  requestedConstraintRefs?: readonly string[];
  satisfiedConstraintRefs?: readonly string[];
  failedConstraintRefs?: readonly string[];
  taskClass?: string;
  creativePreferencePair?: DialogueCreativePreferencePair;
  now?: number;
  clock?: Clock;
}): Promise<{ replay: DialogueMemoryPragmaticsReplay; outcome: ConversationOutcomeRecord; correction?: UserCorrectionRecord; learning: DialoguePolicyLearningUpdate; calibrationObservations: CalibrationObservationRecord[] }> {
  const replay = await latestDialoguePragmaticsFromMemory(input.store, { conversationId: input.conversationId, turnId: input.turnId });
  if (!replay) throw new Error("dialogue.outcome requires a persisted dialogue turn");
  const currentProfile = await latestDialogueStyleProfile(input.store, input.conversationId);
  const learned = await persistDialogueOutcomeAndLearn({
    store: input.store,
    result: replay.result,
    promptText: input.promptText,
    answerGraphHash: replay.answerGraphHash,
    accepted: input.accepted,
    rejected: input.rejected,
    corrected: input.corrected,
    correctionText: input.correctionText,
    currentProfile,
    requestedConstraintRefs: input.requestedConstraintRefs,
    satisfiedConstraintRefs: input.satisfiedConstraintRefs,
    failedConstraintRefs: input.failedConstraintRefs,
    taskClass: input.taskClass,
    creativePreferencePair: input.creativePreferencePair,
    now: input.now,
    clock: input.clock
  });
  return { replay, ...learned };
}

export async function persistDialogueTurn(input: {
  store: DialogueMemoryStore;
  result: DialoguePragmaticsResult;
  answerGraphHash?: string;
  now?: number;
  clock?: Clock;
}): Promise<DialoguePersistenceBatch> {
  const batch = buildDialoguePersistenceBatch({ result: input.result, answerGraphHash: input.answerGraphHash, now: input.now, clock: input.clock });
  await persistDialogueBatch(input.store, batch);
  return batch;
}

export async function persistDialogueOutcomeAndLearn(input: {
  store: DialogueMemoryStore;
  result: DialoguePragmaticsResult;
  promptText: string;
  answerGraphHash?: string;
  accepted?: boolean;
  rejected?: boolean;
  corrected?: boolean;
  correctionText?: string;
  currentProfile?: UserStyleProfile;
  requestedConstraintRefs?: readonly string[];
  satisfiedConstraintRefs?: readonly string[];
  failedConstraintRefs?: readonly string[];
  taskClass?: string;
  creativePreferencePair?: DialogueCreativePreferencePair;
  now?: number;
  clock?: Clock;
}): Promise<{ outcome: ConversationOutcomeRecord; correction?: UserCorrectionRecord; learning: DialoguePolicyLearningUpdate; calibrationObservations: CalibrationObservationRecord[] }> {
  const now = resolveNow(input.now, input.clock);
  const outcome = conversationOutcomeFromPragmatics({
    result: input.result,
    promptText: input.promptText,
    answerGraphHash: input.answerGraphHash,
    accepted: input.accepted,
    rejected: input.rejected,
    corrected: input.corrected,
    correctionText: input.correctionText,
    requestedConstraintRefs: input.requestedConstraintRefs,
    satisfiedConstraintRefs: input.satisfiedConstraintRefs,
    failedConstraintRefs: input.failedConstraintRefs,
    now: new Date(now)
  });
  const correction = input.correctionText
    ? userCorrectionFromOutcome({ outcome, correctionText: input.correctionText, rejectedSurface: input.result.finalText, now })
    : undefined;
  const learning = learnDialoguePolicyWeights({ profile: input.currentProfile ?? input.result.state.userStyleProfile, outcome, now });
  const ordinaryCalibrationObservations = calibrationObservationsFromDialogueOutcome({ result: input.result, outcome, taskClass: input.taskClass, createdAt: now });
  const creativePreferenceObservations = input.creativePreferencePair
    ? creativePreferenceObservationPair({
        pairId: `${outcome.id}:${input.creativePreferencePair.pairId ?? "creative_preference"}`,
        preferred: input.creativePreferencePair.preferred,
        rejected: input.creativePreferencePair.rejected,
        preferenceKind: input.creativePreferencePair.preferenceKind ?? (input.corrected ? "corrected_original" : "accepted_rejected"),
        sourceTraceId: input.result.id,
        sourceRecordId: outcome.id,
        createdAt: now
      })
    : [];
  const calibrationObservations = [...ordinaryCalibrationObservations, ...creativePreferenceObservations];
  await input.store.putConversationOutcome(outcome);
  if (correction) await input.store.putUserCorrection(correction);
  await input.store.putStyleSnapshot(learning.snapshot);
  for (const observation of calibrationObservations) await input.store.putCalibrationObservation(observation);
  if (input.creativePreferencePair) {
    const persistedPairs = await input.store.listCalibrationObservations({
      calibrationId: CALIBRATION_IDS.creativeCandidatePreference,
      taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
      limit: 5_000
    });
    const model = buildCreativePreferenceModels({ observations: persistedPairs, createdAt: now })[CALIBRATION_TASK_CLASS_IDS.creativeGeneration];
    if (model) {
      const snapshot = creativePreferenceModelSnapshotObservation({
        model,
        sourceTraceId: input.result.id,
        sourceRecordId: outcome.id,
        createdAt: now
      });
      await input.store.putCalibrationObservation(snapshot);
      calibrationObservations.push(snapshot);
    }
  }
  return { outcome, correction, learning, calibrationObservations };
}

export function createInMemoryDialogueMemoryStore(seed?: {
  interactionStates?: readonly InteractionStateRecord[];
  policyDecisions?: readonly DialoguePolicyDecisionRecord[];
  outcomes?: readonly ConversationOutcomeRecord[];
  responseCandidates?: readonly ResponseCandidateRecord[];
  snapshots?: readonly StylePreferenceSnapshot[];
  targetProfilePatterns?: readonly TargetProfilePatternRecord[];
  calibrationObservations?: readonly CalibrationObservationRecord[];
}): DialogueMemoryStore {
  const interactionStates = new Map((seed?.interactionStates ?? []).map(record => [record.id, record]));
  const policyDecisions = new Map((seed?.policyDecisions ?? []).map(record => [record.id, record]));
  const outcomes = new Map((seed?.outcomes ?? []).map(record => [record.id, record]));
  const corrections = new Map<string, UserCorrectionRecord>();
  const snapshots = new Map((seed?.snapshots ?? []).map(record => [record.id, record]));
  const candidates = new Map((seed?.responseCandidates ?? []).map(record => [record.id, record]));
  const targetProfilePatterns = new Map((seed?.targetProfilePatterns ?? []).map(record => [record.id, record]));
  const calibrationObservations = new Map((seed?.calibrationObservations ?? []).map(record => [record.id, record]));
  return {
    putInteractionState: async record => { interactionStates.set(record.id, record); },
    compareAndPutInteractionState: async (record, condition) => {
      const current = [...interactionStates.values()]
        .filter(candidate => candidate.conversationId === record.conversationId)
        .map(candidate => ({ candidate, identity: interactionStateIdentity(candidate, condition.stateSchema) }))
        .filter((row): row is { candidate: InteractionStateRecord; identity: { stateId: string; turnIndex: number } } => Boolean(row.identity))
        .sort((left, right) => right.identity.turnIndex - left.identity.turnIndex
          || right.candidate.createdAt - left.candidate.createdAt
          || (right.candidate.id < left.candidate.id ? -1 : right.candidate.id > left.candidate.id ? 1 : 0))[0];
      const currentStateId = current?.identity.stateId ?? null;
      const currentTurnIndex = current?.identity.turnIndex ?? null;
      if (currentStateId !== condition.expectedStateId || currentTurnIndex !== condition.expectedTurnIndex) {
        return { stored: false, currentStateId, currentTurnIndex, reason: "state_conflict" as const };
      }
      if (condition.nextTurnIndex <= (currentTurnIndex ?? -1)) {
        return { stored: false, currentStateId, currentTurnIndex, reason: "turn_not_monotonic" as const };
      }
      const nextIdentity = interactionStateIdentity(record, condition.stateSchema);
      if (!nextIdentity
        || nextIdentity.stateId !== condition.nextStateId
        || nextIdentity.turnIndex !== condition.nextTurnIndex) {
        return { stored: false, currentStateId, currentTurnIndex, reason: "state_conflict" as const };
      }
      interactionStates.set(record.id, record);
      return {
        stored: true,
        currentStateId: condition.nextStateId,
        currentTurnIndex: condition.nextTurnIndex,
        reason: "stored" as const
      };
    },
    putPolicyDecision: async record => { policyDecisions.set(record.id, record); },
    putConversationOutcome: async record => { outcomes.set(record.id, record); },
    putUserCorrection: async record => { corrections.set(record.id, record); },
    putStyleSnapshot: async record => { snapshots.set(record.id, record); },
    putResponseCandidate: async record => { candidates.set(record.id, record); },
    putTargetProfilePattern: async record => { targetProfilePatterns.set(record.id, record); },
    putCalibrationObservation: async record => { calibrationObservations.set(record.id, record); },
    listInteractionStates: async query => newest([...interactionStates.values()].filter(record => (!query?.conversationId || record.conversationId === query.conversationId) && (!query?.turnId || record.turnId === query.turnId)), query?.limit ?? 100, record => record.createdAt),
    listPolicyDecisions: async query => newest([...policyDecisions.values()].filter(record => (!query?.conversationId || record.conversationId === query.conversationId) && (!query?.turnId || record.turnId === query.turnId)), query?.limit ?? 100, record => record.createdAt),
    listResponseCandidates: async query => newest([...candidates.values()].filter(record => (!query?.conversationId || record.conversationId === query.conversationId) && (!query?.turnId || record.turnId === query.turnId) && (!query?.policyDecisionId || record.policyDecisionId === query.policyDecisionId)), query?.limit ?? 100, record => record.createdAt),
    listConversationOutcomes: async query => newest([...outcomes.values()].filter(record => (!query?.conversationId || record.conversationId === query.conversationId) && (!query?.turnId || record.turnId === query.turnId)), query?.limit ?? 100, record => Date.parse(record.createdAt)),
    listStyleSnapshots: async query => newest([...snapshots.values()].filter(record => !query?.conversationId || record.conversationId === query.conversationId), query?.limit ?? 20, record => record.createdAt),
    listTargetProfilePatterns: async query => newest([...targetProfilePatterns.values()].filter(record => (!query?.targetProfileId || record.targetProfileId === query.targetProfileId) && (!query?.patternFamilyId || record.patternFamilyId === query.patternFamilyId)), query?.limit ?? 200, record => record.updatedAt),
    listCalibrationObservations: async query => newest([...calibrationObservations.values()].filter(record =>
      (!query?.calibrationId || record.calibrationId === query.calibrationId)
      && (!query?.subsystemId || record.subsystemId === query.subsystemId)
      && (!query?.taskClass || record.taskClass === query.taskClass)
      && (!query?.sourceRecordId || record.sourceRecordId === query.sourceRecordId)
    ), query?.limit ?? 500, record => record.createdAt)
  };
}

function interactionStateIdentity(record: InteractionStateRecord, stateSchema: string): { stateId: string; turnIndex: number } | undefined {
  if (!record.stateJson || typeof record.stateJson !== "object" || Array.isArray(record.stateJson)) return undefined;
  const state = record.stateJson as Record<string, JsonValue>;
  return state.schema === stateSchema
    && typeof state.id === "string"
    && typeof state.turnIndex === "number"
    && Number.isSafeInteger(state.turnIndex)
    && state.turnIndex >= 0
    ? { stateId: state.id, turnIndex: state.turnIndex }
    : undefined;
}

function featureVectorFromOutcome(outcome: ConversationOutcomeRecord): Record<InteractionFeatureId, number> {
  const requested = new Set(outcome.requestedConstraintRefs);
  const failed = new Set(outcome.failedConstraintRefs);
  return {
    [INTERACTION_FEATURE_IDS.responseLead]: requested.size ? 0.6 : 0.3,
    [INTERACTION_FEATURE_IDS.artifactNeed]: [...requested, ...failed].some(ref => ref.includes("43ab719e")) ? 1 : 0,
    [INTERACTION_FEATURE_IDS.boundaryNeed]: [...requested, ...failed].some(ref => ref.includes("19c43d7a") || ref.includes("unsupported")) ? 1 : 0,
    [INTERACTION_FEATURE_IDS.clarificationCost]: [...failed].some(ref => ref.includes("clarify") || ref.includes("62c9ef30")) ? 1 : 0.15,
    [INTERACTION_FEATURE_IDS.compactness]: outcome.accepted ? 0.45 : 0.25
  };
}

function dialogueStateFromJson(value: JsonValue | undefined): DialogueState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  if (typeof record.conversationId !== "string" || typeof record.turnId !== "string") return undefined;
  const profile = styleProfileFromJson(record.userStyleProfile);
  if (!profile) return undefined;
  return {
    conversationId: record.conversationId,
    turnId: record.turnId,
    currentIntentId: typeof record.currentIntentId === "string" ? record.currentIntentId : "",
    activeTask: typeof record.activeTask === "string" ? record.activeTask : undefined,
    unresolvedSlots: stringArray(record.unresolvedSlots),
    establishedFacts: stringArray(record.establishedFacts),
    rejectedAssumptions: stringArray(record.rejectedAssumptions),
    userStyleProfile: profile,
    interactionFeatures: Array.isArray(record.interactionFeatures) ? record.interactionFeatures.filter(item => item && typeof item === "object" && !Array.isArray(item)) as never[] : [],
    interactionSignals: Array.isArray(record.interactionSignals) ? record.interactionSignals.filter(item => item && typeof item === "object" && !Array.isArray(item)) as never[] : [],
    continuityLinks: stringArray(record.continuityLinks)
  };
}

function dialoguePolicyDecisionFromJson(value: JsonValue | undefined): DialoguePolicyDecision | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  if (record.schema !== "scce.dialogue.policy_decision.v1" || typeof record.id !== "string" || typeof record.conversationId !== "string" || typeof record.turnId !== "string") return undefined;
  return {
    schema: "scce.dialogue.policy_decision.v1",
    id: record.id,
    conversationId: record.conversationId,
    turnId: record.turnId,
    targetProfileId: typeof record.targetProfileId === "string" ? record.targetProfileId : "und",
    rhythmId: typeof record.rhythmId === "string" ? record.rhythmId : "",
    selectedActionIds: stringArray(record.selectedActionIds),
    rankedActions: Array.isArray(record.rankedActions) ? record.rankedActions.filter(item => item && typeof item === "object" && !Array.isArray(item)) as never[] : [],
    trace: record.trace ?? null
  };
}

function recordToDialogueCandidate(policyDecision: DialoguePolicyDecision): (record: ResponseCandidateRecord) => DialoguePragmaticsCandidate {
  return record => ({
    id: record.candidateId,
    text: record.responseText,
    actionIds: [...policyDecision.selectedActionIds],
    sourceIds: record.answerGraphHash ? [record.answerGraphHash] : [],
    trace: toJsonValue({ source: "dialogue-learning.candidate_replay", responseCandidateRecordId: record.id })
  });
}

function recordToCriticResult(record: ResponseCandidateRecord): PragmaticsCriticResult {
  const score = clamp01(record.criticScore);
  return {
    schema: "scce.dialogue.pragmatics_critic.v1",
    id: `dialogue.critic.replay.${hashText(record.id).slice(0, 16)}`,
    candidateId: record.candidateId,
    valid: score > 0,
    score,
    components: {
      truthPreservation: score,
      taskCompletion: score,
      conversationalFit: score,
      userStyleFit: score,
      continuity: score,
      clarity: score,
      naturalRhythm: score,
      penalty: 0
    },
    penalties: [],
    trace: toJsonValue({
      source: "dialogue-learning.critic_replay",
      responseCandidateRecordId: record.id,
      scoreTraceRefs: record.scoreTraceRefs
    })
  };
}

function predictOutcome(profile: UserStyleProfile, features: Record<string, number>): number {
  let dot = -0.2;
  for (const [featureId, value] of Object.entries(features)) dot += ((profile.weights[featureId] ?? 0.5) - 0.5) * value;
  return 1 / (1 + Math.exp(-dot));
}

function cloneProfile(profile: UserStyleProfile): UserStyleProfile {
  return {
    schema: "scce.dialogue.policy_profile.v1",
    weights: { ...profile.weights },
    preferredVocabulary: [...profile.preferredVocabulary],
    rejectedPhrases: [...profile.rejectedPhrases],
    displayLabels: profile.displayLabels ? [...profile.displayLabels] : undefined
  };
}

function styleProfileFromJson(value: JsonValue | undefined): UserStyleProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  if (record.schema !== "scce.dialogue.policy_profile.v1" || !record.weights || typeof record.weights !== "object" || Array.isArray(record.weights)) return undefined;
  const weights: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record.weights)) if (typeof raw === "number") weights[key] = clamp01(raw);
  return {
    schema: "scce.dialogue.policy_profile.v1",
    weights,
    preferredVocabulary: stringArray(record.preferredVocabulary),
    rejectedPhrases: stringArray(record.rejectedPhrases)
  };
}

function stringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function newest<T>(items: T[], limit: number, time: (item: T) => number): T[] {
  return items.sort((left, right) => time(right) - time(left)).slice(0, limit);
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function resolveNow(now: number | undefined, clock?: Clock): number {
  return typeof now === "number" && Number.isFinite(now)
    ? now
    : (clock ?? createClock()).now();
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
