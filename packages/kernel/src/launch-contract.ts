import type {
  AssistantForceClass,
  EvidenceId,
  EvidenceSpan,
  JsonValue,
  RetrievalRole,
  RuntimeCalibrationStatus,
  RuntimeCalibrationSummary,
  RuntimeAnswerBasis,
  RuntimeEvidenceForce,
  RuntimeGuardFlags,
  RuntimeRetrievalRoleTrace,
  RuntimeScoreTrace,
  RuntimeTruthState,
  SemanticEntailmentResult,
  TruthState,
  TurnResult
} from "./types.js";
import { clamp01 } from "./primitives.js";
import type { HybridRecallResult } from "./retrieval.js";
import type { ScoreTrace } from "./scoring/score-trace.js";

export interface LaunchContractInput {
  entailment: SemanticEntailmentResult;
  evidence: readonly EvidenceSpan[];
  assistantForce?: AssistantForceClass;
  scoreTraces?: readonly ScoreTrace[];
  retrievalRoles?: readonly RuntimeRetrievalRoleTrace[];
  preservationChecked?: boolean;
  unsupportedContentBlocked?: boolean;
  now?: number;
}

export type LaunchContractFields = Pick<
  TurnResult,
  "scoreTraces" | "calibrationStatus" | "calibration" | "truthState" | "answerBasis" | "evidenceForce" | "guardFlags" | "retrievalRoles"
>;

const ANSWER_BASIS_IDS = {
  sourceCertified: "basis.1c0e8f42",
  sourceBound: "basis.54d2a9be",
  reasoned: "basis.9f1b2c7a",
  learnedPrior: "basis.72c64a18",
  creative: "basis.31d7b08e",
  speculative: "basis.6ab817c5",
  unsupported: "basis.e13a0d2f",
  clarifyingNeeded: "basis.0b7f31ce"
} as const;

const ANSWER_CERTIFICATION_IDS = {
  sourceCertified: "cert.7aa1c993",
  sourceBound: "cert.2b4f8a11",
  nonCertifying: "cert.4e8b2d11"
} as const;

const ANSWER_BASIS_REASON_IDS = {
  directEvidence: "basis.reason.19b246c1",
  sourceBound: "basis.reason.2a7d0c9e",
  learnedPrior: "basis.reason.889ae213",
  inference: "basis.reason.62d84a7b",
  creative: "basis.reason.346c9f20",
  conjecture: "basis.reason.b0d4c195",
  unsupported: "basis.reason.ef13a841",
  contradiction: "basis.reason.403af5b6"
} as const;

export function launchContractForTurn(input: LaunchContractInput): LaunchContractFields {
  const retrievalRoles = input.retrievalRoles ?? [];
  const scoreTraces = uniqueScoreTraces([
    ...(input.scoreTraces ?? []).map(runtimeScoreTrace),
    ...retrievalRoles.flatMap(role => role.scoreTraces)
  ]);
  const evidenceForce = runtimeEvidenceForce({ evidence: input.evidence, assistantForce: input.assistantForce, entailment: input.entailment });
  const truthState = runtimeTruthState({
    entailment: input.entailment,
    evidence: input.evidence,
    evidenceForce,
    now: input.now ?? Date.now()
  });
  const answerBasis = runtimeAnswerBasis({
    entailment: input.entailment,
    evidence: input.evidence,
    evidenceForce,
    truthState,
    assistantForce: input.assistantForce
  });
  const calibrationStatus = calibrationStatusFor(scoreTraces);
  const calibration = runtimeCalibrationSummary({ status: calibrationStatus, scoreTraces, entailment: input.entailment });
  return {
    scoreTraces,
    calibrationStatus,
    calibration,
    truthState,
    answerBasis,
    evidenceForce,
    guardFlags: runtimeGuardFlags({
      entailment: input.entailment,
      evidence: input.evidence,
      evidenceForce,
      assistantForce: input.assistantForce,
      preservationChecked: input.preservationChecked ?? false,
      unsupportedContentBlocked: input.unsupportedContentBlocked
    }),
    retrievalRoles: retrievalRoles.length ? [...retrievalRoles] : undefined
  };
}

function runtimeAnswerBasis(input: {
  entailment: SemanticEntailmentResult;
  evidence: readonly EvidenceSpan[];
  evidenceForce: RuntimeEvidenceForce;
  truthState: RuntimeTruthState;
  assistantForce?: AssistantForceClass;
}): RuntimeAnswerBasis {
  const symbolicState = input.truthState.symbolicState;
  const reasonIds: string[] = [];
  let basisClassId: string = ANSWER_BASIS_IDS.unsupported;
  let certificationId: string = ANSWER_CERTIFICATION_IDS.nonCertifying;
  let certifiesSourceClaim = false;
  if (input.entailment.contradiction > 0.05 || symbolicState === "truth.contradicted") reasonIds.push(ANSWER_BASIS_REASON_IDS.contradiction);
  if (input.assistantForce === "creative_answer" || input.evidenceForce === "creative" || input.entailment.force === "invented") {
    basisClassId = ANSWER_BASIS_IDS.creative;
    reasonIds.push(ANSWER_BASIS_REASON_IDS.creative);
  } else if (symbolicState === "truth.certified" && input.evidenceForce === "direct" && input.evidence.length > 0) {
    basisClassId = ANSWER_BASIS_IDS.sourceCertified;
    certificationId = ANSWER_CERTIFICATION_IDS.sourceCertified;
    certifiesSourceClaim = true;
    reasonIds.push(ANSWER_BASIS_REASON_IDS.directEvidence);
  } else if (input.evidenceForce === "direct" || input.assistantForce === "source_grounded_answer" || symbolicState === "truth.source_bound_only") {
    basisClassId = ANSWER_BASIS_IDS.sourceBound;
    certificationId = ANSWER_CERTIFICATION_IDS.sourceBound;
    reasonIds.push(ANSWER_BASIS_REASON_IDS.sourceBound);
  } else if (input.evidenceForce === "prior" || input.assistantForce === "learned_corpus_answer") {
    basisClassId = ANSWER_BASIS_IDS.learnedPrior;
    reasonIds.push(ANSWER_BASIS_REASON_IDS.learnedPrior);
  } else if (input.assistantForce === "reasoned_answer" || input.entailment.force === "inferred") {
    basisClassId = ANSWER_BASIS_IDS.reasoned;
    reasonIds.push(ANSWER_BASIS_REASON_IDS.inference);
  } else if (input.assistantForce === "conjecture" || input.evidenceForce === "conjecture" || input.entailment.force === "conjectured") {
    basisClassId = ANSWER_BASIS_IDS.speculative;
    reasonIds.push(ANSWER_BASIS_REASON_IDS.conjecture);
  } else {
    basisClassId = ANSWER_BASIS_IDS.unsupported;
    reasonIds.push(ANSWER_BASIS_REASON_IDS.unsupported);
  }
  return {
    schema: "scce.runtime.answer_basis.v1",
    basisClassId,
    certificationId,
    evidenceForce: input.evidenceForce,
    truthState: symbolicState,
    supportMass: input.truthState.supportMass,
    contradictionMass: input.truthState.contradictionMass,
    uncertaintyMass: input.truthState.uncertaintyMass,
    sourceEvidenceCount: input.evidence.length,
    certifiesSourceClaim,
    fakeEvidenceForbidden: true,
    reasonIds: [...new Set(reasonIds)]
  };
}

export function retrievalRoleTracesFromHybridRecall(recall: readonly HybridRecallResult[]): RuntimeRetrievalRoleTrace[] {
  return recall.map(item => ({
    evidenceId: item.evidenceId as EvidenceId,
    role: item.evidenceRole,
    score: clamp01(item.score),
    reason: item.reason,
    scoreTraces: item.scoreTrace.map(runtimeScoreTrace)
  }));
}

export function runtimeScoreTrace(trace: ScoreTrace | RuntimeScoreTrace): RuntimeScoreTrace {
  return {
    id: trace.id,
    kind: trace.kind,
    value: trace.value,
    range: trace.range,
    meaning: trace.meaning,
    inputs: trace.inputs,
    provenance: trace.provenance,
    calibrated: trace.calibrated,
    calibrationId: trace.calibrationId,
    failureModes: trace.failureModes
  };
}

function runtimeTruthState(input: {
  entailment: SemanticEntailmentResult;
  evidence: readonly EvidenceSpan[];
  evidenceForce: RuntimeEvidenceForce;
  now: number;
}): RuntimeTruthState {
  const supportMass = clamp01(input.entailment.support);
  const contradictionMass = clamp01(input.entailment.contradiction);
  const uncertaintyMass = clamp01(1 - Math.min(1, supportMass + contradictionMass));
  const normalizer = Math.max(0.000001, supportMass + contradictionMass + uncertaintyMass);
  const observedAts = input.evidence.map(span => span.observedAt).filter(Number.isFinite);
  return {
    symbolicState: input.entailment.truthState ?? symbolicTruthState(input.entailment),
    beliefLower: clamp01(supportMass / normalizer),
    plausibilityUpper: clamp01((supportMass + uncertaintyMass) / normalizer),
    supportMass,
    contradictionMass,
    uncertaintyMass,
    validityInterval: observedAts.length ? { start: Math.min(...observedAts), end: null } : null,
    evidenceForce: input.evidenceForce,
    freshness: evidenceFreshness(input.evidence, input.now),
    sourceDiversity: sourceDiversity(input.evidence)
  };
}

function runtimeGuardFlags(input: {
  entailment: SemanticEntailmentResult;
  evidence: readonly EvidenceSpan[];
  evidenceForce: RuntimeEvidenceForce;
  assistantForce?: AssistantForceClass;
  preservationChecked: boolean;
  unsupportedContentBlocked?: boolean;
}): RuntimeGuardFlags {
  const missingEvidence = input.evidence.length === 0;
  const contradictionPresent = input.entailment.contradiction > 0.05 || input.entailment.verdict === "contradicted";
  const allowCreative = input.assistantForce === "creative_answer" || input.entailment.force === "invented";
  const sourceBacked = input.evidenceForce === "direct" || input.evidenceForce === "inferred";
  const priorOnly = input.evidenceForce === "prior" || input.entailment.truthState === "truth.unsupported_prior_only";
  return {
    requireEvidence: !allowCreative,
    blockCertifiedFact: contradictionPresent || priorOnly || (missingEvidence && !allowCreative),
    allowInference: !contradictionPresent && (sourceBacked || input.entailment.force === "inferred"),
    allowCreative,
    exposeContradiction: contradictionPresent,
    sourceBacked,
    missingEvidence,
    contradictionPresent,
    preservationChecked: input.preservationChecked,
    unsupportedContentBlocked: input.unsupportedContentBlocked ?? (priorOnly || (missingEvidence && !allowCreative))
  };
}

function runtimeEvidenceForce(input: {
  evidence: readonly EvidenceSpan[];
  assistantForce?: AssistantForceClass;
  entailment: SemanticEntailmentResult;
}): RuntimeEvidenceForce {
  if (input.assistantForce === "creative_answer") return "creative";
  const classes = input.evidence.map(evidenceForceClass);
  if (classes.some(item => item === "direct_evidence" || item === "source_evidence")) return "direct";
  if (classes.some(item => item === "profile_excerpt_evidence" || item === "source_bound_evidence")) return "inferred";
  if (classes.some(item => item.startsWith("learned_") || item.endsWith("_prior"))) return "prior";
  if (input.entailment.force === "invented") return "creative";
  if (input.entailment.force === "conjectured") return "conjecture";
  if (input.evidence.length && (input.entailment.force === "observed" || input.entailment.force === "proved" || input.entailment.force === "inferred")) return "inferred";
  return "unknown";
}

function evidenceForceClass(span: EvidenceSpan): string {
  const trust = jsonRecord(span.trustVector);
  const provenance = jsonRecord(span.provenance);
  const raw = trust.forceClass ?? provenance.provenanceClass ?? provenance.forceClass ?? provenance.class;
  return typeof raw === "string" ? raw : "";
}

function calibrationStatusFor(scoreTraces: readonly RuntimeScoreTrace[]): RuntimeCalibrationStatus {
  if (!scoreTraces.length) return "uncalibrated";
  const calibrated = scoreTraces.filter(trace => trace.calibrated || trace.kind === "calibrated_probability").length;
  if (calibrated === scoreTraces.length) return "calibrated";
  return calibrated > 0 ? "partial" : "uncalibrated";
}

function runtimeCalibrationSummary(input: {
  status: RuntimeCalibrationStatus;
  scoreTraces: readonly RuntimeScoreTrace[];
  entailment: SemanticEntailmentResult;
}): RuntimeCalibrationSummary {
  const rawScore = clamp01(input.entailment.support * 0.62 + input.entailment.faithfulnessLcb * 0.25 + (1 - input.entailment.contradiction) * 0.13);
  const calibrationId = input.scoreTraces.find(trace => trace.calibrationId)?.calibrationId;
  return {
    taskClass: "runtime.turn.answer",
    rawScore,
    calibrationStatus: input.status,
    calibrationId,
    reliabilityBucket: rawScore >= 0.8 ? "high" : rawScore >= 0.55 ? "medium" : "low"
  };
}

function symbolicTruthState(entailment: SemanticEntailmentResult): TruthState {
  if (entailment.verdict === "contradicted" || entailment.contradiction > 0.4) return "truth.contradicted";
  if (entailment.support >= 0.78 && entailment.faithfulnessLcb >= 0.65 && entailment.evidenceIds.length > 0) return "truth.certified";
  if (entailment.evidenceIds.length === 0) return "truth.insufficient_evidence";
  if (entailment.force === "conjectured") return "truth.ambiguous";
  return "truth.source_bound_only";
}

function evidenceFreshness(evidence: readonly EvidenceSpan[], now: number): number {
  if (!evidence.length) return 0;
  const yearMs = 365 * 24 * 60 * 60 * 1000;
  return mean(evidence.map(span => {
    if (!Number.isFinite(span.observedAt)) return 0;
    const age = Math.max(0, now - span.observedAt);
    return clamp01(1 - age / yearMs);
  }));
}

function sourceDiversity(evidence: readonly EvidenceSpan[]): number {
  if (!evidence.length) return 0;
  const sources = new Set(evidence.map(span => String(span.sourceVersionId || span.sourceId || span.id)));
  return clamp01(sources.size / evidence.length);
}

function uniqueScoreTraces(traces: readonly RuntimeScoreTrace[]): RuntimeScoreTrace[] {
  const out = new Map<string, RuntimeScoreTrace>();
  for (const trace of traces) out.set(trace.id, trace);
  return [...out.values()];
}

function mean(values: readonly number[]): number {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}
