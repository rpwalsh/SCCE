import { createTrace, traceEvent } from "../packages/kernel/dist/debug/trace.js";
import { createNodeRuntime, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

process.env.SCCE_TRACE = "1";
const config = await readScceRuntimeConfig("scce.config.json");
const runtime = createNodeRuntime(config);
const questions = process.argv.slice(2).length ? process.argv.slice(2) : ["When did Apollo 11 land on the Moon?"];

const warmupTrace = createTrace("warmup");
globalThis.__sccTrace = warmupTrace;
console.error("warming up, trace:", warmupTrace?.file);
const warmupStarted = Date.now();
await runtime.kernel.warmup({ graph: true, language: true, brain: true, profile: true, corrections: true });
console.error(JSON.stringify({ warmupMs: Date.now() - warmupStarted }));

for (const text of questions) {
  for (let i = 0; i < 2; i++) {
    const trace = createTrace(`warm-probe-${i}`);
    globalThis.__sccTrace = trace;
    const started = Date.now();
    const result = await runtime.kernel.turn({ text, metadata: { sessionId: `warm-probe-${i}-${Date.now()}` } });
    console.log(JSON.stringify({
      text, turn: i, ms: Date.now() - started, answer: result.answer, traceFile: trace?.file
    }, null, 1));
  }
}
await runtime.close();
