import { DIALOGUE_ACTION_IDS, type DialogueState } from "./dialogue-pragmatics.js";
import { boltzmannDistribution } from "./equation-operators.js";
import { kneserNeyProbability } from "./kneser-ney.js";
import {
  englishCreativeStructuralRouteEvents,
  isEnglishCreativeEventStructurallyRealizable,
  MAX_ENGLISH_STRUCTURAL_CREATIVE_EVENTS
} from "./english-structural-realizer.js";
import {
  creativeEventCompatibilityDecision,
  creativeEventRolePosterior,
  type CreativeEventCompatibilityDecision,
  type CreativeRequestFrame,
  type CreativeRequestSpan
} from "./creative-event-compatibility.js";
import type { LanguageGenerationResult, LanguageMemoryRuntime, LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { createInventionConstruct, type InventionConstruct } from "./prediction.js";
import { canonicalStringify, clamp01, createHasher, featureSet, mean, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";
import { COGNITIVE_OPERATOR_IDS, type ActivatedOperator, type TurnRequirement, type TurnRequirementField } from "./turn-requirements.js";
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

// ---------------------------------------------------------------------------
// Compatibility boundary. Production invention planning starts at
// PlanInventionsInput below. This classifier accepts only structured IDs,
// learned activation, graph state, and explicit authority; request lexemes do
// not select an authority family.
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
 * @deprecated Compatibility classifier. Production routing uses
 * deriveTurnRequirementField plus numeric operator activation. This function
 * remains exported for legacy consumers, but planInventions never calls it and
 * request text never controls invention admission.
 */
export function classifyRequestedAuthority(input: AuthorityClassificationInput): RequestedAuthorityDecision {
  const model = input.model ?? AUTHORITY_BOOTSTRAP_MODEL;
  assertLegacyAuthorityModel(model);
  const temperature = boundedLegacyAuthorityTemperature(input.temperature ?? model.defaultTemperature);
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
  const structuredIds = new Set([
    ...(input.semanticFrameIds ?? []),
    ...(input.questionFeatures ?? []),
    ...(input.graph?.query.features ?? []),
    ...(input.dialogueState?.interactionFeatures.map(feature => feature.id) ?? [])
  ]);
  const features: Record<RequestedAuthorityFeatureId, number> = {
    "authority.feature.bias": 1,
    "authority.feature.request.question": legacyRequestQuestionSignal(input.requestText, structuredIds),
    "authority.feature.request.reasoned": structuredAuthoritySignal(structuredIds, "authority.feature.request.reasoned"),
    "authority.feature.request.creative": structuredAuthoritySignal(structuredIds, "authority.feature.request.creative"),
    "authority.feature.request.translation": structuredAuthoritySignal(structuredIds, "authority.feature.request.translation"),
    "authority.feature.request.program": structuredAuthoritySignal(structuredIds, "authority.feature.request.program"),
    "authority.feature.request.action": structuredAuthoritySignal(structuredIds, "authority.feature.request.action"),
    "authority.feature.dialogue.artifact": actionIds.has(DIALOGUE_ACTION_IDS.artifact) ? 1 : structuredAuthoritySignal(structuredIds, "authority.feature.dialogue.artifact"),
    "authority.feature.dialogue.plan": actionIds.has(DIALOGUE_ACTION_IDS.plan) || actionIds.has(DIALOGUE_ACTION_IDS.nextStep) ? 1 : structuredAuthoritySignal(structuredIds, "authority.feature.dialogue.plan"),
    "authority.feature.dialogue.boundary": actionIds.has(DIALOGUE_ACTION_IDS.boundary) ? 1 : structuredAuthoritySignal(structuredIds, "authority.feature.dialogue.boundary"),
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
  > & Partial<Pick<TurnRequirementField, "requiredFeatures">>;
  /** Numeric operator state; learned IDs select the invention lane. */
  operatorActivations?: readonly ActivatedOperator[];
  /** Source-language adapter output. IDs are opaque to cognitive planning. */
  creativeRequestFrame?: CreativeRequestFrame;
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
  proposalRealization: ProposalRealizationTrace;
  artifactKindIds: string[];
  basisPriorIds: string[];
  selectedGraphNodeIds: string[];
  selectedLanguagePriorIds: string[];
  selectedEdges: GraphEdge[];
  claimBasis: InventionClaimBasis[];
  untestedPerformanceClaim: boolean;
}

interface ProposalRealizationTrace {
  path: "learned_continuation" | "learned_structural_composition" | "mouth_realization_deferred" | "composition_fallback";
  semanticPlanId?: string;
  contextSymbols: string[];
  generationTextHash?: string;
  generationConfidence?: number;
  discourseScore?: number;
  cohesion?: number;
  repetitionPenalty?: number;
  sourcePieceIds?: string[];
  requestConstraintIds?: string[];
  requestConstraintSourceActivationIds?: string[];
  requestConstraintCoverage?: number;
  requestSlotSpans?: Array<{
    text: string;
    charStart: number;
    charEnd: number;
    byteStart: number;
    byteEnd: number;
    sourceActivationId: string;
  }>;
  structuralSourceIds?: string[];
  structuralBundleIds?: string[];
  structuralEventPlan?: StructuralCreativeEventPlanRecord[];
  structuralSentenceCount?: number;
  structuralRealizability?: number;
  stoppedBy?: LanguageGenerationResult["stoppedBy"];
}

type LearnedProposal = {
  surface: string;
  trace: ProposalRealizationTrace;
};

interface LearnedProposalReuse {
  attempted: boolean;
  proposal?: LearnedProposal;
}

type StructuralCreativeDiscourseRelationId =
  | "scce.relation.concurrent"
  | "scce.relation.subsequent"
  | "scce.relation.contrastive"
  | "scce.relation.resolution";

type StructuralCreativeDiscourseBridgeBasisId =
  | "scce.discourse.bridge.source_adjacency"
  | "scce.discourse.bridge.invented_macro";

interface StructuralCreativeEventPlanRecord {
  outputIndex: number;
  bundleId: string;
  eventId: string;
  profileId: string;
  constructionId: string;
  relationId: string;
  roleIds: string[];
  discourseRelationId: StructuralCreativeDiscourseRelationId;
  discourseBridgeBasisId: StructuralCreativeDiscourseBridgeBasisId;
  discourseBeatId: string;
  requestRoleBindings: Array<{
    eventRoleId: "scce.role.patient" | "scce.role.complement";
    requestArgumentId: string;
    requestRoleId: string;
    requestSpan: CreativeRequestSpan;
    rolePosterior: number;
    roleThreshold: number;
    admissible: true;
  }>;
  compatibilityModelId: string;
  compatibilityModelVersion: string;
  compatibilityCalibrationId: string;
  compatibilityThreshold: number;
  requestFit: number;
  graphFit: number;
  routeFit: number;
  routeId: string;
  routeAnchorEventId: string;
  sourceOrdinal: number;
  sourceVersionId: string;
  evidenceId: string;
}

type DurableCreativeEvent =
  NonNullable<LanguageMemoryRuntimeState["importedConstructionBundles"][number]["creativeEvents"]>[number];

interface RequestOwnedCreativeConstraint {
  id: string;
  surface: string;
  semanticRoleId: string;
  learnedFrameOrPatternId: string;
  sourceActivationId: string;
  confidence: number;
  value: number;
  requestSpan: TurnRequirement["origin"]["requestSpan"];
}

interface RequestOwnedLanguageActivationSpan {
  id: string;
  sourceActivationId: string;
  surface: string;
  normalizedSymbols: string[];
  sourceVersionId: string;
  alpha: number;
  unitKind: LanguageMemoryRuntimeState["importedUnits"][number]["unitKind"];
  requestSpan: TurnRequirement["origin"]["requestSpan"];
}

interface RequestOwnedCreativeSlots {
  anchor: RequestOwnedLanguageActivationSpan;
  anchoredSlot: TurnRequirement["origin"]["requestSpan"];
  continuationSlot: TurnRequirement["origin"]["requestSpan"];
}

interface LearnedStructuralSource {
  id: string;
  sourceVersionId: string;
  evidenceIds: string[];
  alpha: number;
  sentences: string[];
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
const MAX_STRUCTURAL_CREATIVE_EVENTS = MAX_ENGLISH_STRUCTURAL_CREATIVE_EVENTS;

function productionStructuralCreativeBundles(
  input: PlanInventionsInput
): LanguageMemoryRuntimeState["importedConstructionBundles"] {
  const scope = input.languageMemoryState.scope;
  if (input.requestedAuthority !== "creative"
    || scope.mode !== "cluster"
    || !scope.purityProven
    || scope.degraded
    || !scope.profileIds.length
    || !scope.sourceVersionIds.length) return [];
  const profileIds = new Set(scope.profileIds);
  const sourceVersionIds = new Set(scope.sourceVersionIds);
  return input.languageMemoryState.importedConstructionBundles.filter(bundle => {
    if (!profileIds.has(bundle.sourceProfileId)
      || !profileIds.has(bundle.targetProfileId)
      || !bundle.sourceVersionIds.length
      || bundle.sourceVersionIds.some(id => !sourceVersionIds.has(id))) return false;
    const evidenceIds = new Set(bundle.evidenceIds);
    const events = bundle.creativeEvents?.filter(structurallyUsableCreativeEvent) ?? [];
    return events.length >= 4
      && events.every(event => (
        event.profileId === bundle.sourceProfileId
        && profileIds.has(event.profileId)
        && sourceVersionIds.has(event.sourceVersionId)
        && bundle.sourceVersionIds.includes(event.sourceVersionId)
        && evidenceIds.has(event.evidenceId)
      ));
  });
}

/**
 * Builds bounded, inspectable invention constructs in the existing construct
 * lane. Evidence can support factual premises, but is never required for the
 * invented material itself.
 */
export function planInventions(input: PlanInventionsInput): InventionConstruct[] {
  const planningActivation = inventionPlanningActivation(input);
  if (!planningActivation.admissible) return [];
  const structuralBundles = productionStructuralCreativeBundles(input);
  const maxCandidates = boundedInteger(input.maxCandidates ?? 4, 1, 8);
  const constraints = extractConstraints(input).slice(0, 16);
  const graphIngredients = graphCompositionIngredients(input).slice(0, 12);
  const languageIngredients = languageCompositionIngredients(input).slice(0, 18);
  const requestIngredients = requestCompositionIngredients(input.requestText);
  const ingredients = uniqueIngredients([...graphIngredients, ...languageIngredients, ...requestIngredients]);
  const structuralMemoryAvailable = structuralBundles.length > 0;
  const structuralCandidateLimit = structuralMemoryAvailable
    ? Math.min(maxCandidates, 3)
    : maxCandidates;
  const learnedProposalReuse: LearnedProposalReuse = { attempted: false };
  const uniqueDrafts = Array.from({ length: structuralCandidateLimit + 2 }, (_, index) =>
    buildDraft(input, constraints, ingredients, graphIngredients, index, structuralBundles, learnedProposalReuse)
  )
    .filter(draft => Boolean(draft.proposalSurface) && !containsInternalSurfaceIdentifier(draft.proposalSurface))
    .filter((draft, index, all) => all.findIndex(candidate => draftCompositionIdentity(candidate) === draftCompositionIdentity(draft)) === index);
  const admittedStructuralBundleIds = new Set(structuralBundles.map(bundle => bundle.id));
  const structuralDrafts = uniqueDrafts.filter(draft => (
    draft.proposalRealization.path === "mouth_realization_deferred"
    && Boolean(draft.proposalRealization.semanticPlanId)
    && (draft.proposalRealization.structuralEventPlan?.length ?? 0) >= 4
    && (draft.proposalRealization.structuralBundleIds?.length ?? 0) > 0
    && draft.proposalRealization.structuralBundleIds?.every(id => admittedStructuralBundleIds.has(id))
  ));
  const productionStructuralAuthority = structuralDrafts.length > 0;
  const learnedDrafts = uniqueDrafts.filter(draft => draft.proposalRealization.path !== "composition_fallback");
  const coldStartFallbackActive = !productionStructuralAuthority && learnedDrafts.length === 0;
  const drafts = (
    productionStructuralAuthority
      ? structuralDrafts
      : coldStartFallbackActive ? uniqueDrafts : learnedDrafts
  ).slice(0, structuralCandidateLimit);
  if (productionStructuralAuthority && drafts.length === 0) return [];
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
        selectionCalibration: {
          calibrated: false,
          status: "provisional_uncalibrated",
          finalSelectionAuthority: "candidate_engine_and_judge"
        },
        rank: index + 1,
        plannerPreferred: index === 0,
        diversity: candidate.diversity,
        temperature,
        samplingDisabled: input.samplingDisabled ?? true,
        selectedGraphNodeIds: candidate.selectedGraphNodeIds,
        selectedGraphEdgeIds: candidate.selectedEdges.map(edge => String(edge.id)),
        selectedLanguagePriorIds: candidate.selectedLanguagePriorIds,
        proposalRealization: candidate.proposalRealization,
        structuralSemanticPlan: candidate.proposalRealization.path === "mouth_realization_deferred"
          ? {
            schema: "scce.structural_semantic_plan.v2",
            id: candidate.proposalRealization.semanticPlanId ?? null,
            sourceBundleIds: candidate.proposalRealization.structuralBundleIds ?? [],
            events: candidate.proposalRealization.structuralEventPlan ?? [],
            contextSymbols: candidate.proposalRealization.contextSymbols,
            selectionAuthority: "candidate_engine_and_judge",
            surfaceRealizationCompetitive: false,
            featureStatus: "provisional_uncalibrated"
          }
          : null,
        proposalSelectionGuard: {
          id: productionStructuralAuthority
            ? "guard.invention.production_structural_authority.v1"
            : "guard.invention.learned_realization_priority.v1",
          productionStructuralAuthority,
          coldStartFallbackActive,
          learnedCandidateCount: productionStructuralAuthority ? 0 : learnedDrafts.length,
          structuralCandidateCount: structuralDrafts.length,
          fallbackCandidateCount: productionStructuralAuthority ? 0 : uniqueDrafts.length - learnedDrafts.length
        },
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

function draftCompositionIdentity(draft: DraftComposition): string {
  return draft.proposalRealization.path === "mouth_realization_deferred"
    ? draft.proposalRealization.semanticPlanId ?? canonicalStringify(toJsonValue(draft.proposalRealization.structuralEventPlan ?? []))
    : normalizeSurface(draft.proposalSurface);
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

function legacyRequestQuestionSignal(text: string, structuredIds: ReadonlySet<string>): number {
  const punctuation = text.trim().endsWith("?") ? 1 : 0;
  return Math.max(punctuation, structuredAuthoritySignal(structuredIds, "authority.feature.request.question"));
}

function structuredAuthoritySignal(ids: ReadonlySet<string>, featureId: RequestedAuthorityFeatureId): number {
  return ids.has(featureId) ? 1 : 0;
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

function requestOwnedCreativeConstraints(input: PlanInventionsInput): RequestOwnedCreativeConstraint[] {
  const requestPoints = [...input.requestText];
  const rows: RequestOwnedCreativeConstraint[] = [];
  for (const requirement of input.requirementField?.requiredFeatures ?? []) {
    const span = requirement.origin.requestSpan;
    if (!requirement.id || !requirement.sourceActivationId || !requirement.origin.learnedFrameOrPatternId) continue;
    if (!requirement.origin.semanticRoleId || requirement.origin.semanticRoleId === "role.structural.unspecified.v1") continue;
    if (requirement.origin.semanticRoleId === "role.request.authority.v1") continue;
    if (!Number.isInteger(span.charStart) || !Number.isInteger(span.charEnd) || span.charStart < 0 || span.charEnd <= span.charStart || span.charEnd > requestPoints.length) continue;
    if (span.charStart === 0 && span.charEnd === requestPoints.length) continue;
    const surface = requestPoints.slice(span.charStart, span.charEnd).join("");
    const prefix = requestPoints.slice(0, span.charStart).join("");
    if (!surface || surface !== span.text || surface !== surface.trim() || surface.length > 256) continue;
    if (new TextEncoder().encode(prefix).byteLength !== span.byteStart || new TextEncoder().encode(prefix + surface).byteLength !== span.byteEnd) continue;
    if (!/[\p{Letter}\p{Number}]/u.test(surface)) continue;
    rows.push({
      id: requirement.id,
      surface,
      semanticRoleId: requirement.origin.semanticRoleId,
      learnedFrameOrPatternId: requirement.origin.learnedFrameOrPatternId,
      sourceActivationId: requirement.sourceActivationId,
      confidence: clamp01(requirement.confidence),
      value: clamp01(requirement.value),
      requestSpan: span
    });
  }
  const bySurface = new Map<string, RequestOwnedCreativeConstraint>();
  for (const row of rows) {
    const key = normalizeSurface(row.surface);
    const previous = bySurface.get(key);
    if (!previous || Math.max(row.confidence, row.value) > Math.max(previous.confidence, previous.value)) bySurface.set(key, row);
  }
  return [...bySurface.values()].sort((left, right) => (
    Math.max(right.confidence, right.value) - Math.max(left.confidence, left.value)
    || left.requestSpan.charStart - right.requestSpan.charStart
    || left.id.localeCompare(right.id)
  ));
}

function extractConstraints(input: PlanInventionsInput): ConstraintSeed[] {
  const activatedSlots = requestOwnedCreativeSlots(input)[0];
  const requestTerms = activatedSlots
    ? requestSurfaceUnits(activatedSlots.continuationSlot.text).slice(0, 10)
    : requestSurfaceUnits(input.requestText).slice(0, 10);
  const requestOwned = requestOwnedCreativeConstraints(input);
  const rows: ConstraintSeed[] = requestOwned.map(constraint => ({
    id: constraint.id,
    surface: constraint.surface,
    weight: 1 + Math.max(constraint.confidence, constraint.value)
  }));
  rows.push(...requestTerms.map((surface, index) => ({
    id: stableId("constraint.request", { surface, index }),
    surface,
    weight: Number((1 + Math.min(0.5, [...surface].length / 24)).toFixed(6))
  })));
  for (const node of input.construct.nodes) {
    const metadata = jsonRecord(node.metadata);
    const explicit = [metadata.constraints, metadata.requiredTerms, metadata.artifactKindIds].flatMap(value => jsonStrings(value, 16));
    for (const surface of explicit
      .map(cleanSurfacePiece)
      .filter(surface => surface && surfaceOwnedByRequestOrEvidence(surface, input.requestText, input.evidence))) {
      rows.push({ id: stableId("constraint.construct", { nodeId: node.id, surface }), surface, weight: 1.5 });
    }
  }
  for (const surface of input.dialogueState.unresolvedSlots
    .map(cleanSurfacePiece)
    .filter(surface => surface && surfaceOwnedByRequestOrEvidence(surface, input.requestText, input.evidence))
    .slice(0, 6)) {
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
  const requestFeatures = featureSet(input.requestText, 512);
  return input.graph.nodes.map(node => {
    const text = graphNodeSurface(node, input.evidence, input.requestText);
    const requestFit = text ? weightedJaccard(requestFeatures, featureSet(text, 256)) : 0;
    return {
      id: String(node.id),
      text,
      source: "graph" as const,
      weight: clamp01((
        0.46 * (active.get(String(node.id)) ?? 0)
        + 0.34 * (ppf.get(String(node.id)) ?? 0)
        + 0.2 * node.alpha
      ) * (0.25 + 0.75 * requestFit)),
      evidenceIds: node.evidenceIds.map(String).filter(id => availableEvidenceIds.has(id)),
      graphNodeId: String(node.id),
      requestFit
    };
  }).filter(row => Boolean(row.text) && row.requestFit >= 0.04)
    .sort((left, right) => right.requestFit - left.requestFit || right.weight - left.weight || left.id.localeCompare(right.id))
    .map(({ requestFit: _requestFit, ...row }) => row);
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
    const text = sourceSurfaceFields(pattern.patternJson).map(cleanSurfacePiece).find(Boolean) ?? "";
    if (!text) continue;
    rows.push({ id: pattern.id, text, source: "language_pattern", weight: clamp01(0.46 * Math.min(1, pattern.support / 8) + 0.34 * weightedJaccard(requestFeatures, featureSet(text, 128)) + 0.2 * Number(activatedIds.has(pattern.id))), evidenceIds: pattern.evidenceIds.map(String) });
  }
  for (const frame of state.importedSemanticFrames.slice(0, 128)) {
    const text = sourceSurfaceFields(frame.frameJson).map(cleanSurfacePiece).find(Boolean) ?? "";
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

function buildStructuralCreativeEventPlan(
  input: PlanInventionsInput,
  variant: number,
  structuralBundles: LanguageMemoryRuntimeState["importedConstructionBundles"]
): StructuralCreativeEventPlanRecord[] {
  const requestFrame = input.creativeRequestFrame;
  if (!requestFrame || !validCreativeRequestFrame(input.requestText, requestFrame)) return [];
  const compatibilityModels = input.languageMemoryState.creativeEventCompatibilityModels;
  if (!compatibilityModels.some(model => (
    model.reliability === "calibrated"
    && model.requestCompilerId === requestFrame.compilerId
  ))) return [];
  const structuralEventLimit = structuralCreativeEventLimit(input);
  const admitted = structuralBundles
    .flatMap(bundle => {
      const events = englishCreativeStructuralRouteEvents(bundle.creativeEvents ?? [])
        .sort((left, right) => left.sourceOrdinal - right.sourceOrdinal || left.id.localeCompare(right.id));
      const routeIndexByEventId = new Map(events.map((event, routeIndex) => [event.id, routeIndex]));
      const compatible = events.flatMap(event => {
        const compatibility = creativeEventCompatibilityDecision(
          compatibilityModels,
          requestFrame,
          event
        );
        if (!compatibility || compatibility.posterior < compatibility.threshold) return [];
        const requestRoleBindings = creativeRequestRoleBindings(
          compatibilityModels,
          requestFrame,
          event
        );
        if (!requestRoleBindings) return [];
        const routeIndex = routeIndexByEventId.get(event.id);
        if (routeIndex === undefined) return [];
        const graphFit = structuralCreativeEventGraphFit(input, event);
        return [{
          bundleId: bundle.id,
          event,
          routeIndex,
          requestRoleBindings,
          compatibility,
          requestFit: compatibility.posterior,
          graphFit,
          routeFit: clamp01(
            1 - (1 - compatibility.posterior) * (1 - graphFit)
          )
        }];
      });
      if (!compatible.length) return [];
      const anchor = [...compatible].sort(compareCompatibleCreativeEvents)[0]!;
      const routeId = stableId("semantic.creative.event.route", {
        bundleId: bundle.id,
        requestFrameId: requestFrame.id,
        compatibilityModelId: anchor.compatibility.modelId,
        admittedEventIds: compatible.map(row => row.event.id)
      });
      return compatible.map(row => ({
        ...row,
        routeId,
        routeAnchorEventId: anchor.event.id
      }));
    });
  if (admitted.length < 4) return [];
  const rowsByRelationId = new Map<string, typeof admitted>();
  for (const row of admitted) {
    const rows = rowsByRelationId.get(row.event.relationId) ?? [];
    rows.push(row);
    rowsByRelationId.set(row.event.relationId, rows);
  }
  const relationGroups = [...rowsByRelationId.entries()]
    .map(([relationId, rows]) => ({
      relationId,
      rows: [...rows].sort(compareCompatibleCreativeEvents)
    }))
    .sort((left, right) => (
      compareCompatibleCreativeEvents(left.rows[0]!, right.rows[0]!)
      || left.relationId.localeCompare(right.relationId)
    ));
  const orderedGroups = rotate(relationGroups, variant % relationGroups.length);
  const selected: typeof admitted = [];
  for (let round = 0; selected.length < structuralEventLimit; round++) {
    let added = false;
    for (const group of orderedGroups) {
      const row = group.rows[round];
      if (!row) continue;
      selected.push(row);
      added = true;
      if (selected.length >= structuralEventLimit) break;
    }
    if (!added) break;
  }
  return selected.map((row, outputIndex) => {
    const previous = selected[outputIndex - 1];
    const discourseRelationId = structuralCreativeDiscourseRelation(outputIndex, selected.length);
    const discourseBeatOrdinal = Math.floor(outputIndex / 18);
    const discourseBeatId = stableId("semantic.creative.discourse.beat", {
      routeId: row.routeId,
      discourseRelationId,
      discourseBeatOrdinal
    });
    const sourceAdjacent = Boolean(
      previous
      && previous.bundleId === row.bundleId
      && previous.routeId === row.routeId
      && previous.routeIndex + 1 === row.routeIndex
    );
    return {
      outputIndex,
      bundleId: row.bundleId,
      eventId: row.event.id,
      profileId: row.event.profileId,
      constructionId: row.event.constructionId,
      relationId: row.event.relationId,
      roleIds: [...row.event.roleIds],
      discourseRelationId,
      discourseBridgeBasisId: sourceAdjacent
        ? "scce.discourse.bridge.source_adjacency"
        : "scce.discourse.bridge.invented_macro",
      discourseBeatId,
      requestRoleBindings: row.requestRoleBindings,
      compatibilityModelId: row.compatibility.modelId,
      compatibilityModelVersion: row.compatibility.modelVersion,
      compatibilityCalibrationId: row.compatibility.calibrationId,
      compatibilityThreshold: row.compatibility.threshold,
      requestFit: row.requestFit,
      graphFit: row.graphFit,
      routeFit: row.routeFit,
      routeId: row.routeId,
      routeAnchorEventId: row.routeAnchorEventId,
      sourceOrdinal: row.event.sourceOrdinal,
      sourceVersionId: row.event.sourceVersionId,
      evidenceId: row.event.evidenceId
    };
  });
}

function compareCompatibleCreativeEvents(
  left: {
    compatibility: CreativeEventCompatibilityDecision;
    graphFit: number;
    event: DurableCreativeEvent;
  },
  right: {
    compatibility: CreativeEventCompatibilityDecision;
    graphFit: number;
    event: DurableCreativeEvent;
  }
): number {
  return right.compatibility.posterior - left.compatibility.posterior
    || right.graphFit - left.graphFit
    || left.event.sourceOrdinal - right.event.sourceOrdinal
    || left.event.id.localeCompare(right.event.id);
}

function creativeRequestRoleBindings(
  models: ReadonlyArray<LanguageMemoryRuntimeState["creativeEventCompatibilityModels"][number]>,
  frame: CreativeRequestFrame,
  event: DurableCreativeEvent
): StructuralCreativeEventPlanRecord["requestRoleBindings"] | undefined {
  const bindings = event.argumentFrame.bindings
    .filter((binding): binding is typeof binding & {
      roleId: "scce.role.patient" | "scce.role.complement";
    } => binding.roleId === "scce.role.patient" || binding.roleId === "scce.role.complement");
  if (bindings.length !== event.argumentFrame.bindings.length) return undefined;
  if (!bindings.length) return [];
  const orderedBindings = [...bindings].sort((left, right) => left.roleId.localeCompare(right.roleId));
  const matchFrom = (
    bindingIndex: number,
    usedArguments: ReadonlySet<string>
  ): StructuralCreativeEventPlanRecord["requestRoleBindings"] | undefined => {
    const binding = orderedBindings[bindingIndex];
    if (!binding) return [];
    const candidates = frame.arguments
      .filter(argument => !usedArguments.has(argument.id))
      .flatMap(argument => {
        const compatibility = creativeEventRolePosterior(
          models,
          frame,
          argument.roleId,
          binding.roleId
        );
        return compatibility && compatibility.posterior >= compatibility.threshold
          ? [{ argument, compatibility }]
          : [];
      })
      .sort((left, right) => (
        right.compatibility.posterior - left.compatibility.posterior
        || left.argument.id.localeCompare(right.argument.id)
      ));
    const selected = candidates[0];
    if (!selected) return undefined;
    for (const candidate of candidates) {
      const nextUsed = new Set(usedArguments);
      nextUsed.add(candidate.argument.id);
      const remaining = matchFrom(bindingIndex + 1, nextUsed);
      if (!remaining) continue;
      return [{
        eventRoleId: binding.roleId,
        requestArgumentId: candidate.argument.id,
        requestRoleId: candidate.argument.roleId,
        requestSpan: { ...candidate.argument.span },
        rolePosterior: candidate.compatibility.posterior,
        roleThreshold: candidate.compatibility.threshold,
        admissible: true
      }, ...remaining];
    }
    return undefined;
  };
  return matchFrom(0, new Set());
}

function validCreativeRequestFrame(
  requestText: string,
  frame: CreativeRequestFrame
): boolean {
  if (!frame.id || !frame.compilerId || !frame.focus.id || !frame.focus.roleId) return false;
  const roles = [frame.focus, ...frame.arguments];
  if (new Set(roles.map(role => role.id)).size !== roles.length) return false;
  return roles.every(role => (
    Boolean(role.roleId)
    && exactCreativeRequestSpan(requestText, role.span)
  ));
}

function exactCreativeRequestSpan(
  requestText: string,
  span: CreativeRequestSpan
): boolean {
  const points = [...requestText];
  if (!Number.isSafeInteger(span.charStart)
    || !Number.isSafeInteger(span.charEnd)
    || span.charStart < 0
    || span.charEnd <= span.charStart
    || span.charEnd > points.length) return false;
  const surface = points.slice(span.charStart, span.charEnd).join("");
  const prefix = points.slice(0, span.charStart).join("");
  return surface === span.text
    && new TextEncoder().encode(prefix).byteLength === span.byteStart
    && new TextEncoder().encode(prefix + surface).byteLength === span.byteEnd;
}

function structuralCreativeEventLimit(input: PlanInventionsInput): number {
  const requestPoints = [...input.requestText];
  let targetWords = 360;
  for (const requirement of input.requirementField?.requiredFeatures ?? []) {
    const responseExtent = jsonRecord(
      jsonRecord(jsonRecord(requirement.trace).activationTrace).responseExtent
    );
    const wordsPerUnit = typeof responseExtent.wordsPerUnit === "number"
      && Number.isFinite(responseExtent.wordsPerUnit)
      && responseExtent.wordsPerUnit > 0
      ? responseExtent.wordsPerUnit
      : 0;
    if (!wordsPerUnit) continue;
    const span = requirement.origin.requestSpan;
    const context = requestPoints.slice(
      Math.max(0, span.charStart - 32),
      Math.min(requestPoints.length, span.charEnd + 12)
    ).join("");
    const quantities = [...context.matchAll(/\p{Number}+(?:[.,]\p{Number}+)?/gu)]
      .map(match => Number(match[0].replaceAll(",", "")))
      .filter(value => Number.isFinite(value) && value > 0);
    const quantity = quantities.at(-1);
    if (quantity) targetWords = Math.max(targetWords, quantity * wordsPerUnit);
  }
  return boundedInteger(
    Math.ceil(targetWords / 3 * 1.1),
    120,
    MAX_STRUCTURAL_CREATIVE_EVENTS
  );
}

function structuralCreativeEventGraphFit(
  input: PlanInventionsInput,
  event: DurableCreativeEvent
): number {
  const evidenceId = String(event.evidenceId);
  return Math.max(0, ...input.graph.edges
    .filter(edge => (
      String(edge.relationId) === event.relationId
      || edge.evidenceIds.some(id => String(id) === evidenceId)
    ))
    .map(edgeRelationPotential));
}

function structurallyUsableCreativeEvent(event: DurableCreativeEvent): boolean {
  return isEnglishCreativeEventStructurallyRealizable(event);
}

function structuralCreativeDiscourseRelation(
  outputIndex: number,
  eventCount: number
): StructuralCreativeDiscourseRelationId {
  const progress = outputIndex / Math.max(1, eventCount - 1);
  if (progress < 0.34) return "scce.relation.concurrent";
  if (progress < 0.68) return "scce.relation.subsequent";
  if (progress < 0.88) return "scce.relation.contrastive";
  return "scce.relation.resolution";
}

function structuralCreativePlanRealizability(
  events: readonly StructuralCreativeEventPlanRecord[]
): number {
  if (events.length < 4) return 0;
  return clamp01(mean(events.map(event => mean([
    Number(event.roleIds.includes("scce.role.agent")),
    Number(Boolean(event.relationId)),
    Number(Boolean(event.constructionId)),
    Number(event.discourseRelationId.startsWith("scce.relation."))
  ]))));
}

function buildDraft(
  input: PlanInventionsInput,
  constraints: readonly ConstraintSeed[],
  ingredients: readonly CompositionIngredient[],
  graphIngredients: readonly CompositionIngredient[],
  variant: number,
  structuralBundles: LanguageMemoryRuntimeState["importedConstructionBundles"],
  learnedProposalReuse: LearnedProposalReuse
): DraftComposition {
  const structuralEventPlan = structuralBundles.length > 0
    ? buildStructuralCreativeEventPlan(input, variant, structuralBundles)
    : [];
  const deferSurfaceRealization = structuralEventPlan.length >= 4;
  const requestTerms = requestSurfaceUnits(input.requestText);
  const activatedSlots = requestOwnedCreativeSlots(input)[0];
  const title = surfaceTitle(activatedSlots?.continuationSlot.text ?? requestTerms.slice(0, 6).join(" "));
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
  const constraintSurface = constraints.slice(0, 6).map(row => row.surface).join("; ") || requestTerms.slice(0, 6).join("; ") || title;
  const learnedProposal = deferSurfaceRealization
    ? undefined
    : reusedLearnedProposalFromMemory(input, requestTerms, variant, learnedProposalReuse);
  const structuralBundleIds = uniqueStrings(structuralEventPlan.map(event => event.bundleId));
  const shapedProposal = deferSurfaceRealization
    ? title
    : proposalShape(variant, title, rotated.map(row => row.text), constraintSurface);
  const proposalSurface = deferSurfaceRealization
    ? title
    : evidenceSafeProposal(learnedProposal?.surface ?? shapedProposal, input.evidence, requestTerms, variant, title);
  const proposalRealization: ProposalRealizationTrace = deferSurfaceRealization
    ? {
      path: "mouth_realization_deferred",
      semanticPlanId: stableId("semantic.realization.plan", {
        requestTerms,
        structuralBundleIds,
        structuralEventPlan,
        constraintIds: constraints.map(row => row.id),
        variant
      }),
      contextSymbols: requestTerms,
      requestConstraintIds: constraints.map(row => row.id),
      requestConstraintCoverage: 1,
      structuralBundleIds,
      structuralEventPlan,
      structuralSentenceCount: structuralEventPlan.length,
      structuralRealizability: structuralCreativePlanRealizability(structuralEventPlan)
    }
    : learnedProposal && normalizeSurface(proposalSurface) === normalizeSurface(learnedProposal.surface)
      ? learnedProposal.trace
      : { path: "composition_fallback", contextSymbols: learnedProposal?.trace.contextSymbols ?? [] };
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
    surface: title,
    force: "conjectured",
    evidenceIds: [],
    kind: "performance_prediction"
  }] : [];
  const selectedLanguagePriorIds = uniqueStrings([
    ...rotated.filter(row => row.source !== "request" && row.source !== "graph").map(row => row.id),
    ...(proposalRealization.sourcePieceIds ?? []),
    ...(proposalRealization.structuralSourceIds ?? []),
    ...(proposalRealization.structuralBundleIds ?? []),
    ...(proposalRealization.structuralEventPlan?.map(event => event.eventId) ?? [])
  ]);
  const basisPriorIds = uniqueStrings([...selectedGraphNodeIds, ...selectedLanguagePriorIds, ...selectedEdges.map(edge => String(edge.relationId))]);
  return {
    title,
    proposalSurface,
    proposalRealization,
    artifactKindIds: artifactKindIds(input.construct),
    basisPriorIds,
    selectedGraphNodeIds,
    selectedLanguagePriorIds,
    selectedEdges,
    claimBasis: [...factualPremises, ...deductions, invention, ...performance],
    untestedPerformanceClaim
  };
}

/**
 * Realizes an invention through hydrated language memory before the bounded
 * cold-start composition path. The seed comes from the request and the
 * continuation from source-owned memory; this boundary contains no
 * language-specific vocabulary.
 */
function reusedLearnedProposalFromMemory(
  input: PlanInventionsInput,
  requestTerms: readonly string[],
  variant: number,
  reuse: LearnedProposalReuse
): LearnedProposal | undefined {
  if (reuse.attempted) return reuse.proposal;
  reuse.proposal = learnedProposalFromMemory(input, requestTerms, variant);
  reuse.attempted = true;
  return reuse.proposal;
}

function learnedProposalFromMemory(input: PlanInventionsInput, requestTerms: readonly string[], variant: number): LearnedProposal | undefined {
  if (!requestTerms.length || !input.languageMemoryState.models.length) return undefined;
  const requestConstraints = requestOwnedCreativeConstraints(input);
  if (!requestConstraints.length) {
    const structural = learnedStructuralProposalFromMemory(input);
    if (structural) return structural;
  }
  const requestConstraint = requestConstraints.length ? requestConstraints[variant % requestConstraints.length] : undefined;
  const contextSurface = requestConstraint?.surface ?? requestTerms[Math.max(0, requestTerms.length - 1 - (variant % requestTerms.length))];
  if (!contextSurface) return undefined;
  const contextSymbols = symbolizeData(contextSurface).filter(symbol => symbol.trim());
  if (!contextSymbols.length) return undefined;
  const generation = input.languageMemory.generate({
    state: input.languageMemoryState,
    contextSymbols,
    requiredTerms: [],
    frames: [],
    generationExtent: 48
  });
  const learnedMove = generation.discourse.moves.find(move => move.role === "learned_continuation");
  const continuation = splitEvidenceSentences(generation.text)[0] ?? "";
  const continuationAlreadyCarriesConstraint = requestConstraint
    ? normalizeSurface(continuation).startsWith(normalizeSurface(requestConstraint.surface))
    : normalizeSurface(continuation).startsWith(normalizeSurface(contextSurface));
  const surface = tidyProposal(continuationAlreadyCarriesConstraint ? continuation : [contextSurface, continuation].filter(Boolean).join(" "));
  const continuationSymbols = symbolizeData(continuation).filter(symbol => /[\p{Letter}\p{Number}]/u.test(symbol));
  if (!learnedMove || continuationSymbols.length < 3 || !surface || containsInternalSurfaceIdentifier(surface)) return undefined;
  if (normalizeSurface(surface) === normalizeSurface(input.requestText)) return undefined;
  if (generation.discourse.cohesion <= 0 || generation.discourse.fluency.ngramMeanActivation <= 0) return undefined;
  if (generation.discourse.repetitionPenalty >= 0.5) return undefined;
  if (copiesCompleteEvidenceSentence(surface, input.evidence)) return undefined;
  if (copiesExactSourceOwnedSurface(surface, input)) return undefined;
  const coveredRequestConstraints = requestConstraints.filter(constraint => normalizeSurface(surface).includes(normalizeSurface(constraint.surface)));
  if (requestConstraint && !coveredRequestConstraints.some(constraint => constraint.id === requestConstraint.id)) return undefined;
  return {
    surface,
    trace: {
      path: "learned_continuation",
      contextSymbols,
      generationTextHash: stableId("generation.surface", generation.text),
      generationConfidence: generation.confidence,
      discourseScore: generation.discourse.discourseScore,
      cohesion: generation.discourse.cohesion,
      repetitionPenalty: generation.discourse.repetitionPenalty,
      sourcePieceIds: uniqueStrings(learnedMove.sourcePieceIds),
      requestConstraintIds: coveredRequestConstraints.map(constraint => constraint.id),
      requestConstraintSourceActivationIds: uniqueStrings(coveredRequestConstraints.map(constraint => constraint.sourceActivationId)),
      requestConstraintCoverage: requestConstraints.length ? coveredRequestConstraints.length / requestConstraints.length : 0,
      stoppedBy: generation.stoppedBy
    }
  };
}

/**
 * Plain corpus ingestion owns language structure but deliberately does not
 * invent semantic role labels. This path therefore binds exact request spans
 * to a source-owned sentence topology through an activated language unit. It
 * changes every selected source sentence, carries no evidence authority, and
 * records both the request coordinates and the durable language-prior IDs.
 */
function learnedStructuralProposalFromMemory(input: PlanInventionsInput): { surface: string; trace: ProposalRealizationTrace } | undefined {
  const slots = requestOwnedCreativeSlots(input);
  const sources = learnedStructuralSources(input.languageMemoryState);
  if (!slots.length || !sources.length) return undefined;
  const ranked = slots.flatMap(slot => sources.flatMap(source => {
    const anchorSentenceIndex = source.sentences.findIndex(sentence => containsSymbolSequence(sentence, slot.anchor.normalizedSymbols));
    if (anchorSentenceIndex < 0 || source.sentences.length < 2) return [];
    const exactSourceVersion = source.sourceVersionId && source.sourceVersionId === slot.anchor.sourceVersionId;
    const sourceEvidence = new Set(source.evidenceIds);
    const anchorUnit = input.languageMemoryState.importedUnits.find(unit => unit.id === slot.anchor.id);
    const evidenceOverlap = anchorUnit?.evidenceIds.some(id => sourceEvidence.has(String(id))) ?? false;
    if (!exactSourceVersion && !evidenceOverlap) return [];
    const requestFit = weightedJaccard(featureSet(input.requestText, 256), featureSet(source.sentences.join(" "), 256));
    const score = clamp01(
      0.38 * Number(exactSourceVersion)
      + 0.18 * Number(evidenceOverlap)
      + 0.18 * clamp01(source.alpha)
      + 0.14 * clamp01(source.sentences.length / 3)
      + 0.12 * requestFit
    );
    return [{ slot, source, anchorSentenceIndex, score }];
  })).sort((left, right) => (
    right.score - left.score
    || right.source.sentences.length - left.source.sentences.length
    || right.slot.anchor.normalizedSymbols.length - left.slot.anchor.normalizedSymbols.length
    || left.source.id.localeCompare(right.source.id)
  ));
  for (const row of ranked) {
    const anchoredSentence = bindAnchoredSourceSentence(
      row.source.sentences[row.anchorSentenceIndex]!,
      row.slot.anchor.normalizedSymbols,
      row.slot.anchoredSlot.text
    );
    const continuationSource = row.source.sentences[(row.anchorSentenceIndex + 1) % row.source.sentences.length];
    const continuationSentence = continuationSource
      ? bindContinuationSourceSentence(continuationSource, row.slot.continuationSlot.text)
      : undefined;
    if (!anchoredSentence || !continuationSentence) continue;
    const surface = tidyProposal(`${anchoredSentence} ${continuationSentence}`);
    const sentences = splitEvidenceSentences(surface);
    if (sentences.length !== 2 || !surface || containsInternalSurfaceIdentifier(surface)) continue;
    if (normalizeSurface(surface) === normalizeSurface(input.requestText)) continue;
    if (!normalizeSurface(surface).includes(normalizeSurface(row.slot.anchoredSlot.text))) continue;
    if (!normalizeSurface(surface).includes(normalizeSurface(row.slot.continuationSlot.text))) continue;
    if (copiesExactSourceOwnedSurface(surface, input) || copiesCompleteEvidenceSentence(surface, input.evidence)) continue;
    const structuralRealizability = kneserNeyRealizability(input.languageMemoryState, surface);
    const contextSymbols = symbolizeData(row.slot.continuationSlot.text).filter(symbol => symbol.trim());
    return {
      surface,
      trace: {
        path: "learned_structural_composition",
        contextSymbols,
        generationTextHash: stableId("generation.structural_surface", surface),
        generationConfidence: clamp01(0.48 + row.score * 0.34 + Math.min(0.18, structuralRealizability * 6)),
        discourseScore: row.score,
        cohesion: clamp01(0.58 + row.score * 0.32),
        repetitionPenalty: 0,
        sourcePieceIds: uniqueStrings([row.slot.anchor.id, row.source.id]),
        requestConstraintIds: [],
        requestConstraintSourceActivationIds: [row.slot.anchor.sourceActivationId],
        requestConstraintCoverage: 1,
        requestSlotSpans: [row.slot.anchoredSlot, row.slot.continuationSlot].map(span => ({
          ...span,
          sourceActivationId: row.slot.anchor.sourceActivationId
        })),
        structuralSourceIds: [row.source.id],
        structuralSentenceCount: sentences.length,
        structuralRealizability,
        stoppedBy: "source_exhausted"
      }
    };
  }
  return undefined;
}

function requestOwnedCreativeSlots(input: PlanInventionsInput): RequestOwnedCreativeSlots[] {
  const requestTokens = lexicalSurfaceSpans(input.requestText);
  if (!requestTokens.length) return [];
  const out: RequestOwnedCreativeSlots[] = [];
  for (const anchor of requestOwnedLanguageActivationSpans(input)) {
    const startUtf16 = utf16IndexAtCodePoint(input.requestText, anchor.requestSpan.charStart);
    const endUtf16 = utf16IndexAtCodePoint(input.requestText, anchor.requestSpan.charEnd);
    const first = requestTokens.findIndex(token => token.start >= startUtf16 && token.start < endUtf16);
    if (first < 0) continue;
    let last = first;
    while (last + 1 < requestTokens.length && requestTokens[last + 1]!.start < endUtf16) last++;
    const previous = first > 0 && whitespaceOnly(input.requestText.slice(requestTokens[first - 1]!.end, requestTokens[first]!.start))
      ? requestTokens[first - 1]
      : undefined;
    const anchoredStart = previous?.start ?? requestTokens[first]!.start;
    const anchoredEnd = requestTokens[last]!.end;
    let continuationLast = last;
    while (continuationLast + 1 < requestTokens.length && continuationLast - last < 7) {
      const gap = input.requestText.slice(requestTokens[continuationLast]!.end, requestTokens[continuationLast + 1]!.start);
      if (hasSentenceBoundary(gap)) break;
      continuationLast++;
    }
    if (!previous || continuationLast <= last) continue;
    const anchoredSlot = exactRequestSpan(input.requestText, anchoredStart, anchoredEnd);
    const continuationSlot = exactRequestSpan(input.requestText, requestTokens[first]!.start, requestTokens[continuationLast]!.end);
    if (!anchoredSlot || !continuationSlot) continue;
    out.push({ anchor, anchoredSlot, continuationSlot });
  }
  const seen = new Set<string>();
  return out.filter(row => {
    const key = `${row.anchor.sourceVersionId}\u0001${row.anchoredSlot.charStart}\u0001${row.continuationSlot.charEnd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((left, right) => (
    right.anchor.normalizedSymbols.length - left.anchor.normalizedSymbols.length
    || [...right.anchor.surface].length - [...left.anchor.surface].length
    || right.anchor.alpha - left.anchor.alpha
    || left.anchor.id.localeCompare(right.anchor.id)
  ));
}

function requestOwnedLanguageActivationSpans(input: PlanInventionsInput): RequestOwnedLanguageActivationSpan[] {
  const activated = new Set(input.requirementField?.activatedPhraseUnitIds ?? []);
  if (!activated.size) return [];
  const requestTokens = lexicalSurfaceSpans(input.requestText);
  const rows: RequestOwnedLanguageActivationSpan[] = [];
  for (const unit of input.languageMemoryState.importedUnits) {
    if (!activated.has(unit.id) || (unit.unitKind !== "symbol" && unit.unitKind !== "phrase" && unit.unitKind !== "morpheme")) continue;
    const normalizedSymbols = lexicalSurfaceSpans(unit.text).map(token => token.key);
    if (!normalizedSymbols.length || normalizedSymbols.length > requestTokens.length) continue;
    for (let index = 0; index <= requestTokens.length - normalizedSymbols.length; index++) {
      if (!normalizedSymbols.every((symbol, offset) => requestTokens[index + offset]?.key === symbol)) continue;
      const start = requestTokens[index]!.start;
      const end = requestTokens[index + normalizedSymbols.length - 1]!.end;
      const requestSpan = exactRequestSpan(input.requestText, start, end);
      if (!requestSpan || requestSpan.charStart === 0 && requestSpan.charEnd === [...input.requestText].length) continue;
      rows.push({
        id: unit.id,
        sourceActivationId: unit.id,
        surface: requestSpan.text,
        normalizedSymbols,
        sourceVersionId: String(unit.sourceVersionId),
        alpha: clamp01(unit.alpha),
        unitKind: unit.unitKind,
        requestSpan
      });
    }
  }
  return rows.sort((left, right) => (
    right.normalizedSymbols.length - left.normalizedSymbols.length
    || [...right.surface].length - [...left.surface].length
    || right.alpha - left.alpha
    || left.id.localeCompare(right.id)
  ));
}

function learnedStructuralSources(state: LanguageMemoryRuntimeState): LearnedStructuralSource[] {
  const rows: LearnedStructuralSource[] = [];
  for (const frame of state.importedSemanticFrames.slice(0, 512)) {
    const record = jsonRecord(frame.frameJson);
    const sourceVersionId = typeof record.sourceVersionId === "string" ? record.sourceVersionId : "";
    for (const [index, surface] of sourceSurfaceFields(frame.frameJson).entries()) {
      const sentences = splitEvidenceSentences(surface).filter(sentence => lexicalSurfaceSpans(sentence).length >= 3);
      if (sentences.length < 2) continue;
      rows.push({
        id: `${frame.id}:surface:${index}`,
        sourceVersionId,
        evidenceIds: frame.evidenceIds.map(String),
        alpha: clamp01(frame.alpha),
        sentences: sentences.slice(0, 12)
      });
    }
  }
  const seen = new Set<string>();
  return rows.filter(row => {
    const key = `${row.sourceVersionId}\u0001${normalizeSurface(row.sentences.join(" "))}`;
    if (!row.sourceVersionId || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function bindAnchoredSourceSentence(sentence: string, anchorSymbols: readonly string[], requestSlot: string): string | undefined {
  const tokens = lexicalSurfaceSpans(sentence);
  const match = symbolSequenceIndex(tokens.map(token => token.key), anchorSymbols);
  if (match < 0) return undefined;
  const anchorEnd = match + anchorSymbols.length - 1;
  const previous = match > 0 && whitespaceOnly(sentence.slice(tokens[match - 1]!.end, tokens[match]!.start))
    ? tokens[match - 1]
    : undefined;
  const start = previous?.start ?? tokens[match]!.start;
  const end = tokens[anchorEnd]!.end;
  const replacement = alignSurfaceCase(requestSlot, sentence.slice(start, end));
  return tidyProposal(`${sentence.slice(0, start)}${replacement}${sentence.slice(end)}`);
}

function bindContinuationSourceSentence(sentence: string, requestSlot: string): string | undefined {
  const first = lexicalSurfaceSpans(sentence)[0];
  if (!first) return undefined;
  const replacement = alignSurfaceCase(requestSlot, sentence.slice(first.start, first.end));
  return tidyProposal(`${sentence.slice(0, first.start)}${replacement}${sentence.slice(first.end)}`);
}

function containsSymbolSequence(surface: string, symbols: readonly string[]): boolean {
  return symbolSequenceIndex(lexicalSurfaceSpans(surface).map(token => token.key), symbols) >= 0;
}

function symbolSequenceIndex(haystack: readonly string[], needle: readonly string[]): number {
  if (!needle.length || needle.length > haystack.length) return -1;
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    if (needle.every((symbol, offset) => haystack[index + offset] === symbol)) return index;
  }
  return -1;
}

function lexicalSurfaceSpans(text: string): Array<{ surface: string; key: string; start: number; end: number }> {
  const rows: Array<{ surface: string; key: string; start: number; end: number }> = [];
  for (const match of text.matchAll(/[\p{Letter}\p{Mark}\p{Number}_]+/gu)) {
    const surface = match[0];
    const start = match.index;
    const key = surface.normalize("NFKC").toLocaleLowerCase();
    if (key) rows.push({ surface, key, start, end: start + surface.length });
  }
  return rows;
}

function exactRequestSpan(text: string, startUtf16: number, endUtf16: number): TurnRequirement["origin"]["requestSpan"] | undefined {
  if (!Number.isInteger(startUtf16) || !Number.isInteger(endUtf16) || startUtf16 < 0 || endUtf16 <= startUtf16 || endUtf16 > text.length) return undefined;
  const surface = text.slice(startUtf16, endUtf16);
  if (!surface || surface !== surface.trim()) return undefined;
  const prefix = text.slice(0, startUtf16);
  return {
    text: surface,
    charStart: [...prefix].length,
    charEnd: [...prefix + surface].length,
    byteStart: new TextEncoder().encode(prefix).byteLength,
    byteEnd: new TextEncoder().encode(prefix + surface).byteLength
  };
}

function utf16IndexAtCodePoint(text: string, pointIndex: number): number {
  return [...text].slice(0, Math.max(0, pointIndex)).join("").length;
}

function whitespaceOnly(value: string): boolean {
  return /^\s*$/u.test(value);
}

function hasSentenceBoundary(value: string): boolean {
  return /[.!?\u3002\uff01\uff1f]/u.test(value);
}

function alignSurfaceCase(surface: string, template: string): string {
  const source = [...template];
  const target = [...surface];
  const sourceIndex = source.findIndex(character => character.toLocaleLowerCase() !== character.toLocaleUpperCase());
  const targetIndex = target.findIndex(character => character.toLocaleLowerCase() !== character.toLocaleUpperCase());
  if (sourceIndex < 0 || targetIndex < 0) return surface;
  const sourceCharacter = source[sourceIndex]!;
  const targetCharacter = target[targetIndex]!;
  if (sourceCharacter === sourceCharacter.toLocaleUpperCase() && sourceCharacter !== sourceCharacter.toLocaleLowerCase()) {
    target[targetIndex] = targetCharacter.toLocaleUpperCase();
  } else if (sourceCharacter === sourceCharacter.toLocaleLowerCase() && sourceCharacter !== sourceCharacter.toLocaleUpperCase()) {
    target[targetIndex] = targetCharacter.toLocaleLowerCase();
  }
  return target.join("");
}

function scoreDraft(input: PlanInventionsInput, draft: DraftComposition, constraints: readonly ConstraintSeed[], memorySurfaces: readonly string[], drafts: readonly DraftComposition[], index: number): ScoredComposition {
  const proposalFeatures = featureSet(draft.proposalSurface, 512);
  const structuralEvents = draft.proposalRealization.structuralEventPlan ?? [];
  const structuralPlanBound = structuralEvents.length > 0;
  const boundConstraintIds = new Set(draft.proposalRealization.requestConstraintIds ?? []);
  const constraintRows: InventionConstraintTrace[] = constraints.map(constraint => ({
    ...constraint,
    satisfied: structuralPlanBound
      ? boundConstraintIds.has(constraint.id)
      : normalizeSurface(draft.proposalSurface).includes(normalizeSurface(constraint.surface))
        || weightedJaccard(proposalFeatures, featureSet(constraint.surface, 128)) >= 0.22
  }));
  const constraintWeight = constraintRows.reduce((sum, row) => sum + row.weight, 0);
  const constraintCoverage = constraintWeight > 0
    ? constraintRows.reduce((sum, row) => sum + row.weight * Number(row.satisfied), 0) / constraintWeight
    : 1;
  const graphCoherence = structuralPlanBound
    ? mean(structuralEvents.map(event => mean([
      event.graphFit,
      event.routeFit,
      Number(Boolean(event.discourseBeatId)),
      Number(event.discourseBridgeBasisId === "scce.discourse.bridge.source_adjacency"
        || event.discourseBridgeBasisId === "scce.discourse.bridge.invented_macro")
    ])))
    : mean(draft.selectedEdges.map(edgeRelationPotential));
  const structuralPlanSimilarities = structuralPlanBound
    ? drafts
      .filter((_, otherIndex) => otherIndex !== index)
      .map(other => structuralCreativePlanSimilarity(
        structuralEvents,
        other.proposalRealization.structuralEventPlan ?? []
      ))
    : [];
  const memorySimilarities = structuralPlanBound
    ? structuralPlanSimilarities
    : memorySurfaces.map(surface => weightedJaccard(proposalFeatures, featureSet(surface, 512)));
  const novelty = clamp01(1 - Math.max(0, ...memorySimilarities));
  const languageRealizability = structuralPlanBound
    ? structuralCreativePlanRealizability(structuralEvents)
    : kneserNeyRealizability(input.languageMemoryState, draft.proposalSurface);
  const requestFit = structuralPlanBound
    ? mean(structuralEvents.map(event => event.requestFit))
    : weightedJaccard(featureSet(input.requestText, 512), proposalFeatures);
  const actionability = clamp01(input.field.alphaTrace.surfaces.actionability);
  const completionPotential = constraintCoverage;
  const usefulness = mean([actionability, requestFit, completionPotential]);
  const contradictionPressure = clamp01(Math.max(input.field.alphaTrace.contradictionMass, input.field.alphaTrace.surfaces.contradiction));
  const internalConflict = structuralPlanBound
    ? 0
    : Math.max(0, ...input.dialogueState.rejectedAssumptions.map(surface => weightedJaccard(proposalFeatures, featureSet(surface, 128))));
  const infeasibility = clamp01(Math.max(input.field.alphaTrace.surfaces.risk, input.dialogueState.unresolvedSlots.length / 16));
  const risk = Math.max(contradictionPressure, internalConflict, infeasibility);
  const surfaceRepetition = structuralPlanBound
    ? 0
    : Math.max(0, ...drafts
      .filter((_, otherIndex) => otherIndex !== index)
      .map(other => weightedJaccard(proposalFeatures, featureSet(other.proposalSurface, 512))));
  const structuralRepetition = structuralPlanBound
    ? 1 - new Set(structuralEvents.map(event => event.eventId)).size / structuralEvents.length
    : 0;
  const repetition = Math.max(surfaceRepetition, structuralRepetition);
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

function structuralCreativePlanSimilarity(
  left: readonly StructuralCreativeEventPlanRecord[],
  right: readonly StructuralCreativeEventPlanRecord[]
): number {
  if (!left.length || !right.length) return 0;
  const length = Math.max(left.length, right.length);
  let aligned = 0;
  for (let index = 0; index < length; index++) {
    if (left[index]?.eventId === right[index]?.eventId) aligned += 1;
  }
  return clamp01(aligned / length);
}

function diversityRank(candidates: readonly ScoredComposition[]): ScoredComposition[] {
  const remaining = [...candidates];
  const selected: ScoredComposition[] = [];
  while (remaining.length) {
    const ranked = remaining.map(candidate => {
      const candidateStructuralEvents = candidate.proposalRealization.structuralEventPlan ?? [];
      const maxSimilarity = Math.max(0, ...selected.map(prior => (
        candidateStructuralEvents.length
          ? structuralCreativePlanSimilarity(
            candidateStructuralEvents,
            prior.proposalRealization.structuralEventPlan ?? []
          )
          : weightedJaccard(featureSet(candidate.proposalSurface, 512), featureSet(prior.proposalSurface, 512))
      )));
      const diversity = 1 - maxSimilarity;
      return { candidate, diversity, score: candidate.probability * (0.72 + 0.28 * diversity) };
    }).sort((left, right) =>
      right.score - left.score
      || right.candidate.bootstrapScore - left.candidate.bootstrapScore
      || draftCompositionIdentity(left.candidate).localeCompare(draftCompositionIdentity(right.candidate))
    );
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
  if (variant % 4 === 0) return `${title}: ${a}; ${b}; ${c}; ${constraints}.`;
  if (variant % 4 === 1) return `${constraints}: ${c}; ${b}; ${a}; ${title}.`;
  if (variant % 4 === 2) return `${a}; ${c}; ${title}; ${b}; ${constraints}.`;
  return `${title}: ${b}; ${constraints}; ${a}; ${c}.`;
}

function evidenceSafeProposal(surface: string, evidence: readonly EvidenceSpan[], requestTerms: readonly string[], variant: number, title: string): string {
  if (!copiesCompleteEvidenceSentence(surface, evidence)) return tidyProposal(surface);
  const safe = requestTerms.slice(0, 8);
  const fallback = tidyProposal(proposalShape(variant, title, [safe[0] ?? title, safe[1] ?? title, safe[2] ?? title], safe.join("; ") || title));
  if (!copiesCompleteEvidenceSentence(fallback, evidence)) return fallback;
  const requestOwned = tidyProposal(safe.join(" "));
  return copiesCompleteEvidenceSentence(requestOwned, evidence) ? "" : requestOwned;
}

function copiesCompleteEvidenceSentence(surface: string, evidence: readonly EvidenceSpan[]): boolean {
  const normalized = normalizeSurface(surface);
  return evidence.some(span => splitEvidenceSentences(span.text).some(sentence => {
    const source = normalizeSurface(sentence);
    return source.length >= 8 && normalized.includes(source);
  }));
}

function copiesExactSourceOwnedSurface(surface: string, input: PlanInventionsInput): boolean {
  const candidateSentences = splitEvidenceSentences(surface)
    .map(normalizeSurface)
    .filter(candidate => symbolizeData(candidate).filter(symbol => /[\p{Letter}\p{Number}]/u.test(symbol)).length >= 2);
  if (!candidateSentences.length) return false;
  const sourceSurfaces = [
    ...input.evidence.map(span => span.text),
    ...input.languageMemoryState.importedUnits.map(unit => unit.text),
    ...input.languageMemoryState.importedPatterns.flatMap(pattern => sourceSurfaceFields(pattern.patternJson)),
    ...input.languageMemoryState.importedSemanticFrames.flatMap(frame => sourceSurfaceFields(frame.frameJson)),
    ...input.languageMemoryState.importedConstructionBundles.flatMap(bundle => bundle.sourceExamples.map(example => example.surface))
  ];
  const sourceSentences = new Set(sourceSurfaces
    .flatMap(splitEvidenceSentences)
    .map(normalizeSurface)
    .filter(source => symbolizeData(source).filter(symbol => /[\p{Letter}\p{Number}]/u.test(symbol)).length >= 2));
  return candidateSentences.some(candidate => sourceSentences.has(candidate));
}

function sourceSurfaceFields(value: JsonValue): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const record = value as Record<string, JsonValue>;
  return ["surface", "text", "preview", "excerpt", "proposition", "claim", "phrase", "title", "summary"]
    .flatMap(key => {
      const item = record[key];
      if (typeof item === "string") return [item];
      if (Array.isArray(item)) return item.filter((entry): entry is string => typeof entry === "string");
      return [];
    });
}

function splitEvidenceSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\r?\n+/u).map(value => value.trim()).filter(Boolean);
}

function graphNodeSurface(node: GraphNode, evidence: readonly EvidenceSpan[], requestText: string): string {
  const linkedEvidenceIds = new Set(node.evidenceIds.map(String));
  const linkedEvidence = evidence.filter(span => linkedEvidenceIds.has(String(span.id)));
  const candidates = [
    ...explicitSourceSurfaceFields(node.representation),
    ...sourceSurfaceFields(node.metadata),
    ...node.features.filter(feature => feature.startsWith("sym:")).map(feature => feature.slice(4))
  ];
  const requestFeatures = featureSet(requestText, 256);
  return uniqueStrings(candidates
    .map(cleanSurfacePiece)
    .filter(candidate => candidate
      && surfaceOwnedByRequestOrEvidence(candidate, requestText, linkedEvidence)
      && !copiesCompleteEvidenceSentence(candidate, linkedEvidence)))
    .map(candidate => ({ candidate, fit: weightedJaccard(requestFeatures, featureSet(candidate, 128)) }))
    .sort((left, right) => right.fit - left.fit || right.candidate.length - left.candidate.length || left.candidate.localeCompare(right.candidate))[0]?.candidate ?? "";
}

function explicitSourceSurfaceFields(value: JsonValue): string[] {
  return typeof value === "string" ? [value] : sourceSurfaceFields(value);
}

function surfaceOwnedByRequestOrEvidence(surface: string, requestText: string, evidence: readonly EvidenceSpan[]): boolean {
  return containsNormalizedSurfaceSequence(requestText, surface)
    || evidence.some(span => containsNormalizedSurfaceSequence(span.text, surface) || containsNormalizedSurfaceSequence(span.textPreview, surface));
}

function containsNormalizedSurfaceSequence(owner: string, candidate: string): boolean {
  const ownerSurface = normalizeSurface(owner);
  const candidateSurface = normalizeSurface(candidate);
  return Boolean(candidateSurface) && ` ${ownerSurface} `.includes(` ${candidateSurface} `);
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
  return uniqueStrings((text.normalize("NFC").match(/[\p{Letter}\p{Mark}\p{Number}_-]+/gu) ?? [])
    .filter(Boolean))
    .slice(0, 24);
}

function cleanSurfacePiece(value: string): string {
  const clean = value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim();
  if (!clean || clean.length > 96 || clean.includes("://") || containsInternalSurfaceIdentifier(clean) || !/[\p{Letter}\p{Number}]/u.test(clean)) return "";
  const symbols = symbolizeData(clean);
  if (!symbols.length || symbols.length > 8) return "";
  return clean.replace(/[.!?]+$/u, "");
}

function containsInternalSurfaceIdentifier(value: string): boolean {
  const clean = value.normalize("NFC").trim();
  if (!clean) return false;
  if (/(?:^|\s)(?:sym:[^\s|]+|bi:[^\s|]+\|[^\s|]+|tri:[^\s|]+\|[^\s|]+\|[^\s|]+|char:\S+)(?:$|\s)/u.test(clean)) return true;
  if (/(?:^|[^\p{Letter}\p{Number}_])(?:node|edge|relation|hyperedge|source|evidence|graph_node|graph_edge|proof_trace|relation_role|slot_graph|slot_answer)_[0-9a-f]{24,}(?:$|[^\p{Letter}\p{Number}_])/iu.test(clean)) return true;
  return !/\s/u.test(clean) && /^(?:[\p{Letter}][\p{Letter}\p{Number}_-]*[.:]){2,}[\p{Letter}\p{Number}_.:-]+$/u.test(clean);
}

function tidyProposal(value: string): string {
  return value.normalize("NFC").replace(/[\u0000-\u001f\u007f]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, 1200);
}

function surfaceTitle(value: string): string {
  return tidyProposal(value).slice(0, 192);
}

function normalizeSurface(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, " ").replace(/\s+/gu, " ").trim();
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
