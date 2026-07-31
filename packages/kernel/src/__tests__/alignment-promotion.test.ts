import { describe, expect, it } from "vitest";
import {
  compileAlignmentPromotionModel,
  type AlignmentAlternativeSet,
  type AlignmentPromotionObservation
} from "../index.js";

describe("independent held-out alignment promotion", () => {
  it("promotes only complete cycle-safe recovery on independent families", () => {
    const model = compileAlignmentPromotionModel({
      alternativeSets: [alternativeSet("series.good", "plan.good")],
      observations: [
        observation("series.good", "plan.good", "induction", "family.train", "induction"),
        observation("series.good", "plan.good", "heldout-copy", "family.train", "heldout"),
        observation("series.good", "plan.good", "heldout-a", "family.holdout.a", "heldout"),
        observation("series.good", "plan.good", "heldout-b", "family.holdout.b", "heldout")
      ]
    });
    const decision = model.decisions[0]!;

    expect(decision.promoted).toBe(true);
    expect(decision.inductionSourceFamilyIds).toEqual(["family.train"]);
    expect(decision.independentHeldoutSourceFamilyIds).toEqual([
      "family.holdout.a",
      "family.holdout.b"
    ]);
    expect(decision.heldoutCoverage).toBe(1);
    expect(decision.cycleRecall).toBe(1);
    expect(decision.unsupportedAdditionCount).toBe(0);
    expect(model.audit).toMatchObject({
      copiedFamiliesCannotSelfValidate: true,
      zeroUnsupportedAdditionsRequired: true
    });
  });

  it("collapses copied holdout families and rejects semantic corruption", () => {
    const corrupted = compileAlignmentPromotionModel({
      alternativeSets: [alternativeSet("series.bad", "plan.bad")],
      observations: [
        observation("series.bad", "plan.bad", "induction", "family.train", "induction"),
        observation("series.bad", "plan.bad", "copy-a", "family.holdout.a", "heldout"),
        observation("series.bad", "plan.bad", "copy-b", "family.holdout.a", "heldout"),
        {
          ...observation("series.bad", "plan.bad", "heldout-b", "family.holdout.b", "heldout"),
          unsupportedAdditionCount: 1,
          cycleRecall: 0.9,
          exactAnchorsPreserved: false
        }
      ]
    });
    const decision = corrupted.decisions[0]!;

    expect(decision.promoted).toBe(false);
    expect(decision.independentHeldoutSourceFamilyIds).toHaveLength(2);
    expect(decision.reasons).toEqual(expect.arrayContaining([
      "cycle_recall_low",
      "exact_anchor_not_preserved",
      "unsupported_additions_present"
    ]));
  });

  // Plan item 118: proves the near-duplicate exclusion is load-bearing, not
  // incidental. Test 1 above already includes a same-family "heldout-copy"
  // row, but its exclusion never changes that test's outcome -- two
  // genuinely independent families are present regardless, so the copy
  // could be silently miscounted as independent and the test would still
  // pass. Here there is only ONE genuinely independent family; a near-
  // duplicate of the induction document (same sourceFamilyId, submitted as
  // if it were separate held-out evidence) is the only thing that could
  // push the independent-family count up to the minimum of 2. If it were
  // wrongly counted, this would promote; because it is correctly excluded,
  // it must not.
  it("rejects promotion when the only second 'independent' family is a near-duplicate of the induction document", () => {
    const model = compileAlignmentPromotionModel({
      alternativeSets: [alternativeSet("series.adversarial", "plan.adversarial")],
      observations: [
        observation("series.adversarial", "plan.adversarial", "induction", "family.train", "induction"),
        // Adversarial: claims to be independent held-out evidence, but its
        // sourceFamilyId is literally the induction document's own family --
        // a near-duplicate resubmission, not real independent corroboration.
        observation("series.adversarial", "plan.adversarial", "near-duplicate-of-induction", "family.train", "heldout"),
        observation("series.adversarial", "plan.adversarial", "heldout-only-real-family", "family.holdout.a", "heldout")
      ]
    });
    const decision = model.decisions[0]!;

    expect(decision.independentHeldoutSourceFamilyIds).toEqual(["family.holdout.a"]);
    expect(decision.independentHeldoutSourceFamilyIds).toHaveLength(1);
    expect(decision.promoted).toBe(false);
    expect(decision.reasons).toContain("independent_heldout_families_low");
  });

  function observation(
    seriesId: string,
    planId: string,
    id: string,
    sourceFamilyId: string,
    partition: AlignmentPromotionObservation["partition"]
  ): AlignmentPromotionObservation {
    return {
      id,
      seriesId,
      planId,
      sourceFamilyId,
      partition,
      requiredGraphTargetCount: 4,
      recoveredGraphTargetCount: 4,
      exactAnchorsPreserved: true,
      cycleRecall: 1,
      unsupportedAdditionCount: 0
    };
  }
});

function alternativeSet(seriesId: string, planId: string): AlignmentAlternativeSet {
  return {
    seriesId,
    hypotheses: [{ plan: { id: planId } }]
  } as unknown as AlignmentAlternativeSet;
}
