// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import type { CapabilityApprovalScope, CapabilityPlan } from "@scce/kernel";
import { ApprovalSession } from "../approval-session.js";

const approvalScope: CapabilityApprovalScope = { episodeId: "episode.owned", goalId: "goal.owned", taskId: "task.owned", inputRef: "input.concrete" };
const action = () => ({ capabilityId: "outlook.send_mail", input: { messageId: "observed.draft.id" }, approvalScope: { ...approvalScope } });
const plan = (id = "plan.owned"): CapabilityPlan => ({ id: id as CapabilityPlan["id"], episodeId: "episode.audit.turn" as CapabilityPlan["episodeId"], ...action(), phase: "commit", status: "planned", riskVector: {}, permission: { allowed: false, dryRun: true }, createdAt: 1 });

describe("task-scoped concrete capability approval", () => {
  it.each(["episodeId", "goalId", "taskId", "inputRef"] as const)("cannot borrow approval across %s", key => {
    const approvals = new ApprovalSession();
    approvals.observePending(plan());
    const record = approvals.approve("plan.owned");
    expect(record.approvalScope).toEqual(approvalScope);
    expect(approvals.isApproved(action())).toBe(true);
    expect(approvals.isApproved({ ...action(), approvalScope: { ...approvalScope, [key]: "another.identity" } })).toBe(false);
    expect(approvals.isApproved({ ...action(), capabilityId: "outlook.delete_draft" })).toBe(false);
    expect(approvals.isApproved({ ...action(), input: { messageId: "different.draft" } })).toBe(false);
    expect(approvals.isApproved({ capabilityId: action().capabilityId, input: action().input })).toBe(false);
  });

  it("keeps unscoped approvals and rejections separate from scoped actions", () => {
    const approvals = new ApprovalSession();
    const unscoped = { capabilityId: action().capabilityId, input: action().input };
    const existing = approvals.requestApproval(unscoped);
    approvals.approve(existing.planId);
    expect(approvals.isApproved(unscoped)).toBe(true);
    expect(approvals.isApproved(action())).toBe(false);
    approvals.observePending(plan());
    approvals.reject("plan.owned");
    expect(approvals.isRejected(action())).toBe(true);
    expect(approvals.isRejected({ ...action(), approvalScope: { ...approvalScope, taskId: "other.task" } })).toBe(false);
    expect(approvals.isRejected(unscoped)).toBe(false);
    approvals.approve("plan.owned");
    expect(approvals.isRejected(action())).toBe(false);
    expect(approvals.isApproved(action())).toBe(true);
  });

  it("does not expose mutable approval identities and refuses plan identity reuse", () => {
    const approvals = new ApprovalSession();
    const source = action();
    const pending = approvals.requestApproval(source);
    const originalPlanId = pending.planId;
    const other = approvals.requestApproval({ ...action(), approvalScope: { ...approvalScope, taskId: "other.task" } });
    source.approvalScope.taskId = "changed.before.review";
    source.input.messageId = "changed.before.review";
    pending.fingerprint = other.fingerprint;
    pending.approvalScope!.taskId = "changed.returned.record";
    const snapshot = approvals.snapshot();
    snapshot.pending.find(row => row.planId === originalPlanId)!.fingerprint = other.fingerprint;
    approvals.approve(originalPlanId);
    expect(approvals.isApproved(action())).toBe(true);
    expect(approvals.isApproved({ ...action(), approvalScope: { ...approvalScope, taskId: "other.task" } })).toBe(false);
    approvals.observePending(plan());
    expect(() => approvals.observePending({ ...plan(), approvalScope: { ...approvalScope, goalId: "another.goal" } })).toThrow(/identity reused/);
  });

  it("retains explicit operator grants and rejects incomplete scoped identities", () => {
    const approvals = new ApprovalSession();
    expect(approvals.isApproved(action())).toBe(false);
    approvals.setTemporaryOperatorGrant(true);
    expect(approvals.isApproved(action())).toBe(true);
    expect(approvals.isApproved({ ...action(), approvalScope: { ...approvalScope, taskId: "other.task" } })).toBe(true);
    approvals.setTemporaryOperatorGrant(false);
    expect(approvals.isApproved(action())).toBe(false);
    expect(() => approvals.requestApproval({ ...action(), approvalScope: { ...approvalScope, inputRef: "" } })).toThrow(/exact episode, goal, task/);
  });
});
