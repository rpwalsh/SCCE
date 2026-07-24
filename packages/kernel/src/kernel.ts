import { createActionGraphBuilder } from "./action-graph.js";
import { createAlphaFieldPersistence } from "./alpha-field-persistence.js";
import {
  createAnswerRevisionCoordinator
} from "./answer-revision.js";
import { createBenchmarkScorer } from "./benchmarks.js";
import { createCandidateEngine } from "./candidate.js";
import { createPfaceEstimator } from "./causal-estimation.js";
import { createCcrEngine } from "./ccr.js";
import { createConnectorGovernance } from "./connector-governance.js";
import { createConstructSubstratePlanner } from "./construct-substrate.js";
import { CORPUS_ROLE_IDS } from "./corpus-registry.js";
import { createCorrectionMemory } from "./correction-memory.js";
import { createCounterfactualCognition } from "./counterfactual-cognition.js";
import { traceEvent } from "./debug/trace.js";
import { englishCreativeStructuralRouteEvents } from "./english-structural-realizer.js";
import { createSemanticEntailmentEngine } from "./entailment.js";
import { assertValidEvaluationCondition } from "./evaluation-flags.js";
import { createEventFactory, extractReplayValue } from "./events.js";
import { createAlphaFieldEngine } from "./field.js";
import { createFunctionalCognitionEngine } from "./functional-cognition.js";
import { analyzeGraph } from "./graph-analytics.js";
import { createIdFactory } from "./ids.js";
import { summarizeCodebaseCheckpoints, summarizeTypedCheckpoints, summarizeTypedRouteStores } from "./ingestion-diagnostics.js";
import { createIngestionRuntime } from "./ingestion-runtime.js";
import { createJudge } from "./judge.js";
import { jsonRecord, uniqueKernelStrings } from "./kernel-answer-primitives.js";
import { createLanguageMemoryRuntime } from "./language-memory-runtime.js";
import {
  createLanguageAcquisitionEngine
} from "./language.js";
import { createWeightedFeatureSketchLearner } from "./latent.js";
import { languageScore } from "./learning-acquisition-runtime.js";
import { createLearningLoop } from "./learning-loop.js";
import { createLearningController } from "./learning.js";
import { validationMessageKey } from "./localization.js";
import { createDeterministicMouth, createMouth } from "./mouth.js";
import { createMultilingualAcquisitionEngine } from "./multilingual-acquisition.js";
import {
  createTypedTemporalWalkEngine
} from "./powerwalk.js";
import { createPredictionLayer } from "./prediction.js";
import { createClock, createHasher, toJsonValue } from "./primitives.js";
import { createProductionTurnRuntime, type ProductionTurnRuntimeState } from "./production-turn-runtime.js";
import { createEmissionEngine, createProgramGraphBuilder, createValidationGraphBuilder } from "./program.js";
import { createProofCarryingAnswer } from "./proof-carrying-answer.js";
import { createRuntimeAcquisition } from "./runtime-acquisition.js";
import {
  positiveRuntimeInt
} from "./runtime-graph-cache.js";
import { createRuntimeGraphRetrieval } from "./runtime-graph-retrieval.js";
import { createRuntimeMemoryControl } from "./runtime-memory-control.js";
import { createRuntimeOrchestrator } from "./runtime-orchestrator.js";
import { createSafetyRailEngine } from "./safety-rail-engine.js";
import { DEFAULT_POLICY } from "./safety.js";
import { createFunctionalConsciousnessScore, createSpectralSelfDistillation } from "./self-distillation.js";
import { createFunctionalSelfModel } from "./self.js";
import { createSemanticMemoryIndex } from "./semantic-memory-index.js";
import { createSemanticProofSystem } from "./semantic-proof-system.js";
import type { ScceKernelDeps } from "./storage.js";
import { createSurfaceLanguageRuntime } from "./surface-language-runtime.js";
import { createAutonomousToolCognition } from "./tool-cognition.js";
import { createTrainingOrchestrator } from "./training-orchestrator.js";
import { createTrainingRuntime } from "./training-runtime.js";
import { createTranslationEngine } from "./translation.js";
import type {
  BenchmarkInput,
  BenchmarkResult,
  EpisodeId,
  EvidenceSpan,
  IngestInput,
  IngestResult,
  InspectionResult,
  InspectionTarget,
  JsonValue,
  OwnerInput,
  PolicyProfile,
  RuntimeWarmupInput,
  RuntimeWarmupResult,
  ScceEvent,
  ScceKernel,
  TrainInput,
  TrainResult,
  TurnResult
} from "./types.js";
import { createWalshSpineReport, walshSpineReportToJson } from "./walsh-spine.js";









export { requestContentPriorUnits, requestContentSurface } from "./kernel-answer-primitives.js";
export { sessionOwnerObservationSurface } from "./local-evidence-runtime.js";

export function createScceKernel(deps: ScceKernelDeps): ScceKernel {
  if (deps.evaluationCondition) assertValidEvaluationCondition(deps.evaluationCondition);
  const clock = deps.clock ?? createClock();
  const hasher = createHasher();
  const idFactory = deps.idFactory ?? createIdFactory({ clock, hasher, namespace: deps.namespace, runSeed: deps.runSeed, deterministicReplay: deps.deterministicReplay });
  const eventFactory = createEventFactory({ idFactory, clock, hasher });
  const language = createLanguageAcquisitionEngine({ idFactory });
  const multilingual = createMultilingualAcquisitionEngine({ hashText: text => hasher.digestHex(text) });
  const languageMemoryRuntime = createLanguageMemoryRuntime({ idFactory, hasher });
  const translationEngine = createTranslationEngine({ idFactory, hasher });
  const powerWalk = createTypedTemporalWalkEngine({ hasher });
  const featureSketchLearner = createWeightedFeatureSketchLearner({ hasher });
  const learning = createLearningController();
  const fieldEngine = createAlphaFieldEngine({ relationPotentialModel: deps.relationPotentialModel });
  const entailment = createSemanticEntailmentEngine({ idFactory, hasher });
  const ccr = createCcrEngine();
  const pca = createProofCarryingAnswer();
  const candidates = createCandidateEngine();
  const judge = createJudge();
  const answerRevision = createAnswerRevisionCoordinator();
  const actionGraphBuilder = createActionGraphBuilder({ hasher });
  const learningLoop = createLearningLoop();
  const functionalCognitionEngine = createFunctionalCognitionEngine();
  const ssd = createSpectralSelfDistillation();
  const fcs = createFunctionalConsciousnessScore();
  const pface = createPfaceEstimator();
  const programBuilder = createProgramGraphBuilder({ idFactory, hasher });
  const validationBuilder = createValidationGraphBuilder({ idFactory });
  const emissionEngine = createEmissionEngine({ idFactory });
  const prediction = createPredictionLayer({ idFactory });
  const alphaPersistence = createAlphaFieldPersistence({ hasher });
  const constructSubstrate = createConstructSubstratePlanner({ idFactory, hasher });
  const counterfactual = createCounterfactualCognition({ hasher });
  const connectorGovernance = createConnectorGovernance({ hasher, now: () => clock.now() });
  const safetyRails = createSafetyRailEngine({ hasher });
  const semanticMemory = createSemanticMemoryIndex({ hasher });
  const semanticProofSystem = createSemanticProofSystem({ hasher });
  const toolCognition = createAutonomousToolCognition({ hasher, now: () => clock.now() });
  const trainingOrchestrator = createTrainingOrchestrator({ hasher, now: () => clock.now() });
  const runtimeOrchestrator = createRuntimeOrchestrator({ hasher });
  const correctionMemory = createCorrectionMemory({ idFactory, hasher });
  const mouth = createMouth({ languageMemory: languageMemoryRuntime, correctionMemory, hashText: text => hasher.digestHex(text), hasher });
  const deterministicMouth = createDeterministicMouth({ hashText: text => hasher.digestHex(text) });
  const policy: PolicyProfile = { ...DEFAULT_POLICY, ...(deps.policy ?? {}) };
  const turnState: ProductionTurnRuntimeState = { lastOutput: "" };
  const failures: string[] = [];
  let bufferedEvents: ScceEvent[] | undefined;
  const turnProofEvidenceLimit = positiveRuntimeInt("SCCE_TURN_PROOF_EVIDENCE", 2);
  const surfaceLanguageMemoryCacheMs = positiveRuntimeInt("SCCE_SURFACE_LANGUAGE_CACHE_MS", 600_000);

  const surfaceLanguageRuntime = createSurfaceLanguageRuntime({
    deps,
    languageMemoryRuntime,
    clock,
    hasher,
    cacheMs: surfaceLanguageMemoryCacheMs,
    profileLimit: Math.min(2048, positiveRuntimeInt("SCCE_SURFACE_LANGUAGE_PROFILE_LIMIT", 512))
  });
  const {
    languageMemorySummary,
    hydrateSurfaceLanguageMemoryCached,
    surfaceLanguageProfilesCached,
    sourceOwnedLanguageProfilesCached,
    sourceOwnedLanguageClusterForAlias,
    sourceOwnedLanguageClustersForWarmup,
    surfaceLanguageClusterCached,
    requestSemanticFrames,
    sourceAnchorSemanticFramesCached,
    uniqueRecordsById
  } = surfaceLanguageRuntime;
  function kernelTrace(event: Parameters<typeof traceEvent>[1]): void {
    traceEvent((globalThis as any).__sccTrace, event);
  }

  async function append(event: ScceEvent): Promise<ScceEvent> {
    if (bufferedEvents) {
      bufferedEvents.push(event);
      return event;
    }
    await deps.storage.events.append(event);
    return event;
  }

  async function appendBatch(events: ScceEvent[]): Promise<ScceEvent[]> {
    await deps.storage.events.appendBatch(events);
    return events;
  }

  const graphRetrieval = createRuntimeGraphRetrieval({
    deps,
    clock,
    hasher,
    candidates,
    failures,
    cacheMs: surfaceLanguageMemoryCacheMs,
    kernelTrace,
    sourceAnchorSemanticFramesCached
  });
  const {
    sourceAnchorEvidenceCacheMaxEntries,
    hotNeighborhoodCached,
    sourceAnchorEvidenceBatchCached,
    graphForText,
    graphForEvidenceIds,
    graphForEvidenceIdsUnrouted,
    graphForTextUncached,
    evidenceOnlyForText,
    evidenceOnlyForIds,
    retrievalTextForTurn,
    evidenceFromTurnMetadata,
    runtimeEvidenceIdsFromMetadata,
    sessionEvidenceFromMetadata,
    currentOwnerSessionEvidence,
    mergeEvidenceSpans,
    graphRetrievalFeatures
  } = graphRetrieval;
  const runtimeMemory = createRuntimeMemoryControl({ deps, clock });
  const { activeBrainMarker, correctionRulesCached, calibrationModelsCached } = runtimeMemory;
  function invalidateRuntimeCaches(): void {
    graphRetrieval.invalidate();
    surfaceLanguageRuntime.invalidate();
    runtimeMemory.invalidate();
  }

  async function withBufferedEventWrites<T>(run: () => Promise<T>): Promise<T> {
    if (bufferedEvents) return run();
    const buffer: ScceEvent[] = [];
    bufferedEvents = buffer;
    try {
      const result = await run();
      if (buffer.length) await deps.storage.events.appendBatch(buffer);
      return result;
    } catch (error) {
      if (buffer.length) await deps.storage.events.appendBatch(buffer).catch(writeError => failures.push(`event batch persistence failed: ${writeError instanceof Error ? writeError.message : String(writeError)}`));
      throw error;
    } finally {
      bufferedEvents = undefined;
    }
  }

  const ingestionRuntime = createIngestionRuntime({
    deps,
    clock,
    hasher,
    idFactory,
    eventFactory,
    language,
    languageMemoryRuntime,
    append,
    onKernelStateMutation({ episodeId, output, invalidateRuntimeCaches: invalidate }) {
      turnState.lastEpisodeId = episodeId;
      turnState.lastOutput = output;
      if (invalidate) invalidateRuntimeCaches();
    }
  });
  const trainingRuntime = createTrainingRuntime({
    deps, clock, idFactory, eventFactory, featureSketchLearner, learning, learningLoop,
    trainingOrchestrator, language, languageMemoryRuntime, fieldEngine, prediction, ssd, fcs,
    policy, failures, append, invalidateRuntimeCaches,
    onKernelStateMutation({ episodeId, output }) {
      turnState.lastEpisodeId = episodeId;
      turnState.lastOutput = output;
    }
  });
  const runtimeAcquisition = createRuntimeAcquisition({
    deps,
    eventFactory,
    hasher,
    failures,
    append,
    ingest: input => ingestionRuntime.ingest(input)
  });
  const { learnHydrateReplan, runtimeMotionDeferredByDeadline } = runtimeAcquisition;
  const productionTurnRuntime = createProductionTurnRuntime({
    deps,
    state: turnState,
    policy,
    failures,
    turnProofEvidenceLimit,
    clock,
    hasher,
    idFactory,
    eventFactory,
    graphRetrieval,
    surfaceLanguageRuntime,
    runtimeMemory,
    runtimeAcquisition,
    languageMemoryRuntime,
    lifecycle: { append, withBufferedEventWrites, kernelTrace },
    engines: {
      actionGraphBuilder, alphaPersistence, answerRevision, candidates, ccr, connectorGovernance,
      constructSubstrate, correctionMemory, counterfactual, deterministicMouth, emissionEngine, entailment,
      fcs, fieldEngine, functionalCognitionEngine, judge, learningLoop, mouth, multilingual, pca, pface,
      powerWalk, prediction, programBuilder, runtimeOrchestrator, safetyRails, semanticMemory,
      semanticProofSystem, ssd, toolCognition, trainingOrchestrator, translationEngine, validationBuilder
    }
  });
  const kernel: ScceKernel = {
    async warmup(input: RuntimeWarmupInput = {}): Promise<RuntimeWarmupResult> {
      const started = clock.now();
      const failures: string[] = [];
      const result: RuntimeWarmupResult = {
        schema: "scce.runtime_warmup.v1",
        totalMs: 0,
        failures
      };
      const languageLimit = Math.max(1, Math.min(256, Math.floor(input.languageLimit ?? 36)));
      const tasks: Array<Promise<void>> = [];

      if (input.graph ?? true) {
        tasks.push(hotNeighborhoodCached()
          .then(hot => {
            const graph = hot?.value.graph;
            result.graph = {
              loaded: Boolean(hot),
              nodes: graph?.nodes.length ?? 0,
              edges: graph?.edges.length ?? 0,
              hyperedges: graph?.hyperedges.length ?? 0,
              evidence: hot?.value.evidence.length ?? 0,
              bytes: hot?.bytes ?? 0
            };
          })
          .catch(error => {
            failures.push(`graph warmup failed: ${error instanceof Error ? error.message : String(error)}`);
            result.graph = { loaded: false, nodes: 0, edges: 0, hyperedges: 0, evidence: 0, bytes: 0 };
          }));
      }

      if (input.language ?? true) {
        tasks.push(Promise.all([
          sourceOwnedLanguageClustersForWarmup()
            .then(clusters => Promise.all([
              hydrateSurfaceLanguageMemoryCached(
                languageLimit,
                undefined,
                "source-surface-ambiguous-or-no-signal"
              ),
              ...clusters.map(cluster => hydrateSurfaceLanguageMemoryCached(
                languageLimit,
                cluster,
                "warmup-source-owned-language-cluster"
              ))
            ])),
          sourceAnchorSemanticFramesCached()
        ])
          .then(([languages, sourceAnchorFrames]) => {
            result.language = {
              loaded: true,
              models: languages.reduce((sum, language) => sum + language.models.length, 0),
              observations: languages.reduce((sum, language) => sum + language.observations.length, 0),
              units: languages.reduce((sum, language) => sum + language.units.length, 0),
              patterns: languages.reduce((sum, language) => sum + language.patterns.length, 0),
              semanticFrames: Math.max(
                languages.reduce((sum, language) => sum + language.semanticFrames.length, 0),
                sourceAnchorFrames.length
              )
            };
          })
          .catch(error => {
            failures.push(`language warmup failed: ${error instanceof Error ? error.message : String(error)}`);
            result.language = { loaded: false, models: 0, observations: 0, units: 0, patterns: 0, semanticFrames: 0 };
          }));
      }

      if (input.brain ?? true) {
        tasks.push(activeBrainMarker()
          .then(() => { result.brain = { loaded: true }; })
          .catch(error => {
            failures.push(`brain warmup failed: ${error instanceof Error ? error.message : String(error)}`);
            result.brain = { loaded: false };
          }));
      }

      if (input.profile ?? true) {
        tasks.push(surfaceLanguageProfilesCached()
          .then(({ profiles }) => { result.profile = { loaded: profiles.length > 0 }; })
          .catch(error => {
            failures.push(`profile warmup failed: ${error instanceof Error ? error.message : String(error)}`);
            result.profile = { loaded: false };
          }));
      }

      if (input.corrections ?? true) {
        tasks.push(correctionRulesCached()
          .then(rules => { result.corrections = { loaded: true, rules: rules.length }; })
          .catch(error => {
            failures.push(`correction warmup failed: ${error instanceof Error ? error.message : String(error)}`);
            result.corrections = { loaded: false, rules: 0 };
          }));
      }

      await Promise.all(tasks);
      if (input.language ?? true) {
        const sourceLanguageStarted = clock.now();
        try {
          const sourceFrames = await sourceAnchorSemanticFramesCached();
          const sourceEvidenceIds = uniqueKernelStrings(sourceFrames
            .flatMap(row => row.frame.evidenceIds.map(String)))
            .slice(0, sourceAnchorEvidenceCacheMaxEntries)
            .map(id => id as EvidenceSpan["id"]);
          await sourceAnchorEvidenceBatchCached(sourceEvidenceIds);
          const creativeClusters = await sourceOwnedLanguageClustersForWarmup();
          const creativeLanguages = await Promise.all(creativeClusters.map(cluster =>
            hydrateSurfaceLanguageMemoryCached(
              languageLimit,
              cluster,
              "warmup-creative-language-cluster",
              CORPUS_ROLE_IDS.publicDomainProse
            )
          ));
          const creativeEvents = creativeLanguages.flatMap(language =>
            language.state.importedConstructionBundles.flatMap(bundle => bundle.creativeEvents ?? [])
          );
          const structuralCreativeEvents = englishCreativeStructuralRouteEvents(creativeEvents);
          if (result.language) {
            result.language.models = Math.max(result.language.models, ...creativeLanguages.map(language => language.models.length));
            result.language.observations = Math.max(result.language.observations, ...creativeLanguages.map(language => language.observations.length));
            result.language.units = Math.max(result.language.units, ...creativeLanguages.map(language => language.units.length));
            result.language.patterns = Math.max(result.language.patterns, ...creativeLanguages.map(language => language.patterns.length));
            result.language.semanticFrames = Math.max(result.language.semanticFrames, ...creativeLanguages.map(language => language.semanticFrames.length));
          }
          kernelTrace({
            stage: "runtime.start",
            label: "kernel.warmup.source_language",
            durationMs: Math.max(0, clock.now() - sourceLanguageStarted),
            counts: {
              sourceFrames: sourceFrames.length,
              sourceEvidence: sourceEvidenceIds.length,
              creativeFrames: creativeLanguages.reduce((sum, language) => sum + language.semanticFrames.length, 0),
              creativeEvents: creativeEvents.length,
              structuralCreativeEvents: structuralCreativeEvents.length
            }
          });
        } catch (error) {
          failures.push(`source language warmup failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      result.totalMs = Math.max(0, clock.now() - started);
      kernelTrace({
        stage: "runtime.start",
        label: "kernel.warmup",
        durationMs: result.totalMs,
        counts: {
          graphNodes: result.graph?.nodes ?? 0,
          graphEdges: result.graph?.edges ?? 0,
          evidence: result.graph?.evidence ?? 0,
          languageModels: result.language?.models ?? 0,
          languageUnits: result.language?.units ?? 0,
          failures: failures.length
        },
        support: { warmup: result as unknown as Record<string, unknown> }
      });
      return result;
    },
    async ingest(input: IngestInput): Promise<IngestResult> {
      return ingestionRuntime.ingest(input);
    },
    async train(input: TrainInput): Promise<TrainResult> {
      return trainingRuntime.train(input);
    },
    async turn(input: OwnerInput): Promise<TurnResult> {
      return productionTurnRuntime.turn(input);
    },

    async replay(episodeId: EpisodeId) {
      const events = await deps.storage.events.readEpisode(episodeId);
      return { episodeId, events, ledgerHash: eventFactory.ledgerHash(events), ...extractReplayValue(events) };
    },

    async inspect(target: InspectionTarget): Promise<InspectionResult> {
      if (target === "last") {
        const events = turnState.lastEpisodeId ? await deps.storage.events.readEpisode(turnState.lastEpisodeId) : [];
        const payloads = (typeId: string) => events.filter(event => event.typeId === typeId).map(event => event.payload);
        const latestPayload = (typeId: string): JsonValue => payloads(typeId).at(-1) ?? null;
        const requirementTrace = latestPayload("TurnRequirementsBuilt");
        return {
          kind: "last",
          value: toJsonValue({
            schema: "scce.inspect.last_turn.v2",
            episodeId: turnState.lastEpisodeId ?? null,
            output: turnState.lastOutput,
            requirements: requirementTrace,
            learnedActivations: jsonRecord(requirementTrace).field ?? null,
            operators: payloads("CognitiveOperatorsActivated"),
            proposals: latestPayload("CognitiveProposalsBuilt"),
            candidates: {
              generated: payloads("CandidateGenerated"),
              rejected: payloads("CandidateRejected"),
              selected: latestPayload("CandidateSelected")
            },
            mouth: latestPayload("MouthSpoken"),
            criticAndRevisions: latestPayload("AnswerRevisionEvaluated"),
            evidenceAndEmission: latestPayload("EmissionGraphBuilt"),
            brainRevision: jsonRecord(requirementTrace).brainRevision ?? null,
            actionState: {
              prepared: payloads("ActionPrepared"),
              committed: payloads("ActionCommitted"),
              rolledBack: payloads("ActionRolledBack")
            },
            timing: turnState.lastTurnTiming ?? null,
            events
          })
        };
      }
      if (target === "brain") return { kind: "brain", value: { marker: await activeBrainMarker(), summary: await deps.storage.brainImports.summarize({ limit: 2000 }), languageMemory: await languageMemorySummary() } as unknown as JsonValue };
      if (target === "language") return { kind: "language", value: { languageMemory: await languageMemorySummary(), brain: await deps.storage.brainImports.summarize({ limit: 2000 }) } as unknown as JsonValue };
      if (target === "graph-priors") {
        const graph = await deps.storage.graph.getSlice({ features: ["concept-prior"], limitNodes: 500, limitEdges: 1000, allowLatestFallback: true });
        return { kind: "graph-priors", value: { marker: await activeBrainMarker(), graph, analytics: analyzeGraph(graph), forceClasses: (await deps.storage.brainImports.summarize({ limit: 2000 })).runs.flatMap(run => Object.entries(run.forceClasses).map(([forceClass, count]) => ({ run: run.importRunId, forceClass, count }))) } as unknown as JsonValue };
      }
      if (target === "graph") {
        const graph = await deps.storage.graph.getSlice({ limitNodes: 200, limitEdges: 400, allowLatestFallback: true });
        return { kind: "graph", value: { graph, analytics: analyzeGraph(graph) } as unknown as JsonValue };
      }
      if (target === "ingestion") {
        const checkpoints = await deps.storage.ingestion.list({ limit: 500 });
        return { kind: "ingestion", value: { checkpoints, typedObservations: summarizeTypedCheckpoints(checkpoints), routeStores: summarizeTypedRouteStores(checkpoints), codebase: summarizeCodebaseCheckpoints(checkpoints), languageMemory: await languageMemorySummary() } as unknown as JsonValue };
      }
      if (target === "codebase") {
        const checkpoints = await deps.storage.ingestion.list({ limit: 2000 });
        return { kind: "codebase", value: summarizeCodebaseCheckpoints(checkpoints) };
      }
      if (target === "model") return { kind: "model", value: { model: await deps.storage.model.readModel(), languageMemory: await languageMemorySummary() } as unknown as JsonValue };
      if (target === "language-memory") {
        const rules = await deps.storage.corrections.listRules({ limit: 100 });
        return { kind: "language-memory", value: { languageMemory: await languageMemorySummary(), corrections: correctionMemory.summarize(rules) } as unknown as JsonValue };
      }
      if (target === "corrections") {
        const rules = await deps.storage.corrections.listRules({ limit: 200 });
        return { kind: "corrections", value: { rules, summary: correctionMemory.summarize(rules) } as unknown as JsonValue };
      }
      if (target === "localization") {
        const bundles = await deps.storage.localization.listBundles({ limit: 200 });
        return { kind: "localization", value: { bundles, languageMemory: await languageMemorySummary() } as unknown as JsonValue };
      }
      if (target === "math-spine") {
        const graph = await deps.storage.graph.getSlice({ limitNodes: 300, limitEdges: 600, allowLatestFallback: true });
        const stats = await deps.storage.stats();
        const languageMemory = await languageMemorySummary();
        const localization = await deps.storage.localization.listBundles({ limit: 100 });
        const report = createWalshSpineReport({ stats, graph, languageMemory: languageMemory as unknown as JsonValue, localization: localization as unknown as JsonValue, now: clock.now() });
        return { kind: "math-spine", value: walshSpineReportToJson(report) };
      }
      if (target === "self") {
        const currentModel = await deps.storage.model.readModel();
        const graph = await deps.storage.graph.getSlice({ limitNodes: 300, limitEdges: 600, allowLatestFallback: true });
        const selfState = await createFunctionalSelfModel({ storage: deps.storage, model: currentModel, policy, recentFailures: failures });
        const projected = ssd.distill({ model: currentModel, graph, self: selfState });
        const consciousness = fcs.score({ self: selfState, ssd: projected });
        return { kind: "self", value: { self: selfState, selfDistillation: projected, functionalConsciousness: consciousness } as unknown as JsonValue };
      }
      if (target === "snapshot") {
        const graph = await deps.storage.graph.getSlice({ limitNodes: 200, limitEdges: 400, allowLatestFallback: true });
        const currentModel = await deps.storage.model.readModel();
        const selfState = await createFunctionalSelfModel({ storage: deps.storage, model: currentModel, policy, recentFailures: failures });
        const stats = await deps.storage.stats();
        const languageMemory = await languageMemorySummary();
        const localization = await deps.storage.localization.listBundles({ limit: 25 });
        const mathSpine = createWalshSpineReport({ stats, graph, languageMemory: languageMemory as unknown as JsonValue, localization: localization as unknown as JsonValue, now: clock.now() });
        return { kind: "snapshot", value: { model: currentModel, graph, graphAnalytics: analyzeGraph(graph), self: selfState, ingestion: await deps.storage.ingestion.list({ limit: 100 }), languageMemory, localization, mathSpine, stats } as unknown as JsonValue };
      }
      if (target === "proofs") return { kind: "proofs", value: { message: validationMessageKey("inspect.proofs.replay_required") } };
      if (typeof target === "object" && target.kind === "brain-import") return { kind: "brain-import", value: { marker: await activeBrainMarker(), summary: await deps.storage.brainImports.summarize({ importRunId: target.importRunId, limit: 2000 }), ledger: await deps.storage.brainImports.listLedger({ importRunId: target.importRunId, limit: 2000 }) } as unknown as JsonValue };
      if (typeof target === "object" && target.kind === "episode") return { kind: "episode", value: (await kernel.replay(target.episodeId)) as unknown as JsonValue };
      if (typeof target === "object" && target.kind === "event") {
        const events = await deps.storage.events.readRange({ limit: 1000 });
        return { kind: "event", value: (events.find(event => event.id === target.eventId) ?? null) as JsonValue };
      }
      return { kind: "unknown", value: null };
    },

    async benchmark(input: BenchmarkInput): Promise<BenchmarkResult> {
      const runId = idFactory.runId();
      const episodeId = idFactory.episodeId();
      const startedAt = clock.now();
      const tasks = input.tasks ?? input.config?.tasks ?? [];
      const results: BenchmarkResult["tasks"] = [];
      const events: ScceEvent[] = [];
      const benchmarkScorer = createBenchmarkScorer();
      for (const task of tasks) {
        const turn = await kernel.turn({ text: task.input, metadata: { benchmarkTaskId: task.id } });
        const rubric = benchmarkScorer.scoreTurn(task, turn);
        const dims = new Map(rubric.dimensions.map(dim => [dim.id, dim.score]));
        const artifactScore = task.expectedArtifacts?.length
          ? task.expectedArtifacts.filter(path => turn.emissionGraph.artifacts.some(artifact => artifact.path === path)).length / task.expectedArtifacts.length
          : dims.get("buildAndTest") ?? 0.5;
        const result = {
          id: task.id,
          score: rubric.score,
          correctness: dims.get("correctness") ?? 0,
          evidenceEntailment: dims.get("evidenceEntailment") ?? 0,
          toolSuccess: dims.get("toolUse") ?? 0,
          codeBuildTest: artifactScore,
          learningImprovement: turn.learningNeeds.length || task.caseType === "LearningAcquisitionCase" ? 0.72 : 0.42,
          multilingual: dims.get("multilingualTransfer") ?? languageScore(turn.evidence),
          efficiency: dims.get("efficiency") ?? 0,
          auditability: dims.get("auditability") ?? 0,
          notes: [...rubric.notes, `caseType=${task.caseType ?? "SmokeCase"}`, "not frontier-comparable"]
        };
        results.push(result);
        await deps.storage.benchmarks.putCase({ id: `${runId}:${task.id}`, runId, case: task as unknown as JsonValue, result: { ...result, rubric: rubric as unknown as JsonValue } as unknown as JsonValue, score: { score: rubric.score } });
      }
      const score = results.length ? results.reduce((sum, item) => sum + item.score, 0) / results.length : 0;
      await deps.storage.benchmarks.putRun({ id: runId, config: (input.config ?? { tasks }) as JsonValue, startedAt, completedAt: clock.now(), summary: { score, tasks: results.length } });
      events.push(await append(eventFactory.create({ episodeId, typeId: "TestExecuted", payload: { runId, tasks: results.length, score } })));
      return { runId, tasks: results, score, events, note: "Benchmarks are persisted local executions. Frontier comparisons are not claimed unless separately run." };
    }
  };

  return kernel;
}
