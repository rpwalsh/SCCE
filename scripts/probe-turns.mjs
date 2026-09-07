#!/usr/bin/env node
// Several in-process turns against the live brain in ONE process, so warm-cache behaviour is visible and a cold-start
// effect cannot be mistaken for a permanent one. Each question is one argument.
import { createTrace } from "../packages/kernel/dist/debug/trace.js";
import { createNodeRuntime, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

process.env.SCCE_TRACE = "1";
const trace = createTrace("probe");
globalThis.__sccTrace = trace;
const config = await readScceRuntimeConfig(process.env.SCCE_PROBE_CONFIG ?? "scce.config.json");
const runtime = createNodeRuntime(config);
if (process.env.SCCE_PROBE_WARMUP !== "0") {
  const warmupStarted = Date.now();
  const warmup = await runtime.kernel.warmup({ languageLimit: Number(process.env.SCCE_PROBE_LANGUAGE_LIMIT) || 36 });
  console.log(JSON.stringify({ warmupMs: Date.now() - warmupStarted, language: warmup.language, failures: warmup.failures }));
}
const questions = process.argv.slice(2);
for (const text of questions) {
  const started = Date.now();
  const result = await runtime.kernel.turn({ text, metadata: { sessionId: `probe-${Date.now()}` } });
  console.log(JSON.stringify({
    ms: Date.now() - started,
    text,
    assistantForce: result.assistantForce,
    answer: result.answer
  }));
}
console.log(JSON.stringify({ traceFile: trace?.file }));
await runtime.close();
