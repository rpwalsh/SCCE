import { canonicalStringify, createHasher, toJsonValue } from "./primitives.js";
import { opaqueRoleId, type OpaqueRoleModel } from "./opaque-role-induction.js";
import type { RelationPromotionModel } from "./relation-promotion.js";
import type { StructuredSemanticCandidate } from "./structured-semantic-candidate.js";
import type { Hasher, JsonValue } from "./types.js";

export const ROLE_SURFACE_ORDER_MODEL_SCHEMA = "scce.role_surface_order_model.v1" as const;

export interface SemanticRoleDistribution {
  relationSeedId: string;
  graphContextId: string;
  probabilities: Array<{ roleId: string; probability: number }>;
  independentSourceCount: number;
}

export interface SurfacePositionDistribution {
  relationSeedId: string;
  roleId: string;
  discourseContextId: string;
  probabilities: Array<{
    state: string;
    probability: number;
  }>;
  repeatProbability: number;
  independentSourceCount: number;
}

export interface RoleSurfaceOrderModel {
  schema: typeof ROLE_SURFACE_ORDER_MODEL_SCHEMA;
  id: string;
  promotionModelId: string;
  opaqueRoleModelId: string;
  semanticRoles: SemanticRoleDistribution[];
  surfacePositions: SurfacePositionDistribution[];
  audit: JsonValue;
}

interface Occurrence {
  relationSeedId: string;
  roleId: string;
  sourceId: string;
  graphContextId: string;
  discourseContextId: string;
  positionState: string;
  repeated: boolean;
}

const ALPHA = 0.5;
const POSITION_BUCKETS = 8;

export function compileRoleSurfaceOrderModel(input: {
  candidates: readonly StructuredSemanticCandidate[];
  promotionModel: RelationPromotionModel;
  opaqueRoleModel: OpaqueRoleModel;
  hasher?: Hasher;
}): RoleSurfaceOrderModel {
  const hasher = input.hasher ?? createHasher();
  const promoted = new Set(input.promotionModel.decisions
    .filter(decision => decision.promoted)
    .map(decision => decision.relationSeedId));
  const occurrences: Occurrence[] = [];
  for (const candidate of input.candidates.filter(row => promoted.has(row.relationSeedId))) {
    const graphContextId = contextId(hasher, "graph", {
      relationSeedId: candidate.relationSeedId,
      arity: candidate.participants.length,
      neighborKinds: candidate.participants.map(port => port.valueKind).sort()
    });
    const discourseContextId = contextId(hasher, "discourse", {
      candidateKind: candidate.kind,
      qualifierKeys: jsonKeys(candidate.qualifiers),
      realizationPattern: candidate.participants.map(port => port.realization).sort()
    });
    const observedCount = candidate.participants.filter(port => port.realization === "observed").length;
    const roleCounts = new Map<string, number>();
    for (let index = 0; index < candidate.participants.length; index += 1) {
      const port = candidate.participants[index]!;
      const roleId = opaqueRoleId(input.opaqueRoleModel, candidate.id, port.portId);
      if (!roleId) continue;
      const priorCount = roleCounts.get(roleId) ?? 0;
      roleCounts.set(roleId, priorCount + 1);
      occurrences.push({
        relationSeedId: candidate.relationSeedId,
        roleId,
        sourceId: String(candidate.sourceId),
        graphContextId,
        discourseContextId,
        positionState: port.realization === "omitted"
          ? "unrealized"
          : positionBucket(index, observedCount),
        repeated: priorCount > 0
      });
    }
  }
  const roleIds = [...new Set(occurrences.map(row => row.roleId))].sort();
  const semanticRoles = grouped(occurrences, row =>
    `${row.relationSeedId}\u001f${row.graphContextId}`)
    .map(rows => ({
      relationSeedId: rows[0]!.relationSeedId,
      graphContextId: rows[0]!.graphContextId,
      probabilities: categoricalRoles(rows.map(row => row.roleId), roleIds),
      independentSourceCount: new Set(rows.map(row => row.sourceId)).size
    }))
    .sort((left, right) =>
      left.relationSeedId.localeCompare(right.relationSeedId)
      || left.graphContextId.localeCompare(right.graphContextId));
  const surfacePositions = grouped(occurrences, row =>
    `${row.relationSeedId}\u001f${row.roleId}\u001f${row.discourseContextId}`)
    .map(rows => {
      const repeatCount = rows.filter(row => row.repeated).length;
      return {
        relationSeedId: rows[0]!.relationSeedId,
        roleId: rows[0]!.roleId,
        discourseContextId: rows[0]!.discourseContextId,
        probabilities: categoricalStates(
          rows.map(row => row.positionState),
          ["unrealized", ...Array.from({ length: POSITION_BUCKETS }, (_, index) => `bucket.${index}`)]
        ),
        repeatProbability: quantize((repeatCount + ALPHA) / (rows.length + 2 * ALPHA)),
        independentSourceCount: new Set(rows.map(row => row.sourceId)).size
      };
    })
    .sort((left, right) =>
      left.relationSeedId.localeCompare(right.relationSeedId)
      || left.roleId.localeCompare(right.roleId)
      || left.discourseContextId.localeCompare(right.discourseContextId));
  const canonical = {
    schema: ROLE_SURFACE_ORDER_MODEL_SCHEMA,
    promotionModelId: input.promotionModel.id,
    opaqueRoleModelId: input.opaqueRoleModel.id,
    semanticRoles,
    surfacePositions
  };
  return {
    ...canonical,
    id: `role_surface_order.${hasher.digestHex(canonicalStringify(canonical)).slice(0, 40)}`,
    audit: toJsonValue({
      learner: "kernel.role_surface_order.separated_empirical_fields.v1",
      semanticRoleConditioning: ["relation", "graph_context"],
      surfacePositionConditioning: ["role", "relation", "discourse_context"],
      semanticIdentityUsesPosition: false,
      unrealizedStateExplicit: true,
      repeatedStateExplicit: true,
      occurrenceCount: occurrences.length
    })
  };
}

function positionBucket(index: number, observedCount: number): string {
  if (observedCount <= 1) return "bucket.0";
  return `bucket.${Math.min(POSITION_BUCKETS - 1, Math.floor(index * POSITION_BUCKETS / observedCount))}`;
}

function categoricalRoles(values: readonly string[], alphabet: readonly string[]): Array<{ roleId: string; probability: number }> {
  const total = values.length + ALPHA * Math.max(1, alphabet.length);
  return alphabet.map(roleId => ({
    roleId,
    probability: quantize((values.filter(item => item === roleId).length + ALPHA) / total)
  }));
}

function categoricalStates(values: readonly string[], alphabet: readonly string[]): Array<{ state: string; probability: number }> {
  const total = values.length + ALPHA * Math.max(1, alphabet.length);
  return alphabet.map(state => ({
    state,
    probability: quantize((values.filter(item => item === state).length + ALPHA) / total)
  }));
}

function grouped<T>(values: readonly T[], key: (value: T) => string): T[][] {
  const groups = new Map<string, T[]>();
  for (const value of values) groups.set(key(value), [...(groups.get(key(value)) ?? []), value]);
  return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, rows]) => rows);
}

function contextId(hasher: Hasher, kind: string, value: unknown): string {
  return `context.${hasher.digestHex(`${kind}\u001f${canonicalStringify(value)}`).slice(0, 24)}`;
}

function jsonKeys(value: JsonValue, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.keys(value).sort().flatMap(key => {
    const path = prefix ? `${prefix}.${key}` : key;
    return [path, ...jsonKeys(value[key]!, path)];
  });
}

function quantize(value: number): number {
  return Math.round(value * 1_000_000_000_000) / 1_000_000_000_000;
}
