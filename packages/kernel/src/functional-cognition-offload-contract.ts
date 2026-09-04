// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { CounterfactualTrace, FunctionalSelectionGate, PersonaSnapshot, PolicyGenome } from "./functional-cognition.js";
import type { GovernanceObservation } from "./governance-observation.js";
import type {
  ForecastEnvelope,
  ForecastState,
  FunctionalSelfState,
  GraphSlice,
  JsonValue,
  ModelState,
  PolicyProfile
} from "./types.js";

export interface FunctionalCognitionOffloadRequest {
  now: number;
  self: FunctionalSelfState;
  model: ModelState;
  graph: GraphSlice;
  policy: PolicyProfile;
  state?: ForecastState;
  forecast?: ForecastEnvelope;
  learningNeeds?: string[];
  personaHistory?: PersonaSnapshot[];
  policyPopulation?: PolicyGenome[];
  governance?: GovernanceObservation;
  traces?: CounterfactualTrace[];
}

export type FunctionalCognitionOffloadResponse =
  | {
    ok: true;
    selfDistillationAudit: JsonValue;
    functionalConsciousnessAudit: JsonValue;
    functionalCognitionAudit: JsonValue;
    /**
     * The real selection gate from the projected report, so the parent can
     * maintain its standing self-state register without re-parsing audit
     * JSON. Absent on responses from older child builds; the register
     * simply does not update then.
     */
    gate?: FunctionalSelectionGate;
  }
  | { ok: false; error: string };
