#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Re-derives `evidence.structural_residue_cut` from the corpus in hand, so the declared value is reproducible
// rather than chosen. The cut is Otsu's split of the structural-residue score over every sentence of every
// promoted evidence span -- the same method corpus identity and language identity use.
//   node tools/derive-structural-residue-cut.mjs [--schema=scce3_runtime] [--spans=N]
// Reads the database URL from SCCE_DATABASE_URL. Read-only.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "packages", "adapters-node", "package.json"));
const pg = require("pg");
const kernel = await import(pathToFileURL(path.join(here, "..", "packages", "kernel", "dist", "index.js")).href);

const flag = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const schema = flag("schema") ?? "scce3_runtime";
const spanCap = Number(flag("spans") ?? Number.MAX_SAFE_INTEGER);
if (!/^[a-z0-9_]+$/u.test(schema)) throw new Error("schema must be a plain identifier");
const url = process.env.SCCE_DATABASE_URL;
if (!url) throw new Error("SCCE_DATABASE_URL is not set");

// Sentence split only; the surface a mouth speaks is a sentence, and the measure is defined on what is spoken.
const sentences = text => String(text).replace(/\s+/gu, " ").trim()
  .split(/(?<=[.!?。！？])\s+/u).map(part => part.trim()).filter(Boolean);

const client = new pg.Client({ connectionString: url, statement_timeout: 900000 });
await client.connect();
const scores = [];
let spans = 0;
try {
  let cursor = "";
  while (spans < spanCap) {
    const rows = (await client.query(
      `select id, text_content from ${schema}.evidence_spans
       where status = 'promoted' and text_content is not null and id > $1 order by id limit 3000`,
      [cursor]
    )).rows;
    if (!rows.length) break;
    for (const row of rows) {
      cursor = row.id;
      spans++;
      for (const sentence of sentences(row.text_content)) scores.push(kernel.structuralResidueScore(sentence));
    }
  }
} finally {
  await client.end();
}

const cut = kernel.otsuThreshold(scores);
const sorted = [...scores].sort((left, right) => left - right);
const quantile = p => sorted[Math.floor(p * (sorted.length - 1))];
const above = sorted.filter(score => score >= cut).length;
console.log(`${spans} promoted spans -> ${scores.length} sentences`);
console.log(`zero: ${sorted.filter(score => score === 0).length}  p50 ${quantile(0.5).toFixed(4)}  p90 ${quantile(0.9).toFixed(4)}  p99 ${quantile(0.99).toFixed(4)}  max ${sorted[sorted.length - 1].toFixed(4)}`);
console.log(`OTSU cut = ${cut.toFixed(4)}  (${above} sentences at or above, ${(100 * above / scores.length).toFixed(2)}%)`);
console.log(`declared evidence.structural_residue_cut = ${kernel.PUBLIC_CALIBRATIONS["evidence.structural_residue_cut"]}`);
