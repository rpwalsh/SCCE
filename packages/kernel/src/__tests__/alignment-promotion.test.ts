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
