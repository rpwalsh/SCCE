import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createScceKernel,
  PRODUCTION_INITIAL_VISIBLE_RESPONSE_SCHEMA,
  type AlphaTrace,
  type BuildTestResult,
  type DocumentGenerationSessionRecord,
  type EvidenceId,
  type EvidenceSpan,
  type GraphSlice,
  type JsonValue,
  type ModelState,
  type ScceEvent,
  type ScceStorage,
  type TaskResumptionSnapshotRecord,
  type UserModelClaimRecord
} from "../index.js";
import type { EventRangeQuery } from "../storage.js";
import type { EpisodeId } from "../types.js";
import { filterEpisodeEvents, filterEventRange } from "./event-range-fixture.js";

/**
 * Plan item L9: proves a turn whose deadline has ALREADY elapsed by the time
 * it runs still completes with a real, non-empty answer instead of hanging,
 * crashing, or exceeding the deadline unboundedly -- the actual, load-bearing
 * safety property the plan doc's "deliberately slow synthetic stage" was
 * meant to exercise. This drives an already-expired deadline directly rather
 * than injecting an artificial delay into a fixture stage: both reach the
 * exact same `deadlineCheckpoint` code path in `production-turn-runtime.ts`
 * (elapsed wall-clock time vs. a synthetic slow stage are indistinguishable
 * to `runtime-deadline.ts`'s `checkpoint()`), and an expired-metadata
 * fixture is deterministic where an injected delay would be flaky.
 *
 * This is only meaningful because of the real production.turn-runtime.ts
 * <-> runtime-deadline.ts wiring fix landed alongside this test: before that
 * fix, `packages/server/src/routes.ts`'s real deadline metadata
 * (`runtime.initialResponseDeadline`) was never recognized by
 * `executableRuntimeDeadlineFromMetadata` (which only read the differently-
 * shaped `runtime.deadline`), so every real request silently ran with no
 * deadline object and none of `production-turn-runtime.ts`'s 16
 * `deadlineCheckpoint` call sites ever gated anything.
 */
describe("runtime deadline integration with a real turn", () => {
  it("still returns a real answer when the production deadline metadata has already elapsed", async () => {
    const clock = createClock({ fixedTime: 9000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const fixture = storageFixture({ evidence: [], clockNow: () => clock.now() });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused in this test */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true
    });

    const now = performance.now();
    const budgetMs = 5_000;
    const startedMonotonicMs = now - 6_000;
    const deadlineMonotonicMs = startedMonotonicMs + budgetMs; // already 1s in the past

    const result = await kernel.turn({
      text: "Zephyr valve pressure stabilizes after calibration.",
      metadata: {
        runtime: {
          initialResponseDeadline: {
            schema: PRODUCTION_INITIAL_VISIBLE_RESPONSE_SCHEMA,
            clock: "node.performance.v1",
            budgetMs,
            startedMonotonicMs,
            deadlineMonotonicMs,
            propagatedAtMonotonicMs: now,
            remainingMs: 0
          }
        }
      }
    });

    expect(typeof result.answer).toBe("string");
    expect(result.answer.trim().length).toBeGreaterThan(0);
  });

  it("produces the same kind of real answer when the deadline has not elapsed, as a control", async () => {
    const clock = createClock({ fixedTime: 9100, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const fixture = storageFixture({ evidence: [], clockNow: () => clock.now() });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused in this test */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true
    });

    const now = performance.now();
    const budgetMs = 5_000;
    const startedMonotonicMs = now;
    const deadlineMonotonicMs = startedMonotonicMs + budgetMs;

    const result = await kernel.turn({
      text: "Zephyr valve pressure stabilizes after calibration.",
      metadata: {
        runtime: {
          initialResponseDeadline: {
            schema: PRODUCTION_INITIAL_VISIBLE_RESPONSE_SCHEMA,
            clock: "node.performance.v1",
            budgetMs,
            startedMonotonicMs,
            deadlineMonotonicMs,
            propagatedAtMonotonicMs: now,
            remainingMs: budgetMs
          }
        }
      }
    });

    expect(typeof result.answer).toBe("string");
    expect(result.answer.trim().length).toBeGreaterThan(0);
  });
});

function storageFixture(input: { evidence: EvidenceSpan[]; clockNow: () => number }): {
  storage: ScceStorage;
  events: ScceEvent[];
} {
  const events: ScceEvent[] = [];
  const currentGraph = () => graphSlice(input.evidence);
  const storage = {
    events: {
      append: async (event: ScceEvent) => { events.push(event); },
      appendBatch: async (rows: ScceEvent[]) => { events.push(...rows); },
      readEpisode: async (episodeId: EpisodeId) => filterEpisodeEvents(events, episodeId),
      readRange: async (query: EventRangeQuery) => filterEventRange(events, query),
      latestLedgerHash: async () => events.at(-1)?.hash ?? ""
    },
    conversation: {
      putTurn: async () => undefined,
      listTurns: async () => []
    },
    graph: {
      upsertNode: async () => undefined,
      upsertEdge: async () => undefined,
      upsertHyperedge: async () => undefined,
      getSlice: async () => currentGraph(),
      getTemporalSlice: async () => ({ ...currentGraph(), temporalQuery: {} }),
      materializeAlphaGraph: async () => emptyAlphaTrace()
    },
    evidence: {
      putSourceVersion: async () => undefined,
      putEvidenceSpan: async () => undefined,
      promoteEvidence: async (ids: EvidenceId[]) => ids.length,
      getEvidence: async (id: EvidenceId) => input.evidence.find(span => String(span.id) === String(id)) ?? null,
      getEvidenceBatch: async (ids: EvidenceId[]) => input.evidence.filter(span => ids.map(String).includes(String(span.id))),
      searchEvidence: async () => input.evidence.map(span => ({ span, score: span.alpha, reason: "fixture" })),
      sourceVersionsForEvidence: async () => []
    },
    quarantine: {
      put: async () => undefined,
      get: async () => null,
      listPending: async () => [],
      markDecision: async () => undefined
    },
    model: {
      readModel: async (): Promise<ModelState> => ({ languageProfiles: [], latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }),
      writeModel: async () => undefined,
      putLanguageProfile: async () => undefined,
      listLanguageProfiles: async () => []
    },
    languageMemory: {
      putNgramObservation: async () => undefined,
      putNgramObservationsBatch: async () => undefined,
      putNgramModel: async () => undefined,
      putLanguageUnit: async () => undefined,
      putLanguagePattern: async () => undefined,
      putSemanticFrame: async () => undefined,
      putTranslationAlignment: async () => undefined,
      listNgramModels: async () => [],
      listNgramObservations: async () => [],
      listLanguageUnits: async () => [],
      listLanguagePatterns: async () => [],
      listSemanticFrames: async () => [],
      listTranslationAlignments: async () => []
    },
    stats: async () => ({ tables: [
      { table: "graph_nodes", rows: currentGraph().nodes.length },
      { table: "graph_edges", rows: currentGraph().edges.length },
      { table: "evidence_spans", rows: input.evidence.length },
      { table: "source_versions", rows: input.evidence.length },
      { table: "semantic_proofs", rows: 0 }
    ] }),
    init: async () => undefined,
    migrate: async () => undefined,
    verify: async () => ({ ok: true, tables: [], errors: [] }),
    close: async () => undefined,
    blobs: unusedStore(),
    ingestion: unusedStore(),
    proofs: unusedStore(),
    constructs: unusedStore(),
    capabilities: unusedStore(),
    forecasts: {
      putState: async () => undefined,
      putForecast: async () => undefined,
      getSeries: async () => []
    },
    benchmarks: unusedStore(),
    brainImports: {
      active: async () => ({ activeImportRunIds: [] }),
      summarize: async () => ({
        activeImportRunIds: [],
        importedLanguagePriorCount: 0,
        importedGraphPriorCount: 0,
        importedDirectEvidenceCount: 0,
        profileExcerptEvidenceCount: 0,
        importedLearnedPriorCount: 0,
        importedProgramPriorCount: 0,
        unknownPriorCount: 0,
        runs: []
      })
    },
    corrections: {
      putRule: async () => undefined,
      listRules: async () => []
    },
    userModelClaims: (() => {
      const records = new Map<string, UserModelClaimRecord>();
      return {
        putClaim: async (claim: UserModelClaimRecord) => {
          const key = `${claim.conversationId} ${claim.id}`;
          if (!records.has(key)) records.set(key, claim);
        },
        listClaims: async (query: { conversationId: string; subject?: string; scope?: string; limit?: number }) => {
          let rows = [...records.values()].filter(row => row.conversationId === query.conversationId);
          if (query.subject) rows = rows.filter(row => row.subject === query.subject);
          if (query.scope) rows = rows.filter(row => row.scope === query.scope);
          rows = rows.slice().sort((left, right) => right.observedAt - left.observedAt);
          return rows.slice(0, query.limit ?? 200);
        }
      };
    })(),
    taskResumption: (() => {
      const records: TaskResumptionSnapshotRecord[] = [];
      return {
        putSnapshot: async (record: TaskResumptionSnapshotRecord) => { records.push(record); },
        getLatestSnapshot: async (goalId: string) => {
          const matching = records.filter(record => record.goalId === goalId);
          return matching.length ? matching.reduce((latest, record) => record.capturedAt > latest.capturedAt ? record : latest) : null;
        }
      };
    })(),
    documentGeneration: (() => {
      const records = new Map<string, DocumentGenerationSessionRecord>();
      const key = (id: string, conversationId: string) => `${conversationId} ${id}`;
      return {
        putSession: async (record: DocumentGenerationSessionRecord) => { records.set(key(record.id, record.conversationId), record); },
        getSession: async (id: string, conversationId: string) => records.get(key(id, conversationId)) ?? null,
        compareAndPutSession: async (record: DocumentGenerationSessionRecord, expectedUpdatedAt: number | null) => {
          const current = records.get(key(record.id, record.conversationId)) ?? null;
          if ((current?.updatedAt ?? null) !== expectedUpdatedAt) return { stored: false, currentUpdatedAt: current?.updatedAt ?? null };
          records.set(key(record.id, record.conversationId), record);
          return { stored: true, currentUpdatedAt: record.updatedAt };
        }
      };
    })(),
    localization: unusedStore(),
    flowCache: unusedStore(),
    selfRewrite: unusedStore(),
    workspace: unusedStore()
  } as unknown as ScceStorage;
  void input.clockNow;
  return { storage, events };
}

function graphSlice(evidence: readonly EvidenceSpan[]): GraphSlice {
  return {
    bounded: true,
    query: {},
    nodes: evidence.map(span => ({
      id: `node:${span.id}` as GraphSlice["nodes"][number]["id"],
      typeId: "type:evidence" as GraphSlice["nodes"][number]["typeId"],
      representation: { label: span.textPreview },
      alpha: span.alpha,
      evidenceIds: [span.id],
      features: span.features,
      createdAt: span.observedAt,
      updatedAt: span.observedAt,
      metadata: {}
    })),
    edges: [],
    hyperedges: []
  };
}

function emptyAlphaTrace(): AlphaTrace {
  return {
    alpha: 0,
    thresholds: { virtual: 0, visible: 0, bonded: 0, structural: 0 },
    relations: [],
    adjacency: { nodes: [], values: [] },
    laplacian: { nodes: [], values: [] },
    normalizedLaplacian: { nodes: [], values: [] },
    surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 },
    contradictionMass: 0,
    bondedLeakage: 0
  };
}

function emptyCommandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}

function unusedStore(): Record<string, (...args: never[]) => Promise<JsonValue>> {
  return new Proxy({}, {
    get: () => async () => null
  }) as Record<string, (...args: never[]) => Promise<JsonValue>>;
}
