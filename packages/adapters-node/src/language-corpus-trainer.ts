// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { AlignmentCalibrationObservation, AlignmentPromotionObservation, GraphEdge, GraphNode, Hyperedge } from "@scce/kernel";
import { ingestStageTracer } from "./ingest-stage-trace-sink.js";
import { blobContentHash } from "./postgres.js";
import {
  createClock,
  canonicalStringify,
  createEventFactory,
  createEvidenceExtractor,
  putSpanBlobs,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime,
  createSourceAdmissionController,
  compileLanguageTrainingBatch,
  prepareLanguageTrainingSegmentation,
  observePreparedLanguageTrainingSegmentation,
  attachSourceDerivedLanguageAliases,
  CORPUS_SOURCE_SYSTEM_IDS,
  canonicalCorpusSourceSystemId,
  corpusNgramSettings,
  createCorpusRegistry,
  corpusRoleIdForSourceSystem,
  corpusSourceAlias,
  type CorpusRegistryOverride,
  joinInformationLabels,
  normalizeInformationLabel,
  toJsonValue,
  type Clock,
  type CompiledLanguageTrainingBatch,
  type CreativeEventConstructionCompiler,
  type EvidenceSpan,
  type IdFactory,
  type InformationLabel,
  type JsonValue,
  type LanguagePatternRecord,
  type LanguageProfile,
  type LanguageUnitRecord,
  type NgramModelRecord,
  type NgramObservation,
  type ScceStorage,
  type SemanticFrameRecord,
  type SourceAdmissionContext,
  type SourceAdmissionDecision,
  type SourceTrust,
  type SourceVersion,
  type SourceVersionId,
  type SourceBoundLanguageConstructionTrainingSet,
  type QuarantineSource,
  type ScceEvent,
  type PreparedLanguageTrainingSegmentation
} from "@scce/kernel";

export interface LanguageCorpusTrainingInput {
  storage: ScceStorage;
  sourceSystem: string;
  streamUri: string;
  text: string;
  sourceUri?: string;
  sourceVersionId?: SourceVersionId;
  evidence?: readonly EvidenceSpan[];
  profile?: LanguageProfile;
  mediaType?: string;
  namespace?: string;
  createdAt?: number;
  maxEvidenceChunkBytes?: number;
  ngramMaxOrder?: number;
  ngramMaxCountersPerOrder?: number;
  ngramVocabularyLimit?: number;
  /** Registry overrides, so a corpus can state its own n-gram limits instead of inheriting the defaults. */
  corpusRegistry?: readonly CorpusRegistryOverride[];
  /** How this lane declares its material to the admission controller. Defaults to the corpus's own declaration. */
  sourceAdmission?: SourceAdmissionContext;
  /** Where this material came from. Defaults to the corpus's own declaration; never inferred from the text. */
  sourceKind?: string;
  corpusMetadata?: JsonValue;
  languageAliases?: readonly string[];
  constructionSets?: readonly SourceBoundLanguageConstructionTrainingSet[];
  creativeEventCompiler?: CreativeEventConstructionCompiler;
  /** Source versions this text came from; their promoted evidence is what the batch's graph slice is read from. */
  graphSnapshotSourceVersionIds?: readonly string[];
  /** Character ranges of the concatenated text and the source family each belongs to. */
  sourceFamilyRanges?: readonly { start: number; end: number; sourceFamilyId: string }[];
  /** Alignment evidence carried from earlier batches: a construction is promoted on what the corpus shows, not one document. */
  alignmentPromotionObservations?: readonly AlignmentPromotionObservation[];
  alignmentCalibrationObservations?: readonly AlignmentCalibrationObservation[];
  languageOnly?: boolean;
  /**
   * Skip writing n-gram observations and models. For text whose n-gram
   * mass is ALREADY in the store (stored-corpus construction training
   * re-runs the language lane over previously-ingested articles),
   * re-inserting hundreds of thousands of observation rows per MB both
   * dominates wall time and double-counts the corpus. Constructions,
   * units, patterns, and frames still train and persist.
   */
  skipNgramPersistence?: boolean;
  /**
   * Skip the raw n-gram OBSERVATIONS while still writing the compiled models.
   *
   * The two are the same information in two forms, and nothing reads the raw one. Its only consumers are a
   * diagnostic summary and a hydration fallback for a scope with no persisted model -- and the comment on that
   * fallback records it returning 0 rows in 48 of 48 measured executions. Nothing learns from them either:
   * training reads evidence spans, which persist regardless.
   *
   * Writing them is what makes a corpus ingest decay. The ids are per shard, so the rows never collapse:
   * measured on a clean scce5 after 4,762 articles, 19,382,688 rows and 27GB, ~460,000 new rows per shard
   * inserted into a primary key that grew with every shard before it. Throughput went from 1,217 sources an
   * hour on the empty brain to 348 five hours later, and ngram.insert was 281s a shard at 93% database wait.
   */
  skipNgramObservationPersistence?: boolean;
  persistSource?: boolean;
  episodeId?: ReturnType<IdFactory["episodeId"]>;
  idFactory?: IdFactory;
  clock?: Clock;
  informationLabel?: InformationLabel;
}

export interface LanguageCorpusTrainingReport {
  schema: "scce.languageCorpusTrainingReport.v1";
  /** Source-derived provenance label retained for storage/query compatibility. */
  sourceSystem: string;
  /** Opaque deterministic identity used by cognition and internal joins. */
  sourceSystemId: string;
  streamUri: string;
  sourceVersionId: string;
  languageProfiles: number;
  evidence: number;
  ngramObservations: number;
  ngramModels: number;
  languageUnits: number;
  languagePatterns: number;
  semanticFrames: number;
  /** What the admission controller decided for this source version, or `unmeasured` when it had no declaration. */
  admission: { disposition: SourceAdmissionDecision["disposition"] | "unmeasured" | "not_applicable"; reasons: string[] };
  /** This batch's own alignment observations, so a caller can carry them into the next batch. */
  alignmentPromotionObservations: AlignmentPromotionObservation[];
  alignmentCalibrationObservations: AlignmentCalibrationObservation[];
  constructionCandidates: number;
  languageConstructions: number;
  graphSurfaceAlignments: number;
  rejectedLanguageConstructions: number;
  eventId: string;
  warnings: string[];
}

/** An opaque process-local preparation token; learned payloads remain private until the atomic commit. */
export interface PreparedLanguageCorpusTraining {
  readonly sourceVersionId: SourceVersionId;
  readonly inputBinding: string;
  readonly graphSnapshotDigest: string;
}

interface PreparedLanguageCorpusPayload {
  sourceSystem: string;
  sourceSystemId: string;
  sourceUri: string;
  namespace: string;
  sourceVersionId: SourceVersionId;
  text: string;
  bytes: Uint8Array;
  mediaType: string;
  source?: SourceVersion;
  quarantine?: QuarantineSource;
  profile: LanguageProfile;
  evidence: EvidenceSpan[];
  metadata: JsonValue;
  informationLabel: InformationLabel;
  admission: LanguageCorpusTrainingReport["admission"];
  createdAt: number;
  segmentation?: PreparedLanguageTrainingSegmentation;
  graphSnapshotDigest: string;
  compiledBatch: CompiledLanguageTrainingBatch;
  observations: NgramObservation[];
  models: NgramModelRecord[];
  units: LanguageUnitRecord[];
  patterns: LanguagePatternRecord[];
  frames: SemanticFrameRecord[];
  constructionWarnings: string[];
  languageConstructions: number;
  learned: ScceEvent;
}

const preparations = new WeakMap<PreparedLanguageCorpusTraining, {
  storage: ScceStorage;
  // The payload is needed for retry after a rolled-back commit, but retaining it after a successful
  // transaction keeps the full compiled batch alive while callers continue with alignment/promotion work.
  payload?: PreparedLanguageCorpusPayload;
  committed: boolean;
}>();

function preparationInputSnapshot(input: LanguageCorpusTrainingInput): LanguageCorpusTrainingInput {
  // Detach caller-owned semantic inputs before compilation. The output contains the compiled batch and can be
  // very large; cloning that output doubled peak memory, while these bounded input snapshots preserve the same
  // isolation and input-binding checks without retaining a second copy of learned rows.
  const clone = <T>(value: T): T => value === undefined ? value : structuredClone(value);
  return {
    ...input,
    evidence: clone(input.evidence),
    profile: clone(input.profile),
    corpusRegistry: clone(input.corpusRegistry),
    sourceAdmission: clone(input.sourceAdmission),
    corpusMetadata: clone(input.corpusMetadata),
    languageAliases: clone(input.languageAliases),
    constructionSets: clone(input.constructionSets),
    graphSnapshotSourceVersionIds: clone(input.graphSnapshotSourceVersionIds),
    sourceFamilyRanges: clone(input.sourceFamilyRanges),
    alignmentPromotionObservations: clone(input.alignmentPromotionObservations),
    alignmentCalibrationObservations: clone(input.alignmentCalibrationObservations),
    informationLabel: clone(input.informationLabel)
  };
}

function trainingInputBinding(input: LanguageCorpusTrainingInput): string {
  // These service objects are used only in preparation; actual output IDs/times are captured in the payload.
  const { storage: _storage, clock: _clock, idFactory: _ids, creativeEventCompiler: _compiler, ...semantic } = input;
  return createHasher().digestHex(canonicalStringify(toJsonValue(semantic)));
}

function graphSnapshotDigest(snapshot: Awaited<ReturnType<typeof graphSnapshotForEvidence>>): string {
  const ordered = <T extends { id: unknown }>(rows: readonly T[]) => [...rows].sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return createHasher().digestHex(canonicalStringify(toJsonValue(snapshot ? {
    nodes: ordered(snapshot.nodes), edges: ordered(snapshot.edges), hyperedges: ordered(snapshot.hyperedges)
  } : null)));
}

/** The promoted spans those source versions own, which is what the graph was projected from. Impure: reads storage. */
async function promotedEvidenceIdsForSourceVersions(
  storage: LanguageCorpusTrainingInput["storage"],
  sourceVersionIds: readonly string[]
): Promise<EvidenceSpan["id"][]> {
  const ids: EvidenceSpan["id"][] = [];
  if (typeof storage.evidence?.searchEvidence !== "function") return ids;
  for (const sourceVersionId of sourceVersionIds.slice(0, TRAINING_SNAPSHOT_SOURCES)) {
      const found = await storage.evidence.searchEvidence({
        sourceVersionId: sourceVersionId as EvidenceSpan["sourceVersionId"],
        status: "promoted",
        limit: TRAINING_SNAPSHOT_EVIDENCE
      });
      for (const item of found) ids.push(item.span.id);
    if (ids.length >= TRAINING_SNAPSHOT_EVIDENCE) break;
  }
  return [...new Set(ids)].slice(0, TRAINING_SNAPSHOT_EVIDENCE);
}

/** This batch's evidence as a graph snapshot, bounded so training stays inside its heap budget. Impure: reads storage. */
async function graphSnapshotForEvidence(
  storage: LanguageCorpusTrainingInput["storage"],
  evidence: readonly EvidenceSpan[],
  sourceVersionIds?: readonly string[]
): Promise<{ nodes: GraphNode[]; edges: GraphEdge[]; hyperedges: Hyperedge[] } | undefined> {
  // A lane that re-chunks stored text mints new spans, and the graph was projected from the original ingestion's
  // spans, so their ids never meet. When the caller names the source versions the text came from, the slice is
  // read from those versions' own promoted evidence instead.
  const evidenceIds = sourceVersionIds?.length
    ? await promotedEvidenceIdsForSourceVersions(storage, sourceVersionIds)
    : [...new Set(evidence.map(span => span.id))].slice(0, TRAINING_SNAPSHOT_EVIDENCE);
  if (!evidenceIds.length || typeof storage.graph?.getSlice !== "function") return undefined;
    const slice = await storage.graph.getSlice({
      evidenceIds,
      limitNodes: TRAINING_SNAPSHOT_NODES,
      limitEdges: TRAINING_SNAPSHOT_EDGES
    });
    // Constructions align surfaces to promoted structured relations, never to chunk feature bags.
    const hyperedges = slice.hyperedges.filter(edge => {
      const modality = edge.modality;
      return typeof modality === "object" && modality !== null && !Array.isArray(modality)
        && typeof (modality as Record<string, unknown>).extractionChannel === "string";
    });
    if (!hyperedges.length) return undefined;
    // Storage adapters may return caller-owned objects. Keep the bounded snapshot detached so
    // compilation cannot retain or mutate the adapter's graph slice after this read.
    return {
      nodes: structuredClone(slice.nodes),
      edges: structuredClone(slice.edges),
      hyperedges: structuredClone(hyperedges)
    };
}

/** The compact Kneser-Ney summary's most-continued symbols, narrowed for a page signature. Mirrors the wiki path. */
function trainerProfileTopContinuation(kneserNey: unknown): Array<[string, number]> {
  const top = (kneserNey as { topContinuation?: unknown } | undefined)?.topContinuation;
  if (!Array.isArray(top)) return [];
  return top
    .filter((pair): pair is [string, number] => Array.isArray(pair) && typeof pair[0] === "string" && typeof pair[1] === "number")
    .map(pair => [pair[0], pair[1]]);
}

const TRAINING_SNAPSHOT_EVIDENCE = 64;
const TRAINING_SNAPSHOT_SOURCES = 8;
const TRAINING_SNAPSHOT_NODES = 512;
const TRAINING_SNAPSHOT_EDGES = 1024;

export async function trainLanguageCorpusText(input: LanguageCorpusTrainingInput): Promise<LanguageCorpusTrainingReport> {
  // Both source-owning and aggregate callers get an atomic learned write. CPU compilation precedes it.
  const prepared = await prepareLanguageCorpusTraining(input);
  return commitLanguageCorpusTraining(input, prepared);
}

export async function prepareLanguageCorpusTraining(input: LanguageCorpusTrainingInput): Promise<PreparedLanguageCorpusTraining> {
  const inputBinding = trainingInputBinding(input);
  const payload = await prepareLanguageCorpusTrainingInternal(preparationInputSnapshot(input));
  if (trainingInputBinding(input) !== inputBinding) throw new Error("language training input changed during preparation");
  const token = Object.freeze({ sourceVersionId: payload.sourceVersionId, inputBinding, graphSnapshotDigest: payload.graphSnapshotDigest });
  preparations.set(token, { storage: input.storage, payload, committed: false });
  return token;
}

export async function commitLanguageCorpusTraining(
  input: LanguageCorpusTrainingInput,
  prepared: PreparedLanguageCorpusTraining
): Promise<LanguageCorpusTrainingReport> {
  const held = preparations.get(prepared);
  if (!held || held.storage !== input.storage) throw new Error("unrecognized language training preparation or storage");
  if (held.committed) throw new Error("language training preparation already committed or in progress");
  if (trainingInputBinding(input) !== prepared.inputBinding) throw new Error("language training input changed before commit");
  held.committed = true;
  try {
    const payload = held.payload;
    if (!payload) throw new Error("prepared language training payload was released before commit");
    const result = await input.storage.transaction(async () => {
      const snapshot = await graphSnapshotForEvidence(input.storage, payload.evidence, input.graphSnapshotSourceVersionIds);
      if (graphSnapshotDigest(snapshot) !== prepared.graphSnapshotDigest) throw new Error("language training graph dependencies changed before commit; prepare again");
      if (trainingInputBinding(input) !== prepared.inputBinding) throw new Error("language training input changed during commit validation");
      return commitLanguageCorpusTrainingInternal(input, payload);
    });
    // Keep only the committed tombstone so a second use still reports "already committed" without retaining
    // the cloned observations/models/compiled alignment payload through the caller's subsequent work.
    held.payload = undefined;
    return result;
  } catch (error) { held.committed = false; throw error; }
}

/** The source version this text is stored under, so a later pass can find its evidence without re-training it. */
export function corpusSourceVersionIdFor(input: { sourceUri: string; text: string }): SourceVersionId {
  const hasher = createHasher();
  const text = input.text.replace(/\u0000/g, " ").normalize("NFC");
  return createIdFactory({ clock: createClock(), hasher })
    .sourceVersionId(`${input.sourceUri}${hasher.digestHex(Buffer.from(text, "utf8"))}`);
}

async function prepareLanguageCorpusTrainingInternal(input: LanguageCorpusTrainingInput): Promise<PreparedLanguageCorpusPayload> {
  const clock = input.clock ?? createClock();
  const hasher = createHasher();
  const sourceSystemId = canonicalCorpusSourceSystemId(input.sourceSystem);
  // Per-corpus n-gram limits, from the registry that carries them, whenever the caller did not state its own.
  //
  // The registry has held maxOrder, maxCountersPerOrder and vocabularyLimit per source system since it was
  // written and `corpusNgramSettings` is the accessor for them; nothing called it, so every corpus trained on
  // whatever global default sat downstream regardless of what the registry said about it. An explicit argument
  // still wins, so no existing caller changes behaviour.
  const registryNgram = corpusNgramSettings(createCorpusRegistry(input.corpusRegistry ?? []), sourceSystemId);
  const sourceInformationLabel = normalizeInformationLabel(
    input.informationLabel ?? verifiedPublicCorpusLabel(sourceSystemId)
  );
  const sourceSystem = corpusSourceAlias(input.sourceSystem);
  const ids = input.idFactory ?? createIdFactory({ clock, hasher, namespace: `corpus-${hasher.digestHex(sourceSystemId).slice(0, 12)}` });
  const events = createEventFactory({ idFactory: ids, clock, hasher });
  const language = createLanguageAcquisitionEngine({ idFactory: ids });
  const languageMemory = createLanguageMemoryRuntime({ idFactory: ids, hasher });
  const sourceUri = input.sourceUri ?? input.streamUri;
  const namespace = input.namespace ?? `corpus:${sourceSystemId}`;
  const createdAt = input.createdAt ?? clock.now();
  const text = input.text.replace(/\u0000/g, " ").normalize("NFC");
  const bytes = Buffer.from(text, "utf8");
  const sourceVersionId = input.sourceVersionId ?? corpusSourceVersionIdFor({ sourceUri, text });
  const sourceId = ids.sourceId(namespace, sourceUri);
  let profile: LanguageProfile = {
    ...(input.profile ?? language.acquire({ sourceVersionId, text, createdAt })),
    informationLabel: sourceInformationLabel
  };
  const metadata = toJsonValue({
    ...jsonRecord(input.corpusMetadata),
    ...(input.languageAliases?.length ? { languageAliases: [...input.languageAliases] } : {}),
    sourceSystem,
    sourceSystemId,
    sourceUri,
    streamUri: input.streamUri,
    provenanceClass: "learned_language_prior"
  });

  let evidence = [...(input.evidence ?? [])];
  let source: SourceVersion | undefined;
  let quarantine: QuarantineSource | undefined;
  let admission: LanguageCorpusTrainingReport["admission"] = { disposition: "not_applicable", reasons: ["this lane persists no source version of its own"] };
  if (!evidence.length && input.persistSource !== false) {
    const extractor = createEvidenceExtractor({ idFactory: ids, hasher });
    const mediaType = input.mediaType ?? "text/plain";
    // Source-version and evidence rows are FK-bound to canonical blob hashes.
    // Persist those blobs before inserting either referencing record.
    const contentHash = blobContentHash(bytes);
    source = {
      sourceId,
      sourceVersionId,
      namespace,
      canonicalUri: sourceUri,
      contentHash,
      mediaType,
      observedAt: createdAt,
      byteLength: bytes.byteLength,
      sourceTrust: corpusSourceTrust(sourceSystemId),
      informationLabel: sourceInformationLabel,
      metadata
    };
    const extracted = extractor.extract({
      sourceId,
      sourceVersionId,
      namespace,
      uri: sourceUri,
      mediaType,
      text,
      languageProfile: profile,
      sourceTrust: source.sourceTrust,
      observedAt: createdAt,
      maxChunkBytes: input.maxEvidenceChunkBytes ?? 64 * 1024,
      metadata,
      exactSourceText: true
    });
    // Law 1: the corpus lanes stamped `promoted` outright and never consulted the controller, so 1,154 live source
    // versions carry a promotion nobody decided. A corpus with no declaration is `unmeasured`, which is neither.
    const context = input.sourceAdmission ?? corpusAdmissionContext(sourceSystemId);
    const decision = context
      ? createSourceAdmissionController().decide({
        source,
        evidence: extracted.spans,
        context,
        // Diagnostic trust is otherwise computed from defaults, which is an unmeasured value deciding an admission.
        metadata: toJsonValue({ ...jsonRecord(metadata), diagnostics: extractorDiagnostics(input.text, text) })
      })
      : undefined;
    const audit = decision?.audit ?? toJsonValue({
      sourceVersionId, namespace, sourceSystemId,
      disposition: "unmeasured",
      reasons: [`no admission context is declared for corpus source system ${sourceSystem}`]
    });
    admission = {
      disposition: decision?.disposition ?? "unmeasured",
      reasons: decision?.reasons ?? [`no admission context is declared for corpus source system ${sourceSystem}`]
    };
    quarantine = {
      id: `${sourceVersionId}:admission`,
      sourceId,
      sourceVersionId,
      uri: sourceUri,
      contentHash,
      mediaType,
      fetchedAt: createdAt,
      trustVector: audit,
      permissionVector: toJsonValue({
        disposition: admission.disposition,
        sourceAdmission: context ? toJsonValue({ ...context }) : null,
        activeInfluence: decision ? toJsonValue({ ...decision.activeInfluence }) : null,
        safetyRails: decision?.safetyRails ?? []
      }),
      decision: admission.disposition === "reject" ? "rejected" : admission.disposition === "promote" ? "promoted" : "pending",
      decisionJson: audit
    };
    if (admission.disposition === "reject") {
      throw new Error(`corpus source rejected at admission: ${admission.reasons.join("; ")}`);
    }
    const actionByEvidence = new Map((decision?.evidenceActions ?? []).map(action => [action.evidenceId, action]));
    evidence = stampEvidence(extracted.spans, {
      sourceSystem,
      sourceSystemId,
      metadata,
      sourceKind: input.sourceKind ?? corpusSourceKind(sourceSystemId),
      status: admission.disposition === "promote" ? "promoted" : "quarantined",
      audit,
      actionByEvidence
    })
      .map(span => ({ ...span, informationLabel: sourceInformationLabel }))
      .map(span => withSourceFamily(span, input.sourceFamilyRanges));
  }

  if (evidence.some(span => !span.informationLabel)) {
    throw new Error("language corpus evidence requires information labels");
  }
  const informationLabel = joinInformationLabels(
    [sourceInformationLabel, ...evidence.map(span => span.informationLabel!)],
    { explicitMergeAuthority: false }
  );
  evidence = evidence.map(span => ({ ...span, informationLabel }));
  profile = attachSourceDerivedLanguageAliases({ profile, metadata, evidence });
  profile = { ...profile, informationLabel };
  // Identity discovery counts documents. A document-owning training call (a book, a source file, a dialogue
  // transcript -- anything that persists its own source) is one document and joins the closed-class population,
  // exactly as a wiki page does. The wiki SHARD trainer passes persistSource=false: its pages already have
  // signatures from the ingestor, and a shard is an aggregate, not a document, so it must not be counted again.
  // The construction lane compiles nothing without the graph its surfaces align to: alignment lattices are
  // built only when the batch carries hyperedges, so with no snapshot every run produced zero reversible
  // constructions and the mouth had no learned sentence shapes to speak with. The snapshot is this batch's own
  // evidence, read back from the graph the same evidence was projected into.
  const trainTrace = ingestStageTracer();
  const snapshotSpan = trainTrace.span("train.graph-snapshot");
  const batchGraphSnapshot = await graphSnapshotForEvidence(input.storage, evidence, input.graphSnapshotSourceVersionIds);
  snapshotSpan.end({
    nodes: batchGraphSnapshot?.nodes.length ?? 0,
    edges: batchGraphSnapshot?.edges.length ?? 0,
    hyperedges: batchGraphSnapshot?.hyperedges.length ?? 0,
    evidence: evidence.length
  });

  // Pure CPU compilation runs before the write transaction in the ordinary and Wikipedia callers.
  const compileSpan = trainTrace.span("train.compile");
  const compiledBatch = compileLanguageTrainingBatch({
    runtime: languageMemory,
    hasher,
    batch: {
      streamId: input.streamUri,
      ...(batchGraphSnapshot ? { graphSnapshot: batchGraphSnapshot } : {}),
      sourceSystem,
      profile,
      sourceVersionId,
      text,
      evidence,
      createdAt,
      maxOrder: input.ngramMaxOrder ?? registryNgram.maxOrder,
      maxCountersPerOrder: input.ngramMaxCountersPerOrder ?? registryNgram.maxCountersPerOrder,
      vocabularyLimit: input.ngramVocabularyLimit ?? registryNgram.vocabularyLimit,
      constructionSets: input.constructionSets,
      ...(input.languageOnly ? { languageOnly: true } : {}),
      ...(input.alignmentPromotionObservations?.length ? { alignmentPromotionObservations: input.alignmentPromotionObservations } : {}),
      ...(input.alignmentCalibrationObservations?.length ? { alignmentCalibrationObservations: input.alignmentCalibrationObservations } : {})
    }
  });
  compileSpan.end({
    observations: compiledBatch.observations.length,
    models: compiledBatch.models.length,
    units: compiledBatch.units.length,
    patterns: compiledBatch.patterns.length,
    semanticFrames: compiledBatch.semanticFrames.length,
    alignmentSupports: compiledBatch.sparseAlignmentCandidateSupports.length
  });
  const observations = input.skipNgramPersistence || input.skipNgramObservationPersistence
    ? []
    : compiledBatch.observations.map(item => ({ ...stampObservation(item, sourceSystem, sourceSystemId, metadata), informationLabel }));
  const models = input.skipNgramPersistence
    ? []
    : compiledBatch.models.map(item => ({ ...stampModel(item, sourceSystem, sourceSystemId, metadata), informationLabel }));
  const units = compiledBatch.units.map(item => ({ ...stampUnit(item, sourceSystem, sourceSystemId, metadata), informationLabel }));
  const compiledConstructionPatterns: LanguagePatternRecord[] = [...compiledBatch.constructionPatterns];
  const constructionWarnings: string[] = [...compiledBatch.warnings];
  if (input.creativeEventCompiler) {
    const creativeEventCompilation = input.creativeEventCompiler.compile({
      profileId: profile.id,
      evidence,
      hasher,
      updatedAt: createdAt
    });
    if (creativeEventCompilation.status === "compiled") {
      // The compiler is an adapter-owned service and may return a mutable pattern object. Detach just this
      // small result; cloning the entire compiled batch here was the memory-retention regression this path avoids.
      compiledConstructionPatterns.push(structuredClone(creativeEventCompilation.pattern));
    } else if (creativeEventCompilation.issues.some(issue =>
      issue.code !== "surface.construction_memory.reject.induction")) {
      constructionWarnings.push(...creativeEventCompilation.issues.map(issue => issue.code));
    }
  }
  const patterns = [
    ...compiledBatch.patterns.filter(pattern => !compiledConstructionPatterns.some(item => item.id === pattern.id)),
    ...compiledConstructionPatterns
  ]
    .map(item => ({ ...stampPattern(item, sourceSystem, sourceSystemId, metadata), informationLabel }));
  const frames = compiledBatch.semanticFrames.map(item => ({ ...stampFrame(item, sourceSystem, sourceSystemId, metadata), informationLabel }));

  const activeImportVersionValue = jsonRecord(input.corpusMetadata).activeImportVersion;
  const segmentation = prepareLanguageTrainingSegmentation({
    batch: { text, createdAt },
    tenantId: informationLabel.tenantId,
    corpusRole: corpusRoleIdForSourceSystem(sourceSystemId),
    activeImportVersion: typeof activeImportVersionValue === "string" ? activeImportVersionValue : sourceSystemId,
    hasher
  });

  const learned = events.create({
    episodeId: input.episodeId ?? ids.episodeId(),
    typeId: "SymbolPatternLearned",
    payload: {
      ...jsonRecord(compiledBatch.audit),
      sourceSystem,
      sourceSystemId,
      streamUri: input.streamUri,
      sourceUri,
      sourceVersionId,
      evidence: evidence.length,
      constructionCandidates: compiledBatch.constructionCandidates,
      languageConstructions: compiledConstructionPatterns.length,
      graphSurfaceAlignments: compiledBatch.graphSurfaceAlignmentSummaries,
      rejectedLanguageConstructions: compiledBatch.rejectedConstructionCandidates,
      constructionPromotion: compiledBatch.constructionPromotion as unknown as JsonValue,
      corpusMetadata: metadata
    }
  });
  return {
    sourceSystem,
    sourceSystemId,
    sourceUri,
    namespace,
    sourceVersionId,
    text,
    bytes,
    mediaType: input.mediaType ?? "text/plain",
    source,
    quarantine,
    profile,
    evidence,
    metadata,
    informationLabel,
    admission,
    createdAt,
    segmentation,
    graphSnapshotDigest: graphSnapshotDigest(batchGraphSnapshot),
    compiledBatch,
    observations,
    models,
    units,
    patterns,
    frames,
    constructionWarnings,
    languageConstructions: compiledConstructionPatterns.length,
    learned
  };
}

async function commitLanguageCorpusTrainingInternal(input: LanguageCorpusTrainingInput, prepared: PreparedLanguageCorpusPayload): Promise<LanguageCorpusTrainingReport> {
  if (prepared.source && prepared.quarantine) {
    const persistedHash = await input.storage.blobs.put(prepared.bytes, prepared.mediaType);
    if (persistedHash !== prepared.source.contentHash) throw new Error("language training source blob hash mismatch");
    await input.storage.quarantine.put(prepared.quarantine);
    await putSpanBlobs(input.storage.blobs, prepared.evidence, prepared.mediaType);
    await input.storage.evidence.putSourceVersion(prepared.source);
    if (input.storage.evidence.putEvidenceSpans) await input.storage.evidence.putEvidenceSpans(prepared.evidence);
    else for (const span of prepared.evidence) await input.storage.evidence.putEvidenceSpan(span);
  }

  await input.storage.model.putLanguageProfile(prepared.profile);
  if (input.persistSource !== false && input.storage.languageIdentities?.putProfileSignatures) {
    await input.storage.languageIdentities.putProfileSignatures({
      informationLabel: prepared.informationLabel,
      rows: [{
        id: prepared.profile.id,
        sourceVersionId: prepared.sourceVersionId,
        sourceSystem: input.sourceSystem,
        sourceUri: input.sourceUri ?? "",
        scripts: (prepared.profile.scripts ?? []).map(row => ({ script: row.script, mass: row.mass })),
        direction: prepared.profile.direction,
        topContinuation: trainerProfileTopContinuation(prepared.profile.kneserNey)
      }]
    });
  }

  const trainTrace = ingestStageTracer();
  const segmentationSpan = trainTrace.span("train.segmentation");
  if (prepared.segmentation) {
    await observePreparedLanguageTrainingSegmentation({ storage: input.storage, prepared: prepared.segmentation });
  }
  segmentationSpan.end();

  const persistSpan = trainTrace.span("train.persist");
  await input.storage.languageMemory.putNgramObservationsBatch(prepared.observations);
  if (input.storage.languageMemory.putNgramModels) await input.storage.languageMemory.putNgramModels(prepared.models);
  else for (const model of prepared.models) await input.storage.languageMemory.putNgramModel(model);
  if (input.storage.languageMemory.putLanguageUnits) await input.storage.languageMemory.putLanguageUnits(prepared.units);
  else for (const unit of prepared.units) await input.storage.languageMemory.putLanguageUnit(unit);
  if (input.storage.languageMemory.putLanguagePatterns) await input.storage.languageMemory.putLanguagePatterns(prepared.patterns);
  else for (const pattern of prepared.patterns) await input.storage.languageMemory.putLanguagePattern(pattern);
  if (input.storage.languageMemory.putSemanticFrames) await input.storage.languageMemory.putSemanticFrames(prepared.frames);
  else for (const frame of prepared.frames) await input.storage.languageMemory.putSemanticFrame(frame);
  await input.storage.events.append(prepared.learned);
  persistSpan.end({
    observations: prepared.observations.length,
    models: prepared.models.length,
    units: prepared.units.length,
    patterns: prepared.patterns.length,
    frames: prepared.frames.length
  });

  return {
    schema: "scce.languageCorpusTrainingReport.v1",
    sourceSystem: prepared.sourceSystem,
    sourceSystemId: prepared.sourceSystemId,
    streamUri: input.streamUri,
    sourceVersionId: prepared.sourceVersionId,
    languageProfiles: 1,
    evidence: prepared.evidence.length,
    ngramObservations: prepared.observations.length,
    ngramModels: prepared.models.length,
    languageUnits: prepared.units.length,
    languagePatterns: prepared.patterns.length,
    semanticFrames: prepared.frames.length,
    admission: prepared.admission,
    alignmentPromotionObservations: [...prepared.compiledBatch.alignmentHeldoutEvaluation.promotionObservations],
    alignmentCalibrationObservations: [...prepared.compiledBatch.alignmentHeldoutEvaluation.calibrationObservations],
    constructionCandidates: prepared.compiledBatch.constructionCandidates,
    languageConstructions: prepared.languageConstructions,
    graphSurfaceAlignments: prepared.compiledBatch.graphSurfaceAlignmentSummaries.length,
    rejectedLanguageConstructions: prepared.compiledBatch.rejectedConstructionCandidates,
    eventId: String(prepared.learned.id),
    warnings: [...new Set(prepared.constructionWarnings)].sort()
  };
}

/** Independence is measured over source families, so a span keeps the family of the document it came from
 *  rather than the batch that happened to carry it. Pure. */
function withSourceFamily(
  span: EvidenceSpan,
  ranges: readonly { start: number; end: number; sourceFamilyId: string }[] | undefined
): EvidenceSpan {
  if (!ranges?.length) return span;
  const found = ranges.find(range => span.charStart >= range.start && span.charStart < range.end);
  if (!found) return span;
  const provenance = span.provenance && typeof span.provenance === "object" && !Array.isArray(span.provenance)
    ? span.provenance as Record<string, JsonValue>
    : {};
  return { ...span, provenance: { ...provenance, sourceFamilyId: found.sourceFamilyId } };
}

/** What each corpus declares itself to be at admission; the same declaration the registry already carries, in the
 *  controller's vocabulary. An undeclared corpus returns undefined, which is `unmeasured`, not a promotion. Pure. */
function corpusAdmissionContext(sourceSystemId: string): SourceAdmissionContext | undefined {
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.wikipedia
    || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.gutenberg
    || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossDocs
    || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossCode) {
    return { sourceClass: "trusted_corpus", intendedUse: "learned_prior", promotionAuthority: "training" };
  }
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.dialogue
    || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.corrections
    || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.workspace) {
    return { sourceClass: "owner_local", intendedUse: "learned_prior", promotionAuthority: "owner" };
  }
  return undefined;
}

/** Where a corpus's material came from, in the vocabulary ingestion-lanes already declares. Pure. */
function corpusSourceKind(sourceSystemId: string): string {
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.wikipedia) return "wikimedia_dump";
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.gutenberg) return "gutenberg_mirror";
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossDocs || sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.ossCode) return "developer_intelligence";
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.dialogue) return "local_corpus";
  if (sourceSystemId === CORPUS_SOURCE_SYSTEM_IDS.workspace) return "local_engineering_corpus";
  return "unknown";
}

/** The extractor facts this lane can actually measure, so diagnostic trust is not computed from defaults. Pure. */
function extractorDiagnostics(rawText: string, normalizedText: string): JsonValue {
  let nulCount = 0;
  for (let index = 0; index < rawText.length; index += 1) if (rawText.charCodeAt(index) === 0) nulCount += 1;
  return toJsonValue({
    charLength: [...normalizedText].length,
    // One extractor ran over this text; this is a count of what happened, not a tuned parameter.
    parserCount: 1,
    binaryRatio: rawText.length ? nulCount / rawText.length : 0,
    missingPreconditions: [],
    warnings: []
  });
}

function stampEvidence(spans: readonly EvidenceSpan[], stamp: {
  sourceSystem: string;
  sourceSystemId: string;
  metadata: JsonValue;
  sourceKind: string;
  status: EvidenceSpan["status"];
  audit: JsonValue;
  actionByEvidence: Map<string, { action: string; alpha: number }>;
}): EvidenceSpan[] {
  const { sourceSystem, sourceSystemId, metadata, sourceKind, status, audit } = stamp;
  return spans.map(span => {
    const action = stamp.actionByEvidence.get(String(span.id));
    return {
      ...span,
      status,
      alpha: action?.action === "lower-alpha" ? Math.min(span.alpha, action.alpha) : span.alpha,
      // Source kind names where the material came from. Every lane through this trainer used to say
      // construction_training, so a repository file arrived labelled as derived training residue.
      provenance: toJsonValue({ ...jsonRecord(span.provenance), ...jsonRecord(metadata), sourceSystem, sourceSystemId, sourceKind, forceClass: "profile_excerpt_evidence" }),
      trustVector: toJsonValue({ ...jsonRecord(span.trustVector), sourceSystem, sourceSystemId, forceClass: "profile_excerpt_evidence", sourceTrust: corpusSourceTrust(sourceSystemId), admission: audit, action: action?.action ?? "quarantine" })
    };
  });
}

function stampObservation(observation: NgramObservation, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): NgramObservation {
  const observationMetadata = jsonRecord(observation.metadata);
  const corpusMetadata = jsonRecord(metadata);
  return {
    ...observation,
    metadata: toJsonValue({
      ...(observationMetadata.profileId !== undefined ? { profileId: observationMetadata.profileId } : {}),
      sourceSystem,
      sourceSystemId,
      provenanceClass: corpusMetadata.provenanceClass ?? "learned_language_prior",
      forceClass: "learned_language_prior",
      ...(observationMetadata.error !== undefined ? { error: observationMetadata.error } : {}),
      ...(observationMetadata.approximate !== undefined ? { approximate: observationMetadata.approximate } : {})
    })
  };
}

function stampModel(model: NgramModelRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): NgramModelRecord {
  return { ...model, modelJson: toJsonValue({ ...jsonRecord(model.modelJson), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function stampUnit(unit: LanguageUnitRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): LanguageUnitRecord {
  return { ...unit, metadata: toJsonValue({ ...jsonRecord(unit.metadata), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

/** The provenance every persisted pattern carries, which is also what the role-scoped hydration query matches on. */
export function stampPattern(pattern: LanguagePatternRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): LanguagePatternRecord {
  return { ...pattern, patternJson: toJsonValue({ ...jsonRecord(pattern.patternJson), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function stampFrame(frame: SemanticFrameRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): SemanticFrameRecord {
  return { ...frame, frameJson: toJsonValue({ ...jsonRecord(frame.frameJson), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function corpusSourceTrust(sourceSystem: string): SourceTrust {
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.wikipedia) return {
    identity: 0.98, integrity: 1, parserReliability: 0.92, directness: 0.84,
    authority: 0.88, freshness: 0.68, independenceGroup: "wikimedia:wikipedia",
    accessScope: "public", licenseStatus: "licensed"
  };
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.workspace) return {
    identity: 1, integrity: 1, parserReliability: 0.94, directness: 1,
    authority: 1, freshness: 0.98, independenceGroup: "owner:workspace",
    accessScope: "owner_private", licenseStatus: "owner_authorized"
  };
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.corrections) return {
    identity: 1, integrity: 1, parserReliability: 1, directness: 1,
    authority: 1, freshness: 1, independenceGroup: "owner:corrections",
    accessScope: "owner_private", licenseStatus: "owner_authorized"
  };
  // Human-authored dialogue: direct and owner-authorized like corrections, but never a factual authority.
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.dialogue) return {
    identity: 1, integrity: 1, parserReliability: 1, directness: 1,
    authority: 0, freshness: 1, independenceGroup: "owner:dialogue",
    accessScope: "owner_private", licenseStatus: "owner_authorized"
  };
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossDocs) return {
    identity: 0.9, integrity: 1, parserReliability: 0.9, directness: 0.82,
    authority: 0.76, freshness: 0.72, independenceGroup: "corpus:oss-docs",
    accessScope: "public", licenseStatus: "licensed"
  };
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossCode) return {
    identity: 0.9, integrity: 1, parserReliability: 0.94, directness: 0.9,
    authority: 0.72, freshness: 0.72, independenceGroup: "corpus:oss-code",
    accessScope: "public", licenseStatus: "licensed"
  };
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.gutenberg) return {
    identity: 0.96, integrity: 1, parserReliability: 0.88, directness: 0.72,
    authority: 0.7, freshness: 0.2, independenceGroup: "corpus:gutenberg",
    accessScope: "public", licenseStatus: "public_domain"
  };
  return {
    identity: 0.5, integrity: 1, parserReliability: 0.7, directness: 0.5,
    authority: 0.4, freshness: 0.5, independenceGroup: `corpus:${sourceSystem}`,
    accessScope: "unknown", licenseStatus: "unknown"
  };
}

function verifiedPublicCorpusLabel(sourceSystem: string): InformationLabel {
  if (sourceSystem !== CORPUS_SOURCE_SYSTEM_IDS.wikipedia && sourceSystem !== CORPUS_SOURCE_SYSTEM_IDS.gutenberg) {
    throw new Error(`language corpus ${sourceSystem} requires an explicit information label`);
  }
  return {
    tenantId: "scce.public.corpus",
    principals: [],
    compartments: [],
    exportClass: "public",
    mergePolicy: "same_owner"
  };
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}
