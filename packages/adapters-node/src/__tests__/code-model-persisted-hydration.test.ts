// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createClock, createHasher, createIdFactory, createLanguageAcquisitionEngine, createNgramMemoryCompiler,
  kneserNeyMaterializationCounts, toJsonValue, type JsonValue, type SourceVersionId } from "@scce/kernel";
import { createLearnedCodeProposer } from "../learned-code-proposer.js";

it("hydrates the canonical persisted compiler output before source-repair inference and keeps unused indexes lazy", async () => {
  const source = "package ledger\nfunc total(amount float64) float64 {\n balances := amount\n return balances\n}\n";
  const targetText = source.replace("return balances", "return balnces");
  const hasher = createHasher();
  const clock = createClock({ fixedTime: 1 });
  const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });
  const sourceVersionId = "source.test-authored.persisted-go.v1" as SourceVersionId;
  const profile = createLanguageAcquisitionEngine({ idFactory }).acquire({ text: source, sourceVersionId, createdAt: 1 });
  const compilation = createNgramMemoryCompiler({ idFactory, hasher }).compile({ streamId: "oss_code:ledger.go", sourceSystem: "oss_code", profile,
    sourceVersionId, text: source, evidence: [], createdAt: 1, maxOrder: 5, retainObservations: false, retainSemanticFrames: false });
  const records = JSON.parse(JSON.stringify(compilation.models.map(record => ({ ...record,
    modelJson: toJsonValue({ ...(record.modelJson as Record<string, JsonValue>), formalLanguage: "go", sourceOrigin: "test-authored-training-reference" })
  })))) as typeof compilation.models;
  const stored = (records[0]!.modelJson as Record<string, JsonValue>).model as Record<string, JsonValue>;
  expect(stored.counts).toBeTruthy();
  for (const key of ["contextCounts", "contextContinuationTypes", "successorIndex", "successorOverflowCounts", "backoffWeights", "baseContinuations"]) expect(stored[key]).toBeUndefined();
  const proposer = createLearnedCodeProposer({ storage: { languageMemory: { listNgramModels: async () => records }, evidence: { searchEvidence: async () => [] } } as never });
  const before = kneserNeyMaterializationCounts();
  expect(await proposer.availableModelCount("go")).toBe(1);
  expect(kneserNeyMaterializationCounts()).toEqual(before);
  const lines = targetText.slice(0, targetText.indexOf("balnces")).split("\n");
  const proposal = await proposer.propose({ request: "balnces", context: { targetPath: "ledger.go", targetText, language: "go", imports: [], symbols: [] },
    diagnostics: [{ id: "actual.checker.fixture", class: "type", path: "ledger.go", line: lines.length, column: lines.at(-1)!.length + 1,
      message: "undefined: balnces", raw: "ledger.go:4:9: undefined: balnces", confidence: 1 }], attempt: 1 });
  expect(proposal).toMatchObject({ operations: [{ kind: "replace", startLine: 4, endLine: 4, content: " return balances" }],
    audit: { sourceModelKeys: [records[0]!.id] } });
  expect(kneserNeyMaterializationCounts()).toEqual({ contextTables: before.contextTables + 1, runtimeIndexes: before.runtimeIndexes + 1 });
});
