// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });

function fixture(rows: Array<{ symbol: string | null; contexts: string | null; model_count: number }>) {
  const adapter = createPostgresStorageAdapter({
    url: "postgres://fixture:fixture@127.0.0.1/fixture",
    schema: "fixture",
    informationAccess: {
      tenantId: "tenant.fixture", principalId: "principal.fixture",
      compartments: ["scope.fixture"], maximumExportClass: "restricted"
    }
  });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    return rows as T[];
  };
  return { adapter, calls };
}

describe("language continuation population projection", () => {
  it("returns complete symbol counts with both model and profile access scopes", async () => {
    const { adapter, calls } = fixture([
      { symbol: "which", contexts: "900", model_count: 3 },
      { symbol: "어느", contexts: "450", model_count: 3 },
      { symbol: "zero", contexts: "0", model_count: 3 },
      { symbol: "__proto__", contexts: "12", model_count: 3 }
    ]);
    const population = await adapter.languageMemory.continuationPopulation!({ languageId: "language.fixture" });
    expect(population?.modelCount).toBe(3);
    expect(population?.languageId).toBe("language.fixture");
    expect(Object.entries(population!.continuationCounts)).toEqual([
      ["which", 900], ["어느", 450], ["zero", 0], ["__proto__", 12]
    ]);
    expect(calls).toHaveLength(1);
    const { sql, params } = calls[0]!;
    expect(sql).toContain("lp.language_id=$1");
    expect(sql).toContain("lp.information_label->>'tenantId' = $2");
    expect(sql).toContain("model.information_label->>'tenantId' = $6");
    expect(params[0]).toBe("language.fixture");
    expect(params[1]).toBe("tenant.fixture");
    expect(params[5]).toBe("tenant.fixture");
    expect(sql).toContain("jsonb_each_text");
    expect(sql).not.toMatch(/\bLIMIT\b/iu);
    expect(sql).not.toContain("SELECT model.*");
  });

  it("does not report an absent population as learned data", async () => {
    const { adapter } = fixture([{ symbol: null, contexts: null, model_count: 0 }]);
    expect(await adapter.languageMemory.continuationPopulation!({ languageId: "language.absent" })).toBeUndefined();
  });

  it("does not query without a learned language identity", async () => {
    const { adapter, calls } = fixture([]);
    expect(await adapter.languageMemory.continuationPopulation!({ languageId: " " })).toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("rejects an invalid count instead of publishing a usable prior", async () => {
    const { adapter } = fixture([{ symbol: "which", contexts: "NaN", model_count: 1 }]);
    await expect(adapter.languageMemory.continuationPopulation!({ languageId: "language.fixture" }))
      .rejects.toThrow("invalid corpus continuation count");
  });
});
