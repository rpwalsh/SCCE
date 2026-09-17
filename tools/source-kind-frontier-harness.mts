/**
 * Offline source-kind frontier harness: what the finite retrieval frontier admits when a source kind is deleted
 * before ranking, and what it admits when the same kind is ranked last instead.
 *
 * The retrieval binding harness cannot see this: its fake search returns every row it is given, so the SQL
 * source-kind rule never runs. This one models the search the database actually performs -- candidate pool,
 * source-kind policy, LIMIT -- over the live posting compositions measured read-only against the promoted store,
 * and replays each request through the production retrieval twice, once under each policy.
 *
 * `erasure` is what `excludeSourceKinds` did; `rank` is what `deprioritizeSourceKinds` does. Prose recall is the
 * deliverable, so the two admitted lists are printed side by side per question.
 *
 * Usage: pnpm retrieval:source-kind-frontier (vite-node tools/source-kind-frontier-harness.mts <cases.json>)
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
  readonly anchor: string;
  readonly answeringUri?: string;
  readonly proseTitle?: string;
  /** The construction-training dump holds wiki prose as well as repository files; "prose" models the half that
   *  no code predicate can reject, which is the only shape that could take a frontier slot from an article. */
  readonly trainingShape?: "code" | "prose";
  readonly composition: Readonly<Record<string, number>>;
}

let nextSpan = 0;
function span(kind: string, uri: string, title: string, mediaType: string, text: string): any {
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
      metadata: { title }
    }
  };
}

/** The repository span the identifier question is about: the file that declares it. */
const declaringText = (identifier: string) => [
  `function ${identifier}(requestText: string, evidence: readonly EvidenceSpan[]): string[] {`,
  "  // Mirrors proposeSourceExactEvidenceAnswer's ranking contract exactly.",
  "  return rankSentences(requestText, evidence);",
  "}"
].join(NL);

/** A repository span that merely mentions the subject: the row that outranked Wikipedia before the binding landed. */
const mentioningText = (subject: string) => [
  `// ${subject} is used here only as an example name in a fixture.`,
  "export function fixture(options) {",
  "  return options;",
  "}"
].join(NL);

function identifierOf(question: string): string {
  const units = question.replace(/[?]/gu, "").split(/\s+/u).filter(Boolean);
  return units[units.length - 1] ?? "";
}

function poolFor(entry: HarnessCase): any[] {
  const identifier = identifierOf(entry.question);
  const subject = entry.proseTitle ?? identifier;
  const body = entry.answeringUri ? declaringText(identifier) : mentioningText(subject);
  const pool: any[] = [];
  for (const [kind, count] of Object.entries(entry.composition)) {
    for (let index = 0; index < count; index++) {
      if (kind === "wikimedia_dump") {
        pool.push(span(kind, `wikipedia://enwiki/pages/${index}/${subject.replace(/ /gu, "_")}`, subject, "text/x-wiki",
          `${subject} is the subject of this article. ${subject} was born on 10 December 1815 and it carries the sentence the request asks for.`));
      } else if (kind === "developer_intelligence") {
        pool.push(span(kind, entry.answeringUri ?? "packages/kernel/src/mouth.ts", "", "text/plain; charset=utf-8", body));
      } else if (kind === "local_document") {
        pool.push(span(kind, `docs/NOTES_${index}.md`, "", "text/markdown",
          `Release notes mentioning ${subject} and ${identifier} among other work.`));
      } else {
        const trainingBody = entry.trainingShape === "prose"
          ? `${subject} is discussed here. Lying is strongly discouraged and forbidden by most interpretations of Christianity, and ${subject} was born on 10 December 1815.`
          : mentioningText(subject);
        pool.push(span(kind, `scce://construction-training/source.5ab6da6d/batch-${kind}-${index}`, "", "text/plain", trainingBody));
      }
    }
  }
  return pool;
}

/** The database's own source-kind rule, both regimes, over one pool. */
function storageFor(pool: readonly any[], policy: "erasure" | "rank") {
  const kindOf = (candidate: any) => String(candidate.provenance?.sourceKind ?? candidate.provenance?.metadata?.sourceKind ?? "");
  return {
    graph: { getSlice: async () => ({ nodes: [], edges: [], hyperedges: [], bounded: true, query: {} }) },
    evidence: {
      getEvidenceBatch: async () => [],
      searchEvidence: async (query: any) => {
        const named: string[] = query?.deprioritizeSourceKinds ?? query?.excludeSourceKinds ?? [];
        const kept = policy === "erasure" ? pool.filter(candidate => !named.includes(kindOf(candidate))) : [...pool];
        return kept
          .map((candidate, index) => ({ candidate, index, rank: policy === "rank" && named.includes(kindOf(candidate)) ? 1 : 0 }))
          .sort((left, right) => left.rank - right.rank || left.index - right.index)
          .slice(0, query?.limit ?? 80)
          .map(entry => ({ span: entry.candidate, score: 1, reason: "frontier fixture" }));
      }
    }
  } as any;
}

function retrieval(pool: readonly any[], policy: "erasure" | "rank") {
  return createRuntimeGraphRetrieval({
    deps: { storage: storageFor(pool, policy) },
    clock: createClock({ fixedTime: 1_000 }),
    hasher: createHasher(),
    candidates: undefined as never,
    failures: [] as string[],
    cacheMs: 0,
    kernelTrace: () => undefined,
    sourceAnchorSemanticFramesCached: async () => []
  } as any);
}

const cases: HarnessCase[] = JSON.parse(fs.readFileSync(process.argv[2]!, "utf8"));
const out: Array<Record<string, unknown>> = [];
for (const entry of cases) {
  const report: Record<string, unknown> = { question: entry.question, anchor: entry.anchor, postings: entry.composition };
  for (const policy of ["erasure", "rank"] as const) {
    clearCorpusIdentitySignals();
    primeCorpusIdentitySignals({
      closedClass: new Set<string>(entry.closedClass ?? []),
      identities: new Set<string>(entry.identities ?? []),
      spread: new Map<string, number>((entry.spread ?? []).map(pair => [pair[0], pair[1]])),
      concentration: entry.concentration ?? 0
    });
    const pool = poolFor(entry);
    const byId = new Map(pool.map(candidate => [String(candidate.id), candidate]));
    const started = process.hrtime.bigint();
    const slice = await retrieval(pool, policy).graphForText(entry.question, { sourceAnchoringRequired: true, residentOnly: true });
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    const admitted = slice.evidence.map((admittedSpan: any) => byId.get(String(admittedSpan.id)));
    const kinds: Record<string, number> = {};
    for (const admittedSpan of admitted) {
      const kind = String(admittedSpan?.provenance?.sourceKind ?? "") || "(none)";
      kinds[kind] = (kinds[kind] ?? 0) + 1;
    }
    report[policy] = {
      admitted: admitted.length,
      byKind: kinds,
      answeringUriAdmitted: entry.answeringUri
        ? admitted.some((admittedSpan: any) => String(admittedSpan?.provenance?.uri ?? "") === entry.answeringUri)
        : undefined,
      proseAdmitted: admitted.filter((admittedSpan: any) => {
        const kind = String(admittedSpan?.provenance?.sourceKind ?? "");
        return kind !== "developer_intelligence" && kind !== "construction_training";
      }).length,
      ms: Number(ms.toFixed(3))
    };
  }
  out.push(report);
}
clearCorpusIdentitySignals();
process.stdout.write(`${JSON.stringify(out, undefined, 1)}${NL}`);
