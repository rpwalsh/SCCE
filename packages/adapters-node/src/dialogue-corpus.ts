// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  CORPUS_SOURCE_SYSTEM_IDS,
  REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,
  canonicalStringify,
  compileLanguageConstructionPattern,
  compileRequestCommunicativeActModel,
  corpusRoleIdForSourceSystem,
  createHasher,
  dialogueRequestActObservations,
  induceConversationalActConstructionTrainingSets,
  requestCommunicativeActPatterns,
  toJsonValue,
  type ConversationalConstructionDocument,
  type ConversationalConstructionInductionReport,
  type DialogueActObservationReport,
  type EvidenceSpan,
  type InformationLabel,
  type JsonValue,
  type LanguagePatternRecord,
  type ScceStorage,
  type SourceVersionId
} from "@scce/kernel";
import { corpusSourceVersionIdFor, stampPattern, trainLanguageCorpusText, type LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";

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
  /** Compile the request-act classifier from this run's transcripts without re-training their n-gram memory. */
  actsOnly?: boolean;
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
  communicativeActs: DialogueCommunicativeActTrainingReport;
  conversationalConstructions: DialogueConversationalConstructionTrainingReport;
  stoppedByHeapSafetyBound: boolean;
  heapMiBAtExit: number;
}

/** What the run's own replies taught the conversation-bound lane, and what of it reached the pattern store. */
export interface DialogueConversationalConstructionTrainingReport {
  schema: "scce.dialogueConversationalConstructionTrainingReport.v1";
  updatedAt: number;
  documentsWithEvidence: number;
  induction: Omit<ConversationalConstructionInductionReport, "sets">;
  bundles: Array<{
    bindingId: string;
    actId: string;
    profileId: string;
    patternId: string;
    constructions: number;
    oneSlotConstructions: number;
    observations: number;
    sourceVersionIds: number;
  }>;
  rejected: Array<{ bindingId: string; issues: string[] }>;
  patternsPersisted: number;
}

/** What the run's own transcripts taught the request-act classifier, and what of it reached the pattern store. */
export interface DialogueCommunicativeActTrainingReport {
  schema: "scce.dialogueCommunicativeActTrainingReport.v1";
  profileId: string;
  updatedAt: number;
  induction: Omit<DialogueActObservationReport, "observations">;
  classCounts: Record<string, number>;
  featuresCompiled: number;
  patternsPersisted: number;
  /** Absent contrast is a fact about the corpus, not an error: hydration refuses a model without it. */
  hydrationContrast: boolean;
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
  const transcripts: string[] = [];
  const read: Array<{ sourceUri: string; text: string }> = [];
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
    transcripts.push(text);
    read.push({ sourceUri: pathToFileURL(file.absolutePath).href, text });
    if (input.actsOnly) continue;
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
    communicativeActs: await persistDialogueCommunicativeActs(input, transcripts),
    conversationalConstructions: await persistConversationalConstructions(input, read),
    stoppedByHeapSafetyBound,
    heapMiBAtExit: heapMiB()
  };
}

/**
 * Compiles the request-act classifier from the transcripts this run read and writes it to the pattern store the
 * turn hydrates from. The acts are the corpus's own recorded adjacency -- what followed a turn -- so the run
 * that reads the transcripts is the run that can measure them; nothing here names an act.
 */
async function persistDialogueCommunicativeActs(
  input: DialogueCorpusTrainOptions,
  transcripts: readonly string[]
): Promise<DialogueCommunicativeActTrainingReport> {
  const hasher = createHasher();
  const profileId = `language_profile_act_${hasher.digestHex(canonicalStringify([
    REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,
    corpusRoleIdForSourceSystem(CORPUS_SOURCE_SYSTEM_IDS.dialogue)
  ]))}`;
  const updatedAt = Date.now();
  const { observations, ...induction } = dialogueRequestActObservations(transcripts);
  const model = compileRequestCommunicativeActModel(observations);
  const patterns = requestCommunicativeActPatterns(model, {
    profileId,
    updatedAt,
    makeId: (representation: JsonValue) => `request_communicative_act_pattern_${hasher.digestHex(canonicalStringify(representation))}`
  }).map(pattern => ({ ...pattern, informationLabel: input.informationLabel }));
  if (patterns.length) {
    if (input.storage.languageMemory.putLanguagePatterns) await input.storage.languageMemory.putLanguagePatterns(patterns);
    else for (const pattern of patterns) await input.storage.languageMemory.putLanguagePattern(pattern);
  }
  const classIds = Object.keys(model.classCounts);
  return {
    schema: "scce.dialogueCommunicativeActTrainingReport.v1",
    profileId,
    updatedAt,
    induction: toJsonValue(induction) as unknown as Omit<DialogueActObservationReport, "observations">,
    classCounts: model.classCounts,
    featuresCompiled: model.features.size,
    patternsPersisted: patterns.length,
    hydrationContrast: classIds.length >= 2 && patterns.length > 0
  };
}

/**
 * Compiles the conversation-bound lane's own construction bundles from the transcripts this run read, and writes
 * them to the same pattern store the relation-keyed bundles live in. The bundle key is act-derived rather than
 * predicate-derived, so nothing here can be mistaken for -- or relabelled as -- a relation-filling frame, and the
 * compiler, anti-unification and durability checks are the ones the relation lane already passes through.
 *
 * Reads the run's evidence back from storage rather than re-chunking the files, so `--acts-only` compiles these
 * against the corpus already ingested, and so one bundle can span every transcript a frame recurred in.
 */
async function persistConversationalConstructions(
  input: DialogueCorpusTrainOptions,
  read: ReadonlyArray<{ sourceUri: string; text: string }>
): Promise<DialogueConversationalConstructionTrainingReport> {
  const hasher = createHasher();
  const updatedAt = Date.now();
  const sourceVersionIds = read.map(file => corpusSourceVersionIdFor(file));
  const profiles = sourceVersionIds.length
    ? await input.storage.model.listLanguageProfiles({ limit: Math.max(64, sourceVersionIds.length * 4), sourceVersionIds })
    : [];
  const profileBySourceVersion = new Map(profiles.map(profile => [String(profile.sourceVersionId), profile.id] as const));
  const documents: ConversationalConstructionDocument[] = [];
  const evidence: EvidenceSpan[] = [];
  for (const sourceVersionId of sourceVersionIds) {
    const profileId = profileBySourceVersion.get(String(sourceVersionId));
    if (!profileId) continue;
    const found = await input.storage.evidence.searchEvidence({
      sourceVersionId: sourceVersionId as SourceVersionId,
      status: "promoted",
      limit: 4096
    });
    const spans = found.map(row => row.span);
    if (!spans.length) continue;
    evidence.push(...spans);
    documents.push({ sourceVersionId: String(sourceVersionId), profileId, spans });
  }

  const { sets, ...induction } = induceConversationalActConstructionTrainingSets({ documents, hasher });
  const sourceSystemId = CORPUS_SOURCE_SYSTEM_IDS.dialogue;
  const metadata = toJsonValue({
    corpusRole: corpusRoleIdForSourceSystem(sourceSystemId),
    authorship: input.authorship,
    provenanceClass: "learned_language_prior"
  });
  const patterns: LanguagePatternRecord[] = [];
  const bundles: DialogueConversationalConstructionTrainingReport["bundles"] = [];
  const rejected: DialogueConversationalConstructionTrainingReport["rejected"] = [];
  for (const set of sets) {
    const compiled = compileLanguageConstructionPattern({
      bindingId: set.bindingId,
      profileId: set.profileId,
      observations: set.observations,
      evidence,
      hasher,
      updatedAt
    });
    if (compiled.status !== "compiled") {
      rejected.push({ bindingId: set.bindingId, issues: [...new Set(compiled.issues.map(issue => issue.code))].sort() });
      continue;
    }
    patterns.push({
      ...stampPattern(compiled.pattern, "dialogue", sourceSystemId, metadata),
      informationLabel: input.informationLabel
    });
    bundles.push({
      bindingId: set.bindingId,
      actId: set.actId,
      profileId: set.profileId,
      patternId: compiled.pattern.id,
      constructions: compiled.bundle.constructions.length,
      oneSlotConstructions: compiled.bundle.constructions.filter(item => item.roleOccurrences.length === 1).length,
      observations: set.observations.length,
      sourceVersionIds: compiled.bundle.sourceVersionIds.length
    });
  }
  if (patterns.length) {
    if (input.storage.languageMemory.putLanguagePatterns) await input.storage.languageMemory.putLanguagePatterns(patterns);
    else for (const pattern of patterns) await input.storage.languageMemory.putLanguagePattern(pattern);
  }
  return {
    schema: "scce.dialogueConversationalConstructionTrainingReport.v1",
    updatedAt,
    documentsWithEvidence: documents.length,
    induction,
    bundles,
    rejected,
    patternsPersisted: patterns.length
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
