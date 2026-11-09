// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { Worker } from "node:worker_threads";
import { availableParallelism, freemem } from "node:os";
import { getHeapStatistics } from "node:v8";
import { canonicalJsonByteLength, type CorpusSegmentationWorkerExecution, type SourceInductionBatchExecution,
  type SourceInductionBatchJob, type SourceInductionBatchSession, type SourceInductionBatchIdentity,
  type SourceInductionBatchProduct, type PreparedCorpusSegmentationMeasurement, type VerifiedCorpusSegmentation } from "@scce/kernel";
import { populationWorkerBundleDigest } from "./population-candidate-worker-contract.js";
import { createWorkerExecutionLifecycle, validateWorkerExecutionResources, type ExecutionWorker, type WorkerExecutionRecord } from "./worker-execution-lifecycle.js";

export type SourceInductionWorkerExecution = Omit<CorpusSegmentationWorkerExecution, "totalPgConnections">;
export interface SourceInductionExecutionReceipt {
  schema: "scce.source_induction_execution.v1"; declaration: SourceInductionWorkerExecution; bundleDigest: string;
  workersStarted: number; preparedBatches: number; inducedBatches: number; peakNodeRssBytes: number; rssSamplingIntervalMs: 100;
}
export function validateSourceInductionWorkerExecution(value: SourceInductionWorkerExecution): SourceInductionWorkerExecution {
  const keys = ["backend", "workers", "workerHeapMb", "maxNodeRssBytes", "abortGraceMs"];
  if (!value || value.backend !== "node_workers.v1" || Object.keys(value).some(key => !keys.includes(key))) throw Error("Invalid source induction execution declaration");
  return validateWorkerExecutionResources(value);
}
interface Dependencies {
  worker?: (initialization: unknown, heapMb: number) => ExecutionWorker;
  bundleDigest?: () => Promise<string>; coordinatorHeapLimitBytes?: number; rss?: () => number;
  cpus?: () => number; freeMemory?: () => number;
}
interface Response { type?: string; kind?: string; bundleDigest?: string; jobDigest?: string; preparations?: PreparedCorpusSegmentationMeasurement[];
  identity?: SourceInductionBatchIdentity; product?: SourceInductionBatchProduct; error?: { name?: string; message?: string; stack?: string } }
type Pending = { type: string; jobDigest: string; resolve(value: Response): void; reject(error: unknown): void };
type SourceWorkerRecord = WorkerExecutionRecord & { ready: boolean; leased: boolean; pending?: Pending; readyResolve(): void; readyReject(error: unknown): void };

/** The existing population-worker lifecycle owns reservation, RSS, cancellation, termination and draining. This adapter owns source messages only. */
export function createSourceInductionExecution(input: { policy: SourceInductionWorkerExecution; signal?: AbortSignal }, dependencies: Dependencies = {}): {
  execution: SourceInductionBatchExecution; close(reason?: unknown): Promise<void>; receipt(): SourceInductionExecutionReceipt | undefined;
} {
  const coordinatorHeapLimitBytes = dependencies.coordinatorHeapLimitBytes ?? getHeapStatistics().heap_size_limit;
  const policy = validateWorkerExecutionResources(validateSourceInductionWorkerExecution(input.policy), coordinatorHeapLimitBytes), records: SourceWorkerRecord[] = [];
  let lifecycle: ReturnType<typeof createWorkerExecutionLifecycle> | undefined, startup: Promise<void> | undefined, closing: Promise<void> | undefined;
  let closed = false, readyComplete = false, bundleDigest = "", preparedBatches = 0, inducedBatches = 0, receipt: SourceInductionExecutionReceipt | undefined;
  const failure = (error: unknown) => { for (const record of records) { record.readyReject(error); record.pending?.reject(error); record.pending = undefined; } };
  const wireError = (value: Response["error"]): Error => {
    const error = Error(value?.message ?? "source induction worker failed"); error.name = value?.name ?? "Error";
    if (value?.stack) error.stack = value.stack; return error;
  };
  const send = (record: SourceWorkerRecord, value: unknown) => {
    const limit = policy.workerHeapMb * 1024 * 1024;
    if (canonicalJsonByteLength(value, limit) > limit) throw Error("source induction message exceeds its declared heap byte budget");
    record.worker.postMessage(value);
  };
  const request = (record: SourceWorkerRecord, type: string, value: object, jobDigest: string): Promise<Response> => {
    if (closed || lifecycle?.failed || record.done || record.pending) return Promise.reject(lifecycle?.error ?? Error("source induction worker is unavailable"));
    return new Promise((resolve, reject) => {
      record.pending = { type, jobDigest, resolve, reject };
      try { send(record, value); } catch (error) { record.pending = undefined; reject(error); }
    });
  };
  const ensureStarted = (): Promise<void> => startup ??= (async () => {
    input.signal?.throwIfAborted();
    if (closed) throw Error("source induction execution is closed");
    const cpus = (dependencies.cpus ?? availableParallelism)(), available = (dependencies.freeMemory ?? freemem)();
    if (!Number.isSafeInteger(cpus) || cpus < 1 || policy.workers > Math.max(1, cpus - 1)) throw Error("source induction workers exceed available CPU capacity");
    const additionalBytes = policy.workers * (policy.workerHeapMb * 1024 * 1024 + 64 * 1024 * 1024);
    if (!Number.isSafeInteger(available) || available < additionalBytes) throw Error("source induction workers lack declared physical memory headroom");
    bundleDigest = await (dependencies.bundleDigest ?? populationWorkerBundleDigest)();
    input.signal?.throwIfAborted(); if (closed) throw Error("source induction execution is closed");
    lifecycle = createWorkerExecutionLifecycle({ declaration: policy, signal: input.signal,
      coordinatorHeapLimitBytes, rss: dependencies.rss, onFailure: failure });
    const ready: Promise<void>[] = [];
    try {
      lifecycle.start(); if (lifecycle.failed) throw lifecycle.error;
      for (let index = 0; index < policy.workers; index++) {
        if (closed || lifecycle.failed) throw lifecycle.error ?? Error("source induction execution is closed");
        const initialization = { schema: "scce.source_induction_worker.v1", bundleDigest, workerHeapMb: policy.workerHeapMb };
        const worker = dependencies.worker ? dependencies.worker(initialization, policy.workerHeapMb) : new Worker(new URL("./source-induction-worker.js", import.meta.url), {
          workerData: initialization, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: policy.workerHeapMb, stackSizeMb: 8 } });
        let yes!: () => void, no!: (error: unknown) => void;
        const initialized = new Promise<void>((resolve, reject) => { yes = resolve; no = reject; }); void initialized.catch(() => {}); ready.push(initialized);
        const record = Object.assign(lifecycle.track(worker), { ready: false, leased: false, pending: undefined as Pending | undefined, readyResolve: yes, readyReject: no }); records.push(record);
        worker.on("message", (message: Response) => {
          if (lifecycle!.failed || closed) return;
          if (!message || typeof message !== "object" || Array.isArray(message)) { lifecycle!.fail(Error("malformed source induction worker response")); return; }
          if (!record.ready) {
            if (message.type === "ready" && message.kind === "source_induction" && message.bundleDigest === bundleDigest) { record.ready = true; record.readyResolve(); return; }
            lifecycle!.fail(message.type === "error" ? wireError(message.error) : Error("source induction worker readiness differs")); return;
          }
          const pending = record.pending;
          if (!pending || message.jobDigest !== pending.jobDigest || message.type !== pending.type && message.type !== "error") {
            lifecycle!.fail(Error("source induction worker response identity or phase differs")); return;
          }
          record.pending = undefined;
          if (message.type === "error") pending.reject(wireError(message.error));
          else { lifecycle!.sample(); if (lifecycle!.failed) pending.reject(lifecycle!.error); else pending.resolve(message); }
        });
        worker.on("exit", (code: number) => { if (!closed && !lifecycle!.failed) lifecycle!.fail(Error(`source induction worker exited before shutdown (${code})`)); });
      }
      await Promise.all(ready); readyComplete = true; lifecycle.sample(); if (lifecycle.failed) throw lifecycle.error;
    } catch (error) { lifecycle.fail(error); await lifecycle.drain(); lifecycle.dispose(); throw error; }
  })();
  const close = (reason?: unknown): Promise<void> => closing ??= (async () => {
    closed = true;
    if (lifecycle && !readyComplete) lifecycle.fail(reason ?? Error("source induction execution closed during startup"));
    try { await startup; } catch { /* The operation retains its startup error. */ }
    if (!lifecycle) return;
    try {
      if (reason !== undefined) lifecycle.fail(reason);
      else if (records.some(record => record.leased || record.pending)) lifecycle.fail(Error("source induction execution closed with outstanding batches"));
      else if (!lifecycle.failed) for (const record of records) if (!record.done) record.worker.postMessage({ type: "shutdown" });
      await lifecycle.drain(); lifecycle.sample();
      if (lifecycle.failed && lifecycle.error !== reason) throw lifecycle.error;
      receipt = { schema: "scce.source_induction_execution.v1", declaration: policy, bundleDigest, workersStarted: records.length,
        preparedBatches, inducedBatches, peakNodeRssBytes: lifecycle.peakRss, rssSamplingIntervalMs: 100 };
    } finally { lifecycle.dispose(); }
  })();
  const execution: SourceInductionBatchExecution = { concurrency: policy.workers, close,
    async open(job: SourceInductionBatchJob): Promise<SourceInductionBatchSession> {
      await ensureStarted(); input.signal?.throwIfAborted();
      const record = records.find(record => !record.leased && !record.done);
      if (!record || closed || lifecycle!.failed) throw lifecycle?.error ?? Error("source induction execution capacity exceeded");
      record.leased = true;
      let released = false, phase = "prepared", release: Promise<void> | undefined;
      const releaseSession = (): Promise<void> => release ??= (async () => {
        if (released) return; released = true;
        try { if (!closed && !lifecycle!.failed && !record.done) await request(record, "released", { type: "release", jobDigest: job.jobDigest }, job.jobDigest); }
        finally { record.leased = false; }
      })();
      try {
        const response = await request(record, "prepared", { type: "prepare", job }, job.jobDigest); preparedBatches++;
        if (!Array.isArray(response.preparations)) throw Error("source induction worker omitted measurement descriptors");
        return { jobDigest: job.jobDigest, preparations: response.preparations, close: releaseSession,
          async verify(corpus?: VerifiedCorpusSegmentation) {
            if (released || phase !== "prepared") throw Error("invalid source induction verification phase");
            const response = await request(record, "verified", { type: "verify", jobDigest: job.jobDigest, ...(corpus ? { corpus } : {}) }, job.jobDigest);
            if (!response.identity) throw Error("source induction worker omitted batch identity"); phase = "verified"; return response.identity;
          },
          async induce() {
            if (released || phase !== "verified") throw Error("invalid source induction computation phase"); phase = "inducing";
            const response = await request(record, "result", { type: "induce", jobDigest: job.jobDigest }, job.jobDigest);
            if (!response.product) throw Error("source induction worker omitted model product"); inducedBatches++; phase = "induced"; return response.product;
          } };
      } catch (error) { try { await releaseSession(); } catch (cleanup) { if (cleanup !== error) throw new AggregateError([error, cleanup], "source induction opening and cleanup failed"); } throw error; }
    } };
  return { execution, close, receipt: () => receipt };
}

/** One resource owner shared by trainer and Wiki prewarm; cleanup never masks a distinct primary failure. */
export async function runSourceInductionExecution<T>(input: { policy: SourceInductionWorkerExecution; signal?: AbortSignal;
  run(execution: SourceInductionBatchExecution): Promise<T> }): Promise<{ result: T; receipt?: SourceInductionExecutionReceipt }> {
  const owner = createSourceInductionExecution(input);
  let result!: T, primary: unknown, failed = false;
  try { result = await input.run(owner.execution); } catch (error) { failed = true; primary = error; }
  try { await owner.close(failed ? primary : undefined); }
  catch (cleanup) { if (failed && cleanup !== primary) throw new AggregateError([primary, cleanup], "source induction operation and cleanup failed"); throw cleanup; }
  if (failed) throw primary;
  const receipt = owner.receipt(); return { result, ...(receipt ? { receipt } : {}) };
}
