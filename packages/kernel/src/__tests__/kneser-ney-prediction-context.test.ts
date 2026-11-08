// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { kneserNeyProbability, predictKneserNey, trainKneserNey, type KneserNeyModel } from "../kneser-ney.js";
import { createHasher } from "../primitives.js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generateLearnedBehaviorCodeRepairs } from "../code-construction.js";
import { codeSurfaceTokens } from "../code-surface.js";

const symbols = ["a", "b", "c", "toString", "a", "b", "c", "constructor", "a", "b", "c", "字",
  "a", "b", "c", "ψ", "a", "b", "valueOf", "__proto__", "a\u0001b", "c", "字", "İ", "ΟΣ", "ẞ"];

function completeOutputs() {
  const out: unknown[] = [];
  for (const order of [1, 2, 3, 5]) {
    const base = trainKneserNey(symbols, { order });
    const malformed = structuredClone(base);
    for (const [key, value] of [["a", NaN], ["a\u0001b", Infinity], ["b", -3]] as const) malformed.contextCounts[key] = value;
    malformed.backoffWeights.c = NaN;
    malformed.contextContinuationTypes.c = Infinity;
    for (const model of [base, malformed]) for (const context of [[], ["a"], ["a", "b", "c"], ["missing", "b", "c"],
      ["constructor"], ["toString"], ["__proto__"], ["a\u0001b", "c"], ["字", "İ", "ΟΣ", "ẞ"]]) {
      for (const limit of [1, 4, 32]) {
        const predictions = predictKneserNey(model, context, limit);
        for (const prediction of predictions) expect(prediction.probability).toBe(kneserNeyProbability(model, context, prediction.symbol));
        out.push(predictions);
      }
    }
  }
  return out;
}

it("preserves complete ranked predictions and exact scalar probabilities across backoff, Unicode, and malformed counts", () => {
  expect(createHasher().digestHex(JSON.stringify(completeOutputs()))).toBe("e4df47dcbe2973a8a2d2937abf416ad9faabedf1584ef80da943dcdad471c348");
});

it("reads each shared context count once per prediction call rather than once per candidate", () => {
  const model = trainKneserNey(symbols, { order: 4 });
  const counts = model.contextCounts;
  let reads = 0;
  model.contextCounts = new Proxy(counts, { get(target, key, receiver) { reads++; return Reflect.get(target, key, receiver); } });
  expect(predictKneserNey(model, ["a", "b", "c"], 32).length).toBeGreaterThan(4);
  expect(reads).toBe(3);
});

it("prepares from the current model on every call without retaining stale model state", () => {
  const model: KneserNeyModel = trainKneserNey(symbols, { order: 4 });
  const context = ["a", "b", "c"];
  const before = predictKneserNey(model, context, 32);
  model.contextCounts[context.join("\u0001")] = model.contextCounts[context.join("\u0001")]! * 4;
  model.backoffWeights[context.join("\u0001")] = 0.125;
  const after = predictKneserNey(model, context, 32);
  expect(after).not.toEqual(before);
  for (const prediction of after) expect(prediction.probability).toBe(kneserNeyProbability(model, context, prediction.symbol));
});

it("preserves the complete frozen-source Map repair candidate sequence and audits", () => {
  const source = readFileSync(resolve("tools/repair-acceptance/cases/map-write-loss/src/paired-evaluation-statistics.ts"), "utf8");
  const original = "byFamily.set(record.taskFamilyId, bucket)", broken = "byFamily.get(record.taskFamilyId)";
  const targetText = source.replace(original, broken), start = source.indexOf(original);
  const models = [{ ...trainKneserNey(codeSurfaceTokens(source), { order: 5 }), sourceKey: "fixture.original.source" }];
  const candidates = generateLearnedBehaviorCodeRepairs({ models, languageId: "typescript", targetPath: "src/paired-evaluation-statistics.ts",
    targetText, failureObservationId: "fixture.native-behavior.failed", maxCandidates: 8, sites: [
      { start: start + "byFamily.get(".length, length: "record.taskFamilyId".length, grammarNodeType: "member_expression", kind: "structure" },
      { start, length: broken.length, grammarNodeType: "call_expression", kind: "structure" }
    ] });
  expect(candidates.some(candidate => candidate.surface === original)).toBe(true);
  expect(createHasher().digestHex(JSON.stringify(candidates))).toBe("e7a80bfaff2ab0af5c7c638b44b89ea32470c75fe739dfc770f2890fe10c5059");
});
