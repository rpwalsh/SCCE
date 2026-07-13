import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createScceKernel,
  featureSet,
  type AlphaTrace,
  type BuildTestResult,
  type ContentHash,
  type EvidenceId,
  type EvidenceSpan,
  type GraphSlice,
  type JsonValue,
  type ModelState,
  type ScceEvent,
  type ScceStorage,
  type SourceId,
  type SourceVersionId
} from "../index.js";

describe("kernel training", () => {
  it("promotes only orchestrator-selected evidence and trains language memory from it", async () => {
    const clock = createClock({ fixedTime: 1000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const sourceVersionId = "source:eligible:v1" as SourceVersionId;
    const eligible = evidenceSpan({
      id: "evidence:eligible",
      sourceVersionId,
      text: "Zephyr valve pressure stabilizes at 42 psi after calibration. The valve relation remains source grounded.",
      trust: 0.94,
      alpha: 0.91,
      status: "quarantined"
    });
    const rejected = evidenceSpan({
      id: "evidence:rejected",
      sourceVersionId: "source:rejected:v1" as SourceVersionId,
      text: "Untrusted rumor says the pump value changed with no source span.",
      trust: 0.12,
      alpha: 0.18,
      status: "quarantined"
    });
    const fixture = storageFixture({ evidence: [eligible, rejected], clockNow: () => clock.now() });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused in this test */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true
    });

    const result = await kernel.train({
      config: {
        learningGoals: ["learn source grounded zephyr valve pressure calibration"],
        promotion: { minTrust: 0.45 }
      }
    });

    expect(result.promotedEvidence).toBe(1);
    expect(fixture.promotedIds).toEqual([String(eligible.id)]);
    expect(fixture.languageWrites.observations).toBeGreaterThan(0);
    expect(fixture.languageWrites.models).toBeGreaterThan(0);
    expect(fixture.languageWrites.units).toBeGreaterThan(0);
    expect(fixture.languageWrites.patterns).toBeGreaterThan(0);
    expect(fixture.languageWrites.semanticFrames).toBeGreaterThan(0);
    expect(fixture.languageProfilesCreated).toBe(1);
    expect(fixture.writtenModel?.trainingSteps).toBe(1);
    const promotedEvent = fixture.events.find(event => event.typeId === "LearningPromoted");
    expect(promotedEvent).toBeDefined();
    const payload = promotedEvent?.payload as { selectedEvidenceIds?: string[]; trainingPromotion?: Array<{ evidenceId: string; promote: boolean }> };
    expect(payload.selectedEvidenceIds).toEqual([String(eligible.id)]);
    expect(payload.trainingPromotion?.find(item => item.evidenceId === String(eligible.id))?.promote).toBe(true);
    expect(payload.trainingPromotion?.find(item => item.evidenceId === String(rejected.id))?.promote).toBe(false);
  });

  it("uses source-derived metadata namespaces for promotion filters", async () => {
    const clock = createClock({ fixedTime: 2000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const webEvidence = evidenceSpan({
      id: "evidence:web",
      sourceVersionId: "source:web:v1" as SourceVersionId,
      text: "Fetched source table lists Nyota Uhura, James T Kirk, and Spock as Star Trek character rows.",
      trust: 0.9,
      alpha: 0.9,
      status: "quarantined",
      provenance: { metadata: { ingestionLane: "web-learning" } },
      trustVector: { trust: 0.9, sourceTrust: 0.9, structuralConfidence: 0.9, namespace: "web-learning" }
    });
    const localEvidence = evidenceSpan({
      id: "evidence:local",
      sourceVersionId: "source:local:v1" as SourceVersionId,
      text: "Local source table lists unrelated fixture rows.",
      trust: 0.9,
      alpha: 0.9,
      status: "quarantined"
    });
    const fixture = storageFixture({ evidence: [webEvidence, localEvidence], clockNow: () => clock.now() });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused in this test */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true
    });

    const result = await kernel.train({
      config: {
        learningGoals: ["learn fetched Star Trek character rows"],
        promotion: { minTrust: 0.45, namespaces: ["web-learning"] }
      }
    });

    expect(result.promotedEvidence).toBe(1);
    expect(fixture.promotedIds).toEqual([String(webEvidence.id)]);
  });

  it("refreshes graph retrieval after training mutates evidence state", async () => {
    const clock = createClock({ fixedTime: 3000, stepMs: 1 });
    const hasher = createHasher();
    const ids = createIdFactory({ clock, hasher, deterministicReplay: true });
    const evidence: EvidenceSpan[] = [];
    const fixture = storageFixture({ evidence, clockNow: () => clock.now() });
    const kernel = createScceKernel({
      storage: fixture.storage,
      files: { streamPath: async function* () { /* unused in this test */ } },
      buildTest: { executeProgram: async (): Promise<BuildTestResult> => ({ build: emptyCommandResult(), test: emptyCommandResult(), repairAttempted: false, repairApplied: false, passed: true, artifacts: [] }) },
      idFactory: ids,
      clock,
      deterministicReplay: true
    });

    await kernel.turn({ text: "Zephyr valve pressure stabilizes after calibration." });
    expect(fixture.evidenceSearchCalls).toBe(1);

    evidence.push(evidenceSpan({
      id: "evidence:zephyr",
      sourceVersionId: "source:zephyr:v1" as SourceVersionId,
      text: "Zephyr valve pressure stabilizes after calibration.",
      trust: 0.95,
      alpha: 0.94,
      status: "promoted"
    }));
    await kernel.train({ config: { learningGoals: ["Zephyr valve pressure stabilizes after calibration."], promotion: { minTrust: 0.4 } } });
    const callsAfterTrain = fixture.evidenceSearchCalls;

    await kernel.turn({ text: "Zephyr valve pressure stabilizes after calibration." });

    expect(fixture.evidenceSearchCalls).toBeGreaterThan(callsAfterTrain);
  });

  it("uses recent session turns as promoted conversation evidence", async () => {
    const clock = createClock({ fixedTime: 4000, stepMs: 1 });
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

    const result = await kernel.turn({
      text: "What is the release codename?",
      metadata: {
        session: {
          sessionId: "session:test",
          recentTurns: [
            { id: "turn:1", sessionId: "session:test", episodeId: "episode:prior", turnIndex: 1, roleId: "session.role.owner", text: "Aster is the release codename.", evidenceIds: [], createdAt: 3990 },
            { id: "turn:2", sessionId: "session:test", episodeId: "episode:prior", turnIndex: 2, roleId: "session.role.assistant", text: "Unsupported prior says the codename is Longs Peak.", evidenceIds: [], createdAt: 3991 }
          ]
        }
      }
    });

    const sessionEvidence = result.evidence.filter(span => String(span.id).startsWith("evidence_session_"));
    expect(sessionEvidence).toHaveLength(1);
    expect(sessionEvidence[0]?.text).toBe("Aster is the release codename.");
    expect(sessionEvidence[0]?.status).toBe("promoted");
  });

  it("treats current declarative session input as owner observation evidence", async () => {
    const clock = createClock({ fixedTime: 5000, stepMs: 1 });
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

    const result = await kernel.turn({
      text: "The release codename is Aster.",
      metadata: { session: { sessionId: "session:current", recentTurns: [] } }
    });

    const sessionEvidence = result.evidence.filter(span => String(span.id).startsWith("evidence_session_"));
    expect(sessionEvidence).toHaveLength(1);
    expect(sessionEvidence[0]?.text).toBe("The release codename is Aster.");
    expect(result.answer).toContain("Aster");
  });
});

function evidenceSpan(input: { id: string; sourceVersionId: SourceVersionId; text: string; trust: number; alpha: number; status: EvidenceSpan["status"]; provenance?: JsonValue; trustVector?: JsonValue }): EvidenceSpan {
  const contentHash = `hash:${input.id}` as ContentHash;
  return {
    id: input.id as EvidenceId,
    sourceId: "source:test" as SourceId,
    sourceVersionId: input.sourceVersionId,
    chunkId: `chunk:${input.id}` as EvidenceSpan["chunkId"],
    contentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: input.text.length,
    charStart: 0,
    charEnd: input.text.length,
    text: input.text,
    textPreview: input.text,
    languageHints: { language: "fixture" },
    scriptHints: { script: "Latn" },
    trustVector: input.trustVector ?? { trust: input.trust, sourceTrust: input.trust, structuralConfidence: input.trust },
    provenance: input.provenance ?? { namespace: "local", source: "kernel-training-test" },
    features: featureSet(input.text, 256),
    status: input.status,
    alpha: input.alpha,
    observedAt: 1000
  };
}

function storageFixture(input: { evidence: EvidenceSpan[]; clockNow: () => number }): {
  storage: ScceStorage;
  events: ScceEvent[];
  promotedIds: string[];
  evidenceSearchCalls: number;
  languageProfilesCreated: number;
  languageWrites: { observations: number; models: number; units: number; patterns: number; semanticFrames: number };
  writtenModel?: ModelState;
} {
  const events: ScceEvent[] = [];
  const promotedIds: string[] = [];
  let languageProfilesCreated = 0;
  let writtenModel: ModelState | undefined;
  let evidenceSearchCalls = 0;
  const languageWrites = { observations: 0, models: 0, units: 0, patterns: 0, semanticFrames: 0 };
  const currentGraph = () => graphSlice(input.evidence);
  const storage = {
    events: {
      append: async (event: ScceEvent) => { events.push(event); },
      appendBatch: async (rows: ScceEvent[]) => { events.push(...rows); },
      readEpisode: async () => events,
      readRange: async () => events,
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
      promoteEvidence: async (ids: EvidenceId[]) => {
        promotedIds.push(...ids.map(String));
        return ids.length;
      },
      getEvidence: async (id: EvidenceId) => input.evidence.find(span => String(span.id) === String(id)) ?? null,
      getEvidenceBatch: async (ids: EvidenceId[]) => input.evidence.filter(span => ids.map(String).includes(String(span.id))),
      searchEvidence: async () => {
        evidenceSearchCalls++;
        return input.evidence.map(span => ({ span, score: span.alpha, reason: "fixture" }));
      },
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
      writeModel: async (model: ModelState) => { writtenModel = model; },
      putLanguageProfile: async () => { languageProfilesCreated++; },
      listLanguageProfiles: async () => []
    },
    languageMemory: {
      putNgramObservation: async () => { languageWrites.observations++; },
      putNgramObservationsBatch: async (observations: readonly unknown[]) => { languageWrites.observations += observations.length; },
      putNgramModel: async () => { languageWrites.models++; },
      putLanguageUnit: async () => { languageWrites.units++; },
      putLanguagePattern: async () => { languageWrites.patterns++; },
      putSemanticFrame: async () => { languageWrites.semanticFrames++; },
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
    localization: unusedStore(),
    flowCache: unusedStore(),
    selfRewrite: unusedStore(),
    workspace: unusedStore()
  } as unknown as ScceStorage;
  void input.clockNow;
  return {
    storage,
    events,
    promotedIds,
    get evidenceSearchCalls() { return evidenceSearchCalls; },
    get languageProfilesCreated() { return languageProfilesCreated; },
    languageWrites,
    get writtenModel() { return writtenModel; }
  };
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
