// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CALIBRATION_IDS,
  CALIBRATION_TASK_CLASS_IDS,
  JUDGE_REQUIREMENT_QUALITY_KEYS,
  buildCalibrationModelSet,
  judgeRequirementObservation,
  judgeRequirementWeights,
  loadCalibrationModelSet,
  type JudgeRequirementQualityKey
} from "../calibration-spine.js";
import { createInMemoryDialogueMemoryStore } from "../dialogue-learning.js";
import { createJudge } from "../judge.js";
import type { CandidateField, CandidateQuality, CandidateSurface } from "../candidate.js";
import type { PolicyProfile, EvidenceId } from "../types.js";
import type { TurnRequirementField } from "../turn-requirements.js";

describe("judge requirement-weight learning", () => {
  it("with no calibration model, produces the exact 2026-07-12 bootstrap softmax weights (regression guard)", () => {
    const requirement = requirements({
      externalTruthAuthority: 0.8,
      sourceDependence: 0.6,
      noveltyDemand: 0.1,
      inferentialDepth: 0.3,
      semanticPreservation: 0.2,
      surfaceTransformation: 0.1,
      formatConstraintStrength: 0.2,
      audienceAdaptation: 0.3,
      causalReasoningDemand: 0.1
    });
    const truth = candidate("candidate.truth", { truthSupport: 1, sourceFidelity: 1 });
    const decision = createJudge().select({
      field: candidateField([truth]),
      policy: policy(),
      requirementField: requirement,
      deterministicReplay: true
    });
    const audit = decision.audit as { positiveWeights: Record<JudgeRequirementQualityKey, number> };
    const golden: Record<JudgeRequirementQualityKey, number> = {
      truthSupport: 0.1679638434407538,
      sourceFidelity: 0.11955167905827375,
      requirementCoverage: 0.050023792318845114,
      novelty: 0.034081296314195035,
      semanticPreservation: 0.04183564547211156,
      transformationQuality: 0.035472180402257525,
      inferentialContinuity: 0.05187042275585188,
      explanatoryPower: 0.042680781571532496,
      executableCompleteness: 0.027487977812361085,
      dialogueContinuity: 0.027487977812361085,
      languageQuality: 0.04162698931983184,
      usefulness: 0.03564998544645227,
      coherence: 0.05239172917127463,
      uncertaintyCalibration: 0.10550398646771422,
      formatFit: 0.041007244188695516,
      styleFit: 0.04141937384445318,
      directness: 0.04646729531695392,
      structure: 0.037477799286081186
    };
    for (const key of JUDGE_REQUIREMENT_QUALITY_KEYS) {
      expect(audit.positiveWeights[key]).toBeCloseTo(golden[key], 9);
    }
    expect(decision.requirementSnapshot?.learned).toBe(false);
    expect(decision.requirementSnapshot?.sampleCount).toBe(0);
  });

  it("fits a coefficient model whose truthSupport term rises when truthSupport strongly predicts real outcomes", () => {
    const observations = [];
    for (let i = 0; i < 60; i++) {
      const highTruthAuthority = i % 2 === 0;
      const requirement = requirements({ externalTruthAuthority: highTruthAuthority ? 0.9 : 0.1, noveltyDemand: 0.1 });
      const quality = qualityVector({ truthSupport: highTruthAuthority ? 0.95 : 0.15, novelty: 0.5 });
      // Outcome correlates with truthSupport, not with any other dimension -- the fit should move
      // truthSupport's coefficients, not novelty's, since novelty carries no real signal here.
      observations.push(judgeRequirementObservation({
        requirement,
        qualityPositive: quality,
        outcome: highTruthAuthority,
        sourceRecordId: `candidate.${i}`,
        createdAt: i
      }));
    }
    const modelSet = buildCalibrationModelSet({ observations, minPoints: 2, createdAt: 1_000 });
    const model = modelSet.judgeRequirementModels?.[CALIBRATION_TASK_CLASS_IDS.generalCognition];
    expect(model).toBeDefined();
    expect(model?.sampleCount).toBe(60);
    // The learned truthSupport.externalTruthAuthority slope should stay strongly positive -- the pattern in
    // the data reinforces the bootstrap's existing belief that truth authority should weight truthSupport.
    expect(model?.coefficients["truthSupport.externalTruthAuthority"]).toBeGreaterThan(1.5);

    const highWeights = judgeRequirementWeights({
      requirement: requirements({ externalTruthAuthority: 0.9, noveltyDemand: 0.1 }),
      modelSet,
      blendTargetSamples: 60
    });
    expect(highWeights.learned).toBe(true);
    expect(highWeights.blend).toBeCloseTo(1, 5);
    expect(highWeights.sampleCount).toBe(60);
  });

  it("round-trips judge-requirement observations through a real store via loadCalibrationModelSet", async () => {
    const store = createInMemoryDialogueMemoryStore();
    for (let i = 0; i < 30; i++) {
      const requirement = requirements({ inferentialDepth: i % 2 === 0 ? 0.9 : 0.1 });
      const quality = qualityVector({ coherence: i % 2 === 0 ? 0.9 : 0.2 });
      await store.putCalibrationObservation(judgeRequirementObservation({
        requirement,
        qualityPositive: quality,
        outcome: i % 2 === 0,
        sourceRecordId: `candidate.round-trip.${i}`,
        createdAt: i
      }));
    }
    const reloaded = await loadCalibrationModelSet({ store, minPoints: 2, createdAt: 2_000 });
    const model = reloaded.judgeRequirementModels?.[CALIBRATION_TASK_CLASS_IDS.generalCognition];
    expect(model?.sampleCount).toBe(30);
    expect(model?.modelHash).toMatch(/^[0-9a-f]{8}$/u);
    const persisted = await store.listCalibrationObservations({ calibrationId: CALIBRATION_IDS.judgeRequirementWeights, limit: 100 });
    expect(persisted).toHaveLength(30);
  });

  it("judge.select threads requirementSnapshot only through the requirement-field path", () => {
    const truth = candidate("candidate.plain", { truthSupport: 0.7 });
    const decision = createJudge().select({
      field: candidateField([truth]),
      policy: policy()
    });
    expect(decision.requirementSnapshot).toBeUndefined();
  });
});

function qualityVector(patch: Partial<Record<JudgeRequirementQualityKey, number>>): Record<JudgeRequirementQualityKey, number> {
  const base: Record<JudgeRequirementQualityKey, number> = Object.fromEntries(
    JUDGE_REQUIREMENT_QUALITY_KEYS.map(key => [key, 0.5])
  ) as Record<JudgeRequirementQualityKey, number>;
  return { ...base, ...patch };
}

function candidate(id: string, qualityPatch: Partial<CandidateQuality> = {}): CandidateSurface {
  const quality: CandidateQuality = {
    requirementCoverage: 0.5,
    truthSupport: 0.5,
    sourceFidelity: 0.5,
    novelty: 0.5,
    semanticPreservation: 0.5,
    transformationQuality: 0.5,
    inferentialContinuity: 0.5,
    explanatoryPower: 0.5,
    executableCompleteness: 0.5,
    dialogueContinuity: 0.5,
    languageQuality: 0.5,
    usefulness: 0.5,
    coherence: 0.5,
    uncertaintyCalibration: 0.5,
    formatFit: 0.5,
    styleFit: 0.5,
    directness: 0.5,
    structure: 0.5,
    repetition: 0,
    contradiction: 0,
    unsupportedFactRate: 0,
    fakeFactualAuthority: 0,
    staleSourceRisk: 0,
    testWeakening: 0,
    telemetryLeak: 0,
    ...qualityPatch
  };
  return {
    id,
    kind: "proof-answer",
    force: "observed",
    answer: `answer for ${id}`,
    evidenceIds: [] as EvidenceId[],
    claimBases: ["direct_evidence"],
    boundaries: [],
    quality,
    scores: {
      support: 0.5,
      faithfulness: 0.5,
      evidenceCoverage: 0.5,
      novelty: quality.novelty,
      realizability: 0.5,
      actionability: 0.5,
      alphaPressure: 0.5,
      contradiction: quality.contradiction,
      constraintCoverage: 0.5,
      graphCoherence: 0.5,
      languageRealizability: 0.5,
      usefulness: 0.5,
      unsupportedFactualAssertion: 0,
      repetition: 0,
      risk: 0
    },
    audit: {}
  } as unknown as CandidateSurface;
}

function candidateField(candidates: CandidateSurface[]): CandidateField {
  return {
    candidates,
    surfaceMass: candidates.map(item => ({ candidateId: item.id, mass: 1 / candidates.length, reason: "fixture" })),
    audit: {},
    scoreTrace: []
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

function requirements(patch: Partial<Omit<TurnRequirementField,
  | "requiredFeatures"
  | "prohibitedFeatures"
  | "activatedFrameIds"
  | "activatedPatternIds"
  | "activatedPhraseUnitIds"
  | "activatedDialogueMoveIds"
  | "activatedConstructIds"
  | "trace"
>> = {}): TurnRequirementField {
  return {
    externalTruthAuthority: 0,
    sourceDependence: 0,
    noveltyDemand: 0,
    inferentialDepth: 0,
    semanticPreservation: 0,
    surfaceTransformation: 0,
    executableArtifactDemand: 0,
    actionCommitment: 0,
    dialogueDependence: 0,
    uncertaintyTolerance: 0.5,
    formatConstraintStrength: 0,
    audienceAdaptation: 0,
    brevityDetailBalance: 0.5,
    temporalReasoningDemand: 0,
    causalReasoningDemand: 0,
    counterfactualDemand: 0,
    requiredFeatures: [],
    prohibitedFeatures: [],
    activatedFrameIds: [],
    activatedPatternIds: [],
    activatedPhraseUnitIds: [],
    activatedDialogueMoveIds: [],
    activatedConstructIds: [],
    confidence: 1,
    trace: {},
    ...patch
  };
}
