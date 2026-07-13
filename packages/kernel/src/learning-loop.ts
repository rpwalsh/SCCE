import type {
  ChunkId,
  ConstructGraph,
  ContentHash,
  EvidenceId,
  EvidenceSpan,
  FieldState,
  GraphEdge,
  GraphNode,
  GraphSlice,
  Hyperedge,
  JsonValue,
  LanguageProfile,
  ModelState,
  SemanticEntailmentResult,
  SourceId,
  SourceVersion,
  SourceVersionId
} from "./types.js";
import type { Observation } from "./ingestion-lanes.js";
import {
  type ProofClaim,
  type ProofEvidenceRecord,
  type ProofForceClass,
  type SemanticProofEngineVerdict,
  type SemanticProofResult,
  proveClaim
} from "./semantic-proof-engine.js";
import { canonicalStringify, clamp01, featureSet, mean, toJsonValue, weightedJaccard } from "./primitives.js";

export type LearningRecordTypeId =
  | "learning.record.field_gap"
  | "learning.record.learning_need"
  | "learning.record.source_plan"
  | "learning.record.tool_capability"
  | "learning.record.acquisition_result"
  | "learning.record.quarantine"
  | "learning.record.validation"
  | "learning.record.promotion"
  | "learning.record.update_plan"
  | "learning.record.continue_decision";

export interface FieldGap {
  id: string;
  gapKindId: string;
  relatedConstructIds: string[];
  missingEvidenceObligations: string[];
  missingCapabilityIds: string[];
  uncertaintyScore: number;
  contradictionScore: number;
  stalenessScore: number;
  expectedUtility: number;
  acquisitionCostEstimate: number;
  riskScore: number;
  priority: number;
  evidenceIds: string[];
  trace: JsonValue;
}

export interface LearningNeed {
  id: string;
  gapId: string;
  needKindId: string;
  requiredSourceKindIds: string[];
  requiredEvidenceFieldIds: string[];
  requiredCapabilityIds: string[];
  acceptanceCriteriaIds: string[];
  maxRisk: number;
  maxCost: number;
  provenanceRequirementIds: string[];
  priority: number;
  trace: JsonValue;
}

export interface SourceDescriptor {
  id: string;
  sourceKindId: string;
  locator: string;
  expectedRecordKindIds: string[];
  provenanceRequirementIds: string[];
  metadata: JsonValue;
}

export interface SourcePlan {
  id: string;
  learningNeedId: string;
  candidateSourceDescriptors: SourceDescriptor[];
  requiredToolCapabilityIds: string[];
  expectedInformationGain: number;
  expectedProofImprovement: number;
  expectedUtility: number;
  riskEstimate: number;
  costEstimate: number;
  sideEffectPenalty: number;
  evi: number;
  quarantinePolicyId: string;
  validationPolicyId: string;
  trace: JsonValue;
}

export interface ToolCapability {
  id: string;
  kindId: string;
  inputSchema: JsonValue;
  outputSchema: JsonValue;
  permissionClass: string;
  sideEffectClass: string;
  deterministic: boolean;
  maxCost: number;
  riskClass: string;
  risk: number;
}

export interface AcquiredRecord {
  id: string;
  recordKindId: string;
  forceClass: ProofForceClass;
  text?: string;
  sourceVersionId?: string;
  evidenceSpanId?: string;
  sourceVersion?: SourceVersion;
  evidenceSpan?: EvidenceSpan;
  proofEvidence?: ProofEvidenceRecord;
  graphNodes?: GraphNode[];
  graphEdges?: GraphEdge[];
  graphHyperedges?: Hyperedge[];
  languagePrior?: JsonValue;
  typedObservation?: Observation;
  metadata: JsonValue;
}

export interface AcquisitionResult {
  id: string;
  sourcePlanId: string;
  toolCapabilityId: string;
  acquiredRecords: AcquiredRecord[];
  rawSourceRefs: string[];
  sourceVersions: SourceVersion[];
  evidenceSpans: EvidenceSpan[];
  warnings: string[];
  errors: string[];
  costObserved: number;
  sideEffectsObserved: string[];
  trace: JsonValue;
}

export interface QuarantineRecord {
  id: string;
  acquisitionResultId: string;
  records: AcquiredRecord[];
  reason: string;
  riskFlags: string[];
  validationRequired: boolean;
  promoted: false;
  trace: JsonValue;
}

export interface ValidationResult {
  id: string;
  quarantineId: string;
  acceptedRecords: AcquiredRecord[];
  rejectedRecords: AcquiredRecord[];
  rejectionReasons: Array<{ recordId: string; reasonCode: string }>;
  directEvidenceCandidates: ProofEvidenceRecord[];
  learnedPriorCandidates: AcquiredRecord[];
  contradictionCandidates: Array<{ recordId: string; proofResult: SemanticProofResult }>;
  sourceVersionSpanChecks: Array<{ recordId: string; passed: boolean; reasonCode: string }>;
  proofAdmissibilityChecks: Array<{ recordId: string; verdict: SemanticProofEngineVerdict; proofResult: SemanticProofResult }>;
  trace: JsonValue;
}

export interface LearningUpdatePlan {
  id: string;
  evidenceRecordsToAdd: EvidenceSpan[];
  graphNodesToAdd: GraphNode[];
  graphEdgesToAdd: GraphEdge[];
  graphHyperedgesToAdd: Hyperedge[];
  languagePriorsToAdd: JsonValue[];
  typedObservationsToAdd: Observation[];
  sourceVersionsToAdd: SourceVersion[];
  proofTracesToAdd: JsonValue[];
  eventsToAdd: JsonValue[];
  trace: JsonValue;
}

export interface LearningPromotionDecision {
  id: string;
  validationId: string;
  promotedRecords: AcquiredRecord[];
  rejectedRecords: AcquiredRecord[];
  updatePlan: LearningUpdatePlan;
  reasonCodes: string[];
  safeToPromote: boolean;
  trace: JsonValue;
}

export interface ContinueDecision {
  id: string;
  decisionKindId: string;
  continueAnswering: boolean;
  askClarification: boolean;
  answerWithCaveat: boolean;
  deferDueToInsufficientEvidence: boolean;
  reportContradiction: boolean;
  reportUnsupported: boolean;
  safeToAssert: boolean;
  reasonCodes: string[];
  proofAfterUpdate?: SemanticProofResult;
  trace: JsonValue;
}

export interface LearningPolicy {
  id?: string;
  maxRisk: number;
  maxCost: number;
  maxToolRuns: number;
  allowedPermissionClasses: string[];
  allowedSideEffectClasses: string[];
  requireDeterministicTools: boolean;
  quarantinePolicyId: string;
  validationPolicyId: string;
  promotionPolicyId: string;
  proofClaims?: ProofClaim[];
  proofEvidence?: ProofEvidenceRecord[];
}

export interface FieldGapDetectionInput {
  construct?: ConstructGraph;
  field?: FieldState;
  proofResults?: SemanticProofResult[];
  entailments?: SemanticEntailmentResult[];
  proofClaims?: ProofClaim[];
  proofEvidence?: ProofEvidenceRecord[];
  typedObservations?: Observation[];
  evidence?: EvidenceSpan[];
  graph?: GraphSlice | { nodes: GraphNode[]; edges: GraphEdge[]; hyperedges?: Hyperedge[] };
  now?: number;
  staleAfterMs?: number;
}

export interface SyntheticSourceMaterial {
  id: string;
  sourceKindId: string;
  uri: string;
  mediaType: string;
  text: string;
  forceClass: ProofForceClass;
  recordKindId?: string;
  proofEvidence?: Omit<ProofEvidenceRecord, "id" | "forceClass" | "sourceVersionId" | "evidenceSpanId"> & Partial<Pick<ProofEvidenceRecord, "id" | "forceClass" | "sourceVersionId" | "evidenceSpanId">>;
  graphNodes?: GraphNode[];
  graphEdges?: GraphEdge[];
  graphHyperedges?: Hyperedge[];
  languagePrior?: JsonValue;
  typedObservation?: Observation;
  metadata?: JsonValue;
}

export interface SyntheticToolFixtures {
  files?: SyntheticSourceMaterial[];
  documents?: SyntheticSourceMaterial[];
  corpus?: SyntheticSourceMaterial[];
  repositories?: SyntheticSourceMaterial[];
  projects?: SyntheticSourceMaterial[];
  evidence?: SyntheticSourceMaterial[];
  packageMetadata?: SyntheticSourceMaterial[];
  commandDryRuns?: SyntheticSourceMaterial[];
  patchPreviews?: SyntheticSourceMaterial[];
}

export interface ToolRuntimeInput {
  fixtures?: SyntheticToolFixtures;
  policy?: Partial<LearningPolicy>;
  now?: number;
}

export interface ToolRuntime {
  runToolCapability(plan: SourcePlan, capability: ToolCapability, input?: ToolRuntimeInput): AcquisitionResult;
}

export interface LearningLoopInput extends FieldGapDetectionInput {
  toolCapabilities: ToolCapability[];
  policy?: Partial<LearningPolicy>;
  fixtures?: SyntheticToolFixtures;
  maxPlansToRun?: number;
}

export interface LearningLoopResult {
  id: string;
  gaps: FieldGap[];
  learningNeeds: LearningNeed[];
  sourcePlans: SourcePlan[];
  acquisitionResults: AcquisitionResult[];
  quarantineRecords: QuarantineRecord[];
  validationResults: ValidationResult[];
  promotionDecisions: LearningPromotionDecision[];
  updatePlans: LearningUpdatePlan[];
  continueDecision: ContinueDecision;
  hydration: LearningLoopHydrationContract;
  trace: JsonValue;
}

export interface LearningHydrationRecord<TPayload> {
  recordTypeId: LearningRecordTypeId;
  recordId: string;
  validation: { valid: boolean; diagnostics: string[] };
  idempotencyKey: string;
  destinationStoreId: string;
  inspectReplayVisibilityId: string;
  provenance: JsonValue;
  payload: TPayload;
  payloadHash: string;
}

export interface FieldGapRecord extends LearningHydrationRecord<FieldGap> {
  recordTypeId: "learning.record.field_gap";
}

export interface LearningNeedRecord extends LearningHydrationRecord<LearningNeed> {
  recordTypeId: "learning.record.learning_need";
}

export interface SourcePlanRecord extends LearningHydrationRecord<SourcePlan> {
  recordTypeId: "learning.record.source_plan";
}

export interface ToolCapabilityRecord extends LearningHydrationRecord<ToolCapability> {
  recordTypeId: "learning.record.tool_capability";
}

export interface AcquisitionResultRecord extends LearningHydrationRecord<AcquisitionResult> {
  recordTypeId: "learning.record.acquisition_result";
}

export interface LearningQuarantineRecord extends LearningHydrationRecord<QuarantineRecord> {
  recordTypeId: "learning.record.quarantine";
}

export interface LearningValidationRecord extends LearningHydrationRecord<ValidationResult> {
  recordTypeId: "learning.record.validation";
}

export interface PromotionDecisionRecord extends LearningHydrationRecord<LearningPromotionDecision> {
  recordTypeId: "learning.record.promotion";
}

export interface LearningUpdatePlanRecord extends LearningHydrationRecord<LearningUpdatePlan> {
  recordTypeId: "learning.record.update_plan";
}

export interface ContinueDecisionRecord extends LearningHydrationRecord<ContinueDecision> {
  recordTypeId: "learning.record.continue_decision";
}

export type LearningLoopRecord =
  | FieldGapRecord
  | LearningNeedRecord
  | SourcePlanRecord
  | ToolCapabilityRecord
  | AcquisitionResultRecord
  | LearningQuarantineRecord
  | LearningValidationRecord
  | PromotionDecisionRecord
  | LearningUpdatePlanRecord
  | ContinueDecisionRecord;

export interface LearningLoopHydrationContract {
  schema: "scce.learning_loop.hydration.v1";
  records: LearningLoopRecord[];
  dryRunPlan: Array<{ destinationStoreId: string; recordTypeId: LearningRecordTypeId; recordId: string; idempotencyKey: string }>;
  diagnostics: string[];
  valid: boolean;
}

export interface LearningLoopPlan {
  fieldGaps: FieldGap[];
  learningNeeds: LearningNeedPlan[];
  goals: Array<{ goal: string; priority: number; coverageGap: number; evi: number; recommendedSources: LearningSourcePlan[] }>;
  globalSources: LearningSourcePlan[];
  promotionFocus: Array<{ evidenceId: string; sourceVersionId: string; value: number; reason: string }>;
  audit: JsonValue;
}

export interface LearningNeedPlan extends LearningNeed {
  goal: string;
  sourcePlans: LearningSourcePlan[];
  continuation: "answer_after_promotion" | "answer_with_unknown" | "await_owner_approval";
}

export interface LearningSourcePlan extends SourcePlan {
  kind: string;
  capabilityId: string;
  query: string;
  expectedValue: number;
  taskProgress: number;
  proofValue: number;
  cost: number;
  risk: number;
  permissionPenalty: number;
  utility: number;
  acquisition: {
    acquire: boolean;
    quarantine: boolean;
    extract: boolean;
    validate: boolean;
    promote: "never_automatic" | "after_validation" | "owner_review";
    graphUpdate: boolean;
  };
  rationale: string;
}

export const DEFAULT_LEARNING_POLICY: LearningPolicy = {
  id: "learning.policy.synthetic_local",
  maxRisk: 0.45,
  maxCost: 0.45,
  maxToolRuns: 3,
  allowedPermissionClasses: ["permission.synthetic_local", "permission.temp_fixture"],
  allowedSideEffectClasses: ["side_effect.none", "side_effect.temp_read"],
  requireDeterministicTools: true,
  quarantinePolicyId: "learning.quarantine.synthetic_required",
  validationPolicyId: "learning.validation.source_span_force_class",
  promotionPolicyId: "learning.promotion.update_plan_only"
};

export function defaultSyntheticToolCapabilities(): ToolCapability[] {
  return [
    toolCapability("tool.fixture.file_read", "tool.kind.fixture_file_read", 0.06, "permission.synthetic_local", "side_effect.none"),
    toolCapability("tool.fixture.repo_inspect", "tool.kind.fixture_repo_inspect", 0.1, "permission.temp_fixture", "side_effect.temp_read"),
    toolCapability("tool.fixture.document_fetch", "tool.kind.fixture_document_fetch", 0.08, "permission.synthetic_local", "side_effect.none"),
    toolCapability("tool.fixture.corpus_lookup", "tool.kind.fixture_corpus_lookup", 0.1, "permission.synthetic_local", "side_effect.none"),
    toolCapability("tool.fixture.project_read", "tool.kind.fixture_project_read", 0.12, "permission.temp_fixture", "side_effect.temp_read"),
    toolCapability("tool.fixture.evidence_lookup", "tool.kind.fixture_evidence_lookup", 0.06, "permission.synthetic_local", "side_effect.none"),
    toolCapability("tool.fixture.package_metadata_lookup", "tool.kind.fixture_package_metadata_lookup", 0.14, "permission.temp_fixture", "side_effect.temp_read"),
    toolCapability("tool.fixture.command_dry_run", "tool.kind.fixture_command_dry_run", 0.18, "permission.temp_fixture", "side_effect.temp_read"),
    toolCapability("tool.fixture.patch_preview", "tool.kind.fixture_patch_preview", 0.2, "permission.temp_fixture", "side_effect.temp_read")
  ];
}

export function createLearningLoop() {
  return {
    plan(input: { goals: string[]; model: ModelState; graph: GraphSlice; evidence: EvidenceSpan[]; languageProfiles: LanguageProfile[] }): LearningLoopPlan {
      const fieldGaps = detectFieldGaps({
        evidence: input.evidence,
        graph: input.graph,
        now: Date.now()
      });
      const goalGaps = input.goals.length ? input.goals.map((goal, index) => gapFromLegacyGoal(goal, input, index)) : [];
      const gaps = dedupeGaps([...fieldGaps, ...goalGaps]).slice(0, 24);
      const capabilities = defaultSyntheticToolCapabilities();
      const learningNeeds = gaps.map(gap => learningNeedFromGap(gap, DEFAULT_LEARNING_POLICY));
      const sourcePlans = planLearningSources(gaps, capabilities, DEFAULT_LEARNING_POLICY);
      const byNeed = groupPlansByNeed(sourcePlans.map(toLearningSourcePlan));
      const legacyNeeds: LearningNeedPlan[] = learningNeeds.map(need => ({
        ...need,
        goal: need.trace && typeof need.trace === "object" && !Array.isArray(need.trace) && typeof need.trace.goal === "string" ? need.trace.goal : need.needKindId,
        sourcePlans: byNeed.get(need.id) ?? [],
        continuation: (byNeed.get(need.id) ?? []).some(plan => plan.acquisition.promote === "after_validation") ? "answer_after_promotion" : "answer_with_unknown"
      }));
      const goals = legacyNeeds.map(need => ({
        goal: need.goal,
        priority: need.priority,
        coverageGap: clamp01(1 - need.priority * 0.5),
        evi: mean(need.sourcePlans.map(plan => plan.evi)),
        recommendedSources: need.sourcePlans
      }));
      const globalSources = sourcePlans.slice(0, 8).map(toLearningSourcePlan);
      const promotionFocus = promotionFocusPlan(input.evidence);
      return {
        fieldGaps: gaps,
        learningNeeds: legacyNeeds,
        goals,
        globalSources,
        promotionFocus,
        audit: toJsonValue({ source: "learning-loop.plan", fieldGaps: gaps, learningNeeds: legacyNeeds, goals, globalSources, promotionFocus })
      };
    }
  };
}

export function detectFieldGaps(input: FieldGapDetectionInput): FieldGap[] {
  const out: FieldGap[] = [];
  const add = (gap: FieldGap) => {
    if (!out.some(existing => existing.id === gap.id || sameGap(existing, gap))) out.push(gap);
  };
  for (const proof of input.proofResults ?? []) {
    if (proof.verdict === "unsupported_prior_only") {
      add(gap("gap.missing_direct_evidence", {
        evidenceIds: proof.rejectedEvidence.map(item => item.evidenceId),
        missingEvidenceObligations: ["obligation.direct_source_span"],
        uncertaintyScore: 0.82,
        expectedUtility: 0.86,
        trace: { proofVerdict: proof.verdict, rejectedEvidence: proof.rejectedEvidence }
      }));
      add(gap("gap.prior_only_support", {
        evidenceIds: proof.rejectedEvidence.map(item => item.evidenceId),
        missingEvidenceObligations: ["obligation.direct_evidence_not_prior"],
        uncertaintyScore: 0.74,
        expectedUtility: 0.72,
        trace: { proofVerdict: proof.verdict }
      }));
    }
    if (proof.verdict === "insufficient_evidence") {
      add(gap("gap.missing_direct_evidence", {
        missingEvidenceObligations: proof.obligations.filter(item => !item.passed).map(item => item.kind),
        uncertaintyScore: 0.78,
        expectedUtility: 0.78,
        trace: { proofVerdict: proof.verdict }
      }));
    }
    if (proof.verdict === "contradicted" || proof.contradictions.length) {
      add(gap("gap.contradiction_present", {
        evidenceIds: proof.contradictions.map(item => item.evidenceId),
        contradictionScore: 0.92,
        riskScore: 0.42,
        expectedUtility: 0.82,
        trace: { proofVerdict: proof.verdict, contradictions: proof.contradictions }
      }));
    }
    if (proof.verdict === "source_bound_only") {
      add(gap("gap.missing_direct_evidence", {
        missingEvidenceObligations: ["obligation.external_source_binding"],
        uncertaintyScore: 0.7,
        expectedUtility: 0.68,
        trace: { proofVerdict: proof.verdict }
      }));
    }
  }
  for (const entailment of input.entailments ?? []) {
    const proofGate = proofGateVerdictFromEntailment(entailment);
    if (proofGate === "unsupported_prior_only" || proofGate === "insufficient_evidence") {
      add(gap("gap.missing_direct_evidence", {
        evidenceIds: entailment.evidenceIds.map(String),
        missingEvidenceObligations: entailment.missing.map(item => item.kind),
        uncertaintyScore: clamp01(1 - entailment.support),
        expectedUtility: 0.76,
        trace: toJsonValue({ entailmentVerdict: entailment.verdict, proofGate: proofGate ?? null })
      }));
    }
    if (entailment.verdict === "contradicted" || proofGate === "contradicted" || entailment.contradiction > 0.45) {
      add(gap("gap.contradiction_present", {
        evidenceIds: entailment.evidenceIds.map(String),
        contradictionScore: Math.max(0.64, entailment.contradiction),
        riskScore: 0.45,
        expectedUtility: 0.8,
        trace: toJsonValue({ entailmentVerdict: entailment.verdict, proofGate: proofGate ?? null })
      }));
    }
    for (const missing of entailment.missing.filter(item => item.required)) {
      add(gap("gap.missing_typed_observation", {
        missingEvidenceObligations: [missing.kind, missing.reason],
        uncertaintyScore: 0.55,
        expectedUtility: 0.58,
        trace: toJsonValue({ missing })
      }));
    }
  }
  if (input.construct?.program?.hydration) {
    const hydration = input.construct.program.hydration;
    if (hydration.dependencies.some(dep => dep.missing) || hydration.validations.some(item => item.commandSource === "program.validation.command.source_derived") || hydration.diagnostics.length) {
      add(gap("gap.program_validation_gap", {
        relatedConstructIds: [input.construct.id, input.construct.program.id].map(String),
        missingCapabilityIds: hydration.dependencies.filter(dep => dep.missing).map(dep => `package:${dep.packageName}`),
        missingEvidenceObligations: hydration.diagnostics,
        uncertaintyScore: 0.5,
        expectedUtility: 0.66,
        riskScore: 0.24,
        trace: toJsonValue({ programId: input.construct.program.id, diagnostics: hydration.diagnostics, missingDependencies: hydration.dependencies.filter(dep => dep.missing) })
      }));
    }
  }
  const activeImportedPrior = importedPriorActivation(input.field);
  if (activeImportedPrior > 0 && !(input.proofEvidence ?? []).some(record => record.forceClass === "direct_evidence")) {
    add(gap("gap.prior_only_support", {
      uncertaintyScore: clamp01(0.4 + activeImportedPrior * 0.4),
      expectedUtility: clamp01(0.45 + activeImportedPrior * 0.35),
      trace: { importedPriorActivation: activeImportedPrior }
    }));
  }
  const stale = staleEvidence(input.evidence ?? [], input.now ?? 0, input.staleAfterMs ?? 1000 * 60 * 60 * 24 * 180);
  if (stale.length) {
    add(gap("gap.stale_source", {
      evidenceIds: stale.map(span => String(span.id)),
      stalenessScore: Math.min(1, stale.length / Math.max(1, (input.evidence ?? []).length)),
      uncertaintyScore: 0.4,
      expectedUtility: 0.48,
      trace: { staleEvidenceIds: stale.map(span => String(span.id)).slice(0, 16) }
    }));
  }
  if ((input.proofClaims?.length ?? 0) > 0 && !(input.typedObservations?.length ?? 0) && !(input.proofEvidence?.length ?? 0)) {
    add(gap("gap.missing_typed_observation", {
      missingEvidenceObligations: ["obligation.typed_observation"],
      uncertaintyScore: 0.64,
      expectedUtility: 0.68,
      trace: { proofClaims: input.proofClaims?.map(item => item.id).slice(0, 12) ?? [] }
    }));
  }
  return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

export function planLearningSources(gaps: readonly FieldGap[], capabilities: readonly ToolCapability[], policyInput: Partial<LearningPolicy> = {}): SourcePlan[] {
  const policy = normalizePolicy(policyInput);
  const plans: SourcePlan[] = [];
  for (const gapItem of gaps) {
    const need = learningNeedFromGap(gapItem, policy);
    for (const capability of capabilities) {
      if (!need.requiredCapabilityIds.includes(capability.id)) continue;
      if (!capabilityAllowed(capability, policy)) continue;
      plans.push(sourcePlanFor(need, gapItem, capability, policy));
    }
  }
  return plans.sort((a, b) => b.evi - a.evi || a.id.localeCompare(b.id));
}

export function createSyntheticToolRuntime(defaults: ToolRuntimeInput = {}): ToolRuntime {
  return {
    runToolCapability(plan, capability, input = {}) {
      return runToolCapability(plan, capability, { ...defaults, ...input, fixtures: mergeFixtures(defaults.fixtures, input.fixtures) });
    }
  };
}

export function runToolCapability(plan: SourcePlan, capability: ToolCapability, input: ToolRuntimeInput = {}): AcquisitionResult {
  const policy = normalizePolicy(input.policy);
  const base = {
    sourcePlanId: plan.id,
    toolCapabilityId: capability.id,
    costObserved: Math.min(capability.maxCost, plan.costEstimate),
    sideEffectsObserved: capability.sideEffectClass === "side_effect.none" ? [] : [capability.sideEffectClass]
  };
  if (!plan.requiredToolCapabilityIds.includes(capability.id)) {
    return acquisitionResult({ ...base, records: [], warnings: [], errors: ["tool.error.capability_not_required"], trace: { plan: plan.id, capability: capability.id } });
  }
  if (!capabilityAllowed(capability, policy)) {
    return acquisitionResult({ ...base, records: [], warnings: [], errors: ["tool.error.capability_rejected_by_policy"], trace: toJsonValue({ plan: plan.id, capability: capability.id, policy: policy.id ?? null }) });
  }
  const materials = materialsForCapability(capability, input.fixtures ?? {});
  if (!materials.length) {
    return acquisitionResult({ ...base, records: [], warnings: ["tool.warning.fixture_empty"], errors: ["tool.error.no_fixture_records"], trace: { plan: plan.id, capability: capability.id } });
  }
  const sourceKindIds = new Set(plan.candidateSourceDescriptors.map(item => item.sourceKindId));
  const selected = materials.filter(material => !sourceKindIds.size || sourceKindIds.has(material.sourceKindId)).slice(0, 8);
  if (!selected.length) {
    return acquisitionResult({ ...base, records: [], warnings: ["tool.warning.no_matching_source_kind"], errors: ["tool.error.no_fixture_records"], trace: { plan: plan.id, capability: capability.id, sourceKindIds: [...sourceKindIds] } });
  }
  const records = selected.map(material => materialToRecord(material, plan, capability, input.now ?? 0));
  return acquisitionResult({
    ...base,
    records,
    warnings: records.some(record => !record.evidenceSpanId && record.forceClass === "direct_evidence") ? ["tool.warning.direct_evidence_without_span"] : [],
    errors: [],
    trace: { plan: plan.id, capability: capability.id, recordIds: records.map(record => record.id) }
  });
}

export function quarantineAcquisition(result: AcquisitionResult, policyInput: Partial<LearningPolicy> = {}): QuarantineRecord {
  const policy = normalizePolicy(policyInput);
  const riskFlags = [
    ...result.errors.map(error => `risk.acquisition_error:${error}`),
    ...result.warnings.map(warning => `risk.acquisition_warning:${warning}`),
    ...(result.sideEffectsObserved.length ? ["risk.side_effect_observed"] : [])
  ];
  return {
    id: stableId("quarantine", { result: result.id, policy: policy.quarantinePolicyId }),
    acquisitionResultId: result.id,
    records: result.acquiredRecords,
    reason: result.errors.length ? "quarantine.reason.acquisition_error" : "quarantine.reason.validation_required",
    riskFlags,
    validationRequired: true,
    promoted: false,
    trace: toJsonValue({ source: "learning.quarantine", acquisitionResultId: result.id, policy: policy.quarantinePolicyId, riskFlags })
  };
}

export function validateQuarantine(record: QuarantineRecord, policyInput: Partial<LearningPolicy> = {}): ValidationResult {
  const policy = normalizePolicy(policyInput);
  const accepted: AcquiredRecord[] = [];
  const rejected: AcquiredRecord[] = [];
  const rejectionReasons: ValidationResult["rejectionReasons"] = [];
  const directEvidenceCandidates: ProofEvidenceRecord[] = [];
  const learnedPriorCandidates: AcquiredRecord[] = [];
  const contradictionCandidates: ValidationResult["contradictionCandidates"] = [];
  const sourceVersionSpanChecks: ValidationResult["sourceVersionSpanChecks"] = [];
  const proofAdmissibilityChecks: ValidationResult["proofAdmissibilityChecks"] = [];
  const proofClaims = policy.proofClaims ?? [];

  for (const item of record.records) {
    const sourceCheck = sourceSpanCheck(item);
    sourceVersionSpanChecks.push(sourceCheck);
    const recordReasons: string[] = [];
    if (item.forceClass === "direct_evidence" && !sourceCheck.passed) recordReasons.push(sourceCheck.reasonCode);
    if (item.forceClass === "unknown_prior") recordReasons.push("validation.reject.unknown_prior");
    if (item.recordKindId === "record.unsupported") recordReasons.push("validation.reject.unsupported_record");
    if (item.typedObservation && !typedObservationValid(item.typedObservation)) recordReasons.push("validation.reject.typed_observation_invalid");
    if (recordReasons.length) {
      rejected.push(item);
      for (const reasonCode of recordReasons) rejectionReasons.push({ recordId: item.id, reasonCode });
      continue;
    }
    accepted.push(item);
    if (item.forceClass === "direct_evidence" && item.proofEvidence) directEvidenceCandidates.push(item.proofEvidence);
    if (isLearnedPrior(item.forceClass)) learnedPriorCandidates.push(item);
    if (item.proofEvidence && proofClaims.length) {
      for (const claim of proofClaims) {
        const proofResult = proveClaim({ claim, candidateEvidence: [item.proofEvidence, ...(policy.proofEvidence ?? [])] });
        proofAdmissibilityChecks.push({ recordId: item.id, verdict: proofResult.verdict, proofResult });
        if (proofResult.verdict === "contradicted") contradictionCandidates.push({ recordId: item.id, proofResult });
      }
    }
  }
  return {
    id: stableId("validation", { quarantine: record.id, accepted: accepted.map(item => item.id), rejected: rejected.map(item => item.id) }),
    quarantineId: record.id,
    acceptedRecords: accepted,
    rejectedRecords: rejected,
    rejectionReasons,
    directEvidenceCandidates,
    learnedPriorCandidates,
    contradictionCandidates,
    sourceVersionSpanChecks,
    proofAdmissibilityChecks,
    trace: toJsonValue({ source: "learning.validation", policy: policy.validationPolicyId, accepted: accepted.length, rejected: rejected.length, contradictions: contradictionCandidates.length })
  };
}

export function promoteValidatedRecords(validation: ValidationResult, policyInput: Partial<LearningPolicy> = {}): LearningPromotionDecision {
  const policy = normalizePolicy(policyInput);
  const safeToPromote = validation.acceptedRecords.length > 0 && validation.contradictionCandidates.length === 0;
  const promoted = safeToPromote ? validation.acceptedRecords : [];
  const rejected = [...validation.rejectedRecords, ...(safeToPromote ? [] : validation.acceptedRecords)];
  const updatePlan = updatePlanFromRecords(promoted, validation, policy);
  const reasonCodes = [
    safeToPromote ? "promotion.safe.update_plan_only" : "promotion.blocked.validation_or_contradiction",
    ...validation.rejectionReasons.map(item => item.reasonCode),
    ...validation.contradictionCandidates.map(() => "promotion.blocked.contradiction_candidate")
  ];
  return {
    id: stableId("promotion", { validation: validation.id, promoted: promoted.map(item => item.id), policy: policy.promotionPolicyId }),
    validationId: validation.id,
    promotedRecords: promoted,
    rejectedRecords: rejected,
    updatePlan,
    reasonCodes: [...new Set(reasonCodes)],
    safeToPromote,
    trace: toJsonValue({ source: "learning.promotion", policy: policy.promotionPolicyId, safeToPromote, updatePlanId: updatePlan.id })
  };
}

export function runLearningLoop(input: LearningLoopInput): LearningLoopResult {
  const policy = normalizePolicy(input.policy);
  const id = stableId("learning_loop", { claims: input.proofClaims?.map(item => item.id) ?? [], evidence: input.evidence?.map(item => String(item.id)) ?? [], now: input.now ?? 0 });
  const gaps = detectFieldGaps(input);
  const learningNeeds = gaps.map(gapItem => learningNeedFromGap(gapItem, policy));
  const sourcePlans = planLearningSources(gaps, input.toolCapabilities, policy);
  const runtime = createSyntheticToolRuntime({ policy, now: input.now });
  const sourcePlansWithFixtureMaterial = input.fixtures
    ? sourcePlans.filter(plan => {
      const capability = input.toolCapabilities.find(item => plan.requiredToolCapabilityIds.includes(item.id));
      return capability ? planHasMatchingFixtureMaterial(plan, capability, input.fixtures ?? {}) : false;
    })
    : [];
  const runnablePlans = (sourcePlansWithFixtureMaterial.length ? sourcePlansWithFixtureMaterial : sourcePlans).slice(0, Math.max(0, input.maxPlansToRun ?? policy.maxToolRuns));
  const acquisitionResults: AcquisitionResult[] = [];
  const quarantineRecords: QuarantineRecord[] = [];
  const validationResults: ValidationResult[] = [];
  const promotionDecisions: LearningPromotionDecision[] = [];
  for (const plan of runnablePlans) {
    const capability = input.toolCapabilities.find(item => plan.requiredToolCapabilityIds.includes(item.id));
    if (!capability) continue;
    const acquisition = runtime.runToolCapability(plan, capability, { fixtures: input.fixtures, policy, now: input.now });
    acquisitionResults.push(acquisition);
    const quarantine = quarantineAcquisition(acquisition, policy);
    quarantineRecords.push(quarantine);
    const validation = validateQuarantine(quarantine, policy);
    validationResults.push(validation);
    promotionDecisions.push(promoteValidatedRecords(validation, policy));
  }
  const updatePlans = promotionDecisions.map(decision => decision.updatePlan);
  const proofAfterUpdate = proofAfterPromotion(input.proofClaims ?? [], input.proofEvidence ?? [], promotionDecisions);
  const continueDecision = continueDecisionFor({ gaps, sourcePlans, acquisitionResults, validationResults, promotionDecisions, proofAfterUpdate });
  const partial = {
    id,
    gaps,
    learningNeeds,
    sourcePlans,
    acquisitionResults,
    quarantineRecords,
    validationResults,
    promotionDecisions,
    updatePlans,
    continueDecision,
    trace: toJsonValue({
      source: "learning-loop.runtime",
      gaps: gaps.map(item => item.id),
      plans: sourcePlans.map(item => item.id),
      acquisitions: acquisitionResults.map(item => item.id),
      promotions: promotionDecisions.map(item => ({ id: item.id, safeToPromote: item.safeToPromote })),
      continueDecision: continueDecision.decisionKindId
    })
  };
  return { ...partial, hydration: createLearningLoopHydrationContract(partial) };
}

export function createLearningLoopHydrationContract(input: Omit<LearningLoopResult, "hydration">): LearningLoopHydrationContract {
  const records: LearningLoopRecord[] = [
    ...input.gaps.map(item => hydrationRecord("learning.record.field_gap", item.id, "store.learning.field_gaps", item) as FieldGapRecord),
    ...input.learningNeeds.map(item => hydrationRecord("learning.record.learning_need", item.id, "store.learning.needs", item) as LearningNeedRecord),
    ...input.sourcePlans.map(item => hydrationRecord("learning.record.source_plan", item.id, "store.learning.source_plans", item) as SourcePlanRecord),
    ...uniqueCapabilities(input.sourcePlans).map(item => hydrationRecord("learning.record.tool_capability", item.id, "store.learning.tool_capabilities", item) as ToolCapabilityRecord),
    ...input.acquisitionResults.map(item => hydrationRecord("learning.record.acquisition_result", item.id, "store.learning.acquisitions", item) as AcquisitionResultRecord),
    ...input.quarantineRecords.map(item => hydrationRecord("learning.record.quarantine", item.id, "store.learning.quarantine", item) as LearningQuarantineRecord),
    ...input.validationResults.map(item => hydrationRecord("learning.record.validation", item.id, "store.learning.validations", item) as LearningValidationRecord),
    ...input.promotionDecisions.map(item => hydrationRecord("learning.record.promotion", item.id, "store.learning.promotions", item) as PromotionDecisionRecord),
    ...input.updatePlans.map(item => hydrationRecord("learning.record.update_plan", item.id, "store.learning.update_plans", item) as LearningUpdatePlanRecord),
    hydrationRecord("learning.record.continue_decision", input.continueDecision.id, "store.learning.continue_decisions", input.continueDecision) as ContinueDecisionRecord
  ];
  const diagnostics = records.flatMap(record => record.validation.diagnostics);
  return {
    schema: "scce.learning_loop.hydration.v1",
    records,
    dryRunPlan: records.map(record => ({ destinationStoreId: record.destinationStoreId, recordTypeId: record.recordTypeId, recordId: record.recordId, idempotencyKey: record.idempotencyKey })),
    diagnostics,
    valid: diagnostics.length === 0
  };
}

export function validateLearningLoopHydrationContract(contract: LearningLoopHydrationContract): { valid: boolean; diagnostics: string[] } {
  const diagnostics: string[] = [];
  if (contract.schema !== "scce.learning_loop.hydration.v1") diagnostics.push("learning.hydration.schema");
  if (!contract.records.length) diagnostics.push("learning.hydration.records_missing");
  if (contract.records.length !== contract.dryRunPlan.length) diagnostics.push("learning.hydration.dry_run_count_mismatch");
  for (const record of contract.records) {
    if (!record.recordId) diagnostics.push(`learning.hydration.record_id:${record.recordTypeId}`);
    if (!record.idempotencyKey) diagnostics.push(`learning.hydration.idempotency:${record.recordId}`);
    if (!record.destinationStoreId) diagnostics.push(`learning.hydration.destination:${record.recordId}`);
    if (!record.inspectReplayVisibilityId) diagnostics.push(`learning.hydration.inspect_visibility:${record.recordId}`);
    if (!record.validation.valid) diagnostics.push(...record.validation.diagnostics);
  }
  return { valid: diagnostics.length === 0 && contract.valid, diagnostics: [...contract.diagnostics, ...diagnostics] };
}

function toolCapability(id: string, kindId: string, risk: number, permissionClass: string, sideEffectClass: string): ToolCapability {
  return {
    id,
    kindId,
    inputSchema: toJsonValue({ sourcePlanId: "string", descriptors: "array" }),
    outputSchema: toJsonValue({ sourceVersions: "array", evidenceSpans: "array", acquiredRecords: "array" }),
    permissionClass,
    sideEffectClass,
    deterministic: true,
    maxCost: risk + 0.08,
    riskClass: risk <= 0.12 ? "risk.low" : "risk.medium",
    risk
  };
}

function normalizePolicy(input: Partial<LearningPolicy> = {}): LearningPolicy {
  return {
    ...DEFAULT_LEARNING_POLICY,
    ...input,
    allowedPermissionClasses: input.allowedPermissionClasses ?? DEFAULT_LEARNING_POLICY.allowedPermissionClasses,
    allowedSideEffectClasses: input.allowedSideEffectClasses ?? DEFAULT_LEARNING_POLICY.allowedSideEffectClasses,
    proofClaims: input.proofClaims ?? DEFAULT_LEARNING_POLICY.proofClaims,
    proofEvidence: input.proofEvidence ?? DEFAULT_LEARNING_POLICY.proofEvidence
  };
}

function learningNeedFromGap(gapItem: FieldGap, policy: LearningPolicy): LearningNeed {
  const kind = gapItem.gapKindId;
  const capabilityIds = capabilityIdsForGap(kind);
  const sourceKinds = sourceKindIdsForGap(kind);
  const requiredEvidence = evidenceFieldIdsForGap(kind);
  return {
    id: stableId("need", { gap: gapItem.id, kind, capabilityIds }),
    gapId: gapItem.id,
    needKindId: needKindForGap(kind),
    requiredSourceKindIds: sourceKinds,
    requiredEvidenceFieldIds: requiredEvidence,
    requiredCapabilityIds: capabilityIds,
    acceptanceCriteriaIds: acceptanceCriteriaForGap(kind),
    maxRisk: Math.min(policy.maxRisk, Math.max(0.08, gapItem.riskScore + 0.22)),
    maxCost: Math.min(policy.maxCost, Math.max(0.08, gapItem.acquisitionCostEstimate + 0.24)),
    provenanceRequirementIds: ["provenance.source_version", "provenance.evidence_span", ...gapItem.missingEvidenceObligations.filter(item => item.includes("source"))],
    priority: gapItem.priority,
    trace: toJsonValue({ source: "learning.need.from_gap", gapKindId: kind, gapPriority: gapItem.priority })
  };
}

function sourcePlanFor(need: LearningNeed, gapItem: FieldGap, capability: ToolCapability, policy: LearningPolicy): SourcePlan {
  const informationGain = clamp01(0.36 + gapItem.uncertaintyScore * 0.28 + need.priority * 0.24 + (capability.kindId.includes("evidence") ? 0.12 : 0));
  const proofImprovement = clamp01(0.28 + gapItem.expectedUtility * 0.34 + (need.requiredEvidenceFieldIds.includes("field.evidence_span_id") ? 0.2 : 0));
  const expectedUtility = clamp01(gapItem.expectedUtility * 0.52 + informationGain * 0.28 + proofImprovement * 0.2);
  const risk = clamp01(Math.max(gapItem.riskScore * 0.62, capability.risk));
  const cost = clamp01(Math.max(gapItem.acquisitionCostEstimate, capability.maxCost * 0.72));
  const sideEffectPenalty = capability.sideEffectClass === "side_effect.none" ? 0 : 0.08;
  const evi = clamp01(informationGain + proofImprovement + expectedUtility - cost - risk - sideEffectPenalty);
  const descriptor = sourceDescriptorFor(need, capability);
  return {
    id: stableId("source_plan", { need: need.id, capability: capability.id, descriptor }),
    learningNeedId: need.id,
    candidateSourceDescriptors: [descriptor],
    requiredToolCapabilityIds: [capability.id],
    expectedInformationGain: informationGain,
    expectedProofImprovement: proofImprovement,
    expectedUtility,
    riskEstimate: risk,
    costEstimate: cost,
    sideEffectPenalty,
    evi,
    quarantinePolicyId: policy.quarantinePolicyId,
    validationPolicyId: policy.validationPolicyId,
    trace: toJsonValue({ source: "learning.source_plan", gapKindId: gapItem.gapKindId, capabilityId: capability.id })
  };
}

function sourceDescriptorFor(need: LearningNeed, capability: ToolCapability): SourceDescriptor {
  const sourceKindId = preferredSourceKindForCapability(need.requiredSourceKindIds, capability.kindId);
  return {
    id: stableId("source_descriptor", { need: need.id, capability: capability.id, sourceKindId }),
    sourceKindId,
    locator: `fixture://${sourceKindId}/${need.id}`,
    expectedRecordKindIds: need.requiredEvidenceFieldIds,
    provenanceRequirementIds: need.provenanceRequirementIds,
    metadata: toJsonValue({ capabilityKindId: capability.kindId, acceptanceCriteriaIds: need.acceptanceCriteriaIds })
  };
}

function capabilityAllowed(capability: ToolCapability, policy: LearningPolicy): boolean {
  if (policy.requireDeterministicTools && !capability.deterministic) return false;
  if (capability.maxCost > policy.maxCost) return false;
  if (capability.risk > policy.maxRisk) return false;
  if (!policy.allowedPermissionClasses.includes(capability.permissionClass)) return false;
  if (!policy.allowedSideEffectClasses.includes(capability.sideEffectClass)) return false;
  return true;
}

function capabilityIdsForGap(gapKindId: string): string[] {
  if (gapKindId === "gap.program_validation_gap") return ["tool.fixture.package_metadata_lookup", "tool.fixture.repo_inspect", "tool.fixture.command_dry_run", "tool.fixture.patch_preview"];
  if (gapKindId === "gap.missing_capability") return ["tool.fixture.package_metadata_lookup", "tool.fixture.repo_inspect"];
  if (gapKindId === "gap.missing_typed_observation") return ["tool.fixture.file_read", "tool.fixture.document_fetch", "tool.fixture.repo_inspect"];
  if (gapKindId === "gap.contradiction_present") return ["tool.fixture.evidence_lookup", "tool.fixture.corpus_lookup"];
  return ["tool.fixture.evidence_lookup", "tool.fixture.corpus_lookup", "tool.fixture.document_fetch"];
}

function sourceKindIdsForGap(gapKindId: string): string[] {
  if (gapKindId === "gap.program_validation_gap") return ["source.synthetic.package_metadata", "source.synthetic.repo_fixture", "source.synthetic.command_dry_run", "source.synthetic.patch_preview"];
  if (gapKindId === "gap.missing_capability") return ["source.synthetic.package_metadata", "source.synthetic.repo_fixture"];
  if (gapKindId === "gap.missing_typed_observation") return ["source.synthetic.file_fixture", "source.synthetic.in_memory_document", "source.synthetic.repo_fixture"];
  if (gapKindId === "gap.stale_source") return ["source.synthetic.corpus_fixture", "source.synthetic.fixture_evidence"];
  return ["source.synthetic.fixture_evidence", "source.synthetic.corpus_fixture", "source.synthetic.in_memory_document"];
}

function evidenceFieldIdsForGap(gapKindId: string): string[] {
  if (gapKindId === "gap.program_validation_gap") return ["field.package_metadata", "field.validation_command", "field.patch_preview", "field.provenance"];
  if (gapKindId === "gap.missing_typed_observation") return ["field.typed_observation", "field.source_version_id", "field.evidence_span_id"];
  return ["field.source_version_id", "field.evidence_span_id", "field.force_class"];
}

function needKindForGap(gapKindId: string): string {
  if (gapKindId === "gap.contradiction_present") return "need.resolve_contradiction";
  if (gapKindId === "gap.program_validation_gap") return "need.program_validation_evidence";
  if (gapKindId === "gap.missing_typed_observation") return "need.typed_observation";
  return "need.direct_evidence";
}

function acceptanceCriteriaForGap(gapKindId: string): string[] {
  if (gapKindId === "gap.contradiction_present") return ["criteria.contradiction_surface", "criteria.source_span_bound"];
  if (gapKindId === "gap.program_validation_gap") return ["criteria.package_fact_observed", "criteria.validation_command_provenance"];
  return ["criteria.direct_evidence_source_version", "criteria.direct_evidence_span", "criteria.force_class_preserved"];
}

function preferredSourceKindForCapability(sourceKinds: readonly string[], capabilityKindId: string): string {
  if (capabilityKindId === "tool.kind.fixture_file_read") return "source.synthetic.file_fixture";
  if (capabilityKindId === "tool.kind.fixture_repo_inspect") return "source.synthetic.repo_fixture";
  if (capabilityKindId === "tool.kind.fixture_package_metadata_lookup") return "source.synthetic.package_metadata";
  if (capabilityKindId === "tool.kind.fixture_project_read") return "source.synthetic.project_fixture";
  if (capabilityKindId === "tool.kind.fixture_document_fetch") return "source.synthetic.in_memory_document";
  if (capabilityKindId === "tool.kind.fixture_corpus_lookup") return "source.synthetic.corpus_fixture";
  if (capabilityKindId === "tool.kind.fixture_command_dry_run") return "source.synthetic.command_dry_run";
  if (capabilityKindId === "tool.kind.fixture_patch_preview") return "source.synthetic.patch_preview";
  return sourceKinds[0] ?? "source.synthetic.fixture_evidence";
}

function materialsForCapability(capability: ToolCapability, fixtures: SyntheticToolFixtures): SyntheticSourceMaterial[] {
  if (capability.kindId === "tool.kind.fixture_file_read") return fixtures.files ?? [];
  if (capability.kindId === "tool.kind.fixture_repo_inspect") return fixtures.repositories ?? fixtures.projects ?? [];
  if (capability.kindId === "tool.kind.fixture_document_fetch") return fixtures.documents ?? [];
  if (capability.kindId === "tool.kind.fixture_corpus_lookup") return fixtures.corpus ?? [];
  if (capability.kindId === "tool.kind.fixture_project_read") return fixtures.projects ?? [];
  if (capability.kindId === "tool.kind.fixture_package_metadata_lookup") return fixtures.packageMetadata ?? [];
  if (capability.kindId === "tool.kind.fixture_command_dry_run") return fixtures.commandDryRuns ?? [];
  if (capability.kindId === "tool.kind.fixture_patch_preview") return fixtures.patchPreviews ?? [];
  return fixtures.evidence ?? [];
}

function planHasMatchingFixtureMaterial(plan: SourcePlan, capability: ToolCapability, fixtures: SyntheticToolFixtures): boolean {
  const materials = materialsForCapability(capability, fixtures);
  if (!materials.length) return false;
  const sourceKindIds = new Set(plan.candidateSourceDescriptors.map(item => item.sourceKindId));
  return materials.some(material => !sourceKindIds.size || sourceKindIds.has(material.sourceKindId));
}

function materialToRecord(material: SyntheticSourceMaterial, plan: SourcePlan, capability: ToolCapability, now: number): AcquiredRecord {
  const text = material.text;
  const sourceVersion = sourceVersionFor(material, now);
  const evidenceSpan = evidenceSpanFor(material, sourceVersion, now);
  const proofEvidence = material.proofEvidence ? {
    ...material.proofEvidence,
    id: material.proofEvidence.id ?? stableId("proof_evidence", { material: material.id, plan: plan.id }),
    forceClass: material.proofEvidence.forceClass ?? material.forceClass,
    sourceVersionId: material.proofEvidence.sourceVersionId ?? String(sourceVersion.sourceVersionId),
    evidenceSpanId: material.proofEvidence.evidenceSpanId ?? String(evidenceSpan.id)
  } satisfies ProofEvidenceRecord : undefined;
  return {
    id: stableId("acquired_record", { material: material.id, plan: plan.id, capability: capability.id }),
    recordKindId: material.recordKindId ?? recordKindForForce(material.forceClass),
    forceClass: material.forceClass,
    text,
    sourceVersionId: String(sourceVersion.sourceVersionId),
    evidenceSpanId: String(evidenceSpan.id),
    sourceVersion,
    evidenceSpan,
    proofEvidence,
    graphNodes: material.graphNodes ?? [],
    graphEdges: material.graphEdges ?? [],
    graphHyperedges: material.graphHyperedges ?? [],
    languagePrior: material.languagePrior,
    typedObservation: material.typedObservation,
    metadata: toJsonValue({ ...(objectRecord(material.metadata)), sourcePlanId: plan.id, toolCapabilityId: capability.id })
  };
}

function sourceVersionFor(material: SyntheticSourceMaterial, now: number): SourceVersion {
  const hash = contentHash(material.text);
  return {
    sourceId: stableId("source", { uri: material.uri }) as SourceId,
    sourceVersionId: stableId("source_version", { uri: material.uri, hash }) as SourceVersionId,
    namespace: "synthetic-fixture",
    canonicalUri: material.uri,
    contentHash: hash as ContentHash,
    mediaType: material.mediaType,
    observedAt: now,
    byteLength: byteLength(material.text),
    trust: 0.92,
    metadata: toJsonValue({ sourceKindId: material.sourceKindId, fixtureId: material.id })
  };
}

function evidenceSpanFor(material: SyntheticSourceMaterial, sourceVersion: SourceVersion, now: number): EvidenceSpan {
  const hash = contentHash(material.text) as ContentHash;
  const bytes = byteLength(material.text);
  return {
    id: stableId("evidence", { sourceVersionId: sourceVersion.sourceVersionId, hash, bytes }) as EvidenceId,
    sourceId: sourceVersion.sourceId,
    sourceVersionId: sourceVersion.sourceVersionId,
    chunkId: stableId("chunk", { sourceVersionId: sourceVersion.sourceVersionId, hash, bytes }) as ChunkId,
    contentHash: hash,
    mediaType: material.mediaType,
    byteStart: 0,
    byteEnd: bytes,
    charStart: 0,
    charEnd: material.text.length,
    text: material.text,
    textPreview: material.text.slice(0, 320),
    languageHints: {},
    scriptHints: {},
    trustVector: toJsonValue({ trust: 0.92, forceClass: material.forceClass }),
    provenance: toJsonValue({ uri: material.uri, sourceKindId: material.sourceKindId, fixtureId: material.id }),
    features: featureSet(material.text, 512),
    status: "promoted",
    alpha: 0.92,
    observedAt: now
  };
}

function acquisitionResult(input: { sourcePlanId: string; toolCapabilityId: string; records: AcquiredRecord[]; warnings: string[]; errors: string[]; costObserved: number; sideEffectsObserved: string[]; trace: JsonValue }): AcquisitionResult {
  const sourceVersions = input.records.flatMap(record => record.sourceVersion ? [record.sourceVersion] : []);
  const evidenceSpans = input.records.flatMap(record => record.evidenceSpan ? [record.evidenceSpan] : []);
  return {
    id: stableId("acquisition", { plan: input.sourcePlanId, capability: input.toolCapabilityId, records: input.records.map(record => record.id), errors: input.errors }),
    sourcePlanId: input.sourcePlanId,
    toolCapabilityId: input.toolCapabilityId,
    acquiredRecords: input.records,
    rawSourceRefs: sourceVersions.map(source => source.canonicalUri),
    sourceVersions,
    evidenceSpans,
    warnings: input.warnings,
    errors: input.errors,
    costObserved: input.costObserved,
    sideEffectsObserved: input.sideEffectsObserved,
    trace: toJsonValue({ source: "learning.tool.acquisition", ...objectRecord(input.trace) })
  };
}

function sourceSpanCheck(record: AcquiredRecord): { recordId: string; passed: boolean; reasonCode: string } {
  if (record.forceClass !== "direct_evidence") return { recordId: record.id, passed: true, reasonCode: "validation.source_span.not_required_for_prior" };
  const passed = Boolean(record.sourceVersionId && record.evidenceSpanId && record.sourceVersion && record.evidenceSpan);
  return { recordId: record.id, passed, reasonCode: passed ? "validation.source_span.bound" : "validation.reject.direct_evidence_missing_source_span" };
}

function typedObservationValid(observation: Observation): boolean {
  return Boolean(observation.id && observation.kind && observation.sourceVersionId && observation.evidenceIds.length);
}

function updatePlanFromRecords(records: readonly AcquiredRecord[], validation: ValidationResult, policy: LearningPolicy): LearningUpdatePlan {
  const direct = records.filter(record => record.forceClass === "direct_evidence");
  const priors = records.filter(record => isLearnedPrior(record.forceClass));
  const sourceVersions = uniqueBy(records.flatMap(record => record.sourceVersion ? [record.sourceVersion] : []), item => String(item.sourceVersionId));
  const evidence = uniqueBy(direct.flatMap(record => record.evidenceSpan ? [record.evidenceSpan] : []), item => String(item.id));
  const proofTraces = validation.proofAdmissibilityChecks.map(check => toJsonValue({ recordId: check.recordId, verdict: check.verdict, proofResult: check.proofResult }));
  return {
    id: stableId("learning_update", { validation: validation.id, records: records.map(record => record.id), policy: policy.promotionPolicyId }),
    evidenceRecordsToAdd: evidence,
    graphNodesToAdd: records.flatMap(record => record.graphNodes ?? []),
    graphEdgesToAdd: records.flatMap(record => record.graphEdges ?? []),
    graphHyperedgesToAdd: records.flatMap(record => record.graphHyperedges ?? []),
    languagePriorsToAdd: priors.flatMap(record => record.languagePrior ? [record.languagePrior] : record.text ? [toJsonValue({ recordId: record.id, forceClass: record.forceClass, text: record.text })] : []),
    typedObservationsToAdd: records.flatMap(record => record.typedObservation ? [record.typedObservation] : []),
    sourceVersionsToAdd: sourceVersions,
    proofTracesToAdd: proofTraces,
    eventsToAdd: records.map(record => toJsonValue({ typeId: "LearningPromoted", recordId: record.id, forceClass: record.forceClass })),
    trace: toJsonValue({ source: "learning.update_plan", directEvidence: direct.length, priors: priors.length, sourceVersions: sourceVersions.length })
  };
}

function proofAfterPromotion(claims: readonly ProofClaim[], existingEvidence: readonly ProofEvidenceRecord[], decisions: readonly LearningPromotionDecision[]): SemanticProofResult | undefined {
  if (!claims.length) return undefined;
  const promotedEvidence = decisions.flatMap(decision => decision.promotedRecords.flatMap(record => record.proofEvidence ? [record.proofEvidence] : []));
  if (!promotedEvidence.length) return undefined;
  const candidateEvidence = [...existingEvidence, ...promotedEvidence];
  return proveClaim({ claim: claims[0]!, candidateEvidence });
}

function continueDecisionFor(input: {
  gaps: readonly FieldGap[];
  sourcePlans: readonly SourcePlan[];
  acquisitionResults: readonly AcquisitionResult[];
  validationResults: readonly ValidationResult[];
  promotionDecisions: readonly LearningPromotionDecision[];
  proofAfterUpdate?: SemanticProofResult;
}): ContinueDecision {
  const contradictions = input.validationResults.flatMap(result => result.contradictionCandidates);
  const errors = input.acquisitionResults.flatMap(result => result.errors);
  const safePromotions = input.promotionDecisions.filter(decision => decision.safeToPromote);
  let decisionKindId = "continue.unsupported";
  if (input.proofAfterUpdate?.verdict === "certified") decisionKindId = "continue.answering";
  else if (contradictions.length || input.proofAfterUpdate?.verdict === "contradicted") decisionKindId = "continue.report_contradiction";
  else if (safePromotions.length) decisionKindId = "continue.answer_with_caveat";
  else if (!input.sourcePlans.length || errors.length) decisionKindId = "continue.insufficient_evidence";
  return {
    id: stableId("continue", { decisionKindId, proof: input.proofAfterUpdate?.verdict ?? null, promotions: safePromotions.map(item => item.id) }),
    decisionKindId,
    continueAnswering: decisionKindId === "continue.answering",
    askClarification: decisionKindId === "continue.clarification_needed",
    answerWithCaveat: decisionKindId === "continue.answer_with_caveat",
    deferDueToInsufficientEvidence: decisionKindId === "continue.insufficient_evidence",
    reportContradiction: decisionKindId === "continue.report_contradiction",
    reportUnsupported: decisionKindId === "continue.unsupported",
    safeToAssert: decisionKindId === "continue.answering",
    reasonCodes: [
      decisionKindId,
      ...input.gaps.map(gapItem => gapItem.gapKindId),
      ...errors
    ],
    proofAfterUpdate: input.proofAfterUpdate,
    trace: toJsonValue({ source: "learning.continue_decision", decisionKindId, promotions: safePromotions.length, contradictions: contradictions.length, errors })
  };
}

function hydrationRecord<TPayload>(recordTypeId: LearningRecordTypeId, recordId: string, destinationStoreId: string, payload: TPayload): LearningHydrationRecord<TPayload> {
  const diagnostics = hydrationDiagnostics(recordTypeId, recordId, payload);
  const payloadHash = hashText(canonicalStringify(payload));
  return {
    recordTypeId,
    recordId,
    validation: { valid: diagnostics.length === 0, diagnostics },
    idempotencyKey: stableId("learning_hydration", { recordTypeId, recordId, payloadHash }),
    destinationStoreId,
    inspectReplayVisibilityId: "inspect.replay.learning_loop",
    provenance: toJsonValue({ source: "learning-loop.hydration", recordTypeId }),
    payload,
    payloadHash
  };
}

function hydrationDiagnostics(recordTypeId: LearningRecordTypeId, recordId: string, payload: unknown): string[] {
  const diagnostics: string[] = [];
  if (!recordId) diagnostics.push(`learning.hydration.record_id:${recordTypeId}`);
  if (payload === null || payload === undefined) diagnostics.push(`learning.hydration.payload:${recordTypeId}`);
  const record = objectRecord(payload as JsonValue);
  if (record && "trace" in record && record.trace === undefined) diagnostics.push(`learning.hydration.trace:${recordTypeId}`);
  return diagnostics;
}

function uniqueCapabilities(plans: readonly SourcePlan[]): ToolCapability[] {
  const ids = [...new Set(plans.flatMap(plan => plan.requiredToolCapabilityIds))];
  return defaultSyntheticToolCapabilities().filter(capability => ids.includes(capability.id));
}

function gap(kindId: string, input: Partial<FieldGap>): FieldGap {
  const uncertainty = clamp01(input.uncertaintyScore ?? 0.4);
  const contradiction = clamp01(input.contradictionScore ?? 0);
  const staleness = clamp01(input.stalenessScore ?? 0);
  const utility = clamp01(input.expectedUtility ?? Math.max(uncertainty, contradiction, staleness));
  const cost = clamp01(input.acquisitionCostEstimate ?? 0.12);
  const risk = clamp01(input.riskScore ?? 0.12);
  const priority = clamp01(input.priority ?? utility + uncertainty * 0.16 + contradiction * 0.22 + staleness * 0.08 - cost * 0.12 - risk * 0.14);
  const body = {
    gapKindId: kindId,
    relatedConstructIds: input.relatedConstructIds ?? [],
    missingEvidenceObligations: input.missingEvidenceObligations ?? [],
    missingCapabilityIds: input.missingCapabilityIds ?? [],
    evidenceIds: input.evidenceIds ?? [],
    trace: input.trace ?? {}
  };
  return {
    id: input.id ?? stableId("gap", body),
    ...body,
    uncertaintyScore: uncertainty,
    contradictionScore: contradiction,
    stalenessScore: staleness,
    expectedUtility: utility,
    acquisitionCostEstimate: cost,
    riskScore: risk,
    priority,
    trace: toJsonValue({ source: "learning.gap", ...objectRecord(input.trace) })
  };
}

function gapFromLegacyGoal(goal: string, input: { model: ModelState; graph: GraphSlice; evidence: EvidenceSpan[]; languageProfiles: LanguageProfile[] }, index: number): FieldGap {
  const features = featureSet(goal, 256);
  const evidenceFeatures = input.evidence.flatMap(span => span.features.slice(0, 64));
  const graphFeatures = input.graph.nodes.flatMap(node => node.features.slice(0, 64));
  const evidenceCoverage = evidenceFeatures.length ? weightedJaccard(features, evidenceFeatures) : 0;
  const graphCoverage = graphFeatures.length ? weightedJaccard(features, graphFeatures) : 0;
  const languageCoverage = input.languageProfiles.length ? Math.min(1, input.languageProfiles.length / 12) : 0;
  const uncertainty = clamp01(1 - 0.48 * evidenceCoverage - 0.34 * graphCoverage - 0.18 * languageCoverage);
  return gap("gap.missing_direct_evidence", {
    id: stableId("gap", { goal, index }),
    missingEvidenceObligations: ["obligation.goal_coverage"],
    uncertaintyScore: uncertainty,
    expectedUtility: clamp01(0.36 + uncertainty * 0.48),
    trace: { goal, modelTrainingSteps: input.model.trainingSteps }
  });
}

function sameGap(left: FieldGap, right: FieldGap): boolean {
  return left.gapKindId === right.gapKindId &&
    stableId("gap_signature", { left: left.missingEvidenceObligations, evidence: left.evidenceIds }) === stableId("gap_signature", { left: right.missingEvidenceObligations, evidence: right.evidenceIds });
}

function dedupeGaps(gaps: readonly FieldGap[]): FieldGap[] {
  const out: FieldGap[] = [];
  for (const item of gaps) if (!out.some(existing => existing.id === item.id || sameGap(existing, item))) out.push(item);
  return out.sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id));
}

function importedPriorActivation(field: FieldState | undefined): number {
  if (!field?.ppfDiagnostics || typeof field.ppfDiagnostics !== "object" || Array.isArray(field.ppfDiagnostics)) return 0;
  const trace = objectRecord((field.ppfDiagnostics as Record<string, JsonValue>).importedPriorTrace);
  const active = trace.activePriorMass;
  if (typeof active === "number") return clamp01(active);
  return 0;
}

function staleEvidence(evidence: readonly EvidenceSpan[], now: number, staleAfterMs: number): EvidenceSpan[] {
  if (now <= 0) return [];
  return evidence.filter(span => now - span.observedAt > staleAfterMs);
}

function proofGateVerdictFromEntailment(entailment: SemanticEntailmentResult): SemanticProofEngineVerdict | undefined {
  const scores = objectRecord(entailment.proof.scores);
  const gate = objectRecord(scores.semanticProofEngine);
  const verdict = gate.verdict;
  return typeof verdict === "string" && isProofEngineVerdict(verdict) ? verdict : undefined;
}

function isProofEngineVerdict(value: string): value is SemanticProofEngineVerdict {
  return value === "certified" ||
    value === "insufficient_evidence" ||
    value === "contradicted" ||
    value === "unsupported_prior_only" ||
    value === "source_bound_only" ||
    value === "ambiguous";
}

function isLearnedPrior(forceClass: ProofForceClass): boolean {
  return forceClass === "learned_language_prior" || forceClass === "learned_concept_prior" || forceClass === "learned_program_prior";
}

function recordKindForForce(forceClass: ProofForceClass): string {
  if (forceClass === "direct_evidence") return "record.direct_evidence";
  if (isLearnedPrior(forceClass)) return "record.learned_prior";
  if (forceClass === "profile_excerpt_evidence") return "record.profile_excerpt";
  return "record.unsupported";
}

function promotionFocusPlan(evidence: readonly EvidenceSpan[]): Array<{ evidenceId: string; sourceVersionId: string; value: number; reason: string }> {
  return evidence.map(span => {
    const trust = objectRecord(span.trustVector);
    const value = clamp01(0.45 * span.alpha + 0.35 * numberOr(trust.trust, 0.5) + 0.2 * (span.status === "promoted" ? 1 : 0.4));
    return { evidenceId: String(span.id), sourceVersionId: String(span.sourceVersionId), value, reason: span.status === "promoted" ? "promotion.focus.already_promoted" : "promotion.focus.quarantined_candidate" };
  }).sort((a, b) => b.value - a.value);
}

function toLearningSourcePlan(plan: SourcePlan): LearningSourcePlan {
  const kind = plan.candidateSourceDescriptors[0]?.sourceKindId ?? "source.synthetic.fixture";
  const capabilityId = plan.requiredToolCapabilityIds[0] ?? "tool.fixture.evidence_lookup";
  const expectedValue = plan.evi;
  return {
    ...plan,
    kind,
    capabilityId,
    query: plan.candidateSourceDescriptors[0]?.locator ?? plan.id,
    expectedValue,
    taskProgress: clamp01(plan.expectedUtility),
    proofValue: clamp01(plan.expectedProofImprovement),
    cost: plan.costEstimate,
    risk: plan.riskEstimate,
    permissionPenalty: plan.sideEffectPenalty,
    utility: expectedValue,
    acquisition: {
      acquire: true,
      quarantine: true,
      extract: true,
      validate: true,
      promote: plan.riskEstimate <= 0.3 ? "after_validation" : "owner_review",
      graphUpdate: true
    },
    rationale: "learning.source_plan.synthetic_local"
  };
}

function groupPlansByNeed(plans: readonly LearningSourcePlan[]): Map<string, LearningSourcePlan[]> {
  const out = new Map<string, LearningSourcePlan[]>();
  for (const plan of plans) out.set(plan.learningNeedId, [...(out.get(plan.learningNeedId) ?? []), plan]);
  return out;
}

function mergeFixtures(left: SyntheticToolFixtures | undefined, right: SyntheticToolFixtures | undefined): SyntheticToolFixtures | undefined {
  if (!left) return right;
  if (!right) return left;
  return {
    files: [...(left.files ?? []), ...(right.files ?? [])],
    documents: [...(left.documents ?? []), ...(right.documents ?? [])],
    corpus: [...(left.corpus ?? []), ...(right.corpus ?? [])],
    repositories: [...(left.repositories ?? []), ...(right.repositories ?? [])],
    projects: [...(left.projects ?? []), ...(right.projects ?? [])],
    evidence: [...(left.evidence ?? []), ...(right.evidence ?? [])],
    packageMetadata: [...(left.packageMetadata ?? []), ...(right.packageMetadata ?? [])],
    commandDryRuns: [...(left.commandDryRuns ?? []), ...(right.commandDryRuns ?? [])],
    patchPreviews: [...(left.patchPreviews ?? []), ...(right.patchPreviews ?? [])]
  };
}

function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}

function objectRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

function numberOr(value: JsonValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function contentHash(text: string): string {
  return `sha256_${hashText(text)}`;
}

function hashText(text: string): string {
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ cp, 16777619);
    h2 = Math.imul(h2 + cp, 1099511627);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}

function stableId(prefix: string, payload: unknown): string {
  return `${prefix}_${hashText(canonicalStringify(payload)).slice(0, 24)}`;
}

function byteLength(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0;
    if (cp <= 0x7f) bytes += 1;
    else if (cp <= 0x7ff) bytes += 2;
    else if (cp <= 0xffff) bytes += 3;
    else bytes += 4;
  }
  return bytes;
}
