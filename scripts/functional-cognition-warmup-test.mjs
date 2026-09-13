import { createTrace } from "../packages/kernel/dist/debug/trace.js";
import { createNodeRuntime, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

process.env.SCCE_TRACE = "1";
const config = await readScceRuntimeConfig("scce.config.json");
const runtime = createNodeRuntime(config);
const text = process.argv[2] ?? "Write a JavaScript function that reverses a string";
const waitMs = Number(process.argv[3] ?? 60000);

console.error("warming up...");
await runtime.kernel.warmup({ graph: true, language: true, brain: true, profile: true, corrections: true });

for (let i = 0; i < 2; i++) {
  const trace = createTrace(`fc-warmup-${i}`);
  globalThis.__sccTrace = trace;
  const started = Date.now();
  const result = await runtime.kernel.turn({ text, metadata: { sessionId: `fc-warmup-${Date.now()}` } });
  console.log(JSON.stringify({ turn: i, ms: Date.now() - started, answer: result.answer, traceFile: trace?.file }, null, 1));
  if (i === 0) {
    console.error(`waiting ${waitMs}ms for the background standing-functional-cognition projection to complete...`);
    await new Promise(resolve => setTimeout(resolve, waitMs));
  }
}
await runtime.close();
