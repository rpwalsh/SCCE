// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { canonicalStringify, CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, createHasher, hashEvent, SEGMENTATION_ADJACENCY_FACTORS_SCHEMA,
  type JsonValue, type ScceEvent } from "@scce/kernel";
import { PostgresStorageAdapter } from "../postgres.js";
import { encodeLanguageArtifacts, languageArtifactJsonByteLengths, LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY } from "../durable-language-artifact-storage.js";
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const digest = (value: unknown): string => createHasher().digestHex(canonicalStringify(value));
const fixture = () => ({ schema: SEGMENTATION_ADJACENCY_FACTORS_SCHEMA, nodeCount: 2001,
  arcs: Array.from({ length: 2000 }, (_, index) => [index, index + 1, index % 3 / 4]) });
const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });

function offlineStorage() {
  const rows = { patterns: [] as Record<string, unknown>[], models: [] as Record<string, unknown>[], events: [] as Record<string, unknown>[] };
  let head: unknown;
  const calls: string[] = [];
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "offline_join", informationAccess: { tenantId: "tenant.owned", principalId: "principal.owned", compartments: [], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  const client = { async query(sql: string, params: readonly unknown[] = []) {
    calls.push(sql);
    if (sql.includes("INSERT INTO") && sql.includes('"language_patterns"')) {
      rows.patterns = JSON.parse(String(params[0])).map((row: Record<string, unknown>) => ({ ...row, evidence_ids: row.evidence_ids_json, updated_at: new Date(Number(row.updated_at_ms)) }));
    } else if (sql.includes("INSERT INTO") && sql.includes('"induced_language_models"')) {
      rows.models = [{ id: params[0], training_plan_id: params[1], model_json: JSON.parse(String(params[2])), information_label: JSON.parse(String(params[5])), created_at: new Date(Number(params[6])) }];
    } else if (sql.includes("INSERT INTO") && sql.includes("(id, episode_id")) {
      const [id, episode_id, type_id, t, payload, parents, hash, ledger_hash] = params;
      rows.events.push({ id, episode_id, type_id, t, payload_json: JSON.parse(String(payload)), parents, hash, ledger_hash });
    } else if (sql.includes("INSERT INTO") && sql.includes("storage_meta")) head = JSON.parse(String(params[1]));
    if (sql.startsWith("SELECT value_json")) return { rows: head ? [{ value_json: head }] : [] };
    if (sql.startsWith("SELECT id, hash")) return { rows: rows.events.filter(row => (params[0] as string[]).includes(String(row.id))) };
    if (sql.startsWith("SELECT id, information_label")) return { rows: [] };
    if (!sql.includes("INSERT INTO") && sql.includes('"induced_language_models"')) return { rows: rows.models };
    if (sql.includes("pattern_headers AS MATERIALIZED")) return { rows: rows.patterns };
    if (sql.startsWith("SELECT *") && sql.includes('"events"')) return { rows: rows.events };
    return { rows: [] };
  }, release() {} };
  (adapter.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => client;
  (adapter.pool as unknown as { query: typeof client.query }).query = client.query;
  return { adapter, rows, calls };
}

describe("Postgres complete language artifact boundaries", () => {
  const label = { tenantId: "tenant.owned", principals: [], compartments: [], exportClass: "public" as const, mergePolicy: "isolated" as const };

  it("rejects unowned noncanonical creative event lookalikes before canonical records are published", async () => {
    const { adapter, rows } = offlineStorage();
    const page = { schema: CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, contentDigest: "unowned", bundle: {
      schema: CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, profileId: "profile.unowned", compilerId: "compiler.unowned",
      events: Array.from({ length: 64 }, (_, index) => ({ id: `event.${index}`, profileId: "profile.unowned", evidenceId: "evidence.unowned" })) } };
    await expect(adapter.languageMemory.putLanguagePattern({ id: "pattern.unowned", profileId: "profile.unowned", patternKind: "semantic_role",
      support: 64, entropy: 0, evidenceIds: [], updatedAt: 1000, informationLabel: label, patternJson: page })).rejects.toThrow("source owner missing");
    expect(rows.patterns).toEqual([]);
  });
  it("normalizes pattern cold writes and decodes list reads", async () => {
    const { adapter, rows } = offlineStorage();
    const pattern = { id: "pattern.owned", profileId: "profile.owned", patternKind: "syntax" as const, support: 1, entropy: 0, evidenceIds: [], updatedAt: 1000, informationLabel: label,
      patternJson: { schema: "scce.induced_language_model.syntax_memory.v1", graph: fixture() } as unknown as JsonValue };
    await adapter.languageMemory.putLanguagePattern(pattern);
    expect(bytes(rows.patterns[0]!.pattern_json)).toBeLessThan(bytes(pattern.patternJson) / 2);
    const decoded = await adapter.languageMemory.listLanguagePatterns({ profileIds: [pattern.profileId] });
    expect(decoded[0]!.patternJson).toEqual(pattern.patternJson);
    expect(digest(decoded[0]!.patternJson)).toBe(digest(pattern.patternJson));
  });

  it("preserves complete geometry, source bindings and ACL through pattern cold writes", async () => {
    const { adapter, rows } = offlineStorage();
    const pattern = { id: "pattern.factor.owned", profileId: "profile.factor.owned", patternKind: "syntax" as const,
      support: 1, entropy: 0, evidenceIds: ["evidence.factor.owned" as never], updatedAt: 1000, informationLabel: label,
      patternJson: { schema: "scce.induced_language_model.syntax_memory.v1", sourceVersionId: "version.factor.owned", graph: fixture() } as unknown as JsonValue };
    await adapter.languageMemory.putLanguagePattern(pattern);
    const decoded = await adapter.languageMemory.listLanguagePatterns({ profileIds: [pattern.profileId] });
    expect(decoded[0]!.patternJson).toEqual(pattern.patternJson);
    expect(decoded[0]!.informationLabel).toEqual(label); expect(decoded[0]!.evidenceIds).toEqual(pattern.evidenceIds);
    expect((rows.patterns[0]!.pattern_json as Record<string, unknown>)[LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY])
      .toMatchObject(languageArtifactJsonByteLengths(pattern.patternJson));
  });

  it("normalizes full induced model cold writes and decodes both read APIs", async () => {
    const { adapter, rows } = offlineStorage();
    const model = { id: "induction.owned", corpusDocuments: 1, vocabularySize: 2, graph: fixture() };
    await adapter.inducedLanguageModels.putModel({ id: model.id, model: model as never, trainingPlanId: "plan.owned", createdAt: 1000, informationLabel: label });
    expect(bytes(rows.models[0]!.model_json)).toBeLessThan(bytes(model) / 2);
    expect((await adapter.inducedLanguageModels.readById(model.id))!.model).toEqual(model);
    expect((await adapter.inducedLanguageModels.listRecent())[0]!.model).toEqual(model);
  });

  it("normalizes nested aggregate event payloads while preserving replay hashes and repeated identities", async () => {
    const { adapter, rows } = offlineStorage();
    const event = { id: "event.owned", episodeId: "episode.owned", typeId: "InducedLanguageModelPersisted", t: 1000, parents: [], payload: {
      memoryProjection: { patterns: [{ patternJson: { graph: fixture() } }] }, retained: "owned"
    } } as unknown as Omit<ScceEvent, "hash">;
    const original = { ...event, hash: hashEvent(event, [], createHasher()) };
    await adapter.events.append(original);
    expect(bytes(rows.events[0]!.payload_json)).toBeLessThan(bytes(original.payload) / 2);
    const decoded = (await adapter.events.readEpisode(original.episodeId))[0]!;
    expect(decoded).toEqual(original);
    expect((await adapter.events.readRange({ episodeId: original.episodeId }))[0]).toEqual(original);
    expect(hashEvent(decoded, [], createHasher())).toBe(original.hash);
    await adapter.events.append(original);
    expect(rows.events).toHaveLength(1);
  });

  it("charges complete decoded bodies while request seeds read only their declared headers", async () => {
    const { adapter, calls } = offlineStorage();
    const original = { schema: "scce.induced_language_model.syntax_memory.v1", graph: fixture(), retained: { other: fixture() } };
    const encoded = encodeLanguageArtifacts(original) as Record<string, unknown>;
    expect(encoded[LANGUAGE_ARTIFACT_BYTE_LEDGER_KEY]).toMatchObject(languageArtifactJsonByteLengths(original));
    await adapter.languageMemory.listLanguagePatterns({ maxTotalJsonBytes: bytes(encoded) * 2 });
    const fullSql = calls.at(-1)!;
    expect(fullSql).toContain("pattern.decoded_jsonb_bytes AS decoded_jsonb_bytes");
    expect(fullSql).toContain("SUM(COALESCE(eligible.decoded_jsonb_bytes, octet_length(eligible.pattern_json::text))) OVER (PARTITION BY CASE");
    expect(fullSql).toContain("CEIL(");
    expect(fullSql).toContain("OR ranked.category_relevance_rank = 1");
    await adapter.languageMemory.listLanguagePatterns({ view: "request_seed", maxTotalJsonBytes: bytes(encoded) * 2 });
    const seedSql = calls.at(-1)!;
    expect(seedSql).toContain("CASE WHEN pattern.pattern_schema='scce.request_requirement_pattern.v1' THEN pattern.decoded_jsonb_bytes ELSE NULL::numeric END AS decoded_jsonb_bytes");
    expect(seedSql).toContain("jsonb_object_agg(seed_field.key,seed_field.value)");
    await adapter.languageMemory.listLanguagePatterns({ patternIds: ["pattern.owned"], maxTotalJsonBytes: bytes(encoded) * 2 });
    expect(calls.at(-1)!).toContain("SUM(COALESCE(eligible.decoded_jsonb_bytes, octet_length(eligible.pattern_json::text))) OVER (ORDER BY");
  });
});
