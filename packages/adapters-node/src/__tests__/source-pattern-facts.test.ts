// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { type InformationLabel } from "@scce/kernel";
import { createSourcePatternFactsCodec, SOURCE_PATTERN_PARTS_KEY, sourcePatternFactSchemaStatements } from "../source-pattern-facts.js";
import { exactPatternFactJson } from "../request-source-facts.js";
import { DURABLE_JOIN_PROGRAM_BYTE_LEDGER_KEY as LEDGER, durableJoinProgramJsonByteLengths } from "../durable-join-program-storage.js";
const label: InformationLabel = { tenantId: "owner", principals: [], compartments: [], exportClass: "public", mergePolicy: "same_owner" };
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const object = (value: unknown): Record<string, unknown> => value as Record<string, unknown>;
function fixture(options: { maxPageBytes?: number; maxReadBytes?: number } = {}) {
  const pages = new Map<string, Record<string, unknown>>(), patterns = new Map<string, Record<string, unknown>>(), refs = new Map<string, string[]>();
  const calls: string[] = [], state = { ownerAccessible: true, pageAccessible: true, patternAccessible: true, conflict: false };
  const host = { table: (name: string) => `fixture.${name}`, requireWritableInformationLabel: (value: InformationLabel | undefined) => value ?? label,
    informationAccessPredicate: (alias: string, parameter: number) => ({ sql: `${alias}.information_label->>'tenantId'=$${parameter}`, params: [label.tenantId] }),
    query: async <T>(sql: string, params: unknown[] = []): Promise<T[]> => {
      calls.push(sql); let result: unknown[] = [];
      if (sql.includes("/* pattern-fact owners */")) result = state.ownerAccessible ? (params[0] as string[]).map(id => ({ profile_id: id, source_version_id: `source.${id}` })) : [];
      else if (sql.includes("/* pattern-fact insert */")) {
        const [id, owner_key, profile_id, source_version_id, kind, digest, value, info] = params;
        const next = { id, owner_key, profile_id, source_version_id, kind, digest, value_json: JSON.parse(value as string), information_label: JSON.parse(info as string) };
        if (!state.conflict && !pages.has(id as string)) { pages.set(id as string, next); result = [{ id }]; }
      } else if (sql.includes("/* pattern-fact immutable */")) {
        const [id, owner_key, profile_id, source_version_id, kind, digest, value, info] = params;
        const expected = { id, owner_key, profile_id, source_version_id, kind, digest, value_json: JSON.parse(value as string), information_label: JSON.parse(info as string) };
        if (!state.conflict && pages.has(id as string) && exactPatternFactJson(pages.get(id as string)) === exactPatternFactJson(expected)) result = [{ id }];
      } else if (sql.includes("/* pattern-fact sizes */") || sql.includes("/* pattern-fact read */")) {
        result = state.pageAccessible ? (params[0] as string[]).flatMap(id => {
          const item = pages.get(id); if (!item || item.owner_key !== params[1] || item.profile_id !== params[2] || item.source_version_id !== params[3]
            || exactPatternFactJson(item.information_label) !== params[4]) return [];
          return [sql.includes("/* pattern-fact sizes */") ? { id, stored_bytes: Buffer.byteLength(JSON.stringify(item.value_json)) } : item];
        }) : [];
      } else if (sql.includes("/* pattern-fact patterns */")) result = state.patternAccessible ? (params[0] as string[]).flatMap(id => patterns.has(id) ? [patterns.get(id)] : []) : [];
      else if (sql.includes("/* pattern-fact reference pages */")) result = (JSON.parse(params[0] as string) as Array<Record<string, unknown>>).flatMap(pair => {
        const page = pages.get(pair.pageId as string); return state.pageAccessible && page && page.profile_id === pair.profileId && page.owner_key === pair.ownerKey
          && page.source_version_id === pair.sourceVersionId && exactPatternFactJson(page.information_label) === exactPatternFactJson(pair.label) ? [{ pattern_id: pair.patternId, page_id: pair.pageId }] : [];
      });
      else if (sql.includes("/* pattern-fact clear refs */")) { for (const id of params[0] as string[]) refs.delete(id); }
      else if (sql.includes("/* pattern-fact set refs */")) { for (const pair of JSON.parse(params[0] as string) as Array<{ patternId: string; pageId: string }>) refs.set(pair.patternId, [...refs.get(pair.patternId) ?? [], pair.pageId]); }
      else if (sql.includes("/* pattern-fact collect */")) { for (const [id, page] of pages) if ((params[0] as string[]).includes(page.profile_id as string)
        && ![...refs.values()].some(ids => ids.includes(id))) pages.delete(id); }
      else throw Error("unexpected fakehost query");
      return clone(result) as T[];
    } };
  const codec = createSourcePatternFactsCodec(host, options);
  const request = (index = 0, profileId = "p") => ({ schema: "scce.request_requirement_pattern.v1", profileId, sourceVersionId: `source.${profileId}`, sourceCompilationId: "compilation",
    sourceTurnRanges: [{ start: 0, end: 12, text: "雪🧵e\u0301\u0000\r\n" }], sourceMetadata: { authored: "human", uri: "fixture://source" }, trainingSourceUri: "fixture://source", occurrence: index });
  const construction = () => ({ schema: "scce.language_construction_pattern.v1", storageEncoding: "scce.language_construction.source_examples.v1", profileId: "p", sourceVersionId: "source.p", sourceCompilationId: "compilation",
    bundle: { sourceExamples: [{ evidenceIndex: 0, surfaceStartCodePoint: 0, surfaceEndCodePoint: 9,
      roles: [{ slotIndex: 0, occurrenceIndex: 0, startCodePoint: 0, endCodePoint: 2, graphBinding: { exact: "雪🧵e\u0301\u0000" } }], nullRoles: [] }] } });
  const input = (value: unknown, extra = {}) => ({ value, logicalValue: value, profileId: String(object(value).profileId), informationLabel: label, ...extra });
  return { codec, pages, patterns, refs, calls, state, request, construction, input };
}

describe("source-owned pattern fact page host", () => {
  it("uses one source-owned page host for both fact kinds, restores exact ordered Unicode records and truthful byte ledgers", async () => {
    const f = fixture(), originals = [f.request(), f.request(1), f.construction()], snapshot = clone(originals);
    const encoded = await f.codec.encodeMany(originals.map(value => f.input(value, { selectionHeaders: { sourceCandidate: true, occurrence: 99 } })));
    expect(f.pages.size).toBe(2); expect(new Set([...f.pages.values()].map(page => page.kind))).toEqual(new Set(["request_source_fact", "construction_role_geometry"]));
    encoded.forEach((value, index) => {
      expect(object(value)[LEDGER]).toMatchObject(durableJoinProgramJsonByteLengths(originals[index]));
      expect(object(value).sourceCandidate).toBe(true); expect(object(value).occurrence).toBe(99);
    });
    const decoded = await f.codec.decodeMany(encoded.map((value, index) => f.input(value, { logicalValue: originals[index] })));
    expect(decoded).toEqual(originals); expect(originals).toEqual(snapshot);
    expect(decoded.map(exactPatternFactJson)).toEqual(originals.map(exactPatternFactJson));
    expect(f.calls.filter(sql => sql.includes("/* pattern-fact read */"))).toHaveLength(1);
    expect(f.calls.find(sql => sql.includes("/* pattern-fact owners */"))).toContain("profile.source_version_id");
    expect(f.calls.find(sql => sql.includes("/* pattern-fact read */"))).toContain("page.information_label=$5::jsonb");
    object(object(decoded[0]).sourceMetadata).authored = "caller mutation";
    expect(object(object(decoded[1]).sourceMetadata).authored).toBe("human");
  });

  it.each(["owner", "page", "label", "profile", "version", "compilation", "digest", "missing", "foreign", "ledger", "header"])("rejects %s corruption or inaccessible scope without a cross-call cache", async mode => {
    const f = fixture(), original = f.request(), [value] = await f.codec.encodeMany([f.input(original, { selectionHeaders: { sourceCandidate: true } })]);
    const encoded = clone(value), input = f.input(encoded);
    await f.codec.decodeMany([input]);
    const page = [...f.pages.values()][0]!;
    if (mode === "owner") f.state.ownerAccessible = false;
    if (mode === "page") f.state.pageAccessible = false;
    if (mode === "label") input.informationLabel = { ...label, compartments: ["foreign"] };
    if (mode === "profile") { input.profileId = "foreign"; object(encoded).profileId = "foreign"; }
    if (mode === "version") page.source_version_id = "foreign";
    if (mode === "compilation") object(encoded).sourceCompilationId = "foreign";
    if (mode === "digest") object((object(page.value_json).payload as unknown[])[0]).value = "changed";
    if (mode === "missing") f.pages.clear();
    if (mode === "foreign") page.owner_key = "foreign";
    if (mode === "ledger") object(object(encoded)[LEDGER]).decodedJsonBytes = 1;
    if (mode === "header") object(encoded).sourceCandidate = false;
    await expect(f.codec.decodeMany([input])).rejects.toThrow();
  });

  it("checks page size before fetching payloads and rejects immutable conflict and orphan inner references", async () => {
    const f = fixture({ maxReadBytes: 300 }), [value] = await f.codec.encodeMany([f.input(f.request())]);
    await expect(f.codec.decodeMany([f.input(value)])).rejects.toThrow(/read budget/u);
    expect(f.calls.some(sql => sql.includes("/* pattern-fact read */"))).toBe(false);
    expect(f.calls.some(sql => sql.includes("/* pattern-fact sizes */"))).toBe(true);
    f.state.conflict = true;
    await expect(f.codec.encodeMany([f.input(f.request())])).rejects.toThrow();
    const orphan = clone(value); delete object(orphan)[SOURCE_PATTERN_PARTS_KEY];
    await expect(f.codec.decodeMany([f.input(orphan)])).rejects.toThrow();
    const tiny = fixture({ maxPageBytes: 1 }); await expect(tiny.codec.encodeMany([tiny.input(tiny.request())])).rejects.toThrow();
  });

  it("preserves an existing original-logical ledger across already packed physical values", async () => {
    const f = fixture(), logical = { ...f.request(), expandedProof: "x".repeat(1024) }, physical = { ...f.request(), [LEDGER]: { schema: "scce.durable_join_program.byte_ledger.v1", ...durableJoinProgramJsonByteLengths(logical) } };
    const [value] = await f.codec.encodeMany([f.input(physical, { logicalValue: logical })]);
    expect(object(object(value)[SOURCE_PATTERN_PARTS_KEY]).introducedLedger).toBe(false);
    expect(await f.codec.decodeMany([f.input(value)])).toEqual([physical]);
    await expect(f.codec.encodeMany([f.input(physical)])).rejects.toThrow();
  });

  it("keeps identical facts isolated by profile, compilation and exact information label", async () => {
    const f = fixture(), first = f.request(), second = f.request(0, "q"), third = { ...f.request(), sourceCompilationId: "other" };
    const encoded = await f.codec.encodeMany([first, second, third].map(value => f.input(value)));
    expect(f.pages.size).toBe(3);
    expect(new Set([...f.pages.values()].map(page => page.owner_key)).size).toBe(3);
    expect(await f.codec.decodeMany(encoded.map((value, index) => f.input(value, { profileId: index === 1 ? "q" : "p" })))).toEqual([first, second, third]);
    await f.codec.encodeMany([f.input(first)]);
    const insert = f.calls.find(sql => sql.includes("/* pattern-fact insert */"))!;
    expect(insert).toContain("ON CONFLICT(id) DO NOTHING");
    const immutable = f.calls.find(sql => sql.includes("/* pattern-fact immutable */"))!;
    for (const field of ["owner_key", "profile_id", "source_version_id", "kind", "digest", "value_json", "information_label"]) expect(immutable).toContain(`existing.${field}=$`);
  });

  it("reconciles only after stored pattern identity is verified, retains shared pages and collects replaced/deleted references", async () => {
    const f = fixture(), originals = [f.request(), f.request(1)], encoded = await f.codec.encodeMany(originals.map(value => f.input(value)));
    const inputs = encoded.map((value, index) => ({ value, patternId: `pattern.${index}`, profileId: "p" }));
    await expect(f.codec.reconcileReferences(inputs)).rejects.toThrow();
    inputs.forEach(input => f.patterns.set(input.patternId, { id: input.patternId, profile_id: input.profileId, pattern_json: input.value, information_label: label }));
    await f.codec.reconcileReferences(inputs); expect(f.refs.size).toBe(2); expect(f.pages.size).toBe(1);
    const plain = { schema: "unrelated" }; f.patterns.get("pattern.0")!.pattern_json = plain;
    await f.codec.reconcileReferences([{ value: plain, patternId: "pattern.0", profileId: "p" }]);
    expect(f.refs.size).toBe(1); expect(f.pages.size).toBe(1);
    f.refs.delete("pattern.1"); f.patterns.delete("pattern.1"); await f.codec.prune(["p"]); expect(f.pages.size).toBe(0);
  });

  it("batches page validation and reference mutations by128 patterns rather than issuing per-pattern SQL", async () => {
    const f = fixture(), [value] = await f.codec.encodeMany([f.input(f.request())]);
    const inputs = Array.from({ length: 257 }, (_, index) => ({ value, patternId: `pattern.${index}`, profileId: "p" }));
    inputs.forEach(input => f.patterns.set(input.patternId, { id: input.patternId, profile_id: "p", pattern_json: value, information_label: label }));
    f.calls.length = 0; await f.codec.reconcileReferences(inputs);
    for (const tag of ["patterns", "reference pages", "clear refs", "set refs"]) expect(f.calls.filter(sql => sql.includes(`/* pattern-fact ${tag} */`))).toHaveLength(3);
    expect(f.refs.size).toBe(257); expect(f.pages.size).toBe(1);
    f.state.pageAccessible = false; const before = clone([...f.refs]);
    await expect(f.codec.reconcileReferences(inputs)).rejects.toThrow(); expect([...f.refs]).toEqual(before);
  });

  it("defines owner-bound shared pages and cascading pattern references without a parallel public pattern store", () => {
    const statements = sourcePatternFactSchemaStatements('"fixture"').join("\n");
    expect(statements).toContain("REFERENCES \"fixture\".source_versions(id)");
    expect(statements).toContain("REFERENCES \"fixture\".language_patterns(id) ON DELETE CASCADE");
    expect(statements).toContain("PRIMARY KEY(pattern_id,page_id)"); expect(statements).toContain("idx_source_pattern_fact_refs_page");
  });
});
