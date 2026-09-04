// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { buildLanguageProfile } from "../multilingual-translation.js";
import { reverseLexicalAlignment, validateTranslationRoundTrip } from "../translation-round-trip-gate.js";
import type { LexicalAlignmentRecord } from "../multilingual-translation.js";

// Plan items 124-125: real translation-quality round-trip validation and
// a hard factual gate, specific to the translation path. Every scenario
// below runs the real buildTranslationPlan (Realize/Interpret) and the
// real factualRoundTripGate end to end -- fixtures were verified against
// the actual real output (not assumed) before being locked into
// assertions, matching this session's established diagnostic-script
// discipline for atomizeText's known sentence-parsing quirks.

describe("reverseLexicalAlignment", () => {
  it("mechanically swaps source and target throughout, including every lexical pair", () => {
    const forward: LexicalAlignmentRecord = {
      id: "a1", kind: "lexical", sourceText: "cat", targetText: "chat",
      sourceProfileId: "en", targetProfileId: "fr", evidenceIds: [], score: 0.9, alpha: 0.9, createdAt: 0,
      lexicalPairs: [{ source: "cat", target: "chat", score: 0.9 }, { source: "mat", target: "tapis", score: 0.8 }]
    };
    const reversed = reverseLexicalAlignment(forward);
    expect(reversed.sourceText).toBe("chat");
    expect(reversed.targetText).toBe("cat");
    expect(reversed.sourceProfileId).toBe("fr");
    expect(reversed.targetProfileId).toBe("en");
    expect(reversed.lexicalPairs).toEqual([{ source: "chat", target: "cat", score: 0.9 }, { source: "tapis", target: "mat", score: 0.8 }]);
    expect(reversed.id).not.toBe(forward.id);
  });
});

describe("validateTranslationRoundTrip (plan items 124-125)", () => {
  it("accepts a real round trip through a well-covered vocabulary (item 124: A -> Realize -> y -> Interpret -> Ahat)", () => {
    const sourceText = "the cat sat on the mat";
    const sourceProfile = buildLanguageProfile(sourceText, "en");
    const targetProfile = buildLanguageProfile("le chat assis sur le tapis", "fr");
    const alignments: LexicalAlignmentRecord[] = [{
      id: "a1", kind: "lexical", sourceText, targetText: "le chat assis sur le tapis",
      sourceProfileId: sourceProfile.id, targetProfileId: targetProfile.id, evidenceIds: [], score: 0.9, alpha: 0.9, createdAt: 0,
      lexicalPairs: [
        { source: "the", target: "le", score: 0.9 },
        { source: "cat", target: "chat", score: 0.9 },
        { source: "sat", target: "assis", score: 0.9 },
        { source: "on", target: "sur", score: 0.9 },
        { source: "mat", target: "tapis", score: 0.9 }
      ]
    }];

    const result = validateTranslationRoundTrip({ sourceText, sourceProfile, targetProfile, lexicalAlignments: alignments });

    expect(result.targetText).toBe(result.forwardPlan.targetText);
    expect(result.backTranslatedText).toBe(result.interpretedPlan.targetText);
    expect(result.gate.accepted).toBe(true);
    expect(result.gate.cycleTrace.distance.added).toEqual([]);
    expect(result.gate.cycleTrace.intendedText).toBe(sourceText);
    expect(result.gate.cycleTrace.realizedText).toBe(result.backTranslatedText);
  });

  it("rejects outright when a real corrupted alignment smuggles an unrelated clause into the round trip (item 125: hard gate, not a soft penalty)", () => {
    const sourceText = "alice ships 42 crates to boston.";
    const sourceProfile = buildLanguageProfile(sourceText, "en");
    const targetProfile = buildLanguageProfile("alice envoie 42 caisses a boston.", "fr");
    // The "boston" entry is a poisoned alignment record: instead of a real
    // translation, it maps to a multi-word string that smuggles in an
    // entirely new, unrelated sentence -- standing in for a corrupted
    // alignment (e.g. noisy training data), a real failure mode this gate
    // must catch.
    const alignments: LexicalAlignmentRecord[] = [{
      id: "a1", kind: "lexical", sourceText, targetText: "alice envoie 42 caisses a boston.",
      sourceProfileId: sourceProfile.id, targetProfileId: targetProfile.id, evidenceIds: [], score: 0.9, alpha: 0.9, createdAt: 0,
      lexicalPairs: [
        { source: "alice", target: "alice", score: 0.9 },
        { source: "ships", target: "envoie", score: 0.9 },
        { source: "crates", target: "caisses", score: 0.9 },
        { source: "to", target: "a", score: 0.9 },
        { source: "boston", target: "boston. bob invents 7 gadgets.", score: 0.9 }
      ]
    }];

    const result = validateTranslationRoundTrip({ sourceText, sourceProfile, targetProfile, lexicalAlignments: alignments });

    expect(result.gate.accepted).toBe(false);
    expect(result.gate.reason).toMatch(/1 atom/);
    expect(result.gate.cycleTrace.distance.added).toHaveLength(1);
    // The rejection is a hard refusal -- the caller still gets the full
    // real cycle trace to inspect, never a silently swallowed failure.
    expect(result.gate.cycleTrace.atomsA.length).toBeGreaterThan(0);
    expect(result.gate.cycleTrace.atomsAhat.length).toBeGreaterThan(0);
  });
});
