#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Does the corpus itself say that two surfaces are forms of one unit? Loads the models a turn would hydrate,
// read-only, primes the free-form lexicon exactly as a turn does, and prints two verdicts per pair: what the
// delivered oracle says, and what the answer path's own relation-coverage predicate reaches. Fails if the oracle
// accepts a pair marked "-", refuses one marked "+", or if the answer path disagrees with the oracle on a pair the
// oracle decides (one surface plus one letter) -- which is what proves the oracle is actually wired in.
//
//   pnpm --filter @scce/kernel build
//   node tools/stem-equivalence-harness.mjs [--budget-mb=48] [--json=out.json]
//
// No server, no writes: one SELECT of model JSON under the hydration byte budget.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { databaseSchema, databaseUrl } from "./lib/runtime-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const budgetBytes = Math.max(1, Number(flag("budget-mb", 48))) * 1024 * 1024;
const jsonOut = flag("json", "");

const distDir = path.join(here, "..", "packages", "kernel", "dist");
if (!fs.existsSync(path.join(distDir, "index.js"))) {
  console.error("build the kernel first: pnpm --filter @scce/kernel build");
  process.exit(2);
}
const distUrl = name => new URL(`file:///${path.join(distDir, name).replace(/\\/g, "/")}`).href;
const { primeFreeFormLexicon, freeFormLexicon, corpusTreatsUnitsAsOneForm } = await import(distUrl("index.js"));
// The answer path's own relation-coverage predicate, not a copy of it.
const { requestUnitSharesStem } = await import(distUrl("local-evidence-runtime.js"));

// "+" the oracle must accept, "-" the oracle must refuse, "?" reported only.
const PAIRS = [
  ["discover", "discovery", "+", "G4: the answering sentence says discovery, the request says discover"],
  ["capita", "capital", "-", "live 2026-09-10: per-capita aid answered the capital of Afghanistan"],
  ["born", "borna", "-", "live: Borna is not born"],
  ["majorian", "bajoran", "-", "similarity alone let Majorian stand in for Bajoran"],
  ["capital", "capitals", "+", "the plural the literal rule used to carry"],
  ["find", "found", "?", "G4's other half: no shared prefix, and nothing measured separates it from mind/mound"],
  ["born", "byrds", "-", "answerhood-gate.test.ts"],
  ["moon", "months", "-", "answerhood-gate.test.ts"],
  ["commanded", "commander", "?", "answerhood-gate.test.ts: outside the oracle, carried by shared prefix"],
  ["land", "landed", "?", "answerhood-gate.test.ts: outside the oracle, carried by shared prefix"],
  ["develop", "developing", "?", "answerhood-gate.test.ts: outside the oracle, carried by shared prefix"],
  ["deliver", "delivery", "?", "the same derivation as discover/discovery"],
  ["recover", "recovery", "?", "the same derivation as discover/discovery"],
  ["war", "ward", "?", "one letter, both free: newly accepted where the literal rule refused"],
  ["sea", "seal", "?", "one letter, both free: newly accepted where the literal rule refused"],
  ["mind", "mound", "?", "orthographically identical to find/found"],
  ["lanka", "lankan", "?", "both forms are fragments of one phrase"]
];
// Pairs the answer path reaches by a route this task did not touch, so a disagreement there is reported, not failed.
const PRE_EXISTING = new Map([["majorian/bajoran", "accepted by the pre-existing similarity floor (0.75 >= units.similarity_floor); answerCoversRequest guards subjects separately"]]);

const pg = createRequire(path.join(here, "..", "packages", "adapters-node", "package.json"))("pg");
const client = new pg.Client({ connectionString: databaseUrl() });
const models = [];
try {
  await client.connect();
  await client.query(`SET search_path TO ${databaseSchema()}, public`);
  await client.query(`SET statement_timeout = '300s'`);
  // The hydration relevance order and byte budget, so the harness sees what a turn sees.
  const ids = (await client.query(
    `SELECT id FROM (
       SELECT model.id,
         SUM(pg_column_size(model.model_json)) OVER (
           ORDER BY COALESCE((model.model_json->'model'->>'totalUnigramCount')::numeric, 0) DESC,
                    model.updated_at DESC, model.id ASC ROWS UNBOUNDED PRECEDING) AS running
       FROM ngram_models model
     ) ranked WHERE running <= $1`,
    [budgetBytes]
  )).rows.map(row => row.id);
  for (const id of ids) {
    const row = (await client.query(`SELECT stream_id, model_json->'model' AS model FROM ngram_models WHERE id=$1`, [id])).rows[0];
    if (!row?.model?.counts) continue;
    models.push({ sourceKey: row.stream_id, order: row.model.order ?? 0, observedSymbolCount: row.model.observedSymbolCount ?? 0, counts: row.model.counts });
  }
} finally {
  await client.end();
}

primeFreeFormLexicon(models);
const started = Date.now();
const lexicon = freeFormLexicon();
const derivationMs = Date.now() - started;
console.log(`models loaded ${models.length} under a ${(budgetBytes / 1048576).toFixed(0)}MB budget`);
console.log(`free-form lexicon: ${lexicon?.forms ?? 0} forms fitted in ${derivationMs}ms`);
console.log("");

const oneLetterApart = (a, b) => Math.abs(a.length - b.length) === 1 && (a.startsWith(b) || b.startsWith(a));
const show = unit => {
  const m = lexicon?.measure(unit);
  const verdict = lexicon?.verdict(unit) ?? "unknown";
  return m ? `${verdict} t=${m.tokens} k=${m.contexts} z=${m.z.toFixed(2)}` : `${verdict} (unseen)`;
};

const rows = [];
const failures = [];
console.log("pair                      want  corpus  path   left form                      right form");
for (const [left, right, want, note] of PAIRS) {
  const corpus = corpusTreatsUnitsAsOneForm(left, right);
  const answerPath = requestUnitSharesStem(left, right);
  const key = `${left}/${right}`;
  if (want === "+" && !corpus) failures.push(`${key}: the corpus refuses a pair it must accept`);
  if (want === "-" && corpus) failures.push(`${key}: the corpus accepts a pair it must refuse`);
  if (oneLetterApart(left, right) && corpus !== answerPath && !PRE_EXISTING.has(key)) {
    failures.push(`${key}: the answer path says ${answerPath} where the corpus says ${corpus} -- the oracle is not wired in`);
  }
  rows.push({ left, right, want, corpus, answerPath, left_measure: lexicon?.measure(left) ?? null, right_measure: lexicon?.measure(right) ?? null, note });
  console.log(key.padEnd(25), want.padEnd(5), (corpus ? "YES" : "no").padEnd(7), (answerPath ? "YES" : "no").padEnd(6), show(left).padEnd(30), show(right));
  const carried = PRE_EXISTING.get(key);
  if (carried) console.log(" ".padEnd(25), `    note: ${carried}`);
}
console.log("");
if (jsonOut) {
  fs.mkdirSync(path.dirname(path.resolve(jsonOut)), { recursive: true });
  fs.writeFileSync(path.resolve(jsonOut), JSON.stringify({ models: models.length, forms: lexicon?.forms ?? 0, derivationMs, rows }, null, 2));
}
if (failures.length) {
  for (const failure of failures) console.error(`FAIL ${failure}`);
  process.exit(1);
}
console.log("every required pair decided as the corpus says");
