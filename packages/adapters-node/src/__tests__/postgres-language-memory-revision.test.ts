// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";
import { LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID, LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, type LanguagePatternRecord } from "@scce/kernel";
import { LANGUAGE_MEMORY_REVISION_KEY, PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
afterEach(async () => { await Promise.all(adapters.splice(0).map(adapter => adapter.close())); });
const label = { tenantId: "tenant.owned", principals: [], compartments: [], exportClass: "public" as const, mergePolicy: "isolated" as const };
const revision = (adapter: PostgresStorageAdapter) => (adapter.languageMemory as { readRevision?: () => Promise<string> }).readRevision!();
const pattern = (id = "pattern.owned"): LanguagePatternRecord => ({ id, profileId: "profile.owned", patternKind: "semantic_role", support: 1, entropy: 0,
  patternJson: { schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, sourceSystem: "dialogue", retained: true }, evidenceIds: [], updatedAt: 1000, informationLabel: label });

function database(initialRevision = 0n) {
  type State = { revision: bigint; bodies: Map<string, string> };
  let committed: State = { revision: initialRevision, bodies: new Map() };
  let failRevision = false;
  const statements: string[] = [];
  function execute(state: State, sql: string, params: readonly unknown[]) {
    if (sql.startsWith("SELECT value_json #>>")) return state.revision ? [{ revision: String(state.revision) }] : [];
    if (sql.includes("AS revision(key,value_json")) { if (failRevision) throw new Error("revision write failed"); state.revision++; return []; }
    if (!sql.includes("RETURNING 1 AS language_memory_changed")) return [];
    if (sql.startsWith("DELETE FROM") && sql.includes('"language_patterns"')) {
      const retained = params.at(-1) as string[];
      const deleted = [...state.bodies.keys()].filter(key => key.startsWith("language_patterns:") && !retained.includes(key.slice("language_patterns:".length)));
      deleted.forEach(key => state.bodies.delete(key));
      return deleted.map(() => ({ language_memory_changed: 1 }));
    }
    if (sql.startsWith("DELETE FROM")) return [];
    const table = /INSERT INTO "revision_fixture"\."([^"]+)"/u.exec(sql)?.[1];
    if (!table) return [{ language_memory_changed: 1 }];
    let rows: Array<Record<string, unknown>>;
    if (table === "storage_meta") rows = [{ id: params[0], value: JSON.parse(String(params[1])) }];
    else {
      const parsed = typeof params[0] === "string" && String(params[0]).startsWith("[") ? JSON.parse(String(params[0])) : undefined;
      rows = Array.isArray(parsed) ? parsed : [{ id: params[0], values: params }];
    }
    return rows.flatMap(row => {
      const { updated_at_ms: _time, ...logical } = row;
      const key = `${table}:${row.id}`, value = JSON.stringify(logical);
      if (state.bodies.get(key) === value && sql.includes("IS DISTINCT FROM")) return [];
      state.bodies.set(key, value);
      return [{ language_memory_changed: 1 }];
    });
  }
  function client() {
    const connection: { pending?: State } = {};
    return { async query(sql: string, params: readonly unknown[] = []) {
      statements.push(sql);
      if (sql === "BEGIN") { connection.pending = { revision: committed.revision, bodies: new Map(committed.bodies) }; return { rows: [] }; }
      if (sql === "COMMIT") { committed = connection.pending!; connection.pending = undefined; return { rows: [] }; }
      if (sql === "ROLLBACK") { connection.pending = undefined; return { rows: [] }; }
      return { rows: execute(connection.pending ?? committed, sql, params) };
    }, release() {} };
  }
  function adapter() {
    const result = new PostgresStorageAdapter({ url: "postgres://offline.invalid/none", schema: "revision_fixture", informationAccess: {
      tenantId: "tenant.owned", principalId: "principal.owned", compartments: [], maximumExportClass: "restricted"
    } });
    adapters.push(result);
    const connection = client();
    (result.pool as unknown as { connect: () => Promise<unknown> }).connect = async () => connection;
    (result.pool as unknown as { query: typeof connection.query }).query = connection.query;
    return result;
  }
  return { adapter, statements, bodies: () => committed.bodies, failRevision: () => { failRevision = true; } };
}

describe("transactional language-memory revision", () => {
  it("exposes a stable initial scalar and observes direct external writes without reading model bodies", async () => {
    const db = database(), writer = db.adapter(), reader = db.adapter();
    expect(typeof (reader.languageMemory as { readRevision?: unknown }).readRevision).toBe("function");
    expect(await revision(reader)).toBe("0");
    await writer.languageMemory.putLanguagePattern(pattern());
    expect(await revision(reader)).toBe("1");
    const mutation = db.statements.findIndex(sql => sql.includes('INSERT INTO "revision_fixture"."language_patterns"'));
    const bump = db.statements.findIndex(sql => sql.includes("AS revision(key,value_json"));
    expect(db.statements.indexOf("BEGIN")).toBeLessThan(mutation);
    expect(bump).toBeGreaterThan(mutation);
    expect(db.statements.indexOf("COMMIT")).toBeGreaterThan(bump);
    const reads = db.statements.filter(sql => sql.startsWith("SELECT value_json #>>"));
    expect(reads).toHaveLength(2);
    expect(reads.every(sql => sql.includes("WHERE key=$1") && !sql.includes("language_patterns") && !sql.includes("model_json"))).toBe(true);
    expect(LANGUAGE_MEMORY_REVISION_KEY).toBe("language_memory.revision");
  });

  it("commits one revision for an outer transaction and does not expose uncommitted changes", async () => {
    const db = database(), writer = db.adapter(), reader = db.adapter();
    await writer.transaction(async () => {
      await writer.languageMemory.putLanguagePattern(pattern("first"));
      await writer.languageMemory.putLanguagePatterns?.([pattern("second"), pattern("third")]);
      expect(await revision(reader)).toBe("0");
    });
    expect(await revision(reader)).toBe("1");
    expect(db.statements.filter(sql => sql.includes("AS revision(key,value_json"))).toHaveLength(1);
  });

  it("rolls back both payload and revision and clears dirty state before pool reuse", async () => {
    const db = database(), writer = db.adapter();
    await expect(writer.transaction(async () => { await writer.languageMemory.putLanguagePattern(pattern()); throw new Error("abort"); })).rejects.toThrow("abort");
    expect(await revision(writer)).toBe("0");
    expect(db.bodies().size).toBe(0);
    await writer.transaction(async () => {});
    expect(await revision(writer)).toBe("0");
    await writer.languageMemory.putLanguagePattern(pattern());
    expect(await revision(writer)).toBe("1");
  });

  it("rolls back a direct payload write if persisting its revision fails", async () => {
    const db = database(), writer = db.adapter(); db.failRevision();
    await expect(writer.languageMemory.putLanguagePattern(pattern())).rejects.toThrow("revision write failed");
    expect(db.bodies().size).toBe(0);
    expect(await revision(writer)).toBe("0");
  });

  it("leaves exact pattern replay unchanged and advances when accepted JSON changes", async () => {
    const db = database(), writer = db.adapter();
    await writer.languageMemory.putLanguagePattern(pattern());
    await writer.languageMemory.putLanguagePattern({ ...pattern(), updatedAt: 2000 });
    expect(await revision(writer)).toBe("1");
    await writer.languageMemory.putLanguagePattern({ ...pattern(), patternJson: { changed: true } });
    expect(await revision(writer)).toBe("2");
  });

  it("does not rewrite retained ACTS members or bump an unchanged active publication", async () => {
    const db = database(), writer = db.adapter();
    const owned = { ...pattern(), patternJson: { schema: "scce.request_requirement_pattern.v1", sourceVersionId: "version.owned", sourceSystem: "dialogue" } };
    const request = { profileId: owned.profileId, sourceVersionId: "version.owned" as never, sourceSystem: "dialogue", schema: "scce.request_requirement_pattern.v1", compilerFingerprint: "recipe.owned", patterns: [owned] };
    await writer.languageMemory.replaceRequestRequirementPatterns?.(request);
    await writer.languageMemory.replaceRequestRequirementPatterns?.(request);
    expect(await revision(writer)).toBe("1");
    const projection = { profileId: owned.profileId, sourceId: "source.owned" as never, sourceVersionId: "version.owned" as never, sourceSystem: "dialogue",
      patternSchema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, componentRecipe: LANGUAGE_CONSTRUCTION_ACTIVE_PROJECTION_RECIPE_ID, patternIds: [] as string[], informationLabel: label };
    await writer.languageMemory.replaceLanguagePatternProjection?.({ patterns: [], projection });
    await writer.languageMemory.replaceLanguagePatternProjection?.({ patterns: [], projection });
    expect(await revision(writer)).toBe("2");
    await writer.languageMemory.replaceRequestRequirementPatterns?.({ ...request, patterns: [] });
    expect(await revision(writer)).toBe("3");
  });

  it("keeps revision text exact beyond JavaScript's safe integer range", async () => {
    const db = database(9007199254740993n), writer = db.adapter();
    expect(await revision(writer)).toBe("9007199254740993");
    await writer.languageMemory.putLanguagePattern(pattern());
    expect(await revision(writer)).toBe("9007199254740994");
  });

  it("invalidates resident adapter model JSON when an external revision changes without a timestamp change", async () => {
    const db = database(), writer = db.adapter(), reader = db.adapter();
    const query = reader.query.bind(reader);
    let changed = false, blobReads = 0;
    reader.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      if (sql.includes("pg_column_size(model.model_json) AS stored_bytes")) return [{ id: "model.cached", stream_id: "stream.owned", language_hint: "und", max_order: 1, discount: "0.75", updated_at: new Date(1), information_label: label, stored_bytes: "100" }] as T[];
      if (sql.includes(" AS json_bytes") && sql.includes("model.model_json")) { blobReads++; return [{ id: "model.cached", updated_at: new Date(1), model_json: { changed }, json_bytes: "100" }] as T[]; }
      return query<T>(sql, params);
    };
    await revision(reader);
    const before = await reader.languageMemory.listNgramModels({ maxTotalJsonBytes: 1000 });
    changed = true;
    await writer.languageMemory.putLanguagePattern(pattern());
    await revision(reader);
    const after = await reader.languageMemory.listNgramModels({ maxTotalJsonBytes: 1000 });
    expect(before[0]!.modelJson).toEqual({ changed: false });
    expect(after[0]!.modelJson).toEqual({ changed: true });
    expect(blobReads).toBe(2);
  });

  const observation = { id: "observation.owned", streamId: "stream.owned", languageHint: "language.owned", order: 1, history: [], symbol: "unit", count: 1, fieldWeight: 1, observedAt: 1000, metadata: {}, informationLabel: label };
  const model = { id: "model.owned", streamId: "stream.owned", languageHint: "language.owned", maxOrder: 1, discount: 0.75, modelJson: { retained: true }, updatedAt: 1000, informationLabel: label };
  const unit = { id: "unit.owned", profileId: "profile.owned", sourceVersionId: "version.owned", script: "Latn", unitKind: "symbol", text: "unit", features: [], competenceVector: [], alpha: 1, evidenceIds: [], metadata: {}, informationLabel: label };
  const frame = { id: "frame.owned", frameJson: { retained: true }, embedding: Array(64).fill(0), evidenceIds: [], alpha: 1, createdAt: 1000, informationLabel: label };
  const profile = { id: "profile.owned", sourceVersionId: "version.owned", charNgrams: [], discoveredNames: [], createdAt: 1000, informationLabel: label };
  it.each([
    ["observation", (a: PostgresStorageAdapter) => a.languageMemory.putNgramObservation(observation as never)],
    ["observation batch", (a: PostgresStorageAdapter) => a.languageMemory.putNgramObservationsBatch([observation] as never)],
    ["model", (a: PostgresStorageAdapter) => a.languageMemory.putNgramModel(model as never)],
    ["model batch", (a: PostgresStorageAdapter) => a.languageMemory.putNgramModels?.([model] as never)],
    ["unit", (a: PostgresStorageAdapter) => a.languageMemory.putLanguageUnit(unit as never)],
    ["unit batch", (a: PostgresStorageAdapter) => a.languageMemory.putLanguageUnits?.([unit] as never)],
    ["semantic frame", (a: PostgresStorageAdapter) => a.languageMemory.putSemanticFrame(frame as never)],
    ["semantic frame batch", (a: PostgresStorageAdapter) => a.languageMemory.putSemanticFrames?.([frame] as never)],
    ["profile", (a: PostgresStorageAdapter) => a.model.putLanguageProfile(profile as never)],
    ["profile batch", (a: PostgresStorageAdapter) => a.model.putLanguageProfiles?.([profile] as never)],
    ["identity", (a: PostgresStorageAdapter) => a.languageIdentities.putIdentities([{ id: "identity.owned", createdAt: 1000, informationLabel: label }] as never)],
    ["profile language assignment", (a: PostgresStorageAdapter) => a.languageIdentities.assignProfileLanguages([{ profileId: "profile.owned", languageId: "language.owned" }] as never)],
    ["profile signature", (a: PostgresStorageAdapter) => a.languageIdentities.putProfileSignatures!({ rows: [{ id: "profile.owned", sourceVersionId: "version.owned", scripts: {}, direction: "ltr", topContinuation: [] }], informationLabel: label } as never)],
    ["induced model", (a: PostgresStorageAdapter) => a.inducedLanguageModels.putModel({ id: "induced.owned", model: { corpusDocuments: 1, vocabularySize: 1 }, trainingPlanId: "plan.owned", createdAt: 1000, informationLabel: label } as never)],
    ["segmentation model", (a: PostgresStorageAdapter) => a.segmentationPopulations.putModel({ id: "segmentation.owned", model: { populations: [], selection: { mdlGainNats: 1 } }, profileIds: [], sourceVersionIds: [], trainingPlanId: "plan.owned", createdAt: 1000, informationLabel: label } as never)],
    ["translation alignment", (a: PostgresStorageAdapter) => a.languageMemory.putTranslationAlignment({ id: "alignment.owned", sourceFrameId: "source.frame", targetFrameId: "target.frame", sourceLanguage: "source.language", targetLanguage: "target.language", force: 1, lossVector: [], alignmentJson: {}, evidenceIds: [], updatedAt: 1000, informationLabel: label } as never)],
    ["translation seed", (a: PostgresStorageAdapter) => a.translationSeeds.putSeeds({ targetLanguage: "target.language", sourceLanguage: "source.language", seeds: [{ sourceSymbol: "source", targetSymbol: "target", score: 1, basis: "paired", evidenceIds: [] }], observedAt: 1000 } as never)],
    ["translation construction", (a: PostgresStorageAdapter) => a.translationConstructions.putConstructions({ targetLanguage: "target.language", constructions: [{ sourceSymbols: ["a", "b"], targetSymbols: ["c", "d"], score: 1, evidenceIds: [] }], observedAt: 1000 } as never)],
    ["target profile pattern", (a: PostgresStorageAdapter) => a.dialogueMemory.putTargetProfilePattern({ id: "target.owned", targetProfileId: "profile.owned", patternFamilyId: "family.owned", patternJson: {}, evidenceIds: [], alpha: 1, createdAt: 1000, updatedAt: 1000 } as never)]
  ] as Array<[string, (adapter: PostgresStorageAdapter) => unknown]>)("includes accepted %s writes in the committed revision", async (_name, write) => {
    const db = database(), writer = db.adapter();
    await write(writer);
    expect(await revision(writer)).toBe("1");
    expect(db.statements.some(sql => sql.includes("RETURNING 1 AS language_memory_changed"))).toBe(true);
    expect(db.statements.filter(sql => sql.includes("AS revision(key,value_json")).length).toBeGreaterThan(0);
  });
});
