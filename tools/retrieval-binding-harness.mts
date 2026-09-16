/**
 * Offline retrieval-binding harness: what each retrieval path carries forward, with no database.
 *
 * Every path in runtime-graph-retrieval decides for itself whether a candidate is relevant to the request. This
 * replays the same request and the same candidate pool through all three and prints what each admitted, so a
 * change that consolidates them can be read as a blast radius rather than asserted.
 *
 * The corpus signal per case is the live measurement the anchor-group harness already replays (`spread`,
 * `concentration`, `closedClass`); the candidate pool is fixed and mixed: the answering article, an unrelated
 * article, a source file whose comment merely names the subject, and a source file that declares an identifier
 * the request names.
 *
 * Usage: pnpm retrieval:bindings (vite-node tools/retrieval-binding-harness.mts <cases.json>)
 */
import fs from "node:fs";

import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../packages/kernel/src/corpus-identity.js";
import { createClock, createHasher } from "../packages/kernel/src/primitives.js";
import { createRuntimeGraphRetrieval } from "../packages/kernel/src/runtime-graph-retrieval.js";

const NL = String.fromCharCode(10);

interface HarnessCase {
  readonly question: string;
  readonly closedClass?: readonly string[];
  readonly identities?: readonly string[];
  readonly spread?: ReadonlyArray<readonly [string, number]>;
  readonly concentration?: number;
  readonly answeringSource?: string;
}

function span(id: string, uri: string, title: string, mediaType: string, text: string): any {
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
    provenance: { uri, byteRange: [0, text.length], charRange: [0, text.length], chunkHash: `sha256_${id}_chunk`, sourceVersionId: `source_version.${id}`, metadata: { title } }
  };
}

function poolFor(entry: HarnessCase): any[] {
  const subject = entry.answeringSource || entry.question;
  const pool = [
    span("unrelated_article", "https://en.wikipedia.org/wiki/File_manager", "file manager", "text/x-wiki",
      "A 'file manager' or 'file browser' is a computer program that provides a user interface to manage files and folders."),
    span("comment_mentions_subject", "packages/kernel/src/mouth.ts", "mouth", "text/plain; charset=utf-8", [
      `// ${subject} is named in this comment only as an example.`,
      "export function realizeSurface(plan) {",
      "  return plan.surface;",
      "}"
    ].join(NL)),
    span("planner_declaration", "packages/kernel/src/program-planner.ts", "program planner", "text/plain; charset=utf-8", [
      "// Program planning over the corpus's own measured quantities.",
      "export function createProgramPlanner(options) {",
      "  const planner = buildPlanner(options);",
      "  return planner;",
      "}"
    ].join(NL))
  ];
  if (entry.answeringSource) {
    pool.unshift(span("answering_article", `https://en.wikipedia.org/wiki/${entry.answeringSource.replace(/ /gu, "_")}`,
      entry.answeringSource.toLocaleLowerCase(), "text/x-wiki",
      `${entry.answeringSource} is the subject of this article. It carries the sentence the request asks for.`));
  }
  return pool;
}

function retrieval(rows: readonly any[]) {
  const graph = { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
  const storage = {
    graph: { getSlice: async () => graph },
    evidence: {
      getEvidenceBatch: async () => [],
      searchEvidence: async () => rows.map(row => ({ span: row, score: 1, reason: "harness" }))
    }
  } as any;
  return createRuntimeGraphRetrieval({
    deps: { storage },
    clock: createClock({ fixedTime: 1_000 }),
    hasher: createHasher(),
    candidates: undefined as never,
    failures: [] as string[],
    cacheMs: 0,
    kernelTrace: () => undefined,
    sourceAnchorSemanticFramesCached: async () => []
  } as any);
}

const shortId = (row: any) => String(row.id).replace("evidence_span.", "");

const cases: HarnessCase[] = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
const out: Array<Record<string, unknown>> = [];
for (const entry of cases) {
  clearCorpusIdentitySignals();
  primeCorpusIdentitySignals({
    closedClass: new Set<string>(entry.closedClass ?? []),
    identities: new Set<string>(entry.identities ?? []),
    spread: new Map<string, number>((entry.spread ?? []).map(pair => [pair[0], pair[1]])),
    concentration: entry.concentration ?? 0
  });
  const pool = poolFor(entry);
  const started = process.hrtime.bigint();
  const anchored = await retrieval(pool).graphForText(entry.question, { sourceAnchoringRequired: true, residentOnly: true });
  const unanchored = await retrieval(pool).graphForText(entry.question, { sourceAnchoringRequired: false });
  const evidenceOnly = await retrieval(pool).evidenceOnlyForText(entry.question, false, false);
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  out.push({
    question: entry.question,
    anchored: (anchored.evidence ?? []).map(shortId).sort(),
    unanchored: (unanchored.evidence ?? []).map(shortId),
    evidenceOnly: (evidenceOnly.evidence ?? []).map(shortId),
    pathMs: Number(durationMs.toFixed(3))
  });
}
console.log(JSON.stringify(out, null, 1));
