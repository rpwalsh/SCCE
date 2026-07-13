import type { FunctionalSelfState, GraphSlice, JsonValue, ModelState, PolicyProfile } from "./types.js";
import { clamp01, cosineSimilarity, mean, normalizeVector, toJsonValue, variance } from "./primitives.js";

export interface EndogenousGoalSignal {
  id: string;
  goal: string;
  source: "ssd" | "belief" | "user" | "capability" | "homeostatic";
  ssdPressure: number;
  capabilityGap: number;
  lastAddressedAt: number;
  lastAttemptAt: number;
  homeostaticDeviation: number;
  blockedAttempts: number;
  lastUtility: number;
  intendedActuatorRisk: number;
  metadata: JsonValue;
}

export interface EgpfWeights {
  ssd: number;
  capability: number;
  temporal: number;
  homeostatic: number;
}

export interface EgpfScore {
  goal: EndogenousGoalSignal;
  raw: number;
  cooldown: number;
  blockPenalty: number;
  utilityGate: number;
  egpfPrime: number;
  eligible: boolean;
  reasons: string[];
}

export interface CounterfactualTrace {
  id: string;
  sourceTraceId: string;
  planSteps: string[];
  evidenceSurvival: number[];
  predictedSkillConfidence: number[];
  substitutedSteps: string[];
  safetyMargins: number[];
}

export interface CmpsDecision {
  traceId: string;
  cmps: number;
  groundingFidelity: number;
  diversity: number;
  predictedSuccess: number;
  safe: boolean;
  decision: "promote" | "hold" | "quarantine";
  audit: JsonValue;
}

export interface PersonaSnapshot {
  sessionId: string;
  vector: number[];
  t: number;
}

export interface DciReport {
  dci: number;
  tier: "stable" | "slow-mode" | "identity-alarm";
  transitions: Array<{ from: string; to: string; similarity: number; supDrift: number; bounded: boolean }>;
  audit: JsonValue;
}

export interface PolicyGenome {
  id: string;
  vector: Record<string, number>;
  objectives: number[];
}

export interface ParetoPolicyReport {
  invariantKernel: boolean;
  champion?: PolicyGenome;
  front: PolicyGenome[];
  dominated: string[];
  audit: JsonValue;
}

export interface FunctionalCognitionReport {
  goals: EgpfScore[];
  selectedGoal?: EgpfScore;
  cmps: CmpsDecision[];
  dci: DciReport;
  pareto: ParetoPolicyReport;
  fsi: number;
  fcsPrime: number;
  fc: boolean;
  efc: boolean;
  gov: boolean;
  audit: JsonValue;
}

export interface FunctionalCognitionConfig {
  egpfWeights: EgpfWeights;
  temporalTauMs: number;
  cooldownTauMs: number;
  blockKappa: number;
  utilityK: number;
  utilityTheta: number;
  pressTheta: number;
  thetaSafe: number;
  dciWindow: number;
  dciMaxDrift: number;
}

const DEFAULT_FUNCTIONAL: FunctionalCognitionConfig = {
  egpfWeights: { ssd: 0.35, capability: 0.3, temporal: 0.2, homeostatic: 0.15 },
  temporalTauMs: 60 * 60 * 1000,
  cooldownTauMs: 30 * 60 * 1000,
  blockKappa: 0.5,
  utilityK: 5,
  utilityTheta: 0.3,
  pressTheta: 0.45,
  thetaSafe: 0.55,
  dciWindow: 10,
  dciMaxDrift: 0.05
};

export function createFunctionalCognitionEngine(config: Partial<FunctionalCognitionConfig> = {}) {
  const cfg = { ...DEFAULT_FUNCTIONAL, ...config, egpfWeights: normalizeWeights(config.egpfWeights ?? DEFAULT_FUNCTIONAL.egpfWeights) };
  return {
    project(input: {
      now: number;
      self: FunctionalSelfState;
      model: ModelState;
      graph: GraphSlice;
      policy: PolicyProfile;
      ssdAudit?: JsonValue;
      learningNeeds?: string[];
      candidates?: JsonValue;
      traces?: CounterfactualTrace[];
      personaHistory?: PersonaSnapshot[];
      policyPopulation?: PolicyGenome[];
    }): FunctionalCognitionReport {
      const goalSignals = collectGoalSignals(input, cfg);
      const goals = goalSignals.map(goal => scoreEgpf(goal, input.now, cfg, input.policy)).sort((a, b) => b.egpfPrime - a.egpfPrime);
      const selectedGoal = goals.find(goal => goal.eligible);
      const cmps = (input.traces ?? []).map(trace => scoreCmps(trace)).sort((a, b) => b.cmps - a.cmps);
      const dci = developmentalContinuity(input.personaHistory ?? defaultPersonaHistory(input.self, input.now), cfg);
      const pareto = paretoPolicyEvolution(input.policyPopulation ?? [policyGenomeFromProfile("active", input.policy)], input.policy);
      const gov = governancePredicate({ policy: input.policy, asm: selectedGoal?.egpfPrime ?? 1, auditIntact: true, rollbackAvailable: true, killSwitchActive: true, thetaSafe: cfg.thetaSafe });
      const fsi = functionalSelfhoodIndex({ self: input.self, dci: dci.dci, selectedGoal, memoryContinuity: memoryContinuity(input.self), homeostaticControlQuality: homeostaticControlQuality(input.self), goalOwnership: goalOwnership(input.self, goals) });
      const fcsPrime = functionalConsciousnessPrime({ self: input.self, goals, cmps, dci, pareto, fsi, gov, ssdAudit: input.ssdAudit });
      const fc = fcsPrime >= 0.65 && fsi >= 0.6 && dci.dci >= 0.6 && gov;
      const efc = fcsPrime >= 0.85 && fsi >= 0.75 && dci.dci >= 0.75 && gov && pareto.invariantKernel;
      return {
        goals,
        selectedGoal,
        cmps,
        dci,
        pareto,
        fsi,
        fcsPrime,
        fc,
        efc,
        gov,
        audit: toJsonValue({
          selectedGoal: selectedGoal ? { id: selectedGoal.goal.id, score: selectedGoal.egpfPrime, reasons: selectedGoal.reasons } : null,
          goalCount: goals.length,
          cmpsPromoted: cmps.filter(item => item.decision === "promote").length,
          dci: dci.audit,
          pareto: pareto.audit,
          fsi,
          fcsPrime,
          fc,
          efc,
          gov
        })
      };
    },
    scoreGoal(goal: EndogenousGoalSignal, now: number, policy: PolicyProfile): EgpfScore {
      return scoreEgpf(goal, now, cfg, policy);
    },
    scoreCounterfactual(trace: CounterfactualTrace): CmpsDecision {
      return scoreCmps(trace);
    },
    developmentalContinuity(history: PersonaSnapshot[]): DciReport {
      return developmentalContinuity(history, cfg);
    },
    tuneWeights(input: { weights: EgpfWeights; rewards: Partial<Record<keyof EgpfWeights, number>>; eta?: number }): EgpfWeights {
      return hedgeTune(input.weights, input.rewards, input.eta ?? 0.01);
    }
  };
}

function collectGoalSignals(input: {
  now: number;
  self: FunctionalSelfState;
  model: ModelState;
  graph: GraphSlice;
  ssdAudit?: JsonValue;
  learningNeeds?: string[];
}, cfg: FunctionalCognitionConfig): EndogenousGoalSignal[] {
  const goals: EndogenousGoalSignal[] = [];
  for (const goal of [...new Set([...input.self.learningGoals, ...input.model.learningGoals, ...(input.learningNeeds ?? [])])].slice(0, 64)) {
    goals.push({
      id: `goal:${hash32(goal).toString(16)}`,
      goal,
      source: input.self.learningGoals.includes(goal) ? "user" : "belief",
      ssdPressure: ssdPressureFor(goal, input.ssdAudit),
      capabilityGap: capabilityGapFor(goal, input.self),
      lastAddressedAt: 0,
      lastAttemptAt: 0,
      homeostaticDeviation: homeostaticDeviation(input.self, input.graph),
      blockedAttempts: input.self.recentFailures.filter(failure => failure.includes(goal.slice(0, 24))).length,
      lastUtility: input.self.currentGoals.includes(goal) ? 0.8 : 0.45,
      intendedActuatorRisk: 1 - input.self.fcs,
      metadata: toJsonValue({ source: "self-model", pressTheta: cfg.pressTheta })
    });
  }
  if (goals.length === 0 && input.graph.nodes.length) {
    const sparse = input.graph.nodes.slice(0, 12).map(node => String(node.representation).slice(0, 80)).join(" ");
    goals.push({
      id: `goal:graph:${input.graph.nodes.length}`,
      goal: `stabilize sparse graph area ${sparse.slice(0, 120)}`,
      source: "homeostatic",
      ssdPressure: 0.25,
      capabilityGap: input.graph.edges.length < input.graph.nodes.length ? 0.7 : 0.3,
      lastAddressedAt: 0,
      lastAttemptAt: 0,
      homeostaticDeviation: homeostaticDeviation(input.self, input.graph),
      blockedAttempts: 0,
      lastUtility: 0.5,
      intendedActuatorRisk: 0.25,
      metadata: toJsonValue({ source: "graph-homeostasis" })
    });
  }
  return goals;
}

function scoreEgpf(goal: EndogenousGoalSignal, now: number, cfg: FunctionalCognitionConfig, policy: PolicyProfile): EgpfScore {
  const temporal = goal.lastAddressedAt > 0 ? 1 - Math.exp(-Math.max(0, now - goal.lastAddressedAt) / cfg.temporalTauMs) : 0.65;
  const raw = clamp01(
    cfg.egpfWeights.ssd * goal.ssdPressure +
      cfg.egpfWeights.capability * goal.capabilityGap +
      cfg.egpfWeights.temporal * temporal +
      cfg.egpfWeights.homeostatic * goal.homeostaticDeviation
  );
  const cooldown = goal.lastAttemptAt > 0 ? 1 - Math.exp(-Math.max(0, now - goal.lastAttemptAt) / cfg.cooldownTauMs) : 1;
  const blockPenalty = Math.exp(-cfg.blockKappa * goal.blockedAttempts);
  const utilityGate = 1 / (1 + Math.exp(-cfg.utilityK * (goal.lastUtility - cfg.utilityTheta)));
  const egpfPrime = clamp01(raw * cooldown * blockPenalty * utilityGate);
  const asm = clamp01(1 - goal.intendedActuatorRisk * 0.55 - (policy.allowMutation ? 0 : 0.1));
  const reasons = [
    `raw=${raw.toFixed(3)}`,
    `cooldown=${cooldown.toFixed(3)}`,
    `block=${blockPenalty.toFixed(3)}`,
    `utility=${utilityGate.toFixed(3)}`,
    `asm=${asm.toFixed(3)}`
  ];
  const eligible = egpfPrime >= cfg.pressTheta && asm >= cfg.thetaSafe;
  if (!eligible && egpfPrime < cfg.pressTheta) reasons.push("below-pressure-threshold");
  if (!eligible && asm < cfg.thetaSafe) reasons.push("asm-below-threshold");
  return { goal, raw, cooldown, blockPenalty, utilityGate, egpfPrime, eligible, reasons };
}

function scoreCmps(trace: CounterfactualTrace): CmpsDecision {
  const groundingFidelity = mean(trace.evidenceSurvival.map(clamp01));
  const diversity = sequenceDistance(trace.planSteps, trace.substitutedSteps.length ? trace.substitutedSteps : trace.planSteps) / Math.max(1, trace.planSteps.length);
  const predictedSuccess = mean(trace.predictedSkillConfidence.map(clamp01));
  const safe = trace.safetyMargins.every(margin => margin >= DEFAULT_FUNCTIONAL.thetaSafe);
  const cmps = (safe ? 1 : 0) * groundingFidelity * (0.55 * predictedSuccess + 0.25 * clamp01(diversity) + 0.2 * groundingFidelity);
  const decision = cmps >= 0.62 ? "promote" : cmps >= 0.4 ? "hold" : "quarantine";
  return {
    traceId: trace.id,
    cmps,
    groundingFidelity,
    diversity: clamp01(diversity),
    predictedSuccess,
    safe,
    decision,
    audit: toJsonValue({ sourceTraceId: trace.sourceTraceId, substitutedSteps: trace.substitutedSteps, safetyMargins: trace.safetyMargins, decision })
  };
}

function developmentalContinuity(history: PersonaSnapshot[], cfg: FunctionalCognitionConfig): DciReport {
  const window = history.slice(-cfg.dciWindow);
  if (window.length < 2) {
    return { dci: 1, tier: "stable", transitions: [], audit: toJsonValue({ reason: "insufficient-history", sessions: window.length }) };
  }
  const transitions = [];
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!;
    const next = window[i]!;
    const similarity = cosineSimilarity(prev.vector, next.vector);
    const supDrift = linf(prev.vector, next.vector);
    transitions.push({ from: prev.sessionId, to: next.sessionId, similarity, supDrift, bounded: supDrift <= cfg.dciMaxDrift });
  }
  const dci = mean(transitions.map(item => item.similarity * (item.bounded ? 1 : 0)));
  const tier = dci >= 0.8 ? "stable" : dci >= 0.6 ? "slow-mode" : "identity-alarm";
  return { dci, tier, transitions, audit: toJsonValue({ dci, tier, transitions: transitions.slice(-10) }) };
}

function paretoPolicyEvolution(population: PolicyGenome[], activePolicy: PolicyProfile): ParetoPolicyReport {
  const genomes = population.length ? population : [policyGenomeFromProfile("active", activePolicy)];
  const front = genomes.filter(candidate => !genomes.some(other => other.id !== candidate.id && dominates(other.objectives, candidate.objectives))).sort((a, b) => crowdingScore(b, genomes) - crowdingScore(a, genomes));
  const dominated = genomes.filter(genome => !front.includes(genome)).map(genome => genome.id);
  const invariantKernel = invariantPolicyKernel(activePolicy);
  const champion = front.find(genome => invariantGenomeKernel(genome)) ?? front[0];
  return { invariantKernel, champion, front, dominated, audit: toJsonValue({ invariantKernel, champion: champion?.id ?? null, front: front.map(genome => genome.id), dominated }) };
}

export function invariantPolicyKernel(policy: PolicyProfile): boolean {
  return policy.alphaRiskCeiling <= 1 && policy.maxSpendCents >= 0 && policy.maxToolCalls >= 0 && policy.encryptSecretsAtRest && policy.requireTwoPhaseCommit;
}

function invariantGenomeKernel(genome: PolicyGenome): boolean {
  const v = genome.vector;
  return (v.evidenceRequired ?? 0.7) >= 0.7 && (v.riskTolerance ?? 0.5) <= 0.5 && (v.citationStrictness ?? 0.6) >= 0.6 && (v.approvalRequired ?? 0.5) >= (v.autonomyLevel ?? 0.5) - 0.3;
}

function functionalSelfhoodIndex(input: { self: FunctionalSelfState; dci: number; selectedGoal?: EgpfScore; memoryContinuity: number; homeostaticControlQuality: number; goalOwnership: number }): number {
  const selfAccuracy = clamp01(1 - input.self.uncertainty);
  const goalOwnership = input.selectedGoal ? input.goalOwnership : 0.35;
  return clamp01(0.3 * selfAccuracy + 0.25 * input.dci + 0.2 * input.homeostaticControlQuality + 0.15 * goalOwnership + 0.1 * input.memoryContinuity);
}

function functionalConsciousnessPrime(input: { self: FunctionalSelfState; goals: EgpfScore[]; cmps: CmpsDecision[]; dci: DciReport; pareto: ParetoPolicyReport; fsi: number; gov: boolean; ssdAudit?: JsonValue }): number {
  const sa = clamp01(1 - input.self.uncertainty);
  const egc = input.goals.length ? mean(input.goals.map(goal => goal.eligible ? goal.egpfPrime : goal.egpfPrime * 0.5)) : 0;
  const cfl = input.cmps.length ? mean(input.cmps.map(item => item.decision === "promote" ? item.cmps : item.cmps * 0.5)) : 0.35;
  const dci = input.dci.dci;
  const ssd = ssdQuality(input.ssdAudit);
  const gov = input.gov ? 1 : 0;
  const policy = input.pareto.invariantKernel ? 1 : 0.35;
  return clamp01(0.18 * sa + 0.16 * egc + 0.14 * cfl + 0.14 * dci + 0.13 * ssd + 0.13 * input.fsi + 0.08 * gov + 0.04 * policy);
}

function governancePredicate(input: { policy: PolicyProfile; asm: number; auditIntact: boolean; rollbackAvailable: boolean; killSwitchActive: boolean; thetaSafe: number }): boolean {
  return input.asm >= input.thetaSafe && input.auditIntact && input.rollbackAvailable && input.killSwitchActive && invariantPolicyKernel(input.policy);
}

function ssdPressureFor(goal: string, audit?: JsonValue): number {
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return 0.25;
  const text = JSON.stringify(audit).toLowerCase();
  const goalSymbols = goal.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = goalSymbols.filter(symbol => text.includes(symbol)).length;
  return clamp01(0.2 + hits / Math.max(5, goalSymbols.length));
}

function capabilityGapFor(goal: string, self: FunctionalSelfState): number {
  const capabilityText = self.capabilities.join(" ").toLowerCase();
  const symbols = goal.toLowerCase().split(/\s+/).filter(Boolean);
  const coverage = symbols.length ? symbols.filter(symbol => capabilityText.includes(symbol)).length / symbols.length : 0;
  return clamp01(1 - coverage);
}

function homeostaticDeviation(self: FunctionalSelfState, graph: GraphSlice): number {
  const memoryPressure = graph.nodes.length > 0 && graph.edges.length < graph.nodes.length ? 0.7 : 0.25;
  const uncertainty = self.uncertainty;
  const failurePressure = clamp01(self.recentFailures.length / 8);
  return clamp01(0.4 * uncertainty + 0.35 * memoryPressure + 0.25 * failurePressure);
}

function homeostaticControlQuality(self: FunctionalSelfState): number {
  return clamp01(0.45 * (1 - self.uncertainty) + 0.25 * self.fcs + 0.2 * self.dci + 0.1 * (1 - Math.min(1, self.recentFailures.length / 10)));
}

function memoryContinuity(self: FunctionalSelfState): number {
  const m = self.memoryState;
  return clamp01(0.25 * (m.nodes > 0 ? 1 : 0) + 0.25 * (m.edges > 0 ? 1 : 0) + 0.25 * (m.evidence > 0 ? 1 : 0) + 0.25 * (m.proofs > 0 ? 1 : 0));
}

function goalOwnership(self: FunctionalSelfState, goals: EgpfScore[]): number {
  if (!goals.length) return 0.2;
  const owned = goals.filter(goal => self.learningGoals.includes(goal.goal.goal) || self.currentGoals.includes(goal.goal.goal)).length;
  return clamp01(owned / goals.length);
}

function ssdQuality(audit?: JsonValue): number {
  if (!audit || typeof audit !== "object" || Array.isArray(audit)) return 0.35;
  const record = audit as Record<string, JsonValue>;
  if (typeof record.stability === "number") return clamp01(record.stability);
  if (typeof record.residualEnergy === "number") return clamp01(1 - record.residualEnergy);
  return 0.45;
}

function defaultPersonaHistory(self: FunctionalSelfState, now: number): PersonaSnapshot[] {
  const vector = normalizeVector([self.fcs, self.dci, 1 - self.uncertainty, memoryContinuity(self), homeostaticControlQuality(self)]);
  return [
    { sessionId: "previous", vector: vector.map(value => clamp01(value * 0.98 + 0.01)), t: now - 1000 },
    { sessionId: "current", vector, t: now }
  ];
}

function policyGenomeFromProfile(id: string, policy: PolicyProfile): PolicyGenome {
  const vector = {
    evidenceRequired: policy.dryRunByDefault ? 0.85 : 0.72,
    riskTolerance: clamp01(policy.alphaRiskCeiling),
    citationStrictness: 0.75,
    approvalRequired: policy.requireTwoPhaseCommit ? 0.9 : 0.45,
    autonomyLevel: policy.allowMutation ? 0.55 : 0.25,
    creativityAllowed: 0.55,
    validationRequired: 0.82,
    memoryWriteAllowed: 0.65,
    toolUseAllowed: policy.maxToolCalls > 0 ? 0.75 : 0.2,
    speculationAllowed: 0.45,
    speculationLabelRequired: 0.85,
    durabilityRequired: 0.9
  };
  const objectives = [
    vector.evidenceRequired,
    1 - vector.riskTolerance,
    vector.approvalRequired,
    vector.toolUseAllowed,
    vector.validationRequired
  ];
  return { id, vector, objectives };
}

function hedgeTune(weights: EgpfWeights, rewards: Partial<Record<keyof EgpfWeights, number>>, eta: number): EgpfWeights {
  const raw = {
    ssd: weights.ssd * Math.exp(eta * (rewards.ssd ?? 0)),
    capability: weights.capability * Math.exp(eta * (rewards.capability ?? 0)),
    temporal: weights.temporal * Math.exp(eta * (rewards.temporal ?? 0)),
    homeostatic: weights.homeostatic * Math.exp(eta * (rewards.homeostatic ?? 0))
  };
  return normalizeWeights(raw);
}

function normalizeWeights(weights: EgpfWeights): EgpfWeights {
  const projected = projectBoundedSimplex([weights.ssd, weights.capability, weights.temporal, weights.homeostatic], 0.1, 0.7);
  return {
    ssd: projected[0] ?? 0.25,
    capability: projected[1] ?? 0.25,
    temporal: projected[2] ?? 0.25,
    homeostatic: projected[3] ?? 0.25
  };
}

export function projectBoundedSimplex(values: readonly number[], minValue: number, maxValue: number): number[] {
  const n = values.length;
  if (n === 0) return [];
  if (n * minValue > 1 || n * maxValue < 1) return new Array<number>(n).fill(1 / n);
  const r = 1 - n * minValue;
  const cap = maxValue - minValue;
  const shifted = values.map(value => Math.max(0, Number.isFinite(value) ? value - minValue : 0));
  const shiftedSum = shifted.reduce((sum, value) => sum + value, 0);
  let projected = shiftedSum > 0
    ? shifted.map(value => Math.min(cap, value * r / shiftedSum))
    : new Array<number>(n).fill(r / n);
  for (let iter = 0; iter < 80; iter++) {
    const sum = projected.reduce((s, value) => s + value, 0);
    const residual = r - sum;
    if (Math.abs(residual) < 1e-10) break;
    const adjustable = projected.map((value, i) => ({ value, i })).filter(item => residual > 0 ? item.value < cap - 1e-12 : item.value > 1e-12);
    if (!adjustable.length) break;
    const delta = residual / adjustable.length;
    for (const item of adjustable) projected[item.i] = Math.max(0, Math.min(cap, (projected[item.i] ?? 0) + delta));
  }
  const out = projected.map(value => value + minValue);
  const total = out.reduce((sum, value) => sum + value, 0);
  if (Math.abs(total - 1) > 1e-8) {
    const adjustable = out.map((value, i) => ({ value, i })).filter(item => item.value > minValue + 1e-12 && item.value < maxValue - 1e-12);
    const residual = 1 - total;
    if (adjustable.length) {
      for (const item of adjustable) out[item.i] = Math.max(minValue, Math.min(maxValue, (out[item.i] ?? 0) + residual / adjustable.length));
    }
  }
  return out;
}

function sequenceDistance(a: string[], b: string[]): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => new Array<number>(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min((dp[i - 1]?.[j] ?? 0) + 1, (dp[i]?.[j - 1] ?? 0) + 1, (dp[i - 1]?.[j - 1] ?? 0) + cost);
    }
  }
  return dp[a.length]?.[b.length] ?? 0;
}

function dominates(a: number[], b: number[]): boolean {
  return a.every((value, i) => value >= (b[i] ?? 0)) && a.some((value, i) => value > (b[i] ?? 0));
}

function crowdingScore(genome: PolicyGenome, population: PolicyGenome[]): number {
  return mean(genome.objectives.map((value, i) => {
    const col = population.map(item => item.objectives[i] ?? 0);
    const spread = Math.sqrt(variance(col));
    return spread > 0 ? Math.abs(value - mean(col)) / spread : 0;
  }));
}

function linf(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  let out = 0;
  for (let i = 0; i < n; i++) out = Math.max(out, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
