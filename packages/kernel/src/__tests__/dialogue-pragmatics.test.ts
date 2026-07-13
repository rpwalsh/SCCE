import { describe, expect, it } from "vitest";
import {
  DEFAULT_USER_STYLE_PROFILE,
  DIALOGUE_ACTION_IDS,
  INTERACTION_FEATURE_IDS,
  applyDialogueFeedback,
  realizeDialogueResponse,
  type DialogueAnswerGraphLike,
  type DialogueState,
  type InteractionFeatureId,
  type UserStyleProfile
} from "../dialogue-pragmatics.js";

describe("dialogue pragmatics", () => {
  it("stores opaque signal/action/reason IDs", () => {
    const result = realizeDialogueResponse({
      requestText: "fix the parser path",
      answerGraph: supportedGraph(),
      previousState: state({
        userStyleProfile: style({
          [INTERACTION_FEATURE_IDS.responseLead]: 0.95,
          [INTERACTION_FEATURE_IDS.compactness]: 0.9,
          [INTERACTION_FEATURE_IDS.hedgeAversion]: 0.9,
          [INTERACTION_FEATURE_IDS.artifactNeed]: 0.8
        })
      })
    });
    expect(result.policyDecision.schema).toBe("scce.dialogue.policy_decision.v1");
    expect(result.policyDecision.selectedActionIds.every(id => /^act\.[a-f0-9]{8}$/u.test(id))).toBe(true);
    expect(result.state.interactionSignals.every(signal => /^sig\.[a-f0-9]{8,16}$/u.test(signal.id))).toBe(true);
    expect(result.policyDecision.rankedActions.every(action => action.reasonIds.every(id => /^rsn\.[a-f0-9]{8}$/u.test(id)))).toBe(true);
    expect(result.policyDecision.rankedActions.every(action => action.scoreTrace.every(trace => trace.kind === "provisional_heuristic" && trace.calibrated === false))).toBe(true);
  });

  it("does not generate display labels as model truth", () => {
    const result = realizeDialogueResponse({
      requestText: "what does this mean?",
      answerGraph: supportedGraph(),
      previousState: state({
        userStyleProfile: {
          ...style({ [INTERACTION_FEATURE_IDS.compactness]: 0.2 }),
          displayLabels: [{ sourceId: "source.derived", text: "源" }]
        }
      })
    });
    expect(result.policyDecision.rankedActions.every(action => !action.displayLabels?.length)).toBe(true);
    expect(result.state.userStyleProfile.displayLabels?.every(label => label.sourceId === "source.derived")).toBe(true);
    expect(result.finalText.length).toBeGreaterThan(0);
  });

  it("repeated correction changes response policy", () => {
    const first = realizeDialogueResponse({
      requestText: "explain",
      answerGraph: supportedGraph(),
      previousState: state({ userStyleProfile: style({ [INTERACTION_FEATURE_IDS.compactness]: 0.2, [INTERACTION_FEATURE_IDS.responseLead]: 0.25 }) })
    });
    const learnedProfile = applyDialogueFeedback(first.state.userStyleProfile, {
      status: "corrected",
      rejectedText: first.finalText,
      rejectedPhrases: ["verbose frame"],
      styleDelta: {
        [INTERACTION_FEATURE_IDS.responseLead]: 0.6,
        [INTERACTION_FEATURE_IDS.compactness]: 0.6,
        [INTERACTION_FEATURE_IDS.caveatTolerance]: -0.4
      }
    });
    const second = realizeDialogueResponse({
      requestText: "again",
      answerGraph: supportedGraph(),
      previousState: { ...first.state, userStyleProfile: learnedProfile }
    });
    expect(second.state.userStyleProfile.weights[INTERACTION_FEATURE_IDS.responseLead]).toBeGreaterThan(first.state.userStyleProfile.weights[INTERACTION_FEATURE_IDS.responseLead] ?? 0);
    expect(second.state.userStyleProfile.weights[INTERACTION_FEATURE_IDS.compactness]).toBeGreaterThan(first.state.userStyleProfile.weights[INTERACTION_FEATURE_IDS.compactness] ?? 0);
  });

  it("missing requested artifact changes policy", () => {
    const result = realizeDialogueResponse({
      requestText: "code this in src/pump.ts",
      answerGraph: supportedGraph(),
      previousState: state({ userStyleProfile: style({ [INTERACTION_FEATURE_IDS.artifactNeed]: 0.15 }) })
    });
    expect(result.policyDecision.selectedActionIds).toContain(DIALOGUE_ACTION_IDS.artifact);
    expect(result.state.interactionFeatures.some(feature => feature.id === INTERACTION_FEATURE_IDS.artifactNeed && feature.value > 0)).toBe(true);
  });

  it("rejected clarification raises the cost of another clarification", () => {
    const first = realizeDialogueResponse({
      requestText: "who owns calibration?",
      answerGraph: unsupportedGraph(),
      previousState: state({ userStyleProfile: style({ [INTERACTION_FEATURE_IDS.clarificationCost]: 0.1 }) })
    });
    const before = actionScore(first, DIALOGUE_ACTION_IDS.clarify);
    const learned = applyDialogueFeedback(first.state.userStyleProfile, {
      status: "rejected",
      rejectedText: "Can you clarify?",
      rejectedPhrases: ["Can you clarify?"]
    });
    const second = realizeDialogueResponse({
      requestText: "same question",
      answerGraph: unsupportedGraph(),
      previousState: { ...first.state, userStyleProfile: learned }
    });
    const after = actionScore(second, DIALOGUE_ACTION_IDS.clarify);
    expect(after.cost).toBeGreaterThan(before.cost);
    expect(after.score).toBeLessThan(before.score);
  });

  it("Korean and sparse target profiles do not depend on English action names", () => {
    const result = realizeDialogueResponse({
      requestText: "ko",
      targetLanguage: "ko",
      answerGraph: supportedGraph({ claim: "압력 파서는 src/pump.ts에 추가해야 한다." }),
      previousState: state()
    });
    expect(result.finalText).toContain("압력 파서는");
    expect(result.policyDecision.targetProfileId).toBe("ko");
    expect(result.policyDecision.selectedActionIds.every(id => /^act\.[a-f0-9]{8}$/u.test(id))).toBe(true);

    const sparse = realizeDialogueResponse({
      requestText: "x-private",
      targetLanguage: "x-private",
      answerGraph: supportedGraph({ claim: "src/pump.ts keeps 17 ms pressure timing." }),
      previousState: state()
    });
    expect(sparse.finalText).toContain("[prof.4e10b8d2]");
    expect(sparse.finalText).toContain("src/pump.ts");
    expect(sparse.finalText).toContain("17 ms");
  });

  it("runtime keeps generated display labels out of policy rows", () => {
    const result = realizeDialogueResponse({
      requestText: "source-bound answer only",
      answerGraph: supportedGraph({ missingEvidenceCount: 1 }),
      previousState: state()
    });
    const boundary = result.policyDecision.rankedActions.find(action => action.id === DIALOGUE_ACTION_IDS.boundary);
    expect(result.policyDecision.selectedActionIds).toContain(DIALOGUE_ACTION_IDS.boundary);
    expect(boundary?.displayLabels).toBeUndefined();
  });

  it("internal telemetry candidate loses to source-slot candidate", () => {
    const result = realizeDialogueResponse({
      requestText: "answer",
      answerGraph: supportedGraph(),
      candidateTexts: [
        "answer_graph.selected_candidate:src/pump.ts",
        "The pressure parser should be added in src/pump.ts."
      ],
      previousState: state({ userStyleProfile: style({ [INTERACTION_FEATURE_IDS.responseLead]: 0.9, [INTERACTION_FEATURE_IDS.compactness]: 0.9 }) })
    });
    const internalCandidateId = result.candidates[0]?.id;
    expect(internalCandidateId).toMatch(/^cand\.[a-f0-9]{8}$/u);
    expect(result.selected.candidateId).not.toBe(internalCandidateId);
    expect(result.finalText).toContain("src/pump.ts");
    expect(result.criticResults.find(item => item.candidateId === internalCandidateId)?.penalties.some(item => /^pen\.[a-f0-9]{8}$/u.test(item.id))).toBe(true);
  });
});

function actionScore(result: ReturnType<typeof realizeDialogueResponse>, actionId: string) {
  const action = result.policyDecision.rankedActions.find(item => item.id === actionId);
  if (!action) throw new Error(`missing action ${actionId}`);
  return action;
}

function supportedGraph(input: { claim?: string; missingEvidenceCount?: number } = {}): DialogueAnswerGraphLike {
  const claim = input.claim ?? "The pressure parser should be added in src/pump.ts.";
  return {
    id: "answer_graph.supported",
    statusId: "workspace.kernel.answer.ready",
    claims: [{ id: "claim.parser", roleId: "answer_graph.role.certified_claim", surface: claim, certified: true }],
    supportLinks: [{ claimId: "claim.parser", evidenceId: "evidence.ops", sourceRef: { path: "docs/ops.md", lineStart: 2 }, forceClass: "direct_evidence" }],
    caveats: input.missingEvidenceCount ? [{ id: "caveat.owner", roleId: "answer_graph.role.missing_evidence", text: "Calibration owner is not recorded." }] : [],
    actions: [{ id: "action.parser", roleId: "answer_graph.role.patch_plan", taskRecordId: "task.parser", affectedFiles: ["src/pump.ts"], evidenceSpanIds: ["evidence.ops"] }],
    uncertainty: { unsupported: false, missingEvidenceCount: input.missingEvidenceCount ?? 0, contradictionCount: 0, gapCount: input.missingEvidenceCount ?? 0 }
  };
}

function unsupportedGraph(): DialogueAnswerGraphLike {
  return {
    id: "answer_graph.unsupported",
    statusId: "workspace.kernel.answer.unsupported",
    claims: [],
    supportLinks: [],
    caveats: [{ id: "caveat.owner", roleId: "answer_graph.role.missing_evidence", text: "Calibration owner is not recorded." }],
    actions: [],
    uncertainty: { unsupported: true, missingEvidenceCount: 1, contradictionCount: 0, gapCount: 1 }
  };
}

function state(patch: Partial<DialogueState> = {}): DialogueState {
  return {
    conversationId: "conversation.test",
    turnId: "turn.test",
    currentIntentId: "intent.09f1dc42",
    unresolvedSlots: [],
    establishedFacts: [],
    rejectedAssumptions: [],
    userStyleProfile: style(),
    interactionFeatures: [],
    interactionSignals: [],
    continuityLinks: [],
    ...patch
  };
}

function style(weights: Partial<Record<InteractionFeatureId, number>> = {}): UserStyleProfile {
  const cleanWeights = Object.fromEntries(Object.entries(weights).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  return {
    ...DEFAULT_USER_STYLE_PROFILE,
    weights: {
      ...DEFAULT_USER_STYLE_PROFILE.weights,
      ...cleanWeights
    },
    preferredVocabulary: [],
    rejectedPhrases: []
  };
}
