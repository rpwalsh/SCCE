// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { Hasher, JsonValue } from "./types.js";

export const CONSTRUCTION_SOURCE_EXAMPLE_STORAGE_SCHEMA = "scce.construction_source_examples.storage.v1";
type Row = Record<string, JsonValue>;
type Role = Row | [number, number];
export interface StoredConstructionSourceExamples {
  schema: typeof CONSTRUCTION_SOURCE_EXAMPLE_STORAGE_SCHEMA;
  roleMode: "inline" | "geometry";
  roles: JsonValue[][];
  examples: JsonValue[][];
  digest: string;
}
const fail = (): never => { throw Error("invalid construction source-example storage"); };
const index = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const record = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : fail();

/** Exact JSON identity: no normalization of evidence strings, opaque keys, or source geometry. */
export function constructionSourceExampleStorageJson(value: unknown): string {
  const active = new WeakSet<object>();
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (!value || typeof value !== "object" || active.has(value)) return fail();
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(d => d.get || d.set)) return fail();
    active.add(value);
    try {
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) return fail();
        return value.map(visit);
      }
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, visit((value as Row)[key])]));
    } finally { active.delete(value); }
  };
  return JSON.stringify(visit(value));
}
function clone<T>(value: T): T { return JSON.parse(constructionSourceExampleStorageJson(value)) as T; }
function ownerHeader(owner: unknown): unknown {
  const header = record(owner), descriptors = Object.getOwnPropertyDescriptors(header);
  if (![Object.prototype, null].includes(Object.getPrototypeOf(header)) || Object.getOwnPropertySymbols(header).length
    || Object.values(descriptors).some(d => d.get || d.set)) return fail();
  return Object.fromEntries(Object.entries(descriptors)
    .filter(([key, descriptor]) => key !== "sourceExamples" && descriptor.enumerable).map(([key, descriptor]) => [key, descriptor.value]));
}
function tupleRole(value: unknown, geometry: boolean): JsonValue[] {
  if (geometry) {
    if (!Array.isArray(value) || value.length !== 2 || !value.every(index)) return fail();
    return [...value];
  }
  const role = record(value);
  if (!index(role.slotIndex) || Object.hasOwn(role, "occurrenceIndex") && !index(role.occurrenceIndex)) return fail();
  const tuple: JsonValue[] = [role.slotIndex, Object.hasOwn(role, "occurrenceIndex") ? role.occurrenceIndex! : null];
  const fields = ["slotIndex", "occurrenceIndex"];
  if (Object.hasOwn(role, "startCodePoint") || Object.hasOwn(role, "endCodePoint")) {
    if (!index(role.startCodePoint) || !index(role.endCodePoint) || role.endCodePoint <= role.startCodePoint) return fail();
    tuple.push(role.startCodePoint, role.endCodePoint); fields.push("startCodePoint", "endCodePoint");
  }
  const extension = Object.fromEntries(Object.entries(role).filter(([key]) => !fields.includes(key)));
  if (Object.keys(extension).length) tuple.push(extension);
  return tuple;
}
function expandRole(value: unknown, geometry: boolean): Role {
  if (!Array.isArray(value)) return fail();
  if (geometry) {
    if (value.length !== 2 || !value.every(index)) return fail();
    return [...value] as [number, number];
  }
  if (value.length < 2 || value.length > 5 || !index(value[0]) || value[1] !== null && !index(value[1])) return fail();
  const hasBounds = typeof value[2] === "number";
  const required = hasBounds ? 4 : 2;
  if (value.length !== required && value.length !== required + 1) return fail();
  const base: Row = { slotIndex: value[0], ...(value[1] !== null ? { occurrenceIndex: value[1] } : {}) };
  if (hasBounds) {
    if (!index(value[2]) || !index(value[3]) || value[3] <= value[2]) return fail();
    base.startCodePoint = value[2]; base.endCodePoint = value[3];
  }
  const extension = value.length === required + 1 ? record(value[required]) : {};
  if (Object.keys(extension).some(key => ["slotIndex", "occurrenceIndex", "startCodePoint", "endCodePoint"].includes(key))) return fail();
  return Object.fromEntries([...Object.entries(base), ...Object.entries(extension)]);
}

/** One transparent writer; optional geometry mode is internal to the source-owned page bridge. */
export function encodeConstructionSourceExamples(values: unknown, owner: unknown, hasher: Hasher, options: { geometry?: boolean } = {}): StoredConstructionSourceExamples {
  if (!Array.isArray(values) || !values.length || values.length > 256) return fail();
  // Snapshot and reject accessors before inspecting any fields.
  const source = clone(values).map(record), geometry = options.geometry === true;
  const dictionary = new Map<string, JsonValue[]>();
  const roleKey = (role: unknown): string => {
    const tuple = tupleRole(role, geometry), key = constructionSourceExampleStorageJson(tuple);
    dictionary.set(key, tuple); return key;
  };
  for (const example of source) for (const field of ["roles", "nullRoles"]) {
    if (!Object.hasOwn(example, field) && field === "nullRoles") continue;
    if (!Array.isArray(example[field])) return fail();
    for (const role of example[field] as JsonValue[]) roleKey(role);
  }
  const entries = [...dictionary].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const ordinals = new Map(entries.map(([key], ordinal) => [key, ordinal]));
  const examples = source.map(example => {
    if (!index(example.evidenceIndex) || !index(example.surfaceStartCodePoint) || !index(example.surfaceEndCodePoint)
      || example.surfaceEndCodePoint <= example.surfaceStartCodePoint) return fail();
    const roles = (example.roles as JsonValue[]).map(role => ordinals.get(roleKey(role))!);
    const tuple: JsonValue[] = [example.evidenceIndex, example.surfaceStartCodePoint, example.surfaceEndCodePoint, roles];
    const extension = Object.fromEntries(Object.entries(example).filter(([key]) => !["evidenceIndex", "surfaceStartCodePoint", "surfaceEndCodePoint", "roles"].includes(key))
      .map(([key, value]) => [key, key === "nullRoles" ? (value as JsonValue[]).map(role => ordinals.get(roleKey(role))!) : value]));
    if (Object.keys(extension).length) tuple.push(extension);
    return tuple;
  });
  const material = { schema: CONSTRUCTION_SOURCE_EXAMPLE_STORAGE_SCHEMA as typeof CONSTRUCTION_SOURCE_EXAMPLE_STORAGE_SCHEMA, roleMode: geometry ? "geometry" as const : "inline" as const,
    roles: entries.map(([, role]) => role), examples };
  return { ...material, digest: hasher.digestHex(constructionSourceExampleStorageJson([ownerHeader(owner), material])) };
}

/** Raw arrays are the logical/oracle form; every stored marker follows the same verified decoder. */
export function decodeConstructionSourceExamples(value: unknown, owner: unknown, hasher: Hasher, options: { geometry?: boolean } = {}): Row[] {
  if (Array.isArray(value)) return clone(value).map(record);
  const packed = record(clone(value));
  if (Object.keys(packed).sort().join(",") !== "digest,examples,roleMode,roles,schema"
    || packed.schema !== CONSTRUCTION_SOURCE_EXAMPLE_STORAGE_SCHEMA || packed.roleMode !== (options.geometry ? "geometry" : "inline")
    || typeof packed.digest !== "string"
    || !Array.isArray(packed.roles) || !Array.isArray(packed.examples) || !packed.examples.length || packed.examples.length > 256) return fail();
  const { digest, ...material } = packed;
  if (hasher.digestHex(constructionSourceExampleStorageJson([ownerHeader(owner), material])) !== digest) return fail();
  const keys = packed.roles.map(role => constructionSourceExampleStorageJson(role));
  if (keys.some((key, i) => i > 0 && keys[i - 1]! >= key)) return fail();
  const roles = packed.roles.map(role => expandRole(role, options.geometry === true)), used = new Set<number>();
  const resolve = (refs: unknown): JsonValue[] => {
    if (!Array.isArray(refs)) return fail();
    return refs.map(ref => { if (!index(ref) || ref >= roles.length) return fail(); used.add(ref); return clone(roles[ref]!) as JsonValue; });
  };
  const examples = packed.examples.map(raw => {
    if (!Array.isArray(raw) || (raw.length !== 4 && raw.length !== 5) || !index(raw[0]) || !index(raw[1]) || !index(raw[2]) || raw[2] <= raw[1]) return fail();
    const extension = raw.length === 5 ? record(raw[4]) : {};
    if (Object.keys(extension).some(key => ["evidenceIndex", "surfaceStartCodePoint", "surfaceEndCodePoint", "roles"].includes(key))) return fail();
    return Object.fromEntries([["evidenceIndex", raw[0]], ["surfaceStartCodePoint", raw[1]], ["surfaceEndCodePoint", raw[2]], ["roles", resolve(raw[3])],
      ...Object.entries(extension).map(([key, value]) => [key, key === "nullRoles" ? resolve(value) : value])]) as Row;
  });
  if (used.size !== roles.length) return fail();
  return examples;
}
