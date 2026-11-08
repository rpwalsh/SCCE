// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createSourceTextPointCache, sourceTextPointLength, sourceTextPointSlice } from "../source-text-points.js";

describe("trusted source text points", () => {
  it("retains exact Unicode slices while rejecting forged cache handles", () => {
    const cache = createSourceTextPointCache();
    const text = "𐐀e\u0301\u0000月";
    const length = [...text].length;
    expect(sourceTextPointLength(text, cache)).toBe(length);
    expect(sourceTextPointSlice(text, 0, length, cache)).toBe(text);
    expect(sourceTextPointSlice(text, -2, length, cache)).toBe([...text].slice(-2).join(""));
    expect(sourceTextPointSlice(`${text}#`, 0, length + 1, cache)).toBe(`${text}#`);
    expect(() => sourceTextPointLength(text, {} as never)).toThrow("unrecognized");
  });
});
