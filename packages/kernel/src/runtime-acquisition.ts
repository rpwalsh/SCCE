import { createCapabilityExecutorRegistry, dispatchCapabilityTask, type CapabilityExecutor, type CapabilityDispatchDisposition } from "./capability-dispatcher.js";
import { createEventFactory } from "./events.js";
import { uniqueKernelStrings } from "./kernel-answer-primitives.js";
import { canonicalStringify, createHasher, redactSecrets, sourceTextSurface, toJsonValue } from "./primitives.js";
import { POLICY_OBJECTIVE_SCHEMA_ID, policyFingerprint, policyObjectiveVector, type PolicyEvaluation } from "./policy-evolution.js";
import { type RuntimeDeadlineDecision } from "./runtime-deadline.js";
import type { PriorRejectedHypothesis, RuntimeReplanMotion, RuntimeReplanTrigger } from "./runtime-motion.js";
import {
  runtimeMotionFailure
} from "./runtime-motion.js";
import { DEFAULT_POLICY } from "./safety.js";
import type { ScceKernelDeps } from "./storage.js";
import type {
  EpisodeId,
  IngestInput,
  IngestResult,
  JsonValue,
  OwnerInput,
  RequestedAuthority,
  ScceEvent
} from "./types.js";

const WEB_SEARCH_CAPABILITY_ID = "connector.web_search";

/**
 * Routes the read-only web-search connector call through the executive
 * dispatcher (Part A finding 9's dispatcher work, plan item 43: one
 * real, low-risk connector capability end to end). Deliberately
 * fail-open on the ledger, never on execution -- matching
 * dispatchBuildTestThroughExecutive's pattern: if deps.executive is
 * absent or dispatch itself throws, the caller falls back to calling
 * deps.connectors.search directly, so durable attestation can never
 * prevent a real search from happening.
 */
async function dispatchWebSearchThroughExecutive(input: {
  deps: ScceKernelDeps;
  episodeId: EpisodeId;
  queryHash: string;
  query: string;
  limit: number;
  hasher: ReturnType<typeof createHasher>;
}): Promise<Awaited<ReturnType<NonNullable<ScceKernelDeps["connectors"]>["search"]>> | undefined> {
  const executive = input.deps.executive;
  const connectors = input.deps.connectors;
  if (!executive || !connectors) return undefined;

  let capturedRows: Awaited<ReturnType<typeof connectors.search>> | undefined;
  const executor: CapabilityExecutor = {
    // A read query has no durable effect to duplicate, so retrying it
    // is inherently as safe as if the provider deduplicated by key --
    // the closest fit among the three declared contracts.
    descriptor: { capabilityId: WEB_SEARCH_CAPABILITY_ID, idempotency: "provider-enforced", rollback: "unavailable" },
    execute: async request => {
      const payload = request.payload as unknown as { query: string; limit: number };
      const rows = await connectors.search(payload.query, payload.limit);
      capturedRows = rows;
      return {
        status: "succeeded",
        outputRefs: rows.map(row => row.uri),
        evidenceRefs: [`web_search.results.${rows.length}`],
        attestationRef: `web_search.${request.invocation.idempotencyKey}`
      };
    }
  };

  const ownerId = input.deps.informationAccess?.principalId ?? "scce-runtime";
  const policyVersionId = `policy_${input.hasher.digestHex(JSON.stringify(input.deps.policy ?? {})).slice(0, 32)}`;
  const goalId = `goal_web_search_${input.queryHash}`;
  const taskId = `task_web_search_${input.queryHash}`;

  try {
    const dispatched = await dispatchCapabilityTask(
      { executive, executors: createCapabilityExecutorRegistry([executor]), hasher: input.hasher, now: () => Date.now() },
      {
        episodeId: input.episodeId,
        ownerId,
        policyVersionId,
        goal: { id: goalId, goalClassId: "goal.class.web_search", objectiveRef: input.queryHash, requirementIds: [], ownerId },
        task: {
          id: taskId,
          goalId,
          taskClassId: "task.class.web_search",
          requirementIds: [],
          dependencyTaskIds: [],
          capabilityId: WEB_SEARCH_CAPABILITY_ID,
          inputRef: input.queryHash,
          policyVersionId,
          controls: {
            authority: {
              authorityClassId: "authority.class.web_search",
              subjectId: ownerId,
              requiredScopeIds: [],
              state: "not_required",
              justificationRef: input.queryHash
            },
            approval: {
              policyId: "approval.policy.web_search",
              state: "not_required",
              approverClassIds: [],
              justificationRef: input.queryHash
            }
          },
          rollback: {
            mode: "not_required",
            justificationRef: "read-only web search has no durable effect to roll back"
          }
        },
        payload: { query: input.query, limit: input.limit } as unknown as JsonValue,
        outcomeEvidenceRefs: []
      }
    );
    if (input.deps.storage.policyEvolution) {
      await recordConnectorDispatchPolicyEvaluation({
        deps: input.deps,
        hasher: input.hasher,
        disposition: dispatched.disposition,
        windowRef: dispatched.receipt?.id ?? dispatched.attemptId ?? input.queryHash,
        createdAt: Date.now()
      });
    }
  } catch {
    // Fail-open: an executive/journal error must never block the real
    // search. If the executor already ran and captured rows, those are
    // still used below; if not, the caller's own try/catch around this
    // whole helper falls back to calling connectors.search directly.
  }
  return capturedRows;
}

/**
 * Records one real PolicyEvaluation from a real, in-production dispatch
 * decision (plan item 53 -- the first thing that actually writes to
 * `policyEvolution.putEvaluation`; the store and aggregation logic
 * already existed with nothing feeding it). Deliberately narrow: a
 * connector dispatch has no evidence/contradiction concept at all, so
 * `evidenceCoverage`/`contradictionRate` are set to their vacuous
 * best-case values (1 and 0) rather than fabricated -- this evaluation
 * genuinely only measures governance/task success for this one
 * dispatch, not proof quality. `governanceSuccessRate` and
 * `taskSuccessRate` collapse to the same real signal at this scope:
 * there is no separate "task" concept apart from whether the dispatch
 * itself succeeded.
 */
export async function recordConnectorDispatchPolicyEvaluation(input: {
  deps: ScceKernelDeps;
  hasher: ReturnType<typeof createHasher>;
  disposition: CapabilityDispatchDisposition;
  windowRef: string;
  createdAt: number;
}): Promise<void> {
  const policyEvolution = input.deps.storage.policyEvolution;
  if (!policyEvolution) return;
  const successRate = input.disposition === "succeeded" ? 1 : input.disposition === "indeterminate" ? 0.5 : 0;
  const rates = {
    evidenceCoverage: 1,
    governanceSuccessRate: successRate,
    contradictionRate: 0,
    rollbackRate: 0,
    taskSuccessRate: successRate
  };
  const resolvedPolicy = { ...DEFAULT_POLICY, ...(input.deps.policy ?? {}) };
  const fingerprint = policyFingerprint(resolvedPolicy);
  const evaluation: PolicyEvaluation = {
    id: `policy_eval_${input.hasher.digestHex(canonicalStringify({ fingerprint, windowRef: input.windowRef, createdAt: input.createdAt })).slice(0, 40)}`,
    policyFingerprint: fingerprint,
    objectiveSchemaId: POLICY_OBJECTIVE_SCHEMA_ID,
    vector: rates,
    objectives: policyObjectiveVector(rates),
    evaluationWindow: { firstEventId: input.windowRef, lastEventId: input.windowRef },
    observations: 1,
    createdAt: input.createdAt,
    informationLabel: {
      tenantId: input.deps.informationAccess?.tenantId ?? "scce.local",
      principals: input.deps.informationAccess?.principalId ? [input.deps.informationAccess.principalId] : [],
      compartments: [],
      // A non-public label requires at least one principal (see
      // information-flow.ts's normalizeInformationLabel) -- without a
      // configured principalId there is no real access boundary to scope
      // this telemetry to, so it degrades to public rather than writing a
      // label that fails its own validation on every later read.
      exportClass: input.deps.informationAccess?.principalId ? "internal" : "public",
      mergePolicy: "isolated"
    }
  };
  await policyEvolution.putEvaluation(evaluation);
}

export function createRuntimeAcquisition(options: {
  deps: ScceKernelDeps;
  eventFactory: ReturnType<typeof createEventFactory>;
  hasher: ReturnType<typeof createHasher>;
  failures: string[];
  append(event: ScceEvent): Promise<ScceEvent>;
  ingest(input: IngestInput): Promise<IngestResult>;
}) {
  const { deps, eventFactory, hasher, failures, append, ingest: ingestSource } = options;


  async function learnHydrateReplan(input: {
    ownerInput: OwnerInput;
    episodeId: EpisodeId;
    requestedAuthority: RequestedAuthority;
    trigger: RuntimeReplanTrigger;
    events: ScceEvent[];
    priorRejectedHypotheses?: PriorRejectedHypothesis[];
  }): Promise<RuntimeReplanMotion> {
    const queryHash = hasher.digestHex(input.ownerInput.text);
    const guardId = `runtime-motion:${hasher.digestHex(`${String(input.episodeId)}\u001f${queryHash}\u001f${input.trigger}`).slice(0, 32)}`;
    const motionFailures: string[] = [];
    let searchResultCount = 0;
    let fetchedSourceCount = 0;
    let ingestedSourceCount = 0;
    let ingestedEvidenceCount = 0;
    const sourceUris: string[] = [];
    const sourceSurfaces: string[] = [];
    input.events.push(await append(eventFactory.create({
      episodeId: input.episodeId,
      typeId: "RuntimeMotionPlanned",
      payload: toJsonValue({
        schema: "scce.runtime_motion.learn_hydrate_replan.v1",
        motionId: "motion.learn_hydrate_replan",
        guardId,
        attempt: 1,
        trigger: input.trigger,
        requestedAuthority: input.requestedAuthority,
        queryHash,
        connectorConfigured: Boolean(deps.connectors),
        readOnlyOperations: ["search", "fetch"]
      })
    })));

    if (deps.connectors) {
      let searchRows: Awaited<ReturnType<typeof deps.connectors.search>> = [];
      try {
        const dispatched = deps.executive
          ? await dispatchWebSearchThroughExecutive({ deps, episodeId: input.episodeId, queryHash, query: input.ownerInput.text, limit: 3, hasher })
          : undefined;
        searchRows = dispatched ?? await deps.connectors.search(input.ownerInput.text, 3);
        searchResultCount = searchRows.length;
        sourceSurfaces.push(...searchRows.flatMap(row => [row.title, row.snippet])
          .map(surface => sourceTextSurface(surface, 320))
          .filter(Boolean));
      } catch (error) {
        motionFailures.push(runtimeMotionFailure("search", error));
      }
      const seenUris = new Set<string>();
      for (const searchRow of searchRows.slice(0, 3)) {
        const searchUri = searchRow.uri.trim();
        if (!searchUri || seenUris.has(searchUri)) continue;
        seenUris.add(searchUri);
        try {
          const fetched = await deps.connectors.fetch(searchUri);
          if (fetched.bytes.byteLength === 0) {
            motionFailures.push(`fetch returned zero bytes: ${redactSecrets(searchUri)}`);
            continue;
          }
          fetchedSourceCount++;
          const canonicalUri = fetched.uri.trim() || searchUri;
          const ingest = await ingestSource({
            uri: canonicalUri,
            namespace: "runtime-acquisition",
            sourceAdmission: {
              sourceClass: "runtime_web",
              intendedUse: "direct_evidence",
              promotionAuthority: "automatic"
            },
            sourceTrust: {
              identity: 0.68,
              integrity: 1,
              parserReliability: 0.78,
              directness: 0.72,
              authority: 0.52,
              freshness: 0.9,
              independenceGroup: runtimeWebIndependenceGroup(canonicalUri),
              accessScope: "public",
              licenseStatus: "unknown"
            },
            content: fetched.bytes,
            mediaType: fetched.mediaType || "application/octet-stream",
            metadata: toJsonValue({
              schema: "scce.runtime_acquired_source.v1",
              canonicalUri,
              sourceUri: canonicalUri,
              uri: canonicalUri,
              title: searchRow.title,
              snippet: searchRow.snippet,
              acquisition: {
                motionId: "motion.learn_hydrate_replan",
                guardId,
                trigger: input.trigger,
                requestedAuthority: input.requestedAuthority,
                parentEpisodeId: String(input.episodeId),
                search: {
                  uri: searchUri,
                  title: searchRow.title,
                  snippet: searchRow.snippet,
                  metadata: searchRow.metadata
                },
                fetch: {
                  uri: canonicalUri,
                  mediaType: fetched.mediaType,
                  metadata: fetched.metadata
                }
              }
            })
          });
          ingestedSourceCount += ingest.sources;
          if (ingest.events.some(event => event.typeId === "SourcePromoted")) ingestedEvidenceCount += ingest.evidence;
          if (ingest.sources > 0) sourceUris.push(canonicalUri);
        } catch (error) {
          motionFailures.push(runtimeMotionFailure(`fetch_ingest:${searchUri}`, error));
        }
      }
    }

    const status: RuntimeReplanMotion["status"] = !deps.connectors
      ? "unavailable"
      : ingestedEvidenceCount > 0
        ? "hydrated"
        : motionFailures.length > 0 && searchResultCount === 0
          ? "failed"
          : "empty";
    const motion: RuntimeReplanMotion = {
      schema: "scce.runtime_motion.learn_hydrate_replan.v1",
      motionId: "motion.learn_hydrate_replan",
      guardId,
      attempt: 1,
      trigger: input.trigger,
      requestedAuthority: input.requestedAuthority,
      parentEpisodeId: String(input.episodeId),
      queryHash,
      connectorConfigured: Boolean(deps.connectors),
      status,
      searchResultCount,
      fetchedSourceCount,
      ingestedSourceCount,
      ingestedEvidenceCount,
      sourceUris: uniqueKernelStrings(sourceUris).slice(0, 3),
      sourceSurfaces: uniqueKernelStrings(sourceSurfaces).slice(0, 6),
      failures: motionFailures.slice(0, 6),
      priorRejectedHypotheses: input.priorRejectedHypotheses ?? []
    };
    input.events.push(await append(eventFactory.create({
      episodeId: input.episodeId,
      typeId: "RuntimeMotionCompleted",
      payload: toJsonValue(motion)
    })));
    return motion;
  }

  function runtimeWebIndependenceGroup(uri: string): string {
    try {
      return `runtime-web:${new URL(uri).hostname.toLocaleLowerCase()}`;
    } catch {
      return `runtime-web:${hasher.digestHex(uri).slice(0, 24)}`;
    }
  }


  function runtimeMotionDeferredByDeadline(input: {
    episodeId: EpisodeId;
    requestedAuthority: RequestedAuthority;
    trigger: RuntimeReplanTrigger;
    requestText: string;
    connectorConfigured: boolean;
    decision?: RuntimeDeadlineDecision;
  }): RuntimeReplanMotion {
    const queryHash = hasher.digestHex(input.requestText);
    const guardId = `runtime-motion:${hasher.digestHex(`${String(input.episodeId)}\u001f${queryHash}\u001f${input.trigger}\u001fdeadline`).slice(0, 32)}`;
    const reason = input.decision
      ? `deadline_guard:not_started:${input.decision.phase}:${input.decision.reason}`
      : "deadline_guard:not_started";
    return {
      schema: "scce.runtime_motion.learn_hydrate_replan.v1",
      motionId: "motion.learn_hydrate_replan",
      guardId,
      attempt: 1,
      trigger: input.trigger,
      requestedAuthority: input.requestedAuthority,
      parentEpisodeId: String(input.episodeId),
      queryHash,
      connectorConfigured: input.connectorConfigured,
      status: "unavailable",
      searchResultCount: 0,
      fetchedSourceCount: 0,
      ingestedSourceCount: 0,
      ingestedEvidenceCount: 0,
      sourceUris: [],
      sourceSurfaces: [],
      failures: [reason],
      priorRejectedHypotheses: []
    };
  }

  return { learnHydrateReplan, runtimeMotionDeferredByDeadline };
}
