// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { createClock, createHasher, createIdFactory, createLanguageMemoryRuntime, exportNgramModelTrainingReplay, informationLabelAllowsRead,
  type JsonValue, type LanguageProfile, type NgramModelRecord } from "@scce/kernel";
import { pooledProfileOwnerFixture } from "../../../kernel/src/__tests__/fixtures/pooled-profile-owner.js";
import { PostgresStorageAdapter } from "../postgres.js";
import { NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA } from "../ngram-model-training-replay-storage.js";
import { DECODED_JSON_BYTE_LEDGER_KEY } from "../decoded-json-byte-ledger.js";

const label = { tenantId: "fixture", principals: ["operator"], compartments: [], exportClass: "restricted" as const, mergePolicy: "same_owner" as const };
const access = { tenantId: "fixture", principalId: "operator", compartments: [], maximumExportClass: "restricted" as const };
const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });
const object = (value: JsonValue): Record<string, JsonValue> => value && typeof value === "object" && !Array.isArray(value) ? value : {};
interface StoredModel { id: string; stream_id: string; language_hint: string; max_order: number; discount: number; model_json: JsonValue;
  updated_at_ms: number; information_label: typeof label }

async function fixture() {
  const source = pooledProfileOwnerFixture(["oma vela. oma neri.", "oma neri. oma vela."]);
  const direct = { ...source.pages[0]!.profile, informationLabel: label }, pooled = { ...source.owned, informationLabel: label };
  const profiles = new Map<string, LanguageProfile>(), models = new Map<string, StoredModel>();
  const current = { parents: true, source: true };
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "ngram_owned", informationAccess: access }); adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.transaction = async work => work();
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.endsWith(" AS accepted")) return [{ accepted: true }] as T[];
    if (sql.startsWith('INSERT INTO "ngram_owned"."language_profiles"')) {
      for (const row of JSON.parse(String(params[0])) as Array<{ profile_json: LanguageProfile }>) profiles.set(row.profile_json.id, row.profile_json);
    }
    if (sql.startsWith('INSERT INTO "ngram_owned"."ngram_models"')) for (const row of JSON.parse(String(params[0])) as StoredModel[]) models.set(row.id, row);
    if (!sql.startsWith('SELECT * FROM "ngram_owned"."ngram_models" model')) return [];
    const requested = sql.includes("model.profile_id=ANY($1::text[])") ? params[0] as string[] : undefined;
    const guarded = sql.includes("model_profile.id=model.profile_id");
    const allowsAbsent = !guarded || sql.includes("NOT EXISTS (SELECT 1 FROM \"ngram_owned\".\"language_profiles\" known_profile");
    return [...models.values()].filter(row => {
      const id = object(row.model_json).profileId;
      if (requested && (typeof id !== "string" || !requested.includes(id))) return false;
      if (!informationLabelAllowsRead(row.information_label, access)) return false;
      const profile = typeof id === "string" ? profiles.get(id) : undefined;
      if (!profile) return allowsAbsent;
      if (sql.includes("model_profile.information_label") && !informationLabelAllowsRead(profile.informationLabel!, access)) return false;
      if (!guarded) return true;
      if (profile.sourceVersionId === direct.sourceVersionId) return current.source && sql.includes("sv.id=model_profile.source_version_id");
      return current.parents && Boolean(profile.pooledSourceBinding) && sql.includes("scce.pooled_language_profile_ownership.v1")
        && sql.includes("pooled_evidence.status='promoted'") && sql.includes("pooled_newer.source_id=pooled_parent.source_id");
    }).map(row => ({ ...row, updated_at: new Date(row.updated_at_ms) })) as T[];
  };
  const hasher = createHasher(), runtime = createLanguageMemoryRuntime({ hasher, idFactory: createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true }) });
  const produce = (profile: LanguageProfile, text: string): NgramModelRecord => ({ ...runtime.train({ streamId: `fixture://${profile.id}`, sourceSystem: "wikipedia",
    profile, text, sourceVersionId: profile.sourceVersionId, evidence: profile.id === direct.id ? source.pages[0]!.evidence : source.evidence,
    createdAt: 1, retainObservations: false }).models[0]!, informationLabel: label });
  const directModel = produce(direct, source.pages[0]!.text), pooledModel = produce(pooled, source.text);
  await adapter.model.putLanguageProfiles!([direct, pooled]);
  await adapter.languageMemory.putNgramModels!([directModel, pooledModel]);
  return { adapter, profiles, models, current, direct, pooled, directModel, pooledModel, calls };
}

it("cold-reads actual producer models only through accessible direct or verified pooled owners and indexed profile filtering", async () => {
  const f = await fixture();
  const stored = object(f.models.get(f.directModel.id)!.model_json), storedModel = object(stored.model ?? null);
  expect(storedModel.schema).toBe(NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA);
  expect(storedModel.counts).toBeUndefined();
  expect(object(stored[DECODED_JSON_BYTE_LEDGER_KEY] ?? null).decodedJsonbBytes).toBeGreaterThan(JSON.stringify(stored).length);
  const cold = await f.adapter.languageMemory.listNgramModels({ sourceSystem: "wikipedia" });
  expect(cold.map(row => row.id).sort()).toEqual([f.directModel.id, f.pooledModel.id].sort());
  const coldDirect = cold.find(row => row.id === f.directModel.id)!;
  expect(coldDirect.modelJson).toEqual(f.directModel.modelJson);
  expect(exportNgramModelTrainingReplay(coldDirect)).toBeDefined();
  await f.adapter.languageMemory.putNgramModel(coldDirect);
  const rewritten = object(f.models.get(f.directModel.id)!.model_json), rewrittenModel = object(rewritten.model ?? null);
  expect(rewrittenModel.schema).toBe(NGRAM_MODEL_TRAINING_REPLAY_STORAGE_SCHEMA);
  expect(rewrittenModel.vocabularyPartition).toBeDefined();
  expect(rewrittenModel.bigramCountTriples).toBeUndefined();
  expect(rewrittenModel.counts).toBeUndefined();
  expect((await f.adapter.languageMemory.listNgramModels({ profileIds: [f.direct.id], limit: 7 })).map(row => row.id)).toEqual([f.directModel.id]);
  const sql = f.calls.at(-1)!.sql;
  expect(sql).toContain("model.profile_id=ANY($1::text[])"); expect(f.calls.at(-1)!.params[0]).toEqual([f.direct.id]);
  expect(sql).not.toContain("known_profile"); expect(sql).not.toContain("model.model_json->>'profileId'");
});

it.each(["missing", "inaccessible", "stale-pooled", "missing-source", "null"] as const)("refuses actual producer content when its owner becomes %s", async failure => {
  const f = await fixture();
  if (failure === "missing") f.profiles.delete(f.direct.id);
  if (failure === "inaccessible") f.profiles.set(f.direct.id, { ...f.direct, informationLabel: { ...label, principals: ["different-operator"] } });
  if (failure === "stale-pooled") f.current.parents = false;
  if (failure === "missing-source") f.current.source = false;
  if (failure === "null") await f.adapter.languageMemory.putNgramModel({ ...f.directModel, modelJson: { ...object(f.directModel.modelJson), profileId: null } });
  const rejected = failure === "stale-pooled" ? f.pooledModel : f.directModel;
  expect((await f.adapter.languageMemory.listNgramModels({ sourceSystem: "wikipedia" })).some(row => row.id === rejected.id)).toBe(false);
});
