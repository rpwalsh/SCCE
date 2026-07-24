import { createCandidateEngine } from "./candidate.js";
import { traceEvent } from "./debug/trace.js";
import { discourseObjectStateFromMetadata } from "./discourse-state.js";
import { evidenceProofBoundary } from "./proof-boundary.js";
import { genericQuestionSignal, jsonRecord, kernelNumber, kernelString, kernelStringArray, namedSubjectAnchors, normalizePriorKey, requestContentSurface, splitPriorUnits, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import { relevanceRequestFocuses } from "./learned-graph-prior-runtime.js";
import {
  evidenceForRequest,
  promotedSessionEvidence,
  requestNeedsSourceAnchoredEvidence,
  sessionOwnerObservationSurface,
  sourceAnchorPhraseContains,
  sourceAnchoredEvidenceForRequest,
  sourceEvidenceAnchorsForRequest,
  temporalCounterexampleExpected
} from "./local-evidence-runtime.js";
import { anchorFeatureSet, clamp01, createClock, createHasher, featureSet, toJsonValue } from "./primitives.js";
import type { RuntimeGraphSliceValue } from "./runtime-graph-cache.js";
import {
  estimateRuntimeGraphSliceBytes,
  fitRuntimeGraphSliceToBudget,
  positiveRuntimeInt,
  runtimeFlag
} from "./runtime-graph-cache.js";
import type { ScceKernelDeps, SemanticFrameRecord } from "./storage.js";
import type {
  EvidenceSpan,
  GraphEdge,
  GraphNode,
  GraphSlice,
  JsonValue,
  OwnerInput
} from "./types.js";



type SourceAnchoredEvidenceSelection = {
  evidence: EvidenceSpan[];
  semanticFrameBoundEvidenceIds: string[];
};


interface GraphSliceCacheEntry {
  loadedAt: number;
  accessedAt: number;
  hits: number;
  bytes: number;
  source: "hot-neighborhood" | "postgres";
  value: RuntimeGraphSliceValue;
}


interface HotGraphNeighborhood {
  key: string;
  loadedAt: number;
  bytes: number;
  value: RuntimeGraphSliceValue;
  nodeById: Map<string, GraphNode>;
  edgeById: Map<string, GraphEdge>;
  hyperedgeById: Map<string, GraphSlice["hyperedges"][number]>;
  edgeByNodeId: Map<string, GraphEdge[]>;
  hyperedgeByNodeId: Map<string, GraphSlice["hyperedges"][number][]>;
  featureNodeIds: Map<string, Set<string>>;
  evidenceById: Map<string, EvidenceSpan>;
  evidenceNodeIds: Map<string, Set<string>>;
  evidenceEdgeIds: Map<string, Set<string>>;
  evidenceHyperedgeIds: Map<string, Set<string>>;
  sourceAnchorEvidenceIds: Map<string, Set<string>>;
}

// Hard resident-walk caps: environment sizing may enlarge the hydrated cache,
// but a turn cannot enlarge this query frontier.
const HOT_QUERY_RADIUS = 2;
const HOT_QUERY_SEED_LIMIT = 24;
const HOT_QUERY_NODE_LIMIT = 96;
const HOT_QUERY_EDGE_LIMIT = 192;
const HOT_QUERY_HYPEREDGE_LIMIT = 48;
const HOT_QUERY_EDGE_BRANCH_LIMIT = 4;
const HOT_QUERY_HYPEREDGE_BRANCH_LIMIT = 4;

export function createRuntimeGraphRetrieval(options: {
  deps: Pick<ScceKernelDeps, "storage">;
  clock: ReturnType<typeof createClock>;
  hasher: ReturnType<typeof createHasher>;
  candidates: ReturnType<typeof createCandidateEngine>;
  failures: string[];
  cacheMs: number;
  kernelTrace(event: Parameters<typeof traceEvent>[1]): void;
  sourceAnchorSemanticFramesCached(): Promise<Array<{ frame: SemanticFrameRecord; surfaceUnits: string[] }>>;
}) {
  const { deps, clock, hasher, candidates, failures, kernelTrace, sourceAnchorSemanticFramesCached } = options;
  const surfaceLanguageMemoryCacheMs = options.cacheMs;

  const graphSliceCacheMaxEntries = positiveRuntimeInt("SCCE_GRAPH_SLICE_CACHE_ENTRIES", 128);

  const graphSliceCacheMaxBytes = positiveRuntimeInt("SCCE_GRAPH_SLICE_CACHE_MB", 256) * 1024 * 1024;

  const hotNeighborhoodEnabled = runtimeFlag("SCCE_HOT_NEIGHBORHOOD", true);

  const hotNeighborhoodNodeLimit = positiveRuntimeInt("SCCE_HOT_NEIGHBORHOOD_NODES", 3000);

  const hotNeighborhoodEdgeLimit = positiveRuntimeInt("SCCE_HOT_NEIGHBORHOOD_EDGES", 6000);

  const hotNeighborhoodEvidenceLimit = positiveRuntimeInt("SCCE_HOT_NEIGHBORHOOD_EVIDENCE", 3000);

  const hotNeighborhoodPostingCap = positiveRuntimeInt("SCCE_HOT_NEIGHBORHOOD_POSTING_CAP", 512);

  const sourceAnchorHotNodeLimit = positiveRuntimeInt("SCCE_SOURCE_ANCHOR_HOT_NODES", 16);

  const sourceAnchorHotEdgeLimit = positiveRuntimeInt("SCCE_SOURCE_ANCHOR_HOT_EDGES", 32);

  const sourceAnchorEvidenceCacheMaxEntries = positiveRuntimeInt("SCCE_SOURCE_ANCHOR_EVIDENCE_CACHE_ENTRIES", 4096);

  const graphSliceCache = new Map<string, GraphSliceCacheEntry>();

  let graphSliceCacheBytes = 0;

  let runtimeCacheEpoch = 0;

  let requireDurableGraphLookup = false;

  let hotNeighborhood: HotGraphNeighborhood | undefined;

  let hotNeighborhoodLoad: Promise<HotGraphNeighborhood | undefined> | undefined;

  const sourceAnchorEvidenceCache = new Map<string, { loadedAt: number; value: EvidenceSpan }>();


  async function sourceAnchorEvidenceBatchCached(
    ids: readonly EvidenceSpan["id"][],
    residentOnly = false
  ): Promise<EvidenceSpan[]> {
    const boundedIds = uniqueKernelStrings(ids.map(String))
      .slice(0, sourceAnchorEvidenceCacheMaxEntries);
    if (!boundedIds.length) return [];
    const now = clock.now();
    const selected = new Map<string, EvidenceSpan>();
    const hot = await hotNeighborhoodIfResident();
    for (const id of boundedIds) {
      const cached = sourceAnchorEvidenceCache.get(id);
      if (cached && now - cached.loadedAt < surfaceLanguageMemoryCacheMs) {
        selected.set(id, cached.value);
        continue;
      }
      const resident = hot?.evidenceById.get(id);
      if (resident) {
        selected.set(id, resident);
        sourceAnchorEvidenceCache.set(id, { loadedAt: now, value: resident });
      }
    }
    const missing = boundedIds
      .filter(id => !selected.has(id))
      .map(id => id as EvidenceSpan["id"]);
    if (missing.length && !residentOnly) {
      const loaded = await deps.storage.evidence.getEvidenceBatch(missing);
      for (const span of loaded) {
        const id = String(span.id);
        selected.set(id, span);
        sourceAnchorEvidenceCache.set(id, { loadedAt: now, value: span });
      }
    }
    while (sourceAnchorEvidenceCache.size > sourceAnchorEvidenceCacheMaxEntries) {
      const oldest = [...sourceAnchorEvidenceCache.entries()]
        .sort((left, right) => left[1].loadedAt - right[1].loadedAt)[0];
      if (!oldest) break;
      sourceAnchorEvidenceCache.delete(oldest[0]);
    }
    return boundedIds
      .map(id => selected.get(id))
      .filter((span): span is EvidenceSpan => Boolean(span));
  }


  function cachedGraphSlice(cacheKey: string): RuntimeGraphSliceValue | undefined {
    const cached = graphSliceCache.get(cacheKey);
    if (!cached) return undefined;
    cached.accessedAt = clock.now();
    cached.hits++;
    return cached.value;
  }


  function cacheGraphSlice(cacheKey: string, value: RuntimeGraphSliceValue, source: GraphSliceCacheEntry["source"]): RuntimeGraphSliceValue {
    const bytes = estimateRuntimeGraphSliceBytes(value);
    if (bytes > graphSliceCacheMaxBytes) return value;
    const now = clock.now();
    const previous = graphSliceCache.get(cacheKey);
    if (previous) graphSliceCacheBytes -= previous.bytes;
    graphSliceCache.set(cacheKey, { loadedAt: now, accessedAt: now, hits: previous?.hits ?? 0, bytes, source, value });
    graphSliceCacheBytes += bytes;
    evictGraphSliceCache();
    return value;
  }


  function evictGraphSliceCache(): void {
    while (graphSliceCache.size > graphSliceCacheMaxEntries || graphSliceCacheBytes > graphSliceCacheMaxBytes) {
      const victim = [...graphSliceCache.entries()]
        .sort((left, right) => left[1].accessedAt - right[1].accessedAt || left[1].hits - right[1].hits)[0];
      if (!victim) return;
      graphSliceCache.delete(victim[0]);
      graphSliceCacheBytes -= victim[1].bytes;
    }
  }


  async function graphForText(text: string, options: {
    allowSemanticFrameEvidence?: boolean;
    sourceAnchoringRequired?: boolean;
    residentOnly?: boolean;
  } = {}) {
    const queryPreparationStarted = Date.now();
    const allowSemanticFrameEvidence = options.allowSemanticFrameEvidence !== false;
    const sourceAnchoringRequired = options.sourceAnchoringRequired ?? requestNeedsSourceAnchoredEvidence(text);
    const residentOnly = options.residentOnly === true;
    const sourceAnchorFeatures = sourceAnchoringRequired ? sourceAnchorRetrievalFeatures(text) : [];
    const features = sourceAnchoringRequired
      ? sourceAnchorFeatures.map(feature => feature.slice("anchor:".length))
      : graphRetrievalFeatures(text);
    const topicTerms = sourceAnchoringRequired
      ? sourceEvidenceAnchorsForRequest(text).slice(0, 8)
      : graphTopicTermsForText(text);
    kernelTrace({
      stage: "graph.resolve.query_features",
      label: "kernel.graphForText",
      durationMs: Date.now() - queryPreparationStarted,
      counts: { features: features.length, topicTerms: topicTerms.length },
      support: { sourceAnchoringRequired, residentOnly }
    });
    const cacheKey = hasher.digestHex(JSON.stringify({
      features,
      topicTerms,
      allowSemanticFrameEvidence,
      sourceAnchoringRequired,
      residentOnly
    })).slice(0, 32);
    const exact = cachedGraphSlice(cacheKey);
    if (exact) return exact;
    if (sourceAnchoringRequired) {
      if (residentOnly) {
        const residentHot = await hotNeighborhoodIfResident();
        if (residentHot) {
          const hotAnchoredEvidence = sourceAnchoredEvidenceFromHot(residentHot, text);
          const hotSlice = hotAnchoredEvidence.length
            ? graphSliceFromHotEvidence(residentHot, hotAnchoredEvidence, features, topicTerms)
            : undefined;
          if (hotSlice && !temporalCounterexampleExpected(text, hotAnchoredEvidence)) return cacheGraphSlice(cacheKey, hotSlice, "hot-neighborhood");
        }
        const semanticSelection = allowSemanticFrameEvidence
          ? await sourceAnchorSemanticFrameEvidence(text, true)
          : { evidence: [], semanticFrameBoundEvidenceIds: [] };
        const certifyingSemanticEvidence = semanticSelection.evidence
          .filter(span => evidenceProofBoundary(span).certifiesFactualProof);
        const semanticIds = new Set(semanticSelection.semanticFrameBoundEvidenceIds
          .filter(id => certifyingSemanticEvidence.some(span => String(span.id) === id)));
        const anchored = sourceAnchoredEvidenceForRequest(text, certifyingSemanticEvidence, semanticIds);
        const evidence = anchored.evidence.slice(0, 24);
        if (evidence.length) {
          const admittedIds = new Set(evidence.map(span => String(span.id)));
          return cacheGraphSlice(cacheKey, emptyRuntimeGraphSlice(
            {
              evidenceIds: evidence.map(span => span.id),
              features: [...features],
              topicTerms,
              radius: 0,
              limitNodes: 0,
              limitEdges: 0
            },
            evidence,
            semanticSelection.semanticFrameBoundEvidenceIds.filter(id => admittedIds.has(id))
          ), "hot-neighborhood");
        }
      }
      const anchoredEvidenceStarted = Date.now();
      const anchoredSelection = await sourceAnchoredEvidenceForText(text, features, allowSemanticFrameEvidence);
      kernelTrace({
        stage: "graph.resolve.anchor_evidence",
        label: "kernel.graphForText",
        durationMs: Date.now() - anchoredEvidenceStarted,
        counts: {
          evidence: anchoredSelection.evidence.length,
          semanticFrameEvidence: anchoredSelection.semanticFrameBoundEvidenceIds.length
        }
      });
      const anchoredEvidence = anchoredSelection.evidence;
      if (!anchoredEvidence.length) {
        return cacheGraphSlice(cacheKey, { graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query: { evidenceIds: [], features: [...features], topicTerms, radius: 0, limitNodes: 0, limitEdges: 0 } }, evidence: [], semanticFrameBoundEvidenceIds: [] }, "postgres");
      }
      const residentGraphHot = await hotNeighborhoodIfResident();
      const residentSlice = residentGraphHot
        ? graphSliceFromHotEvidence(residentGraphHot, anchoredEvidence, features, topicTerms)
        : undefined;
      if (residentSlice) {
        return cacheGraphSlice(cacheKey, {
          ...residentSlice,
          evidence: mergeEvidenceSpans(anchoredEvidence),
          semanticFrameBoundEvidenceIds: anchoredSelection.semanticFrameBoundEvidenceIds
        }, "hot-neighborhood");
      }
      const anchoredGraphStarted = Date.now();
      const graph = await deps.storage.graph.getSlice({
        evidenceIds: anchoredEvidence.map(span => span.id),
        features: [...features],
        topicTerms,
        radius: 1,
        limitNodes: sourceAnchorHotNodeLimit,
        limitEdges: sourceAnchorHotEdgeLimit
      });
      kernelTrace({
        stage: "graph.resolve.anchor_slice",
        label: "kernel.graphForText",
        durationMs: Date.now() - anchoredGraphStarted,
        counts: { nodes: graph.nodes.length, edges: graph.edges.length, hyperedges: graph.hyperedges.length }
      });
      const value: RuntimeGraphSliceValue = {
        graph: {
          ...graph,
          query: { evidenceIds: anchoredEvidence.map(span => span.id), features: [...features], topicTerms, radius: 1, limitNodes: sourceAnchorHotNodeLimit, limitEdges: sourceAnchorHotEdgeLimit }
        },
        evidence: mergeEvidenceSpans(anchoredEvidence),
        semanticFrameBoundEvidenceIds: anchoredSelection.semanticFrameBoundEvidenceIds
      };
      return cacheGraphSlice(cacheKey, value, "postgres");
    }
    if (!requireDurableGraphLookup && !sourceAnchoringRequired) {
      const hot = await hotNeighborhoodCached();
      const hotSlice = hot ? graphSliceFromHotNeighborhood(hot, features, topicTerms) : undefined;
      if (hotSlice) return cacheGraphSlice(cacheKey, hotSlice, "hot-neighborhood");
    }
    if (residentOnly) {
      return cacheGraphSlice(
        cacheKey,
        emptyRuntimeGraphSlice({ evidenceIds: [], features: [...features], topicTerms, radius: 0, limitNodes: 0, limitEdges: 0 }, []),
        "hot-neighborhood"
      );
    }
    const value = await graphForTextUncached(text, features, topicTerms);
    requireDurableGraphLookup = false;
    return cacheGraphSlice(cacheKey, value, "postgres");
  }


  async function graphForEvidenceIds(evidenceIds: readonly string[]): Promise<RuntimeGraphSliceValue> {
    const boundedEvidenceIds = uniqueKernelStrings(evidenceIds).slice(0, 80) as EvidenceSpan["id"][];
    if (!boundedEvidenceIds.length) return {
      graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query: { evidenceIds: [] } },
      evidence: []
    };
    const cacheKey = hasher.digestHex(JSON.stringify({ evidenceIds: boundedEvidenceIds })).slice(0, 32);
    const exact = cachedGraphSlice(cacheKey);
    if (exact) return exact;
    const graph = await deps.storage.graph.getSlice({
      evidenceIds: boundedEvidenceIds,
      radius: 2,
      limitNodes: sourceAnchorHotNodeLimit,
      limitEdges: sourceAnchorHotEdgeLimit
    });
    const graphEvidenceIds = uniqueKernelStrings([
      ...boundedEvidenceIds.map(String),
      ...graph.nodes.flatMap(node => node.evidenceIds.map(String)),
      ...graph.edges.flatMap(edge => edge.evidenceIds.map(String)),
      ...graph.hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
    ]).slice(0, 80);
    const graphEvidence = graphEvidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(graphEvidenceIds as EvidenceSpan["id"][]) : [];
    return cacheGraphSlice(cacheKey, { graph, evidence: graphEvidence }, "postgres");
  }


  async function graphForEvidenceIdsUnrouted(evidenceIds: readonly string[]): Promise<RuntimeGraphSliceValue> {
    const boundedEvidenceIds = uniqueKernelStrings(evidenceIds).slice(0, 80) as EvidenceSpan["id"][];
    if (!boundedEvidenceIds.length) return emptyRuntimeGraphSlice({ evidenceIds: [] }, []);
    const graph = await deps.storage.graph.getSlice({
      evidenceIds: boundedEvidenceIds,
      radius: 2,
      limitNodes: sourceAnchorHotNodeLimit,
      limitEdges: sourceAnchorHotEdgeLimit
    });
    const graphEvidenceIds = uniqueKernelStrings([
      ...boundedEvidenceIds.map(String),
      ...graph.nodes.flatMap(node => node.evidenceIds.map(String)),
      ...graph.edges.flatMap(edge => edge.evidenceIds.map(String)),
      ...graph.hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
    ]).slice(0, 80) as EvidenceSpan["id"][];
    const evidence = graphEvidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(graphEvidenceIds) : [];
    return { graph, evidence };
  }


  async function evidenceOnlyForText(text: string, allowSemanticFrameEvidence = true): Promise<RuntimeGraphSliceValue> {
    const features = graphRetrievalFeatures(text);
    const topicTerms = graphTopicTermsForText(text);
    if (requestNeedsSourceAnchoredEvidence(text)) {
      const selection = await sourceAnchoredEvidenceForText(text, features, allowSemanticFrameEvidence);
      return emptyRuntimeGraphSlice(
        { evidenceIds: selection.evidence.map(span => span.id), features, topicTerms, radius: 0, limitNodes: 0, limitEdges: 0 },
        selection.evidence,
        selection.semanticFrameBoundEvidenceIds
      );
    }
    const evidence = (await deps.storage.evidence.searchEvidence({ features, limit: 40 })).map(item => item.span);
    return emptyRuntimeGraphSlice({ evidenceIds: evidence.map(span => span.id), features, topicTerms, radius: 0, limitNodes: 0, limitEdges: 0 }, evidence);
  }


  async function evidenceOnlyForIds(evidenceIds: readonly string[]): Promise<RuntimeGraphSliceValue> {
    const bounded = uniqueKernelStrings(evidenceIds).slice(0, 80) as EvidenceSpan["id"][];
    const evidence = bounded.length ? await deps.storage.evidence.getEvidenceBatch(bounded) : [];
    return emptyRuntimeGraphSlice({ evidenceIds: bounded, radius: 0, limitNodes: 0, limitEdges: 0 }, evidence);
  }


  function emptyRuntimeGraphSlice(query: GraphSlice["query"], evidence: readonly EvidenceSpan[], semanticFrameBoundEvidenceIds: readonly string[] = []): RuntimeGraphSliceValue {
    return {
      graph: { nodes: [], edges: [], hyperedges: [], bounded: true, query },
      evidence: [...evidence],
      semanticFrameBoundEvidenceIds: [...semanticFrameBoundEvidenceIds]
    };
  }


  async function hotNeighborhoodIfResident(): Promise<HotGraphNeighborhood | undefined> {
    if (hotNeighborhood) return hotNeighborhood;
    return hotNeighborhoodLoad;
  }


  async function sourceAnchoredEvidenceForText(text: string, features: readonly string[], allowSemanticFrameEvidence = true): Promise<SourceAnchoredEvidenceSelection> {
    const anchorFeatures = sourceAnchorRetrievalFeatures(text);
    // Source-bound retrieval should rank on the subject anchors themselves. Mixing
    // the full request feature field into this query makes common prompt fragments
    // match a large share of a hydrated corpus and turns overlap ranking into the
    // dominant turn cost. Fall back to the broader field only when no admissible
    // anchor feature could be derived.
    const retrievalFeatures = uniqueKernelStrings(anchorFeatures.length ? anchorFeatures : features).slice(0, 128);
    const evidenceSearchStarted = Date.now();
    const evidenceSearch = deps.storage.evidence.searchEvidence({ features: retrievalFeatures, limit: anchorFeatures.length ? 96 : 48 })
      .then(results => {
        kernelTrace({
          stage: "graph.resolve.anchor_evidence_search",
          label: "kernel.sourceAnchoredEvidenceForText",
          durationMs: Date.now() - evidenceSearchStarted,
          counts: { results: results.length, features: retrievalFeatures.length },
          support: { retrievalFeatures }
        });
        return results;
      });
    const evidenceResults = await evidenceSearch;
    const semanticFrameEvidence: SourceAnchoredEvidenceSelection = {
      evidence: [],
      semanticFrameBoundEvidenceIds: []
    };
    const promoted = mergeEvidenceSpans(evidenceResults.map(item => item.span))
      .filter(span => (span.status === "promoted" || promotedSessionEvidence(span))
        && evidenceProofBoundary(span).certifiesFactualProof);
    const semanticFrameBoundEvidenceIds = new Set(semanticFrameEvidence.semanticFrameBoundEvidenceIds);
    const anchored = sourceAnchoredEvidenceForRequest(text, promoted, semanticFrameBoundEvidenceIds);
    const evidence = anchored.evidence.slice(0, 24);
    const admittedIds = new Set(evidence.map(span => String(span.id)));
    return {
      evidence,
      semanticFrameBoundEvidenceIds: semanticFrameEvidence.semanticFrameBoundEvidenceIds.filter(id => admittedIds.has(id))
    };
  }


  async function sourceAnchorSemanticFrameEvidence(
    text: string,
    residentOnly = false
  ): Promise<SourceAnchoredEvidenceSelection> {
    const anchors = sourceEvidenceAnchorsForRequest(text);
    if (!anchors.length) return { evidence: [], semanticFrameBoundEvidenceIds: [] };
    const frames = await sourceAnchorSemanticFramesCached().catch(() => []);
    const semanticFrameBoundEvidenceIds = uniqueKernelStrings(frames
      .filter(row => semanticFrameMatchesSourceAnchor(row.surfaceUnits, anchors))
      .flatMap(row => row.frame.evidenceIds.map(String)))
      .slice(0, 64);
    const evidenceIds = semanticFrameBoundEvidenceIds as EvidenceSpan["id"][];
    return {
      evidence: evidenceIds.length ? await sourceAnchorEvidenceBatchCached(evidenceIds, residentOnly) : [],
      semanticFrameBoundEvidenceIds
    };
  }


  function semanticFrameMatchesSourceAnchor(surfaceUnits: readonly string[], anchors: readonly string[]): boolean {
    if (!surfaceUnits.length) return false;
    return anchors.some(anchor => {
      const anchorUnits = splitPriorUnits(anchor).filter(Boolean);
      return anchorUnits.length > 0 && sourceAnchorPhraseContains(surfaceUnits, anchorUnits);
    });
  }


  function sourceAnchorRetrievalFeatures(text: string): string[] {
    const anchors = sourceEvidenceAnchorsForRequest(text);
    const primary = anchors.find(anchor => splitPriorUnits(normalizePriorKey(anchor)).filter(Boolean).length >= 2)
      ?? anchors[0];
    if (!primary) return [];
    const ordered = anchorFeatureSet(primary, 64);
    const phraseFeatures = ordered
      .filter(feature => feature.startsWith("anchor:bi:"))
      .filter(feature => {
        const units = retrievalFeatureUnits(feature.slice("anchor:".length)).filter(unit => !genericQuestionSignal(unit));
        return units.length >= 2 && units.reduce((sum, unit) => sum + [...normalizePriorKey(unit)].length, 0) >= 6;
      });
    if (phraseFeatures.length) return phraseFeatures.slice(0, 4);
    return ordered
      .filter(feature => feature.startsWith("anchor:sym:"))
      .filter(feature => {
        const unit = normalizePriorKey(feature.slice("anchor:sym:".length));
        return !genericQuestionSignal(unit) && [...unit].length >= 3;
      })
      .slice(0, 4);
  }


  async function hotNeighborhoodCached(): Promise<HotGraphNeighborhood | undefined> {
    if (!hotNeighborhoodEnabled || hotNeighborhoodNodeLimit <= 0 || hotNeighborhoodEdgeLimit <= 0) return undefined;
    if (hotNeighborhood) return hotNeighborhood;
    if (hotNeighborhoodLoad) return hotNeighborhoodLoad;
    const epoch = runtimeCacheEpoch;
    const pending = loadHotNeighborhood(epoch);
    hotNeighborhoodLoad = pending;
    return pending.finally(() => {
      if (hotNeighborhoodLoad === pending) hotNeighborhoodLoad = undefined;
    });
  }


  async function loadHotNeighborhood(epoch: number): Promise<HotGraphNeighborhood | undefined> {
    try {
      const graph = await deps.storage.graph.getSlice({
        limitNodes: hotNeighborhoodNodeLimit,
        limitEdges: hotNeighborhoodEdgeLimit,
        allowLatestFallback: true
      });
      if (epoch !== runtimeCacheEpoch || !graph.nodes.length) return undefined;
      const graphEvidenceIds = uniqueKernelStrings([
        ...graph.nodes.flatMap(node => node.evidenceIds.map(String)),
        ...graph.edges.flatMap(edge => edge.evidenceIds.map(String)),
        ...graph.hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
      ]).slice(0, hotNeighborhoodEvidenceLimit);
      const evidence = graphEvidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(graphEvidenceIds as EvidenceSpan["id"][]) : [];
      if (epoch !== runtimeCacheEpoch) return undefined;
      const value = fitRuntimeGraphSliceToBudget({ graph, evidence }, Math.max(16 * 1024 * 1024, Math.floor(graphSliceCacheMaxBytes * 0.8)));
      const hot = buildHotNeighborhood(value);
      hotNeighborhood = hot;
      kernelTrace({
        stage: "graph.resolve",
        label: "kernel.hot_neighborhood",
        counts: {
          nodes: hot.value.graph.nodes.length,
          edges: hot.value.graph.edges.length,
          evidence: hot.value.evidence.length,
          bytes: hot.bytes,
          cacheBytes: graphSliceCacheBytes
        }
      });
      return hot;
    } catch (error) {
      failures.push(`hot neighborhood load failed: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }


  function buildHotNeighborhood(value: RuntimeGraphSliceValue): HotGraphNeighborhood {
    const nodeById = new Map<string, GraphNode>();
    const edgeById = new Map<string, GraphEdge>();
    const hyperedgeById = new Map<string, GraphSlice["hyperedges"][number]>();
    const edgeByNodeId = new Map<string, GraphEdge[]>();
    const hyperedgeByNodeId = new Map<string, GraphSlice["hyperedges"][number][]>();
    const featureNodeIds = new Map<string, Set<string>>();
    const evidenceById = new Map<string, EvidenceSpan>();
    const evidenceNodeIds = new Map<string, Set<string>>();
    const evidenceEdgeIds = new Map<string, Set<string>>();
    const evidenceHyperedgeIds = new Map<string, Set<string>>();
    const sourceAnchorEvidenceIds = new Map<string, Set<string>>();
    for (const span of value.evidence) {
      const evidenceId = String(span.id);
      evidenceById.set(evidenceId, span);
      const anchorFeatures = uniqueKernelStrings([
        ...span.features.filter(feature => feature.startsWith("anchor:")),
        ...anchorFeatureSet((span.textPreview || span.text).slice(0, 4000), 256)
      ]);
      for (const feature of anchorFeatures) {
        if (feature.startsWith("anchor:bi:") || feature.startsWith("anchor:sym:")) {
          addHotIndexValue(sourceAnchorEvidenceIds, feature, evidenceId, 256);
        }
      }
    }
    for (const node of value.graph.nodes) {
      const nodeId = String(node.id);
      nodeById.set(nodeId, node);
      for (const evidenceId of node.evidenceIds.map(String)) addHotIndexValue(evidenceNodeIds, evidenceId, nodeId, 1024);
      for (const feature of node.features.slice(0, 160)) {
        if (!isHighInformationRetrievalFeature(feature)) continue;
        addHotIndexValue(featureNodeIds, feature, nodeId, hotNeighborhoodPostingCap);
      }
    }
    for (const edge of value.graph.edges) {
      const edgeId = String(edge.id);
      edgeById.set(edgeId, edge);
      const source = String(edge.source);
      const target = String(edge.target);
      for (const evidenceId of edge.evidenceIds.map(String)) addHotIndexValue(evidenceEdgeIds, evidenceId, edgeId, 1024);
      const sourceEdges = edgeByNodeId.get(source) ?? [];
      sourceEdges.push(edge);
      edgeByNodeId.set(source, sourceEdges);
      const targetEdges = edgeByNodeId.get(target) ?? [];
      targetEdges.push(edge);
      edgeByNodeId.set(target, targetEdges);
    }
    for (const hyperedge of value.graph.hyperedges) {
      const hyperedgeId = String(hyperedge.id);
      hyperedgeById.set(hyperedgeId, hyperedge);
      for (const evidenceId of hyperedge.provenanceRefs.map(String)) addHotIndexValue(evidenceHyperedgeIds, evidenceId, hyperedgeId, 1024);
      for (const nodeId of hyperedge.memberNodeIds.map(String)) {
        const rows = hyperedgeByNodeId.get(nodeId) ?? [];
        rows.push(hyperedge);
        hyperedgeByNodeId.set(nodeId, rows);
      }
    }
    return {
      key: hasher.digestHex(JSON.stringify({
        nodes: value.graph.nodes.slice(0, 12).map(node => String(node.id)),
        edges: value.graph.edges.slice(0, 12).map(edge => String(edge.id)),
        evidence: value.evidence.slice(0, 12).map(span => String(span.id))
      })).slice(0, 32),
      loadedAt: clock.now(),
      bytes: estimateRuntimeGraphSliceBytes(value),
      value,
      nodeById,
      edgeById,
      hyperedgeById,
      edgeByNodeId,
      hyperedgeByNodeId,
      featureNodeIds,
      evidenceById,
      evidenceNodeIds,
      evidenceEdgeIds,
      evidenceHyperedgeIds,
      sourceAnchorEvidenceIds
    };
  }


  function addHotIndexValue(map: Map<string, Set<string>>, key: string, value: string, cap: number): void {
    if (!key || !value) return;
    const postings = map.get(key) ?? new Set<string>();
    if (postings.size < cap) postings.add(value);
    map.set(key, postings);
  }


  function sourceAnchoredEvidenceFromHot(hot: HotGraphNeighborhood, text: string): EvidenceSpan[] {
    const anchorFeatures = sourceAnchorRetrievalFeatures(text);
    if (!anchorFeatures.length) return [];
    const evidenceIds = new Set<string>();
    for (const feature of anchorFeatures) {
      for (const evidenceId of hot.sourceAnchorEvidenceIds.get(feature) ?? []) evidenceIds.add(evidenceId);
    }
    const indexedEvidence = [...evidenceIds]
      .map(id => hot.evidenceById.get(id))
      .filter((span): span is EvidenceSpan => Boolean(span));
    const candidates = indexedEvidence
      .filter(span => evidenceProofBoundary(span).certifiesFactualProof);
    const indexedAnchored = candidates.length
      ? sourceAnchoredEvidenceForRequest(text, candidates)
      : { evidence: [] };
    if (indexedAnchored.evidence.length) return evidenceForRequest(text, indexedAnchored.evidence).slice(0, 24);
    return [];
  }


  function graphSliceFromHotEvidence(hot: HotGraphNeighborhood, anchoredEvidence: readonly EvidenceSpan[], features: string[], topicTerms: string[]): RuntimeGraphSliceValue | undefined {
    const queryFeatures = uniqueKernelStrings([
      ...features,
      ...topicTerms.flatMap(term => orderedRetrievalFeatures(term))
    ]).slice(0, 512);
    const nodeLimit = sourceAnchorHotNodeLimit;
    const edgeLimit = sourceAnchorHotEdgeLimit;
    const evidenceSeedIds = new Set(anchoredEvidence.map(span => String(span.id)));
    const selectedNodeIds = new Set<string>();
    const edgeRows = new Map<string, { edge: GraphEdge; score: number }>();
    const hyperedgeRows = new Map<string, GraphSlice["hyperedges"][number]>();
    const addEdge = (edge: GraphEdge, score: number) => {
      const edgeId = String(edge.id);
      const previous = edgeRows.get(edgeId);
      if (!previous || score > previous.score) edgeRows.set(edgeId, { edge, score });
      if (selectedNodeIds.size < nodeLimit && hot.nodeById.has(String(edge.source))) selectedNodeIds.add(String(edge.source));
      if (selectedNodeIds.size < nodeLimit && hot.nodeById.has(String(edge.target))) selectedNodeIds.add(String(edge.target));
    };

    for (const evidenceId of evidenceSeedIds) {
      for (const nodeId of hot.evidenceNodeIds.get(evidenceId) ?? []) {
        if (selectedNodeIds.size < nodeLimit) selectedNodeIds.add(nodeId);
      }
      for (const edgeId of hot.evidenceEdgeIds.get(evidenceId) ?? []) {
        const edge = hot.edgeById.get(edgeId);
        if (edge) addEdge(edge, 1 + edge.alpha + edge.weight);
      }
      for (const hyperedgeId of hot.evidenceHyperedgeIds.get(evidenceId) ?? []) {
        const hyperedge = hot.hyperedgeById.get(hyperedgeId);
        if (!hyperedge) continue;
        hyperedgeRows.set(hyperedgeId, hyperedge);
        for (const nodeId of hyperedge.memberNodeIds.map(String)) {
          if (selectedNodeIds.size < nodeLimit && hot.nodeById.has(nodeId)) selectedNodeIds.add(nodeId);
        }
      }
    }

    for (const nodeId of [...selectedNodeIds]) {
      for (const edge of hot.edgeByNodeId.get(nodeId) ?? []) {
        const source = String(edge.source);
        const target = String(edge.target);
        const touchesSelected = selectedNodeIds.has(source) || selectedNodeIds.has(target);
        if (!touchesSelected) continue;
        addEdge(edge, edge.alpha * 0.58 + edge.weight * 0.32 + (selectedNodeIds.has(source) && selectedNodeIds.has(target) ? 0.1 : 0));
      }
      for (const hyperedge of hot.hyperedgeByNodeId.get(nodeId) ?? []) hyperedgeRows.set(String(hyperedge.id), hyperedge);
    }

    const nodes = [...selectedNodeIds]
      .map(nodeId => hot.nodeById.get(nodeId))
      .filter((node): node is GraphNode => Boolean(node))
      .sort((left, right) => right.alpha - left.alpha || String(left.id).localeCompare(String(right.id)))
      .slice(0, nodeLimit);
    if (!nodes.length) return undefined;
    const nodeIds = new Set(nodes.map(node => String(node.id)));
    const edges = [...edgeRows.values()]
      .filter(row => nodeIds.has(String(row.edge.source)) || nodeIds.has(String(row.edge.target)))
      .sort((left, right) => right.score - left.score || String(left.edge.id).localeCompare(String(right.edge.id)))
      .slice(0, edgeLimit)
      .map(row => row.edge);
    const hyperedges = [...hyperedgeRows.values()]
      .filter(edge => edge.memberNodeIds.some(nodeId => nodeIds.has(String(nodeId))))
      .slice(0, Math.max(64, Math.floor(edgeLimit / 4)));
    return {
      graph: {
        nodes,
        edges,
        hyperedges,
        bounded: true,
        query: { evidenceIds: anchoredEvidence.map(span => span.id), features: queryFeatures, topicTerms, radius: 2, limitNodes: nodeLimit, limitEdges: edgeLimit }
      },
      evidence: mergeEvidenceSpans([...anchoredEvidence])
    };
  }
  function graphSliceFromHotNeighborhood(hot: HotGraphNeighborhood, features: string[], topicTerms: string[]): RuntimeGraphSliceValue | undefined {
    const queryFeatures = uniqueKernelStrings([
      ...features,
      ...topicTerms.flatMap(term => orderedRetrievalFeatures(term))
    ]).slice(0, 512);
    const ranked = rankHotNeighborhoodNodes(hot, queryFeatures);
    if (!ranked.length || ranked[0]!.score < 0.04) return undefined;
    const nodeLimit = Math.min(HOT_QUERY_NODE_LIMIT, hot.nodeById.size);
    const edgeLimit = Math.min(HOT_QUERY_EDGE_LIMIT, hot.edgeById.size);
    const selectedNodeIds = new Set<string>();
    const nodeScores = new Map<string, number>();
    const edgeRows = new Map<string, { edge: GraphEdge; score: number }>();
    const hyperedgeRows = new Map<string, {
      hyperedge: GraphSlice["hyperedges"][number];
      score: number;
    }>();
    const recordTransition = (
      transition: ReturnType<typeof hotNeighborhoodTransitions>[number],
      routeScore: number
    ) => {
      if (transition.edge) {
        const edgeId = String(transition.edge.id);
        const previous = edgeRows.get(edgeId);
        if ((!previous || routeScore > previous.score) && edgeRows.size < edgeLimit) {
          edgeRows.set(edgeId, { edge: transition.edge, score: routeScore });
        }
      }
      if (transition.hyperedge) {
        const hyperedgeId = String(transition.hyperedge.id);
        const previous = hyperedgeRows.get(hyperedgeId);
        if ((!previous || routeScore > previous.score)
          && hyperedgeRows.size < HOT_QUERY_HYPEREDGE_LIMIT) {
          hyperedgeRows.set(hyperedgeId, {
            hyperedge: transition.hyperedge,
            score: routeScore
          });
        }
      }
    };
    let frontier = ranked
      .slice(0, Math.min(HOT_QUERY_SEED_LIMIT, nodeLimit))
      .map(row => ({ nodeId: row.nodeId, score: row.score }));
    for (const row of frontier) {
      selectedNodeIds.add(row.nodeId);
      nodeScores.set(row.nodeId, row.score);
    }
    for (let depth = 1; depth <= HOT_QUERY_RADIUS && frontier.length; depth++) {
      const candidatesByNodeId = new Map<string, {
        nodeId: string;
        score: number;
        transition: ReturnType<typeof hotNeighborhoodTransitions>[number];
      }>();
      for (const row of frontier
        .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId))) {
        for (const transition of hotNeighborhoodTransitions(hot, row.nodeId)) {
          const targetNode = hot.nodeById.get(transition.targetNodeId);
          if (!targetNode) continue;
          const routeScore = row.score * transition.potential / (depth + 1);
          if (selectedNodeIds.has(transition.targetNodeId)) {
            recordTransition(transition, routeScore);
            continue;
          }
          const previous = candidatesByNodeId.get(transition.targetNodeId);
          if (!previous || routeScore > previous.score) {
            candidatesByNodeId.set(transition.targetNodeId, {
              nodeId: transition.targetNodeId,
              score: routeScore,
              transition
            });
          }
        }
      }
      const remainingNodeCapacity = Math.max(0, nodeLimit - selectedNodeIds.size);
      const remainingDepths = HOT_QUERY_RADIUS - depth + 1;
      const depthNodeLimit = depth < HOT_QUERY_RADIUS
        ? Math.floor(remainingNodeCapacity / remainingDepths)
        : remainingNodeCapacity;
      const selectedAtDepth = [...candidatesByNodeId.values()]
        .sort((left, right) =>
          right.score - left.score
          || left.nodeId.localeCompare(right.nodeId))
        .slice(0, depthNodeLimit);
      for (const row of selectedAtDepth) {
        selectedNodeIds.add(row.nodeId);
        nodeScores.set(row.nodeId, row.score);
        recordTransition(row.transition, row.score);
      }
      frontier = selectedAtDepth.map(row => ({ nodeId: row.nodeId, score: row.score }));
    }
    const nodes = [...selectedNodeIds]
      .map(nodeId => hot.nodeById.get(nodeId))
      .filter((node): node is GraphNode => Boolean(node))
      .sort((left, right) =>
        (nodeScores.get(String(right.id)) ?? 0) - (nodeScores.get(String(left.id)) ?? 0)
        || right.alpha - left.alpha
        || String(left.id).localeCompare(String(right.id)))
      .slice(0, nodeLimit);
    if (!nodes.length) return undefined;
    const nodeIds = new Set(nodes.map(node => String(node.id)));
    const edges = [...edgeRows.values()]
      .filter(row => nodeIds.has(String(row.edge.source)) && nodeIds.has(String(row.edge.target)))
      .sort((left, right) => right.score - left.score || String(left.edge.id).localeCompare(String(right.edge.id)))
      .slice(0, edgeLimit)
      .map(row => row.edge);
    const hyperedges = [...hyperedgeRows.values()]
      .filter(row => row.hyperedge.memberNodeIds
        .filter(memberNodeId => nodeIds.has(String(memberNodeId))).length >= 2)
      .sort((left, right) =>
        right.score - left.score
        || String(left.hyperedge.id).localeCompare(String(right.hyperedge.id)))
      .slice(0, HOT_QUERY_HYPEREDGE_LIMIT)
      .map(row => row.hyperedge);
    return {
      graph: {
        nodes,
        edges,
        hyperedges,
        bounded: true,
        query: {
          features: queryFeatures,
          topicTerms,
          radius: HOT_QUERY_RADIUS,
          limitNodes: nodeLimit,
          limitEdges: edgeLimit
        }
      },
      // An unanchored resident walk contributes graph priors only. Evidence
      // remains exclusive to the source-anchored retrieval path above.
      evidence: []
    };
  }

  function hotNeighborhoodTransitions(
    hot: HotGraphNeighborhood,
    nodeId: string
  ): Array<{
    targetNodeId: string;
    potential: number;
    edge?: GraphEdge;
    hyperedge?: GraphSlice["hyperedges"][number];
  }> {
    const edgeTransitions = (hot.edgeByNodeId.get(nodeId) ?? [])
      .flatMap(edge => {
        const source = String(edge.source);
        const target = String(edge.target);
        const targetNodeId = source === nodeId ? target : target === nodeId ? source : "";
        const potential = hotEdgeTransitionPotential(edge);
        return targetNodeId && targetNodeId !== nodeId && hot.nodeById.has(targetNodeId) && potential > 0
          ? [{ targetNodeId, potential, edge }]
          : [];
      })
      .sort((left, right) =>
        right.potential - left.potential
        || String(left.edge.id).localeCompare(String(right.edge.id))
        || left.targetNodeId.localeCompare(right.targetNodeId))
      .slice(0, HOT_QUERY_EDGE_BRANCH_LIMIT);
    const hyperedgeTransitions = (hot.hyperedgeByNodeId.get(nodeId) ?? [])
      .flatMap(hyperedge => {
        const potential = hotHyperedgeTransitionPotential(hyperedge);
        if (potential <= 0) return [];
        return hyperedge.memberNodeIds
          .map(String)
          .filter(targetNodeId => targetNodeId !== nodeId && hot.nodeById.has(targetNodeId))
          .map(targetNodeId => ({ targetNodeId, potential, hyperedge }));
      })
      .sort((left, right) =>
        right.potential - left.potential
        || String(left.hyperedge.id).localeCompare(String(right.hyperedge.id))
        || left.targetNodeId.localeCompare(right.targetNodeId)
      )
      .slice(0, HOT_QUERY_HYPEREDGE_BRANCH_LIMIT);
    return [...edgeTransitions, ...hyperedgeTransitions]
      .sort((left, right) => {
        const leftId = "edge" in left
          ? String(left.edge.id)
          : String(left.hyperedge.id);
        const rightId = "edge" in right
          ? String(right.edge.id)
          : String(right.hyperedge.id);
        return right.potential - left.potential
          || leftId.localeCompare(rightId)
          || left.targetNodeId.localeCompare(right.targetNodeId);
      });
  }

  function hotEdgeTransitionPotential(edge: GraphEdge): number {
    const relationPotential = jsonRecord(jsonRecord(edge.metadata).relationPotential);
    const calibrated = relationPotential.calibrated;
    if (typeof calibrated === "number" && Number.isFinite(calibrated)) return clamp01(calibrated);
    return clamp01(Math.sqrt(clamp01(edge.alpha) * clamp01(edge.weight)));
  }

  function hotHyperedgeTransitionPotential(
    hyperedge: GraphSlice["hyperedges"][number]
  ): number {
    const weights = jsonRecord(hyperedge.weightVector);
    const calibrated = weights.calibrated;
    if (typeof calibrated === "number" && Number.isFinite(calibrated)) return clamp01(calibrated);
    const alpha = weights.alpha;
    return typeof alpha === "number" && Number.isFinite(alpha) ? clamp01(alpha) : 0;
  }


  function rankHotNeighborhoodNodes(hot: HotGraphNeighborhood, features: readonly string[]): Array<{ nodeId: string; score: number }> {
    const scores = new Map<string, number>();
    features.slice(0, 256).forEach((feature, index) => {
      const postings = hot.featureNodeIds.get(feature);
      if (!postings) return;
      const weight = 1 / Math.max(1, Math.sqrt(index + 1));
      for (const nodeId of postings) scores.set(nodeId, (scores.get(nodeId) ?? 0) + weight);
    });
    return [...scores.entries()]
      .map(([nodeId, overlap]) => {
        const node = hot.nodeById.get(nodeId);
        return node ? { nodeId, score: overlap + node.alpha * 0.2 } : undefined;
      })
      .filter((row): row is { nodeId: string; score: number } => Boolean(row))
      .sort((left, right) => right.score - left.score || left.nodeId.localeCompare(right.nodeId));
  }


  async function graphForTextUncached(text: string, features = graphRetrievalFeatures(text), topicTerms = graphTopicTermsForText(text)): Promise<RuntimeGraphSliceValue> {
    const evidenceResults = await deps.storage.evidence.searchEvidence({ features, limit: 40 });
    const evidenceIds = evidenceResults.map(item => item.span.id);
    const graph = await deps.storage.graph.getSlice({ evidenceIds, features, topicTerms, radius: 2, limitNodes: 420, limitEdges: 900 });
    const graphEvidenceIds = uniqueKernelStrings([
      ...evidenceIds.map(String),
      ...graph.nodes.flatMap(node => node.evidenceIds.map(String)),
      ...graph.edges.flatMap(edge => edge.evidenceIds.map(String)),
      ...graph.hyperedges.flatMap(edge => edge.provenanceRefs.map(String))
    ]).slice(0, 80);
    const graphEvidence = graphEvidenceIds.length ? await deps.storage.evidence.getEvidenceBatch(graphEvidenceIds as EvidenceSpan["id"][]) : [];
    return { graph, evidence: mergeEvidenceSpans([...evidenceResults.map(item => item.span), ...graphEvidence]) };
  }


  function retrievalTextForTurn(input: OwnerInput): string {
    return input.text;
  }


  async function evidenceFromTurnMetadata(metadata: JsonValue | undefined): Promise<EvidenceSpan[]> {
    const ids = runtimeEvidenceIdsFromMetadata(metadata);
    if (!ids.length) return [];
    const spans = await deps.storage.evidence.getEvidenceBatch(ids as EvidenceSpan["id"][]);
    return spans.filter(span => span.status === "promoted");
  }


  function runtimeEvidenceIdsFromMetadata(metadata: JsonValue | undefined): string[] {
    const record = jsonRecord(metadata);
    const webLearning = jsonRecord(record.webLearning);
    return uniqueKernelStrings([
      ...kernelStringArray(record.runtimeEvidenceIds),
      ...kernelStringArray(record.evidenceIds),
      ...kernelStringArray(webLearning.promotedEvidenceIds)
    ]).slice(0, 80);
  }


  function sessionEvidenceFromMetadata(metadata: JsonValue | undefined): EvidenceSpan[] {
    const session = jsonRecord(jsonRecord(metadata).session);
    const discourseObject = discourseObjectStateFromMetadata(metadata);
    const sessionId = kernelString(session.sessionId);
    const recentTurns = Array.isArray(session.recentTurns) ? session.recentTurns : [];
    if (!sessionId || !recentTurns.length) return [];
    const sessionHash = hasher.digestHex(sessionId).slice(0, 24);
    const sourceId = `source_session_${sessionHash}` as EvidenceSpan["sourceId"];
    const sourceVersionId = `source_version_session_${sessionHash}` as EvidenceSpan["sourceVersionId"];
    return recentTurns
      .map((value, index): EvidenceSpan | undefined => {
        const record = jsonRecord(value as JsonValue);
        const text = (kernelString(record.text) ?? "").trim();
        if (!text) return undefined;
        const roleId = kernelString(record.roleId) || "session.role.unknown";
        const ownerTurn = roleId === "session.role.owner";
        const ownerObservation = ownerTurn && sessionOwnerObservationSurface(text, record);
        const turnId = kernelString(record.id) || `${sessionId}:${index}`;
        const discourseBoundTurn = discourseObject?.mentionIds.includes(turnId) === true;
        const discourseFeature = discourseBoundTurn ? `disc:${discourseObject.objectId.replace(/^.*_([0-9a-f]+)$/u, "$1")}` : undefined;
        const episodeId = kernelString(record.episodeId);
        const createdAt = kernelNumber(record.createdAt) ?? clock.now();
        const spanHash = hasher.digestHex(`${sessionId}\n${turnId}\n${roleId}\n${text}`);
        return {
          id: `evidence_session_${spanHash.slice(0, 48)}` as EvidenceSpan["id"],
          sourceId,
          sourceVersionId,
          chunkId: `chunk_session_${spanHash.slice(0, 48)}` as EvidenceSpan["chunkId"],
          contentHash: `sha256_${spanHash}` as EvidenceSpan["contentHash"],
          mediaType: "application/scce-session-turn+json",
          byteStart: 0,
          byteEnd: text.length,
          charStart: 0,
          charEnd: [...text].length,
          text,
          textPreview: text.replace(/\s+/g, " ").slice(0, 700),
          languageHints: {},
          scriptHints: {},
          trustVector: toJsonValue({
            trust: ownerObservation ? 0.96 : ownerTurn ? 0.52 : 0.62,
            sourceTrust: ownerObservation ? 0.96 : ownerTurn ? 0.52 : 0.62,
            forceClass: ownerObservation
              ? "session_owner_turn_evidence"
              : ownerTurn
                ? "session_owner_query_context"
                : "session_assistant_turn_context"
          }),
          provenance: toJsonValue({ sourceSystem: "conversation-session", sessionId, turnId, roleId, episodeId, createdAt, discourseObjectId: discourseBoundTurn ? discourseObject?.objectId : null }),
          features: [...new Set([...featureSet(text, 512), `session:${sessionHash}`, `role:${roleId}`, ...(discourseFeature ? [discourseFeature] : [])])].slice(0, 560),
          status: ownerObservation ? "promoted" : "quarantined",
          alpha: ownerObservation ? 0.88 : ownerTurn ? 0.36 : 0.48,
          observedAt: createdAt
        };
      })
      .filter((span): span is EvidenceSpan => Boolean(span));
  }


  function currentOwnerSessionEvidence(input: OwnerInput): EvidenceSpan[] {
    const session = jsonRecord(jsonRecord(input.metadata).session);
    const sessionId = kernelString(session.sessionId);
    if (!sessionId || !sessionOwnerObservationSurface(input.text, input.metadata)) return [];
    return sessionEvidenceRecords({
      sessionId,
      turns: [{
        id: `current:${hasher.digestHex(input.text).slice(0, 24)}`,
        roleId: "session.role.owner",
        text: input.text,
        createdAt: clock.now()
      }]
    });
  }


  function sessionEvidenceRecords(input: { sessionId: string; turns: Array<{ id: string; roleId: string; text: string; episodeId?: string; createdAt: number }> }): EvidenceSpan[] {
    const sessionHash = hasher.digestHex(input.sessionId).slice(0, 24);
    const sourceId = `source_session_${sessionHash}` as EvidenceSpan["sourceId"];
    const sourceVersionId = `source_version_session_${sessionHash}` as EvidenceSpan["sourceVersionId"];
    return input.turns
      .map((turn): EvidenceSpan | undefined => {
        const text = turn.text.trim();
        if (!text) return undefined;
        const roleId = turn.roleId || "session.role.unknown";
        const ownerTurn = roleId === "session.role.owner";
        const spanHash = hasher.digestHex(`${input.sessionId}\n${turn.id}\n${roleId}\n${text}`);
        return {
          id: `evidence_session_${spanHash.slice(0, 48)}` as EvidenceSpan["id"],
          sourceId,
          sourceVersionId,
          chunkId: `chunk_session_${spanHash.slice(0, 48)}` as EvidenceSpan["chunkId"],
          contentHash: `sha256_${spanHash}` as EvidenceSpan["contentHash"],
          mediaType: "application/scce-session-turn+json",
          byteStart: 0,
          byteEnd: text.length,
          charStart: 0,
          charEnd: [...text].length,
          text,
          textPreview: text.replace(/\s+/g, " ").slice(0, 700),
          languageHints: toJsonValue({}),
          scriptHints: toJsonValue({}),
          trustVector: toJsonValue({ trust: ownerTurn ? 0.96 : 0.62, sourceTrust: ownerTurn ? 0.96 : 0.62, forceClass: ownerTurn ? "session_owner_turn_evidence" : "session_assistant_turn_context" }),
          provenance: toJsonValue({ sourceSystem: "conversation-session", sessionId: input.sessionId, turnId: turn.id, roleId, episodeId: turn.episodeId ?? null, createdAt: turn.createdAt }),
          features: [...new Set([...featureSet(text, 512), `session:${sessionHash}`, `role:${roleId}`])].slice(0, 560),
          status: ownerTurn ? "promoted" as const : "quarantined" as const,
          alpha: ownerTurn ? 0.88 : 0.48,
          observedAt: turn.createdAt
        };
      })
      .filter((span): span is EvidenceSpan => Boolean(span));
  }


  function mergeEvidenceSpans(spans: EvidenceSpan[]): EvidenceSpan[] {
    const byId = new Map<string, EvidenceSpan>();
    for (const span of spans) if (!byId.has(String(span.id))) byId.set(String(span.id), span);
    return [...byId.values()];
  }
  function graphRetrievalFeatures(text: string): string[] {
    const features = new Map<string, true>();
    const add = (feature: string) => {
      if (isHighInformationRetrievalFeature(feature)) features.set(feature, true);
    };
    for (const term of graphTopicTermsForText(text)) {
      for (const feature of orderedRetrievalFeatures(term)) add(feature);
    }
    for (const anchor of namedSubjectAnchors(text).slice(0, 6)) {
      for (const feature of orderedRetrievalFeatures(anchor)) add(feature);
    }
    for (const anchor of sourceEvidenceAnchorsForRequest(text).slice(0, 16)) {
      for (const feature of orderedRetrievalFeatures(anchor)) features.set(feature, true);
    }
    for (const feature of featureSet(requestContentSurface(text), 256)) add(feature);
    return [...features.keys()].slice(0, 256);
  }


  function isHighInformationRetrievalFeature(feature: string): boolean {
    if (feature.startsWith("tri:")) return retrievalFeatureUnits(feature).filter(highInformationUnit).length >= 2;
    if (feature.startsWith("bi:")) return retrievalFeatureUnits(feature).every(highInformationUnit);
    if (feature.startsWith("sym:")) return highInformationUnit(feature.slice(4));
    return false;
  }


  function orderedRetrievalFeatures(surface: string): string[] {
    const units = splitPriorUnits(normalizePriorKey(surface)).filter(Boolean);
    const out: string[] = [];
    for (const unit of units) out.push(`sym:${unit}`);
    for (let index = 0; index < units.length - 1; index++) out.push(`bi:${units[index]}|${units[index + 1]}`);
    for (let index = 0; index < units.length - 2; index++) out.push(`tri:${units[index]}|${units[index + 1]}|${units[index + 2]}`);
    return out;
  }


  function retrievalFeatureUnits(feature: string): string[] {
    const index = feature.indexOf(":");
    const body = index >= 0 ? feature.slice(index + 1) : feature;
    return body.split("|").filter(Boolean);
  }


  function highInformationUnit(unit: string): boolean {
    const normalized = normalizePriorKey(unit);
    if (normalized.length < 4) return false;
    if (genericQuestionSignal(normalized)) return false;
    return true;
  }


  function graphTopicTermsForText(text: string): string[] {
    const focuses = relevanceRequestFocuses(text).slice(0, 10);
    const phrases: string[] = [];
    for (let index = 0; index < focuses.length - 1; index++) {
      const left = focuses[index] ?? "";
      const right = focuses[index + 1] ?? "";
      if (left.length >= 3 && right.length >= 3) phrases.push(`${left} ${right}`);
    }
    for (let index = 0; index < focuses.length - 2; index++) {
      const left = focuses[index] ?? "";
      const middle = focuses[index + 1] ?? "";
      const right = focuses[index + 2] ?? "";
      if (left.length >= 3 && middle.length >= 3 && right.length >= 3) phrases.push(`${left} ${middle} ${right}`);
    }
    return uniqueKernelStrings([...phrases, ...focuses]).slice(0, 16);
  }

  return {
    sourceAnchorEvidenceCacheMaxEntries,
    hotNeighborhoodCached,
    sourceAnchorEvidenceBatchCached,
    graphForText,
    graphForEvidenceIds,
    graphForEvidenceIdsUnrouted,
    graphForTextUncached,
    evidenceOnlyForText,
    evidenceOnlyForIds,
    retrievalTextForTurn,
    evidenceFromTurnMetadata,
    runtimeEvidenceIdsFromMetadata,
    sessionEvidenceFromMetadata,
    currentOwnerSessionEvidence,
    mergeEvidenceSpans,
    graphRetrievalFeatures,
    invalidate() {
      runtimeCacheEpoch++;
      requireDurableGraphLookup = true;
      graphSliceCache.clear();
      graphSliceCacheBytes = 0;
      hotNeighborhood = undefined;
      hotNeighborhoodLoad = undefined;
      sourceAnchorEvidenceCache.clear();
    }
  };
}
