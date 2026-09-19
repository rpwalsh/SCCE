// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { AlignmentCalibrationObservation, AlignmentPromotionObservation, GraphEdge, GraphNode, Hyperedge } from "@scce/kernel";
import { ingestStageTracer } from "./ingest-stage-trace-sink.js";
import {
  createClock,
  createEventFactory,
  createEvidenceExtractor,
  putSpanBlobs,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime,
  createSourceAdmissionController,
  compileLanguageTrainingBatch,
  observeLanguageTrainingSegmentation,
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
  type SourceBoundLanguageConstructionTrainingSet
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

/** The promoted spans those source versions own, which is what the graph was projected from. Impure: reads storage. */
async function promotedEvidenceIdsForSourceVersions(
  storage: LanguageCorpusTrainingInput["storage"],
  sourceVersionIds: readonly string[]
): Promise<EvidenceSpan["id"][]> {
  const ids: EvidenceSpan["id"][] = [];
  for (const sourceVersionId of sourceVersionIds.slice(0, TRAINING_SNAPSHOT_SOURCES)) {
    try {
      const found = await storage.evidence.searchEvidence({
        sourceVersionId: sourceVersionId as EvidenceSpan["sourceVersionId"],
        status: "promoted",
        limit: TRAINING_SNAPSHOT_EVIDENCE
      });
      for (const item of found) ids.push(item.span.id);
    } catch { /* a lane without this lookup simply trains without a snapshot */ }
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
  if (!evidenceIds.length) return undefined;
  try {
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
    return { nodes: slice.nodes, edges: slice.edges, hyperedges };
  } catch {
    return undefined;
  }
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
  // A shard trainer holds no source rows of its own, and its compile is minutes of pure CPU. Measured on one
  // 6-page shard: language.train 88.7s, of which train.compile is 54.5s at 116% CPU (58,264 n-gram observations
  // from 291KB of text) and train.persist is 33.3s at 12% CPU. Wrapping all of that in one transaction kept a
  // Postgres backend in `idle in transaction` for the whole compile -- which is what the multi-minute ingest
  // stalls were, and none of it is a transactional requirement:
  //
  //   - with persistSource false the source/blob/evidence writes are skipped entirely, so there is no
  //     multi-row source identity to make atomic;
  //   - nothing inside reads back what it wrote, so no statement depends on another's uncommitted state;
  //   - every write is keyed by a stable content-derived id, so re-running the shard rewrites the same rows,
  //     and the shard's checkpoint is not marked complete until this returns.
  //
  // So this path commits per statement instead, and the compile holds nothing. The document-owning path still
  // needs its source version and evidence spans to land together, and keeps the transaction.
  if (input.persistSource === false) return trainLanguageCorpusTextTransaction(input);
  return input.storage.transaction(() => trainLanguageCorpusTextTransaction(input));
}

/** The source version this text is stored under, so a later pass can find its evidence without re-training it. */
export function corpusSourceVersionIdFor(input: { sourceUri: string; text: string }): SourceVersionId {
  const hasher = createHasher();
  const text = input.text.replace(/\u0000/g, " ").normalize("NFC");
  return createIdFactory({ clock: createClock(), hasher })
    .sourceVersionId(`${input.sourceUri}${hasher.digestHex(Buffer.from(text, "utf8"))}`);
}

async function trainLanguageCorpusTextTransaction(input: LanguageCorpusTrainingInput): Promise<LanguageCorpusTrainingReport> {
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
  let admission: LanguageCorpusTrainingReport["admission"] = { disposition: "not_applicable", reasons: ["this lane persists no source version of its own"] };
  if (!evidence.length && input.persistSource !== false) {
    const extractor = createEvidenceExtractor({ idFactory: ids, hasher });
    const mediaType = input.mediaType ?? "text/plain";
    // Source-version and evidence rows are FK-bound to canonical blob hashes.
    // Persist those blobs before inserting either referencing record.
    const contentHash = await input.storage.blobs.put(bytes, mediaType);
    const source: SourceVersion = {
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
    await input.storage.quarantine.put({
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
    });
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
    await putSpanBlobs(input.storage.blobs, evidence, mediaType);
    await input.storage.evidence.putSourceVersion(source);
    if (input.storage.evidence.putEvidenceSpans) await input.storage.evidence.putEvidenceSpans(evidence);
    else for (const span of evidence) await input.storage.evidence.putEvidenceSpan(span);
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
  await input.storage.model.putLanguageProfile(profile);

  // Identity discovery counts documents. A document-owning training call (a book, a source file, a dialogue
  // transcript -- anything that persists its own source) is one document and joins the closed-class population,
  // exactly as a wiki page does. The wiki SHARD trainer passes persistSource=false: its pages already have
  // signatures from the ingestor, and a shard is an aggregate, not a document, so it must not be counted again.
  if (input.persistSource !== false && input.storage.languageIdentities?.putProfileSignatures) {
    await input.storage.languageIdentities.putProfileSignatures({
      informationLabel,
      rows: [{
        id: profile.id,
        sourceVersionId,
        sourceSystem: input.sourceSystem,
        sourceUri: input.sourceUri ?? "",
        scripts: (profile.scripts ?? []).map(row => ({ script: row.script, mass: row.mass })),
        direction: profile.direction,
        topContinuation: trainerProfileTopContinuation(profile.kneserNey)
      }]
    });
  }

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

  // Synchronous CPU, with a Postgres transaction held open around it. Timed because that is the whole question.
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
  const activeImportVersionValue = jsonRecord(input.corpusMetadata).activeImportVersion;
  const segmentationSpan = trainTrace.span("train.segmentation");
  await observeLanguageTrainingSegmentation({
    storage: input.storage,
    batch: { text, createdAt },
    tenantId: informationLabel.tenantId,
    corpusRole: corpusRoleIdForSourceSystem(sourceSystemId),
    activeImportVersion: typeof activeImportVersionValue === "string"
      ? activeImportVersionValue
      : sourceSystemId,
    hasher
  });

  const observations = input.skipNgramPersistence
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
      compiledConstructionPatterns.push(creativeEventCompilation.pattern);
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

  segmentationSpan.end();
  const persistSpan = trainTrace.span("train.persist");
  await input.storage.languageMemory.putNgramObservationsBatch(observations);
  if (input.storage.languageMemory.putNgramModels) await input.storage.languageMemory.putNgramModels(models);
  else for (const model of models) await input.storage.languageMemory.putNgramModel(model);
  if (input.storage.languageMemory.putLanguageUnits) await input.storage.languageMemory.putLanguageUnits(units);
  else for (const unit of units) await input.storage.languageMemory.putLanguageUnit(unit);
  if (input.storage.languageMemory.putLanguagePatterns) await input.storage.languageMemory.putLanguagePatterns(patterns);
  else for (const pattern of patterns) await input.storage.languageMemory.putLanguagePattern(pattern);
  if (input.storage.languageMemory.putSemanticFrames) await input.storage.languageMemory.putSemanticFrames(frames);
  else for (const frame of frames) await input.storage.languageMemory.putSemanticFrame(frame);

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
  persistSpan.end({
    observations: observations.length,
    models: models.length,
    units: units.length,
    patterns: patterns.length,
    frames: frames.length
  });
  await input.storage.events.append(learned);

  return {
    schema: "scce.languageCorpusTrainingReport.v1",
    sourceSystem,
    sourceSystemId,
    streamUri: input.streamUri,
    sourceVersionId,
    languageProfiles: 1,
    evidence: evidence.length,
    ngramObservations: observations.length,
    ngramModels: models.length,
    languageUnits: units.length,
    languagePatterns: patterns.length,
    semanticFrames: frames.length,
    admission,
    alignmentPromotionObservations: [...compiledBatch.alignmentHeldoutEvaluation.promotionObservations],
    alignmentCalibrationObservations: [...compiledBatch.alignmentHeldoutEvaluation.calibrationObservations],
    constructionCandidates: compiledBatch.constructionCandidates,
    languageConstructions: compiledConstructionPatterns.length,
    graphSurfaceAlignments: compiledBatch.graphSurfaceAlignmentSummaries.length,
    rejectedLanguageConstructions: compiledBatch.rejectedConstructionCandidates,
    eventId: String(learned.id),
    warnings: [...new Set(constructionWarnings)].sort()
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

/**
 * What only the owner can state about a corpus. Authority is whether this corpus is a factual authority on its
 * subjects, and freshness is how current its content is -- neither is readable from the bytes, and both are
 * declarations rather than measurements. Authority is coarse on purpose: either the owner vouches for a corpus
 * as a factual authority or does not, and 0.88 against 0.76 was pseudo-precision over a judgement that has no
 * decimals in it.
 */
const CORPUS_DECLARATIONS: Readonly<Record<string, {
  readonly authority: 0 | 1;
  readonly freshness: number;
  readonly independenceGroup: string;
  readonly accessScope: string;
  readonly licenseStatus: string;
}>> = {
  [CORPUS_SOURCE_SYSTEM_IDS.wikipedia]: { authority: 1, freshness: 0.68, independenceGroup: "wikimedia:wikipedia", accessScope: "public", licenseStatus: "licensed" },
  [CORPUS_SOURCE_SYSTEM_IDS.workspace]: { authority: 1, freshness: 0.98, independenceGroup: "owner:workspace", accessScope: "owner_private", licenseStatus: "owner_authorized" },
  [CORPUS_SOURCE_SYSTEM_IDS.corrections]: { authority: 1, freshness: 1, independenceGroup: "owner:corrections", accessScope: "owner_private", licenseStatus: "owner_authorized" },
  // Human-authored dialogue: owner-authorized and current, but never a factual authority.
  [CORPUS_SOURCE_SYSTEM_IDS.dialogue]: { authority: 0, freshness: 1, independenceGroup: "owner:dialogue", accessScope: "owner_private", licenseStatus: "owner_authorized" },
  [CORPUS_SOURCE_SYSTEM_IDS.ossDocs]: { authority: 1, freshness: 0.72, independenceGroup: "corpus:oss-docs", accessScope: "public", licenseStatus: "licensed" },
  [CORPUS_SOURCE_SYSTEM_IDS.ossCode]: { authority: 1, freshness: 0.72, independenceGroup: "corpus:oss-code", accessScope: "public", licenseStatus: "licensed" },
  [CORPUS_SOURCE_SYSTEM_IDS.gutenberg]: { authority: 1, freshness: 0.2, independenceGroup: "corpus:gutenberg", accessScope: "public", licenseStatus: "public_domain" }
};

/**
 * The trust vector of a corpus source. Four of its six numbers are facts about how the source was stored and
 * are the same for every corpus; the other two are the owner's declarations above.
 *
 * It used to be a table of 42 numbers -- six per corpus across seven corpora and a fallback -- varying in ways
 * nothing measured. identity read 0.98 for Wikipedia and 0.9 for OSS docs, though a content hash either
 * identifies a source or it does not. directness read 0.72 for Gutenberg and 0.84 for Wikipedia, though in both
 * cases the text IS the artifact. parserReliability read 0.88 to 1, though this trainer is handed `text` that
 * is already text, so there is no parse to be unreliable about -- and the reliability of the actual extraction
 * is measured separately by admission's own diagnostics, from the parser count and the warnings it reported.
 *
 * No admission gate weakens: every retired identity, parserReliability and directness value already cleared
 * its floor and still does. One gate STRENGTHENS -- an unrecognised corpus declared no authority now fails
 * minimumAuthorityForEvidence where the old fallback of exactly 0.4 scraped past it. An unknown corpus should
 * not be direct evidence.
 */
/** Exposed for the trust-vector test: the derived dimensions must stay uniform and declarations coarse. */
export function corpusSourceTrustForTest(sourceSystem: string): SourceTrust {
  return corpusSourceTrust(sourceSystem);
}

function corpusSourceTrust(sourceSystem: string): SourceTrust {
  const declared = CORPUS_DECLARATIONS[sourceSystem] ?? {
    authority: 0 as const,
    freshness: 0,
    independenceGroup: `corpus:${sourceSystem}`,
    accessScope: "unknown",
    licenseStatus: "unknown"
  };
  return {
    // Content-addressed: the source is exactly identified and verifiable. Facts about hashing.
    identity: 1,
    integrity: 1,
    // The input to this trainer is already text, so nothing was parsed that could have gone wrong here.
    parserReliability: 1,
    // The text is the artifact, with no transform between them: 1/(1 + derivation depth) at depth 0.
    directness: 1,
    authority: declared.authority,
    freshness: declared.freshness,
    independenceGroup: declared.independenceGroup,
    accessScope: declared.accessScope,
    licenseStatus: declared.licenseStatus
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
