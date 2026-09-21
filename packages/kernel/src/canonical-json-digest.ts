// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalJsonValue, canonicalStringify } from "./primitives.js";
import type { Hasher, JsonValue } from "./types.js";

/** The same canonical bytes and hash, without allocating one full JSON string. */
export function canonicalDigestHex(value: unknown, hasher: Hasher): string {
  if (!hasher.digestChunks) return hasher.digestHex(canonicalStringify(value));
  return hasher.digestChunks(canonicalJsonByteChunks(value));
}

/**
 * Plain artifact records and arrays are normalized a record at a time, so a
 * retained batch never needs a second full normalized tree beside its data.
 * Special objects/accessors use the existing normalizer. An individual scalar
 * or special object can still exceed the chunk target; this is not a hard limit
 * on arbitrary JavaScript inputs.
 */
export function* canonicalJsonByteChunks(value: unknown): Iterable<Uint8Array> {
  const pending: string[] = [];
  let pendingCharacters = 0;
  for (const token of canonicalTokens(value, new WeakSet<object>())) {
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

function* canonicalTokens(value: unknown, active: WeakSet<object>): Generator<string> {
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
      yield* canonicalTokens(value[index], active);
    }
    yield "]";
    active.delete(value);
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  // Preserve the old normalizer's special __proto__ assignment behavior and
  // eager evaluation for accessor-bearing records. Durable artifact data has
  // ordinary own data properties, and does not take this compatibility path.
  if (keys.includes("__proto__") || keys.some(key => !Object.hasOwn(Object.getOwnPropertyDescriptor(record, key)!, "value"))) {
    yield* jsonTokens(canonicalJsonValue(value));
    return;
  }
  if (keys.every(key => record[key] === null || typeof record[key] !== "object")) {
    yield JSON.stringify(canonicalJsonValue(value));
    return;
  }
  // JSON.stringify enumerates integer-index keys numerically even when the
  // normalizer inserted them in lexical order. Match that exact byte contract.
  const keyOrder: Record<string, null> = {};
  for (const key of keys) keyOrder[key] = null;
  active.add(value);
  yield "{";
  let index = 0;
  for (const key of Object.keys(keyOrder)) {
    if (index++) yield ",";
    yield JSON.stringify(key);
    yield ":";
    yield* canonicalTokens(record[key], active);
  }
  yield "}";
  active.delete(value);
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
