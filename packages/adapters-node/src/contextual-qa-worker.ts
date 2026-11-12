// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { parentPort, workerData } from "node:worker_threads";
import { acquireContextualQaConstructions, canonicalJsonByteLength, createHasher,
  type ConversationalConstructionDocument } from "@scce/kernel";
import { populationWorkerBundleDigest } from "./population-candidate-worker-contract.js";

interface Initialization { schema: "scce.contextual_qa_worker.v1"; bundleDigest: string; workerHeapMb: number }
interface RunMessage { type: "run"; documents: readonly ConversationalConstructionDocument[]; updatedAt: number; authorship: string;
  partitionIndex: number; partitionCount: number }

const port = parentPort;
if (!port) throw new Error("contextual QA worker requires a parent port");
const initialization = workerData as Initialization;
let running = false;
let completed = false;

try {
  if (initialization.schema !== "scce.contextual_qa_worker.v1"
    || initialization.bundleDigest !== await populationWorkerBundleDigest()
    || !Number.isSafeInteger(initialization.workerHeapMb) || initialization.workerHeapMb < 1) {
    throw new Error("contextual QA worker executable bundle differs");
  }
  port.postMessage({ type: "ready", kind: "contextual_qa", bundleDigest: initialization.bundleDigest });
} catch (error) {
  port.postMessage({ type: "error", error: serializeError(error) });
  process.exitCode = 1;
  port.close();
}

port.on("message", (message: RunMessage | { type: "shutdown" } | { type: "abort" }) => {
  if (message.type === "shutdown") {
    if (running) return;
    port.close();
    return;
  }
  if (message.type === "abort") {
    process.exitCode = 1;
    port.close();
    return;
  }
  if (running || completed) {
    port.postMessage({ type: "error", error: serializeError(new Error("contextual QA worker accepts exactly one run")) });
    return;
  }
  running = true;
  try {
    const result = acquireContextualQaConstructions({ documents: message.documents, hasher: createHasher(), updatedAt: message.updatedAt,
      authorship: message.authorship, groupPartition: { index: message.partitionIndex, count: message.partitionCount } });
    const response = { type: "result", partitionIndex: message.partitionIndex, result };
    if (canonicalJsonByteLength(response, initialization.workerHeapMb * 1024 * 1024) > initialization.workerHeapMb * 1024 * 1024) {
      throw new Error("contextual QA worker result exceeds its declared heap byte budget");
    }
    completed = true;
    port.postMessage(response);
  } catch (error) {
    port.postMessage({ type: "error", partitionIndex: message.partitionIndex, error: serializeError(error) });
  } finally {
    running = false;
  }
});

function serializeError(error: unknown) {
  return error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : { name: "Error", message: String(error) };
}
