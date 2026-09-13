#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Offline quality harness for packages/kernel/src/source-summary.ts. No server, no writes: it reads evidence spans
// with a read-only transaction and prints what the summarizer would say about each source, so front matter winning
// over the work is visible as text rather than as a score.
//
//   pnpm --filter @scce/kernel exec tsc -p tsconfig.json     # dist must exist
//   node --max-old-space-size=7168 tools/source-summary-harness.mjs
//   node --max-old-space-size=7168 tools/source-summary-harness.mjs "moby dick" "jane eyre"
//
// Two views per source, because they fail differently. WHOLE SOURCE is every promoted span of the version with the
// most of them, reassembled at its own character offsets -- sampled across the document, not the first N, since the
// first N of a Gutenberg book are all front matter. IDENTITY WINDOW is only the spans that carry the source's own
// title, which is the worst case the turn runtime hands the summarizer: for a book, mostly title page and banner.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { summarizeSource, unwrapTypographicLineBreaks } from "../packages/kernel/dist/source-summary.js";
import { deriveClosedClassWords } from "../packages/kernel/dist/closed-class-words.js";
// Resolved from the repository, not from one machine's checkout path (same recipe as scripts/db.mjs).
const pg = createRequire(pathToFileURL(path.resolve("packages/adapters-node/package.json")))("pg");

const DEFAULT_TITLES = ["moby dick", "pride and prejudice", "albania"];
const CLOSED_CLASS_CACHE = path.resolve(".tmp/source-summary-closed-class.json");
const SUMMARY_CHARS = Number(process.env.SUMMARY_CHARS ?? 900);
// Cost bound on the identity window: the turn runtime hands the summarizer the evidence it admitted, not a corpus.
const IDENTITY_WINDOW_SPANS = 12;

function databaseConfig() {
  const base = JSON.parse(readFileSync("scce.config.json", "utf8"));
  let local = {};
  try { local = JSON.parse(readFileSync("scce.config.local.json", "utf8")); } catch { /* optional */ }
  const url = process.env.SCCE_DATABASE_URL ?? local?.database?.url ?? base?.database?.url;
  const schema = local?.database?.schema ?? base?.database?.schema ?? "scce3_runtime";
  if (!url) throw new Error("no database url; set SCCE_DATABASE_URL or configure scce.config.local.json");
  return { url, schema };
}

/**
 * The corpus's own scaffolding, by Kneser-Ney continuation counts, exactly as deriveClosedClassWords ranks them.
 * Read from the compact summary each persisted model carries so the whole 900 MB of models never has to move.
 */
async function closedClassWords(client) {
  if (existsSync(CLOSED_CLASS_CACHE)) return new Set(JSON.parse(readFileSync(CLOSED_CLASS_CACHE, "utf8")));
  const rows = await client.query(`
    SELECT entry->>0 AS symbol, sum((entry->>1)::bigint) AS contexts
    FROM ngram_models model, LATERAL jsonb_array_elements(model.model_json->'compact'->'topContinuation') entry
    WHERE model.model_json->'compact' ? 'topContinuation'
    GROUP BY 1`);
  const continuationCounts = {};
  for (const row of rows.rows) continuationCounts[row.symbol] = Number(row.contexts);
  const derived = [...deriveClosedClassWords({ models: [{ continuationCounts }] })];
  mkdirSync(path.dirname(CLOSED_CLASS_CACHE), { recursive: true });
  writeFileSync(CLOSED_CLASS_CACHE, JSON.stringify(derived), "utf8");
  return new Set(derived);
}

/** The version of this source with the most promoted spans, reassembled at its own character offsets. */
async function wholeSource(client, title) {
  const version = await client.query(`
    SELECT source_version_id, count(*) AS spans
    FROM evidence_spans WHERE source_title = $1 AND status = 'promoted'
    GROUP BY source_version_id ORDER BY count(*) DESC, source_version_id LIMIT 1`, [title]);
  if (!version.rows.length) return { text: "", spans: 0, versionId: "" };
  const versionId = version.rows[0].source_version_id;
  const rows = await client.query(`
    SELECT char_start, char_end, text_content FROM evidence_spans
    WHERE source_title = $1 AND source_version_id = $2 AND status = 'promoted'
    ORDER BY char_start`, [title, versionId]);
  const pieces = [];
  let cursor = 0;
  for (const row of rows.rows) {
    if (Number(row.char_end) <= cursor) continue;
    if (Number(row.char_start) > cursor) pieces.push("\n");
    pieces.push(row.text_content);
    cursor = Number(row.char_end);
  }
  return { text: pieces.join(""), spans: rows.rows.length, versionId };
}

/** The spans that carry the source's own title: what identity-bound admission puts in front of the summarizer. */
async function identityWindow(client, title, versionId) {
  if (!versionId) return { text: "", spans: 0 };
  const rows = await client.query(`
    SELECT text_content FROM evidence_spans
    WHERE source_title = $1 AND source_version_id = $2 AND status = 'promoted'
      AND text_content ILIKE '%' || $3 || '%'
    ORDER BY char_start LIMIT $4`, [title, versionId, title, IDENTITY_WINDOW_SPANS]);
  return { text: rows.rows.map(row => row.text_content).join("\n\n"), spans: rows.rows.length };
}

function lineBreakMeasurement(text) {
  const lines = text.replace(/\r\n?/gu, "\n").split("\n");
  const terminator = /[.!?。！？؟۔।॥።။][^\p{L}\p{M}\p{N}]*$/u;
  let paragraphFinal = 0, paragraphFinalClosed = 0, interior = 0, interiorClosed = 0;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const closed = terminator.test(line);
    if ((lines[index + 1] ?? "").trim()) { interior += 1; if (closed) interiorClosed += 1; }
    else { paragraphFinal += 1; if (closed) paragraphFinalClosed += 1; }
  }
  return {
    paragraphFinal,
    interior,
    paragraphFinalRate: paragraphFinal ? paragraphFinalClosed / paragraphFinal : 0,
    interiorRate: interior ? interiorClosed / interior : 0
  };
}

const titles = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_TITLES;
const { url, schema } = databaseConfig();
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`SET search_path TO "${schema}"`);
await client.query("SET statement_timeout = '120s'");
await client.query("SET default_transaction_read_only = on");

const closedClass = await closedClassWords(client);
console.log(`closed class: ${closedClass.size} units derived from the corpus's own continuation counts\n`);

for (const title of titles) {
  const whole = await wholeSource(client, title);
  if (!whole.text) {
    console.log(`######## ${title}: no promoted spans ########\n`);
    continue;
  }
  const window = await identityWindow(client, title, whole.versionId);
  for (const view of [
    { name: "WHOLE SOURCE", text: whole.text, spans: whole.spans },
    { name: "IDENTITY WINDOW", text: window.text, spans: window.spans }
  ]) {
    if (!view.text) continue;
    const measurement = lineBreakMeasurement(view.text);
    const unwrapped = unwrapTypographicLineBreaks(view.text);
    const started = Date.now();
    const summary = summarizeSource({ text: view.text, closedClass, maxChars: SUMMARY_CHARS });
    console.log(`######## ${title} -- ${view.name} (${view.spans} spans, ${view.text.length} chars) ########`);
    console.log(`line breaks: paragraph-final ${measurement.paragraphFinal} closing ${(100 * measurement.paragraphFinalRate).toFixed(1)}%`
      + ` | interior ${measurement.interior} closing ${(100 * measurement.interiorRate).toFixed(1)}%`
      + ` -> ${unwrapped === view.text ? "kept as sentence ends" : "joined as typographic wrap"}`);
    console.log(`summary (${Date.now() - started} ms):\n${summary || "(empty)"}\n`);
  }
}
await client.end();
