// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { assistantForceDecision } from "../assistant-force.js";

// When two sources disagree the turn reports each of them and asserts neither. The force has to say that, because
// every consumer downstream gates on it: calling the report "insufficient_support" told a caller the answer was
// unusable while handing it a complete, cited account of the disagreement, and the answer worth reading was the one
// being discarded. The proposal path had to be decided before, not after -- it reasons about how well each claim is
// supported, and every claim it can see states one side, so it resolved the whole turn to unsupported.
describe("the force of an answer that reports disagreeing sources", () => {
  const contradictedProof = {
    epistemicForce: "observed" as const,
    proofVerdict: "scce.verdict.001",
    evidenceIds: ["evidence_session_a", "evidence_session_b"],
    directEvidenceIds: ["evidence_session_a", "evidence_session_b"],
    support: 0.41,
    contradiction: 0.52
  };

  it("reports the conflict rather than claiming insufficient support", () => {
    const decision = assistantForceDecision({ ...contradictedProof, reportsSourceConflict: true });

    expect(decision.force).toBe("source_conflict_reported");
    expect(decision.reasonIds).toContain("assistant_force.source_conflict_reported");
  });

  it("outranks the per-claim proposal path, whose claims each state one side", () => {
    const decision = assistantForceDecision({
      ...contradictedProof,
      reportsSourceConflict: true,
      selectedProposal: {
        claims: [
          { id: "claim.a", basis: "direct_evidence", evidenceIds: ["evidence_session_a"] },
          { id: "claim.b", basis: "direct_evidence", evidenceIds: ["evidence_session_b"] }
        ]
      } as unknown as Parameters<typeof assistantForceDecision>[0]["selectedProposal"]
    });

    expect(decision.force).toBe("source_conflict_reported");
  });

  it("still calls a contradicted claim unsupported when no conflict is being reported", () => {
    const decision = assistantForceDecision({ ...contradictedProof, reportsSourceConflict: false });

    expect(decision.force).toBe("insufficient_support");
    expect(decision.reasonIds).toContain("assistant_force.contradiction_pressure");
  });

  it("does not fire on an ordinary supported answer", () => {
    const decision = assistantForceDecision({
      epistemicForce: "observed",
      proofVerdict: "scce.verdict.003",
      evidenceIds: ["evidence.a"],
      directEvidenceIds: ["evidence.a"],
      support: 0.8,
      contradiction: 0.05,
      reportsSourceConflict: true
    });

    expect(decision.force).not.toBe("source_conflict_reported");
  });
});
