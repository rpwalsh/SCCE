// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createLanguageMemoryRuntime, type LanguageMemoryRuntimeState } from "../language-memory-runtime.js";
import {
  REQUEST_REQUIREMENT_CORPUS_SCHEMA,
  REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT,
  compileRequestRequirementCorpus,
  parseRequestRequirementCorpus
} from "../request-requirement-learning.js";
import { deriveTurnRequirementField } from "../turn-requirements.js";
import { extendedGenerationDecision } from "../extended-generation-turn.js";
import { createHasher } from "../primitives.js";
import type { EvidenceId, JsonValue, SourceVersionId } from "../types.js";

describe("source-backed response-form learning", () => {
  it("does not hydrate request patterns compiled with stale semantics", () => {
    const compiled = compileRequestRequirementCorpus({
      corpus: {
        schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
        language: "fixture",
        examples: ["toma", "ravi", "paku"].map(subject => ({
          text: `nava sula ${subject}`,
          authority: "creative" as const,
          requirements: { brevityDetailBalance: 0.92 }
        }))
      },
      profileId: "profile.fixture",
      sourceVersionId: "source-version.fixture.stale" as SourceVersionId,
      evidenceIds: ["evidence.fixture.stale" as EvidenceId],
      sourceSystem: "fixture",
      updatedAt: 1,
      makeId: value => `pattern.${createHasher().digestHex(JSON.stringify(value))}`
    });
    const current = compiled.patterns[0]!;
    const stale = {
      ...current,
      id: `${current.id}.stale`,
      patternJson: { ...(current.patternJson as Record<string, unknown>), compilerFingerprint: "obsolete.compiler" }
    };
    const state = createLanguageMemoryRuntime().hydrate({ models: [], patterns: [stale, current] });
    expect(state.importedPatterns.map(pattern => pattern.id)).toContain(current.id);
    expect(state.importedPatterns.map(pattern => pattern.id)).not.toContain(stale.id);
    expect(state.requestRequirementHydration).toMatchObject({ status: "active", current: 1, superseded: 1, droppedStaleCompiler: 0 });
  });

  it("recompiles fingerprint-less request patterns in place and reports the ones it cannot", () => {
    const compiled = compileRequestRequirementCorpus({
      corpus: {
        schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
        language: "fixture",
        examples: ["toma", "ravi", "paku"].map(subject => ({ text: `nava sula ${subject}`, authority: "creative" as const }))
      },
      profileId: "profile.fixture",
      sourceVersionId: "source-version.fixture.legacy" as SourceVersionId,
      evidenceIds: ["evidence.fixture.legacy" as EvidenceId],
      sourceSystem: "fixture",
      updatedAt: 1,
      makeId: value => `pattern.${createHasher().digestHex(JSON.stringify(value))}`
    });
    const current = compiled.patterns.find(pattern => (pattern.patternJson as Record<string, unknown>).surface === "nava sula")!;
    const currentJson = current.patternJson as Record<string, unknown>;
    // A row persisted before the fingerprint existed: same surface and aggregates, no fingerprint, no targets.
    const { compilerFingerprint: _fingerprint, requirementTargets: _targets, requirementTargetBounds: _bounds, ...legacyJson } = currentJson;
    const legacy = { ...current, id: `${current.id}.legacy`, patternJson: { ...legacyJson, requirementCoefficients: { brevityDetailBalance: 0.4 } } as JsonValue };
    const { surface: _surface, ...surfacelessJson } = legacyJson;
    const surfaceless = { ...current, id: `${current.id}.surfaceless`, patternJson: surfacelessJson as JsonValue };

    const state = createLanguageMemoryRuntime().hydrate({ models: [], patterns: [legacy, surfaceless] });
    const hydratedLegacy = state.importedPatterns.find(pattern => pattern.id === legacy.id);
    expect(hydratedLegacy).toBeDefined();
    const hydratedJson = hydratedLegacy!.patternJson as Record<string, unknown>;
    expect(hydratedJson.compilerFingerprint).toBe(REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT);
    expect(hydratedJson.requirementCoefficients).toEqual(currentJson.requirementCoefficients);
    expect(state.importedPatterns.map(pattern => pattern.id)).not.toContain(surfaceless.id);
    expect(state.requestRequirementHydration).toMatchObject({
      status: "inert_stale_compiler",
      compilerFingerprint: REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT,
      current: 0,
      recompiled: 1,
      superseded: 0,
      droppedStaleCompiler: 1,
      droppedIds: [surfaceless.id]
    });
    expect(JSON.stringify(state.audit)).toContain("inert_stale_compiler");

    const field = deriveTurnRequirementField({ requestText: "nava sula yaro", languageMemoryState: runtimeState([hydratedLegacy!]) });
    expect((field.activationsUsed ?? []).some(activation => activation.id === legacy.id)).toBe(true);
  });

  it("gives target/range recompiles a stable source-scoped identity and a current compiler fingerprint", () => {
    const compile = (detail: number) => compileRequestRequirementCorpus({
      corpus: {
        schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
        language: "fixture",
        examples: ["toma", "ravi", "paku"].map(subject => ({
          text: `nava sula ${subject}`,
          authority: "creative" as const,
          requirements: { brevityDetailBalance: detail }
        }))
      },
      profileId: "profile.fixture",
      sourceVersionId: "source-version.fixture.recompile" as SourceVersionId,
      evidenceIds: ["evidence.fixture.recompile" as EvidenceId],
      sourceSystem: "fixture",
      updatedAt: 1,
      makeId: value => `pattern.${createHasher().digestHex(JSON.stringify(value))}`
    });
    const stale = compile(0.05);
    const fresh = compile(0.92);
    const freshPattern = fresh.patterns.find(pattern =>
      (pattern.patternJson as Record<string, unknown>).surface === "nava sula"
    )!;

    expect(freshPattern.id).toBe(stale.patterns.find(pattern =>
      (pattern.patternJson as Record<string, unknown>).surface === "nava sula"
    )?.id);
    expect((freshPattern.patternJson as Record<string, unknown>).compilerFingerprint)
      .toBe(REQUEST_REQUIREMENT_PATTERN_COMPILER_FINGERPRINT);

    const field = deriveTurnRequirementField({
      requestText: "nava sula yaro",
      languageMemoryState: runtimeState(fresh.patterns)
    });
    expect(field.brevityDetailBalance).toBeGreaterThan(0.85);
    expect(field.learnedRequirementBounds?.brevityDetailBalance?.lower).toBeGreaterThan(0.9);
    expect(field.learnedRequirementBounds?.brevityDetailBalance?.upper).toBeLessThanOrEqual(0.92);
  });

  it.each(["nava sula", "가나 다라"])("preserves bounded requirement targets and extent for learned surface %s", surface => {
    const compile = (detail: number) => compileRequestRequirementCorpus({
      corpus: {
        schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
        language: "fixture",
        examples: ["toma", "ravi", "paku"].map(subject => ({
          text: `${surface} ${subject}`,
          authority: "creative" as const,
          requirements: { noveltyDemand: 0.96, brevityDetailBalance: detail }
        }))
      },
      profileId: "profile.fixture",
      sourceVersionId: "source-version.fixture.targets" as SourceVersionId,
      evidenceIds: ["evidence.fixture.targets" as EvidenceId],
      sourceSystem: "fixture",
      updatedAt: 1,
      makeId: value => `pattern.${createHasher().digestHex(JSON.stringify(value))}`
    });
    const field = (detail: number, text = `${surface} yaro`) => deriveTurnRequirementField({
      requestText: text,
      languageMemoryState: runtimeState(compile(detail).patterns)
    });
    const brief = field(0.05);
    const extensive = field(0.92);
    expect(brief.brevityDetailBalance).toBeLessThan(0.1);
    expect(brief.noveltyDemand).toBeGreaterThan(0.9);
    expect(brief.learnedRequirementBounds?.brevityDetailBalance?.lower).toBeCloseTo(brief.brevityDetailBalance, 10);
    expect(extensive.brevityDetailBalance).toBeGreaterThan(0.85);
    expect(extensive.brevityDetailBalance).toBeLessThanOrEqual(0.92);
    expect(extendedGenerationDecision({ requirementField: brief, requestedAuthority: "creative" }).required).toBe(false);
    expect(extendedGenerationDecision({ requirementField: extensive, requestedAuthority: "creative" }).required).toBe(true);
    expect(field(0.05, `${surface} yaro ${surface} zema`).brevityDetailBalance).toBeCloseTo(brief.brevityDetailBalance, 10);
    for (const requirement of brief.requiredFeatures) {
      const span = requirement.origin.requestSpan;
      expect(span.text).toBe([...`${surface} yaro`].slice(span.charStart, span.charEnd).join(""));
      expect(span.byteEnd - span.byteStart).toBe(Buffer.byteLength(span.text));
    }
  });

  it("uses the specific matched context before a contained marginal form, independently of stored order", () => {
    const compiled = compileRequestRequirementCorpus({
      corpus: {
        schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
        language: "fixture",
        examples: [
          ...["paku", "ravi", "sula", "toma", "vani", "yaro", "zema", "danu"].map(subject => ({
            ...annotated(`nava ${subject}`, "response.form.0017.v1"),
            requirements: { noveltyDemand: 0.96, brevityDetailBalance: 0.92 }
          })),
          ...["gemi", "hira"].map(subject => ({
            ...unannotated(`nava keta ${subject}`),
            requirements: { noveltyDemand: 0.96, brevityDetailBalance: 0.05 }
          }))
        ]
      },
      profileId: "profile.fixture",
      sourceVersionId: "source-version.fixture.context" as SourceVersionId,
      evidenceIds: ["evidence.fixture.context" as EvidenceId],
      sourceSystem: "fixture",
      updatedAt: 1,
      makeId: value => `pattern.${createHasher().digestHex(JSON.stringify(value))}`
    });
    expect(compiled.patterns.some(pattern => (pattern.patternJson as Record<string, unknown>).responseForm)).toBe(true);
    for (const patterns of [compiled.patterns, [...compiled.patterns].reverse()]) {
      const field = deriveTurnRequirementField({ requestText: "nava keta zori", languageMemoryState: runtimeState(patterns) });
      expect(field.responseForm).toBeUndefined();
      expect(field.brevityDetailBalance).toBeLessThan(0.1);
      expect(extendedGenerationDecision({ requirementField: field, requestedAuthority: "creative" }).required).toBe(false);
    }
  });

  it("does not amplify separate estimates from the same source or favor an unanchored marginal over its matched anchor", () => {
    const compiled = compileRequestRequirementCorpus({
      corpus: {
        schema: REQUEST_REQUIREMENT_CORPUS_SCHEMA,
        language: "fixture",
        examples: [
          ...["paku", "ravi", "sula", "toma", "vani", "yaro", "zema", "danu"].map(subject => ({
            ...annotated(`${subject} nava`, "response.form.0017.v1"),
            requirements: { noveltyDemand: 0.96, brevityDetailBalance: 0.92 }
          })),
          ...["gemi", "hira"].map(subject => ({
            ...unannotated(`nava ${subject}`),
            requirements: { noveltyDemand: 0.96, brevityDetailBalance: 0.05 }
          }))
        ]
      },
      profileId: "profile.fixture",
      sourceVersionId: "source-version.fixture.anchors" as SourceVersionId,
      evidenceIds: ["evidence.fixture.anchors" as EvidenceId],
      sourceSystem: "fixture",
      updatedAt: 1,
      makeId: value => `pattern.${createHasher().digestHex(JSON.stringify(value))}`
    });
    const anchored = deriveTurnRequirementField({ requestText: "nava zori", languageMemoryState: runtimeState(compiled.patterns) });
    expect(anchored.responseForm).toBeUndefined();
    expect(anchored.brevityDetailBalance).toBeLessThan(0.1);

    const ambiguous = deriveTurnRequirementField({ requestText: "zori nava yiri", languageMemoryState: runtimeState(compiled.patterns) });
    expect(ambiguous.brevityDetailBalance).toBeGreaterThan(0.6);
    expect(ambiguous.learnedRequirementBounds?.brevityDetailBalance?.lower).toBeLessThan(0.1);
    expect(extendedGenerationDecision({ requirementField: ambiguous, requestedAuthority: "creative" }).required).toBe(false);

    const legacyPatterns = ["nava", "keta", "sula"].map((surface, index) => ({
      ...compiled.patterns[0]!,
      id: `pattern.fixture.legacy.${index}`,
      support: 1,
      entropy: 0,
      patternJson: {
        schema: "scce.request_requirement_pattern.v1",
        surface,
        anchor: "any",
        sourceVersionId: "source-version.fixture.legacy",
        requirementCoefficients: { noveltyDemand: 4, brevityDetailBalance: 0.3 }
      }
    }));
    const derive = (requestText: string) => deriveTurnRequirementField({ requestText, languageMemoryState: runtimeState(legacyPatterns) });
    const one = derive("nava");
    const several = derive("nava zori keta yiri sula");
    expect(several.brevityDetailBalance).toBeCloseTo(one.brevityDetailBalance, 10);
    expect(extendedGenerationDecision({ requirementField: several, requestedAuthority: "creative" }).required).toBe(false);
  });

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
