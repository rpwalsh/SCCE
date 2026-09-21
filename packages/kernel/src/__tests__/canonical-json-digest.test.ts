// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import {
  canonicalDigestHex,
  canonicalJsonByteChunks,
  createCanonicalLeafTokenCache
} from "../canonical-json-digest.js";
import { canonicalStringify, createHasher } from "../primitives.js";

describe("incremental canonical JSON digests", () => {
  it("preserves the existing canonical bytes for normalization and shared-record edge cases", () => {
    const sparse = new Array<unknown>(4);
    sparse[2] = "astral \u{1f600}, lone \ud800, null \u0000";
    const specialKeys = JSON.parse('{"__proto__":{"x":1},"10":"ten","2":"two","a":null}');
    const shared = Object.freeze({ target: "port", mass: 0, residual: 0.25 });
    const cases = [
      undefined, null, -0, NaN, Infinity, 12345678901234567890n,
      new Uint8Array([0, 127, 255]), new Date("2026-01-01T00:00:00.000Z"),
      sparse, specialKeys,
      { "10": { value: -0 }, "2": [NaN, new Uint8Array([3, 2, 1])], "01": { value: "\u0000" }, nested: specialKeys },
      { fn: function value() { return 1; }, symbol: Symbol("value"), nested: { missing: undefined } },
      { z: undefined, a: [shared, shared], text: "\u{1f600}".repeat(40_000) }
    ];
    const hasher = createHasher();
    for (const value of cases) {
      const canonical = canonicalStringify(value);
      expect(Buffer.concat([...canonicalJsonByteChunks(value)]).toString("utf8")).toBe(canonical);
      expect(canonicalDigestHex(value, hasher)).toBe(hasher.digestHex(canonical));
    }
  });

  it("emits an early chunk without normalizing the rest of a retained batch", () => {
    let tailReads = 0;
    const value = {
      records: Array.from({ length: 4_000 }, (_, index) => ({ id: index, label: "record".repeat(10) })),
      tail: { get label() { tailReads += 1; return "last"; } }
    };
    const iterator = canonicalJsonByteChunks(value)[Symbol.iterator]();
    const first = iterator.next();
    expect(first.done).toBe(false);
    expect(tailReads).toBe(0);
    const remaining: Uint8Array[] = [];
    for (let next = iterator.next(); !next.done; next = iterator.next()) remaining.push(next.value);
    expect(tailReads).toBe(1);
    expect(Buffer.concat([first.value!, ...remaining]).toString("utf8")).toBe(canonicalStringify(value));
  });

  it("rejects cyclic data while allowing repeated immutable records", () => {
    const cyclic: { child?: unknown } = {};
    cyclic.child = cyclic;
    expect(() => canonicalDigestHex(cyclic, createHasher())).toThrow("canonical JSON cannot encode cycles");
  });

  it("hashes a multi-chunk retained-plan shape with the same full-content digest", () => {
    const shared = Object.freeze({ implicitType: "unmatched", targetMass: 0.125, transportedMass: 0, residual: 0.125 });
    const value = { hypotheses: Array.from({ length: 8 }, (_, rank) => ({
      rank, columns: Array.from({ length: 512 }, (_, index) => ({ graphTargetId: String(index), ...shared }))
    })) };
    const chunks = [...canonicalJsonByteChunks(value)];
    expect(chunks.length).toBeGreaterThan(1);
    const hasher = createHasher();
    expect(canonicalDigestHex(value, hasher)).toBe(hasher.digestHex(canonicalStringify(value)));
  });

  it("reuses only bounded frozen scalar records without changing canonical bytes", () => {
    const shared = Object.freeze({ graphTargetId: "target.shared", mass: 0.25, residual: 0 });
    const nullPrototype = Object.freeze(Object.assign(Object.create(null), {
      graphTargetId: "target.null-prototype",
      mass: 0.125,
      residual: 0
    }));
    const mutable = { graphTargetId: "target.mutable", mass: 0.5, residual: 0 };
    let accessorTarget = "target.accessor";
    const accessor = Object.freeze({
      get graphTargetId() { return accessorTarget; },
      mass: 0.75,
      residual: 0
    });
    const value = { records: [shared, shared, nullPrototype, nullPrototype, mutable, accessor] };
    const cache = createCanonicalLeafTokenCache({ maxEntries: 8, maxBytes: 1024 });
    const uncached = Buffer.concat([...canonicalJsonByteChunks(value)]).toString("utf8");
    const cached = Buffer.concat([...canonicalJsonByteChunks(value, cache)]).toString("utf8");

    expect(cached).toBe(uncached);
    expect(cache.stats().entries).toBe(2);
    expect(cache.stats().retainedBytes).toBeLessThanOrEqual(1024);

    mutable.graphTargetId = "target.mutable.changed";
    accessorTarget = "target.accessor.changed";
    const changed = Buffer.concat([...canonicalJsonByteChunks(value, cache)]).toString("utf8");
    expect(changed).toBe(canonicalStringify(value));
    expect(changed).toContain("target.mutable.changed");
    expect(changed).toContain("target.accessor.changed");
    expect(cache.stats().entries).toBe(2);
  });

  it("admits no token beyond the hard byte or entry bound", () => {
    const records = Array.from({ length: 4 }, (_, index) => Object.freeze({
      id: index,
      text: "x".repeat(40)
    }));
    const cache = createCanonicalLeafTokenCache({ maxEntries: 2, maxBytes: 16 });
    const expected = canonicalStringify({ records });
    const actual = Buffer.concat([...canonicalJsonByteChunks({ records }, cache)]).toString("utf8");

    expect(actual).toBe(expected);
    expect(cache.stats().entries).toBe(0);
    expect(cache.stats().retainedBytes).toBe(0);

    const entryLimited = createCanonicalLeafTokenCache({ maxEntries: 2, maxBytes: 16 * 1024 });
    const entryLimitedActual = Buffer.concat([
      ...canonicalJsonByteChunks({ records }, entryLimited)
    ]).toString("utf8");
    expect(entryLimitedActual).toBe(expected);
    expect(entryLimited.stats().entries).toBe(2);
    expect(entryLimited.stats().retainedBytes).toBeLessThanOrEqual(16 * 1024);
  });

  it("keeps cached edge-value bytes and hashes identical across repeated traversals", () => {
    const leaf = Object.freeze({
      negativeZero: -0,
      notANumber: NaN,
      positiveInfinity: Infinity,
      missing: undefined
    });
    const value = { leaves: [leaf, leaf] };
    const canonical = canonicalStringify(value);
    const cache = createCanonicalLeafTokenCache();
    const hasher = createHasher();
    const first = Buffer.concat([...canonicalJsonByteChunks(value, cache)]);
    const second = Buffer.concat([...canonicalJsonByteChunks(value, cache)]);

    expect(first.toString("utf8")).toBe(canonical);
    expect(second.toString("utf8")).toBe(canonical);
    if (!hasher.digestChunks) throw new Error("fixture requires the streaming hasher");
    expect(hasher.digestChunks(canonicalJsonByteChunks(value, cache))).toBe(hasher.digestHex(canonical));
    expect(cache.stats().entries).toBe(1);
  });

  it("benchmarks a bounded shared-leaf microfixture without a corpus run", () => {
    const shared = Array.from({ length: 2_000 }, (_, index) => Object.freeze({
      graphTargetId: `target.${index}`,
      implicitType: "unmatched",
      targetMass: index / 10,
      transportedMass: 0,
      graphImplicitMass: index / 20,
      overflowMass: 0,
      residual: 0
    }));
    const records = Array.from({ length: 16_000 }, (_, index) => shared[index % shared.length]);
    const value = { records };
    const bytes = (cache?: ReturnType<typeof createCanonicalLeafTokenCache>): Uint8Array =>
      Buffer.concat([...canonicalJsonByteChunks(value, cache)]);
    const baselineStart = process.hrtime.bigint();
    const baseline = bytes();
    const baselineMs = Number(process.hrtime.bigint() - baselineStart) / 1e6;
    const cache = createCanonicalLeafTokenCache();
    const cachedStart = process.hrtime.bigint();
    const cached = bytes(cache);
    const cachedMs = Number(process.hrtime.bigint() - cachedStart) / 1e6;

    expect(Buffer.compare(cached, baseline)).toBe(0);
    expect(cache.stats().entries).toBe(2_000);
    expect(cache.stats().retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    console.log(JSON.stringify({
      fixtureRecords: records.length,
      uniqueSharedLeaves: shared.length,
      baselineMs,
      cachedMs,
      cache: cache.stats()
    }));
  });

  it("preserves custom hashers that only implement the existing digest method", () => {
    const digestHex = vi.fn(() => "custom-digest");
    const input = { z: 2, a: [1, undefined] };
    expect(canonicalDigestHex(input, { digestHex })).toBe("custom-digest");
    expect(digestHex).toHaveBeenCalledExactlyOnceWith(canonicalStringify(input));
  });
});
