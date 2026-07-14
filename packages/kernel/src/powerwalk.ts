import type { GraphEdge, GraphNode, Hasher, JsonValue, NodeId } from "./types.js";
import { canonicalStringify, clamp01, cosineSimilarity, mean, normalizeVector, toJsonValue, variance } from "./primitives.js";
import { jacobiEigenvaluesSymmetric, zeros } from "./math.js";
import {
  fitSparsePpmiRepresentation,
  splitCooccurrenceForValidation,
  type SparseCooccurrenceState,
  type SparsePpmiDiagnostics
} from "./powerwalk-ppmi.js";

export {
  fitSparsePpmiRepresentation,
  mergeSparseCooccurrenceState,
  splitCooccurrenceForValidation,
  POWERWALK_COOCCURRENCE_VERSION,
  POWERWALK_PARTITION_SCHEMA,
  POWERWALK_REPRESENTATION_VERSION
} from "./powerwalk-ppmi.js";
export type {
  PowerWalkPartitionIdentity,
  PowerWalkCooccurrenceRow,
  SparseCooccurrenceCount,
  SparseCooccurrenceState,
  SparsePpmiDiagnostics,
  SparsePpmiFit,
  SparsePpmiOptions
} from "./powerwalk-ppmi.js";

export interface PowerWalkParams {
  p: Map<string, number>;
  q: Map<string, number>;
  lambda: Map<string, number>;
  epsilon: number;
  audit?: JsonValue;
}

export const POWERWALK_TRANSITION_OBSERVATION_SCHEMA = "scce.powerwalk_transition_observation.v1" as const;

/**
 * One candidate that was available at an observed second-order transition.
 * IDs and type IDs are opaque graph identities; no language label participates
 * in the fit.
 */
export interface PowerWalkTransitionCandidateObservation {
  edgeId: string;
  targetNodeId: NodeId;
  targetTypeId: string;
  distance: 0 | 1 | 2;
  edgeWeight: number;
  edgeAlpha: number;
  edgeUpdatedAt: number;
}

/**
 * Transition evidence supplied directly or mapped from an actually executed
 * transition audit. Fitting never manufactures selected choices.
 */
export interface PowerWalkTransitionObservation {
  schema: typeof POWERWALK_TRANSITION_OBSERVATION_SCHEMA;
  origin?: "supplied_typed_observation" | "executed_transition_audit";
  id: string;
  sourceRecordId: string;
  observedAt: number;
  previousNodeId?: NodeId;
  previousTypeId?: string;
  currentNodeId: NodeId;
  currentTypeId: string;
  selectedEdgeId: string;
  candidates: readonly PowerWalkTransitionCandidateObservation[];
}

export interface PowerWalkParameterFitOptions {
  seed?: string;
  holdoutFraction?: number;
  minimumFitObservations?: number;
  minimumHoldoutObservations?: number;
  maximumSweeps?: number;
  minimumHeldOutMeanNllImprovement?: number;
}

export interface PowerWalkTransitionDistribution {
  observationId: string;
  selectedEdgeId: string;
  selectedProbability: number;
  logLikelihood: number;
  negativeLogLikelihood: number;
  candidates: Array<{
    edgeId: string;
    probability: number;
    logWeight: number | null;
    selected: boolean;
  }>;
}

export interface PowerWalkLikelihoodSummary {
  observationCount: number;
  informativeObservationCount: number;
  totalLogLikelihood: number;
  totalNegativeLogLikelihood: number;
  meanNegativeLogLikelihood: number;
  observations: Array<{
    observationId: string;
    sourceRecordId: string;
    selectedEdgeId: string;
    selectedProbability: number;
    logLikelihood: number;
    negativeLogLikelihood: number;
    candidates: Array<{
      edgeId: string;
      probability: number;
      logWeight: number | null;
      selected: boolean;
    }>;
  }>;
}

export interface PowerWalkParameterFitAudit {
  schema: "scce.powerwalk_parameter_fit.v1";
  parameterRole: "active_parameters";
  method: "source_disjoint_multinomial_nll_log_coordinate_descent";
  claimBoundary: "supplied_source_disjoint_transition_observations_only";
  status: "accepted_held_out_improvement" | "rejected_no_held_out_improvement" | "fallback_insufficient_observations";
  accepted: boolean;
  reasons: string[];
  datasetHash: string;
  observationCount: number;
  informativeObservationCount: number;
  sourceRecordCount: number;
  observationOrigins: Array<{ origin: "supplied_typed_observation" | "executed_transition_audit"; count: number }>;
  initializationAudit: JsonValue | null;
  split: {
    seed: string;
    holdoutFraction: number;
    splitHash: string;
    fitObservationIds: string[];
    heldOutObservationIds: string[];
    fitSourceRecordIds: string[];
    heldOutSourceRecordIds: string[];
  };
  objective: {
    candidateLogWeight: string;
    negativeLogLikelihood: string;
    transforms: { p: string; q: string; lambda: string };
  };
  limits: {
    p: { minimum: number; maximum: number };
    q: { minimum: number; maximum: number };
    lambda: { minimum: number; maximum: number; logOffset: number };
    maximumObservations: number;
    maximumCandidatesPerObservation: number;
    maximumTotalCandidates: number;
    maximumCoordinates: number;
    minimumFitObservations: number;
    minimumHoldoutObservations: number;
    maximumSweeps: number;
    minimumHeldOutMeanNllImprovement: number;
  };
  optimizer: {
    coordinateCount: number;
    sweepsCompleted: number;
    converged: boolean;
    initialLogStep: number;
    minimumLogStep: number;
    finalLogStep: number;
    trace: Array<{ sweep: number; logStep: number; acceptedMoves: number; fitTotalNegativeLogLikelihood: number }>;
  };
  parameters: Array<{
    kind: "p" | "q" | "lambda";
    typePair: string;
    initialized: number;
    fittedCandidate: number;
    published: number;
  }>;
  likelihood: {
    fit: { initialized: PowerWalkLikelihoodSummary; fittedCandidate: PowerWalkLikelihoodSummary };
    heldOut: { initialized: PowerWalkLikelihoodSummary; fittedCandidate: PowerWalkLikelihoodSummary };
    fitMeanNllImprovement: number;
    heldOutMeanNllImprovement: number;
  };
}

export interface PowerWalkParameterFitResult {
  /** Immutable bootstrap supplied to the fitter. */
  initializedParameters: PowerWalkParams;
  /** Optimizer candidate, whether or not holdout acceptance publishes it. */
  fittedParameters: PowerWalkParams;
  /** Parameters admitted by the held-out gate and used by the runtime. */
  activeParameters: PowerWalkParams;
  /** Backwards-compatible alias for activeParameters. */
  params: PowerWalkParams;
  audit: PowerWalkParameterFitAudit;
}

export const POWERWALK_PARAMETER_BOUNDS = Object.freeze({
  p: Object.freeze({ minimum: 0.125, maximum: 8 }),
  q: Object.freeze({ minimum: 0.125, maximum: 8 }),
  lambda: Object.freeze({ minimum: 0, maximum: 2, logOffset: 1e-6 })
});

const POWERWALK_FIT_MAXIMUM_OBSERVATIONS = 4_096;
const POWERWALK_FIT_MAXIMUM_CANDIDATES_PER_OBSERVATION = 64;
const POWERWALK_FIT_MAXIMUM_TOTAL_CANDIDATES = 65_536;
const POWERWALK_FIT_MAXIMUM_COORDINATES = 192;
const POWERWALK_FIT_DEFAULT_MINIMUM_FIT_OBSERVATIONS = 48;
const POWERWALK_FIT_DEFAULT_MINIMUM_HOLDOUT_OBSERVATIONS = 24;
const POWERWALK_FIT_MINIMUM_FIT_OBSERVATIONS = 16;
const POWERWALK_FIT_MINIMUM_HOLDOUT_OBSERVATIONS = 8;
const POWERWALK_FIT_DEFAULT_MAXIMUM_SWEEPS = 64;
const POWERWALK_FIT_INITIAL_LOG_STEP = 0.5;
const POWERWALK_FIT_MINIMUM_LOG_STEP = 1 / 128;
const POWERWALK_FIT_DEFAULT_HELD_OUT_IMPROVEMENT = 1e-6;
const POWERWALK_DEFAULT_P = 1;
const POWERWALK_DEFAULT_Q = 1;
const POWERWALK_DEFAULT_LAMBDA = 0.01;

export interface TypePairWalkStats {
  typePair: string;
  edges: number;
  meanAgeDays: number;
  ageVariance: number;
  meanAlphaWeight: number;
  meanOutDegree: number;
  temporalHalfLifeDays: number;
  p: number;
  q: number;
  lambda: number;
}

export interface PowerWalkResult {
  walks: NodeId[][];
  embeddings: Array<{ nodeId: NodeId; vector: number[] }>;
  typePairWalkLengths: PowerWalkLengthDiagnostic[];
  transitionAudit: Array<{
    start: NodeId;
    walkIndex: number;
    step: number;
    from: NodeId;
    to: NodeId;
    previous?: NodeId;
    edgeId: string;
    selected: boolean;
    typePair: string;
    observedAt: number;
    currentTypeId: string;
    targetTypeId: string;
    previousTypeId?: string;
    distance: 0 | 1 | 2;
    edgeWeight: number;
    edgeAlpha: number;
    edgeUpdatedAt: number;
    provenanceRecordIds: string[];
    probability: number;
    bias: number;
    decay: number;
    alphaWeight: number;
  }>;
  cooccurrence: Array<{ nodeId: NodeId; contextNodeId: NodeId; count: number; distanceMean: number; weight: number }>;
  cooccurrenceState: SparseCooccurrenceState;
  representation: SparsePpmiDiagnostics & {
    excludedZeroContextNodes: number;
    zeroContextPolicy: "excluded_from_similarity";
  };
  parameterization: JsonValue;
}

export interface PowerWalkExecution {
  now?: number;
  seed?: string;
  walksPerNode?: number;
  dimensions?: number;
  validationFraction?: number;
  priorCooccurrenceState?: SparseCooccurrenceState;
  parameterFitOptions?: PowerWalkParameterFitOptions;
}

export interface PowerWalkSeedAnchor {
  nodeId: NodeId;
  weight: number;
  feature?: string;
}

export interface PowerWalkSeedExpansionAudit {
  schema: "scce.powerwalk_seed_expansion.v1";
  method: "query_anchor_ppmi_cosine";
  anchorInputCount: number;
  usableAnchorCount: number;
  excludedAnchorCount: number;
  representedNodeCount: number;
  comparedPairs: number;
  minimumCosine: number;
  maximumExpandedSeeds: number;
  expansionScale: number;
  expandedSeedCount: number;
  top: Array<{ nodeId: NodeId; anchorNodeId: NodeId; cosine: number; weight: number }>;
}

export interface PowerWalkSeedExpansion {
  seeds: PowerWalkSeedAnchor[];
  audit: PowerWalkSeedExpansionAudit;
}

export interface PowerWalkLengthDiagnostic {
  typePair: string;
  spectralGap: number;
  length: number;
  boundKind: "reversible_absolute_spectral_bound" | "exploration_heuristic";
  rationale: "bound_assumptions_not_established" | "second_order_transition_bound_not_established";
  assumptions: {
    rowStochastic: boolean;
    irreducible: boolean;
    aperiodic: boolean;
    reversible: boolean;
  };
}

export function createTypedTemporalWalkEngine(options: { hasher: Hasher }) {
  let runtimeTransitionObservations: PowerWalkTransitionObservation[] = [];
  let cachedRuntimeFit: { key: string; result: PowerWalkParameterFitResult } | undefined;
  return {
    initialize(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now = graphSnapshotTime(edges)): PowerWalkParams {
      validatePowerWalkInputs(nodes, edges, now);
      return initializePowerWalkParameters(nodes, edges, now);
    },

    /**
     * @deprecated Compatibility name only. This returns the deterministic
     * initializer and makes no calibration claim.
     */
    calibrate(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now = graphSnapshotTime(edges)): PowerWalkParams {
      return this.initialize(nodes, edges, now);
    },

    fit(
      observations: readonly PowerWalkTransitionObservation[],
      initialParameters: PowerWalkParams,
      fitOptions: PowerWalkParameterFitOptions = {}
    ): PowerWalkParameterFitResult {
      return fitPowerWalkParameters({ observations, initialParameters, hasher: options.hasher, options: fitOptions });
    },

    run(nodes: readonly GraphNode[], edges: readonly GraphEdge[], params?: PowerWalkParams, execution: PowerWalkExecution = {}): PowerWalkResult {
      const now = execution.now ?? graphSnapshotTime(edges);
      validatePowerWalkInputs(nodes, edges, now);
      const canonicalNodes = [...nodes].sort(compareNodes);
      const canonicalEdges = [...edges].sort(compareEdges);
      const initialized = params ?? this.initialize(canonicalNodes, canonicalEdges, now);
      let cfg = initialized;
      if (!params && runtimeTransitionObservations.length > 0) {
        const fitKey = runtimePowerWalkFitKey(runtimeTransitionObservations, initialized, execution.parameterFitOptions, options.hasher);
        const fit = cachedRuntimeFit?.key === fitKey
          ? cachedRuntimeFit.result
          : this.fit(runtimeTransitionObservations, initialized, execution.parameterFitOptions);
        cachedRuntimeFit = { key: fitKey, result: fit };
        cfg = fit.activeParameters;
      }
      const byId = new Map(canonicalNodes.map(node => [node.id, node]));
      const neighbor = new Map<NodeId, GraphEdge[]>();
      for (const edge of canonicalEdges) {
        if (!byId.has(edge.source) || !byId.has(edge.target)) continue;
        if (!neighbor.has(edge.source)) neighbor.set(edge.source, []);
        neighbor.get(edge.source)?.push(edge);
      }
      const transition = transitionMatrix(canonicalNodes, canonicalEdges, cfg, now);
      const typePairWalkLengths = walkLengthsByType(canonicalNodes, canonicalEdges, transition, cfg.epsilon);
      const transitionAudit: PowerWalkResult["transitionAudit"] = [];
      const walks: NodeId[][] = [];
      for (const node of canonicalNodes.slice(0, 500)) {
        const typeLength = typePairWalkLengths.find(item => item.typePair.startsWith(`${String(node.typeId)}->`))?.length ?? 16;
        const walksPerNode = Math.max(1, Math.min(64, Math.floor(execution.walksPerNode ?? 4)));
        for (let walkIndex = 0; walkIndex < walksPerNode; walkIndex++) {
          const walked = walkFrom(node.id, byId, neighbor, canonicalEdges, cfg, Math.min(96, Math.max(8, typeLength)), options.hasher, now, execution.seed ?? "powerwalk", walkIndex);
          walks.push(walked.walk);
          if (transitionAudit.length < 512) transitionAudit.push(...walked.audit.slice(0, 512 - transitionAudit.length));
        }
      }
      const cooccurrence = walkCooccurrence(walks, 4);
      const observedTransitions = powerWalkTransitionObservationsFromAudit(transitionAudit, options.hasher);
      if (observedTransitions.length > 0) {
        runtimeTransitionObservations = mergeRuntimeTransitionObservations(runtimeTransitionObservations, observedTransitions);
      }
      const split = splitCooccurrenceForValidation(cooccurrence, {
        hasher: options.hasher,
        seed: `${execution.seed ?? "powerwalk"}:validation`,
        validationFraction: execution.validationFraction
      });
      const fit = fitSparsePpmiRepresentation(canonicalNodes.map(node => node.id), split.training, {
        hasher: options.hasher,
        dimensions: execution.dimensions,
        projectionSeed: `${execution.seed ?? "powerwalk"}:projection`,
        window: 4,
        priorState: execution.priorCooccurrenceState,
        snapshotId: options.hasher.digestHex(JSON.stringify({
          schema: "powerwalk.training-snapshot.v2",
          seed: execution.seed ?? "powerwalk",
          now,
          partitionPolicyHash: split.partition.policyHash,
          splitHash: split.partition.splitHash
        })),
        validation: split.validation,
        partition: split.partition,
        partitionMismatch: "reset"
      });
      return {
        walks,
        embeddings: fit.embeddings,
        typePairWalkLengths,
        transitionAudit,
        cooccurrence: cooccurrence.slice(0, 2048),
        cooccurrenceState: fit.state,
        representation: {
          ...fit.diagnostics,
          excludedZeroContextNodes: fit.diagnostics.zeroContextNodes,
          zeroContextPolicy: "excluded_from_similarity"
        },
        parameterization: cfg.audit ?? toJsonValue({ schema: "scce.powerwalk_parameter_input.v1", epsilon: cfg.epsilon, evidence: "caller_supplied" })
      };
    }
  };
}

/**
 * Expand query-conditioned retrieval anchors through the learned PowerWalk
 * representation. The input anchors are the only query signal: embeddings are
 * learned from PPMI walk contexts, and zero-context nodes are never replaced by
 * hash-derived vectors.
 */
export function expandPowerWalkSeedAnchors(input: {
  anchors: readonly PowerWalkSeedAnchor[];
  embeddings: readonly { nodeId: NodeId; vector: readonly number[] }[];
  minimumCosine?: number;
  maximumExpandedSeeds?: number;
  maximumAnchors?: number;
  expansionScale?: number;
}): PowerWalkSeedExpansion {
  const minimumCosine = clamp(input.minimumCosine ?? 0.2, -1, 1);
  const maximumExpandedSeeds = clampInteger(input.maximumExpandedSeeds ?? 24, 0, 128);
  const maximumAnchors = clampInteger(input.maximumAnchors ?? 32, 0, 128);
  const expansionScale = clamp01(input.expansionScale ?? 0.5);
  const embeddingByNode = new Map(input.embeddings.map(row => [String(row.nodeId), row]));
  const represented = input.embeddings
    .filter(row => hasLearnedContext(row.vector))
    .sort((left, right) => compareOrdinal(String(left.nodeId), String(right.nodeId)));
  const anchorIds = new Set(input.anchors.map(anchor => String(anchor.nodeId)));
  const anchors = [...input.anchors]
    .filter(anchor => Number.isFinite(anchor.weight) && anchor.weight > 0)
    .sort((left, right) => right.weight - left.weight || compareOrdinal(String(left.nodeId), String(right.nodeId)))
    .slice(0, maximumAnchors);
  const usableAnchors = anchors.filter(anchor => {
    const embedding = embeddingByNode.get(String(anchor.nodeId));
    return embedding ? hasLearnedContext(embedding.vector) : false;
  });
  let comparedPairs = 0;
  const bestByNode = new Map<string, { nodeId: NodeId; anchorNodeId: NodeId; cosine: number; weight: number }>();
  for (const anchor of usableAnchors) {
    const anchorVector = embeddingByNode.get(String(anchor.nodeId))!.vector;
    for (const candidate of represented) {
      if (anchorIds.has(String(candidate.nodeId))) continue;
      comparedPairs++;
      const cosine = cosineSimilarity(anchorVector, candidate.vector);
      if (!Number.isFinite(cosine) || cosine < minimumCosine) continue;
      const weight = clamp01(anchor.weight * cosine * expansionScale);
      if (!(weight > 0)) continue;
      const key = String(candidate.nodeId);
      const existing = bestByNode.get(key);
      if (!existing || weight > existing.weight || (weight === existing.weight && compareOrdinal(String(anchor.nodeId), String(existing.anchorNodeId)) < 0)) {
        bestByNode.set(key, { nodeId: candidate.nodeId, anchorNodeId: anchor.nodeId, cosine, weight });
      }
    }
  }
  const selected = [...bestByNode.values()]
    .sort((left, right) => right.weight - left.weight || right.cosine - left.cosine || compareOrdinal(String(left.nodeId), String(right.nodeId)))
    .slice(0, maximumExpandedSeeds);
  return {
    seeds: selected.map(row => ({
      nodeId: row.nodeId,
      weight: row.weight,
      feature: `powerwalk:ppmi-cosine:${String(row.anchorNodeId)}`
    })),
    audit: {
      schema: "scce.powerwalk_seed_expansion.v1",
      method: "query_anchor_ppmi_cosine",
      anchorInputCount: input.anchors.length,
      usableAnchorCount: usableAnchors.length,
      excludedAnchorCount: input.anchors.length - usableAnchors.length,
      representedNodeCount: represented.length,
      comparedPairs,
      minimumCosine,
      maximumExpandedSeeds,
      expansionScale,
      expandedSeedCount: selected.length,
      top: selected.slice(0, 12)
    }
  };
}

export function initializePowerWalkParameters(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now = graphSnapshotTime(edges)): PowerWalkParams {
  const p = new Map<string, number>();
  const q = new Map<string, number>();
  const lambda = new Map<string, number>();
  const stats = typePairStats(nodes, edges, now);
  for (const row of stats) {
    p.set(row.typePair, row.p);
    q.set(row.typePair, row.q);
    lambda.set(row.typePair, row.lambda);
  }
  return {
    p,
    q,
    lambda,
    epsilon: 0.01,
    audit: toJsonValue({
      schema: "scce.powerwalk_parameter_initialization.v1",
      method: "graph_statistics_bootstrap",
      fitted: false,
      claimBoundary: "deterministic_initializer_only",
      stats
    })
  };
}

/**
 * @deprecated Compatibility name only. PowerWalk graph statistics initialize
 * parameters; they do not calibrate probabilities.
 */
export function calibratePowerWalkParameters(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now = graphSnapshotTime(edges)): PowerWalkParams {
  return initializePowerWalkParameters(nodes, edges, now);
}

/**
 * Fit p, q, and temporal decay only from supplied transition choices. The
 * graph-statistics initializer remains the published fallback unless the
 * untouched, source-record-disjoint holdout has lower mean NLL.
 */
export function fitPowerWalkParameters(input: {
  observations: readonly PowerWalkTransitionObservation[];
  initialParameters: PowerWalkParams;
  hasher: Hasher;
  options?: PowerWalkParameterFitOptions;
}): PowerWalkParameterFitResult {
  validateFitInitialParameters(input.initialParameters);
  const options = normalizedPowerWalkFitOptions(input.options);
  const observations = normalizeTransitionObservations(input.observations);
  const prepared = observations.map(prepareTransitionObservation);
  const datasetHash = input.hasher.digestHex(canonicalStringify(observations));
  const split = splitPowerWalkObservations(observations, input.hasher, options.seed, options.holdoutFraction);
  const byId = new Map(prepared.map(observation => [observation.observation.id, observation]));
  const fitObservations = split.fitObservationIds.map(id => byId.get(id)).filter((row): row is PreparedPowerWalkObservation => Boolean(row));
  const heldOutObservations = split.heldOutObservationIds.map(id => byId.get(id)).filter((row): row is PreparedPowerWalkObservation => Boolean(row));
  // The untouched holdout may score a fitted coordinate, but it must not
  // decide which coordinates exist.
  const coordinates = powerWalkFitCoordinates(fitObservations);
  if (coordinates.length > POWERWALK_FIT_MAXIMUM_COORDINATES) {
    throw new Error(`PowerWalk parameter fit has ${coordinates.length} coordinates; maximum is ${POWERWALK_FIT_MAXIMUM_COORDINATES}`);
  }

  const fitInformativeCount = informativeObservationCount(fitObservations);
  const heldOutInformativeCount = informativeObservationCount(heldOutObservations);
  const reasons: string[] = [];
  if (split.fitSourceRecordIds.length === 0 || split.heldOutSourceRecordIds.length === 0) reasons.push("fewer_than_two_source_records");
  if (fitInformativeCount < options.minimumFitObservations) reasons.push("fit_informative_observations_below_minimum");
  if (heldOutInformativeCount < options.minimumHoldoutObservations) reasons.push("held_out_informative_observations_below_minimum");
  if (coordinates.length === 0) reasons.push("no_identifiable_parameter_coordinates");

  const initializedFitLikelihood = summarizePowerWalkLikelihood(fitObservations, input.initialParameters);
  const initializedHeldOutLikelihood = summarizePowerWalkLikelihood(heldOutObservations, input.initialParameters);
  const commonAudit = {
    schema: "scce.powerwalk_parameter_fit.v1" as const,
    parameterRole: "active_parameters" as const,
    method: "source_disjoint_multinomial_nll_log_coordinate_descent" as const,
    claimBoundary: "supplied_source_disjoint_transition_observations_only" as const,
    datasetHash,
    observationCount: prepared.length,
    informativeObservationCount: informativeObservationCount(prepared),
    sourceRecordCount: new Set(observations.map(observation => observation.sourceRecordId)).size,
    observationOrigins: powerWalkObservationOriginCounts(observations),
    initializationAudit: input.initialParameters.audit ?? null,
    split,
    objective: {
      candidateLogWeight: "log(edgeWeight*edgeAlpha)-I[distance=0]*log(p[previousType->currentType])-I[distance=2]*log(q[currentType->targetType])-lambda[currentType->targetType]*ageDays",
      negativeLogLikelihood: "sum_observations(logsumexp(candidateLogWeight)-selectedCandidateLogWeight)",
      transforms: {
        p: "theta_p=log(p)",
        q: "theta_q=log(q)",
        lambda: `theta_lambda=log(lambda+${POWERWALK_PARAMETER_BOUNDS.lambda.logOffset})`
      }
    },
    limits: {
      p: { ...POWERWALK_PARAMETER_BOUNDS.p },
      q: { ...POWERWALK_PARAMETER_BOUNDS.q },
      lambda: { ...POWERWALK_PARAMETER_BOUNDS.lambda },
      maximumObservations: POWERWALK_FIT_MAXIMUM_OBSERVATIONS,
      maximumCandidatesPerObservation: POWERWALK_FIT_MAXIMUM_CANDIDATES_PER_OBSERVATION,
      maximumTotalCandidates: POWERWALK_FIT_MAXIMUM_TOTAL_CANDIDATES,
      maximumCoordinates: POWERWALK_FIT_MAXIMUM_COORDINATES,
      minimumFitObservations: options.minimumFitObservations,
      minimumHoldoutObservations: options.minimumHoldoutObservations,
      maximumSweeps: options.maximumSweeps,
      minimumHeldOutMeanNllImprovement: options.minimumHeldOutMeanNllImprovement
    }
  };

  if (reasons.length > 0) {
    const initialized = clonePowerWalkParameters(input.initialParameters);
    const fitted = clonePowerWalkParameters(input.initialParameters);
    const published = clonePowerWalkParameters(input.initialParameters);
    const audit: PowerWalkParameterFitAudit = {
      ...commonAudit,
      status: "fallback_insufficient_observations",
      accepted: false,
      reasons,
      optimizer: {
        coordinateCount: coordinates.length,
        sweepsCompleted: 0,
        converged: false,
        initialLogStep: POWERWALK_FIT_INITIAL_LOG_STEP,
        minimumLogStep: POWERWALK_FIT_MINIMUM_LOG_STEP,
        finalLogStep: POWERWALK_FIT_INITIAL_LOG_STEP,
        trace: []
      },
      parameters: parameterAuditRows(coordinates, input.initialParameters, input.initialParameters, input.initialParameters),
      likelihood: {
        fit: { initialized: initializedFitLikelihood, fittedCandidate: initializedFitLikelihood },
        heldOut: { initialized: initializedHeldOutLikelihood, fittedCandidate: initializedHeldOutLikelihood },
        fitMeanNllImprovement: 0,
        heldOutMeanNllImprovement: 0
      }
    };
    initialized.audit = powerWalkFitInputAudit(input.initialParameters.audit);
    fitted.audit = powerWalkFittedCandidateAudit(audit, false);
    published.audit = toJsonValue(audit);
    return {
      initializedParameters: initialized,
      fittedParameters: fitted,
      activeParameters: published,
      params: published,
      audit
    };
  }

  const optimized = fitPowerWalkCoordinates(fitObservations, input.initialParameters, coordinates, options.maximumSweeps);
  const fittedFitLikelihood = summarizePowerWalkLikelihood(fitObservations, optimized.params);
  const fittedHeldOutLikelihood = summarizePowerWalkLikelihood(heldOutObservations, optimized.params);
  const fitMeanNllImprovement = initializedFitLikelihood.meanNegativeLogLikelihood - fittedFitLikelihood.meanNegativeLogLikelihood;
  const heldOutMeanNllImprovement = initializedHeldOutLikelihood.meanNegativeLogLikelihood - fittedHeldOutLikelihood.meanNegativeLogLikelihood;
  const accepted = fitMeanNllImprovement > 0 && heldOutMeanNllImprovement > options.minimumHeldOutMeanNllImprovement;
  const rejectionReasons = accepted
    ? []
    : [
        ...(fitMeanNllImprovement > 0 ? [] : ["fit_mean_nll_did_not_improve"]),
        ...(heldOutMeanNllImprovement > options.minimumHeldOutMeanNllImprovement ? [] : ["held_out_mean_nll_improvement_not_above_threshold"])
      ];
  const published = clonePowerWalkParameters(accepted ? optimized.params : input.initialParameters);
  const audit: PowerWalkParameterFitAudit = {
    ...commonAudit,
    status: accepted ? "accepted_held_out_improvement" : "rejected_no_held_out_improvement",
    accepted,
    reasons: rejectionReasons,
    optimizer: {
      coordinateCount: coordinates.length,
      sweepsCompleted: optimized.trace.length,
      converged: optimized.converged,
      initialLogStep: POWERWALK_FIT_INITIAL_LOG_STEP,
      minimumLogStep: POWERWALK_FIT_MINIMUM_LOG_STEP,
      finalLogStep: optimized.finalLogStep,
      trace: optimized.trace
    },
    parameters: parameterAuditRows(coordinates, input.initialParameters, optimized.params, published),
    likelihood: {
      fit: { initialized: initializedFitLikelihood, fittedCandidate: fittedFitLikelihood },
      heldOut: { initialized: initializedHeldOutLikelihood, fittedCandidate: fittedHeldOutLikelihood },
      fitMeanNllImprovement,
      heldOutMeanNllImprovement
    }
  };
  const initialized = clonePowerWalkParameters(input.initialParameters);
  initialized.audit = powerWalkFitInputAudit(input.initialParameters.audit);
  const fitted = clonePowerWalkParameters(optimized.params);
  fitted.audit = powerWalkFittedCandidateAudit(audit, true);
  published.audit = toJsonValue(audit);
  return {
    initializedParameters: initialized,
    fittedParameters: fitted,
    activeParameters: published,
    params: published,
    audit
  };
}

/** Return the normalized model distribution for one typed transition record. */
export function powerWalkTransitionDistribution(
  observation: PowerWalkTransitionObservation,
  params: PowerWalkParams
): PowerWalkTransitionDistribution {
  validateFitInitialParameters(params);
  return distributionForPrepared(prepareTransitionObservation(normalizeTransitionObservation(observation)), params);
}

/**
 * Convert bounded, actually executed walk choices into typed fit records. A
 * choice without selected-edge provenance is omitted: the fitter must never
 * invent a source group merely to satisfy its split contract.
 */
export function powerWalkTransitionObservationsFromAudit(
  audit: readonly (PowerWalkResult["transitionAudit"][number])[],
  hasher: Hasher
): PowerWalkTransitionObservation[] {
  const grouped = new Map<string, Array<PowerWalkResult["transitionAudit"][number]>>();
  for (const row of audit.slice(0, 512)) {
    const key = canonicalStringify({
      start: String(row.start),
      walkIndex: row.walkIndex,
      step: row.step,
      from: String(row.from),
      previous: row.previous === undefined ? null : String(row.previous),
      observedAt: row.observedAt
    });
    const rows = grouped.get(key) ?? [];
    rows.push(row);
    grouped.set(key, rows);
  }

  const observations: PowerWalkTransitionObservation[] = [];
  for (const rows of grouped.values()) {
    if (rows.length < 2 || rows.length > POWERWALK_FIT_MAXIMUM_CANDIDATES_PER_OBSERVATION) continue;
    const selectedRows = rows.filter(row => row.selected);
    if (selectedRows.length !== 1) continue;
    const selected = selectedRows[0]!;
    const sourceRecordId = selected.provenanceRecordIds[0];
    if (!sourceRecordId) continue;
    if (selected.previous !== undefined && !selected.previousTypeId) continue;
    if (rows.some(row => row.from !== selected.from
      || row.previous !== selected.previous
      || row.observedAt !== selected.observedAt
      || row.currentTypeId !== selected.currentTypeId)) continue;
    const candidates = rows
      .map(row => ({
        edgeId: row.edgeId,
        targetNodeId: row.to,
        targetTypeId: row.targetTypeId,
        distance: row.distance,
        edgeWeight: row.edgeWeight,
        edgeAlpha: row.edgeAlpha,
        edgeUpdatedAt: row.edgeUpdatedAt
      }))
      .sort((left, right) => compareOrdinal(left.edgeId, right.edgeId));
    if (new Set(candidates.map(candidate => candidate.edgeId)).size !== candidates.length) continue;
    const identity = {
      execution: { start: String(selected.start), walkIndex: selected.walkIndex, step: selected.step },
      sourceRecordId,
      observedAt: selected.observedAt,
      previousNodeId: selected.previous === undefined ? null : String(selected.previous),
      previousTypeId: selected.previousTypeId ?? null,
      currentNodeId: String(selected.from),
      currentTypeId: selected.currentTypeId,
      selectedEdgeId: selected.edgeId,
      candidates
    };
    observations.push({
      schema: POWERWALK_TRANSITION_OBSERVATION_SCHEMA,
      origin: "executed_transition_audit",
      id: `powerwalk.audit.${hasher.digestHex(canonicalStringify(identity))}`,
      sourceRecordId,
      observedAt: selected.observedAt,
      ...(selected.previous === undefined
        ? {}
        : { previousNodeId: selected.previous, previousTypeId: selected.previousTypeId! }),
      currentNodeId: selected.from,
      currentTypeId: selected.currentTypeId,
      selectedEdgeId: selected.edgeId,
      candidates
    });
  }
  return observations.sort((left, right) => compareOrdinal(left.id, right.id));
}

interface NormalizedPowerWalkFitOptions {
  seed: string;
  holdoutFraction: number;
  minimumFitObservations: number;
  minimumHoldoutObservations: number;
  maximumSweeps: number;
  minimumHeldOutMeanNllImprovement: number;
}

interface PreparedPowerWalkCandidate {
  edgeId: string;
  typePair: string;
  distance: 0 | 1 | 2;
  edgeWeight: number;
  edgeAlpha: number;
  ageDays: number;
  selected: boolean;
}

interface PreparedPowerWalkObservation {
  observation: PowerWalkTransitionObservation;
  returnTypePair: string;
  candidates: PreparedPowerWalkCandidate[];
}

interface PowerWalkFitCoordinate {
  kind: "p" | "q" | "lambda";
  typePair: string;
}

interface PowerWalkObservationSplit {
  seed: string;
  holdoutFraction: number;
  splitHash: string;
  fitObservationIds: string[];
  heldOutObservationIds: string[];
  fitSourceRecordIds: string[];
  heldOutSourceRecordIds: string[];
}

function normalizedPowerWalkFitOptions(options: PowerWalkParameterFitOptions | undefined): NormalizedPowerWalkFitOptions {
  const seed = requiredPowerWalkText(options?.seed ?? "scce.powerwalk_parameter_fit.v1", "fit seed");
  const holdoutFraction = options?.holdoutFraction ?? 0.25;
  if (!Number.isFinite(holdoutFraction) || holdoutFraction <= 0 || holdoutFraction > 0.5) {
    throw new Error("PowerWalk holdoutFraction must be finite and within (0,0.5]");
  }
  const minimumFitObservations = boundedFitInteger(
    options?.minimumFitObservations ?? POWERWALK_FIT_DEFAULT_MINIMUM_FIT_OBSERVATIONS,
    POWERWALK_FIT_MINIMUM_FIT_OBSERVATIONS,
    POWERWALK_FIT_MAXIMUM_OBSERVATIONS,
    "minimumFitObservations"
  );
  const minimumHoldoutObservations = boundedFitInteger(
    options?.minimumHoldoutObservations ?? POWERWALK_FIT_DEFAULT_MINIMUM_HOLDOUT_OBSERVATIONS,
    POWERWALK_FIT_MINIMUM_HOLDOUT_OBSERVATIONS,
    POWERWALK_FIT_MAXIMUM_OBSERVATIONS,
    "minimumHoldoutObservations"
  );
  const maximumSweeps = boundedFitInteger(options?.maximumSweeps ?? POWERWALK_FIT_DEFAULT_MAXIMUM_SWEEPS, 1, 128, "maximumSweeps");
  const minimumHeldOutMeanNllImprovement = options?.minimumHeldOutMeanNllImprovement ?? POWERWALK_FIT_DEFAULT_HELD_OUT_IMPROVEMENT;
  if (!Number.isFinite(minimumHeldOutMeanNllImprovement) || minimumHeldOutMeanNllImprovement < 0) {
    throw new Error("PowerWalk minimumHeldOutMeanNllImprovement must be finite and non-negative");
  }
  return { seed, holdoutFraction, minimumFitObservations, minimumHoldoutObservations, maximumSweeps, minimumHeldOutMeanNllImprovement };
}

function normalizeTransitionObservations(input: readonly PowerWalkTransitionObservation[]): PowerWalkTransitionObservation[] {
  if (input.length > POWERWALK_FIT_MAXIMUM_OBSERVATIONS) {
    throw new Error(`PowerWalk parameter fit has ${input.length} observations; maximum is ${POWERWALK_FIT_MAXIMUM_OBSERVATIONS}`);
  }
  const observations = input.map(normalizeTransitionObservation).sort((left, right) => compareOrdinal(left.id, right.id));
  const seen = new Set<string>();
  let totalCandidates = 0;
  for (const observation of observations) {
    if (seen.has(observation.id)) throw new Error(`PowerWalk transition observation id is duplicated: ${observation.id}`);
    seen.add(observation.id);
    totalCandidates += observation.candidates.length;
  }
  if (totalCandidates > POWERWALK_FIT_MAXIMUM_TOTAL_CANDIDATES) {
    throw new Error(`PowerWalk parameter fit has ${totalCandidates} candidates; maximum is ${POWERWALK_FIT_MAXIMUM_TOTAL_CANDIDATES}`);
  }
  return observations;
}

function powerWalkObservationOriginCounts(
  observations: readonly PowerWalkTransitionObservation[]
): PowerWalkParameterFitAudit["observationOrigins"] {
  const origins = ["supplied_typed_observation", "executed_transition_audit"] as const;
  return origins
    .map(origin => ({ origin, count: observations.filter(observation => (observation.origin ?? "supplied_typed_observation") === origin).length }))
    .filter(row => row.count > 0);
}

function normalizeTransitionObservation(input: PowerWalkTransitionObservation): PowerWalkTransitionObservation {
  if (!input || typeof input !== "object") throw new Error("PowerWalk transition observation must be an object");
  if (input.schema !== POWERWALK_TRANSITION_OBSERVATION_SCHEMA) throw new Error(`PowerWalk transition observation schema is invalid: ${String(input.id)}`);
  const id = requiredPowerWalkText(input.id, "observation.id");
  const origin = input.origin ?? "supplied_typed_observation";
  if (origin !== "supplied_typed_observation" && origin !== "executed_transition_audit") {
    throw new Error(`PowerWalk observation ${id} origin is invalid`);
  }
  const sourceRecordId = requiredPowerWalkText(input.sourceRecordId, `observation ${id} sourceRecordId`);
  const currentTypeId = requiredPowerWalkText(input.currentTypeId, `observation ${id} currentTypeId`);
  requiredPowerWalkText(input.currentNodeId, `observation ${id} currentNodeId`);
  const selectedEdgeId = requiredPowerWalkText(input.selectedEdgeId, `observation ${id} selectedEdgeId`);
  if (!Number.isFinite(input.observedAt)) throw new Error(`PowerWalk observation ${id} observedAt must be finite`);
  const hasPreviousNode = input.previousNodeId !== undefined;
  const hasPreviousType = input.previousTypeId !== undefined;
  if (hasPreviousNode !== hasPreviousType) throw new Error(`PowerWalk observation ${id} previous node and type must be supplied together`);
  if (hasPreviousNode) requiredPowerWalkText(input.previousNodeId, `observation ${id} previousNodeId`);
  const previousTypeId = hasPreviousType ? requiredPowerWalkText(input.previousTypeId, `observation ${id} previousTypeId`) : undefined;
  if (!Array.isArray(input.candidates) || input.candidates.length < 2) throw new Error(`PowerWalk observation ${id} requires at least two candidates`);
  if (input.candidates.length > POWERWALK_FIT_MAXIMUM_CANDIDATES_PER_OBSERVATION) {
    throw new Error(`PowerWalk observation ${id} has too many candidates; maximum is ${POWERWALK_FIT_MAXIMUM_CANDIDATES_PER_OBSERVATION}`);
  }
  const edgeIds = new Set<string>();
  const candidates = input.candidates.map(candidate => {
    const edgeId = requiredPowerWalkText(candidate.edgeId, `observation ${id} candidate.edgeId`);
    if (edgeIds.has(edgeId)) throw new Error(`PowerWalk observation ${id} candidate edge id is duplicated: ${edgeId}`);
    edgeIds.add(edgeId);
    const targetTypeId = requiredPowerWalkText(candidate.targetTypeId, `observation ${id} candidate ${edgeId} targetTypeId`);
    requiredPowerWalkText(candidate.targetNodeId, `observation ${id} candidate ${edgeId} targetNodeId`);
    if (candidate.distance !== 0 && candidate.distance !== 1 && candidate.distance !== 2) {
      throw new Error(`PowerWalk observation ${id} candidate ${edgeId} distance must be 0, 1, or 2`);
    }
    assertFiniteNonnegative(candidate.edgeWeight, `observation ${id} candidate ${edgeId} edgeWeight`);
    assertFiniteNonnegative(candidate.edgeAlpha, `observation ${id} candidate ${edgeId} edgeAlpha`);
    const alphaWeight = candidate.edgeWeight * candidate.edgeAlpha;
    if (!Number.isFinite(alphaWeight)) throw new Error(`PowerWalk observation ${id} candidate ${edgeId} edgeWeight*edgeAlpha must be finite`);
    if (!Number.isFinite(candidate.edgeUpdatedAt)) throw new Error(`PowerWalk observation ${id} candidate ${edgeId} edgeUpdatedAt must be finite`);
    if (!hasPreviousNode && candidate.distance !== 1) throw new Error(`PowerWalk observation ${id} without a previous node requires distance 1 candidates`);
    if (hasPreviousNode && (String(candidate.targetNodeId) === String(input.previousNodeId)) !== (candidate.distance === 0)) {
      throw new Error(`PowerWalk observation ${id} candidate ${edgeId} return distance disagrees with previousNodeId`);
    }
    return {
      edgeId,
      targetNodeId: candidate.targetNodeId,
      targetTypeId,
      distance: candidate.distance,
      edgeWeight: candidate.edgeWeight,
      edgeAlpha: candidate.edgeAlpha,
      edgeUpdatedAt: candidate.edgeUpdatedAt
    };
  }).sort((left, right) => compareOrdinal(left.edgeId, right.edgeId));
  const selected = candidates.find(candidate => candidate.edgeId === selectedEdgeId);
  if (!selected) throw new Error(`PowerWalk observation ${id} selectedEdgeId is not a candidate`);
  if (!(selected.edgeWeight * selected.edgeAlpha > 0)) throw new Error(`PowerWalk observation ${id} selected candidate must have positive edge weight*edgeAlpha`);
  return {
    schema: POWERWALK_TRANSITION_OBSERVATION_SCHEMA,
    origin,
    id,
    sourceRecordId,
    observedAt: input.observedAt,
    ...(hasPreviousNode ? { previousNodeId: input.previousNodeId!, previousTypeId: previousTypeId! } : {}),
    currentNodeId: input.currentNodeId,
    currentTypeId,
    selectedEdgeId,
    candidates
  };
}

function prepareTransitionObservation(observation: PowerWalkTransitionObservation): PreparedPowerWalkObservation {
  const returnTypePair = `${observation.previousTypeId ?? observation.currentTypeId}->${observation.currentTypeId}`;
  return {
    observation,
    returnTypePair,
    candidates: observation.candidates.map(candidate => ({
      edgeId: candidate.edgeId,
      typePair: `${observation.currentTypeId}->${candidate.targetTypeId}`,
      distance: candidate.distance,
      edgeWeight: candidate.edgeWeight,
      edgeAlpha: candidate.edgeAlpha,
      ageDays: Math.max(0, observation.observedAt - candidate.edgeUpdatedAt) / (1000 * 60 * 60 * 24),
      selected: candidate.edgeId === observation.selectedEdgeId
    }))
  };
}

function splitPowerWalkObservations(
  observations: readonly PowerWalkTransitionObservation[],
  hasher: Hasher,
  seed: string,
  holdoutFraction: number
): PowerWalkObservationSplit {
  const sourceRecordIds = [...new Set(observations.map(observation => observation.sourceRecordId))]
    .sort((left, right) => compareOrdinal(hasher.digestHex(`${seed}\u001f${left}`), hasher.digestHex(`${seed}\u001f${right}`)) || compareOrdinal(left, right));
  const heldOutCount = sourceRecordIds.length < 2 ? 0 : Math.max(1, Math.min(sourceRecordIds.length - 1, Math.round(sourceRecordIds.length * holdoutFraction)));
  const heldOutSourceRecordIds = sourceRecordIds.slice(0, heldOutCount).sort();
  const fitSourceRecordIds = sourceRecordIds.slice(heldOutCount).sort();
  const heldOutSet = new Set(heldOutSourceRecordIds);
  const fitObservationIds = observations.filter(observation => !heldOutSet.has(observation.sourceRecordId)).map(observation => observation.id).sort();
  const heldOutObservationIds = observations.filter(observation => heldOutSet.has(observation.sourceRecordId)).map(observation => observation.id).sort();
  const splitBody = { seed, holdoutFraction, fitObservationIds, heldOutObservationIds, fitSourceRecordIds, heldOutSourceRecordIds };
  return { ...splitBody, splitHash: hasher.digestHex(canonicalStringify(splitBody)) };
}

function powerWalkFitCoordinates(observations: readonly PreparedPowerWalkObservation[]): PowerWalkFitCoordinate[] {
  const keys = new Map<string, PowerWalkFitCoordinate>();
  for (const observation of observations) {
    if (observation.candidates.some(candidate => candidate.distance === 0)) {
      keys.set(`p\u001f${observation.returnTypePair}`, { kind: "p", typePair: observation.returnTypePair });
    }
    for (const candidate of observation.candidates) {
      if (candidate.distance === 2) keys.set(`q\u001f${candidate.typePair}`, { kind: "q", typePair: candidate.typePair });
      if (candidate.ageDays > 0) keys.set(`lambda\u001f${candidate.typePair}`, { kind: "lambda", typePair: candidate.typePair });
    }
  }
  const order = { p: 0, q: 1, lambda: 2 } as const;
  return [...keys.values()].sort((left, right) => order[left.kind] - order[right.kind] || compareOrdinal(left.typePair, right.typePair));
}

function fitPowerWalkCoordinates(
  observations: readonly PreparedPowerWalkObservation[],
  initialParameters: PowerWalkParams,
  coordinates: readonly PowerWalkFitCoordinate[],
  maximumSweeps: number
): {
  params: PowerWalkParams;
  converged: boolean;
  finalLogStep: number;
  trace: Array<{ sweep: number; logStep: number; acceptedMoves: number; fitTotalNegativeLogLikelihood: number }>;
} {
  const params = clonePowerWalkParameters(initialParameters);
  for (const coordinate of coordinates) setPowerWalkParameter(params, coordinate, powerWalkParameter(initialParameters, coordinate));
  const affected = coordinates.map(coordinate => observations
    .map((observation, index) => coordinateAffectsObservation(coordinate, observation) ? index : -1)
    .filter(index => index >= 0));
  const observationNll = observations.map(observation => distributionForPrepared(observation, params).negativeLogLikelihood);
  let logStep = POWERWALK_FIT_INITIAL_LOG_STEP;
  let converged = false;
  const trace: Array<{ sweep: number; logStep: number; acceptedMoves: number; fitTotalNegativeLogLikelihood: number }> = [];

  for (let sweep = 1; sweep <= maximumSweeps; sweep++) {
    let acceptedMoves = 0;
    for (let coordinateIndex = 0; coordinateIndex < coordinates.length; coordinateIndex++) {
      const coordinate = coordinates[coordinateIndex]!;
      const indexes = affected[coordinateIndex] ?? [];
      if (indexes.length === 0) continue;
      const currentValue = powerWalkParameter(params, coordinate);
      const currentTheta = powerWalkParameterTransform(coordinate.kind, currentValue);
      const thetaBounds = powerWalkTransformBounds(coordinate.kind);
      const trialThetas = [
        clamp(currentTheta - logStep, thetaBounds.minimum, thetaBounds.maximum),
        clamp(currentTheta + logStep, thetaBounds.minimum, thetaBounds.maximum)
      ].filter((theta, index, all) => Math.abs(theta - currentTheta) > 1e-15 && all.findIndex(value => Math.abs(value - theta) <= 1e-15) === index);
      const affectedIndexes = new Set(indexes);
      const unaffectedNll = observationNll.reduce((sum, value, index) => affectedIndexes.has(index) ? sum : sum + value, 0);
      let bestTheta = currentTheta;
      let bestTotal = observationNll.reduce((sum, value) => sum + value, 0);
      let bestAffectedNll: number[] | undefined;
      for (const trialTheta of trialThetas) {
        setPowerWalkParameter(params, coordinate, inversePowerWalkParameterTransform(coordinate.kind, trialTheta));
        const trialAffectedNll = indexes.map(index => distributionForPrepared(observations[index]!, params).negativeLogLikelihood);
        const trialTotal = unaffectedNll + trialAffectedNll.reduce((sum, value) => sum + value, 0);
        if (trialTotal < bestTotal - 1e-12) {
          bestTheta = trialTheta;
          bestTotal = trialTotal;
          bestAffectedNll = trialAffectedNll;
        }
      }
      if (bestAffectedNll) {
        setPowerWalkParameter(params, coordinate, inversePowerWalkParameterTransform(coordinate.kind, bestTheta));
        indexes.forEach((index, offset) => { observationNll[index] = bestAffectedNll![offset]!; });
        acceptedMoves++;
      } else {
        setPowerWalkParameter(params, coordinate, currentValue);
      }
    }
    trace.push({
      sweep,
      logStep,
      acceptedMoves,
      fitTotalNegativeLogLikelihood: observationNll.reduce((sum, value) => sum + value, 0)
    });
    if (acceptedMoves === 0) {
      logStep /= 2;
      if (logStep < POWERWALK_FIT_MINIMUM_LOG_STEP) {
        converged = true;
        break;
      }
    }
  }
  return { params, converged, finalLogStep: logStep, trace };
}

function coordinateAffectsObservation(coordinate: PowerWalkFitCoordinate, observation: PreparedPowerWalkObservation): boolean {
  if (coordinate.kind === "p") return coordinate.typePair === observation.returnTypePair && observation.candidates.some(candidate => candidate.distance === 0);
  if (coordinate.kind === "q") return observation.candidates.some(candidate => candidate.distance === 2 && candidate.typePair === coordinate.typePair);
  return observation.candidates.some(candidate => candidate.ageDays > 0 && candidate.typePair === coordinate.typePair);
}

function distributionForPrepared(observation: PreparedPowerWalkObservation, params: PowerWalkParams): PowerWalkTransitionDistribution {
  const weighted = observation.candidates.map(candidate => ({ candidate, logWeight: powerWalkCandidateLogWeight(observation, candidate, params) }));
  const finiteWeights = weighted.map(row => row.logWeight).filter(Number.isFinite);
  if (finiteWeights.length === 0) throw new Error(`PowerWalk observation ${observation.observation.id} has no positive-mass candidates`);
  const maximum = Math.max(...finiteWeights);
  const scaledTotal = weighted.reduce((sum, row) => sum + (Number.isFinite(row.logWeight) ? Math.exp(row.logWeight - maximum) : 0), 0);
  const logNormalizer = maximum + Math.log(scaledTotal);
  const selected = weighted.find(row => row.candidate.selected);
  if (!selected || !Number.isFinite(selected.logWeight)) throw new Error(`PowerWalk observation ${observation.observation.id} selected candidate has zero model mass`);
  const logLikelihood = selected.logWeight - logNormalizer;
  return {
    observationId: observation.observation.id,
    selectedEdgeId: observation.observation.selectedEdgeId,
    selectedProbability: Math.exp(logLikelihood),
    logLikelihood,
    negativeLogLikelihood: -logLikelihood,
    candidates: weighted.map(row => ({
      edgeId: row.candidate.edgeId,
      probability: Number.isFinite(row.logWeight) ? Math.exp(row.logWeight - logNormalizer) : 0,
      logWeight: Number.isFinite(row.logWeight) ? row.logWeight : null,
      selected: row.candidate.selected
    }))
  };
}

function powerWalkCandidateLogWeight(
  observation: PreparedPowerWalkObservation,
  candidate: PreparedPowerWalkCandidate,
  params: PowerWalkParams
): number {
  const alphaWeight = candidate.edgeWeight * candidate.edgeAlpha;
  if (!(alphaWeight > 0)) return Number.NEGATIVE_INFINITY;
  let value = Math.log(alphaWeight);
  if (candidate.distance === 0) value -= Math.log(powerWalkParameter(params, { kind: "p", typePair: observation.returnTypePair }));
  if (candidate.distance === 2) value -= Math.log(powerWalkParameter(params, { kind: "q", typePair: candidate.typePair }));
  value -= powerWalkParameter(params, { kind: "lambda", typePair: candidate.typePair }) * candidate.ageDays;
  return value;
}

function summarizePowerWalkLikelihood(
  observations: readonly PreparedPowerWalkObservation[],
  params: PowerWalkParams
): PowerWalkLikelihoodSummary {
  const rows = observations.map(observation => ({ observation, distribution: distributionForPrepared(observation, params) }));
  const totalNegativeLogLikelihood = rows.reduce((sum, row) => sum + row.distribution.negativeLogLikelihood, 0);
  return {
    observationCount: rows.length,
    informativeObservationCount: informativeObservationCount(observations),
    totalLogLikelihood: -totalNegativeLogLikelihood,
    totalNegativeLogLikelihood,
    meanNegativeLogLikelihood: rows.length > 0 ? totalNegativeLogLikelihood / rows.length : 0,
    observations: rows.map(row => ({
      observationId: row.observation.observation.id,
      sourceRecordId: row.observation.observation.sourceRecordId,
      selectedEdgeId: row.distribution.selectedEdgeId,
      selectedProbability: row.distribution.selectedProbability,
      logLikelihood: row.distribution.logLikelihood,
      negativeLogLikelihood: row.distribution.negativeLogLikelihood,
      candidates: row.distribution.candidates
    }))
  };
}

function informativeObservationCount(observations: readonly PreparedPowerWalkObservation[]): number {
  return observations.filter(observation => observation.candidates.filter(candidate => candidate.edgeWeight * candidate.edgeAlpha > 0).length >= 2).length;
}

function parameterAuditRows(
  coordinates: readonly PowerWalkFitCoordinate[],
  initialized: PowerWalkParams,
  fitted: PowerWalkParams,
  published: PowerWalkParams
): PowerWalkParameterFitAudit["parameters"] {
  return coordinates.map(coordinate => ({
    kind: coordinate.kind,
    typePair: coordinate.typePair,
    initialized: powerWalkParameter(initialized, coordinate),
    fittedCandidate: powerWalkParameter(fitted, coordinate),
    published: powerWalkParameter(published, coordinate)
  }));
}

function powerWalkParameter(params: PowerWalkParams, coordinate: PowerWalkFitCoordinate): number {
  if (coordinate.kind === "p") return params.p.get(coordinate.typePair) ?? POWERWALK_DEFAULT_P;
  if (coordinate.kind === "q") return params.q.get(coordinate.typePair) ?? POWERWALK_DEFAULT_Q;
  return params.lambda.get(coordinate.typePair) ?? POWERWALK_DEFAULT_LAMBDA;
}

function setPowerWalkParameter(params: PowerWalkParams, coordinate: PowerWalkFitCoordinate, value: number): void {
  if (coordinate.kind === "p") params.p.set(coordinate.typePair, clamp(value, POWERWALK_PARAMETER_BOUNDS.p.minimum, POWERWALK_PARAMETER_BOUNDS.p.maximum));
  else if (coordinate.kind === "q") params.q.set(coordinate.typePair, clamp(value, POWERWALK_PARAMETER_BOUNDS.q.minimum, POWERWALK_PARAMETER_BOUNDS.q.maximum));
  else params.lambda.set(coordinate.typePair, clamp(value, POWERWALK_PARAMETER_BOUNDS.lambda.minimum, POWERWALK_PARAMETER_BOUNDS.lambda.maximum));
}

function powerWalkParameterTransform(kind: PowerWalkFitCoordinate["kind"], value: number): number {
  return Math.log(kind === "lambda" ? value + POWERWALK_PARAMETER_BOUNDS.lambda.logOffset : value);
}

function inversePowerWalkParameterTransform(kind: PowerWalkFitCoordinate["kind"], theta: number): number {
  const value = Math.exp(theta);
  return kind === "lambda" ? Math.max(0, value - POWERWALK_PARAMETER_BOUNDS.lambda.logOffset) : value;
}

function powerWalkTransformBounds(kind: PowerWalkFitCoordinate["kind"]): { minimum: number; maximum: number } {
  if (kind === "p") return { minimum: Math.log(POWERWALK_PARAMETER_BOUNDS.p.minimum), maximum: Math.log(POWERWALK_PARAMETER_BOUNDS.p.maximum) };
  if (kind === "q") return { minimum: Math.log(POWERWALK_PARAMETER_BOUNDS.q.minimum), maximum: Math.log(POWERWALK_PARAMETER_BOUNDS.q.maximum) };
  return {
    minimum: Math.log(POWERWALK_PARAMETER_BOUNDS.lambda.minimum + POWERWALK_PARAMETER_BOUNDS.lambda.logOffset),
    maximum: Math.log(POWERWALK_PARAMETER_BOUNDS.lambda.maximum + POWERWALK_PARAMETER_BOUNDS.lambda.logOffset)
  };
}

function clonePowerWalkParameters(params: PowerWalkParams): PowerWalkParams {
  return { p: new Map(params.p), q: new Map(params.q), lambda: new Map(params.lambda), epsilon: params.epsilon, ...(params.audit === undefined ? {} : { audit: params.audit }) };
}

function powerWalkFitInputAudit(sourceAudit: JsonValue | undefined): JsonValue {
  return toJsonValue({
    schema: "scce.powerwalk_parameter_fit_input.v1",
    parameterRole: "initialized_fit_input",
    fitted: false,
    active: false,
    claimBoundary: "input_parameters_before_this_fit",
    sourceAudit: sourceAudit ?? null
  });
}

function powerWalkFittedCandidateAudit(audit: PowerWalkParameterFitAudit, optimizerRan: boolean): JsonValue {
  return toJsonValue({
    schema: "scce.powerwalk_parameter_fit_candidate.v1",
    parameterRole: "optimizer_fit_candidate",
    fitted: optimizerRan,
    active: false,
    acceptedForActivation: audit.accepted,
    status: audit.status,
    datasetHash: audit.datasetHash,
    splitHash: audit.split.splitHash,
    optimizer: {
      coordinateCount: audit.optimizer.coordinateCount,
      sweepsCompleted: audit.optimizer.sweepsCompleted,
      converged: audit.optimizer.converged
    },
    likelihood: {
      fitMeanNllImprovement: audit.likelihood.fitMeanNllImprovement,
      heldOutMeanNllImprovement: audit.likelihood.heldOutMeanNllImprovement
    },
    claimBoundary: audit.claimBoundary
  });
}

function runtimePowerWalkFitKey(
  observations: readonly PowerWalkTransitionObservation[],
  initialized: PowerWalkParams,
  fitOptions: PowerWalkParameterFitOptions | undefined,
  hasher: Hasher
): string {
  const entries = (map: ReadonlyMap<string, number>) => [...map.entries()].sort(([left], [right]) => compareOrdinal(left, right));
  return hasher.digestHex(canonicalStringify({
    observations,
    initialized: {
      p: entries(initialized.p),
      q: entries(initialized.q),
      lambda: entries(initialized.lambda),
      epsilon: initialized.epsilon
    },
    fitOptions: fitOptions ?? null
  }));
}

function mergeRuntimeTransitionObservations(
  existing: readonly PowerWalkTransitionObservation[],
  incoming: readonly PowerWalkTransitionObservation[]
): PowerWalkTransitionObservation[] {
  const byId = new Map<string, PowerWalkTransitionObservation>();
  for (const observation of [...existing, ...incoming]) byId.set(observation.id, observation);
  const newest = [...byId.values()].sort((left, right) => right.observedAt - left.observedAt || compareOrdinal(left.id, right.id));
  const bounded: PowerWalkTransitionObservation[] = [];
  let candidateCount = 0;
  for (const observation of newest) {
    if (bounded.length >= POWERWALK_FIT_MAXIMUM_OBSERVATIONS) break;
    if (candidateCount + observation.candidates.length > POWERWALK_FIT_MAXIMUM_TOTAL_CANDIDATES) continue;
    bounded.push(observation);
    candidateCount += observation.candidates.length;
  }
  return bounded.sort((left, right) => compareOrdinal(left.id, right.id));
}

function validateFitInitialParameters(params: PowerWalkParams): void {
  assertFinitePositive(params.epsilon, "epsilon");
  validateParameterMap(params.p, "p", POWERWALK_PARAMETER_BOUNDS.p.minimum, POWERWALK_PARAMETER_BOUNDS.p.maximum);
  validateParameterMap(params.q, "q", POWERWALK_PARAMETER_BOUNDS.q.minimum, POWERWALK_PARAMETER_BOUNDS.q.maximum);
  validateParameterMap(params.lambda, "lambda", POWERWALK_PARAMETER_BOUNDS.lambda.minimum, POWERWALK_PARAMETER_BOUNDS.lambda.maximum);
}

function validateParameterMap(map: ReadonlyMap<string, number>, label: string, minimum: number, maximum: number): void {
  for (const [key, value] of map) {
    requiredPowerWalkText(key, `${label} type-pair key`);
    if (!Number.isFinite(value) || value < minimum || value > maximum) {
      throw new Error(`PowerWalk ${label}[${key}] must be finite and within [${minimum},${maximum}]`);
    }
  }
}

function requiredPowerWalkText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`PowerWalk ${label} must be a non-empty string`);
  return value;
}

function boundedFitInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`PowerWalk ${label} must be an integer within [${minimum},${maximum}]`);
  }
  return value;
}

export function powerWalkTransitionProbability(input: {
  previous?: GraphNode;
  current: GraphNode;
  candidate: GraphNode;
  edge: GraphEdge;
  allEdges: readonly GraphEdge[];
  params: PowerWalkParams;
  now?: number;
}): { unnormalized: number; bias: number; decay: number; alphaWeight: number; distance: 0 | 1 | 2; typePair: string } {
  assertFiniteNonnegative(input.edge.weight, "edge.weight");
  assertFiniteNonnegative(input.edge.alpha, "edge.alpha");
  if (!Number.isFinite(input.edge.updatedAt)) throw new Error("PowerWalk edge.updatedAt must be finite");
  if (input.now !== undefined && !Number.isFinite(input.now)) throw new Error("PowerWalk now must be finite");
  const typePair = `${input.current.typeId}->${input.candidate.typeId}`;
  const pKey = `${input.previous?.typeId ?? input.current.typeId}->${input.current.typeId}`;
  const distance = node2vecDistance(input.previous?.id, input.candidate.id, input.allEdges);
  const p = input.params.p.get(pKey) ?? 1;
  const q = input.params.q.get(typePair) ?? 1;
  assertFinitePositive(p, `p[${pKey}]`);
  assertFinitePositive(q, `q[${typePair}]`);
  const lambda = input.params.lambda.get(typePair) ?? 0.01;
  assertFiniteNonnegative(lambda, `lambda[${typePair}]`);
  const bias = distance === 0 ? 1 / p : distance === 1 ? 1 : 1 / q;
  const ageDays = Math.max(0, (input.now ?? graphSnapshotTime(input.allEdges)) - input.edge.updatedAt) / (1000 * 60 * 60 * 24);
  const decay = Math.exp(-lambda * ageDays);
  const alphaWeight = input.edge.weight * input.edge.alpha;
  return { unnormalized: Math.max(0, alphaWeight * bias * decay), bias, decay, alphaWeight, distance, typePair };
}

function transitionMatrix(nodes: readonly GraphNode[], edges: readonly GraphEdge[], params: PowerWalkParams, now: number): number[][] {
  const index = new Map(nodes.map((node, i) => [node.id, i]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const matrix = zeros(nodes.length, nodes.length);
  for (const edge of edges) {
    const i = index.get(edge.source);
    const j = index.get(edge.target);
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (i === undefined || j === undefined || !source || !target) continue;
    const key = `${source.typeId}->${target.typeId}`;
    const decay = Math.exp(-(params.lambda.get(key) ?? 0.01) * Math.max(0, now - edge.updatedAt) / (1000 * 60 * 60 * 24));
    matrix[i]![j] = (matrix[i]![j] ?? 0) + edge.weight * edge.alpha * decay;
  }
  return matrix.map(row => normalizeVector(row, 0));
}

export function typeConditionalTransitionMatrix(nodes: readonly GraphNode[], edges: readonly GraphEdge[], params: PowerWalkParams, sourceType: string, targetType: string, now = graphSnapshotTime(edges)): number[][] {
  const pairNodes = nodes.filter(node => String(node.typeId) === sourceType || String(node.typeId) === targetType);
  const index = new Map(pairNodes.map((node, i) => [node.id, i]));
  const byId = new Map(nodes.map(node => [node.id, node]));
  const matrix = zeros(pairNodes.length, pairNodes.length);
  for (const edge of edges) {
    const source = byId.get(edge.source);
    const target = byId.get(edge.target);
    if (!source || !target || String(source.typeId) !== sourceType || String(target.typeId) !== targetType) continue;
    const i = index.get(edge.source);
    const j = index.get(edge.target);
    if (i === undefined || j === undefined) continue;
    const typePair = powerWalkTypePairKey(source, target);
    const decay = Math.exp(-(params.lambda.get(typePair) ?? 0.01) * ageDays(edge, now));
    matrix[i]![j] = (matrix[i]![j] ?? 0) + edge.weight * edge.alpha * decay;
  }
  return matrix.map(row => normalizeVector(row, 0));
}

function walkFrom(
  start: NodeId,
  byId: Map<NodeId, GraphNode>,
  neighbor: Map<NodeId, GraphEdge[]>,
  allEdges: readonly GraphEdge[],
  params: PowerWalkParams,
  length: number,
  hasher: Hasher,
  now: number,
  seed: string,
  walkIndex: number
): { walk: NodeId[]; audit: PowerWalkResult["transitionAudit"] } {
  const walk = [start];
  const audit: PowerWalkResult["transitionAudit"] = [];
  let previous: NodeId | undefined;
  let current = start;
  for (let step = 1; step < length; step++) {
    const edges = neighbor.get(current) ?? [];
    if (edges.length === 0) break;
    const currentNode = byId.get(current);
    if (!currentNode) break;
    const previousNode = previous ? byId.get(previous) : undefined;
    const weighted = edges.map(edge => {
      const dest = byId.get(edge.target);
      if (!dest) return { edge, weight: 0, transition: undefined };
      const transition = powerWalkTransitionProbability({ previous: previousNode, current: currentNode, candidate: dest, edge, allEdges, params, now });
      return { edge, weight: transition.unnormalized, transition };
    });
    const selected = deterministicWeightedChoice(weighted, `${seed}:${start}:${walkIndex}:${current}:${step}`, hasher);
    const total = weighted.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
    for (const item of weighted) {
      if (!item.transition) continue;
      audit.push({
        start,
        walkIndex,
        step,
        from: current,
        to: item.edge.target,
        ...(previous ? { previous } : {}),
        edgeId: String(item.edge.id),
        selected: selected?.id === item.edge.id,
        typePair: item.transition.typePair,
        observedAt: now,
        currentTypeId: String(currentNode.typeId),
        targetTypeId: String(byId.get(item.edge.target)!.typeId),
        ...(previousNode ? { previousTypeId: String(previousNode.typeId) } : {}),
        distance: item.transition.distance,
        edgeWeight: item.edge.weight,
        edgeAlpha: item.edge.alpha,
        edgeUpdatedAt: item.edge.updatedAt,
        provenanceRecordIds: [...new Set(item.edge.evidenceIds.map(String))].sort().slice(0, 16),
        probability: total > 0 ? Math.max(0, item.weight) / total : 0,
        bias: item.transition.bias,
        decay: item.transition.decay,
        alphaWeight: item.transition.alphaWeight
      });
    }
    if (!selected) break;
    previous = current;
    current = selected.target;
    walk.push(current);
  }
  return { walk, audit };
}

function node2vecDistance(previous: NodeId | undefined, candidate: NodeId, edges: readonly GraphEdge[]): 0 | 1 | 2 {
  if (!previous) return 1;
  if (previous === candidate) return 0;
  return edges.some(edge => (edge.source === previous && edge.target === candidate) || (edge.source === candidate && edge.target === previous)) ? 1 : 2;
}

function deterministicWeightedChoice(items: Array<{ edge: GraphEdge; weight: number }>, salt: string, hasher: Hasher): GraphEdge | undefined {
  const total = items.reduce((sum, item) => sum + Math.max(0, item.weight), 0);
  if (total <= 0) return undefined;
  const h = Number.parseInt(hasher.digestHex(salt).slice(0, 12), 16) / 0xffffffffffff;
  let cursor = h * total;
  for (const item of items) {
    cursor -= Math.max(0, item.weight);
    if (cursor <= 0) return item.edge;
  }
  return items[items.length - 1]?.edge;
}

function walkLengthsByType(nodes: readonly GraphNode[], edges: readonly GraphEdge[], transition: number[][], epsilon: number): PowerWalkLengthDiagnostic[] {
  const types = [...new Set(nodes.map(node => String(node.typeId)))].sort();
  const out: PowerWalkLengthDiagnostic[] = [];
  for (const a of types) {
    for (const b of types) {
      const indices = nodes.map((node, i) => ({ node, i })).filter(item => String(item.node.typeId) === a || String(item.node.typeId) === b).map(item => item.i);
      const sub = indices.map(i => indices.map(j => transition[i]?.[j] ?? 0));
      const pairEdges = edges.filter(edge => {
        const s = nodes.find(node => node.id === edge.source);
        const t = nodes.find(node => node.id === edge.target);
        return s && t && String(s.typeId) === a && String(t.typeId) === b;
      });
      const assessment = assessTransitionForMixingBound(sub);
      const assumptionsHold = pairEdges.length > 0 && assessment.valid;
      const heuristicLength = Math.max(8, Math.min(96, Math.ceil(Math.log(1 / Math.max(1e-9, epsilon)) * Math.sqrt(Math.max(1, sub.length)))));
      out.push({
        typePair: `${a}->${b}`,
        // The executed node2vec walk is second-order over (previous,current)
        // states. A first-order node-chain gap is not a bound for that process.
        spectralGap: 0,
        length: heuristicLength,
        boundKind: "exploration_heuristic",
        rationale: assumptionsHold ? "second_order_transition_bound_not_established" : "bound_assumptions_not_established",
        assumptions: assessment.assumptions
      });
    }
  }
  return out;
}

export function minimumPowerWalkLength(spectralGap: number, epsilon: number): number {
  const gap = Math.max(1e-6, spectralGap);
  return Math.max(1, Math.ceil(Math.log(1 / Math.max(1e-9, epsilon)) / gap));
}

export function powerWalkTypePairKey(source: GraphNode, target: GraphNode): string {
  return `${String(source.typeId)}->${String(target.typeId)}`;
}

function typePairStats(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now: number): TypePairWalkStats[] {
  const byId = new Map(nodes.map(node => [node.id, node]));
  const outDegree = new Map<string, number>();
  for (const edge of edges) outDegree.set(String(edge.source), (outDegree.get(String(edge.source)) ?? 0) + 1);
  const types = [...new Set(nodes.map(node => String(node.typeId)))].sort();
  const stats: TypePairWalkStats[] = [];
  for (const sourceType of types) {
    for (const targetType of types) {
      const pairEdges = edges.filter(edge => {
        const s = byId.get(edge.source);
        const t = byId.get(edge.target);
        return s && t && String(s.typeId) === sourceType && String(t.typeId) === targetType;
      });
      const ages = pairEdges.map(edge => ageDays(edge, now));
      const weights = pairEdges.map(edge => edge.weight * edge.alpha);
      const sourceDegrees = nodes.filter(node => String(node.typeId) === sourceType).map(node => outDegree.get(String(node.id)) ?? 0);
      const targetDegrees = nodes.filter(node => String(node.typeId) === targetType).map(node => outDegree.get(String(node.id)) ?? 0);
      const meanOutDegree = mean(sourceDegrees);
      const temporalHalfLifeDays = halfLifeFromAges(ages, pairEdges.length);
      const lambda = Math.log(2) / Math.max(1e-6, temporalHalfLifeDays);
      const degreeRatio = (mean(targetDegrees) + 1) / (meanOutDegree + 1);
      const density = pairEdges.length / Math.max(1, sourceDegrees.length * Math.max(1, targetDegrees.length));
      const p = clamp(0.35 + degreeRatio, 0.25, 4);
      const q = clamp(2.2 - 1.4 * density + 0.4 * Math.sqrt(Math.max(0, variance(targetDegrees))), 0.25, 4);
      stats.push({
        typePair: `${sourceType}->${targetType}`,
        edges: pairEdges.length,
        meanAgeDays: mean(ages),
        ageVariance: variance(ages),
        meanAlphaWeight: mean(weights),
        meanOutDegree,
        temporalHalfLifeDays,
        p,
        q,
        lambda
      });
    }
  }
  return stats;
}

function halfLifeFromAges(ages: readonly number[], edgeCount: number): number {
  if (edgeCount === 0) return 30;
  const m = mean(ages);
  const spread = Math.sqrt(variance(ages));
  return clamp(1 + 0.55 * m + 0.45 * spread, 1, 180);
}

function ageDays(edge: GraphEdge, now: number): number {
  return Math.max(0, now - edge.updatedAt) / (1000 * 60 * 60 * 24);
}

function graphSnapshotTime(edges: readonly GraphEdge[]): number {
  return edges.reduce((latest, edge) => Math.max(latest, edge.updatedAt), 0);
}

function walkCooccurrence(walks: readonly NodeId[][], window: number): PowerWalkResult["cooccurrence"] {
  const counts = new Map<string, { nodeId: NodeId; contextNodeId: NodeId; count: number; distanceSum: number }>();
  for (const walk of walks) {
    for (let i = 0; i < walk.length; i++) {
      const nodeId = walk[i]!;
      for (let j = Math.max(0, i - window); j <= Math.min(walk.length - 1, i + window); j++) {
        if (i === j) continue;
        const contextNodeId = walk[j]!;
        const distance = Math.abs(i - j);
        const key = `${nodeId}\u001f${contextNodeId}`;
        const current = counts.get(key) ?? { nodeId, contextNodeId, count: 0, distanceSum: 0 };
        current.count++;
        current.distanceSum += distance;
        counts.set(key, current);
      }
    }
  }
  const maxCount = Math.max(1, ...[...counts.values()].map(row => row.count));
  return [...counts.values()]
    .map(row => ({ nodeId: row.nodeId, contextNodeId: row.contextNodeId, count: row.count, distanceMean: row.distanceSum / Math.max(1, row.count), weight: clamp01((row.count / maxCount) * (1 / Math.max(1, row.distanceSum / Math.max(1, row.count)))) }))
    .sort((a, b) => b.weight - a.weight || compareOrdinal(String(a.nodeId), String(b.nodeId)));
}

export function typePairSpectralGaps(nodes: readonly GraphNode[], edges: readonly GraphEdge[], params: PowerWalkParams): Array<{
  typePair: string;
  spectralGap: number;
  eigenvalues: number[];
  boundKind: "reversible_absolute_spectral_bound" | "unavailable";
  assumptions: PowerWalkLengthDiagnostic["assumptions"];
}> {
  const types = [...new Set(nodes.map(node => String(node.typeId)))].sort();
  const out: Array<{
    typePair: string;
    spectralGap: number;
    eigenvalues: number[];
    boundKind: "reversible_absolute_spectral_bound" | "unavailable";
    assumptions: PowerWalkLengthDiagnostic["assumptions"];
  }> = [];
  for (const sourceType of types) {
    for (const targetType of types) {
      const matrix = typeConditionalTransitionMatrix(nodes, edges, params, sourceType, targetType);
      const assessment = assessTransitionForMixingBound(matrix);
      out.push({
        typePair: `${sourceType}->${targetType}`,
        spectralGap: assessment.valid ? assessment.spectralGap : 0,
        eigenvalues: assessment.valid ? assessment.eigenvalues.slice(0, 12) : [],
        boundKind: assessment.valid ? "reversible_absolute_spectral_bound" : "unavailable",
        assumptions: assessment.assumptions
      });
    }
  }
  return out;
}

interface TransitionMixingAssessment {
  valid: boolean;
  spectralGap: number;
  eigenvalues: number[];
  minimumStationaryMass: number;
  assumptions: PowerWalkLengthDiagnostic["assumptions"];
}

/**
 * A spectral mixing bound is reported only for a finite, row-stochastic,
 * irreducible, aperiodic, reversible chain. Directed or substochastic slices
 * still receive an exploration length, but no theorem-backed mixing claim.
 */
function assessTransitionForMixingBound(matrix: readonly (readonly number[])[]): TransitionMixingAssessment {
  const size = matrix.length;
  const rowStochastic = size > 0 && matrix.every(row => {
    if (row.length !== size || row.some(value => !Number.isFinite(value) || value < -1e-12)) return false;
    return Math.abs(row.reduce((sum, value) => sum + value, 0) - 1) <= 1e-9;
  });
  const irreducible = rowStochastic && isStronglyConnected(matrix);
  const aperiodic = irreducible && transitionPeriod(matrix) === 1;
  const stationary = rowStochastic ? stationaryDistribution(matrix) : [];
  const reversible = irreducible && stationary.length === size && detailedBalanceHolds(matrix, stationary);
  const assumptions = { rowStochastic, irreducible, aperiodic, reversible };
  if (!rowStochastic || !irreducible || !aperiodic || !reversible) {
    return { valid: false, spectralGap: 0, eigenvalues: [], minimumStationaryMass: 0, assumptions };
  }
  if (size === 1) {
    return { valid: true, spectralGap: 1, eigenvalues: [1], minimumStationaryMass: 1, assumptions };
  }
  const discriminant = matrix.map((row, i) => row.map((value, j) => {
    const piI = stationary[i] ?? 0;
    const piJ = stationary[j] ?? 0;
    if (piI <= 0 || piJ <= 0) return 0;
    return value * Math.sqrt(piI / piJ);
  }));
  const symmetric = discriminant.map((row, i) => row.map((value, j) => 0.5 * (value + (discriminant[j]?.[i] ?? 0))));
  const eigenvalues = jacobiEigenvaluesSymmetric(symmetric, 120).sort((a, b) => Math.abs(b) - Math.abs(a));
  const secondMagnitude = Math.abs(eigenvalues[1] ?? 0);
  const spectralGap = Math.max(0, 1 - secondMagnitude);
  return {
    valid: spectralGap > 1e-12,
    spectralGap,
    eigenvalues,
    minimumStationaryMass: Math.min(...stationary),
    assumptions
  };
}

function stationaryDistribution(matrix: readonly (readonly number[])[]): number[] {
  if (matrix.length === 0) return [];
  let current = new Array<number>(matrix.length).fill(1 / matrix.length);
  for (let iteration = 0; iteration < 10_000; iteration++) {
    const next = new Array<number>(matrix.length).fill(0);
    for (let i = 0; i < matrix.length; i++) {
      for (let j = 0; j < matrix.length; j++) next[j] = (next[j] ?? 0) + (current[i] ?? 0) * (matrix[i]?.[j] ?? 0);
    }
    const residual = next.reduce((sum, value, index) => sum + Math.abs(value - (current[index] ?? 0)), 0);
    current = next;
    if (residual <= 1e-13) break;
  }
  return current;
}

function detailedBalanceHolds(matrix: readonly (readonly number[])[], stationary: readonly number[]): boolean {
  if (stationary.some(value => !(value > 0) || !Number.isFinite(value))) return false;
  for (let i = 0; i < matrix.length; i++) {
    for (let j = i + 1; j < matrix.length; j++) {
      const forward = (stationary[i] ?? 0) * (matrix[i]?.[j] ?? 0);
      const reverse = (stationary[j] ?? 0) * (matrix[j]?.[i] ?? 0);
      if (Math.abs(forward - reverse) > 1e-8 * Math.max(1, Math.abs(forward), Math.abs(reverse))) return false;
    }
  }
  return true;
}

function isStronglyConnected(matrix: readonly (readonly number[])[]): boolean {
  if (matrix.length === 0) return false;
  const forward = reachable(matrix, false);
  const reverse = reachable(matrix, true);
  return forward.size === matrix.length && reverse.size === matrix.length;
}

function reachable(matrix: readonly (readonly number[])[], reverse: boolean): Set<number> {
  const seen = new Set<number>([0]);
  const stack = [0];
  while (stack.length) {
    const current = stack.pop()!;
    for (let candidate = 0; candidate < matrix.length; candidate++) {
      const probability = reverse ? (matrix[candidate]?.[current] ?? 0) : (matrix[current]?.[candidate] ?? 0);
      if (probability > 0 && !seen.has(candidate)) {
        seen.add(candidate);
        stack.push(candidate);
      }
    }
  }
  return seen;
}

function transitionPeriod(matrix: readonly (readonly number[])[]): number {
  if (matrix.length === 0) return 0;
  const distance = new Array<number>(matrix.length).fill(-1);
  distance[0] = 0;
  const queue = [0];
  for (let cursor = 0; cursor < queue.length; cursor++) {
    const current = queue[cursor]!;
    for (let candidate = 0; candidate < matrix.length; candidate++) {
      if ((matrix[current]?.[candidate] ?? 0) <= 0 || (distance[candidate] ?? -1) >= 0) continue;
      distance[candidate] = (distance[current] ?? 0) + 1;
      queue.push(candidate);
    }
  }
  let period = 0;
  for (let from = 0; from < matrix.length; from++) {
    for (let to = 0; to < matrix.length; to++) {
      if ((matrix[from]?.[to] ?? 0) <= 0) continue;
      period = greatestCommonDivisor(period, Math.abs((distance[from] ?? 0) + 1 - (distance[to] ?? 0)));
    }
  }
  return period;
}

function greatestCommonDivisor(left: number, right: number): number {
  let a = Math.abs(Math.trunc(left));
  let b = Math.abs(Math.trunc(right));
  while (b !== 0) [a, b] = [b, a % b];
  return a;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampInteger(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(Number.isFinite(value) ? value : min)));
}

function hasLearnedContext(vector: readonly number[]): boolean {
  return vector.length > 0 && vector.some(value => Number.isFinite(value) && value !== 0);
}

function compareNodes(left: GraphNode, right: GraphNode): number {
  return compareOrdinal(String(left.id), String(right.id));
}

function compareEdges(left: GraphEdge, right: GraphEdge): number {
  return compareOrdinal(String(left.source), String(right.source))
    || compareOrdinal(String(left.target), String(right.target))
    || compareOrdinal(String(left.id), String(right.id));
}

function compareOrdinal(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePowerWalkInputs(nodes: readonly GraphNode[], edges: readonly GraphEdge[], now: number): void {
  if (!Number.isFinite(now)) throw new Error("PowerWalk snapshot time must be finite");
  const nodeIds = new Set<string>();
  for (const node of nodes) {
    const id = String(node.id);
    if (nodeIds.has(id)) throw new Error(`PowerWalk node id is duplicated: ${id}`);
    nodeIds.add(id);
  }
  for (const edge of edges) {
    assertFiniteNonnegative(edge.weight, `edge ${String(edge.id)} weight`);
    assertFiniteNonnegative(edge.alpha, `edge ${String(edge.id)} alpha`);
    if (!Number.isFinite(edge.updatedAt)) throw new Error(`PowerWalk edge ${String(edge.id)} updatedAt must be finite`);
  }
}

function assertFinitePositive(value: number, label: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`PowerWalk ${label} must be finite and positive`);
}

function assertFiniteNonnegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`PowerWalk ${label} must be finite and non-negative`);
}
