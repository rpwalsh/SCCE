// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { TranscriptTurn } from "./dialogue-communicative-act-learning.js";
import type { DurableCreativeEventConstruction } from "./language-construction-memory.js";
import type { AlignedSurfaceExample } from "./language-construction.js";
import type { CreativeEventCompatibilityModel, CreativeRequestFrameAnchor } from "./creative-event-compatibility.js";
import { canonicalStringify, toJsonValue } from "./primitives.js";
import { segmentUnicodeSurfaceV2 } from "./unicode-segmentation-v2.js";
import type { EvidenceSpan, Hasher } from "./types.js";
import type { LanguagePatternRecord } from "./storage.js";

export const CREATIVE_SOURCE_CORRESPONDENCE_RECIPE = "kernel.creative_source_correspondence.v1" as const;

export interface CreativeSourceCorrespondence {
  id: string;
  requestFrameId: string;
  sourceId: string;
  sourceVersionId: string;
  request: SourceTurnWitness & { surface: string };
  reply: SourceTurnWitness & { replyToTurnIndex: number; commitmentScope: "conversation" };
  eventId: string;
  eventRelationId: string;
  eventConstructionId: string;
  eventArgumentFrameId: string;
  bindings: Array<{ requestRoleId: string; eventRoleId: "scce.role.patient" | "scce.role.complement";
    requestStart: number; requestEnd: number; eventStart: number; eventEnd: number }>;
}

interface SourceTurnWitness {
  turnIndex: number;
  evidenceId: string;
  contentHash: string;
  start: number;
  end: number;
  surfaceHash: string;
}

export interface CreativeSourceCorrespondenceContext {
  evidence: readonly EvidenceSpan[];
  events: readonly DurableCreativeEventConstruction[];
  hasher: Hasher;
}

export function compileCreativeSourceCorrespondences(input: CreativeSourceCorrespondenceContext & {
  turns: readonly TranscriptTurn[]; profileId: string; updatedAt: number;
}): LanguagePatternRecord[] {
  const evidence = input.evidence.filter(span => span.status === "promoted");
  const byIndex = new Map(input.turns.map(turn => [turn.index, turn]));
  if (byIndex.size !== input.turns.length) return [];
  const observations: CreativeSourceCorrespondence[] = [];
  const anchors = new Map<string, CreativeRequestFrameAnchor>();
  const compilerId = CREATIVE_SOURCE_CORRESPONDENCE_RECIPE;
  for (const reply of input.turns) {
    const request = byIndex.get(reply.replyToTurnIndex ?? -1);
    if (!request || request.requestAuthority !== "creative" || reply.commitmentScope !== "conversation"
      || request.index >= reply.index || request.endCodePoint > reply.startCodePoint) continue;
    const requestOwner = evidence.find(span => ownsTurn(span, request));
    const replyOwner = evidence.find(span => ownsTurn(span, reply) && span.sourceId === requestOwner?.sourceId && span.sourceVersionId === requestOwner?.sourceVersionId);
    if (!requestOwner || !replyOwner) continue;
    const responseEvents = input.events.filter(event => event.evidenceId === String(replyOwner.id)
      && replyOwner.charStart + event.labelStartCodePoint >= reply.startCodePoint
      && replyOwner.charStart + event.labelEndCodePoint <= reply.endCodePoint);
    const segments = segmentUnicodeSurfaceV2(request.surface).lexicalSegments;
    const spans = new Map<string, { start: number; end: number }>();
    const eventMatches = responseEvents.map(event => ({ event, bindings: event.argumentFrame.bindings.flatMap(port => {
      if (port.roleId !== "scce.role.patient" && port.roleId !== "scce.role.complement") return [];
      const units = segmentUnicodeSurfaceV2(port.surface).lexicalSegments.map(row => row.normalized);
      if (!units.length) return [];
      const matches = segments.flatMap((segment, index) => units.every((unit, offset) => segments[index + offset]?.normalized === unit)
        ? [{ start: segment.codePointStart, end: segments[index + units.length - 1]!.codePointEnd }] : []);
      if (matches.length !== 1) return [];
      const match = matches[0]!;
      spans.set(`${match.start}:${match.end}`, match);
      return [{ ...match, port }];
    }) }));
    spans.clear();
    for (const row of eventMatches) if (row.bindings.length === row.event.argumentFrame.bindings.length) for (const binding of row.bindings) {
      spans.set(`${binding.start}:${binding.end}`, { start: binding.start, end: binding.end });
    }
    const roles = [...spans.values()].sort((a, b) => a.start - b.start || a.end - b.end);
    if (!roles.length || roles.some((role, index) => index > 0 && role.start < roles[index - 1]!.end)) continue;
    const points = [...request.surface];
    let cursor = 0;
    const topology = roles.map(role => { const literal = points.slice(cursor, role.start).join("").normalize("NFKC").toLocaleLowerCase(); cursor = role.end; return literal; });
    topology.push(points.slice(cursor).join("").normalize("NFKC").toLocaleLowerCase());
    const requestFrameId = digest(input.hasher, "creative.request.observed.frame", { compilerId, topology });
    const roleIds = roles.map((_, index) => `${requestFrameId}.role.${index}`);
    const requestWitness = { ...turnWitness(requestOwner, request, input.hasher), surface: request.surface };
    const replyWitness = { ...turnWitness(replyOwner, reply, input.hasher), replyToTurnIndex: request.index, commitmentScope: "conversation" as const };
    for (const { event, bindings } of eventMatches) {
      if (bindings.length !== event.argumentFrame.bindings.length) continue;
      const material: Omit<CreativeSourceCorrespondence, "id"> = {
        requestFrameId, sourceId: String(requestOwner.sourceId), sourceVersionId: String(requestOwner.sourceVersionId),
        request: requestWitness, reply: replyWitness, eventId: event.id, eventRelationId: event.relationId,
        eventConstructionId: event.constructionId, eventArgumentFrameId: event.argumentFrame.id,
        bindings: bindings.map(({ start, end, port }) => ({ requestRoleId: roleIds[roles.findIndex(role => role.start === start && role.end === end)]!,
          eventRoleId: port.roleId as "scce.role.patient" | "scce.role.complement", requestStart: start, requestEnd: end,
          eventStart: port.startCodePoint, eventEnd: port.endCodePoint }))
      };
      observations.push({ ...material, id: digest(input.hasher, "creative.source.correspondence", material) });
    }
    if (!observations.some(row => row.requestFrameId === requestFrameId)) continue;
    const example: AlignedSurfaceExample = { id: digest(input.hasher, "creative.request.observed.example", { requestFrameId, requestWitness }),
      profileKey: compilerId, surface: request.surface, evidenceIds: [String(requestOwner.id)], roleSpans: roles.map((role, index) => ({
        roleId: roleIds[index]!, occurrenceId: roleIds[index]!, start: role.start, end: role.end,
        surface: points.slice(role.start, role.end).join(""), evidenceIds: [String(requestOwner.id)] })) };
    const previous = anchors.get(requestFrameId);
    anchors.set(requestFrameId, { requestFrameId, requestCompilerId: compilerId,
      lexicalKeys: [...new Set(segments.map(row => row.normalized))].sort(), requestRoleIds: roleIds,
      support: (previous?.support ?? 0) + 1, observedSupport: (previous?.observedSupport ?? 0) + 1, acceptedSupport: 0, rejectedSupport: 0,
      exampleTextHashes: [...(previous?.exampleTextHashes ?? []), example.id], requestRoleExamples: [...(previous?.requestRoleExamples ?? []), example] });
  }
  if (!observations.length) return [];
  const unique = [...new Map(observations.map(row => [row.id, row])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const eventCompilers = [...new Set(input.events.filter(event => unique.some(row => row.eventId === event.id)).map(event => event.compilerId))];
  return eventCompilers.map(eventCompilerId => {
    const sourceObservations = unique.filter(row => input.events.some(event => event.id === row.eventId && event.compilerId === eventCompilerId));
    const material = { schema: "scce.creative_event_compatibility_model.v1" as const, version: CREATIVE_SOURCE_CORRESPONDENCE_RECIPE,
      requestCompilerId: compilerId, eventCompilerId, reliability: "source_observed" as const, eventCompatibilities: [], roleCompatibilities: [],
      sourceObservations, requestFrameAnchors: [...anchors.values()].sort((a, b) => a.requestFrameId.localeCompare(b.requestFrameId)) };
    const id = digest(input.hasher, "creative.observed.compatibility", material);
    const model: CreativeEventCompatibilityModel = { ...material, id };
    return { id, profileId: input.profileId, patternKind: "semantic_role" as const, support: sourceObservations.length, entropy: 0,
      patternJson: toJsonValue(model), evidenceIds: [...new Set(sourceObservations.flatMap(row => [row.request.evidenceId, row.reply.evidenceId]))] as EvidenceSpan["id"][], updatedAt: input.updatedAt };
  });
}

export function verifyCreativeSourceCorrespondence(row: CreativeSourceCorrespondence, context: CreativeSourceCorrespondenceContext, owners: readonly string[]): boolean {
  if (!row || typeof row !== "object" || !row.request || !row.reply || !Array.isArray(row.bindings)
    || typeof row.request.surface !== "string" || typeof row.request.surfaceHash !== "string" || typeof row.reply.surfaceHash !== "string"
    || !Number.isSafeInteger(row.request.turnIndex) || !Number.isSafeInteger(row.reply.turnIndex)
    || row.bindings.some(binding => !binding || typeof binding !== "object" || typeof binding.requestRoleId !== "string"
      || !Number.isSafeInteger(binding.requestStart) || !Number.isSafeInteger(binding.requestEnd)
      || !Number.isSafeInteger(binding.eventStart) || !Number.isSafeInteger(binding.eventEnd))) return false;
  const { id, ...material } = row;
  if (id !== digest(context.hasher, "creative.source.correspondence", material) || row.reply.commitmentScope !== "conversation"
    || row.reply.replyToTurnIndex !== row.request.turnIndex || row.request.turnIndex >= row.reply.turnIndex) return false;
  const request = context.evidence.find(span => String(span.id) === row.request.evidenceId);
  const reply = context.evidence.find(span => String(span.id) === row.reply.evidenceId);
  if (!request || !reply || !owners.includes(String(request.id)) || !owners.includes(String(reply.id))
    || !validWitness(request, row.request, row, context.hasher) || !validWitness(reply, row.reply, row, context.hasher)
    || [...request.text].slice(row.request.start, row.request.end).join("") !== row.request.surface
    || request.charStart + row.request.end > reply.charStart + row.reply.start) return false;
  const event = context.events.find(event => event.id === row.eventId && event.evidenceId === String(reply.id)
    && event.sourceVersionId === row.sourceVersionId && event.relationId === row.eventRelationId
    && event.constructionId === row.eventConstructionId && event.argumentFrame.id === row.eventArgumentFrameId);
  if (!event || event.labelStartCodePoint < row.reply.start || event.labelEndCodePoint > row.reply.end
    || row.bindings.length !== event.argumentFrame.bindings.length) return false;
  return row.bindings.every(binding => {
    const port = event.argumentFrame.bindings.find(port => port.roleId === binding.eventRoleId
      && port.startCodePoint === binding.eventStart && port.endCodePoint === binding.eventEnd);
    const surface = [...row.request.surface].slice(binding.requestStart, binding.requestEnd).join("");
    return port && binding.requestStart >= 0 && binding.requestEnd > binding.requestStart && binding.requestEnd <= [...row.request.surface].length
      && lexicalKey(port.surface) === lexicalKey(surface);
  });
}

function lexicalKey(text: string): string { return segmentUnicodeSurfaceV2(text).lexicalSegments.map(row => row.normalized).join("\u0001"); }
function digest(hasher: Hasher, kind: string, value: unknown): string { return `${kind}.${hasher.digestHex(canonicalStringify(toJsonValue(value)))}`; }
function ownsTurn(span: EvidenceSpan, turn: TranscriptTurn): boolean {
  return span.charStart <= turn.startCodePoint && span.charEnd >= turn.endCodePoint
    && [...span.text].slice(turn.startCodePoint - span.charStart, turn.endCodePoint - span.charStart).join("") === turn.surface;
}
function turnWitness(span: EvidenceSpan, turn: TranscriptTurn, hasher: Hasher): SourceTurnWitness {
  return { turnIndex: turn.index, evidenceId: String(span.id), contentHash: String(span.contentHash),
    start: turn.startCodePoint - span.charStart, end: turn.endCodePoint - span.charStart, surfaceHash: hasher.digestHex(turn.surface) };
}
function validWitness(span: EvidenceSpan, witness: SourceTurnWitness, row: CreativeSourceCorrespondence, hasher: Hasher): boolean {
  return span.status === "promoted" && String(span.sourceId) === row.sourceId && String(span.sourceVersionId) === row.sourceVersionId
    && String(span.contentHash) === witness.contentHash && Number.isSafeInteger(witness.start) && Number.isSafeInteger(witness.end)
    && witness.start >= 0 && witness.end > witness.start && witness.end <= [...span.text].length
    && hasher.digestHex([...span.text].slice(witness.start, witness.end).join("")) === witness.surfaceHash;
}
