// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createCorrectionMemory } from "../correction-memory.js";
import { createHasher, createClock } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { decayCorrectionAlpha, detectConflictingCorrections } from "../translation-correction-engine.js";
import type { CorrectionRuleRecord } from "../storage.js";

const clock = createClock({ fixedTime: 1_000, stepMs: 1 });
const hasher = createHasher();
const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "correction-conflict" });

function rule(id: string, pattern: string, replacement: string, weight: number, updatedAt: number): CorrectionRuleRecord {
  return {
    id,
    episodeId: idFactory.episodeId(),
    ruleKind: "terminology_preference",
    scope: "conversation.fixture",
    pattern,
    replacement,
    weight,
    contextJson: {},
    provenanceJson: {},
    createdAt: updatedAt,
    updatedAt
  };
}

describe("corrections age and can contradict each other", () => {
  it("ranks a recent correction above an older one that was recorded with more weight", () => {
    const memory = createCorrectionMemory({ idFactory, hasher });
    const now = Date.now();
    const week = 7 * 24 * 60 * 60 * 1000;
    const old = rule("rule.old", "pump", "bomba", 0.9, now - 8 * week);
    const recent = rule("rule.recent", "valve", "valvula", 0.5, now);

    const ranked = memory.retrieve({ rules: [old, recent] });

    expect(ranked.map(item => item.id)).toEqual(["rule.recent", "rule.old"]);
    expect(decayCorrectionAlpha({ alpha: old.weight, createdAt: old.updatedAt }, now)).toBeLessThan(recent.weight);
  });

  it("names two instructions that render the same term differently", () => {
    const conflicts = detectConflictingCorrections([
      { id: "rule.a", changedTerms: [{ original: "pump", corrected: "bomba", reason: "terminology_preference" }] },
      { id: "rule.b", changedTerms: [{ original: "Pump", corrected: "bomba de agua", reason: "terminology_preference" }] }
    ]);

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ correctionIdA: "rule.a", correctionIdB: "rule.b", term: "pump" });
  });

  it("does not call two instructions a conflict when they agree", () => {
    expect(detectConflictingCorrections([
      { id: "rule.a", changedTerms: [{ original: "pump", corrected: "bomba", reason: "terminology_preference" }] },
      { id: "rule.b", changedTerms: [{ original: "pump", corrected: "Bomba", reason: "terminology_preference" }] }
    ])).toEqual([]);
  });
});
