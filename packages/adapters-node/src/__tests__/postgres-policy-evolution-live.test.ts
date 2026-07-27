import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { POLICY_OBJECTIVE_SCHEMA_ID, type PolicyEvaluation } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();
const liveSchema = process.env.SCCE_TEST_DATABASE_SCHEMA?.trim() || "scce3_runtime";

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

// Plan item 55: two evaluations of the identical policy fingerprint must
// aggregate into exactly one genome row, not two -- against real
// Postgres, not the mocked-query fixture postgres-policy-evolution.test.ts
// uses for its SQL-shape assertions.
describe("Postgres policy evolution genome aggregation (plan item 55)", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "folds two evaluations of the same fingerprint into one genome with evaluation_count=2",
    async () => {
      const adapter = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema: liveSchema });
      adapters.push(adapter);
      await adapter.migrate();
      const suffix = randomUUID();
      const policyFingerprint = `policy_live_${suffix}`;
      const informationLabel = { tenantId: "scce.local", principals: [], compartments: [], exportClass: "public" as const, mergePolicy: "isolated" as const };

      const first: PolicyEvaluation = {
        id: `eval_${suffix}_1`,
        policyFingerprint,
        objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID,
        vector: { evidenceCoverage: 0.6, governanceSuccessRate: 0.6, contradictionRate: 0.4, rollbackRate: 0.4, taskSuccessRate: 0.6 },
        objectives: [0.6, 0.6, 0.6, 0.6, 0.6],
        evaluationWindow: { firstEventId: "event.a1", lastEventId: "event.a2" },
        observations: 1,
        createdAt: 1_000,
        informationLabel
      };
      const second: PolicyEvaluation = {
        ...first,
        id: `eval_${suffix}_2`,
        objectives: [0.8, 0.8, 0.8, 0.8, 0.8],
        evaluationWindow: { firstEventId: "event.b1", lastEventId: "event.b2" },
        createdAt: 2_000
      };

      try {
        await adapter.policyEvolution.putEvaluation(first);
        const afterFirst = await adapter.policyEvolution.listGenomes({ objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID, limit: 500 });
        const genomeAfterFirst = afterFirst.find(genome => genome.policyFingerprint === policyFingerprint);
        expect(genomeAfterFirst?.evaluationCount).toBe(1);
        expect(genomeAfterFirst?.aggregatedObjectives).toEqual([0.6, 0.6, 0.6, 0.6, 0.6]);

        await adapter.policyEvolution.putEvaluation(second);
        const afterSecond = await adapter.policyEvolution.listGenomes({ objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID, limit: 500 });
        const genomesForFingerprint = afterSecond.filter(genome => genome.policyFingerprint === policyFingerprint);
        // Exactly one genome row for this fingerprint, not two.
        expect(genomesForFingerprint).toHaveLength(1);
        const genome = genomesForFingerprint[0]!;
        expect(genome.evaluationCount).toBe(2);
        // Running mean of [0.6, 0.8] per dimension = 0.7, not a fresh 0.8.
        for (const value of genome.aggregatedObjectives) expect(value).toBeCloseTo(0.7);
      } finally {
        await adapter.query(`DELETE FROM ${adapter.table("policy_genomes")} WHERE policy_fingerprint=$1`, [policyFingerprint]);
        await adapter.query(`DELETE FROM ${adapter.table("policy_evaluations")} WHERE policy_fingerprint=$1`, [policyFingerprint]);
      }
    }
  );
});
