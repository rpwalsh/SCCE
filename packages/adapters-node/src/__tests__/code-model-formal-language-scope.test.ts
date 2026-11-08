// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { codeLanguageForModelRecord, codeSurfaceTokens, toJsonValue, trainKneserNey, type NgramModelQuery, type NgramModelRecord } from "@scce/kernel";
import { createLearnedCodeProposer } from "../learned-code-proposer.js";

it("keeps a minority formal language reachable behind more than 96 higher-mass foreign models", async () => {
  const foreign = trainKneserNey(codeSurfaceTokens("export const observed = 42;\n".repeat(64)), { order: 5 });
  const target = trainKneserNey(codeSurfaceTokens("package observed\nfunc value() float64 { return 2.0 }\n"), { order: 5 });
  const row = (id: string, formalLanguage: string, model: typeof target): NgramModelRecord => ({ id, streamId: `opaque:${id}`, languageHint: "script:Latin;direction:ltr",
    maxOrder: model.order, discount: model.discount, updatedAt: 1, modelJson: toJsonValue({ sourceSystem: "oss_code", sourceOrigin: "test-authored-training-reference", formalLanguage, model }) });
  const correct = row("test-authored-go", "go", target);
  const rows = [...Array.from({ length: 97 }, (_, index) => row(`foreign-${index}`, "typescript", foreign)), correct];
  const calls: NgramModelQuery[] = [];
  const proposer = createLearnedCodeProposer({ storage: { languageMemory: { listNgramModels: async (query: NgramModelQuery = {}) => {
    calls.push(query);
    return rows.filter(record => !query.formalLanguage || codeLanguageForModelRecord(record) === query.formalLanguage).slice(0, query.limit);
  } } } as never });
  expect(await proposer.availableModelCount("go")).toBe(1);
  expect(calls).toEqual([expect.objectContaining({ sourceSystem: "oss_code", formalLanguage: "go", limit: 96 })]);
  expect(calls[0]?.languageHint).toBeUndefined();
});
