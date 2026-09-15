// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { calibrated } from "./calibrations/prod-calibrations.js";
import type { KneserNeyModel } from "./kneser-ney.js";
import { jsonRecord, namedSubjectAnchors } from "./kernel-answer-primitives.js";
import { requestContentAnchorUnits } from "./local-evidence-runtime.js";
import { isRequestRequirementPattern } from "./request-requirement-learning.js";
import type { LanguageContinuationPopulation, LanguagePatternRecord } from "./storage.js";

const closedClassByPopulation = new WeakMap<object, Map<number, ReadonlySet<string> | null>>();

/**
 * Closed-class words (function words, connectives) derived from the active
 * language's evidence, never from a hardcoded list: the most frequent unigrams
 * of the resident Kneser-Ney models plus single-token literal slots of learned
 * constructions. Language-agnostic by construction.
 */
/**
 * Request scaffolding the interaction corpus taught for an authority ("who", "when" as learned request openers), as
 * literal construction parts for the derivation above. Multi-word surfaces contribute each of their words: "known for"
 * is scaffolding in "What was X known for?", and neither word is a relation the answer must restate. Pure.
 */
export function requestScaffoldingConstructions(
  patterns: readonly LanguagePatternRecord[],
  authority?: string
): Array<{ parts: Array<{ kind: "literal"; surface: string }> }> {
  return patterns
    .filter(isRequestRequirementPattern)
    .map(pattern => jsonRecord(pattern.patternJson))
    .filter(record => typeof record.surface === "string" && (!authority || record.selectedAuthority === authority))
    .flatMap(record => String(record.surface).split(/\s+/u).filter(Boolean)
      .map(surface => ({ parts: [{ kind: "literal" as const, surface }] })));
}

/**
 * The closed class of a REQUEST: what its words may be discounted as scaffolding when judging whether an answer
 * carries the relation asked about.
 *
 * Two learned sources, applied where each is valid. The interaction corpus's request patterns say which words open or
 * frame a request ("who", "what is", "list the") and apply anywhere. The role language's continuation counts say which
 * words the corpus uses in the most contexts.
 *
 * The corpus signal was read off the request's first two words, so that a relation ranked into the closed class could
 * not be discounted mid-request; position is the wrong bound, and "...indigenous to which country?" then required the
 * answer to say "which". It ranges instead over the population this set exists to discount -- the request's own
 * anchor units -- and over nothing else, so a unit no caller judges is never discounted whatever the corpus ranks it.
 */
export function requestClosedClassWords(input: {
  requestText: string;
  models?: readonly KneserNeyModel[];
  continuationPopulation?: LanguageContinuationPopulation;
  patterns?: readonly LanguagePatternRecord[];
  authority?: string;
  limit?: number;
}): Set<string> {
  const scaffolding = deriveClosedClassWords({ constructions: requestScaffoldingConstructions(input.patterns ?? [], input.authority) });
  const corpus = deriveClosedClassWords({ models: input.models ?? [], continuationPopulation: input.continuationPopulation, limit: input.limit });
  const out = new Set(scaffolding);
  for (const unit of requestContentAnchorUnits(input.requestText)) if (corpus.has(unit)) out.add(unit);
  // The request corpus teaches its frames with real subjects in them ("Who was Ada Lovelace?"), so the subjects'
  // words arrive here as scaffolding literals; the moment that corpus was ingested, "Who is Ada Lovelace?" dropped
  // its only anchor group as scaffolding and retrieved nothing. What this request names is never its scaffolding.
  for (const anchor of namedSubjectAnchors(input.requestText)) {
    for (const unit of anchor.toLocaleLowerCase().split(/\s+/u)) out.delete(unit);
  }
  return out;
}

export function deriveClosedClassWords(input: {
  models?: readonly KneserNeyModel[];
  continuationPopulation?: LanguageContinuationPopulation;
  constructions?: readonly { parts?: readonly { kind: string; surface?: string; [key: string]: unknown }[] }[];
  limit?: number;
}): Set<string> {
  const limit = closedClassLimit(input.limit);
  const populationWords = input.continuationPopulation
    ? closedClassFromPopulation(input.continuationPopulation, limit)
    : undefined;
  if (populationWords) {
    const out = new Set(populationWords);
    addConstructionWords(out, input.constructions ?? []);
    return out;
  }
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
  addConstructionWords(out, input.constructions ?? []);
  return out;
}

function closedClassFromPopulation(population: LanguageContinuationPopulation, limit: number): ReadonlySet<string> | undefined {
  if (population.modelCount <= 0) return undefined;
  let byLimit = closedClassByPopulation.get(population);
  if (!byLimit) {
    byLimit = new Map();
    closedClassByPopulation.set(population, byLimit);
  }
  if (byLimit.has(limit)) return byLimit.get(limit) ?? undefined;
  const ranked = Object.entries(population.continuationCounts)
    .filter(([symbol, contexts]) => isWordSymbol(symbol) && Number.isFinite(contexts) && contexts > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (ranked.length < limit) {
    byLimit.set(limit, null);
    return undefined;
  }
  const derived = new Set(ranked.slice(0, limit).map(([symbol]) => symbol.toLocaleLowerCase()));
  byLimit.set(limit, derived);
  return derived;
}

function addConstructionWords(
  out: Set<string>,
  constructions: readonly { parts?: readonly { kind: string; surface?: string; [key: string]: unknown }[] }[]
): void {
  for (const construction of constructions) {
    for (const part of construction.parts ?? []) {
      if (part.kind !== "literal") continue;
      const surface = String(part.surface ?? "").trim().toLocaleLowerCase();
      if (surface && !/\s/u.test(surface) && isWordSymbol(surface)) out.add(surface);
    }
  }
}


function closedClassLimit(limit?: number): number {
  return Math.max(1, limit ?? calibrated("closed_class.rank_limit"));
}

function isWordSymbol(symbol: string): boolean {
  if (!symbol || symbol.startsWith("<") || symbol.length > 24) return false;
  return /^[\p{L}\p{M}'’-]+$/u.test(symbol);
}
