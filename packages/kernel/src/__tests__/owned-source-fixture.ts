// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { canonicalCorpusSourceSystemId } from "../corpus-registry.js";
import { jsonRecord, kernelString } from "../kernel-answer-primitives.js";
import { createHasher } from "../primitives.js";
import type { BlobStore } from "../storage.js";
import type { ContentHash, EvidenceId, EvidenceSpan, SourceVersion } from "../types.js";

export function ownedSourceFixture(evidence: EvidenceSpan[]) {
  const hasher = createHasher();
  const blobs = new Map<string, Uint8Array>();
  const sources = () => {
    const groups = new Map<string, EvidenceSpan[]>();
    for (const span of evidence) groups.set(String(span.sourceVersionId), [...(groups.get(String(span.sourceVersionId)) ?? []), span]);
    return [...groups.values()].map(spans => {
      const first = spans[0]!;
      let offset = 0;
      for (const span of spans) {
        span.byteStart = offset;
        span.byteEnd = offset + Buffer.byteLength(span.text, "utf8");
        offset = span.byteEnd + 1;
      }
      const bytes = Buffer.from(spans.map(span => span.text).join("\n"));
      const contentHash = `sha256_${hasher.digestHex(bytes)}` as ContentHash;
      blobs.set(contentHash, bytes);
      const provenance = jsonRecord(first.provenance);
      const sourceSystem = kernelString(provenance.sourceSystem) ?? kernelString(jsonRecord(provenance.metadata).sourceSystem) ?? "workspace";
      return { sourceId: first.sourceId, sourceVersionId: first.sourceVersionId, namespace: "fixture", canonicalUri: `fixture://${first.sourceVersionId}`,
        contentHash, mediaType: "text/plain", byteLength: bytes.byteLength, observedAt: first.observedAt, informationLabel: first.informationLabel,
        sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1,
          independenceGroup: String(first.sourceId), accessScope: "fixture", licenseStatus: "fixture" },
        metadata: { sourceSystem, sourceSystemId: canonicalCorpusSourceSystemId(sourceSystem) }, role: "original" } as SourceVersion;
    });
  };
  return {
    sourcesForEvidence: async (ids: EvidenceId[]) => sources().filter(source => evidence.some(span => ids.includes(span.id) && span.sourceVersionId === source.sourceVersionId)),
    blobs: { put: async (bytes: Uint8Array) => { const hash = `sha256_${hasher.digestHex(bytes)}` as ContentHash; blobs.set(hash, new Uint8Array(bytes)); return hash; },
      putRanges: async (items: Parameters<BlobStore["putRanges"]>[0], parent: Parameters<BlobStore["putRanges"]>[1]) => {
        if (`sha256_${hasher.digestHex(parent.bytes)}` !== parent.contentHash) throw new Error("owned fixture range parent changed");
        for (const item of items) {
          if (item.parentHash !== parent.contentHash || item.byteStart < 0 || item.byteEnd <= item.byteStart || item.byteEnd > parent.bytes.byteLength) {
            throw new Error("owned fixture blob range is invalid");
          }
          const bytes = parent.bytes.slice(item.byteStart, item.byteEnd);
          if (`sha256_${hasher.digestHex(bytes)}` !== item.contentHash) throw new Error("owned fixture blob range hash mismatch");
          blobs.set(item.contentHash, bytes);
        }
      },
      get: async (hash: ContentHash) => { sources(); const bytes = blobs.get(hash); if (!bytes) throw new Error(`owned fixture source blob missing: ${hash}`); return bytes; },
      exists: async (hash: ContentHash) => { sources(); return blobs.has(hash); } }
  };
}

export function compilationArtifactIds(rows: readonly { id: string; profileId?: string; metadata?: unknown; patternJson?: unknown; frameJson?: unknown }[], query: {
  compilationId: string; profileId: string; afterId?: string; limit: number;
}): string[] {
  return rows.filter(row => {
    const data = jsonRecord((row.metadata ?? row.patternJson ?? row.frameJson) as import("../types.js").JsonValue);
    return (row.profileId ?? data.profileId) === query.profileId && data.sourceCompilationId === query.compilationId;
  }).map(row => row.id).sort().filter(id => !query.afterId || id > query.afterId).slice(0, query.limit);
}
