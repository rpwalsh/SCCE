// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { buildLanguageProfile, buildTranslationPlan, type LexicalAlignmentRecord } from "../multilingual-translation.js";
import { validateTranslationRoundTrip } from "../translation-round-trip-gate.js";

it.each([
  ["ψ μ ψ? 42\tψ.", "λ ν λ? 42\tλ.", [["ψ", "λ"], ["μ", "ν"]]],
  ["猫 猫，犬！", "犬 犬，猫！", [["猫", "犬"], ["犬", "猫"]]]
])("preserves every source occurrence and separator through real lexical realization: %s", (source, target, pairs) => {
  const sourceText = source as string, targetText = target as string;
  const sourceProfile = buildLanguageProfile(sourceText), targetProfile = buildLanguageProfile(targetText);
  const alignment: LexicalAlignmentRecord = {
    id: "observed-pair", kind: "lexical", sourceText, targetText,
    sourceProfileId: sourceProfile.id, targetProfileId: targetProfile.id,
    evidenceIds: [], score: 1, alpha: 1, createdAt: 0,
    lexicalPairs: (pairs as string[][]).map(([source, target]) => ({ source: source!, target: target!, score: 1 }))
  };
  const plan = buildTranslationPlan(sourceText, sourceProfile, targetProfile, [alignment]);
  expect(plan.targetText).toBe(targetText);
  expect(plan.alignmentCoverage).toBe(1);
  const roundTrip = validateTranslationRoundTrip({ sourceText, sourceProfile, targetProfile, lexicalAlignments: [alignment] });
  expect(roundTrip.backTranslatedText).toBe(sourceText);
  expect(roundTrip.gate.accepted).toBe(true);
});
