import type { EvidenceSpan, JsonValue } from "./types.js";

export function evidenceSourceFamilyId(span: EvidenceSpan): string {
  const provenance = span.provenance && typeof span.provenance === "object"
    && !Array.isArray(span.provenance)
    ? span.provenance as Record<string, JsonValue>
    : {};
  const declared = typeof provenance.sourceFamilyId === "string"
    ? provenance.sourceFamilyId.trim()
    : typeof provenance.dependencyFamilyId === "string"
      ? provenance.dependencyFamilyId.trim()
      : "";
  return declared || String(span.sourceId);
}
