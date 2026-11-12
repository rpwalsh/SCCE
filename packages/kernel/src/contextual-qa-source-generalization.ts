// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { segmentUnicodeSurfaceV2 } from "./unicode-segmentation-v2.js";

export type ContextualQaSourceSurfaceClass = "observed" | "open";
export interface ContextualQaSourceSpan { slotIndex: number; startCodePoint: number; endCodePoint: number; surfaceClass?: ContextualQaSourceSurfaceClass }
export interface ContextualQaSourceWindow { id: string; surface: string; protectedSpans: readonly ContextualQaSourceSpan[] }
export interface ContextualQaSourceGeneralization {
  parts: Array<string | { slotIndex: number }>;
  sourceOnlyRoles: Array<{ slotIndex: number; surfaceClass: ContextualQaSourceSurfaceClass; observedValues: string[] }>;
  fit: Array<{ id: string; sourceOnlySpans: ContextualQaSourceSpan[] }>;
}
type Prepared = { input: ContextualQaSourceWindow; points: string[]; spans: ContextualQaSourceSpan[]; gaps: Array<{ surface: string; start: number }> };
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Source-only variation is a measured finite class; it never becomes an unrestricted factual modifier. */
export function generalizeContextualQaSources(input: { fit: readonly ContextualQaSourceWindow[];
  sourceOnlySurfaceClass?: ContextualQaSourceSurfaceClass }): ContextualQaSourceGeneralization | undefined {
  if (!input.fit.length || new Set(input.fit.map(row => row.id)).size !== input.fit.length) return undefined;
  const prepared = input.fit.map(prepare);
  if (prepared.some(row => !row)) return undefined;
  const rows = (prepared as Prepared[]).sort((a, b) => compare(a.input.surface, b.input.surface));
  const order = rows[0]!.spans.map(span => span.slotIndex);
  if (!order.length || rows.some(row => row.spans.length !== order.length || row.spans.some((span, index) => span.slotIndex !== order[index]))) return undefined;
  let nextSlot = Math.max(...order) + 1;
  const model: ContextualQaSourceGeneralization = { parts: [], sourceOnlyRoles: [], fit: input.fit.map(row => ({ id: row.id, sourceOnlySpans: [] })) };
  const fitById = new Map(model.fit.map(row => [row.id, row]));
  const literal = (surface: string) => {
    if (!surface) return;
    const last = model.parts.at(-1);
    if (typeof last === "string") model.parts[model.parts.length - 1] = last + surface;
    else model.parts.push(surface);
  };
  for (let gap = 0; gap <= order.length; gap++) {
    const surfaces = rows.map(row => row.gaps[gap]!.surface);
    const points = surfaces.map(surface => [...surface]);
    const tokens = surfaces.map(surface => segmentUnicodeSurfaceV2(surface).lexicalSegments);
    const counts = tokens.map(sequence => {
      const map = new Map<string, number[]>();
      sequence.forEach((token, index) => { const indexes = map.get(token.surface) ?? []; indexes.push(index); map.set(token.surface, indexes); });
      return map;
    });
    const anchors = tokens[0]!.filter(token => counts.every(map => map.get(token.surface)?.length === 1))
      .map(token => tokens.map((sequence, index) => sequence[counts[index]!.get(token.surface)![0]!]!));
    const paths: Array<{ score: number; indexes: number[]; key: string }> = [];
    for (let end = 0; end < anchors.length; end++) {
      const weight = [...anchors[end]![0]!.surface].length;
      let best = { score: weight, indexes: [end], key: JSON.stringify([anchors[end]![0]!.surface]) };
      for (let previous = 0; previous < end; previous++) {
        if (!anchors[end]!.every((token, index) => anchors[previous]![index]!.codePointEnd <= token.codePointStart)) continue;
        const indexes = [...paths[previous]!.indexes, end];
        const candidate = { score: paths[previous]!.score + weight, indexes, key: JSON.stringify(indexes.map(index => anchors[index]![0]!.surface)) };
        if (candidate.score > best.score || (candidate.score === best.score && compare(candidate.key, best.key) < 0)) best = candidate;
      }
      paths.push(best);
    }
    const chain = paths.sort((a, b) => b.score - a.score || compare(a.key, b.key))[0]?.indexes ?? [];
    const cursors = rows.map(() => 0);
    for (let position = 0; position <= chain.length; position++) {
      const anchor = position < chain.length ? anchors[chain[position]!] : undefined;
      const ends = rows.map((_, index) => anchor ? anchor[index]!.codePointStart : points[index]!.length);
      const values = points.map((surface, index) => surface.slice(cursors[index], ends[index]).join(""));
      if (values.every(value => value === values[0])) literal(values[0]!);
      else {
        const variants = values.map(value => [...value]);
        const minimum = Math.min(...variants.map(value => value.length));
        let prefix = 0, suffix = 0;
        while (prefix < minimum && variants.every(value => value[prefix] === variants[0]![prefix])) prefix++;
        while (suffix < minimum - prefix && variants.every(value => value[value.length - suffix - 1] === variants[0]![variants[0]!.length - suffix - 1])) suffix++;
        const boundaries = values.map((value, index) => {
          const segmentation = segmentUnicodeSurfaceV2(value);
          return new Set([0, variants[index]!.length,
            ...segmentation.surfaceSegments.flatMap(segment => segment.kind === "whitespace" || segment.kind === "control"
              ? Array.from({ length: segment.codePointEnd - segment.codePointStart + 1 }, (_unused, offset) => segment.codePointStart + offset)
              : [segment.codePointStart, segment.codePointEnd]),
            ...segmentation.lexicalSegments.flatMap(segment => [segment.codePointStart, segment.codePointEnd])]);
        });
        while (prefix > 0 && !boundaries.every(boundary => boundary.has(prefix))) prefix--;
        while (suffix > 0 && !boundaries.every((boundary, index) => boundary.has(variants[index]!.length - suffix))) suffix--;
        const observed = variants.map(value => value.slice(prefix, value.length - suffix).join(""));
        // An absent modifier is measurable when the surrounding literal/protected-role geometry makes the
        // zero-width choice unique. Preserve that absence as a class member without fabricating a zero-width
        // construction role; the interpreter below still rejects multiple complete parses.
        if (observed.some(value => value !== "" && !value.trim()) || !Number.isSafeInteger(nextSlot)) return undefined;
        literal(variants[0]!.slice(0, prefix).join(""));
        const slotIndex = nextSlot++;
        model.parts.push({ slotIndex });
        const surfaceClass = input.sourceOnlySurfaceClass ?? "observed";
        model.sourceOnlyRoles.push({ slotIndex, surfaceClass, observedValues: [...new Set(observed)].sort(compare) });
        rows.forEach((row, index) => {
          const startCodePoint = row.gaps[gap]!.start + cursors[index]! + prefix;
          const endCodePoint = row.gaps[gap]!.start + ends[index]! - suffix;
          if (endCodePoint > startCodePoint) fitById.get(row.input.id)!.sourceOnlySpans.push({ slotIndex, startCodePoint, endCodePoint, surfaceClass });
        });
        literal(variants[0]!.slice(variants[0]!.length - suffix).join(""));
      }
      if (anchor) { literal(anchor[0]!.surface); anchor.forEach((token, index) => { cursors[index] = token.codePointEnd; }); }
    }
    if (gap < order.length) model.parts.push({ slotIndex: order[gap]! });
  }
  // A learned relation may be expressed by role order plus an observed separator alone (for example,
  // an attributive value immediately before the request-bound subject).  Requiring a lexical literal
  // discards that corpus-derived construction and is language-specific; an empty separator remains
  // inadmissible because adjacent open roles have no measurable boundary.
  if (!model.parts.some(part => typeof part === "string" && part.length > 0)) return undefined;
  if (!rows.every(row => interpretContextualQaSourceGeneralization({ model, surface: row.input.surface, protectedSpans: row.spans }))) return undefined;
  return model;
}

/** A held-out window supplies no class members; multiple complete parses are rejected. */
export function interpretContextualQaSourceGeneralization(input: {
  model: Pick<ContextualQaSourceGeneralization, "parts" | "sourceOnlyRoles">;
  surface: string; protectedSpans: readonly ContextualQaSourceSpan[];
}): { sourceOnlySpans: ContextualQaSourceSpan[] } | undefined {
  const row = prepare({ id: "interpret", surface: input.surface, protectedSpans: input.protectedSpans });
  if (!row) return undefined;
  const classes = new Map(input.model.sourceOnlyRoles.map(role => [role.slotIndex, role]));
  if (classes.size !== input.model.sourceOnlyRoles.length || [...classes].some(([slot, values]) => !Number.isSafeInteger(slot) || slot < 0
    || !["observed", "open"].includes(values.surfaceClass) || !values.observedValues.length
    || values.observedValues.some(value => typeof value !== "string" || value !== "" && !value.trim())
    || new Set(values.observedValues).size !== values.observedValues.length)) return undefined;
  const gaps: Array<Array<string | { slotIndex: number }>> = [[]];
  const protectedOrder: number[] = [];
  for (const part of input.model.parts) {
    if (typeof part === "string" || classes.has(part.slotIndex)) gaps.at(-1)!.push(part);
    else { protectedOrder.push(part.slotIndex); gaps.push([]); }
  }
  if (protectedOrder.length !== row.spans.length || protectedOrder.some((slot, index) => slot !== row.spans[index]!.slotIndex)
    || row.spans.some(span => classes.has(span.slotIndex))) return undefined;
  const found: ContextualQaSourceSpan[] = [];
  for (let gap = 0; gap < gaps.length; gap++) {
    const current = row.gaps[gap]!;
    const boundaries = codeUnitBoundaries(current.surface);
    const codePointsAt = new Map<number, number>([[0, 0]]);
    let codeUnitOffset = 0, codePointOffset = 0;
    for (const point of current.surface) {
      codeUnitOffset += point.length;
      codePointsAt.set(codeUnitOffset, ++codePointOffset);
    }
    let states = new Map<number, { ways: number; spans: ContextualQaSourceSpan[] }>([[0, { ways: 1, spans: [] }]]);
    for (const part of gaps[gap]!) {
      const next = new Map<number, { ways: number; spans: ContextualQaSourceSpan[] }>();
      for (const [start, state] of states) for (const value of typeof part === "string" ? [part]
        : classes.get(part.slotIndex)!.surfaceClass === "observed" ? classes.get(part.slotIndex)!.observedValues
          : ["", ...boundaries.filter(end => end > start).map(end => current.surface.slice(start, end)).filter(value => value.trim())]) {
        if (!current.surface.startsWith(value, start)) continue;
        const end = start + value.length, previous = next.get(end);
        const spans = typeof part === "string" || value === "" ? state.spans : [...state.spans, { slotIndex: part.slotIndex,
          startCodePoint: current.start + (codePointsAt.get(start) ?? 0),
          endCodePoint: current.start + (codePointsAt.get(end) ?? codePointOffset),
          surfaceClass: classes.get(part.slotIndex)!.surfaceClass }];
        next.set(end, { ways: Math.min(2, (previous?.ways ?? 0) + state.ways), spans: previous?.spans ?? spans });
      }
      states = next;
      if (!states.size) return undefined;
    }
    const complete = states.get(current.surface.length);
    if (!complete || complete.ways !== 1) return undefined;
    found.push(...complete.spans);
  }
  return { sourceOnlySpans: found };
}

function codeUnitBoundaries(surface: string): number[] {
  const boundaries: number[] = [];
  let offset = 0;
  for (const point of surface) { offset += point.length; boundaries.push(offset); }
  return boundaries;
}

function prepare(input: ContextualQaSourceWindow): Prepared | undefined {
  const points = [...input.surface], spans = input.protectedSpans.map(span => ({ ...span })).sort((a, b) => a.startCodePoint - b.startCodePoint);
  if (spans.some((span, index) => !Number.isSafeInteger(span.slotIndex) || span.slotIndex < 0 || !Number.isSafeInteger(span.startCodePoint)
    || !Number.isSafeInteger(span.endCodePoint) || span.startCodePoint < 0 || span.endCodePoint > points.length || span.endCodePoint <= span.startCodePoint
    || (index > 0 && spans[index - 1]!.endCodePoint > span.startCodePoint))) return undefined;
  const values = new Map<number, string>();
  for (const span of spans) {
    const value = points.slice(span.startCodePoint, span.endCodePoint).join("");
    if (values.has(span.slotIndex) && values.get(span.slotIndex) !== value) return undefined;
    values.set(span.slotIndex, value);
  }
  const gaps: Prepared["gaps"] = [];
  let previous = 0;
  for (const span of spans) { gaps.push({ surface: points.slice(previous, span.startCodePoint).join(""), start: previous }); previous = span.endCodePoint; }
  gaps.push({ surface: points.slice(previous).join(""), start: previous });
  return { input, points, spans, gaps };
}
