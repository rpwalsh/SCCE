// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { createHasher, requestSeedLanguagePattern, requestSeedSemanticFrame, type LanguagePatternRecord, type SemanticFrameRecord } from "@scce/kernel";
import { normalizePriorKey } from "../../../kernel/src/kernel-answer-primitives.js";
import { PostgresStorageAdapter } from "../postgres.js";
import { DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, durableJoinProgramJsonByteLengths } from "../durable-join-program-storage.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const label = { tenantId: "tenant.owned", principals: ["principal.owned"], compartments: [], exportClass: "restricted" as const, mergePolicy: "isolated" as const };
const pattern = (id: string, patternJson: LanguagePatternRecord["patternJson"]): LanguagePatternRecord => ({ id, profileId: "profile.owned",
  patternKind: "semantic_role", patternJson, support: 1, entropy: 0, evidenceIds: [], updatedAt: 1, informationLabel: label });
const frame = (id: string, frameJson: SemanticFrameRecord["frameJson"]): SemanticFrameRecord => ({ id, frameJson, embedding: Array.from({ length: 64 }, (_, index) => index + 1), evidenceIds: [], alpha: 1, createdAt: 1, informationLabel: label });

function fixture(patterns: LanguagePatternRecord[] = [], frames: SemanticFrameRecord[] = []) {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "seed_projection", informationAccess: {
    tenantId: "tenant.owned", principalId: "principal.owned", compartments: [], maximumExportClass: "restricted"
  } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  // Execute the bounded projection/quota contract locally; SQL structure is asserted independently below.
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.includes("AS model_metadata") || sql.startsWith("SELECT DISTINCT pattern.profile_id")) return [];
    if (sql.includes("FROM \"seed_projection\".\"semantic_frames\"")) {
      let rows = frames;
      const surfaceParameter = /frame\.normalized_surface_hash=\$(\d+)/u.exec(sql)?.[1];
      if (surfaceParameter) {
        const hash = params[Number(surfaceParameter) - 1];
        if (typeof hash === "string") rows = rows.filter(row => {
          const own = (row.frameJson as Record<string, unknown>).surface;
          return typeof own === "string" && createHasher().digestHex(normalizePriorKey(own)) === hash;
        });
      }
      if (sql.includes("'[]'::text AS embedding")) rows = rows.flatMap(row => requestSeedSemanticFrame(row) ?? []);
      return rows.map(row => ({ id: row.id, frame_json: row.frameJson, embedding: JSON.stringify(row.embedding), evidence_ids: row.evidenceIds,
        alpha: String(row.alpha), created_at: new Date(row.createdAt), information_label: row.informationLabel })) as unknown as T[];
    }
    if (!sql.includes("pattern_headers AS MATERIALIZED")) return [];
    const seeded = sql.includes("jsonb_object_agg(seed_field.key,seed_field.value)");
    let rows = seeded ? patterns.map(requestSeedLanguagePattern) : patterns;
    const ids = sql.includes("pattern.id=ANY(") ? params.find(Array.isArray) as string[] | undefined : undefined;
    if (ids) rows = rows.filter(row => ids.includes(row.id));
    const numbers = params.filter((value): value is number => typeof value === "number");
    const limit = numbers[0] ?? 1000;
    const budget = numbers[1];
    rows = rows.slice(0, limit);
    if (budget && sql.includes("running_stored_bytes")) {
      let storedBytes = 0;
      rows = rows.filter((row, index) => { storedBytes += Buffer.byteLength(JSON.stringify(patterns.find(pattern => pattern.id === row.id)!.patternJson)); return index === 0 || storedBytes <= budget; });
    }
    if (budget) {
      let jsonBytes = 0;
      rows = rows.filter((row, index) => { jsonBytes += Buffer.byteLength(JSON.stringify(row.patternJson)); return index === 0 || jsonBytes <= budget; });
    }
    return rows.map(row => ({ id: row.id, profile_id: row.profileId, pattern_kind: row.patternKind, support: String(row.support), entropy: String(row.entropy),
      pattern_json: row.patternJson, evidence_ids: row.evidenceIds, updated_at: new Date(row.updatedAt), information_label: row.informationLabel })) as unknown as T[];
  };
  return { adapter, calls };
}

it.each(["request_seed", "full"] as const)("binds only consumed parameters in a scoped %s read without active projections", async view => {
  for (const receipt of [false, true]) {
    const { adapter, calls } = fixture();
    await adapter.languageMemory.listLanguagePatterns({ ...(view === "full" ? {} : { view }),
      patternIds: ["pattern.owned"], profileIds: ["profile.owned"], sourceSystem: "dialogue",
      patternSchemas: [receipt ? "scce.source_induction_coverage.v1" : "scce.long_form_discourse_pattern.v1"],
      patternKind: receipt ? "source_compilation" : "discourse", limit: 8, maxTotalJsonBytes: 4096 });
    const call = calls.find(call => call.sql.includes("pattern_headers AS MATERIALIZED"))!;
    expect(call).toBeDefined();
    const used = new Set([...call.sql.matchAll(/\$(\d+)/gu)].map(match => Number(match[1])));
    expect([...used].sort((left, right) => left - right)).toEqual(call.params.map((_, index) => index + 1));
    expect(call.sql).not.toContain("requested_projection_owner");
  }
});

it("projects source owner headers and explicit request/declarative port flags only after checked bounded candidates", async () => {
  const { adapter, calls } = fixture();
  await adapter.languageMemory.listLanguagePatterns({ view: "request_seed", profileIds: ["profile.owned"], sourceSystem: "workspace", languageId: "language.owned", limit: 8, maxTotalJsonBytes: 4096 });
  const { sql, params } = calls.at(-1)!;
  expect(sql).toContain("jsonb_object_agg(seed_field.key,seed_field.value)");
  expect(sql).toContain("'requestConstructionCandidate'");
  expect(sql).toContain("'sourceConstructionCandidate'");
  expect(sql).toContain("seed_example.value->'nullRoles'");
  expect(sql).toContain("seed_example.value->'roles'");
  expect(sql).toContain("jsonb_typeof(seed_role.value->'graphBinding')='object'");
  expect(sql).toContain("jsonb_typeof(pattern.pattern_json#>'{bundle,sourceExamples}')='array'");
  expect(sql).not.toContain("ELSE pattern.pattern_json END AS pattern_json");
  const projection = sql.indexOf("jsonb_object_agg(seed_field.key,seed_field.value)");
  expect(projection).toBeGreaterThan(sql.indexOf("LIMIT $"));
  expect(projection).toBeGreaterThan(sql.indexOf("current_compilation"));
  expect(projection).toBeGreaterThan(sql.indexOf("pattern.pattern_schema,pattern.id) IN"));
  expect(sql).toContain("pattern.profile_id=ANY(");
  expect(sql).toContain("pattern.source_system=");
  expect(sql).toContain("lp.language_id=");
  expect(sql).toContain("pattern.information_label->>'tenantId'");
  expect(params).toContainEqual(["profile.owned"]);
  expect(params).toContain("workspace");
});

it("budgets projected metadata rather than full physical pages or decoded-program ledgers while preserving category quotas", async () => {
  const pages = ["request", "declarative"].map((name, index) => pattern(`surface.construction.bundle.${name}`, {
    schema: "scce.language_construction_pattern.v1", sourceSystem: "workspace", sourceVersionId: "version.owned",
    bundle: { sourceExamples: [{ surface: "body".repeat(10000), roles: index ? [{ graphBinding: { relationId: "opaque" } }] : [],
      nullRoles: index ? [] : [{ graphBinding: { relationId: "opaque" } }] }], constructions: [{ body: "program".repeat(10000) }] }
  }));
  const stored = pages.map(row => ({ ...row, patternJson: { ...(row.patternJson as Record<string, unknown>),
    _scceJoinProgramStorage: { schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...durableJoinProgramJsonByteLengths(row.patternJson) }
  } as LanguagePatternRecord["patternJson"] }));
  const { adapter, calls } = fixture(stored);
  const seed = await adapter.languageMemory.listLanguagePatterns({ view: "request_seed", limit: 8, maxTotalJsonBytes: 2048 });
  expect(seed).toEqual(pages.map(requestSeedLanguagePattern));
  expect(seed).toHaveLength(2);
  for (const row of seed) {
    expect(row.patternJson).not.toHaveProperty("bundle");
    expect(row.patternJson).not.toHaveProperty("_scceJoinProgramStorage");
  }
  const sql = calls.at(-1)!.sql;
  expect(sql).not.toContain("running_stored_bytes");
  expect(sql).toContain("CASE WHEN pattern.pattern_schema='scce.request_requirement_pattern.v1' THEN pattern.decoded_jsonb_bytes ELSE NULL::numeric END AS decoded_jsonb_bytes");
  expect(sql).toContain("ranked.category_rank <= CEIL(");
  expect(sql).toContain("PARTITION BY CASE");
  expect(sql).toContain("octet_length(eligible.pattern_json::text)");
  expect((await adapter.languageMemory.listLanguagePatterns({ limit: 8, maxTotalJsonBytes: 2048 }))).toEqual([pages[0]]);
  expect(calls.at(-1)!.sql).toContain("running_stored_bytes");
  expect(calls.at(-1)!.sql).toContain("pattern.decoded_jsonb_bytes AS decoded_jsonb_bytes");
});

it("keeps source-conditioned requirements intact and projects only entity classes and syntax metadata", async () => {
  const rows = [pattern("request_requirement_pattern_control", { schema: "scce.request_requirement_pattern.v1", compilerFingerprint: "compiler.opaque",
    surface: "ψ", requirementCoefficients: { noveltyDemand: 2 }, selectedAuthority: "creative", requestUnitResponseCopy: [{ unit: "ψ", supportedPairs: 6, copiedPairs: 0 }],
    corpusAuthorityCounts: { creative: 6 }, unknownCompilerStatistic: { retained: true } }),
  pattern("syntax", { schema: "scce.induced_language_model.syntax_memory.v1", templates: [{ shape: ["source"] }], joinProgram: { source: "program" }, counts: { source: 4 }, boundarySignals: [{ marker: "opaque" }] }),
  pattern("semantic", { schema: "scce.induced_language_model.semantic_memory.v1", profileId: "profile.owned", semanticFrames: [{ predicate: "opaque" }], relationHypothesisModel: { source: "huge" },
    graphBoundConstructions: [{ evidenceIds: ["evidence.owned"], predicate: "opaque", slots: [{ semanticRole: "entity", observedFillers: ["α"], lexicalClassId: "entity.class" }, { semanticRole: "quantity", observedFillers: ["9"], lexicalClassId: "quantity.class" }] }],
    lexicalClasses: [{ id: "entity.class", members: [{ symbol: "β", support: 10 }] }, { id: "quantity.class", members: [{ symbol: "9" }] }] })];
  const { adapter, calls } = fixture(rows);
  expect(await adapter.languageMemory.listLanguagePatterns({ view: "request_seed", limit: 8 })).toEqual(rows.map(requestSeedLanguagePattern));
  const sql = calls.at(-1)!.sql;
  expect(sql).toContain("WHEN admitted.pattern_schema='scce.request_requirement_pattern.v1' THEN pattern.pattern_json");
  expect(sql).toContain("jsonb_build_object('templates','[]'::jsonb)");
  expect(sql).toContain("slot.value->>'semanticRole'='entity'");
  expect(sql).toContain("lexical.value->>'id' IN (SELECT id FROM seed_entity_classes)");
  expect(sql).toContain("'symbol',COALESCE(member.value->'symbol','null'::jsonb)");
  expect(sql).not.toContain("'relationHypothesisModel'");
  expect(sql).not.toContain("'joinProgram'");
  expect(await adapter.languageMemory.listLanguagePatterns({ limit: 8 })).toEqual(rows);
});

it("keeps exact deferred header IDs and their shared prerequisite budget under owner checks", async () => {
  const { adapter, calls } = fixture();
  const patternIds = ["surface.construction.bundle.request", "surface.construction.bundle.declarative"];
  await adapter.languageMemory.listLanguagePatterns({ view: "request_seed", patternIds, profileIds: ["profile.owned"], sourceSystem: "workspace", limit: 2, maxTotalJsonBytes: 4096 });
  const { sql, params } = calls.at(-1)!;
  expect(params[0]).toEqual(patternIds);
  expect(sql).toContain("pattern.id=ANY($1::text[])");
  expect(sql).not.toContain("ranked.category_rank <= CEIL");
  expect(sql).not.toContain("OVER (PARTITION BY CASE");
  expect(sql).toContain("current_compilation");
  expect(sql).toContain("requested_projection_owner");
  expect(sql).toContain("active_projection.information_label->>'tenantId'");
});

it("selects only typed requirement frame metadata before returning rows and leaves full frame reads intact", async () => {
  const rows = [frame("typed", { surface: "ψ", profileId: "profile.owned", sourceVersionId: "version.owned", requirementCoefficients: { noveltyDemand: 2 }, semanticRoleId: "role.opaque", preview: "source output", sourceExamples: ["source body"] }),
    frame("generic", { preview: "source output", semanticFrames: ["body"] }), frame("malformed", { surface: "ψ", requirementCoefficients: [] }),
    frame("blank", { surface: "\u2003", requirementCoefficients: {} })];
  const { adapter, calls } = fixture([], rows);
  expect(await adapter.languageMemory.listSemanticFrames({ view: "request_seed", profileIds: ["profile.owned"], sourceSystem: "workspace", limit: 8 }))
    .toEqual(rows.flatMap(row => requestSeedSemanticFrame(row) ?? []));
  const sql = calls.at(-1)!.sql;
  expect(sql).toContain("jsonb_typeof(frame.frame_json->'surface')='string'");
  expect(sql).toContain("jsonb_typeof(frame.frame_json->'requirementCoefficients')='object'");
  expect(sql).toContain("jsonb_object_agg(seed_field.key,seed_field.value)");
  expect(sql).toContain("'[]'::text AS embedding");
  expect(sql).toContain("frame.frame_json->>'profileId'=ANY(");
  expect(sql).toContain("frame.frame_json->>'sourceSystem'=");
  expect(sql).toContain("frame.information_label->>'tenantId'");
  expect(await adapter.languageMemory.listSemanticFrames({ limit: 8 })).toEqual(rows);
  expect(calls.at(-1)!.sql).toContain("SELECT id, frame_json, embedding::text AS embedding");
});

it.each(["αλφα βήτα", "  ΑΛΦΑ\tβήτα\r\n", "КВАРТУН БОБ", "αλφα\u2003βήτα", "ALPHA", "ＡＬＰＨＡ"])("matches normalized exact request frames without broadening Unicode spacing: %s", async requestSurface => {
  const rows = [frame("greek", { surface: "ΑΛΦΑ\tβήτα" }), frame("em-space", { surface: "αλφα\u2003βήτα" }),
    frame("russian", { surface: "Квартун Боб" }), frame("width", { surface: "ＡＬＰＨＡ" })];
  const { adapter, calls } = fixture([], rows);
  expect(await adapter.languageMemory.listSemanticFrames({ requestSurface, limit: 8 })).toEqual(rows.filter(row =>
    normalizePriorKey(String((row.frameJson as Record<string, unknown>).surface)) === normalizePriorKey(requestSurface)));
  const sql = calls.at(-1)!.sql;
  expect(sql).toContain("frame.normalized_surface_hash=$1");
  expect(sql).not.toContain("lower(");
  expect(sql).not.toContain("[[:space:]]");
  expect(sql).not.toContain("normalize(");
  expect(calls.at(-1)!.params[0]).toBe(createHasher().digestHex(normalizePriorKey(requestSurface)));
});
