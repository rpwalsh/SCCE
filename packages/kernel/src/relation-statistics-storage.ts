// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHasher } from "./primitives.js";
import type { JsonValue } from "./types.js";

export const RELATION_STATISTICS_STORAGE_SCHEMA = "scce.relation_statistics.storage.v1" as const;
type Scalar = string | number | boolean | null;
type Value = Scalar | [node: number];
type Node = [0, Value[]] | [1, shape: number, values: Value[]] | [2, string] | [3];
export interface StoredRelationStatistics {
  schema: typeof RELATION_STATISTICS_STORAGE_SCHEMA;
  shapes: string[][];
  nodes: Node[];
  root: Value;
  decodedJsonBytes: number;
  decodedValueCount: number;
  digest: string;
  tableDigest: string;
}
const fail = (): never => { throw new Error("invalid relation statistics storage"); };
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;
const scalar = (value: unknown): value is Scalar => value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** An exact shared structural table; observations and sufficient statistics remain complete. */
export function encodeRelationStatistics(value: JsonValue): StoredRelationStatistics {
  const nodes: Node[] = [], shapes: string[][] = [], nodeIds = new Map<string, number>(), shapeIds = new Map<string, number>();
  const repeated = new Map<string, number>(), active = new WeakSet<object>(), memo = new WeakMap<object, Value>();
  let count = 0;
  const scan = (value: JsonValue, depth: number): void => {
    if (++count > 1_000_000 || depth > 64) return fail();
    if (typeof value === "string" && value.length >= 24) repeated.set(value, (repeated.get(value) ?? 0) + 1);
    if (value && typeof value === "object") {
      if (active.has(value)) return fail();
      active.add(value);
      for (const member of Object.values(value)) scan(member, depth + 1);
      active.delete(value);
    } else if (!scalar(value)) fail();
  };
  scan(value, 0);
  const intern = (node: Node): [number] => {
    const key = JSON.stringify(node);
    let id = nodeIds.get(key);
    if (id === undefined) { id = nodes.length; nodeIds.set(key, id); nodes.push(node); }
    return [id];
  };
  const visit = (value: JsonValue): Value => {
    if (typeof value === "string" && (repeated.get(value) ?? 0) > 1) return intern([2, value]);
    if (Object.is(value, -0)) return intern([3]);
    if (scalar(value)) return value;
    const cached = memo.get(value); if (cached !== undefined) return cached;
    let result: Value;
    if (Array.isArray(value)) result = intern([0, value.map(visit)]);
    else {
      const keys = Object.keys(value), key = JSON.stringify(keys);
      let shape = shapeIds.get(key);
      if (shape === undefined) { shape = shapes.length; shapes.push(keys); shapeIds.set(key, shape); }
      result = intern([1, shape, keys.map(key => visit(value[key]!))]);
    }
    memo.set(value, result); return result;
  };
  const root = visit(value), json = JSON.stringify(value);
  const table = { shapes, nodes, root, decodedJsonBytes: byteLength(json), decodedValueCount: count };
  return { schema: RELATION_STATISTICS_STORAGE_SCHEMA, ...table,
    digest: createHasher().digestHex(json), tableDigest: createHasher().digestHex(JSON.stringify(table)) };
}

export function decodeRelationStatistics(value: unknown, limits: { maxDecodedBytes?: number; maxDecodedValues?: number } = {}): JsonValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return fail();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).sort().join(",") !== "decodedJsonBytes,decodedValueCount,digest,nodes,root,schema,shapes,tableDigest"
    || row.schema !== RELATION_STATISTICS_STORAGE_SCHEMA || !Array.isArray(row.shapes) || !Array.isArray(row.nodes)
    || !integer(row.decodedJsonBytes) || !integer(row.decodedValueCount) || typeof row.digest !== "string"
    || !/^[a-f0-9]{64}$/u.test(row.digest) || typeof row.tableDigest !== "string"
    || row.tableDigest !== createHasher().digestHex(JSON.stringify({ shapes: row.shapes, nodes: row.nodes, root: row.root,
      decodedJsonBytes: row.decodedJsonBytes, decodedValueCount: row.decodedValueCount }))
    || row.nodes.length > 1_000_000 || row.shapes.length > row.nodes.length) return fail();
  const maxBytes = limits.maxDecodedBytes ?? 128 * 1024 * 1024, maxValues = limits.maxDecodedValues ?? 1_000_000;
  if (row.decodedJsonBytes > maxBytes || row.decodedValueCount > maxValues) return fail();
  const shapes: string[][] = row.shapes.map(shape => {
    if (!Array.isArray(shape) || shape.some(key => typeof key !== "string") || new Set(shape).size !== shape.length) return fail();
    return shape;
  });
  if (new Set(shapes.map(shape => JSON.stringify(shape))).size !== shapes.length) return fail();
  const nodes = row.nodes as Node[], costs: { bytes: number; values: number; depth: number }[] = [];
  const shapeUsed = new Set<number>(), nodeUsed = new Set<number>();
  const cost = (value: unknown, before: number): { bytes: number; values: number; depth: number } => {
    if (Array.isArray(value)) {
      if (value.length !== 1 || !integer(value[0]) || value[0] >= before) return fail();
      return costs[value[0]]!;
    }
    if (!scalar(value)) return fail();
    return { bytes: byteLength(JSON.stringify(value)), values: 1, depth: 0 };
  };
  nodes.forEach((node, index) => {
    if (!Array.isArray(node)) return fail();
    let next: { bytes: number; values: number; depth: number };
    if (node[0] === 2 && node.length === 2 && typeof node[1] === "string") next = cost(node[1], index);
    else if (node[0] === 3 && node.length === 1) next = cost(-0, index);
    else {
      const object = node[0] === 1;
      if (!(node[0] === 0 && node.length === 2 || object && node.length === 3)
        || object && (!integer(node[1]) || !shapes[node[1]])) return fail();
      const members: unknown = object ? node[2] : node[1];
      if (!Array.isArray(members) || object && members.length !== shapes[node[1] as number]!.length) return fail();
      const children = members.map(member => cost(member, index));
      next = { bytes: 2 + Math.max(0, children.length - 1), values: 1, depth: 0 };
      children.forEach(child => { next.bytes += child.bytes; next.values += child.values; next.depth = Math.max(next.depth, child.depth + 1); });
      if (object) next.bytes += shapes[node[1] as number]!.reduce((total, key) => total + byteLength(JSON.stringify(key)) + 1, 0);
    }
    if (!integer(next.bytes) || next.bytes > maxBytes || !integer(next.values) || next.values > maxValues || next.depth > 64) return fail();
    costs.push(next);
  });
  const total = cost(row.root, nodes.length);
  if (total.bytes !== row.decodedJsonBytes || total.values !== row.decodedValueCount) return fail();
  const expand = (value: Value): JsonValue => {
    if (!Array.isArray(value)) return value;
    const id = value[0], node = nodes[id]!; nodeUsed.add(id);
    if (node[0] === 2) return node[1];
    if (node[0] === 3) return -0;
    if (node[0] === 0) return node[1].map(expand);
    shapeUsed.add(node[1]);
    return Object.fromEntries(shapes[node[1]]!.map((key, index) => [key, expand(node[2][index]!)]));
  };
  const restored = expand(row.root as Value);
  if (nodeUsed.size !== nodes.length || shapeUsed.size !== shapes.length || createHasher().digestHex(JSON.stringify(restored)) !== row.digest) return fail();
  return restored;
}
