// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { createHash } from "node:crypto";
import { creativeEventStorageJson, verifyCreativeEventDomainRecord, type CreativeEventDomainRecord } from "./creative-event-normalization.js";
import type { CreativeEventStorageHost } from "./canonical-creative-event-store.js";

export const CREATIVE_LEXICAL_PAGE_TABLE = "creative_event_lexical_pages";
export const CREATIVE_LEXICAL_PAGE_SCHEMA = "scce.creative_lexical_page.storage.v1";
export const CREATIVE_LEXEME_PAGE_REFS_SCHEMA = "scce.creative_lexeme_page_refs.v1";
const PAGE_MEMBERS = 256, PAGE_BYTES = 256 * 1024, DECODED_PAGE_BYTES = 4 * 1024 * 1024, READ_BYTES = 64 * 1024 * 1024;
type Encoded = null | boolean | number | Encoded[];
interface Body { strings: string[]; shapes: string[][]; values: Encoded[] }
export interface CreativeLexicalPage { id: string; memberIds: string[]; value: { schema: typeof CREATIVE_LEXICAL_PAGE_SCHEMA; decodedBytes: number; body: Body } }
export interface CreativeLexemeLocation { pageId: string; ordinal: number }
export interface CreativeLexemePageReferences { schema: typeof CREATIVE_LEXEME_PAGE_REFS_SCHEMA; pages: string[]; refs: Array<[number, number]> }
interface StoredPage { id: Buffer; kind: string; member_ids: Buffer[]; value_json: CreativeLexicalPage["value"] }
type Host = Pick<CreativeEventStorageHost, "table" | "query" | "transaction">;
const fail = (): never => { throw Error("canonical creative-event storage: invalid lexical page"); };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : fail();
const integer = (value: unknown, maximum = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= maximum;
const id = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
const bytes = (value: unknown): number => Buffer.byteLength(creativeEventStorageJson(value));
const pageId = (memberIds: string[], value: CreativeLexicalPage["value"]): string => createHash("sha256").update(creativeEventStorageJson([memberIds, value])).digest("hex");

export function creativeLexicalPageSchemaStatements(q: string): string[] {
  return [`CREATE TABLE IF NOT EXISTS ${q}.${CREATIVE_LEXICAL_PAGE_TABLE} (id BYTEA PRIMARY KEY,kind TEXT NOT NULL CHECK(kind='lexical_forms_page'),member_ids BYTEA[] NOT NULL,value_json JSONB NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS idx_creative_lexical_members ON ${q}.${CREATIVE_LEXICAL_PAGE_TABLE} USING GIN(member_ids) WITH (fastupdate=off)`];
}

/** Shared strings and field shapes are exact definitions; no lexical transformation is performed. */
export function encodeCreativeLexemePage(records: readonly CreativeEventDomainRecord[]): CreativeLexicalPage {
  if (!records.length || records.length > PAGE_MEMBERS) return fail();
  const memberIds = records.map(row => { if (row.kind !== "lexical_forms" || !id(row.id)) return fail(); verifyCreativeEventDomainRecord(row); return row.id; });
  if (new Set(memberIds).size !== memberIds.length) return fail();
  const logical = records.map(row => row.value), decodedBytes = bytes(logical);
  if (decodedBytes > DECODED_PAGE_BYTES) return fail();
  const strings: string[] = [], shapes: string[][] = [], stringIds = new Map<string, number>(), shapeIds = new Map<string, number>();
  const visit = (value: unknown, depth = 0): Encoded => {
    if (depth > 64) return fail();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value) && !Object.is(value, -0)) return [0, value];
    if (typeof value === "string") { let index = stringIds.get(value); if (index === undefined) { index = strings.length; strings.push(value); stringIds.set(value, index); } return index; }
    if (Array.isArray(value)) return [1, ...value.map(child => visit(child, depth + 1))];
    const row = record(value), keys = Object.keys(row).sort(), key = JSON.stringify(keys);
    let shape = shapeIds.get(key); if (shape === undefined) { shape = shapes.length; shapes.push(keys); shapeIds.set(key, shape); }
    return [2, shape, ...keys.map(key => visit(row[key], depth + 1))];
  };
  const value: CreativeLexicalPage["value"] = { schema: CREATIVE_LEXICAL_PAGE_SCHEMA, decodedBytes, body: { strings, shapes, values: logical.map(value => visit(value)) } };
  if (bytes(value) > PAGE_BYTES) return fail();
  return { id: pageId(memberIds, value), memberIds, value };
}

export function decodeCreativeLexemePage(page: CreativeLexicalPage): CreativeEventDomainRecord[] {
  if (!page || Object.keys(page).sort().join(",") !== "id,memberIds,value" || !id(page.id) || !Array.isArray(page.memberIds) || !page.memberIds.length || page.memberIds.length > PAGE_MEMBERS
    || !page.memberIds.every(id) || new Set(page.memberIds).size !== page.memberIds.length || bytes(page.value) > PAGE_BYTES) return fail();
  const value = record(page.value), body = record(value.body);
  if (Object.keys(value).sort().join(",") !== "body,decodedBytes,schema" || value.schema !== CREATIVE_LEXICAL_PAGE_SCHEMA
    || !integer(value.decodedBytes, DECODED_PAGE_BYTES) || page.id !== pageId(page.memberIds, page.value)
    || Object.keys(body).sort().join(",") !== "shapes,strings,values" || !Array.isArray(body.strings) || !body.strings.every(value => typeof value === "string")
    || new Set(body.strings).size !== body.strings.length || !Array.isArray(body.shapes) || !Array.isArray(body.values) || body.values.length !== page.memberIds.length) return fail();
  const strings = body.strings as string[], shapes = body.shapes as string[][];
  for (const shape of shapes) if (!Array.isArray(shape) || !shape.every(value => typeof value === "string") || new Set(shape).size !== shape.length) return fail();
  if (new Set(shapes.map(shape => JSON.stringify(shape))).size !== shapes.length) return fail();
  let expandedBytes = 0, expandedValues = 0;
  const usedStrings = new Set<number>(), usedShapes = new Set<number>();
  const consume = (count: number): void => { expandedBytes += count; if (expandedBytes > DECODED_PAGE_BYTES) fail(); };
  const visit = (input: unknown, depth = 0): unknown => {
    if (depth > 64 || ++expandedValues > 1_000_000) return fail();
    if (input === null || typeof input === "boolean") { consume(Buffer.byteLength(JSON.stringify(input))); return input; }
    if (typeof input === "number") { if (!integer(input, strings.length - 1)) return fail(); usedStrings.add(input); consume(Buffer.byteLength(JSON.stringify(strings[input]))); return strings[input]; }
    if (!Array.isArray(input)) return fail();
    if (input[0] === 0 && input.length === 2 && typeof input[1] === "number" && Number.isFinite(input[1]) && !Object.is(input[1], -0)) { consume(Buffer.byteLength(JSON.stringify(input[1]))); return input[1]; }
    if (input[0] === 1) { consume(2 + Math.max(0, input.length - 2)); return input.slice(1).map(value => visit(value, depth + 1)); }
    if (input[0] === 2 && integer(input[1], shapes.length - 1)) {
      const keys = shapes[input[1]]!; if (input.length !== keys.length + 2) return fail();
      usedShapes.add(input[1]);
      consume(2 + Math.max(0, keys.length - 1) + keys.reduce((total, key) => total + Buffer.byteLength(JSON.stringify(key)) + 1, 0));
      return Object.fromEntries(keys.map((key, index) => [key, visit(input[index + 2], depth + 1)]));
    }
    return fail();
  };
  consume(2 + Math.max(0, body.values.length - 1));
  const logical = body.values.map(value => visit(value));
  if (bytes(logical) !== page.value.decodedBytes || usedStrings.size !== strings.length || usedShapes.size !== shapes.length) return fail();
  return logical.map((value, index) => { const row = { id: page.memberIds[index]!, kind: "lexical_forms", value: record(value) }; verifyCreativeEventDomainRecord(row); return row; });
}

export function creativeLexemePageReferences(ids: readonly string[], locations: ReadonlyMap<string, CreativeLexemeLocation>): CreativeLexemePageReferences {
  if (ids.length > 2048) return fail();
  const pages: string[] = [], indices = new Map<string, number>();
  const refs = ids.map(member => {
    const location = locations.get(member); if (!location || !id(location.pageId) || !integer(location.ordinal, PAGE_MEMBERS - 1)) return fail();
    let index = indices.get(location.pageId); if (index === undefined) { index = pages.length; pages.push(location.pageId); indices.set(location.pageId, index); }
    return [index, location.ordinal] as [number, number];
  });
  return { schema: CREATIVE_LEXEME_PAGE_REFS_SCHEMA, pages, refs };
}
function reference(value: unknown): CreativeLexemePageReferences {
  const row = record(value);
  if (Object.keys(row).sort().join(",") !== "pages,refs,schema" || row.schema !== CREATIVE_LEXEME_PAGE_REFS_SCHEMA || !Array.isArray(row.pages)
    || row.pages.length > 2048 || !row.pages.every(id) || new Set(row.pages).size !== row.pages.length || !Array.isArray(row.refs) || row.refs.length > 2048) return fail();
  const used = new Set<number>();
  for (const ref of row.refs) { if (!Array.isArray(ref) || ref.length !== 2 || !integer(ref[0], row.pages.length - 1) || !integer(ref[1], PAGE_MEMBERS - 1)) return fail(); used.add(ref[0]); }
  if (used.size !== row.pages.length) return fail();
  return row as unknown as CreativeLexemePageReferences;
}

/** This store is called only for definitions belonging to already-authorized occurrence/witness pages. */
export function createCreativeLexemePageStore(host: Host) {
  const table = host.table(CREATIVE_LEXICAL_PAGE_TABLE);
  async function load(ids: readonly string[]): Promise<Map<string, CreativeLexicalPage>> {
    const result = new Map<string, CreativeLexicalPage>(), wanted = [...new Set(ids)]; let totalBytes = 0;
    for (let offset = 0; offset < wanted.length; offset += 128) {
      const chunk = wanted.slice(offset, offset + 128); if (!chunk.every(id)) return fail();
      const params: unknown[] = [chunk.map(id => Buffer.from(id, "hex"))];
      const sizes = await host.query<{ id: Buffer; stored_bytes: number | string }>(`/* lexical-page sizes */ SELECT id,octet_length(value_json::text) AS stored_bytes FROM ${table} WHERE id=ANY($1::bytea[])`, params);
      if (sizes.length !== chunk.length || new Set(sizes.map(row => row.id.toString("hex"))).size !== chunk.length) return fail();
      for (const row of sizes) { const size = Number(row.stored_bytes); if (!integer(size, PAGE_BYTES)) return fail(); totalBytes += size; }
      if (totalBytes > READ_BYTES) return fail();
      const rows = await host.query<StoredPage>(`/* lexical-page read */ SELECT id,kind,member_ids,value_json FROM ${table} WHERE id=ANY($1::bytea[])`, params);
      if (rows.length !== chunk.length) return fail();
      for (const row of rows) {
        if (!Buffer.isBuffer(row.id) || row.kind !== "lexical_forms_page" || !Array.isArray(row.member_ids) || !row.member_ids.every(Buffer.isBuffer)) return fail();
        const page = { id: row.id.toString("hex"), memberIds: row.member_ids.map(member => member.toString("hex")), value: row.value_json };
        if (!chunk.includes(page.id) || result.has(page.id)) return fail(); decodeCreativeLexemePage(page); result.set(page.id, page);
      }
    }
    return result;
  }
  return {
    async putMany(records: readonly CreativeEventDomainRecord[]): Promise<Map<string, CreativeLexemeLocation>> {
      if (!records.length) return new Map();
      return host.transaction(async () => {
        // The mandatory host transaction keeps this lock, lookup and page publication on one client until commit.
        const lock = await host.query<{ isolation: string }>("/* lexical-page writer lock */ SELECT current_setting('transaction_isolation') AS isolation,pg_advisory_xact_lock(1935897190,1162627397)");
        if (lock.length !== 1 || lock[0]!.isolation !== "read committed") throw Error("lexical page publication requires a READ COMMITTED transaction");
        const requested = new Map<string, CreativeEventDomainRecord>();
        for (const row of records) { if (row.kind !== "lexical_forms" || !id(row.id)) return fail(); verifyCreativeEventDomainRecord(row); requested.set(row.id, row); }
        const ids = [...requested.keys()], pageIds = new Set<string>();
        for (let offset = 0; offset < ids.length; offset += 128) {
          const chunk = ids.slice(offset, offset + 128);
          const rows = await host.query<{ id: Buffer }>(`/* lexical-page membership */ SELECT id FROM ${table} WHERE member_ids && $1::bytea[] LIMIT $2`, [chunk.map(id => Buffer.from(id, "hex")), chunk.length + 1]);
          if (rows.length > chunk.length) return fail();
          rows.forEach(row => { if (!Buffer.isBuffer(row.id)) fail(); pageIds.add(row.id.toString("hex")); });
        }
        const existing = await load([...pageIds]), locations = new Map<string, CreativeLexemeLocation>();
        for (const page of existing.values()) for (const [ordinal, row] of decodeCreativeLexemePage(page).entries()) if (requested.has(row.id)) {
          if (locations.has(row.id) || creativeEventStorageJson(row.value) !== creativeEventStorageJson(requested.get(row.id)!.value)) return fail();
          locations.set(row.id, { pageId: page.id, ordinal });
        }
        const missing = ids.filter(id => !locations.has(id)).sort();
        for (let offset = 0; offset < missing.length;) {
          let count = Math.min(PAGE_MEMBERS, missing.length - offset), page: CreativeLexicalPage;
          for (;;) {
            try { page = encodeCreativeLexemePage(missing.slice(offset, offset + count).map(id => requested.get(id)!)); break; }
            catch (error) { if (count === 1) throw error; count = Math.max(1, Math.floor(count / 2)); }
          }
          await host.query(`/* lexical-page insert */ INSERT INTO ${table}(id,kind,member_ids,value_json) VALUES ($1,'lexical_forms_page',$2::bytea[],$3::jsonb) ON CONFLICT(id) DO NOTHING`,
            [Buffer.from(page.id, "hex"), page.memberIds.map(id => Buffer.from(id, "hex")), creativeEventStorageJson(page.value)]);
          const saved = (await load([page.id])).get(page.id)!;
          if (creativeEventStorageJson(saved) !== creativeEventStorageJson(page)) return fail();
          saved.memberIds.forEach((id, ordinal) => locations.set(id, { pageId: saved.id, ordinal })); offset += count;
        }
        return locations;
      });
    },
    async readReferences(values: readonly unknown[]): Promise<{ ids: string[][]; records: CreativeEventDomainRecord[] }> {
      const references = values.map(reference), pages = await load(references.flatMap(ref => ref.pages)), records = new Map<string, CreativeEventDomainRecord>();
      const decoded = new Map([...pages].map(([id, page]) => [id, decodeCreativeLexemePage(page)]));
      const ids = references.map(ref => ref.refs.map(([page, ordinal]) => { const row = decoded.get(ref.pages[page]!)?.[ordinal]; if (!row) return fail(); records.set(row.id, row); return row.id; }));
      return { ids, records: [...records.values()] };
    }
  };
}
