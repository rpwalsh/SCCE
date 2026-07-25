import { describe, expect, it } from "vitest";
import {
  POLICY_OBJECTIVE_SCHEMA_ID,
  aggregateGenome,
  policyFingerprint,
  policyGenomeFromDurable,
  policyObjectiveVector,
  type DurablePolicyGenome,
  type PolicyEvaluation
} from "../policy-evolution.js";
import { createFunctionalCognitionEngine } from "../functional-cognition.js";
import { DEFAULT_POLICY } from "../safety.js";
import type { FunctionalSelfState, GraphSlice, InformationLabel, ModelState, PolicyProfile } from "../types.js";

describe("policyObjectiveVector", () => {
  it("inverts bad-thing rates so every dimension is maximization-oriented", () => {
    const vector = policyObjectiveVector({
      evidenceCoverage: 0.8,
      governanceSuccessRate: 0.9,
      contradictionRate: 0.2,
      rollbackRate: 0.1,
      taskSuccessRate: 0.7
    });
    expect(vector).toEqual([0.8, 0.9, 0.8, 0.9, 0.7]);
  });

  it("clamps out-of-range and non-finite inputs instead of propagating them", () => {
    const vector = policyObjectiveVector({
      evidenceCoverage: 1.4,
      governanceSuccessRate: -0.2,
      contradictionRate: Number.NaN,
      rollbackRate: 2,
      taskSuccessRate: 0.5
    });
    expect(vector[0]).toBe(1);
    expect(vector[1]).toBe(0);
    expect(vector[2]).toBe(0); // 1 - NaN is NaN, and a non-finite result clamps to the conservative worst case (0), not a fabricated "fully safe" 1
    expect(vector[3]).toBe(0); // 1 - clamp(2->1) = 0
  });
});

describe("policyFingerprint", () => {
  it("is deterministic for the same policy fields", () => {
    expect(policyFingerprint(DEFAULT_POLICY)).toBe(policyFingerprint({ ...DEFAULT_POLICY }));
  });

  it("differs when any real field differs", () => {
    const variant: PolicyProfile = { ...DEFAULT_POLICY, alphaRiskCeiling: DEFAULT_POLICY.alphaRiskCeiling - 0.1 };
    expect(policyFingerprint(DEFAULT_POLICY)).not.toBe(policyFingerprint(variant));
  });
});

describe("aggregateGenome", () => {
  it("seeds a new genome from the first evaluation", () => {
    const evaluation = fixtureEvaluation({ objectives: [0.8, 0.6] });
    const genome = aggregateGenome(undefined, evaluation);
    expect(genome.evaluationCount).toBe(1);
    expect(genome.aggregatedObjectives).toEqual([0.8, 0.6]);
    expect(genome.firstEvaluatedAt).toBe(evaluation.createdAt);
  });

  it("folds a second real evaluation into a running mean, not a replacement", () => {
    const first = aggregateGenome(undefined, fixtureEvaluation({ objectives: [1, 0], createdAt: 1_000 }));
    const second = aggregateGenome(first, fixtureEvaluation({ objectives: [0, 1], createdAt: 2_000 }));
    expect(second.evaluationCount).toBe(2);
    expect(second.aggregatedObjectives).toEqual([0.5, 0.5]);
    expect(second.firstEvaluatedAt).toBe(1_000);
    expect(second.lastEvaluatedAt).toBe(2_000);
  });

  it("only advances evaluationCount when a real evaluation is folded in, never implicitly", () => {
    const genome = aggregateGenome(undefined, fixtureEvaluation({ objectives: [0.5] }));
    expect(genome.evaluationCount).toBe(1);
    const foldedAgain = aggregateGenome(genome, fixtureEvaluation({ objectives: [0.5], createdAt: 2_000 }));
    expect(foldedAgain.evaluationCount).toBe(2);
  });
});

describe("policyGenomeFromDurable", () => {
  it("produces a PolicyGenome keyed by fingerprint+schema, carrying the real aggregated objectives", () => {
    const durable: DurablePolicyGenome = {
      policyFingerprint: "policy_abc",
      objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID,
      vector: { evidenceRequired: 0.8, riskTolerance: 0.3, citationStrictness: 0.7, approvalRequired: 0.6, autonomyLevel: 0.4 },
      aggregatedObjectives: [0.7, 0.8, 0.9, 0.6, 0.75],
      evaluationCount: 3,
      firstEvaluatedAt: 1_000,
      lastEvaluatedAt: 3_000,
      informationLabel: fixtureLabel()
    };
    const genome = policyGenomeFromDurable(durable);
    expect(genome.id).toBe("policy_abc:scce.policy-objectives.v1");
    expect(genome.objectives).toEqual(durable.aggregatedObjectives);
    expect(genome.vector).toEqual(durable.vector);
  });
});

describe("distinct-genome counting for Pareto availability (through the real engine)", () => {
  it("does not let two evaluations of one fingerprint count as two genomes", () => {
    const fingerprint = policyFingerprint(DEFAULT_POLICY);
    let genome: DurablePolicyGenome | undefined;
    genome = aggregateGenome(genome, fixtureEvaluation({ policyFingerprint: fingerprint, objectives: [0.6, 0.6, 0.6, 0.6, 0.6], createdAt: 1_000 }));
    genome = aggregateGenome(genome, fixtureEvaluation({ policyFingerprint: fingerprint, objectives: [0.7, 0.7, 0.7, 0.7, 0.7], createdAt: 2_000 }));

    // one fingerprint evaluated twice folds into exactly one genome record
    expect(genome.evaluationCount).toBe(2);

    const report = createFunctionalCognitionEngine().project({
      now: 3_000,
      self: selfState(),
      model: modelState(),
      graph: emptyGraph(),
      policy: DEFAULT_POLICY,
      policyPopulation: [genome].map(policyGenomeFromDurable)
    });
    expect(report.pareto.available).toBe(false); // one distinct genome is still below the >=2 requirement
    expect(report.efc).toBe(false);
  });

  it("becomes Pareto-available once two genuinely distinct fingerprints have real evaluation history", () => {
    const a = aggregateGenome(undefined, fixtureEvaluation({ policyFingerprint: "policy_a", objectives: [0.8, 0.8, 0.8, 0.8, 0.8] }));
    const b = aggregateGenome(undefined, fixtureEvaluation({ policyFingerprint: "policy_b", objectives: [0.75, 0.75, 0.75, 0.75, 0.75] }));

    const report = createFunctionalCognitionEngine().project({
      now: 3_000,
      self: selfState(),
      model: modelState(),
      graph: emptyGraph(),
      policy: DEFAULT_POLICY,
      policyPopulation: [a, b].map(policyGenomeFromDurable)
    });
    expect(report.pareto.available).toBe(true);
  });
});

function selfState(): FunctionalSelfState {
  return {
    currentGoals: ["goal.real"],
    memoryState: { nodes: 12, edges: 16, evidence: 8, sourceVersions: 4, proofs: 3 },
    knownLimits: [],
    uncertainty: 0.1,
    capabilities: ["fixture"],
    activePolicies: ["requireTwoPhaseCommit"],
    recentFailures: [],
    commitments: ["fixture"],
    permissions: ["mutation dry-run unless approved"],
    learningGoals: ["goal.real"],
    fcs: 0.9,
    dci: 0.9
  };
}

function modelState(): ModelState {
  return { languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: ["goal.real"], trainingSteps: 12 };
}

function emptyGraph(): GraphSlice {
  return { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
}

function fixtureEvaluation(patch: Partial<PolicyEvaluation> = {}): PolicyEvaluation {
  return {
    id: `eval_${patch.createdAt ?? 1_000}`,
    policyFingerprint: "policy_fixture",
    objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID,
    vector: { evidenceRequired: 0.7, riskTolerance: 0.5, citationStrictness: 0.6, approvalRequired: 0.5, autonomyLevel: 0.3 },
    objectives: [0.5, 0.5],
    evaluationWindow: { firstEventId: "event.a", lastEventId: "event.b" },
    observations: 1,
    createdAt: 1_000,
    informationLabel: fixtureLabel(),
    ...patch
  };
}

function fixtureLabel(): InformationLabel {
  return {
    exportClass: "public",
    tenantId: "fixture-tenant",
    principals: [],
    compartments: []
  } as unknown as InformationLabel;
}
