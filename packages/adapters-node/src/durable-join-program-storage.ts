// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA,
  creativeSourceObservationStorageForm, creativeSourceObservationsFromStorage,
  JOIN_PROGRAM_MIXTURE_SCHEMA, JOIN_PROGRAM_SCHEMA, JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA, JOIN_PROGRAM_MIXTURE_STORAGE_V1_SCHEMA, JOIN_PROGRAM_LOCAL_FACTORS_SCHEMA,
  SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, encodeSegmentationAdjacencyFactors, decodeSegmentationAdjacencyFactors,
  RELATION_STATISTICS_STORAGE_SCHEMA, encodeRelationStatistics, decodeRelationStatistics,
  canonicalJsonByteLength, isJoinProgramGlobalFactors, isJoinProgramLocalFactors, isJoinProgramMixture, joinProgramMixtureFromStorage, joinProgramMixtureStorageForm,
  type JsonValue, type SegmentationAdjacencyFactors, type SegmentationScoreFactors } from "@scce/kernel";
import { DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA, decodeDurableCreativeEvents, encodeDurableCreativeEvents } from "./durable-creative-event-storage.js";
import { SEMANTIC_FRAME_STORAGE_SCHEMA, SEMANTIC_MEMORY_SCHEMA, decodeSemanticFrames, encodeSemanticFrames } from "./semantic-frame-storage.js";
import { SEMANTIC_PROJECTION_STORAGE_KEY, encodeSemanticProjection, decodeSemanticProjection } from "./semantic-projection-storage.js";
import { JOIN_FACTOR_UNITS_STORAGE_SCHEMA, encodeJoinFactorUnits, decodeJoinFactorUnits } from "./join-factor-unit-storage.js";
import { SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA, encodeSegmentationScoreGraph, decodeSegmentationScoreGraph } from "./segmentation-score-storage.js";

export const DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA = "scce.durable_join_program.storage.v1";
export const DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA = "scce.durable_join_program.byte_ledger.v1";
export const DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY = "_scceJoinProgramStorage";
const INDEXES = ["conditionedIndex", "exactIndex", "structuralIndex", "classIndex", "localShapeIndex", "constructionIndex"] as const;
const CHOICE_FIELDS = new Set(["surface", "count", "probability", "evidenceIds", "evidenceCoordinates"]);
const COORDINATE_FIELDS = new Set(["evidenceId", "sourceVersionId", "documentId", "byteStart", "byteEnd", "utf16Start", "utf16End", "exactSurfaceHash"]);
const SEGMENTATION_GRAPH_STORAGE_SCHEMA = "scce.segmentation_graph.storage.v1";
const GRAPH_LIMITS = { maxBytes: 64 * 1024 * 1024, maxNodes: 16 * 1024 * 1024, maxArcs: 4 * 1024 * 1024 };

/** The marker preserves whether the logical caller supplied a raw or intentionally packed mixture. */
export function encodeDurableJoinPrograms(value: unknown): unknown {
  const root = record(value);
  if (Array.isArray(value) || root && Object.hasOwn(root, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)) return value;
  const joined = transform(value, true), stored = transformGraphs(joined, true), storedRoot = record(stored);
  if (stored === joined || !storedRoot || storedRoot.schema === DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA
    || Object.hasOwn(storedRoot, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)) return stored;
  // JOIN packing and graph packing share the caller's original logical byte charge.
  return { ...storedRoot, [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: {
    schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...durableJoinProgramJsonByteLengths(value),
    ...(root && Object.hasOwn(root, "joinProgram") ? { joinProgramMemberJsonbBytes: durableJoinProgramJsonByteLengths(root.joinProgram).decodedJsonbBytes
      + canonicalJsonByteLength("joinProgram") + 2 + (Object.keys(root).length > 1 ? 2 : 0) } : {})
  } };
}

export function decodeDurableJoinPrograms<T>(value: unknown): T { return transform(transformGraphs(value, false), false) as T; }

/** Check the original parent's budget after every physical layer has been restored. */
export function verifyDurableJoinProgramByteLedger(wire: unknown, logical: unknown): void {
  const root = record(wire);
  if (!root || !Object.hasOwn(root, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)) return;
  const ledger = record(root[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]);
  const sizes = durableJoinProgramJsonByteLengths(logical);
  if (!validLedger(ledger) || ledger!.decodedJsonBytes !== sizes.decodedJsonBytes || ledger!.decodedJsonbBytes !== sizes.decodedJsonbBytes) {
    throw Error("decoded byte ledger mismatch");
  }
  if (Object.hasOwn(ledger!, "joinProgramMemberJsonbBytes")) {
    const body = record(logical);
    const expected = body && Object.hasOwn(body, "joinProgram")
      ? durableJoinProgramJsonByteLengths(body.joinProgram).decodedJsonbBytes + canonicalJsonByteLength("joinProgram") + 2 + (Object.keys(body).length > 1 ? 2 : 0)
      : undefined;
    if (ledger!.joinProgramMemberJsonbBytes !== expected) throw Error("decoded JOIN member byte ledger mismatch");
  }
}

function transform(value: unknown, encoding: boolean): unknown {
  const rootRecord = record(value);
  if (encoding && (Array.isArray(value) || rootRecord && Object.hasOwn(rootRecord, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY))) return value;
  const seen = new WeakMap<object, unknown>();
  const sizes = new WeakMap<object, JsonByteLengths>();
  let packedCreativeEvents = false;
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
    if (!encoding && row?.schema === JOIN_FACTOR_UNITS_STORAGE_SCHEMA) {
      const result = decodeJoinFactorUnits(row, GRAPH_LIMITS.maxArcs);
      seen.set(value, result); return result;
    }
    if (row && encoding && Object.hasOwn(row, "semanticInductionProjection") && !Object.hasOwn(row, SEMANTIC_PROJECTION_STORAGE_KEY)) {
      const result = visit(encodeSemanticProjection(row));
      seen.set(value, result); return result;
    }
    if (row && !encoding && Object.hasOwn(row, SEMANTIC_PROJECTION_STORAGE_KEY)) {
      const result = visit(decodeSemanticProjection(row));
      seen.set(value, result); return result;
    }
    if (row?.schema === JOIN_PROGRAM_MIXTURE_SCHEMA && Array.isArray(row.components)
      && row.components.some(component => { const program = record(record(component)?.program);
        return program && Object.hasOwn(program, "localFactors") && (!isJoinProgramLocalFactors(program.localFactors)
          || !emptyIndex(program.exactIndex) || !emptyIndex(program.classIndex) || !implicitLocalProofs(program)); })) {
      throw new Error("invalid JOIN local factors");
    }
    if (row?.schema === JOIN_PROGRAM_MIXTURE_SCHEMA && Array.isArray(row.components)
      && row.components.some(component => !validGlobalFactors(record(record(component)?.program)))) {
      throw new Error("invalid JOIN global factors");
    }
    if (row?.schema === CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA) {
      if (encoding) return value;
      const observations = creativeSourceObservationsFromStorage(row);
      seen.set(value, observations);
      return observations;
    }
    if (row?.schema === RELATION_STATISTICS_STORAGE_SCHEMA) {
      if (encoding) return value;
      const statistics = decodeRelationStatistics(row);
      seen.set(value, statistics);
      return statistics;
    }
    if (row?.schema === SEMANTIC_FRAME_STORAGE_SCHEMA) {
      if (encoding) return value;
      const frames = decodeSemanticFrames(row);
      seen.set(value, frames);
      return frames;
    }
    if (row?.schema === DURABLE_CREATIVE_EVENT_STORAGE_SCHEMA) {
      if (encoding) return value;
      const events = decodeDurableCreativeEvents(row);
      seen.set(value, events);
      return events;
    }
    if (row?.schema === DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA) {
      const packed = encoding ? transformGraphs(row.mixture, false) : row.mixture;
      const mixture = Object.keys(row).length === 4 && validSizes(row) && record(packed)?.schema === JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA
        ? joinProgramMixtureFromStorage(packed) : undefined;
      if (!mixture) throw new Error("invalid durable JOIN storage marker");
      const sizes = durableJoinProgramJsonByteLengths(mixture);
      if (row.decodedJsonBytes !== sizes.decodedJsonBytes || row.decodedJsonbBytes !== sizes.decodedJsonbBytes) throw Error("decoded JOIN storage byte sizes mismatch");
      if (encoding) return value;
      seen.set(value, mixture);
      return mixture;
    }
    if (row?.schema === JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA || row?.schema === JOIN_PROGRAM_MIXTURE_STORAGE_V1_SCHEMA) {
      const mixture = record(row.mixture);
      if (Array.isArray(mixture?.components) && mixture.components.some(component => { const program = record(record(component)?.program), header = record(program?.header), indexes = record(program?.indexes);
        return header && Object.hasOwn(header, "localFactors") && (!isJoinProgramLocalFactors(header.localFactors)
          || !Array.isArray(indexes?.exactIndex) || indexes.exactIndex.length !== 0
          || !Array.isArray(indexes?.classIndex) || indexes.classIndex.length !== 0
          || !packedImplicitLocalProofs(program, row.schema)); })) {
        throw new Error("invalid JOIN local factors");
      }
      if (Array.isArray(mixture?.components) && mixture.components.some(component => {
        const program = record(record(component)?.program), header = record(program?.header), indexes = record(program?.indexes);
        return header && Object.hasOwn(header, "globalFactors") && (!validGlobalFactors(header)
          || !Array.isArray(indexes?.conditionedIndex) || indexes.conditionedIndex.length !== 0
          || !Array.isArray(indexes?.structuralIndex) || indexes.structuralIndex.length !== 0);
      })) throw new Error("invalid JOIN global factors");
      return !encoding && validLedger(row[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY])
        ? Object.fromEntries(Object.entries(row).filter(([key]) => key !== DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY)) : value;
    }
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
      let next: unknown;
      if (encoding && row?.schema === CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA && key === "sourceObservations" && Array.isArray(child)) {
        next = creativeSourceObservationStorageForm(child as Parameters<typeof creativeSourceObservationStorageForm>[0]);
      } else if (encoding && row?.schema === SEMANTIC_MEMORY_SCHEMA && key === "relationHypothesisModel") {
        next = record(child)?.schema === RELATION_STATISTICS_STORAGE_SCHEMA ? child : encodeRelationStatistics(child as JsonValue);
      } else if (encoding && row?.schema === SEMANTIC_MEMORY_SCHEMA && key === "semanticFrames" && Array.isArray(child)) {
        next = encodeSemanticFrames(child) ?? visit(child);
      } else if (encoding && row?.schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA && key === "events" && Array.isArray(child)) {
        const packed = encodeDurableCreativeEvents(child);
        if (packed) { packedCreativeEvents = true; next = packed; }
        else next = visit(child);
      } else next = visit(child);
      if (next !== child) changed = true;
      return [key, next] as const;
    });
    const result = changed || !encoding && validLedger(ledger) ? Object.fromEntries(!encoding && validLedger(ledger)
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
  const stored = { ...resultRecord, [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: ledger };
  return packedCreativeEvents && jsonByteLengths(stored, sizes).decodedJsonBytes >= ledger.decodedJsonBytes ? value : stored;
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
    if (!program || program.schema !== JOIN_PROGRAM_SCHEMA || !validGlobalFactors(program)
      || Object.hasOwn(program, "localFactors") && (!isJoinProgramLocalFactors(program.localFactors)
        || !emptyIndex(program.exactIndex) || !emptyIndex(program.classIndex) || !implicitLocalProofs(program))) return false;
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
function validGlobalFactors(program: Record<string, unknown> | undefined): boolean {
  return !program || !Object.hasOwn(program, "globalFactors") || isJoinProgramLocalFactors(program.localFactors)
    && isJoinProgramGlobalFactors(program.globalFactors, program.localFactors)
    && (!Object.hasOwn(program, "conditionedIndex") || emptyIndex(program.conditionedIndex))
    && (!Object.hasOwn(program, "structuralIndex") || emptyIndex(program.structuralIndex));
}
function finite(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function emptyIndex(value: unknown): boolean { const row = record(value); return row !== undefined && Object.keys(row).length === 0; }
function implicitLocalProofs(program: Record<string, unknown>): boolean {
  return ["localShapeIndex", "constructionIndex"].every(name => { const index = record(program[name]);
    return index !== undefined && Object.values(index).every(choices => Array.isArray(choices) && choices.every(choice => {
      const coordinates = record(choice)?.evidenceCoordinates; return Array.isArray(coordinates) && coordinates.length === 0;
    }));
  });
}
function packedImplicitLocalProofs(program: Record<string, unknown> | undefined, schema: unknown): boolean {
  const indexes = record(program?.indexes), dictionary = program?.choiceDictionary;
  return ["localShapeIndex", "constructionIndex"].every(name => Array.isArray(indexes?.[name]) && indexes[name].every(entry => {
    if (!Array.isArray(entry) || !Array.isArray(entry[1])) return false;
    return entry[1].every(ref => { const coordinates = schema === JOIN_PROGRAM_MIXTURE_STORAGE_SCHEMA
      ? Array.isArray(dictionary) && Number.isSafeInteger(ref) ? dictionary[ref]?.[4] : undefined
      : record(ref)?.evidenceCoordinateRefs;
      return Array.isArray(coordinates) && coordinates.length === 0;
    });
  }));
}

/** Physical graph bytes are composed after JOIN packing and restored before its validators run. */
function transformGraphs(value: unknown, encoding: boolean): unknown {
  const seen = new WeakMap<object, unknown>();
  const fail = (): never => { throw Error("invalid durable segmentation graph storage"); };
  const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
  const visit = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value;
    if (seen.has(value)) return seen.get(value);
    const row = record(value);
    if (!encoding && row?.schema === JOIN_FACTOR_UNITS_STORAGE_SCHEMA) {
      const result = decodeJoinFactorUnits(row, GRAPH_LIMITS.maxArcs);
      seen.set(value, result); return result;
    }
    if (!encoding && row && record(row.graph)?.schema === SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA) {
      if (Object.hasOwn(row, "scoreRecipe")) return fail();
      const restored = decodeSegmentationScoreGraph(row.graph);
      const result = visit({ ...row, graph: restored.graph, scoreRecipe: restored.recipe });
      seen.set(value, result); return result;
    }
    if (row?.schema === SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA) {
      if (!encoding) return fail();
      decodeSegmentationScoreGraph(row);
      return value;
    }
    if (row?.schema === SEGMENTATION_GRAPH_STORAGE_SCHEMA) {
      if (encoding) return value;
      const ledger = row[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY];
      if (Object.keys(row).filter(key => key !== DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY).sort().join(",") !== "data,digest,schema"
        || Object.hasOwn(row, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY) && !validLedger(ledger)
        || typeof row.data !== "string" || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.digest)
        || row.data.length > Math.ceil(GRAPH_LIMITS.maxBytes / 3) * 4 || row.data.length % 4 || /[^A-Za-z0-9+/=]/u.test(row.data)) return fail();
      const bytes = Buffer.from(row.data, "base64");
      if (bytes.toString("base64") !== row.data || digest(bytes) !== row.digest) return fail();
      const graph = decodeSegmentationAdjacencyFactors(bytes, GRAPH_LIMITS);
      const result = ledger === undefined ? graph : { ...graph, [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: ledger };
      seen.set(value, result); return result;
    }
    if (encoding && row?.schema === SEGMENTATION_ADJACENCY_FACTORS_SCHEMA) {
      const graph = value as SegmentationAdjacencyFactors;
      if (graph.nodeCount > GRAPH_LIMITS.maxNodes || graph.arcs.length > GRAPH_LIMITS.maxArcs) return fail();
      const bytes = encodeSegmentationAdjacencyFactors(graph, GRAPH_LIMITS.maxBytes);
      const result = { schema: SEGMENTATION_GRAPH_STORAGE_SCHEMA, data: Buffer.from(bytes).toString("base64"), digest: digest(bytes) };
      seen.set(value, result); return result;
    }
    let changed = false;
    const members = Object.entries(value).map(([key, member]) => {
      let next: unknown;
      if (encoding && row?.schema === JOIN_PROGRAM_LOCAL_FACTORS_SCHEMA && key === "documents" && Array.isArray(member)) {
        const documents = member.map(doc => {
          const document = record(doc);
          if (!document) throw Error("invalid JOIN local unit document");
          let units: unknown;
          if (Array.isArray(document.units)) units = encodeJoinFactorUnits(document.units);
          else if (record(document.units)?.schema === JOIN_FACTOR_UNITS_STORAGE_SCHEMA) {
            decodeJoinFactorUnits(document.units, GRAPH_LIMITS.maxArcs); return visit(document);
          } else throw Error("invalid JOIN local unit document");
          if (document.scoreRecipe !== undefined) {
            const graph = encodeSegmentationScoreGraph(document.graph as SegmentationAdjacencyFactors, document.scoreRecipe as SegmentationScoreFactors);
            const { scoreRecipe: _metadata, ...header } = document;
            // Both children are already validated and encoded. Replaying the
            // newly created graph here would duplicate the complete calculation.
            return { ...header, graph, units };
          }
          return visit({ ...document, units });
        });
        next = documents.some((doc, index) => doc !== member[index]) ? documents : member;
      } else next = visit(member);
      changed ||= next !== member; return [key, next] as const;
    });
    const result = changed ? Array.isArray(value) ? members.map(([, member]) => member) : Object.fromEntries(members) : value;
    seen.set(value, result); return result;
  };
  return visit(value);
}
