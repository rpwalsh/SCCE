import { describe, expect, it } from "vitest";
import { buildCalibrationModel, calibrateProbability, calibratedScoreTrace } from "./calibration.js";
import { evaluateCalibration } from "./evaluation.js";
import { createCandidateEngine } from "../candidate.js";
import { CALIBRATION_IDS, CALIBRATION_TASK_CLASS_IDS, type CalibrationModelSet } from "../calibration-spine.js";
import type { SemanticEntailmentResult, FieldState, AlphaTrace, MatrixSnapshot } from "../types.js";
import type { CcrResult } from "../ccr.js";
import type { DavisKahanEnvelope, ChernoffResult, SubspaceDriftEntropy, MinimumCoverResult } from "../causal-math.js";

describe("scoring calibration harness", () => {
  it("builds calibration bins and maps raw probabilities", () => {
    const model = buildCalibrationModel({
      id: "cal.answer.v1",
      taskClass: "answer",
      points: [
        { raw: 0.1, outcome: false },
        { raw: 0.2, outcome: false },
        { raw: 0.8, outcome: true },
        { raw: 0.9, outcome: true }
      ],
      binCount: 4,
      createdAt: 1
    });
    const calibrated = calibrateProbability(0.85, model);
    expect(calibrated).toBeGreaterThan(0.5);
    const trace = calibratedScoreTrace({
      raw: 0.85,
      model,
      meaning: "answer correctness probability",
      provenance: ["calibration.test"],
      inputs: ["raw_score"]
    });
    expect(trace.kind).toBe("calibrated_probability");
    expect(trace.calibrationId).toBe("cal.answer.v1");
  });

  it("computes brier/nll/ece metrics", () => {
    const metrics = evaluateCalibration([
      { predicted: 0.9, actual: true },
      { predicted: 0.8, actual: true },
      { predicted: 0.2, actual: false },
      { predicted: 0.1, actual: false }
    ]);
    expect(metrics.sampleCount).toBe(4);
    expect(metrics.brier).toBeLessThan(0.2);
    expect(metrics.nll).toBeGreaterThan(0);
    expect(metrics.ece).toBeLessThan(0.2);
  });

  it("wires calibration model into candidate engine generate() and emits calibrated score traces (PR-9)", () => {
    const model = buildCalibrationModel({
      id: "cal.candidate.v1",
      taskClass: "candidate_selection",
      points: [
        { raw: 0.15, outcome: false },
        { raw: 0.35, outcome: false },
        { raw: 0.65, outcome: true },
        { raw: 0.85, outcome: true },
        { raw: 0.9, outcome: true }
      ],
      binCount: 5,
      createdAt: 1
    });
    const engine = createCandidateEngine();
    const emptyProof: SemanticEntailmentResult["proof"] = {
      id: "proof.pr9-test" as import("../types.js").ProofId,
      claimId: "claim.pr9" as import("../types.js").ClaimId,
      verdict: "inferred",
      confidence: {},
      proofGraph: { nodes: [], edges: [] },
      evidenceIds: [],
      transformIds: [],
      scores: {},
      validatorVersion: "fixture",
      createdAt: 1
    };
    const fakeEntailment: SemanticEntailmentResult = {
      verdict: "entailed",
      semanticVerdict: "entailed",
      force: "inferred",
      support: 0.72,
      contradiction: 0.05,
      faithfulnessLcb: 0.65,
      confidence: {
        verdict: "entailed", support: 0.72, contradiction: 0.05, faithfulnessLcb: 0.65,
        supportingEvidence: 1, sourceVersions: [], structuralCoverage: 0.7, roleCoverage: 0.7,
        relationCompatibility: 0.7, transformationSupport: 0.7, causalMass: 0.5, stability: 0.8,
        satisfiedObligations: 1, requiredObligations: 1
      },
      scores: {
        structuralCoverage: 0.7, roleCoverage: 0.7, relationCompatibility: 0.7,
        transformationSupport: 0.7, causalMass: 0.5, faithfulnessLCB: 0.65,
        contradiction: 0.05, stability: 0.8
      },
      obligations: [],
      mappings: [],
      transforms: [],
      counterexamples: [],
      missing: [],
      evidenceIds: [],
      boundaries: [],
      claim: { id: "claim.pr9" as import("../types.js").ClaimId, text: "pr9", normalized: "pr9", features: [], polarity: 1 },
      proof: emptyProof
    };
    const emptyDavisKahan: DavisKahanEnvelope = { perturbationNorm: 0, spectralGap: 1, sinTheta: 0, stable: true, reason: "fixture" };
    const emptyChernoff: ChernoffResult = { information: 0, tStar: 0.5, affinity: 1, iterations: 0 };
    const emptySde: SubspaceDriftEntropy = { drift: 0, entropy: 0, margin: 1, converged: true, adversarialPlateau: false, reason: "fixture" };
    const emptyMinCover: MinimumCoverResult = { selectedEvidenceIds: [], selectedFeatures: [], coverage: 1, codeLength: 0, uncoveredFeatures: [], audit: {} };
    const fakeCcr: CcrResult = {
      l1: { candidates: [], queryFeatures: [], audit: {} },
      l2: { survivors: [], prunedEdges: 0, davisKahan: emptyDavisKahan, chernoff: emptyChernoff, sde: emptySde, minimumCover: emptyMinCover, audit: {} },
      l3: { sentences: [], answer: "", abstentions: [], audit: {} },
      accepted: false,
      audit: {}
    };
    const emptyMatrix: MatrixSnapshot = { nodes: [], values: [] };
    const fakeAlphaTrace: AlphaTrace = {
      alpha: 0.5,
      thresholds: { virtual: 0.1, visible: 0.2, bonded: 0.5, structural: 0.8 },
      relations: [],
      adjacency: emptyMatrix,
      laplacian: emptyMatrix,
      normalizedLaplacian: emptyMatrix,
      surfaces: { pressure: 0.5, actionability: 0.5, drift: 0.2, risk: 0.1, contradiction: 0.05, bond: 0.3 },
      contradictionMass: 0.05,
      bondedLeakage: 0.02
    };
    const field: FieldState = {
      requestFeatures: [],
      seeds: [],
      active: [],
      ppf: [],
      causalMass: [],
      alphaTrace: fakeAlphaTrace
    };
    const result = engine.generate({
      requestText: "test query for calibration wiring",
      entailment: fakeEntailment,
      evidence: [],
      field,
      ccr: fakeCcr,
      proofAnswer: "calibrated test answer",
      learningNeeds: [],
      calibrationModel: model
    });
    const calibratedTraces = result.scoreTrace.filter(t => t.kind === "calibrated_probability");
    expect(calibratedTraces.length).toBeGreaterThan(0);
    expect(calibratedTraces.every(t => t.calibrationId === "cal.candidate.v1")).toBe(true);
    expect(calibratedTraces.every(t => t.value >= 0 && t.value <= 1)).toBe(true);
  });

  it("uses calibration model sets as active candidate mass, not only traces", () => {
    const engine = createCandidateEngine();
    const fixture = candidateFixture();
    const modelSet: CalibrationModelSet = {
      schema: "scce.calibration.model_set.v1",
      id: "calibration.model_set.fixture",
      observationCount: 8,
      createdAt: 1,
      models: {
        [`${CALIBRATION_IDS.candidateMass}|${CALIBRATION_TASK_CLASS_IDS.sourceBoundQa}`]: {
          id: "cal.candidate.mass.fixture",
          taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
          createdAt: 1,
          bins: [
            { lower: 0, upper: 1, confidence: 0.5, empirical: 0.25 }
          ]
        }
      }
    };
    const uncalibrated = engine.generate({ ...fixture });
    const calibrated = engine.generate({ ...fixture, calibrationModels: modelSet, calibrationTaskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa });
    expect(calibrated.surfaceMass.every(item => item.calibrated === true)).toBe(true);
    expect(calibrated.scoreTrace.some(trace => trace.kind === "calibrated_probability" && trace.calibrationId === "cal.candidate.mass.fixture")).toBe(true);
    expect(calibrated.surfaceMass.map(item => item.mass)).not.toEqual(uncalibrated.surfaceMass.map(item => item.mass));
  });
});

function candidateFixture() {
  const emptyProof: SemanticEntailmentResult["proof"] = {
    id: "proof.fixture" as import("../types.js").ProofId,
    claimId: "claim.fixture" as import("../types.js").ClaimId,
    verdict: "inferred",
    confidence: {},
    proofGraph: { nodes: [], edges: [] },
    evidenceIds: [],
    transformIds: [],
    scores: {},
    validatorVersion: "fixture",
    createdAt: 1
  };
  const fakeEntailment: SemanticEntailmentResult = {
    verdict: "entailed",
    semanticVerdict: "entailed",
    force: "inferred",
    support: 0.72,
    contradiction: 0.05,
    faithfulnessLcb: 0.65,
    confidence: {
      verdict: "entailed", support: 0.72, contradiction: 0.05, faithfulnessLcb: 0.65,
      supportingEvidence: 1, sourceVersions: [], structuralCoverage: 0.7, roleCoverage: 0.7,
      relationCompatibility: 0.7, transformationSupport: 0.7, causalMass: 0.5, stability: 0.8,
      satisfiedObligations: 1, requiredObligations: 1
    },
    scores: {
      structuralCoverage: 0.7, roleCoverage: 0.7, relationCompatibility: 0.7,
      transformationSupport: 0.7, causalMass: 0.5, faithfulnessLCB: 0.65,
      contradiction: 0.05, stability: 0.8
    },
    obligations: [],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    evidenceIds: [],
    boundaries: [],
    claim: { id: "claim.fixture" as import("../types.js").ClaimId, text: "fixture", normalized: "fixture", features: [], polarity: 1 },
    proof: emptyProof
  };
  const emptyDavisKahan: DavisKahanEnvelope = { perturbationNorm: 0, spectralGap: 1, sinTheta: 0, stable: true, reason: "fixture" };
  const emptyChernoff: ChernoffResult = { information: 0, tStar: 0.5, affinity: 1, iterations: 0 };
  const emptySde: SubspaceDriftEntropy = { drift: 0, entropy: 0, margin: 1, converged: true, adversarialPlateau: false, reason: "fixture" };
  const emptyMinCover: MinimumCoverResult = { selectedEvidenceIds: [], selectedFeatures: [], coverage: 1, codeLength: 0, uncoveredFeatures: [], audit: {} };
  const fakeCcr: CcrResult = {
    l1: { candidates: [], queryFeatures: [], audit: {} },
    l2: { survivors: [], prunedEdges: 0, davisKahan: emptyDavisKahan, chernoff: emptyChernoff, sde: emptySde, minimumCover: emptyMinCover, audit: {} },
    l3: { sentences: [], answer: "", abstentions: [], audit: {} },
    accepted: false,
    audit: {}
  };
  const emptyMatrix: MatrixSnapshot = { nodes: [], values: [] };
  const fakeAlphaTrace: AlphaTrace = {
    alpha: 0.5,
    thresholds: { virtual: 0.1, visible: 0.2, bonded: 0.5, structural: 0.8 },
    relations: [],
    adjacency: emptyMatrix,
    laplacian: emptyMatrix,
    normalizedLaplacian: emptyMatrix,
    surfaces: { pressure: 0.5, actionability: 0.5, drift: 0.2, risk: 0.1, contradiction: 0.05, bond: 0.3 },
    contradictionMass: 0.05,
    bondedLeakage: 0.02
  };
  const field: FieldState = {
    requestFeatures: [],
    seeds: [],
    active: [],
    ppf: [],
    causalMass: [],
    alphaTrace: fakeAlphaTrace
  };
  return {
    requestText: "test query for calibration wiring",
    entailment: fakeEntailment,
    evidence: [],
    field,
    ccr: fakeCcr,
    proofAnswer: "calibrated test answer",
    learningNeeds: []
  };
}
