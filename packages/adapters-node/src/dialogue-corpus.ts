// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { LanguageTrainingSegmentationDeclaration } from "./language-training-segmentation.js";
import { pathToFileURL } from "node:url";
import {
  CORPUS_SOURCE_SYSTEM_IDS,
  REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,
  REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE,
  REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM,
  DIALOGUE_ACT_IDS,
  canonicalStringify,
  compileLanguageConstructionPattern,
  compileRequestRequirementCorpus,
  requestFeatures,
  REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT,
  REQUEST_REQUIREMENT_PATTERN_SCHEMA,
  type CreativeEventConstructionCompiler,
  SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
  compileRequestCommunicativeActModel,
  corpusRoleIdForSourceSystem,
  corpusSourceAlias,
  createHasher,
  createLanguageIdentityRuntime,
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
  type ContentHash,
  type EvidenceSpan,
  type EvidenceId,
  type InformationLabel,
  type JsonValue,
  type LanguagePatternRecord,
  type LanguagePatternProjection,
  type ScceStorage,
  type SourceVersionId
} from "@scce/kernel";
import { corpusSourceVersionIdFor, normalizeCorpusTrainingText, readCompletedCorpusCheckpoint, stampPattern, trainLanguageCorpusText, type LanguageCorpusTrainingInput, type LanguageCorpusTrainingReport } from "./language-corpus-trainer.js";
import {persistDialogueComputationComponent,type DialogueComputationReport} from "./dialogue-computation-component.js";
import { persistDialogueContextualQaComponent, type DialogueContextualQaReport } from "./dialogue-contextual-qa-component.js";
import { DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID, conversationalCheckpointSources, runDialogueConversationalComponent } from "./dialogue-conversational-checkpoint.js";
import { sourceBrainBuildReceipt, type SourceBrainBuildReceipt, type SourceBrainBuildResult, type SourceBrainFileAdmission } from "./source-brain-build.js";

/**
 * Who wrote the text. Training on SCCE's own generations is self-training: the model would be fitted to its
 * own output rather than to human language, so only a human-authored declaration is accepted.
 */
export type DialogueCorpusAuthorship = "human_authored" | "system_generated";

export interface DialogueCorpusTrainOptions {
  beforeSourceTraining?: (source: SourceBrainFileAdmission) => void | Promise<void>;
  corpusSegmentation?: LanguageTrainingSegmentationDeclaration;
  sourceInductionExecution?: import("./source-induction-execution.js").SourceInductionWorkerExecution;
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
  onSourceBrainTrainingComplete?: (report: DialogueCorpusTrainReport) => Promise<SourceBrainBuildResult | SourceBrainBuildReceipt | void>;
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
  computationConstructions?: DialogueComputationReport;
  contextualQaConstructions?: DialogueContextualQaReport;
  stoppedByHeapSafetyBound: boolean;
  heapMiBAtExit: number;
  selection?: { selectedSourceUris: string[]; completedSourceUris: string[]; languageTrainingComplete: boolean };
  sourceBrainBuild?: SourceBrainBuildReceipt;
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
  profileIds?: string[];
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
  const completedSourceUris: string[] = [];
  const transcripts: DialogueTranscriptSource[] = [];
  const read: Array<{ sourceUri: string; text: string; transcriptTurns?: readonly TranscriptTurn[]; sourceMetadata?: Record<string, JsonValue> }> = [];
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
    const rawBytes = await readFile(file.absolutePath);
    const raw = rawBytes.toString("utf8");
    const declared = path.extname(file.absolutePath).toLowerCase() === ".json"
      ? validateDeclaredTranscriptSource(JSON.parse(raw)) : undefined;
    const text = declared?.text ?? raw.trim();
    if (!text) {
      skipped.push({ path: file.relativePath, reason: "empty_file", byteLength: file.byteLength });
      continue;
    }
    if (input.beforeSourceTraining) {
      const canonicalText = normalizeCorpusTrainingText(text);
      await input.beforeSourceTraining({ canonicalUri: pathToFileURL(file.absolutePath).href, rawContentHash: createHash("sha256").update(rawBytes).digest("hex"),
        rawByteLength: rawBytes.byteLength, sourceContentHash: sha256(canonicalText), sourceByteLength: Buffer.byteLength(canonicalText, "utf8"),
        projections: [{ sourceSystemId: CORPUS_SOURCE_SYSTEM_IDS.dialogue }] });
    }
    const includeCompletedSource=()=>{
      transcripts.push(declared ?? text);
      read.push({sourceUri:pathToFileURL(file.absolutePath).href,text,
        ...(declared?{transcriptTurns:declared.turns,...(declared.sourceMetadata?{sourceMetadata:declared.sourceMetadata}:{})}:{})});
    };
    if (input.actsOnly){includeCompletedSource();continue;}
    // One pathological file costs that file, never the whole run.
    try {
      const trainingInput: LanguageCorpusTrainingInput = {
        corpusSegmentation: input.corpusSegmentation,
        sourceInductionExecution: input.sourceInductionExecution,
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
      completedSourceUris.push(pathToFileURL(file.absolutePath).href);
      includeCompletedSource();
    } catch (error) {
      skipped.push({
        path: file.relativePath,
        reason: `training_failed: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`,
        byteLength: file.byteLength
      });
    }
  }
  const result: DialogueCorpusTrainReport = {
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
    communicativeActs: await persistDialogueCommunicativeActs(input, transcripts, read),
    requestAuthorities: await persistDialogueRequestAuthorities(input, read),
    conversationalConstructions: await runDialogueConversationalComponent({
      storage: input.storage, rootUri: pathToFileURL(root).href, informationLabel: input.informationLabel, authorship: input.authorship,
      sources: conversationalCheckpointSources(read.map(file => ({ sourceUri: file.sourceUri, sourceVersionId: String(corpusSourceVersionIdFor(file)), contentHash: sha256(file.text),
        byteLength: Buffer.byteLength(file.text, "utf8"), ...(file.transcriptTurns ? { transcriptTurns: file.transcriptTurns } : {}) }))),
      compile: () => persistConversationalConstructions(input, read), unchanged: emptyConversationalConstructionReport
    }),
    computationConstructions: await persistDialogueComputationComponent({storage:input.storage,rootUri:pathToFileURL(root).href,informationLabel:input.informationLabel,authorship:input.authorship,sources:read}),
    contextualQaConstructions: await persistDialogueContextualQaComponent({storage:input.storage,rootUri:pathToFileURL(root).href,informationLabel:input.informationLabel,authorship:input.authorship,sources:read}),
    stoppedByHeapSafetyBound,
    heapMiBAtExit: heapMiB()
  };
  result.selection = { selectedSourceUris: files.map(file => pathToFileURL(file.absolutePath).href), completedSourceUris,
    languageTrainingComplete: files.length > 0 && !input.actsOnly && !stoppedByHeapSafetyBound && skipped.length === 0 && completedSourceUris.length === files.length };
  if (input.storage.languageIdentities) {
    const profileIds = reports.map(report => report.artifacts.languageProfileId);
    if (!profileIds.length && read.length) {
      const versions = read.map(file => corpusSourceVersionIdFor(file));
      const profiles = await input.storage.model.listLanguageProfiles({ sourceVersionIds: versions, limit: versions.length });
      profileIds.push(...profiles.filter(profile => versions.includes(profile.sourceVersionId)).map(profile => profile.id));
    }
    const identities = createLanguageIdentityRuntime({ store: input.storage.languageIdentities, hasher: createHasher(), now: Date.now, informationLabel: input.informationLabel });
    await input.storage.transaction(() => identities.ensure({ requiredProfileIds: profileIds, initializeIfMissing: true }));
  }
  const sourceBrainBuild = result.selection?.languageTrainingComplete ? await input.onSourceBrainTrainingComplete?.(result) : undefined;
  if (sourceBrainBuild) result.sourceBrainBuild = "lifecycle" in sourceBrainBuild ? sourceBrainBuildReceipt(sourceBrainBuild) : sourceBrainBuild;
  return result;
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
    const rootUri = pathToFileURL(path.resolve(input.rootPath)).href;
    const contentHash = sha256(file.text) as ContentHash;
    const byteLength = Buffer.byteLength(file.text, "utf8");
    const binding = canonicalStringify({ sourceSystem: CORPUS_SOURCE_SYSTEM_IDS.dialogue, sourceVersionId, profileId: profile.id,
      rootUri, sourceUri: file.sourceUri, informationLabel: input.informationLabel,
      inputHash: hasher.digestHex(canonicalStringify({ transcriptTurns: file.transcriptTurns, sourceMetadata: file.sourceMetadata ?? null, authorship: input.authorship })) });
    const checkpointId = `dialogue_request_authority_compilation_${hasher.digestHex(binding)}`;
    const currentReceipt = async () => {
      const receipt = await input.storage.ingestion.get(checkpointId);
      const metadata = receipt?.metadata;
      return receipt?.status === "complete" && receipt.phase === "stored" && receipt.rootUri === rootUri
        && receipt.itemUri === file.sourceUri && receipt.contentHash === contentHash && receipt.byteLength === byteLength
        && metadata && typeof metadata === "object" && !Array.isArray(metadata)
        && metadata.schema === "scce.dialogue_request_authority_compilation.v1" && metadata.binding === binding
        && metadata.compilerFingerprint === REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT;
    };
    if (await currentReceipt()) continue;
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
    await input.storage.transaction(async () => {
      if (await currentReceipt()) return;
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
      await input.storage.ingestion.put({ id: checkpointId, rootUri, itemUri: file.sourceUri, phase: "stored", status: "complete",
        offsetBytes: byteLength, contentHash, byteLength, updatedAt: Date.now(), metadata: toJsonValue({
          schema: "scce.dialogue_request_authority_compilation.v1", binding,
          compilerFingerprint: REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT,
          report: { examples: bound.length, evidenceBoundExamples: bound.length, patternsPersisted: patterns.length }
        }) });
      patternsPersisted += patterns.length;
    });
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
  files: readonly { sourceUri: string; text: string }[]
): Promise<DialogueCommunicativeActTrainingReport> {
  const hasher = createHasher();
  const updatedAt = Date.now();
  const sourceDigests = transcripts.map(source => hasher.digestHex(canonicalStringify(source)));
  const populationSourceVersionIds = files.map(file => String(corpusSourceVersionIdFor(file))).sort();
  const population = new Set(populationSourceVersionIds);
  const populationDigest = hasher.digestHex(canonicalStringify(files.map((file, index) => ({ sourceVersionId: corpusSourceVersionIdFor(file),
    sourceDigest: sourceDigests[index] })).sort((a, b) => String(a.sourceVersionId).localeCompare(String(b.sourceVersionId)))));
  const pending: Array<{ index: number; file: typeof files[number]; binding: string; checkpointId: string }> = [];
  const classCounts: Record<string, number> = {};
  let patternsPersisted = 0, featuresCompiled = 0;
  const profileIds = new Set<string>();
  for (const [index, file] of files.entries()) {
    const sourceVersionId = corpusSourceVersionIdFor(file);
    const binding = canonicalStringify({ recipe: REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE, sourceVersionId,
      sourceUri: file.sourceUri, sourceDigest: sourceDigests[index], informationLabel: input.informationLabel });
    const checkpointId = `dialogue_request_act_compilation_${hasher.digestHex(binding)}`;
    const previous = await input.storage.ingestion.get(checkpointId);
    const metadata = previous?.metadata;
    const previousJson = metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : {};
    if (previous?.status === "complete" && previous.phase === "stored" && previousJson.binding === binding
      && typeof previousJson.profileId === "string" && typeof previousJson.sourceId === "string"
      && input.storage.languageMemory.getLanguagePatternProjection) {
      const active = await input.storage.languageMemory.getLanguagePatternProjection({ profileId: previousJson.profileId,
        sourceId: previousJson.sourceId as never, sourceVersionId, sourceSystem: REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM, patternSchema: REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,
        componentRecipe: REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE, informationLabel: input.informationLabel });
      if (active && canonicalStringify(active.patternIds) === canonicalStringify(previousJson.patternIds)
        && (previousJson.populationDigest === populationDigest || (Array.isArray(previousJson.populationSourceVersionIds)
          && previousJson.populationSourceVersionIds.some(id => typeof id === "string" && !population.has(id))))) {
        profileIds.add(previousJson.profileId); continue;
      }
    }
    pending.push({ index, file, binding, checkpointId });
  }
  const { observations, ...induction } = dialogueRequestActObservations(pending.length ? transcripts : []);
  const observationsByDocument = new Map<number, typeof observations[number][]>();
  for (const observation of observations) {
    const held = observationsByDocument.get(observation.documentIndex) ?? [];
    held.push(observation); observationsByDocument.set(observation.documentIndex, held);
  }
  for (const { index, file, binding, checkpointId } of pending) {
    const sourceVersionId = corpusSourceVersionIdFor(file);
    const profiles = await input.storage.model.listLanguageProfiles({ sourceVersionIds: [sourceVersionId], limit: 16 });
    const profile = profiles.find(row => row.sourceVersionId === sourceVersionId);
    if (!profile) continue;
    profileIds.add(profile.id);
    const found = await input.storage.evidence.searchEvidence({ sourceVersionId, status: "promoted", limit: 4096 });
    const spans = found.map(row => row.span).filter(span => span.status === "promoted" && span.sourceVersionId === sourceVersionId);
    const version = input.storage.evidence.sourceVersionById ? await input.storage.evidence.sourceVersionById(sourceVersionId)
      : (await input.storage.evidence.sourceVersionsForEvidence(spans.map(span => span.id))).find(row => row.sourceVersionId === sourceVersionId);
    const sourceId = version?.sourceId ?? spans[0]?.sourceId;
    if (!sourceId || spans.some(span => span.sourceId !== sourceId)) continue;
    const model = compileRequestCommunicativeActModel(observationsByDocument.get(index) ?? []);
    const patterns = (spans.length ? requestCommunicativeActPatterns(model, { profileId: profile.id, updatedAt,
      sourceOwner: { sourceId: String(sourceId), sourceVersionId: String(sourceVersionId), sourceSystem: REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM, evidenceIds: spans.map(span => String(span.id)) },
      makeId: representation => `request_communicative_act_model_${hasher.digestHex(canonicalStringify(representation))}` }) : [])
      .map(pattern => ({ ...pattern, informationLabel: input.informationLabel }));
    if (!input.storage.languageMemory.replaceLanguagePatternProjection) throw new Error("dialogue request-act publication requires exact source projection support");
    await input.storage.transaction(async () => {
      await input.storage.languageMemory.replaceLanguagePatternProjection!({ patterns, projection: { profileId: profile.id,
        sourceId, sourceVersionId, sourceSystem: REQUEST_COMMUNICATIVE_ACT_SOURCE_SYSTEM, patternSchema: REQUEST_COMMUNICATIVE_ACT_PATTERN_SCHEMA,
        componentRecipe: REQUEST_COMMUNICATIVE_ACT_SOURCE_RECIPE, patternIds: patterns.map(pattern => pattern.id), informationLabel: input.informationLabel } });
      await input.storage.ingestion.put({ id: checkpointId, rootUri: pathToFileURL(path.resolve(input.rootPath)).href, itemUri: file.sourceUri,
        phase: "stored", status: "complete", offsetBytes: Buffer.byteLength(file.text), byteLength: Buffer.byteLength(file.text),
        contentHash: sha256(file.text) as ContentHash, updatedAt,
        metadata: toJsonValue({ schema: "scce.dialogue_request_act_compilation.v2", binding, profileId: profile.id,
          sourceId, patternIds: patterns.map(pattern => pattern.id), populationDigest, populationSourceVersionIds }) });
    });
    patternsPersisted += patterns.length;
    featuresCompiled += model.features.size;
    for (const [act, count] of Object.entries(model.classCounts)) classCounts[act] = (classCounts[act] ?? 0) + count;
  }
  return {
    schema: "scce.dialogueCommunicativeActTrainingReport.v1",
    profileId: [...profileIds].sort()[0] ?? "",
    profileIds: [...profileIds].sort(),
    updatedAt,
    induction: toJsonValue(induction) as unknown as Omit<DialogueActObservationReport, "observations">,
    classCounts,
    featuresCompiled,
    patternsPersisted,
    hydrationContrast: Object.keys(classCounts).length >= 2 && Boolean(classCounts[DIALOGUE_ACT_IDS.neutral])
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
): Promise<{ report: DialogueConversationalConstructionTrainingReport; projections: LanguagePatternProjection[] }> {
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
  if (documents.length !== new Set(sourceVersionIds).size) throw new Error("Conversational compilation requires every pooled source's promoted owner evidence");

  const { sets, ...induction } = induceConversationalActConstructionTrainingSets({ documents, hasher });
  const sourceSystemId = CORPUS_SOURCE_SYSTEM_IDS.dialogue;
  const sourceSystem = corpusSourceAlias(sourceSystemId);
  const metadata = toJsonValue({
    corpusRole: corpusRoleIdForSourceSystem(sourceSystemId),
    authorship: input.authorship,
    provenanceClass: "learned_language_prior"
  });
  const patterns: LanguagePatternRecord[] = [];
  const projections: LanguagePatternProjection[] = [];
  const dependenciesByProfile = new Map<string, Map<string, { sourceId: EvidenceSpan["sourceId"]; sourceVersionId: SourceVersionId; evidenceIds: EvidenceId[] }>>();
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
    const owner = documents.find(document => document.profileId === set.profileId);
    const ownerSpan = owner?.spans[0];
    if (!owner || !ownerSpan) throw new Error("Conversational projection has no exact promoted source owner");
    const stamped = stampPattern(compiled.pattern, sourceSystem, sourceSystemId, metadata);
    patterns.push({ ...stamped, informationLabel: input.informationLabel, patternJson: toJsonValue({
      ...(stamped.patternJson as Record<string, JsonValue>), componentRecipe: DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID,
      sourceId: ownerSpan.sourceId, sourceVersionId: owner.sourceVersionId, conversationalBindingId: compiled.bundle.bindingId
    }) });
    const dependencies = dependenciesByProfile.get(set.profileId) ?? new Map();
    for (const example of compiled.bundle.sourceExamples) {
      const span = evidence.find(span => String(span.id) === example.evidenceId && String(span.sourceVersionId) === example.sourceVersionId && span.status === "promoted");
      if (!span) throw new Error("Conversational projection dependency is not exact promoted source evidence");
      const dependency = dependencies.get(example.sourceVersionId) ?? { sourceId: span.sourceId, sourceVersionId: span.sourceVersionId, evidenceIds: [] };
      if (dependency.sourceId !== span.sourceId) throw new Error("Conversational source version has conflicting source ownership");
      dependency.evidenceIds = [...new Set([...dependency.evidenceIds, span.id])].sort();
      dependencies.set(example.sourceVersionId, dependency);
    }
    dependenciesByProfile.set(set.profileId, dependencies);
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
  let patternsPersisted = 0;
  if (input.storage.languageMemory.replaceLanguagePatternProjection) {
      type ConversationProjection = LanguagePatternProjection & { sourceDependencies?: readonly { sourceVersionId: SourceVersionId }[] };
      const pooledVersions = new Set(documents.map(document => document.sourceVersionId));
      for (const owner of [...new Map(documents.map(document => [document.profileId, document])).values()].sort((a, b) => a.profileId.localeCompare(b.profileId))) {
        const profileId = owner.profileId, dependencies = dependenciesByProfile.get(profileId) ?? new Map();
        const ownedPatterns = patterns.filter(pattern => pattern.profileId === profileId);
        const ownerKey = { profileId, sourceId: owner.spans[0]!.sourceId, sourceVersionId: owner.sourceVersionId as SourceVersionId,
          sourceSystem, patternSchema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, componentRecipe: DIALOGUE_CONVERSATIONAL_CONSTRUCTION_RECIPE_ID,
          informationLabel: input.informationLabel };
        const previous: ConversationProjection | undefined = await input.storage.languageMemory.getLanguagePatternProjection?.(ownerKey);
        // A bounded shard cannot replace a recurrence family whose other source owners it did not read.
        if (previous && (!previous.sourceDependencies || previous.sourceDependencies.some(dependency => !pooledVersions.has(String(dependency.sourceVersionId))))) {
          projections.push(previous); continue;
        }
        if (!ownedPatterns.length && !previous) continue;
        const projection = { ...ownerKey, patternIds: ownedPatterns.map(pattern => pattern.id).sort(),
          sourceDependencies: [...dependencies.values()].sort((a, b) => String(a.sourceVersionId).localeCompare(String(b.sourceVersionId))) };
        await input.storage.languageMemory.replaceLanguagePatternProjection({ patterns: ownedPatterns, projection });
        projections.push(projection);
        patternsPersisted += ownedPatterns.length;
      }
  } else if (patterns.length) {
    if (input.storage.languageMemory.putLanguagePatterns) await input.storage.languageMemory.putLanguagePatterns(patterns);
    else for (const pattern of patterns) await input.storage.languageMemory.putLanguagePattern(pattern);
    patternsPersisted = patterns.length;
  }
  return { projections, report: {
    schema: "scce.dialogueConversationalConstructionTrainingReport.v1",
    updatedAt,
    documentsWithEvidence: documents.length,
    induction,
    bundles,
    rejected,
    patternsPersisted
  } };
}

function emptyConversationalConstructionReport(): DialogueConversationalConstructionTrainingReport {
  return { schema: "scce.dialogueConversationalConstructionTrainingReport.v1", updatedAt: 0, documentsWithEvidence: 0,
    induction: { schema: "scce.conversational_construction_induction.v1", documentsRead: 0, spansRead: 0, spansSegmented: 0, adjacentPairs: 0,
      neutralPairs: 0, recurringFrames: 0, varyingFrames: 0, literalFormFloor: 0, bodiedFrames: 0, fillerDiversityFloor: 0, sourceFamilyFloor: 0, keptFrames: 0, observations: 0 },
    bundles: [], rejected: [], patternsPersisted: 0 };
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
