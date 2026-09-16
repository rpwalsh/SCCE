// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { buildLanguageProfileClusters, selectLanguageProfileForSurface } from "../language.js";
import type { LanguageProfile } from "../types.js";
import type { SourceVersionId } from "../types.js";

// Live shape, measured against the running brain: the resident surface cluster carried 382 members and a
// stored profile averages 246 of its 256-cap character trigrams with 20 symbol shapes.
const LIVE_CLUSTER_MEMBERS = 382;
const LIVE_TRIGRAMS_PER_PROFILE = 256;
const LIVE_SHAPES_PER_PROFILE = 20;

const ALPHABET = "abcdefghijklmnopqrstuvwxyz ";

function deterministicProfile(index: number): LanguageProfile {
  const charNgrams: Array<{ ngram: string; count: number }> = [];
  for (let n = 0; n < LIVE_TRIGRAMS_PER_PROFILE; n += 1) {
    const seed = index * 7919 + n * 31;
    const ngram = [0, 1, 2].map(offset => ALPHABET[(seed + offset * 13) % ALPHABET.length]!).join("");
    charNgrams.push({ ngram, count: 1 + ((seed * 17) % 97) });
  }
  const symbolShapes: Array<{ shape: string; count: number }> = [];
  for (let s = 0; s < LIVE_SHAPES_PER_PROFILE; s += 1) {
    symbolShapes.push({ shape: `shape.${(index + s) % 11}`, count: 1 + ((index + s) % 23) });
  }
  return {
    id: `profile.${String(index).padStart(5, "0")}`,
    sourceVersionId: `source.${index}` as SourceVersionId,
    scripts: [{ script: "script:Latn", mass: 1 }],
    symbolShapes,
    charNgrams,
    direction: "ltr",
    entropy: 4.2,
    createdAt: 1,
    artifactSupport: 1 + (index % 5)
  };
}

const liveSizedCluster: readonly LanguageProfile[] = Array.from({ length: LIVE_CLUSTER_MEMBERS }, (_unused, index) => deterministicProfile(index));

function millis(run: () => unknown): number {
  const started = performance.now();
  run();
  return performance.now() - started;
}

describe("language profile clustering cost at live corpus size", () => {
  // The turn runtime clusters the same resident member array on every request, and did it twice per turn.
  // Sort keys computed inside the comparator made each pass O(n log n) JSON serializations of 256 trigrams.
  it("clusters a live-sized resident member set well inside a conversational turn's budget", () => {
    buildLanguageProfileClusters(liveSizedCluster.slice(0, 8));
    const elapsedMs = millis(() => buildLanguageProfileClusters(liveSizedCluster));
    expect(elapsedMs).toBeLessThan(250);
  });

  it("selects a surface profile from a live-sized cluster well inside a conversational turn's budget", () => {
    selectLanguageProfileForSurface(liveSizedCluster.slice(0, 8), "warmup surface");
    const elapsedMs = millis(() => selectLanguageProfileForSurface(liveSizedCluster, "the pump feed reads high"));
    expect(elapsedMs).toBeLessThan(250);
  });

  it("clusters members in an order that does not depend on the order they arrive in", () => {
    const forward = buildLanguageProfileClusters(liveSizedCluster);
    const reversed = buildLanguageProfileClusters([...liveSizedCluster].reverse());
    expect(reversed.map(cluster => cluster.id)).toStrictEqual(forward.map(cluster => cluster.id));
  });
});
