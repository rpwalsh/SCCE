// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { constructionSurfaceComplete, type ConstructionSurface } from "./construction-surface.js";
import { realizeLearnedSurface, type SurfaceMeaningPlan } from "./language-construction.js";
import type { IdFactory } from "./ids.js";
import { sourceReferenceBindingsFromPatterns } from "./source-reference-bindings.js";
import type { NarrativeConditioning } from "./document-generation-session.js";
import { deriveClosedClassWords } from "./closed-class-words.js";
import { calibrated } from "./calibrations/prod-calibrations.js";
import type { KneserNeyModel } from "./kneser-ney.js";
import { KNESER_NEY_SCHEMA, compileKneserNeyRuntimeIndexes, continueBoundedProse, materializeKneserNey, kneserNeyProbability, predictKneserNey } from "./kneser-ney.js";
import { createNgramMemoryCompiler, type NgramMemoryCompilation } from "./ngram-memory.js";
import { buildLanguageProfileClusters, type LanguageProfileCluster } from "./language.js";
import { clamp01, featureSet, mean, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";
import type { EvidenceSpan, Hasher, JsonValue, LanguageCompetenceVector, LanguageProfile, SourceVersionId } from "./types.js";
import type { LanguageContinuationPopulation, LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation, SemanticFrameRecord } from "./storage.js";
import {
  hydrateLanguageConstructionPatterns,
  isLanguageConstructionPattern,
  type DurableLanguageConstructionBundle,
  type LanguageConstructionMemoryIssue
} from "./language-construction-memory.js";
import {
  creativeEventCompatibilityModelsFromPatterns,
  isCreativeEventCompatibilityPattern,
  normalizeCreativeEventCompatibilityModels,
  scopeCreativeEventCompatibilityModels,
  type CreativeEventCompatibilityModel
} from "./creative-event-compatibility.js";
import { SENTENCE_BOUNDARY_SYMBOLS, collapseSurfaceWhitespace, splitSurfaceSentences, surfaceWords } from "./surface-linguistics.js";
import {
  ANSWER_ROLE_IDS,
  ANSWER_SLOT_IDS,
  RELATION_ROLE_IDS,
  isBackgroundAnswerRoleId,
  isBridgeAnswerRoleId
} from "./question-routing-ids.js";
import {
  reconcileRequestRequirementPatterns,
  type RequestRequirementHydrationReport
} from "./request-requirement-learning.js";
import {
  INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA
} from "./language-induction-memory.js";
import {
  isReversibleConstructionPattern,
  reversibleConstructionsFromPatterns,
  type ReversibleConstruction
} from "./reversible-construction.js";
import {
  isPairedAntiUnifiedPattern,
  pairedAntiUnifiedConstructionsFromPatterns,
  type PairedAntiUnifiedConstruction
} from "./paired-anti-unification.js";
import {
  compileOptionalNullRealizationModel,
  isOptionalNullRealizationPattern,
  optionalNullRealizationModelsFromPatterns,
  type OptionalNullRealizationModel
} from "./optional-null-realization.js";
import {
  languageStructuralDeltasFromPatterns,
  structuralDeltaRealizationFit,
  type LanguageStructuralDelta,
  type LanguageStructuralDeltaMatchContext
} from "./language-state-delta.js";


interface DeferredConstructionState {
  independent: LanguageMemoryRuntimeState;
  read(): LanguageMemoryRuntimeState;
  peek(): LanguageMemoryRuntimeState | undefined;
  subscribe(listener: () => void): void;
  roots: readonly unknown[];
}
const deferredConstructionStates = new WeakMap<LanguageMemoryRuntimeState, DeferredConstructionState>();
const constructionStateKeys = ["importedConstructionBundles", "rejectedConstructionPatterns", "creativeEventCompatibilityModels", "importedLanguagePriorCount", "competenceVector", "audit"] as const;

/** Preserve deferred compiler properties when adding turn-owned metadata. */
export function cloneLanguageMemoryRuntimeState(state: LanguageMemoryRuntimeState, overrides: Partial<LanguageMemoryRuntimeState>): LanguageMemoryRuntimeState {
  const clone = Object.defineProperties({}, Object.getOwnPropertyDescriptors(state)) as LanguageMemoryRuntimeState;
  Object.defineProperties(clone, Object.getOwnPropertyDescriptors(overrides));
  const deferred = deferredConstructionStates.get(state);
  if (deferred) {
    let ready: LanguageMemoryRuntimeState | undefined;
    deferredConstructionStates.set(clone, {
      independent: cloneLanguageMemoryRuntimeState(deferred.independent, overrides),
      read: () => ready ??= cloneLanguageMemoryRuntimeState(deferred.read(), overrides),
      peek: () => ready ?? (deferred.peek() ? cloneLanguageMemoryRuntimeState(deferred.peek()!, overrides) : undefined),
      subscribe: deferred.subscribe,
      roots: deferred.roots
    });
  }
  return clone;
}

export function onLanguageMemoryConstructionHydrated(state: LanguageMemoryRuntimeState, listener: () => void): void {
  deferredConstructionStates.get(state)?.subscribe(listener);
}

/** Cache accounting visits retained inputs or completed programs without invoking the compiler. */
export function peekLanguageMemoryConstructionState(state: Partial<LanguageMemoryRuntimeState>): {
  bundles?: readonly DurableLanguageConstructionBundle[];
  rejected?: readonly LanguageConstructionMemoryIssue[];
  roots: readonly unknown[];
} {
  const deferred = deferredConstructionStates.get(state as LanguageMemoryRuntimeState);
  const ready = deferred?.peek();
  if (deferred && !ready) return { roots: deferred.roots };
  const value = ready ?? state;
  return { bundles: value.importedConstructionBundles, rejected: value.rejectedConstructionPatterns,
    roots: [...(deferred?.roots ?? []), value.importedConstructionBundles, value.creativeEventCompatibilityModels] };
}

function deferConstructionState(independent: LanguageMemoryRuntimeState, compile: () => LanguageMemoryRuntimeState, roots: readonly unknown[]): LanguageMemoryRuntimeState {
  let completed: LanguageMemoryRuntimeState | undefined;
  const listeners = new Set<() => void>();
  const read = () => {
    if (!completed) {
      completed = compile();
      for (const listener of listeners) listener();
      listeners.clear();
    }
    return completed;
  };
  const state = cloneLanguageMemoryRuntimeState(independent, {});
  for (const key of constructionStateKeys) Object.defineProperty(state, key, {
    enumerable: true, configurable: true, get: () => read()[key]
  });
  const scope = { ...independent.scope };
  for (const key of ["profileIds", "sourceVersionIds", "degraded", "reason"] as const) Object.defineProperty(scope, key, {
    enumerable: true, configurable: true, get: () => read().scope[key]
  });
  state.scope = scope;
  deferredConstructionStates.set(state, { independent, read, peek: () => completed, subscribe: listener => { listeners.add(listener); }, roots });
  return state;
}

/** Which corpus population a resident model came from. Index-aligned with `models`; the record already carried it. */
export interface LanguageModelPopulation {
  modelId: string;
  sourceSystem?: string;
  corpusRoleId?: string;
}

export interface LanguageMemoryRuntimeState {
  models: KneserNeyModel[];
  modelPopulations: LanguageModelPopulation[];
  /** Exact identity-scoped continuation aggregate; absent means it was not measured. */
  continuationPopulation?: LanguageContinuationPopulation;
  records: NgramModelRecord[];
  streamIds: string[];
  languageHints: string[];
  maxOrder: number;
  observedSymbolCount: number;
  vocabularySize: number;
  importedUnits: LanguageUnitRecord[];
  importedPatterns: LanguagePatternRecord[];
  importedObservations: NgramObservation[];
  importedSemanticFrames: SemanticFrameRecord[];
  /** Typed morphology/construction/interpretation transitions read from durable learner output. */
  structuralDeltas?: LanguageStructuralDelta[];
  importedConstructionBundles: DurableLanguageConstructionBundle[];
  importedReversibleConstructions?: ReversibleConstruction[];
  importedPairedAntiUnifiedConstructions?: PairedAntiUnifiedConstruction[];
  optionalNullRealizationModels?: OptionalNullRealizationModel[];
  creativeEventCompatibilityModels: CreativeEventCompatibilityModel[];
  rejectedConstructionPatterns: LanguageConstructionMemoryIssue[];
  /** Set by hydrate(); absent only on states built without hydration. */
  requestRequirementHydration?: RequestRequirementHydrationReport;
  importedLanguagePriorCount: number;
  competenceVector: LanguageCompetenceVector;
  scope: LanguageMemoryRuntimeScope;
  /** The learned closed class of the identity and corpus family this memory speaks, set by the turn that scoped it. */
  closedClass?: readonly string[];
  audit: JsonValue;
}



export interface LanguageMemoryRuntimeScope {
  mode: "unscoped" | "cluster" | "language";
  clusterId?: string;
  /** The learned language identity this memory was scoped to; provenance is not part of the scope. */
  languageId?: string;
  profileIds: string[];
  sourceVersionIds: string[];
  purityProven: boolean;
  degraded: boolean;
  reason?: string;
}

export interface LanguageMemoryScore {
  activation: number;
  information: number;
  fit: number;
  orderScores: Array<{ order: number; activation: number; information: number; fit: number; observedSymbolCount: number; vocabularySize: number }>;
  audit: JsonValue;
}

export interface LanguageMemorySuggestion {
  symbol: string;
  probability: number;
  order: number;
  support: number;
}

export interface LanguageMemoryRealization {
  text: string;
  surface?: ConstructionSurface;
  evidenceIds: string[];
  score: LanguageMemoryScore;
  continuation?: {
    text: string;
    stoppedBy: string;
    averageLogProbability: number;
    surface?: ConstructionSurface;
    realizationStatus: "realized" | "unresolved";
  };
  audit: JsonValue;
}

export interface LanguageGenerationTerm {
  id?: string;
  text: string;
  weight?: number;
  source?: string;
}

export interface LanguageGenerationAtom {
  id: string;
  text: string;
  kind?: string;
  weight?: number;
  source?: string;
  evidenceIds?: readonly string[];
}

export interface LanguageGenerationOrdering {
  index: number;
  previousPointId?: string;
  nextPointId?: string;
  relation?: string;
  weight?: number;
}

export interface LanguageGenerationFrame {
  /** Complete caller-owned construction alternatives; token arrays are scoring data only. */
  constructionSurfaces?: readonly ConstructionSurface[];
  constructionPlans?: readonly SurfaceMeaningPlan[];
  id: string;
  pointId?: string;
  role?: string;
  force?: string;
  propositionAtoms?: readonly LanguageGenerationAtom[];
  requiredTerms?: readonly LanguageGenerationTerm[];
  semanticFrameIds?: readonly string[];
  realizationConstraints?: JsonValue;
  /** Committed story state; opaque identifiers are not surface terms or n-gram seeds. */
  narrativeConditioning?: NarrativeConditioning;
  targetLanguage?: string;
  targetScript?: string;
  styleProfileId?: string;
  registerVector?: readonly number[];
  detailProfileId?: string;
  ordering?: LanguageGenerationOrdering;
  /** Soft lexical boost, not enforced coverage: words this generation should favor when the beam has a choice. */
  topicVocabulary?: readonly string[];
  /** Lowercase word -> preferred surface casing (proper nouns), applied when rendering beam-synthesized text. */
  properNounCasing?: Readonly<Record<string, string>>;
}

export interface LanguageGenerationInput {
  /** Complete caller-owned construction alternatives; token arrays are scoring data only. */
  constructionSurfaces?: readonly ConstructionSurface[];
  constructionPlans?: readonly SurfaceMeaningPlan[];
  state: LanguageMemoryRuntimeState;
  segmentationPopulationPosterior?: Readonly<Record<string, number>>;
  targetLanguageProfile?: LanguageProfile;
  contextSymbols?: readonly string[];
  requiredTerms?: readonly LanguageGenerationTerm[];
  semanticFrameIds?: readonly string[];
  frames?: readonly LanguageGenerationFrame[];
  generationExtent?: number;
  /** Deterministic exploration nonce; never included in lexical context. */
  choiceSeed?: string;
  styleProfileId?: string;
  registerVector?: readonly number[];
  detailProfileId?: string;
  stop?: {
    maxInformation?: number;
    stopSymbols?: readonly string[];
  };
}

export interface LanguageGenerationResult {
  surface?: ConstructionSurface;
  realizationStatus: "realized" | "unresolved";
  unresolvedReason?: "no_supported_construction";
  requiredAction?: "try_alternate_construction";
  text: string;
  /** Actual final discourse coverage; absent only on older imported generation traces. */
  coverageComplete?: boolean;
  symbols: string[];
  phrasesUsed: string[];
  discourse: LanguageDiscourseTrace;
  importedNgramModelIdsUsed: string[];
  importedObservationIdsUsed: string[];
  importedLanguageUnitIdsUsed: string[];
  importedPhrasePatternIdsUsed: string[];
  importedSemanticFrameIdsUsed: string[];
  orderUsage: Array<{ order: number; symbols: number; averageInformation: number; activation: number }>;
  averageInformation: number;
  confidence: number;
  competence: LanguageCompetenceVector;
  stoppedBy: "empty" | "generation_extent" | "source_exhausted";
  audit: JsonValue;
}

/**
 * A source-neutral structural gate for learned language surfaces. Imported
 * prior use is checked by the Mouth; this gate checks only whether the
 * generated discourse is complete enough to speak.
 */
export function languageGenerationSurfaceAdequate(
  generation: Pick<LanguageGenerationResult, "discourse" | "symbols" | "surface" | "coverageComplete">
): boolean {
  return generation.coverageComplete !== false && languageGenerationSurfaceFluent(generation);
}

/** Structurally speakable, whatever share of the request it reached: coverage ranks a surface, it does not silence one. */
export function languageGenerationSurfaceFluent(
  generation: Pick<LanguageGenerationResult, "discourse" | "symbols" | "surface">
): boolean {
  return !!generation.surface && constructionSurfaceComplete(generation.surface) && !!generation.surface.text;
}

/** Reject a dangling learned function-word pair with no attested sentence ending. */
export function languageGenerationSentenceEndingsAdequate(text: string, state: LanguageMemoryRuntimeState): boolean {
  const models = state.models.filter(model => model.order >= 3 && modelSpeaksInWords(model));
  if (!models.length) return true;
  const closedClass = deriveClosedClassWords({ models, continuationPopulation: state.continuationPopulation });
  for (const sentence of splitSurfaceSentences(text)) {
    const words = surfaceWords(sentence).map(word => word.toLocaleLowerCase());
    const final = words.at(-1);
    const penultimate = words.at(-2);
    if (!final || !penultimate || !closedClass.has(final) || !closedClass.has(penultimate)) continue;
    const observed = models.filter(model => (model.contextCounts[final] ?? 0) > 0 && (model.contextCounts[penultimate] ?? 0) > 0);
    if (!observed.length) continue;
    // A model that learned the ending licenses it; no smoothed-probability
    // cutoff and no list of forbidden words can replace that observation.
    const licensed = observed.some(model => ["</s>", ...SENTENCE_BOUNDARY_SYMBOLS]
      .some(symbol => (model.counts[`${penultimate}\u0001${final}\u0001${symbol}`] ?? 0) > 0));
    if (!licensed) return false;
  }
  return true;
}

export const RHETORICAL_MOVE_IDS = {
  lead: "rmove.94c0e1b7",
  support: "rmove.27f59d04",
  contrast: "rmove.a50d62e8",
  sourceBound: "rmove.6bf421c3",
  boundary: "rmove.dd2c049a",
  close: "rmove.7ce84019"
} as const;

export type RhetoricalMove = string;

export interface ParagraphPlan {
  id: string;
  sentencePlans: SentencePlan[];
  targetSymbolCount: number;
  forceClass: string;
  styleProfileId?: string;
  audit: JsonValue;
}

export interface SentencePlan {
  id: string;
  move: RhetoricalMove;
  claimIds: string[];
  requiredAnchors: string[];
  forceClass: string;
  maxTokens?: number;
  rank: number;
}

export interface ClauseCandidate {
  id: string;
  sentencePlanId: string;
  move: RhetoricalMove;
  text: string;
  claimIds: string[];
  requiredAnchors: string[];
  sourcePieceIds: string[];
  support: number;
  coverage: number;
  continuity: number;
  repetitionPenalty: number;
  lengthFit: number;
  score: number;
}

export interface SentenceLattice {
  id: string;
  paragraphPlan: ParagraphPlan;
  clausesByPlan: Array<{ sentencePlanId: string; candidates: ClauseCandidate[] }>;
  edges: Array<{ fromClauseId: string; toClauseId: string; continuity: number; score: number }>;
  audit: JsonValue;
}

export interface ProseCandidate {
  id: string;
  text: string;
  sentencePlanIds: string[];
  clauseIds: string[];
  score: number;
  claimCoverage: number;
  anchorCoverage: number;
  continuity: number;
  repetitionPenalty: number;
  lengthFit: number;
  priorSupport: number;
  audit: JsonValue;
}

export interface ProseCriticResult {
  candidateId: string;
  accepted: boolean;
  score: number;
  issues: string[];
  claimCoverage: number;
  anchorCoverage: number;
  continuity: number;
  repetitionPenalty: number;
  lengthFit: number;
  audit: JsonValue;
}

interface RuntimeDiscoursePriorProfile {
  patternIds: string[];
  targetMoveCount: number;
  targetSymbolCount: number;
  paragraphCount: number;
  sentenceCount: number;
  sentenceSymbolP75: number;
  paragraphSymbolP50: number;
  dialogueTurnRate: number;
  support: number;
}

export interface LanguageDiscourseMove {
  id: string;
  role: string;
  text: string;
  sourcePieceIds: string[];
  frameIds: string[];
  atomIds: string[];
  support: number;
  information: number;
  symbolCount: number;
  planRank?: number;
}

export interface LanguageDiscourseBoundaryUse {
  text: string;
  source: string;
  sourceId?: string;
  support: number;
  betweenMoveIds: [string, string];
}

export interface LanguageGenerationStep {
  index: number;
  action: "emit_move";
  moveId: string;
  role: string;
  textHash: string;
  boundaryBefore?: string;
  sourcePieceIds: string[];
  coveredRequiredTermIds: string[];
  coveredAtomIds: string[];
  score: number;
  cumulativeScore: number;
  transitionScore: number;
}

export interface LanguageDiscourseFluencyTrace {
  beamWidth: number;
  beamExpansions: number;
  candidateMoveCount: number;
  selectedBeamScore: number;
  selectedUnitIds: string[];
  latentCoherence: number;
  ngramMeanActivation: number;
  priorSupport: number;
  coverageGain: number;
  repetitionPenalty: number;
  symbolCount: number;
}

export interface LanguageDiscourseTrace {
  text: string;
  moves: LanguageDiscourseMove[];
  boundaries: LanguageDiscourseBoundaryUse[];
  steps: LanguageGenerationStep[];
  generationStepCount: number;
  stopReason: "coverage_satisfied" | "generation_extent" | "source_exhausted" | "empty";
  requiredTermIdsCovered: string[];
  propositionAtomIdsCovered: string[];
  scoreOrderTextHash: string;
  anchorCoverage: number;
  cohesion: number;
  repetitionPenalty: number;
  discourseScore: number;
  fluency: LanguageDiscourseFluencyTrace;
}

export interface LanguageMemoryCorrection {
  acceptedText: string;
  replacementText: string;
  delta: number;
  trainingText: string;
  audit: JsonValue;
}

export interface LanguageMemoryRuntime {
  hydrate(input: { models: readonly NgramModelRecord[]; observations?: readonly NgramObservation[]; units?: readonly LanguageUnitRecord[]; patterns?: readonly LanguagePatternRecord[]; semanticFrames?: readonly SemanticFrameRecord[]; constructionEvidence?: readonly EvidenceSpan[]; creativeEventCompatibilityModels?: readonly CreativeEventCompatibilityModel[]; importRunId?: string }): LanguageMemoryRuntimeState;
  hydrateFromImportedBrain(input: { importRunId?: string; models: readonly NgramModelRecord[]; observations: readonly NgramObservation[]; units: readonly LanguageUnitRecord[]; patterns: readonly LanguagePatternRecord[]; semanticFrames?: readonly SemanticFrameRecord[]; constructionEvidence?: readonly EvidenceSpan[]; creativeEventCompatibilityModels?: readonly CreativeEventCompatibilityModel[] }): LanguageMemoryRuntimeState;
  profile(input: { state: LanguageMemoryRuntimeState }): JsonValue;
  observe(input: {
    streamId: string;
    sourceSystem?: string;
    profile: LanguageProfile;
    sourceVersionId: SourceVersionId;
    text: string;
    evidence: EvidenceSpan[];
    createdAt: number;
    maxOrder?: number;
    maxCountersPerOrder?: number;
    vocabularyLimit?: number;
  }): NgramMemoryCompilation;
  train(input: {
    streamId: string;
    sourceSystem?: string;
    profile: LanguageProfile;
    sourceVersionId: SourceVersionId;
    text: string;
    evidence: EvidenceSpan[];
    createdAt: number;
    maxOrder?: number;
    maxCountersPerOrder?: number;
    vocabularyLimit?: number;
    retainObservations?: boolean;
    retainSemanticFrames?: boolean;
  }): NgramMemoryCompilation;
  score(input: { state: LanguageMemoryRuntimeState; text: string; contextText?: string }): LanguageMemoryScore;
  suggest(input: { state: LanguageMemoryRuntimeState; context: string | readonly string[]; limit?: number }): LanguageMemorySuggestion[];
  generate(input: LanguageGenerationInput): LanguageGenerationResult;
  realize(input: {
    state: LanguageMemoryRuntimeState;
    requestText: string;
    candidates: Array<{
      text: string;
      surface?: ConstructionSurface;
      evidenceIds?: string[];
      fit?: number;
      /** Typed realization identity used to scope construction corrections. */
      constructionId?: string;
      profileId?: string;
      contextKey?: string;
    }>;
    continuationPrompt?: string;
  }): LanguageMemoryRealization;
  correct(input: { state: LanguageMemoryRuntimeState; acceptedText: string; replacementText: string; contextText?: string }): LanguageMemoryCorrection;
}

export function createLanguageMemoryRuntime(options: { idFactory?: IdFactory; hasher?: Hasher } = {}): LanguageMemoryRuntime {
  return {
    hydrate(input) {
      const records = [...input.models].sort((left, right) => compareCodePoint(left.id, right.id));
      const importedObservations = [...(input.observations ?? [])]
        .sort((a, b) => b.count - a.count || compareCodePoint(a.symbol, b.symbol) || compareCodePoint(a.id, b.id))
        .slice(0, 20000);
      const reconstructed = modelsFromObservations(importedObservations);
      const { models, populations: modelPopulations } = selectRuntimeModels(records, reconstructed);
      const streamIds = uniqueStrings([...records.map(record => record.streamId), ...importedObservations.map(item => item.streamId)]).sort(compareCodePoint);
      const languageHints = uniqueStrings([...records.map(record => record.languageHint), ...importedObservations.map(item => item.languageHint)]).sort(compareCodePoint);
      const observedSymbolCount = models.reduce((sum, model) => sum + model.observedSymbolCount, 0);
      const importedUnits = [...(input.units ?? [])].sort((a, b) => b.alpha - a.alpha || compareCodePoint(a.text, b.text) || compareCodePoint(a.id, b.id)).slice(0, 4096);
      const requestRequirements = reconcileRequestRequirementPatterns((input.patterns ?? []).filter(pattern => pattern.patternKind !== "source_compilation"));
      const persistedPatterns = requestRequirements.patterns
        .sort((a, b) => b.support - a.support || compareCodePoint(a.patternKind, b.patternKind) || compareCodePoint(a.id, b.id))
        .slice(0, 1024);
      const importedPatterns = persistedPatterns.filter(pattern => (
        !isLanguageConstructionPattern(pattern)
        && !isReversibleConstructionPattern(pattern)
        && !isPairedAntiUnifiedPattern(pattern)
        && !isOptionalNullRealizationPattern(pattern)
        && !isCreativeEventCompatibilityPattern(pattern)
      ));
      const importedReversibleConstructions =
        reversibleConstructionsFromPatterns(persistedPatterns);
      const importedPairedAntiUnifiedConstructions =
        pairedAntiUnifiedConstructionsFromPatterns(persistedPatterns);
      const optionalNullRealizationModels =
        optionalNullRealizationModelsFromPatterns(persistedPatterns);
      const importedSemanticFrames = [...(input.semanticFrames ?? [])].sort((a, b) => b.alpha - a.alpha || compareCodePoint(a.id, b.id)).slice(0, 2048);
      const structuralDeltas = languageStructuralDeltasFromPatterns(persistedPatterns);
      const constructionPatterns = persistedPatterns.filter(isLanguageConstructionPattern);
      const constructionInput = constructionPatterns.length ? structuredClone({
        patterns: constructionPatterns, evidence: input.constructionEvidence ?? []
      }) : undefined;
      const vocabularySize = uniqueVocabularySize(models) + uniqueUnitVocabularySize(importedUnits);
      const priorModelCount = input.models.filter(isImportedLanguagePriorModel).length;
      const finish = (constructionMemory: ReturnType<typeof hydrateLanguageConstructionPatterns>): LanguageMemoryRuntimeState => {
        const creativeEventCompatibilityModels = normalizeCreativeEventCompatibilityModels([
          ...(input.creativeEventCompatibilityModels ?? []).filter(model => model.reliability !== "source_observed"),
          ...creativeEventCompatibilityModelsFromPatterns(persistedPatterns, options.hasher ? {
            hasher: options.hasher, evidence: input.constructionEvidence ?? [], events: constructionMemory.bundles.flatMap(bundle => bundle.creativeEvents ?? []),
            referenceBindings: sourceReferenceBindingsFromPatterns({ patterns: persistedPatterns, evidence: input.constructionEvidence ?? [], hasher: options.hasher }).bindings
          } : undefined)
        ]);
        const importedLanguagePriorCount = importedUnits.length + importedPatterns.length + importedObservations.length + importedSemanticFrames.length + constructionMemory.bundles.length + importedReversibleConstructions.length + importedPairedAntiUnifiedConstructions.length + optionalNullRealizationModels.length + creativeEventCompatibilityModels.length + priorModelCount;
        const competenceVector = competenceFromRuntime({ models, observedSymbolCount, vocabularySize, languageHints, importedUnits, importedPatterns, importedObservations, importedSemanticFrames, importedConstructionBundles: constructionMemory.bundles });
        return {
          models,
          modelPopulations,
          records,
          streamIds,
          languageHints,
          maxOrder: models.reduce((max, model) => Math.max(max, model.order), 0),
          observedSymbolCount,
          vocabularySize,
          importedUnits,
          importedPatterns,
          importedObservations,
          importedSemanticFrames,
          structuralDeltas,
          importedConstructionBundles: constructionMemory.bundles,
          importedReversibleConstructions,
          importedPairedAntiUnifiedConstructions,
          optionalNullRealizationModels,
          creativeEventCompatibilityModels,
          rejectedConstructionPatterns: constructionMemory.rejected,
          requestRequirementHydration: requestRequirements.report,
          importedLanguagePriorCount,
          competenceVector,
          scope: {
            mode: "unscoped",
            profileIds: [],
            sourceVersionIds: [],
            purityProven: false,
            degraded: false,
            reason: "no-language-cluster-requested"
          },
          audit: toJsonValue({
            source: "language-memory-runtime",
            importRunId: input.importRunId ?? null,
            modelRecords: input.models.length,
            reconstructedModels: reconstructed.length,
            usableModels: models.length,
            importedUnits: importedUnits.length,
            importedPatterns: importedPatterns.length,
            persistedConstructionPatterns: persistedPatterns.length - importedPatterns.length,
            importedObservations: importedObservations.length,
            importedSemanticFrames: importedSemanticFrames.length,
            importedConstructionBundles: constructionMemory.bundles.length,
            importedReversibleConstructions:
              importedReversibleConstructions.length,
            importedPairedAntiUnifiedConstructions:
              importedPairedAntiUnifiedConstructions.length,
            optionalNullRealizationModels:
              optionalNullRealizationModels.length,
            creativeEventCompatibilityModels: creativeEventCompatibilityModels.length,
            rejectedConstructionPatterns: constructionMemory.rejected,
            requestRequirementHydration: requestRequirements.report,
            importedLanguagePriorCount,
            orders: models.map(model => model.order),
            streamIds: streamIds.slice(0, 24),
            languageHints: languageHints.slice(0, 24),
            observedSymbolCount,
            vocabularySize,
            competenceVector,
            scope: { mode: "unscoped", purityProven: false, degraded: false }
          })
        };
        };
      const independent = finish({ bundles: [], constructions: [], formClasses: [], rejected: [] });
      return constructionInput ? deferConstructionState(independent, () => finish(hydrateLanguageConstructionPatterns({
        ...constructionInput, hasher: options.hasher
      })), [constructionInput]) : independent;
    },

    hydrateFromImportedBrain(input) {
      return this.hydrate(input);
    },

    profile(input) {
      return toJsonValue({
        streamIds: input.state.streamIds,
        languageHints: input.state.languageHints,
        maxOrder: input.state.maxOrder,
        observedSymbolCount: input.state.observedSymbolCount,
        vocabularySize: input.state.vocabularySize,
        importedLanguagePriorCount: input.state.importedLanguagePriorCount,
        importedUnits: input.state.importedUnits.slice(0, 24).map(unit => ({ profileId: unit.profileId, kind: unit.unitKind, text: unit.text, alpha: unit.alpha })),
        importedPatterns: input.state.importedPatterns.slice(0, 24).map(pattern => ({ profileId: pattern.profileId, kind: pattern.patternKind, support: pattern.support, entropy: pattern.entropy })),
        importedSemanticFrames: input.state.importedSemanticFrames.slice(0, 24).map(frame => ({ id: frame.id, alpha: frame.alpha, evidenceIds: frame.evidenceIds })),
        structuralDeltas: (input.state.structuralDeltas ?? []).slice(0, 24).map(delta => ({
          id: delta.id,
          patternId: delta.patternId,
          profileId: delta.profileId,
          kind: delta.kind,
          surface: delta.surface,
          grammatical: delta.grammatical,
          semantic: delta.semantic,
          support: delta.support,
          evidenceIds: delta.evidenceIds
        })),
        importedConstructionBundles: input.state.importedConstructionBundles.slice(0, 24).map(bundle => ({
          id: bundle.id,
          bindingId: bundle.bindingId,
          sourceProfileId: bundle.sourceProfileId,
          targetProfileId: bundle.targetProfileId,
          sourceVersionIds: bundle.sourceVersionIds,
          evidenceIds: bundle.evidenceIds
        })),
        importedReversibleConstructions:
          (input.state.importedReversibleConstructions ?? []).slice(0, 24)
            .map(construction => ({
              id: construction.id,
              profileId: construction.profileId,
              planId: construction.planId,
              evidenceIds: construction.provenance.evidenceIds
            })),
        importedPairedAntiUnifiedConstructions:
          (input.state.importedPairedAntiUnifiedConstructions ?? [])
            .slice(0, 24)
            .map(construction => ({
              id: construction.id,
              profileIds: construction.profileIds,
              sourceConstructionIds: construction.sourceConstructionIds,
              variableSlotIds: construction.surfaceProgram.variableSlotIds
            })),
        optionalNullRealizationModels:
          (input.state.optionalNullRealizationModels ?? []).slice(0, 24)
            .map(model => ({
              id: model.id,
              status: model.status,
              observations: model.observations.length,
              estimates: model.estimates.length,
              threshold: model.threshold.selected
            })),
        creativeEventCompatibilityModels: input.state.creativeEventCompatibilityModels.slice(0, 24).map(model => ({
          id: model.id,
          version: model.version,
          requestCompilerId: model.requestCompilerId,
          eventCompilerId: model.eventCompilerId,
          calibrationId: model.calibrationId,
          reliability: model.reliability
        })),
        rejectedConstructionPatterns: input.state.rejectedConstructionPatterns.slice(0, 24),
        requestRequirementHydration: input.state.requestRequirementHydration ?? null,
        competenceVector: input.state.competenceVector,
        audit: input.state.audit
      });
    },

    observe(input) {
      return trainWithOptions(input, options);
    },

    train(input) {
      return trainWithOptions(input, options);
    },

    score(input) {
      return scoreText(input.state, input.text, input.contextText);
    },

    suggest(input) {
      const context = typeof input.context === "string" ? symbolizeData(input.context) : [...input.context];
      const merged = new Map<string, LanguageMemorySuggestion>();
      for (const model of input.state.models) {
        for (const prediction of predictKneserNey(model, context.slice(-(model.order - 1)), Math.max(8, input.limit ?? 16) * 2)) {
          if (prediction.symbol === "</s>" || prediction.symbol === "<s>") continue;
          const existing = merged.get(prediction.symbol);
          const support = prediction.probability * Math.max(1, model.order);
          if (!existing || support > existing.support) {
            merged.set(prediction.symbol, { symbol: prediction.symbol, probability: prediction.probability, order: model.order, support });
          }
        }
      }
      for (const unit of input.state.importedUnits.slice(0, Math.max(16, input.limit ?? 16) * 4)) {
        if (unit.unitKind !== "symbol" && unit.unitKind !== "phrase") continue;
        const support = Math.max(0.001, unit.alpha);
        const existing = merged.get(unit.text);
        if (!existing || support > existing.support) merged.set(unit.text, { symbol: unit.text, probability: clamp01(support / 4), order: unit.unitKind === "phrase" ? 2 : 1, support });
      }
      return [...merged.values()]
        .sort((a, b) => b.support - a.support || a.symbol.localeCompare(b.symbol))
        .slice(0, input.limit ?? 16);
    },

    generate(input) {
      return generateFromLanguageMemory(input, options.hasher);
    },

    realize(input) {
      const ranked = input.candidates
        .filter(candidate => !candidate.surface || (candidate.surface.text === candidate.text && constructionSurfaceComplete(candidate.surface)))
        .map(candidate => {
          const score = scoreText(input.state, candidate.text, input.requestText);
          const requestFit = weightedJaccard(featureSet(input.requestText, 256), featureSet(candidate.text, 256));
          const structuralDelta = bestStructuralDeltaForSurface(input.state, input.requestText, candidate.text, candidate);
          const structuralDeltaFit = structuralDelta.fit;
          // A complete learned transition binds both the observed request
          // surface and the candidate surface. Let that typed route carry its
          // measured fit into request scoring; lexical overlap alone can
          // otherwise keep the mismatching surface ahead after reload.
          const learnedRequestFit = Math.max(requestFit, structuralDeltaFit);
          const learnedCandidateFit = Math.max(candidate.fit ?? score.fit, structuralDeltaFit);
          const total = clamp01(calibrated("language_memory.total_activation_weight") * score.activation + calibrated("language_memory.total_request_fit_weight") * learnedRequestFit + calibrated("language_memory.total_candidate_fit_weight") * learnedCandidateFit);
          return { candidate, score, total, structuralDeltaFit, structuralDeltaIds: structuralDelta.ids };
        })
        .sort((a, b) => b.total - a.total || a.candidate.text.localeCompare(b.candidate.text));
      const best = ranked[0];
      const continuationModel = input.state.models.find(model => model.order >= 3) ?? input.state.models[0];
      const continuation = continuationModel && input.continuationPrompt
        ? continueBoundedProse(continuationModel, input.continuationPrompt, {
          generationExtent: 32,
          probabilityFloor: 1e-8,
          temperature: 0.82
        })
        : undefined;
      return {
        text: best?.candidate.text ?? "",
        ...(best?.candidate.surface ? { surface: structuredClone(best.candidate.surface) } : {}),
        evidenceIds: best?.candidate.evidenceIds ?? [],
        score: best?.score ?? scoreText(input.state, "", input.requestText),
        continuation: continuation ? {
          text: continuation.text,
          stoppedBy: continuation.stoppedBy,
          averageLogProbability: continuation.averageLogProbability,
          surface: continuation.surface,
          realizationStatus: continuation.realizationStatus
        } : undefined,
        audit: toJsonValue({
          source: "language-memory-runtime.realize",
          candidates: ranked.slice(0, 12).map(row => ({ textHash: hashText(row.candidate.text), total: row.total, activation: row.score.activation, information: row.score.information })),
          selectedScoreAudit: best?.score.audit ?? null,
          importedNgramModelIdsUsed: importedIdsFromScore(best?.score.audit, "importedNgramModelIdsUsed"),
          importedObservationIdsUsed: importedIdsFromScore(best?.score.audit, "importedObservationIdsUsed"),
          importedLanguageUnitIdsUsed: importedIdsFromScore(best?.score.audit, "importedLanguageUnitIdsUsed"),
          importedPhrasePatternIdsUsed: importedIdsFromScore(best?.score.audit, "importedPhrasePatternIdsUsed"),
          importedSemanticFrameIdsUsed: importedIdsFromScore(best?.score.audit, "importedSemanticFrameIdsUsed"),
          structuralDeltaIdsUsed: best?.structuralDeltaIds ?? [],
          structuralDeltaFit: best?.structuralDeltaFit ?? 0,
          continuation: continuation ? {
            stoppedBy: continuation.stoppedBy,
            symbols: continuation.symbols.length,
            averageLogProbability: continuation.averageLogProbability
          } : null
        })
      };
    },

    correct(input) {
      const before = scoreText(input.state, input.acceptedText, input.contextText);
      const after = scoreText(input.state, input.replacementText, input.contextText);
      const delta = after.activation - before.activation;
      const trainingText = [input.contextText, input.replacementText]
        .filter((value): value is string => Boolean(value && value.trim()))
        .join("\n")
        .slice(0, 2_000_000);
      return {
        acceptedText: input.acceptedText,
        replacementText: input.replacementText,
        delta,
        trainingText,
        audit: toJsonValue({
          source: "language-memory-runtime.correct",
          acceptedHash: hashText(input.acceptedText),
          replacementHash: hashText(input.replacementText),
          before: before.audit,
          after: after.audit,
          trainingChars: trainingText.length
        })
      };
    }
  };
}

interface GenerationPiece {
  text: string;
  source: "required_term" | "proposition_atom" | "semantic_rhetoric" | "language_unit" | "phrase_pattern" | "semantic_frame" | "observation" | "suggestion" | "structural_delta";
  id?: string;
  support: number;
  fit: number;
  order: number;
  probability: number;
  score: number;
  semanticMaterialIds?: string[];
  answerSlotIds?: string[];
  demotedMaterialIds?: string[];
  discourseShapeId?: string;
  compressionApplied?: boolean;
  rhetoricalPlanId?: string;
  roleAssignmentIds?: string[];
  rhetoricalStageIds?: string[];
  backgroundMaterialIds?: string[];
  significanceBridgeMaterialIds?: string[];
  structuralDeltaFit?: number;
  structuralDeltaIds?: string[];
  planRank?: number;
}

interface SemanticFactMaterial {
  id: string;
  subjectLabel: string;
  predicateLabel: string;
  objectLabel: string;
  slotIds: string[];
  support: number;
  forceClass: string;
  relationId: string;
  sourceNodeId: string;
  targetNodeId: string;
  frameId: string;
  relevance: number;
  preferredSubjectLabel?: string;
  upstreamRoleId?: string;
  alphaRhetoricalCentrality?: number;
  pathScore?: number;
  roleScore?: number;
  bridgeValue?: number;
  backgroundPenalty?: number;
  forceMeaning?: number;
  certificationPower?: number;
  alphaRhetoricalPlannerId?: string;
  alphaRhetoricalTargetSentenceCount?: number;
  cognitiveEdgeId?: string;
  requestedSlotId?: string;
  relationRoleId?: string;
  graphQualityClassId?: string;
  topicSenseId?: string;
  finalQuestionFit?: number;
  questionSlotId?: string;
  questionSlotImportance?: string;
  questionSlotScore?: number;
  questionSlotReasonIds?: string[];
}

interface AnswerRoleAssignment {
  id: string;
  materialId: string;
  subjectRef: string;
  relationRef: string;
  objectRef: string;
  roleId: string;
  priority: number;
  support: number;
  relationUsefulness: number;
  questionShapeFit: number;
  requestedSlotId?: string;
  relationRoleId?: string;
  topicSenseId?: string;
  questionSlotId?: string;
  questionSlotImportance?: string;
  shouldSurface: boolean;
  surfaceWeight: number;
}

interface RhetoricalPlanStage {
  id: string;
  roleId: string;
  assignmentIds: string[];
  priority: number;
  surfaceWeight: number;
}

interface RhetoricalPlan {
  id: string;
  subjectLabel: string;
  assignments: AnswerRoleAssignment[];
  stages: RhetoricalPlanStage[];
  backgroundAssignmentIds: string[];
  significanceBridgeAssignmentIds: string[];
  targetMoveCount: number;
  certificationBoundaryId?: string;
}

interface DiscourseBoundaryCandidate {
  text: string;
  source: string;
  sourceId?: string;
  support: number;
}

interface DiscourseBeamState {
  moves: LanguageDiscourseMove[];
  text: string;
  symbolCount: number;
  usedMoveIds: string[];
  coveredRequiredTermIds: string[];
  coveredAtomIds: string[];
  score: number;
  transitionScores: number[];
  latentCoherenceSum: number;
  ngramActivationSum: number;
  priorSupportSum: number;
  coverageGainSum: number;
  repetitionPenalty: number;
  boundaryUses: LanguageDiscourseBoundaryUse[];
}

interface DiscourseDecodeResult {
  moves: LanguageDiscourseMove[];
  text: string;
  boundaries: LanguageDiscourseBoundaryUse[];
  fluency: LanguageDiscourseFluencyTrace;
}
function generateFromLanguageMemory(input: LanguageGenerationInput, hasher?: Hasher): LanguageGenerationResult {
  const requiredTerms = generationRequiredTerms(input), atoms = generationFrameAtoms(input);
  const contextText = (input.contextSymbols ?? []).join(" "); // Operational scoring context, never an emitted surface.
  const rhetorical = planLanguageMemoryDiscourse(input);
  const framePriorities = new Map(rhetorical.materials.map(material => [material.frameId,
    rhetorical.plan?.assignments.find(assignment => assignment.materialId === material.id)?.priority ?? 0]));
  const candidates: Array<{ surface: ConstructionSurface; frameIds: string[]; constructionId?: string }> = [];
  const add = (surface: ConstructionSurface, frameIds: string[], constructionId?: string) => {
    if (surface.text && constructionSurfaceComplete(surface)) {
      const boundFrames = (surface.childBindings ?? []).flatMap(binding => (input.frames ?? []).some(frame => frame.id === binding.roleId) ? [binding.roleId] : []);
      candidates.push({ surface: structuredClone(surface), frameIds: [...new Set([...frameIds, ...boundFrames])], constructionId });
    }
  };
  const resolve = (plans: readonly SurfaceMeaningPlan[], frameIds: string[]) => {
    if (!hasher) return;
    for (const plan of plans) for (const bundle of input.state.importedConstructionBundles) {
      if (!bundle.constructions.some(construction => construction.profileKey === plan.profileKey)) continue;
      const result = realizeLearnedSurface({ plan, constructions: bundle.constructions, formClasses: bundle.formClasses, hasher });
      if (result.status === "realized") add(result.realization, frameIds, result.realization.constructionId);
    }
  };
  for (const surface of input.constructionSurfaces ?? []) add(surface, []);
  resolve(input.constructionPlans ?? [], []);
  for (const frame of input.frames ?? []) {
    for (const surface of frame.constructionSurfaces ?? []) add(surface, [frame.id]);
    resolve(frame.constructionPlans ?? [], [frame.id]);
  }
  const ranked = candidates.map(candidate => {
    const score = scoreText(input.state, candidate.surface.text, contextText);
    const required = coveredRequiredTermIds(candidate.surface.text, requiredTerms);
    // Only a caller-bound construction can establish an opaque frame claim.
    const boundAtoms = (input.frames ?? []).filter(frame => candidate.frameIds.includes(frame.id))
      .flatMap(frame => (frame.propositionAtoms ?? []).filter(atom => atoms.some(value => value.id === atom.id)).map(atom => atom.id));
    const coveredAtoms = uniqueStrings([...coveredAtomIds(candidate.surface.text, atoms), ...boundAtoms]);
    const covered = coverageMeetsThreshold(required.length, coveredAtoms.length, requiredTerms, atoms);
    const rhetoricalPriority = Math.max(0, ...candidate.frameIds.map(id => framePriorities.get(id) ?? 0));
    return { ...candidate, score, required, coveredAtoms, covered, rhetoricalPriority };
  }).sort((a, b) => Number(b.covered) - Number(a.covered) || b.required.length - a.required.length
    || b.coveredAtoms.length - a.coveredAtoms.length || b.rhetoricalPriority - a.rhetoricalPriority || b.score.activation - a.score.activation
    || b.score.fit - a.score.fit || compareCodePoint(a.surface.text, b.surface.text));
  const selected = ranked[0], text = selected?.surface.text ?? "", symbols = symbolizeData(text);
  const score = selected?.score ?? scoreText(input.state, "", contextText);
  const id = selected?.constructionId ?? hashText(text);
  const moves: LanguageDiscourseMove[] = selected ? [{ id, role: "construction", text,
    sourcePieceIds: uniqueStrings(selected.surface.trace.flatMap(part => part.sourceExampleIds)),
    frameIds: selected.frameIds, atomIds: selected.coveredAtoms, support: score.activation,
    information: score.information, symbolCount: symbols.length }] : [];
  const discourse: LanguageDiscourseTrace = { text, moves, boundaries: [], steps: moves.map((move, index) => ({
    index, action: "emit_move", moveId: move.id, role: move.role, textHash: hashText(move.text),
    sourcePieceIds: move.sourcePieceIds, coveredRequiredTermIds: selected!.required,
    coveredAtomIds: selected!.coveredAtoms, score: score.activation, cumulativeScore: score.activation, transitionScore: 0
  })), generationStepCount: moves.length, stopReason: !selected ? "empty" : selected.covered ? "coverage_satisfied" : "source_exhausted",
    requiredTermIdsCovered: selected?.required ?? [], propositionAtomIdsCovered: selected?.coveredAtoms ?? [],
    scoreOrderTextHash: hashText(text), anchorCoverage: selected?.covered ? 1 : 0,
    cohesion: selected ? 1 : 0, repetitionPenalty: 0, discourseScore: score.activation,
    fluency: { beamWidth: 1, beamExpansions: candidates.length, candidateMoveCount: candidates.length,
      selectedBeamScore: score.activation, selectedUnitIds: [], latentCoherence: selected ? score.fit : 0,
      ngramMeanActivation: score.activation, priorSupport: score.activation,
      coverageGain: selected?.covered ? 1 : 0, repetitionPenalty: 0, symbolCount: symbols.length } };
  const orderUsage = score.orderScores.map(row => ({ order: row.order, symbols: symbols.length,
    averageInformation: row.information, activation: row.activation }));
  return { text, ...(selected ? { surface: selected.surface } : {}),
    realizationStatus: selected ? "realized" : "unresolved",
    ...(!selected ? { unresolvedReason: "no_supported_construction" as const, requiredAction: "try_alternate_construction" as const } : {}),
    symbols, phrasesUsed: selected ? [text] : [], coverageComplete: selected?.covered ?? false, discourse,
    importedNgramModelIdsUsed: importedIdsFromScore(score.audit, "importedNgramModelIdsUsed"),
    importedObservationIdsUsed: importedIdsFromScore(score.audit, "importedObservationIdsUsed"),
    importedLanguageUnitIdsUsed: importedIdsFromScore(score.audit, "importedLanguageUnitIdsUsed"),
    importedPhrasePatternIdsUsed: importedIdsFromScore(score.audit, "importedPhrasePatternIdsUsed"),
    importedSemanticFrameIdsUsed: importedIdsFromScore(score.audit, "importedSemanticFrameIdsUsed"),
    orderUsage, averageInformation: score.information, confidence: selected ? score.activation : 0,
    competence: input.state.competenceVector, stoppedBy: selected ? "source_exhausted" : "empty",
    audit: toJsonValue({ source: "language-memory-runtime.generate", constructionCandidateCount: candidates.length,
      constructionId: selected?.constructionId ?? null, frameIds: selected?.frameIds ?? [],
      rhetoricalPlan: rhetorical.plan ?? null, discoursePrior: rhetorical.prior ? discoursePriorAudit(rhetorical.prior) : null,
      realizationStatus: selected ? "realized" : "unresolved", score: score.audit,
      requiredTermIdsCovered: selected?.required ?? [], propositionAtomIdsCovered: selected?.coveredAtoms ?? [] }) };
}

/** Plan claim roles and discourse extent without converting labels or boundary statistics into text. */
export function planLanguageMemoryDiscourse(input: LanguageGenerationInput): {
  materials: SemanticFactMaterial[]; plan?: RhetoricalPlan; prior?: RuntimeDiscoursePriorProfile;
} {
  const materials = semanticFactMaterialsFromFrames(input.frames ?? []);
  const contextText = (input.contextSymbols ?? []).join(" ");
  const prior = runtimeDiscoursePriorProfile(input.state, input.generationExtent);
  return { materials, plan: semanticRhetoricalPlanFromMaterials(materials, contextText, prior), prior };
}



interface NarrativeSurfaceConstraint {
  surface: string;
  source: "established_fact_value" | "open_setup_surface";
}

function generationRequiredTerms(input: LanguageGenerationInput): LanguageGenerationTerm[] {
  const terms = new Map<string, LanguageGenerationTerm>();
  const add = (term: LanguageGenerationTerm | undefined) => {
    const text = tidyInline(term?.text ?? "");
    if (!text) return;
    const key = text.normalize("NFKC").toLocaleLowerCase();
    const existing = terms.get(key);
    const next = { ...term, text, weight: clamp01(term?.weight ?? 0.5) };
    if (!existing || (next.weight ?? 0) > (existing.weight ?? 0)) terms.set(key, next);
  };
  for (const term of input.requiredTerms ?? []) add(term);
  for (const frame of input.frames ?? []) for (const term of frame.requiredTerms ?? []) add(term);
  return [...terms.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
}

function generationFrameAtoms(input: LanguageGenerationInput): LanguageGenerationAtom[] {
  const atoms = new Map<string, LanguageGenerationAtom>();
  const add = (atom: LanguageGenerationAtom | undefined, frame: LanguageGenerationFrame | undefined) => {
    const text = tidyInline(atom?.text ?? "");
    if (!atom || !text) return;
    if (!isDiscourseAtom(atom, frame)) return;
    const key = `${atom.id}:${text.normalize("NFKC").toLocaleLowerCase()}`;
    const existing = atoms.get(key);
    const next = { ...atom, text, weight: clamp01(atom.weight ?? 0.5) };
    if (!existing || (next.weight ?? 0) > (existing.weight ?? 0)) atoms.set(key, next);
  };
  for (const frame of input.frames ?? []) for (const atom of frame.propositionAtoms ?? []) add(atom, frame);
  return [...atoms.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.text.localeCompare(b.text));
}

function isDiscourseAtom(atom: LanguageGenerationAtom, frame: LanguageGenerationFrame | undefined): boolean {
  if (frame?.role && frame.role !== "answer" && frame.role !== "caveat" && frame.role !== "example" && frame.role !== "instruction") return false;
  return atom.kind === "claim" || atom.kind === "surface" || atom.kind === "caveat" || atom.kind === "artifact" || atom.kind === "program";
}

interface RhetoricalLatticeGeneration {
  discourse: LanguageDiscourseTrace;
  paragraphPlan: ParagraphPlan;
  lattice: SentenceLattice;
  proseCandidates: ProseCandidate[];
  critic: ProseCriticResult;
}

export function scopeLanguageMemoryStateToProfile(
  state: LanguageMemoryRuntimeState,
  profile: LanguageProfile
): LanguageMemoryRuntimeState {
  const cluster = buildLanguageProfileClusters([profile])[0];
  if (!cluster) return markLanguageMemoryStateUnscoped(state, "profile-cluster-unavailable");
  const scoped = scopeLanguageMemoryStateToCluster(state, cluster);
  return {
    ...scoped,
    audit: toJsonValue({
      ...jsonRecord(scoped.audit),
      profileId: profile.id,
      sourceVersionId: profile.sourceVersionId
    })
  };
}

/** Which artifacts a scope admits. Each predicate sees only what the artifact says about itself. */
export interface LanguageMemoryOwnership {
  /** A model or observation: its profile when it has one, else the corpus it was trained from. */
  record(profileId: string | undefined, sourceSystem: string | undefined): boolean;
  profile(profileId: string): boolean;
  frame(frame: SemanticFrameRecord): boolean;
  bundle(bundle: LanguageMemoryRuntimeState["importedConstructionBundles"][number]): boolean;
  reversible(construction: NonNullable<LanguageMemoryRuntimeState["importedReversibleConstructions"]>[number]): boolean;
}

interface LanguageMemoryScopeMeta {
  mode: "cluster" | "language";
  clusterId?: string;
  languageId?: string;
  /** Profiles the scope names; a language scope names the profiles it retained. */
  profileIds?: readonly string[];
  /** Provenance of the retained material, reported for audit and never consulted for admission. */
  sourceVersionIds?: readonly string[];
  purityProven: boolean;
  source: string;
  emptyReason: string;
  /** Retained although no identity resolves it. Counted so an unmeasured admission never reads as a measured one. */
  unmeasured?: (profileId: string | undefined, sourceSystem: string | undefined) => boolean;
}

/**
 * Scope a hydrated language memory to a cluster of profiles: an artifact stays when its profile is a member, and a
 * construction bundle additionally when every source version it cites is a member's. Document identity, in other
 * words. Kept for translation targets and source-owned language; the language scope below is the general case.
 */
export function scopeLanguageMemoryStateToCluster(
  state: LanguageMemoryRuntimeState,
  cluster: LanguageProfileCluster,
  options: { admitUnprofiled?: boolean } = {}
): LanguageMemoryRuntimeState {
  const profileIds = new Set(cluster.profileIds);
  const sourceVersionIds = new Set(cluster.sourceVersionIds.map(String));
  const owned = (profileId: string | undefined) => ownedLanguageArtifact(profileId, profileIds) || (options.admitUnprofiled === true && !profileId);
  return scopeLanguageMemoryStateWith(state, {
    record: profileId => owned(profileId),
    profile: profileId => profileIds.has(profileId),
    frame: frame => semanticFrameBelongsToCluster(frame, profileIds),
    bundle: bundle => profileIds.has(bundle.targetProfileId)
      && profileIds.has(bundle.sourceProfileId)
      && bundle.sourceVersionIds.length > 0
      && bundle.sourceVersionIds.every(sourceVersionId => sourceVersionIds.has(sourceVersionId))
      && bundle.sourceExamples.every(example => sourceVersionIds.has(example.sourceVersionId) && bundle.evidenceIds.includes(example.evidenceId)),
    reversible: construction => profileIds.has(construction.profileId)
      && Boolean(construction.surface.sourceVersionId)
      && sourceVersionIds.has(construction.surface.sourceVersionId!)
  }, {
    mode: "cluster",
    clusterId: cluster.id,
    profileIds: [...cluster.profileIds].sort(compareCodePoint),
    sourceVersionIds: cluster.sourceVersionIds.map(String).sort(compareCodePoint),
    purityProven: profileIds.size > 0 && sourceVersionIds.size > 0,
    source: "language-memory-runtime.cluster-scope",
    emptyReason: "cluster-has-no-retained-language-memory"
  });
}

/**
 * Scope a hydrated language memory to a learned language identity. An artifact is admitted when its own profile
 * resolves to that language, or, when neither its profile nor its corpus resolves to any identity at all, because no
 * identity has ever measured it -- discovery assigns profiles once, so everything written afterwards is unassigned,
 * and an absent measurement is not a measurement that the artifact is foreign. Which population such an artifact then
 * realizes is decided downstream by its corpus role on measured support. A construction bundle is admitted by the
 * language of the profiles it was induced for; where it came from stays provenance. This is what lets a construction
 * learned from a training batch be spoken in an answer about an article the batch never contained: same language,
 * different document.
 */
export function scopeLanguageMemoryStateToLanguage(
  state: LanguageMemoryRuntimeState,
  languageId: string,
  resolve: {
    profile(profileId: string): string | undefined;
    corpus(sourceSystem: string | undefined): string | undefined;
  }
): LanguageMemoryRuntimeState {
  // Unmeasured, not foreign: no identity has an opinion about this artifact, so the identity gate declines to have one.
  const resolved = (profileId: string | undefined, sourceSystem: string | undefined) =>
    (profileId ? resolve.profile(profileId) : undefined) ?? resolve.corpus(sourceSystem);
  const speaks = (profileId: string | undefined, sourceSystem: string | undefined) => {
    const identity = resolved(profileId, sourceSystem);
    return identity === undefined || identity === languageId;
  };
  const profileSpeaks = (profileId: string | undefined) => Boolean(profileId) && speaks(profileId, undefined);
  return scopeLanguageMemoryStateWith(state, {
    record: speaks,
    profile: profileId => profileSpeaks(profileId),
    frame: frame => {
      const row = jsonRecord(frame.frameJson);
      const profileId = typeof row.profileId === "string" && row.profileId ? row.profileId : undefined;
      return speaks(profileId, typeof row.sourceSystem === "string" ? row.sourceSystem : undefined);
    },
    bundle: bundle => profileSpeaks(bundle.targetProfileId) || profileSpeaks(bundle.sourceProfileId),
    reversible: construction => profileSpeaks(construction.profileId)
  }, {
    mode: "language",
    languageId,
    purityProven: true,
    source: "language-memory-runtime.language-scope",
    emptyReason: "language-has-no-retained-language-memory",
    unmeasured: (profileId, sourceSystem) => resolved(profileId, sourceSystem) === undefined
  });
}

function scopeLanguageMemoryStateWith(
  state: LanguageMemoryRuntimeState,
  ownership: LanguageMemoryOwnership,
  meta: LanguageMemoryScopeMeta
): LanguageMemoryRuntimeState {
  const deferred = deferredConstructionStates.get(state);
  if (deferred) {
    const independent = scopeLanguageMemoryStateWith(deferred.independent, ownership, meta);
    return deferConstructionState(independent, () => scopeLanguageMemoryStateWith(deferred.read(), ownership, meta), deferred.roots);
  }
  const continuationPopulation = meta.languageId && state.continuationPopulation?.languageId === meta.languageId
    ? state.continuationPopulation
    : undefined;
  const records = state.records.filter(record => ownership.record(modelProfileId(record), recordSourceSystem(record.modelJson)));
  const importedObservations = state.importedObservations.filter(record => ownership.record(observationProfileId(record), recordSourceSystem(record.metadata)));
  const importedUnits = state.importedUnits.filter(record => ownership.profile(record.profileId));
  const importedPatterns = state.importedPatterns.filter(record => ownership.profile(record.profileId));
  const structuralDeltas = (state.structuralDeltas ?? []).filter(delta => ownership.profile(delta.profileId));
  const importedSemanticFrames = state.importedSemanticFrames.filter(frame => ownership.frame(frame));
  const importedConstructionBundles = state.importedConstructionBundles.filter(bundle => ownership.bundle(bundle));
  const importedReversibleConstructions =
    (state.importedReversibleConstructions ?? []).filter(construction => ownership.reversible(construction));
  const importedPairedAntiUnifiedConstructions =
    (state.importedPairedAntiUnifiedConstructions ?? []).filter(construction =>
      construction.profileIds.some(profileId => ownership.profile(profileId)));
  const optionalNullRealizationModels =
    (() => {
      const observations = (state.optionalNullRealizationModels ?? [])
        .flatMap(model => model.observations)
        .filter(row => ownership.profile(row.profileId));
      return observations.length
        ? [compileOptionalNullRealizationModel({ observations })]
        : [];
    })();
  const retainedCreativeCompilerIds = new Set(importedConstructionBundles.flatMap(bundle => (
    (bundle.creativeEvents ?? []).map(event => event.compilerId)
  )));
  const creativeEventCompatibilityModels = scopeCreativeEventCompatibilityModels(state.creativeEventCompatibilityModels.filter(model => (
    retainedCreativeCompilerIds.has(model.eventCompilerId)
  )), new Set(importedConstructionBundles.flatMap(bundle => (bundle.creativeEvents ?? []).map(event => event.id))));
  const rejectedConstructionPatterns = state.rejectedConstructionPatterns.filter(issue => (
    issue.profileId ? ownership.profile(issue.profileId) : false
  ));
  const retainedProfileIds = uniqueStrings([
    ...importedUnits.map(record => record.profileId),
    ...importedPatterns.map(record => record.profileId),
    ...importedConstructionBundles.flatMap(bundle => [bundle.sourceProfileId, bundle.targetProfileId]),
    ...records.map(record => modelProfileId(record) ?? "").filter(Boolean)
  ]).sort(compareCodePoint);
  const scopeProfileIds = meta.profileIds ? [...meta.profileIds] : retainedProfileIds;
  const scopeSourceVersionIds = meta.sourceVersionIds
    ? [...meta.sourceVersionIds]
    : uniqueStrings(importedConstructionBundles.flatMap(bundle => bundle.sourceVersionIds.map(String))).sort(compareCodePoint);
  const reconstructed = modelsFromObservations(importedObservations);
  const { models, populations: modelPopulations } = selectRuntimeModels(records, reconstructed);
  const observedSymbolCount = models.reduce((sum, model) => sum + model.observedSymbolCount, 0);
  const vocabularySize = uniqueVocabularySize(models) + uniqueUnitVocabularySize(importedUnits);
  const languageHints = uniqueStrings([
    ...records.map(record => record.languageHint),
    ...importedObservations.map(record => record.languageHint)
  ]).sort(compareCodePoint);
  const ordinaryPatterns = importedPatterns.filter(pattern => !isLanguageConstructionPattern(pattern));
  const importedLanguagePriorCount = importedUnits.length
    + ordinaryPatterns.length
    + importedObservations.length
    + importedSemanticFrames.length
    + importedConstructionBundles.length
    + importedReversibleConstructions.length
    + importedPairedAntiUnifiedConstructions.length
    + optionalNullRealizationModels.length
    + creativeEventCompatibilityModels.length
   
    + (continuationPopulation ? 1 : 0)
    + records.filter(isImportedLanguagePriorModel).length;
  const competenceVector = competenceFromRuntime({
    models,
    observedSymbolCount,
    vocabularySize,
    languageHints,
    importedUnits,
    importedPatterns: ordinaryPatterns,
    importedObservations,
    importedSemanticFrames,
    importedConstructionBundles
  });
  return {
    models,
    modelPopulations,
    continuationPopulation,
    records,
    streamIds: uniqueStrings([
      ...records.map(record => record.streamId),
      ...importedObservations.map(record => record.streamId)
    ]).sort(compareCodePoint),
    languageHints,
    maxOrder: models.reduce((max, model) => Math.max(max, model.order), 0),
    observedSymbolCount,
    vocabularySize,
    importedUnits,
    importedPatterns,
    importedObservations,
    importedSemanticFrames,
    structuralDeltas,
    importedConstructionBundles,
    importedReversibleConstructions,
    importedPairedAntiUnifiedConstructions,
    optionalNullRealizationModels,
    creativeEventCompatibilityModels,
    rejectedConstructionPatterns,
    importedLanguagePriorCount,
    competenceVector,
    scope: {
      mode: meta.mode,
      ...(meta.clusterId ? { clusterId: meta.clusterId } : {}),
      ...(meta.languageId ? { languageId: meta.languageId } : {}),
      profileIds: scopeProfileIds,
      sourceVersionIds: scopeSourceVersionIds,
      purityProven: meta.purityProven,
      degraded: importedLanguagePriorCount === 0,
      ...(importedLanguagePriorCount === 0 ? { reason: meta.emptyReason } : {})
    },
    audit: toJsonValue({
      source: meta.source,
      mode: meta.mode,
      clusterId: meta.clusterId ?? null,
      languageId: meta.languageId ?? null,
      profileIds: scopeProfileIds,
      sourceVersionIds: scopeSourceVersionIds,
      purityProven: meta.purityProven,
      degraded: importedLanguagePriorCount === 0,
      retained: {
        modelRecords: records.length,
        unmeasuredIdentityModelRecords: meta.unmeasured
          ? records.filter(record => meta.unmeasured!(modelProfileId(record), recordSourceSystem(record.modelJson))).length
          : 0,
        continuationPopulations: continuationPopulation ? 1 : 0,
        observations: importedObservations.length,
        units: importedUnits.length,
        patterns: importedPatterns.length,
        semanticFrames: importedSemanticFrames.length,
        constructionBundles: importedConstructionBundles.length,
        reversibleConstructions: importedReversibleConstructions.length,
        pairedAntiUnifiedConstructions:
          importedPairedAntiUnifiedConstructions.length,
        optionalNullRealizationModels:
          optionalNullRealizationModels.length,
        creativeEventCompatibilityModels: creativeEventCompatibilityModels.length
      },
      rejected: {
        modelRecords: state.records.length - records.length,
        continuationPopulations: state.continuationPopulation && !continuationPopulation ? 1 : 0,
        observations: state.importedObservations.length - importedObservations.length,
        units: state.importedUnits.length - importedUnits.length,
        patterns: state.importedPatterns.length - importedPatterns.length,
        semanticFrames: state.importedSemanticFrames.length - importedSemanticFrames.length,
        constructionBundles: state.importedConstructionBundles.length - importedConstructionBundles.length,
        reversibleConstructions:
          (state.importedReversibleConstructions?.length ?? 0)
          - importedReversibleConstructions.length,
        pairedAntiUnifiedConstructions:
          (state.importedPairedAntiUnifiedConstructions?.length ?? 0)
          - importedPairedAntiUnifiedConstructions.length,
        optionalNullRealizationModels:
          (state.optionalNullRealizationModels?.length ?? 0)
          - optionalNullRealizationModels.length,
        creativeEventCompatibilityModels:
          state.creativeEventCompatibilityModels.length - creativeEventCompatibilityModels.length
      }
    })
  };
}

export function markLanguageMemoryStateUnscoped(
  state: LanguageMemoryRuntimeState,
  reason: string
): LanguageMemoryRuntimeState {
  const competenceVector = competenceFromRuntime({
    models: [],
    observedSymbolCount: 0,
    vocabularySize: 0,
    languageHints: [],
    importedUnits: [],
    importedPatterns: [],
    importedObservations: [],
    importedSemanticFrames: []
  });
  return {
    models: [],
    modelPopulations: [],
    continuationPopulation: undefined,
    records: [],
    streamIds: [],
    languageHints: [],
    maxOrder: 0,
    observedSymbolCount: 0,
    vocabularySize: 0,
    importedUnits: [],
    importedPatterns: [],
    importedObservations: [],
    importedSemanticFrames: [],
    importedConstructionBundles: [],
    importedReversibleConstructions: [],
    importedPairedAntiUnifiedConstructions: [],
    optionalNullRealizationModels: [],
    creativeEventCompatibilityModels: [],
    rejectedConstructionPatterns: [],
    importedLanguagePriorCount: 0,
    competenceVector,
    scope: {
      mode: "unscoped",
      profileIds: [],
      sourceVersionIds: [],
      purityProven: false,
      degraded: true,
      reason
    },
    audit: toJsonValue({
      source: "language-memory-runtime.empty-unscoped",
      scope: {
        mode: "unscoped",
        purityProven: false,
        degraded: true,
        reason,
        retained: {
          modelRecords: 0,
          observations: 0,
          units: 0,
          patterns: 0,
          semanticFrames: 0,
          constructionBundles: 0,
          creativeEventCompatibilityModels: 0
        },
        rejected: {
          modelRecords: state.records.length,
          observations: state.importedObservations.length,
          units: state.importedUnits.length,
          patterns: state.importedPatterns.length,
          semanticFrames: state.importedSemanticFrames.length,
          constructionBundles: state.importedConstructionBundles.length,
          creativeEventCompatibilityModels: state.creativeEventCompatibilityModels.length
        }
      }
    })
  };
}

function anchorCoverage(text: string, anchors: readonly string[]): number {
  const required = uniqueStrings(anchors.map(tidyInline).filter(Boolean));
  if (!required.length) return 1;
  const covered = required.filter(anchor => containsLoose(text, anchor) || weightedJaccard(featureSet(text, 128), featureSet(anchor, 128)) > calibrated("language_memory.anchor_similarity_floor")).length;
  return covered / required.length;
}

/**
 * Plan items 140-141. Same real coverage threshold `discourseBeamHasCoverage`
 * already applies to the primary evidence-grounded beam-search discourse
 * path, applied to a `LanguageDiscourseTrace` (the shape
 * `learnedContinuationDiscourse`'s Kneser-Ney-driven fallback returns).
 * Before this, `generateFromLanguageMemory`'s fallback-acceptance decision
 * (below) only ever checked `discourseSurfaceAdequate` -- a pure fluency/
 * quality gate (length, lexical diversity, repetition, fragment-heaviness)
 * with zero awareness of `requiredTerms`/`frameAtoms` -- meaning a fluent
 * but factually empty Kneser-Ney continuation could replace the real
 * evidence-grounded discourse whenever the latter merely fell short on
 * fluency. That let Kneser-Ney's own statistical seed selection
 * (language-memory-runtime.ts's `learnedContinuationDiscourse`, ~line
 * 3080) actually determine generated content, not just rank among already-
 * licensed derivations -- exactly item 140's violation, and exactly the
 * gap item 141's test needs to close.
 */
function coverageMeetsThreshold(
  requiredCoveredCount: number,
  atomCoveredCount: number,
  requiredTerms: readonly LanguageGenerationTerm[],
  atoms: readonly LanguageGenerationAtom[]
): boolean {
  const requiredDenominator = requiredCoverageDenominator(requiredTerms);
  const atomDenominator = atomCoverageDenominator(atoms);
  const requiredOk = requiredDenominator === 0 || requiredCoveredCount >= requiredDenominator;
  const atomOk = atomDenominator === 0 || atomCoveredCount >= Math.max(1, Math.ceil(atomDenominator * 0.5));
  return requiredOk && atomOk;
}

export function discourseTraceHasCoverage(
  discourse: LanguageDiscourseTrace,
  requiredTerms: readonly LanguageGenerationTerm[],
  atoms: readonly LanguageGenerationAtom[]
): boolean {
  return coverageMeetsThreshold(discourse.requiredTermIdsCovered.length, discourse.propositionAtomIdsCovered.length, requiredTerms, atoms);
}

function requiredCoverageDenominator(requiredTerms: readonly LanguageGenerationTerm[]): number {
  return requiredTerms.filter(term => (term.weight ?? 0) >= calibrated("language_memory.required_term_weight_floor") && tidyInline(term.text)).length;
}

function atomCoverageDenominator(atoms: readonly LanguageGenerationAtom[]): number {
  return atoms.filter(atom => tidyInline(atom.text)).length;
}

/** A vocabulary dominated by single-code-point symbols is a char-level (script) model, not a prose model. */
function modelSpeaksInWords(model: { vocabulary?: readonly string[] }): boolean {
  const sample = (model.vocabulary ?? [])
    .filter(symbol => symbol !== "<unk>" && symbol !== "<s>" && symbol !== "</s>")
    .slice(0, 256);
  if (!sample.length) return false;
  const multiPoint = sample.filter(symbol => [...symbol].length > 1).length;
  return multiPoint / sample.length >= 0.5;
}

// A punctuation/symbol run only counts as a clause boundary when it sits
// next to whitespace (or the string edge). Punctuation glued directly
// between two non-space characters on both sides -- the hyphen in
// "quiet-hours", the colon in "9:00", the periods in "p.m." -- is normal
// word-internal formatting, not a sentence fragment break; splitting on
// every punctuation run regardless of adjacency wrongly flagged ordinary
// sentences containing times, percentages, or hyphenated compounds as
// "fragment heavy" phrase salad.
const DISCOURSE_FRAGMENT_BOUNDARY = /(?<=^|\s)[\p{Punctuation}\p{Symbol}]+|[\p{Punctuation}\p{Symbol}]+(?=\s|$)/gu;

/** Punctuation that sits inside a lexical unit: a path separator, a dotted extension, a hyphenated compound. */
const WORD_INTERNAL_PUNCTUATION = /[./-]+/u;

function coveredRequiredTermIds(text: string, requiredTerms: readonly LanguageGenerationTerm[]): string[] {
  return requiredTerms
    .filter(term => (term.weight ?? 0) >= 0.45)
    .filter(term => {
      const clean = tidyInline(term.text);
      return clean && collapseSurfaceWhitespace(text).normalize("NFKC").toLocaleLowerCase()
        .includes(collapseSurfaceWhitespace(clean).normalize("NFKC").toLocaleLowerCase());
    })
    .map(term => term.id ?? hashText(tidyInline(term.text)))
    .slice(0, 64);
}

function coveredAtomIds(text: string, atoms: readonly LanguageGenerationAtom[]): string[] {
  return atoms
    .filter(atom => {
      const clean = tidyInline(atom.text);
      return clean && containsLoose(text, clean);
    })
    .map(atom => atom.id)
    .slice(0, 64);
}

function containsLoose(text: string, surface: string): boolean {
  const haystack = text.normalize("NFKC").toLocaleLowerCase();
  const needle = surface.normalize("NFKC").toLocaleLowerCase();
  return Boolean(needle && haystack.includes(needle));
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function compareCodePoint(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function trainWithOptions(input: Parameters<LanguageMemoryRuntime["train"]>[0], options: { idFactory?: IdFactory; hasher?: Hasher }): NgramMemoryCompilation {
  if (!options.idFactory || !options.hasher) {
    throw new Error("language memory training requires idFactory and hasher");
  }
  return createNgramMemoryCompiler({ idFactory: options.idFactory, hasher: options.hasher }).compile({
    streamId: input.streamId,
    sourceSystem: input.sourceSystem,
    profile: input.profile,
    sourceVersionId: input.sourceVersionId,
    text: input.text,
    evidence: input.evidence,
    createdAt: input.createdAt,
    maxOrder: input.maxOrder ?? 6,
    maxCountersPerOrder: input.maxCountersPerOrder,
    vocabularyLimit: input.vocabularyLimit,
    retainObservations: input.retainObservations,
    retainSemanticFrames: input.retainSemanticFrames
  });
}

function scoreText(state: LanguageMemoryRuntimeState, text: string, contextText?: string): LanguageMemoryScore {
  const textFeatures = featureSet(text, 256);
  const contextFeatures = contextText ? featureSet(contextText, 256) : [];
  const fit = contextFeatures.length ? weightedJaccard(textFeatures, contextFeatures) : textFeatures.length ? 0.5 : 0;
  const orderScores = state.models.map(model => {
    const information = surfaceInformation(text, model);
    const activation = Math.exp(-Math.min(24, information)) * Math.max(1, model.order) / 21;
    const orderFit = clamp01(calibrated("language_memory.order_fit_weight") * fit + calibrated("language_memory.order_observed_mass_weight") * Math.min(1, model.observedSymbolCount / 10000));
    return { order: model.order, activation, information, fit: orderFit, observedSymbolCount: model.observedSymbolCount, vocabularySize: model.vocabularySize };
  });
  const priorInfluence = importedPriorInfluence(state, text, orderScores);
  const activation = clamp01((orderScores.length ? orderScores.reduce((sum, row) => sum + row.activation * (0.55 + row.fit * 0.45), 0) : 0) + priorInfluence.activation);
  const information = orderScores.length ? mean(orderScores.map(row => row.information)) : text.trim() ? 16 : 0;
  return {
    activation,
    information,
    fit,
    orderScores,
    audit: toJsonValue({
      source: "language-memory-runtime.score",
      textHash: hashText(text),
      activation,
      information,
      fit,
      orders: orderScores.map(row => ({ order: row.order, activation: row.activation, information: row.information, fit: row.fit })),
      importedPriorActivation: priorInfluence.activation,
      importedLanguagePriorCount: state.importedLanguagePriorCount,
      importedNgramModelIdsUsed: priorInfluence.modelIds,
      importedObservationIdsUsed: priorInfluence.observationIds,
      importedLanguageUnitIdsUsed: priorInfluence.unitIds,
      importedPhrasePatternIdsUsed: priorInfluence.patternIds,
      importedSemanticFrameIdsUsed: priorInfluence.semanticFrameIds,
      importedPriorHits: priorInfluence.hits
    })
  };
}

function importedPriorInfluence(
  state: LanguageMemoryRuntimeState,
  text: string,
  orderScores: readonly { order: number; activation: number }[]
): { activation: number; modelIds: string[]; observationIds: string[]; unitIds: string[]; patternIds: string[]; semanticFrameIds: string[]; hits: Array<{ kind: string; id: string; support: number }> } {
  if (!text.trim()) return { activation: 0, modelIds: [], observationIds: [], unitIds: [], patternIds: [], semanticFrameIds: [], hits: [] };
  const lower = text.toLocaleLowerCase();
  const tokenSet = new Set(symbolizeData(text).map(symbol => symbol.toLocaleLowerCase()));
  let mass = 0;
  const hits: Array<{ kind: string; id: string; support: number }> = [];
  const modelIds = importedNgramModelIdsForOrders(state, orderScores);
  if (modelIds.length) {
    const modelMass = Math.min(1.2, modelIds.length * 0.08);
    mass += modelMass;
    for (const id of modelIds.slice(0, 24)) hits.push({ kind: "ngram_model", id, support: modelMass / Math.max(1, modelIds.length) });
  }
  for (const unit of state.importedUnits.slice(0, 1024)) {
    const symbol = unit.text.toLocaleLowerCase();
    if (!symbol || symbol.length > lower.length + 16) continue;
    if (lower.includes(symbol)) {
      const support = Math.max(0.01, unit.alpha);
      mass += support;
      hits.push({ kind: "language_unit", id: unit.id, support });
    }
    if (hits.length >= 96) break;
  }
  for (const observation of state.importedObservations.slice(0, 4096)) {
    const symbol = observation.symbol.toLocaleLowerCase();
    if (!tokenSet.has(symbol)) continue;
    const historyFit = observation.history.length === 0 || observation.history.slice(-5).some(item => tokenSet.has(item.toLocaleLowerCase()));
    if (!historyFit) continue;
    const support = Math.max(0.001, Math.log2(1 + observation.count) * Math.max(0.1, observation.fieldWeight) / 18);
    mass += support;
    hits.push({ kind: "ngram_observation", id: observation.id, support });
    if (hits.length >= 128) break;
  }
  for (const pattern of state.importedPatterns.slice(0, 1024)) {
    const matched = patternKeys(pattern).some(key => key && lower.includes(key.toLocaleLowerCase()));
    if (!matched) continue;
    const support = Math.max(0.001, pattern.support / 8);
    mass += support;
    hits.push({ kind: "language_pattern", id: pattern.id, support });
    if (hits.length >= 160) break;
  }
  for (const frame of state.importedSemanticFrames.slice(0, 1024)) {
    const matched = semanticFrameSurfaces(frame).some(surface => surface && lower.includes(surface.toLocaleLowerCase()));
    if (!matched) continue;
    const support = Math.max(0.001, frame.alpha / 6);
    mass += support;
    hits.push({ kind: "semantic_frame", id: frame.id, support });
    if (hits.length >= 192) break;
  }
  const sorted = hits.sort((a, b) => b.support - a.support || a.id.localeCompare(b.id));
  return {
    activation: clamp01(Math.log2(1 + mass) / 12),
    modelIds: modelIds.slice(0, 24),
    observationIds: sorted.filter(item => item.kind === "ngram_observation").map(item => item.id).slice(0, 32),
    unitIds: sorted.filter(item => item.kind === "language_unit").map(item => item.id).slice(0, 32),
    patternIds: sorted.filter(item => item.kind === "language_pattern").map(item => item.id).slice(0, 32),
    semanticFrameIds: sorted.filter(item => item.kind === "semantic_frame").map(item => item.id).slice(0, 32),
    hits: sorted.slice(0, 48)
  };
}

function importedNgramModelIdsForOrders(state: LanguageMemoryRuntimeState, orderScores: readonly { order: number; activation: number }[]): string[] {
  const activeOrders = new Set(orderScores.filter(row => row.activation > 0).map(row => row.order));
  return state.records
    .filter(record => {
      const model = jsonRecord(jsonRecord(record.modelJson).model);
      return activeOrders.has(record.maxOrder) || activeOrders.has(numberOf(model.order));
    })
    .filter(isImportedLanguagePriorModel)
    .map(record => record.id)
    .slice(0, 64);
}

/**
 * A creative-event bundle pattern's real content lives nested under
 * "bundle" -- these flat siblings are provenance, never phrase surfaces,
 * regardless of what the fallback below would otherwise scrape.
 */
const PATTERN_PROVENANCE_FIELD_NAMES = new Set([
  "sourceUri", "streamUri", "relativePath", "sourceHash", "sourceSystem", "sourceSystemId",
  "sourceVersionId", "profileId", "textHash", "contentDigest", "provenanceClass",
  "languageAliases", "schema", "forceClass", "evidenceId", "index"
]);

/** A compiled request pattern counts feature keys ("any:story ⁣ start:write"), not phrases; handed to generation as
 *  pieces they were spoken ("any:story about", live 2026-09-10). Pure. */
function patternKeyIsFeatureKey(key: string): boolean {
  return /(?:^|\s)(?:any|start|end|sym|bi|tri|char):/u.test(key) || key.includes("⁣");
}

function patternKeys(pattern: LanguagePatternRecord): string[] {
  const json = jsonRecord(pattern.patternJson);
  if (json.schema === INDUCED_LANGUAGE_SYNTAX_MEMORY_PATTERN_SCHEMA) return [];
  const counts = jsonRecord(json.counts);
  const keys = Object.keys(counts).filter(key => !patternKeyIsFeatureKey(key));
  if (keys.length) return keys.slice(0, 64);
  return Object.entries(json)
    .filter(([key, value]) => typeof value === "string" && !PATTERN_PROVENANCE_FIELD_NAMES.has(key))
    .map(([, value]) => String(value))
    .slice(0, 64);
}

export function semanticFrameSurfaces(frame: SemanticFrameRecord): string[] {
  const surfaces: string[] = [];
  const visit = (value: JsonValue | undefined, depth: number) => {
    if (depth > 4 || surfaces.length >= 64) return;
    if (typeof value === "string") {
      const compact = tidyInline(value);
      if (compact) surfaces.push(compact);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (!isRecord(value)) return;
    for (const key of ["surface", "text", "excerpt", "proposition", "claim", "phrase", "title", "summary"]) visit(value[key], depth + 1);
    for (const key of ["frame", "content", "metadata", "source", "originalSource"]) visit(value[key], depth + 1);
  };
  visit(frame.frameJson, 0);
  return [...new Set(surfaces)].slice(0, 64);
}

function importedIdsFromScore(value: JsonValue | undefined, key: string): string[] {
  const raw = jsonRecord(value)[key];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function surfaceInformation(text: string, model: KneserNeyModel): number {
  const symbols = symbolizeData(text).slice(0, 128);
  if (!symbols.length) return 16;
  const padded = [...Array(Math.max(0, model.order - 1)).fill("<s>"), ...symbols, "</s>"];
  let info = 0;
  let count = 0;
  for (let i = Math.max(0, model.order - 1); i < padded.length; i++) {
    const context = padded.slice(Math.max(0, i - model.order + 1), i);
    const symbol = padded[i] ?? "</s>";
    const p = Math.max(1e-12, kneserNeyProbability(model, context, symbol));
    info += -Math.log(p);
    count++;
  }
  return info / Math.max(1, count);
}

function modelsFromObservations(observations: readonly NgramObservation[]): KneserNeyModel[] {
  const byOrder = new Map<number, NgramObservation[]>();
  for (const observation of observations) {
    if (observation.order < 1 || observation.order > 6) continue;
    byOrder.set(observation.order, [...(byOrder.get(observation.order) ?? []), observation]);
  }
  const unigramCounts = new Map<string, number>();
  for (const observation of byOrder.get(1) ?? []) unigramCounts.set(observation.symbol, (unigramCounts.get(observation.symbol) ?? 0) + observation.count);
  const vocabulary = [...unigramCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24000).map(([symbol]) => symbol);
  const models: KneserNeyModel[] = [];
  for (const [order, rows] of [...byOrder.entries()].sort((a, b) => a[0] - b[0])) {
    const counts = new Map<string, number>();
    const contextCounts = new Map<string, number>();
    const continuationContexts = new Map<string, Set<string>>();
    const contextContinuationTypes = new Map<string, Set<string>>();
    for (const row of rows) {
      const gram = [...row.history.slice(-(order - 1)), row.symbol];
      const key = gram.join("\u0001");
      counts.set(key, (counts.get(key) ?? 0) + row.count);
      if (order > 1) {
        const context = gram.slice(0, -1).join("\u0001");
        contextCounts.set(context, (contextCounts.get(context) ?? 0) + row.count);
        if (!continuationContexts.has(row.symbol)) continuationContexts.set(row.symbol, new Set());
        continuationContexts.get(row.symbol)!.add(context);
        if (!contextContinuationTypes.has(context)) contextContinuationTypes.set(context, new Set());
        contextContinuationTypes.get(context)!.add(row.symbol);
      }
    }
    if (!counts.size) continue;
    const continuationCounts = new Map<string, number>();
    for (const [symbol, contexts] of continuationContexts) continuationCounts.set(symbol, contexts.size);
    const totalContinuationTypes = [...continuationContexts.values()].reduce((sum, contexts) => sum + contexts.size, 0);
    const core = {
      order,
      discount: 0.75,
      observedSymbolCount: rows.reduce((sum, row) => sum + row.count, 0),
      vocabularySize: vocabulary.length,
      counts: Object.fromEntries(counts),
      contextCounts: Object.fromEntries(contextCounts),
      continuationCounts: Object.fromEntries(continuationCounts),
      contextContinuationTypes: Object.fromEntries([...contextContinuationTypes.entries()].map(([key, set]) => [key, set.size])),
      totalContinuationTypes,
      unigramCounts: Object.fromEntries(unigramCounts),
      totalUnigramCount: [...unigramCounts.values()].reduce((sum, count) => sum + count, 0),
      vocabulary
    };
    models.push({
      ...core,
      ...compileKneserNeyRuntimeIndexes(core)
    });
  }
  return models;
}

function selectRuntimeModels(records: readonly NgramModelRecord[], reconstructed: readonly KneserNeyModel[]): {
  models: KneserNeyModel[];
  populations: LanguageModelPopulation[];
} {
  const candidates: Array<{ key: string; model: KneserNeyModel; population: LanguageModelPopulation }> = [];
  for (const record of [...records].sort((left, right) => compareCodePoint(left.id, right.id))) {
    const model = ngramModelFromRecord(record);
    if (!model) continue;
    const row = jsonRecord(record.modelJson);
    candidates.push({
      key: `record:${record.id}`,
      model,
      population: {
        modelId: record.id,
        ...(typeof row.sourceSystem === "string" && row.sourceSystem ? { sourceSystem: row.sourceSystem } : {}),
        ...(typeof row.corpusRole === "string" && row.corpusRole ? { corpusRoleId: row.corpusRole } : {})
      }
    });
  }
  for (const model of reconstructed) {
    candidates.push({ key: `reconstructed:${model.order}`, model, population: { modelId: `reconstructed:${model.order}` } });
  }
  const selected = candidates
    .sort((left, right) => right.model.order - left.model.order
      || right.model.observedSymbolCount - left.model.observedSymbolCount
      || compareCodePoint(left.key, right.key))
    .slice(0, 36);
  return { models: selected.map(item => item.model), populations: selected.map(item => item.population) };
}

function recordSourceSystem(json: JsonValue | undefined): string | undefined {
  const row = jsonRecord(json);
  return typeof row.sourceSystem === "string" && row.sourceSystem ? row.sourceSystem : undefined;
}

function modelProfileId(record: NgramModelRecord): string | undefined {
  const row = jsonRecord(record.modelJson);
  return typeof row.profileId === "string" && row.profileId ? row.profileId : undefined;
}

function observationProfileId(record: NgramObservation): string | undefined {
  const row = jsonRecord(record.metadata);
  return typeof row.profileId === "string" && row.profileId ? row.profileId : undefined;
}

function ownedLanguageArtifact(
  profileId: string | undefined,
  profileIds: ReadonlySet<string>
): boolean {
  return Boolean(profileId) && profileIds.has(profileId!);
}

function semanticFrameBelongsToCluster(
  frame: SemanticFrameRecord,
  profileIds: ReadonlySet<string>
): boolean {
  const row = jsonRecord(frame.frameJson);
  return typeof row.profileId === "string"
    && row.profileId.length > 0
    && profileIds.has(row.profileId);
}

// Compiling a record is pure in the record, and scoping re-derives every retained model on each turn; the result is
// held weakly so a live hydration's model is reused rather than rebuilt, and adds no retention of its own.
const compiledModelsByIdentity = new Map<string, WeakRef<KneserNeyModel>>();
const compiledModelFinalizers = new FinalizationRegistry<string>(identity => {
  if (compiledModelsByIdentity.get(identity)?.deref() === undefined) compiledModelsByIdentity.delete(identity);
});

// A write replaces model_json and updated_at together, so those plus the counts this record reports fix its content.
function compiledModelIdentity(record: NgramModelRecord, row: Record<string, JsonValue>): string {
  return [
    record.id,
    record.updatedAt,
    numberOf(row.order),
    numberOf(row.totalUnigramCount),
    numberOf(row.observedSymbolCount),
    numberOf(row.vocabularySize),
    numberOf(row.totalContinuationTypes)
  ].join("\u001f");
}

function ngramModelFromRecord(record: NgramModelRecord): KneserNeyModel | undefined {
  const json = record.modelJson;
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const container = (json as Record<string, JsonValue>).model;
  if (!container || typeof container !== "object" || Array.isArray(container)) return undefined;
  const identity = compiledModelIdentity(record, container as Record<string, JsonValue>);
  const cached = compiledModelsByIdentity.get(identity)?.deref();
  if (cached) return cached;
  compilations += 1;
  const compiled = compileNgramModelFromRecord(record);
  if (compiled) {
    compiledModelsByIdentity.set(identity, new WeakRef(compiled));
    compiledModelFinalizers.register(compiled, identity);
  }
  return compiled;
}

let compilations = 0;

/** Test seam: how many records have been compiled into runtime models, and a reset of the memo. */
export function ngramModelCompilationCount(): number {
  return compilations;
}

export function clearNgramModelCompilationMemo(): void {
  compiledModelsByIdentity.clear();
  compilations = 0;
}

function compileNgramModelFromRecord(record: NgramModelRecord): KneserNeyModel | undefined {
  const json = record.modelJson;
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const model = materializeKneserNey((json as Record<string, JsonValue>).model);
  if (model) model.sourceKey = modelProfileId(record) ?? record.streamId;
  return model;
}

function numberOf(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: JsonValue | undefined): value is Record<string, JsonValue> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return isRecord(value) ? value : {};
}

function uniqueVocabularySize(models: readonly KneserNeyModel[]): number {
  const symbols = new Set<string>();
  for (const model of models) for (const symbol of model.vocabulary) symbols.add(symbol);
  return symbols.size;
}

function uniqueUnitVocabularySize(units: readonly LanguageUnitRecord[]): number {
  const symbols = new Set<string>();
  for (const unit of units) if (unit.unitKind === "symbol" || unit.unitKind === "phrase") symbols.add(unit.text);
  return symbols.size;
}

function tidyInline(text: string): string {
  const out: string[] = [];
  let pendingSpace = false;
  for (const char of text.normalize("NFC")) {
    if (isWhitespaceChar(char)) {
      pendingSpace = out.length > 0;
      continue;
    }
    if (pendingSpace) out.push(" ");
    pendingSpace = false;
    out.push(char);
    if (out.length >= 400) break;
  }
  return out.join("").trim();
}

function isWhitespaceChar(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function provenanceClass(value: JsonValue): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value.provenanceClass ?? value.forceClass;
  if (typeof direct === "string") return direct;
  const nested = value.modelJson;
  if (isRecord(nested)) {
    const nestedDirect = nested.provenanceClass ?? nested.forceClass;
    if (typeof nestedDirect === "string") return nestedDirect;
  }
  return undefined;
}

function isImportedLanguagePriorModel(record: NgramModelRecord): boolean {
  const provenance = provenanceClass(record.modelJson);
  return provenance === "learned_language_prior" || provenance === "learned_program_prior" || record.languageHint.startsWith("learned:");
}

function competenceFromRuntime(input: {
  models: readonly KneserNeyModel[];
  observedSymbolCount: number;
  vocabularySize: number;
  languageHints: readonly string[];
  importedUnits?: readonly LanguageUnitRecord[];
  importedPatterns?: readonly LanguagePatternRecord[];
  importedObservations?: readonly NgramObservation[];
  importedSemanticFrames?: readonly SemanticFrameRecord[];
  importedConstructionBundles?: readonly DurableLanguageConstructionBundle[];
}): LanguageCompetenceVector {
  const maxOrder = input.models.reduce((max, model) => Math.max(max, model.order), 0);
  const modelCoverage = clamp01(input.models.length / 6);
  const lexicalCoverage = clamp01(Math.log2(1 + input.vocabularySize) / 17);
  const importedPhraseMass = (input.importedUnits ?? []).filter(unit => unit.unitKind === "phrase").reduce((sum, unit) => sum + unit.alpha, 0);
  const phraseFluency = clamp01(Math.log2(1 + input.observedSymbolCount + importedPhraseMass) / 18 * Math.min(1, Math.max(maxOrder, 2) / 6));
  const generationReliability = clamp01(calibrated("language_memory.generation_lexical_coverage_weight") * lexicalCoverage + calibrated("language_memory.generation_phrase_fluency_weight") * phraseFluency + calibrated("language_memory.generation_model_coverage_weight") * modelCoverage);
  const patternCoverage = clamp01(Math.log2(1 + (input.importedPatterns?.length ?? 0)) / 10);
  const discoursePatternCoverage = clamp01(Math.log2(1 + (input.importedPatterns ?? []).filter(pattern => pattern.patternKind === "discourse" || pattern.patternKind === "narrative").length) / 8);
  const constructionCoverage = clamp01(Math.log2(1 + (input.importedConstructionBundles?.length ?? 0)) / 10);
  const semanticFrameCoverage = clamp01(Math.log2(1 + (input.importedSemanticFrames?.length ?? 0)) / 10);
  const discourseReliability = clamp01(calibrated("language_memory.discourse_reliability_generation_weight") * generationReliability + calibrated("language_memory.discourse_reliability_pattern_coverage_weight") * discoursePatternCoverage);
  return {
    scriptRecognition: clamp01(input.languageHints.length ? 0.45 + 0.1 * input.languageHints.length : modelCoverage * 0.3),
    segmentationQuality: clamp01(calibrated("language_memory.segmentation_model_coverage_weight") * modelCoverage + calibrated("language_memory.segmentation_lexical_coverage_weight") * lexicalCoverage),
    lexicalCoverage,
    phraseFluency,
    syntacticCoverage: clamp01((maxOrder >= 3 ? phraseFluency * 0.58 : phraseFluency * 0.28) + patternCoverage * 0.16 + constructionCoverage * 0.18 + discoursePatternCoverage * 0.08),
    semanticFrameCoverage,
    translationAlignment: 0,
    entailmentReliability: 0,
    generationReliability: discourseReliability,
    correctionStability: 0,
    localizationReliability: 0
  };
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}

function bestStructuralDeltaForSurface(
  state: LanguageMemoryRuntimeState,
  requestText: string,
  candidateText: string,
  context: LanguageStructuralDeltaMatchContext = {}
): { fit: number; ids: string[] } {
  const rows = (state.structuralDeltas ?? [])
    .slice(0, 256)
    .map(delta => ({ delta, fit: structuralDeltaRealizationFit(delta, requestText, candidateText, context) }))
    .filter(row => row.fit > 0)
    .sort((left, right) => right.fit - left.fit || left.delta.id.localeCompare(right.delta.id));
  return {
    fit: rows[0]?.fit ?? 0,
    ids: rows.slice(0, 4).map(row => row.delta.id)
  };
}



function semanticFactMaterialsFromFrames(frames: readonly LanguageGenerationFrame[]): SemanticFactMaterial[] {
  const out: SemanticFactMaterial[] = [];
  for (const frame of frames) {
    const constraints = jsonRecord(frame.realizationConstraints);
    const fact = jsonRecord(constraints.semanticAnswerFact);
    const subjectLabel = tidyInline(typeof fact.subject === "string" ? fact.subject : "");
    const predicateLabel = tidyInline(typeof fact.predicate === "string" ? fact.predicate : "");
    const objectLabel = tidyInline(typeof fact.object === "string" ? fact.object : "");
    if (!subjectLabel || !predicateLabel || !objectLabel) continue;
    const atomSupport = frame.propositionAtoms?.length ? mean(frame.propositionAtoms.map(atom => clamp01(atom.weight ?? 0.5))) : 0.5;
    const answer = jsonRecord(constraints.semanticAnswer);
    const alphaRhetoricalPlan = jsonRecord(answer.alphaRhetoricalPlan);
    out.push({
      id: `semantic_material:${hashText(`${subjectLabel}\u0001${predicateLabel}\u0001${objectLabel}\u0001${frame.id}`).slice(0, 24)}`,
      subjectLabel,
      predicateLabel,
      objectLabel,
      slotIds: jsonStringArray(answer.answerSlotIds),
      support: clamp01(0.68 + atomSupport * 0.28),
      forceClass: typeof fact.forceClass === "string" ? fact.forceClass : "",
      relationId: typeof fact.relationId === "string" ? fact.relationId : "",
      sourceNodeId: typeof fact.sourceNodeId === "string" ? fact.sourceNodeId : "",
      targetNodeId: typeof fact.targetNodeId === "string" ? fact.targetNodeId : "",
      frameId: frame.id,
      relevance: clamp01(typeof fact.support === "number" ? fact.support : atomSupport),
      preferredSubjectLabel: typeof answer.selectedSubject === "string" ? tidyInline(answer.selectedSubject) : undefined,
      upstreamRoleId: typeof fact.roleId === "string" ? fact.roleId : undefined,
      alphaRhetoricalCentrality: typeof fact.alphaRhetoricalCentrality === "number" ? clamp01(fact.alphaRhetoricalCentrality) : undefined,
      pathScore: typeof fact.pathScore === "number" ? clamp01(fact.pathScore) : undefined,
      roleScore: typeof fact.roleScore === "number" ? clamp01(fact.roleScore) : undefined,
      bridgeValue: typeof fact.bridgeValue === "number" ? clamp01(fact.bridgeValue) : undefined,
      backgroundPenalty: typeof fact.backgroundPenalty === "number" ? clamp01(fact.backgroundPenalty) : undefined,
      forceMeaning: typeof fact.forceMeaning === "number" ? clamp01(fact.forceMeaning) : undefined,
      certificationPower: typeof fact.certificationPower === "number" ? clamp01(fact.certificationPower) : undefined,
      alphaRhetoricalPlannerId: typeof alphaRhetoricalPlan.plannerId === "string" ? alphaRhetoricalPlan.plannerId : undefined,
      alphaRhetoricalTargetSentenceCount: typeof alphaRhetoricalPlan.targetSentenceCount === "number" ? alphaRhetoricalPlan.targetSentenceCount : undefined,
      cognitiveEdgeId: typeof fact.cognitiveEdgeId === "string" ? fact.cognitiveEdgeId : undefined,
      requestedSlotId: typeof fact.requestedSlotId === "string" ? fact.requestedSlotId : undefined,
      relationRoleId: typeof fact.relationRoleId === "string" ? fact.relationRoleId : undefined,
      graphQualityClassId: typeof fact.graphQualityClassId === "string" ? fact.graphQualityClassId : undefined,
      topicSenseId: typeof fact.topicSenseId === "string" ? fact.topicSenseId : undefined,
      finalQuestionFit: typeof fact.finalQuestionFit === "number" ? clamp01(fact.finalQuestionFit) : undefined,
      questionSlotId: typeof fact.questionSlotId === "string" ? fact.questionSlotId : undefined,
      questionSlotImportance: typeof fact.questionSlotImportance === "string" ? fact.questionSlotImportance : undefined,
      questionSlotScore: typeof fact.questionSlotScore === "number" ? clamp01(fact.questionSlotScore) : undefined,
      questionSlotReasonIds: jsonStringArray(fact.questionSlotReasonIds)
    });
  }
  const seen = new Map<string, SemanticFactMaterial>();
  for (const row of out) {
    const key = semanticMaterialKey(row);
    const near = [...seen.values()].find(existing => semanticMaterialOverlap(existing, row) > calibrated("language_memory.material_duplicate_overlap_floor"));
    if (near) {
      if (row.support > near.support) {
        near.id = row.id;
        near.subjectLabel = row.subjectLabel;
        near.predicateLabel = row.predicateLabel;
        near.objectLabel = row.objectLabel;
        near.slotIds = uniqueStrings([...near.slotIds, ...row.slotIds]);
        near.support = Math.max(near.support, row.support);
        near.forceClass = row.forceClass || near.forceClass;
        near.relationId = row.relationId || near.relationId;
        near.sourceNodeId = row.sourceNodeId || near.sourceNodeId;
        near.targetNodeId = row.targetNodeId || near.targetNodeId;
        near.upstreamRoleId = row.upstreamRoleId || near.upstreamRoleId;
        near.alphaRhetoricalCentrality = Math.max(near.alphaRhetoricalCentrality ?? 0, row.alphaRhetoricalCentrality ?? 0) || near.alphaRhetoricalCentrality;
        near.pathScore = Math.max(near.pathScore ?? 0, row.pathScore ?? 0) || near.pathScore;
        near.roleScore = Math.max(near.roleScore ?? 0, row.roleScore ?? 0) || near.roleScore;
        near.bridgeValue = Math.max(near.bridgeValue ?? 0, row.bridgeValue ?? 0) || near.bridgeValue;
        near.backgroundPenalty = Math.max(near.backgroundPenalty ?? 0, row.backgroundPenalty ?? 0) || near.backgroundPenalty;
        near.forceMeaning = Math.max(near.forceMeaning ?? 0, row.forceMeaning ?? 0) || near.forceMeaning;
        near.certificationPower = Math.max(near.certificationPower ?? 0, row.certificationPower ?? 0) || near.certificationPower;
        near.alphaRhetoricalPlannerId = row.alphaRhetoricalPlannerId || near.alphaRhetoricalPlannerId;
        near.alphaRhetoricalTargetSentenceCount = Math.max(near.alphaRhetoricalTargetSentenceCount ?? 0, row.alphaRhetoricalTargetSentenceCount ?? 0) || near.alphaRhetoricalTargetSentenceCount;
        near.cognitiveEdgeId = row.cognitiveEdgeId || near.cognitiveEdgeId;
        near.requestedSlotId = row.requestedSlotId || near.requestedSlotId;
        near.relationRoleId = row.relationRoleId || near.relationRoleId;
        near.graphQualityClassId = row.graphQualityClassId || near.graphQualityClassId;
        near.topicSenseId = row.topicSenseId || near.topicSenseId;
        near.finalQuestionFit = Math.max(near.finalQuestionFit ?? 0, row.finalQuestionFit ?? 0) || near.finalQuestionFit;
        near.questionSlotId = row.questionSlotId || near.questionSlotId;
        near.questionSlotImportance = strongerSlotImportance(row.questionSlotImportance, near.questionSlotImportance);
        near.questionSlotScore = Math.max(near.questionSlotScore ?? 0, row.questionSlotScore ?? 0) || near.questionSlotScore;
        near.questionSlotReasonIds = uniqueStrings([...(near.questionSlotReasonIds ?? []), ...(row.questionSlotReasonIds ?? [])]);
      }
      continue;
    }
    const existing = seen.get(key);
    if (!existing || row.support > existing.support) seen.set(key, row);
  }
  return [...seen.values()]
    .sort((a, b) => b.support - a.support || b.relevance - a.relevance || a.subjectLabel.localeCompare(b.subjectLabel))
    .slice(0, 24);
}



function jsonStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}



function semanticMaterialKey(material: SemanticFactMaterial): string {
  return [material.sourceNodeId || material.subjectLabel, material.relationId || material.predicateLabel, material.targetNodeId || material.objectLabel]
    .map(normalizeSurfaceKey)
    .join("\u0001");
}



function normalizeSurfaceKey(value: string): string {
  return tidyInline(value).normalize("NFKC").toLocaleLowerCase();
}



function semanticMaterialOverlap(a: SemanticFactMaterial, b: SemanticFactMaterial): number {
  return semanticSurfaceOverlap(`${a.subjectLabel} ${a.predicateLabel} ${a.objectLabel}`, `${b.subjectLabel} ${b.predicateLabel} ${b.objectLabel}`);
}



function semanticSurfaceOverlap(a: string, b: string): number {
  return weightedJaccard(featureSet(a, 128), featureSet(b, 128));
}



function strongerSlotImportance(left: string | undefined, right: string | undefined): string | undefined {
  if (!left) return right;
  if (!right) return left;
  return slotImportanceRank(left) <= slotImportanceRank(right) ? left : right;
}



function slotImportanceRank(value: string): number {
  if (value === "core") return 0;
  if (value === "secondary") return 1;
  if (value === "context") return 2;
  if (value === "rejected") return 3;
  return 4;
}



function semanticRhetoricalPlanFromMaterials(materials: readonly SemanticFactMaterial[], contextText: string, discoursePrior?: RuntimeDiscoursePriorProfile): RhetoricalPlan | undefined {
  const ordered = materials.filter(material => !materialRejectedByQuestionSlot(material)).sort((a, b) => b.support - a.support || b.relevance - a.relevance || a.subjectLabel.localeCompare(b.subjectLabel)).slice(0, 16);
  if (!ordered.length) return undefined;
  const subjectLabel = primarySemanticSubject(ordered);
  const assignments = answerRoleAssignmentsFromMaterials(ordered, subjectLabel, contextText);
  const stageSpecs: Array<{ roleId: string; priority: number; surfaceWeight: number }> = [
    { roleId: ANSWER_ROLE_IDS.identity, priority: 0.98, surfaceWeight: 0.92 },
    { roleId: ANSWER_ROLE_IDS.contribution, priority: 0.96, surfaceWeight: 0.96 },
    { roleId: ANSWER_ROLE_IDS.significance, priority: 0.78, surfaceWeight: 0.82 },
    { roleId: ANSWER_ROLE_IDS.context, priority: 0.72, surfaceWeight: 0.72 },
    { roleId: ANSWER_ROLE_IDS.field, priority: 0.62, surfaceWeight: 0.6 },
    { roleId: ANSWER_ROLE_IDS.backgroundActor, priority: 0.34, surfaceWeight: 0.22 },
    { roleId: ANSWER_ROLE_IDS.backgroundRelation, priority: 0.3, surfaceWeight: 0.18 }
  ];
  const stages = stageSpecs
    .map(spec => {
      const rows = assignments.filter(assignment => assignment.roleId === spec.roleId && assignment.shouldSurface);
      return rows.length ? {
        id: `rhetorical.stage:${hashText(`${spec.roleId}:${rows.map(row => row.id).join(":")}`).slice(0, 16)}`,
        roleId: spec.roleId,
        assignmentIds: rows.map(row => row.id),
        priority: spec.priority,
        surfaceWeight: spec.surfaceWeight
      } : undefined;
    })
    .filter((stage): stage is RhetoricalPlanStage => Boolean(stage));
  const bridgeIds = assignments
    .filter(assignment => isBridgeAnswerRoleId(assignment.roleId))
    .map(assignment => assignment.id);
  const backgroundIds = assignments
    .filter(assignment => isBackgroundAnswerRoleId(assignment.roleId))
    .map(assignment => assignment.id);
  return {
    id: `rhetorical.plan:${hashText(`${subjectLabel}:${assignments.map(row => `${row.materialId}:${row.roleId}`).join("|")}`).slice(0, 18)}`,
    subjectLabel,
    assignments,
    stages,
    backgroundAssignmentIds: backgroundIds,
    significanceBridgeAssignmentIds: bridgeIds,
    targetMoveCount: rhetoricalTargetMoveCount(ordered, stages, discoursePrior),
    certificationBoundaryId: assignments.some(assignment => assignment.roleId === ANSWER_ROLE_IDS.boundary) ? ANSWER_ROLE_IDS.boundary : undefined
  };
}



function materialRejectedByQuestionSlot(material: SemanticFactMaterial): boolean {
  return material.questionSlotImportance === "rejected";
}



function primarySemanticSubject(materials: readonly SemanticFactMaterial[]): string {
  const preferred = materials
    .map(material => material.preferredSubjectLabel)
    .find((label): label is string => Boolean(label));
  if (preferred) return preferred;
  const scores = new Map<string, { label: string; score: number }>();
  for (const material of materials) {
    const key = normalizeSurfaceKey(material.subjectLabel);
    const previous = scores.get(key);
    const score = (previous?.score ?? 0) + material.support + material.relevance * 0.35;
    scores.set(key, { label: previous?.label ?? material.subjectLabel, score });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))[0]?.label ?? materials[0]?.subjectLabel ?? "";
}



function answerRoleAssignmentsFromMaterials(materials: readonly SemanticFactMaterial[], subjectLabel: string, contextText: string): AnswerRoleAssignment[] {
  const primaryRows = materials.filter(material => sameSurface(material.subjectLabel, subjectLabel) || sameSurface(material.objectLabel, subjectLabel));
  const primaryObjectKeys = new Set(primaryRows.map(material => normalizeSurfaceKey(material.objectLabel)).filter(Boolean));
  const hasContribution = primaryRows.some(material => semanticRelationSurfaceMass(material) > 1 || semanticQuestionFit(material, contextText) > calibrated("language_memory.material_contribution_question_fit_floor"));
  return materials.map(material => {
    const subjectMatch = sameSurface(material.subjectLabel, subjectLabel);
    const objectMatch = sameSurface(material.objectLabel, subjectLabel);
    const subjectIsContext = primaryObjectKeys.has(normalizeSurfaceKey(material.subjectLabel));
    const objectIsContext = primaryObjectKeys.has(normalizeSurfaceKey(material.objectLabel));
    const questionShapeFit = material.finalQuestionFit ?? semanticQuestionFit(material, contextText);
    const relationUsefulness = clamp01(calibrated("language_memory.relation_support_weight") * material.support + calibrated("language_memory.relation_relevance_weight") * material.relevance + calibrated("language_memory.relation_question_shape_fit_weight") * questionShapeFit);
    let roleId = rhetoricalRoleFromQuestionSlot(material.questionSlotId, material.questionSlotImportance) || material.upstreamRoleId || rhetoricalRoleFromRelationRole(material.relationRoleId) || ANSWER_ROLE_IDS.field;
    const slotLocked = Boolean(material.questionSlotId);
    if (!material.upstreamRoleId && !slotLocked) {
      if (subjectMatch || objectMatch) {
        roleId = semanticRelationSurfaceMass(material) <= 3 && semanticSurfaceSymbolMass(material.objectLabel) <= 4 ? ANSWER_ROLE_IDS.identity : ANSWER_ROLE_IDS.contribution;
      } else if (subjectIsContext) {
        roleId = ANSWER_ROLE_IDS.context;
      } else if (objectIsContext) {
        roleId = hasContribution ? ANSWER_ROLE_IDS.backgroundActor : ANSWER_ROLE_IDS.backgroundRelation;
      }
    }
    const background = isBackgroundAnswerRoleId(roleId);
    const secondarySlot = material.questionSlotImportance === "secondary" || material.questionSlotImportance === "context";
    const rejectedSlot = materialRejectedByQuestionSlot(material);
    const shouldSurface = !rejectedSlot && (!background || (!hasContribution && relationUsefulness > calibrated("language_memory.background_relation_usefulness_floor") && !material.upstreamRoleId && !secondarySlot));
    const centrality = material.alphaRhetoricalCentrality ?? relationUsefulness;
    const slotBoost = material.questionSlotImportance === "core" ? 0.18 : material.questionSlotImportance === "secondary" ? -0.05 : material.questionSlotImportance === "context" ? -0.08 : 0;
    const priority = rhetoricalRolePriority(roleId) + centrality * 0.28 + relationUsefulness * 0.14 + (subjectMatch ? 0.18 : 0) + slotBoost - (material.backgroundPenalty ?? 0) * 0.16;
    return {
      id: `answer.role:${hashText(`${material.id}:${roleId}:${subjectLabel}`).slice(0, 18)}`,
      materialId: material.id,
      subjectRef: material.sourceNodeId || material.subjectLabel,
      relationRef: material.relationId || material.predicateLabel,
      objectRef: material.targetNodeId || material.objectLabel,
      roleId,
      priority: clamp01(priority),
      support: material.support,
      relationUsefulness: material.roleScore ?? relationUsefulness,
      questionShapeFit,
      requestedSlotId: material.requestedSlotId,
      relationRoleId: material.relationRoleId,
      topicSenseId: material.topicSenseId,
      questionSlotId: material.questionSlotId,
      questionSlotImportance: material.questionSlotImportance,
      shouldSurface,
      surfaceWeight: clamp01((shouldSurface ? 0.54 : 0.14) + rhetoricalRolePriority(roleId) * 0.28 + material.support * 0.1 + centrality * 0.22 + slotBoost * 0.6 - (material.backgroundPenalty ?? 0) * 0.2)
    };
  }).sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}



function sameSurface(a: string, b: string): boolean {
  return normalizeSurfaceKey(a) === normalizeSurfaceKey(b);
}



function semanticRelationSurfaceMass(material: SemanticFactMaterial): number {
  return symbolizeData(`${material.predicateLabel} ${material.objectLabel}`).filter(symbol => symbol.trim()).length;
}



function semanticQuestionFit(material: SemanticFactMaterial, contextText: string): number {
  const context = featureSet(contextText, 128);
  if (!context.length) return 0;
  return weightedJaccard(context, featureSet(`${material.subjectLabel} ${material.predicateLabel} ${material.objectLabel}`, 128));
}



function rhetoricalRoleFromQuestionSlot(slotId: string | undefined, importance: string | undefined): string | undefined {
  if (!slotId) return undefined;
  if (importance === "secondary") {
    if (slotId === ANSWER_SLOT_IDS.context) return ANSWER_ROLE_IDS.context;
    if (slotId === ANSWER_SLOT_IDS.significance) return ANSWER_ROLE_IDS.significance;
    return ANSWER_ROLE_IDS.backgroundRelation;
  }
  if (importance === "context") return ANSWER_ROLE_IDS.context;
  if (slotId === ANSWER_SLOT_IDS.roleOrField || slotId === ANSWER_SLOT_IDS.sensePrimary || slotId === ANSWER_SLOT_IDS.selectedSense) return ANSWER_ROLE_IDS.identity;
  if (slotId === ANSWER_SLOT_IDS.contribution || slotId === ANSWER_SLOT_IDS.knownForContribution || slotId === ANSWER_SLOT_IDS.memberRelation || slotId === ANSWER_SLOT_IDS.effectRelation) return ANSWER_ROLE_IDS.contribution;
  if (slotId === ANSWER_SLOT_IDS.significance) return ANSWER_ROLE_IDS.significance;
  if (slotId === ANSWER_SLOT_IDS.context || slotId === ANSWER_SLOT_IDS.sourceConcept || slotId === ANSWER_SLOT_IDS.targetConcept) return ANSWER_ROLE_IDS.context;
  return undefined;
}



function rhetoricalRoleFromRelationRole(value: string | undefined): string | undefined {
  if (value === RELATION_ROLE_IDS.roleClass || value === RELATION_ROLE_IDS.definitionClass) return ANSWER_ROLE_IDS.identity;
  if (value === RELATION_ROLE_IDS.contribution || value === RELATION_ROLE_IDS.knownFor || value === RELATION_ROLE_IDS.characterCast) return ANSWER_ROLE_IDS.contribution;
  if (value === RELATION_ROLE_IDS.effect) return ANSWER_ROLE_IDS.significance;
  if (value === RELATION_ROLE_IDS.domain) return ANSWER_ROLE_IDS.field;
  if (value === RELATION_ROLE_IDS.metadata) return ANSWER_ROLE_IDS.backgroundRelation;
  if (value === RELATION_ROLE_IDS.graphRequestRelation || value === RELATION_ROLE_IDS.graphRequestMembership || value === RELATION_ROLE_IDS.graphExplanatoryPath) return ANSWER_ROLE_IDS.contribution;
  if (value === RELATION_ROLE_IDS.graphCompactAttribute) return ANSWER_ROLE_IDS.field;
  if (value === RELATION_ROLE_IDS.graphCompoundAttribute || value === RELATION_ROLE_IDS.graphCompoundMembership || value === RELATION_ROLE_IDS.graphContextRelation) return ANSWER_ROLE_IDS.context;
  if (value === RELATION_ROLE_IDS.graphNavigation) return ANSWER_ROLE_IDS.backgroundRelation;
  return undefined;
}



function semanticSurfaceSymbolMass(value: string): number {
  return symbolizeData(value).filter(symbol => symbol.trim()).length;
}



function rhetoricalRolePriority(roleId: string): number {
  if (roleId === ANSWER_ROLE_IDS.identity) return 0.92;
  if (roleId === ANSWER_ROLE_IDS.contribution) return 0.9;
  if (roleId === ANSWER_ROLE_IDS.significance) return 0.74;
  if (roleId === ANSWER_ROLE_IDS.context) return 0.62;
  if (roleId === ANSWER_ROLE_IDS.field) return 0.5;
  if (roleId === ANSWER_ROLE_IDS.backgroundActor) return 0.18;
  if (roleId === ANSWER_ROLE_IDS.backgroundRelation) return 0.14;
  if (roleId === ANSWER_ROLE_IDS.boundary) return 0.08;
  return 0.24;
}



function rhetoricalTargetMoveCount(materials: readonly SemanticFactMaterial[], stages: readonly RhetoricalPlanStage[], discoursePrior?: RuntimeDiscoursePriorProfile): number {
  const upstreamTarget = Math.max(0, ...materials.map(material => material.alphaRhetoricalTargetSentenceCount ?? 0));
  const surfacedStageCount = stages.filter(stage => stage.surfaceWeight >= 0.6).length;
  const bridgeStageCount = stages.filter(stage => isBridgeAnswerRoleId(stage.roleId)).length;
  const learnedTarget = discoursePrior?.targetMoveCount ?? 0;
  const raw = Math.max(upstreamTarget, learnedTarget, 1 + surfacedStageCount + Math.min(1, bridgeStageCount));
  return Math.max(2, Math.min(12, Math.round(raw)));
}



function runtimeDiscoursePriorProfile(
  state: LanguageMemoryRuntimeState,
  generationExtent = 0
): RuntimeDiscoursePriorProfile | undefined {
  const patterns = state.importedPatterns
    .filter(pattern => pattern.patternKind === "discourse" || pattern.patternKind === "narrative")
    .slice(0, 512);
  if (!patterns.length) return undefined;
  const patternIds: string[] = [];
  const sentenceCounts: number[] = [];
  const paragraphCounts: number[] = [];
  const sentenceLengths: number[] = [];
  const paragraphLengths: number[] = [];
  const dialogueRates: number[] = [];
  let dialogueTurnMass = 0;
  let support = 0;
  for (const pattern of patterns) {
    const record = jsonRecord(pattern.patternJson);
    const schema = typeof record.schema === "string" ? record.schema : "";
    if (schema !== "scce.long_form_discourse_pattern.v1"
      && schema !== "scce.narrative_surface_pattern.v1") continue;
    patternIds.push(pattern.id);
    support += pattern.support;
    if (schema === "scce.long_form_discourse_pattern.v1") {
      sentenceCounts.push(numberOf(record.sentenceCount));
      paragraphCounts.push(numberOf(record.paragraphCount));
      sentenceLengths.push(...numberArrayFromJson(record.sentenceSymbolLengths).slice(0, 512));
      paragraphLengths.push(...numberArrayFromJson(record.paragraphSymbolLengths).slice(0, 256));
      dialogueTurnMass += topEntryMass(record.dialogueTurnMarkers);
    } else {
      paragraphCounts.push(Math.max(0, topEntryMass(record.paragraphShapeTransitions)));
      dialogueRates.push(numberOf(record.dialogueTurnRate));
    }
  }
  if (!patternIds.length) return undefined;
  const sentenceCount = boundedMax(sentenceCounts, 0, 24);
  const paragraphCount = boundedMax(paragraphCounts, 0, 12);
  const sentenceSymbolP75 = percentile(sentenceLengths, 0.75);
  const paragraphSymbolP50 = percentile(paragraphLengths, 0.5);
  const dialogueTurnRate = boundedMax(dialogueRates, 0, 8) + dialogueTurnMass / Math.max(1, patternIds.length * 12);
  const targetSymbolCount = Math.max(
    generationExtent,
    paragraphCount > 1 && paragraphSymbolP50 > 0 ? paragraphCount * paragraphSymbolP50 : 0,
    sentenceCount > 2 && sentenceSymbolP75 > 0 ? sentenceCount * sentenceSymbolP75 : 0,
    paragraphCount > 1 ? paragraphCount * 32 : 0,
    sentenceCount > 2 ? sentenceCount * 12 : 0
  );
  const targetMoveCount = Math.max(
    0,
    Math.min(12, Math.round(Math.max(
      paragraphCount > 1 ? paragraphCount * 1.5 : 0,
      sentenceCount > 2 ? sentenceCount / 2 : 0,
      dialogueTurnRate > 0 ? 4 + dialogueTurnRate : 0
    )))
  );
  return {
    patternIds: uniqueStrings(patternIds).slice(0, 32),
    targetMoveCount,
    targetSymbolCount: Math.max(0, Math.min(256, Math.ceil(targetSymbolCount))),
    paragraphCount,
    sentenceCount,
    sentenceSymbolP75,
    paragraphSymbolP50,
    dialogueTurnRate,
    support: clamp01(support / Math.max(1, patternIds.length))
  };
}



function numberArrayFromJson(value: JsonValue | undefined): number[] {
  return Array.isArray(value)
    ? value.filter((item): item is number => typeof item === "number" && Number.isFinite(item))
    : [];
}



function topEntryMass(value: JsonValue | undefined): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce<number>((sum, entry) => {
    if (!Array.isArray(entry) || entry.length < 2) return sum;
    const count = entry[1];
    return sum + (typeof count === "number" && Number.isFinite(count) && count > 0 ? count : 0);
  }, 0);
}



function boundedMax(values: readonly number[], min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.max(min, ...values.filter(value => Number.isFinite(value)))));
}



function percentile(values: readonly number[], q: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.floor(clamp01(q) * (sorted.length - 1))));
  return sorted[index] ?? 0;
}



function discoursePriorAudit(prior: RuntimeDiscoursePriorProfile): JsonValue {
  return toJsonValue({
    patternIds: prior.patternIds.slice(0, 16),
    targetMoveCount: prior.targetMoveCount,
    targetSymbolCount: prior.targetSymbolCount,
    paragraphCount: prior.paragraphCount,
    sentenceCount: prior.sentenceCount,
    sentenceSymbolP75: prior.sentenceSymbolP75,
    paragraphSymbolP50: prior.paragraphSymbolP50,
    dialogueTurnRate: prior.dialogueTurnRate,
    support: prior.support
  });
}
