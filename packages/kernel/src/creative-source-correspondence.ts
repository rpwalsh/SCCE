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
import { createSourceTextPointCache, sourceTextPointLength, sourceTextPointSlice, type SourceTextPointCache } from "./source-text-points.js";
import { sourceReferencePropertiesForSpan, sourceReferencePropertyByIdentity, type OwnedSourceReferenceBindings } from "./source-reference-bindings.js";
import { CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID } from "./language-training-recipe.js";

export const CREATIVE_SOURCE_CORRESPONDENCE_RECIPE = "kernel.creative_source_correspondence.v2" as const;

export interface CreativeSourceCorrespondence {
  id: string;
  requestFrameId: string;
  sourceId: string;
  sourceVersionId: string;
  request: SourceTurnWitness & { surface: string; sourceAuthority:"creative"|"unknown" };
  reply: SourceTurnWitness & { replyToTurnIndex: number; commitmentScope: "conversation" };
  eventId: string;
  eventRelationId: string;
  eventConstructionId: string;
  eventArgumentFrameId: string;
  bindings: Array<{ requestRoleId: string; eventRoleId: "scce.role.patient" | "scce.role.complement";
    requestStart: number; requestEnd: number; eventStart: number; eventEnd: number;
    sourceReference?: { patternId: string; referentId: string; propertyId: string } }>;
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
  referenceBindings?: readonly OwnedSourceReferenceBindings[];
}

export interface CreativeSurfaceRoleBinding {
  requestRoleId: string;
  requestStart: number;
  requestEnd: number;
  occurrences: Array<{ start: number; end: number }>;
}

export function creativeSourceSurfaceGroupKey(row: CreativeSourceCorrespondence): string {
  return canonicalStringify([row.requestFrameId, row.sourceVersionId, row.request.evidenceId, row.request.start, row.request.end,
    row.reply.evidenceId, row.reply.start, row.reply.end]);
}

/** Verified source roles seed complete lexical occurrence alignments for creative substitution. */
function acquireCreativeSourceSurfaceBindings(rows: readonly CreativeSourceCorrespondence[], context: CreativeSourceCorrespondenceContext,
  points: SourceTextPointCache): ReadonlyMap<string, readonly CreativeSurfaceRoleBinding[]> {
  const groups = new Map<string, CreativeSourceCorrespondence[]>();
  for (const row of rows) {
    const key = creativeSourceSurfaceGroupKey(row);
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }
  return new Map([...groups].map(([key, group]): [string, readonly CreativeSurfaceRoleBinding[]] => {
    const row = group[0]!;
    const requestOwner = context.evidence.find(span => String(span.id) === row.request.evidenceId);
    const replyOwner = context.evidence.find(span => String(span.id) === row.reply.evidenceId);
    if (!requestOwner || !replyOwner) return [key, []];
    const request = segmentUnicodeSurfaceV2(row.request.surface).lexicalSegments;
    const reply = segmentUnicodeSurfaceV2(sourceTextPointSlice(replyOwner.text, row.reply.start, row.reply.end, points)).lexicalSegments;
    const matches = (segments: typeof request, units: readonly string[]) => segments.flatMap((segment, index) =>
      units.every((unit, offset) => segments[index + offset]?.normalized === unit)
        ? [{ start: segment.codePointStart, end: segments[index + units.length - 1]!.codePointEnd }] : []);
    const bindings = group.flatMap(observation => observation.bindings);
    const roles = [...new Map(bindings.map(binding => [binding.requestRoleId, binding])).values()];
    const acquired = roles.flatMap((binding): CreativeSurfaceRoleBinding[] => {
      const units = segmentUnicodeSurfaceV2(sourceTextPointSlice(row.request.surface, binding.requestStart, binding.requestEnd, points)).lexicalSegments.map(segment => segment.normalized);
      if (!units.length) return [];
      if (units.length === 1 && [...request, ...reply].some(segment => segment.normalized !== units[0]
        && segment.normalized.includes(units[0]!))) return [];
      const sourceMatches = matches(request, units);
      if (sourceMatches.length !== 1 || sourceMatches[0]!.start !== binding.requestStart || sourceMatches[0]!.end !== binding.requestEnd) return [];
      const declared = sourceReferencePropertiesForSpan({ documents: context.referenceBindings ?? [], sourceVersionId: row.sourceVersionId,
        startCodePoint: requestOwner.charStart + row.request.start + binding.requestStart,
        endCodePoint: requestOwner.charStart + row.request.start + binding.requestEnd });
      if (declared.length) return [];
      const occurrences = matches(reply, units).map(match => ({ start: row.reply.start + match.start, end: row.reply.start + match.end }));
      if (!occurrences.length || !bindings.some(seed => seed.requestRoleId === binding.requestRoleId
        && occurrences.some(occurrence => occurrence.start === seed.eventStart && occurrence.end === seed.eventEnd))) return [];
      return [{ requestRoleId: binding.requestRoleId, requestStart: binding.requestStart, requestEnd: binding.requestEnd, occurrences }];
    });
    return [key, acquired.filter(role => !acquired.some(other => other !== role
      && role.occurrences.some(left => other.occurrences.some(right => left.start < right.end && right.start < left.end))))
      .sort((left, right) => left.requestStart - right.requestStart || left.requestEnd - right.requestEnd)];
  }));
}

interface SourceEventOccurrence { event: DurableCreativeEventConstruction; ordinal: number; start: number; end: number }
interface SourceEventRangeIndex { occurrences: SourceEventOccurrence[]; minimumEnds: Float64Array; leafCount: number }

function indexSourceEventRanges(events: readonly DurableCreativeEventConstruction[]): Map<string, SourceEventRangeIndex> {
  const byEvidence = new Map<string, SourceEventOccurrence[]>();
  for (const [ordinal, event] of events.entries()) {
    const start = event.labelStartCodePoint, end = event.labelEndCodePoint;
    if (Number.isNaN(start) || Number.isNaN(end)) continue;
    const occurrences = byEvidence.get(event.evidenceId) ?? [];
    occurrences.push({ event, ordinal, start, end });
    byEvidence.set(event.evidenceId, occurrences);
  }
  return new Map([...byEvidence].map(([evidenceId, occurrences]) => {
    occurrences.sort((a, b) => a.start < b.start ? -1 : a.start > b.start ? 1 : a.ordinal - b.ordinal);
    let leafCount = 1;
    while (leafCount < occurrences.length) leafCount *= 2;
    const minimumEnds = new Float64Array(leafCount * 2).fill(Infinity);
    for (const [index, occurrence] of occurrences.entries()) minimumEnds[leafCount + index] = occurrence.end;
    for (let index = leafCount - 1; index > 0; index--) minimumEnds[index] = Math.min(minimumEnds[index * 2]!, minimumEnds[index * 2 + 1]!);
    return [evidenceId, { occurrences, minimumEnds, leafCount }];
  }));
}

function sourceEventsWithinReply(index: ReadonlyMap<string, SourceEventRangeIndex>, owner: EvidenceSpan, reply: TranscriptTurn): DurableCreativeEventConstruction[] {
  const group = index.get(String(owner.id));
  if (!group) return [];
  const { occurrences, minimumEnds, leafCount } = group;
  const selected: SourceEventOccurrence[] = [];
  const visit = (node: number, start: number, end: number): void => {
    if (start >= occurrences.length || !(owner.charStart + occurrences[Math.min(end, occurrences.length) - 1]!.start >= reply.startCodePoint)
      || !(owner.charStart + minimumEnds[node]! <= reply.endCodePoint)) return;
    if (end - start === 1) { selected.push(occurrences[start]!); return; }
    const middle = (start + end) / 2;
    visit(node * 2, start, middle);
    visit(node * 2 + 1, middle, end);
  };
  visit(1, 0, leafCount);
  // Range pruning changes traversal order; source occurrences keep their original order and multiplicity.
  return selected.sort((a, b) => a.ordinal - b.ordinal).map(occurrence => occurrence.event);
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
  let eventRanges: Map<string, SourceEventRangeIndex> | undefined;
  for (const reply of input.turns) {
    const request = byIndex.get(reply.replyToTurnIndex ?? -1);
    if (!request || (request.requestAuthority !== undefined && request.requestAuthority !== "creative") || reply.commitmentScope !== "conversation"
      || request.index >= reply.index || request.endCodePoint > reply.startCodePoint) continue;
    const requestOwner = evidence.find(span => ownsTurn(span, request));
    const replyOwner = evidence.find(span => ownsTurn(span, reply) && span.sourceId === requestOwner?.sourceId && span.sourceVersionId === requestOwner?.sourceVersionId);
    if (!requestOwner || !replyOwner) continue;
    eventRanges ??= indexSourceEventRanges(input.events);
    const responseEvents = sourceEventsWithinReply(eventRanges, replyOwner, reply);
    const segments = segmentUnicodeSurfaceV2(request.surface).lexicalSegments;
    const spans = new Map<string, { start: number; end: number }>();
    const eventMatches = responseEvents.map(event => ({ event, bindings: event.argumentFrame.bindings.flatMap(port => {
      if (port.roleId !== "scce.role.patient" && port.roleId !== "scce.role.complement") return [];
      const units = segmentUnicodeSurfaceV2(port.surface).lexicalSegments.map(row => row.normalized);
      if (!units.length) return [];
      const matches = segments.flatMap((segment, index) => units.every((unit, offset) => segments[index + offset]?.normalized === unit)
        ? [{ start: segment.codePointStart, end: segments[index + units.length - 1]!.codePointEnd }] : []);
      const properties = sourceReferencePropertiesForSpan({ documents: input.referenceBindings ?? [], sourceVersionId: event.sourceVersionId,
        startCodePoint: replyOwner.charStart + port.startCodePoint, endCodePoint: replyOwner.charStart + port.endCodePoint });
      if (properties.length) {
        const declared = properties.flatMap(property => property.occurrences.filter(occurrence => occurrence.evidenceId === String(requestOwner.id)
          && occurrence.propertySpan!.start >= request.startCodePoint && occurrence.propertySpan!.end <= request.endCodePoint)
          .map(occurrence => ({ start: occurrence.propertySpan!.start - request.startCodePoint, end: occurrence.propertySpan!.end - request.startCodePoint,
            sourceReference: { patternId: property.patternId, referentId: property.referentId, propertyId: property.propertyId }, port })));
        if (declared.length !== 1) return [];
        const declaredMatch = declared[0]!;
        return matches.length === 1 && matches[0]!.start === declaredMatch.start && matches[0]!.end === declaredMatch.end
          ? [{ start: declaredMatch.start, end: declaredMatch.end, port }] : declared;
      }
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
    const sourceAuthority: CreativeSourceCorrespondence["request"]["sourceAuthority"] = request.requestAuthority === "creative" ? "creative" : "unknown";
    const requestFrameId = digest(input.hasher, "creative.request.observed.frame", { compilerId, topology,sourceAuthority });
    const roleIds = roles.map((_, index) => `${requestFrameId}.role.${index}`);
    const requestWitness = { ...turnWitness(requestOwner, request, input.hasher), surface: request.surface,sourceAuthority };
    const replyWitness = { ...turnWitness(replyOwner, reply, input.hasher), replyToTurnIndex: request.index, commitmentScope: "conversation" as const };
    for (const { event, bindings } of eventMatches) {
      if (bindings.length !== event.argumentFrame.bindings.length) continue;
      const material: Omit<CreativeSourceCorrespondence, "id"> = {
        requestFrameId, sourceId: String(requestOwner.sourceId), sourceVersionId: String(requestOwner.sourceVersionId),
        request: requestWitness, reply: replyWitness, eventId: event.id, eventRelationId: event.relationId,
        eventConstructionId: event.constructionId, eventArgumentFrameId: event.argumentFrame.id,
        bindings: bindings.map(({ start, end, port, ...declared }) => ({ requestRoleId: roleIds[roles.findIndex(role => role.start === start && role.end === end)]!,
          eventRoleId: port.roleId as "scce.role.patient" | "scce.role.complement", requestStart: start, requestEnd: end,
          eventStart: port.startCodePoint, eventEnd: port.endCodePoint, ...declared }))
      };
      observations.push({ ...material, id: digest(input.hasher, "creative.source.correspondence", material) });
    }
    if (!observations.some(row => row.requestFrameId === requestFrameId)) continue;
    const example: AlignedSurfaceExample = { id: digest(input.hasher, "creative.request.observed.example", { requestFrameId, requestWitness }),
      profileKey: compilerId, surface: request.surface, evidenceIds: [String(requestOwner.id)], roleSpans: roles.map((role, index) => ({
        roleId: roleIds[index]!, occurrenceId: roleIds[index]!, start: role.start, end: role.end,
        surface: points.slice(role.start, role.end).join(""), evidenceIds: [String(requestOwner.id)] })) };
    const previous = anchors.get(requestFrameId);
    anchors.set(requestFrameId, { requestFrameId, requestCompilerId: compilerId,sourceAuthority,
      lexicalKeys: [...new Set(segments.map(row => row.normalized))].sort(), requestRoleIds: roleIds,
      support: (previous?.support ?? 0) + 1, observedSupport: (previous?.observedSupport ?? 0) + 1, acceptedSupport: 0, rejectedSupport: 0,
      exampleTextHashes: [...(previous?.exampleTextHashes ?? []), example.id], requestRoleExamples: [...(previous?.requestRoleExamples ?? []), example] });
  }
  if (!observations.length) return [];
  const unique = [...new Map(observations.map(row => [row.id, row])).values()].sort((a, b) => a.id.localeCompare(b.id));
  const observedEventIds = new Set(unique.map(row => row.eventId));
  const compilersByEventId = new Map<string, Set<string>>();
  const observationsByCompiler = new Map<string, CreativeSourceCorrespondence[]>();
  for (const event of input.events) {
    const eventId = event.id;
    if (!observedEventIds.has(eventId)) continue;
    const compilers = compilersByEventId.get(eventId) ?? new Set<string>();
    compilers.add(event.compilerId);
    compilersByEventId.set(eventId, compilers);
    if (!observationsByCompiler.has(event.compilerId)) observationsByCompiler.set(event.compilerId, []);
  }
  for (const row of unique) for (const compiler of compilersByEventId.get(row.eventId) ?? []) observationsByCompiler.get(compiler)!.push(row);
  return [...observationsByCompiler].map(([eventCompilerId, sourceObservations]) => {
    const material = { schema: "scce.creative_event_compatibility_model.v1" as const, version: CREATIVE_SOURCE_CORRESPONDENCE_RECIPE,
      requestCompilerId: compilerId, eventCompilerId, reliability: "source_observed" as const, eventCompatibilities: [], roleCompatibilities: [],
      surfaceBindingRecipe: CREATIVE_SOURCE_SURFACE_ACQUISITION_RECIPE_ID,
      sourceObservations, requestFrameAnchors: [...anchors.values()].sort((a, b) => a.requestFrameId.localeCompare(b.requestFrameId)),
      ...((input.referenceBindings ?? []).some(reference => reference.profileId === input.profileId && sourceObservations.some(row => row.sourceId === reference.sourceId && row.sourceVersionId === reference.sourceVersionId))
        ? { sourceReferencePatternIds: (input.referenceBindings ?? []).filter(reference => reference.profileId === input.profileId
          && sourceObservations.some(row => row.sourceId === reference.sourceId && row.sourceVersionId === reference.sourceVersionId)).map(reference => reference.id).sort() } : {}) };
    const id = digest(input.hasher, "creative.observed.compatibility", material);
    const model: CreativeEventCompatibilityModel = { ...material, id };
    return { id, profileId: input.profileId, patternKind: "semantic_role" as const, support: sourceObservations.length, entropy: 0,
      patternJson: toJsonValue(model), evidenceIds: [...new Set(sourceObservations.flatMap(row => [row.request.evidenceId, row.reply.evidenceId]))] as EvidenceSpan["id"][], updatedAt: input.updatedAt };
  });
}

export interface CreativeSourceCorrespondenceVerifier {
  verify(row: CreativeSourceCorrespondence, owners: readonly string[]): boolean;
  eventHasProfile(eventId: string, profileId: string): boolean;
  acquireSurfaceBindings(rows: readonly CreativeSourceCorrespondence[]): ReadonlyMap<string, readonly CreativeSurfaceRoleBinding[]>;
}

// Index immutable source premises for one synchronous model-verification pass.
export function createCreativeSourceCorrespondenceVerifier(context: CreativeSourceCorrespondenceContext): CreativeSourceCorrespondenceVerifier {
  const points = createSourceTextPointCache();
  const evidenceById = new Map<string, EvidenceSpan>();
  for (const span of context.evidence) if (!evidenceById.has(String(span.id))) evidenceById.set(String(span.id), span);
  const eventsById = new Map<string, DurableCreativeEventConstruction[]>();
  for (const event of context.events) {
    const matches = eventsById.get(event.id);
    if (matches) matches.push(event);
    else eventsById.set(event.id, [event]);
  }
  return {
    verify: (row, owners) => verifyCreativeSourceCorrespondenceIndexed(row, context, owners, points, evidenceById, eventsById),
    acquireSurfaceBindings: rows => acquireCreativeSourceSurfaceBindings(rows, context, points),
    eventHasProfile: (eventId, profileId) => eventsById.get(eventId)?.some(event => event.id === eventId && event.profileId === profileId) ?? false
  };
}

export function verifyCreativeSourceCorrespondence(row: CreativeSourceCorrespondence, context: CreativeSourceCorrespondenceContext, owners: readonly string[]): boolean {
  return createCreativeSourceCorrespondenceVerifier(context).verify(row, owners);
}

function verifyCreativeSourceCorrespondenceIndexed(row: CreativeSourceCorrespondence, context: CreativeSourceCorrespondenceContext, owners: readonly string[],
  points: SourceTextPointCache, evidenceById: ReadonlyMap<string, EvidenceSpan>, eventsById: ReadonlyMap<string, readonly DurableCreativeEventConstruction[]>): boolean {
  if (!row || typeof row !== "object" || !row.request || !row.reply || !Array.isArray(row.bindings)
    || (row.request.sourceAuthority !== "creative" && row.request.sourceAuthority !== "unknown")
    || typeof row.request.surface !== "string" || typeof row.request.surfaceHash !== "string" || typeof row.reply.surfaceHash !== "string"
    || !Number.isSafeInteger(row.request.turnIndex) || !Number.isSafeInteger(row.reply.turnIndex)
    || row.bindings.some(binding => !binding || typeof binding !== "object" || typeof binding.requestRoleId !== "string"
      || !Number.isSafeInteger(binding.requestStart) || !Number.isSafeInteger(binding.requestEnd)
      || !Number.isSafeInteger(binding.eventStart) || !Number.isSafeInteger(binding.eventEnd))) return false;
  const { id, ...material } = row;
  if (id !== digest(context.hasher, "creative.source.correspondence", material) || row.reply.commitmentScope !== "conversation"
    || row.reply.replyToTurnIndex !== row.request.turnIndex || row.request.turnIndex >= row.reply.turnIndex) return false;
  const request = evidenceById.get(row.request.evidenceId);
  const reply = evidenceById.get(row.reply.evidenceId);
  if (!request || !reply || String(request.id) !== row.request.evidenceId || String(reply.id) !== row.reply.evidenceId
    || !owners.includes(String(request.id)) || !owners.includes(String(reply.id))
    || !validWitness(request, row.request, row, context.hasher, points) || !validWitness(reply, row.reply, row, context.hasher, points)
    || sourceTextPointSlice(request.text, row.request.start, row.request.end, points) !== row.request.surface
    || request.charStart + row.request.end > reply.charStart + row.reply.start) return false;
  const event = eventsById.get(row.eventId)?.find(event => event.id === row.eventId && event.evidenceId === String(reply.id)
    && event.sourceVersionId === row.sourceVersionId && event.relationId === row.eventRelationId
    && event.constructionId === row.eventConstructionId && event.argumentFrame.id === row.eventArgumentFrameId);
  if (!event || event.labelStartCodePoint < row.reply.start || event.labelEndCodePoint > row.reply.end
    || row.bindings.length !== event.argumentFrame.bindings.length) return false;
  return row.bindings.every(binding => {
    const port = event.argumentFrame.bindings.find(port => port.roleId === binding.eventRoleId
      && port.startCodePoint === binding.eventStart && port.endCodePoint === binding.eventEnd);
    const surface = sourceTextPointSlice(row.request.surface, binding.requestStart, binding.requestEnd, points);
    if (!port || binding.requestStart < 0 || binding.requestEnd <= binding.requestStart || binding.requestEnd > sourceTextPointLength(row.request.surface, points)) return false;
    if (binding.sourceReference) {
      const property = sourceReferencePropertyByIdentity({ documents: context.referenceBindings ?? [], ...binding.sourceReference });
      return property?.occurrences.some(occurrence => occurrence.evidenceId === String(request.id)
        && occurrence.propertySpan?.start === request.charStart + row.request.start + binding.requestStart
        && occurrence.propertySpan.end === request.charStart + row.request.start + binding.requestEnd) === true
        && property.occurrences.some(occurrence => occurrence.evidenceId === String(reply.id)
          && occurrence.propertySpan?.start === reply.charStart + binding.eventStart && occurrence.propertySpan.end === reply.charStart + binding.eventEnd);
    }
    return lexicalKey(port.surface) === lexicalKey(surface);
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
function validWitness(span: EvidenceSpan, witness: SourceTurnWitness, row: CreativeSourceCorrespondence, hasher: Hasher, points: SourceTextPointCache): boolean {
  return span.status === "promoted" && String(span.sourceId) === row.sourceId && String(span.sourceVersionId) === row.sourceVersionId
    && String(span.contentHash) === witness.contentHash && Number.isSafeInteger(witness.start) && Number.isSafeInteger(witness.end)
    && witness.start >= 0 && witness.end > witness.start && witness.end <= sourceTextPointLength(span.text, points)
    && hasher.digestHex(sourceTextPointSlice(span.text, witness.start, witness.end, points)) === witness.surfaceHash;
}
