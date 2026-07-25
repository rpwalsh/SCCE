import { afterEach, describe, expect, it } from "vitest";
import { POLICY_OBJECTIVE_SCHEMA_ID, type PolicyEvaluation } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres policy evolution store", () => {
  it("inserts the evaluation row and seeds a new aggregate genome on the first evaluation for a fingerprint", async () => {
    const { adapter, calls } = fixture([]); // no existing genome row
    await adapter.policyEvolution.putEvaluation(evaluation({ policyFingerprint: "policy_x", objectives: [0.6, 0.6, 0.6, 0.6, 0.6] }));

    const insertEval = calls.find(c => c.sql.includes("INSERT INTO") && c.sql.includes("policy_evaluations"));
    expect(insertEval).toBeDefined();

    const upsertGenome = calls.find(c => c.sql.includes("INSERT INTO") && c.sql.includes("policy_genomes"));
    expect(upsertGenome).toBeDefined();
    expect(upsertGenome!.params[0]).toBe("policy_x");
    expect(upsertGenome!.params[4]).toBe(1); // evaluation_count for a first-time genome
  });

  it("folds a second evaluation of the same fingerprint into a running mean, not evaluation_count=1 again", async () => {
    const existingGenomeRow = {
      policy_fingerprint: "policy_x",
      objective_schema_id: POLICY_OBJECTIVE_SCHEMA_ID,
      vector_json: { evidenceRequired: 0.7, riskTolerance: 0.5, citationStrictness: 0.6, approvalRequired: 0.5, autonomyLevel: 0.3 },
      aggregated_objectives: [0.6, 0.6, 0.6, 0.6, 0.6],
      evaluation_count: 1,
      information_label: { tenantId: "t", principals: [], compartments: [], exportClass: "public", mergePolicy: "isolated" },
      first_evaluated_at: new Date(1_000),
      last_evaluated_at: new Date(1_000)
    };
    const { adapter, calls } = fixture([existingGenomeRow]);
    await adapter.policyEvolution.putEvaluation(evaluation({ policyFingerprint: "policy_x", objectives: [0.8, 0.8, 0.8, 0.8, 0.8], createdAt: 2_000 }));

    const upsertGenome = calls.find(c => c.sql.includes("INSERT INTO") && c.sql.includes("policy_genomes"));
    expect(upsertGenome!.params[4]).toBe(2); // evaluation_count advances to 2, not reset to 1
    expect(upsertGenome!.params[3]).toEqual([0.7, 0.7, 0.7, 0.7, 0.7]); // mean of [0.6]*5 and [0.8]*5
  });

  it("filters listGenomes by objectiveSchemaId and applies a bounded limit", async () => {
    const { adapter, calls } = fixture([]);
    await adapter.policyEvolution.listGenomes({ objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID, limit: 10 });

    const select = calls.find(c => c.sql.includes("SELECT") && c.sql.includes("policy_genomes"));
    expect(select).toBeDefined();
    expect(select!.sql).toContain("objective_schema_id=$1");
    expect(select!.params).toEqual([POLICY_OBJECTIVE_SCHEMA_ID, 10]);
  });
});

function fixture(existingGenomeRows: unknown[]): {
  adapter: PostgresStorageAdapter;
  calls: Array<{ sql: string; params: unknown[] }>;
} {
  const adapter = createPostgresStorageAdapter({ url: "postgres://fixture:fixture@127.0.0.1/fixture", schema: "fixture" });
  adapters.push(adapter);
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  adapter.query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
    calls.push({ sql, params });
    if (sql.includes("SELECT") && sql.includes("policy_genomes") && sql.includes("WHERE policy_fingerprint")) {
      return existingGenomeRows as T[];
    }
    return [] as T[];
  };
  // putEvaluation runs inside storage.transaction(), whose real implementation
  // takes a live pool connection for BEGIN/COMMIT/ROLLBACK -- stub that out too,
  // since only storage.query() (already faked above) needs to be observed here.
  const txClient = { async query() { return { rows: [] }; }, release() {} };
  (adapter.pool as unknown as { connect: () => Promise<typeof txClient> }).connect = async () => txClient;
  return { adapter, calls };
}

function evaluation(patch: Partial<PolicyEvaluation> = {}): PolicyEvaluation {
  return {
    id: `eval_${patch.createdAt ?? 1_000}`,
    policyFingerprint: "policy_fixture",
    objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID,
    vector: { evidenceRequired: 0.7, riskTolerance: 0.5, citationStrictness: 0.6, approvalRequired: 0.5, autonomyLevel: 0.3 },
    objectives: [0.5, 0.5, 0.5, 0.5, 0.5],
    evaluationWindow: { firstEventId: "event.a", lastEventId: "event.b" },
    observations: 1,
    createdAt: 1_000,
    informationLabel: { tenantId: "t", principals: [], compartments: [], exportClass: "public", mergePolicy: "isolated" },
    ...patch
  };
}
