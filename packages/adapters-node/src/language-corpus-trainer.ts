import {
  createClock,
  createEventFactory,
  createEvidenceExtractor,
  createHasher,
  createIdFactory,
  createLanguageAcquisitionEngine,
  createLanguageMemoryRuntime,
  compileLanguageConstructionPattern,
  attachSourceDerivedLanguageAliases,
  CORPUS_SOURCE_SYSTEM_IDS,
  canonicalCorpusSourceSystemId,
  corpusSourceAlias,
  toJsonValue,
  type Clock,
  type EvidenceSpan,
  type IdFactory,
  type JsonValue,
  type LanguagePatternRecord,
  type LanguageProfile,
  type LanguageUnitRecord,
  type NgramModelRecord,
  type NgramObservation,
  type ScceStorage,
  type SemanticFrameRecord,
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
  corpusMetadata?: JsonValue;
  languageAliases?: readonly string[];
  constructionSets?: readonly SourceBoundLanguageConstructionTrainingSet[];
  persistSource?: boolean;
  episodeId?: ReturnType<IdFactory["episodeId"]>;
  idFactory?: IdFactory;
  clock?: Clock;
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
  languageConstructions: number;
  eventId: string;
  warnings: string[];
}

export async function trainLanguageCorpusText(input: LanguageCorpusTrainingInput): Promise<LanguageCorpusTrainingReport> {
  const clock = input.clock ?? createClock();
  const hasher = createHasher();
  const sourceSystemId = canonicalCorpusSourceSystemId(input.sourceSystem);
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
  const sourceVersionId = input.sourceVersionId ?? ids.sourceVersionId(`${sourceUri}\u001f${hasher.digestHex(bytes)}`);
  const sourceId = ids.sourceId(namespace, sourceUri);
  let profile = input.profile ?? language.acquire({ sourceVersionId, text, createdAt });
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
  if (!evidence.length && input.persistSource !== false) {
    const extractor = createEvidenceExtractor({ idFactory: ids, hasher });
    const source: SourceVersion = {
      sourceId,
      sourceVersionId,
      namespace,
      canonicalUri: sourceUri,
      contentHash: ids.contentHash(bytes),
      mediaType: input.mediaType ?? "text/plain",
      observedAt: createdAt,
      byteLength: bytes.byteLength,
      trust: corpusSourceTrust(sourceSystemId),
      metadata
    };
    const extracted = extractor.extract({
      sourceId,
      sourceVersionId,
      namespace,
      uri: sourceUri,
      mediaType: input.mediaType ?? "text/plain",
      text,
      languageProfile: profile,
      observedAt: createdAt,
      maxChunkBytes: input.maxEvidenceChunkBytes ?? 64 * 1024,
      metadata
    });
    evidence = stampEvidence(extracted.spans, sourceSystem, sourceSystemId, metadata);
    await input.storage.evidence.putSourceVersion(source);
    if (input.storage.evidence.putEvidenceSpans) await input.storage.evidence.putEvidenceSpans(evidence);
    else for (const span of evidence) await input.storage.evidence.putEvidenceSpan(span);
  }

  profile = attachSourceDerivedLanguageAliases({ profile, metadata, evidence });
  await input.storage.model.putLanguageProfile(profile);

  const memory = languageMemory.observe({
    streamId: input.streamUri,
    profile,
    sourceVersionId,
    text,
    evidence,
    createdAt,
    maxOrder: input.ngramMaxOrder,
    maxCountersPerOrder: input.ngramMaxCountersPerOrder,
    vocabularyLimit: input.ngramVocabularyLimit
  });

  const observations = memory.observations.map(item => stampObservation(item, sourceSystem, sourceSystemId, metadata));
  const models = memory.models.map(item => stampModel(item, sourceSystem, sourceSystemId, metadata));
  const units = memory.units.map(item => stampUnit(item, sourceSystem, sourceSystemId, metadata));
  const compiledConstructionPatterns: LanguagePatternRecord[] = [];
  const constructionWarnings: string[] = [];
  for (const set of input.constructionSets ?? []) {
    const compiled = compileLanguageConstructionPattern({
      bindingId: set.bindingId,
      profileId: profile.id,
      observations: set.observations,
      evidence,
      hasher,
      updatedAt: createdAt
    });
    if (compiled.status === "compiled") compiledConstructionPatterns.push(compiled.pattern);
    else constructionWarnings.push(...compiled.issues.map(issue => issue.code));
  }
  const patterns = [...memory.patterns, ...compiledConstructionPatterns]
    .map(item => stampPattern(item, sourceSystem, sourceSystemId, metadata));
  const frames = memory.semanticFrames.map(item => stampFrame(item, sourceSystem, sourceSystemId, metadata));

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
      ...jsonRecord(memory.audit),
      sourceSystem,
      sourceSystemId,
      streamUri: input.streamUri,
      sourceUri,
      sourceVersionId,
      evidence: evidence.length,
      languageConstructions: compiledConstructionPatterns.length,
      corpusMetadata: metadata
    }
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
    languageConstructions: compiledConstructionPatterns.length,
    eventId: String(learned.id),
    warnings: [...new Set(constructionWarnings)].sort()
  };
}

function stampEvidence(spans: readonly EvidenceSpan[], sourceSystem: string, sourceSystemId: string, metadata: JsonValue): EvidenceSpan[] {
  return spans.map(span => ({
    ...span,
    status: "promoted",
    provenance: toJsonValue({ ...jsonRecord(span.provenance), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "profile_excerpt_evidence" }),
    trustVector: toJsonValue({ ...jsonRecord(span.trustVector), sourceSystem, sourceSystemId, forceClass: "profile_excerpt_evidence", sourceTrust: corpusSourceTrust(sourceSystemId) })
  }));
}

function stampObservation(observation: NgramObservation, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): NgramObservation {
  return { ...observation, metadata: toJsonValue({ ...jsonRecord(observation.metadata), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function stampModel(model: NgramModelRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): NgramModelRecord {
  return { ...model, modelJson: toJsonValue({ ...jsonRecord(model.modelJson), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function stampUnit(unit: LanguageUnitRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): LanguageUnitRecord {
  return { ...unit, metadata: toJsonValue({ ...jsonRecord(unit.metadata), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function stampPattern(pattern: LanguagePatternRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): LanguagePatternRecord {
  return { ...pattern, patternJson: toJsonValue({ ...jsonRecord(pattern.patternJson), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function stampFrame(frame: SemanticFrameRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): SemanticFrameRecord {
  return { ...frame, frameJson: toJsonValue({ ...jsonRecord(frame.frameJson), ...jsonRecord(metadata), sourceSystem, sourceSystemId, forceClass: "learned_language_prior" }) };
}

function corpusSourceTrust(sourceSystem: string): number {
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.wikipedia) return 0.82;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.workspace) return 0.78;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.corrections) return 0.76;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossDocs) return 0.72;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.ossCode) return 0.66;
  if (sourceSystem === CORPUS_SOURCE_SYSTEM_IDS.gutenberg) return 0.58;
  return 0.5;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, JsonValue>;
}
