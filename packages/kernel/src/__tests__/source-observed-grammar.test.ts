// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { compileLanguageTrainingBatch } from "../language-training-batch.js";
import { createLanguageMemoryRuntime } from "../language-memory-runtime.js";
import { createLanguageAcquisitionEngine } from "../language.js";
import { createEvidenceExtractor } from "../evidence.js";
import { createHasher, createClock } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import type { EvidenceSpan } from "../types.js";

const hasher = createHasher();
const ids = createIdFactory({ hasher, clock: createClock({ fixedTime: 140_000, stepMs: 1 }), deterministicReplay: true, namespace: "source-observed-grammar" });
const language = createLanguageAcquisitionEngine({ idFactory: ids });

function compile(text: string, evidence?: EvidenceSpan[], constructionEvidence?: EvidenceSpan[]) {
  const sourceVersionId = ids.sourceVersionId(text);
  const profile = language.acquire({ sourceVersionId, text, createdAt: 140_000 });
  evidence ??= createEvidenceExtractor({ idFactory: ids, hasher }).extract({
    sourceId: ids.sourceId("fixture", "source://Animalia"), sourceVersionId, namespace: "fixture", uri: "source://Animalia",
    mediaType: "text/plain", text, languageProfile: profile, observedAt: 140_000, maxChunkBytes: 65_536, exactSourceText: true,
    sourceTrust: { identity: 1, integrity: 1, parserReliability: 1, directness: 1, authority: 1, freshness: 1, independenceGroup: "fixture", accessScope: "fixture", licenseStatus: "fixture" }
  }).spans.map(span => ({ ...span, status: "promoted" as const }));
  const trained = compileLanguageTrainingBatch({ runtime: createLanguageMemoryRuntime({ hasher, idFactory: ids }), hasher,
    batch: { streamId: "source://ordinary", profile, sourceVersionId, text, evidence, constructionEvidence, createdAt: 140_000, maxOrder: 3, maxCountersPerOrder: 64 } });
  const restarted = createLanguageMemoryRuntime({ hasher, idFactory: ids }).hydrate({ models: [], patterns: trained.patterns, constructionEvidence: evidence });
  return { trained, restarted, evidence };
}

describe("ordinary source grammar acquisition", () => {
  it("updates qualification through a growing independent pool without copying prior observations or changing owned grammar identities", () => {
    const text = "luma f9 q1. vela f9 q2. luma f9 q2. vela f9 q1.";
    const first = compile(text);
    const own = first.evidence[0]!;
    const expected = [...first.trained.sourceObservedConstructionPatternIds].sort();
    expect(expected.length).toBeGreaterThan(0);
    expect(first.trained.constructionPatterns).toEqual([]);
    expect(first.restarted.importedConstructionBundles).toEqual([]);
    const seen = new Set(expected);
    let qualified = false;
    for (const size of [2, 5, 10]) {
      const prior = Array.from({ length: size }, (_, index) => ({ ...own,
        id: ids.evidenceId({ sourceVersionId: ids.sourceVersionId(`prior.${index}`), byteStart: 0, byteEnd: own.byteEnd, spanHash: own.contentHash }),
        sourceId: ids.sourceId("fixture", `source://prior.${index}`), sourceVersionId: ids.sourceVersionId(`prior.${index}`) }));
      const next = compile(text, [own], [own, ...prior]);
      expect([...next.trained.constructionPatterns.map(pattern => pattern.id), ...next.trained.sourceObservedConstructionPatternIds].sort()).toEqual(expected);
      expect(next.restarted.importedConstructionBundles.every(bundle => bundle.sourceExamples.every(example => example.evidenceId === own.id))).toBe(true);
      expect(next.restarted.importedConstructionBundles.every(bundle => bundle.qualificationStatus === "document_heldout_qualified")).toBe(true);
      qualified ||= next.restarted.importedConstructionBundles.some(bundle => bundle.qualificationStatus === "document_heldout_qualified");
      for (const pattern of next.trained.constructionPatterns) seen.add(pattern.id);
    }
    expect(qualified).toBe(true);
    expect(seen.size).toBe(expected.length);
  });
  it("keeps real single-document source forms in diagnostics and a deterministic receipt without activating them", () => {
    const text = readFileSync(new URL("./fixtures/animalia-source.md", import.meta.url), "utf8");
    expect(Buffer.byteLength(text)).toBe(2357);
    const { trained, restarted, evidence } = compile(text);
    expect(evidence).toHaveLength(1);
    expect(trained.constructionCandidates).toBeGreaterThan(0);
    const publishedConstructions = trained.constructionPatterns.filter(pattern =>
      (pattern.patternJson as { schema?: string }).schema === "scce.language_construction_pattern.v1");
    const speechPatterns = publishedConstructions.filter(isCreativeSpeechPattern);
    expect(publishedConstructions.filter(pattern => !isCreativeSpeechPattern(pattern))).toEqual([]);
    expect(speechPatterns.length).toBeGreaterThan(0);
    expect(trained.sourceObservedConstructionPatternIds).toHaveLength(51);
    expect(trained).not.toHaveProperty("sourceObservedConstructionPatterns");
    expect(trained.rejectedConstructionCandidates).toBe(0);
    expect(trained.constructionPromotion.promotedInducedConstructionSets).toBe(0);
    expect(trained.constructionPromotion.sourceObservedInducedConstructionSets).toBeGreaterThanOrEqual(trained.sourceObservedConstructionPatternIds.length);
    expect(trained.constructionPromotion.rejections.every(row => row.reason === "no_heldout_evidence")).toBe(true);
    expect(restarted.rejectedConstructionPatterns).toEqual([]);
    expect(restarted.importedConstructionBundles.filter(bundle =>
      !bundle.creativeEvents?.length && !bundle.bindingId.startsWith("surface.creative_event.speech."))).toEqual([]);
    expect(restarted.importedConstructionBundles.filter(bundle =>
      bundle.bindingId.startsWith("surface.creative_event.speech.")).length).toBe(speechPatterns.length);
    expect(trained.sourceObservedConstructionPatternIds.length
      / Math.max(1, publishedConstructions.filter(pattern => !isCreativeSpeechPattern(pattern)).length)).toBeGreaterThan(10);
    expect(trained.patterns.some(pattern => trained.sourceObservedConstructionPatternIds.includes(pattern.id))).toBe(false);
    expect(trained.constructionObservationReceipt).toMatchObject({
      candidateCount: trained.sourceObservedConstructionPatternIds.length,
      sourceEvidenceCount: 1,
      sourceEvidenceIds: [String(evidence[0]!.id)],
      sourceEvidenceIdsTruncated: false
    });
    expect(trained.constructionObservationReceipt.observationCount).toBeGreaterThanOrEqual(trained.constructionObservationReceipt.candidateCount);
    expect(trained.constructionObservationReceipt.observationDigestRecipe).toBe("sha256.canonical_observation_digests.v1");
    expect(trained.constructionObservationReceipt.observationDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(trained.constructionObservationReceipt.recomputationIdentity).toMatch(/^[a-f0-9]{64}$/u);
    expect(compile(text).trained.constructionObservationReceipt).toEqual(trained.constructionObservationReceipt);
  });

  it("does not treat chunks or versions of a canonical document as heldout documents", () => {
    const text = "cat chased mouse. dog chased mouse. cat chased ball. dog chased ball.";
    const first = compile(text).evidence[0]!;
    const evidence = Array.from({ length: 5 }, (_, index) => ({ ...first,
      id: ids.evidenceId({ sourceVersionId: ids.sourceVersionId(`version.${index}`), byteStart: 0, byteEnd: first.byteEnd, spanHash: first.contentHash }),
      sourceVersionId: ids.sourceVersionId(`version.${index}`)
    }));
    const { trained } = compile(text, evidence);
    expect(trained.constructionPromotion.heldOutDocumentIds).toEqual([]);
    expect(trained.constructionPromotion.trainDocumentIds).toEqual([String(first.sourceId)]);
    expect(trained.constructionPromotion.promotedInducedConstructionSets).toBe(0);
    expect(trained.constructionPromotion.sourceObservedInducedConstructionSets).toBeGreaterThan(0);
  });

  it("keeps independently heldout documents disjoint and preserves qualification failures", () => {
    const text = "cat chased mouse. dog chased mouse. cat chased ball. dog chased ball.";
    const first = compile(text).evidence[0]!;
    const evidence = Array.from({ length: 12 }, (_, index) => ({ ...first,
      id: ids.evidenceId({ sourceVersionId: ids.sourceVersionId(`independent.${index}`), byteStart: 0, byteEnd: first.byteEnd, spanHash: first.contentHash }),
      sourceVersionId: ids.sourceVersionId(`independent.${index}`), sourceId: ids.sourceId("fixture", `source://independent.${index}`)
    }));
    const { trained, restarted } = compile(text, evidence);
    const report = trained.constructionPromotion;
    expect(report.heldOutDocumentIds.length).toBeGreaterThan(0);
    expect(report.trainDocumentIds.every(id => !report.heldOutDocumentIds.includes(id))).toBe(true);
    expect(report.promotedInducedConstructionSets).toBeGreaterThan(0);
    expect(restarted.importedConstructionBundles.some(bundle => bundle.qualificationStatus === "document_heldout_qualified")).toBe(true);
  });
});

function isCreativeSpeechPattern(pattern: { patternJson: unknown }): boolean {
  const row = pattern.patternJson as { schema?: string; bundle?: { bindingId?: string } };
  return row.schema === "scce.language_construction_pattern.v1"
    && row.bundle?.bindingId?.startsWith("surface.creative_event.speech.") === true;
}
