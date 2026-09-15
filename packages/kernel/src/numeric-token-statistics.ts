// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { KneserNeyModel } from "./kneser-ney.js";
import { freeFormLexiconGeneration, residentLanguageModels } from "./free-form-lexicon.js";
import { otsuThreshold } from "./language-identity.js";

// Units: followers of numbers beyond chance across the vocabulary, Otsu-split by share; marks: roles taught by mixed-mark runs.
export type NumericUnitVerdict = "attached" | "detached" | "silent";
export type NumericSeparatorRole = "grouping" | "decimal" | "silent";

export interface NumericTokenStatistics {
  unit(symbol: string): NumericUnitVerdict;
  separator(mark: string): NumericSeparatorRole;
}

const GRAM_SEPARATOR = "";
const SILENT: NumericTokenStatistics = { unit: () => "silent", separator: () => "silent" };

/** A symbol made only of decimal digits and punctuation, opening and closing on a digit. Pure. */
export function isNumericSymbol(symbol: string): boolean {
  return /^\p{Nd}(?:[\p{Nd}\p{Po}]*\p{Nd})?$/u.test(symbol);
}

/** One punctuation grapheme that may sit between two digit groups. Pure. */
export function isNumericSeparatorSymbol(symbol: string): boolean {
  return /^\p{Po}$/u.test(symbol);
}

export interface NumericRunShape {
  groups: string[];
  marks: string[];
}

/** Digit groups and the marks between them, or undefined when the surface is not digits joined by single marks. Pure. */
export function numericRunShape(surface: string): NumericRunShape | undefined {
  if (!isNumericSymbol(surface)) return undefined;
  const groups: string[] = [];
  const marks: string[] = [];
  let group = "";
  for (const char of surface) {
    if (/\p{Nd}/u.test(char)) {
      group += char;
      continue;
    }
    if (!group) return undefined;
    groups.push(group);
    marks.push(char);
    group = "";
  }
  groups.push(group);
  return { groups, marks };
}

/** The roles a run fixes by itself: two distinct marks, the last occurring once at the end, is grouping then decimal. Pure. */
export function selfEvidentSeparatorRoles(shape: NumericRunShape): { grouping: string; decimal: string } | undefined {
  const distinct = [...new Set(shape.marks)];
  if (distinct.length !== 2) return undefined;
  const decimal = shape.marks[shape.marks.length - 1]!;
  const grouping = distinct.find(mark => mark !== decimal)!;
  if (shape.marks.slice(0, -1).some(mark => mark !== grouping)) return undefined;
  return { grouping, decimal };
}

function chernoffUpperTail(k: number, t: number, p: number): number {
  const q = k / t;
  if (q <= p) return 1;
  const divergence = q * Math.log(q / p) + (q < 1 ? (1 - q) * Math.log((1 - q) / (1 - p)) : 0);
  return Math.exp(-t * divergence);
}

/** Additive counts one model contributes; the turn-level statistics are their sum. */
export interface NumericTokenCounts {
  followers: Map<string, { t: number; k: number }>;
  totalTokens: number;
  numericTokens: number;
  grouping: Map<string, number>;
  decimal: Map<string, number>;
}

let derivations = 0;

/** One pass over a model's gram keys. Pure apart from the derivation counter test seam. */
export function deriveNumericTokenCounts(model: KneserNeyModel): NumericTokenCounts {
  derivations += 1;
  const followers = new Map<string, { t: number; k: number }>();
  let totalTokens = 0;
  let numericTokens = 0;
  const grouping = new Map<string, number>();
  const decimal = new Map<string, number>();
  const numeric = new Map<string, boolean>();
  const isNumeric = (symbol: string): boolean => {
    let cached = numeric.get(symbol);
    if (cached === undefined) { cached = isNumericSymbol(symbol); numeric.set(symbol, cached); }
    return cached;
  };
  const counts = model.counts ?? {};
  for (const gram in counts) {
    const count = counts[gram]!;
    const cut = gram.indexOf(GRAM_SEPARATOR);
    if (cut >= 0 && gram.indexOf(GRAM_SEPARATOR, cut + 1) < 0) {
      const history = gram.slice(0, cut);
      const symbol = gram.slice(cut + 1);
      if (history.startsWith("<") || symbol.startsWith("<") || !/\p{L}/u.test(symbol)) continue;
      const row = followers.get(symbol) ?? { t: 0, k: 0 };
      row.t += count;
      totalTokens += count;
      if (isNumeric(history)) { row.k += count; numericTokens += count; }
      followers.set(symbol, row);
    }
    // Cost bound: only grams that open on a digit can be a numeric run; the rest are skipped on one test.
    if (!/^\p{Nd}/u.test(gram)) continue;
    const parts = cut < 0 ? [gram] : gram.split(GRAM_SEPARATOR);
    if (parts.length % 2 === 0) continue;
    let joined = "";
    let valid = true;
    for (let index = 0; index < parts.length; index++) {
      const part = parts[index]!;
      if (index % 2 === 0 ? !isNumeric(part) : !isNumericSeparatorSymbol(part)) { valid = false; break; }
      joined += part;
    }
    const shape = valid ? numericRunShape(joined) : undefined;
    const roles = shape ? selfEvidentSeparatorRoles(shape) : undefined;
    if (!roles) continue;
    grouping.set(roles.grouping, (grouping.get(roles.grouping) ?? 0) + count);
    decimal.set(roles.decimal, (decimal.get(roles.decimal) ?? 0) + count);
  }
  return { followers, totalTokens, numericTokens, grouping, decimal };
}

/** The unit and separator decisions over summed counts; no gram keys are read here. Pure. */
export function numericTokenStatisticsFromCounts(parts: readonly NumericTokenCounts[]): NumericTokenStatistics {
  const followers = new Map<string, { t: number; k: number }>();
  const grouping = new Map<string, number>();
  const decimal = new Map<string, number>();
  let totalTokens = 0;
  let numericTokens = 0;
  for (const part of parts) {
    totalTokens += part.totalTokens;
    numericTokens += part.numericTokens;
    for (const [symbol, row] of part.followers) {
      const sum = followers.get(symbol);
      if (sum) { sum.t += row.t; sum.k += row.k; } else followers.set(symbol, { t: row.t, k: row.k });
    }
    for (const [mark, count] of part.grouping) grouping.set(mark, (grouping.get(mark) ?? 0) + count);
    for (const [mark, count] of part.decimal) decimal.set(mark, (decimal.get(mark) ?? 0) + count);
  }
  const unitSilent = numericTokens === 0 || totalTokens === 0;
  const attached = new Set<string>();
  if (!unitSilent) {
    const base = numericTokens / totalTokens;
    const significant: Array<{ symbol: string; share: number }> = [];
    for (const [symbol, row] of followers) {
      if (row.k > 0 && followers.size * chernoffUpperTail(row.k, row.t, base) < 1) significant.push({ symbol, share: row.k / row.t });
    }
    // Log scale: shares span orders of magnitude, and a linear cut lands at the top (Gutenberg: 0.67 vs 0.14 in log).
    const cut = otsuThreshold(significant.map(row => Math.log(row.share)));
    for (const row of significant) if (cut === undefined || Math.log(row.share) >= cut) attached.add(row.symbol);
  }
  if (unitSilent && grouping.size === 0) return SILENT;
  return {
    unit(symbol: string): NumericUnitVerdict {
      if (unitSilent) return "silent";
      return attached.has(symbol) ? "attached" : "detached";
    },
    separator(mark: string): NumericSeparatorRole {
      const g = grouping.get(mark) ?? 0;
      const d = decimal.get(mark) ?? 0;
      return g > d ? "grouping" : d > g ? "decimal" : "silent";
    }
  };
}

export function deriveNumericTokenStatistics(models: readonly KneserNeyModel[]): NumericTokenStatistics {
  return numericTokenStatisticsFromCounts(models.map(deriveNumericTokenCounts));
}

let countsByModel = new WeakMap<KneserNeyModel, NumericTokenCounts>();
const countsByIdentity = new Map<string, NumericTokenCounts>();
// Cost bound: persisted model identities kept across re-hydrated model objects; oldest evicted first.
const IDENTITY_CACHE_LIMIT = 256;

function modelIdentity(model: KneserNeyModel): string | undefined {
  return model.sourceKey ? `${model.sourceKey}:${model.order}:${model.observedSymbolCount}:${model.vocabularySize}` : undefined;
}

function cachedNumericTokenCounts(model: KneserNeyModel): NumericTokenCounts {
  const byObject = countsByModel.get(model);
  if (byObject) return byObject;
  const identity = modelIdentity(model);
  let counts = identity ? countsByIdentity.get(identity) : undefined;
  if (!counts) {
    counts = deriveNumericTokenCounts(model);
    if (identity) {
      countsByIdentity.set(identity, counts);
      if (countsByIdentity.size > IDENTITY_CACHE_LIMIT) countsByIdentity.delete(countsByIdentity.keys().next().value!);
    }
  }
  countsByModel.set(model, counts);
  return counts;
}

/** Test seam: how many per-model gram passes have run, and a reset of every cache. */
export function numericTokenDerivationCount(): number {
  return derivations;
}

export function clearNumericTokenStatisticsCache(): void {
  countsByIdentity.clear();
  countsByModel = new WeakMap<KneserNeyModel, NumericTokenCounts>();
  cached = undefined;
  derivations = 0;
}

let cached: { generation: number; statistics: NumericTokenStatistics } | undefined;

/** The statistics of the models this turn installed: cached per-model counts summed, decided once per model set. */
export function residentNumericTokenStatistics(): NumericTokenStatistics {
  const generation = freeFormLexiconGeneration();
  if (cached?.generation === generation) return cached.statistics;
  const models = residentLanguageModels();
  const statistics = models.length ? numericTokenStatisticsFromCounts(models.map(cachedNumericTokenCounts)) : SILENT;
  cached = { generation, statistics };
  return statistics;
}
