// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { expect, it } from "vitest";
import { generateLearnedBehaviorCodeRepairs, type SourceCodeRepairSite } from "../code-construction.js";
import { codeSurfaceTokens } from "../code-surface.js";
import { trainKneserNey } from "../kneser-ney.js";

function repair(source: string, original: string, replacement: string, languageId = "typescript", constraints: Partial<SourceCodeRepairSite> = {}) {
  const targetText = source.replace(original, replacement);
  const start = source.indexOf(original);
  const model = { ...trainKneserNey(codeSurfaceTokens(source), { order: 5 }), sourceKey: "source.admitted.original" };
  return { targetText, start, candidates: generateLearnedBehaviorCodeRepairs({ models: [model], targetText,
    languageId, targetPath: "source", failureObservationId: "receipt.native-contract.failed", maxCandidates: 8,
    sites: [{ start, length: replacement.length, grammarNodeType: "call_expression", ...constraints }] }) };
}

function apply(target: string, candidate: { startLine: number; endLine: number; content: string }) {
  let start = 0;
  for (let line = 1; line < candidate.startLine; line++) start = target.indexOf("\n", start) + 1;
  let end = start;
  for (let line = candidate.startLine; line <= candidate.endLine; line++) {
    const next = target.indexOf("\n", end);
    end = next < 0 ? target.length : next + 1;
  }
  const trailing = target[end - 1] === "\n" ? (target[end - 2] === "\r" ? "\r\n" : "\n") : "";
  return target.slice(0, start) + candidate.content + trailing + target.slice(end);
}

it("repairs the real family-map write loss as one variable-length expression and restores family output", () => {
  const source = readFileSync(resolve("tools/repair-acceptance/cases/map-write-loss/src/paired-evaluation-statistics.ts"), "utf8");
  const original = "byFamily.set(record.taskFamilyId, bucket)";
  const replacement = "byFamily.get(record.taskFamilyId)";
  const { targetText, start, candidates } = repair(source, original, replacement, "typescript", {
    admissibleIdentifiers: ["byFamily", "set", "get", "record", "taskFamilyId", "bucket"],
    requiredIdentifiers: ["byFamily", "record", "taskFamilyId"]
  });
  const execute = (text: string) => {
    const exports = {} as { estimateClassEffectLCB: (records: unknown[], options: unknown) => unknown[] };
    runInNewContext(ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText,
      { exports });
    return exports.estimateClassEffectLCB([{ id: "one", taskFamilyId: "family-a", value: 1 }],
      { confidenceLevel: 0.95, bootstrapSamples: 2, randomSource: () => 0 });
  };
  expect(execute(targetText)).toEqual([]);
  const candidate = candidates.find(item => item.surface === original);
  expect(candidate).toBeDefined();
  const repaired = apply(targetText, candidate!);
  expect(repaired.slice(0, start)).toBe(targetText.slice(0, start));
  expect(repaired.slice(start + original.length)).toBe(targetText.slice(start + replacement.length));
  expect(execute(repaired)).toMatchObject([{ taskFamilyId: "family-a", sampleCount: 1, meanEffect: 1 }]);
  expect(candidate!.audit).toMatchObject({ failureObservationId: "receipt.native-contract.failed",
    sourceModelKeys: ["source.admitted.original"], hypothesizedSpanStart: start, hypothesizedSpanLength: replacement.length });
});

it.each([
  ["python", "def publish(key, payload):\n    sink.write(key, payload)\n", "sink.write(key, payload)", "sink.read(key)"],
  ["rust", "fn publish(key, payload) {\n    sink.insert(key, payload);\n}\n", "sink.insert(key, payload)", "sink.get(key)"],
  ["java", "void publish(Key key, Value payload) {\n    sink.put(key, payload);\n}\n", "sink.put(key, payload)", "sink.get(key)"],
  ["typescript", "function publish(key, payload) {\n    sink.write(key, payload);\n}\n", "sink.write(key, payload)", "sink.read(key)"]
])("composes variable-length source-supported expressions for %s", (language, source, original, replacement) => {
  const { candidates } = repair(source!, original!, replacement!, language!);
  expect(candidates.some(candidate => candidate.surface === original)).toBe(true);
});

it("rejects inserted names outside the parser's binding vocabulary", () => {
  const source = "fn publish(key) {\n    sink.write(key, foreignPayload);\n}\n";
  const { candidates } = repair(source, "sink.write(key, foreignPayload)", "sink.read(key)", "rust", {
    admissibleIdentifiers: ["sink", "write", "read", "key", "localPayload"], requiredIdentifiers: ["sink", "key"]
  });
  expect(candidates).toEqual([]);
});

it("rejects source fillings that replace an existing bound argument with another binding", () => {
  const source = "fn publish(key, other, payload) {\n    sink.write(other, payload);\n}\n";
  const { candidates } = repair(source, "sink.write(other, payload)", "sink.read(key)", "rust", {
    admissibleIdentifiers: ["sink", "write", "read", "key", "other", "payload"], requiredIdentifiers: ["sink", "key"]
  });
  expect(candidates).toEqual([]);
});
