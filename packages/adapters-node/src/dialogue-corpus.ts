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
  compileRequestRequirementCorpus,
  requestFeatures,
  REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT,
  REQUEST_REQUIREMENT_PATTERN_SCHEMA,
  type CreativeEventConstructionCompiler,
  SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
  compileRequestCommunicativeActModel,
  corpusRoleIdForSourceSystem,
  createHasher,
  dialogueRequestActObservations,
  validateDeclaredTranscriptSource,
  induceConversationalActConstructionTrainingSets,
  requestCommunicativeActPatterns,
  toJsonValue,
  type ConversationalConstructionDocument,
  type ConversationalConstructionInductionReport,
  type DialogueActObservationReport,
  type DialogueTranscriptSource,
  type TranscriptTurn,
  type EvidenceSpan,
  type EvidenceId,
  type InformationLabel,
  type JsonValue,
  type LanguagePatternRecord,
  type ScceStorage,
  type SourceVersionId
} from "@scce/kernel";
import { corpusSourceVersionIdFor, readCompletedCorpusCheckpoint, stampPattern, trainLanguageCorpusText, type LanguageCorpusTrainingInput, type LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";

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
  creativeEventCompiler?: CreativeEventConstructionCompiler;
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
  requestAuthorities: DialogueRequestAuthorityTrainingReport;
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

export interface DialogueRequestAuthorityTrainingReport {
  examples: number;
  evidenceBoundExamples: number;
  patternsPersisted: number;
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
  const transcripts: DialogueTranscriptSource[] = [];
  const read: Array<{ sourceUri: string; text: string; transcriptTurns?: readonly TranscriptTurn[]; sourceMetadata?: Record<string, JsonValue> }> = [];
  const skipped: DialogueCorpusTrainReport["filesSkipped"] = [];
  const heapCheckpointMb = input.heapCheckpointMb !== undefined && input.heapCheckpointMb > 0
    ? Math.floor(input.heapCheckpointMb)
    : undefined;
  let stoppedByHeapSafetyBound = false;
  let sourceChanged = false;
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
    const declared = path.extname(file.absolutePath).toLowerCase() === ".json"
      ? validateDeclaredTranscriptSource(JSON.parse(raw)) : undefined;
    const text = declared?.text ?? raw.trim();
    if (!text) {
      skipped.push({ path: file.relativePath, reason: "empty_file", byteLength: file.byteLength });
      continue;
    }
    transcripts.push(declared ?? text);
    read.push({ sourceUri: pathToFileURL(file.absolutePath).href, text,
      ...(declared ? { transcriptTurns: declared.turns, ...(declared.sourceMetadata ? { sourceMetadata: declared.sourceMetadata } : {}) } : {}) });
    if (input.actsOnly) continue;
    // One pathological file costs that file, never the whole run.
    try {
      const trainingInput: LanguageCorpusTrainingInput = {
        storage: input.storage,
        sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.dialogue,
        streamUri: `${CORPUS_SOURCE_SYSTEM_IDS.dialogue}:${normalizeRelative(file.relativePath)}`,
        sourceUri: pathToFileURL(file.absolutePath).href,
        text,
        ...(declared ? { transcriptTurns: declared.turns } : {}),
        mediaType: "text/plain",
        namespace: `corpus:${CORPUS_SOURCE_SYSTEM_IDS.dialogue}`,
        informationLabel: input.informationLabel,
        maxEvidenceChunkBytes: 64 * 1024,
        skipNgramObservationPersistence: true,
        ngramMaxOrder: input.ngramMaxOrder,
        ngramMaxCountersPerOrder: input.ngramMaxCountersPerOrder,
        ngramVocabularyLimit: input.ngramVocabularyLimit,
        languageAliases: input.languageAliases,
        creativeEventCompiler: input.creativeEventCompiler,
        corpusCheckpoint: { rootUri: pathToFileURL(root).href, itemUri: pathToFileURL(file.absolutePath).href,
          contentHash: sha256(text), byteLength: Buffer.byteLength(text, "utf8") },
        corpusMetadata: {
          title: documentTitleFromPath(file.relativePath),
          relativePath: normalizeRelative(file.relativePath),
          sourceHash: sha256(raw),
          corpusRole: corpusRoleIdForSourceSystem(CORPUS_SOURCE_SYSTEM_IDS.dialogue),
          authorship: input.authorship,
          ...(declared ? { transcriptSchema: declared.schema, annotatedTurns: declared.turns.length,
            ...(declared.sourceMetadata ? { sourceMetadata: declared.sourceMetadata } : {}) } : {}),
          ...(input.languageAliases?.length ? { languageAliases: [...input.languageAliases] } : {})
        }
      };
      const replay = await readCompletedCorpusCheckpoint(trainingInput);
      reports.push(replay ?? await trainLanguageCorpusText(trainingInput));
      if (!replay) sourceChanged = true;
    } catch (error) {
      skipped.push({
        path: file.relativePath,
        reason: `training_failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
        byteLength: file.byteLength
      });
    }
  }
  const refreshDialogue = input.actsOnly || sourceChanged;
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
    communicativeActs: await persistDialogueCommunicativeActs(input, refreshDialogue ? transcripts : [], refreshDialogue ? read.map(file => String(corpusSourceVersionIdFor(file))) : []),
    requestAuthorities: await persistDialogueRequestAuthorities(input, refreshDialogue ? read : []),
    conversationalConstructions: await persistConversationalConstructions(input, refreshDialogue ? read : []),
    stoppedByHeapSafetyBound,
    heapMiBAtExit: heapMiB()
  };
}

/** Compiles source-declared request labels against the exact promoted evidence owned by each transcript. */
async function persistDialogueRequestAuthorities(
  input: DialogueCorpusTrainOptions,
  read: ReadonlyArray<{ sourceUri: string; text: string; transcriptTurns?: readonly TranscriptTurn[]; sourceMetadata?: Record<string, JsonValue> }>
): Promise<DialogueRequestAuthorityTrainingReport> {
  const hasher = createHasher();
  let examples = 0;
  let evidenceBoundExamples = 0;
  let patternsPersisted = 0;
  for (const file of read) {
    const turns = file.transcriptTurns?.filter(turn => turn.requestAuthority) ?? [];
    if (!file.transcriptTurns) continue;
    const sourceVersionId = corpusSourceVersionIdFor(file);
    const profiles = await input.storage.model.listLanguageProfiles({ limit: 16, sourceVersionIds: [sourceVersionId] });
    const profile = profiles.find(item => String(item.sourceVersionId) === String(sourceVersionId));
    if (!profile) continue;
    const found = await input.storage.evidence.searchEvidence({ sourceVersionId, status: "promoted", limit: 4096 });
    const spans = found.map(row => row.span).filter(span => String(span.sourceVersionId) === String(sourceVersionId) && span.status === "promoted");
    const replies = new Map(file.transcriptTurns
      .filter(turn => turn.replyToTurnIndex !== undefined)
      .flatMap(turn => {
        const owning = spans.filter(span => span.charStart <= turn.startCodePoint && span.charEnd >= turn.endCodePoint);
        return owning.length ? [[turn.replyToTurnIndex!, { turn, evidenceIds: owning.map(span => String(span.id)) }] as const] : [];
      }));
    const bound = turns.flatMap(turn => {
      const owning = spans.filter(span => span.charStart <= turn.startCodePoint && span.charEnd >= turn.endCodePoint);
      if (!owning.length) return [];
      evidenceBoundExamples++;
      return [{ turn, evidenceIds: owning.map(span => String(span.id)) }];
    });
    examples += bound.length;
    const featureOwners = new Map<string, typeof bound>();
    for (const row of bound) for (const key of new Set(requestFeatures(row.turn.surface).map(feature => feature.key))) {
      const owners = featureOwners.get(key) ?? [];
      owners.push(row);
      featureOwners.set(key, owners);
    }
    const compiled = compileRequestRequirementCorpus({
      corpus: { schema: "scce.request_requirement_corpus.v1", language: "und", examples: bound.map(({ turn }) => ({
        text: turn.surface, authority: turn.requestAuthority!, ...(replies.has(turn.index) ? { responseText: replies.get(turn.index)!.turn.surface } : {})
      })) },
      profileId: profile.id,
      sourceVersionId,
      evidenceIds: [...new Set(bound.flatMap(row => row.evidenceIds))] as EvidenceId[],
      sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.dialogue,
      updatedAt: Date.now(),
      makeId: representation => `request_requirement_dialogue_${hasher.digestHex(canonicalStringify(representation))}`
    });
    const patterns = compiled.patterns.map(pattern => {
      const record = pattern.patternJson as Record<string, JsonValue>;
      const featureKey = `${String(record.anchor)}:${String(record.surface)}`;
      const supportingTurns = featureOwners.get(featureKey) ?? [];
      const sourceTurnRanges = supportingTurns.map(({ turn, evidenceIds }) => ({
        turnIndex: turn.index,
        authority: turn.requestAuthority!,
        sourceCategory: turn.sourceCategory ?? null,
        startCodePoint: turn.startCodePoint,
        endCodePoint: turn.endCodePoint,
        evidenceIds,
        ...(replies.has(turn.index) ? { responseTurnRange: {
          startCodePoint: replies.get(turn.index)!.turn.startCodePoint,
          endCodePoint: replies.get(turn.index)!.turn.endCodePoint,
          evidenceIds: replies.get(turn.index)!.evidenceIds
        } } : {})
      }));
      const evidenceIds = [...new Set(supportingTurns.flatMap(row => [
        ...row.evidenceIds, ...(replies.get(row.turn.index)?.evidenceIds ?? [])
      ]))].slice(0, 64) as EvidenceId[];
      return { ...pattern, evidenceIds,
        patternJson: toJsonValue({ ...record, sourceTurnRanges,
          sourceMetadata: file.sourceMetadata ?? null, trainingSourceUri: file.sourceUri }),
        informationLabel: input.informationLabel };
    });
    if (input.storage.languageMemory.replaceRequestRequirementPatterns) {
      await input.storage.languageMemory.replaceRequestRequirementPatterns({
        profileId: profile.id,
        sourceVersionId,
        sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.dialogue,
        schema: REQUEST_REQUIREMENT_PATTERN_SCHEMA,
        compilerFingerprint: REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT,
        patterns
      });
    } else if (patterns.length) {
      if (input.storage.languageMemory.putLanguagePatterns) await input.storage.languageMemory.putLanguagePatterns(patterns);
      else for (const pattern of patterns) await input.storage.languageMemory.putLanguagePattern(pattern);
    }
    patternsPersisted += patterns.length;
  }
  return { examples, evidenceBoundExamples, patternsPersisted };
}

/**
 * Compiles the request-act classifier from the transcripts this run read and writes it to the pattern store the
 * turn hydrates from. The acts are the corpus's own recorded adjacency -- what followed a turn -- so the run
 * that reads the transcripts is the run that can measure them; nothing here names an act.
 */
async function persistDialogueCommunicativeActs(
  input: DialogueCorpusTrainOptions,
  transcripts: readonly DialogueTranscriptSource[],
  sourceVersionIds: readonly string[]
): Promise<DialogueCommunicativeActTrainingReport> {
  const hasher = createHasher();
  const profileId = `language_profile_act_${hasher.digestHex(canonicalStringify([
    REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,
    corpusRoleIdForSourceSystem(CORPUS_SOURCE_SYSTEM_IDS.dialogue)
  ]))}`;
  const updatedAt = Date.now();
  const { observations, ...induction } = dialogueRequestActObservations(transcripts);
  const model = compileRequestCommunicativeActModel(observations);
  const trainingSourceDigests = transcripts.map(source => hasher.digestHex(canonicalStringify(source)));
  const patterns = requestCommunicativeActPatterns(model, {
    profileId,
    updatedAt,
    makeId: (representation: JsonValue) => `request_communicative_act_pattern_${hasher.digestHex(canonicalStringify(representation))}`
  }).map(pattern => ({ ...pattern,
    patternJson: toJsonValue({ ...(pattern.patternJson as Record<string, JsonValue>),
      trainingSourceVersionIds: [...sourceVersionIds],
      trainingSourceDigests }),
    informationLabel: input.informationLabel }));
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
  read: ReadonlyArray<{ sourceUri: string; text: string; transcriptTurns?: readonly TranscriptTurn[] }>
): Promise<DialogueConversationalConstructionTrainingReport> {
  const hasher = createHasher();
  const updatedAt = Date.now();
  const sourceVersionIds = read.map(file => corpusSourceVersionIdFor(file));
  const turnsBySource = new Map(read.map(file => [String(corpusSourceVersionIdFor(file)), file.transcriptTurns] as const));
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
    documents.push({ sourceVersionId: String(sourceVersionId), profileId, spans, transcriptTurns: turnsBySource.get(String(sourceVersionId)) });
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
      storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
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
      if (!item.isFile() || ![".txt", ".json"].includes(path.extname(item.name).toLowerCase())) continue;
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
