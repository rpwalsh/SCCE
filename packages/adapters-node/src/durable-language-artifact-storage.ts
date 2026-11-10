// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { canonicalJsonByteLength, CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA,
  CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA, creativeSourceObservationStorageForm, creativeSourceObservationsFromStorage,
  SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, encodeSegmentationAdjacencyFactors, decodeSegmentationAdjacencyFactors,
  type SegmentationAdjacencyFactors } from "@scce/kernel";
import { DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA, decodeDurableCreativeEvents, encodeDurableCreativeEvents } from "./durable-creative-event-storage.js";
import { SEMANTIC_FRAME_STORAGE_SCHEMA, SEMANTIC_MEMORY_SCHEMA, decodeSemanticFrames, encodeSemanticFrames } from "./semantic-frame-storage.js";

export const LANGUAGE_ARTIFACT_BYTE_LEDGER_SCHEMA = "scce.language_artifact.byte_ledger.v1";
export const LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY = "_scceLanguageArtifactStorage";
export const SEGMENTATION_GRAPH_STORAGE_SCHEMA = "scce.segmentation_graph.storage.v1";
const GRAPH_LIMITS = { maxBytes: 64 * 1024 * 1024, maxNodes: 16 * 1024 * 1024, maxArcs: 4 * 1024 * 1024 };
const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const fail = (): never => { throw Error("invalid language artifact storage"); };
const record = (value: unknown): Record<string, unknown> | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

export function encodeLanguageArtifacts(value: unknown): unknown { return transform(value, true); }
export function decodeLanguageArtifacts<T>(value: unknown): T { return transform(value, false) as T; }

function transform(value: unknown, encoding: boolean): unknown {
  const root = record(value);
  if (encoding && root && Object.hasOwn(root, LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY)) return value;
  const seen = new WeakMap<object, unknown>(), sizes = new WeakMap<object, JsonByteLengths>();
  const visit = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    if (Array.isArray(value)) {
      let changed = false;
      const next = value.map(child => { const result = visit(child); changed ||= result !== child; return result; });
      const result = changed ? next : value; seen.set(value, result); return result;
    }
    const row = record(value)!;
    if (row.schema === SEGMENTATION_GRAPH_STORAGE_SCHEMA) {
      if (encoding) return value;
      const keys = Object.keys(row).filter(key => key !== LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY).sort().join(",");
      if (keys !== "data,digest,schema" || Object.hasOwn(row, LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY) && !validLedger(row[LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY])
        || typeof row.data !== "string" || typeof row.digest !== "string"
        || !/^[a-f0-9]{64}$/u.test(row.digest) || row.data.length > Math.ceil(GRAPH_LIMITS.maxBytes / 3) * 4
        || row.data.length % 4 || /[^A-Za-z0-9+/=]/u.test(row.data)) return fail();
      const bytes = Buffer.from(row.data, "base64");
      if (bytes.toString("base64") !== row.data || digest(bytes) !== row.digest) return fail();
      const graph = decodeSegmentationAdjacencyFactors(bytes, GRAPH_LIMITS); seen.set(value, graph); return graph;
    }
    if (row.schema === CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA) {
      if (encoding) return value;
      const result = creativeSourceObservationsFromStorage(row); seen.set(value, result); return result;
    }
    if (row.schema === SEMANTIC_FRAME_STORAGE_SCHEMA) {
      if (encoding) return value;
      const result = decodeSemanticFrames(row); seen.set(value, result); return result;
    }
    if (row.schema === DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA) {
      if (encoding) return value;
      const result = decodeDurableCreativeEvents(row); seen.set(value, result); return result;
    }
    if (encoding && row.schema === SEGMENTATION_ADJACENCY_FACTORS_SCHEMA) {
      // The same finite per-page geometry limits apply at both storage boundaries.
      if ((value as SegmentationAdjacencyFactors).nodeCount > GRAPH_LIMITS.maxNodes || (value as SegmentationAdjacencyFactors).arcs.length > GRAPH_LIMITS.maxArcs) return fail();
      const bytes = encodeSegmentationAdjacencyFactors(value as SegmentationAdjacencyFactors, GRAPH_LIMITS.maxBytes);
      const result = { schema: SEGMENTATION_GRAPH_STORAGE_SCHEMA, data: Buffer.from(bytes).toString("base64"), digest: digest(bytes) };
      seen.set(value, result); return result;
    }
    const ledger = row[LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY];
    let changed = false;
    const entries = Object.entries(row).map(([key, child]) => {
      let next: unknown;
      if (encoding && row.schema === CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA && key === "sourceObservations" && Array.isArray(child)) {
        next = creativeSourceObservationStorageForm(child as Parameters<typeof creativeSourceObservationStorageForm>[0]);
      } else if (encoding && row.schema === SEMANTIC_MEMORY_SCHEMA && key === "semanticFrames" && Array.isArray(child)) {
        next = encodeSemanticFrames(child) ?? visit(child);
      } else if (encoding && row.schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA && key === "events" && Array.isArray(child)) {
        next = encodeDurableCreativeEvents(child) ?? visit(child);
      } else next = visit(child);
      changed ||= next !== child; return [key, next] as const;
    });
    if (!encoding && record(ledger)?.schema === LANGUAGE_ARTIFACT_BYTE_LEDGER_SCHEMA && !validLedger(ledger)) return fail();
    const result = changed || !encoding && validLedger(ledger) ? Object.fromEntries(entries.filter(([key]) => encoding || key !== LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY)) : value;
    seen.set(value, result); return result;
  };
  const result = visit(value), resultRecord = record(result);
  if (!encoding || result === value || !resultRecord) return result;
  const ledger = { schema: LANGUAGE_ARTIFACT_BYTE_LEDGER_SCHEMA, ...jsonByteLengths(value, sizes) };
  const stored = { ...resultRecord, [LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY]: ledger };
  return jsonByteLengths(stored, sizes).decodedJsonBytes < ledger.decodedJsonBytes ? stored : value;
}

function validLedger(value: unknown): boolean {
  const row = record(value);
  return !!row && row.schema === LANGUAGE_ARTIFACT_BYTE_LEDGER_SCHEMA && Object.keys(row).length === 3
    && Number.isSafeInteger(row.decodedJsonBytes) && Number(row.decodedJsonBytes) >= 0
    && Number.isSafeInteger(row.decodedJsonbBytes) && Number(row.decodedJsonbBytes) >= Number(row.decodedJsonBytes);
}

interface JsonByteLengths { decodedJsonBytes: number; decodedJsonbBytes: number }

/** PostgreSQL adds separator spaces and expands exponent numbers when it renders JSONB text. */
export function languageArtifactJsonByteLengths(value: unknown): JsonByteLengths { return jsonByteLengths(value, new WeakMap()); }

function jsonByteLengths(value: unknown, cache: WeakMap<object, JsonByteLengths>): JsonByteLengths {
  if (value instanceof Date) return jsonByteLengths(value.toISOString(), cache);
  if (value && typeof value === "object") {
    const found = cache.get(value);
    if (found) return found;
    const children = Array.isArray(value) ? Array.from(value, child => jsonByteLengths(child, cache))
      : Object.entries(value).map(([key, child]) => {
        const bytes = jsonByteLengths(child, cache), keyBytes = Buffer.byteLength(JSON.stringify(key));
        return { decodedJsonBytes: keyBytes + 1 + bytes.decodedJsonBytes, decodedJsonbBytes: keyBytes + 2 + bytes.decodedJsonbBytes };
      });
    const result = children.reduce((total, child) => ({ decodedJsonBytes: total.decodedJsonBytes + child.decodedJsonBytes,
      decodedJsonbBytes: total.decodedJsonbBytes + child.decodedJsonbBytes }), { decodedJsonBytes: 2 + Math.max(0, children.length - 1), decodedJsonbBytes: 2 + Math.max(0, children.length - 1) * 2 });
    cache.set(value, result);
    return result;
  }
  const decodedJsonBytes = typeof value === "string" ? Buffer.byteLength(JSON.stringify(value)) : canonicalJsonByteLength(value);
  if (typeof value !== "number" || !Number.isFinite(value) || !String(value).includes("e")) return { decodedJsonBytes, decodedJsonbBytes: decodedJsonBytes };
  const [mantissa, exponent] = String(value).split("e");
  const unsigned = mantissa!.replace(/^-/, ""), digits = unsigned.replace(".", "");
  const decimalPosition = (unsigned.includes(".") ? unsigned.indexOf(".") : unsigned.length) + Number(exponent);
  const expanded = decimalPosition <= 0 ? 2 - decimalPosition + digits.length : decimalPosition >= digits.length ? decimalPosition : digits.length + 1;
  return { decodedJsonBytes, decodedJsonbBytes: Math.max(decodedJsonBytes, expanded + Number(value < 0)) };
}
