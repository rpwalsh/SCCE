import { describe, expect, it } from "vitest";
import {
  evaluateOperatorPromotion,
  induceOperatorCandidate,
  type EpisodeTrace
} from "../induced-reasoning-operator.js";

function trace(episodeId: string, actionTypeSequence: string[], succeeded: boolean): EpisodeTrace {
  return { episodeId, actionTypeSequence, succeeded };
}

describe("operator induction from real episode traces (plan item 161)", () => {
  it("induces the genuinely repeated pattern, not a hand-authored default", () => {
    const fitTraces: EpisodeTrace[] = [
      trace("e1", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded", "MouthSpoken"], true),
      trace("e2", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded", "MouthSpoken"], true),
      trace("e3", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"], true),
      trace("e4", ["OwnerAsked", "CandidateGenerated", "MouthSpoken"], false)
    ];
    const candidate = induceOperatorCandidate(fitTraces, { minimumSupport: 3 });
    expect(candidate).toBeDefined();
    // The length-3 prefix (OwnerAsked -> CapabilityInvoked ->
    // CapabilitySucceeded) also has support 3 and, being longer, saves
    // more description length under the (support-1)*length scoring than
    // the shorter length-2 pattern -- a real, defensible MDL preference
    // for the more complete unit of induction, not an arbitrary pick.
    expect(candidate?.actionTypeSequence).toEqual(["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"]);
    expect(candidate?.supportCount).toBe(3);
    expect(candidate?.descriptionLengthSavedUnits).toBe((3 - 1) * 3);
  });

  it("returns undefined rather than a fallback default when nothing clears the minimum support bar", () => {
    const fitTraces: EpisodeTrace[] = [
      trace("e1", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"], true),
      trace("e2", ["OwnerAsked", "CandidateGenerated", "MouthSpoken"], false)
    ];
    expect(induceOperatorCandidate(fitTraces, { minimumSupport: 3 })).toBeUndefined();
  });

  it("counts support per distinct episode, not per repeated occurrence within one long episode", () => {
    const fitTraces: EpisodeTrace[] = [
      // The pattern repeats 3 times within this single episode -- must
      // still count as support 1 (there is only one episode in this fit
      // set), not 3, regardless of which specific sub-pattern the tie-break
      // among equally-scored candidates happens to pick.
      trace("e1", [
        "CapabilityInvoked", "CapabilitySucceeded",
        "CapabilityInvoked", "CapabilitySucceeded",
        "CapabilityInvoked", "CapabilitySucceeded"
      ], true)
    ];
    const candidate = induceOperatorCandidate(fitTraces, { minimumSupport: 1 });
    expect(candidate).toBeDefined();
    expect(candidate?.supportCount).toBe(1);
  });
});

describe("held-out promotion gate (plan item 162): positive held-out gain required, not just fit-set success", () => {
  const candidate = induceOperatorCandidate(
    [
      trace("f1", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"], true),
      trace("f2", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"], true),
      trace("f3", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"], true)
    ],
    { minimumSupport: 3 }
  )!;

  it("promotes when the pattern genuinely correlates with success on a disjoint held-out set", () => {
    const heldOutTraces: EpisodeTrace[] = [
      trace("h1", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"], true),
      trace("h2", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded", "MouthSpoken"], true),
      trace("h3", ["OwnerAsked", "CandidateGenerated"], false),
      trace("h4", ["OwnerAsked", "CandidateGenerated", "MouthSpoken"], false)
    ];
    const result = evaluateOperatorPromotion(candidate, heldOutTraces);
    expect(result.promoted).toBe(true);
    expect(result.heldOutGain).toBeCloseTo(1, 9);
    expect(result.reason).toBe("positive held-out outcome gain");
  });

  it("refuses to promote when the pattern appears on held-out data but shows no real advantage over the baseline -- even though every fit-set occurrence succeeded", () => {
    // The pattern succeeded in all 3 fit episodes (a naive "single-episode
    // success" check would promote it), but on disjoint held-out data it
    // succeeds at exactly the same rate as episodes without it -- no real
    // generalizing advantage, so it must not promote.
    const heldOutTraces: EpisodeTrace[] = [
      trace("h1", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"], false),
      trace("h2", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"], true),
      trace("h3", ["OwnerAsked", "CandidateGenerated"], true),
      trace("h4", ["OwnerAsked", "CandidateGenerated"], false)
    ];
    const result = evaluateOperatorPromotion(candidate, heldOutTraces);
    expect(result.promoted).toBe(false);
    expect(result.heldOutGain).toBeCloseTo(0, 9);
    expect(result.reason).toMatch(/non-positive held-out outcome gain/);
  });

  it("refuses to promote when the pattern never appears at all in the held-out set", () => {
    const heldOutTraces: EpisodeTrace[] = [
      trace("h1", ["OwnerAsked", "CandidateGenerated"], true),
      trace("h2", ["OwnerAsked", "MouthSpoken"], false)
    ];
    const result = evaluateOperatorPromotion(candidate, heldOutTraces);
    expect(result.promoted).toBe(false);
    expect(result.heldOutMatchingCount).toBe(0);
    expect(result.reason).toMatch(/no held-out episode/);
  });

  it("refuses to promote when a held-out pattern actively performs worse than the baseline (negative gain)", () => {
    const heldOutTraces: EpisodeTrace[] = [
      trace("h1", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"], false),
      trace("h2", ["OwnerAsked", "CapabilityInvoked", "CapabilitySucceeded"], false),
      trace("h3", ["OwnerAsked", "CandidateGenerated"], true),
      trace("h4", ["OwnerAsked", "CandidateGenerated"], true)
    ];
    const result = evaluateOperatorPromotion(candidate, heldOutTraces);
    expect(result.promoted).toBe(false);
    expect(result.heldOutGain).toBeLessThan(0);
  });
});
