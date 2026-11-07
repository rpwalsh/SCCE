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
  const projection = { surface, comparable, boundaries, normalize };
  return { interpret: construction => interpretProjectedConstruction(construction, projection) };
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
