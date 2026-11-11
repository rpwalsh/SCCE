// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.

/**
 * Browser-safe trace event boundary. The Node trace implementation installs a
 * sink when it is loaded; portable kernel modules can emit diagnostics without
 * importing node:fs or node:path into their dependency graph.
 */
export interface PortableTraceEvent {
  stage: string;
  label?: string;
  durationMs?: number;
  input?: string;
  output?: string;
  counts?: Record<string, number>;
  support?: Record<string, unknown>;
  warnings?: string[];
  file?: string;
  line?: number;
}

export interface PortableTraceHandle {
  traceId: string;
  file: string;
}

type TraceEventSink = (trace: PortableTraceHandle, event: PortableTraceEvent) => void;

const TRACE_SINK = Symbol.for("scce.debug.trace-event-sink.v1");

interface TraceGlobal {
  [TRACE_SINK]?: TraceEventSink;
}

export function installTraceEventSink(sink: TraceEventSink): void {
  (globalThis as TraceGlobal)[TRACE_SINK] = sink;
}

export function traceEvent(trace: PortableTraceHandle | undefined, event: PortableTraceEvent): void {
  if (!trace) return;
  (globalThis as TraceGlobal)[TRACE_SINK]?.(trace, event);
}
