// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_WIKIPEDIA_MAX_ARTICLE_CHARS,
  DEFAULT_WIKIPEDIA_NGRAM_SHARD_CHARS,
  MIN_WIKIPEDIA_MAX_ARTICLE_CHARS,
  effectiveMaxArticleChars,
  effectiveNgramShardChars
} from "../config.js";

// Shard building is lossless only while a shard can hold a whole page, so the config must refuse the reverse.
// Comparing the values as written would have missed the case that matters: ngramShardChars set alone, with
// maxArticleChars left to its 160,000 default, passes a written-value check and then truncates at runtime.
// These pin the comparison to the EFFECTIVE bounds, which is what the ingestor applies.

describe("the effective wikipedia bounds are what decide losslessness", () => {
  it("applies the article default and floor the ingestor applies", () => {
    expect(effectiveMaxArticleChars(undefined)).toBe(DEFAULT_WIKIPEDIA_MAX_ARTICLE_CHARS);
    expect(effectiveMaxArticleChars(1)).toBe(MIN_WIKIPEDIA_MAX_ARTICLE_CHARS);
    expect(effectiveMaxArticleChars(500_000)).toBe(500_000);
  });

  it("applies the shard default the ingestor applies", () => {
    expect(effectiveNgramShardChars(undefined)).toBe(DEFAULT_WIKIPEDIA_NGRAM_SHARD_CHARS);
    expect(effectiveNgramShardChars(800_000)).toBe(800_000);
  });

  it("holds the invariant on the defaults alone, so an unwritten config is still lossless", () => {
    expect(effectiveNgramShardChars(undefined)).toBeGreaterThanOrEqual(effectiveMaxArticleChars(undefined));
  });

  it("catches a shard smaller than a page when only the shard bound is written down", () => {
    // The gap: articleChars is absent from the config but 160,000 at runtime, so a written-value comparison
    // sees `undefined` and lets a 100,000 character shard through to truncate real pages.
    const shardChars = effectiveNgramShardChars(100_000);
    const articleChars = effectiveMaxArticleChars(undefined);
    expect(shardChars).toBe(100_000);
    expect(articleChars).toBe(DEFAULT_WIKIPEDIA_MAX_ARTICLE_CHARS);
    expect(shardChars < articleChars).toBe(true);
  });

  it("catches a page larger than a shard when only the article bound is written down", () => {
    expect(effectiveMaxArticleChars(2_000_000) > effectiveNgramShardChars(undefined)).toBe(true);
  });
});
