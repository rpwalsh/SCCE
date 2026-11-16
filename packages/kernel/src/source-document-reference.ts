// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { EvidenceSpan, JsonValue } from "./types.js";

function objectRecord(value: JsonValue | undefined): Record<string, JsonValue> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {}; }

/** The path a documentation surface was trained from, as the corpus lane recorded it. */
export function documentedPath(span: Pick<EvidenceSpan, "provenance">): string | undefined {
  const provenance = span.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const value = (provenance as Record<string, JsonValue>).relativePath ?? objectRecord(objectRecord((provenance as Record<string, JsonValue>).metadata).workspaceFile).path;
  return typeof value === "string" && value.trim() ? value : undefined;
}

export function documentedRepositoryFamily(span: Pick<EvidenceSpan, "provenance">): string | undefined {
  const provenance = span.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const repository = (provenance as Record<string, JsonValue>).repository;
  if (!repository || typeof repository !== "object" || Array.isArray(repository)) {
    const workspaceId=objectRecord(objectRecord((provenance as Record<string,JsonValue>).metadata).workspace).id;
    return typeof workspaceId==="string"&&workspaceId?`scce://workspace/${encodeURIComponent(workspaceId)}`:undefined;
  }
  const ownerUri = (repository as Record<string, JsonValue>).ownerUri;
  return typeof ownerUri === "string" && ownerUri.trim() ? ownerUri : undefined;
}

export function documentedSourceHash(span: Pick<EvidenceSpan, "provenance">): string | undefined {
  const provenance = span.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const value = (provenance as Record<string, JsonValue>).sourceHash ?? objectRecord(objectRecord((provenance as Record<string, JsonValue>).metadata).workspaceFile).contentHash;
  return typeof value === "string" && value.trim() ? value : undefined;
}
