// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { JOIN_PROGRAM_MIXTURE_SCHEMA, JOIN_PROGRAM_SCHEMA, JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA, JOIN_PROGRAM_MIXTURE_STORAGE_V1_SCHEMA,
  canonicalJsonByteLength, isJoinProgramMixture, joinProgramMixtureFromStorage, joinProgramMixtureStorageForm } from "@scce/kernel";

export const DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA = "scce.durable_join_program.storage.v1";
export const DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA = "scce.durable_join_program.byte_ledger.v1";
export const DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY = "_scceJoinProgramStorage";
const INDEXES = ["conditionedIndex", "exactIndex", "structuralIndex", "classIndex", "localShapeIndex", "constructionIndex"] as const;
const CHOICE_FIELDS = new Set(["surface", "count", "probability", "evidenceIds", "evidenceCoordinates"]);
const COORDINATE_FIELDS = new Set(["evidenceId", "sourceVersionId", "documentId", "byteStart", "byteEnd", "utf16Start", "utf16End", "exactSurfaceHash"]);

/** The marker preserves whether the logical caller supplied a raw or intentionally packed mixture. */
export function encodeDurableJoinPrograms(value: unknown): unknown { return transform(value, true); }

export function decodeDurableJoinPrograms<T>(value: unknown): T { return transform(value, false) as T; }

function transform(value: unknown, encoding: boolean): unknown {
  const rootRecord = record(value);
  if (encoding && (Array.isArray(value) || rootRecord && Object.hasOwn(rootRecord, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY))) return value;
  const seen = new WeakMap<object, unknown>();
  const sizes = new WeakMap<object, JsonByteLengths>();
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
      const mixture = Object.keys(row).length === 4 && validSizes(row) && record(row.mixture)?.schema === JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA
        ? joinProgramMixtureFromStorage(row.mixture) : undefined;
      if (!mixture) throw new Error("invalid durable JOIN storage marker");
      seen.set(value, mixture);
      return mixture;
    }
    if (row?.schema === JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA || row?.schema === JOIN_PROGRAM_MIXTURE_STORAGE_V1_SCHEMA) return value;
    if (!encoding && row?.schema === JOIN_PROGRAM_MIXTURE_SCHEMA) return value;
    if (encoding && row?.schema === JOIN_PROGRAM_MIXTURE_SCHEMA && packable(row)) {
      const stored = { schema: DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA, mixture: joinProgramMixtureStorageForm(row), ...jsonByteLengths(row, sizes) };
      seen.set(value, stored);
      return stored;
    }
    const ledger = row?.[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY];
    if (encoding && row && Object.hasOwn(row, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)) return value;
    let changed = false;
    const entries = Object.entries(value).map(([key, child]) => {
      const next = visit(child);
      if (next !== child) changed = true;
      return [key, next] as const;
    });
    const result = changed ? Object.fromEntries(!encoding && validLedger(ledger)
      ? entries.filter(([key]) => key !== DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY) : entries) : value;
    seen.set(value, result);
    return result;
  };
  const result = visit(value);
  const resultRecord = record(result);
  if (!encoding || result === value || !resultRecord || resultRecord.schema === DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA) return result;
  const original = record(value)!;
  const ledger = { schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...jsonByteLengths(value, sizes),
    ...(Object.hasOwn(original, "joinProgram") ? { joinProgramMemberJsonbBytes: jsonByteLengths(original.joinProgram, sizes).decodedJsonbBytes
      + canonicalJsonByteLength("joinProgram") + 2 + (Object.keys(original).length > 1 ? 2 : 0) } : {}) };
  return { ...resultRecord, [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: ledger };
}

interface JsonByteLengths { decodedJsonBytes: number; decodedJsonbBytes: number }

/** PostgreSQL adds separator spaces and expands exponent numbers when it renders JSONB text. */
export function durableJoinProgramJsonByteLengths(value: unknown): JsonByteLengths { return jsonByteLengths(value, new WeakMap()); }

function jsonByteLengths(value: unknown, cache: WeakMap<object, JsonByteLengths>): JsonByteLengths {
  if (value instanceof Date) return jsonByteLengths(value.toISOString(), cache);
  if (value && typeof value === "object") {
    const found = cache.get(value);
    if (found) return found;
    const children = Array.isArray(value) ? Array.from(value, child => jsonByteLengths(child, cache))
      : Object.entries(value).map(([key, child]) => {
        const bytes = jsonByteLengths(child, cache), keyBytes = canonicalJsonByteLength(key);
        return { decodedJsonBytes: keyBytes + 1 + bytes.decodedJsonBytes, decodedJsonbBytes: keyBytes + 2 + bytes.decodedJsonbBytes };
      });
    const result = children.reduce((total, child) => ({ decodedJsonBytes: total.decodedJsonBytes + child.decodedJsonBytes,
      decodedJsonbBytes: total.decodedJsonbBytes + child.decodedJsonbBytes }), { decodedJsonBytes: 2 + Math.max(0, children.length - 1), decodedJsonbBytes: 2 + Math.max(0, children.length - 1) * 2 });
    cache.set(value, result);
    return result;
  }
  const decodedJsonBytes = canonicalJsonByteLength(value);
  if (typeof value !== "number" || !Number.isFinite(value) || !String(value).includes("e")) return { decodedJsonBytes, decodedJsonbBytes: decodedJsonBytes };
  const [mantissa, exponent] = String(value).split("e");
  const unsigned = mantissa!.replace(/^-/, ""), digits = unsigned.replace(".", "");
  const decimalPosition = (unsigned.includes(".") ? unsigned.indexOf(".") : unsigned.length) + Number(exponent);
  const expanded = decimalPosition <= 0 ? 2 - decimalPosition + digits.length : decimalPosition >= digits.length ? decimalPosition : digits.length + 1;
  return { decodedJsonBytes, decodedJsonbBytes: Math.max(decodedJsonBytes, expanded + Number(value < 0)) };
}

function validSizes(value: Record<string, unknown>): boolean {
  return Number.isSafeInteger(value.decodedJsonBytes) && Number(value.decodedJsonBytes) >= 0
    && Number.isSafeInteger(value.decodedJsonbBytes) && Number(value.decodedJsonbBytes) >= Number(value.decodedJsonBytes);
}

function validLedger(value: unknown): boolean {
  const row = record(value);
  return row !== undefined && row.schema === DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA && validSizes(row)
    && Object.keys(row).every(key => ["schema", "decodedJsonBytes", "decodedJsonbBytes", "joinProgramMemberJsonbBytes"].includes(key))
    && (!Object.hasOwn(row, "joinProgramMemberJsonbBytes") || Number.isSafeInteger(row.joinProgramMemberJsonbBytes) && Number(row.joinProgramMemberJsonbBytes) >= 0);
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
