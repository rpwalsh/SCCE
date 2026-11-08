// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { IngestResult, JsonValue } from "@scce/kernel";

/** Event hashes refer to the complete persisted events; receipt payloads are explicitly projected. */
export function compactIngestResult(result: IngestResult): Record<string, unknown> {
  return {
    ...result,
    responseView: { schema: "scce.ingest_response.v1", detail: "receipt", fullQuery: "full=1" },
    events: result.events.map(event => ({
      ...event,
      payloadView: "receipt",
      payload: ingestEventReceipt(event.typeId, event.payload)
    }))
  };
}

export function compactWorkspaceIngestResult<T extends { kernelResults: IngestResult[] }>(result: T): Record<string, unknown> {
  return {
    ...result,
    responseView: { schema: "scce.workspace.ingest_response.v1", detail: "receipt", fullQuery: "full=1" },
    kernelResults: result.kernelResults.map(compactIngestResult)
  };
}

function ingestEventReceipt(typeId: string, payload: JsonValue): Record<string, JsonValue> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return {};
  const fields = typeId === "SourceObserved" ? ["sourceId", "uri", "namespace"]
    : typeId === "SourceVersionObserved" ? ["sourceVersionId", "contentHash", "byteLength", "role", "derivedFromSourceVersionId", "transformId"]
    : typeId === "SourcePromoted" || typeId === "SourceQuarantined" ? ["sourceVersionId", "context", "sourceTrust", "trustChecks", "parserDiagnosticReliability", "activeInfluence", "risk", "disposition", "reasons", "safetyRails"]
    : ["sourceVersionId", "sourceId", "profileId", "uri"];
  return Object.fromEntries(fields.filter(key => payload[key] !== undefined).map(key => [key, payload[key]!])) as Record<string, JsonValue>;
}
