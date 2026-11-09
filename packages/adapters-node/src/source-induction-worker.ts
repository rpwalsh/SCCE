// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { parentPort, workerData } from "node:worker_threads";
import { canonicalJsonByteLength, type SourceInductionBatchJob, type VerifiedCorpusSegmentation } from "@scce/kernel";
import { populationWorkerBundleDigest } from "./population-candidate-worker-contract.js";
import { createSourceInductionWorkerSession } from "./source-induction-worker-session.js";
const port = parentPort; if (!port) throw Error("source induction worker requires its coordinator");
const initialization = workerData as { schema: string; bundleDigest: string; workerHeapMb: number };
let state: ReturnType<typeof createSourceInductionWorkerSession> | undefined, jobDigest: string | undefined;
const close = () => { state?.close(); state = undefined; port.close(); };
const send = (value: unknown) => {
  if (canonicalJsonByteLength(value, initialization.workerHeapMb * 1024 * 1024) > initialization.workerHeapMb * 1024 * 1024)
    throw Error("source induction worker message exceeds its declared heap byte budget");
  port.postMessage(value);
};
async function main() {
  if (initialization.schema !== "scce.source_induction_worker.v1" || initialization.bundleDigest !== await populationWorkerBundleDigest())
    throw Error("source induction worker executable bundle differs");
  port!.on("message", (message: { type?: string; job?: SourceInductionBatchJob; jobDigest?: string; corpus?: VerifiedCorpusSegmentation }) => {
    if (message.type === "abort" || message.type === "shutdown") { close(); return; }
    try {
      if (message.type === "prepare") {
        if (state || !message.job) throw Error("invalid source induction prepare lifecycle");
        jobDigest = message.job.jobDigest; state = createSourceInductionWorkerSession(message.job);
        send({ type: "prepared", jobDigest, preparations: state.preparations }); return;
      }
      if (message.type === "release" && jobDigest && message.jobDigest === jobDigest) {
        state?.close(); state = undefined; send({ type: "released", jobDigest }); jobDigest = undefined; return;
      }
      if (!state || !jobDigest || message.jobDigest !== jobDigest) throw Error("source induction worker session identity differs");
      if (message.type === "verify") { send({ type: "verified", jobDigest, identity: state.verify(message.corpus) }); return; }
      if (message.type === "induce") { send({ type: "result", jobDigest, product: state.induce() }); return; }
      throw Error("invalid source induction worker message");
    } catch (error) { send({ type: "error", jobDigest, error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined } }); }
  });
  send({ type: "ready", kind: "source_induction", bundleDigest: initialization.bundleDigest });
}
void main().catch(error => { port.postMessage({ type: "error", error: { name: error instanceof Error ? error.name : "Error", message: error instanceof Error ? error.message : String(error), stack: error instanceof Error ? error.stack : undefined } }); close(); });
