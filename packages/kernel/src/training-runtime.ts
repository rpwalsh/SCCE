// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createEventFactory } from "./events.js";
import { createAlphaFieldEngine } from "./field.js";
import { createIdFactory } from "./ids.js";
import { createLanguageMemoryRuntime } from "./language-memory-runtime.js";
import { sourceLanguageTrainingStreamId } from "./source-language-training-identity.js";
import { LANGUAGE_CONSTRUCTION_PUBLICATION, publishCompiledLanguagePatterns } from "./language-pattern-publication.js";
import { sourceCompilationChunkCount, sourceCompilationModelReadLimit, sourceLanguageCompilationReceiptIdForModels, validateSourceCompilationArtifactInventory, validateSourceCompilationReceipt, validateSourceLanguageCompilation } from "./source-language-compilation.js";
import {
  compileLanguageTrainingBatch,
  observeLanguageTrainingSegmentation
} from "./language-training-batch.js";
import { languageMemoryPatternsFromInducedLanguageModel } from "./language-induction-memory.js";
import { SEGMENTATION_POPULATION_SCHEMA } from "./segmentation-population.js";
import { CORPUS_ROLE_IDS, canonicalCorpusSourceSystemId, corpusSourceAlias, corpusRoleIdForSourceSystem, DEFAULT_NGRAM_SETTINGS } from "./corpus-registry.js";
import {
  createLanguageAcquisitionEngine
} from "./language.js";
import { createWeightedFeatureSketchLearner } from "./latent.js";
import { createLearningLoop } from "./learning-loop.js";
import { createLearningController } from "./learning.js";
import { createPredictionLayer } from "./prediction.js";
import { createClock, createHasher, toJsonValue } from "./primitives.js";
import { joinInformationLabels } from "./information-flow.js";
import { jsonRecord, kernelString } from "./kernel-answer-primitives.js";
import { createFunctionalConsciousnessScore, createSpectralSelfDistillation } from "./self-distillation.js";
import { createFunctionalSelfModel } from "./self.js";
import type { ScceKernelDeps } from "./storage.js";
import { createTrainingOrchestrator } from "./training-orchestrator.js";
import type {
  EpisodeId,
  EvidenceSpan,
  GraphSnapshot,
  JsonValue,
  LanguageProfile,
  PolicyProfile,
  ScceEvent,
  TrainInput,
  TrainResult
} from "./types.js";
import { redactTraceValue, summarizeForTrace } from "./debug/trace.js";
import { estimateAlignmentCostMs } from "./runtime-cost-estimate.js";

function groupProbe(phase: string, extra: Record<string, unknown> = {}): void {
  if (!process.env.SCCE_TRAIN_PROBE) return;
  const m = process.memoryUsage();
  process.stderr.write(`GRP ${phase} heap=${Math.round(m.heapUsed / 1048576)} rss=${Math.round(m.rss / 1048576)} ${JSON.stringify(summarizeForTrace(redactTraceValue(extra), 400))}
`);
}

export function createTrainingRuntime(options: {
  deps: ScceKernelDeps;
  clock: ReturnType<typeof createClock>;
  idFactory: ReturnType<typeof createIdFactory>;
  eventFactory: ReturnType<typeof createEventFactory>;
  featureSketchLearner: ReturnType<typeof createWeightedFeatureSketchLearner>;
  learning: ReturnType<typeof createLearningController>;
  learningLoop: ReturnType<typeof createLearningLoop>;
  trainingOrchestrator: ReturnType<typeof createTrainingOrchestrator>;
  language: ReturnType<typeof createLanguageAcquisitionEngine>;
  languageMemoryRuntime: ReturnType<typeof createLanguageMemoryRuntime>;
  fieldEngine: ReturnType<typeof createAlphaFieldEngine>;
  prediction: ReturnType<typeof createPredictionLayer>;
  ssd: ReturnType<typeof createSpectralSelfDistillation>;
  fcs: ReturnType<typeof createFunctionalConsciousnessScore>;
  policy: PolicyProfile;
  failures: string[];
  append(event: ScceEvent): Promise<ScceEvent>;
  invalidateRuntimeCaches(): void;
  onKernelStateMutation(input: { episodeId: EpisodeId; output: string }): void;
}) {
  const {
    deps, clock, idFactory, eventFactory, featureSketchLearner, learning, learningLoop,
    trainingOrchestrator, language, languageMemoryRuntime, fieldEngine, prediction, ssd, fcs,
    policy, failures, append, invalidateRuntimeCaches, onKernelStateMutation
  } = options;
  const hasher = createHasher();


  function trainingPromotionEvidenceIds(plan: { promotion: readonly { evidenceId: string; promote: boolean }[] }): EvidenceSpan["id"][] {
    return [...new Set(plan.promotion.filter(item => item.promote).map(item => item.evidenceId))]
      .map(id => id as EvidenceSpan["id"]);
  }


  function trainingPromotionReason(
    input: TrainInput,
    plan: { promotion: { reasons: Array<{ sourceVersionId: string; action: string; score: number }> } },
    trainingPlan: { id: string; promotion: readonly { evidenceId: string; promote: boolean; score: number }[] }
  ): string {
    const selected = trainingPlan.promotion
      .filter(item => item.promote)
      .slice(0, 24)
      .map(item => `${item.evidenceId}:${item.score.toFixed(3)}`)
      .join("|");
    const sourcePlan = plan.promotion.reasons
      .slice(0, 12)
      .map(item => `${item.sourceVersionId}:${item.action}:${item.score.toFixed(3)}`)
      .join("|");
    return `training promotion minTrust=${input.config.promotion?.minTrust ?? 0.5}; trainingPlan=${trainingPlan.id}; selected=${selected}; sourcePlan=${sourcePlan}`;
  }


  async function persistTrainingLanguageMemory(
    evidence: readonly EvidenceSpan[],
    existingProfiles: readonly LanguageProfile[],
    trainingPlanId: string,
    graphSnapshot: GraphSnapshot
  ): Promise<{ profiles: LanguageProfile[]; audit: JsonValue }> {
    if (!evidence.length) {
      return { profiles: [...existingProfiles], audit: toJsonValue({ source: "kernel.train.language_memory", skipped: "no promoted evidence selected", observations: 0, models: 0, units: 0, patterns: 0, semanticFrames: 0, profilesCreated: 0 }) };
    }
    const profiles = [...existingProfiles];
    const profileBySourceVersion = new Map(profiles.map(profile => [String(profile.sourceVersionId), profile]));
    const groups = new Map<string, EvidenceSpan[]>();
    for (const span of evidence) groups.set(String(span.sourceVersionId), [...(groups.get(String(span.sourceVersionId)) ?? []), span]);
    let observations = 0;
    let models = 0;
    let units = 0;
    let patterns = 0;
    let semanticFrames = 0;
    let graphSurfaceAlignments = 0;
    let estimatedAlignmentCostMs = 0;
    let sparseAlignmentCandidateSupports = 0;
    let sparseAlignmentCandidates = 0;
    let sparseTransportPlans = 0;
    let sparseTransportCells = 0;
    let transportEvidenceAllocations = 0;
    let unresolvedTransportEvidenceAllocations = 0;
    let typedNullCostModels = 0;
    let populationOrderingModels = 0;
    let crossDocumentAlignmentModels = 0;
    let alignmentAlternativeSets = 0;
    let retainedAlignmentHypotheses = 0;
    let alignmentCommunityRoutings = 0;
    let coarseToFineAlignments = 0;
    let calibratedAlignmentModels = 0;
    let promotedAlignmentPlans = 0;
    let reversibleConstructions = 0;
    let reversibleConstructionRejections = 0;
    let pairedAntiUnifiedConstructions = 0;
    let pairedAntiUnifiedConstructionRejections = 0;
    let admittedPairedAntiUnifiedConstructions = 0;
    let graphCorrelatedVariabilityModels = 0;
    let optionalNullRealizationModels = 0;
    let calibratedOptionalNullRealizationModels = 0;
    let surfaceNullMass = 0;
    let graphImplicitMass = 0;
    let profilesCreated = 0;
    let reusedSourceGroups = 0;
    let reusedModels = 0;
    // Heap-safety bound, mirroring the wikipedia ingestor's own proven
    // stopDecision(): sample real heap between groups and stop cleanly
    // rather than letting V8 abort the process. A confirmed OOM here
    // (3398MB peak against a 3072MB cap) took the whole server down with
    // zero recoverable output; a graceful stop keeps everything already
    // persisted and reports honestly that the pass was truncated.
    const heapBoundMb = trainingHeapBoundMb();
    let stoppedByHeapSafetyBound = false;
    let groupsProcessed = 0;
    for (const spans of groups.values()) {
      const first = spans[0];
      if (!first) continue;
      if (heapBoundMb > 0 && trainingHeapMb() >= heapBoundMb) {
        stoppedByHeapSafetyBound = true;
        failures.push(`training language memory stopped by heap safety bound (${trainingHeapMb()} MiB >= ${heapBoundMb} MiB) after ${groupsProcessed} of ${groups.size} source groups`);
        break;
      }
      groupsProcessed++;
      groupProbe("begin", { g: groupsProcessed, of: groups.size, spans: spans.length, chars: spans.reduce((n, sp) => n + sp.text.length, 0) });
      const sourceVersionId = first.sourceVersionId;
      if (spans.some(span => !span.informationLabel)) {
        throw new Error(`training evidence for ${sourceVersionId} is missing an information label`);
      }
      if (spans.some(span => span.sourceId !== first.sourceId)) throw new Error(`training source version ${sourceVersionId} has conflicting owners`);
      const declarations = spans.map(span => {
        const provenance = jsonRecord(span.provenance);
        const metadata = jsonRecord(provenance.metadata);
        const names = [provenance.sourceSystem, metadata.sourceSystem].map(kernelString).filter((value): value is string => Boolean(value));
        const ids = [provenance.sourceSystemId, metadata.sourceSystemId].map(kernelString).filter((value): value is string => Boolean(value));
        const unique = [...new Set([...ids, ...names.map(canonicalCorpusSourceSystemId)])];
        if (unique.length !== 1) throw new Error(`training evidence ${span.id} requires one declared source system`);
        return { id: unique[0]!, name: names.length ? corpusSourceAlias(names[0]!) : corpusSourceAlias(unique[0]!) };
      });
      if (new Set(declarations.map(value => value.id)).size !== 1) throw new Error(`training source version ${sourceVersionId} has conflicting source systems`);
      const sourceSystem = declarations[0]!.name;
      let existingProfile = profileBySourceVersion.get(String(sourceVersionId));
      if (!existingProfile) {
        const ownedProfiles = await deps.storage.model.listLanguageProfiles({ sourceVersionIds: [sourceVersionId], limit: 2 });
        if (ownedProfiles.length > 1) throw new Error(`training source version ${sourceVersionId} has ambiguous language profiles`);
        existingProfile = ownedProfiles[0];
      }
      const informationLabel = joinInformationLabels(
        [
          ...spans.map(span => span.informationLabel!),
          ...(existingProfile?.informationLabel ? [existingProfile.informationLabel] : [])
        ],
        { explicitMergeAuthority: deps.informationAccess?.explicitMergeAuthority === true }
      );
      const ownedSources = await deps.storage.evidence.sourceVersionsForEvidence(spans.map(span => span.id));
      if (ownedSources.length !== 1 || ownedSources[0]!.sourceVersionId !== sourceVersionId || ownedSources[0]!.sourceId !== first.sourceId) {
        throw new Error(`training source version ${sourceVersionId} requires its exact owned canonical source`);
      }
      const source = ownedSources[0]!;
      const sourceMetadata = jsonRecord(source.metadata);
      const declaredSourceSystem = kernelString(sourceMetadata.sourceSystemId) ?? (kernelString(sourceMetadata.sourceSystem) ? canonicalCorpusSourceSystemId(kernelString(sourceMetadata.sourceSystem)!) : undefined);
      if (declaredSourceSystem !== declarations[0]!.id) throw new Error(`training source version ${sourceVersionId} has a different canonical source system`);
      const bytes = await deps.storage.blobs.get(source.contentHash);
      if (bytes.byteLength !== source.byteLength || hasher.digestHex(bytes) !== String(source.contentHash).replace(/^sha256_/u, "")) throw new Error(`training source blob ${sourceVersionId} changed`);
      const text = Buffer.from(bytes).toString("utf8");
      if (!Buffer.from(text, "utf8").equals(Buffer.from(bytes))) throw new Error(`training source ${sourceVersionId} requires a canonical text projection`);
      for (const span of spans) {
        if (Buffer.from(bytes).subarray(span.byteStart, span.byteEnd).toString("utf8") !== span.text) throw new Error(`training evidence ${span.id} does not bind its canonical source bytes`);
      }
      if (existingProfile) {
        const current = await deps.storage.languageMemory.listNgramModels({ profileIds: [existingProfile.id], sourceSystem,
          limit: sourceCompilationModelReadLimit(text.length) });
        const receiptId = sourceLanguageCompilationReceiptIdForModels({ owner: { sourceId: source.sourceId, sourceVersionId, contentHash: source.contentHash },
          profileId: existingProfile.id, sourceSystem, models: current, hasher });
        const receipts = await deps.storage.languageMemory.listLanguagePatterns({ profileIds: [existingProfile.id], sourceSystem,
          patternKind: "source_compilation", patternSchemas: ["scce.source_language_compilation_receipt.v1"],
          patternIds: receiptId ? [receiptId] : [], limit: 1 });
        const receipt = receipts[0] ? jsonRecord(receipts[0].patternJson).compilation : undefined;
        if (!receipt) {
          const existingArtifacts = await Promise.all([
            deps.storage.languageMemory.listLanguageUnits({ profileIds: [existingProfile.id], limit: 1 }),
            deps.storage.languageMemory.listLanguagePatterns({ profileIds: [existingProfile.id], limit: 1 }),
            deps.storage.languageMemory.listSemanticFrames({ profileIds: [existingProfile.id], limit: 1 })
          ]);
          if (!current.length && existingArtifacts.some(rows => rows.length)) throw new Error("canonical source compilation model inventory is incomplete");
          if (current.length) throw new Error("canonical source compilation is missing its receipt");
        }
        if (receipt) {
          sourceCompilationChunkCount(receipt, bytes.byteLength);
          validateSourceCompilationReceipt(receipt, current, hasher);
        }
        const reused = validateSourceLanguageCompilation({ owner: { sourceId: source.sourceId, sourceVersionId, contentHash: source.contentHash },
          profileId: existingProfile.id, sourceSystem, models: current, hasher });
        const requiresConstructionProjection = reused && jsonRecord(reused.options).languageOnly !== true
          && corpusRoleIdForSourceSystem(sourceSystem) !== CORPUS_ROLE_IDS.softwareSymbolic;
        const activeConstructionProjection = reused && requiresConstructionProjection && deps.storage.languageMemory.getLanguagePatternProjection
          ? await deps.storage.languageMemory.getLanguagePatternProjection({ ...LANGUAGE_CONSTRUCTION_PUBLICATION,
            profileId: existingProfile.id, sourceId: source.sourceId, sourceVersionId, sourceSystem, informationLabel,
            sourceCompilationId: reused.compilationId }) : undefined;
        if (reused && (!requiresConstructionProjection || activeConstructionProjection)) {
          if (jsonRecord(receipt).compilationId !== reused.compilationId) throw new Error("canonical source compilation receipt does not own its models");
          const listArtifacts = deps.storage.languageMemory.listSourceCompilationArtifactIds;
          if (!listArtifacts) throw new Error("canonical language replay requires its durable artifact inventory");
          await validateSourceCompilationArtifactInventory({ compilation: reused, profileId: existingProfile.id, hasher,
            list: query => listArtifacts.call(deps.storage.languageMemory, query) });
          if (!profileBySourceVersion.has(String(sourceVersionId))) { profiles.push(existingProfile); profileBySourceVersion.set(String(sourceVersionId), existingProfile); }
          reusedSourceGroups++;
          reusedModels += reused.models;
          continue;
        }
      }
      if (source.mediaType.toLocaleLowerCase().includes("html") || source.mediaType.toLocaleLowerCase().includes("xml")
        || (!source.mediaType.toLocaleLowerCase().startsWith("text/") && corpusRoleIdForSourceSystem(sourceSystem) !== CORPUS_ROLE_IDS.softwareSymbolic)) {
        throw new Error(`training source ${sourceVersionId} requires a canonical learning projection from its source producer`);
      }
      let profile = existingProfile;
      const createsProfile = !profile;
      if (!profile) {
        profile = { ...language.acquire({ sourceVersionId, text, createdAt: clock.now() }), informationLabel };
      }
      const trainedAt = clock.now();
      groupProbe("acquired", { g: groupsProcessed });
      // Alignment must be LOCAL: pair this group's surface with the graph
      // derived from this group's own evidence, exactly as the ingestion
      // path does. Passing the same global corpus slice to every group made
      // each group align 126KB of text against ~700 unrelated hyperedges --
      // measured at >8 minutes and >1GB for ONE group of two hundred, i.e.
      // O(groups x corpus) work for pairings that are semantically wrong
      // anyway (a surface has no business aligning to another source's
      // relations). An empty local graph legitimately skips alignment.
      const groupSpanIds = new Set(spans.map(span => String(span.id)));
      const groupHyperedges = graphSnapshot.hyperedges.filter(edge =>
        edge.evidenceIds.some(id => groupSpanIds.has(String(id))));
      const groupNodeIds = new Set(groupHyperedges.flatMap(edge => edge.memberNodeIds.map(String)));
      const groupSnapshot = groupHyperedges.length
        ? {
          nodes: graphSnapshot.nodes.filter(node => groupNodeIds.has(String(node.id))),
          edges: graphSnapshot.edges.filter(edge => groupNodeIds.has(String(edge.source)) && groupNodeIds.has(String(edge.target))),
          hyperedges: groupHyperedges
        }
        : undefined;
      const memory = compileLanguageTrainingBatch({
        runtime: languageMemoryRuntime,
        hasher,
        batch: {
          streamId: sourceLanguageTrainingStreamId({ sourceId: first.sourceId, sourceVersionId, sourceSystem, hasher }),
          sourceSystem,
          profile,
          sourceVersionId,
          canonicalSource: { sourceId: source.sourceId, contentHash: source.contentHash },
          text,
          evidence: spans,
          createdAt: trainedAt,
          // Measured, not assumed: orders 6 through 9 are identical on this corpus (no 6-gram context recurs) and
          // cost several times the training; see tools/prose-order-calibration.
          maxOrder: DEFAULT_NGRAM_SETTINGS.maxOrder,
          maxCountersPerOrder: 12000,
          retainNgramObservations: false,
          vocabularyLimit: 24000,
          ...(groupSnapshot ? { graphSnapshot: groupSnapshot } : {})
        }
      });
      // What this group's alignment work is expected to cost, priced by the same measured estimator the turn deadline
      // uses, so a slow training pass is visible as a number rather than a stall.
      estimatedAlignmentCostMs += estimateAlignmentCostMs(text.length);
      groupProbe("compiled", { g: groupsProcessed, estimatedAlignmentCostMs: Math.round(estimatedAlignmentCostMs) });
      const groupProfile = profile;
      await deps.storage.transaction(async () => {
        if (createsProfile) await deps.storage.model.putLanguageProfile(groupProfile);
        await observeLanguageTrainingSegmentation({
          storage: deps.storage,
          batch: { text, createdAt: trainedAt },
          tenantId: informationLabel.tenantId,
          corpusRole: corpusRoleIdForSourceSystem(sourceSystem),
          activeImportVersion: trainingPlanId,
          hasher
        });
        for (const model of memory.models) await deps.storage.languageMemory.putNgramModel({ ...model, informationLabel });
        for (const unit of memory.units) await deps.storage.languageMemory.putLanguageUnit({ ...unit, informationLabel });
        await publishCompiledLanguagePatterns({ store: deps.storage.languageMemory,
          owner: { sourceId: source.sourceId, sourceVersionId, contentHash: source.contentHash }, profileId: groupProfile.id,
          sourceSystem, informationLabel, patterns: memory.patterns, projections: [LANGUAGE_CONSTRUCTION_PUBLICATION] });
        for (const frame of memory.semanticFrames) await deps.storage.languageMemory.putSemanticFrame({ ...frame, informationLabel });
      });
      if (!profileBySourceVersion.has(String(sourceVersionId))) {
        profiles.push(groupProfile);
        profileBySourceVersion.set(String(sourceVersionId), groupProfile);
      }
      if (createsProfile) profilesCreated++;
      observations += memory.observations.length;
      models += memory.models.length;
      units += memory.units.length;
      patterns += memory.patterns.length;
      semanticFrames += memory.semanticFrames.length;
      graphSurfaceAlignments += memory.graphSurfaceAlignmentSummaries.length;
      sparseAlignmentCandidateSupports += memory.sparseAlignmentCandidateSupports.length;
      sparseAlignmentCandidates += memory.sparseAlignmentCandidateSupports.reduce(
        (sum, support) => sum + support.candidates.length,
        0
      );
      sparseTransportPlans += memory.sparseTransportPlans.length;
      sparseTransportCells += memory.sparseTransportPlans.reduce(
        (sum, plan) => sum + plan.cells.length,
        0
      );
      transportEvidenceAllocations += memory.transportEvidenceAllocations.length;
      unresolvedTransportEvidenceAllocations += memory.transportEvidenceAllocations
        .filter(allocation => allocation.status === "unresolved_evidence").length;
      typedNullCostModels += memory.typedNullCostModel ? 1 : 0;
      populationOrderingModels += memory.populationOrderingModel ? 1 : 0;
      crossDocumentAlignmentModels += memory.crossDocumentAlignmentModel ? 1 : 0;
      alignmentAlternativeSets += memory.alignmentAlternativeSets.length;
      retainedAlignmentHypotheses += memory.alignmentAlternativeSets.reduce(
        (sum, set) => sum + set.hypotheses.length,
        0
      );
      alignmentCommunityRoutings += memory.alignmentCommunityRoutings.length;
      coarseToFineAlignments += memory.coarseToFineAlignments.length;
      calibratedAlignmentModels +=
        memory.alignmentCalibrationModel.status === "calibrated" ? 1 : 0;
      promotedAlignmentPlans += memory.alignmentPromotionModel.decisions.filter(
        decision => decision.promoted
      ).length;
      reversibleConstructions += memory.reversibleConstructions.length;
      reversibleConstructionRejections +=
        memory.reversibleConstructionRejections.length;
      pairedAntiUnifiedConstructions +=
        memory.pairedAntiUnifiedConstructions.length;
      pairedAntiUnifiedConstructionRejections +=
        memory.pairedAntiUnifiedConstructionRejections.length;
      admittedPairedAntiUnifiedConstructions +=
        memory.admittedPairedAntiUnifiedConstructions.length;
      graphCorrelatedVariabilityModels += 1;
      optionalNullRealizationModels += 1;
      calibratedOptionalNullRealizationModels +=
        memory.optionalNullRealizationModel.status === "ready" ? 1 : 0;
      surfaceNullMass += memory.sparseTransportPlans.reduce(
        (sum, plan) => sum + plan.rowMarginals.reduce(
          (rowSum, row) => rowSum + row.surfaceNullMass,
          0
        ),
        0
      );
      graphImplicitMass += memory.sparseTransportPlans.reduce(
        (sum, plan) => sum + plan.columnMarginals.reduce(
          (columnSum, column) => columnSum + column.graphImplicitMass,
          0
        ),
        0
      );
    }
    return {
      profiles,
      audit: toJsonValue({
        source: "kernel.train.language_memory",
        stoppedByHeapSafetyBound,
        sourceGroupsProcessed: groupsProcessed,
        sourceGroupsTotal: groups.size,
        heapBoundMb: heapBoundMb,
        heapMbAtExit: trainingHeapMb(),
        evidenceSpans: evidence.length,
        sourceVersions: groups.size,
        profilesCreated,
        reusedSourceGroups, reusedModels,
        observations,
        models,
        units,
        patterns,
        semanticFrames,
        graphSurfaceAlignments,
        estimatedAlignmentCostMs: Math.round(estimatedAlignmentCostMs),
        sparseAlignmentCandidateSupports,
        sparseAlignmentCandidates,
        sparseTransportPlans,
        sparseTransportCells,
        transportEvidenceAllocations,
        unresolvedTransportEvidenceAllocations,
        typedNullCostModels,
        populationOrderingModels,
        crossDocumentAlignmentModels,
        alignmentAlternativeSets,
        retainedAlignmentHypotheses,
        alignmentCommunityRoutings,
        coarseToFineAlignments,
        calibratedAlignmentModels,
        promotedAlignmentPlans,
        reversibleConstructions,
        reversibleConstructionRejections,
        pairedAntiUnifiedConstructions,
        pairedAntiUnifiedConstructionRejections,
        admittedPairedAntiUnifiedConstructions,
        graphCorrelatedVariabilityModels,
        optionalNullRealizationModels,
        calibratedOptionalNullRealizationModels,
        surfaceNullMass,
        graphImplicitMass
      })
    };
  }

  return {
    async train(input: TrainInput): Promise<TrainResult> {

      const episodeId = idFactory.episodeId();
      const events: ScceEvent[] = [];
      let model = await deps.storage.model.readModel();
      // queryNodes (postgres.ts) returns zero rows for a filterless query
      // unless allowLatestFallback is set -- a fresh corpus's first train()
      // call has no seedNodeIds/evidenceIds/feature filter to give this
      // bootstrap query, so without this flag the whole pipeline silently
      // finds nothing to promote (plan item 15).
      const slice = await deps.storage.graph.getSlice({ limitNodes: 2000, limitEdges: 4000, allowLatestFallback: true });
      const featureSketches = featureSketchLearner.learn(slice.nodes, 24);
      const pending = await deps.storage.quarantine.listPending({ limit: 500 });
      let profiles = await deps.storage.model.listLanguageProfiles(200);
      const evidenceForLearning = (await deps.storage.evidence.searchEvidence({ features: [...new Set(slice.nodes.flatMap(node => node.features.slice(0, 16)))].slice(0, 128), limit: 200 })).map(item => item.span);
      const plan = learning.plan({ config: input.config, model, graph: slice, pending, profiles, candidateEvidence: evidenceForLearning });
      const eviPlan = learningLoop.plan({ goals: input.config.learningGoals ?? model.learningGoals, model, graph: slice, evidence: evidenceForLearning, languageProfiles: profiles });
      const mvpTrainPlan = trainingOrchestrator.plan({ train: input, evidence: evidenceForLearning, modelState: model, policy });
      const promotionIds = trainingPromotionEvidenceIds(mvpTrainPlan);
      const promoted = await deps.storage.evidence.promoteEvidence(promotionIds, trainingPromotionReason(input, plan, mvpTrainPlan));
      const trainingLanguage = await persistTrainingLanguageMemory(
        evidenceForLearning.filter(span => promotionIds.some(id => String(id) === String(span.id))),
        profiles,
        mvpTrainPlan.id,
        slice
      );
      profiles = trainingLanguage.profiles;
      model = learning.updateModel(model, plan, profiles);
      // Keep the historical model_state key for JSON compatibility; the
      // records themselves are explicitly labelled weighted feature sketches.
      model.latentConcepts = featureSketches;
      if (input.config.policy) Object.assign(policy, input.config.policy);
      await deps.storage.model.writeModel(model);
      const trainingPlanBuiltEvent = await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: mvpTrainPlan.audit }));
      mvpTrainPlan.statusHistory.push({ status: "planned", at: clock.now(), eventId: String(trainingPlanBuiltEvent.id) });
      // Part B step 3: persist the full induction model (morphology,
      // syntax templates, semantic frames, translation seeds), not only its
      // audit -- previously discarded after this function returned. Only
      // attempted when both a real store and a real information label are
      // configured; never invents a label to force persistence through.
      const inducedLanguageModel = mvpTrainPlan.checkpoint.languageModel;
      const languageAudit = jsonRecord(trainingLanguage.audit);
      const reusedCanonicalCompilation = Number(languageAudit.sourceGroupsTotal) > 0
        && languageAudit.reusedSourceGroups === languageAudit.sourceGroupsTotal;
      if (inducedLanguageModel && !reusedCanonicalCompilation && deps.storage.inducedLanguageModels && deps.sourceInformationLabel) {
        await deps.storage.inducedLanguageModels.putModel({
          id: inducedLanguageModel.id,
          model: inducedLanguageModel,
          trainingPlanId: mvpTrainPlan.id,
          createdAt: clock.now(),
          informationLabel: deps.sourceInformationLabel
        });
        const projection = languageMemoryPatternsFromInducedLanguageModel({
          model: inducedLanguageModel,
          profiles,
          idFactory,
          updatedAt: clock.now(),
          sourceSystem: "training",
          informationLabel: deps.sourceInformationLabel
        });
        for (const pattern of projection.patterns) {
          await deps.storage.languageMemory.putLanguagePattern(pattern);
        }
        if (deps.storage.segmentationPopulations && inducedLanguageModel.segmentationPopulations.schema === SEGMENTATION_POPULATION_SCHEMA) {
          const projectedProfileIds = new Set(projection.profileIds);
          await deps.storage.segmentationPopulations.putModel({
            id: inducedLanguageModel.segmentationPopulations.id,
            model: inducedLanguageModel.segmentationPopulations,
            trainingPlanId: mvpTrainPlan.id,
            profileIds: projection.profileIds,
            sourceVersionIds: profiles
              .filter(profile => projectedProfileIds.has(profile.id))
              .map(profile => profile.sourceVersionId),
            createdAt: clock.now(),
            informationLabel: deps.sourceInformationLabel
          });
        }
        const languageModelPersistedEvent = await append(eventFactory.create({
          episodeId,
          typeId: "InducedLanguageModelPersisted",
          payload: toJsonValue({
            modelId: inducedLanguageModel.id,
            trainingPlanId: mvpTrainPlan.id,
            corpusDocuments: inducedLanguageModel.corpusDocuments,
            vocabularySize: inducedLanguageModel.vocabularySize,
            segmentationPopulationModelId: inducedLanguageModel.segmentationPopulations.id,
            segmentationPopulationCount: inducedLanguageModel.segmentationPopulations.populations.length,
            segmentationPopulationRuntimeActive: Boolean(deps.storage.segmentationPopulations),
            memoryProjection: projection as unknown as JsonValue,
            runtimeActivePatterns: projection.patterns.length
          })
        }));
        mvpTrainPlan.statusHistory.push({ status: "persisted", at: clock.now(), eventId: String(languageModelPersistedEvent.id), reason: projection.patterns.length ? "induced language model stored and projected into runtime language memory" : "induced language model stored; runtime projection skipped" });
        events.push(languageModelPersistedEvent);
      }
      events.push(trainingPlanBuiltEvent);
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: plan.audit })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: eviPlan.audit })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPromoted", payload: { promotedEvidence: promoted, selectedEvidenceIds: promotionIds.map(String), weightedFeatureSketches: featureSketches.length, modelStateKey: "latentConcepts", languageProfiles: profiles.length, trainingLanguage: trainingLanguage.audit, promotionPlan: plan.promotion, trainingPromotion: mvpTrainPlan.promotion.slice(0, 64).map(item => ({ evidenceId: item.evidenceId, promote: item.promote, score: item.score, reasons: item.reasons })) } })));
      const selfState = await createFunctionalSelfModel({ storage: deps.storage, model, policy, recentFailures: failures });
      const trainField = fieldEngine.activate({
        text: model.learningGoals.join("\n"),
        nodes: slice.nodes,
        edges: slice.edges,
        hyperedges: slice.hyperedges
      });
      const trainForecastState = prediction.state({ episodeId, graph: slice, alphaTrace: trainField.alphaTrace, t: clock.now() });
      const trainSsd = ssd.distill({ model, graph: slice, state: trainForecastState, self: selfState });
      const trainFcs = fcs.score({ self: selfState, ssd: trainSsd });
      events.push(await append(eventFactory.create({ episodeId, typeId: "SelfModelProjected", payload: { self: selfState, selfDistillation: trainSsd.audit, fcs: trainFcs.audit } })));
      const output = `trained ${featureSketches.length} weighted feature sketch(es), promoted ${promoted} evidence span(s)`;
      onKernelStateMutation({ episodeId, output });
      invalidateRuntimeCaches();
      events.push(await append(eventFactory.create({ episodeId, typeId: "EpisodeClosed", payload: { output } })));

      return { episodeId, promotedEvidence: promoted, featureSketches: featureSketches.length, latentConcepts: featureSketches.length, languageProfiles: profiles.length, learningGoals: model.learningGoals, events };
    
    }
  };
}

/** Heap ceiling for a training pass, in MiB. `SCCE_TRAINING_HEAP_BOUND_MB` overrides; 0 disables. Default leaves real headroom under a typical dev machine's cap so the stop fires before V8 aborts. */
function trainingHeapBoundMb(): number {
  const raw = Number(process.env.SCCE_TRAINING_HEAP_BOUND_MB);
  if (Number.isFinite(raw) && raw >= 0) return Math.floor(raw);
  return 2048;
}

function trainingHeapMb(): number {
  return Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
}
