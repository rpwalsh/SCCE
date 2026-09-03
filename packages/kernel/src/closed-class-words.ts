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
  const totals = new Map<string, number>();
  for (const model of input.models ?? []) {
    for (const [symbol, count] of Object.entries(model.unigramCounts ?? {})) {
      if (!isWordSymbol(symbol)) continue;
      totals.set(symbol, (totals.get(symbol) ?? 0) + count);
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
