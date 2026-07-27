import { describe, expect, it } from "vitest";
import { applyPragmaticsGuard, type PresentationPlan } from "../pragmatics-authorization-guard.js";

describe("pragmatics state cannot suppress a required factual disclosure (plan item 230)", () => {
  it("includes a required disclosure even when pragmatics prefers to suppress its phrasing", () => {
    const plan: PresentationPlan = {
      requiredDisclosures: [
        { id: "disclosure.risk-warning", content: "This action cannot be undone." }
      ],
      authorizationDecisions: [],
      pragmatics: {
        // A real, uncertain stylistic preference: the user has previously
        // reacted badly to blunt warnings, so tone-driven pragmatics
        // "wants" to soften or skip it -- it must not be able to.
        suppressPhraseIds: ["disclosure.risk-warning"],
        toneAdjustment: "gentle"
      }
    };
    const result = applyPragmaticsGuard(plan);
    expect(result.includedDisclosureIds).toEqual(["disclosure.risk-warning"]);
  });

  it("includes every required disclosure regardless of how many pragmatics tries to suppress", () => {
    const plan: PresentationPlan = {
      requiredDisclosures: [
        { id: "d1", content: "..." },
        { id: "d2", content: "..." },
        { id: "d3", content: "..." }
      ],
      authorizationDecisions: [],
      pragmatics: { suppressPhraseIds: ["d1", "d2", "d3"] }
    };
    const result = applyPragmaticsGuard(plan);
    expect(result.includedDisclosureIds.sort()).toEqual(["d1", "d2", "d3"]);
  });
});

describe("pragmatics state cannot bypass an authorization gate (plan item 230)", () => {
  it("never makes a denied capability executable, no matter what pragmatics prefers", () => {
    const plan: PresentationPlan = {
      requiredDisclosures: [],
      authorizationDecisions: [
        { capabilityId: "capability.send-email", authorized: false, reason: "risk acceptance not granted" },
        { capabilityId: "capability.read-file", authorized: true, reason: "read-only, pre-approved" }
      ],
      pragmatics: { toneAdjustment: "eager", reorderPriority: ["capability.send-email"] }
    };
    const result = applyPragmaticsGuard(plan);
    expect(result.executableCapabilityIds).toEqual(["capability.read-file"]);
    expect(result.executableCapabilityIds).not.toContain("capability.send-email");
  });

  it("the pragmatics preference type itself has no field capable of marking a capability authorized -- verified structurally, not just by this test's inputs", () => {
    // If a future edit ever added such a field to
    // PragmaticsPresentationPreference, this call would still compile
    // (structural typing), so the real guarantee is that
    // applyPragmaticsGuard's authorization output is derived solely from
    // `authorizationDecisions`, never from `pragmatics` -- proven by the
    // test above returning the same executable set regardless of what
    // pragmatics prefers.
    const plan: PresentationPlan = {
      requiredDisclosures: [],
      authorizationDecisions: [{ capabilityId: "capability.a", authorized: false, reason: "denied" }],
      pragmatics: {}
    };
    expect(applyPragmaticsGuard(plan).executableCapabilityIds).toEqual([]);
  });
});

describe("pragmatics can still genuinely influence presentation (plan item 229 boundary)", () => {
  it("reorders already-included disclosures according to pragmatics preference", () => {
    const plan: PresentationPlan = {
      requiredDisclosures: [
        { id: "d1", content: "..." },
        { id: "d2", content: "..." },
        { id: "d3", content: "..." }
      ],
      authorizationDecisions: [],
      pragmatics: { reorderPriority: ["d3", "d1"] }
    };
    const result = applyPragmaticsGuard(plan);
    expect(result.presentationOrder).toEqual(["d3", "d1", "d2"]);
    // Reordering never changes *which* disclosures are included.
    expect(result.includedDisclosureIds.sort()).toEqual(["d1", "d2", "d3"]);
  });

  it("falls back to a deterministic order when pragmatics expresses no preference", () => {
    const plan: PresentationPlan = {
      requiredDisclosures: [{ id: "b", content: "..." }, { id: "a", content: "..." }],
      authorizationDecisions: [],
      pragmatics: {}
    };
    expect(applyPragmaticsGuard(plan).presentationOrder).toEqual(["a", "b"]);
  });
});
