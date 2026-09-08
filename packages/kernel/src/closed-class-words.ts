// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { KneserNeyModel } from "./kneser-ney.js";
import type { LearnedConstructionPart } from "./language-construction.js";

/**
 * Closed-class words (function words, connectives) derived from the active
 * language's evidence, never from a hardcoded list: the most frequent unigrams
 * of the resident Kneser-Ney models plus single-token literal slots of learned
 * constructions. Language-agnostic by construction.
 */
export function deriveClosedClassWords(input: {
  models?: readonly KneserNeyModel[];
  constructions?: readonly { parts?: readonly LearnedConstructionPart[] }[];
  limit?: number;
}): Set<string> {
  const limit = Math.max(1, input.limit ?? 96);
  // Ranked by how many distinct contexts a word follows, not by how often it occurs.
  //
  // Raw frequency was the proxy for closed class, and on a partially trained corpus it ranks the wrong things.
  // Measured on the live brain, order-1 counts put "born" (18,088) above "when" (8,613) and put wikitext
  // markup -- "style" 81,870, "align" 82,485 -- above both, so the closed class held markup and content words
  // while the question words fell outside the limit and survived as things an answer had to contain.
  //
  // Kneser-Ney already computes the property that actually distinguishes a function word: the number of
  // distinct histories it continues. On the same brain "when" continues 859 distinct contexts and "born" 57,
  // "the" 4,713 and "align" 24; "a" and "i" continue thousands and stay closed-class at one character, and
  // a single-character Hani content word continues almost none. The number is learned, per corpus, in any
  // script, and was on the hydrated model the whole time. Unigram counts remain the fallback for a model too
  // small to carry continuations at all.
  const totals = new Map<string, number>();
  let continuations = 0;
  for (const model of input.models ?? []) {
    for (const [symbol, contexts] of Object.entries(model.continuationCounts ?? {})) {
      if (!isWordSymbol(symbol)) continue;
      totals.set(symbol, (totals.get(symbol) ?? 0) + contexts);
      continuations++;
    }
  }
  if (!continuations) {
    for (const model of input.models ?? []) {
      for (const [symbol, count] of Object.entries(model.unigramCounts ?? {})) {
        if (!isWordSymbol(symbol)) continue;
        totals.set(symbol, (totals.get(symbol) ?? 0) + count);
      }
    }
  }
  const ranked = [...totals.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  const out = new Set(ranked.slice(0, limit).map(([symbol]) => symbol.toLocaleLowerCase()));
  for (const construction of input.constructions ?? []) {
    for (const part of construction.parts ?? []) {
      if (part.kind !== "literal") continue;
      const surface = part.surface.trim().toLocaleLowerCase();
      if (surface && !/\s/u.test(surface) && isWordSymbol(surface)) out.add(surface);
    }
  }
  return out;
}


function isWordSymbol(symbol: string): boolean {
  if (!symbol || symbol.startsWith("<") || symbol.length > 24) return false;
  return /^[\p{L}\p{M}'’-]+$/u.test(symbol);
}
