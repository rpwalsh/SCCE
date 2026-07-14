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
  it("admits only translated-basis translation candidates for translation", () => {
    const translated = candidate("translated", "translation", ["translated"]);
    const genericTransformation = candidate("generic", "transformation", ["learned_prior"]);
    const unlicensedTranslation = candidate("unlicensed", "translation", ["learned_prior"]);
    const field = candidateField([genericTransformation, unlicensedTranslation, translated]);

    const admitted = admitCandidatesForAuthority(field, "translation");

    expect(admitted.candidates.map(row => row.id)).toEqual([translated.id]);
    expect(admitted.surfaceMass.reduce((sum, row) => sum + row.mass, 0)).toBeCloseTo(1, 12);
    expect(candidateCompatibleWithAuthority(genericTransformation, "translation")).toBe(false);
    expect(candidateCompatibleWithAuthority(unlicensedTranslation, "translation")).toBe(false);
  });

  it("admits the program family and never reopens unrelated candidates", () => {
    const proof = candidate("proof", "proof-answer", ["direct_evidence"]);
    const program = candidate("program", "program-proposal", ["learned_prior"]);
    const workspace = candidate("workspace", "workspace-proposal", ["learned_prior"]);
    const mixed = candidateField([proof, program, workspace]);

    const admitted = admitCandidatesForAuthority(mixed, "program");
    expect(admitted.candidates.map(row => row.id)).toEqual([program.id, workspace.id]);
    expect(admitted.surfaceMass.reduce((sum, row) => sum + row.mass, 0)).toBeCloseTo(1, 12);

    const withoutProgramFamily = candidateField([proof]);
    const unavailable = admitCandidatesForAuthority(withoutProgramFamily, "program");
    expect(unavailable.candidates).toEqual([]);
    expect(unavailable.surfaceMass).toEqual([]);
    expect(JSON.stringify(unavailable.audit)).toContain('"authorityUnavailable":true');
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
