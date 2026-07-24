import type { EpistemicForce, JsonValue, PolicyProfile, RequestedAuthority, ValidationGraph } from "./types.js";
import type { CandidateField, CandidateSurface } from "./candidate.js";
import { clamp01, mean, toJsonValue } from "./primitives.js";
import type { TurnRequirementField } from "./turn-requirements.js";
import {
  functionalCandidateGateFailures,
  type FunctionalSelectionGate
} from "./functional-cognition.js";

export interface JudgeDecision {
  selected: CandidateSurface;
  rejected: Array<{ candidate: CandidateSurface; score: number; reasons: string[] }>;
  scores: Array<{ candidateId: string; score: number; reasons: string[] }>;
  audit: JsonValue;
}

export interface JudgeOptions {
  /** Unit-interval entropy source. Inject a deterministic sequence in tests. */
  random?: () => number;
}

export function createJudge(options: JudgeOptions = {}) {
  const random = options.random ?? Math.random;
  return {
    select(input: {
      field: CandidateField;
      policy: PolicyProfile;
      validation?: ValidationGraph;
      requestedAuthority?: RequestedAuthority;
      requirementField?: TurnRequirementField;
      deterministicReplay?: boolean;
      functionalGate?: FunctionalSelectionGate;
    }): JudgeDecision {
      if (!input.field.candidates.length) throw new Error("judge received no candidates");
      if (input.requirementField) return selectForRequirementField({ ...input, requirementField: input.requirementField, random });
      const massByCandidate = new Map(input.field.surfaceMass.map(item => [item.candidateId, item.mass]));
      const scored = input.field.candidates.map(candidate => {
        const functionalFailures = functionalCandidateGateFailures(candidate.kind, input.functionalGate);
        const reasons: string[] = functionalFailures.map(failure => `hard-failure:${failure}`);
        const score = functionalFailures.length
          ? -1_000_000 - functionalFailures.length
          : scoreCandidate(candidate, input.policy, reasons, input.validation, massByCandidate.get(candidate.id), input.requestedAuthority);
        return { candidate, score, reasons, functionalFailures };
      }).sort((a, b) => b.score - a.score || a.candidate.id.localeCompare(b.candidate.id));
      const selected = scored.find(row => row.functionalFailures.length === 0);
      if (!selected) throw new Error("judge received no functionally admissible candidates");
      return {
        selected: selected.candidate,
        rejected: scored.filter(row => row !== selected),
        scores: scored.map(item => ({ candidateId: item.candidate.id, score: item.score, reasons: item.reasons })),
        audit: toJsonValue({
          requestedAuthority: input.requestedAuthority ?? null,
          selected: selected.candidate.id,
          functionalGate: input.functionalGate ?? null,
          scores: scored.map(item => ({ id: item.candidate.id, kind: item.candidate.kind, score: item.score, reasons: item.reasons }))
        })
      };
    }
  };
}

const POSITIVE_QUALITY_KEYS = [
  "truthSupport",
  "sourceFidelity",
  "requirementCoverage",
  "novelty",
  "semanticPreservation",
  "transformationQuality",
  "inferentialContinuity",
  "explanatoryPower",
  "executableCompleteness",
  "dialogueContinuity",
  "languageQuality",
  "usefulness",
  "coherence",
  "uncertaintyCalibration",
  "formatFit",
  "styleFit",
  "directness",
  "structure"
] as const;

const NEGATIVE_QUALITY_KEYS = [
  "repetition",
  "contradiction",
  "unsupportedFactRate",
  "fakeFactualAuthority",
  "staleSourceRisk",
  "testWeakening",
  "telemetryLeak"
] as const;

type PositiveQualityKey = typeof POSITIVE_QUALITY_KEYS[number];
type NegativeQualityKey = typeof NEGATIVE_QUALITY_KEYS[number];

function selectForRequirementField(input: {
  field: CandidateField;
  policy: PolicyProfile;
  validation?: ValidationGraph;
  requestedAuthority?: RequestedAuthority;
  requirementField: TurnRequirementField;
  deterministicReplay?: boolean;
  functionalGate?: FunctionalSelectionGate;
  random: () => number;
}): JudgeDecision {
  const weights = requirementPositiveWeights(input.requirementField);
  const penalties = requirementPenaltyWeights(input.requirementField);
  const temperature = requirementTemperature(input.requirementField);
  const rows = input.field.candidates.map(candidate => {
    const quality = normalizedQuality(candidate);
    const hardFailures = [
      ...candidateHardFailures(candidate, quality, input.requirementField, input.validation),
      ...functionalCandidateGateFailures(candidate.kind, input.functionalGate)
    ];
    const positive = POSITIVE_QUALITY_KEYS.reduce((sum, key) => sum + weights[key] * quality[key], 0);
    const negative = NEGATIVE_QUALITY_KEYS.reduce((sum, key) => sum + penalties[key] * quality[key], 0);
    const rawScore = Number.isFinite(positive - negative) ? positive - negative : -1;
    const score = hardFailures.length ? -1_000_000 - hardFailures.length : rawScore;
    const reasons = [
      `requirement-quality=${rawScore.toFixed(6)}`,
      `coverage=${quality.requirementCoverage.toFixed(3)}`,
      `truth=${quality.truthSupport.toFixed(3)}`,
      `novelty=${quality.novelty.toFixed(3)}`,
      ...hardFailures.map(failure => `hard-failure:${failure}`)
    ];
    return { candidate, quality, positive, negative, rawScore, score, hardFailures, reasons };
  });
  const admissible = rows.filter(row => row.hardFailures.length === 0);
  if (!admissible.length) throw new Error("judge received no admissible candidates");
  const finiteScores = admissible.map(row => Math.max(-64, Math.min(64, row.rawScore)));
  const probabilities = boltzmannProbabilities(finiteScores, temperature);
  let probabilityIndex = 0;
  const probabilityRows = rows.map(row => ({
    ...row,
    probability: row.hardFailures.length === 0 ? probabilities[probabilityIndex++] ?? 0 : 0
  }));
  const ranked = probabilityRows
    .sort((left, right) => right.score - left.score || right.probability - left.probability || left.candidate.id.localeCompare(right.candidate.id));
  const sampled = input.deterministicReplay === true
    ? { row: ranked[0]!, draw: null }
    : sampleBoltzmann(probabilityRows.filter(row => row.hardFailures.length === 0), input.random);
  const selected = sampled.row;
  return {
    selected: selected.candidate,
    rejected: ranked.filter(row => row !== selected).map(row => ({ candidate: row.candidate, score: row.score, reasons: row.reasons })),
    scores: ranked.map(row => ({ candidateId: row.candidate.id, score: row.score, reasons: row.reasons })),
    audit: toJsonValue({
      schema: "scce.requirement_aware_judge.v1",
      coefficientModel: "judge.requirement.bootstrap.2026-07-12.v1",
      equation: "Q(a|r)=softmax(Wr+b)^T q_positive(a)-rho(r)^T q_negative(a)",
      selection: input.deterministicReplay === true ? "deterministic_max" : "boltzmann_sample",
      randomDraw: sampled.draw,
      selected: selected.candidate.id,
      requestedAuthority: input.requestedAuthority ?? null,
      functionalGate: input.functionalGate ?? null,
      temperature,
      temperatureBounds: [0.08, 0.45],
      positiveWeights: weights,
      penaltyWeights: penalties,
      rows: ranked.map(row => ({
        candidateId: row.candidate.id,
        kind: row.candidate.kind,
        quality: row.quality,
        positive: row.positive,
        negative: row.negative,
        score: row.score,
        rawScore: row.rawScore,
        boltzmannProbability: row.probability,
        hardFailures: row.hardFailures
      }))
    })
  };
}

function requirementPositiveWeights(requirement: TurnRequirementField): Record<PositiveQualityKey, number> {
  const averageRequirement = mean([
    requirement.externalTruthAuthority,
    requirement.sourceDependence,
    requirement.noveltyDemand,
    requirement.inferentialDepth,
    requirement.semanticPreservation,
    requirement.executableArtifactDemand,
    requirement.dialogueDependence,
    requirement.formatConstraintStrength
  ]);
  const logits: Record<PositiveQualityKey, number> = {
    truthSupport: 0.10 + 2.20 * requirement.externalTruthAuthority,
    sourceFidelity: 0.05 + 1.45 * requirement.sourceDependence + 0.75 * requirement.externalTruthAuthority,
    requirementCoverage: 0.25 + 1.45 * averageRequirement,
    novelty: 0.05 + 2.15 * requirement.noveltyDemand,
    semanticPreservation: 0.05 + 2.10 * requirement.semanticPreservation,
    transformationQuality: 0.05 + 1.45 * requirement.surfaceTransformation + 0.55 * requirement.semanticPreservation,
    inferentialContinuity: 0.10 + 1.95 * requirement.inferentialDepth,
    explanatoryPower: 0.05 + 1.35 * requirement.inferentialDepth + 0.35 * requirement.causalReasoningDemand,
    executableCompleteness: 0.05 + 2.20 * requirement.executableArtifactDemand + 0.45 * requirement.actionCommitment,
    dialogueContinuity: 0.05 + 2.10 * requirement.dialogueDependence,
    languageQuality: 0.30 + 0.55 * requirement.audienceAdaptation,
    usefulness: 0.25 + 0.60 * requirement.noveltyDemand + 0.70 * requirement.executableArtifactDemand,
    coherence: 0.50 + 0.65 * requirement.inferentialDepth,
    uncertaintyCalibration: 0.10 + 1.40 * requirement.externalTruthAuthority + 0.35 * requirement.uncertaintyTolerance,
    formatFit: 0.05 + 2.00 * requirement.formatConstraintStrength,
    styleFit: 0.10 + 1.20 * requirement.audienceAdaptation,
    directness: 0.20 + 0.75 * (1 - requirement.brevityDetailBalance),
    structure: 0.20 + 0.80 * requirement.formatConstraintStrength + 0.55 * requirement.executableArtifactDemand
  };
  const maxLogit = Math.max(...Object.values(logits));
  const exponentials = Object.fromEntries(POSITIVE_QUALITY_KEYS.map(key => [key, Math.exp(Math.max(-40, Math.min(40, logits[key] - maxLogit)))])) as Record<PositiveQualityKey, number>;
  const total = Object.values(exponentials).reduce((sum, value) => sum + value, 0);
  return Object.fromEntries(POSITIVE_QUALITY_KEYS.map(key => [key, total > 0 ? exponentials[key] / total : 1 / POSITIVE_QUALITY_KEYS.length])) as Record<PositiveQualityKey, number>;
}

function requirementPenaltyWeights(requirement: TurnRequirementField): Record<NegativeQualityKey, number> {
  return {
    repetition: clamp01(0.16 + 0.18 * requirement.noveltyDemand),
    contradiction: clamp01(0.28 + 0.54 * requirement.externalTruthAuthority + 0.16 * requirement.inferentialDepth),
    unsupportedFactRate: clamp01(0.36 + 0.62 * requirement.externalTruthAuthority + 0.22 * requirement.sourceDependence),
    fakeFactualAuthority: 1,
    staleSourceRisk: clamp01(0.30 + 0.35 * requirement.sourceDependence + 0.25 * requirement.executableArtifactDemand),
    testWeakening: 1,
    telemetryLeak: 0.84
  };
}

function requirementTemperature(requirement: TurnRequirementField): number {
  return Math.max(0.08, Math.min(0.45,
    0.23
    + 0.14 * requirement.noveltyDemand
    + 0.08 * requirement.uncertaintyTolerance
    - 0.11 * requirement.externalTruthAuthority
    - 0.12 * requirement.actionCommitment
    - 0.06 * requirement.executableArtifactDemand
  ));
}

function normalizedQuality(candidate: CandidateSurface): Record<PositiveQualityKey | NegativeQualityKey, number> {
  const structuredTelemetry = looksLikeStructuredTelemetry(candidate.answer) ? 1 : 0;
  const q = candidate.quality;
  const sourceFidelity = q?.sourceFidelity ?? candidate.scores.faithfulness;
  const unsupportedFactRate = q?.unsupportedFactRate ?? candidate.scores.unsupportedFactualAssertion ?? 0;
  const result: Record<PositiveQualityKey | NegativeQualityKey, number> = {
    truthSupport: q?.truthSupport ?? candidate.scores.support,
    sourceFidelity,
    requirementCoverage: q?.requirementCoverage ?? candidate.scores.constraintCoverage ?? 0.5,
    novelty: q?.novelty ?? candidate.scores.novelty,
    semanticPreservation: q?.semanticPreservation ?? sourceFidelity,
    transformationQuality: q?.transformationQuality ?? candidate.scores.realizability,
    inferentialContinuity: q?.inferentialContinuity ?? candidate.scores.graphCoherence ?? candidate.scores.faithfulness,
    explanatoryPower: q?.explanatoryPower ?? candidate.scores.actionability,
    executableCompleteness: q?.executableCompleteness ?? candidate.scores.actionability,
    dialogueContinuity: q?.dialogueContinuity ?? 0.5,
    languageQuality: q?.languageQuality ?? candidate.scores.languageRealizability ?? candidate.scores.realizability,
    usefulness: q?.usefulness ?? candidate.scores.usefulness ?? candidate.scores.actionability,
    coherence: q?.coherence ?? candidate.scores.graphCoherence ?? candidate.scores.faithfulness,
    uncertaintyCalibration: q?.uncertaintyCalibration ?? clamp01(1 - (candidate.scores.unsupportedFactualAssertion ?? 0)),
    formatFit: q?.formatFit ?? candidate.scores.realizability,
    styleFit: q?.styleFit ?? candidate.scores.realizability,
    directness: q?.directness ?? candidate.scores.realizability,
    structure: q?.structure ?? candidate.scores.realizability,
    repetition: q?.repetition ?? candidate.scores.repetition ?? 0,
    contradiction: q?.contradiction ?? candidate.scores.contradiction,
    unsupportedFactRate: candidateHasExternallyFactualClaim(candidate) ? unsupportedFactRate : 0,
    fakeFactualAuthority: q?.fakeFactualAuthority ?? 0,
    staleSourceRisk: q?.staleSourceRisk ?? 0,
    testWeakening: q?.testWeakening ?? 0,
    telemetryLeak: Math.max(q?.telemetryLeak ?? 0, structuredTelemetry)
  };
  for (const key of [...POSITIVE_QUALITY_KEYS, ...NEGATIVE_QUALITY_KEYS]) result[key] = clamp01(Number.isFinite(result[key]) ? result[key] : 0);
  return result;
}

function candidateHardFailures(
  candidate: CandidateSurface,
  quality: Record<PositiveQualityKey | NegativeQualityKey, number>,
  requirement: TurnRequirementField,
  validation?: ValidationGraph
): string[] {
  const failures: string[] = [];
  if (quality.fakeFactualAuthority > 0) failures.push("fake_factual_authority");
  if (quality.testWeakening > 0) failures.push("test_weakening");
  if (quality.telemetryLeak > 0) failures.push("telemetry_leak");
  if (
    requirement.externalTruthAuthority >= 0.7
    && quality.unsupportedFactRate > 0
    && candidateHasExternallyFactualClaim(candidate)
  ) failures.push("unsupported_externally_factual_claim");
  if (candidate.claimBases?.includes("action_result") && !candidateHasActionReceipt(candidate)) failures.push("action_result_without_receipt");
  if (requirement.actionCommitment >= 0.6 && candidate.kind === "action-preview" && candidate.claimBases?.includes("action_result")) failures.push("false_action_completion");
  if (
    requirement.executableArtifactDemand >= 0.65
    && executableCandidateFamily(candidate)
    && validation
    && !validation.passed
  ) failures.push("executable_validation_failed");
  return [...new Set(failures)];
}

function executableCandidateFamily(candidate: CandidateSurface): boolean {
  return candidate.kind === "program-proposal"
    || candidate.kind === "workspace-proposal"
    || candidate.kind === "action-preview";
}

function candidateHasExternallyFactualClaim(candidate: CandidateSurface): boolean {
  const audit = candidate.audit && typeof candidate.audit === "object" && !Array.isArray(candidate.audit)
    ? candidate.audit as Record<string, JsonValue>
    : {};
  if (Array.isArray(audit.claimBases)) {
    const explicit = audit.claimBases.flatMap(item => {
      if (!item || typeof item !== "object" || Array.isArray(item)) return [];
      const externallyFactual = (item as Record<string, JsonValue>).externallyFactual;
      return typeof externallyFactual === "boolean" ? [externallyFactual] : [];
    });
    if (explicit.some(Boolean)) return true;
    if (explicit.length > 0) return false;
  }
  const factualBases = new Set([
    "direct_evidence",
    "source_synthesis",
    "reasoned_inference",
    "causal_inference",
    "temporal_inference",
    "translated",
    "action_result",
    "unsupported"
  ]);
  if ((candidate.claimBases ?? []).some(basis => factualBases.has(basis))) return true;
  if ((candidate.claimBases?.length ?? 0) > 0) return false;
  return new Set<CandidateSurface["kind"]>([
    "proof-answer",
    "ccr-extractive",
    "graph-inference",
    "reasoned-synthesis",
    "causal-inference",
    "temporal-inference",
    "translation"
  ]).has(candidate.kind);
}

function candidateHasActionReceipt(candidate: CandidateSurface): boolean {
  const audit = candidate.audit && typeof candidate.audit === "object" && !Array.isArray(candidate.audit)
    ? candidate.audit as Record<string, JsonValue>
    : {};
  if (typeof audit.actionReceiptId === "string" && audit.actionReceiptId.length > 0) return true;
  const bases = Array.isArray(audit.claimBases) ? audit.claimBases : [];
  return bases.some(item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return false;
    const receipt = (item as Record<string, JsonValue>).actionReceiptId;
    return typeof receipt === "string" && receipt.length > 0;
  });
}

function boltzmannProbabilities(scores: readonly number[], temperature: number): number[] {
  if (!scores.length) return [];
  const boundedTemperature = Math.max(0.08, Math.min(0.45, temperature));
  const max = Math.max(...scores);
  const values = scores.map(score => Math.exp(Math.max(-40, Math.min(40, (score - max) / boundedTemperature))));
  const total = values.reduce((sum, value) => sum + value, 0);
  return values.map(value => total > 0 ? value / total : 1 / values.length);
}

function sampleBoltzmann<T extends { probability: number }>(
  rows: readonly T[],
  random: () => number
): { row: T; draw: number } {
  if (!rows.length) throw new Error("cannot sample an empty Boltzmann distribution");
  const draw = random();
  if (!Number.isFinite(draw) || draw < 0 || draw >= 1) {
    throw new Error("judge random source must return a finite value in [0, 1)");
  }
  let cumulative = 0;
  for (const row of rows) {
    cumulative += row.probability;
    if (draw < cumulative) return { row, draw };
  }
  return { row: rows[rows.length - 1]!, draw };
}

function scoreCandidate(candidate: CandidateSurface, policy: PolicyProfile, reasons: string[], validation?: ValidationGraph, surfaceMass?: number, requestedAuthority?: RequestedAuthority): number {
  if (requestedAuthority === "creative") return scoreCreativeCandidate(candidate, reasons, validation, surfaceMass);
  const s = candidate.scores;
  const epistemic = forceScore(candidate.force);
  const proof = clamp01(0.35 * epistemic + 0.28 * s.support + 0.22 * s.faithfulness + 0.15 * s.evidenceCoverage);
  const field = clamp01(0.38 * s.alphaPressure + 0.25 * s.actionability + 0.2 * s.realizability + 0.17 * s.novelty);
  const mass = clamp01(surfaceMass ?? 0);
  const risk = clamp01(0.6 * s.contradiction + 0.25 * (candidate.boundaries.length ? 0.35 : 0) + 0.15 * Math.max(0, policy.alphaRiskCeiling < 0.5 ? 0.2 : 0));
  const validationScore = validation ? mean(validation.checks.map(check => check.score)) * (validation.passed ? 1 : 0.55) : 0.7;
  if (candidate.force === "proved" || candidate.force === "observed") reasons.push("high-epistemic-force");
  if (candidate.kind === "ccr-extractive") reasons.push("extractive-grounding");
  if (candidate.kind === "creative-candidate") reasons.push("creative-output-boundary");
  if (looksLikeStructuredTelemetry(candidate.answer)) reasons.push("structured-telemetry-not-surface");
  if (candidate.boundaries.length) reasons.push(`boundaries=${candidate.boundaries.length}`);
  if (s.contradiction > 0.25) reasons.push("contradiction-penalty");
  if (validation && !validation.passed) reasons.push("validation-not-passed");
  if (mass > 0) reasons.push(`candidate-mass=${mass.toFixed(3)}`);
  const telemetryPenalty = looksLikeStructuredTelemetry(candidate.answer) ? 0.72 : 0;
  return clamp01(0.32 * proof + 0.24 * field + 0.2 * validationScore + 0.12 * s.realizability + 0.12 * mass - 0.42 * risk - telemetryPenalty);
}

function scoreCreativeCandidate(candidate: CandidateSurface, reasons: string[], validation?: ValidationGraph, surfaceMass?: number): number {
  const s = candidate.scores;
  const mass = clamp01(surfaceMass ?? 0);
  const validationScore = validation ? mean(validation.checks.map(check => check.score)) * (validation.passed ? 1 : 0.55) : 0.7;
  const telemetryPenalty = looksLikeStructuredTelemetry(candidate.answer) ? 0.72 : 0;
  if (candidate.kind !== "creative-candidate" || candidate.force !== "invented") {
    reasons.push("requested-authority-mismatch");
    if (telemetryPenalty > 0) reasons.push("structured-telemetry-not-surface");
    return clamp01(0.12 * mass + 0.08 * s.actionability + 0.08 * s.realizability - telemetryPenalty);
  }
  const constraintCoverage = clamp01(s.constraintCoverage ?? 0);
  const coherence = clamp01(s.graphCoherence ?? s.faithfulness);
  const novelty = clamp01(s.novelty);
  const language = clamp01(s.languageRealizability ?? s.realizability);
  const usefulness = clamp01(s.usefulness ?? s.actionability);
  const risk = clamp01(s.risk ?? s.contradiction);
  const repetition = clamp01(s.repetition ?? 0);
  const fakeFact = clamp01(s.unsupportedFactualAssertion ?? 0);
  const selectionScore = typeof s.creativeSelectionScore === "number" && Number.isFinite(s.creativeSelectionScore)
    ? s.creativeSelectionScore
    : 0.28 * constraintCoverage + 0.22 * coherence + 0.20 * novelty + 0.15 * language + 0.15 * usefulness - 0.30 * risk - 0.20 * repetition - 0.50 * fakeFact;
  const normalizedSelection = clamp01((selectionScore + 1) / 2);
  reasons.push("creative-authority-fit", `constraint-coverage=${constraintCoverage.toFixed(3)}`, `coherence=${coherence.toFixed(3)}`, `novelty=${novelty.toFixed(3)}`, `language=${language.toFixed(3)}`, `usefulness=${usefulness.toFixed(3)}`);
  if (risk > 0.25) reasons.push("creative-risk-penalty");
  if (repetition > 0.25) reasons.push("creative-repetition-penalty");
  if (fakeFact > 0) reasons.push("fake-factual-authority-penalty");
  if (constraintCoverage < 0.5) reasons.push("request-constraint-gap");
  if (validation && !validation.passed) reasons.push("validation-not-passed");
  if (mass > 0) reasons.push(`candidate-mass=${mass.toFixed(3)}`);
  if (telemetryPenalty > 0) reasons.push("structured-telemetry-not-surface");
  return clamp01(0.72 * normalizedSelection + 0.16 * mass + 0.12 * validationScore - telemetryPenalty);
}

function looksLikeStructuredTelemetry(answer: string): boolean {
  const trimmed = answer.trim();
  return trimmed.startsWith("{") && (
    trimmed.includes("\"schema\"") ||
    trimmed.includes("scce.surface.candidate.v1") ||
    trimmed.includes("candidateKind") ||
    trimmed.includes("proofId") ||
    trimmed.includes("\"activeFeatures\"") ||
    trimmed.includes("\"alphaSurfaces\"")
  );
}

function forceScore(force: EpistemicForce): number {
  if (force === "proved") return 1;
  if (force === "observed") return 0.86;
  if (force === "inferred") return 0.65;
  if (force === "conjectured") return 0.46;
  if (force === "invented") return 0.32;
  return 0.12;
}
