// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { createHasher, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, stampSourceLanguageCompilation, type ContentHash, type JsonValue, type SourceId, type SourceVersionId } from "@scce/kernel";
import { sourceLanguageTrainingStreamId } from "../../../kernel/src/source-language-training-identity.js";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const label = { tenantId: "tenant.fixture", principals: ["principal.fixture"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
const hasher = createHasher();

function sourceOwner(profileId: string, sourceSystem: string, modelCount = 1) {
  const owner = { sourceId: `source.${profileId}.${sourceSystem}` as SourceId, sourceVersionId: `version.${profileId}.${sourceSystem}` as SourceVersionId,
    contentHash: `sha256_${hasher.digestHex(profileId + sourceSystem)}` as ContentHash };
  const streamId = sourceLanguageTrainingStreamId({ ...owner, sourceSystem, hasher });
  const chunks = Array.from({ length: modelCount }, (_, index) => `chunk${index}`);
  const models = chunks.map((text, index) => ({ id: `model.${profileId}.${sourceSystem}.${index}`, streamId, languageHint: "und", maxOrder: 2,
    discount: 0.75, updatedAt: 1, modelJson: { profileId, sourceSystem, sourceVersionId: owner.sourceVersionId, model: { totalUnigramCount: text.length } } }));
  const compiled = stampSourceLanguageCompilation({ owner, profileId, sourceSystem, streamId, text: chunks.join(""), chunks, hasher, models,
    options: { maxOrder: 2, maxCountersPerOrder: 64, vocabularyLimit: 64, languageOnly: false, retainNgramObservations: false },
    artifacts: { units: [], patterns: [], semanticFrames: [] } });
  const receipt = compiled.patterns.find(row => (row.patternJson as Record<string, JsonValue>).schema === "scce.source_language_compilation_receipt.v1")!;
  const compilation = (receipt.patternJson as Record<string, JsonValue>).compilation!;
  const compilationId = (compilation as Record<string, JsonValue>).compilationId as string;
  const headers = compiled.models.map(model => ({ id: model.id, stream_id: model.streamId, profile_id: profileId, source_system: sourceSystem,
    source_id: owner.sourceId, source_version_id: owner.sourceVersionId, content_hash: owner.contentHash,
    model_metadata: model.modelJson, compilation_receipt: compilation }));
  const pattern = { id: `surface.construction.bundle.${profileId}.${sourceSystem}`, profile_id: profileId, source_system: sourceSystem,
    pattern_kind: "semantic_role", support: "1", entropy: "0", evidence_ids: [], updated_at: new Date(1), information_label: label,
    pattern_json: { schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, sourceSystem, sourceVersionId: owner.sourceVersionId, sourceCompilationId: compilationId } };
  return { profileId, sourceSystem, headers, pattern, patternIds: [pattern.id], accessible: true };
}
type SourceOwner = ReturnType<typeof sourceOwner>;

function fixture(population: SourceOwner[]) {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture",
    informationAccess: { tenantId: label.tenantId, principalId: label.principals[0]!, compartments: [], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [], modelHeaderReads: string[] = [], projectionExpansions: string[] = [];
  const pairs = (params: unknown[]) => params.flatMap(value => {
    if (typeof value !== "string" || !value.startsWith("[")) return [];
    const rows = JSON.parse(value) as Array<Record<string, unknown>>;
    return rows.every(row => typeof row?.profileId === "string" && Object.hasOwn(row, "sourceSystem") && !Object.hasOwn(row, "compilationId")) ? rows : [];
  });
  const matches = (entry: SourceOwner, owners: Array<Record<string, unknown>>) => owners.some(owner => owner.profileId === entry.profileId && owner.sourceSystem === entry.sourceSystem);
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.startsWith("SELECT DISTINCT pattern.profile_id,pattern.source_system")) {
      const ids = new Set(params[0] as string[]);
      return population.filter(entry => entry.accessible && ids.has(entry.pattern.id)).map(entry => ({ profile_id: entry.profileId, source_system: entry.sourceSystem })) as T[];
    }
    if (sql.includes("AS model_metadata")) {
      const owners = pairs(params);
      const selected = sql.includes('requested_owner."profileId"') ? population.filter(entry => matches(entry, owners)) : population;
      const rows = selected.flatMap(entry => entry.headers);
      modelHeaderReads.push(...rows.map(row => row.id));
      return structuredClone(rows) as T[];
    }
    const wanted = new Set(params[0] as string[]);
    const current = params.flatMap(value => typeof value === "string" && value.startsWith('[{"compilationId"') ? JSON.parse(value) as Array<Record<string, unknown>> : []);
    const projectionOwners = pairs(params);
    const expanded = sql.includes('requested_projection_owner."profileId"') ? population.filter(entry => matches(entry, projectionOwners)) : population;
    projectionExpansions.push(...expanded.map(entry => `${entry.profileId}/${entry.sourceSystem}`));
    const projectedIds = new Set(expanded.flatMap(entry => entry.patternIds));
    const rows = population.filter(entry => entry.accessible && wanted.has(entry.pattern.id) && projectedIds.has(entry.pattern.id)
      && current.some(owner => owner.profileId === entry.profileId && owner.sourceSystem === entry.sourceSystem
        && owner.sourceVersionId === entry.pattern.pattern_json.sourceVersionId && owner.compilationId === entry.pattern.pattern_json.sourceCompilationId));
    const rowLimit = [...params].reverse().find(value => typeof value === "number") as number;
    return rows.slice(0, rowLimit).map(entry => entry.pattern) as T[];
  };
  return { adapter, calls, modelHeaderReads, projectionExpansions };
}

describe("exact pattern reads scale with their actual requested owners", () => {
  it("never reads unrelated compilation headers or expands unrelated projection members", async () => {
    const requested = Array.from({ length: 7 }, (_, index) => sourceOwner(`profile.${index}`, `corpus.${index}`, index === 0 ? 2 : 1));
    const unrelated = [sourceOwner(requested[0]!.profileId, requested[1]!.sourceSystem), sourceOwner(requested[1]!.profileId, requested[0]!.sourceSystem),
      ...Array.from({ length: 96 }, (_, index) => sourceOwner(`foreign.${index}`, `foreign-corpus.${index}`))];
    const f = fixture([...requested, ...unrelated]);
    const ids = requested.map(entry => entry.pattern.id);
    const result = await f.adapter.languageMemory.listLanguagePatterns({ patternIds: [...ids, ids[0]!], limit: ids.length });
    expect(result.map(row => row.id)).toEqual(ids);
    expect(f.modelHeaderReads.sort()).toEqual(requested.flatMap(entry => entry.headers.map(row => row.id)).sort());
    expect(f.projectionExpansions.sort()).toEqual(requested.map(entry => `${entry.profileId}/${entry.sourceSystem}`).sort());
    const lookup = f.calls.find(call => call.sql.startsWith("SELECT DISTINCT pattern.profile_id,pattern.source_system"))!;
    expect(lookup).toBeDefined();
    expect(lookup.params[0]).toEqual(ids);
    expect(lookup.sql).toContain("pattern.id=ANY($1::text[])");
    expect(lookup.sql).toContain("pattern.information_label");
    expect(lookup.sql).not.toMatch(/LIMIT|pattern_json/u);
    const header = f.calls.find(call => call.sql.includes("AS model_metadata"))!;
    expect(header.sql).toContain('model.profile_id=requested_owner."profileId"');
    expect(header.sql).toContain('model.source_system IS NOT DISTINCT FROM requested_owner."sourceSystem"');
    expect(header.sql).toContain("OFFSET 0");
    expect(header.sql).not.toContain("LIMIT");
    for (const alias of ["model", "profile", "version", "receipt"]) expect(header.sql).toContain(`${alias}.information_label`);
    const final = f.calls.at(-1)!;
    const projection = final.sql.slice(final.sql.indexOf("active_projection_ids_0_headers AS MATERIALIZED"), final.sql.indexOf("pattern_headers AS MATERIALIZED"));
    expect(projection.indexOf('requested_projection_owner."profileId"')).toBeLessThan(projection.indexOf("CROSS JOIN LATERAL jsonb_array_elements_text"));
    expect(final.sql).toContain('current_compilation."sourceVersionId"=pattern.owned_source_version_id');
    expect(final.sql).not.toContain("ranked.category_rank <= CEIL");
  });

  it("rejects an incomplete exact-ID result while retaining every requested owner for eligibility proof", async () => {
    const requested = Array.from({ length: 7 }, (_, index) => sourceOwner(`owner.${index}`, `source.${index}`, 2));
    for (const entry of requested.slice(0, -1)) for (const row of entry.headers) row.compilation_receipt = {};
    const f = fixture([...requested, sourceOwner("unrelated", "outside")]);
    const result = await f.adapter.languageMemory.listLanguagePatterns({ patternIds: requested.map(entry => entry.pattern.id), limit: 1 });
    expect(result).toEqual([]);
    expect(f.modelHeaderReads.sort()).toEqual(requested.flatMap(entry => entry.headers.map(row => row.id)).sort());
    expect(f.calls.find(call => call.sql.includes("AS model_metadata"))!.sql).not.toContain("LIMIT");
  });

  it("does no compilation or projection expansion for missing or inaccessible exact IDs", async () => {
    const denied = sourceOwner("private", "private-corpus"); denied.accessible = false;
    const f = fixture([denied, sourceOwner("unrelated", "outside")]);
    expect(await f.adapter.languageMemory.listLanguagePatterns({ patternIds: ["missing", denied.pattern.id], limit: 2 })).toEqual([]);
    expect(f.modelHeaderReads).toEqual([]);
    expect(f.projectionExpansions).toEqual([]);
  });

  it("still rejects missing, duplicate, or changed owned model inventory on exact-ID reads", async () => {
    const entry = sourceOwner("owned", "chosen", 2), f = fixture([entry]);
    const query = { patternIds: [entry.pattern.id], limit: 1 };
    expect((await f.adapter.languageMemory.listLanguagePatterns(query)).map(row => row.id)).toEqual([entry.pattern.id]);
    const original = structuredClone(entry.headers);
    entry.headers.splice(1, 1);
    expect(await f.adapter.languageMemory.listLanguagePatterns(query)).toEqual([]);
    entry.headers.splice(0, entry.headers.length, ...original, original[0]!);
    expect(await f.adapter.languageMemory.listLanguagePatterns(query)).toEqual([]);
    entry.headers.splice(0, entry.headers.length, ...original.map(row => ({ ...row, source_id: "foreign.source" as SourceId })));
    expect(await f.adapter.languageMemory.listLanguagePatterns(query)).toEqual([]);
    entry.headers.splice(0, entry.headers.length, ...original);
    entry.pattern.pattern_json.sourceVersionId = "foreign.version" as SourceVersionId;
    expect(await f.adapter.languageMemory.listLanguagePatterns(query)).toEqual([]);
  });

  it("scopes active projection headers to explicit profile and source filters before member expansion", async () => {
    const f = fixture([]);
    await f.adapter.languageMemory.listLanguagePatterns({ profileIds: ["profile.a", "profile.b"], sourceSystem: "source.chosen", limit: 1 });
    const final = f.calls.at(-1)!;
    const projection = final.sql.slice(final.sql.indexOf("active_projection_ids_0_headers AS MATERIALIZED"), final.sql.indexOf("pattern_headers AS MATERIALIZED"));
    expect(projection).toContain("active_projection.value_json->>'profileId'=ANY(");
    expect(projection).toContain("active_projection.value_json->>'sourceSystem'=");
    expect(projection.indexOf("active_projection.value_json->>'profileId'=ANY(")).toBeLessThan(projection.indexOf("CROSS JOIN LATERAL jsonb_array_elements_text"));
    expect(final.params).toContainEqual(["profile.a", "profile.b"]);
    expect(final.params).toContain("source.chosen");
  });
});
