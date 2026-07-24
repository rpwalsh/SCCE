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
  corpusMetadata?: JsonValue;
  languageAliases?: readonly string[];
  constructionSets?: readonly SourceBoundLanguageConstructionTrainingSet[];
  creativeEventCompiler?: CreativeEventConstructionCompiler;
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
  languageConstructions: number;
  eventId: string;
  warnings: string[];
}

export async function trainLanguageCorpusText(input: LanguageCorpusTrainingInput): Promise<LanguageCorpusTrainingReport> {
  const clock = input.clock ?? createClock();
  const hasher = createHasher();
  const sourceSystemId = canonicalCorpusSourceSystemId(input.sourceSystem);
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
  const sourceVersionId = input.sourceVersionId ?? ids.sourceVersionId(`${sourceUri}\u001f${hasher.digestHex(bytes)}`);
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
    evidence = stampEvidence(extracted.spans, sourceSystem, sourceSystemId, metadata)
      .map(span => ({ ...span, informationLabel: sourceInformationLabel }));
    for (const span of evidence) {
      await input.storage.blobs.put(Buffer.from(span.text, "utf8"), mediaType);
    }
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

  const observations = memory.observations.map(item => ({ ...stampObservation(item, sourceSystem, sourceSystemId, metadata), informationLabel }));
  const models = memory.models.map(item => ({ ...stampModel(item, sourceSystem, sourceSystemId, metadata), informationLabel }));
  const units = memory.units.map(item => ({ ...stampUnit(item, sourceSystem, sourceSystemId, metadata), informationLabel }));
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
  const patterns = [...memory.patterns, ...compiledConstructionPatterns]
    .map(item => ({ ...stampPattern(item, sourceSystem, sourceSystemId, metadata), informationLabel }));
  const frames = memory.semanticFrames.map(item => ({ ...stampFrame(item, sourceSystem, sourceSystemId, metadata), informationLabel }));

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

function stampPattern(pattern: LanguagePatternRecord, sourceSystem: string, sourceSystemId: string, metadata: JsonValue): LanguagePatternRecord {
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
