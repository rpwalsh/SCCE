// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import {
  SEGMENTATION_ADJACENCY_FACTORS_SCHEMA,
  decodeSegmentationAdjacencyFactors,
  encodeSegmentationAdjacencyFactors,
  type SegmentationAdjacencyFactors,
  type SegmentationScoreFactors
} from "@scce/kernel";
import {
  DECODED_JSON_BYTE_LEDGER_KEY,
  isDecodedJsonByteLedger
} from "./decoded-json-byte-ledger.js";
import {
  SEGMENTATION_FACTOR_UNITS_STORAGE_SCHEMA,
  decodeSegmentationFactorUnits,
  encodeSegmentationFactorUnits,
  type SegmentationFactorUnit
} from "./segmentation-factor-unit-storage.js";
import {
  SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA,
  decodeSegmentationScoreGraph,
  encodeSegmentationScoreGraph
} from "./segmentation-score-storage.js";

export const SEGMENTATION_ADJACENCY_STORAGE_SCHEMA = "scce.segmentation_adjacency.storage.v1" as const;
const LIMITS = { maxBytes: 64 * 1024 * 1024, maxNodes: 16 * 1024 * 1024, maxArcs: 4 * 1024 * 1024 };
const SCORE_FIELDS = ["graph", "factors"] as const;

/** Encode graph topology, frozen score data, and repeated factor units without any JOIN semantics. */
export function encodeSegmentationData(value: unknown): unknown {
  return transform(value, true);
}

/** Restore exact segmentation data; this never fits a model or acquires new evidence. */
export function decodeSegmentationData<T>(value: unknown): T {
  return transform(value, false) as T;
}

function transform(value: unknown, encoding: boolean): unknown {
  const seen = new WeakMap<object, unknown>();
  const fail = (): never => { throw Error("invalid durable segmentation data"); };
  const digest = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
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
    if (!encoding && row.schema === SEGMENTATION_FACTOR_UNITS_STORAGE_SCHEMA) {
      const result = decodeSegmentationFactorUnits(row, LIMITS.maxArcs);
      seen.set(input, result);
      return result;
    }
    if (!encoding) {
      const scoreField = SCORE_FIELDS.find(field => record(row[field])?.schema === SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA);
      if (scoreField) {
        if (Object.hasOwn(row, "scoreRecipe")) return fail();
        const restored = decodeSegmentationScoreGraph(row[scoreField]);
        const result = visit({ ...row, [scoreField]: restored.graph, scoreRecipe: restored.recipe });
        seen.set(input, result);
        return result;
      }
    }
    if (row.schema === SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA) {
      if (!encoding) return fail();
      decodeSegmentationScoreGraph(row);
      return input;
    }
    if (row.schema === SEGMENTATION_ADJACENCY_STORAGE_SCHEMA) {
      if (encoding) return input;
      const ledger = row[DECODED_JSON_BYTE_LEDGER_KEY];
      const keys = Object.keys(row).filter(key => key !== DECODED_JSON_BYTE_LEDGER_KEY).sort().join(",");
      if (keys !== "data,digest,schema"
        || Object.hasOwn(row, DECODED_JSON_BYTE_LEDGER_KEY) && !isDecodedJsonByteLedger(ledger)
        || typeof row.data !== "string" || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.digest)
        || row.data.length > Math.ceil(LIMITS.maxBytes / 3) * 4 || row.data.length % 4
        || /[^A-Za-z0-9+/=]/u.test(row.data)) return fail();
      const bytes = Buffer.from(row.data, "base64");
      if (bytes.toString("base64") !== row.data || digest(bytes) !== row.digest) return fail();
      const graph = decodeSegmentationAdjacencyFactors(bytes, LIMITS);
      const result = ledger === undefined ? graph : { ...graph, [DECODED_JSON_BYTE_LEDGER_KEY]: ledger };
      seen.set(input, result);
      return result;
    }
    if (encoding && row.schema === SEGMENTATION_ADJACENCY_FACTORS_SCHEMA) {
      const graph = input as SegmentationAdjacencyFactors;
      if (graph.nodeCount > LIMITS.maxNodes || graph.arcs.length > LIMITS.maxArcs) return fail();
      const bytes = encodeSegmentationAdjacencyFactors(graph, LIMITS.maxBytes);
      const result = {
        schema: SEGMENTATION_ADJACENCY_STORAGE_SCHEMA,
        data: Buffer.from(bytes).toString("base64"),
        digest: digest(bytes)
      };
      seen.set(input, result);
      return result;
    }
    if (encoding && Object.hasOwn(row, "scoreRecipe")) {
      const scoreField = SCORE_FIELDS.find(field => record(row[field])?.schema === SEGMENTATION_ADJACENCY_FACTORS_SCHEMA);
      if (scoreField) {
        const graph = encodeSegmentationScoreGraph(
          row[scoreField] as SegmentationAdjacencyFactors,
          row.scoreRecipe as SegmentationScoreFactors
        );
        const { scoreRecipe: _scoreRecipe, ...header } = row;
        const next = { ...header, [scoreField]: graph };
        if (Array.isArray(row.units) && segmentationFactorUnits(row.units)) {
          next.units = encodeSegmentationFactorUnits(row.units as SegmentationFactorUnit[]);
        }
        const result = visit(next);
        seen.set(input, result);
        return result;
      }
    }
    let changed = false;
    const members = Object.entries(input).map(([key, member]) => {
      let next: unknown;
      if (encoding && key === "units" && Array.isArray(member) && segmentationFactorUnits(member)
        && SCORE_FIELDS.some(field => {
          const schema = record(row[field])?.schema;
          return schema === SEGMENTATION_ADJACENCY_FACTORS_SCHEMA
            || schema === SEGMENTATION_ADJACENCY_STORAGE_SCHEMA
            || schema === SEGMENTATION_SCORE_GRAPH_STORAGE_SCHEMA;
        })) {
        next = encodeSegmentationFactorUnits(member as SegmentationFactorUnit[]);
      } else {
        next = visit(member);
      }
      changed ||= next !== member;
      return [key, next] as const;
    });
    const result = changed ? Object.fromEntries(members) : input;
    seen.set(input, result);
    return result;
  };
  return visit(value);
}

function segmentationFactorUnits(values: readonly unknown[]): boolean {
  return values.every(value => value === null || Array.isArray(value)
    && (value.length === 3 || value.length === 5)
    && Number.isSafeInteger(value[0]) && Number.isSafeInteger(value[1]) && Array.isArray(value[2]));
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}
