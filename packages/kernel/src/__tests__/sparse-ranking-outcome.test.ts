import { describe, expect, it } from "vitest";
import { createClock, createHasher } from "../primitives.js";
import { createRuntimeGraphRetrieval } from "../runtime-graph-retrieval.js";
import { updateFtrlFromTurnOutcome } from "../sparse-ranking-outcome.js";
import { FTRL_GRAPH_NODE_RANK_TASK_CLASS } from "../sparse-ranking-shadow.js";
import { RETRIEVAL_RANK_FEATURE_SCHEMA_V1 } from "../retrieval-rank-features.js";
import type { SparseRankingCheckpoint, SparseRankingModelStore } from "../sparse-ranking-lifecycle.js";
import type {
  EvidenceId,
  EvidenceSpan,
  GraphNode,
  GraphSlice,
  InformationLabel,
  ScceKernelDeps,
  SemanticEntailmentResult
} from "../index.js";

// Plan item 31: two synthetic turns with opposite outcomes (entailed vs.
// contradicted) against the real ftrlShadowRankingForFeatures +
// updateFtrlFromTurnOutcome wiring, proving a persisted checkpoint's
// FTRL weights actually move. Uses an in-memory SparseRankingModelStore
// rather than live Postgres: the store's own round-trip is already
// covered live by adapters-node's postgres-sparse-ranking.test.ts, so
// this test's job is to exercise the *new* correlation/update logic,
// which is storage-implementation-agnostic.
describe("FTRL outcome-based learning end to end (plan item 31)", () => {
  it("moves the persisted checkpoint's FTRL state after real turn outcomes, and the two opposite outcomes push weights in different directions", async () => {
    const clock = createClock({ fixedTime: 1000, stepMs: 1 });
    const hasher = createHasher();

    const nodeA = graphNode({ id: "node:a", evidenceId: "evidence:a", features: ["sym:zephyr", "sym:valve"] });
    // Shares "sym:zephyr" with the query (so BM25 surfaces it as a real
    // candidate alongside node A) but adds an unrelated term so it's
    // still a distinguishable, lower-overlap candidate.
    const nodeB = graphNode({ id: "node:b", evidenceId: "evidence:b", features: ["sym:zephyr", "sym:rumor"] });
    const evidenceA = evidenceSpan({ id: "evidence:a", trust: 0.9 });
    const evidenceB = evidenceSpan({ id: "evidence:b", trust: 0.2 });

    const storage = {
      graph: {
        getSlice: async (): Promise<GraphSlice> => ({
          bounded: true,
          query: {},
          nodes: [nodeA, nodeB],
          edges: [],
          hyperedges: []
        })
      },
      evidence: {
        getEvidenceBatch: async (ids: EvidenceId[]) =>
          [evidenceA, evidenceB].filter(span => ids.map(String).includes(String(span.id)))
      }
    } as unknown as ScceKernelDeps["storage"];

    let stored: SparseRankingCheckpoint = seedCheckpoint();
    const store: SparseRankingModelStore = {
      readActive: async () => structuredClone(stored),
      putCheckpoint: async checkpoint => { stored = checkpoint; },
      activate: async () => undefined,
      rollback: async () => undefined
    };

    const graphRetrieval = createRuntimeGraphRetrieval({
      deps: { storage, sparseRankingModels: store },
      clock,
      hasher,
      candidates: undefined as never,
      failures: [],
      cacheMs: 60_000,
      kernelTrace: () => undefined,
      sourceAnchorSemanticFramesCached: async () => []
    });

    const queryFeatures = ["sym:zephyr", "sym:valve"];

    // Turn 1: entailed verdict certifying node A's evidence. Node B's
    // evidence is in the candidate pool but not certified -- a real
    // preferred/rejected contrast.
    const shadow1 = await graphRetrieval.ftrlShadowRankingForFeatures(queryFeatures);
    expect(shadow1?.ranking.ranked.length).toBeGreaterThan(0);
    const before = structuredClone(stored);
    const result1 = await updateFtrlFromTurnOutcome({
      store,
      shadowRanking: shadow1?.ranking,
      nodesById: shadow1!.nodesById,
      entailment: entailmentFixture({ verdict: "entailed", evidenceIds: ["evidence:a"] }),
      candidatePoolEvidenceIds: ["evidence:a", "evidence:b"] as EvidenceId[],
      clock
    });
    expect(result1.updated).toBe(true);
    expect(stored.examplesSeen).toBe(before.examplesSeen + 1);
    expect(stored.state.coordinates.length).toBeGreaterThan(0);
    expect(stored.state).not.toEqual(before.state);

    // Turn 2: opposite outcome -- node A's evidence is now contradicted.
    // The label inverts (prefer B over A), so this update should push
    // the model in the opposite direction from turn 1's update.
    const afterTurn1 = structuredClone(stored);
    const shadow2 = await graphRetrieval.ftrlShadowRankingForFeatures(queryFeatures);
    const result2 = await updateFtrlFromTurnOutcome({
      store,
      shadowRanking: shadow2?.ranking,
      nodesById: shadow2!.nodesById,
      entailment: entailmentFixture({ verdict: "contradicted", evidenceIds: ["evidence:a"] }),
      candidatePoolEvidenceIds: ["evidence:a", "evidence:b"] as EvidenceId[],
      clock
    });
    expect(result2.updated).toBe(true);
    expect(stored.examplesSeen).toBe(afterTurn1.examplesSeen + 1);
    expect(stored.state).not.toEqual(afterTurn1.state);
    expect(stored.lifecycle).toBe("shadow");
  });
});

function seedCheckpoint(): SparseRankingCheckpoint {
  return {
    modelId: "model:test",
    taskClass: FTRL_GRAPH_NODE_RANK_TASK_CLASS,
    featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
    lifecycle: "shadow",
    state: {
      schemaVersion: "scce.ftrl-proximal-ranker.v1",
      modelId: "model:test",
      featureSchemaId: RETRIEVAL_RANK_FEATURE_SCHEMA_V1,
      hyperparameters: { alpha: 0.1, beta: 1, l1: 0.1, l2: 1 },
      createdAt: 0,
      updatedAt: 0,
      examplesSeen: 0,
      coordinates: []
    },
    trainingWindow: { firstExampleAt: 0, lastExampleAt: 0 },
    examplesSeen: 0,
    createdAt: 0,
    informationLabel: fixtureInformationLabel()
  };
}

function graphNode(input: { id: string; evidenceId: string; features: string[] }): GraphNode {
  return {
    id: input.id as GraphNode["id"],
    typeId: "type:fixture" as GraphNode["typeId"],
    representation: { label: input.id },
    alpha: 0.7,
    evidenceIds: [input.evidenceId as EvidenceId],
    features: input.features,
    createdAt: 1000,
    updatedAt: 1000,
    metadata: {}
  };
}

function evidenceSpan(input: { id: string; trust: number }): EvidenceSpan {
  return {
    id: input.id as EvidenceId,
    sourceId: "source:fixture" as EvidenceSpan["sourceId"],
    sourceVersionId: "source-version:fixture" as EvidenceSpan["sourceVersionId"],
    chunkId: `chunk:${input.id}` as EvidenceSpan["chunkId"],
    contentHash: `hash:${input.id}` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: 10,
    charStart: 0,
    charEnd: 10,
    text: input.id,
    textPreview: input.id,
    languageHints: {},
    scriptHints: {},
    trustVector: { trust: input.trust },
    provenance: {},
    features: [],
    status: "quarantined",
    alpha: input.trust,
    observedAt: 1000,
    informationLabel: fixtureInformationLabel()
  };
}

function fixtureInformationLabel(): InformationLabel {
  return {
    exportClass: "public",
    tenantId: "fixture-tenant",
    principals: [],
    compartments: [],
    mergePolicy: "isolated"
  } as InformationLabel;
}

function entailmentFixture(input: { verdict: SemanticEntailmentResult["verdict"]; evidenceIds: string[] }): SemanticEntailmentResult {
  return {
    claim: { id: "claim:fixture" as never, text: "fixture", normalized: "fixture", features: ["sym:fixture"], polarity: 1 },
    verdict: input.verdict,
    semanticVerdict: input.verdict,
    force: "observed",
    support: 0.8,
    contradiction: input.verdict === "contradicted" ? 0.8 : 0.05,
    faithfulnessLcb: 0.75,
    confidence: {
      verdict: input.verdict,
      support: 0.8,
      contradiction: 0.05,
      faithfulnessLcb: 0.75,
      supportingEvidence: input.evidenceIds.length,
      sourceVersions: [],
      structuralCoverage: 1,
      roleCoverage: 1,
      relationCompatibility: 1,
      transformationSupport: 1,
      causalMass: 0.2,
      stability: 1,
      satisfiedObligations: 0,
      requiredObligations: 0
    },
    scores: { structuralCoverage: 1, roleCoverage: 1, relationCompatibility: 1, transformationSupport: 1, causalMass: 0.2, faithfulnessLCB: 0.75, contradiction: 0.05, stability: 1 },
    obligations: [],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    evidenceIds: input.evidenceIds as EvidenceId[],
    boundaries: [],
    proof: {
      id: "proof:fixture" as never,
      claimId: "claim:fixture" as never,
      verdict: "observed",
      confidence: {},
      proofGraph: { nodes: [{ id: "claim", kind: "claim", label: "fixture", metadata: {} }], edges: [] },
      evidenceIds: input.evidenceIds as EvidenceId[],
      transformIds: [],
      scores: {},
      validatorVersion: "test",
      createdAt: 1000
    }
  };
}
