// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { capabilityBindingVerified, type VerifiedCapabilityBinding } from "./capability-construction.js";
import { invokeRuntimeCapabilityPlan, type RuntimeCapabilities, type RuntimeCapabilityPlanStep } from "./capability-runtime.js";
import type { IdFactory } from "./ids.js";
import { canonicalStringify, toJsonValue } from "./primitives.js";
import { createActionPlanner } from "./safety.js";
import type { ApprovalPort, CapabilityAuditStore } from "./storage.js";
import type { CapabilityApprovalScope, CapabilityPlan, EpisodeId, Hasher, PolicyProfile } from "./types.js";

export async function executeBoundCapability(input: {
  binding: VerifiedCapabilityBinding;
  requestText: string;
  operationId?: string;
  episodeId: EpisodeId;
  ownerId: string;
  policyVersionId: string;
  policy: PolicyProfile;
  capabilities: RuntimeCapabilities;
  approvals?: ApprovalPort;
  audit: CapabilityAuditStore;
  idFactory: IdFactory;
  hasher: Hasher;
  now(): number;
}) {
  if (!capabilityBindingVerified(input.binding, input.requestText)) throw new Error("capability construction binding is not verified");
  const steps: RuntimeCapabilityPlanStep[] = structuredClone(input.binding.steps ?? [{ id: "action", capabilityId: input.binding.capabilityId,
    payload: input.binding.payload, dependencyStepIds: [] }]);
  const requirementIds = [...input.binding.patternIds];
  const ownerId = input.ownerId;
  const policyVersionId = input.policyVersionId;
  const auditEpisodeId = input.episodeId;
  const identity = input.hasher.digestHex(canonicalStringify({ ownerId,
    operationId: input.operationId ?? input.hasher.digestHex(canonicalStringify(steps)) }));
  const executiveEpisodeId = `episode_bound_capability_${identity}`;
  const goalId = `goal_bound_capability_${identity}`;
  const approvals: Array<{ taskId: string; inputRef: string }> = [];
  const plans = new Map<string, CapabilityPlan>();
  const policy = structuredClone({ ...input.policy, ...input.approvals?.policyPatch?.() });
  let remaining = policy.maxToolCalls;
  let networkCalls = 0;
  const accounted = new Set<string>();
  const run = () => invokeRuntimeCapabilityPlan({ capabilities: input.capabilities, episodeId: executiveEpisodeId, goalId,
    ownerId, policyVersionId, steps, approvals,
    maxDispatches: remaining, requirementIds });
  let report = await run();
  const planFor = (task: { taskId: string; capabilityId: string; inputRef: string; payload: import("./types.js").JsonValue }) => {
    const capability = input.capabilities.catalog().find(row => row.id === task.capabilityId);
    if (!capability) throw new Error(`capability unavailable: ${task.capabilityId}`);
    const approvalScope: CapabilityApprovalScope = { episodeId: executiveEpisodeId, goalId, taskId: task.taskId, inputRef: task.inputRef };
    const payload = structuredClone(task.payload);
    const approved = input.approvals?.isApproved({ capabilityId: task.capabilityId, input: structuredClone(payload), approvalScope: { ...approvalScope } });
    const plan = createActionPlanner({ idFactory: input.idFactory, policy }).plan({ episodeId: auditEpisodeId, capability,
      payload, approved, now: input.now() });
    return { ...plan, id: input.idFactory.capabilityCallId({ approvalScope, capabilityId: task.capabilityId }), approvalScope };
  };
  const account = () => {
    for (const result of report.results) {
      if (!["succeeded", "failed", "indeterminate"].includes(result.disposition) || accounted.has(result.taskId)) continue;
      accounted.add(result.taskId);
      remaining--;
      const step = steps.find(row => row.id === result.taskId);
      if (step && input.capabilities.catalog().find(row => row.id === step.capabilityId)?.kind === "network") networkCalls++;
    }
  };
  account();
  while (report.pendingTask && remaining > 0) {
    const task = report.pendingTask;
    const plan = planFor(task);
    plans.set(task.taskId, plan);
    await input.approvals?.observePending(structuredClone(plan));
    const permission = plan.permission as { allowed?: boolean; dryRun?: boolean };
    const capability = input.capabilities.catalog().find(row => row.id === task.capabilityId)!;
    if (!permission.allowed || permission.dryRun || approvals.some(row => row.taskId === task.taskId)
      || capability.kind === "network" && networkCalls >= policy.maxNetworkRequests) break;
    approvals.push({ taskId: task.taskId, inputRef: task.inputRef });
    report = await run();
    account();
  }
  const dispositionFor = (taskId: string) => {
    const task = report.state.tasks[taskId];
    const observation = report.observations.find(row => row.taskId === taskId);
    const receipt = observation ? report.state.receipts[observation.receiptId] : undefined;
    if (task?.status === "succeeded") return "succeeded";
    if (receipt?.status === "failed" || task && ["failed", "rollback_ready", "rollback_blocked", "rollback_failed", "rolled_back"].includes(task.status)) return "failed";
    if (receipt?.status === "indeterminate" || task?.status === "awaiting_outcome") return "indeterminate";
    return report.disposition === "budget_exhausted" ? "budget_exhausted" : "not_ready";
  };
  for (const task of report.taskInputs) {
    const receipt = report.observations.find(row => row.taskId === task.taskId);
    const storedTask = report.state.tasks[task.taskId];
    const current = plans.get(task.taskId) ?? planFor(task);
    const receiptStatus = receipt ? report.state.receipts[receipt.receiptId]?.status : undefined;
    const status: CapabilityPlan["status"] = storedTask?.status === "succeeded" ? "succeeded"
      : receiptStatus === "failed" || storedTask?.status === "failed" ? "failed"
      : receiptStatus === "indeterminate" ? "invoked" : current.status;
    const completed = status === "succeeded" || status === "failed";
    const plan: CapabilityPlan = { ...current, status,
      result: toJsonValue({ disposition: dispositionFor(task.taskId),
        receiptId: receipt?.receiptId, observationRef: receipt ? report.state.receipts[receipt.receiptId]?.attestationRef : undefined }),
      ...(completed ? { completedAt: input.now() } : {}) };
    plans.set(task.taskId, plan);
    await input.audit.putPlan(structuredClone(plan));
  }
  const orderedPlans = steps.flatMap(step => plans.has(step.id) ? [{ taskId: step.id, plan: plans.get(step.id)! }] : []);
  const actions = orderedPlans.map(({ taskId, plan }) => {
    const observed = report.observations.find(row => row.taskId === taskId);
    return { taskId, capabilityId: plan.capabilityId, planId: plan.id, executiveEpisodeId, status: plan.status,
      disposition: dispositionFor(taskId),
      receiptId: observed?.receiptId, observation: observed?.observation };
  });
  return { executiveEpisodeId, goalId, plans: orderedPlans.map(row => row.plan), report, actions };
}
