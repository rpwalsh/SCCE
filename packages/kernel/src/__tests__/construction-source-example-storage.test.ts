// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { CONSTRUCTION_SOURCE_EXAMPLE_STORAGE_SCHEMA, constructionSourceExampleStorageJson, decodeConstructionSourceExamples,
  encodeConstructionSourceExamples, type StoredConstructionSourceExamples } from "../construction-source-example-storage.js";
import { CONSTRUCTION_ROLE_GEOMETRY_KEY, normalizeConstructionRoleGeometry, restoreConstructionRoleGeometry } from "../construction-role-geometry-storage.js";
import { compileLanguageConstructionPattern, hydrateLanguageConstructionPatterns, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE } from "../language-construction-memory.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { requestSeedLanguagePattern } from "../request-language-hydration.js";
import type { SourceBoundConstructionObservation } from "../language-construction-memory.js";
import type { EvidenceSpan, JsonValue, SourceVersionId } from "../types.js";

const hasher = createHasher(), cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const owner = { id: "bundle.exact", bindingId: "binding.exact", sourceProfileId: "profile.exact", evidenceIds: ["evidence.exact"],
  evidenceContentHashes: ["sha256_exact"], contentDigest: "original.semantic.digest", sourceVersionIds: ["source.exact"] };
function examples(count = 256): Record<string, JsonValue>[] {
  return Array.from({ length: count }, (_, i) => ({ evidenceIndex: 0, surfaceStartCodePoint: i * 31, surfaceEndCodePoint: i * 31 + 30,
    roles: [{ slotIndex: 0, occurrenceIndex: 0, startCodePoint: 0, endCodePoint: 2 },
      { slotIndex: 1, occurrenceIndex: 0, startCodePoint: 3, endCodePoint: 5 },
      { slotIndex: 2, occurrenceIndex: 0, startCodePoint: 6, endCodePoint: 8 }] }));
}
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function resign(value: StoredConstructionSourceExamples) {
  const { digest: _digest, ...material } = value;
  value.digest = hasher.digestHex(constructionSourceExampleStorageJson([owner, material])); return value;
}

describe("exact compact construction source examples", () => {
  it("cold restores every occurrence and order through a deterministic role dictionary", () => {
    const source = examples(), before = cold(source), packed = encodeConstructionSourceExamples(source, owner, hasher);
    expect(packed.schema).toBe(CONSTRUCTION_SOURCE_EXAMPLE_STORAGE_SCHEMA);
    expect(packed.roles).toHaveLength(3);
    expect(packed.examples).toHaveLength(256);
    expect(decodeConstructionSourceExamples(cold(packed), owner, hasher)).toEqual(source);
    expect(source).toEqual(before);
    expect(bytes(packed)).toBeLessThan(bytes(source) / 4);
    const reversedKeys = source.map(value => Object.fromEntries(Object.entries(value).reverse()));
    expect(encodeConstructionSourceExamples(reversedKeys, owner, hasher)).toEqual(packed);
    expect(encodeConstructionSourceExamples(decodeConstructionSourceExamples(packed, owner, hasher), owner, hasher)).toEqual(packed);
  });

  it("preserves optional presence, null roles, graph bindings, antecedents, supervision, Unicode and opaque extension keys", () => {
    const source = examples(2);
    source[0]!.roles = [{ slotIndex: 0, startCodePoint: 0, endCodePoint: 2, graphBinding: { relationId: "relation.opaque", roleId: "role.opaque",
      valueKind: "entity", qualifiers: { literal: "🧪e\u0301\u0000\n\t", canonicallyDifferent: "é" } } }];
    source[0]!.nullRoles = [{ slotIndex: 3, occurrenceIndex: 0, graphBinding: { relationId: "r", roleId: "r", valueKind: "entity" } }];
    source[0]!.antecedent = { startCodePoint: 4, endCodePoint: 9, extension: null };
    source[0]!.contextualQaSupervision = { opaque: [null, false, "", "🧪e\u0301\u0000"] };
    source[1]!.nullRoles = [];
    Object.defineProperty(source[0], "__proto__", { value: { kept: "literal" }, enumerable: true });
    Object.defineProperty((source[0]!.roles as JsonValue[])[0], "constructor", { value: "opaque", enumerable: true });
    const packed = encodeConstructionSourceExamples(source, owner, hasher), restored = decodeConstructionSourceExamples(cold(packed), owner, hasher);
    expect(restored).toEqual(source);
    expect(Object.hasOwn((restored[0]!.roles as Record<string, JsonValue>[])[0]!, "occurrenceIndex")).toBe(false);
    expect(Object.hasOwn(restored[0]!, "nullRoles")).toBe(true);
    expect(Object.hasOwn(restored[1]!, "antecedent")).toBe(false);
    expect(({} as Record<string, unknown>).kept).toBeUndefined();
    (restored[0]!.roles as Record<string, JsonValue>[])[0]!.slotIndex = 999;
    expect(decodeConstructionSourceExamples(packed, owner, hasher)).toEqual(source);
  });

  it("binds the marker to exact owner fields and rejects unknown versions, tampering, invalid refs and noncanonical dictionaries", () => {
    const packed = encodeConstructionSourceExamples(examples(2), owner, hasher);
    for (const changed of [{ ...owner, bindingId: "foreign" }, { ...owner, evidenceContentHashes: ["changed"] }, { ...owner, sourceProfileId: "foreign" }]) {
      expect(() => decodeConstructionSourceExamples(packed, changed, hasher)).toThrow(/source-example/u);
    }
    for (const mutate of [
      (p: StoredConstructionSourceExamples) => { p.schema = "unknown" as typeof p.schema; },
      (p: StoredConstructionSourceExamples) => { p.examples[0]![1] = 999; },
      (p: StoredConstructionSourceExamples) => { (p.examples[0]![3] as number[])[0] = 999; resign(p); },
      (p: StoredConstructionSourceExamples) => { p.roles.push(cold(p.roles[0]!)); resign(p); },
      (p: StoredConstructionSourceExamples) => { p.roles.reverse(); resign(p); },
      (p: StoredConstructionSourceExamples) => { p.roles[0]!.push({ slotIndex: 99 }); resign(p); },
      (p: StoredConstructionSourceExamples) => { (p as unknown as Record<string, unknown>).extension = true; }
    ]) {
      const changed = cold(packed); mutate(changed);
      expect(() => decodeConstructionSourceExamples(changed, owner, hasher)).toThrow(/source-example/u);
    }
    expect(() => decodeConstructionSourceExamples({ schema: CONSTRUCTION_SOURCE_EXAMPLE_STORAGE_SCHEMA }, owner, hasher)).toThrow(/source-example/u);
  });

  it("rejects accessors, non-JSON members, sparse arrays and invalid source coordinates before evaluating getters", () => {
    const source = examples(1);
    Object.defineProperty(source[0], "extension", { enumerable: true, get() { throw Error("getter evaluated"); } });
    expect(() => encodeConstructionSourceExamples(source, owner, hasher)).toThrow("invalid construction source-example storage");
    for (const bad of [undefined, NaN, Infinity, -0]) {
      const member = examples(1); member[0]!.extension = bad as JsonValue;
      expect(() => encodeConstructionSourceExamples(member, owner, hasher)).toThrow(/source-example/u);
    }
    expect(() => encodeConstructionSourceExamples(new Array(2), owner, hasher)).toThrow(/source-example/u);
    const invalid = examples(1); invalid[0]!.surfaceEndCodePoint = 0;
    expect(() => encodeConstructionSourceExamples(invalid, owner, hasher)).toThrow(/source-example/u);
  });

  it("passes compact writer data through shared source-owned geometry and restores identical compact bytes", () => {
    const source = examples(32);
    for (let i = 0; i < source.length; i++) source[i]!.roles = [{ slotIndex: 0, occurrenceIndex: 0, startCodePoint: i, endCodePoint: i + 1,
      graphBinding: { relationId: "relation.opaque", roleId: "role.opaque", valueKind: "opaque.entity", qualifiers: { exact: "🧪e\u0301\u0000".repeat(40) } } }];
    const packed = encodeConstructionSourceExamples(source, owner, hasher);
    const pattern = { schema: "scce.language_construction_pattern.v1", storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
      bundle: { ...owner, sourceExamples: packed } };
    const cohort = Array.from({ length: 8 }, () => cold(pattern));
    const normalized = normalizeConstructionRoleGeometry(cohort, "owner.exact", hasher, 4096);
    expect(normalized.pages.length).toBeGreaterThan(0);
    expect(bytes({ values: normalized.values, pages: normalized.pages })).toBeLessThan(bytes({ values: cohort, pages: [] }));
    const pages = new Map(cold(normalized.pages).map(page => [page.id, page]));
    expect(restoreConstructionRoleGeometry(cold(normalized.values[0]), pages, "owner.exact", hasher)).toEqual(pattern);
    const changed = cold(normalized.values[0]) as typeof pattern & Record<string, unknown>;
    (changed[CONSTRUCTION_ROLE_GEOMETRY_KEY] as Record<string, unknown>).logicalDigest = "0".repeat(64);
    expect(() => restoreConstructionRoleGeometry(changed, pages, "owner.exact", hasher)).toThrow(/role geometry/u);
    const changedHeader = cold(normalized.values[0]) as typeof pattern;
    changedHeader.bundle.bindingId = "foreign";
    expect(() => restoreConstructionRoleGeometry(changedHeader, pages, "owner.exact", hasher)).toThrow();
  });

  it("keeps small compact inline cohorts when shared pages and references would grow total storage", () => {
    const source = examples(32), packed = encodeConstructionSourceExamples(source, owner, hasher);
    const pattern = { schema: "scce.language_construction_pattern.v1", storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
      bundle: { ...owner, sourceExamples: packed } };
    const normalized = normalizeConstructionRoleGeometry([pattern], "owner.small", hasher, 4096);
    expect(normalized).toEqual({ values: [pattern], pages: [] });
    expect(decodeConstructionSourceExamples((normalized.values[0] as typeof pattern).bundle.sourceExamples, owner, hasher)).toEqual(source);
  });

  it("uses compact storage in production compilation and hydrates the identical source-owned semantic bundle", () => {
    const ids = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true, namespace: "example-storage" });
    const text = "🧪甲 f9 🦉乙。\n🧪丙 f9 🦉丁。", sourceVersionId = "source.exact" as SourceVersionId;
    const data = new TextEncoder().encode(text), contentHash = ids.contentHash(data), sourceId = ids.sourceId("fixture", "fixture://exact");
    const evidence: EvidenceSpan = { id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd: data.byteLength, spanHash: contentHash }),
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd: data.byteLength, chunkHash: contentHash }), sourceId, sourceVersionId, contentHash,
      mediaType: "text/plain", byteStart: 0, byteEnd: data.byteLength, charStart: 17, charEnd: 17 + [...text].length, text, textPreview: text,
      languageHints: {}, scriptHints: {}, trustVector: { forceClass: "profile_excerpt_evidence" }, provenance: {}, features: [], status: "promoted", alpha: 0.9, observedAt: 1 };
    const input = { bindingId: "relation.exact", profileId: "profile.exact", evidence: [evidence], hasher, updatedAt: 1,
      observations: [0, 10].map(start => ({ sourceVersionId: String(sourceVersionId), evidenceId: String(evidence.id), surfaceStartCodePoint: start,
        surfaceEndCodePoint: start + 9, roles: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: 2 }, { slotIndex: 1, startCodePoint: 3, endCodePoint: 5 },
          { slotIndex: 2, startCodePoint: 6, endCodePoint: 8 }] })) };
    const full = compileLanguageConstructionPattern(input), compact = compileLanguageConstructionPattern({ ...input, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
    expect(full.status).toBe("compiled"); expect(compact.status).toBe("compiled");
    if (compact.status !== "compiled" || full.status !== "compiled") throw Error("fixture compiler failed");
    const root = compact.pattern.patternJson as Record<string, JsonValue>, bundle = root.bundle as Record<string, JsonValue>;
    expect((bundle.sourceExamples as Record<string, JsonValue>).schema).toBe(CONSTRUCTION_SOURCE_EXAMPLE_STORAGE_SCHEMA);
    expect(compact.bundle).toEqual(full.bundle);
    expect(compact.pattern.id).toBe(full.pattern.id);
    const oracle = cold(compact.pattern), oracleBundle = (oracle.patternJson as Record<string, JsonValue>).bundle as Record<string, JsonValue>;
    oracleBundle.sourceExamples = decodeConstructionSourceExamples(bundle.sourceExamples, bundle, hasher);
    const compactHydrated = hydrateLanguageConstructionPatterns({ patterns: [cold(compact.pattern)], evidence: [evidence], hasher });
    expect(compactHydrated.rejected).toEqual([]);
    expect(compactHydrated).toEqual(hydrateLanguageConstructionPatterns({ patterns: [oracle], evidence: [evidence], hasher }));
    expect(compactHydrated).toEqual(hydrateLanguageConstructionPatterns({ patterns: [cold(full.pattern)], evidence: [evidence], hasher }));
    const normalized = normalizeConstructionRoleGeometry([cold(compact.pattern.patternJson)], "source.exact", hasher, 1024);
    const restored = restoreConstructionRoleGeometry(normalized.values[0], new Map(normalized.pages.map(page => [page.id, page])), "source.exact", hasher);
    expect(hydrateLanguageConstructionPatterns({ patterns: [{ ...compact.pattern, patternJson: restored as JsonValue }], evidence: [evidence], hasher })).toEqual(compactHydrated);
    for (const sourceDeclared of [false, true]) for (const requestDeclared of [false, true]) {
      const binding = { relationId: "relation.opaque", roleId: "role.opaque", valueKind: "opaque.entity" };
      const observations: SourceBoundConstructionObservation[] = input.observations.map(observation => ({ ...observation,
        roles: observation.roles.map((role, i) => ({ ...role, ...(sourceDeclared && i === 0 ? { graphBinding: binding } : {}) })),
        nullRoles: [{ slotIndex: 3, ...(requestDeclared ? { graphBinding: binding } : {}) }] }));
      const declaredInput = { ...input, observations };
      const declaredFull = compileLanguageConstructionPattern(declaredInput);
      const declaredCompact = compileLanguageConstructionPattern({ ...declaredInput, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
      if (declaredFull.status !== "compiled" || declaredCompact.status !== "compiled") throw Error("declaration fixture compiler failed");
      const header = requestSeedLanguagePattern(declaredCompact.pattern), headerJson = header.patternJson as Record<string, JsonValue>;
      expect(headerJson.sourceConstructionCandidate).toBe(sourceDeclared);
      expect(headerJson.requestConstructionCandidate).toBe(requestDeclared);
      expect(header).toEqual(requestSeedLanguagePattern(declaredFull.pattern));
      const geometry = normalizeConstructionRoleGeometry([declaredCompact.pattern.patternJson], "owned.flags", hasher, 4096);
      expect(requestSeedLanguagePattern({ ...declaredCompact.pattern, patternJson: geometry.values[0] as JsonValue })).toEqual(header);
      expect(hydrateLanguageConstructionPatterns({ patterns: [cold(declaredCompact.pattern)], evidence: [evidence], hasher }).bundles).toEqual([declaredFull.bundle]);
    }
    const conversationInput = { ...input, bindingId: "surface.conversational_act.binding.opaque",
      observations: [{ ...input.observations[1]!, antecedent: { startCodePoint: 0, endCodePoint: 9 } }] };
    const conversationFull = compileLanguageConstructionPattern(conversationInput);
    const conversationCompact = compileLanguageConstructionPattern({ ...conversationInput, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
    if (conversationFull.status !== "compiled" || conversationCompact.status !== "compiled") throw Error("conversation fixture compiler failed");
    expect(requestSeedLanguagePattern(conversationCompact.pattern)).toEqual(requestSeedLanguagePattern(conversationFull.pattern));
    expect((requestSeedLanguagePattern(conversationCompact.pattern).patternJson as Record<string, JsonValue>).conversationalBindingId).toBe(conversationInput.bindingId);
  });
});
