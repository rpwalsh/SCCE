export type DialogueCommitmentScope = "conversation" | "external";

export interface InstructionDialogueSourceMetadata {
  dataset: string;
  uri: string;
  pinnedRevision: string;
  license: string;
  attribution: string;
  shareAlikeNotice: string;
  changeNotice: string;
  categoryCommitmentScopes: Record<string, DialogueCommitmentScope>;
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
  source: Omit<InstructionDialogueSourceMetadata, "categoryCommitmentScopes"> & {
    rawJsonlFile: string;
    rawJsonlSha256: string;
    rawJsonlBytes: number;
  };
  preparation: {
    transcriptSchema: "scce.dialogue_transcript.v1";
    categoryCommitmentScopes: Record<string, DialogueCommitmentScope>;
    recordsPrepared: number;
    blankLinesSkipped: number;
    categoryCounts: Record<string, number>;
    limits: Required<InstructionDialoguePreparationLimits>;
  };
  outputs: Array<{ path: string; sha256: string; bytes: number; records: number }>;
  totalOutputBytes: number;
}>;
