#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Gives every source that arrived without a title an identity derived from its own content, so retrieval can
// anchor a named subject to it. Wikipedia ships titles; a book, a PDF, a note or a source file does not, and
// without one a request that names a subject declines with "no grounded source" while the document sits in the
// corpus. Measured 2026-09-12: all 45 Gutenberg texts had a NULL title and "Moby-Dick" was unanswerable.
//
//   node tools/derive-source-identity.mjs --dry-run        # report what it would write
//   node tools/derive-source-identity.mjs --apply          # write provenance.title for title-less spans
//
// Idempotent: only spans whose provenance carries no title are touched, so re-running changes nothing and a
// source that later gains a real title keeps it.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { deriveSourceIdentityUnits, deriveClosedClassWords, sourceTitleFromUri } from "../packages/kernel/dist/index.js";
// Resolved from the repository, not from one machine's checkout path (same recipe as scripts/db.mjs).
const pg = createRequire(pathToFileURL(path.resolve("packages/adapters-node/package.json")))("pg");

const args = new Set(process.argv.slice(2));
const apply = args.has("--apply");
const limitSources = Number((process.argv.find(a => a.startsWith("--limit=")) ?? "--limit=0").split("=")[1]) || 0;
// The identity is a set, and matching asks whether every unit the request names is present, so extra units are
// free while a missing one costs the answer: "moby" ranks below "ahab" in Moby-Dick and still must be carried.
const identityLimit = Number((process.argv.find(a => a.startsWith("--width=")) ?? "--width=32").split("=")[1]) || 32;
// Restricts which sources are touched. Training batches of raw wikitext derive markup for an identity, which
// would hijack a request naming a subject that happens to appear in one, so a run is scoped deliberately.
const uriFilter = (process.argv.find(a => a.startsWith("--uri-like=")) ?? "--uri-like=").split("=")[1] ?? "";

function databaseConfig() {
  const base = JSON.parse(readFileSync("scce.config.json", "utf8"));
  let local = {};
  try { local = JSON.parse(readFileSync("scce.config.local.json", "utf8")); } catch { /* optional */ }
  const url = process.env.SCCE_DATABASE_URL ?? local?.database?.url ?? base?.database?.url;
  const schema = local?.database?.schema ?? base?.database?.schema ?? "scce3_runtime";
  if (!url) throw new Error("no database url; set SCCE_DATABASE_URL or configure scce.config.local.json");
  return { url, schema };
}

const { url, schema } = databaseConfig();
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`SET search_path TO "${schema}"`);

// Units the same way the kernel splits them: whitespace on a lowercased surface, four characters or more.
const unitsOf = text => {
  const counts = new Map();
  for (const raw of String(text).toLocaleLowerCase().split(/\s+/u)) {
    const unit = raw.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
    if ([...unit].length < 4) continue;
    counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  return counts;
};

console.log("finding sources whose spans carry no title...");
const titleless = await client.query(`
  SELECT s.canonical_uri, e.source_version_id, count(*) AS spans
  FROM evidence_spans e
  JOIN source_versions v ON v.id = e.source_version_id
  JOIN sources s ON s.id = v.source_id
  -- Sources with no title, or whose title is a derived unit bag from an earlier run of this tool (the identity
  -- belongs in its own field; the title is the locator's name). source_title is the generated column, so this
  -- never decodes provenance_json.
  WHERE (e.source_title = '' OR array_length(string_to_array(e.source_title, ' '), 1) > 8)
    AND ($1 = '' OR s.canonical_uri LIKE '%' || $1 || '%')
  GROUP BY 1, 2
  ORDER BY count(*) DESC
  ${limitSources ? `LIMIT ${limitSources}` : ""}
`, [uriFilter]);
console.log(`  ${titleless.rowCount} source versions without a title\n`);
if (!titleless.rowCount) { await client.end(); process.exit(0); }

// Corpus frequency comes from the learned Kneser-Ney models, which already counted the whole corpus. A first
// attempt derived it from only the documents being backfilled and returned "that with chapter this from whale"
// for Moby-Dick: with a denominator of eight documents, function words looked rare. The models know better.
console.log("loading corpus term frequencies from the learned language models...");
const models = await client.query("SELECT model_json->'model'->'unigramCounts' AS counts, model_json->'model'->'continuationCounts' AS continuations FROM ngram_models");
// The corpus's own notion of function material, by continuation count -- the same derivation the runtime uses.
const closedClass = deriveClosedClassWords({
  models: models.rows.map(row => ({ continuationCounts: row.continuations ?? {}, unigramCounts: row.counts ?? {} })),
  limit: 160
});
console.log(`  closed class: ${closedClass.size} units`);
const corpusFrequency = new Map();
let corpusTokens = 0;
for (const row of models.rows) {
  for (const [unit, count] of Object.entries(row.counts ?? {})) {
    if ([...unit].length < 4) continue;
    const value = Number(count) || 0;
    corpusFrequency.set(unit, (corpusFrequency.get(unit) ?? 0) + value);
    corpusTokens += value;
  }
}
console.log(`  ${corpusFrequency.size} units, ${corpusTokens} tokens\n`);
// deriveSourceIdentityUnits takes document frequencies, so express corpus token frequency on the same scale:
// a unit seen f times out of T behaves like one present in f/T of a corpus of T documents.
const documentFrequency = new Map();
for (const [unit, count] of corpusFrequency) documentFrequency.set(unit, count);
const corpusSize = Math.max(1, corpusTokens);
const documents = [];

for (const row of titleless.rows) {
  // Spread the sample across the document: the first spans of a book are the licence header, not the book.
  const spans = await client.query(`
    SELECT text_content FROM (
      SELECT text_content, row_number() OVER (ORDER BY char_start) AS position, count(*) OVER () AS total
      FROM evidence_spans WHERE source_version_id = $1
    ) ranked
    WHERE position % GREATEST(1, (total / 40)::int) = 0
    LIMIT 40
  `, [row.source_version_id]);
  const counts = new Map();
  for (const span of spans.rows) {
    for (const [unit, count] of unitsOf(span.text_content ?? "")) {
      // What the corpus treats as function material identifies no document.
      if (closedClass.has(unit)) continue;
      counts.set(unit, (counts.get(unit) ?? 0) + count);
    }
  }
  // What a document calls itself, as distinct from what it is about. TF-IDF finds Ahab and the Pequod; it does
  // not find "Moby Dick", because the title phrase is rarer in the text than the whale is. Documents of every
  // format name themselves at the start -- a title page, a paper's header, an invoice, a file's first lines --
  // so the opening's rarest units are taken alongside the body's most distinctive ones.
  const opening = await client.query(
    "SELECT text_content FROM evidence_spans WHERE source_version_id = $1 ORDER BY char_start LIMIT 1",
    [row.source_version_id]
  );
  const openingCounts = new Map();
  for (const [unit, count] of unitsOf((opening.rows[0]?.text_content ?? "").slice(0, 600))) {
    if (closedClass.has(unit)) continue;
    openingCounts.set(unit, count);
  }
  // A source file is about what it declares: the parser facts ingestion already stored carry every declaration name.
  const declared = await client.query(`
    SELECT DISTINCT d->>'name' AS name
    FROM evidence_spans e, jsonb_array_elements(COALESCE(e.provenance_json->'metadata'->'sourceCode'->'declarations', '[]'::jsonb)) d
    WHERE e.source_version_id = $1 AND d->>'name' IS NOT NULL
    LIMIT 96
  `, [row.source_version_id]);
  documents.push({ uri: row.canonical_uri, sourceVersionId: row.source_version_id, counts, openingCounts, declarations: declared.rows.map(r => r.name), spans: Number(row.spans) });
}

let written = 0;
for (const document of documents) {
  const identity = deriveSourceIdentityUnits({
    documentUnitCounts: document.counts,
    corpusDocumentFrequency: documentFrequency,
    corpusDocumentCount: Math.max(corpusSize, documents.length),
    limit: identityLimit
  });
  // The opening's units, ranked by corpus rarity alone: they are stated once, so frequency says nothing.
  const named = deriveSourceIdentityUnits({
    documentUnitCounts: document.openingCounts,
    corpusDocumentFrequency: documentFrequency,
    corpusDocumentCount: Math.max(corpusSize, documents.length),
    limit: 10
  });
  const identityUnits = [...new Set([...named.map(row => row.unit), ...(document.declarations ?? []), ...identity.map(row => row.unit)])].join(" ");
  const title = sourceTitleFromUri(document.uri);
  if (!identityUnits && !title) continue;
  console.log(`${document.uri.split(/[\\/]/).pop()}`);
  console.log(`    title    -> ${title}`);
  console.log(`    identity -> ${identityUnits.slice(0, 120)}`);
  if (apply) {
    const result = await client.query(`
      UPDATE evidence_spans
      SET provenance_json = jsonb_set(jsonb_set(COALESCE(provenance_json, '{}'::jsonb), '{title}', to_jsonb($2::text), true), '{identity}', to_jsonb($3::text), true)
      WHERE source_version_id = $1
    `, [document.sourceVersionId, title, identityUnits]);
    written += result.rowCount;
  }
}

console.log(`\n${documents.length} sources${apply ? `, ${written} spans updated` : " (dry run, nothing written)"}`);
await client.end();
