import { describe, expect, it } from "vitest";
import {
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
});
