import { describe, expect, it } from "vitest";
import { createIdFactory } from "../ids.js";
import { createNgramMemoryCompiler } from "../ngram-memory.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import type { EvidenceSpan, LanguageProfile } from "../types.js";

describe("n-gram memory profile ownership", () => {
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
