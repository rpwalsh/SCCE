#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Trains the public-domain prose corpus through its own lane, which is the point of having those books: they are
// what the engine learns fiction from, so it can write fiction instead of sounding like an encyclopedia.
//
// Measured 2026-09-12: the books had been ingested through the generic local-file path, which trained them at
// n-gram order 1 -- a bag of words with no context -- while Wikipedia trained at order 4. Generation from an
// order-1 model is word salad by construction ("Short passage through, that they were all of them?"), and the
// mouth hydrated only Wikipedia models for a fiction request because no prose-role model of usable order existed.
// This lane also strips the Project Gutenberg header and licence, which the local-file path kept as content.
//
//   node --max-old-space-size=7168 tools/train-gutenberg.mjs [--root=corpus/gutenberg] [--start=0] [--files=15]
import { readFileSync } from "node:fs";
import { createNodeRuntime, readScceRuntimeConfig, trainGutenbergCorpus } from "../packages/adapters-node/dist/index.js";

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const rootPath = flag("root", "corpus/gutenberg");
const startFileIndex = Number(flag("start", "0"));
const maxFilesPerRun = Number(flag("files", "15"));

const config = await readScceRuntimeConfig(process.env.SCCE_PROBE_CONFIG ?? "scce.config.json");
const runtime = createNodeRuntime(config);
const started = Date.now();
console.log(`training public-domain prose from ${rootPath} (files ${startFileIndex}..${startFileIndex + maxFilesPerRun - 1})`);
const report = await trainGutenbergCorpus({
  storage: runtime.storage,
  rootPath,
  startFileIndex,
  maxFilesPerRun,
  // The books are whole novels; the default per-file bound is sized for excerpts.
  maxFileBytes: 8 * 1024 * 1024,
  heapCheckpointMb: 5600
});
console.log(`\ntrained ${report.filesTrained} files in ${((Date.now() - started) / 1000).toFixed(1)}s`);
for (const skip of report.filesSkipped ?? []) console.log(`  skipped ${skip.path}: ${skip.reason}`);
if (report.stoppedByHeapSafetyBound) console.log("  stopped at the heap bound; rerun with --start to continue");
console.log(JSON.stringify({ ...report, filesSkipped: undefined }, null, 1).slice(0, 1200));
await runtime.close();
