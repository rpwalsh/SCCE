// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LearnedConstruction, LearnedConstructionPart, LearnedFormClass } from "./language-construction.js";
import { CONSTRUCTION_GRAMMAR_MDL_SCHEMA, type ConstructionGrammarMdlScore } from "./construction-grammar-mdl.js";

/**
 * Plan item 103. A real, provably-correct local/incremental variant of
 * item 102's `J(Gamma,T) = L(Gamma) + L(T|Gamma)` grammar score:
 * `applyConstructionGrammarEdit` updates the score in work bounded by the
 * size of the edit itself (`Affected(o)`), never by rescanning every
 * other construction/form-class in the grammar -- an ordinary edit (one
 * more example reusing an existing pattern, one new variant, one removed
 * construction) costs O(1) to O(edit size), not O(|Gamma|+|T|).
 *
 * The one real subtlety this has to get right: item 102's data-bits term
 * is a Shannon code, `sum_i -count_i * log2(count_i/total)`, and `total`
 * changes on almost every edit -- naively, that would seem to force
 * recomputing every other construction's own term whenever one count
 * changes. It doesn't, by a real closed-form identity:
 *
 *   sum_i [-count_i * log2(count_i/total)]
 *     = total*log2(total) - sum_i [count_i * log2(count_i)]
 *
 * The right-hand side only needs `total` and a single running sum
 * (`entropyTerm = sum_i count_i*log2(count_i)`), both of which update in
 * O(1) when exactly one `count_i` changes: subtract that entry's own old
 * contribution, add its new one. This module maintains `total` and
 * `entropyTerm` (once for constructions, once per form class) instead of
 * ever re-summing every count, which is what makes the update genuinely
 * local rather than an approximation that happens to look local.
 *
 * Item 102's own `scoreConstructionGrammarMdl` deliberately costs a slot
 * reference by its own form-class id (`literalBits(formClassId)`) rather
 * than `log2(total distinct form classes)` for the same reason: a
 * count-of-everything-else term would make every existing slot's own
 * grammar-bit cost shift whenever an unrelated form class is added
 * anywhere else in the grammar, which is exactly the non-local dependency
 * this module exists to avoid. Both modules therefore compute the
 * identical formula -- this is an optimized incremental evaluator of that
 * formula, not a different score.
 */
export const CONSTRUCTION_GRAMMAR_MDL_INCREMENTAL_SCHEMA = "scce.construction_grammar_mdl_incremental.v1" as const;

export interface ConstructionGrammarMdlState {
  schema: typeof CONSTRUCTION_GRAMMAR_MDL_INCREMENTAL_SCHEMA;
  grammarBits: number;
  constructionCounts: ReadonlyMap<string, number>;
  constructionSequenceBits: ReadonlyMap<string, number>;
  constructionTotal: number;
  constructionEntropyTerm: number;
  formClassVariantCounts: ReadonlyMap<string, ReadonlyMap<string, number>>;
  formClassVariantBits: ReadonlyMap<string, ReadonlyMap<string, number>>;
  formClassTotals: ReadonlyMap<string, number>;
  formClassEntropyTerms: ReadonlyMap<string, number>;
}

export type ConstructionGrammarEdit =
  | { kind: "add_construction"; constructionId: string; sequence: readonly LearnedConstructionPart[]; observationCount: number }
  | { kind: "remove_construction"; constructionId: string }
  | { kind: "set_construction_observation_count"; constructionId: string; count: number }
  | { kind: "add_form_class_variant"; formClassId: string; variantId: string; surface: string; observationCount: number }
  | { kind: "remove_form_class_variant"; formClassId: string; variantId: string }
  | { kind: "set_variant_observation_count"; formClassId: string; variantId: string; count: number };

const NAT_TO_BIT = 1 / Math.log(2);

function log2(value: number): number {
  return Math.log(Math.max(value, Number.EPSILON)) * NAT_TO_BIT;
}

function literalBits(surface: string): number {
  return surface.length * log2(256);
}

function entropyTermFor(count: number): number {
  return count > 0 ? count * log2(count) : 0;
}

function sequenceBits(sequence: readonly LearnedConstructionPart[]): number {
  let bits = 0;
  for (const part of sequence) bits += literalBits(part.kind === "literal" ? part.surface : part.formClassId);
  return bits;
}

export function emptyConstructionGrammarMdlState(): ConstructionGrammarMdlState {
  return {
    schema: CONSTRUCTION_GRAMMAR_MDL_INCREMENTAL_SCHEMA,
    grammarBits: 0,
    constructionCounts: new Map(),
    constructionSequenceBits: new Map(),
    constructionTotal: 0,
    constructionEntropyTerm: 0,
    formClassVariantCounts: new Map(),
    formClassVariantBits: new Map(),
    formClassTotals: new Map(),
    formClassEntropyTerms: new Map()
  };
}

/**
 * Builds a state from a real `LearnedConstruction[]`/`LearnedFormClass[]`
 * grammar (e.g. `induceLearnedConstructions`'s own accepted output) by
 * applying one `add_construction`/`add_form_class_variant` edit per
 * element -- a real, honest way to seed incremental state from a batch
 * grammar (not a separate, parallel implementation of the scoring math
 * that could silently drift from `applyConstructionGrammarEdit`'s own).
 * Not itself O(1) (a batch seed is legitimately O(|Gamma|+|T|) once) --
 * it is what every edit *after* seeding stays local against.
 */
export function buildConstructionGrammarMdlState(input: {
  constructions: readonly LearnedConstruction[];
  formClasses: readonly LearnedFormClass[];
}): ConstructionGrammarMdlState {
  let state = emptyConstructionGrammarMdlState();
  for (const construction of input.constructions) {
    state = applyConstructionGrammarEdit(state, {
      kind: "add_construction",
      constructionId: construction.id,
      sequence: construction.sequence,
      observationCount: construction.sourceExampleIds.length
    });
  }
  for (const formClass of input.formClasses) {
    for (const variant of formClass.variants) {
      state = applyConstructionGrammarEdit(state, {
        kind: "add_form_class_variant",
        formClassId: formClass.id,
        variantId: variant.id,
        surface: variant.surface,
        observationCount: variant.origins.length
      });
    }
  }
  return state;
}

/** O(1) -- reconstructs the current full score purely from maintained aggregates, never rescanning any construction or form class. */
export function currentConstructionGrammarMdlScore(state: ConstructionGrammarMdlState): ConstructionGrammarMdlScore {
  const constructionChoiceBits = state.constructionTotal > 0
    ? state.constructionTotal * log2(state.constructionTotal) - state.constructionEntropyTerm
    : 0;
  let variantChoiceBits = 0;
  let observedExampleCount = 0;
  for (const [formClassId, total] of state.formClassTotals) {
    const entropyTerm = state.formClassEntropyTerms.get(formClassId) ?? 0;
    variantChoiceBits += total > 0 ? total * log2(total) - entropyTerm : 0;
    observedExampleCount += total;
  }
  return {
    schema: CONSTRUCTION_GRAMMAR_MDL_SCHEMA,
    grammarBits: state.grammarBits,
    dataBits: constructionChoiceBits + variantChoiceBits,
    totalBits: state.grammarBits + constructionChoiceBits + variantChoiceBits,
    constructionCount: state.constructionCounts.size,
    formClassCount: state.formClassTotals.size,
    observedExampleCount
  };
}

/** O(|Affected(o)|): the edit's own construction/variant, never the rest of the grammar. */
export function applyConstructionGrammarEdit(
  state: ConstructionGrammarMdlState,
  edit: ConstructionGrammarEdit
): ConstructionGrammarMdlState {
  switch (edit.kind) {
    case "add_construction": {
      if (state.constructionCounts.has(edit.constructionId)) {
        throw new Error(`construction ${edit.constructionId} already exists -- use set_construction_observation_count to change its count`);
      }
      const bits = sequenceBits(edit.sequence);
      const constructionCounts = new Map(state.constructionCounts);
      constructionCounts.set(edit.constructionId, edit.observationCount);
      const constructionSequenceBits = new Map(state.constructionSequenceBits);
      constructionSequenceBits.set(edit.constructionId, bits);
      return {
        ...state,
        grammarBits: state.grammarBits + bits,
        constructionCounts,
        constructionSequenceBits,
        constructionTotal: state.constructionTotal + edit.observationCount,
        constructionEntropyTerm: state.constructionEntropyTerm + entropyTermFor(edit.observationCount)
      };
    }
    case "remove_construction": {
      const previousCount = state.constructionCounts.get(edit.constructionId);
      const bits = state.constructionSequenceBits.get(edit.constructionId);
      if (previousCount === undefined || bits === undefined) {
        throw new Error(`construction ${edit.constructionId} does not exist`);
      }
      const constructionCounts = new Map(state.constructionCounts);
      constructionCounts.delete(edit.constructionId);
      const constructionSequenceBits = new Map(state.constructionSequenceBits);
      constructionSequenceBits.delete(edit.constructionId);
      return {
        ...state,
        grammarBits: state.grammarBits - bits,
        constructionCounts,
        constructionSequenceBits,
        constructionTotal: state.constructionTotal - previousCount,
        constructionEntropyTerm: state.constructionEntropyTerm - entropyTermFor(previousCount)
      };
    }
    case "set_construction_observation_count": {
      const previousCount = state.constructionCounts.get(edit.constructionId);
      if (previousCount === undefined) throw new Error(`construction ${edit.constructionId} does not exist`);
      if (edit.count < 0) throw new Error("observation count must be non-negative");
      const constructionCounts = new Map(state.constructionCounts);
      constructionCounts.set(edit.constructionId, edit.count);
      return {
        ...state,
        constructionCounts,
        constructionTotal: state.constructionTotal - previousCount + edit.count,
        constructionEntropyTerm: state.constructionEntropyTerm - entropyTermFor(previousCount) + entropyTermFor(edit.count)
      };
    }
    case "add_form_class_variant": {
      const variants = state.formClassVariantCounts.get(edit.formClassId) ?? new Map<string, number>();
      if (variants.has(edit.variantId)) {
        throw new Error(`variant ${edit.variantId} already exists in form class ${edit.formClassId} -- use set_variant_observation_count to change its count`);
      }
      const bits = literalBits(edit.surface);
      const nextVariants = new Map(variants);
      nextVariants.set(edit.variantId, edit.observationCount);
      const formClassVariantCounts = new Map(state.formClassVariantCounts);
      formClassVariantCounts.set(edit.formClassId, nextVariants);
      const variantBits = state.formClassVariantBits.get(edit.formClassId) ?? new Map<string, number>();
      const nextVariantBits = new Map(variantBits);
      nextVariantBits.set(edit.variantId, bits);
      const formClassVariantBits = new Map(state.formClassVariantBits);
      formClassVariantBits.set(edit.formClassId, nextVariantBits);
      const formClassTotals = new Map(state.formClassTotals);
      formClassTotals.set(edit.formClassId, (state.formClassTotals.get(edit.formClassId) ?? 0) + edit.observationCount);
      const formClassEntropyTerms = new Map(state.formClassEntropyTerms);
      formClassEntropyTerms.set(edit.formClassId, (state.formClassEntropyTerms.get(edit.formClassId) ?? 0) + entropyTermFor(edit.observationCount));
      return {
        ...state,
        grammarBits: state.grammarBits + bits,
        formClassVariantCounts,
        formClassVariantBits,
        formClassTotals,
        formClassEntropyTerms
      };
    }
    case "remove_form_class_variant": {
      const variants = state.formClassVariantCounts.get(edit.formClassId);
      const variantBitsMap = state.formClassVariantBits.get(edit.formClassId);
      const previousCount = variants?.get(edit.variantId);
      const bits = variantBitsMap?.get(edit.variantId);
      if (previousCount === undefined || bits === undefined || !variants || !variantBitsMap) {
        throw new Error(`variant ${edit.variantId} does not exist in form class ${edit.formClassId}`);
      }
      const nextVariants = new Map(variants);
      nextVariants.delete(edit.variantId);
      const formClassVariantCounts = new Map(state.formClassVariantCounts);
      formClassVariantCounts.set(edit.formClassId, nextVariants);
      const nextVariantBits = new Map(variantBitsMap);
      nextVariantBits.delete(edit.variantId);
      const formClassVariantBits = new Map(state.formClassVariantBits);
      formClassVariantBits.set(edit.formClassId, nextVariantBits);
      const formClassTotals = new Map(state.formClassTotals);
      formClassTotals.set(edit.formClassId, (state.formClassTotals.get(edit.formClassId) ?? 0) - previousCount);
      const formClassEntropyTerms = new Map(state.formClassEntropyTerms);
      formClassEntropyTerms.set(edit.formClassId, (state.formClassEntropyTerms.get(edit.formClassId) ?? 0) - entropyTermFor(previousCount));
      return {
        ...state,
        grammarBits: state.grammarBits - bits,
        formClassVariantCounts,
        formClassVariantBits,
        formClassTotals,
        formClassEntropyTerms
      };
    }
    case "set_variant_observation_count": {
      const variants = state.formClassVariantCounts.get(edit.formClassId);
      const previousCount = variants?.get(edit.variantId);
      if (previousCount === undefined || !variants) throw new Error(`variant ${edit.variantId} does not exist in form class ${edit.formClassId}`);
      if (edit.count < 0) throw new Error("observation count must be non-negative");
      const nextVariants = new Map(variants);
      nextVariants.set(edit.variantId, edit.count);
      const formClassVariantCounts = new Map(state.formClassVariantCounts);
      formClassVariantCounts.set(edit.formClassId, nextVariants);
      const formClassTotals = new Map(state.formClassTotals);
      formClassTotals.set(edit.formClassId, (state.formClassTotals.get(edit.formClassId) ?? 0) - previousCount + edit.count);
      const formClassEntropyTerms = new Map(state.formClassEntropyTerms);
      formClassEntropyTerms.set(
        edit.formClassId,
        (state.formClassEntropyTerms.get(edit.formClassId) ?? 0) - entropyTermFor(previousCount) + entropyTermFor(edit.count)
      );
      return {
        ...state,
        formClassVariantCounts,
        formClassTotals,
        formClassEntropyTerms
      };
    }
  }
}
