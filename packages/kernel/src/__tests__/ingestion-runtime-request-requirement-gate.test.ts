import { describe, expect, it } from "vitest";

import { createEventFactory } from "../events.js";
import { createIdFactory } from "../ids.js";
import { createIngestionRuntime } from "../ingestion-runtime.js";
import { REQUEST_REQUIREMENT_CORPUS_SCHEMA } from "../request-requirement-learning.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createClock, createHasher } from "../primitives.js";
import type { LanguagePatternRecord, QuarantineSource, ScceKernelDeps } from "../storage.js";
import type { EvidenceSpan, ScceEvent, SourceVersion } from "../types.js";

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

async function ingestFixtureText(depsOverrides: Partial<ScceKernelDeps>) {
  const clock = createClock({ fixedTime: 1_000 });
  const hasher = createHasher();
  const idFactory = createIdFactory({ clock, hasher, deterministicReplay: true });
  const sourceVersions: SourceVersion[] = [];
  const evidence: EvidenceSpan[] = [];
  const quarantined: QuarantineSource[] = [];
  const learnedPatterns: LanguagePatternRecord[] = [];
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
      transaction: async <T>(operation: () => Promise<T>) => operation(),
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
        putLanguageProfiles: async () => undefined
      },
      graph: {
        upsertNodes: async () => undefined,
        upsertEdges: async () => undefined,
        upsertHyperedges: async () => undefined
      },
      languageMemory: {
        putNgramObservationsBatch: async () => undefined,
        putNgramModels: async () => undefined,
        putLanguageUnits: async () => undefined,
        putLanguagePatterns: async (patterns: LanguagePatternRecord[]) => {
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
    content: REQUEST_REQUIREMENT_CORPUS_TEXT,
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

  return { learnedPatterns, symbolPatternLearnedPayloads };
}
