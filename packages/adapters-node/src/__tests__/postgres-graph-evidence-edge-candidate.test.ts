// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import type { EvidenceId } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });

function fixture() {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture",
    informationAccess: { tenantId: "tenant.fixture", principalId: "principal.fixture", compartments: ["owned"], maximumExportClass: "internal" } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
  return { adapter, calls };
}

it("uses exact evidence membership while retaining access-before-limit and the public edge evidence order", async () => {
  const { adapter, calls } = fixture();
  await adapter.graph.getSlice({ evidenceBoundOnly: true, evidenceIds: ["evidence.α", "evidence.β"] as EvidenceId[], limitNodes: 16, limitEdges: 32 });
  const query = calls.find(row => row.sql.includes("WITH requested_edges AS MATERIALIZED"));
  expect(query).toBeDefined();
  expect(query!.params).toEqual([["evidence.α", "evidence.β"], 32, "tenant.fixture", ["public", "internal"], "principal.fixture", '["owned"]']);
  expect(query!.sql).toContain("SELECT DISTINCT association.entity_id");
  expect(query!.sql).toContain("association.entity_kind='edge' AND association.evidence_id=ANY($1::text[])");
  expect(query!.sql).toContain('SELECT * FROM "fixture"."graph_edges" WHERE id=requested.entity_id OFFSET 0');
  const parent = query!.sql.indexOf(") AS edge_row"), access = query!.sql.indexOf("edge_row.information_label", parent), limit = query!.sql.indexOf("LIMIT $2");
  expect(parent).toBeGreaterThan(0); expect(access).toBeGreaterThan(parent); expect(limit).toBeGreaterThan(access);
  expect(query!.sql).toContain("ORDER BY alpha DESC, updated_at DESC, id LIMIT $2");
  expect(query!.sql).toContain("NOT association.evidence_id=ANY(edge_row.evidence_ids)");
  expect(query!.sql).toContain("ORDER BY ordered.lane,ordered.first_seen");
});

it("deduplicates requested evidence before grouping and preserves the existing per-group edge limit", async () => {
  const { adapter, calls } = fixture();
  const ids = Array.from({ length: 65 }, (_, index) => `evidence.${index}` as EvidenceId);
  await adapter.graph.getSlice({ evidenceBoundOnly: true, evidenceIds: [...ids, ids[0]!], limitNodes: 16, limitEdges: 7 });
  const queries = calls.filter(row => row.sql.includes("WITH requested_edges AS MATERIALIZED"));
  expect(queries.map(row => (row.params[0] as string[]).length)).toEqual([32, 32, 1]);
  expect(queries.flatMap(row => row.params[0] as string[])).toEqual(ids);
  expect(queries.every(row => row.params[1] === 7)).toBe(true);
});

it("leaves a generic graph selection on its existing node-first branch", async () => {
  const { adapter, calls } = fixture();
  await adapter.graph.getSlice({ allowLatestFallback: true, limitNodes: 16, limitEdges: 32 });
  expect(calls).toHaveLength(1);
  expect(calls[0]!.sql).toContain('FROM "fixture"."graph_nodes"');
  expect(calls[0]!.sql).not.toContain("requested_edges");
});
