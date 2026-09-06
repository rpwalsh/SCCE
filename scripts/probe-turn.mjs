#!/usr/bin/env node
// In-process turn against the live brain, with the kernel trace attached, so the retrieval lane is visible.
import { createTrace, traceEvent } from "../packages/kernel/dist/debug/trace.js";
import { createNodeRuntime, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

process.env.SCCE_TRACE = "1";
const trace = createTrace("probe");
globalThis.__sccTrace = trace;
const config = await readScceRuntimeConfig(process.env.SCCE_PROBE_CONFIG ?? "scce.config.json");
const runtime = createNodeRuntime(config);
const text = process.argv[2] ?? "Who was Ada Lovelace?";
const started = Date.now();
const result = await runtime.kernel.turn({ text, metadata: { sessionId: `probe-${Date.now()}` } });
console.log(JSON.stringify({
  ms: Date.now() - started,
  answer: result.answer,
  assistantForce: result.assistantForce,
  citations: (result.citations ?? []).length,
  traceFile: trace?.file
}, null, 1));
await runtime.close();
