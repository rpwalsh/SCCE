import { describe, expect, it, vi } from "vitest";
import { createRuntimeStartupReadiness, startRuntimeSurface } from "../startup.js";

describe("server runtime startup sequencing", () => {
  it("listens before starting the default background warmup", async () => {
    const calls: string[] = [];
    let finishWarmup: (() => void) | undefined;
    const warmupGate = new Promise<void>(resolve => { finishWarmup = resolve; });
    const readiness = createRuntimeStartupReadiness();

    await startRuntimeSurface({
      warmupEnabled: true,
      strictWarmup: false,
      listen: async () => { calls.push("listen"); },
      warmup: async () => { calls.push("warmup"); await warmupGate; },
      onBackgroundWarmupError: vi.fn(),
      readiness
    });

    expect(calls).toEqual(["listen", "warmup"]);
    expect(readiness.snapshot()).toMatchObject({ phase: "running", ok: false, complete: false });
    finishWarmup?.();
    await warmupGate;
    await vi.waitFor(() => expect(readiness.snapshot()).toMatchObject({ phase: "ready", ok: true, complete: true }));
  });

  it("keeps explicit strict warmup as a pre-listen gate", async () => {
    const calls: string[] = [];
    const readiness = createRuntimeStartupReadiness();

    await startRuntimeSurface({
      warmupEnabled: true,
      strictWarmup: true,
      listen: async () => { calls.push("listen"); },
      warmup: async () => { calls.push("warmup"); },
      onBackgroundWarmupError: vi.fn(),
      readiness
    });

    expect(calls).toEqual(["warmup", "listen"]);
    expect(readiness.snapshot()).toMatchObject({ phase: "ready", ok: true, complete: true });
  });

  it("reports a background warmup failure without retracting the listening surface", async () => {
    const calls: string[] = [];
    const error = new Error("warmup fixture");
    const onBackgroundWarmupError = vi.fn();
    const readiness = createRuntimeStartupReadiness();

    await startRuntimeSurface({
      warmupEnabled: true,
      strictWarmup: false,
      listen: async () => { calls.push("listen"); },
      warmup: async () => { calls.push("warmup"); throw error; },
      onBackgroundWarmupError,
      readiness
    });
    await vi.waitFor(() => expect(onBackgroundWarmupError).toHaveBeenCalledWith(error));

    expect(calls).toEqual(["listen", "warmup"]);
    expect(readiness.snapshot()).toMatchObject({ phase: "failed", ok: false, complete: false, error: "warmup fixture" });
  });

  it("keeps readiness false when startup warmup is explicitly disabled", async () => {
    const readiness = createRuntimeStartupReadiness();

    await startRuntimeSurface({
      warmupEnabled: false,
      strictWarmup: false,
      listen: vi.fn(async () => undefined),
      warmup: vi.fn(async () => undefined),
      onBackgroundWarmupError: vi.fn(),
      readiness
    });

    expect(readiness.snapshot()).toMatchObject({ phase: "disabled", ok: false, complete: false });
  });
});
