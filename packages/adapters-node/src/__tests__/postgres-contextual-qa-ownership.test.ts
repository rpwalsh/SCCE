// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { CONTEXTUAL_QA_CONSTRUCTION_RECIPE as recipe, CONTEXTUAL_QA_SOURCE_SYSTEM as sourceSystem,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA as schema, POSTGRES_SCHEMA_VERSION, requestSeedLanguagePattern,
  type LanguagePatternProjection, type LanguagePatternRecord } from "@scce/kernel";
import { PostgresStorageAdapter, schemaStatements } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const label = { tenantId: "tenant.owned", principals: ["principal.owned"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
function fixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "fixture", informationAccess: {
    tenantId: label.tenantId, principalId: label.principals[0]!, compartments: [], maximumExportClass: "restricted"
  } }); adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params }); return sql.includes("SELECT TRUE AS source_owner_valid") ? [{ source_owner_valid: true }] as T[] : [];
  };
  adapter.transaction = async operation => operation();
  const projection: LanguagePatternProjection = { profileId: "profile.qa", sourceId: "source.qa" as never, sourceVersionId: "version.qa" as never,
    sourceSystem, patternSchema: schema, componentRecipe: recipe, patternIds: ["construction.qa"], informationLabel: label,
    sourceDependencies: [{ sourceId: "source.qa" as never, sourceVersionId: "version.qa" as never, evidenceIds: ["evidence.qa" as never] }] };
  const pattern: LanguagePatternRecord = { id: projection.patternIds[0]!, profileId: projection.profileId, patternKind: "semantic_role", support: 1,
    entropy: 0, evidenceIds: ["evidence.qa" as never], updatedAt: 1, informationLabel: label,
    patternJson: { schema, componentRecipe: recipe, sourceSystem, profileId: projection.profileId, sourceId: projection.sourceId,
      sourceVersionId: projection.sourceVersionId, contextualQaRequestForm: ["Zŵ ", { slotIndex: 0 }], contextualQaRequestFeatures: ["lex:zŵ"] } };
  return { adapter, calls, projection, pattern };
}

it("publishes contextual QA under its exact source and recipe with dependency ownership", async () => {
  const { adapter, calls, projection, pattern } = fixture();
  await adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] });
  const write = calls.find(call => call.sql.includes("AS metadata(key,value_json,updated_at)"))!;
  expect(write.params[0]).toContain('"source-owned"');
  expect(write.params[0]).toContain(recipe);
  expect(JSON.parse(String(write.params[1])).sourceDependencies).toEqual(projection.sourceDependencies);
  expect(write.sql).toContain("previous_version.source_id=incoming_version.source_id");
  expect(calls.find(call => call.sql.includes("SELECT TRUE AS source_owner_valid"))?.params.slice(0, 3))
    .toEqual([projection.profileId, projection.sourceVersionId, projection.sourceId]);
  expect(calls.some(call => call.sql.includes("DELETE FROM"))).toBe(false);
});

it.each(["profile", "source", "version", "namespace", "kind", "recipe", "evidence", "dependencies"])("rejects contextual QA %s mismatch before writes", async damage => {
  const { adapter, calls, projection, pattern } = fixture();
  const metadata = pattern.patternJson as Record<string, unknown>;
  if (damage === "profile") metadata.profileId = "foreign";
  if (damage === "source") metadata.sourceId = "foreign";
  if (damage === "version") metadata.sourceVersionId = "foreign";
  if (damage === "namespace") projection.sourceSystem = "foreign";
  if (damage === "kind") pattern.patternKind = "discourse";
  if (damage === "recipe") metadata.componentRecipe = "foreign";
  if (damage === "evidence") pattern.evidenceIds = ["foreign" as never];
  if (damage === "dependencies") projection.sourceDependencies = [];
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] })).rejects.toThrow();
  expect(calls).toEqual([]);
});

it("uses only indexed contextual QA candidate owners before compilation and body budgets", async () => {
  const { adapter, calls } = fixture();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params });
    return sql.startsWith("SELECT DISTINCT pattern.profile_id,pattern.source_system") ? [{ profile_id: "profile.qa", source_system: sourceSystem }] as T[] : []; };
  await adapter.languageMemory.listLanguagePatterns({ contextualQaRequestFeatures: ["lex:zŵ"], patternSchemas: [schema], sourceSystem, view: "request_seed", limit: 4 });
  const probe = calls[0]!;
  expect(probe.sql).toMatch(/^SELECT DISTINCT pattern\.profile_id,pattern\.source_system/u);
  expect(probe.sql).toContain("pattern.pattern_json->'contextualQaRequestFeatures' ?|");
  expect(probe.sql).toContain(`pattern.pattern_json->>'componentRecipe'='${recipe}'`);
  expect(probe.sql).toContain("pattern.information_label->>'tenantId'");
  const body = calls.at(-1)!;
  for (const marker of ["dependency_evidence.status='promoted'", "newer_dependency_evidence.status='promoted'", "WHERE dependency_evidence.id IS NULL", recipe]) expect(body.sql).toContain(marker);
  expect(body.sql.indexOf("WHERE dependency_evidence.id IS NULL")).toBeLessThan(body.sql.indexOf("ranked_pool AS"));
});

it("does no global catalog work for an empty contextual QA lookup", async () => {
  const { adapter, calls } = fixture();
  expect(await adapter.languageMemory.listLanguagePatterns({ contextualQaRequestFeatures: [] })).toEqual([]);
  expect(calls).toEqual([]);
});

it("rejects incompatible contextual QA scopes without reading another population", async () => {
  const { adapter, calls } = fixture();
  for (const scope of [{ sourceSystem: "foreign" }, { patternSchemas: ["foreign"] }, { patternKind: "discourse" as const }, { sourceComputationBindingId: "other" }])
    expect(await adapter.languageMemory.listLanguagePatterns({ contextualQaRequestFeatures: ["lex:zŵ"], ...scope })).toEqual([]);
  for (const features of [null, "lex:zŵ", [""], [4]]) await expect(adapter.languageMemory.listLanguagePatterns({ contextualQaRequestFeatures: features as never })).rejects.toThrow();
  expect(calls).toEqual([]);
});

it("reads only a complete current contextual QA receipt and exact owned row inventory", async () => {
  const { adapter, calls, projection } = fixture();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params });
    return sql.includes("SELECT value_json FROM") ? [{ value_json: { ...projection, schema: "scce.language_pattern_active_projection.v1" } }] as T[]
      : sql.includes("SELECT pattern.id") ? projection.patternIds.map(id => ({ id })) as T[] : []; };
  expect(await adapter.languageMemory.getLanguagePatternProjection!(projection)).toEqual(projection);
  expect(calls[0]!.sql).toContain("active_projection.information_label");
  expect(calls[0]!.sql).toContain("newer_dependency_evidence.status='promoted'");
  expect(calls[1]!.sql).toContain("pattern.evidence_ids <@ $7::text[]");
  calls.length = 0;
  expect(await adapter.languageMemory.getLanguagePatternProjection!({ ...projection, sourceSystem: "foreign" })).toBeUndefined();
  expect(await adapter.languageMemory.getLanguagePatternProjection!({ ...projection, patternSchema: "foreign" })).toBeUndefined();
  expect(calls).toEqual([]);
});

it("keeps contextual QA interpretation metadata without source programs or supervision text", () => {
  const { pattern } = fixture();
  Object.assign(pattern.patternJson as Record<string, unknown>, { bundle: { sourceExamples: [{ surface: "full source" }] }, witnesses: [{ answerText: "secret answer" }] });
  const projected = requestSeedLanguagePattern(pattern);
  expect(projected.patternJson).toHaveProperty("contextualQaRequestFeatures", ["lex:zŵ"]);
  expect(projected.patternJson).toHaveProperty("contextualQaRequestForm", ["Zŵ ", { slotIndex: 0 }]);
  expect(projected.patternJson).not.toHaveProperty("bundle");
  expect(projected.patternJson).not.toHaveProperty("witnesses");
});

it("declares one idempotent partial request-feature index without rewriting source programs", () => {
  expect(POSTGRES_SCHEMA_VERSION).toBe(31);
  const statements = schemaStatements('"fixture"');
  const indexes = statements.filter(sql => sql.includes("_contextual_qa_request_lookup"));
  expect(indexes).toEqual([`CREATE INDEX IF NOT EXISTS idx_fixture_contextual_qa_request_lookup ON "fixture".language_patterns USING GIN ((pattern_json->'contextualQaRequestFeatures')) WHERE pattern_kind='semantic_role' AND pattern_json->>'schema'='${schema}' AND pattern_json->>'componentRecipe'='${recipe}' AND source_system='${sourceSystem}'`]);
  expect(statements.some(sql => /UPDATE\s+\S*language_patterns\s+SET\s+pattern_json/iu.test(sql))).toBe(false);
});
