import type { Capability, CapabilityPlan, Hasher, JsonValue, PolicyProfile } from "./types.js";
import { clamp01, createHasher, toJsonValue } from "./primitives.js";

export type ConnectorKind = "filesystem" | "process" | "web_search" | "web_fetch" | "outlook" | "youtube" | "telephone";
export type ConnectorPhase = "read" | "prepare" | "commit";
export type WebSearchProvider = "duckduckgo" | "bing" | "brave" | "serpapi" | "tavily";

export interface ConnectorConfig {
  id: string;
  kind: ConnectorKind;
  enabled: boolean;
  provider?: WebSearchProvider | "microsoft_graph" | "youtube_data" | "twilio" | "local";
  baseUrl?: string;
  secretRef?: string;
  limits: {
    requestsPerMinute: number;
    requestsPerSession: number;
    maxBytesPerResponse: number;
    maxSpendCents: number;
  };
  allowedOperations: string[];
  approval: {
    requiredForRead: boolean;
    requiredForPrepare: boolean;
    requiredForCommit: boolean;
    operatorGrantEligible: boolean;
  };
  metadata?: JsonValue;
}

export interface ConnectorQuotaState {
  connectorId: string;
  sessionId: string;
  requestsUsed: number;
  bytesRead: number;
  spendCents: number;
  lastRequestAt?: number;
  failures: number;
}

export interface ConnectorAdmission {
  allowed: boolean;
  mode: "allow" | "approval_required" | "quota_exceeded" | "disabled" | "policy_blocked" | "cooldown";
  connectorId: string;
  phase: ConnectorPhase;
  risk: number;
  reasons: string[];
  approvalTicket?: ConnectorApprovalTicket;
  audit: JsonValue;
}

export interface ConnectorApprovalTicket {
  id: string;
  connectorId: string;
  planId?: string;
  title: string;
  body: string;
  operatorGrantEligible: boolean;
  expiresAt: number;
  risk: number;
  payloadPreview: string;
}

export interface ConnectorResultAdmission {
  accepted: boolean;
  connectorId: string;
  byteLength: number;
  evidenceTrust: number;
  quarantine: boolean;
  reasons: string[];
  eventPayload: JsonValue;
}

export function createConnectorGovernance(options: { hasher?: Hasher; now?: () => number } = {}) {
  const hasher = options.hasher ?? createHasher();
  const now = options.now ?? (() => Date.now());
  return {
    capabilities(configs: ConnectorConfig[]): Capability[] {
      return configs.map(configToCapability);
    },

    validateConfig(configs: ConnectorConfig[]): Array<{ id: string; passed: boolean; message: string }> {
      return validateConnectorConfigs(configs);
    },

    admit(input: {
      config: ConnectorConfig;
      quota: ConnectorQuotaState;
      phase: ConnectorPhase;
      policy: PolicyProfile;
      plan?: CapabilityPlan;
      payload?: JsonValue;
      temporaryOperatorGrant?: boolean;
    }): ConnectorAdmission {
      const t = now();
      const risk = connectorRisk(input.config, input.phase, input.payload, input.plan);
      const reasons: string[] = [];
      if (!input.config.enabled) reasons.push("connector disabled in config file");
      if (risk > input.policy.alphaRiskCeiling) reasons.push(`risk ${risk.toFixed(3)} exceeds ceiling ${input.policy.alphaRiskCeiling.toFixed(3)}`);
      if (input.phase === "commit" && !input.policy.allowMutation) reasons.push("policy disallows mutation");
      if (input.quota.requestsUsed >= input.config.limits.requestsPerSession) reasons.push("session request quota exhausted");
      if (input.quota.spendCents >= Math.min(input.config.limits.maxSpendCents, input.policy.maxSpendCents)) reasons.push("spend cap exhausted");
      if (input.quota.lastRequestAt && t - input.quota.lastRequestAt < 60000 / Math.max(1, input.config.limits.requestsPerMinute)) reasons.push("rate limit cooldown active");
      const needsApproval = approvalRequired(input.config, input.phase, risk, input.policy);
      const operatorGrantAllows = Boolean(input.temporaryOperatorGrant && input.config.approval.operatorGrantEligible && input.phase !== "commit" && risk < Math.min(0.78, input.policy.alphaRiskCeiling));
      const allowed = input.config.enabled && reasons.length === 0 && (!needsApproval || operatorGrantAllows);
      const mode: ConnectorAdmission["mode"] = allowed
        ? "allow"
        : !input.config.enabled
          ? "disabled"
          : reasons.some(reason => reason.includes("quota") || reason.includes("spend cap"))
            ? "quota_exceeded"
            : reasons.some(reason => reason.includes("cooldown"))
              ? "cooldown"
              : reasons.some(reason => reason.includes("policy") || reason.includes("ceiling"))
                ? "policy_blocked"
                : "approval_required";
      const approvalTicket = !allowed && mode === "approval_required"
        ? approvalTicketFor({ config: input.config, plan: input.plan, phase: input.phase, risk, payload: input.payload, t, hasher })
        : undefined;
      return {
        allowed,
        mode,
        connectorId: input.config.id,
        phase: input.phase,
        risk,
        reasons: reasons.length ? reasons : needsApproval && !operatorGrantAllows ? ["explicit approval required"] : ["admitted"],
        approvalTicket,
        audit: toJsonValue({
          connectorId: input.config.id,
          phase: input.phase,
          risk,
          quota: input.quota,
          policy: {
            allowMutation: input.policy.allowMutation,
            maxNetworkRequests: input.policy.maxNetworkRequests,
            maxSpendCents: input.policy.maxSpendCents,
            alphaRiskCeiling: input.policy.alphaRiskCeiling
          },
          temporaryOperatorGrant: input.temporaryOperatorGrant,
          approvalRequired: needsApproval,
          operatorGrantAllows,
          mode
        })
      };
    },

    admitResult(input: {
      config: ConnectorConfig;
      payload: JsonValue;
      byteLength: number;
      statusCode?: number;
      contentType?: string;
      elapsedMs: number;
      plan?: CapabilityPlan;
    }): ConnectorResultAdmission {
      return admitConnectorResult(input);
    },

    updateQuota(input: { quota: ConnectorQuotaState; result: ConnectorResultAdmission; spendCents?: number; t?: number }): ConnectorQuotaState {
      return {
        ...input.quota,
        requestsUsed: input.quota.requestsUsed + 1,
        bytesRead: input.quota.bytesRead + input.result.byteLength,
        spendCents: input.quota.spendCents + (input.spendCents ?? 0),
        lastRequestAt: input.t ?? now(),
        failures: input.result.accepted ? input.quota.failures : input.quota.failures + 1
      };
    }
  };
}

export function defaultConnectorConfigs(): ConnectorConfig[] {
  return [
    connector("filesystem.local", "filesystem", "local", true, ["read", "list", "stat", "prepare_write", "commit_write"], { read: false, prepare: false, commit: true }, { requestsPerMinute: 120, requestsPerSession: 10000, maxBytesPerResponse: 128 * 1024 * 1024, maxSpendCents: 0 }),
    connector("process.local", "process", "local", true, ["diagnose", "extract", "build", "test", "repair"], { read: false, prepare: true, commit: true }, { requestsPerMinute: 30, requestsPerSession: 1000, maxBytesPerResponse: 16 * 1024 * 1024, maxSpendCents: 0 }),
    connector("search.duckduckgo", "web_search", "duckduckgo", true, ["search"], { read: false, prepare: false, commit: false }, { requestsPerMinute: 30, requestsPerSession: 300, maxBytesPerResponse: 2 * 1024 * 1024, maxSpendCents: 0 }),
    connector("search.bing", "web_search", "bing", false, ["search"], { read: false, prepare: false, commit: true }, { requestsPerMinute: 60, requestsPerSession: 500, maxBytesPerResponse: 2 * 1024 * 1024, maxSpendCents: 1000 }),
    connector("search.brave", "web_search", "brave", false, ["search"], { read: false, prepare: false, commit: true }, { requestsPerMinute: 60, requestsPerSession: 500, maxBytesPerResponse: 2 * 1024 * 1024, maxSpendCents: 1000 }),
    connector("search.serpapi", "web_search", "serpapi", false, ["search"], { read: false, prepare: false, commit: true }, { requestsPerMinute: 30, requestsPerSession: 250, maxBytesPerResponse: 2 * 1024 * 1024, maxSpendCents: 2000 }),
    connector("search.tavily", "web_search", "tavily", false, ["search"], { read: false, prepare: false, commit: true }, { requestsPerMinute: 60, requestsPerSession: 500, maxBytesPerResponse: 2 * 1024 * 1024, maxSpendCents: 1000 }),
    connector("web.fetch", "web_fetch", "local", false, ["fetch"], { read: false, prepare: false, commit: true }, { requestsPerMinute: 60, requestsPerSession: 500, maxBytesPerResponse: 16 * 1024 * 1024, maxSpendCents: 0 }),
    connector("outlook.graph", "outlook", "microsoft_graph", false, ["mail.search", "mail.read", "mail.draft", "mail.send", "calendar.read", "calendar.create", "contacts.read"], { read: false, prepare: true, commit: true }, { requestsPerMinute: 60, requestsPerSession: 500, maxBytesPerResponse: 8 * 1024 * 1024, maxSpendCents: 0 }),
    connector("youtube.data", "youtube", "youtube_data", false, ["video.search", "video.read", "channel.read", "comments.read"], { read: false, prepare: false, commit: true }, { requestsPerMinute: 60, requestsPerSession: 500, maxBytesPerResponse: 8 * 1024 * 1024, maxSpendCents: 1000 }),
    connector("telephone.twilio", "telephone", "twilio", false, ["call.prepare", "call.commit"], { read: true, prepare: true, commit: true }, { requestsPerMinute: 10, requestsPerSession: 25, maxBytesPerResponse: 512 * 1024, maxSpendCents: 2500 })
  ];
}

function connector(
  id: string,
  kind: ConnectorKind,
  provider: ConnectorConfig["provider"],
  enabled: boolean,
  allowedOperations: string[],
  approval: { read: boolean; prepare: boolean; commit: boolean },
  limits: ConnectorConfig["limits"]
): ConnectorConfig {
  return {
    id,
    kind,
    provider,
    enabled,
    limits,
    allowedOperations,
    approval: { requiredForRead: approval.read, requiredForPrepare: approval.prepare, requiredForCommit: approval.commit, operatorGrantEligible: kind !== "telephone" },
    metadata: {}
  };
}

function configToCapability(config: ConnectorConfig): Capability {
  const risk =
    config.kind === "filesystem" ? 0.28 :
    config.kind === "process" ? 0.46 :
    config.kind === "web_search" ? 0.22 :
    config.kind === "web_fetch" ? 0.32 :
    config.kind === "outlook" ? 0.62 :
    config.kind === "youtube" ? 0.26 :
    config.kind === "telephone" ? 0.88 :
    0.5;
  const mutates = config.allowedOperations.some(op => /commit|send|create|write|call/u.test(op));
  return {
    id: config.id,
    label: config.id,
    kind: config.kind === "web_search" || config.kind === "web_fetch" ? "network" : config.kind === "filesystem" || config.kind === "process" || config.kind === "outlook" || config.kind === "youtube" || config.kind === "telephone" ? config.kind : "network",
    mutates,
    risk,
    requiresApproval: config.approval.requiredForCommit || config.approval.requiredForPrepare,
    configured: config.enabled && Boolean(config.provider),
    metadata: toJsonValue({ provider: config.provider, operations: config.allowedOperations, limits: config.limits, approval: config.approval })
  };
}

function validateConnectorConfigs(configs: ConnectorConfig[]): Array<{ id: string; passed: boolean; message: string }> {
  const ids = new Set<string>();
  const results: Array<{ id: string; passed: boolean; message: string }> = [];
  for (const config of configs) {
    const duplicate = ids.has(config.id);
    ids.add(config.id);
    results.push({ id: `connector-id:${config.id}`, passed: !duplicate && /^[A-Za-z0-9_.-]+$/.test(config.id), message: `${config.id} has a unique stable id` });
    results.push({ id: `connector-limits:${config.id}`, passed: config.limits.requestsPerMinute > 0 && config.limits.requestsPerSession > 0 && config.limits.maxBytesPerResponse > 0, message: `${config.id} declares bounded request, session, and byte limits` });
    results.push({ id: `connector-operations:${config.id}`, passed: config.allowedOperations.length > 0, message: `${config.id} declares operations` });
    if (config.kind === "web_search") {
      results.push({ id: `connector-provider:${config.id}`, passed: config.provider === "duckduckgo" || config.provider === "bing" || config.provider === "brave" || config.provider === "serpapi" || config.provider === "tavily", message: `${config.id} uses an approved search provider` });
    }
    if (config.kind === "telephone") {
      results.push({ id: `connector-telephone-approval:${config.id}`, passed: config.approval.requiredForCommit, message: `${config.id} requires commit approval` });
    }
  }
  return results;
}

function connectorRisk(config: ConnectorConfig, phase: ConnectorPhase, payload: JsonValue | undefined, plan: CapabilityPlan | undefined): number {
  const base =
    config.kind === "filesystem" ? 0.24 :
    config.kind === "process" ? 0.42 :
    config.kind === "web_search" ? 0.2 :
    config.kind === "web_fetch" ? 0.32 :
    config.kind === "outlook" ? 0.56 :
    config.kind === "youtube" ? 0.24 :
    config.kind === "telephone" ? 0.82 :
    0.5;
  const phaseRisk = phase === "read" ? 0 : phase === "prepare" ? 0.16 : 0.36;
  const payloadRisk = payloadSensitivity(payload);
  const planRisk = plan ? planRiskValue(plan) : 0;
  const spendRisk = config.limits.maxSpendCents > 0 ? Math.min(0.18, config.limits.maxSpendCents / 10000) : 0;
  return clamp01(base + phaseRisk + payloadRisk * 0.24 + planRisk * 0.2 + spendRisk);
}

function approvalRequired(config: ConnectorConfig, phase: ConnectorPhase, risk: number, policy: PolicyProfile): boolean {
  if (risk > 0.45) return true;
  if (phase === "read") return config.approval.requiredForRead;
  if (phase === "prepare") return config.approval.requiredForPrepare || policy.requireTwoPhaseCommit;
  return config.approval.requiredForCommit || policy.requireTwoPhaseCommit || policy.dryRunByDefault;
}

function approvalTicketFor(input: {
  config: ConnectorConfig;
  plan: CapabilityPlan | undefined;
  phase: ConnectorPhase;
  risk: number;
  payload: JsonValue | undefined;
  t: number;
  hasher: Hasher;
}): ConnectorApprovalTicket {
  const payloadPreview = preview(input.payload);
  const id = `connector_approval_${input.hasher.digestHex(`${input.config.id}:${input.phase}:${payloadPreview}:${input.t}`).slice(0, 24)}`;
  return {
    id,
    connectorId: input.config.id,
    planId: input.plan ? String(input.plan.id) : undefined,
    title: `${input.config.id} ${input.phase} approval`,
    body: `Connector ${input.config.id} wants to ${input.phase}. Risk ${input.risk.toFixed(3)}. Payload: ${payloadPreview}`,
    operatorGrantEligible: input.config.approval.operatorGrantEligible && input.phase !== "commit" && input.risk < 0.72,
    expiresAt: input.t + 30 * 60 * 1000,
    risk: input.risk,
    payloadPreview
  };
}

function admitConnectorResult(input: {
  config: ConnectorConfig;
  payload: JsonValue;
  byteLength: number;
  statusCode?: number;
  contentType?: string;
  elapsedMs: number;
  plan?: CapabilityPlan;
}): ConnectorResultAdmission {
  const reasons: string[] = [];
  if (input.byteLength > input.config.limits.maxBytesPerResponse) reasons.push("response exceeded connector byte limit");
  if (input.statusCode !== undefined && (input.statusCode < 200 || input.statusCode >= 300)) reasons.push(`non-success status ${input.statusCode}`);
  if (input.elapsedMs > 120000) reasons.push("connector response exceeded latency safety bound");
  const sensitive = payloadSensitivity(input.payload);
  const trust =
    input.config.kind === "filesystem" ? 0.72 :
    input.config.kind === "web_search" ? 0.55 :
    input.config.kind === "web_fetch" ? 0.52 :
    input.config.kind === "outlook" ? 0.64 :
    input.config.kind === "youtube" ? 0.5 :
    input.config.kind === "telephone" ? 0.42 :
    0.5;
  const evidenceTrust = clamp01(trust - sensitive * 0.12 - (reasons.length ? 0.25 : 0));
  const quarantine = evidenceTrust < 0.45 || reasons.length > 0 || sensitive > 0.72;
  return {
    accepted: reasons.length === 0,
    connectorId: input.config.id,
    byteLength: input.byteLength,
    evidenceTrust,
    quarantine,
    reasons: reasons.length ? reasons : ["connector result accepted"],
    eventPayload: toJsonValue({
      connectorId: input.config.id,
      statusCode: input.statusCode,
      contentType: input.contentType,
      byteLength: input.byteLength,
      elapsedMs: input.elapsedMs,
      evidenceTrust,
      quarantine,
      planId: input.plan ? String(input.plan.id) : null
    })
  };
}

function payloadSensitivity(payload: JsonValue | undefined): number {
  if (payload === undefined || payload === null) return 0;
  const text = preview(payload).toLowerCase();
  let score = 0;
  for (const needle of ["password", "secret", "token", "private", "medical", "financial", "phone", "email", "address", "ssn"]) {
    if (text.includes(needle)) score += 0.12;
  }
  if (text.length > 4096) score += 0.08;
  return clamp01(score);
}

function planRiskValue(plan: CapabilityPlan): number {
  const risk = plan.riskVector;
  if (!risk || typeof risk !== "object" || Array.isArray(risk)) return 0;
  const value = (risk as Record<string, JsonValue>).risk;
  return typeof value === "number" ? clamp01(value) : 0;
}

function preview(value: JsonValue | undefined): string {
  if (value === undefined) return "";
  try {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    return text.length > 300 ? `${text.slice(0, 297)}...` : text;
  } catch {
    return "[unserializable]";
  }
}
