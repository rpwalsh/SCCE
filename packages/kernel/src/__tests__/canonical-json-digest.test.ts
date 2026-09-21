// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { canonicalDigestHex, canonicalJsonByteChunks } from "../canonical-json-digest.js";
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

  it("preserves custom hashers that only implement the existing digest method", () => {
    const digestHex = vi.fn(() => "custom-digest");
    const input = { z: 2, a: [1, undefined] };
    expect(canonicalDigestHex(input, { digestHex })).toBe("custom-digest");
    expect(digestHex).toHaveBeenCalledExactlyOnceWith(canonicalStringify(input));
  });
});
