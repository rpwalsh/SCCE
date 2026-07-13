import type { DialogueState } from "./dialogue-pragmatics.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import { clamp01, mean, toJsonValue } from "./primitives.js";
import type { QuestionCognitiveFabric } from "./question-cognitive-edge.js";
import type { ConstructGraph, JsonValue } from "./types.js";

export const TURN_REQUIREMENT_DIMENSIONS = [
  "externalTruthAuthority",
  "sourceDependence",
  "noveltyDemand",
  "inferentialDepth",
  "semanticPreservation",
  "surfaceTransformation",
  "executableArtifactDemand",
  "actionCommitment",
  "dialogueDependence",
  "uncertaintyTolerance",
  "formatConstraintStrength",
  "audienceAdaptation",
  "brevityDetailBalance",
  "temporalReasoningDemand",
  "causalReasoningDemand",
  "counterfactualDemand"
] as const;

export type TurnRequirementDimension = typeof TURN_REQUIREMENT_DIMENSIONS[number];

export interface TurnRequirementSpan {
  text: string;
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
}

export interface TurnRequirement {
  id: string;
  dimension: TurnRequirementDimension;
  value: number;
  confidence: number;
  status: "explicit" | "inferred";
  origin: {
    requestSpan: TurnRequirementSpan;
    semanticRoleId: string;
    learnedFrameOrPatternId: string;
    dialogueReferenceId?: string;
  };
  sourceActivationId: string;
  trace: JsonValue;
}

export interface TurnRequirementField {
  externalTruthAuthority: number;
  sourceDependence: number;
  noveltyDemand: number;
  inferentialDepth: number;
  semanticPreservation: number;
  surfaceTransformation: number;
  executableArtifactDemand: number;
  actionCommitment: number;
  dialogueDependence: number;
  uncertaintyTolerance: number;
  formatConstraintStrength: number;
  audienceAdaptation: number;
  brevityDetailBalance: number;
  temporalReasoningDemand: number;
  causalReasoningDemand: number;
  counterfactualDemand: number;

  requiredFeatures: TurnRequirement[];
  prohibitedFeatures: TurnRequirement[];

  activatedFrameIds: string[];
  activatedPatternIds: string[];
  activatedPhraseUnitIds: string[];
  activatedDialogueMoveIds: string[];
  activatedConstructIds: string[];

  confidence: number;
  trace: JsonValue;
}

export type RequirementActivationKind = "frame" | "pattern" | "phrase_unit" | "dialogue_move" | "construct";

export interface RequirementActivationSpan {
  charStart: number;
  charEnd: number;
}

/**
 * A language-neutral activation produced by learned language, dialogue, or
 * construct machinery. The coefficient vector is learned state (or an
 * explicitly versioned bootstrap), never a surface-word feature.
 */
export interface LearnedRequirementActivation {
  id: string;
  kind: RequirementActivationKind;
  activation: number;
  confidence?: number;
  span?: RequirementActivationSpan;
  semanticRoleId?: string;
  learnedFrameOrPatternId?: string;
  dialogueReferenceId?: string;
  status?: "explicit" | "inferred";
  polarity?: "required" | "prohibited";
  requirementCoefficients?: Partial<Record<TurnRequirementDimension, number>>;
  trace?: JsonValue;
}

export interface ExplicitTurnRequirement {
  id?: string;
  dimension: TurnRequirementDimension;
  value: number;
  confidence?: number;
  polarity?: "required" | "prohibited";
  status?: "explicit" | "inferred";
  span?: RequirementActivationSpan;
  semanticRoleId: string;
  learnedFrameOrPatternId: string;
  dialogueReferenceId?: string;
  sourceActivationId?: string;
  trace?: JsonValue;
}

export interface TurnRequirementCoefficientModel {
  schema: "scce.turn_requirement.coefficients.v1";
  id: string;
  version: number;
  reliability: "calibrated" | "uncalibrated_bootstrap";
  intercepts: Partial<Record<TurnRequirementDimension, number>>;
  /** Keys are durable activation IDs, optionally prefixed by activation kind. */
  activationWeights: Partial<Record<TurnRequirementDimension, Readonly<Record<string, number>>>>;
  minimumFeatureContribution?: number;
}

export interface DeriveTurnRequirementFieldInput {
  requestText: string;
  languageMemoryState?: LanguageMemoryRuntimeState;
  dialogueState?: DialogueState;
  questionFabric?: QuestionCognitiveFabric;
  constructGraph?: ConstructGraph;
  activations?: readonly LearnedRequirementActivation[];
  explicitRequirements?: readonly ExplicitTurnRequirement[];
  contextContribution?: Partial<Record<TurnRequirementDimension, number>>;
  model?: TurnRequirementCoefficientModel;
}

export const DEFAULT_TURN_REQUIREMENT_MODEL: TurnRequirementCoefficientModel = {
  schema: "scce.turn_requirement.coefficients.v1",
  id: "coeff.turn_requirement.bootstrap.v1",
  version: 1,
  reliability: "uncalibrated_bootstrap",
  intercepts: {
    externalTruthAuthority: -1.4,
    sourceDependence: -1.4,
    noveltyDemand: -1.4,
    inferentialDepth: -1.4,
    semanticPreservation: -1.4,
    surfaceTransformation: -1.4,
    executableArtifactDemand: -1.4,
    actionCommitment: -1.4,
    dialogueDependence: -1.4,
    uncertaintyTolerance: 0,
    formatConstraintStrength: -1.4,
    audienceAdaptation: -1.4,
    brevityDetailBalance: 0,
    temporalReasoningDemand: -1.4,
    causalReasoningDemand: -1.4,
    counterfactualDemand: -1.4
  },
  activationWeights: {},
  minimumFeatureContribution: 0.08
};

export const COGNITIVE_OPERATOR_IDS = {
  evidenceActivation: "operator.cognition.evidence_activation.v1",
  graphPropagation: "operator.cognition.graph_propagation.v1",
  sourceSynthesis: "operator.cognition.source_synthesis.v1",
  relationComposition: "operator.cognition.relation_composition.v1",
  semanticProof: "operator.cognition.semantic_proof.v1",
  temporalAnalysis: "operator.cognition.temporal_analysis.v1",
  causalAnalysis: "operator.cognition.causal_analysis.v1",
  counterfactualConstruction: "operator.cognition.counterfactual_construction.v1",
  analogy: "operator.cognition.analogy.v1",
  invention: "operator.cognition.invention.v1",
  transformation: "operator.cognition.transformation.v1",
  translation: "operator.cognition.translation.v1",
  programPlanning: "operator.cognition.program_planning.v1",
  workspaceRepair: "operator.cognition.workspace_repair.v1",
  actionPlanning: "operator.cognition.action_planning.v1",
  dialogueContinuation: "operator.cognition.dialogue_continuation.v1",
  clarification: "operator.cognition.clarification.v1"
} as const;

export type CognitiveOperatorId = typeof COGNITIVE_OPERATOR_IDS[keyof typeof COGNITIVE_OPERATOR_IDS];

export interface ActivatedOperator {
  id: string;
  operatorId: CognitiveOperatorId;
  activation: number;
  active: boolean;
  contributingRequirementDimensions: TurnRequirementDimension[];
  support: {
    requirement: number;
    graph: number;
    dialogue: number;
    construct: number;
    outcome: number;
  };
  trace: JsonValue;
}

export interface CognitiveOperatorActivationModel {
  schema: "scce.cognitive_operator.activation.v1";
  id: string;
  version: number;
  reliability: "calibrated" | "uncalibrated_bootstrap";
  intercepts: Readonly<Record<CognitiveOperatorId, number>>;
  requirementWeights: Readonly<Record<CognitiveOperatorId, Partial<Record<TurnRequirementDimension, number>>>>;
  activationThreshold: number;
}

export type OperatorSupportMap = Partial<Record<CognitiveOperatorId, number>>;

export interface ActivateCognitiveOperatorsInput {
  requirementField: TurnRequirementField;
  graphSupport?: OperatorSupportMap;
  dialogueSupport?: OperatorSupportMap;
  constructSupport?: OperatorSupportMap;
  outcomeSupport?: OperatorSupportMap;
  model?: CognitiveOperatorActivationModel;
}

const OPERATOR_INTERCEPTS = operatorRecord(-1.35);

export const DEFAULT_COGNITIVE_OPERATOR_MODEL: CognitiveOperatorActivationModel = {
  schema: "scce.cognitive_operator.activation.v1",
  id: "coeff.cognitive_operator.bootstrap.v1",
  version: 1,
  reliability: "uncalibrated_bootstrap",
  intercepts: OPERATOR_INTERCEPTS,
  requirementWeights: {
    [COGNITIVE_OPERATOR_IDS.evidenceActivation]: { externalTruthAuthority: 1.05, sourceDependence: 1.15, uncertaintyTolerance: -0.2 },
    [COGNITIVE_OPERATOR_IDS.graphPropagation]: { inferentialDepth: 1.05, sourceDependence: 0.35, dialogueDependence: 0.25 },
    [COGNITIVE_OPERATOR_IDS.sourceSynthesis]: { sourceDependence: 1.0, inferentialDepth: 0.75, noveltyDemand: 0.3 },
    [COGNITIVE_OPERATOR_IDS.relationComposition]: { inferentialDepth: 1.25, causalReasoningDemand: 0.25, temporalReasoningDemand: 0.25 },
    [COGNITIVE_OPERATOR_IDS.semanticProof]: { externalTruthAuthority: 1.05, sourceDependence: 0.75, inferentialDepth: 0.45 },
    [COGNITIVE_OPERATOR_IDS.temporalAnalysis]: { temporalReasoningDemand: 1.55, inferentialDepth: 0.4 },
    [COGNITIVE_OPERATOR_IDS.causalAnalysis]: { causalReasoningDemand: 1.55, inferentialDepth: 0.4 },
    [COGNITIVE_OPERATOR_IDS.counterfactualConstruction]: { counterfactualDemand: 1.55, inferentialDepth: 0.45, noveltyDemand: 0.25 },
    [COGNITIVE_OPERATOR_IDS.analogy]: { noveltyDemand: 0.75, inferentialDepth: 0.7, uncertaintyTolerance: 0.2 },
    [COGNITIVE_OPERATOR_IDS.invention]: { noveltyDemand: 1.45, inferentialDepth: 0.35, executableArtifactDemand: 0.35, uncertaintyTolerance: 0.25 },
    [COGNITIVE_OPERATOR_IDS.transformation]: { semanticPreservation: 1.0, surfaceTransformation: 1.3 },
    [COGNITIVE_OPERATOR_IDS.translation]: { semanticPreservation: 1.25, surfaceTransformation: 1.1, audienceAdaptation: 0.2 },
    [COGNITIVE_OPERATOR_IDS.programPlanning]: { executableArtifactDemand: 1.4, inferentialDepth: 0.45, formatConstraintStrength: 0.2 },
    [COGNITIVE_OPERATOR_IDS.workspaceRepair]: { executableArtifactDemand: 1.15, actionCommitment: 0.7, dialogueDependence: 0.2 },
    [COGNITIVE_OPERATOR_IDS.actionPlanning]: { actionCommitment: 1.5, executableArtifactDemand: 0.35, externalTruthAuthority: 0.2 },
    [COGNITIVE_OPERATOR_IDS.dialogueContinuation]: { dialogueDependence: 1.55, audienceAdaptation: 0.25 },
    [COGNITIVE_OPERATOR_IDS.clarification]: { externalTruthAuthority: 0.55, sourceDependence: 0.35, uncertaintyTolerance: -0.65, dialogueDependence: 0.4 }
  },
  activationThreshold: 0.5
};

/**
 * Derive r_d = sigmoid(b_d + learned frame/pattern/phrase/dialogue/construct
 * contributions + structural context contribution).
 */
export function deriveTurnRequirementField(input: DeriveTurnRequirementFieldInput): TurnRequirementField {
  const requestText = input.requestText;
  const model = input.model ?? DEFAULT_TURN_REQUIREMENT_MODEL;
  const activations = collectActivations({ ...input, requestText });
  const explicitRequirements = (input.explicitRequirements ?? []).map(row => normalizeExplicitRequirement(requestText, row, model));
  const activationOccurrenceCounts = new Map<string, number>();
  for (const activation of activations) {
    const key = `${activation.kind}|${activation.id}`;
    activationOccurrenceCounts.set(key, (activationOccurrenceCounts.get(key) ?? 0) + 1);
  }
  const requiredFeatures: TurnRequirement[] = [];
  const prohibitedFeatures: TurnRequirement[] = [];
  const dimensionTrace: Record<string, JsonValue> = {};
  const values = emptyDimensionRecord();
  const minimumContribution = finiteOr(model.minimumFeatureContribution, 0.08);

  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
    const intercept = finiteOr(model.intercepts[dimension], finiteOr(DEFAULT_TURN_REQUIREMENT_MODEL.intercepts[dimension], 0));
    const terms: Array<{ activationId: string; kind: RequirementActivationKind; activation: number; coefficient: number; occurrenceNormalization: number; contribution: number }> = [];
    let activationContribution = 0;
    for (const activation of activations) {
      const coefficient = finiteOr(activation.requirementCoefficients?.[dimension], 0)
        + modelActivationWeight(model, dimension, activation);
      const rawContribution = finiteOr(coefficient * activation.activation, 0);
      const occurrenceCount = activationOccurrenceCounts.get(`${activation.kind}|${activation.id}`) ?? 1;
      const occurrenceNormalization = occurrenceCount > 0 ? 1 / occurrenceCount : 1;
      const contribution = finiteOr(rawContribution * occurrenceNormalization, 0);
      if (coefficient === 0 && contribution === 0) continue;
      activationContribution += contribution;
      terms.push({ activationId: activation.id, kind: activation.kind, activation: activation.activation, coefficient, occurrenceNormalization, contribution });
      if (Math.abs(rawContribution) >= minimumContribution) {
        const requirement = requirementFromActivation({ requestText, activation, dimension, contribution: rawContribution, intercept });
        if (activation.polarity === "prohibited" || rawContribution < 0) prohibitedFeatures.push(requirement);
        else requiredFeatures.push(requirement);
      }
    }

    const matchingExplicit = explicitRequirements.filter(row => row.requirement.dimension === dimension);
    let explicitContribution = 0;
    for (const row of matchingExplicit) {
      explicitContribution += row.logitContribution;
      if (row.polarity === "prohibited") prohibitedFeatures.push(row.requirement);
      else requiredFeatures.push(row.requirement);
    }
    const contextContribution = finiteOr(input.contextContribution?.[dimension], 0) + derivedContextContribution(dimension, input);
    const logit = finiteOr(intercept + activationContribution + explicitContribution + contextContribution, 0);
    const value = clamp01(sigmoid(logit));
    values[dimension] = value;
    const contributionByActivationKind = {
      frame: finiteOr(terms.filter(row => row.kind === "frame").reduce((sum, row) => sum + row.contribution, 0), 0),
      pattern: finiteOr(terms.filter(row => row.kind === "pattern").reduce((sum, row) => sum + row.contribution, 0), 0),
      phraseUnit: finiteOr(terms.filter(row => row.kind === "phrase_unit").reduce((sum, row) => sum + row.contribution, 0), 0),
      dialogueMove: finiteOr(terms.filter(row => row.kind === "dialogue_move").reduce((sum, row) => sum + row.contribution, 0), 0),
      construct: finiteOr(terms.filter(row => row.kind === "construct").reduce((sum, row) => sum + row.contribution, 0), 0)
    };
    dimensionTrace[dimension] = toJsonValue({
      intercept,
      activationContribution,
      contributionByActivationKind,
      explicitContribution,
      contextContribution,
      logit,
      value,
      terms
    });
  }

  const confidenceTerms = [
    ...activations.map(row => clamp01(row.activation * finiteOr(row.confidence, row.activation))),
    ...explicitRequirements.map(row => row.requirement.confidence)
  ];
  const confidence = clamp01(mean(confidenceTerms));
  const field: TurnRequirementField = {
    ...values,
    requiredFeatures: uniqueRequirements(requiredFeatures),
    prohibitedFeatures: uniqueRequirements(prohibitedFeatures),
    activatedFrameIds: activatedIds(activations, "frame"),
    activatedPatternIds: activatedIds(activations, "pattern"),
    activatedPhraseUnitIds: activatedIds(activations, "phrase_unit"),
    activatedDialogueMoveIds: activatedIds(activations, "dialogue_move"),
    activatedConstructIds: activatedIds(activations, "construct"),
    confidence,
    trace: toJsonValue({
      schema: "scce.turn_requirement.field_trace.v1",
      equation: "sigmoid(intercept + frame + pattern + phrase + dialogue + construct + context)",
      coefficientModel: { id: model.id, version: model.version, reliability: model.reliability },
      request: { characters: codePoints(requestText).length, bytes: byteLength(requestText) },
      activations: activations.map(activation => ({
        id: activation.id,
        kind: activation.kind,
        activation: activation.activation,
        confidence: activation.confidence,
        learnedFrameOrPatternId: activation.learnedFrameOrPatternId ?? activation.id,
        span: spanFor(requestText, activation.span)
      })),
      dimensions: dimensionTrace,
      confidence,
      confidenceReliability: model.reliability
    })
  };
  return clampRequirementField(field);
}

/** Activate every compatible operator; this deliberately does not choose one mode. */
export function activateCognitiveOperators(input: ActivateCognitiveOperatorsInput): ActivatedOperator[] {
  const model = input.model ?? DEFAULT_COGNITIVE_OPERATOR_MODEL;
  const threshold = clamp01(finiteOr(model.activationThreshold, DEFAULT_COGNITIVE_OPERATOR_MODEL.activationThreshold));
  return (Object.values(COGNITIVE_OPERATOR_IDS) as CognitiveOperatorId[]).map(operatorId => {
    const intercept = finiteOr(model.intercepts[operatorId], finiteOr(DEFAULT_COGNITIVE_OPERATOR_MODEL.intercepts[operatorId], 0));
    const weights = model.requirementWeights[operatorId] ?? {};
    const requirementTerms = TURN_REQUIREMENT_DIMENSIONS.map(dimension => {
      const weight = finiteOr(weights[dimension], 0);
      const value = clamp01(finiteOr(input.requirementField[dimension], 0));
      return { dimension, weight, value, contribution: finiteOr(weight * value, 0) };
    });
    const requirement = finiteOr(requirementTerms.reduce((sum, row) => sum + row.contribution, 0), 0);
    const graph = supportValue(input.graphSupport, operatorId);
    const dialogue = supportValue(input.dialogueSupport, operatorId);
    const construct = supportValue(input.constructSupport, operatorId);
    const outcome = supportValue(input.outcomeSupport, operatorId);
    const logit = finiteOr(intercept + requirement + graph + dialogue + construct + outcome, 0);
    const activation = clamp01(sigmoid(logit));
    const contributingRequirementDimensions = requirementTerms
      .filter(row => Math.abs(row.contribution) >= 0.04)
      .sort((left, right) => Math.abs(right.contribution) - Math.abs(left.contribution) || left.dimension.localeCompare(right.dimension))
      .map(row => row.dimension);
    return {
      id: `activation.${stableId(`${model.id}|${model.version}|${operatorId}|${activation.toFixed(12)}`)}`,
      operatorId,
      activation,
      active: activation >= threshold,
      contributingRequirementDimensions,
      support: { requirement, graph, dialogue, construct, outcome },
      trace: toJsonValue({
        schema: "scce.cognitive_operator.activation_trace.v1",
        equation: "sigmoid(intercept + requirement + graph + dialogue + construct + outcome)",
        coefficientModel: { id: model.id, version: model.version, reliability: model.reliability },
        intercept,
        requirementTerms,
        support: { requirement, graph, dialogue, construct, outcome },
        logit,
        activation,
        threshold
      })
    };
  }).sort((left, right) => right.activation - left.activation || left.operatorId.localeCompare(right.operatorId));
}

function collectActivations(input: DeriveTurnRequirementFieldInput & { requestText: string }): LearnedRequirementActivation[] {
  const rows: LearnedRequirementActivation[] = [];
  for (const row of input.activations ?? []) rows.push(normalizeActivation(input.requestText, row));
  collectLanguageActivations(input.requestText, input.languageMemoryState, rows);
  collectDialogueActivations(input.requestText, input.dialogueState, rows);
  collectQuestionActivations(input.requestText, input.questionFabric, rows);
  collectConstructActivations(input.requestText, input.constructGraph, rows);
  const byKey = new Map<string, LearnedRequirementActivation>();
  for (const row of rows) {
    const span = spanFor(input.requestText, row.span);
    const key = `${row.kind}|${row.id}|${span.charStart}|${span.charEnd}`;
    const previous = byKey.get(key);
    if (!previous || row.activation > previous.activation) byKey.set(key, row);
  }
  return [...byKey.values()].sort((left, right) => right.activation - left.activation || left.kind.localeCompare(right.kind) || left.id.localeCompare(right.id));
}

function collectLanguageActivations(requestText: string, state: LanguageMemoryRuntimeState | undefined, out: LearnedRequirementActivation[]): void {
  if (!state) return;
  for (const unit of state.importedUnits) {
    const metadata = jsonRecord(unit.metadata);
    const kind: RequirementActivationKind = unit.unitKind === "semantic_frame" ? "frame" : unit.unitKind === "syntax_pattern" ? "pattern" : "phrase_unit";
    for (const matchedSpan of learnedSurfaceSpans(requestText, unit.text)) {
      out.push(normalizeActivation(requestText, {
        id: unit.id,
        kind,
        activation: clamp01(unit.alpha),
        confidence: competenceConfidence(unit.competenceVector, unit.alpha),
        span: matchedSpan,
        semanticRoleId: jsonString(metadata.semanticRoleId),
        learnedFrameOrPatternId: jsonString(metadata.frameId) ?? jsonString(metadata.patternId) ?? unit.id,
        requirementCoefficients: requirementCoefficients(metadata.requirementCoefficients),
        trace: toJsonValue({ source: "language_unit", profileId: unit.profileId, unitKind: unit.unitKind, evidenceIds: unit.evidenceIds })
      }));
    }
  }
  for (const pattern of state.importedPatterns) {
    const record = jsonRecord(pattern.patternJson);
    const surface = jsonString(record.surface);
    for (const matchedSpan of surface ? learnedSurfaceSpans(requestText, surface) : []) {
      out.push(normalizeActivation(requestText, {
        id: pattern.id,
        kind: "pattern",
        activation: clamp01(pattern.support * (1 - clamp01(pattern.entropy))),
        confidence: clamp01(pattern.support),
        span: matchedSpan,
        semanticRoleId: jsonString(record.semanticRoleId),
        learnedFrameOrPatternId: pattern.id,
        requirementCoefficients: requirementCoefficients(record.requirementCoefficients),
        trace: toJsonValue({ source: "language_pattern", profileId: pattern.profileId, patternKind: pattern.patternKind, evidenceIds: pattern.evidenceIds })
      }));
    }
  }
  for (const frame of state.importedSemanticFrames) {
    const record = jsonRecord(frame.frameJson);
    const surface = jsonString(record.surface);
    for (const matchedSpan of surface ? learnedSurfaceSpans(requestText, surface) : []) {
      out.push(normalizeActivation(requestText, {
        id: frame.id,
        kind: "frame",
        activation: clamp01(frame.alpha),
        confidence: clamp01(frame.alpha),
        span: matchedSpan,
        semanticRoleId: jsonString(record.semanticRoleId),
        learnedFrameOrPatternId: frame.id,
        requirementCoefficients: requirementCoefficients(record.requirementCoefficients),
        trace: toJsonValue({ source: "semantic_frame", evidenceIds: frame.evidenceIds })
      }));
    }
  }
}

function collectDialogueActivations(requestText: string, state: DialogueState | undefined, out: LearnedRequirementActivation[]): void {
  if (!state) return;
  const fullSpan = fullRequestSpan(requestText);
  if (state.currentIntentId) {
    out.push(normalizeActivation(requestText, {
      id: state.currentIntentId,
      kind: "dialogue_move",
      activation: state.continuityLinks.length > 0 ? 0.82 : 0.58,
      confidence: state.continuityLinks.length > 0 ? 0.78 : 0.52,
      span: fullSpan,
      semanticRoleId: "role.dialogue.current.v1",
      learnedFrameOrPatternId: state.currentIntentId,
      dialogueReferenceId: state.turnId,
      requirementCoefficients: { dialogueDependence: state.continuityLinks.length > 0 ? 0.9 : 0.3 },
      trace: toJsonValue({ source: "dialogue_state", conversationId: state.conversationId, continuityLinkCount: state.continuityLinks.length })
    }));
  }
  for (const signal of state.interactionSignals) {
    out.push(normalizeActivation(requestText, {
      id: signal.id,
      kind: "dialogue_move",
      activation: clamp01(signal.value),
      confidence: clamp01(signal.confidence),
      span: fullSpan,
      semanticRoleId: signal.featureId,
      learnedFrameOrPatternId: signal.featureId,
      dialogueReferenceId: state.turnId,
      trace: toJsonValue({ source: "dialogue_signal", sourceIds: signal.sourceIds, signalTrace: signal.trace })
    }));
  }
}

function collectQuestionActivations(requestText: string, fabric: QuestionCognitiveFabric | undefined, out: LearnedRequirementActivation[]): void {
  if (!fabric) return;
  const fullSpan = fullRequestSpan(requestText);
  const slotCoverage = fabric.requestedSlotIds.length === 0 ? 0 : fabric.selectedFits.length / fabric.requestedSlotIds.length;
  out.push(normalizeActivation(requestText, {
    id: fabric.questionShapeId,
    kind: "pattern",
    activation: clamp01(0.45 + 0.45 * slotCoverage),
    confidence: clamp01(fabric.supportMass),
    span: fullSpan,
    semanticRoleId: fabric.selectedTopicSenseId,
    learnedFrameOrPatternId: fabric.questionShapeId,
    requirementCoefficients: { inferentialDepth: Math.min(0.8, fabric.requestedSlotIds.length / 8) },
    trace: toJsonValue({ source: "question_cognitive_fabric", decision: fabric.decision, requestedSlotIds: fabric.requestedSlotIds })
  }));
  for (const fit of fabric.selectedFits) {
    out.push(normalizeActivation(requestText, {
      id: fit.cognitiveEdgeId,
      kind: "frame",
      activation: clamp01(fit.finalQuestionFit),
      confidence: clamp01(fit.semanticQuality),
      span: fullSpan,
      semanticRoleId: fit.relationRoleId,
      learnedFrameOrPatternId: fit.questionShapeId,
      trace: toJsonValue({ source: "question_edge_fit", requestedSlotId: fit.requestedSlotId, reasonIds: fit.reasonIds })
    }));
  }
}

function collectConstructActivations(requestText: string, graph: ConstructGraph | undefined, out: LearnedRequirementActivation[]): void {
  if (!graph) return;
  for (const node of graph.nodes) {
    const metadata = jsonRecord(node.metadata);
    const numericActivation = jsonNumber(metadata.activation);
    const requestSpan = jsonSpan(metadata.requestSpan);
    out.push(normalizeActivation(requestText, {
      id: node.id,
      kind: "construct",
      activation: clamp01(numericActivation ?? 0.5),
      confidence: clamp01(jsonNumber(metadata.confidence) ?? numericActivation ?? 0.5),
      span: requestSpan ?? fullRequestSpan(requestText),
      semanticRoleId: jsonString(metadata.semanticRoleId) ?? node.kind,
      learnedFrameOrPatternId: jsonString(metadata.frameId) ?? jsonString(metadata.patternId) ?? node.id,
      dialogueReferenceId: jsonString(metadata.dialogueReferenceId),
      requirementCoefficients: requirementCoefficients(metadata.requirementCoefficients),
      trace: toJsonValue({ source: "construct_graph", constructGraphId: graph.id, nodeKind: node.kind })
    }));
  }
}

function normalizeActivation(requestText: string, input: LearnedRequirementActivation): LearnedRequirementActivation {
  return {
    ...input,
    id: input.id || `activation.${stableId(`${input.kind}|${requestText}`)}`,
    activation: clamp01(finiteOr(input.activation, 0)),
    confidence: clamp01(finiteOr(input.confidence, input.activation)),
    span: boundedSpan(requestText, input.span),
    semanticRoleId: input.semanticRoleId || "role.structural.unspecified.v1",
    learnedFrameOrPatternId: input.learnedFrameOrPatternId || input.id || "pattern.structural.unspecified.v1",
    status: input.status ?? "inferred",
    polarity: input.polarity ?? "required",
    requirementCoefficients: finiteCoefficientVector(input.requirementCoefficients),
    trace: input.trace ?? toJsonValue({ source: "structural_activation" })
  };
}

function normalizeExplicitRequirement(requestText: string, input: ExplicitTurnRequirement, model: TurnRequirementCoefficientModel): { requirement: TurnRequirement; polarity: "required" | "prohibited"; logitContribution: number } {
  const confidence = clamp01(finiteOr(input.confidence, 1));
  const value = clamp01(finiteOr(input.value, 0));
  const requestSpan = spanFor(requestText, input.span);
  const sourceActivationId = input.sourceActivationId ?? "activation.structured_api.v1";
  const id = input.id ?? `requirement.${stableId(`${input.dimension}|${requestSpan.byteStart}|${requestSpan.byteEnd}|${input.learnedFrameOrPatternId}|${sourceActivationId}`)}`;
  return {
    polarity: input.polarity ?? "required",
    logitContribution: confidence * (boundedLogit(value) - finiteOr(model.intercepts[input.dimension], finiteOr(DEFAULT_TURN_REQUIREMENT_MODEL.intercepts[input.dimension], 0))),
    requirement: {
      id,
      dimension: input.dimension,
      value,
      confidence,
      status: input.status ?? "explicit",
      origin: {
        requestSpan,
        semanticRoleId: input.semanticRoleId,
        learnedFrameOrPatternId: input.learnedFrameOrPatternId,
        ...(input.dialogueReferenceId ? { dialogueReferenceId: input.dialogueReferenceId } : {})
      },
      sourceActivationId,
      trace: input.trace ?? toJsonValue({ source: "structured_api_metadata" })
    }
  };
}

function requirementFromActivation(input: {
  requestText: string;
  activation: LearnedRequirementActivation;
  dimension: TurnRequirementDimension;
  contribution: number;
  intercept: number;
}): TurnRequirement {
  const requestSpan = spanFor(input.requestText, input.activation.span);
  const value = clamp01(sigmoid(input.intercept + input.contribution));
  const confidence = clamp01(finiteOr(input.activation.confidence, input.activation.activation) * (1 - Math.exp(-Math.abs(input.contribution))));
  return {
    id: `requirement.${stableId(`${input.activation.id}|${input.dimension}|${requestSpan.byteStart}|${requestSpan.byteEnd}`)}`,
    dimension: input.dimension,
    value,
    confidence,
    status: input.activation.status ?? "inferred",
    origin: {
      requestSpan,
      semanticRoleId: input.activation.semanticRoleId ?? "role.structural.unspecified.v1",
      learnedFrameOrPatternId: input.activation.learnedFrameOrPatternId ?? input.activation.id,
      ...(input.activation.dialogueReferenceId ? { dialogueReferenceId: input.activation.dialogueReferenceId } : {})
    },
    sourceActivationId: input.activation.id,
    trace: toJsonValue({
      source: "learned_activation",
      activationKind: input.activation.kind,
      activation: input.activation.activation,
      contribution: input.contribution,
      activationTrace: input.activation.trace ?? null
    })
  };
}

function derivedContextContribution(dimension: TurnRequirementDimension, input: DeriveTurnRequirementFieldInput): number {
  if (dimension !== "dialogueDependence" || !input.dialogueState) return 0;
  const continuity = clamp01(input.dialogueState.continuityLinks.length / 4);
  const unresolved = clamp01(input.dialogueState.unresolvedSlots.length / 4);
  return finiteOr(0.45 * continuity + 0.25 * unresolved, 0);
}

function modelActivationWeight(model: TurnRequirementCoefficientModel, dimension: TurnRequirementDimension, activation: LearnedRequirementActivation): number {
  const weights = model.activationWeights[dimension];
  if (!weights) return 0;
  return finiteOr(weights[`${activation.kind}:${activation.id}`], finiteOr(weights[activation.id], 0));
}

function activatedIds(activations: readonly LearnedRequirementActivation[], kind: RequirementActivationKind): string[] {
  return [...new Set(activations.filter(row => row.kind === kind && row.activation > 0).map(row => row.id))].sort();
}

function uniqueRequirements(rows: readonly TurnRequirement[]): TurnRequirement[] {
  const byId = new Map<string, TurnRequirement>();
  for (const row of rows) {
    const previous = byId.get(row.id);
    if (!previous || row.confidence > previous.confidence) byId.set(row.id, row);
  }
  return [...byId.values()].sort((left, right) => right.confidence - left.confidence || left.id.localeCompare(right.id));
}

function clampRequirementField(field: TurnRequirementField): TurnRequirementField {
  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) field[dimension] = clamp01(finiteOr(field[dimension], 0));
  field.confidence = clamp01(finiteOr(field.confidence, 0));
  for (const requirement of [...field.requiredFeatures, ...field.prohibitedFeatures]) {
    requirement.value = clamp01(finiteOr(requirement.value, 0));
    requirement.confidence = clamp01(finiteOr(requirement.confidence, 0));
  }
  return field;
}

function emptyDimensionRecord(): Record<TurnRequirementDimension, number> {
  return Object.fromEntries(TURN_REQUIREMENT_DIMENSIONS.map(dimension => [dimension, 0])) as Record<TurnRequirementDimension, number>;
}

function finiteCoefficientVector(input: Partial<Record<TurnRequirementDimension, number>> | undefined): Partial<Record<TurnRequirementDimension, number>> {
  const out: Partial<Record<TurnRequirementDimension, number>> = {};
  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
    const value = input?.[dimension];
    if (value !== undefined && Number.isFinite(value)) out[dimension] = value;
  }
  return out;
}

function requirementCoefficients(value: JsonValue | undefined): Partial<Record<TurnRequirementDimension, number>> {
  const record = jsonRecord(value);
  const out: Partial<Record<TurnRequirementDimension, number>> = {};
  for (const dimension of TURN_REQUIREMENT_DIMENSIONS) {
    const coefficient = jsonNumber(record[dimension]);
    if (coefficient !== undefined) out[dimension] = coefficient;
  }
  return out;
}

function spanFor(text: string, span: RequirementActivationSpan | undefined): TurnRequirementSpan {
  const bounded = boundedSpan(text, span);
  const points = codePoints(text);
  const prefix = points.slice(0, bounded.charStart).join("");
  const surface = points.slice(bounded.charStart, bounded.charEnd).join("");
  return {
    text: surface,
    charStart: bounded.charStart,
    charEnd: bounded.charEnd,
    byteStart: byteLength(prefix),
    byteEnd: byteLength(prefix + surface)
  };
}

function boundedSpan(text: string, span: RequirementActivationSpan | undefined): RequirementActivationSpan {
  const length = codePoints(text).length;
  const charStart = Math.max(0, Math.min(length, Math.trunc(finiteOr(span?.charStart, 0))));
  const charEnd = Math.max(charStart, Math.min(length, Math.trunc(finiteOr(span?.charEnd, length))));
  return { charStart, charEnd };
}

function fullRequestSpan(text: string): RequirementActivationSpan {
  return { charStart: 0, charEnd: codePoints(text).length };
}

function learnedSurfaceSpans(text: string, surface: string): RequirementActivationSpan[] {
  if (!surface) return [];
  const spans: RequirementActivationSpan[] = [];
  let fromIndex = 0;
  while (fromIndex <= text.length - surface.length) {
    const utf16Start = text.indexOf(surface, fromIndex);
    if (utf16Start < 0) break;
    spans.push({
      charStart: codePoints(text.slice(0, utf16Start)).length,
      charEnd: codePoints(text.slice(0, utf16Start + surface.length)).length
    });
    fromIndex = utf16Start + surface.length;
  }
  return spans;
}

function jsonSpan(value: JsonValue | undefined): RequirementActivationSpan | undefined {
  const record = jsonRecord(value);
  const charStart = jsonNumber(record.charStart);
  const charEnd = jsonNumber(record.charEnd);
  return charStart === undefined || charEnd === undefined ? undefined : { charStart, charEnd };
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function jsonString(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function jsonNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function competenceConfidence(vector: readonly number[], alpha: number): number {
  const finite = vector.filter(Number.isFinite).map(clamp01);
  return clamp01(0.5 * clamp01(alpha) + 0.5 * mean(finite));
}

function supportValue(map: OperatorSupportMap | undefined, operatorId: CognitiveOperatorId): number {
  const value = finiteOr(map?.[operatorId], 0);
  return Math.max(-1, Math.min(1, value));
}

function operatorRecord(value: number): Record<CognitiveOperatorId, number> {
  return Object.fromEntries(Object.values(COGNITIVE_OPERATOR_IDS).map(id => [id, value])) as Record<CognitiveOperatorId, number>;
}

function boundedLogit(value: number): number {
  const p = Math.max(0.001, Math.min(0.999, clamp01(value)));
  return Math.log(p / (1 - p));
}

function sigmoid(value: number): number {
  const bounded = Math.max(-40, Math.min(40, finiteOr(value, 0)));
  return 1 / (1 + Math.exp(-bounded));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

function codePoints(text: string): string[] {
  return [...text];
}

function stableId(text: string): string {
  let hash = 0x811c9dc5;
  for (const point of codePoints(text)) {
    hash ^= point.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
