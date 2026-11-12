// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export const CONTEXTUAL_QA_CONSTRUCTION_RECIPE = "kernel.dialogue_contextual_qa.v1" as const;
export const CONTEXTUAL_QA_COMPILER_FINGERPRINT = "kernel.dialogue_contextual_qa.compiler.v12" as const;
export const CONTEXTUAL_QA_SOURCE_SYSTEM = "dialogue" as const;
export const CONTEXTUAL_QA_DERIVED_ALIGNMENT_METHOD = "family_qualified_literal_source_reply.v3" as const;
export const CONTEXTUAL_QA_ALIGNMENT_SEGMENTATION_RECIPE = "kernel.dialogue_contextual_qa.literal_alignment.unicode_surface_replay.v1" as const;

/** Parsing metadata only; answer text and declarative programs remain in the owned construction bundle. */
export type ContextualQaRequestForm = readonly (string | { slotIndex: number })[];

export interface ContextualQaSupervision {
  sourceRecordId: string;
  sourceFamilyId?: string;
  sourceId: string;
  profileId: string;
  replyStartCodePoint: number;
  replyEndCodePoint: number;
  contextStartCodePoint: number;
  contextEndCodePoint: number;
  /** Every originally supplied support range, retained so alternative alignments can be replayed. */
  supportingSourceRanges?: readonly { startCodePoint: number; endCodePoint: number; answerRange?: { startCodePoint: number; endCodePoint: number } }[];
  /** Present only when the human transcript explicitly declared the answer coordinates. */
  answerRange?: { startCodePoint: number; endCodePoint: number };
  /** Compiler-derived alignment; verification must reproduce it from the original full reply and context. */
  derivedAnswerAlignment?: {
    method: typeof CONTEXTUAL_QA_DERIVED_ALIGNMENT_METHOD;
    segmentationRecipe: typeof CONTEXTUAL_QA_ALIGNMENT_SEGMENTATION_RECIPE;
    normalizationContractId: string;
    replyAnswerStartCodePoint: number;
    replyAnswerEndCodePoint: number;
    sourceAnswerStartCodePoint: number;
    sourceAnswerEndCodePoint: number;
  };
}

export interface ContextualQaWitness {
  sourceId: string;
  sourceVersionId: string;
  profileId: string;
  evidenceId: string;
  request: { startCodePoint: number; endCodePoint: number };
  reply: { startCodePoint: number; endCodePoint: number };
  context: { startCodePoint: number; endCodePoint: number };
  answer: { startCodePoint: number; endCodePoint: number };
  verificationRole: "fit" | "held_out";
}
