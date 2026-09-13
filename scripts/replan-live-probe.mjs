import { createTrace } from "../packages/kernel/dist/debug/trace.js";
import { createNodeRuntime, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

process.env.SCCE_TRACE = "1";
const config = await readScceRuntimeConfig("scce.config.json");
const runtime = createNodeRuntime(config);
const text = process.argv[2] ?? "Write a JavaScript function called reverseString that reverses a string, but leave a bug in it so the build fails.";

await runtime.kernel.warmup({ graph: true, language: true, brain: true, profile: true, corrections: true });

const trace = createTrace("replan-probe");
globalThis.__sccTrace = trace;
const result = await runtime.kernel.turn({ text, metadata: { sessionId: `replan-probe-${Date.now()}` } });
console.log(JSON.stringify({ answer: result.answer, traceFile: trace?.file }, null, 1));
await runtime.close();
