#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
// Re-chunks oversized evidence spans in place, from text already in the
// database. No re-fetch, no re-parse, no graph rebuild, no retraining.
//
// Why this exists: maxChunkBytes was 131072, so segmentByParagraphs merged
// whole articles into a single evidence span (1.04 spans per document, up to
// 131024 characters). Retrieval's unit was therefore an entire encyclopedia
// article, and evidenceFeatures' `.sort().slice(0, 1100)` truncated the index
// ALPHABETICALLY on top of that, so roughly the first 82 distinct words of an
// article were searchable and everything after "l" was not. The 2026-08-18
// sealed run scored 0/160 on cloze because of it.
//
// Every span satisfies octet_length(text_content) = byte_end - byte_start, so
// a child's global offset is parent.byte_start + its local offset and every
// citation byte range stays exact.
//
// Parents are NOT deleted: 579275 graph nodes reference their evidence ids.
// They stay promoted and are outranked by their own children, because
// searchEvidence now ranks by BM25 with length normalisation rather than raw
// overlap count.
//
// Resumable: a child's id is derived from (sourceVersionId, byteStart,
// byteEnd, contentHash), so re-running skips work already committed rather
// than duplicating it.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const require = createRequire(path.join(repoRoot, "packages", "adapters-node", "package.json"));

const { Client } = require("pg");
const { createEvidenceExtractor } = await import(new URL("packages/kernel/dist/evidence.js", `file://${repoRoot.replace(/\\/g, "/")}/`).href);
const { createHasher, createClock } = await import(new URL("packages/kernel/dist/primitives.js", `file://${repoRoot.replace(/\\/g, "/")}/`).href);
const { createIdFactory } = await import(new URL("packages/kernel/dist/ids.js", `file://${repoRoot.replace(/\\/g, "/")}/`).href);
const { createLanguageAcquisitionEngine } = await import(new URL("packages/kernel/dist/language.js", `file://${repoRoot.replace(/\\/g, "/")}/`).href);

const args = new Map(process.argv.slice(2).map(a => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "true"]; }));
const SCHEMA = args.get("schema") ?? "scce3_runtime";
const CHUNK_BYTES = Number(args.get("chunk-bytes") ?? 4096);
const BATCH = Number(args.get("batch") ?? 50);
const LIMIT = args.get("limit") ? Number(args.get("limit")) : Infinity;
const DRY_RUN = args.get("dry-run") === "true";

const url = process.env.SCCE_DATABASE_URL;
if (!url) { console.error("SCCE_DATABASE_URL is required"); process.exit(1); }

const hasher = createHasher();
const ids = createIdFactory({ clock: createClock({ fixedTime: 1, stepMs: 1 }), hasher, deterministicReplay: true, namespace: "rechunk-backfill" });
const language = createLanguageAcquisitionEngine({ idFactory: ids });
const extractor = createEvidenceExtractor({ idFactory: ids, hasher });

const client = new Client({ connectionString: url });
await client.connect();

const t = name => `"${SCHEMA}"."${name}"`;
const totals = { parents: 0, children: 0, inserted: 0, skipped: 0, failed: 0 };
const started = Date.now();

const { rows: [{ n: pending }] } = await client.query(
  `SELECT count(*)::int AS n FROM ${t("evidence_spans")} WHERE status='promoted' AND octet_length(text_content) > $1`, [CHUNK_BYTES]
);
console.error(`oversized parents to process: ${pending} (chunk-bytes=${CHUNK_BYTES}${DRY_RUN ? ", DRY RUN" : ""})`);

let lastId = "";
while (totals.parents < LIMIT) {
  const { rows } = await client.query(
    `SELECT id, source_id, source_version_id, content_hash, media_type, byte_start, char_start,
            text_content, trust_vector, provenance_json, information_label, observed_at, status, alpha
       FROM ${t("evidence_spans")}
      WHERE status='promoted' AND octet_length(text_content) > $1 AND id > $2
      ORDER BY id ASC LIMIT $3`,
    [CHUNK_BYTES, lastId, Math.min(BATCH, LIMIT - totals.parents)]
  );
  if (rows.length === 0) break;

  for (const parent of rows) {
    lastId = parent.id;
    totals.parents++;
    let children;
    try {
      const profile = language.acquire({ sourceVersionId: parent.source_version_id, text: parent.text_content.slice(0, 40000), createdAt: 1 });
      const extracted = extractor.extract({
        sourceId: parent.source_id,
        sourceVersionId: parent.source_version_id,
        contentHash: parent.content_hash,
        mediaType: parent.media_type ?? "text/plain",
        text: parent.text_content,
        maxChunkBytes: CHUNK_BYTES,
        observedAt: parent.observed_at instanceof Date ? parent.observed_at.getTime() : Number(parent.observed_at) || Date.now(),
        sourceTrust: (parent.trust_vector && parent.trust_vector.sourceTrust) || parent.trust_vector || {},
        languageProfile: profile,
        exactSourceText: true
      });
      children = extracted.spans ?? extracted;
    } catch (error) {
      totals.failed++;
      console.error(`  ! extract failed for ${parent.id}: ${error.message}`);
      continue;
    }
    if (children.length <= 1) { totals.skipped++; continue; }
    totals.children += children.length;
    if (DRY_RUN) continue;

    try {
      await client.query("BEGIN");
      for (const child of children) {
        // Offsets are rebased onto the parent so citation byte ranges stay
        // exact against the original source version.
        const byteStart = Number(parent.byte_start) + Number(child.byteStart);
        const byteEnd = Number(parent.byte_start) + Number(child.byteEnd);
        const charStart = Number(parent.char_start) + Number(child.charStart);
        const charEnd = Number(parent.char_start) + Number(child.charEnd);
        // A subdivision of admitted content inherits its parent's admission
        // outcome; it never earns a better one. Real ingestion runs
        // admission.decide() per source and can lower a span's alpha or
        // quarantine it outright (ingestion-runtime.ts), and this job
        // deliberately does not re-run that gate -- the parent already passed
        // it and the child is a strict subset of the same bytes. So the
        // parent's verdict is inherited instead of recomputed:
        //
        //   status: taken from the parent, never hardcoded "promoted"
        //   alpha:  clamped to the parent's, so a lowered-alpha source cannot
        //           produce children scored higher than it was
        //   trust:  the parent's admission/action audit is carried over, so a
        //           child's provenance is not thinner than its parent's
        //
        // Measured before this was added: 642 of 4374 children (15%) had a
        // higher alpha than the parent they were cut from.
        const childAlpha = Math.min(Number(child.alpha), Number(parent.alpha));
        const parentTrust = parent.trust_vector && typeof parent.trust_vector === "object" ? parent.trust_vector : {};
        const childTrust = child.trustVector && typeof child.trustVector === "object" ? child.trustVector : {};
        const childTrustVector = { ...childTrust };
        for (const key of ["admission", "action", "sourceTrust", "forceClass"]) {
          if (parentTrust[key] !== undefined && childTrustVector[key] === undefined) childTrustVector[key] = parentTrust[key];
        }

        // evidence_spans.content_hash is a foreign key into the
        // content-addressed blob store, so a child's bytes must exist there
        // before the span referencing them can.
        const childBytes = Buffer.from(child.text, "utf8");
        await client.query(
          `INSERT INTO ${t("blobs")} (content_hash, media_type, byte_length, content, created_at)
           VALUES ($1,$2,$3,$4,now()) ON CONFLICT (content_hash) DO NOTHING`,
          [String(child.contentHash), parent.media_type ?? "text/plain", childBytes.byteLength, childBytes]
        );
        const res = await client.query(
          `INSERT INTO ${t("evidence_spans")}
             (id, source_id, source_version_id, chunk_id, content_hash, media_type,
              byte_start, byte_end, char_start, char_end, text_preview, text_content,
              language_hints, script_hints, trust_vector, provenance_json, features,
              status, alpha, observed_at, information_label)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
           ON CONFLICT (id) DO NOTHING`,
          [
            String(child.id), parent.source_id, parent.source_version_id, String(child.chunkId),
            String(child.contentHash), parent.media_type, byteStart, byteEnd, charStart, charEnd,
            String(child.textPreview ?? child.text).slice(0, 2000), child.text,
            child.languageHints ?? {}, child.scriptHints ?? {},
            childTrustVector, parent.provenance_json ?? {},
            child.features, parent.status, childAlpha, parent.observed_at,
            parent.information_label
          ]
        );
        if (res.rowCount === 0) { totals.skipped++; continue; }
        totals.inserted++;
        const anchors = child.features.filter(f => f.startsWith("anchor:bi:") || f.startsWith("anchor:sym:"));
        if (anchors.length) {
          await client.query(
            `INSERT INTO ${t("evidence_anchor_index")} (evidence_id, features)
             VALUES ($1,$2) ON CONFLICT (evidence_id) DO UPDATE SET features = EXCLUDED.features`,
            [String(child.id), anchors]
          );
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      totals.failed++;
      console.error(`  ! insert failed for ${parent.id}: ${error.message}`);
    }
  }
  const elapsed = (Date.now() - started) / 1000;
  const rate = totals.parents / Math.max(1, elapsed);
  const remaining = Math.max(0, pending - totals.parents);
  console.error(`  ${totals.parents}/${pending} parents | ${totals.inserted} inserted | ${totals.failed} failed | ${rate.toFixed(1)}/s | eta ${(remaining / Math.max(0.01, rate) / 60).toFixed(1)}min`);
}

console.error(`\ndone in ${((Date.now() - started) / 1000 / 60).toFixed(1)}min: ${JSON.stringify(totals)}`);
await client.end();
