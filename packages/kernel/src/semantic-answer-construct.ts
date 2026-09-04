// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export interface SemanticAnswerConstructFact {
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
  evidenceIds?: string[];
  roleId?: string;
  alphaRhetoricalCentrality?: number;
  pathScore?: number;
  roleScore?: number;
  bridgeValue?: number;
  backgroundPenalty?: number;
  forceMeaning?: number;
  certificationPower?: number;
  semanticQuality?: number;
  graphQualityClassId?: string;
  answerGrade?: boolean;
  cognitiveEdgeId?: string;
  requestedSlotId?: string;
  relationRoleId?: string;
  topicSenseId?: string;
  finalQuestionFit?: number;
  questionSlotId?: string;
  questionSlotImportance?: string;
  questionSlotScore?: number;
  questionSlotReasonIds?: string[];
}
