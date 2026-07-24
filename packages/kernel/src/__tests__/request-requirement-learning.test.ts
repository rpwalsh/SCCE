import { describe, expect, it } from "vitest";
import type { LanguageMemoryRuntimeState } from "../language-memory-runtime.js";
import {
  REQUEST_REQUIREMENT_CORPUS_SCHEMA,
  compileRequestRequirementCorpus,
  parseRequestRequirementCorpus
} from "../request-requirement-learning.js";
import { deriveTurnRequirementField } from "../turn-requirements.js";
import type { EvidenceId, SourceVersionId } from "../types.js";

describe("source-backed response-form learning", () => {
  it("compiles and activates an opaque form only with adequate annotation support and margin", () => {
    const compiled = compileRequestRequirementCorpus({
      corpus: {
        schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
        language: "fixture",
        responseFormProfiles: [{
          id: "response.form.0017.v1",
          sourceLabel: "fixture form A",
          surfaceLayout: {
            sentencesPerBlock: 1,
            orderedBlocks: true
          }
        }],
        examples: [
          annotated("alpha beta one", "response.form.0017.v1", "fixture form A"),
          annotated("alpha beta two", "response.form.0017.v1", "fixture form A"),
          annotated("alpha beta three", "response.form.0017.v1", "fixture form A"),
          annotated("alpha gamma one", "response.form.0093.v1", "fixture form B")
        ]
      },
      profileId: "profile.fixture",
      sourceVersionId: "source-version.fixture" as SourceVersionId,
      evidenceIds: ["evidence.fixture" as EvidenceId],
      sourceSystem: "fixture",
      updatedAt: 1,
      makeId: value => `pattern.${JSON.stringify(value).length}`
    });
    const alphaPattern = compiled.patterns.find(pattern => {
      const record = pattern.patternJson as Record<string, unknown>;
      return record.surface === "alpha" && record.anchor === "any";
    });
    expect((alphaPattern?.patternJson as Record<string, unknown>).responseForm).toMatchObject({
      id: "response.form.0017.v1",
      posterior: 0.75,
      margin: 0.5,
      exampleSupport: 3,
      annotatedExamples: 4,
      sourceLabel: "fixture form A",
      surfaceLayout: {
        sentencesPerBlock: 1,
        orderedBlocks: true
      }
    });

    const field = deriveTurnRequirementField({
      requestText: "alpha beta request",
      languageMemoryState: runtimeState(compiled.patterns)
    });
    expect(field.responseForm).toMatchObject({
      id: "response.form.0017.v1",
      sourceLabel: "fixture form A",
      surfaceLayout: {
        sentencesPerBlock: 1,
        orderedBlocks: true
      }
    });
    expect(field.responseForm?.sourceActivationIds.length).toBeGreaterThan(0);
    expect((field.trace as Record<string, unknown>).responseForm).toBeTruthy();
  });

  it("does not compile a response form when matched annotations are tied", () => {
    const compiled = compileRequestRequirementCorpus({
      corpus: {
        schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
        language: "fixture",
        examples: [
          annotated("shared alpha", "response.form.0017.v1"),
          annotated("shared beta", "response.form.0017.v1"),
          annotated("shared gamma", "response.form.0093.v1"),
          annotated("shared delta", "response.form.0093.v1")
        ]
      },
      profileId: "profile.fixture",
      sourceVersionId: "source-version.fixture" as SourceVersionId,
      evidenceIds: [],
      sourceSystem: "fixture",
      updatedAt: 1,
      makeId: value => `pattern.${JSON.stringify(value).length}`
    });
    const sharedPatterns = compiled.patterns.filter(pattern =>
      (pattern.patternJson as Record<string, unknown>).surface === "shared"
    );

    expect(sharedPatterns.length).toBeGreaterThan(0);
    for (const pattern of sharedPatterns) {
      expect((pattern.patternJson as Record<string, unknown>).responseForm).toBeUndefined();
    }
    expect(deriveTurnRequirementField({
      requestText: "shared request",
      languageMemoryState: runtimeState(compiled.patterns)
    }).responseForm).toBeUndefined();
  });

  it("lets matched no-form examples defeat a generic layout without suppressing its discriminative feature", () => {
    const formId = "response.form.0006.v1";
    const compiled = compileRequestRequirementCorpus({
      corpus: {
        schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
        language: "fixture",
        responseFormProfiles: [{
          id: formId,
          sourceLabel: "outline or list",
          surfaceLayout: {
            sentencesPerBlock: 1,
            orderedBlocks: true
          }
        }],
        examples: [
          annotated("compose a layout for a harbor", formId, "outline or list"),
          annotated("compose a layout for a garden", formId, "outline or list"),
          unannotated("invent a device for a harbor"),
          unannotated("design a signal for a garden"),
          unannotated("create a festival for a city")
        ]
      },
      profileId: "profile.fixture",
      sourceVersionId: "source-version.fixture" as SourceVersionId,
      evidenceIds: ["evidence.fixture" as EvidenceId],
      sourceSystem: "fixture",
      updatedAt: 1,
      makeId: value => `pattern.${JSON.stringify(value).length}`
    });
    const genericPatterns = compiled.patterns.filter(pattern => {
      const record = pattern.patternJson as Record<string, unknown>;
      return record.surface === "for a";
    });

    expect(genericPatterns.length).toBeGreaterThan(0);
    for (const pattern of genericPatterns) {
      expect((pattern.patternJson as Record<string, unknown>).responseForm).toBeUndefined();
    }
    expect(deriveTurnRequirementField({
      requestText: "invent a device for a valley",
      languageMemoryState: runtimeState(compiled.patterns)
    }).responseForm).toBeUndefined();
    expect(deriveTurnRequirementField({
      requestText: "compose a layout for a citadel",
      languageMemoryState: runtimeState(compiled.patterns)
    }).responseForm).toMatchObject({
      id: formId,
      sourceLabel: "outline or list",
      surfaceLayout: {
        sentencesPerBlock: 1,
        orderedBlocks: true
      }
    });
  });

  it("rejects malformed response-form IDs while preserving the request example", () => {
    const parsed = parseRequestRequirementCorpus(JSON.stringify({
      schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
      language: "fixture",
      corpusRevision: "fixture-response-form-calibration-2",
      examples: [{
        authority: "creative",
        text: "fixture request",
        responseFormId: "plain prose with spaces",
        responseFormSourceLabel: "fixture label"
      }]
    }));

    expect(parsed?.examples).toHaveLength(1);
    expect(parsed?.corpusRevision).toBe("fixture-response-form-calibration-2");
    expect(parsed?.examples[0]?.responseFormId).toBeUndefined();
    expect(parsed?.examples[0]?.responseFormSourceLabel).toBeUndefined();
  });
});

function annotated(text: string, responseFormId: string, responseFormSourceLabel?: string) {
  return {
    authority: "creative" as const,
    text,
    responseFormId,
    ...(responseFormSourceLabel ? { responseFormSourceLabel } : {})
  };
}

function unannotated(text: string) {
  return {
    authority: "creative" as const,
    text
  };
}

function runtimeState(
  importedPatterns: ReturnType<typeof compileRequestRequirementCorpus>["patterns"]
): LanguageMemoryRuntimeState {
  return {
    models: [],
    records: [],
    streamIds: ["stream.fixture"],
    languageHints: ["fixture"],
    maxOrder: 0,
    observedSymbolCount: 0,
    vocabularySize: 0,
    importedUnits: [],
    importedPatterns,
    importedObservations: [],
    importedSemanticFrames: [],
    importedLanguagePriorCount: importedPatterns.length,
    audit: {}
  } as unknown as LanguageMemoryRuntimeState;
}
