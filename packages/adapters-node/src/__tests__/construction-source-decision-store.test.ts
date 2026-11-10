// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { createHasher, constructionSourceExampleStorageJson as exact, requestSeedLanguagePattern, encodeConstructionSourceExamples,
  type EvidenceSpan, type InformationLabel, type JsonValue } from "@scce/kernel";
import { createConstructionSourceDecisionStore, constructionSourceDecisionSchemaStatements, type ConstructionSourceDecisionStorageHost } from "../construction-source-decision-store.js";
import { decodeDurableJoinPrograms, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, durableJoinProgramJsonByteLengths } from "../durable-join-program-storage.js";
const label: InformationLabel = { tenantId: "tenant", principals: ["owner"], compartments: [], exportClass: "restricted", mergePolicy: "isolated" };
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function values() { return Array.from({ length: 24 }, (_, i) => {
  const digest = "digest." + i;
  return { schema: "scce.language_construction_pattern.v1", storageEncoding: "scce.language_construction.source_examples.v1", sourceCompilationId: "compilation", contentDigest: digest,
    bundle: { schema: "scce.language_construction_pattern.v1", id: "surface.construction.bundle." + digest, contentDigest: digest, bindingId: "language.source_relation." + i,
      sourceProfileId: "profile", targetProfileId: "profile", sourceVersionIds: ["version"], evidenceIds: ["evidence"], evidenceContentHashes: ["hash"], acquisitionStatus: "source_observed",
      sourceExamples: [0, 5, 10].map(start => ({ evidenceIndex: 0, surfaceStartCodePoint: start, surfaceEndCodePoint: start + 4,
        roles: [{ slotIndex: 0, occurrenceIndex: 0, startCodePoint: 0, endCodePoint: 2 }, { slotIndex: 1, occurrenceIndex: 0, startCodePoint: 2, endCodePoint: 4 }], nullRoles: [] })) } };
}); }
const seed = (value: unknown) => requestSeedLanguagePattern({ id: "pattern", profileId: "profile", patternKind: "semantic_role", support: 1, entropy: 0,
  evidenceIds: [], updatedAt: 1, patternJson: value as JsonValue }).patternJson;
function fixture() {
  const evidence = { id: "evidence", sourceId: "source", sourceVersionId: "version", contentHash: "hash", charStart: 0, charEnd: 200, byteStart: 0, byteEnd: 200,
    text: "abcd ".repeat(40), status: "promoted", informationLabel: label } as unknown as EvidenceSpan;
  type Stored = { id: string; owner_key: string; kind: string; value_json: Record<string, unknown>; information_label: InformationLabel };
  const pages = new Map<string, Stored>(), calls: string[] = [];
  const state = { depth: 0, transactions: 0, hidden: false, headerBytes: undefined as number | undefined, bodyReads: 0, evidence: [evidence] };
  const host: ConstructionSourceDecisionStorageHost = {
    table: name => `"fixture"."${name}"`,
    transaction: async work => { state.transactions++; state.depth++; try { return await work(); } finally { state.depth--; } },
    requireWritableInformationLabel: value => value ?? label,
    informationAccessPredicate: (alias, first) => ({ sql: `${alias}.information_label->>'tenantId'=$${first}`, params: ["tenant"] }),
    evidence: async ids => { expect(state.depth).toBeGreaterThan(0); return cold(state.evidence.filter(span => ids.includes(span.id))); },
    async query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
      calls.push(sql);
      if (sql.startsWith("INSERT")) { expect(state.depth).toBeGreaterThan(0); for (const row of JSON.parse(String(params[0])) as Stored[]) if (!pages.has(row.id)) pages.set(row.id, cold(row)); return []; }
      expect(sql).toContain("page.information_label");
      if (sql.includes("JOIN jsonb_to_recordset")) { const expected = JSON.parse(String(params[0])) as Stored[];
        return expected.filter(row => !state.hidden && pages.has(row.id) && exact(pages.get(row.id)) === exact(row)).map(row => ({ id: row.id })) as T[]; }
      const ids = params[0] as string[], owner = params[1];
      const selected = [...pages.values()].filter(row => !state.hidden && ids.includes(row.id) && row.owner_key === owner);
      if (sql.includes("octet_length")) return selected.map(row => ({ id: row.id, owner_key: row.owner_key, kind: row.kind, json_bytes: String(state.headerBytes ?? Buffer.byteLength(JSON.stringify(row.value_json))) })) as T[];
      state.bodyReads++; return cold(selected) as T[];
    }
  };
  return { pages, state, calls, host, store: createConstructionSourceDecisionStore(host) };
}

it("stores shared pages transactionally and restores every original body before the canonical decoder, with one original byte charge", async () => {
  const f = fixture(), originals = values();
  const stored = await f.store.encodeMany(originals.map(value => ({ value, informationLabel: label, logicalValue: value })));
  expect(f.pages.size).toBeGreaterThan(0);
  const restored = await f.store.decodeMany(cold(stored));
  expect(restored.map(value => decodeDurableJoinPrograms(value))).toEqual(originals);
  stored.forEach((value, i) => expect(object(value)[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toEqual({ schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...durableJoinProgramJsonByteLengths(originals[i]) }));
  const namespace = createHasher().digestHex(exact(label));
  expect([...f.pages.values()].every(row => row.value_json.namespace === namespace)).toBe(true);
  expect(constructionSourceDecisionSchemaStatements('"fixture"')[0]).toContain("construction_source_decision_pages");
});

it("keeps exact label namespaces separate and preserves a preexisting valid original byte ledger", async () => {
  const f = fixture(), originals = values(), other: InformationLabel = { ...label, exportClass: "confidential" };
  f.state.evidence[0]!.informationLabel = { ...label, exportClass: "internal" };
  const ledger = { schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...durableJoinProgramJsonByteLengths(originals[0]) };
  const stored = await f.store.encodeMany([...originals.map(value => ({ value, logicalValue: value, informationLabel: label })),
    ...originals.map(value => ({ value, logicalValue: value, informationLabel: other }))]);
  expect(new Set([...f.pages.values()].map(row => row.value_json.namespace)).size).toBe(2);
  const [again] = await f.store.encodeMany([{ value: { ...originals[0], [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: ledger }, logicalValue: originals[0], informationLabel: label }, ...originals.slice(1).map(value => ({ value, informationLabel: label }))]);
  expect(object(again)[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toEqual(ledger);
  const restored = await f.store.decodeMany(stored); expect(restored.map(value => decodeDurableJoinPrograms(value))).toEqual([...originals, ...originals]);
});

it("factors nested model and event projections while charging only the original parent payload", async () => {
  const f = fixture(), source = values();
  const model = { schema: "model", memoryProjections: source.map(patternJson => ({ patternJson, informationLabel: label })) };
  const event = { schema: "event", payload: { projections: source.slice(0, 16) } };
  const existing = { schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, ...durableJoinProgramJsonByteLengths(event) };
  const stored = await f.store.encodeMany([{ value: model, informationLabel: label, logicalValue: model },
    { value: { ...event, [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: existing }, informationLabel: label, logicalValue: event }]);
  expect(object(stored[1])[DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]).toEqual(existing);
  const nested = object(stored[0]).memoryProjections as Array<{ patternJson: Record<string, unknown> }>;
  expect(nested.every(row => !Object.hasOwn(row.patternJson, DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY))).toBe(true);
  expect((await f.store.decodeMany(cold(stored))).map(value => decodeDurableJoinPrograms(value))).toEqual([model, event]);
});

it("rejects incompatible nested information labels before inserting any page", async () => {
  const f = fixture(), parent = { memoryProjections: values().map(patternJson => ({ patternJson, informationLabel: { ...label, principals: ["different-owner"] } })) };
  await expect(f.store.encodeMany([{ value: parent, informationLabel: label }])).rejects.toThrow();expect(f.pages.size).toBe(0);
});

it.each(["missing", "unpromoted"])("rejects %s evidence without persisting pages", async mutation => {
  const f = fixture(); if (mutation === "missing") f.state.evidence = []; else f.state.evidence[0]!.status = "quarantined";
  await expect(f.store.encodeMany(values().map(value => ({ value, informationLabel: label })))).rejects.toThrow("decision storage");expect(f.pages.size).toBe(0);
});

it.each(["acl", "owner", "label", "digest", "reference"])("fails closed on %s mismatch", async mutation => {
  const f = fixture(), stored = await f.store.encodeMany(values().map(value => ({ value, informationLabel: label })));
  if (mutation === "acl") f.state.hidden = true;
  if (mutation === "owner") object(stored[0]).sourceCompilationId = "another-compilation";
  if (mutation === "label") [...f.pages.values()][0]!.information_label = { ...label, compartments: ["changed"] };
  if (mutation === "digest") [...f.pages.values()][0]!.value_json.digest = "bad";
  if (mutation === "reference") object(stored[0]).contentDigest = "transplanted";
  await expect(f.store.decodeMany(stored)).rejects.toThrow();
});

it("rejects oversized headers before fetching a page body, and immutable identity collisions", async () => {
  const f = fixture(), inputs = values().map(value => ({ value, informationLabel: label })), stored = await f.store.encodeMany(inputs);
  f.state.headerBytes = 100 * 1024 * 1024;
  await expect(f.store.decodeMany(stored)).rejects.toThrow();expect(f.state.bodyReads).toBe(0);
  [...f.pages.values()][0]!.value_json.digest = "collision";
  await expect(f.store.encodeMany(inputs)).rejects.toThrow();
});

it("passes unrelated families through and rejects preencoded references and counterfeit byte charges", async () => {
  const f = fixture(), unrelated = { schema: "other", value: [1] };
  expect(await f.store.encodeMany([{ value: unrelated }])).toEqual([unrelated]);expect(await f.store.decodeMany([unrelated])).toEqual([unrelated]);expect(f.calls).toHaveLength(0);expect(f.state.transactions).toBe(0);
  const originals = values(), stored = await f.store.encodeMany(originals.map(value => ({ value, informationLabel: label })));
  await expect(f.store.encodeMany([{ value: stored[0], informationLabel: label }])).rejects.toThrow();
  await expect(f.store.encodeMany(originals.map(value => ({ value: { ...value, [DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY]: { schema: DURABLE_JOIN_PROGRAM_BYTE_LEDGER_SCHEMA, decodedJsonBytes: 1, decodedJsonbBytes: 1 } }, logicalValue: value, informationLabel: label })))).rejects.toThrow();
});

it.each([["roles", "sourceConstructionCandidate"], ["nullRoles", "requestConstructionCandidate"]] as const)(
  "keeps %s graph declarations inline when their true root query hint is absent", async (field, hint) => {
    const f = fixture(), originals = values();
    for (const value of originals) for (const example of value.bundle.sourceExamples) {
      if (field === "roles") object(example.roles[0]).graphBinding = { relationId: "relation.opaque", roleId: "role.opaque", valueKind: "entity" };
      else object(example).nullRoles = [{ slotIndex: 2, occurrenceIndex: 0, graphBinding: { relationId: "relation.opaque", roleId: "role.opaque", valueKind: "entity" } }];
    }
    object(originals[0])[hint] = false;
    expect(object(seed(originals[0]))[hint]).toBe(true);
    const stored = await f.store.encodeMany(originals.map(value => ({ value, logicalValue: value, informationLabel: label })));
    expect(stored.every((value, index) => value === originals[index])).toBe(true);
    expect(stored.map(seed)).toEqual(originals.map(seed));
    expect(f.calls).toHaveLength(0); expect(f.state.transactions).toBe(0); expect(f.pages.size).toBe(0);
    // The current producer's explicit hints retain exactly the same seed meaning after paging.
    originals.forEach(value => { object(value)[hint] = true; });
    const paged = await f.store.encodeMany(originals.map(value => ({ value, logicalValue: value, informationLabel: label })));
    expect(f.pages.size).toBeGreaterThan(0);
    expect(paged.map(seed)).toEqual(originals.map(seed));
    expect((await f.store.decodeMany(cold(paged))).map(decodeDurableJoinPrograms)).toEqual(originals);
  });

it("checks graph declarations inside compact source examples without adding visible query flags", async () => {
  const f = fixture(), originals = values();
  for (const value of originals) {
    object(value.bundle.sourceExamples[0]!.roles[0]).graphBinding = { relationId: "relation.opaque", roleId: "role.opaque", valueKind: "entity" };
    object(value.bundle).sourceExamples = encodeConstructionSourceExamples(value.bundle.sourceExamples, value.bundle, createHasher());
  }
  const before = exact(originals), stored = await f.store.encodeMany(originals.map(value => ({ value, informationLabel: label })));
  expect(stored).toEqual(originals); expect(exact(originals)).toBe(before);
  expect(stored.every(value => !Object.hasOwn(object(value), "sourceConstructionCandidate"))).toBe(true);
  expect(f.calls).toHaveLength(0); expect(f.state.transactions).toBe(0);
});

it("writes bounded 64 KiB pages while retaining the existing 256 KiB read contract", async () => {
  const f = fixture(), originals = values();
  originals.forEach((value, index) => { object(value.bundle).opaqueHeader = `${index}.` + "x".repeat(5000); });
  expect(() => createConstructionSourceDecisionStore(f.host, { maxPageBytes: 65536, writePageBytes: 65537 })).toThrow();
  const priorWriter = createConstructionSourceDecisionStore(f.host, { writePageBytes: 256 * 1024 });
  const old = await priorWriter.encodeMany(originals.map(value => ({ value, informationLabel: label })));
  expect([...f.pages.values()].some(row => Buffer.byteLength(exact(row.value_json)) > 64 * 1024)).toBe(true);
  expect((await f.store.decodeMany(cold(old))).map(decodeDurableJoinPrograms)).toEqual(originals);
  f.state.headerBytes = 1;
  const narrowReader = createConstructionSourceDecisionStore(f.host, { maxPageBytes: 64 * 1024 });
  await expect(narrowReader.decodeMany(cold(old))).rejects.toThrow();
  f.state.headerBytes = undefined;
  f.pages.clear();
  const current = await f.store.encodeMany(originals.map(value => ({ value, informationLabel: label })));
  expect(f.pages.size).toBeGreaterThan(1);
  expect([...f.pages.values()].every(row => Buffer.byteLength(exact(row.value_json)) <= 64 * 1024)).toBe(true);
  expect((await f.store.decodeMany(cold(current))).map(decodeDurableJoinPrograms)).toEqual(originals);
});

it("preserves raw array roots without adding a ledger envelope or performing I/O", async () => {
  const f = fixture(), array = values(), before = exact(array);
  const stored = await f.store.encodeMany([{ value: array, informationLabel: label }]);
  expect(stored[0]).toBe(array); expect(exact(stored[0])).toBe(before);
  expect(await f.store.decodeMany(cold(stored))).toEqual([array]);
  expect(f.calls).toHaveLength(0); expect(f.state.transactions).toBe(0); expect(f.pages.size).toBe(0);
});
