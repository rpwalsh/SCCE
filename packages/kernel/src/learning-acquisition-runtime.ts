// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createIdFactory } from "./ids.js";
import { type LearningLoopPlan, type LearningSourcePlan } from "./learning-loop.js";
import { formatSurfaceMessage } from "./localization.js";
import { toJsonValue } from "./primitives.js";
import { createActionPlanner, createCapabilityRegistry } from "./safety.js";
import type {
  CapabilityPlan,
  EpisodeId,
  EvidenceSpan,
  JsonValue,
  PolicyProfile,
  TurnResult
} from "./types.js";

export function learningAcquisitionCapabilityPlans(input: {
  episodeId: EpisodeId;
  learningLoopPlan: LearningLoopPlan;
  policy: PolicyProfile;
  connectorsConfigured: boolean;
  idFactory: ReturnType<typeof createIdFactory>;
  now: number;
}): CapabilityPlan[] {
  const registry = createCapabilityRegistry({
    filesystem: true,
    process: true,
    network: input.connectorsConfigured,
    outlook: input.connectorsConfigured,
    youtube: input.connectorsConfigured,
    telephone: input.connectorsConfigured
  });
  const planner = createActionPlanner({ idFactory: input.idFactory, policy: input.policy });
  const sourcePlans = [
    ...input.learningLoopPlan.learningNeeds.flatMap(need => need.sourcePlans),
    ...input.learningLoopPlan.globalSources
  ]
    .filter(plan => plan.acquisition.acquire)
    .sort((a, b) => b.utility - a.utility || b.expectedValue - a.expectedValue);
  const seen = new Set<string>();
  const out: CapabilityPlan[] = [];
  for (const sourcePlan of sourcePlans) {
    if (out.length >= 12) break;
    const key = `${sourcePlan.capabilityId}:${sourcePlan.query}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const capability = registry.get(sourcePlan.capabilityId);
    if (!capability) continue;
    const payload = learningAcquisitionPayload(sourcePlan);
    const plan = planner.plan({
      episodeId: input.episodeId,
      capability,
      payload,
      now: input.now + out.length,
      approved: false
    });
    // Self-set curriculum never reaches the network on its own: a network plan waits in the approval session until the owner lets it learn.
    out.push(capability.kind === "network"
      ? { ...plan, phase: "prepare", permission: { allowed: false, dryRun: true, requiresExplicitApproval: true, reason: "owner-consent-required" } }
      : plan);
  }
  return out;
}

function learningAcquisitionPayload(plan: LearningSourcePlan): JsonValue {
  return toJsonValue({
    kind: "learning_source_acquisition",
    sourcePlanId: plan.id,
    sourceKind: plan.kind,
    query: plan.query,
    evi: plan.expectedValue,
    utility: plan.utility,
    capabilityId: plan.capabilityId,
    acquisition: {
      stages: [
        plan.acquisition.acquire ? "acquisition" : undefined,
        plan.acquisition.quarantine ? "quarantine" : undefined,
        plan.acquisition.extract ? "extraction" : undefined,
        plan.acquisition.validate ? "validation" : undefined,
        plan.acquisition.promote,
        plan.acquisition.graphUpdate ? "graph_update" : undefined
      ].filter(Boolean),
      quarantineRequired: plan.acquisition.quarantine,
      promotion: plan.acquisition.promote,
      mutatingCommitAllowed: false
    },
    objective: {
      expectedInformationGain: plan.expectedInformationGain,
      taskProgress: plan.taskProgress,
      proofValue: plan.proofValue,
      cost: plan.cost,
      risk: plan.risk,
      permissionPenalty: plan.permissionPenalty
    },
    rationale: plan.rationale
  });
}

export function learningNeedsFor(
  text: string,
  entailment: TurnResult["entailment"],
  evidence: EvidenceSpan[],
  locale?: string
): string[] {
  // An unresolved message key yields an empty string, and pushing that produced needs with no text: a caller
  // counting them saw work to do and had nothing to show for it. Only messages that actually resolved are needs.
  const needs: string[] = [];
  if (evidence.length < 2 || entailment.faithfulnessLcb < 0.2) {
    const need = formatSurfaceMessage("learning.need.evidence", { text: text.slice(0, 180) }, locale);
    if (need) needs.push(need);
  }
  if (entailment.contradiction > 0.2) {
    const need = formatSurfaceMessage(
      "learning.need.contradiction",
      { claim: entailment.claim.normalized.slice(0, 180) },
      locale
    );
    if (need) needs.push(need);
  }
  return needs;
}

export function languageScore(evidence: EvidenceSpan[]): number {
  const scripts = new Set(
    evidence.flatMap(span =>
      ((span.languageHints as { scripts?: Array<{ script: string }> }).scripts ?? [])
        .map(item => item.script)
    )
  );
  return scripts.size > 1 ? 0.8 : scripts.size === 1 ? 0.55 : 0.3;
}
