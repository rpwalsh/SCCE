import type { BoundaryProfile } from "./control-plane-profiles.js";
import type { MeterPattern, RegisterVector } from "./correction-memory.js";
import type { EvidenceId, JsonValue } from "./types.js";

export type LanguageId = string;
export type ScriptId = string;
export type ConstructNodeId = string;
export type SurfaceFormId = string;
export type StyleProfileId = string;
export type RegisterId = string;
export type DetailProfileId = string;
export type MeterPatternId = string;
export type OutputForce = "entailed" | "observed" | "bounded" | "underdetermined" | "contradicted" | "creative";
export type ConstructOutputForce =
  | "ConversationConstruct"
  | "ExplanationConstruct"
  | "RewriteConstruct"
  | "CreativeConstruct"
  | "FactualConstruct"
  | "ProgramConstruct"
  | "TranslationConstruct"
  | "PlanningConstruct"
  | "InferenceConstruct"
  | "ConjectureConstruct"
  | "ImportSummaryConstruct";
export type SurfaceRole = "answer" | "support" | "caveat" | "example" | "instruction" | "conclusion" | "transition";
export type DiscourseUnitRole = SurfaceRole | "artifact_summary";
export type DiscourseBoundaryKind = "none" | "within_sentence" | "sentence";

export interface SurfaceTerm {
  id: string;
  text: string;
  source: "claim" | "obligation" | "construct" | "language-memory" | "correction";
  weight: number;
}

export interface DiscourseUnit {
  id: string;
  role: DiscourseUnitRole;
  frameIds: string[];
  groupId: string;
  sentenceIndex: number;
  boundaryBefore: DiscourseBoundaryKind;
  caveatPlacement?: "after_support" | "inline";
  examplePlacement?: "after_support" | "inline";
  conclusionPlacement?: "final";
  generationExtent: number;
  targetDetailProfileId: DetailProfileId;
  targetStyleProfileId: StyleProfileId;
  registerVector?: RegisterVector;
}

export interface DiscoursePlan {
  id: string;
  units: DiscourseUnit[];
  maxSentenceCount: number;
  targetDetailProfileId: DetailProfileId;
  targetStyleProfileId: StyleProfileId;
  boundaryProfile: BoundaryProfile;
  registerVector?: RegisterVector;
  audit: JsonValue;
}

export interface StyleProfile {
  name?: string;
  density?: number;
  formality?: number;
  creativity?: number;
  exposeProofTerms?: boolean;
}

export interface EvidenceBinding {
  pointId: string;
  evidenceId: EvidenceId;
  sourceVersionId: string;
  support: number;
}

export interface ForceBinding {
  pointId: string;
  force: OutputForce;
  constructForce: ConstructOutputForce;
  support: number;
  contradiction: number;
}

export interface CaveatBinding {
  pointId: string;
  reason: string;
  severity: "low" | "medium" | "high";
}

export interface SurfacePoint {
  id: string;
  constructNodeId?: ConstructNodeId;
  proposition: string;
  force: OutputForce;
  evidenceIds: EvidenceId[];
  caveat?: string;
  role: SurfaceRole;
  support: number;
  contradiction: number;
  realizationConstraints: JsonValue;
}

export interface PropositionAtom {
  id: string;
  text: string;
  kind: "claim" | "quantity" | "symbol" | "entity" | "caveat" | "artifact" | "program" | "surface";
  source: string;
  weight: number;
  evidenceIds: EvidenceId[];
}

export interface RealizationOrdering {
  index: number;
  previousPointId?: string;
  nextPointId?: string;
  relation: "linear";
  weight: number;
}

export interface RealizationFrame {
  id: string;
  pointId: string;
  role: SurfaceRole;
  force: OutputForce;
  constructForce: ConstructOutputForce;
  propositionAtoms: PropositionAtom[];
  requiredTerms: SurfaceTerm[];
  forbiddenSurfaceIds: SurfaceFormId[];
  caveat?: CaveatBinding;
  evidenceBinding?: EvidenceBinding;
  targetLanguage: LanguageId;
  targetScript?: ScriptId;
  styleProfileId: StyleProfileId;
  registerVector?: RegisterVector;
  detailProfileId: DetailProfileId;
  semanticFrameIds: string[];
  ordering: RealizationOrdering;
  realizationConstraints: JsonValue;
}

export interface SurfacePlan {
  thesis?: ConstructNodeId;
  orderedPoints: SurfacePoint[];
  realizationFrames: RealizationFrame[];
  requiredTerms: SurfaceTerm[];
  forbiddenSurfaces: SurfaceFormId[];
  evidenceBindings: EvidenceBinding[];
  forceBindings: ForceBinding[];
  caveatBindings: CaveatBinding[];
  constructForces: Array<{ id: ConstructOutputForce; weight: number; source: string }>;
  targetLanguage: LanguageId;
  targetScript?: ScriptId;
  styleProfileId: StyleProfileId;
  style: Required<StyleProfile>;
  registerId?: RegisterId;
  registerVector?: RegisterVector;
  detailProfileId: DetailProfileId;
  boundaryProfile: BoundaryProfile;
  meterPattern?: MeterPattern;
  meterPatternId?: MeterPatternId;
  audit: JsonValue;
}
