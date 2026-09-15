import { describe, expect, it } from "vitest";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import {
  languageRoundTripDeltaFromMismatch,
  persistLanguageRoundTripDelta
} from "../language-round-trip-learning.js";
import { structuralDeltaRealizationFit } from "../language-state-delta.js";
import { evaluateConstructionCycleConsistency } from "../construction-cycle-consistency.js";
import type { LearnedConstruction, LearnedRealization } from "../language-construction.js";
import type { LanguagePatternRecord } from "../storage.js";

describe("language round-trip learning", () => {
  it("turns a measured semantic mismatch into a durable correction that changes cold selection", async () => {
    const intended = "q8 rel 4 z8.";
    const realized = "q8 rel 99 z8.";
    const learned = languageRoundTripDeltaFromMismatch({
      profileId: "profile.round_trip",
      constructionId: "construction.round_trip",
      intendedText: intended,
      realizedText: realized,
      evidenceIds: ["evidence.round_trip"],
      updatedAt: 10
    });
    expect(learned).toBeDefined();
    expect(learned?.structuralDelta).toMatchObject({
      kind: "construction",
      surface: { from: realized, to: intended },
      grammatical: { ruleId: "construction.round_trip" },
      semantic: { fromRoleId: "scce.round_trip.state.realized", toRoleId: "scce.round_trip.state.intended" }
    });
    expect(learned?.mismatchDimensions).toContain("scce.round_trip.dimension.004");
    expect(structuralDeltaRealizationFit(learned!.structuralDelta, realized, intended, {
      constructionId: "construction.round_trip",
      profileId: "profile.round_trip"
    })).toBe(1);
    expect(structuralDeltaRealizationFit(learned!.structuralDelta, "new context", intended, {
      constructionId: "construction.round_trip",
      profileId: "profile.round_trip"
    })).toBe(0);
    expect(structuralDeltaRealizationFit(learned!.structuralDelta, "new context", intended, {
      constructionId: "construction.other",
      profileId: "profile.round_trip"
    })).toBe(0);
    expect(structuralDeltaRealizationFit(learned!.structuralDelta, realized, intended, {
      constructionId: "construction.other",
      profileId: "profile.round_trip"
    })).toBe(0);
    expect(structuralDeltaRealizationFit(learned!.structuralDelta, "new context", intended)).toBe(0);

    const rows = new Map<string, LanguagePatternRecord>();
    const store = {
      putLanguagePattern: async (pattern: LanguagePatternRecord) => { rows.set(pattern.id, pattern); }
    };
    await persistLanguageRoundTripDelta(store, { delta: learned! });

    const coldRuntime = createLanguageMemoryRuntime();
    const coldState = coldRuntime.hydrate({ models: [], patterns: [] });
    const before = coldRuntime.realize({
      state: coldState,
      requestText: realized,
      candidates: [
        { text: realized, fit: 0.5, constructionId: "construction.round_trip", profileId: "profile.round_trip" },
        { text: intended, fit: 0.5, constructionId: "construction.round_trip", profileId: "profile.round_trip" }
      ]
    });
    expect(before.text).toBe(realized);

    const restartedRuntime = createLanguageMemoryRuntime();
    const restartedState = restartedRuntime.hydrate({ models: [], patterns: [...rows.values()] });
    expect(restartedState.structuralDeltas).toHaveLength(1);
    const after = restartedRuntime.realize({
      state: restartedState,
      requestText: realized,
      candidates: [
        { text: realized, fit: 0.5, constructionId: "construction.round_trip", profileId: "profile.round_trip" },
        { text: intended, fit: 0.5, constructionId: "construction.round_trip", profileId: "profile.round_trip" }
      ]
    });
    expect(after.text).toBe(intended);
    expect(after.audit).toMatchObject({ structuralDeltaIdsUsed: [learned!.structuralDelta.id] });
  });

  it("does not reuse a construction correction for a same-surface candidate from another typed scope", () => {
    const learned = languageRoundTripDeltaFromMismatch({
      profileId: "profile.round_trip",
      constructionId: "construction.round_trip",
      contextKey: "frame.subject-object",
      intendedText: "q8 rel 4 z8.",
      realizedText: "q8 rel 99 z8.",
      evidenceIds: ["evidence.round_trip"],
      updatedAt: 10
    });
    expect(learned).toBeDefined();
    expect(learned?.structuralDelta.contextKey).toBe("frame.subject-object");
    expect(structuralDeltaRealizationFit(learned!.structuralDelta, "new context", "q8 rel 4 z8.", {
      constructionId: "construction.round_trip",
      profileId: "profile.round_trip",
      contextKey: "frame.subject-object"
    })).toBe(1);
    expect(structuralDeltaRealizationFit(learned!.structuralDelta, "new context", "q8 rel 4 z8.", {
      constructionId: "construction.round_trip",
      profileId: "profile.round_trip",
      contextKey: "frame.other"
    })).toBe(0);
  });

  it("keeps a production cycle delta bound to its evidence or trace", async () => {
    const outcome = evaluateConstructionCycleConsistency({
      construction: {
        id: "construction.bound",
        profileKey: "profile.round_trip",
        sourceExampleIds: ["source.bound"],
      } as unknown as LearnedConstruction,
      realization: {
        planId: "plan.bound",
        constructionId: "construction.bound",
        text: "q8 rel 99 z8.",
        evidenceIds: ["evidence.bound"],
      } as unknown as LearnedRealization,
      intendedSurface: "q8 rel 4 z8.",
      sourceTraceId: "trace.bound",
      evidenceIds: ["evidence.bound"],
      createdAt: 11
    });
    expect(outcome.languageDelta).toMatchObject({
      sourceTraceId: "trace.bound",
      structuralDelta: { evidenceIds: ["evidence.bound"] },
      pattern: {
        evidenceIds: ["evidence.bound"],
        patternJson: { sourceTraceId: "trace.bound", evidenceIds: ["evidence.bound"] }
      }
    });
    const persisted = new Map<string, LanguagePatternRecord>();
    await persistLanguageRoundTripDelta({
      putLanguagePattern: async pattern => { persisted.set(pattern.id, pattern); }
    }, { delta: outcome.languageDelta! });
    expect([...persisted.values()][0]).toMatchObject({
      evidenceIds: ["evidence.bound"],
      patternJson: { sourceTraceId: "trace.bound", evidenceIds: ["evidence.bound"] }
    });
    expect(languageRoundTripDeltaFromMismatch({
      profileId: "profile.round_trip",
      intendedText: "q8 rel 4 z8.",
      realizedText: "q8 rel 99 z8.",
      updatedAt: 12
    })).toBeUndefined();
  });

  it("does not turn an unscoped sentence mismatch into a durable construction rule", () => {
    expect(languageRoundTripDeltaFromMismatch({
      profileId: "profile.round_trip",
      intendedText: "q8 rel 4 z8.",
      realizedText: "q8 rel 99 z8.",
      evidenceIds: ["evidence.bound"],
      updatedAt: 13
    })).toBeUndefined();
  });
});
