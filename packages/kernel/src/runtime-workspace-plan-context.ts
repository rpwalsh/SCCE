import { verifyPatchTransactionPlan, type PatchTransactionPlan } from "./patch-transaction.js";
import { toJsonValue } from "./primitives.js";
import type { ExplicitTurnRequirement } from "./turn-requirements.js";
import type { JsonValue } from "./types.js";

export const RUNTIME_WORKSPACE_PLAN_LIMIT = 4 as const;

export interface RuntimeWorkspacePlanContext {
  readonly plans: readonly PatchTransactionPlan[];
  readonly explicitRequirements: readonly ExplicitTurnRequirement[];
  readonly audit: JsonValue;
}

/**
 * Reads the host-owned workspace planning handoff. Public adapters must replace
 * this reserved metadata field rather than merging request metadata into it.
 * Every plan is content-address verified here before it can affect cognition.
 */
export function runtimeWorkspacePlanContext(
  metadata: JsonValue | undefined,
  requestText: string
): RuntimeWorkspacePlanContext {
  const root = jsonRecord(metadata);
  const runtime = jsonRecord(root.runtime);
  const rawPlans = runtime.workspacePlans;
  if (rawPlans === undefined) return emptyContext();
  if (!Array.isArray(rawPlans)) throw new Error("runtime workspace plan context must be an array");
  if (rawPlans.length > RUNTIME_WORKSPACE_PLAN_LIMIT) {
    throw new Error(`runtime workspace plan context exceeds ${RUNTIME_WORKSPACE_PLAN_LIMIT} plans`);
  }

  const plans: PatchTransactionPlan[] = [];
  const hashes = new Set<string>();
  for (const value of rawPlans) {
    const plan = value as unknown as PatchTransactionPlan;
    verifyPatchTransactionPlan(plan);
    if (hashes.has(plan.planHash)) throw new Error(`runtime workspace plan context contains duplicate plan: ${plan.planHash}`);
    hashes.add(plan.planHash);
    plans.push(plan);
  }
  if (plans.length === 0) return emptyContext();

  const charEnd = [...requestText].length;
  const explicitRequirements: ExplicitTurnRequirement[] = [
    structuredRequirement("executableArtifactDemand", 0.98, charEnd),
    structuredRequirement("actionCommitment", 0.55, charEnd),
    structuredRequirement("inferentialDepth", 0.72, charEnd)
  ];
  return {
    plans: Object.freeze([...plans]),
    explicitRequirements: Object.freeze(explicitRequirements),
    audit: toJsonValue({
      schema: "scce.runtime.workspace_plan_context.v1",
      planHashes: plans.map(plan => plan.planHash),
      planCount: plans.length,
      verification: "patch_transaction_hash_verified",
      authorizationGranted: false,
      executionState: "not_executed",
      requestSurfaceRoutingUsed: false
    })
  };
}

function structuredRequirement(
  dimension: ExplicitTurnRequirement["dimension"],
  value: number,
  charEnd: number
): ExplicitTurnRequirement {
  return {
    id: `requirement.runtime_workspace_plan.${dimension}.v1`,
    dimension,
    value,
    confidence: 1,
    polarity: "required",
    status: "explicit",
    span: { charStart: 0, charEnd },
    semanticRoleId: "role.runtime.workspace_plan.v1",
    learnedFrameOrPatternId: "pattern.runtime.workspace_plan.v1",
    sourceActivationId: "activation.runtime.workspace_plan.v1",
    trace: toJsonValue({ source: "runtime.workspacePlans", requestSurfaceRoutingUsed: false })
  };
}

function emptyContext(): RuntimeWorkspacePlanContext {
  return {
    plans: [],
    explicitRequirements: [],
    audit: toJsonValue({
      schema: "scce.runtime.workspace_plan_context.v1",
      planHashes: [],
      planCount: 0,
      verification: "not_applicable",
      authorizationGranted: false,
      executionState: "not_executed",
      requestSurfaceRoutingUsed: false
    })
  };
}

function jsonRecord(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, JsonValue>
    : {};
}
