// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { POSTGRES_SCHEMA_VERSION, SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA as schema, SOURCE_COMPUTATION_CONSTRUCTION_RECIPE as recipe,
  requestSeedLanguagePattern, type LanguagePatternRecord } from "@scce/kernel";
import { PostgresStorageAdapter, schemaStatements } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
function fixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "fixture", informationAccess: {
    tenantId: "tenant.owned", principalId: "principal.owned", compartments: [], maximumExportClass: "restricted"
  } }); adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params });
    return sql.startsWith("SELECT DISTINCT pattern.profile_id,pattern.source_system") ? [{ profile_id: "profile.owned", source_system: "dialogue" }] as T[] : []; };
  return { adapter, calls };
}

it("filters an exact full-form computation binding before body hydration and keeps current source admission", async () => {
  const { adapter, calls } = fixture(), binding = "computation.binding.港.קלט";
  await adapter.languageMemory.listLanguagePatterns({ sourceComputationBindingId: binding, patternSchemas: [schema], sourceSystem: "dialogue",
    languageId: "language.owned", maxTotalJsonBytes: 4096, limit: 8 });
  const call = calls.at(-1)!, headers = call.sql.slice(call.sql.indexOf("pattern_headers AS MATERIALIZED"), call.sql.indexOf("candidate_pool AS MATERIALIZED"));
  expect(call.params).toContain(binding);
  expect(call.params).toContain(recipe);
  const bindingParameter = call.params.indexOf(binding) + 1;
  expect(headers).toContain(`pattern.pattern_json->>'bindingId'=$${bindingParameter}`);
  expect(headers).toContain(`pattern.pattern_json->>'schema'='${schema}'`);
  expect(headers).toContain("pattern.source_system='dialogue'");
  expect(headers).toContain("pattern.information_label->>'tenantId'");
  expect(headers).toContain("lp.language_id=");
  expect(headers).not.toContain("pattern.pattern_json AS");
  expect(call.sql.indexOf(`pattern.pattern_json->>'bindingId'=$${bindingParameter}`)).toBeLessThan(call.sql.indexOf("candidate_pool AS MATERIALIZED"));
  for (const guard of ["dependency_evidence.status='promoted'", "newer_dependency_evidence.status='promoted'",
    "computation_member.evidence_ids <@ header.dependency_evidence_ids", "pattern.id,pattern.component_recipe,pattern.owned_source_version_id"])
    expect(call.sql).toContain(guard);
});

it("fails closed on invalid bindings and incompatible requested computation scope before storage reads", async () => {
  const { adapter, calls } = fixture();
  for (const binding of ["", 7 as never, null as never]) await expect(adapter.languageMemory.listLanguagePatterns({ sourceComputationBindingId: binding })).rejects.toThrow();
  for (const scope of [{ sourceSystem: "foreign" }, { patternSchemas: ["foreign"] }, { patternKind: "discourse" as const }])
    expect(await adapter.languageMemory.listLanguagePatterns({ sourceComputationBindingId: "binding.owned", ...scope })).toEqual([]);
  expect(calls).toEqual([]);
});

it("preserves only the compact binding in request metadata without expanding a computation program", () => {
  const row: LanguagePatternRecord = { id: "computation.owned", profileId: "profile.owned", patternKind: "semantic_role", support: 1, entropy: 0,
    evidenceIds: ["evidence.owned" as never], updatedAt: 1, patternJson: { schema, componentRecipe: recipe, sourceSystem: "dialogue", bindingId: "binding.owned",
      expression: { kind: "source program" }, witnesses: [{ resultText: "999" }], inputConstruction: { sourceExamples: [{ surface: "large source" }] } } };
  const projected = requestSeedLanguagePattern(row);
  expect(projected.patternJson).toHaveProperty("bindingId", "binding.owned");
  for (const key of ["expression", "witnesses", "inputConstruction"]) expect(projected.patternJson).not.toHaveProperty(key);
});

it("retains the partial full-form computation lookup without source body rewrites", () => {
  expect(POSTGRES_SCHEMA_VERSION).toBe(35);
  const statements = schemaStatements('"fixture"'), lookup = statements.filter(sql => sql.includes("_source_computation_binding_lookup"));
  expect(lookup).toEqual([`CREATE INDEX IF NOT EXISTS idx_fixture_source_computation_binding_lookup ON "fixture".language_patterns(source_system,(pattern_json->>'bindingId'),support DESC,updated_at DESC,id) WHERE pattern_json->>'schema'='${schema}'`]);
  expect(statements.some(sql => /UPDATE\s+\S*language_patterns\s+SET\s+pattern_json/iu.test(sql))).toBe(false);
});

it.each([0, 1, 1007])("scopes compilation inventories to all %i exact indexed candidate owners before metadata extraction", async count => {
  const { adapter, calls } = fixture();
  const owners = Array.from({ length: count }, (_, i) => ({ profile_id: `profile.candidate.${i}`, source_system: "dialogue" }));
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params });
    return sql.startsWith("SELECT DISTINCT pattern.profile_id,pattern.source_system") ? owners as T[] : []; };
  expect(await adapter.languageMemory.listLanguagePatterns({ sourceComputationBindingId: "binding.exact", patternSchemas: [schema], sourceSystem: "dialogue", limit: 1 })).toEqual([]);
  const probe = calls[0]!;
  expect(probe.sql).toMatch(/^SELECT DISTINCT pattern\.profile_id,pattern\.source_system/u);
  expect(probe.sql).toContain("pattern.pattern_json->>'bindingId'=$1");
  expect(probe.sql).toContain("pattern.information_label->>'tenantId'");
  expect(probe.sql).not.toContain("LIMIT");
  expect(probe.sql).not.toContain("SELECT pattern.pattern_json");
  if (!count) { expect(calls).toHaveLength(1); return; }
  const inventory = calls.find(call => call.sql.includes("AS model_metadata"))!;
  expect(inventory.sql).toContain('model.profile_id=requested_owner."profileId"');
  expect(inventory.sql).toContain('model.source_system IS NOT DISTINCT FROM requested_owner."sourceSystem"');
  expect(JSON.parse(String(inventory.params[0]))).toEqual(owners.map(owner => ({ profileId: owner.profile_id, sourceSystem: owner.source_system })));
  expect(inventory.sql).not.toContain("LIMIT");
  for (const alias of ["model", "profile", "version", "receipt"]) expect(inventory.sql).toContain(`${alias}.information_label`);
  const body = calls.at(-1)!;
  const ownerBindings = body.params.filter(value => typeof value === "string" && value.startsWith('[{"profileId"'));
  expect(ownerBindings).toHaveLength(1);
  expect(JSON.parse(String(ownerBindings[0]))).toHaveLength(count);
  expect(body.sql).toContain('requested_projection_owner."profileId"=active_projection.value_json->>\'profileId\'');
  expect(body.sql).toContain("dependency_evidence.status='promoted'");
  expect(calls).toHaveLength(3);
});

it("keeps exact row/profile/language/source and access constraints on an empty candidate probe", async () => {
  const { adapter, calls } = fixture();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
  expect(await adapter.languageMemory.listLanguagePatterns({ sourceComputationBindingId: "binding.exact", patternIds: ["pattern.exact"],
    profileIds: ["profile.exact"], languageId: "language.explicit", sourceSystem: "dialogue", patternSchemas: [schema], patternKind: "semantic_role" })).toEqual([]);
  expect(calls).toHaveLength(1);
  for (const marker of ["pattern.id=ANY(", "pattern.profile_id=ANY(", "pattern.source_system=", "lp.language_id=", "pattern.pattern_kind=", "pattern.information_label->>'tenantId'"])
    expect(calls[0]!.sql).toContain(marker);
});

it("does not replace a failed exact-owner probe with a global inventory query", async () => {
  const { adapter, calls } = fixture();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); throw new Error("candidate metadata unavailable"); };
  await expect(adapter.languageMemory.listLanguagePatterns({ sourceComputationBindingId: "binding.exact" })).rejects.toThrow("candidate metadata unavailable");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.sql).toMatch(/^SELECT DISTINCT pattern\.profile_id,pattern\.source_system/u);
});
