import { jsonRecord } from "./kernel-answer-primitives.js";
import { toJsonValue } from "./primitives.js";
import type {
  CapabilityPlan,
  ConstructGraph,
  JsonValue
} from "./types.js";

export function previewTraceText(value: string, maxChars = 600): string {
  return value.length <= maxChars ? value : `${value.slice(0, maxChars)}...`;
}

export function afterTurnMaintenanceDecision(input: {
  translationTarget?: string;
  construct: ConstructGraph;
  capabilityPlans: readonly CapabilityPlan[];
  assistantForce?: string;
}): {
  deferred: boolean;
  audit: JsonValue;
} {
  const required: string[] = [];
  if (input.translationTarget) required.push("maintenance.required.translation");
  if (input.construct.program) required.push("maintenance.required.program_construct");
  if (input.construct.artifacts.length > 0) required.push("maintenance.required.artifact_emission");
  if (capabilityPlansRequireForeground(input.capabilityPlans)) {
    required.push("maintenance.required.capability_plan");
  }
  const deferred = required.length === 0;
  const deferredStages = deferred
    ? [
        "language_acquisition",
        "learning_loop",
        "training_plan",
        "self_model",
        "self_distillation",
        "functional_cognition",
        "forecast_persistence"
      ]
    : [];
  return {
    deferred,
    audit: toJsonValue({
      source: "kernel.turn.maintenance_boundary",
      deferred,
      required,
      deferredStages,
      assistantForce: input.assistantForce ?? null
    })
  };
}

function capabilityPlansRequireForeground(plans: readonly CapabilityPlan[]): boolean {
  return plans.some(plan => {
    if (
      plan.status === "invoked"
      || plan.status === "succeeded"
      || plan.status === "failed"
      || plan.status === "rolled_back"
    ) {
      return true;
    }
    const permission = jsonRecord(plan.permission);
    return permission.allowed === true && permission.dryRun === false;
  });
}
