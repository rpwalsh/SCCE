// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  PRODUCTION_INITIAL_VISIBLE_RESPONSE_SCHEMA,
  RUNTIME_DEADLINE_SCHEMA,
  executableRuntimeDeadlineFromMetadata
} from "../index.js";

describe("runtime deadline admission", () => {
  it("reserves response time and refuses work that cannot fit", () => {
    let now = 1_000;
    const deadline = executableRuntimeDeadlineFromMetadata({
      runtime: {
        deadline: {
          schema: RUNTIME_DEADLINE_SCHEMA,
          clock: "node.performance.v1",
          budgetMs: 5_000,
          responseReserveMs: 1_000,
          startedMonotonicMs: 1_000,
          deadlineMonotonicMs: 6_000,
          computeDeadlineMonotonicMs: 5_000
        }
      }
    }, () => now);
    expect(deadline).toBeDefined();
    expect(deadline!.checkpoint("small", 100).allowed).toBe(true);
    expect(deadline!.checkpoint("too-large", 4_001)).toMatchObject({
      allowed: false,
      reason: "compute_reserve_exhausted"
    });
    now = 6_001;
    expect(deadline!.checkpoint("elapsed", 0)).toMatchObject({
      allowed: false,
      reason: "response_deadline_elapsed"
    });
  });

  /**
   * Plan item L7: `packages/server/src/routes.ts`'s `productionTurnDeadlineMetadata`
   * is the only real production writer of this metadata, and it authors
   * `runtime.initialResponseDeadline` with schema
   * `scce.initial_visible_response.v1` -- not `runtime.deadline` with
   * `RUNTIME_DEADLINE_SCHEMA`. Before this test existed, nothing proved the
   * two sides actually agreed on a shape: every real `/api/turn` request
   * silently got no deadline object at all (`executableRuntimeDeadlineFromMetadata`
   * returned `undefined`), so all 16 `deadlineCheckpoint` call sites in
   * `production-turn-runtime.ts` were unconditionally admitted regardless of
   * elapsed time. This reproduces the exact shape the server sends.
   */
  it("recognizes the production server's initialResponseDeadline shape, not just the direct kernel shape", () => {
    let now = 1_000;
    const deadline = executableRuntimeDeadlineFromMetadata({
      runtime: {
        initialResponseDeadline: {
          schema: PRODUCTION_INITIAL_VISIBLE_RESPONSE_SCHEMA,
          clock: "node.performance.v1",
          budgetMs: 5_000,
          startedMonotonicMs: 1_000,
          deadlineMonotonicMs: 6_000,
          propagatedAtMonotonicMs: 1_000,
          remainingMs: 5_000
        }
      }
    }, () => now);
    expect(deadline).toBeDefined();
    expect(deadline!.checkpoint("small", 100).allowed).toBe(true);
    now = 6_001;
    expect(deadline!.checkpoint("elapsed", 0)).toMatchObject({
      allowed: false,
      reason: "response_deadline_elapsed"
    });
  });

  it("ignores a client-supplied runtime.deadline that does not carry the real schema", () => {
    const deadline = executableRuntimeDeadlineFromMetadata({
      runtime: {
        deadline: { schema: "untrusted.deadline" }
      }
    }, () => 1_000);
    expect(deadline).toBeUndefined();
  });
});
