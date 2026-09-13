import { createTrace } from "../packages/kernel/dist/debug/trace.js";
import { createNodeRuntime, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";

process.env.SCCE_TRACE = "1";
const config = await readScceRuntimeConfig("scce.config.json");
const runtime = createNodeRuntime(config);
await runtime.kernel.warmup({ languageLimit: 64 }).catch(() => undefined);

const questions = [
  "What was the serial number of Abraham Lincoln's pocket watch?",
  "What was Agatha Christie's favorite tea blend?",
  "What was Ahmad Shah Durrani's shoe size?",
  "What is Alaska's official state dinosaur?",
  "What was Alexander Graham Bell's blood type?",
  "What was Alexander the Great's favorite color?",
  "What is El Salvador's national board game?",
  "Why did Apollo 11 land on Mars?"
];
for (const text of questions) {
  const trace = createTrace(`cf-probe`);
  globalThis.__sccTrace = trace;
  const result = await runtime.kernel.turn({ text });
  console.log(JSON.stringify({ text, answer: result.answer }, null, 1));
}
await runtime.close();
