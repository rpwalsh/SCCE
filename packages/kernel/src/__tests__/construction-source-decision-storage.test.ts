// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { constructionSourceDecisionPageId, createConstructionSourceDecisionRestorer, normalizeConstructionSourceDecisions,
  restoreConstructionSourceDecision, validateConstructionSourceDecisionPage, type ConstructionSourceDecisionPage } from "../construction-source-decision-storage.js";
import { constructionSourceExampleStorageJson as exactJson, encodeConstructionSourceExamples } from "../construction-source-example-storage.js";
import { createHasher } from "../primitives.js";
import { requestSeedLanguagePattern } from "../request-language-hydration.js";
import { compileLanguageConstructionPattern, hydrateLanguageConstructionPatterns, SOURCE_EXAMPLE_CONSTRUCTION_STORAGE } from "../language-construction-memory.js";
import type { EvidenceSpan, JsonValue } from "../types.js";
import type { LanguagePatternRecord } from "../storage.js";

const hasher = createHasher(), ownerKey = hasher.digestHex("complete.compiler.input"), namespace = hasher.digestHex("exact.label.owned"), cold = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
function evidence(index: number): EvidenceSpan {
  const text = (index ? "🦉乙 f9 甲。\n" : "🧪甲 f9 乙。\n").repeat(64);
  return { id: `evidence.${index}`, sourceId: "source.owned", sourceVersionId: "version.owned", contentHash: `sha256_${hasher.digestHex(text)}`,
    charStart: index * 1000, charEnd: index * 1000 + [...text].length, byteStart: index * 10000, byteEnd: index * 10000 + Buffer.byteLength(text), text } as EvidenceSpan;
}
const sources = [evidence(0), evidence(1)];
function fixture(count = 32, compact = true, observations = 32) {
  return Array.from({ length: count }, (_, i) => {
    const selected = i % 3 === 0 ? sources : [sources[i % 2]!];
    const contentDigest = hasher.digestHex(`bundle.${i}`);
    const header = { schema: "scce.language_construction_pattern.v1", id: `surface.construction.bundle.${contentDigest}`, contentDigest,
      bindingId: `language.source_relation.${hasher.digestHex(`binding.${i}`).slice(0, 32)}`, sourceProfileId: "profile.owned", targetProfileId: "profile.owned",
      sourceVersionIds: ["version.owned"], evidenceIds: selected.map(e => String(e.id)).sort(), evidenceContentHashes: [...new Set(selected.map(e => String(e.contentHash)))].sort(), acquisitionStatus: "source_observed" };
    const examples = Array.from({ length: observations }, (_, occurrence) => ({ evidenceIndex: occurrence % selected.length, surfaceStartCodePoint: occurrence * 9,
      surfaceEndCodePoint: occurrence * 9 + 7, roles: [{ slotIndex: 0, occurrenceIndex: 0, startCodePoint: 0, endCodePoint: 2 },
        { slotIndex: 1, occurrenceIndex: 0, startCodePoint: 3, endCodePoint: 5 }, { slotIndex: 2, occurrenceIndex: 0, startCodePoint: 6, endCodePoint: 7 }],
      ...(occurrence % 5 === 0 ? { nullRoles: [] } : {}) }));
    return { schema: "scce.language_construction_pattern.v1", storageEncoding: "scce.language_construction.source_examples.v1", contentDigest,
      sourceCompilationId: ownerKey, sourceSystem: "dialogue", ...(i % 5 === 0 ? { sourceConstructionCandidate: true } : {}),
      opaqueMetadata: { literal: "🧪e\u0301\u0000\n" }, bundle: { ...header, sourceExamples: compact ? encodeConstructionSourceExamples(examples, header, hasher) : examples } };
  });
}
function normalized(patterns: readonly unknown[], maxPageBytes = 8192) {
  return normalizeConstructionSourceDecisions(patterns, { ownerKey, namespace, evidence: sources, hasher, maxPageBytes });
}
function record(patternJson: unknown): LanguagePatternRecord {
  const digest = (patternJson as { contentDigest: string }).contentDigest;
  return { id: `surface.construction.bundle.${digest}`, profileId: "profile.owned", patternKind: "semantic_role", support: 0.5, entropy: 0,
    evidenceIds: [], updatedAt: 1, patternJson: patternJson as JsonValue };
}
function resign(page: ConstructionSourceDecisionPage) {
  page.digest = hasher.digestHex(exactJson({ kind: page.kind, ownerKey: page.ownerKey, namespace: page.namespace, payload: page.payload }));
  page.id = `construction.source_decisions.${page.digest}`;
}

describe("source-owned construction decision pages", () => {
  it("keeps page-fitting inspection near linear as a fixed-cap cohort grows 1x, 2x and 4x", () => {
    const work = [64, 128, 256].map(count => {
      let hashes = 0, inspectedBindings = 0, maximumProbe = 0;
      const measured = { ...hasher, digestHex(value: string | Uint8Array) {
        const material = typeof value === "string" && value.startsWith("{") ? JSON.parse(value) as { payload?: { bindings?: unknown[] } } : undefined;
        if (Array.isArray(material?.payload?.bindings)) {
          hashes++; inspectedBindings += material.payload.bindings.length; maximumProbe = Math.max(maximumProbe, material.payload.bindings.length);
        }
        return hasher.digestHex(value);
      } };
      const patterns = fixture(count, false, 8), result = normalizeConstructionSourceDecisions(patterns,
        { ownerKey, namespace, evidence: sources, hasher: measured, maxPageBytes: 4096 });
      expect(result.pages.length).toBeGreaterThan(4);
      expect(result.pages.every(page => bytes(page) <= 4096)).toBe(true);
      const largestPage = Math.max(...result.pages.map(page => page.payload.bindings.length));
      expect(maximumProbe).toBeLessThanOrEqual(2 * (largestPage + 1));
      expect(inspectedBindings).toBeLessThan(count * 20);
      const restore = createConstructionSourceDecisionRestorer(new Map(result.pages.map(page => [page.id, page])), ownerKey, hasher, 4096);
      expect(result.patterns.map(restore)).toEqual(patterns);
      return { hashes, inspectedBindings };
    });
    for (let index = 1; index < work.length; index++) {
      expect(work[index]!.inspectedBindings).toBeLessThan(work[index - 1]!.inspectedBindings * 2.5);
      expect(work[index]!.hashes).toBeLessThan(work[index - 1]!.hashes * 2.5);
    }
  });

  it("cold restores every complete compact bundle, original identity, Unicode, query hint and observation order within byte caps", () => {
    const patterns = fixture(48, true, 32), before = cold(patterns), result = normalized(patterns);
    expect(patterns).toEqual(before);
    expect(result.pages.length).toBeGreaterThan(1);
    expect(result.pages.every(page => bytes(page) <= 8192)).toBe(true);
    expect(bytes(result)).toBeLessThan(bytes({ patterns, pages: [] }));
    const restore = createConstructionSourceDecisionRestorer(new Map(cold(result.pages).map(page => [page.id, page])), ownerKey, hasher, 8192);
    expect(result.patterns.map(pattern => restore(cold(pattern)))).toEqual(patterns);
    for (let i = 0; i < patterns.length; i++) {
      expect(requestSeedLanguagePattern(record(result.patterns[i]))).toEqual(requestSeedLanguagePattern(record(patterns[i])));
      const physical = result.patterns[i] as { bundle: Record<string, unknown> };
      expect(Object.keys(physical.bundle).sort()).toEqual(["ordinal", "pageId", "schema"]);
    }
  });

  it("is deterministic across input ordering and preserves duplicate input positions without duplicating immutable binding slots", () => {
    const patterns = fixture(16, false, 16), first = normalized(patterns, 16384), reversed = normalized([...patterns].reverse(), 16384);
    expect(reversed.pages).toEqual(first.pages);
    expect(reversed.patterns).toEqual([...first.patterns].reverse());
    const duplicate = normalized([...patterns, patterns[0]!], 16384);
    expect(duplicate.pages).toEqual(first.pages);
    expect(duplicate.patterns.at(-1)).toEqual(duplicate.patterns[0]);
    const restore = createConstructionSourceDecisionRestorer(new Map(duplicate.pages.map(page => [page.id, page])), ownerKey, hasher);
    expect(duplicate.patterns.map(restore)).toEqual([...patterns, patterns[0]]);
  });

  it("keeps an individually oversized exact decision inline while sharing the rest of the cohort losslessly", () => {
    const patterns = fixture(32, false, 8) as Array<Record<string, unknown>>;
    (patterns[0]!.bundle as Record<string, unknown>).oversizedExactDecision = "x".repeat(8192);
    const result = normalized(patterns, 4096);
    expect(result.pages.length).toBeGreaterThan(0);
    expect(result.pages.every(page => bytes(page) <= 4096)).toBe(true);
    expect(constructionSourceDecisionPageId(result.patterns[0])).toBeUndefined();
    const restore = createConstructionSourceDecisionRestorer(new Map(cold(result.pages).map(page => [page.id, page])), ownerKey, hasher, 4096);
    expect(result.patterns.map(pattern => restore(cold(pattern)))).toEqual(patterns);
  });

  it("gives identical bodies in different exact label namespaces different immutable IDs", () => {
    const patterns = fixture(16, false, 16), first = normalized(patterns, 32768);
    const other = normalizeConstructionSourceDecisions(patterns, { ownerKey, namespace: hasher.digestHex("exact.label.foreign"), evidence: sources, hasher, maxPageBytes: 32768 });
    expect(other.pages.map(page => page.payload)).toEqual(first.pages.map(page => page.payload));
    expect(other.pages.every(page => !first.pages.some(original => original.id === page.id))).toBe(true);
    expect(() => createConstructionSourceDecisionRestorer(new Map(other.pages.map(page => [page.id, page])), ownerKey, hasher)(first.patterns[0])).toThrow(/source-owned construction/u);
    const changed = cold(first.pages[0]!); changed.namespace = other.pages[0]!.namespace;
    expect(() => validateConstructionSourceDecisionPage(changed, ownerKey, hasher)).toThrow(/source-owned construction/u);
  });

  it("preserves optional presence, graph declarations, null roles, padded extents, antecedents and opaque extension keys", () => {
    const patterns = fixture(24, false, 16) as Array<Record<string, unknown>>;
    for (const pattern of patterns) {
      const examples = (pattern.bundle as { sourceExamples: Array<Record<string, unknown>> }).sourceExamples;
      for (let i = 0; i < examples.length; i++) {
        const example = examples[i]!, roles = example.roles as Array<Record<string, unknown>>;
        delete roles[0]!.occurrenceIndex;
        roles[0]!.graphBinding = { relationId: "relation.opaque", roleId: "role.opaque", valueKind: "entity", qualifiers: { literal: "e\u0301\u0000🧪" } };
        Object.defineProperty(roles[0], "__proto__", { enumerable: true, value: { literal: "preserved" } });
        example.surfaceEndCodePoint = (example.surfaceEndCodePoint as number) + 1;
        example.nullRoles = i % 2 ? [] : [{ slotIndex: 3, graphBinding: { relationId: "r", roleId: "v", valueKind: "opaque" } }];
        example.antecedent = { startCodePoint: 0, endCodePoint: 2 };
        example.contextualQaSupervision = { opaque: [null, false, "", "🧪\u0000"] };
      }
    }
    const result = normalized(patterns, 32768);
    expect(result.pages.length).toBeGreaterThan(0);
    const restore = createConstructionSourceDecisionRestorer(new Map(cold(result.pages).map(page => [page.id, page])), ownerKey, hasher);
    expect(result.patterns.map(restore)).toEqual(patterns);
    expect(({} as Record<string, unknown>).literal).toBeUndefined();
  });

  it("validates and snapshots a shared page once while restoring only requested bindings", () => {
    const patterns = fixture(24, false, 8), result = normalized(patterns, 32768), firstId = constructionSourceDecisionPageId(result.patterns[0])!;
    const selected = result.patterns.map((value, i) => ({ value, i })).filter(({ value }) => constructionSourceDecisionPageId(value) === firstId);
    expect(selected.length).toBeGreaterThan(1);
    let hashes = 0;
    const measured = { ...hasher, digestHex(value: string | Uint8Array) { hashes++; return hasher.digestHex(value); } };
    const pages = new Map(cold(result.pages).map(page => [page.id, page]));
    const restore = createConstructionSourceDecisionRestorer(pages, ownerKey, measured);
    expect(restore(selected[0]!.value)).toEqual(patterns[selected[0]!.i]);
    expect(hashes).toBe(1);
    pages.get(firstId)!.payload.owners[0]!.targetProfileId = "changed-after-snapshot";
    for (const selectedPattern of selected.slice(1)) expect(restore(selectedPattern.value)).toEqual(patterns[selectedPattern.i]);
    expect(hashes).toBe(1);
  });

  it("rejects foreign owners, absent pages, slot swaps, changed roots, changed proofs, malformed references and unknown fields", () => {
    const result = normalized(fixture(24, false, 8), 32768), value = cold(result.patterns[0]) as Record<string, unknown>;
    const id = constructionSourceDecisionPageId(value)!, page = result.pages.find(p => p.id === id)!;
    expect(() => restoreConstructionSourceDecision(value, page, "foreign.compilation", hasher)).toThrow(/source-owned construction/u);
    expect(() => createConstructionSourceDecisionRestorer(new Map(), ownerKey, hasher)(value)).toThrow(/source-owned construction/u);
    for (const mutate of [
      (root: Record<string, unknown>) => { root.contentDigest = "foreign"; },
      (root: Record<string, unknown>) => { root.sourceCompilationId = "foreign"; },
      (root: Record<string, unknown>) => { (root.bundle as Record<string, unknown>).ordinal = 99999; },
      (root: Record<string, unknown>) => { (root.bundle as Record<string, unknown>).schema = "scce.construction_source_decision_ref.v999"; },
      (root: Record<string, unknown>) => { (root.bundle as Record<string, unknown>).extra = true; }
    ]) {
      const changed = cold(value); mutate(changed);
      expect(() => restoreConstructionSourceDecision(changed, page, ownerKey, hasher)).toThrow(/source-owned construction/u);
    }
    for (const mutate of [
      (p: ConstructionSourceDecisionPage) => { p.payload.evidence[0]!.contentHash = "changed"; },
      (p: ConstructionSourceDecisionPage) => { p.payload.observations[0]![2][0] = 99999; resign(p); },
      (p: ConstructionSourceDecisionPage) => { (p.payload as unknown as Record<string, unknown>).extra = true; resign(p); },
      (p: ConstructionSourceDecisionPage) => { p.payload.roleLayouts[0]![0]!.startCodePoint = 0; resign(p); }
    ]) {
      const changed = cold(page); mutate(changed);
      expect(() => validateConstructionSourceDecisionPage(changed, ownerKey, hasher, 32768)).toThrow(/source-owned construction/u);
    }
    expect(() => validateConstructionSourceDecisionPage(page, ownerKey, hasher, 1)).toThrow(/source-owned construction/u);
    expect(() => normalized(result.patterns, 32768)).toThrow(/source-owned construction/u);
    expect(normalized(fixture(1), 1)).toEqual({ patterns: fixture(1), pages: [] });
  });

  it("keeps unrelated families and unprofitable cohorts unchanged, and rejects invalid source ownership without invoking getters", () => {
    const unrelated = [{ schema: "unrelated", opaque: "🧪\u0000" }];
    expect(normalized(unrelated)).toEqual({ patterns: unrelated, pages: [] });
    const small = fixture(1, true, 1);
    expect(normalized(small, 32768)).toEqual({ patterns: small, pages: [] });
    const invalid = cold(sources); invalid[0]!.contentHash = "foreign" as EvidenceSpan["contentHash"];
    expect(() => normalizeConstructionSourceDecisions(fixture(), { ownerKey, namespace, evidence: invalid, hasher, maxPageBytes: 32768 })).toThrow(/source-owned construction/u);
    const unsafe = fixture() as Array<Record<string, unknown>>;
    Object.defineProperty(unsafe[0], "extension", { enumerable: true, get() { throw Error("getter evaluated"); } });
    expect(() => normalized(unsafe)).toThrow("invalid source-owned construction decisions");
    const unsafeEvidence = [...sources];
    unsafeEvidence[0] = { ...sources[0]!, get text(): string { throw Error("getter evaluated"); } };
    expect(() => normalizeConstructionSourceDecisions(fixture(), { ownerKey, namespace, evidence: unsafeEvidence, hasher, maxPageBytes: 32768 })).toThrow("invalid source-owned construction decisions");
  });

  it("restores real compiled source-owned programs and their query headers before the existing cold verifier runs", () => {
    const evidence = { ...sources[0]!, status: "promoted" as const, alpha: 0.9, observedAt: 1 };
    const compiled = Array.from({ length: 16 }, (_, i) => compileLanguageConstructionPattern({
      bindingId: `language.source_relation.${hasher.digestHex(`compiled.${i}`).slice(0, 32)}`, profileId: "profile.owned", evidence: [evidence], hasher, updatedAt: 1,
      storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE, observations: [0, 9, 18, 27].map(start => ({ sourceVersionId: String(evidence.sourceVersionId), evidenceId: String(evidence.id),
        surfaceStartCodePoint: start, surfaceEndCodePoint: start + 7, roles: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: 2 },
          { slotIndex: 1, startCodePoint: 3, endCodePoint: 5 }, { slotIndex: 2, startCodePoint: 6, endCodePoint: 7 }] }))
    }));
    const patterns = compiled.map(result => { if (result.status !== "compiled") throw Error(JSON.stringify(result.issues)); return { ...result.pattern,
      patternJson: { ...(result.pattern.patternJson as Record<string, JsonValue>), sourceCompilationId: ownerKey } }; });
    const result = normalizeConstructionSourceDecisions(patterns.map(pattern => pattern.patternJson), { ownerKey, namespace, evidence: [evidence], hasher, maxPageBytes: 32768 });
    expect(result.pages.length).toBeGreaterThan(0);
    const restore = createConstructionSourceDecisionRestorer(new Map(cold(result.pages).map(page => [page.id, page])), ownerKey, hasher);
    const restored = patterns.map((pattern, i) => ({ ...pattern, patternJson: restore(cold(result.patterns[i])) as JsonValue }));
    expect(restored).toEqual(patterns);
    expect(restored.map(requestSeedLanguagePattern)).toEqual(patterns.map(requestSeedLanguagePattern));
    const coldState = hydrateLanguageConstructionPatterns({ patterns: restored, evidence: [evidence], hasher });
    expect(coldState.rejected).toEqual([]);
    expect(coldState).toEqual(hydrateLanguageConstructionPatterns({ patterns, evidence: [evidence], hasher }));
  });
});
