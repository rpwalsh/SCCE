import { DIALOGUE_ACTION_IDS, type DialogueState } from "./dialogue-pragmatics.js";
import { boltzmannDistribution } from "./equation-operators.js";
import { kneserNeyProbability } from "./kneser-ney.js";
import type { LanguageMemoryRuntime, LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { createInventionConstruct, type InventionConstruct } from "./prediction.js";
import { canonicalStringify, clamp01, createHasher, featureSet, mean, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";
import { COGNITIVE_OPERATOR_IDS, type ActivatedOperator, type TurnRequirementField } from "./turn-requirements.js";
import type { ConstructGraph, EvidenceSpan, FieldState, GraphEdge, GraphNode, GraphSlice, JsonValue, RequestedAuthority } from "./types.js";

export const REQUESTED_AUTHORITIES = ["factual", "reasoned", "creative", "translation", "program", "action"] as const satisfies readonly RequestedAuthority[];

export const REQUESTED_AUTHORITY_FEATURE_SCHEMA = [
  "authority.feature.bias",
  "authority.feature.request.question",
  "authority.feature.request.reasoned",
  "authority.feature.request.creative",
  "authority.feature.request.translation",
  "authority.feature.request.program",
  "authority.feature.request.action",
  "authority.feature.dialogue.artifact",
  "authority.feature.dialogue.plan",
  "authority.feature.dialogue.boundary",
  "authority.feature.language.activation",
  "authority.feature.semantic_frame.activation",
  "authority.feature.question_graph.activation",
  "authority.feature.construct.invention",
  "authority.feature.construct.program"
] as const;

export type RequestedAuthorityFeatureId = (typeof REQUESTED_AUTHORITY_FEATURE_SCHEMA)[number];

export interface RequestedAuthorityModel {
  schema: "scce.requested_authority_model.v1";
  version: string;
  featureSchema: readonly RequestedAuthorityFeatureId[];
  defaultTemperature: number;
  coefficients: Readonly<Record<RequestedAuthority, {
    intercept: number;
    weights: Readonly<Record<RequestedAuthorityFeatureId, number>>;
  }>>;
}

export interface AuthorityClassificationInput {
  requestText: string;
  explicitAuthority?: RequestedAuthority;
  dialogueState?: DialogueState;
  dialogueActionIds?: readonly string[];
  semanticFrameIds?: readonly string[];
  languageMemory?: LanguageMemoryRuntime;
  languageMemoryState?: LanguageMemoryRuntimeState;
  graph?: GraphSlice;
  construct?: ConstructGraph;
  questionFeatures?: readonly string[];
  temperature?: number;
  model?: RequestedAuthorityModel;
}

export interface RequestedAuthorityDecision {
  schema: "scce.requested_authority_decision.v1";
  requestedAuthority: RequestedAuthority;
  explicitOverride: boolean;
  modelVersion: string;
  temperature: number;
  featureSchema: RequestedAuthorityFeatureId[];
  features: Record<RequestedAuthorityFeatureId, number>;
  logits: Record<RequestedAuthority, number>;
  probabilities: Record<RequestedAuthority, number>;
  fallbackSignals: string[];
  audit: JsonValue;
}

/**
 * @deprecated English-only bootstrap retained solely for callers of the
 * explicitly exported legacy authority classifier below. Production turn
 * routing derives RequestedAuthority from TurnRequirementField and must not
 * call this classifier. Nothing in planInventions references this table.
 */
const LEGACY_ENGLISH_REQUEST_SIGNAL_SYMBOLS = {
  reasoned: ["derive", "explain", "reason", "compare"],
  creative: ["invent", "imagine", "devise", "brainstorm"],
  translation: ["translate", "translation", "transliterate", "localize"],
  program: ["implement", "code", "patch", "build"],
  action: ["send", "schedule", "call", "execute"]
} as const;

// ---------------------------------------------------------------------------
// Deprecated English compatibility boundary. Production invention planning
// starts at PlanInventionsInput below and has no call edge into this section.
// ---------------------------------------------------------------------------

const AUTHORITY_BOOTSTRAP_MODEL: RequestedAuthorityModel = {
  schema: "scce.requested_authority_model.v1",
  version: "authority.bootstrap.2026-07-12.v1",
  featureSchema: REQUESTED_AUTHORITY_FEATURE_SCHEMA,
  defaultTemperature: 0.72,
  coefficients: {
    factual: legacyAuthorityRow(0.46, {
      "authority.feature.request.question": 1.34,
      "authority.feature.dialogue.boundary": 0.28,
      "authority.feature.question_graph.activation": 0.62,
      "authority.feature.request.creative": -0.72,
      "authority.feature.request.translation": -0.64,
      "authority.feature.request.program": -0.42,
      "authority.feature.request.action": -0.38
    }),
    reasoned: legacyAuthorityRow(0.08, {
      "authority.feature.request.reasoned": 1.82,
      "authority.feature.dialogue.plan": 0.34,
      "authority.feature.question_graph.activation": 0.36,
      "authority.feature.language.activation": 0.14
    }),
    creative: legacyAuthorityRow(-0.22, {
      "authority.feature.request.creative": 2.92,
      "authority.feature.dialogue.artifact": 0.44,
      "authority.feature.dialogue.plan": 0.28,
      "authority.feature.language.activation": 0.12,
      "authority.feature.semantic_frame.activation": 0.2,
      "authority.feature.construct.invention": 3.2
    }),
    translation: legacyAuthorityRow(-0.28, {
      "authority.feature.request.translation": 3.12,
      "authority.feature.language.activation": 0.18,
      "authority.feature.semantic_frame.activation": 0.12
    }),
    program: legacyAuthorityRow(-0.2, {
      "authority.feature.request.program": 2.72,
      "authority.feature.dialogue.artifact": 0.48,
      "authority.feature.dialogue.plan": 0.24,
      "authority.feature.construct.program": 2.36
    }),
    action: legacyAuthorityRow(-0.18, {
      "authority.feature.request.action": 2.84,
      "authority.feature.dialogue.plan": 0.62,
      "authority.feature.dialogue.artifact": 0.22
    })
  }
};

/** @deprecated Used only with classifyRequestedAuthority compatibility calls. */
export function requestedAuthorityBootstrapModel(): RequestedAuthorityModel {
  return AUTHORITY_BOOTSTRAP_MODEL;
}

/**
 * @deprecated English-only compatibility classifier. Production routing uses
 * deriveTurnRequirementField plus numeric operator activation. This function
 * remains exported for legacy consumers and tests, but planInventions never
 * calls it and request text never controls invention admission.
 */
export function classifyRequestedAuthority(input: AuthorityClassificationInput): RequestedAuthorityDecision {
  const model = input.model ?? AUTHORITY_BOOTSTRAP_MODEL;
  assertLegacyAuthorityModel(model);
  const temperature = boundedLegacyAuthorityTemperature(input.temperature ?? model.defaultTemperature);
  const requestFeatures = new Set(featureSet(input.requestText, 512));
  const actionIds = new Set(input.dialogueActionIds ?? []);
  const constructKinds = new Set(input.construct?.nodes.map(node => node.kind) ?? []);
  const questionGraphFeatures = [
    ...(input.questionFeatures ?? []),
    ...(input.graph?.query.features ?? []),
    ...(input.graph?.query.topicTerms ?? []),
    ...(input.graph?.query.nodeTypes ?? [])
  ];
  const languageActivation = input.languageMemory && input.languageMemoryState
    ? input.languageMemory.score({ state: input.languageMemoryState, text: input.requestText }).activation
    : 0;
  const semanticFrameActivation = legacyFrameActivation(input.requestText, input.languageMemoryState, input.semanticFrameIds);
  const features: Record<RequestedAuthorityFeatureId, number> = {
    "authority.feature.bias": 1,
    "authority.feature.request.question": legacyRequestQuestionSignal(input.requestText, requestFeatures),
    "authority.feature.request.reasoned": legacyRequestSymbolSignal(requestFeatures, LEGACY_ENGLISH_REQUEST_SIGNAL_SYMBOLS.reasoned),
    "authority.feature.request.creative": legacyRequestSymbolSignal(requestFeatures, LEGACY_ENGLISH_REQUEST_SIGNAL_SYMBOLS.creative),
    "authority.feature.request.translation": legacyRequestSymbolSignal(requestFeatures, LEGACY_ENGLISH_REQUEST_SIGNAL_SYMBOLS.translation),
    "authority.feature.request.program": legacyRequestSymbolSignal(requestFeatures, LEGACY_ENGLISH_REQUEST_SIGNAL_SYMBOLS.program),
    "authority.feature.request.action": legacyRequestSymbolSignal(requestFeatures, LEGACY_ENGLISH_REQUEST_SIGNAL_SYMBOLS.action),
    "authority.feature.dialogue.artifact": actionIds.has(DIALOGUE_ACTION_IDS.artifact) ? 1 : legacyDialogueFeature(input.dialogueState, "artifact"),
    "authority.feature.dialogue.plan": actionIds.has(DIALOGUE_ACTION_IDS.plan) || actionIds.has(DIALOGUE_ACTION_IDS.nextStep) ? 1 : legacyDialogueFeature(input.dialogueState, "plan"),
    "authority.feature.dialogue.boundary": actionIds.has(DIALOGUE_ACTION_IDS.boundary) ? 1 : legacyDialogueFeature(input.dialogueState, "boundary"),
    "authority.feature.language.activation": clamp01(languageActivation),
    "authority.feature.semantic_frame.activation": semanticFrameActivation,
    "authority.feature.question_graph.activation": legacyQuestionGraphActivation(questionGraphFeatures),
    "authority.feature.construct.invention": constructRequestsInvention(input.construct) ? 1 : 0,
    "authority.feature.construct.program": input.construct?.program || constructKinds.has("construct:program") || constructKinds.has("family:program") ? 1 : 0
  };
  const logits = Object.fromEntries(REQUESTED_AUTHORITIES.map(authority => {
    const row = model.coefficients[authority];
    const logit = row.intercept + model.featureSchema.reduce((sum, id) => sum + row.weights[id] * features[id], 0);
    return [authority, logit];
  })) as Record<RequestedAuthority, number>;
  const inferredProbabilities = legacySoftmaxLogits(logits, temperature);
  const inferredAuthority = [...REQUESTED_AUTHORITIES]
    .sort((left, right) => inferredProbabilities[right] - inferredProbabilities[left] || left.localeCompare(right))[0] ?? "factual";
  const explicitOverride = input.explicitAuthority !== undefined;
  const requestedAuthority = input.explicitAuthority ?? inferredAuthority;
  const probabilities = explicitOverride
    ? Object.fromEntries(REQUESTED_AUTHORITIES.map(authority => [authority, authority === requestedAuthority ? 1 : 0])) as Record<RequestedAuthority, number>
    : inferredProbabilities;
  const fallbackSignals = Object.entries(features)
    .filter(([id, value]) => id !== "authority.feature.bias" && value > 0)
    .map(([id]) => id)
    .sort();
  return {
    schema: "scce.requested_authority_decision.v1",
    requestedAuthority,
    explicitOverride,
    modelVersion: model.version,
    temperature,
    featureSchema: [...model.featureSchema],
    features,
    logits,
    probabilities,
    fallbackSignals,
    audit: toJsonValue({
      source: "invention-planner.requested-authority",
      equation: "P(k|q)=exp(z_k/tau)/sum_j(exp(z_j/tau)); z_k=theta_k^T f(q,d,l,g)",
      modelSchema: model.schema,
      modelVersion: model.version,
      coefficients: model.coefficients,
      featureSchema: model.featureSchema,
      features,
      logits,
      inferredProbabilities,
      finalProbabilities: probabilities,
      explicitOverride,
      evidenceAvailabilityUsed: false,
      fallbackSignals
    })
  };
}

export interface PlanInventionsInput {
  requestText: string;
  requestedAuthority: RequestedAuthority;
  field: FieldState;
  graph: GraphSlice;
  languageMemory: LanguageMemoryRuntime;
  languageMemoryState: LanguageMemoryRuntimeState;
  dialogueState: DialogueState;
  evidence: readonly EvidenceSpan[];
  construct: ConstructGraph;
  /** Numeric, learned requirement field from the production turn lane. */
  requirementField?: Pick<TurnRequirementField,
    "noveltyDemand"
    | "activatedFrameIds"
    | "activatedPatternIds"
    | "activatedPhraseUnitIds"
    | "activatedConstructIds"
  >;
  /** Numeric operator state; learned IDs select the invention lane. */
  operatorActivations?: readonly ActivatedOperator[];
  temperature?: number;
  samplingDisabled?: boolean;
  maxCandidates?: number;
}

export type InventionClaimBasis = {
  id: string;
  surface?: string;
  force: "observed" | "inferred" | "invented" | "conjectured";
  evidenceIds: string[];
  kind: "factual_premise" | "deduction" | "invention" | "performance_prediction";
};

export type InventionConstraintTrace = { id: string; surface: string; weight: number; satisfied: boolean };

interface ConstraintSeed {
  id: string;
  surface: string;
  weight: number;
}

interface CompositionIngredient {
  id: string;
  text: string;
  source: "request" | "graph" | "language_unit" | "language_pattern" | "semantic_frame" | "observation";
  weight: number;
  evidenceIds: string[];
  graphNodeId?: string;
}

interface DraftComposition {
  title: string;
  proposalSurface: string;
  artifactKindIds: string[];
  basisPriorIds: string[];
  selectedGraphNodeIds: string[];
  selectedLanguagePriorIds: string[];
  selectedEdges: GraphEdge[];
  claimBasis: InventionClaimBasis[];
  untestedPerformanceClaim: boolean;
}

interface ScoredComposition extends DraftComposition {
  constraintCoverage: number;
  constraints: InventionConstraintTrace[];
  graphCoherence: number;
  novelty: number;
  languageRealizability: number;
  usefulness: number;
  risk: number;
  repetition: number;
  unsupportedFactualAssertion: number;
  bootstrapScore: number;
  diversity: number;
  probability: number;
}

const CREATIVE_TEMPERATURE = 0.28;

/**
 * Builds bounded, inspectable invention constructs in the existing construct
 * lane. Evidence can support factual premises, but is never required for the
 * invented material itself.
 */
export function planInventions(input: PlanInventionsInput): InventionConstruct[] {
  const planningActivation = inventionPlanningActivation(input);
  if (!planningActivation.admissible) return [];
  const maxCandidates = boundedInteger(input.maxCandidates ?? 4, 2, 8);
  const constraints = extractConstraints(input).slice(0, 16);
  const graphIngredients = graphCompositionIngredients(input).slice(0, 12);
  const languageIngredients = languageCompositionIngredients(input).slice(0, 18);
  const requestIngredients = requestCompositionIngredients(input.requestText);
  const ingredients = uniqueIngredients([...graphIngredients, ...languageIngredients, ...requestIngredients]);
  const drafts = Array.from({ length: maxCandidates + 2 }, (_, index) => buildDraft(input, constraints, ingredients, graphIngredients, index))
    .filter((draft, index, all) => all.findIndex(candidate => normalizeSurface(candidate.proposalSurface) === normalizeSurface(draft.proposalSurface)) === index)
    .slice(0, maxCandidates);
  const memorySurfaces = existingMemorySurfaces(input);
  const preliminary = drafts.map((draft, index) => scoreDraft(input, draft, constraints, memorySurfaces, drafts, index));
  const temperature = boundedCreativeTemperature(input.temperature ?? CREATIVE_TEMPERATURE);
  const probabilities = boltzmannDistribution({ energies: preliminary.map(candidate => -candidate.bootstrapScore), temperature });
  const withProbabilities = preliminary.map((candidate, index) => ({ ...candidate, probability: probabilities[index] ?? 0 }));
  const ranked = diversityRank(withProbabilities);
  return ranked.map((candidate, index) => {
    const basisEvidenceIds = uniqueStrings(candidate.claimBasis
      .filter(record => record.kind === "factual_premise")
      .flatMap(record => record.evidenceIds));
    return createInventionConstruct({
      title: candidate.title,
      proposalSurface: candidate.proposalSurface,
      artifactKindIds: candidate.artifactKindIds,
      basisEvidenceIds,
      basisPriorIds: candidate.basisPriorIds,
      noveltyScore: candidate.novelty,
      supportScore: clamp01(mean([candidate.constraintCoverage, candidate.graphCoherence, candidate.languageRealizability, candidate.usefulness]) * (1 - candidate.risk)),
      riskScore: candidate.risk,
      trace: toJsonValue({
        source: "invention-planner.plan",
        requestedAuthority: input.requestedAuthority,
        planningActivation,
        lexicalRoutingUsed: false,
        surfaceTokensAffectAdmission: false,
        constraintCoverage: candidate.constraintCoverage,
        graphCoherence: candidate.graphCoherence,
        novelty: candidate.novelty,
        languageRealizability: candidate.languageRealizability,
        usefulness: candidate.usefulness,
        risk: candidate.risk,
        repetition: candidate.repetition,
        unsupportedFactualAssertion: candidate.unsupportedFactualAssertion,
        bootstrapScore: candidate.bootstrapScore,
        constraints: candidate.constraints,
        claimBasis: candidate.claimBasis,
        untestedPerformanceClaim: candidate.untestedPerformanceClaim,
        selectionProbability: candidate.probability,
        probability: candidate.probability,
        rank: index + 1,
        selected: index === 0,
        diversity: candidate.diversity,
        temperature,
        samplingDisabled: input.samplingDisabled ?? true,
        selectedGraphNodeIds: candidate.selectedGraphNodeIds,
        selectedGraphEdgeIds: candidate.selectedEdges.map(edge => String(edge.id)),
        selectedLanguagePriorIds: candidate.selectedLanguagePriorIds,
        bootstrapCoefficients: {
          constraintCoverage: 0.28,
          graphCoherence: 0.22,
          novelty: 0.2,
          languageRealizability: 0.15,
          usefulness: 0.15,
          risk: -0.3,
          repetition: -0.2,
          unsupportedFactualAssertion: -0.5
        },
        equations: {
          constraintCoverage: "sum_j(w_j*I[satisfies_j])/sum_j(w_j)",
          graphCoherence: "mean_e(relationPotential(e))",
          novelty: "1-max_m(weightedJaccard(phi(g),phi(m)))",
          languageRealizability: "exp(mean_i(log(P_KN(token_i|history_i))))",
          usefulness: "mean(actionability,requestFit,completionPotential)",
          risk: "max(contradictionPressure,internalConflict,infeasibility)",
          selection: "P(g_i)=exp(S_i/T)/sum_j(exp(S_j/T))"
        },
        generatedMaterialUsesEvidenceAsAuthority: false,
        copiesCompleteEvidenceSentence: copiesCompleteEvidenceSentence(candidate.proposalSurface, input.evidence)
      })
    });
  });
}

function legacyAuthorityRow(intercept: number, patch: Partial<Record<RequestedAuthorityFeatureId, number>>): RequestedAuthorityModel["coefficients"][RequestedAuthority] {
  return {
    intercept,
    weights: Object.fromEntries(REQUESTED_AUTHORITY_FEATURE_SCHEMA.map(id => [id, patch[id] ?? 0])) as Record<RequestedAuthorityFeatureId, number>
  };
}

function assertLegacyAuthorityModel(model: RequestedAuthorityModel): void {
  if (model.schema !== "scce.requested_authority_model.v1" || !model.version.trim()) throw new Error("requested-authority model schema/version is invalid");
  if (model.featureSchema.length !== REQUESTED_AUTHORITY_FEATURE_SCHEMA.length || model.featureSchema.some((id, index) => id !== REQUESTED_AUTHORITY_FEATURE_SCHEMA[index])) {
    throw new Error("requested-authority model feature schema does not match the runtime schema");
  }
  boundedLegacyAuthorityTemperature(model.defaultTemperature);
  for (const authority of REQUESTED_AUTHORITIES) {
    const row = model.coefficients[authority];
    if (!row || !Number.isFinite(row.intercept)) throw new Error(`requested-authority model row ${authority} is invalid`);
    for (const id of model.featureSchema) if (!Number.isFinite(row.weights[id])) throw new Error(`requested-authority coefficient ${authority}/${id} is invalid`);
  }
}

function legacySoftmaxLogits(logits: Record<RequestedAuthority, number>, temperature: number): Record<RequestedAuthority, number> {
  const scaled = REQUESTED_AUTHORITIES.map(authority => logits[authority] / temperature);
  const max = Math.max(...scaled);
  const weights = scaled.map(value => Math.exp(value - max));
  const total = weights.reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(REQUESTED_AUTHORITIES.map((authority, index) => [authority, (weights[index] ?? 0) / Math.max(Number.EPSILON, total)])) as Record<RequestedAuthority, number>;
}

function boundedLegacyAuthorityTemperature(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("requested-authority temperature must be finite");
  return Math.max(0.05, Math.min(2, value));
}

function boundedCreativeTemperature(value: number): number {
  if (!Number.isFinite(value)) throw new RangeError("creative temperature must be finite");
  return Math.max(0.05, Math.min(1.5, value));
}

function legacyRequestQuestionSignal(text: string, features: ReadonlySet<string>): number {
  const punctuation = text.trim().endsWith("?") ? 1 : 0;
  const interrogative = ["what", "who", "when", "where", "which", "is", "are"].some(symbol => features.has(`sym:${symbol}`)) ? 0.7 : 0;
  return Math.max(punctuation, interrogative);
}

function legacyRequestSymbolSignal(features: ReadonlySet<string>, symbols: readonly string[]): number {
  const hits = symbols.filter(symbol => features.has(`sym:${symbol}`)).length;
  return clamp01(hits / Math.max(1, Math.min(2, symbols.length)));
}

function legacyDialogueFeature(state: DialogueState | undefined, fragment: string): number {
  if (!state) return 0;
  const direct = state.interactionFeatures.filter(feature => feature.id.includes(fragment)).map(feature => feature.value);
  const signals = state.interactionSignals.filter(signal => signal.featureId.includes(fragment)).map(signal => signal.value * signal.confidence);
  return clamp01(Math.max(0, ...direct, ...signals));
}

function legacyFrameActivation(requestText: string, state: LanguageMemoryRuntimeState | undefined, explicitFrameIds: readonly string[] | undefined): number {
  if (!state) return explicitFrameIds?.length ? clamp01(explicitFrameIds.length / 4) : 0;
  const requestFeatures = featureSet(requestText, 256);
  const explicit = new Set(explicitFrameIds ?? []);
  const scores = state.importedSemanticFrames.slice(0, 256).map(frame => {
    const surfaces = jsonStrings(frame.frameJson, 20).join(" ");
    const fit = surfaces ? weightedJaccard(requestFeatures, featureSet(surfaces, 256)) : 0;
    return clamp01(fit * 0.72 + frame.alpha * 0.18 + (explicit.has(frame.id) ? 0.34 : 0));
  });
  return clamp01(Math.max(explicit.size ? explicit.size / 4 : 0, ...scores, 0));
}

function legacyQuestionGraphActivation(features: readonly string[]): number {
  const normalized = uniqueStrings(features.map(value => value.normalize("NFC").trim()).filter(Boolean));
  return clamp01(Math.log2(1 + normalized.length) / 4);
}

function constructRequestsInvention(construct: ConstructGraph | undefined): boolean {
  if (!construct) return false;
  return construct.nodes.some(node => {
    if (node.kind === "construct:invention" || node.kind === "family:invention") return true;
    const metadata = jsonRecord(node.metadata);
    return metadata.operatorId === COGNITIVE_OPERATOR_IDS.invention
      || metadata.semanticRoleId === "semantic.role.invention";
  });
}

function inventionPlanningActivation(input: PlanInventionsInput): {
  authority: number;
  noveltyRequirement: number;
  inventionOperator: number;
  construct: number;
  activation: number;
  threshold: number;
  admissible: boolean;
  activeLearnedIds: string[];
} {
  const authority = Number(input.requestedAuthority === "creative");
  const noveltyRequirement = clamp01(input.requirementField?.noveltyDemand ?? 0);
  const inventionOperators = (input.operatorActivations ?? [])
    .filter(row => row.operatorId === COGNITIVE_OPERATOR_IDS.invention && row.active);
  const inventionOperator = clamp01(Math.max(0, ...inventionOperators.map(row => row.activation)));
  const construct = Number(constructRequestsInvention(input.construct));
  const activation = Math.max(authority, noveltyRequirement, inventionOperator, construct);
  const threshold = 0.5;
  return {
    authority,
    noveltyRequirement,
    inventionOperator,
    construct,
    activation,
    threshold,
    admissible: activation >= threshold,
    activeLearnedIds: uniqueStrings([
      ...(input.requirementField?.activatedFrameIds ?? []),
      ...(input.requirementField?.activatedPatternIds ?? []),
      ...(input.requirementField?.activatedPhraseUnitIds ?? []),
      ...(input.requirementField?.activatedConstructIds ?? []),
      ...inventionOperators.map(row => row.id),
      ...inventionOperators.map(row => row.operatorId)
    ]).sort()
  };
}

function extractConstraints(input: PlanInventionsInput): ConstraintSeed[] {
  const requestTerms = requestSurfaceUnits(input.requestText).slice(0, 10);
  const rows: ConstraintSeed[] = requestTerms.map((surface, index) => ({
    id: stableId("constraint.request", { surface, index }),
    surface,
    weight: Number((1 + Math.min(0.5, [...surface].length / 24)).toFixed(6))
  }));
  for (const node of input.construct.nodes) {
    const metadata = jsonRecord(node.metadata);
    const explicit = [metadata.constraints, metadata.requiredTerms, metadata.artifactKindIds].flatMap(value => jsonStrings(value, 16));
    for (const surface of explicit.map(cleanSurfacePiece).filter(Boolean)) {
      rows.push({ id: stableId("constraint.construct", { nodeId: node.id, surface }), surface, weight: 1.5 });
    }
  }
  for (const surface of input.dialogueState.unresolvedSlots.map(cleanSurfacePiece).filter(Boolean).slice(0, 6)) {
    rows.push({ id: stableId("constraint.dialogue", surface), surface, weight: 1.25 });
  }
  const unique = new Map<string, ConstraintSeed>();
  for (const row of rows) {
    const key = normalizeSurface(row.surface);
    const existing = unique.get(key);
    if (!existing || row.weight > existing.weight) unique.set(key, row);
  }
  return [...unique.values()].sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
}

function graphCompositionIngredients(input: PlanInventionsInput): CompositionIngredient[] {
  const active = new Map(input.field.active.map(row => [String(row.nodeId), row.activation]));
  const ppf = new Map(input.field.ppf.map(row => [String(row.nodeId), row.mass]));
  const availableEvidenceIds = new Set(input.evidence.map(span => String(span.id)));
  return input.graph.nodes.map(node => {
    const text = graphNodeSurface(node, input.evidence, input.requestText);
    return {
      id: String(node.id),
      text,
      source: "graph" as const,
      weight: clamp01(0.46 * (active.get(String(node.id)) ?? 0) + 0.34 * (ppf.get(String(node.id)) ?? 0) + 0.2 * node.alpha),
      evidenceIds: node.evidenceIds.map(String).filter(id => availableEvidenceIds.has(id)),
      graphNodeId: String(node.id)
    };
  }).filter(row => Boolean(row.text))
    .sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
}

function languageCompositionIngredients(input: PlanInventionsInput): CompositionIngredient[] {
  const requestFeatures = featureSet(input.requestText, 256);
  const state = input.languageMemoryState;
  const activatedIds = new Set([
    ...(input.requirementField?.activatedFrameIds ?? []),
    ...(input.requirementField?.activatedPatternIds ?? []),
    ...(input.requirementField?.activatedPhraseUnitIds ?? [])
  ]);
  const rows: CompositionIngredient[] = [];
  for (const unit of state.importedUnits.slice(0, 256)) {
    const text = cleanSurfacePiece(unit.text);
    if (!text) continue;
    rows.push({ id: unit.id, text, source: "language_unit", weight: clamp01(0.52 * unit.alpha + 0.28 * weightedJaccard(requestFeatures, featureSet(text, 128)) + 0.2 * Number(activatedIds.has(unit.id))), evidenceIds: unit.evidenceIds.map(String) });
  }
  for (const pattern of state.importedPatterns.slice(0, 128)) {
    const text = jsonStrings(pattern.patternJson, 8).map(cleanSurfacePiece).find(Boolean) ?? "";
    if (!text) continue;
    rows.push({ id: pattern.id, text, source: "language_pattern", weight: clamp01(0.46 * Math.min(1, pattern.support / 8) + 0.34 * weightedJaccard(requestFeatures, featureSet(text, 128)) + 0.2 * Number(activatedIds.has(pattern.id))), evidenceIds: pattern.evidenceIds.map(String) });
  }
  for (const frame of state.importedSemanticFrames.slice(0, 128)) {
    const text = jsonStrings(frame.frameJson, 12).map(cleanSurfacePiece).find(Boolean) ?? "";
    if (!text) continue;
    rows.push({ id: frame.id, text, source: "semantic_frame", weight: clamp01(0.5 * frame.alpha + 0.3 * weightedJaccard(requestFeatures, featureSet(text, 128)) + 0.2 * Number(activatedIds.has(frame.id))), evidenceIds: frame.evidenceIds.map(String) });
  }
  for (const observation of state.importedObservations.slice(0, 192)) {
    const text = cleanSurfacePiece([...observation.history.slice(-2), observation.symbol].join(" "));
    if (!text) continue;
    rows.push({ id: observation.id, text, source: "observation", weight: clamp01(Math.log2(1 + observation.count) / 12), evidenceIds: observation.evidenceId ? [String(observation.evidenceId)] : [] });
  }
  return rows.sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
}

function requestCompositionIngredients(requestText: string): CompositionIngredient[] {
  return requestSurfaceUnits(requestText).slice(0, 12).map((text, index) => ({
    id: stableId("request.term", { text, index }),
    text,
    source: "request",
    weight: 0.72,
    evidenceIds: []
  }));
}

function uniqueIngredients(rows: readonly CompositionIngredient[]): CompositionIngredient[] {
  const bySurface = new Map<string, CompositionIngredient>();
  for (const row of rows) {
    const key = normalizeSurface(row.text);
    if (!key) continue;
    const existing = bySurface.get(key);
    if (!existing || row.weight > existing.weight) bySurface.set(key, row);
  }
  return [...bySurface.values()].sort((left, right) => right.weight - left.weight || left.id.localeCompare(right.id));
}

function buildDraft(input: PlanInventionsInput, constraints: readonly ConstraintSeed[], ingredients: readonly CompositionIngredient[], graphIngredients: readonly CompositionIngredient[], variant: number): DraftComposition {
  const requestTerms = requestSurfaceUnits(input.requestText);
  const title = surfaceTitle(requestTerms.slice(0, 6).join(" ") || `composition.${stableId("title", input.requestText).slice(-8)}`);
  const rotated = rotate(ingredients, variant).slice(0, 3);
  while (rotated.length < 3) rotated.push({
    id: stableId("request.fallback", { variant, index: rotated.length }),
    text: requestTerms[rotated.length % Math.max(1, requestTerms.length)] ?? title,
    source: "request",
    weight: 0.5,
      evidenceIds: []
  });
  const graphChoice = graphIngredients[variant % Math.max(1, graphIngredients.length)];
  if (graphChoice && !rotated.some(row => row.source === "graph")) rotated[0] = graphChoice;
  const languageChoices = ingredients.filter(row => row.source !== "request" && row.source !== "graph");
  const languageChoice = languageChoices[variant % Math.max(1, languageChoices.length)];
  if (languageChoice && !rotated.some(row => row.source !== "request" && row.source !== "graph")) rotated[1] = languageChoice;
  const requestChoice = ingredients.find(row => row.source === "request");
  if (requestChoice && !rotated.some(row => row.source === "request")) rotated[2] = requestChoice;
  const constraintSurface = constraints.slice(0, 6).map(row => row.surface).join(" · ") || requestTerms.slice(0, 6).join(" · ") || title;
  const proposalSurface = evidenceSafeProposal(proposalShape(variant, title, rotated.map(row => row.text), constraintSurface), input.evidence, requestTerms, variant, title);
  const selectedGraphNodeIds = uniqueStrings(rotated.filter(row => row.graphNodeId).map(row => row.graphNodeId!));
  const selectedEdges = selectCompositionEdges(input.graph.edges, selectedGraphNodeIds, variant);
  for (const edge of selectedEdges) {
    if (!selectedGraphNodeIds.includes(String(edge.source))) selectedGraphNodeIds.push(String(edge.source));
    if (!selectedGraphNodeIds.includes(String(edge.target))) selectedGraphNodeIds.push(String(edge.target));
  }
  const selectedGraphRows = graphIngredients.filter(row => selectedGraphNodeIds.includes(row.graphNodeId ?? ""));
  const availableEvidenceIds = new Set(input.evidence.map(span => String(span.id)));
  const factualPremises = selectedGraphRows.filter(row => row.evidenceIds.length).map(row => ({
    id: stableId("claim.premise", { ingredient: row.id, evidenceIds: row.evidenceIds }),
    surface: row.text,
    force: "observed" as const,
    evidenceIds: uniqueStrings(row.evidenceIds),
    kind: "factual_premise" as const
  }));
  const deductions = selectedEdges.slice(0, 3).map(edge => ({
    id: stableId("claim.deduction", { edge: edge.id, relation: edge.relationId }),
    surface: String(edge.relationId),
    force: "inferred" as const,
    evidenceIds: uniqueStrings(edge.evidenceIds.map(String).filter(id => availableEvidenceIds.has(id))),
    kind: "deduction" as const
  }));
  const invention: InventionClaimBasis = {
    id: stableId("claim.invention", { title, proposalSurface }),
    surface: proposalSurface,
    force: "invented",
    evidenceIds: [],
    kind: "invention"
  };
  const untestedPerformanceClaim = constructRequestsPerformancePrediction(input.construct);
  const performance: InventionClaimBasis[] = untestedPerformanceClaim ? [{
    id: stableId("claim.performance", { title, request: input.requestText }),
    surface: `${title} ⟦semantic.role.performance_prediction⟧`,
    force: "conjectured",
    evidenceIds: [],
    kind: "performance_prediction"
  }] : [];
  const selectedLanguagePriorIds = uniqueStrings(rotated.filter(row => row.source !== "request" && row.source !== "graph").map(row => row.id));
  const basisPriorIds = uniqueStrings([...selectedGraphNodeIds, ...selectedLanguagePriorIds, ...selectedEdges.map(edge => String(edge.relationId))]);
  return {
    title,
    proposalSurface,
    artifactKindIds: artifactKindIds(input.construct),
    basisPriorIds,
    selectedGraphNodeIds,
    selectedLanguagePriorIds,
    selectedEdges,
    claimBasis: [...factualPremises, ...deductions, invention, ...performance],
    untestedPerformanceClaim
  };
}

function scoreDraft(input: PlanInventionsInput, draft: DraftComposition, constraints: readonly ConstraintSeed[], memorySurfaces: readonly string[], drafts: readonly DraftComposition[], index: number): ScoredComposition {
  const proposalFeatures = featureSet(draft.proposalSurface, 512);
  const constraintRows: InventionConstraintTrace[] = constraints.map(constraint => ({
    ...constraint,
    satisfied: normalizeSurface(draft.proposalSurface).includes(normalizeSurface(constraint.surface)) || weightedJaccard(proposalFeatures, featureSet(constraint.surface, 128)) >= 0.22
  }));
  const constraintWeight = constraintRows.reduce((sum, row) => sum + row.weight, 0);
  const constraintCoverage = constraintWeight > 0
    ? constraintRows.reduce((sum, row) => sum + row.weight * Number(row.satisfied), 0) / constraintWeight
    : 1;
  const graphCoherence = mean(draft.selectedEdges.map(edgeRelationPotential));
  const memorySimilarities = memorySurfaces.map(surface => weightedJaccard(proposalFeatures, featureSet(surface, 512)));
  const novelty = clamp01(1 - Math.max(0, ...memorySimilarities));
  const languageRealizability = kneserNeyRealizability(input.languageMemoryState, draft.proposalSurface);
  const requestFit = weightedJaccard(featureSet(input.requestText, 512), proposalFeatures);
  const actionability = clamp01(input.field.alphaTrace.surfaces.actionability);
  const completionPotential = constraintCoverage;
  const usefulness = mean([actionability, requestFit, completionPotential]);
  const contradictionPressure = clamp01(Math.max(input.field.alphaTrace.contradictionMass, input.field.alphaTrace.surfaces.contradiction));
  const internalConflict = Math.max(0, ...input.dialogueState.rejectedAssumptions.map(surface => weightedJaccard(proposalFeatures, featureSet(surface, 128))));
  const infeasibility = clamp01(Math.max(input.field.alphaTrace.surfaces.risk, input.dialogueState.unresolvedSlots.length / 16));
  const risk = Math.max(contradictionPressure, internalConflict, infeasibility);
  const repetition = Math.max(0, ...drafts
    .filter((_, otherIndex) => otherIndex !== index)
    .map(other => weightedJaccard(proposalFeatures, featureSet(other.proposalSurface, 512))));
  const unsupportedFactualAssertion = clamp01(draft.claimBasis
    .filter(record => record.kind === "factual_premise" && record.evidenceIds.length === 0)
    .length / Math.max(1, draft.claimBasis.filter(record => record.kind === "factual_premise").length));
  const bootstrapScore =
    0.28 * constraintCoverage +
    0.22 * graphCoherence +
    0.2 * novelty +
    0.15 * languageRealizability +
    0.15 * usefulness -
    0.3 * risk -
    0.2 * repetition -
    0.5 * unsupportedFactualAssertion;
  return {
    ...draft,
    constraintCoverage,
    constraints: constraintRows,
    graphCoherence,
    novelty,
    languageRealizability,
    usefulness,
    risk,
    repetition,
    unsupportedFactualAssertion,
    bootstrapScore,
    diversity: 1,
    probability: 0
  };
}

function diversityRank(candidates: readonly ScoredComposition[]): ScoredComposition[] {
  const remaining = [...candidates];
  const selected: ScoredComposition[] = [];
  while (remaining.length) {
    const ranked = remaining.map(candidate => {
      const maxSimilarity = Math.max(0, ...selected.map(prior => weightedJaccard(featureSet(candidate.proposalSurface, 512), featureSet(prior.proposalSurface, 512))));
      const diversity = 1 - maxSimilarity;
      return { candidate, diversity, score: candidate.probability * (0.72 + 0.28 * diversity) };
    }).sort((left, right) => right.score - left.score || right.candidate.bootstrapScore - left.candidate.bootstrapScore || left.candidate.proposalSurface.localeCompare(right.candidate.proposalSurface));
    const next = ranked[0]!;
    selected.push({ ...next.candidate, diversity: next.diversity });
    remaining.splice(remaining.indexOf(next.candidate), 1);
  }
  return selected;
}

function edgeRelationPotential(edge: GraphEdge): number {
  const metadata = jsonRecord(edge.metadata);
  const potential = jsonRecord(metadata.relationPotential);
  const calibrated = typeof potential.calibrated === "number" ? potential.calibrated : undefined;
  return calibrated === undefined ? clamp01(Math.sqrt(clamp01(edge.alpha) * clamp01(edge.weight))) : clamp01(calibrated);
}

function kneserNeyRealizability(state: LanguageMemoryRuntimeState, text: string): number {
  const symbols = symbolizeData(text).slice(0, 128);
  if (!symbols.length || !state.models.length) return 0;
  const model = [...state.models].sort((left, right) => right.order - left.order || right.observedSymbolCount - left.observedSymbolCount)[0]!;
  const padded = [...Array(Math.max(0, model.order - 1)).fill("<s>"), ...symbols, "</s>"];
  let logProbability = 0;
  let count = 0;
  for (let index = Math.max(0, model.order - 1); index < padded.length; index++) {
    const context = padded.slice(Math.max(0, index - model.order + 1), index);
    const symbol = padded[index] ?? "</s>";
    logProbability += Math.log(Math.max(1e-12, kneserNeyProbability(model, context, symbol)));
    count++;
  }
  return clamp01(Math.exp(logProbability / Math.max(1, count)));
}

function existingMemorySurfaces(input: PlanInventionsInput): string[] {
  return uniqueStrings([
    ...input.languageMemoryState.importedUnits.map(unit => unit.text),
    ...input.languageMemoryState.importedPatterns.flatMap(pattern => jsonStrings(pattern.patternJson, 8)),
    ...input.languageMemoryState.importedSemanticFrames.flatMap(frame => jsonStrings(frame.frameJson, 8)),
    ...input.languageMemoryState.importedObservations.map(observation => [...observation.history.slice(-3), observation.symbol].join(" ")),
    ...input.graph.nodes.flatMap(node => jsonStrings(node.representation, 6)),
    ...input.dialogueState.establishedFacts
  ].map(cleanSurfacePiece).filter(Boolean)).slice(0, 2048);
}

function selectCompositionEdges(edges: readonly GraphEdge[], nodeIds: readonly string[], variant: number): GraphEdge[] {
  const ids = new Set(nodeIds);
  const connected = edges.filter(edge => ids.has(String(edge.source)) && ids.has(String(edge.target)));
  const adjacent = edges.filter(edge => ids.has(String(edge.source)) || ids.has(String(edge.target)));
  const rows = connected.length ? connected : adjacent;
  return rotate([...rows].sort((left, right) => edgeRelationPotential(right) - edgeRelationPotential(left) || String(left.id).localeCompare(String(right.id))), variant).slice(0, 6);
}

function proposalShape(variant: number, title: string, pieces: readonly string[], constraints: string): string {
  const [a = title, b = title, c = title] = pieces;
  if (variant % 4 === 0) return `${title}: ${a} → ${b} → ${c}; ${constraints}.`;
  if (variant % 4 === 1) return `${constraints}: ${c} ← ${b} ← ${a} — ${title}.`;
  if (variant % 4 === 2) return `${a} + ${c} ⇢ ${title}; ${b} ⇄ ${constraints}.`;
  return `${title} — ${b}; ${constraints}; ${a} ↔ ${c}.`;
}

function evidenceSafeProposal(surface: string, evidence: readonly EvidenceSpan[], requestTerms: readonly string[], variant: number, title: string): string {
  if (!copiesCompleteEvidenceSentence(surface, evidence)) return tidyProposal(surface);
  const safe = requestTerms.slice(0, 8);
  const fallback = tidyProposal(proposalShape(variant, title, [safe[0] ?? title, safe[1] ?? title, safe[2] ?? title], safe.join(" · ") || title));
  if (!copiesCompleteEvidenceSentence(fallback, evidence)) return fallback;
  const opaque = stableId("composition", { variant, requestTerms }).slice(-16);
  return `⟦composition.${opaque}⟧:${variant + 1}.`;
}

function copiesCompleteEvidenceSentence(surface: string, evidence: readonly EvidenceSpan[]): boolean {
  const normalized = normalizeSurface(surface);
  return evidence.some(span => splitEvidenceSentences(span.text).some(sentence => {
    const source = normalizeSurface(sentence);
    return source.length >= 8 && normalized.includes(source);
  }));
}

function splitEvidenceSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\r?\n+/u).map(value => value.trim()).filter(Boolean);
}

function graphNodeSurface(node: GraphNode, evidence: readonly EvidenceSpan[], requestText: string): string {
  const candidates = [...jsonStrings(node.representation, 12), ...jsonStrings(node.metadata, 8), ...node.features.filter(feature => feature.startsWith("sym:")).map(feature => feature.slice(4))];
  const requestFeatures = featureSet(requestText, 256);
  return uniqueStrings(candidates.map(cleanSurfacePiece).filter(candidate => candidate && !copiesCompleteEvidenceSentence(candidate, evidence)))
    .map(candidate => ({ candidate, fit: weightedJaccard(requestFeatures, featureSet(candidate, 128)) }))
    .sort((left, right) => right.fit - left.fit || right.candidate.length - left.candidate.length || left.candidate.localeCompare(right.candidate))[0]?.candidate ?? "";
}

function artifactKindIds(construct: ConstructGraph): string[] {
  const kinds = construct.nodes.map(node => node.kind).filter(kind => kind.startsWith("construct:") || kind.startsWith("family:"));
  if (construct.program) kinds.push("artifact.kind.program");
  if (!kinds.length) kinds.push("artifact.kind.design");
  return uniqueStrings(kinds).sort().slice(0, 12);
}

function constructRequestsPerformancePrediction(construct: ConstructGraph): boolean {
  return construct.nodes.some(node => {
    if (node.kind === "construct:performance_prediction" || node.kind === "claim:performance_prediction") return true;
    const metadata = jsonRecord(node.metadata);
    return metadata.semanticRoleId === "semantic.role.performance_prediction"
      || metadata.claimBasisId === "claim.basis.performance_prediction";
  });
}

/**
 * Produces bounded surface units without interpreting any language. Every
 * Unicode letter/number symbol is treated alike; authority and operator choice
 * happen before this function through structured numeric state.
 */
function requestSurfaceUnits(text: string): string[] {
  return uniqueStrings(symbolizeData(text)
    .filter(symbol => /^[\p{Letter}\p{Number}_-]+$/u.test(symbol))
    .filter(Boolean))
    .slice(0, 24);
}

function cleanSurfacePiece(value: string): string {
  const clean = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean || clean.length > 96 || clean.includes("://") || !/[\p{Letter}\p{Number}]/u.test(clean)) return "";
  const symbols = symbolizeData(clean);
  if (!symbols.length || symbols.length > 8) return "";
  return clean.replace(/[.!?]+$/u, "");
}

function tidyProposal(value: string): string {
  return value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 1200);
}

function surfaceTitle(value: string): string {
  return tidyProposal(value).slice(0, 192);
}

function normalizeSurface(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{Letter}\p{Number}]+/gu, " ").replace(/\s+/gu, " ").trim();
}

function rotate<T>(rows: readonly T[], offset: number): T[] {
  if (!rows.length) return [];
  const start = ((offset % rows.length) + rows.length) % rows.length;
  return [...rows.slice(start), ...rows.slice(0, start)];
}

function jsonStrings(value: unknown, limit: number): string[] {
  const out: string[] = [];
  const visit = (item: unknown, depth: number) => {
    if (out.length >= limit || depth > 4 || item === null || item === undefined) return;
    if (typeof item === "string") {
      out.push(item);
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item.slice(0, limit)) visit(child, depth + 1);
      return;
    }
    if (typeof item === "object") {
      for (const key of Object.keys(item as Record<string, unknown>).sort().slice(0, limit)) visit((item as Record<string, unknown>)[key], depth + 1);
    }
  };
  visit(value, 0);
  return out.slice(0, limit);
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}.${createHasher().digestHex(canonicalStringify(value)).slice(0, 20)}`;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) throw new RangeError("invention candidate limit must be finite");
  return Math.max(minimum, Math.min(maximum, Math.floor(value)));
}
