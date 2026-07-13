import { canonicalStringify, clamp01, featureSet, toJsonValue, weightedJaccard } from "./primitives.js";
import { provisionalHeuristicScore, type ScoreTrace } from "./scoring/score-trace.js";
import type { JsonValue } from "./types.js";
import { CALIBRATION_IDS, CALIBRATION_TASK_CLASS_IDS, calibrateRuntimeScore, type CalibrationModelSet } from "./calibration-spine.js";
import { kalmanUpdate, replicatorDynamicsStep } from "./equation-operators.js";

export type InteractionFeatureId = string;
export type InteractionSignalId = string;
export type DialogueActionId = string;

export interface DialogueDisplayLabel {
  sourceId: "source.derived";
  text: string;
}

export interface InteractionFeature {
  id: InteractionFeatureId;
  value: number;
  sourceIds: string[];
  evidence: string[];
  displayLabels?: DialogueDisplayLabel[];
}

export interface InteractionSignal {
  id: InteractionSignalId;
  featureId: InteractionFeatureId;
  value: number;
  confidence: number;
  sourceIds: string[];
  trace: JsonValue;
  displayLabels?: DialogueDisplayLabel[];
}

export interface DialogueAction {
  id: DialogueActionId;
  utility: number;
  cost: number;
  score: number;
  reasonIds: string[];
  scoreTrace: ScoreTrace[];
  displayLabels?: DialogueDisplayLabel[];
}

export interface UserStyleProfile {
  schema: "scce.dialogue.policy_profile.v1";
  weights: Record<InteractionFeatureId, number>;
  preferredVocabulary: string[];
  rejectedPhrases: string[];
  displayLabels?: DialogueDisplayLabel[];
}

export interface DialogueState {
  conversationId: string;
  turnId: string;
  currentIntentId: string;
  activeTask?: string;
  unresolvedSlots: string[];
  establishedFacts: string[];
  rejectedAssumptions: string[];
  userStyleProfile: UserStyleProfile;
  interactionFeatures: InteractionFeature[];
  interactionSignals: InteractionSignal[];
  continuityLinks: string[];
}

export interface DialoguePolicyDecision {
  schema: "scce.dialogue.policy_decision.v1";
  id: string;
  conversationId: string;
  turnId: string;
  targetProfileId: string;
  rhythmId: string;
  selectedActionIds: DialogueActionId[];
  rankedActions: DialogueAction[];
  trace: JsonValue;
}

export interface DialoguePragmaticsCandidate {
  id: string;
  text: string;
  actionIds: DialogueActionId[];
  sourceIds: string[];
  trace: JsonValue;
}

export interface PragmaticsCriticResult {
  schema: "scce.dialogue.pragmatics_critic.v1";
  id: string;
  candidateId: string;
  valid: boolean;
  score: number;
  components: {
    truthPreservation: number;
    taskCompletion: number;
    conversationalFit: number;
    userStyleFit: number;
    continuity: number;
    clarity: number;
    naturalRhythm: number;
    penalty: number;
  };
  penalties: Array<{ id: string; weight: number; hitCount: number; examples: string[] }>;
  trace: JsonValue;
}

export interface DialoguePragmaticsResult {
  schema: "scce.dialogue.pragmatics_result.v1";
  id: string;
  state: DialogueState;
  policyDecision: DialoguePolicyDecision;
  candidates: DialoguePragmaticsCandidate[];
  criticResults: PragmaticsCriticResult[];
  selected: { candidateId: string; criticId: string; textHash: string; score: number };
  finalText: string;
  evidenceIds: string[];
  trace: JsonValue;
}

export interface DialogueFeedback {
  status?: "accepted" | "rejected" | "corrected";
  acceptedText?: string;
  rejectedText?: string;
  preferredText?: string;
  feedbackText?: string;
  rejectedPhrases?: string[];
  styleDelta?: Record<InteractionFeatureId, number>;
}

export interface DialogueAnswerGraphLike {
  id: string;
  statusId?: string;
  claims: Array<{ id: string; roleId?: string; surface: string; certified?: boolean }>;
  supportLinks: Array<{ claimId?: string; evidenceId: string; sourceRef?: { path?: string; lineStart?: number; lineEnd?: number }; forceClass?: string }>;
  caveats: Array<{ id: string; roleId?: string; text: string; sourceRef?: { path?: string; lineStart?: number; lineEnd?: number } }>;
  actions: Array<{ id: string; roleId?: string; taskRecordId?: string; affectedFiles: string[]; evidenceSpanIds: string[] }>;
  uncertainty: { unsupported: boolean; missingEvidenceCount: number; contradictionCount: number; gapCount: number };
}

export interface DialogueStateUpdateInput {
  conversationId?: string;
  turnId?: string;
  requestText: string;
  previousState?: DialogueState;
  answerGraph?: DialogueAnswerGraphLike;
  targetLanguage?: string;
  feedback?: DialogueFeedback;
  statePatch?: Partial<Omit<DialogueState, "userStyleProfile" | "interactionFeatures" | "interactionSignals">> & {
    userStyleProfile?: Partial<UserStyleProfile>;
    interactionFeatures?: InteractionFeature[];
    interactionSignals?: InteractionSignal[];
  };
}

export interface DialoguePragmaticsInput extends DialogueStateUpdateInput {
  answerGraph: DialogueAnswerGraphLike;
  candidateTexts?: string[];
  calibrationModels?: CalibrationModelSet;
  calibrationTaskClass?: string;
}

interface DialogueSurfaceMessageSlot {
  fragments: string[];
  sourceIds: string[];
}

interface DialogueMaterial {
  primaryClaim: string;
  certifiedClaims: string[];
  evidenceLabels: string[];
  evidenceIds: string[];
  caveats: string[];
  actionFiles: string[];
  nextStep?: DialogueSurfaceMessageSlot;
}

export const INTERACTION_FEATURE_IDS = {
  responseLead: "feat.2f4c0a17",
  artifactNeed: "feat.07a812cb",
  calculusNeed: "feat.a6b321d4",
  compactness: "feat.f134e0b9",
  caveatTolerance: "feat.6d04ac12",
  hedgeAversion: "feat.712fd8ea",
  reviewPressure: "feat.518ac06e",
  clarificationCost: "feat.9e7d44b0",
  boundaryNeed: "feat.c74ef201"
} as const;

export const DIALOGUE_ACTION_IDS = {
  answer: "act.8a7e1f20",
  boundary: "act.19c43d7a",
  bestEffort: "act.0df61b94",
  artifact: "act.43ab719e",
  calculus: "act.b20e5a68",
  plan: "act.f8326d01",
  clarify: "act.62c9ef30",
  nextStep: "act.584d3c9a",
  premiseCheck: "act.3ac081de"
} as const;

const RHYTHM_IDS = {
  calculus: "rhythm.3bc1a0f7",
  artifact: "rhythm.8ed491c2",
  boundary: "rhythm.5ad70e63",
  compact: "rhythm.c60a91f4",
  general: "rhythm.24f7b3ce"
} as const;

const TARGET_PROFILE_MARKERS = {
  p0: "prof.4e10b8d2"
} as const;

const SIGNAL_EVIDENCE_IDS = {
  symbolicShape: "evt.0b7a2e11",
  artifactShape: "evt.74c1a02f",
  lowDelayShape: "evt.b4051a7e",
  lowLengthShape: "evt.5ad2e0c9",
  pressurePunctuation: "evt.93e1d8b6",
  graphUncertainty: "evt.6f7c1b90",
  graphAction: "evt.d3b5a84f",
  graphContradiction: "evt.80f4a2c6"
} as const;

const ACTION_REASON_IDS = {
  r0: "rsn.1d0a2f83",
  r1: "rsn.77c4e1a9",
  r2: "rsn.5a60b8c2",
  r3: "rsn.0f3e91b7",
  r4: "rsn.a2e94d10",
  r5: "rsn.e6b27c49",
  r6: "rsn.91cb0f54",
  r7: "rsn.4f802bc1",
  r8: "rsn.c63bd90e"
} as const;

const DIALOGUE_PENALTY_IDS = {
  structure: "pen.0b3a91e6",
  rawInternal: "pen.92f10ac7",
  actionMismatch: "pen.a91dc047",
  unsupported: "pen.e15b803d",
  unneededQuestion: "pen.0f7c3d5a",
  rejectedSurface: "pen.c8e40762",
  lengthDrift: "pen.46d2a710"
} as const;

const DIALOGUE_CANDIDATE_IDS = {
  sparse: "cand.0b54c712",
  boundaryBest: "cand.7a9e0214",
  boundary: "cand.f48c70de",
  formal: "cand.95d18c3f",
  artifact: "cand.c46b02a7",
  plan: "cand.2d8f5a09",
  compact: "cand.5fc0e1b2",
  expanded: "cand.a8c6207d",
  empty: "cand.00000000"
} as const;

export const DEFAULT_USER_STYLE_PROFILE: UserStyleProfile = {
  schema: "scce.dialogue.policy_profile.v1",
  weights: {
    [INTERACTION_FEATURE_IDS.responseLead]: 0.62,
    [INTERACTION_FEATURE_IDS.artifactNeed]: 0.34,
    [INTERACTION_FEATURE_IDS.calculusNeed]: 0.34,
    [INTERACTION_FEATURE_IDS.compactness]: 0.56,
    [INTERACTION_FEATURE_IDS.caveatTolerance]: 0.44,
    [INTERACTION_FEATURE_IDS.hedgeAversion]: 0.5,
    [INTERACTION_FEATURE_IDS.reviewPressure]: 0.12,
    [INTERACTION_FEATURE_IDS.clarificationCost]: 0.38,
    [INTERACTION_FEATURE_IDS.boundaryNeed]: 0.5
  },
  preferredVocabulary: [],
  rejectedPhrases: []
};

export function updateDialogueState(input: DialogueStateUpdateInput): DialogueState {
  const previous = input.previousState;
  const feedbackProfile = applyDialogueFeedback(previous?.userStyleProfile ?? DEFAULT_USER_STYLE_PROFILE, input.feedback);
  const patchedProfile = mergeUserStyleProfile(feedbackProfile, input.statePatch?.userStyleProfile);
  const requestSignals = requestInteractionSignals(input.requestText);
  const graphSignals = graphInteractionSignals(input.answerGraph);
  const features = mergeInteractionFeatures([
    ...(previous?.interactionFeatures ?? []),
    ...requestSignals.map(signalToFeature),
    ...graphSignals.map(signalToFeature),
    ...(input.statePatch?.interactionFeatures ?? [])
  ]);
  const signals = [...requestSignals, ...graphSignals, ...(input.statePatch?.interactionSignals ?? [])].slice(-64);
  const graphFacts = input.answerGraph?.claims.filter(claim => claim.certified).map(claim => claim.surface).filter(Boolean) ?? [];
  const graphSlots = input.answerGraph ? unresolvedSlotsFromGraph(input.answerGraph) : [];
  const graphTask = input.answerGraph?.actions[0]?.taskRecordId ?? previous?.activeTask;
  const profile = {
    ...patchedProfile,
    weights: applyFeatureSignals(patchedProfile.weights, signals)
  };
  return {
    conversationId: input.statePatch?.conversationId ?? previous?.conversationId ?? input.conversationId ?? "conversation.default",
    turnId: input.statePatch?.turnId ?? input.turnId ?? `turn.${hashText(input.requestText).slice(0, 16)}`,
    currentIntentId: input.statePatch?.currentIntentId ?? classifyIntentId(input.requestText, input.answerGraph, previous),
    activeTask: input.statePatch?.activeTask ?? graphTask,
    unresolvedSlots: uniqueStrings([...(previous?.unresolvedSlots ?? []), ...graphSlots, ...(input.statePatch?.unresolvedSlots ?? [])]).slice(0, 24),
    establishedFacts: uniqueStrings([...(previous?.establishedFacts ?? []), ...graphFacts, ...(input.statePatch?.establishedFacts ?? [])]).slice(-48),
    rejectedAssumptions: uniqueStrings([
      ...(previous?.rejectedAssumptions ?? []),
      ...(input.feedback?.rejectedPhrases ?? []),
      ...(input.statePatch?.rejectedAssumptions ?? [])
    ]).slice(-32),
    userStyleProfile: profile,
    interactionFeatures: features,
    interactionSignals: signals,
    continuityLinks: uniqueStrings([
      ...(previous?.continuityLinks ?? []),
      ...(input.answerGraph ? [input.answerGraph.id] : []),
      ...(input.statePatch?.continuityLinks ?? [])
    ]).slice(-48)
  };
}

export function planDialoguePolicy(input: { state: DialogueState; answerGraph: DialogueAnswerGraphLike; targetLanguage?: string }): DialoguePolicyDecision {
  const state = input.state;
  const profile = state.userStyleProfile;
  const enoughInformation = hasEnoughInformation(input.answerGraph);
  const boundaryNeed = input.answerGraph.uncertainty.unsupported || input.answerGraph.uncertainty.missingEvidenceCount > 0;
  const rows: DialogueAction[] = [];
  const add = (id: DialogueActionId, utility: number, cost: number, reasonIds: string[]) => {
    const normalizedUtility = clamp01(utility);
    const normalizedCost = clamp01(cost);
    rows.push({
      id,
      utility: normalizedUtility,
      cost: normalizedCost,
      score: clamp01(normalizedUtility - normalizedCost),
      reasonIds,
      scoreTrace: [
        provisionalHeuristicScore({
          value: normalizedUtility,
          range: [0, 1],
          meaning: "score.0c97e8a1",
          inputs: [id, ...reasonIds],
          provenance: ["dialogue-pragmatics.policy"],
          failureModes: ["risk.0e36a148", "risk.7dc5f921"],
          idSeed: `${id}:utility:${reasonIds.join("|")}`
        }),
        provisionalHeuristicScore({
          value: normalizedCost,
          range: [0, 1],
          meaning: "score.d14c0f6b",
          inputs: [id, ...reasonIds],
          provenance: ["dialogue-pragmatics.policy"],
          failureModes: ["risk.b1f5a4c0", "risk.7dc5f921"],
          idSeed: `${id}:cost:${reasonIds.join("|")}`
        })
      ]
    });
  };
  add(DIALOGUE_ACTION_IDS.answer, 0.5 + (enoughInformation ? 0.28 : -0.18) + weight(profile, INTERACTION_FEATURE_IDS.responseLead) * 0.16, 0.04, [ACTION_REASON_IDS.r0]);
  add(DIALOGUE_ACTION_IDS.clarify, enoughInformation ? 0.08 : 0.5, 0.18 + weight(profile, INTERACTION_FEATURE_IDS.clarificationCost) * 0.28, [ACTION_REASON_IDS.r1]);
  add(DIALOGUE_ACTION_IDS.bestEffort, enoughInformation ? 0.28 : 0.78, 0.08, [ACTION_REASON_IDS.r2]);
  add(DIALOGUE_ACTION_IDS.boundary, boundaryNeed ? 0.72 : 0.18, 0.04 + (1 - weight(profile, INTERACTION_FEATURE_IDS.caveatTolerance)) * 0.1, [ACTION_REASON_IDS.r3]);
  add(DIALOGUE_ACTION_IDS.plan, input.answerGraph.actions.length ? 0.74 : 0.22, 0.08, [ACTION_REASON_IDS.r4]);
  add(DIALOGUE_ACTION_IDS.calculus, weight(profile, INTERACTION_FEATURE_IDS.calculusNeed), 0.08, [ACTION_REASON_IDS.r5]);
  add(DIALOGUE_ACTION_IDS.artifact, weight(profile, INTERACTION_FEATURE_IDS.artifactNeed), 0.08, [ACTION_REASON_IDS.r6]);
  add(DIALOGUE_ACTION_IDS.premiseCheck, input.answerGraph.uncertainty.contradictionCount > 0 ? 0.64 : 0.14, 0.06, [ACTION_REASON_IDS.r7]);
  add(DIALOGUE_ACTION_IDS.nextStep, input.answerGraph.actions.length || boundaryNeed ? 0.58 : 0.24, 0.06, [ACTION_REASON_IDS.r8]);
  const rankedActions = rows.sort((left, right) => right.score - left.score || left.id.localeCompare(right.id));
  const selectedActionIds = selectActions(rankedActions, state, input.answerGraph);
  const rhythmId = rhythmFor(state, input.answerGraph, selectedActionIds);
  return {
    schema: "scce.dialogue.policy_decision.v1",
    id: `dialogue.policy.${hashText(canonicalStringify({ state, graph: input.answerGraph.id, selectedActionIds })).slice(0, 24)}`,
    conversationId: state.conversationId,
    turnId: state.turnId,
    targetProfileId: input.targetLanguage ?? "und",
    rhythmId,
    selectedActionIds,
    rankedActions,
    trace: toJsonValue({
      source: "dialogue-pragmatics.policy",
      enoughInformation,
      boundaryNeed,
      featureIds: state.interactionFeatures.map(feature => feature.id),
      signalIds: state.interactionSignals.map(signal => signal.id)
    })
  };
}

export function realizeDialogueResponse(input: DialoguePragmaticsInput): DialoguePragmaticsResult {
  const state = updateDialogueState(input);
  const policyDecision = planDialoguePolicy({ state, answerGraph: input.answerGraph, targetLanguage: input.targetLanguage });
  const candidates = buildDialogueCandidates({
    state,
    policy: policyDecision,
    answerGraph: input.answerGraph,
    targetLanguage: input.targetLanguage ?? "und",
    providedTexts: input.candidateTexts ?? []
  });
  const criticResults = candidates.map(candidate => critiquePragmaticsCandidate({
    state,
    policyDecision,
    answerGraph: input.answerGraph,
    candidate,
    targetLanguage: input.targetLanguage ?? "und",
    calibrationModels: input.calibrationModels,
    calibrationTaskClass: input.calibrationTaskClass ?? CALIBRATION_TASK_CLASS_IDS.dialogueOutcome
  }));
  const preservedDraft = preservedProvidedDraftCritic(candidates, criticResults);
  const selectedCritic = preservedDraft ?? criticResults
    .filter(result => result.valid)
    .sort((left, right) => right.score - left.score || left.candidateId.localeCompare(right.candidateId))[0] ??
    criticResults.sort((left, right) => right.score - left.score || left.candidateId.localeCompare(right.candidateId))[0];
  const selectedCandidate = candidates.find(candidate => candidate.id === selectedCritic?.candidateId) ?? candidates[0] ?? emptyCandidate(policyDecision);
  const finalText = removeRejectedPhrases(selectedCandidate.text, state);
  return {
    schema: "scce.dialogue.pragmatics_result.v1",
    id: `dialogue.pragmatics.${hashText(canonicalStringify({ state, decision: policyDecision.id, selected: selectedCandidate.id })).slice(0, 24)}`,
    state,
    policyDecision,
    candidates,
    criticResults,
    selected: {
      candidateId: selectedCandidate.id,
      criticId: selectedCritic?.id ?? "",
      textHash: hashText(finalText),
      score: selectedCritic?.score ?? 0
    },
    finalText,
    evidenceIds: uniqueStrings(input.answerGraph.supportLinks.map(link => link.evidenceId)),
    trace: toJsonValue({
      source: "dialogue-pragmatics.realize",
      answerGraphId: input.answerGraph.id,
      selectedActionIds: policyDecision.selectedActionIds,
      selectedCandidateId: selectedCandidate.id
    })
  };
}

export function applyDialogueFeedback(profile: UserStyleProfile, feedback: DialogueFeedback | undefined): UserStyleProfile {
  if (!feedback) return cloneStyleProfile(profile);
  const next = cloneStyleProfile(profile);
  for (const [featureId, value] of Object.entries(feedback.styleDelta ?? {})) {
    if (typeof value === "number") next.weights[featureId] = clamp01((next.weights[featureId] ?? 0.5) + value);
  }
  if (feedback.status === "accepted") {
    next.weights[INTERACTION_FEATURE_IDS.responseLead] = clamp01(weight(next, INTERACTION_FEATURE_IDS.responseLead) + acceptedLeadDelta(feedback.acceptedText, feedback.rejectedText));
    next.weights[INTERACTION_FEATURE_IDS.compactness] = clamp01(weight(next, INTERACTION_FEATURE_IDS.compactness) + acceptedCompactDelta(feedback.acceptedText, feedback.rejectedText));
  }
  if (feedback.status === "rejected" || feedback.status === "corrected") {
    next.weights[INTERACTION_FEATURE_IDS.hedgeAversion] = clamp01(weight(next, INTERACTION_FEATURE_IDS.hedgeAversion) + 0.08);
    next.weights[INTERACTION_FEATURE_IDS.clarificationCost] = clamp01(weight(next, INTERACTION_FEATURE_IDS.clarificationCost) + 0.12);
    next.rejectedPhrases = uniqueStrings([
      ...next.rejectedPhrases,
      ...(feedback.rejectedPhrases ?? []),
      ...rejectedFragments(feedback.rejectedText)
    ]).slice(-48);
  }
  if (feedback.preferredText) next.preferredVocabulary = uniqueStrings([...next.preferredVocabulary, ...salientSurfaceUnits(feedback.preferredText)]).slice(-48);
  return applyReplicatorFeedback(next, feedback);
}

export function critiquePragmaticsCandidate(input: {
  state: DialogueState;
  policyDecision: DialoguePolicyDecision;
  answerGraph: DialogueAnswerGraphLike;
  candidate: DialoguePragmaticsCandidate;
  targetLanguage: string;
  calibrationModels?: CalibrationModelSet;
  calibrationTaskClass?: string;
}): PragmaticsCriticResult {
  const text = input.candidate.text;
  const enoughInformation = hasEnoughInformation(input.answerGraph);
  const penalties: PragmaticsCriticResult["penalties"] = [];
  const addPenalty = (id: string, weightValue: number, examples: string[]) => {
    const clean = uniqueStrings(examples.filter(Boolean)).slice(0, 4);
    if (clean.length && weightValue > 0) penalties.push({ id, weight: weightValue, hitCount: clean.length, examples: clean });
  };
  addPenalty(DIALOGUE_PENALTY_IDS.rawInternal, 0.2, rawInternalLabelHits(text));
  addPenalty(DIALOGUE_PENALTY_IDS.structure, 0.1, paragraphRhythmHits(text));
  addPenalty(DIALOGUE_PENALTY_IDS.actionMismatch, input.policyDecision.selectedActionIds.includes(DIALOGUE_ACTION_IDS.answer) && !input.candidate.actionIds.includes(DIALOGUE_ACTION_IDS.answer) ? 0.18 : 0, [input.candidate.id]);
  addPenalty(DIALOGUE_PENALTY_IDS.unneededQuestion, enoughInformation && text.includes("?") && !input.candidate.actionIds.includes(DIALOGUE_ACTION_IDS.clarify) ? 0.18 : 0, ["?"]);
  addPenalty(DIALOGUE_PENALTY_IDS.rejectedSurface, 0.28, rejectedPhraseHits(text, input.state));
  addPenalty(DIALOGUE_PENALTY_IDS.lengthDrift, weight(input.state.userStyleProfile, INTERACTION_FEATURE_IDS.compactness) > 0.65 && surfaceWordCount(text) > 90 ? 0.14 : 0, [String(surfaceWordCount(text))]);
  if (input.answerGraph.uncertainty.unsupported && !input.candidate.actionIds.includes(DIALOGUE_ACTION_IDS.boundary)) addPenalty(DIALOGUE_PENALTY_IDS.unsupported, 0.36, [input.answerGraph.id]);
  const penalty = clamp01(penalties.reduce((sum, item) => sum + item.weight * Math.max(1, item.hitCount), 0));
  const components = {
    truthPreservation: truthPreservationScore(text, input.answerGraph),
    taskCompletion: taskCompletionScore(input.candidate, input.policyDecision, input.answerGraph),
    conversationalFit: conversationalFitScore(input.candidate, input.state, input.policyDecision),
    userStyleFit: userStyleFitScore(text, input.state),
    continuity: rejectedPhraseHits(text, input.state).length ? 0 : 1,
    clarity: clarityScore(text),
    naturalRhythm: naturalRhythmScore(input.candidate, input.policyDecision, input.state),
    penalty
  };
  const rawScore = clamp01(
    components.truthPreservation * 0.24 +
    components.taskCompletion * 0.18 +
    components.conversationalFit * 0.16 +
    components.userStyleFit * 0.14 +
    components.continuity * 0.1 +
    components.clarity * 0.08 +
    components.naturalRhythm * 0.1 -
    components.penalty
  );
  const calibrated = calibrateRuntimeScore({
    raw: rawScore,
    calibrationId: CALIBRATION_IDS.dialoguePragmaticsScore,
    taskClass: input.calibrationTaskClass ?? CALIBRATION_TASK_CLASS_IDS.dialogueOutcome,
    modelSet: input.calibrationModels,
    meaning: "calibrated dialogue pragmatics score",
    provenance: ["dialogue-pragmatics.critic"],
    inputs: [input.candidate.id, input.policyDecision.id]
  });
  const score = calibrated.value;
  return {
    schema: "scce.dialogue.pragmatics_critic.v1",
    id: `dialogue.critic.${hashText(canonicalStringify({ candidate: input.candidate.id, score, penalties })).slice(0, 24)}`,
    candidateId: input.candidate.id,
    valid: score >= 0.2 && !penalties.some(item => item.id === DIALOGUE_PENALTY_IDS.unsupported && item.weight >= 0.36),
    score,
    components,
    penalties,
    trace: toJsonValue({
      source: "dialogue-pragmatics.critic",
      policyDecisionId: input.policyDecision.id,
      answerGraphId: input.answerGraph.id,
      rawScore,
      calibration: calibrated
    })
  };
}

function buildDialogueCandidates(input: {
  state: DialogueState;
  policy: DialoguePolicyDecision;
  answerGraph: DialogueAnswerGraphLike;
  targetLanguage: string;
  providedTexts: readonly string[];
}): DialoguePragmaticsCandidate[] {
  const material = dialogueMaterial(input.answerGraph);
  const candidates: DialoguePragmaticsCandidate[] = [];
  const add = (id: string, text: string, actionIds: DialogueActionId[], sourceIds: string[]) => {
    const clean = tidySurface(text);
    if (!clean) return;
    candidates.push({ id, text: clean, actionIds, sourceIds, trace: toJsonValue({ source: "dialogue-pragmatics.candidate", answerGraphId: input.answerGraph.id }) });
  };
  input.providedTexts.forEach((text, index) => add(`cand.${hashText(`input:${index}`).slice(0, 8)}`, text, input.policy.selectedActionIds, material.evidenceIds));
  if (sparseTargetProfile(input.targetLanguage)) {
    add(DIALOGUE_CANDIDATE_IDS.sparse, neutralTargetSurface(material, input.answerGraph, input.targetLanguage), input.policy.selectedActionIds, material.evidenceIds);
    return dedupeCandidates(candidates);
  }
  if (input.answerGraph.uncertainty.unsupported || !hasEnoughInformation(input.answerGraph)) {
    add(DIALOGUE_CANDIDATE_IDS.boundaryBest, insufficientSurface(material), [DIALOGUE_ACTION_IDS.bestEffort, DIALOGUE_ACTION_IDS.boundary, DIALOGUE_ACTION_IDS.nextStep], material.evidenceIds);
  }
  if (input.policy.selectedActionIds.includes(DIALOGUE_ACTION_IDS.calculus)) {
    add(DIALOGUE_CANDIDATE_IDS.formal, formalSurface(material), [DIALOGUE_ACTION_IDS.calculus, DIALOGUE_ACTION_IDS.answer], material.evidenceIds);
  }
  if (input.policy.selectedActionIds.includes(DIALOGUE_ACTION_IDS.artifact)) {
    add(DIALOGUE_CANDIDATE_IDS.artifact, artifactSurface(material), [DIALOGUE_ACTION_IDS.artifact, DIALOGUE_ACTION_IDS.answer, DIALOGUE_ACTION_IDS.nextStep], material.evidenceIds);
  }
  if (input.policy.selectedActionIds.includes(DIALOGUE_ACTION_IDS.plan)) {
    add(DIALOGUE_CANDIDATE_IDS.plan, planSurface(material), [DIALOGUE_ACTION_IDS.plan, DIALOGUE_ACTION_IDS.answer, DIALOGUE_ACTION_IDS.nextStep], material.evidenceIds);
  }
  if (input.policy.selectedActionIds.includes(DIALOGUE_ACTION_IDS.boundary) || input.state.currentIntentId === "intent.83f0c4ba") {
    add(DIALOGUE_CANDIDATE_IDS.boundary, boundarySurface(material, input.answerGraph), [DIALOGUE_ACTION_IDS.answer, DIALOGUE_ACTION_IDS.boundary], material.evidenceIds);
  }
  const compact = weight(input.state.userStyleProfile, INTERACTION_FEATURE_IDS.compactness);
  const responseLead = weight(input.state.userStyleProfile, INTERACTION_FEATURE_IDS.responseLead);
  if (compact > 0.62 || responseLead > 0.72) {
    add(DIALOGUE_CANDIDATE_IDS.compact, compactSurface(material, input.answerGraph), [DIALOGUE_ACTION_IDS.answer], material.evidenceIds);
  } else {
    add(DIALOGUE_CANDIDATE_IDS.expanded, expandedSurface(material, input.answerGraph), [DIALOGUE_ACTION_IDS.answer, DIALOGUE_ACTION_IDS.plan, DIALOGUE_ACTION_IDS.nextStep], material.evidenceIds);
  }
  return dedupeCandidates(candidates);
}

function preservedProvidedDraftCritic(candidates: readonly DialoguePragmaticsCandidate[], critics: readonly PragmaticsCriticResult[]): PragmaticsCriticResult | undefined {
  const candidate = candidates.find(item => item.id === `cand.${hashText("input:0").slice(0, 8)}` && item.sourceIds.length > 0);
  if (!candidate) return undefined;
  const critic = critics.find(item => item.candidateId === candidate.id);
  if (!critic?.valid || critic.score < 0.5) return undefined;
  const hardPenalty = critic.penalties.some(item =>
    item.id === DIALOGUE_PENALTY_IDS.rawInternal ||
    item.id === DIALOGUE_PENALTY_IDS.rejectedSurface ||
    item.id === DIALOGUE_PENALTY_IDS.unsupported
  );
  return hardPenalty ? undefined : critic;
}

function requestInteractionSignals(text: string): InteractionSignal[] {
  const urgentPunctuation = (text.match(/[!?]/gu) ?? []).length;
  const wordCount = surfaceWordCount(text);
  const hasCodeFenceOrPath = /```|(?:^|\s)[\w./-]+\.(?:ts|tsx|js|py|rs|go|java|json|md)\b/u.test(text);
  const hasSymbolicNotation = /[=≠≈≤≥<>∑∫√∆λ→←↔±×÷]/u.test(text);
  const shortDirectiveShape = wordCount > 0 && wordCount <= 8 && !/[?？]/u.test(text);
  const signals: InteractionSignal[] = [];
  const add = (featureId: InteractionFeatureId, value: number, sourceIds: string[], evidence: string[]) => {
    if (value <= 0) return;
    signals.push({
      id: `sig.${hashText(canonicalStringify({ featureId, value, evidence })).slice(0, 16)}`,
      featureId,
      value: clamp01(value),
      confidence: 0.72,
      sourceIds,
      trace: toJsonValue({ source: "dialogue-pragmatics.request-signal", evidence })
    });
  };
  add(INTERACTION_FEATURE_IDS.calculusNeed, hasSymbolicNotation ? 1 : 0, ["turn.input"], [SIGNAL_EVIDENCE_IDS.symbolicShape]);
  add(INTERACTION_FEATURE_IDS.artifactNeed, hasCodeFenceOrPath ? 1 : 0, ["turn.input"], [SIGNAL_EVIDENCE_IDS.artifactShape]);
  add(INTERACTION_FEATURE_IDS.responseLead, shortDirectiveShape || urgentPunctuation > 1 ? 1 : 0, ["turn.input"], [SIGNAL_EVIDENCE_IDS.lowDelayShape]);
  add(INTERACTION_FEATURE_IDS.compactness, shortDirectiveShape || wordCount <= 6 ? 1 : 0, ["turn.input"], [SIGNAL_EVIDENCE_IDS.lowLengthShape]);
  add(INTERACTION_FEATURE_IDS.reviewPressure, urgentPunctuation > 2 || /[?!؟？！]{2,}/u.test(text) ? 1 : 0, ["turn.input"], [SIGNAL_EVIDENCE_IDS.pressurePunctuation]);
  return signals;
}

function graphInteractionSignals(graph: DialogueAnswerGraphLike | undefined): InteractionSignal[] {
  if (!graph) return [];
  const signals: InteractionSignal[] = [];
  const add = (featureId: InteractionFeatureId, value: number, evidence: string[]) => {
    if (value <= 0) return;
    signals.push({
      id: `sig.${hashText(canonicalStringify({ featureId, value, graph: graph.id })).slice(0, 16)}`,
      featureId,
      value: clamp01(value),
      confidence: 0.86,
      sourceIds: [graph.id],
      trace: toJsonValue({ source: "dialogue-pragmatics.graph-signal", evidence })
    });
  };
  add(INTERACTION_FEATURE_IDS.boundaryNeed, graph.uncertainty.unsupported || graph.uncertainty.missingEvidenceCount > 0 ? 1 : 0, [SIGNAL_EVIDENCE_IDS.graphUncertainty]);
  add(INTERACTION_FEATURE_IDS.artifactNeed, graph.actions.length ? 0.75 : 0, [SIGNAL_EVIDENCE_IDS.graphAction]);
  add(INTERACTION_FEATURE_IDS.reviewPressure, graph.uncertainty.contradictionCount > 0 ? 0.7 : 0, [SIGNAL_EVIDENCE_IDS.graphContradiction]);
  return signals;
}

function signalToFeature(signal: InteractionSignal): InteractionFeature {
  return {
    id: signal.featureId,
    value: signal.value,
    sourceIds: signal.sourceIds,
    evidence: [String(signal.trace)],
    displayLabels: signal.displayLabels
  };
}

function applyFeatureSignals(base: Record<string, number>, signals: readonly InteractionSignal[]): Record<string, number> {
  const out = { ...base };
  for (const signal of signals) {
    const current = out[signal.featureId] ?? 0.5;
    out[signal.featureId] = kalmanUpdate({
      estimate: current,
      estimateVariance: 0.08,
      measurement: signal.value,
      measurementVariance: Math.max(0.02, 1 - signal.confidence),
      processVariance: 0.01
    }).estimate;
  }
  if ((out[INTERACTION_FEATURE_IDS.reviewPressure] ?? 0) > 0.6) {
    out[INTERACTION_FEATURE_IDS.responseLead] = clamp01((out[INTERACTION_FEATURE_IDS.responseLead] ?? 0.5) + 0.18);
    out[INTERACTION_FEATURE_IDS.caveatTolerance] = clamp01((out[INTERACTION_FEATURE_IDS.caveatTolerance] ?? 0.5) - 0.12);
  }
  return out;
}

function applyReplicatorFeedback(profile: UserStyleProfile, feedback: DialogueFeedback): UserStyleProfile {
  if (!feedback.status) return profile;
  const ids = Object.keys(profile.weights).sort();
  if (!ids.length) return profile;
  const fitness = ids.map(id => {
    if (feedback.status === "accepted") {
      if (id === INTERACTION_FEATURE_IDS.responseLead || id === INTERACTION_FEATURE_IDS.compactness) return 1.12;
      if (id === INTERACTION_FEATURE_IDS.clarificationCost) return 0.96;
      return 1.02;
    }
    if (id === INTERACTION_FEATURE_IDS.hedgeAversion || id === INTERACTION_FEATURE_IDS.clarificationCost || id === INTERACTION_FEATURE_IDS.boundaryNeed) return 1.16;
    if (id === INTERACTION_FEATURE_IDS.caveatTolerance) return 1.08;
    return 0.98;
  });
  const distribution = replicatorDynamicsStep({ weights: ids.map(id => profile.weights[id] ?? 0.5), fitness, floor: 0.01 });
  const uniform = 1 / ids.length;
  const weights = { ...profile.weights };
  ids.forEach((id, index) => {
    const relative = (distribution[index] ?? uniform) / uniform;
    weights[id] = clamp01((weights[id] ?? 0.5) * (0.94 + 0.06 * relative));
  });
  return { ...profile, weights };
}

function dialogueMaterial(answerGraph: DialogueAnswerGraphLike): DialogueMaterial {
  const certifiedClaims = answerGraph.claims.filter(claim => claim.certified).map(claim => claim.surface).filter(Boolean);
  const claims = certifiedClaims.length ? certifiedClaims : answerGraph.claims.map(claim => claim.surface).filter(Boolean);
  const evidenceLabels = uniqueStrings(answerGraph.supportLinks.map(link => sourceLabel(link.sourceRef) || link.evidenceId)).slice(0, 6);
  const evidenceIds = uniqueStrings(answerGraph.supportLinks.map(link => link.evidenceId));
  const caveats = uniqueStrings(answerGraph.caveats.map(caveat => caveat.text).filter(Boolean)).slice(0, 4);
  const actionFiles = uniqueStrings(answerGraph.actions.flatMap(action => action.affectedFiles)).slice(0, 8);
  const primaryClaim = claims[0] ?? "";
  const nextStep = actionFiles.length
    ? surfaceSlot(actionFiles, actionFiles)
    : caveats.length
      ? surfaceSlot(caveats.slice(0, 1), answerGraph.caveats.map(caveat => caveat.id))
      : undefined;
  return { primaryClaim, certifiedClaims: claims, evidenceLabels, evidenceIds, caveats, actionFiles, nextStep };
}

function neutralTargetSurface(material: ReturnType<typeof dialogueMaterial>, answerGraph: DialogueAnswerGraphLike, targetLanguage: string): string {
  const profileMarkers = sparseTargetProfile(targetLanguage) ? [`[${TARGET_PROFILE_MARKERS.p0}]`] : [];
  const lines = [
    ...profileMarkers,
    material.primaryClaim,
    ...material.evidenceLabels.map(label => `[${label}]`),
    ...material.actionFiles.map(file => `-> ${file}`),
    ...(answerGraph.uncertainty.unsupported ? ["?"] : [])
  ].filter(Boolean);
  return lines.join("\n");
}

function compactSurface(material: ReturnType<typeof dialogueMaterial>, answerGraph: DialogueAnswerGraphLike): string {
  if (answerGraph.uncertainty.unsupported || !material.primaryClaim) return insufficientSurface(material);
  return compactSentences([material.primaryClaim, material.caveats[0], renderSurfaceSlot(material.nextStep)]);
}

function expandedSurface(material: ReturnType<typeof dialogueMaterial>, answerGraph: DialogueAnswerGraphLike): string {
  if (answerGraph.uncertainty.unsupported || !material.primaryClaim) return insufficientSurface(material);
  return compactSentences([material.primaryClaim, evidenceRefSurface(material), material.caveats[0], renderSurfaceSlot(material.nextStep)]);
}

function boundarySurface(material: ReturnType<typeof dialogueMaterial>, answerGraph: DialogueAnswerGraphLike): string {
  return [
    material.primaryClaim || material.caveats[0] || uncertaintyMarker(answerGraph),
    evidenceRefSurface(material),
    uncertaintyMarker(answerGraph),
    renderSurfaceSlot(material.nextStep)
  ].filter(Boolean).join("\n");
}

function formalSurface(material: ReturnType<typeof dialogueMaterial>): string {
  return compactSentences([
    "y* = argmax_y(u(y) - c(y)).",
    material.primaryClaim,
    evidenceRefSurface(material),
    renderSurfaceSlot(material.nextStep)
  ]);
}

function artifactSurface(material: ReturnType<typeof dialogueMaterial>): string {
  const files = material.actionFiles.length ? joinHuman(material.actionFiles) : "";
  return compactSentences([
    files,
    material.primaryClaim,
    renderSurfaceSlot(material.nextStep)
  ]);
}

function planSurface(material: ReturnType<typeof dialogueMaterial>): string {
  return compactSentences([
    material.primaryClaim,
    renderSurfaceSlot(material.nextStep),
    evidenceRefSurface(material)
  ]);
}

function insufficientSurface(material: ReturnType<typeof dialogueMaterial>): string {
  return compactSentences([material.primaryClaim, material.caveats[0], renderSurfaceSlot(material.nextStep), evidenceRefSurface(material)]);
}

function surfaceSlot(fragments: readonly string[], sourceIds: readonly string[]): DialogueSurfaceMessageSlot {
  return {
    fragments: uniqueStrings(fragments.map(tidySurface).filter(Boolean)),
    sourceIds: uniqueStrings(sourceIds.map(tidySurface).filter(Boolean))
  };
}

function renderSurfaceSlot(slot: DialogueSurfaceMessageSlot | undefined): string {
  return slot ? joinHuman(slot.fragments) : "";
}

function evidenceRefSurface(material: ReturnType<typeof dialogueMaterial>): string {
  return material.evidenceLabels.length ? material.evidenceLabels.map(label => `[${label}]`).join(" ") : "";
}

function uncertaintyMarker(graph: DialogueAnswerGraphLike): string {
  if (graph.uncertainty.contradictionCount > 0) return `!${graph.uncertainty.contradictionCount}`;
  if (graph.uncertainty.missingEvidenceCount > 0) return `?${graph.uncertainty.missingEvidenceCount}`;
  if (graph.uncertainty.unsupported) return "?";
  return "";
}

function selectActions(rows: readonly DialogueAction[], state: DialogueState, graph: DialogueAnswerGraphLike): DialogueActionId[] {
  const selected: DialogueActionId[] = [];
  const add = (id: DialogueActionId) => {
    if (!selected.includes(id)) selected.push(id);
  };
  add(DIALOGUE_ACTION_IDS.answer);
  if (graph.uncertainty.unsupported || graph.uncertainty.missingEvidenceCount > 0) add(DIALOGUE_ACTION_IDS.boundary);
  if (!hasEnoughInformation(graph)) add(DIALOGUE_ACTION_IDS.bestEffort);
  if (weight(state.userStyleProfile, INTERACTION_FEATURE_IDS.calculusNeed) > 0.72 || hasStrongSignal(state, INTERACTION_FEATURE_IDS.calculusNeed)) add(DIALOGUE_ACTION_IDS.calculus);
  if (weight(state.userStyleProfile, INTERACTION_FEATURE_IDS.artifactNeed) > 0.72 || hasStrongSignal(state, INTERACTION_FEATURE_IDS.artifactNeed)) add(DIALOGUE_ACTION_IDS.artifact);
  if (graph.actions.length) add(DIALOGUE_ACTION_IDS.plan);
  if (graph.uncertainty.contradictionCount > 0) add(DIALOGUE_ACTION_IDS.premiseCheck);
  if (graph.actions.length || graph.uncertainty.missingEvidenceCount > 0) add(DIALOGUE_ACTION_IDS.nextStep);
  for (const row of rows) {
    if (selected.length >= 5) break;
    if (row.score >= 0.58) add(row.id);
  }
  return selected.slice(0, 6);
}

function rhythmFor(state: DialogueState, graph: DialogueAnswerGraphLike, actionIds: readonly DialogueActionId[]): string {
  if (actionIds.includes(DIALOGUE_ACTION_IDS.calculus)) return RHYTHM_IDS.calculus;
  if (actionIds.includes(DIALOGUE_ACTION_IDS.artifact)) return RHYTHM_IDS.artifact;
  if (graph.uncertainty.unsupported || actionIds.includes(DIALOGUE_ACTION_IDS.boundary)) return RHYTHM_IDS.boundary;
  return weight(state.userStyleProfile, INTERACTION_FEATURE_IDS.compactness) > 0.62 ? RHYTHM_IDS.compact : RHYTHM_IDS.general;
}

function classifyIntentId(text: string, graph: DialogueAnswerGraphLike | undefined, previous: DialogueState | undefined): string {
  if (/[=]/u.test(text)) return "intent.7291af0c";
  if (/```|(?:^|\s)[\w./-]+\.(?:ts|tsx|js|py|rs|go|java|json|md)\b/u.test(text)) return "intent.4bd129aa";
  if (graph?.supportLinks.length) return "intent.83f0c4ba";
  return previous?.currentIntentId ?? "intent.09f1dc42";
}

function truthPreservationScore(text: string, graph: DialogueAnswerGraphLike): number {
  if (graph.uncertainty.unsupported) return graph.caveats.length || text.trim() ? 0.76 : 0.18;
  const surfaces = graph.claims.map(claim => claim.surface).filter(Boolean);
  if (!surfaces.length) return 0.5;
  const textFeatures = featureSet(text, 256);
  return clamp01(Math.max(...surfaces.map(surface => weightedJaccard(textFeatures, featureSet(surface, 256)))) * 2.4);
}

function taskCompletionScore(candidate: DialoguePragmaticsCandidate, decision: DialoguePolicyDecision, graph: DialogueAnswerGraphLike): number {
  const actions = new Set(candidate.actionIds);
  const required = decision.selectedActionIds.filter(action => action !== DIALOGUE_ACTION_IDS.clarify);
  const covered = required.filter(action => actions.has(action)).length / Math.max(1, required.length);
  const actionFit = graph.actions.length ? Number(candidate.text.includes(graph.actions[0]?.affectedFiles[0] ?? "")) : 1;
  return clamp01(0.75 * covered + 0.25 * actionFit);
}

function conversationalFitScore(candidate: DialoguePragmaticsCandidate, state: DialogueState, decision: DialoguePolicyDecision): number {
  if (decision.selectedActionIds.includes(DIALOGUE_ACTION_IDS.calculus)) return candidate.actionIds.includes(DIALOGUE_ACTION_IDS.calculus) ? 1 : 0.35;
  if (weight(state.userStyleProfile, INTERACTION_FEATURE_IDS.reviewPressure) > 0.68) return surfaceWordCount(candidate.text) < 70 ? 0.92 : 0.48;
  return 0.72;
}

function userStyleFitScore(text: string, state: DialogueState): number {
  const words = surfaceWordCount(text);
  const compactFit = weight(state.userStyleProfile, INTERACTION_FEATURE_IDS.compactness) > 0.62 ? clamp01(1 - Math.max(0, words - 70) / 100) : 0.72;
  return clamp01(compactFit);
}

function clarityScore(text: string): number {
  const words = surfaceWordCount(text);
  if (words === 0) return 0;
  if (words <= 80) return 0.9;
  if (words <= 150) return 0.72;
  return 0.42;
}

function naturalRhythmScore(candidate: DialoguePragmaticsCandidate, decision: DialoguePolicyDecision, state: DialogueState): number {
  const required = decision.selectedActionIds.filter(action => action !== DIALOGUE_ACTION_IDS.clarify);
  const covered = required.filter(action => candidate.actionIds.includes(action)).length / Math.max(1, required.length);
  const compact = weight(state.userStyleProfile, INTERACTION_FEATURE_IDS.compactness);
  const lengthFit = compact > 0.62 ? clamp01(1 - Math.max(0, surfaceWordCount(candidate.text) - 70) / 120) : 0.76;
  return clamp01(0.7 * covered + 0.3 * lengthFit);
}

function hasEnoughInformation(graph: DialogueAnswerGraphLike): boolean {
  return !graph.uncertainty.unsupported && (graph.claims.some(claim => claim.certified) || graph.supportLinks.length > 0 || graph.actions.length > 0);
}

function unresolvedSlotsFromGraph(graph: DialogueAnswerGraphLike): string[] {
  return [
    ...graph.caveats.filter(caveat => caveat.roleId?.includes("missing")).map(caveat => caveat.id),
    ...(graph.uncertainty.missingEvidenceCount > 0 ? [`missing_evidence:${graph.uncertainty.missingEvidenceCount}`] : [])
  ];
}

function mergeUserStyleProfile(base: UserStyleProfile, patch: Partial<UserStyleProfile> | undefined): UserStyleProfile {
  const patchWeights = patch?.weights ?? {};
  return {
    schema: "scce.dialogue.policy_profile.v1",
    weights: { ...base.weights, ...Object.fromEntries(Object.entries(patchWeights).map(([key, value]) => [key, clamp01(value)])) },
    preferredVocabulary: uniqueStrings([...(base.preferredVocabulary ?? []), ...(patch?.preferredVocabulary ?? [])]).slice(-48),
    rejectedPhrases: uniqueStrings([...(base.rejectedPhrases ?? []), ...(patch?.rejectedPhrases ?? [])]).slice(-48),
    displayLabels: patch?.displayLabels ?? base.displayLabels
  };
}

function cloneStyleProfile(profile: UserStyleProfile): UserStyleProfile {
  return {
    schema: "scce.dialogue.policy_profile.v1",
    weights: { ...profile.weights },
    preferredVocabulary: [...profile.preferredVocabulary],
    rejectedPhrases: [...profile.rejectedPhrases],
    displayLabels: profile.displayLabels ? [...profile.displayLabels] : undefined
  };
}

function mergeInteractionFeatures(features: readonly InteractionFeature[]): InteractionFeature[] {
  const byId = new Map<string, InteractionFeature>();
  for (const feature of features) {
    const existing = byId.get(feature.id);
    byId.set(feature.id, existing
      ? { ...existing, value: Math.max(existing.value, feature.value), sourceIds: uniqueStrings([...existing.sourceIds, ...feature.sourceIds]), evidence: uniqueStrings([...existing.evidence, ...feature.evidence]) }
      : { ...feature, value: clamp01(feature.value), sourceIds: [...feature.sourceIds], evidence: [...feature.evidence] });
  }
  return [...byId.values()].slice(-32);
}

function weight(profile: UserStyleProfile, featureId: InteractionFeatureId): number {
  return clamp01(profile.weights[featureId] ?? DEFAULT_USER_STYLE_PROFILE.weights[featureId] ?? 0.5);
}

function hasStrongSignal(state: DialogueState, featureId: InteractionFeatureId): boolean {
  return state.interactionSignals.some(signal => signal.featureId === featureId && signal.value >= 0.85);
}

function acceptedLeadDelta(accepted: string | undefined, rejected: string | undefined): number {
  if (!accepted || !rejected) return 0.03;
  return surfaceWordCount(accepted) < surfaceWordCount(rejected) ? 0.08 : 0.01;
}

function acceptedCompactDelta(accepted: string | undefined, rejected: string | undefined): number {
  if (!accepted || !rejected) return 0.02;
  return accepted.length < rejected.length ? 0.1 : -0.02;
}

function rejectedFragments(text: string | undefined): string[] {
  if (!text) return [];
  return splitSentences(text).slice(0, 2).flatMap(sentence => {
    const clean = tidySurface(sentence);
    return clean.length > 12 ? [clean.slice(0, 96)] : [];
  });
}

function rejectedPhraseHits(text: string, state: DialogueState): string[] {
  const lower = text.toLocaleLowerCase();
  return uniqueStrings([...state.rejectedAssumptions, ...state.userStyleProfile.rejectedPhrases]
    .filter(phrase => phrase && lower.includes(phrase.toLocaleLowerCase())));
}

function removeRejectedPhrases(text: string, state: DialogueState): string {
  let out = text;
  for (const phrase of [...state.rejectedAssumptions, ...state.userStyleProfile.rejectedPhrases]) {
    if (!phrase) continue;
    out = out.replace(new RegExp(escapeRegExp(phrase), "giu"), " ").replace(/\s+/gu, " ");
  }
  return tidySurface(out);
}

function rawInternalLabelHits(text: string): string[] {
  return (text.match(/\b(?:scce|workspace\.kernel|answer_graph|proofTraceId|mouthTraceId|surface\.[a-z0-9_.-]+)\b/giu) ?? []).slice(0, 8);
}

function paragraphRhythmHits(text: string): string[] {
  const paragraphs = text.split(/\n{2,}/u).map(item => item.trim()).filter(Boolean);
  const longParagraphs = paragraphs.filter(item => surfaceWordCount(item) > 120);
  const choppy = paragraphs.length >= 4 && paragraphs.every(item => surfaceWordCount(item) < 8);
  return [...longParagraphs.slice(0, 2), ...(choppy ? ["shape.7ce9a013"] : [])];
}

function sparseTargetProfile(targetLanguage: string): boolean {
  const lower = targetLanguage.toLocaleLowerCase();
  if (!lower || lower === "und") return false;
  return lower.startsWith("x-") || lower.startsWith("art-");
}

function sourceLabel(ref: { path?: string; lineStart?: number; lineEnd?: number } | undefined): string {
  if (!ref?.path) return "";
  const line = ref.lineStart ? `:${ref.lineStart}${ref.lineEnd && ref.lineEnd !== ref.lineStart ? `-${ref.lineEnd}` : ""}` : "";
  return `${ref.path}${line}`;
}

function salientSurfaceUnits(text: string): string[] {
  return uniqueStrings((text.match(/[\p{Letter}\p{Number}_-]{4,}/gu) ?? []).slice(0, 24));
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/u).map(item => item.trim()).filter(Boolean);
}

function surfaceWordCount(text: string): number {
  return (text.match(/[\p{Letter}\p{Number}_-]+/gu) ?? []).length;
}

function compactSentences(parts: readonly (string | undefined)[]): string {
  return parts.map(ensureSentence).filter(Boolean).join(" ");
}

function ensureSentence(value: string | undefined): string {
  const clean = tidySurface(value ?? "");
  if (!clean) return "";
  return /[.!?]$/u.test(clean) ? clean : `${clean}.`;
}

function joinHuman(values: readonly string[]): string {
  const clean = values.map(tidySurface).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? "";
  return clean.join("; ");
}

function tidySurface(value: string): string {
  return value.normalize("NFC").replace(/\s+/gu, " ").trim();
}

function dedupeCandidates(candidates: readonly DialoguePragmaticsCandidate[]): DialoguePragmaticsCandidate[] {
  const byText = new Map<string, DialoguePragmaticsCandidate>();
  for (const candidate of candidates) {
    const key = candidate.text.toLocaleLowerCase();
    if (!byText.has(key)) byText.set(key, candidate);
  }
  return [...byText.values()];
}

function emptyCandidate(decision: DialoguePolicyDecision): DialoguePragmaticsCandidate {
  return {
    id: DIALOGUE_CANDIDATE_IDS.empty,
    text: "",
    actionIds: decision.selectedActionIds,
    sourceIds: [],
    trace: toJsonValue({ source: "dialogue-pragmatics.empty" })
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function hashText(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
