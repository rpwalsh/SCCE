// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { randomBytes, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHasher } from "@scce/kernel";
import { createPostgresStorageAdapter, type PostgresStorageAdapter } from "../postgres.js";
import { readScceRuntimeConfig } from "../config.js";
import { CREATIVE_EVENT_NORMALIZATION_SCHEMA, creativeEventStorageJson, type CreativeEventDomainRecord } from "../creative-event-normalization.js";
import { createCreativeLexemePageStore, creativeLexemePageReferences, creativeLexicalPageSchemaStatements,
  encodeCreativeLexemePage, decodeCreativeLexemePage, type CreativeLexicalPage } from "../creative-lexeme-page-storage.js";

const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function lexical(index: number): CreativeEventDomainRecord {
  const sourceLabel = `opaque.${index}.🧪é雪`, forms = { infinitive: sourceLabel, past: sourceLabel, present: sourceLabel, gerund: sourceLabel, participle: sourceLabel };
  const value = { sourceLabel, forms };
  return { id: createHasher().digestHex(creativeEventStorageJson([CREATIVE_EVENT_NORMALIZATION_SCHEMA, "lexical_forms", value])), kind: "lexical_forms", value };
}
function rehash(page: CreativeLexicalPage): void { page.id = createHash("sha256").update(creativeEventStorageJson([page.memberIds, page.value])).digest("hex"); }

describe("exact lexical definition pages", () => {
  it("shares only equal strings and shapes while preserving original definition IDs and future extensions", () => {
    const records = Array.from({ length: 256 }, (_, index) => lexical(index));
    const changed = records[0]!.value.forms as Record<string, unknown>;
    changed.past = "different.🧪"; changed.extension = JSON.parse('{"__proto__":"inert","text":"é\\u0000雪","values":[false,null,12.5]}');
    records[0]!.id = createHasher().digestHex(creativeEventStorageJson([CREATIVE_EVENT_NORMALIZATION_SCHEMA, "lexical_forms", records[0]!.value]));
    const before = creativeEventStorageJson(records), page = encodeCreativeLexemePage(records), restored = decodeCreativeLexemePage(cold(page));
    expect(creativeEventStorageJson(restored)).toBe(before);
    expect(page.memberIds).toEqual(records.map(row => row.id));
    expect(Buffer.byteLength(JSON.stringify(page.value))).toBeLessThan(Buffer.byteLength(JSON.stringify(records)) / 2);
    (restored[0]!.value.forms as Record<string, unknown>).past = "changed";
    expect(creativeEventStorageJson(decodeCreativeLexemePage(cold(page)))).toBe(before);
    expect(creativeEventStorageJson(records)).toBe(before);
  });
  it("rejects changed page hashes, unknown fields, forged old definition IDs and malformed references", () => {
    const page = encodeCreativeLexemePage([lexical(0), lexical(1)]);
    for (const mutate of [(value: CreativeLexicalPage) => { value.id = "0".repeat(64); },
      (value: CreativeLexicalPage) => { value.value.decodedBytes--; rehash(value); },
      (value: CreativeLexicalPage) => { Object.assign(value.value, { unknown: true }); rehash(value); },
      (value: CreativeLexicalPage) => { value.memberIds[0] = "1".repeat(64); rehash(value); },
      (value: CreativeLexicalPage) => { value.value.body.values[0] = 999999; rehash(value); }]) {
      const invalid = cold(page); mutate(invalid); expect(() => decodeCreativeLexemePage(invalid)).toThrow();
    }
    expect(() => encodeCreativeLexemePage([])).toThrow();
    expect(() => encodeCreativeLexemePage(Array.from({ length: 257 }, (_, index) => lexical(index)))).toThrow();
    expect(() => creativeLexemePageReferences([lexical(0).id], new Map())).toThrow();
  });
});

const nativeConfig = process.env.SCCE_LEXEME_NATIVE_CONFIG;
describe.skipIf(!nativeConfig)("native transactional lexical page publication", () => {
  let first: PostgresStorageAdapter, second: PostgresStorageAdapter;
  const stores: ReturnType<typeof createCreativeLexemePageStore>[] = [];
  beforeAll(async () => {
    const config = await readScceRuntimeConfig(nativeConfig!);
    const databaseName = "scce_lexical_test_" + randomBytes(10).toString("hex"), adminURL = new URL(config.database.url); adminURL.pathname = "/postgres";
    const admin = createPostgresStorageAdapter({ ...config.database, url: adminURL.toString(), informationAccess: config.security?.informationAccess });
    try { expect((await admin.query("SELECT 1 FROM pg_database WHERE datname=$1", [databaseName])).length).toBe(0); await admin.query(`CREATE DATABASE "${databaseName}" TEMPLATE template0`); }
    finally { await admin.close(); }
    const url = new URL(config.database.url); url.pathname = "/" + databaseName;
    first = createPostgresStorageAdapter({ ...config.database, url: url.toString(), schema: "lexical_test", informationAccess: config.security?.informationAccess });
    second = createPostgresStorageAdapter({ ...config.database, url: url.toString(), schema: "lexical_test", informationAccess: config.security?.informationAccess });
    expect((await first.query<{ name: string }>("SELECT current_database() AS name"))[0]!.name).toBe(databaseName);
    await first.query('CREATE SCHEMA "lexical_test"');
    for (const statement of creativeLexicalPageSchemaStatements('"lexical_test"')) await first.query(statement);
    for (const storage of [first, second]) stores.push(createCreativeLexemePageStore({ table: name => storage.table(name),
      query: (sql, params) => storage.query(sql, params), transaction: work => storage.transaction(work) }));
  });
  afterAll(async () => { await first?.close(); await second?.close(); });

  it("deduplicates overlapping concurrent writers and exact retries using one transaction-scoped lock", async () => {
    const records = Array.from({ length: 500 }, (_, index) => lexical(index));
    const [left, right] = await Promise.all([stores[0]!.putMany(records.slice(0, 300)), stores[1]!.putMany(records.slice(200))]);
    for (const record of records.slice(200, 300)) expect(left.get(record.id)).toEqual(right.get(record.id));
    const counts = await first.query<{ members: string; distinct_members: string; maximum_uses: string }>(`SELECT count(*)::text AS members,count(DISTINCT member)::text AS distinct_members,max(uses)::text AS maximum_uses
      FROM (SELECT member,count(*) OVER (PARTITION BY member) AS uses FROM "lexical_test".creative_event_lexical_pages CROSS JOIN LATERAL unnest(member_ids) member) members`);
    expect(counts[0]).toEqual({ members: "500", distinct_members: "500", maximum_uses: "1" });
    const before = await first.query<{ count: string }>('SELECT count(*)::text AS count FROM "lexical_test".creative_event_lexical_pages');
    expect(await stores[0]!.putMany(records.slice(0, 300))).toEqual(left);
    expect(await first.query('SELECT count(*)::text AS count FROM "lexical_test".creative_event_lexical_pages')).toEqual(before);
    const locations = new Map([...left, ...right]), reference = creativeLexemePageReferences(records.map(row => row.id), locations);
    const restored = await stores[1]!.readReferences([cold(reference)]);
    expect(restored.ids[0]).toEqual(records.map(row => row.id));
    expect(restored.records).toEqual(records);
  });

  it("rolls back page writes atomically and safely retries the identical definition", async () => {
    const record = lexical(1000);
    await expect(first.transaction(async () => { await stores[0]!.putMany([record]); throw Error("abort qualified write"); })).rejects.toThrow("abort qualified write");
    expect(await first.query('SELECT id FROM "lexical_test".creative_event_lexical_pages WHERE member_ids @> $1::bytea[]', [[Buffer.from(record.id, "hex")]])).toEqual([]);
    const locations = await stores[0]!.putMany([record]), reference = creativeLexemePageReferences([record.id], locations);
    expect((await stores[1]!.readReferences([reference])).records).toEqual([record]);
    const bad = cold(reference); bad.refs[0]![1] = 255;
    await expect(stores[1]!.readReferences([bad])).rejects.toThrow();
  });
});
