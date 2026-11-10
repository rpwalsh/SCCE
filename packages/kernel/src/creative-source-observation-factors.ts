// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { deriveCreativeSourceCorrespondence, type CreativeSourceCorrespondence } from "./creative-source-correspondence.js";
import { createHasher } from "./primitives.js";
import type { Hasher } from "./types.js";

export const CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA = "scce.creative_source_observation_factors.v1" as const;
type SourceGroup = Pick<CreativeSourceCorrespondence, "requestFrameId" | "sourceId" | "sourceVersionId" | "request" | "reply">;
type Occurrence = [group: number, eventId: string, relation: number, construction: number, argumentFrame: number, bindings: number];
export interface CreativeSourceObservationFactors {
  schema: typeof CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA;
  contentDigest: string;
  groups: SourceGroup[];
  eventRelations: string[];
  eventConstructions: string[];
  eventArgumentFrames: string[];
  bindingSets: CreativeSourceCorrespondence["bindings"][];
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
function exactJson(value: unknown): string {
  const sorted = (value: unknown): unknown => Array.isArray(value) ? value.map(sorted)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([key, member]) => [key, sorted(member)])) : value;
  return JSON.stringify(sorted(value));
}
type Facts = Omit<CreativeSourceObservationFactors, "schema" | "contentDigest">;
function digest(facts: Facts, hasher: Hasher): string {
  return hasher.digestHex(exactJson(facts));
}
function dictionary<T>() {
  const values: T[] = [], index = new Map<string, number>();
  return { values, intern(value: T): number {
    const key = exactJson(value); let id = index.get(key);
    if (id === undefined) { id = values.length; values.push(value); index.set(key, id); }
    return id;
  } };
}

/** One request/reply premise is retained once for its ordered event correspondences. */
export function creativeSourceObservationStorageForm(rows: readonly CreativeSourceCorrespondence[], hasher: Hasher = createHasher()): CreativeSourceObservationFactors {
  if (!Array.isArray(rows)) return failure();
  const groups = dictionary<SourceGroup>(), relations = dictionary<string>(), constructions = dictionary<string>(), argumentFrames = dictionary<string>();
  const bindingSets = dictionary<CreativeSourceCorrespondence["bindings"]>(), occurrences: Occurrence[] = [];
  for (const raw of rows) {
    const row = record(raw); keys(row, ["id", ...groupKeys, ...occurrenceKeys]);
    const group = sourceGroup(Object.fromEntries(groupKeys.map(key => [key, row[key]]))), occurrenceBindings = bindings(row.bindings);
    const material = { ...group, eventId: requiredText(row.eventId), eventRelationId: requiredText(row.eventRelationId),
      eventConstructionId: requiredText(row.eventConstructionId), eventArgumentFrameId: requiredText(row.eventArgumentFrameId), bindings: occurrenceBindings };
    if (row.id !== deriveCreativeSourceCorrespondence(material, hasher).id) return failure();
    occurrences.push([groups.intern(group), material.eventId, relations.intern(material.eventRelationId), constructions.intern(material.eventConstructionId),
      argumentFrames.intern(material.eventArgumentFrameId), bindingSets.intern(occurrenceBindings)]);
  }
  const facts = { groups: groups.values, eventRelations: relations.values, eventConstructions: constructions.values,
    eventArgumentFrames: argumentFrames.values, bindingSets: bindingSets.values, occurrences };
  return { schema: CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA, contentDigest: digest(facts, hasher), ...facts };
}

/** Restores the original logical rows before the existing source/evidence authorization verifier. */
export function creativeSourceObservationsFromStorage(value: unknown, hasher: Hasher = createHasher()): CreativeSourceCorrespondence[] {
  const root = record(value); keys(root, ["schema", "contentDigest", "groups", "eventRelations", "eventConstructions", "eventArgumentFrames", "bindingSets", "occurrences"]);
  if (root.schema !== CREATIVE_SOURCE_OBSERVATION_FACTORS_SCHEMA || !Array.isArray(root.groups) || !Array.isArray(root.occurrences)) return failure();
  const table = <T>(raw: unknown, validate: (value: unknown) => T): T[] => {
    if (!Array.isArray(raw)) return failure();
    const values = raw.map(validate);
    if (new Set(values.map(exactJson)).size !== values.length) return failure();
    return values;
  };
  const groups = table(root.groups, sourceGroup), eventRelations = table(root.eventRelations, requiredText), eventConstructions = table(root.eventConstructions, requiredText);
  const eventArgumentFrames = table(root.eventArgumentFrames, requiredText), bindingSets = table(root.bindingSets, bindings);
  const tables = [groups, eventRelations, eventConstructions, eventArgumentFrames, bindingSets], used = tables.map(() => new Set<number>());
  const occurrences: Occurrence[] = root.occurrences.map(raw => {
    if (!Array.isArray(raw) || raw.length !== 6) return failure();
    const refs = [raw[0], raw[2], raw[3], raw[4], raw[5]].map((value, index) => {
      const id = integer(value); if (id >= tables[index]!.length) return failure(); used[index]!.add(id); return id;
    });
    return [refs[0]!, requiredText(raw[1]), refs[1]!, refs[2]!, refs[3]!, refs[4]!];
  });
  if (used.some((set, index) => set.size !== tables[index]!.length)
    || root.contentDigest !== digest({ groups, eventRelations, eventConstructions, eventArgumentFrames, bindingSets, occurrences }, hasher)) return failure();
  return occurrences.map(([index, eventId, relation, construction, argumentFrame, binding]) =>
    deriveCreativeSourceCorrespondence({ ...structuredClone(groups[index]!), eventId, eventRelationId: eventRelations[relation]!, eventConstructionId: eventConstructions[construction]!,
      eventArgumentFrameId: eventArgumentFrames[argumentFrame]!, bindings: structuredClone(bindingSets[binding]!) }, hasher));
}
