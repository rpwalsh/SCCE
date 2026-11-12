// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import type { ContentHash, EvidenceSpan, InformationLabel } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";
import { encodeCanonicalEvidenceSpanText } from "../canonical-evidence-span-text.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const hash = (bytes: Uint8Array) => `sha256_${createHash("sha256").update(bytes).digest("hex")}` as ContentHash;
const label: InformationLabel = {tenantId: "fixture", principals: ["owner"], compartments: ["corpus"], exportClass: "restricted", mergePolicy: "isolated"};
function fixture() {
  const adapter = createPostgresStorageAdapter({url: "postgres://offline.invalid/no_database", schema: "evidence_canonical",
    informationAccess: {tenantId: "fixture", principalId: "owner", compartments: ["corpus"], maximumExportClass: "restricted"}});
  adapters.push(adapter);
  const bodies = new Map<string, Buffer>(), owners = new Map<string, {id: string; source_id: string; content_hash: string; byte_length: string}>();
  const allowed = new Set<string>(), calls: Array<{sql: string; params: unknown[]}> = [];
  function source(id: string, text: string) {
    const bytes = Buffer.from(text), content_hash = hash(bytes);
    bodies.set(content_hash, bytes); owners.set(id, {id, source_id: `source.${id}`, content_hash, byte_length: String(bytes.length)}); allowed.add(id);
    return bytes;
  }
  const a = source("a", "前置|雪🧭\r\n|後置"), b = source("b", "مرحبا e\u0301");
  function span(id: string, version: string, bytes: Buffer, start: number, end: number): EvidenceSpan {
    const text = bytes.subarray(start, end).toString("utf8"), charStart = [...bytes.subarray(0, start).toString("utf8")].length;
    return {id: id as EvidenceSpan["id"], sourceId: `source.${version}` as EvidenceSpan["sourceId"], sourceVersionId: version as EvidenceSpan["sourceVersionId"],
      chunkId: `chunk.${id}` as EvidenceSpan["chunkId"], contentHash: hash(Buffer.from(text)), mediaType: "text/plain", byteStart: start, byteEnd: end,
      charStart, charEnd: charStart + [...text].length, text, textPreview: `preview:${id}\t`, languageHints: {}, scriptHints: {}, trustVector: {identity: 1},
      provenance: {sourceKind: "fixture"}, features: ["anchor:sym:雪山大海", "sym:雪山大海", "sym:雪山大海"], status: "promoted", alpha: 0.5, observedAt: 1234, informationLabel: label};
  }
  const spans = [span("evidence.a.middle", "a", a, Buffer.byteLength("前置|"), Buffer.byteLength("前置|雪🧭\r\n")),
    span("evidence.b.opening", "b", b, 0, b.length), span("evidence.a.opening", "a", a, 0, Buffer.byteLength("前置"))];
  const rows = spans.map(item => {
    encodeCanonicalEvidenceSpanText(item);
    return {id: item.id, source_id: item.sourceId, source_version_id: item.sourceVersionId, chunk_id: item.chunkId, content_hash: item.contentHash,
      media_type: item.mediaType, byte_start: String(item.byteStart), byte_end: String(item.byteEnd), char_start: String(item.charStart), char_end: String(item.charEnd),
      text_preview: item.textPreview, language_hints: item.languageHints, script_hints: item.scriptHints,
      trust_vector: item.trustVector, provenance_json: item.provenance, features: item.features, status: item.status, alpha: String(item.alpha),
      observed_at: new Date(item.observedAt), information_label: label, visual_regions: [[0, 0, 1, 1]], visual_score: "0.875"};
  });
  Object.defineProperty(adapter, "transaction", {value: async <T>(operation: () => Promise<T>) => operation()});
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({sql, params});
    if (sql.includes("current_setting('enable_seqscan')")) return [{enabled: "on"}] as T[];
    if (sql.startsWith("SELECT sv.id,sv.source_id,sv.content_hash,sv.byte_length")) {
      return [...owners.values()].filter(owner => (params[0] as string[]).includes(owner.id) && allowed.has(owner.id)) as T[];
    }
    if (sql.includes('FROM "evidence_canonical"."blobs" blob')) {
      const bytes = bodies.get(String(params[0]));
      return (bytes ? [{content: bytes, byte_length: String(bytes.length), range_parent_hash: null, range_start: null, range_end: null, archive_reference: null, archive: null}] : []) as T[];
    }
    if (sql.startsWith("SELECT * FROM") && sql.includes('"evidence_spans" evidence')) {
      if (sql.includes("char_start=0")) return rows.filter(row => row.char_start === "0") as T[];
      return rows.filter(row => Array.isArray(params[0]) ? params[0].includes(row.id) : params[0] === row.id) as T[];
    }
    if (sql.includes("feature_postings AS") || sql.includes("feature_hits AS") || sql.startsWith("SELECT ev.*") || sql.startsWith("SELECT ev.*,")) return rows as T[];
    return [];
  };
  return {adapter, rows, spans, calls, bodies, owners, allowed};
}

describe("Postgres canonical evidence full-text path", () => {
  it("writes the canonical content reference and exact preview while omitting the full body and duplicate digest", async () => {
    const f = fixture(), before = structuredClone(f.spans[0]!);
    await f.adapter.evidence.putEvidenceSpans!(f.spans);
    const write = f.calls.find(call => call.sql.includes("INSERT INTO") && call.sql.includes("AS ev("))!;
    expect(write).toBeDefined(); expect(write.sql).not.toContain("text_content");
    expect(write.sql).toContain("text_preview, language_hints");
    expect(write.sql).not.toContain("text_sha256");
    const payload = JSON.parse(String(write.params[0])) as Array<Record<string, unknown>>;
    for (const [index, row] of payload.entries()) {
      expect(row).not.toHaveProperty("text"); expect(row).not.toHaveProperty("text_content");
      expect(row).not.toHaveProperty("text_sha256");
      expect(row.text_preview).toBe(f.spans[index]!.textPreview);
      expect(row.features_json).toEqual(f.spans[index]!.features);
    }
    expect(f.spans[0]).toEqual(before);
  });

  it("fails invalid logical text before any write/label I/O", async () => {
    const f = fixture(), broken = {...f.spans[0]!, text: "wrong"};
    await expect(f.adapter.evidence.putEvidenceSpan(broken)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it("batch-authorizes source versions before bytes, reads each source once and preserves interleaved database order", async () => {
    const f = fixture();
    const restored = await f.adapter.evidence.getEvidenceBatch(f.spans.map(span => span.id).reverse());
    expect(restored.map(span => span.id)).toEqual(f.spans.map(span => span.id));
    expect(restored.map(span => span.text)).toEqual(f.spans.map(span => span.text));
    expect(restored.map(span => span.textPreview)).toEqual(f.spans.map(span => span.textPreview));
    expect(restored.map(span => span.informationLabel)).toEqual(f.spans.map(() => label));
    const authorization = f.calls.findIndex(call => call.sql.startsWith("SELECT sv.id,sv.source_id"));
    const byteReads = f.calls.flatMap((call, index) => call.sql.includes('FROM "evidence_canonical"."blobs" blob') ? [index] : []);
    expect(byteReads).toHaveLength(2); expect(byteReads.every(index => index > authorization)).toBe(true);
    expect(f.calls[authorization]!.params[0]).toEqual(["a", "b"]);
    expect(f.calls[authorization]!.sql).toContain("sv.information_label");
    expect(f.calls[0]!.sql).toContain("evidence.information_label");
  });

  it("returns no bytes or evidence when the owning source version is inaccessible", async () => {
    const f = fixture(); f.allowed.clear();
    expect(await f.adapter.evidence.getEvidence(f.spans[0]!.id)).toBeNull();
    expect(f.calls.some(call => call.sql.includes('FROM "evidence_canonical"."blobs" blob'))).toBe(false);
  });

  it("hydrates single and opening-evidence readers through the same exact path", async () => {
    const f = fixture();
    expect((await f.adapter.evidence.getEvidence(f.spans[0]!.id))?.text).toBe(f.spans[0]!.text);
    const opening = await f.adapter.evidence.openingEvidenceForSourceVersions!(["a", "b"] as EvidenceSpan["sourceVersionId"][]);
    expect(opening.map(span => span.text)).toEqual([f.spans[1]!.text, f.spans[2]!.text]);
  });

  it.each([
    {features: ["anchor:sym:雪山大海"], reason: "anchor-posting BM25"},
    {features: ["sym:雪山大海"], reason: "GIN feature-hit"},
    {sourceVersionId: "a" as EvidenceSpan["sourceVersionId"], reason: "feature/source bounded"}
  ])("hydrates the $reason search branch without changing ranking or scores", async ({reason, ...query}) => {
    const f = fixture(), result = await f.adapter.evidence.searchEvidence({...query, status: "any", limit: 3});
    expect(result.map(item => item.span.id)).toEqual(f.spans.map(span => span.id));
    expect(result.map(item => item.span.text)).toEqual(f.spans.map(span => span.text));
    expect(result.every(item => item.score === 0.5 && item.reason.includes(reason))).toBe(true);
  });

  it("hydrates visual results while retaining the original visual score and regions", async () => {
    const f = fixture(), result = await f.adapter.evidence.searchEvidenceByVisual!({embedding: Array(512).fill(0), limit: 3});
    expect(result.map(item => item.span.text)).toEqual(f.spans.map(span => span.text));
    expect(result.every(item => item.score === 0.875)).toBe(true);
    expect(result[0]!.regions).toEqual([[0, 0, 1, 1]]);
  });

  it.each(["content identity", "offset", "source identity"])("fails closed on a corrupted stored %s", async mutation => {
    const f = fixture();
    if (mutation === "content identity") f.rows[0]!.content_hash = "sha256_bad" as ContentHash;
    if (mutation === "offset") { f.rows[0]!.byte_start = String(Number(f.rows[0]!.byte_start) + 1); f.rows[0]!.byte_end = String(Number(f.rows[0]!.byte_end) + 1); }
    if (mutation === "source identity") f.owners.get("a")!.source_id = "source.foreign";
    await expect(f.adapter.evidence.getEvidence(f.spans[0]!.id)).rejects.toThrow(/canonical evidence/u);
  });

  it("returns an empty batch without source/blob queries", async () => {
    const f = fixture(); expect(await f.adapter.evidence.getEvidenceBatch([])).toEqual([]); expect(f.calls).toEqual([]);
  });
});
