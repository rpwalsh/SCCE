import { describe, expect, it } from "vitest";
import { assistantForceDecision } from "../assistant-force.js";
import {
  CALIBRATION_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  CREATIVE_PREFERENCE_FEATURE_SCHEMA,
  buildCalibrationModelSet,
  calibrationModelFor,
  creativePreferenceObservationPair,
  creativePreferenceScore,
  loadCalibrationModelSet,
  type CreativePreferenceFeatureVector
} from "../calibration-spine.js";
import { createCandidateEngine, type CandidateField } from "../candidate.js";
import {
  createInMemoryDialogueMemoryStore,
  persistDialogueOutcomeAndLearn,
  persistDialogueOutcomeFromMemory,
  persistDialogueTurn
} from "../dialogue-learning.js";
import { realizeDialogueResponse, type DialogueAnswerGraphLike } from "../dialogue-pragmatics.js";
import { createJudge } from "../judge.js";
import { createInventionConstruct, type InventionConstruct } from "../prediction.js";
import { toJsonValue } from "../primitives.js";
import type {
  AlphaTrace,
  ClaimId,
  EvidenceId,
  EvidenceSpan,
  FieldState,
  MatrixSnapshot,
  PolicyProfile,
  ProofId,
  SemanticEntailmentResult
} from "../types.js";
import type { CcrResult } from "../ccr.js";
import type { ChernoffResult, DavisKahanEnvelope, MinimumCoverResult, SubspaceDriftEntropy } from "../causal-math.js";

describe("creative candidate selection and preference calibration", () => {
  it("emits invented candidates without requiring evidence and retains only observed factual premises", () => {
    const engine = createCandidateEngine();
    const noBasis = invention("invention.no-basis", []);
    const noEvidenceResult = engine.generate({
      ...candidateFixture([]),
      requestedAuthority: "creative",
      inventionCandidates: [noBasis]
    });
    const ungrounded = noEvidenceResult.candidates.find(candidate => candidate.kind === "creative-candidate");
    expect(ungrounded).toBeDefined();
    expect(ungrounded?.force).toBe("invented");
    expect(ungrounded?.evidenceIds).toEqual([]);
    expect(ungrounded?.answer.trim().length).toBeGreaterThan(0);
    expect(JSON.stringify(ungrounded?.audit)).toContain('"generatedMaterialRequiresEvidence":false');

    const premise = evidence("evidence.premise");
    const generated = evidence("evidence.generated");
    const withBasis = invention("invention.with-basis", [String(premise.id), "evidence.not-observed"], [String(generated.id)]);
    const groundedResult = engine.generate({
      ...candidateFixture([premise, generated]),
      requestedAuthority: "creative",
      inventionCandidates: [withBasis]
    });
    const grounded = groundedResult.candidates.find(candidate => candidate.kind === "creative-candidate");
    expect(grounded?.evidenceIds).toEqual([premise.id]);
    expect(JSON.stringify(grounded?.audit)).toContain("evidence.not-observed");
    expect(JSON.stringify(grounded?.audit)).toContain("evidence.generated");
    expect(grounded?.scores.constraintCoverage).toBeCloseTo(0.94);
    expect(grounded?.scores.graphCoherence).toBeCloseTo(0.86);
  });

  it("lets an authority-fit invention outrank proof-boundary and learning candidates", () => {
    const fixture = candidateFixture([]);
    const field = createCandidateEngine().generate({
      ...fixture,
      requestedAuthority: "creative",
      inventionCandidates: [invention("invention.selectable", [])],
      learningNeeds: ["constraint.unresolved"]
    });
    expect(field.candidates.some(candidate => candidate.kind === "proof-answer")).toBe(true);
    expect(field.candidates.some(candidate => candidate.kind === "learning-plan")).toBe(true);
    const decision = createJudge().select({
      field,
      policy: policy(),
      requestedAuthority: "creative"
    });
    expect(decision.selected.kind).toBe("creative-candidate");
    expect(decision.selected.force).toBe("invented");
    expect(decision.scores.find(row => row.candidateId === decision.selected.id)?.reasons).toContain("creative-authority-fit");
  });

  it("keeps explicit creative and translation authority ahead of direct evidence while contradiction remains first", () => {
    const direct = "evidence.direct" as EvidenceId;
    expect(assistantForceDecision({
      requestedAuthority: "creative",
      epistemicForce: "observed",
      evidenceIds: [direct],
      directEvidenceIds: [direct],
      support: 0.92
    }).force).toBe("creative_answer");
    expect(assistantForceDecision({
      requestedAuthority: "translation",
      epistemicForce: "invented",
      outputForce: "creative",
      evidenceIds: [direct],
      directEvidenceIds: [direct]
    }).force).toBe("translation_answer");
    expect(assistantForceDecision({
      requestedAuthority: "creative",
      epistemicForce: "invented",
      contradiction: 0.9
    }).force).toBe("insufficient_support");
  });

  it("fits persisted accepted/rejected pairs with logistic preference loss and changes ranking", () => {
    const preferred: CreativePreferenceFeatureVector = {
      constraintCoverage: 0.2,
      graphCoherence: 0.2,
      novelty: 0.1,
      languageRealizability: 1,
      usefulness: 1,
      risk: 0,
      repetition: 0,
      unsupportedFactualAssertion: 0
    };
    const rejected: CreativePreferenceFeatureVector = {
      constraintCoverage: 1,
      graphCoherence: 1,
      novelty: 1,
      languageRealizability: 0,
      usefulness: 0,
      risk: 0,
      repetition: 0,
      unsupportedFactualAssertion: 0
    };
    const fallbackPreferred = creativePreferenceScore({ features: preferred }).score;
    const fallbackRejected = creativePreferenceScore({ features: rejected }).score;
    expect(fallbackPreferred).toBeLessThan(fallbackRejected);

    const observations = Array.from({ length: 16 }, (_, index) => creativePreferenceObservationPair({
      pairId: `preference.${index}`,
      preferred: { candidateId: "candidate.preferred", features: preferred },
      rejected: { candidateId: "candidate.rejected", features: rejected },
      sourceTraceId: `trace.${index}`,
      sourceRecordId: `outcome.${index}`,
      createdAt: 100 + index
    })).flat();
    const modelSet = buildCalibrationModelSet({ observations, minPoints: 2, createdAt: 500 });
    const model = modelSet.creativePreferenceModels?.[CALIBRATION_TASK_CLASS_IDS.creativeGeneration];
    expect(model).toBeDefined();
    expect(model?.featureSchemaId).toBe(CREATIVE_PREFERENCE_FEATURE_SCHEMA.id);
    expect(model?.featureIds).toEqual(CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds);
    expect(model?.pairCount).toBe(16);
    expect(model?.trainingRecordIds).toHaveLength(32);
    expect(model?.modelHash).toMatch(/^[0-9a-f]{8}$/u);
    expect(model?.id).toContain(model?.modelHash ?? "missing");
    expect(model?.trainingLoss).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(observations[0]?.metadata)).toContain(CREATIVE_PREFERENCE_FEATURE_SCHEMA.id);

    const learnedPreferred = creativePreferenceScore({
      features: preferred,
      modelSet,
      taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration
    });
    const learnedRejected = creativePreferenceScore({
      features: rejected,
      modelSet,
      taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration
    });
    expect(learnedPreferred.source).toBe("pairwise_preference");
    expect(learnedPreferred.score).toBeGreaterThan(learnedRejected.score);
  });

  it("does not borrow a scalar calibration model from another task for creative generation", () => {
    const modelSet = buildCalibrationModelSet({
      observations: [],
      createdAt: 1
    });
    modelSet.models[`${CALIBRATION_IDS.candidateMass}|${CALIBRATION_TASK_CLASS_IDS.sourceBoundQa}`] = {
      id: "calibration.source-only",
      taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
      bins: [{ lower: 0, upper: 1, confidence: 0.5, empirical: 0.5 }],
      createdAt: 1
    };
    expect(calibrationModelFor({
      modelSet,
      calibrationId: CALIBRATION_IDS.candidateMass,
      taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration
    })).toBeUndefined();
  });

  it("persists dialogue preference pairs and reloads them to change later creative candidate ranking", async () => {
    const preferred: CreativePreferenceFeatureVector = {
      constraintCoverage: 0.2,
      graphCoherence: 0.2,
      novelty: 0.1,
      languageRealizability: 1,
      usefulness: 1,
      risk: 0,
      repetition: 0,
      unsupportedFactualAssertion: 0
    };
    const rejected: CreativePreferenceFeatureVector = {
      constraintCoverage: 1,
      graphCoherence: 1,
      novelty: 1,
      languageRealizability: 0,
      usefulness: 0,
      risk: 0,
      repetition: 0,
      unsupportedFactualAssertion: 0
    };
    const store = createInMemoryDialogueMemoryStore();
    const dialogue = realizeDialogueResponse({
      requestText: "Create a bounded graph transform subject to the active constraints.",
      answerGraph: unsupportedDialogueGraph()
    });
    for (let index = 0; index < 16; index++) {
      const learned = await persistDialogueOutcomeAndLearn({
        store,
        result: dialogue,
        promptText: "Create a bounded graph transform subject to the active constraints.",
        accepted: true,
        taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
        creativePreferencePair: {
          pairId: `creative.feedback.${index}`,
          preferred: { candidateId: "candidate.preferred", features: preferred },
          rejected: { candidateId: "candidate.rejected", features: rejected }
        },
        now: 1_000 + index
      });
      expect(learned.calibrationObservations.filter(row => row.calibrationId === CALIBRATION_IDS.creativeCandidatePreference)).toHaveLength(2);
    }
    const persisted = await store.listCalibrationObservations({
      calibrationId: CALIBRATION_IDS.creativeCandidatePreference,
      taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
      limit: 100
    });
    expect(persisted).toHaveLength(32);
    expect(new Set(persisted.map(row => row.sourceRecordId)).size).toBe(16);

    const reloadedModels = await loadCalibrationModelSet({ store, minPoints: 2, createdAt: 2_000 });
    const preferenceModel = reloadedModels.creativePreferenceModels?.[CALIBRATION_TASK_CLASS_IDS.creativeGeneration];
    expect(preferenceModel?.pairCount).toBe(16);
    expect(preferenceModel?.trainingRecordIds).toHaveLength(32);
    expect(preferenceModel?.modelHash).toMatch(/^[0-9a-f]{8}$/u);
    const modelSnapshots = await store.listCalibrationObservations({
      calibrationId: CALIBRATION_IDS.creativeCandidatePreferenceModel,
      taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
      limit: 100
    });
    expect(modelSnapshots).toHaveLength(15);
    const latestSnapshot = modelSnapshots[0];
    const snapshotMetadata = latestSnapshot?.metadata as Record<string, unknown> | undefined;
    expect(latestSnapshot?.selectedOutputHash).toBe(preferenceModel?.modelHash);
    expect(snapshotMetadata?.featureSchemaId).toBe(CREATIVE_PREFERENCE_FEATURE_SCHEMA.id);
    expect(snapshotMetadata?.modelHash).toBe(preferenceModel?.modelHash);
    expect(Object.keys(snapshotMetadata?.coefficients as object)).toEqual(expect.arrayContaining([...CREATIVE_PREFERENCE_FEATURE_SCHEMA.featureIds]));
    expect(snapshotMetadata?.trainingRecordIds).toHaveLength(32);

    const preferredConstruct = invention("invention.preference.preferred", [], [], preferred);
    const rejectedConstruct = invention("invention.preference.rejected", [], [], rejected);
    const engine = createCandidateEngine();
    const fixture = candidateFixture([]);
    const before = engine.generate({
      ...fixture,
      requestedAuthority: "creative",
      inventionCandidates: [preferredConstruct, rejectedConstruct]
    });
    const after = engine.generate({
      ...fixture,
      requestedAuthority: "creative",
      inventionCandidates: [preferredConstruct, rejectedConstruct],
      calibrationModels: reloadedModels,
      calibrationTaskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration
    });
    const beforePreferred = candidateMassFor(before, `creative:${preferredConstruct.id}:0`);
    const beforeRejected = candidateMassFor(before, `creative:${rejectedConstruct.id}:1`);
    const afterPreferred = candidateMassFor(after, `creative:${preferredConstruct.id}:0`);
    const afterRejected = candidateMassFor(after, `creative:${rejectedConstruct.id}:1`);
    expect(beforePreferred).toBeLessThan(beforeRejected);
    expect(afterPreferred).toBeGreaterThan(afterRejected);
  });

  it("threads corrected/original creative preferences through persisted dialogue replay", async () => {
    const store = createInMemoryDialogueMemoryStore();
    const dialogue = realizeDialogueResponse({
      requestText: "Create a bounded graph transform subject to the active constraints.",
      answerGraph: unsupportedDialogueGraph()
    });
    await persistDialogueTurn({ store, result: dialogue, now: 3_000 });
    const features = preferenceFeaturePair();
    const learned = await persistDialogueOutcomeFromMemory({
      store,
      conversationId: dialogue.state.conversationId,
      turnId: dialogue.state.turnId,
      promptText: "Create a bounded graph transform subject to the active constraints.",
      corrected: true,
      correctionText: "Prefer the more useful bounded composition.",
      taskClass: CALIBRATION_TASK_CLASS_IDS.creativeGeneration,
      creativePreferencePair: {
        pairId: "creative.corrected",
        preferenceKind: "corrected_original",
        preferred: { candidateId: "candidate.corrected", features: features.preferred },
        rejected: { candidateId: "candidate.original", features: features.rejected }
      },
      now: 3_001
    });
    expect(learned.replay.result.selected.candidateId).toBe(dialogue.selected.candidateId);
    const pairRows = learned.calibrationObservations.filter(row => row.calibrationId === CALIBRATION_IDS.creativeCandidatePreference);
    expect(pairRows).toHaveLength(2);
    expect(JSON.stringify(pairRows.map(row => row.metadata))).toContain("corrected_original");
  });
});

function invention(
  id: string,
  basisEvidenceIds: string[],
  nonFactualBasisIds: string[] = [],
  metrics: CreativePreferenceFeatureVector = {
    constraintCoverage: 0.94,
    graphCoherence: 0.86,
    novelty: 0.9,
    languageRealizability: 0.88,
    usefulness: 0.91,
    risk: 0.08,
    repetition: 0.04,
    unsupportedFactualAssertion: 0
  }
): InventionConstruct {
  const base = createInventionConstruct({
    id,
    title: `design.${id}`,
    proposalSurface: `Compose ${id} as a bounded graph transform with an inspectable validation stage.`,
    artifactKindIds: ["artifact.algorithm"],
    basisEvidenceIds: [...basisEvidenceIds, ...nonFactualBasisIds],
    basisPriorIds: ["prior.graph-transform"],
    noveltyScore: metrics.novelty,
    supportScore: metrics.graphCoherence,
    riskScore: metrics.risk
  });
  return {
    ...base,
    trace: toJsonValue({
      ...metrics,
      bootstrapScore: creativePreferenceScore({ features: metrics }).score,
      claimBasis: [
        { id: "claim.generated", kind: "invention", force: "invented", evidenceIds: nonFactualBasisIds },
        { id: "claim.premise", kind: "factual_premise", force: "observed", evidenceIds: basisEvidenceIds }
      ]
    })
  };
}

function candidateMassFor(field: CandidateField, candidateId: string): number {
  const row = field.surfaceMass.find(item => item.candidateId === candidateId);
  if (!row) throw new Error(`missing candidate mass: ${candidateId}`);
  return row.mass;
}

function unsupportedDialogueGraph(): DialogueAnswerGraphLike {
  return {
    id: "answer_graph.creative_feedback",
    claims: [],
    supportLinks: [],
    caveats: [{ id: "caveat.creative", text: "No factual claim is requested." }],
    actions: [],
    uncertainty: { unsupported: true, missingEvidenceCount: 0, contradictionCount: 0, gapCount: 0 }
  };
}

function preferenceFeaturePair(): { preferred: CreativePreferenceFeatureVector; rejected: CreativePreferenceFeatureVector } {
  return {
    preferred: {
      constraintCoverage: 0.4,
      graphCoherence: 0.5,
      novelty: 0.4,
      languageRealizability: 0.9,
      usefulness: 0.9,
      risk: 0.05,
      repetition: 0.05,
      unsupportedFactualAssertion: 0
    },
    rejected: {
      constraintCoverage: 0.8,
      graphCoherence: 0.7,
      novelty: 0.8,
      languageRealizability: 0.2,
      usefulness: 0.2,
      risk: 0.1,
      repetition: 0.2,
      unsupportedFactualAssertion: 0
    }
  };
}

function evidence(id: string): EvidenceSpan {
  return {
    id: id as EvidenceId,
    sourceId: "source.fixture" as EvidenceSpan["sourceId"],
    sourceVersionId: "source-version.fixture" as EvidenceSpan["sourceVersionId"],
    chunkId: "chunk.fixture" as EvidenceSpan["chunkId"],
    contentHash: "hash.fixture" as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: 7,
    charStart: 0,
    charEnd: 7,
    text: "premise",
    textPreview: "premise",
    languageHints: {},
    scriptHints: {},
    trustVector: {},
    provenance: {},
    features: ["premise"],
    status: "promoted",
    alpha: 0.8,
    observedAt: 1
  };
}

function candidateFixture(evidenceRows: EvidenceSpan[]) {
  const evidenceIds = evidenceRows.map(row => row.id);
  const proof: SemanticEntailmentResult["proof"] = {
    id: "proof.creative-fixture" as ProofId,
    claimId: "claim.creative-fixture" as ClaimId,
    verdict: evidenceIds.length ? "observed" : "unknown",
    confidence: {},
    proofGraph: { nodes: [], edges: [] },
    evidenceIds,
    transformIds: [],
    scores: {},
    validatorVersion: "fixture",
    createdAt: 1
  };
  const support = evidenceIds.length ? 0.62 : 0.04;
  const entailment: SemanticEntailmentResult = {
    verdict: evidenceIds.length ? "entailed" : "unknown",
    semanticVerdict: evidenceIds.length ? "entailed" : "unknown",
    force: evidenceIds.length ? "observed" : "unknown",
    support,
    contradiction: 0,
    faithfulnessLcb: evidenceIds.length ? 0.7 : 0.05,
    confidence: {
      verdict: evidenceIds.length ? "entailed" : "unknown",
      support,
      contradiction: 0,
      faithfulnessLcb: evidenceIds.length ? 0.7 : 0.05,
      supportingEvidence: evidenceIds.length,
      sourceVersions: [],
      structuralCoverage: 0.2,
      roleCoverage: 0.2,
      relationCompatibility: 0.2,
      transformationSupport: 0.2,
      causalMass: 0,
      stability: 0.5,
      satisfiedObligations: 0,
      requiredObligations: 1
    },
    scores: {
      structuralCoverage: 0.2,
      roleCoverage: 0.2,
      relationCompatibility: 0.2,
      transformationSupport: 0.2,
      causalMass: 0,
      faithfulnessLCB: evidenceIds.length ? 0.7 : 0.05,
      contradiction: 0,
      stability: 0.5
    },
    obligations: [],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    evidenceIds,
    boundaries: evidenceIds.length ? [] : ["proof-boundary"],
    claim: { id: "claim.creative-fixture" as ClaimId, text: "fixture", normalized: "fixture", features: [], polarity: 1 },
    proof
  };
  return {
    requestText: "Create a bounded graph transform subject to the active constraints.",
    entailment,
    evidence: evidenceRows,
    field: field(),
    ccr: ccr(),
    proofAnswer: evidenceIds.length ? "The premise is observed." : "No certified answer is available.",
    learningNeeds: [] as string[]
  };
}

function field(): FieldState {
  const matrix: MatrixSnapshot = { nodes: [], values: [] };
  const alphaTrace: AlphaTrace = {
    alpha: 0.5,
    thresholds: { virtual: 0.1, visible: 0.2, bonded: 0.5, structural: 0.8 },
    relations: [],
    adjacency: matrix,
    laplacian: matrix,
    normalizedLaplacian: matrix,
    surfaces: { pressure: 0.5, actionability: 0.6, drift: 0.4, risk: 0.1, contradiction: 0, bond: 0.3 },
    contradictionMass: 0,
    bondedLeakage: 0
  };
  return { requestFeatures: [], seeds: [], active: [], ppf: [], causalMass: [], alphaTrace };
}

function ccr(): CcrResult {
  const davisKahan: DavisKahanEnvelope = { perturbationNorm: 0, spectralGap: 1, sinTheta: 0, stable: true, reason: "fixture" };
  const chernoff: ChernoffResult = { information: 0, tStar: 0.5, affinity: 1, iterations: 0 };
  const sde: SubspaceDriftEntropy = { drift: 0, entropy: 0, margin: 1, converged: true, adversarialPlateau: false, reason: "fixture" };
  const minimumCover: MinimumCoverResult = { selectedEvidenceIds: [], selectedFeatures: [], coverage: 0, codeLength: 0, uncoveredFeatures: [], audit: {} };
  return {
    l1: { candidates: [], queryFeatures: [], audit: {} },
    l2: { survivors: [], prunedEdges: 0, davisKahan, chernoff, sde, minimumCover, audit: {} },
    l3: { sentences: [], answer: "", abstentions: [], audit: {} },
    accepted: false,
    audit: {}
  };
}

function policy(): PolicyProfile {
  return {
    allowMutation: false,
    requireTwoPhaseCommit: true,
    dryRunByDefault: true,
    maxNetworkRequests: 0,
    maxToolCalls: 0,
    maxSpendCents: 0,
    alphaRiskCeiling: 0.5,
    encryptSecretsAtRest: true
  };
}
