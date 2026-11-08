// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { generateLearnedBehaviorCodeRepairs, learnedCodeRepairOperations } from "../code-construction.js";
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

it("joins independent source-attested repairs before the application gate must accept their combined behavior", () => {
  const source = "fn aggregate(rows) {\n let initial = 0;\n let balances = map();\n for amount in rows { balances += amount; }\n return balances;\n}\n";
  const targetText = source.replace("initial = 0", "initial = 1").replace("+=", "-=");
  const initial = targetText.indexOf("1;");
  const addition = targetText.indexOf("-=");
  const model = { ...trainKneserNey(codeSurfaceTokens(source), { order: 5, discount: 0.75 }), sourceKey: "source.record.joined" };
  const input = { models: [model], languageId: "opaque.formal-language", targetPath: "ledger.opaque", targetText,
    failureObservationId: "receipt.failed-test.joined", maxCandidates: 4,
    sites: [{ start: initial, length: 1, grammarNodeType: "integer_literal" }, { start: addition, length: 2, grammarNodeType: "-=" }] };
  const candidates = generateLearnedBehaviorCodeRepairs(input);
  expect(candidates[0]).toMatchObject({ startLine: 2, endLine: 4,
    content: " let initial = 0;\n let balances = map();\n for amount in rows { balances += amount; }",
    audit: { failureObservationId: "receipt.failed-test.joined", sourceModelKeys: ["source.record.joined"],
      hypothesizedSpans: [{ start: initial, length: 1, originalText: "1", replacement: "0" }, { start: addition, length: 2, originalText: "-=", replacement: "+=" }] } });
  expect(candidates.filter(candidate => candidate.startLine === candidate.endLine)).toHaveLength(2);
  expect(learnedCodeRepairOperations(candidates[0]!, input.targetPath)).toMatchObject([
    { startLine: 2, endLine: 2, content: " let initial = 0;" },
    { startLine: 4, endLine: 4, content: " for amount in rows { balances += amount; }" }
  ]);
  expect(candidates).toHaveLength(3);
  expect(generateLearnedBehaviorCodeRepairs({ ...input, maxCandidates: 1 })).toHaveLength(1);
  expect(generateLearnedBehaviorCodeRepairs({ ...input, failureObservationId: "" })).toEqual([]);
});

it("rejects a joined neighborhood that no source actually observed", () => {
  const candidates = generateLearnedBehaviorCodeRepairs({
    models: ["c+=b", "a-=b"].map((source, index) => ({ ...trainKneserNey(codeSurfaceTokens(source), { order: 2, discount: 0.75 }), sourceKey: `source.branch.${index}` })),
    languageId: "opaque.formal-language", targetPath: "source.opaque", targetText: "a+=b", failureObservationId: "receipt.actual.failed-contract",
    sites: [{ start: 0, length: 1, grammarNodeType: "identifier" }, { start: 1, length: 2, grammarNodeType: "+=" }]
  });
  expect(candidates.map(candidate => candidate.content).sort()).toEqual(["a-=b", "c+=b"]);
  expect(candidates.some(candidate => candidate.content === "c-=b")).toBe(false);
});
