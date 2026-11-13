// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { SOURCE_REQUEST_EDIT_SCHEMA as schema, SOURCE_REQUEST_EDIT_RECIPE as recipe, type LanguagePatternProjection, type LanguagePatternRecord } from "@scce/kernel";
import { PostgresStorageAdapter, schemaStatements } from "../postgres.js";
const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const label = { tenantId: "owned", principals: ["owner"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
function fixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "fixture", informationAccess: {
    tenantId: label.tenantId, principalId: "owner", compartments: [], maximumExportClass: "restricted" } }); adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return sql.includes("SELECT TRUE AS source_owner_valid") ? [{ source_owner_valid: true }] as T[] : []; };
  adapter.transaction = async operation => operation();
  const projection: LanguagePatternProjection = { profileId: "profile", sourceId: "source" as never, sourceVersionId: "version" as never,
    sourceSystem: "dialogue", patternSchema: schema, componentRecipe: recipe, informationLabel: label, patternIds: ["program"],
    sourceDependencies: [{ sourceId: "source" as never, sourceVersionId: "version" as never, evidenceIds: ["evidence" as never] },
      { sourceId: "second" as never, sourceVersionId: "second.version" as never, evidenceIds: ["second.evidence" as never] }] };
  const pattern: LanguagePatternRecord = { id: "program", profileId: "profile", patternKind: "semantic_role", support: 3, entropy: 0,
    evidenceIds: ["evidence", "second.evidence"] as never, updatedAt: 1, informationLabel: label,
    patternJson: { schema, componentRecipe: recipe, sourceSystem: "dialogue", sourceId: "source", sourceVersionId: "version", profileId: "profile" } };
  return { adapter, calls, projection, pattern };
}
it("publishes the exact source-owned active component and preserves all source dependencies", async () => {
  const { adapter, calls, projection, pattern } = fixture();
  await adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] });
  const write = calls.find(call => call.sql.includes("AS metadata(key,value_json,updated_at)"))!;
  expect(JSON.parse(String(write.params[1])).sourceDependencies).toEqual(projection.sourceDependencies);
  expect(String(write.params[0])).toContain('"source-owned"');
  expect(String(write.params[0])).toContain(recipe);
});
it("selects complete indexed candidates before replay while guarding all current principal-owned dependencies", async () => {
  const { adapter, calls } = fixture();
  await adapter.languageMemory.listLanguagePatterns({ patternSchemas: [schema], sourceEditRequestFeatures: ["lex:操作"], limit: 512,
    maxTotalJsonBytes: 8 * 1024 * 1024, requireComplete: true });
  const call = calls.at(-1)!;
  expect(call.sql).toContain("pattern.pattern_json->'sourceEditRequestFeatures' ?|");
  for (const part of ["dependency_version", "dependency_evidence", "newer_dependency_version", "newer_dependency_evidence",
    "auxiliary_profile", "auxiliary_owner", "dependency_evidence_ids", "computation_member.evidence_ids <@ header.dependency_evidence_ids"]) expect(call.sql).toContain(part);
  expect(call.params).toContain(schema); expect(call.params).toContain(recipe); expect(call.params).toContainEqual(["lex:操作"]);
  expect(call.params).toContain("owner");
  expect(schemaStatements("fixture").some(statement => statement.includes("USING GIN ((pattern_json->'sourceEditRequestFeatures'))")
    && statement.includes(`pattern_json->>'schema'='${schema}'`) && statement.includes(`pattern_json->>'componentRecipe'='${recipe}'`))).toBe(true);
});
it.each(["recipe", "profile", "source", "dependencies"])("rejects forged edit publication %s before writes", async damage => {
  const { adapter, calls, projection, pattern } = fixture();
  const body = pattern.patternJson as Record<string, unknown>;
  if (damage === "recipe") body.componentRecipe = "forged";
  if (damage === "profile") body.profileId = "forged";
  if (damage === "source") body.sourceId = "forged";
  if (damage === "dependencies") projection.sourceDependencies = [];
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] })).rejects.toThrow();
  expect(calls).toEqual([]);
});
