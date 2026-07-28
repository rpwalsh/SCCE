import { describe, expect, it } from "vitest";
import { assistantForceDecision, type AssistantForceClaim } from "../assistant-force.js";
import { assistantForceProposalFromCandidateClaimBasis } from "../candidate-construct-binding.js";
import type { CandidateSurface } from "../candidate-contract.js";

/**
 * These tests target the compositional-force refactor directly: a single
 * answer can legitimately mix claims with different epistemic force
 * (asserted, inferred, hypothetical, invented, translated, ...), and
 * Valid(Y) = ∧ᵢ Valid(yᵢ | force(yᵢ)) means the WHOLE answer is only valid
 * if every non-fictional unit inside it independently clears its own bar --
 * a single invented or certified claim must never be allowed to win
 * precedence and hide a different claim's real failure.
 */
describe("compositional per-claim force (Valid(Y) = ∧i Valid(yi | force(yi)))", () => {
  it("does not let a co-present invented claim mask an unsupported non-fictional claim (fiction with an unmet factual constraint)", () => {
    const claims: AssistantForceClaim[] = [
      { id: "claim.invented", basis: "invented", evidenceIds: [] },
      { id: "claim.factual.unsupported", basis: "direct_evidence", evidenceIds: [] }
    ];
    const decision = assistantForceDecision({
      requestedAuthority: "creative",
      selectedProposal: { id: "proposal.mixed", claims }
    });
    expect(decision.force).toBe("insufficient_support");
    expect(decision.unsupportedClaimIds).toEqual(["claim.factual.unsupported"]);
    expect(decision.claimDecisions.map(claim => claim.claimId)).toEqual(["claim.invented", "claim.factual.unsupported"]);
  });

  it("does not let a co-present certified claim mask a different unsupported claim either (not just the creative-specific shortcut)", () => {
    const claims: AssistantForceClaim[] = [
      { id: "claim.certified", basis: "direct_evidence", evidenceIds: ["evidence:1"], certified: true },
      { id: "claim.unsupported", basis: "learned_prior", evidenceIds: [] }
    ];
    const decision = assistantForceDecision({
      requestedAuthority: "reasoned",
      selectedProposal: { id: "proposal.mixed-factual", claims }
    });
    expect(decision.force).toBe("insufficient_support");
    expect(decision.unsupportedClaimIds).toEqual(["claim.unsupported"]);
  });

  it("never counts a hypothetical/conjectured claim as unsupported, regardless of missing evidence (preserved conditional status)", () => {
    const claims: AssistantForceClaim[] = [
      { id: "claim.conjectured", basis: "conjectured", evidenceIds: [] },
      { id: "claim.observed", basis: "direct_evidence", evidenceIds: ["evidence:1"] }
    ];
    const decision = assistantForceDecision({
      requestedAuthority: "creative",
      selectedProposal: { id: "proposal.hypothetical", claims }
    });
    expect(decision.unsupportedClaimIds).toEqual([]);
    expect(decision.force).not.toBe("insufficient_support");
  });

  it("keeps a fully-invented composed answer as creative_answer for a creative-authority turn (no spurious regression)", () => {
    const claims: AssistantForceClaim[] = [
      { id: "claim.invented.only", basis: "invented", evidenceIds: [] }
    ];
    const decision = assistantForceDecision({
      requestedAuthority: "creative",
      selectedProposal: { id: "proposal.pure-fiction", claims }
    });
    expect(decision.force).toBe("creative_answer");
    expect(decision.unsupportedClaimIds).toEqual([]);
  });

  it("lifts a creative candidate's real audit.claimBasis shape (as written by candidate.ts's creativeCandidate()) into AssistantForceClaim[]", () => {
    // Mirrors the exact JSON shape candidate.ts:1148-1166 attaches to a
    // creative-candidate's audit -- one entry per factual_premise/deduction/
    // invention/performance_prediction unit inside that one generated
    // surface (see invention-planner.ts:1391-1436's InventionClaimBasis[]).
    const candidate = {
      id: "creative:construct-1:0",
      kind: "creative-candidate",
      answer: "A grounded premise, extended into an invented continuation.",
      audit: {
        source: "invention.construct",
        claimBasis: [
          { id: "claim.premise.1", surface: "Ada Lovelace wrote notes.", force: "observed", evidenceIds: ["evidence:ada-1"], kind: "factual_premise" },
          { id: "claim.deduction.1", force: "inferred", evidenceIds: ["evidence:ada-1"], kind: "deduction" },
          { id: "claim.invention.1", surface: "the engine dreams in punch cards", force: "invented", evidenceIds: [], kind: "invention" }
        ]
      }
    } as unknown as CandidateSurface;

    const proposal = assistantForceProposalFromCandidateClaimBasis(candidate);
    expect(proposal?.id).toBe(candidate.id);
    expect(proposal?.claims).toEqual([
      { id: "claim.premise.1", basis: "direct_evidence", evidenceIds: ["evidence:ada-1"] },
      { id: "claim.deduction.1", basis: "reasoned_inference", evidenceIds: ["evidence:ada-1"] },
      { id: "claim.invention.1", basis: "invented", evidenceIds: [] }
    ]);

    const decision = assistantForceDecision({ requestedAuthority: "creative", selectedProposal: proposal });
    expect(decision.force).toBe("creative_answer");
    expect(decision.unsupportedClaimIds).toEqual([]);
  });

  it("returns undefined for a candidate with no claimBasis in its audit (flat candidates fall back to the non-compositional path unchanged)", () => {
    const candidate = {
      id: "proof-answer:1",
      kind: "proof-answer",
      answer: "Ada Lovelace wrote notes about the Analytical Engine.",
      audit: { source: "proof-answer" }
    } as unknown as CandidateSurface;
    expect(assistantForceProposalFromCandidateClaimBasis(candidate)).toBeUndefined();
  });

  it("a genuinely all-fictional creative answer never resolves to insufficient_support on its own (claim data stays informative, not a trigger)", () => {
    // production-turn-runtime.ts deliberately keeps requestedAuthority ===
    // "creative" turns exempt from the whole-turn coherence-support-failure
    // recovery/regenerate loop, even though this compositional check is now
    // real: replanning the ENTIRE turn is the wrong response to one flagged
    // sub-claim in creative content -- it can silence or rewrite freely
    // invented material, which is more "proof bound" than what was asked
    // for. The claim-level data below (unsupportedClaimIds/claimDecisions)
    // is preserved for a future targeted caveat on just the affected unit,
    // not as a full-turn veto. This test just confirms the data itself is
    // still accurate for a pure invention: no claim is ever spuriously
    // flagged, since a real invention candidate's claimBasis only contains
    // "observed"/"inferred" entries when the invention planner found real
    // grounding for them (invention-planner.ts:1391 only emits
    // factual_premise entries for graph rows that already have
    // evidenceIds), and "invented"/"conjectured" claims never fail their
    // own bar.
    const claims: AssistantForceClaim[] = [
      { id: "claim.invention.only", basis: "invented", evidenceIds: [] },
      { id: "claim.performance.conjecture", basis: "conjectured", evidenceIds: [] }
    ];
    const decision = assistantForceDecision({
      requestedAuthority: "creative",
      selectedProposal: { id: "proposal.all-fiction", claims }
    });
    expect(decision.force).not.toBe("insufficient_support");
    expect(decision.unsupportedClaimIds).toEqual([]);
  });
});
