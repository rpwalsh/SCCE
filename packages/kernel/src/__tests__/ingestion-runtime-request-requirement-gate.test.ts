// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { getFixtureLanguagePatternProjection, installFixtureLanguagePatternProjection, replaceFixtureLanguagePatternProjection } from "./language-pattern-projection-fixture.js";
import { describe, expect, it } from "vitest";

import { createEventFactory } from "../events.js";
import { createIdFactory } from "../ids.js";
import { createIngestionRuntime } from "../ingestion-runtime.js";
import { REQUEST_REQUIREMENT_CORPUS_SCHEMA } from "../request-requirement-learning.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createClock, createHasher } from "../primitives.js";
import { DEFAULT_NGRAM_SETTINGS } from "../corpus-registry.js";
import { hydrateLanguageConstructionPatterns } from "../language-construction-memory.js";
import { filterEventRange } from "./event-range-fixture.js";
import type { EventRangeQuery, LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation, QuarantineSource, ScceKernelDeps } from "../storage.js";
import type { EvidenceSpan, ScceEvent, SourceVersion, LanguageProfile, JsonValue } from "../types.js";

// A hand-authored English request/authority-routing corpus used to disguise a
// synthetic classifier as learned language evidence (see
// packages/kernel/src/request-requirement-learning.ts). This must stay inert
// unless a caller deliberately opts in -- schema-sniffing alone must never be
// enough to promote it into production authority/response-form control.
const REQUEST_REQUIREMENT_CORPUS_TEXT = JSON.stringify({
  schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
  language: "en",
  examples: [
    { text: "Write a poem about autumn", authority: "creative" },
    { text: "Write a short story about the sea", authority: "creative" },
    { text: "Write a haiku about winter", authority: "creative" }
  ]
});

describe("request-requirement corpus ingestion gate", () => {
  it("keeps unqualified single-source grammar diagnostic while publishing evidence-owned creative speech", async () => {
    const text = ["cat chased mouse.", "dog chased mouse.", "cat chased ball.", "dog chased ball.",
      "cat chased mouse.", "dog chased ball.", "cat chased ball.", "dog chased mouse."].join(" ");
    const fixture = await ingestFixtureText({}, text);
    const schema = "scce.language_construction_pattern.v1";
    const stored = fixture.learnedPatterns.filter(pattern => (pattern.patternJson as { schema?: string }).schema === schema);
    expect(stored.filter(pattern => !isCreativeSpeechPattern(pattern))).toEqual([]);
    const speechPatternIds = stored.filter(isCreativeSpeechPattern).map(pattern => pattern.id).sort();
    expect(speechPatternIds.length).toBeGreaterThan(0);
    const active = await fixture.store.listLanguagePatterns({ patternSchemas: [schema] });
    expect(active.filter(pattern => !isCreativeSpeechPattern(pattern))).toEqual([]);
    expect(active.filter(isCreativeSpeechPattern).map(pattern => pattern.id).sort()).toEqual(speechPatternIds);
    const hydrated = hydrateLanguageConstructionPatterns({ patterns: active.filter(pattern => !isCreativeSpeechPattern(pattern)), evidence: fixture.evidence, hasher: fixture.hasher });
    expect(hydrated.rejected).toEqual([]);
    expect(hydrated.constructions).toEqual([]);
    expect(hydrated.bundles).toEqual([]);
    await fixture.ingest(text);
    let repeated = await fixture.store.listLanguagePatterns({ patternSchemas: [schema] });
    expect(repeated.filter(pattern => !isCreativeSpeechPattern(pattern))).toEqual([]);
    expect(repeated.filter(isCreativeSpeechPattern).map(pattern => pattern.id).sort()).toEqual(speechPatternIds);
    await fixture.ingest("A single observation.");
    expect(fixture.publications.at(-1)!.projection.patternIds).toEqual([]);
    repeated = await fixture.store.listLanguagePatterns({ patternSchemas: [schema] });
    expect(repeated.filter(pattern => !isCreativeSpeechPattern(pattern))).toEqual([]);
    expect(fixture.learnedPatterns.filter(pattern =>
      (pattern.patternJson as { schema?: string }).schema === schema && !isCreativeSpeechPattern(pattern))).toEqual([]);
    expect(fixture.learnedPatterns.filter(isCreativeSpeechPattern).map(pattern => pattern.id).sort()).toEqual(speechPatternIds);
  });
  it("persists ordinary upload models and forms atomically without raw count duplicates", async () => {
    const text = "Zephyr valve pressure remains stable. Measurements follow the recorded calibration.";
    const fixture = await ingestFixtureText({}, text);
    expect(fixture.rawObservationWrites).toBe(0);
    expect(fixture.rawObservationCalls).toBe(0);
    expect(fixture.learnedModels).toHaveLength(1);
    expect((fixture.learnedModels[0]!.modelJson as { sourceSystem: string }).sourceSystem).toBe("workspace");
    expect(fixture.learnedUnits.length).toBeGreaterThan(0);
    expect(fixture.learnedPatterns.length).toBeGreaterThan(0);
    expect(fixture.languageWriteDepths.every(depth => depth > 0)).toBe(true);
    const reference = createLanguageMemoryRuntime({ idFactory: fixture.idFactory, hasher: fixture.hasher }).observe({ streamId: "generic-retained-upload", profile: fixture.profiles[0]!,
      sourceVersionId: fixture.profiles[0]!.sourceVersionId, text, evidence: fixture.evidence, createdAt: 1,
      maxOrder: DEFAULT_NGRAM_SETTINGS.maxOrder, maxCountersPerOrder: 12000, vocabularyLimit: 24000 });
    expect(reference.observations.length).toBeGreaterThan(0);
    expect((fixture.learnedModels[0]!.modelJson as { model: JsonValue }).model).toEqual((reference.models[0]!.modelJson as { model: JsonValue }).model);
    expect(fixture.learnedUnits.map(unit => [unit.unitKind, unit.text])).toEqual(reference.units.map(unit => [unit.unitKind, unit.text]));
    const language = createLanguageMemoryRuntime();
    const state = language.hydrate({ models: fixture.learnedModels, observations: [], units: fixture.learnedUnits, patterns: fixture.learnedPatterns });
    expect(state.models).toHaveLength(1);
    expect(language.suggest({ state, context: [] }).length).toBeGreaterThan(0);
  });

  it("does not classify request-requirement text into production patterns by default", async () => {
    const { learnedPatterns, symbolPatternLearnedPayloads } = await ingestFixtureText({
      allowSyntheticRequestRequirementBootstrap: false
    });

    expect(learnedPatterns.some(isRequestRequirementPattern)).toBe(false);
    for (const payload of symbolPatternLearnedPayloads) {
      expect(JSON.stringify(payload)).not.toContain("requestRequirements");
    }
  });

  it("only classifies request-requirement text into production patterns when explicitly opted in", async () => {
    const { learnedPatterns } = await ingestFixtureText({
      allowSyntheticRequestRequirementBootstrap: true
    });

    expect(learnedPatterns.some(isRequestRequirementPattern)).toBe(true);
  });
});

function isCreativeSpeechPattern(pattern: LanguagePatternRecord): boolean {
  const row = pattern.patternJson as { schema?: string; bundle?: { bindingId?: string } };
  return row.schema === "scce.language_construction_pattern.v1"
    && row.bundle?.bindingId?.startsWith("surface.creative_event.speech.") === true;
}

function isRequestRequirementPattern(pattern: LanguagePatternRecord): boolean {
  const value = pattern.patternJson;
  return Boolean(
    value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as { schema?: unknown }).schema === "scce.request_requirement_pattern.v1"
  );
}

async function ingestFixtureText(depsOverrides: Partial<ScceKernelDeps>, content = REQUEST_REQUIREMENT_CORPUS_TEXT) {
  const clock = createClock({ fixedTime: 1_000 });
  const hasher = createHasher();
  const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });
  const sourceVersions: SourceVersion[] = [];
  const evidence: EvidenceSpan[] = [];
  const quarantined: QuarantineSource[] = [];
  const learnedPatterns: LanguagePatternRecord[] = [];
  const learnedModels: NgramModelRecord[] = [];
  const learnedUnits: LanguageUnitRecord[] = [];
  const profiles: LanguageProfile[] = [];
  const languageWriteDepths: number[] = [];
  let rawObservationWrites = 0;
  let rawObservationCalls = 0;
  let transactionDepth = 0;
  const events: ScceEvent[] = [];
  const symbolPatternLearnedPayloads: unknown[] = [];
  const publications: Parameters<NonNullable<ScceKernelDeps["storage"]["languageMemory"]["replaceLanguagePatternProjection"]>>[0][] = [];
  const informationLabel = {
    tenantId: "fixture.tenant",
    principals: ["fixture.owner"],
    compartments: ["fixture.ingestion"],
    exportClass: "restricted" as const,
    mergePolicy: "isolated" as const
  };
  const deps = {
    maxChunkBytes: 4096,
    informationAccess: {
      tenantId: "fixture.tenant",
      principalId: "fixture.owner",
      compartments: ["fixture.ingestion"],
      maximumExportClass: "restricted"
    },
    sourceInformationLabel: informationLabel,
    ...depsOverrides,
    storage: {
      events: {
        readRange: async (query: EventRangeQuery) => filterEventRange(events, query)
      },
      transaction: async <T>(operation: () => Promise<T>) => { transactionDepth++; try { return await operation(); } finally { transactionDepth--; } },
      blobs: {
        put: async (content: Uint8Array) => {
          const hash = idFactory.contentHash(content);
          return hash;
        }
      },
      evidence: {
        putSourceVersion: async (source: SourceVersion) => {
          sourceVersions.push(source);
        },
        putEvidenceSpans: async (spans: EvidenceSpan[]) => {
          for (const span of spans) {
            const prior = evidence.findIndex(row => row.id === span.id);
            if (prior < 0) evidence.push(span); else evidence[prior] = span;
          }
        },
        getEvidenceBatch: async (ids: EvidenceSpan["id"][]) => {
          const requestedIds = new Set(ids.map(String));
          return evidence.filter(span => requestedIds.has(String(span.id)));
        }
      },
      quarantine: {
        put: async (source: QuarantineSource) => {
          quarantined.push(source);
        }
      },
      ingestion: {
        put: async () => undefined
      },
      model: {
        putLanguageProfiles: async (rows: LanguageProfile[]) => { languageWriteDepths.push(transactionDepth); profiles.push(...rows); }
      },
      graph: {
        upsertNodes: async () => undefined,
        upsertEdges: async () => undefined,
        upsertHyperedges: async () => undefined
      },
      languageMemory: {
        putNgramObservationsBatch: async (rows: NgramObservation[]) => { rawObservationCalls++; rawObservationWrites += rows.length; },
        putNgramModels: async (rows: NgramModelRecord[]) => { languageWriteDepths.push(transactionDepth); learnedModels.push(...rows); },
        putLanguageUnits: async (rows: LanguageUnitRecord[]) => { languageWriteDepths.push(transactionDepth); learnedUnits.push(...rows); },
        getLanguagePatternProjection: getFixtureLanguagePatternProjection,
        replaceLanguagePatternProjection: async function(this: ScceKernelDeps["storage"]["languageMemory"], input: (typeof publications)[number]) { publications.push(input); await replaceFixtureLanguagePatternProjection.call(this, input); },
        listLanguagePatterns: async (query: Parameters<ScceKernelDeps["storage"]["languageMemory"]["listLanguagePatterns"]>[0]) => learnedPatterns.filter(row => !query?.patternSchemas || query.patternSchemas.includes(String((row.patternJson as { schema?: string }).schema))),
        putLanguagePatterns: async (patterns: LanguagePatternRecord[]) => {
          languageWriteDepths.push(transactionDepth);
          for (const pattern of patterns) {
            const prior = learnedPatterns.findIndex(row => row.id === pattern.id);
            if (prior < 0) learnedPatterns.push(pattern); else learnedPatterns[prior] = pattern;
          }
        },
        putSemanticFrames: async () => undefined
      }
    }
  } as unknown as ScceKernelDeps;
  installFixtureLanguagePatternProjection(deps.storage.languageMemory);

  const runtime = createIngestionRuntime({
    deps,
    clock,
    hasher,
    idFactory,
    eventFactory: createEventFactory({ idFactory, clock, hasher }),
    language: createLanguageAcquisitionEngine({ idFactory }),
    languageMemoryRuntime: createLanguageMemoryRuntime({ idFactory, hasher }),
    append: async event => {
      events.push(event);
      if (event.typeId === "SymbolPatternLearned") symbolPatternLearnedPayloads.push(event.payload);
      return event;
    },
    onKernelStateMutation: () => undefined
  });

  const ingest = (content: string) => runtime.ingest({
    uri: "inline://request-requirement-gate-fixture",
    namespace: "fixture",
    mediaType: "application/json",
    content,
    sourceAdmission: {
      sourceClass: "owner_local",
      intendedUse: "learned_prior",
      promotionAuthority: "owner"
    },
    sourceTrust: {
      identity: 1,
      integrity: 1,
      parserReliability: 1,
      directness: 1,
      authority: 1,
      freshness: 1,
      independenceGroup: "fixture:request-requirement-gate",
      accessScope: "owner_private",
      licenseStatus: "owner_authorized"
    }
  });
  await ingest(content);

  expect(sourceVersions.length).toBeGreaterThan(0);
  expect(evidence.length).toBeGreaterThan(0);
  expect(quarantined.length).toBeGreaterThan(0);

  return { learnedPatterns, symbolPatternLearnedPayloads, learnedModels, learnedUnits, profiles, evidence, idFactory, hasher, languageWriteDepths, rawObservationWrites, rawObservationCalls,
    store: deps.storage.languageMemory, publications, ingest };
}
