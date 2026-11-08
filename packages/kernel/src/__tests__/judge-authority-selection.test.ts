// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createJudge } from "../judge.js";
import { admitCandidatesForAuthority } from "../request-authority.js";
import { DEFAULT_POLICY } from "../safety.js";
import type { CandidateField } from "../candidate-contract.js";
import type { CalibrationModelSet, JudgeRequirementModel } from "../calibration-spine.js";
import type { TurnRequirementField } from "../turn-requirements.js";

const captured = JSON.parse(readFileSync(new URL("./fixtures/creative-authority-selection-live.json", import.meta.url), "utf8")) as {
  field: CandidateField;
  requirementField: TurnRequirementField;
  expectedCandidateId: string;
  judgeRequirementModels: Record<string, JudgeRequirementModel>;
  capturedJudge: { rows: Array<{ candidateId: string; rawScore: number }> };
};

const calibrationModelSet: CalibrationModelSet = { schema: "scce.calibration.model_set.v1", id: "captured.creative.judge",
  models: {}, judgeRequirementModels: captured.judgeRequirementModels, observationCount: 83, createdAt: 0 };

describe("canonical candidate authority selection", () => {
  it("does not substitute factual premises when creative content is unavailable", () => {
    const generated = structuredClone(captured.field);
    generated.candidates = generated.candidates.filter(row => row.kind !== "creative-candidate");
    generated.surfaceMass = generated.surfaceMass.filter(row => generated.candidates.some(candidate => candidate.id === row.candidateId));
    expect(generated.candidates.length).toBeGreaterThan(0);
    const admitted = admitCandidatesForAuthority(generated, "creative");
    expect(admitted.candidates).toEqual([]);
    expect(admitted.surfaceMass).toEqual([]);
    expect(admitted.audit).toMatchObject({ authorityAdmission: {
      generatedCandidateCount: generated.candidates.length, authorityUnavailable: true, fallbackToGeneratedField: false
    } });
    const stale = { ...generated, authorityAdmission: admitted.authorityAdmission };
    expect(() => createJudge().select({ field: stale, policy: DEFAULT_POLICY, requestedAuthority: "creative",
      requirementField: captured.requirementField, deterministicReplay: true }))
      .toThrow("judge received no admissible candidates");
  });

  it("consumes the live creative field's existing admission instead of independently selecting a reasoned hypothesis", () => {
    const field = admitCandidatesForAuthority(structuredClone(captured.field), "creative");
    expect(field.candidates).toHaveLength(5);
    expect(field.surfaceMass.find(row => row.candidateId === captured.expectedCandidateId)?.mass).toBe(1);
    expect(field.surfaceMass.filter(row => row.candidateId !== captured.expectedCandidateId).every(row => row.mass === 0)).toBe(true);
    const decision = createJudge().select({ field, policy: DEFAULT_POLICY, requestedAuthority: "creative",
      requirementField: captured.requirementField, calibrationModelSet, deterministicReplay: true });
    const actualRows = (decision.audit as { rows: Array<{ candidateId: string; rawScore: number }> }).rows;
    for (const row of captured.capturedJudge.rows) expect(actualRows.find(actual => actual.candidateId === row.candidateId)?.rawScore).toBeCloseTo(row.rawScore, 12);
    expect(decision.selected.id).toBe(captured.expectedCandidateId);
    expect(decision.rejected).toHaveLength(4);
    for (const row of decision.rejected) expect(row.reasons).toContain("hard-failure:authority_selection_mismatch");
    expect(field.candidates).toHaveLength(5);
  });

  it("preserves proof guards after authority admission", () => {
    const field = structuredClone(captured.field);
    field.candidates.find(row => row.id === captured.expectedCandidateId)!.quality!.fakeFactualAuthority = 1;
    expect(() => createJudge().select({ field: admitCandidatesForAuthority(field, "creative"), policy: DEFAULT_POLICY,
      requestedAuthority: "creative", requirementField: captured.requirementField, calibrationModelSet, deterministicReplay: true }))
      .toThrow("judge received no admissible candidates");
  });

  it("keeps exploration inside the same admitted candidate set", () => {
    const decision = createJudge({ random: () => 0 }).select({ field: admitCandidatesForAuthority(structuredClone(captured.field), "creative"),
      policy: DEFAULT_POLICY, requestedAuthority: "creative", requirementField: captured.requirementField, calibrationModelSet,
      deterministicReplay: false, explorationSamplingEnabled: true });
    expect(decision.selected.id).toBe(captured.expectedCandidateId);
  });
});
