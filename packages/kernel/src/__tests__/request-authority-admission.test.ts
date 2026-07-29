import { describe, expect, it } from "vitest";
import type { CandidateField, CandidateSurface } from "../candidate.js";
import { createJudge } from "../judge.js";
import {
  admitCandidatesForAuthority,
  candidateCompatibleWithAuthority,
  explicitAuthorityRequirements
} from "../request-authority.js";
import { DEFAULT_POLICY } from "../safety.js";
import { deriveTurnRequirementField } from "../turn-requirements.js";
import type { ValidationGraph } from "../types.js";

describe("requested-authority candidate admission", () => {
  it("keeps every candidate kind eligible for translation, recording compatibility only in the audit", () => {
    // There is no such thing as a "translation turn" that other candidate
    // kinds are barred from -- admitCandidatesForAuthority no longer drops
    // anything. The projected authority's compatibility is still computed
    // and recorded for observability/judge-signal purposes, it just isn't
    // a hard filter anymore.
    const translated = candidate("translated", "translation", ["translated"]);
    const genericTransformation = candidate("generic", "transformation", ["learned_prior"]);
    const unlicensedTranslation = candidate("unlicensed", "translation", ["learned_prior"]);
    const field = candidateField([genericTransformation, unlicensedTranslation, translated]);

    const admitted = admitCandidatesForAuthority(field, "translation");

    expect(admitted.candidates).toEqual(field.candidates);
    expect(admitted.surfaceMass).toEqual(field.surfaceMass);
    expect(candidateCompatibleWithAuthority(genericTransformation, "translation")).toBe(false);
    expect(candidateCompatibleWithAuthority(unlicensedTranslation, "translation")).toBe(false);
    expect(candidateCompatibleWithAuthority(translated, "translation")).toBe(true);
    const audit = JSON.stringify(admitted.audit);
    expect(audit).toContain(`"compatibleCandidateIds":["${translated.id}"]`);
    expect(audit).toContain(`"admittedCandidateIds":["${genericTransformation.id}","${unlicensedTranslation.id}","${translated.id}"]`);
  });

  it("keeps the full field for program authority and never reports a false authorityUnavailable", () => {
    const proof = candidate("proof", "proof-answer", ["direct_evidence"]);
    const program = candidate("program", "program-proposal", ["learned_prior"]);
    const workspace = candidate("workspace", "workspace-proposal", ["learned_prior"]);
    const mixed = candidateField([proof, program, workspace]);

    const admitted = admitCandidatesForAuthority(mixed, "program");
    expect(admitted.candidates).toEqual(mixed.candidates);
    expect(admitted.surfaceMass).toEqual(mixed.surfaceMass);
    expect(JSON.stringify(admitted.audit)).toContain(`"compatibleCandidateIds":["${program.id}","${workspace.id}"]`);

    // A generated candidate is never dropped just because it doesn't match
    // the projected authority -- it can still win in the judge on its own
    // merits. authorityUnavailable now means literally zero candidates
    // were generated at all, not "zero candidates matched this authority."
    const withoutProgramFamily = candidateField([proof]);
    const stillPresent = admitCandidatesForAuthority(withoutProgramFamily, "program");
    expect(stillPresent.candidates).toEqual([proof]);
    expect(JSON.stringify(stillPresent.audit)).toContain('"authorityUnavailable":false');
  });

  it("does not select an exact action candidate that fails receipt checks", () => {
    const unsafeAction = candidate("unsafe-action", "action-preview", ["action_result"]);
    const admitted = admitCandidatesForAuthority(candidateField([unsafeAction]), "action");
    const requirementField = deriveTurnRequirementField({
      requestText: "Execute the requested action.",
      explicitRequirements: explicitAuthorityRequirements({
        requestText: "Execute the requested action.",
        authority: "action",
        sourceId: "request-authority-admission.test"
      })
    });

    expect(() => createJudge({ random: () => 0.5 }).select({
      field: admitted,
      policy: DEFAULT_POLICY,
      requestedAuthority: "action",
      requirementField,
      deterministicReplay: true
    })).toThrow("judge received no admissible candidates");
  });

  it("does not select an exact program candidate that fails executable validation", () => {
    const program = candidate("failed-program", "program-proposal", ["learned_prior"]);
    const admitted = admitCandidatesForAuthority(candidateField([program]), "program");
    const requestText = "Prepare a validated program repair.";
    const requirementField = deriveTurnRequirementField({
      requestText,
      explicitRequirements: explicitAuthorityRequirements({
        requestText,
        authority: "program",
        sourceId: "request-authority-admission.test"
      })
    });
    const failedValidation: ValidationGraph = {
      id: "validation:failed-program" as ValidationGraph["id"],
      constructId: "construct:failed-program" as ValidationGraph["constructId"],
      checks: [{
        id: "typecheck",
        status: "failed",
        score: 0,
        message: "fixture validation failure",
        evidenceIds: []
      }],
      passed: false
    };

    expect(() => createJudge({ random: () => 0.5 }).select({
      field: admitted,
      policy: DEFAULT_POLICY,
      validation: failedValidation,
      requestedAuthority: "program",
      requirementField,
      deterministicReplay: true
    })).toThrow("judge received no admissible candidates");
  });
});

function candidate(
  id: string,
  kind: CandidateSurface["kind"],
  claimBases: CandidateSurface["claimBases"]
): CandidateSurface {
  return {
    id,
    kind,
    answer: `${id} answer`,
    force: "inferred",
    evidenceIds: [],
    scores: {
      support: 0.5,
      contradiction: 0,
      faithfulness: 0.5,
      alphaPressure: 0.5,
      actionability: 0.5,
      evidenceCoverage: 0.5,
      novelty: 0.5,
      realizability: 0.5
    },
    claimBases,
    boundaries: [],
    audit: {}
  };
}

function candidateField(candidates: CandidateSurface[]): CandidateField {
  return {
    candidates,
    surfaceMass: candidates.map((row, index) => ({
      candidateId: row.id,
      mass: (index + 1) / candidates.reduce((sum, _candidate, candidateIndex) => sum + candidateIndex + 1, 0),
      reason: "fixture"
    })),
    audit: { fixture: true },
    scoreTrace: []
  };
}
