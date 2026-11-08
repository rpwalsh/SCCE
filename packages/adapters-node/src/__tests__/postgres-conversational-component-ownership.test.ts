// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { PostgresStorageAdapter } from "../postgres.js";
import { DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID as conversationRecipe } from "../dialogue-conversational-checkpoint.js";
import { REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA, REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE, REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM,
  LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, type LanguagePatternProjection, type LanguagePatternRecord } from "@scce/kernel";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const label = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
function fixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "fixture", informationAccess: {
    tenantId: label.tenantId, principalId: label.principals[0]!, compartments: [], maximumExportClass: "restricted"
  } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params });
    return sql.includes("SELECT TRUE AS source_owner_valid") ? [{ source_owner_valid: true }] as T[] : []; };
  adapter.transaction = async operation => operation();
  return { adapter, calls };
}
function publication(conversation = false) {
  const projection: LanguagePatternProjection = { profileId: "profile.owned", sourceId: "source.owned" as never, sourceVersionId: "version.owned" as never,
    sourceSystem: conversation ? "dialogue" : REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM,
    patternSchema: conversation ? LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA : REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,
    componentRecipe: conversation ? conversationRecipe : REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE, patternIds: ["pattern.owned"], informationLabel: label,
    ...(conversation ? { sourceDependencies: [{ sourceId: "source.owned" as never, sourceVersionId: "version.owned" as never, evidenceIds: ["evidence.owned" as never] }] } : {}) };
  const pattern: LanguagePatternRecord = { id: "pattern.owned", profileId: projection.profileId, patternKind: conversation ? "semantic_role" : "discourse",
    support: 1, entropy: 0, evidenceIds: ["evidence.owned" as never], updatedAt: 1, informationLabel: label,
    patternJson: { schema: projection.patternSchema, sourceSystem: projection.sourceSystem, profileId: projection.profileId,
      sourceId: projection.sourceId, sourceVersionId: projection.sourceVersionId, componentRecipe: projection.componentRecipe } };
  return { projection, patterns: [pattern] };
}

it("publishes request-act owners under a logical-source key and never lets an older version replace the current owner", async () => {
  const { adapter, calls } = fixture(), input = publication();
  await adapter.languageMemory.replaceLanguagePatternProjection!(input);
  const write = calls.find(call => call.sql.includes("AS metadata(key,value_json,updated_at)"))!;
  expect(write.params[0]).toContain('"source-owned"');
  expect(write.params[0]).toContain('"source.owned"');
  expect(write.params[0]).not.toContain('"profile.owned"');
  expect(write.sql).toContain("previous_version.source_id=incoming_version.source_id");
  expect(write.sql).toContain("previous_version.observed_at,previous_version.id");
});

it("rejects a nonexistent or inaccessible auxiliary source owner before storing any pattern", async () => {
  const { adapter, calls } = fixture();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => { calls.push({ sql, params }); return []; };
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!(publication())).rejects.toThrow("accessible source profile/version");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.sql).toContain("owner_profile.source_version_id");
  expect(calls[0]!.sql).toContain("owner_version.information_label->>'tenantId'");
});

it("does not accept a completed auxiliary projection when any exact owned header is missing", async () => {
  const { adapter, calls } = fixture(), { projection } = publication();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    return sql.includes("SELECT value_json FROM") ? [{ value_json: { ...projection, schema: "scce.language_pattern_active_projection.v1" } }] as T[] : [];
  };
  expect(await adapter.languageMemory.getLanguagePatternProjection!(projection)).toBeUndefined();
  expect(calls).toHaveLength(2);
  expect(calls[1]!.sql).toContain("pattern.id=ANY($1::text[])");
  expect(calls[1]!.params.slice(0, 6)).toEqual([projection.patternIds, projection.profileId, projection.sourceVersionId,
    projection.sourceSystem, projection.patternSchema, projection.componentRecipe]);
  expect(calls[1]!.sql).not.toContain("pattern_json");
});

it.each(["profile", "source", "version", "kind", "namespace", "recipe", "evidence"])("rejects an auxiliary request-act %s mismatch before any write", async damage => {
  const { adapter, calls } = fixture(), input = publication();
  if (damage === "profile") input.patterns[0]!.profileId = "foreign";
  if (damage === "kind") input.patterns[0]!.patternKind = "semantic_role";
  if (damage === "evidence") input.patterns[0]!.evidenceIds = [];
  const fields: Record<string, string> = { source: "sourceId", version: "sourceVersionId", namespace: "sourceSystem", recipe: "componentRecipe" };
  const field = fields[damage];
  if (field) (input.patterns[0]!.patternJson as Record<string, unknown>)[field] = "foreign";
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!(input)).rejects.toThrow();
  expect(calls).toEqual([]);
});

it("admits only active request-act owner IDs with real source/profile and promoted accessible evidence before budgets", async () => {
  const { adapter, calls } = fixture();
  await adapter.languageMemory.listLanguagePatterns({ sourceSystem: REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM,
    patternSchemas: [REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA], limit: 2048 });
  const sql = calls.at(-1)!.sql;
  for (const marker of ["projection_profile.source_version_id=active_projection.value_json->>'sourceVersionId'",
    "projection_version.source_id=active_projection.value_json->>'sourceId'", "owned_evidence.status='promoted'",
    "newer_act_version.observed_at,newer_act_version.id", "newer_act_evidence.status='promoted'",
    "owned_evidence.source_version_id=pattern.owned_source_version_id", "owned_evidence.information_label->>'tenantId'",
    "evidence_owner.source_id=owned_evidence.source_id", "WHERE owned_evidence.id IS NULL"]) expect(sql).toContain(marker);
  expect(sql.indexOf("WHERE owned_evidence.id IS NULL")).toBeLessThan(sql.indexOf("ranked_pool AS"));
  expect(calls.at(-1)!.params).toContain(REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE);
  expect(sql).not.toContain("OR NOT EXISTS (\n          SELECT 1 FROM active_projection_ids_0_headers published");
});

it("keeps conversational auxiliary publication separate from base compilation and carries exact pooled dependencies once", async () => {
  const { adapter, calls } = fixture(), input = publication(true);
  await adapter.languageMemory.replaceLanguagePatternProjection!(input);
  const auxiliary = calls.find(call => call.sql.includes("AS metadata(key,value_json,updated_at)"))!;
  expect(auxiliary.params[0]).toContain(conversationRecipe);
  expect(JSON.parse(String(auxiliary.params[1])).sourceDependencies).toEqual(input.projection.sourceDependencies);
  calls.length = 0;
  await adapter.languageMemory.replaceLanguagePatternProjection!({ patterns: [], projection: { ...input.projection,
    componentRecipe: LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID, patternIds: [], sourceDependencies: undefined } });
  const base = calls.find(call => call.sql.includes("AS metadata(key,value_json,updated_at)"))!;
  expect(base.params[0]).not.toBe(auxiliary.params[0]);
  calls.length = 0;
  await adapter.languageMemory.listLanguagePatterns({ patternSchemas: [LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA] });
  const sql = calls.at(-1)!.sql;
  expect(sql).toContain(`OR active_projection.value_json->>'componentRecipe'='${conversationRecipe}'`);
  for (const marker of ["sourceDependencies", "dependency_version.source_id=dependency.", "dependency_evidence.status='promoted'",
    "newer_dependency_version.observed_at,newer_dependency_version.id", "newer_dependency_evidence.status='promoted'",
    "dependency_evidence.information_label->>'tenantId'", "newer_dependency_version.information_label->>'tenantId'"]) expect(sql).toContain(marker);
});

it("does not let a base projection bypass conversational dependency admission", async () => {
  const { adapter, calls } = fixture(), input = publication(true);
  input.projection.componentRecipe = LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID;
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!(input)).rejects.toThrow();
  expect(calls).toEqual([]);
});

it.each([undefined, [], [{ sourceId: "source.foreign", sourceVersionId: "version.foreign", evidenceIds: ["evidence.owned"] }],
  [{ sourceId: "source.owned", sourceVersionId: "version.owned", evidenceIds: ["evidence.foreign"] }]])("rejects missing, foreign or incomplete pooled dependencies %j", async dependencies => {
  const { adapter, calls } = fixture(), input = publication(true);
  input.projection.sourceDependencies = dependencies as never;
  await expect(adapter.languageMemory.replaceLanguagePatternProjection!(input)).rejects.toThrow();
  expect(calls).toEqual([]);
});
