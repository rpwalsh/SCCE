// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Where ingest stage records go on Node: one NDJSON line per stage, appended as it happens, so a stall can be
// read while it is still stalling and a crash keeps everything written before it. Enabled only by
// SCCE_INGEST_TRACE naming a file; unset, the tracer is the no-op form and costs nothing.

import { appendFileSync } from "node:fs";
import { createIngestStageTracer, stageSinkToLines, type IngestStageTracer } from "@scce/kernel";

export const INGEST_TRACE_ENV = "SCCE_INGEST_TRACE";

let shared: IngestStageTracer | undefined;

/** The process's ingest tracer. One per process, because the trace file is one append stream. */
export function ingestStageTracer(): IngestStageTracer {
  if (shared) return shared;
  const path = process.env[INGEST_TRACE_ENV];
  if (!path) {
    shared = createIngestStageTracer();
    return shared;
  }
  shared = createIngestStageTracer(stageSinkToLines(line => {
    // Synchronous append: a stall must not be hidden by a writer that flushes only after it ends.
    try { appendFileSync(path, line); } catch { /* tracing must never break an ingest */ }
  }));
  return shared;
}
