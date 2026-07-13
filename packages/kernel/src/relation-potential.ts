import { canonicalStringify, createHasher } from "./primitives.js";
import type { GraphEdge } from "./types.js";

export const RELATION_POTENTIAL_FEATURES = [
  "compatibility",
  "provenance",
  "temporalFit",
  "modalityAgreement",
  "recurrence",
  "utility",
  "sourceAgreement",
  "contradiction"
] as const;

export type RelationPotentialFeatureId = (typeof RELATION_POTENTIAL_FEATURES)[number];
export type RelationPotentialFeatures = Readonly<Record<RelationPotentialFeatureId, number>>;

export interface RelationPotentialExample {
  readonly id: string;
  readonly features: RelationPotentialFeatures;
  readonly label: 0 | 1;
}

export interface RelationPotentialFitOptions {
  readonly iterations?: number;
  readonly learningRate?: number;
  readonly l2?: number;
}

export interface RelationPotentialFitDatasets {
  /** Examples used only to fit the constrained relation coefficients. */
  readonly coefficientTraining: readonly RelationPotentialExample[];
  /** Examples used only to fit the Platt slope and intercept. */
  readonly calibrationFit: readonly RelationPotentialExample[];
  /** Examples used only to report post-fit calibration metrics. */
  readonly evaluationHoldout: readonly RelationPotentialExample[];
}

export interface RelationPotentialModel {
  readonly schema: "scce.relation_potential.v2";
  readonly modelId: string;
  readonly datasetHash: string;
  readonly sampleCounts: {
    readonly coefficientTrainingCount: number;
    readonly calibrationFitCount: number;
    readonly evaluationHoldoutCount: number;
  };
  readonly coefficients: Readonly<Record<Exclude<RelationPotentialFeatureId, "contradiction">, number>>;
  readonly contradictionCoefficient: number;
  readonly intercept: number;
  readonly calibration: {
    readonly method: "platt";
    readonly slope: number;
    readonly intercept: number;
    /** Brier score measured only on evaluationHoldout after all fitting. */
    readonly holdoutBrier: number;
    /** Expected calibration error measured only on evaluationHoldout after all fitting. */
    readonly holdoutEce: number;
  };
}

export interface RelationPotentialScore {
  readonly rawLogit: number;
  readonly uncalibrated: number;
  readonly calibrated: number;
  readonly modelId: string;
}

export const RELATION_POTENTIAL_PROJECTION_SCHEMA = "scce.graph_edge_relation_features.v1" as const;

export interface RelationPotentialProjectionAudit {
  readonly schema: typeof RELATION_POTENTIAL_PROJECTION_SCHEMA;
  readonly edgeId: string;
  readonly relationId: string;
  readonly snapshotTime: number;
  readonly sameRelationEndpointCount: number;
  readonly distinctSupportingEvidenceCount: number;
  readonly featureSources: Readonly<Record<RelationPotentialFeatureId, string>>;
  readonly features: RelationPotentialFeatures;
}

export interface RelationPotentialEdgeScoreAudit extends RelationPotentialProjectionAudit {
  readonly modelId: string;
  readonly rawLogit: number;
  readonly uncalibrated: number;
  readonly calibrated: number;
  readonly baseTransitionWeight: number;
  readonly scoredTransitionWeight: number;
}

export interface RelationPotentialEdgeScoringResult {
  readonly edges: GraphEdge[];
  readonly audit: readonly RelationPotentialEdgeScoreAudit[];
}

export function fitRelationPotential(
  datasets: RelationPotentialFitDatasets,
  options: RelationPotentialFitOptions = {}
): RelationPotentialModel {
  if (!datasets || typeof datasets !== "object" || Array.isArray(datasets)) throw new TypeError("relation-potential fitting requires named datasets");
  assertExactKeys(datasets as unknown as Record<string, unknown>, ["coefficientTraining", "calibrationFit", "evaluationHoldout"], "relation-potential fitting datasets");
  const { coefficientTraining, calibrationFit, evaluationHoldout } = datasets;
  validateFitDataset(coefficientTraining, "coefficientTraining");
  validateFitDataset(calibrationFit, "calibrationFit");
  validateFitDataset(evaluationHoldout, "evaluationHoldout");
  assertDisjointFitDatasets(datasets);
  const iterations = boundedInteger(options.iterations ?? 800, 1, 100_000, "iterations");
  const learningRate = positiveFinite(options.learningRate ?? 0.08, "learningRate");
  const l2 = nonnegativeFinite(options.l2 ?? 0.001, "l2");
  const positiveFeatures = RELATION_POTENTIAL_FEATURES.filter((name): name is Exclude<RelationPotentialFeatureId, "contradiction"> => name !== "contradiction");
  const weights = Object.fromEntries(positiveFeatures.map(name => [name, 0])) as Record<Exclude<RelationPotentialFeatureId, "contradiction">, number>;
  let contradictionCoefficient = 0;
  let intercept = 0;

  for (let iteration = 0; iteration < iterations; iteration++) {
    const gradients = Object.fromEntries(positiveFeatures.map(name => [name, 0])) as Record<Exclude<RelationPotentialFeatureId, "contradiction">, number>;
    let contradictionGradient = 0;
    let interceptGradient = 0;
    for (const row of coefficientTraining) {
      const error = sigmoid(linear(row.features, weights, contradictionCoefficient, intercept)) - row.label;
      for (const name of positiveFeatures) gradients[name] += error * row.features[name];
      contradictionGradient += error * -row.features.contradiction;
      interceptGradient += error;
    }
    const scale = 1 / coefficientTraining.length;
    for (const name of positiveFeatures) weights[name] = Math.max(0, weights[name] - learningRate * (gradients[name] * scale + l2 * weights[name]));
    contradictionCoefficient = Math.max(0, contradictionCoefficient - learningRate * (contradictionGradient * scale + l2 * contradictionCoefficient));
    intercept -= learningRate * interceptGradient * scale;
  }

  const calibrationFitLogits = calibrationFit.map(row => linear(row.features, weights, contradictionCoefficient, intercept));
  const calibration = fitPlatt(calibrationFitLogits, calibrationFit.map(row => row.label));
  const holdoutLogits = evaluationHoldout.map(row => linear(row.features, weights, contradictionCoefficient, intercept));
  const holdoutProbabilities = holdoutLogits.map(logit => sigmoid(calibration.slope * logit + calibration.intercept));
  const holdoutLabels = evaluationHoldout.map(row => row.label);
  const datasetHash = createHasher().digestHex(canonicalStringify({
    coefficientTraining,
    calibrationFit,
    evaluationHoldout
  }));
  const sampleCounts = Object.freeze({
    coefficientTrainingCount: coefficientTraining.length,
    calibrationFitCount: calibrationFit.length,
    evaluationHoldoutCount: evaluationHoldout.length
  });
  const publishedCalibration = Object.freeze({
    method: "platt" as const,
    slope: calibration.slope,
    intercept: calibration.intercept,
    holdoutBrier: brier(holdoutProbabilities, holdoutLabels),
    holdoutEce: expectedCalibrationError(holdoutProbabilities, holdoutLabels)
  });
  const unsigned = {
    schema: "scce.relation_potential.v2",
    datasetHash,
    sampleCounts,
    coefficients: Object.freeze({ ...weights }),
    contradictionCoefficient,
    intercept,
    calibration: publishedCalibration
  } as const;
  const modelId = relationPotentialModelId(unsigned);
  return freezeRelationPotentialModel({ ...unsigned, modelId });
}

export function scoreRelationPotential(model: RelationPotentialModel, features: RelationPotentialFeatures): RelationPotentialScore {
  assertValidRelationPotentialModel(model);
  return scoreValidatedRelationPotential(model, features);
}

function scoreValidatedRelationPotential(model: RelationPotentialModel, features: RelationPotentialFeatures): RelationPotentialScore {
  validateFeatures(features);
  const rawLogit = linear(features, model.coefficients, model.contradictionCoefficient, model.intercept);
  finite(rawLogit, "relation-potential raw logit");
  return {
    rawLogit,
    uncalibrated: sigmoid(rawLogit),
    calibrated: sigmoid(model.calibration.slope * rawLogit + model.calibration.intercept),
    modelId: model.modelId
  };
}

/**
 * Validate a serialized frozen-inference model. The identifier covers every
 * published coefficient and calibration statistic, so a config edit cannot
 * silently retain the old version identifier.
 */
export function assertValidRelationPotentialModel(model: RelationPotentialModel): void {
  if (!model || typeof model !== "object" || Array.isArray(model)) throw new TypeError("relation-potential model must be an object");
  assertExactKeys(model as unknown as Record<string, unknown>, [
    "schema", "modelId", "datasetHash", "sampleCounts", "coefficients", "contradictionCoefficient", "intercept", "calibration"
  ], "relation-potential model");
  if (model.schema !== "scce.relation_potential.v2") throw new Error("relation-potential model schema must be scce.relation_potential.v2");
  if (!/^[a-f0-9]{64}$/u.test(model.datasetHash)) throw new Error("relation-potential datasetHash must be a lowercase sha256 digest");
  assertExactKeys(model.sampleCounts as unknown as Record<string, unknown>, ["coefficientTrainingCount", "calibrationFitCount", "evaluationHoldoutCount"], "relation-potential sampleCounts");
  boundedInteger(model.sampleCounts.coefficientTrainingCount, 2, Number.MAX_SAFE_INTEGER, "relation-potential sampleCounts coefficientTrainingCount");
  boundedInteger(model.sampleCounts.calibrationFitCount, 2, Number.MAX_SAFE_INTEGER, "relation-potential sampleCounts calibrationFitCount");
  boundedInteger(model.sampleCounts.evaluationHoldoutCount, 2, Number.MAX_SAFE_INTEGER, "relation-potential sampleCounts evaluationHoldoutCount");
  assertExactKeys(model.coefficients as unknown as Record<string, unknown>, RELATION_POTENTIAL_FEATURES.filter(name => name !== "contradiction"), "relation-potential coefficients");
  for (const [name, value] of Object.entries(model.coefficients)) nonnegativeFinite(value, `relation-potential coefficient ${name}`);
  nonnegativeFinite(model.contradictionCoefficient, "relation-potential contradictionCoefficient");
  finite(model.intercept, "relation-potential intercept");
  assertExactKeys(model.calibration as unknown as Record<string, unknown>, ["method", "slope", "intercept", "holdoutBrier", "holdoutEce"], "relation-potential calibration");
  if (model.calibration.method !== "platt") throw new Error("relation-potential calibration method must be platt");
  positiveFinite(model.calibration.slope, "relation-potential calibration slope");
  finite(model.calibration.intercept, "relation-potential calibration intercept");
  unitInterval(model.calibration.holdoutBrier, "relation-potential calibration holdoutBrier");
  unitInterval(model.calibration.holdoutEce, "relation-potential calibration holdoutEce");
  const expectedId = relationPotentialModelId(model);
  if (model.modelId !== expectedId) throw new Error(`relation-potential modelId does not match frozen model content; expected ${expectedId}`);
}

/** Returns an immutable defensive copy suitable for production inference. */
export function freezeRelationPotentialModel(model: RelationPotentialModel): RelationPotentialModel {
  assertValidRelationPotentialModel(model);
  return Object.freeze({
    schema: model.schema,
    modelId: model.modelId,
    datasetHash: model.datasetHash,
    sampleCounts: Object.freeze({ ...model.sampleCounts }),
    coefficients: Object.freeze({ ...model.coefficients }),
    contradictionCoefficient: model.contradictionCoefficient,
    intercept: model.intercept,
    calibration: Object.freeze({ ...model.calibration })
  });
}

/**
 * Source-neutral, bounded projection from graph structure and typed numeric
 * relation signals. It never reads node labels, answer text, or evaluation
 * questions. Missing modality/contradiction signals remain explicit zeros.
 */
export function projectGraphEdgeRelationPotential(
  edge: GraphEdge,
  context: { readonly edges: readonly GraphEdge[]; readonly snapshotTime?: number }
): RelationPotentialProjectionAudit {
  validateProjectionEdge(edge);
  context.edges.forEach(validateProjectionEdge);
  const snapshotTime = context.snapshotTime ?? graphSnapshotTime(context.edges);
  finite(snapshotTime, "relation-potential projection snapshotTime");
  const peers = context.edges.filter(candidate =>
    candidate.source === edge.source && candidate.target === edge.target && candidate.relationId === edge.relationId
  );
  const distinctEvidence = new Set(peers.flatMap(candidate => candidate.evidenceIds.map(String))).size;
  const typedSignals = relationPotentialSignals(edge);
  const features = Object.freeze({
    compatibility: saturatingNonnegative(edge.weight),
    provenance: countSaturation(edge.evidenceIds.length),
    temporalFit: edge.temporalScope.validFrom <= snapshotTime && (edge.temporalScope.validTo === undefined || snapshotTime <= edge.temporalScope.validTo) ? 1 : 0,
    modalityAgreement: typedSignals.modalityAgreement ?? 0,
    recurrence: countSaturation(Math.max(0, peers.length - 1)),
    utility: saturatingNonnegative(edge.alpha),
    sourceAgreement: countSaturation(distinctEvidence),
    contradiction: typedSignals.contradiction ?? 0
  });
  validateFeatures(features);
  return Object.freeze({
    schema: RELATION_POTENTIAL_PROJECTION_SCHEMA,
    edgeId: String(edge.id),
    relationId: String(edge.relationId),
    snapshotTime,
    sameRelationEndpointCount: peers.length,
    distinctSupportingEvidenceCount: distinctEvidence,
    featureSources: Object.freeze({
      compatibility: "edge.weight.saturating_nonnegative.v1",
      provenance: "edge.evidence_count.saturation.v1",
      temporalFit: "edge.temporal_scope.contains_snapshot.v1",
      modalityAgreement: typedSignals.modalityAgreement === undefined ? "unobserved.zero.v1" : "edge.metadata.relation_potential.modality_agreement.v1",
      recurrence: "graph.same_relation_endpoint_count.saturation.v1",
      utility: "edge.alpha.saturating_nonnegative.v1",
      sourceAgreement: "graph.peer_distinct_evidence_count.saturation.v1",
      contradiction: typedSignals.contradiction === undefined ? "unobserved.zero.v1" : "edge.metadata.relation_potential.contradiction.v1"
    }),
    features
  });
}

/** Apply a configured frozen model exactly once to transition weights. */
export function scoreGraphEdgesWithRelationPotential(
  model: RelationPotentialModel,
  edges: readonly GraphEdge[],
  options: { readonly snapshotTime?: number } = {}
): RelationPotentialEdgeScoringResult {
  const frozenModel = freezeRelationPotentialModel(model);
  const snapshotTime = options.snapshotTime ?? graphSnapshotTime(edges);
  const audit: RelationPotentialEdgeScoreAudit[] = [];
  const scoredEdges = edges.map(edge => {
    const projection = projectGraphEdgeRelationPotential(edge, { edges, snapshotTime });
    const score = scoreValidatedRelationPotential(frozenModel, projection.features);
    const baseTransitionWeight = edge.weight * edge.alpha;
    finite(baseTransitionWeight, `relation-potential base transition weight for edge ${String(edge.id)}`);
    const scoredAlpha = edge.alpha * score.calibrated;
    const scoredTransitionWeight = edge.weight * scoredAlpha;
    finite(scoredTransitionWeight, `relation-potential scored transition weight for edge ${String(edge.id)}`);
    audit.push(Object.freeze({ ...projection, ...score, baseTransitionWeight, scoredTransitionWeight }));
    return Object.freeze({ ...edge, alpha: scoredAlpha });
  });
  return Object.freeze({ edges: scoredEdges, audit: Object.freeze(audit) });
}

function fitPlatt(logits: readonly number[], labels: readonly (0 | 1)[]): { slope: number; intercept: number } {
  let slope = 1;
  let intercept = 0;
  for (let iteration = 0; iteration < 600; iteration++) {
    let slopeGradient = 0;
    let interceptGradient = 0;
    for (let index = 0; index < logits.length; index++) {
      const logit = logits[index] ?? 0;
      const error = sigmoid(slope * logit + intercept) - (labels[index] ?? 0);
      slopeGradient += error * logit;
      interceptGradient += error;
    }
    slope -= 0.05 * slopeGradient / logits.length;
    intercept -= 0.05 * interceptGradient / logits.length;
  }
  return { slope, intercept };
}

function linear(
  features: RelationPotentialFeatures,
  weights: Readonly<Record<Exclude<RelationPotentialFeatureId, "contradiction">, number>>,
  contradictionCoefficient: number,
  intercept: number
): number {
  return intercept
    + weights.compatibility * features.compatibility
    + weights.provenance * features.provenance
    + weights.temporalFit * features.temporalFit
    + weights.modalityAgreement * features.modalityAgreement
    + weights.recurrence * features.recurrence
    + weights.utility * features.utility
    + weights.sourceAgreement * features.sourceAgreement
    - contradictionCoefficient * features.contradiction;
}

function validateExample(example: RelationPotentialExample): void {
  if (!example.id.trim()) throw new Error("relation-potential example id must be non-empty");
  validateFeatures(example.features);
  if (example.label !== 0 && example.label !== 1) throw new Error("relation-potential label must be 0 or 1");
}

function validateFitDataset(examples: readonly RelationPotentialExample[], role: keyof RelationPotentialFitDatasets): void {
  if (!Array.isArray(examples)) throw new TypeError(`relation-potential ${role} must be an array`);
  examples.forEach(validateExample);
  if (examples.length < 2 || new Set(examples.map(row => row.label)).size < 2) {
    throw new Error(`relation-potential ${role} requires both labels`);
  }
  if (new Set(examples.map(row => row.id)).size !== examples.length) {
    throw new Error(`relation-potential ${role} example ids must be unique`);
  }
}

function assertDisjointFitDatasets(datasets: RelationPotentialFitDatasets): void {
  const ownerById = new Map<string, keyof RelationPotentialFitDatasets>();
  for (const role of ["coefficientTraining", "calibrationFit", "evaluationHoldout"] as const) {
    for (const example of datasets[role]) {
      const priorRole = ownerById.get(example.id);
      if (priorRole) throw new Error(`relation-potential datasets must be disjoint; example id ${example.id} occurs in ${priorRole} and ${role}`);
      ownerById.set(example.id, role);
    }
  }
}

function validateFeatures(features: RelationPotentialFeatures): void {
  for (const name of RELATION_POTENTIAL_FEATURES) {
    const value = features[name];
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`relation-potential feature ${name} must be within [0, 1]`);
  }
}

function relationPotentialModelId(model: Omit<RelationPotentialModel, "modelId"> | RelationPotentialModel): string {
  const material = {
    schema: model.schema,
    datasetHash: model.datasetHash,
    sampleCounts: model.sampleCounts,
    coefficients: model.coefficients,
    contradictionCoefficient: model.contradictionCoefficient,
    intercept: model.intercept,
    calibration: model.calibration
  };
  return `relation-potential:${createHasher().digestHex(canonicalStringify(material))}`;
}

function validateProjectionEdge(edge: GraphEdge): void {
  if (!edge || typeof edge !== "object") throw new TypeError("relation-potential projection edge must be an object");
  nonnegativeFinite(edge.weight, `relation-potential edge ${String(edge.id)} weight`);
  nonnegativeFinite(edge.alpha, `relation-potential edge ${String(edge.id)} alpha`);
  finite(edge.temporalScope?.validFrom, `relation-potential edge ${String(edge.id)} temporalScope.validFrom`);
  if (edge.temporalScope.validTo !== undefined) {
    finite(edge.temporalScope.validTo, `relation-potential edge ${String(edge.id)} temporalScope.validTo`);
    if (edge.temporalScope.validTo < edge.temporalScope.validFrom) throw new RangeError(`relation-potential edge ${String(edge.id)} temporalScope.validTo must not precede validFrom`);
  }
  if (!Array.isArray(edge.evidenceIds)) throw new TypeError(`relation-potential edge ${String(edge.id)} evidenceIds must be an array`);
}

function relationPotentialSignals(edge: GraphEdge): { modalityAgreement?: number; contradiction?: number } {
  const metadata = objectRecord(edge.metadata);
  const signals = objectRecord(metadata?.relationPotential);
  if (!signals) return {};
  assertAllowedKeys(signals, ["modalityAgreement", "contradiction"], `relation-potential edge ${String(edge.id)} metadata.relationPotential`);
  const result: { modalityAgreement?: number; contradiction?: number } = {};
  if (signals.modalityAgreement !== undefined) result.modalityAgreement = unitInterval(signals.modalityAgreement, `relation-potential edge ${String(edge.id)} modalityAgreement`);
  if (signals.contradiction !== undefined) result.contradiction = unitInterval(signals.contradiction, `relation-potential edge ${String(edge.id)} contradiction`);
  return result;
}

function graphSnapshotTime(edges: readonly GraphEdge[]): number {
  return edges.reduce((latest, edge) => Math.max(latest, edge.updatedAt), 0);
}

function saturatingNonnegative(value: number): number {
  nonnegativeFinite(value, "relation-potential structural feature input");
  return value === 0 ? 0 : value / (1 + value);
}

function countSaturation(count: number): number {
  if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("relation-potential count feature must be a nonnegative safe integer");
  return count === 0 ? 0 : 1 - Math.exp(-count / 2);
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function assertExactKeys(record: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(record).sort();
  const required = [...expected].sort();
  if (actual.length !== required.length || actual.some((key, index) => key !== required[index])) {
    throw new Error(`${label} must contain exactly: ${required.join(", ")}`);
  }
}

function assertAllowedKeys(record: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allow = new Set(allowed);
  const unknown = Object.keys(record).filter(key => !allow.has(key));
  if (unknown.length) throw new Error(`${label} contains unsupported fields: ${unknown.sort().join(", ")}`);
}

function sigmoid(value: number): number {
  if (value >= 0) return 1 / (1 + Math.exp(-value));
  const exp = Math.exp(value);
  return exp / (1 + exp);
}

function brier(probabilities: readonly number[], labels: readonly (0 | 1)[]): number {
  return probabilities.reduce((sum, probability, index) => sum + (probability - (labels[index] ?? 0)) ** 2, 0) / probabilities.length;
}

function expectedCalibrationError(probabilities: readonly number[], labels: readonly (0 | 1)[], bins = 10): number {
  let total = 0;
  for (let bin = 0; bin < bins; bin++) {
    const lower = bin / bins;
    const upper = (bin + 1) / bins;
    const indices = probabilities.map((value, index) => ({ value, index })).filter(row => row.value >= lower && (bin === bins - 1 ? row.value <= upper : row.value < upper));
    if (!indices.length) continue;
    const confidence = indices.reduce((sum, row) => sum + row.value, 0) / indices.length;
    const accuracy = indices.reduce((sum, row) => sum + (labels[row.index] ?? 0), 0) / indices.length;
    total += indices.length / probabilities.length * Math.abs(accuracy - confidence);
  }
  return total;
}

function boundedInteger(value: number, min: number, max: number, label: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new RangeError(`${label} must be an integer within [${min}, ${max}]`);
  return value;
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${label} must be positive and finite`);
  return value;
}

function nonnegativeFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new RangeError(`${label} must be nonnegative and finite`);
  return value;
}

function finite(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
  return value;
}

function unitInterval(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) throw new RangeError(`${label} must be within [0, 1]`);
  return value;
}
