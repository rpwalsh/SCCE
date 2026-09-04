// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createStringMemo } from "../pure-memo.js";
import { featureSet } from "../primitives.js";
import { tidySurfaceText } from "../surface-linguistics.js";

describe("bounded string memo", () => {
  it("computes once per distinct key and serves repeats from cache", () => {
    let calls = 0;
    const memo = createStringMemo(text => { calls++; return text.toUpperCase(); }, { maxEntries: 8, maxKeyChars: 64, maxTotalChars: 1024 });
    expect(memo("a")).toBe("A");
    expect(memo("a")).toBe("A");
    expect(memo("a")).toBe("A");
    expect(calls).toBe(1);
    expect(memo.stats()).toMatchObject({ hits: 2, misses: 1 });
  });

  it("caches a falsy result rather than recomputing it every time", () => {
    // "" is the tidied form of any all-whitespace surface, which the turn
    // produces constantly; a truthiness check for cache membership would
    // recompute exactly the cheapest-to-cache case forever.
    let calls = 0;
    const memo = createStringMemo(() => { calls++; return ""; }, { maxEntries: 8, maxKeyChars: 64, maxTotalChars: 1024 });
    memo("   ");
    memo("   ");
    expect(calls).toBe(1);
  });

  it("evicts the least recently used entry past the entry bound", () => {
    let calls = 0;
    const memo = createStringMemo(text => { calls++; return text; }, { maxEntries: 2, maxKeyChars: 64, maxTotalChars: 1024 });
    memo("a"); memo("b");
    memo("a");            // refreshes "a", so "b" is now least recent
    memo("c");            // evicts "b"
    expect(memo.stats().entries).toBe(2);
    memo("a");
    expect(calls).toBe(3); // a, b, c -- "a" never recomputed
    memo("b");
    expect(calls).toBe(4); // "b" was evicted, so it recomputes
  });

  it("bounds retained characters, not just entry count", () => {
    // The resident language-memory cache OOMed precisely because an
    // entry-count bound says nothing about bytes held.
    const memo = createStringMemo(text => text, { maxEntries: 1000, maxKeyChars: 1000, maxTotalChars: 100 });
    for (let index = 0; index < 50; index++) memo("x".repeat(20) + index);
    expect(memo.stats().chars).toBeLessThanOrEqual(100);
    expect(memo.stats().entries).toBeLessThan(50);
  });

  it("declines to cache an oversized input instead of evicting everything for it", () => {
    const memo = createStringMemo(text => text.length, { maxEntries: 8, maxKeyChars: 10, maxTotalChars: 1024 });
    memo("small");
    memo("x".repeat(500));
    memo("x".repeat(500));
    expect(memo.stats().uncacheable).toBe(2);
    expect(memo.stats().entries).toBe(1); // "small" survived
  });
});

describe("memoized transforms keep their semantics", () => {
  it("tidySurfaceText returns identical output on repeat calls", () => {
    const samples = ["  Ada   Lovelace  wrote   notes..  ", "東京 に  行く。。", "", "   ", "A (b) \"c\" d!!"];
    for (const sample of samples) {
      const first = tidySurfaceText(sample);
      expect(tidySurfaceText(sample)).toBe(first);
    }
    expect(tidySurfaceText("  Ada   Lovelace  wrote   notes..  ")).toBe("Ada Lovelace wrote notes.");
  });

  it("featureSet hands every caller its own array", () => {
    // Cached arrays must never be shared: a caller that sorts or splices the
    // result would silently corrupt every later caller's features.
    const first = featureSet("Ada Lovelace");
    const second = featureSet("Ada Lovelace");
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    first.push("mutated");
    expect(featureSet("Ada Lovelace")).not.toContain("mutated");
  });

  it("featureSet keys on the limit, not just the text", () => {
    const wide = featureSet("Ada Lovelace wrote the notes", 2000);
    const narrow = featureSet("Ada Lovelace wrote the notes", 3);
    expect(narrow).toHaveLength(3);
    expect(wide.length).toBeGreaterThan(narrow.length);
  });
});
