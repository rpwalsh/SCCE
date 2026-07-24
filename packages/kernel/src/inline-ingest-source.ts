import { createHasher, redactSecrets, toJsonValue } from "./primitives.js";
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
  const text = redactSecrets(
    typeof input.content === "string" ? input.content : Buffer.from(bytes).toString("utf8")
  );
  const uri = input.uri ?? "inline://owner-content";
  const hash = `sha256_${hasher.digestHex(bytes)}` as ContentHash;
  yield {
    type: "file",
    file: {
      uri,
      namespace: input.namespace ?? "inline",
      mediaType: input.mediaType ?? "text/plain",
      bytes,
      text,
      metadata: input.metadata ?? null
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
