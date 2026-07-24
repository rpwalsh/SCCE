import type { CorrectionRuleRecord } from "./storage.js";
import type { CandidateSurface } from "./candidate.js";
import type { ClaimBasis, CognitiveProposal, PlannedClaim } from "./cognitive-planner.js";
import type { ConstructGraph, EvidenceId, EvidenceSpan, FieldState, Hasher, JsonValue, LanguageProfile, RequestedAuthority, SemanticEntailmentResult } from "./types.js";
import type { TurnRequirementField } from "./turn-requirements.js";
import type { ContinueDecision } from "./learning-loop.js";
import type {
  CaveatBinding,
  ConstructNodeId,
  ConstructOutputForce,
  DetailProfileId,
  DiscourseBoundaryKind,
  DiscoursePlan,
  DiscourseUnit,
  DiscourseUnitRole,
  LanguageId,
  MeterPatternId,
  OutputForce,
  PropositionAtom,
  RealizationFrame,
  RegisterId,
  ScriptId,
  StyleProfile,
  StyleProfileId,
  SurfacePlan,
  SurfacePoint,
  SurfaceRole,
  SurfaceTerm
} from "./mouth-types.js";
import {
  explainSurfaceEnergy,
  rankBySurfaceEnergy,
  scoreSurfaceEnergy,
  type SurfaceEnergyCandidate,
  type SurfaceEnergyContext,
  type SurfaceOutputFeature,
  type SurfaceRevisionConstraint,
  type SurfaceTransformationBaseline
} from "./walsh-surface-energy.js";
import {
  semanticFrameSurfaces,
  type LanguageGenerationResult,
  type LanguageMemoryRuntime,
  type LanguageMemoryRuntimeState,
  type LanguageMemoryScore
} from "./language-memory-runtime.js";
import {
  englishCreativeStructuralRouteEvents,
  isEnglishCreativeEventStructurallyRealizable,
  MAX_ENGLISH_STRUCTURAL_CREATIVE_EVENTS,
  realizeEnglishStructuralCreative,
  type EnglishStructuralPlannedEvent,
  type EnglishStructuralRequestRoleBinding,
  type LearnedResponseExtentHint,
  type NarrativeBridgeRelationId
} from "./english-structural-realizer.js";
import type { CorrectionMemory, CorrectionStyleInfluence, MeterPattern, RegisterVector } from "./correction-memory.js";
import { detectCannedAnswerSpeech } from "./surface-quality.js";
import {
  boundaryFormsForKind,
  boundaryProfileFor,
  DETAIL_PROFILE_IDS,
  detailPolicyForProfile,
  isInlineBoundary,
  isTerminalBoundary,
  resolveDetailProfileId,
  type BoundaryProfile,
  type ConstructForceInferenceResult,
  type DetailProfilePolicy
} from "./control-plane-profiles.js";
import { canonicalStringify, clamp01, featureSet, mean, toJsonValue, weightedJaccard } from "./primitives.js";
import { containsUnresolvedSurfaceKey } from "./localization.js";
import { ensureSurfaceSentence as ensureUnicodeSurfaceSentence, hasUncasedNonLatinLetter, hasUppercaseLetter, isSentenceBoundarySymbol, splitSurfaceSentences as splitUnicodeSurfaceSentences } from "./surface-linguistics.js";
import { CALIBRATION_TASK_CLASS_IDS, type CalibrationModelSet } from "./calibration-spine.js";
import {
  realizeLearnedSurface,
  type LearnedConstruction,
  type LearnedRealization,
  type SurfaceMeaningPlan
} from "./language-construction.js";
import {
  languageConstructionOccurrenceId,
  languageConstructionRoleId,
  type DurableLanguageConstructionBundle
} from "./language-construction-memory.js";
import { learnedScriptIdForCharacter, rankLanguageProfilesForSurface } from "./language.js";

const LOCAL_ANSWER_RELATION_IDS = {
  sourceQuote: "rel.1f7c4a92",
  polarityReject: "rel.8d64be21",
  temporalCounterexample: "rel.7f1c2a90"
} as const;

export type {
  CaveatBinding,
  ConstructNodeId,
  ConstructOutputForce,
  DetailProfileId,
  DiscourseBoundaryKind,
  DiscoursePlan,
  DiscourseUnit,
  DiscourseUnitRole,
  EvidenceBinding,
  ForceBinding,
  LanguageId,
  MeterPatternId,
  OutputForce,
  PropositionAtom,
  RealizationFrame,
  RealizationOrdering,
  RegisterId,
  ScriptId,
  StyleProfile,
  StyleProfileId,
  SurfaceFormId,
  SurfacePlan,
  SurfacePoint,
  SurfaceRole,
  SurfaceTerm
} from "./mouth-types.js";

type DetailPolicy = DetailProfilePolicy;

interface ImportedSurfacePiece {
  id: string;
  kind: "suggestion" | "language_unit" | "phrase_pattern" | "semantic_frame" | "observation";
  text: string;
  support: number;
}

type ForceAwareAnswerPolicyId =
  | "certified_fact"
  | "source_bound"
  | "import_bound"
  | "learned_prior_summary"
  | "inference"
  | "conjecture"
  | "creative"
  | "translation"
  | "conversation";

interface ForceAwareAnswerPolicy {
  policyId: ForceAwareAnswerPolicyId;
  boundaryId?: ForceAwareAnswerPolicyId;
  reasonId: string;
  allowsExternalFactCertification: boolean;
}

interface ForceAwareSurface {
  policy: ForceAwareAnswerPolicy;
  text: string;
  force: OutputForce;
  caveat?: string;
  support: number;
  requiresLanguageGeneration?: boolean;
  trace: JsonValue;
}

interface SemanticAnswerFact {
  subject: string;
  predicate: string;
  object: string;
  sourceNodeId: string;
  targetNodeId: string;
  relationId: string;
  forceClass: string;
  score: number;
  activation: number;
  overlap: number;
  support: number;
  sourceVersionId?: string;
  evidenceIds?: string[];
  roleId?: string;
  alphaRhetoricalCentrality?: number;
  pathScore?: number;
  roleScore?: number;
  bridgeValue?: number;
  backgroundPenalty?: number;
  forceMeaning?: number;
  certificationPower?: number;
  semanticQuality?: number;
  graphQualityClassId?: string;
  answerGrade?: boolean;
  cognitiveEdgeId?: string;
  requestedSlotId?: string;
  relationRoleId?: string;
  topicSenseId?: string;
  finalQuestionFit?: number;
  questionSlotId?: string;
  questionSlotImportance?: string;
  questionSlotScore?: number;
  questionSlotReasonIds?: string[];
}

interface SemanticAnswerSlot {
  id: string;
  relationIds: string[];
  factKeys: string[];
  support: number;
  activation: number;
}

interface SemanticAnswerConstructState {
  schema: "scce.semantic_answer_construct.v1";
  questionShapeId: string;
  selectedSubject: string;
  selectedFacts: SemanticAnswerFact[];
  answerSlots: SemanticAnswerSlot[];
  selectedRelations: string[];
  activatedNeighborhood: SemanticAnswerFact[];
  rejectedCandidates: Array<{ relationId: string; sourceNodeId: string; targetNodeId: string; reasonId: string; score: number }>;
  supportIds: string[];
  forceId: string;
  boundaryId: string;
  activeBrainVersion: string;
  activeImportRunIds: string[];
  alphaRhetoricalPlan?: JsonValue;
  cognitiveFabric?: JsonValue;
  questionSlotPlan?: JsonValue;
  certificationBoundary: {
    directEvidenceCount: number;
    evidenceSpanIds: string[];
    sourceVersionIds: string[];
    externalFactCertification: boolean;
  };
}

interface InsufficientSupportConstructState {
  schema: "scce.insufficient_support_construct.v1";
  questionShapeId: string;
  selectedMainSubject: string;
  requestedFocuses: string[];
  closestSubjectCandidates: string[];
  relevanceGate: JsonValue;
  explanatoryAnswerContract: JsonValue;
  activeBrainVersion: string;
  activeImportRunIds: string[];
  certificationBoundary: {
    directEvidenceCount: number;
    externalFactCertification: boolean;
  };
}

type SurfaceCandidatePath = "generated";

interface SurfaceCandidate {
  id: string;
  style: string;
  path: SurfaceCandidatePath;
  claimBasis?: ClaimBasis;
  text: string;
  evidenceIds: EvidenceId[];
  fit: number;
  importedPieceIds: string[];
  generation?: LanguageGenerationResult;
  discoursePlan?: DiscoursePlan;
  sentenceCandidates?: SentenceCandidate[];
  boundaryDecisions?: DiscourseAssembly["boundaryDecisions"];
  exactSurface?: boolean;
  audit?: JsonValue;
}

interface StructuralCreativeSelectionBinding {
  semanticCandidateId: string;
  cognitiveProposalId?: string;
  invention: InventionConstructState;
  semanticPlanId: string;
  sourceBundleIds: string[];
  events: StructuralCreativeEventSelector[];
}

interface StructuralCreativeEventSelector {
  outputIndex: number;
  bundleId: string;
  eventId: string;
  profileId: string;
  constructionId: string;
  relationId: string;
  roleIds: string[];
  discourseRelationId: NarrativeBridgeRelationId;
  discourseBridgeBasisId:
    | "scce.discourse.bridge.source_adjacency"
    | "scce.discourse.bridge.invented_macro";
  discourseBeatId: string;
  requestRoleBindings: EnglishStructuralRequestRoleBinding[];
  compatibilityModelId: string;
  compatibilityModelVersion: string;
  compatibilityCalibrationId: string;
  compatibilityThreshold: number;
  requestFit: number;
  graphFit: number;
  routeFit: number;
  routeId: string;
  routeAnchorEventId: string;
  sourceOrdinal: number;
  sourceVersionId: string;
  evidenceId: string;
}

type HydratedStructuralCreativeEvent = EnglishStructuralPlannedEvent & Pick<
  StructuralCreativeEventSelector,
  | "discourseBridgeBasisId"
  | "discourseBeatId"
  | "graphFit"
  | "requestRoleBindings"
  | "routeFit"
  | "routeId"
  | "routeAnchorEventId"
  | "sourceOrdinal"
>;

interface SentenceCandidate {
  unitId: string;
  role: DiscourseUnitRole;
  text: string;
  generation: LanguageGenerationResult;
  coveredRequiredTerms: string[];
  coveredPropositionAtoms: string[];
  importedPriorIds: string[];
  orderUsage: LanguageGenerationResult["orderUsage"];
  preservationScore: number;
  stopReason: LanguageGenerationResult["stoppedBy"];
}

interface DiscourseAssembly {
  text: string;
  boundaryDecisions: Array<{ fromUnitId: string; toUnitId: string; kind: DiscourseBoundaryKind; text: string; source: string; boundarySource: BoundaryProfile["boundarySource"]; repeatedBoundaryPenalty: number }>;
}

interface SurfaceRepairResult {
  text: string;
  changed: boolean;
  audit: JsonValue;
}

const DEFAULT_FACTUAL_SURFACE_EXTENT = 560;
const MINIMUM_REPEATED_TOKEN_SPAN = 8;

export interface UncertaintyMarker {
  pointId: string;
  reason: string;
  severity: "low" | "medium" | "high";
}

export interface InspectRef {
  kind: "proof" | "construct" | "emission" | "surface" | "correction" | "language-memory";
  id: string;
}

export interface RealizationTrace {
  planHash: string;
  surfacePlan: JsonValue;
  discoursePlan: JsonValue;
  realizationFrames: JsonValue;
  candidates: Array<{ id: string; style: string; path: SurfaceCandidatePath; textHash: string; score: number; changedByCorrections: number; preservation: number; forbiddenHits: number; importedPieceIds: string[]; semanticCandidateId?: string; semanticPlanId?: string; surfaceRealizationId?: string; audit?: JsonValue }>;
  selected: { id: string; path: SurfaceCandidatePath; textHash: string; languageActivation: number; semanticPreservation: number; semanticCandidateId?: string; semanticPlanId?: string; surfaceRealizationId?: string };
  languageMemory: JsonValue;
  brainInfluence: JsonValue;
  corrections: JsonValue;
  preservation: JsonValue;
  surfaceRepair: JsonValue;
  walshSurfaceEnergy: JsonValue;
}

export interface MouthSemanticSlot {
  id: string;
  roleId: string;
  value: JsonValue;
  evidenceIds?: EvidenceId[];
  sourceId?: string;
}

export interface MouthSemanticRelation {
  id: string;
  relationId: string;
  sourceSlotId: string;
  targetSlotId: string;
  evidenceIds?: EvidenceId[];
}

export interface MouthSemanticInput {
  schema: "scce.mouth.semantic_input.v1";
  authority: RequestedAuthority;
  slots: MouthSemanticSlot[];
  relations?: MouthSemanticRelation[];
}

export interface SpeakInput {
  construct: ConstructGraph;
  field: FieldState;
  requirementField?: TurnRequirementField;
  selectedProposal?: CognitiveProposal;
  claimBases?: readonly PlannedClaim[];
  requiredOutputFeatures?: readonly SurfaceOutputFeature[];
  prohibitedOutputFeatures?: readonly SurfaceOutputFeature[];
  revisionConstraints?: readonly SurfaceRevisionConstraint[];
  languageProfile: LanguageProfile;
  evidence: EvidenceSpan[];
  entailment: SemanticEntailmentResult;
  languageMemory: LanguageMemoryRuntimeState;
  answerDraft?: string;
  targetLanguage?: LanguageId;
  targetScript?: ScriptId;
  style?: StyleProfile;
  styleProfileId?: StyleProfileId;
  registerId?: RegisterId;
  registerVector?: RegisterVector;
  meterPattern?: MeterPattern;
  meterPatternId?: MeterPatternId;
  maxLength?: number;
  detailProfileId?: DetailProfileId;
  correctionRules?: CorrectionRuleRecord[];
  brainMarker?: JsonValue;
  learningDecision?: ContinueDecision;
  selectedCandidate?: CandidateSurface;
  calibrationModels?: CalibrationModelSet;
  calibrationTaskClass?: string;
  requestedAuthority?: RequestedAuthority;
  semanticInput?: MouthSemanticInput;
}

export interface SpokenOutput {
  text: string;
  language: LanguageId;
  force: OutputForce;
  evidenceRefs: EvidenceId[];
  uncertainty: UncertaintyMarker[];
  inspectRefs: InspectRef[];
  realizationTrace: RealizationTrace;
  surfacePlan: SurfacePlan;
}

export interface Mouth {
  speak(input: SpeakInput): Promise<SpokenOutput>;
}

interface MouthGenerationWorkBudget {
  readonly startedAtMs: number;
  readonly deadlineAtMs: number;
  readonly maxExtent: number;
  remainingCalls: number;
  admittedCalls: number;
  deniedCalls: number;
}

const MOUTH_GENERATION_CALL_LIMIT = 1;
const MOUTH_GENERATION_EXTENT_LIMIT = 48;
const MOUTH_GENERATION_WINDOW_MS = 2_500;

function createMouthGenerationWorkBudget(startedAtMs: number): MouthGenerationWorkBudget {
  return {
    startedAtMs,
    deadlineAtMs: startedAtMs + MOUTH_GENERATION_WINDOW_MS,
    maxExtent: MOUTH_GENERATION_EXTENT_LIMIT,
    remainingCalls: MOUTH_GENERATION_CALL_LIMIT,
    admittedCalls: 0,
    deniedCalls: 0
  };
}

function claimMouthGenerationWork(budget: MouthGenerationWorkBudget, requestedExtent: number): number | undefined {
  if (budget.remainingCalls <= 0 || Date.now() >= budget.deadlineAtMs) {
    budget.deniedCalls += 1;
    return undefined;
  }
  budget.remainingCalls -= 1;
  budget.admittedCalls += 1;
  return Math.max(1, Math.min(budget.maxExtent, Math.floor(requestedExtent)));
}

export function createMouth(options: { languageMemory: LanguageMemoryRuntime; correctionMemory: CorrectionMemory; hashText: (text: string) => string; hasher?: Hasher }): Mouth {
  const constructionHasher: Hasher = options.hasher ?? { digestHex: options.hashText };
  return {
    async speak(input) {
      if (input.selectedCandidate && kernelCandidateCarriesTerminalRuntimeMotionSurface(input.selectedCandidate)) {
        return createDeterministicMouth({ hashText: options.hashText }).speak(input);
      }
      const mouthStartedAt = Date.now();
      const generationWorkBudget = createMouthGenerationWorkBudget(mouthStartedAt);
      let mouthPhaseStartedAt = mouthStartedAt;
      const mouthPhaseMs: Record<string, number> = {};
      const markMouthPhase = (id: string) => {
        const now = Date.now();
        mouthPhaseMs[id] = now - mouthPhaseStartedAt;
        mouthPhaseStartedAt = now;
      };
      const correctionInfluence = options.correctionMemory.styleFromRules({
        rules: input.correctionRules ?? [],
        context: { targetLanguageId: input.targetLanguage, targetScriptId: input.targetScript, registerVector: input.registerVector, meterPattern: input.meterPattern, surfaceKind: input.construct.program ? "program" : "answer" }
      });
      markMouthPhase("correction_influence");
      const structuralCreativeProductionLane = input.requestedAuthority === "creative";
      const structuralCreativeSelection = selectedStructuralCreativePlan(input);
      const nonEventCreativeMouthHandoff = selectedNonEventCreativeMouthHandoff(input);
      const structuralCreativePreflight = structuralCreativeProductionLane
        && Boolean(structuralCreativeSelection)
        && hasHydratedStructuralCreativePrior(
          input.languageMemory,
          input.languageProfile,
          structuralCreativeSelection
        );
      const basePriorPieces = structuralCreativePreflight
        ? []
        : importedSurfacePieces(input, undefined, undefined);
      markMouthPhase("base_prior_pieces");
      const rawPlan = buildSurfacePlan(input, correctionInfluence, options.hashText, basePriorPieces);
      markMouthPhase("surface_plan");
      const plan = applySurfacePlanCorrections(rawPlan, input.correctionRules ?? [], correctionInfluence, options.hashText);
      markMouthPhase("surface_plan_corrections");
      const discoursePlan = buildDiscoursePlan(plan, options.hashText);
      markMouthPhase("discourse_plan");
      const structuralCreativeCandidate = structuralCreativePreflight && structuralCreativeSelection
        ? sourceStructuralCreativeCandidate(plan, discoursePlan, input, structuralCreativeSelection)
        : undefined;
      markMouthPhase("structural_creative_realization");
      const structuralCreativeBound = Boolean(structuralCreativeCandidate);
      const structuralCreativeFailClosed = false;
      markMouthPhase("structural_admission");
      const priorPieces = structuralCreativeBound
        ? basePriorPieces
        : importedSurfacePieces(input, plan, options.languageMemory, basePriorPieces);
      const kernelSelectedCandidate = structuralCreativeBound || nonEventCreativeMouthHandoff
        ? undefined
        : input.selectedCandidate ? surfaceCandidateFromKernelCandidate(input.selectedCandidate, discoursePlan, input) : undefined;
      const governedActionPreview = structuralCreativeBound ? undefined : governedActionPreviewCandidate(input, discoursePlan);
      const semanticSourceCandidate = structuralCreativeBound ? undefined : semanticSourceAnswerCandidate(input, discoursePlan);
      const learnedConstructionCandidate = structuralCreativeBound
        ? undefined
        : semanticLearnedConstructionCandidate(input, plan, discoursePlan, constructionHasher);
      const constructAnchored = structuralCreativeBound || nonEventCreativeMouthHandoff
        ? undefined
        : constructAnchoredCandidate(plan, discoursePlan, input, priorPieces);
      const preserveEvidenceBackedKernelCandidate = Boolean(
        kernelSelectedCandidate &&
        input.requestedAuthority !== "creative" &&
        input.selectedCandidate &&
        (kernelCandidateCarriesVerifiedSourceExcerptSurface(input.selectedCandidate, input)
          || (
            !semanticAnswerConstructState(input.construct)
            && (input.selectedCandidate.kind === "proof-answer"
              || kernelCandidateCarriesExactBoundSourceSurface(input.selectedCandidate, input))
          )) &&
        input.selectedCandidate.evidenceIds.length > 0 &&
        kernelCandidateCanPreempt(input, kernelSelectedCandidate)
      );
      const generatedCandidates = structuralCreativeCandidate
        ? [structuralCreativeCandidate]
        : structuralCreativeFailClosed || preserveEvidenceBackedKernelCandidate
          ? []
          : generatedCandidatesFromFrames(plan, discoursePlan, input, options.languageMemory, priorPieces, generationWorkBudget);
      markMouthPhase("candidate_setup");
      const creativeRequested = isCreativeRequested(input, plan);
      const supportBoundary = creativeRequested ? undefined : supportBoundaryCandidate(input, discoursePlan, options.languageMemory, generationWorkBudget);
      const rawCandidates = [
        ...(kernelSelectedCandidate ? [kernelSelectedCandidate] : []),
        ...(governedActionPreview ? [governedActionPreview] : []),
        ...(semanticSourceCandidate && semanticSourceCandidate.id !== kernelSelectedCandidate?.id ? [semanticSourceCandidate] : []),
        ...(learnedConstructionCandidate ? [learnedConstructionCandidate] : []),
        ...(constructAnchored ? [constructAnchored] : []),
        ...generatedCandidates.filter(candidate => candidate.id !== kernelSelectedCandidate?.id),
        ...(supportBoundary && supportBoundary.id !== kernelSelectedCandidate?.id ? [supportBoundary] : [])
      ].filter(candidate => admissibleMouthSurface(candidate.text));
      const scoredCandidates = rawCandidates.map(candidate => {
        const appliedCorrection = options.correctionMemory.applyText({ text: candidate.text, rules: input.correctionRules ?? [] });
        const structuralCandidateSurface = Boolean(structuralCreativeSelectionBindingFromSurface(candidate));
        const protectedCandidateSurface = candidate.exactSurface || structuralCandidateSurface;
        const corrected = protectedCandidateSurface
          ? { text: candidate.text, applied: appliedCorrection.applied }
          : appliedCorrection;
        const factualSurfaceControl = !protectedCandidateSurface && appliesFactualSurfaceControl(input, candidate, plan);
        const repetitionControlled = factualSurfaceControl
          ? preserveRequiredSurfaceValues(corrected.text, collapseRepeatedTokenSpans(corrected.text), plan)
          : corrected.text;
        const bounded = protectedCandidateSurface
          ? candidate.text
          : preserveSurfaceExtent(
            repetitionControlled,
            input.maxLength ?? (factualSurfaceControl ? DEFAULT_FACTUAL_SURFACE_EXTENT : undefined),
            plan
          );
        const preservation = semanticPreservation({ text: bounded, plan, entailment: input.entailment });
        const score = structuralCreativeSelectionBindingFromSurface(candidate)
          ? structuralCreativeLanguageScore(candidate, input)
          : options.languageMemory.score({ state: input.languageMemory, text: bounded, contextText: input.entailment.claim.text });
        const workspaceAnchoredCandidate = candidate.id === "candidate:generated:construct-anchored"
          && (isWorkspaceKernelSpeakInput(input) || input.requestedAuthority === "program");
        const governedActionCandidate = candidate.id === "candidate:generated:governed-action-preview";
        const proofBoundaryCandidate = candidate.id === "candidate:generated:proof-boundary";
        const semanticLearnedConstructionCandidate = candidate.id.startsWith("candidate:generated:learned-construction:");
        const exactConstraintHits = protectedCandidateSurface
          ? exactSurfaceConstraintHits(candidate.text, input, plan, appliedCorrection.applied)
          : [];
        const conversationMemoryCandidate = candidate.id === "candidate:generated:conversation-memory";
        const conversationContextCandidate = conversationMemoryCandidate && !candidate.generation;
        const creativeSurfaceCandidate = creativeRequested || candidate.claimBasis === "invented";
        const structuralCreativeCandidateBound = Boolean(
          structuralCreativeSelectionBindingFromSurface(candidate)
        );
        const forbiddenHits = creativeSurfaceCandidate
          ? uniqueStrings([
            ...forbiddenSurfaceHits(bounded, plan),
            ...(structuralCreativeCandidateBound ? [] : creativeSemanticDriftHits(bounded, input))
          ])
          : workspaceAnchoredCandidate || governedActionCandidate
          ? []
          : proofBoundaryCandidate
            ? uniqueStrings([
              ...forbiddenSurfaceHits(bounded, plan),
              ...semanticAnswerDriftHits(bounded, input, priorPieces),
              ...unanchoredImportedPriorHits(candidate, input)
            ])
          : semanticLearnedConstructionCandidate
            ? uniqueStrings([
              ...forbiddenSurfaceHits(bounded, plan),
              ...semanticAnswerDriftHits(bounded, input, priorPieces),
              ...exactConstraintHits
            ])
          : conversationMemoryCandidate
            ? uniqueStrings([
              ...forbiddenSurfaceHits(bounded, plan),
              ...(conversationContextCandidate ? [] : questionEchoHits(bounded, input.entailment.claim.text))
            ])
          : uniqueStrings([
            ...forbiddenSurfaceHits(bounded, plan),
            ...semanticAnswerDriftHits(bounded, input, priorPieces),
            ...questionEchoHits(bounded, input.entailment.claim.text),
            ...languagePriorLeakageHits(bounded, input, priorPieces),
            ...unanchoredImportedPriorHits(candidate, input)
          ]);
        const adjustedFit = forbiddenHits.length ? candidate.fit * 0.1 : candidate.fit;
        return { ...candidate, fit: adjustedFit, text: bounded, correction: corrected, preservation, score, forbiddenHits };
      });
      markMouthPhase("candidate_scoring");
      const energyContext = walshSurfaceEnergyContext(input, plan, discoursePlan, correctionInfluence, basePriorPieces);
      const energyRows = rankBySurfaceEnergy(scoredCandidates.map(candidate => surfaceEnergyCandidate(candidate, plan)), energyContext);
      markMouthPhase("candidate_energy");
      const byCandidateId = new Map(scoredCandidates.map(candidate => [candidate.id, candidate]));
      const validEnergyRows = energyRows.filter(row => row.result.valid);
      const correctedCandidates = energyRows.map(row => byCandidateId.get(row.candidate.id)).filter((candidate): candidate is typeof scoredCandidates[number] => Boolean(candidate));
      const selectedRow = validEnergyRows[0] ?? energyRows.find(row => !row.result.hardViolations.length);
      const selectedKernelCandidate = input.selectedCandidate ? scoredCandidates.find(candidate => candidate.id === input.selectedCandidate?.id) : undefined;
      const semanticAnswerState = creativeRequested ? undefined : semanticAnswerConstructState(input.construct);
      const semanticLearnedCandidate = semanticAnswerState
        ? scoredCandidates.find(candidate => (
          candidate.id.startsWith("candidate:generated:learned-construction:")
          && !candidate.forbiddenHits.length
          && selectedRow?.candidate.id === candidate.id
          && (!selectedKernelCandidate || candidate.fit >= selectedKernelCandidate.fit)
          && energyRows.some(row => row.candidate.id === candidate.id && row.result.valid)
        ))
        : undefined;
      const semanticRhetoricalCandidate = semanticAnswerState
        ? scoredCandidates.find(candidate => candidate.id === "candidate:generated:rhetorical-lattice" && !candidate.forbiddenHits.length)
        : undefined;
      const semanticTemporalCounterexampleCandidate = semanticAnswerState
        ? scoredCandidates.find(candidate => candidate.id === "candidate:generated:semantic-temporal-counterexample" && !candidate.forbiddenHits.length)
        : undefined;
      const semanticDirectEvidenceCandidate = semanticAnswerState
        ? scoredCandidates.find(candidate => candidate.id === "candidate:generated:semantic-direct-evidence" && !candidate.forbiddenHits.length)
        : undefined;
      const semanticGraphCandidate = semanticTemporalCounterexampleCandidate ?? semanticLearnedCandidate ?? semanticDirectEvidenceCandidate ?? semanticRhetoricalCandidate ?? (semanticAnswerState
        ? scoredCandidates.find(candidate => !candidate.forbiddenHits.length)
        : undefined);
      const structuredConstructCandidate = generatedConstructSurface(input.construct) && !creativeRequested
        ? scoredCandidates.find(candidate => !candidate.forbiddenHits.length)
        : undefined;
      const proofBoundarySelectedCandidate = plan.constructForces.some(force => force.id === "CreativeConstruct")
        ? undefined
        : scoredCandidates.find(candidate => candidate.id === "candidate:generated:proof-boundary" && !candidate.forbiddenHits.length);
      const workspaceDraftCandidate = isWorkspaceKernelSpeakInput(input) || input.requestedAuthority === "program"
        ? scoredCandidates.find(candidate => candidate.id === "candidate:generated:construct-anchored" && !candidate.forbiddenHits.some(hit => hit.includes("echo")))
        : undefined;
      const governedActionDraftCandidate = input.requestedAuthority === "action"
        ? scoredCandidates.find(candidate => candidate.id === "candidate:generated:governed-action-preview")
        : undefined;
      const energySelected = selectedRow ? byCandidateId.get(selectedRow.candidate.id) : undefined;
      const learnedCreativeCandidateAvailable = creativeRequested && scoredCandidates.some(candidate => candidate.id.startsWith("candidate:generated:creative:"));
      const learnedCreativeProposal = creativeRequested
        ? scoredCandidates.find(candidate => (
          candidate.id === "candidate:generated:creative:learned-proposal"
          && !candidate.forbiddenHits.length
          && energyRows.some(row => row.candidate.id === candidate.id && row.result.valid)
        ))
        : undefined;
      const realizedCreativeCandidate = creativeRequested
        ? energyRows
          .filter(row => row.result.valid && row.candidate.id.startsWith("candidate:generated:creative:"))
          .map(row => byCandidateId.get(row.candidate.id))
          .find((candidate): candidate is typeof scoredCandidates[number] => Boolean(candidate && !candidate.forbiddenHits.length))
        : undefined;
      const plannerSelectedCandidate = selectedKernelCandidate &&
        (!creativeRequested || !learnedCreativeCandidateAvailable) &&
        !selectedKernelCandidate.forbiddenHits.length &&
        kernelCandidateCanPreempt(input, selectedKernelCandidate)
        ? selectedKernelCandidate
        : undefined;
      const selected = plannerSelectedCandidate ??
        semanticGraphCandidate ??
        structuredConstructCandidate ??
        proofBoundarySelectedCandidate ??
        governedActionDraftCandidate ??
        workspaceDraftCandidate ??
        learnedCreativeProposal ??
        realizedCreativeCandidate ??
        (energySelected && !energySelected.forbiddenHits.length ? energySelected : undefined);
      const selectedEnergy = energyRows.find(row => row.candidate.id === selected?.id)?.result;
      markMouthPhase("candidate_selection");
      const selectedBoundSourceSurface = Boolean(
        selected &&
        input.selectedCandidate?.id === selected.id &&
        kernelCandidateCarriesExactBoundSourceSurface(input.selectedCandidate, input)
      );
      const finalEnergyContext = input.requirementField
        ? {
          ...energyContext,
          transformationBaseline: finalTransformationBaseline(selected?.text ?? "", input),
          minimumSemanticPreservation: selectedBoundSourceSurface
            ? 0
            : input.selectedProposal || input.requirementField.semanticPreservation >= 0.6
            ? preservationFloor(plan)
            : 0
        }
        : energyContext;
      const realization = {
        text: selected?.text ?? "",
        evidenceIds: selected?.evidenceIds.map(String) ?? [],
        score: selected?.score ?? options.languageMemory.score({ state: input.languageMemory, text: "", contextText: input.entailment.claim.text }),
        audit: toJsonValue({
          source: structuralCreativeFailClosed
            ? "surface.boundary.structural_realization_unavailable"
            : "mouth.generated-selection",
          discoursePlan: selected?.discoursePlan ? discoursePlanSummary(selected.discoursePlan) : null,
          boundaryDecisions: selected?.boundaryDecisions ?? [],
          generatedSentences: selected?.sentenceCandidates?.map(sentence => sentenceSummary(sentence, options.hashText)) ?? [],
          generation: selected?.generation?.audit ?? null,
          candidateAudit: selected?.audit ?? null,
          score: selected?.score.audit ?? null,
          importedNgramModelIdsUsed: uniqueStrings([...(selected?.sentenceCandidates?.flatMap(sentence => sentence.generation.importedNgramModelIdsUsed) ?? selected?.generation?.importedNgramModelIdsUsed ?? []), ...selectedImportedIds(selected, ["model:", "ngram:"])]),
          importedObservationIdsUsed: uniqueStrings([...(selected?.sentenceCandidates?.flatMap(sentence => sentence.generation.importedObservationIdsUsed) ?? selected?.generation?.importedObservationIdsUsed ?? []), ...selectedImportedIds(selected, ["obs:", "observation:"])]),
          importedLanguageUnitIdsUsed: uniqueStrings([...(selected?.sentenceCandidates?.flatMap(sentence => sentence.generation.importedLanguageUnitIdsUsed) ?? selected?.generation?.importedLanguageUnitIdsUsed ?? []), ...selectedImportedIds(selected, ["unit:"])]),
          importedPhrasePatternIdsUsed: uniqueStrings([...(selected?.sentenceCandidates?.flatMap(sentence => sentence.generation.importedPhrasePatternIdsUsed) ?? selected?.generation?.importedPhrasePatternIdsUsed ?? []), ...selectedImportedIds(selected, ["pattern:"])]),
          importedSemanticFrameIdsUsed: uniqueStrings([...(selected?.sentenceCandidates?.flatMap(sentence => sentence.generation.importedSemanticFrameIdsUsed) ?? selected?.generation?.importedSemanticFrameIdsUsed ?? []), ...selectedImportedIds(selected, ["frame:"])]),
        })
      };
      const selectedPreservation = selected?.preservation ?? semanticPreservation({ text: realization.text, plan, entailment: input.entailment });
      const exactSelectedSurface = selected?.exactSurface === true;
      const sourceStructuralCreativeSurface = Boolean(
        selected && structuralCreativeSelectionBindingFromSurface(selected)
      );
      const protectedSelectedSurface = exactSelectedSurface || sourceStructuralCreativeSurface;
      const preservationText = !protectedSelectedSurface && (selectedPreservation.score < preservationFloor(plan) || Boolean(selected?.forbiddenHits.length))
        ? repairPreservation({ text: realization.text, plan, preservation: selectedPreservation })
        : realization.text;
      const preservationChecked = preservationText === realization.text ? selectedPreservation : semanticPreservation({ text: preservationText, plan, entailment: input.entailment });
      const readabilityRepair: SurfaceRepairResult = exactSelectedSurface || sourceStructuralCreativeSurface
        ? {
          text: preservationText,
          changed: false,
          audit: toJsonValue({
            skipped: true,
            reasonId: exactSelectedSurface
              ? "surface.repair.exact_learned_construction"
              : "surface.repair.source_structural_invariants"
          })
        }
        : repairSurfaceReadability({ text: preservationText, plan, discoursePlan, preservation: preservationChecked });
      const repairedPreservation = readabilityRepair.changed ? semanticPreservation({ text: readabilityRepair.text, plan, entailment: input.entailment }) : preservationChecked;
      const finalText = protectedSelectedSurface
        ? realization.text
        : repairedPreservation.score < preservationFloor(plan) ? preservationText : readabilityRepair.text;
      const finalPreservation = finalText === preservationText ? preservationChecked : repairedPreservation;
      const caveatCheckedText = protectedSelectedSurface ? finalText : ensureRuntimeCaveats(finalText, plan);
      const artifactCleanedText = protectedSelectedSurface ? caveatCheckedText : stripInternalSurfaceArtifacts(tidySurface(caveatCheckedText));
      const repairedFinalSurfaceText = protectedSelectedSurface
        ? artifactCleanedText
        : repairSemanticAnswerFinalSurface(artifactCleanedText, input.construct);
      const finalFactualSurfaceControl = Boolean(selected && !protectedSelectedSurface && appliesFactualSurfaceControl(input, selected, plan));
      const finalSurfaceText = protectedSelectedSurface
        ? repairedFinalSurfaceText
        : preserveSurfaceExtent(
          repairedFinalSurfaceText,
          finalFactualSurfaceControl ? input.maxLength ?? DEFAULT_FACTUAL_SURFACE_EXTENT : undefined,
          plan
        );
      const finalSurfacePreservation = finalSurfaceText === finalText ? finalPreservation : semanticPreservation({ text: finalSurfaceText, plan, entailment: input.entailment });
      const protectedSurfaceText = protectedSelectedSurface ? finalSurfaceText : protectedImportSummarySurface(plan, finalSurfaceText);
      const protectedSurfacePreservation = protectedSurfaceText === finalSurfaceText ? finalSurfacePreservation : semanticPreservation({ text: protectedSurfaceText, plan, entailment: input.entailment });
      const evidenceRefs = outputEvidenceRefs(input, plan, selected?.evidenceIds);
      const formatProtectedSurfaceText = protectedSelectedSurface
        ? selected?.text
        : selected?.text ? finalFormattedSurface(selected.text, input, plan) : undefined;
      const unmarkedOutputSurfaceText = admissibleMouthSurface(formatProtectedSurfaceText ?? protectedSurfaceText)
        ? (formatProtectedSurfaceText ?? protectedSurfaceText)
        : "";
      const proofSurface = proofSurfaceMarker({ evidenceRefs, entailment: input.entailment });
      const preserveRequestedFormat = Boolean(formatProtectedSurfaceText);
      let outputSurfaceText = protectedSelectedSurface
        ? unmarkedOutputSurfaceText
        : applyProofSurfaceMarker(unmarkedOutputSurfaceText, proofSurface, { exposeMarker: Boolean(input.style?.exposeProofTerms), preserveFormatting: preserveRequestedFormat });
      let outputSurfacePreservation = outputSurfaceText === protectedSurfaceText ? protectedSurfacePreservation : semanticPreservation({ text: outputSurfaceText, plan, entailment: input.entailment });
      let emittedSurfaceEnergy = scoreSurfaceEnergy({
        id: selected?.id ?? "candidate:generated:emitted-surface",
        text: outputSurfaceText,
        force: plan.forceBindings[0]?.force ?? dominantForce(plan),
        evidenceIds: evidenceRefs.map(String),
        importedPieceIds: selected?.importedPieceIds ?? [],
        languageActivation: realization.score.activation,
        languageFit: realization.score.fit,
        semanticPreservation: outputSurfacePreservation.score,
        correctionAppliedCount: selected?.correction.applied.filter(item => item.changed).length ?? 0,
        forbiddenSurfaceHits: [],
        boundaryDecisions: selected?.boundaryDecisions ?? [],
        metadata: toJsonValue({ path: selected?.path ?? "generated", style: selected?.style ?? "surface.path.generated.emitted", emittedSurface: true, selectedCandidateId: selected?.id ?? null })
      }, finalEnergyContext);
      if (!emittedSurfaceEnergy.valid && selected?.text && !protectedSelectedSurface) {
        const conservativeFormatted = finalFormattedSurface(selected.text, input, plan);
        const conservativeUnmarked = conservativeFormatted ?? stripInternalSurfaceArtifacts(tidySurface(ensureRuntimeCaveats(selected.text, plan)));
        const conservativeText = applyProofSurfaceMarker(conservativeUnmarked, proofSurface, { exposeMarker: Boolean(input.style?.exposeProofTerms), preserveFormatting: Boolean(conservativeFormatted) });
        const conservativePreservation = semanticPreservation({ text: conservativeText, plan, entailment: input.entailment });
        const conservativeEnergy = scoreSurfaceEnergy({
          id: `${selected.id}:conservative-final`,
          text: conservativeText,
          force: plan.forceBindings[0]?.force ?? dominantForce(plan),
          evidenceIds: evidenceRefs.map(String),
          importedPieceIds: selected.importedPieceIds,
          languageActivation: realization.score.activation,
          languageFit: realization.score.fit,
          semanticPreservation: conservativePreservation.score,
          correctionAppliedCount: selected.correction.applied.filter(item => item.changed).length,
          forbiddenSurfaceHits: [],
          boundaryDecisions: selected.boundaryDecisions,
          metadata: toJsonValue({ path: selected.path, style: selected.style, emittedSurface: true, conservativeFinalRenderer: true, selectedCandidateId: selected.id })
        }, finalEnergyContext);
        if (conservativeEnergy.valid) {
          outputSurfaceText = conservativeText;
          outputSurfacePreservation = conservativePreservation;
          emittedSurfaceEnergy = conservativeEnergy;
        }
      }
      if (!emittedSurfaceEnergy.valid && outputSurfaceText) {
        const violations = emittedSurfaceEnergy.hardViolations
          .map(item => `${item.id}=${canonicalStringify(item.trace)}`)
          .join(", ");
        throw new Error(`final mouth surface failed hard validity gate${violations ? `: ${violations}` : ""}`);
      }
      markMouthPhase("final_surface");
      const selectedSurfaceEnergy = selectedEnergy?.valid ? selectedEnergy : emittedSurfaceEnergy;
      const selectedStructuralBinding = selected
        ? structuralCreativeSelectionBindingFromSurface(selected)
        : undefined;
      return {
        text: outputSurfaceText,
        language: plan.targetLanguage,
        force: dominantForce(plan),
        evidenceRefs,
        uncertainty: uncertaintyMarkers(plan, outputSurfacePreservation, input.construct),
        inspectRefs: [
          { kind: "proof", id: String(input.entailment.proof.id) },
          { kind: "construct", id: String(input.construct.id) },
          { kind: "surface", id: planHash(plan, options.hashText) },
          { kind: "language-memory", id: input.languageMemory.streamIds[0] ?? "language-memory" },
          ...(input.correctionRules ?? []).slice(0, 8).map(rule => ({ kind: "correction" as const, id: rule.id }))
        ],
        realizationTrace: {
          planHash: planHash(plan, options.hashText),
          surfacePlan: surfacePlanSummary(plan),
          discoursePlan: discoursePlanSummary(discoursePlan),
          realizationFrames: realizationFrameSummary(plan),
          candidates: correctedCandidates.map(candidate => {
            const binding = structuralCreativeSelectionBindingFromSurface(candidate);
            return {
              id: candidate.id,
              style: candidate.style,
              path: candidate.path,
              textHash: options.hashText(candidate.text),
              score: Number(candidate.score.activation.toFixed(6)),
              changedByCorrections: candidate.correction.applied.filter(item => item.changed).length,
              preservation: Number(candidate.preservation.score.toFixed(6)),
              forbiddenHits: candidate.forbiddenHits.length,
              forbiddenHitIds: candidate.forbiddenHits.slice(0, 8),
              importedPieceIds: candidate.importedPieceIds,
              semanticCandidateId: binding?.semanticCandidateId,
              semanticPlanId: binding?.semanticPlanId,
              surfaceRealizationId: binding?.surfaceRealizationId,
              audit: candidate.audit
            };
          }),
          selected: {
            id: selected?.id ?? (structuralCreativeFailClosed
              ? "surface.boundary.structural_realization_unavailable"
              : "language-memory-selected"),
            path: selected?.path ?? "generated",
            textHash: options.hashText(outputSurfaceText),
            languageActivation: realization.score.activation,
            semanticPreservation: outputSurfacePreservation.score,
            semanticCandidateId: selectedStructuralBinding?.semanticCandidateId,
            semanticPlanId: selectedStructuralBinding?.semanticPlanId,
            surfaceRealizationId: selectedStructuralBinding?.surfaceRealizationId,
            proofSurface
          },
          languageMemory: toJsonValue({
            realization: realization.audit,
            selectedGeneration: selected?.generation?.audit ?? null,
            structuralCreative: {
              selectionBound: Boolean(structuralCreativeSelection),
              preflightAdmitted: structuralCreativePreflight,
              realizationAdmitted: Boolean(structuralCreativeCandidate),
              failClosed: structuralCreativeFailClosed,
              unavailableReasonId: structuralCreativeFailClosed
                ? "surface.boundary.structural_realization_unavailable"
                : null,
              languageProfileId: input.languageProfile.id,
              scope: input.languageMemory.scope,
              hydratedBundleIds: input.languageMemory.importedConstructionBundles.map(bundle => bundle.id),
              selectedBundleIds: structuralCreativeSelection?.sourceBundleIds ?? [],
              selectedEventCount: structuralCreativeSelection?.events.length ?? 0
            },
            mouthPerformance: {
              phaseMs: mouthPhaseMs,
              measuredMs: Date.now() - mouthStartedAt,
              generationWorkBudget: {
                callLimit: MOUTH_GENERATION_CALL_LIMIT,
                extentLimit: generationWorkBudget.maxExtent,
                windowMs: MOUTH_GENERATION_WINDOW_MS,
                admittedCalls: generationWorkBudget.admittedCalls,
                deniedCalls: generationWorkBudget.deniedCalls,
                remainingCalls: generationWorkBudget.remainingCalls
              }
            }
          }),
          brainInfluence: toJsonValue({
            activeBrainVersion: jsonRecord(input.brainMarker).activeBrainVersion ?? null,
            activeImportRunIds: jsonRecord(input.brainMarker).activeImportRunIds ?? [],
            importedLanguagePriorCount: input.languageMemory.importedLanguagePriorCount,
            importedNgramModelIdsUsed: importedIdsFrom(realization.audit, "importedNgramModelIdsUsed"),
            importedObservationIdsUsed: importedIdsFrom(realization.audit, "importedObservationIdsUsed"),
            importedLanguageUnitIdsUsed: importedIdsFrom(realization.audit, "importedLanguageUnitIdsUsed"),
            importedPhrasePatternIdsUsed: importedIdsFrom(realization.audit, "importedPhrasePatternIdsUsed"),
            importedSemanticFrameIdsUsed: importedIdsFrom(realization.audit, "importedSemanticFrameIdsUsed"),
            generatedSurfacePieces: priorPieces.filter(piece => correctedCandidates.some(candidate => candidate.importedPieceIds.includes(piece.id))).map(piece => ({ id: piece.id, kind: piece.kind, textHash: options.hashText(piece.text), support: piece.support })).slice(0, 32)
          }),
          corrections: toJsonValue({
            influence: correctionInfluence.audit,
            plan: jsonRecord(plan.audit).correctionInfluence ?? null,
            rules: (input.correctionRules ?? []).slice(0, 24).map(rule => ({
              id: rule.id,
              kind: rule.ruleKind,
              scope: rule.scope,
              pattern: rule.pattern,
              replacement: rule.replacement ?? null,
              weight: rule.weight
            })),
            applied: correctedCandidates.flatMap(candidate => candidate.correction.applied).filter(item => item.changed).slice(0, 24)
          }),
          preservation: finalSurfacePreservation.audit,
          surfaceRepair: readabilityRepair.audit,
          walshSurfaceEnergy: toJsonValue({
            requirementContext: input.requirementField ? {
              confidence: input.requirementField.confidence,
              selectedProposalId: input.selectedProposal?.id ?? null,
              claimBases: (input.claimBases ?? input.selectedProposal?.claims ?? []).map(claim => ({ claimId: claim.id, basis: claim.basis, evidenceIds: claim.evidenceIds })),
              requiredOutputFeatureIds: (input.requiredOutputFeatures ?? input.requirementField.requiredFeatures).map(feature => feature.id),
              prohibitedOutputFeatureIds: (input.prohibitedOutputFeatures ?? input.requirementField.prohibitedFeatures).map(feature => feature.id),
              revisionConstraintIds: (input.revisionConstraints ?? []).map(constraint => constraint.defectId)
            } : null,
            selected: explainSurfaceEnergy(selectedSurfaceEnergy),
            selectedCandidate: selectedEnergy ? explainSurfaceEnergy(selectedEnergy) : null,
            emitted: explainSurfaceEnergy(emittedSurfaceEnergy),
            selectedScoreTrace: selectedSurfaceEnergy.scoreTrace,
            emittedScoreTrace: emittedSurfaceEnergy.scoreTrace,
            ranked: energyRows.slice(0, 12).map(row => ({
              rank: row.rank,
              candidateId: row.candidate.id,
              valid: row.result.valid,
              energy: row.result.energy,
              proofVerdictUsed: row.result.proofVerdictUsed ?? null,
              hardViolations: row.result.hardViolations.map(item => item.id),
              scoreTrace: row.result.scoreTrace,
              components: row.result.components.map(component => ({ id: component.id, raw: component.raw, contribution: component.contribution, polarity: component.polarity }))
            }))
          })
        },
        surfacePlan: plan
      };
    }
  };
}

/**
 * Deterministic evaluation realizer. It consumes the kernel-selected
 * candidate and the same proof-aware surface plan, but never reads or scores
 * language memory, imported surface pieces, or learned correction rules.
 */
export function createDeterministicMouth(options: { hashText: (text: string) => string }): Mouth {
  return {
    async speak(input) {
      const noLearnedInfluence: CorrectionStyleInfluence = {
        styleTags: [],
        preferredTerms: [],
        audit: toJsonValue({ source: "mouth.deterministic", learnedInfluence: false })
      };
      const plan = buildSurfacePlan({ ...input, correctionRules: [] }, noLearnedInfluence, options.hashText);
      const discoursePlan = buildDiscoursePlan(plan, options.hashText);
      const deterministicVerdict = proofGateVerdict(input.entailment);
      const terminalRuntimeMotionSelected = Boolean(input.selectedCandidate && kernelCandidateCarriesTerminalRuntimeMotionSurface(input.selectedCandidate));
      const deterministicSurfaces = terminalRuntimeMotionSelected
        ? [input.selectedCandidate?.answer ?? ""]
        : [
          input.selectedCandidate && kernelCandidateDirectSurfaceAllowed(input.selectedCandidate, input)
            ? input.selectedCandidate.answer
            : "",
          semanticSlotSurface(input.semanticInput?.slots[0]?.value ?? null),
          plan.orderedPoints.find(point => point.role === "answer" && point.proposition.trim())?.proposition ?? "",
          plan.orderedPoints.find(programOrArtifactSurfacePoint)?.proposition ?? "",
          deterministicVerdict
            ? boundarySurfaceFromRuntime(input.entailment, input.evidence, deterministicVerdict)
            : ""
        ];
      const selectedText = deterministicSurfaces.find(surface => admissibleMouthSurface(surface)) ?? "";
      const normalizedSelectedText = tidySurface(selectedText);
      const readableSelectedText = dominantConstructForce(plan.constructForces) === "ProgramConstruct"
        || hasStructuredSurfaceShape(normalizedSelectedText)
        ? normalizedSelectedText
        : repairSurfaceDelimiterBalance(normalizedSelectedText);
      const candidateText = preserveSurfaceExtent(readableSelectedText, input.maxLength, plan);
      const text = admissibleMouthSurface(candidateText) ? candidateText : "";
      const preservation = semanticPreservation({ text, plan, entailment: input.entailment });
      const evidenceRefs = outputEvidenceRefs(input, plan, input.selectedCandidate?.evidenceIds);
      const selectedId = text
        ? input.selectedCandidate?.id ?? "candidate:deterministic:surface-plan"
        : "candidate:deterministic:continuation-required";
      const textHash = options.hashText(text);
      const planId = planHash(plan, options.hashText);
      return {
        text,
        language: plan.targetLanguage,
        force: dominantForce(plan),
        evidenceRefs,
        uncertainty: uncertaintyMarkers(plan, preservation, input.construct),
        inspectRefs: [
          { kind: "proof", id: String(input.entailment.proof.id) },
          { kind: "construct", id: String(input.construct.id) },
          { kind: "surface", id: planId }
        ],
        realizationTrace: {
          planHash: planId,
          surfacePlan: surfacePlanSummary(plan),
          discoursePlan: discoursePlanSummary(discoursePlan),
          realizationFrames: realizationFrameSummary(plan),
          candidates: [{
            id: selectedId,
            style: "surface.style.deterministic",
            path: "generated",
            textHash,
            score: 1,
            changedByCorrections: 0,
            preservation: Number(preservation.score.toFixed(6)),
            forbiddenHits: 0,
            importedPieceIds: []
          }],
          selected: {
            id: selectedId,
            path: "generated",
            textHash,
            languageActivation: 0,
            semanticPreservation: Number(preservation.score.toFixed(6))
          },
          languageMemory: toJsonValue({ bypassed: true, reason: "deterministic-mouth" }),
          brainInfluence: toJsonValue({ importedSurfacePiecesUsed: 0 }),
          corrections: toJsonValue({ bypassed: true, applied: [] }),
          preservation: preservation.audit,
          surfaceRepair: toJsonValue({ changed: false, deterministic: true }),
          walshSurfaceEnergy: toJsonValue({ bypassed: true, deterministicCandidate: selectedId })
        },
        surfacePlan: plan
      };
    }
  };
}

function surfacePlanSummary(plan: SurfacePlan): JsonValue {
  const audit = jsonRecord(plan.audit);
  return toJsonValue({
    thesis: plan.thesis ?? null,
    pointCount: plan.orderedPoints.length,
    realizationFrames: plan.realizationFrames.length,
    evidenceBindings: plan.evidenceBindings.length,
    caveatBindings: plan.caveatBindings.length,
    requiredTerms: plan.requiredTerms.length,
    forbiddenSurfaces: plan.forbiddenSurfaces.length,
    constructForces: plan.constructForces,
    targetLanguage: plan.targetLanguage,
    targetScript: plan.targetScript ?? null,
    styleProfileId: plan.styleProfileId,
    detailProfileId: plan.detailProfileId,
    registerId: plan.registerId ?? null,
    meterPatternId: plan.meterPatternId ?? null,
    forceAwareAnswerPolicy: audit.forceAwareAnswerPolicy ?? null
  });
}

function realizationFrameSummary(plan: SurfacePlan): JsonValue {
  return toJsonValue(plan.realizationFrames.slice(0, 24).map(frame => ({
    id: frame.id,
    pointId: frame.pointId,
    role: frame.role,
    force: frame.force,
    constructForce: frame.constructForce,
    targetLanguage: frame.targetLanguage,
    targetScript: frame.targetScript ?? null,
    styleProfileId: frame.styleProfileId,
    detailProfileId: frame.detailProfileId,
    atomCount: frame.propositionAtoms.length,
    requiredTermCount: frame.requiredTerms.length,
    evidenceBinding: frame.evidenceBinding ? { evidenceId: frame.evidenceBinding.evidenceId, sourceVersionId: frame.evidenceBinding.sourceVersionId } : null,
    caveat: frame.caveat ? { reason: frame.caveat.reason, severity: frame.caveat.severity } : null,
    semanticFrameIds: frame.semanticFrameIds,
    ordering: frame.ordering,
    atoms: frame.propositionAtoms.slice(0, 8).map(atom => ({ id: atom.id, kind: atom.kind, source: atom.source, weight: atom.weight, textHash: hash32(atom.text).toString(16) })),
    requiredTerms: frame.requiredTerms.slice(0, 8).map(term => ({ id: term.id, source: term.source, weight: term.weight, textHash: hash32(term.text).toString(16) }))
  })));
}

function discoursePlanSummary(plan: DiscoursePlan): JsonValue {
  return toJsonValue({
    id: plan.id,
    maxSentenceCount: plan.maxSentenceCount,
    targetDetailProfileId: plan.targetDetailProfileId,
    targetStyleProfileId: plan.targetStyleProfileId,
    boundaryProfileId: plan.boundaryProfile.id,
    boundarySource: plan.boundaryProfile.boundarySource,
    unitCount: plan.units.length,
    units: plan.units.map(unit => ({
      id: unit.id,
      role: unit.role,
      frameIds: unit.frameIds,
      groupId: unit.groupId,
      sentenceIndex: unit.sentenceIndex,
      boundaryBefore: unit.boundaryBefore,
      caveatPlacement: unit.caveatPlacement ?? null,
      examplePlacement: unit.examplePlacement ?? null,
      conclusionPlacement: unit.conclusionPlacement ?? null,
      generationExtent: unit.generationExtent
    })),
    audit: plan.audit
  });
}

function sentenceSummary(sentence: SentenceCandidate, hashText: (text: string) => string): JsonValue {
  return toJsonValue({
    unitId: sentence.unitId,
    role: sentence.role,
    textHash: hashText(sentence.text),
    coveredRequiredTerms: sentence.coveredRequiredTerms,
    coveredPropositionAtoms: sentence.coveredPropositionAtoms,
    importedPriorIds: sentence.importedPriorIds,
    orderUsage: sentence.orderUsage,
    preservationScore: sentence.preservationScore,
    stopReason: sentence.stopReason
  });
}

function importedIdsFrom(value: JsonValue, key: string): string[] {
  const record = jsonRecord(value);
  const direct = record[key];
  if (Array.isArray(direct)) return direct.filter((item): item is string => typeof item === "string");
  const selected = jsonRecord(record.selectedScoreAudit);
  const nested = selected[key];
  return Array.isArray(nested) ? nested.filter((item): item is string => typeof item === "string") : [];
}

function selectedImportedIds(candidate: { importedPieceIds: string[] } | undefined, prefixes: readonly string[]): string[] {
  const ids = candidate?.importedPieceIds ?? [];
  return ids.filter(id => prefixes.some(prefix => id.startsWith(prefix)));
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

type ProofGateVerdict = "certified" | "insufficient_evidence" | "contradicted" | "unsupported_prior_only" | "source_bound_only" | "ambiguous";

function proofGateVerdict(entailment: SemanticEntailmentResult): ProofGateVerdict | undefined {
  const scores = jsonRecord(entailment.proof.scores);
  const gate = jsonRecord(scores.semanticProofEngine);
  const verdict = gate.verdict;
  if (typeof verdict === "string" && isProofGateVerdict(verdict)) return verdict;
  for (const boundary of entailment.boundaries ?? []) {
    const marker = String(boundary);
    const prefix = "semantic-proof-engine:";
    if (!marker.startsWith(prefix)) continue;
    const value = marker.slice(prefix.length);
    if (isProofGateVerdict(value)) return value;
  }
  return undefined;
}

function isProofGateVerdict(value: string): value is ProofGateVerdict {
  return value === "certified" ||
    value === "insufficient_evidence" ||
    value === "contradicted" ||
    value === "unsupported_prior_only" ||
    value === "source_bound_only" ||
    value === "ambiguous";
}

function proofGateAllowsFactualSurface(entailment: SemanticEntailmentResult): boolean {
  const verdict = proofGateVerdict(entailment);
  return verdict === undefined || verdict === "certified";
}

function proofSurfaceMarker(input: { evidenceRefs: readonly EvidenceId[]; entailment: SemanticEntailmentResult }): "proof" | "no_proof" {
  const verdict = proofGateVerdict(input.entailment);
  if (input.evidenceRefs.length > 0 && (verdict === undefined || verdict === "certified" || verdict === "source_bound_only" || verdict === "contradicted")) return "proof";
  return "no_proof";
}

function applyProofSurfaceMarker(text: string, marker: "proof" | "no_proof", options: { exposeMarker?: boolean; preserveFormatting?: boolean } = {}): string {
  void marker;
  void options.exposeMarker;
  const clean = options.preserveFormatting ? text.normalize("NFC").trim() : tidySurface(text);
  return clean;
}

function buildSurfacePlan(
  input: SpeakInput,
  correctionInfluence: CorrectionStyleInfluence,
  hashText: (text: string) => string,
  basePriorPieces?: readonly ImportedSurfacePiece[]
): SurfacePlan {
  const targetLanguage = correctionInfluence.targetLanguage ?? input.targetLanguage ?? languageIdFromProfile(input.languageProfile);
  const targetScript = correctionInfluence.scriptId ?? input.targetScript ?? input.languageProfile.scripts[0]?.script;
  const style = normalizeStyle(input.style, correctionInfluence);
  const styleProfileId = input.styleProfileId ?? styleProfileFrom(style, correctionInfluence);
  const registerVector = correctionInfluence.registerVector ?? input.registerVector;
  const registerId = input.registerId ?? registerIdFrom(registerVector);
  const meterPattern = correctionInfluence.meterPattern ?? input.meterPattern;
  const meterPatternId = input.meterPatternId ?? meterPattern?.id;
  const semanticAnswerConstruct = semanticAnswerConstructState(input.construct);
  const explicitDetailProfileId = input.detailProfileId ?? correctionInfluence.detailProfileId;
  const requirementDetailProfileId = explicitDetailProfileId ? undefined : detailProfileFromRequirementField(input.requirementField);
  let detailSelectionSource = explicitDetailProfileId
    ? "explicit"
    : requirementDetailProfileId
      ? "turn_requirement_field"
      : "style_register";
  let detailProfileId = resolveDetailProfileId({
    explicitProfileId: explicitDetailProfileId ?? requirementDetailProfileId,
    styleDensity: style.density,
    registerVector
  });
  if (!explicitDetailProfileId && !requirementDetailProfileId && semanticAnswerConstruct && semanticAnswerConstruct.selectedFacts.length >= 2) {
    detailProfileId = DETAIL_PROFILE_IDS[2]!;
    detailSelectionSource = "semantic_answer_extent";
  }
  const detailPolicy = detailPolicyForProfile(detailProfileId, registerVector);
  const boundaryProfile = boundaryProfileFor({ scriptId: targetScript, metadata: input.languageProfile.ngramProfile });
  const constructForceInference = inferConstructForces(input);
  const constructForces = constructForceInference.rows.map(row => ({ id: row.id, weight: row.weight, source: row.source }));
  const forceAwareSurface = forceAwareHydratedAnswerSurface(input);
  const forceAwarePolicy = forceAwareSurface?.policy ?? answerPolicyFor(input);
  const evidenceById = new Map(input.evidence.map(span => [String(span.id), span]));
  const points = surfacePoints(input, evidenceById, constructForces, detailPolicy, hashText, forceAwareSurface);
  const requiredTerms = requiredTermsFor(input, basePriorPieces);
  const evidenceBindings = points.flatMap(point =>
    point.evidenceIds.map(evidenceId => {
      const span = evidenceById.get(String(evidenceId));
      return {
        pointId: point.id,
        evidenceId,
        sourceVersionId: String(span?.sourceVersionId ?? ""),
        support: point.support
      };
    })
  );
  const forceBindings = points.map(point => ({ pointId: point.id, force: point.force, constructForce: dominantConstructForce(constructForces), support: point.support, contradiction: point.contradiction }));
  const caveatBindings = points.flatMap(point => point.caveat ? [{ pointId: point.id, reason: point.caveat, severity: point.force === "contradicted" ? "high" as const : point.force === "underdetermined" ? "medium" as const : "low" as const }] : []);
  const plan: SurfacePlan = {
    thesis: points.find(point => point.role === "answer")?.id,
    orderedPoints: points,
    realizationFrames: [],
    requiredTerms,
    forbiddenSurfaces: [],
    evidenceBindings,
    forceBindings,
    caveatBindings,
    constructForces,
    targetLanguage,
    targetScript,
    styleProfileId,
    style,
    registerId,
    registerVector,
    detailProfileId,
    boundaryProfile,
    meterPattern,
    meterPatternId,
    audit: toJsonValue({
      source: "mouth.surface-plan",
      requestedAuthority: input.requestedAuthority ?? null,
      targetLanguage,
      targetScript: targetScript ?? null,
      styleProfileId,
      registerId: registerId ?? null,
      detailProfileId,
      detailSelectionSource,
      detailRequirement: input.requirementField ? {
        brevityDetailBalance: input.requirementField.brevityDetailBalance,
        formatConstraintStrength: input.requirementField.formatConstraintStrength,
        inferentialDepth: input.requirementField.inferentialDepth,
        confidence: input.requirementField.confidence
      } : null,
      boundaryProfile: { id: boundaryProfile.id, scriptId: boundaryProfile.scriptId ?? null, boundarySource: boundaryProfile.boundarySource },
      meterPatternId: meterPatternId ?? null,
      detailPolicy: detailPolicy.audit,
      constructForces,
      constructForceInference: constructForceInference.audit,
      registerVector: registerVector ?? null,
      meterPattern: meterPattern ?? null,
      pointCount: points.length,
      requiredTerms: requiredTerms.slice(0, 24),
      evidenceBindings: evidenceBindings.length,
      caveatBindings: caveatBindings.length,
      forceAwareAnswerPolicy: forceAwarePolicy,
      hydratedImportSummary: forceAwareSurface ? jsonRecord(forceAwareSurface.trace) : null,
      semanticAnswer: semanticAnswerConstruct ? {
        forceId: semanticAnswerConstruct.forceId,
        boundaryId: semanticAnswerConstruct.boundaryId,
        factCount: semanticAnswerConstruct.selectedFacts.length,
        supportIds: semanticAnswerConstruct.supportIds,
        certificationBoundary: semanticAnswerConstruct.certificationBoundary
      } : null,
      field: {
        active: input.field.active.slice(0, 12),
        alpha: input.field.alphaTrace.alpha,
        contradictionMass: input.field.alphaTrace.contradictionMass
      }
    })
  };
  return { ...plan, realizationFrames: realizationFramesForPlan(plan, hashText) };
}

function detailProfileFromRequirementField(requirement: TurnRequirementField | undefined): DetailProfileId | undefined {
  if (!requirement) return undefined;
  const detail = clamp01(requirement.brevityDetailBalance);
  const sequence = Math.max(clamp01(requirement.formatConstraintStrength), clamp01(requirement.inferentialDepth) * 0.72);
  if (detail >= 0.58 && sequence >= 0.68) return DETAIL_PROFILE_IDS[3]!;
  if (detail >= 0.68) return DETAIL_PROFILE_IDS[2]!;
  if (detail <= 0.32) return DETAIL_PROFILE_IDS[0]!;
  return undefined;
}

function buildDiscoursePlan(plan: SurfacePlan, hashText: (text: string) => string): DiscoursePlan {
  const detailPolicy = detailPolicyForProfile(plan.detailProfileId, plan.registerVector);
  const maxSentenceCount = detailPolicy.maxSentenceCount;
  const orderedFrames = orderFramesForDiscourse(plan.realizationFrames, detailPolicy);
  const groupedSemanticAnswer = undefined as DiscourseUnit | undefined;
  const groupedFrameIds = new Set(groupedSemanticAnswer?.frameIds ?? []);
  const orderedItems = discourseItemsForFrames(orderedFrames.filter(frame => !groupedFrameIds.has(frame.id))).slice(0, Math.max(0, maxSentenceCount - (groupedSemanticAnswer ? 1 : 0)));
  const units: DiscourseUnit[] = [
    ...(groupedSemanticAnswer ? [groupedSemanticAnswer] : []),
    ...orderedItems.map((item, offset) => {
      const index = offset + (groupedSemanticAnswer ? 1 : 0);
      const frame = item.frame;
      const itemRole = item.role ?? frame.role;
      const role: DiscourseUnitRole = frame.role === "example" && frame.constructForce !== "CreativeConstruct" ? "artifact_summary" : frame.role;
      const unitRole = itemRole === "example" && frame.constructForce !== "CreativeConstruct" ? "artifact_summary" : itemRole;
      const unit: DiscourseUnit = {
        id: `disc:${hashText(`${plan.thesis ?? "surface"}:${frame.id}:${index}:${unitRole}`).slice(0, 16)}`,
        role: unitRole,
        frameIds: [frame.id],
        groupId: unitRole === "caveat" ? "discourse.group.caveat" : role === "artifact_summary" || role === "example" ? "discourse.group.example" : "discourse.group.answer",
        sentenceIndex: index,
        boundaryBefore: (index === 0 ? "none" : "sentence") as DiscourseBoundaryKind,
        caveatPlacement: unitRole === "caveat" ? "after_support" : undefined,
        examplePlacement: unitRole === "example" || unitRole === "artifact_summary" ? "after_support" : undefined,
        conclusionPlacement: unitRole === "conclusion" ? "final" : undefined,
        generationExtent: generationExtentForDiscourseUnit(frame, plan, detailPolicy),
        targetDetailProfileId: plan.detailProfileId,
        targetStyleProfileId: plan.styleProfileId,
        registerVector: plan.registerVector
      };
      return unit;
    })];
  return {
    id: `discourse:${hashText(JSON.stringify({ plan: planHash(plan, hashText), units: units.map(unit => [unit.role, unit.frameIds]) })).slice(0, 20)}`,
    units,
    maxSentenceCount,
    targetDetailProfileId: plan.detailProfileId,
    targetStyleProfileId: plan.styleProfileId,
    boundaryProfile: plan.boundaryProfile,
    registerVector: plan.registerVector,
    audit: toJsonValue({
      source: "mouth.discourse-plan",
      maxSentenceCount,
      targetDetailProfileId: plan.detailProfileId,
      targetStyleProfileId: plan.styleProfileId,
      boundaryProfileId: plan.boundaryProfile.id,
      boundarySource: plan.boundaryProfile.boundarySource,
      unitRoles: units.map(unit => unit.role),
      boundaryKinds: units.map(unit => unit.boundaryBefore)
    })
  };
}

function discourseItemsForFrames(frames: readonly RealizationFrame[]): Array<{ frame: RealizationFrame; role?: DiscourseUnitRole }> {
  const out: Array<{ frame: RealizationFrame; role?: DiscourseUnitRole }> = [];
  for (const frame of frames) {
    out.push({ frame });
    if (frame.caveat && frame.role !== "caveat") out.push({ frame, role: "caveat" });
  }
  return out;
}

function orderFramesForDiscourse(frames: readonly RealizationFrame[], detailPolicy: DetailPolicy): RealizationFrame[] {
  const answer = frames.find(frame => frame.role === "answer");
  const supports = frames.filter(frame => frame.role === "support").slice(0, detailPolicy.maxSupportPoints);
  const examples = frames.filter(frame => frame.role === "example").slice(0, detailPolicy.maxExamples);
  const instructions = frames.filter(frame => frame.role === "instruction").slice(0, detailPolicy.maxInstructions);
  const caveats = frames.filter(frame => frame.role === "caveat").slice(0, detailPolicy.maxCaveats);
  const conclusions = frames.filter(frame => frame.role === "conclusion").slice(0, 1);
  return uniqueFrames([...(answer ? [answer] : []), ...supports, ...examples, ...instructions, ...caveats, ...conclusions]);
}

function uniqueFrames(frames: readonly RealizationFrame[]): RealizationFrame[] {
  const seen = new Set<string>();
  const out: RealizationFrame[] = [];
  for (const frame of frames) {
    if (seen.has(frame.id)) continue;
    seen.add(frame.id);
    out.push(frame);
  }
  return out;
}

function generationExtentForDiscourseUnit(frame: RealizationFrame, plan: SurfacePlan, detailPolicy: DetailPolicy): number {
  void plan;
  const base = detailPolicy.baseSurfaceUnitTarget;
  const atomMass = Math.min(10, frame.propositionAtoms.length * 2);
  const supportMass = Math.round(detailPolicy.density * 8);
  return Math.max(8, Math.min(48, base + atomMass + supportMass));
}

function surfacePoints(input: SpeakInput, evidenceById: Map<string, EvidenceSpan>, constructForces: readonly SurfacePlan["constructForces"][number][], detailPolicy: DetailPolicy, hashText: (text: string) => string, forceAwareSurface?: ForceAwareSurface): SurfacePoint[] {
  const out: SurfacePoint[] = [];
  const support = clamp01(input.entailment.support);
  const contradiction = clamp01(input.entailment.contradiction);
  const constructForce = dominantConstructForce(constructForces);
  const learningSurface = learningSurfaceOverride(input.learningDecision);
  const semanticAnswer = semanticAnswerConstructState(input.construct);
  const invention = inventionConstructState(input.construct);
  const generatedSurface = generatedConstructSurface(input.construct);
  const runtimeSurface = forceAwareSurface;
  const certifiedProofGate = proofGateVerdict(input.entailment) === "certified";
  const nonCertifiedProofGate = Boolean(proofGateVerdict(input.entailment) && !certifiedProofGate);
  if (semanticAnswer && !invention) {
    out.push(...semanticAnswerSurfacePoints({ semanticAnswer, construct: input.construct, constructForce, hashText, detailPolicy }));
  } else {
    const answerText = runtimeSurface?.text ?? answerFromConstruct(input, constructForce);
    if (answerText) out.push({
      id: `surface:${hashText(`answer:${answerText}`).slice(0, 16)}`,
      constructNodeId: constructNodeForForce(input.construct, constructForce),
      proposition: answerText,
      force: runtimeSurface?.force ?? generatedSurface?.force ?? learningSurface?.force ?? outputForceFromConstruct(input.entailment, constructForce),
      evidenceIds: invention ? invention.basisEvidenceIds.filter(id => evidenceById.has(String(id))).slice(0, 8) : input.entailment.evidenceIds.slice(0, 5),
      caveat: runtimeSurface?.caveat ?? learningSurface?.caveat ?? generatedSurface?.caveat ?? caveatFor(input.entailment),
      role: "answer",
      support: runtimeSurface ? runtimeSurface.support : generatedSurface ? (invention ? generatedSurface.support : Math.min(support, generatedSurface.support)) : learningSurface ? Math.min(support, 0.44) : support,
      contradiction: learningSurface?.force === "contradicted" ? Math.max(contradiction, 0.72) : contradiction,
      realizationConstraints: toJsonValue({ constructForce, preserve: "claim-force", detailProfileId: detailPolicy.id, generatedConstruct: generatedSurface?.trace ?? null, forceAwareAnswerPolicy: runtimeSurface?.policy ?? null, forceAwareTrace: runtimeSurface?.trace ?? null, learningDecision: input.learningDecision ? { id: input.learningDecision.id, decisionKindId: input.learningDecision.decisionKindId, safeToAssert: input.learningDecision.safeToAssert } : null })
    });
    else if (!(input.semanticInput?.slots ?? []).some(slot => slot.roleId !== "mouth.role.semantic.frame" && admittedSemanticSlotSurface(input, slot.roleId, slot.value))) out.push({
      id: `surface:${hashText("answer:empty").slice(0, 16)}`,
      constructNodeId: constructNodeForForce(input.construct, constructForce),
      proposition: "",
      force: learningSurface?.force ?? outputForceFromConstruct(input.entailment, constructForce),
      evidenceIds: [],
      role: "answer",
      support,
      contradiction,
      realizationConstraints: toJsonValue({ constructForce, emptySurface: true })
    });
  }
  for (const [index, slot] of (invention ? [] : (input.semanticInput?.slots ?? [])).slice(0, 24).entries()) {
    if (slot.roleId === "mouth.role.semantic.frame") continue;
    const proposition = admittedSemanticSlotSurface(input, slot.roleId, slot.value);
    if (!proposition) continue;
    const evidenceIds = (slot.evidenceIds ?? []).filter(id => evidenceById.has(String(id))).slice(0, 8);
    out.push({
      id: `surface:${hashText(`semantic-slot:${slot.id}:${proposition}`).slice(0, 16)}`,
      proposition,
      force: outputForceFromConstruct(input.entailment, constructForce),
      evidenceIds,
      role: index === 0 && !out.some(point => point.role === "answer") ? "answer" : "support",
      support: Math.max(0.2, support),
      contradiction,
      realizationConstraints: toJsonValue({
        schema: input.semanticInput?.schema,
        authority: input.semanticInput?.authority,
        slotId: slot.id,
        roleId: slot.roleId,
        sourceId: slot.sourceId ?? null,
        relations: (input.semanticInput?.relations ?? []).filter(relation => relation.sourceSlotId === slot.id || relation.targetSlotId === slot.id)
      })
    });
  }
  for (const obligation of (invention ? [] : input.entailment.obligations).slice(0, detailPolicy.maxSupportPoints + detailPolicy.maxCaveats + 2)) {
    if (obligation.status !== "satisfied" && obligation.status !== "contradicted" && obligation.status !== "underdetermined") continue;
    if (certifiedProofGate && obligation.status === "underdetermined") continue;
    if (certifiedProofGate && obligation.status === "contradicted") continue;
    if (nonCertifiedProofGate && obligation.status !== "contradicted") continue;
    const proposition = obligationPointText(obligation.claimText, obligation.reason, obligation.status);
    if (!proposition || out.some(point => point.proposition === proposition)) continue;
    out.push({
      id: `surface:${hashText(`${obligation.id}:${proposition}`).slice(0, 16)}`,
      proposition,
      force: obligation.status === "contradicted" ? "contradicted" : obligation.status === "underdetermined" ? "underdetermined" : "entailed",
      evidenceIds: obligation.evidenceIds.slice(0, 5),
      caveat: obligation.status === "underdetermined" ? surfaceCaveatReason(obligation.reason) : undefined,
      role: obligation.status === "contradicted" ? "caveat" : "support",
      support: obligation.support,
      contradiction: obligation.contradiction,
      realizationConstraints: toJsonValue({ obligationId: obligation.id, obligationKind: obligation.kind, required: obligation.required })
    });
  }
  const licensedMissingCaveats = invention || input.entailment.evidenceIds.length === 0
    ? []
    : input.entailment.missing.filter(missing => jsonRecord(missing.audit).surfaceDispositionId === "surface.caveat.append");
  for (const missing of licensedMissingCaveats.slice(0, detailPolicy.maxCaveats)) {
    const caveat = surfaceCaveatReason(missing.reason);
    if (!caveat || out.some(point => point.caveat === caveat || point.proposition === caveat)) continue;
    out.push({
      id: `surface:${hashText(`missing:${missing.id}:${caveat}`).slice(0, 16)}`,
      proposition: caveat,
      force: "underdetermined",
      evidenceIds: missing.evidenceIds.filter(id => evidenceById.has(String(id))).slice(0, 5),
      caveat,
      role: "caveat",
      support: Math.max(0.2, support),
      contradiction,
      realizationConstraints: toJsonValue({ missingId: missing.id, obligationId: missing.obligationId, missingKind: missing.kind, required: missing.required })
    });
  }
  if (invention) {
    for (const claim of invention.claimBasis.slice(0, Math.max(2, detailPolicy.maxSupportPoints + 1))) {
      if (!claim.surface || out.some(point => point.proposition === claim.surface)) continue;
      const evidenceIds = claim.kind === "factual_premise" || claim.force === "observed"
        ? claim.evidenceIds.filter(id => invention.basisEvidenceIds.includes(id) && evidenceById.has(String(id))).slice(0, 5)
        : [];
      out.push({
        id: `surface:${hashText(`invention-claim:${claim.id}:${claim.surface}`).slice(0, 16)}`,
        constructNodeId: invention.nodeId,
        proposition: claim.surface,
        force: outputForceFromInventionClaim(claim.force),
        evidenceIds,
        role: claim.kind === "performance_prediction" ? "conclusion" : "support",
        support: claim.force === "observed" ? Math.max(0.3, generatedSurface?.support ?? 0.3) : Math.max(0.2, (generatedSurface?.support ?? 0.3) * 0.8),
        contradiction,
        realizationConstraints: toJsonValue({
          constructForce: "CreativeConstruct",
          inventionClaimBasis: claim,
          proofStatusId: invention.proofStatusId
        })
      });
    }
  }
  if (input.construct.program) {
    const programSurface = programSurfaceSummary(input.construct.program);
    out.push({
      id: `surface:${hashText(`program:${input.construct.program.id}`).slice(0, 16)}`,
      proposition: programPoint(programSurface),
      force: "bounded",
      evidenceIds: input.entailment.evidenceIds.slice(0, 5),
      role: "instruction",
      support: Math.max(0.42, support),
      contradiction,
      realizationConstraints: toJsonValue({ constructForce: "ProgramConstruct", artifactCount: input.construct.program.files.length, programSurface })
    });
  }
  for (const artifact of (invention ? [] : input.construct.artifacts).filter(item => !input.construct.program?.files.some(file => file.artifactId === item.artifactId)).slice(0, 4)) {
    const proposition = artifactPoint(artifact);
    out.push({
      id: `surface:${hashText(`artifact:${artifact.artifactId}:${artifact.path}`).slice(0, 16)}`,
      proposition,
      force: constructForce === "CreativeConstruct" ? "creative" : "bounded",
      evidenceIds: constructForce === "CreativeConstruct" && invention
        ? invention.basisEvidenceIds.filter(id => evidenceById.has(String(id))).slice(0, 5)
        : input.entailment.evidenceIds.slice(0, 3),
      role: constructForce === "CreativeConstruct" ? "example" : "support",
      support: Math.max(0.34, support),
      contradiction,
      realizationConstraints: toJsonValue({ constructForce, artifactId: artifact.artifactId, mediaType: artifact.mediaType, role: artifact.role })
    });
  }
  return out.slice(0, 12);
}

function semanticAnswerSurfacePoints(input: {
  semanticAnswer: SemanticAnswerConstructState;
  construct: ConstructGraph;
  constructForce: ConstructOutputForce;
  hashText: (text: string) => string;
  detailPolicy: DetailPolicy;
}): SurfacePoint[] {
  const facts = uniquePriorBoundFacts(input.semanticAnswer.selectedFacts).slice(0, Math.max(4, input.detailPolicy.maxSupportPoints + 2));
  const constructNodeId = constructNodeForForce(input.construct, input.constructForce);
  return facts.map((fact, index) => {
    const support = Math.max(0.22, Math.min(0.76, Math.max(fact.support, fact.activation, fact.overlap)));
    return {
      id: `surface:${input.hashText(`semantic-answer:${fact.relationId}:${semanticFactKey(fact)}`).slice(0, 16)}`,
      constructNodeId,
      proposition: semanticQuestionMeaningSlot(fact, index),
      force: "bounded" as const,
      role: index === 0 ? "answer" as const : "support" as const,
      support,
      contradiction: 0,
      evidenceIds: input.semanticAnswer.certificationBoundary.externalFactCertification
        ? (fact.evidenceIds ?? []).map(id => id as EvidenceId)
        : [],
      realizationConstraints: toJsonValue({
        constructForce: input.constructForce,
        preserve: "semantic-answer-slots",
        detailProfileId: input.detailPolicy.id,
        semanticAnswerFact: {
          subject: fact.subject,
          predicate: fact.predicate,
          object: fact.object,
          sourceNodeId: fact.sourceNodeId,
          targetNodeId: fact.targetNodeId,
          relationId: fact.relationId,
          forceClass: fact.forceClass,
          support: fact.support,
          activation: fact.activation,
          overlap: fact.overlap,
          score: fact.score,
          sourceVersionId: fact.sourceVersionId ?? null,
          roleId: fact.roleId ?? null,
          alphaRhetoricalCentrality: fact.alphaRhetoricalCentrality ?? null,
          pathScore: fact.pathScore ?? null,
          roleScore: fact.roleScore ?? null,
          bridgeValue: fact.bridgeValue ?? null,
          backgroundPenalty: fact.backgroundPenalty ?? null,
          forceMeaning: fact.forceMeaning ?? null,
          certificationPower: fact.certificationPower ?? null,
          semanticQuality: fact.semanticQuality ?? null,
          graphQualityClassId: fact.graphQualityClassId ?? null,
          answerGrade: fact.answerGrade ?? null,
          cognitiveEdgeId: fact.cognitiveEdgeId ?? null,
          requestedSlotId: fact.requestedSlotId ?? null,
          relationRoleId: fact.relationRoleId ?? null,
          topicSenseId: fact.topicSenseId ?? null,
          finalQuestionFit: fact.finalQuestionFit ?? null,
          questionSlotId: fact.questionSlotId ?? null,
          questionSlotImportance: fact.questionSlotImportance ?? null,
          questionSlotScore: fact.questionSlotScore ?? null,
          questionSlotReasonIds: fact.questionSlotReasonIds ?? []
        },
        semanticAnswer: {
          questionShapeId: input.semanticAnswer.questionShapeId,
          selectedSubject: input.semanticAnswer.selectedSubject,
          forceId: input.semanticAnswer.forceId,
          boundaryId: input.semanticAnswer.boundaryId,
          answerSlotIds: input.semanticAnswer.answerSlots.filter(slot => slot.factKeys.includes(semanticFactKey(fact))).map(slot => slot.id),
          selectedRelations: input.semanticAnswer.selectedRelations,
          supportIds: input.semanticAnswer.supportIds,
          alphaRhetoricalPlan: input.semanticAnswer.alphaRhetoricalPlan ?? null,
          cognitiveFabric: input.semanticAnswer.cognitiveFabric ?? null,
          questionSlotPlan: input.semanticAnswer.questionSlotPlan ?? null,
          certificationBoundary: input.semanticAnswer.certificationBoundary
        }
      })
    };
  });
}

function semanticQuestionMeaningSlot(fact: SemanticAnswerFact, index: number): string {
  const slot = fact.questionSlotId || fact.requestedSlotId || fact.relationRoleId || fact.roleId || "semantic_fact";
  return `semantic.answer.meaning_slot.${index + 1}.${hash32(slot).toString(16)}`;
}

function realizationFramesForPlan(plan: SurfacePlan, hashText: (text: string) => string): RealizationFrame[] {
  const constructForce = dominantConstructForce(plan.constructForces);
  return plan.orderedPoints.map((point, index) => {
    const evidenceBinding = plan.evidenceBindings.find(binding => binding.pointId === point.id);
    const caveat = plan.caveatBindings.find(binding => binding.pointId === point.id);
    return {
      id: `frame:${hashText(`${point.id}:${index}:${point.force}`).slice(0, 16)}`,
      pointId: point.id,
      role: point.role,
      force: point.force,
      constructForce,
      propositionAtoms: propositionAtomsForPoint(point, plan.requiredTerms, hashText),
      requiredTerms: requiredTermsForPoint(point, plan.requiredTerms),
      forbiddenSurfaceIds: plan.forbiddenSurfaces,
      caveat,
      evidenceBinding,
      targetLanguage: plan.targetLanguage,
      targetScript: plan.targetScript,
      styleProfileId: plan.styleProfileId,
      registerVector: plan.registerVector,
      detailProfileId: plan.detailProfileId,
      semanticFrameIds: semanticFrameIdsFromPoint(point),
      ordering: {
        index,
        previousPointId: plan.orderedPoints[index - 1]?.id,
        nextPointId: plan.orderedPoints[index + 1]?.id,
        relation: "linear",
        weight: 1 / Math.max(1, index + 1)
      },
      realizationConstraints: point.realizationConstraints
    };
  });
}

function propositionAtomsForPoint(point: SurfacePoint, requiredTerms: readonly SurfaceTerm[], hashText: (text: string) => string): PropositionAtom[] {
  const atoms: PropositionAtom[] = [];
  const add = (text: string, kind: PropositionAtom["kind"], source: string, weight: number, evidenceIds: readonly EvidenceId[] = point.evidenceIds) => {
    const clean = normalizeEvidenceSentence(text);
    if (!clean) return;
    const id = `atom:${hashText(`${point.id}:${kind}:${clean}`).slice(0, 16)}`;
    if (!atoms.some(atom => atom.id === id || atom.text === clean)) atoms.push({ id, text: clean, kind, source, weight: clamp01(weight), evidenceIds: [...evidenceIds] });
  };
  const semanticFact = semanticFactFromRealizationConstraints(point.realizationConstraints);
  if (semanticFact) {
    add(semanticFact.subject, "surface", semanticFact.sourceNodeId, 0.94);
    add(semanticFact.predicate, "surface", semanticFact.relationId, 0.9);
    add(semanticFact.object, "surface", semanticFact.targetNodeId, 0.9);
  } else {
    const primaryKind: PropositionAtom["kind"] = point.role === "instruction" ? "program" : point.role === "example" ? "artifact" : "claim";
    add(point.proposition, primaryKind, point.constructNodeId ?? point.id, Math.max(0.2, point.support));
  }
  if (point.caveat) add(point.caveat, "caveat", point.id, Math.max(0.2, point.contradiction));
  for (const symbol of invariantSymbols(point.proposition).slice(0, 16)) add(symbol.text, symbol.kind === "number" ? "quantity" : symbol.kind, point.id, symbol.kind === "number" ? 0.96 : 0.72);
  for (const term of requiredTerms.filter(term => containsSurface(point.proposition, term.text)).slice(0, 16)) add(term.text, term.text === point.proposition ? "surface" : "claim", term.source, term.weight, point.evidenceIds);
  return atoms.slice(0, 32);
}

function semanticFactFromRealizationConstraints(value: JsonValue): SemanticAnswerFact | undefined {
  const fact = jsonRecord(jsonRecord(value).semanticAnswerFact);
  return semanticAnswerFactFromJson(fact);
}

function requiredTermsForPoint(point: SurfacePoint, terms: readonly SurfaceTerm[]): SurfaceTerm[] {
  const semanticFact = semanticFactFromRealizationConstraints(point.realizationConstraints);
  if (semanticFact) return [];
  const local = terms.filter(term => containsSurface(point.proposition, term.text));
  const global = terms.filter(term => term.weight >= 0.8);
  const importedSurface = terms.filter(term => term.source === "language-memory" && term.weight >= 0.18).slice(0, 4);
  const correctionSurface = terms.filter(term => term.source === "correction" && term.weight >= 0.18).slice(0, 4);
  const byId = new Map<string, SurfaceTerm>();
  for (const term of [...local, ...global, ...importedSurface, ...correctionSurface]) byId.set(term.id, term);
  return [...byId.values()].sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text)).slice(0, 24);
}

function semanticFrameIdsFromPoint(point: SurfacePoint): string[] {
  const constraints = jsonRecord(point.realizationConstraints);
  const direct = constraints.semanticFrameIds;
  return Array.isArray(direct) ? direct.filter((item): item is string => typeof item === "string") : [];
}

function surfaceCandidateFromKernelCandidate(candidate: CandidateSurface, discoursePlan: DiscoursePlan, input: SpeakInput): SurfaceCandidate | undefined {
  if (!kernelCandidateDirectSurfaceAllowed(candidate, input)) return undefined;
  if (!kernelCandidateSurfaceAdmissible(candidate, input)) return undefined;
  return {
    id: candidate.id,
    style: `surface.path.kernel_selected.${candidate.kind}`,
    path: "generated",
    claimBasis: candidate.claimBases?.includes("invented") ? "invented" : undefined,
    text: candidate.answer,
    evidenceIds: candidate.evidenceIds,
    fit: clamp01(
      0.24 * candidate.scores.support +
      0.2 * candidate.scores.faithfulness +
      0.18 * candidate.scores.alphaPressure +
      0.18 * candidate.scores.evidenceCoverage +
      0.12 * candidate.scores.realizability -
      0.24 * candidate.scores.contradiction
    ),
    importedPieceIds: [],
    discoursePlan,
    boundaryDecisions: [],
    exactSurface: kernelCandidateCarriesExactBoundSourceSurface(candidate, input)
      || kernelCandidateCarriesVerifiedSourceExcerptSurface(candidate, input)
  };
}

function kernelCandidateCanPreempt(input: SpeakInput, candidate: SurfaceCandidate): boolean {
  if (input.selectedCandidate?.id === candidate.id && kernelCandidateCarriesExactBoundSourceSurface(input.selectedCandidate, input)) return true;
  if (input.selectedCandidate?.id === candidate.id && kernelCandidateCarriesVerifiedSourceExcerptSurface(input.selectedCandidate, input)) return true;
  if (input.selectedCandidate?.id === candidate.id
    && candidate.evidenceIds.length > 0
    && input.selectedCandidate.boundaries.some(boundary => (
      boundary === "selected-evidence-bound"
      || boundary === "local-evidence-certification-boundary"
      || boundary === "source-bound"
    ))) return true;
  if (semanticAnswerConstructState(input.construct)) return false;
  if (generatedConstructSurface(input.construct)) return false;
  if (isWorkspaceKernelSpeakInput(input)) return false;
  if (candidate.evidenceIds.length > 0) return true;
  return candidate.fit >= 0.42;
}

function semanticSourceAnswerCandidate(input: SpeakInput, discoursePlan: DiscoursePlan): SurfaceCandidate | undefined {
  const slot = input.semanticInput?.slots.find(item => item.roleId === "mouth.role.source.answer");
  if (!slot || typeof slot.value !== "string" || !slot.evidenceIds?.length) return undefined;
  const evidenceIds = slot.evidenceIds.filter(id => input.evidence.some(span => span.id === id && span.status === "promoted"));
  if (!evidenceIds.length) return undefined;
  const text = tidySurface(slot.value);
  if (!admissibleMouthSurface(text)) return undefined;
  return {
    id: `candidate:generated:source-answer:${slot.id}`,
    style: "surface.path.generated.source_answer",
    path: "generated",
    text,
    evidenceIds,
    fit: 0.86,
    importedPieceIds: [],
    discoursePlan,
    boundaryDecisions: []
  };
}

interface LearnedConstructionCandidateRow {
  candidate: SurfaceCandidate;
  bundleId: string;
  constructionId: string;
}

function semanticLearnedConstructionCandidate(
  input: SpeakInput,
  plan: SurfacePlan,
  discoursePlan: DiscoursePlan,
  hasher: Hasher
): SurfaceCandidate | undefined {
  const state = semanticAnswerConstructState(input.construct);
  if (!state?.certificationBoundary.externalFactCertification) return undefined;
  if (state.forceId !== "output.force.source_bound_answer" || state.boundaryId !== "output.force.source_bound") return undefined;
  if (plan.targetLanguage !== input.languageProfile.id) return undefined;
  const certifiedEvidenceIds = new Set(state.certificationBoundary.evidenceSpanIds);
  if (!certifiedEvidenceIds.size) return undefined;
  const certifiedSourceVersionIds = new Set(state.certificationBoundary.sourceVersionIds);
  const rows: LearnedConstructionCandidateRow[] = [];
  const facts = uniquePriorBoundFacts(state.selectedFacts);
  if (facts.length !== 1 || state.selectedFacts.length !== 1) return undefined;
  const fact = facts[0]!;
  if (!completeLearnedFactCoverage(state, fact) || !learnedFactRouteAdmissible(fact)) return undefined;

  if (!exactFactSurface(fact.subject) || !exactFactSurface(fact.predicate) || !exactFactSurface(fact.object)) return undefined;
  const factEvidenceIds = new Set(fact.evidenceIds ?? []);
  if (!factEvidenceIds.size || !fact.sourceVersionId) return undefined;
  const proofEvidence = input.evidence
    .filter(span => span.status === "promoted"
      && jsonRecord(span.trustVector).forceClass === "direct_evidence"
      && certifiedEvidenceIds.has(String(span.id))
      && factEvidenceIds.has(String(span.id))
      && fact.sourceVersionId === String(span.sourceVersionId)
      && certifiedSourceVersionIds.has(String(span.sourceVersionId)))
    .sort((left, right) => compareSurfaceText(String(left.id), String(right.id)));
  if (!proofEvidence.length) return undefined;
  const routeAdmissibility = Math.max(...proofEvidence.map(span => learnedFactRouteAdmissibility(fact, span)));
  if (routeAdmissibility <= 0) return undefined;
  const proofEvidenceIds = proofEvidence.map(span => String(span.id));
  const bundles = input.languageMemory.importedConstructionBundles
    .filter(bundle => bundle.bindingId === fact.relationId
      && bundle.sourceProfileId === input.languageProfile.id
      && bundle.targetProfileId === input.languageProfile.id)
    .sort((left, right) => compareSurfaceText(left.id, right.id));

  for (const bundle of bundles) {
    for (const construction of bundle.constructions) {
      const candidate = learnedConstructionCandidateFromBundle({
        input,
        plan,
        discoursePlan,
        fact,
        bundle,
        construction,
        proofEvidenceIds,
        routeAdmissibility,
        hasher
      });
      if (candidate) rows.push({ candidate, bundleId: bundle.id, constructionId: construction.id });
    }
  }

  return rows.sort((left, right) => (
    right.candidate.fit - left.candidate.fit
    || compareSurfaceText(left.bundleId, right.bundleId)
    || compareSurfaceText(left.constructionId, right.constructionId)
    || compareSurfaceText(left.candidate.id, right.candidate.id)
  ))[0]?.candidate;
}

function learnedConstructionCandidateFromBundle(input: {
  input: SpeakInput;
  plan: SurfacePlan;
  discoursePlan: DiscoursePlan;
  fact: SemanticAnswerFact;
  bundle: DurableLanguageConstructionBundle;
  construction: LearnedConstruction;
  proofEvidenceIds: readonly string[];
  routeAdmissibility: number;
  hasher: Hasher;
}): SurfaceCandidate | undefined {
  if (input.construction.profileKey !== input.bundle.targetProfileId
    || !input.bundle.constructions.some(construction => construction.id === input.construction.id)) return undefined;
  const factSlots = [
    { slotIndex: 0, semanticId: input.fact.sourceNodeId, surface: input.fact.subject },
    { slotIndex: 1, semanticId: input.fact.relationId, surface: input.fact.predicate },
    { slotIndex: 2, semanticId: input.fact.targetNodeId, surface: input.fact.object }
  ];
  const slotByRoleId = new Map(factSlots.map(slot => [
    languageConstructionRoleId(input.hasher, input.bundle.bindingId, slot.slotIndex),
    slot
  ]));
  const occurrenceSlotIndexes = constructionOccurrenceSlotIndexes(input.bundle);
  if (!occurrenceSlotIndexes) return undefined;
  const formClasses = input.bundle.formClasses.filter(formClass => formClass.constructionId === input.construction.id);
  const formClassByOccurrence = new Map(formClasses.map(formClass => [formClass.occurrenceId, formClass.id]));
  const seenSlotIndexes = new Set<number>();
  const slots: Array<SurfaceMeaningPlan["slots"][number]> = [];
  for (const occurrence of input.construction.roleOccurrences) {
    if (occurrence.realization !== "spoken") return undefined;
    const slotIndex = occurrenceSlotIndexes.get(occurrence.occurrenceId);
    const factSlot = slotIndex === undefined ? undefined : slotByRoleId.get(occurrence.roleId);
    if (!factSlot || factSlot.slotIndex !== slotIndex || seenSlotIndexes.has(slotIndex)) return undefined;
    const expectedOccurrenceId = languageConstructionOccurrenceId(input.hasher, input.bundle.bindingId, slotIndex, 0);
    if (occurrence.occurrenceId !== expectedOccurrenceId) return undefined;
    const formClassId = formClassByOccurrence.get(occurrence.occurrenceId);
    if (!formClassId) return undefined;
    seenSlotIndexes.add(slotIndex);
    slots.push({
      roleId: occurrence.roleId,
      occurrenceId: occurrence.occurrenceId,
      variants: [{
        id: opaqueSurfaceId(input.hasher, "variant", [input.bundle.id, input.construction.id, input.fact.relationId, factSlot.semanticId, factSlot.surface]),
        profileKey: input.input.languageProfile.id,
        surface: factSlot.surface,
        evidenceIds: [...input.proofEvidenceIds],
        support: input.routeAdmissibility,
        formClassId
      }]
    });
  }
  if (seenSlotIndexes.size !== factSlots.length || factSlots.some(slot => !seenSlotIndexes.has(slot.slotIndex))) return undefined;
  const plan: SurfaceMeaningPlan = {
    id: opaqueSurfaceId(input.hasher, "plan", [
      input.bundle.id,
      input.construction.id,
      input.fact.sourceNodeId,
      input.fact.relationId,
      input.fact.targetNodeId,
      input.proofEvidenceIds
    ]),
    profileKey: input.input.languageProfile.id,
    roleSignature: factSlots.map(slot => languageConstructionRoleId(input.hasher, input.bundle.bindingId, slot.slotIndex)),
    slots
  };
  const realized = realizeLearnedSurface({
    plan,
    constructions: [input.construction],
    formClasses,
    hasher: input.hasher
  });
  if (realized.status !== "realized") return undefined;
  if (!realized.realization.trace
    .filter(part => part.kind === "literal")
    .every(part => [...part.surface].every(isUnboundStructuralPoint))) return undefined;
  if (!exactSurfaceSatisfiesPlan(realized.realization.text, input.input, input.plan)
    || !learnedProfileAcceptsSurface(input.input.languageProfile, realized.realization.text)) return undefined;
  return persistedLearnedSurfaceCandidate({
    input,
    realization: realized.realization,
    proofEvidenceIds: input.proofEvidenceIds,
    normalizedSupport: input.routeAdmissibility
  });
}

function persistedLearnedSurfaceCandidate(input: {
  input: {
    input: SpeakInput;
    plan: SurfacePlan;
    discoursePlan: DiscoursePlan;
    fact: SemanticAnswerFact;
    bundle: DurableLanguageConstructionBundle;
    construction: LearnedConstruction;
    proofEvidenceIds: readonly string[];
    routeAdmissibility: number;
    hasher: Hasher;
  };
  realization: LearnedRealization;
  proofEvidenceIds: readonly string[];
  normalizedSupport: number;
}): SurfaceCandidate {
  const { fact, bundle, construction, discoursePlan, hasher } = input.input;
  return {
    id: `candidate:generated:learned-construction:${hasher.digestHex(input.realization.id).slice(0, 20)}`,
    style: "surface.path.generated.learned_construction",
    path: "generated",
    text: input.realization.text,
    evidenceIds: input.proofEvidenceIds.map(id => id as EvidenceId),
    fit: input.normalizedSupport,
    importedPieceIds: [],
    discoursePlan,
    boundaryDecisions: [],
    exactSurface: true,
    audit: toJsonValue({
      schema: "scce.mouth.learned_construction_candidate.v2",
      profile: {
        profileKey: input.input.input.languageProfile.id,
        profileSourceVersionId: input.input.input.languageProfile.sourceVersionId
      },
      selectedFact: {
        sourceNodeId: fact.sourceNodeId,
        relationId: fact.relationId,
        targetNodeId: fact.targetNodeId,
        proofEvidenceIds: input.proofEvidenceIds
      },
      bundle: {
        id: bundle.id,
        contentDigest: bundle.contentDigest,
        bindingId: bundle.bindingId,
        sourceProfileId: bundle.sourceProfileId,
        targetProfileId: bundle.targetProfileId,
        sourceVersionIds: bundle.sourceVersionIds,
        evidenceIds: bundle.evidenceIds,
        sourceExamples: bundle.sourceExamples.map(example => ({
          id: example.id,
          sourceVersionId: example.sourceVersionId,
          evidenceId: example.evidenceId,
          evidenceCharStart: example.evidenceCharStart,
          evidenceCharEnd: example.evidenceCharEnd,
          surfaceStartCodePoint: example.surfaceStartCodePoint,
          surfaceEndCodePoint: example.surfaceEndCodePoint,
          coordinateSystemId: "unicode.code_point.v1"
        }))
      },
      construction: {
        id: construction.id,
        patternEvidenceIds: construction.patternEvidenceIds,
        provenance: construction.provenance,
        support: construction.support
      },
      realization: {
        id: input.realization.id,
        evidenceIds: input.realization.evidenceIds,
        provenance: input.realization.provenance,
        trace: input.realization.trace.map(part => ({
          ...part,
          outputStart: codePointOffsetAtUtf16(input.realization.text, part.outputStart),
          outputEnd: codePointOffsetAtUtf16(input.realization.text, part.outputEnd)
        })),
        coordinateSystemId: "unicode.code_point.v1",
        score: input.realization.score
      }
    })
  };
}

function constructionOccurrenceSlotIndexes(
  bundle: DurableLanguageConstructionBundle
): Map<string, number> | undefined {
  const out = new Map<string, number>();
  for (const example of bundle.sourceExamples) {
    for (const role of [...example.roles, ...example.nullRoles]) {
      const current = out.get(role.occurrenceId);
      if (current !== undefined && current !== role.slotIndex) return undefined;
      out.set(role.occurrenceId, role.slotIndex);
    }
  }
  return out;
}

function exactFactSurface(value: string): boolean {
  return value.length > 0 && value === value.normalize("NFC") && value === value.trim();
}

function completeLearnedFactCoverage(state: SemanticAnswerConstructState, fact: SemanticAnswerFact): boolean {
  if (state.answerSlots.length !== 1 || state.selectedRelations.length !== 1) return false;
  if (state.selectedRelations[0] !== fact.relationId || state.selectedSubject !== fact.subject) return false;
  const slot = state.answerSlots[0]!;
  if (slot.relationIds.length !== 1 || slot.relationIds[0] !== fact.relationId) return false;
  if (slot.factKeys.length !== 1 || !learnedFactSurfaceKeys(fact).has(slot.factKeys[0]!)) return false;
  return finiteUnitSignal(slot.support) && finiteUnitSignal(slot.activation);
}

function learnedFactSurfaceKeys(fact: SemanticAnswerFact): Set<string> {
  const surfaces = [fact.subject, fact.predicate, fact.object, fact.relationId];
  return new Set([
    surfaces.join("\u0001").toLocaleLowerCase().replace(/\s+/gu, " ").trim(),
    surfaces.map(surface => surface.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim()).join("\u0001")
  ]);
}

function learnedFactRouteAdmissible(fact: SemanticAnswerFact): boolean {
  if (fact.forceClass !== "direct_evidence" || fact.answerGrade !== true) return false;
  if (!Number.isFinite(fact.finalQuestionFit) || (fact.finalQuestionFit ?? 0) < 0.44) return false;
  return [
    fact.support,
    fact.activation,
    fact.score,
    fact.overlap,
    fact.certificationPower,
    fact.semanticQuality,
    fact.questionSlotScore
  ].every(finiteUnitSignal);
}

function learnedFactRouteAdmissibility(fact: SemanticAnswerFact, span: EvidenceSpan): number {
  if (!learnedFactRouteAdmissible(fact) || !finiteUnitSignal(span.alpha)) return 0;
  const factors = [
    fact.support,
    fact.activation,
    fact.score,
    fact.overlap,
    fact.finalQuestionFit!,
    fact.certificationPower!,
    fact.semanticQuality!,
    fact.questionSlotScore!,
    span.alpha
  ];
  return clamp01(factors.reduce((product, value) => product * clamp01(value), 1));
}

function finiteUnitSignal(value: number | undefined): boolean {
  return Number.isFinite(value) && (value ?? 0) > 0 && (value ?? 0) <= 1;
}

function exactSurfaceSatisfiesPlan(surface: string, input: SpeakInput, plan: SurfacePlan): boolean {
  if (input.maxLength && input.maxLength > 0 && [...surface].length > input.maxLength) return false;
  if (plan.targetLanguage !== input.languageProfile.id) return false;
  if (plan.targetScript && !input.languageProfile.scripts.some(row => row.script === plan.targetScript)) return false;
  if (input.requirementField || input.requiredOutputFeatures?.length || input.prohibitedOutputFeatures?.length || input.revisionConstraints?.length) return false;
  if (plan.caveatBindings.some(binding => !containsSurface(surface, binding.reason))) return false;
  if (input.learningDecision && (
    input.learningDecision.answerWithCaveat
    || input.learningDecision.deferDueToInsufficientEvidence
    || input.learningDecision.reportContradiction
    || input.learningDecision.reportUnsupported
  )) return false;
  if (input.style?.exposeProofTerms || input.meterPattern || input.meterPatternId) return false;
  return true;
}

function exactSurfaceConstraintHits(
  surface: string,
  input: SpeakInput,
  plan: SurfacePlan,
  correctionApplications: readonly { changed: boolean }[]
): string[] {
  const hits: string[] = [];
  if (!exactSurfaceSatisfiesPlan(surface, input, plan)) hits.push("surface.exact.constraint_mismatch");
  if (correctionApplications.some(application => application.changed)) hits.push("surface.exact.correction_required");
  return hits;
}

function codePointOffsetAtUtf16(surface: string, offset: number): number {
  return [...surface.slice(0, Math.max(0, offset))].length;
}

function isUnboundStructuralPoint(point: string): boolean {
  return isTrimCodePoint(point) || /[\p{P}\p{Separator}]/u.test(point);
}

function isTrimCodePoint(point: string): boolean {
  return point.trim().length === 0;
}

function learnedProfileAcceptsSurface(profile: LanguageProfile, surface: string): boolean {
  const ranked = rankLanguageProfilesForSurface([profile], surface)[0];
  return Boolean(ranked && ranked.score >= 0.48 && ranked.trigramCoverage >= 0.24);
}

function opaqueSurfaceId(hasher: Hasher, prefix: string, value: unknown): string {
  return `${prefix}.${hasher.digestHex(canonicalStringify([prefix, value])).slice(0, 24)}`;
}

function compareSurfaceText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function kernelCandidateDirectSurfaceAllowed(candidate: CandidateSurface, input: SpeakInput): boolean {
  if (kernelCandidateCarriesTerminalRuntimeMotionSurface(candidate)) return true;
  if (candidate.kind === "translation" || candidate.kind === "transformation") return true;
  if (candidate.kind === "creative-candidate" && candidate.force === "invented" && candidate.claimBases?.includes("invented") === true) return true;
  if (kernelCandidateCarriesExactBoundSourceSurface(candidate, input)) return true;
  if (kernelCandidateCarriesVerifiedSourceExcerptSurface(candidate, input)) return true;
  if ((candidate.kind === "proof-answer" || candidate.kind === "ccr-extractive") && candidate.evidenceIds.length > 0) {
    return candidate.boundaries.some(boundary => boundary === "selected-evidence-bound" || boundary === "local-evidence-certification-boundary" || boundary === "source-bound");
  }
  return false;
}

function kernelCandidateCarriesTerminalRuntimeMotionSurface(candidate: CandidateSurface): boolean {
  if (candidate.kind !== "dialogue-continuation" || candidate.force !== "unknown" || candidate.evidenceIds.length > 0) return false;
  const audit = jsonRecord(candidate.audit);
  if (audit.schema !== "scce.runtime_motion_candidate.v1"
    || audit.source !== "kernel.runtime_decision_boundary"
    || audit.externalFactCertification !== false
    || audit.fakeEvidenceForbidden !== true) return false;
  const semanticFrame = jsonRecord(audit.semanticFrame);
  if (semanticFrame.frameId !== "semantic.runtime.motion.clarification.v1") return false;
  const boundaries = new Set(candidate.boundaries);
  return candidate.answer.trim().length > 0
    && boundaries.has("runtime-motion-non-assertive")
    && boundaries.has("runtime-motion-acquisition-exhausted")
    && boundaries.has("runtime-motion-no-fabricated-evidence");
}

function kernelCandidateSurfaceAdmissible(candidate: CandidateSurface, input: SpeakInput): boolean {
  const answer = tidySurface(candidate.answer);
  if (!answer) return false;
  if (semanticAnswerConstructState(input.construct) && candidate.kind === "proof-answer" && !candidate.evidenceIds.length) return false;
  if (containsSurfaceRealizerTelemetry(answer)) return false;
  if (containsInternalSurfaceArtifact(answer)) return false;
  if (containsStructuredCandidateTelemetry(answer)) return false;
  if (!admissibleMouthSurface(answer)) return false;
  if (looksLikeInternalDiagnosticCode(answer.toLocaleLowerCase())) return false;
  if (candidate.kind !== "creative-candidate" && input.requestedAuthority !== "creative" && questionEchoHits(answer, input.entailment.claim.text).length && !evidenceBoundQuestionOverlapAllowed(candidate, input)) return false;
  return true;
}

function evidenceBoundQuestionOverlapAllowed(candidate: CandidateSurface, input: SpeakInput): boolean {
  if (kernelCandidateCarriesExactBoundSourceSurface(candidate, input)) return true;
  if (candidate.kind !== "proof-answer" || !candidate.evidenceIds.length) return false;
  return candidate.boundaries.some(boundary => boundary === "selected-evidence-bound" || boundary === "local-evidence-certification-boundary");
}

function kernelCandidateCarriesBoundSourceSurface(candidate: CandidateSurface): boolean {
  if (candidate.kind !== "reasoned-synthesis" && candidate.kind !== "causal-inference" && candidate.kind !== "temporal-inference") return false;
  if (!candidate.evidenceIds.length) return false;
  const semanticFrame = jsonRecord(jsonRecord(candidate.audit).semanticFrame);
  const origin = typeof semanticFrame.surfaceOriginId === "string" ? semanticFrame.surfaceOriginId : "";
  if (origin !== "surface.cognitive_proposal.bound_proof_evidence.v1"
    && origin !== "surface.cognitive_proposal.bound_selected_evidence.v1") return false;
  const candidateEvidenceIds = new Set(candidate.evidenceIds.map(String));
  const surfaceEvidenceIds = stringArrayFromJson(semanticFrame.surfaceEvidenceIds);
  return surfaceEvidenceIds.length > 0 && surfaceEvidenceIds.every(id => candidateEvidenceIds.has(id));
}

function kernelCandidateCarriesExactBoundSourceSurface(candidate: CandidateSurface, input: SpeakInput): boolean {
  if (!kernelCandidateCarriesBoundSourceSurface(candidate)) return false;
  const semanticFrame = jsonRecord(jsonRecord(candidate.audit).semanticFrame);
  const surfaceEvidenceIds = stringArrayFromJson(semanticFrame.surfaceEvidenceIds);
  const participatingEvidenceIds = kernelCandidateParticipatingEvidenceIds(candidate, input);
  if (!surfaceEvidenceIds.every(id => participatingEvidenceIds.has(id))) return false;
  const evidenceById = new Map(input.evidence.map(span => [String(span.id), span]));
  const surfaceEvidence = surfaceEvidenceIds.map(id => evidenceById.get(id));
  if (surfaceEvidence.some((span): span is undefined => !span || span.status !== "promoted")) return false;
  const admittedEvidence = surfaceEvidence.filter((span): span is EvidenceSpan => Boolean(span));
  if (!admittedEvidence.every(span => evidenceLanguageCompatibleWithMouth(span, input))) return false;
  const answer = tidySurface(candidate.answer);
  if (!answer) return false;
  return admittedEvidence.some(span => {
    return [span.text, span.textPreview]
      .filter((surface): surface is string => typeof surface === "string")
      .some(surface => tidySurface(surface) === answer);
  });
}

function kernelCandidateCarriesVerifiedSourceExcerptSurface(candidate: CandidateSurface, input: SpeakInput): boolean {
  if (candidate.kind !== "proof-answer" && candidate.kind !== "ccr-extractive") return false;
  const candidateEvidenceIds = new Set(candidate.evidenceIds.map(String));
  if (!candidateEvidenceIds.size) return false;
  const evidenceById = new Map(input.evidence.map(span => [String(span.id), span]));
  const admittedEvidence = [...candidateEvidenceIds]
    .map(id => evidenceById.get(id))
    .filter((span): span is EvidenceSpan => Boolean(span));
  if (admittedEvidence.length !== candidateEvidenceIds.size) return false;
  if (admittedEvidence.some(span => span.status !== "promoted" || !evidenceLanguageCompatibleWithMouth(span, input))) return false;
  const answer = tidySurface(candidate.answer);
  if (!answer || !admissibleMouthSurface(answer)) return false;
  return admittedEvidence.some(span => (
    [span.text, span.textPreview]
      .filter((surface): surface is string => typeof surface === "string")
      .some(surface => tidySurface(surface).includes(answer))
  ));
}

function kernelCandidateParticipatingEvidenceIds(candidate: CandidateSurface, input: SpeakInput): Set<string> {
  const audit = jsonRecord(candidate.audit);
  const claimBases = Array.isArray(audit.claimBases) ? audit.claimBases.map(jsonRecord) : [];
  const admissibleBases = new Set([
    "direct_evidence",
    "source_synthesis",
    "reasoned_inference",
    "causal_inference",
    "temporal_inference",
    "translated"
  ]);
  const semanticFrame = jsonRecord(audit.semanticFrame);
  const proofBoundSurface = semanticFrame.surfaceOriginId === "surface.cognitive_proposal.bound_proof_evidence.v1";
  const selectedBoundEvidenceIds = input.selectedCandidate?.id === candidate.id && proofBoundSurface && kernelCandidateCarriesBoundSourceSurface(candidate)
    ? candidate.evidenceIds
      .filter(id => input.evidence.some(span => String(span.id) === String(id) && span.status === "promoted"))
      .map(String)
    : [];
  return new Set([
    ...input.entailment.evidenceIds.map(String),
    ...input.entailment.proof.evidenceIds.map(String),
    ...selectedBoundEvidenceIds,
    ...claimBases
      .filter(claim => typeof claim.basis === "string" && admissibleBases.has(claim.basis))
      .flatMap(claim => stringArrayFromJson(claim.evidenceIds))
  ]);
}

function evidenceLanguageCompatibleWithMouth(span: EvidenceSpan, input: SpeakInput): boolean {
  if (String(span.sourceVersionId) === String(input.languageProfile.sourceVersionId)) return true;
  const hints = jsonRecord(span.languageHints);
  const targetIds = new Set([
    String(input.languageProfile.id),
    String(input.targetLanguage ?? "")
  ].filter(Boolean));
  const declaredIds = [hints.profileId, hints.languageProfileId, hints.language]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (declaredIds.some(id => targetIds.has(id))) return true;
  const scope = input.languageMemory.scope;
  if (scope.mode === "cluster"
    && scope.purityProven
    && !scope.degraded
    && declaredIds.some(id => scope.profileIds.includes(id))
    && scope.sourceVersionIds.includes(String(span.sourceVersionId))) return true;
  if (declaredIds.length) return false;
  const declaredScripts = new Set([
    ...arrayRecords(hints.scripts),
    ...arrayRecords(jsonRecord(span.scriptHints).dominantScripts)
  ].map(row => stringFrom(row.script)).filter((script): script is string => Boolean(script)));
  const targetScripts = new Set([
    ...input.languageProfile.scripts.map(row => row.script),
    input.targetScript
  ].filter((script): script is string => typeof script === "string" && script.length > 0));
  if (declaredScripts.size && [...declaredScripts].some(script => targetScripts.has(script))) return true;
  const requestScripts = contentScriptIds(input.entailment.claim.text);
  const evidenceScripts = contentScriptIds(span.text || span.textPreview);
  if (requestScripts.size
    && evidenceScripts.size
    && [...requestScripts].every(script => evidenceScripts.has(script))) return true;
  return learnedProfileAcceptsSurface(input.languageProfile, span.text || span.textPreview);
}

function contentScriptIds(surface: string): Set<string> {
  return new Set([...surface]
    .filter(point => /[\p{Letter}\p{Mark}]/u.test(point))
    .map(learnedScriptIdForCharacter));
}

function generatedCandidatesFromFrames(
  plan: SurfacePlan,
  discoursePlan: DiscoursePlan,
  input: SpeakInput,
  languageMemory: LanguageMemoryRuntime,
  priorPieces: readonly ImportedSurfacePiece[],
  generationWorkBudget: MouthGenerationWorkBudget
): SurfaceCandidate[] {
  const preflightCreative = isCreativeRequested(input, plan);
  const preflightSemanticState = preflightCreative ? undefined : semanticAnswerConstructState(input.construct);
  const preflightTemporalCounterexample = preflightSemanticState
    ? semanticTemporalCounterexampleSurface(preflightSemanticState.selectedFacts.length ? preflightSemanticState.selectedFacts : preflightSemanticState.activatedNeighborhood)
    : undefined;
  if (preflightTemporalCounterexample) {
    const learned = learnedTemporalCounterexampleCandidate(discoursePlan, input);
    return learned ? [learned] : [];
  }
  const conversationMemory = preflightCreative
    ? undefined
    : conversationMemoryCandidate(input, discoursePlan, languageMemory, generationWorkBudget);
  if (!discoursePlan.units.length) return conversationMemory ? [conversationMemory] : [];
  const creativeRequested = isCreativeRequested(input, plan);
  const semanticAnswerState = creativeRequested ? undefined : semanticAnswerConstructState(input.construct);
  const isSemanticAnswer = Boolean(semanticAnswerState);
  const directEvidence = semanticAnswerState
    ? semanticDirectEvidenceCandidate(semanticAnswerState, discoursePlan, input)
    : undefined;
  const rhetoricalLattice = isSemanticAnswer
    ? rhetoricalLatticeCandidateFromFrames(plan, discoursePlan, input, languageMemory, priorPieces, generationWorkBudget)
    : undefined;
  const isInsufficientSupport = !creativeRequested && Boolean(insufficientSupportConstructState(input.construct));
  const isImportSummary = plan.constructForces.some(force => force.id === "ImportSummaryConstruct");
  if (isSemanticAnswer) return uniqueSurfaceCandidates([
    ...(directEvidence ? [directEvidence] : []),
    ...(rhetoricalLattice ? [rhetoricalLattice] : [])
  ]);
  if (isInsufficientSupport) return [];
  if (isImportSummary) return [];
  const creativeVariants = creativeRequested
    ? creativeCandidatesFromFrames(plan, discoursePlan, input, languageMemory, priorPieces, generationWorkBudget)
    : [];
  if (!shouldAttemptGenerated(plan, input.languageMemory)) {
    return uniqueSurfaceCandidates([...creativeVariants, ...(conversationMemory ? [conversationMemory] : [])]);
  }
  const sentences: SentenceCandidate[] = [];
  for (const unit of discoursePlan.units) {
    const frames = framesForDiscourseUnit(unit, plan);
    if (!frames.length) continue;
    const unitTerms = requiredTermsForDiscourseUnit(unit, frames, plan);
    const unitPlan: SurfacePlan = { ...plan, realizationFrames: frames, requiredTerms: unitTerms };
    const contextSymbols = [input.entailment.claim.text, ...sentences.map(sentence => sentence.text)].filter(Boolean);
    const generationExtent = claimMouthGenerationWork(generationWorkBudget, unit.generationExtent);
    if (generationExtent === undefined) break;
    const generation = languageMemory.generate({
      state: input.languageMemory,
      targetLanguageProfile: input.languageProfile,
      contextSymbols,
      requiredTerms: unitTerms,
      semanticFrameIds: input.languageMemory.importedSemanticFrames.map(frame => frame.id).slice(0, 64),
      frames,
      generationExtent,
      styleProfileId: unit.targetStyleProfileId,
      registerVector: unit.registerVector,
      detailProfileId: unit.targetDetailProfileId
    });
    const generatedText = isImportSummary && unit.role === "caveat"
      ? importSummaryCaveatSurface(frames, generation.text)
      : isImportSummary ? preserveImportSummaryCoverage(generation.text, unitPlan, unit.role) : generation.text;
    if (!admissibleLearnedSurface(generatedText, generation)) continue;
    const preservation = semanticPreservation({ text: generatedText, plan: unitPlan, entailment: input.entailment });
    sentences.push({
      unitId: unit.id,
      role: unit.role,
      text: generatedText,
      generation,
      coveredRequiredTerms: stringArrayFromJson(jsonRecord(generation.audit).requiredTermIdsCovered),
      coveredPropositionAtoms: stringArrayFromJson(jsonRecord(generation.audit).propositionAtomIdsCovered),
      importedPriorIds: generationImportedPriorIds(generation),
      orderUsage: generation.orderUsage,
      preservationScore: preservation.score,
      stopReason: generation.stoppedBy
    });
  }
  if (!sentences.length) return uniqueSurfaceCandidates([
    ...creativeVariants,
    ...(conversationMemory ? [conversationMemory] : [])
  ]);
  const assembly = assembleDiscourseSentences({ discoursePlan, sentences, languageMemory: input.languageMemory });
  if (!assembly.text.trim()) return uniqueSurfaceCandidates([
    ...creativeVariants,
    ...(conversationMemory ? [conversationMemory] : [])
  ]);
  const generatedIds = uniqueStrings(sentences.flatMap(sentence => sentence.importedPriorIds));
  const pieceIds = uniqueStrings([...generatedIds, ...priorPieces.filter(piece => assembly.text.includes(piece.text)).map(piece => piece.id)]);
  const aggregateGeneration = aggregateLanguageGeneration(sentences);
  return uniqueSurfaceCandidates([
    {
    id: "candidate:generated:0",
    style: "surface.path.generated",
    path: "generated",
    text: assembly.text,
    evidenceIds: [...new Set(discoursePlan.units.flatMap(unit => unit.frameIds).map(id => plan.realizationFrames.find(frame => frame.id === id)).filter((frame): frame is RealizationFrame => Boolean(frame)).flatMap(frame => frame.evidenceBinding?.evidenceId ? [frame.evidenceBinding.evidenceId] : []))],
    fit: clamp01(0.58 + mean(sentences.map(sentence => sentence.generation.confidence)) * 0.42),
    importedPieceIds: pieceIds,
    generation: aggregateGeneration,
    discoursePlan,
    sentenceCandidates: sentences,
    boundaryDecisions: assembly.boundaryDecisions
    },
    ...creativeVariants
  ]);
}

function semanticDirectEvidenceCandidate(
  state: SemanticAnswerConstructState,
  discoursePlan: DiscoursePlan,
  input: SpeakInput
): SurfaceCandidate | undefined {
  if (!state.certificationBoundary.externalFactCertification) return undefined;
  if (state.forceId !== "output.force.source_bound_answer" || state.boundaryId !== "output.force.source_bound") return undefined;
  const certifiedEvidenceIds = new Set(state.certificationBoundary.evidenceSpanIds);
  const certifiedSourceVersionIds = new Set(state.certificationBoundary.sourceVersionIds);
  if (!certifiedEvidenceIds.size || !certifiedSourceVersionIds.size) return undefined;
  const rows = uniquePriorBoundFacts(state.selectedFacts)
    .filter(fact => fact.relationId === LOCAL_ANSWER_RELATION_IDS.sourceQuote)
    .filter(fact => fact.forceClass === "direct_evidence")
    .map(fact => {
      const evidenceIds = uniqueStrings((fact.evidenceIds ?? []).filter(id => certifiedEvidenceIds.has(id)));
      const sourceCertified = Boolean(fact.sourceVersionId && certifiedSourceVersionIds.has(fact.sourceVersionId));
      const surface = stripInternalSurfaceArtifacts(tidySurface(fact.object || fact.predicate));
      return {
        fact,
        evidenceIds,
        sourceCertified,
        surface: ensureSurfaceSentence(surface)
      };
    })
    .filter(row => row.evidenceIds.length > 0 && row.sourceCertified && admissibleMouthSurface(row.surface))
    .sort((left, right) => (
      semanticFactImportanceRank(left.fact.questionSlotImportance) - semanticFactImportanceRank(right.fact.questionSlotImportance)
      || (right.fact.questionSlotScore ?? 0) - (left.fact.questionSlotScore ?? 0)
      || right.fact.support - left.fact.support
      || compareSurfaceText(left.surface, right.surface)
    ));
  const selected: typeof rows = [];
  for (const row of rows) {
    if (selected.some(existing => (
      containsSurface(existing.surface, row.surface)
      || containsSurface(row.surface, existing.surface)
      || weightedJaccard(featureSet(existing.surface, 256), featureSet(row.surface, 256)) > 0.88
    ))) continue;
    selected.push(row);
    if (selected.length >= Math.max(1, Math.min(4, discoursePlan.units.length || 2))) break;
  }
  if (!selected.length) return undefined;
  const text = joinSurfaceSentences(selected.map(row => row.surface));
  if (!text || !admissibleMouthSurface(text)) return undefined;
  const evidenceIds = uniqueEvidenceIds(selected.flatMap(row => row.evidenceIds.map(id => id as EvidenceId)));
  if (!evidenceIds.length || evidenceIds.some(id => !input.evidence.some(span => span.id === id && span.status === "promoted"))) return undefined;
  return {
    id: "candidate:generated:semantic-direct-evidence",
    style: "surface.path.generated.semantic_direct_evidence",
    path: "generated",
    text,
    evidenceIds,
    fit: clamp01(0.82 + mean(selected.map(row => row.fact.support)) * 0.14),
    importedPieceIds: [],
    discoursePlan,
    boundaryDecisions: [],
    audit: toJsonValue({
      schema: "scce.mouth.semantic_direct_evidence.v1",
      factKeys: selected.map(row => semanticAnswerFactKey(row.fact)),
      evidenceIds: evidenceIds.map(String),
      sourceVersionIds: uniqueStrings(selected.map(row => row.fact.sourceVersionId ?? "").filter(Boolean)),
      externalFactCertification: true
    })
  };
}

function semanticFactImportanceRank(value: string | undefined): number {
  if (value === "core") return 0;
  if (value === "secondary") return 1;
  return 2;
}

function semanticAnswerFactKey(fact: Pick<SemanticAnswerFact, "sourceNodeId" | "relationId" | "targetNodeId">): string {
  return `${fact.sourceNodeId}\u0001${fact.relationId}\u0001${fact.targetNodeId}`;
}

function creativeCandidatesFromFrames(
  plan: SurfacePlan,
  discoursePlan: DiscoursePlan,
  input: SpeakInput,
  languageMemory: LanguageMemoryRuntime,
  priorPieces: readonly ImportedSurfacePiece[],
  generationWorkBudget: MouthGenerationWorkBudget
): SurfaceCandidate[] {
  const invention = inventionConstructState(input.construct);
  if (!invention) {
    const artifact = creativeArtifactCandidate(input, discoursePlan);
    return artifact ? [artifact] : [];
  }
  const learnedProposal = learnedCreativeProposalCandidate(invention, plan, discoursePlan, input, priorPieces);
  if (!plan.realizationFrames.length) return learnedProposal ? [learnedProposal] : [];
  const frames = plan.realizationFrames;
  const constraintsFirst = [...frames].sort((left, right) =>
    right.requiredTerms.length - left.requiredTerms.length ||
    left.ordering.index - right.ordering.index ||
    left.id.localeCompare(right.id)
  );
  const actionFirst = [...frames].sort((left, right) =>
    creativeRoleRank(left.role) - creativeRoleRank(right.role) ||
    left.ordering.index - right.ordering.index ||
    left.id.localeCompare(right.id)
  );
  const variants: Array<{ id: string; style: string; frames: RealizationFrame[]; contextSymbols: string[] }> = [
    {
      id: "meaning-first",
      style: "surface.path.generated.creative.meaning_first",
      frames: [...frames],
      contextSymbols: [invention.proposalSurface, ...invention.claimBasis.map(row => row.surface)]
    },
    {
      id: "constraint-first",
      style: "surface.path.generated.creative.constraint_first",
      frames: constraintsFirst,
      contextSymbols: [...invention.constraints.map(row => row.surface), invention.proposalSurface]
    },
    {
      id: "action-first",
      style: "surface.path.generated.creative.action_first",
      frames: actionFirst,
      contextSymbols: [...actionFirst.flatMap(frame => frame.propositionAtoms.map(atom => atom.text)).reverse(), invention.proposalSurface]
    }
  ];
  const evidenceIds = invention.basisEvidenceIds.filter(id => input.evidence.some(span => String(span.id) === String(id)));
  const creativeRequiredTerms = creativeRequestContentTerms(input);
  const out: SurfaceCandidate[] = learnedProposal ? [learnedProposal] : [];
  for (const variant of variants) {
    const anchoredAssembly = creativeAnchoredAssembly(variant.id, variant.frames, discoursePlan, input.languageMemory);
    const generationExtent = claimMouthGenerationWork(
      generationWorkBudget,
      Math.max(24, Math.min(128, discoursePlan.units.reduce((total, unit) => total + unit.generationExtent, 0) || 64))
    );
    if (generationExtent === undefined) break;
    const generation = languageMemory.generate({
      state: input.languageMemory,
      targetLanguageProfile: input.languageProfile,
      contextSymbols: uniqueStrings([
        input.entailment.claim.text,
        ...variant.contextSymbols
      ].filter(Boolean)),
      requiredTerms: creativeRequiredTerms,
      semanticFrameIds: uniqueStrings([
        ...variant.frames.flatMap(frame => frame.semanticFrameIds),
        ...input.languageMemory.importedSemanticFrames.map(frame => frame.id).slice(0, 64)
      ]),
      frames: variant.frames,
      generationExtent,
      styleProfileId: discoursePlan.targetStyleProfileId,
      registerVector: discoursePlan.registerVector,
      detailProfileId: discoursePlan.targetDetailProfileId
    });
    const generatedText = tidySurface(generation.text);
    const learnedText = admissibleLearnedSurface(generatedText, generation) ? generatedText : "";
    const anchoredText = admissibleMouthSurface(anchoredAssembly.text) ? tidySurface(anchoredAssembly.text) : "";
    const text = learnedText && !out.some(candidate => candidate.text === learnedText)
      ? learnedText
      : anchoredText;
    if (!text) continue;
    const importedPieceIds = uniqueStrings([
      ...generationImportedPriorIds(generation),
      ...priorPieces.filter(piece => containsSurface(text, piece.text) || overlapsClaim(piece.text, text)).map(piece => piece.id)
    ]);
    out.push({
      id: `candidate:generated:creative:${variant.id}`,
      style: variant.style,
      path: "generated",
      claimBasis: "invented",
      text,
      evidenceIds,
      fit: clamp01(0.46 + generation.confidence * 0.34 + invention.noveltyScore * 0.12 + (1 - invention.riskScore) * 0.08),
      importedPieceIds,
      generation,
      discoursePlan,
      sentenceCandidates: [{
        unitId: `disc:creative:${variant.id}`,
        role: "answer",
        text,
        generation,
        coveredRequiredTerms: stringArrayFromJson(jsonRecord(generation.audit).requiredTermIdsCovered),
        coveredPropositionAtoms: stringArrayFromJson(jsonRecord(generation.audit).propositionAtomIdsCovered),
        importedPriorIds: generationImportedPriorIds(generation),
        orderUsage: generation.orderUsage,
        preservationScore: semanticPreservation({ text, plan, entailment: input.entailment }).score,
        stopReason: generation.stoppedBy
      }],
      boundaryDecisions: generation.text.trim() ? generation.discourse.boundaries.map(boundary => ({
        fromUnitId: boundary.betweenMoveIds[0],
        toUnitId: boundary.betweenMoveIds[1],
        kind: "sentence" as const,
        text: boundary.text,
        source: boundary.source,
        boundarySource: discoursePlan.boundaryProfile.boundarySource,
        repeatedBoundaryPenalty: 0
      })) : anchoredAssembly.boundaryDecisions
    });
  }
  return out;
}

function selectedStructuralCreativePlan(input: SpeakInput): StructuralCreativeSelectionBinding | undefined {
  const candidate = input.selectedCandidate;
  if (!candidate || candidate.kind !== "creative-candidate") return undefined;
  if (!candidate.claimBases?.includes("invented")) return undefined;
  if (input.selectedProposal && candidate.proposalId !== input.selectedProposal.id) return undefined;
  const proposalConstructIds = new Set(
    input.selectedProposal?.constructIds ?? candidate.constructIds ?? []
  );
  const selectedInventionNodeIds = uniqueStrings(candidate.constructIds ?? [])
    .filter(id => proposalConstructIds.has(id))
    .filter(id => input.construct.nodes.some(node => (
      String(node.id) === id
      && (node.kind === "construct:invention" || jsonRecord(node.metadata).schema === "scce.invention_construct.v1")
    )));
  if (selectedInventionNodeIds.length !== 1) return undefined;
  const invention = inventionConstructState(input.construct, selectedInventionNodeIds[0]);
  if (!invention) return undefined;
  const trace = jsonRecord(invention.trace);
  const proposalRealization = jsonRecord(trace.proposalRealization);
  const semanticPlan = jsonRecord(trace.structuralSemanticPlan);
  if (proposalRealization.path !== "mouth_realization_deferred") return undefined;
  const semanticPlanId = stringFrom(proposalRealization.semanticPlanId);
  if (!semanticPlanId || semanticPlan.id !== semanticPlanId) return undefined;
  if (semanticPlan.schema !== "scce.structural_semantic_plan.v2"
    || semanticPlan.selectionAuthority !== "candidate_engine_and_judge"
    || semanticPlan.surfaceRealizationCompetitive !== false) return undefined;
  const sourceBundleIds = uniqueStrings([
    ...stringArrayFromJson(proposalRealization.structuralBundleIds),
    ...stringArrayFromJson(semanticPlan.sourceBundleIds)
  ]);
  const proposalEvents = structuralCreativeEventSelectors(proposalRealization.structuralEventPlan);
  const events = structuralCreativeEventSelectors(semanticPlan.events);
  if (!sourceBundleIds.length
    || events.length < 4
    || proposalEvents.length !== events.length
    || canonicalStringify(toJsonValue(proposalEvents)) !== canonicalStringify(toJsonValue(events))) return undefined;
  const eventBundleIds = uniqueStrings(events.map(event => event.bundleId));
  if (canonicalStringify([...sourceBundleIds].sort()) !== canonicalStringify([...eventBundleIds].sort())) return undefined;
  return {
    semanticCandidateId: candidate.id,
    cognitiveProposalId: candidate.proposalId,
    invention,
    semanticPlanId,
    sourceBundleIds,
    events
  };
}

function structuralCreativeEventSelectors(
  value: JsonValue | undefined
): StructuralCreativeEventSelector[] {
  if (!Array.isArray(value)
    || value.length < 4
    || value.length > MAX_ENGLISH_STRUCTURAL_CREATIVE_EVENTS) return [];
  const rows = arrayRecords(value);
  if (rows.length !== value.length) return [];
  const out: StructuralCreativeEventSelector[] = [];
  const eventIds = new Set<string>();
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index]!;
    const outputIndex = typeof row.outputIndex === "number" && Number.isSafeInteger(row.outputIndex)
      ? row.outputIndex
      : -1;
    const bundleId = stringFrom(row.bundleId);
    const eventId = stringFrom(row.eventId);
    const profileId = stringFrom(row.profileId);
    const constructionId = stringFrom(row.constructionId);
    const relationId = stringFrom(row.relationId);
    const discourseRelationId = stringFrom(row.discourseRelationId);
    const discourseBridgeBasisId = stringFrom(row.discourseBridgeBasisId);
    const discourseBeatId = stringFrom(row.discourseBeatId);
    const requestRoleBindings = structuralCreativeRequestRoleBindings(row.requestRoleBindings);
    const compatibilityModelId = stringFrom(row.compatibilityModelId);
    const compatibilityModelVersion = stringFrom(row.compatibilityModelVersion);
    const compatibilityCalibrationId = stringFrom(row.compatibilityCalibrationId);
    const compatibilityThreshold = unitIntervalJsonNumber(row.compatibilityThreshold);
    const routeId = stringFrom(row.routeId);
    const routeAnchorEventId = stringFrom(row.routeAnchorEventId);
    const sourceVersionId = stringFrom(row.sourceVersionId);
    const evidenceId = stringFrom(row.evidenceId);
    const roleIds = stringArrayFromJson(row.roleIds);
    const requestFit = unitIntervalJsonNumber(row.requestFit);
    const graphFit = unitIntervalJsonNumber(row.graphFit);
    const routeFit = unitIntervalJsonNumber(row.routeFit);
    const sourceOrdinal = typeof row.sourceOrdinal === "number" && Number.isSafeInteger(row.sourceOrdinal)
      ? row.sourceOrdinal
      : -1;
    if (outputIndex !== index
      || !bundleId
      || !eventId
      || !profileId
      || !constructionId
      || !relationId
      || !routeId
      || !routeAnchorEventId
      || !sourceVersionId
      || !evidenceId
      || !discourseBeatId
      || requestRoleBindings === undefined
      || !compatibilityModelId
      || !compatibilityModelVersion
      || !compatibilityCalibrationId
      || compatibilityThreshold === undefined
      || eventIds.has(eventId)
      || !roleIds.includes("scce.role.agent")
      || requestFit === undefined
      || graphFit === undefined
      || routeFit === undefined
      || sourceOrdinal < 0
      || !isStructuralCreativeDiscourseBridgeBasisId(discourseBridgeBasisId)
      || !isNarrativeBridgeRelationId(discourseRelationId)) return [];
    eventIds.add(eventId);
    out.push({
      outputIndex,
      bundleId,
      eventId,
      profileId,
      constructionId,
      relationId,
      roleIds,
      discourseRelationId,
      discourseBridgeBasisId,
      discourseBeatId,
      requestRoleBindings,
      compatibilityModelId,
      compatibilityModelVersion,
      compatibilityCalibrationId,
      compatibilityThreshold,
      requestFit,
      graphFit,
      routeFit,
      routeId,
      routeAnchorEventId,
      sourceOrdinal,
      sourceVersionId,
      evidenceId
    });
  }
  return out;
}

function structuralCreativeRequestRoleBindings(
  value: JsonValue | undefined
): StructuralCreativeEventSelector["requestRoleBindings"] | undefined {
  if (!Array.isArray(value) || value.length > 2) return undefined;
  const rows = arrayRecords(value);
  if (rows.length !== value.length) return undefined;
  const bindings: StructuralCreativeEventSelector["requestRoleBindings"] = [];
  const eventRoleIds = new Set<string>();
  const requestArgumentIds = new Set<string>();
  for (const row of rows) {
    const eventRoleId = stringFrom(row.eventRoleId);
    const requestArgumentId = stringFrom(row.requestArgumentId);
    const requestRoleId = stringFrom(row.requestRoleId);
    const requestSpan = jsonRecord(row.requestSpan);
    const requestSpanText = stringFrom(requestSpan.text);
    const requestSpanCharStart = safeNonNegativeInteger(requestSpan.charStart);
    const requestSpanCharEnd = safeNonNegativeInteger(requestSpan.charEnd);
    const requestSpanByteStart = safeNonNegativeInteger(requestSpan.byteStart);
    const requestSpanByteEnd = safeNonNegativeInteger(requestSpan.byteEnd);
    const rolePosterior = unitIntervalJsonNumber(row.rolePosterior);
    const roleThreshold = unitIntervalJsonNumber(row.roleThreshold);
    if ((eventRoleId !== "scce.role.patient" && eventRoleId !== "scce.role.complement")
      || !requestArgumentId
      || !requestRoleId
      || !requestSpanText
      || requestSpanCharStart === undefined
      || requestSpanCharEnd === undefined
      || requestSpanByteStart === undefined
      || requestSpanByteEnd === undefined
      || requestSpanCharEnd <= requestSpanCharStart
      || requestSpanByteEnd <= requestSpanByteStart
      || rolePosterior === undefined
      || roleThreshold === undefined
      || rolePosterior < roleThreshold
      || row.admissible !== true
      || eventRoleIds.has(eventRoleId)
      || requestArgumentIds.has(requestArgumentId)) return undefined;
    eventRoleIds.add(eventRoleId);
    requestArgumentIds.add(requestArgumentId);
    bindings.push({
      eventRoleId,
      requestArgumentId,
      requestRoleId,
      requestSpan: {
        text: requestSpanText,
        charStart: requestSpanCharStart,
        charEnd: requestSpanCharEnd,
        byteStart: requestSpanByteStart,
        byteEnd: requestSpanByteEnd
      },
      rolePosterior,
      roleThreshold,
      admissible: true
    });
  }
  return bindings;
}

function isNarrativeBridgeRelationId(
  value: string | undefined
): value is NarrativeBridgeRelationId {
  return value === "scce.relation.concurrent"
    || value === "scce.relation.subsequent"
    || value === "scce.relation.contrastive"
    || value === "scce.relation.resolution";
}

function isStructuralCreativeDiscourseBridgeBasisId(
  value: string | undefined
): value is StructuralCreativeEventSelector["discourseBridgeBasisId"] {
  return value === "scce.discourse.bridge.source_adjacency"
    || value === "scce.discourse.bridge.invented_macro";
}

function unitIntervalJsonNumber(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : undefined;
}

function safeNonNegativeInteger(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function resolveHydratedStructuralCreativeEvents(
  state: LanguageMemoryRuntimeState,
  languageProfile: LanguageProfile,
  binding: StructuralCreativeSelectionBinding
): HydratedStructuralCreativeEvent[] | undefined {
  if (state.scope.mode !== "cluster" || !state.scope.purityProven) return undefined;
  const scopedProfileIds = new Set(state.scope.profileIds);
  const bundleById = new Map(state.importedConstructionBundles.map(bundle => [bundle.id, bundle]));
  const admittedBundleIds = new Set(binding.sourceBundleIds);
  const bindingSelectorByEventId = new Map(binding.events.map(selector => [selector.eventId, selector]));
  const structuralRouteByBundleId = new Map<string, {
    eventById: Map<string, NonNullable<LanguageMemoryRuntimeState["importedConstructionBundles"][number]["creativeEvents"]>[number]>;
    indexByEventId: Map<string, number>;
  }>();
  for (const bundleId of admittedBundleIds) {
    const bundle = bundleById.get(bundleId);
    if (!bundle) return undefined;
    const routeEvents = englishCreativeStructuralRouteEvents(bundle.creativeEvents ?? [])
      .sort((left, right) =>
        left.sourceOrdinal - right.sourceOrdinal || left.id.localeCompare(right.id)
      );
    if (routeEvents.length < 4) return undefined;
    structuralRouteByBundleId.set(bundleId, {
      eventById: new Map(routeEvents.map(event => [event.id, event])),
      indexByEventId: new Map(routeEvents.map((event, index) => [event.id, index]))
    });
  }
  const routeBundleIds = new Map<string, string>();
  const routeAnchorEventIds = new Map<string, string>();
  const resolved: HydratedStructuralCreativeEvent[] = [];
  for (let index = 0; index < binding.events.length; index++) {
    const selector = binding.events[index]!;
    const previous = binding.events[index - 1];
    if (!admittedBundleIds.has(selector.bundleId) || !scopedProfileIds.has(selector.profileId)) return undefined;
    const bundle = bundleById.get(selector.bundleId);
    const structuralRoute = structuralRouteByBundleId.get(selector.bundleId);
    if (!bundle
      || !structuralRoute
      || bundle.sourceProfileId !== selector.profileId
      || bundle.targetProfileId !== selector.profileId
      || !bundle.sourceVersionIds.includes(selector.sourceVersionId)
      || !bundle.evidenceIds.includes(selector.evidenceId)) return undefined;
    const event = structuralRoute.eventById.get(selector.eventId);
    if (!event
      || !isEnglishCreativeEventStructurallyRealizable(event)
      || event.profileId !== selector.profileId
      || event.constructionId !== selector.constructionId
      || event.relationId !== selector.relationId
      || event.sourceVersionId !== selector.sourceVersionId
      || event.evidenceId !== selector.evidenceId
      || event.sourceOrdinal !== selector.sourceOrdinal
      || canonicalStringify(event.roleIds) !== canonicalStringify(selector.roleIds)) return undefined;
    const routeAnchor = structuralRoute.eventById.get(selector.routeAnchorEventId);
    const routeAnchorSelector = bindingSelectorByEventId.get(selector.routeAnchorEventId);
    if (!routeAnchor
      || !routeAnchorSelector
      || routeAnchor.profileId !== selector.profileId
      || routeAnchorSelector.routeId !== selector.routeId
      || routeAnchorSelector.bundleId !== selector.bundleId) return undefined;
    const existingRouteBundleId = routeBundleIds.get(selector.routeId);
    const existingRouteAnchorEventId = routeAnchorEventIds.get(selector.routeId);
    if ((existingRouteBundleId && existingRouteBundleId !== selector.bundleId)
      || (existingRouteAnchorEventId && existingRouteAnchorEventId !== selector.routeAnchorEventId)) return undefined;
    routeBundleIds.set(selector.routeId, selector.bundleId);
    routeAnchorEventIds.set(selector.routeId, selector.routeAnchorEventId);
    const currentBundleEventIndex = structuralRoute.indexByEventId.get(selector.eventId) ?? -1;
    const previousBundleEventIndex = previous?.bundleId === selector.bundleId
      ? structuralRoute.indexByEventId.get(previous.eventId) ?? -1
      : -1;
    const sourceAdjacent = Boolean(
      previous
      && previous.bundleId === selector.bundleId
      && previous.routeId === selector.routeId
      && previousBundleEventIndex >= 0
      && currentBundleEventIndex === previousBundleEventIndex + 1
    );
    const expectedBridgeBasisId = sourceAdjacent
      ? "scce.discourse.bridge.source_adjacency"
      : "scce.discourse.bridge.invented_macro";
    const eventArgumentRoleIds = event.argumentFrame.bindings.map(binding => binding.roleId).sort();
    const plannedArgumentRoleIds = selector.requestRoleBindings.map(binding => binding.eventRoleId).sort();
    if (selector.discourseBridgeBasisId !== expectedBridgeBasisId
      || (sourceAdjacent && previous!.sourceOrdinal >= selector.sourceOrdinal)
      || selector.requestFit < selector.compatibilityThreshold
      || canonicalStringify(eventArgumentRoleIds) !== canonicalStringify(plannedArgumentRoleIds)
      || Math.abs(selector.routeFit - clamp01(
        1 - (1 - selector.requestFit) * (1 - selector.graphFit)
      )) > 1e-12) return undefined;
    resolved.push({
      outputIndex: selector.outputIndex,
      bundleId: selector.bundleId,
      event,
      discourseRelationId: selector.discourseRelationId,
      discourseBridgeBasisId: selector.discourseBridgeBasisId,
      discourseBeatId: selector.discourseBeatId,
      requestRoleBindings: selector.requestRoleBindings,
      requestFit: selector.requestFit,
      graphFit: selector.graphFit,
      routeFit: selector.routeFit,
      routeId: selector.routeId,
      routeAnchorEventId: selector.routeAnchorEventId,
      sourceOrdinal: selector.sourceOrdinal
    });
  }
  const resolvedBundleIds = uniqueStrings(resolved.map(row => row.bundleId)).sort();
  if (canonicalStringify(resolvedBundleIds) !== canonicalStringify([...admittedBundleIds].sort())) return undefined;
  return resolved;
}

function hasHydratedStructuralCreativePrior(
  state: LanguageMemoryRuntimeState,
  languageProfile: LanguageProfile,
  binding: StructuralCreativeSelectionBinding | undefined
): boolean {
  return Boolean(binding && resolveHydratedStructuralCreativeEvents(state, languageProfile, binding));
}

function sourceStructuralCreativeCandidate(
  plan: SurfacePlan,
  discoursePlan: DiscoursePlan,
  input: SpeakInput,
  binding: StructuralCreativeSelectionBinding
): SurfaceCandidate | undefined {
  if (!plan.realizationFrames.length) return undefined;
  const plannedEvents = resolveHydratedStructuralCreativeEvents(
    input.languageMemory,
    input.languageProfile,
    binding
  );
  if (!plannedEvents) return undefined;
  const creativeRequiredTerms = creativeRequestContentTerms(input);
  const structural = realizeEnglishStructuralCreative({
    requestText: input.entailment.claim.text,
    contentTerms: creativeRequiredTerms.map(term => term.text),
    plannedEvents,
    ...(input.requirementField?.responseForm ? {
      responseForm: input.requirementField.responseForm
    } : {}),
    responseExtentHints: creativeResponseExtentHints(input),
    defaultTargetWords: creativeDefaultTargetWords(input)
  });
  if (!structural || !admissibleMouthSurface(structural.text)) return undefined;
  const surfaceRealizationId = `surface:creative-structural:${hash32([
    binding.semanticCandidateId,
    binding.semanticPlanId,
    structural.text
  ].join("\u0001")).toString(16)}`;
  const semanticRealizability = clamp01(
    input.selectedCandidate?.scores.languageRealizability
    ?? input.selectedCandidate?.scores.realizability
    ?? 0
  );
  return {
    id: surfaceRealizationId,
    style: "surface.path.generated.creative.structural_source",
    path: "generated",
    claimBasis: "invented",
    text: structural.text,
    evidenceIds: [],
    fit: semanticRealizability,
    importedPieceIds: structural.importedBundleIds,
    discoursePlan,
    boundaryDecisions: [],
    audit: toJsonValue({
      ...jsonRecord(structural.audit),
      selectionBinding: {
        semanticCandidateId: binding.semanticCandidateId,
        cognitiveProposalId: binding.cognitiveProposalId ?? null,
        inventionConstructId: binding.invention.nodeId,
        semanticPlanId: binding.semanticPlanId,
        surfaceRealizationId,
        selectedEventIds: plannedEvents.map(row => row.event.id),
        selectedBundleIds: structural.importedBundleIds
      },
      realizationFeature: {
        value: structural.confidence,
        calibrated: false,
        selectionCompetitive: false,
        status: "provisional_uncalibrated"
      },
      responseForm: input.requirementField?.responseForm ?? null,
      constructionMemory: {
        bundleCount: input.languageMemory.importedConstructionBundles.length,
        creativeEventCount: input.languageMemory.importedConstructionBundles
          .reduce((sum, bundle) => sum + (bundle.creativeEvents?.length ?? 0), 0),
        selectedEventCount: plannedEvents.length,
        selectedBundleIds: binding.sourceBundleIds,
        rawEvidenceBodyRead: false
      }
    })
  };
}

function creativeRequestContentTerms(input: SpeakInput): SurfaceTerm[] {
  const controlSpans = (input.requirementField?.requiredFeatures ?? [])
    .filter(requirement => requirement.origin.semanticRoleId === "role.request.requirement.v1")
    .map(requirement => requirement.origin.requestSpan)
    .filter(span => span.charEnd > span.charStart);
  const controlBoundary = controlSpans.reduce((end, span) => Math.max(end, span.charEnd), 0);
  const requestText = input.entailment.claim.text;
  const tokens = [...requestText.matchAll(/[\p{Letter}\p{Mark}\p{Number}_]+/gu)].map(match => {
    const utf16Start = match.index ?? 0;
    const text = match[0];
    const start = [...requestText.slice(0, utf16Start)].length;
    return { text, start, end: start + [...text].length };
  });
  const selected = tokens
    .filter(token => token.start >= controlBoundary)
    .filter(token => [...token.text].length >= 3 || [...token.text].every(char => /\p{Number}/u.test(char)))
    .slice(-12);
  const bySurface = new Map<string, SurfaceTerm>();
  for (const token of selected) {
    const key = token.text.normalize("NFKC").toLocaleLowerCase();
    if (!key || bySurface.has(key)) continue;
    bySurface.set(key, {
      id: `surface.term:${hash32(`creative:${key}`).toString(16)}`,
      text: token.text,
      source: "construct",
      weight: 0.88
    });
  }
  return [...bySurface.values()];
}

function creativeResponseExtentHints(input: SpeakInput): LearnedResponseExtentHint[] {
  const hints: LearnedResponseExtentHint[] = [];
  const seen = new Set<string>();
  for (const requirement of input.requirementField?.requiredFeatures ?? []) {
    const trace = jsonRecord(requirement.trace);
    const activationTrace = jsonRecord(trace.activationTrace);
    const responseExtent = jsonRecord(activationTrace.responseExtent);
    const unitSurface = stringFrom(responseExtent.unitSurface);
    const wordsPerUnit = typeof responseExtent.wordsPerUnit === "number"
      && Number.isFinite(responseExtent.wordsPerUnit)
      ? responseExtent.wordsPerUnit
      : 0;
    if (!unitSurface || !Number.isFinite(wordsPerUnit) || wordsPerUnit <= 0) continue;
    const key = `${requirement.origin.learnedFrameOrPatternId}\u0001${requirement.origin.requestSpan.charStart}\u0001${unitSurface}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hints.push({
      unitSurface,
      wordsPerUnit,
      requestSpan: {
        charStart: requirement.origin.requestSpan.charStart,
        charEnd: requirement.origin.requestSpan.charEnd
      },
      sourcePatternId: requirement.origin.learnedFrameOrPatternId
    });
  }
  return hints;
}

function creativeDefaultTargetWords(input: SpeakInput): number {
  const detail = clamp01(input.requirementField?.brevityDetailBalance ?? 0.5);
  const format = clamp01(input.requirementField?.formatConstraintStrength ?? 0);
  return Math.round(120 + detail * 80 + format * 40);
}

function structuralCreativeSelectionBindingFromSurface(candidate: Pick<SurfaceCandidate, "id" | "audit">): {
  semanticCandidateId: string;
  semanticPlanId: string;
  surfaceRealizationId: string;
} | undefined {
  const binding = jsonRecord(jsonRecord(candidate.audit).selectionBinding);
  const semanticCandidateId = stringFrom(binding.semanticCandidateId);
  const semanticPlanId = stringFrom(binding.semanticPlanId);
  const surfaceRealizationId = stringFrom(binding.surfaceRealizationId);
  if (!semanticCandidateId || !semanticPlanId || !surfaceRealizationId) return undefined;
  if (surfaceRealizationId !== candidate.id) return undefined;
  return { semanticCandidateId, semanticPlanId, surfaceRealizationId };
}

function structuralCreativeLanguageScore(candidate: SurfaceCandidate, input: SpeakInput): LanguageMemoryScore {
  const audit = jsonRecord(candidate.audit);
  const typedEventGraph = jsonRecord(audit.typedEventGraph);
  const importedBundleIds = uniqueStrings(
    arrayRecords(typedEventGraph.events)
      .map(event => stringFrom(event.constructionBundleId))
      .filter((id): id is string => Boolean(id))
  );
  const semanticSelectionValue = clamp01(
    input.selectedCandidate?.scores.languageRealizability
    ?? input.selectedCandidate?.scores.realizability
    ?? candidate.fit
  );
  const binding = structuralCreativeSelectionBindingFromSurface(candidate);
  return {
    activation: semanticSelectionValue,
    information: 0,
    fit: semanticSelectionValue,
    orderScores: [],
    audit: toJsonValue({
      source: "mouth.english_structural_creative.score",
      role: "selected_semantic_plan_realization_feature",
      selectionCompetitive: false,
      calibrated: false,
      featureStatus: "provisional_uncalibrated",
      semanticCandidateId: binding?.semanticCandidateId ?? null,
      semanticPlanId: binding?.semanticPlanId ?? null,
      surfaceRealizationId: binding?.surfaceRealizationId ?? null,
      value: semanticSelectionValue,
      candidateScoreTrace: input.selectedCandidate?.scoreTrace ?? [],
      importedConstructionBundleIdsUsed: importedBundleIds,
      hiddenWeights: false
    })
  };
}

function learnedCreativeProposalCandidate(
  invention: InventionConstructState,
  plan: SurfacePlan,
  discoursePlan: DiscoursePlan,
  input: SpeakInput,
  priorPieces: readonly ImportedSurfacePiece[]
): SurfaceCandidate | undefined {
  const trace = jsonRecord(invention.trace);
  const realization = jsonRecord(trace.proposalRealization);
  const realizationPath = stringFrom(realization.path);
  if (realizationPath !== "learned_continuation" && realizationPath !== "learned_structural_composition") return undefined;
  const text = tidySurface(invention.proposalSurface);
  if (!text || !admissibleMouthSurface(text)) return undefined;
  const evidenceIds = invention.basisEvidenceIds.filter(id => input.evidence.some(span => String(span.id) === String(id)));
  const sourcePieceIds = uniqueStrings([
    ...stringArrayFromJson(realization.sourcePieceIds),
    ...stringArrayFromJson(realization.structuralSourceIds),
    ...invention.basisPriorIds
  ]);
  return {
    id: "candidate:generated:creative:learned-proposal",
    style: "surface.path.generated.creative.learned_proposal",
    path: "generated",
    claimBasis: "invented",
    text,
    evidenceIds,
    fit: clamp01(0.72 + invention.supportScore * 0.12 + invention.noveltyScore * 0.1 + (1 - invention.riskScore) * 0.06),
    importedPieceIds: uniqueStrings([
      ...sourcePieceIds,
      ...priorPieces.filter(piece => containsSurface(text, piece.text) || overlapsClaim(piece.text, text)).map(piece => piece.id)
    ]),
    discoursePlan,
    boundaryDecisions: []
  };
}

function selectedNonEventCreativeMouthHandoff(input: SpeakInput): boolean {
  if (input.requestedAuthority !== "creative") return false;
  const invention = inventionConstructState(input.construct);
  if (!invention) return false;
  const realization = jsonRecord(jsonRecord(invention.trace).proposalRealization);
  return realization.path === "mouth_non_event_realization_deferred";
}

function creativeArtifactCandidate(input: SpeakInput, discoursePlan: DiscoursePlan): SurfaceCandidate | undefined {
  const artifactSurfaces = uniqueStrings(input.construct.artifacts
    .slice(0, 4)
    .map(artifactPoint)
    .filter(Boolean));
  if (!artifactSurfaces.length) return undefined;
  const text = joinSurfaceSentences(artifactSurfaces);
  if (!admissibleMouthSurface(text)) return undefined;
  return {
    id: "candidate:generated:creative:artifact",
    style: "surface.path.generated.creative.artifact",
    path: "generated",
    claimBasis: "invented",
    text,
    evidenceIds: [],
    fit: 0.72,
    importedPieceIds: [],
    discoursePlan,
    boundaryDecisions: []
  };
}

function creativeAnchoredAssembly(
  variantId: string,
  frames: readonly RealizationFrame[],
  discoursePlan: DiscoursePlan,
  languageMemory: LanguageMemoryRuntimeState
): DiscourseAssembly {
  const units = frames.map((frame, index): DiscourseUnit => {
    const existing = discoursePlan.units.find(unit => unit.frameIds.includes(frame.id));
    return {
      ...(existing ?? {
        role: frame.role,
        groupId: `discourse.group.creative.${frame.role}`,
        generationExtent: Math.max(12, frame.propositionAtoms.length * 6),
        targetDetailProfileId: discoursePlan.targetDetailProfileId,
        targetStyleProfileId: discoursePlan.targetStyleProfileId,
        registerVector: discoursePlan.registerVector
      }),
      id: `disc:creative:${variantId}:${index}`,
      frameIds: [frame.id],
      sentenceIndex: index,
      boundaryBefore: index === 0 ? "none" : "sentence"
    };
  });
  const variantPlan: DiscoursePlan = { ...discoursePlan, units };
  const surfaces = units.map((unit, index) => ({ unit, text: anchoredTextForFrames(unit, frames[index] ? [frames[index]!] : []) }));
  return assembleAnchoredSurfaces({ discoursePlan: variantPlan, surfaces, languageMemory });
}

function creativeRoleRank(role: SurfaceRole): number {
  if (role === "instruction" || role === "conclusion") return 0;
  if (role === "answer") return 1;
  if (role === "support" || role === "example") return 2;
  return 3;
}

function uniqueSurfaceCandidates(candidates: readonly SurfaceCandidate[]): SurfaceCandidate[] {
  const seen = new Set<string>();
  const out: SurfaceCandidate[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    out.push(candidate);
  }
  return out;
}

function conversationMemoryCandidate(
  input: SpeakInput,
  discoursePlan: DiscoursePlan,
  languageMemory: LanguageMemoryRuntime,
  generationWorkBudget: MouthGenerationWorkBudget
): SurfaceCandidate | undefined {
  if (semanticAnswerConstructState(input.construct)) return undefined;
  if (generatedConstructSurface(input.construct)) return undefined;
  if (input.construct.program || isWorkspaceKernelSpeakInput(input)) return undefined;
  if (input.evidence.length || input.entailment.evidenceIds.length) return undefined;
  if (importSummaryRequested(input.entailment.claim.text)) return undefined;
  if (input.entailment.force !== "invented" && (input.entailment.verdict === "unknown" || input.entailment.verdict === "underdetermined")) return undefined;
  const generationExtent = claimMouthGenerationWork(
    generationWorkBudget,
    Math.max(18, Math.min(72, discoursePlan.units[0]?.generationExtent ?? 36))
  );
  if (generationExtent === undefined) return undefined;
  const generation = languageMemory.generate({
    state: input.languageMemory,
    targetLanguageProfile: input.languageProfile,
    contextSymbols: [input.entailment.claim.text],
    requiredTerms: [],
    frames: [],
    generationExtent,
    styleProfileId: discoursePlan.targetStyleProfileId,
    registerVector: discoursePlan.registerVector,
    detailProfileId: discoursePlan.targetDetailProfileId
  });
  const generatedText = usableConversationMemoryText(generation.text, input.entailment.claim.text);
  const text = generatedText && admissibleLearnedSurface(generatedText, generation) ? generatedText : undefined;
  if (!text) return undefined;
  if (isBoundaryGlyph(text) || ![...text].some(char => isLetterChar(char) || isDigitChar(char)) || looksLikeOrphanLanguageFragment(text)) return undefined;
  if (generatedText && questionEchoHits(text, input.entailment.claim.text).length) return undefined;
  return {
    id: "candidate:generated:conversation-memory",
    style: "surface.path.generated.conversation_memory",
    path: "generated",
    text,
    evidenceIds: [],
    fit: clamp01(0.46 + generation.confidence * 0.32 + input.languageMemory.competenceVector.generationReliability * 0.18),
    importedPieceIds: generationImportedPriorIds(generation),
    generation,
    discoursePlan,
    boundaryDecisions: generation.discourse.boundaries.map(boundary => ({
      fromUnitId: boundary.betweenMoveIds[0],
      toUnitId: boundary.betweenMoveIds[1],
      kind: "sentence" as const,
      text: boundary.text,
      source: boundary.source,
      boundarySource: discoursePlan.boundaryProfile.boundarySource,
      repeatedBoundaryPenalty: 0
    }))
  };
}

function usableConversationMemoryText(text: string, question: string): string | undefined {
  const clean = tidySurface(text);
  if (!clean) return undefined;
  if (isBoundaryGlyph(clean) || ![...clean].some(char => isLetterChar(char) || isDigitChar(char)) || looksLikeOrphanLanguageFragment(clean)) return undefined;
  if (questionEchoHits(clean, question).length) return undefined;
  return clean;
}

function conversationContextSurface(text: string, generationExtent: number): string | undefined {
  const clean = tidySurface(text);
  if (!clean || /[?？؟]/u.test(clean)) return undefined;
  const tokens = splitWhitespace(clean)
    .map(stripOuterSurfaceBoundary)
    .filter(token => [...token].some(char => isLetterChar(char) || isDigitChar(char)));
  if (tokens.length < 4) return undefined;
  const selected = tokens.slice(tokens.length > 5 ? 1 : 0, Math.max(tokens.length, 1)).slice(0, Math.max(4, Math.min(24, generationExtent)));
  const surface = ensureSurfaceSentence(selected.join(" "));
  if (!surface || questionEchoHits(surface, text).includes("surface.reject.echo.exact")) return undefined;
  return surface;
}

function semanticTemporalCounterexampleSurface(facts: readonly SemanticAnswerFact[]): string | undefined {
  const rejection = facts.find(fact => fact.relationId === LOCAL_ANSWER_RELATION_IDS.polarityReject);
  const support = facts.find(fact => fact.relationId === LOCAL_ANSWER_RELATION_IDS.temporalCounterexample);
  if (!rejection || !support) return undefined;
  const supportSurface = temporalSupportSurface(support);
  return supportSurface || undefined;
}

function temporalSupportSurface(fact: SemanticAnswerFact): string {
  const marker = stripOuterSurfaceBoundary(normalizeEvidenceSentence(fact.predicate));
  const withoutListMarkup = normalizeEvidenceSentence(fact.object)
    .split(/\r?\n/u)
    .map(line => line.replace(/^\s*[*#;:|]+\s*/u, ""))
    .join(" ")
    .replace(/^\s*[*#;:|]+\s*/u, "");
  const cleaned = collapseRepeatedSentenceSegments(withoutListMarkup);
  if (!cleaned) return "";
  const sentences = splitSurfaceSentences(cleaned).map(tidySurface).filter(Boolean);
  if (!marker || sentences.length < 2) return cleaned;
  const markerIndex = sentences.findIndex(sentence => containsSurface(sentence, marker));
  if (markerIndex <= 0) return cleaned;
  return joinSurfaceSentences([sentences[markerIndex]!, ...sentences.filter((_, index) => index !== markerIndex)]);
}

interface LearnedNegativeBridge {
  requestHead: string;
  bridge: string;
  priorIds: string[];
  confidence: number;
}

function learnedTemporalCounterexampleCandidate(discoursePlan: DiscoursePlan, input: SpeakInput): SurfaceCandidate | undefined {
  const state = semanticAnswerConstructState(input.construct);
  if (!state?.certificationBoundary.externalFactCertification) return undefined;
  const facts = uniquePriorBoundFacts(state.selectedFacts.length ? state.selectedFacts : state.activatedNeighborhood);
  const rejection = facts.find(fact => fact.relationId === LOCAL_ANSWER_RELATION_IDS.polarityReject);
  const support = facts.find(fact => fact.relationId === LOCAL_ANSWER_RELATION_IDS.temporalCounterexample);
  if (!rejection || !support) return undefined;
  const subject = normalizeEvidenceSentence(rejection.subject || state.selectedSubject);
  const predicate = stripOuterSurfaceBoundary(normalizeEvidenceSentence(rejection.object || rejection.predicate));
  const supportSurface = temporalSupportSurface(support);
  if (!subject || !predicate || !supportSurface) return undefined;
  const bridge = learnedNegativeBridge({
    requestText: input.entailment.claim.text,
    subject,
    predicate,
    languageMemory: input.languageMemory
  });
  const evidenceIds = uniqueEvidenceIds([
    ...(rejection.evidenceIds ?? []).map(id => id as EvidenceId),
    ...(support.evidenceIds ?? []).map(id => id as EvidenceId),
    ...state.certificationBoundary.evidenceSpanIds.map(id => id as EvidenceId)
  ]);
  if (!bridge) {
    if (!admissibleMouthSurface(supportSurface) || questionEchoHits(supportSurface, input.entailment.claim.text).length) return undefined;
    return {
      id: "candidate:generated:semantic-temporal-counterexample",
      style: "surface.path.generated.semantic_temporal_counterexample.source",
      path: "generated",
      text: supportSurface,
      evidenceIds,
      fit: 0.78,
      importedPieceIds: [],
      discoursePlan,
      boundaryDecisions: []
    };
  }
  const conclusion = tidySurface([subject, bridge.requestHead, bridge.bridge, predicate].filter(Boolean).join(" "));
  if (!conclusion || containsInternalSurfaceArtifact(conclusion) || conclusion.includes("¬")) return undefined;
  const text = joinSurfaceSentences([conclusion, supportSurface]);
  if (!admissibleMouthSurface(text) || questionEchoHits(text, input.entailment.claim.text).length) return undefined;
  return {
    id: "candidate:generated:semantic-temporal-counterexample",
    style: "surface.path.generated.semantic_temporal_counterexample",
    path: "generated",
    text,
    evidenceIds,
    fit: clamp01(0.78 + bridge.confidence * 0.18),
    importedPieceIds: bridge.priorIds,
    discoursePlan,
    boundaryDecisions: []
  };
}

function learnedNegativeBridge(input: {
  requestText: string;
  subject: string;
  predicate: string;
  languageMemory: LanguageMemoryRuntimeState;
}): LearnedNegativeBridge | undefined {
  const request = learnedSurfaceTokens(input.requestText);
  const subject = learnedSurfaceTokens(input.subject);
  if (!request.length || !subject.length) return undefined;
  const subjectStart = surfaceTokenSubsequenceIndex(request, subject);
  if (subjectStart <= 0) return undefined;
  const requestedHead = request[0];
  if (!requestedHead) return undefined;
  const excluded = new Set([
    ...request.map(token => token.key),
    ...learnedSurfaceTokens(input.predicate).map(token => token.key)
  ]);
  const rows = learnedLanguageSurfaceRows(input.languageMemory);
  const candidates = new Map<string, {
    surfaceMass: Map<string, number>;
    headMass: Map<string, number>;
    occurrences: number;
    supportMass: number;
    priorIds: Set<string>;
  }>();
  let continuationCount = 0;
  for (const row of rows) {
    const tokens = learnedSurfaceTokens(row.text);
    const seenInRow = new Set<string>();
    for (let index = 0; index < tokens.length - 1; index++) {
      const head = tokens[index];
      const next = tokens[index + 1];
      if (!head || !next || head.key !== requestedHead.key) continue;
      if (!learnedBridgeToken(next.surface) || excluded.has(next.key)) continue;
      continuationCount++;
      const candidate = candidates.get(next.key) ?? {
        surfaceMass: new Map<string, number>(),
        headMass: new Map<string, number>(),
        occurrences: 0,
        supportMass: 0,
        priorIds: new Set<string>()
      };
      candidate.occurrences++;
      candidate.supportMass += Math.max(0.05, row.support);
      candidate.surfaceMass.set(next.surface, (candidate.surfaceMass.get(next.surface) ?? 0) + Math.max(0.05, row.support));
      candidate.headMass.set(head.surface, (candidate.headMass.get(head.surface) ?? 0) + Math.max(0.05, row.support));
      if (!seenInRow.has(next.key)) candidate.priorIds.add(row.id);
      seenInRow.add(next.key);
      candidates.set(next.key, candidate);
    }
  }
  const ranked = [...candidates.entries()]
    .filter(([, candidate]) => candidate.occurrences >= 3 && candidate.priorIds.size >= 3)
    .map(([key, candidate]) => ({
      key,
      ...candidate,
      score: candidate.occurrences + candidate.priorIds.size * 0.8 + candidate.supportMass * 0.2
    }))
    .sort((left, right) => right.score - left.score || right.occurrences - left.occurrences || left.key.localeCompare(right.key));
  const selected = ranked[0];
  if (!selected || continuationCount <= 0) return undefined;
  const runner = ranked[1];
  const share = selected.occurrences / continuationCount;
  const dominance = runner ? selected.score / Math.max(0.001, runner.score) : Number.POSITIVE_INFINITY;
  if (share < 0.45 && dominance < 1.6) return undefined;
  const bridge = strongestLearnedSurface(selected.surfaceMass);
  const requestHead = strongestLearnedSurface(selected.headMass);
  if (!bridge || !requestHead) return undefined;
  return {
    requestHead,
    bridge,
    priorIds: [...selected.priorIds].sort().slice(0, 24),
    confidence: clamp01(0.42 + Math.min(0.4, share * 0.5) + Math.min(0.18, Math.max(0, dominance - 1) * 0.12))
  };
}

function learnedLanguageSurfaceRows(state: LanguageMemoryRuntimeState): Array<{ id: string; text: string; support: number }> {
  const rows: Array<{ id: string; text: string; support: number }> = [];
  for (const frame of state.importedSemanticFrames.slice(0, 2048)) {
    for (const surface of learnedSemanticFrameSurfaces(frame).slice(0, 4)) rows.push({ id: frame.id, text: surface, support: frame.alpha });
  }
  for (const unit of state.importedUnits.slice(0, 512)) {
    if (unit.unitKind === "phrase" || unit.unitKind === "symbol") rows.push({ id: unit.id, text: unit.text, support: unit.alpha });
  }
  for (const pattern of state.importedPatterns.slice(0, 256)) {
    for (const surface of patternSurfaceKeys(pattern).slice(0, 8)) rows.push({ id: pattern.id, text: surface, support: pattern.support });
  }
  for (const observation of state.importedObservations.slice(0, 1200)) {
    rows.push({ id: observation.id, text: [...observation.history.slice(-4), observation.symbol].join(" "), support: clamp01(Math.log2(1 + observation.count) * Math.max(0.1, observation.fieldWeight) / 12) });
  }
  const seen = new Set<string>();
  return rows.filter(row => {
    const text = normalizeEvidenceSentence(row.text);
    const key = `${row.id}\u0001${text}`;
    if (!text || seen.has(key)) return false;
    seen.add(key);
    row.text = text;
    return true;
  });
}

function learnedSemanticFrameSurfaces(frame: LanguageMemoryRuntimeState["importedSemanticFrames"][number]): string[] {
  const surfaces = [...semanticFrameSurfaces(frame)];
  const visit = (value: JsonValue | undefined, depth: number) => {
    if (depth > 4 || surfaces.length >= 32) return;
    if (typeof value === "string") {
      const clean = normalizeEvidenceSentence(value);
      if (splitWhitespace(clean).length >= 4 && [...clean].some(isLetterChar) && !looksLikeInternalDiagnosticCode(clean.toLocaleLowerCase())) surfaces.push(clean);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) visit(child, depth + 1);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) visit(child, depth + 1);
  };
  visit(frame.frameJson, 0);
  return uniqueStrings(surfaces);
}

function learnedSurfaceTokens(text: string): Array<{ surface: string; key: string }> {
  return splitWhitespace(tidySurface(text))
    .map(stripOuterSurfaceBoundary)
    .map(surface => surface.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ""))
    .filter(surface => [...surface].some(char => isLetterChar(char) || isDigitChar(char)))
    .map(surface => ({ surface, key: surface.normalize("NFKC").toLocaleLowerCase() }));
}

function surfaceTokenSubsequenceIndex(haystack: readonly { key: string }[], needle: readonly { key: string }[]): number {
  if (!needle.length || needle.length > haystack.length) return -1;
  for (let index = 0; index <= haystack.length - needle.length; index++) {
    if (needle.every((token, offset) => haystack[index + offset]?.key === token.key)) return index;
  }
  return -1;
}

function learnedBridgeToken(surface: string): boolean {
  const chars = [...surface];
  if (!chars.length || chars.length > 24) return false;
  if (!chars.some(isLetterChar) || chars.some(isDigitChar)) return false;
  return !containsInternalSurfaceArtifact(surface) && !looksLikeInternalDiagnosticCode(surface.toLocaleLowerCase());
}

function strongestLearnedSurface(values: ReadonlyMap<string, number>): string | undefined {
  return [...values.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
}

function entitySurfaceOverlap(entity: string, surface: string): boolean {
  const entityUnits = surfaceEntityUnits(entity);
  if (!entityUnits.length) return false;
  const surfaceUnits = new Set(surfaceEntityUnits(surface));
  if (!surfaceUnits.size) return false;
  const hits = entityUnits.filter(unit => surfaceUnits.has(unit)).length;
  return hits >= Math.min(2, entityUnits.length) || hits / entityUnits.length >= 0.5;
}

function surfaceEntityUnits(text: string): string[] {
  return splitWhitespace(text.normalize("NFKC").toLocaleLowerCase())
    .map(unit => stripOuterSurfaceBoundary(unit).replace(/[^\p{L}\p{N}]+/gu, ""))
    .filter(unit => [...unit].length >= 3);
}

function rhetoricalLatticeCandidateFromFrames(
  plan: SurfacePlan,
  discoursePlan: DiscoursePlan,
  input: SpeakInput,
  languageMemory: LanguageMemoryRuntime,
  priorPieces: readonly ImportedSurfacePiece[],
  generationWorkBudget: MouthGenerationWorkBudget
): SurfaceCandidate | undefined {
  const frames = plan.realizationFrames.filter(frame => semanticFactFromRealizationConstraints(frame.realizationConstraints));
  if (!frames.length) return undefined;
  const contextSymbols = uniqueStrings([
    input.entailment.claim.text,
    semanticAnswerConstructState(input.construct)?.selectedSubject ?? "",
    ...frames.flatMap(frame => frame.propositionAtoms.map(atom => atom.text))
  ].filter(Boolean));
  const generationExtent = claimMouthGenerationWork(
    generationWorkBudget,
    Math.max(56, Math.min(192, discoursePlan.units.reduce((sum, unit) => sum + unit.generationExtent, 0) || 96))
  );
  if (generationExtent === undefined) return undefined;
  const generation = languageMemory.generate({
    state: input.languageMemory,
    targetLanguageProfile: input.languageProfile,
    contextSymbols,
    requiredTerms: [],
    semanticFrameIds: input.languageMemory.importedSemanticFrames.map(frame => frame.id).slice(0, 64),
    frames,
    generationExtent,
    styleProfileId: discoursePlan.targetStyleProfileId,
    registerVector: discoursePlan.registerVector,
    detailProfileId: discoursePlan.targetDetailProfileId
  });
  const learnedText = admissibleLearnedSurface(generation.text, generation) ? tidySurface(generation.text) : "";
  const text = learnedText;
  if (!text) return undefined;
  const evidenceIds = uniqueEvidenceIds(frames.flatMap(frame => frame.evidenceBinding?.evidenceId ? [frame.evidenceBinding.evidenceId] : []));
  const pieceIds = uniqueStrings([
    ...generationImportedPriorIds(generation),
    ...priorPieces.filter(piece => containsSurface(text, piece.text) || overlapsClaim(piece.text, text)).map(piece => piece.id)
  ]);
  return {
    id: "candidate:generated:rhetorical-lattice",
    style: "surface.path.generated.rhetorical_sentence_lattice",
    path: "generated",
    text,
    evidenceIds,
    fit: clamp01(0.68 + generation.confidence * 0.24 + (generation.discourse.discourseScore ?? 0) * 0.08),
    importedPieceIds: pieceIds,
    generation,
    discoursePlan,
    sentenceCandidates: [{
      unitId: "disc:rhetorical-lattice",
      role: "answer",
      text,
      generation,
      coveredRequiredTerms: stringArrayFromJson(jsonRecord(generation.audit).requiredTermIdsCovered),
      coveredPropositionAtoms: stringArrayFromJson(jsonRecord(generation.audit).propositionAtomIdsCovered),
      importedPriorIds: generationImportedPriorIds(generation),
      orderUsage: generation.orderUsage,
      preservationScore: semanticPreservation({ text, plan, entailment: input.entailment }).score,
      stopReason: generation.stoppedBy
    }],
    boundaryDecisions: generation.discourse.boundaries.map(boundary => ({
      fromUnitId: boundary.betweenMoveIds[0],
      toUnitId: boundary.betweenMoveIds[1],
      kind: "sentence" as const,
      text: boundary.text,
      source: boundary.source,
      boundarySource: discoursePlan.boundaryProfile.boundarySource,
      repeatedBoundaryPenalty: 0
    }))
  };
}

function preserveImportSummaryCoverage(text: string, plan: SurfacePlan, role: DiscourseUnitRole): string {
  if (role !== "answer") return text;
  const summary = plan.orderedPoints.find(point => point.force === "underdetermined" && point.role === "answer")?.proposition ?? plan.orderedPoints[0]?.proposition ?? "";
  if (!summary.trim()) return text;
  const clean = tidySurface(text);
  if (!clean) return summary;
  const summaryHead = splitWhitespace(summary)[0] ?? "";
  const requiredNumbers = uniqueStrings(plan.orderedPoints.flatMap(point => invariantSymbols(point.proposition)).filter(symbol => symbol.kind === "number").map(symbol => symbol.text));
  const missingNumbers = requiredNumbers.filter(number => !clean.includes(number));
  if (summaryHead && clean.includes(summaryHead) && !containsSurface(clean, summary)) return summary;
  if (!missingNumbers.length) return clean;
  if (containsSurface(summary, clean) || weightedJaccard(featureSet(clean, 256), featureSet(summary, 256)) > 0.55) return summary;
  if (containsSurface(text, summary)) return text;
  return renderDiscourseUnitBoundary(clean, summary, "sentence", sentenceBoundaryForInput(plan));
}

function importSummaryCaveatSurface(frames: readonly RealizationFrame[], generatedText: string): string {
  return frames.find(frame => frame.caveat?.reason)?.caveat?.reason ?? generatedText;
}

function governedActionPreviewCandidate(input: SpeakInput, discoursePlan: DiscoursePlan): SurfaceCandidate | undefined {
  const candidate = input.selectedCandidate;
  const surface = governedActionPreviewSurface(candidate);
  if (!candidate || !surface) return undefined;
  const audit = jsonRecord(candidate.audit);
  return {
    id: "candidate:generated:governed-action-preview",
    style: "surface.path.generated.governed_action_preview",
    path: "generated",
    text: surface,
    evidenceIds: candidate.evidenceIds,
    fit: 0.98,
    importedPieceIds: [],
    discoursePlan,
    boundaryDecisions: [],
    exactSurface: true,
    audit: toJsonValue({ selectedCandidateId: candidate.id, source: "capability.plan", planId: audit.planId })
  };
}

function governedActionPreviewSurface(candidate: CandidateSurface | undefined): string | undefined {
  if (candidate?.kind !== "action-preview" || !candidate.boundaries.includes("action-plan-not-executed")) return undefined;
  const audit = jsonRecord(candidate.audit);
  const permission = jsonRecord(audit.permission);
  const planId = stringFrom(audit.planId);
  const capabilityId = stringFrom(audit.capabilityId);
  const phase = stringFrom(audit.phase);
  if (audit.source !== "capability.plan"
    || audit.status !== "planned"
    || audit.executionState !== "not_executed"
    || audit.actionReceiptId !== null
    || !planId
    || !capabilityId
    || !phase
    || !["read", "prepare", "commit"].includes(phase)
    || permission.dryRun !== true
    || !admissibleMouthSurface(candidate.answer)) return undefined;
  const document = jsonObjectSurface(candidate.answer);
  if (!document
    || document.artifactKind !== "action-preview"
    || document.planId !== planId
    || document.capabilityId !== capabilityId
    || document.phase !== phase
    || document.executionState !== "not_executed"
    || (document.status !== undefined && document.status !== "planned")
    || (document.actionReceiptId !== undefined && document.actionReceiptId !== null)) return undefined;
  if (document.permission !== undefined && jsonRecord(document.permission).dryRun !== true) return undefined;
  return candidate.answer;
}

function jsonObjectSurface(surface: string): Record<string, JsonValue> | undefined {
  const clean = surface.trim();
  if (!clean) return undefined;
  const fenced = /^```json[\t ]*\r?\n([\s\S]*?)\r?\n```$/iu.exec(clean);
  const payload = fenced?.[1] ?? clean;
  if (!fenced && clean.startsWith("```")) return undefined;
  try {
    const parsed = JSON.parse(payload) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, JsonValue>
      : undefined;
  } catch {
    return undefined;
  }
}

function constructAnchoredCandidate(plan: SurfacePlan, discoursePlan: DiscoursePlan, input: SpeakInput, priorPieces: readonly ImportedSurfacePiece[]): SurfaceCandidate | undefined {
  void priorPieces;
  const selectedKind = input.selectedCandidate?.kind;
  const programAuthorityCandidate = input.requestedAuthority === "program"
    && (selectedKind === "program-proposal" || selectedKind === "workspace-proposal");
  if (!programAuthorityCandidate && !isWorkspaceKernelSpeakInput(input)) return undefined;
  const workspacePlanSurface = selectedWorkspacePlanSurface(input.selectedCandidate);
  if (workspacePlanSurface) {
    return {
      id: "candidate:generated:construct-anchored",
      style: "surface.path.generated.construct_anchored.workspace_plan",
      path: "generated",
      text: workspacePlanSurface,
      evidenceIds: input.selectedCandidate?.evidenceIds ?? [],
      fit: 0.98,
      importedPieceIds: [],
      discoursePlan,
      boundaryDecisions: [],
      exactSurface: true,
      audit: toJsonValue({ selectedCandidateId: input.selectedCandidate?.id ?? null, source: "workspace.patch_transaction_plan" })
    };
  }
  const points = plan.orderedPoints.filter(point => point.proposition.trim() && programOrArtifactSurfacePoint(point));
  const requestPathAnchors = invariantSymbols(input.entailment.claim.text)
    .filter(symbol => symbol.kind === "symbol" && (symbol.text.includes("/") || symbol.text.includes("\\")))
    .map(symbol => stripOuterSurfaceBoundary(symbol.text))
    .filter(Boolean);
  const requestFeatures = featureSet(input.entailment.claim.text, 256);
  const sourceRow = requestPathAnchors.length
    ? input.evidence
      .map(span => ({
        span,
        text: normalizeEvidenceSentence(span.text || span.textPreview || ""),
        fit: weightedJaccard(requestFeatures, featureSet(span.text || span.textPreview || "", 256))
      }))
      .filter(row => row.text && requestPathAnchors.some(anchor => containsSurface(row.text, anchor)) && admissibleMouthSurface(row.text))
      .sort((left, right) => right.fit - left.fit || right.span.alpha - left.span.alpha || String(left.span.id).localeCompare(String(right.span.id)))[0]
    : undefined;
  const pointText = joinSurfaceSentences(uniqueStrings(points.map(point => tidySurface(point.proposition))).slice(0, 6));
  const text = sourceRow ? preserveSurfaceExtent(sourceRow.text, input.maxLength ?? 1200) : pointText;
  if (!admissibleMouthSurface(text)) return undefined;
  return {
    id: "candidate:generated:construct-anchored",
    style: "surface.path.generated.construct_anchored",
    path: "generated",
    text,
    evidenceIds: sourceRow ? [sourceRow.span.id] : uniqueEvidenceIds(points.flatMap(point => point.evidenceIds)),
    fit: 0.88,
    importedPieceIds: [],
    discoursePlan,
    boundaryDecisions: []
  };
}

function selectedWorkspacePlanSurface(candidate: CandidateSurface | undefined): string | undefined {
  if (candidate?.kind !== "workspace-proposal") return undefined;
  if (!candidate.boundaries.includes("workspace-plan-not-authorized") || !candidate.boundaries.includes("workspace-plan-not-executed")) return undefined;
  const audit = jsonRecord(candidate.audit);
  if (audit.source !== "workspace.patch_transaction_plan"
    || audit.authorizationGranted !== false
    || audit.executionState !== "not_executed"
    || typeof audit.planHash !== "string"
    || !Array.isArray(audit.operations)) return undefined;
  return admissibleMouthSurface(candidate.answer) ? candidate.answer : undefined;
}

function programOrArtifactSurfacePoint(point: SurfacePoint): boolean {
  const constraints = jsonRecord(point.realizationConstraints);
  return constraints.constructForce === "ProgramConstruct"
    || typeof constraints.artifactId === "string"
    || typeof constraints.programSurface === "object" && constraints.programSurface !== null;
}

function supportBoundaryCandidate(
  input: SpeakInput,
  discoursePlan: DiscoursePlan,
  languageMemory: LanguageMemoryRuntime,
  generationWorkBudget: MouthGenerationWorkBudget
): SurfaceCandidate | undefined {
  const supportState = insufficientSupportConstructState(input.construct);
  const importedLanguagePriorCount = input.languageMemory.importedLanguagePriorCount || numberFromJson(jsonRecord(input.brainMarker).importedLanguagePriorCount);
  const unanchoredImportedPrior = input.evidence.length === 0 && input.entailment.evidenceIds.length === 0 && importedLanguagePriorCount > 0;
  const verdict = proofGateVerdict(input.entailment) ?? (supportState || unanchoredImportedPrior ? "insufficient_evidence" : undefined);
  if (verdict !== "contradicted" && verdict !== "source_bound_only") return undefined;
  const text = supportBoundarySurfaceFromRuntime(input, verdict);
  if (!text) return undefined;
  if (verdict === "source_bound_only") {
    return {
      id: "candidate:generated:proof-boundary",
      style: "surface.path.generated.proof_boundary",
      path: "generated",
      text,
      evidenceIds: [],
      fit: 0.84,
      importedPieceIds: [],
      discoursePlan,
      boundaryDecisions: []
    };
  }
  const requiredTerm = { id: "surface.term.proof_boundary", text, weight: 0.92, source: "proof-boundary" };
  const frame = {
    id: "frame:proof-boundary",
    role: "caveat",
    force: "underdetermined",
    propositionAtoms: [{ id: "atom:proof-boundary", text, kind: "caveat", weight: 0.96, source: "proof-boundary" }],
    requiredTerms: [requiredTerm],
    targetLanguage: input.targetLanguage,
    targetScript: input.targetScript,
    styleProfileId: discoursePlan.targetStyleProfileId,
    registerVector: discoursePlan.registerVector,
    detailProfileId: discoursePlan.targetDetailProfileId
  };
  const generationExtent = claimMouthGenerationWork(
    generationWorkBudget,
    Math.max(24, Math.min(56, discoursePlan.units[0]?.generationExtent ?? 36))
  );
  if (generationExtent === undefined) return undefined;
  const generation = languageMemory.generate({
    state: input.languageMemory,
    targetLanguageProfile: input.languageProfile,
    contextSymbols: uniqueStrings([
      input.entailment.claim.text,
      supportState?.selectedMainSubject ?? "",
      ...(supportState?.requestedFocuses ?? []),
      text
    ]),
    requiredTerms: [requiredTerm],
    frames: [frame],
    generationExtent,
    styleProfileId: discoursePlan.targetStyleProfileId,
    registerVector: discoursePlan.registerVector,
    detailProfileId: discoursePlan.targetDetailProfileId
  });
  const generatedText = proofBoundaryGeneratedSurface(generation.text, text);
  if (!admissibleLearnedSurface(generatedText, generation)) return undefined;
  return {
    id: "candidate:generated:proof-boundary",
    style: "surface.path.generated.proof_boundary",
    path: "generated",
    text: generatedText,
    evidenceIds: input.entailment.evidenceIds.slice(0, 5),
    fit: 0.82,
    importedPieceIds: generationImportedPriorIds(generation),
    generation,
    discoursePlan,
    boundaryDecisions: []
  };
}

function supportBoundarySurfaceFromRuntime(input: SpeakInput, verdict: ProofGateVerdict): string {
  const claimText = normalizeEvidenceSentence(input.entailment.claim.text);
  const runtimeBoundary = boundarySurfaceFromRuntime(input.entailment, input.evidence, verdict);
  if (runtimeBoundary && !containsSurface(runtimeBoundary, claimText) && !looksLikeInternalDiagnosticCode(runtimeBoundary.toLocaleLowerCase())) return runtimeBoundary;
  return "";
}

function claimAnchorBoundarySurface(claimText: string): string {
  const units = splitWhitespace(claimText)
    .map(stripOuterSurfaceBoundary)
    .filter(Boolean);
  const searchUnits = claimText.includes("?") ? units.slice(1) : units;
  const spans: string[][] = [];
  let current: string[] = [];
  for (const unit of searchUnits) {
    if (orthographicAnchorUnit(unit)) current.push(unit);
    else if (current.length) {
      spans.push(current);
      current = [];
    }
  }
  if (current.length) spans.push(current);
  const selected = spans
    .filter(span => span.join("").length >= 3)
    .sort((left, right) => right.length - left.length || right.join(" ").length - left.join(" ").length)[0];
  return selected ? ensureSurfaceSentence(selected.join(" ")) : "";
}

function orthographicAnchorUnit(unit: string): boolean {
  if (!unit) return false;
  if (/^\p{N}+$/u.test(unit)) return false;
  return hasUppercaseLetter(unit) || hasUncasedNonLatinLetter(unit);
}

function proofBoundaryGeneratedSurface(generated: string, boundary: string): string {
  const clean = tidySurface(generated);
  if (!clean) return "";
  if (containsSurface(clean, boundary)) return clean;
  if (splitWhitespace(clean).length <= 2) return "";
  return renderDiscourseUnitBoundary(clean, boundary, "sentence", ".");
}

function stripPossessiveSurfaceSuffix(unit: string): string {
  if (unit.length <= 2) return unit;
  const last = unit[unit.length - 1] ?? "";
  const previous = unit[unit.length - 2] ?? "";
  if ((previous === "'" || previous === "’") && (last === "s" || last === "S")) return unit.slice(0, -2);
  return unit;
}

function isWorkspaceKernelSpeakInput(input: SpeakInput): boolean {
  return input.construct.nodes.some(node => node.id === "workspace.kernel.answer" || jsonRecord(node.metadata).schema === "scce.workspace_kernel.answer.v1");
}

function anchoredTextForFrames(unit: DiscourseUnit, frames: readonly RealizationFrame[]): string {
  const atoms = frames.flatMap(frame => frame.propositionAtoms);
  const proofBoundarySurface = frames.some(frame => frame.force === "underdetermined" || frame.force === "contradicted");
  const preferredKinds: PropositionAtom["kind"][] =
    unit.role === "caveat" ? ["caveat", "claim", "surface"] :
      unit.role === "instruction" ? ["program", "claim", "surface"] :
        unit.role === "example" || unit.role === "artifact_summary" ? ["artifact", "program", "claim", "surface"] :
          ["claim", "program", "artifact", "surface"];
  const primary = preferredKinds
    .flatMap(kind => atoms.filter(atom => atom.kind === kind))
    .sort((left, right) => right.weight - left.weight || left.text.length - right.text.length)[0];
  let text = normalizeEvidenceSentence(primary?.text ?? frames[0]?.propositionAtoms[0]?.text ?? "");
  const requiredTerms = uniqueSurfaceTerms(frames.flatMap(frame => frame.requiredTerms))
    .filter(term => (!proofBoundarySurface && term.weight >= 0.82) || term.source === "language-memory" || term.source === "correction")
    .map(term => term.text)
    .filter(term => !containsSurface(text, term))
    .slice(0, 8);
  if (requiredTerms.length && text.length <= 420) text = normalizeEvidenceSentence(`${text} ${requiredTerms.join(" ")}`);
  return text;
}

function assembleAnchoredSurfaces(input: { discoursePlan: DiscoursePlan; surfaces: readonly { unit: DiscourseUnit; text: string }[]; languageMemory: LanguageMemoryRuntimeState }): DiscourseAssembly {
  const ordered = input.discoursePlan.units
    .map(unit => ({ unit, surface: input.surfaces.find(surface => surface.unit.id === unit.id) }))
    .filter((row): row is { unit: DiscourseUnit; surface: { unit: DiscourseUnit; text: string } } => Boolean(row.surface));
  if (!ordered.length) return { text: "", boundaryDecisions: [] };
  let text = tidySurface(ordered[0]!.surface.text);
  const decisions: DiscourseAssembly["boundaryDecisions"] = [];
  const usedBoundaries: string[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const left = ordered[index - 1]!;
    const right = ordered[index]!;
    const decision = chooseDiscourseUnitBoundary({
      left: left.unit,
      right: right.unit,
      previousBoundaries: usedBoundaries,
      languageMemory: input.languageMemory,
      boundaryProfile: input.discoursePlan.boundaryProfile
    });
    usedBoundaries.push(decision.text);
    text = renderDiscourseUnitBoundary(text, right.surface.text, decision.kind, decision.text);
    decisions.push({
      fromUnitId: left.unit.id,
      toUnitId: right.unit.id,
      kind: decision.kind,
      text: decision.text,
      source: decision.source,
      boundarySource: decision.boundarySource,
      repeatedBoundaryPenalty: decision.repeatedBoundaryPenalty
    });
  }
  return { text: tidySurface(text), boundaryDecisions: decisions };
}

function framesForDiscourseUnit(unit: DiscourseUnit, plan: SurfacePlan): RealizationFrame[] {
  const frames = unit.frameIds.map(id => plan.realizationFrames.find(frame => frame.id === id)).filter((frame): frame is RealizationFrame => Boolean(frame));
  if (unit.role !== "caveat") return frames;
  return frames.map(frame => {
    const caveatText = frame.caveat?.reason;
    if (!caveatText) return frame;
    const caveatAtom = frame.propositionAtoms.find(atom => atom.kind === "caveat") ?? {
      id: `atom:${hash32(`${frame.id}:caveat:${caveatText}`).toString(16)}`,
      text: caveatText,
      kind: "caveat" as const,
      source: frame.pointId,
      weight: 0.96,
      evidenceIds: frame.evidenceBinding?.evidenceId ? [frame.evidenceBinding.evidenceId] : []
    };
    return {
      ...frame,
      role: "caveat" as const,
      propositionAtoms: [caveatAtom],
      requiredTerms: uniqueSurfaceTerms([
        ...frame.requiredTerms,
        { id: `surface.term:${hash32(caveatText).toString(16)}`, text: caveatText, source: "construct", weight: 0.96 }
      ])
    };
  });
}

function requiredTermsForDiscourseUnit(unit: DiscourseUnit, frames: readonly RealizationFrame[], plan: SurfacePlan): SurfaceTerm[] {
  if (frames.some(frame => semanticFactFromRealizationConstraints(frame.realizationConstraints))) {
    return [];
  }
  const terms = [...frames.flatMap(frame => frame.requiredTerms), ...plan.requiredTerms.filter(term => term.weight >= 0.82)];
  if (unit.role === "caveat") {
    for (const frame of frames) {
      const caveatText = frame.caveat?.reason;
      if (caveatText) terms.push({ id: `surface.term:${hash32(caveatText).toString(16)}`, text: caveatText, source: "construct", weight: 0.96 });
    }
  }
  return uniqueSurfaceTerms(terms);
}

function generationImportedPriorIds(generation: LanguageGenerationResult): string[] {
  return uniqueStrings([
    ...generation.importedLanguageUnitIdsUsed,
    ...generation.importedPhrasePatternIdsUsed,
    ...generation.importedObservationIdsUsed,
    ...generation.importedSemanticFrameIdsUsed,
    ...generation.importedNgramModelIdsUsed
  ]);
}

function aggregateLanguageGeneration(sentences: readonly SentenceCandidate[]): LanguageGenerationResult | undefined {
  const first = sentences[0]?.generation;
  if (!first) return undefined;
  const generations = sentences.map(sentence => sentence.generation);
  const audits = generations.map(generation => jsonRecord(generation.audit));
  return {
    ...first,
    text: tidySurface(sentences.map(sentence => sentence.text).join(" ")),
    symbols: generations.flatMap(generation => generation.symbols),
    phrasesUsed: uniqueStrings(generations.flatMap(generation => generation.phrasesUsed)),
    importedNgramModelIdsUsed: uniqueStrings(generations.flatMap(generation => generation.importedNgramModelIdsUsed)),
    importedObservationIdsUsed: uniqueStrings(generations.flatMap(generation => generation.importedObservationIdsUsed)),
    importedLanguageUnitIdsUsed: uniqueStrings(generations.flatMap(generation => generation.importedLanguageUnitIdsUsed)),
    importedPhrasePatternIdsUsed: uniqueStrings(generations.flatMap(generation => generation.importedPhrasePatternIdsUsed)),
    importedSemanticFrameIdsUsed: uniqueStrings(generations.flatMap(generation => generation.importedSemanticFrameIdsUsed)),
    orderUsage: generations.flatMap(generation => generation.orderUsage),
    averageInformation: mean(generations.map(generation => generation.averageInformation)),
    confidence: mean(generations.map(generation => generation.confidence)),
    stoppedBy: generations.some(generation => generation.stoppedBy === "generation_extent")
      ? "generation_extent"
      : generations.some(generation => generation.stoppedBy === "source_exhausted")
        ? "source_exhausted"
        : first.stoppedBy,
    audit: toJsonValue({
      ...jsonRecord(first.audit),
      source: "mouth.generated-selection.aggregate-language-generation",
      generatedSentenceCount: sentences.length,
      generatedSentences: sentences.map(sentence => ({
        unitId: sentence.unitId,
        role: sentence.role,
        stopReason: sentence.stopReason,
        preservationScore: sentence.preservationScore,
        importedPriorIds: sentence.importedPriorIds
      })),
      sentenceGenerationAudits: audits,
      semanticFactMaterialsUsed: audits.flatMap(audit => arrayRecords(audit.semanticFactMaterialsUsed)),
      answerRoleAssignments: audits.flatMap(audit => arrayRecords(audit.answerRoleAssignments)),
      selectedPieces: audits.flatMap(audit => arrayRecords(audit.selectedPieces)),
      demotedFacts: audits.flatMap(audit => arrayRecords(audit.demotedFacts)),
      requiredTermIdsCovered: uniqueStrings(audits.flatMap(audit => stringArrayFromJson(audit.requiredTermIdsCovered))),
      propositionAtomIdsCovered: uniqueStrings(audits.flatMap(audit => stringArrayFromJson(audit.propositionAtomIdsCovered))),
      warnings: uniqueStrings(audits.flatMap(audit => stringArrayFromJson(audit.warnings)))
    })
  };
}

function stringArrayFromJson(value: JsonValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function arrayLength(value: JsonValue | undefined): number {
  return Array.isArray(value) ? value.length : 0;
}

function arrayRecords(value: JsonValue | undefined): Array<Record<string, JsonValue>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, JsonValue> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function stringFromJson(value: JsonValue | undefined): string {
  return typeof value === "string" ? value : "";
}

function numberFromJson(value: JsonValue | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberFromJson(value: JsonValue | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function countRecord(value: JsonValue | undefined): Record<string, number> {
  const record = jsonRecord(value);
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    const count = numberFromJson(raw);
    if (count > 0) out[key] = count;
  }
  return out;
}

function countWarningsWithPrefix(runs: readonly Record<string, JsonValue>[], prefix: string): number {
  const normalizedPrefix = prefix.toLocaleLowerCase();
  let count = 0;
  for (const run of runs) {
    for (const warning of stringArrayFromJson(run.warnings)) {
      if (warning.toLocaleLowerCase().startsWith(normalizedPrefix)) count++;
    }
  }
  return count;
}

function sumNumbers(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function mergeCounts(records: readonly Record<string, number>[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const record of records) for (const [key, value] of Object.entries(record)) out[key] = (out[key] ?? 0) + value;
  return out;
}

function uniqueSurfaceTerms(terms: readonly SurfaceTerm[]): SurfaceTerm[] {
  const byId = new Map<string, SurfaceTerm>();
  for (const term of terms) {
    const existing = byId.get(term.id);
    if (!existing || term.weight > existing.weight) byId.set(term.id, term);
  }
  return [...byId.values()].sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text)).slice(0, 32);
}

function assembleDiscourseSentences(input: { discoursePlan: DiscoursePlan; sentences: readonly SentenceCandidate[]; languageMemory: LanguageMemoryRuntimeState }): DiscourseAssembly {
  const byUnit = new Map(input.sentences.map(sentence => [sentence.unitId, sentence]));
  const ordered = input.discoursePlan.units.map(unit => ({ unit, sentence: byUnit.get(unit.id) })).filter((row): row is { unit: DiscourseUnit; sentence: SentenceCandidate } => Boolean(row.sentence));
  if (!ordered.length) return { text: "", boundaryDecisions: [] };
  let text = tidySurface(ordered[0]!.sentence.text);
  const decisions: DiscourseAssembly["boundaryDecisions"] = [];
  const usedBoundaries: string[] = [];
  for (let index = 1; index < ordered.length; index++) {
    const left = ordered[index - 1]!;
    const right = ordered[index]!;
    const decision = chooseDiscourseUnitBoundary({
      left: left.unit,
      right: right.unit,
      previousBoundaries: usedBoundaries,
      languageMemory: input.languageMemory,
      boundaryProfile: input.discoursePlan.boundaryProfile
    });
    usedBoundaries.push(decision.text);
    text = renderDiscourseUnitBoundary(text, right.sentence.text, decision.kind, decision.text);
    decisions.push({
      fromUnitId: left.unit.id,
      toUnitId: right.unit.id,
      kind: decision.kind,
      text: decision.text,
      source: decision.source,
      boundarySource: decision.boundarySource,
      repeatedBoundaryPenalty: decision.repeatedBoundaryPenalty
    });
  }
  return { text: tidySurface(text), boundaryDecisions: decisions };
}

function chooseDiscourseUnitBoundary(input: {
  left: DiscourseUnit;
  right: DiscourseUnit;
  previousBoundaries: readonly string[];
  languageMemory: LanguageMemoryRuntimeState;
  boundaryProfile: BoundaryProfile;
}): { kind: DiscourseBoundaryKind; text: string; source: string; boundarySource: BoundaryProfile["boundarySource"]; repeatedBoundaryPenalty: number } {
  const sentenceKind = input.right.boundaryBefore === "sentence" || input.right.role === "caveat" || input.right.role === "example" || input.right.role === "artifact_summary";
  const candidates = discourseTransitionCandidates(input.languageMemory, sentenceKind, input.boundaryProfile);
  const structural = sentenceKind ? sentenceBoundaryFor(input.languageMemory, input.boundaryProfile) : inlineBoundaryFor(input.languageMemory, input.boundaryProfile);
  const all = [...candidates, structural];
  const ranked = all
    .map(candidate => {
      const repeated = input.previousBoundaries.filter(boundary => boundary === candidate.text).length;
      const repeatedBoundaryPenalty = repeated ? Math.min(0.7, repeated * input.boundaryProfile.repeatedBoundaryPenalty) : 0;
      const roleFit = boundaryRoleFit(candidate.text, input.left.role, input.right.role, sentenceKind, input.boundaryProfile);
      return { ...candidate, repeatedBoundaryPenalty, score: clamp01(candidate.support * 0.5 + roleFit * 0.38 + (sentenceKind ? 0.12 : 0.06) - repeatedBoundaryPenalty) };
    })
    .sort((a, b) => b.score - a.score || a.text.localeCompare(b.text));
  const selected = ranked[0] ?? { ...structural, repeatedBoundaryPenalty: 0 };
  return {
    kind: sentenceKind ? "sentence" : "within_sentence",
    text: selected.text,
    source: selected.source,
    boundarySource: selected.boundarySource,
    repeatedBoundaryPenalty: selected.repeatedBoundaryPenalty ?? 0
  };
}

function discourseTransitionCandidates(state: LanguageMemoryRuntimeState, sentenceKind: boolean, profile: BoundaryProfile): Array<{ text: string; source: string; boundarySource: BoundaryProfile["boundarySource"]; support: number; repeatedBoundaryPenalty?: number }> {
  const out: Array<{ text: string; source: string; boundarySource: BoundaryProfile["boundarySource"]; support: number }> = [];
  const add = (text: string, source: string, support: number) => {
    const clean = tidySurface(text);
    if (!clean) return;
    if (sentenceKind && isInlineBoundary(profile, clean)) return;
    if (!sentenceKind && isTerminalBoundary(profile, clean)) return;
    out.push({ text: clean, source, boundarySource: "learned_prior", support: clamp01(support) });
  };
  for (const pattern of state.importedPatterns.slice(0, 256)) {
    for (const value of transitionStringsFromJson(pattern.patternJson)) add(value, `language_pattern:${pattern.id}`, pattern.support);
  }
  for (const unit of state.importedUnits.slice(0, 256)) {
    for (const value of transitionStringsFromJson(unit.metadata)) add(value, `language_unit:${unit.id}`, unit.alpha);
  }
  const seen = new Map<string, { text: string; source: string; boundarySource: BoundaryProfile["boundarySource"]; support: number }>();
  for (const candidate of out) {
    const existing = seen.get(candidate.text);
    if (!existing || candidate.support > existing.support) seen.set(candidate.text, candidate);
  }
  return [...seen.values()].sort((a, b) => b.support - a.support || a.text.localeCompare(b.text)).slice(0, 12);
}

function transitionStringsFromJson(value: JsonValue | undefined): string[] {
  const out: string[] = [];
  const visit = (node: JsonValue | undefined, keyPath: readonly string[], depth: number) => {
    if (depth > 5 || out.length >= 96) return;
    if (typeof node === "string") {
      if (keyPath.some(isTransitionMetadataKey)) out.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child, keyPath, depth + 1);
      return;
    }
    if (!node || typeof node !== "object" || Array.isArray(node)) return;
    for (const [key, child] of Object.entries(node)) visit(child, [...keyPath, key], depth + 1);
  };
  visit(value, [], 0);
  return [...new Set(out)].slice(0, 32);
}

function isTransitionMetadataKey(key: string): boolean {
  const normalized = key.toLocaleLowerCase();
  return normalized.includes("boundary") || normalized.includes("separator") || normalized.includes("connector") || normalized.includes("transition") || normalized.includes("joiner") || normalized.includes("cadence");
}

function sentenceBoundaryFor(state: LanguageMemoryRuntimeState, profile: BoundaryProfile): { text: string; source: string; boundarySource: BoundaryProfile["boundarySource"]; support: number } {
  const observed = punctuationObservation(state, boundaryFormsForKind(profile, "sentence"));
  if (observed) return observed;
  const form = boundaryFormsForKind(profile, "sentence")[0] ?? ".";
  return { text: form, source: profile.id, boundarySource: profile.boundarySource, support: profile.profileBoundaryWeight };
}

function inlineBoundaryFor(state: LanguageMemoryRuntimeState, profile: BoundaryProfile): { text: string; source: string; boundarySource: BoundaryProfile["boundarySource"]; support: number } {
  const observed = punctuationObservation(state, boundaryFormsForKind(profile, "inline"));
  if (observed) return observed;
  const form = boundaryFormsForKind(profile, "inline")[0] ?? ":";
  return { text: form, source: profile.id, boundarySource: profile.boundarySource, support: profile.profileBoundaryWeight };
}

function punctuationObservation(state: LanguageMemoryRuntimeState, candidates: readonly string[]): { text: string; source: string; boundarySource: BoundaryProfile["boundarySource"]; support: number } | undefined {
  let best: { text: string; source: string; boundarySource: BoundaryProfile["boundarySource"]; support: number } | undefined;
  for (const observation of state.importedObservations.slice(0, 2048)) {
    if (!candidates.includes(observation.symbol)) continue;
    const support = clamp01(Math.log2(1 + observation.count) * Math.max(0.1, observation.fieldWeight) / 10);
    if (!best || support > best.support) best = { text: observation.symbol, source: `ngram_observation:${observation.id}`, boundarySource: "learned_prior", support };
  }
  return best;
}

function boundaryRoleFit(boundary: string, left: DiscourseUnitRole, right: DiscourseUnitRole, sentenceKind: boolean, profile: BoundaryProfile): number {
  if (sentenceKind && isTerminalBoundary(profile, boundary)) return right === "caveat" || right === "example" || right === "artifact_summary" ? 0.92 : 0.84;
  if (!sentenceKind && !isTerminalBoundary(profile, boundary)) return left === right ? 0.86 : 0.62;
  return 0.32;
}

function renderDiscourseUnitBoundary(left: string, right: string, kind: DiscourseBoundaryKind, boundary: string): string {
  const cleanLeft = tidySurface(left);
  const cleanRight = tidySurface(right);
  if (!cleanLeft) return cleanRight;
  if (!cleanRight) return cleanLeft;
  const cleanBoundary = tidySurface(boundary);
  if (kind === "sentence") {
    const punctuated = hasTerminalBoundary(cleanLeft) ? cleanLeft : `${cleanLeft}${cleanBoundary || "."}`;
    return tidySurface(`${punctuated} ${cleanRight}`);
  }
  if (!cleanBoundary) return tidySurface(`${cleanLeft} ${cleanRight}`);
  if (isBoundaryGlyph(cleanBoundary)) return tidySurface(`${cleanLeft}${cleanBoundary} ${cleanRight}`);
  return tidySurface(`${cleanLeft} ${cleanBoundary} ${cleanRight}`);
}

function isLikelySentenceBoundary(value: string): boolean {
  return isSentenceBoundarySymbol(value);
  return value === "." || value === "!" || value === "?" || value === "。" || value === "؟" || value === "।";
}

function isLikelyInlineOnlyBoundary(value: string): boolean {
  return value === ":" || value === ";" || value === "," || value === "،" || value === "、";
}

function hasTerminalBoundary(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  const last = clean[clean.length - 1] ?? "";
  return isLikelySentenceBoundary(last);
}

function isBoundaryGlyph(value: string): boolean {
  if (!value) return false;
  for (const char of value) {
    if (isWhitespaceChar(char)) continue;
    if (isLetterChar(char) || isDigitChar(char) || char === "_" || char === "-") return false;
  }
  return true;
}

function shouldAttemptGenerated(plan: SurfacePlan, state: LanguageMemoryRuntimeState): boolean {
  void plan;
  return state.models.length > 0 ||
    state.records.length > 0 ||
    state.importedUnits.length > 0 ||
    state.importedPatterns.length > 0 ||
    state.importedObservations.length > 0 ||
    state.importedSemanticFrames.length > 0;
}

function surfaceEnergyCandidate(
  candidate: SurfaceCandidate & {
    preservation: { score: number };
    score: { activation: number; fit: number };
    correction: { applied: Array<{ changed: boolean }> };
    forbiddenHits: readonly string[];
  },
  plan: SurfacePlan
): SurfaceEnergyCandidate {
  return {
    id: candidate.id,
    text: candidate.text,
    force: plan.forceBindings[0]?.force ?? dominantForce(plan),
    evidenceIds: candidate.evidenceIds.map(String),
    importedPieceIds: candidate.importedPieceIds,
    languageActivation: candidate.score.activation,
    languageFit: candidate.score.fit,
    semanticPreservation: candidate.preservation.score,
    correctionAppliedCount: candidate.correction.applied.filter(item => item.changed).length,
    forbiddenSurfaceHits: candidate.forbiddenHits,
    boundaryDecisions: candidate.boundaryDecisions,
    metadata: toJsonValue({ path: candidate.path, style: candidate.style })
  };
}

function walshSurfaceEnergyContext(
  input: SpeakInput,
  plan: SurfacePlan,
  discoursePlan: DiscoursePlan,
  correctionInfluence: CorrectionStyleInfluence,
  basePriorPieces?: readonly ImportedSurfacePiece[]
): SurfaceEnergyContext {
  const audit = jsonRecord(plan.audit);
  const forbiddenForms = Array.isArray(audit.forbiddenSurfaceForms) ? audit.forbiddenSurfaceForms.map(jsonRecord) : [];
  const priorPieces = importedSurfacePieces(input, plan, undefined, basePriorPieces);
  const evidenceBoundaryText = input.evidence.map(span => span.text || span.textPreview).join("\n");
  const supportBoundaryText = `${input.entailment.claim.text}\n${evidenceBoundaryText}`;
  const requiredEntityTerms = plan.requiredTerms.filter(term => term.weight >= 0.82 && containsSurface(evidenceBoundaryText, term.text));
  const requiredNumberTerms = plan.requiredTerms.filter(term => term.weight >= 0.82 && containsSurface(supportBoundaryText, term.text));
  return {
    construct: input.construct,
    requestedAuthority: input.requestedAuthority,
    requirementField: input.requirementField,
    selectedProposal: input.selectedProposal,
    claimBases: input.claimBases ?? input.selectedProposal?.claims,
    requiredOutputFeatures: input.requiredOutputFeatures ?? input.requirementField?.requiredFeatures,
    prohibitedOutputFeatures: input.prohibitedOutputFeatures ?? input.requirementField?.prohibitedFeatures,
    revisionConstraints: input.revisionConstraints,
    surfacePlan: plan,
    discoursePlan,
    proofVerdict: proofGateVerdict(input.entailment),
    forceClass: input.entailment.force,
    expectedForce: plan.forceBindings[0]?.force ?? forceFromEntailment(input.entailment),
    field: input.field,
    fieldSummary: {
      alphaPressure: input.field.alphaTrace.surfaces.pressure,
      ppfMass: input.field.ppf.slice(0, 8).reduce((sum, item) => sum + item.mass, 0),
      contradictionPressure: input.field.alphaTrace.surfaces.contradiction,
      actionability: input.field.alphaTrace.surfaces.actionability
    },
    languagePrior: {
      activation: input.languageMemory.competenceVector.generationReliability,
      fit: input.languageMemory.competenceVector.phraseFluency,
      support: input.languageMemory.importedLanguagePriorCount / Math.max(1, input.languageMemory.importedLanguagePriorCount + 12),
      importedPieceIds: priorPieces.map(piece => piece.id),
      surfaces: priorPieces.map(piece => piece.text).slice(0, 48)
    },
    correction: {
      rules: input.correctionRules ?? [],
      termRewrites: correctionInfluence.preferredTerms,
      styleVector: correctionInfluence.styleVector,
      registerVector: correctionInfluence.registerVector
    },
    styleVector: correctionInfluence.styleVector ?? [plan.style.density, plan.style.formality, plan.style.creativity],
    registerVector: correctionInfluence.registerVector ?? plan.registerVector,
    boundaryProfile: plan.boundaryProfile,
    requiredEntities: requiredEntityTerms.filter(term => !invariantSymbols(term.text).some(symbol => symbol.kind === "number")).map(term => term.text),
    requiredNumbers: dominantConstructForce(plan.constructForces) === "ProgramConstruct"
      ? []
      : uniqueStrings(requiredNumberTerms.flatMap(term => invariantSymbols(term.text)).filter(symbol => symbol.kind === "number").map(symbol => symbol.text)),
    requiredCaveats: plan.caveatBindings.map(binding => binding.reason),
    forbiddenSurfaces: forbiddenForms.map(form => ({
      id: typeof form.id === "string" ? form.id : "surface.form.unknown",
      text: typeof form.text === "string" ? form.text : undefined
    })),
    directQuoteBindings: directQuoteBindingsFromPlan(plan),
    learnedPriorEvidenceIds: input.evidence.filter(span => evidenceForceClass(span).startsWith("learned_")).map(span => String(span.id)),
    directEvidenceIds: input.evidence.filter(span => evidenceForceClass(span) === "direct_evidence").map(span => String(span.id)),
    calibrationModels: input.calibrationModels,
    calibrationTaskClass: input.calibrationTaskClass ?? (isCreativeRequested(input, plan) ? CALIBRATION_TASK_CLASS_IDS.creativeGeneration : CALIBRATION_TASK_CLASS_IDS.sourceBoundQa)
  };
}

function finalTransformationBaseline(text: string, input: SpeakInput): SurfaceTransformationBaseline {
  const claims = input.claimBases ?? input.selectedProposal?.claims ?? [];
  const claimSurfaces = claims.map(claim => claim.text.trim()).filter(surface => surface && containsSurface(text, surface));
  const requestedSurfaces = (input.requiredOutputFeatures ?? [])
    .map(feature => "surface" in feature && typeof feature.surface === "string" ? feature.surface.trim() : "")
    .filter(surface => surface && containsSurface(text, surface));
  const codeLiterals = uniqueStrings(claims
    .flatMap(claim => invariantSymbols(claim.text))
    .filter(symbol => symbol.kind === "symbol" && text.includes(symbol.text))
    .map(symbol => symbol.text));
  const preserveFormat = (input.requirementField?.formatConstraintStrength ?? 0) >= 0.5;
  const lines = text.split(/\r?\n/u);
  return {
    requiredSurfaces: uniqueStrings([...claimSurfaces, ...requestedSurfaces]),
    requiredCodeLiterals: codeLiterals,
    minimumLineCount: preserveFormat ? Math.max(1, lines.length) : undefined,
    minimumListMarkerCount: preserveFormat ? lines.filter(line => /^\s*(?:[-*+] |\d+[.)] )/u.test(line)).length : undefined,
    minimumCodeFenceCount: preserveFormat ? (text.match(/```/gu) ?? []).length : undefined
  };
}

function finalFormattedSurface(text: string, input: SpeakInput, plan: SurfacePlan): string | undefined {
  if ((input.requirementField?.formatConstraintStrength ?? 0) < 0.5) return undefined;
  const lineEnding = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/u);
  const hasStructuralFormat = lines.length > 1 || lines.some(line => /^\s*(?:[-*+] |\d+[.)] )/u.test(line)) || text.includes("```");
  if (!hasStructuralFormat) return undefined;
  const cleaned = lines
    .map(line => stripInternalSurfaceArtifactTokens(line).trimEnd())
    .join(lineEnding)
    .trim();
  if (!cleaned) return undefined;
  void plan;
  return cleaned;
}

function directQuoteBindingsFromPlan(plan: SurfacePlan): Array<{ id: string; text: string }> {
  const out: Array<{ id: string; text: string }> = [];
  for (const frame of plan.realizationFrames) {
    const constraints = jsonRecord(frame.realizationConstraints);
    const direct = constraints.directQuoteBindings;
    if (!Array.isArray(direct)) continue;
    for (const item of direct.map(jsonRecord)) {
      if (typeof item.id === "string" && typeof item.text === "string") out.push({ id: item.id, text: item.text });
    }
  }
  return out.slice(0, 24);
}

function evidenceForceClass(span: EvidenceSpan): string {
  for (const value of [span.trustVector, span.provenance, span.languageHints, span.scriptHints]) {
    const found = findForceClass(value);
    if (found) return found;
  }
  return "";
}

function findForceClass(value: JsonValue | undefined): string | undefined {
  if (typeof value === "string") return value === "direct_evidence" || value.startsWith("learned_") || value === "profile_excerpt_evidence" || value === "unknown_prior" ? value : undefined;
  if (!value || typeof value !== "object") return undefined;
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findForceClass(item);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, JsonValue>;
  for (const key of ["forceClass", "force_class", "class"]) {
    const found = findForceClass(record[key]);
    if (found) return found;
  }
  for (const child of Object.values(record)) {
    const found = findForceClass(child);
    if (found) return found;
  }
  return undefined;
}

function semanticPreservation(input: { text: string; plan: SurfacePlan; entailment: SemanticEntailmentResult }): { score: number; missingTerms: string[]; audit: JsonValue } {
  const normalizedText = input.text.normalize("NFKC").toLocaleLowerCase();
  const requiredTerms = input.plan.requiredTerms.filter(term => term.weight >= 0.45);
  const missingTerms = requiredTerms.filter(term => !normalizedText.includes(term.text.normalize("NFKC").toLocaleLowerCase())).map(term => term.text);
  const force = dominantConstructForce(input.plan.constructForces);
  const requiredNumbers = invariantSymbols(force === "CreativeConstruct"
    ? input.plan.orderedPoints.map(point => point.proposition).join(" ")
    : input.entailment.claim.text).filter(symbol => symbol.kind === "number").map(symbol => symbol.text);
  const missingNumbers = requiredNumbers.filter(number => !input.text.includes(number));
  const unsupportedNumbers = invariantSymbols(input.text)
    .filter(symbol => symbol.kind === "number")
    .map(symbol => symbol.text)
    .filter(number => !requiredNumbers.includes(number) && !input.plan.orderedPoints.some(point => point.proposition.includes(number)));
  const proofSensitive = force === "FactualConstruct" || force === "InferenceConstruct" || force === "TranslationConstruct";
  const penalty = missingTerms.length + missingNumbers.length * 2 + (proofSensitive ? unsupportedNumbers.length * 2 : 0);
  const score = clamp01(1 - penalty / Math.max(4, requiredTerms.length + requiredNumbers.length * 2 + (proofSensitive ? 2 : 0)));
  return {
    score,
    missingTerms: [...missingTerms, ...missingNumbers, ...unsupportedNumbers.map(number => `unsupported:${number}`)],
    audit: toJsonValue({
      source: "mouth.semantic-preservation",
      constructForce: force,
      requiredTerms,
      missingTerms,
      requiredNumbers,
      missingNumbers,
      unsupportedNumbers,
      score
    })
  };
}

function outputEvidenceRefs(input: SpeakInput, plan: SurfacePlan, selectedEvidenceIds: readonly EvidenceId[] | undefined): EvidenceId[] {
  const planEvidenceIds = plan.evidenceBindings.map(binding => binding.evidenceId);
  const invention = inventionConstructState(input.construct);
  if (!invention) return [...new Set((selectedEvidenceIds ?? planEvidenceIds).map(id => id as EvidenceId))];
  const allowed = new Set(invention.basisEvidenceIds.map(String));
  const available = new Set(input.evidence.map(span => String(span.id)));
  const participatingIds = selectedEvidenceIds === undefined
    ? planEvidenceIds
    : selectedEvidenceIds;
  return [...new Set(participatingIds)]
    .filter(id => allowed.has(String(id)) && available.has(String(id)))
    .map(id => id as EvidenceId);
}

function uncertaintyMarkers(plan: SurfacePlan, preservation: { score: number; missingTerms: string[] }, construct?: ConstructGraph): UncertaintyMarker[] {
  const markers: UncertaintyMarker[] = [];
  for (const point of plan.orderedPoints) {
    if (point.force === "underdetermined") markers.push({ pointId: point.id, reason: point.caveat ?? "underdetermined support", severity: "medium" });
    if (point.force === "contradicted") markers.push({ pointId: point.id, reason: point.caveat ?? point.proposition, severity: "high" });
  }
  const invention = construct ? inventionConstructState(construct) : undefined;
  for (const claim of invention?.claimBasis ?? []) {
    if (claim.kind !== "performance_prediction" && claim.force !== "conjectured") continue;
    markers.push({ pointId: claim.id, reason: "surface.uncertainty.untested_performance_claim", severity: "medium" });
  }
  if (invention?.untestedPerformanceClaim && !markers.some(marker => marker.reason === "surface.uncertainty.untested_performance_claim")) {
    markers.push({ pointId: invention.nodeId, reason: "surface.uncertainty.untested_performance_claim", severity: "medium" });
  }
  if (preservation.missingTerms.length) markers.push({ pointId: plan.thesis ?? "surface", reason: `surface.uncertainty.required_terms_missing:${preservation.missingTerms.length}`, severity: preservation.score < 0.5 ? "high" : "medium" });
  return markers.slice(0, 8);
}

function normalizeStyle(style: StyleProfile | undefined, correctionInfluence: CorrectionStyleInfluence): Required<StyleProfile> {
  const name = correctionInfluence.tone ?? style?.name ?? "surface.style.default";
  return {
    name,
    density: clamp01(style?.density ?? 0.62),
    formality: clamp01(style?.formality ?? 0.45),
    creativity: clamp01(style?.creativity ?? 0.12),
    exposeProofTerms: Boolean(style?.exposeProofTerms)
  };
}

function styleProfileFrom(style: Required<StyleProfile>, correctionInfluence: CorrectionStyleInfluence): StyleProfileId {
  if (correctionInfluence.styleTags.length) return `surface.style.corrected:${correctionInfluence.styleTags[0]}`;
  const densityBand = Math.round(style.density * 4);
  const formalityBand = Math.round(style.formality * 4);
  const creativityBand = Math.round(style.creativity * 4);
  return `surface.style.vector.${densityBand}.${formalityBand}.${creativityBand}`;
}

function registerIdFrom(registerVector: RegisterVector | undefined): RegisterId | undefined {
  if (!registerVector?.length) return undefined;
  return `surface.register.vector.${registerVector.map(value => Math.round(clamp01(Math.abs(value)) * 9)).slice(0, 6).join(".")}`;
}

function languageIdFromProfile(profile: LanguageProfile): string {
  return profile.id || "und";
}

export function inferConstructForces(input: SpeakInput): ConstructForceInferenceResult<ConstructOutputForce> {
  type ForceSignalSource = "construct_graph" | "semantic_proof" | "field_state" | "language_target" | "correction_rule";
  const rows: Array<{ id: ConstructOutputForce; weight: number; source: string; evidence: Array<{ signalId: string; source: ForceSignalSource; weight: number; support: number }> }> = [];
  const hasFamily = (suffix: string) => input.construct.nodes.some(node => node.kind === suffix || node.id.endsWith(suffix));
  const add = (id: ConstructOutputForce, weight: number, source: string, signalId: string, signalSource: ForceSignalSource, support = weight) => rows.push({
    id,
    weight: clamp01(weight),
    source,
    evidence: [{ signalId, source: signalSource, weight: clamp01(weight), support: clamp01(support) }]
  });
  const support = clamp01(input.entailment.support);
  const contradiction = clamp01(input.entailment.contradiction);
  if (input.requestedAuthority === "translation") add("TranslationConstruct", 1, "force.requested.translation", "signal.requested_authority.translation", "language_target", 1);
  if (input.requestedAuthority === "creative") add("CreativeConstruct", 1, "force.requested.creative", "signal.requested_authority.creative", "construct_graph", 1);
  add("ConversationConstruct", 0.35 + Math.max(0, 0.32 - support * 0.18 - contradiction * 0.2), "force.surface.default", "signal.surface.default", "field_state");
  add("ExplanationConstruct", 0.28 + Math.min(0.45, input.entailment.obligations.length / 18), "force.semantic.obligations", "signal.semantic.obligation_count", "semantic_proof", input.entailment.obligations.length / 18);
  if (learningAllowsFactualSurface(input.learningDecision) && proofGateAllowsFactualSurface(input.entailment) && (input.entailment.force === "proved" || input.entailment.evidenceIds.length)) add("FactualConstruct", 0.32 + support * 0.58, "force.semantic.certified", "signal.semantic.certified_evidence", "semantic_proof", support);
  if (input.entailment.force === "inferred") add("InferenceConstruct", 0.3 + support * 0.42, "force.semantic.inferred", "signal.semantic.inferred_force", "semantic_proof", support);
  if (input.entailment.force === "conjectured" || input.entailment.force === "invented") add("ConjectureConstruct", 0.34 + input.field.alphaTrace.surfaces.drift * 0.4, "force.field.drift", "signal.field.drift", "field_state", input.field.alphaTrace.surfaces.drift);
  if (input.construct.program || hasFamily("construct:program")) add("ProgramConstruct", input.construct.program ? 0.92 : 0.62, "force.construct.program", "signal.construct.program", "construct_graph", input.construct.program ? 1 : 0.62);
  if (input.construct.artifacts.length && !input.construct.program) add("CreativeConstruct", 0.42 + input.field.alphaTrace.surfaces.drift * 0.35, "force.construct.artifact", "signal.construct.artifact", "construct_graph", input.construct.artifacts.length / 6);
  if (input.construct.nodes.some(node => node.kind === "construct:prediction")) add("ConjectureConstruct", 0.74, "force.construct.prediction", "signal.construct.prediction", "construct_graph", 0.74);
  if (input.construct.nodes.some(node => node.kind === "construct:invention")) add("CreativeConstruct", 0.74, "force.construct.invention", "signal.construct.invention", "construct_graph", 0.74);
  const semanticAnswer = semanticAnswerConstructState(input.construct);
  if (semanticAnswer) add("InferenceConstruct", 0.76, "force.construct.semantic_answer", "signal.construct.semantic_answer", "construct_graph", semanticAnswer.selectedFacts.length / Math.max(1, semanticAnswer.selectedFacts.length + 2));
  if (!semanticAnswer && input.targetLanguage && input.targetLanguage !== "und" && input.targetLanguage !== languageIdFromProfile(input.languageProfile)) add("TranslationConstruct", 0.78, "force.language.target", "signal.language.target_differs", "language_target");
  if (hasFamily("construct:action_plan")) add("PlanningConstruct", 0.58 + input.field.alphaTrace.surfaces.actionability * 0.28, "force.construct.plan", "signal.construct.action_plan", "construct_graph", input.field.alphaTrace.surfaces.actionability);
  const importSummarySurface = forceAwareHydratedAnswerSurface(input);
  if (importSummarySurface) add("ImportSummaryConstruct", 0.88, "force.brain.learned_prior_summary", importSummarySurface.policy.reasonId, "field_state", importSummarySurface.support);
  if ((input.correctionRules ?? []).some(rule => rule.ruleKind === "preferred_surface" || rule.ruleKind === "terminology_preference" || rule.ruleKind === "script_preference")) add("RewriteConstruct", 0.52, "force.correction.surface", "signal.correction.surface_rule", "correction_rule");
  const ranked = rows.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id)).slice(0, 8);
  return {
    rows: ranked,
    audit: toJsonValue({
      source: "mouth.force-inference",
      mode: "structured_signals",
      rows: ranked.map(row => ({ id: row.id, weight: row.weight, source: row.source, evidence: row.evidence }))
    })
  };
}

function dominantConstructForce(forces: readonly SurfacePlan["constructForces"][number][]): ConstructOutputForce {
  return forces[0]?.id ?? "ConversationConstruct";
}

function isCreativeRequested(input: SpeakInput, plan?: SurfacePlan): boolean {
  return input.requestedAuthority === "creative" ||
    Boolean(inventionConstructState(input.construct)) ||
    Boolean(plan?.constructForces.some(force => force.id === "CreativeConstruct" && force.weight >= 0.4));
}

function constructNodeForForce(construct: ConstructGraph, force: ConstructOutputForce): ConstructNodeId | undefined {
  if (force === "ProgramConstruct") return construct.nodes.find(node => node.kind === "construct:program")?.id ?? construct.program?.id;
  if (force === "CreativeConstruct") return inventionConstructState(construct)?.nodeId ?? construct.nodes.find(node => node.kind === "construct:invention")?.id;
  if (force === "PlanningConstruct") return construct.nodes.find(node => node.kind === "construct:action_plan")?.id;
  if (force === "TranslationConstruct") return construct.nodes.find(node => node.kind === "construct:translation")?.id;
  if (force === "ImportSummaryConstruct") return construct.nodes.find(node => node.kind === "construct:learning_plan")?.id ?? construct.nodes.find(node => node.kind === "construct:answer")?.id;
  if (force === "InferenceConstruct") return construct.nodes.find(node => node.kind === "construct:semantic_answer")?.id ?? construct.nodes.find(node => node.kind === "construct:graph_node_answer")?.id ?? construct.nodes.find(node => node.kind === "construct:answer")?.id ?? construct.nodes[0]?.id;
  return construct.nodes.find(node => node.kind === "construct:answer")?.id ?? construct.nodes[0]?.id;
}

function outputForceFromConstruct(entailment: SemanticEntailmentResult, force: ConstructOutputForce): OutputForce {
  if (force === "CreativeConstruct") return "creative";
  if (force === "ConjectureConstruct") return "underdetermined";
  if (force === "InferenceConstruct") return "bounded";
  if (force === "ImportSummaryConstruct") return "underdetermined";
  return forceFromEntailment(entailment);
}

function answerFromConstruct(input: SpeakInput, force: ConstructOutputForce): string {
  const generated = generatedConstructSurface(input.construct);
  if (generated && force !== "CreativeConstruct") return generated.text;
  if (insufficientSupportConstructState(input.construct)) return "";
  if (force === "ProgramConstruct" && input.construct.program) return "";
  if (force === "CreativeConstruct" || input.entailment.force === "invented") return "";
  return answerFromObligations(input.entailment, input.evidence, { allowClaimBoundary: claimSurfaceBoundaryAllowed(input, force) });
}

function answerPolicyFor(input: SpeakInput): ForceAwareAnswerPolicy {
  const proofVerdict = proofGateVerdict(input.entailment);
  if (input.requestedAuthority === "translation") return forceAwarePolicy("translation", "force.policy.requested_translation", false);
  if (input.requestedAuthority === "creative" || inventionConstructState(input.construct)) return forceAwarePolicy("creative", "force.policy.requested_creative", false);
  if (proofVerdict === "certified") return forceAwarePolicy("certified_fact", "force.policy.certified_fact", true);
  if (proofVerdict === "source_bound_only") return forceAwarePolicy("source_bound", "force.policy.source_bound", false);
  if (semanticAnswerConstructState(input.construct)) return forceAwarePolicy("inference", "force.policy.semantic_answer", false, "import_bound");
  if (graphNodeAnswerConstructRow(input.construct)) return forceAwarePolicy("inference", "force.policy.graph_node_answer", false, "import_bound");
  if (insufficientSupportConstructState(input.construct)) return forceAwarePolicy("conversation", "force.policy.insufficient_relevance", false);
  const importSummary = forceAwareHydratedAnswerSurface(input);
  if (importSummary) return importSummary.policy;
  if (input.entailment.force === "inferred") return forceAwarePolicy("inference", "force.policy.inference", false);
  if (input.entailment.force === "conjectured" || input.entailment.force === "invented") return forceAwarePolicy("conjecture", "force.policy.conjecture", false);
  return forceAwarePolicy("conversation", "force.policy.conversation", false);
}

function forceAwarePolicy(policyId: ForceAwareAnswerPolicyId, reasonId: string, allowsExternalFactCertification: boolean, boundaryId?: ForceAwareAnswerPolicyId): ForceAwareAnswerPolicy {
  return { policyId, boundaryId, reasonId, allowsExternalFactCertification };
}

function forceAwareHydratedAnswerSurface(input: SpeakInput): ForceAwareSurface | undefined {
  void input;
  return undefined;
}

function importSummaryRequested(text: string): boolean {
  const units = new Set(splitWhitespace(tidySurface(text)).map(unit => stripOuterSurfaceBoundary(unit).toLocaleLowerCase()).filter(Boolean));
  const asksImport = units.has("scce2") || units.has("import") || units.has("imported") || units.has("shard") || units.has("brain-import");
  const asksInspect = units.has("summary") || units.has("status") || units.has("inspect") || units.has("debug");
  return asksImport && asksInspect;
}

function importSummarySurfaceText(input: SpeakInput): string {
  void input;
  return "";
}

function semanticAnswerConstructState(construct: ConstructGraph): SemanticAnswerConstructState | undefined {
  const rows = construct.nodes.map(node => ({ node, metadata: jsonRecord(node.metadata) }));
  const row = rows.find(item => item.node.kind === "construct:semantic_answer" || item.metadata.schema === "scce.semantic_answer_construct.v1")
    ?? rows.find(item => item.node.kind === "construct:prior_bound_answer" || item.metadata.schema === "scce.prior_bound_answer_construct.v1");
  if (!row) return undefined;
  const facts = arrayRecords(row.metadata.selectedFacts)
    .map(semanticAnswerFactFromJson)
    .filter((fact): fact is SemanticAnswerFact => Boolean(fact));
  if (!facts.length) return undefined;
  const boundary = jsonRecord(row.metadata.certificationBoundary);
  return {
    schema: "scce.semantic_answer_construct.v1",
    questionShapeId: stringFromJson(row.metadata.questionShapeId),
    selectedSubject: stringFromJson(row.metadata.selectedSubject) || facts[0]?.subject || row.node.label,
    selectedFacts: facts,
    answerSlots: arrayRecords(row.metadata.answerSlots).map(semanticAnswerSlotFromJson),
    selectedRelations: stringArrayFromJson(row.metadata.selectedRelations),
    activatedNeighborhood: arrayRecords(row.metadata.activatedNeighborhood).map(semanticAnswerFactFromJson).filter((fact): fact is SemanticAnswerFact => Boolean(fact)),
    rejectedCandidates: arrayRecords(row.metadata.rejectedCandidates).map(row => ({
      relationId: stringFromJson(row.relationId),
      sourceNodeId: stringFromJson(row.sourceNodeId),
      targetNodeId: stringFromJson(row.targetNodeId),
      reasonId: stringFromJson(row.reasonId),
      score: numberFromJson(row.score)
    })),
    supportIds: stringArrayFromJson(row.metadata.supportIds),
    forceId: stringFromJson(row.metadata.forceId) || "output.force.learned_concept_prior_answer",
    boundaryId: stringFromJson(row.metadata.boundaryId) || "output.force.import_bound",
    activeBrainVersion: stringFromJson(row.metadata.activeBrainVersion),
    activeImportRunIds: stringArrayFromJson(row.metadata.activeImportRunIds),
    alphaRhetoricalPlan: row.metadata.alphaRhetoricalPlan,
    cognitiveFabric: row.metadata.cognitiveFabric,
    questionSlotPlan: row.metadata.questionSlotPlan,
    certificationBoundary: {
      directEvidenceCount: numberFromJson(boundary.directEvidenceCount),
      evidenceSpanIds: stringArrayFromJson(boundary.evidenceSpanIds),
      sourceVersionIds: stringArrayFromJson(boundary.sourceVersionIds),
      externalFactCertification: boundary.externalFactCertification === true
    }
  };
}

function semanticAnswerSlotFromJson(value: Record<string, JsonValue>): SemanticAnswerSlot {
  return {
    id: stringFromJson(value.id),
    relationIds: stringArrayFromJson(value.relationIds),
    factKeys: stringArrayFromJson(value.factKeys),
    support: numberFromJson(value.support),
    activation: numberFromJson(value.activation)
  };
}

function insufficientSupportConstructState(construct: ConstructGraph): InsufficientSupportConstructState | undefined {
  const row = construct.nodes
    .map(node => ({ node, metadata: jsonRecord(node.metadata) }))
    .find(item => item.node.kind === "construct:insufficient_support" || item.metadata.schema === "scce.insufficient_support_construct.v1");
  if (!row) return undefined;
  return {
    schema: "scce.insufficient_support_construct.v1",
    questionShapeId: stringFromJson(row.metadata.questionShapeId),
    selectedMainSubject: stringFromJson(row.metadata.selectedMainSubject) || row.node.label,
    requestedFocuses: stringArrayFromJson(row.metadata.requestedFocuses),
    closestSubjectCandidates: stringArrayFromJson(row.metadata.closestSubjectCandidates),
    relevanceGate: row.metadata.relevanceGate ?? null,
    explanatoryAnswerContract: row.metadata.explanatoryAnswerContract ?? null,
    activeBrainVersion: stringFromJson(row.metadata.activeBrainVersion),
    activeImportRunIds: stringArrayFromJson(row.metadata.activeImportRunIds),
    certificationBoundary: {
      directEvidenceCount: numberFromJson(jsonRecord(row.metadata.certificationBoundary).directEvidenceCount),
      externalFactCertification: Boolean(jsonRecord(row.metadata.certificationBoundary).externalFactCertification)
    }
  };
}

function semanticAnswerFactFromJson(value: Record<string, JsonValue>): SemanticAnswerFact | undefined {
  const subject = stringFromJson(value.subject);
  const predicate = stringFromJson(value.predicate);
  const object = stringFromJson(value.object);
  if (!subject || !predicate || !object) return undefined;
  return {
    subject,
    predicate,
    object,
    sourceNodeId: stringFromJson(value.sourceNodeId),
    targetNodeId: stringFromJson(value.targetNodeId),
    relationId: stringFromJson(value.relationId),
    forceClass: stringFromJson(value.forceClass),
    score: numberFromJson(value.score),
    activation: numberFromJson(value.activation),
    overlap: numberFromJson(value.overlap),
    support: numberFromJson(value.support),
    sourceVersionId: stringFromJson(value.sourceVersionId) || undefined,
    evidenceIds: stringArrayFromJson(value.evidenceIds),
    roleId: stringFromJson(value.roleId) || undefined,
    alphaRhetoricalCentrality: optionalNumberFromJson(value.alphaRhetoricalCentrality),
    pathScore: optionalNumberFromJson(value.pathScore),
    roleScore: optionalNumberFromJson(value.roleScore),
    bridgeValue: optionalNumberFromJson(value.bridgeValue),
    backgroundPenalty: optionalNumberFromJson(value.backgroundPenalty),
    forceMeaning: optionalNumberFromJson(value.forceMeaning),
    certificationPower: optionalNumberFromJson(value.certificationPower),
    semanticQuality: optionalNumberFromJson(value.semanticQuality),
    graphQualityClassId: stringFromJson(value.graphQualityClassId) || undefined,
    answerGrade: typeof value.answerGrade === "boolean" ? value.answerGrade : undefined,
    cognitiveEdgeId: stringFromJson(value.cognitiveEdgeId) || undefined,
    requestedSlotId: stringFromJson(value.requestedSlotId) || undefined,
    relationRoleId: stringFromJson(value.relationRoleId) || undefined,
    topicSenseId: stringFromJson(value.topicSenseId) || undefined,
    finalQuestionFit: optionalNumberFromJson(value.finalQuestionFit),
    questionSlotId: stringFromJson(value.questionSlotId) || undefined,
    questionSlotImportance: stringFromJson(value.questionSlotImportance) || undefined,
    questionSlotScore: optionalNumberFromJson(value.questionSlotScore),
    questionSlotReasonIds: stringArrayFromJson(value.questionSlotReasonIds)
  };
}

function semanticFactKey(fact: Pick<SemanticAnswerFact, "subject" | "predicate" | "object" | "relationId">): string {
  return [fact.subject, fact.predicate, fact.object, fact.relationId]
    .map(part => collapseWhitespace(part.normalize("NFKC").toLocaleLowerCase()))
    .join("\u0001");
}

function brainImportSummary(markerValue: JsonValue | undefined): {
  activeBrainVersion: string;
  activeImportRunIds: string[];
  leadImportRunId: string;
  importRunCount: number;
  graphShardCount: number;
  graphNodeCount: number;
  graphEdgeCount: number;
  hyperedgeCount: number;
  learnedPriorCount: number;
  graphPriorCount: number;
  languagePriorCount: number;
  programPriorCount: number;
  directEvidenceCount: number;
  profileExcerptEvidenceCount: number;
  unsupportedSectionCount: number;
  unknownPriorCount: number;
} {
  const marker = jsonRecord(markerValue);
  const activeImportRunIds = stringArrayFromJson(marker.activeImportRunIds);
  const runs = arrayRecords(marker.runs);
  const forceClasses = mergeCounts(runs.map(run => countRecord(run.forceClasses)));
  const rowCounts = mergeCounts(runs.map(run => countRecord(run.rowCounts)));
  const unsupportedSectionCount = Math.max(
    0,
    numberFromJson(marker.unsupportedSectionCount),
    sumNumbers(runs.map(run => numberFromJson(run.unsupportedSectionCount))),
    sumNumbers(runs.map(run => arrayLength(run.unsupportedSections))),
    countWarningsWithPrefix(runs, "unsupported section ")
  );
  const unknownSectionCount = Math.max(
    0,
    numberFromJson(marker.unknownSectionCount),
    sumNumbers(runs.map(run => arrayLength(run.unknownSections))),
    countWarningsWithPrefix(runs, "unknown section ")
  );
  const graphShardCount = Math.max(0, forceClasses.learned_concept_prior ?? 0);
  const graphNodeCount = Math.max(0, rowCounts.graph_nodes ?? 0);
  const graphEdgeCount = Math.max(0, rowCounts.graph_edges ?? 0);
  const hyperedgeCount = Math.max(0, rowCounts.graph_hyperedges ?? 0);
  return {
    activeBrainVersion: stringFromJson(marker.activeBrainVersion),
    activeImportRunIds,
    leadImportRunId: activeImportRunIds[0] || stringFromJson(runs[0]?.importRunId) || "none",
    importRunCount: Math.max(activeImportRunIds.length, runs.length),
    graphShardCount,
    graphNodeCount,
    graphEdgeCount,
    hyperedgeCount,
    learnedPriorCount: numberFromJson(marker.importedLearnedPriorCount),
    graphPriorCount: numberFromJson(marker.importedGraphPriorCount),
    languagePriorCount: numberFromJson(marker.importedLanguagePriorCount),
    programPriorCount: numberFromJson(marker.importedProgramPriorCount),
    directEvidenceCount: numberFromJson(marker.importedDirectEvidenceCount),
    profileExcerptEvidenceCount: numberFromJson(marker.profileExcerptEvidenceCount),
    unsupportedSectionCount,
    unknownPriorCount: Math.max(numberFromJson(marker.unknownPriorCount), unknownSectionCount, forceClasses.unknown_prior ?? 0)
  };
}

function answerFromObligations(entailment: SemanticEntailmentResult, evidence: readonly EvidenceSpan[], options: { allowClaimBoundary?: boolean } = {}): string {
  const proofVerdict = proofGateVerdict(entailment);
  if (proofVerdict === "contradicted") {
    const contradictionSurface = boundarySurfaceFromRuntime(entailment, evidence, proofVerdict);
    if (contradictionSurface) return contradictionSurface;
  }
  const satisfied = entailment.obligations.find(item =>
    item.status === "satisfied" &&
    (options.allowClaimBoundary || item.evidenceIds.length > 0 || !questionEchoHits(item.claimText, entailment.claim.text).length)
  );
  if (satisfied?.claimText) return satisfied.claimText;
  const sourceText = evidence
    .map(span => normalizeEvidenceSentence(span.textPreview || span.text || ""))
    .find(Boolean);
  if (sourceText) return sourceText;
  const claimText = normalizeEvidenceSentence(entailment.claim.text);
  if (claimText && options.allowClaimBoundary) return claimText;
  if (proofVerdict === "source_bound_only") {
    const sourceBoundary = boundarySurfaceFromRuntime(entailment, evidence, proofVerdict);
    if (sourceBoundary) return sourceBoundary;
  }
  return unsupportedAnswerBoundarySurface();
}

function claimSurfaceBoundaryAllowed(input: SpeakInput, force?: ConstructOutputForce): boolean {
  if (force === "TranslationConstruct") return true;
  if (input.construct.nodes.some(node => node.kind === "construct:translation" || node.kind === "construct:rewrite")) return true;
  if (input.entailment.obligations.some(obligation => obligation.kind === "transform" && obligation.status === "satisfied")) return true;
  return (input.correctionRules ?? []).some(rule =>
    Boolean(rule.replacement) &&
    (rule.ruleKind === "preferred_surface" ||
      rule.ruleKind === "terminology_preference" ||
      rule.ruleKind === "translation_preference" ||
      rule.ruleKind === "pronunciation_or_transliteration" ||
      rule.ruleKind === "script_preference")
  );
}

function unsupportedAnswerBoundarySurface(locale?: string): string {
  void locale;
  return "";
}

function obligationPointText(claimText: string, reason: string, status: string): string {
  const claim = claimText.trim();
  const spokenClaim = looksLikeInternalDiagnosticCode(claim.toLocaleLowerCase()) ? "" : claim;
  const spokenReason = surfaceCaveatReason(reason) ?? "";
  const base = normalizeEvidenceSentence(spokenClaim || spokenReason);
  if (!base) return "";
  if (status === "contradicted") return spokenReason || base;
  return base;
}

function normalizeEvidenceSentence(text: string): string {
  return removeEmptyLines(collapseWhitespace(text).trim());
}

function semanticSlotSurface(value: JsonValue): string {
  const surfaces: string[] = [];
  const visit = (item: JsonValue, depth: number) => {
    if (depth > 4 || surfaces.length >= 24) return;
    if (typeof item === "string") {
      const clean = normalizeEvidenceSentence(item);
      if (clean && !looksLikeInternalDiagnosticCode(clean.toLocaleLowerCase()) && !containsUnresolvedSurfaceKey(clean)) surfaces.push(clean);
      return;
    }
    if (typeof item === "number" || typeof item === "boolean") {
      surfaces.push(String(item));
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (item && typeof item === "object") {
      for (const child of Object.values(item)) visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return uniqueStrings(surfaces).join(" ");
}

function admittedSemanticSlotSurface(input: SpeakInput, roleId: string, value: JsonValue): string {
  const surface = semanticSlotSurface(value);
  if (roleId !== "mouth.role.action.preview" || !surface) return surface;
  const governedSurface = governedActionPreviewSurface(input.selectedCandidate);
  return governedSurface && tidySurface(governedSurface) === tidySurface(surface) ? surface : "";
}

function caveatFor(entailment: SemanticEntailmentResult): string | undefined {
  const proofVerdict = proofGateVerdict(entailment);
  if (proofVerdict && proofVerdict !== "certified") return boundarySurfaceFromRuntime(entailment, [], proofVerdict);
  if (entailment.verdict === "contradicted") return surfaceCaveatReason(entailment.counterexamples[0]?.reason);
  return undefined;
}

function boundarySurfaceFromRuntime(entailment: SemanticEntailmentResult, evidence: readonly EvidenceSpan[], verdict: ProofGateVerdict): string {
  if (verdict === "contradicted") {
    const reason = surfaceCaveatReason(entailment.counterexamples[0]?.reason);
    if (reason) return reason;
  }
  if (verdict === "source_bound_only") {
    const excerpt = evidence.find(span => evidenceForceClass(span) === "profile_excerpt_evidence");
    const text = normalizeEvidenceSentence(excerpt?.textPreview || excerpt?.text || "");
    if (text) return text;
  }
  return "";
}

function stripOuterSurfaceBoundary(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && isSurfaceBoundaryChar(value[start] ?? "")) start++;
  while (end > start && isSurfaceBoundaryChar(value[end - 1] ?? "")) end--;
  return value.slice(start, end);
}

function isSurfaceBoundaryChar(char: string): boolean {
  return isWhitespaceChar(char) || isLikelySentenceBoundary(char) || isLikelyInlineOnlyBoundary(char) || char === "\"" || char === "'";
}

function surfaceCaveatReason(reason: string | undefined): string | undefined {
  const clean = reason?.trim();
  if (!clean) return undefined;
  const lower = clean.toLocaleLowerCase();
  if (lower.startsWith("surface.")) return undefined;
  if (lower.startsWith("candidate-")) return undefined;
  if (lower.startsWith("proof-")) return undefined;
  if (looksLikeInternalDiagnosticCode(lower)) return undefined;
  if (lower.includes("-threshold")) return undefined;
  if (lower.includes("mapping-below")) return undefined;
  return clean;
}

function looksLikeInternalDiagnosticCode(value: string): boolean {
  if (containsInternalSurfaceArtifact(value)) return true;
  if (/^[lp]+(?:\|[lp]+)*\s*:/u.test(value)) return true;
  let hasSeparator = false;
  for (const ch of value) if (ch === "-" || ch === "_" || ch === "." || ch === ":") hasSeparator = true;
  if (!hasSeparator) return false;
  let hasDigit = false;
  for (const ch of value) {
    if (ch === " " || ch === "\t" || ch === "\n") return false;
    if (ch === "-" || ch === "_" || ch === "." || ch === ":") continue;
    const cp = ch.codePointAt(0) ?? 0;
    if (cp >= 48 && cp <= 57) {
      hasDigit = true;
      continue;
    }
    if (cp >= 97 && cp <= 122) continue;
    return false;
  }
  if (hasDigit) return false;
  return true;
}

function stripInternalSurfaceArtifacts(text: string): string {
  const cleanedSentences: string[] = [];
  for (const sentence of splitSurfaceSentences(text)) {
    const stripped = stripInternalSurfaceArtifactTokens(sentence).trim();
    if (!stripped || containsOnlyInternalSurfaceArtifacts(stripped)) continue;
    cleanedSentences.push(stripped);
  }
  const cleaned = tidySurface(cleanedSentences.join(" "));
  if (cleaned) return cleaned;
  return tidySurface(stripInternalSurfaceArtifactTokens(text));
}

function containsSurfaceRealizerTelemetry(text: string): boolean {
  const lower = text.toLocaleLowerCase();
  return lower.includes("scce.surface.realizer") ||
    lower.includes("surface.point=") ||
    lower.includes("surface.limit=") ||
    lower.includes("surface.grounding=") ||
    lower.includes("surface.ref=");
}

function stripInternalSurfaceArtifactTokens(text: string): string {
  return text
    .replace(/\{[^{}]*scce\.surface\.realizer[^{}]*\}/giu, " ")
    .replace(/\bsemantic\.answer\.meaning_slot\.[A-Za-z0-9_.:-]+\b/giu, "")
    .replace(/\bsurface\.(?:point|limit|grounding|ref)\s*=\s*[^\n.?!]*(?:[.?!]|\n|$)/giu, " ")
    .replace(/\b(?:(?:language_profile|source_version|scce2_import_run|source_import_run|graph_node|graph_edge|proof_trace|relation_role|slot_graph|slot_answer)_[A-Za-z0-9_:.:-]+|(?:node|edge|relation|hyperedge)_[0-9a-f]{32,64})\b/giu, "")
    .replace(/\s+([,.;:!?])/gu, "$1")
    .replace(/\s{2,}/gu, " ");
}

function containsOnlyInternalSurfaceArtifacts(text: string): boolean {
  const stripped = stripInternalSurfaceArtifactTokens(text).replace(/[.,;:!?()\[\]{}"'`\s-]+/gu, "");
  return stripped.length === 0;
}

function containsInternalSurfaceArtifact(text: string): boolean {
  return /scce\.surface\.realizer/iu.test(text) ||
    /\bsemantic\.answer\.meaning_slot\.[A-Za-z0-9_.:-]+\b/iu.test(text) ||
    /\bsurface\.(?:point|limit|grounding|ref)\s*=/iu.test(text) ||
    /\b(?:(?:language_profile|source_version|scce2_import_run|source_import_run|graph_node|graph_edge|proof_trace|relation_role|slot_graph|slot_answer)_[A-Za-z0-9_:.:-]+|(?:node|edge|relation|hyperedge)_[0-9a-f]{32,64})\b/iu.test(text) ||
    containsInternalGraphFeatureSurface(text);
}

function containsInternalGraphFeatureSurface(text: string): boolean {
  return /(?:^|\s)(?:sym:[^\s|]+|bi:[^\s|]+\|[^\s|]+|tri:[^\s|]+\|[^\s|]+\|[^\s|]+|char:\S+)(?:$|\s)/u.test(text);
}

function containsStructuredCandidateTelemetry(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith("{") && (
    /"schema"\s*:\s*"scce\.surface\.candidate\.v1"/iu.test(trimmed) ||
    /"candidateKind"\s*:/iu.test(trimmed) ||
    /"activeFeatures"\s*:/iu.test(trimmed) ||
    /"alphaSurfaces"\s*:/iu.test(trimmed) ||
    /"proofId"\s*:/iu.test(trimmed)
  );
}

function admissibleMouthSurface(text: string): boolean {
  const clean = tidySurface(text);
  if (!clean) return false;
  if (containsUnresolvedSurfaceKey(clean)) return false;
  if (containsSurfaceRealizerTelemetry(clean) || containsInternalSurfaceArtifact(clean) || containsStructuredCandidateTelemetry(clean)) return false;
  return detectCannedAnswerSpeech(clean).length === 0;
}

function admissibleLearnedSurface(text: string, generation: LanguageGenerationResult): boolean {
  return admissibleMouthSurface(text) && generationImportedPriorIds(generation).length > 0;
}

function forceFromEntailment(entailment: SemanticEntailmentResult): OutputForce {
  const proofVerdict = proofGateVerdict(entailment);
  if (proofVerdict === "certified") return entailment.force === "proved" ? "entailed" : "observed";
  if (proofVerdict === "contradicted") return "contradicted";
  if (proofVerdict === "source_bound_only") return "bounded";
  if (proofVerdict === "insufficient_evidence" || proofVerdict === "unsupported_prior_only" || proofVerdict === "ambiguous") return "underdetermined";
  if (entailment.verdict === "contradicted") return "contradicted";
  if (entailment.verdict === "underdetermined" || entailment.verdict === "unknown") return "underdetermined";
  if (entailment.force === "proved") return "entailed";
  return "observed";
}

function learningAllowsFactualSurface(decision: ContinueDecision | undefined): boolean {
  return !decision || decision.safeToAssert || decision.continueAnswering;
}

function learningSurfaceOverride(decision: ContinueDecision | undefined): { force: OutputForce; caveat?: string } | undefined {
  if (!decision || decision.continueAnswering) return undefined;
  if (decision.reportContradiction) return { force: "contradicted" };
  if (decision.answerWithCaveat || decision.deferDueToInsufficientEvidence || decision.reportUnsupported || decision.askClarification) return { force: "underdetermined" };
  return undefined;
}

function dominantForce(plan: SurfacePlan): OutputForce {
  const constructForce = dominantConstructForce(plan.constructForces);
  if (constructForce === "CreativeConstruct") return "creative";
  if (plan.constructForces.some(force => force.id === "CreativeConstruct" && force.weight >= 0.4)) return "creative";
  if (plan.forceBindings.some(binding => binding.force === "contradicted")) return "contradicted";
  if (plan.forceBindings.some(binding => binding.force === "underdetermined")) return "underdetermined";
  return plan.forceBindings[0]?.force ?? "bounded";
}

function requiredTermsFor(input: SpeakInput, basePriorPieces?: readonly ImportedSurfacePiece[]): SurfaceTerm[] {
  const terms = new Map<string, SurfaceTerm>();
  const add = (text: string, source: SurfaceTerm["source"], weight: number) => {
    const normalized = text.normalize("NFKC").trim();
    if (!normalized) return;
    if (looksLikeInternalDiagnosticCode(normalized.toLocaleLowerCase())) return;
    const id = `surface.term:${hash32(normalized).toString(16)}`;
    const existing = terms.get(normalized);
    if (!existing || weight > existing.weight) terms.set(normalized, { id, text: normalized, source, weight: clamp01(weight) });
  };
  const semanticAnswer = semanticAnswerConstructState(input.construct);
  if (semanticAnswer) return [];
  if (insufficientSupportConstructState(input.construct)) return [];
  if (!semanticAnswer && !isCreativeRequested(input) && learningAllowsFactualSurface(input.learningDecision) && proofGateAllowsFactualSurface(input.entailment)) {
    for (const symbol of invariantSymbols(input.entailment.claim.text)) add(symbol.text, "claim", symbol.kind === "number" ? 0.95 : symbol.kind === "symbol" ? 0.88 : 0.68);
    for (const obligation of input.entailment.obligations.slice(0, 20)) {
      if (obligation.kind === "quantity" || obligation.kind === "temporal" || obligation.kind === "symbol" || obligation.kind === "entity") {
        for (const symbol of invariantSymbols(obligation.claimText)) add(symbol.text, "obligation", obligation.required ? 0.82 : 0.48);
      }
    }
  }
  if (input.construct.program) {
    const program = programSurfaceSummary(input.construct.program);
    add(program.entrypoint, "construct", 0.96);
    for (const file of [...program.sourceFiles, ...program.testFiles].slice(0, 10)) add(file, "construct", 0.88);
    for (const command of [...program.observedValidation, ...program.sourceDerivedValidation].slice(0, 4)) add(command, "construct", 0.82);
  }
  for (const piece of importedSurfacePieces(input, undefined, undefined, basePriorPieces).filter(piece => piece.kind !== "suggestion" && piece.kind !== "observation").slice(0, 12)) {
    if (overlapsClaim(piece.text, input.entailment.claim.text)) add(piece.text, "language-memory", Math.min(0.36, piece.support));
  }
  return [...terms.values()].sort((a, b) => b.weight - a.weight || a.text.localeCompare(b.text)).slice(0, 40);
}

function removeEmptyLines(text: string): string {
  return splitLines(text)
    .map(line => line.trimEnd())
    .filter((line, index, lines) => line.trim() || (index > 0 && index < lines.length - 1 && lines[index - 1]?.trim()))
    .join("\n")
    .trim();
}

function appliesFactualSurfaceControl(input: SpeakInput, candidate: SurfaceCandidate, plan: SurfacePlan): boolean {
  if (input.construct.program || isWorkspaceKernelSpeakInput(input)) return false;
  if (input.requestedAuthority && input.requestedAuthority !== "factual" && input.requestedAuthority !== "reasoned") return false;
  const constructForce = dominantConstructForce(plan.constructForces);
  if (constructForce === "ProgramConstruct" || constructForce === "CreativeConstruct" || constructForce === "TranslationConstruct") return false;
  if (!input.requestedAuthority && constructForce !== "FactualConstruct") return false;
  return !hasStructuredSurfaceShape(candidate.text);
}

function hasStructuredSurfaceShape(text: string): boolean {
  const clean = text.trim();
  if (!clean) return false;
  if (clean.includes("```")) return true;
  if (jsonObjectSurface(clean)) return true;
  const lines = splitLines(clean).filter(line => line.trim());
  if (lines.length <= 1) return false;
  return lines.some(line => /^\s*(?:[-*+] |\d+[.)] )/u.test(line))
    || lines.filter(line => line.includes("|")).length >= 2;
}

interface SurfaceTokenOffset {
  key: string;
  start: number;
  end: number;
}

function surfaceTokenOffsets(text: string): SurfaceTokenOffset[] {
  const rows: SurfaceTokenOffset[] = [];
  for (const match of text.matchAll(/[\p{Letter}\p{Mark}\p{Number}_]+/gu)) {
    const start = match.index;
    if (start === undefined) continue;
    rows.push({
      key: match[0].normalize("NFKC").toLocaleLowerCase(),
      start,
      end: start + match[0].length
    });
  }
  return rows;
}

function collapseRepeatedTokenSpans(text: string): string {
  let current = tidySurface(text);
  for (let pass = 0; pass < 16; pass++) {
    const tokens = surfaceTokenOffsets(current);
    const repeated = longestRepeatedTokenSpan(tokens);
    if (!repeated) break;
    current = tidySurface(`${current.slice(0, repeated.start)} ${current.slice(repeated.end)}`);
  }
  return current;
}

function longestRepeatedTokenSpan(tokens: readonly SurfaceTokenOffset[]): { start: number; end: number } | undefined {
  if (tokens.length < MINIMUM_REPEATED_TOKEN_SPAN * 2) return undefined;
  const boundedTokens = tokens.slice(0, 4096);
  const priorBySequence = new Map<string, number[]>();
  let best: { tokenCount: number; start: number; end: number } | undefined;
  for (let later = 0; later + MINIMUM_REPEATED_TOKEN_SPAN <= boundedTokens.length; later++) {
    const sequenceKey = boundedTokens
      .slice(later, later + MINIMUM_REPEATED_TOKEN_SPAN)
      .map(token => token.key)
      .join("\u0001");
    const priors = priorBySequence.get(sequenceKey) ?? [];
    for (const earlier of priors) {
      if (earlier + MINIMUM_REPEATED_TOKEN_SPAN > later) continue;
      let tokenCount = MINIMUM_REPEATED_TOKEN_SPAN;
      while (
        earlier + tokenCount < later
        && later + tokenCount < boundedTokens.length
        && boundedTokens[earlier + tokenCount]!.key === boundedTokens[later + tokenCount]!.key
      ) tokenCount++;
      const candidate = {
        tokenCount,
        start: boundedTokens[later]!.start,
        end: boundedTokens[later + tokenCount - 1]!.end
      };
      if (!best || candidate.tokenCount > best.tokenCount
        || candidate.tokenCount === best.tokenCount && candidate.start < best.start) best = candidate;
    }
    priors.push(later);
    priorBySequence.set(sequenceKey, priors.slice(-16));
  }
  return best ? { start: best.start, end: best.end } : undefined;
}

function preserveRequiredSurfaceValues(before: string, candidate: string, plan: SurfacePlan): string {
  const requiredTerms = plan.requiredTerms.filter(term => term.weight >= 0.45).map(term => term.text);
  const requiredSymbols = plan.orderedPoints.flatMap(point => invariantSymbols(point.proposition)).map(symbol => symbol.text);
  const required = uniqueStrings([...requiredTerms, ...requiredSymbols]).filter(value => containsSurface(before, value));
  return required.every(value => containsSurface(candidate, value)) ? candidate : before;
}

function preserveSurfaceExtent(text: string, maxLength?: number, plan?: SurfacePlan): string {
  if (!maxLength || maxLength <= 0 || surfaceCodePointLength(text) <= maxLength) return text;
  const normalized = tidySurface(text);
  if (surfaceCodePointLength(normalized) <= maxLength) return normalized;
  const units = splitExtentUnits(normalized);
  const completedUnits = units.filter(extentUnitHasTerminalBoundary);
  const eligibleUnits = completedUnits.length ? completedUnits : units;
  const eligibleSurface = tidySurface(eligibleUnits.join(" "));
  const required = plan ? extentRequiredSurfaces(plan, eligibleSurface) : [];
  const selected: string[] = [];
  for (const unit of eligibleUnits
    .filter(unit => required.some(term => containsSurface(unit, term)))
    .sort((left, right) => extentCoverage(right, required) - extentCoverage(left, required) || surfaceCodePointLength(left) - surfaceCodePointLength(right))) {
    if (appendExtentUnit(selected, unit, maxLength)) continue;
  }
  for (const unit of eligibleUnits) {
    if (selected.includes(unit)) continue;
    if (!selected.length || surfaceCodePointLength(selected.join(" ")) < Math.floor(maxLength * 0.72)) appendExtentUnit(selected, unit, maxLength);
  }
  const ordered = eligibleUnits.filter(unit => selected.includes(unit));
  const candidate = tidySurface(ordered.join(" "));
  if (candidate && required.every(term => containsSurface(candidate, term) || !containsSurface(eligibleSurface, term))) return candidate;
  const anchorSurface = compactAnchorSurface(required, maxLength);
  if (anchorSurface) return anchorSurface;
  return compactWholeWordSurface(eligibleSurface, maxLength);
}

function extentRequiredSurfaces(plan: SurfacePlan, candidateText: string): string[] {
  const weightedTerms = plan.requiredTerms
    .filter(term => term.weight >= 0.82)
    .map(term => term.text)
    .filter(term => containsSurface(candidateText, term));
  const symbols = plan.orderedPoints
    .flatMap(point => invariantSymbols(point.proposition))
    .map(symbol => symbol.text)
    .filter(symbol => containsSurface(candidateText, symbol));
  const caveats = plan.caveatBindings
    .map(binding => binding.reason)
    .filter(reason => containsSurface(candidateText, reason));
  return uniqueStrings([...weightedTerms, ...symbols, ...caveats])
    .filter(term => term.trim().length > 0)
    .sort((left, right) => right.length - left.length || left.localeCompare(right))
    .slice(0, 12);
}

function splitExtentUnits(text: string): string[] {
  const units = splitUnicodeSurfaceSentences(text)
    .map(unit => tidySurface(unit))
    .filter(Boolean);
  return units.length ? units : [text];
}

const SURFACE_DELIMITER_PAIRS: ReadonlyMap<string, string> = new Map([
  ["(", ")"],
  ["[", "]"],
  ["{", "}"],
  ["\uff08", "\uff09"],
  ["\uff3b", "\uff3d"],
  ["\uff5b", "\uff5d"],
  ["\u3008", "\u3009"],
  ["\u300a", "\u300b"],
  ["\u300c", "\u300d"],
  ["\u300e", "\u300f"],
  ["\u3010", "\u3011"],
  ["\u3014", "\u3015"],
  ["\u3016", "\u3017"],
  ["\u3018", "\u3019"],
  ["\u301a", "\u301b"]
]);
const SURFACE_OPENING_BY_CLOSER: ReadonlyMap<string, string> = new Map(
  [...SURFACE_DELIMITER_PAIRS].map(([opening, closing]) => [closing, opening])
);
const SURFACE_CLOSING_DELIMITERS = new Set(SURFACE_OPENING_BY_CLOSER.keys());
const SURFACE_SENTENCE_TRAILING_CLOSERS = new Set([
  ...SURFACE_CLOSING_DELIMITERS,
  "\"",
  "'",
  "\u2019",
  "\u201d",
  "\u00bb",
  "\u203a"
]);

function extentUnitHasTerminalBoundary(text: string): boolean {
  const chars = [...text.trimEnd()];
  while (chars.length && SURFACE_SENTENCE_TRAILING_CLOSERS.has(chars.at(-1) ?? "")) chars.pop();
  return isSentenceBoundarySymbol(chars.at(-1) ?? "");
}

function surfaceCodePointLength(text: string): number {
  return [...text].length;
}

function extentCoverage(text: string, required: readonly string[]): number {
  return required.filter(term => containsSurface(text, term)).length;
}

function appendExtentUnit(selected: string[], unit: string, maxLength: number): boolean {
  const next = tidySurface([...selected, unit].join(" "));
  if (surfaceCodePointLength(next) > maxLength) return false;
  selected.push(unit);
  return true;
}

function compactAnchorSurface(required: readonly string[], maxLength: number): string {
  const selected: string[] = [];
  for (const term of required) {
    const next = tidySurface([...selected, term].join(" "));
    if (surfaceCodePointLength(next) <= maxLength) selected.push(term);
  }
  return tidySurface(selected.join(" "));
}

function compactWholeWordSurface(text: string, maxLength: number): string {
  const selected: string[] = [];
  for (const word of splitWhitespace(text)) {
    const next = [...selected, word].join(" ");
    if (surfaceCodePointLength(next) > maxLength) break;
    selected.push(word);
  }
  if (selected.length) return selected.join(" ");
  return "";
}

function applySurfacePlanCorrections(plan: SurfacePlan, rules: readonly CorrectionRuleRecord[], influence: CorrectionStyleInfluence, hashText: (text: string) => string): SurfacePlan {
  const forbiddenForms = rules
    .filter(rule => (rule.ruleKind === "semantic_error" || rule.ruleKind === "surface_note") && rule.pattern.trim())
    .map(rule => ({ id: `surface.form:${hashText(rule.pattern).slice(0, 16)}`, ruleId: rule.id, text: rule.pattern, textHash: hashText(rule.pattern), ruleKind: rule.ruleKind }))
    .slice(0, 64);
  const correctedPoints = plan.orderedPoints.map(point => {
    const preferred = influence.preferredTerms.reduce((text, item) => text.split(item.pattern).join(item.replacement), point.proposition);
    return preferred === point.proposition ? point : { ...point, proposition: preferred, realizationConstraints: toJsonValue({ ...jsonRecord(point.realizationConstraints), correctedBySurfacePlan: true }) };
  });
  const corrected: SurfacePlan = {
    ...plan,
    orderedPoints: correctedPoints,
    forbiddenSurfaces: [...new Set([...plan.forbiddenSurfaces, ...forbiddenForms.map(form => form.id)])],
    targetLanguage: influence.targetLanguage ?? plan.targetLanguage,
    targetScript: influence.scriptId ?? plan.targetScript,
    registerVector: influence.registerVector ?? plan.registerVector,
    meterPattern: influence.meterPattern ?? plan.meterPattern,
    audit: toJsonValue({
      ...jsonRecord(plan.audit),
      correctionInfluence: influence.audit,
      forbiddenSurfaceForms: forbiddenForms.map(form => ({ id: form.id, ruleId: form.ruleId, text: form.text, textHash: form.textHash, ruleKind: form.ruleKind })),
      preferredSurfaceCount: influence.preferredTerms.length
    })
  };
  return { ...corrected, realizationFrames: realizationFramesForPlan(corrected, hashText) };
}

function forbiddenSurfaceHits(text: string, plan: SurfacePlan): string[] {
  const audit = jsonRecord(plan.audit);
  const forms = Array.isArray(audit.forbiddenSurfaceForms) ? audit.forbiddenSurfaceForms : [];
  const hits: string[] = [];
  for (const id of plan.forbiddenSurfaces) {
    const form = forms.map(jsonRecord).find(row => row.id === id);
    const ruleId = typeof form?.ruleId === "string" ? form.ruleId : id;
    const surface = typeof form?.text === "string" ? form.text : undefined;
    if (surface && text.includes(surface)) hits.push(ruleId);
  }
  return hits;
}

function semanticAnswerDriftHits(text: string, input: SpeakInput, priorPieces: readonly ImportedSurfacePiece[]): string[] {
  const state = semanticAnswerConstructState(input.construct);
  if (!state) return [];
  const allowed = uniqueStrings([
    state.selectedSubject,
    ...state.selectedFacts.flatMap(fact => [fact.subject, fact.predicate, fact.object])
  ]).filter(value => splitWhitespace(value).length > 0);
  const hits: string[] = [];
  for (const piece of priorPieces) {
    if (!piece.text || !containsSurface(text, piece.text)) continue;
    const aligned = allowed.some(value =>
      containsSurface(value, piece.text) ||
      containsSurface(piece.text, value) ||
      overlapsClaim(piece.text, value)
    );
    if (!aligned) hits.push(`semantic-answer-drift:${hash32(piece.text).toString(16)}`);
  }
  if (surfaceDashCount(text) > 2) hits.push("semantic-answer-boundary-drift");
  return hits;
}

function questionEchoHits(text: string, question: string): string[] {
  const cleanQuestion = tidySurface(question);
  const normalizedText = normalizeSurfaceEcho(text);
  const normalizedQuestion = normalizeSurfaceEcho(cleanQuestion);
  if (!normalizedText || !normalizedQuestion) return [];
  const hits: string[] = [];
  const overlap = weightedJaccard(featureSet(normalizedText, 256), featureSet(normalizedQuestion, 256));
  if (normalizedText === normalizedQuestion) hits.push("surface.reject.echo.exact");
  if (overlap >= 0.92 && preservesQuestionShape(text, question)) hits.push("surface.reject.echo.question_shape");
  if (overlap >= 0.86 && normalizedText.length <= normalizedQuestion.length + 8) hits.push("surface.reject.echo.minor_cleanup");
  return uniqueStrings(hits);
}

function languagePriorLeakageHits(text: string, input: SpeakInput, priorPieces: readonly ImportedSurfacePiece[]): string[] {
  if (semanticAnswerConstructState(input.construct) || input.construct.program) return [];
  if (generatedConstructSurface(input.construct)) return [];
  const hits: string[] = [];
  const supportText = input.evidence.map(span => `${span.textPreview} ${span.text}`).join(" ");
  const supportFeatures = featureSet([supportText, input.entailment.claim.text].join(" "), 512);
  const textFeatures = featureSet(text, 512);
  const coverage = supportFeatures.length ? weightedJaccard(textFeatures, supportFeatures) : 0;
  const priorMass = priorPieces.filter(piece => containsSurface(text, piece.text) || overlapsClaim(piece.text, text)).length;
  const unanchored = input.evidence.length === 0 && input.entailment.evidenceIds.length === 0 && !generatedConstructSurface(input.construct) && !isWorkspaceKernelSpeakInput(input);
  if (priorMass > 0 && unanchored) hits.push("surface.reject.language_prior_unanchored");
  else if (priorMass > 0 && coverage < 0.08 && input.evidence.length === 0) hits.push("surface.reject.language_prior_unanchored");
  if (looksLikeOrphanLanguageFragment(text)) hits.push("surface.reject.orphan_language_fragment");
  return hits;
}

function unanchoredImportedPriorHits(candidate: SurfaceCandidate, input: SpeakInput): string[] {
  if (!candidate.importedPieceIds.length) return [];
  if (candidate.style === "surface.path.generated.conversation_memory") return [];
  if (input.evidence.length > 0) return [];
  if (semanticAnswerConstructState(input.construct) || input.construct.program || isWorkspaceKernelSpeakInput(input)) return [];
  if (candidate.style === "surface.path.generated.construct_anchored") return [];
  return ["surface.reject.language_prior_unanchored"];
}

function normalizeSurfaceEcho(text: string): string {
  return splitWhitespace(tidySurface(text))
    .map(stripOuterSurfaceBoundary)
    .map(value => value.toLocaleLowerCase())
    .filter(Boolean)
    .join(" ");
}

function preservesQuestionShape(text: string, question: string): boolean {
  const cleanText = tidySurface(text);
  const cleanQuestion = tidySurface(question);
  const textLast = cleanText[cleanText.length - 1] ?? "";
  const questionLast = cleanQuestion[cleanQuestion.length - 1] ?? "";
  return textLast === questionLast || questionLast === "?";
}

function looksLikeOrphanLanguageFragment(text: string): boolean {
  const clean = tidySurface(text);
  if (!clean) return true;
  const symbols = splitWhitespace(clean);
  if (symbols.length <= 2 && clean.length <= 16) return true;
  if (symbols.length <= 8 && (symbols[0]?.endsWith(",") || symbols[0]?.endsWith("-") || symbols[0]?.endsWith("–"))) return true;
  let quoteCount = 0;
  for (const char of clean) if (char === "\"" || char === "'") quoteCount++;
  if (quoteCount % 2 === 1 && symbols.length < 12) return true;
  return false;
}

function surfaceDashCount(text: string): number {
  let count = 0;
  for (const char of text) if (char === "–" || char === "—") count++;
  return count;
}

function importedSurfacePieces(
  input: SpeakInput,
  plan: SurfacePlan | undefined,
  languageMemory: LanguageMemoryRuntime | undefined,
  basePriorPieces?: readonly ImportedSurfacePiece[]
): ImportedSurfacePiece[] {
  const context = plan?.orderedPoints[0]?.proposition ?? input.entailment.claim.text;
  const pieces: ImportedSurfacePiece[] = [];
  for (const suggestion of languageMemory?.suggest({ state: input.languageMemory, context, limit: 16 }) ?? []) {
    if (suggestion.symbol.trim()) pieces.push({ id: `suggestion:${hash32(suggestion.symbol).toString(16)}`, kind: "suggestion", text: suggestion.symbol, support: suggestion.support });
  }
  if (basePriorPieces) pieces.push(...basePriorPieces);
  else {
    for (const unit of input.languageMemory.importedUnits.slice(0, 256)) {
      if (unit.unitKind !== "phrase" && unit.unitKind !== "symbol") continue;
      pieces.push({ id: unit.id, kind: "language_unit", text: unit.text, support: unit.alpha });
    }
    for (const observation of input.languageMemory.importedObservations.slice(0, 512)) {
      pieces.push({ id: observation.id, kind: "observation", text: [...observation.history.slice(-4), observation.symbol].join(" "), support: Math.log2(1 + observation.count) * Math.max(0.1, observation.fieldWeight) / 12 });
    }
    for (const pattern of input.languageMemory.importedPatterns.slice(0, 256)) {
      for (const surface of patternSurfaceKeys(pattern).slice(0, 8)) pieces.push({ id: pattern.id, kind: "phrase_pattern", text: surface, support: pattern.support });
    }
    for (const frame of input.languageMemory.importedSemanticFrames.slice(0, 256)) {
      for (const surface of semanticFrameSurfaces(frame).slice(0, 8)) pieces.push({ id: frame.id, kind: "semantic_frame", text: surface, support: frame.alpha });
    }
  }
  const seen = new Set<string>();
  return pieces
    .map(piece => ({ ...piece, text: normalizeEvidenceSentence(piece.text) }))
    .filter(piece => piece.text && piece.support > 0)
    .filter(piece => {
      const key = `${piece.kind}:${piece.id}:${piece.text}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.support - a.support || a.text.localeCompare(b.text))
    .slice(0, 256);
}

function preservationFloor(plan: SurfacePlan): number {
  const force = dominantConstructForce(plan.constructForces);
  if (force === "CreativeConstruct") return 0.28;
  if (force === "ConjectureConstruct") return 0.42;
  if (force === "FactualConstruct" || force === "TranslationConstruct") return 0.62;
  return 0.5;
}

function repairPreservation(input: { text: string; plan: SurfacePlan; preservation: { missingTerms: string[] } }): string {
  void input.plan;
  void input.preservation;
  return removeEmptyLines(input.text);
}

function creativeSemanticDriftHits(text: string, input: SpeakInput): string[] {
  if (!isCreativeRequested(input)) return [];
  const requestTerms = creativeRequestContentTerms(input)
    .map(term => term.text)
    .filter(term => [...term].length >= 3);
  if (requestTerms.length) {
    const covered = requestTerms.filter(term => containsSurface(text, term));
    const requiredCoverage = requestTerms.length <= 2 ? requestTerms.length : Math.max(2, Math.ceil(requestTerms.length * 0.5));
    if (covered.length < requiredCoverage) return ["surface.reject.creative_request_drift"];
  }
  const invention = inventionConstructState(input.construct);
  const anchors = uniqueStrings([
    invention?.proposalSurface ?? "",
    ...(invention?.claimBasis.map(claim => claim.surface) ?? []),
    ...input.construct.artifacts.flatMap(artifact => [artifact.path, artifact.content])
  ].map(normalizeEvidenceSentence).filter(Boolean));
  if (!anchors.length) return [];
  if (requestTerms.some(term => containsSurface(text, term))) return [];
  const aligned = anchors.some(anchor =>
    containsSurface(text, anchor) ||
    containsSurface(anchor, text) ||
    weightedJaccard(featureSet(text, 256), featureSet(anchor, 256)) >= 0.08
  );
  return aligned ? [] : ["surface.reject.creative_semantic_drift"];
}

function repairSurfaceReadability(input: { text: string; plan: SurfacePlan; discoursePlan: DiscoursePlan; preservation: { missingTerms: string[] } }): SurfaceRepairResult {
  const before = tidySurface(input.text);
  const deduped = collapseRepeatedSurfaceUnits(before);
  const sequenceDeduped = collapseRepeatedSurfaceSequences(deduped);
  const sentenceDeduped = collapseRepeatedSentenceSegments(sequenceDeduped);
  const delimiterBalanced = dominantConstructForce(input.plan.constructForces) === "ProgramConstruct"
    || hasStructuredSurfaceShape(sentenceDeduped)
    ? sentenceDeduped
    : repairSurfaceDelimiterBalance(sentenceDeduped);
  const boundaryLimited = collapseRepeatedInlineBoundaries(delimiterBalanced, sentenceBoundaryForInput(input.plan), boundaryFormsForKind(input.plan.boundaryProfile, "inline"));
  const normalized = removeEmptyLines(boundaryLimited);
  const requiredTerms = input.plan.requiredTerms.filter(term => term.weight >= 0.45).map(term => term.text);
  const requiredSymbols = input.plan.orderedPoints.flatMap(point => invariantSymbols(point.proposition)).map(symbol => symbol.text);
  const preservesTerms = requiredTerms.every(term => containsSurface(normalized, term) || !containsSurface(before, term));
  const preservesSymbols = requiredSymbols.every(symbol => containsSurface(normalized, symbol) || !containsSurface(before, symbol));
  const text = preservesTerms && preservesSymbols ? normalized : before;
  const changed = text !== before;
  return {
    text,
    changed,
    audit: toJsonValue({
      source: "mouth.surface-repair",
      changed,
      boundaryProfileId: input.plan.boundaryProfile.id,
      boundarySource: input.plan.boundaryProfile.boundarySource,
      beforeHash: hash32(before).toString(16),
      afterHash: hash32(text).toString(16),
      discoursePlanId: input.discoursePlan.id,
      unitCount: input.discoursePlan.units.length,
      missingTermsBeforeRepair: input.preservation.missingTerms,
      operations: {
        collapsedRepeatedSurfaceUnits: deduped !== before,
        collapsedRepeatedSurfaceSequences: sequenceDeduped !== deduped,
        collapsedRepeatedSentences: sentenceDeduped !== sequenceDeduped,
        repairedDelimiterBalance: delimiterBalanced !== sentenceDeduped,
        collapsedRepeatedBoundaries: boundaryLimited !== delimiterBalanced,
        normalizedWhitespace: normalized !== boundaryLimited,
        preservationRollback: text === before && normalized !== before
      },
      requiredTermCount: requiredTerms.length,
      requiredSymbolCount: requiredSymbols.length
    })
  };
}

function ensureRuntimeCaveats(text: string, plan: SurfacePlan): string {
  const clean = tidySurface(text);
  if (!clean) return clean;
  const points = new Map(plan.orderedPoints.map(point => [point.id, point]));
  const caveats = uniqueStrings(plan.caveatBindings
    .map(binding => {
      const point = points.get(binding.pointId);
      if (!point || point.caveat !== binding.reason || point.support <= 0) return "";
      const reason = surfaceCaveatReason(binding.reason);
      return reason && admissibleMouthSurface(reason) ? reason : "";
    })
    .filter(Boolean))
    .filter(reason => !containsSurface(clean, reason));
  return caveats.length ? joinSurfaceSentences([clean, ...caveats]) : clean;
}

function repairSemanticAnswerFinalSurface(text: string, construct: ConstructGraph): string {
  const state = semanticAnswerConstructState(construct);
  if (!state) return text;
  if (surfaceDashCount(text) <= 2 && !detectCannedAnswerSpeech(text).length) return text;
  return text;
}

function protectedImportSummarySurface(plan: SurfacePlan, repairedText: string): string {
  void plan;
  return repairedText;
}

function sentenceBoundaryForInput(plan: SurfacePlan): string {
  return boundaryFormsForKind(plan.boundaryProfile, "sentence")[0] ?? ".";
}

function collapseRepeatedSurfaceUnits(text: string): string {
  const symbols = splitWhitespace(tidySurface(text));
  if (symbols.length <= 1) return tidySurface(text);
  const out: string[] = [];
  for (const symbol of symbols) {
    const previous = out[out.length - 1];
    if (previous && previous.normalize("NFKC").toLocaleLowerCase() === symbol.normalize("NFKC").toLocaleLowerCase()) continue;
    out.push(symbol);
  }
  return out.join(" ");
}

function collapseRepeatedSurfaceSequences(text: string): string {
  let symbols = splitWhitespace(tidySurface(text));
  if (symbols.length < 8) return tidySurface(text);
  let changed = true;
  while (changed) {
    changed = false;
    const maximum = Math.floor(symbols.length / 2);
    for (let width = maximum; width >= 4 && !changed; width--) {
      for (let start = 0; start + width * 2 <= symbols.length; start++) {
        const left = symbols.slice(start, start + width).map(repeatedSurfaceSymbolKey);
        const right = symbols.slice(start + width, start + width * 2).map(repeatedSurfaceSymbolKey);
        if (!left.every((symbol, index) => symbol && symbol === right[index])) continue;
        symbols = [...symbols.slice(0, start), ...symbols.slice(start + width)];
        changed = true;
        break;
      }
    }
  }
  return symbols.join(" ");
}

function repeatedSurfaceSymbolKey(value: string): string {
  return stripOuterSurfaceBoundary(value).normalize("NFKC").toLocaleLowerCase();
}

function collapseRepeatedSentenceSegments(text: string): string {
  const segments = splitSurfaceSentences(text);
  if (segments.length <= 1) return tidySurface(text);
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const segment of segments) {
    const clean = tidySurface(segment);
    if (!clean) continue;
    const key = clean.normalize("NFKC").toLocaleLowerCase();
    if (seen.has(key)) continue;
    const nearIndex = kept.findIndex(existing => nearDuplicateSentence(existing, clean));
    if (nearIndex >= 0) {
      if (clean.length > kept[nearIndex]!.length) kept[nearIndex] = clean;
      continue;
    }
    seen.add(key);
    kept.push(clean);
  }
  return tidySurface(kept.join(" "));
}

function nearDuplicateSentence(left: string, right: string): boolean {
  if (weightedJaccard(featureSet(left, 128), featureSet(right, 128)) > 0.78) return true;
  const leftSymbols = lexicalSurfaceSymbols(left);
  const rightSymbols = lexicalSurfaceSymbols(right);
  if (!leftSymbols.size || !rightSymbols.size) return false;
  let intersection = 0;
  for (const symbol of leftSymbols) if (rightSymbols.has(symbol)) intersection++;
  return intersection / Math.max(1, Math.min(leftSymbols.size, rightSymbols.size)) > 0.82;
}

function lexicalSurfaceSymbols(text: string): Set<string> {
  const units = new Set<string>();
  let current = "";
  const flush = () => {
    const clean = current.toLocaleLowerCase();
    if (clean.length >= 4) units.add(clean);
    current = "";
  };
  for (const char of text.normalize("NFKC")) {
    if (isLetterChar(char) || isDigitChar(char)) {
      current += char;
      continue;
    }
    flush();
  }
  flush();
  return units;
}

function splitSurfaceSentences(text: string): string[] {
  return splitUnicodeSurfaceSentences(text);
  const segments: string[] = [];
  let current = "";
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    current += char;
    const next = text[index + 1] ?? "";
    if (isLikelySentenceBoundary(char) && (!next || isWhitespaceChar(next))) {
      segments.push(current);
      current = "";
    }
  }
  if (current.trim()) segments.push(current);
  return segments;
}

function collapseRepeatedInlineBoundaries(text: string, sentenceBoundary: string, inline: readonly string[]): string {
  let out = "";
  let repeatedInline = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index] ?? "";
    if (inline.includes(char)) {
      const left = text[index - 1] ?? "";
      const right = text[index + 1] ?? "";
      if (isDigitChar(left) && isDigitChar(right)) {
        out += char;
        continue;
      }
      repeatedInline++;
      if (repeatedInline > 1) continue;
      out += char;
      continue;
    }
    if (!isWhitespaceChar(char) && !inline.includes(char)) {
      if (isLikelySentenceBoundary(char)) repeatedInline = 0;
    }
    if (isLikelySentenceBoundary(char) && out.endsWith(char)) continue;
    out += char;
  }
  return tidySurface(out);
}

function repairSurfaceDelimiterBalance(text: string): string {
  const output: string[] = [];
  const openings: Array<{ char: string; outputIndex: number }> = [];
  for (const char of text) {
    if (SURFACE_DELIMITER_PAIRS.has(char)) {
      openings.push({ char, outputIndex: output.length });
      output.push(char);
      continue;
    }
    const expectedOpening = SURFACE_OPENING_BY_CLOSER.get(char);
    if (expectedOpening) {
      const activeOpening = openings.at(-1);
      if (!activeOpening || activeOpening.char !== expectedOpening) continue;
      while (output.length && isWhitespaceChar(output.at(-1) ?? "")) output.pop();
      output.push(char);
      openings.pop();
      continue;
    }
    if (isSentenceBoundarySymbol(char) || isLikelyInlineOnlyBoundary(char)) {
      while (output.length && isWhitespaceChar(output.at(-1) ?? "")) output.pop();
    }
    output.push(char);
  }
  if (!openings.length) return tidySurface(output.join(""));
  const unmatchedOpeningIndexes = new Set(openings.map(opening => opening.outputIndex));
  return tidySurface(output.filter((_char, index) => !unmatchedOpeningIndexes.has(index)).join(""));
}

function artifactPoint(artifact: ConstructGraph["artifacts"][number]): string {
  const path = normalizeEvidenceSentence(artifact.path);
  const content = normalizeEvidenceSentence(artifact.content);
  if (!path) return content;
  if (!content || containsSurface(path, content) || containsSurface(content, path)) return content || path;
  return joinSurfaceClauses([path, content]);
}

interface GeneratedConstructSurface {
  text: string;
  force: OutputForce;
  support: number;
  caveat: string;
  trace: JsonValue;
}

interface InventionClaimBasisState {
  id: string;
  surface: string;
  force: "observed" | "inferred" | "invented" | "conjectured";
  evidenceIds: EvidenceId[];
  kind: "factual_premise" | "deduction" | "invention" | "performance_prediction";
}

interface InventionConstraintState {
  id: string;
  surface: string;
  weight: number;
  satisfied: boolean;
}

interface InventionConstructState {
  nodeId: ConstructNodeId;
  proposalSurface: string;
  basisEvidenceIds: EvidenceId[];
  basisPriorIds: string[];
  noveltyScore: number;
  supportScore: number;
  riskScore: number;
  proofStatusId: string;
  claimBasis: InventionClaimBasisState[];
  constraints: InventionConstraintState[];
  untestedPerformanceClaim: boolean;
  trace: JsonValue;
}

function generatedConstructSurface(construct: ConstructGraph): GeneratedConstructSurface | undefined {
  const invention = inventionConstructState(construct);
  if (invention) {
    return {
      text: compactHumanSentence([invention.proposalSurface]),
      force: "creative",
      support: invention.supportScore,
      caveat: "",
      trace: toJsonValue({
        schema: "scce.invention_construct.v1",
        constructId: invention.nodeId,
        noveltyScore: invention.noveltyScore,
        supportScore: invention.supportScore,
        riskScore: invention.riskScore,
        proofStatusId: invention.proofStatusId,
        basisEvidenceIds: invention.basisEvidenceIds,
        basisPriorIds: invention.basisPriorIds,
        claimBasis: invention.claimBasis,
        constraints: invention.constraints,
        untestedPerformanceClaim: invention.untestedPerformanceClaim
      })
    };
  }
  const semanticAnswer = semanticAnswerConstructState(construct);
  if (semanticAnswer) return undefined;
  const insufficient = insufficientSupportConstructState(construct);
  const graphNodeAnswer = graphNodeAnswerConstructRow(construct);
  if (graphNodeAnswer) {
    const metadata = graphNodeAnswer.metadata;
    const surface = stringFrom(metadata.answerSurface) || graphNodeAnswer.node.label;
    const selectedNodes = arrayRecords(metadata.selectedNodes);
    const support = clamp01(mean(selectedNodes.map(row => numberFrom(row.score, 0.32))));
    return {
      text: tidySurface(surface),
      force: "bounded",
      support: support || 0.32,
      caveat: "",
      trace: toJsonValue({
        schema: metadata.schema ?? "scce.graph_node_answer_construct.v1",
        constructId: graphNodeAnswer.node.id,
        forceId: metadata.forceId ?? "output.force.learned_graph_node_answer",
        boundaryId: metadata.boundaryId ?? "output.force.import_bound",
        selectedNodeIds: selectedNodes.map(row => stringFrom(row.nodeId)).filter(Boolean),
        certificationBoundary: metadata.certificationBoundary ?? null
      })
    };
  }
  const prediction = construct.nodes.map(node => ({ node, metadata: jsonRecord(node.metadata) })).find(row => row.node.kind === "construct:prediction" || row.metadata.schema === "scce.prediction_construct.v1");
  if (prediction) {
    const metadata = prediction.metadata;
    const surface = stringFrom(metadata.predictedSurface) || stringFrom(metadata.surface) || prediction.node.label;
    const support = numberFrom(metadata.supportScore, 0.38);
    const uncertainty = numberFrom(metadata.uncertaintyScore, clamp01(1 - support));
    const risk = numberFrom(metadata.riskScore, uncertainty);
    return {
      text: compactHumanSentence([surface]),
      force: "underdetermined",
      support,
      caveat: "",
      trace: toJsonValue({
        schema: metadata.schema ?? "scce.prediction_construct.v1",
        constructId: prediction.node.id,
        noveltyScore: numberFrom(metadata.noveltyScore, 0),
        supportScore: support,
        riskScore: risk,
        proofStatusId: metadata.proofStatusId ?? "proof.status.non_certifying_prediction"
      })
    };
  }
  const runtimeDiagnostic = construct.nodes.map(node => ({ node, metadata: jsonRecord(node.metadata) })).find(row => row.node.kind === "construct:runtime_diagnostic" || row.metadata.schema === "scce.runtime_diagnostic_construct.v1");
  if (runtimeDiagnostic) {
    const metadata = runtimeDiagnostic.metadata;
    return {
      text: compactHumanSentence([stringFrom(metadata.answerSurface) || runtimeDiagnostic.node.label]),
      force: "bounded",
      support: 0.74,
      caveat: "",
      trace: toJsonValue({
        schema: metadata.schema ?? "scce.runtime_diagnostic_construct.v1",
        constructId: runtimeDiagnostic.node.id,
        forceId: metadata.forceId ?? "output.force.import_bound",
        runtimeBoundary: metadata.runtimeBoundary ?? null,
        priorCounts: metadata.priorCounts ?? null
      })
    };
  }
  if (insufficient) return undefined;
  return undefined;
}

function inventionConstructState(construct: ConstructGraph, selectedNodeId?: string): InventionConstructState | undefined {
  const row = construct.nodes
    .map(node => ({ node, metadata: jsonRecord(node.metadata) }))
    .find(item => (
      (!selectedNodeId || String(item.node.id) === selectedNodeId)
      && (item.node.kind === "construct:invention" || item.metadata.schema === "scce.invention_construct.v1")
    ));
  if (!row) return undefined;
  const trace = jsonRecord(row.metadata.trace);
  const proposalSurface = tidySurface(stringFrom(row.metadata.proposalSurface) || stringFrom(row.metadata.title) || row.node.label);
  if (!proposalSurface) return undefined;
  const basisEvidenceIds = stringArrayFromJson(row.metadata.basisEvidenceIds).map(id => id as EvidenceId);
  const claimBasis = arrayRecords(trace.claimBasis).map((claim, index): InventionClaimBasisState => ({
    id: stringFrom(claim.id) || `invention.claim.${index + 1}`,
    surface: tidySurface(stringFrom(claim.surface) || ""),
    force: inventionClaimForce(claim.force),
    evidenceIds: stringArrayFromJson(claim.evidenceIds).map(id => id as EvidenceId),
    kind: inventionClaimKind(claim.kind)
  }));
  const constraints = arrayRecords(trace.constraints).map((constraint, index): InventionConstraintState => ({
    id: stringFrom(constraint.id) || `invention.constraint.${index + 1}`,
    surface: tidySurface(stringFrom(constraint.surface) || ""),
    weight: Math.max(0.000001, numberFrom(constraint.weight, 1)),
    satisfied: constraint.satisfied === true
  }));
  const untestedPerformanceClaim = trace.untestedPerformanceClaim === true || claimBasis.some(claim => claim.kind === "performance_prediction" || claim.force === "conjectured");
  return {
    nodeId: row.node.id,
    proposalSurface,
    basisEvidenceIds,
    basisPriorIds: stringArrayFromJson(row.metadata.basisPriorIds),
    noveltyScore: clamp01(numberFrom(row.metadata.noveltyScore, 0)),
    supportScore: clamp01(numberFrom(row.metadata.supportScore, basisEvidenceIds.length ? 0.52 : 0.22)),
    riskScore: clamp01(numberFrom(row.metadata.riskScore, 0.44)),
    proofStatusId: stringFrom(row.metadata.proofStatusId) || "proof.status.generated_not_evidence",
    claimBasis,
    constraints,
    untestedPerformanceClaim,
    trace: row.metadata.trace ?? {}
  };
}

function inventionClaimForce(value: JsonValue | undefined): InventionClaimBasisState["force"] {
  return value === "observed" || value === "inferred" || value === "invented" || value === "conjectured" ? value : "invented";
}

function inventionClaimKind(value: JsonValue | undefined): InventionClaimBasisState["kind"] {
  return value === "factual_premise" || value === "deduction" || value === "invention" || value === "performance_prediction" ? value : "invention";
}

function outputForceFromInventionClaim(force: InventionClaimBasisState["force"]): OutputForce {
  if (force === "observed") return "observed";
  if (force === "inferred") return "bounded";
  if (force === "conjectured") return "underdetermined";
  return "creative";
}

function graphNodeAnswerConstructRow(construct: ConstructGraph): { node: ConstructGraph["nodes"][number]; metadata: Record<string, JsonValue> } | undefined {
  return construct.nodes
    .map(node => ({ node, metadata: jsonRecord(node.metadata) }))
    .find(row => row.node.kind === "construct:graph_node_answer" || row.metadata.schema === "scce.graph_node_answer_construct.v1");
}

function insufficientSupportFocus(state: InsufficientSupportConstructState): string {
  const subject = tidySurface(state.selectedMainSubject);
  if (subject && !looksLikeInternalDiagnosticCode(subject.toLocaleLowerCase())) return subject;
  const focus = state.requestedFocuses.find(item => item && !looksLikeInternalDiagnosticCode(item.toLocaleLowerCase()));
  return focus ? displaySupportFocus(focus) : "";
}

function displaySupportFocus(value: string): string {
  return splitWhitespace(tidySurface(value))
    .map(stripOuterSurfaceBoundary)
    .filter(Boolean)
    .join(" ");
}

function joinSurfaceSentences(values: readonly string[]): string {
  return values.map(value => ensureSurfaceSentence(value)).filter(Boolean).join(" ");
}

function ensureSurfaceSentence(value: string): string {
  return ensureUnicodeSurfaceSentence(tidySurface(value));
}

function uniquePriorBoundFacts(facts: readonly SemanticAnswerFact[]): SemanticAnswerFact[] {
  const byKey = new Map<string, SemanticAnswerFact>();
  for (const fact of facts) {
    const key = [fact.subject, fact.predicate, fact.object].map(part => part.toLocaleLowerCase()).join("\u0001");
    const existing = byKey.get(key);
    if (!existing || fact.support + fact.activation + fact.overlap > existing.support + existing.activation + existing.overlap) byKey.set(key, fact);
  }
  return [...byKey.values()];
}

function sameSurfaceEntity(left: string, right: string): boolean {
  const a = tidySurface(left).toLocaleLowerCase();
  const b = tidySurface(right).toLocaleLowerCase();
  return Boolean(a && b && (a === b || a.includes(b) || b.includes(a)));
}

interface ProgramSurfaceSummary {
  programId: string;
  entrypoint: string;
  fileCount: number;
  sourceFiles: string[];
  configFiles: string[];
  testFiles: string[];
  docFiles: string[];
  observedValidation: string[];
  sourceDerivedValidation: string[];
  hydrationSchema?: string;
  hydrationValid?: boolean;
  symbolCount: number;
  missingDependencies: string[];
}

function programSurfaceSummary(program: NonNullable<ConstructGraph["program"]>): ProgramSurfaceSummary {
  const filesByRole = (role: "source" | "test" | "config" | "doc") => program.files.filter(file => file.role === role).map(file => file.path).slice(0, 12);
  const validations = program.hydration?.validations ?? [];
  const commandText = (item: typeof validations[number]) => [item.command.command, ...item.command.args].filter(Boolean).join(" ");
  return {
    programId: program.id,
    entrypoint: program.entrypoint,
    fileCount: program.files.length,
    sourceFiles: filesByRole("source"),
    configFiles: filesByRole("config"),
    testFiles: filesByRole("test"),
    docFiles: filesByRole("doc"),
    observedValidation: validations.filter(item => item.commandSource === "program.validation.command.observed").map(commandText),
    sourceDerivedValidation: validations.filter(item => item.commandSource === "program.validation.command.source_derived").map(commandText),
    hydrationSchema: program.hydration?.schema,
    hydrationValid: program.hydration?.valid,
    symbolCount: program.hydration?.symbols.length ?? 0,
    missingDependencies: program.hydration?.dependencies.filter(dep => dep.missing).map(dep => dep.packageName).slice(0, 8) ?? []
  };
}

function programPoint(summary: ProgramSurfaceSummary): string {
  const sourceFiles = summary.sourceFiles.length ? joinSurfaceClauses(summary.sourceFiles) : "";
  const testFiles = summary.testFiles.length ? joinSurfaceClauses(summary.testFiles) : "";
  const observed = summary.observedValidation.length ? joinSurfaceClauses(summary.observedValidation) : "";
  const sourceDerived = summary.sourceDerivedValidation.length ? joinSurfaceClauses(summary.sourceDerivedValidation) : "";
  const missing = summary.missingDependencies.length ? joinSurfaceClauses(summary.missingDependencies) : "";
  return compactHumanSentence([
    summary.entrypoint,
    sourceFiles,
    testFiles,
    observed,
    sourceDerived,
    missing
  ]);
}

function compactHumanSentence(parts: readonly string[]): string {
  const joined = parts.map(part => part.trim()).filter(Boolean).join(" ");
  const clean = tidySurface(joined);
  if (!clean) return clean;
  const last = clean[clean.length - 1] ?? "";
  return isLikelySentenceBoundary(last) ? clean : `${clean}.`;
}

function joinHuman(values: readonly string[]): string {
  const clean = values.map(value => value.trim()).filter(Boolean);
  if (clean.length <= 1) return clean[0] ?? "";
  return clean.join(", ");
}

function joinSurfaceClauses(values: readonly string[]): string {
  return values.map(value => value.trim()).filter(Boolean).join(": ");
}

function stringFrom(value: JsonValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function numberFrom(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? clamp01(value) : clamp01(fallback);
}

function scoreLabel(value: number): string {
  return value.toFixed(2);
}

function planHash(plan: SurfacePlan, hashText: (text: string) => string): string {
  return hashText(JSON.stringify({ thesis: plan.thesis, points: plan.orderedPoints.map(point => [point.id, point.force]), targetLanguage: plan.targetLanguage, targetScript: plan.targetScript ?? null, detailProfileId: plan.detailProfileId, constructForces: plan.constructForces.map(force => [force.id, force.weight]) })).slice(0, 24);
}

function patternSurfaceKeys(pattern: { patternJson: JsonValue }): string[] {
  const json = jsonRecord(pattern.patternJson);
  const counts = jsonRecord(json.counts);
  const out = Object.keys(counts);
  if (out.length) return out.slice(0, 64);
  for (const value of Object.values(json)) {
    if (typeof value === "string" && value.trim()) out.push(value.trim());
    if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string" && item.trim()) out.push(item.trim());
    }
  }
  return [...new Set(out)].slice(0, 64);
}

function overlapsClaim(text: string, claimText: string): boolean {
  const a = featureSet(text, 128);
  const b = featureSet(claimText, 128);
  return weightedJaccard(a, b) > 0.04 || invariantSymbols(text).some(symbol => claimText.includes(symbol.text));
}

function containsSurface(text: string, surface: string): boolean {
  return text.normalize("NFKC").toLocaleLowerCase().includes(surface.normalize("NFKC").toLocaleLowerCase());
}

function uniqueEvidenceIds(values: readonly EvidenceId[]): EvidenceId[] {
  const seen = new Set<string>();
  const out: EvidenceId[] = [];
  for (const value of values) {
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function invariantSymbols(text: string): Array<{ text: string; kind: "number" | "symbol" | "entity" }> {
  const out: Array<{ text: string; kind: "number" | "symbol" | "entity" }> = [];
  let symbol = "";
  const flush = () => {
    const value = symbol.trim();
    symbol = "";
    if (!value) return;
    const kind = invariantKind(value);
    if (kind) out.push({ text: value, kind });
  };
  for (const char of text.normalize("NFKC")) {
    if (isInvariantSymbolChar(char)) {
      symbol += char;
    } else {
      flush();
    }
  }
  flush();
  return out.slice(0, 128);
}

function invariantKind(value: string): "number" | "symbol" | "entity" | undefined {
  let digits = 0;
  let letters = 0;
  let symbols = 0;
  let dottedLetterOnly = true;
  for (const char of value) {
    if (isDigitChar(char)) {
      digits++;
      dottedLetterOnly = false;
    } else if (isLetterChar(char)) {
      letters++;
    } else {
      symbols++;
      if (char !== ".") dottedLetterOnly = false;
    }
  }
  if (digits > 0 && letters === 0) return "number";
  if (digits === 0 && letters > 0 && symbols > 0 && dottedLetterOnly) return undefined;
  if (symbols > 0 && value.length > 1) return "symbol";
  if (digits > 0 && letters > 0) return "symbol";
  if (letters > 0 && value.length >= 2 && hasCaseSignal(value)) return "entity";
  return undefined;
}

function isInvariantSymbolChar(char: string): boolean {
  return isLetterChar(char) || isDigitChar(char) || char === "." || char === ":" || char === "_" || char === "-" || char === "/" || char === "#" || char === "@" || char === "$" || char === "%";
}

function isLetterChar(char: string): boolean {
  return char.toLocaleLowerCase() !== char.toLocaleUpperCase();
}

function isDigitChar(char: string): boolean {
  const code = char.charCodeAt(0);
  return code >= 48 && code <= 57;
}

function hasCaseSignal(value: string): boolean {
  return hasUppercaseLetter(value) || hasUncasedNonLatinLetter(value);
}

function splitLines(text: string): string[] {
  const lines: string[] = [];
  let current = "";
  for (const char of text) {
    if (char === "\r") continue;
    if (char === "\n") {
      lines.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  lines.push(current);
  return lines;
}

function collapseWhitespace(text: string): string {
  const out: string[] = [];
  let pending = false;
  for (const char of text) {
    if (isWhitespaceChar(char)) {
      pending = out.length > 0;
      continue;
    }
    if (pending) out.push(" ");
    pending = false;
    out.push(char);
  }
  return out.join("");
}

function tidySurface(text: string): string {
  return collapseConsecutiveBoundaryGlyphs(collapseWhitespace(text.normalize("NFC")).trim());
}

function collapseConsecutiveBoundaryGlyphs(text: string): string {
  let out = "";
  for (const char of text) {
    const previous = out[out.length - 1] ?? "";
    if (isLikelySentenceBoundary(char) && previous === char) continue;
    if (isLikelyInlineOnlyBoundary(char) && previous === char) continue;
    out += char;
  }
  return out;
}

function splitWhitespace(text: string): string[] {
  const symbols: string[] = [];
  let current = "";
  for (const char of text) {
    if (isWhitespaceChar(char)) {
      if (current) {
        symbols.push(current);
        current = "";
      }
    } else {
      current += char;
    }
  }
  if (current) symbols.push(current);
  return symbols;
}

function isWhitespaceChar(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v";
}

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
