import type { IdFactory } from "./ids.js";
import type { KneserNeyModel } from "./kneser-ney.js";
import { continueBoundedProse, kneserNeyProbability, predictKneserNey } from "./kneser-ney.js";
import { createNgramMemoryCompiler, type NgramMemoryCompilation } from "./ngram-memory.js";
import { buildLanguageProfileClusters, type LanguageProfileCluster } from "./language.js";
import { clamp01, featureSet, mean, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";
import type { EvidenceSpan, Hasher, JsonValue, LanguageCompetenceVector, LanguageProfile, SourceVersionId } from "./types.js";
import type { LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation, SemanticFrameRecord } from "./storage.js";
import {
  hydrateLanguageConstructionPatterns,
  isLanguageConstructionPattern,
  type DurableLanguageConstructionBundle,
  type LanguageConstructionMemoryIssue
} from "./language-construction-memory.js";
import { ensureSurfaceSentence as ensureUnicodeSurfaceSentence, isSentenceBoundarySymbol as isUnicodeSentenceBoundarySymbol, stripTerminalSentenceBoundary } from "./surface-linguistics.js";
import {
  ANSWER_ROLE_IDS,
  ANSWER_SLOT_IDS,
  GRAPH_QUALITY_CLASS_IDS,
  RELATION_ROLE_IDS,
  isBackgroundAnswerRoleId,
  isBridgeAnswerRoleId
} from "./question-routing-ids.js";

export interface LanguageMemoryRuntimeState {
  models: KneserNeyModel[];
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
  importedConstructionBundles: DurableLanguageConstructionBundle[];
  rejectedConstructionPatterns: LanguageConstructionMemoryIssue[];
  importedLanguagePriorCount: number;
  competenceVector: LanguageCompetenceVector;
  scope: LanguageMemoryRuntimeScope;
  audit: JsonValue;
}

export interface LanguageMemoryRuntimeScope {
  mode: "unscoped" | "cluster";
  clusterId?: string;
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
  evidenceIds: string[];
  score: LanguageMemoryScore;
  continuation?: {
    text: string;
    stoppedBy: string;
    averageLogProbability: number;
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
  id: string;
  pointId?: string;
  role?: string;
  force?: string;
  propositionAtoms?: readonly LanguageGenerationAtom[];
  requiredTerms?: readonly LanguageGenerationTerm[];
  semanticFrameIds?: readonly string[];
  realizationConstraints?: JsonValue;
  targetLanguage?: string;
  targetScript?: string;
  styleProfileId?: string;
  registerVector?: readonly number[];
  detailProfileId?: string;
  ordering?: LanguageGenerationOrdering;
}

export interface LanguageGenerationInput {
  state: LanguageMemoryRuntimeState;
  targetLanguageProfile?: LanguageProfile;
  contextSymbols?: readonly string[];
  requiredTerms?: readonly LanguageGenerationTerm[];
  semanticFrameIds?: readonly string[];
  frames?: readonly LanguageGenerationFrame[];
  generationExtent?: number;
  styleProfileId?: string;
  registerVector?: readonly number[];
  detailProfileId?: string;
  stop?: {
    maxInformation?: number;
    stopSymbols?: readonly string[];
  };
}

export interface LanguageGenerationResult {
  text: string;
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
  hydrate(input: { models: readonly NgramModelRecord[]; observations?: readonly NgramObservation[]; units?: readonly LanguageUnitRecord[]; patterns?: readonly LanguagePatternRecord[]; semanticFrames?: readonly SemanticFrameRecord[]; constructionEvidence?: readonly EvidenceSpan[]; importRunId?: string }): LanguageMemoryRuntimeState;
  hydrateFromImportedBrain(input: { importRunId?: string; models: readonly NgramModelRecord[]; observations: readonly NgramObservation[]; units: readonly LanguageUnitRecord[]; patterns: readonly LanguagePatternRecord[]; semanticFrames?: readonly SemanticFrameRecord[]; constructionEvidence?: readonly EvidenceSpan[] }): LanguageMemoryRuntimeState;
  profile(input: { state: LanguageMemoryRuntimeState }): JsonValue;
  observe(input: {
    streamId: string;
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
    profile: LanguageProfile;
    sourceVersionId: SourceVersionId;
    text: string;
    evidence: EvidenceSpan[];
    createdAt: number;
    maxOrder?: number;
    maxCountersPerOrder?: number;
    vocabularyLimit?: number;
  }): NgramMemoryCompilation;
  score(input: { state: LanguageMemoryRuntimeState; text: string; contextText?: string }): LanguageMemoryScore;
  suggest(input: { state: LanguageMemoryRuntimeState; context: string | readonly string[]; limit?: number }): LanguageMemorySuggestion[];
  generate(input: LanguageGenerationInput): LanguageGenerationResult;
  realize(input: {
    state: LanguageMemoryRuntimeState;
    requestText: string;
    candidates: Array<{ text: string; evidenceIds?: string[]; fit?: number }>;
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
      const models = selectRuntimeModels(records, reconstructed);
      const streamIds = uniqueStrings([...records.map(record => record.streamId), ...importedObservations.map(item => item.streamId)]).sort(compareCodePoint);
      const languageHints = uniqueStrings([...records.map(record => record.languageHint), ...importedObservations.map(item => item.languageHint)]).sort(compareCodePoint);
      const observedSymbolCount = models.reduce((sum, model) => sum + model.observedSymbolCount, 0);
      const importedUnits = [...(input.units ?? [])].sort((a, b) => b.alpha - a.alpha || compareCodePoint(a.text, b.text) || compareCodePoint(a.id, b.id)).slice(0, 4096);
      const persistedPatterns = [...(input.patterns ?? [])].sort((a, b) => b.support - a.support || compareCodePoint(a.patternKind, b.patternKind) || compareCodePoint(a.id, b.id)).slice(0, 1024);
      const importedPatterns = persistedPatterns.filter(pattern => !isLanguageConstructionPattern(pattern));
      const importedSemanticFrames = [...(input.semanticFrames ?? [])].sort((a, b) => b.alpha - a.alpha || compareCodePoint(a.id, b.id)).slice(0, 2048);
      const constructionMemory = hydrateLanguageConstructionPatterns({
        patterns: persistedPatterns,
        evidence: input.constructionEvidence ?? [],
        hasher: options.hasher
      });
      const vocabularySize = uniqueVocabularySize(models) + uniqueUnitVocabularySize(importedUnits);
      const importedLanguagePriorCount = importedUnits.length + importedPatterns.length + importedObservations.length + importedSemanticFrames.length + constructionMemory.bundles.length + input.models.filter(isImportedLanguagePriorModel).length;
      const competenceVector = competenceFromRuntime({ models, observedSymbolCount, vocabularySize, languageHints, importedUnits, importedPatterns, importedObservations, importedSemanticFrames, importedConstructionBundles: constructionMemory.bundles });
      return {
        models,
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
        importedConstructionBundles: constructionMemory.bundles,
        rejectedConstructionPatterns: constructionMemory.rejected,
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
          rejectedConstructionPatterns: constructionMemory.rejected,
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
        importedConstructionBundles: input.state.importedConstructionBundles.slice(0, 24).map(bundle => ({
          id: bundle.id,
          bindingId: bundle.bindingId,
          sourceProfileId: bundle.sourceProfileId,
          targetProfileId: bundle.targetProfileId,
          sourceVersionIds: bundle.sourceVersionIds,
          evidenceIds: bundle.evidenceIds
        })),
        rejectedConstructionPatterns: input.state.rejectedConstructionPatterns.slice(0, 24),
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
      return generateFromLanguageMemory(input);
    },

    realize(input) {
      const ranked = input.candidates
        .map(candidate => {
          const score = scoreText(input.state, candidate.text, input.requestText);
          const requestFit = weightedJaccard(featureSet(input.requestText, 256), featureSet(candidate.text, 256));
          const total = clamp01(0.46 * score.activation + 0.34 * requestFit + 0.2 * (candidate.fit ?? score.fit));
          return { candidate, score, total };
        })
        .sort((a, b) => b.total - a.total || a.candidate.text.localeCompare(b.candidate.text));
      const best = ranked[0];
      const continuationModel = input.state.models.find(model => model.order >= 3) ?? input.state.models[0];
      const continuation = continuationModel && input.continuationPrompt
        ? continueBoundedProse(continuationModel, input.continuationPrompt, { generationExtent: 32, probabilityFloor: 1e-8, temperature: 0.82 })
        : undefined;
      return {
        text: best?.candidate.text ?? "",
        evidenceIds: best?.candidate.evidenceIds ?? [],
        score: best?.score ?? scoreText(input.state, "", input.requestText),
        continuation: continuation ? { text: continuation.text, stoppedBy: continuation.stoppedBy, averageLogProbability: continuation.averageLogProbability } : undefined,
        audit: toJsonValue({
          source: "language-memory-runtime.realize",
          candidates: ranked.slice(0, 12).map(row => ({ textHash: hashText(row.candidate.text), total: row.total, activation: row.score.activation, information: row.score.information })),
          selectedScoreAudit: best?.score.audit ?? null,
          importedNgramModelIdsUsed: importedIdsFromScore(best?.score.audit, "importedNgramModelIdsUsed"),
          importedObservationIdsUsed: importedIdsFromScore(best?.score.audit, "importedObservationIdsUsed"),
          importedLanguageUnitIdsUsed: importedIdsFromScore(best?.score.audit, "importedLanguageUnitIdsUsed"),
          importedPhrasePatternIdsUsed: importedIdsFromScore(best?.score.audit, "importedPhrasePatternIdsUsed"),
          importedSemanticFrameIdsUsed: importedIdsFromScore(best?.score.audit, "importedSemanticFrameIdsUsed"),
          continuation: continuation ? { stoppedBy: continuation.stoppedBy, symbols: continuation.symbols.length, averageLogProbability: continuation.averageLogProbability } : null
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
  source: "required_term" | "proposition_atom" | "semantic_rhetoric" | "language_unit" | "phrase_pattern" | "semantic_frame" | "observation" | "suggestion";
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

function generateFromLanguageMemory(input: LanguageGenerationInput): LanguageGenerationResult {
  const generationExtent = Math.max(1, Math.min(256, Math.floor(input.generationExtent ?? 64)));
  const requiredTerms = generationRequiredTerms(input);
  const frameAtoms = generationFrameAtoms(input);
  const contextSymbols = [...(input.contextSymbols ?? []), ...requiredTerms.map(term => term.text), ...frameAtoms.map(atom => atom.text)]
    .map(symbol => tidyInline(symbol))
    .filter(Boolean)
    .slice(-128);
  const contextText = contextSymbols.join(" ");
  const pieces = generationPieces(input, requiredTerms, frameAtoms, contextSymbols, contextText);
  const candidatePieces = selectGenerationPieces(pieces, requiredTerms, generationExtent);
  const latticeGeneration = generateRhetoricalSentenceLattice({
    state: input.state,
    pieces: candidatePieces,
    requiredTerms,
    frameAtoms,
    frames: input.frames ?? [],
    contextSymbols,
    contextText,
    generationExtent,
    styleProfileId: input.styleProfileId
  });
  const firstDiscourse = latticeGeneration?.discourse ?? weaveDiscourse({ state: input.state, pieces: candidatePieces, requiredTerms, frameAtoms, frames: input.frames ?? [], contextSymbols, generationExtent });
  const discourse = speechBearingSurface(firstDiscourse.text)
    ? firstDiscourse
    : learnedContinuationDiscourse({ state: input.state, contextSymbols, contextText, requiredTerms, frameAtoms, generationExtent, pieces: candidatePieces }) ?? firstDiscourse;
  const selectedMovePieceIds = new Set(discourse.moves.flatMap(move => move.sourcePieceIds));
  const selected = candidatePieces.filter(piece => {
    const clean = tidyInline(piece.text);
    return (piece.id && selectedMovePieceIds.has(piece.id)) || discourse.moves.some(move => containsLoose(move.text, clean) || containsLoose(clean, move.text));
  });
  const text = discourse.text;
  const symbols = symbolizeData(text);
  const score = scoreText(input.state, text, contextText);
  const orderUsage = score.orderScores.map(row => ({
    order: row.order,
    symbols: symbols.length,
    averageInformation: row.information,
    activation: row.activation
  }));
  const importedFromScore = {
    modelIds: importedIdsFromScore(score.audit, "importedNgramModelIdsUsed"),
    observationIds: importedIdsFromScore(score.audit, "importedObservationIdsUsed"),
    unitIds: importedIdsFromScore(score.audit, "importedLanguageUnitIdsUsed"),
    patternIds: importedIdsFromScore(score.audit, "importedPhrasePatternIdsUsed"),
    semanticFrameIds: importedIdsFromScore(score.audit, "importedSemanticFrameIdsUsed")
  };
  const importedNgramModelIdsUsed = uniqueStrings([...importedFromScore.modelIds, ...importedNgramModelIdsForOrders(input.state, score.orderScores)]);
  const importedObservationIdsUsed = uniqueStrings([...importedFromScore.observationIds, ...selected.filter(piece => piece.source === "observation" && piece.id).map(piece => piece.id!)]);
  const importedLanguageUnitIdsUsed = uniqueStrings([...importedFromScore.unitIds, ...selected.filter(piece => piece.source === "language_unit" && piece.id).map(piece => piece.id!)]);
  const importedPhrasePatternIdsUsed = uniqueStrings([...importedFromScore.patternIds, ...selected.filter(piece => piece.source === "phrase_pattern" && piece.id).map(piece => piece.id!)]);
  const selectedText = joinTextForAudit(selected.map(piece => piece.text));
  const importedSemanticFrameIdsUsed = uniqueStrings([
    ...importedFromScore.semanticFrameIds,
    ...selected.filter(piece => piece.source === "semantic_frame" && piece.id).map(piece => piece.id!),
    ...semanticFrameIdsOverlappingSelectedText(input.state, selectedText)
  ]);
  const semanticMaterials = semanticFactMaterialsFromFrames(input.frames ?? []);
  const selectedSemanticPieces = selected.filter(piece => piece.source === "semantic_rhetoric");
  const semanticMaterialIdsUsed = uniqueStrings(selectedSemanticPieces.flatMap(piece => piece.semanticMaterialIds ?? []));
  const semanticRhetoricalPlan = semanticRhetoricalPlanFromMaterials(semanticMaterials, contextText);
  const semanticFactMaterialsUsed = semanticMaterials
    .filter(material => semanticMaterialIdsUsed.includes(material.id))
    .map(material => ({
      id: material.id,
      frameId: material.frameId,
      relationId: material.relationId,
      sourceNodeId: material.sourceNodeId,
      targetNodeId: material.targetNodeId,
      forceClass: material.forceClass,
      slotIds: material.slotIds,
      support: material.support,
      upstreamRoleId: material.upstreamRoleId ?? null,
      alphaRhetoricalCentrality: material.alphaRhetoricalCentrality ?? null,
      pathScore: material.pathScore ?? null,
      roleScore: material.roleScore ?? null,
      bridgeValue: material.bridgeValue ?? null,
      backgroundPenalty: material.backgroundPenalty ?? null,
      forceMeaning: material.forceMeaning ?? null,
      certificationPower: material.certificationPower ?? null,
      alphaRhetoricalPlannerId: material.alphaRhetoricalPlannerId ?? null,
      cognitiveEdgeId: material.cognitiveEdgeId ?? null,
      requestedSlotId: material.requestedSlotId ?? null,
      relationRoleId: material.relationRoleId ?? null,
      topicSenseId: material.topicSenseId ?? null,
      finalQuestionFit: material.finalQuestionFit ?? null,
      questionSlotId: material.questionSlotId ?? null,
      questionSlotImportance: material.questionSlotImportance ?? null,
      questionSlotScore: material.questionSlotScore ?? null,
      questionSlotReasonIds: material.questionSlotReasonIds ?? []
    }));
  const answerSlotsFilled = uniqueStrings(selectedSemanticPieces.flatMap(piece => piece.answerSlotIds ?? []));
  const demotedFacts = uniqueStrings(selectedSemanticPieces.flatMap(piece => piece.demotedMaterialIds ?? []));
  const roleAssignmentIdsUsed = uniqueStrings(selectedSemanticPieces.flatMap(piece => piece.roleAssignmentIds ?? []));
  const languagePriorsUsed = uniqueStrings(selected
    .filter(piece => piece.source === "language_unit" || piece.source === "phrase_pattern" || piece.source === "semantic_frame" || piece.source === "observation" || piece.source === "suggestion")
    .map(piece => piece.id ?? piece.source));
  const compressionApplied = selectedSemanticPieces.some(piece => Boolean(piece.compressionApplied));
  const discourseShapeId = selectedSemanticPieces.find(piece => piece.discourseShapeId)?.discourseShapeId ?? semanticRhetoricalPlan?.id;
  const stoppedBy: LanguageGenerationResult["stoppedBy"] = text ? (symbols.length >= generationExtent ? "generation_extent" : "source_exhausted") : "empty";
  const averageInformation = orderUsage.length ? mean(orderUsage.map(row => row.averageInformation)) : 0;
  const importedUseMass = importedLanguageUnitIdsUsed.length + importedPhrasePatternIdsUsed.length + importedObservationIdsUsed.length + importedSemanticFrameIdsUsed.length + importedNgramModelIdsUsed.length;
  const confidence = clamp01(0.42 * score.activation + 0.28 * input.state.competenceVector.generationReliability + 0.18 * Math.min(1, selected.length / 5) + 0.12 * Math.min(1, importedUseMass / 4));
  return {
    text,
    symbols,
    phrasesUsed: selected.map(piece => piece.text),
    discourse,
    importedNgramModelIdsUsed,
    importedObservationIdsUsed,
    importedLanguageUnitIdsUsed,
    importedPhrasePatternIdsUsed,
    importedSemanticFrameIdsUsed,
    orderUsage,
    averageInformation,
    confidence,
    competence: input.state.competenceVector,
    stoppedBy,
    audit: toJsonValue({
      source: "language-memory-runtime.generate",
      textHash: hashText(text),
      phraseCount: selected.length,
      symbolCount: symbols.length,
      generationExtent,
      stoppedBy,
      confidence,
      averageInformation,
      generationStepCount: discourse.generationStepCount,
      decoderSteps: discourse.steps,
      selectedTransitions: discourse.boundaries,
      requiredTermIdsCovered: discourse.requiredTermIdsCovered,
      propositionAtomIdsCovered: discourse.propositionAtomIdsCovered,
      scoreOrderTextHash: discourse.scoreOrderTextHash,
      discourse,
      rhetoricalSentenceLattice: latticeGeneration ? {
        paragraphPlan: {
          id: latticeGeneration.paragraphPlan.id,
          sentencePlanCount: latticeGeneration.paragraphPlan.sentencePlans.length,
          targetSymbolCount: latticeGeneration.paragraphPlan.targetSymbolCount,
          forceClass: latticeGeneration.paragraphPlan.forceClass
        },
        lattice: {
          id: latticeGeneration.lattice.id,
          clausePlanCount: latticeGeneration.lattice.clausesByPlan.length,
          clauseCandidateCount: latticeGeneration.lattice.clausesByPlan.reduce((sum, row) => sum + row.candidates.length, 0),
          edgeCount: latticeGeneration.lattice.edges.length,
          audit: latticeGeneration.lattice.audit
        },
        proseCandidates: latticeGeneration.proseCandidates.slice(0, 8).map(candidate => ({
          id: candidate.id,
          textHash: hashText(candidate.text),
          sentencePlanIds: candidate.sentencePlanIds,
          score: candidate.score,
          claimCoverage: candidate.claimCoverage,
          anchorCoverage: candidate.anchorCoverage,
          continuity: candidate.continuity,
          repetitionPenalty: candidate.repetitionPenalty,
          lengthFit: candidate.lengthFit,
          priorSupport: candidate.priorSupport
        })),
        critic: {
          candidateId: latticeGeneration.critic.candidateId,
          accepted: latticeGeneration.critic.accepted,
          score: latticeGeneration.critic.score,
          issues: latticeGeneration.critic.issues
        }
      } : null,
      selectedPieces: selected.slice(0, 24).map(piece => ({
        id: piece.id ?? null,
        source: piece.source,
        textHash: hashText(piece.text),
        support: piece.support,
        fit: piece.fit,
        order: piece.order,
        probability: piece.probability,
        score: piece.score,
        semanticMaterialIds: piece.semanticMaterialIds ?? [],
        answerSlotIds: piece.answerSlotIds ?? [],
        demotedMaterialIds: piece.demotedMaterialIds ?? [],
        discourseShapeId: piece.discourseShapeId ?? null,
        compressionApplied: Boolean(piece.compressionApplied),
        rhetoricalPlanId: piece.rhetoricalPlanId ?? null,
        roleAssignmentIds: piece.roleAssignmentIds ?? [],
        rhetoricalStageIds: piece.rhetoricalStageIds ?? [],
        backgroundMaterialIds: piece.backgroundMaterialIds ?? [],
        significanceBridgeMaterialIds: piece.significanceBridgeMaterialIds ?? []
      })),
      semanticFactMaterialsUsed,
      answerSlotsFilled,
      languagePriorsUsed,
      compressionApplied,
      demotedFacts,
      answerRoleAssignments: semanticRhetoricalPlan ? semanticRhetoricalPlan.assignments.map(assignment => ({
        id: assignment.id,
        materialId: assignment.materialId,
        subjectRef: assignment.subjectRef,
        relationRef: assignment.relationRef,
        objectRef: assignment.objectRef,
        roleId: assignment.roleId,
        priority: assignment.priority,
        support: assignment.support,
        relationUsefulness: assignment.relationUsefulness,
      questionShapeFit: assignment.questionShapeFit,
      requestedSlotId: assignment.requestedSlotId ?? null,
      relationRoleId: assignment.relationRoleId ?? null,
      topicSenseId: assignment.topicSenseId ?? null,
      questionSlotId: assignment.questionSlotId ?? null,
      questionSlotImportance: assignment.questionSlotImportance ?? null,
      shouldSurface: assignment.shouldSurface,
      surfaceWeight: assignment.surfaceWeight
      })) : [],
      rhetoricalPlan: semanticRhetoricalPlan ? {
        id: semanticRhetoricalPlan.id,
        subjectLabelHash: hashText(semanticRhetoricalPlan.subjectLabel),
        stages: semanticRhetoricalPlan.stages,
        targetMoveCount: semanticRhetoricalPlan.targetMoveCount,
        backgroundAssignmentIds: semanticRhetoricalPlan.backgroundAssignmentIds,
        significanceBridgeAssignmentIds: semanticRhetoricalPlan.significanceBridgeAssignmentIds,
        roleAssignmentIdsUsed
      } : null,
      discourseShapeId: discourseShapeId ?? null,
      importedNgramModelIdsUsed,
      importedObservationIdsUsed,
      importedLanguageUnitIdsUsed,
      importedPhrasePatternIdsUsed,
      importedSemanticFrameIdsUsed,
      orderUsage,
      competence: input.state.competenceVector,
      score: score.audit,
      frames: (input.frames ?? []).slice(0, 16).map(frame => ({
        id: frame.id,
        pointId: frame.pointId ?? null,
        role: frame.role ?? null,
        force: frame.force ?? null,
        targetLanguage: frame.targetLanguage ?? null,
        targetScript: frame.targetScript ?? null,
        semanticFrameIds: frame.semanticFrameIds ?? [],
        atomCount: frame.propositionAtoms?.length ?? 0,
        requiredTermCount: frame.requiredTerms?.length ?? 0
      }))
    })
  };
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
  return [...terms.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.text.localeCompare(b.text)).slice(0, 48);
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
  return [...atoms.values()].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0) || a.text.localeCompare(b.text)).slice(0, 48);
}

function isDiscourseAtom(atom: LanguageGenerationAtom, frame: LanguageGenerationFrame | undefined): boolean {
  if (frame?.role && frame.role !== "answer" && frame.role !== "caveat" && frame.role !== "example" && frame.role !== "instruction") return false;
  return atom.kind === "claim" || atom.kind === "surface" || atom.kind === "caveat" || atom.kind === "artifact" || atom.kind === "program";
}

function generationPieces(
  input: LanguageGenerationInput,
  requiredTerms: readonly LanguageGenerationTerm[],
  frameAtoms: readonly LanguageGenerationAtom[],
  contextSymbols: readonly string[],
  contextText: string
): GenerationPiece[] {
  const semanticFrameIds = new Set([...(input.semanticFrameIds ?? []), ...(input.frames ?? []).flatMap(frame => frame.semanticFrameIds ?? [])]);
  const rows: GenerationPiece[] = [];
  const allowRawNgramSurfacePieces = requiredTerms.length === 0 && frameAtoms.length === 0;
  const add = (text: string, source: GenerationPiece["source"], id: string | undefined, support: number, metadata: Partial<GenerationPiece> = {}) => {
    const clean = tidyInline(text);
    if (!clean) return;
    const fit = contextText ? weightedJaccard(featureSet(clean, 256), featureSet(contextText, 256)) : 0.5;
    if ((source === "observation" || source === "suggestion") && !allowRawNgramSurfacePieces) return;
    if ((source === "observation" || source === "suggestion") && (!isDiscourseBearingPriorSurface(clean) || !hasContextAnchor(clean, contextText))) return;
    if ((source === "language_unit" || source === "phrase_pattern" || source === "semantic_frame") && !allowRawNgramSurfacePieces && (!isDiscourseBearingPriorSurface(clean) || !hasContextAnchor(clean, contextText))) return;
    const ngram = ngramPieceSupport(input.state, clean, contextSymbols);
    const score = clamp01(0.34 * clamp01(support) + 0.24 * fit + 0.22 * ngram.probability + 0.2 * sourcePreference(source));
    rows.push({ ...metadata, text: clean, source, id, support: clamp01(support), fit, order: ngram.order, probability: ngram.probability, score });
  };
  for (const term of requiredTerms) add(term.text, "required_term", term.id, Math.max(0.1, term.weight ?? 0.5));
  for (const atom of frameAtoms) add(atom.text, "proposition_atom", atom.id, Math.max(0.1, atom.weight ?? 0.5));
  for (const piece of semanticRhetoricalPiecesFromMaterials(semanticFactMaterialsFromFrames(input.frames ?? []), input.state, contextText)) {
    add(piece.text, piece.source, piece.id, piece.support, piece);
  }
  for (const unit of input.state.importedUnits.slice(0, 1024)) {
    if (unit.unitKind !== "phrase" && unit.unitKind !== "symbol") continue;
    add(unit.text, "language_unit", unit.id, unit.alpha);
  }
  for (const pattern of input.state.importedPatterns.slice(0, 512)) {
    for (const surface of patternKeys(pattern).slice(0, 8)) add(surface, "phrase_pattern", pattern.id, pattern.support);
  }
  for (const frame of input.state.importedSemanticFrames.slice(0, 512)) {
    if (semanticFrameIds.size && !semanticFrameIds.has(frame.id)) continue;
    for (const surface of semanticFrameSurfaces(frame).slice(0, 8)) add(surface, "semantic_frame", frame.id, frame.alpha);
  }
  for (const observation of input.state.importedObservations.slice(0, 2048)) {
    const text = [...observation.history.slice(-5), observation.symbol].join(" ");
    const support = Math.max(0.001, Math.log2(1 + observation.count) * Math.max(0.1, observation.fieldWeight) / 12);
    add(text, "observation", observation.id, support);
  }
  for (const suggestion of suggestFromModels(input.state, contextSymbols, 24)) add(suggestion.symbol, "suggestion", undefined, suggestion.support);
  const seen = new Map<string, GenerationPiece>();
  for (const row of rows) {
    const key = row.text.normalize("NFKC").toLocaleLowerCase();
    const existing = seen.get(key);
    if (!existing || row.score > existing.score) seen.set(key, row);
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || b.support - a.support || a.text.localeCompare(b.text)).slice(0, 256);
}

function selectGenerationPieces(pieces: readonly GenerationPiece[], requiredTerms: readonly LanguageGenerationTerm[], generationExtent: number): GenerationPiece[] {
  const selected: GenerationPiece[] = [];
  const add = (piece: GenerationPiece) => {
    if (!piece.text) return;
    const selectedText = selected.map(row => row.text).join(" ");
    if (containsLoose(selectedText, piece.text) || selected.some(row => containsLoose(piece.text, row.text) && row.source !== "required_term")) return;
    const projected = symbolizeData(tidyInline([...selected.map(row => row.text), piece.text].join(" ")));
    if (projected.length > generationExtent && selected.length) return;
    selected.push(piece);
  };
  if (requiredTerms.length) {
    const semanticRhetoric = pieces.filter(row => row.source === "semantic_rhetoric").slice(0, Math.max(1, Math.min(3, Math.floor(generationExtent / 14))));
    for (const piece of semanticRhetoric) add(piece);
    if (semanticRhetoric.length) {
      for (const piece of pieces.filter(row => row.source === "semantic_frame").slice(0, 2)) add(piece);
      for (const source of ["language_unit", "phrase_pattern"] as const) for (const piece of pieces.filter(row => row.source === source).slice(0, 2)) add(piece);
      return selected.slice(0, 8);
    }
    for (const piece of pieces.filter(row => row.source === "proposition_atom").slice(0, 8)) add(piece);
    for (const term of requiredTerms) {
      const text = tidyInline(term.text);
      if (!text || selected.some(piece => containsLoose(piece.text, text)) || containsLoose(joinTextForAudit(selected.map(piece => piece.text)), text)) continue;
      add({ text, source: "required_term", id: term.id, support: clamp01(term.weight ?? 0.5), fit: 1, order: 0, probability: 1, score: 1 });
    }
    for (const piece of pieces.filter(row => row.source === "semantic_frame").slice(0, 4)) add(piece);
    for (const source of ["language_unit", "phrase_pattern"] as const) for (const piece of pieces.filter(row => row.source === source).slice(0, 4)) add(piece);
    if (!selected.length) for (const piece of pieces.slice(0, 4)) add(piece);
    return selected.slice(0, 12);
  }
  for (const piece of pieces.filter(row => row.source === "semantic_rhetoric").slice(0, Math.max(1, Math.min(3, Math.floor(generationExtent / 14))))) add(piece);
  if (selected.length) {
    for (const source of ["semantic_frame", "language_unit", "phrase_pattern"] as const) for (const piece of pieces.filter(row => row.source === source).slice(0, 2)) add(piece);
    return selected.slice(0, 8);
  }
  for (const source of ["language_unit", "phrase_pattern", "observation", "suggestion"] as const) {
    for (const piece of pieces.filter(row => row.source === source).slice(0, 6)) add(piece);
    if (selected.length >= 3) break;
  }
  for (const piece of pieces.filter(row => row.source === "proposition_atom").slice(0, 4)) add(piece);
  for (const piece of pieces.filter(row => row.source === "semantic_frame").slice(0, 4)) add(piece);
  for (const term of requiredTerms) {
    const text = tidyInline(term.text);
    if (!text || selected.some(piece => containsLoose(piece.text, text)) || containsLoose(joinTextForAudit(selected.map(piece => piece.text)), text)) continue;
    add({ text, source: "required_term", id: term.id, support: clamp01(term.weight ?? 0.5), fit: 1, order: 0, probability: 1, score: 1 });
  }
  if (!selected.length) for (const piece of pieces.slice(0, 4)) add(piece);
  return selected.slice(0, 12);
}

interface RhetoricalLatticeGeneration {
  discourse: LanguageDiscourseTrace;
  paragraphPlan: ParagraphPlan;
  lattice: SentenceLattice;
  proseCandidates: ProseCandidate[];
  critic: ProseCriticResult;
}

function generateRhetoricalSentenceLattice(input: {
  state: LanguageMemoryRuntimeState;
  pieces: readonly GenerationPiece[];
  requiredTerms: readonly LanguageGenerationTerm[];
  frameAtoms: readonly LanguageGenerationAtom[];
  frames: readonly LanguageGenerationFrame[];
  contextSymbols: readonly string[];
  contextText: string;
  generationExtent: number;
  styleProfileId?: string;
}): RhetoricalLatticeGeneration | undefined {
  const materials = semanticFactMaterialsFromFrames(input.frames);
  if (!materials.length) return undefined;
  const rhetoricalPlan = semanticRhetoricalPlanFromMaterials(materials, input.contextText);
  if (!rhetoricalPlan) return undefined;
  const paragraphPlan = paragraphPlanFromRhetoricalPlan({
    plan: rhetoricalPlan,
    materials,
    frameAtoms: input.frameAtoms,
    generationExtent: input.generationExtent,
    styleProfileId: input.styleProfileId
  });
  if (!paragraphPlan.sentencePlans.length) return undefined;
  const inlineBoundary = chooseInlineCompressionBoundary(input.state);
  const clausesByPlan = paragraphPlan.sentencePlans
    .map(sentencePlan => ({
      sentencePlanId: sentencePlan.id,
      candidates: clauseCandidatesForSentencePlan({
        sentencePlan,
        plan: rhetoricalPlan,
        materials,
        pieces: input.pieces,
        inlineBoundary: inlineBoundary.text,
        generationExtent: input.generationExtent
      })
    }))
    .filter(row => row.candidates.length > 0);
  if (!clausesByPlan.length) return undefined;
  const lattice: SentenceLattice = {
    id: `sentence.lattice:${hashText(`${paragraphPlan.id}:${clausesByPlan.flatMap(row => row.candidates.map(candidate => candidate.id)).join("|")}`).slice(0, 18)}`,
    paragraphPlan,
    clausesByPlan,
    edges: clauseLatticeEdges(clausesByPlan),
    audit: toJsonValue({
      source: "language-memory-runtime.rhetorical_sentence_lattice",
      paragraphPlanId: paragraphPlan.id,
      sentencePlanCount: paragraphPlan.sentencePlans.length,
      clauseCandidateCount: clausesByPlan.reduce((sum, row) => sum + row.candidates.length, 0),
      edgeCount: clauseLatticeEdges(clausesByPlan).length,
      inlineBoundarySource: inlineBoundary.source
    })
  };
  const sentenceBoundary = chooseSentenceDiscourseBoundary(input.state);
  const proseCandidates = proseCandidatesFromSentenceLattice({ lattice, sentenceBoundary: sentenceBoundary.text, generationExtent: input.generationExtent });
  if (!proseCandidates.length) return undefined;
  const critics = proseCandidates
    .map(candidate => critiqueProseCandidate(candidate, lattice))
    .sort((a, b) => Number(b.accepted) - Number(a.accepted) || b.score - a.score || a.candidateId.localeCompare(b.candidateId));
  const critic = critics[0];
  const selected = critic ? proseCandidates.find(candidate => candidate.id === critic.candidateId) : undefined;
  if (!critic || !selected || !selected.text.trim()) return undefined;
  const discourse = discourseFromProseCandidate({
    candidate: selected,
    lattice,
    critic,
    state: input.state,
    requiredTerms: input.requiredTerms,
    frameAtoms: input.frameAtoms,
    sentenceBoundary,
    generationExtent: input.generationExtent
  });
  return { discourse, paragraphPlan, lattice, proseCandidates: proseCandidates.slice(0, 12), critic };
}

function paragraphPlanFromRhetoricalPlan(input: {
  plan: RhetoricalPlan;
  materials: readonly SemanticFactMaterial[];
  frameAtoms: readonly LanguageGenerationAtom[];
  generationExtent: number;
  styleProfileId?: string;
}): ParagraphPlan {
  const materialById = new Map(input.materials.map(material => [material.id, material]));
  const directMaterials = materialsForRoles(input.plan, materialById, [ANSWER_ROLE_IDS.identity, ANSWER_ROLE_IDS.contribution]).slice(0, 3);
  const explanationMaterials = materialsForRoles(input.plan, materialById, [ANSWER_ROLE_IDS.contribution, ANSWER_ROLE_IDS.significance, ANSWER_ROLE_IDS.context, ANSWER_ROLE_IDS.field]).slice(0, 4);
  const contrastMaterials = input.plan.backgroundAssignmentIds.map(id => materialById.get(input.plan.assignments.find(row => row.id === id)?.materialId ?? "")).filter((row): row is SemanticFactMaterial => Boolean(row)).slice(0, 2);
  const hasAttachedEvidence = input.frameAtoms.some(atom => (atom.evidenceIds ?? []).length > 0);
  const forceClass = input.materials.find(material => material.forceClass)?.forceClass ?? "bounded_memory";
  const target = Math.max(24, Math.min(192, input.generationExtent));
  const sentencePlans: SentencePlan[] = [];
  const add = (move: RhetoricalMove, materials: readonly SemanticFactMaterial[], rank: number, anchors: readonly string[] = []) => {
    const claimIds = uniqueStrings(materials.map(material => material.id));
    const requiredAnchors = uniqueStrings([
      ...anchors,
      ...materials.flatMap(material => [material.subjectLabel, material.objectLabel])
    ].map(tidyInline).filter(Boolean)).slice(0, move === RHETORICAL_MOVE_IDS.lead ? 4 : 3);
    sentencePlans.push({
      id: `sentence.plan:${hashText(`${input.plan.id}:${move}:${claimIds.join(":")}:${rank}`).slice(0, 18)}`,
      move,
      claimIds,
      requiredAnchors,
      forceClass,
      maxTokens: Math.max(8, Math.ceil(target / 5)),
      rank
    });
  };
  const memberMaterials = collectionMemberMaterials(input.plan, materialById, input.materials, input.plan.subjectLabel);
  if (memberMaterials.length) {
    add(RHETORICAL_MOVE_IDS.lead, memberMaterials, 0, [input.plan.subjectLabel]);
    return {
      id: `paragraph.plan:${hashText(`${input.plan.id}:member_relation`).slice(0, 18)}`,
      sentencePlans,
      targetSymbolCount: target,
      forceClass,
      styleProfileId: input.styleProfileId,
      audit: toJsonValue({
        source: "language-memory-runtime.paragraph_plan",
        rhetoricalPlanId: input.plan.id,
        subjectLabelHash: hashText(input.plan.subjectLabel),
        moves: sentencePlans.map(plan => plan.move),
        hasAttachedEvidence,
        forceClass
      })
    };
  }
  add(RHETORICAL_MOVE_IDS.lead, directMaterials.length ? directMaterials : input.materials.slice(0, 2), 0, [input.plan.subjectLabel]);
  add(RHETORICAL_MOVE_IDS.support, explanationMaterials.length ? explanationMaterials : input.materials.slice(0, 3), 1, [input.plan.subjectLabel]);
  if (contrastMaterials.length) add(RHETORICAL_MOVE_IDS.contrast, contrastMaterials, 2, [input.plan.subjectLabel]);
  add(RHETORICAL_MOVE_IDS.sourceBound, input.materials.slice(0, 3), 3, [input.plan.subjectLabel]);
  add(RHETORICAL_MOVE_IDS.boundary, input.materials.slice(0, 2), 4, hasAttachedEvidence ? [] : [input.plan.subjectLabel]);
  add(RHETORICAL_MOVE_IDS.close, directMaterials.length ? directMaterials : input.materials.slice(0, 2), 5, [input.plan.subjectLabel]);
  return {
    id: `paragraph.plan:${hashText(`${input.plan.id}:${sentencePlans.map(plan => plan.move).join("|")}`).slice(0, 18)}`,
    sentencePlans,
    targetSymbolCount: target,
    forceClass,
    styleProfileId: input.styleProfileId,
    audit: toJsonValue({
      source: "language-memory-runtime.paragraph_plan",
      rhetoricalPlanId: input.plan.id,
      subjectLabelHash: hashText(input.plan.subjectLabel),
      moves: sentencePlans.map(plan => plan.move),
      hasAttachedEvidence,
      forceClass
    })
  };
}

function clauseCandidatesForSentencePlan(input: {
  sentencePlan: SentencePlan;
  plan: RhetoricalPlan;
  materials: readonly SemanticFactMaterial[];
  pieces: readonly GenerationPiece[];
  inlineBoundary: string;
  generationExtent: number;
}): ClauseCandidate[] {
  const materialById = new Map(input.materials.map(material => [material.id, material]));
  const planMaterials = input.sentencePlan.claimIds.map(id => materialById.get(id)).filter((row): row is SemanticFactMaterial => Boolean(row));
  const sourcePieceIds = sourcePieceIdsForClaims(input.pieces, input.sentencePlan.claimIds);
  const textRows = rhetoricalClauseTexts({
    move: input.sentencePlan.move,
    plan: input.plan,
    materials: planMaterials.length ? planMaterials : input.materials,
    materialById,
    inlineBoundary: input.inlineBoundary
  });
  const out: ClauseCandidate[] = [];
  for (const [index, text] of textRows.entries()) {
    const clean = tidyInline(text);
    if (!clean) continue;
    if (containsUserFacingMetaSpeech(clean)) continue;
    const coverage = anchorCoverage(clean, input.sentencePlan.requiredAnchors);
    const repetitionPenalty = discourseRepetitionPenalty(clean);
    const symbolCount = symbolizeData(clean).length;
    const maxTokens = input.sentencePlan.maxTokens ?? input.generationExtent;
    const lengthFit = clamp01(1 - Math.max(0, symbolCount - maxTokens) / Math.max(1, maxTokens));
    const support = clamp01(semanticMaterialSupport(planMaterials.length ? planMaterials : input.materials) + (sourcePieceIds.length ? 0.04 : 0));
    const continuity = clauseContinuity(clean, input.plan.subjectLabel);
    const score = clamp01(0.3 * support + 0.28 * coverage + 0.18 * continuity + 0.16 * lengthFit + 0.08 * (1 - repetitionPenalty));
    out.push({
      id: `clause:${hashText(`${input.sentencePlan.id}:${index}:${clean}`).slice(0, 18)}`,
      sentencePlanId: input.sentencePlan.id,
      move: input.sentencePlan.move,
      text: clean,
      claimIds: input.sentencePlan.claimIds,
      requiredAnchors: input.sentencePlan.requiredAnchors,
      sourcePieceIds,
      support,
      coverage,
      continuity,
      repetitionPenalty,
      lengthFit,
      score
    });
  }
  return out.sort((a, b) => b.score - a.score || a.text.localeCompare(b.text)).slice(0, 3);
}

function rhetoricalClauseTexts(input: {
  move: RhetoricalMove;
  plan: RhetoricalPlan;
  materials: readonly SemanticFactMaterial[];
  materialById: ReadonlyMap<string, SemanticFactMaterial>;
  inlineBoundary: string;
}): string[] {
  const boundary = input.inlineBoundary || ",";
  const rows: string[] = [];
  const add = (value: string) => {
    const clean = tidyInline(value);
    if (!clean) return;
    if (containsUserFacingMetaSpeech(clean)) return;
    if (!rows.some(row => semanticRelationDuplicate(row, clean))) rows.push(clean);
  };
  const members = collectionMemberMaterials(input.plan, input.materialById, input.materials, input.plan.subjectLabel);
  if (members.length && (input.move === RHETORICAL_MOVE_IDS.lead || input.move === RHETORICAL_MOVE_IDS.support || input.move === RHETORICAL_MOVE_IDS.close)) {
    add(members.map(material => collectionMemberLabel(material, input.plan.subjectLabel)).filter(Boolean).join(`${boundary} `));
    return rows.slice(0, 4);
  }
  if (input.move === RHETORICAL_MOVE_IDS.lead || input.move === RHETORICAL_MOVE_IDS.close) {
    const main = rhetoricalMainSurface(input.plan, input.materialById, boundary);
    add(main.text);
    const bridge = rhetoricalContributionBridgeSurface(input.plan, input.materialById, boundary);
    add(bridge.text);
  }
  if (input.move === RHETORICAL_MOVE_IDS.support) {
    const bridge = rhetoricalBridgeSurface(input.plan, input.materialById, boundary);
    add(bridge.text);
    const contributionBridge = rhetoricalContributionBridgeSurface(input.plan, input.materialById, boundary);
    add(contributionBridge.text);
  }
  if (input.move === RHETORICAL_MOVE_IDS.contrast) {
    const background = materialsForRoles(input.plan, input.materialById, [ANSWER_ROLE_IDS.backgroundActor, ANSWER_ROLE_IDS.backgroundRelation, ANSWER_ROLE_IDS.context]).slice(0, 2);
    for (const material of background) add(contextRelationSegments(material, input.plan.subjectLabel).join(" "));
  }
  if (input.move === RHETORICAL_MOVE_IDS.sourceBound) {
    const supported = input.materials
      .filter(material => material.forceClass === "direct_evidence" || material.certificationPower)
      .slice(0, 2);
    for (const material of supported) add(materialClauseSurface(material, input.plan.subjectLabel, boundary));
  }
  if (input.move === RHETORICAL_MOVE_IDS.boundary) {
    const weak = input.materials
      .filter(material => material.forceClass !== "direct_evidence" && !material.certificationPower)
      .sort((a, b) => a.support - b.support)
      .slice(0, 1);
    for (const material of weak) add(materialClauseSurface(material, input.plan.subjectLabel, boundary));
  }
  for (const material of input.materials.slice(0, 4)) add(materialClauseSurface(material, input.plan.subjectLabel, boundary));
  return rows.slice(0, 4);
}

function collectionMemberMaterials(plan: RhetoricalPlan, materialById: ReadonlyMap<string, SemanticFactMaterial>, materials: readonly SemanticFactMaterial[], subject: string): SemanticFactMaterial[] {
  const surfaced = materialsForRoles(plan, materialById, [ANSWER_ROLE_IDS.contribution, ANSWER_ROLE_IDS.context, ANSWER_ROLE_IDS.field]);
  return uniqueSemanticMaterials([...surfaced, ...materials])
    .filter(material => !materialRejectedByQuestionSlot(material))
    .filter(material => isCollectionMemberMaterial(material, subject))
    .sort((a, b) => (b.questionSlotScore ?? b.finalQuestionFit ?? b.support) - (a.questionSlotScore ?? a.finalQuestionFit ?? a.support) || a.objectLabel.localeCompare(b.objectLabel))
    .slice(0, 8);
}

function isCollectionMemberMaterial(material: SemanticFactMaterial, subject: string): boolean {
  const slotAligned = material.questionSlotId === ANSWER_SLOT_IDS.memberRelation;
  const roleAligned = material.relationRoleId === RELATION_ROLE_IDS.graphRequestMembership;
  if (!slotAligned && !roleAligned) return false;
  const direct = sameSurface(material.subjectLabel, subject);
  const inverse = inverseCollectionMemberMaterial(material, subject);
  if (!direct && !inverse) return false;
  if (direct && sameSurface(material.objectLabel, subject)) return false;
  const object = normalizeSurfaceKey(material.objectLabel);
  const member = collectionMemberLabel(material, subject);
  if (!object || !member || sameSurface(member, subject)) return false;
  if (semanticSurfaceSymbolMass(member) > 6) return false;
  return inverse || semanticSurfaceSymbolMass(material.objectLabel) <= 5;
}

function collectionMemberLabel(material: SemanticFactMaterial, subject: string): string {
  return inverseCollectionMemberMaterial(material, subject) ? material.subjectLabel : material.objectLabel;
}

function inverseCollectionMemberMaterial(material: SemanticFactMaterial, subject: string): boolean {
  if (material.relationRoleId !== RELATION_ROLE_IDS.graphRequestMembership && material.graphQualityClassId !== GRAPH_QUALITY_CLASS_IDS.catalogNavigation) return false;
  if (sameSurface(material.subjectLabel, subject)) return false;
  return containsSurfaceUnits(material.objectLabel, subject);
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

export function scopeLanguageMemoryStateToCluster(
  state: LanguageMemoryRuntimeState,
  cluster: LanguageProfileCluster
): LanguageMemoryRuntimeState {
  const profileIds = new Set(cluster.profileIds);
  const sourceVersionIds = new Set(cluster.sourceVersionIds.map(String));
  const records = state.records.filter(record => ownedLanguageArtifact(
    modelProfileId(record),
    modelSourceVersionId(record),
    profileIds,
    sourceVersionIds
  ));
  const importedObservations = state.importedObservations.filter(record => ownedLanguageArtifact(
    observationProfileId(record),
    String(record.sourceVersionId ?? ""),
    profileIds,
    sourceVersionIds
  ));
  const importedUnits = state.importedUnits.filter(record => profileIds.has(record.profileId));
  const importedPatterns = state.importedPatterns.filter(record => profileIds.has(record.profileId));
  const importedSemanticFrames = state.importedSemanticFrames.filter(frame => semanticFrameBelongsToCluster(frame, profileIds, sourceVersionIds));
  const importedConstructionBundles = state.importedConstructionBundles.filter(bundle => (
    profileIds.has(bundle.targetProfileId)
    && profileIds.has(bundle.sourceProfileId)
    && bundle.sourceVersionIds.length > 0
    && bundle.sourceVersionIds.every(sourceVersionId => sourceVersionIds.has(sourceVersionId))
    && bundle.sourceExamples.every(example => (
      sourceVersionIds.has(example.sourceVersionId)
      && bundle.evidenceIds.includes(example.evidenceId)
    ))
  ));
  const rejectedConstructionPatterns = state.rejectedConstructionPatterns.filter(issue => (
    issue.profileId ? profileIds.has(issue.profileId) : false
  ));
  const reconstructed = modelsFromObservations(importedObservations);
  const models = selectRuntimeModels(records, reconstructed);
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
    importedConstructionBundles,
    rejectedConstructionPatterns,
    importedLanguagePriorCount,
    competenceVector,
    scope: {
      mode: "cluster",
      clusterId: cluster.id,
      profileIds: [...cluster.profileIds].sort(compareCodePoint),
      sourceVersionIds: cluster.sourceVersionIds.map(String).sort(compareCodePoint),
      purityProven: profileIds.size > 0 && sourceVersionIds.size > 0,
      degraded: importedLanguagePriorCount === 0,
      ...(importedLanguagePriorCount === 0 ? { reason: "cluster-has-no-retained-language-memory" } : {})
    },
    audit: toJsonValue({
      source: "language-memory-runtime.cluster-scope",
      mode: "cluster",
      clusterId: cluster.id,
      profileIds: [...profileIds].sort(compareCodePoint),
      sourceVersionIds: [...sourceVersionIds].sort(compareCodePoint),
      purityProven: profileIds.size > 0 && sourceVersionIds.size > 0,
      degraded: importedLanguagePriorCount === 0,
      retained: {
        modelRecords: records.length,
        observations: importedObservations.length,
        units: importedUnits.length,
        patterns: importedPatterns.length,
        semanticFrames: importedSemanticFrames.length,
        constructionBundles: importedConstructionBundles.length
      },
      rejected: {
        modelRecords: state.records.length - records.length,
        observations: state.importedObservations.length - importedObservations.length,
        units: state.importedUnits.length - importedUnits.length,
        patterns: state.importedPatterns.length - importedPatterns.length,
        semanticFrames: state.importedSemanticFrames.length - importedSemanticFrames.length,
        constructionBundles: state.importedConstructionBundles.length - importedConstructionBundles.length
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
          constructionBundles: 0
        },
        rejected: {
          modelRecords: state.records.length,
          observations: state.importedObservations.length,
          units: state.importedUnits.length,
          patterns: state.importedPatterns.length,
          semanticFrames: state.importedSemanticFrames.length,
          constructionBundles: state.importedConstructionBundles.length
        }
      }
    })
  };
}

function clauseLatticeEdges(clausesByPlan: readonly { sentencePlanId: string; candidates: readonly ClauseCandidate[] }[]): SentenceLattice["edges"] {
  const edges: SentenceLattice["edges"] = [];
  for (let index = 1; index < clausesByPlan.length; index++) {
    for (const left of clausesByPlan[index - 1]!.candidates) {
      for (const right of clausesByPlan[index]!.candidates) {
        const continuity = weightedJaccard(featureSet(left.text, 128), featureSet(right.text, 128));
        edges.push({
          fromClauseId: left.id,
          toClauseId: right.id,
          continuity,
          score: clamp01(0.55 * continuity + 0.25 * right.score + 0.2 * left.score)
        });
      }
    }
  }
  return edges.slice(0, 96);
}

function proseCandidatesFromSentenceLattice(input: { lattice: SentenceLattice; sentenceBoundary: string; generationExtent: number }): ProseCandidate[] {
  const beams: ClauseCandidate[][] = [[]];
  for (const row of input.lattice.clausesByPlan) {
    const next: ClauseCandidate[][] = [];
    for (const beam of beams) {
      for (const candidate of row.candidates) next.push([...beam, candidate]);
    }
    beams.splice(0, beams.length, ...next
      .sort((a, b) => clauseSequenceScore(b) - clauseSequenceScore(a))
      .slice(0, 16));
  }
  return beams
    .map((clauses, index) => proseCandidateFromClauses(clauses, input.lattice, input.sentenceBoundary, input.generationExtent, index))
    .filter((candidate): candidate is ProseCandidate => Boolean(candidate))
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, 12);
}

function proseCandidateFromClauses(clauses: readonly ClauseCandidate[], lattice: SentenceLattice, sentenceBoundary: string, generationExtent: number, index: number): ProseCandidate | undefined {
  if (!clauses.length) return undefined;
  const text = clauses.map(clause => terminateDiscourseSurface(clause.text, sentenceBoundary)).join(" ");
  if (containsUserFacingMetaSpeech(text)) return undefined;
  const symbolCount = symbolizeData(text).length;
  const target = Math.max(1, Math.min(generationExtent, lattice.paragraphPlan.targetSymbolCount));
  const claimIds = uniqueStrings(lattice.paragraphPlan.sentencePlans.flatMap(plan => plan.claimIds));
  const coveredClaimIds = uniqueStrings(clauses.flatMap(clause => clause.claimIds));
  const anchors = uniqueStrings(lattice.paragraphPlan.sentencePlans.flatMap(plan => plan.requiredAnchors));
  const claimCoverage = claimIds.length ? coveredClaimIds.length / claimIds.length : 1;
  const anchor = anchorCoverage(text, anchors);
  const continuity = clauseSequenceContinuity(clauses);
  const repetitionPenalty = discourseRepetitionPenalty(text);
  const lengthFit = clamp01(1 - Math.abs(symbolCount - target) / Math.max(1, target));
  const priorSupport = clauses.length ? mean(clauses.map(clause => clause.support)) : 0;
  const score = clamp01(0.26 * claimCoverage + 0.22 * anchor + 0.18 * continuity + 0.16 * priorSupport + 0.12 * lengthFit + 0.06 * (1 - repetitionPenalty));
  return {
    id: `prose:${hashText(`${lattice.id}:${index}:${clauses.map(clause => clause.id).join("|")}`).slice(0, 18)}`,
    text,
    sentencePlanIds: clauses.map(clause => clause.sentencePlanId),
    clauseIds: clauses.map(clause => clause.id),
    score,
    claimCoverage,
    anchorCoverage: anchor,
    continuity,
    repetitionPenalty,
    lengthFit,
    priorSupport,
    audit: toJsonValue({
      source: "language-memory-runtime.prose_candidate",
      symbolCount,
      target,
      moveCount: clauses.length,
      score
    })
  };
}

function critiqueProseCandidate(candidate: ProseCandidate, lattice: SentenceLattice): ProseCriticResult {
  const issues: string[] = [];
  if (!candidate.text.trim()) issues.push("prose.empty");
  if (containsUserFacingMetaSpeech(candidate.text)) issues.push("prose.meta_speech");
  if (candidate.claimCoverage < 0.55) issues.push("prose.claim_coverage.low");
  if (candidate.anchorCoverage < 0.42) issues.push("prose.anchor_coverage.low");
  if (candidate.repetitionPenalty > 0.42) issues.push("prose.repetition.high");
  if (candidate.lengthFit < 0.16) issues.push("prose.length_fit.low");
  const score = clamp01(candidate.score - issues.length * 0.08);
  return {
    candidateId: candidate.id,
    accepted: issues.length === 0 || (issues.length === 1 && issues[0] === "prose.length_fit.low"),
    score,
    issues,
    claimCoverage: candidate.claimCoverage,
    anchorCoverage: candidate.anchorCoverage,
    continuity: candidate.continuity,
    repetitionPenalty: candidate.repetitionPenalty,
    lengthFit: candidate.lengthFit,
    audit: toJsonValue({
      source: "language-memory-runtime.prose_critic",
      latticeId: lattice.id,
      candidateId: candidate.id,
      issues,
      score
    })
  };
}

function discourseFromProseCandidate(input: {
  candidate: ProseCandidate;
  lattice: SentenceLattice;
  critic: ProseCriticResult;
  state: LanguageMemoryRuntimeState;
  requiredTerms: readonly LanguageGenerationTerm[];
  frameAtoms: readonly LanguageGenerationAtom[];
  sentenceBoundary: DiscourseBoundaryCandidate;
  generationExtent: number;
}): LanguageDiscourseTrace {
  const clauseById = new Map(input.lattice.clausesByPlan.flatMap(row => row.candidates).map(clause => [clause.id, clause]));
  const clauses = input.candidate.clauseIds.map(id => clauseById.get(id)).filter((clause): clause is ClauseCandidate => Boolean(clause));
  const moves = clauses.map((clause, index): LanguageDiscourseMove => ({
    id: `move:${hashText(`${clause.id}:${index}`).slice(0, 12)}`,
    role: clause.move,
    text: clause.text,
    sourcePieceIds: clause.sourcePieceIds,
    frameIds: clause.claimIds,
    atomIds: clause.claimIds,
    support: clause.support,
    information: discourseMoveInformation(input.state, clause.text),
    symbolCount: symbolizeData(clause.text).length,
    planRank: index
  }));
  const boundaries: LanguageDiscourseBoundaryUse[] = [];
  for (let index = 1; index < moves.length; index++) {
    boundaries.push({
      text: input.sentenceBoundary.text,
      source: input.sentenceBoundary.source,
      sourceId: input.sentenceBoundary.sourceId,
      support: input.sentenceBoundary.support,
      betweenMoveIds: [moves[index - 1]!.id, moves[index]!.id]
    });
  }
  const text = input.candidate.text;
  const symbolCount = symbolizeData(text).length;
  const requiredTermIdsCovered = coveredRequiredTermIds(text, input.requiredTerms);
  const propositionAtomIdsCovered = coveredAtomIds(text, input.frameAtoms);
  const fluency: LanguageDiscourseFluencyTrace = {
    beamWidth: Math.max(1, Math.min(8, input.lattice.clausesByPlan.reduce((max, row) => Math.max(max, row.candidates.length), 1))),
    beamExpansions: input.lattice.edges.length + input.candidate.clauseIds.length,
    candidateMoveCount: input.lattice.clausesByPlan.reduce((sum, row) => sum + row.candidates.length, 0),
    selectedBeamScore: input.critic.score,
    selectedUnitIds: moves.map(move => move.id),
    latentCoherence: input.candidate.continuity,
    ngramMeanActivation: moves.length ? clamp01(mean(moves.map(move => 1 / Math.max(1, move.information)))) : 0,
    priorSupport: input.candidate.priorSupport,
    coverageGain: input.candidate.claimCoverage,
    repetitionPenalty: input.candidate.repetitionPenalty,
    symbolCount
  };
  return {
    text,
    moves,
    boundaries,
    steps: discourseGenerationSteps(moves, boundaries, text, input.requiredTerms, input.frameAtoms),
    generationStepCount: moves.length,
    stopReason: stopReasonForDiscourse({ text, moves, symbolCount, generationExtent: input.generationExtent, requiredTermIdsCovered, requiredTerms: input.requiredTerms, propositionAtomIdsCovered, frameAtoms: input.frameAtoms }),
    requiredTermIdsCovered,
    propositionAtomIdsCovered,
    scoreOrderTextHash: hashText(input.candidate.clauseIds.join("|")),
    anchorCoverage: input.candidate.anchorCoverage,
    cohesion: discourseCohesion(moves),
    repetitionPenalty: input.candidate.repetitionPenalty,
    discourseScore: input.critic.score,
    fluency
  };
}

function sourcePieceIdsForClaims(pieces: readonly GenerationPiece[], claimIds: readonly string[]): string[] {
  return uniqueStrings(pieces
    .filter(piece => piece.id && piece.semanticMaterialIds?.some(id => claimIds.includes(id)))
    .map(piece => piece.id!));
}

function materialsForRoles(plan: RhetoricalPlan, materialById: ReadonlyMap<string, SemanticFactMaterial>, roleIds: readonly string[]): SemanticFactMaterial[] {
  return uniqueSemanticMaterials(plan.assignments
    .filter(assignment => roleIds.includes(assignment.roleId) && assignment.shouldSurface)
    .sort((a, b) => b.surfaceWeight - a.surfaceWeight || b.priority - a.priority)
    .map(assignment => materialById.get(assignment.materialId))
    .filter((material): material is SemanticFactMaterial => Boolean(material)));
}

function anchorCoverage(text: string, anchors: readonly string[]): number {
  const required = uniqueStrings(anchors.map(tidyInline).filter(Boolean));
  if (!required.length) return 1;
  const covered = required.filter(anchor => containsLoose(text, anchor) || weightedJaccard(featureSet(text, 128), featureSet(anchor, 128)) > 0.18).length;
  return covered / required.length;
}

function clauseContinuity(text: string, subject: string): number {
  const cleanSubject = tidyInline(subject);
  if (!cleanSubject) return 0.5;
  return clamp01(0.35 + weightedJaccard(featureSet(text, 128), featureSet(cleanSubject, 128)) * 1.4);
}

function clauseSequenceScore(clauses: readonly ClauseCandidate[]): number {
  if (!clauses.length) return 0;
  return clamp01(mean(clauses.map(clause => clause.score)) + clauseSequenceContinuity(clauses) * 0.18 - mean(clauses.map(clause => clause.repetitionPenalty)) * 0.18);
}

function clauseSequenceContinuity(clauses: readonly ClauseCandidate[]): number {
  if (clauses.length <= 1) return clauses.length ? 0.72 : 0;
  const scores: number[] = [];
  for (let index = 1; index < clauses.length; index++) scores.push(weightedJaccard(featureSet(clauses[index - 1]!.text, 128), featureSet(clauses[index]!.text, 128)));
  return clamp01(mean(scores));
}

function weaveDiscourse(input: {
  state: LanguageMemoryRuntimeState;
  pieces: readonly GenerationPiece[];
  requiredTerms: readonly LanguageGenerationTerm[];
  frameAtoms: readonly LanguageGenerationAtom[];
  frames: readonly LanguageGenerationFrame[];
  contextSymbols: readonly string[];
  generationExtent: number;
}): LanguageDiscourseTrace {
  const availableMoves = discourseMoves(input);
  const boundary = availableMoves.some(move => move.role === "semantic_rhetoric")
    ? chooseSentenceDiscourseBoundary(input.state)
    : chooseDiscourseBoundary(input.state, input.contextSymbols);
  const decoded = decodeDiscourseMoves({ state: input.state, moves: availableMoves, boundary, requiredTerms: input.requiredTerms, frameAtoms: input.frameAtoms, generationExtent: input.generationExtent });
  const repairedText = repairRequiredTermCoverage(decoded.text, input.requiredTerms, input.generationExtent);
  const text = availableMoves.some(move => move.role === "semantic_rhetoric")
    ? terminateDiscourseSurface(repairedText, boundary.text)
    : repairedText;
  const finalMoves = decoded.moves.map(move => ({ ...move, symbolCount: symbolizeData(move.text).length, information: discourseMoveInformation(input.state, move.text) }));
  const boundaries = decoded.boundaries.map(row => ({ ...row, support: boundary.support }));
  const requiredTermIdsCovered = coveredRequiredTermIds(text, input.requiredTerms);
  const propositionAtomIdsCovered = coveredAtomIds(text, input.frameAtoms);
  const steps = discourseGenerationSteps(finalMoves, boundaries, text, input.requiredTerms, input.frameAtoms);
  const symbolCount = symbolizeData(text).length;
  const anchorCoverage = requiredTermCoverage(text, input.requiredTerms);
  const cohesion = discourseCohesion(finalMoves);
  const repetitionPenalty = discourseRepetitionPenalty(text);
  const fluency = {
    ...decoded.fluency,
    selectedUnitIds: finalMoves.map(move => move.id),
    symbolCount,
    repetitionPenalty
  };
  const discourseScore = clamp01(0.3 * anchorCoverage + 0.24 * cohesion + 0.22 * fluency.selectedBeamScore + 0.14 * fluency.ngramMeanActivation + 0.1 * boundary.support - repetitionPenalty * 0.24);
  return {
    text,
    moves: finalMoves,
    boundaries,
    steps,
    generationStepCount: steps.length,
    stopReason: stopReasonForDiscourse({ text, moves: finalMoves, symbolCount, generationExtent: input.generationExtent, requiredTermIdsCovered, requiredTerms: input.requiredTerms, propositionAtomIdsCovered, frameAtoms: input.frameAtoms }),
    requiredTermIdsCovered,
    propositionAtomIdsCovered,
    scoreOrderTextHash: hashText(joinTextForAudit(input.pieces.map(piece => piece.text))),
    anchorCoverage,
    cohesion,
    repetitionPenalty,
    discourseScore,
    fluency
  };
}

function decodeDiscourseMoves(input: {
  state: LanguageMemoryRuntimeState;
  moves: readonly LanguageDiscourseMove[];
  boundary: DiscourseBoundaryCandidate;
  requiredTerms: readonly LanguageGenerationTerm[];
  frameAtoms: readonly LanguageGenerationAtom[];
  generationExtent: number;
}): DiscourseDecodeResult {
  const candidates = rankDiscourseMoveCandidates(input.moves).slice(0, 32);
  const hasPriorAnchorCandidate = candidates.some(isPriorAnchorMove);
  const semanticCandidateCount = candidates.filter(move => move.role === "semantic_rhetoric").length;
  const minimumCoverageMoves = semanticCandidateCount > 1 ? Math.min(4, semanticCandidateCount) : Math.min(2, candidates.length);
  const beamWidth = Math.max(2, Math.min(8, Math.ceil(Math.sqrt(candidates.length + 1))));
  const maxSteps = Math.min(8, candidates.length);
  let beams: DiscourseBeamState[] = [emptyDiscourseBeamState()];
  let best = beams[0]!;
  let beamExpansions = 0;

  for (let depth = 0; depth < maxSteps; depth++) {
    const expanded: DiscourseBeamState[] = [];
    for (const state of beams) {
      for (const move of candidates) {
        if (state.usedMoveIds.includes(move.id)) continue;
        const next = advanceDiscourseBeam({ state, move, boundary: input.boundary, requiredTerms: input.requiredTerms, frameAtoms: input.frameAtoms, generationExtent: input.generationExtent });
        if (!next) continue;
        expanded.push(next);
        beamExpansions++;
      }
    }
    if (!expanded.length) break;
    beams = expanded
      .sort((a, b) => scoreDiscourseBeamState(b, input.requiredTerms, input.frameAtoms) - scoreDiscourseBeamState(a, input.requiredTerms, input.frameAtoms) || a.text.localeCompare(b.text))
      .slice(0, beamWidth);
    if (scoreDiscourseBeamState(beams[0]!, input.requiredTerms, input.frameAtoms) > scoreDiscourseBeamState(best, input.requiredTerms, input.frameAtoms)) best = beams[0]!;
    if (discourseBeamHasCoverage(best, input.requiredTerms, input.frameAtoms) && (!hasPriorAnchorCandidate || discourseBeamHasPriorAnchor(best)) && best.moves.length >= minimumCoverageMoves) break;
  }

  if (!best.moves.length && candidates.length) {
    best = advanceDiscourseBeam({ state: emptyDiscourseBeamState(), move: candidates[0]!, boundary: input.boundary, requiredTerms: input.requiredTerms, frameAtoms: input.frameAtoms, generationExtent: input.generationExtent }) ?? emptyDiscourseBeamState();
  }

  const moveCount = Math.max(1, best.moves.length);
  const latentCoherence = best.moves.length > 1 ? clamp01(best.latentCoherenceSum / Math.max(1, best.moves.length - 1)) : best.moves.length ? 0.72 : 0;
  const fluency: LanguageDiscourseFluencyTrace = {
    beamWidth,
    beamExpansions,
    candidateMoveCount: candidates.length,
    selectedBeamScore: clamp01(scoreDiscourseBeamState(best, input.requiredTerms, input.frameAtoms)),
    selectedUnitIds: best.moves.map(move => move.id),
    latentCoherence,
    ngramMeanActivation: clamp01(best.ngramActivationSum / moveCount),
    priorSupport: clamp01(best.priorSupportSum / moveCount),
    coverageGain: clamp01(best.coverageGainSum / moveCount),
    repetitionPenalty: best.repetitionPenalty,
    symbolCount: best.symbolCount
  };
  return { moves: best.moves, text: best.text, boundaries: best.boundaryUses, fluency };
}

function emptyDiscourseBeamState(): DiscourseBeamState {
  return {
    moves: [],
    text: "",
    symbolCount: 0,
    usedMoveIds: [],
    coveredRequiredTermIds: [],
    coveredAtomIds: [],
    score: 0,
    transitionScores: [],
    latentCoherenceSum: 0,
    ngramActivationSum: 0,
    priorSupportSum: 0,
    coverageGainSum: 0,
    repetitionPenalty: 0,
    boundaryUses: []
  };
}

function advanceDiscourseBeam(input: {
  state: DiscourseBeamState;
  move: LanguageDiscourseMove;
  boundary: DiscourseBoundaryCandidate;
  requiredTerms: readonly LanguageGenerationTerm[];
  frameAtoms: readonly LanguageGenerationAtom[];
  generationExtent: number;
}): DiscourseBeamState | undefined {
  const text = input.state.text ? renderBoundary(input.boundary.text, input.state.text, input.move.text) : tidyInline(input.move.text);
  const symbols = symbolizeData(text);
  if (symbols.length > input.generationExtent && input.state.moves.length > 0) return undefined;
  const requiredTermIds = coveredRequiredTermIds(text, input.requiredTerms);
  const atomIds = coveredAtomIds(text, input.frameAtoms);
  const termGain = newCoverageMass(input.state.coveredRequiredTermIds, requiredTermIds, requiredCoverageDenominator(input.requiredTerms));
  const atomGain = newCoverageMass(input.state.coveredAtomIds, atomIds, atomCoverageDenominator(input.frameAtoms));
  const coverageGain = clamp01(0.62 * termGain + 0.38 * atomGain);
  const lastMove = input.state.moves[input.state.moves.length - 1];
  const transitionScore = lastMove ? weightedJaccard(featureSet(lastMove.text, 128), featureSet(input.move.text, 128)) : 0.72;
  const ngramActivation = clamp01(1 / Math.max(1, input.move.information));
  const priorSupport = clamp01(input.move.support + Math.min(0.2, input.move.sourcePieceIds.length * 0.04));
  const roleFit = clamp01(1 - discourseRoleRank(input.move.role) / 12);
  const projectedRepetition = discourseRepetitionPenalty(text);
  const boundaryBonus = input.state.moves.length ? clamp01(input.boundary.support) * 0.05 : 0;
  const priorAnchorBonus = isPriorAnchorMove(input.move) ? 0.42 : 0;
  const planOrderBonus = clamp01(1 - discoursePlanRank(input.move) / 8) * (input.state.moves.length ? 0.05 : 0.24);
  const increment = 0.23 * coverageGain + 0.28 * priorSupport + 0.15 * transitionScore + 0.11 * ngramActivation + 0.07 * roleFit + boundaryBonus + priorAnchorBonus + planOrderBonus - projectedRepetition * 0.22;
  const boundaryUses = [...input.state.boundaryUses];
  if (lastMove) boundaryUses.push({ text: input.boundary.text, source: input.boundary.source, sourceId: input.boundary.sourceId, support: input.boundary.support, betweenMoveIds: [lastMove.id, input.move.id] });
  return {
    moves: [...input.state.moves, input.move],
    text,
    symbolCount: symbols.length,
    usedMoveIds: [...input.state.usedMoveIds, input.move.id],
    coveredRequiredTermIds: requiredTermIds,
    coveredAtomIds: atomIds,
    score: input.state.score + increment,
    transitionScores: [...input.state.transitionScores, transitionScore],
    latentCoherenceSum: input.state.latentCoherenceSum + (lastMove ? transitionScore : 0),
    ngramActivationSum: input.state.ngramActivationSum + ngramActivation,
    priorSupportSum: input.state.priorSupportSum + priorSupport,
    coverageGainSum: input.state.coverageGainSum + coverageGain,
    repetitionPenalty: projectedRepetition,
    boundaryUses
  };
}

function rankDiscourseMoveCandidates(moves: readonly LanguageDiscourseMove[]): LanguageDiscourseMove[] {
  const byId = new Map<string, LanguageDiscourseMove>();
  for (const move of moves) {
    const existing = byId.get(move.id);
    if (!existing || discourseCandidateScore(move) > discourseCandidateScore(existing)) byId.set(move.id, move);
  }
  return [...byId.values()]
    .sort((a, b) => discourseCandidateScore(b) - discourseCandidateScore(a) || discoursePlanRank(a) - discoursePlanRank(b) || a.text.localeCompare(b.text))
    .slice(0, 48);
}

function discourseCandidateScore(move: LanguageDiscourseMove): number {
  const ngramActivation = clamp01(1 / Math.max(1, move.information));
  const roleFit = clamp01(1 - discourseRoleRank(move.role) / 12);
  const sourceMass = Math.min(0.16, move.sourcePieceIds.length * 0.04);
  const compactness = clamp01(1 / Math.max(1, move.symbolCount / 8));
  const priorAnchor = isPriorAnchorMove(move) ? 0.42 : 0;
  const planOrder = clamp01(1 - discoursePlanRank(move) / 8);
  return clamp01(0.4 * move.support + 0.16 * ngramActivation + 0.14 * roleFit + 0.08 * compactness + 0.06 * sourceMass + 0.12 * planOrder + priorAnchor);
}

function discoursePlanRank(move: LanguageDiscourseMove): number {
  return typeof move.planRank === "number" && Number.isFinite(move.planRank) ? move.planRank : 8;
}

function scoreDiscourseBeamState(state: DiscourseBeamState, requiredTerms: readonly LanguageGenerationTerm[], atoms: readonly LanguageGenerationAtom[]): number {
  const requiredCoverage = requiredCoverageDenominator(requiredTerms) ? state.coveredRequiredTermIds.length / requiredCoverageDenominator(requiredTerms) : 1;
  const atomCoverage = atomCoverageDenominator(atoms) ? state.coveredAtomIds.length / atomCoverageDenominator(atoms) : 1;
  const moveBalance = Math.min(1, state.moves.length / 3);
  const transitionMean = state.transitionScores.length ? mean(state.transitionScores) : state.moves.length ? 0.72 : 0;
  const averageSupport = state.moves.length ? state.priorSupportSum / state.moves.length : 0;
  const priorAnchor = discourseBeamHasPriorAnchor(state) ? 0.62 : 0;
  return state.score + 0.32 * clamp01(requiredCoverage) + 0.18 * clamp01(atomCoverage) + 0.12 * moveBalance + 0.1 * transitionMean + 0.12 * clamp01(averageSupport) + priorAnchor - state.repetitionPenalty * 0.32;
}

function discourseBeamHasCoverage(state: DiscourseBeamState, requiredTerms: readonly LanguageGenerationTerm[], atoms: readonly LanguageGenerationAtom[]): boolean {
  const requiredDenominator = requiredCoverageDenominator(requiredTerms);
  const atomDenominator = atomCoverageDenominator(atoms);
  const requiredOk = requiredDenominator === 0 || state.coveredRequiredTermIds.length >= requiredDenominator;
  const atomOk = atomDenominator === 0 || state.coveredAtomIds.length >= Math.max(1, Math.ceil(atomDenominator * 0.5));
  return requiredOk && atomOk;
}

function requiredCoverageDenominator(requiredTerms: readonly LanguageGenerationTerm[]): number {
  return requiredTerms.filter(term => (term.weight ?? 0) >= 0.45 && tidyInline(term.text)).length;
}

function atomCoverageDenominator(atoms: readonly LanguageGenerationAtom[]): number {
  return atoms.filter(atom => tidyInline(atom.text)).length;
}

function newCoverageMass(previousIds: readonly string[], nextIds: readonly string[], denominator: number): number {
  if (denominator <= 0) return 0;
  let gain = 0;
  for (const id of nextIds) if (!previousIds.includes(id)) gain++;
  return clamp01(gain / denominator);
}

function isPriorAnchorMove(move: LanguageDiscourseMove): boolean {
  return move.role === "semantic_rhetoric" || move.role === "language_unit" || move.role === "phrase_pattern" || move.role === "observation" || move.role === "suggestion";
}

function discourseBeamHasPriorAnchor(state: DiscourseBeamState): boolean {
  return state.moves.some(isPriorAnchorMove);
}

function discourseGenerationSteps(
  moves: readonly LanguageDiscourseMove[],
  boundaries: readonly LanguageDiscourseBoundaryUse[],
  text: string,
  requiredTerms: readonly LanguageGenerationTerm[],
  atoms: readonly LanguageGenerationAtom[]
): LanguageGenerationStep[] {
  return moves.map((move, index) => {
    const prefix = joinTextForAudit(moves.slice(0, index + 1).map(row => row.text));
    const boundary = index === 0 ? undefined : boundaries[index - 1]?.text;
    return {
      index,
      action: "emit_move",
      moveId: move.id,
      role: move.role,
      textHash: hashText(move.text),
      boundaryBefore: boundary,
      sourcePieceIds: move.sourcePieceIds,
      coveredRequiredTermIds: coveredRequiredTermIds(prefix || text, requiredTerms),
      coveredAtomIds: coveredAtomIds(prefix || text, atoms),
      score: clamp01(move.support * 0.45 + (1 / Math.max(1, move.information)) * 0.25 + (move.symbolCount > 0 ? 0.3 : 0)),
      cumulativeScore: clamp01((index + 1) / Math.max(1, moves.length)),
      transitionScore: index === 0 ? 0.72 : weightedJaccard(featureSet(moves[index - 1]!.text, 128), featureSet(move.text, 128))
    };
  });
}

function stopReasonForDiscourse(input: {
  text: string;
  moves: readonly LanguageDiscourseMove[];
  symbolCount: number;
  generationExtent: number;
  requiredTermIdsCovered: readonly string[];
  requiredTerms: readonly LanguageGenerationTerm[];
  propositionAtomIdsCovered: readonly string[];
  frameAtoms: readonly LanguageGenerationAtom[];
}): LanguageDiscourseTrace["stopReason"] {
  if (!input.text.trim() || !input.moves.length) return "empty";
  if (input.symbolCount >= input.generationExtent) return "generation_extent";
  const required = input.requiredTerms.filter(term => (term.weight ?? 0) >= 0.45);
  const atoms = input.frameAtoms.filter(atom => atom.kind === "claim" || atom.kind === "surface" || atom.kind === "caveat" || atom.kind === "artifact" || atom.kind === "program");
  const requiredCovered = required.length === 0 || input.requiredTermIdsCovered.length >= required.length;
  const atomCovered = atoms.length === 0 || input.propositionAtomIdsCovered.length >= Math.max(1, Math.ceil(atoms.length * 0.5));
  return requiredCovered && atomCovered ? "coverage_satisfied" : "source_exhausted";
}

function discourseMoves(input: {
  state: LanguageMemoryRuntimeState;
  pieces: readonly GenerationPiece[];
  requiredTerms: readonly LanguageGenerationTerm[];
  frameAtoms: readonly LanguageGenerationAtom[];
  frames: readonly LanguageGenerationFrame[];
}): LanguageDiscourseMove[] {
  const rows: LanguageDiscourseMove[] = [];
  const frameIdsByText = frameIdsBySurface(input.frames);
  const atomIdsByText = atomIdsBySurface(input.frameAtoms);
  const hasSemanticRhetoric = input.pieces.some(piece => piece.source === "semantic_rhetoric");
  const add = (text: string, role: string, support: number, sourcePieceIds: string[], planRank?: number) => {
    const clean = tidyInline(text);
    if (!clean) return;
    if (!speechBearingSurface(clean) || !isDiscourseBearingPriorSurface(clean)) return;
    if (rows.some(row => shouldMergeDiscourseMoves(row, clean, role))) {
      const host = rows.find(row => shouldMergeDiscourseMoves(row, clean, role));
      if (host && clean.length > host.text.length) host.text = clean;
      if (host) {
        host.support = Math.max(host.support, support);
        const ranks = [host.planRank, planRank].filter((rank): rank is number => typeof rank === "number" && Number.isFinite(rank));
        host.planRank = ranks.length ? Math.min(...ranks) : undefined;
        host.sourcePieceIds = uniqueStrings([...host.sourcePieceIds, ...sourcePieceIds]);
        host.frameIds = uniqueStrings([...host.frameIds, ...(frameIdsByText.get(clean) ?? [])]);
        host.atomIds = uniqueStrings([...host.atomIds, ...(atomIdsByText.get(clean) ?? [])]);
      }
      return;
    }
    rows.push({
      id: `move:${hashText(`${role}:${clean}`).slice(0, 12)}`,
      role,
      text: clean,
      sourcePieceIds,
      frameIds: frameIdsByText.get(clean) ?? [],
      atomIds: atomIdsByText.get(clean) ?? [],
      support: clamp01(support),
      information: discourseMoveInformation(input.state, clean),
      symbolCount: symbolizeData(clean).length,
      planRank
    });
  };
  for (const piece of input.pieces) add(piece.text, piece.source, piece.support, piece.id ? [piece.id] : [], piece.planRank);
  if (!hasSemanticRhetoric) for (const atom of input.frameAtoms.slice(0, 8)) add(atom.text, atom.kind ?? "atom", atom.weight ?? 0.5, [atom.id]);
  return rows;
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
    const near = [...seen.values()].find(existing => semanticMaterialOverlap(existing, row) > 0.92);
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

function semanticRhetoricalPiecesFromMaterials(materials: readonly SemanticFactMaterial[], state: LanguageMemoryRuntimeState, contextText: string): GenerationPiece[] {
  const plan = semanticRhetoricalPlanFromMaterials(materials, contextText);
  if (!plan) return [];
  const materialById = new Map(materials.map(material => [material.id, material]));
  const boundary = chooseInlineCompressionBoundary(state).text;
  const rows: GenerationPiece[] = [];
  const add = (input: { text: string; idSeed: string; support: number; surfaced: readonly SemanticFactMaterial[]; stages?: readonly string[]; rank: number }) => {
    if (!input.text.trim()) return;
    rows.push(semanticRhetoricalPiece({
      text: input.text,
      idSeed: input.idSeed,
      support: input.support,
      materials: input.surfaced,
      demoted: demotedMaterialIdsForPlan(plan, input.surfaced),
      plan,
      stages: input.stages ?? [],
      planRank: input.rank
    }));
  };
  const main = rhetoricalMainSurface(plan, materialById, boundary);
  add({ text: main.text, idSeed: `${plan.id}:main`, support: main.support, surfaced: main.materials, stages: main.stageIds, rank: 0 });
  const contributionBridge = rhetoricalContributionBridgeSurface(plan, materialById, boundary);
  add({ text: contributionBridge.text, idSeed: `${plan.id}:contribution_bridge`, support: contributionBridge.support, surfaced: contributionBridge.materials, stages: contributionBridge.stageIds, rank: 1 });
  const bridge = rhetoricalBridgeSurface(plan, materialById, boundary);
  add({ text: bridge.text, idSeed: `${plan.id}:bridge`, support: bridge.support, surfaced: bridge.materials, stages: bridge.stageIds, rank: 2 });
  const members = collectionMemberMaterials(plan, materialById, materials, plan.subjectLabel);
  if (members.length) add({
    text: members.map(material => collectionMemberLabel(material, plan.subjectLabel)).filter(Boolean).join(`${boundary} `),
    idSeed: `${plan.id}:members`,
    support: semanticMaterialSupport(members),
    surfaced: members,
    stages: plan.stages.filter(stage => stage.roleId === ANSWER_ROLE_IDS.contribution).map(stage => stage.id),
    rank: 0
  });
  if (!members.length) {
    for (const material of materials.slice(0, 4)) add({
      text: materialClauseSurface(material, plan.subjectLabel, boundary),
      idSeed: `${plan.id}:${material.id}`,
      support: material.support,
      surfaced: [material],
      stages: plan.stages.filter(stage => stage.assignmentIds.some(id => plan.assignments.find(assignment => assignment.id === id)?.materialId === material.id)).map(stage => stage.id),
      rank: 4
    });
  }
  return rows
    .filter(piece => piece.text.trim())
    .sort((a, b) => (a.planRank ?? 99) - (b.planRank ?? 99) || b.support - a.support || a.text.localeCompare(b.text))
    .slice(0, 10);
}

function semanticRhetoricalPlanFromMaterials(materials: readonly SemanticFactMaterial[], contextText: string): RhetoricalPlan | undefined {
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
    targetMoveCount: rhetoricalTargetMoveCount(ordered, stages),
    certificationBoundaryId: assignments.some(assignment => assignment.roleId === ANSWER_ROLE_IDS.boundary) ? ANSWER_ROLE_IDS.boundary : undefined
  };
}

function rhetoricalTargetMoveCount(materials: readonly SemanticFactMaterial[], stages: readonly RhetoricalPlanStage[]): number {
  const upstreamTarget = Math.max(0, ...materials.map(material => material.alphaRhetoricalTargetSentenceCount ?? 0));
  const surfacedStageCount = stages.filter(stage => stage.surfaceWeight >= 0.6).length;
  const bridgeStageCount = stages.filter(stage => isBridgeAnswerRoleId(stage.roleId)).length;
  const raw = Math.max(upstreamTarget, 1 + surfacedStageCount + Math.min(1, bridgeStageCount));
  return Math.max(2, Math.min(6, Math.round(raw)));
}

function answerRoleAssignmentsFromMaterials(materials: readonly SemanticFactMaterial[], subjectLabel: string, contextText: string): AnswerRoleAssignment[] {
  const primaryRows = materials.filter(material => sameSurface(material.subjectLabel, subjectLabel) || sameSurface(material.objectLabel, subjectLabel));
  const primaryObjectKeys = new Set(primaryRows.map(material => normalizeSurfaceKey(material.objectLabel)).filter(Boolean));
  const hasContribution = primaryRows.some(material => semanticRelationSurfaceMass(material) > 1 || semanticQuestionFit(material, contextText) > 0.04);
  return materials.map(material => {
    const subjectMatch = sameSurface(material.subjectLabel, subjectLabel);
    const objectMatch = sameSurface(material.objectLabel, subjectLabel);
    const subjectIsContext = primaryObjectKeys.has(normalizeSurfaceKey(material.subjectLabel));
    const objectIsContext = primaryObjectKeys.has(normalizeSurfaceKey(material.objectLabel));
    const questionShapeFit = material.finalQuestionFit ?? semanticQuestionFit(material, contextText);
    const relationUsefulness = clamp01(0.32 * material.support + 0.24 * material.relevance + 0.44 * questionShapeFit);
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
    const shouldSurface = !rejectedSlot && (!background || (!hasContribution && relationUsefulness > 0.64 && !material.upstreamRoleId && !secondarySlot));
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

function rhetoricalMainSurface(plan: RhetoricalPlan, materialById: ReadonlyMap<string, SemanticFactMaterial>, boundary: string): { text: string; materials: SemanticFactMaterial[]; demotedMaterialIds: string[]; stageIds: string[]; support: number } {
  const identity = firstMaterialForRole(plan, materialById, ANSWER_ROLE_IDS.identity);
  const contribution = firstMaterialForRole(plan, materialById, ANSWER_ROLE_IDS.contribution);
  const segments: string[] = [];
  const materials = uniqueSemanticMaterials([identity, contribution].filter((item): item is SemanticFactMaterial => Boolean(item)));
  if (plan.subjectLabel) segments.push(plan.subjectLabel);
  if (identity?.objectLabel) segments.push(identity.objectLabel);
  if (contribution) {
    for (const segment of relationObjectSegments(contribution)) {
      if (segment && !segments.some(existing => semanticRelationDuplicate(existing, segment))) segments.push(segment);
    }
  }
  return {
    text: tidyInline(segments.join(`${boundary} `)),
    materials,
    demotedMaterialIds: demotedMaterialIdsForPlan(plan, materials),
    stageIds: plan.stages.filter(stage => stage.roleId === ANSWER_ROLE_IDS.identity || stage.roleId === ANSWER_ROLE_IDS.contribution).map(stage => stage.id),
    support: clamp01(semanticMaterialSupport(materials) + 0.08)
  };
}

function rhetoricalBridgeSurface(plan: RhetoricalPlan, materialById: ReadonlyMap<string, SemanticFactMaterial>, boundary: string): { text: string; materials: SemanticFactMaterial[]; demotedMaterialIds: string[]; stageIds: string[]; support: number } {
  const context = firstMaterialForRole(plan, materialById, ANSWER_ROLE_IDS.significance) ?? firstMaterialForRole(plan, materialById, ANSWER_ROLE_IDS.context) ?? firstMaterialForRole(plan, materialById, ANSWER_ROLE_IDS.field);
  if (!context) return { text: "", materials: [], demotedMaterialIds: demotedMaterialIdsForPlan(plan, []), stageIds: [], support: 0 };
  const segments = contextRelationSegments(context, plan.subjectLabel);
  const materials = [context];
  return {
    text: tidyInline(segments.join(" ")),
    materials,
    demotedMaterialIds: demotedMaterialIdsForPlan(plan, materials),
    stageIds: plan.stages.filter(stage => isBridgeAnswerRoleId(stage.roleId)).map(stage => stage.id),
    support: semanticMaterialSupport(materials) * 0.72
  };
}

function rhetoricalContributionBridgeSurface(plan: RhetoricalPlan, materialById: ReadonlyMap<string, SemanticFactMaterial>, boundary: string): { text: string; materials: SemanticFactMaterial[]; demotedMaterialIds: string[]; stageIds: string[]; support: number } {
  void boundary;
  const contribution = firstMaterialForRole(plan, materialById, ANSWER_ROLE_IDS.contribution);
  const context = firstMaterialForRole(plan, materialById, ANSWER_ROLE_IDS.significance) ?? firstMaterialForRole(plan, materialById, ANSWER_ROLE_IDS.context) ?? firstMaterialForRole(plan, materialById, ANSWER_ROLE_IDS.field);
  if (!contribution || !context) return { text: "", materials: [], demotedMaterialIds: demotedMaterialIdsForPlan(plan, []), stageIds: [], support: 0 };
  if (sameSurface(contribution.objectLabel, context.subjectLabel) || semanticRelationDuplicate(contribution.objectLabel, context.subjectLabel)) {
    return { text: "", materials: [], demotedMaterialIds: demotedMaterialIdsForPlan(plan, []), stageIds: [], support: 0 };
  }
  const contextSegments = contextRelationSegments(context, plan.subjectLabel).filter(segment => !sameSurface(segment, plan.subjectLabel));
  const segments = [
    contribution.subjectLabel,
    ...relationObjectSegments(contribution),
    ...contextSegments
  ].map(tidyInline).filter(Boolean);
  const text = tidyInline(segments.join(" "));
  if (!text || semanticSurfaceOverlap(text, contribution.objectLabel) > 0.92) return { text: "", materials: [], demotedMaterialIds: demotedMaterialIdsForPlan(plan, []), stageIds: [], support: 0 };
  const materials = uniqueSemanticMaterials([contribution, context]);
  return {
    text,
    materials,
    demotedMaterialIds: demotedMaterialIdsForPlan(plan, materials),
    stageIds: plan.stages.filter(stage => stage.roleId === ANSWER_ROLE_IDS.contribution || isBridgeAnswerRoleId(stage.roleId)).map(stage => stage.id),
    support: semanticMaterialSupport(materials) * 0.9
  };
}

function semanticRhetoricalPiece(input: {
  text: string;
  idSeed: string;
  support: number;
  materials: readonly SemanticFactMaterial[];
  demoted: readonly string[];
  plan: RhetoricalPlan;
  stages: readonly string[];
  planRank: number;
}): GenerationPiece {
  return {
    text: tidyInline(input.text),
    source: "semantic_rhetoric",
    id: `semantic_rhetoric:${hashText(input.idSeed).slice(0, 24)}`,
    support: clamp01(input.support),
    fit: 0.84,
    order: 0,
    probability: 0.5,
    score: clamp01(0.8 + input.support * 0.16),
    semanticMaterialIds: input.materials.map(row => row.id),
    answerSlotIds: uniqueStrings(input.materials.flatMap(row => row.slotIds)),
    demotedMaterialIds: uniqueStrings(input.demoted),
    discourseShapeId: input.plan.id,
    compressionApplied: false,
    rhetoricalPlanId: input.plan.id,
    roleAssignmentIds: input.plan.assignments.filter(assignment => input.materials.some(material => material.id === assignment.materialId)).map(assignment => assignment.id),
    rhetoricalStageIds: uniqueStrings(input.stages),
    backgroundMaterialIds: input.plan.assignments.filter(assignment => input.plan.backgroundAssignmentIds.includes(assignment.id)).map(assignment => assignment.materialId),
    significanceBridgeMaterialIds: input.plan.assignments.filter(assignment => input.plan.significanceBridgeAssignmentIds.includes(assignment.id)).map(assignment => assignment.materialId),
    planRank: input.planRank
  };
}

function firstMaterialForRole(plan: RhetoricalPlan, materialById: ReadonlyMap<string, SemanticFactMaterial>, roleId: string): SemanticFactMaterial | undefined {
  const assignment = plan.assignments
    .filter(row => row.roleId === roleId && row.shouldSurface)
    .sort((a, b) => b.surfaceWeight - a.surfaceWeight || b.priority - a.priority)[0];
  return assignment ? materialById.get(assignment.materialId) : undefined;
}

function demotedMaterialIdsForPlan(plan: RhetoricalPlan, surfaced: readonly SemanticFactMaterial[]): string[] {
  const surfacedIds = new Set(surfaced.map(material => material.id));
  return plan.assignments.filter(assignment => !surfacedIds.has(assignment.materialId)).map(assignment => assignment.materialId);
}

function relationObjectSegments(material: SemanticFactMaterial): string[] {
  const relation = tidyInline(material.predicateLabel);
  const object = tidyInline(material.objectLabel);
  if (lowSurfaceRelationLabel(relation)) return [object].filter(Boolean);
  if (relation && object) return [tidyInline(`${relation} ${object}`)];
  return [relation, object].filter(Boolean);
}

function contextRelationSegments(material: SemanticFactMaterial, selectedSubject: string): string[] {
  const subject = tidyInline(material.subjectLabel);
  const relation = tidyInline(material.predicateLabel);
  const object = tidyInline(material.objectLabel);
  if (sameSurface(object, selectedSubject) && lowSurfaceRelationLabel(relation)) return [subject].filter(Boolean);
  if (sameSurface(subject, selectedSubject)) return relationObjectSegments(material);
  if (lowSurfaceRelationLabel(relation)) return [subject, object].filter(Boolean);
  return [subject, relation, object].filter(Boolean);
}

function materialClauseSurface(material: SemanticFactMaterial, selectedSubject: string, boundary: string): string {
  const subject = tidyInline(material.subjectLabel);
  const relation = tidyInline(material.predicateLabel);
  const object = tidyInline(material.objectLabel);
  if (!subject || !object) return subject || object;
  if (sameSurface(subject, selectedSubject)) return relationObjectSegments(material).join(" ");
  if (sameSurface(object, selectedSubject)) return lowSurfaceRelationLabel(relation) ? subject : tidyInline(`${relation} ${subject}`);
  return tidyInline([subject, ...relationObjectSegments(material)].filter(Boolean).join(`${boundary} `));
}

function sentenceSubject(value: string): string {
  return titleEntitySurface(tidyInline(value));
}

function humanObject(value: string): string {
  const clean = tidyInline(value).replace(/_/gu, " ");
  if (clean.includes("#")) return "";
  return clean;
}

function humanPredicate(value: string): string {
  return tidyInline(value).replace(/_/gu, " ").toLocaleLowerCase();
}

function containsSurfaceUnits(surface: string, required: string): boolean {
  const haystack = new Set(symbolizeData(surface).map(normalizeSurfaceKey).filter(Boolean));
  const needles = uniqueStrings(symbolizeData(required).map(normalizeSurfaceKey).filter(Boolean));
  return needles.length > 0 && needles.every(needle => haystack.has(needle));
}

function titleEntitySurface(value: string): string {
  const clean = humanObject(value);
  const units = clean.split(" ").filter(Boolean);
  if (!units.length) return clean;
  if (units.length > 5) return stripTerminalSentenceBoundary(sentenceCaseSurface(clean));
  return units.map(unit => {
    if (unit.length === 1) return unit.toLocaleUpperCase();
    const first = unit[0] ?? "";
    if (first !== first.toLocaleLowerCase()) return unit;
    return `${first.toLocaleUpperCase()}${unit.slice(1)}`;
  }).join(" ");
}

function sentenceCaseSurface(value: string): string {
  const clean = tidyInline(value);
  if (!clean) return "";
  return ensureUnicodeSurfaceSentence(clean);
}

function learnedContinuationDiscourse(input: {
  state: LanguageMemoryRuntimeState;
  contextSymbols: readonly string[];
  contextText: string;
  requiredTerms: readonly LanguageGenerationTerm[];
  frameAtoms: readonly LanguageGenerationAtom[];
  generationExtent: number;
  pieces: readonly GenerationPiece[];
}): LanguageDiscourseTrace | undefined {
  if (!input.pieces.length) return undefined;
  const candidates: Array<{
    text: string;
    move: LanguageDiscourseMove;
    support: number;
    score: LanguageMemoryScore;
    continuationAverageLogProbability: number;
  }> = [];
  const models = [...input.state.models]
    .sort((a, b) => b.order - a.order || b.observedSymbolCount - a.observedSymbolCount)
    .slice(0, 1);
  const pieceSeeds = input.pieces
    .map(piece => piece.text)
    .filter(surface => speechBearingSurface(surface) && isDiscourseBearingPriorSurface(surface))
    .slice(0, 12);
  for (const model of models) {
    const predictedSeeds = predictKneserNey(model, input.contextSymbols.slice(-(model.order - 1)), 16)
      .map(item => item.symbol)
      .filter(symbol => symbol !== "</s>" && symbol !== "<s>" && symbol !== "<unk>")
      .filter(isGenerationSeedSurface)
      .slice(0, 1);
    const seeds = uniqueStrings([...pieceSeeds.slice(0, 1), ...predictedSeeds]).slice(0, 1);
    const prompts: Array<{ prompt: readonly string[]; seed?: string }> = [
      ...(seeds.length ? seeds.map(seed => ({ prompt: [...input.contextSymbols, ...symbolizeData(seed)], seed })) : [{ prompt: input.contextSymbols }])
    ];
    for (const row of prompts) {
      const continuation = continueBoundedProse(model, row.prompt, {
        generationExtent: Math.max(8, Math.min(28, input.generationExtent)),
        probabilityFloor: 1e-12,
        temperature: 0.92,
        blockedSymbols: ["<unk>"]
      });
      const text = learnedContinuationSurface(row.seed, continuation.text, input.contextText, input.generationExtent);
      if (!text) continue;
      const score = scoreText(input.state, text, input.contextText);
      const sourcePieceIds = input.pieces
        .filter(piece => containsLoose(text, piece.text) || containsLoose(piece.text, text))
        .map(piece => piece.id)
        .filter((id): id is string => Boolean(id))
        .slice(0, 24);
      candidates.push({
        text,
        move: {
          id: `move:${hashText(`learned-continuation:${text}`).slice(0, 12)}`,
          role: "learned_continuation",
          text,
          sourcePieceIds,
          frameIds: [],
          atomIds: [],
          support: clamp01(0.48 + score.activation * 0.34 + Math.min(0.18, sourcePieceIds.length * 0.03)),
          information: score.information,
          symbolCount: symbolizeData(text).length,
          planRank: 4
        },
        support: clamp01(0.48 + score.activation * 0.34 + Math.min(0.18, sourcePieceIds.length * 0.03)),
        score,
        continuationAverageLogProbability: continuation.averageLogProbability
      });
    }
  }
  const selected = candidates
    .sort((a, b) =>
      continuationCandidateScore(b) - continuationCandidateScore(a) ||
      a.text.localeCompare(b.text)
    )[0];
  if (!selected) return undefined;
  const boundary = chooseSentenceDiscourseBoundary(input.state);
  const text = terminateDiscourseSurface(selected.text, boundary.text);
  const requiredTermIdsCovered = coveredRequiredTermIds(text, input.requiredTerms);
  const propositionAtomIdsCovered = coveredAtomIds(text, input.frameAtoms);
  const step: LanguageGenerationStep = {
    index: 0,
    action: "emit_move",
    moveId: selected.move.id,
    role: selected.move.role,
    textHash: hashText(text),
    sourcePieceIds: selected.move.sourcePieceIds,
    coveredRequiredTermIds: requiredTermIdsCovered,
    coveredAtomIds: propositionAtomIdsCovered,
    score: selected.support,
    cumulativeScore: selected.support,
    transitionScore: 0.72
  };
  return {
    text,
    moves: [{ ...selected.move, text }],
    boundaries: [],
    steps: [step],
    generationStepCount: 1,
    stopReason: "source_exhausted",
    requiredTermIdsCovered,
    propositionAtomIdsCovered,
    scoreOrderTextHash: hashText(text),
    anchorCoverage: requiredTermCoverage(text, input.requiredTerms),
    cohesion: 0.72,
    repetitionPenalty: discourseRepetitionPenalty(text),
    discourseScore: clamp01(0.36 + selected.support * 0.32 + selected.score.activation * 0.24),
    fluency: {
      beamWidth: 1,
      beamExpansions: candidates.length,
      candidateMoveCount: candidates.length,
      selectedBeamScore: continuationCandidateScore(selected),
      selectedUnitIds: [selected.move.id],
      latentCoherence: 0.72,
      ngramMeanActivation: selected.score.activation,
      priorSupport: selected.support,
      coverageGain: requiredTermIdsCovered.length || propositionAtomIdsCovered.length ? 1 : 0,
      repetitionPenalty: discourseRepetitionPenalty(text),
      symbolCount: symbolizeData(text).length
    }
  };
}

function learnedContinuationSurface(seed: string | undefined, continuationText: string, contextText: string, generationExtent: number): string | undefined {
  const seeded = tidyInline([seed, continuationText].filter(Boolean).join(" "));
  const clean = trimBoundaryGlyphSurface(seeded);
  if (!clean || !speechBearingSurface(clean) || !isDiscourseBearingPriorSurface(clean)) return undefined;
  const symbols = symbolizeData(clean);
  if (symbols.length < 2 || symbols.length > Math.max(8, generationExtent)) return undefined;
  const contextOverlap = contextText ? weightedJaccard(featureSet(clean, 256), featureSet(contextText, 256)) : 0;
  if (contextOverlap > 0.92 && clean.length <= contextText.length + 8) return undefined;
  return clean;
}

function continuationCandidateScore(input: { text: string; support: number; score: LanguageMemoryScore; continuationAverageLogProbability: number }): number {
  const compactness = clamp01(1 / Math.max(1, symbolizeData(input.text).length / 24));
  const probability = clamp01(Math.exp(Math.max(-24, input.continuationAverageLogProbability)));
  return clamp01(0.42 * input.support + 0.28 * input.score.activation + 0.18 * compactness + 0.12 * probability);
}

function naturalJoin(values: readonly string[], finalJoiner = ";"): string {
  const clean = uniqueStrings(values.map(tidyInline).filter(Boolean));
  if (clean.length <= 1) return clean[0] ?? "";
  return clean.join(finalJoiner === ";" ? "; " : ` ${finalJoiner} `);
}

function containsUserFacingMetaSpeech(value: string): boolean {
  const clean = tidyInline(value).normalize("NFKC").toLocaleLowerCase();
  const hasStructuralMarker = /[._:=]/u.test(clean) || clean.includes("scce");
  if (!hasStructuralMarker) return false;
  const key = clean.replace(/[\s.\-:=]+/gu, "_").replace(/_+/gu, "_");
  return [
    "answer_path",
    "relation_roles",
    "active_memory_labels",
    "role_weight",
    "graph_proximity",
    "selected_memory_structure",
    "source_evidence_attached",
    "bounded_wording",
    "center_of_answer"
  ].some(marker => key.includes(marker));
}

function lowSurfaceRelationLabel(value: string): boolean {
  const key = normalizeSurfaceKey(value).split("_").join(" ");
  const symbolCount = symbolizeData(key).filter(symbol => symbol.trim()).length;
  return symbolCount <= 1 && key.length <= 2;
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

function semanticRelationSurfaceMass(material: SemanticFactMaterial): number {
  return symbolizeData(`${material.predicateLabel} ${material.objectLabel}`).filter(symbol => symbol.trim()).length;
}

function semanticSurfaceSymbolMass(value: string): number {
  return symbolizeData(value).filter(symbol => symbol.trim()).length;
}

function semanticQuestionFit(material: SemanticFactMaterial, contextText: string): number {
  const context = featureSet(contextText, 128);
  if (!context.length) return 0;
  return weightedJaccard(context, featureSet(`${material.subjectLabel} ${material.predicateLabel} ${material.objectLabel}`, 128));
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

function semanticRelationDuplicate(left: string, right: string): boolean {
  if (semanticSurfaceOverlap(left, right) > 0.72 || containsLoose(left, right) || containsLoose(right, left)) return true;
  const leftSymbols = new Set(symbolizeData(left).map(normalizeSurfaceKey).filter(Boolean));
  const rightSymbols = new Set(symbolizeData(right).map(normalizeSurfaceKey).filter(Boolean));
  if (!leftSymbols.size || !rightSymbols.size) return false;
  let shared = 0;
  for (const symbol of leftSymbols) if (rightSymbols.has(symbol)) shared++;
  return shared / Math.min(leftSymbols.size, rightSymbols.size) >= 0.86 && shared / Math.max(leftSymbols.size, rightSymbols.size) >= 0.62;
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

function semanticContextMaterials(primary: readonly SemanticFactMaterial[], secondary: readonly SemanticFactMaterial[]): SemanticFactMaterial[] {
  if (!secondary.length) return [];
  const anchors = new Set<string>();
  for (const material of primary) {
    anchors.add(normalizeSurfaceKey(material.subjectLabel));
    anchors.add(normalizeSurfaceKey(material.objectLabel));
  }
  return [...secondary]
    .map(row => ({
      row,
      score: row.support + row.relevance * 0.32 + (anchors.has(normalizeSurfaceKey(row.subjectLabel)) || anchors.has(normalizeSurfaceKey(row.objectLabel)) ? 0.36 : 0)
    }))
    .sort((a, b) => b.score - a.score || a.row.subjectLabel.localeCompare(b.row.subjectLabel))
    .map(row => row.row);
}

function semanticMaterialSupport(materials: readonly SemanticFactMaterial[]): number {
  return materials.length ? clamp01(mean(materials.map(row => row.support)) + Math.min(0.12, materials.length * 0.025)) : 0;
}

function uniqueSemanticMaterials(materials: readonly SemanticFactMaterial[]): SemanticFactMaterial[] {
  const out = new Map<string, SemanticFactMaterial>();
  for (const material of materials) out.set(material.id, material);
  return [...out.values()];
}

function chooseInlineCompressionBoundary(state: LanguageMemoryRuntimeState): DiscourseBoundaryCandidate {
  let best: DiscourseBoundaryCandidate | undefined;
  for (const observation of state.importedObservations.slice(0, 4096)) {
    if (!isInlineCompressionBoundarySymbol(observation.symbol)) continue;
    const support = clamp01(Math.log2(1 + observation.count) * Math.max(0.1, observation.fieldWeight) / 10);
    if (!best || support > best.support) best = { text: observation.symbol, source: "ngram_observation", sourceId: observation.id, support };
  }
  return best ?? { text: ";", source: "structural-boundary", support: 0.38 };
}

function isInlineCompressionBoundarySymbol(value: string): boolean {
  const code = value.codePointAt(0);
  return value === "," || value === ";" || value === ":" || code === 0x060c || code === 0x3001 || code === 0xff1b;
}

function semanticDiscourseShapeId(materials: readonly SemanticFactMaterial[]): string {
  const subjects = uniqueStrings(materials.map(row => normalizeSurfaceKey(row.subjectLabel))).length;
  const objects = uniqueStrings(materials.map(row => normalizeSurfaceKey(row.objectLabel))).length;
  const relations = uniqueStrings(materials.map(row => row.relationId || normalizeSurfaceKey(row.predicateLabel))).length;
  return `semantic.discourse.shape.${subjects}.${objects}.${relations}.${hashText(materials.map(semanticMaterialKey).join("\u0001")).slice(0, 12)}`;
}

function semanticMaterialKey(material: SemanticFactMaterial): string {
  return [material.sourceNodeId || material.subjectLabel, material.relationId || material.predicateLabel, material.targetNodeId || material.objectLabel]
    .map(normalizeSurfaceKey)
    .join("\u0001");
}

function materialRejectedByQuestionSlot(material: SemanticFactMaterial): boolean {
  return material.questionSlotImportance === "rejected";
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

function semanticMaterialOverlap(a: SemanticFactMaterial, b: SemanticFactMaterial): number {
  return semanticSurfaceOverlap(`${a.subjectLabel} ${a.predicateLabel} ${a.objectLabel}`, `${b.subjectLabel} ${b.predicateLabel} ${b.objectLabel}`);
}

function semanticSurfaceOverlap(a: string, b: string): number {
  return weightedJaccard(featureSet(a, 128), featureSet(b, 128));
}

function sameSurface(a: string, b: string): boolean {
  return normalizeSurfaceKey(a) === normalizeSurfaceKey(b);
}

function normalizeSurfaceKey(value: string): string {
  return tidyInline(value).normalize("NFKC").toLocaleLowerCase();
}

function jsonStringArray(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item)) : [];
}

function shouldMergeDiscourseMoves(existing: LanguageDiscourseMove, text: string, role: string): boolean {
  if (existing.text === text) return true;
  const overlaps = containsLoose(existing.text, text) || containsLoose(text, existing.text);
  if (!overlaps) return false;
  if (existing.role === role) return true;
  const existingAnchor = existing.role === "semantic_rhetoric" || existing.role === "language_unit" || existing.role === "phrase_pattern" || existing.role === "observation" || existing.role === "suggestion";
  const nextAnchor = role === "semantic_rhetoric" || role === "language_unit" || role === "phrase_pattern" || role === "observation" || role === "suggestion";
  if (existingAnchor !== nextAnchor) return false;
  return Math.abs(symbolizeData(existing.text).length - symbolizeData(text).length) <= 2;
}

function discourseRoleRank(role: string): number {
  if (role === "semantic_rhetoric") return 0;
  if (role === "language_unit") return 0;
  if (role === "phrase_pattern") return 1;
  if (role === "observation") return 2;
  if (role === "suggestion") return 3;
  if (role === "claim" || role === "surface" || role === "quantity" || role === "entity" || role === "symbol") return 4;
  if (role === "semantic_frame") return 5;
  if (role === "caveat") return 6;
  if (role === "required_term") return 7;
  return 8;
}

function renderBoundary(boundary: string, left: string, right: string): string {
  const cleanBoundary = tidyInline(boundary);
  if (!cleanBoundary) return tidyInline(`${left} ${right}`);
  if (isBoundaryGlyphSurface(cleanBoundary)) return tidyInline(`${left}${cleanBoundary} ${right}`);
  return tidyInline(`${left} ${cleanBoundary} ${right}`);
}

function chooseDiscourseBoundary(state: LanguageMemoryRuntimeState, contextSymbols: readonly string[]): DiscourseBoundaryCandidate {
  const candidates = discourseBoundaryCandidates(state, contextSymbols);
  return candidates[0] ?? { text: ":", source: "structural-boundary", support: 0.2 };
}

function chooseSentenceDiscourseBoundary(state: LanguageMemoryRuntimeState): DiscourseBoundaryCandidate {
  let best: DiscourseBoundaryCandidate | undefined;
  for (const observation of state.importedObservations.slice(0, 4096)) {
    if (!isSentenceBoundarySymbol(observation.symbol)) continue;
    const support = clamp01(Math.log2(1 + observation.count) * Math.max(0.1, observation.fieldWeight) / 10);
    if (!best || support > best.support) best = { text: observation.symbol, source: "ngram_observation", sourceId: observation.id, support };
  }
  return best ?? { text: ".", source: "structural-boundary", support: 0.42 };
}

function isSentenceBoundarySymbol(value: string): boolean {
  return isUnicodeSentenceBoundarySymbol(value);
  return value === "." || value === "!" || value === "?" || value === "。" || value === "؟" || value === "।";
}

function terminateDiscourseSurface(text: string, boundary: string): string {
  const clean = tidyInline(text);
  if (!clean || !isSentenceBoundarySymbol(boundary)) return clean;
  const last = clean[clean.length - 1] ?? "";
  return isSentenceBoundarySymbol(last) ? clean : `${clean}${boundary}`;
}

function discourseBoundaryCandidates(state: LanguageMemoryRuntimeState, contextSymbols: readonly string[]): DiscourseBoundaryCandidate[] {
  const out: DiscourseBoundaryCandidate[] = [];
  const add = (text: string, source: string, sourceId: string | undefined, support: number, allowWordConnector: boolean) => {
    const clean = tidyInline(text);
    if (!clean || (allowWordConnector ? !looksLikeBoundaryCandidate(clean) : !isBoundaryGlyphSurface(clean))) return;
    if (!allowWordConnector && !isAtomicBoundaryGlyph(clean)) return;
    out.push({ text: clean, source, sourceId, support: clamp01(support) });
  };
  for (const pattern of state.importedPatterns.slice(0, 512)) {
    const values = discourseStringsFromJson(pattern.patternJson);
    for (const value of values) add(value, "language_pattern", pattern.id, pattern.support, true);
  }
  for (const unit of state.importedUnits.slice(0, 1024)) {
    for (const value of discourseStringsFromJson(unit.metadata)) add(value, "language_unit", unit.id, unit.alpha, true);
  }
  for (const observation of state.importedObservations.slice(0, 4096)) {
    add(observation.symbol, "ngram_observation", observation.id, Math.min(1, Math.log2(1 + observation.count) * Math.max(0.1, observation.fieldWeight) / 10), false);
  }
  for (const model of state.models) {
    for (const prediction of predictKneserNey(model, contextSymbols.slice(-(model.order - 1)), 32)) {
      add(prediction.symbol, "ngram_prediction", undefined, prediction.probability * Math.max(1, model.order), false);
    }
  }
  const best = new Map<string, DiscourseBoundaryCandidate>();
  for (const row of out) {
    const key = row.text.normalize("NFKC").toLocaleLowerCase();
    const existing = best.get(key);
    if (!existing || row.support > existing.support) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => b.support - a.support || a.text.localeCompare(b.text)).slice(0, 16);
}

function discourseStringsFromJson(value: JsonValue | undefined): string[] {
  const out: string[] = [];
  const visit = (node: JsonValue | undefined, keyPath: readonly string[], depth: number) => {
    if (depth > 5 || out.length >= 128) return;
    if (typeof node === "string") {
      if (keyPath.some(isDiscourseMetadataKey) ? looksLikeBoundaryCandidate(node) : isBoundaryGlyphSurface(tidyInline(node))) out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, keyPath, depth + 1);
      return;
    }
    if (!isRecord(node)) return;
    for (const [key, child] of Object.entries(node)) visit(child, [...keyPath, key], depth + 1);
  };
  visit(value, [], 0);
  return [...new Set(out)].slice(0, 64);
}

function isDiscourseMetadataKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase();
  return normalized.includes("boundary") || normalized.includes("separator") || normalized.includes("connector") || normalized.includes("transition") || normalized.includes("joiner") || normalized.includes("cadence");
}

function looksLikeBoundaryCandidate(value: string): boolean {
  const clean = tidyInline(value);
  if (!clean || clean.length > 32) return false;
  if (isBoundaryGlyphSurface(clean)) return true;
  const symbolCount = symbolizeData(clean).filter(symbol => symbol.trim()).length;
  return symbolCount > 0 && symbolCount <= 3 && clean.length <= 24;
}

function isBoundaryGlyphSurface(value: string): boolean {
  if (!value) return false;
  let glyphs = 0;
  for (const char of value) {
    if (isWhitespaceChar(char)) continue;
    if (isLetterLike(char) || isDigitLike(char) || char === "_" || char === "-") return false;
    glyphs++;
  }
  return glyphs > 0;
}

function isAtomicBoundaryGlyph(value: string): boolean {
  let glyphs = 0;
  for (const char of value) {
    if (isWhitespaceChar(char)) continue;
    if (isLetterLike(char) || isDigitLike(char) || char === "_" || char === "-") return false;
    glyphs++;
  }
  return glyphs === 1;
}

function isDiscourseBearingPriorSurface(value: string): boolean {
  if (isBoundaryGlyphSurface(value)) return false;
  const symbols = symbolizeData(value).filter(symbol => symbol.trim());
  const letterSymbols = symbols.filter(symbol => hasLetterLikeSurface(symbol));
  if (letterSymbols.length < 2) return false;
  const punctuation = [...value].filter(char => !isWhitespaceChar(char) && !isLetterLike(char) && !isDigitLike(char)).length;
  const glyphs = [...value].filter(char => !isWhitespaceChar(char)).length;
  if (glyphs > 0 && punctuation / glyphs > 0.35) return false;
  return true;
}

function isGenerationSeedSurface(value: string): boolean {
  const clean = tidyInline(value);
  if (!clean || isBoundaryGlyphSurface(clean)) return false;
  return speechBearingSurface(clean);
}

function speechBearingSurface(value: string): boolean {
  for (const char of value) if (isLetterLike(char) || isDigitLike(char)) return true;
  return false;
}

function trimBoundaryGlyphSurface(value: string): string {
  const chars = [...tidyInline(value)];
  while (chars.length && !isLetterLike(chars[0]!) && !isDigitLike(chars[0]!)) chars.shift();
  while (chars.length && !isLetterLike(chars[chars.length - 1]!) && !isDigitLike(chars[chars.length - 1]!) && !isSentenceBoundarySymbol(chars[chars.length - 1]!)) chars.pop();
  return tidyInline(chars.join(""));
}

function hasLetterLikeSurface(value: string): boolean {
  for (const char of value) if (isLetterLike(char)) return true;
  return false;
}

function hasContextAnchor(value: string, contextText: string): boolean {
  const context = new Set(symbolizeData(contextText).map(symbol => symbol.toLocaleLowerCase()).filter(isAnchorSymbol));
  if (!context.size) return false;
  return symbolizeData(value).map(symbol => symbol.toLocaleLowerCase()).some(symbol => isAnchorSymbol(symbol) && context.has(symbol));
}

function isAnchorSymbol(value: string): boolean {
  if (value.length >= 4 && hasLetterLikeSurface(value)) return true;
  return value.length > 0 && [...value].every(isDigitLike);
}

function repairRequiredTermCoverage(text: string, requiredTerms: readonly LanguageGenerationTerm[], generationExtent: number): string {
  let out = tidyInline(text);
  for (const term of requiredTerms.filter(item => (item.weight ?? 0) >= 0.8)) {
    const clean = tidyInline(term.text);
    if (!clean || containsLoose(out, clean)) continue;
    const projected = tidyInline(`${out} ${clean}`);
    if (symbolizeData(projected).length <= generationExtent) out = projected;
  }
  return out;
}

function requiredTermCoverage(text: string, requiredTerms: readonly LanguageGenerationTerm[]): number {
  const required = requiredTerms.filter(term => (term.weight ?? 0) >= 0.45).map(term => tidyInline(term.text)).filter(Boolean);
  if (!required.length) return 1;
  const covered = required.filter(term => containsLoose(text, term)).length;
  return covered / required.length;
}

function coveredRequiredTermIds(text: string, requiredTerms: readonly LanguageGenerationTerm[]): string[] {
  return requiredTerms
    .filter(term => (term.weight ?? 0) >= 0.45)
    .filter(term => {
      const clean = tidyInline(term.text);
      return clean && containsLoose(text, clean);
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

function joinTextForAudit(values: readonly string[]): string {
  return values.map(tidyInline).filter(Boolean).join(" ");
}

function discourseCohesion(moves: readonly LanguageDiscourseMove[]): number {
  if (moves.length <= 1) return moves.length ? 0.72 : 0;
  const scores: number[] = [];
  for (let i = 1; i < moves.length; i++) scores.push(weightedJaccard(featureSet(moves[i - 1]!.text, 128), featureSet(moves[i]!.text, 128)));
  return clamp01(mean(scores));
}

function discourseRepetitionPenalty(text: string): number {
  const symbols = symbolizeData(text).filter(symbol => symbol.trim());
  if (symbols.length <= 1) return 0;
  const seen = new Set<string>();
  let repeated = 0;
  for (const symbol of symbols) {
    if (seen.has(symbol)) repeated++;
    seen.add(symbol);
  }
  return clamp01(repeated / symbols.length);
}

function discourseMoveInformation(state: LanguageMemoryRuntimeState, text: string): number {
  if (!state.models.length) return text.trim() ? 16 : 0;
  return mean(state.models.slice(0, 6).map(model => surfaceInformation(text, model)));
}

function frameIdsBySurface(frames: readonly LanguageGenerationFrame[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const frame of frames) {
    for (const atom of frame.propositionAtoms ?? []) {
      const clean = tidyInline(atom.text);
      if (!clean) continue;
      out.set(clean, uniqueStrings([...(out.get(clean) ?? []), frame.id]));
    }
  }
  return out;
}

function atomIdsBySurface(atoms: readonly LanguageGenerationAtom[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const atom of atoms) {
    const clean = tidyInline(atom.text);
    if (!clean) continue;
    out.set(clean, uniqueStrings([...(out.get(clean) ?? []), atom.id]));
  }
  return out;
}

function ngramPieceSupport(state: LanguageMemoryRuntimeState, text: string, contextSymbols: readonly string[]): { probability: number; order: number } {
  const symbols = symbolizeData(text).slice(0, 32);
  if (!symbols.length || !state.models.length) return { probability: 0, order: 0 };
  let bestProbability = 0;
  let bestOrder = 0;
  for (const model of state.models) {
    let info = 0;
    const generated: string[] = [];
    for (const symbol of symbols) {
      const context = [...contextSymbols, ...generated].slice(-(model.order - 1));
      const probability = Math.max(1e-12, kneserNeyProbability(model, context, symbol));
      info += -Math.log(probability);
      generated.push(symbol);
    }
    const activation = Math.exp(-info / Math.max(1, symbols.length));
    const weighted = activation * Math.max(1, model.order) / 6;
    if (weighted > bestProbability) {
      bestProbability = weighted;
      bestOrder = model.order;
    }
  }
  return { probability: clamp01(bestProbability), order: bestOrder };
}

function suggestFromModels(state: LanguageMemoryRuntimeState, context: readonly string[], limit: number): LanguageMemorySuggestion[] {
  const merged = new Map<string, LanguageMemorySuggestion>();
  for (const model of state.models) {
    for (const prediction of predictKneserNey(model, context.slice(-(model.order - 1)), Math.max(8, limit) * 2)) {
      if (prediction.symbol === "</s>" || prediction.symbol === "<s>") continue;
      const support = prediction.probability * Math.max(1, model.order);
      const existing = merged.get(prediction.symbol);
      if (!existing || support > existing.support) merged.set(prediction.symbol, { symbol: prediction.symbol, probability: prediction.probability, order: model.order, support });
    }
  }
  return [...merged.values()].sort((a, b) => b.support - a.support || a.symbol.localeCompare(b.symbol)).slice(0, limit);
}

function semanticFrameIdsOverlappingSelectedText(state: LanguageMemoryRuntimeState, selectedText: string): string[] {
  const normalized = selectedText.normalize("NFKC").toLocaleLowerCase();
  if (!normalized) return [];
  return state.importedSemanticFrames
    .filter(frame => semanticFrameSurfaces(frame).some(surface => {
      const compact = surface.normalize("NFKC").toLocaleLowerCase();
      return compact.includes(normalized) || symbolizeData(normalized).some(symbol => symbol.length > 2 && compact.includes(symbol));
    }))
    .map(frame => frame.id)
    .slice(0, 32);
}

function sourcePreference(source: GenerationPiece["source"]): number {
  if (source === "required_term") return 1;
  if (source === "semantic_rhetoric") return 0.98;
  if (source === "language_unit") return 0.96;
  if (source === "phrase_pattern") return 0.88;
  if (source === "observation") return 0.78;
  if (source === "semantic_frame") return 0.74;
  if (source === "proposition_atom") return 0.68;
  return 0.52;
}

function containsLoose(text: string, surface: string): boolean {
  const haystack = text.normalize("NFKC").toLocaleLowerCase();
  const needle = surface.normalize("NFKC").toLocaleLowerCase();
  return Boolean(needle && haystack.includes(needle));
}

function isLetterLike(char: string): boolean {
  return char.toLocaleLowerCase() !== char.toLocaleUpperCase();
}

function isDigitLike(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
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
    profile: input.profile,
    sourceVersionId: input.sourceVersionId,
    text: input.text,
    evidence: input.evidence,
    createdAt: input.createdAt,
    maxOrder: input.maxOrder ?? 6,
    maxCountersPerOrder: input.maxCountersPerOrder,
    vocabularyLimit: input.vocabularyLimit
  });
}

function scoreText(state: LanguageMemoryRuntimeState, text: string, contextText?: string): LanguageMemoryScore {
  const textFeatures = featureSet(text, 256);
  const contextFeatures = contextText ? featureSet(contextText, 256) : [];
  const fit = contextFeatures.length ? weightedJaccard(textFeatures, contextFeatures) : textFeatures.length ? 0.5 : 0;
  const orderScores = state.models.map(model => {
    const information = surfaceInformation(text, model);
    const activation = Math.exp(-Math.min(24, information)) * Math.max(1, model.order) / 21;
    const orderFit = clamp01(0.72 * fit + 0.28 * Math.min(1, model.observedSymbolCount / 10000));
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

function patternKeys(pattern: LanguagePatternRecord): string[] {
  const json = jsonRecord(pattern.patternJson);
  const counts = jsonRecord(json.counts);
  const keys = Object.keys(counts);
  if (keys.length) return keys.slice(0, 64);
  return Object.entries(json)
    .filter(([, value]) => typeof value === "string")
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
    models.push({
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
    });
  }
  return models;
}

function selectRuntimeModels(records: readonly NgramModelRecord[], reconstructed: readonly KneserNeyModel[]): KneserNeyModel[] {
  const candidates: Array<{ key: string; model: KneserNeyModel }> = [];
  for (const record of [...records].sort((left, right) => compareCodePoint(left.id, right.id))) {
    const model = ngramModelFromRecord(record);
    if (model) candidates.push({ key: `record:${record.id}`, model });
  }
  for (const model of reconstructed) candidates.push({ key: `reconstructed:${model.order}`, model });
  return candidates
    .sort((left, right) => right.model.order - left.model.order
      || right.model.observedSymbolCount - left.model.observedSymbolCount
      || compareCodePoint(left.key, right.key))
    .slice(0, 36)
    .map(candidate => candidate.model);
}

function modelSourceVersionId(record: NgramModelRecord): string | undefined {
  const row = jsonRecord(record.modelJson);
  return typeof row.sourceVersionId === "string" && row.sourceVersionId ? row.sourceVersionId : undefined;
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
  sourceVersionId: string | undefined,
  profileIds: ReadonlySet<string>,
  sourceVersionIds: ReadonlySet<string>
): boolean {
  if (profileId) return profileIds.has(profileId);
  return Boolean(sourceVersionId) && sourceVersionIds.has(sourceVersionId!);
}

function semanticFrameBelongsToCluster(
  frame: SemanticFrameRecord,
  profileIds: ReadonlySet<string>,
  sourceVersionIds: ReadonlySet<string>
): boolean {
  const row = jsonRecord(frame.frameJson);
  if (typeof row.profileId === "string" && row.profileId) return profileIds.has(row.profileId);
  return typeof row.sourceVersionId === "string" && sourceVersionIds.has(row.sourceVersionId);
}

function ngramModelFromRecord(record: NgramModelRecord): KneserNeyModel | undefined {
  const json = record.modelJson;
  if (!json || typeof json !== "object" || Array.isArray(json)) return undefined;
  const model = (json as Record<string, JsonValue>).model;
  if (!model || typeof model !== "object" || Array.isArray(model)) return undefined;
  const row = model as Record<string, JsonValue>;
  if (typeof row.order !== "number" || typeof row.discount !== "number" || !isRecord(row.counts) || !isRecord(row.contextCounts) || !Array.isArray(row.vocabulary)) return undefined;
  return {
    order: row.order,
    discount: row.discount,
    observedSymbolCount: numberOf(row.observedSymbolCount),
    vocabularySize: numberOf(row.vocabularySize),
    counts: numberRecord(row.counts),
    contextCounts: numberRecord(row.contextCounts),
    continuationCounts: numberRecord(row.continuationCounts),
    contextContinuationTypes: numberRecord(row.contextContinuationTypes),
    totalContinuationTypes: numberOf(row.totalContinuationTypes),
    unigramCounts: numberRecord(row.unigramCounts),
    totalUnigramCount: numberOf(row.totalUnigramCount),
    vocabulary: row.vocabulary.map(String)
  };
}

function numberRecord(value: JsonValue | undefined): Record<string, number> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, raw]) => [key, numberOf(raw)]));
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
  const generationReliability = clamp01(0.4 * lexicalCoverage + 0.36 * phraseFluency + 0.24 * modelCoverage);
  const patternCoverage = clamp01(Math.log2(1 + (input.importedPatterns?.length ?? 0)) / 10);
  const constructionCoverage = clamp01(Math.log2(1 + (input.importedConstructionBundles?.length ?? 0)) / 10);
  const semanticFrameCoverage = clamp01(Math.log2(1 + (input.importedSemanticFrames?.length ?? 0)) / 10);
  return {
    scriptRecognition: clamp01(input.languageHints.length ? 0.45 + 0.1 * input.languageHints.length : modelCoverage * 0.3),
    segmentationQuality: clamp01(0.35 * modelCoverage + 0.65 * lexicalCoverage),
    lexicalCoverage,
    phraseFluency,
    syntacticCoverage: clamp01((maxOrder >= 3 ? phraseFluency * 0.62 : phraseFluency * 0.3) + patternCoverage * 0.18 + constructionCoverage * 0.2),
    semanticFrameCoverage,
    translationAlignment: 0,
    entailmentReliability: 0,
    generationReliability,
    correctionStability: 0,
    localizationReliability: 0
  };
}

function hashText(text: string): string {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(16);
}
