import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createSparseVector, createTypedSparseFeatureId, type SparseRankingComparisonExample } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();
const liveSchema = process.env.SCCE_TEST_DATABASE_SCHEMA?.trim() || "scce3_runtime";

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

describe("Postgres sparse ranking comparison log (plan item 32 infrastructure)", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "appends and lists comparison examples ordered by recordedAt, bounded to task/feature-schema class and limit",
    async () => {
      const adapter = createPostgresStorageAdapter({ url: liveDatabaseUrl! , schema: liveSchema });
      adapters.push(adapter);
      await adapter.migrate();
      const suffix = randomUUID();
      const taskClass = `test.task.${suffix}`;
      const featureSchemaId = "test.schema.v1";
      const featureId = createTypedSparseFeatureId({ familyId: "test", value: suffix });
      const candidates = [createSparseVector([{ id: featureId, value: 1 }]), createSparseVector([{ id: featureId, value: 0.5 }])];
      const informationLabel = { tenantId: "scce.local", principals: [], compartments: [], exportClass: "public" as const, mergePolicy: "isolated" as const };

      const examples: SparseRankingComparisonExample[] = [0, 1, 2].map(index => ({
        id: `comparison:${suffix}:${index}`,
        taskClass,
        featureSchemaId,
        recordedAt: 1_000 + index,
        candidates,
        preferredIndex: index % 2,
        weight: 0.8,
        source: "proof_certification",
        informationLabel
      }));

      try {
        for (const example of examples) await adapter.sparseRankingComparisons.append(example);
        // A duplicate append of the same id must not error or duplicate the row.
        await adapter.sparseRankingComparisons.append(examples[0]!);

        const listed = await adapter.sparseRankingComparisons.listRecent({ taskClass, featureSchemaId, limit: 10 });
        expect(listed.map(example => example.id)).toEqual(examples.map(example => example.id));
        expect(listed[0]!.candidates).toEqual(candidates);
        expect(listed[0]!.preferredIndex).toBe(0);
        expect(listed[1]!.preferredIndex).toBe(1);
        expect(listed[0]!.informationLabel).toEqual(informationLabel);

        const bounded = await adapter.sparseRankingComparisons.listRecent({ taskClass, featureSchemaId, limit: 2 });
        expect(bounded.map(example => example.id)).toEqual(examples.slice(1).map(example => example.id));
      } finally {
        await adapter.query(`DELETE FROM ${adapter.table("sparse_ranking_comparisons")} WHERE task_class=$1`, [taskClass]);
      }
    }
  );
});
