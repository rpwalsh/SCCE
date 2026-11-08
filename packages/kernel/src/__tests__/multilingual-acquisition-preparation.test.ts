// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createIdFactory } from "../ids.js";
import { clamp01, createClock, createHasher, weightedJaccard } from "../primitives.js";
import { createMultilingualAcquisitionEngine, type AlignmentPair } from "../multilingual-acquisition.js";
import type { LanguageProfile } from "../types.js";

function acquiredProfiles(count: number): LanguageProfile[] {
  const language = createLanguageAcquisitionEngine({ idFactory: createIdFactory({ clock: createClock(), hasher: createHasher(), namespace: "alignment-preparation", deterministicReplay: true }) });
  const sources = ["λ μ ν ξ. λ μ ξ.", "정류장 센서 안정 신호. 센서 신호.", "محطة حساس مستقر. محطة مستقر.", "const f=(a,b)=>a+b; f(2,3);"];
  return Array.from({ length: count }, (_, index) => language.acquire({ sourceVersionId: `source:${index}` as LanguageProfile["sourceVersionId"],
    text: `${sources[index % sources.length]} ${index}`, createdAt: 1 }));
}

function legacyContinuations(profile: LanguageProfile): string[] {
  const kn = profile.kneserNey as { summary?: { topContinuations?: Array<{ symbol: string }> }; topContinuation?: Array<[string, number]> } | undefined;
  return [...(kn?.summary?.topContinuations?.map(item => item.symbol) ?? []), ...(kn?.topContinuation?.map(item => item[0]) ?? [])].filter(Boolean);
}

function legacyAlignment(left: LanguageProfile, right: LanguageProfile): AlignmentPair {
  const scriptOverlap = weightedJaccard(left.scripts.map(item => item.script), right.scripts.map(item => item.script));
  const shapeOverlap = weightedJaccard(left.symbolShapes.map(item => item.shape), right.symbolShapes.map(item => item.shape));
  const charNgramOverlap = weightedJaccard(left.charNgrams.map(item => item.ngram), right.charNgrams.map(item => item.ngram));
  const continuationOverlap = weightedJaccard(legacyContinuations(left), legacyContinuations(right));
  return { leftProfileId: left.id, rightProfileId: right.id, scriptOverlap, shapeOverlap, charNgramOverlap, continuationOverlap,
    alignment: clamp01(0.28 * scriptOverlap + 0.22 * shapeOverlap + 0.32 * charNgramOverlap + 0.18 * continuationOverlap) };
}

it("reads each acquired profile's ngram inventory a constant number of times rather than once per pair", () => {
  const profiles = acquiredProfiles(24), reads = new Array<number>(profiles.length).fill(0);
  profiles.forEach((profile, index) => {
    const ngrams = profile.charNgrams;
    Object.defineProperty(profile, "charNgrams", { get() { reads[index] = (reads[index] ?? 0) + 1; return ngrams; } });
  });
  const report = createMultilingualAcquisitionEngine().analyze({ text: "λ μ", profiles, evidence: [] });
  expect(report.alignments).toHaveLength(128);
  expect(reads).toEqual(new Array(profiles.length).fill(3));
});

it("preserves every score, duplicate profile position and stable tie order against the original calculation", () => {
  const profiles = acquiredProfiles(18);
  profiles[1]!.id = profiles[0]!.id;
  profiles[2]!.charNgrams.push(...profiles[2]!.charNgrams);
  profiles[3]!.scripts = []; profiles[3]!.symbolShapes = []; profiles[3]!.charNgrams = []; profiles[3]!.kneserNey = {};
  profiles[4]!.scripts = []; profiles[4]!.symbolShapes = []; profiles[4]!.charNgrams = []; profiles[4]!.kneserNey = {};
  profiles[5]!.kneserNey = { summary: { topContinuations: [{ symbol: "λ" }, { symbol: "λ" }] }, topContinuation: [["λ", 1], ["👩🏽‍💻", 2]] };
  const expected: AlignmentPair[] = [];
  for (let left = 0; left < profiles.length; left++) for (let right = left + 1; right < profiles.length; right++) expected.push(legacyAlignment(profiles[left]!, profiles[right]!));
  expected.sort((a, b) => b.alignment - a.alignment);
  const before = structuredClone(profiles), engine = createMultilingualAcquisitionEngine();
  const report = engine.analyze({ text: "λ μ", profiles, evidence: [] });
  expect(JSON.stringify(report.alignments)).toBe(JSON.stringify(expected.slice(0, 128)));
  for (const left of profiles) for (const right of profiles) expect(engine.compareProfiles(left, right)).toEqual(legacyAlignment(left, right));
  expect(profiles).toEqual(before);
});

it("uses fresh source statistics on the next call without mutating an earlier report", () => {
  const profiles = acquiredProfiles(2), engine = createMultilingualAcquisitionEngine();
  const original = engine.analyze({ text: "λ μ", profiles, evidence: [] });
  const before = structuredClone(original);
  profiles[1]!.charNgrams = structuredClone(profiles[0]!.charNgrams);
  profiles[1]!.symbolShapes = structuredClone(profiles[0]!.symbolShapes);
  const changed = engine.analyze({ text: "λ μ", profiles, evidence: [] });
  expect(changed.alignments[0]).toEqual(legacyAlignment(profiles[0]!, profiles[1]!));
  expect(changed.alignments[0]).not.toEqual(original.alignments[0]);
  expect(original).toEqual(before);
});
