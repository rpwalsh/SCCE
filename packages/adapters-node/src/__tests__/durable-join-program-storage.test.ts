// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { canonicalDigestHex, canonicalStringify, createHasher, hashEvent, joinProgramMixtureStorageForm, type JoinProgramMixture, type JsonValue, type ScceEvent } from "@scce/kernel";
import { decodeDurableJoinPrograms, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA,
  durableJoinProgramJsonByteLengths, encodeDurableJoinPrograms } from "../durable-join-program-storage.js";
import { PostgresStorageAdapter } from "../postgres.js";

function fixture(): JoinProgramMixture {
  const coordinate = { evidenceId: "evidence.owned", sourceVersionId: "version.owned", documentId: "document.owned", byteStart: 1, byteEnd: 2, utf16Start: 1, utf16End: 2, exactSurfaceHash: "hash.exact" };
  const choice = { surface: " ", count: 1, probability: 1, evidenceIds: [coordinate.evidenceId], evidenceCoordinates: [coordinate] };
  const entries = Array.from({ length: 64 }, (_, index) => [JSON.stringify([`surface.${index}`, "shared", "class.shared", "scale.shared"]), [choice]]);
  const indexes = Object.fromEntries(["conditionedIndex", "exactIndex", "structuralIndex", "classIndex", "localShapeIndex", "constructionIndex"].map(name => [name, Object.fromEntries(entries)]));
  return JSON.parse(JSON.stringify({ schema: "scce.join_program_mixture.v3", id: "mixture.owned", populationModelId: "population.owned", minimumConfidence: 0,
    retainedMetadata: { text: "\u{1f600}\u0000", zero: 0, nullable: null }, components: [{ populationId: "population.owned", weight: 1, retainedMetadata: [false, "雪"], program: {
      schema: "scce.join_program.v3", id: "program.owned", populationId: "population.owned", observations: 64, minimumConfidence: 0,
      ...indexes, backoffReliability: { conditioned: 1, exact: 1, structural: 1, class: 1, local_shape: 1, construction: 1 }, sourceDocumentIds: ["document.owned"], trainingDocumentIds: ["document.owned"],
      evaluation: { heldoutDocumentIds: [], selectionDocumentIds: [], observations: 0, exactAccuracy: null, negativeLogLikelihood: null, expectedCalibrationError: null, reconstructionAccuracy: null, whitespaceInsertionErrors: 0, whitespaceDeletionErrors: 0, punctuationErrors: 0, crossScriptAccuracy: null }, audit: { retained: true }
    } }] })) as JoinProgramMixture;
}

const cold = (value: unknown): unknown => JSON.parse(JSON.stringify(value));
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
const digest = (value: unknown): string => createHasher().digestHex(canonicalStringify(value));

describe("durable JOIN representation", () => {
  it("packs cold raw mixtures nested in aggregate payloads and restores every logical field", () => {
    const mixture = fixture();
    const value = { memoryProjection: { patterns: [{ patternJson: { joinProgram: mixture } }] }, model: { joinProgram: mixture }, metadata: { retained: null } };
    const encoded = encodeDurableJoinPrograms(value);
    expect(bytes(encoded)).toBeLessThan(bytes(value) / 2);
    expect(JSON.stringify(encoded)).toContain(DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA);
    const decoded = decodeDurableJoinPrograms(cold(encoded));
    expect(decoded).toEqual(value);
    expect(digest(decoded)).toBe(digest(value));
    expect(encodeDurableJoinPrograms(encoded)).toBe(encoded);
    expect(value.model.joinProgram).toEqual(mixture);
  });

  it("leaves intentionally packed public values, unrelated schemas, and malformed lookalikes unchanged", () => {
    const value = { joinProgram: joinProgramMixtureStorageForm(fixture()), other: { schema: "arbitrary.schema", components: [] }, malformed: { schema: "scce.join_program_mixture.v3", id: "lookalike" } };
    expect(encodeDurableJoinPrograms(value)).toBe(value);
    expect(decodeDurableJoinPrograms(cold(value))).toEqual(value);
  });

  it("does not discard unrecognized choice or coordinate fields", () => {
    for (const field of ["choice", "coordinate"]) {
      const mixture = fixture();
      const choice = Object.values(mixture.components[0]!.program.exactIndex)[0]![0]!;
      Object.assign(field === "choice" ? choice : choice.evidenceCoordinates[0]!, { extensionMetadata: { retained: true } });
      expect(encodeDurableJoinPrograms(mixture)).toBe(mixture);
      expect(decodeDurableJoinPrograms(cold(encodeDurableJoinPrograms(mixture)))).toEqual(mixture);
    }
  });

  it("rejects corrupt storage markers instead of returning a changed logical artifact", () => {
    expect(() => decodeDurableJoinPrograms({ schema: DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA, mixture: {} })).toThrow();
    expect(() => decodeDurableJoinPrograms({ schema: DURABLE_JOIN_PROGRAM_STORAGE_SCHEMA, mixture: fixture() })).toThrow();
  });

  it("accounts for JSONB separator spaces, exponent expansion, Unicode and prototype-like keys", () => {
    const value = JSON.parse('{"__proto__":"owned","values":[1e-7,1e21,-1e-7,"雪"]}');
    const jsonb = '{"__proto__": "owned", "values": [0.0000001, 1000000000000000000000, -0.0000001, "雪"]}';
    expect(durableJoinProgramJsonByteLengths(value)).toEqual({ decodedJsonBytes: bytes(value), decodedJsonbBytes: Buffer.byteLength(jsonb) });
    expect(durableJoinProgramJsonByteLengths(Number.MIN_VALUE).decodedJsonbBytes).toBe(326);
    expect(durableJoinProgramJsonByteLengths(Number.MAX_VALUE).decodedJsonbBytes).toBe(309);
  });

  it("records decoded size outside arbitrary nested mixtures and preserves caller ledger collisions", () => {
    const value = { schema: "arbitrary.schema", nested: [{ mixture: fixture() }] };
    const encoded = encodeDurableJoinPrograms(value) as Record<string, unknown>;
    const ledger = encoded[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY] as Record<string, unknown>;
    expect(ledger).toEqual({ schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...durableJoinProgramJsonByteLengths(value) });
    expect(Number(ledger.decodedJsonbBytes)).toBeGreaterThan(bytes(encoded));
    expect(decodeDurableJoinPrograms(cold(encoded))).toEqual(value);
    const collision = { ...value, [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: { retainedCallerData: true } };
    expect(encodeDurableJoinPrograms(collision)).toBe(collision);
    expect(decodeDurableJoinPrograms(cold(collision))).toEqual(collision);
  });

  it.runIf(Boolean(process.env.SCCE_JOIN_STORAGE_SAMPLE))("normalizes the captured large syntax artifact without changing its canonical hash", async () => {
    const row = JSON.parse(await readFile(process.env.SCCE_JOIN_STORAGE_SAMPLE!, "utf8")) as { pattern_json: JsonValue };
    const original = row.pattern_json;
    const hash = canonicalDigestHex(original, createHasher());
    const encoded = encodeDurableJoinPrograms(original);
    const beforeBytes = bytes(original), encodedBytes = bytes(encoded);
    expect(encodedBytes).toBeLessThan(beforeBytes / 2);
    const decoded = decodeDurableJoinPrograms(cold(encoded));
    expect(canonicalDigestHex(decoded, createHasher())).toBe(hash);
    console.log(JSON.stringify({ schema: "scce.join_storage_sample_roundtrip.v1", beforeBytes, encodedBytes, ...durableJoinProgramJsonByteLengths(original), canonicalHashPreserved: true }));
  });
});

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

describe("Postgres JOIN storage boundaries", () => {
  const label = { tenantId: "tenant.owned", principals: [], compartments: [], exportClass: "public" as const, mergePolicy: "isolated" as const };

  it("normalizes pattern cold writes and decodes list reads", async () => {
    const { adapter, rows } = offlineStorage();
    const pattern = { id: "pattern.owned", profileId: "profile.owned", patternKind: "syntax" as const, support: 1, entropy: 0, evidenceIds: [], updatedAt: 1000, informationLabel: label,
      patternJson: { schema: "scce.induced_language_model.syntax_memory.v1", joinProgram: fixture() } as unknown as JsonValue };
    await adapter.languageMemory.putLanguagePattern(pattern);
    expect(bytes(rows.patterns[0]!.pattern_json)).toBeLessThan(bytes(pattern.patternJson) / 2);
    const decoded = await adapter.languageMemory.listLanguagePatterns({ profileIds: [pattern.profileId] });
    expect(decoded[0]!.patternJson).toEqual(pattern.patternJson);
    expect(digest(decoded[0]!.patternJson)).toBe(digest(pattern.patternJson));
  });

  it("normalizes full induced model cold writes and decodes both read APIs", async () => {
    const { adapter, rows } = offlineStorage();
    const model = { id: "induction.owned", corpusDocuments: 1, vocabularySize: 2, joinProgram: fixture() };
    await adapter.inducedLanguageModels.putModel({ id: model.id, model: model as never, trainingPlanId: "plan.owned", createdAt: 1000, informationLabel: label });
    expect(bytes(rows.models[0]!.model_json)).toBeLessThan(bytes(model) / 2);
    expect((await adapter.inducedLanguageModels.readById(model.id))!.model).toEqual(model);
    expect((await adapter.inducedLanguageModels.listRecent())[0]!.model).toEqual(model);
  });

  it("normalizes nested aggregate event payloads while preserving replay hashes and repeated identities", async () => {
    const { adapter, rows } = offlineStorage();
    const event = { id: "event.owned", episodeId: "episode.owned", typeId: "InducedLanguageModelPersisted", t: 1000, parents: [], payload: {
      memoryProjection: { patterns: [{ patternJson: { joinProgram: fixture() } }] }, retained: "owned"
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

  it("uses decoded bytes in the fair category budget while request seeds exclude the JOIN member", async () => {
    const { adapter, calls } = offlineStorage();
    const original = { schema: "scce.induced_language_model.syntax_memory.v1", joinProgram: fixture(), retained: { other: fixture() } };
    const encoded = encodeDurableJoinPrograms(original) as Record<string, unknown>;
    const ledger = encoded[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY] as Record<string, number>;
    const { joinProgram: _join, ...seed } = original;
    expect(ledger.decodedJsonbBytes! - ledger.joinProgramMemberJsonbBytes!).toBe(durableJoinProgramJsonByteLengths(seed).decodedJsonbBytes);
    await adapter.languageMemory.listLanguagePatterns({ maxTotalJsonBytes: bytes(encoded) * 2 });
    const fullSql = calls.at(-1)!;
    expect(fullSql).toContain("pattern.decoded_jsonb_bytes AS decoded_jsonb_bytes");
    expect(fullSql).toContain("SUM(COALESCE(eligible.decoded_jsonb_bytes, octet_length(eligible.pattern_json::text))) OVER (PARTITION BY CASE");
    expect(fullSql).toContain("CEIL(");
    expect(fullSql).toContain("OR ranked.category_relevance_rank = 1");
    await adapter.languageMemory.listLanguagePatterns({ view: "request_seed", maxTotalJsonBytes: bytes(encoded) * 2 });
    const seedSql = calls.at(-1)!;
    expect(seedSql).toContain("NULL::numeric AS decoded_jsonb_bytes");
    expect(seedSql).toContain("jsonb_object_agg(seed_field.key,seed_field.value)");
    expect(seedSql).not.toContain("THEN pattern.pattern_json - 'joinProgram' ELSE pattern.pattern_json END");
    await adapter.languageMemory.listLanguagePatterns({ patternIds: ["pattern.owned"], maxTotalJsonBytes: bytes(encoded) * 2 });
    expect(calls.at(-1)!).toContain("SUM(COALESCE(eligible.decoded_jsonb_bytes, octet_length(eligible.pattern_json::text))) OVER (ORDER BY");
  });
});
