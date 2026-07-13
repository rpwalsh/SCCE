import type { Capability, CapabilityPlan, EpisodeId, PolicyProfile } from "./types.js";
import type { IdFactory } from "./ids.js";
import { clamp01, toJsonValue } from "./primitives.js";

export const DEFAULT_POLICY: PolicyProfile = {
  allowMutation: false,
  requireTwoPhaseCommit: true,
  dryRunByDefault: true,
  maxNetworkRequests: 12,
  maxToolCalls: 24,
  maxSpendCents: 0,
  alphaRiskCeiling: 0.55,
  encryptSecretsAtRest: true
};

export type CapabilityConfig = Partial<Record<Capability["kind"] | string, boolean>>;

export function createCapabilityRegistry(configured: CapabilityConfig = {}) {
  const capabilities: Capability[] = [
    capability("filesystem.read", "filesystem", false, 0.1, false, configured["filesystem.read"] ?? configured.filesystem ?? true),
    capability("filesystem.write", "filesystem", true, 0.45, true, configured["filesystem.write"] ?? configured.filesystem ?? true),
    capability("process.build_test", "process", true, 0.5, true, configured["process.build_test"] ?? configured.process ?? true),
    capability("network.fetch", "network", false, 0.35, false, configured["network.fetch"] ?? configured.network ?? false),
    capability("network.search", "network", false, 0.32, false, configured["network.search"] ?? configured.network ?? false),
    capability("outlook.search_mail", "outlook", false, 0.24, false, configured["outlook.search_mail"] ?? configured.outlook ?? false),
    capability("outlook.read_mail", "outlook", false, 0.28, false, configured["outlook.read_mail"] ?? configured.outlook ?? false),
    capability("outlook.create_draft", "outlook", true, 0.54, true, configured["outlook.create_draft"] ?? configured.outlook ?? false),
    capability("outlook.send_mail", "outlook", true, 0.82, true, configured["outlook.send_mail"] ?? configured.outlook ?? false),
    capability("outlook.read_calendar", "outlook", false, 0.32, false, configured["outlook.read_calendar"] ?? configured.outlook ?? false),
    capability("outlook.create_calendar_event", "outlook", true, 0.74, true, configured["outlook.create_calendar_event"] ?? configured.outlook ?? false),
    capability("outlook.read_contacts", "outlook", false, 0.35, false, configured["outlook.read_contacts"] ?? configured.outlook ?? false),
    capability("youtube.search", "youtube", false, 0.24, false, configured["youtube.search"] ?? configured.youtube ?? false),
    capability("youtube.read_video_metadata", "youtube", false, 0.24, false, configured["youtube.read_video_metadata"] ?? configured.youtube ?? false),
    capability("youtube.read_channel_metadata", "youtube", false, 0.24, false, configured["youtube.read_channel_metadata"] ?? configured.youtube ?? false),
    capability("youtube.read_comments", "youtube", false, 0.34, false, configured["youtube.read_comments"] ?? configured.youtube ?? false),
    capability("telephone.call", "telephone", true, 0.95, true, configured["telephone.call"] ?? configured.telephone ?? false)
  ];
  return {
    all: () => capabilities.slice(),
    get: (id: string) => capabilities.find(item => item.id === id)
  };
}

export function createActionPlanner(options: { idFactory: IdFactory; policy: PolicyProfile }) {
  return {
    plan(input: { episodeId: EpisodeId; capability: Capability; payload: unknown; approved?: boolean; now: number }): CapabilityPlan {
      const decision = decide(input.capability, options.policy, input.approved);
      return {
        id: options.idFactory.capabilityCallId({ episodeId: input.episodeId, capabilityId: input.capability.id, payload: input.payload, now: input.now }),
        episodeId: input.episodeId,
        capabilityId: input.capability.id,
        phase: decision.phase,
        status: "planned",
        input: toJsonValue(input.payload),
        riskVector: { risk: input.capability.risk, mutates: input.capability.mutates },
        permission: decision,
        createdAt: input.now
      };
    }
  };
}

function capability(id: string, kind: Capability["kind"], mutates: boolean, risk: number, requiresApproval: boolean, configured: boolean): Capability {
  return { id, label: id, kind, mutates, risk, requiresApproval, configured, metadata: {} };
}

function decide(capability: Capability, policy: PolicyProfile, approved?: boolean) {
  if (!capability.configured) return { allowed: false, dryRun: true, phase: "prepare" as const, reason: "capability-not-configured" };
  if (clamp01(capability.risk) > policy.alphaRiskCeiling) return { allowed: false, dryRun: true, phase: "prepare" as const, reason: "alpha-risk-ceiling" };
  if (!capability.mutates) return { allowed: true, dryRun: false, phase: "read" as const, reason: "read-only" };
  if (approved) return { allowed: true, dryRun: false, phase: "commit" as const, reason: "operator-approved" };
  if (!policy.allowMutation) return { allowed: true, dryRun: true, phase: "prepare" as const, reason: "awaiting-operator-approval" };
  if (capability.requiresApproval && !approved) return { allowed: false, dryRun: true, phase: "prepare" as const, reason: "approval-required" };
  return { allowed: true, dryRun: policy.dryRunByDefault || policy.requireTwoPhaseCommit, phase: policy.requireTwoPhaseCommit ? ("prepare" as const) : ("commit" as const), reason: policy.requireTwoPhaseCommit ? "two-phase-prepare" : "commit-allowed" };
}
