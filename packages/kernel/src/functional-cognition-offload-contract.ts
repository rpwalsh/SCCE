import type { CounterfactualTrace, PersonaSnapshot, PolicyGenome } from "./functional-cognition.js";
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
  | { ok: true; selfDistillationAudit: JsonValue; functionalConsciousnessAudit: JsonValue; functionalCognitionAudit: JsonValue }
  | { ok: false; error: string };
