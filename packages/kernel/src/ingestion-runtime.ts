import { createSourceAdmissionController } from "./admission.js";
import { createEventFactory } from "./events.js";
import { createEvidenceExtractor } from "./evidence.js";
import { createSourceGraphBuilder } from "./graphbuild.js";
import { createIdFactory } from "./ids.js";
import { routeStoreCounts, sumRecord } from "./ingestion-diagnostics.js";
import { inlineIngestStream } from "./inline-ingest-source.js";
import { jsonRecord, kernelString } from "./kernel-answer-primitives.js";
import { createLanguageMemoryRuntime } from "./language-memory-runtime.js";
import {
  createLanguageAcquisitionEngine
} from "./language.js";
import { createClock, createHasher, toJsonValue } from "./primitives.js";
import {
  compileRequestRequirementCorpus,
  parseRequestRequirementCorpus,
  requestRequirementCorpusLanguageText
} from "./request-requirement-learning.js";
import type { ScceKernelDeps } from "./storage.js";
import { createTypedIngestProjector } from "./typed-ingest.js";
import type {
  EpisodeId,
  IngestInput,
  IngestResult,
  JsonValue,
  ScceEvent,
  SourceVersion
} from "./types.js";

export function createIngestionRuntime(options: {
  deps: ScceKernelDeps;
  clock: ReturnType<typeof createClock>;
  hasher: ReturnType<typeof createHasher>;
  idFactory: ReturnType<typeof createIdFactory>;
  eventFactory: ReturnType<typeof createEventFactory>;
  language: ReturnType<typeof createLanguageAcquisitionEngine>;
  languageMemoryRuntime: ReturnType<typeof createLanguageMemoryRuntime>;
  append(event: ScceEvent): Promise<ScceEvent>;
  onKernelStateMutation(input: { episodeId: EpisodeId; output: string; invalidateRuntimeCaches: boolean }): void;
}) {
  const {
    deps, clock, hasher, idFactory, eventFactory, language, languageMemoryRuntime, append, onKernelStateMutation
  } = options;

  const evidenceExtractor = createEvidenceExtractor({ idFactory, hasher });

  const graphBuilder = createSourceGraphBuilder({ idFactory });

  const admission = createSourceAdmissionController();

  const typedIngest = createTypedIngestProjector({ idFactory, hasher });

  return {
    async ingest(input: IngestInput): Promise<IngestResult> {

      const episodeId = idFactory.episodeId();
      const events: ScceEvent[] = [];
      events.push(await append(eventFactory.create({ episodeId, typeId: "OwnerAsked", payload: { ingest: input.path ?? input.uri ?? "inline", metadata: input.metadata ?? null } })));
      let sources = 0;
      let fileCount = 0;
      let evidenceCount = 0;
      let graphNodes = 0;
      let graphEdges = 0;
      let languageProfiles = 0;
      const typedObservationCounts: Record<string, number> = {};
      const observationRouteCounts: Record<string, number> = {};
      const skipped: Array<{ path: string; reason: string }> = [];
      const stream = input.content !== undefined
        ? inlineIngestStream(input, clock.now(), hasher)
        : deps.files.streamPath(input.path ?? input.uri ?? ".", { metadata: input.metadata });
      for await (const item of stream) {
        await deps.storage.ingestion.put(item.checkpoint);
        if (item.type === "checkpoint") continue;
        if (item.type === "skipped") {
          skipped.push(item.skipped);
          continue;
        }
        const file = item.file;
        fileCount++;
        const now = clock.now();
        const contentHash = await deps.storage.blobs.put(file.bytes, file.mediaType);
        const sourceId = idFactory.sourceId(file.namespace, file.uri);
        const sourceVersionId = idFactory.sourceVersionId(file.bytes);
        const source: SourceVersion = {
          sourceId,
          sourceVersionId,
          namespace: file.namespace,
          canonicalUri: file.uri,
          contentHash,
          mediaType: file.mediaType,
          observedAt: now,
          byteLength: file.bytes.byteLength,
          trust: 0.82,
          metadata: file.metadata
        };
        const requestRequirementCorpus = parseRequestRequirementCorpus(file.text);
        await deps.storage.evidence.putSourceVersion(source);
        events.push(await append(eventFactory.create({ episodeId, typeId: "SourceObserved", payload: { sourceId, uri: file.uri, namespace: file.namespace } })));
        events.push(await append(eventFactory.create({ episodeId, typeId: "SourceVersionObserved", payload: { sourceVersionId, contentHash, byteLength: file.bytes.byteLength } })));
        sources++;
        const preview = typedIngest.preview({ uri: file.uri, mediaType: file.mediaType, text: file.text, metadata: file.metadata });
        const languageSurface = requestRequirementCorpus
          ? requestRequirementCorpusLanguageText(requestRequirementCorpus)
          : preview.languageText || (preview.suppressRawLanguageTraining ? "" : file.text);
        const profile = language.acquire({ sourceVersionId, text: languageSurface, createdAt: now });
        if (deps.storage.model.putLanguageProfiles) await deps.storage.model.putLanguageProfiles([profile]);
        else await deps.storage.model.putLanguageProfile(profile);
        events.push(await append(eventFactory.create({ episodeId, typeId: "LanguagePatternLearned", payload: { profileId: profile.id, scripts: profile.scripts.slice(0, 4), entropy: profile.entropy } })));
        languageProfiles++;
        const extracted = evidenceExtractor.extract({
          sourceId,
          sourceVersionId,
          namespace: file.namespace,
          uri: file.uri,
          mediaType: file.mediaType,
          text: file.text,
          languageProfile: profile,
          observedAt: now,
          maxChunkBytes: deps.maxChunkBytes ?? 131072,
          metadata: file.metadata
        });
        const decision = admission.decide({ source, evidence: extracted.spans, metadata: file.metadata });
        await deps.storage.quarantine.put({
          id: `${sourceVersionId}:admission`,
          sourceId,
          sourceVersionId,
          uri: file.uri,
          contentHash,
          mediaType: file.mediaType,
          fetchedAt: now,
          trustVector: decision.audit,
          permissionVector: { disposition: decision.disposition, safetyRails: decision.safetyRails },
          decision: decision.disposition === "reject" ? "rejected" : decision.disposition === "promote" ? "promoted" : "pending",
          decisionJson: decision.audit
        });
        events.push(await append(eventFactory.create({ episodeId, typeId: decision.disposition === "promote" ? "SourcePromoted" : "SourceQuarantined", payload: decision.audit })));
        if (decision.disposition === "reject") {
          events.push(await append(eventFactory.create({ episodeId, typeId: "FailureObserved", payload: { sourceVersionId, reasons: decision.reasons } })));
          continue;
        }
        const actionByEvidence = new Map(decision.evidenceActions.map(action => [action.evidenceId, action]));
        const admittedSpans = extracted.spans.map(span => {
          const action = actionByEvidence.get(String(span.id));
          return {
            ...span,
            alpha: action?.action === "lower-alpha" ? Math.min(span.alpha, action.alpha) : span.alpha,
            status: decision.disposition === "promote" ? "promoted" as const : "quarantined" as const,
            trustVector: { ...(span.trustVector as Record<string, JsonValue>), admission: decision.audit, action: action?.action ?? "quarantine" }
          };
        });
        for (const span of admittedSpans) await deps.storage.blobs.put(Buffer.from(span.text, "utf8"), file.mediaType);
        if (deps.storage.evidence.putEvidenceSpans) await deps.storage.evidence.putEvidenceSpans(admittedSpans);
        else for (const span of admittedSpans) await deps.storage.evidence.putEvidenceSpan(span);
        evidenceCount += admittedSpans.length;
        const typedProjection = typedIngest.project({
          sourceId,
          sourceVersionId,
          uri: file.uri,
          mediaType: file.mediaType,
          text: file.text,
          metadata: file.metadata,
          evidence: admittedSpans,
          observedAt: now
        });
        for (const [kind, count] of Object.entries(typedProjection.observationCounts)) typedObservationCounts[kind] = (typedObservationCounts[kind] ?? 0) + count;
        const routeCounts = routeStoreCounts(typedProjection.routes);
        for (const [store, count] of Object.entries(routeCounts)) observationRouteCounts[store] = (observationRouteCounts[store] ?? 0) + count;
        if (deps.storage.graph.upsertNodes) await deps.storage.graph.upsertNodes(typedProjection.graphNodes);
        else for (const graphNode of typedProjection.graphNodes) await deps.storage.graph.upsertNode(graphNode);
        if (deps.storage.graph.upsertEdges) await deps.storage.graph.upsertEdges(typedProjection.graphEdges);
        else for (const graphEdge of typedProjection.graphEdges) await deps.storage.graph.upsertEdge(graphEdge);
        graphNodes += typedProjection.graphNodes.length;
        graphEdges += typedProjection.graphEdges.length;
        events.push(await append(eventFactory.create({ episodeId, typeId: "GraphUpdated", payload: { typedIngest: typedProjection.diagnostics } })));

        const languageTrainingText = requestRequirementCorpus
          ? requestRequirementCorpusLanguageText(requestRequirementCorpus)
          : typedProjection.languageText;
        const languageMemory = languageTrainingText.trim() ? languageMemoryRuntime.observe({
          streamId: file.uri,
          sourceSystem: kernelString(jsonRecord(file.metadata).sourceSystem),
          profile,
          sourceVersionId,
          text: languageTrainingText,
          evidence: admittedSpans,
          createdAt: now,
          maxOrder: 6,
          maxCountersPerOrder: 12000,
          vocabularyLimit: 24000
        }) : undefined;
        if (languageMemory) {
        const requestRequirementLearning = requestRequirementCorpus
          ? compileRequestRequirementCorpus({
            corpus: requestRequirementCorpus,
            profileId: profile.id,
            sourceVersionId,
            evidenceIds: admittedSpans.map(span => span.id),
            sourceSystem: kernelString(jsonRecord(file.metadata).sourceSystem) ?? "corrections",
            updatedAt: now,
            makeId: representation => String(idFactory.semanticId("request_requirement_pattern", representation))
          })
          : undefined;
        await deps.storage.languageMemory.putNgramObservationsBatch(languageMemory.observations);
        if (deps.storage.languageMemory.putNgramModels) await deps.storage.languageMemory.putNgramModels(languageMemory.models);
        else for (const model of languageMemory.models) await deps.storage.languageMemory.putNgramModel(model);
        if (deps.storage.languageMemory.putLanguageUnits) await deps.storage.languageMemory.putLanguageUnits(languageMemory.units);
        else for (const unit of languageMemory.units) await deps.storage.languageMemory.putLanguageUnit(unit);
        const learnedPatterns = requestRequirementLearning
          ? [...languageMemory.patterns, ...requestRequirementLearning.patterns]
          : languageMemory.patterns;
        if (deps.storage.languageMemory.putLanguagePatterns) await deps.storage.languageMemory.putLanguagePatterns(learnedPatterns);
        else for (const pattern of learnedPatterns) await deps.storage.languageMemory.putLanguagePattern(pattern);
        if (deps.storage.languageMemory.putSemanticFrames) await deps.storage.languageMemory.putSemanticFrames(languageMemory.semanticFrames);
        else for (const frame of languageMemory.semanticFrames) await deps.storage.languageMemory.putSemanticFrame(frame);
        events.push(await append(eventFactory.create({
          episodeId,
          typeId: "SymbolPatternLearned",
          payload: requestRequirementLearning
            ? toJsonValue({ languageMemory: languageMemory.audit, requestRequirements: requestRequirementLearning.audit })
            : languageMemory.audit
        })));
        } else {
          events.push(await append(eventFactory.create({ episodeId, typeId: "SymbolPatternLearned", payload: { skipped: "no language-bearing observations", uri: file.uri, typedIngest: typedProjection.diagnostics } })));
        }
        const builtGraph = graphBuilder.build({ sourceVersionId, uri: file.uri, mediaType: file.mediaType, languageProfile: profile, evidence: admittedSpans, observedAt: now });
        if (deps.storage.graph.upsertNodes) await deps.storage.graph.upsertNodes(builtGraph.nodes);
        else for (const graphNode of builtGraph.nodes) await deps.storage.graph.upsertNode(graphNode);
        if (deps.storage.graph.upsertEdges) await deps.storage.graph.upsertEdges(builtGraph.edges);
        else for (const graphEdge of builtGraph.edges) await deps.storage.graph.upsertEdge(graphEdge);
        if (deps.storage.graph.upsertHyperedges) await deps.storage.graph.upsertHyperedges(builtGraph.hyperedges);
        else for (const hyperedge of builtGraph.hyperedges) await deps.storage.graph.upsertHyperedge(hyperedge);
        graphNodes += builtGraph.nodes.length;
        graphEdges += builtGraph.edges.length;
        await deps.storage.ingestion.put({ ...item.checkpoint, phase: "stored", status: "complete", offsetBytes: file.bytes.byteLength, contentHash, byteLength: file.bytes.byteLength, updatedAt: clock.now(), metadata: { ...(item.checkpoint.metadata as Record<string, JsonValue>), typedIngest: typedProjection.diagnostics } });
        events.push(await append(eventFactory.create({ episodeId, typeId: "EvidenceLinked", payload: { sourceVersionId, diagnostics: extracted.diagnostics } })));
        events.push(await append(eventFactory.create({ episodeId, typeId: "GraphUpdated", payload: builtGraph.diagnostics })));
      }
      const output = `ingested ${sources} source version(s), ${evidenceCount} evidence span(s), ${sumRecord(typedObservationCounts)} typed observation(s)`;
      const invalidateRuntimeCaches = Boolean(sources || evidenceCount || graphNodes || graphEdges || languageProfiles);
      onKernelStateMutation({ episodeId, output, invalidateRuntimeCaches });
      events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output, typedObservations: typedObservationCounts, observationRoutes: observationRouteCounts } })));

      return { episodeId, files: fileCount, sources, evidence: evidenceCount, graphNodes, graphEdges, languageProfiles, typedObservations: typedObservationCounts, observationRoutes: observationRouteCounts, skipped, events };
    
    }
  };
}
