// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify, createHasher, solveTaskSchedule, toJsonValue, type ConstructGraph, type EpisodeId, type PolicyProfile, type RuntimeCapabilities } from "@scce/kernel";

export interface LocalExecutiveGoalRequest {
  schema: "scce.local_executive_goal.v1";
  episodeId: string;
  goalId: string;
  tasks: Array<{ id: string; dependencyTaskIds: string[]; construct: ConstructGraph }>;
}

export function parseLocalExecutiveGoal(value: unknown): LocalExecutiveGoalRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("local executive goal must be an object");
  const row = value as LocalExecutiveGoalRequest;
  if (row.schema !== "scce.local_executive_goal.v1" || typeof row.episodeId !== "string" || !row.episodeId.trim()
    || typeof row.goalId !== "string" || !row.goalId.trim() || !Array.isArray(row.tasks) || !row.tasks.length) throw new Error("local executive goal requires schema, episodeId, goalId and tasks");
  for (const task of row.tasks) {
    if (!task || typeof task.id !== "string" || !task.id.trim() || !Array.isArray(task.dependencyTaskIds) || task.dependencyTaskIds.some(id => typeof id !== "string")
      || !task.construct?.program || !Array.isArray(task.construct.artifacts) || typeof task.construct.id !== "string"
      || !task.construct.program.build || !task.construct.program.test) throw new Error("local executive task requires a typed build/test construct and dependencies");
    for (const command of [task.construct.program.build, task.construct.program.test]) {
      if (typeof command.command !== "string" || !command.command || !Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string") || typeof command.cwd !== "string") throw new Error("local executive commands require command, string arguments and workspace cwd");
    }
    if (task.construct.artifacts.some(artifact => typeof artifact.path !== "string" || typeof artifact.content !== "string")) throw new Error("local executive artifacts require paths and source content");
  }
  if (new Set(row.tasks.map(task => task.id)).size !== row.tasks.length) throw new Error("local executive task identities must be unique");
  if (solveTaskSchedule(row.tasks.map(task => ({ id: task.id, dependencyIds: task.dependencyTaskIds }))).status !== "scheduled") throw new Error("local executive goal has cyclic dependencies");
  return row;
}

/** One local production lane, shared by CLI and HTTP and the ordinary turn executor. */
export async function runLocalExecutiveGoal(input: { request: LocalExecutiveGoalRequest; capabilities: RuntimeCapabilities; ownerId: string; policy: PolicyProfile; approved: boolean }) {
  const request = parseLocalExecutiveGoal(input.request);
  const hasher = createHasher();
  const objectiveRef = hasher.digestHex(canonicalStringify(request));
  const policyVersionId = `policy_${hasher.digestHex(canonicalStringify(input.policy))}`;
  const capabilityId = "process.build_test";
  return input.capabilities.runGoal({
    maxDispatches: input.policy.maxToolCalls,
    tasks: request.tasks.map(task => ({
      episodeId: request.episodeId, ownerId: input.ownerId, policyVersionId,
      goal: { id: request.goalId, goalClassId: "goal.class.local_build_test", objectiveRef, requirementIds: [], ownerId: input.ownerId },
      task: { id: task.id, goalId: request.goalId, taskClassId: "task.class.build_test", requirementIds: [], dependencyTaskIds: task.dependencyTaskIds, capabilityId,
        inputRef: hasher.digestHex(canonicalStringify(task.construct)), policyVersionId,
        controls: { authority: { authorityClassId: "authority.class.build_test", subjectId: input.ownerId, requiredScopeIds: [], state: "not_required", justificationRef: objectiveRef },
          approval: { policyId: "approval.policy.local_goal", state: "pending", approverClassIds: [input.ownerId], justificationRef: objectiveRef } },
        rollback: { mode: "not_required", justificationRef: "build/test uses an isolated temporary workspace" } },
      ...(input.approved ? { approvalDecision: { decisionId: `approval_${objectiveRef}_${task.id}`, decision: "approved" as const, policyId: "approval.policy.local_goal", decidedBy: input.ownerId, evidenceRefs: [objectiveRef] } } : {}),
      payload: toJsonValue({ episodeId: request.episodeId as EpisodeId, construct: task.construct }), outcomeEvidenceRefs: []
    }))
  });
}
