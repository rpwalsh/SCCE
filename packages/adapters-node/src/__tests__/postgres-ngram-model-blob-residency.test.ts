// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import type { InformationLabel } from "@scce/kernel";
import { clearResidentNgramModelJson, createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const informationAccess = {
  tenantId: "tenant.fixture",
  principalId: "principal.fixture",
  compartments: [],
  maximumExportClass: "restricted" as const,
  explicitMergeAuthority: true
};
const label: InformationLabel = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "internal", mergePolicy: "isolated" };

interface Row { id: string; updated_at: Date; stored_bytes: number; json_bytes: number; model_json: Record<string, unknown> }

function row(id: string, mass: number, bytes: number, updatedAtMs = 1_000): Row {
  return {
    id,
    updated_at: new Date(updatedAtMs),
    stored_bytes: bytes,
    json_bytes: bytes,
    model_json: { sourceSystem: "wikipedia", profileId: `profile.${id}`, model: { order: 2, totalUnigramCount: mass } }
  };
}

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => {
  clearResidentNgramModelJson();
  for (const adapter of adapters.splice(0)) await adapter.close();
});

function fixture(rows: Row[]) {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture", informationAccess });
  adapters.push(adapter);
  const candidateSql: string[] = [];
  const blobSql: string[] = [];
  const blobIds: string[][] = [];
  const ordered = () => [...rows].sort((left, right) =>
    (right.model_json.model as { totalUnigramCount: number }).totalUnigramCount - (left.model_json.model as { totalUnigramCount: number }).totalUnigramCount
    || right.updated_at.getTime() - left.updated_at.getTime()
    || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    if (sql.includes("pg_column_size(model.model_json) AS stored_bytes")) {
      candidateSql.push(sql);
      const limit = Number(params[params.length - 1]);
      return ordered().slice(0, limit).map(item => ({
        id: item.id,
        stream_id: "stream.fixture",
        language_hint: "hint.fixture",
        max_order: 2,
        discount: "0.75",
        updated_at: item.updated_at,
        information_label: label,
        stored_bytes: String(item.stored_bytes)
      })) as T[];
    }
    if (sql.includes("octet_length(model.model_json::text) AS json_bytes")) {
      blobSql.push(sql);
      const ids = params[0] as string[];
      blobIds.push([...ids]);
      return rows.filter(item => ids.includes(item.id))
        .map(item => ({ id: item.id, updated_at: item.updated_at, model_json: item.model_json, json_bytes: String(item.json_bytes) })) as T[];
    }
    throw new Error(`unexpected query: ${sql}`);
  };
  return { adapter, candidateSql, blobSql, blobIds };
}

const rows = () => [row("model.a", 900, 400), row("model.b", 500, 400), row("model.c", 100, 400)];

describe("n-gram model blob residency", () => {
  it("does not re-read a model_json blob this process already holds", async () => {
    const { adapter, candidateSql, blobSql, blobIds } = fixture(rows());
    const first = await adapter.languageMemory.listNgramModels({ sourceSystem: "wikipedia", limit: 12, maxTotalJsonBytes: 1_200 });
    expect(first.map(record => record.id)).toEqual(["model.a", "model.b", "model.c"]);
    expect(blobIds).toEqual([["model.a", "model.b", "model.c"]]);

    const second = await adapter.languageMemory.listNgramModels({ sourceSystem: "wikipedia", limit: 12, maxTotalJsonBytes: 1_200 });
    expect(second).toEqual(first);
    expect(second.map(record => record.modelJson)).toEqual(first.map(record => record.modelJson));
    // The ranking is still asked of PostgreSQL every time; only the blobs are not read again.
    expect(candidateSql).toHaveLength(2);
    expect(blobSql).toHaveLength(1);
  });

  it("reads the blob again when the row version moves under the same id", async () => {
    const source = rows();
    const { adapter, blobIds } = fixture(source);
    await adapter.languageMemory.listNgramModels({ sourceSystem: "wikipedia", limit: 12, maxTotalJsonBytes: 1_200 });
    source[1] = { ...source[1]!, updated_at: new Date(2_000), model_json: { ...source[1]!.model_json, model: { order: 2, totalUnigramCount: 500 } } };

    const reread = await adapter.languageMemory.listNgramModels({ sourceSystem: "wikipedia", limit: 12, maxTotalJsonBytes: 1_200 });
    expect(blobIds).toEqual([["model.a", "model.b", "model.c"], ["model.b"]]);
    expect(reread.find(record => record.id === "model.b")!.updatedAt).toBe(2_000);
  });

  it("applies the cumulative byte budget in relevance order, resident or not", async () => {
    const { adapter } = fixture(rows());
    const budgeted = await adapter.languageMemory.listNgramModels({ sourceSystem: "wikipedia", limit: 12, maxTotalJsonBytes: 800 });
    expect(budgeted.map(record => record.id)).toEqual(["model.a", "model.b"]);

    const again = await adapter.languageMemory.listNgramModels({ sourceSystem: "wikipedia", limit: 12, maxTotalJsonBytes: 800 });
    expect(again.map(record => record.id)).toEqual(["model.a", "model.b"]);
  });

  it("still returns the best record when the budget is smaller than it", async () => {
    const { adapter } = fixture(rows());
    const tiny = await adapter.languageMemory.listNgramModels({ sourceSystem: "wikipedia", limit: 12, maxTotalJsonBytes: 10 });
    expect(tiny.map(record => record.id)).toEqual(["model.a"]);
  });
});
