import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCapabilityExecutorRegistry,
  createExecutiveEpisodeMachine,
  createHasher,
  dispatchCapabilityTask,
  reconcileIndeterminateCapability,
  type CapabilityExecutor,
  type EpisodeId as ExecutiveEpisodeIdType
} from "@scce/kernel";
import { createDurableExecutiveEpisode } from "@scce/kernel";
import { createExecutiveEventJournal, createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";

const adapters: PostgresStorageAdapter[] = [];
const liveDatabaseUrl = process.env.SCCE_TEST_DATABASE_URL?.trim();
const liveSchema = process.env.SCCE_TEST_DATABASE_SCHEMA?.trim() || "scce3_runtime";

afterEach(async () => {
  await Promise.all(adapters.splice(0).map(adapter => adapter.close()));
});

// Plan item 44: prove one real connector capability's full
// prepare -> dispatch -> receipt -> outcome trail is durable and
// replayable after a simulated crash, against real Postgres -- not the
// in-memory/mocked-query journal fixtures used elsewhere.
describe("connector capability dispatch durability across a simulated crash (plan item 44)", () => {
  (liveDatabaseUrl ? it : it.skip)(
    "resumes an indeterminate connector dispatch from durable Postgres state in a fresh process and reconciles it",
    async () => {
      const adapter = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema: liveSchema });
      adapters.push(adapter);
      await adapter.migrate();
      const suffix = randomUUID();
      const episodeId = `episode.durability.${suffix}` as ExecutiveEpisodeIdType;
      const hasher = createHasher();

      let searchInvocations = 0;
      const indeterminateExecutor: CapabilityExecutor = {
        descriptor: { capabilityId: "connector.web_search", idempotency: "provider-enforced", rollback: "unavailable" },
        execute: async () => {
          searchInvocations += 1;
          // Simulates a crash mid-provider-call: the executor cannot
          // tell whether the search actually reached the provider.
          return { status: "indeterminate", outputRefs: [], evidenceRefs: ["connector.timeout"], attestationRef: `attempt.${searchInvocations}` };
        }
      };

      const dispatchInput = {
        episodeId,
        ownerId: "owner.durability",
        policyVersionId: "policy.v1",
        goal: { id: `goal.${suffix}`, goalClassId: "goal.class.web_search", objectiveRef: suffix, requirementIds: [], ownerId: "owner.durability" },
        task: {
          id: `task.${suffix}`,
          goalId: `goal.${suffix}`,
          taskClassId: "task.class.web_search",
          requirementIds: [],
          dependencyTaskIds: [],
          capabilityId: "connector.web_search",
          inputRef: suffix,
          policyVersionId: "policy.v1",
          controls: {
            authority: { authorityClassId: "authority.class.web_search", subjectId: "owner.durability", requiredScopeIds: [], state: "not_required" as const, justificationRef: suffix },
            approval: { policyId: "approval.policy.web_search", state: "not_required" as const, approverClassIds: [], justificationRef: suffix }
          },
          rollback: { mode: "not_required" as const, justificationRef: "read-only search has no durable effect to roll back" }
        },
        payload: { query: "durability test query", limit: 3 },
        outcomeEvidenceRefs: [] as string[]
      };

      try {
        // "Process 1": dispatches, gets an indeterminate result, then
        // is discarded entirely -- nothing from it is reused below.
        const firstProcessJournal = createExecutiveEventJournal(adapter);
        const firstProcessExecutive = createDurableExecutiveEpisode({
          machine: createExecutiveEpisodeMachine(hasher),
          journal: firstProcessJournal,
          maxConflictRetries: 1
        });
        const firstResult = await dispatchCapabilityTask(
          { executive: firstProcessExecutive, executors: createCapabilityExecutorRegistry([indeterminateExecutor]), hasher, now: () => Date.now() },
          dispatchInput
        );
        expect(firstResult.disposition).toBe("indeterminate");
        expect(searchInvocations).toBe(1);

        // "Process 2": a brand new adapter/journal/executive instance
        // pointed at the same live database and episode id, simulating
        // a restart after a crash. It must see the exact durable state
        // process 1 left behind, not start over.
        const secondAdapter = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema: liveSchema });
        adapters.push(secondAdapter);
        const secondProcessJournal = createExecutiveEventJournal(secondAdapter);
        const secondProcessExecutive = createDurableExecutiveEpisode({
          machine: createExecutiveEpisodeMachine(hasher),
          journal: secondProcessJournal,
          maxConflictRetries: 1
        });
        const resumedState = await secondProcessExecutive.load(episodeId);
        expect(resumedState.tasks[dispatchInput.task.id]?.status).toBe("awaiting_outcome");

        // A retried dispatch call in the new process must NOT re-invoke
        // the executor (idempotency-key based duplicate detection) --
        // it just reports the same indeterminate state.
        const retried = await dispatchCapabilityTask(
          { executive: secondProcessExecutive, executors: createCapabilityExecutorRegistry([indeterminateExecutor]), hasher, now: () => Date.now() },
          dispatchInput
        );
        expect(retried.disposition).toBe("indeterminate");
        expect(searchInvocations).toBe(1);

        // Reconciliation (item 42) resolves it from the new process,
        // still against the same durable episode.
        const reconcilingExecutor: CapabilityExecutor = {
          ...indeterminateExecutor,
          reconcile: async () => ({ status: "succeeded", outputRefs: ["https://example.test/result"], evidenceRefs: ["provider.lookup.confirmed"], attestationRef: "reconciled" })
        };
        const reconciled = await reconcileIndeterminateCapability(
          { executive: secondProcessExecutive, executors: createCapabilityExecutorRegistry([reconcilingExecutor]), hasher, now: () => Date.now() },
          { episodeId, taskId: dispatchInput.task.id, outcomeEvidenceRefs: [] }
        );
        expect(reconciled.disposition).toBe("succeeded");
        expect(reconciled.state.tasks[dispatchInput.task.id]?.status).toBe("succeeded");

        // A third, independent process confirms the resolved outcome is
        // itself durable.
        const thirdAdapter = createPostgresStorageAdapter({ url: liveDatabaseUrl!, schema: liveSchema });
        adapters.push(thirdAdapter);
        const thirdProcessExecutive = createDurableExecutiveEpisode({
          machine: createExecutiveEpisodeMachine(hasher),
          journal: createExecutiveEventJournal(thirdAdapter),
          maxConflictRetries: 1
        });
        const finalState = await thirdProcessExecutive.load(episodeId);
        expect(finalState.tasks[dispatchInput.task.id]?.status).toBe("succeeded");
      } finally {
        await adapter.query(`DELETE FROM ${adapter.table("executive_event")} WHERE episode_id=$1`, [episodeId]);
        await adapter.query(`DELETE FROM ${adapter.table("executive_command")} WHERE episode_id=$1`, [episodeId]);
        await adapter.query(`DELETE FROM ${adapter.table("executive_episode")} WHERE episode_id=$1`, [episodeId]);
      }
    }
  );
});
