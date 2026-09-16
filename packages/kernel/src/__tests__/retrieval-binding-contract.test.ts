// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeGraphRetrieval } from "../runtime-graph-retrieval.js";
import { createClock, createHasher } from "../primitives.js";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import type { EvidenceSearchResult, ScceKernelDeps } from "../storage.js";
import type { EvidenceSpan, GraphSlice, GraphSliceQuery } from "../types.js";

const NL = String.fromCharCode(10);

const CLOSED = new Set(["the", "in", "a", "of", "and", "to", "was", "is", "as", "on", "for", "by", "at", "with", "s", "from"]);

function span(partial: Record<string, unknown>): EvidenceSpan {
  const text = String(partial.text);
  return {
    languageHints: ["en"],
    scriptHints: ["Latn"],
    trustVector: { reliability: 1, corroboration: 1, recency: 1 },
    status: "promoted",
    alpha: 1,
    observedAt: new Date(1000).toISOString(),
    byteStart: 0,
    byteEnd: text.length,
    charStart: 0,
    charEnd: text.length,
    textPreview: text.slice(0, 80),
    features: [],
    ...partial
  } as unknown as EvidenceSpan;
}

function corpusSpan(id: string, uri: string, title: string, mediaType: string, text: string): EvidenceSpan {
  return span({
    id: `evidence_span.${id}`,
    sourceId: `source.${id}`,
    sourceVersionId: `source_version.${id}`,
    chunkId: `chunk.${id}`,
    contentHash: `sha256_${id}`,
    mediaType,
    text,
    provenance: {
      uri,
      byteRange: [0, text.length],
      charRange: [0, text.length],
      chunkHash: `sha256_${id}_chunk`,
      sourceVersionId: `source_version.${id}`,
      metadata: { title }
    }
  });
}

const PLANNER_BODY = [
  "// Program planning over the corpus's own measured quantities.",
  "export function createProgramPlanner(options) {",
  "  const planner = buildPlanner(options);",
  "  return planner;",
  "}"
].join(NL);

const planner = corpusSpan("program_planner_declaration", "packages/kernel/src/program-planner.ts", "program planner", "text/plain; charset=utf-8", PLANNER_BODY);
const viewer = corpusSpan("file_viewer", "https://en.wikipedia.org/wiki/File_viewer", "file viewer", "text/x-wiki",
  "A 'file viewer' is a utility application software on operating systems, such as Linux, macOS and Windows. It presents the contents of a file to the user.");

function retrieval(rows: readonly EvidenceSpan[]) {
  const graph: GraphSlice = { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
  const getSlice = vi.fn(async (_query: GraphSliceQuery) => graph);
  const getEvidenceBatch = vi.fn(async () => []);
  const searchEvidence = vi.fn(async (): Promise<EvidenceSearchResult[]> =>
    rows.map(row => ({ span: row, score: 1, reason: "test" }) as unknown as EvidenceSearchResult));
  const storage = { graph: { getSlice }, evidence: { getEvidenceBatch, searchEvidence } } as unknown as ScceKernelDeps["storage"];
  return createRuntimeGraphRetrieval({
    deps: { storage },
    clock: createClock({ fixedTime: 1_000 }),
    hasher: createHasher(),
    candidates: undefined as never,
    failures: [] as string[],
    cacheMs: 0,
    kernelTrace: vi.fn(),
    sourceAnchorSemanticFramesCached: async () => []
  });
}

function prime(): void {
  primeCorpusIdentitySignals({
    closedClass: CLOSED,
    identities: new Set(["program planner", "file viewer", "createprogramplanner"]),
    spread: new Map(),
    concentration: 1
  });
}

const REQUEST = "Which file defines createProgramPlanner?";

describe("every retrieval path decides admissibility from the same binding", () => {
  afterEach(() => clearCorpusIdentitySignals());

  it("keeps the declaring source on the source-anchored path", async () => {
    prime();
    const slice = await retrieval([planner, viewer]).graphForText(REQUEST, { sourceAnchoringRequired: true, residentOnly: true });
    expect(slice.evidence?.map(row => String(row.id))).toContain("evidence_span.program_planner_declaration");
  });

  it("keeps the declaring source on the unanchored graph path too", async () => {
    // graphForTextUncached is a production fallback for the same turn text (production-turn-runtime withFallback
    // chain) and 77 traced turns reached the unanchored branch. It drops every code span outright.
    prime();
    const slice = await retrieval([planner, viewer]).graphForText(REQUEST, { sourceAnchoringRequired: false });
    expect(slice.evidence?.map(row => String(row.id))).toContain("evidence_span.program_planner_declaration");
  });

  it("keeps the declaring source on the evidence-only path too", async () => {
    // evidenceOnlyForText's unanchored branch is the last fallback of the same chain.
    prime();
    const slice = await retrieval([planner, viewer]).evidenceOnlyForText(REQUEST, false, false);
    expect(slice.evidence?.map(row => String(row.id))).toContain("evidence_span.program_planner_declaration");
  });
});
