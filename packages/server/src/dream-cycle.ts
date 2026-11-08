// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { createNodeRuntime } from "@scce/adapters-node";
import { LANGUAGE_CORPUS_TRAINING_RECIPE_ID, trainStoredCorpusConstructions } from "@scce/adapters-node";

export interface DreamCycleConfig {
  enabled?: boolean;
  idleMinutes?: number;
  batchBytes?: number;
  heapCheckpointMb?: number;
}

export interface DreamCycleHandle {
  /** Call on every inbound API request so the cycle knows the system is awake. */
  recordActivity(): void;
  beginActivity(): () => void;
  stop(): Promise<void>;
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
  let stopped = false;
  let activeRequests = 0;
  let controller: AbortController | undefined;
  let activeRun: Promise<void> | undefined;
  const cursorId = `dream-cycle:wikipedia:${LANGUAGE_CORPUS_TRAINING_RECIPE_ID}`;
  const cursorUri = `scce://dream-cycle/wikipedia/${LANGUAGE_CORPUS_TRAINING_RECIPE_ID}`;

  const timer = setInterval(() => {
    if (stopped || !enabled || dreaming || activeRequests > 0) return;
    if (Date.now() - lastActivityAt < idleMs) return;
    dreaming = true;
    controller = new AbortController();
    const signal = controller.signal;
    activeRun = (async () => {
      try {
        const checkpoint = await input.runtime.storage.ingestion.get(cursorId);
        const metadata = checkpoint?.metadata;
        if (checkpoint && (!metadata || typeof metadata !== "object" || Array.isArray(metadata)
          || metadata.schema !== "scce.dream_source_cursor.v1"
          || metadata.recipeId !== LANGUAGE_CORPUS_TRAINING_RECIPE_ID
          || metadata.nextSourceVersionId !== null && typeof metadata.nextSourceVersionId !== "string")) {
          throw new Error("dream source cursor is invalid");
        }
        const afterSourceVersionId = metadata && typeof metadata === "object" && !Array.isArray(metadata)
          && typeof metadata.nextSourceVersionId === "string" ? metadata.nextSourceVersionId : undefined;
        if (signal.aborted) return;
        const report = await trainStoredCorpusConstructions({
          storage: input.runtime.storage,
          ...(afterSourceVersionId ? { afterSourceVersionId } : {}),
          maxTotalBytes: batchBytes,
          batchBytes,
          heapCheckpointMb,
          signal
        });
        if (report.batchesTrained > 0) {
          await input.runtime.kernel.refreshAfterBrainActivation();
        }
        if (report.stoppedByStorageFailure || report.batchesFailed.length) throw new Error("dream training reported incomplete source work; source cursor retained");
        if (report.stoppedByInterruption && report.sourcesConsidered === 0) {
          log("SCCE dream cycle: interrupted before a source completed; source cursor retained");
          return;
        }
        await input.runtime.storage.ingestion.put({
          id: cursorId, rootUri: cursorUri, itemUri: cursorUri, phase: "stored", status: "complete", offsetBytes: 0,
          updatedAt: Date.now(), metadata: { schema: "scce.dream_source_cursor.v1", recipeId: LANGUAGE_CORPUS_TRAINING_RECIPE_ID,
            nextSourceVersionId: report.exhausted ? null : report.nextSourceVersionId, exhausted: report.exhausted,
            interrupted: report.stoppedByInterruption ?? false }
        });
        if (report.stoppedByInterruption) log(`SCCE dream cycle: interrupted after ${report.sourcesConsidered} completed sources; checkpointed through ${report.nextSourceVersionId}`);
        if (report.batchesTrained > 0) {
          log(`SCCE dream cycle: trained batch ${report.nextBatchIndex - 1} (${report.articlesTrained} articles, +${report.reports.reduce((sum, item) => sum + item.languageConstructions, 0)} constructions)`);
        }
      } catch (error) {
        log(`SCCE dream cycle batch failed (will retry next idle period): ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        dreaming = false;
        controller = undefined;
        // A dream consumed real time; require a fresh idle window before
        // the next one rather than chaining batches back-to-back.
        lastActivityAt = Date.now();
      }
    })();
  }, 30_000);
  timer.unref?.();

  const recordActivity = () => {
    lastActivityAt = Date.now();
    controller?.abort();
  };

  return {
    recordActivity,
    beginActivity() {
      activeRequests++;
      recordActivity();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeRequests--;
        recordActivity();
      };
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      controller?.abort();
      return activeRun ?? Promise.resolve();
    }
  };
}
