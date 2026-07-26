import { describe, expect, it } from "vitest";
import { languageGenerationSurfaceAdequate, type LanguageDiscourseTrace } from "../index.js";

describe("languageGenerationSurfaceAdequate fragment heuristic", () => {
  it("accepts an ordinary sentence containing a hyphenated compound, a time, and a percentage", () => {
    const text = "quiet-hours lighting cue dims library lights to 40% after 9:00 p.m. for lower glare.";
    expect(languageGenerationSurfaceAdequate({ discourse: discourse(text), symbols: text.split(" ") })).toBe(true);
  });

  it("still rejects genuinely disconnected short-fragment output", () => {
    const text = "sym:x | bi:y | z:9 | q:1 | w:2 | e:3 | r:4 invented node edge";
    expect(languageGenerationSurfaceAdequate({ discourse: discourse(text), symbols: text.split(" ") })).toBe(false);
  });
});

function discourse(text: string): LanguageDiscourseTrace {
  return {
    text,
    moves: [],
    boundaries: [],
    steps: [],
    generationStepCount: 1,
    stopReason: "generation_extent",
    requiredTermIdsCovered: [],
    propositionAtomIdsCovered: [],
    scoreOrderTextHash: "",
    anchorCoverage: 1,
    cohesion: 1,
    repetitionPenalty: 0,
    discourseScore: 1,
    fluency: { averageLogProbability: 0, order: 1, backoffRate: 0 } as LanguageDiscourseTrace["fluency"]
  };
}
