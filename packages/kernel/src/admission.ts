import type { EvidenceSpan, JsonValue, SourceVersion } from "./types.js";
import { clamp01, mean, toJsonValue } from "./primitives.js";

export interface SourceAdmissionPolicy {
  minimumTrust: number;
  maximumBinaryRatio: number;
  requireText: boolean;
  allowNetworkSources: boolean;
  allowOpaqueLicenses: boolean;
  promoteNamespaces: string[];
  rejectNamespaces: string[];
  sensitiveFeatureIds: string[];
  maxEvidenceAlphaForSensitiveUnpromoted: number;
}

export interface SourceAdmissionDecision {
  disposition: "quarantine" | "promote" | "reject";
  trust: number;
  risk: number;
  reasons: string[];
  safetyRails: string[];
  evidenceActions: Array<{ evidenceId: string; action: "promote" | "quarantine" | "lower-alpha"; alpha: number; reason: string }>;
  audit: JsonValue;
}

export const DEFAULT_ADMISSION_POLICY: SourceAdmissionPolicy = {
  minimumTrust: 0.5,
  maximumBinaryRatio: 0.12,
  requireText: true,
  allowNetworkSources: false,
  allowOpaqueLicenses: true,
  promoteNamespaces: [],
  rejectNamespaces: [],
  sensitiveFeatureIds: [],
  maxEvidenceAlphaForSensitiveUnpromoted: 0.42
};

export function createSourceAdmissionController(policy: Partial<SourceAdmissionPolicy> = {}) {
  const p: SourceAdmissionPolicy = { ...DEFAULT_ADMISSION_POLICY, ...policy };
  return {
    decide(input: { source: SourceVersion; evidence: readonly EvidenceSpan[]; metadata?: JsonValue }): SourceAdmissionDecision {
      const reasons: string[] = [];
      const safetyRails: string[] = [];
      const namespaceRejected = p.rejectNamespaces.includes(input.source.namespace);
      const namespacePromoted = p.promoteNamespaces.includes(input.source.namespace);
      const metadata = normalizeMetadata(input.metadata ?? input.source.metadata);
      const diagnosticTrust = diagnosticTrustFrom(metadata);
      const textTrust = input.evidence.length > 0 || !p.requireText ? 1 : 0;
      const licenseTrust = p.allowOpaqueLicenses || Boolean(metadata.licenseHint) ? 1 : 0.4;
      const namespaceTrust = namespaceRejected ? 0 : namespacePromoted ? 1 : 0.72;
      const trust = clamp01(0.35 * input.source.trust + 0.25 * diagnosticTrust + 0.2 * textTrust + 0.1 * licenseTrust + 0.1 * namespaceTrust);
      if (namespaceRejected) reasons.push("namespace rejected by policy");
      if (input.evidence.length === 0 && p.requireText) reasons.push("no extracted text evidence");
      if (diagnosticTrust < 0.5) reasons.push("extractor diagnostics reduced trust");
      if (!p.allowNetworkSources && input.source.namespace.startsWith("network")) reasons.push("network sources disabled by policy");
      const sensitive = sensitivityScore(input.evidence, metadata, p);
      const binaryRatio = typeof metadata.binaryRatio === "number" ? metadata.binaryRatio : 0;
      const risk = clamp01(0.28 * sensitive + 0.22 * binaryRatio + 0.22 * (1 - trust) + 0.14 * (namespaceRejected ? 1 : 0) + 0.14 * (input.evidence.length ? 0 : 1));
      if (sensitive > 0.15) safetyRails.push("safety.rail.structured_sensitive_source");
      if (binaryRatio > p.maximumBinaryRatio) reasons.push("binary ratio exceeds policy");
      const disposition = namespaceRejected || binaryRatio > p.maximumBinaryRatio
        ? "reject"
        : trust >= p.minimumTrust && risk < 0.55 && namespacePromoted
          ? "promote"
          : "quarantine";
      const evidenceActions = input.evidence.map(span => {
        const containsSensitive = sensitivityScore([span], metadata, p) > 0;
        if (disposition === "promote") return { evidenceId: String(span.id), action: "promote" as const, alpha: span.alpha, reason: "source admission promoted namespace and trust threshold" };
        if (containsSensitive && span.alpha > p.maxEvidenceAlphaForSensitiveUnpromoted) return { evidenceId: String(span.id), action: "lower-alpha" as const, alpha: p.maxEvidenceAlphaForSensitiveUnpromoted, reason: "sensitive unpromoted evidence alpha ceiling" };
        return { evidenceId: String(span.id), action: "quarantine" as const, alpha: span.alpha, reason: reasons[0] ?? "default quarantine until explicit training promotion" };
      });
      return {
        disposition,
        trust,
        risk,
        reasons: reasons.length ? reasons : [`source ${disposition}`],
        safetyRails,
        evidenceActions,
        audit: toJsonValue({ sourceVersionId: input.source.sourceVersionId, namespace: input.source.namespace, trust, risk, disposition, reasons, safetyRails, evidenceActions })
      };
    }
  };
}

function normalizeMetadata(value: JsonValue): Record<string, JsonValue> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const record = value as Record<string, JsonValue>;
  const diagnostics = record.diagnostics && typeof record.diagnostics === "object" && !Array.isArray(record.diagnostics)
    ? record.diagnostics as Record<string, JsonValue>
    : {};
  return { ...record, ...diagnostics };
}

function diagnosticTrustFrom(metadata: Record<string, JsonValue>): number {
  const parserCount = typeof metadata.parserCount === "number" ? metadata.parserCount : 1;
  const missing = Array.isArray(metadata.missingPreconditions) ? metadata.missingPreconditions.length : 0;
  const warnings = Array.isArray(metadata.warnings) ? metadata.warnings.length : 0;
  const charLength = typeof metadata.charLength === "number" ? metadata.charLength : 0;
  return clamp01(0.35 + Math.min(0.3, parserCount * 0.08) + Math.min(0.25, Math.log2(1 + charLength) / 40) - Math.min(0.35, missing * 0.08 + warnings * 0.03));
}

function sensitivityScore(evidence: readonly EvidenceSpan[], metadata: Record<string, JsonValue>, policy: SourceAdmissionPolicy): number {
  const metadataScore = typeof metadata.safetyScore === "number" ? metadata.safetyScore : 0;
  const configured = new Set(policy.sensitiveFeatureIds);
  const featureScores = evidence.map(span => {
    const structured = span.features.filter(feature => feature.startsWith("safety:") || feature.startsWith("risk:"));
    const configuredHits = configured.size ? structured.filter(feature => configured.has(feature)).length : structured.length;
    return clamp01(configuredHits / Math.max(1, configured.size || 4));
  });
  return clamp01(Math.max(metadataScore, mean(featureScores)));
}
