import { describe, expect, it } from "vitest";
import {
  BRAIN_LIFECYCLE_STATES,
  assertBrainLifecycleTransition,
  assertGenericBrainLifecycleTransition,
  canTransitionBrainLifecycle,
  validateBrainManifestContract,
  validationDisposition,
  type BrainManifestContract
} from "../brain-lifecycle.js";

describe("brain lifecycle contract", () => {
  it("allows only declared state transitions", () => {
    expect(BRAIN_LIFECYCLE_STATES).toEqual([
      "CREATED", "IMPORTING", "VALIDATING", "READY", "ACTIVE", "STOPPED", "FAILED", "QUARANTINED", "INCOMPATIBLE"
    ]);
    expect(canTransitionBrainLifecycle("CREATED", "IMPORTING")).toBe(true);
    expect(canTransitionBrainLifecycle("IMPORTING", "READY")).toBe(false);
    expect(canTransitionBrainLifecycle("READY", "ACTIVE")).toBe(true);
    expect(canTransitionBrainLifecycle("ACTIVE", "READY")).toBe(true);
    expect(canTransitionBrainLifecycle("INCOMPATIBLE", "IMPORTING")).toBe(false);
    expect(() => assertBrainLifecycleTransition("IMPORTING", "ACTIVE")).toThrow("invalid brain lifecycle transition IMPORTING -> ACTIVE");
  });

  it("reserves transitions into and out of ACTIVE for atomic activation", () => {
    expect(canTransitionBrainLifecycle("READY", "ACTIVE")).toBe(true);
    expect(canTransitionBrainLifecycle("ACTIVE", "READY")).toBe(true);
    expect(() => assertGenericBrainLifecycleTransition("READY", "ACTIVE")).toThrow("requires activateReady");
    expect(() => assertGenericBrainLifecycleTransition("ACTIVE", "READY")).toThrow("requires activateReady");
    expect(() => assertGenericBrainLifecycleTransition("ACTIVE", "STOPPED")).toThrow("requires activateReady");
    expect(() => assertGenericBrainLifecycleTransition("VALIDATING", "READY")).not.toThrow();
  });

  it("requires a compatible, content-counted, hash-bound manifest before READY", () => {
    const manifest: BrainManifestContract = {
      schema: "scce.brainManifestContract.v1",
      importRunId: "run-1",
      brainVersion: "brain-1",
      rootPath: "/brain/one",
      manifestHash: "a".repeat(64),
      sourceSchema: "scce.brainShardManifest.v3",
      runtimeContractVersion: 1,
      content: { graphShardCount: 1, languageShardCount: 2, ngramStateCount: 3, priorSectionCount: 4 },
      metadata: {},
      createdAt: 1
    };
    const valid = validateBrainManifestContract(manifest);
    expect(validationDisposition(valid)).toBe("PASSED");

    const invalid = validateBrainManifestContract({ ...manifest, manifestHash: "not-a-hash", content: { ...manifest.content, graphShardCount: -1 } });
    expect(validationDisposition(invalid)).toBe("FAILED");
    expect(invalid.filter(check => !check.passed).map(check => check.id)).toEqual(["manifest.hash", "manifest.content.graphShardCount"]);
  });
});
