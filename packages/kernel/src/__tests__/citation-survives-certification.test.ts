// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";

import { createProofCarryingAnswer } from "../proof-carrying-answer.js";
import type { EvidenceSpan } from "../types.js";

const SOURCE = "/** The real per-turn sync (items 217-218). If this turn has a fresh task decomposition, it persists a new snapshot. */";

const span = {
  id: "evidence_span.task_resumption",
  sourceId: "source.task_resumption",
  sourceVersionId: "source_version.task_resumption",
  chunkId: "chunk.task_resumption",
  contentHash: "sha256_task_resumption",
  mediaType: "text/typescript",
  byteStart: 0,
  byteEnd: SOURCE.length,
  charStart: 0,
  charEnd: SOURCE.length,
  text: SOURCE,
  textPreview: SOURCE.slice(0, 80),
  languageHints: ["en"],
  scriptHints: ["Latn"],
  trustVector: { reliability: 1, corroboration: 1, recency: 1 },
  provenance: {
    uri: "packages/kernel/src/task-resumption-turn-request.ts",
    title: "task resumption turn request",
    byteRange: [0, SOURCE.length],
    charRange: [0, SOURCE.length],
    chunkHash: "chunk_hash",
    sourceVersionId: "source_version.task_resumption"
  },
  features: [],
  status: "promoted",
  alpha: 1,
  observedAt: new Date(1000).toISOString()
} as unknown as EvidenceSpan;

const CLAIM = "The real per-turn sync (items 217-218).";
const CITATION = "\n\nSource: task resumption turn request";

/**
 * Why the turn cites the release and never the text it certifies.
 *
 * releaseText splits an answer into sentences and keeps only the ones evidence admits. A citation is not a claim
 * the answer makes, so it is never admitted, and attaching it before certification silently removed it from the
 * answer. Measured live 2026-09-16: every code row that held evidence spoke a source excerpt naming no source,
 * while the one branch that already set releaseAnswer itself kept its citation -- the same rule, written twice,
 * one copy wrong.
 */
describe("certification reads the claim, not the citation", () => {
  const pca = createProofCarryingAnswer();

  for (const force of ["observed", "inferred", "unknown"] as const) {
    it(`drops a citation attached before certification (${force})`, () => {
      expect(pca.certify({ answer: `${CLAIM}${CITATION}`, evidence: [span], force }).releaseAnswer)
        .not.toContain("Source:");
    });
  }

  it("returns the claim unchanged when the citation is kept out of it", () => {
    expect(pca.certify({ answer: CLAIM, evidence: [span], force: "observed" }).releaseAnswer).toBe(CLAIM);
  });
});
