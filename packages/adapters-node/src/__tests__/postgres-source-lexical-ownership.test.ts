// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { LEXICAL_SENSE_SCHEMA, LEXICAL_SENSE_RECIPE, LEXICAL_GRAMMAR_SCHEMA, LEXICAL_GRAMMAR_RECIPE,
  SOURCE_QUESTION_FRAME_SCHEMA, SOURCE_QUESTION_FRAME_RECIPE,
  type LanguagePatternProjection, type LanguagePatternRecord } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const label = { tenantId: "lexical.owner", principals: ["reader"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
const schemas = [[LEXICAL_SENSE_SCHEMA, LEXICAL_SENSE_RECIPE], [LEXICAL_GRAMMAR_SCHEMA, LEXICAL_GRAMMAR_RECIPE],
  [SOURCE_QUESTION_FRAME_SCHEMA, SOURCE_QUESTION_FRAME_RECIPE]] as const;

function fixture(schema: string, recipe: string) {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "fixture", informationAccess: {
    tenantId: label.tenantId, principalId: "reader", compartments: [], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.includes("SELECT TRUE AS source_owner_valid")) return [{ source_owner_valid: true }] as T[];
    if (sql.includes("SELECT TRUE AS lexical_scope_valid")) return [{ lexical_scope_valid: true }] as T[];
    if (sql.includes("SELECT DISTINCT pattern.profile_id,pattern.source_system")) return [{ profile_id: "profile", source_system: "workspace" }] as T[];
    return [];
  };
  adapter.transaction = async operation => operation();
  const projection: LanguagePatternProjection = { profileId: "profile", sourceId: "source" as never, sourceVersionId: "version" as never,
    sourceSystem: "workspace", patternSchema: schema, componentRecipe: recipe, patternIds: ["lexical.pattern"], informationLabel: label,
    sourceDependencies: [{ sourceId: "source" as never, sourceVersionId: "version" as never, contentHash: "content" as never, evidenceIds: ["evidence" as never] }] };
  const pattern: LanguagePatternRecord = { id: projection.patternIds[0]!, profileId: projection.profileId, patternKind: "semantic_role", support: 1,
    entropy: 0, evidenceIds: ["evidence" as never], updatedAt: 1, informationLabel: label,
    patternJson: { schema, componentRecipe: recipe, sourceSystem: "workspace", profileId: "profile", sourceId: "source", sourceVersionId: "version",
      sourceContentHash: "content", lexiconId: "retained.lexicon", language: "el" } };
  return { adapter, calls, projection, pattern };
}

it.each(schemas)("publishes %s only with its current accessible hash-bound source inventory", async (schema, recipe) => {
  const { adapter, calls, projection, pattern } = fixture(schema, recipe);
  await adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] });
  const validation = calls.find(call => call.sql.includes("SELECT TRUE AS lexical_scope_valid"))!;
  for (const fragment of ["dependency_version.content_hash IS DISTINCT FROM", "dependency_evidence.status='promoted'",
    "newer_dependency_version.observed_at,newer_dependency_version.id", "auxiliary_profile", "dependency_evidence.information_label->>'tenantId'"]) {
    expect(validation.sql).toContain(fragment);
  }
  const write = calls.find(call => call.sql.includes("AS metadata(key,value_json,updated_at)"))!;
  expect(String(write.params[0])).toContain('"source-owned"');
  expect(String(write.params[0])).toContain(recipe);
  expect(JSON.parse(String(write.params[1])).sourceDependencies).toEqual(projection.sourceDependencies);
  expect(write.sql).toContain("previous_version.observed_at,previous_version.id");
  expect(calls.indexOf(validation)).toBeLessThan(calls.findIndex(call => call.sql.includes('INSERT INTO "fixture"."language_patterns"')));
});

it.each(["recipe", "namespace", "source", "profile", "hash", "lexicon", "language", "evidence", "dependencyHash"])("rejects lexical %s damage before writes", async damage => {
  const { adapter, calls, projection, pattern } = fixture(...schemas[0]);
  const metadata = pattern.patternJson as Record<string, unknown>;
  if (damage === "recipe") projection.componentRecipe = "foreign";
  if (damage === "namespace") projection.sourceSystem = "dialogue";
  if (damage === "source") metadata.sourceId = "foreign";
  if (damage === "profile") metadata.profileId = "foreign";
  if (damage === "hash") metadata.sourceContentHash = "foreign";
  if (damage === "lexicon") delete metadata.lexiconId;
  if (damage === "language") delete metadata.language;
  if (damage === "evidence") pattern.evidenceIds = ["foreign" as never];
  if (damage === "dependencyHash") delete projection.sourceDependencies![0]!.contentHash;
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] })).rejects.toThrow();
  expect(calls).toEqual([]);
});

it("rejects a stale or revoked lexical dependency before publishing any learned rows", async () => {
  const { adapter, calls, projection, pattern } = fixture(...schemas[0]);
  const original = adapter.query;
  adapter.query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => sql.includes("SELECT TRUE AS lexical_scope_valid") ? [] : original<T>(sql, params);
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!({ projection, patterns: [pattern] })).rejects.toThrow("stale, revoked");
  expect(calls.some(call => call.sql.includes("INSERT INTO"))).toBe(false);
});

it.each(schemas)("filters %s by active ownership and complete membership before resource admission", async (schema, recipe) => {
  const { adapter, calls } = fixture(schema, recipe);
  await adapter.languageMemory.listLanguagePatterns({ patternSchemas: [schema], languageId: "learned.el", lexicalUnits: ["ποιος"],
    requireComplete: true, limit: 10, maxTotalJsonBytes: 8192 });
  const query = calls.at(-1)!;
  expect(query.params).toContain(recipe);
  for (const fragment of ["dependency_version.content_hash IS DISTINCT FROM", "selected_evidence.status='promoted'",
    "computation_member.id=member.pattern_id", "computation_member.profile_id=member.profile_id",
    "computation_member.source_system=member.source_system", "computation_member.pattern_schema=member.pattern_schema",
    "computation_member.component_recipe=member.projection_recipe", "computation_member.owned_source_version_id=member.source_version_id",
    "computation_member.pattern_kind='semantic_role'", "COALESCE(array_length(computation_member.evidence_ids,1),0)>0",
    "active_projection.information_label", "pattern.information_label", "row_number() OVER () AS projection_key",
    "FULL JOIN active_projection_ids_0_dependencies allowed",
    "allowed.projection_key=requested.projection_key AND allowed.evidence_id=requested.evidence_id",
    "declared.projection_key=membership.projection_key AND declared.dependency_ordinal=membership.dependency_ordinal",
    "declared.source_id=membership.evidence_source_id AND declared.source_version_id=membership.evidence_source_version_id",
    "GROUP BY projection_key,profile_id,source_system,pattern_schema,projection_recipe,source_version_id,pattern_id",
    "HAVING bool_and(allowed_id IS NOT NULL)",
    "active_projection.value_json->>'sourceSystem'='workspace'", "complete_stats", "expected_pattern_count=complete_stats.complete_pattern_count"]) {
    expect(query.sql).toContain(fragment);
  }
  expect(query.sql.indexOf("dependency_version.content_hash IS DISTINCT FROM")).toBeLessThan(query.sql.indexOf("ranked_pool AS"));
  expect(query.sql.indexOf("_eligible AS MATERIALIZED")).toBeLessThan(query.sql.indexOf("candidate_pool AS MATERIALIZED"));
  expect(query.sql).toContain("SUM(COALESCE(selected.decoded_jsonb_bytes, octet_length(selected.pattern_json::text)))");
  expect(query.sql).not.toContain("eligible_patterns eligible JOIN complete_read");
  expect(query.params).not.toContain(null);
  expect(query.sql).toContain("octet_length(array_to_json(pattern.evidence_ids)::text)");
  expect(query.sql).toContain("pg_column_size(pattern.pattern_json) + pg_column_size(pattern.evidence_ids)");
});

it.each([{}, { limit: 10 }, { limit: 10, maxTotalJsonBytes: 8192 }])("requires an explicit complete lexical budget %j", async budget => {
  const { adapter, calls } = fixture(...schemas[0]);
  await expect(adapter.languageMemory.listLanguagePatterns({ lexicalUnits: ["語"], ...budget })).rejects.toThrow("complete finite");
  expect(calls).toEqual([]);
});

it.each([[11, 10, 100], [1, 1, 8193]])("reports lexical capacity failure instead of partial knowledge (%s/%s/%s)", async (expected, complete, bytes) => {
  const { adapter } = fixture(...schemas[0]);
  const original = adapter.query;
  adapter.query = async <T>(sql: string, params?: unknown[]): Promise<T[]> => sql.includes("complete_stats AS")
    ? [{ id: null, expected_pattern_count: expected, complete_pattern_count: complete, decoded_complete_bytes: bytes }] as T[] : original<T>(sql, params);
  await expect(adapter.languageMemory.listLanguagePatterns({ patternSchemas: [schemas[0][0]], lexicalUnits: ["語"],
    requireComplete: true, limit: 10, maxTotalJsonBytes: 8192 })).rejects.toThrow("exceeds the configured");
});
