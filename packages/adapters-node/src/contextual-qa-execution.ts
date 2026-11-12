// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Worker } from "node:worker_threads";
import { availableParallelism, freemem } from "node:os";
import {
  canonicalJsonByteLength,
  mergeContextualQaAcquisitionResults,
  type ContextualQaAcquisitionResult,
  type ConversationalConstructionDocument
} from "@scce/kernel";
import { populationWorkerBundleDigest } from "./population-candidate-worker-contract.js";
import {
  createWorkerExecutionLifecycle,
  validateWorkerExecutionResources,
  type ExecutionWorker,
  type WorkerExecutionRecord
} from "./worker-execution-lifecycle.js";

export interface ContextualQaWorkerExecution {
  backend: "node_workers.v1";
  workers: number;
  workerHeapMb: number;
  coordinatorHeapMb: number;
  maxNodeRssBytes: number;
  abortGraceMs: number;
}

export interface ContextualQaExecutionReceipt {
  schema: "scce.contextual_qa_execution.v1";
  declaration: ContextualQaWorkerExecution;
  bundleDigest: string;
  workersStarted: number;
  completedPartitions: number;
  peakNodeRssBytes: number;
  rssSamplingIntervalMs: 100;
}

interface Dependencies {
  worker?: (initialization: unknown, heapMb: number) => ExecutionWorker;
  bundleDigest?: () => Promise<string>;
  rss?: () => number;
  cpus?: () => number;
  freeMemory?: () => number;
}

interface WorkerResponse {
  type?: string;
  kind?: string;
  bundleDigest?: string;
  partitionIndex?: number;
  result?: ContextualQaAcquisitionResult;
  error?: { name?: string; message?: string; stack?: string };
}

type ContextualQaWorkerRecord = WorkerExecutionRecord & { ready: boolean; completed: boolean; partitionIndex: number };

export function validateContextualQaWorkerExecution(value: ContextualQaWorkerExecution): Readonly<ContextualQaWorkerExecution> {
  const keys = ["backend", "workers", "workerHeapMb", "coordinatorHeapMb", "maxNodeRssBytes", "abortGraceMs"];
  if (!value || value.backend !== "node_workers.v1" || Object.keys(value).some(key => !keys.includes(key))
    || !Number.isSafeInteger(value.coordinatorHeapMb) || value.coordinatorHeapMb < 1) {
    throw new Error("Invalid contextual QA execution declaration");
  }
  return validateWorkerExecutionResources(value, value.coordinatorHeapMb * 1024 * 1024);
}

/**
 * Evaluate independent, deterministically assigned construction groups in parallel. The coordinator retains
 * the complete corpus only once and performs the single global conflict/subsumption reduction after all shards.
 */
export async function runContextualQaAcquisition(input: {
  documents: readonly ConversationalConstructionDocument[];
  updatedAt: number;
  authorship: string;
  execution: ContextualQaWorkerExecution;
  signal?: AbortSignal;
}, dependencies: Dependencies = {}): Promise<{ result: ContextualQaAcquisitionResult; receipt: ContextualQaExecutionReceipt }> {
  const execution = validateContextualQaWorkerExecution(input.execution);
  input.signal?.throwIfAborted();
  const cpus = (dependencies.cpus ?? availableParallelism)();
  if (!Number.isSafeInteger(cpus) || cpus < 1 || execution.workers > Math.max(1, cpus - 1)) {
    throw new Error("contextual QA workers exceed available CPU capacity");
  }
  const requiredMemory = execution.coordinatorHeapMb * 1024 * 1024
    + execution.workers * (execution.workerHeapMb * 1024 * 1024 + 64 * 1024 * 1024);
  const availableMemory = (dependencies.freeMemory ?? freemem)();
  if (!Number.isSafeInteger(availableMemory) || availableMemory < requiredMemory) {
    throw new Error("contextual QA workers lack declared physical memory headroom");
  }

  const bundleDigest = await (dependencies.bundleDigest ?? populationWorkerBundleDigest)();
  input.signal?.throwIfAborted();
  const results: Array<ContextualQaAcquisitionResult | undefined> = new Array(execution.workers);
  const records: ContextualQaWorkerRecord[] = [];
  let completed = 0;
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const barrier = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  void barrier.catch(() => {});
  const lifecycle = createWorkerExecutionLifecycle({ declaration: execution,
    coordinatorHeapLimitBytes: execution.coordinatorHeapMb * 1024 * 1024,
    signal: input.signal, rss: dependencies.rss, onFailure: reject });
  const fail = (error: unknown) => lifecycle.fail(error);
  const wireError = (value: WorkerResponse["error"]): Error => {
    const error = new Error(value?.message ?? "contextual QA worker failed");
    error.name = value?.name ?? "Error";
    if (value?.stack) error.stack = value.stack;
    return error;
  };

  try {
    lifecycle.start();
    if (lifecycle.failed) throw lifecycle.error;
    const message = { type: "run", documents: input.documents, updatedAt: input.updatedAt, authorship: input.authorship,
      partitionCount: execution.workers };
    const messageBytes = canonicalJsonByteLength(message, execution.workerHeapMb * 1024 * 1024);
    if (messageBytes > execution.workerHeapMb * 1024 * 1024) throw new Error("contextual QA worker input exceeds its declared heap byte budget");

    for (let partitionIndex = 0; partitionIndex < execution.workers; partitionIndex++) {
      const initialization = { schema: "scce.contextual_qa_worker.v1", bundleDigest, workerHeapMb: execution.workerHeapMb };
      const worker = dependencies.worker ? dependencies.worker(initialization, execution.workerHeapMb) : new Worker(new URL("./contextual-qa-worker.js", import.meta.url), {
        workerData: initialization, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: execution.workerHeapMb, stackSizeMb: 8 }
      });
      const record = Object.assign(lifecycle.track(worker), { ready: false, completed: false, partitionIndex });
      records.push(record);
      worker.on("message", (response: WorkerResponse) => {
        if (lifecycle.failed) return;
        if (!response || typeof response !== "object" || Array.isArray(response)) {
          fail(new Error("malformed contextual QA worker response")); return;
        }
        if (!record.ready) {
          if (response.type !== "ready" || response.kind !== "contextual_qa" || response.bundleDigest !== bundleDigest) {
            fail(response.type === "error" ? wireError(response.error) : new Error("contextual QA worker readiness differs")); return;
          }
          record.ready = true;
          worker.postMessage({ ...message, partitionIndex });
          return;
        }
        if (response.type === "error") { fail(wireError(response.error)); return; }
        if (response.type !== "result" || response.partitionIndex !== partitionIndex || !response.result || record.completed) {
          fail(new Error("contextual QA worker response identity differs")); return;
        }
        results[partitionIndex] = response.result;
        record.completed = true;
        completed++;
        lifecycle.sample();
        worker.postMessage({ type: "shutdown" });
        if (completed === execution.workers) resolve();
      });
      worker.on("exit", (code: number) => {
        if (!lifecycle.failed && (code !== 0 || !record.completed)) fail(new Error(`contextual QA worker exited before completion (${code})`));
      });
    }

    await barrier;
    await lifecycle.drain();
    lifecycle.sample();
    if (lifecycle.failed) throw lifecycle.error;
    const result = mergeContextualQaAcquisitionResults(results as ContextualQaAcquisitionResult[]);
    return { result, receipt: { schema: "scce.contextual_qa_execution.v1", declaration: execution, bundleDigest,
      workersStarted: records.length, completedPartitions: completed, peakNodeRssBytes: lifecycle.peakRss, rssSamplingIntervalMs: 100 } };
  } catch (error) {
    fail(error);
    await lifecycle.drain();
    throw lifecycle.error;
  } finally {
    lifecycle.dispose();
  }
}
