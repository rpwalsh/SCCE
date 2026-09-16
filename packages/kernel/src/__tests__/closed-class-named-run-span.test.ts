// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { requestClosedClassWords } from "../closed-class-words.js";
import { clearCorpusIdentitySignals } from "../corpus-identity.js";
import { namedSubjectAnchors } from "../kernel-answer-primitives.js";
import type { LanguageContinuationPopulation, LanguagePatternRecord } from "../storage.js";

afterEach(() => clearCorpusIdentitySignals());

/**
 * Before any corpus identity is primed -- the first turn of a run, and every turn whose language memory did not
 * warm -- a named run can span the request whole. Deleting that run's words then deleted the corpus ranking's own
 * verdict along with the subject, and the request kept every word as content.
 *
 * Live measurement behind the numbers below: the selected language identity holds 457 models and 92,989 word
 * types; "is" ranks 30, "which" 51, "when" 63, "what" 71, "who" 78 -- all inside closed_class.rank_limit -- while
 * "mercury" ranks far outside it.
 */
const population = fixturePopulation(["is", "what", "who"], ["mercury", "lovelace", "ada"]);
const patterns = [requestPattern("what", "factual"), requestPattern("who", "factual"), requestPattern("ada", "factual"), requestPattern("lovelace", "factual")];

describe("a named run spanning the request does not delete the corpus closed class", () => {
  it("keeps the units the corpus ranks closed and still drops the subject it names", () => {
    // The precondition: with no primed corpus signal the whole request reads as one named run.
    expect(namedSubjectAnchors("What is Mercury?")).toEqual(["what is mercury"]);

    const closed = requestClosedClassWords({ requestText: "What is Mercury?", continuationPopulation: population, patterns, authority: "factual" });
    expect(closed.has("what")).toBe(true);
    expect(closed.has("mercury")).toBe(false);
  });

  it("still refuses to discount a named subject the corpus does not rank closed", () => {
    // The rule this guard was written for: the request corpus teaches its frames with real subjects in them, and
    // those subjects arrive as scaffolding literals. A subject outside the corpus closed class is still deleted.
    const closed = requestClosedClassWords({ requestText: "Who is Ada Lovelace?", continuationPopulation: population, patterns, authority: "factual" });
    expect(closed.has("who")).toBe(true);
    expect(closed.has("ada")).toBe(false);
    expect(closed.has("lovelace")).toBe(false);
  });
});

function fixturePopulation(closed: readonly string[], open: readonly string[]): LanguageContinuationPopulation {
  const continuationCounts: Record<string, number> = {};
  for (let index = 0; index < 192; index += 1) {
    const first = String.fromCharCode(97 + Math.floor(index / 26));
    const second = String.fromCharCode(97 + (index % 26));
    continuationCounts[`fixture${first}${second}`] = 10_000 - index;
  }
  for (let index = 0; index < closed.length; index += 1) continuationCounts[closed[index]!] = 20_000 - index;
  for (const unit of open) continuationCounts[unit] = 1;
  return { languageId: "language.corpus", modelCount: 457, continuationCounts };
}

function requestPattern(surface: string, selectedAuthority: string): LanguagePatternRecord {
  return {
    id: `request_requirement_pattern_${surface}`,
    profileId: "profile.requests",
    patternJson: { schema: "scce.request_requirement_pattern.v1", surface, selectedAuthority }
  } as unknown as LanguagePatternRecord;
}
