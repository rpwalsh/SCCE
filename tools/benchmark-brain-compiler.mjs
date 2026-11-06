// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { performance } from "node:perf_hooks";
import { getHeapStatistics } from "node:v8";
import { benchmarkBuildIdentity } from "./lib/benchmark-build-identity.mjs";

const { values } = parseArgs({ options: {
  input: { type: "string", multiple: true },
  out: { type: "string" },
  kernel: { type: "string", default: "packages/kernel/dist/index.js" },
  "span-codepoints": { type: "string", default: "1800" },
  "skip-observations": { type: "boolean", default: false },
  "language-only": { type: "boolean", default: false }
} });
if (!values.input?.length) throw new Error("Usage: node tools/benchmark-brain-compiler.mjs --input=<utf8-file> [--input=<file>] [--out=<json>] [--kernel=<built-index.js>] [--skip-observations] [--language-only]");
const spanSize = Number(values["span-codepoints"]);
if (!Number.isSafeInteger(spanSize) || spanSize < 1) throw new Error("span-codepoints must be a positive integer");
const kernelPath = resolve(values.kernel);
const kernel = await import(pathToFileURL(kernelPath).href);
const { createClock, createHasher, createIdFactory, createLanguageAcquisitionEngine, createLanguageMemoryRuntime, compileLanguageTrainingBatch, canonicalStringify, canonicalDigestHex } = kernel;
const hasher = createHasher();
const clock = createClock({ fixedTime: 1000, stepMs: 1 });
const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "compiler-benchmark" });
const evidence = [];
const sources = [];
const texts = [];
for (const file of values.input) {
  const bytes = await readFile(resolve(file));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const sourceId = ids.sourceId("compiler-benchmark", pathToFileURL(resolve(file)).href);
  const contentHash = ids.contentHash(bytes);
  const sourceVersionId = ids.sourceVersionId(`${sourceId}\u001f${contentHash}`);
  const characters = [...text];
  let byteStart = 0;
  for (let charStart = 0; charStart < characters.length; charStart += spanSize) {
    const chunk = characters.slice(charStart, charStart + spanSize).join("");
    const spanHash = ids.contentHash(chunk);
    const byteEnd = byteStart + Buffer.byteLength(chunk);
    evidence.push({
      id: ids.evidenceId({ sourceVersionId, byteStart, byteEnd, spanHash }),
      sourceId, sourceVersionId, chunkId: ids.chunkId({ sourceVersionId, byteStart, byteEnd, chunkHash: spanHash }),
      contentHash: spanHash, mediaType: "text/plain", byteStart, byteEnd, charStart,
      charEnd: Math.min(characters.length, charStart + spanSize), text: chunk, textPreview: chunk.slice(0, 180),
      features: [], languageHints: {}, scriptHints: {}, trustVector: { forceClass: "direct_evidence" },
      provenance: { sourceFamilyId: String(sourceId) }, alpha: 1, status: "promoted", observedAt: 1000
    });
    byteStart = byteEnd;
  }
  sources.push({ file: resolve(file), contentHash, bytes: bytes.length, sourceId, sourceVersionId });
  texts.push(text);
}
const text = texts.join("\n\n");
const sourceVersionId = ids.sourceVersionId(canonicalStringify(sources.map(source => [source.sourceId, source.contentHash])));
const measurements = [];
function measured(stage, run) {
  const start = performance.now();
  const result = run();
  measurements.push({ stage, elapsedMs: performance.now() - start, ...process.memoryUsage(), maximumResidentKiB: process.resourceUsage().maxRSS });
  return result;
}
const language = createLanguageAcquisitionEngine({ idFactory: ids });
const profile = measured("acquisition", () => language.acquire({ sourceVersionId, text, createdAt: 1000 }));
const runtime = createLanguageMemoryRuntime({ idFactory: ids, hasher });
const train = runtime.train.bind(runtime);
runtime.train = input => measured("ngram", () => train(input));
const compiled = measured("complete-compilation", () => compileLanguageTrainingBatch({ runtime, hasher, batch: {
  streamId: "benchmark://compiler", profile, sourceVersionId, text, evidence, createdAt: 1000,
  retainNgramObservations: !values["skip-observations"], languageOnly: values["language-only"]
} }));
const retained = { ...compiled, audit: null, observations: values["skip-observations"] ? [] : compiled.observations };
const report = {
  schema: "scce.compiler_benchmark.v1", scope: "pure_compiler_without_storage_or_served_answers", generatedAt: new Date().toISOString(),
  implementation: { ...await benchmarkBuildIdentity(kernelPath), heapLimitBytes: getHeapStatistics().heap_size_limit },
  workload: { sources, textBytes: Buffer.byteLength(text), evidenceSpans: evidence.length, spanCodePoints: spanSize, skipObservations: values["skip-observations"], languageOnly: values["language-only"] },
  measurements, retainedArtifactDigest: canonicalDigestHex(retained, hasher),
  counts: { compiledObservations: compiled.observations.length, retainedObservations: retained.observations.length, models: compiled.models.length, units: compiled.units.length, patterns: compiled.patterns.length, frames: compiled.semanticFrames.length, constructionCandidates: compiled.constructionCandidates },
  qualification: "Compiler measurements do not qualify persistence, answer quality, or an 8 GB whole-machine build."
};
const json = JSON.stringify(report, null, 2) + "\n";
if (values.out) { await mkdir(dirname(resolve(values.out)), { recursive: true }); await writeFile(resolve(values.out), json, "utf8"); }
else process.stdout.write(json);
