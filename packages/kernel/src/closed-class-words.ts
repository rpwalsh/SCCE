// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { calibrated } from "./calibrations/prod-calibrations.js";
import type { KneserNeyModel } from "./kneser-ney.js";
import { jsonRecord, namedSubjectAnchors } from "./kernel-answer-primitives.js";
import { requestContentAnchorUnits } from "./local-evidence-runtime.js";
import { isRequestRequirementPattern, requestFeatures, REQUEST_UNIT_RESPONSE_COPY_RECIPE_ID } from "./request-requirement-learning.js";
import { unicodeLexicalSegments } from "./unicode-segmentation.js";
import type { LanguageContinuationPopulation, LanguagePatternRecord } from "./storage.js";

const closedClassByPopulation = new WeakMap<object, Map<number, ReadonlySet<string> | null>>();

/**
 * Closed-class words (function words, connectives) derived from the active
 * language's evidence, never from a hardcoded list: the most frequent unigrams
 * of the resident Kneser-Ney models plus single-token literal slots of learned
 * constructions. Language-agnostic by construction.
 */
/** Source-paired request form excludes any unit copied by an overlapping reply witness. */
export function requestScaffoldingConstructions(
  patterns: readonly LanguagePatternRecord[],
  authority?: string,
  requestText?: string
): Array<{ parts: Array<{ kind: "literal"; surface: string }> }> {
  const observed = requestText?.trim() ? new Set(requestFeatures(requestText).map(row => `${row.anchor}\u0000${row.surface}`)) : undefined;
  const candidates = new Set<string>();
  const copied = new Set<string>();
  for (const pattern of patterns) {
    if (!isRequestRequirementPattern(pattern)) continue;
    const record = jsonRecord(pattern.patternJson);
    if (typeof record.surface !== "string" || typeof record.selectedAuthority !== "string"
      || (authority && record.selectedAuthority !== authority)
      || (observed && !observed.has(`${record.anchor}\u0000${record.surface}`))
      || record.requestUnitResponseCopyRecipe !== REQUEST_UNIT_RESPONSE_COPY_RECIPE_ID
      || record.requestUnitResponseCopyAuthority !== record.selectedAuthority
      || !Array.isArray(record.requestUnitResponseCopy)) continue;
    const units = new Set(unicodeLexicalSegments(record.surface).map(row => row.normalized));
    for (const value of record.requestUnitResponseCopy) {
      const witness = jsonRecord(value);
      const unit = witness.unit;
      const supportedPairs = witness.supportedPairs;
      const copiedPairs = witness.copiedPairs;
      if (typeof unit !== "string" || !units.has(unit) || typeof supportedPairs !== "number" || typeof copiedPairs !== "number"
        || !Number.isSafeInteger(supportedPairs) || supportedPairs <= 0
        || !Number.isSafeInteger(copiedPairs) || copiedPairs < 0 || copiedPairs > supportedPairs) continue;
      if (copiedPairs > 0) copied.add(unit);
      else if (record.requestSpanRole === "control") candidates.add(unit);
    }
  }
  return [...candidates].filter(unit => !copied.has(unit)).map(surface => ({ parts: [{ kind: "literal" as const, surface }] }));
}

/**
 * The closed class of a REQUEST: what its words may be discounted as scaffolding when judging whether an answer
 * carries the relation asked about.
 *
 * Two learned sources, applied where each is valid. The interaction corpus's request patterns say which words open or
 * frame a request ("who", "what is", "list the") and apply at matching source-observed features. The role language's continuation counts say which
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
  /** Learned by the selected language identity; used only when turn hydration has no runtime statistics. */
  identityClosedClassWords?: ReadonlySet<string>;
  patterns?: readonly LanguagePatternRecord[];
  authority?: string;
  limit?: number;
}): Set<string> {
  const scaffolding = deriveClosedClassWords({ constructions: requestScaffoldingConstructions(input.patterns ?? [], input.authority, input.requestText) });
  const limit = closedClassLimit(input.limit);
  const modelRank = input.models?.length && !(input.continuationPopulation && closedClassFromPopulation(input.continuationPopulation, limit))
    ? rankModelClosedClass(input.models, limit, true) : undefined;
  const corpus = deriveClosedClassWordsPrepared({
    models: input.models ?? [],
    continuationPopulation: input.continuationPopulation,
    identityClosedClassWords: input.identityClosedClassWords,
    limit: input.limit
  }, modelRank);
  const out = new Set(scaffolding);
  for (const unit of requestContentAnchorUnits(input.requestText)) if (corpus.has(unit)) out.add(unit);
  // The request corpus teaches its frames with real subjects in them ("Who was Ada Lovelace?"), so the subjects'
  // words arrive here as scaffolding literals; the moment that corpus was ingested, "Who is Ada Lovelace?" dropped
  // its only anchor group as scaffolding and retrieved nothing. What this request names is never its scaffolding.
  //
  // Except what the corpus-scale population itself ranks closed: a named run can span the whole request, and
  // deleting its words unconditionally deleted the ranking's own verdict. Measured on the live brain,
  // "What is Mercury?" is one named run before any corpus identity is primed, so "what" -- continuation rank 71 of
  // 92,989 word types, inside the limit -- was dropped with "mercury" and the request kept every word as content.
  // Naming something cannot make a function word of this language stop being one.
  //
  // Use the best corpus statistic available. A full continuation population wins when present; otherwise the
  // hydrated models carry the same learned continuation counts. Omitting models here erased every model-only
  // function word inside a maximal named run, even when the request-scoped corpus set had correctly ranked it.
  const ranked = namedRunClosedClassWords(input, modelRank);
  for (const anchor of namedSubjectAnchors(input.requestText)) {
    for (const unit of anchor.toLocaleLowerCase().split(/\s+/u)) if (!ranked.has(unit)) out.delete(unit);
  }
  return out;
}

function namedRunClosedClassWords(input: {
  models?: readonly KneserNeyModel[];
  continuationPopulation?: LanguageContinuationPopulation;
  identityClosedClassWords?: ReadonlySet<string>;
  limit?: number;
}, prepared?: ModelClosedClassRank): Set<string> {
  const limit = closedClassLimit(input.limit);
  if (input.continuationPopulation) {
    const measuredPopulation = closedClassFromPopulation(input.continuationPopulation, limit);
    if (measuredPopulation) return new Set(measuredPopulation);
  }
  if (input.models?.length) {
    const ranked = prepared ?? rankModelClosedClass(input.models, limit, true);
    return ranked.namedRunEligible ? new Set(ranked.words) : new Set();
  }
  if (input.continuationPopulation) return new Set();
  return deriveClosedClassWords({ identityClosedClassWords: input.identityClosedClassWords, limit });
}

type ClosedClassInput = {
  models?: readonly KneserNeyModel[];
  continuationPopulation?: LanguageContinuationPopulation;
  /** Learned by the selected language identity; never substitutes for present runtime statistics. */
  identityClosedClassWords?: ReadonlySet<string>;
  constructions?: readonly { parts?: readonly { kind: string; surface?: string; [key: string]: unknown }[] }[];
  limit?: number;
};

export function deriveClosedClassWords(input: ClosedClassInput): Set<string> {
  return deriveClosedClassWordsPrepared(input);
}

function deriveClosedClassWordsPrepared(input: ClosedClassInput, prepared?: ModelClosedClassRank): Set<string> {
  const limit = closedClassLimit(input.limit);
  const hasRuntimeStatistics = Boolean(input.continuationPopulation) || (input.models?.length ?? 0) > 0;
  if (!hasRuntimeStatistics && input.identityClosedClassWords?.size) {
    const out = new Set([...input.identityClosedClassWords]
      .map(symbol => symbol.toLocaleLowerCase())
      .filter(isWordSymbol));
    addConstructionWords(out, input.constructions ?? []);
    return new Set([...out].slice(0, limit));
  }
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
  const out = new Set((prepared ?? rankModelClosedClass(input.models ?? [], limit, false)).words);
  addConstructionWords(out, input.constructions ?? []);
  return out;
}

interface ModelClosedClassRank { words: ReadonlySet<string>; namedRunEligible: boolean }

function rankModelClosedClass(models: readonly KneserNeyModel[], limit: number, measureNamedRun: boolean): ModelClosedClassRank {
  const totals = new Map<string, number>();
  const positiveContinuations = new Set<string>();
  const positiveUnigrams = new Set<string>();
  let continuations = 0;
  for (const model of models) {
    for (const [symbol, contexts] of Object.entries(model.continuationCounts ?? {})) {
      if (!isWordSymbol(symbol)) continue;
      totals.set(symbol, (totals.get(symbol) ?? 0) + contexts);
      continuations++;
      if (measureNamedRun && positiveContinuations.size < limit && Number.isFinite(contexts) && contexts > 0) positiveContinuations.add(symbol);
    }
  }
  if (!continuations || (measureNamedRun && positiveContinuations.size === 0)) {
    for (const model of models) {
      for (const [symbol, count] of Object.entries(model.unigramCounts ?? {})) {
        if (!isWordSymbol(symbol)) continue;
        if (!continuations) totals.set(symbol, (totals.get(symbol) ?? 0) + count);
        if (measureNamedRun && positiveUnigrams.size < limit && Number.isFinite(count) && count > 0) positiveUnigrams.add(symbol);
      }
    }
  }
  const ranked = [...totals.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return { words: new Set(ranked.slice(0, limit).map(([symbol]) => symbol.toLocaleLowerCase())),
    namedRunEligible: (positiveContinuations.size > 0 ? positiveContinuations.size : positiveUnigrams.size) >= limit };
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
