import type { Capability, CapabilityPlan, JsonValue, PolicyProfile } from "./types.js";
import type { Hasher } from "./types.js";
import { canonicalStringify, clamp01, toJsonValue } from "./primitives.js";

export type ActuatorClass =
  | "observe_only"
  | "reason_only"
  | "draft_only"
  | "local_read"
  | "local_write"
  | "memory_write"
  | "skill_write"
  | "policy_write"
  | "git_write"
  | "network_read"
  | "external_commit";

export type AuthorityLevel = "autonomous" | "user_delegated" | "operator_approved" | "forbidden";
export type GovernedActionStatus = "pending" | "approved" | "executed" | "failed" | "reverted" | "rejected" | "expired";

export interface GovCertificate {
  asmScore: number;
  thetaSafe: number;
  govPassed: boolean;
  actuatorClass: ActuatorClass;
  rollbackRequired: boolean;
  rollbackId?: string;
  killSwitchLive?: boolean;
  policyHash: string;
  authoritySource: string;
  fcsPrimePrev?: number;
  fsiPrev?: number;
  dciPrev?: number;
  suppressedAlternatives?: string[];
  failureIfRejected?: string;
}

export interface GovernedActionProposal {
  id: string;
  status: GovernedActionStatus;
  capabilityId: string;
  actuatorClass: ActuatorClass;
  authority: AuthorityLevel;
  payload: JsonValue;
  attestation: string;
  asmScore: number;
  cost: number;
  createdAt: number;
  expiresAt: number;
  certificate: GovCertificate;
  rejectionReason?: string;
}

export interface GovernedTransition {
  transitionId: string;
  actuatorClass: ActuatorClass;
  proposedBy: "user" | "system" | "operator";
  actionKind: string;
  reason: string;
  scores: {
    asm: number;
    thetaSafe: number;
    fcsPrime?: number;
    fsi?: number;
    dci?: number;
    egpfPrime?: number;
  };
  gates: {
    gov: boolean;
    auditIntact: boolean;
    rollbackAvailable: boolean;
    killSwitchActive: boolean;
  };
  rollback: {
    required: boolean;
    planId?: string;
    estimatedCostMs?: number;
  };
  proposalId?: string;
  auditId?: string;
  executedAt?: string;
}

export interface TwoPhaseProposal {
  id: string;
  status: "proposed" | "approved" | "committed" | "partial" | "failed" | "rejected" | "expired";
  goal: string;
  actions: GovernedActionProposal[];
  asmPlan: number;
  costPlan: number;
  attestation: string;
  createdAt: number;
  expiresAt: number;
  audit: JsonValue;
}

export interface GovernedActionEnvelope {
  classify(capability: Pick<Capability, "id" | "kind" | "mutates" | "risk" | "metadata">): { actuatorClass: ActuatorClass; authority: AuthorityLevel };
  attest(kind: string, payload: JsonValue): string;
  propose(input: {
    capability: Pick<Capability, "id" | "kind" | "mutates" | "risk" | "metadata">;
    payload: JsonValue;
    policy: PolicyProfile;
    now: number;
    authoritySource?: string;
    auditIntact?: boolean;
    rollbackAvailable?: boolean;
    killSwitchActive?: boolean;
    ttlMs?: number;
    suppressedAlternatives?: string[];
    fcsPrimePrev?: number;
    fsiPrev?: number;
    dciPrev?: number;
  }): GovernedActionProposal;
  plan(input: {
    goal: string;
    capabilities: Array<Pick<Capability, "id" | "kind" | "mutates" | "risk" | "metadata">>;
    payloads: JsonValue[];
    policy: PolicyProfile;
    now: number;
  }): TwoPhaseProposal;
  verify(input: { proposal: GovernedActionProposal; payload: JsonValue; policy: PolicyProfile; now: number; approved: boolean }): { ok: boolean; reason: string; transition: GovernedTransition };
  summarizePlans(plans: CapabilityPlan[], policy: PolicyProfile): JsonValue;
}

export function createGovernedActionEnvelope(deps: { hasher: Hasher }): GovernedActionEnvelope {
  return {
    classify,
    attest(kind, payload) {
      return deps.hasher.digestHex(canonicalStringify({ kind, payload }));
    },
    propose(input) {
      const classification = classify(input.capability);
      const thetaSafe = thetaFor(input.policy, classification.actuatorClass);
      const asmScore = autonomySafetyMargin(input.capability, input.policy, classification.actuatorClass);
      const rollbackRequired = rollbackRequiredFor(classification.actuatorClass);
      const gates = {
        gov: asmScore >= thetaSafe && classification.authority !== "forbidden",
        auditIntact: input.auditIntact ?? true,
        rollbackAvailable: !rollbackRequired || Boolean(input.rollbackAvailable ?? false),
        killSwitchActive: input.killSwitchActive ?? true
      };
      const certificate: GovCertificate = {
        asmScore,
        thetaSafe,
        govPassed: gates.gov && gates.auditIntact && gates.rollbackAvailable && gates.killSwitchActive,
        actuatorClass: classification.actuatorClass,
        rollbackRequired,
        rollbackId: rollbackRequired && gates.rollbackAvailable ? `rollback:${input.capability.id}:${input.now}` : undefined,
        killSwitchLive: gates.killSwitchActive,
        policyHash: deps.hasher.digestHex(canonicalStringify(input.policy)),
        authoritySource: input.authoritySource ?? "autonomous-loop",
        fcsPrimePrev: input.fcsPrimePrev,
        fsiPrev: input.fsiPrev,
        dciPrev: input.dciPrev,
        suppressedAlternatives: input.suppressedAlternatives
      };
      const payload = toJsonValue(input.payload);
      const attestation = deps.hasher.digestHex(canonicalStringify({ kind: input.capability.id, payload }));
      const rejectionReason = rejectionFor({ classification, gates, asmScore, thetaSafe, policy: input.policy });
      return {
        id: `gae_${deps.hasher.digestHex(`${input.capability.id}\u001f${attestation}\u001f${input.now}`).slice(0, 32)}`,
        status: rejectionReason ? "rejected" : "pending",
        capabilityId: input.capability.id,
        actuatorClass: classification.actuatorClass,
        authority: classification.authority,
        payload,
        attestation,
        asmScore,
        cost: costOf(input.capability),
        createdAt: input.now,
        expiresAt: input.now + (input.ttlMs ?? 30 * 60 * 1000),
        certificate,
        rejectionReason
      };
    },
    plan(input) {
      const actions = input.capabilities.map((capability, index) => this.propose({ capability, payload: input.payloads[index] ?? null, policy: { ...input.policy, allowMutation: false, dryRunByDefault: true }, now: input.now }));
      const asmPlan = actions.length ? Math.min(...actions.map(action => action.asmScore)) : 1;
      const costPlan = actions.reduce((sum, action) => sum + action.cost, 0);
      const attestation = deps.hasher.digestHex(canonicalStringify({ goal: input.goal, actions: actions.map(action => ({ id: action.id, attestation: action.attestation })) }));
      return {
        id: `tpc_${attestation.slice(0, 32)}`,
        status: actions.some(action => action.status === "rejected") ? "rejected" : "proposed",
        goal: input.goal,
        actions,
        asmPlan,
        costPlan,
        attestation,
        createdAt: input.now,
        expiresAt: input.now + 30 * 60 * 1000,
        audit: toJsonValue({ asmPlan, costPlan, actions: actions.map(action => ({ id: action.id, class: action.actuatorClass, authority: action.authority, asm: action.asmScore, status: action.status })) })
      };
    },
    verify(input) {
      const currentAttestation = deps.hasher.digestHex(canonicalStringify({ kind: input.proposal.capabilityId, payload: input.payload }));
      const expired = input.now > input.proposal.expiresAt;
      const asm = input.proposal.asmScore;
      const thetaSafe = thetaFor(input.policy, input.proposal.actuatorClass);
      const gates = {
        gov: input.proposal.certificate.govPassed && asm >= thetaSafe,
        auditIntact: true,
        rollbackAvailable: !input.proposal.certificate.rollbackRequired || Boolean(input.proposal.certificate.rollbackId),
        killSwitchActive: input.proposal.certificate.killSwitchLive !== false
      };
      const reason = expired
        ? "proposal_expired"
        : currentAttestation !== input.proposal.attestation
          ? "attestation_mismatch"
          : !input.approved
            ? "approval_missing"
            : Object.values(gates).every(Boolean)
              ? "verified"
              : "governance_gate_failed";
      const ok = reason === "verified";
      return {
        ok,
        reason,
        transition: {
          transitionId: `transition_${deps.hasher.digestHex(`${input.proposal.id}\u001f${reason}\u001f${input.now}`).slice(0, 32)}`,
          actuatorClass: input.proposal.actuatorClass,
          proposedBy: input.proposal.certificate.authoritySource === "operator" ? "operator" : "system",
          actionKind: input.proposal.capabilityId,
          reason,
          scores: { asm, thetaSafe, fcsPrime: input.proposal.certificate.fcsPrimePrev, fsi: input.proposal.certificate.fsiPrev, dci: input.proposal.certificate.dciPrev },
          gates,
          rollback: { required: input.proposal.certificate.rollbackRequired, planId: input.proposal.certificate.rollbackId },
          proposalId: input.proposal.id,
          executedAt: ok ? new Date(input.now).toISOString() : undefined
        }
      };
    },
    summarizePlans(plans, policy) {
      const rows = plans.map(plan => {
        const classification = classify({ id: plan.capabilityId, kind: capabilityKind(plan.capabilityId), mutates: Boolean((plan.riskVector as { mutates?: boolean }).mutates), risk: riskNumber(plan.riskVector), metadata: null });
        return {
          planId: plan.id,
          capabilityId: plan.capabilityId,
          status: plan.status,
          phase: plan.phase,
          actuatorClass: classification.actuatorClass,
          authority: classification.authority,
          asm: autonomySafetyMargin({ id: plan.capabilityId, kind: capabilityKind(plan.capabilityId), mutates: Boolean((plan.riskVector as { mutates?: boolean }).mutates), risk: riskNumber(plan.riskVector), metadata: null }, policy, classification.actuatorClass),
          permission: plan.permission
        };
      });
      return toJsonValue({ rows, asmPlan: rows.length ? Math.min(...rows.map(row => row.asm)) : 1, pendingApprovals: rows.filter(row => row.authority === "operator_approved").length });
    }
  };
}

export function classify(capability: Pick<Capability, "id" | "kind" | "mutates" | "risk" | "metadata">): { actuatorClass: ActuatorClass; authority: AuthorityLevel } {
  if (capability.kind === "filesystem") return capability.mutates ? { actuatorClass: "local_write", authority: "operator_approved" } : { actuatorClass: "local_read", authority: "autonomous" };
  if (capability.kind === "process") return { actuatorClass: "local_write", authority: "operator_approved" };
  if (capability.kind === "network") return { actuatorClass: "network_read", authority: "user_delegated" };
  if (capability.kind === "outlook") {
    if (capability.id.includes("send") || capability.id.includes("event")) return { actuatorClass: "external_commit", authority: "forbidden" };
    if (capability.id.includes("draft")) return { actuatorClass: "draft_only", authority: "operator_approved" };
    return { actuatorClass: "network_read", authority: "user_delegated" };
  }
  if (capability.kind === "youtube") return { actuatorClass: "network_read", authority: "user_delegated" };
  if (capability.kind === "telephone") return { actuatorClass: "external_commit", authority: "forbidden" };
  return capability.risk > 0.7 ? { actuatorClass: "external_commit", authority: "forbidden" } : { actuatorClass: "observe_only", authority: "autonomous" };
}

function autonomySafetyMargin(capability: Pick<Capability, "id" | "kind" | "mutates" | "risk" | "metadata">, policy: PolicyProfile, actuatorClass: ActuatorClass): number {
  const mutationPenalty = capability.mutates ? 0.22 : 0;
  const classPenalty = actuatorClass === "external_commit" ? 1 : actuatorClass.endsWith("_write") ? 0.35 : actuatorClass === "network_read" ? 0.18 : 0.05;
  const policyPenalty = policy.allowMutation ? 0 : capability.mutates ? 0.28 : 0;
  const budgetPressure = clamp01((policy.maxToolCalls <= 0 ? 0.25 : 0) + (policy.maxSpendCents <= 0 && actuatorClass === "network_read" ? 0.2 : 0));
  return clamp01(1 - capability.risk * 0.45 - mutationPenalty - classPenalty - policyPenalty - budgetPressure);
}

function thetaFor(policy: PolicyProfile, actuatorClass: ActuatorClass): number {
  const base = clamp01(1 - policy.alphaRiskCeiling * 0.25);
  if (actuatorClass === "external_commit") return 1.01;
  if (actuatorClass.endsWith("_write")) return Math.max(0.62, base);
  if (actuatorClass === "network_read") return Math.max(0.48, base - 0.12);
  return Math.max(0.32, base - 0.24);
}

function rollbackRequiredFor(actuatorClass: ActuatorClass): boolean {
  return actuatorClass === "local_write" || actuatorClass === "memory_write" || actuatorClass === "skill_write" || actuatorClass === "policy_write" || actuatorClass === "git_write";
}

function rejectionFor(input: { classification: { actuatorClass: ActuatorClass; authority: AuthorityLevel }; gates: Record<string, boolean>; asmScore: number; thetaSafe: number; policy: PolicyProfile }): string | undefined {
  if (input.classification.authority === "forbidden") return "forbidden_actuator_class";
  if (input.asmScore < input.thetaSafe) return `asm_below_theta:${input.asmScore.toFixed(3)}<${input.thetaSafe.toFixed(3)}`;
  if (!input.gates.auditIntact) return "gov_audit_chain_broken";
  if (!input.gates.rollbackAvailable) return "gov_rollback_not_ready";
  if (!input.gates.killSwitchActive) return "gov_kill_switch_dead";
  if (input.classification.authority === "operator_approved" && !input.policy.allowMutation) return "operator_approval_required";
  return undefined;
}

function costOf(capability: Pick<Capability, "risk" | "mutates" | "kind">): number {
  return Math.ceil(10 + capability.risk * 100 + (capability.mutates ? 40 : 0) + (capability.kind === "network" ? 15 : 0));
}

function capabilityKind(capabilityId: string): Capability["kind"] {
  if (capabilityId.startsWith("filesystem.")) return "filesystem";
  if (capabilityId.startsWith("process.")) return "process";
  if (capabilityId.startsWith("network.")) return "network";
  if (capabilityId.startsWith("outlook.")) return "outlook";
  if (capabilityId.startsWith("youtube.")) return "youtube";
  if (capabilityId.startsWith("telephone.")) return "telephone";
  return "process";
}

function riskNumber(value: JsonValue): number {
  return value && typeof value === "object" && !Array.isArray(value) && typeof value.risk === "number" ? value.risk : 0.5;
}
