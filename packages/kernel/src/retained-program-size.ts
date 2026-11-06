// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

const WORD_BYTES = Float64Array.BYTES_PER_ELEMENT;

/**
 * Conservative content accounting for hydrated program graphs. Unlike JSON serialization this visits shared
 * objects once, includes Map/Set contents, and never materializes a second tree or a giant serialized string.
 * The allowance is an operational estimate, not a claim about a particular engine's object layout. Stop as soon
 * as a caller's allowance is exceeded: an oversized entry will not be retained, so its exact size is immaterial.
 */
export function estimateRetainedProgramBytes(roots: Iterable<unknown>, allowance = Number.MAX_SAFE_INTEGER): number {
  const seen = new WeakSet<object>();
  const stack: Iterator<unknown>[] = [roots[Symbol.iterator]()];
  let bytes = 0;
  function* children(value: object): Generator<unknown> {
    if (ArrayBuffer.isView(value)) { yield value.buffer; return; }
    if (value instanceof ArrayBuffer) { bytes += value.byteLength; return; }
    if (value instanceof Map) {
      for (const [key, entry] of value) { bytes += 2 * WORD_BYTES; yield key; yield entry; }
      return;
    }
    if (value instanceof Set || Array.isArray(value)) {
      for (const entry of value) { bytes += WORD_BYTES; yield entry; }
      return;
    }
    for (const key in value) {
      if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
      bytes += key.length * 2 + WORD_BYTES;
      yield (value as Record<string, unknown>)[key];
    }
  }
  while (stack.length && bytes <= allowance) {
    const next = stack[stack.length - 1]!.next();
    if (next.done) { stack.pop(); continue; }
    const value = next.value;
    if (typeof value === "string") { bytes += value.length * 2; continue; }
    if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") { bytes += WORD_BYTES; continue; }
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    seen.add(value);
    bytes += 3 * WORD_BYTES;
    stack.push(children(value));
  }
  return bytes;
}
