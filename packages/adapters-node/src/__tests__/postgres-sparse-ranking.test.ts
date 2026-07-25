import { afterEach, describe, expect, it } from "vitest";
import { RETRIEVAL_RANK_FEATURE_SCHEMA_V1, type SparseRankingCheckpoint } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

const TASK_CLASS = "graph.node_rank.v1";

function checkpoint(patch: Partial<SparseRankingCheckpoint> = {}): SparseRankingCheckpoint {
  return {
    modelId: "model.fixture",
    taskClass: TASK_CLASS,
    featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
    lifecycle: "candidate",
    state: {
      schemaVersion: "scce.ftrl.v1" as never,
      modelId: "model.fixture",
      featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
      hyperparameters: { alpha: 0.1, beta: 1, l1: 0, l2: 0 },
      createdAt: 1_000,
      updatedAt: 1_000,
      examplesSeen: 0,
      coordinates: []
    },
    trainingWindow: { firstExampleAt: 1_000, lastExampleAt: 1_000 },
    examplesSeen: 0,
    informationLabel: { tenantId: "t", principals: [], compartments: [], exportClass: "internal", mergePolicy: "isolated" },
    createdAt: 1_000,
    ...patch
  };
}

function fixture(rowsByModelId: Map<string, Record<string, unknown>>, activeByTaskClass: Map<string, string>) {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture" });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO") && sql.includes("sparse_ranking_models")) {
      const [modelId, taskClass, featureSchemaId, lifecycle] = params as [string, string, string, string];
      rowsByModelId.set(modelId, {
        model_id: modelId,
        task_class: taskClass,
        feature_schema_id: featureSchemaId,
        lifecycle,
        previous_active_model_id: (params[8] as string | null) ?? null,
        rollback_reason: (params[9] as string | null) ?? null
      });
      return [] as T[];
    }
    if (sql.includes("SET lifecycle='active'")) {
      const [modelId] = params as [string];
      const row = rowsByModelId.get(modelId);
      if (row) row.lifecycle = "active";
      return [] as T[];
    }
    if (sql.includes("SET lifecycle='approved'")) {
      const [modelId] = params as [string];
      const row = rowsByModelId.get(modelId);
      if (row && row.lifecycle === "active") row.lifecycle = "approved";
      return [] as T[];
    }
    if (sql.includes("SET lifecycle='rolled_back'")) {
      const [modelId, reason] = params as [string, string];
      const row = rowsByModelId.get(modelId);
      if (row) { row.lifecycle = "rolled_back"; row.rollback_reason = reason; }
      return [] as T[];
    }
    if (sql.includes("SELECT") && sql.includes("sparse_ranking_models") && sql.includes("WHERE model_id=$1")) {
      const [modelId] = params as [string];
      const row = rowsByModelId.get(modelId);
      return (row ? [row] : []) as T[];
    }
    if (sql.includes("SELECT model_id FROM") && sql.includes("sparse_ranking_active_model")) {
      const [taskClass, featureSchemaId] = params as [string, string];
      const modelId = activeByTaskClass.get(`${taskClass}:${featureSchemaId}`);
      return (modelId ? [{ model_id: modelId }] : []) as T[];
    }
    if (sql.includes("INSERT INTO") && sql.includes("sparse_ranking_active_model")) {
      const [taskClass, featureSchemaId, modelId] = params as [string, string, string];
      activeByTaskClass.set(`${taskClass}:${featureSchemaId}`, modelId);
      return [] as T[];
    }
    if (sql.includes("DELETE FROM") && sql.includes("sparse_ranking_active_model")) {
      const [taskClass, featureSchemaId] = params as [string, string];
      activeByTaskClass.delete(`${taskClass}:${featureSchemaId}`);
      return [] as T[];
    }
    return [] as T[];
  };
  const txClient = { async query() { return { rows: [] }; }, release() {} };
  (adapter.pool as unknown as { connect: () => Promise<typeof txClient> }).connect = async () => txClient;
  return { adapter, calls };
}

describe("Postgres sparse ranking model store", () => {
  it("readActive returns undefined when no model has ever been activated for a task class", async () => {
    const { adapter } = fixture(new Map(), new Map());
    expect(await adapter.sparseRanking.readActive(TASK_CLASS, RETRIEVAL_RANK_FEATURE_SCHEMA_V1)).toBeUndefined();
  });

  it("refuses to activate a model that has not been marked approved", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    rows.set("model.candidate", { model_id: "model.candidate", task_class: TASK_CLASS, feature_schema_id: RETRIEVAL_RANK_FEATURE_SCHEMA_V1, lifecycle: "shadow" });
    const { adapter } = fixture(rows, new Map());

    await expect(adapter.sparseRanking.activate({ modelId: "model.candidate", taskClass: TASK_CLASS, featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1 }))
      .rejects.toThrow(/only "approved" models may activate/);
  });

  it("activates an approved model and demotes the previously active one back to approved", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    rows.set("model.old", { model_id: "model.old", task_class: TASK_CLASS, feature_schema_id: RETRIEVAL_RANK_FEATURE_SCHEMA_V1, lifecycle: "active" });
    rows.set("model.new", { model_id: "model.new", task_class: TASK_CLASS, feature_schema_id: RETRIEVAL_RANK_FEATURE_SCHEMA_V1, lifecycle: "approved" });
    const active = new Map([[`${TASK_CLASS}:${RETRIEVAL_RANK_FEATURE_SCHEMA_V1}`, "model.old"]]);
    const { adapter } = fixture(rows, active);

    await adapter.sparseRanking.activate({ modelId: "model.new", taskClass: TASK_CLASS, featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1 });

    expect(rows.get("model.new")!.lifecycle).toBe("active");
    expect(rows.get("model.old")!.lifecycle).toBe("approved");
    expect(active.get(`${TASK_CLASS}:${RETRIEVAL_RANK_FEATURE_SCHEMA_V1}`)).toBe("model.new");
  });

  it("rolls back to the previously active model when one is recorded", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    rows.set("model.old", { model_id: "model.old", task_class: TASK_CLASS, feature_schema_id: RETRIEVAL_RANK_FEATURE_SCHEMA_V1, lifecycle: "approved" });
    rows.set("model.bad", { model_id: "model.bad", task_class: TASK_CLASS, feature_schema_id: RETRIEVAL_RANK_FEATURE_SCHEMA_V1, lifecycle: "active", previous_active_model_id: "model.old" });
    const active = new Map([[`${TASK_CLASS}:${RETRIEVAL_RANK_FEATURE_SCHEMA_V1}`, "model.bad"]]);
    const { adapter } = fixture(rows, active);

    await adapter.sparseRanking.rollback({ taskClass: TASK_CLASS, featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1, reason: "regressed recall@50" });

    expect(rows.get("model.bad")!.lifecycle).toBe("rolled_back");
    expect(rows.get("model.bad")!.rollback_reason).toBe("regressed recall@50");
    expect(rows.get("model.old")!.lifecycle).toBe("active");
    expect(active.get(`${TASK_CLASS}:${RETRIEVAL_RANK_FEATURE_SCHEMA_V1}`)).toBe("model.old");
  });

  it("clears the active slot on rollback when there is no previous model to fall back to", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    rows.set("model.only", { model_id: "model.only", task_class: TASK_CLASS, feature_schema_id: RETRIEVAL_RANK_FEATURE_SCHEMA_V1, lifecycle: "active" });
    const active = new Map([[`${TASK_CLASS}:${RETRIEVAL_RANK_FEATURE_SCHEMA_V1}`, "model.only"]]);
    const { adapter } = fixture(rows, active);

    await adapter.sparseRanking.rollback({ taskClass: TASK_CLASS, featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1, reason: "no baseline available" });

    expect(rows.get("model.only")!.lifecycle).toBe("rolled_back");
    expect(active.has(`${TASK_CLASS}:${RETRIEVAL_RANK_FEATURE_SCHEMA_V1}`)).toBe(false);
  });

  it("putCheckpoint records a call the store can be queried back through readActive once activated", async () => {
    const rows = new Map<string, Record<string, unknown>>();
    const { adapter, calls } = fixture(rows, new Map());

    await adapter.sparseRanking.putCheckpoint(checkpoint({ modelId: "model.new", lifecycle: "candidate" }));
    const insert = calls.find(c => c.sql.includes("INSERT INTO") && c.sql.includes("sparse_ranking_models"));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe("model.new");
    expect(insert!.params[3]).toBe("candidate");
  });
});
