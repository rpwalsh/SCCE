#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Relation promotion judges a relation by how many independent sources support it, but it only ever saw the
// candidates of the ingestion run in hand -- so a corpus taken a batch at a time never reached that threshold
// (measured: 0 promoted of 138 decisions, 137 of them short of independent sources). Ingestion now carries its
// observations forward; this re-derives them for a corpus ingested before that, from stored blobs and spans,
// without re-fetching or re-chunking anything.
//   node tools/accumulate-relation-observations.mjs [--apply] [--limit=N] [--schema=scce3_runtime]
// Without --apply it reports what promotion would decide. Reads the database URL from SCCE_DATABASE_URL.
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "packages", "adapters-node", "package.json"));
const pg = require("pg");
const kernel = await import(pathToFileURL(path.join(here, "..", "packages", "kernel", "dist", "index.js")).href);

const apply = process.argv.includes("--apply");
const schema = process.argv.find(arg => arg.startsWith("--schema="))?.slice(9) ?? "scce3_runtime";
const limit = Number(process.argv.find(arg => arg.startsWith("--limit="))?.slice(8) ?? 4000);
if (!/^[a-z0-9_]+$/u.test(schema)) throw new Error("schema must be a plain identifier");
if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit must be a positive number");
const url = process.env.SCCE_DATABASE_URL;
if (!url) throw new Error("SCCE_DATABASE_URL is not set");

const hasher = kernel.createHasher();
const idFactory = kernel.createIdFactory({
  clock: kernel.createClock({ fixedTime: 0 }),
  hasher,
  namespace: "relation-observation-backfill"
});
const projector = kernel.createTypedIngestProjector({ idFactory, hasher });

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  const versions = (await client.query(
    `select v.id, v.source_id, v.media_type, v.metadata_json, v.observed_at, b.content
     from ${schema}.source_versions v join ${schema}.blobs b on b.content_hash = v.content_hash
     order by v.observed_at desc limit $1`,
    [limit]
  )).rows;
  console.log(`${versions.length} source versions with stored content`);

  // Only the observations are kept: holding every projected candidate exhausted the heap at a few thousand
  // documents, and promotion needs the sufficient statistics, not the candidates they came from.
  const observations = new Map();
  let projected = 0;
  for (const version of versions) {
    const spans = (await client.query(
      `select id, source_id, source_version_id, content_hash, media_type, byte_start, byte_end, char_start, char_end,
              text_preview, text_content, language_hints, script_hints, trust_vector, provenance_json, features, status, alpha, observed_at
       from ${schema}.evidence_spans where source_version_id = $1 and status = 'promoted'`,
      [version.id]
    )).rows;
    if (!spans.length) continue;
    const text = Buffer.isBuffer(version.content) ? version.content.toString("utf8") : String(version.content ?? "");
    if (!text) continue;
    const metadata = version.metadata_json ?? {};
    try {
      const projection = projector.project({
        sourceId: version.source_id,
        sourceVersionId: version.id,
        uri: String(metadata.uri ?? metadata.canonicalUri ?? version.id),
        mediaType: version.media_type,
        text,
        metadata,
        evidence: spans.map(span => ({
          id: span.id,
          sourceId: span.source_id,
          sourceVersionId: span.source_version_id,
          contentHash: span.content_hash,
          mediaType: span.media_type,
          byteStart: span.byte_start,
          byteEnd: span.byte_end,
          charStart: span.char_start,
          charEnd: span.char_end,
          textPreview: span.text_preview ?? "",
          text: span.text_content ?? span.text_preview ?? "",
          languageHints: span.language_hints ?? [],
          scriptHints: span.script_hints ?? [],
          trustVector: span.trust_vector ?? {},
          provenance: span.provenance_json ?? {},
          features: span.features ?? [],
          status: span.status,
          alpha: Number(span.alpha ?? 0),
          observedAt: new Date(span.observed_at).getTime()
        })),
        observedAt: new Date(version.observed_at).getTime()
      });
      for (const row of kernel.relationObservationsFromCandidates(projection.semanticCandidates)) {
        observations.set([row.relationSeedId, row.channel, row.sourceFamilyId, row.signature].join(""), row);
      }
      projected++;
    } catch (error) {
      if (process.env.SCCE_VERBOSE) console.log(`skipped ${version.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const rows = [...observations.values()];
  const families = new Set(rows.map(row => row.sourceFamilyId));
  console.log(`projected ${projected} versions -> ${rows.length} observations across ${families.size} source families`);

  const model = kernel.compileRelationPromotionModel({ candidates: [], priorObservations: rows, hasher });
  const promoted = model.decisions.filter(decision => decision.promoted);
  console.log(`promotion over the accumulated corpus: ${promoted.length} promoted of ${model.decisions.length} decisions`);
  for (const decision of model.decisions.slice(0, 8)) {
    console.log(`  ${decision.relationSeedId} sources=${decision.independentSourceCount} gain=${decision.descriptionLength.gainNats} promoted=${decision.promoted}${decision.reasons.length ? " reasons=" + decision.reasons.join(",") : ""}`);
  }

  if (!apply) { console.log("dry run: re-run with --apply to store these observations"); process.exit(0); }
  await client.query("begin");
  for (const row of rows) {
    await client.query(
      `insert into ${schema}.relation_observations(relation_seed_id,channel,source_family_id,signature,candidate_id,source_id,observed_at)
       values($1,$2,$3,$4,$5,$6,now()) on conflict(relation_seed_id,channel,source_family_id,signature) do nothing`,
      [row.relationSeedId, row.channel, row.sourceFamilyId, row.signature, row.candidateId, row.sourceId]
    );
  }
  await client.query("commit");
  console.log(`stored ${rows.length} observations`);
} catch (error) {
  await client.query("rollback").catch(() => undefined);
  throw error;
} finally {
  await client.end();
}
