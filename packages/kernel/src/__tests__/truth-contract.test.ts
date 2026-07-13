import { describe, expect, it } from "vitest";
import { evidenceForceFromProofForceClass, truthStateFromProofVerdict, isUnsupportedTruthState } from "../truth-contract.js";

describe("truth contract", () => {
  it("maps proof force classes into typed evidence forces", () => {
    expect(evidenceForceFromProofForceClass("direct_evidence")).toBe("evidence.direct_source_span");
    expect(evidenceForceFromProofForceClass("profile_excerpt_evidence")).toBe("evidence.source_bound_profile_excerpt");
    expect(evidenceForceFromProofForceClass("learned_language_prior")).toBe("evidence.learned_prior");
    expect(evidenceForceFromProofForceClass("unknown_prior")).toBe("evidence.unknown_prior");
  });

  it("maps verdicts into typed truth states and unsupported guards", () => {
    expect(truthStateFromProofVerdict("certified")).toBe("truth.certified");
    expect(truthStateFromProofVerdict("unsupported_prior_only")).toBe("truth.unsupported_prior_only");
    expect(truthStateFromProofVerdict("insufficient_evidence")).toBe("truth.insufficient_evidence");
    expect(isUnsupportedTruthState("truth.unsupported_prior_only")).toBe(true);
    expect(isUnsupportedTruthState("truth.certified")).toBe(false);
  });
});
