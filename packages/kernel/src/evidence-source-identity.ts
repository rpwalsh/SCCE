// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { jsonRecord, kernelString } from "./kernel-answer-primitives.js";
import type { EvidenceSourceIdentity, EvidenceSpan, JsonValue } from "./types.js";

/**
 * What a span's provenance says the source IS, resolved once.
 *
 * Two ingestors write these in two places -- the Wikipedia dump at the top level, the repository ingestor under
 * `metadata` -- and every consumer re-derived the pair for itself: evidenceTitle read both, evidenceIdentity read
 * both, evidenceCitation read only the first and cited nothing for the whole repository corpus. The schema already
 * states the rule once (the `source_title` generated column coalesces exactly these two), so this is that same rule
 * on the TypeScript side of the boundary, not a fifth opinion.
 *
 * Pure: the one place raw provenance is read for title, identity and source kind.
 */
export function resolveEvidenceSourceIdentity(provenanceJson: JsonValue | undefined): EvidenceSourceIdentity {
  const provenance = jsonRecord(provenanceJson);
  const metadata = jsonRecord(provenance.metadata);
  return {
    title: kernelString(provenance.title) ?? kernelString(metadata.title) ?? "",
    identity: kernelString(provenance.identity) ?? kernelString(metadata.identity) ?? "",
    sourceKind: kernelString(provenance.sourceKind) ?? kernelString(metadata.sourceKind) ?? ""
  };
}

/**
 * The resolved identity of a span, from the field the read boundary set when it is there and from provenance when
 * it is not. A span built in memory (a session span, a fixture) never crossed that boundary, so the fallback is
 * the same resolver rather than an empty identity.
 */
export function evidenceSourceIdentity(span: EvidenceSpan): EvidenceSourceIdentity {
  return span.sourceIdentity ?? resolveEvidenceSourceIdentity(span.provenance);
}
