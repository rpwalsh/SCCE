import { describe, expect, it } from "vitest";
import { assistantForceClass, assistantForceDecision, type EvidenceId } from "../index.js";

describe("assistant force classes", () => {
  const evidence = "evidence:direct" as EvidenceId;

  it("maps certified direct proof to certified_fact", () => {
    expect(assistantForceClass({
      epistemicForce: "proved",
      proofVerdict: "certified",
      evidenceIds: [evidence],
      directEvidenceIds: [evidence],
      support: 0.92
    })).toBe("certified_fact");
  });

  it("separates source-grounded, learned, reasoned, conjectural, creative, and translation answers", () => {
    expect(assistantForceClass({ epistemicForce: "observed", evidenceIds: [evidence], directEvidenceIds: [evidence], support: 0.64 })).toBe("source_grounded_answer");
    expect(assistantForceClass({ forceClass: "learned_concept_prior", evidenceIds: ["prior:1"], learnedPriorEvidenceIds: ["prior:1"], support: 0.58 })).toBe("learned_corpus_answer");
    expect(assistantForceClass({ epistemicForce: "inferred", support: 0.48 })).toBe("reasoned_answer");
    expect(assistantForceClass({ epistemicForce: "conjectured", support: 0.25 })).toBe("conjecture");
    expect(assistantForceClass({ epistemicForce: "invented", outputForce: "creative" })).toBe("creative_answer");
    expect(assistantForceClass({ epistemicForce: "observed", constructForces: ["TranslationConstruct"], targetLanguageChanged: true })).toBe("translation_answer");
  });

  it("routes contradiction and missing support to insufficient_support", () => {
    expect(assistantForceClass({ epistemicForce: "proved", proofVerdict: "contradicted", contradiction: 0.86 })).toBe("insufficient_support");
    expect(assistantForceClass({ epistemicForce: "unknown", proofVerdict: "insufficient_evidence", support: 0.02 })).toBe("insufficient_support");
  });

  it("keeps claim bases separate while a source-informed invention remains creative overall", () => {
    const decision = assistantForceDecision({
      epistemicForce: "observed",
      evidenceIds: [evidence],
      directEvidenceIds: [evidence],
      selectedProposal: {
        id: "proposal:source-informed-invention",
        claims: [
          { id: "claim:premise", basis: "direct_evidence", evidenceIds: [evidence] },
          { id: "claim:design", basis: "invented" },
          { id: "claim:effect", basis: "conjectured" }
        ]
      }
    });

    expect(decision.force).toBe("creative_answer");
    expect(decision.audit).toMatchObject({
      selectedProposalId: "proposal:source-informed-invention",
      claimBasis: [
        { claimId: "claim:premise", basis: "direct_evidence", force: "source_grounded_answer" },
        { claimId: "claim:design", basis: "invented", force: "creative_answer" },
        { claimId: "claim:effect", basis: "conjectured", force: "conjecture" }
      ]
    });
  });

  it("keeps translation and invention constructs ahead of incidental direct evidence", () => {
    expect(assistantForceDecision({
      evidenceIds: [evidence],
      directEvidenceIds: [evidence],
      selectedProposal: {
        id: "proposal:translated",
        claims: [
          { id: "claim:source", basis: "direct_evidence", evidenceIds: [evidence] },
          { id: "claim:translation", basis: "translated" },
          { id: "claim:wording", basis: "invented" }
        ]
      }
    }).force).toBe("translation_answer");
  });

  it("certifies only supported direct claims and preserves structural inference mappings", () => {
    const certified = assistantForceDecision({
      epistemicForce: "proved",
      proofVerdict: "certified",
      evidenceIds: [evidence],
      directEvidenceIds: [evidence],
      selectedProposal: {
        id: "proposal:certified",
        claims: [{ id: "claim:fact", basis: "direct_evidence", evidenceIds: [evidence] }]
      }
    });
    expect(certified.force).toBe("certified_fact");

    const derived = assistantForceDecision({
      selectedProposal: {
        id: "proposal:derived",
        claims: [
          { id: "claim:reason", basis: "reasoned_inference" },
          { id: "claim:forecast", basis: "conjectured" },
          { id: "claim:unsupported", basis: "unsupported" }
        ]
      }
    });
    expect(derived.force).toBe("reasoned_answer");
    expect(derived.audit).toMatchObject({
      claimBasis: [
        { claimId: "claim:reason", force: "reasoned_answer" },
        { claimId: "claim:forecast", force: "conjecture" },
        { claimId: "claim:unsupported", force: "insufficient_support" }
      ]
    });
  });

  it("never treats an action-result reference as proof without a matching durable receipt", () => {
    const selectedProposal = {
      id: "proposal:action",
      claims: [
        { id: "claim:premise", basis: "direct_evidence" as const, evidenceIds: [evidence] },
        { id: "claim:action", basis: "action_result" as const, actionReceiptId: "receipt:action", actionStatus: "succeeded" as const }
      ]
    };
    const missingReceipt = assistantForceDecision({ selectedProposal, evidenceIds: [evidence], directEvidenceIds: [evidence] });
    expect(missingReceipt.force).toBe("insufficient_support");
    expect(missingReceipt.reasonIds).toContain("assistant_force.action_result_without_durable_receipt");

    const mismatchedOutcome = assistantForceDecision({
      selectedProposal,
      evidenceIds: [evidence],
      directEvidenceIds: [evidence],
      actionReceipts: [{
        id: "receipt:action",
        durable: true,
        status: "failed",
        receiptHash: `sha256:${"a".repeat(64)}` as `sha256:${string}`
      }]
    });
    expect(mismatchedOutcome.force).toBe("insufficient_support");

    const verified = assistantForceDecision({
      selectedProposal,
      evidenceIds: [evidence],
      directEvidenceIds: [evidence],
      actionReceipts: [{
        id: "receipt:action",
        durable: true,
        status: "succeeded",
        receiptHash: `sha256:${"b".repeat(64)}` as `sha256:${string}`
      }]
    });
    expect(verified.force).toBe("action_result");
    expect(verified.audit).toMatchObject({
      durableReceiptCount: 1,
      invalidActionClaimIds: [],
      claimBasis: [
        { claimId: "claim:premise", force: "source_grounded_answer" },
        { claimId: "claim:action", verifiedActionReceipt: true, force: "action_result" }
      ]
    });
  });
});
