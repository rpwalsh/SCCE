import { describe, expect, it } from "vitest";
import { induceLearnedConstructions, type AlignedSurfaceExample } from "../language-construction.js";
import { scoreConstructionGrammarMdl } from "../construction-grammar-mdl.js";
import {
  applyConstructionGrammarEdit,
  buildConstructionGrammarMdlState,
  currentConstructionGrammarMdlScore
} from "../construction-grammar-mdl-incremental.js";
import { createHasher } from "../primitives.js";

// Plan item 103. Proves the incremental evaluator is an exact,
// bounded-work equivalent of item 102's full batch formula -- never an
// approximation that merely looks local.

const HASHER = createHasher();

function alignedExample(input: { id: string; profileKey: string; surface: string; roles: ReadonlyArray<readonly [string, string]> }): AlignedSurfaceExample {
  const used = new Map<string, number>();
  return {
    id: input.id,
    profileKey: input.profileKey,
    surface: input.surface,
    evidenceIds: [`evidence.${input.id}`],
    roleSpans: input.roles.map(([roleId, surface]) => {
      const from = used.get(surface) ?? 0;
      const start = input.surface.indexOf(surface, from);
      if (start < 0) throw new Error(`fixture bug: ${JSON.stringify(surface)} not found`);
      used.set(surface, start + surface.length);
      return { roleId, start, end: start + surface.length, surface, evidenceIds: [`evidence.${input.id}.${roleId}`] };
    })
  };
}

function realGrammar() {
  return induceLearnedConstructions({
    hasher: HASHER,
    examples: [
      alignedExample({ id: "e1", profileKey: "profile.1", surface: "Aster likes Nova.", roles: [["role.subject", "Aster"], ["role.object", "Nova"]] }),
      alignedExample({ id: "e2", profileKey: "profile.1", surface: "Bram likes Ceres.", roles: [["role.subject", "Bram"], ["role.object", "Ceres"]] }),
      alignedExample({ id: "e3", profileKey: "profile.1", surface: "Delia likes Nova.", roles: [["role.subject", "Delia"], ["role.object", "Nova"]] }),
      alignedExample({ id: "e4", profileKey: "profile.2", surface: "Farro orbits Gale silently.", roles: [["role.subject", "Farro"], ["role.object", "Gale"]] })
    ]
  });
}

describe("incremental construction-grammar MDL score (plan item 103)", () => {
  it("seeding incremental state from a real induced grammar reproduces the full batch score exactly", () => {
    const grammar = realGrammar();
    const batchScore = scoreConstructionGrammarMdl({ constructions: grammar.constructions, formClasses: grammar.formClasses });
    const state = buildConstructionGrammarMdlState({ constructions: grammar.constructions, formClasses: grammar.formClasses });
    const incrementalScore = currentConstructionGrammarMdlScore(state);

    expect(incrementalScore.grammarBits).toBeCloseTo(batchScore.grammarBits, 9);
    expect(incrementalScore.dataBits).toBeCloseTo(batchScore.dataBits, 9);
    expect(incrementalScore.totalBits).toBeCloseTo(batchScore.totalBits, 9);
    expect(incrementalScore).toMatchObject({
      constructionCount: batchScore.constructionCount,
      formClassCount: batchScore.formClassCount,
      observedExampleCount: batchScore.observedExampleCount
    });
  });

  it("bumping one construction's observation count via a local edit produces exactly the score a full recompute would, and never touches any other construction's own count", () => {
    const grammar = realGrammar();
    const repeated = grammar.constructions.find(c => c.sourceExampleIds.length > 1);
    expect(repeated).toBeDefined(); // real proof this fixture actually has a reused construction to bump

    const before = buildConstructionGrammarMdlState({ constructions: grammar.constructions, formClasses: grammar.formClasses });
    const otherConstructionIds = [...before.constructionCounts.keys()].filter(id => id !== repeated!.id);
    const otherCountsBefore = otherConstructionIds.map(id => before.constructionCounts.get(id));
    const otherBitsBefore = otherConstructionIds.map(id => before.constructionSequenceBits.get(id));

    const after = applyConstructionGrammarEdit(before, {
      kind: "set_construction_observation_count",
      constructionId: repeated!.id,
      count: repeated!.sourceExampleIds.length + 5
    });

    // Every OTHER construction's own count and grammar-bit contribution
    // is byte-identical -- the edit touched only the one construction it
    // named, not a rescan of the rest of the grammar.
    const otherCountsAfter = otherConstructionIds.map(id => after.constructionCounts.get(id));
    const otherBitsAfter = otherConstructionIds.map(id => after.constructionSequenceBits.get(id));
    expect(otherCountsAfter).toEqual(otherCountsBefore);
    expect(otherBitsAfter).toEqual(otherBitsBefore);

    // And the resulting score exactly matches a real full recompute over
    // the equivalent modified corpus (the same real induced constructions,
    // with only that one construction's real sourceExampleIds length
    // increased to match).
    const modifiedConstructions = grammar.constructions.map(c =>
      c.id === repeated!.id
        ? { ...c, sourceExampleIds: [...c.sourceExampleIds, "extra.1", "extra.2", "extra.3", "extra.4", "extra.5"] }
        : c
    );
    const recomputed = scoreConstructionGrammarMdl({ constructions: modifiedConstructions, formClasses: grammar.formClasses });
    const incremental = currentConstructionGrammarMdlScore(after);
    expect(incremental.dataBits).toBeCloseTo(recomputed.dataBits, 9);
    expect(incremental.grammarBits).toBeCloseTo(recomputed.grammarBits, 9);
  });

  it("adding a brand-new construction only adds that construction's own bits, leaving every existing construction's contribution untouched", () => {
    const grammar = realGrammar();
    const before = buildConstructionGrammarMdlState({ constructions: grammar.constructions, formClasses: grammar.formClasses });
    const existingIds = [...before.constructionCounts.keys()];
    const existingBitsBefore = existingIds.map(id => before.constructionSequenceBits.get(id));

    const newSequence = [
      { kind: "literal" as const, surface: "Hello, ", origins: [], evidenceIds: [] },
      { kind: "slot" as const, roleId: "role.greeting_target", occurrenceId: "occ.0", formClassId: "form_class.new", required: true as const, origins: [], evidenceIds: [] },
      { kind: "literal" as const, surface: "!", origins: [], evidenceIds: [] }
    ];
    const after = applyConstructionGrammarEdit(before, {
      kind: "add_construction",
      constructionId: "construction.new_greeting",
      sequence: newSequence,
      observationCount: 2
    });

    const existingBitsAfter = existingIds.map(id => after.constructionSequenceBits.get(id));
    expect(existingBitsAfter).toEqual(existingBitsBefore);

    const expectedNewBits = "Hello, ".length * Math.log2(256) + "form_class.new".length * Math.log2(256) + "!".length * Math.log2(256);
    expect(after.grammarBits - before.grammarBits).toBeCloseTo(expectedNewBits, 9);
  });

  it("removing a construction is the exact inverse of adding it -- round-trips back to the original state's score", () => {
    const grammar = realGrammar();
    const before = buildConstructionGrammarMdlState({ constructions: grammar.constructions, formClasses: grammar.formClasses });
    const beforeScore = currentConstructionGrammarMdlScore(before);
    const target = grammar.constructions[0]!;

    const removed = applyConstructionGrammarEdit(before, { kind: "remove_construction", constructionId: target.id });
    const restored = applyConstructionGrammarEdit(removed, {
      kind: "add_construction",
      constructionId: target.id,
      sequence: target.sequence,
      observationCount: target.sourceExampleIds.length
    });
    const restoredScore = currentConstructionGrammarMdlScore(restored);

    expect(restoredScore.totalBits).toBeCloseTo(beforeScore.totalBits, 9);
    expect(restoredScore.constructionCount).toBe(beforeScore.constructionCount);
  });

  it("rejects re-adding a construction id that already exists, and rejects a negative observation count, rather than silently corrupting the running totals", () => {
    const grammar = realGrammar();
    const state = buildConstructionGrammarMdlState({ constructions: grammar.constructions, formClasses: grammar.formClasses });
    const existingId = grammar.constructions[0]!.id;
    expect(() => applyConstructionGrammarEdit(state, { kind: "add_construction", constructionId: existingId, sequence: [], observationCount: 1 })).toThrow();
    expect(() => applyConstructionGrammarEdit(state, { kind: "set_construction_observation_count", constructionId: existingId, count: -1 })).toThrow();
    expect(() => applyConstructionGrammarEdit(state, { kind: "remove_construction", constructionId: "construction.does_not_exist" })).toThrow();
  });
});
