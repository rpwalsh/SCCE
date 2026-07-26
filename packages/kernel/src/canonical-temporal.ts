import { toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

export const CANONICAL_TEMPORAL_SCHEMA = "scce.temporal_coordinates.v1" as const;

export interface CanonicalTemporalCoordinates {
  schema: typeof CANONICAL_TEMPORAL_SCHEMA;
  sourceTime: number | null;
  observedTime: number;
  eventTime: number | null;
  validFrom: number | null;
  validTo: number | null;
  eventSurfaceMention: JsonValue | null;
  provenance: JsonValue;
}

export function canonicalTemporalCoordinates(input: {
  observedTime: number;
  sourceTime?: number | null;
  eventTime?: number | null;
  validFrom?: number | null;
  validTo?: number | null;
  eventSurfaceMention?: JsonValue | null;
  provenance?: JsonValue;
}): CanonicalTemporalCoordinates {
  const temporal: CanonicalTemporalCoordinates = {
    schema: CANONICAL_TEMPORAL_SCHEMA,
    sourceTime: finiteOrNull(input.sourceTime),
    observedTime: finiteRequired(input.observedTime, "observedTime"),
    eventTime: finiteOrNull(input.eventTime),
    validFrom: finiteOrNull(input.validFrom),
    validTo: finiteOrNull(input.validTo),
    eventSurfaceMention: input.eventSurfaceMention ?? null,
    provenance: toJsonValue(input.provenance ?? {})
  };
  if (temporal.validFrom !== null
    && temporal.validTo !== null
    && temporal.validTo < temporal.validFrom) {
    throw new Error("validTo must not precede validFrom");
  }
  return temporal;
}

export function assertCanonicalTemporalCoordinates(
  value: CanonicalTemporalCoordinates
): void {
  if (value.schema !== CANONICAL_TEMPORAL_SCHEMA) {
    throw new Error("unsupported temporal coordinate schema");
  }
  finiteRequired(value.observedTime, "observedTime");
  for (const [name, coordinate] of [
    ["sourceTime", value.sourceTime],
    ["eventTime", value.eventTime],
    ["validFrom", value.validFrom],
    ["validTo", value.validTo]
  ] as const) {
    if (coordinate !== null) finiteRequired(coordinate, name);
  }
  if (value.validFrom !== null && value.validTo !== null && value.validTo < value.validFrom) {
    throw new Error("validTo must not precede validFrom");
  }
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value === undefined || value === null ? null : finiteRequired(value, "temporal coordinate");
}

function finiteRequired(value: number, name: string): number {
  if (!Number.isFinite(value)) throw new Error(`${name} must be finite`);
  return value;
}
