// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRuntimeGraphRetrieval } from "../runtime-graph-retrieval.js";
import { sourceIdentityAdmissibleEvidenceForRequest } from "../local-evidence-runtime.js";
import { createClock, createHasher } from "../primitives.js";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import type { EvidenceSearchResult, ScceKernelDeps } from "../storage.js";
import type { EvidenceSpan, GraphSlice, GraphSliceQuery } from "../types.js";

const NL = String.fromCharCode(10);

// The live language identity's own measured closed class, so the anchors here are the anchors the turn forms.
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
const manager = corpusSpan("file_manager", "https://en.wikipedia.org/wiki/File_manager", "file manager", "text/x-wiki",
  "A 'file manager' or 'file browser' is a computer program that provides a user interface to manage files and folders. It copies, moves and renames them.");

function retrieval(rows: readonly EvidenceSpan[]) {
  const graph: GraphSlice = { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
  const getSlice = vi.fn(async (_query: GraphSliceQuery) => graph);
  const getEvidenceBatch = vi.fn(async () => []);
  const searchEvidence = vi.fn(async (): Promise<EvidenceSearchResult[]> =>
    rows.map(row => ({ span: row, score: 1, reason: "test" }) as unknown as EvidenceSearchResult));
  const kernelTrace = vi.fn();
  const storage = { graph: { getSlice }, evidence: { getEvidenceBatch, searchEvidence } } as unknown as ScceKernelDeps["storage"];
  return createRuntimeGraphRetrieval({
    deps: { storage },
    clock: createClock({ fixedTime: 1_000 }),
    hasher: createHasher(),
    candidates: undefined as never,
    failures: [] as string[],
    cacheMs: 60_000,
    kernelTrace,
    sourceAnchorSemanticFramesCached: async () => []
  });
}

describe("a source that declares the identifier a request names is evidence for it", () => {
  afterEach(() => clearCorpusIdentitySignals());

  it("keeps the declaring source in the retrieval pool of a question that is not a program request", async () => {
    // Measured live at 365ca06: "Which file defines createProgramPlanner?" retrieved 78 spans, promoted 29 and
    // admitted the File viewer and File manager articles; the two promoted program-planner.ts spans that carry
    // `anchor:sym:createprogramplanner` never reached admission.
    primeCorpusIdentitySignals({
      closedClass: CLOSED,
      identities: new Set(["program planner", "file viewer", "file manager", "createprogramplanner"]),
      spread: new Map(),
      concentration: 1
    });
    const slice = await retrieval([planner, viewer, manager])
      .graphForText("Which file defines createProgramPlanner?", { sourceAnchoringRequired: true, residentOnly: true });

    expect(slice.evidence?.map(row => String(row.id))).toContain("evidence_span.program_planner_declaration");
  });

  it("admits the declaring source, and not an article merely titled with a word of the question", () => {
    primeCorpusIdentitySignals({
      closedClass: CLOSED,
      identities: new Set(["program planner", "file viewer", "file manager", "createprogramplanner"]),
      spread: new Map(),
      concentration: 1
    });
    const admitted = sourceIdentityAdmissibleEvidenceForRequest(
      "Which file defines createProgramPlanner?",
      [planner, viewer, manager],
      new Set(),
      CLOSED
    );

    expect(admitted.evidence.map(row => String(row.id))).toEqual(["evidence_span.program_planner_declaration"]);
  });

  it("still yields to a source exactly titled with the subject, so prose keeps a prose question", () => {
    // The declaration branch matches any source file whose body carries a named unit of the request, including a
    // comment naming a person. A corpus that holds the article about her answers from the article.
    primeCorpusIdentitySignals({
      closedClass: CLOSED,
      identities: new Set(["ada lovelace"]),
      spread: new Map(),
      concentration: 1
    });
    const article = corpusSpan("ada_lovelace_article", "https://en.wikipedia.org/wiki/Ada_Lovelace", "ada lovelace", "text/x-wiki",
      "Ada Lovelace was an English mathematician born on 10 December 1815 in London. She is known for her work on the Analytical Engine.");
    const comment = corpusSpan("source_comment", "packages/kernel/src/fixture.ts", "fixture", "text/plain; charset=utf-8", [
      "// Ada Lovelace was born on 10 December 1815; this comment names her.",
      "export function loveLaceBirthFixture(options) {",
      "  return options;",
      "}"
    ].join(NL));

    const admitted = sourceIdentityAdmissibleEvidenceForRequest("When was Ada Lovelace born?", [article, comment], new Set(), CLOSED);

    expect(admitted.evidence.map(row => String(row.id))).toEqual(["evidence_span.ada_lovelace_article"]);
  });
});
