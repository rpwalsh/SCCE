#!/usr/bin/env node
// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
//
// Reads a trace JSONL already on disk (never the live server) and attributes wall-clock to stages, so a turn's
// real cost breakdown is visible without running anything. Two views:
//   1. explicit durationMs the stage recorded for itself (authoritative where present).
//   2. inter-event gap: time between an event and the next, charged to the event's stage (captures cost that
//      happens between two markers, which is where unmeasured work hides).
import { readFileSync } from "node:fs";

const file = process.argv[2];
if (!file) { process.stderr.write("usage: trace-cost-model.mjs <trace.jsonl> [--turn=N]\n"); process.exit(1); }
const wantTurn = Number((process.argv.find(a => a.startsWith("--turn=")) ?? "").slice(7)) || null;

const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
const events = [];
for (const line of lines) { try { events.push(JSON.parse(line)); } catch { /* skip malformed */ } }

// Segment into turns: each POST /api/turn request opens a turn; the next turn.runtime.end (or next request) closes it.
const turns = [];
let current = null;
for (const e of events) {
  if (e.stage === "api.request" && String(e.label).includes("POST /api/turn")) {
    if (current) turns.push(current);
    current = { start: e.time, events: [] };
  }
  if (current) current.events.push(e);
  if (e.stage === "turn.runtime.end" && current) { current.end = e.time; turns.push(current); current = null; }
}
if (current) turns.push(current);

if (!turns.length) { process.stderr.write("no /api/turn segments found in this trace\n"); process.exit(2); }

process.stdout.write(`file: ${file}\nturns found: ${turns.length}\n`);

const analyze = (turn, idx) => {
  const evs = turn.events;
  const t0 = Date.parse(evs[0].time);
  const tN = Date.parse(evs[evs.length - 1].time);
  const wall = tN - t0;
  // Explicit self-reported durations.
  const explicit = new Map();
  for (const e of evs) if (Number.isFinite(e.durationMs)) explicit.set(e.stage, (explicit.get(e.stage) ?? 0) + e.durationMs);
  // Inter-event gap charged to the stage that was just entered.
  const gap = new Map();
  for (let i = 0; i < evs.length - 1; i++) {
    const dt = Date.parse(evs[i + 1].time) - Date.parse(evs[i].time);
    if (dt > 0) gap.set(evs[i].stage, (gap.get(evs[i].stage) ?? 0) + dt);
  }
  // Bytes / cardinality signals worth surfacing.
  const signals = [];
  for (const e of evs) {
    if (e.counts?.bytes) signals.push(`${e.stage}: ${(e.counts.bytes / 1e6).toFixed(1)}MB (${e.label ?? ""})`);
    if (e.stage === "runtime.start" && e.support?.warmup?.cacheOccupancy) {
      const c = e.support.warmup.cacheOccupancy;
      signals.push(`warmup cache: surfaceProfiles=${c.surfaceProfiles} languageMemoryMB=${(c.languageMemoryEstimatedBytes / 1e6).toFixed(0)}`);
    }
  }

  process.stdout.write(`\n===== turn ${idx + 1}: wall ${wall}ms, ${evs.length} events =====\n`);
  process.stdout.write(`--- top stages by inter-event gap (where wall-clock actually went):\n`);
  for (const [stage, ms] of [...gap].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    process.stdout.write(`  ${String(ms).padStart(6)}ms ${String((100 * ms / wall).toFixed(1)).padStart(5)}%  ${stage}\n`);
  }
  process.stdout.write(`--- stages that self-reported a durationMs:\n`);
  for (const [stage, ms] of [...explicit].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
    process.stdout.write(`  ${String(ms).padStart(6)}ms  ${stage}\n`);
  }
  if (signals.length) { process.stdout.write(`--- data-movement signals:\n`); for (const s of signals.slice(0, 12)) process.stdout.write(`  ${s}\n`); }
};

turns.forEach((t, i) => { if (!wantTurn || i + 1 === wantTurn) analyze(t, i); });
