// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA, SOURCE_COMPUTATION_CONSTRUCTION_RECIPE } from "@scce/kernel";
import { createHasher, stampSourceLanguageCompilation, validateSourceLanguageCompilationHeader, INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID, INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA, LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA, SOURCE_CODE_FUNCTION_PATTERN_SCHEMA, SOURCE_CODE_FUNCTION_PROJECTION_RECIPE_ID, SOURCE_SEGMENTATION_WITNESS_SCHEMA, POSTGRES_REQUIRED_TABLES, type JsonValue, type SourceVersionId } from "@scce/kernel";
import { canonicalDigestHex } from "../../../kernel/src/canonical-json-digest.js";
import { LANGUAGE_TRAINING_BATCH_RECIPE_ID } from "../../../kernel/src/language-training-recipe.js";
import { sourceLanguageTrainingStreamId } from "../../../kernel/src/source-language-training-identity.js";
import { clearResidentNgramModelJson, createPostgresStorageAdapter, schemaStatements, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres language-memory ownership queries", () => {
  it.each([
    { maxTotalJsonBytes: undefined, view: undefined, patternIds: undefined },
    { maxTotalJsonBytes: 1_000_000, view: "request_seed" as const, patternIds: undefined },
    { maxTotalJsonBytes: undefined, view: "request_seed" as const, patternIds: ["pattern.current"] },
    { maxTotalJsonBytes: 1_000_000, view: undefined, patternIds: ["pattern.current"] }
  ])("carries narrow checked headers through admission without rescanning or retaining large bodies: %j", async options => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ ...options, profileIds: ["profile.owned"], sourceSystem: "oss_code",
      languageId: "language.owned", formalLanguage: "typescript", parameterCount: 0, limit: 12 });
    const sql = calls.at(-1)!.sql;
    const headers = sql.slice(sql.indexOf("pattern_headers AS MATERIALIZED ("), sql.indexOf("candidate_pool AS MATERIALIZED ("));
    expect(headers).not.toContain("jsonb_to_record");
    for (const field of ["pattern_schema", "component_recipe", "source_compilation_id", "owned_source_version_id", "pattern_language", "has_source_compilation", "has_source_version"]) {
      expect(headers).toContain(`pattern.${field}`);
    }
    expect(headers).not.toContain("pattern.pattern_json ?");
    for (const filter of ["pattern.profile_id=ANY(", "pattern.source_system=", "pattern.pattern_json->>'formalLanguage'=",
      "pattern.pattern_json->>'parameterCount'=", "lp.language_id=", "pattern.information_label->>'tenantId'"]) expect(headers).toContain(filter);
    expect(headers).not.toMatch(/pattern\.pattern_json\s+AS\s+pattern_json|SELECT\s+pattern\.\*/u);
    const pool = sql.slice(sql.indexOf("candidate_pool AS MATERIALIZED ("), sql.indexOf("category_counts AS MATERIALIZED ("));
    expect(pool).toContain("FROM pattern_headers pattern");
    expect(pool).toContain("pattern.has_source_compilation");
    expect(pool).toContain("pattern.has_source_version");
    expect(pool).toContain('current_compilation."sourceVersionId"=pattern.owned_source_version_id');
    expect(pool).not.toContain("pattern.pattern_json");
    for (const field of ["pattern_schema", "pattern_language", "source_system"]) {
      expect(sql).toContain(`ranked.${field}`);
      expect(sql).toContain(`admitted.${field}`);
    }
    expect(sql).toContain("information_label,pattern_schema,pattern_language,source_system FROM");
    expect(sql).not.toContain("JOIN pattern_headers");
    expect(sql.indexOf('JOIN "fixture"."language_patterns" pattern ON pattern.id=admitted.id')).toBeGreaterThan(sql.indexOf("admitted AS ("));
    expect(sql).toContain("WHERE scoped.pattern_schema='scce.request_requirement_pattern.v1'");
    expect(sql).toContain("WHERE pattern_schema IS DISTINCT FROM 'scce.request_requirement_pattern.v1'");
    expect(calls.at(-1)!.params).toContainEqual(["profile.owned"]);
    expect(calls.at(-1)!.params).toContain("typescript");
    expect(calls.at(-1)!.params).toContain("0");
  });

  it.each([
    ["kernel.language_training_batch.v3", undefined],
    ["kernel.language_training_batch.v4", undefined],
    ["kernel.language_training_batch.v4", "kernel.language_training_batch.v4"],
    ["kernel.language_training_batch.v5", undefined],
    ["kernel.language_training_batch.v5", "kernel.language_training_batch.v5"]
  ])("reads the exact current stored %s generation with identity recipe %s while training still requires recompilation", async (recipe, identityRecipe) => {
    const { adapter } = fixture();
    const stored = compilationHeaderFixture(recipe!, identityRecipe);
    const newer = compilationHeaderFixture();
    const compilationId = (row: typeof stored) => (row.model_metadata as { sourceCompilation: { compilationId: string } }).sourceCompilation.compilationId;
    let header = stored;
    const rows = [{ id: "foreign.v5-looking", compilationId: compilationId(newer) }, { id: "stored.current", compilationId: compilationId(stored) }];
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes("AS model_metadata")) return [header] as T[];
      const ownerParam = params.find(value => typeof value === "string" && value.startsWith("[{\"compilationId\""));
      const owners = typeof ownerParam === "string" ? JSON.parse(ownerParam) as Array<{ compilationId: string }> : [];
      return rows.filter(row => owners.some(owner => owner.compilationId === row.compilationId)).slice(0, 1).map(row => ({ id: row.id, profile_id: stored.profile_id,
        pattern_kind: "semantic_role", support: "100", entropy: "0", pattern_json: { sourceCompilationId: row.compilationId }, evidence_ids: [], updated_at: new Date(1),
        information_label: { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" } })) as T[];
    };
    const read = () => adapter.languageMemory.listLanguagePatterns({ profileId: stored.profile_id, sourceSystem: stored.source_system, limit: 1, maxTotalJsonBytes: 1000 });
    expect((await read()).map(row => row.id)).toEqual(["stored.current"]);
    const validation = { owner: { sourceId: stored.source_id as never, sourceVersionId: stored.source_version_id as SourceVersionId, contentHash: stored.content_hash as never },
      profileId: stored.profile_id, sourceSystem: stored.source_system, modelJson: stored.model_metadata, compilationReceipt: stored.compilation_receipt, hasher: createHasher() };
    expect(() => validateSourceLanguageCompilationHeader(validation)).toThrow("canonical source compilation header");
    expect(validateSourceLanguageCompilationHeader({ ...validation, validationPolicy: "read_stored" })).toBe(compilationId(stored));
    header = compilationHeaderFixture("kernel.language_training_batch.v999");
    expect(await read()).toEqual([]);
    header = { ...stored, compilation_receipt: { ...(stored.compilation_receipt as object), modelInventory: [] } };
    expect(await read()).toEqual([]);
    header = newer;
    expect((await read()).map(row => row.id)).toEqual(["foreign.v5-looking"]);
    expect(rows).toHaveLength(2);
  });
  it("admits only the validated current source generation before any pattern row or byte budget", async () => {
    const { adapter, calls } = fixture();
    const header = compilationHeaderFixture();
    const current = (header.model_metadata as { sourceCompilation: { compilationId: string } }).sourceCompilation.compilationId;
    const patterns = [
      { id: "stale.semantic", support: 100, sourceCompilationId: "old-compilation", schema: "scce.induced_language_model.semantic_memory.v1" },
      { id: "stale.creative", support: 90, sourceCompilationId: "old-compilation", schema: "scce.creative_event_construction_pattern.v3" },
      { id: "current.semantic", support: 3, sourceCompilationId: current, schema: "scce.induced_language_model.semantic_memory.v1" },
      { id: "current.creative", support: 2, sourceCompilationId: current, schema: "scce.creative_event_construction_pattern.v3" },
      { id: "imported.standalone", support: 1, schema: "scce.induced_language_model.semantic_memory.v1" }
    ].map(row => ({ ...row, profileId: "profile.owned", sourceSystem: "gutenberg", sourceVersionId: "version.owned" }));
    patterns.splice(2, 0, { ...patterns[2]!, id: "wrong.version", sourceVersionId: "other.version" },
      { ...patterns[2]!, id: "wrong.profile", profileId: "other.profile" }, { ...patterns[2]!, id: "wrong.system", sourceSystem: "other.system" });
    let headers = [header];
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      if (sql.includes("AS model_metadata")) return structuredClone(headers) as T[];
      const ownerParam = params.find(value => typeof value === "string" && value.startsWith("[{\"compilationId\""));
      const owners = typeof ownerParam === "string" ? JSON.parse(ownerParam) as Array<{ compilationId: string; profileId: string; sourceSystem: string; sourceVersionId: string }> : [];
      const rows = patterns.filter(row => !row.sourceCompilationId || !sql.includes("current_compilation") || owners.some(owner => owner.compilationId === row.sourceCompilationId
        && owner.profileId === row.profileId && owner.sourceSystem === row.sourceSystem && owner.sourceVersionId === row.sourceVersionId));
      return rows.slice(0, 2).map(row => ({ id: row.id, profile_id: "profile.owned", pattern_kind: "semantic_role", support: String(row.support), entropy: "0",
        pattern_json: row, evidence_ids: [], updated_at: new Date(1), information_label: { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" } })) as T[];
    };
    const read = () => adapter.languageMemory.listLanguagePatterns({ profileId: "profile.owned", sourceSystem: "gutenberg", limit: 2, maxTotalJsonBytes: 1000 });
    expect((await read()).map(row => row.id)).toEqual(["current.semantic", "current.creative"]);
    const headerQuery = calls.find(call => call.sql.includes("AS model_metadata"))!;
    expect(headerQuery.sql).not.toContain("SELECT model.model_json");
    for (const alias of ["model", "profile", "version", "receipt"]) expect(headerQuery.sql).toContain(`${alias}.information_label`);
    expect(headerQuery.sql).toContain("version.id=profile.source_version_id");
    expect(headerQuery.sql).toContain("receipt.id='source.language.compilation.'");
    const patternQuery = calls.at(-1)!;
    expect(patternQuery.sql.indexOf('current_compilation."compilationId"=pattern.source_compilation_id')).toBeGreaterThanOrEqual(0);
    expect(patternQuery.sql.indexOf('current_compilation."compilationId"=pattern.source_compilation_id')).toBeLessThan(patternQuery.sql.indexOf("ranked_pool AS"));
    expect(patternQuery.sql.indexOf('current_compilation."compilationId"=pattern.source_compilation_id')).toBeLessThan(patternQuery.sql.indexOf("running_stored_bytes"));
    expect(patternQuery.sql).toContain('current_compilation."sourceSystem"=pattern.source_system');
    expect(patternQuery.sql).toContain('current_compilation."sourceVersionId"=pattern.owned_source_version_id');
    const changedHeaders: typeof headers = [
      { ...header, source_id: "other.source" }, { ...header, source_version_id: "other.version" }, { ...header, content_hash: "other.hash" },
      { ...header, profile_id: "other.profile" }, { ...header, source_system: "other.system" }, { ...header, compilation_receipt: null },
      { ...header, id: "other.model" }, { ...header, stream_id: "other.stream" },
      { ...header, compilation_receipt: { ...(header.compilation_receipt as object), modelInventory: [] } },
      { ...header, model_metadata: { ...(header.model_metadata as object), sourceCompilation: { ...(header.model_metadata as { sourceCompilation: object }).sourceCompilation, compilationId: "tampered" } } },
      { ...header, compilation_receipt: { ...(header.compilation_receipt as object), sourceId: "other.source" } }
    ];
    for (const changed of changedHeaders) {
      headers = [changed];
      expect((await read()).map(row => row.id)).toEqual(["imported.standalone"]);
    }
    headers = [header, { ...header, source_id: "other.source" }];
    expect((await read()).map(row => row.id)).toEqual(["imported.standalone"]);
    headers = [header, header];
    expect((await read()).map(row => row.id)).toEqual(["imported.standalone"]);
    headers = [];
    expect((await read()).map(row => row.id)).toEqual(["imported.standalone"]);
    expect(patterns).toHaveLength(8);
  });
  it("filters exact compiler-owned receipt IDs before ranking or limiting historical rows", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ patternIds: ["receipt.current"], profileIds: ["profile.owned"],
      sourceSystem: "gutenberg", patternKind: "source_compilation", patternSchemas: ["scce.source_language_compilation_receipt.v1"], limit: 1 });
    const query = calls.at(-1)!;
    expect(query.sql).toContain("pattern.id=ANY($1::text[])");
    expect(query.params[0]).toEqual(["receipt.current"]);
    expect(query.sql.indexOf("pattern.id=ANY")).toBeLessThan(query.sql.indexOf("ranked_pool AS"));
    expect(query.sql).toContain("pattern.information_label");
    const count = calls.length;
    expect(await adapter.languageMemory.listLanguagePatterns({ patternIds: [] })).toEqual([]);
    expect(calls).toHaveLength(count);
  });
  it("projects nongenerative metadata and declared construction headers for an interpretation read", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ view: "request_seed", profileIds: ["profile.owned"], sourceSystem: "wikipedia", limit: 8 });
    expect(calls.at(-1)!.sql).toContain("jsonb_object_agg(seed_field.key,seed_field.value)");
    expect(calls.at(-1)!.sql).toContain("'requestConstructionCandidate'");
    expect(calls.at(-1)!.sql).toContain("'sourceConstructionCandidate'");
    expect(calls.at(-1)!.sql).toContain("jsonb_typeof(seed_role.value->'graphBinding')='object'");
    expect(calls.at(-1)!.sql).toContain("CASE WHEN pattern.pattern_schema='scce.request_requirement_pattern.v1'");
    expect(calls.at(-1)!.sql).toContain("THEN pattern.decoded_artifact_jsonb_bytes ELSE NULL::numeric END");
    expect(calls.at(-1)!.sql).not.toContain("ELSE pattern.pattern_json END AS pattern_json");
    expect(calls.at(-1)!.sql).not.toContain("running_stored_bytes");
    expect(calls.at(-1)!.sql).toContain("jsonb_build_object('templates','[]'::jsonb)");
    expect(calls.at(-1)!.sql).toContain("pattern.information_label");
    expect(calls.at(-1)!.sql).toContain("pattern.pattern_schema,pattern.id) IN (");
    expect(calls.at(-1)!.params).toContainEqual(["profile.owned"]);
    await adapter.languageMemory.listLanguagePatterns({ profileIds: ["profile.owned"], sourceSystem: "wikipedia", limit: 8 });
    expect(calls.at(-1)!.sql).not.toContain("pattern.pattern_json - ");
  });

  it("reads exact mixed-kind prerequisites without dropping required pages to category quotas", async () => {
    const { adapter, calls } = fixture();
    const patternIds = ["surface.construction.bundle.reply", ...Array.from({ length: 5 }, (_, index) => `surface.creative_event.bundle.${index}`)];
    await adapter.languageMemory.listLanguagePatterns({ patternIds, profileId: "profile.owned", limit: patternIds.length, maxTotalJsonBytes: 32 * 1024 * 1024 });
    const call = calls.at(-1)!;
    expect(call.params).toContainEqual(patternIds);
    expect(call.sql).toContain("pattern.id=ANY(");
    expect(call.sql).not.toContain("ranked.category_rank <= CEIL");
    expect(call.sql).not.toContain("SUM(candidate.stored_bytes) OVER (PARTITION BY");
    expect(call.sql).not.toContain("SUM(octet_length(eligible.pattern_json::text)) OVER (PARTITION BY");
    expect(call.sql).toContain("running_json_bytes <=");
    expect(call.sql).not.toContain("OR ranked.category_relevance_rank = 1");
    expect(call.sql).not.toContain("OR sized.category_relevance_rank = 1");
    expect(call.sql).toContain("current_compilation");
    expect(call.sql).toContain("pattern.information_label");
    expect(call.sql).toContain("SELECT profile_id,source_system,pattern_schema,pattern_id,projection_recipe FROM active_projection_ids_0");
    expect(call.sql).not.toContain("WHERE (pattern.component_recipe=");
  });

  it("keeps archival segmentation witnesses out of searches and request seeds but admits a 64MiB exact audit read", async () => {
    const { adapter, calls } = fixture();
    const archiveGate = `(pattern.pattern_schema IS DISTINCT FROM '${SOURCE_SEGMENTATION_WITNESS_SCHEMA}' AND pattern.pattern_schema IS DISTINCT FROM '${LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA}')`;

    await adapter.languageMemory.listLanguagePatterns({ profileId: "profile.owned", limit: 8 });
    expect(calls.at(-1)!.sql).toContain(archiveGate);

    await adapter.languageMemory.listLanguagePatterns({ view: "request_seed", patternIds: ["segmentation.source.owned"], limit: 1 });
    expect(calls.at(-1)!.sql).toContain(archiveGate);

    await adapter.languageMemory.listLanguagePatterns({ patternIds: ["segmentation.source.owned", "segmentation.manifest.owned"],
      limit: 2, maxTotalJsonBytes: 64 * 1024 * 1024, requireComplete: true });
    const exact = calls.at(-1)!;
    expect(exact.sql).not.toContain(archiveGate);
    expect(exact.sql).toContain("pattern.id=ANY($1::text[])");
    expect(exact.params[0]).toEqual(["segmentation.source.owned", "segmentation.manifest.owned"]);
    expect(exact.params).toContain(64 * 1024 * 1024);
    expect(exact.sql).not.toContain("OR ranked.category_relevance_rank = 1");
    expect(exact.sql).not.toContain("OR sized.category_relevance_rank = 1");
  });

  it("keeps schema-less active language rows readable while applying null-safe archive and retired-syntax gates", async () => {
    const { adapter, calls } = fixture();
    const informationLabel = { tenantId: "tenant.fixture", principals: [], compartments: [], exportClass: "public", mergePolicy: "isolated" };
    const rows = ["cadence", "morphology", "segmentation", "semantic_role", "syntax"].map((pattern_kind, index) => ({
      id: `language.active.schema-less.${pattern_kind}`,
      profile_id: "profile.schema-less",
      pattern_kind,
      support: String(5 - index),
      entropy: "0",
      pattern_json: { learned: true, patternKind: pattern_kind },
      evidence_ids: [],
      updated_at: new Date(index + 1),
      information_label: informationLabel
    }));
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      return (sql.includes("candidate_pool AS MATERIALIZED") ? rows : []) as T[];
    };

    const result = await adapter.languageMemory.listLanguagePatterns({ profileId: "profile.schema-less", limit: rows.length });
    expect(result.map(row => row.id)).toEqual(rows.map(row => row.id));
    const sql = calls.at(-1)!.sql;
    expect(sql).toContain(`pattern.pattern_schema IS DISTINCT FROM '${SOURCE_SEGMENTATION_WITNESS_SCHEMA}'`);
    expect(sql).toContain(`pattern.pattern_schema IS DISTINCT FROM '${LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA}'`);
    expect(sql).toContain("pattern.pattern_schema IS NULL");
    expect(sql).not.toContain("pattern.pattern_schema NOT IN");
  });

  it("returns archival exact-ID rows only after proving every requested ID survived ownership and bounds", async () => {
    const { adapter, calls } = fixture();
    const informationLabel = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
    const rows = [SOURCE_SEGMENTATION_WITNESS_SCHEMA, LANGUAGE_SEGMENTATION_WITNESS_MANIFEST_PATTERN_SCHEMA].map((schema, index) => ({
      id: `segmentation.archive.${index}`,
      profile_id: "profile.owned",
      pattern_kind: "semantic_role",
      support: "1",
      entropy: "0",
      pattern_json: { schema, id: `segmentation.archive.${index}`, compact: true },
      evidence_ids: [],
      updated_at: new Date(1),
      information_label: informationLabel
    }));
    let complete = false;
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      if (sql.startsWith("SELECT DISTINCT pattern.profile_id,pattern.source_system")) {
        return [{ profile_id: "profile.owned", source_system: "fixture" }] as T[];
      }
      if (sql.includes("candidate_pool AS MATERIALIZED")) return (complete ? rows : rows.slice(0, 1)) as T[];
      return [];
    };
    const query = { patternIds: rows.map(row => row.id), limit: rows.length,
      maxTotalJsonBytes: 64 * 1024 * 1024, requireComplete: true };
    expect(await adapter.languageMemory.listLanguagePatterns(query)).toEqual([]);
    complete = true;
    expect((await adapter.languageMemory.listLanguagePatterns(query)).map(row => row.id)).toEqual(rows.map(row => row.id));
  });
  it("reads exact accessible projection receipts and validates their owned compilation inventory including empty results", async () => {
    const { adapter, calls } = fixture();
    const informationLabel = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
    const query = { profileId: "profile.owned", sourceId: "source.owned" as never, sourceVersionId: "version.owned" as SourceVersionId,
      sourceSystem: "workspace", patternSchema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, componentRecipe: LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID,
      informationLabel, sourceCompilationId: "compile.owned" };
    let patternIds = ["construction.owned"];
    let inventory = [...patternIds];
    let manifest: Record<string, unknown> = { schema: "scce.language_pattern_active_projection.v1", ...query, patternIds };
    adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push({ sql, params });
      return (sql.includes("storage_meta") ? [{ value_json: manifest }] : inventory.map(id => ({ id }))) as T[];
    };
    expect((await adapter.languageMemory.getLanguagePatternProjection!(query))?.patternIds).toEqual(patternIds);
    expect(calls.at(-1)!.sql).toContain("sourceCompilationId");
    expect(calls.at(-1)!.sql).toContain("pattern.information_label");
    inventory = [];
    expect(await adapter.languageMemory.getLanguagePatternProjection!(query)).toBeUndefined();
    patternIds = [];
    manifest = { ...manifest, patternIds };
    expect((await adapter.languageMemory.getLanguagePatternProjection!(query))?.patternIds).toEqual([]);
    for (const change of [{ profileId: "profile.other" }, { sourceId: "source.other" }, { sourceVersionId: "version.other" },
      { sourceSystem: "other" }, { componentRecipe: "retired.recipe" }, { informationLabel: { ...informationLabel, tenantId: "other" } }]) {
      const original = manifest;
      manifest = { ...manifest, ...change };
      expect(await adapter.languageMemory.getLanguagePatternProjection!(query)).toBeUndefined();
      manifest = original;
    }
    expect(await adapter.languageMemory.getLanguagePatternProjection!({ ...query, informationLabel: { ...informationLabel, tenantId: "other" } })).toBeUndefined();
  });
  it("resolves a held source version by exact identity under information access", async () => {
    const { adapter, calls } = fixture();
    expect(await adapter.evidence.sourceVersionById?.("source-version.held" as SourceVersionId)).toBeNull();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toContain("WHERE sv.id=$1 AND");
    expect(calls[0]!.sql).toContain("sv.information_label");
    expect(calls[0]!.params[0]).toBe("source-version.held");
  });

  it("publishes the exact callable learning result, including empty recompiles, before retrieval budgets", async () => {
    const { adapter, calls } = fixture();
    adapter.transaction = async operation => operation();
    const informationLabel = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
    const pattern = { id: "source.code.function.pattern.current", profileId: "profile.owned", patternKind: "source_code_function" as const,
      support: 1, entropy: 0, patternJson: { schema: SOURCE_CODE_FUNCTION_PATTERN_SCHEMA, sourceSystem: "oss_code", sourceVersionId: "source-version.owned", formalLanguage: "python" }, evidenceIds: [], updatedAt: 2, informationLabel };
    const projection = { profileId: pattern.profileId, sourceId: "source.owned" as never, sourceVersionId: "source-version.owned" as SourceVersionId,
      sourceSystem: "oss_code", patternSchema: SOURCE_CODE_FUNCTION_PATTERN_SCHEMA, componentRecipe: SOURCE_CODE_FUNCTION_PROJECTION_RECIPE_ID,
      patternIds: [pattern.id], informationLabel };
    await adapter.languageMemory.replaceLanguagePatternProjection?.({ patterns: [pattern], projection });
    await adapter.languageMemory.replaceLanguagePatternProjection?.({ patterns: [], projection: { ...projection, profileId: "profile.recompiled", sourceVersionId: "version.recompiled" as SourceVersionId, patternIds: [] } });
    const writes = calls.filter(call => call.sql.includes('INSERT INTO "fixture"."storage_meta"'));
    expect(writes).toHaveLength(2);
    expect(writes[0]!.params[0]).toBe(writes[1]!.params[0]);
    expect(writes[1]!.params[1]).toContain('"patternIds":[]');
    expect(calls.some(call => /DELETE FROM/u.test(call.sql))).toBe(false);
    calls.length = 0;
    await adapter.languageMemory.listLanguagePatterns({ sourceSystem: "oss_code", patternKind: "source_code_function", formalLanguage: "python", limit: 1 });
    const query = calls.at(-1)!;
    expect(query.params).toContain(SOURCE_CODE_FUNCTION_PATTERN_SCHEMA);
    expect(query.params).toContain(SOURCE_CODE_FUNCTION_PROJECTION_RECIPE_ID);
    expect(query.sql.indexOf("pattern.pattern_schema,pattern.id) IN (")).toBeGreaterThanOrEqual(0);
    expect(query.sql.indexOf("pattern.pattern_schema,pattern.id) IN (")).toBeLessThan(query.sql.indexOf("ranked_pool AS"));
  });
  it("requires active publication for source-owned test contracts before spending retrieval budgets", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ sourceSystem: "oss_code", patternKind: "source_code_assertion_contract", limit: 1 });
    const query = calls.at(-1)!;
    expect(query.params).toContain("scce.source_owned_test_contract.v1");
    expect(query.params).toContain("scce.source_owned_test_contract_projection.v1");
    expect(query.sql.indexOf("pattern.pattern_schema,pattern.id) IN (")).toBeGreaterThanOrEqual(0);
    expect(query.sql.indexOf("pattern.pattern_schema,pattern.id) IN (")).toBeLessThan(query.sql.indexOf("ranked_pool AS"));
  });
  it("preserves original compilation membership on construction-only pattern updates", async () => {
    const { adapter, calls } = fixture();
    adapter.transaction = async operation => operation();
    await adapter.languageMemory.putLanguagePattern({ id: "surface.construction.bundle.owned", profileId: "profile.owned", patternKind: "syntax", support: 1, entropy: 0,
      patternJson: { schema: "construction.fixture" }, evidenceIds: [], updatedAt: 2,
      informationLabel: { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" } });
    const insertion = calls.find(call => call.sql.includes('INSERT INTO "fixture"."language_patterns"'));
    expect(insertion?.sql).toContain("jsonb_build_object('sourceCompilationId',lp.pattern_json->'sourceCompilationId')");
    expect(insertion?.sql).toContain("|| EXCLUDED.pattern_json");
  });

  it("keeps compilation metadata out of language hydration and pages only artifact IDs", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ profileId: "profile.owned" });
    expect(calls.at(-1)?.sql).toContain("pattern.pattern_kind<>'source_compilation'");
    await adapter.languageMemory.listLanguagePatterns({ profileId: "profile.owned", patternKind: "source_compilation", limit: 2 });
    expect(calls.at(-1)?.params).toContain("source_compilation");
    await adapter.languageMemory.listSourceCompilationArtifactIds?.({ profileId: "profile.owned", compilationId: "compile.owned", family: "patterns", afterId: "pattern.before", limit: 256 });
    expect(calls.at(-1)?.sql).toContain("SELECT artifact.id FROM");
    expect(calls.at(-1)?.sql).toContain("sourceCompilationId");
    expect(calls.at(-1)?.sql).not.toContain("SELECT artifact.*");
    expect(calls.at(-1)?.params).toContain("pattern.before");
    expect(calls.at(-1)?.params.at(-1)).toBe(256);
  });

  it("preserves immutable source metadata when a canonical model is recompiled by another producer", async () => {
    const { adapter, calls } = fixture();
    adapter.transaction = async operation => operation();
    await adapter.languageMemory.putNgramModel({ id: "ngram.canonical", streamId: "source.language.training.canonical", languageHint: "und", maxOrder: 3, discount: 0.75,
      modelJson: { profileId: "profile.owned", sourceVersionId: "source.owned", sourceSystem: "oss_code", model: { observedSymbolCount: 8 } }, updatedAt: 2,
      informationLabel: { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" } });
    const insertion = calls.find(call => call.sql.includes('INSERT INTO "fixture"."ngram_models"'));
    expect(insertion?.sql).toContain("AS n(id,stream_id");
    expect(insertion?.sql).toContain("model_json=EXCLUDED.model_json");
    expect(calls.some(call=>call.sql.includes("model_json AS value,information_label") && call.sql.includes("FOR UPDATE"))).toBe(true);
    expect(insertion?.sql).toContain("information_label=EXCLUDED.information_label");
  });

  it("filters compact source functions by declared language and arity before spending any row or byte budget", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ sourceSystem: "oss_code", patternKind: "source_code_function", formalLanguage: "typescript", parameterCount: 0, limit: 500, maxTotalJsonBytes: 1_000_000 });
    const call = calls.at(-1)!;
    expect(call.params).toContain("source_code_function");
    expect(call.params).toContain("typescript");
    expect(call.params).toContain("0");
    expect(call.sql.indexOf("pattern.pattern_kind=")).toBeLessThan(call.sql.indexOf("ranked_pool AS"));
    expect(call.sql.indexOf("pattern.pattern_json->>'formalLanguage'=")).toBeLessThan(call.sql.indexOf("ranked_pool AS"));
    expect(call.sql.indexOf("pattern.pattern_json->>'parameterCount'=")).toBeLessThan(call.sql.indexOf("ranked_pool AS"));
    expect(call.sql).toContain("pattern.source_system=");
    await expect(adapter.languageMemory.listLanguagePatterns({ parameterCount: -1 })).rejects.toThrow("non-negative integer");
    const index = schemaStatements('"fixture"').find(sql => sql.includes("_source_code_function_lookup"));
    expect(index).toContain("WHERE pattern_kind='source_code_function'");
    expect(index).toContain("source_system,(pattern_json->>'formalLanguage'),(pattern_json->>'parameterCount')");
  });

  it("filters requested pattern schemas in the candidate pool before any row limit is applied", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({
      sourceSystem: "source.dialogue",
      patternSchemas: ["scce.request_requirement_pattern.v1", "scce.creative_event_compatibility_model.v1"],
      limit: 2048
    });
    const call = calls.at(-1)!;
    const filter = call.sql.indexOf("pattern.pattern_schema=ANY(");
    expect(filter).toBeGreaterThanOrEqual(0);
    expect(filter).toBeLessThan(call.sql.indexOf("ranked_pool AS"));
    expect(filter).toBeLessThan(call.sql.lastIndexOf("LIMIT"));
    expect(call.params).toContainEqual(["scce.request_requirement_pattern.v1", "scce.creative_event_compatibility_model.v1"]);
  });

  it("filters historical construction bundles through the active source projection before row limits", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ profileId: "profile.owned", sourceSystem: "wikipedia", limit: 32 });
    const call = calls.at(-1)!;
    const activeFilter = call.sql.indexOf("pattern.pattern_schema,pattern.id) IN (");
    expect(activeFilter).toBeGreaterThanOrEqual(0);
    expect(activeFilter).toBeLessThan(call.sql.indexOf("ranked_pool AS"));
    expect(activeFilter).toBeLessThan(call.sql.lastIndexOf("LIMIT"));
    expect(call.sql).toContain("pattern.pattern_schema IS DISTINCT FROM");
    expect(call.sql).toContain("SELECT profile_id,source_system,pattern_schema,pattern_id,projection_recipe FROM active_projection_ids_0");
    expect(call.sql).not.toContain("WHERE (pattern.component_recipe=");
    expect(call.sql).toContain("active_projection.information_label->>'tenantId'");
    expect(call.params).toContain(LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA);
    expect(call.params).toContain(LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID);
  });

  it("expands each accessible active projection once before matching exact source-owned pattern IDs", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ profileId: "profile.large-transcript", limit: 2048, maxTotalJsonBytes: 64_000_000 });
    const sql = calls.at(-1)!.sql;
    expect(sql.match(/active_projection_ids_\d+ AS MATERIALIZED/gu)).toHaveLength(10);
    expect(sql.match(/active_projection_ids_\d+_headers AS MATERIALIZED/gu)).toHaveLength(10);
    expect(sql.match(/END\) member\(pattern_id\)/gu)).toHaveLength(10);
    for (const [offset, schema] of [
      "scce.induced_language_model.morphology_memory.v1",
      INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA,
      "scce.induced_language_model.semantic_memory.v1",
      "scce.induced_language_model.translation_seed_memory.v1"
    ].entries()) {
      const header = sql.slice(sql.indexOf(`active_projection_ids_${offset + 6}_headers AS MATERIALIZED`),
        sql.indexOf(`active_projection_ids_${offset + 6} AS MATERIALIZED`));
      const schemaParameter = header.match(/active_projection\.value_json->>'patternSchema'=\$(\d+)/u);
      const recipeParameter = header.match(/active_projection\.value_json->>'componentRecipe'=\$(\d+)/u);
      expect(schemaParameter).not.toBeNull();
      expect(recipeParameter).not.toBeNull();
      expect(calls.at(-1)!.params[Number(schemaParameter![1]) - 1]).toBe(schema);
      expect(calls.at(-1)!.params[Number(recipeParameter![1]) - 1]).toBe(INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID);
    }
    expect(calls.at(-1)!.params).toContain(SOURCE_COMPUTATION_CONSTRUCTION_SCHEMA);
    const computationRecipeParameter = calls.at(-1)!.params.indexOf(SOURCE_COMPUTATION_CONSTRUCTION_RECIPE) + 1;
    expect(computationRecipeParameter).toBeGreaterThan(0);
    const computationHeader = sql.slice(sql.indexOf("active_projection_ids_5_headers AS MATERIALIZED"), sql.indexOf("active_projection_ids_5 AS MATERIALIZED"));
    expect(computationHeader).toContain(`active_projection.value_json->>'componentRecipe'=$${computationRecipeParameter}`);
    expect(computationHeader).toContain("auxiliary_owner.source_id=active_projection.value_json->>'sourceId'");
    expect(computationHeader).toContain("dependency_evidence.status='promoted'");
    expect(computationHeader).toContain("AS source_version_id");
    expect(sql).toContain("computation_member.evidence_ids <@ header.dependency_evidence_ids");
    expect(sql).toContain("SELECT header.profile_id,header.source_system,header.pattern_schema,header.projection_recipe,member.pattern_id");
    expect(sql).not.toContain("active_projection.value_json->'patternIds' ? pattern.id");
    expect(sql).toContain("pattern.profile_id,pattern.source_system,pattern.pattern_schema,pattern.id");
    expect(sql).toContain("active_projection.information_label->>'tenantId'");
    expect(sql.indexOf("pattern.id) IN (")).toBeLessThan(sql.indexOf("ranked_pool AS"));
    expect(sql.indexOf("pattern.id) IN (")).toBeLessThan(sql.indexOf("running_json_bytes"));
  });

  it("makes retired full-witness syntax generations inert without a no-current-row fallback", async () => {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ profileId: "profile.owned", maxTotalJsonBytes: 64_000_000, limit: 2048 });
    const call = calls.at(-1)!;
    const syntaxGate = call.sql.indexOf("pattern.pattern_schema IS NULL");
    expect(syntaxGate).toBeGreaterThanOrEqual(0);
    expect(syntaxGate).toBeLessThan(call.sql.indexOf("ranked_pool AS"));
    expect(syntaxGate).toBeLessThan(call.sql.indexOf("candidates AS MATERIALIZED"));
    expect(syntaxGate).toBeLessThan(call.sql.lastIndexOf("LIMIT"));
    expect(call.sql).not.toContain("active_syntax");
    expect(call.sql).toContain("OR NOT starts_with(pattern.pattern_schema,'scce.induced_language_model.syntax_memory.')");
    expect(call.sql).toContain("OR (pattern.pattern_schema=$");
    expect(call.sql).toContain("AND pattern.component_recipe=$");
    expect(call.params).toContain(INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA);
    expect(call.params).toContain(INDUCED_LANGUAGE_MEMORY_COMPONENT_RECIPE_ID);
  });

  it("atomically publishes active construction IDs, including an empty replacement, without deleting history", async () => {
    const { adapter, calls } = fixture();
    adapter.transaction = async operation => operation();
    const informationLabel = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
    const previous = { id: "surface.construction.bundle.previous", profileId: "profile.owned", patternKind: "semantic_role" as const,
      support: 1, entropy: 0, patternJson: { schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, sourceSystem: "wikipedia" }, evidenceIds: [], updatedAt: 2, informationLabel };
    const projection = { profileId: "profile.owned", sourceId: "source.owned" as never, sourceVersionId: "source-version.owned" as SourceVersionId,
      sourceSystem: "wikipedia", patternSchema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, componentRecipe: LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID,
      patternIds: [previous.id], informationLabel };
    await adapter.languageMemory.replaceLanguagePatternProjection?.({ patterns: [previous], projection });
    const patternWrite = calls.findIndex(call => call.sql.includes('INSERT INTO "fixture"."language_patterns"'));
    const firstActiveWrite = calls.findIndex(call => call.sql.includes('INSERT INTO "fixture"."storage_meta"'));
    expect(patternWrite).toBeGreaterThanOrEqual(0);
    expect(firstActiveWrite).toBeGreaterThan(patternWrite);
    expect(calls[firstActiveWrite]!.params[0]).toContain("source.owned");
    expect(calls[firstActiveWrite]!.params[1]).toContain(previous.id);

    const current = { ...previous, id: "surface.construction.bundle.current", updatedAt: 3 };
    await adapter.languageMemory.replaceLanguagePatternProjection?.({ patterns: [current], projection: { ...projection, sourceVersionId: "source-version.current" as SourceVersionId, patternIds: [current.id] } });
    const activeWrites = calls.filter(call => call.sql.includes('INSERT INTO "fixture"."storage_meta"'));
    expect(activeWrites).toHaveLength(2);
    expect(activeWrites[0]!.params[0]).toBe(activeWrites[1]!.params[0]);
    expect(activeWrites[1]!.params[1]).toContain(current.id);
    expect(activeWrites[1]!.params[1]).not.toContain(previous.id);
    await adapter.languageMemory.replaceLanguagePatternProjection?.({ patterns: [current], projection: { ...projection,
      sourceVersionId: "source-version.current" as SourceVersionId, patternIds: [current.id] } });
    const replayWrites = calls.filter(call => call.sql.includes('INSERT INTO "fixture"."storage_meta"'));
    expect(replayWrites).toHaveLength(3);
    expect(replayWrites[2]!.params[0]).toBe(replayWrites[1]!.params[0]);
    expect(replayWrites[2]!.params[1]).toBe(replayWrites[1]!.params[1]);
    expect(replayWrites[2]!.sql).toContain("WHERE metadata.value_json IS DISTINCT FROM EXCLUDED.value_json");
    const otherSource = { ...previous, id: "surface.construction.bundle.other-source" };
    await adapter.languageMemory.replaceLanguagePatternProjection?.({ patterns: [otherSource], projection: { ...projection,
      sourceId: "source.other" as never, sourceVersionId: "source-version.other" as SourceVersionId, patternIds: [otherSource.id] } });
    const scopedWrites = calls.filter(call => call.sql.includes('INSERT INTO "fixture"."storage_meta"'));
    expect(scopedWrites).toHaveLength(4);
    expect(scopedWrites[3]!.params[0]).not.toBe(scopedWrites[1]!.params[0]);
    expect(scopedWrites[3]!.params[1]).toContain(otherSource.id);
    expect(calls.some(call => /DELETE FROM "fixture"\."language_patterns"/u.test(call.sql))).toBe(false);

    calls.length = 0;
    await adapter.languageMemory.replaceLanguagePatternProjection?.({ patterns: [], projection: { ...projection, sourceVersionId: "source-version.current" as SourceVersionId, patternIds: [] } });
    const emptyManifest = calls.find(call => call.sql.includes('INSERT INTO "fixture"."storage_meta"'));
    expect(emptyManifest?.params[1]).toContain('"patternIds":[]');
    expect(calls.some(call => /DELETE FROM "fixture"\."language_patterns"/u.test(call.sql))).toBe(false);
  });
  it("filters plural profile ownership before unit and pattern limits", async () => {
    const { adapter, calls } = fixture();

    await adapter.languageMemory.listLanguageUnits({ profileIds: ["profile.a", "profile.b"], sourceSystem: "fixture", limit: 5 });
    await adapter.languageMemory.listLanguagePatterns({ profileIds: ["profile.a", "profile.b"], sourceSystem: "fixture", limit: 5 });

    expect(calls[0]?.sql).toContain("profile_id=ANY($1::text[])");
    expect(calls[0]?.sql.indexOf("profile_id=ANY")).toBeLessThan(calls[0]!.sql.indexOf("LIMIT"));
    expect(calls[0]?.params[0]).toEqual(["profile.a", "profile.b"]);
    expect(calls.at(-1)?.sql).toContain("profile_id=ANY($1::text[])");
    expect(calls.at(-1)?.sql.indexOf("profile_id=ANY")).toBeLessThan(calls.at(-1)!.sql.indexOf("LIMIT"));
  });

  it("supersedes stale request-requirement rows in one source scope before storing fresh target/range patterns", async () => {
    const { adapter, calls } = fixture();
    adapter.transaction = async operation => operation();
    const pattern = {
      id: "request_requirement_pattern.fixture.nava-sula",
      profileId: "profile.fixture",
      patternKind: "semantic_role" as const,
      support: 0.9,
      entropy: 0.1,
      patternJson: {
        schema: "scce.request_requirement_pattern.v1",
        compilerFingerprint: "scce.request_requirement_pattern.targets_and_ranges.v1",
        sourceVersionId: "source-version.fixture",
        sourceSystem: "corrections",
        surface: "nava sula",
        requirementTargets: { brevityDetailBalance: 0.92 },
        requirementTargetBounds: { brevityDetailBalance: { lower: 0.92, upper: 0.92 } }
      },
      evidenceIds: [],
      updatedAt: 1,
      informationLabel: {
        tenantId: "tenant.fixture",
        principals: ["principal.fixture"],
        compartments: [],
        exportClass: "restricted" as const,
        mergePolicy: "isolated" as const
      }
    };

    await adapter.languageMemory.replaceRequestRequirementPatterns?.({
      profileId: pattern.profileId,
      sourceVersionId: "source-version.fixture" as SourceVersionId,
      sourceSystem: "corrections",
      schema: "scce.request_requirement_pattern.v1",
      compilerFingerprint: "scce.request_requirement_pattern.targets_and_ranges.v1",
      patterns: [pattern]
    });

    const deletion = calls.find(call => call.sql.includes("DELETE FROM \"fixture\".\"language_patterns\""));
    const insertion = calls.find(call => call.sql.includes("INSERT INTO \"fixture\".\"language_patterns\""));
    expect(deletion).toBeDefined();
    expect(deletion?.sql).toContain("pattern.pattern_json->>'schema'=$2");
    expect(deletion?.sql).toContain("pattern.pattern_json->>'sourceVersionId'=$3");
    expect(deletion?.sql).toContain("pattern.pattern_json->>'sourceSystem'=$4");
    expect(deletion?.params.slice(0, 4)).toEqual([
      "profile.fixture",
      "scce.request_requirement_pattern.v1",
      "source-version.fixture",
      "corrections"
    ]);
    expect(insertion).toBeDefined();
    expect(calls.indexOf(deletion!)).toBeLessThan(calls.indexOf(insertion!));
    expect(JSON.stringify(insertion?.params)).toContain("requirementTargets");
    expect(JSON.stringify(insertion?.params)).toContain("0.92");
  });

  it("requires exact profile ownership for model and observation reads", async () => {
    const { adapter, calls } = fixture();

    await adapter.languageMemory.listNgramModels({ profileIds: ["profile.a"], limit: 7 });
    await adapter.languageMemory.listNgramObservations({ profileIds: ["profile.a"], limit: 7 });

    // Models use the stored key; observations use the migration's matching indexed metadata expression.
    const modelSql = calls[0]!.sql;
    expect(modelSql).toContain("model.profile_id=ANY($1::text[])");
    expect(modelSql).not.toMatch(/\bmodel\.model_json\s*->>?\s*'(?:profileId|sourceVersionId)'/u);
    expect(modelSql).not.toMatch(/\bOR\s*\(*\s*model\.(?:profile_id|model_json)/u);
    expect(modelSql.indexOf("model.profile_id=ANY($1::text[])"))
      .toBeLessThan(modelSql.indexOf("model_profile.id=model.profile_id"));
    expect(modelSql).toContain("model_profile.profile_json->'pooledSourceBinding'");
    expect(modelSql).toContain("pooled_parent.id=owned.value->>'sourceVersionId'");
    expect(modelSql).toContain("pooled_evidence.status='promoted'");
    expect(modelSql).toContain("pooled_newer.source_id=pooled_parent.source_id");
    expect(calls[0]?.params[0]).toEqual(["profile.a"]);
    expect(calls[0]?.params.at(-1)).toBe(7);
    expect(calls[1]?.sql).toContain("FROM unnest($5::text[]) AS owner(owner_id)");
    const observationSql = calls[1]!.sql;
    expect(observationSql).toContain("observation.metadata_json->>'profileId'=owner.owner_id");
    expect(observationSql.indexOf("observation.metadata_json->>'profileId'=owner.owner_id"))
      .toBeLessThan(observationSql.indexOf("ORDER BY observation.count"));
    expect(observationSql).not.toMatch(/\bOR\s*\(*\s*observation\.(?:metadata_json|profile_id)/u);
    expect(observationSql).not.toMatch(/sourceVersionId|source_version_id/u);
    expect(schemaStatements('"fixture"')).toContain('CREATE INDEX IF NOT EXISTS idx_fixture_ngram_profile_rank ON "fixture".ngram_observations((metadata_json->>\'profileId\'),count DESC,observed_at DESC)');
    expect(calls[1]?.params[4]).toEqual(["profile.a"]);
    expect(calls[1]?.params.at(-1)).toBe(7);
    expect(calls).toHaveLength(2);
  });

  it("enforces the cumulative JSON byte budget in relevance order for model and unit reads", async () => {
    const { adapter, calls } = fixture();

    await adapter.languageMemory.listNgramModels({ limit: 12, maxTotalJsonBytes: 64 * 1024 * 1024 });
    await adapter.languageMemory.listLanguageUnits({ limit: 40, maxTotalJsonBytes: 24 * 1024 * 1024 });

    // Count limits stopped bounding memory once whole-novel training grew
    // single model_json blobs to tens of MB (a 4GB server heap OOMed at
    // warmup, verified live). Records are admitted until the byte budget is
    // exhausted, in the SAME relevance order as the count limit, and the top
    // record always loads so an undersized budget degrades to one record
    // instead of zero. The two tests below hold the budget quantity itself.
    const modelSql = calls[0]!.sql;
    // trained_mass is a stored generated column now (carries the exact COALESCE the code used to evaluate).
    expect(modelSql).toContain("ORDER BY model.trained_mass DESC, model.updated_at DESC, model.id ASC");
    const unitSql = calls[1]!.sql;
    expect(unitSql).toContain("SUM((CASE WHEN unit.metadata_json");
    expect(unitSql).toContain("decodedJsonbBytes");
    expect(unitSql).toContain("ELSE octet_length(unit.metadata_json::text) END) + octet_length(unit.unit_text)) OVER (ORDER BY unit.alpha DESC, unit.id ASC");
    expect(unitSql).toContain("running_json_bytes <=");
    expect(calls[1]?.params.at(-1)).toBe(24 * 1024 * 1024);

    // Without a budget the classic count-limited query is byte-identical
    // to the previous contract.
    await adapter.languageMemory.listNgramModels({ limit: 12 });
    expect(calls[2]?.sql).not.toContain("running_json_bytes");
  });

  // The budget bounds the bytes this process hydrates, so the deciding quantity is the uncompressed JSON text
  // length; pg_column_size reports compressed, possibly-TOASTed storage and under-counts the heap it must bound.
  it("bounds the budget by uncompressed JSON text length, not by compressed storage size", async () => {
    clearResidentNgramModelJson();
    const { adapter } = modelFixture([
      { id: "model.a", storedBytes: 100, jsonBytes: 400 },
      { id: "model.b", storedBytes: 100, jsonBytes: 400 },
      { id: "model.c", storedBytes: 100, jsonBytes: 400 }
    ]);

    // Every record fits three times over weighed by stored size (300 of 1000) and the third does not fit weighed
    // by JSON text (1200 of 1000), so the returned prefix names which quantity decided.
    const admitted = await adapter.languageMemory.listNgramModels({ limit: 12, maxTotalJsonBytes: 1000 });
    expect(admitted.map(model => model.id)).toEqual(["model.a", "model.b"]);
  });

  it("admits the top record when the budget is smaller than it, rather than returning nothing", async () => {
    clearResidentNgramModelJson();
    const { adapter } = modelFixture([
      { id: "model.solo.a", storedBytes: 100, jsonBytes: 400 },
      { id: "model.solo.b", storedBytes: 100, jsonBytes: 400 }
    ]);

    const admitted = await adapter.languageMemory.listNgramModels({ limit: 12, maxTotalJsonBytes: 100 });
    expect(admitted.map(model => model.id)).toEqual(["model.solo.a"]);
  });

  it("requires exact profile ownership for semantic-frame reads", async () => {
    const { adapter, calls } = fixture();

    await adapter.languageMemory.listSemanticFrames({
      profileIds: ["profile.a"],
      sourceSystem: "fixture",
      limit: 9
    });

    const sql = calls[0]!.sql;
    expect(sql).toContain("frame_json->>'profileId'=ANY");
    expect(sql).not.toContain("sourceVersionId");
    expect(sql.indexOf("profileId")).toBeLessThan(sql.indexOf("LIMIT"));
    expect(calls[0]?.params[0]).toBe("fixture");
    expect(calls[0]?.params[1]).toEqual(["profile.a"]);
    expect(calls[0]?.params.at(-1)).toBe(9);
  });

  it("filters exact semantic-frame surfaces before the matching rank limit", async () => {
    const { adapter, calls } = fixture();

    await adapter.languageMemory.listSemanticFrames({ surface: "surface.fixture", limit: 11 });

    const sql = calls[0]!.sql;
    expect(sql).toContain("frame_json->>'surface'=$1");
    expect(sql).toContain("frame.normalized_surface_hash=$2");
    expect(sql).toContain("ORDER BY alpha DESC, created_at DESC, id ASC LIMIT $7");
    expect(sql.indexOf("frame_json->>'surface'=$1")).toBeLessThan(sql.indexOf("ORDER BY"));
    expect(calls[0]?.params[0]).toBe("surface.fixture");
    expect(calls[0]?.params[1]).toBe(createHasher().digestHex("surface.fixture"));
    expect(calls[0]?.params.at(-1)).toBe(11);
  });

  it("migrates an idempotent fixed-size surface hash index while retaining source-profile backfills", async () => {
    const { adapter } = fixture();
    const statements: string[] = [];
    const client = {
      async query(sql: string): Promise<{ rows: Array<Record<string, string>> }> {
        statements.push(sql);
        if (sql.includes("information_schema.tables")) {
          return { rows: POSTGRES_REQUIRED_TABLES.map(table_name => ({ table_name })) };
        }
        if (sql.includes("information_schema.columns")) {
          const identifiers = [...new Set(statements
            .filter(statement => statement.startsWith("CREATE TABLE") || statement.startsWith("ALTER TABLE"))
            .flatMap(statement => statement.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? []))];
          return {
            rows: POSTGRES_REQUIRED_TABLES.flatMap(table_name => identifiers.map(column_name => ({ table_name, column_name })))
          };
        }
        return { rows: [] };
      },
      release(): void {}
    };
    (adapter.pool as unknown as { connect: () => Promise<typeof client> }).connect = async () => client;

    await adapter.migrate();

    expect(statements.filter(statement => statement.includes("semantic_frames_surface_rank"))).toEqual([
      `DROP INDEX IF EXISTS "fixture".idx_fixture_semantic_frames_surface_rank`
    ]);
    expect(statements).toContain(`CREATE INDEX IF NOT EXISTS idx_fixture_semantic_frames_normalized_surface_hash_rank ON "fixture".semantic_frames(normalized_surface_hash,alpha DESC,created_at DESC,id ASC)`);
    expect(statements.some(statement =>
      statement.includes("UPDATE \"fixture\".language_profiles profile")
      && statement.includes("jsonb_array_elements(profile.profile_json->'charNgrams')")
    )).toBe(true);
  });

  it("bounds referenced profile discovery with index-backed semi-joins", async () => {
    const { adapter, calls } = fixture();

    await adapter.model.listLanguageProfiles({ limit: 17, referencedByLanguageMemory: true });

    const sql = calls[0]!.sql;
    expect(sql).toContain("EXISTS");
    expect(sql).toContain("profile_id=lp.id");
    // Four correlated index-backed probes stay EXISTS; the ngram_observations
    // probe is a recursive skip scan over the indexed profileId expression -- a
    // correlated EXISTS there seq-scanned the multi-GB
    // observations table once per candidate profile without observations.
    expect(sql.match(/OFFSET 0/g)).toHaveLength(4);
    expect(sql).toContain("WITH RECURSIVE obs_profiles");
    expect(sql).toContain("WHERE o.metadata_json->>'profileId' IS NOT NULL");
    expect(sql).toContain("WHERE o.metadata_json->>'profileId' > op.pid");
    expect(sql.match(/ORDER BY o\.metadata_json->>'profileId' LIMIT 1/g)).toHaveLength(2);
    expect(sql).not.toMatch(/\bo\.profile_id\b/u);
    expect(schemaStatements('"fixture"')).toContain('CREATE INDEX IF NOT EXISTS idx_fixture_ngram_profile_rank ON "fixture".ngram_observations((metadata_json->>\'profileId\'),count DESC,observed_at DESC)');
    expect(sql).not.toContain("EXISTS (SELECT 1 FROM \"fixture\".ngram_observations");
    expect(sql).toContain("LIMIT $1");
    expect(sql).not.toMatch(/artifact_refs|GROUP BY/i);
    expect(calls[0]?.params[0]).toBe(17);
  });

  it("ranks profile candidates from the indexed durable trigram set before applying the bound", async () => {
    const { adapter, calls } = fixture();

    await adapter.model.listLanguageProfiles({
      limit: 19,
      referencedByLanguageMemory: true,
      surfaceNgrams: ["QEL", "ela", "qel"]
    });

    // Found by content, not position: a one-off probe for the
    // referenced_by_language_memory column (tools/migrations) can
    // precede it. This test is about the profile query's shape.
    const call = calls.find(entry => entry.sql.includes("lp.ngram_keys"))!;
    expect(call).toBeDefined();
    const sql = call.sql;
    expect(sql).toContain("lp.ngram_keys && $1::text[]");
    expect(sql).toContain("FROM unnest(lp.ngram_keys)");
    expect(sql.indexOf("lp.ngram_keys &&")).toBeLessThan(sql.indexOf("LIMIT $2"));
    expect(call.params[0]).toEqual(["qel", "ela"]);
    expect(call.params[1]).toBe(19);
  });
});

/** Ranked ngram_models rows whose stored size and JSON text length differ, in the order the relevance query returns. */
function modelFixture(models: ReadonlyArray<{ id: string; storedBytes: number; jsonBytes: number }>): {
  adapter: PostgresStorageAdapter;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const { adapter, calls } = fixture();
  const label = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
  const updatedAt = new Date(1);
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.includes("pg_column_size(model.model_json) AS stored_bytes")) {
      return models.map(model => ({
        id: model.id,
        stream_id: "stream.fixture",
        language_hint: "script:Latn",
        max_order: 3,
        discount: "0.75",
        updated_at: updatedAt,
        information_label: label,
        stored_bytes: String(model.storedBytes)
      })) as unknown as T[];
    }
    if (sql.includes(" AS json_bytes") && sql.includes("model.model_json")) {
      const wanted = new Set((params[0] as string[] | undefined) ?? []);
      return models.filter(model => wanted.has(model.id)).map(model => ({
        id: model.id,
        updated_at: updatedAt,
        model_json: { profileId: "profile.fixture", model: { totalUnigramCount: 1 } },
        json_bytes: String(model.jsonBytes)
      })) as unknown as T[];
    }
    return [];
  };
  return { adapter, calls };
}

function compilationHeaderFixture(compilerRecipe: string = LANGUAGE_TRAINING_BATCH_RECIPE_ID, identityRecipe?: string): { id: string; stream_id: string; profile_id: string; source_system: string; source_id: string; source_version_id: string; content_hash: string; model_metadata: JsonValue; compilation_receipt: JsonValue } {
  const hasher = createHasher();
  const owner = { sourceId: "source.owned" as never, sourceVersionId: "version.owned" as SourceVersionId, contentHash: "sha256.owned" as never };
  const streamId = sourceLanguageTrainingStreamId({ ...owner, sourceSystem: "gutenberg", hasher, identityRecipe });
  const compiled = stampSourceLanguageCompilation({ owner, profileId: "profile.owned", sourceSystem: "gutenberg", streamId, text: "abc", chunks: ["abc"], hasher,
    models: [{ id: "model.owned", streamId, languageHint: "und", maxOrder: 2, discount: 0.75, updatedAt: 1,
      modelJson: { profileId: "profile.owned", sourceVersionId: owner.sourceVersionId, sourceSystem: "gutenberg", model: { totalUnigramCount: 3 } } }],
    options: { maxOrder: 2, maxCountersPerOrder: 64, vocabularyLimit: 64, languageOnly: false, retainNgramObservations: false },
    artifacts: { units: [], patterns: [], semanticFrames: [] } });
  const model = compiled.models[0]!.modelJson as Record<string, JsonValue>;
  const { compilationId: _oldId, chunk, modelDigest, ...common } = model.sourceCompilation as Record<string, JsonValue>;
  const header = { ...common, compilerRecipe };
  const compilationId = canonicalDigestHex(header, hasher);
  const receipt = (compiled.patterns[0]!.patternJson as { compilation: Record<string, JsonValue> }).compilation;
  return { id: compiled.models[0]!.id, stream_id: streamId, profile_id: "profile.owned", source_system: "gutenberg", source_id: owner.sourceId, source_version_id: owner.sourceVersionId, content_hash: owner.contentHash,
    model_metadata: { ...model, sourceCompilation: { ...header, compilationId, chunk: chunk!, modelDigest: modelDigest! } },
    compilation_receipt: { ...receipt, ...header, compilationId } };
}

function fixture(): {
  adapter: PostgresStorageAdapter;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const adapter = createPostgresStorageAdapter({
    url: "postgres://fixture:fixture@127.0.0.1/fixture",
    schema: "fixture",
    informationAccess: {
      tenantId: "tenant.fixture",
      principalId: "principal.fixture",
      compartments: [],
      maximumExportClass: "restricted"
    }
  });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    return [];
  };
  return { adapter, calls };
}
