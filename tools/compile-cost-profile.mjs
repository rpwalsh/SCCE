// Profiles compileLanguageTrainingBatch on real corpus evidence, outside an ingest run.
//
// train.compile is the largest CPU stage in ingest (353-399s per shard) and profiling it through a live ingest
// means waiting for a shard flush and for the process to exit before --cpu-prof writes anything. This calls the
// same production compile on a shard-sized batch read straight from the brain.
//
//   SCCE_CONFIG=scce.config.new.json node --cpu-prof --cpu-prof-dir=.scce/prof tools/compile-cost-profile.mjs 150000
//
// Measured on scce4, 152,115 chars over 40 spans: segmentation and lattice building 33%, content hashing 16%,
// GC 12%, canonicalisation 8%, and n-gram counting 1.9% -- the stage is named for the smallest thing in it.
import { readScceRuntimeConfig, createNodeRuntime } from "../packages/adapters-node/dist/index.js";
import {
  compileLanguageTrainingBatch,
  createLanguageMemoryRuntime,
  createClock,
  createIdFactory,
  createHasher,
  loadFittedPopulation
} from "../packages/kernel/dist/index.js";

const config = await readScceRuntimeConfig(process.env.SCCE_CONFIG ?? "scce.config.json");
const runtime = createNodeRuntime(config);
const hasher = createHasher();

// A shard is ~1.2M chars of text over a few hundred spans. Read until we have that much.
const targetChars = Number(process.argv[2] ?? 300_000);
const spans = [];
let chars = 0;
let afterId;
while (chars < targetChars) {
  const page = await runtime.storage.evidence.listPromotedEvidenceSpans({
    limit: 500, ...(afterId ? { afterId } : {})
  });
  if (!page.length) break;
  afterId = String(page[page.length - 1].id);
  for (const span of page) {
    if (!span.text.trim()) continue;
    spans.push(span);
    chars += span.text.length;
    if (chars >= targetChars) break;
  }
  if (page.length < 500) break;
}
console.log(`batch: ${spans.length} spans, ${chars} chars`);

// A real profile from the brain, because the n-gram compiler reads its scripts to pick a language hint.
const profiles = await runtime.storage.model.listLanguageProfiles(1);
const profile = profiles[0];
if (!profile) throw new Error("no language profile on file");
console.log(`profile: ${profile.id}`);
const fittedPopulation = await loadFittedPopulation(runtime.storage.segmentationPopulations);
console.log(`consolidated population: ${fittedPopulation ? fittedPopulation.id : "none"}`);

const idFactory = createIdFactory({ clock: createClock(), hasher });
const languageMemory = createLanguageMemoryRuntime({ idFactory, hasher });
const text = spans.map(span => span.text).join("\n");
const started = Date.now();
const compiled = compileLanguageTrainingBatch({
  runtime: languageMemory,
  hasher,
  batch: {
    streamId: "profile://shard",
    sourceSystem: "wikimedia:wikipedia",
    profile: profile ?? undefined,
    sourceVersionId: String(spans[0]?.sourceVersionId ?? "source_version.profile"),
    text,
    evidence: spans,
    createdAt: Date.now(),
    maxOrder: 5,
    maxCountersPerOrder: 12000,
    vocabularyLimit: 24000,
    ...(fittedPopulation ? { fittedPopulation } : {})
  }
});
const ms = Date.now() - started;
console.log(
  `compile ${ms}ms  observations=${compiled.observations.length} models=${compiled.models.length} `
  + `units=${compiled.units.length} patterns=${compiled.patterns.length} frames=${compiled.semanticFrames.length}`
);
process.exit(0);
