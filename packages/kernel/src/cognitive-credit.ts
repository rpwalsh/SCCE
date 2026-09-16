// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// One durable record per turn linking both credit chains end to end, keyed by the episode id every other
// persisted turn record already uses. Before this, calibration_observations carried a content-hashed
// candidate id (one value observed across 92 different turns), so no observation could be attributed to
// the turn that produced it, and 54 of the declared calibration ids had no observation at all.
import { CALIBRATION_IDS, CALIBRATION_SUBSYSTEM_IDS, calibrationObservationRecord, type CalibrationObservationRecord } from "./calibration-spine.js";
import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";
import type { JsonValue } from "./types.js";

export const COGNITIVE_CREDIT_SCHEMA = "scce.cognitive_credit.record.v1";

/** The two chains named in the directive, as ids so a query never parses prose. */
export const CREDIT_CHAIN_IDS = {
  /** surface -> selected candidate -> proposal -> operator sequence -> requirement inference -> activations */
  surfaceToActivation: "credit.chain.surface_to_activation",
  /** answer fact -> proof -> relation -> activated region -> retrieval decision */
  factToRetrieval: "credit.chain.fact_to_retrieval"
} as const;

export const CREDIT_STAGE_IDS = {
  surface: "stage.surface",
  candidate: "stage.candidate",
  judge: "stage.judge",
  proposal: "stage.proposal",
  operator: "stage.operator",
  requirement: "stage.requirement",
  activation: "stage.activation",
  answerFact: "stage.answer_fact",
  proof: "stage.proof",
  relation: "stage.relation",
  activatedRegion: "stage.activated_region",
  retrieval: "stage.retrieval"
} as const;

export type CreditStageId = typeof CREDIT_STAGE_IDS[keyof typeof CREDIT_STAGE_IDS];

/** Where an outcome label came from. `absent` is recorded, never guessed around. */
export const CREDIT_OUTCOME_SOURCE_IDS = {
  runtimeSignal: "outcome.source.runtime_signal",
  graded: "outcome.source.graded",
  userFeedback: "outcome.source.user_feedback",
  absent: "outcome.source.absent"
} as const;

export type CreditOutcomeSourceId = typeof CREDIT_OUTCOME_SOURCE_IDS[keyof typeof CREDIT_OUTCOME_SOURCE_IDS];

export const CREDIT_OUTCOME_LABEL_IDS = {
  positive: "outcome.positive",
  negative: "outcome.negative",
  unknown: "outcome.unknown"
} as const;

/** Calibration id and subsystem each stage's deciding quantity is an observation of. */
export const CREDIT_STAGE_CALIBRATION: Readonly<Record<CreditStageId, { calibrationId: string; subsystemId: string; chainId: string }>> = Object.freeze({
  [CREDIT_STAGE_IDS.surface]: { calibrationId: CALIBRATION_IDS.mouthSurfaceFit, subsystemId: CALIBRATION_SUBSYSTEM_IDS.mouth, chainId: CREDIT_CHAIN_IDS.surfaceToActivation },
  [CREDIT_STAGE_IDS.candidate]: { calibrationId: CALIBRATION_IDS.candidateMass, subsystemId: CALIBRATION_SUBSYSTEM_IDS.candidate, chainId: CREDIT_CHAIN_IDS.surfaceToActivation },
  [CREDIT_STAGE_IDS.judge]: { calibrationId: CALIBRATION_IDS.judgeRequirementWeights, subsystemId: CALIBRATION_SUBSYSTEM_IDS.candidate, chainId: CREDIT_CHAIN_IDS.surfaceToActivation },
  [CREDIT_STAGE_IDS.proposal]: { calibrationId: CALIBRATION_IDS.proposalSelection, subsystemId: CALIBRATION_SUBSYSTEM_IDS.planner, chainId: CREDIT_CHAIN_IDS.surfaceToActivation },
  [CREDIT_STAGE_IDS.operator]: { calibrationId: CALIBRATION_IDS.operatorOutcome, subsystemId: CALIBRATION_SUBSYSTEM_IDS.operator, chainId: CREDIT_CHAIN_IDS.surfaceToActivation },
  [CREDIT_STAGE_IDS.requirement]: { calibrationId: CALIBRATION_IDS.requirementFieldInference, subsystemId: CALIBRATION_SUBSYSTEM_IDS.requirement, chainId: CREDIT_CHAIN_IDS.surfaceToActivation },
  [CREDIT_STAGE_IDS.activation]: { calibrationId: CALIBRATION_IDS.requirementActivationSupport, subsystemId: CALIBRATION_SUBSYSTEM_IDS.requirement, chainId: CREDIT_CHAIN_IDS.surfaceToActivation },
  [CREDIT_STAGE_IDS.answerFact]: { calibrationId: CALIBRATION_IDS.answerFactBinding, subsystemId: CALIBRATION_SUBSYSTEM_IDS.answer, chainId: CREDIT_CHAIN_IDS.factToRetrieval },
  [CREDIT_STAGE_IDS.proof]: { calibrationId: CALIBRATION_IDS.proofSupport, subsystemId: CALIBRATION_SUBSYSTEM_IDS.proof, chainId: CREDIT_CHAIN_IDS.factToRetrieval },
  [CREDIT_STAGE_IDS.relation]: { calibrationId: CALIBRATION_IDS.relationComposition, subsystemId: CALIBRATION_SUBSYSTEM_IDS.relation, chainId: CREDIT_CHAIN_IDS.factToRetrieval },
  [CREDIT_STAGE_IDS.activatedRegion]: { calibrationId: CALIBRATION_IDS.alphaVisibleBondedStructural, subsystemId: CALIBRATION_SUBSYSTEM_IDS.alpha, chainId: CREDIT_CHAIN_IDS.factToRetrieval },
  [CREDIT_STAGE_IDS.retrieval]: { calibrationId: CALIBRATION_IDS.retrievalHybridRecall, subsystemId: CALIBRATION_SUBSYSTEM_IDS.retrieval, chainId: CREDIT_CHAIN_IDS.factToRetrieval }
});

export interface CreditStageFrame {
  stageId: CreditStageId;
  chainId: string;
  calibrationId: string;
  subsystemId: string;
  /** The one number this stage decided on, unit interval, so a policy fit has a target without parsing metadata. */
  decidingQuantity: number;
  /** Every quantity this stage weighed, named. Data, never prose. */
  decidingQuantities: Record<string, number>;
  /** What this stage produced. */
  ids: string[];
  /** What the next stage down the chain handed it -- the backward credit link. */
  upstreamIds: string[];
  /** True when the turn genuinely reached this stage; a frame is recorded either way so a gap is visible. */
  reached: boolean;
}

/** Runtime-observed signals. Each is read off the turn; none is inferred and none stands in for user feedback. */
export interface CreditRuntimeSignals {
  spoke: boolean;
  withheld: boolean;
  replanned: boolean;
  revised: boolean;
  corrected: boolean;
  contradictionMass: number;
  /** Denominator for the discharge ratio; without it `unresolvedObligationCount` cannot be read as a quality. */
  obligationCount: number;
  unresolvedObligationCount: number;
  budgetExceededCount: number;
  evidenceCount: number;
}

export interface CreditGradedVerdict {
  suiteId: string;
  itemId: string;
  verdict: string;
  declined: boolean;
}

export interface CognitiveCreditOutcome {
  label: string;
  source: CreditOutcomeSourceId;
  /** False whenever the label came from the runtime watching itself rather than from an external judgement. */
  supervised: boolean;
  /** Unit-interval quality the turn measured about itself; null when it measured none. Never a class. */
  reward: number | null;
  /** Every measured term that entered the reward, named, so a fit can weigh them instead of the mean. */
  rewardTerms: Record<string, number>;
  signals: CreditRuntimeSignals;
  graded: CreditGradedVerdict | null;
}

export interface CognitiveCreditRecord {
  schema: typeof COGNITIVE_CREDIT_SCHEMA;
  id: string;
  episodeId: string;
  conversationId: string;
  taskClass: string;
  requestedAuthority: string;
  createdAt: number;
  outcome: CognitiveCreditOutcome;
  stages: CreditStageFrame[];
}

const rec = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {});
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const ids = (values: unknown[], limit = 24): string[] => values.map(str).filter(Boolean).slice(0, limit);

function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** Structural view of a TurnResult: the credit builder reads ids and numbers, never runtime classes. */
export interface CognitiveCreditTurnView {
  episodeId: string;
  conversationId: string;
  taskClass: string;
  requestedAuthority?: string;
  answer: string;
  requirementField?: JsonValue;
  operatorActivations?: JsonValue;
  cognitiveProposals?: JsonValue;
  selectedCandidate?: JsonValue;
  judge?: JsonValue;
  mouth?: JsonValue;
  entailment?: JsonValue;
  field?: JsonValue;
  retrievalRoles?: JsonValue;
  evidenceIds?: readonly string[];
  withheld?: JsonValue;
  runtimeMotion?: JsonValue;
  answerRevision?: JsonValue;
  corrections?: JsonValue;
  timing?: JsonValue;
  createdAt: number;
}

function runtimeSignals(view: CognitiveCreditTurnView): CreditRuntimeSignals {
  const entailment = rec(view.entailment);
  const candidate = rec(view.selectedCandidate);
  const scores = rec(candidate.scores);
  const obligations = arr(entailment.obligations);
  const motion = rec(view.runtimeMotion);
  return {
    spoke: view.answer.trim().length > 0,
    withheld: Boolean(view.withheld),
    // A motion that ran and was refused, disabled or came back empty is not a replan; only added evidence is.
    replanned: str(motion.status) === "hydrated" && num(motion.ingestedEvidenceCount) > 0,
    revised: Boolean(view.answerRevision),
    corrected: arr(rec(view.corrections).applied).length > 0,
    contradictionMass: clamp01(num(scores.contradiction) || num(entailment.contradiction)),
    obligationCount: obligations.length,
    unresolvedObligationCount: obligations.filter(row => str(rec(row).status) !== "satisfied").length,
    budgetExceededCount: arr(rec(view.timing).budgetExceeded).length,
    evidenceCount: (view.evidenceIds ?? []).length
  };
}

/**
 * Unit-interval qualities the turn already measured about itself. Unweighted on purpose: each measured term
 * counts once, because any weighting here would be a hand-set coefficient. Only terms with a real denominator
 * qualify -- `budgetExceededCount` and `evidenceCount` have none and would need an invented scale.
 */
export function runtimeRewardTerms(signals: CreditRuntimeSignals): Record<string, number> {
  if (signals.obligationCount <= 0) return {};
  return {
    // The proof engine scores its own obligations as satisfied/required; `underdetermined` lowers that ratio
    // rather than voiding the turn, so the reward reads them the same way instead of demanding perfection.
    obligationDischarge: clamp01((signals.obligationCount - signals.unresolvedObligationCount) / signals.obligationCount),
    nonContradiction: clamp01(1 - signals.contradictionMass)
  };
}

/**
 * What the runtime can honestly say by watching itself is a measured quality, never a class: one turn has no
 * population to split against, and splitting it here would be a hand-picked cut. The label therefore stays
 * `unknown` until a reader with the episodes in hand classifies them (`creditRewardClasses`), or a grader
 * speaks (`withGradedOutcome`).
 */
function runtimeOutcome(signals: CreditRuntimeSignals): CognitiveCreditOutcome {
  const rewardTerms = signals.spoke && !signals.withheld ? runtimeRewardTerms(signals) : {};
  const values = Object.values(rewardTerms);
  const measured = signals.spoke && !signals.withheld ? (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null) : 0;
  return {
    label: CREDIT_OUTCOME_LABEL_IDS.unknown,
    source: measured === null ? CREDIT_OUTCOME_SOURCE_IDS.absent : CREDIT_OUTCOME_SOURCE_IDS.runtimeSignal,
    supervised: false,
    reward: measured === null ? null : clamp01(measured),
    rewardTerms,
    signals,
    graded: null
  };
}

function frame(
  stageId: CreditStageId,
  reached: boolean,
  decidingQuantity: number,
  decidingQuantities: Record<string, number>,
  stageIds: string[],
  upstreamIds: string[]
): CreditStageFrame {
  const binding = CREDIT_STAGE_CALIBRATION[stageId];
  return {
    stageId,
    chainId: binding.chainId,
    calibrationId: binding.calibrationId,
    subsystemId: binding.subsystemId,
    decidingQuantity: clamp01(decidingQuantity),
    decidingQuantities,
    ids: stageIds,
    upstreamIds,
    reached
  };
}

/** Pure: builds the whole chain from what the turn already computed. No IO, no re-derivation, no extra read. */
export function buildCognitiveCreditRecord(view: CognitiveCreditTurnView): CognitiveCreditRecord {
  const requirement = rec(view.requirementField);
  const activations = arr(view.operatorActivations).map(rec);
  const activeOperators = activations.filter(row => row.active === true);
  const proposals = arr(view.cognitiveProposals).map(rec);
  const candidate = rec(view.selectedCandidate);
  const candidateScores = rec(candidate.scores);
  const judge = rec(view.judge);
  const mouthTrace = rec(rec(rec(view.mouth).trace).selected);
  const entailment = rec(view.entailment);
  const field = rec(view.field);
  const active = arr(field.active).map(rec);
  const roles = arr(view.retrievalRoles).map(rec);
  const proof = rec(entailment.proof);
  const mappings = arr(entailment.mappings).map(rec);
  const transforms = arr(entailment.transforms).map(rec);
  const evidenceIds = [...(view.evidenceIds ?? [])];

  const proposalId = str(candidate.proposalId);
  const selectedProposal = proposals.find(row => str(row.id) === proposalId) ?? proposals[0] ?? {};
  const proposalQuality = rec(rec(selectedProposal).quality);
  const activationsUsed = arr(requirement.activationsUsed).map(rec);
  const activatedIds = [
    ...ids(arr(requirement.activatedFrameIds)),
    ...ids(arr(requirement.activatedPatternIds)),
    ...ids(arr(requirement.activatedPhraseUnitIds)),
    ...ids(arr(requirement.activatedDialogueMoveIds)),
    ...ids(arr(requirement.activatedConstructIds))
  ];
  const requirementDimensions: Record<string, number> = {};
  for (const [key, value] of Object.entries(requirement)) {
    if (typeof value === "number" && Number.isFinite(value)) requirementDimensions[key] = value;
  }
  const activeMean = activeOperators.length
    ? activeOperators.reduce((sum, row) => sum + num(row.activation), 0) / activeOperators.length
    : 0;
  const regionMass = active.length ? active.reduce((sum, row) => sum + num(row.activation), 0) / active.length : 0;
  const roleMean = roles.length ? roles.reduce((sum, row) => sum + num(row.score), 0) / roles.length : 0;
  const boundRelations = mappings.filter(row => str(rec(row).status ?? row.status) !== "missing");

  const stages: CreditStageFrame[] = [
    frame(CREDIT_STAGE_IDS.surface, view.answer.trim().length > 0,
      num(candidateScores.realizability),
      { answerChars: view.answer.length, evidenceRefs: evidenceIds.length, realizability: num(candidateScores.realizability), faithfulness: num(candidateScores.faithfulness) },
      ids([mouthTrace.surfaceRealizationId ?? mouthTrace.id]), ids([candidate.id])),
    frame(CREDIT_STAGE_IDS.candidate, Boolean(candidate.id),
      num(candidateScores.support),
      { support: num(candidateScores.support), contradiction: num(candidateScores.contradiction), evidenceCoverage: num(candidateScores.evidenceCoverage), alphaPressure: num(candidateScores.alphaPressure), novelty: num(candidateScores.novelty) },
      ids([candidate.id]), ids([proposalId])),
    frame(CREDIT_STAGE_IDS.judge, arr(judge.rows).length > 0,
      num(rec(arr(judge.rows).map(rec).find(row => str(row.candidateId) === str(candidate.id)) ?? arr(judge.rows).map(rec)[0]).score),
      Object.fromEntries(Object.entries(rec(candidate.quality)).filter(([, value]) => typeof value === "number") as [string, number][]),
      ids([candidate.id]), ids(proposals.map(row => row.id))),
    frame(CREDIT_STAGE_IDS.proposal, proposals.length > 0,
      num(proposalQuality.score) || num(rec(proposalQuality.reasoning).score),
      { proposals: proposals.length, mmr: num(proposalQuality.mmr), diversity: num(proposalQuality.diversity), satisfied: arr(rec(selectedProposal).satisfiedRequirementIds).length, missed: arr(rec(selectedProposal).missedRequirementIds).length },
      ids([proposalId || rec(selectedProposal).id]), ids(activeOperators.map(row => row.operatorId))),
    frame(CREDIT_STAGE_IDS.operator, activeOperators.length > 0,
      activeMean,
      { active: activeOperators.length, considered: activations.length, meanActivation: activeMean, meanRequirementSupport: activeOperators.length ? activeOperators.reduce((sum, row) => sum + num(rec(row.support).requirement), 0) / activeOperators.length : 0, meanOutcomeSupport: activeOperators.length ? activeOperators.reduce((sum, row) => sum + num(rec(row.support).outcome), 0) / activeOperators.length : 0 },
      ids(activeOperators.map(row => row.operatorId)), ids(activeOperators.flatMap(row => arr(row.contributingRequirementDimensions)))),
    frame(CREDIT_STAGE_IDS.requirement, Object.keys(requirementDimensions).length > 0,
      num(requirement.confidence),
      requirementDimensions,
      ids(arr(requirement.requiredFeatures).map(row => rec(row).id)), activatedIds),
    frame(CREDIT_STAGE_IDS.activation, activatedIds.length > 0 || activationsUsed.length > 0,
      activationsUsed.length ? clamp01(activationsUsed.reduce((sum, row) => sum + num(row.weight), 0) / activationsUsed.length) : (activatedIds.length ? 1 : 0),
      { activated: activatedIds.length, used: activationsUsed.length },
      activatedIds, []),

    frame(CREDIT_STAGE_IDS.answerFact, Boolean(rec(entailment.claim).id),
      num(entailment.faithfulnessLcb) || num(entailment.support),
      { support: num(entailment.support), contradiction: num(entailment.contradiction), faithfulnessLcb: num(entailment.faithfulnessLcb), confidence: num(entailment.confidence) },
      ids([rec(entailment.claim).id]), ids([proof.id])),
    frame(CREDIT_STAGE_IDS.proof, Boolean(proof.id),
      num(rec(entailment.scores).support) || num(entailment.support),
      { obligations: arr(entailment.obligations).length, counterexamples: arr(entailment.counterexamples).length, missing: arr(entailment.missing).length, transforms: transforms.length },
      ids([proof.id]), ids(boundRelations.map(row => rec(row).id ?? rec(row).relationId))),
    frame(CREDIT_STAGE_IDS.relation, mappings.length > 0,
      mappings.length ? boundRelations.length / mappings.length : 0,
      { mappings: mappings.length, bound: boundRelations.length, transforms: transforms.length },
      ids(mappings.map(row => rec(row).id ?? rec(row).relationId)), ids(active.map(row => row.nodeId))),
    frame(CREDIT_STAGE_IDS.activatedRegion, active.length > 0,
      regionMass,
      { activeNodes: active.length, seeds: arr(field.seeds).length, meanActivation: regionMass, ppfNodes: arr(field.ppf).length },
      ids(active.map(row => row.nodeId)), ids(roles.map(row => row.evidenceId))),
    frame(CREDIT_STAGE_IDS.retrieval, roles.length > 0 || evidenceIds.length > 0,
      roleMean || (evidenceIds.length ? 1 : 0),
      { roleTraces: roles.length, evidence: evidenceIds.length, meanRoleScore: roleMean },
      ids(roles.map(row => row.evidenceId).concat(evidenceIds)), [])
  ];

  const outcome = runtimeOutcome(runtimeSignals(view));
  return {
    schema: COGNITIVE_CREDIT_SCHEMA,
    id: `cognitive.credit.${hashText(view.episodeId)}`,
    episodeId: view.episodeId,
    conversationId: view.conversationId,
    taskClass: view.taskClass,
    requestedAuthority: view.requestedAuthority ?? "",
    createdAt: view.createdAt,
    outcome,
    stages
  };
}

/** Re-stamps a record with an external grader's verdict. The runtime never produces this label itself. */
export function withGradedOutcome(record: CognitiveCreditRecord, graded: CreditGradedVerdict): CognitiveCreditRecord {
  return {
    ...record,
    outcome: {
      label: graded.verdict === "correct" || graded.verdict === "declined" ? CREDIT_OUTCOME_LABEL_IDS.positive : CREDIT_OUTCOME_LABEL_IDS.negative,
      source: CREDIT_OUTCOME_SOURCE_IDS.graded,
      supervised: true,
      reward: record.outcome.reward,
      rewardTerms: record.outcome.rewardTerms,
      signals: record.outcome.signals,
      graded
    }
  };
}

/** The record itself, as one observation row so it survives a restart in the table every fit already reads. */
export function cognitiveCreditObservation(record: CognitiveCreditRecord): CalibrationObservationRecord {
  return calibrationObservationRecord({
    calibrationId: CALIBRATION_IDS.turnCognitiveCredit,
    subsystemId: CALIBRATION_SUBSYSTEM_IDS.turn,
    taskClass: record.taskClass,
    rawScore: record.stages.filter(stage => stage.reached).length / record.stages.length,
    outcome: record.outcome.label === CREDIT_OUTCOME_LABEL_IDS.positive,
    finalOutcome: record.outcome.label,
    sourceRecordId: record.episodeId,
    sourceTraceId: record.episodeId,
    idSeed: canonicalStringify({ credit: record.id, source: record.outcome.source }),
    metadata: toJsonValue(record as unknown as JsonValue),
    createdAt: record.createdAt
  });
}

/** One row per stage, keyed by the episode id, so "given a stage and an outcome" is an indexed query. */
export function cognitiveCreditStageObservations(record: CognitiveCreditRecord): CalibrationObservationRecord[] {
  return record.stages.map(stage => calibrationObservationRecord({
    calibrationId: stage.calibrationId,
    subsystemId: stage.subsystemId,
    taskClass: record.taskClass,
    rawScore: stage.decidingQuantity,
    outcome: record.outcome.label === CREDIT_OUTCOME_LABEL_IDS.positive,
    finalOutcome: record.outcome.label,
    sourceRecordId: record.episodeId,
    sourceTraceId: record.episodeId,
    idSeed: canonicalStringify({ credit: record.id, stage: stage.stageId, source: record.outcome.source }),
    metadata: toJsonValue({
      schema: "scce.cognitive_credit.stage_observation.v1",
      creditRecordId: record.id,
      episodeId: record.episodeId,
      conversationId: record.conversationId,
      stageId: stage.stageId,
      chainId: stage.chainId,
      reached: stage.reached,
      outcomeSource: record.outcome.source,
      supervised: record.outcome.supervised,
      reward: record.outcome.reward,
      rewardTerms: record.outcome.rewardTerms,
      gradedVerdict: record.outcome.graded?.verdict ?? null,
      ids: stage.ids,
      upstreamIds: stage.upstreamIds,
      decidingQuantities: stage.decidingQuantities,
      signals: record.outcome.signals as unknown as JsonValue
    }),
    createdAt: record.createdAt
  }));
}

/** The record plus its per-stage rows, in the order a single multi-row insert should write them. */
export function cognitiveCreditObservations(record: CognitiveCreditRecord): CalibrationObservationRecord[] {
  return [cognitiveCreditObservation(record), ...cognitiveCreditStageObservations(record)];
}
