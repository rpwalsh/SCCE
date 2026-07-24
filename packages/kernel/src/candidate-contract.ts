import type { ClaimBasis } from "./cognitive-planner.js";
import type { ScoreTrace } from "./scoring/score-trace.js";
import type { EpistemicForce, EvidenceId, JsonValue } from "./types.js";

export interface CandidateSurface {
  id: string;
  kind:
    | "proof-answer"
    | "ccr-extractive"
    | "graph-inference"
    | "reasoned-synthesis"
    | "causal-inference"
    | "temporal-inference"
    | "counterfactual-response"
    | "creative-candidate"
    | "transformation"
    | "translation"
    | "program-proposal"
    | "workspace-proposal"
    | "action-preview"
    | "dialogue-continuation";
  answer: string;
  force: EpistemicForce;
  evidenceIds: EvidenceId[];
  scores: {
    support: number;
    contradiction: number;
    faithfulness: number;
    alphaPressure: number;
    actionability: number;
    evidenceCoverage: number;
    novelty: number;
    realizability: number;
    constraintCoverage?: number;
    graphCoherence?: number;
    languageRealizability?: number;
    usefulness?: number;
    risk?: number;
    repetition?: number;
    unsupportedFactualAssertion?: number;
    creativeSelectionScore?: number;
  };
  quality?: CandidateQuality;
  proposalId?: string;
  constructIds?: string[];
  claimBases?: ClaimBasis[];
  satisfiedRequirementIds?: string[];
  missedRequirementIds?: string[];
  boundaries: string[];
  audit: JsonValue;
  scoreTrace?: ScoreTrace[];
}

export interface CandidateQuality {
  requirementCoverage: number;
  truthSupport: number;
  sourceFidelity: number;
  novelty: number;
  semanticPreservation: number;
  transformationQuality: number;
  inferentialContinuity: number;
  explanatoryPower: number;
  executableCompleteness: number;
  dialogueContinuity: number;
  languageQuality: number;
  usefulness: number;
  coherence: number;
  uncertaintyCalibration: number;
  formatFit: number;
  styleFit: number;
  directness: number;
  structure: number;
  repetition: number;
  contradiction: number;
  unsupportedFactRate: number;
  fakeFactualAuthority: number;
  staleSourceRisk: number;
  testWeakening: number;
  telemetryLeak: number;
}

export interface CandidateField {
  candidates: CandidateSurface[];
  surfaceMass: Array<{
    candidateId: string;
    mass: number;
    reason: string;
    rawMass?: number;
    calibrated?: boolean;
    calibrationId?: string;
  }>;
  audit: JsonValue;
  scoreTrace: ScoreTrace[];
}
