// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { hashEvent } from "./events.js";
import {
  projectProgramBehaviorRoleExecutionSupport,
  verifyBehaviorRoleExecutionGraphInput,
  type BehaviorRoleExecutionGraphInput,
  type BehaviorRoleExecutionReceiptInput,
  type ProgramBehaviorRoleExecutionSupport
} from "./program-behavior-role-execution-support.js";
import { canonicalStringify } from "./primitives.js";
import type { EventLedger } from "./storage.js";
import type { Clock, EpisodeId, EventId, EventTypeId, Hasher, JsonValue, ScceEvent } from "./types.js";

export const PROGRAM_BEHAVIOR_VALIDATION_PLAN_BOUND_EVENT = "ProgramBehaviorValidationPlanBound" as const;
export const PROGRAM_BEHAVIOR_EXECUTION_SUPPORTED_EVENT = "ProgramBehaviorRoleExecutionSupported" as const;
export const PROGRAM_BEHAVIOR_VALIDATION_PLAN_BINDING_SCHEMA = "scce.program.behavior_validation_plan_binding.v2" as const;
export const PROGRAM_BEHAVIOR_EXECUTION_EVENT_SCHEMA = "scce.program.behavior_execution_event.v1" as const;

export interface ProgramBehaviorValidationPlanBinding {
  readonly schema: typeof PROGRAM_BEHAVIOR_VALIDATION_PLAN_BINDING_SCHEMA;
  readonly planHash: string;
  readonly validationPolicyId: string;
  /** Content identity of the complete server-owned policy and execution provider. */
  readonly validationBindingHash: string;
  readonly graph: BehaviorRoleExecutionGraphInput;
}

export interface ProgramBehaviorValidationLedger {
  bindPlan(binding: ProgramBehaviorValidationPlanBinding): Promise<void>;
  loadPlan(input: { readonly workspaceId: string; readonly planHash: string }): Promise<ProgramBehaviorValidationPlanBinding | null>;
  recordExecution(input: {
    readonly workspaceId: string;
    readonly planHash: string;
    readonly validationPolicyId: string;
    readonly validationBindingHash: string;
    readonly receipt: BehaviorRoleExecutionReceiptInput;
  }): Promise<readonly ProgramBehaviorRoleExecutionSupport[]>;
}

/** Uses the existing durable event ledger; no second program-learning store is introduced. */
export function createProgramBehaviorValidationLedger(deps: {
  readonly events: EventLedger;
  readonly clock: Clock;
  readonly hasher: Hasher;
}): ProgramBehaviorValidationLedger {
  const episodeFor = (workspaceId: string, planHash: string) => programBehaviorValidationEpisodeId(workspaceId, planHash, deps.hasher);
  return {
    async bindPlan(input) {
      const binding = verifyPlanBinding(input);
      const episodeId = episodeFor(binding.graph.workspaceRevision.workspaceId, binding.planHash);
      const events = await deps.events.readEpisode(episodeId);
      const existing = boundEvent(events);
      if (existing) {
        const stored = bindingFromEvent(existing);
        if (canonicalStringify(stored) !== canonicalStringify(binding)) {
          throw new Error(`program behavior validation plan binding is immutable: ${binding.planHash}`);
        }
        return;
      }
      await deps.events.append(ledgerEvent({
        episodeId,
        typeId: PROGRAM_BEHAVIOR_VALIDATION_PLAN_BOUND_EVENT,
        payload: binding,
        identity: canonicalStringify({
          workspaceId: binding.graph.workspaceRevision.workspaceId,
          planHash: binding.planHash
        }),
        clock: deps.clock,
        hasher: deps.hasher
      }));
      const stored = boundEvent(await deps.events.readEpisode(episodeId));
      if (!stored || canonicalStringify(bindingFromEvent(stored)) !== canonicalStringify(binding)) {
        throw new Error(`program behavior validation plan binding is immutable: ${binding.planHash}`);
      }
    },
    async loadPlan(input) {
      verifyId(input.workspaceId, "workspaceId");
      verifyHash(input.planHash, "planHash");
      const event = boundEvent(await deps.events.readEpisode(episodeFor(input.workspaceId, input.planHash)));
      return event ? bindingFromEvent(event) : null;
    },
    async recordExecution(input) {
      verifyId(input.workspaceId, "workspaceId");
      verifyHash(input.planHash, "planHash");
      verifyId(input.validationPolicyId, "validationPolicyId");
      verifyHash(input.validationBindingHash, "validationBindingHash");
      if (input.receipt.planHash !== input.planHash) throw new Error("program behavior execution receipt belongs to another plan");
      const episodeId = episodeFor(input.workspaceId, input.planHash);
      const events = await deps.events.readEpisode(episodeId);
      const bindingEvent = boundEvent(events);
      if (!bindingEvent) throw new Error(`program behavior validation plan binding is absent: ${input.planHash}`);
      const binding = bindingFromEvent(bindingEvent);
      if (binding.graph.workspaceRevision.workspaceId !== input.workspaceId) throw new Error("program behavior execution workspace does not match the plan binding");
      if (binding.validationPolicyId !== input.validationPolicyId) throw new Error("program behavior execution validation policy does not match the plan binding");
      if (binding.validationBindingHash !== input.validationBindingHash) throw new Error("program behavior execution validation binding does not match the plan binding");
      const supports = projectProgramBehaviorRoleExecutionSupport({ graph: binding.graph, receipt: input.receipt }, deps.hasher);
      if (supports.length === 0) return [];
      const existing = events.find(event => String(event.typeId) === PROGRAM_BEHAVIOR_EXECUTION_SUPPORTED_EVENT);
      if (existing) {
        const stored = executionFromEvent(existing, binding, deps.hasher);
        if (canonicalStringify(stored.receipt) !== canonicalStringify(input.receipt)) {
          throw new Error(`program behavior execution support is immutable: ${input.planHash}`);
        }
        return stored.supports;
      }
      await deps.events.append(ledgerEvent({
        episodeId,
        typeId: PROGRAM_BEHAVIOR_EXECUTION_SUPPORTED_EVENT,
        payload: {
          schema: PROGRAM_BEHAVIOR_EXECUTION_EVENT_SCHEMA,
          planHash: input.planHash,
          receipt: input.receipt,
          supports
        },
        parents: [bindingEvent],
        identity: canonicalStringify({ workspaceId: input.workspaceId, planHash: input.planHash }),
        clock: deps.clock,
        hasher: deps.hasher
      }));
      const storedEvent = (await deps.events.readEpisode(episodeId))
        .find(event => String(event.typeId) === PROGRAM_BEHAVIOR_EXECUTION_SUPPORTED_EVENT);
      if (!storedEvent) throw new Error(`program behavior execution support was not persisted: ${input.planHash}`);
      const stored = executionFromEvent(storedEvent, binding, deps.hasher);
      if (canonicalStringify(stored.receipt) !== canonicalStringify(input.receipt)) {
        throw new Error(`program behavior execution support is immutable: ${input.planHash}`);
      }
      return stored.supports;
    }
  };
}

function ledgerEvent(input: {
  readonly episodeId: EpisodeId;
  readonly typeId: string;
  readonly payload: unknown;
  readonly identity: string;
  readonly parents?: readonly ScceEvent[];
  readonly clock: Clock;
  readonly hasher: Hasher;
}): ScceEvent {
  const parents = input.parents ?? [];
  const eventWithoutHash: Omit<ScceEvent, "hash"> = {
    id: `event_program_behavior_${input.hasher.digestHex(`${input.typeId}\u001f${input.identity}`).slice(0, 48)}` as EventId,
    episodeId: input.episodeId,
    typeId: input.typeId as EventTypeId,
    t: input.clock.now(),
    payload: JSON.parse(JSON.stringify(input.payload)) as JsonValue,
    parents: parents.map(parent => parent.id)
  };
  return { ...eventWithoutHash, hash: hashEvent(eventWithoutHash, parents.map(parent => parent.hash), input.hasher) };
}

export function programBehaviorValidationEpisodeId(workspaceId: string, planHash: string, hasher: Hasher): EpisodeId {
  verifyId(workspaceId, "workspaceId");
  verifyHash(planHash, "planHash");
  return `episode_program_behavior_${hasher.digestHex(canonicalStringify({ workspaceId, planHash })).slice(0, 40)}` as EpisodeId;
}

function verifyPlanBinding(input: ProgramBehaviorValidationPlanBinding): ProgramBehaviorValidationPlanBinding {
  if (input.schema !== PROGRAM_BEHAVIOR_VALIDATION_PLAN_BINDING_SCHEMA) throw new Error("unsupported program behavior validation binding schema");
  verifyHash(input.planHash, "planHash");
  verifyId(input.validationPolicyId, "validationPolicyId");
  verifyHash(input.validationBindingHash, "validationBindingHash");
  verifyBehaviorRoleExecutionGraphInput(input.graph);
  return deepFreeze({ ...input, graph: input.graph });
}

function boundEvent(events: readonly ScceEvent[]): ScceEvent | undefined {
  const matches = events.filter(event => String(event.typeId) === PROGRAM_BEHAVIOR_VALIDATION_PLAN_BOUND_EVENT);
  if (matches.length > 1) throw new Error("program behavior validation episode has multiple plan bindings");
  return matches[0];
}

function bindingFromEvent(event: ScceEvent): ProgramBehaviorValidationPlanBinding {
  const value = jsonRecord(event.payload, "program behavior validation binding event");
  return verifyPlanBinding({
    schema: value.schema as typeof PROGRAM_BEHAVIOR_VALIDATION_PLAN_BINDING_SCHEMA,
    planHash: stringValue(value.planHash, "binding planHash"),
    validationPolicyId: stringValue(value.validationPolicyId, "binding validationPolicyId"),
    validationBindingHash: stringValue(value.validationBindingHash, "binding validationBindingHash"),
    graph: value.graph as unknown as BehaviorRoleExecutionGraphInput
  });
}

function executionFromEvent(event: ScceEvent, binding: ProgramBehaviorValidationPlanBinding, hasher: Hasher): {
  receipt: BehaviorRoleExecutionReceiptInput;
  supports: readonly ProgramBehaviorRoleExecutionSupport[];
} {
  const value = jsonRecord(event.payload, "program behavior execution event");
  if (value.schema !== PROGRAM_BEHAVIOR_EXECUTION_EVENT_SCHEMA || value.planHash !== binding.planHash) {
    throw new Error("program behavior execution event identity is invalid");
  }
  const receipt = value.receipt as unknown as BehaviorRoleExecutionReceiptInput;
  const supports = projectProgramBehaviorRoleExecutionSupport({ graph: binding.graph, receipt }, hasher);
  if (canonicalStringify(value.supports) !== canonicalStringify(supports)) throw new Error("program behavior execution event support is invalid");
  return { receipt, supports };
}

function jsonRecord(value: JsonValue, label: string): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} is invalid`);
  return value as Record<string, JsonValue>;
}

function stringValue(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is invalid`);
  return value;
}

function verifyHash(value: string, label: string): void {
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) throw new Error(`${label} must be a SHA-256 content hash`);
}

function verifyId(value: string, label: string): void {
  if (!value || value.trim() !== value) throw new Error(`${label} must be a non-empty identifier`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const item of Object.values(value as Record<string, unknown>)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}
