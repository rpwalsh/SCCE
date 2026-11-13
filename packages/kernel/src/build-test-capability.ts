// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { toJsonValue } from "./primitives.js";
import type { BuildTestPort } from "./storage.js";
import type { BuildTestResult, ConstructGraph, EpisodeId, JsonValue } from "./types.js";
import type { CapabilityExecutor } from "./capability-dispatcher.js";

export function buildTestEvidenceRefs(result: BuildTestResult): string[] {
  return [`build_test.build.code.${result.build.code ?? "null"}`, `build_test.test.code.${result.test.code ?? "null"}`];
}

export function buildTestActualDelta(construct: ConstructGraph, result: BuildTestResult): JsonValue {
  return toJsonValue({ programId: construct.program?.id ?? null, buildCode: result.build.code, testCode: result.test.code, passed: result.passed,
    artifacts: result.artifacts.map(artifact => ({ path: artifact.path, contentHash: artifact.contentHash })) });
}

export function createBuildTestCapabilityExecutor(input: { buildTest: BuildTestPort; capabilityId: string; onResult?(result: BuildTestResult): void }): CapabilityExecutor {
  return {
    descriptor: { capabilityId: input.capabilityId, idempotency: "non-repeatable", rollback: "unavailable" },
    execute: async request => {
      const payload = request.payload as unknown as { episodeId: EpisodeId; construct: ConstructGraph };
      const result = await input.buildTest.executeProgram(payload);
      input.onResult?.(result);
      return {
        status: result.passed ? "succeeded" : "failed", outputRefs: result.artifacts.map(artifact => artifact.path),
        evidenceRefs: buildTestEvidenceRefs(result),
        attestationRef: `build_test.${request.invocation.idempotencyKey}`,
        actualDelta: buildTestActualDelta(payload.construct, result)
      };
    }
  };
}
