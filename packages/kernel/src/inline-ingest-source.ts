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
  const originalText = typeof input.content === "string"
    ? input.content
    : Buffer.from(bytes).toString("utf8");
  const redacted = redactSecretsWithMap(originalText);
  const derivativeBytes = Buffer.from(redacted.text, "utf8");
  const originalTextBytes = Buffer.from(originalText, "utf8");
  const evidenceDerivative = Buffer.from(bytes).equals(derivativeBytes)
    ? undefined
    : {
      bytes: derivativeBytes,
      text: redacted.text,
      kind: redacted.redactionMap.some(interval => interval.replacement === "[REDACTED]")
        ? "redacted-text" as const
        : "extracted-text" as const,
      transformId: "scce.source-text-derivative.v1",
      originalCoordinateSpace: Buffer.from(bytes).equals(originalTextBytes)
        ? "source-bytes" as const
        : "extracted-text-utf8" as const,
      redactionMap: redacted.redactionMap
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
