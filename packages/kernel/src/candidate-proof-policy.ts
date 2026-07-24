import type { CandidateSurface } from "./candidate.js";
import { jsonRecord } from "./kernel-answer-primitives.js";
import { toJsonValue } from "./primitives.js";
import type { TurnResult } from "./types.js";

export function selectedCandidateEntailment(
  entailment: TurnResult["entailment"],
  selected: CandidateSurface
): TurnResult["entailment"] {
  const candidateOwnsPlanSemantics = candidateUsesNonFactualPlanSemantics(selected);
  const support = candidateOwnsPlanSemantics ? selected.scores.support : entailment.support;
  const contradiction = candidateOwnsPlanSemantics ? selected.scores.contradiction : entailment.contradiction;
  if (selected.force === entailment.force) {
    return {
      ...entailment,
      support,
      contradiction,
      evidenceIds: [...selected.evidenceIds],
      boundaries: [...new Set([...entailment.boundaries, `selected-candidate:${selected.id}`])]
    };
  }
  return {
    ...entailment,
    force: selected.force,
    support,
    contradiction,
    evidenceIds: [...selected.evidenceIds],
    proof: {
      ...entailment.proof,
      verdict: selected.force,
      confidence: toJsonValue({
        ...jsonRecord(entailment.proof.confidence),
        selectedCandidateId: selected.id,
        selectedCandidateKind: selected.kind,
        selectedCandidateForce: selected.force,
        originalEntailmentForce: entailment.force
      }),
      scores: {
        ...jsonRecord(entailment.proof.scores),
        selectedCandidate: toJsonValue({
          id: selected.id,
          kind: selected.kind,
          force: selected.force,
          evidenceIds: selected.evidenceIds.map(String),
          boundaries: selected.boundaries
        })
      }
    },
    confidence: {
      ...entailment.confidence,
      verdict: selected.force === "unknown" ? "unknown" : entailment.confidence.verdict
    },
    boundaries: [...new Set([...entailment.boundaries, `selected-candidate:${selected.id}`, `selected-force:${selected.force}`])]
  };
}

export function candidateUsesNonFactualPlanSemantics(selected: CandidateSurface): boolean {
  return selected.kind === "program-proposal"
    || selected.kind === "workspace-proposal"
    || selected.kind === "action-preview"
    || selected.kind === "translation"
    || selected.kind === "transformation"
    || selected.kind === "creative-candidate";
}

export function candidateIsSafeNonExecutingPlan(selected: CandidateSurface): boolean {
  if (selected.kind !== "program-proposal" && selected.kind !== "workspace-proposal") return false;
  const audit = jsonRecord(selected.audit);
  return audit.authorizationGranted === false
    && audit.executionState === "not_executed"
    && selected.boundaries.includes("workspace-plan-not-authorized")
    && selected.boundaries.includes("workspace-plan-not-executed")
    && !selected.claimBases?.includes("action_result");
}
