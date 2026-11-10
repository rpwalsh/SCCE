// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE } from "./language-construction-memory.js";
import type { Hasher, JsonValue } from "./types.js";
import { decodeConstructionSourceExamples, encodeConstructionSourceExamples } from "./construction-source-example-storage.js";

export const CONSTRUCTION_ROLE_GEOMETRY_KEY = "_scceConstructionRoleGeometry";
export const CONSTRUCTION_ROLE_GEOMETRY_REFERENCE_SCHEMA = "scce.construction_role_geometry_ref.v1";
export const CONSTRUCTION_ROLE_GEOMETRY_COMPACT_REFERENCE_SCHEMA = "scce.construction_role_geometry_ref.v2";
export const CONSTRUCTION_ROLE_GEOMETRY_KIND = "construction_role_geometry";
export interface ConstructionRoleGeometryPage {
  id: string;
  ownerKey: string;
  kind: typeof CONSTRUCTION_ROLE_GEOMETRY_KIND;
  payload: Record<string, JsonValue>[];
  digest: string;
}
type Row = Record<string, unknown>;
const fail = (): never => { throw Error("invalid source-owned construction role geometry"); };
const row = (value: unknown): Row => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : fail();
const utf8 = new TextEncoder();
const bytes = (value: string): number => utf8.encode(value).byteLength;
const safeIndex = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

/** Storage equality preserves JSON strings and keys exactly, without source-text normalization. */
function storageJson(value: unknown): string {
  const active = new WeakSet<object>();
  const visit = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (!value || typeof value !== "object" || active.has(value)) return fail();
    if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return fail();
    active.add(value);
    try {
      const descriptors = Object.getOwnPropertyDescriptors(value);
      if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(descriptor => descriptor.get || descriptor.set)) return fail();
      if (Array.isArray(value)) {
        if (Object.keys(value).length !== value.length) return fail();
        return value.map(visit);
      }
      return Object.fromEntries(Object.keys(value).sort().map(key => [key, visit((value as Row)[key])]));
    } finally { active.delete(value); }
  };
  return JSON.stringify(visit(value));
}
function roleJson(value: unknown): string {
  const role = row(value);
  if (!safeIndex(role.slotIndex) || !safeIndex(role.occurrenceIndex)) return fail();
  if (Object.hasOwn(role, "startCodePoint") || Object.hasOwn(role, "endCodePoint")) {
    if (!safeIndex(role.startCodePoint) || !safeIndex(role.endCodePoint) || role.endCodePoint <= role.startCodePoint) return fail();
  }
  return storageJson(role);
}
function pageIdentity(ownerKey: string, payload: unknown, hasher: Hasher): string {
  const digest = hasher.digestHex(storageJson({ kind: CONSTRUCTION_ROLE_GEOMETRY_KIND, ownerKey, payload }));
  return /^[a-f0-9]{64}$/u.test(digest) ? digest : fail();
}
function pageId(digest: string): string { return `construction.role_geometry.${digest}`; }
function sourceExamples(value: unknown, hasher: Hasher, geometry = false): { root: Row; bundle: Row; examples: Row[]; compact: boolean } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const root = value as Row;
  if (Object.hasOwn(root, CONSTRUCTION_ROLE_GEOMETRY_KEY)) return fail();
  if (root.schema !== LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA || root.storageEncoding !== SOURCE_EXAMPLE_CONSTRUCTION_STORAGE) return undefined;
  const bundle = row(root.bundle);
  let examples: Record<string, JsonValue>[];
  try { examples = decodeConstructionSourceExamples(bundle.sourceExamples, bundle, hasher, { geometry }); } catch { return fail(); }
  if (!examples.length) return fail();
  return { root, bundle, examples, compact: !Array.isArray(bundle.sourceExamples) };
}

export function validateConstructionRoleGeometryPage(value: unknown, ownerKey: string, hasher: Hasher): asserts value is ConstructionRoleGeometryPage {
  const page = row(value);
  if (!ownerKey || page.ownerKey !== ownerKey || page.kind !== CONSTRUCTION_ROLE_GEOMETRY_KIND || typeof page.digest !== "string"
    || Object.keys(page).sort().join(",") !== "digest,id,kind,ownerKey,payload" || !Array.isArray(page.payload) || !page.payload.length) return fail();
  const keys = page.payload.map(roleJson);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => index > 0 && keys[index - 1]! >= key)) return fail();
  if (page.digest !== pageIdentity(ownerKey, page.payload, hasher) || page.id !== pageId(page.digest)) return fail();
}

/** Store each exact relative role record once per source compilation; observations and their order remain separate. */
export function normalizeConstructionRoleGeometry(values: readonly unknown[], ownerKey: string, hasher: Hasher, maxPageBytes: number): {
  values: unknown[]; pages: ConstructionRoleGeometryPage[];
} {
  if (!ownerKey || !Number.isSafeInteger(maxPageBytes) || maxPageBytes <= 0) return fail();
  const inputs = values.map(value => sourceExamples(value, hasher)), roles = new Map<string, Record<string, JsonValue>>(), roleKeys = new WeakMap<object, string>();
  const keyOf = (value: unknown): string => {
    const role = row(value);
    let key = roleKeys.get(role);
    if (key === undefined) { key = roleJson(role); roleKeys.set(role, key); }
    if (!roles.has(key)) roles.set(key, JSON.parse(key) as Record<string, JsonValue>);
    return key;
  };
  for (const input of inputs) if (input) for (const example of input.examples) for (const field of ["roles", "nullRoles"]) {
    if (!Object.hasOwn(example, field) && field === "nullRoles") continue;
    if (!Array.isArray(example[field])) return fail();
    for (const role of example[field] as unknown[]) keyOf(role);
  }
  const entries = [...roles].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const locations = new Map<string, readonly [number, number]>(), pages: ConstructionRoleGeometryPage[] = [];
  const envelopeBytes = bytes(storageJson({ id: pageId("0".repeat(64)), ownerKey, kind: CONSTRUCTION_ROLE_GEOMETRY_KIND, payload: [], digest: "0".repeat(64) }));
  let payload: Record<string, JsonValue>[] = [], usedBytes = envelopeBytes;
  const flush = () => {
    if (!payload.length) return;
    const digest = pageIdentity(ownerKey, payload, hasher);
    pages.push({ id: pageId(digest), ownerKey, kind: CONSTRUCTION_ROLE_GEOMETRY_KIND, payload, digest });
    payload = []; usedBytes = envelopeBytes;
  };
  for (const [key, value] of entries) {
    const size = bytes(key);
    if (envelopeBytes + size > maxPageBytes) throw Error("construction role exceeds shared page byte budget");
    if (usedBytes + size + (payload.length ? 1 : 0) > maxPageBytes) flush();
    locations.set(key, [pages.length, payload.length]);
    usedBytes += size + (payload.length ? 1 : 0); payload.push(value);
  }
  flush();
  const normalized = inputs.map((input, index) => {
    if (!input) return values[index];
    const used = new Set<number>();
    for (const example of input.examples) for (const field of ["roles", "nullRoles"]) for (const role of (example[field] ?? []) as unknown[]) used.add(locations.get(keyOf(role))![0]);
    const selected = [...used].sort((left, right) => left - right), local = new Map(selected.map((page, index) => [page, index]));
    if (!selected.length) return values[index];
    const examples = input.examples.map(example => Object.fromEntries(Object.entries(example).map(([field, member]) => [field,
      field === "roles" || field === "nullRoles" ? (member as unknown[]).map(role => {
        const [page, ordinal] = locations.get(keyOf(role))!; return [local.get(page)!, ordinal];
      }) : member])));
    return { ...input.root, bundle: { ...input.bundle, sourceExamples: input.compact
      ? encodeConstructionSourceExamples(examples, input.bundle, hasher, { geometry: true }) : examples },
      [CONSTRUCTION_ROLE_GEOMETRY_KEY]: input.compact
        ? { schema: CONSTRUCTION_ROLE_GEOMETRY_COMPACT_REFERENCE_SCHEMA, pages: selected.map(index => pages[index]!.id),
          compact: true, logicalDigest: hasher.digestHex(storageJson({ ...input.bundle, sourceExamples: input.examples })) }
        : { schema: CONSTRUCTION_ROLE_GEOMETRY_REFERENCE_SCHEMA, pages: selected.map(index => pages[index]!.id) } };
  });
  // Compact inline observations already share their local geometry. External pages
  // are worthwhile only when the complete source-owned representation is smaller.
  // Keep the logical raw-array oracle behavior unchanged.
  if (inputs.some(input => input?.compact)
    && bytes(storageJson({ values: normalized, pages })) >= bytes(storageJson({ values, pages: [] }))) {
    return { values: [...values], pages: [] };
  }
  return { values: normalized, pages };
}

export function constructionRoleGeometryPageIds(value: unknown): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, CONSTRUCTION_ROLE_GEOMETRY_KEY)) return [];
  const reference = row((value as Row)[CONSTRUCTION_ROLE_GEOMETRY_KEY]);
  const compact = reference.schema === CONSTRUCTION_ROLE_GEOMETRY_COMPACT_REFERENCE_SCHEMA;
  if ((!compact && reference.schema !== CONSTRUCTION_ROLE_GEOMETRY_REFERENCE_SCHEMA)
    || Object.keys(reference).sort().join(",") !== (compact ? "compact,logicalDigest,pages,schema" : "pages,schema")
    || compact && (typeof reference.compact !== "boolean" || typeof reference.logicalDigest !== "string" || !/^[a-f0-9]{64}$/u.test(reference.logicalDigest))
    || !Array.isArray(reference.pages) || !reference.pages.length || reference.pages.some(id => typeof id !== "string" || !id.startsWith("construction.role_geometry."))
    || new Set(reference.pages).size !== reference.pages.length) return fail();
  return reference.pages as string[];
}

export function createConstructionRoleGeometryRestorer(pagesById: ReadonlyMap<string, ConstructionRoleGeometryPage>, ownerKey: string, hasher: Hasher): (value: unknown) => unknown {
  const validated = new Map<string, readonly string[]>();
  const pageFor = (id: string): readonly string[] => {
    const cached = validated.get(id); if (cached) return cached;
    const page = pagesById.get(id);
    validateConstructionRoleGeometryPage(page, ownerKey, hasher);
    if (page.id !== id) return fail();
    const roles = page.payload.map(roleJson); validated.set(id, roles); return roles;
  };
  return value => restore(value, pageFor, hasher);
}

export function restoreConstructionRoleGeometry(value: unknown, pagesById: ReadonlyMap<string, ConstructionRoleGeometryPage>, ownerKey: string, hasher: Hasher): unknown {
  return createConstructionRoleGeometryRestorer(pagesById, ownerKey, hasher)(value);
}

function restore(value: unknown, pageFor: (id: string) => readonly string[], hasher: Hasher): unknown {
  const ids = constructionRoleGeometryPageIds(value);
  if (!ids.length) return value;
  const root = row(value), { [CONSTRUCTION_ROLE_GEOMETRY_KEY]: _reference, ...logical } = root;
  const input = sourceExamples(logical, hasher, true); if (!input) return fail();
  const pages = ids.map(pageFor);
  const used = new Set<number>();
  const examples = input.examples.map(example => Object.fromEntries(Object.entries(example).map(([field, member]) => {
    if (field !== "roles" && field !== "nullRoles") return [field, member];
    if (!Array.isArray(member)) return fail();
    return [field, member.map(reference => {
      if (!Array.isArray(reference) || reference.length !== 2 || !safeIndex(reference[0]) || !safeIndex(reference[1])) return fail();
      const role = pages[reference[0]]?.[reference[1]];
      if (role === undefined) return fail(); used.add(reference[0]);
      return JSON.parse(role) as Record<string, JsonValue>;
    })];
  })));
  if (used.size !== pages.length) return fail();
  const reference = row(root[CONSTRUCTION_ROLE_GEOMETRY_KEY]);
  if (reference.schema === CONSTRUCTION_ROLE_GEOMETRY_COMPACT_REFERENCE_SCHEMA
    && (input.compact !== reference.compact || hasher.digestHex(storageJson({ ...input.bundle, sourceExamples: examples })) !== reference.logicalDigest)) return fail();
  return { ...logical, bundle: { ...input.bundle, sourceExamples: input.compact
    ? encodeConstructionSourceExamples(examples, input.bundle, hasher) : examples } };
}
