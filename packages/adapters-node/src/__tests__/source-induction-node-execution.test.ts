// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { canonicalStringify, compileSourceInductionWindows, compileSourceInductionWindowsAsync, createHasher, inductionCharBudget,
  inductionDocumentCharCap, sourceInductionBatchJobDigest, sourceInductionBatches, type SourceInductionBatchJob } from "@scce/kernel";
import { createSourceInductionExecution, validateSourceInductionWorkerExecution, type SourceInductionWorkerExecution } from "../source-induction-execution.js";
import { createSourceInductionWorkerSession } from "../source-induction-worker-session.js";
import type { ExecutionWorker } from "../worker-execution-lifecycle.js";
const policy: SourceInductionWorkerExecution = { backend: "node_workers.v1", workers: 2, workerHeapMb: 32, maxNodeRssBytes: 1024 ** 3, abortGraceMs: 5 };
const hasher = createHasher(), documents = [{ id: "source.owned", text: "oma vela. oma neri. ? e\u0301. ".repeat(3) }];
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
class Peer extends EventEmitter {
  done = false; terminated = 0; induced = 0; state?: ReturnType<typeof createSourceInductionWorkerSession>; digest?: string;
  constructor(readonly options: { hang?: boolean; ignoreAbort?: boolean; foreign?: boolean; ready?: boolean } = {}) {
    super(); if (options.ready !== false) queueMicrotask(() => this.emit("message", { type: "ready", kind: "source_induction", bundleDigest: "bundle" }));
  }
  postMessage(message: { type: string; job?: SourceInductionBatchJob; jobDigest?: string; corpus?: Parameters<ReturnType<typeof createSourceInductionWorkerSession>["verify"]>[0] }) {
    queueMicrotask(() => {
      if (this.done) return;
      if (message.type === "abort" || message.type === "shutdown") { if (!(message.type === "abort" && this.options.ignoreAbort)) this.exit(); return; }
      try {
        if (message.type === "prepare") { this.digest = message.job!.jobDigest; this.state = createSourceInductionWorkerSession(structuredClone(message.job!));
          this.reply({ type: "prepared", preparations: this.state.preparations }); }
        else if (message.type === "verify") this.reply({ type: "verified", identity: this.state!.verify(message.corpus) });
        else if (message.type === "induce") { if (this.options.hang) return; this.induced++; this.reply({ type: "result", product: this.state!.induce() }); }
        else if (message.type === "release") { this.state?.close(); this.state = undefined; this.reply({ type: "released" }); this.digest = undefined; }
      } catch (error) { this.reply({ type: "error", error: { name: "Error", message: error instanceof Error ? error.message : String(error) } }); }
    });
  }
  reply(value: object) { this.emit("message", structuredClone({ ...value, jobDigest: this.options.foreign ? "foreign" : this.digest })); }
  exit() { if (this.done) return; this.done = true; this.state?.close(); this.emit("exit", 0); }
  async terminate() { this.terminated++; this.exit(); return 0; }
}
const cast = (worker: Peer) => worker as unknown as ExecutionWorker;
function fixture(options: ConstructorParameters<typeof Peer>[0] = {}, signal?: AbortSignal) {
  const workers: Peer[] = [];
  const owner = createSourceInductionExecution({ policy, signal }, { worker: () => { const peer = new Peer(options); workers.push(peer); return cast(peer); },
    bundleDigest: async () => "bundle", coordinatorHeapLimitBytes: 1024, rss: () => 123456, cpus: () => 4, freeMemory: () => 8 * 1024 ** 3 });
  return { workers, owner };
}
function job(): SourceInductionBatchJob {
  const batch = sourceInductionBatches([{ id: "single", text: "oma vela." }], hasher).next().value!;
  const body = { ordinal: 0, batch, retainFullModel: true, batchBudgetUtf16: inductionCharBudget(), windowCapUtf16: inductionDocumentCharCap() };
  return { ...body, jobDigest: sourceInductionBatchJobDigest(body, hasher) };
}
it("reuses one explicitly owned worker pool across source items and drains it once", async () => {
  vi.stubEnv("SCCE_INDUCTION_CHAR_BUDGET", "64"); vi.stubEnv("SCCE_INDUCTION_DOC_CHAR_CAP", "32");
  const f = fixture(), expected = compileSourceInductionWindows({ documents, hasher });
  const first = await compileSourceInductionWindowsAsync({ documents, hasher, execution: f.owner.execution });
  expect(canonicalStringify(first)).toBe(canonicalStringify(expected));
  expect(f.workers).toHaveLength(2);
  expect(f.workers.every(worker => !worker.done && worker.state === undefined)).toBe(true);
  expect(f.owner.receipt()).toMatchObject({ workersStarted: 2, preparedBatches: first.models.length,
    inducedBatches: first.models.length, peakNodeRssBytes: 123456 });

  const second = await compileSourceInductionWindowsAsync({ documents, hasher, execution: f.owner.execution });
  expect(canonicalStringify(second)).toBe(canonicalStringify(expected));
  expect(f.workers).toHaveLength(2);
  await f.owner.close();
  expect(f.workers).toHaveLength(2); expect(f.workers.every(worker => worker.done)).toBe(true);
  expect(f.owner.receipt()).toMatchObject({ workersStarted: 2, preparedBatches: first.models.length + second.models.length,
    inducedBatches: first.models.length + second.models.length, peakNodeRssBytes: 123456 });
  await f.owner.close();
});
it("cancels an in-flight synchronous job through the shared grace/terminate/drain path", async () => {
  const controller = new AbortController(), f = fixture({ hang: true, ignoreAbort: true }, controller.signal);
  const pending = compileSourceInductionWindowsAsync({ documents: [{ id: "one", text: "oma vela." }], hasher, execution: f.owner.execution, signal: controller.signal });
  await vi.waitFor(() => expect(f.workers.some(worker => worker.state)).toBe(true));
  controller.abort(Error("owner cancelled")); await expect(pending).rejects.toThrow("owner cancelled");
  expect(f.workers.every(worker => worker.done && worker.terminated === 1)).toBe(true); await f.owner.close(controller.signal.reason);
});
it("closes during worker startup without leaving ready promises or workers alive", async () => {
  const f = fixture({ ready: false }), pending = f.owner.execution.open(job());
  const rejected = expect(pending).rejects.toThrow("cancel startup");
  await vi.waitFor(() => expect(f.workers).toHaveLength(2));
  await f.owner.close(Error("cancel startup")); await rejected; expect(f.workers.every(worker => worker.done)).toBe(true);
});
it("refuses wrong-session responses without serial fallback and drains all resources", async () => {
  const f = fixture({ foreign: true });
  await expect(compileSourceInductionWindowsAsync({ documents: [{ id: "one", text: "oma vela." }], hasher, execution: f.owner.execution })).rejects.toThrow("identity");
  expect(f.workers.every(worker => worker.done && worker.induced === 0)).toBe(true);
});
it("validates explicit source policy without starting workers or accepting PG-only fields", async () => {
  expect(validateSourceInductionWorkerExecution(policy)).toEqual(policy);
  expect(() => validateSourceInductionWorkerExecution({ ...policy, totalPgConnections: 1 } as unknown as SourceInductionWorkerExecution)).toThrow("declaration");
  const worker = vi.fn();
  for (const dependencies of [{ cpus: () => 1, freeMemory: () => 8 * 1024 ** 3 }, { cpus: () => 4, freeMemory: () => 0 }]) {
    const owner = createSourceInductionExecution({ policy }, { ...dependencies, worker, bundleDigest: async () => "bundle", coordinatorHeapLimitBytes: 1024 });
    await expect(owner.execution.open(job())).rejects.toThrow(/capacity|headroom/u); await owner.close();
  }
  expect(worker).not.toHaveBeenCalled();
});
