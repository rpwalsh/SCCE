// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { JOIN_PROGRAM_MIXTURE_SCHEMA, JOIN_PROGRAM_SCHEMA, JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA, JOIN_PROGRAM_MIXTURE_STORAGE_V1_SCHEMA,
  isJoinProgramMixture, joinProgramMixtureFromStorage, joinProgramMixtureStorageForm } from "@scce/kernel";

export const DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA = "scce.durable_join_program.storage.v1";
const INDEXES = ["conditionedIndex", "exactIndex", "structuralIndex", "classIndex", "localShapeIndex", "constructionIndex"] as const;
const CHOICE_FIELDS = new Set(["surface", "count", "probability", "evidenceIds", "evidenceCoordinates"]);
const COORDINATE_FIELDS = new Set(["evidenceId", "sourceVersionId", "documentId", "byteStart", "byteEnd", "utf16Start", "utf16End", "exactSurfaceHash"]);

/** The marker preserves whether the logical caller supplied a raw or intentionally packed mixture. */
export function encodeDurableJoinPrograms(value: unknown): unknown { return transform(value, true); }

export function decodeDurableJoinPrograms<T>(value: unknown): T { return transform(value, false) as T; }

function transform(value: unknown, encoding: boolean): unknown {
  const seen = new WeakMap<object, unknown>();
  const visit = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map(child => {
        const result = visit(child);
        if (result !== child) changed = true;
        return result;
      });
      const result = changed ? next : value;
      seen.set(value, result);
      return result;
    }
    const row = record(value);
    if (row?.schema === DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA) {
      if (encoding) return value;
      const mixture = Object.keys(row).length === 2 && record(row.mixture)?.schema === JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA
        ? joinProgramMixtureFromStorage(row.mixture) : undefined;
      if (!mixture) throw new Error("invalid durable JOIN storage marker");
      seen.set(value, mixture);
      return mixture;
    }
    if (row?.schema === JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA || row?.schema === JOIN_PROGRAM_MIXTURE_STORAGE_V1_SCHEMA) return value;
    if (!encoding && row?.schema === JOIN_PROGRAM_MIXTURE_SCHEMA) return value;
    if (encoding && row?.schema === JOIN_PROGRAM_MIXTURE_SCHEMA && packable(row)) {
      const stored = { schema: DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA, mixture: joinProgramMixtureStorageForm(row) };
      seen.set(value, stored);
      return stored;
    }
    let changed = false;
    const entries = Object.entries(value).map(([key, child]) => {
      const next = visit(child);
      if (next !== child) changed = true;
      return [key, next] as const;
    });
    const result = changed ? Object.fromEntries(entries) : value;
    seen.set(value, result);
    return result;
  };
  return visit(value);
}

function packable(value: Record<string, unknown>): value is Record<string, unknown> & import("@scce/kernel").JoinProgramMixture {
  if (!isJoinProgramMixture(value) || !finite(value.minimumConfidence)) return false;
  return value.components.every(component => {
    if (!finite(component.weight)) return false;
    const program = record(component.program);
    if (!program || program.schema !== JOIN_PROGRAM_SCHEMA) return false;
    return INDEXES.every(name => {
      const index = record(program[name]);
      return index !== undefined && Object.values(index).every(choices => Array.isArray(choices) && choices.every(choice => {
        const row = record(choice);
        if (!row || Object.keys(row).some(key => !CHOICE_FIELDS.has(key)) || typeof row.surface !== "string" || !finite(row.count) || !finite(row.probability)
          || !Array.isArray(row.evidenceIds) || !row.evidenceIds.every(id => typeof id === "string") || !Array.isArray(row.evidenceCoordinates)) return false;
        return row.evidenceCoordinates.every(coordinate => {
          const point = record(coordinate);
          return point !== undefined && Object.keys(point).every(key => COORDINATE_FIELDS.has(key))
            && typeof point.evidenceId === "string" && typeof point.documentId === "string" && typeof point.exactSurfaceHash === "string"
            && (!Object.hasOwn(point, "sourceVersionId") || typeof point.sourceVersionId === "string")
            && [point.byteStart, point.byteEnd, point.utf16Start, point.utf16End].every(finite);
        });
      }));
    });
  });
}

function record(value: unknown): Record<string, unknown> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined; }
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
