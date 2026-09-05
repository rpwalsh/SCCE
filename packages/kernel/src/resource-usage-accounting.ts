// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
/**
 * Plan item 236 (measurement half). Real measured wall-energy accounting
 * inputs -- CPU, RAM, wall-clock, disk -- for a bounded operation. This
 * module only ever reports what was genuinely measured (via injected
 * snapshot functions, so it is testable without real OS calls and usable
 * in `packages/adapters-node` with real `process.cpuUsage()`/
 * `process.memoryUsage()`/`process.hrtime.bigint()` without this pure
 * kernel module depending on Node APIs directly).
 *
 * **Honest scope note**: "the north-star objective's amortized-energy
 * formula" that item 236 asks this to serve, and the `Q,C,A,R,F,H,W`
 * usefulness-per-joule rubric item 237 asks for, are not defined in this
 * repository under any name (searched `docs/*.md` thoroughly -- absent,
 * same as item 155's "Gate II"). Converting the real measurements this
 * module produces into an actual joule figure requires a real, calibrated
 * power model (joules per CPU-ms, joules per byte of RAM-time, joules per
 * byte of disk I/O) specific to real serving hardware -- data this repo
 * does not have and this module will not fabricate. `wallEnergyJoules`
 * below is therefore an explicit, injected function of the real
 * measurements, never a baked-in constant.
 */

export interface ResourceUsageSnapshot {
  /** From `process.cpuUsage().user`, microseconds. */
  cpuUserMicros: number;
  /** From `process.cpuUsage().system`, microseconds. */
  cpuSystemMicros: number;
  /** From `process.memoryUsage().rss`, bytes. */
  residentSetBytes: number;
  /** From `process.hrtime.bigint()`, nanoseconds. */
  wallClockNanos: bigint;
  diskBytesRead: number;
  diskBytesWritten: number;
}

export interface MeasuredResourceUsage {
  cpuUserMs: number;
  cpuSystemMs: number;
  /** Real, not synthesized: the larger of the two snapshots' resident-set sizes -- an operation's peak RSS is never smaller than either endpoint's own reading. */
  peakResidentSetBytes: number;
  wallClockMs: number;
  diskBytesRead: number;
  diskBytesWritten: number;
}

/** A single measured operation is not expected to run longer than this many nanoseconds (~104 days). A `wallClockNanos` delta beyond it indicates corrupted/impossible telemetry, not a real long-running operation -- rejected rather than silently losing precision in the `Number(bigint)` conversion below. */
const MAX_PLAUSIBLE_WALL_CLOCK_NANOS = 9_000_000_000_000_000n;

function validateSnapshot(snapshot: ResourceUsageSnapshot, label: string): void {
  const numericFields: Array<[string, number]> = [
    ["cpuUserMicros", snapshot.cpuUserMicros],
    ["cpuSystemMicros", snapshot.cpuSystemMicros],
    ["residentSetBytes", snapshot.residentSetBytes],
    ["diskBytesRead", snapshot.diskBytesRead],
    ["diskBytesWritten", snapshot.diskBytesWritten]
  ];
  for (const [name, value] of numericFields) {
    if (!Number.isFinite(value) || value < 0) {
      throw new RangeError(`${label} snapshot's ${name} must be a finite, nonnegative number; received ${value}`);
    }
  }
  if (typeof snapshot.wallClockNanos !== "bigint" || snapshot.wallClockNanos < 0n) {
    throw new RangeError(`${label} snapshot's wallClockNanos must be a nonnegative bigint; received ${snapshot.wallClockNanos}`);
  }
}

/** The real delta between two snapshots taken around a bounded operation. Throws on invalid/impossible raw telemetry (negative or non-finite readings) before any arithmetic runs, and on a negative wall-clock delta -- snapshots must be given start-then-end, never out of order. */
export function measureResourceUsageDelta(start: ResourceUsageSnapshot, end: ResourceUsageSnapshot): MeasuredResourceUsage {
  validateSnapshot(start, "start");
  validateSnapshot(end, "end");
  const wallClockNanos = end.wallClockNanos - start.wallClockNanos;
  if (wallClockNanos < 0n) throw new RangeError("end snapshot precedes start snapshot");
  if (wallClockNanos > MAX_PLAUSIBLE_WALL_CLOCK_NANOS) {
    throw new RangeError(`wall-clock delta (${wallClockNanos}ns) exceeds the maximum plausible duration for a single measured operation -- likely corrupted telemetry`);
  }
  return {
    cpuUserMs: Math.max(0, (end.cpuUserMicros - start.cpuUserMicros) / 1000),
    cpuSystemMs: Math.max(0, (end.cpuSystemMicros - start.cpuSystemMicros) / 1000),
    peakResidentSetBytes: Math.max(start.residentSetBytes, end.residentSetBytes),
    wallClockMs: Number(wallClockNanos) / 1_000_000,
    diskBytesRead: Math.max(0, end.diskBytesRead - start.diskBytesRead),
    diskBytesWritten: Math.max(0, end.diskBytesWritten - start.diskBytesWritten)
  };
}

export interface PowerModel {
  /** Joules per CPU-millisecond (user + system combined, or supply separate coefficients by pre-summing before calling). */
  joulesPerCpuMs: number;
  /** Joules per byte-millisecond of resident memory held (peak RSS x wall-clock duration is the real proxy this repo can measure without a memory-controller power sensor). */
  joulesPerByteMsResident: number;
  joulesPerByteDiskIo: number;
}

/**
 * Converts a real measurement into a real joule figure -- only once a
 * caller supplies real, calibrated `PowerModel` coefficients for their
 * actual serving hardware. There is no default `PowerModel` exported
 * here: a fabricated default would misrepresent every deployment that
 * doesn't happen to match whatever machine produced it.
 */
export function wallEnergyJoules(usage: MeasuredResourceUsage, model: PowerModel): number {
  for (const [name, value] of Object.entries(model)) {
    if (!Number.isFinite(value) || value < 0) throw new RangeError(`PowerModel.${name} must be a finite, nonnegative number`);
  }
  const cpuJoules = usage.cpuUserMs * model.joulesPerCpuMs + usage.cpuSystemMs * model.joulesPerCpuMs;
  const residentJoules = usage.peakResidentSetBytes * usage.wallClockMs * model.joulesPerByteMsResident;
  const diskJoules = (usage.diskBytesRead + usage.diskBytesWritten) * model.joulesPerByteDiskIo;
  const total = cpuJoules + residentJoules + diskJoules;
  if (!Number.isFinite(total)) throw new RangeError("wall energy computation overflowed");
  return total;
}

/** The host's own process accounting, or nothing when the host does not expose it. Never synthesized. */
export function captureResourceUsageSnapshot(): ResourceUsageSnapshot | undefined {
  const runtime = (globalThis as { process?: { cpuUsage?: () => { user: number; system: number }; memoryUsage?: () => { rss: number }; hrtime?: { bigint?: () => bigint } } }).process;
  const cpu = runtime?.cpuUsage?.();
  const memory = runtime?.memoryUsage?.();
  const wallClockNanos = runtime?.hrtime?.bigint?.();
  if (!cpu || !memory || wallClockNanos === undefined) return undefined;
  return {
    cpuUserMicros: cpu.user,
    cpuSystemMicros: cpu.system,
    residentSetBytes: memory.rss,
    wallClockNanos,
    diskBytesRead: 0,
    diskBytesWritten: 0
  };
}
