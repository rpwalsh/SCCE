import type { EvidenceId, JsonValue, NodeId } from "./types.js";

export type SemanticAtomPolarity = 1 | -1;
export type SemanticProofVerdict = string;
export type SemanticConstraintKind = string;

export interface SemanticRoleBinding {
  name: string;
  value: string;
  normalized: string;
  type: string;
  features: string[];
  weight: number;
  nodeId?: NodeId;
  evidenceId?: EvidenceId;
}

export interface SemanticQuantity {
  value: number;
  unit?: string;
  lower?: number;
  upper?: number;
  inclusiveLower: boolean;
  inclusiveUpper: boolean;
}

export interface SemanticTemporalScope {
  lower?: number;
  upper?: number;
  instant?: number;
  granularity: string;
}

export interface SemanticConstraint {
  id: string;
  kind: SemanticConstraintKind;
  subject: string;
  operator: string;
  value: JsonValue;
  confidence: number;
  evidenceIds: EvidenceId[];
}

export interface SemanticAtom {
  id: string;
  predicate: string;
  predicateFeatures: string[];
  roles: SemanticRoleBinding[];
  constraints: SemanticConstraint[];
  polarity: SemanticAtomPolarity;
  alpha: number;
  modality: string;
  source: string;
  sourceText: string;
  evidenceIds: EvidenceId[];
  nodeIds: NodeId[];
  vector: number[];
  proofClass: string;
  certifiesFactualProof: boolean;
  proofBoundaryReason?: string;
}
