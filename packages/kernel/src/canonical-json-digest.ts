// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalJsonValue, canonicalStringify } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";

export interface CanonicalLeafTokenCache {
  get(record: object): string | undefined;
  set(record: object, token: string): void;
  stats(): { entries: number; retainedBytes: number };
}

/**
 * Bounds retained canonical tokens while allowing one payload traversal to
 * reuse frozen scalar records shared by retained plans and allocations.
 */
export function createCanonicalLeafTokenCache(options: {
  maxEntries?: number;
  maxBytes?: number;
} = {}): CanonicalLeafTokenCache {
  const maxEntries = boundedCacheLimit(options.maxEntries, 65_536, "entry");
  const maxBytes = boundedCacheLimit(options.maxBytes, 16 * 1024 * 1024, "byte");
  const values = new WeakMap<object, string>();
  let entries = 0;
  let retainedBytes = 0;
  return {
    get(record) {
      return values.get(record);
    },
    set(record, token) {
      if (values.has(record)) return;
      // Count a conservative UTF-16 footprint as well as UTF-8 bytes so the
      // cache bound remains meaningful for either V8 string representation.
      const tokenBytes = Math.max(Buffer.byteLength(token, "utf8"), token.length * 2);
      if (entries >= maxEntries || tokenBytes > maxBytes - retainedBytes) return;
      values.set(record, token);
      entries += 1;
      retainedBytes += tokenBytes;
    },
    stats() {
      return { entries, retainedBytes };
    }
  };
}

/** The same canonical bytes and hash, without allocating one full JSON string. */
export function canonicalDigestHex(value: unknown, hasher: Hasher, leafTokenCache?: CanonicalLeafTokenCache): string {
  if (!hasher.digestChunks) return hasher.digestHex(canonicalStringify(value));
  return hasher.digestChunks(canonicalJsonByteChunks(value, leafTokenCache));
}

/** Exact canonical UTF-8 size up to the allowance, without constructing a serialized object or array. */
export function canonicalJsonByteLength(value: unknown, allowance = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isFinite(allowance) || allowance < 0) throw new Error("canonical JSON size allowance must be finite and nonnegative");
  const active = new WeakSet<object>();
  let bytes = 0;
  const count = (input: unknown): void => {
    if (bytes > allowance) return;
    if (input === null || input === undefined) { bytes += 4; return; }
    if (typeof input === "string") { bytes += Buffer.byteLength(JSON.stringify(input.replace(/\u0000/g, " ")), "utf8"); return; }
    if (typeof input === "number") { bytes += Number.isFinite(input) ? String(input).length : 4; return; }
    if (typeof input === "boolean") { bytes += input ? 4 : 5; return; }
    if (typeof input !== "object") { bytes += Buffer.byteLength(JSON.stringify(String(input)), "utf8"); return; }
    if (input instanceof Date) { count(input.toISOString()); return; }
    if (active.has(input)) throw new Error("canonical JSON cannot encode cycles");
    active.add(input);
    bytes += 2;
    if (Array.isArray(input) || input instanceof Uint8Array) {
      for (let index = 0; index < input.length && bytes <= allowance; index++) {
        if (index) bytes++;
        count(input[index]);
      }
    } else {
      let fields = 0;
      for (const key of Object.keys(input)) {
        if (bytes > allowance) break;
        if (fields++) bytes++;
        bytes += Buffer.byteLength(JSON.stringify(key), "utf8");
        bytes++;
        count((input as Record<string, unknown>)[key]);
      }
    }
    active.delete(input);
  };
  count(value);
  return bytes;
}

/**
 * Plain artifact records and arrays are normalized a record at a time, so a
 * retained batch never needs a second full normalized tree beside its data.
 * Special objects/accessors use the existing normalizer. An individual scalar
 * or special object can still exceed the chunk target; this is not a hard limit
 * on arbitrary JavaScript inputs.
 */
export function* canonicalJsonByteChunks(
  value: unknown,
  leafTokenCache?: CanonicalLeafTokenCache
): Iterable<Uint8Array> {
  const pending: string[] = [];
  let pendingCharacters = 0;
  for (const token of canonicalTokens(value, new WeakSet<object>(), leafTokenCache)) {
    pending.push(token);
    pendingCharacters += token.length;
    if (pendingCharacters >= 64 * 1024) {
      // Complete JSON tokens keep UTF-16 surrogate pairs together before UTF-8 encoding.
      yield Buffer.from(pending.join(""), "utf8");
      pending.length = 0;
      pendingCharacters = 0;
    }
  }
  if (pending.length) yield Buffer.from(pending.join(""), "utf8");
}

function* canonicalTokens(
  value: unknown,
  active: WeakSet<object>,
  leafTokenCache?: CanonicalLeafTokenCache
): Generator<string> {
  if (value === null || typeof value !== "object" || value instanceof Date || value instanceof Uint8Array) {
    yield JSON.stringify(canonicalJsonValue(value));
    return;
  }
  if (active.has(value)) throw new Error("canonical JSON cannot encode cycles");
  if (Array.isArray(value)) {
    active.add(value);
    yield "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index) yield ",";
      yield* canonicalTokens(value[index], active, leafTokenCache);
    }
    yield "]";
    active.delete(value);
    return;
  }
  const cached = leafTokenCache?.get(value);
  if (cached !== undefined) {
    yield cached;
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  // Accessors retain the canonical normalizer's eager evaluation contract.
  if (keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(record, key)!, "value"))) {
    yield* jsonTokens(canonicalJsonValue(value));
    return;
  }
  if (keys.every(key => record[key] === null || typeof record[key] !== "object")) {
    const cacheable = leafTokenCache !== undefined && isFrozenScalarDataRecord(value, keys);
    const token = JSON.stringify(canonicalJsonValue(value));
    if (cacheable) leafTokenCache.set(value, token);
    yield token;
    return;
  }
  // JSON.stringify enumerates integer-index keys numerically even when the
  // normalizer inserted them in lexical order. Match that exact byte contract.
  const keyOrder: Record<string, null> = {};
  for (const key of keys) {
    if (key === "__proto__") Object.defineProperty(keyOrder, key, {
      value: null,
      enumerable: true,
      configurable: true,
      writable: true
    });
    else keyOrder[key] = null;
  }
  active.add(value);
  yield "{";
  let index = 0;
  for (const key of Object.keys(keyOrder)) {
    if (index++) yield ",";
    yield JSON.stringify(key);
    yield ":";
    yield* canonicalTokens(record[key], active, leafTokenCache);
  }
  yield "}";
  active.delete(value);
}

function isFrozenScalarDataRecord(value: object, keys: readonly string[]): boolean {
  try {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    if (!Object.isFrozen(value)) return false;
    for (const key of keys) {
      if (key === "__proto__") return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) return false;
      const field = descriptor.value;
      if (field !== null
        && field !== undefined
        && typeof field !== "string"
        && typeof field !== "number"
        && typeof field !== "boolean"
        && typeof field !== "bigint") return false;
    }
    return true;
  } catch {
    // Accessor/proxy edge cases retain the uncached canonical path.
    return false;
  }
}

function* jsonTokens(value: JsonValue | undefined): Generator<string> {
  if (Array.isArray(value)) {
    yield "[";
    for (let index = 0; index < value.length; index += 1) {
      if (index) yield ",";
      // Sparse array holes stringify as null in the existing canonical serializer.
      yield* jsonTokens(value[index]);
    }
    yield "]";
  } else if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    // Marginal/cell records are mostly scalar leaves. Native serialization of
    // one leaf avoids a generator transition for every key and numeric value.
    if (keys.every(key => value[key] === null || typeof value[key] !== "object")) {
      yield JSON.stringify(value);
      return;
    }
    yield "{";
    for (let index = 0; index < keys.length; index += 1) {
      if (index) yield ",";
      const key = keys[index]!;
      yield JSON.stringify(key);
      yield ":";
      yield* jsonTokens(value[key]);
    }
    yield "}";
  } else {
    yield value === undefined ? "null" : JSON.stringify(value);
  }
}

function boundedCacheLimit(value: number | undefined, fallback: number, unit: string): number {
  const limit = value ?? fallback;
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new RangeError(`canonical leaf cache ${unit} bound must be a positive safe integer`);
  }
  return limit;
}
