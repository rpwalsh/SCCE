// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { LearnedRealization, LearnedRealizationTracePart } from "./language-construction.js";

export type ConstructionSurface = Pick<LearnedRealization, "text" | "trace" | "evidenceIds"> & {
  childBindings?: readonly ConstructionSurfaceChildBinding[];
};
export interface ConstructionSurfaceChildBinding {
  roleId: string;
  occurrenceId?: string;
  constructionId?: string;
  outputStart: number;
  outputEnd: number;
  surface: ConstructionSurface;
}
export type ConstructionSurfacePiece =
  | ({ kind: "literal" } & Pick<LearnedRealizationTracePart, "surface" | "evidenceIds" | "sourceExampleIds">)
  | { kind: "slot"; roleId: string; occurrenceId?: string; constructionId?: string; surface: ConstructionSurface };

/** Geometry validation does not replace the caller's construction, evidence or graph authorization. */
export function constructionSurfaceComplete(surface: ConstructionSurface): boolean {
  const active = new WeakSet<object>();
  const valid = (value: ConstructionSurface): boolean => {
    if (!value || typeof value.text !== "string" || !Array.isArray(value.trace) || !Array.isArray(value.evidenceIds) || active.has(value)) return false;
    active.add(value);
    try {
      let cursor = 0;
      for (const part of value.trace) {
        if ((part.kind !== "literal" && part.kind !== "slot") || !Number.isSafeInteger(part.outputStart) || !Number.isSafeInteger(part.outputEnd)
          || part.outputStart !== cursor || part.outputEnd < cursor || part.surface !== value.text.slice(cursor, part.outputEnd)
          || part.surface.length !== part.outputEnd - cursor || !Array.isArray(part.evidenceIds) || !Array.isArray(part.sourceExampleIds)) return false;
        cursor = part.outputEnd;
      }
      if (cursor !== value.text.length) return false;
      return (value.childBindings ?? []).every(binding => typeof binding.roleId === "string" && Number.isSafeInteger(binding.outputStart)
        && Number.isSafeInteger(binding.outputEnd) && binding.outputStart >= 0 && binding.outputEnd >= binding.outputStart
        && binding.outputEnd <= value.text.length && binding.surface.text === value.text.slice(binding.outputStart, binding.outputEnd) && valid(binding.surface));
    } finally { active.delete(value); }
  };
  return valid(surface);
}

function snapshot(surface: ConstructionSurface): ConstructionSurface {
  return { text: surface.text, evidenceIds: [...surface.evidenceIds], trace: surface.trace.map(part => ({ ...part,
    evidenceIds: [...part.evidenceIds], sourceExampleIds: [...part.sourceExampleIds] })),
    ...(surface.childBindings ? { childBindings: surface.childBindings.map(binding => ({ ...binding, surface: snapshot(binding.surface) })) } : {}) };
}

/** Concatenates an already licensed ordered literal/slot program exactly, without predicting boundary text. */
export function composeConstructionSurface(pieces: readonly ConstructionSurfacePiece[]): ConstructionSurface | undefined {
  let text = "";
  const trace: LearnedRealizationTracePart[] = [], childBindings: ConstructionSurfaceChildBinding[] = [], evidenceIds = new Set<string>();
  for (const piece of pieces) {
    const start = text.length;
    if (piece.kind === "literal") {
      text += piece.surface;
      trace.push({ kind: "literal", outputStart: start, outputEnd: text.length, surface: piece.surface,
        evidenceIds: [...piece.evidenceIds], sourceExampleIds: [...piece.sourceExampleIds] });
      piece.evidenceIds.forEach(id => evidenceIds.add(id));
    } else {
      if (!constructionSurfaceComplete(piece.surface)) return undefined;
      const child = snapshot(piece.surface); text += child.text;
      trace.push(...child.trace.map(part => ({ ...part, outputStart: start + part.outputStart, outputEnd: start + part.outputEnd })));
      childBindings.push({ roleId: piece.roleId, ...(piece.occurrenceId ? { occurrenceId: piece.occurrenceId } : {}),
        ...(piece.constructionId ? { constructionId: piece.constructionId } : {}), outputStart: start, outputEnd: text.length, surface: child });
      child.evidenceIds.forEach(id => evidenceIds.add(id));
    }
  }
  const result = { text, trace, evidenceIds: [...evidenceIds], ...(childBindings.length ? { childBindings } : {}) };
  return constructionSurfaceComplete(result) ? result : undefined;
}
