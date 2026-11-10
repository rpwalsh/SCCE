// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
  CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA,
  UNIVERSAL_CREATIVE_EVENT_COMPILER_ID,
  LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
  SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
  OBSOLETE_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2,
  compileUniversalCreativeEventConstructionPattern,
  compileLanguageConstructionPattern,
  compileLanguageConstructionPatterns,
  hydrateLanguageConstructionPatterns
} from "../language-construction-memory.js";
import { cloneLanguageMemoryRuntimeState, createLanguageMemoryRuntime, peekLanguageMemoryConstructionState, scopeLanguageMemoryStateToCluster, scopeLanguageMemoryStateToLanguage } from "../language-memory-runtime.js";
import { estimateRetainedProgramBytes } from "../retained-program-size.js";
import { normalizeConstructionRoleGeometry, restoreConstructionRoleGeometry } from "../construction-role-geometry-storage.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { LanguageProfileCluster } from "../language.js";
import type { LanguagePatternRecord } from "../storage.js";
import type { EvidenceSpan, JsonValue, LanguageProfile, SourceVersionId } from "../types.js";

const hasher = createHasher();
const clock = createClock({ fixedTime: 91_000, stepMs: 1 });
const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "construction-memory" });

describe("durable language-construction memory", () => {
  it("defers canonical construction verification through request setup, then memoizes exact source-owned programs", () => {
    const evidence = evidenceSpan("source.lazy", "🧪甲 f9 🦉乙。\n🧪丙 f9 🦉丁。", 17);
    const compiled = compileLanguageConstructionPattern({ bindingId: "relation.lazy", profileId: "profile.lazy", evidence: [evidence], hasher,
      updatedAt: 91_500, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE,
      observations: [0, 10].map(start => ({ sourceVersionId: String(evidence.sourceVersionId), evidenceId: String(evidence.id),
        surfaceStartCodePoint: start, surfaceEndCodePoint: start + 9,
        roles: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: 2 }, { slotIndex: 1, startCodePoint: 3, endCodePoint: 5 }, { slotIndex: 2, startCodePoint: 6, endCodePoint: 8 }] })) });
    expect(compiled.status).toBe("compiled");
    if (compiled.status !== "compiled") throw new Error("source compiler failed");
    const patterns = [structuredClone(compiled.pattern)];
    const expected = hydrateLanguageConstructionPatterns({ patterns, evidence: [evidence], hasher });
    let digests = 0;
    const measuredHasher = { ...hasher, digestHex: (...args: Parameters<typeof hasher.digestHex>) => { digests++; return hasher.digestHex(...args); } };
    const runtime = createLanguageMemoryRuntime({ hasher: measuredHasher });
    const state = runtime.hydrateFromImportedBrain({ models: [], observations: [], units: [], patterns, constructionEvidence: [evidence] });
    const overlaid = cloneLanguageMemoryRuntimeState(state, { closedClass: ["f9"] });
    const scoped = scopeLanguageMemoryStateToLanguage(overlaid, "language.lazy", { profile: () => "language.lazy", corpus: () => "language.lazy" });
    const request = cloneLanguageMemoryRuntimeState(scoped, { importedPatterns: [...scoped.importedPatterns] });
    expect(request.scope.mode).toBe("language");
    expect(request.scope.purityProven).toBe(true);
    expect(request.importedUnits).toEqual([]);
    expect(digests).toBe(0);
    expect(peekLanguageMemoryConstructionState(request).bundles).toBeUndefined();
    expect(estimateRetainedProgramBytes(peekLanguageMemoryConstructionState(request).roots)).toBeGreaterThan(0);
    expect(digests).toBe(0);
    evidence.text = evidence.text.replace("甲", "戊");
    (patterns[0]!.patternJson as Record<string, JsonValue>).contentDigest = "forged-after-hydration";
    const bundles = request.importedConstructionBundles;
    expect(bundles).toEqual(expected.bundles);
    const compiledDigests = digests;
    expect(compiledDigests).toBeGreaterThan(0);
    expect(request.importedConstructionBundles).toBe(bundles);
    expect(request.rejectedConstructionPatterns).toEqual([]);
    expect(request.scope.profileIds).toEqual(["profile.lazy"]);
    expect(request.scope.sourceVersionIds).toEqual(["source.lazy"]);
    expect(digests).toBe(compiledDigests);
    const foreign = scopeLanguageMemoryStateToLanguage(state, "language.foreign", { profile: () => "language.lazy", corpus: () => "language.lazy" });
    expect(foreign.importedConstructionBundles).toEqual([]);
    expect(foreign.importedLanguagePriorCount).toBe(0);
    const mutated = runtime.hydrateFromImportedBrain({ models: [], observations: [], units: [], patterns, constructionEvidence: [evidence] });
    expect(mutated.importedConstructionBundles).toEqual([]);
    const rejectedDigests = digests;
    expect(mutated.rejectedConstructionPatterns).not.toEqual([]);
    expect(mutated.importedConstructionBundles).toEqual([]);
    expect(digests).toBe(rejectedDigests);
  });
  it("shares source coordinates across a streaming batch without retaining stale source or profile state", () => {
    const evidence = evidenceSpan("source.batch", "🧪甲 f9 🦉乙。", 17);
    const observations = [{ sourceVersionId: String(evidence.sourceVersionId), evidenceId: String(evidence.id),
      surfaceStartCodePoint: 0, surfaceEndCodePoint: 9,
      roles: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: 2 }, { slotIndex: 1, startCodePoint: 3, endCodePoint: 5 }, { slotIndex: 2, startCodePoint: 6, endCodePoint: 8 }] }];
    const shared = { profileId: "profile.batch", evidence: [evidence], hasher, updatedAt: 91_500, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE };
    const sets = ["relation.甲", "relation.乙", "relation.丙"].map(bindingId => ({ bindingId, observations }));
    const expected = sets.map(set => compileLanguageConstructionPattern({ ...shared, ...set }));
    let reads = 0;
    let text = evidence.text;
    const observed = { ...evidence, get text() { reads++; return text; } };
    const iterator = compileLanguageConstructionPatterns({ ...shared, evidence: [observed], sets });
    expect(reads).toBe(0);
    const first = iterator.next();
    text = text.replace("甲", "丁");
    expect([first.value, ...iterator]).toEqual(expected);
    expect(reads).toBe(1);
    const changed = [...compileLanguageConstructionPatterns({ ...shared, profileId: "profile.other", evidence: [observed], sets })];
    expect(reads).toBe(2);
    expect(changed).toEqual(sets.map(set => compileLanguageConstructionPattern({ ...shared, profileId: "profile.other", evidence: [{ ...evidence, text }], ...set })));
    expect(changed[0]).not.toEqual(expected[0]);
    reads = 0;
    text = evidence.text;
    const patterns = expected.flatMap(result => result.status === "compiled" ? [result.pattern] : []);
    expect(hydrateLanguageConstructionPatterns({ patterns, evidence: [observed], hasher }).rejected).toEqual([]);
    expect(reads).toBe(1);
    text = text.replace("甲", "丁");
    expect(hydrateLanguageConstructionPatterns({ patterns, evidence: [observed], hasher }).bundles).toEqual([]);
    expect(reads).toBe(2);
    const wrongOwner = { ...sets[0]!, observations: [{ ...observations[0]!, sourceVersionId: "source.foreign" }] };
    const wrongRange = { ...sets[0]!, observations: [{ ...observations[0]!, surfaceEndCodePoint: 90 }] };
    expect([...compileLanguageConstructionPatterns({ ...shared, sets: [wrongOwner, wrongRange] })].map(result => result.status)).toEqual(["rejected", "rejected"]);
  });

  it("rehydrates versioned source-example references into exactly the same programs and source identities as legacy storage", () => {
    const evidence = evidenceSpan("source.compact", "🧪甲 f9 🦉乙。\n🧪丙 f9 🦉丁。", 17);
    const observations = [0, 10].map(start => ({ sourceVersionId: String(evidence.sourceVersionId), evidenceId: String(evidence.id),
      surfaceStartCodePoint: start, surfaceEndCodePoint: start + 9,
      roles: [{ slotIndex: 0, startCodePoint: 0, endCodePoint: 2 }, { slotIndex: 1, startCodePoint: 3, endCodePoint: 5 }, { slotIndex: 2, startCodePoint: 6, endCodePoint: 8 }] }));
    const input = { bindingId: "relation.compact", profileId: "profile.compact", observations, evidence: [evidence], hasher, updatedAt: 91_500 };
    const legacy = compileLanguageConstructionPattern(input);
    const compact = compileLanguageConstructionPattern({ ...input, storageEncoding: SOURCE_EXAMPLE_CONSTRUCTION_STORAGE });
    expect(legacy.status).toBe("compiled");
    expect(compact.status).toBe("compiled");
    if (legacy.status !== "compiled" || compact.status !== "compiled") return;
    expect(compact.bundle).toEqual(legacy.bundle);
    expect(compact.pattern.id).toBe(legacy.pattern.id);
    expect(compact.pattern.evidenceIds).toEqual(legacy.pattern.evidenceIds);
    expect(JSON.stringify(compact.pattern.patternJson).length).toBeLessThan(JSON.stringify(legacy.pattern.patternJson).length);
    const compactBody = (compact.pattern.patternJson as { bundle: Record<string, JsonValue> }).bundle;
    expect(compactBody).not.toHaveProperty("constructions");
    expect(compactBody).not.toHaveProperty("formClasses");
    expect(hydrateLanguageConstructionPatterns({ patterns: [compact.pattern], evidence: [evidence], hasher }).bundles).toEqual([legacy.bundle]);
    expect(hydrateLanguageConstructionPatterns({ patterns: [legacy.pattern], evidence: [evidence], hasher }).bundles).toEqual([legacy.bundle]);
    const stored = normalizeConstructionRoleGeometry([compact.pattern.patternJson], "owned.compilation", hasher, 4096);
    const pages = new Map<string, typeof stored.pages[number]>(JSON.parse(JSON.stringify(stored.pages)).map((page: typeof stored.pages[number]) => [page.id, page]));
    const restored = restoreConstructionRoleGeometry(JSON.parse(JSON.stringify(stored.values[0])), pages, "owned.compilation", hasher) as JsonValue;
    expect(restored).toEqual(compact.pattern.patternJson);
    expect(hydrateLanguageConstructionPatterns({ patterns: [{ ...compact.pattern, patternJson: restored }], evidence: [evidence], hasher }).bundles).toEqual([legacy.bundle]);
    const tampered = structuredClone(compact.pattern);
    (tampered.patternJson as { bundle: { formClasses?: JsonValue[] } }).bundle.formClasses = [];
    expect(hydrateLanguageConstructionPatterns({ patterns: [tampered], evidence: [evidence], hasher }).bundles).toEqual([]);
  });
  it("reads each owned Unicode source once per compilation while preserving exact observation and antecedent records", () => {
    const request = "🤖？";
    const surfaces = Array.from({ length: 128 }, (_, index) => `🧪甲${index} f9 乙${index}。`);
    const text = surfaces.map(surface => `${request}\n${surface}`).join("\n");
    const evidence = evidenceSpan("source.coordinate-budget", text, 17);
    let offset = 0;
    const observations = surfaces.map((surface, index) => {
      const subject = `🧪甲${index}`;
      const start = offset + [...request].length + 1;
      const result = { sourceVersionId: String(evidence.sourceVersionId), evidenceId: String(evidence.id),
        surfaceStartCodePoint: start, surfaceEndCodePoint: start + [...surface].length,
        antecedent: { startCodePoint: offset, endCodePoint: offset + [...request].length },
        roles: [
          { slotIndex: 0, startCodePoint: 0, endCodePoint: [...subject].length },
          { slotIndex: 1, startCodePoint: [...subject].length + 1, endCodePoint: [...subject].length + 3 },
          { slotIndex: 2, startCodePoint: [...subject].length + 4, endCodePoint: [...surface].length - 1 }
        ] };
      offset = result.surfaceEndCodePoint + 1;
      return result;
    });
    const input = { bindingId: "relation.coordinate-budget", profileId: "profile.coordinate-budget", observations, hasher, updatedAt: 91_500 };
    const expected = compileLanguageConstructionPattern({ ...input, evidence: [evidence] });
    let reads = 0;
    let currentText = text;
    const observed = { ...evidence, get text() { reads++; return currentText; } };
    const compiled = compileLanguageConstructionPattern({ ...input, evidence: [observed] });
    expect(compiled.status).toBe("compiled");
    expect(compiled).toEqual(expected);
    expect(reads).toBe(1);
    if (compiled.status !== "compiled") return;
    expect(compiled.bundle.sourceExamples.every(example => example.antecedent?.surface === request)).toBe(true);
    currentText = text.replace("🤖", "🦉");
    expect(hydrateLanguageConstructionPatterns({ patterns: [compiled.pattern], evidence: [observed], hasher }).bundles).toEqual([]);
  });

  it("restarts from an exact evidence-bound Unicode/code-point record", () => {
    const evidence = evidenceSpan("source.jp", "🧪\n東京は日本。", 17);
    const compiled = compile(evidence, "profile.jp", "relation.location", {
      surfaceStartCodePoint: 2,
      surfaceEndCodePoint: 8,
      roles: [
        { slotIndex: 0, startCodePoint: 0, endCodePoint: 2 },
        { slotIndex: 1, startCodePoint: 2, endCodePoint: 3 },
        { slotIndex: 2, startCodePoint: 3, endCodePoint: 5 }
      ]
    });

    expect(compiled.status).toBe("compiled");
    if (compiled.status !== "compiled") return;
    const restarted = createLanguageMemoryRuntime({ hasher }).hydrate({
      models: [],
      observations: [],
      units: [],
      patterns: [compiled.pattern],
      semanticFrames: [],
      constructionEvidence: [evidence]
    });

    expect(restarted.importedPatterns).toEqual([]);
    expect(restarted.importedConstructionBundles).toHaveLength(1);
    expect(restarted.importedConstructionBundles[0]).toMatchObject({
      id: compiled.bundle.id,
      bindingId: "relation.location",
      sourceProfileId: "profile.jp",
      targetProfileId: "profile.jp",
      sourceVersionIds: ["source.jp"],
      evidenceIds: [String(evidence.id)]
    });
    expect(restarted.importedConstructionBundles[0]?.sourceExamples[0]).toMatchObject({
      evidenceCharStart: 17,
      evidenceCharEnd: 25,
      surfaceStartCodePoint: 2,
      surfaceEndCodePoint: 8,
      surface: "東京は日本。"
    });
    expect(restarted.rejectedConstructionPatterns).toEqual([]);
  });

  it("rejects a bundle atomically when evidence is missing after restart", () => {
    const evidence = evidenceSpan("source.a", "Aster powers pump.", 0);
    const compiled = compiledPattern(evidence);

    const hydrated = hydrateLanguageConstructionPatterns({
      patterns: [compiled],
      evidence: [],
      hasher
    });

    expect(hydrated.bundles).toEqual([]);
    expect(hydrated.constructions).toEqual([]);
    expect(hydrated.formClasses).toEqual([]);
    expect(hydrated.rejected).toEqual([expect.objectContaining({
      patternId: compiled.id,
      code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence
    })]);
  });

  it("rejects a tampered or partial member set instead of hydrating a remainder", () => {
    const evidence = evidenceSpan("source.a", "Aster powers pump.", 0);
    const compiled = compiledPattern(evidence);
    const tampered = structuredClone(compiled) as LanguagePatternRecord;
    const patternJson = tampered.patternJson as Record<string, JsonValue>;
    const bundle = patternJson.bundle as Record<string, JsonValue>;
    bundle.formClasses = [];

    const hydrated = hydrateLanguageConstructionPatterns({
      patterns: [tampered],
      evidence: [evidence],
      hasher
    });

    expect(hydrated.bundles).toEqual([]);
    expect(hydrated.constructions).toEqual([]);
    expect(hydrated.formClasses).toEqual([]);
    expect(hydrated.rejected[0]).toMatchObject({ patternId: compiled.id });
    expect([
      LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.digest,
      LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member
    ]).toContain(hydrated.rejected[0]?.code);
  });

  it("rejects mixed source ownership even when an evidence identity is reused", () => {
    const evidence = evidenceSpan("source.a", "Aster powers pump.", 0);
    const compiled = compiledPattern(evidence);
    const mixedEvidence = { ...evidence, sourceVersionId: "source.other" as SourceVersionId };

    const hydrated = hydrateLanguageConstructionPatterns({
      patterns: [compiled],
      evidence: [mixedEvidence],
      hasher
    });

    expect(hydrated.bundles).toEqual([]);
    expect(hydrated.rejected[0]).toMatchObject({
      patternId: compiled.id,
      code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.evidence
    });
  });

  it("excludes same-profile constructions whose source version is outside the selected cluster", () => {
    const evidence = evidenceSpan("source.a", "Aster powers pump.", 0);
    const compiled = compiledPattern(evidence);
    const state = createLanguageMemoryRuntime({ hasher }).hydrate({
      models: [],
      observations: [],
      units: [],
      patterns: [compiled],
      semanticFrames: [],
      constructionEvidence: [evidence]
    });

    const scoped = scopeLanguageMemoryStateToCluster(state, cluster("profile.a", "source.other"));

    expect(scoped.importedConstructionBundles).toEqual([]);
    expect(scoped.importedLanguagePriorCount).toBe(0);
    expect(scoped.scope).toMatchObject({ degraded: true });
  });

  it("does not expose construction schema, identity, or digest through generic pattern generation", () => {
    const evidence = evidenceSpan("source.a", "Aster powers pump.", 0);
    const compiled = compiledPattern(evidence);
    const runtime = createLanguageMemoryRuntime({ hasher });
    const state = runtime.hydrate({
      models: [],
      observations: [],
      units: [],
      patterns: [compiled],
      semanticFrames: [],
      constructionEvidence: [evidence]
    });

    const generated = runtime.generate({
      state,
      contextSymbols: [LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA, compiled.id],
      generationExtent: 32
    });
    const surfaceMaterial = JSON.stringify({
      text: generated.text,
      phrasesUsed: generated.phrasesUsed,
      moves: generated.discourse.moves,
      boundaries: generated.discourse.boundaries
    });

    expect(state.importedPatterns).toEqual([]);
    expect(generated.text).toBe("");
    expect(surfaceMaterial).not.toContain(LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA);
    expect(surfaceMaterial).not.toContain(compiled.id);
    expect(surfaceMaterial).not.toContain(String((compiled.patternJson as Record<string, JsonValue>).contentDigest));
  });
});

describe("source-verified universal creative argument frames", () => {
  const universalCreativeText = [
    "cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
    "cat chased mouse.", "dog chased ball.", "cat chased ball.", "dog chased mouse."
  ].join(" ");

  it("persists and re-verifies a real patient binding without a source sentence body", () => {
    const evidence = evidenceSpan("source.univ", universalCreativeText, 0);
    const compiled = compileUniversalCreativeEventConstructionPattern({
      profileId: "profile.univ",
      evidence: [evidence],
      hasher,
      updatedAt: 91_500
    });

    expect(compiled.status).toBe("compiled");
    if (compiled.status !== "compiled") return;
    const hydrated = hydrateLanguageConstructionPatterns({
      patterns: [compiled.pattern],
      evidence: [evidence],
      hasher
    });
    expect(hydrated.rejected).toEqual([]);
    const event = hydrated.bundles[0]?.creativeEvents
      ?.find(row => row.argumentFrame.bindings.length > 0);
    expect(event?.compilerId).toBe(UNIVERSAL_CREATIVE_EVENT_COMPILER_ID);
    expect(event?.argumentFrame).toMatchObject({
      schema: CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
      roleIds: ["scce.role.agent", "scce.role.patient"]
    });
    const persisted = (compiled.pattern.patternJson as Record<string, JsonValue>).bundle as Record<string, JsonValue>;
    expect(JSON.stringify(persisted)).not.toContain("cat chased mouse");
    for (const binding of event?.argumentFrame.bindings ?? []) {
      expect([...evidence.text].slice(binding.startCodePoint, binding.endCodePoint).join(""))
        .toBe(binding.surface);
    }
  });

  it("rejects a tampered argument binding atomically", () => {
    const evidence = evidenceSpan("source.univ", universalCreativeText, 0);
    const compiled = compileUniversalCreativeEventConstructionPattern({
      profileId: "profile.univ",
      evidence: [evidence],
      hasher,
      updatedAt: 91_500
    });
    if (compiled.status !== "compiled") throw new Error(JSON.stringify(compiled.issues));
    const tampered = structuredClone(compiled.pattern);
    const patternJson = tampered.patternJson as Record<string, JsonValue>;
    const bundle = patternJson.bundle as Record<string, JsonValue>;
    const events = bundle.events as Array<Record<string, JsonValue>>;
    const frame = events[0]?.argumentFrame as Record<string, JsonValue>;
    const bindings = frame.bindings as Array<Record<string, JsonValue>>;
    if (bindings.length) bindings[0]!.surface = "counterfeit";
    else frame.bindings = [{ roleId: "scce.role.patient", surface: "counterfeit", surfaceDigest: "x", startCodePoint: 0, endCodePoint: 1 }];

    const hydrated = hydrateLanguageConstructionPatterns({
      patterns: [tampered],
      evidence: [evidence],
      hasher
    });
    expect(hydrated.bundles).toEqual([]);
    // Digest-first verification: any post-persistence tamper trips the
    // whole-bundle content digest before per-member checks run. Rejection
    // stays atomic; the code names the outermost gate that caught it.
    expect(hydrated.rejected).toEqual([expect.objectContaining({
      code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.digest
    })]);
  });

  it("rejects the incompatible v2 creative schema with an explicit reason", () => {
    const evidence = evidenceSpan("source.univ", universalCreativeText, 0);
    const compiled = compileUniversalCreativeEventConstructionPattern({
      profileId: "profile.univ",
      evidence: [evidence],
      hasher,
      updatedAt: 91_500
    });
    if (compiled.status !== "compiled") throw new Error(JSON.stringify(compiled.issues));
    const obsolete = structuredClone(compiled.pattern);
    const patternJson = obsolete.patternJson as Record<string, JsonValue>;
    const bundle = patternJson.bundle as Record<string, JsonValue>;
    patternJson.schema = OBSOLETE_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2;
    bundle.schema = OBSOLETE_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2;

    const hydrated = hydrateLanguageConstructionPatterns({
      patterns: [obsolete],
      evidence: [evidence],
      hasher
    });
    expect(CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA)
      .not.toBe(OBSOLETE_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2);
    expect(hydrated.bundles).toEqual([]);
    expect(hydrated.rejected).toEqual([expect.objectContaining({
      code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.obsoleteCreativeV2
    })]);
  });
});

function compiledPattern(evidence: EvidenceSpan): LanguagePatternRecord {
  const result = compile(evidence, "profile.a", "relation.power", {
    surfaceStartCodePoint: 0,
    surfaceEndCodePoint: 18,
    roles: [
      { slotIndex: 0, startCodePoint: 0, endCodePoint: 5 },
      { slotIndex: 1, startCodePoint: 6, endCodePoint: 12 },
      { slotIndex: 2, startCodePoint: 13, endCodePoint: 17 }
    ]
  });
  if (result.status !== "compiled") throw new Error(JSON.stringify(result.issues));
  return result.pattern;
}

function compile(
  evidence: EvidenceSpan,
  profileId: string,
  bindingId: string,
  range: {
    surfaceStartCodePoint: number;
    surfaceEndCodePoint: number;
    roles: Array<{ slotIndex: number; startCodePoint: number; endCodePoint: number }>;
  }
) {
  return compileLanguageConstructionPattern({
    bindingId,
    profileId,
    observations: [{
      sourceVersionId: String(evidence.sourceVersionId),
      evidenceId: String(evidence.id),
      ...range
    }],
    evidence: [evidence],
    hasher,
    updatedAt: 91_500
  });
}

function evidenceSpan(sourceVersionId: string, text: string, charStart: number): EvidenceSpan {
  const bytes = new TextEncoder().encode(text);
  const contentHash = ids.contentHash(bytes);
  const sourceId = ids.sourceId("fixture", `fixture://${sourceVersionId}`);
  return {
    id: ids.evidenceId({ sourceVersionId: sourceVersionId as SourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, spanHash: contentHash }),
    sourceId,
    sourceVersionId: sourceVersionId as SourceVersionId,
    chunkId: ids.chunkId({ sourceVersionId: sourceVersionId as SourceVersionId, byteStart: 0, byteEnd: bytes.byteLength, chunkHash: contentHash }),
    contentHash,
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: bytes.byteLength,
    charStart,
    charEnd: charStart + [...text].length,
    text,
    textPreview: text,
    languageHints: {},
    scriptHints: {},
    trustVector: { forceClass: "profile_excerpt_evidence" },
    provenance: {},
    features: [],
    status: "promoted",
    alpha: 0.9,
    observedAt: 91_000
  };
}

function cluster(profileId: string, sourceVersionId: string): LanguageProfileCluster {
  const profile: LanguageProfile = {
    id: profileId,
    sourceVersionId: sourceVersionId as SourceVersionId,
    scripts: [{ script: "script.opaque", mass: 1 }],
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    entropy: 0,
    createdAt: 1
  };
  return {
    id: "cluster.fixture",
    members: [profile],
    profileIds: [profileId],
    sourceVersionIds: [sourceVersionId as SourceVersionId],
    discoveredNames: [],
    scripts: profile.scripts,
    symbolShapes: [],
    charNgrams: [],
    direction: "unknown",
    artifactSupport: 1
  };
}
