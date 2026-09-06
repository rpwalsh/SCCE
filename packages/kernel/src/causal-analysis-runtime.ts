// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { Clock, EpisodeId, Hasher, ScceEvent } from "./types.js";
import { toJsonValue } from "./primitives.js";
import { createIdentifiedCausalGraphEngine, type IdentifiedCausalEstimateInput, type IdentifiedCausalEstimateResult } from "./identified-causal-graph.js";
import { createTemporalCausalDiscoveryEngine, type CausalDiscoveryReport } from "./causal-discovery.js";
import { createTemporalCausalDiscovery, type TemporalSeries } from "./temporal-causal.js";
import type { createEventFactory } from "./events.js";
import type { IdFactory } from "./ids.js";

export const CAUSAL_ANALYSIS_REQUEST_SCHEMA = "scce.causal_analysis_request.v1";
export const CAUSAL_DISCOVERY_REQUEST_SCHEMA = "scce.causal_discovery_request.v1";

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

/**
 * Temporal causal discovery over caller-supplied series.
 *
 * Distinct from `analyze`, which estimates an effect under an identification strategy the caller states. Discovery
 * proposes structure instead, and the same boundary applies for the same reason: the series arrive typed from a
 * caller, never inferred from prose, because inventing variables from text would fabricate the structure being
 * discovered. Two discovery implementations existed and neither was reachable -- `createTemporalCausalDiscoveryEngine`
 * carries FDR control, PCMCI links and Reichenbach screens, while `createTemporalCausalDiscovery` reports the
 * stationarity of each series, which is the precondition Granger validity rests on. Both are reported, because a
 * reviewer who cannot see whether the series were stationarizable cannot judge the edges.
 */
export interface CausalDiscoveryRequest {
  schema: typeof CAUSAL_DISCOVERY_REQUEST_SCHEMA;
  series: readonly TemporalSeries[];
  maxLag?: number;
  fdrQ?: number;
  minSamples?: number;
  transferEntropyBins?: number;
}

export interface CausalDiscoveryResult {
  episodeId: EpisodeId;
  eventId: string;
  report: CausalDiscoveryReport;
  stationarity: ReturnType<ReturnType<typeof createTemporalCausalDiscovery>["discover"]>["stationarity"];
}

export function createCausalAnalysisRuntime(deps: {
  clock: Clock;
  hasher: Hasher;
  idFactory: IdFactory;
  eventFactory: ReturnType<typeof createEventFactory>;
  append(event: ScceEvent): Promise<ScceEvent>;
}) {
  const engine = createIdentifiedCausalGraphEngine({ clock: deps.clock, hasher: deps.hasher });
  const discoveryEngine = createTemporalCausalDiscoveryEngine();
  const stationarityReporter = createTemporalCausalDiscovery();
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
    },

    async discover(request: CausalDiscoveryRequest): Promise<CausalDiscoveryResult> {
      if (request.schema !== CAUSAL_DISCOVERY_REQUEST_SCHEMA) {
        throw new Error(`unsupported causal discovery request schema: ${String((request as { schema?: unknown }).schema)}`);
      }
      if (!request.series.length) throw new Error("causal discovery needs at least one series");
      const episodeId = deps.idFactory.episodeId();
      const report = discoveryEngine.discover({
        series: request.series,
        ...(request.maxLag === undefined ? {} : { maxLag: request.maxLag }),
        ...(request.fdrQ === undefined ? {} : { fdrQ: request.fdrQ }),
        ...(request.minSamples === undefined ? {} : { minSamples: request.minSamples }),
        ...(request.transferEntropyBins === undefined ? {} : { transferEntropyBins: request.transferEntropyBins })
      });
      const stationarity = stationarityReporter.discover(request.series, {
        ...(request.maxLag === undefined ? {} : { maxLag: request.maxLag }),
        ...(request.minSamples === undefined ? {} : { minSamples: request.minSamples })
      }).stationarity;
      const event = await deps.append(deps.eventFactory.create({
        episodeId,
        typeId: "CausalStructureDiscovered",
        payload: toJsonValue({
          schema: CAUSAL_DISCOVERY_REQUEST_SCHEMA,
          series: request.series.length,
          grangerEdges: report.grangerEdges.length,
          transferEntropyEdges: report.transferEntropyEdges.length,
          pcmciLinks: report.pcmciLinks.length,
          fused: report.fused.length,
          stationarity: stationarity.length,
          audit: report.audit
        })
      }));
      return { episodeId, eventId: String(event.id), report, stationarity };
    }
  };
}

export type CausalAnalysisRuntime = ReturnType<typeof createCausalAnalysisRuntime>;
