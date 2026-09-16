// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CORPUS_SOURCE_SYSTEM_IDS,
  corpusRoleIdForSourceSystem,
  type InformationLabel,
  type ScceStorage
} from "@scce/kernel";
import { trainLanguageCorpusText, type LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";

/**
 * Who wrote the text. Training on SCCE's own generations is self-training: the model would be fitted to its
 * own output rather than to human language, so only a human-authored declaration is accepted.
 */
export type DialogueCorpusAuthorship = "human_authored" | "system_generated";

export interface DialogueCorpusTrainOptions {
  storage: ScceStorage;
  rootPath: string;
  /** Dialogue is owner-private. The trainer refuses a public label so a transcript cannot be exported as corpus. */
  informationLabel: InformationLabel;
  authorship: DialogueCorpusAuthorship;
  startFileIndex?: number;
  maxFilesPerRun?: number;
  maxFileBytes?: number;
  maxDepth?: number;
  ngramMaxOrder?: number;
  ngramMaxCountersPerOrder?: number;
  ngramVocabularyLimit?: number;
  languageAliases?: readonly string[];
  /** Heap-safety checkpoint in MiB, same contract as gutenberg-corpus.ts. Cost bound, not a modeling choice. */
  heapCheckpointMb?: number;
}

export interface DialogueCorpusTrainReport {
  schema: "scce.dialogueCorpusTrainReport.v1";
  rootPath: string;
  sourceSystem: typeof CORPUS_SOURCE_SYSTEM_IDS.dialogue;
  corpusRoleId: string;
  authorship: DialogueCorpusAuthorship;
  startFileIndex: number;
  filesTrained: number;
  filesSkipped: Array<{ path: string; reason: string; byteLength?: number }>;
  totals: DialogueCorpusTrainingTotals;
  reports: LanguageCorpusTrainingReport[];
  stoppedByHeapSafetyBound: boolean;
  heapMiBAtExit: number;
}

export interface DialogueCorpusTrainingTotals {
  languageProfiles: number;
  evidence: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
}

interface FoundFile {
  absolutePath: string;
  relativePath: string;
  byteLength: number;
}

// Cost bounds, matching gutenberg-corpus.ts.
const DEFAULT_MAX_FILES = 64;
const DEFAULT_MAX_FILE_BYTES = 4_000_000;
const DEFAULT_MAX_DEPTH = 8;

export async function trainDialogueCorpus(input: DialogueCorpusTrainOptions): Promise<DialogueCorpusTrainReport> {
  if (input.authorship !== "human_authored") {
    throw new Error(
      `dialogue corpus refuses authorship ${input.authorship}: training on SCCE's own generations is self-training`
    );
  }
  if (input.informationLabel.exportClass === "public") {
    throw new Error("dialogue corpus refuses a public export class: a transcript is owner-private");
  }
  const root = path.resolve(input.rootPath);
  const startFileIndex = Math.max(0, Math.floor(input.startFileIndex ?? 0));
  const maxFiles = Math.max(1, Math.floor(input.maxFilesPerRun ?? DEFAULT_MAX_FILES));
  const maxFileBytes = Math.max(1024, Math.floor(input.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES));
  const files = (
    await walkTextFiles(root, Math.max(0, Math.floor(input.maxDepth ?? DEFAULT_MAX_DEPTH)), startFileIndex + maxFiles)
  ).slice(startFileIndex, startFileIndex + maxFiles);
  const reports: LanguageCorpusTrainingReport[] = [];
  const skipped: DialogueCorpusTrainReport["filesSkipped"] = [];
  const heapCheckpointMb = input.heapCheckpointMb !== undefined && input.heapCheckpointMb > 0
    ? Math.floor(input.heapCheckpointMb)
    : undefined;
  let stoppedByHeapSafetyBound = false;
  for (const file of files) {
    if (heapCheckpointMb !== undefined && heapMiB() >= heapCheckpointMb) {
      stoppedByHeapSafetyBound = true;
      break;
    }
    if (file.byteLength > maxFileBytes) {
      skipped.push({ path: file.relativePath, reason: "file_exceeds_maxFileBytes", byteLength: file.byteLength });
      continue;
    }
    const raw = await readFile(file.absolutePath, "utf8");
    const text = raw.trim();
    if (!text) {
      skipped.push({ path: file.relativePath, reason: "empty_file", byteLength: file.byteLength });
      continue;
    }
    // One pathological file costs that file, never the whole run.
    try {
      reports.push(await trainLanguageCorpusText({
        storage: input.storage,
        sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.dialogue,
        streamUri: `${CORPUS_SOURCE_SYSTEM_IDS.dialogue}:${normalizeRelative(file.relativePath)}`,
        sourceUri: pathToFileURL(file.absolutePath).href,
        text,
        mediaType: "text/plain",
        namespace: `corpus:${CORPUS_SOURCE_SYSTEM_IDS.dialogue}`,
        informationLabel: input.informationLabel,
        maxEvidenceChunkBytes: 64 * 1024,
        ngramMaxOrder: input.ngramMaxOrder,
        ngramMaxCountersPerOrder: input.ngramMaxCountersPerOrder,
        ngramVocabularyLimit: input.ngramVocabularyLimit,
        languageAliases: input.languageAliases,
        corpusMetadata: {
          title: documentTitleFromPath(file.relativePath),
          relativePath: normalizeRelative(file.relativePath),
          sourceHash: sha256(raw),
          corpusRole: corpusRoleIdForSourceSystem(CORPUS_SOURCE_SYSTEM_IDS.dialogue),
          authorship: input.authorship,
          ...(input.languageAliases?.length ? { languageAliases: [...input.languageAliases] } : {})
        }
      }));
    } catch (error) {
      skipped.push({
        path: file.relativePath,
        reason: `training_failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
        byteLength: file.byteLength
      });
    }
  }
  return {
    schema: "scce.dialogueCorpusTrainReport.v1",
    rootPath: root,
    sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.dialogue,
    corpusRoleId: corpusRoleIdForSourceSystem(CORPUS_SOURCE_SYSTEM_IDS.dialogue),
    authorship: input.authorship,
    startFileIndex,
    filesTrained: reports.length,
    filesSkipped: skipped,
    totals: sumReports(reports),
    reports,
    stoppedByHeapSafetyBound,
    heapMiBAtExit: heapMiB()
  };
}

function heapMiB(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}

async function walkTextFiles(root: string, maxDepth: number, maxFiles: number): Promise<FoundFile[]> {
  const out: FoundFile[] = [];
  const visit = async (dir: string, depth: number) => {
    if (out.length >= maxFiles || depth > maxDepth) return;
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (out.length >= maxFiles) break;
      const absolute = path.join(dir, item.name);
      if (item.isDirectory()) {
        if (!item.name.startsWith(".")) await visit(absolute, depth + 1);
        continue;
      }
      if (!item.isFile() || path.extname(item.name).toLowerCase() !== ".txt") continue;
      const info = await stat(absolute);
      out.push({ absolutePath: absolute, relativePath: path.relative(root, absolute), byteLength: info.size });
    }
  };
  await visit(root, 0);
  return out.sort((a, b) => a.relativePath.localeCompare(b.relativePath)).slice(0, maxFiles);
}

function sumReports(reports: readonly LanguageCorpusTrainingReport[]): DialogueCorpusTrainingTotals {
  return reports.reduce((sum, report) => ({
    languageProfiles: sum.languageProfiles + report.languageProfiles,
    evidence: sum.evidence + report.evidence,
    ngramObservations: sum.ngramObservations + report.ngramObservations,
    ngramModels: sum.ngramModels + report.ngramModels,
    languageUnits: sum.languageUnits + report.languageUnits,
    languagePatterns: sum.languagePatterns + report.languagePatterns,
    semanticFrames: sum.semanticFrames + report.semanticFrames
  }), { languageProfiles: 0, evidence: 0, ngramObservations: 0, ngramModels: 0, languageUnits: 0, languagePatterns: 0, semanticFrames: 0 });
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizeRelative(value: string): string {
  return value.replace(/\\/g, "/");
}

/** The file's own name, without directories or extension. Script-neutral: it copies the bytes the name carries. */
function documentTitleFromPath(relativePath: string): string {
  const base = normalizeRelative(relativePath).split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  return (dot > 0 ? base.slice(0, dot) : base).trim();
}
