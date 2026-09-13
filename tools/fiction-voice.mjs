#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Does the engine write fiction, or does it write encyclopedia? That is the question the public-domain prose
// corpus exists to answer, and it is measurable without any judge: score each generated passage under the
// corpus's OWN two model families -- the encyclopedic models and the public-domain prose models -- and report
// which family assigns it higher per-token likelihood. A passage that reads like Wikipedia scores higher under
// Wikipedia; one that reads like a novel scores higher under the novels.
//
// Three verdicts per passage, none of them opinion:
//   register   which model family the passage is more likely under, and by how much (nats/token)
//   echo       share of the passage's content units that came from the request itself
//   copied     longest run of consecutive units the passage shares with any source span it could have seen
//
//   node --max-old-space-size=7168 tools/fiction-voice.mjs [--out=artifacts/fiction-voice.json]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import path from "node:path";
import { pathToFileURL } from "node:url";
const pg = createRequire(pathToFileURL(path.resolve("packages/adapters-node/package.json")))("pg");

const flag = (name, fallback) => (process.argv.find(a => a.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=").slice(1).join("=");
const outPath = flag("out", "artifacts/fiction-voice.json");
const serverUrl = process.env.SCCE_SERVER_URL ?? "http://127.0.0.1:3873";

const PROMPTS = [
  "Write a short passage of fiction about a sailor leaving harbour at dawn.",
  "Write the opening paragraph of a novel about a lighthouse keeper.",
  "Tell a short story about a stranger arriving in a village at night.",
  "Write a scene in which two old friends meet again after many years.",
  "Describe a storm at sea as a novelist would."
];

const base = JSON.parse(readFileSync("scce.config.json", "utf8"));
let local = {};
try { local = JSON.parse(readFileSync("scce.config.local.json", "utf8")); } catch { /* optional */ }
const client = new pg.Client({ connectionString: process.env.SCCE_DATABASE_URL ?? local?.database?.url ?? base?.database?.url });
await client.connect();
await client.query(`SET search_path TO "${local?.database?.schema ?? base?.database?.schema ?? "scce3_runtime"}"`);
await client.query("SET statement_timeout='300s'");

// The two families, told apart by the stream each model was trained from -- not by any label a tool wrote later.
// Counts are aggregated in the database: pulling every model's JSON into this process exhausts the heap.
async function familyCounts(label, whereSql) {
  const rows = await client.query(`
    SELECT unit AS key, sum(value::numeric)::bigint AS count
    FROM ngram_models m, jsonb_each_text(m.model_json->'model'->'unigramCounts') AS kv(unit, value)
    WHERE ${whereSql}
    GROUP BY 1`);
  const counts = new Map();
  let total = 0;
  for (const row of rows.rows) {
    const value = Number(row.count) || 0;
    counts.set(row.key, value);
    total += value;
  }
  console.log(`  ${label}: ${counts.size} units, ${total} tokens`);
  return { counts, total };
}
const orders = await client.query("SELECT DISTINCT max_order, stream_id LIKE 'wikipedia://%' AS wiki FROM ngram_models ORDER BY 1");
console.log("model families:");
const families = {
  prose: await familyCounts("prose", "m.stream_id NOT LIKE 'wikipedia://%' AND m.stream_id LIKE '%.txt%' AND m.max_order >= 3"),
  encyclopedic: await familyCounts("encyclopedic", "m.stream_id LIKE 'wikipedia://%'")
};
console.log("orders present: " + orders.rows.map(r => (r.wiki ? "wiki" : "other") + ":" + r.max_order).join(", "));

const units = text => String(text).toLocaleLowerCase().split(/\s+/u).map(u => u.replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}']+$/gu, "")).filter(Boolean);

/** Per-token log-likelihood of a passage under one family, add-one smoothed over that family's own vocabulary. */
function logLikelihood(family, passage) {
  if (!family.total) return null;
  const tokens = units(passage);
  if (!tokens.length) return null;
  let sum = 0;
  for (const token of tokens) sum += Math.log(((family.counts.get(token) ?? 0) + 1) / (family.total + family.counts.size));
  return { perToken: sum / tokens.length, tokens: tokens.length };
}

async function turn(text) {
  const started = Date.now();
  const response = await fetch(`${serverUrl}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, sessionId: `fiction-voice-${Date.now()}` })
  });
  const body = await response.json().catch(() => ({}));
  const result = body.turn ?? body.result ?? body;
  return { status: response.status, ms: Date.now() - started, answer: String(result.answer ?? "") };
}

/** The longest run of consecutive units the passage shares with any span of the corpus it could have drawn from. */
async function longestCopiedRun(passage) {
  const tokens = units(passage);
  for (let length = Math.min(12, tokens.length); length >= 4; length--) {
    for (let start = 0; start + length <= tokens.length; start++) {
      const phrase = tokens.slice(start, start + length).join(" ");
      const hit = await client.query("SELECT 1 FROM evidence_spans WHERE text_content ILIKE $1 LIMIT 1", [`%${phrase}%`]);
      if (hit.rowCount) return { length, phrase };
    }
  }
  return { length: 0, phrase: "" };
}

const rows = [];
for (const prompt of PROMPTS) {
  const result = await turn(prompt);
  const passage = result.answer.replace(/\s+Sources?:.*$/u, "").trim();
  const promptUnits = new Set(units(prompt));
  const passageUnits = units(passage);
  const echo = passageUnits.length ? passageUnits.filter(unit => promptUnits.has(unit)).length / passageUnits.length : 1;
  const prose = logLikelihood(families.prose, passage);
  const encyclopedic = logLikelihood(families.encyclopedic, passage);
  const copied = passage ? await longestCopiedRun(passage) : { length: 0, phrase: "" };
  const register = prose && encyclopedic ? (prose.perToken > encyclopedic.perToken ? "prose" : "encyclopedic") : "unscored";
  const margin = prose && encyclopedic ? Number((prose.perToken - encyclopedic.perToken).toFixed(4)) : null;
  rows.push({ prompt, status: result.status, ms: result.ms, passage: passage.slice(0, 400), tokens: passageUnits.length, echo: Number(echo.toFixed(3)), register, margin, copiedRun: copied.length });
  console.log(`\n[${(result.ms / 1000).toFixed(1)}s] ${prompt}`);
  console.log(`  register=${register} margin=${margin} echo=${echo.toFixed(2)} copiedRun=${copied.length} tokens=${passageUnits.length}`);
  console.log(`  ${passage.replace(/\s+/gu, " ").slice(0, 200)}`);
}

const scored = rows.filter(row => row.register !== "unscored");
const summary = {
  schema: "scce.fiction_voice.v1",
  generatedAt: new Date().toISOString(),
  passages: rows.length,
  proseRegister: scored.filter(row => row.register === "prose").length,
  meanEcho: Number((rows.reduce((sum, row) => sum + row.echo, 0) / Math.max(1, rows.length)).toFixed(3)),
  maxCopiedRun: Math.max(0, ...rows.map(row => row.copiedRun)),
  rows
};
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, JSON.stringify(summary, null, 2) + "\n", "utf8");
console.log(`\n${summary.proseRegister}/${scored.length} passages read as prose rather than encyclopedia; mean echo ${summary.meanEcho}; longest copied run ${summary.maxCopiedRun}`);
console.log(`wrote ${outPath}`);
await client.end();
