// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA, canonicalStringify, createHasher, joinInformationLabels,
  normalizeInformationLabel, validatePooledLanguageProfileOwnership, type InformationLabel, type LanguageProfile,
  type PooledLanguageProfileOwnership } from "@scce/kernel";
import { pooledProfileOwnershipSql, profileSourceOwnershipSql } from "./pooled-profile-ownership.js";
import { CREATIVE_EVENT_NORMALIZATION_TABLES, CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA, creativeEventRecord,
  creativeEventStorageJson, normalizeCreativeEventPage, reconstructCreativeEventPage, verifyCreativeEventDomainRecord,
  type CreativeEventDomainRecord, type CreativeEventOwner } from "./creative-event-normalization.js";
import { DECODED_JSON_BYTE_LEDGER_KEY, DECODED_JSON_BYTE_LEDGER_SCHEMA, decodeDurableArtifact,
  decodedJsonByteLengths, encodeDurableArtifact, verifyDurableArtifactByteLedger } from "./durable-artifact-storage.js";
import { createCreativeLexemePageStore, creativeLexicalPageSchemaStatements, creativeLexemePageReferences,
  CREATIVE_LEXEME_PAGE_REFS_SCHEMA, type CreativeLexemeLocation } from "./creative-lexeme-page-storage.js";

export interface CreativeEventStorageHost {
  table(name: string): string;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(work: () => Promise<T>): Promise<T>;
  requireWritableInformationLabel(label: InformationLabel | undefined): InformationLabel;
  informationAccessPredicate(alias: string, firstParameter: number): { sql: string; params: unknown[] };
  informationAccess?: { explicitMergeAuthority?: boolean };
}
interface DomainRow { id: string; kind: string; value_json: Record<string, unknown>; information_label?: InformationLabel }
interface OwnerRow {
  profile_id: string; source_id: string; source_version_id: string; source_content_hash: string; evidence_id: string; evidence_content_hash: string;
  char_start: number; char_end: number; byte_start: number; byte_end: number;
  profile_source_version_id: string; has_pooled_binding: boolean; pooled_profile: LanguageProfile | null;
  profile_label: InformationLabel; source_label: InformationLabel; evidence_label: InformationLabel;
}
const hasher = createHasher();
export const CANONICAL_CREATIVE_EVENT_ARRAY_SCHEMA = "scce.creative_event_array_payload.v1";
const PAGE_ROWS_PER_STATEMENT = 256;
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const bodyHash = (value: unknown): string => hasher.digestHex(canonicalStringify(value));
function fail(message: string): never { throw Error(`canonical creative-event storage: ${message}`); }

export function canonicalCreativeEventSchemaStatements(q: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${q}.creative_event_templates (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind='template_definition'),value_json JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.creative_event_lexemes (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind='lexical_forms'),value_json JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.creative_event_witnesses (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind='occurrence_witness'),value_json JSONB NOT NULL,information_label JSONB NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${q}.creative_event_occurrences (id TEXT PRIMARY KEY,kind TEXT NOT NULL CHECK(kind='occurrence_page'),value_json JSONB NOT NULL,information_label JSONB NOT NULL)`,
    ...creativeLexicalPageSchemaStatements(q)
  ];
}

/** These records are immutable representations, never a second evidence or inference store. */
export function createCanonicalCreativeEventCodec(host: CreativeEventStorageHost) {
  const lexicalPages = createCreativeLexemePageStore(host);
  const mergeOptions = { explicitMergeAuthority: host.informationAccess?.explicitMergeAuthority === true };
  const join = (labels: InformationLabel[]): InformationLabel => host.requireWritableInformationLabel(joinInformationLabels(labels, mergeOptions));
  const ownersFor = async (bundles: readonly Record<string, unknown>[], requirePromoted = true): Promise<Map<string, CreativeEventOwner>> => {
    const requests = new Map<string, { profileId: string; evidenceId: string }>();
    for (const bundle of bundles) for (const value of bundle.events as unknown[]) {
      const event = creativeEventRecord(value);
      if (typeof event.profileId !== "string" || typeof event.evidenceId !== "string") return fail("missing event owner");
      const request = { profileId: event.profileId, evidenceId: event.evidenceId };
      requests.set(creativeEventStorageJson([request.profileId, request.evidenceId]), request);
    }
    const owners = new Map<string, CreativeEventOwner>(), entries = [...requests.values()];
    for (let offset = 0; offset < entries.length; offset += PAGE_ROWS_PER_STATEMENT) {
      const params: unknown[] = [JSON.stringify(entries.slice(offset, offset + PAGE_ROWS_PER_STATEMENT))];
      const profileAccess = host.informationAccessPredicate("profile", params.length + 1); params.push(...profileAccess.params);
      const lifecycle = { lifecycle: requirePromoted ? "current" as const : "historical" as const };
      const directOwner = profileSourceOwnershipSql(host, params, "profile", lifecycle);
      const pooledOwner = pooledProfileOwnershipSql(host, params, "profile.id", "profile.source_version_id", "(profile.profile_json->'pooledSourceBinding')", lifecycle);
      const versionAccess = host.informationAccessPredicate("version", params.length + 1); params.push(...versionAccess.params);
      const evidenceAccess = host.informationAccessPredicate("evidence", params.length + 1); params.push(...evidenceAccess.params);
      const rows = await host.query<OwnerRow>(`WITH requested AS MATERIALIZED (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS request("profileId" text,"evidenceId" text)
        ), admitted_profiles AS MATERIALIZED (
          SELECT profile.id,profile.source_version_id,profile.information_label,
            profile.profile_json->'pooledSourceBinding' AS pooled_binding,
            CASE WHEN profile.profile_json->'pooledSourceBinding' IS NOT NULL THEN profile.profile_json ELSE NULL END AS pooled_profile
          FROM ${host.table("language_profiles")} profile
          JOIN (SELECT DISTINCT "profileId" FROM requested) owner ON owner."profileId"=profile.id
          WHERE ${profileAccess.sql} AND CASE WHEN profile.profile_json->'pooledSourceBinding' IS NULL
            THEN ${directOwner} ELSE ${pooledOwner} END
        ), pooled_members AS MATERIALIZED (
          SELECT profile.id AS profile_id,member.value FROM admitted_profiles profile
          CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(profile.pooled_binding->'evidence')='array'
            THEN profile.pooled_binding->'evidence' ELSE '[]'::jsonb END) member(value)
        ) SELECT profile.id AS profile_id,version.source_id,version.id AS source_version_id,version.content_hash AS source_content_hash,
        evidence.id AS evidence_id,evidence.content_hash AS evidence_content_hash,evidence.char_start,evidence.char_end,evidence.byte_start,evidence.byte_end,
        profile.source_version_id AS profile_source_version_id,profile.pooled_binding IS NOT NULL AS has_pooled_binding,
        CASE WHEN profile.pooled_binding IS NOT NULL AND ROW_NUMBER() OVER (PARTITION BY profile.id ORDER BY evidence.id)=1 THEN profile.pooled_profile ELSE NULL END AS pooled_profile,
        profile.information_label AS profile_label,version.information_label AS source_label,evidence.information_label AS evidence_label
        FROM requested JOIN admitted_profiles profile ON profile.id=requested."profileId"
        JOIN ${host.table("evidence_spans")} evidence ON evidence.id=requested."evidenceId"
        JOIN ${host.table("source_versions")} version ON version.id=evidence.source_version_id AND version.source_id=evidence.source_id
        JOIN ${host.table("sources")} source ON source.id=version.source_id
        WHERE ${requirePromoted ? "evidence.status='promoted' AND " : ""}${versionAccess.sql} AND ${evidenceAccess.sql}
          AND ((profile.pooled_binding IS NULL AND profile.source_version_id=version.id)
            OR (profile.pooled_binding IS NOT NULL AND EXISTS (SELECT 1 FROM pooled_members member
              WHERE member.profile_id=profile.id AND member.value->>'id'=evidence.id AND member.value->>'sourceId'=version.source_id
                AND member.value->>'sourceVersionId'=version.id AND member.value->>'contentHash'=evidence.content_hash
                AND member.value->>'byteStart'=evidence.byte_start::text AND member.value->>'byteEnd'=evidence.byte_end::text
                AND member.value->>'charStart'=evidence.char_start::text AND member.value->>'charEnd'=evidence.char_end::text)))`, params);
      const pooled = new Map<string, PooledLanguageProfileOwnership>();
      for (const row of rows) if (row.pooled_profile) {
        if (row.pooled_profile.id !== row.profile_id || row.pooled_profile.sourceVersionId !== row.profile_source_version_id || pooled.has(row.profile_id)) return fail("invalid pooled profile snapshot");
        const ownership = validatePooledLanguageProfileOwnership(row.pooled_profile, hasher);
        if (!ownership) return fail("missing pooled profile receipt");
        pooled.set(row.profile_id, ownership);
      }
      for (const row of rows) {
        const key = creativeEventStorageJson([row.profile_id, row.evidence_id]);
        if (!requests.has(key) || owners.has(key)) return fail("ambiguous canonical owner");
        if (row.has_pooled_binding === true) {
          const receipt = pooled.get(row.profile_id);
          if (!receipt || !receipt.parents.includes(row.source_version_id) || receipt.evidence.filter(span => span.id === row.evidence_id
            && span.sourceId === row.source_id && span.sourceVersionId === row.source_version_id && span.contentHash === row.evidence_content_hash
            && span.byteStart === Number(row.byte_start) && span.byteEnd === Number(row.byte_end)
            && span.charStart === Number(row.char_start) && span.charEnd === Number(row.char_end)).length !== 1) return fail("pooled evidence is outside the verified receipt");
        } else if (row.has_pooled_binding !== false || row.profile_source_version_id !== row.source_version_id) return fail("invalid direct source profile binding");
        owners.set(key, { profileId: row.profile_id, sourceId: row.source_id, sourceVersionId: row.source_version_id, sourceContentHash: row.source_content_hash,
          evidenceId: row.evidence_id, evidenceContentHash: row.evidence_content_hash, evidenceCharStart: Number(row.char_start), evidenceCharEnd: Number(row.char_end),
          informationLabel: join([row.profile_label, row.source_label, row.evidence_label]) });
      }
    }
    if (owners.size !== requests.size) return fail("source owner missing, inaccessible or unpromoted");
    return owners;
  };
  const persist = async (table: typeof CREATIVE_EVENT_NORMALIZATION_TABLES[number], records: CreativeEventDomainRecord[], locations?: ReadonlyMap<string, CreativeLexemeLocation>): Promise<void> => {
    const labeled = table === "creative_event_witnesses" || table === "creative_event_occurrences";
    for (let offset = 0; offset < records.length; offset += PAGE_ROWS_PER_STATEMENT) {
      const batch = records.slice(offset, offset + PAGE_ROWS_PER_STATEMENT);
      batch.forEach(verifyCreativeEventDomainRecord);
      const payload = batch.map(row => ({ id: row.id, kind: row.kind, value_json: table === "creative_event_occurrences"
        ? { ...row.value, lexemes: creativeLexemePageReferences(row.value.lexemes as string[], locations!) } : row.value,
        ...(labeled ? { information_label: host.requireWritableInformationLabel(row.informationLabel) } : {}) }));
      const serialized = JSON.stringify(payload);
      await host.query(`INSERT INTO ${host.table(table)} AS canonical(id,kind,value_json${labeled ? ",information_label" : ""})
        SELECT input.id,input.kind,input.value_json${labeled ? ",input.information_label" : ""}
        FROM jsonb_to_recordset($1::jsonb) AS input(id text,kind text,value_json jsonb${labeled ? ",information_label jsonb" : ""})
        ON CONFLICT(id) DO NOTHING`, [serialized]);
      const rows = await host.query<{ id: string }>(`SELECT canonical.id FROM ${host.table(table)} canonical
        JOIN jsonb_to_recordset($1::jsonb) AS expected(id text,kind text,value_json jsonb${labeled ? ",information_label jsonb" : ""}) ON expected.id=canonical.id
        WHERE canonical.kind=expected.kind AND canonical.value_json=expected.value_json${labeled ? " AND canonical.information_label=expected.information_label" : ""}`, [serialized]);
      if (new Set(rows.map(row => row.id)).size !== batch.length || rows.some(row => !batch.some(expected => expected.id === row.id))) return fail("immutable record identity conflict");
    }
  };
  const read = async (table: typeof CREATIVE_EVENT_NORMALIZATION_TABLES[number], ids: readonly string[]): Promise<CreativeEventDomainRecord[]> => {
    const records: CreativeEventDomainRecord[] = [], unique = [...new Set(ids)];
    const labeled = table === "creative_event_witnesses" || table === "creative_event_occurrences";
    for (let offset = 0; offset < unique.length; offset += PAGE_ROWS_PER_STATEMENT) {
      const wanted = unique.slice(offset, offset + PAGE_ROWS_PER_STATEMENT), params: unknown[] = [wanted];
      const access = labeled ? host.informationAccessPredicate("canonical", params.length + 1) : undefined;
      if (access) params.push(...access.params);
      const rows = await host.query<DomainRow>(`SELECT canonical.id,canonical.kind,canonical.value_json${labeled ? ",canonical.information_label" : ""}
        FROM ${host.table(table)} canonical WHERE canonical.id=ANY($1::text[])${access ? ` AND ${access.sql}` : ""}`, params);
      if (new Set(rows.map(row => row.id)).size !== wanted.length || rows.some(row => !wanted.includes(row.id))) return fail("referenced record missing or inaccessible");
      for (const row of rows) {
        const next: CreativeEventDomainRecord = { id: row.id, kind: row.kind, value: row.value_json,
          ...(labeled ? { informationLabel: normalizeInformationLabel(row.information_label!) } : {}) };
        if (table !== "creative_event_occurrences") verifyCreativeEventDomainRecord(next); records.push(next);
      }
    }
    return records;
  };
  const encodeMany = async (inputs: readonly { value: unknown; informationLabel?: InformationLabel }[]): Promise<unknown[]> => {
      const bundles = new Map<object, { value: Record<string, unknown>; labels: InformationLabel[] }>();
      for (const input of inputs) walk(input.value, (row, inherited) => {
        if (typeof row.schema === "string" && row.schema.startsWith("scce.creative_event_construction_pattern.") && Object.hasOwn(row, "events")
          && (row.schema !== CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA || !Array.isArray(row.events))) return fail("unsupported preencoded creative-event page");
        if (row.schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA && Array.isArray(row.events)) {
          const old = bundles.get(row) ?? { value: row, labels: [] };
          if (inherited) old.labels.push(inherited); bundles.set(row, old);
        }
      }, input.informationLabel, join);
      if (!bundles.size) return inputs.map(input => encodeDurableArtifact(input.value));
      return host.transaction(async () => {
        const owners = await ownersFor([...bundles.values()].map(row => row.value)), references = new Map<object, unknown>();
        const pending = new Map(CREATIVE_EVENT_NORMALIZATION_TABLES.map(table => [table, new Map<string, CreativeEventDomainRecord>()]));
        for (const [bundle, entry] of bundles) {
          const plan = normalizeCreativeEventPage({ bundle: entry.value, owners,
            ...(entry.labels.length ? { informationLabel: join(entry.labels) } : {}), ...mergeOptions });
          references.set(bundle, plan.reference);
          for (const table of CREATIVE_EVENT_NORMALIZATION_TABLES) for (const row of plan.records[table]) pending.get(table)!.set(row.id, row);
        }
        const locations = await lexicalPages.putMany([...pending.get("creative_event_lexemes")!.values()]);
        for (const table of CREATIVE_EVENT_NORMALIZATION_TABLES) if (table !== "creative_event_lexemes") await persist(table, [...pending.get(table)!.values()], locations);
        return inputs.map(({ value }) => {
          const normalized = replace(value, row => references.has(row) ? { ...row, events: references.get(row) } : undefined);
          if (normalized === value) return encodeDurableArtifact(value);
          if (!Array.isArray(value) && (!record(value) || Object.hasOwn(record(value)!, DECODED_JSON_BYTE_LEDGER_KEY))) return fail("reserved root storage marker");
          const ledger = { schema: DECODED_JSON_BYTE_LEDGER_SCHEMA, ...decodedJsonByteLengths(value) };
          if (Array.isArray(value)) return { schema: CANONICAL_CREATIVE_EVENT_ARRAY_SCHEMA, value: normalized, [DECODED_JSON_BYTE_LEDGER_KEY]: ledger };
          const encoded = creativeEventRecord(encodeDurableArtifact(normalized));
          return { ...encoded, [DECODED_JSON_BYTE_LEDGER_KEY]: ledger };
        });
      });
  };
  return {
    encodeMany,
    async encode(value: unknown, informationLabel?: InformationLabel): Promise<unknown> {
      return (await encodeMany([{ value, informationLabel }]))[0];
    },
    async decodeMany(values: readonly unknown[]): Promise<unknown[]> {
      const decoded = values.map(value => decodeDurableArtifact<unknown>(value));
      const referenceIds = new Set<string>();
      for (const value of decoded) walk(value, row => {
        if (row.schema === CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA) {
          if (typeof row.pageId !== "string") return fail("invalid page reference"); referenceIds.add(row.pageId);
        }
      });
      if (!referenceIds.size) return decoded.map((value, index) => { verifyDurableArtifactByteLedger(values[index], value); return value; });
      const records = new Map<string, CreativeEventDomainRecord>();
      const pages = await read("creative_event_occurrences", [...referenceIds]);
      for (const page of pages) if (!Array.isArray(page.value.occurrences) || page.value.occurrences.length < 4 || page.value.occurrences.length > 2048) return fail("invalid source page cardinality");
      const references = (field: string): string[] => pages.flatMap(row => {
        const ids = row.value[field]; if (!Array.isArray(ids) || !ids.every((id): id is string => typeof id === "string")) return fail("invalid page components"); return ids;
      });
      const witnesses = await read("creative_event_witnesses", references("witnesses"));
      witnesses.forEach(row => records.set(row.id, row));
      const currentOwners = await ownersFor([{ events: witnesses.map(row => ({ ...row.value, profileId: creativeEventRecord(row.value.scope).profileId })) }], false);
      for (const row of witnesses) {
        const scope = creativeEventRecord(row.value.scope), owner = currentOwners.get(creativeEventStorageJson([scope.profileId, row.value.evidenceId]));
        if (!owner || owner.sourceId !== row.value.sourceId || owner.sourceVersionId !== row.value.sourceVersionId || owner.sourceContentHash !== row.value.sourceContentHash
          || owner.evidenceContentHash !== row.value.evidenceContentHash || owner.evidenceCharStart !== row.value.evidenceCharStart || owner.evidenceCharEnd !== row.value.evidenceCharEnd) return fail("changed canonical source witness");
      }
      for (const page of pages) for (const witnessId of page.value.witnesses as string[]) {
        const scope = creativeEventRecord(records.get(witnessId)?.value.scope);
        if (scope.profileId !== page.value.profileId || scope.compilerId !== page.value.compilerId) return fail("changed canonical page owner");
      }
      // Source ownership is checked before any globally shared pure lexical definition is hydrated.
      for (const page of pages) if (record(page.value.lexemes)?.schema !== CREATIVE_LEXEME_PAGE_REFS_SCHEMA) return fail("invalid lexical page reference");
      const lexical = await lexicalPages.readReferences(pages.map(page => page.value.lexemes));
      lexical.records.forEach(row => records.set(row.id, row));
      pages.forEach((page, index) => { page.value = { ...page.value, lexemes: lexical.ids[index]! }; verifyCreativeEventDomainRecord(page); records.set(page.id, page); });
      (await read("creative_event_templates", references("templates"))).forEach(row => records.set(row.id, row));
      return decoded.map((value, index) => {
        const wire = record(values[index]), envelope = wire?.schema === CANONICAL_CREATIVE_EVENT_ARRAY_SCHEMA;
        if (envelope && (Object.keys(wire!).length !== 3 || !Array.isArray(record(value)?.value))) return fail("invalid array payload envelope");
        let changed = false;
        const restored = replace(envelope ? record(value)!.value : value, row => {
          const ref = record(row.events);
          if (row.schema !== CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA || ref?.schema !== CREATIVE_EVENT_OCCURRENCE_REFERENCE_SCHEMA) return undefined;
          const events = reconstructCreativeEventPage({ reference: ref, records }), next = { ...row, events };
          if (records.get(String(ref.pageId))?.value.bundleDigest !== bodyHash(next)) return fail("restored bundle digest mismatch");
          changed = true; return next;
        });
        if (!changed) {
          if (envelope) return fail("unresolved array payload envelope");
          verifyDurableArtifactByteLedger(values[index], value); return value;
        }
        const ledger = record(wire?.[DECODED_JSON_BYTE_LEDGER_KEY]);
        if (!ledger || ledger.schema !== DECODED_JSON_BYTE_LEDGER_SCHEMA) return fail("missing decoded byte ledger");
        const logical = envelope ? restored : Object.fromEntries(Object.entries(creativeEventRecord(restored)).filter(([key]) => key !== DECODED_JSON_BYTE_LEDGER_KEY));
        verifyDurableArtifactByteLedger(values[index], logical);
        return logical;
      });
    }
  };
}

function walk(value: unknown, visit: (row: Record<string, unknown>, label?: InformationLabel) => void, label?: InformationLabel,
  merge: (labels: InformationLabel[]) => InformationLabel = labels => joinInformationLabels(labels)): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const child of value) walk(child, visit, label, merge); return; }
  const row = creativeEventRecord(value);
  visit(row, label);
  if (row.schema === CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA && Array.isArray(row.events)) return;
  for (const [key, child] of Object.entries(row)) walk(child, visit,
    key === "patternJson" && row.informationLabel ? merge([...(label ? [label] : []), normalizeInformationLabel(row.informationLabel as InformationLabel)]) : label, merge);
}

function replace(value: unknown, visit: (row: Record<string, unknown>) => unknown): unknown {
  const seen = new WeakMap<object, unknown>();
  const run = (input: unknown): unknown => {
    if (!input || typeof input !== "object") return input;
    if (seen.has(input)) return seen.get(input);
    if (Array.isArray(input)) { const next = input.map(run); const output = next.some((value, index) => value !== input[index]) ? next : input; seen.set(input, output); return output; }
    const row = creativeEventRecord(input), replacement = visit(row);
    if (replacement !== undefined) { seen.set(input, replacement); return replacement; }
    const entries = Object.entries(row).map(([key, child]) => [key, run(child)] as const);
    const output = entries.some(([key, child]) => child !== row[key]) ? Object.fromEntries(entries) : row;
    seen.set(input, output); return output;
  };
  return run(value);
}
