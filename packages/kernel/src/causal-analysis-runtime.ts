import type { Clock, EpisodeId, Hasher, ScceEvent } from "./types.js";
import { toJsonValue } from "./primitives.js";
import { createIdentifiedCausalGraphEngine, type IdentifiedCausalEstimateInput, type IdentifiedCausalEstimateResult } from "./identified-causal-graph.js";
import type { createEventFactory } from "./events.js";
import type { IdFactory } from "./ids.js";

export const CAUSAL_ANALYSIS_REQUEST_SCHEMA = "scce.causal_analysis_request.v1";

/**
 * The only supported entry point into identified causal inference. Ordinary
 * conversational turns never reach this -- there is no natural-language
 * inference of {treatment, outcome, adjustmentSet, assumptions} here, by
 * design (inventing a causal design from prose would fabricate the
 * identification strategy). Callers (HTTP endpoint, CLI) must supply a
 * fully typed, evidence-bound request.
 */
export interface CausalAnalysisRequest extends IdentifiedCausalEstimateInput {
  schema: typeof CAUSAL_ANALYSIS_REQUEST_SCHEMA;
}

export interface CausalAnalysisResult {
  episodeId: EpisodeId;
  eventId: string;
  status: IdentifiedCausalEstimateResult["status"];
  estimate: IdentifiedCausalEstimateResult;
}

export function createCausalAnalysisRuntime(deps: {
  clock: Clock;
  hasher: Hasher;
  idFactory: IdFactory;
  eventFactory: ReturnType<typeof createEventFactory>;
  append(event: ScceEvent): Promise<ScceEvent>;
}) {
  const engine = createIdentifiedCausalGraphEngine({ clock: deps.clock, hasher: deps.hasher });
  return {
    async analyze(request: CausalAnalysisRequest): Promise<CausalAnalysisResult> {
      if (request.schema !== CAUSAL_ANALYSIS_REQUEST_SCHEMA) {
        throw new Error(`unsupported causal analysis request schema: ${String((request as { schema?: unknown }).schema)}`);
      }
      const episodeId = deps.idFactory.episodeId();
      const estimate = engine.estimate(request);
      const event = await deps.append(deps.eventFactory.create({
        episodeId,
        typeId: estimate.status === "identified" ? "CausalEffectIdentified" : "CausalIdentificationRejected",
        payload: estimate.status === "identified"
          ? toJsonValue({ claim: estimate.claim, audit: estimate.audit })
          : toJsonValue({ audit: estimate.audit })
      }));
      return { episodeId, eventId: String(event.id), status: estimate.status, estimate };
    }
  };
}

export type CausalAnalysisRuntime = ReturnType<typeof createCausalAnalysisRuntime>;
