// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CorrectionRuleRecord, LanguagePatternRecord } from "./storage.js";
import type { CreativeRequestFrame } from "./creative-event-compatibility.js";
import type { NarrativeConditioning } from "./document-generation-session.js";
import type { CandidateSurface } from "./candidate.js";
import type { DiscoursePlanningHandoffV2 } from "./discourse-state.js";
import type { CognitiveProposal, PlannedClaim } from "./cognitive-planner.js";
import type {
  ConstructGraph,
  EvidenceId,
  EvidenceSpan,
  FieldState,
  JsonValue,
  LanguageProfile,
  RequestedAuthority,
  SemanticEntailmentResult
} from "./types.js";
import type { TurnRequirementField } from "./turn-requirements.js";
import type { SemanticRealizationContract } from "./semantic-answer-construct.js";
import type { ContinueDecision } from "./learning-loop.js";
import type {
  DetailProfileId,
  LanguageId,
  MeterPatternId,
  OutputForce,
  RegisterId,
  ScriptId,
  StyleProfile,
  StyleProfileId,
  SurfacePlan
} from "./mouth-types.js";
import type { SurfaceOutputFeature, SurfaceRevisionConstraint } from "./walsh-surface-energy.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import type { MeterPattern, RegisterVector } from "./correction-memory.js";
import type { DialogueState, UserStyleProfile } from "./dialogue-pragmatics.js";
import type { ConstructionCycleConsistencyOutcome } from "./construction-cycle-consistency.js";
import type { CalibrationModelSet } from "./calibration-spine.js";
import type { ConversationTurnSurface } from "./language-construction.js";
import type { RequestCommunicativeActClassification } from "./request-communicative-act.js";

export type SurfaceCandidatePath = "generated";

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
  candidates: Array<{ id: string; style: string; path: SurfaceCandidatePath; textHash: string; textPreview?: string; score: number; changedByCorrections: number; preservation: number; forbiddenHits: number; forbiddenHitIds?: string[]; importedPieceIds: string[]; semanticCandidateId?: string; semanticPlanId?: string; surfaceRealizationId?: string; audit?: JsonValue }>;
  selected: { id: string; path: SurfaceCandidatePath; textHash: string; languageActivation: number; semanticPreservation: number; semanticCandidateId?: string; semanticPlanId?: string; surfaceRealizationId?: string; audit?: JsonValue };
  languageMemory: JsonValue;
  brainInfluence: JsonValue;
  corrections: JsonValue;
  preservation: JsonValue;
  surfaceRepair: JsonValue;
  walshSurfaceEnergy: JsonValue;
  /** The one contract this surface passed, stage by stage. Absent means a path reached a user without it. */
  surfaceContract?: JsonValue;
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
  conversationId?: string;
  requestTurnId?: string;
  previousConversationPlan?: import("./conversation-plan-memory.js").ConversationPlanState;
  /** Actual request for echo comparison; an absent request never makes selected factual content a question. */
  requestText?: string;
  /** Source-owned request controls guide coverage and never enter generative memory. */
  requestControlPatterns?: readonly LanguagePatternRecord[];
  programBehaviorRequirements?: readonly import("./types.js").ProgramBehaviorRequirement[];
  codeFunctionPatterns?: readonly LanguagePatternRecord[];
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
  /** Opaque identity for the requested realization language; never a locale/display alias. */
  targetLanguageIdentityId?: string;
  answerDraft?: string;
  targetLanguage?: LanguageId;
  /** Formal language this turn's artifact is written in, when the request named one. */
  codeLanguage?: string;
  /** Judges a candidate wording against this turn's evidence, so faithfulness is meaning, not vocabulary. */
  meaningVerifier?: (text: string) => { support: number; contradiction: number };
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
  /** Evidence explicitly bound by the discourse state for this turn. */
  explicitContextEvidenceIds?: ReadonlySet<string>;
  calibrationModels?: CalibrationModelSet;
  calibrationTaskClass?: string;
  requestedAuthority?: RequestedAuthority;
  /** Typed request structure compiled by the language layer; Mouth uses its spans as content constraints. */
  creativeRequestFrame?: CreativeRequestFrame;
  narrativeConditioning?: NarrativeConditioning;
  /** Durable, typed interaction profile used to condition realization. */
  dialogueUserStyleProfile?: UserStyleProfile;
  /** Prior-turn rejected surfaces constrain realization only; they never alter evidence admissibility. */
  dialogueRejectedAssumptions?: readonly string[];
  /** Restored turn-level continuity used as bounded learned-generation context. */
  dialogueContinuity?: Pick<DialogueState, "activeTask" | "establishedFacts" | "unresolvedSlots">;
  /** Turns of this conversation, as the caller observed them. The only material a conversation-bound unit may cite. */
  conversationTurns?: readonly ConversationTurnSurface[];
  /** The induced act this request classified as. An active, non-neutral act is what licenses the conversation-bound lane. */
  requestCommunicativeAct?: RequestCommunicativeActClassification;
  /** Proof-bearing V2 continuity from the canonical production turn. */
  dialoguePlanningHandoff?: DiscoursePlanningHandoffV2;
  semanticInput?: MouthSemanticInput;
  /** Lets a short bound value (a bare date/time/name the request's own subject+relation demanded, e.g. "20:17"
   *  for "when did X land") satisfy coverage without lexically restating the request -- see coversRequest below. */
  realizationContract?: SemanticRealizationContract;
  /** Warm durable construction scores; loading them never blocks the first response. */
  cycleConsistencyByConstructionId?: ReadonlyMap<string, number>;
  /** Stable turn trace identity attached to a cycle observation. */
  constructionCycleSourceTraceId?: string;
}

export interface SpokenOutput {
  text: string;
  realizationAvailability: { status: "realized" } | { status: "insufficient_support"; decisionId: string; reasonId?: string } | { status: "realization_unavailable"; reasonId: string; eligibleCandidateCount: number };
  language: LanguageId;
  force: OutputForce;
  evidenceRefs: EvidenceId[];
  uncertainty: UncertaintyMarker[];
  inspectRefs: InspectRef[];
  realizationTrace: RealizationTrace;
  surfacePlan: SurfacePlan;
  /**
   * False when `text` still failed a real hard quality/safety gate
   * (forbidden surface, canned speech, phrase salad, telemetry leak,
   * semantic meaning loss, direct-quote mutation, dropped required output,
   * format violation) even after the conservative-retry re-render -- these
   * are genuine structural-validity failures, distinct from thin/absent
   * evidence, which is never a reason to withhold or flag the surface.
   * Callers should treat this as a real reason to regenerate, not just
   * log it.
   */
  surfaceValid: boolean;
  hardSurfaceViolationIds: string[];
  /** The selected learned construction's typed meaning/surface cycle, if one won. */
  constructionCycleOutcome?: ConstructionCycleConsistencyOutcome;
}

export interface Mouth {
  speak(input: SpeakInput): Promise<SpokenOutput>;
}
