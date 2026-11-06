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
import { realizeLearnedSurface } from "../language-construction.js";
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
    const expected = first.trained.constructionPatterns.map(pattern => pattern.id).sort();
    expect(expected.length).toBeGreaterThan(0);
    const seen = new Set(expected);
    let qualified = false;
    for (const size of [2, 5, 10]) {
      const prior = Array.from({ length: size }, (_, index) => ({ ...own,
        id: ids.evidenceId({ sourceVersionId: ids.sourceVersionId(`prior.${index}`), byteStart: 0, byteEnd: own.byteEnd, spanHash: own.contentHash }),
        sourceId: ids.sourceId("fixture", `source://prior.${index}`), sourceVersionId: ids.sourceVersionId(`prior.${index}`) }));
      const next = compile(text, [own], [own, ...prior]);
      expect(next.trained.constructionPatterns.map(pattern => pattern.id).sort()).toEqual(expected);
      expect(next.restarted.importedConstructionBundles.every(bundle => bundle.sourceExamples.every(example => example.evidenceId === own.id))).toBe(true);
      qualified ||= next.restarted.importedConstructionBundles.some(bundle => bundle.qualificationStatus === "document_heldout_qualified");
      for (const pattern of next.trained.constructionPatterns) seen.add(pattern.id);
    }
    expect(qualified).toBe(true);
    expect(seen.size).toBe(expected.length);
  });
  it("retains and rehydrates real single-document source forms without claiming document-heldout qualification", () => {
    const text = readFileSync(new URL("./fixtures/animalia-source.md", import.meta.url), "utf8");
    expect(Buffer.byteLength(text)).toBe(2357);
    const { trained, restarted, evidence } = compile(text);
    expect(evidence).toHaveLength(1);
    expect(trained.constructionCandidates).toBeGreaterThan(0);
    expect(trained.constructionPatterns.length).toBeGreaterThan(0);
    expect(trained.rejectedConstructionCandidates).toBe(0);
    expect(trained.constructionPromotion.promotedInducedConstructionSets).toBe(0);
    expect(trained.constructionPromotion.sourceObservedInducedConstructionSets).toBe(trained.constructionPatterns.length);
    expect(trained.constructionPromotion.rejections.every(row => row.reason === "no_heldout_evidence")).toBe(true);
    expect(restarted.rejectedConstructionPatterns).toEqual([]);
    expect(restarted.importedConstructionBundles).toHaveLength(trained.constructionPatterns.length);
    expect(restarted.importedConstructionBundles.every(bundle => bundle.acquisitionStatus === "source_observed")).toBe(true);
    const realizations = restarted.importedConstructionBundles.flatMap(bundle => bundle.sourceExamples.map(example => {
      expect([...text].slice(example.surfaceStartCodePoint, example.surfaceEndCodePoint).join("")).toBe(example.surface);
      return realizeLearnedSurface({ hasher, constructions: bundle.constructions, formClasses: bundle.formClasses, plan: {
        id: example.id, profileKey: bundle.targetProfileId,
        roleSignature: [...new Set([...example.roles, ...example.nullRoles].map(role => role.roleId))],
        slots: [
          ...example.roles.map(role => ({ roleId: role.roleId, occurrenceId: role.occurrenceId, variants: [{ id: `${example.id}.${role.occurrenceId}`, profileKey: bundle.targetProfileId, surface: role.surface, evidenceIds: [example.evidenceId] }] })),
          ...example.nullRoles.map(role => ({ roleId: role.roleId, occurrenceId: role.occurrenceId, realization: "null" as const, variants: [], evidenceIds: [example.evidenceId] }))
        ]
      } });
    }));
    expect(realizations.some(result => result.status === "realized")).toBe(true);
    expect(realizations.filter(result => result.status === "realized").every(result => result.status === "realized" && result.realization.provenance.verification === "unverified")).toBe(true);
    const missing = createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns: trained.constructionPatterns, constructionEvidence: [] });
    expect(missing.importedConstructionBundles).toEqual([]);
    const altered = structuredClone(trained.constructionPatterns);
    const row = altered[0]!.patternJson as { bundle: { acquisitionStatus: string } };
    row.bundle.acquisitionStatus = "document_heldout_qualified";
    expect(createLanguageMemoryRuntime({ hasher }).hydrate({ models: [], patterns: [altered[0]!], constructionEvidence: evidence }).importedConstructionBundles).toEqual([]);
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
