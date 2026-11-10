// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, canonicalStringify, createClock, createHasher, createIdFactory, createLanguageAcquisitionEngine,
  createUniversalCreativeEventConstructionCompiler, deriveUniversalCreativeEvent, hashEvent, hydrateLanguageConstructionPatterns,
  informationLabelAllowsRead, requestSeedLanguagePattern, type EvidenceSpan, type InformationLabel,
  type JsonValue, type LanguagePatternRecord, type ScceEvent } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";
import { canonicalCreativeEventSchemaStatements } from "../canonical-creative-event-store.js";
import { CREATIVE_EVENT_NORMALIZATION_SCHEMA, CREATIVE_EVENT_NORMALIZATION_TABLES, CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA,
  creativeEventStorageJson, normalizeCreativeEventPage, reconstructCreativeEventPage,
  type CreativeEventDomainRecord, type CreativeEventOwner } from "../creative-event-normalization.js";
import { LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY, languageArtifactJsonByteLengths } from "../durable-language-artifact-storage.js";

const hasher = createHasher(), label: InformationLabel = { tenantId: "tenant.owned", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" };
const access = { tenantId: "tenant.owned", principalId: "principal.owned", compartments: [], maximumExportClass: "restricted" as const };
const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("expected object"); return value as Record<string, unknown>;
};
const digest = (value: unknown): string => hasher.digestHex(canonicalStringify(value));
let evidence: EvidenceSpan, patterns: LanguagePatternRecord[], owner: CreativeEventOwner;
beforeAll(() => {
  const text = (JSON.parse(readFileSync(new URL("../../../kernel/src/__tests__/fixtures/dolly-human-16.json", import.meta.url), "utf8")) as { text: string }).text;
  const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true, namespace: "canonical-creative" });
  const sourceVersionId = ids.sourceVersionId(text), contentHash = ids.contentHash(text), sourceId = ids.sourceId("dialogue", "fixture://pinned-dolly16"), length = Buffer.byteLength(text);
  evidence = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: length, spanHash: contentHash }), sourceId, sourceVersionId,
    chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: length, chunkHash: contentHash }), contentHash,
    mediaType: "text/plain", byteStart: 0, byteEnd: length, charStart: 0, charEnd: [...text].length, text, textPreview: text,
    languageHints: {}, scriptHints: {}, trustVector: {}, provenance: {}, features: [], status: "promoted", alpha: 1, observedAt: 1, informationLabel: label };
  const profile = createLanguageAcquisitionEngine({ idFactory: ids }).acquire({ sourceVersionId, text, createdAt: 1 });
  const compiled = createUniversalCreativeEventConstructionCompiler().compile({ profileId: profile.id, evidence: [evidence], hasher, updatedAt: 1 });
  if (compiled.status !== "compiled") throw Error("genuine human source did not compile");
  patterns = (compiled.patterns ?? [compiled.pattern]).filter(pattern => object(pattern.patternJson).bundle).map(pattern => ({ ...pattern, informationLabel: label }));
  owner = { profileId: profile.id, sourceId, sourceVersionId, sourceContentHash: contentHash, evidenceId: evidence.id, evidenceContentHash: contentHash,
    evidenceCharStart: evidence.charStart, evidenceCharEnd: evidence.charEnd, informationLabel: label };
});

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });

function fixture() {
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "canonical_creative", informationAccess: access });
  adapters.push(adapter);
  const components = new Map(CREATIVE_EVENT_NORMALIZATION_TABLES.map(table => [table, new Map<string, Record<string, unknown>>()]));
  const rows = { patterns: [] as Record<string, unknown>[], models: [] as Record<string, unknown>[], events: [] as Record<string, unknown>[] };
  const calls: string[] = [], state = { inserted: 0, source: { ...owner }, promoted: true, sourceLabel: label, head: undefined as unknown };
  const query = async (sql: string, params: unknown[] = []) => {
    calls.push(sql);
    if (sql.includes("SELECT profile.id AS profile_id")) {
      const requested = JSON.parse(String(params[0])) as Array<{ profileId: string; evidenceId: string }>;
      const selected = requested.filter(item => item.profileId === state.source.profileId && item.evidenceId === state.source.evidenceId
        && (!sql.includes("evidence.status='promoted'") || state.promoted) && informationLabelAllowsRead(state.sourceLabel, access));
      return { rows: selected.map(() => ({ profile_id: state.source.profileId, source_id: state.source.sourceId, source_version_id: state.source.sourceVersionId, source_content_hash: state.source.sourceContentHash,
        evidence_id: state.source.evidenceId, evidence_content_hash: state.source.evidenceContentHash, char_start: state.source.evidenceCharStart,
        char_end: state.source.evidenceCharEnd, byte_start: evidence.byteStart, byte_end: evidence.byteEnd,
        profile_source_version_id: state.source.sourceVersionId, has_pooled_binding: false, pooled_profile: null,
        profile_label: state.sourceLabel, source_label: state.sourceLabel, evidence_label: state.sourceLabel })) };
    }
    const table = CREATIVE_EVENT_NORMALIZATION_TABLES.find(table => sql.includes(`"${table}"`));
    if (table) {
      const saved = components.get(table)!;
      if (sql.startsWith("INSERT INTO")) {
        for (const row of JSON.parse(String(params[0])) as Record<string, unknown>[]) if (!saved.has(String(row.id))) { saved.set(String(row.id), cold(row)); state.inserted++; }
        return { rows: [] };
      }
      if (sql.includes("AS expected")) {
        const expected = JSON.parse(String(params[0])) as Record<string, unknown>[];
        return { rows: expected.filter(row => saved.has(String(row.id)) && creativeEventStorageJson(saved.get(String(row.id))) === creativeEventStorageJson(row)).map(row => ({ id: row.id })) };
      }
      const ids = params[0] as string[];
      return { rows: ids.flatMap(id => { const row = saved.get(id); return row && (!row.information_label || informationLabelAllowsRead(row.information_label as InformationLabel, access)) ? [cold(row)] : []; }) };
    }
    if (sql.includes("INSERT INTO") && sql.includes('"language_patterns"')) {
      rows.patterns = (JSON.parse(String(params[0])) as Record<string, unknown>[]).map(row => ({ ...row, evidence_ids: row.evidence_ids_json, updated_at: new Date(Number(row.updated_at_ms)) }));
    } else if (sql.includes("INSERT INTO") && sql.includes('"induced_language_models"')) {
      if (!rows.models.some(row => row.id === params[0])) rows.models.push({ id: params[0], training_plan_id: params[1], model_json: JSON.parse(String(params[2])), information_label: JSON.parse(String(params[5])), created_at: new Date(Number(params[6])) });
    } else if (sql.includes("INSERT INTO") && sql.includes("(id, episode_id")) {
      const [id, episode_id, type_id, t, payload, parents, hash, ledger_hash] = params;
      rows.events.push({ id, episode_id, type_id, t, payload_json: JSON.parse(String(payload)), parents, hash, ledger_hash });
    } else if (sql.includes("INSERT INTO") && sql.includes("storage_meta")) state.head = JSON.parse(String(params[1]));
    if (sql.startsWith("SELECT value_json")) return { rows: state.head ? [{ value_json: state.head }] : [] };
    if (sql.startsWith("SELECT id, hash")) return { rows: rows.events.filter(row => (params[0] as string[]).includes(String(row.id))) };
    if (sql.startsWith("SELECT id, information_label")) return { rows: [] };
    if (!sql.includes("INSERT INTO") && sql.includes('"induced_language_models"')) return { rows: rows.models };
    if (sql.includes("pattern_headers AS MATERIALIZED")) return { rows: rows.patterns.map(row => {
      if (!sql.includes("CASE WHEN pattern.pattern_schema='scce.request_requirement_pattern.v1' THEN pattern.decoded_jsonb_bytes ELSE NULL::numeric END AS decoded_jsonb_bytes")) return row;
      const pattern: LanguagePatternRecord = { id: String(row.id), profileId: String(row.profile_id), patternKind: "semantic_role", support: Number(row.support), entropy: Number(row.entropy),
        patternJson: row.pattern_json as JsonValue, evidenceIds: evidence.id ? [evidence.id] : [], updatedAt: 1 };
      return { ...row, pattern_json: requestSeedLanguagePattern(pattern).patternJson };
    }) };
    if (sql.startsWith("SELECT *") && sql.includes('"events"')) return { rows: rows.events };
    return { rows: [] };
  };
  const client = { query, release() {} };
  (adapter.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => client;
  (adapter.pool as unknown as { query: typeof query }).query = query;
  return { adapter, rows, components, calls, state };
}

describe("canonical creative-event domain normalization", () => {
  it("stores shared definitions once and cold-restores every genuine event through the production pattern API", async () => {
    const { adapter, rows, components, calls, state } = fixture();
    if (!adapter.languageMemory.putLanguagePatterns) throw Error("missing batch pattern writer");
    await adapter.languageMemory.putLanguagePatterns(patterns);
    expect(components.get("creative_event_templates")!.size).toBe(2);
    expect(components.get("creative_event_lexemes")!.size).toBeGreaterThan(0);
    expect(components.get("creative_event_witnesses")!.size).toBe(1);
    expect(components.get("creative_event_occurrences")!.size).toBe(patterns.length);
    for (const row of rows.patterns) {
      const stored = object(row.pattern_json), original = patterns.find(pattern => pattern.id === row.id)!;
      expect(object(object(stored.bundle).events).schema).toBe(CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA);
      expect(object(stored[LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY])).toMatchObject(languageArtifactJsonByteLengths(original.patternJson));
      const { events: _events, ...headers } = object(stored.bundle), { events: _originalEvents, ...originalHeaders } = object(object(original.patternJson).bundle);
      expect(headers).toEqual(originalHeaders);
    }
    const restored = await adapter.languageMemory.listLanguagePatterns({ patternIds: patterns.map(pattern => pattern.id), limit: patterns.length,
      maxTotalJsonBytes: patterns.reduce((sum, pattern) => sum + languageArtifactJsonByteLengths(pattern.patternJson).decodedJsonbBytes, 0), requireComplete: true });
    expect(restored.map(pattern => digest(pattern.patternJson))).toEqual(patterns.map(pattern => digest(pattern.patternJson)));
    expect(hydrateLanguageConstructionPatterns({ patterns: restored, evidence: [evidence], hasher }))
      .toEqual(hydrateLanguageConstructionPatterns({ patterns, evidence: [evidence], hasher }));
    const insertions = state.inserted;
    await adapter.languageMemory.putLanguagePatterns(patterns);
    expect(state.inserted).toBe(insertions);
    const beforeSeed = calls.length;
    const seed = await adapter.languageMemory.listLanguagePatterns({ view: "request_seed", profileIds: [owner.profileId], maxTotalJsonBytes: 8192 });
    expect(seed.map(pattern => pattern.patternJson)).toEqual(patterns.map(pattern => requestSeedLanguagePattern(pattern).patternJson));
    expect(calls.slice(beforeSeed).some(sql => CREATIVE_EVENT_NORMALIZATION_TABLES.some(table => sql.includes(`"${table}"`)))).toBe(false);
    expect(calls.slice(beforeSeed).some(sql => sql.includes("SELECT profile.id AS profile_id"))).toBe(false);
  });

  it("reuses the same canonical records in full induced models and immutable ledger payloads without changing replay hashes", async () => {
    const { adapter, components, rows, state } = fixture();
    const model = { id: "model.genuine.creative", corpusDocuments: 1, vocabularySize: 2, patterns: patterns.map(pattern => pattern.patternJson),
      segmentationDocuments: [{ graph: { schema: SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, nodeCount: 1001,
        arcs: Array.from({ length: 1000 }, (_, index) => [index, index + 1, 0]) } }] };
    await adapter.inducedLanguageModels.putModel({ id: model.id, model: model as never, trainingPlanId: "plan.owned", createdAt: 1, informationLabel: label });
    const count = state.inserted;
    expect(JSON.stringify(rows.models[0]!.model_json).includes(CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA)).toBe(true);
    expect(JSON.stringify(rows.models[0]!.model_json).includes("scce.segmentation_graph.storage.v1")).toBe(true);
    expect((await adapter.inducedLanguageModels.readById(model.id))!.model).toEqual(model);
    expect((await adapter.inducedLanguageModels.listRecent())[0]!.model).toEqual(model);
    const input = { id: "event.genuine.creative", episodeId: "episode.owned", typeId: "InducedLanguageModelPersisted", t: 1, parents: [],
      payload: { memoryProjection: { patterns } } } as unknown as Omit<ScceEvent, "hash">;
    const event = { ...input, hash: hashEvent(input, [], hasher) };
    await adapter.events.append(event);
    expect(state.inserted).toBe(count);
    expect(components.get("creative_event_occurrences")!.size).toBe(patterns.length);
    expect(JSON.stringify(rows.events[0]!.payload_json).includes(CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA)).toBe(true);
    const restored = (await adapter.events.readEpisode(event.episodeId))[0]!;
    expect(restored).toEqual(event);
    expect(hashEvent(restored, [], hasher)).toBe(event.hash);
    expect((await adapter.events.readRange({ episodeId: event.episodeId }))[0]).toEqual(event);
    await adapter.events.append(event);
    expect(rows.events).toHaveLength(1);
    expect(state.inserted).toBe(count);
  });

  it("rejects changed canonical owners, inaccessible labels, missing components and understated decoded budgets", async () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => { f.state.source = { ...owner, sourceVersionId: "foreign.version" }; },
      (f: ReturnType<typeof fixture>) => { f.state.source = { ...owner, evidenceContentHash: "changed.hash" }; },
      (f: ReturnType<typeof fixture>) => { f.state.source = { ...owner, sourceContentHash: "changed.raw.source.hash" }; },
      (f: ReturnType<typeof fixture>) => { f.state.sourceLabel = { ...label, tenantId: "tenant.foreign", exportClass: "restricted", principals: ["foreign"] }; },
      (f: ReturnType<typeof fixture>) => { f.components.get("creative_event_lexemes")!.clear(); },
      (f: ReturnType<typeof fixture>) => { object(object(f.rows.patterns[0]!.pattern_json)[LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY]).decodedJsonBytes = 1; }
    ]) {
      const f = fixture(); await f.adapter.languageMemory.putLanguagePattern(patterns[0]!); mutate(f);
      let rejected: unknown;
      try { await f.adapter.languageMemory.listLanguagePatterns({ patternIds: [patterns[0]!.id] }); } catch (error) { rejected = error; }
      expect(rejected).toBeInstanceOf(Error);
    }
    const f = fixture(); f.state.promoted = false;
    await expect(f.adapter.languageMemory.putLanguagePattern(patterns[0]!)).rejects.toThrow("source owner missing");
    expect([...f.components.values()].every(rows => rows.size === 0)).toBe(true);
  });

  it("preserves array-root event payloads and their immutable public hashes", async () => {
    const { adapter, rows } = fixture();
    const input = { id: "event.genuine.array", episodeId: "episode.array", typeId: "InducedLanguageModelPersisted", t: 1, parents: [],
      payload: patterns.map(pattern => pattern.patternJson) } as unknown as Omit<ScceEvent, "hash">;
    const event = { ...input, hash: hashEvent(input, [], hasher) };
    await adapter.events.append(event);
    expect(JSON.stringify(rows.events[0]!.payload_json).includes(CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA)).toBe(true);
    const restored = (await adapter.events.readEpisode(event.episodeId))[0]!;
    expect(restored).toEqual(event);
    expect(Array.isArray(restored.payload)).toBe(true);
    expect(hashEvent(restored, [], hasher)).toBe(event.hash);
  });

  it("shares pure definitions across independent owner scopes while retaining all contextual identities", () => {
    const bundle = object(object(patterns[0]!.patternJson).bundle), owners = new Map([[creativeEventStorageJson([owner.profileId, owner.evidenceId]), owner]]);
    const first = normalizeCreativeEventPage({ bundle, owners });
    const secondOwner = { ...owner, profileId: "profile.independent", sourceId: "source.independent", sourceVersionId: "version.independent", evidenceId: "evidence.independent" };
    const secondBundle = { ...bundle, profileId: secondOwner.profileId, events: (bundle.events as Parameters<typeof deriveUniversalCreativeEvent>[0][])
      .map(event => deriveUniversalCreativeEvent({ ...event, profileId: secondOwner.profileId, sourceVersionId: secondOwner.sourceVersionId, evidenceId: secondOwner.evidenceId }, hasher)) };
    const second = normalizeCreativeEventPage({ bundle: secondBundle, owners: new Map([[creativeEventStorageJson([secondOwner.profileId, secondOwner.evidenceId]), secondOwner]]) });
    expect(second.records.creative_event_templates.map(row => row.id)).toEqual(first.records.creative_event_templates.map(row => row.id));
    expect(second.records.creative_event_lexemes.map(row => row.id)).toEqual(first.records.creative_event_lexemes.map(row => row.id));
    expect(second.reference.pageId).not.toBe(first.reference.pageId);
    const records = new Map<string, CreativeEventDomainRecord>();
    for (const rows of Object.values(second.records)) for (const row of rows) records.set(row.id, cold(row));
    expect(reconstructCreativeEventPage({ reference: second.reference, records })).toEqual(secondBundle.events);
  });

  it("preserves Unicode, NUL and future JSON extensions without repairing noncanonical identities", () => {
    const bundle = cold(object(object(patterns[0]!.patternJson).bundle)), events = bundle.events as Parameters<typeof deriveUniversalCreativeEvent>[0][];
    const changed = { ...events[0]!, futureData: JSON.parse('{"__proto__":"owned","text":"雪🧭\\u0000","values":[false,null,12.5]}'),
      argumentFrame: { ...events[0]!.argumentFrame, futureFrame: { retained: true } } };
    events[0] = deriveUniversalCreativeEvent(changed, hasher);
    const owners = new Map([[creativeEventStorageJson([owner.profileId, owner.evidenceId]), owner]]), plan = normalizeCreativeEventPage({ bundle, owners });
    const records = new Map<string, CreativeEventDomainRecord>();
    for (const rows of Object.values(plan.records)) for (const row of rows) records.set(row.id, cold(row));
    const restored = reconstructCreativeEventPage({ reference: plan.reference, records });
    expect(creativeEventStorageJson(restored)).toBe(creativeEventStorageJson(events));
    object(restored[0]!.futureData).text = "changed";
    expect(creativeEventStorageJson(reconstructCreativeEventPage({ reference: plan.reference, records }))).toBe(creativeEventStorageJson(events));
    const invalid = cold(bundle); object((invalid.events as unknown[])[0]).id = "forged";
    expect(() => normalizeCreativeEventPage({ bundle: invalid, owners })).toThrow("noncanonical");
    object((invalid.events as unknown[])[0]).compilerId = "compiler.unknown";
    expect(() => normalizeCreativeEventPage({ bundle: invalid, owners })).toThrow("unsupported");
  });

  it("declares only four typed canonical tables and keeps their source-owned witness and occurrence labels", () => {
    const ddl = canonicalCreativeEventSchemaStatements('"test"');
    expect(ddl).toHaveLength(4);
    for (const table of CREATIVE_EVENT_NORMALIZATION_TABLES) expect(ddl.some(sql => sql.includes(`.${table} (`))).toBe(true);
    expect(ddl.filter(sql => sql.includes("information_label JSONB NOT NULL"))).toHaveLength(2);
    expect(ddl.every(sql => sql.includes("PRIMARY KEY") && sql.includes("CHECK(kind="))).toBe(true);
    expect(CREATIVE_EVENT_NORMALIZATION_SCHEMA).toBe("scce.creative_event_normalization.v1");
  });
});
