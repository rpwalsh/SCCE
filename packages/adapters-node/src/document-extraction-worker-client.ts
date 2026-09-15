// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { existsSync } from "node:fs";
import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { DocumentWasmExtractionRequest, DocumentWasmExtractionResult } from "./document-wasm-extraction.js";

export async function runDocumentExtractionWorker(
  request: DocumentWasmExtractionRequest,
  options: { timeoutMs: number; signal?: AbortSignal }
): Promise<DocumentWasmExtractionResult> {
  options.signal?.throwIfAborted();
  const worker = new Worker(workerUrl(), {
    resourceLimits: { maxOldGenerationSizeMb: 384, stackSizeMb: 8 }
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error, result?: DocumentWasmExtractionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", aborted);
      void worker.terminate();
      if (error) reject(error); else resolve(result!);
    };
    const timer = setTimeout(() => finish(new Error("document extraction timed out")), options.timeoutMs);
    const aborted = () => finish(options.signal?.reason instanceof Error ? options.signal.reason : new Error("document extraction cancelled"));
    options.signal?.addEventListener("abort", aborted, { once: true });
    worker.once("error", error => finish(error));
    worker.once("exit", code => {
      if (!settled && code !== 0) finish(new Error(`document extraction worker exited before returning a result (${code})`));
    });
    worker.once("message", (message: { id?: unknown; ok?: boolean; result?: DocumentWasmExtractionResult; error?: unknown }) => {
      if (message.ok && message.result) finish(undefined, message.result);
      else finish(new Error(typeof message.error === "string" ? message.error : "document extraction worker returned no result"));
    });
    worker.postMessage({ id: 1, request });
  });
}

function workerUrl(): URL {
  const local = new URL("./document-extraction-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(local))) return local;
  const fallback = new URL("../dist/document-extraction-worker.js", import.meta.url);
  if (existsSync(fileURLToPath(fallback))) return fallback;
  throw new Error("document extraction worker is unavailable; build @scce/adapters-node");
}
