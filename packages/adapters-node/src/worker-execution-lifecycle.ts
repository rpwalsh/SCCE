// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { Worker } from "node:worker_threads";
import { getHeapStatistics } from "node:v8";

export interface WorkerExecutionResources {
  workers: number;
  workerHeapMb: number;
  maxNodeRssBytes: number;
  abortGraceMs: number;
}
export type ExecutionWorker = Pick<Worker, "on" | "postMessage" | "terminate">;
export interface WorkerExecutionRecord {
  readonly worker: ExecutionWorker;
  readonly exited: Promise<void>;
  readonly done: boolean;
  readonly exitCode?: number;
}

export function validateWorkerExecutionResources<T extends WorkerExecutionResources>(value: T, coordinatorHeapLimitBytes?: number): Readonly<T> {
  if (!value || [value.workers, value.workerHeapMb, value.maxNodeRssBytes, value.abortGraceMs]
    .some(number => !Number.isSafeInteger(number) || number < 1)) throw Error("Invalid worker execution resource declaration");
  if (coordinatorHeapLimitBytes !== undefined && (!Number.isSafeInteger(coordinatorHeapLimitBytes) || coordinatorHeapLimitBytes < 1
    || value.maxNodeRssBytes < coordinatorHeapLimitBytes + value.workers * (value.workerHeapMb * 1024 * 1024 + 64 * 1024 * 1024))) {
    throw Error("Worker memory declaration cannot reserve coordinator heap, worker heaps and page budgets");
  }
  return Object.freeze({ ...value });
}

export function createWorkerExecutionLifecycle(input: {
  declaration: WorkerExecutionResources;
  signal?: AbortSignal;
  coordinatorHeapLimitBytes?: number;
  rss?: () => number;
  onFailure?: (error: unknown) => void;
}) {
  const declaration = validateWorkerExecutionResources(input.declaration, input.coordinatorHeapLimitBytes ?? getHeapStatistics().heap_size_limit);
  const records: Array<{ worker: ExecutionWorker; exited: Promise<void>; done: boolean; exitCode?: number }> = [];
  let failed = false, error: unknown, peakRss = 0, started = false, disposed = false, forcedExpired = false;
  let forced: ReturnType<typeof setTimeout> | undefined, monitor: ReturnType<typeof setInterval> | undefined;
  const abortWorker = (record: WorkerExecutionRecord) => { if (!record.done) record.worker.postMessage({ type: "abort" }); };
  const fail = (failure: unknown) => {
    if (failed) return;
    failed = true; error = failure;
    for (const record of records) abortWorker(record);
    if (disposed) {
      forcedExpired = true;
      for (const record of records) if (!record.done) void record.worker.terminate();
    } else forced = setTimeout(() => { forcedExpired = true; for (const record of records) if (!record.done) void record.worker.terminate(); }, declaration.abortGraceMs);
    input.onFailure?.(failure);
  };
  const aborted = () => fail(input.signal?.reason ?? Error("Worker execution cancelled"));
  const sample = () => {
    if (disposed) return;
    const rss = (input.rss ?? (() => Math.max(process.memoryUsage().rss, process.resourceUsage().maxRSS * 1024)))();
    if (!Number.isSafeInteger(rss) || rss < 1) { fail(Error("Worker RSS measurement unavailable")); return; }
    peakRss = Math.max(peakRss, rss);
    if (rss > declaration.maxNodeRssBytes) fail(Error("Worker aggregate Node RSS budget exceeded"));
  };
  return {
    get failed() { return failed; }, get error() { return error; }, get peakRss() { return peakRss; },
    start(): void {
      if (started || disposed || failed) return;
      started = true;
      input.signal?.addEventListener("abort", aborted, { once: true });
      if (input.signal?.aborted) { aborted(); return; }
      sample();
      if (!failed) monitor = setInterval(sample, 100);
    },
    track(worker: ExecutionWorker): WorkerExecutionRecord {
      let resolveExit!: () => void;
      const record = { worker, exited: new Promise<void>(resolve => { resolveExit = resolve; }), done: false, exitCode: undefined as number | undefined };
      records.push(record);
      worker.on("error", fail);
      worker.on("exit", (code: number) => { record.done = true; record.exitCode = code; resolveExit(); });
      if (disposed && !failed) { fail(Error("Worker execution lifecycle is disposed")); return record; }
      if (failed) { abortWorker(record); if ((forcedExpired || disposed) && !record.done) void worker.terminate(); }
      return record;
    },
    sample, fail,
    async drain(): Promise<void> {
      let count: number;
      do { count = records.length; await Promise.all(records.map(record => record.exited)); } while (records.length !== count);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (monitor) clearInterval(monitor);
      if (forced) clearTimeout(forced);
      input.signal?.removeEventListener("abort", aborted);
    }
  };
}
