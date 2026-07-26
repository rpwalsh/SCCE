import { createSourceAdmissionController } from "./admission.js";
import {
  compileCreativeEventCompatibilityCorpus,
  creativeEventCompatibilityCorpusLanguageText,
  parseCreativeEventCompatibilityCorpus
} from "./creative-event-compatibility.js";
import { createEventFactory } from "./events.js";
import { createEvidenceExtractor } from "./evidence.js";
import { createSourceGraphBuilder } from "./graphbuild.js";
import { createIdFactory } from "./ids.js";
import { routeStoreCounts, sumRecord } from "./ingestion-diagnostics.js";
import { inlineIngestStream } from "./inline-ingest-source.js";
import { jsonRecord, kernelString } from "./kernel-answer-primitives.js";
import { createLanguageMemoryRuntime } from "./language-memory-runtime.js";
import {
  compileLanguageTrainingBatch,
  observeLanguageTrainingSegmentation
} from "./language-training-batch.js";
import { corpusRoleIdForSourceSystem } from "./corpus-registry.js";
import {
  createLanguageAcquisitionEngine
} from "./language.js";
import { createClock, createHasher, toJsonValue } from "./primitives.js";
import {
  informationLabelAllowsRead,
  joinInformationLabels,
  normalizeInformationLabel
} from "./information-flow.js";
import {
  compileRequestRequirementCorpus,
  parseRequestRequirementCorpus,
  requestRequirementCorpusLanguageText
} from "./request-requirement-learning.js";
import type { ScceKernelDeps } from "./storage.js";
import {
  createTypedIngestProjector,
  graphFromStructuredSemanticCandidates
} from "./typed-ingest.js";
import {
  compileRelationPromotionModel
} from "./relation-promotion.js";
import { compileOpaqueRoleModel } from "./opaque-role-induction.js";
import { compileRoleSurfaceOrderModel } from "./role-surface-order.js";
import {
  compileSparseAlignmentTargetIndex,
  generateSparseAlignmentCandidates
} from "./sparse-alignment-candidates.js";
import { solveSparseFusedUnbalancedTransport } from "./sparse-fused-transport.js";
import { compileTypedNullCostModel } from "./typed-null-alignment.js";
import { compilePopulationOrderingModel } from "./population-ordering.js";
import { compileCrossDocumentAlignmentModel } from "./cross-document-alignment.js";
import {
  compileAlignmentAlternativeSet,
  alignmentAlternativeSeriesId,
  alignmentAlternativeSetsFromEventPayloads,
  extractAlignmentAlternatives
} from "./alignment-alternatives.js";
import {
  compileAlignmentCommunityRouting,
  compileCoarseToFineAlignmentResult
} from "./coarse-to-fine-alignment.js";
import { compileAlignmentCalibrationModel } from "./alignment-calibration.js";
import { compileAlignmentPromotionModel } from "./alignment-promotion.js";
import { compileAutomaticAlignmentEvaluation } from "./alignment-heldout-evaluation.js";
import {
  compileReversibleConstructionPattern,
  compileReversibleConstructions,
  reversibleConstructionCreationSnapshotId,
  reversibleConstructionProfileId
} from "./reversible-construction.js";
import {
  compilePairedAntiUnifiedConstructions,
  compilePairedAntiUnifiedPatterns
} from "./paired-anti-unification.js";
import {
  admittedPairedAntiUnifiedConstructions,
  compileGraphCorrelatedVariabilityModel
} from "./graph-correlated-variability.js";
import { allocateTransportEvidence } from "./transport-evidence-allocation.js";
import { buildSurfaceLattice } from "./surface-lattice.js";
import { evidenceSourceFamilyId } from "./source-family.js";
import { liftHyperedgesToTypedIncidenceGraph } from "./typed-incidence-graph.js";
import type { StructuredSemanticCandidate } from "./structured-semantic-candidate.js";
import type {
  EpisodeId,
  EvidenceSpan,
  IngestInput,
  IngestResult,
  JsonValue,
  InformationLabel,
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
      if (!deps.sourceInformationLabel || !deps.informationAccess) {
        throw new Error("ingestion requires an explicit information access context and source information label");
      }
      const informationLabel = input.informationLabel
        ? joinInformationLabels(
          [deps.sourceInformationLabel, input.informationLabel],
          { explicitMergeAuthority: deps.informationAccess.explicitMergeAuthority === true }
        )
        : normalizeInformationLabel(deps.sourceInformationLabel);
      if (!informationLabelAllowsRead(informationLabel, deps.informationAccess)) {
        throw new Error("ingestion information label is not authorized by the active access context");
      }

      const episodeId = idFactory.episodeId();
      const events: ScceEvent[] = [];
      events.push(await append(eventFactory.create({ episodeId, typeId: "OwnerAsked", payload: { ingest: input.path ?? input.uri ?? "inline", metadata: input.metadata ?? null } })));
      let sources = 0;
      let fileCount = 0;
      let evidenceCount = 0;
      let graphNodes = 0;
      let graphEdges = 0;
      let graphHyperedges = 0;
      let languageProfiles = 0;
      const typedObservationCounts: Record<string, number> = {};
      const observationRouteCounts: Record<string, number> = {};
      const relationCandidates: StructuredSemanticCandidate[] = [];
      const profileIdBySourceVersion = new Map<string, string>();
      const skipped: Array<{ path: string; reason: string }> = [];
      const stream = input.content !== undefined
        ? inlineIngestStream(input, clock.now(), hasher)
        : deps.files.streamPath(input.path ?? input.uri ?? ".", { metadata: input.metadata });
      for await (const item of stream) {
        if (item.type === "checkpoint") {
          await deps.storage.ingestion.put(item.checkpoint);
          continue;
        }
        if (item.type === "skipped") {
          await deps.storage.ingestion.put(item.checkpoint);
          skipped.push(item.skipped);
          continue;
        }
        const file = item.file;
        fileCount++;
        await deps.storage.transaction(async () => {
        await deps.storage.ingestion.put(item.checkpoint);
        const now = clock.now();
        const sourceId = idFactory.sourceId(file.namespace, file.uri);
        const originalContentHash = await deps.storage.blobs.put(file.bytes, file.mediaType);
        const originalSourceVersionId = idFactory.sourceVersionId(file.bytes);
        const originalSource: SourceVersion = {
          sourceId,
          sourceVersionId: originalSourceVersionId,
          namespace: file.namespace,
          canonicalUri: file.uri,
          contentHash: originalContentHash,
          mediaType: file.mediaType,
          observedAt: now,
          byteLength: file.bytes.byteLength,
          sourceTrust: input.sourceTrust,
          informationLabel,
          metadata: file.metadata,
          role: "original"
        };
        await deps.storage.evidence.putSourceVersion(originalSource);
        const derivative = file.evidenceDerivative;
        const sourceText = derivative?.text ?? file.text;
        const sourceBytes = derivative?.bytes ?? file.bytes;
        if (!Buffer.from(sourceText, "utf8").equals(Buffer.from(sourceBytes))) {
          throw new Error(`evidence derivative bytes do not encode source text: ${file.uri}`);
        }
        const derivativeMediaType = derivative ? "text/plain; charset=utf-8" : file.mediaType;
        const contentHash = derivative
          ? await deps.storage.blobs.put(sourceBytes, derivativeMediaType)
          : originalContentHash;
        const sourceVersionId = derivative
          ? idFactory.sourceVersionId(sourceBytes)
          : originalSourceVersionId;
        const source: SourceVersion = derivative
          ? {
            sourceId,
            sourceVersionId,
            namespace: file.namespace,
            canonicalUri: file.uri,
            contentHash,
            mediaType: derivativeMediaType,
            observedAt: now,
            byteLength: sourceBytes.byteLength,
            sourceTrust: input.sourceTrust,
            informationLabel,
            metadata: file.metadata,
            role: "evidence-derivative",
            derivation: {
              kind: derivative.kind,
              transformId: derivative.transformId,
              derivedFromSourceVersionId: originalSourceVersionId,
              originalCoordinateSpace: derivative.originalCoordinateSpace,
              redactionMap: derivative.redactionMap
            }
          }
          : originalSource;
        const requestRequirementCorpus = parseRequestRequirementCorpus(sourceText);
        const creativeEventCompatibilityCorpus = parseCreativeEventCompatibilityCorpus(sourceText);
        if (derivative) await deps.storage.evidence.putSourceVersion(source);
        events.push(await append(eventFactory.create({ episodeId, typeId: "SourceObserved", payload: { sourceId, uri: file.uri, namespace: file.namespace } })));
        events.push(await append(eventFactory.create({
          episodeId,
          typeId: "SourceVersionObserved",
          payload: {
            sourceVersionId: originalSourceVersionId,
            contentHash: originalContentHash,
            byteLength: file.bytes.byteLength,
            role: "original"
          }
        })));
        if (derivative) {
          events.push(await append(eventFactory.create({
            episodeId,
            typeId: "SourceVersionObserved",
            payload: {
              sourceVersionId,
              contentHash,
              byteLength: sourceBytes.byteLength,
              role: "evidence-derivative",
              derivedFromSourceVersionId: originalSourceVersionId,
              transformId: derivative.transformId
            }
          })));
        }
        sources += derivative ? 2 : 1;
        const preview = typedIngest.preview({ uri: file.uri, mediaType: file.mediaType, text: sourceText, metadata: file.metadata });
        const languageSurface = requestRequirementCorpus
          ? requestRequirementCorpusLanguageText(requestRequirementCorpus)
          : creativeEventCompatibilityCorpus
            ? creativeEventCompatibilityCorpusLanguageText(creativeEventCompatibilityCorpus)
          : preview.languageText || (preview.suppressRawLanguageTraining ? "" : sourceText);
        const profile = {
          ...language.acquire({ sourceVersionId, text: languageSurface, createdAt: now }),
          informationLabel
        };
        profileIdBySourceVersion.set(String(sourceVersionId), profile.id);
        const extracted = evidenceExtractor.extract({
          sourceId,
          sourceVersionId,
          namespace: file.namespace,
          uri: file.uri,
          mediaType: source.mediaType,
          text: sourceText,
          languageProfile: profile,
          sourceTrust: source.sourceTrust,
          observedAt: now,
          maxChunkBytes: deps.maxChunkBytes ?? 131072,
          metadata: file.metadata,
          exactSourceText: true
        });
        const decision = admission.decide({
          source,
          evidence: extracted.spans,
          context: input.sourceAdmission,
          metadata: file.metadata
        });
        await deps.storage.quarantine.put({
          id: `${sourceVersionId}:admission`,
          sourceId,
          sourceVersionId,
          uri: file.uri,
          contentHash,
          mediaType: file.mediaType,
          fetchedAt: now,
          trustVector: decision.audit,
          permissionVector: toJsonValue({
            disposition: decision.disposition,
            sourceAdmission: decision.context,
            activeInfluence: decision.activeInfluence,
            safetyRails: decision.safetyRails
          }),
          decision: decision.disposition === "reject" ? "rejected" : decision.disposition === "promote" ? "promoted" : "pending",
          decisionJson: decision.audit
        });
        events.push(await append(eventFactory.create({ episodeId, typeId: decision.disposition === "promote" ? "SourcePromoted" : "SourceQuarantined", payload: decision.audit })));
        if (decision.disposition === "reject") {
          events.push(await append(eventFactory.create({ episodeId, typeId: "FailureObserved", payload: { sourceVersionId, reasons: decision.reasons } })));
          return;
        }
        const actionByEvidence = new Map(decision.evidenceActions.map(action => [action.evidenceId, action]));
        const admittedSpans = extracted.spans.map(span => {
          const action = actionByEvidence.get(String(span.id));
          return {
            ...span,
            alpha: action?.action === "lower-alpha" ? Math.min(span.alpha, action.alpha) : span.alpha,
            status: decision.disposition === "promote" ? "promoted" as const : "quarantined" as const,
            informationLabel,
            trustVector: { ...(span.trustVector as Record<string, JsonValue>), admission: decision.audit, action: action?.action ?? "quarantine" }
          };
        });
        for (const span of admittedSpans) await deps.storage.blobs.put(Buffer.from(span.text, "utf8"), source.mediaType);
        if (deps.storage.evidence.putEvidenceSpans) await deps.storage.evidence.putEvidenceSpans(admittedSpans);
        else for (const span of admittedSpans) await deps.storage.evidence.putEvidenceSpan(span);
        evidenceCount += admittedSpans.length;
        if (decision.disposition !== "promote") {
          await deps.storage.ingestion.put({
            ...item.checkpoint,
            phase: "stored",
            status: "complete",
            offsetBytes: file.bytes.byteLength,
            contentHash: originalContentHash,
            byteLength: file.bytes.byteLength,
            updatedAt: clock.now(),
            metadata: {
              ...(item.checkpoint.metadata as Record<string, JsonValue>),
              admission: decision.audit,
              activeInfluence: decision.activeInfluence
            }
          });
          return;
        }
        if (decision.activeInfluence.language) {
          if (deps.storage.model.putLanguageProfiles) await deps.storage.model.putLanguageProfiles([profile]);
          else await deps.storage.model.putLanguageProfile(profile);
          events.push(await append(eventFactory.create({
            episodeId,
            typeId: "LanguagePatternLearned",
            payload: { profileId: profile.id, scripts: profile.scripts.slice(0, 4), entropy: profile.entropy }
          })));
          languageProfiles++;
        }
        const typedProjection = typedIngest.project({
          sourceId,
          sourceVersionId,
          uri: file.uri,
          mediaType: file.mediaType,
          text: sourceText,
          metadata: file.metadata,
          evidence: admittedSpans,
          observedAt: now
        });
        for (const [kind, count] of Object.entries(typedProjection.observationCounts)) typedObservationCounts[kind] = (typedObservationCounts[kind] ?? 0) + count;
        const routeCounts = routeStoreCounts(typedProjection.routes);
        for (const [store, count] of Object.entries(routeCounts)) observationRouteCounts[store] = (observationRouteCounts[store] ?? 0) + count;
        if (decision.activeInfluence.graph) {
          relationCandidates.push(...typedProjection.semanticCandidates);
          const typedGraphNodes = labelRecords(typedProjection.graphNodes, informationLabel);
          const typedGraphEdges = labelRecords(typedProjection.graphEdges, informationLabel);
          if (deps.storage.graph.upsertNodes) await deps.storage.graph.upsertNodes(typedGraphNodes);
          else for (const graphNode of typedGraphNodes) await deps.storage.graph.upsertNode(graphNode);
          if (deps.storage.graph.upsertEdges) await deps.storage.graph.upsertEdges(typedGraphEdges);
          else for (const graphEdge of typedGraphEdges) await deps.storage.graph.upsertEdge(graphEdge);
          const typedHyperedges = labelRecords(typedProjection.graphHyperedges, informationLabel);
          if (deps.storage.graph.upsertHyperedges) await deps.storage.graph.upsertHyperedges(typedHyperedges);
          else for (const hyperedge of typedHyperedges) await deps.storage.graph.upsertHyperedge(hyperedge);
          graphNodes += typedProjection.graphNodes.length;
          graphEdges += typedProjection.graphEdges.length;
          graphHyperedges += typedProjection.graphHyperedges.length;
          events.push(await append(eventFactory.create({ episodeId, typeId: "GraphUpdated", payload: { typedIngest: typedProjection.diagnostics } })));
        }

        const languageTrainingText = requestRequirementCorpus
          ? requestRequirementCorpusLanguageText(requestRequirementCorpus)
          : creativeEventCompatibilityCorpus
            ? creativeEventCompatibilityCorpusLanguageText(creativeEventCompatibilityCorpus)
          : typedProjection.languageText;
        if (decision.activeInfluence.language) {
        if (languageTrainingText.trim()) {
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
        const creativeEventCompatibilityLearning = creativeEventCompatibilityCorpus
          ? compileCreativeEventCompatibilityCorpus({
            corpus: creativeEventCompatibilityCorpus,
            profileId: profile.id,
            evidenceIds: admittedSpans.map(span => span.id),
            updatedAt: now,
            makeId: representation => String(idFactory.semanticId(
              "creative_event_compatibility_pattern",
              representation
            ))
          })
          : undefined;
        const compiledBatch = compileLanguageTrainingBatch({
          runtime: languageMemoryRuntime,
          hasher,
          batch: {
            streamId: file.uri,
            sourceSystem: kernelString(jsonRecord(file.metadata).sourceSystem),
            profile,
            sourceVersionId,
            text: languageTrainingText,
            evidence: admittedSpans,
            createdAt: now,
            maxOrder: 6,
            maxCountersPerOrder: 12000,
            vocabularyLimit: 24000,
            additionalPatterns: [
              ...(requestRequirementLearning?.patterns ?? []),
              ...(creativeEventCompatibilityLearning?.patterns ?? [])
            ]
          }
        });
        const sourceSystem = kernelString(jsonRecord(file.metadata).sourceSystem) ?? "workspace";
        await observeLanguageTrainingSegmentation({
          storage: deps.storage,
          batch: { text: languageTrainingText, createdAt: now },
          tenantId: informationLabel.tenantId,
          corpusRole: corpusRoleIdForSourceSystem(sourceSystem),
          activeImportVersion: kernelString(jsonRecord(file.metadata).activeImportVersion) ?? file.namespace,
          hasher
        });
        const observations = labelRecords(compiledBatch.observations, informationLabel);
        const models = labelRecords(compiledBatch.models, informationLabel);
        const units = labelRecords(compiledBatch.units, informationLabel);
        const learnedPatterns = labelRecords(compiledBatch.patterns, informationLabel);
        const semanticFrames = labelRecords(compiledBatch.semanticFrames, informationLabel);
        await deps.storage.languageMemory.putNgramObservationsBatch(observations);
        if (deps.storage.languageMemory.putNgramModels) await deps.storage.languageMemory.putNgramModels(models);
        else for (const model of models) await deps.storage.languageMemory.putNgramModel(model);
        if (deps.storage.languageMemory.putLanguageUnits) await deps.storage.languageMemory.putLanguageUnits(units);
        else for (const unit of units) await deps.storage.languageMemory.putLanguageUnit(unit);
        if (deps.storage.languageMemory.putLanguagePatterns) await deps.storage.languageMemory.putLanguagePatterns(learnedPatterns);
        else for (const pattern of learnedPatterns) await deps.storage.languageMemory.putLanguagePattern(pattern);
        if (deps.storage.languageMemory.putSemanticFrames) await deps.storage.languageMemory.putSemanticFrames(semanticFrames);
        else for (const frame of semanticFrames) await deps.storage.languageMemory.putSemanticFrame(frame);
        events.push(await append(eventFactory.create({
          episodeId,
          typeId: "SymbolPatternLearned",
          payload: requestRequirementLearning || creativeEventCompatibilityLearning
            ? toJsonValue({
              languageMemory: compiledBatch.audit,
              ...(requestRequirementLearning
                ? { requestRequirements: requestRequirementLearning.audit }
                : {}),
              ...(creativeEventCompatibilityLearning
                ? { creativeEventCompatibility: creativeEventCompatibilityLearning.audit }
                : {})
            })
            : compiledBatch.audit
        })));
        } else {
          events.push(await append(eventFactory.create({ episodeId, typeId: "SymbolPatternLearned", payload: { skipped: "no language-bearing observations", uri: file.uri, typedIngest: typedProjection.diagnostics } })));
        }
        }
        if (decision.activeInfluence.graph) {
          const builtGraph = graphBuilder.build({ sourceVersionId, uri: file.uri, mediaType: file.mediaType, languageProfile: profile, evidence: admittedSpans, observedAt: now });
          const builtGraphNodes = labelRecords(builtGraph.nodes, informationLabel);
          const builtGraphEdges = labelRecords(builtGraph.edges, informationLabel);
          const builtHyperedges = labelRecords(builtGraph.hyperedges, informationLabel);
          if (deps.storage.graph.upsertNodes) await deps.storage.graph.upsertNodes(builtGraphNodes);
          else for (const graphNode of builtGraphNodes) await deps.storage.graph.upsertNode(graphNode);
          if (deps.storage.graph.upsertEdges) await deps.storage.graph.upsertEdges(builtGraphEdges);
          else for (const graphEdge of builtGraphEdges) await deps.storage.graph.upsertEdge(graphEdge);
          if (deps.storage.graph.upsertHyperedges) await deps.storage.graph.upsertHyperedges(builtHyperedges);
          else for (const hyperedge of builtHyperedges) await deps.storage.graph.upsertHyperedge(hyperedge);
          graphNodes += builtGraph.nodes.length;
          graphEdges += builtGraph.edges.length;
          graphHyperedges += builtGraph.hyperedges.length;
          events.push(await append(eventFactory.create({ episodeId, typeId: "GraphUpdated", payload: builtGraph.diagnostics })));
        }
        await deps.storage.ingestion.put({ ...item.checkpoint, phase: "stored", status: "complete", offsetBytes: file.bytes.byteLength, contentHash: originalContentHash, byteLength: file.bytes.byteLength, updatedAt: clock.now(), metadata: { ...(item.checkpoint.metadata as Record<string, JsonValue>), typedIngest: typedProjection.diagnostics } });
        events.push(await append(eventFactory.create({ episodeId, typeId: "EvidenceLinked", payload: { sourceVersionId, diagnostics: extracted.diagnostics } })));
        });
      }
      const relationPromotionModel = compileRelationPromotionModel({
        candidates: relationCandidates,
        hasher
      });
      const opaqueRoleModel = compileOpaqueRoleModel({
        candidates: relationCandidates,
        promotionModel: relationPromotionModel,
        hasher
      });
      const roleSurfaceOrderModel = compileRoleSurfaceOrderModel({
        candidates: relationCandidates,
        promotionModel: relationPromotionModel,
        opaqueRoleModel,
        hasher
      });
      if (relationCandidates.length) {
        const promotedGraph = graphFromStructuredSemanticCandidates({
          candidates: relationCandidates,
          observedAt: clock.now(),
          ids: idFactory,
          hasher,
          relationPromotionModel,
          opaqueRoleModel
        });
        const promotedNodes = labelRecords(promotedGraph.nodes, informationLabel);
        const promotedEdges = labelRecords(promotedGraph.edges, informationLabel);
        if (deps.storage.graph.upsertNodes) await deps.storage.graph.upsertNodes(promotedNodes);
        else for (const node of promotedNodes) await deps.storage.graph.upsertNode(node);
        if (deps.storage.graph.upsertEdges) await deps.storage.graph.upsertEdges(promotedEdges);
        else for (const edge of promotedEdges) await deps.storage.graph.upsertEdge(edge);
        const promotedHyperedges = labelRecords(promotedGraph.hyperedges, informationLabel);
        if (deps.storage.graph.upsertHyperedges) await deps.storage.graph.upsertHyperedges(promotedHyperedges);
        else for (const hyperedge of promotedHyperedges) await deps.storage.graph.upsertHyperedge(hyperedge);
        graphHyperedges += promotedGraph.hyperedges.length;
        const incidenceGraph = liftHyperedgesToTypedIncidenceGraph({
          hyperedges: promotedGraph.hyperedges,
          hasher
        });
        const alignmentTargetIndex = compileSparseAlignmentTargetIndex({
          incidenceGraph,
          nodes: promotedGraph.nodes,
          hasher
        });
        const relationEvidenceIds = [...new Set(
          relationCandidates.flatMap(candidate => candidate.evidenceIds.map(String))
        )].sort();
        const relationEvidence = await deps.storage.evidence.getEvidenceBatch(
          relationEvidenceIds as EvidenceSpan["id"][]
        );
        let alignmentCandidateCount = 0;
        let alignmentSurfaceUnitCount = 0;
        let maximumAlignmentDegree = 0;
        const alignmentSupportIds: string[] = [];
        const routedAlignmentSupportIds: string[] = [];
        const alignmentCommunityRoutingIds: string[] = [];
        const transportPlanIds: string[] = [];
        let transportIterationCount = 0;
        let transportedCellCount = 0;
        const transportEvidenceAllocationIds: string[] = [];
        let unresolvedTransportEvidenceCount = 0;
        let unresolvedTransportEvidenceAllocationCount = 0;
        let maximumTransportEvidenceResidual = 0;
        const typedNullCostModelIds = new Set<string>();
        const populationOrderingModelIds = new Set<string>();
        const crossDocumentAlignmentModelIds = new Set<string>();
        const alignmentAlternativeSetIds: string[] = [];
        const alignmentAlternativeSets:
          ReturnType<typeof compileAlignmentAlternativeSet>[] = [];
        const coarseToFineAlignments:
          ReturnType<typeof compileCoarseToFineAlignmentResult>[] = [];
        const allAlignmentEvidenceAllocations:
          ReturnType<typeof allocateTransportEvidence>[] = [];
        const historicalAlignmentPayloads = (await deps.storage.events.readRange({
          typeId: "SparseAlignmentCandidatesCompiled",
          limit: 1_024
        })).map(event => event.payload);
        let retainedAlignmentHypothesisCount = 0;
        let omittedAlignmentSearchBranchCount = 0;
        let surfaceNullMass = 0;
        let graphImplicitMass = 0;
        const alignmentSupports:
          ReturnType<typeof generateSparseAlignmentCandidates>[] = [];
        const alignmentLattices:
          ReturnType<typeof buildSurfaceLattice>[] = [];
        for (const span of relationEvidence) {
          const lattice = buildSurfaceLattice({
            documentId: String(span.id),
            sourceFamilyId: evidenceSourceFamilyId(span),
            text: span.text,
            sourceVersionId: span.sourceVersionId,
            evidenceIds: [span.id],
            hasher
          });
          alignmentLattices.push(lattice);
          const support = generateSparseAlignmentCandidates({
            lattice,
            targetIndex: alignmentTargetIndex,
            hasher
          });
          alignmentSupportIds.push(support.id);
          alignmentCandidateCount += support.candidates.length;
          alignmentSurfaceUnitCount += support.rows.length;
          maximumAlignmentDegree = Math.max(
            maximumAlignmentDegree,
            ...support.rows.map(row => row.candidateIds.length)
          );
          alignmentSupports.push(support);
        }
        const alignmentCommunityRoutings = alignmentSupports.map(support =>
          compileAlignmentCommunityRouting({
            support,
            targetIndex: alignmentTargetIndex,
            hasher
          }));
        const routedAlignmentSupports = alignmentCommunityRoutings.map(routing => {
          alignmentCommunityRoutingIds.push(routing.id);
          routedAlignmentSupportIds.push(routing.routedSupport.id);
          return routing.routedSupport;
        });
        const typedNullCostModel = compileTypedNullCostModel({
          supports: routedAlignmentSupports,
          targetIndex: alignmentTargetIndex,
          hasher
        });
        const populationOrderingModel = compilePopulationOrderingModel({
          supports: routedAlignmentSupports,
          hasher
        });
        const initialTransportPlans = routedAlignmentSupports.map(support =>
          solveSparseFusedUnbalancedTransport({
            support,
            targetIndex: alignmentTargetIndex,
            typedNullCostModel,
            populationOrderingModel,
            hasher
          }));
        const crossDocumentAlignmentModel = compileCrossDocumentAlignmentModel({
          supports: routedAlignmentSupports,
          plans: initialTransportPlans,
          targetIndex: alignmentTargetIndex,
          hasher
        });
        const finalTransportPlans = routedAlignmentSupports.map(support =>
          solveSparseFusedUnbalancedTransport({
            support,
            targetIndex: alignmentTargetIndex,
            typedNullCostModel,
            populationOrderingModel,
            crossDocumentAlignmentModel,
            hasher
          }));
        for (let index = 0; index < finalTransportPlans.length; index++) {
          const support = routedAlignmentSupports[index]!;
          const transport = finalTransportPlans[index]!;
          transportPlanIds.push(transport.id);
          transportIterationCount += transport.iterations.length;
          transportedCellCount += transport.cells.length;
          typedNullCostModelIds.add(transport.typedNullCostModelId);
          populationOrderingModelIds.add(transport.populationOrderingModelId);
          if (transport.crossDocumentAlignmentModelId) {
            crossDocumentAlignmentModelIds.add(
              transport.crossDocumentAlignmentModelId
            );
          }
          surfaceNullMass += transport.rowMarginals.reduce(
            (sum, row) => sum + row.surfaceNullMass,
            0
          );
          graphImplicitMass += transport.columnMarginals.reduce(
            (sum, column) => sum + column.graphImplicitMass,
            0
          );
          const extractedAlternatives = extractAlignmentAlternatives({
            basePlan: transport,
            support,
            targetIndex: alignmentTargetIndex,
            typedNullCostModel,
            populationOrderingModel,
            crossDocumentAlignmentModel,
            hasher
          });
          const alternativeAllocations = extractedAlternatives.plans.map(plan =>
            allocateTransportEvidence({
              plan,
              support,
              hasher
            }));
          allAlignmentEvidenceAllocations.push(...alternativeAllocations);
          const seriesId = alignmentAlternativeSeriesId({
            support,
            targetIndex: alignmentTargetIndex,
            hasher
          });
          const alternativeSet = compileAlignmentAlternativeSet({
            seriesId,
            plans: extractedAlternatives.plans,
            evidenceAllocations: alternativeAllocations,
            predecessorSets: [
              ...alignmentAlternativeSetsFromEventPayloads(
                historicalAlignmentPayloads,
                seriesId
              ),
              ...alignmentAlternativeSets.filter(set => set.seriesId === seriesId)
            ],
            omittedSearchBranchCount: extractedAlternatives.omittedSearchBranchCount,
            hasher
          });
          alignmentAlternativeSetIds.push(alternativeSet.id);
          alignmentAlternativeSets.push(alternativeSet);
          coarseToFineAlignments.push(compileCoarseToFineAlignmentResult({
            routing: alignmentCommunityRoutings[index]!,
            primaryPlan: transport,
            alternativeSet,
            hasher
          }));
          retainedAlignmentHypothesisCount += alternativeSet.hypotheses.length;
          omittedAlignmentSearchBranchCount += alternativeSet.omittedSearchBranchCount;
          const allocation = alternativeAllocations.find(item =>
            item.transportPlanId === transport.id)!;
          transportEvidenceAllocationIds.push(allocation.id);
          unresolvedTransportEvidenceCount += allocation.unresolvedCandidateIds.length;
          unresolvedTransportEvidenceAllocationCount +=
            allocation.status === "unresolved_evidence" ? 1 : 0;
          maximumTransportEvidenceResidual = Math.max(
            maximumTransportEvidenceResidual,
            allocation.conservationResidual
          );
        }
        const alignmentHeldoutEvaluation =
          compileAutomaticAlignmentEvaluation({
            alternativeSets: alignmentAlternativeSets,
            supports: routedAlignmentSupports,
            referencePlans: finalTransportPlans,
            evidenceAllocations: allAlignmentEvidenceAllocations,
            targetIndex: alignmentTargetIndex,
            hasher
          });
        const alignmentCalibrationModel = compileAlignmentCalibrationModel({
          observations: alignmentHeldoutEvaluation.calibrationObservations,
          hasher
        });
        const alignmentPromotionModel = compileAlignmentPromotionModel({
          alternativeSets: alignmentAlternativeSets,
          observations: alignmentHeldoutEvaluation.promotionObservations,
          hasher
        });
        const reversibleConstructionCompilation =
          compileReversibleConstructions({
            alternativeSets: alignmentAlternativeSets,
            promotionModel: alignmentPromotionModel,
            calibrationModel: alignmentCalibrationModel,
            supports: routedAlignmentSupports,
            targetIndex: alignmentTargetIndex,
            lattices: alignmentLattices,
            evidenceAllocations: allAlignmentEvidenceAllocations,
            profileId: reversibleConstructionProfileId({
              sourceVersionIds: relationEvidence.map(span =>
                String(span.sourceVersionId)),
              populationPosteriors: routedAlignmentSupports.map(support =>
                support.populationPosterior),
              hasher
            }),
            profileIdBySourceVersion,
            creationSnapshotId: reversibleConstructionCreationSnapshotId({
              sourceVersionId: [...new Set(relationEvidence.map(span =>
                String(span.sourceVersionId)))].sort().join("\u001f"),
              graphNodeIds: promotedGraph.nodes.map(node => String(node.id)),
              graphEdgeIds: promotedGraph.edges.map(edge => String(edge.id)),
              hyperedgeIds: promotedGraph.hyperedges.map(edge => String(edge.id)),
              hasher
            }),
            createdAt: clock.now(),
            hasher
          });
        const reversibleConstructionPatterns =
          reversibleConstructionCompilation.constructions.map(
            compileReversibleConstructionPattern
          );
        const pairedAntiUnifiedCompilation =
          compilePairedAntiUnifiedConstructions({
            constructions: reversibleConstructionCompilation.constructions,
            createdAt: clock.now(),
            creationSnapshotId: `paired_anti_unification_snapshot.${
              hasher.digestHex(reversibleConstructionCompilation.constructions
                .map(construction => construction.id).sort()
                .join("\u001f")).slice(0, 40)
            }`,
            hasher
          });
        const pairedAntiUnifiedPatterns =
          (() => {
            const graphCorrelatedVariabilityModel =
              compileGraphCorrelatedVariabilityModel({
                constructions: pairedAntiUnifiedCompilation.constructions,
                hasher
              });
            const admitted = admittedPairedAntiUnifiedConstructions({
              constructions: pairedAntiUnifiedCompilation.constructions,
              model: graphCorrelatedVariabilityModel
            });
            return {
              graphCorrelatedVariabilityModel,
              admitted,
              patterns: admitted.flatMap(({ construction, admission }) =>
                compilePairedAntiUnifiedPatterns(construction, admission))
            };
          })();
        const labeledReversiblePatterns = labelRecords(
          [
            ...reversibleConstructionPatterns,
            ...pairedAntiUnifiedPatterns.patterns
          ],
          informationLabel
        );
        if (deps.storage.languageMemory.putLanguagePatterns) {
          await deps.storage.languageMemory.putLanguagePatterns(
            labeledReversiblePatterns
          );
        } else {
          for (const pattern of labeledReversiblePatterns) {
            await deps.storage.languageMemory.putLanguagePattern(pattern);
          }
        }
        events.push(await append(eventFactory.create({
          episodeId,
          typeId: "RelationPromotionCompiled",
          payload: toJsonValue({
            modelId: relationPromotionModel.id,
            opaqueRoleModelId: opaqueRoleModel.id,
            roleSurfaceOrderModelId: roleSurfaceOrderModel.id,
            candidateCount: relationCandidates.length,
            promotedRelationSeedIds: relationPromotionModel.decisions
              .filter(decision => decision.promoted)
              .map(decision => decision.relationSeedId),
            decisions: relationPromotionModel.decisions.map(decision => ({
              relationSeedId: decision.relationSeedId,
              promoted: decision.promoted,
              gainNats: decision.descriptionLength.gainNats,
              recoveryGain: decision.recovery.gain,
              reasons: decision.reasons
            }))
          })
        })));
        events.push(await append(eventFactory.create({
          episodeId,
          typeId: "SparseAlignmentCandidatesCompiled",
          payload: toJsonValue({
            schema: "scce.sparse_alignment_candidate_batch.v1",
            incidenceGraphId: incidenceGraph.id,
            targetIndexId: alignmentTargetIndex.id,
            evidenceCount: relationEvidence.length,
            surfaceUnitCount: alignmentSurfaceUnitCount,
            candidateCount: alignmentCandidateCount,
            maximumCandidateDegree: maximumAlignmentDegree,
            supportIds: alignmentSupportIds,
            routedSupportIds: routedAlignmentSupportIds,
            communityRoutingIds: alignmentCommunityRoutingIds,
            communityCount: alignmentCommunityRoutings.reduce(
              (sum, routing) => sum + routing.communities.length,
              0
            ),
            transportPlanIds,
            transportIterationCount,
            transportedCellCount,
            transportEvidenceAllocationIds,
            unresolvedTransportEvidenceCount,
            unresolvedTransportEvidenceAllocationCount,
            maximumTransportEvidenceResidual,
            evidenceMassConserved: unresolvedTransportEvidenceAllocationCount === 0,
            typedNullCostModelIds: [...typedNullCostModelIds].sort(),
            typedNullCostsCalibrated: false,
            populationOrderingModelIds: [...populationOrderingModelIds].sort(),
            crossDocumentAlignmentModelIds:
              [...crossDocumentAlignmentModelIds].sort(),
            alignmentAlternativeSetIds,
            alignmentAlternativeSets,
            coarseToFineAlignments,
            alignmentCalibrationModel,
            alignmentPromotionModel,
            alignmentHeldoutEvaluation,
            reversibleConstructions:
              reversibleConstructionCompilation.constructions,
            reversibleConstructionRejections:
              reversibleConstructionCompilation.rejections,
            pairedAntiUnifiedConstructions:
              pairedAntiUnifiedCompilation.constructions,
            pairedAntiUnifiedConstructionRejections:
              pairedAntiUnifiedCompilation.rejections,
            graphCorrelatedVariabilityModel:
              pairedAntiUnifiedPatterns.graphCorrelatedVariabilityModel,
            admittedPairedAntiUnifiedConstructions:
              pairedAntiUnifiedPatterns.admitted.map(row => row.construction),
            retainedAlignmentHypothesisCount,
            omittedAlignmentSearchBranchCount,
            alignmentPosteriorScope: "retained_candidate_set_only",
            exactGlobalAlignmentPosteriorClaimed: false,
            surfaceNullMass,
            graphImplicitMass,
            transportSolver: "scce.sparse_fused_unbalanced_transport.v1",
            globalOptimalityClaimed: false,
            candidateMemory: "O(|S|*K_pi)",
            denseMatrixMaterialized: false
          })
        })));
      }
      const output = `ingested ${sources} source version(s), ${evidenceCount} evidence span(s), ${sumRecord(typedObservationCounts)} typed observation(s)`;
      const invalidateRuntimeCaches = Boolean(sources || evidenceCount || graphNodes || graphEdges || graphHyperedges || languageProfiles);
      onKernelStateMutation({ episodeId, output, invalidateRuntimeCaches });
      events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output, typedObservations: typedObservationCounts, observationRoutes: observationRouteCounts } })));

      return {
        episodeId,
        files: fileCount,
        sources,
        evidence: evidenceCount,
        graphNodes,
        graphEdges,
        graphHyperedges,
        languageProfiles,
        relationCandidates: relationCandidates.length,
        promotedRelations: relationPromotionModel.decisions.filter(decision => decision.promoted).length,
        relationPromotionModelId: relationPromotionModel.id,
        opaqueRoleModelId: opaqueRoleModel.id,
        roleSurfaceOrderModelId: roleSurfaceOrderModel.id,
        typedObservations: typedObservationCounts,
        observationRoutes: observationRouteCounts,
        skipped,
        events
      };
    
    }
  };
}

function labelRecords<T extends { informationLabel?: InformationLabel }>(
  records: readonly T[],
  informationLabel: InformationLabel
): Array<T & { informationLabel: InformationLabel }> {
  return records.map(record => ({ ...record, informationLabel }));
}
