// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// A translator that reads a page and forgets it is a stunt. What makes it a faculty is that the second page of
// the same hand is easier than the first: the marks it already worked out come back already known, and only
// what is new has to be worked out again.
//
// So what the eye learns about a script is kept as its SIGNS, not as its pages. A sign is remembered by the
// shape of its own exemplar and the symbol it turned out to stand for, which is exactly what a translation seed
// holds -- a source symbol, a target symbol, a score and a basis of "shape". Nothing about the page it came
// from is kept, because nothing about that page is what recurs.
//
// A remembered sign is matched to a new page's sign by the same profile distance the page's own inventory was
// built with, and accepted only inside that page's own measured same-sign scale. So the memory is never
// consulted more loosely than the page trusts its own marks, and a hand different enough not to match simply
// does not, which is the honest outcome rather than a wrong reading carried forward.

import type { GlyphProfile } from "./visual-shape-signature.js";
import { profileDistance } from "./visual-shape-signature.js";
import type { PageSigns } from "./visual-sign-inventory.js";

/** A sign the eye has read before: the shape of its exemplar, and the symbol it stood for. */
export interface LearnedSign {
  readonly exemplar: GlyphProfile;
  readonly symbol: string;
  /** How well the reading that taught it was supported. */
  readonly score: number;
}

/** Densities are quantised to the resolution a cell can carry, so a signature is stable and comparable. */
const QUANTUM = 1000;

/**
 * A sign's exemplar as one self-describing string, so it can live in a store that holds symbols rather than
 * vectors. The grid comes first because two profiles on different grids are not comparable at all.
 */
export function encodeExemplar(exemplar: GlyphProfile): string {
  const densities = exemplar.density.map(value => Math.round(value * QUANTUM)).join(".");
  return `${exemplar.cols}x${exemplar.rows}:${densities}`;
}

/** The inverse, returning nothing rather than a guess when the text is not an exemplar. */
export function decodeExemplar(text: string): GlyphProfile | undefined {
  const parts = /^(\d+)x(\d+):([0-9.]*)$/.exec(text);
  if (!parts) return undefined;
  const cols = Number(parts[1]);
  const rows = Number(parts[2]);
  const density = parts[3]!.length ? parts[3]!.split(".").map(value => Number(value) / QUANTUM) : [];
  if (!Number.isFinite(cols) || !Number.isFinite(rows) || density.length !== cols * rows) return undefined;
  if (density.some(value => !Number.isFinite(value))) return undefined;
  return { cols, rows, density };
}

/** What the eye learned about one script, ready to be kept. */
export interface ScriptMemory {
  readonly scriptId: string;
  readonly targetLanguage: string;
  readonly signs: readonly LearnedSign[];
}

/**
 * What a reading learned worth keeping: each sign of the page that was actually given a symbol, as its own
 * exemplar. Signs the reading could not place are not kept, because a sign with no symbol teaches nothing.
 */
export function scriptMemoryOf(input: {
  readonly scriptId: string;
  readonly targetLanguage: string;
  readonly signs: PageSigns;
  readonly signToSymbol: ReadonlyMap<number, string>;
  readonly score: number;
}): ScriptMemory {
  const learned: LearnedSign[] = [];
  for (const cluster of input.signs.inventory.clusters) {
    const symbol = input.signToSymbol.get(cluster.id);
    if (symbol === undefined) continue;
    learned.push({ exemplar: cluster.exemplar, symbol, score: input.score });
  }
  return { scriptId: input.scriptId, targetLanguage: input.targetLanguage, signs: learned };
}

export interface RecalledSign {
  /** The sign id on the page now being read. */
  readonly sign: number;
  readonly symbol: string;
  readonly distance: number;
  readonly score: number;
}

/**
 * Match a page's signs against signs read before, within the page's own measured same-sign scale. Each
 * remembered sign may claim at most one sign of this page and each sign of this page at most one symbol, taken
 * in order of closeness, so a single remembered shape cannot label half the page.
 */
export function recallSigns(signs: PageSigns, remembered: readonly LearnedSign[]): RecalledSign[] {
  const scale = signs.inventory.cutDistance;
  if (!remembered.length || !signs.inventory.clusters.length || !(scale > 0)) return [];

  const pairs: RecalledSign[] = [];
  for (const cluster of signs.inventory.clusters) {
    for (const known of remembered) {
      const distance = profileDistance(cluster.exemplar, known.exemplar);
      // Never more loosely than the page trusts its own marks to be the same sign.
      if (!Number.isFinite(distance) || distance > scale) continue;
      pairs.push({ sign: cluster.id, symbol: known.symbol, distance, score: known.score });
    }
  }
  pairs.sort((left, right) =>
    left.distance - right.distance
    || right.score - left.score
    || left.sign - right.sign
    || left.symbol.localeCompare(right.symbol));

  const takenSigns = new Set<number>();
  const takenSymbols = new Set<string>();
  const matched: RecalledSign[] = [];
  for (const pair of pairs) {
    if (takenSigns.has(pair.sign) || takenSymbols.has(pair.symbol)) continue;
    takenSigns.add(pair.sign);
    takenSymbols.add(pair.symbol);
    matched.push(pair);
  }
  return matched;
}
