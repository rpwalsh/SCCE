// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createCapabilityExecutorRegistry, dispatchCapabilityTask, dispatchRollbackAttempt,
  type CapabilityDispatchInput, type CapabilityDispatchResult, type CapabilityExecutor, type CapabilityExecutorRegistry } from "./capability-dispatcher.js";
import type { DurableExecutiveEpisode } from "./executive-journal.js";
import { runExecutiveGoal, type ExecutiveGoalRunInput, type ExecutiveResultBinding } from "./executive-goal-runtime.js";
import { canonicalStringify, createHasher, redactSecrets, toJsonValue } from "./primitives.js";
import type { BlobStore, DialogueMemoryStore } from "./storage.js";
import type { Capability, ContentHash, Hasher, JsonValue } from "./types.js";

export interface CapabilityOperation {
  capability: Capability;
  phase: "read" | "prepare" | "commit";
  inputSchema: JsonValue;
  validate(payload: JsonValue): void;
  execute(payload: JsonValue): Promise<JsonValue>;
  partialResult?(error: unknown): JsonValue | undefined;
  outputRefs?(result: JsonValue): string[];
  evidenceRefs?(result: JsonValue): string[];
  actualDelta?(result: JsonValue, payload: JsonValue): JsonValue;
  succeeded?(result: JsonValue): boolean;
  compensation?: { capabilityId: string; payload(result: JsonValue): JsonValue };
}

export interface CapabilityObservation {
  schema: "scce.capability_observation.v1";
  capabilityId: string;
  inputRef: string;
  result?: JsonValue;
  error?: string;
}

export interface RuntimeCapabilityResult extends CapabilityDispatchResult {
  observation?: CapabilityObservation;
}

export type RuntimeCapabilityGoalResult = Awaited<ReturnType<typeof runExecutiveGoal>> & {
  observations: Array<{ taskId: string; receiptId: string; observation: CapabilityObservation }>;
};

export interface RuntimeCapabilities {
  catalog(): readonly Capability[];
  operations(): readonly (Pick<CapabilityOperation, "capability" | "phase" | "inputSchema"> & { compensationCapabilityId?: string })[];
  executors: CapabilityExecutorRegistry;
  dispatch(input: CapabilityDispatchInput): Promise<RuntimeCapabilityResult>;
  runGoal(input: ExecutiveGoalRunInput): Promise<RuntimeCapabilityGoalResult>;
  rollback(input: { episodeId: string; taskId: string }): ReturnType<typeof dispatchRollbackAttempt>;
}

const OBSERVATION_REF_PREFIX = "capability_observation:";

export function createRuntimeCapabilities(input: {
  executive: DurableExecutiveEpisode;
  blobs: Pick<BlobStore, "put" | "get">;
  operations: readonly CapabilityOperation[];
  hasher?: Hasher;
  now?: () => number;
  dialogueMemory?: Pick<DialogueMemoryStore, "putCalibrationObservation">;
}): RuntimeCapabilities {
  const hasher = input.hasher ?? createHasher();
  const now = input.now ?? (() => Date.now());
  const operations = new Map(input.operations.map(operation => [operation.capability.id, operation]));
  if (operations.size !== input.operations.length) throw new Error("duplicate runtime capability operation");
  const readObservation = async (refs: readonly string[]): Promise<CapabilityObservation | undefined> => {
    const observationRefs = refs.filter(value => value.startsWith(OBSERVATION_REF_PREFIX));
    if (observationRefs.length > 1) throw new Error("ambiguous capability observations");
    const ref = observationRefs[0];
    if (!ref) return undefined;
    const hash = ref.slice(OBSERVATION_REF_PREFIX.length) as ContentHash;
    const bytes = await input.blobs.get(hash);
    if (`sha256_${hasher.digestHex(bytes)}` !== hash) throw new Error("capability observation hash mismatch");
    const observation = JSON.parse(new TextDecoder().decode(bytes)) as CapabilityObservation;
    if (observation.schema !== "scce.capability_observation.v1") throw new Error("invalid capability observation");
    return observation;
  };
  const execute: CapabilityExecutor["execute"] = async request => {
    const operation = operations.get(request.invocation.capabilityId);
    if (!operation?.capability.configured) throw new Error(`capability unavailable: ${request.invocation.capabilityId}`);
    operation.validate(request.payload);
    const observation: CapabilityObservation = { schema: "scce.capability_observation.v1", capabilityId: operation.capability.id,
      inputRef: request.invocation.inputRef };
    let status: "succeeded" | "failed" | "indeterminate";
    let outputRefs: string[] = [];
    try {
      observation.result = await operation.execute(request.payload);
      status = operation.succeeded?.(observation.result) === false ? "failed" : "succeeded";
      outputRefs = operation.outputRefs?.(observation.result) ?? [];
    } catch (error) {
      observation.error = redactSecrets(error instanceof Error ? error.message : String(error));
      observation.result = operation.partialResult?.(error);
      status = observation.result === undefined ? "indeterminate" : "failed";
      if (observation.result !== undefined) outputRefs = operation.outputRefs?.(observation.result) ?? [];
    }
    const hash = await input.blobs.put(new TextEncoder().encode(canonicalStringify(observation)), "application/json");
    return { status, outputRefs: [...outputRefs, `${OBSERVATION_REF_PREFIX}${hash}`],
      evidenceRefs: observation.result === undefined ? [] : operation.evidenceRefs?.(observation.result) ?? [],
      attestationRef: hash, actualDelta: observation.result !== undefined && operation.actualDelta
        ? operation.actualDelta(observation.result, request.payload) : toJsonValue({ observationRef: hash, status }) };
  };
  const executors = createCapabilityExecutorRegistry(input.operations.map(operation => ({
    descriptor: { capabilityId: operation.capability.id, idempotency: "non-repeatable" as const,
      rollback: operation.compensation ? "compensating-action" as const : "unavailable" as const },
    execute,
    rollback: async request => {
      const state = await input.executive.load(request.invocation.episodeId);
      const task = state.tasks[request.invocation.taskId];
      const original = task && operations.get(task.capabilityId);
      if (!task || !original?.compensation || original.compensation.capabilityId !== operation.capability.id) throw new Error("capability compensation does not match its original task");
      const attempt = Object.values(state.attempts).find(row => row.taskId === task.id && row.kind === "execution" && row.receiptId);
      const receipt = attempt?.receiptId ? state.receipts[attempt.receiptId] : undefined;
      const observation = receipt ? await readObservation(receipt.outputRefs) : undefined;
      if (observation?.result === undefined) throw new Error("capability compensation requires its original result");
      return execute({ ...request, payload: original.compensation.payload(observation.result) });
    }
  })));
  const deps = { executive: input.executive, executors, hasher, now, dialogueMemory: input.dialogueMemory,
    validatePayload(capabilityId: string, payload: JsonValue) {
      const operation = operations.get(capabilityId);
      if (!operation?.capability.configured) throw new Error(`capability unavailable: ${capabilityId}`);
      operation.validate(payload);
    },
    async readTaskResult(state: Awaited<ReturnType<DurableExecutiveEpisode["load"]>>, taskId: string): Promise<JsonValue> {
      const task = state.tasks[taskId];
      const attempt = Object.values(state.attempts).filter(row => row.taskId === taskId && row.kind === "execution").sort((a, b) => b.ordinal - a.ordinal)[0];
      const receipt = attempt?.receiptId ? state.receipts[attempt.receiptId] : undefined;
      const observation = receipt ? await readObservation(receipt.outputRefs) : undefined;
      if (task?.status !== "succeeded" || receipt?.status !== "succeeded" || observation?.result === undefined
        || observation.capabilityId !== task.capabilityId || observation.inputRef !== task.inputRef) throw new Error("executive predecessor requires a verified successful observation");
      return observation.result;
    } };
  return {
    catalog: () => input.operations.map(operation => ({ ...operation.capability,
      metadata: toJsonValue({ phase: operation.phase, inputSchema: operation.inputSchema, declaration: operation.capability.metadata }) })),
    operations: () => input.operations.map(({ capability, phase, inputSchema, compensation }) => ({ capability, phase, inputSchema,
      ...(compensation ? { compensationCapabilityId: compensation.capabilityId } : {}) })),
    executors,
    async runGoal(request) {
      for (const task of request.tasks) {
        const operation = operations.get(task.task.capabilityId);
        if (!operation?.capability.configured) throw new Error(`capability unavailable: ${task.task.capabilityId}`);
        if (!task.resultBindings?.length) operation.validate(task.payload);
      }
      const result = await runExecutiveGoal(deps, request);
      const observations: RuntimeCapabilityGoalResult["observations"] = [];
      for (const original of request.tasks) {
        const task = result.state.tasks[original.task.id];
        const attempt = Object.values(result.state.attempts).filter(row => row.taskId === original.task.id && row.kind === "execution").sort((a, b) => b.ordinal - a.ordinal)[0];
        const receipt = attempt?.receiptId ? result.state.receipts[attempt.receiptId] : undefined;
        const observation = receipt ? await readObservation(receipt.outputRefs) : undefined;
        if (receipt && observation) {
          if (observation.capabilityId !== task!.capabilityId || observation.inputRef !== task!.inputRef) throw new Error("capability goal observation identity differs");
          observations.push({ taskId: original.task.id, receiptId: receipt.id, observation });
        }
      }
      return { ...result, observations };
    },
    async dispatch(request) {
      const operation = operations.get(request.task.capabilityId);
      if (!operation?.capability.configured) throw new Error(`capability unavailable: ${request.task.capabilityId}`);
      operation.validate(request.payload);
      const existing = await input.executive.load(request.episodeId);
      const task = existing.tasks[request.task.id];
      if (existing.status !== "unopened" && existing.ownerId !== request.ownerId) throw new Error("capability episode owner differs");
      if (task && (task.inputRef !== request.task.inputRef || task.capabilityId !== request.task.capabilityId
        || task.goalId !== request.goal.id || task.policyVersionId !== request.policyVersionId)) throw new Error("capability task identity reused with different input");
      if (task) {
        const attempt = Object.values(existing.attempts).find(row => row.taskId === task.id && row.kind === "execution");
        if (attempt?.payloadHash && attempt.payloadHash !== hasher.digestHex(canonicalStringify(request.payload))) throw new Error("capability task payload changed");
      }
      const dispatched = await dispatchCapabilityTask(deps, request);
      const observation = dispatched.receipt ? await readObservation(dispatched.receipt.outputRefs) : undefined;
      if (observation && (observation.capabilityId !== request.task.capabilityId || observation.inputRef !== request.task.inputRef)) throw new Error("capability observation identity differs");
      return { ...dispatched, ...(observation ? { observation } : {}) };
    },
    async rollback(request) {
      const state = await input.executive.load(request.episodeId);
      if (!state.tasks[request.taskId]) return { disposition: "no_rollback_needed", state };
      return dispatchRollbackAttempt(deps, { ...request, outcomeEvidenceRefs: [] });
    }
  };
}

export interface RuntimeCapabilityPlanStep {
  id: string;
  capabilityId: string;
  payload: JsonValue;
  dependencyStepIds: string[];
  resultBindings?: ExecutiveResultBinding[];
}

export async function invokeRuntimeCapabilityPlan(input: {
  capabilities: RuntimeCapabilities;
  episodeId: string;
  goalId: string;
  ownerId: string;
  policyVersionId: string;
  steps: readonly RuntimeCapabilityPlanStep[];
  approvals?: readonly { taskId: string; inputRef: string }[];
  maxDispatches: number;
  requirementIds?: string[];
}) {
  const hasher = createHasher();
  const stepIds = new Set(input.steps.map(step => step.id));
  const approvals = input.approvals ?? [];
  if (stepIds.size !== input.steps.length || input.steps.some(step => typeof step.id !== "string" || !step.id)) throw new Error("capability plan step identities must be unique and explicit");
  if (new Set(approvals.map(row => row.taskId)).size !== approvals.length || approvals.some(row => !stepIds.has(row.taskId) || typeof row.inputRef !== "string" || !row.inputRef)) throw new Error("capability plan approvals require exact task identities");
  const objectiveRef = hasher.digestHex(canonicalStringify(input.steps));
  const goal = { id: input.goalId, goalClassId: "goal.class.capability", objectiveRef,
    requirementIds: input.requirementIds ?? [], ownerId: input.ownerId };
  return input.capabilities.runGoal({ maxDispatches: input.maxDispatches, tasks: input.steps.map(step => {
    const operation = input.capabilities.operations().find(row => row.capability.id === step.capabilityId);
    if (!operation) throw new Error(`capability unavailable: ${step.capabilityId}`);
    const inputRef = hasher.digestHex(canonicalStringify(step.payload));
    const policyId = `approval.${step.capabilityId}`;
    const controls = {
      authority: { authorityClassId: `authority.${step.capabilityId}`, subjectId: input.ownerId, requiredScopeIds: [], state: "not_required" as const, justificationRef: inputRef },
      approval: { policyId, state: "pending" as const, approverClassIds: [input.ownerId], justificationRef: inputRef }
    };
    const approval = input.approvals?.find(row => row.taskId === step.id);
    if (approval && !step.resultBindings?.length && approval.inputRef !== inputRef) throw new Error("executive approval must identify the concrete payload");
    return { episodeId: input.episodeId, ownerId: input.ownerId, policyVersionId: input.policyVersionId, goal,
      task: { id: step.id, goalId: input.goalId, taskClassId: `task.class.${step.capabilityId}`, capabilityId: step.capabilityId,
        inputRef, policyVersionId: input.policyVersionId, requirementIds: input.requirementIds ?? [], dependencyTaskIds: step.dependencyStepIds,
        controls, rollback: operation.compensationCapabilityId ? { mode: "capability" as const, capabilityId: operation.compensationCapabilityId,
          planId: `rollback_${step.id}`, inputRef, justificationRef: inputRef,
          controls: { authority: controls.authority, approval: { ...controls.approval, state: "not_required" as const } } }
          : { mode: "not_required" as const, justificationRef: inputRef } },
      ...(approval ? { approvalDecision: { decisionId: `approval_${step.id}`, decision: "approved" as const, policyId,
        decidedBy: input.ownerId, evidenceRefs: [approval.inputRef] } } : {}),
      payload: step.payload, resultBindings: step.resultBindings, outcomeEvidenceRefs: [] };
  }) });
}

export function requireCapabilityResult(dispatched: RuntimeCapabilityResult): JsonValue {
  if (dispatched.disposition !== "succeeded" || dispatched.observation?.result === undefined) {
    throw new Error(dispatched.observation?.error ?? `capability produced no result (disposition: ${dispatched.disposition})`);
  }
  return dispatched.observation.result;
}

export async function invokeRuntimeCapability(input: {
  capabilities: RuntimeCapabilities;
  episodeId: string;
  taskId: string;
  ownerId: string;
  policyVersionId: string;
  capabilityId: string;
  payload: JsonValue;
  approved: boolean;
  requirementIds?: string[];
  dependencyTaskIds?: string[];
  operatorOutcome?: CapabilityDispatchInput["operatorOutcome"];
}): Promise<RuntimeCapabilityResult> {
  const operation = input.capabilities.operations().find(row => row.capability.id === input.capabilityId);
  if (!operation) throw new Error(`capability unavailable: ${input.capabilityId}`);
  const inputRef = createHasher().digestHex(canonicalStringify(input.payload));
  const goalId = `goal_${input.taskId}`;
  const approvalPolicyId = `approval.${input.capabilityId}`;
  const controls = {
    authority: { authorityClassId: `authority.${input.capabilityId}`, subjectId: input.ownerId, requiredScopeIds: [], state: "not_required" as const, justificationRef: inputRef },
    approval: { policyId: approvalPolicyId, state: "pending" as const, approverClassIds: [input.ownerId], justificationRef: inputRef }
  };
  return input.capabilities.dispatch({
    episodeId: input.episodeId, ownerId: input.ownerId, policyVersionId: input.policyVersionId,
    goal: { id: goalId, goalClassId: "goal.class.capability", objectiveRef: inputRef, requirementIds: input.requirementIds ?? [], ownerId: input.ownerId },
    task: { id: input.taskId, goalId, taskClassId: `task.class.${input.capabilityId}`, capabilityId: input.capabilityId,
      inputRef, policyVersionId: input.policyVersionId, requirementIds: input.requirementIds ?? [], dependencyTaskIds: input.dependencyTaskIds ?? [], controls,
      rollback: operation.compensationCapabilityId ? { mode: "capability", capabilityId: operation.compensationCapabilityId,
        planId: `rollback_${input.taskId}`, inputRef, justificationRef: inputRef,
        controls: { authority: controls.authority, approval: { ...controls.approval, state: "not_required" } } }
        : { mode: "not_required", justificationRef: inputRef } },
    ...(input.approved ? { approvalDecision: { decisionId: `approval_${input.taskId}`, decision: "approved" as const,
      policyId: approvalPolicyId, decidedBy: input.ownerId, evidenceRefs: [inputRef] } } : {}),
    payload: input.payload, outcomeEvidenceRefs: [], operatorOutcome: input.operatorOutcome
  });
}
