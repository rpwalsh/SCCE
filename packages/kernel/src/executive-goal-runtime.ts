// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify } from "./primitives.js";
import { solveTaskSchedule } from "./task-schedule-solver.js";
import { dispatchCapabilityTask, type CapabilityDispatcherDeps, type CapabilityDispatchInput, type CapabilityDispatchResult } from "./capability-dispatcher.js";
import { executiveResumePlan, type ExecutiveEpisodeState } from "./executive-episode.js";

export interface ExecutiveGoalRunInput {
  tasks: CapabilityDispatchInput[];
  maxDispatches: number;
}

/** Execute an explicit goal DAG through the existing scheduler and durable dispatcher. */
export async function runExecutiveGoal(deps: CapabilityDispatcherDeps, input: ExecutiveGoalRunInput) {
  if (!Number.isSafeInteger(input.maxDispatches) || input.maxDispatches < 0) throw new Error("maxDispatches must be a nonnegative integer");
  const first = input.tasks[0];
  if (!first) throw new Error("an executive goal requires tasks");
  const tasks = new Map(input.tasks.map(task => [task.task.id, task]));
  if (tasks.size !== input.tasks.length) throw new Error("executive task identities must be unique");
  for (const task of input.tasks) {
    if (task.episodeId !== first.episodeId || task.ownerId !== first.ownerId || task.policyVersionId !== first.policyVersionId
      || canonicalStringify(task.goal) !== canonicalStringify(first.goal) || task.task.goalId !== first.goal.id
      || task.task.policyVersionId !== first.policyVersionId) throw new Error("executive tasks must share one owned goal and policy");
    if (!deps.executors.get(task.task.capabilityId)) throw new Error(`unsupported executive capability: ${task.task.capabilityId}`);
  }
  const schedule = solveTaskSchedule(input.tasks.map(task => ({ id: task.task.id, dependencyIds: task.task.dependencyTaskIds })));
  if (schedule.status !== "scheduled") throw new Error(`executive goal dependency cycle: ${schedule.cycle.join(", ")}`);
  const commandId = (stage: string) => `cmd_${deps.hasher.digestHex(canonicalStringify({ episodeId: first.episodeId, goalId: first.goal.id, stage }))}`;
  let state = await deps.executive.load(first.episodeId);
  if (state.status === "unopened") state = await deps.executive.dispatch({ type: "open_episode", episodeId: first.episodeId, commandId: commandId("open"), occurredAt: deps.now(), ownerId: first.ownerId, policyVersionId: first.policyVersionId });
  if (state.ownerId !== first.ownerId || state.policyVersionId !== first.policyVersionId) throw new Error("executive episode ownership or policy changed");
  if (!state.goals[first.goal.id]) state = await deps.executive.dispatch({ type: "declare_goal", episodeId: first.episodeId, commandId: commandId("goal"), occurredAt: deps.now(), goal: first.goal });
  const storedGoal = state.goals[first.goal.id]!;
  const { status: _status, createdAt: _createdAt, conclusion: _conclusion, ...goalIdentity } = storedGoal;
  if (canonicalStringify(goalIdentity) !== canonicalStringify(first.goal)) throw new Error("executive goal identity changed");
  for (const taskId of schedule.order) {
    const task = tasks.get(taskId)!;
    if (!state.tasks[taskId]) state = await deps.executive.dispatch({ type: "declare_task", episodeId: first.episodeId, commandId: commandId(`task:${taskId}`), occurredAt: deps.now(), task: task.task });
    const { status: _taskStatus, createdAt: _taskCreatedAt, activeAttemptId: _attempt, ...stored } = state.tasks[taskId]!;
    const controls = { ...stored.controls };
    delete controls.authorityDecision;
    delete controls.approvalDecision;
    if (canonicalStringify({ ...stored, controls }) !== canonicalStringify(task.task)) throw new Error(`executive task identity changed: ${taskId}`);
    if (stored.controls.authority.state === "pending" && !stored.controls.authorityDecision && task.authorityDecision) state = await deps.executive.dispatch({ type: "record_authority", episodeId: first.episodeId, commandId: commandId(`authority:${taskId}`), occurredAt: deps.now(), taskId, target: "execution", decision: task.authorityDecision });
    if (stored.controls.approval.state === "pending" && !stored.controls.approvalDecision && task.approvalDecision) state = await deps.executive.dispatch({ type: "record_approval", episodeId: first.episodeId, commandId: commandId(`approval:${taskId}`), occurredAt: deps.now(), taskId, target: "execution", decision: task.approvalDecision });
  }
  if (Object.values(state.tasks).some(task => task.goalId === first.goal.id && !tasks.has(task.id))) throw new Error("executive goal contains tasks absent from this request");
  const results: Array<{ taskId: string; disposition: CapabilityDispatchResult["disposition"] }> = [];
  let dispatched = 0;
  for (const taskId of schedule.order) {
    if (state.tasks[taskId]!.status === "succeeded") continue;
    if (dispatched >= input.maxDispatches) return report("budget_exhausted", state, results);
    const result = await dispatchCapabilityTask(deps, tasks.get(taskId)!);
    state = result.state;
    dispatched++;
    results.push({ taskId, disposition: result.disposition });
    if (result.disposition !== "succeeded") return report(result.disposition, state, results);
  }
  if (state.goals[first.goal.id]!.status === "active") {
    const outcomes = Object.values(state.outcomes).filter(outcome => state.tasks[state.attempts[outcome.attemptId]!.taskId]!.goalId === first.goal.id);
    state = await deps.executive.dispatch({ type: "conclude_goal", episodeId: first.episodeId, commandId: commandId("conclude"), occurredAt: deps.now(), goalId: first.goal.id, disposition: "satisfied", outcomeIds: outcomes.map(outcome => outcome.id), evidenceRefs: [...new Set(outcomes.flatMap(outcome => outcome.evidenceRefs))] });
  }
  return report("succeeded", state, results);
}

function report(disposition: string, state: ExecutiveEpisodeState, results: Array<{ taskId: string; disposition: CapabilityDispatchResult["disposition"] }>) {
  return { schema: "scce.executive_goal_run.v1" as const, disposition, state, results, resume: executiveResumePlan(state) };
}
