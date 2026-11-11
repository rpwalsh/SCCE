// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA, canonicalStringify, createHasher, deriveUniversalCreativeEvent,
  joinInformationLabels, normalizeInformationLabel, type DurableCreativeEventConstruction, type DurableCreativeEventArgumentBinding,
  type InformationLabel } from "@scce/kernel";

export const CREATIVE_EVENT_NORMALIZATION_SCHEMA = "scce.creative_event_normalization.v1";
export const CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA = "scce.creative_event_occurrence_page_ref.v1";
export const CREATIVE_EVENT_SOURCE_DERIVED_STORAGE_SCHEMA = "scce.creative_event_source_derived_storage.v1";
export const CREATIVE_EVENT_NORMALIZATION_TABLES = ["creative_event_templates", "creative_event_lexemes", "creative_event_witnesses", "creative_event_occurrences"] as const;
export type CreativeEventNormalizationTable = typeof CREATIVE_EVENT_NORMALIZATION_TABLES[number];
export interface CreativeEventOwner {
  profileId: string; sourceId: string; sourceVersionId: string; sourceContentHash: string; evidenceId: string; evidenceContentHash: string;
  evidenceCharStart: number; evidenceCharEnd: number; evidenceText?: string; informationLabel: InformationLabel;
}
export interface CreativeEventDomainRecord {
  id: string; kind: string; value: Record<string, unknown>; informationLabel?: InformationLabel;
}
export interface CreativeEventPagePlan {
  reference: { schema: typeof CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA; pageId: string; count: number };
  records: Record<CreativeEventNormalizationTable, CreativeEventDomainRecord[]>;
}
const hash = createHasher();
const TEMPLATE = "creative_event_templates", LEXEME = "creative_event_lexemes", WITNESS = "creative_event_witnesses", PAGE = "creative_event_occurrences";
const EVENT_FIELDS = ["id", "compilerId", "constructionId", "profileId", "sourceVersionId", "evidenceId", "evidenceContentHash", "evidenceCharStart", "evidenceCharEnd",
  "labelStartCodePoint", "labelEndCodePoint", "sourceOrdinal", "relationId", "sourceLabel", "sourceLabelDigest", "tenseId", "valencyId", "roleIds", "argumentFrame", "forms"];
const FRAME_FIELDS = ["id", "schema", "compilerId", "sourceSentenceStartCodePoint", "sourceSentenceEndCodePoint", "roleIds", "bindings"];

function fail(): never { throw Error("invalid canonical creative-event normalization"); }
export function creativeEventRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
}
function text(value: unknown): string { return typeof value === "string" && value.length ? value : fail(); }
function coordinate(value: unknown): number { return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fail(); }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : fail(); }
function fields(row: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(names.map(name => Object.hasOwn(row, name) ? [name, row[name]] : fail()));
}
function extensions(row: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(Object.entries(row).filter(([name]) => !names.includes(name)));
}
function extend(row: Record<string, unknown>, extra: unknown): Record<string, unknown> {
  const extension = creativeEventRecord(extra);
  if (Object.keys(extension).some(key => Object.hasOwn(row, key))) return fail();
  return Object.fromEntries([...Object.entries(row), ...Object.entries(extension)]);
}

/** Storage identities preserve JSON strings and keys exactly, including escaped NUL. */
export function creativeEventStorageJson(value: unknown): string {
  const active = new WeakSet<object>();
  const visit = (input: unknown): unknown => {
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number" && Number.isFinite(input) && !Object.is(input, -0)) return input;
    if (!input || typeof input !== "object" || active.has(input)) return fail();
    active.add(input);
    try {
      if (Array.isArray(input)) {
        if (Object.keys(input).length !== input.length) return fail();
        return input.map(visit);
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) return fail();
      return Object.fromEntries(Object.keys(input).sort().map(key => [key, visit((input as Record<string, unknown>)[key])]));
    } finally { active.delete(input); }
  };
  return JSON.stringify(visit(value));
}
function recordId(kind: string, value: unknown): string {
  return hash.digestHex(creativeEventStorageJson([CREATIVE_EVENT_NORMALIZATION_SCHEMA, kind, value]));
}
export function verifyCreativeEventDomainRecord(record: CreativeEventDomainRecord): void {
  if (record.id !== recordId(record.kind, record.value)) return fail();
}

function canonicalEvent(raw: unknown, verifyIncoming: boolean): DurableCreativeEventConstruction {
  const event = creativeEventRecord(raw), frame = creativeEventRecord(event.argumentFrame), forms = creativeEventRecord(event.forms);
  const tenseId = text(event.tenseId), valencyId = text(event.valencyId);
  if (frame.schema !== CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA
    || !["scce.tense.past", "scce.tense.present", "scce.tense.future", "scce.tense.unknown"].includes(tenseId)
    || !["scce.valency.agent", "scce.valency.agent_patient"].includes(valencyId)) return fail();
  const bindings: DurableCreativeEventArgumentBinding[] = array(frame.bindings).map(raw => {
    const binding = creativeEventRecord(raw), roleId = text(binding.roleId);
    if (roleId !== "scce.role.patient" && roleId !== "scce.role.complement") return fail();
    const connector = binding.connector === undefined ? undefined : creativeEventRecord(binding.connector);
    return { ...binding, roleId, surface: text(binding.surface), surfaceDigest: typeof binding.surfaceDigest === "string" ? binding.surfaceDigest : "pending",
      startCodePoint: coordinate(binding.startCodePoint), endCodePoint: coordinate(binding.endCodePoint),
      ...(connector ? { connector: { ...connector, surface: text(connector.surface),
        surfaceDigest: typeof connector.surfaceDigest === "string" ? connector.surfaceDigest : "pending",
        startCodePoint: coordinate(connector.startCodePoint), endCodePoint: coordinate(connector.endCodePoint) } } : {}) };
  });
  const parsed: DurableCreativeEventConstruction = { ...event,
    id: typeof event.id === "string" ? event.id : "pending", compilerId: text(event.compilerId), profileId: text(event.profileId),
    constructionId: typeof event.constructionId === "string" ? event.constructionId : "pending",
    relationId: typeof event.relationId === "string" ? event.relationId : "pending",
    sourceLabelDigest: typeof event.sourceLabelDigest === "string" ? event.sourceLabelDigest : "pending",
    sourceVersionId: text(event.sourceVersionId), evidenceId: text(event.evidenceId), evidenceContentHash: text(event.evidenceContentHash),
    evidenceCharStart: coordinate(event.evidenceCharStart), evidenceCharEnd: coordinate(event.evidenceCharEnd),
    sourceLabel: text(event.sourceLabel), labelStartCodePoint: coordinate(event.labelStartCodePoint), labelEndCodePoint: coordinate(event.labelEndCodePoint),
    sourceOrdinal: coordinate(event.sourceOrdinal), tenseId: tenseId as DurableCreativeEventConstruction["tenseId"],
    valencyId: valencyId as DurableCreativeEventConstruction["valencyId"], roleIds: array(event.roleIds).map(text),
    forms: { ...forms, infinitive: text(forms.infinitive), past: text(forms.past), present: text(forms.present), gerund: text(forms.gerund), participle: text(forms.participle) },
    argumentFrame: { ...frame, id: typeof frame.id === "string" ? frame.id : "pending", schema: CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
      compilerId: text(frame.compilerId), sourceSentenceStartCodePoint: coordinate(frame.sourceSentenceStartCodePoint),
      sourceSentenceEndCodePoint: coordinate(frame.sourceSentenceEndCodePoint), roleIds: array(frame.roleIds).map(text), bindings } };
  const derived = deriveUniversalCreativeEvent(parsed, hash);
  if (verifyIncoming && creativeEventStorageJson(raw) !== creativeEventStorageJson(derived)) throw Error("unsupported noncanonical universal creative-event identities");
  return derived;
}

function retainedBindings(bindings: unknown): Record<string, unknown>[] {
  return array(bindings).map(raw => {
    const row = creativeEventRecord(raw), { surfaceDigest: _digest, ...binding } = row;
    if (binding.connector !== undefined) {
      const { surfaceDigest: _connectorDigest, ...connector } = creativeEventRecord(binding.connector);
      binding.connector = connector;
    }
    return binding;
  });
}

function sourcePoints(owner: CreativeEventOwner): string[] | undefined {
  if (typeof owner.evidenceText !== "string") return undefined;
  const points = [...owner.evidenceText];
  return points.length === owner.evidenceCharEnd - owner.evidenceCharStart ? points : undefined;
}

function ownedSurface(points: readonly string[], start: unknown, end: unknown): string | undefined {
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || Number(start) < 0 || Number(end) <= Number(start) || Number(end) > points.length) return undefined;
  return points.slice(Number(start), Number(end)).join("");
}

function sourceDerivedBinding(raw: unknown, points: readonly string[]): boolean {
  const binding = creativeEventRecord(raw);
  if (ownedSurface(points, binding.startCodePoint, binding.endCodePoint) !== binding.surface) return false;
  if (binding.connector !== undefined) {
    const connector = creativeEventRecord(binding.connector);
    if (ownedSurface(points, connector.startCodePoint, connector.endCodePoint) !== connector.surface) return false;
  }
  return true;
}

function sourceDerivableEvent(event: Record<string, unknown>, owner: CreativeEventOwner): boolean {
  const points = sourcePoints(owner), frame = creativeEventRecord(event.argumentFrame), forms = creativeEventRecord(event.forms);
  if (!points) return false;
  const sourceLabel = ownedSurface(points, event.labelStartCodePoint, event.labelEndCodePoint)?.normalize("NFC").toLowerCase();
  if (sourceLabel !== event.sourceLabel || event.sourceOrdinal !== owner.evidenceCharStart + Number(event.labelStartCodePoint)) return false;
  const formNames = ["gerund", "infinitive", "participle", "past", "present"];
  if (Object.keys(forms).sort().join(",") !== formNames.join(",") || formNames.some(name => forms[name] !== sourceLabel)) return false;
  return array(frame.bindings).every(binding => sourceDerivedBinding(binding, points));
}

function sourceDerivedBindings(bindings: unknown): Record<string, unknown>[] {
  return array(bindings).map(raw => {
    const row = creativeEventRecord(raw), { surface: _surface, surfaceDigest: _digest, ...binding } = row;
    if (binding.connector !== undefined) {
      const { surface: _connectorSurface, surfaceDigest: _connectorDigest, ...connector } = creativeEventRecord(binding.connector);
      binding.connector = connector;
    }
    return binding;
  });
}

function restoreSourceDerivedBindings(bindings: unknown, points: readonly string[]): Record<string, unknown>[] {
  return array(bindings).map(raw => {
    const binding = creativeEventRecord(raw), surface = ownedSurface(points, binding.startCodePoint, binding.endCodePoint);
    if (surface === undefined) return fail();
    const connector = binding.connector === undefined ? undefined : creativeEventRecord(binding.connector);
    const connectorSurface = connector ? ownedSurface(points, connector.startCodePoint, connector.endCodePoint) : undefined;
    if (connector && connectorSurface === undefined) return fail();
    return { ...binding, surface, surfaceDigest: "pending", ...(connector ? { connector: { ...connector, surface: connectorSurface, surfaceDigest: "pending" } } : {}) };
  });
}

export function normalizeCreativeEventPage(input: {
  bundle: Record<string, unknown>; owners: ReadonlyMap<string, CreativeEventOwner>; informationLabel?: InformationLabel; explicitMergeAuthority?: boolean;
}): CreativeEventPagePlan {
  if (input.bundle.schema !== CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA) return fail();
  const compilerId = text(input.bundle.compilerId), profileId = text(input.bundle.profileId), events = array(input.bundle.events);
  if (events.length < 4 || events.length > 2048) return fail();
  const sourceDerived = events.every(raw => {
    const event = creativeEventRecord(raw), owner = input.owners.get(creativeEventStorageJson([profileId, text(event.evidenceId)]));
    return Boolean(owner && owner.profileId === profileId && owner.sourceVersionId === event.sourceVersionId && owner.evidenceId === event.evidenceId
      && owner.evidenceContentHash === event.evidenceContentHash && owner.evidenceCharStart === event.evidenceCharStart
      && owner.evidenceCharEnd === event.evidenceCharEnd && sourceDerivableEvent(event, owner));
  });
  const records: CreativeEventPagePlan["records"] = { creative_event_templates: [], creative_event_lexemes: [], creative_event_witnesses: [], creative_event_occurrences: [] };
  const ids = new Map<CreativeEventNormalizationTable, Set<string>>(CREATIVE_EVENT_NORMALIZATION_TABLES.map(name => [name, new Set()]));
  const add = (table: CreativeEventNormalizationTable, kind: string, value: Record<string, unknown>, informationLabel?: InformationLabel): string => {
    const id = recordId(kind, value);
    if (!ids.get(table)!.has(id)) { ids.get(table)!.add(id); records[table].push({ id, kind, value: JSON.parse(creativeEventStorageJson(value)) as Record<string, unknown>,
      ...(informationLabel ? { informationLabel: normalizeInformationLabel(informationLabel) } : {}) }); }
    return id;
  };
  const templateIds: string[] = [], lexemeIds: string[] = [], witnessIds: string[] = [];
  const templateIndices = new Map<string, number>(), lexemeIndices = new Map<string, number>(), witnessIndices = new Map<string, number>();
  const local = (id: string, values: string[], indices: Map<string, number>): number => {
    let position = indices.get(id); if (position === undefined) { position = values.length; values.push(id); indices.set(id, position); }
    return position;
  };
  const labels: InformationLabel[] = [];
  const occurrences = events.map(raw => {
    canonicalEvent(raw, true);
    const event = creativeEventRecord(raw), frame = creativeEventRecord(event.argumentFrame);
    if (event.compilerId !== compilerId || event.profileId !== profileId) return fail();
    const owner = input.owners.get(creativeEventStorageJson([profileId, text(event.evidenceId)]));
    if (!owner || owner.profileId !== profileId || owner.sourceVersionId !== event.sourceVersionId || owner.evidenceId !== event.evidenceId
      || owner.evidenceContentHash !== event.evidenceContentHash || owner.evidenceCharStart !== event.evidenceCharStart || owner.evidenceCharEnd !== event.evidenceCharEnd) return fail();
    const label = input.informationLabel ? joinInformationLabels([owner.informationLabel, input.informationLabel], input) : normalizeInformationLabel(owner.informationLabel);
    labels.push(label);
    const scope = { normalization: CREATIVE_EVENT_NORMALIZATION_SCHEMA, compilerId, profileId, informationLabel: label };
    const template = add(TEMPLATE, "template_definition", { ...fields(event, ["tenseId", "valencyId", "roleIds"]),
      argumentFrame: fields(frame, ["schema", "compilerId", "roleIds"]) });
    const lexeme = sourceDerived ? undefined : add(LEXEME, "lexical_forms", fields(event, ["sourceLabel", "forms"]));
    const witness = add(WITNESS, "occurrence_witness", { scope, sourceId: owner.sourceId, sourceContentHash: owner.sourceContentHash,
      ...fields(event, ["sourceVersionId", "evidenceId", "evidenceContentHash", "evidenceCharStart", "evidenceCharEnd"]) }, label);
    return sourceDerived
      ? [local(template, templateIds, templateIndices), local(witness, witnessIds, witnessIndices),
        coordinate(event.labelStartCodePoint), coordinate(event.labelEndCodePoint),
        coordinate(frame.sourceSentenceStartCodePoint), coordinate(frame.sourceSentenceEndCodePoint), sourceDerivedBindings(frame.bindings),
        { event: extensions(event, EVENT_FIELDS), argumentFrame: extensions(frame, FRAME_FIELDS) }]
      : [local(template, templateIds, templateIndices), local(lexeme!, lexemeIds, lexemeIndices), local(witness, witnessIds, witnessIndices),
        coordinate(event.labelStartCodePoint), coordinate(event.labelEndCodePoint), coordinate(event.sourceOrdinal),
        coordinate(frame.sourceSentenceStartCodePoint), coordinate(frame.sourceSentenceEndCodePoint), retainedBindings(frame.bindings),
        { event: extensions(event, EVENT_FIELDS), argumentFrame: extensions(frame, FRAME_FIELDS) }];
  });
  if (!occurrences.length) return fail();
  const label = joinInformationLabels(labels, input);
  const pageId = add(PAGE, "occurrence_page", { schema: CREATIVE_EVENT_NORMALIZATION_SCHEMA, compilerId, profileId,
    bundleDigest: hash.digestHex(canonicalStringify(input.bundle)), templates: templateIds,
    ...(sourceDerived ? { storageEncoding: CREATIVE_EVENT_SOURCE_DERIVED_STORAGE_SCHEMA } : { lexemes: lexemeIds }), witnesses: witnessIds, occurrences }, label);
  return { reference: { schema: CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA, pageId, count: occurrences.length }, records };
}

export function reconstructCreativeEventPage(input: {
  reference: Record<string, unknown>; records: ReadonlyMap<string, CreativeEventDomainRecord>; owners?: ReadonlyMap<string, CreativeEventOwner>;
}): Record<string, unknown>[] {
  if (input.reference.schema !== CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA || Object.keys(input.reference).length !== 3) return fail();
  const get = (id: unknown, kind: string): Record<string, unknown> => {
    const record = input.records.get(text(id));
    if (!record || record.kind !== kind) return fail();
    verifyCreativeEventDomainRecord(record);
    return record.value;
  };
  const page = get(input.reference.pageId, "occurrence_page");
  if (page.schema !== CREATIVE_EVENT_NORMALIZATION_SCHEMA) return fail();
  const sourceDerived = page.storageEncoding === CREATIVE_EVENT_SOURCE_DERIVED_STORAGE_SCHEMA;
  if (!sourceDerived && page.storageEncoding !== undefined) return fail();
  const templates = array(page.templates), lexemes = sourceDerived ? [] : array(page.lexemes), witnesses = array(page.witnesses), occurrences = array(page.occurrences);
  if (occurrences.length < 4 || occurrences.length > 2048) return fail();
  if (coordinate(input.reference.count) !== occurrences.length) return fail();
  const at = (values: unknown[], index: unknown): unknown => values[coordinate(index)] ?? fail();
  return occurrences.map(raw => {
    const occurrence = array(raw); if (occurrence.length !== (sourceDerived ? 8 : 10)) return fail();
    const template = get(at(templates, occurrence[0]), "template_definition");
    const lexeme = sourceDerived ? undefined : get(at(lexemes, occurrence[1]), "lexical_forms");
    const witnessIndex = sourceDerived ? occurrence[1] : occurrence[2];
    const witness = get(at(witnesses, witnessIndex), "occurrence_witness"), scope = creativeEventRecord(witness.scope);
    if (scope.normalization !== CREATIVE_EVENT_NORMALIZATION_SCHEMA || scope.compilerId !== page.compilerId || scope.profileId !== page.profileId) return fail();
    if (!input.records.get(text(at(witnesses, witnessIndex)))!.informationLabel
      || creativeEventStorageJson(normalizeInformationLabel(scope.informationLabel as InformationLabel))
        !== creativeEventStorageJson(input.records.get(text(at(witnesses, witnessIndex)))!.informationLabel)) return fail();
    const owner = sourceDerived ? input.owners?.get(creativeEventStorageJson([text(scope.profileId), text(witness.evidenceId)])) : undefined;
    const points = owner ? sourcePoints(owner) : undefined;
    if (sourceDerived && (!owner || !points || owner.sourceVersionId !== witness.sourceVersionId || owner.evidenceId !== witness.evidenceId
      || owner.evidenceContentHash !== witness.evidenceContentHash || owner.evidenceCharStart !== witness.evidenceCharStart
      || owner.evidenceCharEnd !== witness.evidenceCharEnd)) return fail();
    const labelStart = coordinate(occurrence[sourceDerived ? 2 : 3]), labelEnd = coordinate(occurrence[sourceDerived ? 3 : 4]);
    const sourceLabel = sourceDerived ? ownedSurface(points!, labelStart, labelEnd)?.normalize("NFC").toLowerCase() : undefined;
    if (sourceDerived && sourceLabel === undefined) return fail();
    const extra = creativeEventRecord(occurrence[sourceDerived ? 7 : 9]);
    const frame = extend({ ...creativeEventRecord(template.argumentFrame),
      sourceSentenceStartCodePoint: coordinate(occurrence[sourceDerived ? 4 : 6]), sourceSentenceEndCodePoint: coordinate(occurrence[sourceDerived ? 5 : 7]),
      bindings: sourceDerived ? restoreSourceDerivedBindings(occurrence[6], points!) : array(occurrence[8]) }, extra.argumentFrame);
    const event = extend({ compilerId: page.compilerId, profileId: page.profileId,
      ...fields(witness, ["sourceVersionId", "evidenceId", "evidenceContentHash", "evidenceCharStart", "evidenceCharEnd"]),
      ...(sourceDerived ? { sourceLabel, forms: { infinitive: sourceLabel, past: sourceLabel, present: sourceLabel, gerund: sourceLabel, participle: sourceLabel } }
        : fields(lexeme!, ["sourceLabel", "forms"])), ...fields(template, ["tenseId", "valencyId", "roleIds"]),
      labelStartCodePoint: labelStart, labelEndCodePoint: labelEnd,
      sourceOrdinal: sourceDerived ? owner!.evidenceCharStart + labelStart : coordinate(occurrence[5]), argumentFrame: frame }, extra.event);
    return JSON.parse(creativeEventStorageJson(canonicalEvent(event, false))) as Record<string, unknown>;
  });
}
