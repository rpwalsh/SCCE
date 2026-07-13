import { describe, expect, it } from "vitest";
import { createAuditEngine } from "../audit.js";
import { createBenchmarkScorer } from "../benchmarks.js";
import { createLearningController } from "../learning.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { createEventFactory } from "../events.js";
import type { GraphSlice, SemanticEntailmentResult, TurnResult } from "../types.js";

describe("audit, learning, and benchmark source contracts", () => {
  const clock = createClock({ fixedTime: 100, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true });

  it("verifies event chains and detects tampering", () => {
    const events = createEventFactory({ idFactory: ids, clock, hasher });
    const episodeId = ids.episodeId();
    const first = events.create({ episodeId, typeId: "OwnerAsked", payload: { textHash: "abc" } });
    const second = events.create({ episodeId, typeId: "EpisodeClosed", payload: { output: "done" }, parents: [first] });
    const audit = createAuditEngine();
    expect(audit.verifyEventChain([first, second]).ok).toBe(true);
    expect(audit.verifyEventChain([{ ...second, hash: "wrong" }]).ok).toBe(false);
  });

  it("builds a learning plan from sparse graph and pending quarantine", () => {
    const graph: GraphSlice = { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
    const plan = createLearningController().plan({ config: { learningGoals: ["improve proof graph synthesis"] }, model: { languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }, graph, pending: [], profiles: [] });
    expect(plan.goals[0]?.priority).toBeGreaterThan(0);
    expect(plan.graph.actions.length).toBeGreaterThan(0);
  });

  it("scores benchmark turns without claiming frontier comparisons", () => {
    const scorer = createBenchmarkScorer();
    const turn = minimalTurn();
    const result = scorer.scoreTurn({ id: "proof", input: "explain alpha", expectedEvidence: ["alpha"], expectedArtifacts: [] }, turn);
    expect(result.score).toBeGreaterThan(0);
    expect(result.notes.some(note => note.includes("no frontier"))).toBe(true);
  });

  function minimalTurn(): TurnResult {
    const proofId = ids.proofId({ claimId: ids.claimId("alpha"), evidenceIds: [], transforms: [], validatorVersion: "test" });
    const entailment: SemanticEntailmentResult = {
      claim: { id: ids.claimId("alpha"), text: "alpha", normalized: "alpha", features: ["sym:alpha"], polarity: 1 },
      verdict: "entailed",
      semanticVerdict: "entailed",
      force: "observed",
      support: 0.8,
      contradiction: 0.05,
      faithfulnessLcb: 0.7,
      confidence: { verdict: "entailed", support: 0.8, contradiction: 0.05, faithfulnessLcb: 0.7, supportingEvidence: 0, sourceVersions: [], structuralCoverage: 1, roleCoverage: 1, relationCompatibility: 1, transformationSupport: 1, causalMass: 0.2, stability: 1, satisfiedObligations: 0, requiredObligations: 0 },
      scores: { structuralCoverage: 1, roleCoverage: 1, relationCompatibility: 1, transformationSupport: 1, causalMass: 0.2, faithfulnessLCB: 0.7, contradiction: 0.05, stability: 1 },
      obligations: [],
      mappings: [],
      transforms: [],
      counterexamples: [],
      missing: [],
      evidenceIds: [],
      boundaries: [],
      proof: { id: proofId, claimId: ids.claimId("alpha"), verdict: "observed", confidence: {}, proofGraph: { nodes: [{ id: "claim", kind: "claim", label: "alpha", metadata: {} }], edges: [] }, evidenceIds: [], transformIds: [], scores: {}, validatorVersion: "test", createdAt: clock.now() }
    };
    return {
      episodeId: ids.episodeId(),
      answer: "alpha",
      epistemicForce: "observed",
      evidence: [],
      field: { requestFeatures: ["sym:alpha"], seeds: [], active: [], ppf: [], causalMass: [], alphaTrace: { alpha: 0.007, thresholds: { virtual: 0, visible: 0, bonded: 0, structural: 1 }, relations: [], adjacency: { nodes: [], values: [] }, laplacian: { nodes: [], values: [] }, normalizedLaplacian: { nodes: [], values: [] }, surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 }, contradictionMass: 0, bondedLeakage: 0 } },
      entailment,
      constructGraph: { id: ids.constructId("c"), episodeId: ids.episodeId(), forceVector: {}, nodes: [], edges: [], artifacts: [] },
      validationGraph: { id: ids.validationId("v"), constructId: ids.constructId("c"), checks: [], passed: true },
      emissionGraph: { id: ids.emissionId("e"), constructId: ids.constructId("c"), answer: "alpha", epistemicForce: "observed", artifacts: [], evidenceIds: [], proofId },
      forecast: { id: ids.forecastEnvelopeId("f"), sourceStateId: ids.forecastStateId("s"), horizon: 1, mean: [], covariance: [], interval: [], createdAt: clock.now() },
      learningNeeds: [],
      scoreTraces: [],
      calibrationStatus: "uncalibrated",
      truthState: {
        symbolicState: "truth.certified",
        beliefLower: 0.8,
        plausibilityUpper: 0.95,
        supportMass: 0.8,
        contradictionMass: 0.05,
        uncertaintyMass: 0.15,
        validityInterval: null,
        evidenceForce: "direct",
        freshness: 0,
        sourceDiversity: 0
      },
      evidenceForce: "direct",
      guardFlags: {
        requireEvidence: true,
        blockCertifiedFact: false,
        allowInference: true,
        allowCreative: false,
        exposeContradiction: false,
        sourceBacked: true,
        missingEvidence: false,
        contradictionPresent: false,
        preservationChecked: true,
        unsupportedContentBlocked: false
      },
      events: []
    };
  }
});
