// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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
  sensitiveFeatureIds: []
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
      // Was a bare 0.5 while the gate it reports on is minimumDiagnosticParserReliability. A reason that
      // disagrees with its own gate describes nothing.
      if (diagnosticTrust < p.minimumDiagnosticParserReliability) reasons.push("extractor diagnostics reduced trust");
      if (!networkSourceAllowed) reasons.push("runtime web sources disabled by policy");
      if (input.context.intendedUse === "quarantine_only") reasons.push("source context requires quarantine");
      if (!promotionAuthorized) reasons.push("source context lacks promotion authority");
      for (const [dimension, passed] of Object.entries(trustChecks)) {
        if (!passed) reasons.push(`source trust check failed: ${dimension}`);
      }
      const sensitive = sensitivityScore(input.evidence, metadata, p);
      const binaryRatio = typeof metadata.binaryRatio === "number" ? metadata.binaryRatio : 0;
      // Any structured sensitivity raises the rail. It was `> 0.15`, which this file already contradicts three
      // lines down where a single span counts as sensitive at `> 0`.
      if (sensitive > 0) safetyRails.push("safety.rail.structured_sensitive_source");
      if (binaryRatio > p.maximumBinaryRatio) reasons.push("binary ratio exceeds policy");
      // A source with no evidence spans has nothing to promote: promotion grants influence over the graph and
      // language memory, and there is nothing here to grant it over.
      //
      // This replaces `risk < 0.55`, where risk was 0.45*sensitive + 0.35*binaryRatio + 0.2*(no evidence).
      // That blend decided almost nothing. `binaryRatio > maximumBinaryRatio` already forces reject above, so
      // by this line binaryRatio is at most 0.12 and contributes at most 0.042. With evidence present the test
      // was therefore 0.45*sensitive + 0.042 < 0.55, which holds for every sensitivity up to 1.0 -- the gate
      // could not fire. It bound only when a source carried no evidence, and then on an arbitrary sensitivity
      // cut. So the condition it was standing in for is stated directly, and sensitivity is left to the rail
      // and to the per-span discount below, which are the two places it is actually acted on.
      const hasEvidence = input.evidence.length > 0;
      if (!hasEvidence) reasons.push("source carries no evidence to promote");
      const disposition = namespaceRejected || binaryRatio > p.maximumBinaryRatio || !trustVectorValid
        ? "reject"
        : trustGatePassed
          && hasEvidence
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
        const spanSensitivity = sensitivityScore([span], metadata, p);
        const containsSensitive = spanSensitivity > 0;
        if (disposition === "promote") return { evidenceId: String(span.id), action: "promote" as const, alpha: span.alpha, reason: "typed source context authorized promotion and trust threshold passed" };
        // Sensitive evidence that was not promoted is discounted BY HOW SENSITIVE IT MEASURED, rather than
        // clipped to a fixed ceiling of 0.42. A flat ceiling treats a barely-sensitive span and an entirely
        // sensitive one identically, and it raised the alpha of anything measuring below it. Scaling by
        // (1 - sensitivity) is monotone in the measurement, never raises a span's alpha, and reaches zero only
        // when the span measured wholly sensitive.
        if (containsSensitive) {
          const discounted = clamp01(span.alpha * (1 - spanSensitivity));
          if (discounted < span.alpha) {
            return { evidenceId: String(span.id), action: "lower-alpha" as const, alpha: discounted, reason: "unpromoted sensitive evidence discounted by measured sensitivity" };
          }
        }
        return { evidenceId: String(span.id), action: "quarantine" as const, alpha: span.alpha, reason: reasons[0] ?? "default quarantine until explicit training promotion" };
      });
      return {
        disposition,
        context: input.context,
        sourceTrust,
        trustChecks,
        parserDiagnosticReliability: diagnosticTrust,
        activeInfluence,
        // Reported as the measured sensitivity of this source's evidence, which is the one risk quantity here
        // that is actually measured. It was a blend of sensitivity, binary ratio and has-no-evidence at
        // 0.45/0.35/0.2; the other two are reported beside it in the audit as the conditions they are.
        risk: sensitive,
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
          risk: sensitive,
          sensitivity: sensitive,
          binaryRatio,
          hasEvidence,
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

/**
 * How reliable the extraction was, as the share of parse signal that came back clean: parsers that ran against
 * parsers that ran plus the defects they reported.
 *
 * It was `0.35 + min(0.3, parsers*0.08) + min(0.25, log2(1+chars)/40) - min(0.35, missing*0.08 + warnings*0.03)`
 * -- six numbers and three ceilings, none of them measured. The character count is gone with them: how much
 * text a source contains is not a statement about whether its parser worked.
 *
 * This never weakens the gate it feeds. A clean single-parser source read 0.68 before and reads 1.0 now, so it
 * passes either way; one warning reads 0.5 against 0.65 and still passes; three warnings read 0.25 against
 * 0.59 and now fail minimumDiagnosticParserReliability, where before they passed. Monotonically stricter as
 * defects accumulate, which is the direction a reliability measure should move.
 */
function diagnosticTrustFrom(metadata: Record<string, JsonValue>): number {
  const parserCount = typeof metadata.parserCount === "number" ? Math.max(0, metadata.parserCount) : 1;
  const missing = Array.isArray(metadata.missingPreconditions) ? metadata.missingPreconditions.length : 0;
  const warnings = Array.isArray(metadata.warnings) ? metadata.warnings.length : 0;
  const defects = missing + warnings;
  const signal = parserCount + defects;
  return signal > 0 ? clamp01(parserCount / signal) : 0;
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
