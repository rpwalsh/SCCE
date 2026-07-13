import {
  ANSWER_ROLE_IDS,
  ANSWER_SLOT_IDS,
  GRAPH_QUALITY_CLASS_IDS,
  GRAPH_SLOT_IDS,
  QUESTION_SHAPE_IDS,
  QUESTION_SHAPE_REASON_IDS,
  QUESTION_SLOT_REASON_IDS,
  QUESTION_TYPE_IDS,
  QUESTION_TYPE_REASON_IDS,
  RELATION_ROLE_IDS,
  isBackgroundAnswerRoleId,
  type QuestionShapeKindId,
  type QuestionTypeId
} from "./question-routing-ids.js";

export type QuestionSlotImportance = "core" | "secondary" | "context" | "rejected";

export type QuestionSlotPlannerQuestionType = QuestionTypeId;

const SENSE_SLOT_PRIMARY = ANSWER_SLOT_IDS.sensePrimary;
const SENSE_SLOT_LOW_VALUE = ANSWER_SLOT_IDS.senseLowValue;
const SENSE_REASON_PRIMARY = "qr.qr.72f08c9a";
const SENSE_REASON_LOW_VALUE = "qr.qr.a6d14f20";
const SENSE_REASON_ROLE_FIELD = QUESTION_SLOT_REASON_IDS.roleField;

export interface QuestionSlotFactInput {
  factKey: string;
  subject: string;
  predicate: string;
  object: string;
  relationId: string;
  forceClass: string;
  score: number;
  support: number;
  alphaSupport: number;
  ppfSupport: number;
  semanticQuality: number;
  graphQualityClassId?: string;
  answerGrade?: boolean;
  requestedSlotId?: string;
  relationRoleId?: string;
  topicSenseId?: string;
  finalQuestionFit?: number;
  upstreamRoleId?: string;
  alphaRhetoricalCentrality?: number;
}

export interface QuestionSlotAssignment {
  factKey: string;
  slotId: string;
  importance: QuestionSlotImportance;
  score: number;
  reasonIds: string[];
  topicSenseId: string;
}

export interface QuestionSlotPlan {
  schema: "scce.question_slot_plan.v1";
  questionTypeId: QuestionSlotPlannerQuestionType;
  requiredSlots: string[];
  filledCoreSlots: string[];
  filledSecondarySlots: string[];
  missingSlots: string[];
  selectedAnswerCore: QuestionSlotAssignment[];
  selectedContext: QuestionSlotAssignment[];
  rejected: QuestionSlotAssignment[];
  partialSupport: boolean;
  selectedTopicSenseId: string;
  supportMass: number;
  reasonIds: string[];
}

interface PlannerContext {
  questionUnits: string[];
  demandUnits: string[];
  selectedTopicUnits: string[];
  selectedTopic: string;
  questionTypeId: QuestionSlotPlannerQuestionType;
  selectedTopicSenseId: string;
  structuralShapeId: QuestionShapeKindId;
}

export function planQuestionSlots(input: {
  questionText: string;
  selectedTopic?: string;
  facts: readonly QuestionSlotFactInput[];
}): QuestionSlotPlan {
  const context = plannerContext(input.questionText, input.selectedTopic, input.facts);
  const requiredSlots = requiredSlotsForQuestionType(context.questionTypeId);
  const assignments = input.facts
    .map(fact => classifyFactForQuestion(fact, context))
    .sort((left, right) => importanceOrder(left.importance) - importanceOrder(right.importance) || right.score - left.score || left.factKey.localeCompare(right.factKey));
  const selectedAnswerCore = uniqueAssignments(assignments.filter(row => row.importance === "core")).slice(0, context.questionTypeId === QUESTION_TYPE_IDS.collectionMember ? 8 : 6);
  const coreKeys = new Set(selectedAnswerCore.map(row => row.factKey));
  const selectedContext = uniqueAssignments(assignments
    .filter(row => row.importance === "secondary" || row.importance === "context")
    .filter(row => !coreKeys.has(row.factKey)))
    .slice(0, 6);
  const rejected = assignments.filter(row => row.importance === "rejected").slice(0, 16);
  const filledCoreSlots = uniqueStrings(selectedAnswerCore.map(row => row.slotId));
  const filledSecondarySlots = uniqueStrings(selectedContext.map(row => row.slotId));
  const missingSlots = requiredSlots.filter(slot => !filledCoreSlots.includes(slot));
  const collectionPartial = context.questionTypeId === QUESTION_TYPE_IDS.collectionMember && selectedAnswerCore.length > 0 && selectedAnswerCore.length < 3;
  const partialSupport = missingSlots.length > 0 || collectionPartial;
  const supportMass = mean(selectedAnswerCore.map(row => row.score));
  const reasonIds = uniqueStrings([
    QUESTION_TYPE_REASON_IDS[context.questionTypeId],
    QUESTION_SHAPE_REASON_IDS[context.structuralShapeId],
    partialSupport ? QUESTION_SLOT_REASON_IDS.partialSupport : QUESTION_SLOT_REASON_IDS.coreFilled,
    missingSlots.length ? QUESTION_SLOT_REASON_IDS.requiredMissing : ""
  ]);
  return {
    schema: "scce.question_slot_plan.v1",
    questionTypeId: context.questionTypeId,
    requiredSlots,
    filledCoreSlots,
    filledSecondarySlots,
    missingSlots,
    selectedAnswerCore,
    selectedContext,
    rejected,
    partialSupport,
    selectedTopicSenseId: context.selectedTopicSenseId,
    supportMass,
    reasonIds
  };
}

function plannerContext(questionText: string, selectedTopic: string | undefined, facts: readonly QuestionSlotFactInput[]): PlannerContext {
  const questionUnits = surfaceUnits(questionText);
  const selectedTopicUnits = surfaceUnits(selectedTopic ?? "");
  const demandUnits = uniqueStrings(questionUnits.filter(unit => unit.length >= 4 && !selectedTopicUnits.some(topic => fuzzyUnit(unit, topic))));
  const structuralShapeId = structuralQuestionShape(questionUnits, questionText);
  const questionTypeId = questionTypeFor({ facts, structuralShapeId });
  const selectedTopicSenseId = selectedSenseForFacts(questionTypeId, facts, selectedTopic ?? "");
  return {
    questionUnits,
    demandUnits,
    selectedTopicUnits,
    selectedTopic: trimSurface(selectedTopic ?? ""),
    questionTypeId,
    selectedTopicSenseId,
    structuralShapeId
  };
}

function structuralQuestionShape(questionUnits: readonly string[], questionText: string): QuestionShapeKindId {
  const unitCount = questionUnits.length;
  const extent = Math.max(0, ...questionUnits.map(unit => unit.length));
  const hasQuestionBoundary = questionText.includes("?");
  if (unitCount <= 3 && hasQuestionBoundary) return QUESTION_SHAPE_IDS.compact;
  if (unitCount <= 7) return QUESTION_SHAPE_IDS.narrow;
  if (extent >= 12 || unitCount >= 12) return QUESTION_SHAPE_IDS.expanded;
  return QUESTION_SHAPE_IDS.balanced;
}

function questionTypeFor(input: { facts: readonly QuestionSlotFactInput[]; structuralShapeId: string }): QuestionSlotPlannerQuestionType {
  const membership = Math.max(0, ...input.facts.map(memberRelationScore));
  const contribution = Math.max(0, ...input.facts.map(contributionScore));
  const roleField = Math.max(0, ...input.facts.map(roleOrFieldScore));
  const significance = Math.max(0, ...input.facts.map(significanceScore));
  const senseCount = new Set(input.facts.map(fact => fact.topicSenseId).filter(Boolean)).size;
  const strongContribution = input.facts.some(fact =>
    contributionScore(fact) > 0.54 &&
    fact.graphQualityClassId !== GRAPH_QUALITY_CLASS_IDS.weakFragment &&
    fact.relationRoleId !== RELATION_ROLE_IDS.graphRequestMembership &&
    fact.relationRoleId !== RELATION_ROLE_IDS.graphCompoundMembership
  );
  if (senseCount > 1 && input.structuralShapeId === QUESTION_SHAPE_IDS.compact) return QUESTION_TYPE_IDS.senseDefinition;
  if (membership > 0.56 && !strongContribution) return QUESTION_TYPE_IDS.collectionMember;
  if (significance > 0.62 && contribution < 0.58) return QUESTION_TYPE_IDS.effectBridge;
  if (contribution > 0.54 && contribution >= roleField * 0.8) return QUESTION_TYPE_IDS.contribution;
  if (membership > 0.56) return QUESTION_TYPE_IDS.collectionMember;
  return QUESTION_TYPE_IDS.entity;
}

function requiredSlotsForQuestionType(typeId: QuestionSlotPlannerQuestionType): string[] {
  if (typeId === QUESTION_TYPE_IDS.collectionMember) return [ANSWER_SLOT_IDS.memberRelation];
  if (typeId === QUESTION_TYPE_IDS.senseDefinition) return [ANSWER_SLOT_IDS.selectedSense, SENSE_SLOT_PRIMARY];
  if (typeId === QUESTION_TYPE_IDS.effectBridge) return [ANSWER_SLOT_IDS.sourceConcept, ANSWER_SLOT_IDS.targetConcept, ANSWER_SLOT_IDS.effectRelation];
  if (typeId === QUESTION_TYPE_IDS.contribution) {
    return [ANSWER_SLOT_IDS.roleOrField, ANSWER_SLOT_IDS.contribution, ANSWER_SLOT_IDS.context, ANSWER_SLOT_IDS.significance];
  }
  return [ANSWER_SLOT_IDS.roleOrField, ANSWER_SLOT_IDS.knownForContribution];
}

function classifyFactForQuestion(fact: QuestionSlotFactInput, context: PlannerContext): QuestionSlotAssignment {
  const reasons: string[] = [];
  const baseScore = factScore(fact, context);
  const force = forceClassRank(fact.forceClass);
  if (force <= 0) {
    return assignment(fact, ANSWER_SLOT_IDS.unsupportedSource, "rejected", baseScore * 0.1, [QUESTION_SLOT_REASON_IDS.forceRejected], context);
  }
  if (fact.forceClass === "profile_excerpt_evidence") {
    return assignment(fact, ANSWER_SLOT_IDS.profileExcerpt, "secondary", baseScore * 0.42, [QUESTION_SLOT_REASON_IDS.profileExcerpt], context);
  }
  if (fact.relationRoleId === RELATION_ROLE_IDS.graphNavigation || fact.graphQualityClassId === GRAPH_QUALITY_CLASS_IDS.noisyMarkup) {
    return assignment(fact, ANSWER_SLOT_IDS.navigationNoise, "rejected", baseScore * 0.18, [QUESTION_SLOT_REASON_IDS.navigationNoise], context);
  }
  if (isBackgroundAnswerRoleId(fact.upstreamRoleId) && fact.relationRoleId !== RELATION_ROLE_IDS.graphRequestMembership) {
    return assignment(fact, ANSWER_SLOT_IDS.backgroundContext, "secondary", baseScore * 0.48, [QUESTION_SLOT_REASON_IDS.backgroundRole], context);
  }
  if (context.questionTypeId === QUESTION_TYPE_IDS.senseDefinition && fact.topicSenseId && context.selectedTopicSenseId && fact.topicSenseId !== context.selectedTopicSenseId) {
    return assignment(fact, ANSWER_SLOT_IDS.alternateSense, "rejected", baseScore * 0.42, [QUESTION_SLOT_REASON_IDS.senseMixed], context);
  }
  const metadata = metadataScore(fact);
  const requestFit = fact.finalQuestionFit ?? 0;
  const member = memberRelationScore(fact);
  const memberValue = memberCandidateValueScore(fact, context);
  const roleField = roleOrFieldScore(fact);
  const contribution = contributionScore(fact);
  const contextScore = contextObjectScore(fact, context);
  const significance = significanceScore(fact);
  if (metadata > 0.48 && requestFit < 0.72 && member < 0.5 && contribution < 0.5 && roleField < 0.5) {
    reasons.push(QUESTION_SLOT_REASON_IDS.metadata);
    return assignment(fact, metadataSlotForFact(), context.questionTypeId === QUESTION_TYPE_IDS.collectionMember ? "rejected" : "secondary", baseScore * (1 - metadata * 0.55), reasons, context);
  }
  if (context.questionTypeId === QUESTION_TYPE_IDS.collectionMember) {
    if (member > 0.5 && requestFit >= 0.24 && memberValue >= 0.46) return assignment(fact, ANSWER_SLOT_IDS.memberRelation, "core", baseScore + member * 0.26 + memberValue * 0.18, [QUESTION_SLOT_REASON_IDS.memberRequested], context);
    if (member > 0.5) return assignment(fact, ANSWER_SLOT_IDS.collectionLabelFragment, "rejected", baseScore * 0.18, [QUESTION_SLOT_REASON_IDS.collectionFragment], context);
    return assignment(fact, contextScore > 0.36 ? ANSWER_SLOT_IDS.collectionContext : ANSWER_SLOT_IDS.requestMismatch, contextScore > 0.36 ? "context" : "rejected", baseScore * 0.38, [QUESTION_SLOT_REASON_IDS.memberMissing], context);
  }
  if (context.questionTypeId === QUESTION_TYPE_IDS.contribution) {
    if (contribution > 0.42) return assignment(fact, ANSWER_SLOT_IDS.contribution, "core", baseScore + contribution * 0.28, [QUESTION_SLOT_REASON_IDS.contributionPath], context);
    if (roleField > 0.42) return assignment(fact, ANSWER_SLOT_IDS.roleOrField, "core", baseScore + roleField * 0.18, [QUESTION_SLOT_REASON_IDS.roleField], context);
    if (significance > 0.42) return assignment(fact, ANSWER_SLOT_IDS.significance, "core", baseScore + significance * 0.18, [QUESTION_SLOT_REASON_IDS.significance], context);
    if (contextScore > 0.38) return assignment(fact, ANSWER_SLOT_IDS.context, "secondary", baseScore + contextScore * 0.1, [QUESTION_SLOT_REASON_IDS.context], context);
  }
  if (context.questionTypeId === QUESTION_TYPE_IDS.effectBridge) {
    if (significance > 0.4 || contribution > 0.5) return assignment(fact, ANSWER_SLOT_IDS.effectRelation, "core", baseScore + Math.max(significance, contribution) * 0.24, [QUESTION_SLOT_REASON_IDS.effectRelation], context);
    if (roleField > 0.36) return assignment(fact, ANSWER_SLOT_IDS.sourceConcept, "secondary", baseScore, [QUESTION_SLOT_REASON_IDS.effectContext], context);
    if (contextScore > 0.36) return assignment(fact, ANSWER_SLOT_IDS.targetConcept, "secondary", baseScore, [QUESTION_SLOT_REASON_IDS.effectContext], context);
  }
  if (context.questionTypeId === QUESTION_TYPE_IDS.senseDefinition) {
    if (lowDefinitionCandidate(fact)) return assignment(fact, SENSE_SLOT_LOW_VALUE, "rejected", baseScore * 0.2, [SENSE_REASON_LOW_VALUE], context);
    if (definitionStatementCandidate(fact)) return assignment(fact, SENSE_SLOT_PRIMARY, "core", baseScore + 0.18, [SENSE_REASON_PRIMARY], context);
    if (roleField > 0.38) return assignment(fact, SENSE_SLOT_PRIMARY, "core", baseScore + roleField * 0.18, [SENSE_REASON_ROLE_FIELD], context);
    if (contribution > 0.38 || contextScore > 0.38) return assignment(fact, ANSWER_SLOT_IDS.selectedSense, "core", baseScore + Math.max(contribution, contextScore) * 0.14, [QUESTION_SLOT_REASON_IDS.selectedSense], context);
  }
  if (roleField > 0.42) return assignment(fact, ANSWER_SLOT_IDS.roleOrField, "core", baseScore + roleField * 0.16, [QUESTION_SLOT_REASON_IDS.roleField], context);
  if (contribution > 0.38 || requestFit >= 0.64) return assignment(fact, ANSWER_SLOT_IDS.knownForContribution, "core", baseScore + Math.max(contribution, requestFit) * 0.18, [QUESTION_SLOT_REASON_IDS.knownContribution], context);
  if (contextScore > 0.32 || significance > 0.34) return assignment(fact, ANSWER_SLOT_IDS.context, "secondary", baseScore * 0.72, [QUESTION_SLOT_REASON_IDS.context], context);
  return assignment(fact, ANSWER_SLOT_IDS.lowQuestionValue, "rejected", baseScore * 0.22, [QUESTION_SLOT_REASON_IDS.lowSlotValue], context);
}

function assignment(fact: QuestionSlotFactInput, slotId: string, importance: QuestionSlotImportance, score: number, reasonIds: readonly string[], context: PlannerContext): QuestionSlotAssignment {
  return {
    factKey: fact.factKey,
    slotId,
    importance,
    score: clamp01(score),
    reasonIds: uniqueStrings([...reasonIds, ...(fact.topicSenseId && fact.topicSenseId !== context.selectedTopicSenseId ? [QUESTION_SLOT_REASON_IDS.alternateSense] : [])]),
    topicSenseId: fact.topicSenseId || context.selectedTopicSenseId || "topic_sense.none"
  };
}

function factScore(fact: QuestionSlotFactInput, context: PlannerContext): number {
  const questionFit = fact.finalQuestionFit ?? 0;
  const demandFit = maxAffinity(context.demandUnits, factSurfaceUnits(fact));
  const alpha = Math.max(fact.alphaSupport, fact.alphaRhetoricalCentrality ?? 0);
  return clamp01(
    0.24 * clamp01(fact.score) +
    0.16 * clamp01(fact.support) +
    0.13 * clamp01(alpha) +
    0.11 * clamp01(fact.ppfSupport) +
    0.14 * clamp01(fact.semanticQuality) +
    0.17 * clamp01(questionFit) +
    0.05 * demandFit
  );
}

function roleOrFieldScore(fact: QuestionSlotFactInput): number {
  const objectUnits = surfaceUnits(fact.object);
  const relationRole = fact.relationRoleId === RELATION_ROLE_IDS.graphCompactAttribute ? 0.52 : 0;
  const upstream = fact.upstreamRoleId === ANSWER_ROLE_IDS.identity || fact.upstreamRoleId === ANSWER_ROLE_IDS.field ? 0.58 : 0;
  const requested = fact.requestedSlotId === ANSWER_SLOT_IDS.roleOrField || fact.requestedSlotId === SENSE_SLOT_PRIMARY || fact.requestedSlotId === GRAPH_SLOT_IDS.compactAttribute ? 0.34 : 0;
  const compact = objectUnits.length > 0 && objectUnits.length <= 6 ? 0.16 : 0;
  const compactRequestAligned = fact.relationRoleId === RELATION_ROLE_IDS.graphRequestRelation && objectUnits.length > 0 && objectUnits.length <= 3 ? 0.42 : 0;
  const answerGrade = fact.answerGrade ? 0.08 : 0;
  return clamp01(relationRole + upstream + requested + compact + compactRequestAligned + answerGrade);
}

function contributionScore(fact: QuestionSlotFactInput): number {
  const objectUnits = surfaceUnits(fact.object);
  const membershipRole = fact.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership || fact.relationRoleId === RELATION_ROLE_IDS.graphCompoundMembership;
  if (membershipRole) return 0;
  const explanatoryObject = objectUnits.length >= 5;
  const role = fact.relationRoleId === RELATION_ROLE_IDS.graphExplanatoryPath || (fact.relationRoleId === RELATION_ROLE_IDS.graphRequestRelation && explanatoryObject) ? 0.46 : 0;
  const upstream = fact.upstreamRoleId === ANSWER_ROLE_IDS.contribution && explanatoryObject ? 0.62 : fact.upstreamRoleId === ANSWER_ROLE_IDS.contribution ? 0.18 : 0;
  const requested = fact.requestedSlotId === ANSWER_SLOT_IDS.contribution || fact.requestedSlotId === ANSWER_SLOT_IDS.knownForContribution || fact.requestedSlotId === GRAPH_SLOT_IDS.explanatoryPath || fact.requestedSlotId === GRAPH_SLOT_IDS.requestAlignedRelation ? 0.36 : 0;
  const explanatoryMass = explanatoryObject ? 0.2 : 0;
  const fit = clamp01(fact.finalQuestionFit ?? 0) * 0.18;
  return clamp01(role + upstream + requested + explanatoryMass + fit);
}

function significanceScore(fact: QuestionSlotFactInput): number {
  const upstream = fact.upstreamRoleId === ANSWER_ROLE_IDS.significance ? 0.58 : 0;
  const requested = fact.requestedSlotId === ANSWER_SLOT_IDS.significance || fact.requestedSlotId === ANSWER_SLOT_IDS.effectRelation ? 0.42 : 0;
  const role = fact.relationRoleId === RELATION_ROLE_IDS.graphExplanatoryPath ? 0.18 : 0;
  return clamp01(upstream + requested + role + clamp01(fact.finalQuestionFit ?? 0) * 0.12);
}

function contextObjectScore(fact: QuestionSlotFactInput, context: PlannerContext): number {
  const upstream = fact.upstreamRoleId === ANSWER_ROLE_IDS.context || fact.upstreamRoleId === ANSWER_ROLE_IDS.field ? 0.38 : 0;
  const role = fact.relationRoleId === RELATION_ROLE_IDS.graphCompoundAttribute || fact.relationRoleId === RELATION_ROLE_IDS.graphCompoundMembership || fact.relationRoleId === RELATION_ROLE_IDS.graphContextRelation ? 0.32 : 0;
  const requested = fact.requestedSlotId === ANSWER_SLOT_IDS.context || fact.requestedSlotId === GRAPH_SLOT_IDS.contextBridge ? 0.28 : 0;
  const demand = maxAffinity(factSurfaceUnits(fact), context.demandUnits) * 0.24;
  const topicBridge = topicBridgeScore(fact, context) * 0.18;
  const untypedRelevant = !fact.relationRoleId && !fact.upstreamRoleId && !fact.requestedSlotId && clamp01(fact.finalQuestionFit ?? 0) >= 0.5 ? 0.34 : 0;
  return clamp01(upstream + role + requested + demand + topicBridge + untypedRelevant + clamp01(fact.semanticQuality) * 0.1);
}

function memberRelationScore(fact: QuestionSlotFactInput): number {
  const role = fact.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership ? 0.68 : fact.relationRoleId === RELATION_ROLE_IDS.graphCompoundMembership ? 0.34 : 0;
  const requested = fact.requestedSlotId === ANSWER_SLOT_IDS.memberRelation || fact.requestedSlotId === GRAPH_SLOT_IDS.requestAlignedRelation ? 0.24 : 0;
  const category = fact.graphQualityClassId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation && role > 0 ? 0.12 : 0;
  return clamp01(role + requested + category + clamp01(fact.finalQuestionFit ?? 0) * 0.18);
}

function memberCandidateValueScore(fact: QuestionSlotFactInput, context: PlannerContext): number {
  const objectUnits = surfaceUnits(fact.object);
  if (!objectUnits.length) return 0;
  const subjectUnits = surfaceUnits(fact.subject);
  const selected = context.selectedTopicUnits;
  const selectedSubject = selected.length > 0 && selected.every(unit => subjectUnits.some(subjectUnit => fuzzyUnit(subjectUnit, unit)));
  const objectContainsSelectedTopic = selected.length > 0 && selected.every(unit => objectUnits.some(objectUnit => fuzzyUnit(objectUnit, unit)));
  const objectIsSelectedTopic = objectContainsSelectedTopic && objectUnits.length <= selected.length + 1;
  const objectRepeatsDemand = objectUnits.every(unit => context.demandUnits.some(demand => fuzzyUnit(unit, demand)));
  const weakFragment = fact.graphQualityClassId === GRAPH_QUALITY_CLASS_IDS.weakFragment;
  const category = fact.graphQualityClassId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation;
  const genericOneToken = objectUnits.length === 1 && objectUnits[0]!.length <= 3;
  const listHeading = subjectUnits.length <= Math.max(3, selected.length + 1) && selectedSubject && objectUnits.length <= 1;
  const inverseCategoryMember = category &&
    objectContainsSelectedTopic &&
    !selectedSubject &&
    subjectUnits.length > 0 &&
    subjectUnits.length <= 6 &&
    !subjectUnits.every(unit => context.demandUnits.some(demand => fuzzyUnit(unit, demand)));
  if (inverseCategoryMember) {
    return clamp01(0.74 + clamp01(fact.finalQuestionFit ?? 0) * 0.14 + (fact.answerGrade ? 0.06 : 0));
  }
  if (selectedSubject && category && objectContainsSelectedTopic) return 0.1;
  if (objectIsSelectedTopic) return 0.08;
  if (objectRepeatsDemand) return 0.08;
  if (selectedSubject && weakFragment && objectUnits.length <= 2) return 0.08;
  if (selectedSubject && weakFragment && genericOneToken) return 0.1;
  if (fact.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership && selectedSubject) {
    const compactMember = objectUnits.length <= 5 ? 0.62 : 0.42;
    return clamp01(compactMember + clamp01(fact.finalQuestionFit ?? 0) * 0.16 + (category ? 0.08 : 0));
  }
  if (genericOneToken) return 0.06;
  if (listHeading && (weakFragment || category)) return 0.16;
  if (selectedSubject && weakFragment && objectUnits.length <= 2) return 0.22;
  if (selectedSubject && category && objectUnits.length <= 2) return 0.26;
  const compactEntity = objectUnits.length >= 1 && objectUnits.length <= 5 ? 0.54 : 0.34;
  const graphStrength = fact.graphQualityClassId === GRAPH_QUALITY_CLASS_IDS.answerGrade ? 0.2 : fact.answerGrade ? 0.1 : 0;
  const roleStrength = fact.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership ? 0.12 : 0;
  return clamp01(compactEntity + graphStrength + roleStrength);
}

function metadataScore(fact: QuestionSlotFactInput): number {
  if (fact.graphQualityClassId === GRAPH_QUALITY_CLASS_IDS.catalogNavigation && fact.relationRoleId !== RELATION_ROLE_IDS.graphRequestMembership) return 0.62;
  if (fact.relationRoleId === RELATION_ROLE_IDS.graphNavigation) return 0.74;
  if (!fact.relationRoleId && !fact.upstreamRoleId && !fact.requestedSlotId && clamp01(fact.finalQuestionFit ?? 0) < 0.64) return 0.42;
  return 0;
}

function metadataSlotForFact(): string {
  return ANSWER_SLOT_IDS.secondaryMetadata;
}

function lowDefinitionCandidate(fact: QuestionSlotFactInput): boolean {
  const objectUnits = surfaceUnits(fact.object);
  if (objectUnits.length > 1) return false;
  if (definitionStatementCandidate(fact)) return false;
  return true;
}

function definitionStatementCandidate(fact: QuestionSlotFactInput): boolean {
  const objectUnits = surfaceUnits(fact.object);
  if (!objectUnits.length) return false;
  if (fact.requestedSlotId === SENSE_SLOT_PRIMARY || fact.requestedSlotId === GRAPH_SLOT_IDS.compactAttribute) return true;
  if (fact.relationRoleId === RELATION_ROLE_IDS.definitionClass || fact.relationRoleId === RELATION_ROLE_IDS.roleClass) return true;
  if (fact.relationRoleId === RELATION_ROLE_IDS.graphCompactAttribute) return true;
  if (fact.relationRoleId === RELATION_ROLE_IDS.graphExplanatoryPath && objectUnits.length > 1) return true;
  return fact.upstreamRoleId === ANSWER_ROLE_IDS.identity || fact.upstreamRoleId === ANSWER_ROLE_IDS.field;
}

function topicBridgeScore(fact: QuestionSlotFactInput, context: PlannerContext): number {
  if (!context.selectedTopicUnits.length) return 0;
  const subject = surfaceUnits(fact.subject);
  const object = surfaceUnits(fact.object);
  const subjectHit = maxAffinity(subject, context.selectedTopicUnits);
  const objectHit = maxAffinity(object, context.selectedTopicUnits);
  if (subjectHit > 0.8 && objectHit <= 0.2) return 0.6;
  if (objectHit > 0.8 && subjectHit <= 0.2) return 0.5;
  return Math.max(subjectHit, objectHit) * 0.32;
}

function selectedSenseForFacts(typeId: QuestionSlotPlannerQuestionType, facts: readonly QuestionSlotFactInput[], selectedTopic: string): string {
  const selectedTopicUnits = surfaceUnits(selectedTopic);
  const scores = new Map<string, number>();
  for (const fact of facts) {
    const sense = fact.topicSenseId || "topic_sense.none";
    const focus = exactSelectedTopicSubjectScore(fact, selectedTopicUnits);
    const base = factScore(fact, { questionUnits: [], demandUnits: [], selectedTopicUnits, selectedTopic, questionTypeId: typeId, selectedTopicSenseId: sense, structuralShapeId: QUESTION_SHAPE_IDS.none });
    scores.set(sense, (scores.get(sense) ?? 0) + base + focus * (typeId === QUESTION_TYPE_IDS.senseDefinition ? 1.4 : 0.48));
  }
  const rows = [...scores.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  return rows[0]?.[0] ?? "topic_sense.none";
}

function exactSelectedTopicSubjectScore(fact: QuestionSlotFactInput, selectedTopicUnits: readonly string[]): number {
  if (!selectedTopicUnits.length) return 0;
  const subjectUnits = surfaceUnits(fact.subject);
  if (!subjectUnits.length) return 0;
  const covers = selectedTopicUnits.every(unit => subjectUnits.some(subjectUnit => fuzzyUnit(subjectUnit, unit)));
  if (!covers) return 0;
  if (subjectUnits.length <= selectedTopicUnits.length) return 1;
  return 0.08;
}

function forceClassRank(forceClass: string): number {
  if (forceClass === "direct_evidence") return 1;
  if (forceClass === "learned_concept_prior") return 0.82;
  if (forceClass === "profile_excerpt_evidence") return 0.28;
  if (forceClass === "learned_language_prior" || forceClass === "unknown_prior") return 0;
  return 0.18;
}

function factSurfaceUnits(fact: QuestionSlotFactInput): string[] {
  return uniqueStrings([...surfaceUnits(fact.subject), ...surfaceUnits(fact.predicate), ...surfaceUnits(fact.object), ...surfaceUnits(fact.relationId)]);
}

function maxAffinity(left: readonly string[], right: readonly string[]): number {
  if (!left.length || !right.length) return 0;
  let hits = 0;
  const limit = Math.max(1, Math.min(left.length, right.length));
  for (const unit of left) {
    let best = 0;
    for (const target of right) if (fuzzyUnit(unit, target)) best = Math.max(best, unitSimilarity(unit, target));
    hits += best;
  }
  return clamp01(hits / limit);
}

function importanceOrder(value: QuestionSlotImportance): number {
  if (value === "core") return 0;
  if (value === "secondary") return 1;
  if (value === "context") return 2;
  return 3;
}

function uniqueAssignments(rows: readonly QuestionSlotAssignment[]): QuestionSlotAssignment[] {
  const out = new Map<string, QuestionSlotAssignment>();
  for (const row of rows) {
    const existing = out.get(row.factKey);
    if (!existing || importanceOrder(row.importance) < importanceOrder(existing.importance) || row.score > existing.score) out.set(row.factKey, row);
  }
  return [...out.values()].sort((left, right) => importanceOrder(left.importance) - importanceOrder(right.importance) || right.score - left.score || left.factKey.localeCompare(right.factKey));
}

function surfaceUnits(value: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of value.normalize("NFKC").toLocaleLowerCase()) {
    if (isUnitChar(char)) {
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

function isUnitChar(char: string): boolean {
  return char.toLocaleLowerCase() !== char.toLocaleUpperCase() || (char >= "0" && char <= "9");
}

function fuzzyUnit(left: string, right: string): boolean {
  if (left === right) return true;
  if (left.length >= 4 && right.length >= 4 && (left.includes(right) || right.includes(left))) return true;
  return unitSimilarity(left, right) >= 0.72;
}

function unitSimilarity(left: string, right: string): number {
  if (!left || !right) return 0;
  if (left === right) return 1;
  const shorter = Math.min(left.length, right.length);
  const longer = Math.max(left.length, right.length);
  if (shorter < 4) return 0;
  if (left.includes(right) || right.includes(left)) return shorter / longer;
  const distance = boundedDistance(left, right, 2);
  if (distance > 2) return 0;
  return clamp01(1 - distance / longer);
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

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

function uniqueStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (value && !out.includes(value)) out.push(value);
  return out;
}
