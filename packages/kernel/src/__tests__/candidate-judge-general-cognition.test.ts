import { describe, expect, it } from "vitest";
import { createCandidateEngine, type CandidateField, type CandidateQuality, type CandidateSurface } from "../candidate.js";
import type { ClaimBasis, CognitiveProposal, PlannedClaim } from "../cognitive-planner.js";
import { createJudge } from "../judge.js";
import { createPatchTransactionPlan } from "../patch-transaction.js";
import { createInventionConstruct } from "../prediction.js";
import { toJsonValue } from "../primitives.js";
import {
  COGNITIVE_OPERATOR_IDS,
  type ActivatedOperator,
  type CognitiveOperatorId,
  type TurnRequirementField
} from "../turn-requirements.js";
import type { CcrResult } from "../ccr.js";
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
import type { ChernoffResult, DavisKahanEnvelope, MinimumCoverResult, SubspaceDriftEntropy } from "../causal-math.js";

describe("general-cognition candidate and judge contracts", () => {
  it("turns a cognitive proposal into a clean answer surface without exposing telemetry", () => {
    const proposal = cognitiveProposal({
      id: "proposal.clean-surface",
      claims: [claim("claim.clean", "Use a bounded relation route and validate the selected edge.", "reasoned_inference")],
      trace: { schema: "internal.proposal.trace", scores: { raw: 0.91 } }
    });
    const field = createCandidateEngine().generate({
      ...engineFixture([]),
      requirementField: requirements({ inferentialDepth: 0.9 }),
      cognitiveProposals: [proposal]
    });

    const candidate = field.candidates.find(row => row.proposalId === proposal.id);
    expect(candidate).toBeDefined();
    expect(candidate?.kind).toBe("reasoned-synthesis");
    expect(candidate?.answer).toBe("Use a bounded relation route and validate the selected edge.");
    expect(candidate?.answer).not.toMatch(/[{}]/u);
    expect(candidate?.answer).not.toContain("internal.proposal.trace");
    expect(candidate?.answer).not.toContain("scores");
  });

  it("uses exact proof-bound source text when a reasoned proposal has no realizable claim surface", () => {
    const observed = evidence("evidence.reasoned-surface", "એક જ સમયે 42 kPa અને 57 kPa પરસ્પર વિરોધી માપ છે.");
    const operator = activeOperator(COGNITIVE_OPERATOR_IDS.relationComposition);
    const proposal = cognitiveProposal({
      id: "proposal.reasoned-control-surface",
      operatorActivations: [operator],
      claims: [claim("claim.reasoned-control-surface", "i18n:construct.family.answer", "reasoned_inference")],
      evidenceIds: []
    });
    const field = createCandidateEngine().generate({
      ...engineFixture([observed]),
      requestedAuthority: "reasoned",
      requirementField: requirements({ inferentialDepth: 0.98 }),
      operatorActivations: [operator],
      cognitiveProposals: [proposal]
    });

    const candidate = proposalCandidate(field, proposal.id);
    expect(candidate.answer).toBe(observed.text);
    expect(candidate.evidenceIds).toEqual([observed.id]);
    expect(candidate.kind).toBe("reasoned-synthesis");
    expect(JSON.stringify(candidate.audit)).toContain('"surfaceOriginId":"surface.cognitive_proposal.bound_proof_evidence.v1"');
    expect(JSON.stringify(candidate.audit)).toContain(String(observed.id));
  });

  it("labels exact selected-source fallback honestly when the proof has no evidence ids", () => {
    const observed = evidence("evidence.reasoned-selected-surface", "42 kPa and 57 kPa are incompatible measurements of one state at one time.");
    const operator = activeOperator(COGNITIVE_OPERATOR_IDS.relationComposition);
    const proposal = cognitiveProposal({
      id: "proposal.reasoned-selected-control-surface",
      operatorActivations: [operator],
      claims: [claim("claim.reasoned-selected-control-surface", "i18n:construct.family.answer", "reasoned_inference")],
      steps: [{
        id: "step.reasoned-selected-proof-control",
        order: 0,
        text: "proof_9ee8a4acc2710d48ada36219bd27831eca7247fbe6bedebf",
        basis: "learned_prior",
        dependsOnIds: [],
        evidenceIds: [],
        trace: {}
      }],
      evidenceIds: []
    });
    const fixture = engineFixture([observed]);
    fixture.entailment.evidenceIds = [];
    fixture.entailment.proof.evidenceIds = [];
    const field = createCandidateEngine().generate({
      ...fixture,
      requestedAuthority: "reasoned",
      requirementField: requirements({ inferentialDepth: 0.98 }),
      operatorActivations: [operator],
      cognitiveProposals: [proposal]
    });

    const candidate = proposalCandidate(field, proposal.id);
    expect(candidate.answer).toBe(observed.text);
    expect(candidate.evidenceIds).toEqual([observed.id]);
    expect(JSON.stringify(candidate.audit)).toContain('"surfaceOriginId":"surface.cognitive_proposal.bound_selected_evidence.v1"');
  });

  it("does not invent a fallback surface for an evidence-free reasoned proposal", () => {
    const operator = activeOperator(COGNITIVE_OPERATOR_IDS.relationComposition);
    const proposal = cognitiveProposal({
      id: "proposal.reasoned-control-surface-without-proof",
      operatorActivations: [operator],
      claims: [claim("claim.reasoned-control-surface-without-proof", "i18n:construct.family.answer", "reasoned_inference")],
      evidenceIds: []
    });
    const field = createCandidateEngine().generate({
      ...engineFixture([]),
      requestedAuthority: "reasoned",
      requirementField: requirements({ inferentialDepth: 0.98 }),
      operatorActivations: [operator],
      cognitiveProposals: [proposal]
    });

    const candidate = proposalCandidate(field, proposal.id);
    expect(candidate.answer).toBe("");
    expect(candidate.evidenceIds).toEqual([]);
    expect(JSON.stringify(candidate.audit)).toContain('"surfaceOriginId":null');
  });

  it("keeps a program proposal semantic when its only incoming surface is an internal control id", () => {
    const operator = activeOperator(COGNITIVE_OPERATOR_IDS.programPlanning);
    const proposal = cognitiveProposal({
      id: "proposal.program-semantic-only",
      operatorActivations: [operator],
      claims: [claim("claim.program-semantic-only", "i18n:construct.family.answer", "learned_prior")],
      semanticFrameIds: ["frame.program.fixture"]
    });
    const field = createCandidateEngine().generate({
      ...engineFixture([]),
      requirementField: requirements({ executableArtifactDemand: 1 }),
      operatorActivations: [operator],
      cognitiveProposals: [proposal]
    });

    const candidate = proposalCandidate(field, proposal.id);
    expect(candidate.kind).toBe("program-proposal");
    expect(candidate.answer).toBe("");
    expect(JSON.stringify(candidate.audit)).toContain('"frameId":"semantic.cognitive_proposal.v1"');
    expect(JSON.stringify(candidate.audit)).toContain('"semanticFrameIds":["frame.program.fixture"]');
  });

  it("keeps invented material invented without treating missing evidence as a factual-support defect", () => {
    const proposal = cognitiveProposal({
      id: "proposal.invented",
      claims: [claim("claim.invented", "A reversible index can stage alternatives before choosing one.", "invented", {
        externallyFactual: false,
        evidenceIds: []
      })]
    });
    const requirementField = requirements({ noveltyDemand: 0.95, externalTruthAuthority: 0 });
    const field = createCandidateEngine().generate({
      ...engineFixture([]),
      requirementField,
      cognitiveProposals: [proposal]
    });
    const candidate = proposalCandidate(field, proposal.id);

    expect(candidate.kind).toBe("creative-candidate");
    expect(candidate.force).toBe("invented");
    expect(candidate.evidenceIds).toEqual([]);
    expect(candidate.quality?.unsupportedFactRate).toBe(0);
    expect(candidate.quality?.fakeFactualAuthority).toBe(0);
    expect(candidate.quality?.sourceFidelity).toBe(1);
    expect(candidate.boundaries).not.toContain("unsupported-factual-claim");

    const decision = createJudge().select({ field, policy: policy(), requirementField });
    const row = decision.scores.find(score => score.candidateId === candidate.id);
    expect(row?.reasons.some(reason => reason.startsWith("hard-failure:"))).toBe(false);
  });

  it("emits only the proposal-backed invention when cognitive proposals are supplied", () => {
    const operators = [activeOperator(COGNITIVE_OPERATOR_IDS.invention)];
    const proposal = cognitiveProposal({
      id: "proposal.only-creative",
      operatorActivations: operators,
      claims: [claim("claim.only-creative", "Stage several reversible alternatives before choosing one.", "invented")]
    });
    const rawInvention = createInventionConstruct({
      id: "invention.legacy-duplicate",
      title: "Legacy duplicate",
      proposalSurface: "A second raw creative surface that must not be emitted."
    });
    const field = createCandidateEngine().generate({
      ...engineFixture([]),
      requirementField: requirements({ noveltyDemand: 1 }),
      operatorActivations: operators,
      cognitiveProposals: [proposal],
      inventionCandidates: [rawInvention]
    });

    const creative = field.candidates.filter(row => row.kind === "creative-candidate");
    expect(creative).toHaveLength(1);
    expect(creative[0]?.proposalId).toBe(proposal.id);
    expect(creative[0]?.claimBases).toEqual(["invented"]);
    expect(creative[0]?.quality).toBeDefined();
    expect(field.candidates.some(row => row.id.startsWith("creative:invention.legacy-duplicate"))).toBe(false);
    expect(field.candidates.some(row => row.kind === "proof-answer" || row.kind === "graph-inference")).toBe(false);
  });

  it("does not expose an unsupported factual proof fallback as invented authority", () => {
    const fixture = engineFixture([]);
    fixture.entailment.force = "invented";
    const field = createCandidateEngine().generate({
      ...fixture,
      requestedAuthority: "factual",
      requirementField: requirements({ externalTruthAuthority: 1, sourceDependence: 1 }),
      operatorActivations: []
    });

    expect(field.candidates.find(row => row.kind === "proof-answer")?.force).toBe("unknown");
    expect(field.candidates.some(row => row.force === "invented")).toBe(false);
  });

  it("turns verified workspace, pending action, and unresolved dialogue state into operator-backed plan candidates", () => {
    const operators = [
      activeOperator(COGNITIVE_OPERATOR_IDS.workspaceRepair),
      activeOperator(COGNITIVE_OPERATOR_IDS.actionPlanning),
      activeOperator(COGNITIVE_OPERATOR_IDS.dialogueContinuation)
    ];
    const workspacePlan = createPatchTransactionPlan({
      operations: [{ kind: "create", path: "src/new.ts", content: "export const value = 1;\n" }]
    });
    const field = createCandidateEngine().generate({
      ...engineFixture([]),
      requirementField: requirements({ executableArtifactDemand: 1, actionCommitment: 0.8, dialogueDependence: 0.8 }),
      operatorActivations: operators,
      workspacePlans: [
        toJsonValue(workspacePlan),
        toJsonValue({
          schema: "scce.workspace.proposed_artifact.v1",
          path: "src/proposed.ts",
          contentHash: "sha256_fixture",
          mediaType: "text/typescript",
          role: "source"
        })
      ],
      actionPlans: [toJsonValue({
        id: "capability-plan.fixture",
        capabilityId: "filesystem.write",
        phase: "prepare",
        status: "planned",
        permission: { allowed: false, dryRun: true, reason: "approval-required" }
      })],
      dialogueState: toJsonValue({
        turnId: "turn.fixture",
        activeTask: "task.fixture",
        unresolvedSlots: ["slot.target"],
        continuityLinks: ["turn.previous"]
      })
    });

    const workspace = field.candidates.find(row => row.kind === "workspace-proposal");
    const workspaceArtifact = field.candidates.find(row => row.proposalId?.startsWith("workspace-artifact:"));
    const action = field.candidates.find(row => row.kind === "action-preview");
    const dialogue = field.candidates.find(row => row.proposalId === "dialogue-plan:turn.fixture");
    expect(workspace?.proposalId).toBe(`workspace-plan:${workspacePlan.planHash}`);
    expect(workspace?.boundaries).toContain("workspace-plan-not-executed");
    expect(workspace?.answer).toContain(workspacePlan.planHash);
    expect(workspace?.answer).toContain('"kind": "create"');
    expect(workspace?.answer).toContain('"path": "src/new.ts"');
    expect(workspace?.answer).toContain("export const value = 1;\n");
    expect(JSON.stringify(workspace?.audit)).toContain('"frameId":"semantic.workspace.patch_plan.v1"');
    expect(JSON.stringify(workspace?.audit)).toContain("src/new.ts");
    expect(workspaceArtifact?.answer).toBe("");
    expect(JSON.stringify(workspaceArtifact?.audit)).toContain('"frameId":"semantic.workspace.artifact_proposal.v1"');
    expect(JSON.stringify(workspaceArtifact?.audit)).toContain("src/proposed.ts");
    expect(workspaceArtifact?.boundaries).toContain("workspace-artifact-not-byte-validated");
    expect(action?.claimBases).toEqual(["conjectured"]);
    expect(action?.answer).toContain('"artifactKind": "action-preview"');
    expect(action?.answer).toContain('"objectiveSurface": "fixture request"');
    expect(action?.answer).toContain('"capabilityId": "filesystem.write"');
    expect(action?.answer).toContain('"executionState": "not_executed"');
    expect(JSON.stringify(action?.audit)).toContain('"frameId":"semantic.action.preview.v1"');
    expect(JSON.stringify(action?.audit)).toContain('"capabilityId":"filesystem.write"');
    expect(JSON.stringify(action?.audit)).toContain('"surfaceOriginId":"surface.action.preview.structural.v1"');
    expect(dialogue?.kind).toBe("dialogue-continuation");
    expect(dialogue?.answer).toBe("");
    expect(dialogue?.missedRequirementIds).toEqual(["slot.target"]);
    expect(JSON.stringify(dialogue?.audit)).toContain('"frameId":"semantic.dialogue.continuation.v1"');
    expect(field.candidates.some(row => row.kind === "graph-inference" || row.kind === "creative-candidate")).toBe(false);
  });

  it("keeps a bounded proof fallback when an active operator produces no valid alternative", () => {
    const field = createCandidateEngine().generate({
      ...engineFixture([]),
      requestedAuthority: "action",
      requirementField: requirements({ actionCommitment: 1 }),
      operatorActivations: [activeOperator(COGNITIVE_OPERATOR_IDS.actionPlanning)],
      actionPlans: []
    });

    expect(field.candidates).toHaveLength(1);
    expect(field.candidates[0]?.kind).toBe("proof-answer");
    expect(field.candidates[0]?.answer).toBe("");
    expect(JSON.stringify(field.candidates[0]?.audit)).toContain('"frameId":"semantic.answer.proof.v1"');
    expect(jsonRecord(field.audit).operatorRoutingFallback).toBe(true);
  });

  it("changes selection from truth support to novelty when the requirement vector changes", () => {
    const truth = candidate("candidate.truth", {
      truthSupport: 1,
      sourceFidelity: 1,
      novelty: 0.02,
      uncertaintyCalibration: 1
    });
    const novel = candidate("candidate.novel", {
      truthSupport: 0.02,
      sourceFidelity: 0.02,
      novelty: 1,
      uncertaintyCalibration: 0.5
    }, ["invented"]);
    const field = candidateField([truth, novel]);

    const truthDecision = createJudge().select({
      field,
      policy: policy(),
      requirementField: requirements({ externalTruthAuthority: 1, sourceDependence: 1, noveltyDemand: 0 }),
      deterministicReplay: true
    });
    const noveltyDecision = createJudge().select({
      field,
      policy: policy(),
      requirementField: requirements({ externalTruthAuthority: 0, sourceDependence: 0, noveltyDemand: 1 }),
      deterministicReplay: true
    });

    expect(truthDecision.selected.id).toBe(truth.id);
    expect(noveltyDecision.selected.id).toBe(novel.id);
  });

  it("hard-fails fake factual attribution even when its other quality scores are maximal", () => {
    const fake = candidate("candidate.fake-attribution", {
      truthSupport: 1,
      sourceFidelity: 1,
      novelty: 1,
      requirementCoverage: 1,
      languageQuality: 1,
      usefulness: 1,
      coherence: 1,
      fakeFactualAuthority: 1
    }, ["direct_evidence"]);
    const safe = candidate("candidate.safe", { truthSupport: 0.6, sourceFidelity: 0.6 });
    const decision = createJudge().select({
      field: candidateField([fake, safe]),
      policy: policy(),
      requirementField: requirements({ externalTruthAuthority: 1 })
    });

    expect(decision.selected.id).toBe(safe.id);
    const rejected = decision.rejected.find(row => row.candidate.id === fake.id);
    expect(rejected?.score).toBeLessThan(-1_000_000);
    expect(rejected?.reasons).toContain("hard-failure:fake_factual_authority");
  });

  it("rejects semantic loss when semantic preservation is strongly required", () => {
    const preserved = candidate("candidate.preserved", { semanticPreservation: 1, transformationQuality: 0.7 });
    const lossy = candidate("candidate.lossy", { semanticPreservation: 0, transformationQuality: 1 });
    const decision = createJudge().select({
      field: candidateField([lossy, preserved]),
      policy: policy(),
      requirementField: requirements({ semanticPreservation: 1, surfaceTransformation: 0 }),
      deterministicReplay: true
    });

    expect(decision.selected.id).toBe(preserved.id);
    expect(decision.rejected.map(row => row.candidate.id)).toContain(lossy.id);
  });

  it("retains mixed claim bases and their evidence boundary on the proposal candidate", () => {
    const observed = evidence("evidence.mixed", "Observed pressure remained within the stated range.");
    const proposal = cognitiveProposal({
      id: "proposal.mixed-bases",
      claims: [
        claim("claim.observed", "The observed pressure remained in range.", "direct_evidence", { evidenceIds: [observed.id], externallyFactual: true }),
        claim("claim.reasoned", "That supports continuing the bounded trial.", "reasoned_inference", { graphEdgeIds: ["edge.support"], externallyFactual: false }),
        claim("claim.invented", "A reversible checkpoint can make the trial easier to inspect.", "invented")
      ],
      evidenceIds: [observed.id]
    });
    const field = createCandidateEngine().generate({
      ...engineFixture([observed]),
      requirementField: requirements({ externalTruthAuthority: 0.5, noveltyDemand: 0.5, inferentialDepth: 0.5 }),
      cognitiveProposals: [proposal]
    });
    const candidate = proposalCandidate(field, proposal.id);

    expect(candidate.claimBases).toEqual(["direct_evidence", "reasoned_inference", "invented"]);
    expect(candidate.evidenceIds).toEqual([observed.id]);
    expect(candidate.force).toBe("invented");
    expect(JSON.stringify(candidate.audit)).toContain('"basis":"direct_evidence"');
    expect(JSON.stringify(candidate.audit)).toContain('"basis":"reasoned_inference"');
    expect(JSON.stringify(candidate.audit)).toContain('"basis":"invented"');
  });

  it("uses a clean meaning surface for graph inference instead of serializing its audit", () => {
    const observed = evidence("evidence.graph", "The pump remained stable throughout the bounded run.");
    const fixture = engineFixture([observed]);
    const field = createCandidateEngine().generate({ ...fixture, proofAnswer: "The pump remained stable." });
    const graph = field.candidates.find(row => row.kind === "graph-inference");

    expect(graph).toBeDefined();
    expect(graph?.answer).toBe(fixture.entailment.claim.text);
    expect(graph?.answer.trim().startsWith("{")).toBe(false);
    expect(graph?.answer).not.toContain("causalMass");
    expect(JSON.stringify(graph?.audit)).toContain("causalMass");
  });

  it("bounds Boltzmann temperature and emits a normalized probability distribution", () => {
    const field = candidateField([
      candidate("candidate.alpha", { truthSupport: 0.8 }),
      candidate("candidate.beta", { novelty: 0.8 })
    ]);
    const cold = createJudge().select({
      field,
      policy: policy(),
      requirementField: requirements({
        externalTruthAuthority: 1,
        actionCommitment: 1,
        executableArtifactDemand: 1,
        noveltyDemand: 0,
        uncertaintyTolerance: 0
      })
    });
    const hot = createJudge().select({
      field,
      policy: policy(),
      requirementField: requirements({
        externalTruthAuthority: 0,
        actionCommitment: 0,
        executableArtifactDemand: 0,
        noveltyDemand: 1,
        uncertaintyTolerance: 1
      })
    });

    const coldAudit = jsonRecord(cold.audit);
    const hotAudit = jsonRecord(hot.audit);
    expect(coldAudit.temperature).toBe(0.08);
    expect(hotAudit.temperature).toBe(0.45);
    expect(coldAudit.temperatureBounds).toEqual([0.08, 0.45]);
    expect(hotAudit.temperatureBounds).toEqual([0.08, 0.45]);
    for (const audit of [coldAudit, hotAudit]) {
      const rows = Array.isArray(audit.rows) ? audit.rows.map(jsonRecord) : [];
      const probability = rows.reduce((sum, row) => sum + number(row.boltzmannProbability), 0);
      expect(probability).toBeCloseTo(1, 12);
      expect(rows.every(row => number(row.boltzmannProbability) >= 0 && number(row.boltzmannProbability) <= 1)).toBe(true);
    }
  });

  it("samples the audited Boltzmann distribution unless deterministic replay is requested", () => {
    const alpha = candidate("candidate.alpha", {});
    const beta = candidate("candidate.beta", {});
    const field = candidateField([alpha, beta]);
    const requirementField = requirements({ noveltyDemand: 0.5, uncertaintyTolerance: 0.5 });

    const sampled = createJudge({ random: () => 0.75 }).select({ field, policy: policy(), requirementField });
    const replayed = createJudge({ random: () => 0.75 }).select({
      field,
      policy: policy(),
      requirementField,
      deterministicReplay: true
    });

    expect(sampled.selected.id).toBe(beta.id);
    expect(jsonRecord(sampled.audit).selection).toBe("boltzmann_sample");
    expect(jsonRecord(sampled.audit).randomDraw).toBe(0.75);
    expect(replayed.selected.id).toBe(alpha.id);
    expect(jsonRecord(replayed.audit).selection).toBe("deterministic_max");
    expect(jsonRecord(replayed.audit).randomDraw).toBeNull();
  });

  it("hard-fails unsupported externally factual claims at high truth authority without hard-failing invention", () => {
    const unsupportedFact = candidate("candidate.unsupported-fact", {
      truthSupport: 0.9,
      sourceFidelity: 0,
      unsupportedFactRate: 1
    }, ["reasoned_inference"]);
    const invention = candidate("candidate.invention", {
      novelty: 1,
      unsupportedFactRate: 1
    }, ["invented"]);
    const safe = candidate("candidate.safe-fact", { truthSupport: 0.4, sourceFidelity: 0.4 });
    const decision = createJudge().select({
      field: candidateField([unsupportedFact, invention, safe]),
      policy: policy(),
      requirementField: requirements({ externalTruthAuthority: 1, sourceDependence: 1 }),
      deterministicReplay: true
    });

    expect(decision.scores.find(row => row.candidateId === unsupportedFact.id)?.reasons)
      .toContain("hard-failure:unsupported_externally_factual_claim");
    expect(decision.scores.find(row => row.candidateId === invention.id)?.reasons)
      .not.toContain("hard-failure:unsupported_externally_factual_claim");
  });
});

function candidate(
  id: string,
  qualityPatch: Partial<CandidateQuality> = {},
  claimBases: ClaimBasis[] = ["direct_evidence"]
): CandidateSurface {
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
    kind: claimBases.includes("invented") ? "creative-candidate" : "reasoned-synthesis",
    answer: `Clean answer for ${id}.`,
    force: claimBases.includes("invented") ? "invented" : "inferred",
    evidenceIds: [],
    scores: {
      support: quality.truthSupport,
      contradiction: quality.contradiction,
      faithfulness: quality.sourceFidelity,
      alphaPressure: 0.5,
      actionability: quality.usefulness,
      evidenceCoverage: quality.sourceFidelity,
      novelty: quality.novelty,
      realizability: quality.languageQuality
    },
    quality,
    claimBases,
    boundaries: [],
    audit: {},
    scoreTrace: []
  };
}

function candidateField(candidates: CandidateSurface[]): CandidateField {
  return {
    candidates,
    surfaceMass: candidates.map(candidate => ({ candidateId: candidate.id, mass: 1 / candidates.length, reason: "fixture" })),
    audit: {},
    scoreTrace: []
  };
}

function cognitiveProposal(patch: Partial<CognitiveProposal> & Pick<CognitiveProposal, "id" | "claims">): CognitiveProposal {
  return {
    id: patch.id,
    operatorActivations: patch.operatorActivations ?? [],
    claims: patch.claims,
    relations: patch.relations ?? [],
    steps: patch.steps ?? [],
    artifacts: patch.artifacts ?? [],
    evidenceIds: patch.evidenceIds ?? [],
    priorIds: patch.priorIds ?? [],
    graphNodeIds: patch.graphNodeIds ?? [],
    semanticFrameIds: patch.semanticFrameIds ?? [],
    constructIds: patch.constructIds ?? [],
    satisfiedRequirementIds: patch.satisfiedRequirementIds ?? [],
    missedRequirementIds: patch.missedRequirementIds ?? [],
    quality: patch.quality ?? {
      reasoning: {
        premiseValidity: 1,
        relationContinuity: 0.8,
        requirementCoverage: 1,
        explanatoryPower: 0.7,
        contradictionHandling: 1,
        temporalConsistency: 1,
        simplicity: 0.9,
        usefulness: 0.8,
        unsupportedLeapRate: 0,
        internalContradiction: 0,
        score: 0.85
      },
      baseQuality: 0.85,
      diversity: 1,
      mmr: 0.85,
      hardFailures: []
    },
    trace: patch.trace ?? {}
  };
}

function claim(
  id: string,
  text: string,
  basis: ClaimBasis,
  patch: Partial<PlannedClaim> = {}
): PlannedClaim {
  return {
    id,
    text,
    basis,
    evidenceIds: [],
    priorIds: basis === "reasoned_inference" ? ["prior.fixture"] : [],
    graphNodeIds: [],
    graphEdgeIds: basis === "reasoned_inference" ? ["edge.fixture"] : [],
    externallyFactual: basis === "direct_evidence" || basis === "source_synthesis",
    hypothetical: basis === "counterfactual",
    trace: {},
    ...patch
  };
}

function proposalCandidate(field: CandidateField, proposalId: string): CandidateSurface {
  const candidate = field.candidates.find(row => row.proposalId === proposalId);
  if (!candidate) throw new Error(`missing proposal candidate: ${proposalId}`);
  return candidate;
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
    confidence: 0.9,
    trace: {},
    ...patch
  };
}

function activeOperator(operatorId: CognitiveOperatorId): ActivatedOperator {
  return {
    id: `activation.${operatorId}`,
    operatorId,
    activation: 0.9,
    active: true,
    contributingRequirementDimensions: [],
    support: { requirement: 0.9, graph: 0, dialogue: 0, construct: 0, outcome: 0 },
    trace: {}
  };
}

function engineFixture(evidenceRows: EvidenceSpan[]) {
  const evidenceIds = evidenceRows.map(row => row.id);
  const proof: SemanticEntailmentResult["proof"] = {
    id: "proof.general-cognition-fixture" as ProofId,
    claimId: "claim.general-cognition-fixture" as ClaimId,
    verdict: evidenceIds.length ? "observed" : "unknown",
    confidence: {},
    proofGraph: { nodes: [], edges: [] },
    evidenceIds,
    transformIds: [],
    scores: {},
    validatorVersion: "fixture",
    createdAt: 1
  };
  const support = evidenceIds.length ? 0.7 : 0.04;
  const entailment: SemanticEntailmentResult = {
    verdict: evidenceIds.length ? "entailed" : "unknown",
    semanticVerdict: evidenceIds.length ? "entailed" : "unknown",
    force: evidenceIds.length ? "observed" : "unknown",
    support,
    contradiction: 0,
    faithfulnessLcb: evidenceIds.length ? 0.8 : 0.05,
    confidence: {
      verdict: evidenceIds.length ? "entailed" : "unknown",
      support,
      contradiction: 0,
      faithfulnessLcb: evidenceIds.length ? 0.8 : 0.05,
      supportingEvidence: evidenceIds.length,
      sourceVersions: [],
      structuralCoverage: 0.5,
      roleCoverage: 0.5,
      relationCompatibility: 0.5,
      transformationSupport: 0.5,
      causalMass: 0.5,
      stability: 0.8,
      satisfiedObligations: evidenceIds.length,
      requiredObligations: 1
    },
    scores: {
      structuralCoverage: 0.5,
      roleCoverage: 0.5,
      relationCompatibility: 0.5,
      transformationSupport: 0.5,
      causalMass: 0.5,
      faithfulnessLCB: evidenceIds.length ? 0.8 : 0.05,
      contradiction: 0,
      stability: 0.8
    },
    obligations: [],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    evidenceIds,
    boundaries: evidenceIds.length ? [] : ["proof-boundary"],
    claim: {
      id: "claim.general-cognition-fixture" as ClaimId,
      text: "The pump remained stable throughout the bounded run.",
      normalized: "the pump remained stable throughout the bounded run",
      features: [],
      polarity: 1
    },
    proof
  };
  return {
    requestText: "fixture request",
    entailment,
    evidence: evidenceRows,
    field: fieldState(),
    ccr: ccr(),
    proofAnswer: evidenceIds.length ? "The observed source supports the claim." : "No certified answer is available.",
    learningNeeds: [] as string[]
  };
}

function evidence(id: string, text: string): EvidenceSpan {
  return {
    id: id as EvidenceId,
    sourceId: "source.fixture" as EvidenceSpan["sourceId"],
    sourceVersionId: "source-version.fixture" as EvidenceSpan["sourceVersionId"],
    chunkId: `${id}.chunk` as EvidenceSpan["chunkId"],
    contentHash: `${id}.hash` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: Buffer.byteLength(text),
    charStart: 0,
    charEnd: text.length,
    text,
    textPreview: text,
    languageHints: [],
    scriptHints: [],
    trustVector: {},
    provenance: {},
    features: [],
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}

function fieldState(): FieldState {
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
  return {
    requestFeatures: [],
    seeds: [],
    active: [],
    ppf: [],
    causalMass: [{ nodeId: "node.fixture" as FieldState["causalMass"][number]["nodeId"], mass: 0.8, reason: "fixture relation support" }],
    alphaTrace
  };
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

function jsonRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function number(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
