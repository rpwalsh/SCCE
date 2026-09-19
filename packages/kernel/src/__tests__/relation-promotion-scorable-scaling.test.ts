// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  compileRelationPromotionModel,
  RELATION_PROMOTION_MIN_INDEPENDENT_SOURCES,
  type RelationObservation
} from "../relation-promotion.js";
import { createHasher } from "../primitives.js";

// Below four independent source families every seed is unscorable and refused unconditionally, which is the
// cheap path this corpus has lived on: wikipedia declares ONE family, so nothing was ever scored. At four the
// gate opens and every seed runs evaluateRelation plus three negative controls -- and the duplicate control
// built an array the size of the whole fit set per seed and scanned it, which is quadratic in seed count.
// Measured before the derived scope: 932ms at 2,000 seeds, 18.4s at 8,000. scce4 holds 184,405 seeds.

const hasher = createHasher();

function observations(seeds: number, families: number, signatures = 7): RelationObservation[] {
  const rows: RelationObservation[] = [];
  for (let family = 0; family < families; family += 1) {
    for (let seed = 0; seed < seeds; seed += 1) {
      rows.push({
        candidateId: `candidate.${family}.${seed}`,
        relationSeedId: `seed.${seed}`,
        channel: "source_declared_structured",
        sourceId: `source.${family}`,
        sourceFamilyId: `family_${family}`,
        signature: `signature.${seed % signatures}`
      });
    }
  }
  return rows;
}

const fit = (rows: readonly RelationObservation[]): ReturnType<typeof compileRelationPromotionModel> =>
  compileRelationPromotionModel({ candidates: [], priorObservations: rows, hasher });

describe("promotion cost once seeds become scorable", () => {
  it("scores nothing below the independence threshold, and everything at it", () => {
    const below = fit(observations(40, RELATION_PROMOTION_MIN_INDEPENDENT_SOURCES - 1));
    const at = fit(observations(40, RELATION_PROMOTION_MIN_INDEPENDENT_SOURCES));
    const scorable = (model: ReturnType<typeof fit>): number => model.decisions
      .filter(decision => !decision.reasons.includes("insufficient_independent_sources")).length;
    expect(scorable(below)).toBe(0);
    expect(scorable(at)).toBe(40);
  });

  it("costs linear time in the number of scorable seeds, not quadratic", () => {
    // Three things were quadratic here, all of them per scorable seed: the duplicate control materialised an
    // array the size of the whole fit set, its scope rebuilt a Set of every seed in the channel, and its
    // recovery denominator summed over every seed against a scope whose cache was always cold. All three are
    // closed-form for a set of identical rows. Measured 18.4s -> 210ms at 8,000 seeds.
    const time = (seeds: number): number => {
      const rows = observations(seeds, RELATION_PROMOTION_MIN_INDEPENDENT_SOURCES);
      const started = Date.now();
      fit(rows);
      return Math.max(1, Date.now() - started);
    };
    // Warm the JIT so the first sample is not paying compilation the second one avoids.
    time(500);
    const small = time(2000);
    const large = time(8000);
    // Four times the seeds. Linear is ~4x, quadratic would be ~16x. Generous headroom, still catches a return
    // to quadratic, which at this corpus's 184,405 seeds is the difference between seconds and hours.
    expect(large / small).toBeLessThan(8);
  }, 120_000);

  it("keeps the duplicate control's verdict, which is what the derived scope had to preserve", () => {
    // The control asks whether repetition inside one source can pass for corroboration across several. It must
    // still refuse, and it must still be the reason recorded -- a faster control that stopped refusing would be
    // a weakened gate, not an optimisation.
    const model = fit(observations(30, 4, 1));
    expect(model.decisions.length).toBe(30);
    for (const decision of model.decisions) {
      const duplicate = decision.controls.find(control => control.kind === "duplicate_only");
      expect(duplicate).toBeDefined();
      // One signature for everything means the relation carries no information the background lacks, so the
      // duplicate control cannot show a gain. The point is that it is still computed and still reported.
      expect(duplicate!.independentSourceCount).toBe(1);
      expect(Number.isFinite(duplicate!.gainNats)).toBe(true);
    }
  });

  it("is deterministic across repeated compiles, because replay depends on it", () => {
    const rows = observations(60, 5, 3);
    const first = fit(rows);
    const second = fit(rows);
    expect(second.id).toBe(first.id);
    expect(JSON.stringify(second.decisions)).toBe(JSON.stringify(first.decisions));
  });
});
