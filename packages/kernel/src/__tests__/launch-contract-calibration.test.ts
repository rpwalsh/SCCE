// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, afterEach } from "vitest";
import { launchContractForTurn } from "../launch-contract.js";
import { PUBLIC_CALIBRATIONS } from "../calibrations/public-calibrations.js";
import { clearProdCalibrations, installProdCalibrations } from "../calibrations/prod-calibrations.js";
import type { EvidenceSpan, SemanticEntailmentResult } from "../types.js";

/** The id a live 422 carried at 9f82d0a when this constant refused a real question. */
const CONTRADICTION_REASON_ID = "basis.reason.403af5b6";

afterEach(() => clearProdCalibrations());

const span = (id: string): EvidenceSpan => ({
  id,
  documentId: "doc.1",
  text: "The program planner compiles an executable artifact plan.",
  start: 0,
  end: 56,
  createdAt: 1_000
} as unknown as EvidenceSpan);

/** Only the fields launch-contract's truth-state, basis and reliability decisions read. */
function entailment(values: { support: number; contradiction: number; faithfulnessLcb: number; evidenceIds: string[] }): SemanticEntailmentResult {
  return {
    claim: { id: "claim.1", text: "x" },
    verdict: "underdetermined",
    semanticVerdict: "underdetermined",
    force: "inferred",
    support: values.support,
    contradiction: values.contradiction,
    faithfulnessLcb: values.faithfulnessLcb,
    confidence: { lo: 0, point: 0, hi: 0 },
    scores: {},
    obligations: [],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    proof: { id: "proof.1" },
    evidenceIds: values.evidenceIds,
    boundaries: []
  } as unknown as SemanticEntailmentResult;
}

const contract = (values: Parameters<typeof entailment>[0], evidence: readonly EvidenceSpan[] = [span("ev.1")]) =>
  launchContractForTurn({ entailment: entailment(values), evidence, evidenceForce: undefined, now: 2_000 } as never);

describe("launch-contract reads its deciding constants from the calibration registry", () => {
  it("declares every constant it decides truth state and certification with", () => {
    for (const id of [
      "launch_contract.contradiction_reason_floor",
      "launch_contract.contradicted_truth_state_floor",
      "launch_contract.certified_support_floor",
      "launch_contract.certified_faithfulness_floor",
      "launch_contract.reliability_support_weight",
      "launch_contract.reliability_faithfulness_weight",
      "launch_contract.reliability_noncontradiction_weight",
      "launch_contract.reliability_high_floor",
      "launch_contract.reliability_medium_floor"
    ] as const) {
      expect(PUBLIC_CALIBRATIONS[id], id).toBeTypeOf("number");
    }
  });

  it("keeps the shipped behaviour with no production profile installed", () => {
    // The declared values were moved verbatim, so 0.06 still trips the contradiction reason at the bootstrap.
    const fields = contract({ support: 0.9, contradiction: 0.06, faithfulnessLcb: 0.9, evidenceIds: ["ev.1"] });
    expect(fields.answerBasis!.reasonIds).toContain(CONTRADICTION_REASON_ID);
    expect(fields.guardFlags.exposeContradiction).toBe(true);
    expect(fields.truthState.symbolicState).toBe("truth.certified");
  });

  it("moves the contradiction reason when the registry value moves", () => {
    installProdCalibrations({ "launch_contract.contradiction_reason_floor": 0.2 });
    const fields = contract({ support: 0.9, contradiction: 0.06, faithfulnessLcb: 0.9, evidenceIds: ["ev.1"] });
    expect(fields.answerBasis!.reasonIds).not.toContain(CONTRADICTION_REASON_ID);
    expect(fields.guardFlags.exposeContradiction).toBe(false);
    expect(fields.guardFlags.blockCertifiedFact).toBe(false);
  });

  it("moves the certification gate when the registry value moves", () => {
    installProdCalibrations({ "launch_contract.certified_support_floor": 0.95 });
    const fields = contract({ support: 0.9, contradiction: 0, faithfulnessLcb: 0.9, evidenceIds: ["ev.1"] });
    expect(fields.truthState.symbolicState).not.toBe("truth.certified");
  });

  it("moves the contradicted truth state when the registry value moves", () => {
    installProdCalibrations({ "launch_contract.contradicted_truth_state_floor": 0.1 });
    const fields = contract({ support: 0.9, contradiction: 0.2, faithfulnessLcb: 0.9, evidenceIds: ["ev.1"] });
    expect(fields.truthState.symbolicState).toBe("truth.contradicted");
  });

  it("moves the reliability bucket when the registry value moves", () => {
    const shipped = contract({ support: 0.9, contradiction: 0, faithfulnessLcb: 0.9, evidenceIds: ["ev.1"] });
    expect(shipped.calibration!.reliabilityBucket).toBe("high");
    installProdCalibrations({ "launch_contract.reliability_high_floor": 0.99 });
    const moved = contract({ support: 0.9, contradiction: 0, faithfulnessLcb: 0.9, evidenceIds: ["ev.1"] });
    expect(moved.calibration!.reliabilityBucket).toBe("medium");
  });
});
