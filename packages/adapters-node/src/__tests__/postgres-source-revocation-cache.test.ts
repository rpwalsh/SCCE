// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it } from "vitest";
import { buildLanguageProfileClusters, createClock, createHasher, createIdFactory, createLanguageMemoryRuntime, informationLabelAllowsRead,
  type InformationLabel, type ScceKernelDeps, type SourceVersion } from "@scce/kernel";
import { createSurfaceLanguageRuntime } from "../../../kernel/src/surface-language-runtime.js";
import { pooledProfileOwnerFixture } from "../../../kernel/src/__tests__/fixtures/pooled-profile-owner.js";
import { PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { for (const adapter of adapters.splice(0)) await adapter.close(); });

it("drops a warm acquired model after its source owner restricts access, matching a cold scoped read", async () => {
  const owner = pooledProfileOwnerFixture(["oma vela. oma neri. oma vela."]);
  const page = owner.pages[0]!, span = page.evidence[0]!;
  const label: InformationLabel = { tenantId: "fixture", principals: ["operator"], compartments: [], exportClass: "restricted", mergePolicy: "same_owner" };
  const readerAccess = { tenantId: "fixture", principalId: "operator", compartments: [], maximumExportClass: "restricted" as const };
  const profile = { ...page.profile, informationLabel: label };
  const memory = createLanguageMemoryRuntime({ hasher: owner.hasher,
    idFactory: createIdFactory({ hasher: owner.hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true }) });
  const model = { ...memory.train({ streamId: "fixture://source-cache", sourceSystem: "wikipedia", profile,
    text: page.text, sourceVersionId: profile.sourceVersionId, evidence: page.evidence, createdAt: 1, retainObservations: false }).models[0]!, informationLabel: label };
  const source: SourceVersion = { sourceId: span.sourceId, sourceVersionId: span.sourceVersionId, namespace: "fixture",
    canonicalUri: "fixture://source-cache", contentHash: span.contentHash, byteLength: Buffer.byteLength(page.text), mediaType: "text/plain",
    observedAt: 1, sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
      independenceGroup: String(span.sourceId), accessScope: "fixture", licenseStatus: "fixture" }, informationLabel: label, metadata: {} };
  let committed = { sourceLabel: label, revision: 0n };
  const statements: string[] = [];
  function adapter(admin: boolean) {
    const result = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "revocation_cache",
      informationAccess: admin ? { ...readerAccess, compartments: ["private"] } : readerAccess });
    adapters.push(result);
    let pending: typeof committed | undefined;
    const query = async (sql: string, params: readonly unknown[] = []) => {
      statements.push(sql);
      if (sql === "BEGIN") { pending = structuredClone(committed); return { rows: [] }; }
      if (sql === "COMMIT") { committed = pending!; pending = undefined; return { rows: [] }; }
      if (sql === "ROLLBACK") { pending = undefined; return { rows: [] }; }
      const state = pending ?? committed;
      if (sql.includes("AS revision(key,value_json")) { state.revision++; return { rows: [] }; }
      if (sql.startsWith("SELECT value_json #>>")) return { rows: [{ revision: String(state.revision) }] };
      if (sql.includes('FROM "revocation_cache"."source_versions"') && sql.includes("FOR UPDATE")) return { rows: [{ id: source.sourceVersionId, information_label: state.sourceLabel }] };
      if (sql.includes('INSERT INTO "revocation_cache"."source_versions"')) {
        const next = JSON.parse(String(params[8])) as InformationLabel;
        const changed = JSON.stringify(next) !== JSON.stringify(state.sourceLabel);
        state.sourceLabel = next;
        return { rows: changed && sql.includes("AS language_memory_changed") ? [{ language_memory_changed: 1 }] : [] };
      }
      if (sql.includes('FROM "revocation_cache"."ngram_models" model') && (sql.includes("AS stored_bytes")
        || sql.includes("AS json_bytes") || sql.startsWith('SELECT * FROM "revocation_cache"."ngram_models"'))) {
        if (!sql.includes("AS json_bytes")) {
          expect(sql).toContain("sv.id=model_profile.source_version_id");
          expect(sql).toContain("sv.information_label");
          if (!informationLabelAllowsRead(state.sourceLabel, readerAccess)) return { rows: [] };
        }
        return { rows: [{ id: model.id, stream_id: model.streamId, language_hint: model.languageHint, max_order: model.maxOrder,
          discount: model.discount, model_json: model.modelJson, updated_at: new Date(model.updatedAt), information_label: label,
          stored_bytes: "1000", json_bytes: "1000" }] };
      }
      return { rows: [] };
    };
    (result.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => ({ query, release() {} });
    (result.pool as unknown as { query: typeof query }).query = query;
    return result;
  }
  const writer = adapter(true), reader = adapter(false);
  await writer.evidence.putSourceVersion(source);
  const runtime = () => createSurfaceLanguageRuntime({ deps: { storage: reader as unknown as ScceKernelDeps["storage"] },
    languageMemoryRuntime: memory, hasher: createHasher(), clock: createClock({ fixedTime: 1 }), cacheMs: 100_000, profileLimit: 32 });
  const warm = runtime(), cluster = buildLanguageProfileClusters([profile])[0]!;
  const before = await warm.hydrateSurfaceLanguageMemoryCached(12, cluster);
  expect(before.state.models).toHaveLength(1);
  const revision = await reader.languageMemory.readRevision!();
  await writer.evidence.putSourceVersion(source);
  expect(await reader.languageMemory.readRevision!()).toBe(revision);
  await expect(writer.transaction(async () => {
    await writer.evidence.putSourceVersion({ ...source, informationLabel: { ...label, compartments: ["private"] } });
    throw new Error("abort restriction");
  })).rejects.toThrow("abort restriction");
  expect(await reader.languageMemory.readRevision!()).toBe(revision);
  expect(informationLabelAllowsRead(committed.sourceLabel, readerAccess)).toBe(true);
  await warm.synchronizeWithStorage();
  expect((await warm.hydrateSurfaceLanguageMemoryCached(12, cluster)).state).toBe(before.state);
  await writer.evidence.putSourceVersion({ ...source, informationLabel: { ...label, compartments: ["private"] } });
  expect(await reader.languageMemory.readRevision!()).not.toBe(revision);
  expect(informationLabelAllowsRead(committed.sourceLabel, readerAccess)).toBe(false);
  expect(await reader.languageMemory.listNgramModels({ profileIds: [profile.id] })).toEqual([]);
  await warm.synchronizeWithStorage();
  const after = await warm.hydrateSurfaceLanguageMemoryCached(12, cluster);
  const cold = await runtime().hydrateSurfaceLanguageMemoryCached(12, cluster);
  expect(cold.state.models).toHaveLength(0);
  expect(after.state.models).toHaveLength(0);
  expect(statements.some(sql => sql.includes("AS revision(key,value_json"))).toBe(true);
});

it("coalesces actual evidence changes, preserves promoted replay and matched promotion counts, and rolls back restrictions", async () => {
  const owner = pooledProfileOwnerFixture(["oma vela. oma neri."]);
  const label: InformationLabel = { tenantId: "fixture", principals: ["operator"], compartments: [], exportClass: "restricted", mergePolicy: "same_owner" };
  const span = { ...owner.evidence[0]!, informationLabel: label, status: "quarantined" as const };
  type EvidenceRow = { id: string; status: string; information_label: InformationLabel; alpha: number; trust_vector: object; provenance_json: object; features: string[] };
  type State = { revision: bigint; rows: Map<string, EvidenceRow> };
  let committed: State = { revision: 0n, rows: new Map() }, pending: State | undefined;
  const adapter = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "evidence_revision",
    informationAccess: { tenantId: "fixture", principalId: "operator", compartments: ["private"], maximumExportClass: "restricted" } });
  adapters.push(adapter);
  const query = async (sql: string, params: readonly unknown[] = []) => {
    if (sql === "BEGIN") { pending = structuredClone(committed); return { rows: [] }; }
    if (sql === "COMMIT") { committed = pending!; pending = undefined; return { rows: [] }; }
    if (sql === "ROLLBACK") { pending = undefined; return { rows: [] }; }
    const state = pending ?? committed;
    if (sql.includes("AS revision(key,value_json")) { state.revision++; return { rows: [] }; }
    if (sql.startsWith("SELECT value_json #>>")) return { rows: [{ revision: String(state.revision) }] };
    if (sql.includes("FOR UPDATE") && sql.startsWith("SELECT id, information_label")) return { rows: [...state.rows.values()] };
    if (sql.includes("AS admission_changed")) {
      expect(sql).toContain("FOR UPDATE");
      return { rows: (params[0] as string[]).flatMap(id => {
        const row = state.rows.get(id); if (!row) return [];
        const changed = row.status !== "promoted"; row.status = "promoted";
        row.provenance_json = { ...row.provenance_json, ...JSON.parse(String(params[1])) };
        return [{ id, admission_changed: changed }];
      }) };
    }
    if (sql.includes('INSERT INTO "evidence_revision"."evidence_spans"')) {
      expect(sql).toContain("status=CASE WHEN ev.status='promoted' THEN ev.status ELSE EXCLUDED.status END");
      expect(sql).toContain("IS DISTINCT FROM (prior.status,prior.alpha");
      const changed = (JSON.parse(String(params[0])) as Array<EvidenceRow & { features_json: string[] }>).flatMap(input => {
        const previous = state.rows.get(input.id);
        const row: EvidenceRow = { id: input.id, status: previous?.status === "promoted" ? "promoted" : input.status,
          alpha: Math.max(previous?.alpha ?? input.alpha, input.alpha), trust_vector: { ...previous?.trust_vector, ...input.trust_vector },
          provenance_json: { ...previous?.provenance_json, ...input.provenance_json }, information_label: input.information_label,
          features: [...new Set([...(previous?.features ?? []), ...input.features_json])].sort() };
        state.rows.set(row.id, row);
        return JSON.stringify(previous) === JSON.stringify(row) ? [] : [{ language_memory_changed: 1 }];
      });
      return { rows: changed };
    }
    return { rows: [] };
  };
  (adapter.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => ({ query, release() {} });
  (adapter.pool as unknown as { query: typeof query }).query = query;
  const revision = () => adapter.languageMemory.readRevision!();
  await adapter.transaction(async () => { await adapter.evidence.putEvidenceSpan(span); await adapter.evidence.putEvidenceSpans!([span]); });
  expect(await revision()).toBe("1");
  await adapter.evidence.putEvidenceSpan(span);
  expect(await revision()).toBe("1");
  expect(await adapter.evidence.promoteEvidence([span.id], "owner confirms")).toBe(1);
  expect(await revision()).toBe("2");
  expect(await adapter.evidence.promoteEvidence([span.id], "owner confirms")).toBe(1);
  await adapter.evidence.putEvidenceSpan(span);
  expect(committed.rows.get(span.id)!.status).toBe("promoted");
  expect(await revision()).toBe("2");
  await expect(adapter.transaction(async () => {
    await adapter.evidence.putEvidenceSpan({ ...span, informationLabel: { ...label, compartments: ["private"] } });
    throw new Error("abort evidence restriction");
  })).rejects.toThrow("abort evidence restriction");
  expect(await revision()).toBe("2");
  expect(committed.rows.get(span.id)!.information_label).toEqual(label);
  await adapter.evidence.putEvidenceSpan({ ...span, informationLabel: { ...label, compartments: ["private"] } });
  expect(await revision()).toBe("3");
});
