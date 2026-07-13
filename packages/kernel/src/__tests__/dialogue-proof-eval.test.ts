import { describe, expect, it } from "vitest";
import {
  CALIBRATION_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  DEFAULT_USER_STYLE_PROFILE,
  DIALOGUE_ACTION_IDS,
  EVAL_CATEGORY_IDS,
  INTERACTION_FEATURE_IDS,
  TARGET_PROFILE_PATTERN_FAMILY_IDS,
  buildDialoguePersistenceBatch,
  buildCalibrationModelsById,
  buildTurnDialogueBridge,
  conversationOutcomeFromPragmatics,
  createInMemoryDialogueMemoryStore,
  createJsonlEvalProvider,
  learnDialoguePolicyWeights,
  latestDialoguePragmaticsFromMemory,
  planStreamRhythm,
  persistDialogueOutcomeFromMemory,
  realizeDialogueResponse,
  replayDialogueOutcomeMemory,
  runBlindPairwiseEval,
  targetProfilePatternRecord,
  userCorrectionFromOutcome,
  verifyProofPreservingParaphrases,
  type DialogueAnswerGraphLike
} from "../index.js";

describe("dialogue proof/eval milestone", () => {
  it("persists outcome memory and replays learned style after restart", async () => {
    const result = realizeDialogueResponse({
      requestText: "who owns calibration?",
      answerGraph: unsupportedGraph()
    });
    const batch = buildDialoguePersistenceBatch({ result, answerGraphHash: "graph.hash", now: 1000 });
    const outcome = conversationOutcomeFromPragmatics({
      result,
      promptText: "who owns calibration?",
      rejected: true,
      failedConstraintRefs: [DIALOGUE_ACTION_IDS.clarify],
      now: new Date("2026-01-01T00:00:00.000Z")
    });
    const correction = userCorrectionFromOutcome({ outcome, correctionText: "Don't ask again; give the best source-bound answer.", rejectedSurface: result.finalText, now: 1001 });
    const learned = learnDialoguePolicyWeights({ profile: DEFAULT_USER_STYLE_PROFILE, outcome, learningRate: 0.2, now: 1002 });
    const store = createInMemoryDialogueMemoryStore();
    await store.putInteractionState(batch.interactionState);
    await store.putPolicyDecision(batch.policyDecision);
    for (const candidate of batch.responseCandidates) await store.putResponseCandidate(candidate);
    await store.putConversationOutcome(outcome);
    await store.putUserCorrection(correction);
    await store.putStyleSnapshot(learned.snapshot);
    const replayedPragmatics = await latestDialoguePragmaticsFromMemory(store, { conversationId: result.state.conversationId, turnId: result.state.turnId });
    expect(replayedPragmatics?.result.policyDecision.id).toBe(result.policyDecision.id);
    expect(replayedPragmatics?.result.finalText).toBe(result.finalText);
    const learnedFromReplay = await persistDialogueOutcomeFromMemory({
      store,
      conversationId: result.state.conversationId,
      turnId: result.state.turnId,
      promptText: "who owns calibration?",
      corrected: true,
      correctionText: "Answer from source-bound evidence without another clarification."
    });
    expect(learnedFromReplay.replay.result.selected.candidateId).toBe(result.selected.candidateId);
    expect(learnedFromReplay.correction?.correctionText).toContain("source-bound");
    expect(learnedFromReplay.calibrationObservations.map(item => item.calibrationId)).toEqual(expect.arrayContaining([
      CALIBRATION_IDS.dialoguePragmaticsScore,
      CALIBRATION_IDS.mouthSurfaceFit,
      CALIBRATION_IDS.mouthPreservation,
      CALIBRATION_IDS.languageGenerationConfidence
    ]));
    const persistedCalibration = await store.listCalibrationObservations({ sourceRecordId: learnedFromReplay.outcome.id });
    expect(persistedCalibration).toHaveLength(4);
    expect(persistedCalibration.every(item => /^calibration\.observation\.[0-9a-f]+$/u.test(item.id))).toBe(true);

    const restarted = createInMemoryDialogueMemoryStore({
      outcomes: await store.listConversationOutcomes({ conversationId: result.state.conversationId }),
      policyDecisions: await store.listPolicyDecisions({ conversationId: result.state.conversationId }),
      responseCandidates: await store.listResponseCandidates({ conversationId: result.state.conversationId }),
      snapshots: await store.listStyleSnapshots({ conversationId: result.state.conversationId }),
      calibrationObservations: persistedCalibration
    });
    const replay = replayDialogueOutcomeMemory({
      conversationId: result.state.conversationId,
      outcomes: await restarted.listConversationOutcomes({ conversationId: result.state.conversationId }),
      snapshots: await restarted.listStyleSnapshots({ conversationId: result.state.conversationId })
    });

    expect(replay.rejectedSurfaceHashes).toContain(outcome.responseHash);
    expect(replay.latestProfile?.weights[INTERACTION_FEATURE_IDS.clarificationCost]).toBeGreaterThan(DEFAULT_USER_STYLE_PROFILE.weights[INTERACTION_FEATURE_IDS.clarificationCost] ?? 0);
    expect(learned.scoreTrace.every(trace => trace.kind === "provisional_heuristic" && trace.calibrated === false)).toBe(true);
  });

  it("keeps calibration ids operational and buildable from outcomes", () => {
    const ids = Object.values(CALIBRATION_IDS);
    expect(ids).toEqual(expect.arrayContaining([
      "proof.force.proved",
      "proof.support",
      "proof.contradiction",
      "mouth.surface_fit",
      "dialogue.pragmatics_score",
      "workspace.answer_confidence",
      "code.role_confidence"
    ]));
    expect(new Set(ids).size).toBe(ids.length);
    const models = buildCalibrationModelsById({
      observations: [
        {
          schema: "scce.calibration.observation.v1",
          id: "calibration.observation.test.1",
          calibrationId: CALIBRATION_IDS.dialoguePragmaticsScore,
          subsystemId: "subsystem.dialogue",
          taskClass: CALIBRATION_TASK_CLASS_IDS.dialogueOutcome,
          rawScore: 0.8,
          outcome: true,
          finalOutcome: "outcome.accepted",
          metadata: {},
          createdAt: 1
        },
        {
          schema: "scce.calibration.observation.v1",
          id: "calibration.observation.test.2",
          calibrationId: CALIBRATION_IDS.dialoguePragmaticsScore,
          subsystemId: "subsystem.dialogue",
          taskClass: CALIBRATION_TASK_CLASS_IDS.dialogueOutcome,
          rawScore: 0.2,
          outcome: false,
          finalOutcome: "outcome.rejected",
          metadata: {},
          createdAt: 2
        }
      ],
      minPoints: 2,
      binCount: 2
    });
    expect(Object.keys(models)).toContain(`${CALIBRATION_IDS.dialoguePragmaticsScore}|${CALIBRATION_TASK_CLASS_IDS.dialogueOutcome}`);
  });

  it("stores target profile patterns with opaque/source-neutral family IDs", () => {
    const record = targetProfilePatternRecord({
      targetProfileId: "ko",
      patternFamilyId: TARGET_PROFILE_PATTERN_FAMILY_IDS.turnShape,
      patternJson: { observed: ["source.derived.turn_shape"] },
      evidenceIds: ["evidence.ko" as never],
      alpha: 0.7,
      now: 1000
    });
    expect(record.patternFamilyId).toMatch(/^tpf\.[a-f0-9]{8}$/u);
    expect(record.evidenceIds).toEqual(["evidence.ko"]);
  });

  it("rejects proof-preserving paraphrases that drop negation or protected spans", () => {
    const graph = supportedGraph({
      claim: "token.alpha did not satisfy relation.beta at marker.1777.",
      actions: []
    });
    const report = verifyProofPreservingParaphrases({
      answerGraph: graph,
      variants: [
        "token.alpha did not satisfy relation.beta at marker.1777. docs/source.md.",
        "token.alpha satisfied relation.beta."
      ]
    });
    expect(report.passed).toBe(false);
    expect(report.checks[0]?.valid).toBe(true);
    expect(report.checks[1]?.droppedNegation).toBe(true);
    expect(report.checks[1]?.missingProtectedSpans).toContain("1777");
  });

  it("plans stream rhythm with truth boundary before unsafe lead claims", () => {
    const result = realizeDialogueResponse({ requestText: "answer source only", answerGraph: unsupportedGraph() });
    const plan = planStreamRhythm({ policyDecision: result.policyDecision, answerGraph: unsupportedGraph(), finalText: result.finalText });
    const boundary = plan.segments.find(segment => segment.roleId === "stream.97ab401e");
    const lead = plan.segments.find(segment => segment.roleId === "stream.6f2e9c31");
    expect(boundary?.canEmitBeforeFullCompletion).toBe(true);
    expect(lead?.dependencies).toContain("stream.97ab401e");
  });

  it("bridges a live turn result into persisted dialogue memory", async () => {
    const result = minimalTurnResult({
      answer: "token.alpha did not satisfy relation.beta.",
      evidenceText: "token.alpha did not satisfy relation.beta."
    });
    const bridge = buildTurnDialogueBridge({
      requestText: "did token.alpha satisfy relation.beta?",
      result,
      conversationId: "conversation.live",
      turnId: "turn.live"
    });
    const store = createInMemoryDialogueMemoryStore();
    const batch = buildDialoguePersistenceBatch({ result: bridge.pragmatics, answerGraphHash: bridge.answerGraphHash, now: 2000 });
    await store.putInteractionState(batch.interactionState);
    await store.putPolicyDecision(batch.policyDecision);
    for (const candidate of batch.responseCandidates) await store.putResponseCandidate(candidate);

    const replayed = await latestDialoguePragmaticsFromMemory(store, { conversationId: "conversation.live", turnId: "turn.live" });
    expect(bridge.streamPlan.segments.length).toBeGreaterThan(0);
    expect(replayed?.answerGraphHash).toBe(bridge.answerGraphHash);
    expect(replayed?.result.finalText).toContain("token.alpha");
  });

  it("runs a blinded pairwise eval without training on provider names", async () => {
    const prompts = [{
      id: "prompt.eval.1",
      categoryId: EVAL_CATEGORY_IDS.proofPreservation,
      prompt: "Did token.alpha satisfy relation.beta?",
      rubric: {
        id: "rubric.eval.1",
        criteria: ["correctness", "naturalness"],
        expectedTerms: ["token.alpha", "relation.beta"],
        forbiddenTerms: ["provider.opaque"],
        protectedSpans: ["token.alpha"],
        brevityTargetWords: 30
      }
    }];
    const providers = [
      createJsonlEvalProvider({ providerId: "provider.opaque.1", answers: [{ id: "answer.a", promptId: "prompt.eval.1", providerId: "provider.opaque.1", text: "token.alpha did not satisfy relation.beta." }] }),
      createJsonlEvalProvider({ providerId: "provider.opaque.2", answers: [{ id: "answer.b", promptId: "prompt.eval.1", providerId: "provider.opaque.2", text: "relation.beta omitted the protected token." }] })
    ];
    const run = await runBlindPairwiseEval({ prompts, providers, baselineProviderId: "provider.opaque.1" });
    expect(run.judgments).toHaveLength(1);
    expect(run.calibrationObservations.length).toBeGreaterThan(0);
    expect(run.calibrationObservations.map(item => item.calibrationId)).toEqual(expect.arrayContaining([
      CALIBRATION_IDS.proofSupport,
      CALIBRATION_IDS.mouthPreservation
    ]));
    expect(run.judgments[0]?.hiddenProviderIds).toBe(true);
    expect(run.report.categories[0]?.baselinePreferredRate).toBe(1);
    expect(JSON.stringify(run.report.trace)).toContain("providerNamesUsedForTraining");
  });
});

function supportedGraph(input: { claim?: string; actions?: DialogueAnswerGraphLike["actions"] } = {}): DialogueAnswerGraphLike {
  const claim = input.claim ?? "The pressure parser should preserve src/pump.ts and 17 ms.";
  return {
    id: "answer_graph.supported",
    claims: [{ id: "claim.main", surface: claim, certified: true }],
    supportLinks: [{ claimId: "claim.main", evidenceId: "evidence.main", sourceRef: { path: "docs/source.md", lineStart: 4 }, forceClass: "direct_evidence" }],
    caveats: [],
    actions: input.actions ?? [{ id: "action.main", affectedFiles: ["src/pump.ts"], evidenceSpanIds: ["evidence.main"] }],
    uncertainty: { unsupported: false, missingEvidenceCount: 0, contradictionCount: 0, gapCount: 0 }
  };
}

function minimalTurnResult(input: { answer: string; evidenceText: string }) {
  const evidence = [{
    id: "evidence.live" as never,
    sourceId: "source.live" as never,
    sourceVersionId: "source_version.live" as never,
    chunkId: "chunk.live" as never,
    contentHash: "content.live" as never,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: input.evidenceText.length,
    charStart: 0,
    charEnd: input.evidenceText.length,
    text: input.evidenceText,
    textPreview: input.evidenceText,
    languageHints: {},
    scriptHints: {},
    trustVector: {},
    provenance: { path: "docs/source.md", lineStart: 1 },
    features: [],
    status: "promoted" as const,
    alpha: 0.9,
    observedAt: 1
  }];
  return {
    episodeId: "episode.live" as never,
    answer: input.answer,
    epistemicForce: "source_bound" as const,
    assistantForce: "source_grounded_answer" as const,
    evidence,
    field: { seeds: [], active: [], ppf: [], causalMass: [], alphaTrace: { schema: "scce.alpha_trace.v1", id: "alpha.live", graphHash: "graph.live", score: 0, steps: [], diagnostics: {} } },
    entailment: { contradiction: 0 },
    constructGraph: { id: "construct.live" as never, episodeId: "episode.live" as never, forceVector: {}, nodes: [], edges: [], artifacts: [] },
    validationGraph: { id: "validation.live" as never, constructId: "construct.live" as never, checks: [], passed: true },
    emissionGraph: { id: "emission.live" as never, constructId: "construct.live" as never, answer: input.answer, epistemicForce: "source_bound" as const, assistantForce: "source_grounded_answer" as const, artifacts: [], evidenceIds: ["evidence.live" as never], proofId: "proof.live" as never },
    forecast: { id: "forecast.live", interval: { start: 0, end: 1 }, probability: 0.5, drivers: [], audit: {} },
    learningNeeds: [],
    scoreTraces: [],
    calibrationStatus: "uncalibrated" as const,
    truthState: "truth.source_bound_only" as const,
    evidenceForce: "direct_evidence" as const,
    guardFlags: [],
    events: []
  } as never;
}

function unsupportedGraph(): DialogueAnswerGraphLike {
  return {
    id: "answer_graph.unsupported",
    claims: [],
    supportLinks: [],
    caveats: [{ id: "caveat.missing", roleId: "answer_graph.role.missing_evidence", text: "Calibration owner is not recorded." }],
    actions: [],
    uncertainty: { unsupported: true, missingEvidenceCount: 1, contradictionCount: 0, gapCount: 1 }
  };
}
