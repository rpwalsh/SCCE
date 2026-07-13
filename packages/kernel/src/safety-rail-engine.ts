import type { CapabilityPlan, Hasher, JsonValue, PolicyProfile } from "./types.js";
import { clamp01, createHasher, toJsonValue } from "./primitives.js";

export type SafetySignalKind =
  | "self_harm"
  | "harm_to_others"
  | "medical_crisis"
  | "persecutory_belief"
  | "mania_pressure"
  | "substance_risk"
  | "financial_impulsivity"
  | "privacy_exposure"
  | "weaponization"
  | "ordinary";

export interface SafetySignal {
  id: string;
  kind: SafetySignalKind;
  score: number;
  span: string;
  reason: string;
}

export interface SafetyRailDecision {
  id: string;
  risk: number;
  level: "ordinary" | "supportive" | "high_caution" | "block_mutation" | "crisis";
  signals: SafetySignal[];
  allowed: boolean;
  blockedPlans: string[];
  requiredResponseMoves: string[];
  forbiddenResponseMoves: string[];
  audit: JsonValue;
}

export interface SafetyRailConfig {
  enabled: boolean;
  crisisResources: Array<{ label: string; value: string; region?: string }>;
  blockOutboundCommunicationOnHighCaution: boolean;
  blockSpendOnHighCaution: boolean;
  requireApprovalForProcessOnHighCaution: boolean;
  encryptedNotesOnly: boolean;
}

export function createSafetyRailEngine(options: { hasher?: Hasher; config?: Partial<SafetyRailConfig> } = {}) {
  const hasher = options.hasher ?? createHasher();
  const config = { ...defaultSafetyRailConfig(), ...options.config };
  return {
    evaluate(input: { text: string; plans?: CapabilityPlan[]; policy?: PolicyProfile; region?: string; signals?: SafetySignal[] }): SafetyRailDecision {
      const signals = normalizeStructuredSignals(input.signals ?? [], input.text, hasher);
      const risk = aggregateSafetyRisk(signals);
      const level = levelFor(risk, signals);
      const blockedPlans = blockedPlansFor(input.plans ?? [], level, config, input.policy);
      const allowed = config.enabled ? level !== "crisis" && blockedPlans.length === 0 : true;
      const requiredResponseMoves = requiredMoves(level, config, input.region);
      const forbiddenResponseMoves = forbiddenMoves(level);
      return {
        id: `safety_decision_${hasher.digestHex(JSON.stringify({ text: input.text.slice(0, 512), signals: signals.map(s => [s.kind, s.score]), level, blockedPlans })).slice(0, 32)}`,
        risk,
        level,
        signals,
        allowed,
        blockedPlans,
        requiredResponseMoves,
        forbiddenResponseMoves,
        audit: toJsonValue({
          enabled: config.enabled,
          risk,
          level,
          signals,
          blockedPlans,
          encryptedNotesOnly: config.encryptedNotesOnly,
          policy: input.policy ? {
            allowMutation: input.policy.allowMutation,
            maxSpendCents: input.policy.maxSpendCents,
            alphaRiskCeiling: input.policy.alphaRiskCeiling
          } : null
        })
      };
    },

    redactForUnencryptedSurface(value: JsonValue): JsonValue {
      return config.encryptedNotesOnly ? redactSensitiveSafetyPayload(value) : value;
    }
  };
}

export function defaultSafetyRailConfig(): SafetyRailConfig {
  return {
    enabled: true,
    crisisResources: [
      { label: "ui.resource.crisis.us_ca.988", value: "988", region: "US" },
      { label: "ui.resource.emergency.us.911", value: "911", region: "US" }
    ],
    blockOutboundCommunicationOnHighCaution: true,
    blockSpendOnHighCaution: true,
    requireApprovalForProcessOnHighCaution: true,
    encryptedNotesOnly: true
  };
}

function normalizeStructuredSignals(signals: readonly SafetySignal[], text: string, hasher: Hasher): SafetySignal[] {
  const normalized = signals.map((signal, index) => ({
    id: signal.id || `safety_${hasher.digestHex(`${signal.kind}:${index}:${text.length}`).slice(0, 20)}`,
    kind: signal.kind,
    score: clamp01(signal.score),
    span: signal.span ? `[structured:${hasher.digestHex(signal.span).slice(0, 16)}]` : "",
    reason: signal.reason || `safety.signal.${signal.kind}`
  }));
  if (!normalized.length) normalized.push({ id: `safety_${hasher.digestHex(`ordinary:${text.length}`).slice(0, 20)}`, kind: "ordinary", score: 0.05, span: "", reason: "safety.signal.ordinary" });
  return dedupeSignals(normalized).sort((a, b) => b.score - a.score);
}

function aggregateSafetyRisk(signals: readonly SafetySignal[]): number {
  let risk = 0;
  for (const signal of signals) {
    const weight =
      signal.kind === "self_harm" || signal.kind === "harm_to_others" || signal.kind === "medical_crisis" ? 1 :
      signal.kind === "weaponization" ? 0.85 :
      signal.kind === "persecutory_belief" || signal.kind === "mania_pressure" ? 0.72 :
      signal.kind === "substance_risk" || signal.kind === "financial_impulsivity" ? 0.62 :
      signal.kind === "privacy_exposure" ? 0.48 :
      0.1;
    risk = 1 - (1 - risk) * (1 - signal.score * weight);
  }
  return clamp01(risk);
}

function levelFor(risk: number, signals: readonly SafetySignal[]): SafetyRailDecision["level"] {
  if (signals.some(signal => (signal.kind === "self_harm" || signal.kind === "harm_to_others" || signal.kind === "medical_crisis") && signal.score > 0.78)) return "crisis";
  if (risk > 0.78) return "block_mutation";
  if (risk > 0.52) return "high_caution";
  if (risk > 0.22) return "supportive";
  return "ordinary";
}

function blockedPlansFor(plans: readonly CapabilityPlan[], level: SafetyRailDecision["level"], config: SafetyRailConfig, policy: PolicyProfile | undefined): string[] {
  if (level === "ordinary" || level === "supportive") return [];
  const blocked: string[] = [];
  for (const plan of plans) {
    const risk = plan.riskVector && typeof plan.riskVector === "object" && !Array.isArray(plan.riskVector) ? plan.riskVector as Record<string, JsonValue> : {};
    const mutates = risk.mutates === true || plan.phase === "commit";
    const network = risk.network === true;
    const capability = plan.capabilityId.toLowerCase();
    if (level === "crisis" && mutates) blocked.push(String(plan.id));
    if (level === "block_mutation" && mutates) blocked.push(String(plan.id));
    if (level === "high_caution" && config.blockOutboundCommunicationOnHighCaution && (capability.includes("outlook") || capability.includes("telephone") || (network && mutates))) blocked.push(String(plan.id));
    if (level === "high_caution" && config.blockSpendOnHighCaution && (policy?.maxSpendCents ?? 0) > 0 && mutates) blocked.push(String(plan.id));
    if (level === "high_caution" && config.requireApprovalForProcessOnHighCaution && capability.includes("process") && mutates) blocked.push(String(plan.id));
  }
  return [...new Set(blocked)];
}

function requiredMoves(level: SafetyRailDecision["level"], config: SafetyRailConfig, region: string | undefined): string[] {
  if (level === "ordinary") return ["safety.move.evidence_boundaries"];
  if (level === "supportive") return ["safety.move.grounded_support", "safety.move.external_support_when_relevant"];
  if (level === "high_caution") return ["safety.move.slow_irreversible_actions", "safety.move.require_sensitive_approval"];
  if (level === "block_mutation") return ["safety.move.block_mutation", "safety.move.inspection_only"];
  const resources = config.crisisResources.filter(item => !region || !item.region || item.region === region).map(item => `${item.label}: ${item.value}`);
  return ["safety.move.crisis_support", "safety.move.local_emergency_help", ...resources];
}

function forbiddenMoves(level: SafetyRailDecision["level"]): string[] {
  const common = ["safety.forbid.diagnosis_claim", "safety.forbid.mental_state_certainty", "safety.forbid.escalation"];
  if (level === "ordinary") return [];
  if (level === "supportive") return common;
  if (level === "high_caution") return [...common, "safety.forbid.impulsive_commitment"];
  if (level === "block_mutation") return [...common, "safety.forbid.mutating_capabilities"];
  return [...common, "safety.forbid.dangerous_instructions"];
}

function redactSensitiveSafetyPayload(value: JsonValue): JsonValue {
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.length > 240 ? `${value.slice(0, 237)}...` : value;
  if (Array.isArray(value)) return value.map(redactSensitiveSafetyPayload);
  const out: Record<string, JsonValue> = {};
  for (const [key, item] of Object.entries(value)) {
    out[key] = /span|text|prompt|body|payload/i.test(key) ? "[ENCRYPTED-SAFETY-NOTE]" : redactSensitiveSafetyPayload(item);
  }
  return out;
}

function dedupeSignals(signals: SafetySignal[]): SafetySignal[] {
  const map = new Map<string, SafetySignal>();
  for (const signal of signals) {
    const key = `${signal.kind}:${signal.span}`;
    const existing = map.get(key);
    if (!existing || signal.score > existing.score) map.set(key, signal);
  }
  return [...map.values()];
}
