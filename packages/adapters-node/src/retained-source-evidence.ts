// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { normalizeInformationLabel, type EvidenceSpanReference, type EvidenceStore } from "@scce/kernel";
import type { PostgresStorageAdapter } from "./postgres.js";

type Host = Pick<PostgresStorageAdapter, "query" | "table" | "informationAccessPredicate">;
interface HeaderRow { id: string; chunk_id: string; source_id: string; source_version_id: string; content_hash: string; media_type: string;
  byte_start: string; byte_end: string; char_start: string; char_end: string; status: "promoted" | "quarantined"; alpha: string;
  observed_at: Date; information_label: EvidenceSpanReference["informationLabel"] }
const columns = ["id", "chunk_id", "source_id", "source_version_id", "content_hash", "media_type", "byte_start", "byte_end", "char_start", "char_end", "status", "alpha", "observed_at", "information_label"].map(column => `evidence.${column}`).join(",");

/** Exact retained references use indexed IDs first; only absent IDs require a source-range lookup. */
export async function resolveRetainedSourceEvidence(host: Host, input: Parameters<NonNullable<EvidenceStore["resolveEvidenceSpanReferences"]>>[0]): Promise<EvidenceSpanReference[]> {
  if (!input.sourceVersionId || input.spans.some(span => !span.id || ![span.byteStart, span.byteEnd].every(Number.isSafeInteger)
    || span.byteStart < 0 || span.byteEnd <= span.byteStart || !/^sha256[_:][a-f0-9]{64}$/u.test(String(span.contentHash)))) throw new Error("invalid retained source evidence ranges");
  const found = new Map<string, HeaderRow>();
  for (let offset = 0; offset < input.spans.length; offset += 2048) {
    const batch = input.spans.slice(offset, offset + 2048), access = host.informationAccessPredicate("evidence", 3);
    const sourceAccess = host.informationAccessPredicate("version", 3 + access.params.length);
    const rows = await host.query<HeaderRow>(`SELECT ${columns} FROM ${host.table("evidence_spans")} evidence
      JOIN ${host.table("source_versions")} version ON version.id=evidence.source_version_id AND version.source_id=evidence.source_id
      WHERE evidence.source_version_id=$2 AND evidence.id=ANY($1::text[]) AND ${access.sql} AND ${sourceAccess.sql}`, [batch.map(span => span.id), input.sourceVersionId, ...access.params, ...sourceAccess.params]);
    for (const row of rows) { if (!batch.some(span => span.id === row.id) || found.has(row.id)) throw new Error("retained evidence ID lookup returned an invalid inventory"); found.set(row.id, row); }
    const missing = batch.filter(span => !found.has(span.id));
    if (!missing.length) continue;
    const rangeAccess = host.informationAccessPredicate("evidence", 4), rangeSourceAccess = host.informationAccessPredicate("version", 4 + rangeAccess.params.length);
    const matches = await host.query<HeaderRow>(`WITH retained_source_headers AS MATERIALIZED (
      SELECT ${columns} FROM ${host.table("evidence_spans")} evidence
      JOIN ${host.table("source_versions")} version ON version.id=evidence.source_version_id AND version.source_id=evidence.source_id
      WHERE evidence.source_version_id=$2 AND evidence.byte_start=ANY($3::bigint[]) AND ${rangeAccess.sql} AND ${rangeSourceAccess.sql})
      SELECT DISTINCT ON (requested.ordinal) ${columns}
      FROM jsonb_to_recordset($1::jsonb) AS requested(ordinal int,byte_start bigint,byte_end bigint,content_hash text)
      JOIN retained_source_headers evidence ON evidence.byte_start=requested.byte_start
        AND evidence.byte_end=requested.byte_end AND evidence.content_hash=requested.content_hash
      ORDER BY requested.ordinal,evidence.id`,
      [JSON.stringify(missing.map((span, ordinal) => ({ ordinal, byte_start: span.byteStart, byte_end: span.byteEnd, content_hash: span.contentHash }))), input.sourceVersionId,
        [...new Set(missing.map(span => span.byteStart))], ...rangeAccess.params, ...rangeSourceAccess.params]);
    if (matches.length > missing.length) throw new Error("retained source range lookup exceeded its exact inventory");
    for (const row of matches) {
      if (row.source_version_id !== input.sourceVersionId || !missing.some(span => Number(row.byte_start) === span.byteStart && Number(row.byte_end) === span.byteEnd && row.content_hash === span.contentHash)) throw new Error("retained source range lookup returned a foreign range");
      found.set(row.id, row);
    }
  }
  return [...found.values()].map(row => ({ id: row.id as EvidenceSpanReference["id"], chunkId: row.chunk_id as EvidenceSpanReference["chunkId"],
    sourceId: row.source_id as EvidenceSpanReference["sourceId"], sourceVersionId: row.source_version_id as EvidenceSpanReference["sourceVersionId"],
    contentHash: row.content_hash as EvidenceSpanReference["contentHash"], mediaType: row.media_type, byteStart: Number(row.byte_start), byteEnd: Number(row.byte_end),
    charStart: Number(row.char_start), charEnd: Number(row.char_end), status: row.status, alpha: Number(row.alpha), observedAt: row.observed_at.getTime(),
    informationLabel: row.information_label ? normalizeInformationLabel(row.information_label) : undefined }));
}
