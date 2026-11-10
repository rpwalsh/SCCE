// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHasher, normalizeInformationLabel, normalizeConstructionRoleGeometry, constructionRoleGeometryPageIds,
  createConstructionRoleGeometryRestorer, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE, type ConstructionRoleGeometryPage, type InformationLabel, type JsonValue } from "@scce/kernel";
import { normalizeRequestSourceFacts, createRequestSourceFactsRestorer, requestSourceFactPageIds, exactPatternFactJson,
  type RequestSourceFactPage } from "./request-source-facts.js";
import { profileSourceOwnershipSql } from "./pooled-profile-ownership.js";
import { DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY as LEDGER, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA,
  durableJoinProgramJsonByteLengths } from "./durable-join-program-storage.js";
import type { CreativeEventStorageHost } from "./canonical-creative-event-store.js";

export const SOURCE_PATTERN_PARTS_KEY = "_sccePatternParts";
export const SOURCE_PATTERN_PARTS_SCHEMA = "scce.source_pattern_parts.v1";
type Host = Pick<CreativeEventStorageHost, "table" | "query" | "informationAccessPredicate" | "requireWritableInformationLabel">;
type Page = ConstructionRoleGeometryPage | RequestSourceFactPage;
type Row = Record<string, unknown>;
export interface SourcePatternFactsInput { value: unknown; logicalValue?: unknown; profileId: string; informationLabel: InformationLabel; selectionHeaders?: Record<string, JsonValue> }
export interface SourcePatternFactsReference { value: unknown; patternId: string; profileId: string }
interface Owner { profile_id: string; source_version_id: string }
interface StoredPage { id: string; owner_key: string; profile_id: string; source_version_id: string; kind: Page["kind"]; digest: string; value_json: Page; information_label: InformationLabel; stored_bytes?: number | string }
interface Marker { schema: string; ownerKey: string; recordDigest: string; introducedLedger: false | Row; headerChanges?: Array<[string, boolean, unknown, unknown]> }
const hasher = createHasher(), CHUNK = 128;
const fail = (): never => { throw Error("source-owned pattern facts are missing, inaccessible or changed"); };
const row = (value: unknown): Row | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Row : undefined;
const hash = (value: unknown): string => hasher.digestHex(exactPatternFactJson(value));
const same = (left: unknown, right: unknown): boolean => exactPatternFactJson(left) === exactPatternFactJson(right);
const compilation = (value: Row): string | null => typeof value.sourceCompilationId === "string" ? value.sourceCompilationId
  : typeof row(value.sourceCompilation)?.compilationId === "string" ? row(value.sourceCompilation)!.compilationId as string : null;
const pageIds = (value: unknown): string[] => [...constructionRoleGeometryPageIds(value), ...requestSourceFactPageIds(value)];
const candidate = (value: unknown): boolean => { const root = row(value); return !!root && (root.schema === "scce.language_construction_pattern.v1"
  && root.storageEncoding === SOURCE_EXAMPLE_CONSTRUCTION_STORAGE || root.schema === "scce.request_requirement_pattern.v1" && Array.isArray(root.sourceTurnRanges)); };

export function sourcePatternFactSchemaStatements(q: string): string[] {
  return [
    `CREATE TABLE IF NOT EXISTS ${q}.source_pattern_fact_pages (id TEXT PRIMARY KEY,owner_key TEXT NOT NULL,profile_id TEXT NOT NULL REFERENCES ${q}.language_profiles(id) ON DELETE CASCADE,source_version_id TEXT NOT NULL REFERENCES ${q}.source_versions(id),kind TEXT NOT NULL CHECK(kind IN ('construction_role_geometry','request_source_fact')),digest TEXT NOT NULL,value_json JSONB NOT NULL,information_label JSONB NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_source_pattern_fact_pages_profile ON ${q}.source_pattern_fact_pages(profile_id)`,
    `CREATE TABLE IF NOT EXISTS ${q}.source_pattern_fact_refs (pattern_id TEXT NOT NULL REFERENCES ${q}.language_patterns(id) ON DELETE CASCADE,page_id TEXT NOT NULL REFERENCES ${q}.source_pattern_fact_pages(id),PRIMARY KEY(pattern_id,page_id))`,
    `CREATE INDEX IF NOT EXISTS idx_source_pattern_fact_refs_page ON ${q}.source_pattern_fact_refs(page_id)`
  ];
}

/** The caller's transaction contains page writes, pattern writes, reference reconciliation and collection. */
export function createSourcePatternFactsCodec(host: Host, options: { maxPageBytes?: number; maxReadBytes?: number } = {}) {
  const maxPageBytes = options.maxPageBytes ?? 256 * 1024, maxReadBytes = options.maxReadBytes ?? 64 * 1024 * 1024;
  if (![maxPageBytes, maxReadBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw Error("invalid pattern-fact byte budget");
  async function owners(profileIds: readonly string[]): Promise<Map<string, Owner>> {
    const result = new Map<string, Owner>(), ids = [...new Set(profileIds)];
    for (let offset = 0; offset < ids.length; offset += CHUNK) {
      const params: unknown[] = [ids.slice(offset, offset + CHUNK)];
      const access = host.informationAccessPredicate("profile", params.length + 1); params.push(...access.params);
      const ownership = profileSourceOwnershipSql(host, params, "profile");
      const versionAccess = host.informationAccessPredicate("version", params.length + 1); params.push(...versionAccess.params);
      const rows = await host.query<Owner>(`/* pattern-fact owners */ SELECT profile.id AS profile_id,profile.source_version_id
        FROM ${host.table("language_profiles")} profile JOIN ${host.table("source_versions")} version ON version.id=profile.source_version_id
        WHERE profile.id=ANY($1::text[]) AND ${access.sql} AND ${versionAccess.sql} AND ${ownership}`, params);
      for (const owner of rows) { if (result.has(owner.profile_id)) return fail(); result.set(owner.profile_id, owner); }
    }
    for (const id of ids) if (!result.has(id)) return fail();
    return result;
  }
  function binding(input: SourcePatternFactsInput, owner: Owner): { ownerKey: string; label: InformationLabel } {
    const root = row(input.value) ?? fail(), label = normalizeInformationLabel(input.informationLabel);
    if (typeof root.profileId === "string" && root.profileId !== input.profileId
      || typeof root.sourceVersionId === "string" && root.sourceVersionId !== owner.source_version_id) return fail();
    return { ownerKey: hash({ profileId: input.profileId, sourceVersionId: owner.source_version_id, sourceCompilationId: compilation(root), label }), label };
  }
  function marker(value: unknown): Marker | undefined {
    const root = row(value); if (!root || !Object.hasOwn(root, SOURCE_PATTERN_PARTS_KEY)) {
      if (pageIds(value).length) return fail(); return undefined;
    }
    const raw = row(root[SOURCE_PATTERN_PARTS_KEY]);
    if (!raw || raw.schema !== SOURCE_PATTERN_PARTS_SCHEMA || typeof raw.ownerKey !== "string" || !/^[a-f0-9]{64}$/u.test(raw.ownerKey)
      || typeof raw.recordDigest !== "string" || !/^[a-f0-9]{64}$/u.test(raw.recordDigest)
      || raw.introducedLedger !== false && !row(raw.introducedLedger)
      || Object.keys(raw).some(key => !["schema", "ownerKey", "recordDigest", "introducedLedger", "headerChanges"].includes(key)) || !pageIds(value).length) return fail();
    if (raw.headerChanges !== undefined && (!Array.isArray(raw.headerChanges) || !raw.headerChanges.length
      || raw.headerChanges.some(change => !Array.isArray(change) || change.length !== 4 || typeof change[0] !== "string" || typeof change[1] !== "boolean"
        || [SOURCE_PATTERN_PARTS_KEY, LEDGER, "_scceConstructionRoleGeometry", "_scceRequestSourceFacts"].includes(change[0]))
      || new Set(raw.headerChanges.map(change => (change as unknown[])[0])).size !== raw.headerChanges.length)) return fail();
    return raw as unknown as Marker;
  }
  async function collect(profileIds: readonly string[]): Promise<void> {
    for (let offset = 0; offset < profileIds.length; offset += CHUNK) {
      const params: unknown[] = [profileIds.slice(offset, offset + CHUNK)];
      const access = host.informationAccessPredicate("page", params.length + 1); params.push(...access.params);
      await host.query(`/* pattern-fact collect */ DELETE FROM ${host.table("source_pattern_fact_pages")} page
        WHERE page.profile_id=ANY($1::text[]) AND ${access.sql} AND NOT EXISTS (SELECT 1 FROM ${host.table("source_pattern_fact_refs")} ref WHERE ref.page_id=page.id)`, params);
    }
  }
  return {
    async encodeMany(inputs: readonly SourcePatternFactsInput[]): Promise<unknown[]> {
      const selected = inputs.filter(input => candidate(input.value));
      for (const input of inputs) if (row(input.value)?.[SOURCE_PATTERN_PARTS_KEY] !== undefined || pageIds(input.value).length) return fail();
      for (const input of selected) if (input.logicalValue === undefined || Object.hasOwn(row(input.logicalValue) ?? {}, LEDGER)) return fail();
      const admitted = await owners(selected.map(input => input.profileId)), groups = new Map<string, { inputs: SourcePatternFactsInput[]; owner: Owner; label: InformationLabel }>();
      for (const input of selected) {
        const owner = admitted.get(input.profileId)!, { ownerKey, label } = binding(input, owner);
        host.requireWritableInformationLabel(label);
        const group = groups.get(ownerKey) ?? { inputs: [], owner, label }; group.inputs.push(input); groups.set(ownerKey, group);
      }
      const replacements = new Map<SourcePatternFactsInput, unknown>();
      for (const [ownerKey, group] of groups) {
        const roles = normalizeConstructionRoleGeometry(group.inputs.map(input => input.value), ownerKey, hasher, maxPageBytes);
        const requests = normalizeRequestSourceFacts(roles.values, ownerKey, hasher, maxPageBytes);
        for (const page of [...roles.pages, ...requests.pages]) {
          const stored = { ...page, profileId: group.owner.profile_id, sourceVersionId: group.owner.source_version_id, label: group.label };
          const params: unknown[] = [stored.id, ownerKey, stored.profileId, stored.sourceVersionId, stored.kind, stored.digest, exactPatternFactJson(page), exactPatternFactJson(stored.label)];
          const rows = await host.query<{ id: string }>(`/* pattern-fact insert */ INSERT INTO ${host.table("source_pattern_fact_pages")}
            (id,owner_key,profile_id,source_version_id,kind,digest,value_json,information_label) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
            ON CONFLICT(id) DO NOTHING RETURNING id`, params);
          if (!rows.length) rows.push(...await host.query<{ id: string }>(`/* pattern-fact immutable */ SELECT existing.id FROM ${host.table("source_pattern_fact_pages")} existing
            WHERE existing.id=$1 AND existing.owner_key=$2 AND existing.profile_id=$3 AND existing.source_version_id=$4 AND existing.kind=$5
              AND existing.digest=$6 AND existing.value_json=$7::jsonb AND existing.information_label=$8::jsonb`, params));
          if (rows.length !== 1 || rows[0]!.id !== page.id) return fail();
        }
        group.inputs.forEach((input, index) => {
          const normalized = requests.values[index]; if (!pageIds(normalized).length) return;
          const original = row(input.value)!, next = { ...row(normalized)! };
          const sizes = { schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...durableJoinProgramJsonByteLengths(input.logicalValue) };
          const existing = original[LEDGER];
          if (existing !== undefined && (!input.logicalValue || !same(existing, sizes))) return fail();
          const introducedLedger = existing === undefined ? sizes : false;
          if (introducedLedger) next[LEDGER] = introducedLedger;
          const headerChanges: NonNullable<Marker["headerChanges"]> = [];
          for (const [key, value] of Object.entries(input.selectionHeaders ?? {})) {
            if ([SOURCE_PATTERN_PARTS_KEY, LEDGER, "_scceConstructionRoleGeometry", "_scceRequestSourceFacts"].includes(key)) return fail();
            if (Object.hasOwn(next, key) && same(next[key], value)) continue;
            headerChanges.push([key, Object.hasOwn(next, key), Object.hasOwn(next, key) ? next[key] : null, value]);
            Object.defineProperty(next, key, { value: structuredClone(value), enumerable: true, configurable: true, writable: true });
          }
          next[SOURCE_PATTERN_PARTS_KEY] = { schema: SOURCE_PATTERN_PARTS_SCHEMA, ownerKey, recordDigest: hash(original), introducedLedger,
            ...(headerChanges.length ? { headerChanges } : {}) };
          replacements.set(input, next);
        });
      }
      return inputs.map(input => replacements.get(input) ?? input.value);
    },
    async decodeMany(inputs: readonly SourcePatternFactsInput[]): Promise<unknown[]> {
      const marked = inputs.filter(input => marker(input.value)), admitted = await owners(marked.map(input => input.profileId));
      const groups = new Map<string, { inputs: SourcePatternFactsInput[]; owner: Owner; label: InformationLabel; ids: Set<string> }>();
      let referenceBytes = 0;
      for (const input of marked) {
        const ref = marker(input.value)!, owner = admitted.get(input.profileId)!, bound = binding(input, owner);
        if (ref.ownerKey !== bound.ownerKey) return fail();
        const group = groups.get(ref.ownerKey) ?? { inputs: [], owner, label: bound.label, ids: new Set<string>() };
        group.inputs.push(input);
        for (const id of pageIds(input.value)) if (!group.ids.has(id)) {
          referenceBytes += Buffer.byteLength(id, "utf8");
          if (referenceBytes > maxReadBytes) throw Error("source-owned pattern facts exceed decoded read budget");
          group.ids.add(id);
        }
        groups.set(ref.ownerKey, group);
      }
      const replacements = new Map<SourcePatternFactsInput, unknown>(); let readBytes = 0;
      for (const [ownerKey, group] of groups) {
        const pages = new Map<string, Page>(), ids = [...group.ids];
        for (let offset = 0; offset < ids.length; offset += CHUNK) {
          const params: unknown[] = [ids.slice(offset, offset + CHUNK), ownerKey, group.owner.profile_id, group.owner.source_version_id, exactPatternFactJson(group.label)];
          const access = host.informationAccessPredicate("page", params.length + 1); params.push(...access.params);
          const scope = `page.id=ANY($1::text[]) AND page.owner_key=$2 AND page.profile_id=$3 AND page.source_version_id=$4 AND page.information_label=$5::jsonb AND ${access.sql}`;
          const sizes = await host.query<{ id: string; stored_bytes: number | string }>(`/* pattern-fact sizes */ SELECT page.id,octet_length(page.value_json::text) AS stored_bytes FROM ${host.table("source_pattern_fact_pages")} page WHERE ${scope}`, params);
          if (sizes.length !== (params[0] as string[]).length || new Set(sizes.map(item => item.id)).size !== sizes.length) return fail();
          for (const size of sizes) { const bytes = Number(size.stored_bytes); if (!Number.isSafeInteger(bytes) || bytes < 0) return fail(); readBytes += bytes; }
          if (readBytes > maxReadBytes) throw Error("source-owned pattern facts exceed decoded read budget");
          const rows = await host.query<StoredPage>(`/* pattern-fact read */ SELECT page.* FROM ${host.table("source_pattern_fact_pages")} page WHERE ${scope}`, params);
          if (rows.length !== sizes.length) return fail();
          for (const stored of rows) {
            const page = stored.value_json;
            if (!group.ids.has(stored.id) || pages.has(stored.id) || stored.owner_key !== ownerKey || stored.profile_id !== group.owner.profile_id
              || stored.source_version_id !== group.owner.source_version_id || !same(normalizeInformationLabel(stored.information_label), group.label)
              || !page || page.id !== stored.id || page.ownerKey !== ownerKey || page.kind !== stored.kind || page.digest !== stored.digest
              || Buffer.byteLength(exactPatternFactJson(page), "utf8") > maxPageBytes) return fail();
            pages.set(stored.id, page);
          }
        }
        const restoreRoles = createConstructionRoleGeometryRestorer(pages as ReadonlyMap<string, ConstructionRoleGeometryPage>, ownerKey, hasher);
        const restoreRequests = createRequestSourceFactsRestorer(pages as ReadonlyMap<string, RequestSourceFactPage>, ownerKey, hasher);
        for (const input of group.inputs) {
          const ref = marker(input.value)!, next = { ...row(restoreRoles(restoreRequests(input.value)))! }; delete next[SOURCE_PATTERN_PARTS_KEY];
          for (const [key, present, old, encoded] of ref.headerChanges ?? []) {
            if (!Object.hasOwn(next, key) || !same(next[key], encoded)) return fail();
            if (present) Object.defineProperty(next, key, { value: old, enumerable: true, configurable: true, writable: true }); else delete next[key];
          }
          if (ref.introducedLedger) { if (!same(next[LEDGER], ref.introducedLedger)) return fail(); delete next[LEDGER]; }
          if (hash(next) !== ref.recordDigest) return fail(); replacements.set(input, next);
        }
      }
      return inputs.map(input => replacements.get(input) ?? input.value);
    },
    async reconcileReferences(inputs: readonly SourcePatternFactsReference[]): Promise<void> {
      const existing = new Set<string>();
      for (let offset = 0; offset < inputs.length; offset += CHUNK) {
        const rows = await host.query<{ pattern_id: string }>(`/* pattern-fact existing refs */ SELECT DISTINCT pattern_id FROM ${host.table("source_pattern_fact_refs")} WHERE pattern_id=ANY($1::text[])`, [inputs.slice(offset, offset + CHUNK).map(input => input.patternId)]);
        rows.forEach(item => existing.add(item.pattern_id));
      }
      const active = inputs.filter(input => marker(input.value) || existing.has(input.patternId));
      const seen = new Set<string>(), admitted = await owners(active.map(input => input.profileId));
      for (let offset = 0; offset < active.length; offset += CHUNK) {
        const chunk = active.slice(offset, offset + CHUNK);
        const params: unknown[] = [chunk.map(input => input.patternId)];
        const access = host.informationAccessPredicate("pattern", params.length + 1); params.push(...access.params);
        const stored = await host.query<{ id: string; profile_id: string; pattern_json: unknown; information_label: InformationLabel }>(`/* pattern-fact patterns */ SELECT pattern.id,pattern.profile_id,pattern.pattern_json,pattern.information_label FROM ${host.table("language_patterns")} pattern WHERE pattern.id=ANY($1::text[]) AND ${access.sql}`, params);
        const byId = new Map(stored.map(item => [item.id, item]));
        const pairs: Array<{ patternId: string; pageId: string; profileId: string; ownerKey: string; sourceVersionId: string; label: InformationLabel }> = [];
        for (const input of chunk) {
          if (seen.has(input.patternId)) return fail(); seen.add(input.patternId);
          const actual = byId.get(input.patternId), ref = marker(input.value);
          if (!actual || actual.profile_id !== input.profileId || !same(row(actual.pattern_json)?.[SOURCE_PATTERN_PARTS_KEY] ?? null, ref ?? null)
            || !same(pageIds(actual.pattern_json), pageIds(input.value))) return fail();
          const ids = pageIds(input.value);
          for (const pageId of new Set(ids)) pairs.push({ patternId: input.patternId, pageId, profileId: input.profileId, ownerKey: ref!.ownerKey,
            sourceVersionId: admitted.get(input.profileId)!.source_version_id, label: normalizeInformationLabel(actual.information_label) });
        }
        if (pairs.length) {
          const pageParams: unknown[] = [exactPatternFactJson(pairs)];
          const pageAccess = host.informationAccessPredicate("page", pageParams.length + 1); pageParams.push(...pageAccess.params);
          const pages = await host.query<{ pattern_id: string; page_id: string }>(`/* pattern-fact reference pages */ WITH requested AS (
            SELECT * FROM jsonb_to_recordset($1::jsonb) AS request("patternId" text,"pageId" text,"profileId" text,"ownerKey" text,"sourceVersionId" text,label jsonb))
            SELECT request."patternId" AS pattern_id,page.id AS page_id FROM requested request JOIN ${host.table("source_pattern_fact_pages")} page
              ON page.id=request."pageId" AND page.profile_id=request."profileId" AND page.owner_key=request."ownerKey"
              AND page.source_version_id=request."sourceVersionId" AND page.information_label=request.label WHERE ${pageAccess.sql}`, pageParams);
          const expected = new Set(pairs.map(pair => exactPatternFactJson([pair.patternId, pair.pageId])));
          if (pages.length !== expected.size || new Set(pages.map(page => exactPatternFactJson([page.pattern_id, page.page_id]))).size !== expected.size
            || pages.some(page => !expected.has(exactPatternFactJson([page.pattern_id, page.page_id])))) return fail();
        }
        await host.query(`/* pattern-fact clear refs */ DELETE FROM ${host.table("source_pattern_fact_refs")} WHERE pattern_id=ANY($1::text[])`, [chunk.map(input => input.patternId)]);
        if (pairs.length) await host.query(`/* pattern-fact set refs */ INSERT INTO ${host.table("source_pattern_fact_refs")}(pattern_id,page_id)
          SELECT request."patternId",request."pageId" FROM jsonb_to_recordset($1::jsonb) AS request("patternId" text,"pageId" text) ON CONFLICT DO NOTHING`,
          [exactPatternFactJson(pairs.map(({ patternId, pageId }) => ({ patternId, pageId })))]);
      }
      await collect([...new Set(active.map(input => input.profileId))]);
    },
    async prune(profileIds: readonly string[]): Promise<void> { await owners(profileIds); await collect([...new Set(profileIds)]); }
  };
}
