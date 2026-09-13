#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Fiction is not code, and a prose document is direct evidence whatever folder it arrived from.
//
// Measured 2026-09-12: the structural source parser ran over the fifteen public-domain novels and reported 257
// calls, 199 tests and 48 declarations in A Tale of Two Cities. That stored `metadata.sourceCode` on the book
// spans, classified them `developer_intelligence` and `profile_excerpt_evidence`, and prose retrieval excludes
// both -- so "Who is Mr Darcy?" could not see Pride and Prejudice at all, while the same query without those
// exclusions returned nothing but Pride and Prejudice. The ingest path no longer does this (code-graph.ts now
// decides by declared type); this corrects the rows it already wrote.
//
//   node tools/reclassify-text-sources.mjs              # report
//   node tools/reclassify-text-sources.mjs --apply      # correct the rows
//
// Scope: sources whose URI is a plain-text document. Wikipedia batches and the owner's repository are untouched.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
const pg = createRequire(pathToFileURL(path.resolve("packages/adapters-node/package.json")))("pg");

const apply = process.argv.includes("--apply");
const base = JSON.parse(readFileSync("scce.config.json", "utf8"));
let local = {};
try { local = JSON.parse(readFileSync("scce.config.local.json", "utf8")); } catch { /* optional */ }
const url = process.env.SCCE_DATABASE_URL ?? local?.database?.url ?? base?.database?.url;
const schema = local?.database?.schema ?? base?.database?.schema ?? "scce3_runtime";
if (!url) throw new Error("no database url; set SCCE_DATABASE_URL or configure scce.config.local.json");
const client = new pg.Client({ connectionString: url });
await client.connect();
await client.query(`SET search_path TO "${schema}"`);
await client.query("SET statement_timeout='900s'");

// A text document that is misfiled in any of the three ways: wrong force class, filed as developer
// intelligence at either level, or carrying source-code facts mined out of prose.
const PREDICATE = `
  s.canonical_uri ~* '\\.(txt|md|rst|text)$'
    AND (e.provenance_json->>'forceClass' IS DISTINCT FROM 'direct_evidence'
         OR COALESCE(e.provenance_json->>'sourceKind', e.provenance_json->'metadata'->>'sourceKind') = 'developer_intelligence'
         OR COALESCE(e.provenance_json->'metadata'->'sourceCode', 'null'::jsonb) <> 'null'::jsonb)`;

const before = await client.query(`
  SELECT COALESCE(e.provenance_json->>'forceClass','(none)') AS force_class,
         COALESCE(e.provenance_json->>'sourceKind', e.provenance_json->'metadata'->>'sourceKind','(none)') AS source_kind,
         (COALESCE(e.provenance_json->'metadata'->'sourceCode','null'::jsonb) <> 'null'::jsonb) AS parsed_as_code,
         count(*) AS spans, count(DISTINCT s.id) AS sources
  FROM evidence_spans e
  JOIN source_versions v ON v.id = e.source_version_id
  JOIN sources s ON s.id = v.source_id
  WHERE ${PREDICATE}
  GROUP BY 1, 2, 3 ORDER BY 4 DESC
`);
if (!before.rowCount) {
  console.log("nothing to reclassify");
  await client.end();
  process.exit(0);
}
for (const row of before.rows) {
  console.log(`${String(row.spans).padStart(6)} spans / ${String(row.sources).padStart(3)} sources   forceClass=${row.force_class}  sourceKind=${row.source_kind}  parsedAsCode=${row.parsed_as_code}`);
}

if (!apply) {
  console.log("\n(dry run, nothing written)");
  await client.end();
  process.exit(0);
}

// Three corrections in one write: prose is direct evidence; a text document is not developer intelligence (at
// either level -- retrieval excludes on the top-level field); and a novel's "declarations" are not facts about
// it, so the parser's output is removed rather than corrected.
const result = await client.query(`
  UPDATE evidence_spans e
  SET provenance_json = jsonb_set(
        (CASE WHEN e.provenance_json->'metadata'->>'sourceKind' = 'developer_intelligence'
              THEN jsonb_set(e.provenance_json, '{metadata,sourceKind}', '"local_document"'::jsonb, true)
              ELSE e.provenance_json END
         || CASE WHEN e.provenance_json->>'sourceKind' = 'developer_intelligence'
                 THEN jsonb_build_object('sourceKind', 'local_document')
                 ELSE '{}'::jsonb END)
        #- '{metadata,sourceCode}',
        '{forceClass}', '"direct_evidence"'::jsonb, true)
  FROM source_versions v, sources s
  WHERE v.id = e.source_version_id AND s.id = v.source_id
    AND ${PREDICATE}
`);
console.log(`\n${result.rowCount} spans corrected: direct evidence, not developer intelligence, no source-code facts`);
await client.end();
