import type { createNodeRuntime } from "@scce/adapters-node";
import { trainStoredCorpusConstructions } from "@scce/adapters-node";

export interface DreamCycleConfig {
  enabled?: boolean;
  idleMinutes?: number;
  batchBytes?: number;
  heapCheckpointMb?: number;
}

export interface DreamCycleHandle {
  /** Call on every inbound API request so the cycle knows the system is awake. */
  recordActivity(): void;
  stop(): void;
}

/**
 * The idle-time consolidation ("dreaming") loop: when no requests have
 * arrived for `idleMinutes`, run ONE bounded stored-corpus construction-
 * training batch -- reprocessing text the blob store already holds into
 * generalized language structures -- then yield. One batch per idle
 * window, never concurrent with itself, immediately deferential: any
 * inbound request resets the idle clock so the next batch waits for the
 * next quiet period. This is the same production lane operators run by
 * hand (`scce corpus train wikipedia-stored`), scheduled into the
 * machine's own downtime; batches are byte-bounded and resumable, so a
 * dream interrupted by shutdown loses nothing.
 */
export function startDreamCycle(input: {
  runtime: ReturnType<typeof createNodeRuntime>;
  config?: DreamCycleConfig;
  log?: (line: string) => void;
}): DreamCycleHandle {
  const enabled = input.config?.enabled !== false;
  const idleMs = Math.max(60_000, Math.floor((input.config?.idleMinutes ?? 15) * 60_000));
  const batchBytes = Math.max(64 * 1024, Math.floor(input.config?.batchBytes ?? 512 * 1024));
  const heapCheckpointMb = Math.max(256, Math.floor(input.config?.heapCheckpointMb ?? 2048));
  const log = input.log ?? ((line: string) => process.stdout.write(`${line}\n`));
  let lastActivityAt = Date.now();
  let dreaming = false;
  let nextBatchIndex = 0;
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped || !enabled || dreaming) return;
    if (Date.now() - lastActivityAt < idleMs) return;
    dreaming = true;
    void (async () => {
      try {
        const report = await trainStoredCorpusConstructions({
          storage: input.runtime.storage,
          startBatchIndex: nextBatchIndex,
          maxTotalBytes: batchBytes,
          batchBytes,
          heapCheckpointMb
        });
        if (report.batchesTrained > 0) {
          nextBatchIndex = report.nextBatchIndex;
          log(`SCCE dream cycle: trained batch ${report.nextBatchIndex - 1} (${report.articlesTrained} articles, +${report.reports.reduce((sum, item) => sum + item.languageConstructions, 0)} constructions)`);
        } else {
          // Nothing left to dream about at this index -- wrap around so a
          // later idle period re-extracts from the top with whatever
          // evaluator improvements have landed since.
          nextBatchIndex = 0;
        }
      } catch (error) {
        log(`SCCE dream cycle batch failed (will retry next idle period): ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        dreaming = false;
        // A dream consumed real time; require a fresh idle window before
        // the next one rather than chaining batches back-to-back.
        lastActivityAt = Date.now();
      }
    })();
  }, 30_000);
  timer.unref?.();

  return {
    recordActivity() {
      lastActivityAt = Date.now();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    }
  };
}
