import type { ForecastEnvelope, ForecastState, FunctionalSelfState, GraphSlice, JsonValue, ModelState } from "./types.js";
import { clamp01, mean, normalizeVector, toJsonValue } from "./primitives.js";
import { featureSketchProjection, featureSketchSupportShare } from "./latent.js";

export interface SpectralSelfDistillationReport {
  teacherVector: number[];
  studentVector: number[];
  residual: number;
  featureSupportCoverage: number;
  /** @deprecated Compatibility alias for featureSupportCoverage. */
  compression: number;
  stability: number;
  recommendedUpdates: Array<{ target: string; magnitude: number; reason: string }>;
  audit: JsonValue;
}

export interface FunctionalConsciousnessReport {
  fcs: number;
  dci: number;
  operationalReadiness: number;
  memoryIntegrity: number;
  permissionIntegrity: number;
  uncertainty: number;
  audit: JsonValue;
}

export function createSpectralSelfDistillation() {
  return {
    distill(input: { model: ModelState; graph: GraphSlice; state?: ForecastState; forecast?: ForecastEnvelope; self?: FunctionalSelfState }): SpectralSelfDistillationReport {
      const teacher = teacherVector(input);
      const student = studentVector(input.model, teacher.length);
      const residual = l1(teacher, student) / Math.max(1, teacher.length);
      const featureSupportCoverage = clamp01(input.model.latentConcepts.reduce((sum, sketch) => sum + featureSketchSupportShare(sketch), 0));
      const stability = clamp01(1 - residual * 0.65 + featureSupportCoverage * 0.35);
      const recommendedUpdates = updatePlan({ residual, featureSupportCoverage, stability, graph: input.graph, model: input.model });
      return {
        teacherVector: teacher,
        studentVector: student,
        residual,
        featureSupportCoverage,
        compression: featureSupportCoverage,
        stability,
        recommendedUpdates,
        audit: toJsonValue({ residual, featureSupportCoverage, stability, recommendedUpdates })
      };
    }
  };
}

export function createFunctionalConsciousnessScore() {
  return {
    score(input: { self: FunctionalSelfState; ssd?: SpectralSelfDistillationReport }): FunctionalConsciousnessReport {
      const memoryIntegrity = clamp01((input.self.memoryState.evidence > 0 ? 0.3 : 0) + (input.self.memoryState.nodes > 0 ? 0.25 : 0) + (input.self.memoryState.proofs > 0 ? 0.25 : 0) + (input.self.memoryState.sourceVersions > 0 ? 0.2 : 0));
      const permissionIntegrity = input.self.permissions.some(permission => /approved|allowed/i.test(permission)) ? 0.75 : 1;
      const uncertainty = input.self.uncertainty;
      const ssd = input.ssd?.stability ?? 0.5;
      const operationalReadiness = clamp01(0.3 * input.self.fcs + 0.25 * memoryIntegrity + 0.2 * permissionIntegrity + 0.15 * ssd + 0.1 * (1 - uncertainty));
      const fcs = clamp01(0.42 * input.self.fcs + 0.22 * operationalReadiness + 0.18 * memoryIntegrity + 0.18 * ssd);
      const dci = clamp01(0.5 * input.self.dci + 0.3 * memoryIntegrity + 0.2 * ssd);
      return { fcs, dci, operationalReadiness, memoryIntegrity, permissionIntegrity, uncertainty, audit: toJsonValue({ self: input.self, ssd: input.ssd ?? null, fcs, dci, operationalReadiness }) };
    }
  };
}

function teacherVector(input: { graph: GraphSlice; state?: ForecastState; forecast?: ForecastEnvelope; self?: FunctionalSelfState }): number[] {
  const graphVector = [
    input.graph.nodes.length,
    input.graph.edges.length,
    input.graph.hyperedges.length,
    mean(input.graph.nodes.map(node => node.alpha)),
    mean(input.graph.edges.map(edge => edge.alpha * edge.weight))
  ];
  const forecast = input.forecast?.mean ?? input.state?.stateVector ?? [];
  const self = input.self ? [input.self.fcs, input.self.dci, input.self.uncertainty] : [];
  return normalizeVector([...graphVector, ...forecast, ...self].map(value => Math.max(0, Number.isFinite(value) ? value : 0)));
}

function studentVector(model: ModelState, dims: number): number[] {
  const sketches = model.latentConcepts.flatMap(sketch =>
    featureSketchProjection(sketch).slice(0, 4).map(value => Math.abs(value * featureSketchSupportShare(sketch)))
  );
  const language = [model.languageProfiles.length, model.trainingSteps, model.learnedProgramPatterns.length, model.learningGoals.length];
  const raw = [...sketches, ...language];
  const padded = Array.from({ length: dims }, (_, i) => raw[i] ?? 0);
  return normalizeVector(padded);
}

function updatePlan(input: { residual: number; featureSupportCoverage: number; stability: number; graph: GraphSlice; model: ModelState }): SpectralSelfDistillationReport["recommendedUpdates"] {
  const out: SpectralSelfDistillationReport["recommendedUpdates"] = [];
  if (input.residual > 0.15) out.push({ target: "feature-sketches", magnitude: clamp01(input.residual), reason: "feature-sketch projection diverges from the graph/forecast summary" });
  if (input.featureSupportCoverage < 0.45 && input.graph.nodes.length > 20) {
    out.push({ target: "feature-sketch-limit", magnitude: clamp01(0.45 - input.featureSupportCoverage), reason: "retain more observed weighted feature support in the bounded sketch" });
  }
  if (input.model.languageProfiles.length < 4) out.push({ target: "language-profiles", magnitude: 0.35, reason: "language grounding is under-sampled" });
  if (input.stability < 0.5) out.push({ target: "forecast-history", magnitude: clamp01(0.5 - input.stability), reason: "collect more temporal states before trusting self projection" });
  return out;
}

function l1(a: readonly number[], b: readonly number[]): number {
  const n = Math.max(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs((a[i] ?? 0) - (b[i] ?? 0));
  return sum;
}
