/**
 * Offline anchor-group harness: the retrieval feature groups a request produces, with no database.
 *
 * Each case supplies the corpus signal the live turn was primed with. `spread` and `concentration` are measured
 * against the live corpus (distinct sources carrying every unit of a run, and the Otsu split of that distribution
 * the running system reports); `closedClass` is the scaffolding the live `turn.corpus_identity` trace shows the
 * turn split its content runs on. Nothing here is invented: it is recorded system state, replayed offline.
 *
 * Usage: pnpm retrieval:anchor-groups (vite-node tools/anchor-group-harness.mts <cases.json>)
 */
import fs from "node:fs";

import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../packages/kernel/src/corpus-identity.js";
import { createClock, createHasher } from "../packages/kernel/src/primitives.js";
import { createRuntimeGraphRetrieval } from "../packages/kernel/src/runtime-graph-retrieval.js";

interface HarnessCase {
  readonly question: string;
  readonly closedClass?: readonly string[];
  readonly identities?: readonly string[];
  readonly spread?: ReadonlyArray<readonly [string, number]>;
  readonly concentration?: number;
  /** Where the answer lives, so a reachability pass can say whether any group can seed it. */
  readonly answeringSource?: string;
}

async function groupsFor(text: string): Promise<{ groups: string[][]; durationMs: number }> {
  const graph = { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
  const traces: any[] = [];
  const storage = {
    graph: { getSlice: async () => graph },
    evidence: { getEvidenceBatch: async () => [], searchEvidence: async () => [] }
  } as any;
  const runtime = createRuntimeGraphRetrieval({
    deps: { storage },
    clock: createClock({ fixedTime: 1_000 }),
    hasher: createHasher(),
    candidates: undefined as never,
    failures: [] as string[],
    cacheMs: 0,
    kernelTrace: (event: any) => traces.push(event),
    sourceAnchorSemanticFramesCached: async () => []
  } as any);
  const started = process.hrtime.bigint();
  await runtime.graphForText(text, { sourceAnchoringRequired: true, residentOnly: true });
  const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
  const event = traces.find(candidate => candidate.stage === "graph.resolve.anchor_evidence_search");
  return { groups: event?.support?.anchorFeatureGroups ?? [], durationMs };
}

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
  const { groups, durationMs } = await groupsFor(entry.question);
  out.push({
    question: entry.question,
    answeringSource: entry.answeringSource,
    groups,
    features: [...new Set(groups.flat())].sort(),
    groupCount: groups.length,
    buildMs: Number(durationMs.toFixed(3))
  });
}
console.log(JSON.stringify(out, null, 1));
