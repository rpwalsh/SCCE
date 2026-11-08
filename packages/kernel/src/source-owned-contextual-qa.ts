// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export const CONTEXTUAL_QA_CONSTRUCTION_RECIPE = "kernel.dialogue_contextual_qa.v1" as const;
export const CONTEXTUAL_QA_SOURCE_SYSTEM = "dialogue" as const;

/** Parsing metadata only; answer text and declarative programs remain in the owned construction bundle. */
export type ContextualQaRequestForm = readonly (string | { slotIndex: number })[];

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
