import type { Capability, CapabilityCallId, CapabilityPlan, Clock, EpisodeId, EvidenceSpan, FieldState, Hasher, JsonValue, PolicyProfile } from "./types.js";
import { clamp01, createClock, createHasher, featureSet, mean, toJsonValue, weightedJaccard } from "./primitives.js";
import type { FunctionalSelectionGate } from "./functional-cognition.js";

export type ToolIntentKind =
  | "observe"
  | "search"
  | "retrieve"
  | "extract"
  | "analyze"
  | "generate"
  | "edit"
  | "execute"
  | "communicate"
  | "schedule"
  | "purchase"
  | "publish"
  | "repair";

export type ApprovalMode = "not_required" | "explicit" | "temporary_operator_grant" | "blocked_by_policy";
export type CapabilityPhase = "read" | "prepare" | "commit";

const ACTION_PREPARE_COMMITMENT_THRESHOLD = 0.55;
const PREPARED_ACTION_KINDS = new Set<ToolIntentKind>(["edit", "execute", "communicate", "schedule", "purchase", "publish"]);

export interface ToolObjective {
  id: string;
  kind: ToolIntentKind;
  label: string;
  features: string[];
  requiredEvidence: number;
  mutationPressure: number;
  networkPressure: number;
  privacyPressure: number;
  communicationPressure: number;
  codePressure: number;
  urgency: number;
  expectedValue: number;
}

export interface CapabilityScore {
  capabilityId: string;
  objectiveId: string;
  phase: CapabilityPhase;
  fit: number;
  evi: number;
  risk: number;
  utility: number;
  reversible: boolean;
  configured: boolean;
  approvalMode: ApprovalMode;
  reasons: string[];
}

export interface ApprovalControl {
  id: string;
  planId: CapabilityCallId;
  mode: ApprovalMode;
  title: string;
  body: string;
  buttons: Array<{ id: "approve" | "deny" | "temporary_operator_grant"; label: string; consequence: string }>;
  operatorGrantEligible: boolean;
  risk: number;
  expiresAt?: number;
}

export interface ToolCognitionPlan {
  id: string;
  episodeId: EpisodeId;
  objectives: ToolObjective[];
  scores: CapabilityScore[];
  capabilityPlans: CapabilityPlan[];
  approvals: ApprovalControl[];
  ledger: Array<{ id: string; t: number; event: string; payload: JsonValue }>;
  policyAudit: JsonValue;
  residualNeeds: Array<{ objectiveId: string; reason: string; connectorHint?: string; evidenceValue: number }>;
  session: {
    operatorGrant: boolean;
    operatorGrantUntil?: number;
    maxToolCalls: number;
    remainingToolCalls: number;
    maxNetworkRequests: number;
    remainingNetworkRequests: number;
  };
}

export interface ToolOutcomeObservation {
  planId: CapabilityCallId;
  status: "succeeded" | "failed" | "rolled_back";
  durationMs: number;
  resultSummary: string;
  evidenceProduced: number;
  artifactsProduced: number;
  errorClass?: string;
  spendCents?: number;
}

export interface ToolLearningSignal {
  planId: CapabilityCallId;
  objectiveId?: string;
  utilityDelta: number;
  riskDelta: number;
  connectorReliability: number;
  retainAsPattern: boolean;
  notes: string[];
}

export function createAutonomousToolCognition(options: { hasher?: Hasher; clock?: Clock; now?: () => number } = {}) {
  const hasher = options.hasher ?? createHasher();
  const clock = options.clock ?? createClock();
  const now = options.now ?? (() => clock.now());

  return {
    analyze(input: { request: string; evidence?: EvidenceSpan[]; field?: FieldState; actionCommitment?: number }): ToolObjective[] {
      return analyzeObjectives(input.request, input.evidence ?? [], input.field, hasher, input.actionCommitment);
    },

    plan(input: {
      episodeId: EpisodeId;
      request: string;
      capabilities: Capability[];
      policy: PolicyProfile;
      evidence?: EvidenceSpan[];
      field?: FieldState;
      actionCommitment?: number;
      temporaryOperatorGrant?: { enabled: boolean; until?: number };
      functionalGate?: FunctionalSelectionGate;
    }): ToolCognitionPlan {
      const t = now();
      const actionCommitment = clamp01(input.actionCommitment ?? 0);
      const objectives = analyzeObjectives(input.request, input.evidence ?? [], input.field, hasher, actionCommitment);
      const operatorGrant = Boolean(input.temporaryOperatorGrant?.enabled && (!input.temporaryOperatorGrant.until || input.temporaryOperatorGrant.until > t));
      const scored = scoreCapabilities({ objectives, capabilities: input.capabilities, policy: input.policy, operatorGrant, now: t });
      const selectedBeforeFunctionalGate = selectCapabilityScores(scored, input.policy, objectives, actionCommitment);
      const selected = selectedBeforeFunctionalGate.filter(score => functionalCapabilityAdmissible(score, input.functionalGate));
      const capabilityPlans = materializePlans({ selected, objectives, episodeId: input.episodeId, request: input.request, policy: input.policy, operatorGrant, hasher, t });
      const approvals = buildApprovalControls(capabilityPlans, selected, operatorGrant, t);
      const residualNeeds = residualNeedsFor(objectives, selected, input.capabilities);
      const networkPlans = capabilityPlans.filter(plan => {
        const risk = plan.riskVector as { network?: boolean };
        return risk.network;
      }).length;
      return {
        id: `tool_cognition_${hasher.digestHex(JSON.stringify({ episodeId: input.episodeId, objectives: objectives.map(o => o.id), selected: selected.map(s => s.capabilityId) })).slice(0, 32)}`,
        episodeId: input.episodeId,
        objectives,
        scores: scored,
        capabilityPlans,
        approvals,
        ledger: [
          { id: `ledger_${hasher.digestHex(`objectives:${input.request}`).slice(0, 18)}`, t, event: "objectives_analyzed", payload: toJsonValue({ objectives: objectives.map(o => ({ id: o.id, kind: o.kind, expectedValue: o.expectedValue })) }) },
          { id: `ledger_${hasher.digestHex(`selected:${selected.map(s => s.capabilityId).join("|")}`).slice(0, 18)}`, t, event: "capabilities_selected", payload: toJsonValue({ selected }) },
          { id: `ledger_${hasher.digestHex(`approval:${approvals.map(a => a.id).join("|")}`).slice(0, 18)}`, t, event: "approvals_prepared", payload: toJsonValue({ approvalIds: approvals.map(a => a.id), operatorGrant }) }
        ],
        policyAudit: toJsonValue({
          ...policyAudit(input.policy, selected, capabilityPlans, approvals, actionCommitment),
          functionalGate: input.functionalGate ?? null,
          functionalGateRejected: selectedBeforeFunctionalGate
            .filter(score => !selected.includes(score))
            .map(score => ({ capabilityId: score.capabilityId, objectiveId: score.objectiveId, phase: score.phase }))
        }),
        residualNeeds,
        session: {
          operatorGrant,
          operatorGrantUntil: input.temporaryOperatorGrant?.until,
          maxToolCalls: input.policy.maxToolCalls,
          remainingToolCalls: Math.max(0, input.policy.maxToolCalls - capabilityPlans.length),
          maxNetworkRequests: input.policy.maxNetworkRequests,
          remainingNetworkRequests: Math.max(0, input.policy.maxNetworkRequests - networkPlans)
        }
      };
    },

    learnFromOutcome(input: { plan: ToolCognitionPlan; outcomes: ToolOutcomeObservation[] }): ToolLearningSignal[] {
      return input.outcomes.map(outcome => learningSignalFor(input.plan, outcome));
    }
  };
}

function functionalCapabilityAdmissible(
  score: CapabilityScore,
  gate: FunctionalSelectionGate | undefined
): boolean {
  if (!gate) return false;
  if (!gate.gov || !gate.fc) return false;
  if (score.phase === "read") return true;
  return gate.efc && Boolean(gate.selectedGoalId);
}

function analyzeObjectives(request: string, evidence: readonly EvidenceSpan[], field: FieldState | undefined, hasher: Hasher, actionCommitment = 0): ToolObjective[] {
  const features = featureSet(request, 512);
  const evidenceMass = evidence.length ? mean(evidence.map(span => clamp01(span.alpha))) : 0;
  const fieldMass = field ? mean([...field.ppf.map(item => item.mass), ...field.active.map(item => item.activation)].slice(0, 512)) : 0;
  const surfaces = field?.alphaTrace.surfaces;
  const riskSurface = surfaces ? clamp01(0.35 * surfaces.risk + 0.25 * surfaces.contradiction + 0.2 * surfaces.drift + 0.2 * (1 - surfaces.bond)) : 0.35;
  const operations = operationPressures(request, features, actionCommitment);
  const objectives: ToolObjective[] = [];
  const baseExpected = clamp01(0.25 + 0.45 * (1 - evidenceMass) + 0.2 * (1 - fieldMass) + 0.1 * riskSurface);
  const add = (kind: ToolIntentKind, pressure: number, label: string, patch: Partial<ToolObjective> = {}) => {
    if (pressure <= 0.08) return;
    const id = `objective_${hasher.digestHex(`${kind}:${label}:${features.slice(0, 96).join("|")}`).slice(0, 24)}`;
    objectives.push({
      id,
      kind,
      label,
      features,
      requiredEvidence: clamp01(patch.requiredEvidence ?? (1 - evidenceMass) * pressure),
      mutationPressure: clamp01(patch.mutationPressure ?? operations.mutation * pressure),
      networkPressure: clamp01(patch.networkPressure ?? operations.network * pressure),
      privacyPressure: clamp01(patch.privacyPressure ?? operations.privacy * pressure),
      communicationPressure: clamp01(patch.communicationPressure ?? operations.communication * pressure),
      codePressure: clamp01(patch.codePressure ?? operations.code * pressure),
      urgency: clamp01(patch.urgency ?? operations.urgency),
      expectedValue: clamp01((patch.expectedValue ?? baseExpected) * (0.55 + 0.45 * pressure))
    });
  };

  add("observe", Math.max(0.18, 1 - evidenceMass), "inspect available local evidence", { mutationPressure: 0, networkPressure: 0, expectedValue: clamp01(baseExpected + 0.1) });
  add("search", operations.network * Math.max(operations.search, 1 - evidenceMass), "acquire external evidence through configured search providers", { mutationPressure: 0, requiredEvidence: 0.9, networkPressure: operations.network });
  add("retrieve", operations.retrieve, "retrieve referenced resources and source versions", { mutationPressure: 0, requiredEvidence: 0.75 });
  add("extract", operations.extract, "extract structured content from documents and media", { mutationPressure: 0, requiredEvidence: 0.7 });
  add("analyze", operations.analysis, "run bounded analysis over graph and source material", { mutationPressure: 0, networkPressure: 0 });
  add("generate", operations.generate, "prepare generated artifact content", { mutationPressure: 0.15 * operations.generate, codePressure: operations.code });
  add("edit", operations.edit, "prepare filesystem edits behind approval", { mutationPressure: operations.mutation, codePressure: operations.code });
  add("execute", operations.execute, "execute a local command or verification step behind approval", { mutationPressure: Math.max(0.25, operations.mutation, actionCommitment), codePressure: operations.code });
  add("communicate", operations.communication, "prepare outbound communication through a configured connector", { mutationPressure: operations.communication, communicationPressure: operations.communication, privacyPressure: Math.max(operations.privacy, 0.55) });
  add("schedule", operations.schedule, "prepare calendar or reminder action", { mutationPressure: operations.schedule, communicationPressure: 0.45 });
  add("purchase", operations.purchase, "prepare a spend-bearing transaction", { mutationPressure: operations.purchase, networkPressure: operations.network, privacyPressure: 0.8, expectedValue: baseExpected * 0.65 });
  add("publish", operations.publish, "prepare public or remote publication", { mutationPressure: operations.publish, networkPressure: operations.network, privacyPressure: 0.7 });
  add("repair", operations.repair, "diagnose and repair a failing generated artifact", { mutationPressure: Math.max(operations.mutation, 0.45), codePressure: 0.9 });

  return mergeCompatibleObjectives(objectives).sort((a, b) => b.expectedValue - a.expectedValue || b.requiredEvidence - a.requiredEvidence);
}

function operationPressures(request: string, features: readonly string[], actionCommitment = 0) {
  const featureText = features.join(" ");
  const hasUrl = /[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>]+/iu.test(request);
  const hasEmailLike = /[\p{Letter}\p{Number}._%+-]+@[\p{Letter}\p{Number}.-]+\.[\p{Letter}]{2,}/u.test(request);
  const hasPhoneLike = /(?:\+?\d[\d ().-]{7,}\d)/u.test(request);
  const hasCalendarLike = /\b\d{4}-\d{2}-\d{2}(?:[T ][0-2]\d:[0-5]\d(?::[0-5]\d)?(?:Z|[+-][0-2]\d:[0-5]\d)?)?\b/u.test(request);
  const hasFileExt = /\.(?:[A-Za-z0-9]{1,12})(?:\s|$|[)"'`])/u.test(request);
  const hasArchiveOrDocumentExt = /\.(?:zip|pdf|docx|xlsx|xlsm|xls|csv|tsv|json|xml|bz2|gz)(?:\s|$|[)"'`])/iu.test(request);
  const hasCodeFence = /```|^\s*(?:import|export|class|function|const|let|var)\s/mu.test(request);
  const hasPatchMarker = /^(?:diff --git|@@\s|[+-]{3}\s|Index:\s)/mu.test(request);
  const hasCliFlag = /(^|\s)--[A-Za-z0-9][A-Za-z0-9_-]*/u.test(request);
  const hasPathLike = /(?:^|\s)(?:[A-Za-z]:\\|\.{0,2}\/|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+)/u.test(request);
  const hasSecretLike = /(?:[A-Za-z0-9_=-]{32,}|-----BEGIN [A-Z ]+-----)/u.test(request);
  const hasPackageLike = /@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+|[A-Za-z0-9_.-]+@[0-9]+(?:\.[0-9]+){1,3}/u.test(request);
  const code = hasCodeFence || /\.(?:ts|tsx|js|jsx|mjs|cjs|py|rs|go|cs|sql|java|kt|swift|cpp|c|h)\b/iu.test(request) || /sym:(ts|tsx|js|jsx|py|rs|cs|sql)\b/u.test(featureText) ? 1 : 0.12;
  const network = hasUrl ? 1 : 0.08;
  const mutation = hasPatchMarker ? 0.92 : hasPathLike && code ? 0.64 : 0.08;
  const communication = hasEmailLike || hasPhoneLike || hasCalendarLike ? 1 : 0.03;
  const edit = hasPatchMarker ? 1 : 0.1;
  const structuralExecute = hasCliFlag || hasPackageLike ? 0.7 : 0.08;
  const schedule = hasCalendarLike ? 1 : 0.02;
  const publish = hasUrl && hasPatchMarker ? 0.6 : 0.04;
  const specializedAction = Math.max(edit, communication, schedule, publish);
  const privacy = hasSecretLike ? 1 : 0.18;
  const urgency = hasCalendarLike ? 0.55 : 0.35;
  return {
    search: network > 0.5 && !hasUrl ? 0.65 : 0.1,
    retrieve: hasUrl || hasPathLike || hasFileExt ? 1 : 0.25,
    extract: hasArchiveOrDocumentExt ? 1 : 0.18,
    analysis: hasArchiveOrDocumentExt || hasCodeFence || hasPathLike ? 0.72 : 0.48,
    generate: code > 0.5 || hasCliFlag ? 0.75 : 0.2,
    edit,
    execute: specializedAction > 0.5
      ? structuralExecute
      : Math.max(structuralExecute, clamp01(actionCommitment)),
    communication,
    schedule,
    purchase: 0,
    publish,
    repair: hasPatchMarker || code > 0.5 && hasPathLike ? 0.55 : 0.2,
    network,
    mutation,
    privacy,
    urgency,
    code
  };
}

function mergeCompatibleObjectives(objectives: ToolObjective[]): ToolObjective[] {
  const merged: ToolObjective[] = [];
  for (const objective of objectives) {
    const existing = merged.find(item => item.kind === objective.kind && weightedJaccard(item.features, objective.features) > 0.8);
    if (!existing) {
      merged.push(objective);
      continue;
    }
    existing.requiredEvidence = Math.max(existing.requiredEvidence, objective.requiredEvidence);
    existing.mutationPressure = Math.max(existing.mutationPressure, objective.mutationPressure);
    existing.networkPressure = Math.max(existing.networkPressure, objective.networkPressure);
    existing.privacyPressure = Math.max(existing.privacyPressure, objective.privacyPressure);
    existing.communicationPressure = Math.max(existing.communicationPressure, objective.communicationPressure);
    existing.codePressure = Math.max(existing.codePressure, objective.codePressure);
    existing.urgency = Math.max(existing.urgency, objective.urgency);
    existing.expectedValue = Math.max(existing.expectedValue, objective.expectedValue);
  }
  return merged;
}

function scoreCapabilities(input: { objectives: ToolObjective[]; capabilities: Capability[]; policy: PolicyProfile; operatorGrant: boolean; now: number }): CapabilityScore[] {
  const scores: CapabilityScore[] = [];
  for (const objective of input.objectives) {
    for (const capability of input.capabilities) {
      for (const phase of phasesFor(objective, capability, input.policy)) {
        const fit = capabilityFit(objective, capability, phase);
        if (fit <= 0.04) continue;
        const risk = capabilityRisk(objective, capability, phase, input.policy);
        const evi = expectedValueOfInformation(objective, capability, phase, risk);
        const reversible = phase !== "commit" || !capability.mutates || capability.kind === "filesystem" || capability.kind === "process";
        const approvalMode = approvalModeFor(objective, capability, phase, risk, input.policy, input.operatorGrant);
        const configuredPenalty = capability.configured ? 1 : 0.25;
        const utility = clamp01((0.55 * fit + 0.45 * evi) * configuredPenalty * (1 - risk * 0.42));
        scores.push({
          capabilityId: capability.id,
          objectiveId: objective.id,
          phase,
          fit,
          evi,
          risk,
          utility,
          reversible,
          configured: capability.configured,
          approvalMode,
          reasons: scoreReasons(objective, capability, phase, fit, evi, risk, approvalMode)
        });
      }
    }
  }
  return scores.sort((a, b) => b.utility - a.utility || a.risk - b.risk || a.capabilityId.localeCompare(b.capabilityId));
}

function phasesFor(objective: ToolObjective, capability: Capability, policy: PolicyProfile): CapabilityPhase[] {
  const phases: CapabilityPhase[] = objective.kind === "execute" ? ["prepare"] : ["read"];
  const needsPrepare = objective.mutationPressure > 0.1 || capability.mutates || objective.kind === "generate" || objective.kind === "repair";
  if (needsPrepare && !phases.includes("prepare")) phases.push("prepare");
  const canCommit = objective.mutationPressure > 0.3 || capability.mutates || objective.kind === "publish" || objective.kind === "communicate" || objective.kind === "purchase";
  if (canCommit && policy.allowMutation) phases.push("commit");
  return phases;
}

function capabilityFit(objective: ToolObjective, capability: Capability, phase: CapabilityPhase): number {
  const kind = capability.kind;
  const kindFit =
    objective.kind === "search" && kind === "network" ? 1 :
    objective.kind === "retrieve" && (kind === "filesystem" || kind === "network") ? 0.9 :
    objective.kind === "extract" && (kind === "filesystem" || kind === "process") ? 0.86 :
    objective.kind === "analyze" && (kind === "process" || kind === "filesystem") ? 0.75 :
    objective.kind === "generate" && (kind === "filesystem" || kind === "process") ? 0.72 :
    objective.kind === "edit" && kind === "filesystem" ? 1 :
    objective.kind === "execute" && kind === "process" ? 1 :
    objective.kind === "communicate" && (kind === "outlook" || kind === "telephone" || kind === "network") ? 0.96 :
    objective.kind === "schedule" && (kind === "outlook" || kind === "network") ? 0.9 :
    objective.kind === "purchase" && kind === "network" ? 0.74 :
    objective.kind === "publish" && (kind === "network" || kind === "filesystem" || kind === "process") ? 0.82 :
    objective.kind === "repair" && (kind === "process" || kind === "filesystem") ? 0.9 :
    objective.kind === "observe" && (kind === "filesystem" || kind === "process") ? 0.7 :
    0.12;
  const phaseFit = phase === "read" ? 0.92 : phase === "prepare" ? 0.78 + objective.mutationPressure * 0.15 : 0.72 + objective.mutationPressure * 0.22;
  const metadataFit = metadataCapabilityFit(objective, capability);
  return clamp01(0.62 * kindFit + 0.23 * phaseFit + 0.15 * metadataFit);
}

function metadataCapabilityFit(objective: ToolObjective, capability: Capability): number {
  const metadataFeatures = featureSet(JSON.stringify(capability.metadata), 256);
  if (metadataFeatures.length === 0) return 0.35;
  return weightedJaccard(objective.features, metadataFeatures);
}

function capabilityRisk(objective: ToolObjective, capability: Capability, phase: CapabilityPhase, policy: PolicyProfile): number {
  const capabilityRiskBase = clamp01(capability.risk);
  const mutation = capability.mutates || phase === "commit" ? objective.mutationPressure : objective.mutationPressure * 0.25;
  const privacy = objective.privacyPressure * (capability.kind === "network" || capability.kind === "outlook" || capability.kind === "telephone" ? 1 : 0.45);
  const spend = objective.kind === "purchase" ? Math.min(1, policy.maxSpendCents <= 0 ? 1 : 0.65) : 0;
  const network = capability.kind === "network" || capability.kind === "youtube" || capability.kind === "outlook" || capability.kind === "telephone" ? objective.networkPressure : 0.08;
  const policyPenalty = policy.dryRunByDefault && phase === "commit" ? 0.18 : 0;
  return clamp01(0.32 * capabilityRiskBase + 0.24 * mutation + 0.2 * privacy + 0.14 * network + 0.1 * spend + policyPenalty);
}

function expectedValueOfInformation(objective: ToolObjective, capability: Capability, phase: CapabilityPhase, risk: number): number {
  const phaseValue = phase === "read" ? objective.requiredEvidence : phase === "prepare" ? objective.expectedValue * 0.72 : objective.expectedValue * 0.55;
  const connectorValue =
    capability.kind === "network" ? objective.networkPressure :
    capability.kind === "filesystem" ? Math.max(objective.requiredEvidence, objective.codePressure * 0.55) :
    capability.kind === "process" ? Math.max(objective.codePressure, objective.requiredEvidence * 0.5) :
    capability.kind === "outlook" || capability.kind === "telephone" ? objective.communicationPressure :
    capability.kind === "youtube" ? Math.max(objective.networkPressure, objective.requiredEvidence * 0.75) :
    0.2;
  return clamp01((0.58 * phaseValue + 0.42 * connectorValue) * (1 - risk * 0.3));
}

function approvalModeFor(objective: ToolObjective, capability: Capability, phase: CapabilityPhase, risk: number, policy: PolicyProfile, operatorGrant: boolean): ApprovalMode {
  if (!capability.configured) return "blocked_by_policy";
  if (risk > policy.alphaRiskCeiling) return "blocked_by_policy";
  if (phase === "commit" && !policy.allowMutation) return "blocked_by_policy";
  const approvalNeeded = capability.requiresApproval || phase === "commit" || risk > 0.35 || objective.privacyPressure > 0.55 || objective.kind === "purchase";
  if (!approvalNeeded) return "not_required";
  if (operatorGrant && risk < Math.min(0.82, policy.alphaRiskCeiling) && objective.kind !== "purchase") return "temporary_operator_grant";
  return "explicit";
}

function scoreReasons(objective: ToolObjective, capability: Capability, phase: CapabilityPhase, fit: number, evi: number, risk: number, approvalMode: ApprovalMode): string[] {
  const reasons = [
    `${phase} phase for ${objective.kind}`,
    `fit=${fit.toFixed(3)}`,
    `evi=${evi.toFixed(3)}`,
    `risk=${risk.toFixed(3)}`,
    `approval=${approvalMode}`
  ];
  if (!capability.configured) reasons.push("capability is present but lacks connector configuration");
  if (objective.privacyPressure > 0.55) reasons.push("privacy pressure raises approval requirement");
  if (objective.mutationPressure > 0.55) reasons.push("mutation pressure requires two phase action handling");
  return reasons;
}

function selectCapabilityScores(
  scores: CapabilityScore[],
  policy: PolicyProfile,
  objectives: readonly ToolObjective[],
  actionCommitment: number
): CapabilityScore[] {
  if (actionCommitment >= ACTION_PREPARE_COMMITMENT_THRESHOLD) {
    const objectiveById = new Map(objectives.map(objective => [objective.id, objective]));
    const preparedExecution = scores.find(score =>
      score.phase === "prepare"
      && score.approvalMode !== "blocked_by_policy"
      && PREPARED_ACTION_KINDS.has(objectiveById.get(score.objectiveId)?.kind ?? "observe")
    );
    if (preparedExecution) return [preparedExecution];
  }
  const selected: CapabilityScore[] = [];
  const covered = new Set<string>();
  const phaseCount = new Map<CapabilityPhase, number>();
  for (const score of scores) {
    if (selected.length >= policy.maxToolCalls) break;
    if (score.approvalMode === "blocked_by_policy") continue;
    const key = `${score.objectiveId}:${score.phase}`;
    if (covered.has(key)) continue;
    const currentPhaseCount = phaseCount.get(score.phase) ?? 0;
    if (score.phase === "commit" && currentPhaseCount >= Math.max(1, Math.ceil(policy.maxToolCalls / 3))) continue;
    if (score.utility < 0.12 && selected.length > 0) continue;
    selected.push(score);
    covered.add(key);
    phaseCount.set(score.phase, currentPhaseCount + 1);
  }
  return enforcePhaseOrder(selected);
}

function enforcePhaseOrder(scores: CapabilityScore[]): CapabilityScore[] {
  const phaseRank: Record<CapabilityPhase, number> = { read: 0, prepare: 1, commit: 2 };
  return [...scores].sort((a, b) => phaseRank[a.phase] - phaseRank[b.phase] || b.utility - a.utility);
}

function materializePlans(input: {
  selected: CapabilityScore[];
  objectives: ToolObjective[];
  episodeId: EpisodeId;
  request: string;
  policy: PolicyProfile;
  operatorGrant: boolean;
  hasher: Hasher;
  t: number;
}): CapabilityPlan[] {
  const objectiveById = new Map(input.objectives.map(objective => [objective.id, objective]));
  return input.selected.map((score, index) => {
    const objective = objectiveById.get(score.objectiveId);
    const payload = {
      objectiveId: score.objectiveId,
      capabilityId: score.capabilityId,
      phase: score.phase,
      index,
      requestHash: input.hasher.digestHex(input.request).slice(0, 24)
    };
    const id = `capability_call_${input.hasher.digestHex(JSON.stringify(payload)).slice(0, 32)}` as CapabilityCallId;
    return {
      id,
      episodeId: input.episodeId,
      capabilityId: score.capabilityId,
      phase: score.phase,
      status: "planned",
      input: toJsonValue({
        objective,
        requestHash: payload.requestHash,
        phase: score.phase,
        allowedOperations: allowedOperationsFor(score, input.policy),
        executionDiscipline: score.phase === "commit" ? "approval_backed_commit" : score.phase === "prepare" ? "prepare_without_external_mutation" : "bounded_read"
      }),
      riskVector: toJsonValue({
        risk: score.risk,
        fit: score.fit,
        evi: score.evi,
        mutates: score.phase === "commit" || (objective?.mutationPressure ?? 0) > 0.4,
        network: (objective?.networkPressure ?? 0) > 0.35,
        privacy: objective?.privacyPressure ?? 0,
        reversible: score.reversible
      }),
      permission: toJsonValue({
        allowed: score.approvalMode !== "blocked_by_policy",
        mode: score.approvalMode,
        dryRun: input.policy.dryRunByDefault || score.phase !== "commit",
        temporaryOperatorGrant: input.operatorGrant && score.approvalMode === "temporary_operator_grant",
        requiresExplicitApproval: score.approvalMode === "explicit",
        policy: {
          allowMutation: input.policy.allowMutation,
          requireTwoPhaseCommit: input.policy.requireTwoPhaseCommit,
          alphaRiskCeiling: input.policy.alphaRiskCeiling,
          maxSpendCents: input.policy.maxSpendCents
        }
      }),
      createdAt: input.t
    };
  });
}

function allowedOperationsFor(score: CapabilityScore, policy: PolicyProfile): string[] {
  const operations = score.phase === "read"
    ? ["cap.op.read", "cap.op.inspect", "cap.op.surface_digest"]
    : score.phase === "prepare"
      ? ["cap.op.read", "cap.op.inspect", "cap.op.prepare", "cap.op.diff", "cap.op.plan"]
      : ["cap.op.commit"];
  if (score.phase === "commit" && policy.requireTwoPhaseCommit) operations.unshift("cap.op.verify_prepared_state");
  if (score.reversible) operations.push("cap.op.rollback_plan");
  return operations;
}

function buildApprovalControls(plans: CapabilityPlan[], scores: CapabilityScore[], operatorGrant: boolean, t: number): ApprovalControl[] {
  const scoreByPlanKey = new Map(scores.map(score => [`${score.capabilityId}:${score.phase}`, score]));
  const controls: ApprovalControl[] = [];
  for (const plan of plans) {
    const score = scoreByPlanKey.get(`${plan.capabilityId}:${plan.phase}`);
    const permission = plan.permission as { mode?: ApprovalMode };
    const mode = permission.mode ?? score?.approvalMode ?? "explicit";
    if (mode === "not_required" || mode === "temporary_operator_grant") continue;
    const risk = score?.risk ?? 0.5;
    const operatorGrantEligible = risk < 0.72 && plan.phase !== "commit";
    controls.push({
      id: `approval_${String(plan.id)}`,
      planId: plan.id,
      mode,
      title: mode === "blocked_by_policy" ? "Policy blocked capability action" : "Capability approval required",
      body: approvalBody(plan, score),
      buttons: ([
        { id: "approve", label: "Approve", consequence: "Allows this planned capability phase once." },
        { id: "deny", label: "Deny", consequence: "Leaves the action uninvoked and records the denial." },
        { id: "temporary_operator_grant", label: "Operator Grant for session", consequence: "Allows eligible planned actions during this session until the session safety bound expires." }
      ] as const).filter(button => button.id !== "temporary_operator_grant" || operatorGrantEligible),
      operatorGrantEligible: operatorGrantEligible && !operatorGrant,
      risk,
      expiresAt: t + 30 * 60 * 1000
    });
  }
  return controls;
}

function approvalBody(plan: CapabilityPlan, score: CapabilityScore | undefined): string {
  const risk = score?.risk ?? 0.5;
  const utility = score?.utility ?? 0;
  const reasons = score?.reasons.join("; ") ?? "Capability requires explicit owner control.";
  return `Plan ${String(plan.id)} asks to ${plan.phase} using ${plan.capabilityId}. Risk ${risk.toFixed(3)}, utility ${utility.toFixed(3)}. ${reasons}`;
}

function residualNeedsFor(objectives: ToolObjective[], selected: CapabilityScore[], capabilities: Capability[]): ToolCognitionPlan["residualNeeds"] {
  const selectedByObjective = new Map<string, CapabilityScore[]>();
  for (const score of selected) {
    const existing = selectedByObjective.get(score.objectiveId) ?? [];
    existing.push(score);
    selectedByObjective.set(score.objectiveId, existing);
  }
  return objectives.flatMap(objective => {
    const chosen = selectedByObjective.get(objective.id) ?? [];
    if (chosen.some(score => score.utility >= 0.28)) return [];
    const connectorHint = connectorHintForObjective(objective, capabilities);
    return [{
      objectiveId: objective.id,
      reason: chosen.length === 0 ? "no configured capability met utility and policy thresholds" : "available capability utility remains low",
      connectorHint,
      evidenceValue: objective.requiredEvidence
    }];
  });
}

function connectorHintForObjective(objective: ToolObjective, capabilities: Capability[]): string | undefined {
  const configuredKinds = new Set(capabilities.filter(c => c.configured).map(c => c.kind));
  if (objective.kind === "search" && !configuredKinds.has("network")) return "configure a web search provider in scce.config.json";
  if (objective.kind === "communicate" && !configuredKinds.has("outlook") && !configuredKinds.has("telephone")) return "configure an Outlook or telephone connector in scce.config.json";
  if (objective.kind === "extract" && !configuredKinds.has("process")) return "configure local document extraction tools in scce.config.json";
  if (objective.kind === "edit" && !configuredKinds.has("filesystem")) return "enable filesystem capability in scce.config.json";
  return undefined;
}

function policyAudit(policy: PolicyProfile, selected: CapabilityScore[], plans: CapabilityPlan[], approvals: ApprovalControl[], actionCommitment: number) {
  return {
    actionCommitment,
    actionPrepareCommitmentThreshold: ACTION_PREPARE_COMMITMENT_THRESHOLD,
    allowMutation: policy.allowMutation,
    requireTwoPhaseCommit: policy.requireTwoPhaseCommit,
    dryRunByDefault: policy.dryRunByDefault,
    maxToolCalls: policy.maxToolCalls,
    maxNetworkRequests: policy.maxNetworkRequests,
    alphaRiskCeiling: policy.alphaRiskCeiling,
    selected: selected.map(score => ({ capabilityId: score.capabilityId, objectiveId: score.objectiveId, phase: score.phase, risk: score.risk, utility: score.utility, approvalMode: score.approvalMode })),
    plannedCount: plans.length,
    approvalCount: approvals.length,
    blockedCount: selected.filter(score => score.approvalMode === "blocked_by_policy").length
  };
}

function learningSignalFor(plan: ToolCognitionPlan, outcome: ToolOutcomeObservation): ToolLearningSignal {
  const capabilityPlan = plan.capabilityPlans.find(item => item.id === outcome.planId);
  const objective = capabilityPlan ? objectiveFromPlanInput(capabilityPlan.input) : undefined;
  const success = outcome.status === "succeeded" ? 1 : outcome.status === "rolled_back" ? 0.35 : 0;
  const produced = clamp01(0.45 * Math.min(1, outcome.evidenceProduced / 8) + 0.35 * Math.min(1, outcome.artifactsProduced / 4) + 0.2 * success);
  const spendPenalty = clamp01((outcome.spendCents ?? 0) / 5000);
  const durationPenalty = clamp01(outcome.durationMs / 120000);
  const utilityDelta = clamp01(produced - 0.18 * spendPenalty - 0.08 * durationPenalty);
  const riskDelta = clamp01((outcome.status === "failed" ? 0.22 : -0.08) + spendPenalty * 0.2 + (outcome.errorClass ? 0.1 : 0));
  const connectorReliability = clamp01(0.55 * success + 0.45 * (1 - riskDelta));
  const notes = [
    `status=${outcome.status}`,
    `evidence=${outcome.evidenceProduced}`,
    `artifacts=${outcome.artifactsProduced}`,
    `durationMs=${outcome.durationMs}`
  ];
  if (outcome.errorClass) notes.push(`errorClass=${outcome.errorClass}`);
  return {
    planId: outcome.planId,
    objectiveId: objective?.id,
    utilityDelta,
    riskDelta,
    connectorReliability,
    retainAsPattern: connectorReliability > 0.62 && utilityDelta > 0.28,
    notes
  };
}

function objectiveFromPlanInput(input: JsonValue): ToolObjective | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const objective = (input as Record<string, JsonValue>).objective;
  if (!objective || typeof objective !== "object" || Array.isArray(objective)) return undefined;
  const record = objective as Record<string, JsonValue>;
  if (typeof record.id !== "string" || typeof record.kind !== "string") return undefined;
  return {
    id: record.id,
    kind: record.kind as ToolIntentKind,
    label: typeof record.label === "string" ? record.label : record.kind,
    features: Array.isArray(record.features) ? record.features.filter((item): item is string => typeof item === "string") : [],
    requiredEvidence: typeof record.requiredEvidence === "number" ? record.requiredEvidence : 0,
    mutationPressure: typeof record.mutationPressure === "number" ? record.mutationPressure : 0,
    networkPressure: typeof record.networkPressure === "number" ? record.networkPressure : 0,
    privacyPressure: typeof record.privacyPressure === "number" ? record.privacyPressure : 0,
    communicationPressure: typeof record.communicationPressure === "number" ? record.communicationPressure : 0,
    codePressure: typeof record.codePressure === "number" ? record.codePressure : 0,
    urgency: typeof record.urgency === "number" ? record.urgency : 0,
    expectedValue: typeof record.expectedValue === "number" ? record.expectedValue : 0
  };
}
