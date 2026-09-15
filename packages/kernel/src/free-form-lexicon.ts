// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { KneserNeyModel } from "./kneser-ney.js";

/**
 * Which surfaces the corpus uses as free forms, and which are fragments of one fixed phrase.
 *
 * This exists to decide, without a suffix list, whether one surface plus one more letter is the same unit:
 * "discovery" is "discover" inflected, "capital" is not "capita" inflected. The literal rule it replaces accepted
 * exactly one letter, "s", which is English and nothing else, and it is why "What did he discover?" could not
 * read the sentence that says "discovery".
 *
 * The instrument is the Kneser-Ney continuation count at order 1: how many DISTINCT words precede a symbol, the
 * same property deriveClosedClassWords ranks by and the property KN itself substitutes for frequency. A free form
 * is preceded by many different words; a fragment of a fixed phrase is preceded by one. Measured on the live brain,
 * "capita" occurs 119 times after 2 distinct words ("per" is 95% of them) while "capital" occurs 1,428 times after
 * 295, and the corpus's most extreme forms by this measure are exactly the fragments -- lankan, aires, capita,
 * rican, facto, vegas, indies.
 *
 * Diversity alone is frequency-dependent, so the cut is not a number: the corpus's own type/token relation
 * (log k = a + b log t) is fitted over its whole vocabulary and a form is bound when its residual is further into
 * the lower tail than chance explains across a vocabulary of this size -- fewer than one such form expected. The
 * tail is bounded exactly (Mills), so nothing here is approximated or tuned. A form with too few tokens for even a
 * single context to reach that tail has told the corpus nothing and is "unknown", not "free": that is what rejects
 * "Borna" for "born", and an unseen surface, which is what rejects "Majorian" for "Bajoran".
 *
 * What this does NOT do: alternation-level productivity. Measured over all 2,249 one-letter pairs of the live
 * vocabulary, the fraction beating a frequency-matched control is 90% for "s" and 54-70% for every other letter
 * including "l" and "a" -- no separation. Per-pair context similarity is worse still: discover/discovery scores
 * below capita/capital on cosine, Jaccard and document lift. Neither is used here.
 */
export type FreeFormVerdict = "free" | "bound" | "unknown";

export interface FreeFormLexicon {
  /** Forms the type/token relation was fitted over. Zero means the corpus has said nothing yet. */
  readonly forms: number;
  /** What the corpus says about this surface. */
  verdict(unit: string): FreeFormVerdict;
  /** The measurement behind that verdict, for a harness or a trace. */
  measure(unit: string): { tokens: number; contexts: number; z: number } | undefined;
}

const GRAM_SEPARATOR = "\u0001";
const EMPTY_LEXICON: FreeFormLexicon = { forms: 0, verdict: () => "unknown", measure: () => undefined };

/** The exact normal lower-tail bound (Mills): P(Z < z) <= phi(z)/|z| for z < 0. No fitted constants. */
function lowerTailBound(z: number): number {
  if (z >= 0) return 1;
  return Math.exp(-(z * z) / 2) / (Math.abs(z) * Math.sqrt(2 * Math.PI));
}

export function deriveFreeFormLexicon(models: readonly KneserNeyModel[]): FreeFormLexicon {
  const contexts = new Map<string, Set<string>>();
  const tokens = new Map<string, number>();
  // Cost bound: one pass over the resident models' gram keys, 2.29M of them for the 6 models a live turn holds.
  // Entries() materialised a pair array per key and the symbol test ran per gram; both are memoised here, measured
  // 7.6s -> 1.5s on that corpus. Symbols repeat across grams, so the cache is small and the hit rate is high.
  const normalized = new Map<string, string | null>();
  const asWord = (symbol: string): string | null => {
    let cached = normalized.get(symbol);
    if (cached === undefined) {
      cached = !symbol || symbol.startsWith("<") || symbol.length > 24 || !/^[\p{L}\p{M}'’-]+$/u.test(symbol)
        ? null
        : symbol.toLocaleLowerCase();
      normalized.set(symbol, cached);
    }
    return cached;
  };
  for (const model of models) {
    const counts = model.counts ?? {};
    for (const gram in counts) {
      const cut = gram.indexOf(GRAM_SEPARATOR);
      if (cut < 0 || gram.indexOf(GRAM_SEPARATOR, cut + 1) >= 0) continue;
      const history = asWord(gram.slice(0, cut));
      if (history === null) continue;
      const key = asWord(gram.slice(cut + 1));
      if (key === null) continue;
      let seen = contexts.get(key);
      if (!seen) { seen = new Set(); contexts.set(key, seen); }
      seen.add(history);
      tokens.set(key, (tokens.get(key) ?? 0) + counts[gram]!);
    }
  }
  // A form seen once carries no type/token relation at all -- its context count can only be one.
  const measured: Array<{ key: string; t: number; k: number }> = [];
  for (const [key, seen] of contexts) {
    const t = tokens.get(key) ?? 0;
    if (t >= 2) measured.push({ key, t, k: seen.size });
  }
  if (measured.length < 2) return EMPTY_LEXICON;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const row of measured) {
    const x = Math.log(row.t);
    const y = Math.log(row.k);
    sx += x; sy += y; sxx += x * x; sxy += x * y;
  }
  const n = measured.length;
  const denominator = n * sxx - sx * sx;
  if (!(Math.abs(denominator) > 0)) return EMPTY_LEXICON;
  const slope = (n * sxy - sx * sy) / denominator;
  const intercept = (sy - slope * sx) / n;
  let squared = 0;
  for (const row of measured) {
    const residual = Math.log(row.k) - (intercept + slope * Math.log(row.t));
    squared += residual * residual;
  }
  const sigma = Math.sqrt(squared / n);
  if (!(sigma > 0)) return EMPTY_LEXICON;
  const observed = new Map(measured.map(row => [row.key, row] as const));
  return {
    forms: n,
    verdict(unit: string): FreeFormVerdict {
      const row = observed.get(unit.toLocaleLowerCase());
      if (!row) return "unknown";
      const expected = intercept + slope * Math.log(row.t);
      // Could this many tokens have shown the form bound at all? One context is the most constrained it can be.
      if (n * lowerTailBound(-expected / sigma) >= 1) return "unknown";
      return n * lowerTailBound((Math.log(row.k) - expected) / sigma) < 1 ? "bound" : "free";
    },
    measure(unit: string) {
      const row = observed.get(unit.toLocaleLowerCase());
      if (!row) return undefined;
      return { tokens: row.t, contexts: row.k, z: (Math.log(row.k) - (intercept + slope * Math.log(row.t))) / sigma };
    }
  };
}

let resident: readonly KneserNeyModel[] = [];
let lexicon: FreeFormLexicon | undefined;
let signature = "";
let generation = 0;

/**
 * Installs the models this turn hydrated, mirroring primeCorpusIdentitySignals: the answer path's unit matcher is
 * pure and reads what the corpus taught rather than carrying models through thirty call sites. The derivation
 * itself is deferred to the first question asked of it, so a turn that never compares two forms pays nothing.
 */
export function primeFreeFormLexicon(models: readonly KneserNeyModel[]): void {
  let next = `${models.length}`;
  for (const model of models) next += `|${model.sourceKey ?? ""}:${model.order}:${model.observedSymbolCount}`;
  if (next === signature) return;
  resident = models;
  lexicon = undefined;
  signature = next;
  generation += 1;
}

/** Bumped whenever the model set changes, so callers memoizing a match derived from it can tell it is stale. */
export function freeFormLexiconGeneration(): number {
  return generation;
}

/** The language models the current turn installed, for other corpus measurements keyed to the same generation. */
export function residentLanguageModels(): readonly KneserNeyModel[] {
  return resident;
}

export function freeFormLexicon(): FreeFormLexicon | undefined {
  if (!lexicon && resident.length) lexicon = deriveFreeFormLexicon(resident);
  return lexicon;
}

/** Test seam: forget what the corpus taught, so a unit test starts from no corpus knowledge. */
export function clearFreeFormLexicon(): void {
  resident = [];
  lexicon = undefined;
  signature = "";
  generation += 1;
}

/** "silent" is a corpus that has not been hydrated at all, which decides nothing and leaves the caller its own rules. */
export type UnitFormVerdict = "same" | "different" | "silent";

/**
 * Whether the corpus itself says these two surfaces are one unit: one is the other plus a single letter, and the
 * corpus uses both as free forms. This is the whole replacement for the literal plural rule -- one predicate, so
 * the answer path and the harness that checks it cannot drift apart.
 *
 * A hydrated corpus that has never seen one of the surfaces has answered: they are not one form. Only an unhydrated
 * one is silent, and then the caller's own geometry decides exactly as it did before this existed.
 */
export function corpusUnitFormVerdict(left: string, right: string): UnitFormVerdict {
  if (!left || !right || left === right) return "silent";
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  if (longer.length - shorter.length !== 1 || !longer.startsWith(shorter)) return "silent";
  if (!/\p{L}/u.test(longer.slice(shorter.length))) return "silent";
  const corpus = freeFormLexicon();
  if (!corpus) return "silent";
  return corpus.verdict(shorter) === "free" && corpus.verdict(longer) === "free" ? "same" : "different";
}

/** The same question as a boolean, for a caller that treats a silent corpus as no evidence. */
export function corpusTreatsUnitsAsOneForm(left: string, right: string): boolean {
  return corpusUnitFormVerdict(left, right) === "same";
}
