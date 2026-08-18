import { createFunctionalConsciousnessScore, createSpectralSelfDistillation } from "./self-distillation.js";
import { createFunctionalCognitionEngine, functionalSelectionGate } from "./functional-cognition.js";
import type {
  FunctionalCognitionOffloadRequest,
  FunctionalCognitionOffloadResponse
} from "./functional-cognition-offload-contract.js";

/**
 * Child-process entry for the deferred functional-cognition projection
 * (self-distillation + consciousness scoring + goal/policy projection).
 * Runs in its own OS process with its own capped V8 heap (see
 * functional-cognition-offload.ts) so a slow/large turn can never grow the
 * main server process's heap -- mirrors the wikipedia ingestor's child
 * process + heap cap pattern instead of an in-process concurrency counter.
 * Pure computation only: no storage/DB access happens here, matching
 * spreadsheet-process.ts's shape for this same reason.
 */

if (!process.send) throw new Error("functional-cognition offload process requires an IPC channel");

const ssd = createSpectralSelfDistillation();
const fcs = createFunctionalConsciousnessScore();
const functionalCognitionEngine = createFunctionalCognitionEngine();

process.once("message", (message: unknown) => {
  try {
    const input = message as FunctionalCognitionOffloadRequest;
    const selfDistillation = ssd.distill({ model: input.model, graph: input.graph, state: input.state, forecast: input.forecast, self: input.self });
    const functionalConsciousness = fcs.score({ self: input.self, ssd: selfDistillation });
    const functionalCognition = functionalCognitionEngine.project({
      now: input.now,
      self: input.self,
      model: input.model,
      graph: input.graph,
      policy: input.policy,
      ssdAudit: selfDistillation.audit,
      learningNeeds: input.learningNeeds,
      personaHistory: input.personaHistory,
      governance: input.governance,
      traces: input.traces,
      policyPopulation: input.policyPopulation
    });
    const response: FunctionalCognitionOffloadResponse = {
      ok: true,
      selfDistillationAudit: selfDistillation.audit,
      functionalConsciousnessAudit: functionalConsciousness.audit,
      functionalCognitionAudit: functionalCognition.audit,
      gate: functionalSelectionGate(functionalCognition)
    };
    process.send?.(response, disconnect);
  } catch (error) {
    const response: FunctionalCognitionOffloadResponse = { ok: false, error: error instanceof Error ? error.message : String(error) };
    process.send?.(response, disconnect);
  }
});

function disconnect(): void {
  if (process.connected) process.disconnect();
}
