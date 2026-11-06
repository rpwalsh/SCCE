// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";

import { createEventFactory } from "../events.js";
import { createIdFactory } from "../ids.js";
import { createIngestionRuntime } from "../ingestion-runtime.js";
import { REQUEST_REQUIREMENT_CORPUS_SCHEMA } from "../request-requirement-learning.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createClock, createHasher } from "../primitives.js";
import { DEFAULT_NGRAM_SETTINGS } from "../corpus-registry.js";
import type { LanguagePatternRecord, LanguageUnitRecord, NgramModelRecord, NgramObservation, QuarantineSource, ScceKernelDeps } from "../storage.js";
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
          evidence.push(...spans);
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
        putLanguagePatterns: async (patterns: LanguagePatternRecord[]) => {
          languageWriteDepths.push(transactionDepth);
          learnedPatterns.push(...patterns);
        },
        putSemanticFrames: async () => undefined
      }
    }
  } as unknown as ScceKernelDeps;

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

  await runtime.ingest({
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

  expect(sourceVersions.length).toBeGreaterThan(0);
  expect(evidence.length).toBeGreaterThan(0);
  expect(quarantined.length).toBeGreaterThan(0);

  return { learnedPatterns, symbolPatternLearnedPayloads, learnedModels, learnedUnits, profiles, evidence, idFactory, hasher, languageWriteDepths, rawObservationWrites, rawObservationCalls };
}
