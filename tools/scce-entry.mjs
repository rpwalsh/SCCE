#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { spawn } from "node:child_process";
import path from "node:path";
import {
  acquireAndTrainGithubOssRepository,
  createNodeRuntime,
  readScceRuntimeConfig,
  trainOssCorpus
} from "../packages/adapters-node/dist/index.js";

const argv = process.argv.slice(2);
const parsed = globalConfig(argv);
const command = parsed.args;

if (command[0] === "corpus" && command[1] === "train" && command[2] === "oss") {
  await runLocalOss(parsed.configPath, command.slice(3));
} else if (command[0] === "corpus" && command[1] === "train" && command[2] === "oss-github") {
  await runGithubOss(parsed.configPath, command.slice(3));
} else {
  // `pnpm scce` historically launched the compiled CLI with a 7 GiB old-space bound. The launcher is transparent
  // for every non-OSS command, including that memory envelope.
  const child = spawn(process.execPath, ["--max-old-space-size=7168", "packages/cli/dist/index.js", ...argv], {
    cwd: process.cwd(),
    stdio: "inherit",
    windowsHide: false
  });
  child.on("error", error => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
  child.on("close", code => { process.exitCode = code ?? 1; });
}

async function runLocalOss(configPath, args) {
  const target = args.find(arg => !arg.startsWith("--"));
  if (!target) throw new Error("usage: scce corpus train oss <path> [--max-files=N] [--max-files-per-run=N] [--start-file=N --expected-snapshot=HASH] [--heap-checkpoint-mb=N]");
  const optionArgs = args.filter(arg => arg !== target);
  const options = parseOssOptions(optionArgs);
  const config = await readScceRuntimeConfig(configPath);
  const runtime = createNodeRuntime(config);
  try {
    const report = await trainOssCorpus({ storage: runtime.storage, rootPath: path.resolve(target), ...options });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await runtime.close();
  }
}

async function runGithubOss(configPath, args) {
  const target = args.find(arg => !arg.startsWith("--"));
  if (!target) throw new Error("usage: scce corpus train oss-github <https://github.com/owner/repo> --commit=<40-hex-sha> [--max-files-per-run=N] [--start-file=N]");
  const commit = value(args, "--commit");
  if (!commit) throw new Error("oss-github requires --commit=<40-hex-sha>");
  const optionArgs = args.filter(arg => arg !== target && !arg.startsWith("--commit="));
  const options = parseOssOptions(optionArgs, { allowExpectedSnapshot: false });
  const config = await readScceRuntimeConfig(configPath);
  const runtime = createNodeRuntime(config);
  try {
    const inventoryLimit = options.maxFilesPerRepo ?? options.maxFiles;
    const report = await acquireAndTrainGithubOssRepository({
      storage: runtime.storage,
      remoteUrl: target,
      commitSha: commit,
      bounds: {
        ...(inventoryLimit !== undefined ? { maxFiles: inventoryLimit } : {}),
        ...(options.maxFileBytes !== undefined ? { maxFileBytes: options.maxFileBytes } : {}),
        ...(options.maxTotalBytes !== undefined ? { maxTotalBytes: options.maxTotalBytes } : {}),
        ...(options.maxDepth !== undefined ? { maxDepth: options.maxDepth } : {})
      },
      training: {
        startFileIndex: options.startFileIndex,
        maxFilesPerRun: options.maxFilesPerRun,
        includeDocs: options.includeDocs,
        includeSource: options.includeSource,
        ngramMaxOrder: options.ngramMaxOrder,
        ngramMaxCountersPerOrder: options.ngramMaxCountersPerOrder,
        ngramVocabularyLimit: options.ngramVocabularyLimit,
        languageAliases: options.languageAliases,
        heapCheckpointMb: options.heapCheckpointMb
      }
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await runtime.close();
  }
}

function parseOssOptions(args, contract = { allowExpectedSnapshot: true }) {
  const out = {};
  for (const arg of args) {
    const [flag, raw] = arg.split("=", 2);
    const num = raw === undefined ? NaN : Number(raw);
    if (flag === "--max-files" && Number.isFinite(num)) out.maxFiles = positiveInt(num, flag);
    else if (flag === "--max-files-per-repo" && Number.isFinite(num)) out.maxFilesPerRepo = positiveInt(num, flag);
    else if (flag === "--max-files-per-run" && Number.isFinite(num)) out.maxFilesPerRun = positiveInt(num, flag);
    else if ((flag === "--start-file" || flag === "--start-file-index") && Number.isFinite(num)) out.startFileIndex = nonNegativeInt(num, flag);
    else if (contract.allowExpectedSnapshot && (flag === "--expected-snapshot" || flag === "--expected-snapshot-hash") && raw?.trim()) out.expectedSnapshotHash = raw.trim();
    else if (flag === "--max-file-bytes" && Number.isFinite(num)) out.maxFileBytes = positiveInt(num, flag);
    else if (flag === "--max-total-bytes" && Number.isFinite(num)) out.maxTotalBytes = positiveInt(num, flag);
    else if (flag === "--max-depth" && Number.isFinite(num)) out.maxDepth = nonNegativeInt(num, flag);
    else if (flag === "--heap-checkpoint-mb" && Number.isFinite(num)) out.heapCheckpointMb = positiveInt(num, flag);
    else if (flag === "--ngram-max-order" && Number.isFinite(num)) out.ngramMaxOrder = positiveInt(num, flag);
    else if (flag === "--ngram-max-counters" && Number.isFinite(num)) out.ngramMaxCountersPerOrder = positiveInt(num, flag);
    else if (flag === "--ngram-vocabulary-limit" && Number.isFinite(num)) out.ngramVocabularyLimit = positiveInt(num, flag);
    else if (flag === "--language" && raw?.trim()) out.languageAliases = [...new Set(raw.split(",").map(value => value.trim()).filter(Boolean))];
    else if (arg === "--docs-only") { out.includeDocs = true; out.includeSource = false; }
    else if (arg === "--code-only") { out.includeDocs = false; out.includeSource = true; }
    else throw new Error(`unknown OSS training option: ${arg}`);
  }
  return out;
}

function globalConfig(args) {
  let configPath = "scce.config.json";
  const rest = [];
  for (let index = 0; index < args.length; index += 1) {
    const current = args[index];
    if (current === "--config") {
      const next = args[++index];
      if (!next) throw new Error("--config requires a path");
      configPath = next;
      continue;
    }
    if (current.startsWith("--config=")) {
      configPath = current.slice("--config=".length) || configPath;
      continue;
    }
    rest.push(current);
  }
  return { configPath, args: rest };
}

function value(args, flag) {
  const prefix = `${flag}=`;
  return args.find(arg => arg.startsWith(prefix))?.slice(prefix.length).trim() || undefined;
}

function positiveInt(value, flag) {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${flag} must be a positive integer`);
  return Math.floor(value);
}

function nonNegativeInt(value, flag) {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${flag} must be a non-negative integer`);
  return Math.floor(value);
}
