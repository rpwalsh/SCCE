// How does a shard's training cost scale with the text in it?
//
// A shard accumulates ngramShardChars (2,400,000 by default) before it trains. Measured on scce5, the page
// phase of one run took ~41 minutes for 684 articles and the training that followed took ~89 minutes, so the
// shard is where the time goes. If that cost is linear in text, a smaller shard buys nothing overall. If it is
// superlinear, the budget is the lever and the fix is a number, not an algorithm.
//
//   SCCE_CONFIG=scce.config.json node --max-old-space-size=7168 tools/shard-compile-scaling.mjs scce5_runtime
import { readScceRuntimeConfig, createNodeRuntime } from "../packages/adapters-node/dist/index.js";
import {
  compileLanguageTrainingBatch,
  createLanguageMemoryRuntime,
  createClock,
  createIdFactory,
  createHasher
} from "../packages/kernel/dist/index.js";

const config = await readScceRuntimeConfig(process.env.SCCE_CONFIG ?? "scce.config.json");
const schema = process.argv[2];
if (schema) config.database = { ...config.database, schema };
const runtime = createNodeRuntime(config);
const hasher = createHasher();
const idFactory = createIdFactory({ clock: createClock(), hasher });

const profiles = await runtime.storage.model.listLanguageProfiles(1);
const profile = profiles[0];
if (!profile) throw new Error("no language profile on file");

// Read enough real spans to build the largest batch under test.
const target = Number(process.argv[3] ?? 1_200_000);
const spans = [];
let chars = 0;
// Whole source versions, which is what a shard actually accumulates.
const backed = await runtime.storage.evidence.listEvidenceBackedSourceVersions({ limit: 400 });
for (const row of backed) {
  const found = await runtime.storage.evidence.searchEvidence({
    sourceVersionId: row.sourceVersionId, status: "promoted", limit: 200
  });
  for (const hit of found) {
    const span = hit.span;
    if (!span?.text?.trim()) continue;
    spans.push(span);
    chars += span.text.length;
  }
  if (chars >= target) break;
}
console.log(`pool: ${spans.length} spans, ${chars} chars`);

function batchOf(limitChars) {
  const picked = [];
  let used = 0;
  for (const span of spans) {
    if (used + span.text.length > limitChars) break;
    picked.push(span);
    used += span.text.length;
  }
  return { evidence: picked, text: picked.map(s => s.text).join("\n"), chars: used };
}

console.log(`${"chars".padStart(10)} ${"spans".padStart(6)} ${"ms".padStart(9)} ${"ms/100k".padStart(9)}  growth`);
let previous;
for (const limit of [150_000, 300_000, 600_000, 1_200_000]) {
  const batch = batchOf(limit);
  if (!batch.evidence.length) break;
  const started = Date.now();
  compileLanguageTrainingBatch({
    runtime: createLanguageMemoryRuntime({ idFactory, hasher }),
    hasher,
    batch: {
      streamId: "profile://shard-scaling",
      sourceSystem: "wikimedia:wikipedia",
      profile,
      sourceVersionId: String(batch.evidence[0].sourceVersionId),
      text: batch.text,
      evidence: batch.evidence,
      createdAt: Date.now(),
      maxOrder: 3,
      maxCountersPerOrder: 12000,
      vocabularyLimit: 24000
    }
  });
  const ms = Date.now() - started;
  const per100k = Math.round((ms / batch.chars) * 100_000);
  console.log(
    `${String(batch.chars).padStart(10)} ${String(batch.evidence.length).padStart(6)} `
    + `${String(ms).padStart(9)} ${String(per100k).padStart(9)}  ${previous ? (ms / previous).toFixed(2) + "x" : ""}`
  );
  previous = ms;
}
console.log("\nlinear = 2.00x per doubling and a flat ms/100k; superlinear = higher, and the budget is the lever");
process.exit(0);
