// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import {
  CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA,
  CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA,
  CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA,
  RELATION_STATISTICS_STORAGE_SCHEMA,
  creativeSourceObservationStorageForm,
  creativeSourceObservationsFromStorage,
  decodeRelationStatistics,
  encodeRelationStatistics,
  type JsonValue
} from "@scce/kernel";
import {
  DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA,
  decodeDurableCreativeEvents,
  encodeDurableCreativeEvents
} from "./durable-creative-event-storage.js";
import {
  SEMANTIC_FRAME_STORAGE_SCHEMA,
  SEMANTIC_MEMORY_SCHEMA,
  decodeSemanticFrames,
  encodeSemanticFrames
} from "./semantic-frame-storage.js";
import {
  SEMANTIC_PROJECTION_STORAGE_KEY,
  decodeSemanticProjection,
  encodeSemanticProjection
} from "./semantic-projection-storage.js";
import {
  DECODED_JSON_BYTE_LEDGER_KEY,
  decodedJsonByteLedger,
  decodedJsonByteLengths,
  isDecodedJsonByteLedger,
  verifyDecodedJsonByteLedger
} from "./decoded-json-byte-ledger.js";
import { decodeSegmentationData, encodeSegmentationData } from "./segmentation-data-storage.js";

export {
  DECODED_JSON_BYTE_LEDGER_KEY,
  DECODED_JSON_BYTE_LEDGER_SCHEMA,
  decodedJsonByteLengths
} from "./decoded-json-byte-ledger.js";

/** Physical storage codecs for learned artifacts that do not carry runtime or JOIN semantics. */
export function encodeDurableArtifact(value: unknown): unknown {
  const root = record(value);
  if (Array.isArray(value) || root && Object.hasOwn(root, DECODED_JSON_BYTE_LEDGER_KEY)) return value;
  const transformed = transformArtifact(value, true);
  const stored = encodeSegmentationData(transformed);
  const storedRoot = record(stored);
  if (stored === value || !storedRoot || Object.hasOwn(storedRoot, DECODED_JSON_BYTE_LEDGER_KEY)) return stored;
  return { ...storedRoot, [DECODED_JSON_BYTE_LEDGER_KEY]: decodedJsonByteLedger(value) };
}

/** Restore the exact public artifact; no fitting, acquisition, or model selection occurs here. */
export function decodeDurableArtifact<T>(value: unknown): T {
  return transformArtifact(decodeSegmentationData(value), false) as T;
}

export function verifyDurableArtifactByteLedger(wire: unknown, logical: unknown): void {
  verifyDecodedJsonByteLedger(wire, logical);
}

function transformArtifact(value: unknown, encoding: boolean): unknown {
  const rootRecord = record(value);
  if (encoding && (Array.isArray(value) || rootRecord && Object.hasOwn(rootRecord, DECODED_JSON_BYTE_LEDGER_KEY))) return value;
  const seen = new WeakMap<object, unknown>();
  let packedCreativeEvents = false;
  const visit = (input: unknown): unknown => {
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return seen.get(input);
    if (Array.isArray(input)) {
      let changed = false;
      const next = input.map(child => {
        const result = visit(child);
        changed ||= result !== child;
        return result;
      });
      const result = changed ? next : input;
      seen.set(input, result);
      return result;
    }
    const row = record(input)!;
    if (encoding && Object.hasOwn(row, "semanticInductionProjection")
      && !Object.hasOwn(row, SEMANTIC_PROJECTION_STORAGE_KEY)) {
      const result = visit(encodeSemanticProjection(row));
      seen.set(input, result);
      return result;
    }
    if (!encoding && Object.hasOwn(row, SEMANTIC_PROJECTION_STORAGE_KEY)) {
      const result = visit(decodeSemanticProjection(row));
      seen.set(input, result);
      return result;
    }
    if (row.schema === CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA) {
      if (encoding) return input;
      const observations = creativeSourceObservationsFromStorage(row);
      seen.set(input, observations);
      return observations;
    }
    if (row.schema === RELATION_STATISTICS_STORAGE_SCHEMA) {
      if (encoding) return input;
      const statistics = decodeRelationStatistics(row);
      seen.set(input, statistics);
      return statistics;
    }
    if (row.schema === SEMANTIC_FRAME_STORAGE_SCHEMA) {
      if (encoding) return input;
      const frames = decodeSemanticFrames(row);
      seen.set(input, frames);
      return frames;
    }
    if (row.schema === DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA) {
      if (encoding) return input;
      const events = decodeDurableCreativeEvents(row);
      seen.set(input, events);
      return events;
    }
    if (encoding && Object.hasOwn(row, DECODED_JSON_BYTE_LEDGER_KEY)) return input;
    let changed = false;
    const entries = Object.entries(input).map(([key, child]) => {
      let next: unknown;
      if (encoding && row.schema === CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA
        && key === "sourceObservations" && Array.isArray(child)) {
        next = creativeSourceObservationStorageForm(child as Parameters<typeof creativeSourceObservationStorageForm>[0]);
      } else if (encoding && row.schema === SEMANTIC_MEMORY_SCHEMA && key === "relationHypothesisModel") {
        next = record(child)?.schema === RELATION_STATISTICS_STORAGE_SCHEMA
          ? child
          : encodeRelationStatistics(child as JsonValue);
      } else if (encoding && row.schema === SEMANTIC_MEMORY_SCHEMA && key === "semanticFrames" && Array.isArray(child)) {
        next = encodeSemanticFrames(child) ?? visit(child);
      } else if (encoding && row.schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA
        && key === "events" && Array.isArray(child)) {
        const packed = encodeDurableCreativeEvents(child);
        if (packed) {
          packedCreativeEvents = true;
          next = packed;
        } else {
          next = visit(child);
        }
      } else {
        next = visit(child);
      }
      changed ||= next !== child;
      return [key, next] as const;
    });
    const ledger = row[DECODED_JSON_BYTE_LEDGER_KEY];
    const removeLedger = !encoding && isDecodedJsonByteLedger(ledger);
    const result = changed || removeLedger
      ? Object.fromEntries(removeLedger ? entries.filter(([key]) => key !== DECODED_JSON_BYTE_LEDGER_KEY) : entries)
      : input;
    seen.set(input, result);
    return result;
  };
  const result = visit(value);
  if (!encoding || result === value || !record(result)) return result;
  const stored = { ...record(result)!, [DECODED_JSON_BYTE_LEDGER_KEY]: decodedJsonByteLedger(value) };
  return packedCreativeEvents
    && decodedJsonByteLengths(stored).decodedJsonBytes >= decodedJsonByteLengths(value).decodedJsonBytes
    ? value
    : stored;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
