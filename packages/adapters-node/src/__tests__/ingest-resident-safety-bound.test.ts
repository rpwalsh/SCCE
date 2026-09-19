// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { totalmem } from "node:os";
import { residentSafetyBoundMiBForTest } from "../wikipedia-v3-ingestor.js";

// A clean scce5 run died inside train.compile at 598 MiB of heap and 4,390 MiB of RSS. The heap checkpoint
// fires on heapUsed, which was nowhere near its 5,161 MiB limit, so the child was lost instead of checkpointed
// and the supervisor stopped the whole run. memorySafetyBoundMb -- declared, validated, plumbed through, and
// written into every checkpoint and event -- was compared against nothing at all.
//
// It also has to be capped by the machine: an 8,192 MiB bound on a 15,921 MiB box that also hosts the database
// this ingest writes to is not a bound, and a bound above physical memory is the same as no bound.

describe("the resident safety bound", () => {
  it("is nothing when nothing was declared, so behaviour is unchanged without config", () => {
    expect(residentSafetyBoundMiBForTest(undefined)).toBe(0);
    expect(residentSafetyBoundMiBForTest(0)).toBe(0);
    expect(residentSafetyBoundMiBForTest(-1)).toBe(0);
  });

  it("never exceeds the memory the machine actually has", () => {
    const totalMiB = Math.round(totalmem() / 1024 / 1024);
    // A bound far larger than the machine is how the check gets silently disabled.
    expect(residentSafetyBoundMiBForTest(totalMiB * 16)).toBeLessThanOrEqual(totalMiB);
  });

  it("honours a declared bound that the machine can accommodate", () => {
    // Small enough that neither the machine cap nor the reachable cap can be the binding constraint.
    expect(residentSafetyBoundMiBForTest(600)).toBe(600);
  });

  it("never returns a bound so small that ingest could not make progress", () => {
    // A bound below the floor would checkpoint on the first page forever.
    expect(residentSafetyBoundMiBForTest(1)).toBeGreaterThanOrEqual(512);
  });
});
