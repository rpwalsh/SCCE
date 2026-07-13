import type { CapabilityPlan, EmissionGraph, EpisodeId, Hasher, JsonValue, PolicyProfile } from "./types.js";
import { clamp01, createHasher, toJsonValue } from "./primitives.js";
import { createGovernedActionEnvelope } from "./governed-action.js";

export interface ActionGraph {
  id: string;
  episodeId: EpisodeId;
  nodes: Array<{ id: string; kind: string; label: string; metadata: JsonValue }>;
  edges: Array<{ source: string; target: string; relation: string; weight: number }>;
  risk: number;
  pendingApprovals: string[];
  audit: JsonValue;
}

export function createActionGraphBuilder(options: { hasher?: Hasher } = {}) {
  const governed = createGovernedActionEnvelope({ hasher: options.hasher ?? createHasher() });
  return {
    build(input: { episodeId: EpisodeId; plans: CapabilityPlan[]; emission?: EmissionGraph; policy: PolicyProfile }): ActionGraph {
      const governedSummary = governed.summarizePlans(input.plans, input.policy);
      const nodes: ActionGraph["nodes"] = [
        { id: "episode", kind: "episode", label: String(input.episodeId), metadata: {} },
        ...input.plans.map(plan => ({ id: String(plan.id), kind: `capability:${plan.status}`, label: plan.capabilityId, metadata: toJsonValue({ phase: plan.phase, permission: plan.permission, riskVector: plan.riskVector }) }))
      ];
      if (input.emission) nodes.push({ id: String(input.emission.id), kind: "emission", label: input.emission.epistemicForce, metadata: { proofId: input.emission.proofId, artifacts: input.emission.artifacts.length } });
      const edges: ActionGraph["edges"] = input.plans.map(plan => ({ source: "episode", target: String(plan.id), relation: plan.phase, weight: actionWeight(plan) }));
      if (input.emission) edges.push(...input.plans.map(plan => ({ source: String(plan.id), target: String(input.emission!.id), relation: "conditions_emission", weight: actionWeight(plan) })));
      const pendingApprovals = input.plans.filter(plan => {
        const permission = plan.permission as { dryRun?: boolean; allowed?: boolean };
        return !permission.allowed || permission.dryRun;
      }).map(plan => String(plan.id));
      const risk = clamp01(Math.max(0, ...input.plans.map(plan => riskOf(plan))) + (input.policy.allowMutation ? 0.05 : 0));
      const id = `action_graph:${String(input.episodeId)}:${input.plans.length}:${pendingApprovals.length}`;
      return { id, episodeId: input.episodeId, nodes, edges, risk, pendingApprovals, audit: toJsonValue({ risk, pendingApprovals, governed: governedSummary, plans: input.plans.map(plan => ({ id: plan.id, capabilityId: plan.capabilityId, status: plan.status, phase: plan.phase })) }) };
    }
  };
}

function actionWeight(plan: CapabilityPlan): number {
  const permission = plan.permission as { allowed?: boolean; dryRun?: boolean };
  const status = plan.status === "succeeded" ? 1 : plan.status === "failed" ? 0.1 : plan.status === "invoked" ? 0.65 : 0.35;
  return clamp01(status * (permission.allowed ? 1 : 0.35) * (permission.dryRun ? 0.5 : 1));
}

function riskOf(plan: CapabilityPlan): number {
  const risk = plan.riskVector as { risk?: number; mutates?: boolean };
  return clamp01((risk.risk ?? 0.5) + (risk.mutates ? 0.1 : 0));
}
