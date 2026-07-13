import { clamp01 } from "./primitives.js";
import type { GraphEdgeQuality } from "./graph-edge-quality.js";
import {
  GRAPH_QUALITY_CLASS_IDS,
  GRAPH_SLOT_IDS,
  QUESTION_EDGE_DECISION_IDS,
  RELATION_ROLE_IDS,
  type QuestionEdgeDecisionId
} from "./question-routing-ids.js";

export type QuestionShapeId = string;

export type QuestionEdgeDecision = QuestionEdgeDecisionId;

export interface RawQuestionEdgeInput {
  rawEdgeId: string;
  relationId: string;
  subject: string;
  predicate: string;
  object: string;
  forceClass: string;
  semanticQuality: number;
  graphQuality?: GraphEdgeQuality;
  alphaSupport?: number;
  ppfSupport?: number;
  supportMass?: number;
  selectedTopic?: string;
  requestText: string;
}

export interface CognitiveEdge {
  id: string;
  rawEdgeIds: string[];
  subjectRef: string;
  relationRoleId: string;
  objectRef: string;
  sourceDerivedLabels: {
    subject: string;
    predicate: string;
    object: string;
  };
  supportMass: number;
  semanticQuality: number;
  forceClass: string;
  roleAffordances: string[];
  topicSenseHints: string[];
  alphaWeight: number;
  ppfWeight: number;
  certificationPower: number;
  normalizationIds: string[];
}

export interface QuestionEdgeFit {
  rawEdgeId: string;
  cognitiveEdgeId: string;
  questionShapeId: QuestionShapeId;
  requestedSlotId: string;
  relationRoleId: string;
  topicSenseId: string;
  subjectFit: number;
  relationFit: number;
  objectFit: number;
  slotFit: number;
  alphaSupport: number;
  ppfSupport: number;
  semanticQuality: number;
  roleUsefulness: number;
  finalQuestionFit: number;
  decision: QuestionEdgeDecision;
  reasonIds: string[];
}

export interface NormalizedQuestionEdge {
  cognitiveEdge: CognitiveEdge;
  fit: QuestionEdgeFit;
}

export interface QuestionCognitiveFabric {
  questionShapeId: QuestionShapeId;
  requestedSlotIds: string[];
  selectedTopicSenseId: string;
  cognitiveEdgeCount: number;
  normalizedEdgeCount: number;
  salvagedEdgeCount: number;
  primarySlotFillCount: number;
  secondarySlotFillCount: number;
  missingRequestedSlots: string[];
  selectedFits: QuestionEdgeFit[];
  demotedFits: QuestionEdgeFit[];
  rejectedFits: QuestionEdgeFit[];
  decision: QuestionEdgeDecision;
  supportMass: number;
}

export function questionShapeIdFromText(text: string): QuestionShapeId {
  const units = surfaceUnits(text).filter(unit => unit.length > 1 && !numericUnit(unit));
  const distinct = unique(units);
  const maxExtent = Math.max(0, ...distinct.map(unit => unit.length));
  const shapeKind = questionShapeKindFor({ unitCount: distinct.length, maxExtent, textLength: text.length, hasQuestionBoundary: text.includes("?") });
  const profile = [
    shapeKind,
    `u${Math.min(15, distinct.length)}`,
    `x${Math.min(18, maxExtent)}`,
    `q${text.includes("?") ? 1 : 0}`,
    `m${Math.min(6, Math.floor(text.length / 24))}`
  ].join(".");
  return `question.shape.graph.${shapeKind}.${stableId(profile)}`;
}

export function requestedSlotsForQuestionShape(questionShapeId: QuestionShapeId): string[] {
  const shapeKind = questionShapeKindFromId(questionShapeId);
  if (shapeKind === "compact") return [GRAPH_SLOT_IDS.topicAnchor, GRAPH_SLOT_IDS.compactAttribute, GRAPH_SLOT_IDS.requestAlignedRelation];
  if (shapeKind === "narrow") return [GRAPH_SLOT_IDS.topicAnchor, GRAPH_SLOT_IDS.requestAlignedRelation, GRAPH_SLOT_IDS.compactAttribute, GRAPH_SLOT_IDS.explanatoryPath];
  if (shapeKind === "expanded") return [GRAPH_SLOT_IDS.topicAnchor, GRAPH_SLOT_IDS.explanatoryPath, GRAPH_SLOT_IDS.contextBridge, GRAPH_SLOT_IDS.requestAlignedRelation];
  return [GRAPH_SLOT_IDS.topicAnchor, GRAPH_SLOT_IDS.requestAlignedRelation, GRAPH_SLOT_IDS.compactAttribute, GRAPH_SLOT_IDS.contextBridge];
}

function questionShapeKindFor(input: { unitCount: number; maxExtent: number; textLength: number; hasQuestionBoundary: boolean }): string {
  if (input.unitCount <= 3 && input.hasQuestionBoundary) return "compact";
  if (input.unitCount <= 7 && input.textLength <= 72) return "narrow";
  if (input.unitCount >= 12 || input.maxExtent >= 12 || input.textLength >= 120) return "expanded";
  return "balanced";
}

function questionShapeKindFromId(questionShapeId: QuestionShapeId): string {
  const parts = questionShapeId.split(".");
  const candidate = parts[3] ?? "";
  return candidate === "compact" || candidate === "narrow" || candidate === "expanded" || candidate === "balanced" ? candidate : "balanced";
}

export function normalizeRawGraphEdgeToCognitiveEdge(input: RawQuestionEdgeInput): NormalizedQuestionEdge {
  return normalizeRawGraphEdgeToCognitiveEdges(input)[0] ?? fallbackNormalizedEdge(input);
}

export function normalizeRawGraphEdgeToCognitiveEdges(input: RawQuestionEdgeInput): NormalizedQuestionEdge[] {
  const questionShapeId = questionShapeIdFromText(input.requestText);
  const requestedSlotIds = requestedSlotsForQuestionShape(questionShapeId);
  const normalized = normalizeEdgeLabels(input);
  const relationRoleId = relationRoleFor(input, normalized);
  const topicSenseId = topicSenseFor(normalized, input.requestText, input.selectedTopic);
  const primarySlotId = bestSlotForRole(relationRoleId, questionShapeId);
  const normalizations = normalizationIdsFor(input, normalized, relationRoleId);
  const base = makeCognitiveEdge(input, normalized, relationRoleId, topicSenseId, normalizations);
  const fit = fitCognitiveEdge({
    input,
    edge: base,
    questionShapeId,
    requestedSlotIds,
    requestedSlotId: primarySlotId,
    topicSenseId
  });
  const edges: NormalizedQuestionEdge[] = [{ cognitiveEdge: base, fit }];
  for (const extracted of compoundTopicEdges(input, normalized, questionShapeId)) edges.push(extracted);
  return edges;
}

export function buildQuestionCognitiveFabric(edges: readonly NormalizedQuestionEdge[], questionText: string): QuestionCognitiveFabric {
  const questionShapeId = questionShapeIdFromText(questionText);
  const requestedSlotIds = requestedSlotsFromEdges(edges, questionShapeId);
  const ordered = [...edges].sort((left, right) => right.fit.finalQuestionFit - left.fit.finalQuestionFit || right.cognitiveEdge.supportMass - left.cognitiveEdge.supportMass);
  const selected: QuestionEdgeFit[] = [];
  const filled = new Set<string>();
  const selectedIds = new Set<string>();
  for (const item of ordered) {
    if (item.fit.decision !== QUESTION_EDGE_DECISION_IDS.requestedSupport && item.fit.decision !== QUESTION_EDGE_DECISION_IDS.partialSupport) continue;
    if (filled.has(item.fit.requestedSlotId)) continue;
    selected.push(item.fit);
    selectedIds.add(item.fit.cognitiveEdgeId);
    filled.add(item.fit.requestedSlotId);
    if (selected.length >= 10) break;
  }
  for (const item of ordered) {
    if (selected.length >= 10) break;
    if (selectedIds.has(item.fit.cognitiveEdgeId)) continue;
    if (item.fit.decision !== QUESTION_EDGE_DECISION_IDS.requestedSupport && item.fit.decision !== QUESTION_EDGE_DECISION_IDS.partialSupport) continue;
    if (item.fit.finalQuestionFit < 0.76) continue;
    selected.push(item.fit);
    selectedIds.add(item.fit.cognitiveEdgeId);
  }
  const missingRequestedSlots = requestedSlotIds.filter(slot => !filled.has(slot));
  const demotedFits = ordered.map(item => item.fit).filter(fit => !selected.some(row => row.cognitiveEdgeId === fit.cognitiveEdgeId) && fit.finalQuestionFit >= 0.22).slice(0, 20);
  const rejectedFits = ordered.map(item => item.fit).filter(fit => fit.finalQuestionFit < 0.22).slice(0, 20);
  const supportMass = clamp01(mean(selected.map(fit => fit.finalQuestionFit)));
  const primarySlotFillCount = requestedSlotIds.filter(slot => filled.has(slot)).length;
  const secondarySlotFillCount = selected.length - primarySlotFillCount;
  const selectedTopicSenseId = selected[0]?.topicSenseId ?? ordered[0]?.fit.topicSenseId ?? "topic_sense.none";
  return {
    questionShapeId,
    requestedSlotIds,
    selectedTopicSenseId,
    cognitiveEdgeCount: edges.length,
    normalizedEdgeCount: edges.filter(edge => edge.cognitiveEdge.normalizationIds.length > 0).length,
    salvagedEdgeCount: edges.filter(edge => edge.cognitiveEdge.normalizationIds.some(id => id.includes("salvage"))).length,
    primarySlotFillCount,
    secondarySlotFillCount,
    missingRequestedSlots,
    selectedFits: selected,
    demotedFits,
    rejectedFits,
    decision: fabricDecision({ questionShapeId, selected, missingRequestedSlots, ordered }),
    supportMass
  };
}

function fallbackNormalizedEdge(input: RawQuestionEdgeInput): NormalizedQuestionEdge {
  const questionShapeId = questionShapeIdFromText(input.requestText);
  const normalized = normalizeEdgeLabels(input);
  const edge = makeCognitiveEdge(input, normalized, RELATION_ROLE_IDS.unknown, "topic_sense.unknown", []);
  return {
    cognitiveEdge: edge,
    fit: fitCognitiveEdge({
      input,
      edge,
      questionShapeId,
      requestedSlotIds: requestedSlotsForQuestionShape(questionShapeId),
      requestedSlotId: GRAPH_SLOT_IDS.contextRelation,
      topicSenseId: "topic_sense.unknown"
    })
  };
}

function normalizeEdgeLabels(input: RawQuestionEdgeInput): { subject: string; predicate: string; object: string } {
  const subject = trimSurface(input.subject);
  const predicate = trimSurface(input.predicate);
  const object = trimSurface(input.object);
  return { subject, predicate, object };
}

function makeCognitiveEdge(input: RawQuestionEdgeInput, labels: { subject: string; predicate: string; object: string }, relationRoleId: string, topicSenseId: string, normalizationIds: string[]): CognitiveEdge {
  const id = `cognitive.edge:${stableId([input.rawEdgeId, labels.subject, relationRoleId, labels.object, topicSenseId].join("\u0001"))}`;
  return {
    id,
    rawEdgeIds: [input.rawEdgeId],
    subjectRef: labels.subject,
    relationRoleId,
    objectRef: labels.object,
    sourceDerivedLabels: { subject: input.subject, predicate: input.predicate, object: input.object },
    supportMass: clamp01(input.supportMass ?? 0.5),
    semanticQuality: clamp01(input.semanticQuality),
    forceClass: input.forceClass,
    roleAffordances: roleAffordances(relationRoleId),
    topicSenseHints: [topicSenseId],
    alphaWeight: clamp01(input.alphaSupport ?? 0),
    ppfWeight: clamp01(input.ppfSupport ?? 0),
    certificationPower: input.forceClass === "direct_evidence" ? 1 : 0,
    normalizationIds
  };
}

function fitCognitiveEdge(input: { input: RawQuestionEdgeInput; edge: CognitiveEdge; questionShapeId: QuestionShapeId; requestedSlotIds: readonly string[]; requestedSlotId: string; topicSenseId: string }): QuestionEdgeFit {
  const subjectFit = subjectFitFor(input.edge, input.input.requestText, input.input.selectedTopic);
  const demandUnits = requestContentUnits(input.input.requestText, input.input.selectedTopic);
  const demandFit = affinity(surfaceUnits(`${input.edge.sourceDerivedLabels.predicate} ${input.edge.objectRef}`), demandUnits);
  const demandPenalty = demandUnits.length > 0 &&
    demandFit <= 0 &&
    input.edge.relationRoleId !== RELATION_ROLE_IDS.graphExplanatoryPath &&
    input.edge.relationRoleId !== RELATION_ROLE_IDS.graphRequestRelation &&
    input.edge.relationRoleId !== RELATION_ROLE_IDS.graphRequestMembership
    ? 0.24
    : 0;
  const relationFit = clamp01(relationFitFor(input.edge.relationRoleId, input.questionShapeId) - demandPenalty);
  const objectFit = objectFitFor(input.edge, input.questionShapeId);
  const slotFit = input.requestedSlotIds.includes(input.requestedSlotId) ? relationFit : relationFit * 0.35;
  const roleUsefulness = roleUsefulnessFor(input.edge.relationRoleId, input.questionShapeId);
  const graphPenalty = graphQuestionPenalty(input.input.graphQuality, input.edge.normalizationIds);
  const finalQuestionFit = clamp01(
    0.19 * subjectFit +
    0.2 * relationFit +
    0.14 * objectFit +
    0.18 * slotFit +
    0.08 * clamp01(input.input.alphaSupport ?? 0) +
    0.07 * clamp01(input.input.ppfSupport ?? 0) +
    0.08 * input.edge.semanticQuality +
    0.06 * roleUsefulness -
    graphPenalty -
    demandPenalty * 0.72
  );
  const reasonIds: string[] = [];
  if (subjectFit < 0.24) reasonIds.push("question_edge.reason.subject_mismatch");
  if (slotFit < 0.3) reasonIds.push("question_edge.reason.requested_slot_mismatch");
  if (demandPenalty > 0) reasonIds.push("question_edge.reason.request_demand_unmet");
  if (input.input.graphQuality && !input.input.graphQuality.answerGrade && input.edge.normalizationIds.length === 0) reasonIds.push("question_edge.reason.raw_quality_not_answer_grade");
  if (input.edge.normalizationIds.some(id => id.includes("salvage"))) reasonIds.push("question_edge.reason.salvaged_edge");
  if (metadataRole(input.edge.relationRoleId)) reasonIds.push("question_edge.reason.secondary_metadata_role");
  return {
    rawEdgeId: input.input.rawEdgeId,
    cognitiveEdgeId: input.edge.id,
    questionShapeId: input.questionShapeId,
    requestedSlotId: input.requestedSlotId,
    relationRoleId: input.edge.relationRoleId,
    topicSenseId: input.topicSenseId,
    subjectFit,
    relationFit,
    objectFit,
    slotFit,
    alphaSupport: clamp01(input.input.alphaSupport ?? 0),
    ppfSupport: clamp01(input.input.ppfSupport ?? 0),
    semanticQuality: input.edge.semanticQuality,
    roleUsefulness,
    finalQuestionFit,
    decision: questionEdgeDecision({ finalQuestionFit, slotFit, relationFit, subjectFit, roleId: input.edge.relationRoleId, questionShapeId: input.questionShapeId, demandUnmet: demandPenalty > 0 }),
    reasonIds: unique(reasonIds)
  };
}

function relationRoleFor(input: RawQuestionEdgeInput, labels: { subject: string; predicate: string; object: string }): string {
  const relationUnits = surfaceUnits(`${labels.predicate} ${labels.object}`);
  const predicateUnits = surfaceUnits(labels.predicate);
  const objectUnits = surfaceUnits(labels.object);
  const requestUnits = requestContentUnits(input.requestText, input.selectedTopic);
  const predicateRequestFit = affinity(predicateUnits, requestUnits);
  const objectRequestFit = affinity(objectUnits, requestUnits);
  const relationRequestFit = affinity(relationUnits, requestUnits);
  const subjectTopicCompound = compactTopicCompound(labels.subject, input.selectedTopic);
  const objectTopicCompound = compactTopicCompound(labels.object, input.selectedTopic);
  const categoryLike = input.graphQuality?.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation;
  const answerGrade = Boolean(input.graphQuality?.answerGrade);
  const compactPredicate = predicateUnits.length > 0 && predicateUnits.length <= 3;
  const compactObject = objectUnits.length > 0 && objectUnits.length <= 5;
  const explanatoryObject = objectUnits.length >= 5 || relationUnits.length >= 7;
  const requestAligned = relationRequestFit > 0.14 || objectRequestFit > 0.2 || predicateRequestFit > 0.2;
  if (categoryLike) {
    if ((subjectTopicCompound || objectTopicCompound) && requestAligned) return RELATION_ROLE_IDS.graphRequestMembership;
    if (subjectTopicCompound || objectTopicCompound) return RELATION_ROLE_IDS.graphCompoundMembership;
    return RELATION_ROLE_IDS.graphNavigation;
  }
  if (requestAligned) return RELATION_ROLE_IDS.graphRequestRelation;
  if (answerGrade && compactPredicate && compactObject) return RELATION_ROLE_IDS.graphCompactAttribute;
  if (answerGrade && explanatoryObject) return RELATION_ROLE_IDS.graphExplanatoryPath;
  if (weakConnectorPredicate(labels.predicate) && explanatoryObject) return RELATION_ROLE_IDS.graphExplanatoryPath;
  if (compactObject && !weakConnectorPredicate(labels.predicate)) return RELATION_ROLE_IDS.graphCompactAttribute;
  if (subjectTopicCompound || objectTopicCompound) return RELATION_ROLE_IDS.graphCompoundAttribute;
  return RELATION_ROLE_IDS.graphContextRelation;
}

function bestSlotForRole(roleId: string, questionShapeId: QuestionShapeId): string {
  void questionShapeId;
  if (roleId === RELATION_ROLE_IDS.graphRequestRelation || roleId === RELATION_ROLE_IDS.graphRequestMembership) return GRAPH_SLOT_IDS.requestAlignedRelation;
  if (roleId === RELATION_ROLE_IDS.graphCompactAttribute) return GRAPH_SLOT_IDS.compactAttribute;
  if (roleId === RELATION_ROLE_IDS.graphExplanatoryPath) return GRAPH_SLOT_IDS.explanatoryPath;
  if (roleId === RELATION_ROLE_IDS.graphCompoundMembership) return GRAPH_SLOT_IDS.contextBridge;
  if (roleId === RELATION_ROLE_IDS.graphCompoundAttribute) return GRAPH_SLOT_IDS.compactAttribute;
  if (roleId === RELATION_ROLE_IDS.graphNavigation) return GRAPH_SLOT_IDS.navigation;
  return GRAPH_SLOT_IDS.contextRelation;
}

function relationFitFor(roleId: string, questionShapeId: QuestionShapeId): number {
  void questionShapeId;
  if (roleId === RELATION_ROLE_IDS.graphRequestRelation || roleId === RELATION_ROLE_IDS.graphRequestMembership) return 0.98;
  if (roleId === RELATION_ROLE_IDS.graphCompactAttribute) return 0.84;
  if (roleId === RELATION_ROLE_IDS.graphExplanatoryPath) return 0.78;
  if (roleId === RELATION_ROLE_IDS.graphCompoundMembership || roleId === RELATION_ROLE_IDS.graphCompoundAttribute) return 0.66;
  if (roleId === RELATION_ROLE_IDS.graphContextRelation) return 0.5;
  if (metadataRole(roleId)) return 0.08;
  return 0.42;
}

function roleUsefulnessFor(roleId: string, questionShapeId: QuestionShapeId): number {
  return clamp01(relationFitFor(roleId, questionShapeId) + (metadataRole(roleId) ? -0.22 : 0.08));
}

function graphQuestionPenalty(quality: GraphEdgeQuality | undefined, normalizationIds: readonly string[]): number {
  if (!quality) return 0;
  if (normalizationIds.some(id => id.includes("salvage") || id.includes("decomposition"))) return quality.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation ? 0.1 : 0;
  if (quality.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation) return 0.28;
  if (quality.classId === GRAPH_QUALITY_CLASS_IDS.noisyMarkup) return 0.36;
  if (quality.classId === GRAPH_QUALITY_CLASS_IDS.weakFragment) return 0.16;
  if (!quality.answerGrade) return 0.08;
  return 0;
}

function objectFitFor(edge: CognitiveEdge, questionShapeId: QuestionShapeId): number {
  void questionShapeId;
  const units = surfaceUnits(edge.objectRef);
  if (!units.length) return 0;
  const mass = Math.min(1, units.length / 10);
  const distinct = unique(units).length / Math.max(1, units.length);
  return clamp01(0.22 + mass * 0.5 + distinct * 0.18);
}

function subjectFitFor(edge: CognitiveEdge, requestText: string, selectedTopic?: string): number {
  const subject = surfaceUnits(edge.subjectRef);
  const object = surfaceUnits(edge.objectRef);
  const topic = surfaceUnits(selectedTopic ?? "");
  const request = requestContentUnits(requestText, selectedTopic);
  const anchor = topic.length ? topic : request.slice(0, 4);
  if (!anchor.length) return 0.5;
  const subjectHit = affinity(subject, anchor);
  const objectHit = affinity(object, anchor) * 0.62;
  return clamp01(Math.max(subjectHit, objectHit));
}

function topicSenseFor(labels: { subject: string; predicate: string; object: string }, requestText: string, selectedTopic?: string): string {
  const units = unique(surfaceUnits(`${selectedTopic ?? ""} ${labels.subject} ${labels.predicate} ${labels.object} ${requestText}`)).slice(0, 12);
  return units.length ? `topic_sense.${stableId(units.join("\u0001"))}` : "topic_sense.none";
}

function normalizationIdsFor(input: RawQuestionEdgeInput, labels: { subject: string; predicate: string; object: string }, roleId: string): string[] {
  const ids: string[] = [];
  if (labels.object !== trimSurface(input.object)) ids.push("cognitive_edge.normalization.long_copula_salvage");
  if (weakConnectorPredicate(labels.predicate) && roleId === RELATION_ROLE_IDS.graphExplanatoryPath) {
    ids.push("cognitive_edge.normalization.long_copula_salvage");
    ids.push("cognitive_edge.normalization.explanatory_path_salvage");
  }
  if (compactTopicCompound(input.subject, input.selectedTopic) || compactTopicCompound(input.object, input.selectedTopic)) ids.push("cognitive_edge.normalization.compound_topic_label");
  return ids;
}

function compoundTopicEdges(input: RawQuestionEdgeInput, labels: { subject: string; predicate: string; object: string }, questionShapeId: QuestionShapeId): NormalizedQuestionEdge[] {
  const topic = trimSurface(input.selectedTopic ?? "");
  if (!topic) return [];
  const extracted: NormalizedQuestionEdge[] = [];
  for (const surface of [labels.subject, labels.object]) {
    if (input.graphQuality?.classId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation && surface === labels.object) continue;
    if (!compactTopicCompound(surface, topic)) continue;
    const roles = extractRoleUnits(surface, topic);
    for (const role of roles.slice(0, 4)) {
      const requestAligned = affinity(surfaceUnits(`${labels.predicate} ${labels.object}`), requestContentUnits(input.requestText, input.selectedTopic)) > 0;
      const normalized = { subject: topic, predicate: labels.predicate, object: role };
      const edge = makeCognitiveEdge(input, normalized, requestAligned ? RELATION_ROLE_IDS.graphRequestMembership : RELATION_ROLE_IDS.graphCompoundMembership, topicSenseFor(normalized, input.requestText, topic), ["cognitive_edge.normalization.compound_label_decomposition"]);
      const fit = fitCognitiveEdge({
        input,
        edge,
        questionShapeId,
        requestedSlotIds: requestedSlotsForQuestionShape(questionShapeId),
        requestedSlotId: bestSlotForRole(edge.relationRoleId, questionShapeId),
        topicSenseId: edge.topicSenseHints[0] ?? "topic_sense.domain_unspecified"
      });
      extracted.push({ cognitiveEdge: edge, fit });
    }
  }
  return extracted;
}

function extractRoleUnits(surface: string, topic: string): string[] {
  const topicUnits = new Set(surfaceUnits(topic));
  const units = surfaceUnits(surface).filter(unit => !topicUnits.has(unit));
  const out: string[] = [];
  for (const unit of units) {
    if (unit.length <= 1) continue;
    if (numericUnit(unit)) continue;
    if (lowInformationRoleResidue(unit)) continue;
    if (out.includes(unit)) continue;
    out.push(unit);
  }
  return out;
}

function lowInformationRoleResidue(unit: string): boolean {
  let letters = 0;
  let digits = 0;
  let symbols = 0;
  for (const char of unit) {
    if (char.toLocaleLowerCase() !== char.toLocaleUpperCase()) letters++;
    else if (char >= "0" && char <= "9") digits++;
    else symbols++;
  }
  if (digits > 0 && letters === 0) return true;
  if (digits > 0 && digits >= letters) return true;
  return symbols > letters && letters <= 1;
}

function fabricDecision(input: { questionShapeId: QuestionShapeId; selected: readonly QuestionEdgeFit[]; missingRequestedSlots: readonly string[]; ordered: readonly NormalizedQuestionEdge[] }): QuestionEdgeDecision {
  if (!input.ordered.length) return QUESTION_EDGE_DECISION_IDS.insufficientSupport;
  if (!input.selected.length) {
    return input.ordered.some(edge => edge.fit.finalQuestionFit >= 0.18) ? QUESTION_EDGE_DECISION_IDS.requestedSlotMissing : QUESTION_EDGE_DECISION_IDS.insufficientSupport;
  }
  const support = mean(input.selected.map(row => row.finalQuestionFit));
  if (support >= 0.58 && input.missingRequestedSlots.length <= Math.max(1, requestedSlotsForQuestionShape(input.questionShapeId).length - 2)) return QUESTION_EDGE_DECISION_IDS.requestedSupport;
  return QUESTION_EDGE_DECISION_IDS.partialSupport;
}

function questionEdgeDecision(input: { finalQuestionFit: number; slotFit: number; relationFit: number; subjectFit: number; roleId: string; questionShapeId: QuestionShapeId; demandUnmet: boolean }): QuestionEdgeDecision {
  if (input.subjectFit < 0.18) return QUESTION_EDGE_DECISION_IDS.insufficientSupport;
  if (input.demandUnmet && input.finalQuestionFit < 0.58) return QUESTION_EDGE_DECISION_IDS.requestedSlotMissing;
  if (input.slotFit < 0.22 || input.relationFit < 0.2) return QUESTION_EDGE_DECISION_IDS.requestedSlotMissing;
  if (metadataRole(input.roleId)) return QUESTION_EDGE_DECISION_IDS.requestedSlotMissing;
  if (input.finalQuestionFit >= 0.58) return QUESTION_EDGE_DECISION_IDS.requestedSupport;
  if (input.finalQuestionFit >= 0.34) return QUESTION_EDGE_DECISION_IDS.partialSupport;
  return QUESTION_EDGE_DECISION_IDS.weakGraphOnly;
}

function roleAffordances(roleId: string): string[] {
  if (roleId === RELATION_ROLE_IDS.graphRequestRelation || roleId === RELATION_ROLE_IDS.graphRequestMembership) return [GRAPH_SLOT_IDS.requestAlignedRelation, GRAPH_SLOT_IDS.topicAnchor];
  if (roleId === RELATION_ROLE_IDS.graphCompactAttribute) return [GRAPH_SLOT_IDS.compactAttribute, GRAPH_SLOT_IDS.topicAnchor];
  if (roleId === RELATION_ROLE_IDS.graphExplanatoryPath) return [GRAPH_SLOT_IDS.explanatoryPath, GRAPH_SLOT_IDS.contextBridge];
  if (roleId === RELATION_ROLE_IDS.graphCompoundMembership || roleId === RELATION_ROLE_IDS.graphCompoundAttribute) return [GRAPH_SLOT_IDS.contextBridge];
  if (roleId === RELATION_ROLE_IDS.graphNavigation) return [GRAPH_SLOT_IDS.navigation];
  return [GRAPH_SLOT_IDS.contextRelation];
}

function weakConnectorPredicate(value: string): boolean {
  const units = surfaceUnits(value);
  return units.length === 0 || (units.length === 1 && (units[0]?.length ?? 0) <= 2);
}

function metadataRole(roleId: string): boolean {
  return roleId === RELATION_ROLE_IDS.metadata || roleId === RELATION_ROLE_IDS.graphNavigation;
}

function requestedSlotsFromEdges(edges: readonly NormalizedQuestionEdge[], questionShapeId: QuestionShapeId): string[] {
  const rows = new Map<string, number>();
  for (const edge of edges) {
    const slot = edge.fit.requestedSlotId;
    const value = Math.max(rows.get(slot) ?? 0, edge.fit.finalQuestionFit);
    rows.set(slot, value);
  }
  const ranked = [...rows.entries()]
    .filter(([slot]) => slot !== GRAPH_SLOT_IDS.navigation)
    .sort((left, right) => right[1] - left[1])
    .map(([slot]) => slot);
  return unique([...ranked.slice(0, 5), ...requestedSlotsForQuestionShape(questionShapeId)]).slice(0, 6);
}

function containsTopicCompound(surface: string, topic?: string): boolean {
  const topicUnits = surfaceUnits(topic ?? "");
  if (topicUnits.length < 1) return false;
  const surfaceUnitsValue = surfaceUnits(surface);
  if (surfaceUnitsValue.length <= topicUnits.length) return false;
  return topicUnits.every(unit => surfaceUnitsValue.includes(unit));
}

function compactTopicCompound(surface: string, topic?: string): boolean {
  if (!containsTopicCompound(surface, topic)) return false;
  const topicUnits = surfaceUnits(topic ?? "");
  const surfaceUnitsValue = surfaceUnits(surface);
  const extra = surfaceUnitsValue.length - topicUnits.length;
  const extraRatio = extra / Math.max(1, topicUnits.length);
  return extra <= 5 && extraRatio <= 2.5;
}

function affinity(units: readonly string[], anchors: readonly string[]): number {
  if (!units.length || !anchors.length) return 0;
  let hits = 0;
  for (const anchor of anchors) if (units.some(unit => fuzzyUnit(unit, anchor))) hits++;
  return clamp01(hits / Math.max(1, anchors.length));
}

function requestContentUnits(requestText: string, selectedTopic?: string): string[] {
  const topicUnits = new Set(surfaceUnits(selectedTopic ?? ""));
  const all = surfaceUnits(requestText)
    .filter(unit => !topicUnits.has(unit))
    .filter(unit => unit.length >= 5 && !numericUnit(unit));
  return unique(all);
}

function fuzzyUnit(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) return true;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if (shorter < 4) return false;
  if (longer - shorter > Math.max(1, Math.floor(longer * 0.18))) return false;
  return boundedDistance(left, right, 2) <= Math.max(1, Math.floor(longer * 0.22));
}

function boundedDistance(left: string, right: string, maxDistance: number): number {
  if (Math.abs(left.length - right.length) > maxDistance) return maxDistance + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      const value = Math.min((previous[j] ?? 0) + 1, (current[j - 1] ?? 0) + 1, (previous[j - 1] ?? 0) + cost);
      current[j] = value;
      rowMin = Math.min(rowMin, value);
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    previous = current;
  }
  return previous[right.length] ?? maxDistance + 1;
}

function surfaceUnits(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of value.normalize("NFKC").toLocaleLowerCase()) {
    if (isSurfaceChar(char)) {
      current += char;
      continue;
    }
    if (current) out.push(current);
    current = "";
  }
  if (current) out.push(current);
  return out.filter(Boolean);
}

function trimSurface(value: string): string {
  let out = "";
  let pendingSpace = false;
  for (const char of value.normalize("NFKC")) {
    const space = char === " " || char === "\t" || char === "\r" || char === "\n";
    if (space) {
      pendingSpace = Boolean(out);
      continue;
    }
    if (pendingSpace) out += " ";
    pendingSpace = false;
    out += char;
  }
  return out.trim();
}

function isSurfaceChar(char: string): boolean {
  return isLetter(char) || numericUnit(char);
}

function isLetter(char: string): boolean {
  return char.toLocaleLowerCase() !== char.toLocaleUpperCase();
}

function numericUnit(value: string): boolean {
  if (!value) return false;
  for (const char of value) if (char < "0" || char > "9") return false;
  return true;
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function unique(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (value && !out.includes(value)) out.push(value);
  return out;
}

function stableId(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
