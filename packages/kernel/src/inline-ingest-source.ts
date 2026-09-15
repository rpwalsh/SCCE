// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHasher, redactSecretsWithMap, toJsonValue } from "./primitives.js";
import type { IngestedSourceFile, IngestionCheckpoint } from "./storage.js";
import type { ContentHash, IngestInput } from "./types.js";

export async function* inlineIngestStream(
  input: IngestInput,
  now: number,
  hasher: ReturnType<typeof createHasher>
): AsyncIterable<{ type: "file"; file: IngestedSourceFile; checkpoint: IngestionCheckpoint }> {
  const bytes = typeof input.content === "string"
    ? Buffer.from(input.content, "utf8")
    : new Uint8Array(input.content ?? new Uint8Array());
  const upstreamDerivative = input.evidenceDerivative;
  if (upstreamDerivative && !Buffer.from(upstreamDerivative.bytes).equals(Buffer.from(upstreamDerivative.text, "utf8"))) {
    throw new Error(`evidence derivative bytes do not encode derivative text: ${input.uri ?? "inline://owner-content"}`);
  }
  const extractedText = upstreamDerivative?.text ?? (typeof input.content === "string"
    ? input.content
    : Buffer.from(bytes).toString("utf8"));
  const redacted = redactSecretsWithMap(extractedText);
  // A derivative map is rooted in the derivative's declared coordinate space.
  // Once an upstream transform has already redacted content, a second redaction
  // pass cannot be represented by simply concatenating maps: the new intervals
  // are measured in the upstream derivative while the persisted map must point
  // back to the original source.  Extraction has no general inverse mapping,
  // so reject that ambiguous composition rather than recording false lineage.
  if (upstreamDerivative && redacted.redactionMap.length > 0 && (
    upstreamDerivative.redactionMap.length > 0
    || upstreamDerivative.originalCoordinateSpace !== "extracted-text-utf8"
  )) {
    throw new Error(`cannot compose evidence derivative redaction maps without a shared extracted-text coordinate space: ${input.uri ?? "inline://owner-content"}`);
  }
  const derivativeBytes = Buffer.from(redacted.text, "utf8");
  const extractedTextBytes = Buffer.from(extractedText, "utf8");
  const evidenceDerivative = !upstreamDerivative && Buffer.from(bytes).equals(derivativeBytes)
    ? undefined
    : {
      bytes: derivativeBytes,
      text: redacted.text,
      kind: redacted.redactionMap.some(interval => interval.replacement === "[REDACTED]")
        ? "redacted-text" as const
        : upstreamDerivative?.kind ?? "extracted-text" as const,
      transformId: redacted.redactionMap.length
        ? `${upstreamDerivative?.transformId ?? "scce.source-text-derivative.v1"}+scce.secret-redaction.v1`
        : upstreamDerivative?.transformId ?? "scce.source-text-derivative.v1",
      originalCoordinateSpace: upstreamDerivative?.originalCoordinateSpace
        ?? (Buffer.from(bytes).equals(extractedTextBytes) ? "source-bytes" as const : "extracted-text-utf8" as const),
      redactionMap: [...(upstreamDerivative?.redactionMap ?? []), ...redacted.redactionMap]
    };
  const uri = input.uri ?? "inline://owner-content";
  const hash = `sha256_${hasher.digestHex(bytes)}` as ContentHash;
  yield {
    type: "file",
    file: {
      uri,
      namespace: input.namespace ?? "inline",
      mediaType: input.mediaType ?? "text/plain",
      bytes,
      text: redacted.text,
      metadata: input.metadata ?? null,
      evidenceDerivative
    },
    checkpoint: {
      id: `ingest_${hasher.digestHex(`${uri}\u001f${hash}`).slice(0, 32)}`,
      rootUri: uri,
      itemUri: uri,
      phase: "extracted",
      status: "complete",
      offsetBytes: bytes.byteLength,
      contentHash: hash,
      byteLength: bytes.byteLength,
      updatedAt: now,
      metadata: toJsonValue({ inline: true, mediaType: input.mediaType ?? "text/plain" })
    }
  };
}
