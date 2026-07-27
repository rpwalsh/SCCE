import { describe, expect, it } from "vitest";
import { buildVoiceProfile, checkAntiCopyGuard, type VoiceSample } from "../voice-profile.js";

describe("persistent voice representation (plan item 225)", () => {
  it("derives cadence, lexical distribution, viewpoint, and rhetorical habits from real samples, with provenance", () => {
    const samples: VoiceSample[] = [
      {
        sourceId: "journal.1",
        text: "I walked to the store (it was raining, of course). I bought bread and milk. I wondered if this was really worth it."
      },
      {
        sourceId: "journal.2",
        text: "I sat by the window (the light was fading fast) and I read my old letters. I missed the sound of the city."
      }
    ];
    const profile = buildVoiceProfile(samples);

    expect(profile.viewpoint).toBe("first_person");
    expect(profile.rhetoricalHabits).toContain("frequent_parenthetical_asides");
    expect(profile.cadence.averageSentenceLength).toBeGreaterThan(0);
    expect(profile.lexicalDistribution["i"]).toBeGreaterThan(0);
    expect(profile.provenance.sourceIds).toEqual(["journal.1", "journal.2"]);
    expect(profile.provenance.sampleCount).toBe(2);
  });

  it("reports a genuinely mixed viewpoint honestly rather than forcing a single dominant one", () => {
    const samples: VoiceSample[] = [
      { sourceId: "s1", text: "I think you should see it. You will understand once I show you." }
    ];
    const profile = buildVoiceProfile(samples);
    expect(profile.viewpoint).toBe("mixed");
  });

  it("two different sample sets produce two different profiles -- this is derived, not a fixed hand-authored description", () => {
    const first = buildVoiceProfile([{ sourceId: "a", text: "He walked. He talked. He left." }]);
    const second = buildVoiceProfile([{ sourceId: "b", text: "I ran far and wide across every hill I could find, wondering all the while." }]);
    expect(first.viewpoint).toBe("third_person");
    expect(second.viewpoint).toBe("first_person");
    expect(first.cadence.averageSentenceLength).not.toBe(second.cadence.averageSentenceLength);
  });

  it("rejects an empty sample set rather than fabricating a default voice", () => {
    expect(() => buildVoiceProfile([])).toThrow(/at least one sample/);
  });
});

describe("anti-copy guard: voice generalizes without reproducing a protected passage (plan item 226)", () => {
  const protectedPassages: VoiceSample[] = [
    { sourceId: "protected.1", text: "The quick brown fox jumps over the lazy dog everyday without fail." }
  ];
  const maxAllowedNgramWords = 4;

  it("flags generated text that reproduces more than the allowed n-gram threshold verbatim", () => {
    const generated = "Yesterday, the quick brown fox jumps over the lazy dog and then ran away laughing.";
    const result = checkAntiCopyGuard(generated, protectedPassages, maxAllowedNgramWords);
    expect(result.violatesProtectedSpan).toBe(true);
    expect(result.matchedSourceId).toBe("protected.1");
    expect(result.matchedLength).toBeGreaterThan(maxAllowedNgramWords);
  });

  it("does not flag genuinely novel content that merely echoes the voice's style", () => {
    const generated = "The energetic auburn wolf leaps across the sleepy cat regularly, without hesitation.";
    const result = checkAntiCopyGuard(generated, protectedPassages, maxAllowedNgramWords);
    expect(result.violatesProtectedSpan).toBe(false);
  });

  it("tolerates a short shared phrase at or below the allowed threshold", () => {
    // Shares only "over the lazy dog" (4 words) with the protected passage
    // -- at the threshold, not beyond it.
    const generated = "My neighbor's cat leapt over the lazy dog before scurrying off.";
    const result = checkAntiCopyGuard(generated, protectedPassages, maxAllowedNgramWords);
    expect(result.violatesProtectedSpan).toBe(false);
  });

  it("is case- and whitespace-insensitive -- a copy dressed up with different capitalization still counts", () => {
    const generated = "THE   QUICK BROWN fox JUMPS over THE lazy DOG appeared suddenly.";
    const result = checkAntiCopyGuard(generated, protectedPassages, maxAllowedNgramWords);
    expect(result.violatesProtectedSpan).toBe(true);
  });

  it("checks every protected passage, not just the first", () => {
    const passages: VoiceSample[] = [
      { sourceId: "p1", text: "Completely unrelated content about mountains and rivers flowing gently downstream." },
      { sourceId: "p2", text: "A secret recipe involves three cups of flour and two eggs mixed slowly together." }
    ];
    const generated = "She whispered that a secret recipe involves three cups of flour and two eggs, then smiled.";
    const result = checkAntiCopyGuard(generated, passages, 4);
    expect(result.violatesProtectedSpan).toBe(true);
    expect(result.matchedSourceId).toBe("p2");
  });
});
