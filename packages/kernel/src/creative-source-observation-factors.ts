// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { deriveCreativeSourceCorrespondence, type CreativeSourceCorrespondence } from "./creative-source-correspondence.js";
import { canonicalStringify, createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";

export const CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA = "scce.creative_source_observation_factors.v1" as const;
type SourceGroup = Pick<CreativeSourceCorrespondence, "requestFrameId" | "sourceId" | "sourceVersionId" | "request" | "reply">;
type Occurrence = [group: number, eventId: string, eventRelationId: string, eventConstructionId: string,
  eventArgumentFrameId: string, bindings: CreativeSourceCorrespondence["bindings"]];
export interface CreativeSourceObservationFactors {
  schema: typeof CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA;
  contentDigest: string;
  groups: SourceGroup[];
  occurrences: Occurrence[];
}
const failure = (): never => { throw new Error("invalid creative source observation factors"); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value)
  ? value as Record<string, unknown> : failure();
const requiredText = (value: unknown): string => typeof value === "string" && value.length > 0 ? value : failure();
const integer = (value: unknown): number => Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : failure();
function keys(row: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): void {
  if (required.some(key => !Object.hasOwn(row, key)) || Object.keys(row).some(key => !required.includes(key) && !optional.includes(key))) failure();
}
const groupKeys = ["requestFrameId", "sourceId", "sourceVersionId", "request", "reply"] as const;
const occurrenceKeys = ["eventId", "eventRelationId", "eventConstructionId", "eventArgumentFrameId", "bindings"] as const;
const witnessKeys = ["turnIndex", "evidenceId", "contentHash", "start", "end", "surfaceHash"] as const;
function sourceGroup(value: unknown): SourceGroup {
  const group = record(value); keys(group, groupKeys);
  const request = record(group.request), reply = record(group.reply);
  keys(request, [...witnessKeys, "surface", "sourceAuthority"]);
  keys(reply, [...witnessKeys, "replyToTurnIndex", "commitmentScope"]);
  for (const witness of [request, reply]) {
    for (const field of ["evidenceId", "contentHash", "surfaceHash"]) requiredText(witness[field]);
    for (const field of ["turnIndex", "start", "end"]) integer(witness[field]);
    if (Number(witness.end) <= Number(witness.start)) failure();
  }
  if (typeof request.surface !== "string" || !["creative", "unknown"].includes(String(request.sourceAuthority))
    || reply.commitmentScope !== "conversation" || integer(reply.replyToTurnIndex) !== request.turnIndex
    || Number(request.turnIndex) >= Number(reply.turnIndex)) failure();
  return { requestFrameId: requiredText(group.requestFrameId), sourceId: requiredText(group.sourceId), sourceVersionId: requiredText(group.sourceVersionId),
    request: structuredClone(request) as unknown as SourceGroup["request"], reply: structuredClone(reply) as unknown as SourceGroup["reply"] };
}
function bindings(value: unknown): CreativeSourceCorrespondence["bindings"] {
  if (!Array.isArray(value)) return failure();
  return value.map(raw => {
    const binding = record(raw); keys(binding, ["requestRoleId", "eventRoleId", "requestStart", "requestEnd", "eventStart", "eventEnd"], ["sourceReference"]);
    requiredText(binding.requestRoleId);
    if (binding.eventRoleId !== "scce.role.patient" && binding.eventRoleId !== "scce.role.complement") failure();
    for (const field of ["requestStart", "requestEnd", "eventStart", "eventEnd"]) integer(binding[field]);
    if (Number(binding.requestEnd) <= Number(binding.requestStart) || Number(binding.eventEnd) <= Number(binding.eventStart)) failure();
    if (Object.hasOwn(binding, "sourceReference")) {
      const reference = record(binding.sourceReference); keys(reference, ["patternId", "referentId", "propertyId"]);
      for (const field of ["patternId", "referentId", "propertyId"]) requiredText(reference[field]);
    }
    return structuredClone(binding) as unknown as CreativeSourceCorrespondence["bindings"][number];
  });
}
function digest(groups: SourceGroup[], occurrences: Occurrence[], hasher: Hasher): string {
  return hasher.digestHex(canonicalStringify({ groups, occurrences }));
}

/** One request/reply premise is retained once for its ordered event correspondences. */
export function creativeSourceObservationStorageForm(rows: readonly CreativeSourceCorrespondence[], hasher: Hasher = createHasher()): CreativeSourceObservationFactors {
  if (!Array.isArray(rows)) return failure();
  const groups: SourceGroup[] = [], occurrences: Occurrence[] = [], groupIndex = new Map<string, number>();
  for (const raw of rows) {
    const row = record(raw); keys(row, ["id", ...groupKeys, ...occurrenceKeys]);
    const group = sourceGroup(Object.fromEntries(groupKeys.map(key => [key, row[key]]))), occurrenceBindings = bindings(row.bindings);
    const material = { ...group, eventId: requiredText(row.eventId), eventRelationId: requiredText(row.eventRelationId),
      eventConstructionId: requiredText(row.eventConstructionId), eventArgumentFrameId: requiredText(row.eventArgumentFrameId), bindings: occurrenceBindings };
    if (row.id !== deriveCreativeSourceCorrespondence(material, hasher).id) return failure();
    const key = canonicalStringify(group); let index = groupIndex.get(key);
    if (index === undefined) { index = groups.length; groups.push(group); groupIndex.set(key, index); }
    occurrences.push([index, material.eventId, material.eventRelationId, material.eventConstructionId, material.eventArgumentFrameId, occurrenceBindings]);
  }
  return { schema: CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA, contentDigest: digest(groups, occurrences, hasher), groups, occurrences };
}

/** Restores the original logical rows before the existing source/evidence authorization verifier. */
export function creativeSourceObservationsFromStorage(value: unknown, hasher: Hasher = createHasher()): CreativeSourceCorrespondence[] {
  const root = record(value); keys(root, ["schema", "contentDigest", "groups", "occurrences"]);
  if (root.schema !== CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA || !Array.isArray(root.groups) || !Array.isArray(root.occurrences)) return failure();
  const groups = root.groups.map(sourceGroup), unique = new Set(groups.map(group => canonicalStringify(group)));
  if (unique.size !== groups.length) return failure();
  const used = new Set<number>();
  const occurrences: Occurrence[] = root.occurrences.map(raw => {
    if (!Array.isArray(raw) || raw.length !== 6) return failure();
    const index = integer(raw[0]); if (index >= groups.length) return failure(); used.add(index);
    return [index, requiredText(raw[1]), requiredText(raw[2]), requiredText(raw[3]), requiredText(raw[4]), bindings(raw[5])];
  });
  if (used.size !== groups.length || root.contentDigest !== digest(groups, occurrences, hasher)) return failure();
  return occurrences.map(([index, eventId, eventRelationId, eventConstructionId, eventArgumentFrameId, occurrenceBindings]) =>
    deriveCreativeSourceCorrespondence({ ...structuredClone(groups[index]!), eventId, eventRelationId, eventConstructionId,
      eventArgumentFrameId, bindings: occurrenceBindings }, hasher));
}
