// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LearnedConstruction } from "./language-construction.js";
import { canonicalGraphemeSegmenter, canonicalNormalizationContract, normalizeCanonicalSurface } from "./normalization-contract.js";

export interface InterpretedSurfaceRole {
  roleId: string;
  occurrenceId: string;
  surface: string;
  startCodePoint: number;
  endCodePoint: number;
}

export interface LearnedSurfaceInterpreter {
  interpret(construction: Pick<LearnedConstruction, "sequence">): InterpretedSurfaceRole[] | undefined;
  enumerate(construction: Pick<LearnedConstruction, "sequence">, options: SurfaceEnumerationOptions): SurfaceEnumerationResult;
}

export interface SurfaceEnumerationOptions {
  maxTransitions: number;
  consumeTransition?: () => boolean;
  knownSurfaces?: ReadonlyMap<string, string>;
  acceptRole?: (role: InterpretedSurfaceRole) => boolean;
  visit?: (roles: readonly InterpretedSurfaceRole[]) => void | boolean;
  collect?: boolean;
}

export interface SurfaceEnumerationResult {
  interpretations: InterpretedSurfaceRole[][];
  complete: boolean;
  truncated: boolean;
  visited: number;
}

interface SurfaceProjection {
  surface: string;
  comparable: string;
  boundaries: ReadonlyMap<number, { utf16: number; codePoint: number }>;
  boundaryOffsets: readonly number[];
  normalize: (value: string) => string;
}

/** Share one grapheme projection across the acquired programs tested against this exact surface. */
export function createLearnedSurfaceInterpreter(surface: string, canonicalComparison = false): LearnedSurfaceInterpreter {
  const contract = canonicalComparison ? canonicalNormalizationContract() : undefined;
  const normalize = contract ? (value: string) => normalizeCanonicalSurface(value, contract) : (value: string) => value;
  const boundaries = new Map<number, { utf16: number; codePoint: number }>();
  let comparable = "";
  let points = 0;
  boundaries.set(0, { utf16: 0, codePoint: 0 });
  for (const segment of canonicalGraphemeSegmenter().segment(surface)) {
    comparable += normalize(segment.segment);
    points += [...segment.segment].length;
    boundaries.set(comparable.length, { utf16: segment.index + segment.segment.length, codePoint: points });
  }
  let boundaryOffsets: number[] | undefined;
  const projection = { surface, comparable, boundaries, normalize,
    get boundaryOffsets() { return boundaryOffsets ??= [...boundaries.keys()]; } };
  return { interpret: construction => interpretProjectedConstruction(construction, projection),
    enumerate: (construction, options) => enumerateProjectedConstruction(construction, projection, options) };
}

/** Charge each parser state and candidate slot boundary before expanding it. */
function enumerateProjectedConstruction(construction: Pick<LearnedConstruction, "sequence">, projection: SurfaceProjection,
  options: SurfaceEnumerationOptions): SurfaceEnumerationResult {
  if (!Number.isSafeInteger(options.maxTransitions) || options.maxTransitions <= 0) throw new Error("maxTransitions must be a positive safe integer");
  const result: SurfaceEnumerationResult = { interpretations: [], complete: true, truncated: false, visited: 0 };
  const { sequence } = construction;
  const { surface, comparable, boundaries, boundaryOffsets, normalize } = projection;
  if (!sequence.some(part => part.kind === "literal" && part.surface) || sequence.some(part => part.kind === "literal" && !part.surface)) return result;
  const literals = sequence.map(part => part.kind === "literal" ? normalize(part.surface) : undefined);
  const known = new Map<string, string>();
  type Prefix = { role: InterpretedSurfaceRole; previous?: Prefix };
  type State = { kind: "state"; index: number; cursor: number; prefix?: Prefix };
  type Boundary = { kind: "boundary"; index: number; cursor: number; prefix?: Prefix; end: number; mode: "known" | "literal" | "final" | "adjacent"; offsetIndex: number };
  const stack: Array<State | Boundary> = [{ kind: "state", index: 0, cursor: 0 }];
  while (stack.length) {
    if (result.visited === options.maxTransitions) { result.complete = false; result.truncated = true; break; }
    if (options.consumeTransition && !options.consumeTransition()) { result.complete = false; result.truncated = true; break; }
    const frame = stack.pop()!;
    result.visited++;
    if (frame.kind === "state") {
      const { index, cursor, prefix } = frame;
      if (index === sequence.length) {
        if (cursor !== comparable.length) continue;
        const roles: InterpretedSurfaceRole[] = [];
        for (let node = prefix; node; node = node.previous) roles.push(node.role);
        roles.reverse();
        if (options.collect !== false) result.interpretations.push(roles);
        if (options.visit?.(roles) === false) { result.complete = false; break; }
        continue;
      }
      const part = sequence[index]!;
      if (part.kind === "literal") {
        const literal = literals[index]!;
        const end = cursor + literal.length;
        if (comparable.startsWith(literal, cursor) && boundaries.has(end)) stack.push({ kind: "state", index: index + 1, cursor: end, prefix });
        continue;
      }
      if (!boundaries.has(cursor)) continue;
      const value = options.knownSurfaces?.get(part.occurrenceId);
      if (value !== undefined) {
        if (!known.has(part.occurrenceId)) known.set(part.occurrenceId, normalize(value));
        const expected = known.get(part.occurrenceId)!;
        if (expected && comparable.startsWith(expected, cursor)) stack.push({ kind: "boundary", index, cursor, prefix,
          end: cursor + expected.length, mode: "known", offsetIndex: 0 });
      } else if (sequence[index + 1]?.kind === "slot") {
        let offsetIndex = 0, high = boundaryOffsets.length;
        while (offsetIndex < high) {
          const middle = Math.floor((offsetIndex + high) / 2);
          if (boundaryOffsets[middle]! <= cursor) offsetIndex = middle + 1;
          else high = middle;
        }
        if (offsetIndex < boundaryOffsets.length) stack.push({ kind: "boundary", index, cursor, prefix,
          end: boundaryOffsets[offsetIndex]!, mode: "adjacent", offsetIndex });
      } else {
        const next = literals[index + 1];
        const end = next === undefined ? comparable.length : comparable.indexOf(next, cursor + 1);
        if (end > cursor) stack.push({ kind: "boundary", index, cursor, prefix, end,
          mode: next === undefined ? "final" : "literal", offsetIndex: 0 });
      }
      continue;
    }
    const { index, cursor, prefix, end, mode } = frame;
    if (mode === "adjacent") {
      const offsetIndex = frame.offsetIndex + 1;
      if (offsetIndex < boundaryOffsets.length) stack.push({ ...frame, end: boundaryOffsets[offsetIndex]!, offsetIndex });
    } else if (mode === "literal") {
      const next = comparable.indexOf(literals[index + 1]!, end + 1);
      if (next > cursor) stack.push({ ...frame, end: next });
    }
    const startBoundary = boundaries.get(cursor), endBoundary = boundaries.get(end);
    if (end <= cursor || !startBoundary || !endBoundary) continue;
    const part = sequence[index]!;
    if (part.kind !== "slot") continue;
    const role: InterpretedSurfaceRole = { roleId: part.roleId, occurrenceId: part.occurrenceId,
      surface: surface.slice(startBoundary.utf16, endBoundary.utf16), startCodePoint: startBoundary.codePoint, endCodePoint: endBoundary.codePoint };
    if (options.acceptRole && !options.acceptRole(role)) continue;
    stack.push({ kind: "state", index: index + 1, cursor: end, prefix: { role, previous: prefix } });
  }
  return result;
}

function interpretProjectedConstruction(construction: Pick<LearnedConstruction, "sequence">, projection: {
  surface: string;
  comparable: string;
  boundaries: ReadonlyMap<number, { utf16: number; codePoint: number }>;
  normalize: (value: string) => string;
}): InterpretedSurfaceRole[] | undefined {
  const { surface, comparable, boundaries, normalize } = projection;
  if (!construction.sequence.some(part => part.kind === "literal" && part.surface)) return undefined;
  if (construction.sequence.some(part => part.kind === "literal" && !part.surface)) return undefined;
  const literals = construction.sequence.map(part => part.kind === "literal" ? normalize(part.surface) : undefined);
  const memo = new Map<string, InterpretedSurfaceRole[][]>();
  const parse = (index: number, cursor: number): InterpretedSurfaceRole[][] => {
    if (index === construction.sequence.length) return cursor === comparable.length ? [[]] : [];
    const key = `${index}:${cursor}`;
    const cached = memo.get(key);
    if (cached) return cached;
    const part = construction.sequence[index]!;
    if (part.kind === "literal") {
      const literal = literals[index]!;
      const end = cursor + literal.length;
      const result = comparable.startsWith(literal, cursor) && boundaries.has(end) ? parse(index + 1, end) : [];
      memo.set(key, result);
      return result;
    }
    const startBoundary = boundaries.get(cursor);
    if (!startBoundary || construction.sequence[index + 1]?.kind === "slot") return [];
    const next = literals[index + 1];
    const results: InterpretedSurfaceRole[][] = [];
    let end = next === undefined ? comparable.length : comparable.indexOf(next, cursor + 1);
    while (end > cursor) {
      const endBoundary = boundaries.get(end);
      if (endBoundary) for (const suffix of parse(index + 1, end)) {
        results.push([{
          roleId: part.roleId, occurrenceId: part.occurrenceId,
          surface: surface.slice(startBoundary.utf16, endBoundary.utf16),
          startCodePoint: startBoundary.codePoint, endCodePoint: endBoundary.codePoint
        }, ...suffix]);
        if (results.length > 1) { memo.set(key, results); return results; }
      }
      if (next === undefined) break;
      end = comparable.indexOf(next, end + 1);
    }
    memo.set(key, results);
    return results;
  };
  const matches = parse(0, 0);
  return matches.length === 1 ? matches[0] : undefined;
}

export function interpretLearnedSurface(input: {
  construction: Pick<LearnedConstruction, "sequence">;
  surface: string;
  canonicalComparison?: boolean;
}): InterpretedSurfaceRole[] | undefined {
  return createLearnedSurfaceInterpreter(input.surface, input.canonicalComparison).interpret(input.construction);
}
