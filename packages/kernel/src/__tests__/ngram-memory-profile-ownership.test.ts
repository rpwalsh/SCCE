// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { createIdFactory } from "../ids.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createNgramMemoryCompiler } from "../ngram-memory.js";
import { CORPUS_SOURCE_SYSTEM_IDS } from "../corpus-registry.js";
import { sourceLanguageTrainingStreamId } from "../source-language-training-identity.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import type { EvidenceSpan, LanguageProfile } from "../types.js";

describe("n-gram memory profile ownership", () => {
  it("does not admit compilation receipts as language capability", () => {
    const runtime = createLanguageMemoryRuntime();
    const state = runtime.hydrate({ models: [], observations: [], patterns: [{ id: "source.language.compilation.fixture", profileId: "profile.fixture", patternKind: "source_compilation",
      support: 1, entropy: 0, patternJson: { schema: "scce.source_language_compilation_receipt.v1", compilation: {} }, evidenceIds: [], updatedAt: 1 }] });
    expect(state.importedPatterns).toEqual([]);
    expect(state.importedLanguagePriorCount).toBe(0);
    expect(state.models).toEqual([]);
    expect(runtime.generate({ state }).text).toBe("");
  });

  it("shares canonical source model identities across producer namespaces without merging owners", () => {
    const hasher = createHasher();
    const learned = profile("profile.canonical", "source.canonical");
    const evidence = span("evidence.canonical", "alpha beta alpha gamma");
    const owner = evidence.sourceId;
    const streamId = sourceLanguageTrainingStreamId({ sourceId: owner, sourceVersionId: learned.sourceVersionId, sourceSystem: "workspace", hasher });
    const input = { streamId, sourceSystem: "workspace", profile: learned, sourceVersionId: learned.sourceVersionId, text: evidence.text, evidence: [evidence], createdAt: 1, retainObservations: false };
    const compile = (namespace: string, stream = streamId, sourceSystem = "workspace") => createNgramMemoryCompiler({ hasher,
      idFactory: createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true, namespace }) }).compile({ ...input, streamId: stream, sourceSystem });
    const corpus = compile("corpus-producer", streamId, CORPUS_SOURCE_SYSTEM_IDS.workspace);
    const retrained = compile("kernel-producer");
    expect(corpus.models).toEqual(retrained.models);
    expect(corpus.models).toHaveLength(1);
    expect(corpus.models[0]?.modelJson).toMatchObject({ sourceSystem: "workspace" });
    const otherStream = sourceLanguageTrainingStreamId({ sourceId: "source.other-owner" as EvidenceSpan["sourceId"], sourceVersionId: learned.sourceVersionId, sourceSystem: "workspace", hasher });
    expect(compile("kernel-producer", otherStream).models[0]?.id).not.toBe(corpus.models[0]?.id);
  });

  it("avoids discarded observation identities while retaining identical learned artifacts", () => {
    const hasher = createHasher();
    const idFactory = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true });
    const compiler = createNgramMemoryCompiler({ hasher, idFactory });
    const evidence = span("evidence.retention", "alpha beta alpha gamma alpha beta");
    const learned = profile("profile.retention", "source.retention");
    const input = { streamId: "stream.retention", profile: learned, sourceVersionId: learned.sourceVersionId, text: evidence.text, evidence: [evidence], createdAt: 1 };
    const full = compiler.compile(input);
    const identity = vi.spyOn(idFactory, "semanticId");
    const lean = compiler.compile({ ...input, retainObservations: false });
    const served = createLanguageMemoryRuntime({ idFactory, hasher }).train({ ...input, retainObservations: false });
    expect(full.observations.length).toBeGreaterThan(0);
    expect(lean.observations).toEqual([]);
    expect(served.observations).toEqual([]);
    expect(served.models).toEqual(full.models);
    expect(identity.mock.calls.some(([kind]) => kind === "ngram_observation")).toBe(false);
    expect({ models: lean.models, units: lean.units, patterns: lean.patterns, frames: lean.semanticFrames }).toEqual({ models: full.models, units: full.units, patterns: full.patterns, frames: full.semanticFrames });
    identity.mockRestore();
  });

  it("includes profile ownership in semantic-frame identity", () => {
    const hasher = createHasher();
    const compiler = createNgramMemoryCompiler({
      hasher,
      idFactory: createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true })
    });
    const evidence = span("evidence.shared", "\uAC00\uB098\uB2E4 \uB77C\uB9C8\uBC14");
    const first = profile("profile.first", "source.first");
    const second = profile("profile.second", "source.second");

    const left = compiler.compile({ streamId: "stream.first", profile: first, sourceVersionId: first.sourceVersionId, text: evidence.text, evidence: [evidence], createdAt: 1 });
    const right = compiler.compile({ streamId: "stream.second", profile: second, sourceVersionId: second.sourceVersionId, text: evidence.text, evidence: [evidence], createdAt: 1 });

    expect(left.semanticFrames[0]?.id).not.toBe(right.semanticFrames[0]?.id);
    expect(left.semanticFrames[0]?.frameJson).toMatchObject({ profileId: first.id, sourceVersionId: evidence.sourceVersionId });
    expect(right.semanticFrames[0]?.frameJson).toMatchObject({ profileId: second.id, sourceVersionId: evidence.sourceVersionId });
  });

  it("classifies Hangul units without losing unknown or mixed-script units", () => {
    const hasher = createHasher();
    const compiler = createNgramMemoryCompiler({
      hasher,
      idFactory: createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true })
    });
    const learned = profile("profile.mixed", "source.mixed");
    learned.scripts = [{ script: "script:Hang", mass: 0.5 }, { script: "script:unregistered", mass: 0.5 }];
    const evidence = span("evidence.mixed", "\uAC00\uB098\uB2E4 \u10D0\u10D1\u10D2");
    const compiled = compiler.compile({ streamId: "stream.mixed", profile: learned, sourceVersionId: learned.sourceVersionId, text: evidence.text, evidence: [evidence], createdAt: 1 });

    expect(compiled.units.some(unit => unit.script === "script:Hang")).toBe(true);
    expect(compiled.units.some(unit => unit.script.startsWith("script:opaque:block:"))).toBe(true);
    expect(new Set(compiled.units.map(unit => unit.profileId))).toEqual(new Set([learned.id]));
  });

  it("includes profile ownership in n-gram identities for a shared source", () => {
    const hasher = createHasher();
    const compiler = createNgramMemoryCompiler({
      hasher,
      idFactory: createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true })
    });
    const evidence = span("evidence.shared-source", "qelari venatu qelari venatu");
    const first = profile("profile.first", "source.shared");
    const second = profile("profile.second", "source.shared");
    const input = { streamId: "stream.shared", sourceVersionId: first.sourceVersionId, text: evidence.text, evidence: [evidence], createdAt: 1 };
    const left = compiler.compile({ ...input, profile: first });
    const right = compiler.compile({ ...input, profile: second });

    expect(left.models[0]?.id).not.toBe(right.models[0]?.id);
    expect(left.observations[0]?.id).not.toBe(right.observations[0]?.id);
  });

  it("preserves a source-declared corpus system across every language-memory record family", () => {
    const hasher = createHasher();
    const compiler = createNgramMemoryCompiler({
      hasher,
      idFactory: createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true })
    });
    const learned = profile("profile.owned", "source.owned");
    const evidence = span("evidence.owned", "qelari venatu qelari venatu");
    const compiled = compiler.compile({
      streamId: "stream.owned",
      sourceSystem: "workspace",
      profile: learned,
      sourceVersionId: learned.sourceVersionId,
      text: evidence.text,
      evidence: [evidence],
      createdAt: 1
    });

    expect(compiled.observations[0]?.metadata).toMatchObject({ sourceSystem: "workspace" });
    expect(compiled.models[0]?.modelJson).toMatchObject({ sourceSystem: "workspace" });
    expect(compiled.units[0]?.metadata).toMatchObject({ sourceSystem: "workspace" });
    expect(compiled.patterns[0]?.patternJson).toMatchObject({ sourceSystem: "workspace" });
    expect(compiled.semanticFrames[0]?.frameJson).toMatchObject({ sourceSystem: "workspace" });
  });

  it("compiles long-form discourse and narrative structure into hydrated language priors", () => {
    const hasher = createHasher();
    const idFactory = createIdFactory({ clock: createClock({ fixedTime: 1 }), hasher, deterministicReplay: true });
    const compiler = createNgramMemoryCompiler({ hasher, idFactory });
    const learned = profile("profile.narrative", "source.narrative");
    const text = [
      "The lantern moved across the ridge. The watcher waited.",
      "",
      "\u201cKeep the signal low,\u201d Mira said.",
      "\u2014Then we cross before dawn.",
      "",
      "The lantern vanished. The watcher followed the old path."
    ].join("\n");
    const evidence = span("evidence.narrative", text);

    const compiled = compiler.compile({
      streamId: "stream.narrative",
      sourceSystem: "gutenberg",
      profile: learned,
      sourceVersionId: learned.sourceVersionId,
      text,
      evidence: [evidence],
      createdAt: 1
    });

    const discourse = compiled.patterns.find(pattern => pattern.patternKind === "discourse");
    const narrative = compiled.patterns.find(pattern => pattern.patternKind === "narrative");
    expect(discourse?.patternJson).toMatchObject({
      schema: "scce.long_form_discourse_pattern.v1",
      sourceSystem: "gutenberg",
      paragraphCount: 3
    });
    expect(narrative?.patternJson).toMatchObject({
      schema: "scce.narrative_surface_pattern.v1",
      sourceSystem: "gutenberg"
    });

    const state = createLanguageMemoryRuntime({ hasher, idFactory }).hydrate({
      models: compiled.models,
      observations: compiled.observations,
      units: compiled.units,
      patterns: compiled.patterns,
      semanticFrames: compiled.semanticFrames
    });
    expect(state.importedPatterns.some(pattern => pattern.patternKind === "discourse")).toBe(true);
    expect(state.importedPatterns.some(pattern => pattern.patternKind === "narrative")).toBe(true);
    expect(state.competenceVector.generationReliability).toBeGreaterThan(0);
  });
});

function profile(id: string, sourceVersionId: string): LanguageProfile {
  return {
    id,
    sourceVersionId: sourceVersionId as LanguageProfile["sourceVersionId"],
    scripts: [{ script: "script:Hang", mass: 1 }],
    symbolShapes: [],
    charNgrams: [{ ngram: "\uAC00\uB098\uB2E4", count: 1 }],
    direction: "ltr",
    entropy: 0.2,
    createdAt: 1
  };
}

function span(id: string, text: string): EvidenceSpan {
  return {
    id: id as EvidenceSpan["id"],
    sourceId: `source.${id}` as EvidenceSpan["sourceId"],
    sourceVersionId: `source-version.${id}` as EvidenceSpan["sourceVersionId"],
    chunkId: `chunk.${id}` as EvidenceSpan["chunkId"],
    contentHash: `hash.${id}` as EvidenceSpan["contentHash"],
    mediaType: "text/plain",
    byteStart: 0,
    byteEnd: new TextEncoder().encode(text).byteLength,
    charStart: 0,
    charEnd: text.length,
    text,
    textPreview: text,
    languageHints: {},
    scriptHints: {},
    trustVector: { trust: 0.9, forceClass: "direct_evidence" },
    provenance: { source: "ngram-memory-profile-ownership.test" },
    features: featureSet(text, 256),
    status: "promoted",
    alpha: 0.9,
    observedAt: 1
  };
}
