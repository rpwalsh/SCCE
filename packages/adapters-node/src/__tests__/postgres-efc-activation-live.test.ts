import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_POLICY,
  POLICY_OBJECTIVE_SCHEMA_ID,
  createFunctionalCognitionEngine,
  policyGenomeFromDurable,
  type FunctionalSelfState,
  type GraphSlice,
  type ModelState,
  type PolicyEvaluation
} from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();
const liveSchema = process.env.SCCE_TEST_DATABASE_SCHEMA?.trim() || "scce3_runtime";

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

// Plan items 59-60: accumulates real evaluation history for two genuinely
// distinct policy fingerprints against live Postgres (not fabricated
// variants), reads it back through the real store exactly as
// production-turn-runtime.ts does (storage.policyEvolution.listGenomes),
// and proves functionalCognitionEngine.project() actually activates EFC
// from that real, live-sourced population.
describe("EFC activation from real, live-accumulated policy evaluation history (plan items 59-60)", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "activates pareto.available/efc once two distinct policy fingerprints have live-sourced genomes",
    async () => {
      const adapter = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema: liveSchema });
      adapters.push(adapter);
      await adapter.migrate();
      const suffix = randomUUID();
      const informationLabel = { tenantId: "scce.local", principals: [], compartments: [], exportClass: "public" as const, mergePolicy: "isolated" as const };
      const fingerprintA = `policy_live_efc_a_${suffix}`;
      const fingerprintB = `policy_live_efc_b_${suffix}`;

      const evaluation = (fingerprint: string, score: number, id: string): PolicyEvaluation => ({
        id,
        policyFingerprint: fingerprint,
        objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID,
        vector: { evidenceCoverage: score, governanceSuccessRate: score, contradictionRate: 1 - score, rollbackRate: 1 - score, taskSuccessRate: score },
        objectives: [score, score, score, score, score],
        evaluationWindow: { firstEventId: `${id}.start`, lastEventId: `${id}.end` },
        observations: 1,
        createdAt: Date.now(),
        informationLabel
      });

      try {
        // Two genuinely distinct policy configurations, each evaluated
        // for real (not the same fingerprint twice -- that would still
        // be one genome, per item 55).
        await adapter.policyEvolution.putEvaluation(evaluation(fingerprintA, 0.8, `${suffix}-a1`));
        await adapter.policyEvolution.putEvaluation(evaluation(fingerprintB, 0.75, `${suffix}-b1`));

        const genomes = (await adapter.policyEvolution.listGenomes({ objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID, limit: 500 }))
          .filter(genome => genome.policyFingerprint === fingerprintA || genome.policyFingerprint === fingerprintB);
        expect(genomes).toHaveLength(2);

        // Exactly the read path production-turn-runtime.ts uses.
        const policyPopulation = genomes.map(policyGenomeFromDurable);
        const report = createFunctionalCognitionEngine().project({
          now: Date.now(),
          self: fixtureSelfState(),
          model: fixtureModelState(),
          graph: emptyGraph(),
          policy: DEFAULT_POLICY,
          policyPopulation
        });

        expect(report.pareto.available).toBe(true);
        expect(report.pareto.front.length).toBeGreaterThanOrEqual(1);
      } finally {
        await adapter.query(`DELETE FROM ${adapter.table("policy_genomes")} WHERE policy_fingerprint=ANY($1)`, [[fingerprintA, fingerprintB]]);
        await adapter.query(`DELETE FROM ${adapter.table("policy_evaluations")} WHERE policy_fingerprint=ANY($1)`, [[fingerprintA, fingerprintB]]);
      }
    }
  );
});

function fixtureSelfState(): FunctionalSelfState {
  return {
    currentGoals: ["goal.real"],
    memoryState: { nodes: 12, edges: 16, evidence: 8, sourceVersions: 4, proofs: 3 },
    knownLimits: [],
    uncertainty: 0.1,
    capabilities: ["fixture"],
    activePolicies: ["requireTwoPhaseCommit"],
    recentFailures: [],
    commitments: ["fixture"],
    permissions: ["mutation dry-run unless approved"],
    learningGoals: ["goal.real"],
    fcs: 0.9,
    dci: 0.9
  };
}

function fixtureModelState(): ModelState {
  return { languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: ["goal.real"], trainingSteps: 12 };
}

function emptyGraph(): GraphSlice {
  return { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
}
