// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import {
  POSTGRES_REQUIRED_TABLES,
  type ContentHash,
  type EvidenceId,
  type EvidenceSpan,
  type SourceId,
  type SourceVersionId
} from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";
import { requiredHydrationColumns, schemaStatements } from "../postgres-schema.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

function fixture(): PostgresStorageAdapter {
  const adapter = new PostgresStorageAdapter({
    url: "postgres://offline.invalid/none",
    schema: "feature_normalization",
    informationAccess: {
      tenantId: "fixture",
      principalId: "owner",
      compartments: ["test"],
      maximumExportClass: "restricted"
    }
  });
  adapters.push(adapter);
  return adapter;
}

function evidence(): EvidenceSpan {
  return {
    id: "evidence.feature-normalization" as EvidenceId,
    sourceId: "source.feature-normalization" as SourceId,
    sourceVersionId: "source-version.feature-normalization" as SourceVersionId,
    chunkId: "chunk.feature-normalization" as EvidenceSpan["chunkId"],
    contentHash: "sha256_feature-normalization" as ContentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: 10,
    charStart: 0,
    charEnd: 10,
    textPreview: "alpha beta",
    text: "alpha beta",
    languageHints: {},
    scriptHints: {},
    trustVector: {} as EvidenceSpan["trustVector"],
    provenance: {},
    features: ["anchor:sym:alpha", "anchor:bi:alpha|beta", "sym:beta"],
    status: "promoted",
    alpha: 1,
    observedAt: 1,
    informationLabel: {
      tenantId: "fixture",
      principals: ["owner"],
      compartments: ["test"],
      exportClass: "restricted",
      mergePolicy: "isolated"
    }
  };
}

describe("canonical evidence feature storage", () => {
  it("keeps one feature array and one GIN while losslessly retiring the derived anchor relation", () => {
    const sql = schemaStatements('"feature_normalization"');
    expect(sql).toContain('DROP TABLE IF EXISTS "feature_normalization".evidence_anchor_index');
    expect(sql.some(statement => /CREATE TABLE.*evidence_anchor_index/u.test(statement))).toBe(false);
    expect(sql.some(statement => /CREATE INDEX.*evidence_anchor/u.test(statement))).toBe(false);
    expect(sql.filter(statement => /evidence_spans USING GIN\(features\)/u.test(statement))).toHaveLength(1);
    expect(POSTGRES_REQUIRED_TABLES).not.toContain("evidence_anchor_index");
    expect(requiredHydrationColumns()).not.toHaveProperty("evidence_anchor_index");
  });

  it("writes the complete logical feature set only to evidence_spans", async () => {
    const adapter = fixture();
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    Object.defineProperty(adapter, "transaction", { value: async <T>(operation: () => Promise<T>) => operation() });
    Object.defineProperty(adapter, "query", { value: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return [];
    }});

    const span = evidence();
    await adapter.evidence.putEvidenceSpan(span);

    const write = calls.find(call => call.sql.includes("INSERT INTO") && call.sql.includes("evidence_spans"));
    expect(write).toBeDefined();
    expect(write!.sql).not.toContain("evidence_anchor_index");
    const payload = JSON.parse(String(write!.params[0])) as Array<{ features_json: string[] }>;
    expect(payload[0]?.features_json).toEqual(span.features);
    expect(calls.some(call => call.sql.includes("evidence_anchor_index"))).toBe(false);
  });

  it("serves anchor posting retrieval from the canonical evidence GIN without changing access filtering", async () => {
    const adapter = fixture();
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    Object.defineProperty(adapter, "transaction", { value: async <T>(operation: () => Promise<T>) => operation() });
    Object.defineProperty(adapter, "query", { value: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      if (/current_setting\('enable_seqscan'\)/u.test(sql)) return [{ enabled: "on" }];
      return [];
    }});

    await adapter.evidence.searchEvidence({ features: ["anchor:sym:alpha"], status: "promoted", limit: 10 });

    const read = calls.find(call => call.sql.includes("feature_postings AS"));
    expect(read).toBeDefined();
    expect(read!.sql).not.toContain("evidence_anchor_index");
    expect(read!.sql).toContain('FROM "feature_normalization"."evidence_spans" probe');
    expect(read!.sql).toContain("feature_evidence.features @> ARRAY[postings.feature]::text[]");
    expect(read!.sql).toContain("evidence.information_label");
  });
});
