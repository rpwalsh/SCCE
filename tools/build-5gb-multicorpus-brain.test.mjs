// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  albedoAcceptanceCase,
  assertCorpusSkipsAdmissible,
  assertResumeCorpusScope,
  assertBuildStateScope,
  completionTargetReached,
  dollyAcceptanceCase,
  mayStartBudgetedBatch,
  loadPinnedLexicalManifest,
  parseArguments,
  publishPinnedLexicalResource,
  replayPinnedLexicalResource,
  resumeOrderedSchedule,
  selectedOasstRoot,
  trainCodeBatch,
  trainGutenbergBatch,
  trainPinnedLexicalResource,
  finalizeBuildLanguageIdentities,
  validateAcceptanceCases,
  verifyBrainBuildPrerequisites,
  walkdirCiAcceptanceCase
} from "./build-5gb-multicorpus-brain.mjs";

test("lexical inputs are optional and require a complete manifest pin", () => {
  const base = ["--fresh-config", ".scce/fresh.json", "--receipt", ".scce/receipt.json"];
  assert.equal(parseArguments(base).lexicalManifest, undefined);
  assert.throws(() => parseArguments([...base, "--lexical-manifest", "lexical.json"]), /requires a path/u);
  const lexicalManifest = { path: path.resolve("lexical.json"), contentHash: `sha256_${"a".repeat(64)}` };
  const parsed = parseArguments([...base, "--lexical-manifest", "lexical.json", "--lexical-manifest-hash", lexicalManifest.contentHash]);
  assert.deepEqual(parsed.lexicalManifest, lexicalManifest);
  assert.throws(() => assertResumeCorpusScope({ corpusIdentity: { lexicalManifest } }, { resume: true }), /lexical manifest differs/u);
  assert.doesNotThrow(() => assertResumeCorpusScope({ corpusIdentity: { lexicalManifest } }, { resume: true, lexicalManifest }));
});

test("completed and unfinished initialization scope must match before supervisor reuse", () => {
  const options = parseArguments(["--fresh-config", "fresh.json", "--receipt", "receipt.json"]);
  const state = { status: "complete", budgetBytes: options.budgetBytes, guardBytes: options.guardBytes, targetBytes: null,
    corpusIdentity: { wikipediaDump: null, wikipediaIndex: null, gutenbergRoot: options.gutenbergRoot,
      dollyRoot: options.dollyRoot, oasstRoot: options.oasstRoot, codeRoot: options.codeRoot }, selection: { englishOnly: false } };
  assert.doesNotThrow(() => assertBuildStateScope(state, options));
  assert.throws(() => assertBuildStateScope(state, { ...options, targetBytes: 100 }), /target-bytes differs/u);
  assert.throws(() => assertBuildStateScope(state, { ...options, lexicalManifest: { path: "different", contentHash: "different" } }), /corpus paths differ/u);
});

test("pinned lexical initialization uses ordinary checkpoints and refuses changed inputs without learning", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-lexical-init-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = path.join(root, "source.conllu"), manifestPath = path.join(root, "lexical.json");
  const sourceText = await readFile(new URL("../packages/adapters-node/src/__tests__/fixtures/ud-ewt-question-excerpt.conllu", import.meta.url), "utf8");
  await writeFile(source, sourceText);
  const hash = value => `sha256_${createHash("sha256").update(value).digest("hex")}`;
  const resource = { id: "pinned-ud", path: "source.conllu", format: "conllu", contentHash: hash(sourceText),
    sourceUri: "https://example.test/pinned/source.conllu", lexiconId: "fixture:1", language: "en", license: "CC-BY-SA-4.0",
    maxSourceBytes: Buffer.byteLength(sourceText) };
  const manifest = { schema: "scce.initial_lexical_resources.v1", resources: [resource] };
  const writeManifest = async value => {
    const bytes = JSON.stringify(value);
    await writeFile(manifestPath, bytes);
    return { path: manifestPath, contentHash: hash(bytes) };
  };
  const pin = await writeManifest(manifest);
  const [loaded] = await loadPinnedLexicalManifest(pin);
  assert.equal(loaded.path, source);
  assert.equal(loaded.maxDatabaseGrowthBytes, undefined);
  const label = { tenantId: "test", principals: ["owner"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
  const report = { schema: "scce.languageCorpusTrainingReport.v1", sourceVersionId: "derived.1", originalSourceVersionId: "raw.1",
    sourceContentHash: hash(sourceText), artifacts: { languageProfileId: "profile.1" } };
  const result = { status: "complete", checkpointed: true, lexiconId: resource.lexiconId, language: resource.language,
    license: resource.license, sourceVersionId: report.sourceVersionId, annotationSourceVersionId: report.originalSourceVersionId,
    contentHash: report.sourceContentHash, profileId: report.artifacts.languageProfileId };
  let rows = [], learned = 0;
  const api = { config: { security: { informationAccess: { tenantId: "test" }, defaultSourceInformationLabel: label } },
    storage: { ingestion: { list: async query => {
      assert.equal(query.rootUri, resource.sourceUri);
      return rows;
    } } }, readLexicalSource: async input => {
      assert.equal(input.maxSourceBytes, resource.maxSourceBytes);
      return readFile(input.path, "utf8");
    }, adapters: { ingestUdLexicalCorpus: async input => {
      assert.equal(input.informationLabel, label);
      assert.equal(input.text, sourceText);
      if (!rows.length) { learned++; rows = [{ metadata: { report } }]; }
      return result;
    } } };
  const state = { status: "building", reports: [], batches: [], measurements: [], lanes: {}, budgetBytes: 1000, guardBytes: 100 };
  const first = await trainPinnedLexicalResource(loaded, state, api);
  assert.equal(first.replayed, false);
  assert.deepEqual(first.input, loaded);
  const replay = await trainPinnedLexicalResource(loaded, state, api);
  assert.equal(replay.replayed, true);
  assert.equal(learned, 1);
  assert.deepEqual(state.reports, [report]);
  const projection = { profileId: result.profileId, sourceId: "source.1", sourceVersionId: result.sourceVersionId,
    sourceSystem: "workspace", patternSchema: "grammar.v1", componentRecipe: "grammar.recipe.v1", patternIds: ["pattern.1"], informationLabel: label };
  report.sourceOwnedPatternProjections = [projection];
  rows[0].metadata.compilerRecipe = "corpus.recipe.v1";
  rows[0].metadata.batchRecipe = "batch.recipe.v1";
  rows[0].metadata.componentRecipes = { "sourceOwned:grammar.v1": "grammar.recipe.v1" };
  api.kernel = { canonicalStringify: JSON.stringify, normalizeInformationLabel: value => value,
    LANGUAGE_TRAINING_BATCH_RECIPE_ID: "batch.recipe.v1", LEXICAL_GRAMMAR_SCHEMA: "grammar.v1", LEXICAL_GRAMMAR_RECIPE: "grammar.recipe.v1",
    SOURCE_QUESTION_FRAME_SCHEMA: "frame.v1", SOURCE_QUESTION_FRAME_RECIPE: "frame.recipe.v1" };
  api.adapters.languageCorpusTrainingRecipeId = () => "corpus.recipe.v1";
  api.storage.languageMemory = { getLanguagePatternProjection: async () => projection, listLanguagePatterns: async () => [{ id: "pattern.1" }] };
  api.storage.query = async sql => sql.includes("pg_database_size") ? [{ bytes: "950" }] : [];
  await publishPinnedLexicalResource(loaded, { statePath: path.join(root, "state.json"), receiptPath: path.join(root, "receipt.json"),
    budgetBytes: 1000, guardBytes: 100 }, state, api);
  assert.equal(learned, 1);
  assert.equal(state.batches.at(-1).details.replayed, true);
  await assert.rejects(replayPinnedLexicalResource(loaded, state, { ...api, storage: { ...api.storage,
    languageMemory: { ...api.storage.languageMemory, getLanguagePatternProjection: async () => undefined } } }), /active projection header/u);
  await assert.rejects(replayPinnedLexicalResource(loaded, state, { ...api, storage: { ...api.storage,
    languageMemory: { ...api.storage.languageMemory, listLanguagePatterns: async () => [] } } }), /active projection patterns/u);
  await assert.rejects(replayPinnedLexicalResource(loaded, state, { ...api,
    adapters: { ...api.adapters, languageCorpusTrainingRecipeId: () => "new.recipe" } }), /stale compiler recipes/u);
  await assert.rejects(trainPinnedLexicalResource(loaded, { reports: [] }, { ...api, storage: { ingestion: { list: async () => [] } } }), /exact durable/u);
  await assert.rejects(trainPinnedLexicalResource(loaded, { reports: [] }, { ...api, config: { security: {} } }), /configured information access/u);
  await assert.rejects(trainPinnedLexicalResource({ ...loaded, format: "wordnet" }, { reports: [] },
    { ...api, adapters: { readWordnetLmf: () => ({ lexiconId: "changed", language: "en", license: resource.license }) } }), /declaration differs/u);
  await assert.rejects(loadPinnedLexicalManifest({ ...pin, contentHash: hash("wrong") }), /declared pin/u);
  await assert.rejects(loadPinnedLexicalManifest(await writeManifest({ ...manifest, resources: [{ ...resource, maxSourceBytes: resource.maxSourceBytes - 1 }] })), /encoded bytes exceed/u);
  await assert.rejects(loadPinnedLexicalManifest(await writeManifest({ ...manifest, resources: [resource, resource] })), /repeats a resource/u);
  await writeFile(source, `${sourceText}\nchanged`);
  await assert.rejects(trainPinnedLexicalResource(loaded, state, api), /encoded bytes exceed|declared pin/u);
  assert.equal(learned, 1);
});

test("lexical global budget refusal is durable and never invokes the ingestor", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "scce-lexical-budget-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { statePath: path.join(root, "state.json"), receiptPath: path.join(root, "receipt.json"), budgetBytes: 1000, guardBytes: 100 };
  const state = { status: "building", reports: [], batches: [], lanes: {}, budgetBytes: 1000, guardBytes: 100 };
  const api = { storage: { query: async sql => sql.includes("pg_database_size") ? [{ bytes: "950" }] : [] } };
  await assert.rejects(publishPinnedLexicalResource({ id: "required-resource" }, options, state, api), /cannot start/u);
  const persisted = JSON.parse(await readFile(options.statePath, "utf8"));
  assert.equal(persisted.lastFailure.resourceId, "required-resource");
  assert.equal(persisted.status, "building");
  assert.equal(persisted.lastFailure.beforeBytes, 950);
});

test("initialization finalizes the measured identities of exactly its admitted profile owners", async () => {
  const calls = [];
  const state = { reports: [{ artifacts: { languageProfileId: "ordinary" } }, { artifacts: { languageProfileId: "lexical" } }] };
  const api = { storage: { transaction: async operation => { calls.push("transaction"); return operation(); } } };
  const runtime = { ensure: async input => {
    calls.push(input);
    return { readiness: "ready", identities: [{ id: "measured" }], assigned: 2, discovered: true };
  } };
  assert.equal((await finalizeBuildLanguageIdentities(state, api, runtime)).identities, 1);
  assert.deepEqual(calls, ["transaction", { finalize: true, initializeIfMissing: true, requiredProfileIds: ["ordinary", "lexical"] }]);
  await assert.rejects(finalizeBuildLanguageIdentities(state, api, { ensure: async () => ({ readiness: "missing", identities: [] }) }), /not ready/u);
});

test("a resumed round-robin continues after its last committed optional lane", () => {
  const schedule = ["gutenberg", "dolly", "code", "oasst", "wikipedia"].map(lane => [lane, lane]);
  assert.deepEqual(resumeOrderedSchedule(schedule, [
    { lane: "wikipedia", required: true },
    { lane: "gutenberg", required: false }
  ]).map(([lane]) => lane), ["dolly", "code", "oasst", "wikipedia", "gutenberg"]);
  assert.deepEqual(resumeOrderedSchedule(schedule, [
    { lane: "wikipedia", required: true }
  ]).map(([lane]) => lane), ["gutenberg", "dolly", "code", "oasst", "wikipedia"]);
});

test("existing fresh config mode never requests a second output config", () => {
  const parsed = parseArguments([
    "--fresh-config", ".scce/fresh.json",
    "--receipt", ".scce/verification/receipt.json"
  ], "C:/workspace/scce");
  assert.equal(parsed.existingFreshConfig, true);
  assert.equal(parsed.configPath, "C:\\workspace\\scce\\.scce\\fresh.json");
  assert.equal(parsed.outputConfigPath, parsed.configPath);
  assert.equal(parsed.budgetBytes, 5_000_000_000);
  assert.equal(parsed.guardBytes, 200_000_000);
  assert.equal(parsed.englishOnly, false);
});

test("English-only corpus scope is explicit and cannot be repeated", () => {
  const parsed = parseArguments([
    "--fresh-config", ".scce/fresh.json", "--receipt", ".scce/receipt.json", "--english-only", "--resume"
  ], "C:/workspace/scce");
  assert.equal(parsed.englishOnly, true);
  assert.equal(parsed.resume, true);
  assert.throws(() => parseArguments([
    "--fresh-config", ".scce/fresh.json", "--receipt", ".scce/receipt.json", "--english-only", "--english-only"
  ]), /may be supplied once/u);
});

test("English-only training and acceptance read the same OpenAssistant root", () => {
  assert.equal(selectedOasstRoot({ englishOnly: true, oasstRoot: "C:\\corpus\\oasst" }), "C:\\corpus\\oasst\\en");
  assert.equal(selectedOasstRoot({ englishOnly: false, oasstRoot: "C:\\corpus\\oasst" }), "C:\\corpus\\oasst");
});

test("resume cannot relabel already-committed corpus scope", () => {
  assert.doesNotThrow(() => assertResumeCorpusScope({ selection: { englishOnly: true } }, { resume: true, englishOnly: true }));
  assert.doesNotThrow(() => assertResumeCorpusScope({ selection: { englishOnly: false } }, { resume: true, englishOnly: false }));
  assert.throws(() => assertResumeCorpusScope({ selection: { englishOnly: false } }, { resume: true, englishOnly: true }), /scope differs/u);
  assert.throws(() => assertResumeCorpusScope({ selection: { englishOnly: true } }, { resume: true, englishOnly: false }), /scope differs/u);
});

test("new database mode requires both base and new ignored configs", () => {
  assert.throws(() => parseArguments(["--config", "scce.config.json", "--receipt", "receipt.json"]), /Usage:/u);
  const parsed = parseArguments([
    "--config", "scce.config.json", "--output-config", ".scce/new.json", "--receipt", ".scce/receipt.json"
  ], "C:/workspace/scce");
  assert.equal(parsed.existingFreshConfig, false);
  assert.notEqual(parsed.configPath, parsed.outputConfigPath);
});

test("code dependency snapshots require a pinned manifest and survive builder forwarding", async () => {
  const base = ["--fresh-config", ".scce/fresh.json", "--receipt", ".scce/receipt.json"];
  assert.throws(() => parseArguments([...base, "--code-dependency-manifest", "deps.json"]), /requires a path/u);
  assert.throws(() => parseArguments([...base, "--code-dependency-manifest-hash", "sha256_" + "a".repeat(64)]), /requires a path/u);
  const options = parseArguments([...base, "--code-dependency-manifest", "deps.json", "--code-dependency-manifest-hash", "sha256_" + "a".repeat(64)]);
  assert.equal(options.codeDependencyManifest.path, path.resolve("deps.json"));
  let received;
  const state = { lanes: { code: { cursor: 0, snapshotHash: null } }, reports: [] };
  await trainCodeBatch(options, state, { storage: {}, settings: {}, adapters: { trainOssCorpus: async input => {
    received = input.dependencyManifest;
    return { reports: [], filesSkipped: [], snapshotHash: "snapshot", snapshotComplete: true, nextFileIndex: 0,
      filesTotal: 0, trainingComplete: true, stoppedByHeapSafetyBound: false, sourceContractClosure: {
        complete: true, roots: [], candidateCount: 0, nextCandidateIndex: 0, round: 0, incompleteInRound: 0 } };
  } } }, 1);
  assert.deepEqual(received, options.codeDependencyManifest);
  assert.throws(() => assertResumeCorpusScope({ corpusIdentity: { codeDependencyManifest: received } }, { resume: true }), /manifest differs/u);
  assert.doesNotThrow(() => assertResumeCorpusScope({ corpusIdentity: { codeDependencyManifest: received } }, { resume: true, codeDependencyManifest: received }));
});

test("preflight proves every external input before a brain build starts", async t => {
  const rootPath = await mkdtemp(path.join(os.tmpdir(), "scce-brain-preflight-"));
  t.after(() => rm(rootPath, { recursive: true, force: true }));
  const file = async relative => {
    const target = path.join(rootPath, relative);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, "fixture", "utf8");
    return target;
  };
  const directory = async relative => {
    const target = path.join(rootPath, relative);
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, "fixture.txt"), "fixture", "utf8");
    return target;
  };
  const options = {
    rootPath,
    configPath: await file("brain.json"),
    outputConfigPath: path.join(rootPath, "new-brain.json"),
    receiptPath: path.join(rootPath, "receipt.json"),
    statePath: path.join(rootPath, "state.json"),
    gutenbergRoot: await directory("corpora/gutenberg"),
    dollyRoot: await directory("corpora/dolly"),
    oasstRoot: await directory("corpora/oasst"),
    codeRoot: await directory("corpora/code"),
    wikipediaDump: await file("corpora/wiki.xml.bz2"),
    wikipediaIndex: await file("corpora/wiki-index.txt"),
    existingFreshConfig: false,
    englishOnly: false
  };
  await file("packages/adapters-node/dist/index.js");
  await file("packages/kernel/dist/index.js");
  await assert.doesNotReject(verifyBrainBuildPrerequisites(options));
  const manifestPath = await file("dependency-manifest.json");
  await assert.rejects(verifyBrainBuildPrerequisites({ ...options, codeDependencyManifest: { path: manifestPath, contentHash: "sha256_" + "0".repeat(64) } }),
    error => error.code === "SCCE_BRAIN_PREREQUISITE_INVALID" && /content hash differs/u.test(error.message));
  await rm(options.codeRoot, { recursive: true, force: true });
  await assert.rejects(verifyBrainBuildPrerequisites(options), error =>
    error.code === "SCCE_BRAIN_PREREQUISITE_INVALID" && /code corpus/u.test(error.message));
});

test("source-induction workers are explicit, complete, and override-ready", () => {
  assert.throws(() => parseArguments([
    "--fresh-config", ".scce/fresh.json", "--receipt", ".scce/receipt.json", "--source-workers", "2"
  ]), /must be supplied together/u);
  const parsed = parseArguments([
    "--fresh-config", ".scce/fresh.json", "--receipt", ".scce/receipt.json",
    "--source-workers", "2", "--source-worker-heap-mb", "512", "--max-node-rss-bytes", "8000000000"
  ], "C:/workspace/scce");
  assert.deepEqual(parsed.sourceInductionExecution, {
    backend: "node_workers.v1", workers: 2, workerHeapMb: 512, maxNodeRssBytes: 8_000_000_000, abortGraceMs: 10_000
  });
});

test("budget guard accounts for both the fixed reserve and measured batch growth", () => {
  assert.equal(mayStartBudgetedBatch(4_700_000_000, 5_000_000_000, 200_000_000, 10_000_000), true);
  assert.equal(mayStartBudgetedBatch(4_810_000_000, 5_000_000_000, 200_000_000, 10_000_000), false);
  assert.equal(mayStartBudgetedBatch(4_600_000_000, 5_000_000_000, 100_000_000, 300_000_000), false);
});

test("a soft completion target stops only after committed physical storage reaches it", () => {
  assert.equal(completionTargetReached(1_999_999_999, 2_000_000_000), false);
  assert.equal(completionTargetReached(2_000_000_000, 2_000_000_000), true);
  assert.equal(completionTargetReached(2_050_000_000, 2_000_000_000), true);
  assert.equal(completionTargetReached(2_050_000_000, null), false);
  const parsed = parseArguments([
    "--fresh-config", ".scce/fresh.json", "--receipt", ".scce/receipt.json", "--target-bytes", "2000000000"
  ], "C:/workspace/scce");
  assert.equal(parsed.targetBytes, 2_000_000_000);
  assert.throws(() => parseArguments([
    "--fresh-config", ".scce/fresh.json", "--receipt", ".scce/receipt.json",
    "--budget-bytes", "1000000000", "--target-bytes", "2000000000"
  ]), /must not exceed/u);
});

test("acceptance receipt requires all five corpora and exact source bindings", () => {
  const binding = { sourceId: "source.1", sourceVersionId: "version.1", contentHash: "a".repeat(64) };
  const cases = ["wikipedia", "gutenberg", "dolly", "code", "openassistant"].map(corpus => ({
    id: `${corpus}-case`, corpus, question: "What does the source say?", sourceBindings: [binding], expectedAnyAnswerTerms: ["answer"]
  }));
  assert.equal(validateAcceptanceCases(cases), cases);
  assert.throws(() => validateAcceptanceCases(cases.slice(1)), /missing corpora: wikipedia/u);
  assert.throws(() => validateAcceptanceCases(cases.map((item, index) => index ? item : { ...item, sourceBindings: [{}] })), /runner contract/u);
});

test("the Dolly acceptance contract requires exactly the requested date", () => {
  const sourceBindings = [{ sourceId: "source.dolly", sourceVersionId: "version.dolly", contentHash: "hash.dolly" }];
  const testCase = dollyAcceptanceCase(sourceBindings);
  assert.equal(testCase.question, "When did Virgin Australia start operating?");
  assert.deepEqual(testCase.expectedAnswerTerms, ["31 August 2000"]);
  assert.equal(testCase.expectedAnswerTerms.includes("Virgin Blue"), false);
  assert.equal(testCase.sourceBindings, sourceBindings);
});

test("the Wikipedia and code generators ask natural questions about one bounded fact", () => {
  const sourceBindings = [{ sourceId: "source.bound", sourceVersionId: "version.bound", contentHash: "hash.bound" }];
  const albedo = albedoAcceptanceCase(sourceBindings,
    "Albedo is the fraction of sunlight that is diffusely reflected by a body. Snow is a separate example.");
  assert.equal(albedo.question, "What is albedo?");
  assert.deepEqual(albedo.expectedAnswerTerms, ["fraction of sunlight", "diffusely reflected"]);

  const code = walkdirCiAcceptanceCase(sourceBindings,
    "- build: pinned\n  os: ubuntu-latest\n  rust: 1.60.0\n- build: nightly\n  rust: nightly");
  assert.equal(code.question, "Which Rust version does Walkdir's pinned CI build use?");
  assert.deepEqual(code.expectedAnswerTerms, ["1.60.0"]);
});

test("only empty or unsupported corpus inputs are admissible skips", () => {
  assert.deepEqual(assertCorpusSkipsAdmissible("gutenberg", [
    { path: "empty.txt", reason: "empty_after_boilerplate_strip" }
  ]), [{ path: "empty.txt", reason: "empty_after_boilerplate_strip" }]);
  assertCorpusSkipsAdmissible("code", [
    { path: "vendor.zip", reason: "archive_file" },
    { path: "node_modules", reason: "generated_or_dependency_directory" }
  ]);
  assert.throws(() => assertCorpusSkipsAdmissible("gutenberg", [
    { path: "book.txt", reason: "training_failed: persistence failed" }
  ]), error => error.code === "SCCE_MULTICORPUS_SOURCE_TRAINING_FAILED" && /book\.txt/u.test(error.message));
  assert.throws(() => assertCorpusSkipsAdmissible("code", [
    { path: "deep/source.ts", reason: "max_depth" }
  ]), /max_depth/u);
});

test("a Gutenberg training failure cannot advance its persisted lane cursor", async () => {
  const state = { lanes: { gutenberg: { cursor: 7, exhausted: false } }, reports: [{ id: "previous" }] };
  const api = { storage: {}, settings: {}, adapters: { trainGutenbergCorpus: async () => ({
    reports: [], filesTrained: 0, filesSkipped: [{ path: "book.txt", reason: "training_failed: exact replay missing" }],
    stoppedByHeapSafetyBound: false
  }) } };
  await assert.rejects(trainGutenbergBatch({ gutenbergRoot: "C:/corpus" }, state, api, 1),
    error => error.code === "SCCE_MULTICORPUS_SOURCE_TRAINING_FAILED");
  assert.equal(state.lanes.gutenberg.cursor, 7);
  assert.equal(state.lanes.gutenberg.exhausted, false);
  assert.deepEqual(state.reports, [{ id: "previous" }]);
});

test("a code projection failure cannot advance its cursor or accept a new snapshot", async () => {
  const state = { lanes: { code: { cursor: 3, exhausted: false, snapshotHash: null } }, reports: [] };
  const api = { storage: {}, settings: {}, adapters: { trainOssCorpus: async () => ({
    reports: [], nextFileIndex: 3, snapshotHash: "snapshot.new", codeTrained: 0, docsTrained: 0,
    filesSkipped: [{ path: "src/a.ts", reason: "training_failed: compiler failed" }], stoppedByHeapSafetyBound: false
  }) } };
  await assert.rejects(trainCodeBatch({ codeRoot: "C:/repos" }, state, api, 50),
    error => error.code === "SCCE_MULTICORPUS_SOURCE_TRAINING_FAILED");
  assert.equal(state.lanes.code.cursor, 3);
  assert.equal(state.lanes.code.snapshotHash, null);
  assert.deepEqual(state.reports, []);
});

function codeBatchFixture(report) {
  const state = { lanes: { code: { cursor: report.nextFileIndex, exhausted: false, snapshotHash: "snapshot" } }, reports: [] };
  const api = { storage: {}, settings: {}, adapters: { trainOssCorpus: async () => ({
    reports: [], snapshotHash: "snapshot", snapshotComplete: true, codeTrained: 0, docsTrained: 0,
    filesSkipped: [], stoppedByHeapSafetyBound: false, ...report
  }) } };
  return { state, api };
}

test("a short code batch does not exhaust a fully inventoried but partially acquired project", async () => {
  const { state, api } = codeBatchFixture({ nextFileIndex: 1, filesTotal: 20, trainingComplete: false });
  state.lanes.code.cursor = 0;
  const result = await trainCodeBatch({ codeRoot: "C:/repos" }, state, api, 50);
  assert.equal(state.lanes.code.exhausted, false);
  assert.equal(state.lanes.code.acquisitionComplete, false);
  assert.equal(result.progressed, true);
});

test("EOF code closure work continues without file cursor advancement and stops after an unresolved full sweep", async () => {
  const closure = { recipe: "closure", candidateCount: 4, nextCandidateIndex: 2, round: 0, complete: false, incompleteInRound: 1, roots: [] };
  const report = { nextFileIndex: 20, filesTotal: 20, trainingComplete: false, sourceContractClosure: closure };
  const { state, api } = codeBatchFixture(report);
  let result = await trainCodeBatch({ codeRoot: "C:/repos" }, state, api, 50);
  assert.equal(result.progressed, true);
  assert.equal(state.lanes.code.exhausted, false);
  closure.nextCandidateIndex = 0; closure.round = 1;
  result = await trainCodeBatch({ codeRoot: "C:/repos" }, state, api, 50);
  assert.equal(result.progressed, true);
  closure.nextCandidateIndex = 2;
  result = await trainCodeBatch({ codeRoot: "C:/repos" }, state, api, 50);
  assert.equal(result.progressed, false);
  assert.equal(state.lanes.code.exhausted, false);
  assert.equal(state.lanes.code.trainingComplete, false);
  assert.equal(state.lanes.code.projectClosure.incompleteInRound, 1);
});

test("code exhaustion follows completed acquisition and project closure", async () => {
  const { state, api } = codeBatchFixture({ nextFileIndex: 20, filesTotal: 20, trainingComplete: true,
    sourceContractClosure: { recipe: "closure", candidateCount: 4, nextCandidateIndex: 0, round: 1, complete: true, incompleteInRound: 0, roots: [] } });
  await trainCodeBatch({ codeRoot: "C:/repos" }, state, api, 50);
  assert.equal(state.lanes.code.acquisitionComplete, true);
  assert.equal(state.lanes.code.trainingComplete, true);
  assert.equal(state.lanes.code.exhausted, true);
});

test("a heap checkpoint retains dependency acquisition progress before the selected file advances", async () => {
  const { state, api } = codeBatchFixture({ nextFileIndex: 3, filesTotal: 20, trainingComplete: false,
    stoppedByHeapSafetyBound: true, contextAcquisition: { roots: [], preacquiredPaths: ["tsconfig.json"] } });
  const result = await trainCodeBatch({ codeRoot: "C:/repos" }, state, api, 50);
  assert.equal(result.progressed, true);
  assert.equal(state.lanes.code.cursor, 3);
  assert.equal(state.lanes.code.exhausted, false);
  assert.deepEqual(result.details.contextAcquisition.preacquiredPaths, ["tsconfig.json"]);
});
