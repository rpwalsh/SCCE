// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CapabilityOperation } from "./capability-runtime.js";
import { buildTestActualDelta, buildTestEvidenceRefs } from "./build-test-capability.js";
import type { BlobStore, BuildTestPort, ConnectorPort } from "./storage.js";
import { toJsonValue } from "./primitives.js";
import type { BuildTestResult, Capability, ConstructGraph, ContentHash, EpisodeId, JsonValue } from "./types.js";

type ObjectValue = Record<string, JsonValue>;
type FieldType = "string" | "strings" | "positive_integer" | "object" | "json";
type Fields = Record<string, FieldType | { optional: FieldType }>;

function object(value: JsonValue): ObjectValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("capability input must be an object");
  return value;
}

function validate(value: JsonValue, fields: Fields): void {
  const row = object(value);
  for (const [key, declaration] of Object.entries(fields)) {
    const optional = typeof declaration === "object";
    const type = optional ? declaration.optional : declaration;
    const field = row[key];
    if (field === undefined && optional) continue;
    const valid = type === "string" ? typeof field === "string"
      : type === "strings" ? Array.isArray(field) && field.every(item => typeof item === "string")
      : type === "positive_integer" ? Number.isSafeInteger(field) && Number(field) > 0
      : type === "json" ? field !== undefined : Boolean(field && typeof field === "object" && !Array.isArray(field));
    if (!valid) throw new Error(`capability input ${key} requires ${type}`);
  }
  if (Object.keys(row).some(key => !Object.hasOwn(fields, key))) throw new Error("capability input has undeclared fields");
}

function resourceId(result: JsonValue): string[] {
  const row = result && typeof result === "object" && !Array.isArray(result) ? result : {};
  const id = row.id ?? row.sid;
  return typeof id === "string" && id ? [id] : [];
}

function partialResourceResult(error: unknown): JsonValue | undefined {
  if (!error || typeof error !== "object") return undefined;
  const row = error as { messageId?: unknown; eventId?: unknown };
  const id = row.eventId ?? row.messageId;
  return typeof id === "string" && id ? { id } : undefined;
}

export function createConnectorCapabilityOperations(input: {
  connectors?: ConnectorPort;
  blobs: Pick<BlobStore, "put" | "get">;
  capabilities: readonly Capability[];
  buildTest?: BuildTestPort;
}): CapabilityOperation[] {
  const capabilities = new Map(input.capabilities.map(row => [row.id, row]));
  const operations: CapabilityOperation[] = [];
  const add = (id: string, fields: Fields, execute: CapabilityOperation["execute"], extra: Partial<CapabilityOperation> = {}) => {
    const capability = capabilities.get(id);
    if (!capability) return;
    operations.push({ capability, phase: capability.mutates ? "commit" : "read", inputSchema: toJsonValue(fields),
      validate: value => validate(value, fields), execute, outputRefs: resourceId, ...extra });
  };
  const port = input.connectors;
  if (port) {
  add("network.search", { query: "string", limit: "positive_integer" }, async value => {
    const row = object(value);
    return toJsonValue(await port.search(row.query as string, row.limit as number));
  });
  add("network.fetch", { uri: "string" }, async value => {
    const fetched = await port.fetch(object(value).uri as string);
    const bodyRef = await input.blobs.put(fetched.bytes, fetched.mediaType);
    const derivative = fetched.evidenceDerivative;
    return toJsonValue({ uri: fetched.uri, mediaType: fetched.mediaType, bodyRef, metadata: fetched.metadata,
      ...(derivative ? { evidenceDerivative: { kind: derivative.kind, transformId: derivative.transformId,
        originalCoordinateSpace: derivative.originalCoordinateSpace, redactionMap: derivative.redactionMap,
        bodyRef: await input.blobs.put(derivative.bytes, "text/plain;charset=utf-8") } } : {}) });
  });
  if (port.outlookSearch) add("outlook.search_mail", { query: "string", limit: { optional: "positive_integer" } }, value => {
    const row = object(value); return port.outlookSearch!(row.query as string, row.limit as number | undefined);
  });
  if (port.outlookReadMessage) add("outlook.read_mail", { messageId: "string" }, value => port.outlookReadMessage!(object(value).messageId as string));
  if (port.outlookCreateDraft) add("outlook.create_draft", { to: "strings", subject: "string", body: "string", cc: { optional: "strings" } }, value =>
    port.outlookCreateDraft!({ ...object(value) as unknown as Parameters<NonNullable<ConnectorPort["outlookCreateDraft"]>>[0], approved: true }),
    { partialResult: partialResourceResult, compensation: { capabilityId: "outlook.delete_draft", payload: result => ({ messageId: resourceId(result)[0] ?? "" }) } });
  if (port.outlookDeleteDraft) add("outlook.delete_draft", { messageId: "string" }, value => port.outlookDeleteDraft!(object(value).messageId as string, true));
  if (port.outlookSendDraft) add("outlook.send_mail", { messageId: "string" }, value => port.outlookSendDraft!(object(value).messageId as string, true));
  if (port.outlookReadCalendar) add("outlook.read_calendar", { start: "string", end: "string" }, value =>
    port.outlookReadCalendar!(object(value) as unknown as { start: string; end: string }));
  if (port.outlookCreateCalendarEvent) add("outlook.create_calendar_event", { subject: "string", start: "string", end: "string", attendees: { optional: "strings" }, body: { optional: "string" } }, value =>
    port.outlookCreateCalendarEvent!({ ...object(value) as unknown as Parameters<NonNullable<ConnectorPort["outlookCreateCalendarEvent"]>>[0], approved: true }),
    { partialResult: partialResourceResult, compensation: { capabilityId: "outlook.delete_calendar_event", payload: result => ({ eventId: resourceId(result)[0] ?? "" }) } });
  if (port.outlookDeleteCalendarEvent) add("outlook.delete_calendar_event", { eventId: "string" }, value => port.outlookDeleteCalendarEvent!(object(value).eventId as string, true));
  if (port.outlookReadContacts) add("outlook.read_contacts", { query: { optional: "string" } }, value => port.outlookReadContacts!(object(value).query as string | undefined));
  if (port.youtubeSearch) add("youtube.search", { query: "string", limit: { optional: "positive_integer" } }, value => {
    const row = object(value); return port.youtubeSearch!(row.query as string, row.limit as number | undefined);
  });
  if (port.youtubeVideo) add("youtube.read_video_metadata", { videoId: "string" }, value => port.youtubeVideo!(object(value).videoId as string));
  if (port.youtubeChannel) add("youtube.read_channel_metadata", { channelId: "string" }, value => port.youtubeChannel!(object(value).channelId as string));
  if (port.youtubeComments) add("youtube.read_comments", { videoId: "string", limit: { optional: "positive_integer" } }, value => {
    const row = object(value); return port.youtubeComments!(row.videoId as string, row.limit as number | undefined);
  });
  if (port.telephoneCall) add("telephone.call", { to: "string", twiml: "string" }, value => {
    const row = object(value); return port.telephoneCall!(row.to as string, row.twiml as string, true);
  });
  }
  if (input.buildTest) {
    for (const id of ["process.build_test", "program.local_validation"]) add(id, { episodeId: "string", construct: "object", faultInjection: { optional: "string" } }, async value => {
      const row = object(value);
      const construct = row.construct as unknown as ConstructGraph;
      if (!construct.program || !Array.isArray(construct.artifacts)) throw new Error("build/test capability requires a program construct");
      return toJsonValue(await input.buildTest!.executeProgram({ episodeId: row.episodeId as EpisodeId, construct,
        ...(typeof row.faultInjection === "string" ? { faultInjection: row.faultInjection } : {}) }));
    }, { succeeded: result => object(result).passed === true,
      evidenceRefs: result => buildTestEvidenceRefs(result as unknown as BuildTestResult),
      actualDelta: (result, payload) => buildTestActualDelta(object(payload).construct as unknown as ConstructGraph, result as unknown as BuildTestResult),
      outputRefs: result => {
      const artifacts = object(result).artifacts;
      return Array.isArray(artifacts) ? artifacts.flatMap(value => typeof object(value).path === "string" ? [object(value).path as string] : []) : [];
    } });
  }
  return operations;
}

export async function restoreFetchedCapabilityResult(result: JsonValue, blobs: Pick<BlobStore, "get">): Promise<Awaited<ReturnType<ConnectorPort["fetch"]>>> {
  const row = object(result);
  validate(row, { uri: "string", mediaType: "string", bodyRef: "string", metadata: "json", evidenceDerivative: { optional: "object" } });
  const derivative = row.evidenceDerivative ? object(row.evidenceDerivative) : undefined;
  const derivativeBytes = derivative ? await blobs.get(derivative.bodyRef as ContentHash) : undefined;
  return { uri: row.uri as string, mediaType: row.mediaType as string, bytes: await blobs.get(row.bodyRef as ContentHash), metadata: row.metadata!,
    ...(derivative && derivativeBytes ? { evidenceDerivative: {
      kind: derivative.kind as "extracted-text" | "redacted-text", transformId: derivative.transformId as string,
      originalCoordinateSpace: derivative.originalCoordinateSpace as "source-bytes" | "extracted-text-utf8",
      redactionMap: derivative.redactionMap as unknown as NonNullable<Awaited<ReturnType<ConnectorPort["fetch"]>>["evidenceDerivative"]>["redactionMap"],
      bytes: derivativeBytes, text: new TextDecoder().decode(derivativeBytes)
    } } : {}) };
}
