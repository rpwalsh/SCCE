import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createHydrationPlan } from "../hydration-runtime.js";

describe("controlled hydration runtime", () => {
  it("plans the checked-in SCCE2-compatible brain deterministically without DB writes", async () => {
    const fixture = path.resolve("examples/scce2-controlled-brain");
    const first = await createHydrationPlan(fixture, { hashWorkExtentBytes: 1024 * 1024, maxHashBytesPerFile: 1024 * 1024 });
    const second = await createHydrationPlan(fixture, { hashWorkExtentBytes: 1024 * 1024, maxHashBytesPerFile: 1024 * 1024 });

    expect(first.planId).toBe(second.planId);
    expect(first.safeToHydrate).toBe(true);
    expect(first.filesFound).toBeGreaterThanOrEqual(2);
    expect(first.importableSections.some(section => section.kind === "graph")).toBe(true);
    expect(first.importableSections.some(section => section.kind === "language")).toBe(true);
    expect(first.recordCountsByFamily.graph_nodes).toBeGreaterThan(0);
    expect(first.recordCountsByFamily.language_units).toBeGreaterThan(0);
    expect(first.destinationTables.graph_nodes).toBeGreaterThan(0);
    expect(first.destinationTables.language_units).toBeGreaterThan(0);
    expect(first.directEvidenceSourceSpanCoverage.directEvidenceSpans).toBe(1);
    expect(first.directEvidenceSourceSpanCoverage.directEvidenceWithExactSourceSpan).toBe(1);
    expect(first.directEvidenceSourceSpanCoverage.profileExcerptEvidenceSpans).toBe(1);
    expect(first.sourceCompletionPlan.safeToHydrate).toBe(true);
    expect(first.warnings.some(item => item.includes("brain bundle"))).toBe(true);
  });

  it("rejects explicit direct evidence without exact source/span and refuses empty success", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scce-hydrate-plan-"));
    try {
      await mkdir(path.join(root, "language"), { recursive: true });
      await writeJson(path.join(root, "language", "language-shard-0001.profile.json"), {
        schema: "scce.learnedLanguageProfileShard.v1",
        sourceId: "bad-direct-evidence",
        shardId: "language-shard-0001",
        languageId: "bad-fixture-language",
        script: "Latn",
        confidence: 0.7,
        tokenizationProfile: { observedSymbols: [{ value: "azurite", count: 1 }] },
        fileEvidence: [
          {
            id: "bad-direct",
            title: "bad direct evidence",
            excerpt: "This row asked to be direct evidence but has no source span.",
            forceClass: "direct_evidence"
          }
        ]
      });

      const bad = await createHydrationPlan(root);
      expect(bad.safeToHydrate).toBe(false);
      expect(bad.directEvidenceSourceSpanCoverage.directEvidenceRejectedForMissingSourceSpan).toBe(1);
      expect(JSON.stringify(bad.missingRequiredFields)).toContain("direct_evidence_requires_exact_source_span");

      const empty = await mkdtemp(path.join(os.tmpdir(), "scce-hydrate-empty-"));
      try {
        const emptyPlan = await createHydrationPlan(empty);
        expect(emptyPlan.safeToHydrate).toBe(false);
        expect(emptyPlan.warnings).toContain("hydrate plan found zero importable SCCE2 sections");
      } finally {
        await rm(empty, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("plans root-level SCCE2 hexagram prose/code states as unique learned priors", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "scce-hydrate-hexagram-"));
    try {
      await writeFile(path.join(root, "hexagram-prose.bin"), Buffer.from("SCCE prose binary sample"));
      await writeFile(path.join(root, "hexagram-prose.v8"), Buffer.from("SCCE prose v8 sample"));
      await writeFile(path.join(root, "hexagram-code.bin"), Buffer.from("SCCE code binary sample"));
      await writeFile(path.join(root, "hexagram-code.v8"), Buffer.from("SCCE code v8 sample"));

      const plan = await createHydrationPlan(root, { hashWorkExtentBytes: 1024 * 1024, maxHashBytesPerFile: 1024 * 1024 });
      expect(plan.safeToHydrate).toBe(true);
      expect(plan.filesFound).toBe(4);
      expect(plan.importableSections.map(section => section.id).sort()).toEqual([
        "hexagram-code-bin",
        "hexagram-code-v8",
        "hexagram-prose-bin",
        "hexagram-prose-v8"
      ]);
      expect(plan.learnedPriorCounts.language).toBe(2);
      expect(plan.learnedPriorCounts.program).toBe(2);
      expect(plan.missingRequiredFields).toEqual([]);
      expect(plan.sourceCompletionPlan.duplicateIdempotencyConflicts).toEqual([]);
      expect(plan.destinationTables.ngram_models).toBe(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
