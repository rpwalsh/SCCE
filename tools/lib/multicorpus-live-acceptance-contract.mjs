// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function preview(value, limit) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  return text.length <= limit ? text : `${text.slice(0, Math.max(0, limit - 3))}...`;
}

export function compactAcceptanceEvidence(span) {
  if (!isRecord(span)) return { sourceId: null };
  return {
    id: typeof span.id === "string" ? span.id : null,
    sourceId: typeof span.sourceId === "string" ? span.sourceId : null,
    sourceVersionId: typeof span.sourceVersionId === "string" ? span.sourceVersionId : null,
    chunkId: typeof span.chunkId === "string" ? span.chunkId : null,
    contentHash: typeof span.contentHash === "string" ? span.contentHash : null,
    sourceContentHash: typeof span.sourceContentHash === "string" ? span.sourceContentHash : null,
    byteStart: finiteNumber(span.byteStart),
    byteEnd: finiteNumber(span.byteEnd),
    textPreview: typeof span.textPreview === "string" ? preview(span.textPreview, 420) : ""
  };
}

export function evidenceMatchesSourceBinding(span, binding) {
  if (span.sourceId !== binding.sourceId) return false;
  if (binding.sourceVersionId && span.sourceVersionId !== binding.sourceVersionId) return false;
  // `contentHash` on an evidence span identifies the cited chunk/evidence payload. A build
  // binding's `contentHash` identifies the complete source version. Compare only when the API
  // supplies that like-for-like source hash; sourceId + sourceVersionId is otherwise the exact owner.
  if (binding.contentHash && span.sourceContentHash && span.sourceContentHash !== binding.contentHash) return false;
  return true;
}
