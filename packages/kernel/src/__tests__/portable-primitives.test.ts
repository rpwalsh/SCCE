// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createHasher, randomHex } from "../primitives.js";

describe("portable canonical primitives", () => {
  it("keeps SHA-256 identities byte-for-byte equal to the native implementation", () => {
    const portable = createHasher();
    for (const value of ["", "abc", "SCCE ðŸ§  e\u0301", "unpaired \ud800 tail"]) {
      const expected = createHash("sha256").update(value, "utf8").digest("hex");
      expect(portable.digestHex(value)).toBe(expected);
    }
    const bytes = Uint8Array.from([0, 1, 2, 127, 128, 255]);
    expect(portable.digestHex(bytes)).toBe(
      createHash("sha256").update(bytes).digest("hex")
    );
  });

  it("hashes chunk streams as the exact concatenated bytes", () => {
    const chunks = [
      Uint8Array.from([0, 1]),
      new Uint8Array(),
      Uint8Array.from([2, 255])
    ];
    const expected = createHash("sha256");
    for (const chunk of chunks) expected.update(chunk);
    expect(createHasher().digestChunks?.(chunks)).toBe(expected.digest("hex"));
  });

  it("uses the platform cryptographic generator with a bounded byte contract", () => {
    expect(randomHex(12)).toMatch(/^[a-f0-9]{24}$/u);
    expect(randomHex(0)).toBe("");
    expect(() => randomHex(-1)).toThrow("random byte count");
    expect(() => randomHex(65_537)).toThrow("random byte count");
  });
});
