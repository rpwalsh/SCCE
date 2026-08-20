import { createNodeRuntime, readScceRuntimeConfig } from "../packages/adapters-node/dist/index.js";
import { createTrace } from "../packages/kernel/dist/debug/trace.js";
import { readFileSync } from "node:fs";

process.env.SCCE_TRACE = "1";
const trace = createTrace("realtest");
globalThis.__sccTrace = trace;

const config = await readScceRuntimeConfig("scce.realtest.config.json");
const runtime = createNodeRuntime(config);
const question = process.argv[2] || "What license does SlopBlocker use?";
const result = await runtime.kernel.turn({ text: question });
console.log(JSON.stringify({
  answer: result.answer,
  force: result.epistemicForce,
  evidenceCount: result.evidence.length,
  evidenceHeads: result.evidence.slice(0, 3).map(span => String(span.text ?? span.textPreview ?? "").slice(0, 80)),
  entailment: { support: result.entailment?.support, force: result.entailment?.force, claim: String(result.entailment?.claim?.text ?? "").slice(0, 100) },
  eventTypes: [...new Set((result.events ?? []).map(event => event.typeId))]
}, null, 2));
if (trace) {
  for (const line of readFileSync(trace.file, "utf8").trim().split("\n")) {
    const row = JSON.parse(line);
    if (true) console.log("TRACE", row.stage, JSON.stringify(row.counts ?? {}), JSON.stringify(row.support ?? {}));
  }
}
await runtime.close?.();
process.exit(0);
