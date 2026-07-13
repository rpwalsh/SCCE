import type { AssistantForceClass, EvidenceSpan, JsonValue, SemanticEntailmentResult } from "./types.js";
import type { CounterfactualWorld } from "./counterfactual-cognition.js";
import type { RuntimeReadiness } from "./runtime-orchestrator.js";
import { clamp01, mean, toJsonValue } from "./primitives.js";

export const RUNTIME_COHERENCE_DIMENSION_IDS = {
  discourseObject: "coh.dim.0d4a8c21",
  evidenceCluster: "coh.dim.71e3b902",
  genericContamination: "coh.dim.a4d11e6c",
  proofState: "coh.dim.449bc73f",
  counterfactualStability: "coh.dim.e2a70b19",
  mouthSurface: "coh.dim.8f6d10a2",
  languagePriorLeakage: "coh.dim.b12409dd",
  runtimeReadiness: "coh.dim.53c92e41"
} as const;

export const RUNTIME_COHERENCE_REPAIR_TARGET_IDS = {
  evidenceActivation: "coh.repair.391ab7ce",
  proofDemotion: "coh.repair.90e14f2b",
  mouthRegeneration: "coh.repair.c786d441",
  readinessRepair: "coh.repair.2f650a8d",
  sourceQuarantine: "coh.repair.741e6f05"
} as const;

export interface RuntimeCoherenceDecision {
  schema: "scce.runtime_coherence_decision.v1";
  coherenceMass: number;
  instabilityMass: number;
  repairRequired: boolean;
  emitAllowed: boolean;
  demotionRequired: boolean;
  failedDimensionIds: string[];
  repairTargetIds: string[];
  assistantForceBefore: AssistantForceClass;
  assistantForceAfter: AssistantForceClass;
  influenceIds: string[];
  audit: JsonValue;
}

export interface RuntimeCoherenceInput {
  requestText: string;
  answerText: string;
  evidence: readonly EvidenceSpan[];
  entailment: SemanticEntailmentResult;
  assistantForce: AssistantForceClass;
  counterfactual?: CounterfactualWorld;
  readiness?: RuntimeReadiness;
  discourseObject?: JsonValue;
  mouthAudit?: JsonValue;
  selectedCandidateAudit?: JsonValue;
}

export function decideRuntimeCoherence(input: RuntimeCoherenceInput): RuntimeCoherenceDecision {
  const failedDimensionIds: string[] = [];
  const repairTargetIds: string[] = [];
  const pressures: number[] = [];
  const evidenceCluster = evidenceClusterCoherence(input.evidence);
  if (evidenceCluster.pressure > 0.34) {
    failedDimensionIds.push(RUNTIME_COHERENCE_DIMENSION_IDS.evidenceCluster);
    repairTargetIds.push(RUNTIME_COHERENCE_REPAIR_TARGET_IDS.evidenceActivation);
    pressures.push(evidenceCluster.pressure);
  }
  const generic = genericContaminationPressure(input.requestText, input.evidence);
  if (generic > 0.42) {
    failedDimensionIds.push(RUNTIME_COHERENCE_DIMENSION_IDS.genericContamination);
    repairTargetIds.push(RUNTIME_COHERENCE_REPAIR_TARGET_IDS.sourceQuarantine);
    pressures.push(generic);
  }
  const proofPressure = proofPressureFrom(input.entailment);
  if (proofPressure > 0.58) {
    failedDimensionIds.push(RUNTIME_COHERENCE_DIMENSION_IDS.proofState);
    repairTargetIds.push(RUNTIME_COHERENCE_REPAIR_TARGET_IDS.proofDemotion);
    pressures.push(proofPressure);
  }
  const counterfactualPressure = counterfactualInstability(input.counterfactual);
  if (counterfactualPressure > 0.5) {
    failedDimensionIds.push(RUNTIME_COHERENCE_DIMENSION_IDS.counterfactualStability);
    repairTargetIds.push(RUNTIME_COHERENCE_REPAIR_TARGET_IDS.proofDemotion);
    pressures.push(counterfactualPressure);
  }
  const mouthPressure = mouthLeakagePressure(input.answerText, input.mouthAudit);
  if (mouthPressure > 0.01) {
    failedDimensionIds.push(RUNTIME_COHERENCE_DIMENSION_IDS.mouthSurface);
    repairTargetIds.push(RUNTIME_COHERENCE_REPAIR_TARGET_IDS.mouthRegeneration);
    pressures.push(mouthPressure);
  }
  const languagePriorPressure = languagePriorLeakage(input.assistantForce, input.evidence);
  if (languagePriorPressure > 0.01) {
    failedDimensionIds.push(RUNTIME_COHERENCE_DIMENSION_IDS.languagePriorLeakage);
    repairTargetIds.push(RUNTIME_COHERENCE_REPAIR_TARGET_IDS.proofDemotion);
    pressures.push(languagePriorPressure);
  }
  const readinessPressure = runtimeReadinessPressure(input.readiness);
  if (readinessPressure > 0.5) {
    failedDimensionIds.push(RUNTIME_COHERENCE_DIMENSION_IDS.runtimeReadiness);
    repairTargetIds.push(RUNTIME_COHERENCE_REPAIR_TARGET_IDS.readinessRepair);
    pressures.push(readinessPressure);
  }
  const discoursePressure = discourseObjectPressure(input.discourseObject);
  if (discoursePressure > 0.5) {
    failedDimensionIds.push(RUNTIME_COHERENCE_DIMENSION_IDS.discourseObject);
    repairTargetIds.push(RUNTIME_COHERENCE_REPAIR_TARGET_IDS.evidenceActivation);
    pressures.push(discoursePressure);
  }
  const instabilityMass = clamp01(pressures.length ? mean(pressures) + Math.max(...pressures) * 0.35 : 0);
  const coherenceMass = clamp01(1 - instabilityMass);
  const emitAllowed = !failedDimensionIds.includes(RUNTIME_COHERENCE_DIMENSION_IDS.mouthSurface) && readinessPressure < 0.82;
  const demotionRequired =
    !emitAllowed ||
    failedDimensionIds.some(id => id !== RUNTIME_COHERENCE_DIMENSION_IDS.discourseObject && id !== RUNTIME_COHERENCE_DIMENSION_IDS.mouthSurface);
  const assistantForceAfter = applyRuntimeCoherenceToAssistantForce({
    current: input.assistantForce,
    emitAllowed,
    demotionRequired,
    failedDimensionIds
  });
  const influenceIds = assistantForceAfter !== input.assistantForce
    ? ["coh.influence.aa13f0c7"]
    : failedDimensionIds.length
      ? ["coh.influence.6d93b27e"]
      : [];
  return {
    schema: "scce.runtime_coherence_decision.v1",
    coherenceMass,
    instabilityMass,
    repairRequired: !emitAllowed || mouthPressure > 0.01,
    emitAllowed,
    demotionRequired,
    failedDimensionIds: unique(failedDimensionIds),
    repairTargetIds: unique(repairTargetIds),
    assistantForceBefore: input.assistantForce,
    assistantForceAfter,
    influenceIds,
    audit: toJsonValue({
      evidenceCluster,
      genericContaminationPressure: generic,
      proofPressure,
      counterfactualPressure,
      mouthPressure,
      languagePriorPressure,
      readinessPressure,
      discoursePressure,
      discourseObject: input.discourseObject ?? null,
      assistantForceBefore: input.assistantForce,
      assistantForceAfter,
      selectedCandidateAudit: input.selectedCandidateAudit ?? null
    })
  };
}

export function applyRuntimeCoherenceToAssistantForce(input: {
  current: AssistantForceClass;
  emitAllowed: boolean;
  demotionRequired: boolean;
  failedDimensionIds: readonly string[];
}): AssistantForceClass {
  if (!input.emitAllowed) return "insufficient_support";
  if (!input.demotionRequired) return input.current;
  if (input.current === "learned_corpus_answer") return "insufficient_support";
  if (input.failedDimensionIds.includes(RUNTIME_COHERENCE_DIMENSION_IDS.languagePriorLeakage)) return "insufficient_support";
  if (input.current === "certified_fact" || input.current === "source_grounded_answer") return "reasoned_answer";
  return input.current;
}

function evidenceClusterCoherence(evidence: readonly EvidenceSpan[]): { clusters: number; topShare: number; pressure: number } {
  if (evidence.length <= 2) return { clusters: evidence.length, topShare: 1, pressure: 0 };
  const counts = new Map<string, number>();
  for (const span of evidence) {
    const key = String(span.sourceVersionId || titleFromEvidence(span) || span.id);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = Math.max(...counts.values());
  const topShare = top / Math.max(1, evidence.length);
  return { clusters: counts.size, topShare, pressure: clamp01((counts.size - 2) / 4 + (1 - topShare) * 0.55) };
}

function genericContaminationPressure(requestText: string, evidence: readonly EvidenceSpan[]): number {
  if (evidence.length < 2) return 0;
  const requestTokens = tokenSet(requestText);
  const genericHits = evidence.filter(span => {
    const title = titleFromEvidence(span);
    if (!title) return false;
    const tokens = tokenSet(title);
    const overlap = [...tokens].filter(token => requestTokens.has(token)).length;
    return tokens.size <= 1 && overlap === 0;
  }).length;
  return clamp01(genericHits / Math.max(1, evidence.length));
}

function proofPressureFrom(entailment: SemanticEntailmentResult): number {
  const contradiction = clamp01(entailment.contradiction ?? 0);
  const support = clamp01(entailment.support ?? 0);
  return clamp01(contradiction * 0.7 + (1 - support) * 0.22);
}

function counterfactualInstability(counterfactual: CounterfactualWorld | undefined): number {
  if (!counterfactual) return 0;
  const failedConstraintPressure = counterfactual.constraints
    .filter(item => item.id === "bounded-unit-interval" || item.id === "effect-path-support")
    .filter(item => !item.passed)
    .reduce((max, item) => Math.max(max, clamp01(item.pressure)), 0);
  const unsupportedEffects = counterfactual.effect
    .filter(item => Math.abs(item.effect) > 0.08 && item.pathSupport < 0.08)
    .map(item => Math.abs(item.effect));
  return clamp01(Math.max(failedConstraintPressure, unsupportedEffects.length ? mean(unsupportedEffects) : 0));
}

function mouthLeakagePressure(answerText: string, mouthAudit: JsonValue | undefined): number {
  const text = answerText.normalize("NFKC");
  const debris = /(\[\[|\]\]|\|alt=|\|thumb|={2,}|File:|Image:|\(;)/u.test(text) ? 1 : 0;
  return clamp01(debris + (mouthAudit === undefined ? 0 : 0));
}

function languagePriorLeakage(force: AssistantForceClass, evidence: readonly EvidenceSpan[]): number {
  if (force !== "learned_corpus_answer" && force !== "certified_fact" && force !== "source_grounded_answer") return 0;
  if (!evidence.length) return force === "learned_corpus_answer" ? 0.9 : 0.65;
  const factualEvidence = evidence.filter(span => {
    const provenance = jsonRecord(span.provenance);
    const trust = jsonRecord(span.trustVector);
    const forceClass = String(provenance.forceClass ?? trust.forceClass ?? "");
    return forceClass !== "learned_language_prior" && forceClass !== "learned_program_prior" && forceClass !== "learned_concept_prior";
  }).length;
  return factualEvidence ? 0 : 0.8;
}

function runtimeReadinessPressure(readiness: RuntimeReadiness | undefined): number {
  if (!readiness) return 0;
  return clamp01((readiness.ready ? 0 : 0.65) + readiness.missing.length * 0.12 + readiness.risk * 0.35);
}

function discourseObjectPressure(value: JsonValue | undefined): number {
  const record = jsonRecord(value);
  if (!Object.keys(record).length) return 0;
  const confidence = numeric(record.bindingConfidence);
  const evidenceIds = Array.isArray(record.evidenceIds) ? record.evidenceIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const signals = Array.isArray(record.signalIds) ? record.signalIds.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
  const queryConcatenationUsed = record.queryConcatenationUsed === true;
  const missingEvidence = confidence >= 0.45 && evidenceIds.length === 0 ? 0.8 : 0;
  const malformedSignals = signals.some(signal => !/^disc\.signal\.[0-9a-f]{8}$/u.test(signal)) ? 0.65 : 0;
  return clamp01(Math.max(queryConcatenationUsed ? 0.7 : 0, missingEvidence, malformedSignals));
}

function titleFromEvidence(span: EvidenceSpan): string {
  const provenance = jsonRecord(span.provenance);
  return typeof provenance.title === "string" ? provenance.title : "";
}

function tokenSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const token of (text.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(token => token.length > 1)) {
    out.add(token);
    if (token.endsWith("s") && token.length > 3) out.add(token.slice(0, -1));
  }
  return out;
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function numeric(value: JsonValue | undefined): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}
