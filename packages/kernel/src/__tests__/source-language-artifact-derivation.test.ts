// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it, vi } from "vitest";
import { canonicalDigestHex } from "../canonical-json-digest.js";
import type { IdFactory } from "../ids.js";
import { createIdFactory } from "../ids.js";
import { createNgramMemoryCompiler } from "../ngram-memory.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import {
  DEFAULT_SOURCE_LANGUAGE_ARTIFACT_DERIVATION_LIMITS,
  MAX_SOURCE_LANGUAGE_COUNTERS_PER_ORDER,
  MAX_SOURCE_LANGUAGE_VOCABULARY,
  SOURCE_LANGUAGE_ARTIFACT_DERIVATION_SCHEMA,
  deriveSourceLanguageArtifacts,
  mergeSourceDerivedLanguageUnitMetadata,
  mergeSourceDerivedSemanticFrameBody,
  normalizeSourceLanguageArtifactCompilerOptions,
  separateSourceDerivedLanguageUnitMetadata,
  separateSourceDerivedSemanticFrameBody,
  sourceLanguageArtifactFloat32StorageDigest,
  type SourceLanguageArtifactDerivationInput,
  type SourceLanguageArtifactDerivationReceipt
} from "../source-language-artifact-derivation.js";
import { SOURCE_ROLE_PROJECTION_SUPPLEMENTARY_BLANK } from "../unicode-segmentation.js";
import type { EvidenceSpan, LanguageProfile } from "../types.js";

describe("source-derived language artifact replay", () => {
  it("matches the independent pre-extraction producer oracle and the integrated producer", () => {
    const fixture = replayFixture();
    const derived = deriveSourceLanguageArtifacts(fixture);
    const compiled = createNgramMemoryCompiler({ hasher: fixture.hasher, idFactory: fixture.idFactory }).compile({
      ...compilerInput(fixture),
      maxOrder: 6,
      maxCountersPerOrder: 128,
      vocabularyLimit: 512
    });

    expect({ units: derived.units, semanticFrames: derived.semanticFrames })
      .toEqual({ units: compiled.units, semanticFrames: compiled.semanticFrames });
    expect(compiled.sourceArtifactDerivation).toEqual({ receipt: derived.receipt, measurement: derived.measurement });
    // Frozen against the old, independent ngram-memory producer before its
    // unit/frame implementation was extracted into the replay primitive. The
    // oracle includes ordinary whitespace/control graphemes; only SCCE's
    // reserved source-role marker is excluded.
    expect(canonicalDigestHex({ units: derived.units, semanticFrames: derived.semanticFrames }, fixture.hasher))
      .toBe("67b4c903c008d7c2bf92bf1c2544f5c83d88bb6a6b5420c298fdbc456cd72236");
    expect(derived.units.every(unit => unit.evidenceIds.join("|") === "evidence.replay.0|evidence.replay.1")).toBe(true);
    expect(derived.semanticFrames.map(frame => frame.evidenceIds)).toEqual([["evidence.replay.0"], ["evidence.replay.1"]]);
    expect(derived.receipt.compilerOptions).toEqual(fixture.compilerOptions);
  });

  it("keeps the complete 4/5/6-gram producer behavior while replaying invariant unit/frame rows", () => {
    let invariant: unknown;
    for (const maxOrder of [4, 5, 6]) {
      const fixture = replayFixture({ maxOrder });
      const compiled = createNgramMemoryCompiler({ hasher: fixture.hasher, idFactory: fixture.idFactory }).compile({
        ...compilerInput(fixture),
        maxOrder,
        maxCountersPerOrder: 128,
        vocabularyLimit: 512
      });
      const derived = deriveSourceLanguageArtifacts(fixture);
      expect(compiled.models[0]?.maxOrder).toBe(maxOrder);
      expect([...new Set(compiled.observations.map(row => row.order))].sort((a, b) => a - b))
        .toEqual(Array.from({ length: maxOrder }, (_, index) => index + 1));
      expect({ units: compiled.units, semanticFrames: compiled.semanticFrames })
        .toEqual({ units: derived.units, semanticFrames: derived.semanticFrames });
      const rows = { units: derived.units, semanticFrames: derived.semanticFrames };
      if (invariant === undefined) invariant = rows;
      else expect(rows).toEqual(invariant);
    }
  });

  it("preserves pre-extraction behavior for legacy evidence without a materialized preview", () => {
    const fixture = replayFixture();
    const evidence = fixture.evidence.map(span => {
      const legacy: Partial<EvidenceSpan> = { ...span };
      delete legacy.textPreview;
      return legacy as EvidenceSpan;
    });
    const input = { ...fixture, evidence };
    const derived = deriveSourceLanguageArtifacts(input);
    const compiled = createNgramMemoryCompiler({ hasher: fixture.hasher, idFactory: fixture.idFactory }).compile({
      ...compilerInput(input),
      maxOrder: 6,
      maxCountersPerOrder: 128,
      vocabularyLimit: 512
    });

    expect(derived.measurement.evidenceUtf8Bytes).toBe(evidence.reduce((sum, span) =>
      sum + new TextEncoder().encode(span.text).byteLength, 0));
    expect(derived.semanticFrames.every(frame =>
      (frame.frameJson as Record<string, unknown>).preview === null)).toBe(true);
    expect({ units: compiled.units, semanticFrames: compiled.semanticFrames })
      .toEqual({ units: derived.units, semanticFrames: derived.semanticFrames });
    expect(deriveSourceLanguageArtifacts(input).receipt).toEqual(derived.receipt);
  });

  it("rejects receipt tampering, version/dependency drift and a different semantic-ID producer", () => {
    const fixture = replayFixture();
    const original = deriveSourceLanguageArtifacts(fixture);
    expect(deriveSourceLanguageArtifacts({ ...fixture, expectedReceipt: original.receipt }).receipt).toEqual(original.receipt);

    const tampered = { ...original.receipt, sourceTextHash: "tampered" };
    expect(() => deriveSourceLanguageArtifacts({ ...fixture, expectedReceipt: tampered }))
      .toThrow(/receipt was changed/u);
    const wrongVersion = { ...original.receipt, schema: "scce.source_language_artifact_derivation.v2" } as unknown as SourceLanguageArtifactDerivationReceipt;
    expect(() => deriveSourceLanguageArtifacts({ ...fixture, expectedReceipt: wrongVersion }))
      .toThrow(/unsupported source language artifact derivation version/u);

    const semanticId = vi.spyOn(fixture.idFactory, "semanticId");
    expect(() => deriveSourceLanguageArtifacts({ ...fixture, text: `${fixture.text}!`, expectedReceipt: original.receipt }))
      .toThrow(/dependencies changed/u);
    expect(semanticId).not.toHaveBeenCalled();
    semanticId.mockRestore();
    expect(() => deriveSourceLanguageArtifacts({
      ...fixture,
      profile: { ...fixture.profile, entropy: fixture.profile.entropy + 0.01 },
      expectedReceipt: original.receipt
    })).toThrow(/dependencies changed/u);
    expect(() => deriveSourceLanguageArtifacts({
      ...fixture,
      evidence: fixture.evidence.map((span, index) => index ? span : { ...span, alpha: span.alpha - 0.01 }),
      expectedReceipt: original.receipt
    })).toThrow(/dependencies changed/u);
    expect(() => deriveSourceLanguageArtifacts({
      ...fixture,
      compilerOptions: { ...fixture.compilerOptions, maxOrder: 5 },
      expectedReceipt: original.receipt
    })).toThrow(/dependencies changed/u);

    const alternateIds = alternateSemanticIdFactory(fixture.idFactory);
    expect(() => deriveSourceLanguageArtifacts({ ...fixture, idFactory: alternateIds, expectedReceipt: original.receipt }))
      .toThrow(/artifacts changed/u);
  });

  it("reports deterministic replay cost/bytes and enforces non-overridable input/output ceilings", () => {
    const fixture = replayFixture();
    const derived = deriveSourceLanguageArtifacts(fixture);
    const evidenceBytes = fixture.evidence.reduce((sum, span) => sum
      + new TextEncoder().encode(span.text).byteLength
      + new TextEncoder().encode(span.textPreview).byteLength, 0);
    expect(derived.measurement).toMatchObject({
      sourceUtf8Bytes: new TextEncoder().encode(fixture.text).byteLength,
      evidenceUtf8Bytes: evidenceBytes,
      artifactJsonUtf8Bytes: new TextEncoder().encode(JSON.stringify({ units: derived.units, semanticFrames: derived.semanticFrames })).byteLength,
      units: derived.units.length,
      semanticFrames: derived.semanticFrames.length
    });
    expect(derived.measurement.reconstructionWorkUnits).toBeGreaterThan(derived.measurement.sourceUtf8Bytes);

    expect(() => deriveSourceLanguageArtifacts({ ...fixture, limits: { maxSourceUtf8Bytes: 1 } }))
      .toThrow(/source-byte limit/u);
    expect(() => deriveSourceLanguageArtifacts({ ...fixture, limits: { maxSourceUtf16Units: 1 } }))
      .toThrow(/source-UTF16 limit/u);
    expect(() => deriveSourceLanguageArtifacts({ ...fixture, limits: { maxEvidenceSpans: 1 } }))
      .toThrow(/evidence-span limit/u);
    expect(() => deriveSourceLanguageArtifacts({ ...fixture, limits: { maxArtifactJsonUtf8Bytes: 1 } }))
      .toThrow(/artifact-byte limit/u);
    expect(() => deriveSourceLanguageArtifacts({
      ...fixture,
      limits: { maxSourceUtf8Bytes: DEFAULT_SOURCE_LANGUAGE_ARTIFACT_DERIVATION_LIMITS.maxSourceUtf8Bytes + 1 }
    })).toThrow(/no greater than/u);
    expect(() => normalizeSourceLanguageArtifactCompilerOptions({
      maxCountersPerOrder: MAX_SOURCE_LANGUAGE_COUNTERS_PER_ORDER + 1
    })).toThrow(/positive bounded integers/u);
    expect(() => normalizeSourceLanguageArtifactCompilerOptions({
      vocabularyLimit: MAX_SOURCE_LANGUAGE_VOCABULARY + 1
    })).toThrow(/positive bounded integers/u);
  });

  it("preserves raw NUL/Unicode dependencies, excludes projected blanks, and compares vectors at PostgreSQL Float32 precision", () => {
    const fixture = replayFixture();
    const nulText = `alpha\u0000beta 漢字 alpha beta`;
    const nulEvidence = [span("evidence.nul", nulText, 0)];
    const nul = deriveSourceLanguageArtifacts({ ...fixture, text: nulText, evidence: nulEvidence });
    const spaced = deriveSourceLanguageArtifacts({ ...fixture, text: nulText.replace("\u0000", " "), evidence: [span("evidence.nul", nulText.replace("\u0000", " "), 0)] });
    expect(nul.receipt.sourceTextHash).not.toBe(spaced.receipt.sourceTextHash);
    expect(nul.receipt.evidenceDependencyDigest).not.toBe(spaced.receipt.evidenceDependencyDigest);
    const nulCompiled = createNgramMemoryCompiler({ hasher: fixture.hasher, idFactory: fixture.idFactory }).compile({
      ...compilerInput({ ...fixture, text: nulText, evidence: nulEvidence }),
      maxOrder: 6,
      maxCountersPerOrder: 128,
      vocabularyLimit: 512
    });
    expect({ units: nul.units, semanticFrames: nul.semanticFrames })
      .toEqual({ units: nulCompiled.units, semanticFrames: nulCompiled.semanticFrames });

    const projectedText = `alpha${SOURCE_ROLE_PROJECTION_SUPPLEMENTARY_BLANK} beta alpha beta`;
    const projectedEvidence = [span("evidence.projected", projectedText, 0)];
    const projected = deriveSourceLanguageArtifacts({ ...fixture, text: projectedText, evidence: projectedEvidence });
    expect([...projected.projection.symbols, ...projected.projection.graphemes, ...projected.units.flatMap(unit => [unit.text, ...unit.features])]
      .some(value => value.includes(SOURCE_ROLE_PROJECTION_SUPPLEMENTARY_BLANK))).toBe(false);
    const projectedCompiled = createNgramMemoryCompiler({ hasher: fixture.hasher, idFactory: fixture.idFactory }).compile({
      ...compilerInput({ ...fixture, text: projectedText, evidence: projectedEvidence }),
      maxOrder: 6,
      maxCountersPerOrder: 128,
      vocabularyLimit: 512
    });
    expect(projectedCompiled.observations.some(row => row.symbol.includes(SOURCE_ROLE_PROJECTION_SUPPLEMENTARY_BLANK)
      || row.history.some(value => value.includes(SOURCE_ROLE_PROJECTION_SUPPLEMENTARY_BLANK)))).toBe(false);

    const roundedFrames = nul.semanticFrames.map(frame => ({ ...frame, embedding: Array.from(Float32Array.from(frame.embedding)) }));
    expect(roundedFrames.some((frame, frameIndex) => frame.embedding.some((value, index) => value !== nul.semanticFrames[frameIndex]!.embedding[index]))).toBe(true);
    expect(sourceLanguageArtifactFloat32StorageDigest({ units: nul.units, semanticFrames: roundedFrames, hasher: fixture.hasher }))
      .toBe(nul.receipt.artifactStorageDigest);
  });

  it("keeps durability-owned and unknown JSON envelopes outside replay-owned fields", () => {
    const unitMetadata = {
      profileEntropy: 0.375,
      sourceSystem: "wikipedia",
      shape: "LLLLL",
      sourceCompilationId: "compilation.fixture",
      futureOwner: { version: 9, opaque: ["keep", "this"] }
    };
    const unit = separateSourceDerivedLanguageUnitMetadata(unitMetadata);
    expect(unit.derived).toEqual({ profileEntropy: 0.375, sourceSystem: "wikipedia", shape: "LLLLL" });
    expect(unit.envelope).toEqual({ sourceCompilationId: "compilation.fixture", futureOwner: { version: 9, opaque: ["keep", "this"] } });
    expect(mergeSourceDerivedLanguageUnitMetadata(unit)).toEqual(unitMetadata);

    const frameJson = {
      sourceVersionId: "source-version.fixture",
      profileId: "profile.fixture",
      evidenceId: "evidence.fixture",
      index: 0,
      textHash: "hash.fixture",
      preview: "preview",
      symbolCount: 1,
      featureSample: ["sym:preview"],
      roleSignature: [],
      sourceCompilationId: "compilation.fixture",
      unknownEnvelope: { retained: true }
    };
    const frame = separateSourceDerivedSemanticFrameBody(frameJson);
    expect(frame.envelope).toEqual({ sourceCompilationId: "compilation.fixture", unknownEnvelope: { retained: true } });
    expect(mergeSourceDerivedSemanticFrameBody(frame)).toEqual(frameJson);
    expect(() => mergeSourceDerivedSemanticFrameBody({ derived: frame.derived, envelope: { profileId: "override" } }))
      .toThrow(/cannot override profileId/u);
    expect(SOURCE_LANGUAGE_ARTIFACT_DERIVATION_SCHEMA).toBe("scce.source_language_artifact_derivation.v1");
  });
});

function replayFixture(overrides: { maxOrder?: number } = {}): SourceLanguageArtifactDerivationInput {
  const hasher = createHasher();
  const idFactory = createIdFactory({
    clock: createClock({ fixedTime: 1_700_000_000_000 }),
    hasher,
    deterministicReplay: true
  });
  const profile: LanguageProfile = {
    id: "profile.replay.oracle",
    sourceVersionId: "source-version.replay.oracle" as LanguageProfile["sourceVersionId"],
    scripts: [{ script: "script:Latn", mass: 0.7 }, { script: "script:Hani", mass: 0.3 }],
    symbolShapes: [],
    charNgrams: [{ ngram: "alpha", count: 4 }],
    direction: "ltr",
    entropy: 0.375,
    createdAt: 1_700_000_000_000
  };
  const first = "Alpha βeta alpha βeta. 漢字 alpha βeta.";
  const second = "Alpha βeta alpha βeta. Final 漢字 signal.";
  return {
    streamId: "stream.replay.oracle",
    sourceSystem: "wikipedia",
    profile,
    sourceVersionId: profile.sourceVersionId,
    text: `${first}\n${second}`,
    evidence: [span("evidence.replay.0", first, 0), span("evidence.replay.1", second, 1)],
    createdAt: 1_700_000_000_000,
    compilerOptions: normalizeSourceLanguageArtifactCompilerOptions({
      maxOrder: overrides.maxOrder ?? 6,
      maxCountersPerOrder: 128,
      vocabularyLimit: 512
    }),
    idFactory,
    hasher
  };
}

function compilerInput(input: Pick<SourceLanguageArtifactDerivationInput,
  "streamId" | "sourceSystem" | "profile" | "sourceVersionId" | "text" | "evidence" | "createdAt">) {
  return {
    streamId: input.streamId,
    sourceSystem: input.sourceSystem,
    profile: input.profile,
    sourceVersionId: input.sourceVersionId,
    text: input.text,
    evidence: [...input.evidence],
    createdAt: input.createdAt
  };
}

function span(id: string, text: string, index: number): EvidenceSpan {
  return {
    id: id as EvidenceSpan["id"],
    sourceId: "source.replay.oracle" as EvidenceSpan["sourceId"],
    sourceVersionId: "source-version.replay.oracle" as EvidenceSpan["sourceVersionId"],
    chunkId: `chunk.${index}` as EvidenceSpan["chunkId"],
    contentHash: `hash.${index}` as EvidenceSpan["contentHash"],
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
    provenance: { source: "pre-extraction-oracle" },
    features: featureSet(text, 256),
    status: "promoted",
    alpha: index ? 0.7 : 0.9,
    observedAt: 1_700_000_000_000
  };
}

function alternateSemanticIdFactory(idFactory: IdFactory): IdFactory {
  return new Proxy(idFactory, {
    get(target, property, receiver) {
      if (property === "semanticId") {
        const semanticId = target.semanticId.bind(target);
        return ((...args: Parameters<IdFactory["semanticId"]>) => `alternate.${semanticId(...args)}`) as IdFactory["semanticId"];
      }
      const value = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    }
  });
}
