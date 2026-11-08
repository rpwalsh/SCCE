// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA as schema, SOURCE_COMPUTATION_CONSTRUCTION_RECIPE as recipe,
  SOURCE_COMPUTATION_SOURCE_SYSTEM as sourceSystem, type LanguagePatternProjection, type LanguagePatternRecord } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const label = { tenantId: "tenant.owned", principals: ["principal.owned"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
function fixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "fixture", informationAccess: {
    tenantId: label.tenantId, principalId: label.principals[0]!, compartments: [], maximumExportClass: "restricted"
  } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params }); return sql.includes("SELECT TRUE AS source_owner_valid") ? [{ source_owner_valid: true }] as T[] : [];
  };
  adapter.transaction = async operation => operation();
  const projection: LanguagePatternProjection = { profileId: "profile.owned", sourceId: "source.owned" as never, sourceVersionId: "version.owned" as never,
    sourceSystem, patternSchema: schema, componentRecipe: recipe, patternIds: ["computation.owned"], informationLabel: label,
    sourceDependencies: [{ sourceId: "source.owned" as never, sourceVersionId: "version.owned" as never, evidenceIds: ["evidence.owned" as never] },
      { sourceId: "source.support" as never, sourceVersionId: "version.support" as never, evidenceIds: ["evidence.support" as never] }] };
  const pattern: LanguagePatternRecord = { id: projection.patternIds[0]!, profileId: projection.profileId, patternKind: "semantic_role", support: 1,
    entropy: 0, evidenceIds: ["evidence.owned" as never, "evidence.support" as never], updatedAt: 1, informationLabel: label,
    patternJson: { schema, componentRecipe: recipe, sourceSystem, profileId: projection.profileId, sourceId: projection.sourceId, sourceVersionId: projection.sourceVersionId } };
  return { adapter, calls, projection, pattern };
}

it("publishes exact computation ownership and dependency snapshots separately without deleting history", async () => {
  const { adapter, calls, projection, pattern } = fixture();
  await adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] });
  const write = calls.find(call => call.sql.includes("AS metadata(key,value_json,updated_at)"))!;
  expect(write.params[0]).toContain('"source-owned"');
  expect(write.params[0]).toContain(recipe);
  expect(JSON.parse(String(write.params[1])).sourceDependencies).toEqual(projection.sourceDependencies);
  expect(write.sql).toContain("previous_version.source_id=incoming_version.source_id");
  expect(write.sql).toContain("previous_version.observed_at,previous_version.id");
  const owner = calls.find(call => call.sql.includes("SELECT TRUE AS source_owner_valid"))!;
  expect(owner.params.slice(0, 3)).toEqual([projection.profileId, projection.sourceVersionId, projection.sourceId]);
  expect(owner.sql).toContain("owner_profile.information_label->>'tenantId'");
  expect(owner.sql).toContain("owner_version.information_label->>'tenantId'");
  expect(calls.findIndex(call => call.sql.includes('INSERT INTO "fixture"."language_patterns"'))).toBeGreaterThan(calls.indexOf(owner));
  calls.length = 0;
  await adapter.languageMemory.replaceLanguagePatternProjection!({ projection: { ...projection, patternIds: [], sourceDependencies: [] }, patterns: [] });
  expect(JSON.parse(String(calls.at(-1)!.params[1])).patternIds).toEqual([]);
  expect(calls.some(call => call.sql.includes("DELETE FROM"))).toBe(false);
});

it.each(["profile", "jsonProfile", "source", "version", "namespace", "kind", "recipe", "schema", "emptyEvidence", "foreignEvidence", "projectionRecipe", "projectionNamespace"])("rejects a computation %s mismatch before any storage access", async damage => {
  const { adapter, calls, projection, pattern } = fixture();
  const metadata = pattern.patternJson as Record<string, unknown>;
  if (damage === "profile") pattern.profileId = "foreign";
  if (damage === "jsonProfile") metadata.profileId = "foreign";
  if (damage === "source") metadata.sourceId = "foreign";
  if (damage === "version") metadata.sourceVersionId = "foreign";
  if (damage === "namespace") metadata.sourceSystem = "foreign";
  if (damage === "kind") pattern.patternKind = "discourse";
  if (damage === "recipe") metadata.componentRecipe = "foreign";
  if (damage === "schema") metadata.schema = "foreign";
  if (damage === "emptyEvidence") pattern.evidenceIds = [];
  if (damage === "foreignEvidence") pattern.evidenceIds = ["foreign" as never];
  if (damage === "projectionRecipe") projection.componentRecipe = "foreign";
  if (damage === "projectionNamespace") projection.sourceSystem = "foreign";
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] })).rejects.toThrow();
  expect(calls).toEqual([]);
});

it.each([undefined, [], [{ sourceId: "foreign", sourceVersionId: "foreign", evidenceIds: ["evidence.owned", "evidence.support"] }],
  [{ sourceId: "source.owned", sourceVersionId: "version.owned", evidenceIds: [] }]])("rejects incomplete computation source dependencies %j", async dependencies => {
  const { adapter, calls, projection, pattern } = fixture();
  projection.sourceDependencies = dependencies as never;
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] })).rejects.toThrow();
  expect(calls).toEqual([]);
});

it("rejects inaccessible computation owners before writing any pattern", async () => {
  const { adapter, calls, projection, pattern } = fixture();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] })).rejects.toThrow("accessible source profile/version");
  expect(calls).toHaveLength(1);
});

it("requires a complete current accessible promoted dependency set before computation budgets and exact row membership", async () => {
  const { adapter, calls } = fixture();
  await adapter.languageMemory.listLanguagePatterns({ patternSchemas: [schema], sourceSystem, profileId: "profile.owned", maxTotalJsonBytes: 1024 });
  const query = calls.at(-1)!;
  expect(query.params).toContain(schema);
  expect(query.params).toContain(recipe);
  for (const marker of ["auxiliary_profile.id=active_projection.value_json->>'profileId'", "auxiliary_owner.source_id=active_projection.value_json->>'sourceId'",
    "sourceDependencies", "dependency_version.source_id=dependency.", "dependency_evidence.source_id=dependency_version.source_id",
    "dependency_evidence.status='promoted'", "newer_dependency_version.observed_at,newer_dependency_version.id",
    "newer_dependency_evidence.status='promoted'", "auxiliary_profile.information_label->>'tenantId'",
    "dependency_version.information_label->>'tenantId'", "dependency_evidence.information_label->>'tenantId'",
    "newer_dependency_version.information_label->>'tenantId'", "WHERE dependency_evidence.id IS NULL"]) expect(query.sql).toContain(marker);
  expect(query.sql).toContain("pattern.id,pattern.component_recipe,pattern.owned_source_version_id");
  expect(query.sql).toContain("SELECT profile_id,source_system,pattern_schema,pattern_id,projection_recipe,source_version_id FROM active_projection_ids_0");
  expect(query.sql).not.toContain("headers published");
  expect(query.sql.indexOf("WHERE dependency_evidence.id IS NULL")).toBeLessThan(query.sql.indexOf("ranked_pool AS"));
  expect(query.sql).toContain("pattern.pattern_kind='semantic_role'");
  expect(query.sql).toContain("computation_member.evidence_ids <@ header.dependency_evidence_ids");
  expect(query.sql).toContain("computation_member.owned_source_version_id=header.source_version_id");
});

it("does not treat a missing exact computation header as a completed projection", async () => {
  const { adapter, calls, projection } = fixture();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params }); return sql.includes("SELECT value_json FROM")
      ? [{ value_json: { ...projection, schema: "scce.language_pattern_active_projection.v1" } }] as T[] : [];
  };
  expect(await adapter.languageMemory.getLanguagePatternProjection!(projection)).toBeUndefined();
  expect(calls).toHaveLength(2);
  expect(calls[0]!.sql).toContain("dependency_evidence.status='promoted'");
  expect(calls[1]!.sql).toContain("pattern.id=ANY($1::text[])");
  expect(calls[1]!.sql).toContain("pattern.evidence_ids <@ $7::text[]");
  expect(calls[1]!.params[6]).toEqual(["evidence.owned", "evidence.support"]);
  expect(calls[1]!.params.slice(0, 6)).toEqual([projection.patternIds, projection.profileId, projection.sourceVersionId, sourceSystem, schema, recipe]);
});

it("reads only an exact accessible computation receipt and its full owned header inventory", async () => {
  const { adapter, calls, projection } = fixture();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params }); return sql.includes("SELECT value_json FROM")
      ? [{ value_json: { ...projection, schema: "scce.language_pattern_active_projection.v1" } }] as T[]
      : sql.includes("SELECT pattern.id") ? projection.patternIds.map(id => ({ id })) as T[] : [];
  };
  expect(await adapter.languageMemory.getLanguagePatternProjection!(projection)).toEqual(projection);
  expect(calls[0]!.sql).toContain("active_projection.information_label->>'tenantId'");
  expect(calls[0]!.sql).toContain("newer_dependency_evidence.status='promoted'");
  calls.length = 0;
  expect(await adapter.languageMemory.getLanguagePatternProjection!({ ...projection, componentRecipe: "foreign" })).toBeUndefined();
  expect(await adapter.languageMemory.getLanguagePatternProjection!({ ...projection, sourceSystem: "foreign" })).toBeUndefined();
  expect(calls).toEqual([]);
});

it("excludes computation rows in a foreign namespace without loading an auxiliary header catalog", async () => {
  const { adapter, calls } = fixture();
  await adapter.languageMemory.listLanguagePatterns({ patternSchemas: [schema], sourceSystem: "foreign" });
  const query = calls.at(-1)!;
  const schemaParameter = query.params.lastIndexOf(schema) + 1;
  expect(schemaParameter).toBeGreaterThan(0);
  expect(query.sql).toContain(`WHERE (NOT (pattern.has_source_compilation)`);
  expect(query.sql).toContain(`AND pattern.pattern_schema IS DISTINCT FROM $${schemaParameter}`);
  expect(query.sql).not.toContain("sourceDependencies");
});
