#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * Publishes typed contextual-QA constructions exclusively from canonical source
 * blobs and compact transcript annotations already retained by a brain. It never
 * reads a corpus file, invokes language training, or changes source/profile/ngram
 * records. The underlying component is checkpointed and idempotent.
 */
import path from "node:path";
import process from "node:process";
import { readFile } from "node:fs/promises";
import { dryRunStoredDialogueQaPublication } from "./lib/stored-dialogue-qa-dry-run.mjs";
import { atomicWriteJson } from "./lib/brain-build-publication.mjs";
import {
  assertStoredDialogueQaPublication,
  runStoredDialogueQaPublication,
  STORED_DIALOGUE_QA_PUBLICATION_SCHEMA
} from "./lib/stored-dialogue-qa-publication.mjs";

const options = parseArguments(process.argv.slice(2));
if (options.help) {
  process.stdout.write(helpText());
  process.exit(0);
}

const adapters = await import("../packages/adapters-node/dist/index.js");
const kernel = await import("../packages/kernel/dist/index.js");
const configPath = path.resolve(options.configPath);
const outputPath = path.resolve(options.outputPath);
const config = await adapters.readScceRuntimeConfig(configPath);
const readOnlyUrl = new URL(config.database.url);
if (options.dryRun) readOnlyUrl.searchParams.set("options",
  [readOnlyUrl.searchParams.get("options"), "-c default_transaction_read_only=on"].filter(Boolean).join(" "));
const storage = adapters.createPostgresStorageAdapter({ ...config.database, url: readOnlyUrl.toString(), informationAccess: config.security?.informationAccess });
const startedAt = new Date().toISOString();
let report;
let result;
let failure;

try {
  const qualification = options.jointPoolReceiptPath ? JSON.parse(await readFile(options.jointPoolReceiptPath, "utf8")) : undefined;
  if (qualification && (qualification.schema !== "scce.stored_dialogue_qa_qualification.v1"
    || qualification.sourceSelectionComplete !== true || qualification.transcriptFiltering !== false
    || !Array.isArray(qualification.sourceReceipts) || !qualification.sourceReceipts.length)) {
    throw Error("Joint publication requires a complete retained-source qualification receipt");
  }
  const contextualQaJointPool = qualification ? {
    rootUri: `scce://declared-retained-dialogue-qa/${kernel.createHasher().digestHex(kernel.canonicalStringify(qualification.sourceReceipts))}`,
    sourceVersionIds: qualification.sourceReceipts.map(source => source.sourceVersionId)
  } : undefined;
  const publicationInput = {
    storage, adapters, kernel, databaseSchema: config.database.schema,
    createVerificationStorage: async () => adapters.createPostgresStorageAdapter({
      ...config.database,
      informationAccess: config.security?.informationAccess
    }),
    maxArticleBytes: options.maxArticleBytes,
    maxTotalBytes: options.maxTotalBytes,
    maxSourceAttempts: options.maxSourceAttempts,
    sourcePageSize: options.sourcePageSize,
    includeUriPrefix: options.includeUriPrefix,
    ...(contextualQaJointPool ? { contextualQaJointPool } : {}),
    contextualQaExecution: {
      backend: "node_workers.v1",
      workers: options.workers,
      workerHeapMb: options.workerHeapMb,
      coordinatorHeapMb: options.coordinatorHeapMb,
      maxNodeRssBytes: options.maxNodeRssBytes,
      abortGraceMs: options.abortGraceMs
    }
  };
  if (options.dryRun) {
    result = await dryRunStoredDialogueQaPublication({ storage, adapters, kernel, trainingOptions: {
      minArticleBytes: 0, maxArticleBytes: options.maxArticleBytes, maxTotalBytes: options.maxTotalBytes,
      maxSourceAttempts: options.maxSourceAttempts, sourcePageSize: options.sourcePageSize,
      ...(options.includeUriPrefix ? { includeUriPrefixes: [options.includeUriPrefix] } : {}),
      ...(contextualQaJointPool ? { contextualQaJointPool } : {}), contextualQaExecution: publicationInput.contextualQaExecution
    } });
  } else {
    ({ report, result } = await runStoredDialogueQaPublication(publicationInput));
    assertStoredDialogueQaPublication(result);
  }
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
} finally {
  await storage.close();
}

const receipt = {
  schema: STORED_DIALOGUE_QA_PUBLICATION_SCHEMA,
  startedAt,
  completedAt: new Date().toISOString(),
  status: failure ? "failed" : "complete",
  input: {
    configFile: path.basename(configPath),
    dryRun: options.dryRun,
    jointPoolReceipt: options.jointPoolReceiptPath ?? null,
    sourceSystem: "dialogue",
    corpusFilesRead: 0,
    languageTrainingInvoked: false,
    maxTotalBytes: options.maxTotalBytes,
    maxArticleBytes: options.maxArticleBytes,
    maxSourceAttempts: options.maxSourceAttempts,
    sourcePageSize: options.sourcePageSize,
    includeUriPrefix: options.includeUriPrefix ?? null,
    workers: options.workers,
    workerHeapMb: options.workerHeapMb,
    coordinatorHeapMb: options.coordinatorHeapMb,
    maxNodeRssBytes: options.maxNodeRssBytes,
    abortGraceMs: options.abortGraceMs
  },
  result: result ?? null,
  failure: failure ?? null
};

await atomicWriteJson(outputPath, receipt);
process.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
if (failure) process.exitCode = 1;

function parseArguments(args) {
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === "--help" || token === "-h") return { help: true };
    if (!token.startsWith("--")) throw new Error(`unexpected argument: ${token}`);
    const value = args[++index];
    if (!value || value.startsWith("--")) throw new Error(`missing value for ${token}`);
    values.set(token, value);
  }
  const positive = (name, fallback) => {
    const raw = values.get(name);
    const value = raw === undefined ? fallback : Number(raw);
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
    return value;
  };
  const dryRun = values.get("--dry-run");
  if (dryRun !== undefined && dryRun !== "true" && dryRun !== "false") throw new Error("--dry-run must be true or false");
  return {
    help: false,
    configPath: values.get("--config") ?? ".scce/brain-5gb-20261111-r004.json",
    outputPath: values.get("--out") ?? ".scce/verification/brain-5gb-r004/stored-dialogue-qa-publication.json",
    maxTotalBytes: positive("--max-total-bytes", 512 * 1024 * 1024),
    maxArticleBytes: positive("--max-article-bytes", 8 * 1024 * 1024),
    maxSourceAttempts: positive("--max-source-attempts", 2048),
    sourcePageSize: positive("--source-page-size", 128),
    includeUriPrefix: values.get("--include-uri-prefix"),
    jointPoolReceiptPath: values.get("--joint-pool-receipt"),
    dryRun: values.get("--dry-run") === "true",
    workers: positive("--workers", 5),
    workerHeapMb: positive("--worker-heap-mb", 576),
    coordinatorHeapMb: positive("--coordinator-heap-mb", 512),
    maxNodeRssBytes: positive("--max-node-rss-bytes", 7_000_000_000),
    abortGraceMs: positive("--abort-grace-ms", 5_000)
  };
}

function helpText() {
  return `Usage: node tools/publish-stored-dialogue-qa.mjs [options]\n\n` +
    `Publishes contextual-QA constructions from evidence already stored in a brain.\n` +
    `No corpus files are read and no language training is invoked.\n\n` +
    `  --config <path>               Runtime config\n` +
    `  --out <path>                  JSON receipt path\n` +
    `  --max-total-bytes <bytes>     Stored-source read bound\n` +
    `  --max-article-bytes <bytes>   Per-source read bound\n` +
    `  --max-source-attempts <count> Source-count bound\n` +
    `  --source-page-size <count>    Bounded inventory page size\n` +
    `  --include-uri-prefix <uri>    Restrict publication to one retained corpus root\n` +
    `  --joint-pool-receipt <path>   Joint selection; preserves verified active knowledge\n` +
    `  --dry-run <true|false>        Compute publication with in-memory writes\n` +
    `  --workers <count>             Deterministic QA group workers (default 5)\n` +
    `  --worker-heap-mb <MiB>        Heap ceiling per QA worker\n` +
    `  --coordinator-heap-mb <MiB>   Coordinator reservation\n` +
    `  --max-node-rss-bytes <bytes>  Aggregate Node RSS ceiling\n` +
    `  --abort-grace-ms <ms>         Grace before forced worker termination\n`;
}
