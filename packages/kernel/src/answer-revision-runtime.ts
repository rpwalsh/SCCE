import type {
  RevisionAnswerVersion,
  RevisionValidationResults
} from "./answer-revision.js";
import type { CandidateSurface } from "./candidate.js";
import type { CognitiveProposal } from "./cognitive-planner.js";
import { updateDialogueState } from "./dialogue-pragmatics.js";
import type { JudgeDecision } from "./judge.js";
import type { SpokenOutput } from "./mouth.js";
import { toJsonValue } from "./primitives.js";
import type { EvidenceSpan, TurnResult } from "./types.js";

export function selectedCandidateRevisionQuality(judged: JudgeDecision, spoken: SpokenOutput): number {
  const judgeScore = judged.scores.find(row => row.candidateId === judged.selected.id)?.score ?? 0;
  const mouthScore = spoken.realizationTrace.candidates.find(row => row.id === spoken.realizationTrace.selected.id)?.score ?? 0;
  return Math.max(
    0,
    Math.min(
      1,
      0.56 * Math.max(0, Math.min(1, judgeScore))
        + 0.44 * Math.max(0, Math.min(1, mouthScore))
    )
  );
}

export function revisionAnswerVersion(input: {
  id: string;
  proposal: CognitiveProposal;
  candidate: CandidateSurface;
  spoken: SpokenOutput;
  evidence: readonly EvidenceSpan[];
  dialogueState: ReturnType<typeof updateDialogueState>;
  validation: TurnResult["validationGraph"];
  quality: number;
}): RevisionAnswerVersion {
  const validationResults = revisionValidationResults(input);
  return {
    id: input.id,
    selectedProposal: input.proposal,
    selectedCandidate: input.candidate,
    mouthOutput: { text: input.spoken.text, evidenceRefs: input.spoken.evidenceRefs },
    claimBases: input.proposal.claims.map(claim => ({
      claimId: claim.id,
      basis: claim.basis,
      evidenceIds: claim.evidenceIds,
      trace: claim.trace
    })),
    evidence: input.evidence,
    dialogueState: input.dialogueState,
    validationResults,
    quality: {
      score: input.quality,
      hardFailures: validationResults.hardFailures,
      trace: toJsonValue({
        source: "judge_and_mouth",
        score: input.quality,
        candidateId: input.candidate.id,
        mouthCandidateId: input.spoken.realizationTrace.selected.id
      })
    }
  };
}

function revisionValidationResults(input: {
  proposal: CognitiveProposal;
  candidate: CandidateSurface;
  spoken: SpokenOutput;
  evidence: readonly EvidenceSpan[];
  validation: TurnResult["validationGraph"];
}): RevisionValidationResults {
  const satisfied = new Set(input.proposal.satisfiedRequirementIds);
  const evidenceIds = new Set(input.evidence.map(span => String(span.id)));
  const proposalEvidenceIds = new Set([
    ...input.proposal.evidenceIds.map(String),
    ...input.proposal.claims.flatMap(claim => claim.evidenceIds.map(String))
  ]);
  const issues: Array<RevisionValidationResults["issues"][number]> = [];
  const hardFailures: Array<RevisionValidationResults["hardFailures"][number]> = [];
  const quality = input.candidate.quality;
  if ((quality?.telemetryLeak ?? 0) > 0) {
    issues.push({
      kind: "telemetry_leak",
      severity: "hard_failure",
      correction: "remove_telemetry",
      confidence: 1,
      trace: toJsonValue({ candidateId: input.candidate.id })
    });
    hardFailures.push({
      id: "revision.hard.telemetry_leak.v1",
      kind: "telemetry_leak",
      trace: input.candidate.audit
    });
  }
  if ((quality?.fakeFactualAuthority ?? 0) > 0 || (quality?.unsupportedFactRate ?? 0) > 0) {
    issues.push({
      kind: (quality?.fakeFactualAuthority ?? 0) > 0 ? "citation_mismatch" : "unsupported_factual_claim",
      severity: (quality?.fakeFactualAuthority ?? 0) > 0 ? "hard_failure" : "error",
      correction: (quality?.fakeFactualAuthority ?? 0) > 0 ? "repair_citation_binding" : "ground_or_qualify_claim",
      confidence: Math.max(quality?.fakeFactualAuthority ?? 0, quality?.unsupportedFactRate ?? 0),
      trace: input.candidate.audit
    });
  }
  if ((quality?.testWeakening ?? 0) > 0) {
    issues.push({
      kind: "test_weakening",
      severity: "hard_failure",
      correction: "restore_test_strength",
      confidence: 1,
      trace: input.candidate.audit
    });
    hardFailures.push({
      id: "revision.hard.test_weakening.v1",
      kind: "test_weakening",
      trace: input.candidate.audit
    });
  }
  return {
    validationGraph: input.validation,
    requirementChecks: [
      ...input.proposal.satisfiedRequirementIds.map(requirementId => ({
        requirementId,
        satisfied: true,
        confidence: 1,
        trace: toJsonValue({ proposalId: input.proposal.id })
      })),
      ...input.proposal.missedRequirementIds.map(requirementId => ({
        requirementId,
        satisfied: satisfied.has(requirementId),
        confidence: 1,
        trace: toJsonValue({ proposalId: input.proposal.id })
      }))
    ],
    citationChecks: input.spoken.evidenceRefs.map(evidenceId => ({
      evidenceId,
      matched: evidenceIds.has(String(evidenceId)) && proposalEvidenceIds.has(String(evidenceId)),
      confidence: 1,
      trace: toJsonValue({
        evidenceId,
        existsInTurnEvidence: evidenceIds.has(String(evidenceId)),
        licensedByProposal: proposalEvidenceIds.has(String(evidenceId))
      })
    })),
    issues,
    hardFailures,
    trace: toJsonValue({
      schema: "scce.answer_revision.validation.v1",
      validationGraphId: input.validation.id,
      validationPassed: input.validation.passed,
      proposalId: input.proposal.id,
      candidateId: input.candidate.id
    })
  };
}
