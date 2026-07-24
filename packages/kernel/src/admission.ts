import type { EvidenceSpan, JsonValue, SourceAdmissionContext, SourceTrust, SourceVersion } from "./types.js";
import { clamp01, mean, toJsonValue } from "./primitives.js";

export interface SourceAdmissionPolicy {
  minimumIdentity: number;
  minimumIntegrity: number;
  minimumParserReliability: number;
  minimumDiagnosticParserReliability: number;
  minimumDirectnessForEvidence: number;
  minimumAuthorityForEvidence: number;
  maximumBinaryRatio: number;
  requireText: boolean;
  allowNetworkSources: boolean;
  allowOpaqueLicenses: boolean;
  rejectNamespaces: string[];
  sensitiveFeatureIds: string[];
  maxEvidenceAlphaForSensitiveUnpromoted: number;
}

export interface SourceAdmissionDecision {
  disposition: "quarantine" | "promote" | "reject";
  context: SourceAdmissionContext;
  sourceTrust: SourceTrust;
  trustChecks: Record<string, boolean>;
  parserDiagnosticReliability: number;
  activeInfluence: {
    graph: boolean;
    language: boolean;
  };
  risk: number;
  reasons: string[];
  safetyRails: string[];
  evidenceActions: Array<{ evidenceId: string; action: "promote" | "quarantine" | "lower-alpha"; alpha: number; reason: string }>;
  audit: JsonValue;
}

export const DEFAULT_ADMISSION_POLICY: SourceAdmissionPolicy = {
  minimumIdentity: 0.5,
  minimumIntegrity: 0.7,
  minimumParserReliability: 0.5,
  minimumDiagnosticParserReliability: 0.4,
  minimumDirectnessForEvidence: 0.45,
  minimumAuthorityForEvidence: 0.4,
  maximumBinaryRatio: 0.12,
  requireText: true,
  allowNetworkSources: true,
  allowOpaqueLicenses: true,
  rejectNamespaces: [],
  sensitiveFeatureIds: [],
  maxEvidenceAlphaForSensitiveUnpromoted: 0.42
};

export function createSourceAdmissionController(policy: Partial<SourceAdmissionPolicy> = {}) {
  const p: SourceAdmissionPolicy = { ...DEFAULT_ADMISSION_POLICY, ...policy };
  return {
    decide(input: {
      source: SourceVersion;
      evidence: readonly EvidenceSpan[];
      context: SourceAdmissionContext;
      metadata?: JsonValue;
    }): SourceAdmissionDecision {
      const reasons: string[] = [];
      const safetyRails: string[] = [];
      const namespaceRejected = p.rejectNamespaces.includes(input.source.namespace);
      const metadata = normalizeMetadata(input.metadata ?? input.source.metadata);
      const diagnosticTrust = diagnosticTrustFrom(metadata);
      const textTrust = input.evidence.length > 0 || !p.requireText ? 1 : 0;
      const promotionAuthorized = sourceContextAuthorizesPromotion(input.context);
      const networkSourceAllowed = input.context.sourceClass !== "runtime_web" || p.allowNetworkSources;
      const sourceTrust = input.source.sourceTrust;
      const trustVectorValid = sourceTrustDimensionsValid(sourceTrust);
      const directEvidence = input.context.intendedUse === "direct_evidence";
      const licenseAllowed = sourceTrust.licenseStatus !== "restricted"
        && (p.allowOpaqueLicenses || sourceTrust.licenseStatus !== "unknown");
      const trustChecks: Record<string, boolean> = {
        vectorValid: trustVectorValid,
        identity: sourceTrust.identity >= p.minimumIdentity,
        integrity: sourceTrust.integrity >= p.minimumIntegrity,
        parserReliability: sourceTrust.parserReliability >= p.minimumParserReliability,
        parserDiagnostics: diagnosticTrust >= p.minimumDiagnosticParserReliability,
        directness: !directEvidence || sourceTrust.directness >= p.minimumDirectnessForEvidence,
        authority: !directEvidence || sourceTrust.authority >= p.minimumAuthorityForEvidence,
        independenceGroup: Boolean(sourceTrust.independenceGroup.trim()),
        accessScope: Boolean(sourceTrust.accessScope.trim()),
        licenseStatus: Boolean(sourceTrust.licenseStatus.trim()) && licenseAllowed,
        textPresent: Boolean(textTrust)
      };
      const trustGatePassed = Object.values(trustChecks).every(Boolean);
      if (namespaceRejected) reasons.push("namespace rejected by policy");
      if (input.evidence.length === 0 && p.requireText) reasons.push("no extracted text evidence");
      if (diagnosticTrust < 0.5) reasons.push("extractor diagnostics reduced trust");
      if (!networkSourceAllowed) reasons.push("runtime web sources disabled by policy");
      if (input.context.intendedUse === "quarantine_only") reasons.push("source context requires quarantine");
      if (!promotionAuthorized) reasons.push("source context lacks promotion authority");
      for (const [dimension, passed] of Object.entries(trustChecks)) {
        if (!passed) reasons.push(`source trust check failed: ${dimension}`);
      }
      const sensitive = sensitivityScore(input.evidence, metadata, p);
      const binaryRatio = typeof metadata.binaryRatio === "number" ? metadata.binaryRatio : 0;
      const risk = clamp01(0.45 * sensitive + 0.35 * binaryRatio + 0.2 * (input.evidence.length ? 0 : 1));
      if (sensitive > 0.15) safetyRails.push("safety.rail.structured_sensitive_source");
      if (binaryRatio > p.maximumBinaryRatio) reasons.push("binary ratio exceeds policy");
      const disposition = namespaceRejected || binaryRatio > p.maximumBinaryRatio || !trustVectorValid
        ? "reject"
        : trustGatePassed
          && risk < 0.55
          && networkSourceAllowed
          && promotionAuthorized
          && input.context.intendedUse !== "quarantine_only"
          ? "promote"
          : "quarantine";
      const activeInfluence = {
        graph: disposition === "promote" && input.context.intendedUse !== "language_only",
        language: disposition === "promote"
          && input.context.intendedUse !== "direct_evidence"
      };
      const evidenceActions = input.evidence.map(span => {
        const containsSensitive = sensitivityScore([span], metadata, p) > 0;
        if (disposition === "promote") return { evidenceId: String(span.id), action: "promote" as const, alpha: span.alpha, reason: "typed source context authorized promotion and trust threshold passed" };
        if (containsSensitive && span.alpha > p.maxEvidenceAlphaForSensitiveUnpromoted) return { evidenceId: String(span.id), action: "lower-alpha" as const, alpha: p.maxEvidenceAlphaForSensitiveUnpromoted, reason: "sensitive unpromoted evidence alpha ceiling" };
        return { evidenceId: String(span.id), action: "quarantine" as const, alpha: span.alpha, reason: reasons[0] ?? "default quarantine until explicit training promotion" };
      });
      return {
        disposition,
        context: input.context,
        sourceTrust,
        trustChecks,
        parserDiagnosticReliability: diagnosticTrust,
        activeInfluence,
        risk,
        reasons: reasons.length ? reasons : [`source ${disposition}`],
        safetyRails,
        evidenceActions,
        audit: toJsonValue({
          sourceVersionId: input.source.sourceVersionId,
          namespace: input.source.namespace,
          context: input.context,
          sourceTrust,
          trustChecks,
          parserDiagnosticReliability: diagnosticTrust,
          activeInfluence,
          risk,
          disposition,
          reasons,
          safetyRails,
          evidenceActions
        })
      };
    }
  };
}

function sourceContextAuthorizesPromotion(context: SourceAdmissionContext): boolean {
  switch (context.sourceClass) {
    case "owner_local":
      return context.promotionAuthority === "owner";
    case "trusted_corpus":
      return context.promotionAuthority === "training" || context.promotionAuthority === "owner";
    case "connector_private":
    case "runtime_web":
      return context.promotionAuthority === "automatic" || context.promotionAuthority === "owner";
    case "generated":
      return context.intendedUse === "language_only" && context.promotionAuthority === "owner";
  }
}

function sourceTrustDimensionsValid(trust: SourceTrust): boolean {
  return [
    trust.identity,
    trust.integrity,
    trust.parserReliability,
    trust.directness,
    trust.authority,
    trust.freshness
  ].every(value => Number.isFinite(value) && value >= 0 && value <= 1);
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
