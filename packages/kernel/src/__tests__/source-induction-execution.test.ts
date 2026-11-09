// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, expect, it, vi } from "vitest";
import { createHasher, canonicalStringify } from "../primitives.js";
import { compileSourceInductionWindows, compileSourceInductionWindowsAsync, compileSourceInductionWindowsFromCorpus, sourceInductionBatches } from "../source-window-induction.js";
import { prepareConstructionInduction, prepareConstructionInductionAsync, preparedLanguageInductionProducts } from "../graph-surface-alignment.js";
import type { SourceInductionBatchExecution, SourceInductionBatchProduct } from "../source-induction-execution.js";
import type { InducedLanguageMemoryModel } from "../language-induction-memory.js";
import { createSourceInductionWorkerSession } from "../../../adapters-node/src/source-induction-worker-session.js";
import { rawCorpusSegmentationFixture } from "./fixtures/raw-corpus-segmentation.js";
const hasher = createHasher();
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
function port(options: { reorder?: boolean; fail?: number; wrongDigest?: boolean } = {}) {
  let active = 0, peak = 0, closed = false, releaseFirst!: () => void;
  const secondFinished = new Promise<void>(resolve => { releaseFirst = resolve; });
  const completed: number[] = [], opened: number[] = [];
  const sessions = new Set<{ close(): Promise<void> }>();
  const close = vi.fn(async () => { closed = true; releaseFirst(); await Promise.all([...sessions].map(session => session.close())); });
  const execution: SourceInductionBatchExecution = { concurrency: 2, close, async open(job) {
    if (closed) throw Error("execution closed");
    opened.push(job.ordinal);
    const raw = createSourceInductionWorkerSession(structuredClone(job)); let released = false;
    active++; peak = Math.max(peak, active);
    const session = { jobDigest: options.wrongDigest ? "foreign" : job.jobDigest, preparations: structuredClone(raw.preparations),
      async verify(wire: Parameters<typeof raw.verify>[0]) { return raw.verify(wire ? structuredClone(wire) : undefined); },
      async induce(): Promise<SourceInductionBatchProduct> {
        try {
          if (job.ordinal === options.fail) throw Error(`source batch ${job.ordinal} failed`);
          const product = structuredClone(raw.induce());
          if (options.reorder && job.ordinal === 0) await secondFinished;
          completed.push(job.ordinal); return product;
        } finally { if (job.ordinal === 1) releaseFirst(); }
      },
      async close() { if (released) return; released = true; raw.close(); active--; sessions.delete(session); } };
    sessions.add(session); return session;
  } };
  return { execution, opened, completed, close, peak: () => peak, active: () => active };
}
const documents = [{ id: "owned.unicode", text: "oma vela. ? e\u0301 ?????. oma neri. ".repeat(5) }];
function bounds() { vi.stubEnv("SCCE_INDUCTION_CHAR_BUDGET", "80"); vi.stubEnv("SCCE_INDUCTION_DOC_CHAR_CAP", "40"); }

it("retires genuinely induced out-of-order batches with exact serial models, coverage, cache order and Unicode ranges", async () => {
  bounds(); const expectedCache = new Map<string, InducedLanguageMemoryModel>(), cache = new Map<string, InducedLanguageMemoryModel>();
  const expected = compileSourceInductionWindows({ documents, hasher, modelCache: expectedCache }), worker = port({ reorder: true });
  const actual = await compileSourceInductionWindowsAsync({ documents, hasher, modelCache: cache, execution: worker.execution });
  expect(worker.completed.slice(0, 2)).toEqual([1, 0]); expect(worker.peak()).toBe(2); expect(worker.active()).toBe(0);
  expect(canonicalStringify(actual)).toBe(canonicalStringify(expected)); expect([...cache.keys()]).toEqual([...expectedCache.keys()]);
  expect(actual.fullModel).toBeUndefined(); expect(Object.isFrozen(actual.models[0])).toBe(true);
  await worker.close();
});
it("preserves single-batch fullModel and suppresses it on an exact cache hit without opening workers", async () => {
  const docs = [{ id: "owned.single", text: "oma vela. oma neri." }], cache = new Map<string, InducedLanguageMemoryModel>(), worker = port();
  const expected = compileSourceInductionWindows({ documents: docs, hasher });
  const actual = await compileSourceInductionWindowsAsync({ documents: docs, hasher, execution: worker.execution, modelCache: cache });
  expect(actual.fullModel).toBeDefined(); expect(canonicalStringify(actual)).toBe(canonicalStringify(expected));
  const cachedWorker = port(); const replay = await compileSourceInductionWindowsAsync({ documents: docs, hasher, execution: cachedWorker.execution, modelCache: cache });
  expect(replay.fullModel).toBeUndefined(); expect(replay.models).toEqual(actual.models); expect(cachedWorker.opened).toEqual([]);
  await worker.close(); await cachedWorker.close();
});
it("singleflights repeated exact batch keys while preserving ordered duplicate products", async () => {
  vi.stubEnv("SCCE_INDUCTION_CHAR_BUDGET", "12"); vi.stubEnv("SCCE_INDUCTION_DOC_CHAR_CAP", "12");
  const repeated = [{ id: "same", text: "oma vela." }, { id: "same", text: "oma vela." }], worker = port();
  const expected = compileSourceInductionWindows({ documents: repeated, hasher, modelCache: new Map() });
  const actual = await compileSourceInductionWindowsAsync({ documents: repeated, hasher, modelCache: new Map(), execution: worker.execution });
  expect(canonicalStringify(actual)).toBe(canonicalStringify(expected)); expect(worker.completed).toHaveLength(1);
  expect(actual.models[0]).toBe(actual.models[1]); await worker.close();
});
it("keeps source and qualification views serial and reuses the existing prepared view identity", async () => {
  bounds(); const subset = [{ id: "fit", text: "oma vela. oma neri." }], worker = port();
  const before = prepareConstructionInduction({ documents, hasher, additionalDocumentSets: [subset], contextDocuments: subset });
  const after = await prepareConstructionInductionAsync({ documents, hasher, execution: worker.execution, additionalDocumentSets: [subset], contextDocuments: subset });
  expect(after.inputDigest).toBe(before.inputDigest);
  expect(canonicalStringify(preparedLanguageInductionProducts({ documents, hasher, prepared: after })))
    .toBe(canonicalStringify(preparedLanguageInductionProducts({ documents, hasher, prepared: before })));
  const opened = worker.opened.length;
  expect(await prepareConstructionInductionAsync({ documents, hasher, execution: worker.execution, additionalDocumentSets: [subset], contextDocuments: subset, prepared: after })).toBe(after);
  expect(worker.opened).toHaveLength(opened); await worker.close();
});
it("rebinds genuine worker-local measurements to centrally loaded corpus slices without a local refit", async () => {
  bounds(); const { loader } = await rawCorpusSegmentationFixture();
  const expected = await compileSourceInductionWindowsFromCorpus({ documents, hasher, corpusLoader: loader }), worker = port({ reorder: true });
  const actual = await compileSourceInductionWindowsAsync({ documents, hasher, corpusLoader: loader, execution: worker.execution });
  expect(canonicalStringify(actual)).toBe(canonicalStringify(expected)); await worker.close();
});
it("keeps only the successfully retired prefix in the cache when a later worker batch fails", async () => {
  bounds(); const worker = port({ fail: 1 }), cache = new Map<string, InducedLanguageMemoryModel>();
  await expect(compileSourceInductionWindowsAsync({ documents, hasher, execution: worker.execution, modelCache: cache })).rejects.toThrow("source batch 1 failed");
  expect(cache.size).toBe(1); expect(worker.active()).toBe(0); expect(worker.close).toHaveBeenCalled();
});
it("rejects foreign jobs and unsupported hasher behavior instead of falling back to serial induction", async () => {
  const docs = [{ id: "owned", text: "oma vela." }], wrong = port({ wrongDigest: true });
  await expect(compileSourceInductionWindowsAsync({ documents: docs, hasher, execution: wrong.execution })).rejects.toThrow("job identity");
  expect(wrong.completed).toEqual([]); expect(wrong.active()).toBe(0);
  const custom = { ...hasher, digestChunks: () => "noncanonical" }, worker = port();
  await expect(compileSourceInductionWindowsAsync({ documents: docs, hasher: custom, execution: worker.execution })).rejects.toThrow("hasher differs");
  expect(worker.completed).toEqual([]);
});
it("does not create worker sessions for entirely empty language material", async () => {
  const worker = port(); const docs = [{ id: "empty", text: " \n\t " }];
  const actual = await compileSourceInductionWindowsAsync({ documents: docs, hasher, execution: worker.execution });
  expect(actual).toEqual(compileSourceInductionWindows({ documents: docs, hasher })); expect(worker.opened).toEqual([]); await worker.close();
});
