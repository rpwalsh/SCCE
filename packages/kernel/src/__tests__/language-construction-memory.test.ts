import { describe, expect, it } from "vitest";
import {
  CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
  CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA,
  ENGLISH_CREATIVE_EVENT_COMPILER_ID,
  LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS,
  LANGUAGE_CONSTRUCTION_PATTERN_SCHEMA,
  LEGACY_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2,
  compileEnglishCreativeEventConstructionPattern,
  compileLanguageConstructionPattern,
  hydrateLanguageConstructionPatterns
} from "../language-construction-memory.js";
import { createLanguageMemoryRuntime, scopeLanguageMemoryStateToCluster } from "../language-memory-runtime.js";
import { createClock, createHasher } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { LanguageProfileCluster } from "../language.js";
import type { LanguagePatternRecord } from "../storage.js";
import type { EvidenceSpan, JsonValue, LanguageProfile, SourceVersionId } from "../types.js";

const hasher = createHasher();
const clock = createClock({ fixedTime: 91_000, stepMs: 1 });
const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "construction-memory" });

describe("durable language-construction memory", () => {
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

describe("source-verified English creative argument frames", () => {
  it("persists and re-verifies patient and complement heads without a source sentence body", () => {
    const evidence = evidenceSpan(
      "source.en",
      "He considered the impossible bargain. She attributed the signal to a damaged instrument. I searched through the ruined laboratory. He carried the heavy lantern.",
      0
    );
    const compiled = compileEnglishCreativeEventConstructionPattern({
      profileId: "profile.en",
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
    const attributed = hydrated.bundles[0]?.creativeEvents
      ?.find(event => event.forms.infinitive === "attribute");
    expect(attributed?.compilerId).toBe(ENGLISH_CREATIVE_EVENT_COMPILER_ID);
    expect(attributed?.argumentFrame).toMatchObject({
      schema: CREATIVE_EVENT_ARGUMENT_FRAME_SCHEMA,
      roleIds: ["scce.role.agent", "scce.role.patient", "scce.role.complement"],
      bindings: [
        {
          roleId: "scce.role.patient",
          surface: "signal"
        },
        {
          roleId: "scce.role.complement",
          surface: "instrument",
          connector: {
            surface: "to"
          }
        }
      ]
    });
    const persisted = (compiled.pattern.patternJson as Record<string, JsonValue>).bundle as Record<string, JsonValue>;
    expect(JSON.stringify(persisted)).not.toContain("She attributed the signal to a damaged instrument.");
    for (const binding of attributed?.argumentFrame.bindings ?? []) {
      expect([...evidence.text].slice(binding.startCodePoint, binding.endCodePoint).join(""))
        .toBe(binding.surface);
      if (binding.connector) {
        expect([...evidence.text].slice(binding.connector.startCodePoint, binding.connector.endCodePoint).join(""))
          .toBe(binding.connector.surface);
      }
    }
  });

  it("preserves source-bound lemmas through conjugation and hydration", () => {
    const evidence = evidenceSpan(
      "source.en",
      "He owned the lantern. She encompassed the valley. He considered the map. She attributed the signal to an instrument. I searched through the laboratory. He carried the letter.",
      0
    );
    const compiled = compileEnglishCreativeEventConstructionPattern({
      profileId: "profile.en",
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
    expect(hydrated.bundles).toHaveLength(1);
    expect(hydrated.bundles[0]?.creativeEvents?.map(event => event.forms.infinitive))
      .toEqual(expect.arrayContaining(["own", "encompass", "consider", "attribute", "search", "carry"]));
  });

  it("rejects a tampered argument binding atomically", () => {
    const evidence = evidenceSpan(
      "source.en",
      "He considered the impossible bargain. She attributed the signal to a damaged instrument. I searched through the ruined laboratory. He carried the heavy lantern.",
      0
    );
    const compiled = compileEnglishCreativeEventConstructionPattern({
      profileId: "profile.en",
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
    bindings[0]!.surface = "counterfeit";

    const hydrated = hydrateLanguageConstructionPatterns({
      patterns: [tampered],
      evidence: [evidence],
      hasher
    });
    expect(hydrated.bundles).toEqual([]);
    expect(hydrated.rejected).toEqual([expect.objectContaining({
      code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.member
    })]);
  });

  it("rejects the incompatible v2 creative schema with an explicit reason", () => {
    const evidence = evidenceSpan(
      "source.en",
      "He considered the impossible bargain. She attributed the signal to a damaged instrument. I searched through the ruined laboratory. He carried the heavy lantern.",
      0
    );
    const compiled = compileEnglishCreativeEventConstructionPattern({
      profileId: "profile.en",
      evidence: [evidence],
      hasher,
      updatedAt: 91_500
    });
    if (compiled.status !== "compiled") throw new Error(JSON.stringify(compiled.issues));
    const legacy = structuredClone(compiled.pattern);
    const patternJson = legacy.patternJson as Record<string, JsonValue>;
    const bundle = patternJson.bundle as Record<string, JsonValue>;
    patternJson.schema = LEGACY_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2;
    bundle.schema = LEGACY_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2;

    const hydrated = hydrateLanguageConstructionPatterns({
      patterns: [legacy],
      evidence: [evidence],
      hasher
    });
    expect(CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA)
      .not.toBe(LEGACY_CREATIVE_EVENT_CONSTRUCTION_PATTERN_SCHEMA_V2);
    expect(hydrated.bundles).toEqual([]);
    expect(hydrated.rejected).toEqual([expect.objectContaining({
      code: LANGUAGE_CONSTRUCTION_MEMORY_REJECTION_IDS.legacyCreativeV2
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
