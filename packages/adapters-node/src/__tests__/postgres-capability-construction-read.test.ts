// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { capabilityBindingForRequest, CAPABILITY_CONSTRUCTION_SCHEMA, type ScceStorage } from "@scce/kernel";
import { SOURCE_CONSTRUCTION_READ_BUDGET } from "../../../kernel/src/request-language-hydration.js";
import { PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });

describe("ordinary capability discovery through the canonical PostgreSQL read contract", () => {
  it("returns no action for an empty owned capability schema with a complete bounded read", async () => {
    const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "capability_read", informationAccess: {
      tenantId: "tenant.owned", principalId: "principal.owned", compartments: [], maximumExportClass: "restricted"
    } });
    adapters.push(adapter);
    const calls: Array<{ sql: string; params: unknown[] }> = [];
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
    const storage = { languageMemory: adapter.languageMemory } as ScceStorage;
    await expect(capabilityBindingForRequest({ storage, requestText: "Who composed Swan Lake?" })).resolves.toBeUndefined();
    const selected = calls.find(call => call.sql.includes("pattern_headers AS MATERIALIZED"))!;
    expect(selected).toBeDefined();
    expect(selected.params).toContainEqual([CAPABILITY_CONSTRUCTION_SCHEMA]);
    expect(selected.params).toContain(SOURCE_CONSTRUCTION_READ_BUDGET.limit);
    expect(selected.params).toContain(SOURCE_CONSTRUCTION_READ_BUDGET.maxTotalJsonBytes);
    expect(selected.sql).toContain("complete_read AS MATERIALIZED");
    expect(selected.sql).toContain("(SELECT COUNT(*) FROM candidate_pool)=(SELECT COUNT(*) FROM complete_read)");
    expect(selected.sql).toContain("pattern.information_label->>'tenantId'");
    await expect(adapter.languageMemory.listLanguagePatterns({ patternSchemas: [CAPABILITY_CONSTRUCTION_SCHEMA], requireComplete: true })).rejects.toThrow(/positive finite row and decoded byte bounds/);
  });
});
