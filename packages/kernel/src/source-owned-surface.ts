// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * A surface whose complete text is owned by one learned/source artifact.
 * `text` is returned byte-for-byte; callers must not normalize it before
 * presenting it as an exact source span.
 */
export interface SourceOwnedSurface {
  id: string;
  lane: "learned_construction" | "reversible_construction" | "language_unit" | "evidence_span";
  text: string;
  evidenceIds?: readonly string[];
  sourceVersionId?: string | null;
}

export interface SourceOwnedSurfaceTraceStep {
  sourceId: string;
  lane: SourceOwnedSurface["lane"] | "single_unit";
  unitCount: number;
}

export interface SourceOwnedSurfaceRealization {
  text: string;
  trace: SourceOwnedSurfaceTraceStep[];
  unresolvedBoundaries: number;
  status: "resolved" | "preserved_source_span" | "unresolved";
  owner?: {
    sourceId: string;
    lane: SourceOwnedSurface["lane"];
    evidenceIds: readonly string[];
    sourceVersionId: string | null;
  };
  requiredAction?: "try_alternate_derivation" | "request_additional_evidence";
}

/**
 * Realize one of the supplied derivations without inventing a universal
 * separator. A single unit is already a complete candidate surface. A
 * multi-unit derivation is speakable only when one learned construction or
 * source span contains every unit, exactly and in order; in that case the
 * owner's complete, unmodified surface is returned.
 */
export function realizeSourceOwnedSurface(input: {
  derivations: readonly (readonly string[])[];
  sources?: readonly SourceOwnedSurface[];
}): SourceOwnedSurfaceRealization {
  const derivations = input.derivations
    .map(derivation => derivation.filter(unit => unit.length > 0))
    .filter(derivation => derivation.length > 0);
  const single = derivations.find(derivation => derivation.length === 1);
  if (single) {
    return {
      text: single[0]!,
      trace: [{ sourceId: "surface.single_unit", lane: "single_unit", unitCount: 1 }],
      unresolvedBoundaries: 0,
      status: "resolved"
    };
  }

  const matches = (input.sources ?? [])
    .flatMap(source => derivations
      .filter(derivation => derivation.length > 1 && containsUnitsExactlyInOrder(source.text, derivation))
      .map(derivation => ({ source, unitCount: derivation.length })))
    .sort((left, right) =>
      left.source.text.length - right.source.text.length
      || left.source.id.localeCompare(right.source.id));
  const selected = matches[0];
  if (selected) {
    return {
      text: selected.source.text,
      trace: [{ sourceId: selected.source.id, lane: selected.source.lane, unitCount: selected.unitCount }],
      unresolvedBoundaries: 0,
      status: "preserved_source_span",
      owner: {
        sourceId: selected.source.id,
        lane: selected.source.lane,
        evidenceIds: [...(selected.source.evidenceIds ?? [])],
        sourceVersionId: selected.source.sourceVersionId ?? null
      }
    };
  }

  const unresolvedBoundaries = derivations.length
    ? Math.max(0, Math.min(...derivations.map(derivation => derivation.length - 1)))
    : 0;
  return {
    text: "",
    trace: [],
    unresolvedBoundaries,
    status: "unresolved",
    requiredAction: "try_alternate_derivation"
  };
}

function containsUnitsExactlyInOrder(surface: string, units: readonly string[]): boolean {
  let cursor = 0;
  for (const unit of units) {
    const start = surface.indexOf(unit, cursor);
    if (start < 0) return false;
    cursor = start + unit.length;
  }
  return true;
}
