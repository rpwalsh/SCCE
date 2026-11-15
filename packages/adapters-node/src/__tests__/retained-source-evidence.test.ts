// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createClock, createHasher, createIdFactory, type EvidenceSpan, type InformationLabel } from "@scce/kernel";
import { resolveRetainedSourceEvidence } from "../retained-source-evidence.js";
import { schemaStatements } from "../postgres-schema.js";

const ids = createIdFactory({ clock: createClock(), hasher: createHasher() }), label: InformationLabel = {
  tenantId: "retained.tests", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" };
const version = ids.sourceVersionId("raw"), source = ids.sourceId("test", "fixture://raw"), contentHash = ids.contentHash("text");
const span = (index: number) => ({ id: ids.evidenceId({ sourceVersionId: version, byteStart: index * 4, byteEnd: index * 4 + 4, spanHash: contentHash }),
  byteStart: index * 4, byteEnd: index * 4 + 4, contentHash });
const row = (value: ReturnType<typeof span>, alias = value.id) => ({ id: alias, chunk_id: "chunk", source_id: source, source_version_id: version,
  content_hash: contentHash, media_type: "text/plain", byte_start: String(value.byteStart), byte_end: String(value.byteEnd), char_start: String(value.byteStart),
  char_end: String(value.byteEnd), status: "promoted", alpha: "1", observed_at: new Date(1), information_label: label });

it("uses bounded header-only ID reads and resolves only missing IDs through exact retained source ranges", async () => {
  const requested = Array.from({ length: 2050 }, (_, index) => span(index)), calls: Array<{ sql: string; params: unknown[] }> = [];
  const missing = requested[2049]!, alias = `${missing.id}.existing` as EvidenceSpan["id"];
  const found = await resolveRetainedSourceEvidence({ table: name => `"fixture"."${name}"`,
    informationAccessPredicate: (name, start) => ({ sql: `${name}.information_label->>'tenantId'=$${start}`, params: [label.tenantId] }),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      if (sql.includes("jsonb_to_recordset")) {
        expect(params[1]).toBe(version);
        expect(JSON.parse(String(params[0]))).toEqual([{ ordinal: 0, byte_start: missing.byteStart, byte_end: missing.byteEnd, content_hash: contentHash }]);
        return [row(missing, alias)] as T[];
      }
      return requested.filter(value => value.id !== missing.id && (params[0] as string[]).includes(value.id)).map(value => row(value)) as T[];
    }
  }, { sourceVersionId: version, spans: requested });
  expect(found).toHaveLength(requested.length);
  expect(found.find(value => value.byteStart === missing.byteStart)?.id).toBe(alias);
  expect(calls.filter(call => !call.sql.includes("jsonb_to_recordset")).map(call => (call.params[0] as string[]).length)).toEqual([2048, 2]);
  expect(calls.filter(call => call.sql.includes("jsonb_to_recordset"))).toHaveLength(1);
  for (const call of calls) {
    expect(call.sql).toContain("version.source_id=evidence.source_id");
    expect(call.sql).toContain("version.information_label");
    expect(call.sql).toContain("evidence.information_label");
    expect(call.sql).not.toMatch(/SELECT \*|text_preview|features|provenance_json|language_hints|script_hints|trust_vector/u);
  }
  const rangeSql = calls.find(call => call.sql.includes("jsonb_to_recordset"))!;
  expect(rangeSql.sql).toContain("retained_source_headers AS MATERIALIZED");
  expect(rangeSql.sql).toContain("evidence.byte_start=ANY($3::bigint[])");
  expect(rangeSql.params[2]).toEqual([missing.byteStart]);
});

it("declares the exact retained-source range index in canonical initialization", () => {
  const statements = schemaStatements('"retained"').filter(sql => sql.includes("evidence_exact_source_range"));
  expect(statements).toEqual(['CREATE INDEX IF NOT EXISTS idx_retained_evidence_exact_source_range ON "retained".evidence_spans(source_version_id,byte_start,byte_end,content_hash)']);
});

it("does not turn absence into an invented evidence reference and rejects foreign range results", async () => {
  const wanted = span(0), host = { table: (name: string) => name, informationAccessPredicate: () => ({ sql: "TRUE", params: [] as unknown[] }),
    query: async <T>(): Promise<T[]> => [] };
  expect(await resolveRetainedSourceEvidence(host, { sourceVersionId: version, spans: [wanted] })).toEqual([]);
  await expect(resolveRetainedSourceEvidence({ ...host, query: async <T>(sql: string): Promise<T[]> => sql.includes("jsonb_to_recordset")
    ? [{ ...row(wanted), byte_end: "5" }] as T[] : [] }, { sourceVersionId: version, spans: [wanted] })).rejects.toThrow("foreign range");
});
