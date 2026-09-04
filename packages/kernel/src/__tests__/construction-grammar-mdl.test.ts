// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { induceLearnedConstructions, type AlignedSurfaceExample } from "../language-construction.js";
import { scoreConstructionGrammarMdl } from "../construction-grammar-mdl.js";
import { createHasher } from "../primitives.js";

// Plan item 102. Scores real LearnedConstruction/LearnedFormClass output
// from induceLearnedConstructions -- the real induction pipeline items
// 91-95/100 already implement and this session already re-verified live
// -- never hand-fabricated grammar objects, so this proves the MDL
// formula against the exact shape the real pipeline produces.

const HASHER = createHasher();

function alignedExample(input: {
  id: string;
  profileKey: string;
  surface: string;
  roles: ReadonlyArray<readonly [string, string]>;
}): AlignedSurfaceExample {
  const used = new Map<string, number>();
  return {
    id: input.id,
    profileKey: input.profileKey,
    surface: input.surface,
    evidenceIds: [`evidence.${input.id}`],
    roleSpans: input.roles.map(([roleId, surface]) => {
      const from = used.get(surface) ?? 0;
      const start = input.surface.indexOf(surface, from);
      if (start < 0) throw new Error(`fixture bug: ${JSON.stringify(surface)} not found in ${JSON.stringify(input.surface)}`);
      used.set(surface, start + surface.length);
      return { roleId, start, end: start + surface.length, surface, evidenceIds: [`evidence.${input.id}.${roleId}`] };
    })
  };
}

describe("scoreConstructionGrammarMdl (plan item 102)", () => {
  it("a single observation costs real grammar bits but zero data bits -- no uncertainty to encode when there is only one possible choice", () => {
    const learned = induceLearnedConstructions({
      hasher: HASHER,
      examples: [alignedExample({ id: "e1", profileKey: "profile.1", surface: "Aster likes Nova.", roles: [["role.subject", "Aster"], ["role.object", "Nova"]] })]
    });
    const score = scoreConstructionGrammarMdl({ constructions: learned.constructions, formClasses: learned.formClasses });

    expect(score.grammarBits).toBeGreaterThan(0);
    expect(score.dataBits).toBe(0);
    expect(score.totalBits).toBe(score.grammarBits);
    expect(score.constructionCount).toBe(1);
  });

  it("a grammar that reuses one shared construction across many examples compresses better (lower total bits) than an equivalent set of one-off unique constructions with the same total literal content", () => {
    // Grammar A: one real, repeated pattern ("<X> likes <Y>.") realized
    // four times with different real fillers -- exactly what a genuine
    // reusable construction looks like.
    const repeatedPatternExamples: AlignedSurfaceExample[] = [
      alignedExample({ id: "a1", profileKey: "profile.a", surface: "Aster likes Nova.", roles: [["role.subject", "Aster"], ["role.object", "Nova"]] }),
      alignedExample({ id: "a2", profileKey: "profile.a", surface: "Bram likes Ceres.", roles: [["role.subject", "Bram"], ["role.object", "Ceres"]] }),
      alignedExample({ id: "a3", profileKey: "profile.a", surface: "Delia likes Ember.", roles: [["role.subject", "Delia"], ["role.object", "Ember"]] }),
      alignedExample({ id: "a4", profileKey: "profile.a", surface: "Farro likes Gale.", roles: [["role.subject", "Farro"], ["role.object", "Gale"]] })
    ];
    const grammarA = induceLearnedConstructions({ hasher: HASHER, examples: repeatedPatternExamples });
    expect(grammarA.constructions).toHaveLength(1); // real proof the four examples really did share one structural key
    const scoreA = scoreConstructionGrammarMdl({ constructions: grammarA.constructions, formClasses: grammarA.formClasses });

    // Grammar B: four genuinely distinct one-off sentence shapes with
    // comparable total literal content but zero shared structure --
    // induceLearnedConstructions will (correctly) treat each as its own
    // construction, so nothing is reused.
    const distinctPatternExamples: AlignedSurfaceExample[] = [
      alignedExample({ id: "b1", profileKey: "profile.b", surface: "Aster orbits Nova quietly.", roles: [["role.subject", "Aster"], ["role.object", "Nova"]] }),
      alignedExample({ id: "b2", profileKey: "profile.b", surface: "Ceres, once distant, met Bram.", roles: [["role.subject", "Ceres"], ["role.object", "Bram"]] }),
      alignedExample({ id: "b3", profileKey: "profile.b", surface: "Under Ember's light, Delia waited.", roles: [["role.subject", "Ember"], ["role.object", "Delia"]] }),
      alignedExample({ id: "b4", profileKey: "profile.b", surface: "Gale finally reached Farro's gate.", roles: [["role.subject", "Gale"], ["role.object", "Farro"]] })
    ];
    const grammarB = induceLearnedConstructions({ hasher: HASHER, examples: distinctPatternExamples });
    expect(grammarB.constructions.length).toBeGreaterThan(1); // real proof these did NOT share structure
    const scoreB = scoreConstructionGrammarMdl({ constructions: grammarB.constructions, formClasses: grammarB.formClasses });

    // The real MDL claim: reusing one real construction across four
    // examples costs meaningfully less total description length, per
    // observed example, than four unrelated one-off constructions of
    // similar surface length each.
    const bitsPerExampleA = scoreA.totalBits / scoreA.observedExampleCount;
    const bitsPerExampleB = scoreB.totalBits / scoreB.observedExampleCount;
    expect(bitsPerExampleA).toBeLessThan(bitsPerExampleB);
  });

  it("a skewed (predictable) variant distribution costs fewer data bits than a uniform one over the same alphabet size -- a real Shannon-code sensitivity, not just a variant count", () => {
    // Skewed: the same filler "Nova" appears three times, "Ceres" once --
    // real, unequal empirical frequency.
    const skewed = induceLearnedConstructions({
      hasher: HASHER,
      examples: [
        alignedExample({ id: "s1", profileKey: "profile.s", surface: "Aster likes Nova.", roles: [["role.subject", "Aster"], ["role.object", "Nova"]] }),
        alignedExample({ id: "s2", profileKey: "profile.s", surface: "Bram likes Nova.", roles: [["role.subject", "Bram"], ["role.object", "Nova"]] }),
        alignedExample({ id: "s3", profileKey: "profile.s", surface: "Delia likes Nova.", roles: [["role.subject", "Delia"], ["role.object", "Nova"]] }),
        alignedExample({ id: "s4", profileKey: "profile.s", surface: "Farro likes Ceres.", roles: [["role.subject", "Farro"], ["role.object", "Ceres"]] })
      ]
    });
    // Uniform: four distinct object fillers, each exactly once.
    const uniform = induceLearnedConstructions({
      hasher: HASHER,
      examples: [
        alignedExample({ id: "u1", profileKey: "profile.u", surface: "Aster likes Nova.", roles: [["role.subject", "Aster"], ["role.object", "Nova"]] }),
        alignedExample({ id: "u2", profileKey: "profile.u", surface: "Bram likes Ceres.", roles: [["role.subject", "Bram"], ["role.object", "Ceres"]] }),
        alignedExample({ id: "u3", profileKey: "profile.u", surface: "Delia likes Ember.", roles: [["role.subject", "Delia"], ["role.object", "Ember"]] }),
        alignedExample({ id: "u4", profileKey: "profile.u", surface: "Farro likes Gale.", roles: [["role.subject", "Farro"], ["role.object", "Gale"]] })
      ]
    });

    const scoreSkewed = scoreConstructionGrammarMdl({ constructions: skewed.constructions, formClasses: skewed.formClasses });
    const scoreUniform = scoreConstructionGrammarMdl({ constructions: uniform.constructions, formClasses: uniform.formClasses });

    // Same construction count, same subject-role uniqueness pattern (4
    // distinct subjects in both) -- the only real structural difference is
    // the object-role variant distribution's skew, so a real difference in
    // dataBits here is attributable to that skew, not incidental noise.
    expect(scoreSkewed.constructionCount).toBe(scoreUniform.constructionCount);
    expect(scoreSkewed.dataBits).toBeLessThan(scoreUniform.dataBits);
  });

  it("an empty grammar scores zero on every dimension", () => {
    const score = scoreConstructionGrammarMdl({ constructions: [], formClasses: [] });
    expect(score).toMatchObject({ grammarBits: 0, dataBits: 0, totalBits: 0, constructionCount: 0, formClassCount: 0, observedExampleCount: 0 });
  });
});
