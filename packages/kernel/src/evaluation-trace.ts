import {
  assertValidEvaluationCondition,
  conditionDisablesComponent,
  type EvaluationComponentId,
  type EvaluationConditionConfig
} from "./evaluation-flags.js";

export type EvaluationTraceEventName = "componentEntered" | "componentBypassed" | "cacheRead";

interface EvaluationTraceEventBase {
  readonly schemaVersion: "1.0";
  readonly event: EvaluationTraceEventName;
  readonly traceId: string;
  readonly runId: string;
  readonly questionId: string;
  readonly conditionId: EvaluationConditionConfig["conditionId"];
  readonly configHash: string;
  readonly cacheNamespace: string;
  readonly sequence: number;
  readonly time: string;
  readonly component: EvaluationComponentId;
  readonly boundary: string;
}

export interface ComponentEnteredEvent extends EvaluationTraceEventBase {
  readonly event: "componentEntered";
}

export interface ComponentBypassedEvent extends EvaluationTraceEventBase {
  readonly event: "componentBypassed";
  readonly reason: "condition-disabled" | "not-applicable";
}

export interface CacheReadEvent extends EvaluationTraceEventBase {
  readonly event: "cacheRead";
  readonly cacheKey: string;
  readonly cacheOwnerConditionId: EvaluationConditionConfig["conditionId"];
  readonly cacheOwnerConfigHash: string;
  readonly cacheOwnerNamespace: string;
  readonly hit: boolean;
}

export type EvaluationTraceEvent = ComponentEnteredEvent | ComponentBypassedEvent | CacheReadEvent;

export interface EvaluationTraceIdentity {
  readonly traceId: string;
  readonly runId: string;
  readonly questionId: string;
}

export interface EvaluationCacheOwner {
  readonly conditionId: EvaluationConditionConfig["conditionId"];
  readonly configHash: string;
  readonly cacheNamespace: string;
}

export interface EvaluationTraceRecorder {
  componentEntered(component: EvaluationComponentId, boundary: string): ComponentEnteredEvent;
  componentBypassed(component: EvaluationComponentId, boundary: string, reason?: ComponentBypassedEvent["reason"]): ComponentBypassedEvent;
  cacheRead(input: {
    readonly component: EvaluationComponentId;
    readonly boundary: string;
    readonly cacheKey: string;
    readonly owner: EvaluationCacheOwner;
    readonly hit: boolean;
  }): CacheReadEvent;
  events(): readonly EvaluationTraceEvent[];
}

export interface EvaluationTraceViolation {
  readonly code:
    | "TRACE_EMPTY"
    | "EVENT_CONDITION_MISMATCH"
    | "EVENT_CONFIG_MISMATCH"
    | "EVENT_NAMESPACE_MISMATCH"
    | "EVENT_SEQUENCE_INVALID"
    | "DISABLED_COMPONENT_ENTERED"
    | "DISABLED_COMPONENT_CACHE_READ"
    | "DISABLED_COMPONENT_BYPASS_MISSING"
    | "CACHE_KEY_NAMESPACE_MISMATCH"
    | "CACHE_OWNER_CONDITION_MISMATCH"
    | "CACHE_OWNER_CONFIG_MISMATCH"
    | "CACHE_OWNER_NAMESPACE_MISMATCH";
  readonly message: string;
  readonly eventIndex?: number;
  readonly component?: EvaluationComponentId;
}

export interface EvaluationTraceVerification {
  readonly schemaVersion: "1.0";
  readonly valid: boolean;
  readonly conditionId: EvaluationConditionConfig["conditionId"];
  readonly configHash: string;
  readonly eventCount: number;
  readonly disabledComponents: readonly EvaluationComponentId[];
  readonly bypassedDisabledComponents: readonly EvaluationComponentId[];
  readonly violations: readonly EvaluationTraceViolation[];
}

export function createEvaluationTrace(
  condition: EvaluationConditionConfig,
  identity: EvaluationTraceIdentity,
  options: {
    readonly nowIso?: () => string;
    readonly sink?: (event: EvaluationTraceEvent) => void;
  } = {}
): EvaluationTraceRecorder {
  assertValidEvaluationCondition(condition);
  assertNonEmpty(identity.traceId, "traceId");
  assertNonEmpty(identity.runId, "runId");
  assertNonEmpty(identity.questionId, "questionId");
  const recorded: EvaluationTraceEvent[] = [];
  const nowIso = options.nowIso ?? (() => condition.clockIso);

  const base = (component: EvaluationComponentId, boundary: string): Omit<EvaluationTraceEventBase, "event"> => {
    assertNonEmpty(boundary, "component boundary");
    const eventBase = {
      schemaVersion: "1.0" as const,
      traceId: identity.traceId,
      runId: identity.runId,
      questionId: identity.questionId,
      conditionId: condition.conditionId,
      configHash: condition.configHash,
      cacheNamespace: condition.cacheNamespace,
      sequence: recorded.length,
      time: nowIso(),
      component,
      boundary
    };
    if (!Number.isFinite(Date.parse(eventBase.time))) throw new Error("evaluation trace clock returned an invalid timestamp");
    return eventBase;
  };

  const add = <T extends EvaluationTraceEvent>(event: T): T => {
    Object.freeze(event);
    recorded.push(event);
    options.sink?.(event);
    return event;
  };

  return Object.freeze({
    componentEntered(component: EvaluationComponentId, boundary: string) {
      return add({ ...base(component, boundary), event: "componentEntered" });
    },
    componentBypassed(component: EvaluationComponentId, boundary: string, reason: ComponentBypassedEvent["reason"] = "condition-disabled") {
      return add({ ...base(component, boundary), event: "componentBypassed", reason });
    },
    cacheRead(input: {
      readonly component: EvaluationComponentId;
      readonly boundary: string;
      readonly cacheKey: string;
      readonly owner: EvaluationCacheOwner;
      readonly hit: boolean;
    }) {
      assertNonEmpty(input.cacheKey, "cache key");
      return add({
        ...base(input.component, input.boundary),
        event: "cacheRead",
        cacheKey: input.cacheKey,
        cacheOwnerConditionId: input.owner.conditionId,
        cacheOwnerConfigHash: input.owner.configHash,
        cacheOwnerNamespace: input.owner.cacheNamespace,
        hit: input.hit
      });
    },
    events() {
      return Object.freeze([...recorded]);
    }
  });
}

export function executeEvaluationComponent<T>(input: {
  readonly condition: EvaluationConditionConfig;
  readonly trace: EvaluationTraceRecorder;
  readonly component: EvaluationComponentId;
  readonly boundary: string;
  readonly execute: () => T;
  readonly bypass: () => T;
}): T {
  if (conditionDisablesComponent(input.condition, input.component)) {
    input.trace.componentBypassed(input.component, input.boundary, "condition-disabled");
    return input.bypass();
  }
  input.trace.componentEntered(input.component, input.boundary);
  return input.execute();
}

export function currentEvaluationCacheOwner(condition: EvaluationConditionConfig): EvaluationCacheOwner {
  assertValidEvaluationCondition(condition);
  return Object.freeze({
    conditionId: condition.conditionId,
    configHash: condition.configHash,
    cacheNamespace: condition.cacheNamespace
  });
}

export function verifyEvaluationTrace(
  condition: EvaluationConditionConfig,
  events: readonly EvaluationTraceEvent[]
): EvaluationTraceVerification {
  assertValidEvaluationCondition(condition);
  const violations: EvaluationTraceViolation[] = [];
  const bypassed = new Set<EvaluationComponentId>();
  if (events.length === 0) violations.push({ code: "TRACE_EMPTY", message: "evaluation trace contains no component-boundary events" });

  events.forEach((event, eventIndex) => {
    if (event.conditionId !== condition.conditionId) add("EVENT_CONDITION_MISMATCH", "event condition does not match evaluated condition", eventIndex, event.component);
    if (event.configHash !== condition.configHash) add("EVENT_CONFIG_MISMATCH", "event config hash does not match evaluated configuration", eventIndex, event.component);
    if (event.cacheNamespace !== condition.cacheNamespace) add("EVENT_NAMESPACE_MISMATCH", "event cache namespace does not match evaluated configuration", eventIndex, event.component);
    if (event.sequence !== eventIndex) add("EVENT_SEQUENCE_INVALID", "event sequence is not contiguous from zero", eventIndex, event.component);

    const disabled = conditionDisablesComponent(condition, event.component);
    if (event.event === "componentBypassed" && disabled && event.reason === "condition-disabled") bypassed.add(event.component);
    if (event.event === "componentEntered" && disabled) add("DISABLED_COMPONENT_ENTERED", "disabled component was entered", eventIndex, event.component);
    if (event.event === "cacheRead") {
      if (disabled) add("DISABLED_COMPONENT_CACHE_READ", "disabled component attempted a cache read", eventIndex, event.component);
      if (!event.cacheKey.startsWith(`${condition.cacheNamespace}:`)) add("CACHE_KEY_NAMESPACE_MISMATCH", "cache key is outside the condition namespace", eventIndex, event.component);
      if (event.cacheOwnerConditionId !== condition.conditionId) add("CACHE_OWNER_CONDITION_MISMATCH", "cache entry was produced by another condition", eventIndex, event.component);
      if (event.cacheOwnerConfigHash !== condition.configHash) add("CACHE_OWNER_CONFIG_MISMATCH", "cache entry was produced by another configuration", eventIndex, event.component);
      if (event.cacheOwnerNamespace !== condition.cacheNamespace) add("CACHE_OWNER_NAMESPACE_MISMATCH", "cache entry owner namespace does not match the active namespace", eventIndex, event.component);
    }
  });

  for (const component of condition.disabledComponents) {
    if (!bypassed.has(component)) add("DISABLED_COMPONENT_BYPASS_MISSING", "disabled component has no explicit condition-disabled bypass event", undefined, component);
  }

  return Object.freeze({
    schemaVersion: "1.0",
    valid: violations.length === 0,
    conditionId: condition.conditionId,
    configHash: condition.configHash,
    eventCount: events.length,
    disabledComponents: Object.freeze([...condition.disabledComponents]),
    bypassedDisabledComponents: Object.freeze([...bypassed]),
    violations: Object.freeze(violations)
  });

  function add(
    code: EvaluationTraceViolation["code"],
    message: string,
    eventIndex?: number,
    component?: EvaluationComponentId
  ): void {
    violations.push({ code, message, ...(eventIndex === undefined ? {} : { eventIndex }), ...(component === undefined ? {} : { component }) });
  }
}

function assertNonEmpty(value: string, name: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${name} must be a non-empty string`);
}
