// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { CONSTRUCTION_ROLE_GEOMETRY_KEY, constructionRoleGeometryPageIds, createConstructionRoleGeometryRestorer,
  normalizeConstructionRoleGeometry, restoreConstructionRoleGeometry, validateConstructionRoleGeometryPage } from "../construction-role-geometry-storage.js";
import { LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE } from "../language-construction-memory.js";
import { createHasher } from "../primitives.js";
import type { JsonValue } from "../types.js";

const hasher = createHasher(), owner = "compilation.exact/profile.owned/label.restricted";
const cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value));
function pattern(index: number, observations = 32) {
  return { schema: LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
    sourceCompilationId: "compilation.exact", contentDigest: `original.canonical.digest.${index}`,
    bundle: { bindingId: `binding.${index}`, sourceProfileId: "profile.owned", evidenceIds: ["evidence.exact"],
      sourceExamples: Array.from({ length: observations }, (_, occurrence) => ({ evidenceIndex: 0,
        surfaceStartCodePoint: (index * observations + occurrence) * 10, surfaceEndCodePoint: (index * observations + occurrence) * 10 + 9,
        roles: [{ slotIndex: 0, occurrenceIndex: 0, startCodePoint: 0, endCodePoint: 2 },
          { slotIndex: 1, occurrenceIndex: 0, startCodePoint: 3, endCodePoint: 5, graphBinding: {
            relationId: "relation.opaque", roleId: "role.opaque", valueKind: "entity", qualifiers: { source: "🧪é\u0000\n" } } },
          { slotIndex: 2, occurrenceIndex: 0, startCodePoint: 6, endCodePoint: 8 }],
        nullRoles: occurrence % 2 ? [{ slotIndex: 3, occurrenceIndex: 1, graphBinding: { relationId: "relation.opaque", roleId: "role.omitted", valueKind: "entity" } }] : [],
        antecedent: { startCodePoint: 0, endCodePoint: 1 }, contextualQaSupervision: { unmodified: ["🦉", "\r\n", ""] } })) } };
}

describe("source-owned construction role geometry", () => {
  it("shares exact role definitions across unique observations, with linear references and one bounded dictionary", () => {
    let dictionary: unknown;
    for (const count of [1, 8, 32]) {
      const values = Array.from({ length: count }, (_, index) => pattern(index));
      const before = JSON.stringify(values), normalized = normalizeConstructionRoleGeometry(values, owner, hasher, 1024);
      expect(JSON.stringify(values)).toBe(before);
      expect(normalized.pages.flatMap(page => page.payload)).toHaveLength(4);
      expect(normalized.pages.every(page => bytes(page) <= 1024)).toBe(true);
      if (dictionary) expect(normalized.pages).toEqual(dictionary); else dictionary = cold(normalized.pages);
      const pages = new Map(cold(normalized.pages).map(page => [page.id, page]));
      const restore = createConstructionRoleGeometryRestorer(pages, owner, hasher);
      expect(normalized.values.map(value => restore(cold(value)))).toEqual(values);
      expect(bytes(normalized.values) + bytes(normalized.pages)).toBeLessThan(bytes(values));
      expect(normalized.values.flatMap(value => (value as typeof values[number]).bundle.sourceExamples)).toHaveLength(count * 32);
    }
  });

  it("is deterministic under input ordering and key ordering and preserves opaque extension keys exactly", () => {
    const first = pattern(0), second = pattern(1);
    Object.defineProperty(first.bundle.sourceExamples[0]!.roles[0]!, "__proto__", { value: { kept: "literal" }, enumerable: true });
    Object.defineProperty(first.bundle.sourceExamples[0]!.roles[0]!, "constructor", { value: "kept", enumerable: true });
    const ordered = normalizeConstructionRoleGeometry([first, second], owner, hasher, 512);
    const reversed = normalizeConstructionRoleGeometry([cold(second), cold(first)], owner, hasher, 512);
    expect(reversed.pages).toEqual(ordered.pages);
    expect(reversed.values).toEqual([...ordered.values].reverse());
    const pages = new Map(ordered.pages.map(page => [page.id, page]));
    expect(restoreConstructionRoleGeometry(cold(ordered.values[0]), pages, owner, hasher)).toEqual(first);
    expect(({} as Record<string, unknown>).kept).toBeUndefined();
    expect(normalizeConstructionRoleGeometry([{ schema: "unrelated", roles: [1] }], owner, hasher, 512)).toEqual({ values: [{ schema: "unrelated", roles: [1] }], pages: [] });
  });

  it("validates and snapshots each referenced page once rather than rescanning its dictionary per pattern", () => {
    const values = Array.from({ length: 32 }, (_, index) => pattern(index));
    const normalized = normalizeConstructionRoleGeometry(values, owner, hasher, 1024);
    const pages = new Map(cold(normalized.pages).map(page => [page.id, page]));
    let hashes = 0;
    const measured = { ...hasher, digestHex: (value: string | Uint8Array) => { hashes++; return hasher.digestHex(value); } };
    const restore = createConstructionRoleGeometryRestorer(pages, owner, measured);
    expect(restore(normalized.values[0])).toEqual(values[0]);
    expect(hashes).toBe(normalized.pages.length);
    for (const page of pages.values()) page.payload[0]!.slotIndex = 999;
    for (let index = 1; index < values.length; index++) expect(restore(normalized.values[index])).toEqual(values[index]);
    expect(hashes).toBe(normalized.pages.length);
  });

  it("rejects missing, changed, foreign or overbudget pages and malformed occurrence references", () => {
    const normalized = normalizeConstructionRoleGeometry([pattern(0)], owner, hasher, 1024), value = cold(normalized.values[0]) as Record<string, unknown>;
    const pages = new Map(normalized.pages.map(page => [page.id, page]));
    expect(constructionRoleGeometryPageIds(value)).toEqual(normalized.pages.map(page => page.id));
    expect(() => restoreConstructionRoleGeometry(value, new Map(), owner, hasher)).toThrow(/role geometry/u);
    expect(() => restoreConstructionRoleGeometry(value, pages, "foreign", hasher)).toThrow(/role geometry/u);
    const corrupt = cold(normalized.pages[0]!); corrupt.payload[0]!.slotIndex = 998;
    expect(() => validateConstructionRoleGeometryPage(corrupt, owner, hasher)).toThrow(/role geometry/u);
    const examples = (value.bundle as { sourceExamples: { roles: unknown[] }[] }).sourceExamples;
    examples[0]!.roles[0] = [0, 99999];
    expect(() => restoreConstructionRoleGeometry(value, pages, owner, hasher)).toThrow(/role geometry/u);
    expect(() => normalizeConstructionRoleGeometry(normalized.values, owner, hasher, 1024)).toThrow(/role geometry/u);
    expect(() => normalizeConstructionRoleGeometry([pattern(0)], owner, hasher, 1)).toThrow(/page byte budget/u);
    const wrongMarker = { ...pattern(0), [CONSTRUCTION_ROLE_GEOMETRY_KEY]: { schema: "wrong", pages: [] } };
    expect(() => constructionRoleGeometryPageIds(wrongMarker)).toThrow(/role geometry/u);
  });

  it("never merges NUL and space role labels or evaluates accessors", () => {
    const value = pattern(0, 2), role = value.bundle.sourceExamples[0]!.roles[1]!;
    value.bundle.sourceExamples[1]!.roles[1]!.graphBinding!.qualifiers.source = "🧪é \n";
    const normalized = normalizeConstructionRoleGeometry([value], owner, hasher, 1024);
    expect(normalized.pages.flatMap(page => page.payload)).toHaveLength(5);
    const unsafe = { slotIndex: 0, occurrenceIndex: 0, startCodePoint: 0, endCodePoint: 2,
      get extension(): JsonValue { throw Error("getter evaluated"); } };
    value.bundle.sourceExamples[0]!.roles[0] = unsafe;
    expect(() => normalizeConstructionRoleGeometry([value], owner, hasher, 1024)).toThrow("invalid source-owned construction role geometry");
    expect(role.graphBinding!.qualifiers.source).toContain("\u0000");
  });
});
