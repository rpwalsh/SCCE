// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { generateLearnedBehaviorCodeRepairs } from "../code-construction.js";
import { codeSurfaceTokens } from "../code-surface.js";
import { trainKneserNey } from "../kneser-ney.js";

it("locates a source grammar reconstruction hypothesis from corpus likelihood and preserves its failed-test authority", () => {
  const source = "fn aggregate(amount) {\n balances += amount;\n return balances;\n}\n";
  const targetText = source.replace("+=", "-=");
  const start = targetText.indexOf("-=");
  const model = { ...trainKneserNey(codeSurfaceTokens(source), { order: 5, discount: 0.75 }), sourceKey: "source.record.owned" };
  const input = { models: [model], languageId: "rust", targetPath: "ledger.rs", targetText,
    failureObservationId: "receipt.failed-test.owned", sites: [{ start, length: 2, grammarNodeType: "-=" }] };
  const candidates = generateLearnedBehaviorCodeRepairs(input);
  expect(candidates[0]).toMatchObject({ startLine: 2, endLine: 2, content: " balances += amount;", surface: "+=", strategy: "span",
    audit: { failureObservationId: "receipt.failed-test.owned", sourceModelKeys: ["source.record.owned"], hypothesizedSpanStart: start,
      hypothesizedSpanLength: 2, originalText: "-=", replacement: "+=" } });
  expect(candidates[0]!.score).toBeGreaterThan(0);
  expect(generateLearnedBehaviorCodeRepairs({ ...input, failureObservationId: "" })).toEqual([]);
  expect(generateLearnedBehaviorCodeRepairs({ ...input, models: [] })).toEqual([]);
  expect(generateLearnedBehaviorCodeRepairs({ ...input, sites: [{ start: start + 1, length: 1, grammarNodeType: "=" }] })).toEqual([]);
});
