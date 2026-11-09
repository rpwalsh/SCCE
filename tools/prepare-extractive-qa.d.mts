// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
export interface ExtractiveQaSourceMetadata {
  dataset: string;
  source: string;
  sha256: string;
  sourceLicense: string;
  authorship: "human_authored";
  split: "train";
}
export interface ExtractiveQaLimits {
  maxInputBytes: number;
  maxOutputFileBytes: number;
  maxOutputBytes: number;
  maxOutputFiles: number;
}
export interface ExtractiveQaPreparedSource {
  dataset: string;
  sourceUri: string;
  sourceSha256: string;
  license: string;
  authorship: "human_authored";
  split: "train";
}
export interface ExtractiveQaPreparedRange {
  startCodePoint: number;
  endCodePoint: number;
  answerRange?: { startCodePoint: number; endCodePoint: number };
}
export interface ExtractiveQaPreparedTurn {
  index: number;
  speakerId: "human.question" | "human.answer";
  sourceRecordId: string;
  sourceFamilyId: string;
  surface: string;
  startCodePoint: number;
  endCodePoint: number;
  replyToTurnIndex?: number;
  commitmentScope?: "external";
  supportingSourceRanges?: ExtractiveQaPreparedRange[];
}
export interface ExtractiveQaPreparedTranscript {
  schema: "scce.dialogue_transcript.v1";
  sourceMetadata: ExtractiveQaPreparedSource;
  text: string;
  turns: ExtractiveQaPreparedTurn[];
}
export interface ExtractiveQaPreparationManifest {
  schema: "scce.extractive_qa_preparation.v1";
  source: ExtractiveQaPreparedSource;
  sourceBytes: number;
  preparation: {
    transcriptDirectory: "transcripts";
    paragraphs: number;
    questions: number;
    prepared: number;
    unanswerable: number;
    ambiguousAnnotations: number;
    holdoutPartition: "original_article";
    contextCopiesPerParagraph: 1;
  };
  limits: ExtractiveQaLimits;
  outputs: Array<{path: string; bytes: number; sha256: string}>;
  totalOutputBytes: number;
}
export function prepareExtractiveQa(input: {
  inputPath: string;
  outputDir: string;
  metadata: ExtractiveQaSourceMetadata | string;
  limits?: Partial<ExtractiveQaLimits>;
}): Promise<ExtractiveQaPreparationManifest>;
