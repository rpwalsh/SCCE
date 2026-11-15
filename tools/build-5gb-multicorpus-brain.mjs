// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { opendir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createBrainDatabase } from "./create-brain-database.mjs";
import { atomicWriteJson, publishBrainBuildCheckpoint } from "./lib/brain-build-publication.mjs";
import { assertStoredDialogueQaPublication, runStoredDialogueQaPublication } from "./lib/stored-dialogue-qa-publication.mjs";
import {
  dialoguePairBoundAcceptanceCase,
  firstSentenceWithDistinctiveTerms,
  lineWindowBoundAcceptanceCase,
  sentenceBoundAcceptanceCase
} from "./lib/source-bound-acceptance-cases.mjs";

const DEFAULT_BUDGET_BYTES = 5_000_000_000;
const DEFAULT_GUARD_BYTES = 200_000_000;
const RETAINED_QA_FINALIZATION_BOUNDS = Object.freeze({
  maxTotalBytes: 512 * 1024 * 1024,
  maxArticleBytes: 8 * 1024 * 1024,
  maxSourceAttempts: 2048,
  sourcePageSize: 128
});
const RETAINED_QA_EXECUTION = Object.freeze({
  backend: "node_workers.v1",
  workers: 5,
  workerHeapMb: 576,
  coordinatorHeapMb: 512,
  maxNodeRssBytes: 7_000_000_000,
  abortGraceMs: 5_000
});
const STATE_SCHEMA = "scce.multicorpus_5gb_build_state.v1";
const RECEIPT_SCHEMA = "scce.multicorpus_5gb_build_receipt.v1";
const SCRIPT_PATH = fileURLToPath(import.meta.url);

const valueFlags = new Map([
  ["--config", "configPath"], ["--output-config", "outputConfigPath"], ["--database-name", "databaseName"],
  ["--fresh-config", "freshConfigPath"],
  ["--receipt", "receiptPath"], ["--state", "statePath"], ["--wikipedia-dump", "wikipediaDump"],
  ["--wikipedia-index", "wikipediaIndex"], ["--gutenberg", "gutenbergRoot"], ["--dolly", "dollyRoot"],
  ["--oasst", "oasstRoot"], ["--code", "codeRoot"], ["--budget-bytes", "budgetBytes"],
  ["--code-dependency-manifest", "codeDependencyManifestPath"], ["--code-dependency-manifest-hash", "codeDependencyManifestHash"],
  ["--lexical-manifest", "lexicalManifestPath"], ["--lexical-manifest-hash", "lexicalManifestHash"],
  ["--guard-bytes", "guardBytes"], ["--target-bytes", "targetBytes"], ["--heap-checkpoint-mb", "heapCheckpointMb"],
  ["--source-workers", "sourceWorkers"], ["--source-worker-heap-mb", "sourceWorkerHeapMb"],
  ["--max-node-rss-bytes", "maxNodeRssBytes"]
]);

export function parseArguments(args, cwd = process.cwd()) {
  const result = { resume: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === "--resume") {
      if (result.resume) throw new Error("--resume may be supplied once");
      result.resume = true;
      continue;
    }
    if (flag === "--english-only") {
      if (result.englishOnly) throw new Error("--english-only may be supplied once");
      result.englishOnly = true;
      continue;
    }
    const key = valueFlags.get(flag), value = args[index + 1];
    if (!key || !value || value.startsWith("--") || result[key] !== undefined) throw new Error(usage());
    result[key] = value;
    index++;
  }
  const usesExistingFreshConfig = result.freshConfigPath !== undefined;
  if (!result.receiptPath || (usesExistingFreshConfig ? result.configPath || result.outputConfigPath || result.databaseName : !result.configPath || !result.outputConfigPath)) {
    throw new Error(usage());
  }
  const absolute = value => path.resolve(cwd, value);
  const outputConfigPath = absolute(result.freshConfigPath ?? result.outputConfigPath);
  const budgetBytes = positiveInteger(result.budgetBytes ?? DEFAULT_BUDGET_BYTES, "budget-bytes");
  const guardBytes = positiveInteger(result.guardBytes ?? Math.min(DEFAULT_GUARD_BYTES, Math.floor(budgetBytes / 20)), "guard-bytes");
  if (guardBytes >= budgetBytes) throw new Error("guard-bytes must be smaller than budget-bytes");
  const targetBytes = result.targetBytes === undefined ? undefined : positiveInteger(result.targetBytes, "target-bytes");
  if (targetBytes !== undefined && targetBytes > budgetBytes) throw new Error("target-bytes must not exceed budget-bytes");
  let codeDependencyManifest;
  if (result.codeDependencyManifestPath !== undefined || result.codeDependencyManifestHash !== undefined) {
    if (!result.codeDependencyManifestPath || !/^sha256_[a-f0-9]{64}$/u.test(result.codeDependencyManifestHash ?? "")) {
      throw new Error("Code dependency manifest requires a path and canonical sha256_ content hash");
    }
    codeDependencyManifest = { path: absolute(result.codeDependencyManifestPath), contentHash: result.codeDependencyManifestHash };
  }
  let lexicalManifest;
  if (result.lexicalManifestPath !== undefined || result.lexicalManifestHash !== undefined) {
    if (!result.lexicalManifestPath || !/^sha256_[a-f0-9]{64}$/u.test(result.lexicalManifestHash ?? "")) {
      throw new Error("Lexical manifest requires a path and canonical sha256_ content hash");
    }
    lexicalManifest = { path: absolute(result.lexicalManifestPath), contentHash: result.lexicalManifestHash };
  }
  const workerFlags = [result.sourceWorkers, result.sourceWorkerHeapMb, result.maxNodeRssBytes];
  const workerFlagsPresent = workerFlags.filter(value => value !== undefined).length;
  if (workerFlagsPresent !== 0 && workerFlagsPresent !== workerFlags.length) {
    throw new Error("source-workers, source-worker-heap-mb, and max-node-rss-bytes must be supplied together");
  }
  const sourceInductionExecution = workerFlagsPresent === workerFlags.length ? {
    backend: "node_workers.v1",
    workers: positiveInteger(result.sourceWorkers, "source-workers"),
    workerHeapMb: positiveInteger(result.sourceWorkerHeapMb, "source-worker-heap-mb"),
    maxNodeRssBytes: positiveInteger(result.maxNodeRssBytes, "max-node-rss-bytes"),
    abortGraceMs: 10_000
  } : undefined;
  return {
    configPath: absolute(result.freshConfigPath ?? result.configPath), outputConfigPath, receiptPath: absolute(result.receiptPath),
    statePath: absolute(result.statePath ?? `${outputConfigPath}.build-state.json`),
    ...(result.databaseName ? { databaseName: result.databaseName } : {}),
    wikipediaDump: result.wikipediaDump ? absolute(result.wikipediaDump) : undefined,
    wikipediaIndex: result.wikipediaIndex ? absolute(result.wikipediaIndex) : undefined,
    gutenbergRoot: absolute(result.gutenbergRoot ?? path.join(cwd, "..", "fuggit", "corpus", "gutenberg")),
    dollyRoot: absolute(result.dollyRoot ?? path.join(cwd, ".scce", "corpus-bootstrap", "dolly15k-v1", "transcripts")),
    oasstRoot: absolute(result.oasstRoot ?? path.join(cwd, ".scce", "corpus-bootstrap", "oasst1-human-conversations-v1", "train")),
    codeRoot: absolute(result.codeRoot ?? path.join(cwd, ".scce", "corpus-bootstrap", "code-seed-v1", "repos")),
    ...(codeDependencyManifest ? { codeDependencyManifest } : {}),
    ...(lexicalManifest ? { lexicalManifest } : {}),
    budgetBytes, guardBytes, ...(targetBytes === undefined ? {} : { targetBytes }),
    heapCheckpointMb: positiveInteger(result.heapCheckpointMb ?? 7168, "heap-checkpoint-mb"),
    ...(sourceInductionExecution ? { sourceInductionExecution } : {}),
    resume: result.resume, englishOnly: result.englishOnly === true,
    existingFreshConfig: usesExistingFreshConfig, rootPath: path.resolve(cwd)
  };
}

export function mayStartBudgetedBatch(currentBytes, budgetBytes, guardBytes, observedGrowth = 0) {
  const dynamicGuard = Math.max(guardBytes, Math.ceil(Math.max(0, observedGrowth) * 1.5));
  return currentBytes + dynamicGuard < budgetBytes;
}

/** Continue a resumed round-robin after its last committed optional lane. */
export function resumeOrderedSchedule(schedule, batches) {
  const lastLane = [...batches].reverse().find(batch => batch.required === false)?.lane;
  const index = schedule.findIndex(([lane]) => lane === lastLane);
  return index < 0 ? [...schedule] : [...schedule.slice(index + 1), ...schedule.slice(0, index + 1)];
}

export function selectedOasstRoot(options) {
  return options.englishOnly ? path.join(options.oasstRoot, "en") : options.oasstRoot;
}

export function assertResumeCorpusScope(state, options) {
  if (options.resume && JSON.stringify(state.corpusIdentity?.lexicalManifest ?? null) !== JSON.stringify(options.lexicalManifest ?? null)) {
    throw new Error("Resume lexical manifest differs from the original initialization scope");
  }
  if (options.resume && (state.corpusIdentity?.codeDependencyManifest?.path !== options.codeDependencyManifest?.path
    || state.corpusIdentity?.codeDependencyManifest?.contentHash !== options.codeDependencyManifest?.contentHash)) {
    throw new Error("Resume code dependency manifest differs from the original initialization scope");
  }
  const previous = state?.selection?.englishOnly;
  if (options.resume && typeof previous === "boolean" && previous !== (options.englishOnly === true)) {
    throw new Error("Resume english-only scope differs from the original brain build");
  }
}

export async function buildFiveGbMulticorpusBrain(options) {
  await verifyBrainBuildPrerequisites(options);
  const lexicalResources = options.lexicalManifest ? await loadPinnedLexicalManifest(options.lexicalManifest) : [];
  const adapters = await import("../packages/adapters-node/dist/index.js");
  const kernel = await import("../packages/kernel/dist/index.js");
  const lexicalReader = lexicalResources.length ? await import("../packages/adapters-node/dist/lexical-corpus-store.js") : undefined;
  if (lexicalResources.length && ["ingestUdLexicalCorpus", "ingestWordnetCorpus", "readWordnetLmf", "languageCorpusTrainingRecipeId"]
    .some(name => typeof adapters[name] !== "function")) {
    throw prerequisiteFailure("built lexical corpus adapters", options.rootPath, "rebuild the packages before starting this initialization");
  }
  let state;
  if (options.resume) {
    state = JSON.parse(await readFile(options.statePath, "utf8"));
    validateResumeState(state, options);
  } else if (!options.existingFreshConfig) {
    const created = await createBrainDatabase({ config: options.configPath, outputConfig: options.outputConfigPath, databaseName: options.databaseName });
    state = initialState(options, created.databaseName);
    await persistState(options, state);
  } else {
    const databaseName = await verifyExistingFreshDatabase(options.outputConfigPath, adapters);
    state = initialState(options, databaseName);
    await persistState(options, state);
  }
  assertResumeCorpusScope(state, options);
  state.selection = { ...state.selection, englishOnly: options.englishOnly === true };
  if (state.targetBytes !== undefined && state.targetBytes !== null && state.targetBytes !== options.targetBytes) {
    throw new Error("Resume target-bytes differs from the original initialization target");
  }
  state.targetBytes = options.targetBytes ?? state.targetBytes ?? null;

  const config = await adapters.readScceRuntimeConfig(options.outputConfigPath);
  const storage = adapters.createPostgresStorageAdapter({ ...config.database, informationAccess: config.security?.informationAccess });
  const label = ownerPrivateLabel(config);
  const wikipedia = config.runtime.corpora?.wikipedia;
  const dumpPath = path.resolve(options.wikipediaDump ?? wikipedia?.dumpPath ?? "");
  const indexPath = options.wikipediaIndex ?? wikipedia?.indexPath;
  if (!dumpPath || dumpPath === options.rootPath || !wikipedia?.enabled) throw new Error("An enabled configured Wikipedia corpus and local dump are required");
  await assertRegularFile(dumpPath, "Wikipedia dump");
  if (indexPath) await assertRegularFile(indexPath, "Wikipedia multistream index");

  const sourceInductionExecution = options.sourceInductionExecution ?? config.runtime.sourceInductionExecution;
  const sourceInductionExecutionOwner = sourceInductionExecution
    ? adapters.createSourceInductionExecution({ policy: sourceInductionExecution })
    : undefined;
  const settings = {
    corpusSegmentation: config.runtime.corpusSegmentation,
    sourceInductionExecution,
    ...(sourceInductionExecutionOwner ? { sourceInductionExecutionOwner } : {}),
    ngramMaxOrder: wikipedia.ngramMaxOrder ?? 4,
    ngramMaxCountersPerOrder: wikipedia.ngramMaxCountersPerOrder ?? 12_000,
    ngramVocabularyLimit: wikipedia.ngramVocabularyLimit ?? 24_000,
    heapCheckpointMb: options.heapCheckpointMb
  };
  const api = {
    storage, config, label, settings, adapters, kernel, dumpPath,
    ...(lexicalReader ? { readLexicalSource: lexicalReader.readBoundedLexicalCorpusSource } : {}),
    ...(indexPath ? { indexPath: path.resolve(indexPath) } : {})
  };
  const identityRuntime = kernel.createLanguageIdentityRuntime({ store: storage.languageIdentities,
    hasher: kernel.createHasher(), now: Date.now, informationLabel: config.security?.defaultSourceInformationLabel });

  let primaryFailure;
  try {
    const starting = await databaseMeasurement(storage);
    if (starting.databaseBytes >= options.budgetBytes) throw new Error("Fresh brain schema already meets or exceeds the database budget");
    state.measurements.push({ stage: "open", at: new Date().toISOString(), ...starting });
    await checkpoint(options, state, starting);

    // Every required lane earns one committed batch before any lane is allowed to fill the remaining budget.
    const requiredOasstRoot = selectedOasstRoot(options);
    const required = [
      ["gutenberg", () => trainGutenbergBatch(options, state, api, 1)],
      ["dolly", () => trainDialogueBatch("dolly", options.dollyRoot, options, state, api, 1)],
      ["oasst", () => trainDialogueBatch("oasst", requiredOasstRoot, options, state, api, 1)],
      ["code", () => trainCodeBatch(options, state, api, 1)],
      ["wikipedia", () => trainWikipediaBatch(options, state, api, 2)]
    ];
    for (const [lane, operation] of required) {
      while (!state.lanes[lane].included) {
        if (state.lanes[lane].exhausted) throw new Error(`Required corpus lane has no successfully trained source: ${lane}`);
        await committedBatch(lane, true, operation, options, state, storage);
      }
    }
    if (lexicalResources.length) {
      state.finalization = { ...state.finalization, beforeLexical: await finalizeBuildLanguageIdentities(state, api, identityRuntime) };
      await checkpoint(options, state, await databaseMeasurement(storage));
      for (const resource of lexicalResources) await publishPinnedLexicalResource(resource, options, state, api);
    }

    const schedule = resumeOrderedSchedule([
      ["gutenberg", () => trainGutenbergBatch(options, state, api, 1)],
      ["dolly", () => trainDialogueBatch("dolly", options.dollyRoot, options, state, api, 8)],
      ["code", () => trainCodeBatch(options, state, api, 50)],
      ...(options.englishOnly ? [] : [["oasst", () => trainDialogueBatch("oasst", options.oasstRoot, options, state, api, 8)]]),
      ["wikipedia", () => trainWikipediaBatch(options, state, api, 20)]
    ], state.batches);
    let progressed = true;
    while (progressed) {
      progressed = false;
      for (const [lane, operation] of schedule) {
        if (state.lanes[lane].exhausted) continue;
        const current = await databaseMeasurement(storage);
        if (completionTargetReached(current.databaseBytes, state.targetBytes)) {
          state.stopReason = "completion_target_reached";
          break;
        }
        const observed = maximumLaneGrowth(state, lane);
        if (!mayStartBudgetedBatch(current.databaseBytes, options.budgetBytes, options.guardBytes, observed)) {
          state.stopReason = "database_budget_guard";
          break;
        }
        const result = await committedBatch(lane, false, operation, options, state, storage);
        progressed ||= result.progressed;
      }
      if (state.stopReason === "database_budget_guard") break;
    }

    if (!state.reports.length) throw new Error("No language-training reports were committed");
    state.finalization = { ...state.finalization, languageIdentities: await finalizeBuildLanguageIdentities(state, api, identityRuntime) };
    const selectedItems = adapters.sourceBrainSelectedItemsFromReports(state.reports);
    const selectedIds = selectedItems.map(item => item.sourceVersionId);
    const retainedQa = await runStoredDialogueQaPublication({
      storage, adapters, kernel, databaseSchema: config.database.schema,
      createVerificationStorage: async () => adapters.createPostgresStorageAdapter({
        ...config.database,
        informationAccess: config.security?.informationAccess
      }),
      ...RETAINED_QA_FINALIZATION_BOUNDS,
      contextualQaExecution: RETAINED_QA_EXECUTION
    });
    state.finalization = { ...state.finalization, contextualQa: retainedQa.result };
    const finalizationMeasurement = await databaseMeasurement(storage);
    state.measurements.push({ stage: "retained_dialogue_qa_published", at: new Date().toISOString(), ...finalizationMeasurement });
    await checkpoint(options, state, finalizationMeasurement, selectedItems);
    assertStoredDialogueQaPublication(retainedQa.result);
    if (finalizationMeasurement.databaseBytes > options.budgetBytes) {
      throw new Error("Retained dialogue publication exceeded the hard physical budget");
    }
    const configuration = {
      schema: "scce.multicorpus_5gb_configuration.v1", budgetBytes: options.budgetBytes, guardBytes: options.guardBytes,
      targetBytes: state.targetBytes,
      selection: { englishOnly: options.englishOnly === true },
      ...(options.lexicalManifest ? { lexicalManifest: options.lexicalManifest, lexicalResources } : {}),
      finalization: { contextualQa: {
        required: true,
        compilerFingerprints: [...new Set(retainedQa.result.components.map(item => item.compilerFingerprint))].sort(),
        coldVerifiedPatternIds: retainedQa.result.coldVerifiedPatternIds
      } },
      corpora: Object.fromEntries(Object.entries(state.lanes).map(([name, lane]) => [name, {
        batches: lane.batches, trainedReports: lane.trainedReports, exhausted: lane.exhausted,
        ...(name === "code" ? codeTrainingReadiness(lane) : {})
      }]))
    };
    const sourceId = `multicorpus-5gb:${state.databaseName}`;
    const sourceSchema = "scce.multicorpus.5gb.v1";
    const sourceManifestHash = adapters.sourceBrainInputManifestHash({ sourceId, sourceSchema, selectedItems, configuration });
    const completed = await adapters.completeInitialSourceBrainBuild({
      storage, informationLabel: label, sourceId, sourceSchema, rootPath: options.rootPath, sourceManifestHash,
      selectedItems, reports: state.reports, configuration, activate: true,
      completion: { explicitSelection: true, selectedItemIds: selectedIds, completedItemIds: selectedIds,
        stoppedByHeapSafetyBound: false, interrupted: false, skippedRequiredItemIds: [] }
    });
    if (!completed.active || completed.report.disposition !== "PASSED") throw new Error("Unified source brain did not pass validation and activate");
    state.sourceBrain = adapters.sourceBrainBuildReceipt(completed);
    await finalizeBuildLanguageIdentities(state, api, identityRuntime);
    state.finalization.languageIdentities = await kernel.inspectLanguageIdentityFinalization({
      store: storage.languageIdentities, runtime: identityRuntime, hasher: kernel.createHasher(),
      readRevision: storage.languageMemory.readRevision?.bind(storage.languageMemory),
      synchronize: async () => { await identityRuntime.ensure(); }, activeBrain: () => storage.brainImports.active()
    });
    if (!state.finalization.languageIdentities.ready) throw new Error("Completed brain lacks stable current language identity finalization");
    const finalMeasurement = await databaseMeasurement(storage);
    if (finalMeasurement.databaseBytes > options.budgetBytes) throw new Error("Final database exceeded the hard physical budget");
    state.acceptanceCases = await acceptanceCases(state, options, storage);
    validateAcceptanceCases(state.acceptanceCases);
    delete state.lastFailure;
    state.status = "complete";
    state.completedAt = new Date().toISOString();
    state.measurements.push({ stage: "complete", at: state.completedAt, ...finalMeasurement });
    await checkpoint(options, state, finalMeasurement, selectedItems);
    return publicReceipt(state, finalMeasurement, selectedItems);
  } catch (error) {
    primaryFailure = error;
    if (!state.lastFailure) {
      state.status = "building";
      state.lastFailure = { lane: "finalization", at: new Date().toISOString(),
        failureCode: typeof error?.code === "string" ? error.code : error?.name ?? "Error", message: String(error?.message ?? error).slice(0, 500) };
      try { await checkpoint(options, state, await databaseMeasurement(storage)); } catch { /* preserve the original failure */ }
    }
    throw error;
  } finally {
    let cleanupFailure;
    try { await sourceInductionExecutionOwner?.close(primaryFailure); } catch (error) { cleanupFailure = error; }
    try { await storage.close(); } catch (error) { cleanupFailure ??= error; }
    if (primaryFailure === undefined && cleanupFailure !== undefined) throw cleanupFailure;
  }
}

async function fileContentHash(target) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(target)) hash.update(chunk);
  return `sha256_${hash.digest("hex")}`;
}

export async function loadPinnedLexicalManifest(pin) {
  await assertRegularFile(pin.path, "lexical manifest");
  const bytes = await readFile(pin.path);
  if (`sha256_${createHash("sha256").update(bytes).digest("hex")}` !== pin.contentHash) {
    throw prerequisiteFailure("lexical manifest", pin.path, "content hash differs from its declared pin");
  }
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (manifest?.schema !== "scce.initial_lexical_resources.v1" || !Array.isArray(manifest.resources) || !manifest.resources.length) {
    throw new Error("Lexical manifest requires schema scce.initial_lexical_resources.v1 and nonempty resources");
  }
  const ids = new Set(), uris = new Set(), paths = new Set();
  const resources = [];
  for (const row of manifest.resources) {
    for (const key of ["id", "path", "sourceUri", "lexiconId", "language", "license"]) {
      if (typeof row?.[key] !== "string" || !row[key].trim()) throw new Error(`Lexical manifest resource requires ${key}`);
    }
    if (!["conllu", "wordnet"].includes(row.format) || !/^sha256_[a-f0-9]{64}$/u.test(row.contentHash ?? "")) {
      throw new Error("Lexical resource requires format conllu or wordnet and a canonical sha256_ content hash");
    }
    const resource = { id: row.id, path: path.resolve(path.dirname(pin.path), row.path), sourceUri: row.sourceUri,
      contentHash: row.contentHash, format: row.format, lexiconId: row.lexiconId, language: row.language, license: row.license,
      maxSourceBytes: positiveInteger(row.maxSourceBytes, "lexical maxSourceBytes"),
      ...(row.maxDatabaseGrowthBytes === undefined ? {} : {
        maxDatabaseGrowthBytes: positiveInteger(row.maxDatabaseGrowthBytes, "lexical maxDatabaseGrowthBytes") }) };
    if (ids.has(resource.id) || uris.has(resource.sourceUri) || paths.has(resource.path)) throw new Error("Lexical manifest repeats a resource identity, URI, or path");
    ids.add(resource.id); uris.add(resource.sourceUri); paths.add(resource.path);
    await verifyPinnedLexicalResource(resource);
    resources.push(resource);
  }
  return resources;
}

async function verifyPinnedLexicalResource(resource) {
  await assertRegularFile(resource.path, `lexical resource ${resource.id}`);
  if ((await stat(resource.path)).size > resource.maxSourceBytes) {
    throw prerequisiteFailure("lexical resource", resource.path, "encoded bytes exceed maxSourceBytes");
  }
  if (await fileContentHash(resource.path) !== resource.contentHash) {
    throw prerequisiteFailure("lexical resource", resource.path, "content hash differs from its declared pin");
  }
}

export async function finalizeBuildLanguageIdentities(state, api, runtime) {
  const result = await api.storage.transaction(() => runtime.ensure({ finalize: true, initializeIfMissing: true,
    requiredProfileIds: [...new Set(state.reports.map(report => report.artifacts.languageProfileId))] }));
  if (result.readiness !== "ready" || !result.identities.length) throw new Error("Language identity finalization is not ready");
  return { readiness: result.readiness, identities: result.identities.length, assigned: result.assigned, discovered: result.discovered };
}

export async function trainPinnedLexicalResource(resource, state, api) {
  await verifyPinnedLexicalResource(resource);
  if (!api.config.security?.informationAccess || !api.config.security?.defaultSourceInformationLabel) {
    throw new Error("Lexical initialization requires configured information access and source label");
  }
  const text = await api.readLexicalSource({ path: resource.path, maxSourceBytes: resource.maxSourceBytes });
  await verifyPinnedLexicalResource(resource);
  if (resource.format === "wordnet") {
    const parsed = api.adapters.readWordnetLmf(text);
    if (["lexiconId", "language", "license"].some(key => parsed[key] !== resource[key])) {
      throw new Error(`Lexical resource ${resource.id} WN-LMF declaration differs from the pinned identity, language, or license`);
    }
  }
  const ingest = resource.format === "conllu" ? api.adapters.ingestUdLexicalCorpus : api.adapters.ingestWordnetCorpus;
  const previousCheckpoints = await api.storage.ingestion.list({ rootUri: resource.sourceUri, status: "complete", phase: "stored" });
  const result = await ingest({ storage: api.storage, text, sourceUri: resource.sourceUri,
    maxSourceBytes: resource.maxSourceBytes, lexiconId: resource.lexiconId, language: resource.language, license: resource.license,
    informationLabel: api.config.security.defaultSourceInformationLabel });
  if (result.status !== "complete" || result.checkpointed !== true || ["lexiconId", "language", "license"].some(key => result[key] !== resource[key])) {
    throw new Error(`Lexical resource ${resource.id} did not complete its pinned ordinary corpus checkpoint`);
  }
  const checkpoints = await api.storage.ingestion.list({ rootUri: resource.sourceUri, status: "complete", phase: "stored" });
  const reports = checkpoints.map(row => row.metadata?.report).filter(report => report?.sourceVersionId === result.sourceVersionId
    && report.originalSourceVersionId === result.annotationSourceVersionId && report.sourceContentHash === result.contentHash
    && report.artifacts?.languageProfileId === result.profileId);
  if (reports.length !== 1) throw new Error(`Lexical resource ${resource.id} lacks one exact durable language-training report`);
  const report = reports[0];
  const previous = state.reports.find(row => row.sourceVersionId === report.sourceVersionId);
  if (previous && JSON.stringify(previous) !== JSON.stringify(report)) throw new Error("Lexical checkpoint report changed during replay");
  if (!previous) state.reports.push(report);
  state.lexicalResources ??= {};
  const replayed = previousCheckpoints.some(row => JSON.stringify(row.metadata?.report) === JSON.stringify(report));
  state.lexicalResources[resource.id] = { input: resource, ...result, replayed, sourceBytes: Buffer.byteLength(text) };
  return state.lexicalResources[resource.id];
}

export async function replayPinnedLexicalResource(resource, state, api) {
  await verifyPinnedLexicalResource(resource);
  const receipt = state.lexicalResources?.[resource.id];
  if (!receipt || JSON.stringify(receipt.input) !== JSON.stringify(resource) || receipt.status !== "complete" || !receipt.checkpointed) {
    throw new Error(`Lexical resource ${resource.id} has no matching completed initialization receipt`);
  }
  const rows = await api.storage.ingestion.list({ rootUri: resource.sourceUri, status: "complete", phase: "stored" });
  const matching = rows.filter(row => row.metadata?.report?.sourceVersionId === receipt.sourceVersionId
    && row.metadata.report.originalSourceVersionId === receipt.annotationSourceVersionId
    && row.metadata.report.sourceContentHash === receipt.contentHash
    && row.metadata.report.artifacts?.languageProfileId === receipt.profileId);
  if (matching.length !== 1) throw new Error(`Lexical resource ${resource.id} lacks its exact durable checkpoint`);
  const checkpoint = matching[0], report = checkpoint.metadata.report, canonical = api.kernel.canonicalStringify;
  if (checkpoint.metadata.compilerRecipe !== api.adapters.languageCorpusTrainingRecipeId("workspace")
    || checkpoint.metadata.batchRecipe !== api.kernel.LANGUAGE_TRAINING_BATCH_RECIPE_ID
    || !state.reports.some(row => canonical(row) === canonical(report))) {
    throw new Error(`Lexical resource ${resource.id} has stale compiler recipes or a changed checkpoint report`);
  }
  const currentRecipes = new Map(resource.format === "wordnet"
    ? [[api.kernel.LEXICAL_SENSE_SCHEMA, api.kernel.LEXICAL_SENSE_RECIPE]]
    : [[api.kernel.LEXICAL_GRAMMAR_SCHEMA, api.kernel.LEXICAL_GRAMMAR_RECIPE],
      [api.kernel.SOURCE_QUESTION_FRAME_SCHEMA, api.kernel.SOURCE_QUESTION_FRAME_RECIPE]]);
  const projections = report.sourceOwnedPatternProjections;
  const requiredSchema = resource.format === "wordnet" ? api.kernel.LEXICAL_SENSE_SCHEMA : api.kernel.LEXICAL_GRAMMAR_SCHEMA;
  if (!projections?.length || !projections.some(row => row.patternSchema === requiredSchema)
    || projections.some(row => !currentRecipes.has(row.patternSchema) || currentRecipes.get(row.patternSchema) !== row.componentRecipe
      || checkpoint.metadata.componentRecipes?.[`sourceOwned:${row.patternSchema}`] !== row.componentRecipe)) {
    throw new Error(`Lexical resource ${resource.id} has missing or stale source-owned projection recipes`);
  }
  if (!api.config.security?.informationAccess || !api.config.security?.defaultSourceInformationLabel
    || projections.some(row => canonical(row.informationLabel) !== canonical(api.kernel.normalizeInformationLabel(api.config.security.defaultSourceInformationLabel)))) {
    throw new Error(`Lexical resource ${resource.id} no longer matches its configured source information label`);
  }
  for (const projection of projections) {
    const active = await api.storage.languageMemory.getLanguagePatternProjection?.(projection);
    if (!active || canonical(active) !== canonical(projection) || !projection.patternIds.length) {
      throw new Error(`Lexical resource ${resource.id} lacks its complete active projection header`);
    }
    const patterns = await api.storage.languageMemory.listLanguagePatterns({ view: "request_seed", patternIds: projection.patternIds,
      limit: projection.patternIds.length });
    if (canonical(patterns.map(row => row.id).sort()) !== canonical([...projection.patternIds].sort())) {
      throw new Error(`Lexical resource ${resource.id} lacks its complete active projection patterns`);
    }
  }
  receipt.replayed = true;
  return receipt;
}

export async function publishPinnedLexicalResource(resource, options, state, api) {
  const before = await databaseMeasurement(api.storage);
  try {
    const replay = Boolean(state.lexicalResources?.[resource.id]);
    if (!replay && (!mayStartBudgetedBatch(before.databaseBytes, options.budgetBytes, options.guardBytes)
      || resource.maxDatabaseGrowthBytes !== undefined && before.databaseBytes + resource.maxDatabaseGrowthBytes >= options.budgetBytes)) {
      throw new Error(`Lexical resource ${resource.id} cannot start within the physical database budget and guard`);
    }
    const result = replay ? await replayPinnedLexicalResource(resource, state, api) : await trainPinnedLexicalResource(resource, state, api);
    const after = await databaseMeasurement(api.storage);
    if (after.databaseBytes > options.budgetBytes || resource.maxDatabaseGrowthBytes !== undefined
      && after.databaseBytes - before.databaseBytes > resource.maxDatabaseGrowthBytes) {
      throw new Error(`Lexical resource ${resource.id} exceeded its declared database growth bound or hard physical budget`);
    }
    state.batches.push({ lane: "lexical", required: true, at: new Date().toISOString(), beforeBytes: before.databaseBytes,
      afterBytes: after.databaseBytes, growthBytes: Math.max(0, after.databaseBytes - before.databaseBytes), details: result });
    state.measurements.push({ stage: `lexical:${resource.id}`, at: new Date().toISOString(), ...after });
    delete state.lastFailure;
    await checkpoint(options, state, after);
  } catch (error) {
    const after = await databaseMeasurement(api.storage);
    state.lastFailure = { lane: "lexical", resourceId: resource.id, at: new Date().toISOString(),
      failureCode: typeof error?.code === "string" ? error.code : error?.name ?? "Error", message: String(error.message).slice(0, 500),
      beforeBytes: before.databaseBytes, afterBytes: after.databaseBytes };
    await checkpoint(options, state, after);
    throw error;
  }
}

async function committedBatch(lane, required, operation, options, state, storage) {
  const before = await databaseMeasurement(storage);
  if (!required && !mayStartBudgetedBatch(before.databaseBytes, options.budgetBytes, options.guardBytes, maximumLaneGrowth(state, lane))) {
    return { progressed: false };
  }
  const reportCount = state.reports.length;
  const cursorBefore = state.lanes[lane].cursor;
  let result;
  try {
    result = await operation();
  } catch (error) {
    let after = before;
    try { after = await databaseMeasurement(storage); } catch { /* retain the last trustworthy measurement */ }
    state.lastFailure = {
      lane,
      at: new Date().toISOString(),
      cursor: cursorBefore,
      failureCode: typeof error?.code === "string" ? error.code : error?.name ?? "Error",
      message: String(error?.message ?? error).slice(0, 500),
      beforeBytes: before.databaseBytes,
      afterBytes: after.databaseBytes
    };
    state.measurements.push({ stage: `${lane}_failed`, at: state.lastFailure.at, ...after });
    await checkpoint(options, state, after);
    throw error;
  }
  const after = await databaseMeasurement(storage);
  const growthBytes = Math.max(0, after.databaseBytes - before.databaseBytes);
  delete state.lastFailure;
  state.lanes[lane].batches++;
  state.lanes[lane].trainedReports += state.reports.length - reportCount;
  state.lanes[lane].included ||= result.included ?? state.reports.length > reportCount;
  state.batches.push({ lane, required, at: new Date().toISOString(), beforeBytes: before.databaseBytes,
    afterBytes: after.databaseBytes, growthBytes, trainedReports: state.reports.length - reportCount, details: result.details });
  state.measurements.push({ stage: lane, at: new Date().toISOString(), ...after });
  if (after.databaseBytes > options.budgetBytes) throw new Error(`Database exceeded its hard physical budget after the bounded ${lane} batch`);
  await checkpoint(options, state, after);
  return { progressed: result.progressed || state.reports.length > reportCount };
}

export async function trainGutenbergBatch(options, state, api, maxFilesPerRun) {
  const lane = state.lanes.gutenberg;
  const report = await api.adapters.trainGutenbergCorpus({ storage: api.storage, rootPath: options.gutenbergRoot,
    startFileIndex: lane.cursor, maxFilesPerRun, ...api.settings });
  assertCorpusSkipsAdmissible("gutenberg", report.filesSkipped);
  state.reports.push(...report.reports);
  const advanced = report.filesTrained + report.filesSkipped.length;
  lane.cursor += advanced;
  lane.exhausted = advanced < maxFilesPerRun && !report.stoppedByHeapSafetyBound;
  if (report.stoppedByHeapSafetyBound && advanced === 0) throw new Error("Gutenberg heap checkpoint made no progress");
  return { progressed: advanced > 0, details: { cursor: lane.cursor, filesTrained: report.filesTrained,
    filesSkipped: report.filesSkipped, stoppedByHeapSafetyBound: report.stoppedByHeapSafetyBound } };
}

export function completionTargetReached(currentBytes, targetBytes) {
  return Number.isSafeInteger(currentBytes) && currentBytes >= 0
    && Number.isSafeInteger(targetBytes) && targetBytes > 0
    && currentBytes >= targetBytes;
}

export async function trainDialogueBatch(name, rootPath, options, state, api, maxFilesPerRun) {
  const lane = state.lanes[name];
  const report = await api.adapters.trainDialogueCorpus({ storage: api.storage, rootPath, informationLabel: api.label,
    authorship: "human_authored", startFileIndex: lane.cursor, maxFilesPerRun, ...api.settings });
  assertCorpusSkipsAdmissible(name, report.filesSkipped);
  state.reports.push(...report.reports);
  const advanced = report.filesTrained + report.filesSkipped.length;
  lane.cursor += advanced;
  lane.exhausted = advanced < maxFilesPerRun && !report.stoppedByHeapSafetyBound;
  if (report.stoppedByHeapSafetyBound && advanced === 0) throw new Error(`${name} heap checkpoint made no progress`);
  return { progressed: advanced > 0, details: { cursor: lane.cursor, filesTrained: report.filesTrained,
    filesSkipped: report.filesSkipped, stoppedByHeapSafetyBound: report.stoppedByHeapSafetyBound } };
}

export async function trainCodeBatch(options, state, api, maxFilesPerRun) {
  const lane = state.lanes.code;
  const report = await api.adapters.trainOssCorpus({ storage: api.storage, rootPath: options.codeRoot,
    startFileIndex: lane.cursor, maxFilesPerRun, maxFilesPerRepo: 100_000, includeDocs: true, includeSource: true,
    ...(options.codeDependencyManifest ? { dependencyManifest: options.codeDependencyManifest } : {}),
    ...(lane.snapshotHash ? { expectedSnapshotHash: lane.snapshotHash } : {}), ...api.settings });
  assertCorpusSkipsAdmissible("code", report.filesSkipped);
  if (!Number.isSafeInteger(report.filesTotal) || report.filesTotal < 0
    || !Number.isSafeInteger(report.nextFileIndex) || report.nextFileIndex < lane.cursor || report.nextFileIndex > report.filesTotal) {
    throw new Error("Code corpus report has an invalid pinned acquisition cursor");
  }
  const acquisitionComplete = report.snapshotComplete === true && report.inspectionTruncated !== true
    && report.nextFileIndex === report.filesTotal;
  if (report.trainingComplete === true && (!acquisitionComplete || report.stoppedByHeapSafetyBound
    || report.sourceContractClosure?.complete !== true)) throw new Error("Code training completion lacks complete acquisition and project closure");
  lane.snapshotHash ??= report.snapshotHash;
  if (lane.snapshotHash !== report.snapshotHash) throw new Error("Code corpus snapshot changed during the build");
  state.reports.push(...report.reports);
  const advanced = report.nextFileIndex - lane.cursor;
  const dependencyProgress = (report.contextAcquisition?.preacquiredPaths.length ?? 0) > 0;
  const previousClosure = lane.projectClosure;
  const closure = report.sourceContractClosure;
  lane.cursor = report.nextFileIndex;
  lane.acquisitionComplete = acquisitionComplete;
  lane.trainingComplete = report.trainingComplete === true;
  lane.exhausted = lane.trainingComplete;
  if (advanced > 0 || dependencyProgress) delete lane.closureSweepStart;
  let closureProgress = false;
  if (closure) {
    const published = closure.roots.some(root => root.status === "compiled");
    if (published) delete lane.closureSweepStart;
    if (acquisitionComplete && !closure.complete) {
      lane.closureSweepStart ??= { round: closure.round, cursor: closure.nextCandidateIndex };
      const start = lane.closureSweepStart;
      const swept = closure.round > start.round + 1
        || closure.round > start.round && closure.nextCandidateIndex >= start.cursor;
      closureProgress = !swept && (closure.round !== (previousClosure?.round ?? 0)
        || closure.nextCandidateIndex !== (previousClosure?.nextCandidateIndex ?? 0));
    }
    closureProgress ||= published;
    lane.projectClosure = structuredClone(closure);
  }
  if (report.stoppedByHeapSafetyBound && advanced === 0 && !dependencyProgress && !report.reports.length) {
    throw new Error("Code heap checkpoint made no progress");
  }
  return { progressed: advanced > 0 || dependencyProgress || closureProgress, included: report.reports.some(item => item.sourceSystem === "oss_code"), details: { cursor: lane.cursor,
    ...codeTrainingReadiness(lane), codeTrained: report.codeTrained,
    docsTrained: report.docsTrained, filesSkipped: report.filesSkipped, stoppedByHeapSafetyBound: report.stoppedByHeapSafetyBound,
    contextAcquisition: report.contextAcquisition ?? null } };
}

function codeTrainingReadiness(lane) {
  return { acquisitionComplete: lane.acquisitionComplete ?? false, trainingComplete: lane.trainingComplete ?? false,
    projectClosure: lane.projectClosure ?? null };
}

async function trainWikipediaBatch(options, state, api, maxPages) {
  const lane = state.lanes.wikipedia;
  const ingestor = api.adapters.createWikipediaV3Ingestor({ storage: api.storage, config: api.config });
  const acquisition = await ingestor.ingest({ acquireOnly: true, dumpPath: api.dumpPath,
    ...(api.indexPath ? { indexPath: api.indexPath } : {}), maxPages, resume: true,
    memorySafetyBoundMb: api.config.runtime.corpora.wikipedia.memorySafetyBoundMb,
    heapCheckpointMb: options.heapCheckpointMb });
  lane.pages += acquisition.pages;
  lane.sources += acquisition.sources;
  const sourceSystems = [api.kernel.CORPUS_SOURCE_SYSTEM_IDS.wikipedia,
    api.kernel.corpusSourceAlias(api.kernel.CORPUS_SOURCE_SYSTEM_IDS.wikipedia)];
  const inventory = await api.storage.evidence.listEvidenceBackedSourceVersions({ sourceSystems,
    excludeTrainingDerived: true, orderBySourceVersionId: true, minByteLength: 0, maxByteLength: 2_000_000, limit: 100_000 });
  const trained = new Set(lane.trainedSourceVersionIds);
  const pending = inventory.filter(item => !trained.has(String(item.sourceVersionId))).slice(0, Math.max(1, maxPages * 2));
  let replay;
  if (pending.length) {
    replay = await api.adapters.trainStoredCorpusConstructions({ storage: api.storage,
      sourceSystem: api.kernel.CORPUS_SOURCE_SYSTEM_IDS.wikipedia, sourceVersionIds: pending.map(item => String(item.sourceVersionId)),
      maxTotalBytes: Math.max(1024, pending.reduce((sum, item) => sum + item.byteLength, 0) + 1024),
      maxSourceAttempts: pending.length, sourcePageSize: pending.length, batchBytes: 1024 * 1024,
      minArticleBytes: 0, maxArticleBytes: 2_000_000, languageOnly: true, ...api.settings });
    assertWikipediaReplaySucceeded(replay);
    if (replay.stoppedByHeapSafetyBound && replay.reports.length === 0) {
      throw new Error("Wikipedia language-training heap checkpoint made no progress");
    }
    state.reports.push(...replay.reports);
    for (const report of replay.reports) trained.add(String(report.sourceVersionId));
    lane.trainedSourceVersionIds = [...trained].sort();
  }
  lane.exhausted = acquisition.pages === 0 && pending.length === 0;
  if (acquisition.pages > 0 && (!replay || replay.reports.length === 0)) throw new Error("Wikipedia acquisition produced no trainable language report");
  return { progressed: acquisition.pages > 0 || Boolean(replay?.reports.length), details: {
    pagesAcquired: acquisition.pages, sourcesAcquired: acquisition.sources, pagesTotal: lane.pages,
    reportsTrained: replay?.reports.length ?? 0, stoppedByHeapSafetyBound: acquisition.stoppedByHeapSafetyBound || replay?.stoppedByHeapSafetyBound === true
  } };
}

const ADMISSIBLE_CORPUS_SKIPS = Object.freeze({
  gutenberg: new Set(["empty_after_boilerplate_strip"]),
  dolly: new Set(["empty_file"]),
  oasst: new Set(["empty_file"]),
  code: new Set([
    "archive_file",
    "binary_file",
    "empty_language_training_projection",
    "generated_or_dependency_directory",
    "not_language_training_material"
  ])
});

/** Empty or unsupported material may be recorded; supported material that failed to train aborts without cursor advance. */
export function assertCorpusSkipsAdmissible(lane, skipped) {
  const admissible = ADMISSIBLE_CORPUS_SKIPS[lane];
  if (!admissible || !Array.isArray(skipped)) throw new Error(`Invalid ${lane} corpus training report`);
  const failures = skipped.filter(item => !item || typeof item.path !== "string" || !item.path
    || typeof item.reason !== "string" || !admissible.has(item.reason));
  if (!failures.length) return skipped;
  const first = failures[0] ?? {};
  const error = new Error(`${lane} corpus source did not train at ${String(first.path ?? "unknown").slice(0, 200)}: ${String(first.reason ?? "invalid skip record").slice(0, 300)}`);
  error.code = "SCCE_MULTICORPUS_SOURCE_TRAINING_FAILED";
  error.corpusLane = lane;
  error.failures = failures.slice(0, 16);
  throw error;
}

function assertWikipediaReplaySucceeded(report) {
  const failures = [
    ...(Array.isArray(report?.batchesFailed) ? report.batchesFailed : [{ reason: "missing batchesFailed" }]),
    ...(Array.isArray(report?.sourcesSkipped) ? report.sourcesSkipped : [{ reason: "missing sourcesSkipped" }]),
    ...(report?.storageFailure ? [report.storageFailure] : []),
    ...(report?.stoppedByInterruption ? [{ reason: "interrupted" }] : [])
  ];
  if (!failures.length) return report;
  const first = failures[0] ?? {};
  const error = new Error(`Wikipedia source did not train: ${String(first.reason ?? "invalid replay report").slice(0, 400)}`);
  error.code = "SCCE_MULTICORPUS_SOURCE_TRAINING_FAILED";
  error.corpusLane = "wikipedia";
  error.failures = failures.slice(0, 16);
  throw error;
}

async function databaseMeasurement(storage) {
  const [database] = await storage.query("SELECT pg_database_size(current_database())::text AS bytes");
  const tables = await storage.query(
    "SELECT c.relname AS name,pg_total_relation_size(c.oid)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','m') ORDER BY pg_total_relation_size(c.oid) DESC,c.relname ASC",
    [storage.schema]
  );
  return { databaseBytes: Number(database.bytes), largestTables: tables.slice(0, 20).map(row => ({ name: row.name, bytes: Number(row.bytes) })) };
}

async function verifyExistingFreshDatabase(configPath, adapters) {
  const config = await adapters.readScceRuntimeConfig(configPath);
  const url = new URL(config.database.url);
  if (!["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)) throw new Error("Existing fresh brain must use local PostgreSQL");
  const storage = adapters.createPostgresStorageAdapter({ ...config.database, informationAccess: config.security?.informationAccess });
  try {
    if (!(await storage.verify()).ok) throw new Error("Existing fresh brain schema verification failed");
    const tables = ["sources", "source_versions", "evidence_spans", "language_profiles", "ngram_models", "language_units", "language_patterns", "semantic_frames", "brain_import_lifecycle"];
    for (const table of tables) {
      const [row] = await storage.query(`SELECT count(*)::text AS count FROM ${storage.table(table)}`);
      if (row.count !== "0") throw new Error(`Existing fresh brain is not empty: ${table}`);
    }
    return decodeURIComponent(url.pathname.slice(1));
  } finally { await storage.close(); }
}

async function acceptanceCases(state, options, storage) {
  const cases = [];
  const first = (sourceSystem, predicate = () => true) => state.reports.find(row => row.sourceSystem === sourceSystem && predicate(row));
  const bindings = async report => {
    const source = await storage.evidence.sourceVersionById(report.sourceVersionId);
    if (!source) throw new Error("Acceptance source version is missing");
    return [{ sourceId: String(source.sourceId), sourceVersionId: String(source.sourceVersionId), contentHash: String(source.contentHash) }];
  };
  const dolly = first("dialogue", row => row.streamUri.includes("dialogue-00001"));
  if (dolly) cases.push(dollyAcceptanceCase(await bindings(dolly)));
  const alice = first("gutenberg", row => row.streamUri.toLowerCase().includes("alice-in-wonderland"));
  if (alice) cases.push({ id: "gutenberg-alice-cat", corpus: "gutenberg", requestedAuthority: "factual",
    question: "What is the name of Alice's cat?", expectedAnswerTerms: ["Dinah"], sourceBindings: await bindings(alice) });
  else {
    const gutenberg = first("gutenberg");
    if (gutenberg) cases.push(await evidenceDerivedCase(storage, gutenberg, "gutenberg", "gutenberg-ingested-source", bindings));
  }
  const code = first("oss_code", row => /burntsushi--walkdir\/.*\/\.github\/workflows\/ci\.yml$/iu.test(row.streamUri))
    ?? first("oss_code");
  if (code) {
    const texts = await committedEvidenceTexts(storage, code);
    const walkdirCi = texts.find(text => /build:\s*pinned/iu.test(text) && /rust:\s*1\.60\.0/iu.test(text));
    cases.push(walkdirCi
      ? walkdirCiAcceptanceCase(await bindings(code), walkdirCi)
      : await evidenceDerivedCase(storage, code, "code", "code-ingested-source", bindings));
  }
  const wiki = first("wikipedia", row => /\/Albedo$/iu.test(row.streamUri)) ?? first("wikipedia");
  if (wiki) {
    const texts = await committedEvidenceTexts(storage, wiki);
    const albedo = texts.find(text => /Albedo is the fraction of sunlight/iu.test(text));
    cases.push(albedo
      ? albedoAcceptanceCase(await bindings(wiki), albedo)
      : await evidenceDerivedCase(storage, wiki, "wikipedia", "wikipedia-ingested-source", bindings));
  }
  const oasstCase = await dialogueCaseFromCommittedReport(state, selectedOasstRoot(options), "openassistant", row => row.streamUri.includes("oasst-"), bindings);
  if (oasstCase) cases.push(oasstCase);
  return cases;
}

export function dollyAcceptanceCase(sourceBindings) {
  return { id: "dolly-virgin-australia", corpus: "dolly", requestedAuthority: "factual",
    question: "When did Virgin Australia start operating?", expectedAnswerTerms: ["31 August 2000"], sourceBindings };
}

export function albedoAcceptanceCase(sourceBindings, sourceText) {
  return sentenceBoundAcceptanceCase({
    id: "wikipedia-albedo-definition", corpus: "wikipedia", requestedAuthority: "factual",
    question: "What is albedo?", expectedAnswerTerms: ["fraction of sunlight", "diffusely reflected"],
    sourceBindings, sourceText, sentenceFragments: ["Albedo is", "fraction of sunlight"]
  });
}

export function walkdirCiAcceptanceCase(sourceBindings, sourceText) {
  return lineWindowBoundAcceptanceCase({
    id: "code-walkdir-pinned-rust", corpus: "code", requestedAuthority: "factual",
    question: "Which Rust version does Walkdir's pinned CI build use?",
    expectedAnswerTerms: ["1.60.0"], sourceBindings, sourceText,
    anchorLine: "- build: pinned", windowLines: 3
  });
}

async function evidenceDerivedCase(storage, report, corpus, id, bindings) {
  const text = (await committedEvidenceTexts(storage, report))[0] ?? report.streamUri;
  const bounded = firstSentenceWithDistinctiveTerms(text, distinctiveTerms);
  const terms = bounded.terms;
  if (!terms.length) throw new Error(`No sentence-bound acceptance expectation could be generated for ${report.sourceVersionId}`);
  const subject = terms.slice(0, 3).join(" ") || report.streamUri;
  return { id, corpus, requestedAuthority: "factual", question: `What does the admitted ${corpus} source say about ${subject}?`,
    expectedAnyAnswerTerms: terms, sourceBindings: await bindings(report) };
}

async function committedEvidenceTexts(storage, report) {
  const evidence = await storage.evidence.searchEvidence({ sourceVersionId: report.sourceVersionId, status: "promoted", limit: 8 });
  return evidence.map(row => row.span.text).filter(value => typeof value === "string" && value.trim());
}

async function dialogueCaseFromCommittedReport(state, root, corpus, predicate, bindings) {
  const report = state.reports.find(row => row.sourceSystem === "dialogue" && predicate(row));
  if (!report) return undefined;
  const relative = report.streamUri.replace(/^[^:]+:/u, "");
  try {
    const transcript = JSON.parse(await readFile(path.join(root, ...relative.split("/")), "utf8"));
    const surfaces = (transcript.turns ?? []).map(turn => turn.surface).filter(value => typeof value === "string" && value.trim());
    if (surfaces.length < 2) return undefined;
    return dialoguePairBoundAcceptanceCase({
      id: `${corpus}-committed-dialogue`, corpus, requestedAuthority: "factual", question: surfaces[0],
      expectedAnyAnswerTerms: distinctiveTerms(surfaces[1]), sourceBindings: await bindings(report),
      sourceText: surfaces.join(" "), pair: { prompt: surfaces[0], answer: surfaces[1] }
    });
  } catch { return undefined; }
}

function distinctiveTerms(text) {
  return [...new Set(text.normalize("NFC").split(/[^\p{L}\p{N}'’-]+/u).filter(part => [...part].length >= 5))].slice(0, 4);
}

export function validateAcceptanceCases(cases) {
  const required = new Set(["wikipedia", "gutenberg", "dolly", "code", "openassistant"]);
  for (const item of cases) {
    if (!item || typeof item.id !== "string" || !item.id || typeof item.question !== "string" || !item.question
      || typeof item.corpus !== "string" || !required.has(item.corpus) || !Array.isArray(item.sourceBindings) || !item.sourceBindings.length
      || item.sourceBindings.some(binding => typeof binding.sourceId !== "string" || !binding.sourceId
        || typeof binding.sourceVersionId !== "string" || !binding.sourceVersionId || typeof binding.contentHash !== "string" || !binding.contentHash)
      || (!Array.isArray(item.expectedAnswerTerms) && !Array.isArray(item.expectedAnyAnswerTerms))) {
      throw new Error("Generated API acceptance case does not satisfy the bound-source runner contract");
    }
    required.delete(item.corpus);
  }
  if (required.size) throw new Error(`Generated API acceptance cases are missing corpora: ${[...required].join(",")}`);
  return cases;
}

function initialState(options, databaseName) {
  const lane = () => ({ cursor: 0, batches: 0, trainedReports: 0, included: false, exhausted: false });
  return { schema: STATE_SCHEMA, status: "building", createdAt: new Date().toISOString(), databaseName,
    budgetBytes: options.budgetBytes, guardBytes: options.guardBytes,
    targetBytes: options.targetBytes ?? null,
    corpusIdentity: corpusIdentity(options), reports: [], batches: [], measurements: [],
    lanes: { gutenberg: lane(), dolly: lane(), oasst: lane(), code: { ...lane(), snapshotHash: null },
      wikipedia: { ...lane(), pages: 0, sources: 0, trainedSourceVersionIds: [] } } };
}

function validateResumeState(state, options) {
  if (state?.schema !== STATE_SCHEMA || state.status !== "building") throw new Error("Resume state is not an unfinished 5 GB multicorpus build");
  assertBuildStateScope(state, options);
}

export function assertBuildStateScope(state, options) {
  if (state.budgetBytes !== options.budgetBytes || state.guardBytes !== options.guardBytes) throw new Error("Resume budget differs from the original build");
  if (JSON.stringify(state.corpusIdentity) !== JSON.stringify(corpusIdentity(options))) throw new Error("Resume corpus paths differ from the original build");
  if ((state.targetBytes ?? null) !== (options.targetBytes ?? null)) throw new Error("Resume target-bytes differs from the original initialization target");
  assertResumeCorpusScope(state, { ...options, resume: true });
}

function corpusIdentity(options) {
  return { wikipediaDump: options.wikipediaDump ?? null, wikipediaIndex: options.wikipediaIndex ?? null,
    gutenbergRoot: options.gutenbergRoot, dollyRoot: options.dollyRoot, oasstRoot: options.oasstRoot, codeRoot: options.codeRoot,
    ...(options.codeDependencyManifest ? { codeDependencyManifest: options.codeDependencyManifest } : {}),
    ...(options.lexicalManifest ? { lexicalManifest: options.lexicalManifest } : {}) };
}

async function checkpoint(options, state, measurement, selectedItems = undefined) {
  await publishBrainBuildCheckpoint({
    statePath: options.statePath,
    receiptPath: options.receiptPath,
    state,
    receipt: publicReceipt(state, measurement, selectedItems)
  });
}

async function persistState(options, state) {
  await atomicWriteJson(options.statePath, state);
}

function publicReceipt(state, measurement, selectedItems) {
  const sourceBytes = selectedItems?.reduce((sum, item) => sum + item.byteLength, 0) ?? null;
  return { schema: RECEIPT_SCHEMA, status: state.status, databaseName: state.databaseName,
    createdAt: state.createdAt, ...(state.completedAt ? { completedAt: state.completedAt } : {}),
    selection: state.selection ?? { englishOnly: false },
    budgetBytes: state.budgetBytes, guardBytes: state.guardBytes, targetBytes: state.targetBytes ?? null,
    databaseBytes: measurement?.databaseBytes ?? null,
    sourceBytes, amplification: sourceBytes ? (measurement.databaseBytes / sourceBytes) : null,
    lanes: Object.fromEntries(Object.entries(state.lanes).map(([name, lane]) => [name, {
      included: lane.included, exhausted: lane.exhausted, batches: lane.batches, trainedReports: lane.trainedReports,
      ...(name === "code" ? codeTrainingReadiness(lane) : {}),
      ...(name === "wikipedia" ? { pages: lane.pages, sources: lane.sources } : {})
    }])), trainedReports: state.reports.length, batches: state.batches.length,
    largestTables: measurement?.largestTables ?? [], sourceBrain: state.sourceBrain ?? null,
    finalization: state.finalization ?? null,
    ...(state.lexicalResources ? { lexicalResources: state.lexicalResources } : {}),
    acceptanceCases: state.acceptanceCases ?? [], stopReason: state.stopReason ?? null,
    lastFailure: state.lastFailure ?? null,
    checks: { freshPhysicalDatabase: true, everyRequiredCorpusIncluded: Object.values(state.lanes).every(lane => lane.included),
      withinPhysicalBudget: measurement ? measurement.databaseBytes <= state.budgetBytes : null,
      unifiedBrainActive: state.sourceBrain?.active === true,
      retainedDialogueQaPublished: state.finalization?.contextualQa?.coldVerifiedContextualQaPatterns > 0,
      languageIdentitiesFinalized: state.finalization?.languageIdentities?.ready === true }
  };
}

function ownerPrivateLabel(config) {
  const accessContext = config.security?.informationAccess;
  if (!accessContext?.tenantId || !accessContext.principalId || !accessContext.maximumExportClass) {
    throw new Error("The local config needs an information-access context for owner-private dialogue training");
  }
  if (accessContext.maximumExportClass === "public") throw new Error("Dialogue training requires an owner-private maximum export class");
  return { tenantId: accessContext.tenantId, principals: [accessContext.principalId],
    compartments: [...accessContext.compartments], exportClass: accessContext.maximumExportClass, mergePolicy: "isolated" };
}

function prerequisiteFailure(label, target, reason) {
  const error = new Error(`Missing or invalid ${label} prerequisite at ${target}: ${reason}`);
  error.code = "SCCE_BRAIN_PREREQUISITE_INVALID";
  return error;
}

async function assertRegularFile(target, label) {
  let value;
  try { value = await stat(target); }
  catch (error) {
    if (error?.code === "ENOENT") throw prerequisiteFailure(label, target, "path does not exist");
    throw error;
  }
  if (!value.isFile()) throw prerequisiteFailure(label, target, "expected a regular file");
}

async function assertNonemptyDirectory(target, label) {
  let directory;
  try { directory = await opendir(target); }
  catch (error) {
    if (error?.code === "ENOENT") throw prerequisiteFailure(label, target, "path does not exist");
    if (error?.code === "ENOTDIR") throw prerequisiteFailure(label, target, "expected a directory");
    throw error;
  }
  try {
    if (!await directory.read()) throw prerequisiteFailure(label, target, "directory is empty");
  } finally {
    await directory.close();
  }
}

export async function verifyBrainBuildPrerequisites(options) {
  if (process.env.SCCE_DATABASE_URL?.trim()) throw new Error("Unset SCCE_DATABASE_URL so the new brain config cannot be overridden");
  await assertRegularFile(options.configPath, "local SCCE config");
  if (options.lexicalManifest) await loadPinnedLexicalManifest(options.lexicalManifest);
  if (options.codeDependencyManifest) {
    const manifest = options.codeDependencyManifest;
    await assertRegularFile(manifest.path, "code dependency manifest");
    if (`sha256_${createHash("sha256").update(await readFile(manifest.path)).digest("hex")}` !== manifest.contentHash) {
      throw prerequisiteFailure("code dependency manifest", manifest.path, "content hash differs from its declared pin");
    }
  }
  await Promise.all([
    assertRegularFile(path.join(options.rootPath, "packages", "adapters-node", "dist", "index.js"), "built adapters-node package"),
    assertRegularFile(path.join(options.rootPath, "packages", "kernel", "dist", "index.js"), "built kernel package"),
    assertNonemptyDirectory(options.gutenbergRoot, "Gutenberg corpus"),
    assertNonemptyDirectory(options.dollyRoot, "Dolly transcript corpus"),
    assertNonemptyDirectory(selectedOasstRoot(options), options.englishOnly ? "English OpenAssistant corpus" : "OpenAssistant corpus"),
    assertNonemptyDirectory(options.codeRoot, "code corpus"),
    ...(options.wikipediaDump ? [assertRegularFile(options.wikipediaDump, "Wikipedia dump")] : []),
    ...(options.wikipediaIndex ? [assertRegularFile(options.wikipediaIndex, "Wikipedia multistream index")] : [])
  ]);
  if (options.codeDependencyManifest) {
    const adapters = await import(pathToFileURL(path.join(options.rootPath, "packages", "adapters-node", "dist", "index.js")).href);
    await adapters.loadOssDependencyManifest({ ...options.codeDependencyManifest, rootPath: options.codeRoot, maxFilesPerRepo: 100_000 });
  }
  if (!options.existingFreshConfig && path.resolve(options.outputConfigPath) === path.resolve(options.configPath)) throw new Error("Output config must be a new path");
  if (path.resolve(options.receiptPath) === path.resolve(options.outputConfigPath) || path.resolve(options.statePath) === path.resolve(options.outputConfigPath)) {
    throw new Error("Receipt/state paths must not replace a config");
  }
}

function maximumLaneGrowth(state, lane) {
  return state.batches.filter(batch => batch.lane === lane).reduce((max, batch) => Math.max(max, batch.growthBytes), 0);
}

function positiveInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw new Error(`${name} must be a positive safe integer`);
  return number;
}

function usage() {
  return "Usage: node --max-old-space-size=7168 tools/build-5gb-multicorpus-brain.mjs (--fresh-config <existing-empty-brain.json> | --config <base-local-config.json> --output-config <new-ignored-config.json> [--database-name <new-name>]) --receipt <ignored-receipt.json> [--wikipedia-dump <dump>] [--wikipedia-index <index>] [--gutenberg <dir>] [--dolly <transcripts-dir>] [--oasst <train-dir>] [--code <repos-dir>] [--code-dependency-manifest <manifest.json> --code-dependency-manifest-hash <sha256_hex>] [--lexical-manifest <manifest.json> --lexical-manifest-hash <sha256_hex>] [--budget-bytes 5000000000] [--guard-bytes 200000000] [--target-bytes 2000000000] [--heap-checkpoint-mb 7168] [--source-workers N --source-worker-heap-mb N --max-node-rss-bytes N] [--english-only] [--resume]";
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const receipt = await buildFiveGbMulticorpusBrain(options);
    console.log(JSON.stringify(receipt));
  } catch (error) {
    const safe = { schema: RECEIPT_SCHEMA, status: "failed", failureCode: typeof error?.code === "string" ? error.code : error?.name ?? "Error",
      message: error?.code === "SCCE_BRAIN_PREREQUISITE_INVALID"
        ? String(error.message).slice(0, 1000)
        : "The multicorpus build failed; inspect the ignored local state and database logs" };
    console.error(JSON.stringify(safe));
    process.exitCode = 1;
  }
}
