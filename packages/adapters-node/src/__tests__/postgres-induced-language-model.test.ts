import { afterEach, describe, expect, it } from "vitest";
import type { InducedLanguageModel, InducedLanguageModelRecord } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

function fakeModel(id: string): InducedLanguageModel {
  return {
    id,
    corpusDocuments: 3,
    symbolCount: 120,
    vocabularySize: 45,
    scripts: [],
    ngrams: [],
    kneserNey: {},
    boundarySignals: [],
    morphology: [],
    syntaxTemplates: [],
    lexicalClasses: [],
    morphologyClassBindings: [],
    semanticFrames: [],
    translationSeeds: [],
    proseDiagnostics: {},
    audit: {}
  };
}

function record(patch: Partial<InducedLanguageModelRecord> = {}): InducedLanguageModelRecord {
  return {
    id: "model.fixture",
    model: fakeModel("model.fixture"),
    trainingPlanId: "training_plan.fixture",
    createdAt: 1_000,
    informationLabel: { tenantId: "t", principals: ["principal.fixture"], compartments: [], exportClass: "internal", mergePolicy: "isolated" },
    ...patch
  };
}

function fixture(rows: Array<Record<string, unknown>>) {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture" });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.includes("SELECT") && sql.includes("induced_language_models") && sql.includes("WHERE id=$1")) {
      const [id] = params as [string];
      return rows.filter(row => row.id === id) as T[];
    }
    if (sql.includes("SELECT") && sql.includes("induced_language_models") && sql.includes("ORDER BY created_at DESC")) {
      const [limit] = params as [number];
      return [...rows]
        .sort((a, b) => (b.created_at as Date).getTime() - (a.created_at as Date).getTime())
        .slice(0, limit) as T[];
    }
    if (sql.includes("INSERT INTO") && sql.includes("induced_language_models")) {
      const [id, trainingPlanId, modelJson, , , informationLabel, createdAt] = params as [string, string, string, number, number, string, number];
      rows.push({
        id,
        training_plan_id: trainingPlanId,
        model_json: JSON.parse(modelJson),
        information_label: JSON.parse(informationLabel),
        created_at: new Date(createdAt as number)
      });
      return [] as T[];
    }
    return [] as T[];
  };
  return { adapter, calls };
}

describe("Postgres induced language model store", () => {
  it("readById returns undefined for a model that was never persisted", async () => {
    const { adapter } = fixture([]);
    expect(await adapter.inducedLanguageModels.readById("missing")).toBeUndefined();
  });

  it("putModel then readById round-trips the full model, not just a summary", async () => {
    const { adapter } = fixture([]);
    const input = record();
    await adapter.inducedLanguageModels.putModel(input);

    const readBack = await adapter.inducedLanguageModels.readById(input.id);
    expect(readBack).toBeDefined();
    expect(readBack!.model).toEqual(input.model);
    expect(readBack!.trainingPlanId).toBe(input.trainingPlanId);
  });

  it("listRecent returns models newest first, bounded by limit", async () => {
    const { adapter } = fixture([]);
    await adapter.inducedLanguageModels.putModel(record({ id: "model.a", createdAt: 1_000 }));
    await adapter.inducedLanguageModels.putModel(record({ id: "model.b", createdAt: 3_000 }));
    await adapter.inducedLanguageModels.putModel(record({ id: "model.c", createdAt: 2_000 }));

    const recent = await adapter.inducedLanguageModels.listRecent({ limit: 2 });
    expect(recent.map(r => r.id)).toEqual(["model.b", "model.c"]);
  });

  it("putModel issues an ON CONFLICT DO NOTHING insert, not a blind overwrite", async () => {
    const { adapter, calls } = fixture([]);
    await adapter.inducedLanguageModels.putModel(record());
    const insert = calls.find(c => c.sql.includes("INSERT INTO") && c.sql.includes("induced_language_models"));
    expect(insert!.sql).toContain("ON CONFLICT(id) DO NOTHING");
  });
});
