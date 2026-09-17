// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, describe, expect, it } from "vitest";

import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import { createClock, createHasher } from "../primitives.js";
import { createRuntimeGraphRetrieval } from "../runtime-graph-retrieval.js";

const NL = String.fromCharCode(10);

const CLOSED = new Set(["which", "when", "was", "the", "of", "is", "a", "in", "s"]);

/**
 * The search the database actually runs, as far as source kind is concerned.
 *
 * `excludeSourceKinds` deleted the named kinds from the candidate set before ranking; `deprioritizeSourceKinds`
 * ranks them behind every other kind and deletes nothing. Both are honoured here so the two regimes can be
 * compared over one pool, and so reverting the kernel hunk puts the erasure back and fails these assertions.
 */
function storageFor(pool: readonly any[]) {
  const kindOf = (span: any) => String(span.provenance?.sourceKind ?? span.provenance?.metadata?.sourceKind ?? "");
  return {
    graph: { getSlice: async () => ({ nodes: [], edges: [], hyperedges: [], bounded: true, query: {} }) },
    evidence: {
      getEvidenceBatch: async () => [],
      searchEvidence: async (query: any) => {
        const excluded: string[] = query?.excludeSourceKinds ?? [];
        const deprioritized: string[] = query?.deprioritizeSourceKinds ?? [];
        const kept = pool.filter(span => !excluded.includes(kindOf(span)));
        return kept
          .map((span, index) => ({ span, index, rank: deprioritized.includes(kindOf(span)) ? 1 : 0 }))
          .sort((left, right) => left.rank - right.rank || left.index - right.index)
          .slice(0, query?.limit ?? 80)
          .map(entry => ({ span: entry.span, score: 1, reason: "frontier fixture" }));
      }
    }
  } as any;
}

function retrieval(pool: readonly any[]) {
  return createRuntimeGraphRetrieval({
    deps: { storage: storageFor(pool) },
    clock: createClock({ fixedTime: 1_000 }),
    hasher: createHasher(),
    candidates: undefined as never,
    failures: [] as string[],
    cacheMs: 0,
    kernelTrace: () => undefined,
    sourceAnchorSemanticFramesCached: async () => []
  } as any);
}

let nextSpan = 0;
function span(kind: string, uri: string, title: string, mediaType: string, text: string, identity = ""): any {
  const id = `f${nextSpan++}`;
  return {
    id: `evidence_span.${id}`,
    sourceId: `source.${id}`,
    sourceVersionId: `source_version.${id}`,
    chunkId: `chunk.${id}`,
    contentHash: `sha256_${id}`,
    mediaType,
    text,
    textPreview: text.slice(0, 80),
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
    features: [],
    provenance: {
      uri,
      sourceKind: kind,
      byteRange: [0, text.length],
      charRange: [0, text.length],
      chunkHash: `sha256_${id}_chunk`,
      sourceVersionId: `source_version.${id}`,
      // Measured over every posting of anchor:sym:bestevidencesentences: the 20 repository spans carry a title
      // and a derived identity, the 48 training-dump spans carry neither. That asymmetry is what separates the
      // file from the training corpus's copy of the same file, so the fixture has to carry it.
      ...(identity ? { title, identity } : {}),
      metadata: { title }
    }
  };
}

const repeat = <T,>(count: number, make: (index: number) => T): T[] => Array.from({ length: count }, (_, index) => make(index));

// Live composition of `anchor:sym:bestevidencesentences` over the promoted store, measured read-only 2026-09-16:
// 46 construction_training, 20 developer_intelligence, 2 with no declared kind, 1 local_document.
const DECLARING_TEXT = [
  "function bestEvidenceSentences(requestText: string, evidence: readonly EvidenceSpan[]): string[] {",
  "  // Mirrors proposeSourceExactEvidenceAnswer's ranking contract exactly.",
  "  return rankSentences(requestText, evidence);",
  "}"
].join(NL);
const TRAINING_TEXT = [
  "export function proposeSourceExactEvidenceAnswer(input: {",
  "  requestText: string;",
  "  selectedEvidence: readonly EvidenceSpan[];",
  "}) {",
  "  return input;",
  "}"
].join(NL);

function identifierPool(): any[] {
  return [
    ...repeat(46, index => span("construction_training", `scce://construction-training/source.5ab6da6d/batch-${index}`, "", "text/plain", TRAINING_TEXT)),
    ...repeat(20, () => span("developer_intelligence", "packages/kernel/src/local-evidence-runtime.ts", "local evidence runtime",
      "text/plain; charset=utf-8", DECLARING_TEXT, "local evidence runtime import bestEvidenceSentences")),
    ...repeat(2, index => span("", `scce://construction-training/source.5ab6da6d/batch-x${index}`, "", "text/plain", TRAINING_TEXT)),
    span("local_document", "docs/IMPLEMENTATION_STATUS.md", "", "text/markdown",
      "the title-lead boost's coverage transfer ported to bestEvidenceSentences so who-played-X questions reach the deeper cast sentence.")
  ];
}

// Live composition of `anchor:sym:lovelace`: 354 construction_training, 169 developer_intelligence, 30 with no
// declared kind, 29 wikimedia_dump, 6 local_document. The prose frontier is already saturated at limit 64.
const LOVELACE_ARTICLE = "Ada Lovelace was born on 10 December 1815. She was an English mathematician and writer, chiefly known for her work on Charles Babbage's Analytical Engine.";
const LOVELACE_MENTION = [
  "// Ada Lovelace born 1815 is used here only as an example in a fixture.",
  "export function fixture(options) {",
  "  return options;",
  "}"
].join(NL);

function proseSpans(): any[] {
  return [
    ...repeat(29, index => span("wikimedia_dump", `wikipedia://enwiki/pages/974/Ada_Lovelace#${index}`, "Ada Lovelace", "text/x-wiki", LOVELACE_ARTICLE)),
    ...repeat(6, index => span("local_document", `docs/EVALUATION_PROTOCOL.md#${index}`, "", "text/plain; charset=utf-8",
      "Corpus: four documents byte-exact-dumped from the live blobs table, each verified against its stored content hash (Star Trek, TOS, DS9, Ada Lovelace).")),
    ...repeat(30, index => span("", `scce://construction-training/source.5ab6da6d/batch-y${index}`, "", "text/plain", LOVELACE_MENTION))
  ];
}

function deprioritizedSpans(): any[] {
  return [
    ...repeat(354, index => span("construction_training", `scce://construction-training/source.5ab6da6d/batch-z${index}`, "", "text/plain", LOVELACE_MENTION)),
    ...repeat(169, () => span("developer_intelligence", "packages/kernel/src/mouth.ts", "mouth", "text/plain; charset=utf-8",
      LOVELACE_MENTION, "mouth import realizeSurface"))
  ];
}

const admittedIds = async (pool: readonly any[], question: string) =>
  (await retrieval(pool).graphForText(question, { sourceAnchoringRequired: true, residentOnly: true }))
    .evidence.map((entry: any) => String(entry.id));

const urisOf = (pool: readonly any[], ids: readonly string[]) =>
  ids.map(id => String(pool.find(entry => String(entry.id) === id)?.provenance?.uri ?? ""));

describe("source kind is a frontier rank, not an erasure", () => {
  afterEach(() => clearCorpusIdentitySignals());

  it("retrieves the file that declares the identifier without any code-generation activation", () => {
    // The law-4 headline. `sourceCodeEvidenceAllowed` is false here: no programPlanning, no workspaceRepair, no
    // executableArtifactDemand. Under the SQL exclusion the 20 developer_intelligence spans of the declaring file
    // were deleted before ranking, so the only survivors were a markdown status doc and two untyped training rows.
    primeCorpusIdentitySignals({
      closedClass: CLOSED,
      identities: new Set<string>(),
      spread: new Map([["file defines bestevidencesentences", 1], ["file", 960], ["defines", 181], ["bestevidencesentences", 12]]),
      concentration: 289
    });
    const pool = identifierPool();
    return admittedIds(pool, "Which file defines bestEvidenceSentences?").then(ids => {
      expect(urisOf(pool, ids)).toContain("packages/kernel/src/local-evidence-runtime.ts");
    });
  });

  it("admits exactly the prose the erasure admitted for a prose question", async () => {
    // The deliverable is not removing the exclusion, it is removing it without losing prose. The frontier is
    // saturated by prose at this anchor (65 non-deprioritized rows against limit 64), so the rank must hand back
    // the identical rows the erasure did, in the identical order.
    const prime = () => primeCorpusIdentitySignals({
      closedClass: CLOSED,
      identities: new Set(["ada lovelace", "ada"]),
      spread: new Map([["ada lovelace born", 31], ["ada", 244], ["lovelace", 112], ["born", 6780]]),
      concentration: 289
    });
    const question = "When was Ada Lovelace born?";

    prime();
    const erasureUniverse = proseSpans();
    const before = urisOf(erasureUniverse, await admittedIds(erasureUniverse, question));
    clearCorpusIdentitySignals();

    prime();
    const wholeUniverse = [...proseSpans(), ...deprioritizedSpans()];
    const after = urisOf(wholeUniverse, await admittedIds(wholeUniverse, question));

    expect(after).toEqual(before);
    expect(before.length).toBeGreaterThan(0);
  });
});
