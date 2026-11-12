#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

import { resolve } from "node:path";
import {
  createNodeRuntime,
  readScceRuntimeConfig,
  trainDialogueCorpus
} from "../packages/adapters-node/dist/index.js";

const argument = (name, fallback) => {
  const prefix = `--${name}=`;
  const value = process.argv.find(item => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : fallback;
};

const configPath = resolve(argument("config", process.env.SCCE_PROBE_CONFIG ?? "scce.config.json"));
const rootPath = resolve(argument("root", ".scce/corpus-bootstrap/squad-v2/transcripts"));
const startFileIndex = Number(argument("start", "0"));
const maxFilesPerRun = Number(argument("files", "4"));
const heapCheckpointMb = Number(argument("heap-checkpoint-mb", "5600"));

for (const [name, value] of Object.entries({ startFileIndex, maxFilesPerRun, heapCheckpointMb })) {
  if (!Number.isSafeInteger(value) || value < (name === "startFileIndex" ? 0 : 1)) {
    throw new Error(`Invalid ${name}`);
  }
}

const config = await readScceRuntimeConfig(configPath);
const access = config.security?.informationAccess;
if (!access?.tenantId || !access.principalId || !access.maximumExportClass) {
  throw new Error("Extractive-QA training requires the configured information-access owner");
}
const informationLabel = {
  tenantId: access.tenantId,
  principals: [access.principalId],
  compartments: [...access.compartments],
  exportClass: access.maximumExportClass,
  mergePolicy: "isolated"
};

const runtime = createNodeRuntime(config);
const startedAt = Date.now();
try {
  const before = (await runtime.storage.query(
    "SELECT current_database() AS database, pg_database_size(current_database())::text AS bytes"
  ))[0];
  const report = await trainDialogueCorpus({
    storage: runtime.storage,
    rootPath,
    authorship: "human_authored",
    informationLabel,
    startFileIndex,
    maxFilesPerRun,
    maxFileBytes: 8 * 1024 * 1024,
    heapCheckpointMb
  });
  const contextualQa = [report.contextualQaConstructions]
    .filter(Boolean)
    .map(item => ({
      pairs: item.pairs,
      patternsPersisted: item.patternsPersisted,
      qualifiedFamilies: item.qualifiedFamilies,
      unchanged: item.unchanged,
      rejectedByReason: Object.fromEntries([...item.rejected.reduce(
        (counts, row) => counts.set(row.reason, (counts.get(row.reason) ?? 0) + 1), new Map()
      )].sort(([left], [right]) => left.localeCompare(right)))
    }));
  const after = (await runtime.storage.query(
    "SELECT current_database() AS database, pg_database_size(current_database())::text AS bytes"
  ))[0];
  process.stdout.write(`${JSON.stringify({
    schema: "scce.extractive_qa_training.v1",
    elapsedMs: Date.now() - startedAt,
    startFileIndex,
    maxFilesPerRun,
    filesTrained: report.filesTrained,
    filesSkipped: report.filesSkipped,
    stoppedByHeapSafetyBound: report.stoppedByHeapSafetyBound,
    nextFileIndex: startFileIndex + report.filesTrained + report.filesSkipped.length,
    database: {
      name: after.database,
      beforeBytes: Number(before.bytes),
      afterBytes: Number(after.bytes),
      growthBytes: Number(after.bytes) - Number(before.bytes)
    },
    contextualQa
  })}\n`);
} finally {
  await runtime.close();
}
