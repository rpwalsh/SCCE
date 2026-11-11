// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createEventFactory } from "../events.js";
import { exactComputationForExpression } from "../exact-computation.js";
import { createAlphaFieldEngine } from "../field.js";
import { createIdFactory } from "../ids.js";
import { launchContractForTurn } from "../launch-contract.js";
import type { LanguageMemoryRuntimeState } from "../language-memory-runtime.js";
import { arithmeticAnswerForText } from "../local-evidence-runtime.js";
import type { Mouth, SpokenOutput } from "../mouth-contracts.js";
import { createPredictionLayer } from "../prediction.js";
import { createClock, createHasher } from "../primitives.js";
import { createEmissionEngine, createProgramGraphBuilder, createValidationGraphBuilder } from "../program.js";
import { createProofCarryingAnswer } from "../proof-carrying-answer.js";
import {
  runExactComputationTurn,
  type ExactComputationRuntimeStatePatch,
  type ExactComputationTurnInput,
  type ExactComputationTurnPorts
} from "../turn-exact-computation.js";
import type { EpisodeId, LanguageProfile, ScceEvent, SourceVersionId, TurnResult } from "../types.js";

const episodeId = "episode.exact.fixture" as EpisodeId;

function languageProfile(): LanguageProfile {
  return {
    id: "profile.exact.fixture",
    sourceVersionId: "source-version.exact.fixture" as SourceVersionId,
    scripts: [],
    symbolShapes: [],
    charNgrams: [],
    direction: "ltr",
    entropy: 0,
    createdAt: 1
  };
}

function turnInput(events: ScceEvent[], overrides: Partial<ExactComputationTurnInput> = {}): ExactComputationTurnInput {
  return {
    requestText: "2 + 2",
    episodeId,
    requestedAuthority: "factual",
    languageMemory: {} as LanguageMemoryRuntimeState,
    languageProfile,
    runtimeAudit: { mode: "turn" },
    safetyAudit: { allowed: true },
    events,
    ...overrides
  };
}

function fixture(events: ScceEvent[], mouthOverride?: Mouth): {
  ports: ExactComputationTurnPorts;
  order: string[];
  patches: ExactComputationRuntimeStatePatch[];
  timing: NonNullable<TurnResult["timing"]>;
} {
  const clock = createClock({ fixedTime: 1_700_000_000_000, stepMs: 1 });
  const hasher = createHasher();
  const idFactory = createIdFactory({ clock, hasher, namespace: "turn-exact-computation-test" });
  const eventFactory = createEventFactory({ clock, hasher, idFactory });
  const order: string[] = [];
  const patches: ExactComputationRuntimeStatePatch[] = [];
  const timing: NonNullable<TurnResult["timing"]> = {
    schema: "scce.turn_timing.v1",
    totalMs: 7,
    persistenceMode: "deferred",
    budgetsMs: { graphSlice: 100, proof: 150, mouth: 300, total: 2500 },
    budgetExceeded: []
  };
  const mouth: Mouth = {
    async speak() {
      throw new Error("formal arithmetic must not invoke Mouth");
    }
  };
  const ports: ExactComputationTurnPorts = {
    clock,
    idFactory,
    fieldEngine: createAlphaFieldEngine({ clock }),
    programBuilder: createProgramGraphBuilder({ idFactory, hasher }),
    mouth: mouthOverride ?? mouth,
    pca: createProofCarryingAnswer(),
    validationBuilder: createValidationGraphBuilder({ idFactory }),
    emissionEngine: createEmissionEngine({ idFactory }),
    prediction: createPredictionLayer({ idFactory }),
    recordFailure(message) { order.push(`failure:${message}`); },
    markTiming(stage) { order.push(`mark:${stage}`); },
    setTimingPart(stage, value) { order.push(`timing:${stage}:${value}`); },
    buildTiming() {
      order.push("build-timing");
      return timing;
    },
    applyStatePatch(patch) {
      order.push(`patch:${Object.keys(patch).join(",")}`);
      patches.push(patch);
    },
    async appendEvent(input) {
      order.push(`event:${input.typeId}`);
      return eventFactory.create(input);
    },
    kernelTrace(event) { order.push(`trace:${event.stage}`); },
    async consolidateCurrentEpisode() {
      order.push("consolidate");
      events.push(eventFactory.create({ episodeId, typeId: "EpisodeConsolidated", payload: { sourceEventCount: events.length } }));
      return { sourceEventCount: events.length - 1 };
    },
    resultFields() {
      order.push("result-fields");
      return {
        calibrationTaskClass: "calibration.fixture",
        requestedAuthorityDecision: { selected: "factual" },
        requestCommunicativeAct: { actId: "question" },
        requirementField: { sourceDependence: 0 },
        operatorActivations: [],
        corrections: [],
        userModelStore: { claims: [] },
        userModelProvenance: { explicit: 0 },
        repoCognition: undefined,
        documentGeneration: undefined
      };
    },
    evaluationTraceResult() {
      order.push("evaluation-trace");
      return {};
    },
    turnContract(input) {
      order.push("turn-contract");
      return launchContractForTurn({ ...input, now: clock.now() });
    }
  };
  return { ports, order, patches, timing };
}

describe("exact-computation terminal turn", () => {
  it("preserves the handled lane's event order and staged runtime-state mutations", async () => {
    const events: ScceEvent[] = [];
    const { ports, order, patches, timing } = fixture(events);
    const arithmetic = arithmeticAnswerForText("2 + 2");
    expect(arithmetic).toBeDefined();

    const result = await runExactComputationTurn(turnInput(events, { formalArithmetic: arithmetic }), ports);

    expect(result?.answer).toBe("2 + 2 = 4.");
    expect(events.map(event => String(event.typeId))).toEqual([
      "ComputationEvaluated",
      "SemanticEntailmentChecked",
      "EmissionGraphBuilt",
      "EpisodeClosed",
      "EpisodeConsolidated"
    ]);
    expect(patches).toHaveLength(3);
    expect(patches[0]?.lastField).toBe(result?.field);
    expect(patches[1]).toEqual({ lastEpisodeId: episodeId, lastOutput: "2 + 2 = 4." });
    expect(patches[2]).toEqual({ lastTurnTiming: timing });
    expect(order.indexOf("event:EpisodeClosed")).toBeLessThan(order.indexOf("consolidate"));
    expect(order.indexOf("patch:lastTurnTiming")).toBeLessThan(order.indexOf("consolidate"));
    expect(order.slice(-3)).toEqual(["result-fields", "evaluation-trace", "turn-contract"]);
  });

  it("returns unhandled without invoking terminal engines, events, timing, or state ports", async () => {
    const events: ScceEvent[] = [];
    const { ports, order, patches } = fixture(events);
    let languageProfileReads = 0;

    const result = await runExactComputationTurn(turnInput(events, {
      languageProfile: () => {
        languageProfileReads += 1;
        return languageProfile();
      }
    }), ports);

    expect(result).toBeUndefined();
    expect(events).toEqual([]);
    expect(patches).toEqual([]);
    expect(order).toEqual([]);
    expect(languageProfileReads).toBe(0);
  });

  it("keeps source realization trace and Mouth event ordering inside the same terminal lane", async () => {
    const events: ScceEvent[] = [];
    const evaluation = exactComputationForExpression("2 + 2");
    expect(evaluation).toBeDefined();
    let languageProfileReads = 0;
    const mouth: Mouth = {
      async speak() {
        return {
          text: evaluation!.answer,
          evidenceRefs: [],
          realizationAvailability: { status: "realized" },
          realizationTrace: { selected: "source-computation", surfaceContract: { accepted: true } },
          surfaceValid: true
        } as unknown as SpokenOutput;
      }
    };
    const { ports, order } = fixture(events, mouth);

    const result = await runExactComputationTurn(turnInput(events, {
      sourceComputation: {
        evaluation: evaluation!,
        patternIds: ["pattern.source-computation.fixture"],
        roleBindings: [],
        requestDigest: "request.digest.fixture"
      },
      languageProfile: () => {
        languageProfileReads += 1;
        return languageProfile();
      }
    }), ports);

    expect(result?.answer).toBe(evaluation?.answer);
    expect(languageProfileReads).toBe(1);
    expect(order).toContain("trace:turn.source_computation");
    expect(events.map(event => String(event.typeId))).toEqual([
      "ComputationEvaluated",
      "MouthSpoken",
      "SemanticEntailmentChecked",
      "EmissionGraphBuilt",
      "EpisodeClosed",
      "EpisodeConsolidated"
    ]);
  });
});
