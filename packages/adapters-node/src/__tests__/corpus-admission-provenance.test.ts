// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { getFixtureLanguagePatternProjection, replaceFixtureLanguagePatternProjection } from "../../../kernel/src/__tests__/language-pattern-projection-fixture.js";
import { describe, expect, it } from "vitest";
import { LANGUAGE_CORPUS_TRAINING_RECIPE_ID, trainLanguageCorpusText } from "../language-corpus-trainer.js";
import { trainStoredCorpusConstructions } from "../stored-corpus-construction-training.js";
import { blobContentHash } from "../postgres.js";
import { canonicalCorpusSourceSystemId, createClock, createHasher, createIdFactory } from "@scce/kernel";
import type {
  EvidenceSpan,
  EvidenceBackedSourceVersionQuery,
  EvidenceQuery,
  GraphEdge,
  GraphNode,
  Hyperedge,
  IngestionCheckpoint,
  LanguageProfileQuery,
  JsonValue,
  LanguagePatternRecord,
  LanguageProfile,
  LanguageUnitRecord,
  NgramModelRecord,
  NgramObservation,
  ScceEvent,
  ScceStorage,
  SemanticFrameRecord,
  SourceVersion
} from "@scce/kernel";

interface QuarantineRecord {
  sourceVersionId: string;
  decision: string;
  decisionJson: JsonValue;
  permissionVector: JsonValue;
}

interface MemoryState {
  events: ScceEvent[];
  sourceVersions: SourceVersion[];
  evidence: EvidenceSpan[];
  quarantine: QuarantineRecord[];
  blobs: Map<string, Uint8Array>;
  profiles: LanguageProfile[];
  patterns: LanguagePatternRecord[];
  models: NgramModelRecord[];
  observations: NgramObservation[];
  checkpoints: Map<string, IngestionCheckpoint>;
  replayPages: EvidenceBackedSourceVersionQuery[];
  graph: { nodes: GraphNode[]; edges: GraphEdge[]; hyperedges: Hyperedge[] };
}

const OSS_INFORMATION_LABEL = {
  tenantId: "scce.public.corpus",
  principals: [],
  compartments: [],
  exportClass: "public" as const,
  mergePolicy: "same_owner" as const
};

/** Long enough to clear the stored-corpus lane's 2000-byte article floor and to induce more than one chunk. */
function corpusText(subject: string): string {
  const sentence = `The ${subject} module resolves a declared symbol to the file that declares it, and the resolver records the span it read. `;
  return sentence.repeat(40);
}

function provenanceOf(span: EvidenceSpan): Record<string, JsonValue> {
  const value = span.provenance;
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function mergeGraphRow<T extends GraphNode | GraphEdge | Hyperedge>(rows: T[], row: T, kind: "nodes" | "edges" | "hyperedges"): void {
  const index = rows.findIndex(existing => existing.id === row.id);
  if (index < 0) { rows.push(structuredClone(row)); return; }
  const previous = rows[index]!;
  const merged = { ...previous, evidenceIds: [...new Set([...previous.evidenceIds, ...row.evidenceIds])],
    updatedAt: row.updatedAt, informationLabel: row.informationLabel } as unknown as T;
  if (kind === "nodes") {
    const before = previous as GraphNode;
    const incoming = row as GraphNode;
    Object.assign(merged, { alpha: Math.max(before.alpha, incoming.alpha), features: [...new Set([...before.features, ...incoming.features])],
      metadata: mergeJsonRecord(before.metadata, incoming.metadata) });
  } else if (kind === "edges") {
    const before = previous as GraphEdge;
    const incoming = row as GraphEdge;
    Object.assign(merged, { alpha: Math.max(before.alpha, incoming.alpha), weight: Math.max(before.weight, incoming.weight),
      metadata: mergeJsonRecord(before.metadata, incoming.metadata) });
  } else {
    const before = previous as Hyperedge;
    const incoming = row as Hyperedge;
    Object.assign(merged, { schema: incoming.schema, relationId: incoming.relationId, participantPorts: incoming.participantPorts,
      memberNodeIds: incoming.memberNodeIds, qualifiers: incoming.qualifiers, modality: incoming.modality, weightVector: incoming.weightVector,
      temporalScope: incoming.temporalScope, provenanceRefs: [...new Set([...before.provenanceRefs, ...incoming.provenanceRefs])] });
  }
  rows[index] = merged;
}

function mergeJsonRecord(left: JsonValue, right: JsonValue): JsonValue {
  const asRecord = (value: JsonValue) => value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue> : {};
  return { ...asRecord(left), ...asRecord(right) };
}

describe("corpus trainer admission and provenance", () => {
  it("records an admission decision for every corpus source version it promotes", async () => {
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "oss_code",
      streamUri: "oss_code:packages/kernel/src/resolver.ts",
      sourceUri: "repo://example/repo@abc123#path=packages/kernel/src/resolver.ts",
      text: corpusText("resolver"),
      mediaType: "text/x-typescript",
      informationLabel: OSS_INFORMATION_LABEL,
      corpusMetadata: { title: "resolver.ts", identity: "resolver", relativePath: "packages/kernel/src/resolver.ts" }
    });

    expect(fixture.state.evidence.length).toBeGreaterThan(0);
    // Law 1: a promoted span must carry a decision that was actually taken, not the absence of one.
    expect(fixture.state.quarantine.map(row => row.sourceVersionId))
      .toEqual(fixture.state.sourceVersions.map(row => String(row.sourceVersionId)));
    expect(fixture.state.quarantine[0]?.decision).toBe("promoted");
    expect(fixture.state.evidence.every(span => span.status === "promoted")).toBe(true);
  });

  it("names the corpus a span came from instead of labelling every lane construction_training", async () => {
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "oss_code",
      streamUri: "oss_code:packages/kernel/src/resolver.ts",
      sourceUri: "repo://example/repo@abc123#path=packages/kernel/src/resolver.ts",
      text: corpusText("resolver"),
      mediaType: "text/x-typescript",
      informationLabel: OSS_INFORMATION_LABEL,
      corpusMetadata: { title: "resolver.ts", identity: "resolver" }
    });

    const kinds = new Set(fixture.state.evidence.map(span => provenanceOf(span).sourceKind));
    expect(kinds).not.toContain("construction_training");
    expect(kinds).toEqual(new Set(["developer_intelligence"]));
  });

  it("keeps a supplied Wikipedia profile excerpt excerpt-classified while learned rows remain priors", async () => {
    const fixture = memoryStorage();
    const sourceText = corpusText("Pequod");
    const excerptText = "Pequod module resolves a declared symbol";
    const charStart = sourceText.indexOf(excerptText);
    const byteStart = Buffer.byteLength(sourceText.slice(0, charStart), "utf8");
    const excerptBytes = Buffer.from(excerptText, "utf8");
    const fullSourceBytes = Buffer.from(sourceText, "utf8");
    const sourceId = "source.profile-excerpt" as SourceVersion["sourceId"];
    const sourceVersionId = "source_version.profile-excerpt" as SourceVersion["sourceVersionId"];
    const sourceUri = "wikipedia://enwiki/pages/profile-excerpt";
    const sourceVersion: SourceVersion = {
      sourceId, sourceVersionId, namespace: "corpus:wikipedia", canonicalUri: sourceUri,
      contentHash: blobContentHash(fullSourceBytes) as SourceVersion["contentHash"], byteLength: fullSourceBytes.byteLength,
      mediaType: "text/plain", observedAt: 1, sourceTrust: {} as any, informationLabel: OSS_INFORMATION_LABEL,
      metadata: { sourceSystem: "wikipedia" }
    };
    const profileExcerpt: EvidenceSpan = {
      id: "evidence.profile-excerpt" as EvidenceSpan["id"], sourceId, sourceVersionId,
      chunkId: "chunk.profile-excerpt" as EvidenceSpan["chunkId"],
      contentHash: blobContentHash(excerptBytes) as EvidenceSpan["contentHash"], mediaType: "text/plain",
      byteStart, byteEnd: byteStart + excerptBytes.byteLength, charStart, charEnd: charStart + excerptText.length,
      text: excerptText, textPreview: excerptText, languageHints: {}, scriptHints: {},
      trustVector: { forceClass: "profile_excerpt_evidence" },
      provenance: { sourceSystem: "wikipedia", sourceKind: "wikimedia_dump", forceClass: "profile_excerpt_evidence" },
      features: [], status: "promoted", alpha: 0.9, observedAt: 1, informationLabel: OSS_INFORMATION_LABEL
    };
    fixture.state.sourceVersions.push(sourceVersion);
    fixture.state.evidence.push(profileExcerpt);
    fixture.state.blobs.set(String(sourceVersion.contentHash), new Uint8Array(fullSourceBytes));
    const persistedExcerptSource = fixture.state.blobs.get(String(sourceVersion.contentHash))!;
    const persistedExcerptBytes = persistedExcerptSource.subarray(profileExcerpt.byteStart, profileExcerpt.byteEnd);
    expect(blobContentHash(persistedExcerptSource)).toBe(sourceVersion.contentHash);
    expect(blobContentHash(persistedExcerptBytes)).toBe(profileExcerpt.contentHash);
    expect(Buffer.from(persistedExcerptBytes).toString("utf8")).toBe(profileExcerpt.text);
    expect(profileExcerpt.byteStart).toBeGreaterThan(0);
    expect(profileExcerpt.byteEnd).toBeLessThan(persistedExcerptSource.byteLength);

    const input = {
      storage: fixture.storage, sourceSystem: "wikipedia", streamUri: sourceUri, sourceUri, text: sourceText,
      createdAt: 2, informationLabel: OSS_INFORMATION_LABEL, persistSource: false, evidence: [profileExcerpt],
      ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64,
      corpusCheckpoint: { rootUri: "wikipedia://enwiki/pages", itemUri: "profile-excerpt" }
    };
    const checkpointId = createIdFactory({ clock: createClock(), hasher: createHasher(), namespace: "corpus-training-checkpoint", deterministicReplay: true })
      .semanticId("corpus_training_checkpoint", {
        compilerRecipe: LANGUAGE_CORPUS_TRAINING_RECIPE_ID,
        sourceSystem: canonicalCorpusSourceSystemId("wikipedia"),
        rootUri: input.corpusCheckpoint.rootUri,
        itemUri: input.corpusCheckpoint.itemUri
      });

    const report = await trainLanguageCorpusText(input);
    expect(report.evidence).toBe(1);
    expect(fixture.state.evidence).toEqual([profileExcerpt]);
    expect(fixture.state.sourceVersions).toEqual([sourceVersion]);
    expect(fixture.state.checkpoints.has(checkpointId)).toBe(true);
    expect(fixture.state.checkpoints.size).toBe(1);
    expect(fixture.state.models.length).toBeGreaterThan(0);
    expect(fixture.state.patterns.length).toBeGreaterThan(0);
    expect(fixture.state.models.every(row => (row.modelJson as Record<string, JsonValue>).forceClass === "learned_language_prior")).toBe(true);
    expect(fixture.state.patterns.every(row => (row.patternJson as Record<string, JsonValue>).forceClass === "learned_language_prior")).toBe(true);
    expect(provenanceOf(fixture.state.evidence[0]!).forceClass).toBe("profile_excerpt_evidence");
    expect(provenanceOf(fixture.state.evidence[0]!).forceClass).not.toBe("direct_evidence");

    const beforeReplay = structuredClone(fixture.state);
    expect(await trainLanguageCorpusText(input)).toEqual(report);
    expect(fixture.state).toEqual(beforeReplay);
  });

  it("refuses to promote a corpus whose admission context is unmeasured, and records that state", async () => {
    const fixture = memoryStorage();
    await trainLanguageCorpusText({
      storage: fixture.storage,
      sourceSystem: "an-undeclared-corpus",
      streamUri: "an-undeclared-corpus:doc/1",
      sourceUri: "scce://undeclared/doc/1",
      text: corpusText("undeclared"),
      mediaType: "text/plain",
      informationLabel: OSS_INFORMATION_LABEL
    });

    // Unmeasured is neither a refusal nor a promotion: the state is written, and it is not "promoted".
    expect(fixture.state.evidence.length).toBeGreaterThan(0);
    expect(fixture.state.evidence.every(span => span.status === "promoted")).toBe(false);
    expect(fixture.state.quarantine[0]?.decision).toBe("pending");
    expect(JSON.stringify(fixture.state.quarantine[0]?.decisionJson)).toContain("unmeasured");
  });

  it("keeps original source provenance during construction replay without creating a new truth source", async () => {
    const fixture = memoryStorage();
    const parents: Awaited<ReturnType<typeof trainLanguageCorpusText>>[] = [];
    for (const [title, subject] of [["Resolver", "resolver"], ["Declaration", "declaration"]]) {
      const uri = `wikipedia://enwiki/pages/${parents.length + 1}/${title}`;
      parents.push(await trainLanguageCorpusText({ storage: fixture.storage, sourceSystem: "wikipedia",
        streamUri: uri, sourceUri: uri, text: corpusText(subject!), mediaType: "text/plain", createdAt: 1,
        informationLabel: OSS_INFORMATION_LABEL, ngramMaxOrder: 2, ngramMaxCountersPerOrder: 64,
        corpusMetadata: { title: title!, identity: subject! } }));
    }
    expect(fixture.state.profiles).toHaveLength(2);
    expect(fixture.state.evidence.length).toBeGreaterThan(0);
    expect(fixture.state.evidence.every(span => span.status === "promoted")).toBe(true);
    for (const profile of fixture.state.profiles) {
      expect(parents.some(parent => parent.sourceVersionId === String(profile.sourceVersionId))).toBe(true);
    }
    const original = structuredClone({ sourceVersions: fixture.state.sourceVersions, evidence: fixture.state.evidence,
      profiles: fixture.state.profiles, models: fixture.state.models, observations: fixture.state.observations,
      quarantine: fixture.state.quarantine, blobKeys: [...fixture.state.blobs.keys()] });
    const originalCompilationMetadata = structuredClone(fixture.state.patterns.filter(pattern => pattern.patternKind === "source_compilation"));
    const originalCompilations = originalCompilationMetadata.filter(pattern =>
      (pattern.patternJson as Record<string, JsonValue>).schema === "scce.source_language_compilation_receipt.v1");
    const originalInductionCoverage = originalCompilationMetadata.filter(pattern =>
      (pattern.patternJson as Record<string, JsonValue>).schema === "scce.source_induction_coverage.v1");
    const originalCreativeCoverage = originalCompilationMetadata.filter(pattern =>
      (pattern.patternJson as Record<string, JsonValue>).schema === "scce.creative_event_source_coverage.v1");
    const originalGraphIds = {
      nodes: fixture.state.graph.nodes.map(row => row.id).sort(),
      edges: fixture.state.graph.edges.map(row => row.id).sort(),
      hyperedges: fixture.state.graph.hyperedges.map(row => row.id).sort()
    };
    expect(originalCompilations).toHaveLength(parents.length);
    expect(originalInductionCoverage).toHaveLength(parents.length);
    expect(originalCreativeCoverage).toHaveLength(parents.length);
    const eventStart = fixture.state.events.length;
    const report = await trainStoredCorpusConstructions({ storage: fixture.storage, sourcePageSize: 1,
      maxTotalBytes: 1024 * 1024, batchBytes: 1024 * 1024 });

    const sourceIds = parents.map(parent => parent.sourceVersionId).sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
    expect(report.articlesTrained).toBe(2);
    expect(report.exhausted).toBe(true);
    expect(report.batchesFailed).toEqual([]);
    expect(report.sourcesSkipped).toEqual([]);
    expect(report.reports.map(item => item.sourceVersionId)).toEqual(sourceIds);
    expect(report.reports.every(item => item.languagePatterns > 0)).toBe(true);
    expect(fixture.state.replayPages.filter(query => query.orderBySourceVersionId).map(query => query.afterSourceVersionId))
      .toEqual([undefined, sourceIds[0], sourceIds[1]]);
    expect({ sourceVersions: fixture.state.sourceVersions, evidence: fixture.state.evidence, profiles: fixture.state.profiles,
      models: fixture.state.models, observations: fixture.state.observations, quarantine: fixture.state.quarantine,
      blobKeys: [...fixture.state.blobs.keys()] }).toEqual(original);
    const currentCompilationReceipts = fixture.state.patterns.filter(pattern => pattern.patternKind === "source_compilation"
      && (pattern.patternJson as Record<string, JsonValue>).schema === "scce.source_language_compilation_receipt.v1");
    expect(currentCompilationReceipts).toEqual(originalCompilations);
    const currentInductionCoverage = fixture.state.patterns.filter(pattern => pattern.patternKind === "source_compilation"
      && (pattern.patternJson as Record<string, JsonValue>).schema === "scce.source_induction_coverage.v1");
    const withoutReplayMetadata = (pattern: LanguagePatternRecord) => {
      const { lane: _lane, replayRecipeId: _replayRecipeId, ...metadata } = pattern.patternJson as Record<string, JsonValue>;
      return { ...pattern, patternJson: metadata };
    };
    expect(currentInductionCoverage.map(withoutReplayMetadata)).toEqual(originalInductionCoverage.map(withoutReplayMetadata));
    const currentCreativeCoverage = fixture.state.patterns.filter(pattern => pattern.patternKind === "source_compilation"
      && (pattern.patternJson as Record<string, JsonValue>).schema === "scce.creative_event_source_coverage.v1");
    expect(currentCreativeCoverage.map(withoutReplayMetadata)).toEqual(originalCreativeCoverage.map(withoutReplayMetadata));
    expect(currentInductionCoverage.every(pattern => {
      const metadata = pattern.patternJson as Record<string, JsonValue>;
      return metadata.lane === "stored-corpus-construction-replay" && metadata.replayRecipeId === LANGUAGE_CORPUS_TRAINING_RECIPE_ID;
    })).toBe(true);
    expect(fixture.state.sourceVersions.some(source => source.canonicalUri.startsWith("scce://construction-training/"))).toBe(false);
    expect(fixture.state.evidence.some(span => provenanceOf(span).derivation === "construction_training")).toBe(false);
    const evidenceById = new Map(fixture.state.evidence.map(span => [String(span.id), span]));
    expect({
      nodes: fixture.state.graph.nodes.map(row => row.id).sort(),
      edges: fixture.state.graph.edges.map(row => row.id).sort(),
      hyperedges: fixture.state.graph.hyperedges.map(row => row.id).sort()
    }).toEqual(originalGraphIds);
    const sourceClaimRecords = [
      ...fixture.state.graph.nodes.filter(node => !isObservationStoreTopologyNode(node)),
      ...fixture.state.graph.edges,
      ...fixture.state.graph.hyperedges
    ];
    expect(sourceClaimRecords.length).toBeGreaterThan(0);
    for (const node of fixture.state.graph.nodes.filter(isObservationStoreTopologyNode)) {
      expect(fixture.state.graph.edges.some(edge => edge.target === node.id
        && edge.evidenceIds.length > 0
        && edge.evidenceIds.every(id => evidenceById.has(String(id))))).toBe(true);
    }
    for (const record of sourceClaimRecords) {
      expect(record.evidenceIds.length).toBeGreaterThan(0);
      expect(record.evidenceIds.every(id => evidenceById.has(String(id)))).toBe(true);
    }
    const profilesById = new Map(fixture.state.profiles.map(profile => [profile.id, profile]));
    const sourceUris = new Set(fixture.state.sourceVersions.map(source => source.canonicalUri));
    expect(fixture.state.patterns.filter(pattern => pattern.patternKind !== "source_compilation").length).toBeGreaterThan(0);
    for (const pattern of fixture.state.patterns) {
      const profile = profilesById.get(pattern.profileId);
      expect(profile).toBeDefined();
      for (const id of pattern.evidenceIds) expect(evidenceById.get(String(id))?.sourceVersionId).toBe(profile!.sourceVersionId);
      const metadata = pattern.patternJson as Record<string, JsonValue>;
      if (metadata.schema === "scce.source_language_compilation_receipt.v1") {
        expect(pattern.evidenceIds).toEqual([]);
        expect(metadata.forceClass).toBeUndefined();
        continue;
      }
      if (pattern.patternKind === "source_compilation") {
        expect(["scce.source_induction_coverage.v1", "scce.creative_event_source_coverage.v1"]).toContain(metadata.schema);
        expect(metadata.complete).toBe(true);
        if (metadata.schema === "scce.source_induction_coverage.v1") expect(metadata.coveredUtf16Length).toBe(metadata.inputUtf16Length);
        else {
          const induction = metadata.sourceInduction as Record<string, JsonValue>;
          expect(induction.complete).toBe(true);
          expect(induction.coveredUtf16Length).toBe(induction.inputUtf16Length);
          const pages = metadata.pages as Array<{ id: string; observedEvents: number }>;
          expect(pages.length).toBeGreaterThan(0);
          expect(pages.reduce((sum, page) => sum + page.observedEvents, 0)).toBe(metadata.observedEvents);
          expect(pages.every(page => fixture.state.patterns.some(row => row.id === page.id && row.profileId === pattern.profileId))).toBe(true);
        }
        expect(pattern.evidenceIds.length).toBeGreaterThan(0);
      }
      expect(metadata.forceClass).toBe("learned_language_prior");
      expect(sourceUris.has(String(metadata.sourceUri))).toBe(true);
    }
    const replayedLearning = fixture.state.events.slice(eventStart).filter(event => event.typeId === "SymbolPatternLearned");
    expect(replayedLearning.map(event => (event.payload as Record<string, JsonValue>).sourceVersionId)).toEqual(sourceIds);
  });
});

function memoryStorage(): { storage: ScceStorage; state: MemoryState } {
  const state: MemoryState = { events: [], sourceVersions: [], evidence: [], quarantine: [], blobs: new Map(),
    profiles: [], patterns: [], models: [], observations: [], checkpoints: new Map(), replayPages: [], graph: { nodes: [], edges: [], hyperedges: [] } };
  const put = <T extends { id: string }>(rows: T[], row: T) => {
    const index = rows.findIndex(existing => existing.id === row.id);
    if (index < 0) rows.push(row); else rows[index] = row;
  };
  const storage = {
    events: {
      append: async (event: ScceEvent) => { state.events.push(event); },
      appendBatch: async (events: ScceEvent[]) => { state.events.push(...events); },
      readEpisode: async () => state.events,
      readRange: async () => state.events,
      latestLedgerHash: async () => state.events.at(-1)?.hash ?? ""
    },
    evidence: {
      putSourceVersion: async (source: SourceVersion) => { state.sourceVersions.push(source); },
      putEvidenceSpan: async (span: EvidenceSpan) => { state.evidence.push(span); },
      putEvidenceSpans: async (spans: readonly EvidenceSpan[]) => { state.evidence.push(...spans); },
      promoteEvidence: async (ids: EvidenceSpan["id"][]) => ids.length,
      getEvidence: async (id: EvidenceSpan["id"]) => state.evidence.find(span => span.id === id) ?? null,
      getEvidenceBatch: async (ids: EvidenceSpan["id"][]) => state.evidence.filter(span => ids.includes(span.id)),
      searchEvidence: async (query: EvidenceQuery) => state.evidence
        .filter(span => (!query.sourceVersionId || span.sourceVersionId === query.sourceVersionId) && (!query.status || span.status === query.status))
        .slice(0, query.limit).map(span => ({ span, score: span.alpha, reason: "exact source owner" })),
      sourceVersionsForEvidence: async (ids: EvidenceSpan["id"][]) => {
        const versions = new Set(state.evidence.filter(span => ids.includes(span.id)).map(span => span.sourceVersionId));
        return state.sourceVersions.filter(source => versions.has(source.sourceVersionId));
      },
      listEvidenceBackedSourceVersions: async (query: EvidenceBackedSourceVersionQuery = {}) => {
        state.replayPages.push(structuredClone(query));
        return state.sourceVersions.filter(source => {
          const id = String(source.sourceVersionId);
          const metadata = source.metadata as Record<string, JsonValue>;
          const declared = canonicalCorpusSourceSystemId(String(metadata.sourceSystemId ?? metadata.sourceSystem));
          return state.evidence.some(span => span.sourceVersionId === source.sourceVersionId && span.status === "promoted")
            && (!query.afterSourceVersionId || Buffer.compare(Buffer.from(id), Buffer.from(query.afterSourceVersionId)) > 0)
            && (!query.sourceVersionIds?.length || query.sourceVersionIds.includes(id))
            && (!query.sourceSystem || canonicalCorpusSourceSystemId(query.sourceSystem) === declared)
            && (!query.sourceSystems?.length || query.sourceSystems.some(system => canonicalCorpusSourceSystemId(system) === declared))
            && (!query.includeUriPrefixes?.length || query.includeUriPrefixes.some(prefix => source.canonicalUri.startsWith(prefix)))
            && !(query.excludeUriPrefixes ?? []).some(prefix => source.canonicalUri.startsWith(prefix))
            && (query.minByteLength === undefined || source.byteLength >= query.minByteLength)
            && (query.maxByteLength === undefined || source.byteLength <= query.maxByteLength);
        }).sort((left, right) => Buffer.compare(Buffer.from(String(left.sourceVersionId)), Buffer.from(String(right.sourceVersionId))))
          .slice(0, query.limit).map(source => ({ sourceVersionId: source.sourceVersionId, contentHash: source.contentHash,
            byteLength: source.byteLength, canonicalUri: source.canonicalUri,
            promotedSpanCount: state.evidence.filter(span => span.sourceVersionId === source.sourceVersionId && span.status === "promoted").length }));
      }
    },
    blobs: {
      put: async (bytes: Uint8Array) => { const hash = blobContentHash(bytes); state.blobs.set(hash, bytes); return hash; },
      get: async (hash: string) => { const found = state.blobs.get(hash); if (!found) throw new Error(`no blob ${hash}`); return found; }
    },
    quarantine: {
      put: async (record: { sourceVersionId: string; decision: string; decisionJson: JsonValue; permissionVector: JsonValue }) => {
        state.quarantine.push({
          sourceVersionId: String(record.sourceVersionId),
          decision: record.decision,
          decisionJson: record.decisionJson,
          permissionVector: record.permissionVector
        });
      },
      get: async () => null,
      list: async () => [],
      decide: async () => undefined
    },
    model: {
      readModel: async () => ({ languageProfiles: state.profiles, latentConcepts: [], learnedProgramPatterns: [], learningGoals: [], trainingSteps: 0 }),
      writeModel: async () => undefined,
      putLanguageProfile: async (profile: LanguageProfile) => { put(state.profiles, profile); },
      listLanguageProfiles: async (query?: number | LanguageProfileQuery) => state.profiles
        .filter(profile => typeof query === "number" || !query?.sourceVersionIds?.length || query.sourceVersionIds.includes(profile.sourceVersionId))
        .slice(0, typeof query === "number" ? query : query?.limit)
    },
    languageMemory: {
      putNgramObservation: async (row: NgramObservation) => { put(state.observations, row); },
      putNgramObservationsBatch: async (rows: readonly NgramObservation[]) => { for (const row of rows) put(state.observations, row); },
      putNgramModel: async (row: NgramModelRecord) => { put(state.models, row); },
      putNgramModels: async (rows: readonly NgramModelRecord[]) => { for (const row of rows) put(state.models, row); },
      putLanguageUnit: async (_row: LanguageUnitRecord) => undefined,
      putLanguageUnits: async (_rows: readonly LanguageUnitRecord[]) => undefined,
      getLanguagePatternProjection: getFixtureLanguagePatternProjection,
      replaceLanguagePatternProjection: replaceFixtureLanguagePatternProjection,
      putLanguagePattern: async (row: LanguagePatternRecord) => { put(state.patterns, row); },
      putLanguagePatterns: async (rows: readonly LanguagePatternRecord[]) => { for (const row of rows) put(state.patterns, row); },
      putSemanticFrame: async (_row: SemanticFrameRecord) => undefined,
      putSemanticFrames: async (_rows: readonly SemanticFrameRecord[]) => undefined,
      putTranslationAlignment: async () => undefined,
      listNgramModels: async () => state.models,
      listNgramObservations: async () => state.observations,
      listLanguageUnits: async () => [],
      listLanguagePatterns: async () => [],
      listSemanticFrames: async () => [],
      listTranslationAlignments: async () => []
    },
    ingestion: {
      put: async (checkpoint: IngestionCheckpoint) => { state.checkpoints.set(checkpoint.id, structuredClone(checkpoint)); },
      get: async (id: string) => state.checkpoints.get(id) ?? null,
      list: async () => [...state.checkpoints.values()]
    },
    graph: {
      upsertNode: async (row: GraphNode) => mergeGraphRow(state.graph.nodes, row, "nodes"),
      upsertNodes: async (rows: readonly GraphNode[]) => { for (const row of rows) mergeGraphRow(state.graph.nodes, row, "nodes"); },
      upsertEdge: async (row: GraphEdge) => mergeGraphRow(state.graph.edges, row, "edges"),
      upsertEdges: async (rows: readonly GraphEdge[]) => { for (const row of rows) mergeGraphRow(state.graph.edges, row, "edges"); },
      upsertHyperedge: async (row: Hyperedge) => mergeGraphRow(state.graph.hyperedges, row, "hyperedges"),
      upsertHyperedges: async (rows: readonly Hyperedge[]) => { for (const row of rows) mergeGraphRow(state.graph.hyperedges, row, "hyperedges"); },
      getSlice: async (query: { evidenceIds?: readonly EvidenceSpan["id"][]; limitNodes?: number; limitEdges?: number }) => {
        const evidence = new Set((query.evidenceIds ?? []).map(String));
        const owns = (row: { evidenceIds: readonly EvidenceSpan["id"][] }) => row.evidenceIds.some(id => evidence.has(String(id)));
        return { nodes: state.graph.nodes.filter(owns).slice(0, query.limitNodes ?? state.graph.nodes.length),
          edges: state.graph.edges.filter(owns).slice(0, query.limitEdges ?? state.graph.edges.length),
          hyperedges: state.graph.hyperedges.filter(owns).slice(0, query.limitEdges ?? state.graph.hyperedges.length), bounded: true as const, query };
      }
    },
    init: async () => undefined,
    transaction: async <T>(fn: () => Promise<T>) => fn(),
    migrate: async () => undefined,
    verify: async () => ({ ok: true, tables: [], errors: [] }),
    stats: async () => ({}),
    close: async () => undefined
  } as unknown as ScceStorage;
  return { storage, state };
}

function isObservationStoreTopologyNode(node: GraphNode): boolean {
  const representation = node.representation && typeof node.representation === "object" && !Array.isArray(node.representation)
    ? node.representation as Record<string, JsonValue>
    : {};
  return node.evidenceIds.length === 0
    && typeof representation.store === "string"
    && node.features.includes(`store:${representation.store}`);
}
