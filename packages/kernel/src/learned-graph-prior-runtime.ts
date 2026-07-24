import { scoreGraphEdgeQuality, type GraphEdgeQuality } from "./graph-edge-quality.js";
import {
  boundedEditDistance,
  collapsePriorWhitespace,
  genericQuestionSignal,
  hasPriorAnchorSignal,
  isPriorSeparator,
  jsonRecord,
  kernelClamp01,
  kernelNumber,
  kernelString,
  kernelStringArray,
  namedSubjectAnchors,
  normalizePriorKey,
  requestContentPriorUnits,
  requestContentSurface,
  splitPriorUnits,
  stripOuterPriorSeparators,
  uniqueKernelStrings,
} from "./kernel-answer-primitives.js";
import { featureSet, mean, sourceTextSurface, toJsonValue, weightedJaccard } from "./primitives.js";
import { graphEdgePriorClass, graphNodePriorClass, isLearnedPriorClass } from "./proof-boundary.js";
import {
  buildQuestionCognitiveFabric,
  normalizeRawGraphEdgeToCognitiveEdges,
  type CognitiveEdge,
  type QuestionCognitiveFabric,
  type QuestionEdgeFit
} from "./question-cognitive-edge.js";
import {
  ANSWER_ROLE_GROUPS,
  ANSWER_ROLE_IDS,
  ANSWER_SLOT_IDS,
  GRAPH_QUALITY_CLASS_IDS,
  GRAPH_SLOT_IDS,
  isBackgroundAnswerRoleId,
  isBridgeAnswerRoleId,
  QUESTION_EDGE_DECISION_IDS,
  RELATION_ROLE_IDS,
  type QuestionEdgeDecisionId
} from "./question-routing-ids.js";
import { planQuestionSlots, type QuestionSlotAssignment, type QuestionSlotPlan } from "./question-slot-planner.js";
import type { SemanticAnswerConstructFact } from "./semantic-answer-construct.js";
import type {
  ConstructGraph,
  EvidenceSpan,
  GraphEdge,
  GraphNode,
  JsonValue,
  TurnResult
} from "./types.js";




 const EXPLANATORY_CONTRACT_SLOT_IDS = {
  important: "qr.ec.93d70a4b",
  significance: "qr.ec.2f6b8c01",
  background: "qr.ec.7a41d9e3",
  boundary: "qr.ec.b0e54c28",
  subject: "qr.ec.11c6a7d5",
  role: "qr.ec.d4b08f61",
  primary: "qr.ec.5e31c0a9",
  context: "qr.ec.0a79f2d6",
  contextDomain: "qr.ec.8c16b4e0",
  definition: "qr.ec.f72a0d13",
  memberSet: "qr.ec.43e9b5a2",
  source: "qr.ec.a6d50e91",
  target: "qr.ec.9b27d4f8",
  effect: "qr.ec.6f01a8c3",
  request: "qr.ec.28d3e7b0"
} as const;


 interface LearnedGraphPriorFact {
  subject: string;
  predicate: string;
  object: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationId: string;
  forceClass: string;
  score: number;
  activation: number;
  overlap: number;
  support: number;
  sourceVersionId?: string;
  evidenceIds: string[];
  ppfMass: number;
  sourceActivation: number;
  targetActivation: number;
  graphQuality: GraphEdgeQuality;
  cognitiveEdge: CognitiveEdge;
  questionEdgeFit: QuestionEdgeFit;
}


 interface CleanPriorTerm {
  text: string;
  markerId?: string;
}


 interface SemanticAnswerSlot {
  id: string;
  relationIds: string[];
  factKeys: string[];
  support: number;
  activation: number;
}


 interface SemanticAnswerConstructState {
  schema: "scce.semantic_answer_construct.v1";
  questionShapeId: string;
  selectedSubject: string;
  selectedFacts: SemanticAnswerConstructFact[];
  answerSlots: SemanticAnswerSlot[];
  selectedRelations: string[];
  activatedNeighborhood: SemanticAnswerConstructFact[];
  rejectedCandidates: Array<{ relationId: string; sourceNodeId: string; targetNodeId: string; reasonId: string; score: number }>;
  supportIds: string[];
  forceId: "output.force.learned_concept_prior_answer";
  boundaryId: "output.force.import_bound";
  activeBrainVersion: string;
  activeImportRunIds: string[];
  relevanceGate: RelevanceGate;
  cognitiveFabric: QuestionCognitiveFabric;
  questionSlotPlan: QuestionSlotPlan;
  explanatoryAnswerContract: ExplanatoryAnswerContract;
  alphaRhetoricalPlan: AlphaRhetoricalPlan;
  certificationBoundary: {
    directEvidenceCount: number;
    evidenceSpanIds: string[];
    sourceVersionIds: string[];
    externalFactCertification: boolean;
  };
}


 type RelevanceGateDecision = QuestionEdgeDecisionId;


 interface RelevanceGate {
  schema: "scce.relevance_gate.v1";
  queryFingerprint: string;
  normalizedQuerySignals: string[];
  candidateSubjectMatches: Array<{ label: string; affinity: number; nodeIds: string[] }>;
  activatedNodeCount: number;
  activatedEdgeCount: number;
  selectedPathCount: number;
  maxSubjectAffinity: number;
  maxQuestionOverlap: number;
  alphaSupportMass: number;
  ppfSupportMass: number;
  relationSupportMass: number;
  answerGradeGraphPriorCount: number;
  weakGraphPriorCount: number;
  categoryGraphPriorCount: number;
  noisyGraphPriorCount: number;
  answerGradeSupportMass: number;
  weakGraphSupportMass: number;
  requestedCognitiveSupportCount: number;
  requestedCognitiveSupportMass: number;
  missingRequestedSlots: string[];
  selectedTopicSenseId: string;
  languageOnlySupportMass: number;
  directEvidenceCount: number;
  learnedGraphPriorCount: number;
  learnedLanguagePriorCount: number;
  relevanceScore: number;
  decision: RelevanceGateDecision;
  reasonIds: string[];
}


 interface ExplanatoryAnswerContract {
  schema: "scce.explanatory_answer_contract.v1";
  questionShapeId: string;
  mainSubjectCandidates: string[];
  selectedMainSubject: string;
  requestedFocuses: string[];
  requiredSlots: string[];
  optionalSlots: string[];
  filledSlots: string[];
  unsupportedSlots: string[];
  relevanceGate: RelevanceGate;
  alphaAnswerPlan?: AlphaRhetoricalPlan;
  rhetoricalPlan: JsonValue;
  certificationBoundary: JsonValue;
  targetSurfaceExtent: { floor: number; target: number; ceiling: number };
  questionSlotPlan?: QuestionSlotPlan;
}


 interface InsufficientSupportConstructState {
  schema: "scce.insufficient_support_construct.v1";
  questionShapeId: string;
  selectedMainSubject: string;
  requestedFocuses: string[];
  closestSubjectCandidates: string[];
  relevanceGate: RelevanceGate;
  explanatoryAnswerContract: ExplanatoryAnswerContract;
  activeBrainVersion: string;
  activeImportRunIds: string[];
  certificationBoundary: {
    directEvidenceCount: number;
    externalFactCertification: false;
  };
}


 interface GraphNodeAnswerConstructState {
  schema: "scce.graph_node_answer_construct.v1";
  questionShapeId: string;
  selectedSubject: string;
  requestedFocuses: string[];
  answerSurface: string;
  selectedNodes: GraphNodeAnswerRow[];
  forceId: "output.force.learned_graph_node_answer";
  boundaryId: "output.force.import_bound";
  activeBrainVersion: string;
  activeImportRunIds: string[];
  certificationBoundary: {
    directEvidenceCount: number;
    evidenceSpanIds: string[];
    sourceVersionIds: string[];
    externalFactCertification: boolean;
  };
}


 interface GraphNodeAnswerRow {
  nodeId: string;
  surface: string;
  score: number;
  alpha: number;
  activation: number;
  ppfMass: number;
  featureOverlap: number;
  surfaceOverlap: number;
  forceClass: string;
}


 interface AlphaRhetoricalAssignment {
  id: string;
  factKey: string;
  relationId: string;
  sourceNodeId: string;
  targetNodeId: string;
  roleId: string;
  arc: number;
  pathScore: number;
  roleScore: number;
  pathActivation: number;
  relationSupport: number;
  bridgeValue: number;
  backgroundPenalty: number;
  contradictionPressure: number;
  forceMeaning: number;
  certificationPower: number;
  semanticQuality: number;
  graphQualityClassId: string;
  answerGrade: boolean;
  selected: boolean;
  shouldSurface: boolean;
}


 interface AlphaRhetoricalPlan {
  schema: "scce.alpha_rhetorical_plan.v1";
  plannerId: "walsh.alpha_rhetorical_centrality";
  selectedSubject: string;
  selectedSubjectNodeIds: string[];
  requiredRoleIds: string[];
  optionalRoleIds: string[];
  selectedRoleIds: string[];
  backgroundRoleIds: string[];
  assignments: AlphaRhetoricalAssignment[];
  selectedFactKeys: string[];
  backgroundFactKeys: string[];
  planEnergy: number;
  explanationCompleteness: number;
  targetSentenceCount: number;
  proofBoundaryId: "output.force.import_bound";
  audit: JsonValue;
}


export function attachLearnedGraphPriorConstruct(input: {
  construct: ConstructGraph;
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
  selectedEvidence: readonly EvidenceSpan[];
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
}): ConstructGraph {
  const state = learnedGraphPriorConstructState(input);
  if (!state) {
    const nodeAnswer = graphNodeAnswerConstructState(input);
    if (nodeAnswer) {
      const nodeId = `construct:graph-node-answer:${input.hasher.digestHex(JSON.stringify(nodeAnswer.selectedNodes.map(node => node.nodeId))).slice(0, 20)}`;
      const nodes = input.construct.nodes.filter(node => node.kind !== "construct:graph_node_answer");
      const edges = input.construct.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
      return {
        ...input.construct,
        nodes: [
          ...nodes,
          {
            id: nodeId,
            kind: "construct:graph_node_answer",
            label: nodeAnswer.selectedSubject || "construct.graph_node_answer",
            metadata: toJsonValue(nodeAnswer)
          }
        ],
        edges: [
          ...edges,
          ...nodeAnswer.selectedNodes.map(row => ({ source: nodeId, target: row.nodeId, relation: "uses_prior_node", weight: row.score }))
        ]
      };
    }
    const insufficient = insufficientSupportConstructState(input);
    if (!insufficient) return input.construct;
    const nodeId = `construct:insufficient-support:${input.hasher.digestHex(JSON.stringify(insufficient.relevanceGate)).slice(0, 20)}`;
    const nodes = input.construct.nodes.filter(node => node.kind !== "construct:insufficient_support");
    const edges = input.construct.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
    return {
      ...input.construct,
      nodes: [
        ...nodes,
        {
          id: nodeId,
          kind: "construct:insufficient_support",
          label: insufficient.selectedMainSubject || "construct.insufficient_support",
          metadata: toJsonValue(insufficient)
        }
      ],
      edges
    };
  }
  const nodeId = `construct:semantic-answer:${input.hasher.digestHex(JSON.stringify(state.supportIds)).slice(0, 20)}`;
  const nodes = input.construct.nodes.filter(node => node.kind !== "construct:semantic_answer");
  const edges = input.construct.edges.filter(edge => edge.source !== nodeId && edge.target !== nodeId);
  return {
    ...input.construct,
    nodes: [
      ...nodes,
      {
        id: nodeId,
        kind: "construct:semantic_answer",
        label: state.selectedSubject || "construct.semantic_answer",
        metadata: toJsonValue(state)
      }
    ],
    edges: [
      ...edges,
      ...state.selectedFacts.flatMap(fact => [
        { source: nodeId, target: fact.sourceNodeId, relation: "uses_prior_subject", weight: fact.support },
        { source: nodeId, target: fact.targetNodeId, relation: "uses_prior_object", weight: fact.support }
      ])
    ]
  };
}


 function learnedGraphPriorConstructState(input: {
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
  selectedEvidence: readonly EvidenceSpan[];
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
}): SemanticAnswerConstructState | undefined {
  const marker = jsonRecord(input.brainMarker);
  const activeBrainVersion = kernelString(marker.activeBrainVersion) ?? (input.selectedEvidence.length ? "runtime.direct_evidence" : "");
  if (!activeBrainVersion) return undefined;
  const learnedPriorCount =
    kernelNumber(marker.importedLearnedPriorCount) +
    kernelNumber(marker.importedGraphPriorCount) +
    kernelNumber(marker.importedLanguagePriorCount) +
    kernelNumber(marker.importedProgramPriorCount);
  if (learnedPriorCount <= 0 && input.selectedEvidence.length <= 0) return undefined;
  const ranked = rankedLearnedGraphPriorFacts(input);
  const cognitiveFabric = cognitiveFabricFromFacts(ranked, input.requestText);
  const initialAlphaPlan = createAlphaRhetoricalPlan({
    ranked,
    requestText: input.requestText,
    field: input.field,
    hasher: input.hasher
  });
  const preliminarySlotSelection = questionSlotSelectionForPriorFacts({
    ranked,
    requestText: input.requestText,
    selectedSubject: initialAlphaPlan?.selectedSubject || cognitiveTopicForRequest(input.requestText),
    alphaPlan: initialAlphaPlan
  });
  const gate = relevanceGateFor({
    requestText: input.requestText,
    ranked,
    cognitiveFabric,
    questionSlotPlan: preliminarySlotSelection?.plan,
    alphaPlan: initialAlphaPlan,
    field: input.field,
    brainMarker: marker,
    selectedEvidence: input.selectedEvidence,
    hasher: input.hasher
  });
  if (!relevanceGateCanSpeakPriorAnswer(gate)) return undefined;
  const gateSelectedSubject = gate.candidateSubjectMatches[0]?.label || cognitiveTopicForRequest(input.requestText);
  const selectedSubject = gateSelectedSubject || initialAlphaPlan?.selectedSubject || "";
  const initialAlphaPlanUsable = Boolean(initialAlphaPlan && semanticAnswerSubjectAllowed(input.requestText, initialAlphaPlan.selectedSubject, gate) && (!gateSelectedSubject || samePriorEntity(initialAlphaPlan.selectedSubject, gateSelectedSubject)));
  const alphaPlan = initialAlphaPlanUsable ? initialAlphaPlan : createFallbackAlphaRhetoricalPlan({
    ranked,
    selectedSubject,
    requestText: input.requestText,
    field: input.field,
    hasher: input.hasher
  }) ?? createMinimalAlphaRhetoricalPlan({
    ranked,
    selectedSubject,
    cognitiveFabric
  });
  if (!alphaPlan) return undefined;
  if (!semanticAnswerSubjectAllowed(input.requestText, alphaPlan.selectedSubject, gate)) return undefined;
  const factByKey = new Map(ranked.map(fact => [semanticFactKey(fact), fact]));
  const slotSelection = questionSlotSelectionForPriorFacts({
    ranked,
    requestText: input.requestText,
    selectedSubject: alphaPlan.selectedSubject,
    alphaPlan
  });
  if (!slotSelection) return undefined;
  const { plan: questionSlotPlan, topicFacts, assignmentByFactKey } = slotSelection;
  if (!questionSlotPlanAllowsPriorAnswer(questionSlotPlan, gate)) return undefined;
  const slotAssignmentByFactKey = new Map<string, QuestionSlotAssignment>();
  const orderedSlotAssignments = [...questionSlotPlan.selectedAnswerCore, ...questionSlotPlan.selectedContext];
  if (!orderedSlotAssignments.length) return undefined;
  orderedSlotAssignments.forEach((assignment, index) => {
    const existing = slotAssignmentByFactKey.get(assignment.factKey);
    if (!existing || assignment.score > existing.score || index < orderedSlotAssignments.findIndex(row => row.factKey === existing.factKey)) slotAssignmentByFactKey.set(assignment.factKey, assignment);
  });
  const slotOrder = new Map(orderedSlotAssignments.map((assignment, index) => [assignment.factKey, index]));
  const facts = uniqueLearnedFacts(orderedSlotAssignments
    .map(assignment => factByKey.get(assignment.factKey))
    .filter((fact): fact is LearnedGraphPriorFact => Boolean(fact)))
    .sort((left, right) => (slotOrder.get(semanticFactKey(left)) ?? 999) - (slotOrder.get(semanticFactKey(right)) ?? 999))
    .slice(0, 10);
  if (!facts.length) return undefined;
  const answerSlots = semanticAnswerSlots(facts, input.hasher);
  const selectedRelations = uniqueKernelStrings(facts.map(fact => fact.relationId));
  const certifyingEvidenceIds = uniqueKernelStrings([
    ...input.selectedEvidence.map(span => String(span.id)),
    ...facts.filter(fact => fact.forceClass === "direct_evidence").flatMap(fact => fact.evidenceIds)
  ]);
  const selectedSourceVersionIds = uniqueKernelStrings([
    ...input.selectedEvidence.map(span => String(span.sourceVersionId)),
    ...facts.map(fact => fact.sourceVersionId ?? "")
  ]);
  const activatedNeighborhood = facts
    .slice()
    .sort((left, right) => right.activation - left.activation || right.score - left.score)
    .slice(0, 12);
  const selectedKeys = new Set(facts.map(semanticFactKey));
  const rejectedCandidates = ranked
    .filter(fact => !selectedKeys.has(semanticFactKey(fact)))
    .slice(0, 16)
    .map(fact => ({
      relationId: fact.relationId,
      sourceNodeId: fact.sourceNodeId,
      targetNodeId: fact.targetNodeId,
      reasonId: "semantic_answer.selection.outside_neighborhood",
      score: fact.score
    }));
  return {
    schema: "scce.semantic_answer_construct.v1",
    questionShapeId: semanticQuestionShapeId(facts, input.requestText, input.hasher, alphaPlan),
    selectedSubject: alphaPlan?.selectedSubject || facts[0]?.subject || "",
    selectedFacts: facts.map(fact => ({
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      sourceNodeId: fact.sourceNodeId,
      targetNodeId: fact.targetNodeId,
      relationId: fact.relationId,
      forceClass: fact.forceClass,
      score: fact.score,
      activation: fact.activation,
      overlap: fact.overlap,
      support: fact.support,
      sourceVersionId: fact.sourceVersionId,
      evidenceIds: fact.evidenceIds,
      roleId: assignmentByFactKey.get(semanticFactKey(fact))?.roleId,
      alphaRhetoricalCentrality: assignmentByFactKey.get(semanticFactKey(fact))?.arc,
      pathScore: assignmentByFactKey.get(semanticFactKey(fact))?.pathScore,
      roleScore: assignmentByFactKey.get(semanticFactKey(fact))?.roleScore,
      bridgeValue: assignmentByFactKey.get(semanticFactKey(fact))?.bridgeValue,
      backgroundPenalty: assignmentByFactKey.get(semanticFactKey(fact))?.backgroundPenalty,
      forceMeaning: assignmentByFactKey.get(semanticFactKey(fact))?.forceMeaning,
      certificationPower: assignmentByFactKey.get(semanticFactKey(fact))?.certificationPower,
      semanticQuality: fact.graphQuality.semanticQuality,
      graphQualityClassId: fact.graphQuality.classId,
      answerGrade: factQuestionFitAllowsSurface(fact),
      cognitiveEdgeId: fact.cognitiveEdge.id,
      requestedSlotId: fact.questionEdgeFit.requestedSlotId,
      relationRoleId: fact.questionEdgeFit.relationRoleId,
      topicSenseId: fact.questionEdgeFit.topicSenseId,
      finalQuestionFit: fact.questionEdgeFit.finalQuestionFit,
      questionSlotId: slotAssignmentByFactKey.get(semanticFactKey(fact))?.slotId,
      questionSlotImportance: slotAssignmentByFactKey.get(semanticFactKey(fact))?.importance,
      questionSlotScore: slotAssignmentByFactKey.get(semanticFactKey(fact))?.score,
      questionSlotReasonIds: slotAssignmentByFactKey.get(semanticFactKey(fact))?.reasonIds
    })),
    answerSlots,
    selectedRelations,
    activatedNeighborhood: activatedNeighborhood.map(fact => ({
      subject: fact.subject,
      predicate: fact.predicate,
      object: fact.object,
      sourceNodeId: fact.sourceNodeId,
      targetNodeId: fact.targetNodeId,
      relationId: fact.relationId,
      forceClass: fact.forceClass,
      score: fact.score,
      activation: fact.activation,
      overlap: fact.overlap,
      support: fact.support,
      sourceVersionId: fact.sourceVersionId,
      evidenceIds: fact.evidenceIds,
      roleId: assignmentByFactKey.get(semanticFactKey(fact))?.roleId,
      alphaRhetoricalCentrality: assignmentByFactKey.get(semanticFactKey(fact))?.arc,
      pathScore: assignmentByFactKey.get(semanticFactKey(fact))?.pathScore,
      roleScore: assignmentByFactKey.get(semanticFactKey(fact))?.roleScore,
      bridgeValue: assignmentByFactKey.get(semanticFactKey(fact))?.bridgeValue,
      backgroundPenalty: assignmentByFactKey.get(semanticFactKey(fact))?.backgroundPenalty,
      forceMeaning: assignmentByFactKey.get(semanticFactKey(fact))?.forceMeaning,
      certificationPower: assignmentByFactKey.get(semanticFactKey(fact))?.certificationPower,
      semanticQuality: fact.graphQuality.semanticQuality,
      graphQualityClassId: fact.graphQuality.classId,
      answerGrade: factQuestionFitAllowsSurface(fact),
      cognitiveEdgeId: fact.cognitiveEdge.id,
      requestedSlotId: fact.questionEdgeFit.requestedSlotId,
      relationRoleId: fact.questionEdgeFit.relationRoleId,
      topicSenseId: fact.questionEdgeFit.topicSenseId,
      finalQuestionFit: fact.questionEdgeFit.finalQuestionFit,
      questionSlotId: slotAssignmentByFactKey.get(semanticFactKey(fact))?.slotId,
      questionSlotImportance: slotAssignmentByFactKey.get(semanticFactKey(fact))?.importance,
      questionSlotScore: slotAssignmentByFactKey.get(semanticFactKey(fact))?.score,
      questionSlotReasonIds: slotAssignmentByFactKey.get(semanticFactKey(fact))?.reasonIds
    })),
    rejectedCandidates,
    supportIds: uniqueKernelStrings(facts.flatMap(fact => [fact.sourceNodeId, fact.targetNodeId, fact.relationId, fact.sourceVersionId ?? "", ...fact.evidenceIds])),
    forceId: "output.force.learned_concept_prior_answer",
    boundaryId: "output.force.import_bound",
    activeBrainVersion,
    activeImportRunIds: kernelStringArray(marker.activeImportRunIds),
    relevanceGate: gate,
    cognitiveFabric,
    questionSlotPlan,
    explanatoryAnswerContract: explanatoryAnswerContractFor({ requestText: input.requestText, gate, alphaPlan, facts, cognitiveFabric, questionSlotPlan, hasher: input.hasher }),
    alphaRhetoricalPlan: alphaPlan,
    certificationBoundary: {
      directEvidenceCount: input.selectedEvidence.length,
      evidenceSpanIds: certifyingEvidenceIds,
      sourceVersionIds: selectedSourceVersionIds,
      externalFactCertification: certifyingEvidenceIds.length > 0
    }
  };
}


 function relevanceGateCanSpeakPriorAnswer(gate: RelevanceGate): boolean {
  return gate.decision === QUESTION_EDGE_DECISION_IDS.directEvidence ||
    gate.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport ||
    gate.decision === QUESTION_EDGE_DECISION_IDS.partialSupport;
}


 function createMinimalAlphaRhetoricalPlan(input: {
  ranked: readonly LearnedGraphPriorFact[];
  selectedSubject: string;
  cognitiveFabric: QuestionCognitiveFabric;
}): AlphaRhetoricalPlan | undefined {
  const subject = input.selectedSubject.trim();
  if (!subject) return undefined;
  const subjectFacts = input.ranked.filter(fact => factTopicMatchesSelected(fact, subject)).slice(0, 12);
  if (!subjectFacts.length) return undefined;
  return {
    schema: "scce.alpha_rhetorical_plan.v1",
    plannerId: "walsh.alpha_rhetorical_centrality",
    selectedSubject: subject,
    selectedSubjectNodeIds: uniqueKernelStrings(subjectFacts.filter(fact => factSubjectMatchesSelected(fact, subject)).map(fact => fact.sourceNodeId)),
    requiredRoleIds: [],
    optionalRoleIds: [],
    selectedRoleIds: uniqueKernelStrings(subjectFacts.map(fact => rhetoricalRoleFromRelationRoleId(fact.questionEdgeFit.relationRoleId))),
    backgroundRoleIds: [],
    assignments: [],
    selectedFactKeys: subjectFacts.map(semanticFactKey),
    backgroundFactKeys: [],
    planEnergy: kernelClamp01(1 - input.cognitiveFabric.supportMass),
    explanationCompleteness: input.cognitiveFabric.supportMass,
    targetSentenceCount: Math.max(2, Math.min(4, subjectFacts.length)),
    proofBoundaryId: "output.force.import_bound",
    audit: toJsonValue({ fallback: "minimal_cognitive_fabric", selectedFitCount: input.cognitiveFabric.selectedFits.length })
  };
}


 function createFallbackAlphaRhetoricalPlan(input: {
  ranked: readonly LearnedGraphPriorFact[];
  selectedSubject: string;
  requestText: string;
  field: TurnResult["field"];
  hasher: { digestHex(input: string | Uint8Array): string };
}): AlphaRhetoricalPlan | undefined {
  const subject = input.selectedSubject.trim();
  if (!subject) return undefined;
  const anchors = priorRequestAnchors(input.requestText);
  const subjectFacts = input.ranked.filter(fact => factTopicMatchesSelected(fact, subject)).slice(0, 96);
  if (!subjectFacts.length) return undefined;
  const bridgeAnchors = specificPriorBridgeAnchors(subjectFacts);
  const contradictionPressure = kernelClamp01(input.field.alphaTrace.surfaces.contradiction * 0.58 + input.field.alphaTrace.contradictionMass * 0.42);
  const assignmentCandidates = subjectFacts
    .map(fact => alphaRhetoricalAssignment({ fact, subject, anchors, bridgeAnchors, contradictionPressure, hasher: input.hasher }))
    .sort((left, right) => right.arc - left.arc || right.pathScore - left.pathScore || left.factKey.localeCompare(right.factKey));
  const assignments = assignmentCandidates.filter(assignment => assignment.arc > 0.0001 || assignment.pathScore > 0.18);
  const fallbackAssignments = assignments.length ? assignments : assignmentCandidates.slice(0, 12);
  if (!fallbackAssignments.length) return undefined;
  const selected = selectAlphaRhetoricalAssignments(fallbackAssignments);
  const selectedKeys = new Set(selected.map(assignment => assignment.factKey));
  const allAssignments = fallbackAssignments.map(assignment => ({
    ...assignment,
    selected: selectedKeys.has(assignment.factKey),
    shouldSurface: selectedKeys.has(assignment.factKey) && assignment.shouldSurface
  }));
  const selectedRoleIds = uniqueKernelStrings(selected.map(assignment => assignment.roleId));
  const requiredRoleIds = [...ANSWER_ROLE_GROUPS.required];
  const bridgeCoverage = selectedRoleIds.some(isBridgeAnswerRoleId) ? 1 : 0;
  const supportMass = mean(selected.map(assignment => assignment.arc || assignment.pathScore));
  const missingRequired = requiredRoleIds.filter(roleId => !selectedRoleIds.includes(roleId)).length;
  const targetSentenceCount = alphaRhetoricalTargetSentenceCount({ selected, bridgeCoverage, supportMass, missingRequired });
  return {
    schema: "scce.alpha_rhetorical_plan.v1",
    plannerId: "walsh.alpha_rhetorical_centrality",
    selectedSubject: subject,
    selectedSubjectNodeIds: uniqueKernelStrings(subjectFacts.filter(fact => factSubjectMatchesSelected(fact, subject)).map(fact => fact.sourceNodeId)),
    requiredRoleIds,
    optionalRoleIds: [...ANSWER_ROLE_GROUPS.optional],
    selectedRoleIds,
    backgroundRoleIds: [...ANSWER_ROLE_GROUPS.background],
    assignments: allAssignments.slice(0, 64),
    selectedFactKeys: selected.map(assignment => assignment.factKey),
    backgroundFactKeys: selected.filter(assignment => isBackgroundAnswerRoleId(assignment.roleId)).map(assignment => assignment.factKey),
    planEnergy: kernelClamp01(missingRequired * 0.18 + Math.max(0, 0.42 - supportMass) - bridgeCoverage * 0.08),
    explanationCompleteness: kernelClamp01(0.34 * (1 - missingRequired / requiredRoleIds.length) + 0.24 * bridgeCoverage + 0.24 * supportMass + 0.18 * Math.min(1, selected.length / 4)),
    targetSentenceCount,
    proofBoundaryId: "output.force.import_bound",
    audit: toJsonValue({
      inputFactCount: input.ranked.length,
      assignmentCount: allAssignments.length,
      contradictionPressure,
      supportMass,
      bridgeCoverage,
      missingRequired,
      selectedRoleIds,
      fallback: true
    })
  };
}


 function selectedSubjectCategoryLabelFact(fact: LearnedGraphPriorFact, alphaPlan: AlphaRhetoricalPlan): boolean {
  if (fact.graphQuality.classId !== GRAPH_QUALITY_CLASS_IDS.catalogNavigation) return false;
  if (!alphaPlan.selectedSubjectNodeIds.includes(fact.sourceNodeId)) return false;
  return fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership ||
    fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompoundMembership ||
    fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphNavigation;
}


 function questionSlotSelectionForPriorFacts(input: {
  ranked: readonly LearnedGraphPriorFact[];
  requestText: string;
  selectedSubject: string;
  alphaPlan?: AlphaRhetoricalPlan;
}): { plan: QuestionSlotPlan; topicFacts: LearnedGraphPriorFact[]; assignmentByFactKey: Map<string, AlphaRhetoricalAssignment> } | undefined {
  const selectedSubject = input.selectedSubject.trim();
  if (!selectedSubject) return undefined;
  const assignmentByFactKey = new Map((input.alphaPlan?.assignments ?? []).map(assignment => [assignment.factKey, assignment]));
  const topicFacts = input.ranked
    .filter(fact => factTopicMatchesSelected(fact, selectedSubject))
    .filter(fact => !input.alphaPlan || !selectedSubjectCategoryLabelFact(fact, input.alphaPlan))
    .filter(fact => factQuestionFitAllowsSurface(fact) || topicCompoundMembershipAnswerFact(fact))
    .filter(fact => questionShapeAllowsPriorFact(fact, input.requestText) || topicCompoundMembershipAnswerFact(fact));
  const plan = planQuestionSlots({
    questionText: input.requestText,
    selectedTopic: selectedSubject,
    facts: topicFacts
      .slice(0, 160)
      .map(fact => {
        const key = semanticFactKey(fact);
        const assignment = assignmentByFactKey.get(key);
        return {
          factKey: key,
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          relationId: fact.relationId,
          forceClass: fact.forceClass,
          score: fact.score,
          support: fact.support,
          alphaSupport: fact.activation,
          ppfSupport: fact.ppfMass,
          semanticQuality: fact.graphQuality.semanticQuality,
          graphQualityClassId: fact.graphQuality.classId,
          answerGrade: fact.graphQuality.answerGrade,
          requestedSlotId: fact.questionEdgeFit.requestedSlotId,
          relationRoleId: fact.questionEdgeFit.relationRoleId,
          topicSenseId: fact.questionEdgeFit.topicSenseId,
          finalQuestionFit: fact.questionEdgeFit.finalQuestionFit,
          upstreamRoleId: assignment?.roleId,
          alphaRhetoricalCentrality: assignment?.arc
        };
      })
  });
  return { plan, topicFacts, assignmentByFactKey };
}


 function questionSlotPlanAllowsPriorAnswer(plan: QuestionSlotPlan, gate: RelevanceGate): boolean {
  if (!plan.selectedAnswerCore.length) return false;
  return gate.decision === QUESTION_EDGE_DECISION_IDS.directEvidence ||
    gate.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport ||
    gate.decision === QUESTION_EDGE_DECISION_IDS.partialSupport;
}


 function topicCompoundMembershipAnswerFact(fact: LearnedGraphPriorFact): boolean {
  if (fact.questionEdgeFit.relationRoleId !== RELATION_ROLE_IDS.graphRequestMembership) return false;
  if (samePriorEntity(fact.subject, fact.object)) return false;
  const objectMass = semanticPriorSurfaceMass(fact.object);
  return objectMass > 0 && objectMass <= 5 && fact.questionEdgeFit.finalQuestionFit >= 0.3;
}


 function fallbackQuestionSlotAssignments(facts: readonly LearnedGraphPriorFact[], requestText: string): QuestionSlotAssignment[] {
  const anchors = priorRequestAnchors(requestText);
  const selected = uniqueLearnedFacts([
    ...facts.filter(topicCompoundMembershipAnswerFact),
    ...expandGraphPriorAnswerNeighborhood({
      ranked: facts,
      prioritized: prioritizeGraphPriorFacts(facts, requestText),
      requestText
    })
  ])
    .filter(fact => factCompletenessScore(fact, anchors) > 0.08 || topicCompoundMembershipAnswerFact(fact))
    .sort((left, right) =>
      Number(topicCompoundMembershipAnswerFact(right)) - Number(topicCompoundMembershipAnswerFact(left)) ||
      factCompletenessScore(right, anchors) - factCompletenessScore(left, anchors) ||
      right.score - left.score ||
      right.support - left.support
    )
    .slice(0, 10);
  return selected.map((fact, index): QuestionSlotAssignment => ({
    factKey: semanticFactKey(fact),
    slotId: topicCompoundMembershipAnswerFact(fact) ? ANSWER_SLOT_IDS.memberRelation : fact.questionEdgeFit.requestedSlotId || ANSWER_SLOT_IDS.knownForContribution,
    importance: "core",
    score: kernelClamp01(0.44 + factCompletenessScore(fact, anchors) * 0.28 + fact.questionEdgeFit.finalQuestionFit * 0.28),
    reasonIds: ["qr.qr.d20a6b4e"],
    topicSenseId: fact.questionEdgeFit.topicSenseId || `topic_sense.${index}`
  }));
}


 function cognitiveFabricSlotAssignments(facts: readonly LearnedGraphPriorFact[], fabric: QuestionCognitiveFabric): QuestionSlotAssignment[] {
  const selectedFitIds = new Set(fabric.selectedFits.map(fit => fit.cognitiveEdgeId));
  const selected = facts
    .filter(fact => selectedFitIds.has(fact.cognitiveEdge.id))
    .sort((left, right) =>
      right.questionEdgeFit.finalQuestionFit - left.questionEdgeFit.finalQuestionFit ||
      right.score - left.score ||
      right.support - left.support
    )
    .slice(0, 8);
  return selected.map((fact, index): QuestionSlotAssignment => ({
    factKey: semanticFactKey(fact),
    slotId: fact.questionEdgeFit.requestedSlotId || ANSWER_SLOT_IDS.knownForContribution,
    importance: "core",
    score: kernelClamp01(0.42 + fact.questionEdgeFit.finalQuestionFit * 0.42 + fact.support * 0.16),
    reasonIds: ["qr.qr.0a59c3f8"],
    topicSenseId: fact.questionEdgeFit.topicSenseId || `topic_sense.fabric.${index}`
  }));
}


 function rhetoricalRoleFromRelationRoleId(value: string): string {
  if (value === RELATION_ROLE_IDS.graphCompactAttribute) return ANSWER_ROLE_IDS.identity;
  if (value === RELATION_ROLE_IDS.graphRequestRelation || value === RELATION_ROLE_IDS.graphExplanatoryPath || value === RELATION_ROLE_IDS.graphRequestMembership) return ANSWER_ROLE_IDS.contribution;
  if (value === RELATION_ROLE_IDS.graphContextRelation || value === RELATION_ROLE_IDS.graphContextBridge || value === RELATION_ROLE_IDS.graphCompoundAttribute || value === RELATION_ROLE_IDS.graphCompoundMembership) return ANSWER_ROLE_IDS.context;
  return ANSWER_ROLE_IDS.field;
}


 function rankedLearnedGraphPriorFacts(input: {
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
}): LearnedGraphPriorFact[] {
  const requestFeatures = featureSet(input.requestText, 512);
  const unitSpecificity = requestUnitSpecificity(input.graph.nodes, new Set(requestFeatures));
  const primaryUnits = primarySpecificRequestUnits(unitSpecificity);
  const requestAnchors = priorRequestAnchors(input.requestText);
  const selectedTopic = cognitiveTopicForRequest(input.requestText);
  const nodeById = new Map(input.graph.nodes.map(node => [String(node.id), node]));
  const activationByNodeId = new Map(input.field.active.map(row => [String(row.nodeId), row.activation]));
  const ppfMassByNodeId = new Map(input.field.ppf.map(row => [String(row.nodeId), row.mass]));
  const facts: LearnedGraphPriorFact[] = [];
  for (const edge of input.graph.edges) {
    const sourceNode = nodeById.get(String(edge.source));
    const targetNode = nodeById.get(String(edge.target));
    const edgeClass = graphEdgePriorClass(edge);
    const sourceClass = sourceNode ? graphNodePriorClass(sourceNode) : "none";
    const targetClass = targetNode ? graphNodePriorClass(targetNode) : "none";
    const edgeEvidenceIds = edge.evidenceIds.map(String);
    const learnedPriorClass = isLearnedPriorClass(edgeClass) ? edgeClass : isLearnedPriorClass(sourceClass) ? sourceClass : isLearnedPriorClass(targetClass) ? targetClass : "";
    const forceClass = learnedPriorClass || (edgeEvidenceIds.length ? "direct_evidence" : "");
    if (!forceClass) continue;
    if (forceClass !== "learned_concept_prior" && forceClass !== "direct_evidence") continue;
    const metadata = jsonRecord(edge.metadata);
    const sourceMetadata = jsonRecord(sourceNode?.metadata);
    const targetMetadata = jsonRecord(targetNode?.metadata);
    const relation = jsonRecord(metadata.relation);
    const rawSubject = cleanPriorTerm(kernelString(relation.subject) || graphNodeSurface(sourceNode));
    const rawPredicate = cleanPriorTerm(kernelString(relation.predicate) || String(edge.relationId));
    const rawObject = cleanPriorTerm(kernelString(relation.object) || graphNodeSurface(targetNode));
    if (!rawSubject.text || !rawPredicate.text || !rawObject.text) continue;
    if (priorSurfaceLooksStructuralDebris(rawSubject.text) || priorSurfaceLooksStructuralDebris(rawObject.text)) continue;
    if (rawSubject.markerId === "question" || rawSubject.markerId === "object") continue;
    if (rawObject.markerId === "question") continue;
    if (rawSubject.text === rawObject.text) continue;
    const subject = displayPriorTerm(rawSubject.text, "subject");
    const predicate = rawPredicate.text.toLocaleLowerCase();
    const object = displayPriorTerm(rawObject.text, "object");
    if (primaryUnits.length && !graphPriorFactMatchesPrimaryUnit({ subject, predicate, object, sourceNode, targetNode, primaryUnits })) continue;
    const graphQuality = scoreGraphEdgeQuality({
      edgeId: String(edge.id),
      relationId: String(edge.relationId),
      subject,
      predicate,
      object,
      weight: edge.weight,
      alpha: edge.alpha,
      forceClass,
      sourceShardSupport: kernelNumber(relation.confidence, edge.weight)
    });
    if (!priorFactAdmissibleForAnswer(subject, predicate, object, requestAnchors) && graphQuality.semanticQuality < 0.2) continue;
    const sourceActivation = activationByNodeId.get(String(edge.source)) ?? 0;
    const targetActivation = activationByNodeId.get(String(edge.target)) ?? 0;
    const activation = Math.max(sourceActivation, targetActivation);
    const ppfMass = Math.max(ppfMassByNodeId.get(String(edge.source)) ?? 0, ppfMassByNodeId.get(String(edge.target)) ?? 0);
    const support = Math.max(0, Math.min(1, kernelNumber(relation.confidence, edge.weight)));
    const cognitiveEdges = normalizeRawGraphEdgeToCognitiveEdges({
      rawEdgeId: String(edge.id),
      relationId: String(edge.relationId),
      subject,
      predicate,
      object,
      forceClass,
      semanticQuality: graphQuality.semanticQuality,
      graphQuality,
      alphaSupport: activation,
      ppfSupport: ppfMass,
      supportMass: support,
      selectedTopic,
      requestText: input.requestText
    });
    for (const cognitive of cognitiveEdges) {
      const factText = `${cognitive.cognitiveEdge.subjectRef} ${cognitive.cognitiveEdge.sourceDerivedLabels.predicate} ${cognitive.cognitiveEdge.objectRef}`;
      const overlap = weightedJaccard(requestFeatures, featureSet(factText, 512));
      const qualityMass = graphQuality.answerGrade || cognitive.fit.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport
        ? Math.max(graphQuality.semanticQuality, cognitive.fit.finalQuestionFit)
        : Math.max(graphQuality.semanticQuality * 0.32, cognitive.fit.finalQuestionFit * 0.5);
      const score = (
        overlap * 0.24 +
        activation * 0.16 +
        ppfMass * 0.1 +
        support * 0.08 +
        graphQuality.semanticQuality * 0.12 +
        cognitive.fit.finalQuestionFit * 0.3
      ) * qualityMass;
      if (overlap <= 0 && activation <= 0.00001 && cognitive.fit.finalQuestionFit < 0.18) continue;
      facts.push({
        subject: cognitive.cognitiveEdge.subjectRef,
        predicate: cognitive.cognitiveEdge.sourceDerivedLabels.predicate.toLocaleLowerCase(),
        object: cognitive.cognitiveEdge.objectRef,
        sourceNodeId: String(edge.source),
        targetNodeId: String(edge.target),
        relationId: String(edge.relationId),
        forceClass,
        score,
        activation,
        overlap,
        support,
        sourceVersionId: kernelString(metadata.sourceVersionId) ?? kernelString(sourceMetadata.sourceVersionId) ?? kernelString(targetMetadata.sourceVersionId),
        evidenceIds: edgeEvidenceIds,
        ppfMass,
        sourceActivation,
        targetActivation,
        graphQuality,
        cognitiveEdge: cognitive.cognitiveEdge,
        questionEdgeFit: cognitive.fit
      });
    }
  }
  return uniqueLearnedFacts(facts)
    .sort((left, right) => right.score - left.score || right.support - left.support || left.subject.localeCompare(right.subject));
}


 function graphPriorFactMatchesPrimaryUnit(input: {
  subject: string;
  predicate: string;
  object: string;
  sourceNode: GraphNode | undefined;
  targetNode: GraphNode | undefined;
  primaryUnits: readonly string[];
}): boolean {
  const surfaceUnits = new Set(splitPriorUnits(normalizePriorKey(`${input.subject} ${input.predicate} ${input.object}`)).filter(unit => unit.length >= 3));
  const featureUnits = new Set<string>();
  for (const node of [input.sourceNode, input.targetNode]) {
    for (const feature of node?.features ?? []) {
      if (feature.startsWith("sym:")) featureUnits.add(feature.slice(4));
    }
  }
  return input.primaryUnits.some(unit => surfaceUnits.has(unit) || featureUnits.has(unit));
}


 function uniqueLearnedFacts(facts: readonly LearnedGraphPriorFact[]): LearnedGraphPriorFact[] {
  const byKey = new Map<string, LearnedGraphPriorFact>();
  for (const fact of facts) {
    const key = normalizePriorKey(`${fact.subject}:${fact.predicate}:${fact.object}:${fact.questionEdgeFit.requestedSlotId}:${fact.questionEdgeFit.relationRoleId}`);
    const existing = byKey.get(key);
    if (!existing || fact.score > existing.score) byKey.set(key, fact);
  }
  return [...byKey.values()];
}


 function cognitiveFabricFromFacts(facts: readonly LearnedGraphPriorFact[], requestText: string): QuestionCognitiveFabric {
  return buildQuestionCognitiveFabric(facts.map(fact => ({ cognitiveEdge: fact.cognitiveEdge, fit: fact.questionEdgeFit })), requestText);
}


 function factQuestionFitAllowsSurface(fact: LearnedGraphPriorFact): boolean {
  return fact.questionEdgeFit.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport ||
    fact.questionEdgeFit.decision === QUESTION_EDGE_DECISION_IDS.partialSupport ||
    fact.questionEdgeFit.finalQuestionFit >= 0.44;
}


export function cognitiveTopicForRequest(text: string): string {
  const named = namedSubjectAnchors(text);
  if (named.length) return named[0] ?? "";
  const focuses = relevanceRequestFocuses(text).filter(unit => !genericQuestionSignal(unit)).slice(0, 6);
  for (let length = Math.min(3, focuses.length); length >= 2; length--) {
    for (let index = 0; index <= focuses.length - length; index++) {
      const phrase = focuses.slice(index, index + length).join(" ");
      if (phrase.length >= 6) return phrase;
    }
  }
  return focuses[0] ?? "";
}


 function insufficientSupportConstructState(input: {
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
  selectedEvidence: readonly EvidenceSpan[];
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
}): InsufficientSupportConstructState | undefined {
  if (input.selectedEvidence.length > 0) return undefined;
  const marker = jsonRecord(input.brainMarker);
  const activeBrainVersion = kernelString(marker.activeBrainVersion);
  if (!activeBrainVersion) return undefined;
  const ranked = rankedLearnedGraphPriorFacts(input);
  const cognitiveFabric = cognitiveFabricFromFacts(ranked, input.requestText);
  const alphaPlan = createAlphaRhetoricalPlan({ ranked, requestText: input.requestText, field: input.field, hasher: input.hasher });
  const slotSelection = questionSlotSelectionForPriorFacts({
    ranked,
    requestText: input.requestText,
    selectedSubject: alphaPlan?.selectedSubject || cognitiveTopicForRequest(input.requestText),
    alphaPlan
  });
  const gate = relevanceGateFor({
    requestText: input.requestText,
    ranked,
    cognitiveFabric,
    questionSlotPlan: slotSelection?.plan,
    alphaPlan,
    field: input.field,
    brainMarker: marker,
    selectedEvidence: input.selectedEvidence,
    hasher: input.hasher
  });
  const confidentSubjects = gate.candidateSubjectMatches.filter(row => row.affinity >= 0.18).map(row => row.label).slice(0, 6);
  const requestedFocuses = relevanceRequestFocuses(input.requestText);
  const contract = explanatoryAnswerContractFor({
    requestText: input.requestText,
    gate,
    alphaPlan,
    facts: [],
    cognitiveFabric,
    questionSlotPlan: slotSelection?.plan,
    hasher: input.hasher
  });
  return {
    schema: "scce.insufficient_support_construct.v1",
    questionShapeId: contract.questionShapeId,
    selectedMainSubject: confidentSubjects[0] ?? requestedFocuses[0] ?? "",
    requestedFocuses,
    closestSubjectCandidates: confidentSubjects,
    relevanceGate: gate,
    explanatoryAnswerContract: contract,
    activeBrainVersion,
    activeImportRunIds: kernelStringArray(marker.activeImportRunIds),
    certificationBoundary: {
      directEvidenceCount: input.selectedEvidence.length,
      externalFactCertification: false
    }
  };
}


 function graphNodeAnswerConstructState(input: {
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
  selectedEvidence: readonly EvidenceSpan[];
  brainMarker: JsonValue;
  hasher: { digestHex(input: string | Uint8Array): string };
}): GraphNodeAnswerConstructState | undefined {
  if (input.selectedEvidence.length > 0) return undefined;
  const marker = jsonRecord(input.brainMarker);
  const activeBrainVersion = kernelString(marker.activeBrainVersion);
  if (!activeBrainVersion) return undefined;
  const rows = rankedGraphNodeAnswerRows(input);
  if (!rows.length) return undefined;
  const requestedFocuses = relevanceRequestFocuses(input.requestText);
  const selected = rows.slice(0, Math.min(10, rows.length));
  const answerSurface = selected.map(row => row.surface).join("\n").trim();
  if (!answerSurface) return undefined;
  return {
    schema: "scce.graph_node_answer_construct.v1",
    questionShapeId: `question.shape.node:${input.hasher.digestHex(JSON.stringify({ requestedFocuses, nodes: selected.map(row => row.nodeId) })).slice(0, 16)}`,
    selectedSubject: selected[0]?.surface ?? requestedFocuses[0] ?? "",
    requestedFocuses,
    answerSurface,
    selectedNodes: selected,
    forceId: "output.force.learned_graph_node_answer",
    boundaryId: "output.force.import_bound",
    activeBrainVersion,
    activeImportRunIds: kernelStringArray(marker.activeImportRunIds),
    certificationBoundary: {
      directEvidenceCount: input.selectedEvidence.length,
      evidenceSpanIds: [],
      sourceVersionIds: [],
      externalFactCertification: false
    }
  };
}


 function rankedGraphNodeAnswerRows(input: {
  requestText: string;
  graph: { nodes: readonly GraphNode[]; edges: readonly GraphEdge[] };
  field: TurnResult["field"];
}): GraphNodeAnswerRow[] {
  const requestFeatures = new Set(featureSet(input.requestText, 512));
  const requestFeatureList = [...requestFeatures];
  const requestAnchors = priorRequestAnchors(input.requestText);
  const unitSpecificity = requestUnitSpecificity(input.graph.nodes, requestFeatures);
  const primaryUnits = primarySpecificRequestUnits(unitSpecificity);
  const focusUnits = new Set(relevanceRequestFocuses(input.requestText).flatMap(focus => splitPriorUnits(normalizePriorKey(focus))).filter(unit => unit.length >= 3));
  const activationByNodeId = new Map(input.field.active.map(row => [String(row.nodeId), row.activation]));
  const ppfMassByNodeId = new Map(input.field.ppf.map(row => [String(row.nodeId), row.mass]));
  const rows: GraphNodeAnswerRow[] = [];
  for (const node of input.graph.nodes) {
    const forceClass = graphNodePriorClass(node);
    if (!isLearnedPriorClass(forceClass)) continue;
    const raw = cleanPriorTerm(graphNodeSurface(node));
    const surface = compactGraphNodeSurface(raw.text);
    if (!surface || priorSurfaceLooksStructuralDebris(surface)) continue;
    const normalized = normalizePriorKey(surface);
    const surfaceUnits = splitPriorUnits(normalized).filter(unit => unit.length >= 3);
    if (!surfaceUnits.length) continue;
    if (primaryUnits.length && !graphNodeMatchesPrimaryUnit(node, surfaceUnits, primaryUnits)) continue;
    const featureOverlap = nodeSpecificFeatureOverlap(node.features, unitSpecificity);
    const surfaceOverlap = weightedJaccard(requestFeatureList, featureSet(surface, 256));
    const surfaceSpecificity = surfaceSpecificityOverlap(surfaceUnits, unitSpecificity);
    const anchorScore = graphNodeAnchorScore(normalized, surfaceUnits, requestAnchors, focusUnits, unitSpecificity);
    const activation = activationByNodeId.get(String(node.id)) ?? 0;
    const ppfMass = ppfMassByNodeId.get(String(node.id)) ?? 0;
    const topologySupport = Math.max(activation, ppfMass);
    if (featureOverlap <= 0 && surfaceSpecificity <= 0 && surfaceOverlap <= 0 && anchorScore <= 0 && topologySupport <= 0.000001) continue;
    const alpha = kernelClamp01(node.alpha);
    const score = kernelClamp01(
      featureOverlap * 0.42 +
      Math.min(1, anchorScore / 8) * 0.2 +
      surfaceSpecificity * 0.16 +
      surfaceOverlap * 0.08 +
      activation * 0.1 +
      ppfMass * 0.08 +
      alpha * 0.06
    );
    if (score < 0.018 && anchorScore <= 0) continue;
    rows.push({
      nodeId: String(node.id),
      surface,
      score,
      alpha,
      activation,
      ppfMass,
      featureOverlap,
      surfaceOverlap,
      forceClass
    });
  }
  return uniqueGraphNodeAnswerRows(rows)
    .sort((left, right) =>
      right.score - left.score ||
      right.featureOverlap - left.featureOverlap ||
      right.surfaceOverlap - left.surfaceOverlap ||
      left.surface.localeCompare(right.surface)
    );
}


 function requestUnitSpecificity(nodes: readonly GraphNode[], requestFeatures: ReadonlySet<string>): Map<string, number> {
  const requestUnits = [...requestFeatures]
    .filter(feature => feature.startsWith("sym:"))
    .map(feature => feature.slice(4))
    .filter(unit => unit.length >= 3)
    .filter(unit => !genericQuestionSignal(unit))
    .filter(Boolean);
  const counts = new Map(requestUnits.map(unit => [unit, 0]));
  for (const node of nodes) {
    const seen = new Set<string>();
    for (const feature of node.features) {
      if (!feature.startsWith("sym:")) continue;
      const unit = feature.slice(4);
      if (counts.has(unit)) seen.add(unit);
    }
    for (const unit of seen) counts.set(unit, (counts.get(unit) ?? 0) + 1);
  }
  const nodeCount = Math.max(1, nodes.length);
  const specificity = new Map<string, number>();
  for (const unit of requestUnits) {
    const count = counts.get(unit) ?? 0;
    if (count <= 0) continue;
    const rarity = Math.log((nodeCount + 1) / (count + 1)) / Math.log(nodeCount + 1);
    const lengthMass = Math.min(1, [...unit].length / 12);
    specificity.set(unit, kernelClamp01(0.12 + rarity * 0.58 + lengthMass * 0.3));
  }
  return specificity;
}


 function primarySpecificRequestUnits(specificity: ReadonlyMap<string, number>): string[] {
  const ranked = [...specificity.entries()]
    .sort((left, right) => right[1] - left[1] || right[0].length - left[0].length);
  const top = ranked[0]?.[1] ?? 0;
  if (top <= 0) return [];
  return ranked
    .filter(([, score]) => score >= top * 0.92)
    .slice(0, 2)
    .map(([unit]) => unit);
}


 function graphNodeMatchesPrimaryUnit(node: GraphNode, surfaceUnits: readonly string[], primaryUnits: readonly string[]): boolean {
  const featureUnits = new Set(node.features.filter(feature => feature.startsWith("sym:")).map(feature => feature.slice(4)));
  return primaryUnits.some(unit => featureUnits.has(unit) || surfaceUnits.includes(unit));
}


 function nodeSpecificFeatureOverlap(features: readonly string[], specificity: ReadonlyMap<string, number>): number {
  if (!features.length || !specificity.size) return 0;
  const total = [...specificity.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  let matched = 0;
  const seen = new Set<string>();
  for (const feature of features) {
    if (!feature.startsWith("sym:")) continue;
    const unit = feature.slice(4);
    if (seen.has(unit)) continue;
    seen.add(unit);
    matched += specificity.get(unit) ?? 0;
  }
  return kernelClamp01(matched / total);
}


 function surfaceSpecificityOverlap(units: readonly string[], specificity: ReadonlyMap<string, number>): number {
  if (!units.length || !specificity.size) return 0;
  const total = [...specificity.values()].reduce((sum, value) => sum + value, 0);
  if (total <= 0) return 0;
  const matched = uniqueKernelStrings(units).reduce((sum, unit) => sum + (specificity.get(unit) ?? 0), 0);
  return kernelClamp01(matched / total);
}


 function graphNodeAnchorScore(normalized: string, units: readonly string[], anchors: ReadonlySet<string>, focusUnits: ReadonlySet<string>, specificity: ReadonlyMap<string, number>): number {
  let score = 0;
  for (const anchor of anchors) {
    const anchorMass = anchorSpecificity(anchor, specificity);
    if (normalized === anchor) score += 8 * anchorMass;
    else if (anchor.length >= 4 && normalized.includes(anchor)) score += (anchor.includes(" ") ? 5 : 2) * anchorMass;
  }
  for (const unit of units) {
    const unitMass = specificity.get(unit) ?? 0;
    if (anchors.has(unit)) score += 2 * unitMass;
    if (focusUnits.has(unit)) score += unitMass;
  }
  return score;
}


 function anchorSpecificity(anchor: string, specificity: ReadonlyMap<string, number>): number {
  const units = splitPriorUnits(anchor).filter(Boolean);
  if (!units.length) return 0.1;
  const matched = units.map(unit => specificity.get(unit) ?? 0).filter(value => value > 0);
  if (!matched.length) return 0.1;
  return mean(matched);
}


 function uniqueGraphNodeAnswerRows(rows: readonly GraphNodeAnswerRow[]): GraphNodeAnswerRow[] {
  const bySurface = new Map<string, GraphNodeAnswerRow>();
  for (const row of rows) {
    const key = normalizePriorKey(row.surface);
    const existing = bySurface.get(key);
    if (!existing || row.score > existing.score) bySurface.set(key, row);
  }
  return [...bySurface.values()];
}


 function compactGraphNodeSurface(value: string): string {
  const clean = collapsePriorWhitespace(stripOuterPriorSeparators(sourceTextSurface(value, 600)));
  if ([...clean].length <= 180) return clean;
  return [...clean].slice(0, 177).join("").trimEnd() + "...";
}


 function relevanceGateFor(input: {
  requestText: string;
  ranked: readonly LearnedGraphPriorFact[];
  cognitiveFabric: QuestionCognitiveFabric;
  questionSlotPlan?: QuestionSlotPlan;
  alphaPlan: AlphaRhetoricalPlan | undefined;
  field: TurnResult["field"];
  brainMarker: Record<string, JsonValue>;
  selectedEvidence: readonly EvidenceSpan[];
  hasher: { digestHex(input: string | Uint8Array): string };
}): RelevanceGate {
  const signals = relevanceRequestFocuses(input.requestText);
  const candidateSubjectMatches = relevanceSubjectMatches(input.ranked, signals).slice(0, 8);
  const selectedKeys = new Set(input.alphaPlan?.selectedFactKeys ?? []);
  const selectedFacts = input.ranked.filter(fact => selectedKeys.has(semanticFactKey(fact))).slice(0, 12);
  const scoredFacts = selectedFacts.length ? selectedFacts : input.ranked.slice(0, 8);
  const maxSubjectAffinity = candidateSubjectMatches[0]?.affinity ?? 0;
  const maxQuestionOverlap = Math.max(0, ...input.ranked.slice(0, 24).map(fact => fact.overlap));
  const alphaSupportMass = kernelClamp01(mean(scoredFacts.map(fact => fact.activation)));
  const ppfSupportMass = kernelClamp01(mean(scoredFacts.map(fact => fact.ppfMass)));
  const relationSupportMass = kernelClamp01(mean(scoredFacts.map(fact => fact.support)));
  const answerGradeFacts = input.ranked.filter(fact => fact.graphQuality.answerGrade);
  const weakGraphFacts = input.ranked.filter(fact => fact.graphQuality.classId === GRAPH_QUALITY_CLASS_IDS.weakFragment);
  const categoryGraphFacts = input.ranked.filter(fact => fact.graphQuality.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation);
  const noisyGraphFacts = input.ranked.filter(fact => fact.graphQuality.classId === GRAPH_QUALITY_CLASS_IDS.noisyMarkup);
  const answerGradeGraphPriorCount = answerGradeFacts.length;
  const weakGraphPriorCount = weakGraphFacts.length;
  const categoryGraphPriorCount = categoryGraphFacts.length;
  const noisyGraphPriorCount = noisyGraphFacts.length;
  const answerGradeSupportMass = kernelClamp01(mean(answerGradeFacts.slice(0, 12).map(fact => fact.graphQuality.semanticQuality * Math.max(fact.support, fact.activation, fact.ppfMass))));
  const weakGraphSupportMass = kernelClamp01(mean([...weakGraphFacts, ...categoryGraphFacts].slice(0, 12).map(fact => fact.graphQuality.semanticQuality * Math.max(fact.support, fact.activation, fact.ppfMass))));
  const slotPlanCoreCount = input.questionSlotPlan?.selectedAnswerCore.length ?? 0;
  const slotPlanAllowsAnswer = !input.questionSlotPlan || slotPlanCoreCount > 0;
  const requestedCognitiveSupportCount = input.questionSlotPlan ? slotPlanCoreCount : input.cognitiveFabric.selectedFits.length;
  const requestedCognitiveSupportMass = input.questionSlotPlan ? input.questionSlotPlan.supportMass : input.cognitiveFabric.supportMass;
  const missingRequestedSlots = uniqueKernelStrings([
    ...input.cognitiveFabric.missingRequestedSlots,
    ...(input.questionSlotPlan?.missingSlots ?? [])
  ]);
  const selectedTopicSenseId = input.cognitiveFabric.selectedTopicSenseId;
  const selectedPathCoherence = input.alphaPlan?.explanationCompleteness ?? 0;
  const directEvidenceCount = input.selectedEvidence.length;
  const learnedGraphPriorCount = input.ranked.length;
  const learnedLanguagePriorCount = kernelNumber(input.brainMarker.importedLanguagePriorCount);
  const languageOnlySupportMass = learnedGraphPriorCount > 0 ? 0 : kernelClamp01(Math.log1p(learnedLanguagePriorCount) / Math.log(100000));
  const contradictionPressure = kernelClamp01(input.field.alphaTrace.surfaces.contradiction * 0.5 + input.field.alphaTrace.contradictionMass * 0.5);
  const unrelatedPriorPenalty = learnedGraphPriorCount > 0 && maxSubjectAffinity < 0.08 && maxQuestionOverlap < 0.03 ? 0.6 : 0;
  const graphPriorSupport = learnedGraphPriorCount > 0 ? kernelClamp01(Math.log1p(learnedGraphPriorCount) / Math.log(64)) : 0;
  const relevanceScore = kernelClamp01(
    0.16 * maxSubjectAffinity +
    0.12 * maxQuestionOverlap +
    0.1 * alphaSupportMass +
    0.08 * ppfSupportMass +
    0.12 * selectedPathCoherence +
    0.08 * relationSupportMass +
    0.12 * answerGradeSupportMass +
    0.22 * requestedCognitiveSupportMass +
    0.03 * weakGraphSupportMass +
    0.04 * graphPriorSupport +
    0.12 * Math.min(1, directEvidenceCount) -
    0.24 * languageOnlySupportMass -
    0.16 * contradictionPressure -
    0.22 * unrelatedPriorPenalty
  );
  const reasonIds: string[] = [];
  if (directEvidenceCount > 0) reasonIds.push("relevance.reason.direct_evidence_present");
  if (learnedGraphPriorCount > 0) reasonIds.push("relevance.reason.graph_priors_present");
  if (answerGradeGraphPriorCount > 0) reasonIds.push("relevance.reason.answer_grade_graph_priors_present");
  if (requestedCognitiveSupportCount > 0) reasonIds.push("relevance.reason.requested_cognitive_support_present");
  if (missingRequestedSlots.length > 0) reasonIds.push("relevance.reason.requested_slots_missing");
  if (!slotPlanAllowsAnswer) reasonIds.push("relevance.reason.question_slot_answer_core_missing");
  if (weakGraphPriorCount + categoryGraphPriorCount > 0) reasonIds.push("relevance.reason.weak_or_category_graph_priors_present");
  if (languageOnlySupportMass > 0) reasonIds.push("relevance.reason.language_only_support");
  if (unrelatedPriorPenalty > 0) reasonIds.push("relevance.reason.unrelated_prior_penalty");
  if (contradictionPressure > 0.1) reasonIds.push("relevance.reason.contradiction_pressure");
  let decision: RelevanceGateDecision = QUESTION_EDGE_DECISION_IDS.insufficientSupport;
  if (directEvidenceCount > 0 && relevanceScore >= 0.22) decision = QUESTION_EDGE_DECISION_IDS.directEvidence;
  else if (learnedGraphPriorCount <= 0 && learnedLanguagePriorCount > 0) decision = QUESTION_EDGE_DECISION_IDS.languageOnlyRejected;
  else if (!slotPlanAllowsAnswer && learnedGraphPriorCount > 0) decision = QUESTION_EDGE_DECISION_IDS.requestedSlotMissing;
  else if (input.cognitiveFabric.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport && slotPlanAllowsAnswer && relevanceScore >= 0.22 && requestedCognitiveSupportMass >= 0.2) decision = QUESTION_EDGE_DECISION_IDS.requestedSupport;
  else if (input.cognitiveFabric.decision === QUESTION_EDGE_DECISION_IDS.partialSupport && slotPlanAllowsAnswer && relevanceScore >= 0.18 && requestedCognitiveSupportMass >= 0.14) decision = QUESTION_EDGE_DECISION_IDS.partialSupport;
  else if (input.cognitiveFabric.decision === QUESTION_EDGE_DECISION_IDS.requestedSlotMissing) decision = QUESTION_EDGE_DECISION_IDS.requestedSlotMissing;
  else if (input.cognitiveFabric.decision === QUESTION_EDGE_DECISION_IDS.ambiguousSense) decision = QUESTION_EDGE_DECISION_IDS.ambiguousSense;
  else if (learnedGraphPriorCount > 0 && weakGraphSupportMass > 0) decision = QUESTION_EDGE_DECISION_IDS.weakGraphOnly;
  else if (candidateSubjectMatches.length > 1 && Math.abs((candidateSubjectMatches[0]?.affinity ?? 0) - (candidateSubjectMatches[1]?.affinity ?? 0)) < 0.025 && relevanceScore >= 0.18) decision = QUESTION_EDGE_DECISION_IDS.clarificationCosted;
  if (decision === QUESTION_EDGE_DECISION_IDS.insufficientSupport) reasonIds.push("relevance.reason.below_floor");
  if (decision === QUESTION_EDGE_DECISION_IDS.languageOnlyRejected) reasonIds.push("relevance.reason.language_priors_do_not_supply_facts");
  return {
    schema: "scce.relevance_gate.v1",
    queryFingerprint: input.hasher.digestHex(input.requestText).slice(0, 24),
    normalizedQuerySignals: signals,
    candidateSubjectMatches,
    activatedNodeCount: input.field.active.length,
    activatedEdgeCount: input.ranked.filter(fact => fact.activation > 0.00001).length,
    selectedPathCount: input.alphaPlan?.selectedFactKeys.length ?? 0,
    maxSubjectAffinity,
    maxQuestionOverlap,
    alphaSupportMass,
    ppfSupportMass,
    relationSupportMass,
    answerGradeGraphPriorCount,
    weakGraphPriorCount,
    categoryGraphPriorCount,
    noisyGraphPriorCount,
    answerGradeSupportMass,
    weakGraphSupportMass,
    requestedCognitiveSupportCount,
    requestedCognitiveSupportMass,
    missingRequestedSlots,
    selectedTopicSenseId,
    languageOnlySupportMass,
    directEvidenceCount,
    learnedGraphPriorCount,
    learnedLanguagePriorCount,
    relevanceScore,
    decision,
    reasonIds: uniqueKernelStrings(reasonIds)
  };
}


 function explanatoryAnswerContractFor(input: {
  requestText: string;
  gate: RelevanceGate;
  alphaPlan: AlphaRhetoricalPlan | undefined;
  facts: readonly LearnedGraphPriorFact[];
  cognitiveFabric: QuestionCognitiveFabric;
  questionSlotPlan?: QuestionSlotPlan;
  hasher: { digestHex(input: string | Uint8Array): string };
}): ExplanatoryAnswerContract {
  const questionShapeId = semanticQuestionShapeId(input.facts, input.requestText, input.hasher, input.alphaPlan);
  const requestedFocuses = relevanceRequestFocuses(input.requestText);
  const selectedRoles = new Set(input.alphaPlan?.selectedRoleIds ?? []);
  const requiredSlots = uniqueKernelStrings([...(input.questionSlotPlan?.requiredSlots ?? []), ...explanatoryRequiredSlots(input.requestText, requestedFocuses), ...input.cognitiveFabric.requestedSlotIds]);
  const optionalSlots = [
    EXPLANATORY_CONTRACT_SLOT_IDS.important,
    EXPLANATORY_CONTRACT_SLOT_IDS.significance,
    EXPLANATORY_CONTRACT_SLOT_IDS.background,
    EXPLANATORY_CONTRACT_SLOT_IDS.boundary
  ];
  const cognitiveFilled = new Set(input.cognitiveFabric.selectedFits.map(fit => fit.requestedSlotId));
  const slotPlanFilled = new Set([...(input.questionSlotPlan?.filledCoreSlots ?? []), ...(input.questionSlotPlan?.filledSecondarySlots ?? [])]);
  const filledSlots = requiredSlots.filter(slot => slotPlanFilled.has(slot) || explanatorySlotFilled(slot, selectedRoles, input.facts) || cognitiveFilled.has(slot));
  const unsupportedSlots = requiredSlots.filter(slot => !filledSlots.includes(slot));
  const supportRichness = input.gate.relevanceScore + filledSlots.length / Math.max(1, requiredSlots.length);
  const richAnswer = input.gate.decision === QUESTION_EDGE_DECISION_IDS.requestedSupport || input.gate.decision === QUESTION_EDGE_DECISION_IDS.partialSupport;
  const target = richAnswer
    ? Math.max(2, Math.min(10, Math.round(2 + supportRichness * 4 + (input.questionSlotPlan?.selectedAnswerCore.length ?? 0) * 0.6 + unsupportedSlots.length * 0.25)))
    : 1;
  return {
    schema: "scce.explanatory_answer_contract.v1",
    questionShapeId,
    mainSubjectCandidates: input.gate.candidateSubjectMatches.map(row => row.label),
    selectedMainSubject: input.alphaPlan?.selectedSubject || input.gate.candidateSubjectMatches[0]?.label || requestedFocuses[0] || "",
    requestedFocuses,
    requiredSlots,
    optionalSlots,
    filledSlots,
    unsupportedSlots,
    relevanceGate: input.gate,
    alphaAnswerPlan: input.alphaPlan,
    rhetoricalPlan: toJsonValue({
      selectedRoleIds: input.alphaPlan?.selectedRoleIds ?? [],
      backgroundRoleIds: input.alphaPlan?.backgroundRoleIds ?? [],
      planEnergy: input.alphaPlan?.planEnergy ?? 1,
      explanationCompleteness: input.alphaPlan?.explanationCompleteness ?? 0,
      cognitiveFabric: input.cognitiveFabric
    }),
    certificationBoundary: toJsonValue({
      directEvidenceCount: input.gate.directEvidenceCount,
      externalFactCertification: input.gate.decision === QUESTION_EDGE_DECISION_IDS.directEvidence
    }),
    targetSurfaceExtent: {
      floor: richAnswer ? Math.min(3, Math.max(2, input.questionSlotPlan?.selectedAnswerCore.length ?? 2)) : 1,
      target,
      ceiling: richAnswer ? 10 : 2
    },
    questionSlotPlan: input.questionSlotPlan
  };
}


 function createAlphaRhetoricalPlan(input: {
  ranked: readonly LearnedGraphPriorFact[];
  requestText: string;
  field: TurnResult["field"];
  hasher: { digestHex(input: string | Uint8Array): string };
}): AlphaRhetoricalPlan | undefined {
  if (!input.ranked.length) return undefined;
  const anchors = priorRequestAnchors(input.requestText);
  const subject = alphaRhetoricalSubject(input.ranked, anchors, input.requestText);
  if (!subject) return undefined;
  const subjectFacts = input.ranked.filter(fact => samePriorEntity(fact.subject, subject));
  const bridgeAnchors = specificPriorBridgeAnchors(subjectFacts);
  const contradictionPressure = kernelClamp01(input.field.alphaTrace.surfaces.contradiction * 0.58 + input.field.alphaTrace.contradictionMass * 0.42);
  const assignments = input.ranked.slice(0, 96)
    .map(fact => alphaRhetoricalAssignment({ fact, subject, anchors, bridgeAnchors, contradictionPressure, hasher: input.hasher }))
    .filter(assignment => assignment.arc > 0.0001)
    .sort((left, right) => right.arc - left.arc || right.pathScore - left.pathScore || left.factKey.localeCompare(right.factKey));
  if (!assignments.length) return undefined;
  const selected = selectAlphaRhetoricalAssignments(assignments);
  if (!selected.length) return undefined;
  const selectedKeys = new Set(selected.map(assignment => assignment.factKey));
  const allAssignments = assignments.map(assignment => ({
    ...assignment,
    selected: selectedKeys.has(assignment.factKey),
    shouldSurface: selectedKeys.has(assignment.factKey) && assignment.shouldSurface
  }));
  const selectedRoleIds = uniqueKernelStrings(selected.map(assignment => assignment.roleId));
  const requiredRoleIds = [...ANSWER_ROLE_GROUPS.required];
  const optionalRoleIds = [...ANSWER_ROLE_GROUPS.optional];
  const missingRequired = requiredRoleIds.filter(roleId => !selectedRoleIds.includes(roleId)).length;
  const surfaced = selected.filter(assignment => assignment.shouldSurface);
  const supportMass = mean(selected.map(assignment => assignment.arc));
  const bridgeCoverage = selectedRoleIds.some(isBridgeAnswerRoleId) ? 1 : 0;
  const backgroundDominance = selected.filter(assignment => isBackgroundAnswerRoleId(assignment.roleId)).reduce((sum, assignment) => sum + (assignment.shouldSurface ? assignment.arc : assignment.arc * 0.15), 0);
  const fragmentation = kernelClamp01(Math.max(0, selected.length - uniqueKernelStrings(selected.map(assignment => assignment.roleId)).length) / Math.max(1, selected.length));
  const explanationCompleteness = kernelClamp01(0.36 * (1 - missingRequired / requiredRoleIds.length) + 0.22 * bridgeCoverage + 0.22 * supportMass + 0.2 * Math.min(1, surfaced.length / 4));
  const targetSentenceCount = alphaRhetoricalTargetSentenceCount({ selected, bridgeCoverage, supportMass, missingRequired });
  const planEnergy = kernelClamp01(
    missingRequired * 0.18 +
    backgroundDominance * 0.22 +
    fragmentation * 0.14 +
    contradictionPressure * 0.18 +
    Math.abs(targetSentenceCount - Math.max(2, surfaced.length)) * 0.03 -
    explanationCompleteness * 0.28
  );
  return {
    schema: "scce.alpha_rhetorical_plan.v1",
    plannerId: "walsh.alpha_rhetorical_centrality",
    selectedSubject: subject,
    selectedSubjectNodeIds: uniqueKernelStrings(input.ranked.filter(fact => samePriorEntity(fact.subject, subject)).map(fact => fact.sourceNodeId)),
    requiredRoleIds,
    optionalRoleIds,
    selectedRoleIds,
    backgroundRoleIds: [...ANSWER_ROLE_GROUPS.background],
    assignments: allAssignments.slice(0, 64),
    selectedFactKeys: selected.map(assignment => assignment.factKey),
    backgroundFactKeys: selected.filter(assignment => isBackgroundAnswerRoleId(assignment.roleId)).map(assignment => assignment.factKey),
    planEnergy,
    explanationCompleteness,
    targetSentenceCount,
    proofBoundaryId: "output.force.import_bound",
    audit: toJsonValue({
      inputFactCount: input.ranked.length,
      assignmentCount: allAssignments.length,
      contradictionPressure,
      supportMass,
      bridgeCoverage,
      backgroundDominance,
      fragmentation,
      missingRequired,
      selectedRoleIds
    })
  };
}


 function alphaRhetoricalSubject(facts: readonly LearnedGraphPriorFact[], anchors: ReadonlySet<string>, requestText: string): string {
  for (const anchor of namedSubjectAnchors(requestText)) {
    const best = subjectAnchorCandidates(facts, anchors, anchor)[0];
    if (best) return best.label;
  }
  const phraseAnchors = [...anchors]
    .filter(anchor => anchor.includes(" "))
    .sort((left, right) => splitPriorUnits(right).length - splitPriorUnits(left).length || right.length - left.length);
  for (const anchor of phraseAnchors) {
    const best = subjectAnchorCandidates(facts, anchors, anchor)[0];
    if (best) return best.label;
  }
  const scores = new Map<string, { label: string; score: number; nodeIds: Set<string> }>();
  for (const fact of facts) {
    const key = normalizePriorKey(fact.subject);
    const anchorMass = factRequestAnchorScore(fact, anchors);
    const score = fact.score * 0.28 + fact.activation * 0.22 + fact.ppfMass * 0.22 + fact.support * 0.16 + anchorMass * 0.12;
    const previous = scores.get(key) ?? { label: fact.subject, score: 0, nodeIds: new Set<string>() };
    previous.score += score;
    previous.nodeIds.add(fact.sourceNodeId);
    scores.set(key, previous);
  }
  const best = [...scores.values()]
    .filter(row => !anchors.size || splitPriorUnits(normalizePriorKey(row.label)).some(unit => anchors.has(unit)))
    .sort((left, right) => right.score - left.score || right.nodeIds.size - left.nodeIds.size || left.label.localeCompare(right.label))[0];
  return best?.label ?? "";
}


 function semanticAnswerSubjectAllowed(requestText: string, selectedSubject: string, gate: RelevanceGate): boolean {
  const selected = normalizePriorKey(selectedSubject);
  if (!selected) return false;
  for (const anchor of namedSubjectAnchors(requestText)) {
    if (selected === anchor || selected.startsWith(`${anchor} `) || anchor.startsWith(`${selected} `)) return true;
  }
  const selectedUnits = splitPriorUnits(selected);
  const contentUnits = requestContentPriorUnits(requestText).filter(unit => unit.length >= 5 && !genericQuestionSignal(unit));
  if (contentUnits.some(unit => selectedUnits.includes(unit))) return true;
  return gate.candidateSubjectMatches.some(row => normalizePriorKey(row.label) === selected && row.affinity >= 0.3);
}


 function subjectAnchorCandidates(facts: readonly LearnedGraphPriorFact[], anchors: ReadonlySet<string>, anchor: string): Array<{ label: string; exact: number; mass: number; score: number }> {
  return facts
    .filter(fact => priorSubjectMatchesAnchorPhrase(fact.subject, anchor))
    .map(fact => ({
      label: fact.subject,
      exact: normalizePriorKey(fact.subject) === anchor ? 1 : 0,
      mass: semanticPriorSurfaceMass(fact.subject),
      score: fact.score + fact.activation + fact.ppfMass + fact.support + factRequestAnchorScore(fact, anchors)
    }))
    .sort((left, right) => right.exact - left.exact || left.mass - right.mass || right.score - left.score || left.label.localeCompare(right.label));
}


 function priorSubjectMatchesAnchorPhrase(subject: string, phrase: string): boolean {
  const key = normalizePriorKey(subject);
  return key === phrase || key.startsWith(`${phrase} `);
}


 function alphaRhetoricalAssignment(input: {
  fact: LearnedGraphPriorFact;
  subject: string;
  anchors: ReadonlySet<string>;
  bridgeAnchors: ReadonlySet<string>;
  contradictionPressure: number;
  hasher: { digestHex(input: string | Uint8Array): string };
}): AlphaRhetoricalAssignment {
  const roleId = alphaRhetoricalRoleId(input.fact, input.subject, input.anchors, input.bridgeAnchors);
  const subjectCentrality = samePriorEntity(input.fact.subject, input.subject) || samePriorEntity(input.fact.object, input.subject) ? 1 : factSharesSpecificPriorAnchor(input.fact, input.bridgeAnchors) ? 0.58 : 0.22;
  const requestFit = kernelClamp01(factRequestAnchorScore(input.fact, input.anchors) / Math.max(1, input.anchors.size + 1));
  const questionFit = input.fact.questionEdgeFit.finalQuestionFit;
  const pathActivation = kernelClamp01(0.38 * input.fact.activation + 0.34 * input.fact.ppfMass + 0.28 * Math.max(input.fact.sourceActivation, input.fact.targetActivation));
  const relationSupport = kernelClamp01(input.fact.support);
  const bridgeValue = alphaRhetoricalBridgeValue(input.fact, input.subject, input.bridgeAnchors, input.anchors, roleId);
  const semanticQuality = input.fact.graphQuality.semanticQuality;
  const backgroundPenalty = isBackgroundAnswerRoleId(roleId)
    ? kernelClamp01(0.66 - questionFit * 0.28 + subjectCentrality * 0.08)
    : 0;
  const forceMeaning = input.fact.forceClass === "learned_concept_prior" ? 0.92 : 0.5;
  const certificationPower = input.fact.forceClass === "direct_evidence" && Boolean(input.fact.sourceVersionId) ? 1 : 0;
  const distanceFromSubject = samePriorEntity(input.fact.subject, input.subject) || samePriorEntity(input.fact.object, input.subject) ? 0 : factSharesSpecificPriorAnchor(input.fact, input.bridgeAnchors) ? 0.42 : 0.76;
  const pathScore = kernelClamp01(
    0.26 * Math.log1p(pathActivation * 8) / Math.log(9) +
    0.22 * relationSupport +
    0.1 * requestFit +
    0.18 * questionFit +
    0.18 * bridgeValue +
    0.12 * forceMeaning +
    0.22 * semanticQuality -
    0.1 * distanceFromSubject -
    0.12 * input.contradictionPressure
  );
  const roleScore = sigmoidKernel(
    1.7 * subjectCentrality +
    0.72 * requestFit +
    1.45 * questionFit +
    1.4 * pathActivation +
    1.05 * relationSupport +
    1.25 * bridgeValue -
    1.2 * (1 - semanticQuality) -
    1.15 * distanceFromSubject -
    1.55 * backgroundPenalty -
    1.3 * input.contradictionPressure
  );
  const answerGradeMass = factQuestionFitAllowsSurface(input.fact) ? 1 : 0.18;
  const arc = kernelClamp01(pathScore * roleScore * forceMeaning * semanticQuality * answerGradeMass * bridgeValueOrOne(bridgeValue, roleId) * (1 - backgroundPenalty * 0.72) * (1 - input.contradictionPressure));
  const shouldSurface = factQuestionFitAllowsSurface(input.fact) && !isBackgroundAnswerRoleId(roleId) && roleId !== ANSWER_ROLE_IDS.boundary;
  return {
    id: `alpha.rhetorical.assignment:${input.hasher.digestHex(`${semanticFactKey(input.fact)}:${roleId}`).slice(0, 18)}`,
    factKey: semanticFactKey(input.fact),
    relationId: input.fact.relationId,
    sourceNodeId: input.fact.sourceNodeId,
    targetNodeId: input.fact.targetNodeId,
    roleId,
    arc,
    pathScore,
    roleScore,
    pathActivation,
    relationSupport,
    bridgeValue,
    backgroundPenalty,
    contradictionPressure: input.contradictionPressure,
    forceMeaning,
    certificationPower,
    semanticQuality,
    graphQualityClassId: input.fact.graphQuality.classId,
    answerGrade: factQuestionFitAllowsSurface(input.fact),
    selected: false,
    shouldSurface
  };
}


 function alphaRhetoricalRoleId(fact: LearnedGraphPriorFact, subject: string, anchors: ReadonlySet<string>, bridgeAnchors: ReadonlySet<string>): string {
  const subjectMatch = samePriorEntity(fact.subject, subject);
  const objectMatch = samePriorEntity(fact.object, subject);
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphNavigation) return ANSWER_ROLE_IDS.backgroundRelation;
  if (lowValueCatalogFact(fact)) return ANSWER_ROLE_IDS.backgroundRelation;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership) return subjectMatch || objectMatch ? ANSWER_ROLE_IDS.context : ANSWER_ROLE_IDS.backgroundActor;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphRequestRelation) return ANSWER_ROLE_IDS.contribution;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphExplanatoryPath) return ANSWER_ROLE_IDS.contribution;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompactAttribute) return subjectMatch ? ANSWER_ROLE_IDS.identity : ANSWER_ROLE_IDS.field;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompoundMembership || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompoundAttribute) return subjectMatch || objectMatch ? ANSWER_ROLE_IDS.context : ANSWER_ROLE_IDS.backgroundActor;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphContextRelation) return subjectMatch ? ANSWER_ROLE_IDS.context : ANSWER_ROLE_IDS.backgroundRelation;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.metadata) return ANSWER_ROLE_IDS.backgroundRelation;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.contribution || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.knownFor || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.characterCast) return ANSWER_ROLE_IDS.contribution;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.effect) return ANSWER_ROLE_IDS.significance;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.domain) return ANSWER_ROLE_IDS.field;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.roleClass || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.definitionClass) return ANSWER_ROLE_IDS.identity;
  if (subjectMatch) return ANSWER_ROLE_IDS.contribution;
  if (objectMatch) return ANSWER_ROLE_IDS.contribution;
  if (factSharesSpecificPriorAnchor({ ...fact, object: fact.subject }, bridgeAnchors)) {
    return factRequestAnchorScore(fact, anchors) > 0 ? ANSWER_ROLE_IDS.significance : ANSWER_ROLE_IDS.context;
  }
  if (factSharesSpecificPriorAnchor(fact, bridgeAnchors)) return ANSWER_ROLE_IDS.backgroundActor;
  return factRequestAnchorScore(fact, anchors) > 0 ? ANSWER_ROLE_IDS.field : ANSWER_ROLE_IDS.backgroundRelation;
}


 function alphaRhetoricalBridgeValue(fact: LearnedGraphPriorFact, subject: string, bridgeAnchors: ReadonlySet<string>, anchors: ReadonlySet<string>, roleId: string): number {
  const direct = samePriorEntity(fact.subject, subject) || samePriorEntity(fact.object, subject) ? 0.88 : 0;
  const bridge = factSpecificBridgeScore(fact, bridgeAnchors) ? 0.78 : 0;
  const request = factRequestAnchorScore(fact, anchors) > 0 ? 0.64 : 0;
  const role = roleId === ANSWER_ROLE_IDS.significance ? 0.92 : roleId === ANSWER_ROLE_IDS.context || roleId === ANSWER_ROLE_IDS.field ? 0.78 : roleId === ANSWER_ROLE_IDS.contribution ? 0.86 : 0.48;
  return kernelClamp01(Math.max(direct, bridge, request, role));
}


 function bridgeValueOrOne(bridgeValue: number, roleId: string): number {
  return isBackgroundAnswerRoleId(roleId) ? kernelClamp01(0.72 + bridgeValue * 0.18) : kernelClamp01(0.82 + bridgeValue * 0.18);
}


 function selectAlphaRhetoricalAssignments(assignments: readonly AlphaRhetoricalAssignment[]): AlphaRhetoricalAssignment[] {
  const selected: AlphaRhetoricalAssignment[] = [];
  const selectedKeys = new Set<string>();
  const addBest = (roleId: string) => {
    const row = assignments.filter(item => item.roleId === roleId && !selectedKeys.has(item.factKey)).sort((left, right) => right.arc - left.arc || right.pathScore - left.pathScore)[0];
    if (!row) return;
    selected.push(row);
    selectedKeys.add(row.factKey);
  };
  for (const roleId of ANSWER_ROLE_GROUPS.selectionOrder) addBest(roleId);
  const background = assignments
    .filter(item => isBackgroundAnswerRoleId(item.roleId) && !selectedKeys.has(item.factKey))
    .sort((left, right) => right.arc - left.arc || right.bridgeValue - left.bridgeValue)[0];
  if (background && selected.length >= 2) {
    selected.push(background);
    selectedKeys.add(background.factKey);
  }
  if (!selected.length) {
    const best = assignments[0];
    if (best) selected.push(best);
  }
  return selected.sort((left, right) => alphaRhetoricalRoleOrder(left.roleId) - alphaRhetoricalRoleOrder(right.roleId) || right.arc - left.arc);
}


 function alphaRhetoricalRoleOrder(roleId: string): number {
  if (roleId === ANSWER_ROLE_IDS.identity) return 0;
  if (roleId === ANSWER_ROLE_IDS.contribution) return 1;
  if (roleId === ANSWER_ROLE_IDS.significance) return 2;
  if (roleId === ANSWER_ROLE_IDS.context) return 3;
  if (roleId === ANSWER_ROLE_IDS.field) return 4;
  if (roleId === ANSWER_ROLE_IDS.backgroundActor) return 5;
  if (roleId === ANSWER_ROLE_IDS.backgroundRelation) return 6;
  return 8;
}


 function alphaRhetoricalTargetSentenceCount(input: { selected: readonly AlphaRhetoricalAssignment[]; bridgeCoverage: number; supportMass: number; missingRequired: number }): number {
  const supported = uniqueKernelStrings(input.selected.map(assignment => assignment.roleId)).length;
  const raw = 2 + supported * 0.7 + input.bridgeCoverage * 1.2 + input.supportMass * 1.6 - input.missingRequired * 0.75;
  return Math.max(2, Math.min(8, Math.round(raw)));
}


export function relevanceRequestFocuses(text: string): string[] {
  const named = namedSubjectAnchors(text);
  const units = requestContentPriorUnits(text)
    .map(stripOuterPriorSeparators)
    .filter(unit => unit.length >= 4)
    .filter(unit => !genericQuestionSignal(unit));
  return uniqueKernelStrings([...named, ...units]).slice(0, 16);
}


 function relevanceSubjectMatches(facts: readonly LearnedGraphPriorFact[], signals: readonly string[]): Array<{ label: string; affinity: number; nodeIds: string[] }> {
  const rows = new Map<string, { label: string; affinity: number; nodeIds: Set<string> }>();
  for (const fact of facts.slice(0, 128)) {
    const key = normalizePriorKey(fact.subject);
    const affinity = kernelClamp01(
      0.42 * fuzzySignalAffinity(fact.subject, signals) +
      0.18 * fuzzySignalAffinity(fact.object, signals) +
      0.18 * fact.overlap +
      0.12 * fact.activation +
      0.1 * fact.ppfMass
    );
    if (affinity <= 0.001) continue;
    const previous = rows.get(key) ?? { label: fact.subject, affinity: 0, nodeIds: new Set<string>() };
    previous.affinity = Math.max(previous.affinity, affinity);
    previous.nodeIds.add(fact.sourceNodeId);
    rows.set(key, previous);
  }
  return [...rows.values()]
    .map(row => ({ label: row.label, affinity: row.affinity, nodeIds: [...row.nodeIds].slice(0, 8) }))
    .sort((left, right) => right.affinity - left.affinity || left.label.localeCompare(right.label));
}


 function fuzzySignalAffinity(label: string, signals: readonly string[]): number {
  const units = splitPriorUnits(normalizePriorKey(label)).filter(Boolean);
  if (!units.length || !signals.length) return 0;
  let score = 0;
  for (const signal of signals) {
    let best = 0;
    for (const unit of units) best = Math.max(best, fuzzyUnitSimilarity(signal, unit));
    score += best;
  }
  return kernelClamp01(score / Math.max(1, Math.min(signals.length, units.length + 1)));
}


 function fuzzyUnitSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) return 0.82;
  const distance = boundedEditDistance(left, right, 3);
  const scale = Math.max(left.length, right.length);
  if (distance > 3 || scale <= 0) return 0;
  return kernelClamp01(1 - distance / scale);
}


 function explanatoryRequiredSlots(text: string, focuses: readonly string[]): string[] {
  void text;
  const slots: string[] = [GRAPH_SLOT_IDS.topicAnchor, GRAPH_SLOT_IDS.compactAttribute, GRAPH_SLOT_IDS.explanatoryPath];
  if (focuses.length > 1) slots.push(GRAPH_SLOT_IDS.requestAlignedRelation, GRAPH_SLOT_IDS.contextBridge);
  return uniqueKernelStrings(slots);
}


 function explanatorySlotFilled(slot: string, selectedRoles: ReadonlySet<string>, facts: readonly LearnedGraphPriorFact[]): boolean {
  if (slot === GRAPH_SLOT_IDS.topicAnchor) return facts.length > 0 || selectedRoles.size > 0;
  if (slot === GRAPH_SLOT_IDS.requestAlignedRelation) return facts.some(fact => fact.questionEdgeFit.requestedSlotId === slot || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphRequestRelation || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership);
  if (slot === GRAPH_SLOT_IDS.compactAttribute) return selectedRoles.has(ANSWER_ROLE_IDS.identity) || facts.some(fact => fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompactAttribute);
  if (slot === GRAPH_SLOT_IDS.explanatoryPath) return selectedRoles.has(ANSWER_ROLE_IDS.contribution) || facts.some(fact => fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphExplanatoryPath);
  if (slot === GRAPH_SLOT_IDS.contextBridge) return selectedRoles.has(ANSWER_ROLE_IDS.context) || selectedRoles.has(ANSWER_ROLE_IDS.significance) || selectedRoles.has(ANSWER_ROLE_IDS.field) || facts.some(fact => fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompoundMembership || fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphCompoundAttribute);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.subject) return selectedRoles.has(ANSWER_ROLE_IDS.identity) || facts.length > 0;
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.role) return selectedRoles.has(ANSWER_ROLE_IDS.identity);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.primary) return selectedRoles.has(ANSWER_ROLE_IDS.contribution);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.context || slot === EXPLANATORY_CONTRACT_SLOT_IDS.important || slot === EXPLANATORY_CONTRACT_SLOT_IDS.contextDomain) return selectedRoles.has(ANSWER_ROLE_IDS.context) || selectedRoles.has(ANSWER_ROLE_IDS.field) || selectedRoles.has(ANSWER_ROLE_IDS.significance);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.significance) return selectedRoles.has(ANSWER_ROLE_IDS.significance) || selectedRoles.has(ANSWER_ROLE_IDS.context);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.definition) return selectedRoles.has(ANSWER_ROLE_IDS.identity) || selectedRoles.has(ANSWER_ROLE_IDS.field);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.memberSet) return facts.length >= 3 && uniqueKernelStrings(facts.map(fact => fact.object)).length >= 3;
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.source || slot === EXPLANATORY_CONTRACT_SLOT_IDS.target) return facts.length > 0;
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.effect) return selectedRoles.has(ANSWER_ROLE_IDS.significance) || selectedRoles.has(ANSWER_ROLE_IDS.field);
  if (slot === EXPLANATORY_CONTRACT_SLOT_IDS.request) return facts.some(fact => fact.overlap > 0.03);
  return false;
}


 function semanticPriorRelationMass(fact: LearnedGraphPriorFact): number {
  return splitPriorUnits(normalizePriorKey(`${fact.predicate} ${fact.object}`)).filter(Boolean).length;
}


 function semanticPriorSurfaceMass(value: string): number {
  return splitPriorUnits(normalizePriorKey(value)).filter(Boolean).length;
}


 function sigmoidKernel(value: number): number {
  return 1 / (1 + Math.exp(-value));
}


 function priorFactAdmissibleForAnswer(subject: string, predicate: string, object: string, requestAnchors: ReadonlySet<string>): boolean {
  const subjectUnits = splitPriorUnits(normalizePriorKey(subject));
  const predicateUnits = splitPriorUnits(normalizePriorKey(predicate));
  const objectUnits = splitPriorUnits(normalizePriorKey(object));
  if (!subjectUnits.length || !predicateUnits.length || !objectUnits.length) return false;
  if (priorSurfaceLooksStructuralDebris(subject) || priorSurfaceLooksStructuralDebris(object)) return false;
  if (priorSurfaceIsQuestionOperator(subjectUnits)) return false;
  if (priorSurfaceIsQuestionOperator(predicateUnits)) return false;
  if (priorSurfaceIsQuestionOperator(objectUnits)) return false;
  if (subjectUnits.some(genericQuestionSignal) && subjectUnits.filter(unit => !genericQuestionSignal(unit)).length < 1) return false;
  if (subjectUnits.length > 8) return false;
  if (predicateUnits.length > 6) return false;
  if (objectUnits.length > 5) return false;
  if ([...subject].length > 96) return false;
  if ([...predicate].length > 80) return false;
  if ([...object].length > 96) return false;
  const punctuationMass = [...object].filter(isDensePriorPunctuation).length / Math.max(1, [...object].length);
  if (punctuationMass > 0.12) return false;
  if (!requestAllowsDiagnosticModality(requestAnchors) && priorFactHasDiagnosticModality([...predicateUnits, ...objectUnits])) return false;
  return true;
}


 function priorSurfaceLooksStructuralDebris(value: string): boolean {
  const clean = stripOuterPriorSeparators(collapsePriorWhitespace(value));
  if (!clean) return true;
  const first = clean[0] ?? "";
  if (first === "#" || first === "<" || first === ">") return true;
  let quoteCount = 0;
  for (const char of clean) if (char === "\"" || char === "'") quoteCount++;
  if (quoteCount > 0 && splitPriorUnits(clean).length <= 4) return true;
  const units = splitPriorUnits(normalizePriorKey(clean));
  if (units.length <= 2 && units.some(unit => unit.includes("abort") || unit.includes("thread"))) return true;
  return false;
}


 function priorSurfaceIsQuestionOperator(units: readonly string[]): boolean {
  if (!units.length) return false;
  return units.every(unit => genericQuestionSignal(unit) || unit.length <= 1);
}


 function isDensePriorPunctuation(char: string): boolean {
  return char === ":" || char === ";" || char === "{" || char === "}" || char === "[" || char === "]" || char === "(" || char === ")" || char === "=" || char === "|";
}


 function requestAllowsDiagnosticModality(anchors: ReadonlySet<string>): boolean {
  void anchors;
  return false;
}


 function priorFactHasDiagnosticModality(units: readonly string[]): boolean {
  void units;
  return false;
}


 function prioritizeGraphPriorFacts(facts: readonly LearnedGraphPriorFact[], requestText: string): LearnedGraphPriorFact[] {
  const anchors = priorRequestAnchors(requestText);
  const primary = [...facts]
    .sort((left, right) =>
      factRequestAnchorScore(right, anchors) - factRequestAnchorScore(left, anchors) ||
      right.score - left.score ||
      right.support - left.support ||
      left.subject.localeCompare(right.subject)
    )[0];
  if (!primary) return [];
  if (factRequestAnchorScore(primary, anchors) < 2) return [];
  const subjectFacts = facts
    .filter(fact => samePriorEntity(fact.subject, primary.subject))
    .sort((left, right) => right.score - left.score || right.support - left.support || left.object.localeCompare(right.object));
  const subjectObjects = specificPriorBridgeAnchors(subjectFacts);
  const linkedFacts = facts
    .filter(fact => !samePriorEntity(fact.subject, primary.subject))
    .filter(fact => factSharesSpecificPriorAnchor(fact, subjectObjects))
    .filter(fact => factRequestAnchorScore(fact, anchors) >= 2)
    .sort((left, right) => right.score - left.score || right.support - left.support)
    .slice(0, 1);
  return uniqueLearnedFacts([...subjectFacts.slice(0, 4), ...linkedFacts]).slice(0, 5);
}


 function expandGraphPriorAnswerNeighborhood(input: {
  ranked: readonly LearnedGraphPriorFact[];
  prioritized: readonly LearnedGraphPriorFact[];
  requestText: string;
}): LearnedGraphPriorFact[] {
  const anchors = priorRequestAnchors(input.requestText);
  const primary = input.prioritized[0];
  if (!primary) return [];
  const selected: LearnedGraphPriorFact[] = [];
  const add = (fact: LearnedGraphPriorFact | undefined) => {
    if (!fact) return;
    if (selected.some(row => semanticFactKey(row) === semanticFactKey(fact))) return;
    selected.push(fact);
  };
  const subjectFacts = input.ranked
    .filter(fact => samePriorEntity(fact.subject, primary.subject))
    .sort((left, right) =>
      factCompletenessScore(right, anchors) - factCompletenessScore(left, anchors) ||
      right.score - left.score ||
      right.support - left.support
    );
  for (const fact of subjectFacts.slice(0, 8)) add(fact);
  const bridgeAnchors = specificPriorBridgeAnchors(subjectFacts);
  const linkedFacts = input.ranked
    .filter(fact => !samePriorEntity(fact.subject, primary.subject))
    .filter(fact => factSharesSpecificPriorAnchor(fact, bridgeAnchors))
    .filter(fact => factRequestAnchorScore(fact, anchors) > 0 || factSpecificBridgeScore(fact, bridgeAnchors) > 0)
    .sort((left, right) =>
      factSpecificBridgeScore(right, bridgeAnchors) - factSpecificBridgeScore(left, bridgeAnchors) ||
      factCompletenessScore(right, anchors) - factCompletenessScore(left, anchors) ||
      right.activation - left.activation ||
      right.score - left.score
    );
  for (const fact of linkedFacts.slice(0, 4)) add(fact);
  return selected
    .sort((left, right) =>
      Number(samePriorEntity(right.subject, primary.subject)) - Number(samePriorEntity(left.subject, primary.subject)) ||
      factSpecificBridgeScore(right, bridgeAnchors) - factSpecificBridgeScore(left, bridgeAnchors) ||
      factCompletenessScore(right, anchors) - factCompletenessScore(left, anchors) ||
      right.score - left.score ||
      right.support - left.support
    )
    .slice(0, 8);
}


 function semanticAnswerSlots(facts: readonly LearnedGraphPriorFact[], hasher: { digestHex(input: string | Uint8Array): string }): SemanticAnswerSlot[] {
  const byRelation = new Map<string, LearnedGraphPriorFact[]>();
  for (const fact of facts) byRelation.set(fact.relationId, [...(byRelation.get(fact.relationId) ?? []), fact]);
  return [...byRelation.entries()]
    .map(([relationId, rows]) => ({
      id: `answer.slot:${hasher.digestHex(relationId).slice(0, 16)}`,
      relationIds: [relationId],
      factKeys: rows.map(semanticFactKey),
      support: mean(rows.map(row => row.support)),
      activation: mean(rows.map(row => row.activation))
    }))
    .sort((left, right) => right.support - left.support || right.activation - left.activation)
    .slice(0, 12);
}


 function semanticQuestionShapeId(facts: readonly LearnedGraphPriorFact[], requestText: string, hasher: { digestHex(input: string | Uint8Array): string }, alphaPlan?: AlphaRhetoricalPlan): string {
  const relationMass = uniqueKernelStrings(facts.map(fact => fact.relationId)).slice(0, 8);
  const anchorMass = [...priorRequestAnchors(requestText)].slice(0, 8);
  const roleMass = alphaPlan?.selectedRoleIds ?? [];
  return `question.shape:${hasher.digestHex(JSON.stringify({ relationMass, anchorMass, roleMass })).slice(0, 16)}`;
}


 function factCompletenessScore(fact: LearnedGraphPriorFact, anchors: ReadonlySet<string>): number {
  return factRequestAnchorScore(fact, anchors) * 0.46 + fact.activation * 0.24 + fact.support * 0.18 + fact.overlap * 0.12;
}


 function semanticFactKey(fact: Pick<LearnedGraphPriorFact, "subject" | "predicate" | "object" | "relationId">): string {
  return normalizePriorKey(`${fact.subject}\u0001${fact.predicate}\u0001${fact.object}\u0001${fact.relationId}`);
}


 function priorRequestAnchors(text: string): Set<string> {
  const anchors = new Set(requestContentPriorUnits(text).filter(unit => unit.length >= 5));
  const contentUnits = requestContentPriorUnits(text)
    .map(stripOuterPriorSeparators)
    .filter(unit => unit.length >= 3 && !genericQuestionSignal(unit));
  for (const unit of splitPriorUnits(collapsePriorWhitespace(requestContentSurface(text)))) {
    const clean = stripOuterPriorSeparators(unit);
    if (clean.length >= 3 && clean.length < 5 && hasPriorAnchorSignal(clean)) anchors.add(normalizePriorKey(clean));
  }
  for (let index = 0; index < contentUnits.length - 1; index++) {
    const left = contentUnits[index] ?? "";
    const right = contentUnits[index + 1] ?? "";
    if (left.length >= 3 && right.length >= 3) anchors.add(`${left} ${right}`);
  }
  for (let index = 0; index < contentUnits.length - 2; index++) {
    const left = contentUnits[index] ?? "";
    const middle = contentUnits[index + 1] ?? "";
    const right = contentUnits[index + 2] ?? "";
    if (left.length >= 3 && middle.length >= 3 && right.length >= 3) anchors.add(`${left} ${middle} ${right}`);
  }
  const focuses = relevanceRequestFocuses(text).slice(0, 10);
  for (let index = 0; index < focuses.length - 1; index++) {
    const left = focuses[index] ?? "";
    const right = focuses[index + 1] ?? "";
    if (left.length >= 3 && right.length >= 3) anchors.add(`${left} ${right}`);
  }
  for (let index = 0; index < focuses.length - 2; index++) {
    const left = focuses[index] ?? "";
    const middle = focuses[index + 1] ?? "";
    const right = focuses[index + 2] ?? "";
    if (left.length >= 3 && middle.length >= 3 && right.length >= 3) anchors.add(`${left} ${middle} ${right}`);
  }
  return anchors;
}


 function factRequestAnchorScore(fact: LearnedGraphPriorFact, anchors: ReadonlySet<string>): number {
  if (!anchors.size) return 0;
  const subjectKey = normalizePriorKey(fact.subject);
  const objectKey = normalizePriorKey(fact.object);
  const predicateKey = normalizePriorKey(fact.predicate);
  const subjectUnits = splitPriorUnits(subjectKey);
  const objectUnits = splitPriorUnits(objectKey);
  const predicateUnits = splitPriorUnits(predicateKey);
  let phraseScore = 0;
  for (const anchor of anchors) {
    if (!anchor.includes(" ")) continue;
    if (subjectKey === anchor) phraseScore += 8;
    else if (subjectKey.includes(anchor)) phraseScore += 6;
    else if (objectKey.includes(anchor)) phraseScore += 3;
    else if (predicateKey.includes(anchor)) phraseScore += 1;
  }
  const subjectScore = subjectUnits.filter(unit => anchors.has(unit)).length * 2;
  const objectScore = objectUnits.filter(unit => anchors.has(unit)).length;
  const predicateScore = predicateUnits.filter(unit => anchors.has(unit)).length * 0.5;
  return phraseScore + subjectScore + objectScore + predicateScore;
}


 function factTopicMatchesSelected(fact: LearnedGraphPriorFact, selectedSubject: string): boolean {
  return factSubjectMatchesSelected(fact, selectedSubject) || factObjectMatchesSelected(fact, selectedSubject);
}


 function factSubjectMatchesSelected(fact: LearnedGraphPriorFact, selectedSubject: string): boolean {
  const subject = normalizePriorKey(fact.subject);
  const selected = normalizePriorKey(selectedSubject);
  if (!subject || !selected) return false;
  if (subject === selected || subject.startsWith(`${selected} `) || selected.startsWith(`${subject} `)) return true;
  if (!subject.includes(selected)) return false;
  return semanticPriorSurfaceMass(subject) <= Math.max(8, semanticPriorSurfaceMass(selected) + 5);
}


 function factObjectMatchesSelected(fact: LearnedGraphPriorFact, selectedSubject: string): boolean {
  const object = normalizePriorKey(fact.object);
  const selected = normalizePriorKey(selectedSubject);
  if (!object || !selected) return false;
  return object === selected || object.startsWith(`${selected} `) || selected.startsWith(`${object} `);
}


 function questionShapeAllowsPriorFact(fact: LearnedGraphPriorFact, requestText: string): boolean {
  void requestText;
  if (!factQuestionFitAllowsSurface(fact)) return false;
  if (lowValueCatalogFact(fact)) return false;
  if (fact.questionEdgeFit.relationRoleId === RELATION_ROLE_IDS.graphNavigation) return false;
  return fact.graphQuality.answerGrade ||
    fact.questionEdgeFit.finalQuestionFit >= 0.44 ||
    fact.questionEdgeFit.requestedSlotId === GRAPH_SLOT_IDS.requestAlignedRelation;
}


 function lowValueCatalogFact(fact: LearnedGraphPriorFact): boolean {
  const role = fact.questionEdgeFit.relationRoleId;
  const fit = fact.questionEdgeFit.finalQuestionFit;
  const quality = fact.graphQuality;
  if (role === RELATION_ROLE_IDS.graphNavigation) return true;
  if (quality.classId === GRAPH_QUALITY_CLASS_IDS.noisyMarkup || quality.classId === GRAPH_QUALITY_CLASS_IDS.redirectAlias || quality.classId === GRAPH_QUALITY_CLASS_IDS.titleHint) return true;
  if (temporalOrQuantityCatalogSurface(fact.subject) && fit < 0.7) return true;
  if (temporalOrQuantityCatalogSurface(fact.object) && fit < 0.62 && role !== RELATION_ROLE_IDS.graphRequestRelation) return true;
  if (quality.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation) return !(role === RELATION_ROLE_IDS.graphRequestMembership && fit >= 0.5 && semanticPriorSurfaceMass(fact.object) > 1);
  if (quality.classId === GRAPH_QUALITY_CLASS_IDS.weakFragment && fit < 0.5 && fact.overlap < 0.08) return true;
  if (quality.fragmentScore >= 0.62 && fit < 0.64) return true;
  return false;
}


 function temporalOrQuantityCatalogSurface(value: string): boolean {
  const units = splitPriorUnits(normalizePriorKey(value));
  if (!units.length) return false;
  const numeric = units.filter(numericCatalogUnit).length;
  if (!numeric) return false;
  return numeric / units.length >= 0.5 || (units.length <= 3 && numeric > 0);
}


 function numericCatalogUnit(unit: string): boolean {
  let digits = 0;
  let letters = 0;
  for (const char of unit) {
    if (char >= "0" && char <= "9") digits++;
    else if (char.toLocaleLowerCase() !== char.toLocaleUpperCase()) letters++;
  }
  return digits > 0 && (letters === 0 || digits >= letters);
}


 function graphNodeSurface(node: GraphNode | undefined): string {
  if (!node) return "";
  const representation = node.representation;
  if (typeof representation === "string") return representation;
  const record = jsonRecord(representation);
  for (const key of ["names", "aliases"]) {
    const value = kernelStringArray(record[key])[0];
    if (value) return value;
  }
  for (const key of ["name", "label", "text", "textPreview", "conceptId", "title", "body"]) {
    const value = kernelString(record[key]);
    if (value) return sourceTextSurface(value, 900) || value;
  }
  return String(node.id);
}


 function cleanPriorTerm(value: string): CleanPriorTerm {
  let text = collapsePriorWhitespace(value.normalize("NFKC"));
  let markerId: string | undefined;
  for (let pass = 0; pass < 4; pass++) {
    text = stripOuterPriorSeparators(text);
    const stripped = stripLeadingPriorSchemaMarker(text);
    if (!stripped) break;
    markerId = stripped.markerId;
    text = stripped.text;
  }
  return { text: stripOuterPriorSeparators(collapsePriorWhitespace(text)), markerId };
}


 function stripLeadingPriorSchemaMarker(text: string): CleanPriorTerm | undefined {
  const markers = ["body", "sentence", "answer", "question", "title", "text", "object"];
  const lower = text.toLocaleLowerCase();
  for (const marker of markers) {
    if (!lower.startsWith(marker)) continue;
    const next = text[marker.length] ?? "";
    if (next && !isPriorSeparator(next)) continue;
    let index = marker.length;
    while (index < text.length && isPriorSeparator(text[index] ?? "")) index++;
    return { markerId: marker, text: text.slice(index).trim() };
  }
  return undefined;
}


 function displayPriorTerm(value: string, role: "subject" | "object"): string {
  const clean = stripOuterPriorSeparators(collapsePriorWhitespace(value));
  if (role === "object") return clean;
  return titleCaseShortPriorTerm(clean);
}


 function titleCaseShortPriorTerm(value: string): string {
  const units = splitPriorUnits(value);
  if (!units.length || units.length > 6) return uppercaseInitial(value);
  return units.map(uppercaseInitial).join(" ");
}


 function uppercaseInitial(value: string): string {
  if (!value) return value;
  const first = value[0] ?? "";
  return `${first.toLocaleUpperCase()}${value.slice(1)}`;
}


 function samePriorEntity(left: string, right: string): boolean {
  const a = normalizePriorKey(left);
  const b = normalizePriorKey(right);
  return a === b || a.includes(b) || b.includes(a);
}


 function overlapsPriorTerm(left: string, right: string): boolean {
  const leftUnits = splitPriorUnits(normalizePriorKey(left)).filter(unit => unit.length > 3);
  const rightUnits = new Set(splitPriorUnits(normalizePriorKey(right)).filter(unit => unit.length > 3));
  if (!leftUnits.length || !rightUnits.size) return false;
  return leftUnits.some(unit => rightUnits.has(unit));
}


 function priorAnchorUnits(facts: readonly LearnedGraphPriorFact[]): Set<string> {
  const anchors = new Set<string>();
  for (const fact of facts) {
    for (const unit of [...splitPriorUnits(normalizePriorKey(fact.subject)), ...splitPriorUnits(normalizePriorKey(fact.object))]) {
      if (unit.length > 3) anchors.add(unit);
    }
  }
  return anchors;
}


 function specificPriorBridgeAnchors(facts: readonly LearnedGraphPriorFact[]): Set<string> {
  const anchors = new Set<string>();
  for (const fact of facts) {
    addSpecificPriorBridgeSurface(anchors, fact.object);
  }
  return anchors;
}


 function addSpecificPriorBridgeSurface(anchors: Set<string>, value: string): void {
  const normalized = normalizePriorKey(value);
  const units = splitPriorUnits(normalized);
  if (units.length >= 2) anchors.add(normalized);
  for (const unit of units) {
    if (unit.length >= 8) anchors.add(unit);
  }
}


 function factSpecificBridgeScore(fact: LearnedGraphPriorFact, anchors: ReadonlySet<string>): number {
  if (!anchors.size) return 0;
  let score = 0;
  for (const surface of [fact.subject, fact.object]) {
    const normalized = normalizePriorKey(surface);
    if (anchors.has(normalized)) score += 3;
    for (const unit of splitPriorUnits(normalized)) {
      if (unit.length >= 8 && anchors.has(unit)) score += 1;
    }
  }
  return score;
}


 function factSharesSpecificPriorAnchor(fact: LearnedGraphPriorFact, anchors: ReadonlySet<string>): boolean {
  return factSpecificBridgeScore(fact, anchors) > 0;
}


 function factSharesPriorAnchor(fact: LearnedGraphPriorFact, anchors: ReadonlySet<string>): boolean {
  if (!anchors.size) return false;
  for (const unit of [...splitPriorUnits(normalizePriorKey(fact.subject)), ...splitPriorUnits(normalizePriorKey(fact.object))]) {
    if (unit.length > 3 && anchors.has(unit)) return true;
  }
  return false;
}
