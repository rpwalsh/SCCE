import { describe, expect, it } from "vitest";
import {
  ANSWER_REVISION_CONTRACT,
  createAnswerCritic,
  createAnswerRevisionCoordinator,
  type RevisionAnswerVersion,
  type RevisionProposal,
  type RevisionRequirementField,
  type RevisionValidationResults
} from "../answer-revision.js";
import type { CandidateSurface } from "../candidate.js";
import { toJsonValue } from "../primitives.js";
import type { EvidenceId, EvidenceSpan } from "../types.js";

describe("bounded answer revision", () => {
  it("reports a typed missing-requirement defect without drafting replacement prose", () => {
    const result = createAnswerCritic().review(criticInput({
      text: "A compact answer.",
      required: ["requirement.output.table"],
      missed: ["requirement.output.table"]
    }));

    expect(result.defects).toHaveLength(1);
    const defect = result.defects[0]!;
    expect(defect).toMatchObject({
      schema: "scce.answer_revision.defect.v1",
      kind: "missing_required_feature",
      severity: "error",
      violatedRequirement: {
        id: "requirement.output.table",
        source: "field",
        kind: "required"
      },
      requestedCorrection: { operation: "satisfy_requirement" }
    });
    expect(defect.confidence).toBeGreaterThan(0);
    expect(defect.affected.kind).toBe("span");
    expect("replacementText" in defect.requestedCorrection).toBe(false);
  });

  it("reports repeated surface content with exact character and byte offsets", () => {
    const prefix = "Café routes remain bounded. ";
    const repeated = "Café routes remain bounded.";
    const result = createAnswerCritic().review(criticInput({ text: `${prefix}${repeated}` }));
    const defect = result.defects.find(item => item.kind === "repetition");

    expect(defect).toBeDefined();
    expect(defect?.affected.kind).toBe("span");
    if (defect?.affected.kind !== "span") throw new Error("expected a span defect");
    expect(defect.affected.span.text).toBe(repeated);
    expect(defect.affected.span.charStart).toBe(prefix.length);
    expect(defect.affected.span.byteStart).toBe(Buffer.byteLength(prefix, "utf8"));
    expect(defect.requestedCorrection.operation).toBe("remove_repetition");
  });

  it("hard-fails a citation that is unavailable or outside the selected meaning", () => {
    const allowed = "evidence.allowed" as EvidenceId;
    const fabricated = "evidence.fabricated" as EvidenceId;
    const result = createAnswerCritic().review(criticInput({
      text: "The cited premise supports the design.",
      evidence: [evidence(allowed)],
      allowedEvidence: [allowed],
      citedEvidence: [fabricated]
    }));
    const defect = result.defects.find(item => item.kind === "citation_mismatch");

    expect(defect?.severity).toBe("hard_failure");
    expect(defect?.violatedRequirement.id).toBe("revision.invariant.citation_integrity.v1");
    expect(result.hardFailureCount).toBe(1);
  });

  it("accepts an improved valid revision only at the 0.025 quality margin", async () => {
    const baseline = version("baseline", "Keep the graph bounded. Keep the graph bounded.", 0.5);
    const almost = version("almost", "Keep the graph bounded and identify the selected route.", 0.524);
    const improved = version("improved", "Keep the graph bounded and expose the selected route.", 0.525);
    const result = await createAnswerRevisionCoordinator().revise({
      requirementField: field(),
      baseline,
      source: { kind: "candidate_revisions", candidates: [almost, improved] }
    });

    expect(ANSWER_REVISION_CONTRACT.minimumQualityGain).toBe(0.025);
    expect(result.disposition).toBe("resolved");
    expect(result.selected?.id).toBe("improved");
    expect(result.attempts).toHaveLength(2);
    expect(result.attempts[0]).toMatchObject({ accepted: false, hardFailureCount: 0 });
    expect(result.attempts[1]).toMatchObject({ accepted: true, hardFailureCount: 0 });
    expect(result.attempts[1]!.qualityGain).toBeCloseTo(0.025);
  });

  it("rejects a worse revision", async () => {
    const baseline = version("baseline", "Keep the graph bounded. Keep the graph bounded.", 0.5);
    const worse = version("worse", "Keep the graph bounded and expose the route.", 0.42);
    const result = await createAnswerRevisionCoordinator().revise({
      requirementField: field(),
      baseline,
      source: { kind: "candidate_revisions", candidates: [worse] }
    });

    expect(result.disposition).toBe("exhausted_valid");
    expect(result.selected?.id).toBe("baseline");
    expect(result.attempts[0]?.accepted).toBe(false);
    expect(result.attempts[0]?.rejectionReasons).toContain("revision.reject.insufficient_quality_gain.v1");
  });

  it("rejects a higher-scoring revision with a hard failure", async () => {
    const allowed = "evidence.allowed" as EvidenceId;
    const baseline = version("baseline", "Keep the graph bounded. Keep the graph bounded.", 0.5, {
      evidence: [evidence(allowed)],
      allowedEvidence: [allowed]
    });
    const invalid = version("invalid", "Keep the graph bounded and expose the route.", 0.9, {
      evidence: [evidence(allowed)],
      allowedEvidence: [allowed],
      citedEvidence: ["evidence.fabricated" as EvidenceId]
    });
    const result = await createAnswerRevisionCoordinator().revise({
      requirementField: field(),
      baseline,
      source: { kind: "candidate_revisions", candidates: [invalid] }
    });

    expect(result.selected?.id).toBe("baseline");
    expect(result.attempts[0]).toMatchObject({ accepted: false, hardFailureCount: 1 });
    expect(result.attempts[0]?.rejectionReasons).toContain("revision.reject.hard_failure.v1");
  });

  it("invokes planner and Mouth callbacks for no more than two rounds", async () => {
    const baseline = version("baseline", "Keep the graph bounded. Keep the graph bounded.", 0.5);
    let plannerCalls = 0;
    let mouthCalls = 0;
    const result = await createAnswerRevisionCoordinator().revise({
      requirementField: field(),
      baseline,
      source: {
        kind: "planner_mouth",
        planner(input) {
          plannerCalls += 1;
          return {
            id: `plan.${input.round}`,
            round: input.round,
            constraints: input.constraints,
            trace: toJsonValue({ round: input.round })
          };
        },
        mouth(input) {
          mouthCalls += 1;
          expect(input.constraints.length).toBeGreaterThan(0);
          expect(input.plan.constraints).toEqual(input.constraints);
          return version(
            `attempt.${input.round}`,
            `Keep the graph bounded. Keep the graph bounded. Round ${input.round}.`,
            0.51
          );
        }
      }
    });

    expect(result.roundsUsed).toBe(2);
    expect(result.attempts).toHaveLength(2);
    expect(plannerCalls).toBe(2);
    expect(mouthCalls).toBe(2);
    expect(result.attempts.every(attempt => !attempt.accepted)).toBe(true);
  });
});

function criticInput(input: {
  text: string;
  required?: string[];
  missed?: string[];
  evidence?: EvidenceSpan[];
  allowedEvidence?: EvidenceId[];
  citedEvidence?: EvidenceId[];
}) {
  const required = input.required ?? [];
  const requirementField = field(required);
  const selectedCandidate = candidate("candidate.fixture", input.allowedEvidence ?? []);
  return {
    requirementField,
    selectedProposal: proposal(
      "proposal.fixture",
      input.allowedEvidence ?? [],
      required.filter(id => !(input.missed ?? []).includes(id)),
      input.missed ?? []
    ),
    selectedCandidate,
    mouthOutput: { text: input.text, evidenceRefs: input.citedEvidence ?? [] },
    claimBases: [{
      claimId: "claim.fixture",
      basis: "invented" as const,
      evidenceIds: input.allowedEvidence ?? [],
      trace: toJsonValue({ fixture: "basis" })
    }],
    evidence: input.evidence ?? [],
    validationResults: validation()
  };
}

function version(
  id: string,
  text: string,
  score: number,
  input: { evidence?: EvidenceSpan[]; allowedEvidence?: EvidenceId[]; citedEvidence?: EvidenceId[] } = {}
): RevisionAnswerVersion {
  return {
    id,
    selectedProposal: proposal(`proposal.${id}`, input.allowedEvidence ?? []),
    selectedCandidate: candidate(`candidate.${id}`, input.allowedEvidence ?? []),
    mouthOutput: { text, evidenceRefs: input.citedEvidence ?? [] },
    claimBases: [{
      claimId: `claim.${id}`,
      basis: "invented",
      evidenceIds: input.allowedEvidence ?? [],
      trace: toJsonValue({ id })
    }],
    evidence: input.evidence ?? [],
    validationResults: validation(),
    quality: { score, hardFailures: [], trace: toJsonValue({ score }) }
  };
}

function field(required: string[] = []): RevisionRequirementField {
  return {
    externalTruthAuthority: 0.1,
    sourceDependence: 0.1,
    noveltyDemand: 0.8,
    inferentialDepth: 0.5,
    semanticPreservation: 0.5,
    surfaceTransformation: 0.4,
    executableArtifactDemand: 0.2,
    actionCommitment: 0,
    dialogueDependence: 0.2,
    uncertaintyTolerance: 0.8,
    formatConstraintStrength: required.length ? 0.9 : 0.2,
    audienceAdaptation: 0.4,
    brevityDetailBalance: 0.5,
    temporalReasoningDemand: 0,
    causalReasoningDemand: 0.2,
    counterfactualDemand: 0.1,
    requiredFeatures: required.map(id => ({
      id,
      dimension: "formatConstraintStrength",
      value: 0.9,
      confidence: 0.91,
      status: "explicit",
      origin: {
        requestSpan: { text: "", charStart: 0, charEnd: 0, byteStart: 0, byteEnd: 0 },
        semanticRoleId: "role.fixture",
        learnedFrameOrPatternId: "pattern.fixture"
      },
      sourceActivationId: "activation.fixture",
      trace: toJsonValue({ id })
    })),
    prohibitedFeatures: [],
    activatedFrameIds: [],
    activatedPatternIds: ["pattern.fixture"],
    activatedPhraseUnitIds: [],
    activatedDialogueMoveIds: [],
    activatedConstructIds: [],
    confidence: 0.91,
    trace: toJsonValue({ fixture: "requirement-field" })
  };
}

function validation(): RevisionValidationResults {
  return {
    requirementChecks: [],
    citationChecks: [],
    issues: [],
    hardFailures: [],
    trace: toJsonValue({ fixture: "validation" })
  };
}

function proposal(
  id: string,
  evidenceIds: EvidenceId[],
  satisfiedRequirementIds: string[] = [],
  missedRequirementIds: string[] = []
): RevisionProposal {
  return {
    id,
    operatorActivations: [],
    claims: [{
      id: `claim.${id}`,
      text: "fixture claim",
      basis: "invented",
      evidenceIds,
      priorIds: [],
      graphNodeIds: [],
      graphEdgeIds: [],
      externallyFactual: false,
      hypothetical: false,
      trace: toJsonValue({ id })
    }],
    relations: [],
    steps: [],
    artifacts: [],
    evidenceIds,
    priorIds: [],
    graphNodeIds: [],
    semanticFrameIds: [],
    constructIds: [],
    satisfiedRequirementIds,
    missedRequirementIds,
    quality: {
      reasoning: {
        premiseValidity: 1,
        relationContinuity: 1,
        requirementCoverage: 1,
        explanatoryPower: 0.8,
        contradictionHandling: 1,
        temporalConsistency: 1,
        simplicity: 0.8,
        usefulness: 0.8,
        unsupportedLeapRate: 0,
        internalContradiction: 0,
        score: 0.8
      },
      baseQuality: 0.8,
      diversity: 0.8,
      mmr: 0.8,
      hardFailures: []
    },
    trace: toJsonValue({ id })
  };
}

function candidate(id: string, evidenceIds: EvidenceId[]): CandidateSurface {
  return {
    id,
    kind: "creative-candidate",
    answer: "candidate draft",
    force: "invented",
    evidenceIds,
    scores: {
      support: 0,
      contradiction: 0,
      faithfulness: 1,
      alphaPressure: 0,
      actionability: 0.8,
      evidenceCoverage: 1,
      novelty: 0.8,
      realizability: 0.8
    },
    boundaries: [],
    audit: toJsonValue({ fixture: id })
  };
}

function evidence(id: EvidenceId): EvidenceSpan {
  return { id } as EvidenceSpan;
}
