import { clamp01, toJsonValue } from "./primitives.js";
import type {
  GraphTemporalScope,
  JsonValue
} from "./types.js";
import type { CanonicalTemporalCoordinates } from "./canonical-temporal.js";

export interface GraphTemporalEvaluation {
  status: "valid" | "invalid" | "uncertain" | "atemporal";
  fit: number;
}

export function knownGraphTemporalScope(
  validFrom: number,
  validTo?: number,
  provenance?: JsonValue
): GraphTemporalScope {
  if (!Number.isFinite(validFrom)) throw new Error("known temporal scope requires finite validFrom");
  if (validTo !== undefined && (!Number.isFinite(validTo) || validTo < validFrom)) {
    throw new Error("known temporal scope validTo must be finite and not precede validFrom");
  }
  return {
    status: "known",
    validFrom,
    ...(validTo === undefined ? {} : { validTo }),
    ...(provenance === undefined ? {} : { provenance: toJsonValue(provenance) })
  };
}

export function unknownGraphTemporalScope(
  uncertainty = 1,
  provenance?: JsonValue
): GraphTemporalScope {
  return {
    status: "unknown",
    uncertainty: clamp01(uncertainty),
    ...(provenance === undefined ? {} : { provenance: toJsonValue(provenance) })
  };
}

export function atemporalGraphTemporalScope(provenance?: JsonValue): GraphTemporalScope {
  return {
    status: "atemporal",
    ...(provenance === undefined ? {} : { provenance: toJsonValue(provenance) })
  };
}

export function graphTemporalScopeFromCanonical(
  coordinates: CanonicalTemporalCoordinates
): GraphTemporalScope {
  if (coordinates.validFrom !== null) {
    return knownGraphTemporalScope(
      coordinates.validFrom,
      coordinates.validTo ?? undefined,
      coordinates.provenance
    );
  }
  const provenance = jsonRecord(coordinates.provenance);
  if (provenance.temporalStatus === "atemporal") {
    return atemporalGraphTemporalScope(coordinates.provenance);
  }
  return unknownGraphTemporalScope(1, coordinates.provenance);
}

export function evaluateGraphTemporalScope(
  scope: GraphTemporalScope,
  queryTime: number
): GraphTemporalEvaluation {
  if (scope.status === "atemporal") return { status: "atemporal", fit: 1 };
  if (scope.status === "unknown") {
    return { status: "uncertain", fit: clamp01(1 - scope.uncertainty) };
  }
  const validFrom = scope.validFrom;
  const validTo = scope.validTo;
  const valid = validFrom <= queryTime && (validTo === undefined || queryTime <= validTo);
  return { status: valid ? "valid" : "invalid", fit: valid ? 1 : 0 };
}

export function isKnownGraphTemporalScope(
  scope: GraphTemporalScope
): scope is Extract<GraphTemporalScope, { status: "known" }> | Extract<GraphTemporalScope, { status?: undefined }> {
  return scope.status === "known" || scope.status === undefined;
}

export function assertProductionGraphTemporalScope(scope: GraphTemporalScope): void {
  if (scope.status === undefined) {
    throw new Error("legacy graph temporal scope is forbidden in compiled production snapshots");
  }
  if (scope.status === "known") knownGraphTemporalScope(scope.validFrom, scope.validTo);
  if (scope.status === "unknown" && (!Number.isFinite(scope.uncertainty)
    || scope.uncertainty < 0
    || scope.uncertainty > 1)) {
    throw new Error("unknown graph temporal uncertainty must be in [0,1]");
  }
}

function jsonRecord(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}
