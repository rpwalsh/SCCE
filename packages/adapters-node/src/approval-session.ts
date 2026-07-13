import { createHash } from "node:crypto";
import type { ApprovalPort, CapabilityPlan, JsonValue, PolicyProfile } from "@scce/kernel";
import { canonicalStringify, toJsonValue } from "@scce/kernel";

export interface ApprovalSnapshot {
  operatorGrant: boolean;
  pending: Array<ApprovalRecord>;
  approved: Array<ApprovalRecord>;
}

export interface ApprovalRecord {
  planId: string;
  capabilityId: string;
  input: JsonValue;
  fingerprint: string;
  reason: string;
  createdAt: number;
  approvedAt?: number;
}

export class ApprovalSession implements ApprovalPort {
  private operatorGrant = false;
  private readonly pending = new Map<string, ApprovalRecord>();
  private readonly approved = new Map<string, ApprovalRecord>();

  isApproved(input: { capabilityId: string; input: JsonValue }): boolean {
    if (this.operatorGrant) return true;
    return this.approved.has(fingerprint(input.capabilityId, input.input));
  }

  observePending(plan: CapabilityPlan): void {
    const permission = plan.permission as { dryRun?: boolean; allowed?: boolean; reason?: string };
    if (permission.allowed && !permission.dryRun) return;
    const record = recordFromPlan(plan, permission.reason ?? "approval-required");
    this.pending.set(record.planId, record);
  }

  requestApproval(input: { capabilityId: string; input: JsonValue; reason?: string }): ApprovalRecord {
    const record: ApprovalRecord = {
      planId: `approval_${fingerprint(input.capabilityId, input.input).slice(0, 24)}`,
      capabilityId: input.capabilityId,
      input: input.input,
      fingerprint: fingerprint(input.capabilityId, input.input),
      reason: input.reason ?? "approval-required",
      createdAt: Date.now()
    };
    this.pending.set(record.planId, record);
    return record;
  }

  approve(planId: string): ApprovalRecord {
    const record = this.pending.get(planId);
    if (!record) throw new Error(`approval plan not found: ${planId}`);
    const approved = { ...record, approvedAt: Date.now() };
    this.pending.delete(planId);
    this.approved.set(approved.fingerprint, approved);
    return approved;
  }

  setTemporaryOperatorGrant(enabled: boolean): ApprovalSnapshot {
    this.operatorGrant = enabled;
    return this.snapshot();
  }

  policyPatch(): Partial<PolicyProfile> {
    return this.operatorGrant
      ? { allowMutation: true, dryRunByDefault: false, requireTwoPhaseCommit: false, alphaRiskCeiling: 1 }
      : {};
  }

  snapshot(): ApprovalSnapshot {
    return {
      operatorGrant: this.operatorGrant,
      pending: [...this.pending.values()].sort((a, b) => b.createdAt - a.createdAt),
      approved: [...this.approved.values()].sort((a, b) => (b.approvedAt ?? 0) - (a.approvedAt ?? 0)).slice(0, 100)
    };
  }
}

export function createApprovalSession(): ApprovalSession {
  return new ApprovalSession();
}

function recordFromPlan(plan: CapabilityPlan, reason: string): ApprovalRecord {
  const input = toJsonValue(plan.input);
  return {
    planId: String(plan.id),
    capabilityId: plan.capabilityId,
    input,
    fingerprint: fingerprint(plan.capabilityId, input),
    reason,
    createdAt: plan.createdAt
  };
}

function fingerprint(capabilityId: string, input: JsonValue): string {
  return createHash("sha256").update(`${capabilityId}\u001f${canonicalStringify(input)}`).digest("hex");
}
