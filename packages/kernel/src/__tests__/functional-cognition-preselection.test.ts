import { describe, expect, it } from "vitest";
import {
  createFunctionalCognitionEngine,
  personaHistoryFromEvents,
  personaSnapshotFromSelf
} from "../functional-cognition.js";
import { governanceObservation } from "../governance-observation.js";
import { createGovernedActionEnvelope } from "../governed-action.js";
import { createJudge } from "../judge.js";
import { createHasher } from "../primitives.js";
import { DEFAULT_POLICY } from "../safety.js";
import { createAutonomousToolCognition } from "../tool-cognition.js";
import type { CandidateField, CandidateSurface } from "../candidate.js";
import type {
  Capability,
  EpisodeId,
  FunctionalSelfState,
  GraphSlice,
  ModelState,
  ScceEvent
} from "../types.js";

describe("functional cognition real-input projection", () => {
  it("does not manufacture DCI, CMPS, or Pareto availability", () => {
    const report = createFunctionalCognitionEngine().project({
      now: 2_000,
      self: selfState(),
      model: modelState(),
      graph: emptyGraph(),
      policy: DEFAULT_POLICY
    });

    expect(report.cmpsAvailable).toBe(false);
    expect(report.dci).toMatchObject({ available: false, dci: 0, tier: "unavailable" });
    expect(report.pareto).toMatchObject({
      available: false,
      invariantKernel: false,
      activePolicyInvariant: true,
      front: []
    });
    expect(report.governance).toMatchObject({ ready: false });
    expect(report.governance.failures).toHaveLength(7);
    expect(report.gov).toBe(false);
    expect(report.fc).toBe(false);
    expect(report.efc).toBe(false);
  });

  it("derives governance only from a complete observed control set", () => {
    const report = createFunctionalCognitionEngine({ thetaSafe: 0 }).project({
      now: 2_000,
      self: selfState(),
      model: modelState(),
      graph: emptyGraph(),
      policy: DEFAULT_POLICY,
      governance: readyGovernance()
    });

    expect(report.governance.ready).toBe(true);
    expect(report.gov).toBe(true);
    expect(report.cmpsAvailable).toBe(false);
    expect(report.fc).toBe(false);
  });

  it("builds continuity only from durable SelfModelProjected payloads and the current real state", () => {
    const self = selfState();
    const event = {
      id: "event.previous",
      episodeId: "episode.previous",
      typeId: "SelfModelProjected",
      t: 1_000,
      payload: { self },
      parents: [],
      hash: "hash"
    } as unknown as ScceEvent;
    const current = personaSnapshotFromSelf({
      sessionId: "episode.current",
      self,
      t: 2_000
    });

    const history = personaHistoryFromEvents([event], current);
    const dci = createFunctionalCognitionEngine().developmentalContinuity(history);

    expect(history.map(snapshot => snapshot.sessionId)).toEqual(["episode.previous", "episode.current"]);
    expect(dci.available).toBe(true);
    expect(dci.dci).toBeCloseTo(1, 8);
    expect(dci.tier).toBe("stable");
  });

});

describe("functional cognition selection gates", () => {
  it("keeps an autonomous action candidate out when FC/EFC and a selected goal are unavailable", () => {
    const proof = candidate("proof", "proof-answer");
    const action = candidate("action", "action-preview");
    const field: CandidateField = {
      candidates: [action, proof],
      surfaceMass: [
        { candidateId: action.id, mass: 0.9, reason: "fixture" },
        { candidateId: proof.id, mass: 0.1, reason: "fixture" }
      ],
      scoreTrace: [],
      audit: {}
    };

    const decision = createJudge({ random: () => 0.5 }).select({
      field,
      policy: DEFAULT_POLICY,
      functionalGate: { fc: false, efc: false, gov: true }
    });
    const absentGateDecision = createJudge({ random: () => 0.5 }).select({
      field,
      policy: DEFAULT_POLICY
    });

    expect(decision.selected.id).toBe(proof.id);
    expect(absentGateDecision.selected.id).toBe(proof.id);
    expect(decision.rejected.find(row => row.candidate.id === action.id)?.reasons).toContain(
      "hard-failure:functional-consciousness-unavailable"
    );
  });

  it("allows read planning under FC but requires EFC and a selected goal for prepare planning", () => {
    const cognition = createAutonomousToolCognition({ now: () => 1_000 });
    const base = {
      episodeId: "episode.functional-gate" as EpisodeId,
      request: "αβγ",
      capabilities: capabilities(),
      policy: DEFAULT_POLICY
    };
    const read = cognition.plan({
      ...base,
      actionCommitment: 0.05,
      functionalGate: { fc: true, efc: false, gov: true, selectedGoalId: "goal.real" }
    });
    const absentGate = cognition.plan({
      ...base,
      actionCommitment: 0.05
    });
    const heldPrepare = cognition.plan({
      ...base,
      actionCommitment: 0.95,
      functionalGate: { fc: true, efc: false, gov: true, selectedGoalId: "goal.real" }
    });
    const admittedPrepare = cognition.plan({
      ...base,
      actionCommitment: 0.95,
      functionalGate: { fc: true, efc: true, gov: true, selectedGoalId: "goal.real" }
    });

    expect(read.capabilityPlans[0]?.phase).toBe("read");
    expect(absentGate.capabilityPlans).toEqual([]);
    expect(heldPrepare.capabilityPlans).toEqual([]);
    expect(admittedPrepare.capabilityPlans[0]?.phase).toBe("prepare");
  });

  it("fails governed actions closed when audit or kill-switch observations are absent", () => {
    const governed = createGovernedActionEnvelope({ hasher: createHasher() });
    const capability: Capability = {
      id: "filesystem.read",
      label: "filesystem.read",
      kind: "filesystem",
      mutates: false,
      risk: 0,
      requiresApproval: false,
      configured: true,
      metadata: {}
    };
    const policy = { ...DEFAULT_POLICY, alphaRiskCeiling: 1, maxToolCalls: 10 };
    const absent = governed.propose({
      capability,
      payload: {},
      policy,
      now: 1_000
    });
    const killSwitchMissing = governed.propose({
      capability,
      payload: {},
      policy,
      now: 1_000,
      auditIntact: true,
      rollbackAvailable: true
    });
    const observed = governed.propose({
      capability,
      payload: {},
      policy,
      now: 1_000,
      auditIntact: true,
      rollbackAvailable: true,
      killSwitchActive: true
    });
    const certificateWithoutKillSwitch = {
      ...observed,
      certificate: { ...observed.certificate }
    };
    delete certificateWithoutKillSwitch.certificate.killSwitchLive;

    expect(absent).toMatchObject({ status: "rejected", rejectionReason: "gov_audit_chain_broken" });
    expect(killSwitchMissing).toMatchObject({ status: "rejected", rejectionReason: "gov_kill_switch_dead" });
    expect(observed.status).toBe("pending");
    expect(governed.verify({
      proposal: certificateWithoutKillSwitch,
      payload: {},
      policy,
      now: 1_001,
      approved: true
    })).toMatchObject({ ok: false, reason: "governance_gate_failed" });
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
  return {
    languageProfiles: [],
    latentConcepts: [],
    learnedProgramPatterns: [],
    learningGoals: ["goal.real"],
    trainingSteps: 12
  };
}

function emptyGraph(): GraphSlice {
  return { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
}

function candidate(id: string, kind: CandidateSurface["kind"]): CandidateSurface {
  return {
    id,
    kind,
    answer: id,
    force: kind === "proof-answer" ? "observed" : "conjectured",
    evidenceIds: [],
    scores: {
      support: kind === "proof-answer" ? 0.8 : 0.5,
      contradiction: 0,
      faithfulness: 0.9,
      alphaPressure: 0.8,
      actionability: kind === "action-preview" ? 1 : 0.2,
      evidenceCoverage: 0.8,
      novelty: 0.2,
      realizability: 0.9
    },
    boundaries: [],
    audit: {}
  };
}

function readyGovernance() {
  const passed = {
    available: true,
    passed: true,
    reason: "verified",
    evidence: {}
  };
  return governanceObservation(2_000, {
    eventLedger: { ...passed, events: 4, latestLedgerHash: "ledger" },
    rollback: { ...passed, artifactsChecked: 1, artifactsReady: 1 },
    killSwitch: { ...passed, state: "armed", independentlyConfigured: true },
    leases: {
      ...passed,
      enumerable: true,
      activeLeases: 0,
      connectorAuthorityReady: true,
      executorAuthorityReady: true,
      revocableActiveLeases: 0
    },
    pendingMutations: {
      ...passed,
      enumerable: true,
      pending: 0,
      mutationIds: []
    },
    policyIntegrity: {
      ...passed,
      fingerprint: "fingerprint",
      expectedFingerprint: "fingerprint",
      fingerprintValid: true,
      signatureValid: true
    },
    immutability: {
      ...passed,
      updateDenied: true,
      deleteDenied: true,
      protectiveTriggerPresent: true
    }
  });
}

function capabilities(): Capability[] {
  return [
    {
      id: "filesystem.fixture",
      label: "fixture.read",
      kind: "filesystem",
      mutates: true,
      risk: 0.28,
      requiresApproval: true,
      configured: true,
      metadata: {}
    },
    {
      id: "process.fixture",
      label: "fixture.prepare",
      kind: "process",
      mutates: false,
      risk: 0.46,
      requiresApproval: true,
      configured: true,
      metadata: {}
    }
  ];
}

describe("standing functional cognition register", () => {
  const gate = { fc: true, efc: true, gov: true, selectedGoalId: "goal:x", selectedGoalScore: 0.8 };

  it("authorizes from a fresh standing projection and degrades honestly on staleness", async () => {
    const { standingFunctionalGate, STANDING_FUNCTIONAL_COGNITION_TTL_MS } = await import("../functional-cognition.js");
    const now = 1_000_000_000;
    const fresh = standingFunctionalGate({
      standing: { gate, computedAt: now - 1000 },
      now,
      authorizeCapabilities: true
    });
    expect(fresh.source).toBe("standing-fresh");
    expect(fresh.gate.fc).toBe(true);
    expect(fresh.gate.efc).toBe(true);

    const stale = standingFunctionalGate({
      standing: { gate, computedAt: now - STANDING_FUNCTIONAL_COGNITION_TTL_MS - 1 },
      now,
      authorizeCapabilities: true
    });
    expect(stale.source).toBe("standing-stale");
    expect(stale.gate.fc).toBe(false);
    expect(stale.gate.efc).toBe(false);
    // gov is state, not authorization -- staleness must not fabricate or
    // erase it.
    expect(stale.gate.gov).toBe(true);

    const missing = standingFunctionalGate({ standing: undefined, now, authorizeCapabilities: true });
    expect(missing.source).toBe("standing-missing");
    expect(missing.gate.fc).toBe(false);
  });

  it("never authorizes in audit-only mode even when fresh", async () => {
    const { standingFunctionalGate } = await import("../functional-cognition.js");
    const read = standingFunctionalGate({
      standing: { gate, computedAt: 5_000 },
      now: 6_000,
      authorizeCapabilities: false
    });
    expect(read.source).toBe("standing-fresh");
    expect(read.gate.fc).toBe(false);
    expect(read.gate.efc).toBe(false);
  });

  it("maps a judge-rejected candidate to a real counterfactual trace", async () => {
    const { counterfactualTraceFromRejectedCandidate } = await import("../functional-cognition.js");
    const trace = counterfactualTraceFromRejectedCandidate({
      episodeId: "episode-1",
      candidateId: "candidate:generated:alt",
      candidateKind: "proof-answer",
      score: 1.2,
      reasons: ["requirement-quality=1.2", "hard-failure:telemetry_leak"],
      support: 0.7,
      evidenceCount: 2,
      hardFailure: true,
      selectedCandidateId: "candidate:winner"
    });
    expect(trace.sourceTraceId).toBe("episode-1");
    expect(trace.planSteps[0]).toBe("proof-answer");
    expect(trace.substitutedSteps).toEqual(["candidate:winner"]);
    expect(trace.evidenceSurvival[0]).toBeCloseTo(0.7);
    expect(trace.safetyMargins[0]).toBeLessThan(0.5);
  });
});
