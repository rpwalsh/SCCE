// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { PortableTraceEvent } from "./debug/trace-event.js";
import { verifyExactResultMatchesClaim, type ExactComputationEvaluation } from "./exact-computation.js";
import type { FieldEvaluationContext, createAlphaFieldEngine } from "./field.js";
import type { IdFactory } from "./ids.js";
import { jsonRecord } from "./kernel-answer-primitives.js";
import type { LanguageMemoryRuntimeState } from "./language-memory-runtime.js";
import type { LaunchContractFields, LaunchContractInput } from "./launch-contract.js";
import { createArithmeticEntailment } from "./local-evidence-runtime.js";
import type { Mouth } from "./mouth-contracts.js";
import type { createPredictionLayer } from "./prediction.js";
import { toJsonValue } from "./primitives.js";
import type { createEmissionEngine, createProgramGraphBuilder, createValidationGraphBuilder } from "./program.js";
import type { createProofCarryingAnswer } from "./proof-carrying-answer.js";
import { invariantScore } from "./scoring/score-trace.js";
import type { VerifiedSourceComputationResult } from "./source-computation-acquisition.js";
import type {
  Clock,
  EpisodeId,
  GraphSlice,
  JsonValue,
  LanguageProfile,
  RequestedAuthority,
  ScceEvent,
  TurnResult
} from "./types.js";

/** The structural result shared by the exact and plain deterministic calculators. */
export interface ExactComputationArithmetic {
  expression: string;
  normalizedExpression: string;
  value: number;
  valueText: string;
  answer: string;
  audit: JsonValue;
}

export interface ExactComputationResultFields {
  calibrationTaskClass: string;
  requestedAuthorityDecision: JsonValue;
  requestCommunicativeAct: JsonValue;
  requirementField: JsonValue;
  operatorActivations: JsonValue;
  corrections: JsonValue;
  userModelStore: JsonValue;
  userModelProvenance: JsonValue;
  repoCognition: JsonValue | undefined;
  documentGeneration: JsonValue | undefined;
}

export interface ExactComputationRuntimeStatePatch {
  lastField?: TurnResult["field"];
  lastEpisodeId?: EpisodeId;
  lastOutput?: string;
  lastTurnTiming?: TurnResult["timing"];
}

export interface ExactComputationTurnInput {
  requestText: string;
  episodeId: EpisodeId;
  requestedAuthority: RequestedAuthority;
  sourceComputation?: VerifiedSourceComputationResult;
  formalExactComputation?: ExactComputationEvaluation;
  formalArithmetic?: ExactComputationArithmetic;
  previousField?: TurnResult["field"];
  fieldEvaluation?: FieldEvaluationContext;
  languageMemory: LanguageMemoryRuntimeState;
  /** Activated profile only; deferred so non-computation turns do not advance the runtime clock. */
  languageProfile(): LanguageProfile;
  runtimeAudit: JsonValue;
  safetyAudit: JsonValue;
  events: ScceEvent[];
}

export interface ExactComputationTurnPorts {
  clock: Pick<Clock, "now">;
  idFactory: IdFactory;
  fieldEngine: Pick<ReturnType<typeof createAlphaFieldEngine>, "activate">;
  programBuilder: Pick<ReturnType<typeof createProgramGraphBuilder>, "build">;
  mouth: Mouth;
  pca: Pick<ReturnType<typeof createProofCarryingAnswer>, "certify">;
  validationBuilder: Pick<ReturnType<typeof createValidationGraphBuilder>, "build">;
  emissionEngine: Pick<ReturnType<typeof createEmissionEngine>, "emit">;
  prediction: Pick<ReturnType<typeof createPredictionLayer>, "state" | "forecast">;
  recordFailure(message: string): void;
  markTiming(stage: "graphSliceMs" | "proofMs" | "validationMs" | "forecastMs"): void;
  setTimingPart(stage: "candidateMs" | "planningMs" | "mouthMs" | "maintenanceMs", value: number): void;
  buildTiming(persistenceMode: "deferred"): NonNullable<TurnResult["timing"]>;
  applyStatePatch(patch: ExactComputationRuntimeStatePatch): void;
  appendEvent(input: { episodeId: EpisodeId; typeId: string; payload: unknown }): Promise<ScceEvent>;
  kernelTrace(event: PortableTraceEvent): void;
  consolidateCurrentEpisode(): Promise<JsonValue>;
  resultFields(): ExactComputationResultFields;
  evaluationTraceResult(): Pick<TurnResult, "evaluationTrace" | "evaluationTraceVerification">;
  turnContract(input: Omit<LaunchContractInput, "now">): LaunchContractFields;
}

/**
 * Completes the deterministic-computation terminal lane from already activated runtime data.
 * It owns no storage or corpus port: source discovery and language-memory preparation happen before this boundary.
 */
export async function runExactComputationTurn(
  input: ExactComputationTurnInput,
  ports: ExactComputationTurnPorts
): Promise<TurnResult | undefined> {
  const exactComputation = input.sourceComputation?.evaluation ?? input.formalExactComputation;
  const exactComputationVerified = exactComputation
    ? verifyExactResultMatchesClaim(exactComputation.result, exactComputation.resultText)
    : undefined;
  if (exactComputation && exactComputationVerified && !exactComputationVerified.matches) {
    ports.recordFailure(`exact computation answer does not match its own quantity: expected ${exactComputationVerified.expected}, answer ${exactComputation.answer}`);
  }
  const arithmetic: ExactComputationArithmetic | undefined = exactComputation && exactComputationVerified?.matches
    ? {
      expression: exactComputation.expression,
      normalizedExpression: exactComputation.expression,
      value: Number(exactComputation.result.numerator) / Number(exactComputation.result.denominator),
      valueText: exactComputation.resultText,
      answer: exactComputation.answer,
      audit: exactComputation.audit
    }
    : input.formalArithmetic;
  if (!arithmetic || input.requestedAuthority === "creative" || input.requestedAuthority === "translation") return undefined;

  ports.markTiming("graphSliceMs");
  const graph: GraphSlice = { nodes: [], edges: [], hyperedges: [], bounded: true, query: {} };
  const field = ports.fieldEngine.activate({
    text: input.requestText,
    nodes: [],
    edges: [],
    previous: input.previousField,
    evaluation: input.fieldEvaluation
  });
  ports.applyStatePatch({ lastField: field });
  const entailment = createArithmeticEntailment({
    requestText: input.sourceComputation ? arithmetic.answer : input.requestText,
    arithmetic,
    field,
    idFactory: ports.idFactory,
    createdAt: ports.clock.now()
  });
  ports.markTiming("proofMs");
  const construct = ports.programBuilder.build({
    episodeId: input.episodeId,
    text: input.requestText,
    entailment,
    evidence: [],
    createdAt: ports.clock.now()
  });
  const computationSpoken = input.sourceComputation
    ? await ports.mouth.speak({
      requestText: input.requestText,
      verifiedComputation: input.sourceComputation,
      construct,
      field,
      entailment,
      evidence: [],
      requestedAuthority: input.requestedAuthority,
      languageMemory: input.languageMemory,
      languageProfile: input.languageProfile()
    })
    : undefined;
  if (input.sourceComputation) {
    ports.kernelTrace({
      stage: "turn.source_computation",
      label: "kernel.turn",
      counts: { sourcePatterns: input.sourceComputation.patternIds.length },
      support: {
        patternIds: input.sourceComputation.patternIds,
        realizationAvailability: computationSpoken?.realizationAvailability,
        surfaceValid: computationSpoken?.surfaceValid,
        selected: computationSpoken?.realizationTrace.selected,
        surfaceContract: computationSpoken?.realizationTrace.surfaceContract
      }
    });
  }
  const computationSurfaceAccepted = !input.sourceComputation || Boolean(
    computationSpoken?.surfaceValid
    && computationSpoken.realizationAvailability.status === "realized"
    && computationSpoken.text === arithmetic.answer
  );
  const answer = computationSurfaceAccepted ? computationSpoken?.text ?? arithmetic.answer : "";
  const pcaReport = ports.pca.certify({ answer, evidence: [], force: entailment.force });
  const validation = ports.validationBuilder.build({
    construct,
    entailment,
    pca: pcaReport as unknown as JsonValue
  });
  const rawEmission = ports.emissionEngine.emit({
    construct,
    validation,
    entailment,
    answer,
    pca: pcaReport as unknown as JsonValue
  });
  const emission = {
    ...rawEmission,
    answer: computationSurfaceAccepted ? rawEmission.answer : "",
    assistantForce: computationSurfaceAccepted ? "reasoned_answer" as const : "insufficient_support" as const
  };
  ports.setTimingPart("candidateMs", 0);
  ports.setTimingPart("planningMs", 0);
  ports.setTimingPart("mouthMs", 0);
  ports.markTiming("validationMs");
  const state = ports.prediction.state({
    episodeId: input.episodeId,
    graph,
    alphaTrace: field.alphaTrace,
    t: ports.clock.now()
  });
  const forecast = ports.prediction.forecast({ states: [], source: state, horizon: 2, createdAt: ports.clock.now() });
  ports.markTiming("forecastMs");
  ports.setTimingPart("maintenanceMs", 0);
  ports.applyStatePatch({ lastEpisodeId: input.episodeId, lastOutput: emission.answer });

  input.events.push(await ports.appendEvent({
    episodeId: input.episodeId,
    typeId: "ComputationEvaluated",
    payload: input.sourceComputation
      ? toJsonValue({
        ...jsonRecord(arithmetic.audit),
        sourcePatternIds: input.sourceComputation.patternIds,
        roleBindings: input.sourceComputation.roleBindings,
        surfaceEmitted: computationSurfaceAccepted
      })
      : arithmetic.audit
  }));
  if (computationSpoken) {
    input.events.push(await ports.appendEvent({
      episodeId: input.episodeId,
      typeId: "MouthSpoken",
      payload: {
        text: computationSpoken.text,
        evidenceRefs: computationSpoken.evidenceRefs,
        trace: toJsonValue(computationSpoken.realizationTrace)
      }
    }));
  }
  input.events.push(await ports.appendEvent({
    episodeId: input.episodeId,
    typeId: "SemanticEntailmentChecked",
    payload: {
      proofId: entailment.proof.id,
      force: entailment.force,
      assistantForce: emission.assistantForce,
      support: entailment.support,
      contradiction: entailment.contradiction,
      deterministicArithmetic: true
    }
  }));
  input.events.push(await ports.appendEvent({
    episodeId: input.episodeId,
    typeId: "EmissionGraphBuilt",
    payload: emission
  }));
  const timing = ports.buildTiming("deferred");
  input.events.push(await ports.appendEvent({
    episodeId: input.episodeId,
    typeId: "EpisodeClosed",
    payload: { output: emission.answer, deterministicArithmetic: true, timing }
  }));
  ports.applyStatePatch({ lastTurnTiming: timing });
  const episodeConsolidation = await ports.consolidateCurrentEpisode();
  const resultFields = ports.resultFields();

  return {
    episodeId: input.episodeId,
    requestedAuthority: input.requestedAuthority,
    calibrationTaskClass: resultFields.calibrationTaskClass,
    requestedAuthorityDecision: resultFields.requestedAuthorityDecision,
    requestCommunicativeAct: resultFields.requestCommunicativeAct,
    requirementField: resultFields.requirementField,
    operatorActivations: resultFields.operatorActivations,
    answer: emission.answer,
    epistemicForce: emission.epistemicForce,
    assistantForce: emission.assistantForce,
    evidence: [],
    field,
    entailment,
    constructGraph: construct,
    validationGraph: validation,
    emissionGraph: emission,
    forecast,
    learningNeeds: [],
    actionGraph: toJsonValue({
      deterministicArithmetic: arithmetic.audit,
      runtime: input.runtimeAudit,
      safety: input.safetyAudit,
      maintenanceDeferred: true
    }),
    proofCarryingAnswer: pcaReport.audit,
    languageAcquisition: toJsonValue({ skipped: true, reason: "kernel.turn.deterministic_arithmetic" }),
    mouth: computationSpoken
      ? toJsonValue(computationSpoken.realizationTrace)
      : toJsonValue({ skipped: true, reason: "kernel.turn.deterministic_arithmetic" }),
    ...(computationSpoken
      ? {
        realizationAvailability: toJsonValue(!computationSurfaceAccepted
          ? {
            status: "realization_unavailable",
            reasonId: "computation_surface_contract_rejected",
            eligibleCandidateCount: 0
          }
          : computationSpoken.realizationAvailability)
      }
      : {}),
    corrections: resultFields.corrections,
    userModelStore: resultFields.userModelStore,
    userModelProvenance: resultFields.userModelProvenance,
    learningLoop: toJsonValue({ maintenanceDeferred: true, deterministicArithmetic: true }),
    episodeConsolidation,
    relevantPastEpisodes: undefined,
    repoCognition: resultFields.repoCognition,
    documentGeneration: resultFields.documentGeneration,
    timing,
    ...ports.evaluationTraceResult(),
    ...ports.turnContract({
      entailment,
      evidence: [],
      assistantForce: emission.assistantForce,
      unsupportedContentBlocked: !computationSurfaceAccepted,
      ...(exactComputationVerified && computationSurfaceAccepted
        ? {
          scoreTraces: [invariantScore({
            value: exactComputationVerified.matches ? 1 : 0,
            range: [0, 1],
            meaning: "exact computation result equals the quantity in the spoken answer",
            inputs: [exactComputation!.expression, exactComputationVerified.expected],
            provenance: ["exact-computation.verifyExactResultMatchesClaim"],
            idSeed: `exact:${exactComputation!.expression}:${exactComputationVerified.expected}`
          })]
        }
        : {})
    }),
    events: input.events
  };
}
