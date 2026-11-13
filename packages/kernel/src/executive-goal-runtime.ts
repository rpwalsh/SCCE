// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalStringify } from "./primitives.js";
import { solveTaskSchedule } from "./task-schedule-solver.js";
import { dispatchCapabilityTask, type CapabilityDispatcherDeps, type CapabilityDispatchInput, type CapabilityDispatchResult } from "./capability-dispatcher.js";
import { executiveResumePlan, type ExecutiveEpisodeState } from "./executive-episode.js";
import type { JsonValue } from "./types.js";

export interface ExecutiveResultBinding {
  path: Array<string | number>;
  predecessorTaskId: string;
  resultPath: Array<string | number>;
  type: "string" | "number" | "boolean" | "object" | "array" | "null" | "json";
}

export type ExecutiveGoalTaskInput = CapabilityDispatchInput & { resultBindings?: ExecutiveResultBinding[] };
export interface ExecutiveResolvedTaskInput {
  taskId: string;
  capabilityId: string;
  inputRef: string;
  payload: JsonValue;
}

export interface ExecutiveGoalRunInput {
  tasks: ExecutiveGoalTaskInput[];
  maxDispatches: number;
}

/** Execute an explicit goal DAG through the existing scheduler and durable dispatcher. */
export async function runExecutiveGoal(deps: CapabilityDispatcherDeps & {
  readTaskResult?(state: ExecutiveEpisodeState, taskId: string): Promise<JsonValue>;
  validatePayload?(capabilityId: string, payload: JsonValue): void;
}, input: ExecutiveGoalRunInput) {
  if (!Number.isSafeInteger(input.maxDispatches) || input.maxDispatches < 0) throw new Error("maxDispatches must be a nonnegative integer");
  const first = input.tasks[0];
  if (!first) throw new Error("an executive goal requires tasks");
  const tasks = new Map(input.tasks.map(task => [task.task.id, task]));
  if (tasks.size !== input.tasks.length) throw new Error("executive task identities must be unique");
  for (const task of input.tasks) {
    if (Object.hasOwn(Object.prototype, task.task.id)) throw new Error("executive task identity collides with a state object property");
    if (task.episodeId !== first.episodeId || task.ownerId !== first.ownerId || task.policyVersionId !== first.policyVersionId
      || canonicalStringify(task.goal) !== canonicalStringify(first.goal) || task.task.goalId !== first.goal.id
      || task.task.policyVersionId !== first.policyVersionId || task.goal.ownerId !== first.ownerId) throw new Error("executive tasks must share one owned goal and policy");
    if (!deps.executors.get(task.task.capabilityId)) throw new Error(`unsupported executive capability: ${task.task.capabilityId}`);
    validateExecutiveResultBindings(task.payload, task.resultBindings ?? [], task.task.dependencyTaskIds);
    if (!task.resultBindings?.length) deps.validatePayload?.(task.task.capabilityId, task.payload);
  }
  const schedule = solveTaskSchedule(input.tasks.map(task => ({ id: task.task.id, dependencyIds: task.task.dependencyTaskIds })));
  if (schedule.status !== "scheduled") throw new Error(`executive goal dependency cycle: ${schedule.cycle.join(", ")}`);
  const planRef = `executive_plan:${deps.hasher.digestHex(canonicalStringify(input.tasks.map(({ authorityDecision: _authority, approvalDecision: _approval, ...task }) => ({ ...task, resultBindings: task.resultBindings ?? [] })).sort((a, b) => a.task.id.localeCompare(b.task.id))))}`;
  const goal = { ...first.goal, objectiveRef: planRef };
  const commandId = (stage: string) => `cmd_${deps.hasher.digestHex(canonicalStringify({ episodeId: first.episodeId, goalId: first.goal.id, stage }))}`;
  let state = await deps.executive.load(first.episodeId);
  if (state.status === "unopened") state = await deps.executive.dispatch({ type: "open_episode", episodeId: first.episodeId, commandId: commandId("open"), occurredAt: deps.now(), ownerId: first.ownerId, policyVersionId: first.policyVersionId });
  if (state.ownerId !== first.ownerId || state.policyVersionId !== first.policyVersionId) throw new Error("executive episode ownership or policy changed");
  if (!state.goals[first.goal.id]) state = await deps.executive.dispatch({ type: "declare_goal", episodeId: first.episodeId, commandId: commandId("goal"), occurredAt: deps.now(), goal });
  const storedGoal = state.goals[first.goal.id]!;
  const { status: _status, createdAt: _createdAt, conclusion: _conclusion, ...goalIdentity } = storedGoal;
  if (canonicalStringify(goalIdentity) !== canonicalStringify(goal)) throw new Error("executive goal identity changed");
  const resolved = new Map<string, CapabilityDispatchInput>();
  const reportRun = (disposition: string, current: ExecutiveEpisodeState, results: Array<{ taskId: string; disposition: CapabilityDispatchResult["disposition"] }>) => report(disposition, current, results, planRef,
    [...resolved.values()].map(task => ({ taskId: task.task.id, capabilityId: task.task.capabilityId, inputRef: task.task.inputRef, payload: task.payload })));
  const resolve = async (taskId: string): Promise<CapabilityDispatchInput | undefined> => {
    const original = tasks.get(taskId)!;
    const bindings = original.resultBindings ?? [];
    if (original.task.dependencyTaskIds.some(id => !state.tasks[id])) return undefined;
    if (bindings.some(binding => state.tasks[binding.predecessorTaskId]?.status !== "succeeded")) return undefined;
    const payload = structuredClone(original.payload);
    for (const binding of bindings) {
      if (!deps.readTaskResult) throw new Error("executive result bindings require canonical observations");
      const value = executivePathValue(await deps.readTaskResult(state, binding.predecessorTaskId), binding.resultPath);
      if (value === undefined || !bindingTypeMatches(value, binding.type)) throw new Error(`executive result binding type mismatch: ${taskId}`);
      setExecutivePath(payload, binding.path, value);
    }
    deps.validatePayload?.(original.task.capabilityId, payload);
    const inputRef = bindings.length ? deps.hasher.digestHex(canonicalStringify(payload)) : original.task.inputRef;
    const task: CapabilityDispatchInput = { ...original, goal, payload, task: { ...original.task, inputRef,
      controls: bindings.length ? { ...original.task.controls, approval: { ...original.task.controls.approval, justificationRef: inputRef } } : original.task.controls } };
    if (bindings.length && task.approvalDecision && (!task.approvalDecision.evidenceRefs.includes(inputRef)
      || task.approvalDecision.decidedBy !== first.ownerId)) throw new Error("executive approval must identify the concrete resolved payload and owner");
    resolved.set(taskId, task);
    return task;
  };
  const declare = async (taskId: string, task: CapabilityDispatchInput) => {
    if (!state.tasks[taskId]) state = await deps.executive.dispatch({ type: "declare_task", episodeId: first.episodeId, commandId: commandId(`task:${taskId}`), occurredAt: deps.now(), task: task.task });
    const { status: _taskStatus, createdAt: _taskCreatedAt, activeAttemptId: _attempt, ...stored } = state.tasks[taskId]!;
    const controls = { ...stored.controls };
    delete controls.authorityDecision;
    delete controls.approvalDecision;
    if (canonicalStringify({ ...stored, controls }) !== canonicalStringify(task.task)) throw new Error(`executive task identity changed: ${taskId}`);
    if (stored.controls.authority.state === "pending" && !stored.controls.authorityDecision && task.authorityDecision) state = await deps.executive.dispatch({ type: "record_authority", episodeId: first.episodeId, commandId: commandId(`authority:${taskId}`), occurredAt: deps.now(), taskId, target: "execution", decision: task.authorityDecision });
    if (stored.controls.approval.state === "pending" && !stored.controls.approvalDecision && task.approvalDecision) state = await deps.executive.dispatch({ type: "record_approval", episodeId: first.episodeId, commandId: commandId(`approval:${taskId}`), occurredAt: deps.now(), taskId, target: "execution", decision: task.approvalDecision });
  };
  for (const taskId of schedule.order) {
    const task = await resolve(taskId);
    if (task) await declare(taskId, task);
  }
  if (Object.values(state.tasks).some(task => task.goalId === first.goal.id && !tasks.has(task.id))) throw new Error("executive goal contains tasks absent from this request");
  const results: Array<{ taskId: string; disposition: CapabilityDispatchResult["disposition"] }> = [];
  let dispatched = 0;
  for (const taskId of schedule.order) {
    const task = resolved.get(taskId) ?? await resolve(taskId);
    if (!task) return reportRun("not_ready", state, results);
    await declare(taskId, task);
    if (state.tasks[taskId]!.status === "succeeded") continue;
    if (["rollback_ready", "rollback_blocked", "rollback_failed", "rolled_back"].includes(state.tasks[taskId]!.status)) return reportRun("failed", state, results);
    if (dispatched >= input.maxDispatches) return reportRun("budget_exhausted", state, results);
    const result = await dispatchCapabilityTask(deps, task);
    state = result.state;
    dispatched++;
    results.push({ taskId, disposition: result.disposition });
    if (result.disposition !== "succeeded") return { ...reportRun(result.disposition, state, results),
      ...(result.disposition === "not_ready" ? { pendingTask: { taskId, capabilityId: task.task.capabilityId, inputRef: task.task.inputRef, payload: task.payload } } : {}) };
  }
  if (state.goals[first.goal.id]!.status === "active") {
    const outcomes = Object.values(state.outcomes).filter(outcome => state.tasks[state.attempts[outcome.attemptId]!.taskId]!.goalId === first.goal.id);
    state = await deps.executive.dispatch({ type: "conclude_goal", episodeId: first.episodeId, commandId: commandId("conclude"), occurredAt: deps.now(), goalId: first.goal.id, disposition: "satisfied", outcomeIds: outcomes.map(outcome => outcome.id), evidenceRefs: [...new Set(outcomes.flatMap(outcome => outcome.evidenceRefs))] });
  }
  return reportRun("succeeded", state, results);
}

function report(disposition: string, state: ExecutiveEpisodeState, results: Array<{ taskId: string; disposition: CapabilityDispatchResult["disposition"] }>, planRef: string, taskInputs: ExecutiveResolvedTaskInput[]) {
  return { schema: "scce.executive_goal_run.v1" as const, disposition, state, results, planRef, taskInputs, resume: executiveResumePlan(state),
    pendingTask: undefined as { taskId: string; capabilityId: string; inputRef: string; payload: JsonValue } | undefined };
}

export function executivePathValue(value: JsonValue, path: readonly (string | number)[]): JsonValue | undefined {
  let current: JsonValue | undefined = value;
  for (const key of path) {
    if (!current || typeof current !== "object" || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string | number, JsonValue>)[key];
  }
  return current;
}

function setExecutivePath(payload: JsonValue, path: readonly (string | number)[], value: JsonValue): void {
  const parent = executivePathValue(payload, path.slice(0, -1));
  if (!parent || typeof parent !== "object" || !Object.hasOwn(parent, path.at(-1)!)) throw new Error("executive binding target absent");
  Object.defineProperty(parent, path.at(-1)!, { value: structuredClone(value), enumerable: true, configurable: true, writable: true });
}

function bindingTypeMatches(value: JsonValue, type: ExecutiveResultBinding["type"]): boolean {
  return type === "json" || (type === "null" ? value === null : type === "array" ? Array.isArray(value)
    : type === "object" ? Boolean(value && typeof value === "object" && !Array.isArray(value)) : typeof value === type);
}

export function validateExecutiveResultBindings(payload: JsonValue, bindings: readonly ExecutiveResultBinding[], dependencyTaskIds: readonly string[]): void {
  const paths: string[][] = [];
  for (const binding of bindings) {
    if (!binding || !Array.isArray(binding.path) || !binding.path.length || !Array.isArray(binding.resultPath)
      || [...binding.path, ...binding.resultPath].some(key => typeof key !== "string" && !(typeof key === "number" && Number.isSafeInteger(key) && key >= 0))
      || !["string", "number", "boolean", "object", "array", "null", "json"].includes(binding.type)
      || !dependencyTaskIds.includes(binding.predecessorTaskId)) throw new Error("invalid executive predecessor result binding");
    if (executivePathValue(payload, binding.path) === undefined) throw new Error("executive binding target absent");
    const path = binding.path.map(String);
    if (paths.some(previous => previous.slice(0, Math.min(previous.length, path.length)).every((key, index) => key === path[index]))) throw new Error("overlapping executive result binding targets");
    paths.push(path);
  }
}
