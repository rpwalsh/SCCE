#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// The counts that decide whether a brain can answer: sources ingested, evidence promoted, and the trained
// language profiles the closed-class machinery needs. majorityClosedClass keeps a word carried by more than
// half the profiles, so a handful of profiles is a degenerate closed class rather than a small one.
// Goes through the runtime adapter, so credentials resolve exactly once, the same way every other command does.
import { statSync } from "node:fs";
import { createNodeRuntime, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

const config = await readScceRuntimeConfig(process.argv[2] ?? "scce.config.json");
const runtime = createNodeRuntime(config);
const storage = runtime.storage;
const s = config.database.schema;

const counts = (await storage.query(`SELECT
    (SELECT count(*) FROM ${s}.source_versions) AS sources,
    (SELECT count(*) FROM ${s}.evidence_spans) AS evidence,
    (SELECT count(*) FROM ${s}.language_profiles) AS profiles,
    (SELECT count(*) FROM ${s}.language_identities) AS identities,
    (SELECT count(*) FROM ${s}.ngram_models) AS models,
    (SELECT count(*) FROM ${s}.ngram_observations) AS observations,
    (SELECT COALESCE(max(offset_bytes),0) FROM ${s}.ingestion_checkpoints) AS wiki_offset`))[0];

for (const [key, value] of Object.entries(counts)) {
  if (key === "wiki_offset") continue;
  process.stdout.write(`${key.padEnd(14)} ${String(value).padStart(12)}\n`);
}

const dump = config.runtime.corpora?.wikipedia?.dumpPath;
let through = "";
if (dump) {
  const size = statSync(dump, { throwIfNoEntry: false })?.size;
  if (size) through = `  (${(100 * Number(counts.wiki_offset) / size).toFixed(1)}% of ${(size / 1e6).toFixed(0)}MB dump)`;
}
process.stdout.write(`wiki_offset    ${String(counts.wiki_offset).padStart(12)}${through}\n`);

if (Number(counts.identities) === 0 && Number(counts.profiles) > 0) {
  process.stdout.write("\nno language identities: run `scce language identities --rebuild` before serving\n");
}
await storage.close?.();
