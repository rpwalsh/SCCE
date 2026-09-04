// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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
