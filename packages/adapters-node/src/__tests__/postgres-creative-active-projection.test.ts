// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID, type LanguagePatternRecord, type LanguagePatternProjection } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });

function fixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "offline_creative", informationAccess: {
    tenantId: "tenant.owned", principalId: "principal.owned", compartments: [], maximumExportClass: "restricted"
  } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
  adapter.transaction = async operation => operation();
  const informationLabel = { tenantId: "tenant.owned", principals: ["principal.owned"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
  const pattern: LanguagePatternRecord = { id: "compatibility.current", profileId: "profile.owned", patternKind: "semantic_role", support: 1, entropy: 0,
    patternJson: { schema: CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, sourceId: "source.owned", sourceVersionId: "version.owned", sourceSystem: "dialogue" }, evidenceIds: [], updatedAt: 1000, informationLabel };
  const projection: LanguagePatternProjection = { profileId: pattern.profileId, sourceId: "source.owned" as never, sourceVersionId: "version.owned" as never,
    sourceSystem: "dialogue", patternSchema: CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA, componentRecipe: CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID,
    patternIds: [pattern.id], informationLabel };
  return { adapter, calls, pattern, projection };
}

describe("source-owned creative compatibility publication", () => {
  it("publishes exact models and an empty current set without deleting history", async () => {
    expect(typeof CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID).toBe("string");
    const { adapter, calls, pattern, projection } = fixture();
    await adapter.languageMemory.replaceLanguagePatternProjection?.({ patterns: [pattern], projection });
    const insert = calls.findIndex(call => call.sql.includes('INSERT INTO "offline_creative"."language_patterns"'));
    const receipt = calls.findIndex(call => call.sql.includes('INSERT INTO "offline_creative"."storage_meta"'));
    expect(insert).toBeGreaterThanOrEqual(0);
    expect(receipt).toBeGreaterThan(insert);
    expect(calls[receipt]!.params[1]).toContain(pattern.id);
    await adapter.languageMemory.replaceLanguagePatternProjection?.({ patterns: [], projection: { ...projection, patternIds: [] } });
    expect(calls.at(-1)!.params[1]).toContain('"patternIds":[]');
    expect(calls.some(call => call.sql.includes("DELETE FROM"))).toBe(false);
  });

  it.each(["profile", "system", "source", "version", "schema", "kind"])("rejects a foreign %s before writing any row", async field => {
    const { adapter, calls, pattern, projection } = fixture();
    const changed = { ...pattern, patternJson: { ...(pattern.patternJson as Record<string, unknown>) } };
    if (field === "profile") changed.profileId = "profile.foreign";
    if (field === "kind") changed.patternKind = "syntax";
    Object.assign(changed.patternJson, field === "system" ? { sourceSystem: "foreign" } : field === "source" ? { sourceId: "source.foreign" }
      : field === "version" ? { sourceVersionId: "version.foreign" } : field === "schema" ? { schema: "foreign.schema" } : {});
    await expect(adapter.languageMemory.replaceLanguagePatternProjection?.({ patterns: [changed as LanguagePatternRecord], projection })).rejects.toThrow("rows in the replacement batch");
    expect(calls).toHaveLength(0);
  });

  it("filters only after an accessible exact source/profile/schema publication and before budgets", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ patternSchemas: [CREATIVE_EVENT_COMPATIBILITY_MODEL_SCHEMA], profileId: "profile.owned", sourceSystem: "dialogue", maxTotalJsonBytes: 1024 });
    const query = calls.at(-1)!;
    expect(query.params).toContain(CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID);
    for (const predicate of ["projection_profile.id=active_projection.value_json->>'profileId'", "projection_profile.source_version_id=active_projection.value_json->>'sourceVersionId'",
      "projection_version.source_id=active_projection.value_json->>'sourceId'", "published.profile_id=pattern.profile_id", "published.source_system=pattern.source_system", "published.pattern_schema=pattern.pattern_schema"])
      expect(query.sql).toContain(predicate);
    expect(query.sql).toContain("OR NOT EXISTS (");
    expect(query.sql).toContain("SELECT profile_id,source_system,pattern_schema,pattern_id FROM active_projection_ids_0");
    expect(query.sql.indexOf("FROM active_projection_ids_0_headers published")).toBeLessThan(query.sql.indexOf("ranked_pool AS"));
    expect(query.sql.indexOf("FROM active_projection_ids_0_headers published")).toBeLessThan(query.sql.indexOf("running_json_bytes"));
    expect(query.sql).toContain("active_projection.information_label->>'tenantId'");
  });
});
