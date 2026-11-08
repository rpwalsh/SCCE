// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
declare const sourceTextPointCacheBrand: unique symbol;
export interface SourceTextPointCache { readonly [sourceTextPointCacheBrand]: true }

const sourceTextPointCaches = new WeakMap<SourceTextPointCache, Map<string, string[]>>();

export function createSourceTextPointCache(): SourceTextPointCache {
  const cache = Object.freeze({}) as SourceTextPointCache;
  sourceTextPointCaches.set(cache, new Map());
  return cache;
}

function sourceTextPoints(text: string, cache: SourceTextPointCache): readonly string[] {
  const byText = sourceTextPointCaches.get(cache);
  if (!byText) throw new Error("unrecognized source text point cache");
  let points = byText.get(text);
  if (!points) { points = [...text]; byText.set(text, points); }
  return points;
}

export function sourceTextPointLength(text: string, cache: SourceTextPointCache): number {
  return sourceTextPoints(text, cache).length;
}

export function sourceTextPointSlice(text: string, start: number, end: number, cache: SourceTextPointCache): string {
  return sourceTextPoints(text, cache).slice(start, end).join("");
}
