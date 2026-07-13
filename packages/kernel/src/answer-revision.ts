import type { CandidateSurface } from "./candidate.js";
import type { ClaimBasis, CognitiveProposal, PlannedClaim } from "./cognitive-planner.js";
import type { DialogueState } from "./dialogue-pragmatics.js";
import type { SpokenOutput } from "./mouth.js";
import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";
import type { TurnRequirementField } from "./turn-requirements.js";
import type { EvidenceId, EvidenceSpan, JsonValue, ValidationGraph } from "./types.js";

export type RevisionRequirementField = TurnRequirementField;

export type RevisionProposal = CognitiveProposal;
export type RevisionClaimBasisKind = ClaimBasis;

export type RevisionClaimBasis = Pick<PlannedClaim, "basis" | "evidenceIds" | "trace"> & {
  claimId: PlannedClaim["id"];
};

export type RevisionDefectKind =
  | "missing_required_feature"
  | "prohibited_feature_present"
  | "incorrect_output_form"
  | "unsupported_factual_claim"
  | "citation_mismatch"
  | "reasoning_gap"
  | "contradiction"
  | "semantic_meaning_loss"
  | "translation_omission"
  | "insufficient_novelty"
  | "repetition"
  | "poor_structure"
  | "unclear_referent"
  | "tone_mismatch"
  | "unnecessary_hedging"
  | "excessive_evidence_language"
  | "stale_workspace_source"
  | "test_weakening"
  | "action_without_receipt"
  | "telemetry_leak";

export type RevisionDefectSeverity = "warning" | "error" | "hard_failure";

export interface RevisionSpan {
  text: string;
  charStart: number;
  charEnd: number;
  byteStart: number;
  byteEnd: number;
}

export type RevisionAffectedTarget =
  | { kind: "claim"; claimId: string }
  | { kind: "span"; span: RevisionSpan }
  | { kind: "claim_span"; claimId: string; span: RevisionSpan };

export interface RevisionRequirementReference {
  id: string;
  source: "field" | "validation" | "invariant";
  kind: "required" | "prohibited" | "invariant";
  confidence: number;
  trace: JsonValue;
}

export type RevisionCorrectionOperation =
  | "satisfy_requirement"
  | "remove_prohibited_feature"
  | "repair_output_form"
  | "ground_or_qualify_claim"
  | "repair_citation_binding"
  | "close_reasoning_gap"
  | "resolve_contradiction"
  | "restore_meaning"
  | "restore_translation_content"
  | "increase_meaning_novelty"
  | "remove_repetition"
  | "improve_structure"
  | "resolve_referent"
  | "align_tone"
  | "remove_unnecessary_hedging"
  | "reduce_evidence_language"
  | "refresh_workspace_basis"
  | "restore_test_strength"
  | "require_action_receipt"
  | "remove_telemetry";

export interface RevisionCorrectionRequest {
  operation: RevisionCorrectionOperation;
  targetIds: string[];
  preserveClaimIds: string[];
  trace: JsonValue;
}

export interface RevisionDefect {
  schema: "scce.answer_revision.defect.v1";
  id: string;
  kind: RevisionDefectKind;
  severity: RevisionDefectSeverity;
  severityScore: number;
  affected: RevisionAffectedTarget;
  violatedRequirement: RevisionRequirementReference;
  supportingTrace: JsonValue;
  requestedCorrection: RevisionCorrectionRequest;
  confidence: number;
}

export interface RevisionRequirementCheck {
  requirementId: string;
  satisfied: boolean;
  affectedClaimId?: string;
  affectedSpan?: RevisionSpan;
  confidence: number;
  trace: JsonValue;
}

export interface RevisionCitationCheck {
  claimId?: string;
  evidenceId?: EvidenceId;
  matched: boolean;
  affectedSpan?: RevisionSpan;
  confidence: number;
  trace: JsonValue;
}

/**
 * Validators report observations; the critic only converts those observations
 * into bounded correction constraints. The issue never contains replacement
 * prose.
 */
export interface RevisionValidationIssue {
  kind: RevisionDefectKind;
  severity: RevisionDefectSeverity;
  affectedClaimId?: string;
  affectedSpan?: RevisionSpan;
  requirementId?: string;
  correction: RevisionCorrectionOperation;
  confidence: number;
  trace: JsonValue;
}

export interface RevisionHardFailure {
  id: string;
  kind: string;
  trace: JsonValue;
}

export interface RevisionValidationResults {
  validationGraph?: ValidationGraph;
  requirementChecks: readonly RevisionRequirementCheck[];
  citationChecks: readonly RevisionCitationCheck[];
  issues: readonly RevisionValidationIssue[];
  hardFailures: readonly RevisionHardFailure[];
  trace: JsonValue;
}

export type RevisionMouthOutput = Pick<SpokenOutput, "text" | "evidenceRefs">;

export interface AnswerCriticInput {
  requirementField: RevisionRequirementField;
  selectedProposal: RevisionProposal;
  selectedCandidate: CandidateSurface;
  mouthOutput: RevisionMouthOutput;
  claimBases: readonly RevisionClaimBasis[];
  evidence: readonly EvidenceSpan[];
  dialogueState?: DialogueState;
  validationResults: RevisionValidationResults;
}

export interface AnswerCriticResult {
  schema: "scce.answer_revision.critic.v1";
  defects: RevisionDefect[];
  hardFailureCount: number;
  trace: JsonValue;
}

export interface AnswerCritic {
  review(input: AnswerCriticInput): AnswerCriticResult;
}

export interface RevisionQualityAssessment {
  score: number;
  hardFailures: readonly RevisionHardFailure[];
  trace: JsonValue;
}

export interface RevisionAnswerVersion {
  id: string;
  selectedProposal: RevisionProposal;
  selectedCandidate: CandidateSurface;
  mouthOutput: RevisionMouthOutput;
  claimBases: readonly RevisionClaimBasis[];
  evidence: readonly EvidenceSpan[];
  dialogueState?: DialogueState;
  validationResults: RevisionValidationResults;
  quality: RevisionQualityAssessment;
}

export interface RevisionConstraint {
  defectId: string;
  defectKind: RevisionDefectKind;
  affected: RevisionAffectedTarget;
  violatedRequirement: RevisionRequirementReference;
  requestedCorrection: RevisionCorrectionRequest;
  confidence: number;
}

export interface RevisionPlan {
  id: string;
  round: 1 | 2;
  constraints: readonly RevisionConstraint[];
  trace: JsonValue;
}

export interface RevisionPlannerInput {
  round: 1 | 2;
  requirementField: RevisionRequirementField;
  current: RevisionAnswerVersion;
  defects: readonly RevisionDefect[];
  constraints: readonly RevisionConstraint[];
  priorAttempts: readonly RevisionAttempt[];
}

export interface RevisionMouthInput extends RevisionPlannerInput {
  plan: RevisionPlan;
}

export type RevisionSource =
  | {
      kind: "planner_mouth";
      planner(input: RevisionPlannerInput): Promise<RevisionPlan> | RevisionPlan;
      mouth(input: RevisionMouthInput): Promise<RevisionAnswerVersion> | RevisionAnswerVersion;
    }
  | {
      kind: "candidate_revisions";
      candidates: readonly RevisionAnswerVersion[];
    };

export interface RevisionAttempt {
  schema: "scce.answer_revision.attempt.v1";
  round: 1 | 2;
  baselineVersionId: string;
  proposedVersionId: string;
  planId?: string;
  defectsBefore: RevisionDefect[];
  defectsAfter: RevisionDefect[];
  qualityBefore: number;
  qualityAfter: number;
  qualityGain: number;
  requiredQualityGain: number;
  hardFailureCount: number;
  accepted: boolean;
  rejectionReasons: string[];
  trace: JsonValue;
}

export type RevisionDisposition =
  | "not_needed"
  | "resolved"
  | "exhausted_valid"
  | "exhausted_no_valid_result";

export interface AnswerRevisionResult {
  schema: "scce.answer_revision.result.v1";
  disposition: RevisionDisposition;
  selected?: RevisionAnswerVersion;
  attempts: RevisionAttempt[];
  initialDefects: RevisionDefect[];
  finalDefects: RevisionDefect[];
  roundsUsed: number;
  trace: JsonValue;
}

export interface AnswerRevisionCoordinator {
  revise(input: {
    requirementField: RevisionRequirementField;
    baseline: RevisionAnswerVersion;
    source: RevisionSource;
  }): Promise<AnswerRevisionResult>;
}

export const ANSWER_REVISION_CONTRACT = {
  schema: "scce.answer_revision.contract.v1",
  maxRounds: 2,
  minimumQualityGain: 0.025
} as const;

const INVARIANT_REQUIREMENTS = {
  citationIntegrity: "revision.invariant.citation_integrity.v1",
  nonRepetition: "revision.invariant.non_repetition.v1",
  validQuality: "revision.invariant.finite_quality.v1"
} as const;

const HARD_DEFECT_KINDS = new Set<RevisionDefectKind>([
  "citation_mismatch",
  "test_weakening",
  "action_without_receipt",
  "telemetry_leak"
]);

const CORRECTION_BY_DEFECT: Record<RevisionDefectKind, RevisionCorrectionOperation> = {
  missing_required_feature: "satisfy_requirement",
  prohibited_feature_present: "remove_prohibited_feature",
  incorrect_output_form: "repair_output_form",
  unsupported_factual_claim: "ground_or_qualify_claim",
  citation_mismatch: "repair_citation_binding",
  reasoning_gap: "close_reasoning_gap",
  contradiction: "resolve_contradiction",
  semantic_meaning_loss: "restore_meaning",
  translation_omission: "restore_translation_content",
  insufficient_novelty: "increase_meaning_novelty",
  repetition: "remove_repetition",
  poor_structure: "improve_structure",
  unclear_referent: "resolve_referent",
  tone_mismatch: "align_tone",
  unnecessary_hedging: "remove_unnecessary_hedging",
  excessive_evidence_language: "reduce_evidence_language",
  stale_workspace_source: "refresh_workspace_basis",
  test_weakening: "restore_test_strength",
  action_without_receipt: "require_action_receipt",
  telemetry_leak: "remove_telemetry"
};

export function createAnswerCritic(): AnswerCritic {
  return {
    review(input) {
      const defects = deduplicateDefects([
        ...missingRequirementDefects(input),
        ...validationIssueDefects(input),
        ...citationDefects(input),
        ...repetitionDefects(input)
      ]).sort((left, right) =>
        severityRank(right.severity) - severityRank(left.severity) ||
        right.confidence - left.confidence ||
        left.id.localeCompare(right.id)
      );
      return {
        schema: "scce.answer_revision.critic.v1",
        defects,
        hardFailureCount: hardFailures(input, defects).length,
        trace: toJsonValue({
          contract: ANSWER_REVISION_CONTRACT.schema,
          proposalId: input.selectedProposal.id,
          candidateId: input.selectedCandidate.id,
          defectIds: defects.map(defect => defect.id),
          validationTrace: input.validationResults.trace,
          dialogueTurnId: input.dialogueState?.turnId ?? null
        })
      };
    }
  };
}

export function createAnswerRevisionCoordinator(options: { critic?: AnswerCritic } = {}): AnswerRevisionCoordinator {
  const critic = options.critic ?? createAnswerCritic();
  return {
    async revise(input) {
      const initialCritique = critic.review(criticInput(input.requirementField, input.baseline));
      const initialHardFailures = hardFailuresForVersion(input.baseline, initialCritique.defects);
      if (initialCritique.defects.length === 0 && initialHardFailures.length === 0) {
        return revisionResult("not_needed", input.baseline, [], initialCritique.defects, initialCritique.defects);
      }

      let current = input.baseline;
      let currentDefects = initialCritique.defects;
      let strongestValid = initialHardFailures.length === 0 ? input.baseline : undefined;
      const attempts: RevisionAttempt[] = [];

      for (let roundIndex = 0; roundIndex < ANSWER_REVISION_CONTRACT.maxRounds; roundIndex++) {
        const round = (roundIndex + 1) as 1 | 2;
        const proposed = await proposedRevision(input.source, {
          round,
          requirementField: input.requirementField,
          current,
          defects: currentDefects,
          constraints: revisionConstraints(currentDefects),
          priorAttempts: attempts
        });
        if (!proposed) break;

        const critique = critic.review(criticInput(input.requirementField, proposed.version));
        const proposedHardFailures = hardFailuresForVersion(proposed.version, critique.defects);
        const qualityBefore = normalizedQuality(current.quality.score);
        const qualityAfter = normalizedQuality(proposed.version.quality.score);
        const qualityGain = qualityAfter - qualityBefore;
        const finiteQuality = Number.isFinite(current.quality.score) && Number.isFinite(proposed.version.quality.score);
        const accepted = finiteQuality &&
          proposedHardFailures.length === 0 &&
          qualityGain + Number.EPSILON >= ANSWER_REVISION_CONTRACT.minimumQualityGain;
        const rejectionReasons = [
          ...(!finiteQuality ? [INVARIANT_REQUIREMENTS.validQuality] : []),
          ...(proposedHardFailures.length > 0 ? ["revision.reject.hard_failure.v1"] : []),
          ...(qualityGain + Number.EPSILON < ANSWER_REVISION_CONTRACT.minimumQualityGain ? ["revision.reject.insufficient_quality_gain.v1"] : [])
        ];
        const attempt: RevisionAttempt = {
          schema: "scce.answer_revision.attempt.v1",
          round,
          baselineVersionId: current.id,
          proposedVersionId: proposed.version.id,
          ...(proposed.plan ? { planId: proposed.plan.id } : {}),
          defectsBefore: currentDefects,
          defectsAfter: critique.defects,
          qualityBefore,
          qualityAfter,
          qualityGain,
          requiredQualityGain: ANSWER_REVISION_CONTRACT.minimumQualityGain,
          hardFailureCount: proposedHardFailures.length,
          accepted,
          rejectionReasons,
          trace: toJsonValue({
            planTrace: proposed.plan?.trace ?? null,
            assessmentTrace: proposed.version.quality.trace,
            validationTrace: proposed.version.validationResults.trace,
            hardFailureIds: proposedHardFailures.map(failure => failure.id)
          })
        };
        attempts.push(attempt);

        if (accepted) {
          current = proposed.version;
          currentDefects = critique.defects;
          if (!strongestValid || normalizedQuality(current.quality.score) > normalizedQuality(strongestValid.quality.score)) strongestValid = current;
          if (currentDefects.length === 0) {
            return revisionResult("resolved", current, attempts, initialCritique.defects, currentDefects);
          }
        } else {
          currentDefects = deduplicateDefects([...currentDefects, ...critique.defects]);
        }
      }

      const selected = strongestValid;
      const finalDefects = selected
        ? critic.review(criticInput(input.requirementField, selected)).defects
        : currentDefects;
      return revisionResult(
        selected ? "exhausted_valid" : "exhausted_no_valid_result",
        selected,
        attempts,
        initialCritique.defects,
        finalDefects
      );
    }
  };
}

export function revisionConstraints(defects: readonly RevisionDefect[]): RevisionConstraint[] {
  return defects.map(defect => ({
    defectId: defect.id,
    defectKind: defect.kind,
    affected: defect.affected,
    violatedRequirement: defect.violatedRequirement,
    requestedCorrection: defect.requestedCorrection,
    confidence: defect.confidence
  }));
}

function criticInput(requirementField: RevisionRequirementField, version: RevisionAnswerVersion): AnswerCriticInput {
  return {
    requirementField,
    selectedProposal: version.selectedProposal,
    selectedCandidate: version.selectedCandidate,
    mouthOutput: version.mouthOutput,
    claimBases: version.claimBases,
    evidence: version.evidence,
    ...(version.dialogueState ? { dialogueState: version.dialogueState } : {}),
    validationResults: version.validationResults
  };
}

async function proposedRevision(
  source: RevisionSource,
  input: RevisionPlannerInput
): Promise<{ version: RevisionAnswerVersion; plan?: RevisionPlan } | undefined> {
  if (source.kind === "candidate_revisions") {
    const version = source.candidates[input.round - 1];
    return version ? { version } : undefined;
  }
  const plan = await source.planner(input);
  if (plan.round !== input.round) throw new Error(`revision plan round ${plan.round} does not match requested round ${input.round}`);
  const version = await source.mouth({ ...input, plan });
  return { version, plan };
}

function missingRequirementDefects(input: AnswerCriticInput): RevisionDefect[] {
  const required = new Map(input.requirementField.requiredFeatures.map(requirement => [requirement.id, requirement] as const));
  const missed = new Set(input.selectedProposal.missedRequirementIds.filter(id => required.has(id)));
  for (const check of input.validationResults.requirementChecks) {
    if (!check.satisfied && required.has(check.requirementId)) missed.add(check.requirementId);
  }
  return [...missed].sort().map(requirementId => {
    const requirement = required.get(requirementId)!;
    const check = input.validationResults.requirementChecks.find(item => item.requirementId === requirementId && !item.satisfied);
    return createDefect({
      kind: "missing_required_feature",
      severity: "error",
      affected: affectedTarget(input.mouthOutput.text, check?.affectedClaimId, check?.affectedSpan),
      requirement: {
        id: requirementId,
        source: "field",
        kind: "required",
        confidence: clamp01(requirement.confidence ?? check?.confidence ?? input.requirementField.confidence),
        trace: requirement.trace ?? check?.trace ?? input.requirementField.trace
      },
      trace: toJsonValue({ proposalId: input.selectedProposal.id, requirementCheck: check?.trace ?? null }),
      correction: "satisfy_requirement",
      confidence: clamp01(check?.confidence ?? requirement.confidence ?? input.requirementField.confidence),
      preserveClaimIds: input.selectedProposal.claims.map(claim => claim.id)
    });
  });
}

function validationIssueDefects(input: AnswerCriticInput): RevisionDefect[] {
  return input.validationResults.issues.map(issue => {
    const fieldRequirement = [...input.requirementField.requiredFeatures, ...input.requirementField.prohibitedFeatures]
      .find(requirement => requirement.id === issue.requirementId);
    const requirementKind = input.requirementField.prohibitedFeatures.some(requirement => requirement.id === issue.requirementId)
      ? "prohibited" as const
      : fieldRequirement ? "required" as const : "invariant" as const;
    return createDefect({
      kind: issue.kind,
      severity: issue.severity,
      affected: affectedTarget(input.mouthOutput.text, issue.affectedClaimId, issue.affectedSpan),
      requirement: {
        id: issue.requirementId ?? `revision.validation.${issue.kind}.v1`,
        source: fieldRequirement ? "field" : "validation",
        kind: requirementKind,
        confidence: clamp01(fieldRequirement?.confidence ?? issue.confidence),
        trace: fieldRequirement?.trace ?? issue.trace
      },
      trace: issue.trace,
      correction: issue.correction,
      confidence: issue.confidence,
      preserveClaimIds: input.selectedProposal.claims.map(claim => claim.id)
    });
  });
}

function citationDefects(input: AnswerCriticInput): RevisionDefect[] {
  const available = new Set(input.evidence.map(item => String(item.id)));
  const allowed = new Set([
    ...input.selectedProposal.evidenceIds.map(String),
    ...input.selectedCandidate.evidenceIds.map(String),
    ...input.claimBases.flatMap(basis => basis.evidenceIds.map(String))
  ]);
  const mismatches = input.validationResults.citationChecks.filter(check => !check.matched).map(check => ({
    evidenceId: check.evidenceId ? String(check.evidenceId) : undefined,
    claimId: check.claimId,
    span: check.affectedSpan,
    confidence: check.confidence,
    trace: check.trace
  }));
  for (const evidenceId of input.mouthOutput.evidenceRefs.map(String)) {
    if (!available.has(evidenceId) || !allowed.has(evidenceId)) {
      mismatches.push({
        evidenceId,
        claimId: undefined,
        span: undefined,
        confidence: 1,
        trace: toJsonValue({ evidenceId, available: available.has(evidenceId), allowedBySelectedMeaning: allowed.has(evidenceId) })
      });
    }
  }
  return mismatches.map(mismatch => createDefect({
    kind: "citation_mismatch",
    severity: "hard_failure",
    affected: affectedTarget(input.mouthOutput.text, mismatch.claimId, mismatch.span),
    requirement: {
      id: INVARIANT_REQUIREMENTS.citationIntegrity,
      source: "invariant",
      kind: "invariant",
      confidence: clamp01(mismatch.confidence),
      trace: mismatch.trace
    },
    trace: toJsonValue({ evidenceId: mismatch.evidenceId ?? null, validationTrace: mismatch.trace }),
    correction: "repair_citation_binding",
    confidence: mismatch.confidence,
    preserveClaimIds: input.selectedProposal.claims.map(claim => claim.id)
  }));
}

function repetitionDefects(input: AnswerCriticInput): RevisionDefect[] {
  const repetition = firstRepeatedUnit(input.mouthOutput.text);
  if (!repetition) return [];
  return [createDefect({
    kind: "repetition",
    severity: "error",
    affected: { kind: "span", span: repetition.span },
    requirement: {
      id: INVARIANT_REQUIREMENTS.nonRepetition,
      source: "invariant",
      kind: "invariant",
      confidence: repetition.confidence,
      trace: toJsonValue({ detector: repetition.detector })
    },
    trace: toJsonValue({ detector: repetition.detector, repeatedUnit: repetition.normalized }),
    correction: "remove_repetition",
    confidence: repetition.confidence,
    preserveClaimIds: input.selectedProposal.claims.map(claim => claim.id)
  })];
}

function createDefect(input: {
  kind: RevisionDefectKind;
  severity: RevisionDefectSeverity;
  affected: RevisionAffectedTarget;
  requirement: RevisionRequirementReference;
  trace: JsonValue;
  correction?: RevisionCorrectionOperation;
  confidence: number;
  preserveClaimIds: string[];
}): RevisionDefect {
  const confidence = clamp01(input.confidence);
  const id = stableId("revision.defect", {
    kind: input.kind,
    affected: input.affected,
    requirementId: input.requirement.id,
    correction: input.correction ?? CORRECTION_BY_DEFECT[input.kind]
  });
  return {
    schema: "scce.answer_revision.defect.v1",
    id,
    kind: input.kind,
    severity: input.severity,
    severityScore: severityScore(input.severity),
    affected: input.affected,
    violatedRequirement: input.requirement,
    supportingTrace: input.trace,
    requestedCorrection: {
      operation: input.correction ?? CORRECTION_BY_DEFECT[input.kind],
      targetIds: targetIds(input.affected, input.requirement.id),
      preserveClaimIds: [...new Set(input.preserveClaimIds)].sort(),
      trace: toJsonValue({ sourceDefectId: id, replacementTextAuthorized: false })
    },
    confidence
  };
}

function affectedTarget(text: string, claimId?: string, span?: RevisionSpan): RevisionAffectedTarget {
  if (claimId && span) return { kind: "claim_span", claimId, span: normalizedSpan(text, span) };
  if (claimId) return { kind: "claim", claimId };
  return { kind: "span", span: normalizedSpan(text, span ?? wholeSpan(text)) };
}

function normalizedSpan(text: string, span: RevisionSpan): RevisionSpan {
  const charStart = Math.max(0, Math.min(text.length, finiteInteger(span.charStart)));
  const charEnd = Math.max(charStart, Math.min(text.length, finiteInteger(span.charEnd)));
  const spanText = text.slice(charStart, charEnd);
  return {
    text: spanText,
    charStart,
    charEnd,
    byteStart: Buffer.byteLength(text.slice(0, charStart), "utf8"),
    byteEnd: Buffer.byteLength(text.slice(0, charEnd), "utf8")
  };
}

function wholeSpan(text: string): RevisionSpan {
  return {
    text,
    charStart: 0,
    charEnd: text.length,
    byteStart: 0,
    byteEnd: Buffer.byteLength(text, "utf8")
  };
}

function firstRepeatedUnit(text: string): { span: RevisionSpan; normalized: string; confidence: number; detector: string } | undefined {
  const units = surfaceUnits(text);
  const seen = new Map<string, { start: number; end: number }>();
  for (const unit of units) {
    const normalized = normalizedWords(unit.text).join(" ");
    if (normalized.length < 12 || normalized.split(" ").length < 3) continue;
    if (seen.has(normalized)) {
      return {
        span: normalizedSpan(text, { ...wholeSpan(unit.text), charStart: unit.start, charEnd: unit.end }),
        normalized,
        confidence: 0.94,
        detector: "revision.detector.repeated_surface_unit.v1"
      };
    }
    seen.set(normalized, { start: unit.start, end: unit.end });
  }

  const tokens = wordTokens(text);
  const width = 6;
  const grams = new Map<string, { index: number; start: number; end: number }>();
  for (let index = 0; index + width <= tokens.length; index++) {
    const window = tokens.slice(index, index + width);
    const normalized = window.map(token => token.normalized).join(" ");
    const prior = grams.get(normalized);
    if (prior && index - prior.index >= width) {
      const start = window[0]!.start;
      const end = window[window.length - 1]!.end;
      return {
        span: normalizedSpan(text, { ...wholeSpan(text.slice(start, end)), charStart: start, charEnd: end }),
        normalized,
        confidence: 0.78,
        detector: "revision.detector.repeated_token_window.v1"
      };
    }
    if (!prior) grams.set(normalized, { index, start: window[0]!.start, end: window[window.length - 1]!.end });
  }
  return undefined;
}

function surfaceUnits(text: string): Array<{ text: string; start: number; end: number }> {
  const units: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (char === "\n" || char === "." || char === "!" || char === "?" || char === "。" || char === "！" || char === "？") {
      const end = index + 1;
      const segment = text.slice(start, end).trim();
      if (segment) {
        const leading = text.slice(start, end).search(/\S/u);
        units.push({ text: segment, start: start + Math.max(0, leading), end });
      }
      start = end;
    }
  }
  const tail = text.slice(start).trim();
  if (tail) {
    const leading = text.slice(start).search(/\S/u);
    units.push({ text: tail, start: start + Math.max(0, leading), end: text.length });
  }
  return units;
}

function normalizedWords(text: string): string[] {
  return wordTokens(text).map(token => token.normalized);
}

function wordTokens(text: string): Array<{ normalized: string; start: number; end: number }> {
  const tokens: Array<{ normalized: string; start: number; end: number }> = [];
  const pattern = /[\p{L}\p{N}][\p{L}\p{M}\p{N}'’_-]*/gu;
  for (const match of text.matchAll(pattern)) {
    if (match.index === undefined) continue;
    tokens.push({
      normalized: match[0].normalize("NFKC").toLocaleLowerCase(),
      start: match.index,
      end: match.index + match[0].length
    });
  }
  return tokens;
}

function hardFailures(input: AnswerCriticInput, defects: readonly RevisionDefect[]): RevisionHardFailure[] {
  return validationHardFailures(input.validationResults, defects);
}

function validationHardFailures(validationResults: RevisionValidationResults, defects: readonly RevisionDefect[]): RevisionHardFailure[] {
  const defectFailures = defects
    .filter(defect => defect.severity === "hard_failure" || HARD_DEFECT_KINDS.has(defect.kind))
    .map(defect => ({ id: defect.id, kind: defect.kind, trace: defect.supportingTrace }));
  const graphFailures = validationResults.validationGraph?.checks
    .filter(check => check.status === "failed")
    .map(check => ({ id: check.id, kind: "validation_graph_failure", trace: toJsonValue(check) })) ?? [];
  return uniqueHardFailures([...validationResults.hardFailures, ...defectFailures, ...graphFailures]);
}

function hardFailuresForVersion(version: RevisionAnswerVersion, defects: readonly RevisionDefect[]): RevisionHardFailure[] {
  return uniqueHardFailures([...version.quality.hardFailures, ...validationHardFailures(version.validationResults, defects)]);
}

function uniqueHardFailures(failures: readonly RevisionHardFailure[]): RevisionHardFailure[] {
  const byId = new Map<string, RevisionHardFailure>();
  for (const failure of failures) byId.set(failure.id, failure);
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function deduplicateDefects(defects: readonly RevisionDefect[]): RevisionDefect[] {
  const byId = new Map<string, RevisionDefect>();
  for (const defect of defects) byId.set(defect.id, defect);
  return [...byId.values()];
}

function revisionResult(
  disposition: RevisionDisposition,
  selected: RevisionAnswerVersion | undefined,
  attempts: RevisionAttempt[],
  initialDefects: RevisionDefect[],
  finalDefects: RevisionDefect[]
): AnswerRevisionResult {
  return {
    schema: "scce.answer_revision.result.v1",
    disposition,
    ...(selected ? { selected } : {}),
    attempts,
    initialDefects,
    finalDefects,
    roundsUsed: attempts.length,
    trace: toJsonValue({
      contract: ANSWER_REVISION_CONTRACT,
      selectedVersionId: selected?.id ?? null,
      attemptIds: attempts.map(attempt => `${attempt.round}:${attempt.proposedVersionId}`),
      acceptance: attempts.map(attempt => ({ round: attempt.round, accepted: attempt.accepted, qualityGain: attempt.qualityGain, hardFailureCount: attempt.hardFailureCount }))
    })
  };
}

function targetIds(affected: RevisionAffectedTarget, requirementId: string): string[] {
  const ids = [requirementId];
  if (affected.kind === "claim" || affected.kind === "claim_span") ids.push(affected.claimId);
  if (affected.kind === "span" || affected.kind === "claim_span") ids.push(`span:${affected.span.charStart}:${affected.span.charEnd}`);
  return ids;
}

function severityRank(severity: RevisionDefectSeverity): number {
  return severity === "hard_failure" ? 3 : severity === "error" ? 2 : 1;
}

function severityScore(severity: RevisionDefectSeverity): number {
  return severity === "hard_failure" ? 1 : severity === "error" ? 0.72 : 0.36;
}

function normalizedQuality(value: number): number {
  return clamp01(value);
}

function finiteInteger(value: number): number {
  return Number.isFinite(value) ? Math.trunc(value) : 0;
}

function stableId(prefix: string, value: unknown): string {
  const source = canonicalStringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${prefix}.${(hash >>> 0).toString(16).padStart(8, "0")}`;
}
