#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Relation promotion judges a relation by how many independent sources support it, but it only ever saw the
// candidates of the ingestion run in hand -- so a corpus taken a batch at a time never reached that threshold
// (measured: 0 promoted of 138 decisions, 137 of them short of independent sources). Ingestion now carries its
// observations forward; this re-derives them for a corpus ingested before that, from stored blobs and spans,
// without re-fetching or re-chunking anything.
//   node tools/accumulate-relation-observations.mjs [--apply] [--limit=N] [--batch=N] [--report]
//                                                   [--after=<source_version_id>] [--resume] [--schema=scce3_runtime]
// Corpus-wide it sweeps by source_version_id keyset, one short transaction per batch, so the live server is never
// behind a long write transaction and the run restarts where it stopped. --report additionally holds every
// observation in memory and compiles the promotion model, which only fits a bounded --limit.
// Reads the database URL from SCCE_DATABASE_URL.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(here, "..", "packages", "adapters-node", "package.json"));
const pg = require("pg");
const kernel = await import(pathToFileURL(path.join(here, "..", "packages", "kernel", "dist", "index.js")).href);

const flag = name => process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
const apply = process.argv.includes("--apply");
const report = process.argv.includes("--report");
const resume = process.argv.includes("--resume");
const schema = flag("schema") ?? "scce3_runtime";
const limit = Number(flag("limit") ?? Number.MAX_SAFE_INTEGER);
// Cost bounds, not modelling parameters: how much of the corpus one transaction and one heap may hold at a time.
const batchVersions = Number(flag("batch") ?? 64);
const batchBytes = 64 * 1024 * 1024;
const insertChunkRows = 500;
if (!/^[a-z0-9_]+$/u.test(schema)) throw new Error("schema must be a plain identifier");
if (!Number.isFinite(limit) || limit <= 0) throw new Error("--limit must be a positive number");
if (!Number.isFinite(batchVersions) || batchVersions <= 0) throw new Error("--batch must be a positive number");
const url = process.env.SCCE_DATABASE_URL;
if (!url) throw new Error("SCCE_DATABASE_URL is not set");

const statePath = path.join(here, "..", "artifacts", "relation-observation-backfill.json");
const readState = () => { try { return JSON.parse(fs.readFileSync(statePath, "utf8")); } catch { return null; } };
const writeState = state => {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify(state, null, 1));
};

const hasher = kernel.createHasher();
const idFactory = kernel.createIdFactory({
  clock: kernel.createClock({ fixedTime: 0 }),
  hasher,
  namespace: "relation-observation-backfill"
});
const projector = kernel.createTypedIngestProjector({ idFactory, hasher });

const client = new pg.Client({ connectionString: url });
await client.connect();
const started = Date.now();
let cursor = flag("after") ?? (resume ? readState()?.cursor ?? "" : "");
const totals = { versionsSeen: 0, versionsProjected: 0, versionsSkipped: 0, observations: 0, inserted: 0, oversizeSignatures: 0, byChannel: {}, oversizeSamples: [] };
if (resume) {
  const prior = readState();
  if (prior?.totals) for (const key of Object.keys(totals)) if (typeof prior.totals[key] === "number") totals[key] = prior.totals[key];
  if (prior?.totals?.byChannel) totals.byChannel = { ...prior.totals.byChannel, ...totals.byChannel };
}
const reportRows = report ? new Map() : null;

try {
  for (;;) {
    if (totals.versionsSeen >= limit) break;
    const take = Math.min(batchVersions, limit - totals.versionsSeen);
    const versions = (await client.query(
      `select v.id, v.source_id, v.media_type, v.metadata_json, v.observed_at, v.byte_length, b.content
       from ${schema}.source_versions v join ${schema}.blobs b on b.content_hash = v.content_hash
       where v.id > $1 order by v.id limit $2`,
      [cursor, take]
    )).rows;
    if (!versions.length) break;

    // One span query per batch. Per version it was 24,735 round trips against the largest table in the schema.
    const spansByVersion = new Map();
    for (const span of (await client.query(
      `select id, source_id, source_version_id, content_hash, media_type, byte_start, byte_end, char_start, char_end,
              text_preview, text_content, language_hints, script_hints, trust_vector, provenance_json, features, status, alpha, observed_at
       from ${schema}.evidence_spans where source_version_id = any($1::text[]) and status = 'promoted'`,
      [versions.map(version => version.id)]
    )).rows) {
      const bucket = spansByVersion.get(span.source_version_id);
      if (bucket) bucket.push(span); else spansByVersion.set(span.source_version_id, [span]);
    }

    const batchObservations = new Map();
    let batchBytesSeen = 0;
    for (const version of versions) {
      cursor = version.id;
      totals.versionsSeen++;
      const spans = spansByVersion.get(version.id);
      if (!spans?.length) { totals.versionsSkipped++; continue; }
      const text = Buffer.isBuffer(version.content) ? version.content.toString("utf8") : String(version.content ?? "");
      if (!text) { totals.versionsSkipped++; continue; }
      batchBytesSeen += text.length;
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
          const key = [row.relationSeedId, row.channel, row.sourceFamilyId, row.signature].join("|");
          // The observation is as old as the document that states it. Stamping one instant across a whole
          // backfill ties every row and hands promotion an order it cannot reproduce.
          batchObservations.set(key, { ...row, observedAt: new Date(version.observed_at) });
          if (reportRows) reportRows.set(key, row);
        }
        totals.versionsProjected++;
      } catch (error) {
        totals.versionsSkipped++;
        if (process.env.SCCE_VERBOSE) console.log(`skipped ${version.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (batchBytesSeen > batchBytes) break;
    }

    // A btree key is bounded at 2704 bytes by PostgreSQL, and the primary key here is the whole signature. A
    // signature that long is a candidate with hundreds of participants -- a serialized structure, not a relation --
    // and its shape is unique to one document, so it can never corroborate anything. Counted and reported.
    const rows = [];
    for (const row of batchObservations.values()) {
      const keyBytes = Buffer.byteLength(row.relationSeedId) + Buffer.byteLength(row.channel)
        + Buffer.byteLength(row.sourceFamilyId) + Buffer.byteLength(row.signature);
      if (keyBytes > 2600) {
        totals.oversizeSignatures++;
        if (totals.oversizeSamples.length < 8) totals.oversizeSamples.push({ channel: row.channel, keyBytes, sourceId: row.sourceId, signatureHead: row.signature.slice(0, 200) });
        continue;
      }
      rows.push(row);
    }
    totals.observations += rows.length;
    for (const row of rows) totals.byChannel[row.channel] = (totals.byChannel[row.channel] ?? 0) + 1;

    if (apply && rows.length) {
      // One short transaction per batch. The single corpus-wide transaction this replaces would have held write
      // locks for hours while four other lanes measured against the same server.
      await client.query("begin");
      try {
        for (let offset = 0; offset < rows.length; offset += insertChunkRows) {
          const chunk = rows.slice(offset, offset + insertChunkRows);
          const params = [];
          const tuples = chunk.map(row => {
            params.push(row.relationSeedId, row.channel, row.sourceFamilyId, row.signature, row.candidateId, row.sourceId, row.observedAt);
            const base = params.length - 7;
            return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7})`;
          });
          const result = await client.query(
            `insert into ${schema}.relation_observations(relation_seed_id,channel,source_family_id,signature,candidate_id,source_id,observed_at)
             values ${tuples.join(",")} on conflict(relation_seed_id,channel,source_family_id,signature) do nothing`,
            params
          );
          totals.inserted += result.rowCount ?? 0;
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      }
      writeState({ cursor, totals, updatedAt: new Date().toISOString() });
    }

    const elapsed = (Date.now() - started) / 1000;
    console.log(`${totals.versionsSeen} versions | projected ${totals.versionsProjected} skipped ${totals.versionsSkipped} | observations ${totals.observations} inserted ${totals.inserted} | ${elapsed.toFixed(0)}s`);
  }

  console.log(`swept ${totals.versionsSeen} versions -> ${totals.observations} observations, ${totals.inserted} new rows stored`);
  console.log(`by channel: ${JSON.stringify(totals.byChannel)}`);
  console.log(`oversize signatures refused by the index: ${totals.oversizeSignatures}`);
  for (const sample of totals.oversizeSamples) console.log(`  oversize ${sample.channel} ${sample.keyBytes}B ${sample.sourceId} ${sample.signatureHead}`);

  if (reportRows) {
    const rows = [...reportRows.values()];
    const families = new Set(rows.map(row => row.sourceFamilyId));
    console.log(`report over ${rows.length} observations across ${families.size} source families`);
    const model = kernel.compileRelationPromotionModel({ candidates: [], priorObservations: rows, hasher });
    const promoted = model.decisions.filter(decision => decision.promoted);
    console.log(`promotion over the accumulated corpus: ${promoted.length} promoted of ${model.decisions.length} decisions`);
    for (const decision of promoted.slice(0, 16)) {
      console.log(`  PROMOTED ${decision.relationSeedId} channel=${decision.channel} sources=${decision.independentSourceCount} gain=${decision.descriptionLength.gainNats}`);
    }
  }
  if (!apply) console.log("dry run: re-run with --apply to store these observations");
} finally {
  await client.end();
}
