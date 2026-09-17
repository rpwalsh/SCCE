#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Writes a brain's ingested source text out as one .txt per source version, so the order sweep can measure
// prediction on the corpus the system is actually trained on rather than on a stand-in.
//
//   node tools/prose-order-calibration/export-corpus-text.mjs --config=scce.config.new.json --out=corpus/wiki-calibration
//
// The export is corpus content: it belongs only under a gitignored path and never in the repository.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const args = new Map(process.argv.slice(2).filter(a => a.startsWith("--")).map(a => {
  const at = a.indexOf("=");
  return at < 0 ? [a.slice(2), "true"] : [a.slice(2, at), a.slice(at + 1)];
}));
const configPath = args.get("config") ?? "scce.config.json";
const outDir = path.resolve(args.get("out") ?? "corpus/wiki-calibration");
const limit = Number(args.get("limit") ?? 600);
const minBytes = Number(args.get("minBytes") ?? 4000);

const adapters = await import(pathToFileURL(path.resolve("packages/adapters-node/dist/index.js")).href);
const { createNodeRuntime, readScceRuntimeConfig } = adapters;
const config = await readScceRuntimeConfig(configPath);
const runtime = createNodeRuntime(config);
const storage = runtime.storage;
const schema = config.database.schema;

await mkdir(outDir, { recursive: true });

// Longest sources first: the sweep needs held-out documents long enough to yield passages, and a stub article
// contributes no measurable prediction. byte_length is the stored length, so this costs no detoast.
const rows = await storage.query(
  `SELECT sv.id, sv.content_hash, sv.byte_length, s.canonical_uri
   FROM ${schema}.source_versions sv
   JOIN ${schema}.sources s ON s.id = sv.source_id
   WHERE sv.byte_length >= $1
   ORDER BY sv.byte_length DESC
   LIMIT $2`,
  [minBytes, limit]
);

let written = 0;
let bytes = 0;
for (const row of rows) {
  const content = await storage.blobs.get(row.content_hash).catch(() => undefined);
  if (!content) continue;
  const text = Buffer.from(content).toString("utf8");
  if (!text.trim()) continue;
  const slug = String(row.canonical_uri).replace(/[^a-zA-Z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(-80) || `source-${written}`;
  await writeFile(path.join(outDir, `${String(written).padStart(4, "0")}-${slug}.txt`), text, "utf8");
  written += 1;
  bytes += Buffer.byteLength(text);
}

process.stdout.write(`wrote ${written} files, ${(bytes / 1e6).toFixed(1)}MB to ${outDir}\n`);
process.stdout.write(`shard-equivalents at 1.2M chars: ${(bytes / 1_200_000).toFixed(1)}\n`);
await storage.close?.();
