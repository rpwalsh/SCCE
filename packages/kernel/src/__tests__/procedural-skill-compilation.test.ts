import { describe, expect, it } from "vitest";
import {
  compileSkillFromEpisodes,
  executeSkill,
  type ProceduralEpisodeTrace,
  type SkillExecutionContext,
  type SkillStep
} from "../procedural-skill-compilation.js";

const RESTART_STEPS: SkillStep[] = [
  { actionType: "stop_service", input: { service: "worker" } },
  { actionType: "clear_queue", input: { queue: "worker.jobs" } },
  { actionType: "start_service", input: { service: "worker" } }
];

function successfulEpisode(episodeId: string): ProceduralEpisodeTrace {
  return { episodeId, steps: RESTART_STEPS, succeeded: true };
}

describe("procedural skill compilation (plan item 215)", () => {
  it("compiles a real repeated, successful step sequence into a typed skill", () => {
    const skill = compileSkillFromEpisodes({
      episodes: [successfulEpisode("e1"), successfulEpisode("e2"), successfulEpisode("e3")],
      minimumSuccessCount: 3,
      authority: "action",
      cost: 2,
      preconditions: ["worker.unresponsive"],
      postconditions: ["worker.responsive"]
    });
    expect(skill).toBeDefined();
    expect(skill?.steps).toEqual(RESTART_STEPS);
    expect(skill?.sourceEpisodeIds).toEqual(["e1", "e2", "e3"]);
    expect(skill?.authority).toBe("action");
    expect(skill?.preconditions).toEqual(["worker.unresponsive"]);
  });

  it("ignores failed episodes when counting toward the minimum success count", () => {
    const episodes: ProceduralEpisodeTrace[] = [
      successfulEpisode("e1"),
      successfulEpisode("e2"),
      { episodeId: "e3-failed", steps: RESTART_STEPS, succeeded: false }
    ];
    const skill = compileSkillFromEpisodes({ episodes, minimumSuccessCount: 3, authority: "action", cost: 1 });
    expect(skill).toBeUndefined();
  });

  it("does not compile a sequence that repeats fewer times than the required minimum", () => {
    const skill = compileSkillFromEpisodes({
      episodes: [successfulEpisode("e1"), successfulEpisode("e2")],
      minimumSuccessCount: 3,
      authority: "action",
      cost: 1
    });
    expect(skill).toBeUndefined();
  });

  it("prefers the most-repeated distinct step sequence when several candidates exist", () => {
    const otherSteps: SkillStep[] = [{ actionType: "noop", input: {} }];
    const episodes: ProceduralEpisodeTrace[] = [
      successfulEpisode("e1"),
      successfulEpisode("e2"),
      successfulEpisode("e3"),
      { episodeId: "e4", steps: otherSteps, succeeded: true },
      { episodeId: "e5", steps: otherSteps, succeeded: true }
    ];
    const skill = compileSkillFromEpisodes({ episodes, minimumSuccessCount: 2, authority: "action", cost: 1 });
    expect(skill?.steps).toEqual(RESTART_STEPS);
    expect(skill?.sourceEpisodeIds).toEqual(["e1", "e2", "e3"]);
  });
});

describe("skill execution runs purely from the typed program (plan item 216)", () => {
  function recordingContext(handlers: Record<string, (input: unknown) => { ok: boolean; output?: unknown }>) {
    const received: Array<{ actionType: string; input: unknown }> = [];
    const context: SkillExecutionContext = {
      async executeStep(step) {
        received.push({ actionType: step.actionType, input: step.input });
        const handler = handlers[step.actionType];
        return handler ? (handler(step.input) as { ok: boolean; output?: import("../types.js").JsonValue }) : { ok: false };
      }
    };
    return { context, received };
  }

  it("executes every step from the typed program and never receives any conversational text", async () => {
    const skill = compileSkillFromEpisodes({
      episodes: [successfulEpisode("e1"), successfulEpisode("e2"), successfulEpisode("e3")],
      minimumSuccessCount: 3,
      authority: "action",
      cost: 1
    })!;
    const { context, received } = recordingContext({
      stop_service: () => ({ ok: true }),
      clear_queue: () => ({ ok: true }),
      start_service: () => ({ ok: true, output: { restarted: true } })
    });
    const result = await executeSkill(skill, context);
    expect(result.ok).toBe(true);
    expect(result.stepResults.map(step => step.actionType)).toEqual(["stop_service", "clear_queue", "start_service"]);
    expect(result.stepResults[2]?.output).toEqual({ restarted: true });
    // Everything the context ever saw was a typed {actionType, input} pair
    // straight from the compiled program -- never a string of original
    // episode/conversation text.
    expect(received).toEqual(RESTART_STEPS.map(step => ({ actionType: step.actionType, input: step.input })));
    for (const call of received) {
      expect(typeof call.actionType).toBe("string");
      expect(call).not.toHaveProperty("conversationalText");
      expect(call).not.toHaveProperty("episodeId");
    }
  });

  it("stops at the first failing step rather than continuing past it", async () => {
    const skill = compileSkillFromEpisodes({
      episodes: [successfulEpisode("e1"), successfulEpisode("e2"), successfulEpisode("e3")],
      minimumSuccessCount: 3,
      authority: "action",
      cost: 1
    })!;
    const { context, received } = recordingContext({
      stop_service: () => ({ ok: true }),
      clear_queue: () => ({ ok: false })
    });
    const result = await executeSkill(skill, context);
    expect(result.ok).toBe(false);
    expect(received.map(call => call.actionType)).toEqual(["stop_service", "clear_queue"]);
  });

  it("runs the declared rollback program, in reverse order, only when execution actually failed", async () => {
    const rollbackSteps: SkillStep[] = [
      { actionType: "start_service", input: { service: "worker" } },
      { actionType: "restore_queue", input: { queue: "worker.jobs" } }
    ];
    const skill = compileSkillFromEpisodes({
      episodes: [successfulEpisode("e1"), successfulEpisode("e2"), successfulEpisode("e3")],
      minimumSuccessCount: 3,
      authority: "action",
      cost: 1,
      rollbackSteps
    })!;
    const { context, received } = recordingContext({
      stop_service: () => ({ ok: true }),
      clear_queue: () => ({ ok: false }),
      restore_queue: () => ({ ok: true }),
      start_service: () => ({ ok: true })
    });
    const result = await executeSkill(skill, context);
    expect(result.ok).toBe(false);
    expect(result.rolledBack).toBe(true);
    expect(received.map(call => call.actionType)).toEqual([
      "stop_service", "clear_queue", "restore_queue", "start_service"
    ]);
  });

  it("never attempts a rollback when execution succeeds, or when no rollback program was ever declared", async () => {
    const skillWithoutRollback = compileSkillFromEpisodes({
      episodes: [successfulEpisode("e1"), successfulEpisode("e2"), successfulEpisode("e3")],
      minimumSuccessCount: 3,
      authority: "action",
      cost: 1
    })!;
    const { context: succeedingContext } = recordingContext({
      stop_service: () => ({ ok: true }),
      clear_queue: () => ({ ok: true }),
      start_service: () => ({ ok: true })
    });
    expect((await executeSkill(skillWithoutRollback, succeedingContext)).rolledBack).toBe(false);

    const { context: failingContextNoRollback } = recordingContext({
      stop_service: () => ({ ok: true }),
      clear_queue: () => ({ ok: false })
    });
    expect((await executeSkill(skillWithoutRollback, failingContextNoRollback)).rolledBack).toBe(false);
  });
});
