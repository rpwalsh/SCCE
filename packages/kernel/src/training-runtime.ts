import { createEventFactory } from "./events.js";
import { createAlphaFieldEngine } from "./field.js";
import { createIdFactory } from "./ids.js";
import { createLanguageMemoryRuntime } from "./language-memory-runtime.js";
import {
  createLanguageAcquisitionEngine
} from "./language.js";
import { createWeightedFeatureSketchLearner } from "./latent.js";
import { createLearningLoop } from "./learning-loop.js";
import { createLearningController } from "./learning.js";
import { createPredictionLayer } from "./prediction.js";
import { createClock, toJsonValue } from "./primitives.js";
import { joinInformationLabels } from "./information-flow.js";
import { createFunctionalConsciousnessScore, createSpectralSelfDistillation } from "./self-distillation.js";
import { createFunctionalSelfModel } from "./self.js";
import type { ScceKernelDeps } from "./storage.js";
import { createTrainingOrchestrator } from "./training-orchestrator.js";
import type {
  EpisodeId,
  EvidenceSpan,
  JsonValue,
  LanguageProfile,
  PolicyProfile,
  ScceEvent,
  TrainInput,
  TrainResult
} from "./types.js";

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
    trainingPlanId: string
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
    let profilesCreated = 0;
    for (const spans of groups.values()) {
      const first = spans[0];
      if (!first) continue;
      const sourceVersionId = first.sourceVersionId;
      if (spans.some(span => !span.informationLabel)) {
        throw new Error(`training evidence for ${sourceVersionId} is missing an information label`);
      }
      const existingProfile = profileBySourceVersion.get(String(sourceVersionId));
      const informationLabel = joinInformationLabels(
        [
          ...spans.map(span => span.informationLabel!),
          ...(existingProfile?.informationLabel ? [existingProfile.informationLabel] : [])
        ],
        { explicitMergeAuthority: deps.informationAccess?.explicitMergeAuthority === true }
      );
      const text = spans.map(span => span.text).join("\n");
      let profile = existingProfile;
      if (!profile) {
        profile = { ...language.acquire({ sourceVersionId, text, createdAt: clock.now() }), informationLabel };
        await deps.storage.model.putLanguageProfile(profile);
        profiles.push(profile);
        profileBySourceVersion.set(String(sourceVersionId), profile);
        profilesCreated++;
      }
      const memory = languageMemoryRuntime.train({
        streamId: `training:${trainingPlanId}:${String(sourceVersionId)}`,
        profile,
        sourceVersionId,
        text,
        evidence: spans,
        createdAt: clock.now(),
        maxOrder: 6,
        maxCountersPerOrder: 12000,
        vocabularyLimit: 24000
      });
      await deps.storage.languageMemory.putNgramObservationsBatch(memory.observations.map(record => ({ ...record, informationLabel })));
      for (const model of memory.models) await deps.storage.languageMemory.putNgramModel({ ...model, informationLabel });
      for (const unit of memory.units) await deps.storage.languageMemory.putLanguageUnit({ ...unit, informationLabel });
      for (const pattern of memory.patterns) await deps.storage.languageMemory.putLanguagePattern({ ...pattern, informationLabel });
      for (const frame of memory.semanticFrames) await deps.storage.languageMemory.putSemanticFrame({ ...frame, informationLabel });
      observations += memory.observations.length;
      models += memory.models.length;
      units += memory.units.length;
      patterns += memory.patterns.length;
      semanticFrames += memory.semanticFrames.length;
    }
    return {
      profiles,
      audit: toJsonValue({
        source: "kernel.train.language_memory",
        evidenceSpans: evidence.length,
        sourceVersions: groups.size,
        profilesCreated,
        observations,
        models,
        units,
        patterns,
        semanticFrames
      })
    };
  }

  return {
    async train(input: TrainInput): Promise<TrainResult> {

      const episodeId = idFactory.episodeId();
      const events: ScceEvent[] = [];
      let model = await deps.storage.model.readModel();
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
      const trainingLanguage = await persistTrainingLanguageMemory(evidenceForLearning.filter(span => promotionIds.some(id => String(id) === String(span.id))), profiles, mvpTrainPlan.id);
      profiles = trainingLanguage.profiles;
      model = learning.updateModel(model, plan, profiles);
      // Keep the historical model_state key for JSON compatibility; the
      // records themselves are explicitly labelled weighted feature sketches.
      model.latentConcepts = featureSketches;
      if (input.config.policy) Object.assign(policy, input.config.policy);
      await deps.storage.model.writeModel(model);
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: plan.audit })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: eviPlan.audit })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPlanBuilt", payload: mvpTrainPlan.audit })));
      events.push(await append(eventFactory.create({ episodeId, typeId: "LearningPromoted", payload: { promotedEvidence: promoted, selectedEvidenceIds: promotionIds.map(String), weightedFeatureSketches: featureSketches.length, legacyModelStateKey: "latentConcepts", languageProfiles: profiles.length, trainingLanguage: trainingLanguage.audit, promotionPlan: plan.promotion, trainingPromotion: mvpTrainPlan.promotion.slice(0, 64).map(item => ({ evidenceId: item.evidenceId, promote: item.promote, score: item.score, reasons: item.reasons })) } })));
      const selfState = await createFunctionalSelfModel({ storage: deps.storage, model, policy, recentFailures: failures });
      const trainField = fieldEngine.activate({ text: model.learningGoals.join("\n"), nodes: slice.nodes, edges: slice.edges });
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
