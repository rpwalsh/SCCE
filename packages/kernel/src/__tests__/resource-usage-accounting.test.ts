import { describe, expect, it } from "vitest";
import { measureResourceUsageDelta, wallEnergyJoules, type ResourceUsageSnapshot } from "../resource-usage-accounting.js";

// Plan item 236 (measurement half): real measured wall-energy accounting
// inputs, and a real joule conversion that only ever runs off an
// explicitly injected, calibrated power model -- never a fabricated
// default coefficient.

function snapshot(overrides: Partial<ResourceUsageSnapshot> = {}): ResourceUsageSnapshot {
  return {
    cpuUserMicros: 0,
    cpuSystemMicros: 0,
    residentSetBytes: 0,
    wallClockNanos: 0n,
    diskBytesRead: 0,
    diskBytesWritten: 0,
    ...overrides
  };
}

describe("measureResourceUsageDelta", () => {
  it("computes real deltas across every dimension", () => {
    const start = snapshot({ cpuUserMicros: 1000, cpuSystemMicros: 500, residentSetBytes: 1_000_000, wallClockNanos: 0n, diskBytesRead: 100, diskBytesWritten: 50 });
    const end = snapshot({ cpuUserMicros: 5000, cpuSystemMicros: 1500, residentSetBytes: 1_500_000, wallClockNanos: 2_000_000n, diskBytesRead: 400, diskBytesWritten: 300 });
    const usage = measureResourceUsageDelta(start, end);
    expect(usage).toEqual({
      cpuUserMs: 4, cpuSystemMs: 1, peakResidentSetBytes: 1_500_000, wallClockMs: 2, diskBytesRead: 300, diskBytesWritten: 250
    });
  });

  it("peak resident-set size is the real maximum of the two endpoints, not the delta", () => {
    const start = snapshot({ residentSetBytes: 2_000_000 });
    const end = snapshot({ residentSetBytes: 1_800_000, wallClockNanos: 1_000_000n });
    expect(measureResourceUsageDelta(start, end).peakResidentSetBytes).toBe(2_000_000);
  });

  it("throws when the end snapshot precedes the start snapshot", () => {
    expect(() => measureResourceUsageDelta(snapshot({ wallClockNanos: 5_000_000n }), snapshot({ wallClockNanos: 1_000_000n }))).toThrow();
  });

  it("CRITICAL fix: rejects a NaN/Infinity/negative raw reading before any arithmetic, rather than silently producing NaN or a masked negative delta", () => {
    expect(() => measureResourceUsageDelta(snapshot({ cpuUserMicros: Number.NaN }), snapshot())).toThrow(/cpuUserMicros/);
    expect(() => measureResourceUsageDelta(snapshot({ cpuSystemMicros: Number.POSITIVE_INFINITY }), snapshot())).toThrow(/cpuSystemMicros/);
    expect(() => measureResourceUsageDelta(snapshot({ residentSetBytes: -1 }), snapshot())).toThrow(/residentSetBytes/);
    expect(() => measureResourceUsageDelta(snapshot(), snapshot({ diskBytesRead: Number.NaN }))).toThrow(/diskBytesRead/);
    expect(() => measureResourceUsageDelta(snapshot(), snapshot({ diskBytesWritten: -5 }))).toThrow(/diskBytesWritten/);
  });

  it("CRITICAL fix: rejects a negative wallClockNanos on either snapshot", () => {
    expect(() => measureResourceUsageDelta(snapshot({ wallClockNanos: -1n }), snapshot())).toThrow(/wallClockNanos/);
  });

  it("CRITICAL fix: rejects an implausibly large wall-clock delta rather than silently losing precision in the bigint-to-number conversion", () => {
    expect(() => measureResourceUsageDelta(snapshot(), snapshot({ wallClockNanos: 10_000_000_000_000_000n }))).toThrow(/plausible duration/);
  });
});

describe("wallEnergyJoules (real conversion off an explicit, injected power model only)", () => {
  it("computes a real joule figure from real measurements and a real calibrated model", () => {
    const usage = measureResourceUsageDelta(
      snapshot(),
      snapshot({ cpuUserMicros: 2_000_000, residentSetBytes: 100, wallClockNanos: 1_000_000_000n })
    );
    const joules = wallEnergyJoules(usage, { joulesPerCpuMs: 0.05, joulesPerByteMsResident: 0.000001, joulesPerByteDiskIo: 0 });
    // cpuUserMs=2000 -> 100 joules from CPU; residentBytes(100) x wallClockMs(1000) x 0.000001 = 0.1 joules.
    expect(joules).toBeCloseTo(100.1, 6);
  });

  it("rejects a negative or non-finite power-model coefficient rather than producing a nonsensical figure", () => {
    const usage = measureResourceUsageDelta(snapshot(), snapshot({ wallClockNanos: 1_000_000n }));
    expect(() => wallEnergyJoules(usage, { joulesPerCpuMs: -1, joulesPerByteMsResident: 0, joulesPerByteDiskIo: 0 })).toThrow();
    expect(() => wallEnergyJoules(usage, { joulesPerCpuMs: Number.NaN, joulesPerByteMsResident: 0, joulesPerByteDiskIo: 0 })).toThrow();
  });

  it("zero measured usage under any real model produces exactly zero joules", () => {
    const usage = measureResourceUsageDelta(snapshot(), snapshot());
    expect(wallEnergyJoules(usage, { joulesPerCpuMs: 1, joulesPerByteMsResident: 1, joulesPerByteDiskIo: 1 })).toBe(0);
  });
});
