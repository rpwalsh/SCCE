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
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
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

it("declares schema30 with one idempotent partial full-form lookup index and no source body rewrite", () => {
  expect(POSTGRES_SCHEMA_VERSION).toBe(30);
  const statements = schemaStatements('"fixture"'), lookup = statements.filter(sql => sql.includes("_source_computation_binding_lookup"));
  expect(lookup).toEqual([`CREATE INDEX IF NOT EXISTS idx_fixture_source_computation_binding_lookup ON "fixture".language_patterns(source_system,(pattern_json->>'bindingId'),support DESC,updated_at DESC,id) WHERE pattern_json->>'schema'='${schema}'`]);
  expect(statements.some(sql => /UPDATE\s+\S*language_patterns\s+SET\s+pattern_json/iu.test(sql))).toBe(false);
});
