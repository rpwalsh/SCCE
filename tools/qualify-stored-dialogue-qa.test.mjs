// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { qualifyStoredDialogueQa } from "./qualify-stored-dialogue-qa.mjs";
import { dryRunStoredDialogueQaPublication } from "./lib/stored-dialogue-qa-dry-run.mjs";

test("dry-run canonical publication records an additive plan without calling live writes or transactions", async () => {
  const forbidden = () => { throw Error("live writes are forbidden"); };
  const key = { profileId: "p", sourceId: "s", sourceVersionId: "v", sourceSystem: "dialogue",
    patternSchema: "schema", componentRecipe: "recipe", informationLabel: { owner: "fixture" } };
  const storage = { transaction: forbidden, evidence: {}, blobs: {}, model: {}, languageIdentities: {},
    ingestion: { get: async () => null, put: forbidden },
    languageMemory: { getLanguagePatternProjection: async () => ({ ...key, patternIds: ["old"] }),
      listLanguagePatterns: async () => [], replaceLanguagePatternProjection: forbidden } };
  const adapters = { trainStoredCorpusConstructions: async ({ storage: facade }) => {
    await facade.transaction(async () => {
      await facade.ingestion.put({ id: "checkpoint", status: "complete" });
      await facade.languageMemory.replaceLanguagePatternProjection({ patterns: [{ id: "old" }, { id: "new" }],
        projection: { ...key, patternIds: ["old", "new"], sourceDependencies: [] } });
    });
    return { exhausted: true, sourcesAttempted: 1, contextualQa: { reports: [], deferred: [] }, sourcesSkipped: [], batchesFailed: [] };
  } };
  const result = await dryRunStoredDialogueQaPublication({ storage, adapters, kernel: { canonicalStringify: JSON.stringify }, trainingOptions: {} });
  assert.equal(result.affectedProjections, 1);
  assert.deepEqual(result.retainedActivePatternIds, ["old"]);
  assert.deepEqual(result.newPatternIds, ["new"]);
  assert.equal(result.mode, "read_only");
});

function fixture() {
  const label = { owner: "fixture" };
  const turns = [{ index: 0, surface: "α?" }, { index: 1, surface: "β", replyToTurnIndex: 0 },
    { index: 2, surface: "γ?", requestAuthority: "factual" }, { index: 3, surface: "δ", replyToTurnIndex: 2 }];
  const row = { sourceVersionId: "version.one", contentHash: "hash.one", canonicalUri: "fixture://one", byteLength: 20 };
  const storage = {
    evidence: { listEvidenceBackedSourceVersions: async () => [row], sourceVersionById: async () => row,
      searchEvidence: async () => [{ span: { id: "evidence.one", sourceVersionId: row.sourceVersionId, informationLabel: label } }] },
    blobs: { get: async () => Buffer.from("unchanged source") },
    model: { listLanguageProfiles: async () => [{ id: "profile.one" }] },
    languageIdentities: { listIdentities: async () => [{ id: "language.one", schema: "identity.v1", evidence: { status: "family_measured" }, informationLabel: label }],
      listProfileLanguages: async () => [{ profileId: "profile.one", languageId: "language.one" }] }
  };
  const kernel = { createHasher: () => ({ digestHex: value => createHash("sha256").update(value).digest("hex") }),
    canonicalStringify: JSON.stringify, LANGUAGE_IDENTITY_SCHEMA: "identity.v1" };
  const options = { includeUriPrefix: "fixture://", maxSources: 2, maxTotalBytes: 1000, execution: {} };
  return { storage, kernel, options, readArchive: async () => turns, turns };
}

test("retained qualification keeps every original contrast and does not publish", async () => {
  const input = fixture();
  let observed;
  const result = await qualifyStoredDialogueQa({ ...input, execute: async value => {
    observed = value;
    return { result: { pairs: 2, families: [], rejected: [] }, receipt: { completedPartitions: 1 } };
  } });
  assert.deepEqual(observed.documents[0].transcriptTurns, input.turns);
  assert.equal(observed.documents[0].transcriptTurns, input.turns);
  assert.equal(result.transcriptFiltering, false);
  assert.equal(result.sourceSelectionComplete, true);
  assert.equal(result.sourceReceipts[0].pairs, 2);
  assert.equal(result.mode, "read_only");
});

test("retained qualification refuses a truncated owner pool before acquisition", async () => {
  const input = fixture();
  input.options.maxSources = 1;
  input.storage.evidence.listEvidenceBackedSourceVersions = async () => [{}, {}];
  await assert.rejects(qualifyStoredDialogueQa({ ...input, execute: async () => { throw Error("acquisition must not run"); } }),
    /no partial qualification/);
});

test("retained qualification refuses unmatched evidence ownership", async () => {
  const input = fixture();
  input.storage.evidence.searchEvidence = async () => [{ span: { sourceVersionId: "version.one", informationLabel: { owner: "foreign" } } }];
  await assert.rejects(qualifyStoredDialogueQa({ ...input, execute: async () => { throw Error("acquisition must not run"); } }),
    /ownership does not match/);
});
