// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export type DialogueCommitmentScope = "conversation" | "external";
export type DialogueRequestAuthority = "factual" | "reasoned" | "creative" | "translation" | "program" | "action";

export interface InstructionDialogueSourceMetadata {
  dataset: string;
  uri: string;
  pinnedRevision: string;
  license: string;
  attribution: string;
  shareAlikeNotice: string;
  changeNotice: string;
  categoryCommitmentScopes: Record<string, DialogueCommitmentScope>;
  categoryRequestAuthorities: Record<string, DialogueRequestAuthority>;
}

export interface PreparedDialogueTranscriptSourceMetadata {
  dataset: string;
  uri: string;
  pinnedRevision: string;
  license: string;
  attribution: string;
  shareAlikeNotice: string;
  changeNotice: string;
}

export interface PreparedDialogueTurnSourceMetadata {
  sourceCategory: string;
  requestAuthority?: DialogueRequestAuthority;
}

export interface PreparedDialogueTranscriptTurn extends PreparedDialogueTurnSourceMetadata {
  index: number;
  speakerId: "user" | "assistant";
  surface: string;
  startCodePoint: number;
  endCodePoint: number;
  requestAuthority?: DialogueRequestAuthority;
  replyToTurnIndex?: number;
  commitmentScope?: DialogueCommitmentScope;
  supportingSourceRanges?: Array<{ startCodePoint: number; endCodePoint: number; surface: string }>;
}

export interface PreparedDialogueTranscript {
  schema: "scce.dialogue_transcript.v1";
  sourceMetadata: PreparedDialogueTranscriptSourceMetadata;
  text: string;
  turns: PreparedDialogueTranscriptTurn[];
}

export interface InstructionDialoguePreparationLimits {
  maxInputBytes?: number;
  maxRecordBytes?: number;
  maxOutputFileBytes?: number;
  maxOutputBytes?: number;
  maxOutputFiles?: number;
  maxRecords?: number;
}

export const DECLARED_TRANSCRIPT_SCHEMA: "scce.dialogue_transcript.v1";
export const PREPARATION_MANIFEST_SCHEMA: "scce.dialogue_preparation_manifest.v1";
export const DEFAULT_PREPARATION_LIMITS: Readonly<Required<InstructionDialoguePreparationLimits>>;

export function prepareInstructionDialogue(options: {
  inputPath: string;
  outputDir: string;
  metadata: string | InstructionDialogueSourceMetadata;
  limits?: InstructionDialoguePreparationLimits;
}): Promise<{
  schema: "scce.dialogue_preparation_manifest.v1";
  source: Omit<InstructionDialogueSourceMetadata, "categoryCommitmentScopes" | "categoryRequestAuthorities"> & {
    rawJsonlFile: string;
    rawJsonlSha256: string;
    rawJsonlBytes: number;
  };
  preparation: {
    transcriptSchema: "scce.dialogue_transcript.v1";
    transcriptDirectory: "transcripts";
    categoryCommitmentScopes: Record<string, DialogueCommitmentScope>;
    categoryRequestAuthorities: Record<string, DialogueRequestAuthority>;
    recordsPrepared: number;
    blankLinesSkipped: number;
    categoryCounts: Record<string, number>;
    limits: Required<InstructionDialoguePreparationLimits>;
  };
  outputs: Array<{ path: string; sha256: string; bytes: number; records: number }>;
  totalOutputBytes: number;
}>;
