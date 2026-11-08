// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { generateLearnedSyntaxCodeInsertions } from "../code-construction.js";
import { codeSurfaceTokens } from "../code-surface.js";
import { trainKneserNey } from "../kneser-ney.js";

it("learns a missing ambient delimiter from source counts without requiring the fragment to open it", () => {
  const source = "fn total(value: i32) -> i32 {\n value\n}\n";
  const start = source.lastIndexOf("}");
  const targetText = source.slice(0, start) + source.slice(start + 1);
  const model = { ...trainKneserNey(codeSurfaceTokens(source), { order: 5, discount: 0.75 }), sourceKey: "source.record.syntax" };
  const input = { models: [model], languageId: "opaque.formal-language", targetPath: "source.opaque", targetText,
    failureObservationId: "receipt.actual.failed-compiler", sites: [{ start, length: 0, grammarNodeType: "ERROR" }] };
  const candidates = generateLearnedSyntaxCodeInsertions(input);
  expect(candidates[0]).toMatchObject({ startLine: 3, endLine: 3, content: "}", surface: "}", requireSyntaxErrorReduction: true,
    audit: { failureObservationId: input.failureObservationId, sourceModelKeys: [model.sourceKey], inserted: "}", hypothesizedSpanStart: start,
      hypothesizedSpanLength: 0, grammarRecoveryNodeType: "ERROR" } });
  expect(candidates[0]!.score).toBeGreaterThan(0);
  expect(generateLearnedSyntaxCodeInsertions({ ...input, models: [] })).toEqual([]);
  expect(generateLearnedSyntaxCodeInsertions({ ...input, failureObservationId: "" })).toEqual([]);
  expect(generateLearnedSyntaxCodeInsertions({ ...input, sites: [{ start: start + 1, length: 1, grammarNodeType: "ERROR" }] })).toEqual([]);
});
