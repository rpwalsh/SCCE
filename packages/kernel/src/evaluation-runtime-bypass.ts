import type { CcrResult } from "./ccr.js";
import type { IdFactory } from "./ids.js";
import {
  normalizePriorKey
} from "./kernel-answer-primitives.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { hashTextForLocalProof } from "./local-evidence-runtime.js";
import type {
  PowerWalkResult,
  PowerWalkSeedAnchor
} from "./powerwalk.js";
import {
  createHasher,
  featureSet,
  toJsonValue,
  weightedJaccard
} from "./primitives.js";
import type { RetrievalPlan } from "./retrieval.js";
import type {
  HybridRetrievalResult,
  RetrievalQuery
} from "./semantic-memory-index.js";
import type { SemanticProofResult } from "./semantic-proof-system.js";
import type {
  LanguageProfile,
  TurnResult
} from "./types.js";

export function emptySurfaceLanguageMemory(): {
  models: never[];
  observations: never[];
  units: never[];
  patterns: never[];
  semanticFrames: never[];
  requestControlPatterns: never[];
  surfaceProfile: LanguageProfile | undefined;
  state: LanguageMemoryRuntimeState;
  active: { activeImportRunIds: never[] };
  corpusPlan: never[];
} {
  const competenceVector = {
    scriptRecognition: 0,
    segmentationQuality: 0,
    lexicalCoverage: 0,
    phraseFluency: 0,
    syntacticCoverage: 0,
    semanticFrameCoverage: 0,
    translationAlignment: 0,
    entailmentReliability: 0,
    generationReliability: 0,
    correctionStability: 0,
    localizationReliability: 0
  };
  return {
    models: [],
    observations: [],
    units: [],
    patterns: [],
    semanticFrames: [],
    requestControlPatterns: [],
    surfaceProfile: undefined,
    state: {
      models: [],
      records: [],
      streamIds: [],
      languageHints: [],
      maxOrder: 0,
      observedSymbolCount: 0,
      vocabularySize: 0,
      importedUnits: [],
      importedPatterns: [],
      importedObservations: [],
      importedSemanticFrames: [],
      importedConstructionBundles: [],
      rejectedConstructionPatterns: [],
      importedLanguagePriorCount: 0,
      competenceVector,
      scope: {
        mode: "unscoped",
        profileIds: [],
        sourceVersionIds: [],
        purityProven: false,
        degraded: true,
        reason: "evaluation-language-memory-bypass"
      },
      audit: toJsonValue({
        source: "evaluation.language-memory-bypass",
        conditionDisabled: true
      })
    },
    active: { activeImportRunIds: [] },
    corpusPlan: []
  };
}

export function surfaceLanguageMemoryProfile(
  state: LanguageMemoryRuntimeState,
  disabled: boolean
): ReturnType<typeof toJsonValue> {
  if (disabled) {
    return toJsonValue({
      bypassed: true,
      reason: "condition-disabled",
      importedLanguagePriorCount: 0
    });
  }
  return toJsonValue({
    streamIds: state.streamIds,
    languageHints: state.languageHints,
    maxOrder: state.maxOrder,
    observedSymbolCount: state.observedSymbolCount,
    vocabularySize: state.vocabularySize,
    importedLanguagePriorCount: state.importedLanguagePriorCount,
    competenceVector: state.competenceVector,
    audit: state.audit
  });
}

export function disabledLearnedSemanticRetrieval(
  text: string,
  features: string[],
  hasher: ReturnType<typeof createHasher>
): {
  retrieval: HybridRetrievalResult;
  roleRetrieval: RetrievalPlan;
} {
  const query: RetrievalQuery = { text, features, limit: 80 };
  const audit = toJsonValue({
    source: "evaluation.learned-semantics-bypass",
    reason: "condition-disabled",
    lexicalSelectionRemainsInEvidenceBoundary: true
  });
  return {
    retrieval: {
      plan: {
        id: `retrieval_plan_disabled_${hasher.digestHex(text).slice(0, 24)}`,
        query,
        terms: [],
        shards: [],
        postgres: {
          preparedStatements: [],
          transaction: "read_committed",
          cursorRows: 0
        },
        residentMemoryBytes: 0,
        audit
      },
      candidates: [],
      selectedEvidenceIds: [],
      selectedNodeIds: [],
      diagnostics: audit
    },
    roleRetrieval: {
      query: text,
      queryFeatures: features,
      recall: [],
      expansionFeatures: [],
      graphSeeds: [],
      audit
    }
  };
}

export function queryConditionedSemanticSeedAnchors(
  candidates: readonly HybridRetrievalResult["candidates"][number][],
  queryFeatures: readonly string[],
  limit = 40
): PowerWalkSeedAnchor[] {
  const bestByNode = new Map<string, PowerWalkSeedAnchor>();
  for (const candidate of candidates) {
    if (!candidate.nodeId || !Number.isFinite(candidate.score) || candidate.score <= 0) continue;
    const overlap = weightedJaccard(queryFeatures, candidate.features);
    if (!(overlap > 0)) continue;
    const seed: PowerWalkSeedAnchor = {
      nodeId: candidate.nodeId,
      weight: Math.max(0, Math.min(1, candidate.score)),
      feature: `semantic-retrieval:query-overlap:${overlap.toFixed(6)}`
    };
    const key = String(seed.nodeId);
    const existing = bestByNode.get(key);
    if (!existing || seed.weight > existing.weight) bestByNode.set(key, seed);
  }
  return [...bestByNode.values()]
    .sort((left, right) => right.weight - left.weight || String(left.nodeId).localeCompare(String(right.nodeId)))
    .slice(0, Math.max(0, Math.min(64, Math.floor(limit))));
}

export function emptyPowerWalkResult(): PowerWalkResult {
  return {
    walks: [],
    embeddings: [],
    typePairWalkLengths: [],
    transitionAudit: [],
    cooccurrence: [],
    cooccurrenceState: {
      version: "powerwalk.cooccurrence.v3",
      window: 4,
      partitionPolicyHash: "evaluation-disabled",
      totalCount: 0,
      appliedSnapshotIds: [],
      entries: []
    },
    representation: {
      version: "powerwalk.sparse-ppmi-projection.v1",
      method: "positive_pointwise_mutual_information_with_seeded_sparse_projection",
      dimensions: 64,
      projectionSeed: "evaluation-disabled",
      trainPairs: 0,
      trainEvents: 0,
      priorEvents: 0,
      positivePpmiEntries: 0,
      representedNodes: 0,
      zeroContextNodes: 0,
      validationPairs: 0,
      validationEvents: 0,
      partitionPolicyHash: "evaluation-disabled",
      currentSplitHash: "evaluation-disabled",
      validationHash: "evaluation-disabled",
      priorStateDisposition: "not_provided",
      dataHash: "evaluation-disabled-no-data",
      modelHash: "evaluation-disabled-no-model",
      validationInterpretation: "not_available",
      excludedZeroContextNodes: 0,
      zeroContextPolicy: "excluded_from_similarity"
    },
    parameterization: toJsonValue({
      schema: "scce.powerwalk_parameter_bypass.v1",
      source: "evaluation.powerwalk-bypass",
      reason: "condition-disabled"
    })
  };
}

export function createAblatedSupportEntailment(input: {
  requestText: string;
  field: TurnResult["field"];
  idFactory: Pick<IdFactory, "claimId" | "proofId">;
  createdAt: number;
}): TurnResult["entailment"] {
  const normalized = normalizePriorKey(input.requestText);
  const features = featureSet(input.requestText, 256);
  const claim = {
    id: input.idFactory.claimId({
      normalized,
      polarity: 1,
      features: features.slice(0, 96)
    }),
    text: input.requestText,
    normalized,
    features,
    polarity: 1
  };
  const transformIds = ["evaluation-support-bypass"];
  const proofId = input.idFactory.proofId({
    claimId: claim.id,
    evidenceIds: [],
    transforms: transformIds,
    validatorVersion: "scce-evaluation-support-bypass-v1"
  });
  const scores = {
    structuralCoverage: 0,
    roleCoverage: 0,
    relationCompatibility: 0,
    transformationSupport: 0,
    causalMass: 0,
    faithfulnessLCB: 0,
    contradiction: 0,
    stability: 0
  };
  const confidence = {
    verdict: "unknown" as const,
    support: 0,
    contradiction: 0,
    faithfulnessLcb: 0,
    supportingEvidence: 0,
    sourceVersions: [],
    structuralCoverage: 0,
    roleCoverage: 0,
    relationCompatibility: 0,
    transformationSupport: 0,
    causalMass: 0,
    stability: 0,
    satisfiedObligations: 0,
    requiredObligations: 1
  };
  return {
    claim,
    verdict: "unknown",
    semanticVerdict: "unknown",
    force: "unknown",
    support: 0,
    contradiction: 0,
    faithfulnessLcb: 0,
    confidence,
    scores,
    obligations: [{
      id: "obligation:evaluation-support-engine-disabled",
      kind: "source_version",
      status: "missing",
      claimText: input.requestText,
      evidenceIds: [],
      sourceVersionIds: [],
      support: 0,
      contradiction: 0,
      required: true,
      reason: "evaluation.support_engine.disabled",
      metadata: toJsonValue({ supportEngineExecuted: false })
    }],
    mappings: [],
    transforms: [],
    counterexamples: [],
    missing: [],
    proof: {
      id: proofId,
      claimId: claim.id,
      verdict: "unknown",
      confidence: toJsonValue({
        ...confidence,
        supportEngineExecuted: false
      }),
      proofGraph: {
        nodes: [{
          id: String(claim.id),
          kind: "claim",
          label: "proof.claim.support_engine_disabled",
          metadata: toJsonValue({
            textHash: hashTextForLocalProof(input.requestText)
          })
        }],
        edges: []
      },
      evidenceIds: [],
      transformIds,
      scores: toJsonValue({
        supportEngineExecuted: false,
        scores
      }),
      validatorVersion: "scce-evaluation-support-bypass-v1",
      createdAt: input.createdAt
    },
    evidenceIds: [],
    boundaries: ["support-engine-disabled", "non-certifying"]
  };
}

export function emptySemanticProofResult(
  text: string,
  hasher: ReturnType<typeof createHasher>
): SemanticProofResult {
  const replay = toJsonValue({
    source: "evaluation.support-engine-bypass",
    claimHash: hasher.digestHex(text),
    supportEngineExecuted: false
  });
  return {
    id: `semantic_proof_disabled_${hasher.digestHex(text).slice(0, 24)}`,
    verdict: "underdetermined",
    claimAtoms: [],
    evidenceAtoms: [],
    graphAtoms: [],
    support: 0,
    contradiction: 0,
    coverage: 0,
    faithfulnessLcb: 0,
    obligations: [],
    counterexamples: [],
    steps: [],
    graph: { nodes: [], edges: [] },
    replay
  };
}

export function emptyCcrResult(text: string): CcrResult {
  const audit = toJsonValue({
    source: "evaluation.support-engine-bypass",
    queryHash: hashTextForLocalProof(text),
    accepted: false
  });
  return {
    l1: {
      candidates: [],
      queryFeatures: [],
      audit
    },
    l2: {
      survivors: [],
      prunedEdges: 0,
      davisKahan: null,
      chernoff: null,
      sde: null,
      minimumCover: null,
      audit
    } as unknown as CcrResult["l2"],
    l3: {
      sentences: [],
      answer: "",
      abstentions: ["support-engine-disabled"],
      audit
    },
    accepted: false,
    audit
  };
}
