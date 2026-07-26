import type {
  AlphaTrace,
  EvidenceId,
  EvidenceSpan,
  GraphSlice,
  JsonValue,
  ModelState,
  ScceEvent,
  ScceStorage
} from "../index.js";

// Extracted from kernel-training.test.ts's storageFixture() so
// evidence-promotion-evaluation.test.ts can build the same kind of
// in-memory storage without duplicating ~120 lines of ScceStorage
// boilerplate. Behavior is identical; only the name differs.
export function storageFixtureForEvaluation(input: { evidence: EvidenceSpan[]; clockNow: () => number }): {
  storage: ScceStorage;
  events: ScceEvent[];
  promotedIds: string[];
} {
  const events: ScceEvent[] = [];
  const promotedIds: string[] = [];
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
    localization: unusedStore(),
    flowCache: unusedStore(),
    selfRewrite: unusedStore(),
    workspace: unusedStore()
  } as unknown as ScceStorage;
  void input.clockNow;
  return { storage, events, promotedIds };
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

function unusedStore(): Record<string, (...args: never[]) => Promise<JsonValue>> {
  return new Proxy({}, {
    get: () => async () => null
  }) as Record<string, (...args: never[]) => Promise<JsonValue>>;
}
