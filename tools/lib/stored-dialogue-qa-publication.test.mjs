// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import test from "node:test";
import {
  assertStoredDialogueQaPublication,
  runStoredDialogueQaPublication
} from "./stored-dialogue-qa-publication.mjs";

const component = {
  compilerFingerprint: "compiler.current", pairs: 4, qualifiedFamilies: 1,
  patternsPersisted: 1, unchanged: false, rejected: []
};

test("retained dialogue finalization uses no language-training lane and proves a cold read", async () => {
  let trainingInput;
  let verificationClosed = false;
  const verificationSql = [];
  const pattern = { id: "pattern.qa", evidenceIds: ["evidence.qa"], patternJson: {} };
  const report = {
    exhausted: true, stoppedByStorageFailure: false, stoppedByInterruption: false, stoppedByHeapSafetyBound: false,
    sourcesEnumerated: 4, sourcesConsidered: 4, sourcesAttempted: 4, reports: [], sourcesSkipped: [], batchesFailed: [],
    contextualQa: { reports: [component], deferred: [] }
  };
  const storage = {
    query: async () => { throw new Error("publishing adapter must not verify its own writes"); },
    languageMemory: { listLanguagePatterns: async () => { throw new Error("publishing adapter must not hydrate verification rows"); } },
    evidence: { getEvidenceBatch: async () => { throw new Error("publishing adapter must not hydrate verification evidence"); } }
  };
  const verificationStorage = {
    query: async sql => {
      verificationSql.push(sql);
      return sql.includes("count(*)") ? [{ count: "2" }] : [{ id: pattern.id }];
    },
    languageMemory: { listLanguagePatterns: async () => [pattern] },
    evidence: { getEvidenceBatch: async () => [{ id: "evidence.qa" }] },
    close: async () => { verificationClosed = true; }
  };
  const adapters = { trainStoredCorpusConstructions: async input => { trainingInput = input; return report; } };
  const kernel = {
    LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA: "scce.language_construction_pattern.v1",
    CONTEXTUAL_QA_CONSTRUCTION_RECIPE: "kernel.dialogue_contextual_qa.v1",
    createHasher: () => ({}), verifyContextualQaConstruction: ({ pattern: value }) => value.id === pattern.id ? {} : undefined
  };
  const publication = await runStoredDialogueQaPublication({ storage, adapters, kernel, databaseSchema: "scce_runtime",
    createVerificationStorage: async () => verificationStorage,
    maxArticleBytes: 100, maxTotalBytes: 1000, maxSourceAttempts: 10, sourcePageSize: 2,
    includeUriPrefix: "file:///retained/qa/" });
  assert.equal(trainingInput.contextualQaOnly, true);
  assert.equal(trainingInput.minArticleBytes, 0);
  assert.deepEqual(trainingInput.includeUriPrefixes, ["file:///retained/qa/"]);
  assert.deepEqual(publication.result.coldVerifiedPatternIds, [pattern.id]);
  assert.equal(publication.result.physicalContextualQaPatterns, 2);
  assert.match(verificationSql.find(sql => sql.includes("storage_meta")) ?? "", /language_pattern_active_projection/u);
  assert.equal(verificationClosed, true);
  assert.equal(publication.result.languageTrainingReports, 0);
  assert.equal(assertStoredDialogueQaPublication(publication.result), publication.result);
});

test("brain completion refuses physical rows that cannot cold-hydrate and verify", () => {
  const base = {
    exhausted: true, stoppedByStorageFailure: false, stoppedByInterruption: false, stoppedByHeapSafetyBound: false,
    languageTrainingReports: 0, contextualQaReports: 1, deferred: [], physicalContextualQaPatterns: 1,
    activeContextualQaPatterns: 1, coldVerifiedContextualQaPatterns: 0
  };
  assert.throws(() => assertStoredDialogueQaPublication(base), /cold-verifiable/u);
  assert.throws(() => assertStoredDialogueQaPublication({ ...base, coldVerifiedContextualQaPatterns: 1, languageTrainingReports: 1 }),
    /unexpectedly invoked language training/u);
});

test("database schema names cannot enter publication SQL", async () => {
  const report = { exhausted: true, reports: [], contextualQa: { reports: [], deferred: [] } };
  await assert.rejects(runStoredDialogueQaPublication({
    storage: {}, adapters: { trainStoredCorpusConstructions: async () => report },
    kernel: {}, databaseSchema: 'runtime";DROP TABLE brains;--',
    maxArticleBytes: 1, maxTotalBytes: 1, maxSourceAttempts: 1, sourcePageSize: 1
  }), /safe SQL identifier/u);
});
