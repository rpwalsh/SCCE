// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createScceKernel,
  type BuildTestResult,
  type ScceStorage
} from "../index.js";
import { surfaceEchoesPrompt } from "../creative-section-realization.js";
import { storageFixtureForEvaluation } from "./evidence-promotion-evaluation-fixture.js";

/**
 * A turn never speaks its own request back. Measured live 2026-09-12: the program lane went around every
 * lane-level echo guard and answered "Write a JavaScript function that computes time dilation..." with exactly
 * itself. An echo is worse than a decline, because a decline is honest and an echo looks like an answer.
 */
describe("prompt echo refusal", () => {
  const requests = [
    "Zephyr valve pressure stabilizes after calibration.",
    "What is the capital of Peru?",
    "Invent a new indexing algorithm for this graph"
  ];

  for (const text of requests) {
    it(`refuses to answer with the request itself: ${text}`, async () => {
      const result = await turnOnEmptyCorpus(text);

      expect(surfaceEchoesPrompt(result.answer, text), result.answer).toBe(false);
    });
  }
});

async function turnOnEmptyCorpus(text: string) {
  const clock = createClock({ fixedTime: 9000, stepMs: 1 });
  const hasher = createHasher();
  const kernel = createScceKernel({
    storage: turnStorage(clock),
    files: { streamPath: async function* () { /* unused: this turn reads no files */ } },
    buildTest: {
      executeProgram: async (): Promise<BuildTestResult> => ({
        build: emptyCommandResult(),
        test: emptyCommandResult(),
        repairAttempted: false,
        repairApplied: false,
        passed: true,
        artifacts: []
      })
    },
    idFactory: createIdFactory({ clock, hasher, deterministicReplay: true }),
    clock,
    deterministicReplay: true
  });

  return kernel.turn({ text });
}

// The shared evaluation fixture plus the per-conversation stores a turn reads; nothing here carries a corpus.
function turnStorage(clock: ReturnType<typeof createClock>): ScceStorage {
  const base = storageFixtureForEvaluation({ evidence: [], clockNow: () => clock.now() }).storage;
  return {
    ...base,
    userModelClaims: { putClaim: async () => undefined, listClaims: async () => [] },
    taskResumption: { putSnapshot: async () => undefined, getLatestSnapshot: async () => null },
    documentGeneration: {
      putSession: async () => undefined,
      getSession: async () => null,
      compareAndPutSession: async () => ({ stored: true, currentUpdatedAt: null })
    }
  } as unknown as ScceStorage;
}

function emptyCommandResult() {
  return { code: 0, stdout: "", stderr: "", durationMs: 0 };
}
