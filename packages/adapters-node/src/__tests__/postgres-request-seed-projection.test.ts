// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { createHasher, createLanguageInductionEngine, predictionScoringLanguagePattern, requestSeedLanguagePattern, requestSeedSemanticFrame, semanticInductionProjection,
  toJsonValue, type LanguagePatternRecord, type SemanticFrameRecord } from "@scce/kernel";
import { normalizePriorKey } from "../../../kernel/src/kernel-answer-primitives.js";
import { PostgresStorageAdapter } from "../postgres.js";
import { DECODED_JSON_BYTE_LEDGER_KEY, DECODED_JSON_BYTE_LEDGER_SCHEMA, decodedJsonByteLengths, encodeDurableArtifact } from "../durable-artifact-storage.js";
import { SEMANTIC_PROJECTION_STORAGE_KEY } from "../semantic-projection-storage.js";

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
    const predictionScoring = sql.includes("'sentenceCount'") && sql.includes("'paragraphShapeTransitions'");
    let rows = seeded ? patterns.map(row => {
      const physical = row.patternJson as Record<string, unknown>;
      if (!Object.hasOwn(physical, SEMANTIC_PROJECTION_STORAGE_KEY)) return predictionScoring
        ? predictionScoringLanguagePattern(row)
        : requestSeedLanguagePattern(row);
      const seed = requestSeedLanguagePattern(row), json = seed.patternJson as Record<string, unknown>;
      const { graphBoundConstructions: _graphs, lexicalClasses: _classes, ...headers } = json;
      return { ...seed, patternJson: { ...headers,
        ...(typeof physical.modelId === "string" ? { modelId: physical.modelId } : {}),
        semanticInductionProjection: physical.semanticInductionProjection,
        [SEMANTIC_PROJECTION_STORAGE_KEY]: physical[SEMANTIC_PROJECTION_STORAGE_KEY]
      } as LanguagePatternRecord["patternJson"] };
    }) : patterns;
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

it.each(["request_seed", "prediction_scoring", "full"] as const)("binds only consumed parameters in a scoped %s read without active projections", async view => {
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

it("bounds a multi-corpus pattern population in one owned projection", async () => {
  const { adapter, calls } = fixture();
  await adapter.languageMemory.listLanguagePatterns({
    view: "request_seed",
    sourceSystems: ["dialogue", "wikipedia", "dialogue"],
    languageId: "language.owned",
    limit: 768,
    maxTotalJsonBytes: 32 * 1024 * 1024
  });
  const callsWithPatterns = calls.filter(call => call.sql.includes("pattern_headers AS MATERIALIZED"));
  expect(callsWithPatterns).toHaveLength(1);
  const { sql, params } = callsWithPatterns[0]!;
  expect(sql).toContain("pattern.source_system=ANY(");
  expect(sql).toContain("active_projection.value_json->>'sourceSystem'=ANY(");
  expect(calls.find(call => call.sql.includes("AS model_metadata"))?.sql).toContain("model.source_system=ANY(");
  expect(params).toContainEqual(["dialogue", "wikipedia"]);
  expect(params.filter(value => value === 768)).toHaveLength(1);
  await expect(adapter.languageMemory.listLanguagePatterns({ sourceSystem: "dialogue", sourceSystems: ["wikipedia"] }))
    .rejects.toThrow("sourceSystem or sourceSystems");
  expect(await adapter.languageMemory.listLanguagePatterns({ sourceSystems: [] })).toEqual([]);
});

it("budgets projected metadata rather than full physical pages or decoded-program ledgers while preserving category quotas", async () => {
  const pages = ["request", "declarative"].map((name, index) => pattern(`surface.construction.bundle.${name}`, {
    schema: "scce.language_construction_pattern.v1", sourceSystem: "workspace", sourceVersionId: "version.owned",
    bundle: { sourceExamples: [{ surface: "body".repeat(10000), roles: index ? [{ graphBinding: { relationId: "opaque" } }] : [],
      nullRoles: index ? [] : [{ graphBinding: { relationId: "opaque" } }] }], constructions: [{ body: "program".repeat(10000) }] }
  }));
  const stored = pages.map(row => ({ ...row, patternJson: { ...(row.patternJson as Record<string, unknown>),
    [DECODED_JSON_BYTE_LEDGER_KEY]: { schema: DECODED_JSON_BYTE_LEDGER_SCHEMA, ...decodedJsonByteLengths(row.patternJson) }
  } as LanguagePatternRecord["patternJson"] }));
  const { adapter, calls } = fixture(stored);
  const seed = await adapter.languageMemory.listLanguagePatterns({ view: "request_seed", limit: 8, maxTotalJsonBytes: 2048 });
  expect(seed).toEqual(pages.map(requestSeedLanguagePattern));
  expect(seed).toHaveLength(2);
  for (const row of seed) {
    expect(row.patternJson).not.toHaveProperty("bundle");
    expect(row.patternJson).not.toHaveProperty(DECODED_JSON_BYTE_LEDGER_KEY);
  }
  const sql = calls.at(-1)!.sql;
  expect(sql).not.toContain("running_stored_bytes");
  expect(sql).toContain("CASE WHEN pattern.pattern_schema='scce.request_requirement_pattern.v1' THEN pattern.decoded_artifact_jsonb_bytes ELSE NULL::numeric END AS decoded_jsonb_bytes");
  expect(sql).toContain("ranked.category_rank <= CEIL(");
  expect(sql).toContain("PARTITION BY CASE");
  expect(sql).toContain("octet_length(eligible.pattern_json::text)");
  expect((await adapter.languageMemory.listLanguagePatterns({ limit: 8, maxTotalJsonBytes: 2048 }))).toEqual([pages[0]]);
  expect(calls.at(-1)!.sql).toContain("running_stored_bytes");
  expect(calls.at(-1)!.sql).toContain("pattern.decoded_artifact_jsonb_bytes AS decoded_jsonb_bytes");
});

it("rejects deferred construction and creative bodies at prediction/scoring headers before pattern JSON expansion", async () => {
  const rows = [pattern("pattern.ordinary", { schema: "scce.long_form_discourse_pattern.v1", counts: { "lumen arc": 3 },
    sentenceCount: 2, sourceBody: "ordinary body is not causal" }),
  pattern("surface.construction.bundle.heavy", { schema: "scce.language_construction_pattern.v1", surface: "lumen arc",
    bundle: { sourceExamples: [{ surface: "secret body", roles: [], nullRoles: [] }], program: "x".repeat(4096) } })];
  const { adapter, calls } = fixture(rows);
  const projected = await adapter.languageMemory.listLanguagePatterns({ view: "prediction_scoring", limit: 8, maxTotalJsonBytes: 4096 });
  expect(projected).toEqual(rows.map(predictionScoringLanguagePattern));
  expect(JSON.stringify(projected)).not.toContain("secret body");
  expect(JSON.stringify(projected)).not.toContain("ordinary body is not causal");
  const sql = calls.at(-1)!.sql;
  const headerScope = sql.indexOf("pattern_headers AS MATERIALIZED");
  const bodyJoin = sql.indexOf(`JOIN "seed_projection"."language_patterns" pattern ON pattern.id=admitted.id`);
  expect(sql).toContain("pattern.pattern_schema IS DISTINCT FROM 'scce.language_construction_pattern.v1'");
  expect(sql).toContain("pattern.pattern_schema NOT LIKE 'scce.creative_event_construction_pattern.%'");
  expect(headerScope).toBeGreaterThan(-1);
  expect(bodyJoin).toBeGreaterThan(headerScope);
  expect(sql.indexOf("pattern.pattern_schema IS DISTINCT FROM 'scce.language_construction_pattern.v1'"))
    .toBeLessThan(bodyJoin);
  expect(sql).not.toContain("running_stored_bytes");
  expect(sql).toContain("octet_length(eligible.pattern_json::text)");
});

it("bounds projected prediction/scoring frames before returning decoded rows", async () => {
  const rows = [frame("frame.prediction", { surface: "lumen arc", profileId: "profile.owned", sourceSystem: "workspace",
    requirementCoefficients: { noveltyDemand: 2 }, content: { sourceBody: "not causal" } })];
  const { adapter, calls } = fixture([], rows);
  const projected = await adapter.languageMemory.listSemanticFrames({ view: "prediction_scoring", limit: 8, maxTotalJsonBytes: 2048 });
  expect(projected).toEqual(rows.flatMap(row => requestSeedSemanticFrame(row) ?? []));
  expect(JSON.stringify(projected)).not.toContain("not causal");
  const sql = calls.at(-1)!.sql;
  expect(sql).toContain("WITH projected AS MATERIALIZED");
  expect(sql).toContain("octet_length(to_jsonb(projected)::text)");
  expect(sql).toContain("running_json_bytes");
  expect(sql).toContain("decoded_json_bytes<=");
  await expect(adapter.languageMemory.listSemanticFrames({ view: "prediction_scoring", limit: 8 }))
    .rejects.toThrow("positive finite decoded byte bound");
});

it("bounds minimal prediction/scoring units without decoding stored metadata bodies", async () => {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "seed_projection", informationAccess: {
    tenantId: "tenant.owned", principalId: "principal.owned", compartments: [], maximumExportClass: "restricted"
  } });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    return [{ id: "unit.prediction", profile_id: "profile.owned", source_version_id: "version.owned", script: "script.Latn",
      unit_kind: "phrase", unit_text: "lumen arc", features: [], competence_vector: [], alpha: "0.8", evidence_ids: [],
      metadata_json: { connectors: ["therefore"] }, information_label: label }] as unknown as T[];
  };
  const units = await adapter.languageMemory.listLanguageUnits({ view: "prediction_scoring", profileIds: ["profile.owned"], limit: 8, maxTotalJsonBytes: 2048 });
  expect(units).toMatchObject([{ id: "unit.prediction", text: "lumen arc", features: [], competenceVector: [], metadata: { connectors: ["therefore"] } }]);
  const sql = calls.at(-1)!.sql;
  expect(sql).toContain("WITH candidates AS MATERIALIZED");
  expect(sql).toContain("ARRAY[]::text[] AS features");
  expect(sql).toContain("octet_length(to_jsonb(candidates)::text)");
  expect(sql).toContain("decoded_json_bytes<=");
  expect(sql).not.toContain("source_artifact_metadata");
  await expect(adapter.languageMemory.listLanguageUnits({ view: "prediction_scoring", limit: 8 }))
    .rejects.toThrow("positive finite decoded byte bound");
});

it("keeps source-conditioned requirements intact and projects only entity classes and syntax metadata", async () => {
  const rows = [pattern("request_requirement_pattern_control", { schema: "scce.request_requirement_pattern.v1", compilerFingerprint: "compiler.opaque",
    surface: "ψ", requirementCoefficients: { noveltyDemand: 2 }, selectedAuthority: "creative", requestUnitResponseCopy: [{ unit: "ψ", supportedPairs: 6, copiedPairs: 0 }],
    corpusAuthorityCounts: { creative: 6 }, unknownCompilerStatistic: { retained: true } }),
  pattern("syntax", { schema: "scce.induced_language_model.syntax_memory.v1", templates: [{ shape: ["source"] }], segmentationWitness: { source: "witness" }, counts: { source: 4 }, boundarySignals: [{ marker: "opaque" }] }),
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
  expect(sql).not.toContain("'segmentationWitness'");
  expect(await adapter.languageMemory.listLanguagePatterns({ limit: 8 })).toEqual(rows);
});

it("carries only admitted semantic replay state through SQL, then cold-projects the exact entity request seed", async () => {
  const hasher = createHasher();
  const model = createLanguageInductionEngine({ hasher }).induce({ documents: [{ id: "source.semantic",
    text: "Alice follows Bob. Bob follows Alice. Mira directs Neralis.", evidenceIds: ["evidence.semantic" as never], trust: 0.9 }] });
  const logicalJson = toJsonValue({ schema: "scce.induced_language_model.semantic_memory.v1", modelId: "model.owned", profileId: "profile.owned",
    sourceVersionId: "version.owned", semanticFrames: model.semanticFrames, graphBoundConstructions: model.graphBoundConstructions,
    lexicalClasses: model.lexicalClasses, relationHypothesisModel: model.relationHypothesisModel,
    semanticInductionProjection: semanticInductionProjection({ factors: model.semanticInductionFactors!, semanticFrames: model.semanticFrames,
      graphBoundConstructions: model.graphBoundConstructions, lexicalClasses: model.lexicalClasses,
      relationHypothesisModel: model.relationHypothesisModel, hasher }), counts: { follows: 2 } });
  const logical = pattern("semantic.replay", logicalJson);
  const physical = { ...logical, patternJson: encodeDurableArtifact(logicalJson) as LanguagePatternRecord["patternJson"] };
  const { adapter, calls } = fixture([physical]);
  const query = { view: "request_seed" as const, limit: 8, maxTotalJsonBytes: 1024 * 1024 };
  const expected = requestSeedLanguagePattern(logical);
  const first = await adapter.languageMemory.listLanguagePatterns(query);
  expect(first).toEqual([expected]);
  const sql = calls.at(-1)!.sql;
  expect(sql).toContain(`(${"pattern.pattern_json"}) ? '${SEMANTIC_PROJECTION_STORAGE_KEY}'`);
  expect(sql).toContain(`'semanticInductionProjection',pattern.pattern_json->'semanticInductionProjection'`);
  expect(sql).toContain(`'${SEMANTIC_PROJECTION_STORAGE_KEY}',pattern.pattern_json->'${SEMANTIC_PROJECTION_STORAGE_KEY}'`);
  expect(sql).toContain("'modelId'");
  expect(requestSeedLanguagePattern(logical).patternJson).not.toHaveProperty("modelId");
  const replayQueries = () => calls.filter(call => !call.sql.includes("pattern_headers AS MATERIALIZED")
    && !call.sql.includes("AS model_metadata") && !call.sql.startsWith("SELECT DISTINCT pattern.profile_id")).length;
  const replayQueriesAfterFirst = replayQueries();
  (first[0]!.patternJson as Record<string, unknown>).counts = { poisoned: 1 };
  const second = await adapter.languageMemory.listLanguagePatterns(query);
  expect(second).toEqual([expected]);
  expect(second[0]).not.toBe(first[0]);
  expect(replayQueries()).toBe(replayQueriesAfterFirst);
  physical.support = 2;
  expect(await adapter.languageMemory.listLanguagePatterns(query)).toEqual([{ ...expected, support: 2 }]);
  expect(calls.filter(call => call.sql.includes("pattern_headers AS MATERIALIZED"))).toHaveLength(3);
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
