import { clamp01, toJsonValue } from "./primitives.js";
import type {
  GraphEdge,
  GraphTemporalScope,
  JsonValue
} from "./types.js";
import type { CanonicalTemporalCoordinates } from "./canonical-temporal.js";
import { conflictingTimelineFacts, recordTimelineFact, type TimelineFact } from "./temporal-interval-algebra.js";

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

/**
 * Plan items 169-170 wiring. graph-temporal.ts's own evaluateGraphTemporalScope
 * (above) only ever compares one interval against a single query time -- it
 * has no multi-fact timeline or two-interval comparison at all. The real
 * per-turn source of conflicting-subject timeline facts this needed:
 * multiple graph edges that already share the same (source, target,
 * relationId) -- the same "peer" grouping relation-potential.ts's own
 * temporal-fit projection already computes -- each with its own real,
 * bounded (validFrom and validTo both known) temporal scope. Converts each
 * such edge into a real temporal-interval-algebra.ts TimelineFact and
 * reports genuine Allen-algebra conflicts (overlapping, non-adjacent real-
 * world periods) among them -- e.g. two edges both claiming the same
 * relation held during genuinely overlapping date ranges. Edges with an
 * open-ended (validTo undefined) or degenerate (validTo <= validFrom)
 * scope are skipped rather than assigned a fabricated closed interval;
 * Allen's algebra is only defined for genuine positive-length intervals.
 */
export function conflictingGraphEdgeIntervals(
  edges: readonly GraphEdge[]
): Array<[GraphEdge, GraphEdge]> {
  const groups = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    const scope = edge.temporalScope;
    if (!isKnownGraphTemporalScope(scope) || scope.status !== "known") continue;
    if (scope.validTo === undefined || scope.validTo <= scope.validFrom) continue;
    const key = `${String(edge.source)}${String(edge.target)}${String(edge.relationId)}`;
    const bucket = groups.get(key) ?? [];
    bucket.push(edge);
    groups.set(key, bucket);
  }
  const conflicts: Array<[GraphEdge, GraphEdge]> = [];
  for (const bucket of groups.values()) {
    if (bucket.length < 2) continue;
    let facts: TimelineFact<GraphEdge>[] = [];
    for (const edge of bucket) {
      const scope = edge.temporalScope as Extract<GraphTemporalScope, { status: "known" }>;
      facts = recordTimelineFact(facts, {
        id: String(edge.id),
        subjectId: `${String(edge.source)}${String(edge.target)}${String(edge.relationId)}`,
        interval: { start: scope.validFrom, end: scope.validTo! },
        value: edge,
        recordedAt: edge.updatedAt
      });
    }
    for (const [left, right] of conflictingTimelineFacts(facts)) conflicts.push([left.value, right.value]);
  }
  return conflicts.sort((left, right) => String(left[0].id).localeCompare(String(right[0].id)) || String(left[1].id).localeCompare(String(right[1].id)));
}

function jsonRecord(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}
