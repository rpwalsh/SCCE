// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import type { JoinLocalFactorDocument } from "@scce/kernel";

export const JOIN_FACTOR_UNITS_STORAGE_SCHEMA = "scce.join_factor_units.storage.v1" as const;
export type JoinFactorUnit = JoinLocalFactorDocument["units"][number];
export interface StoredJoinFactorUnits {
  schema: typeof JOIN_FACTOR_UNITS_STORAGE_SCHEMA;
  count: number;
  width: 1 | 2 | 4;
  dictionary: JoinFactorUnit[];
  refs: string;
  digest: string;
}
const MAX_UNITS = 4 * 1024 * 1024;
// Bound repeated evidence arrays before expanding dictionary references into public rows.
const MAX_EVIDENCE_REFS = 16 * 1024 * 1024;
const fail = (): never => { throw Error("invalid JOIN factor unit storage"); };
const natural = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && !Object.is(value, -0);
const widthFor = (count: number): 1 | 2 | 4 => count <= 256 ? 1 : count <= 65536 ? 2 : 4;

function array(value: unknown, maximum: number): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype || value.length > maximum
    || Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== value.length + 1) return fail();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (let index = 0; index < value.length; index++) if (!descriptors[index] || !Object.hasOwn(descriptors[index]!, "value")) return fail();
  return value;
}

function unit(value: unknown): JoinFactorUnit {
  if (value === null) return null;
  const row = array(value, 5);
  if (row.length !== 3 && row.length !== 5 || !natural(row[0]) || !natural(row[1]) || row[1] > 7) return fail();
  const refs = array(row[2], MAX_EVIDENCE_REFS);
  if (!refs.every(natural) || new Set(refs).size !== refs.length) return fail();
  if (row.length === 5 && (!natural(row[3]) || !natural(row[4]) || row[4] <= row[3])) return fail();
  return row.length === 3 ? [row[0], row[1], [...refs] as number[]] : [row[0], row[1], [...refs] as number[], row[3] as number, row[4] as number];
}

function clone(value: JoinFactorUnit): JoinFactorUnit {
  return value === null ? null : value.length === 3 ? [value[0], value[1], [...value[2]]] : [value[0], value[1], [...value[2]], value[3], value[4]];
}
function digest(count: number, width: number, dictionary: readonly JoinFactorUnit[], refs: Uint8Array): string {
  return createHash("sha256").update(JSON.stringify({ schema: JOIN_FACTOR_UNITS_STORAGE_SCHEMA, count, width, dictionary })).update(refs).digest("hex");
}
function refAt(bytes: Buffer, index: number, width: 1 | 2 | 4): number {
  return width === 1 ? bytes[index]! : width === 2 ? bytes.readUInt16LE(index * 2) : bytes.readUInt32LE(index * 4);
}

/** Ordered null/typed unit rows share exact dictionary definitions, never public mutable arrays. */
export function encodeJoinFactorUnits(units: readonly JoinFactorUnit[]): StoredJoinFactorUnits {
  const input = array(units, MAX_UNITS), dictionary: JoinFactorUnit[] = [], ids = new Map<string, number>();
  const references: number[] = [];
  let evidenceRefs = 0;
  for (const raw of input) {
    const value = unit(raw);
    evidenceRefs += value?.[2].length ?? 0;
    if (evidenceRefs > MAX_EVIDENCE_REFS) return fail();
    const key = JSON.stringify(value);
    let id = ids.get(key);
    if (id === undefined) { id = dictionary.length; ids.set(key, id); dictionary.push(value); }
    references.push(id);
  }
  const count = input.length, width = widthFor(dictionary.length), bytes = Buffer.alloc(count * width);
  references.forEach((ref, index) => {
    if (width === 1) bytes[index] = ref;
    else if (width === 2) bytes.writeUInt16LE(ref, index * 2);
    else bytes.writeUInt32LE(ref, index * 4);
  });
  return { schema: JOIN_FACTOR_UNITS_STORAGE_SCHEMA, count, width, dictionary, refs: bytes.toString("base64"), digest: digest(count, width, dictionary, bytes) };
}

/** Validate byte/count/evidence bounds and checksum before allocating the expanded logical array. */
export function decodeJoinFactorUnits(value: unknown, maxUnits = MAX_UNITS): JoinLocalFactorDocument["units"] {
  if (!natural(maxUnits) || maxUnits > MAX_UNITS || !value || typeof value !== "object" || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
  const row = value as Record<string, unknown>;
  if (Object.getOwnPropertySymbols(row).length || Object.getOwnPropertyNames(row).sort().join(",") !== "count,dictionary,digest,refs,schema,width"
    || Object.values(Object.getOwnPropertyDescriptors(row)).some(descriptor => !Object.hasOwn(descriptor, "value"))) return fail();
  if (row.schema !== JOIN_FACTOR_UNITS_STORAGE_SCHEMA || !natural(row.count) || row.count > maxUnits
    || !Array.isArray(row.dictionary) || row.dictionary.length > row.count || row.width !== widthFor(row.dictionary.length)
    || typeof row.refs !== "string" || typeof row.digest !== "string" || !/^[a-f0-9]{64}$/u.test(row.digest)) return fail();
  const count = row.count, width = row.width as 1 | 2 | 4, expectedBytes = count * width;
  if (row.refs.length !== Math.ceil(expectedBytes / 3) * 4 || /[^A-Za-z0-9+/=]/u.test(row.refs)) return fail();
  const bytes = Buffer.from(row.refs, "base64");
  if (bytes.length !== expectedBytes || bytes.toString("base64") !== row.refs) return fail();
  const rawDictionary = array(row.dictionary, count), dictionary: JoinFactorUnit[] = [];
  let dictionaryRefs = 0;
  for (const raw of rawDictionary) {
    const value = unit(raw); dictionaryRefs += value?.[2].length ?? 0;
    if (dictionaryRefs > MAX_EVIDENCE_REFS) return fail();
    dictionary.push(value);
  }
  if (new Set(dictionary.map(value => JSON.stringify(value))).size !== dictionary.length
    || digest(count, width, dictionary, bytes) !== row.digest) return fail();
  let discovered = 0, evidenceRefs = 0;
  for (let index = 0; index < count; index++) {
    const ref = refAt(bytes, index, width);
    // First appearances canonically enumerate the dictionary; no unused or reordered definitions.
    if (ref >= dictionary.length || ref > discovered) return fail();
    if (ref === discovered) discovered++;
    evidenceRefs += dictionary[ref]?.[2].length ?? 0;
    if (evidenceRefs > MAX_EVIDENCE_REFS) return fail();
  }
  if (discovered !== dictionary.length) return fail();
  return Array.from({ length: count }, (_, index) => clone(dictionary[refAt(bytes, index, width)]!));
}
