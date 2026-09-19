// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Stage accounting for ingestion, so a stall identifies itself instead of being sampled at from outside.
//
// Sampling a running ingest from the inspector cannot tell you which PHASE it caught. Measured the hard way: a
// heap sample taken minutes after a stall reported the write phase's allocation sites, and those were read as
// the stall's cause. Two further outside-in hypotheses died the same way. The fix is that every stage records
// its own wall time, CPU time and memory as it runs, so the sum can be compared against total wall time and any
// unattributed interval is visible as a gap rather than inferred.
//
// Off unless SCCE_INGEST_TRACE names a file. When off, `stage()` is a direct call with no timing and no
// allocation, so cognition and scheduling are identical whether tracing is on or not.

import type { JsonValue } from "./types.js";

export interface StageRecord {
  readonly stage: string;
  /**
   * "begin" is written when a stage opens and "end" when it closes. Without the begin record a stage that is
   * still running writes nothing, so the one case worth observing -- a stall in progress -- is invisible in the
   * trace. Measured: five minutes of stall produced an empty file.
   */
  readonly phase: "begin" | "end";
  /** Monotonic milliseconds. */
  readonly wallMs: number;
  readonly cpuUserMs: number;
  readonly cpuSystemMs: number;
  readonly heapBeforeMB: number;
  readonly heapAfterMB: number;
  readonly rssAfterMB: number;
  /** Stage-supplied counts: rows, candidates, bytes, whatever the stage measured. */
  readonly counters?: Readonly<Record<string, number>>;
  readonly startedAtMs: number;
  readonly endedAtMs: number;
  readonly failed?: boolean;
}

export interface StageSink {
  record(entry: StageRecord): void;
}

const MB = 1024 * 1024;

/** A tracer that keeps nothing and costs nothing: the shape used when tracing is off. */
const DISABLED: IngestStageTracer = {
  enabled: false,
  async stage(_name, operation) { return operation({ setCounters() { /* nothing */ } }); },
  mark() { /* nothing */ },
  span() { return { end() { /* nothing */ } }; },
  drain() { return []; }
};

export interface StageSpan {
  end(counters?: Readonly<Record<string, number>>): void;
}

export interface IngestStageTracer {
  readonly enabled: boolean;
  /** Time one stage. `counters` may be returned by the operation via `setCounters`. */
  stage<T>(
    name: string,
    operation: (span: { setCounters(counters: Readonly<Record<string, number>>): void }) => Promise<T> | T
  ): Promise<T>;
  /** A zero-duration event, for boundaries like a commit point. */
  mark(name: string, counters?: Readonly<Record<string, number>>): void;
  /** For stages whose start and end are not lexically nested. */
  span(name: string): StageSpan;
  drain(): readonly StageRecord[];
}

export function createIngestStageTracer(sink?: StageSink): IngestStageTracer {
  if (!sink) return DISABLED;
  const records: StageRecord[] = [];
  const emit = (entry: StageRecord) => {
    records.push(entry);
    sink.record(entry);
  };
  const open = (name: string) => {
    const startedAtMs = Date.now();
    const wall = process.hrtime.bigint();
    const cpu = process.cpuUsage();
    const heapBefore = process.memoryUsage().heapUsed;
    const openMemory = process.memoryUsage();
    emit({
      stage: name,
      phase: "begin",
      wallMs: 0,
      cpuUserMs: 0,
      cpuSystemMs: 0,
      heapBeforeMB: Math.round(heapBefore / MB),
      heapAfterMB: Math.round(heapBefore / MB),
      rssAfterMB: Math.round(openMemory.rss / MB),
      startedAtMs,
      endedAtMs: startedAtMs
    });
    return (counters: Readonly<Record<string, number>> | undefined, failed: boolean) => {
      const spent = process.cpuUsage(cpu);
      const memory = process.memoryUsage();
      emit({
        stage: name,
        phase: "end",
        wallMs: Number(process.hrtime.bigint() - wall) / 1e6,
        cpuUserMs: spent.user / 1000,
        cpuSystemMs: spent.system / 1000,
        heapBeforeMB: Math.round(heapBefore / MB),
        heapAfterMB: Math.round(memory.heapUsed / MB),
        rssAfterMB: Math.round(memory.rss / MB),
        ...(counters ? { counters } : {}),
        startedAtMs,
        endedAtMs: Date.now(),
        ...(failed ? { failed: true } : {})
      });
    };
  };

  return {
    enabled: true,
    async stage(name, operation) {
      const close = open(name);
      let counters: Readonly<Record<string, number>> | undefined;
      try {
        const out = await operation({ setCounters(next) { counters = next; } });
        close(counters, false);
        return out;
      } catch (error) {
        close(counters, true);
        throw error;
      }
    },
    mark(name, counters) {
      const close = open(name);
      close(counters, false);
    },
    span(name) {
      const close = open(name);
      let ended = false;
      return {
        end(counters) {
          if (ended) return;
          ended = true;
          close(counters, false);
        }
      };
    },
    drain() {
      return [...records];
    }
  };
}

/**
 * Where a stage record goes. NDJSON one line per stage, appended, so a stall can be read while it is happening
 * and a crash keeps everything written before it.
 */
export function stageSinkToLines(write: (line: string) => void): StageSink {
  return {
    record(entry) {
      write(`${JSON.stringify(entry as unknown as JsonValue)}\n`);
    }
  };
}

/**
 * What the stage records say about a run: total wall time against the sum of attributed stage time, so an
 * unattributed interval is a number rather than a suspicion. Top-level stages only -- a nested stage's time is
 * already inside its parent, so summing everything would double count.
 */
export function attributionReport(records: readonly StageRecord[]): {
  readonly totalWallMs: number;
  readonly attributedMs: number;
  readonly unattributedMs: number;
  readonly byStage: readonly { stage: string; calls: number; wallMs: number; cpuMs: number; shareOfAttributed: number }[];
  readonly gaps: readonly { afterStage: string; beforeStage: string; wallMs: number }[];
} {
  if (!records.length) {
    return { totalWallMs: 0, attributedMs: 0, unattributedMs: 0, byStage: [], gaps: [] };
  }
  const ordered = [...records].filter(entry => entry.phase === "end").sort((left, right) => left.startedAtMs - right.startedAtMs);
  if (!ordered.length) return { totalWallMs: 0, attributedMs: 0, unattributedMs: 0, byStage: [], gaps: [] };
  const totalWallMs = ordered[ordered.length - 1]!.endedAtMs - ordered[0]!.startedAtMs;

  // Union of covered intervals, so nesting and overlap do not double count.
  const intervals = ordered.map(entry => [entry.startedAtMs, entry.endedAtMs] as const);
  let attributedMs = 0;
  let cursor = -Infinity;
  for (const [start, end] of intervals) {
    const from = Math.max(start, cursor);
    if (end > from) {
      attributedMs += end - from;
      cursor = end;
    }
  }

  // Gaps between consecutive top-level intervals: the intervals nothing claimed.
  const gaps: { afterStage: string; beforeStage: string; wallMs: number }[] = [];
  let reach = ordered[0]!.endedAtMs;
  let reachStage = ordered[0]!.stage;
  for (const entry of ordered.slice(1)) {
    if (entry.startedAtMs > reach) {
      gaps.push({ afterStage: reachStage, beforeStage: entry.stage, wallMs: entry.startedAtMs - reach });
    }
    if (entry.endedAtMs > reach) {
      reach = entry.endedAtMs;
      reachStage = entry.stage;
    }
  }

  const totals = new Map<string, { calls: number; wallMs: number; cpuMs: number }>();
  for (const entry of ordered) {
    const held = totals.get(entry.stage) ?? { calls: 0, wallMs: 0, cpuMs: 0 };
    held.calls += 1;
    held.wallMs += entry.wallMs;
    held.cpuMs += entry.cpuUserMs + entry.cpuSystemMs;
    totals.set(entry.stage, held);
  }
  const byStage = [...totals]
    .map(([stage, held]) => ({
      stage,
      calls: held.calls,
      wallMs: held.wallMs,
      cpuMs: held.cpuMs,
      shareOfAttributed: attributedMs > 0 ? held.wallMs / attributedMs : 0
    }))
    .sort((left, right) => right.wallMs - left.wallMs);

  return {
    totalWallMs,
    attributedMs,
    unattributedMs: Math.max(0, totalWallMs - attributedMs),
    byStage,
    gaps: gaps.sort((left, right) => right.wallMs - left.wallMs)
  };
}
