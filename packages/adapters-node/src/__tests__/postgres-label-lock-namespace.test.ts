// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { joinDurableRecordLabels } from "../postgres.js";

// Measured: advisory lock keys are database-wide, so hashing only the record id into 256 buckets made every
// schema and every labeled table share one lock space. A profiling ingest into scce_prof deadlocked the live
// ingest into scce4_runtime, killing a corpus build. The bucket order was not deterministic either: the
// ORDER BY sat in the outer query, where Postgres evaluates the lock function per unordered row first.

function fakeStorage(schema: string) {
  const statements: Array<{ sql: string; params: readonly unknown[] }> = [];
  const label = { tenantId: "t", principals: ["principal.fixture"], compartments: [], exportClass: "internal", mergePolicy: "isolated" };
  const storage = {
    statements,
    table: (name: string) => `"${schema}"."${name}"`,
    requireInformationAccess: () => ({ explicitMergeAuthority: true }),
    requireWritableInformationLabel: () => label,
    query: async (sql: string, params: readonly unknown[] = []) => {
      statements.push({ sql, params });
      return [];
    }
  };
  return storage as unknown as Parameters<typeof joinDurableRecordLabels>[0] & { statements: typeof statements };
}

async function lockStatementFor(schema: string, table: string) {
  const storage = fakeStorage(schema);
  await joinDurableRecordLabels(storage, table as never, [{ id: "record-b" }, { id: "record-a" }]);
  const lock = storage.statements.find(statement => statement.sql.includes("pg_advisory_xact_lock"));
  expect(lock).toBeDefined();
  return lock!;
}

describe("the durable-label advisory lock names what it protects", () => {
  it("namespaces the lock by qualified table, so two schemas do not share one bucket space", async () => {
    const one = await lockStatementFor("scce4_runtime", "evidence_spans");
    const other = await lockStatementFor("scce_prof", "evidence_spans");
    expect(one.sql).toContain("pg_advisory_xact_lock(namespace.key, buckets.bucket)");
    expect(one.params[1]).toBe(`"scce4_runtime"."evidence_spans"`);
    expect(other.params[1]).toBe(`"scce_prof"."evidence_spans"`);
    expect(one.params[1]).not.toBe(other.params[1]);
  });

  it("namespaces the lock by table too, so unrelated tables in one schema do not contend", async () => {
    const spans = await lockStatementFor("scce4_runtime", "evidence_spans");
    const models = await lockStatementFor("scce4_runtime", "ngram_models");
    expect(spans.params[1]).not.toBe(models.params[1]);
  });

  it("orders buckets inside the subquery, where the ordering actually governs acquisition", async () => {
    const lock = await lockStatementFor("scce4_runtime", "evidence_spans");
    const orderIndex = lock.sql.indexOf("ORDER BY bucket");
    const closingIndex = lock.sql.indexOf(") buckets");
    expect(orderIndex).toBeGreaterThan(-1);
    expect(closingIndex).toBeGreaterThan(-1);
    expect(orderIndex).toBeLessThan(closingIndex);
  });

  it("still locks every distinct bucket for the records it was given", async () => {
    const lock = await lockStatementFor("scce4_runtime", "evidence_spans");
    expect(lock.sql).toContain("SELECT DISTINCT");
    expect(lock.sql).toContain("& 255");
    expect(lock.params[0]).toEqual(["record-a", "record-b"]);
  });
});
