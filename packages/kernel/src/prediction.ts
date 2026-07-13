import type { AlphaTrace, ConstructGraph, ForecastEnvelope, ForecastState, GraphSnapshot, JsonValue, ProgramGraph } from "./types.js";
import type { IdFactory } from "./ids.js";
import { covariance, jacobiEigenvaluesSymmetric } from "./math.js";
import { clamp01, mean, toJsonValue } from "./primitives.js";
import { woldForecast } from "./spectral-forecast.js";

export interface PredictionConstruct {
  schema: "scce.prediction_construct.v1";
  id: string;
  subjectId: string;
  relationId: string;
  predictedSurface: string;
  horizonId?: string;
  basisEvidenceIds: string[];
  basisPriorIds: string[];
  noveltyScore: number;
  supportScore: number;
  riskScore: number;
  uncertaintyScore: number;
  proofStatusId: "proof.status.non_certifying_prediction";
  trace: JsonValue;
}

export interface InventionConstruct {
  schema: "scce.invention_construct.v1";
  id: string;
  title: string;
  proposalSurface: string;
  artifactKindIds: string[];
  basisEvidenceIds: string[];
  basisPriorIds: string[];
  noveltyScore: number;
  supportScore: number;
  riskScore: number;
  proofStatusId: "proof.status.generated_not_evidence";
  programGraph?: ProgramGraph;
  validationPlan: Array<{ command: { command: string; args: string[]; cwd: string }; commandSource: string; expectedFiles: string[] }>;
  trace: JsonValue;
}

export function createPredictionConstruct(input: {
  id?: string;
  subjectId: string;
  relationId: string;
  predictedSurface: string;
  horizonId?: string;
  basisEvidenceIds?: readonly string[];
  basisPriorIds?: readonly string[];
  supportScore?: number;
  riskScore?: number;
  uncertaintyScore?: number;
}): PredictionConstruct {
  const support = clamp01(input.supportScore ?? (input.basisEvidenceIds?.length ? 0.58 : 0.24));
  const uncertainty = clamp01(input.uncertaintyScore ?? 1 - support * 0.72);
  const risk = clamp01(input.riskScore ?? uncertainty * 0.7);
  const novelty = noveltyFromIds(input.predictedSurface, input.basisEvidenceIds ?? [], input.basisPriorIds ?? []);
  const body = {
    subjectId: input.subjectId,
    relationId: input.relationId,
    predictedSurface: input.predictedSurface,
    horizonId: input.horizonId ?? null,
    basisEvidenceIds: [...(input.basisEvidenceIds ?? [])],
    basisPriorIds: [...(input.basisPriorIds ?? [])]
  };
  return {
    schema: "scce.prediction_construct.v1",
    id: input.id ?? stableId("prediction_construct", body),
    subjectId: input.subjectId,
    relationId: input.relationId,
    predictedSurface: input.predictedSurface,
    horizonId: input.horizonId,
    basisEvidenceIds: [...(input.basisEvidenceIds ?? [])],
    basisPriorIds: [...(input.basisPriorIds ?? [])],
    noveltyScore: novelty,
    supportScore: support,
    riskScore: risk,
    uncertaintyScore: uncertainty,
    proofStatusId: "proof.status.non_certifying_prediction",
    trace: toJsonValue({ source: "prediction.construct", support, risk, uncertainty, novelty, certifiesFact: false })
  };
}

export function createInventionConstruct(input: {
  id?: string;
  title: string;
  proposalSurface: string;
  artifactKindIds?: readonly string[];
  basisEvidenceIds?: readonly string[];
  basisPriorIds?: readonly string[];
  programGraph?: ProgramGraph;
  supportScore?: number;
  riskScore?: number;
  noveltyScore?: number;
  trace?: JsonValue;
}): InventionConstruct {
  const support = clamp01(input.supportScore ?? (input.basisEvidenceIds?.length ? 0.52 : 0.22));
  const novelty = clamp01(input.noveltyScore ?? noveltyFromIds(input.proposalSurface, input.basisEvidenceIds ?? [], input.basisPriorIds ?? []));
  const risk = clamp01(input.riskScore ?? 0.22 + novelty * 0.38 + (input.programGraph?.hydration?.valid === false ? 0.22 : 0));
  const validationPlan = input.programGraph ? validationPlanFromProgram(input.programGraph) : [];
  const body = {
    title: input.title,
    proposalSurface: input.proposalSurface,
    artifactKindIds: [...(input.artifactKindIds ?? [])],
    basisEvidenceIds: [...(input.basisEvidenceIds ?? [])],
    basisPriorIds: [...(input.basisPriorIds ?? [])],
    programGraphId: input.programGraph?.id ?? null
  };
  return {
    schema: "scce.invention_construct.v1",
    id: input.id ?? stableId("invention_construct", body),
    title: input.title,
    proposalSurface: input.proposalSurface,
    artifactKindIds: [...(input.artifactKindIds ?? [])],
    basisEvidenceIds: [...(input.basisEvidenceIds ?? [])],
    basisPriorIds: [...(input.basisPriorIds ?? [])],
    noveltyScore: novelty,
    supportScore: support,
    riskScore: risk,
    proofStatusId: "proof.status.generated_not_evidence",
    programGraph: input.programGraph,
    validationPlan,
    trace: toJsonValue({
      source: "invention.construct",
      support,
      risk,
      novelty,
      certifiesFact: false,
      programGraphId: input.programGraph?.id ?? null,
      validationCommands: validationPlan.length,
      ...jsonObject(input.trace)
    })
  };
}

function jsonObject(value: JsonValue | undefined): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}

export function predictionConstructNode(construct: PredictionConstruct): ConstructGraph["nodes"][number] {
  return {
    id: construct.id,
    kind: "construct:prediction",
    label: construct.subjectId,
    metadata: toJsonValue(construct)
  };
}

export function inventionConstructNode(construct: InventionConstruct): ConstructGraph["nodes"][number] {
  return {
    id: construct.id,
    kind: "construct:invention",
    label: construct.title,
    metadata: toJsonValue({ ...construct, programGraph: construct.programGraph ? { id: construct.programGraph.id, entrypoint: construct.programGraph.entrypoint } : null })
  };
}

export function createPredictionLayer(options: { idFactory: IdFactory }) {
  return {
    state(input: { episodeId?: ForecastState["episodeId"]; graph: GraphSnapshot; alphaTrace: AlphaTrace; t: number }): ForecastState {
      const eigen = jacobiEigenvaluesSymmetric(input.alphaTrace.normalizedLaplacian.values);
      const lambda2 = eigen[1] ?? 0;
      const lambdaN = eigen[eigen.length - 1] ?? 0;
      const degrees = input.alphaTrace.adjacency.values.map(row => row.reduce((sum, value) => sum + value, 0));
      const degreeMean = mean(degrees);
      const degreeSigma = Math.sqrt(mean(degrees.map(d => (d - degreeMean) ** 2)));
      const stateVector = [
        lambda2,
        lambdaN,
        degreeSigma,
        input.graph.edges.length,
        input.alphaTrace.contradictionMass,
        input.alphaTrace.surfaces.drift,
        input.alphaTrace.bondedLeakage,
        input.alphaTrace.surfaces.actionability,
        input.alphaTrace.surfaces.risk
      ];
      return {
        id: options.idFactory.forecastStateId({ episodeId: input.episodeId, stateVector, t: input.t }),
        episodeId: input.episodeId,
        t: input.t,
        stateVector,
        alphaSurface: input.alphaTrace.surfaces,
        spectrum: input.alphaTrace.normalizedLaplacian
      };
    },
    forecast(input: { states: ForecastState[]; source: ForecastState; horizon: number; createdAt: number }): ForecastEnvelope {
      const history = [...input.states.slice(-8), input.source].map(state => state.stateVector);
      const d = input.source.stateVector.length;
      const eig = jacobiEigenvaluesSymmetric(input.source.spectrum.values);
      const gap = Math.max(1e-6, Math.abs((eig[1] ?? 0) - (eig[0] ?? 0)));
      const spectral = woldForecast({ series: input.states.slice(-16).map(state => state.stateVector), source: input.source.stateVector, horizon: input.horizon, maxOrder: 3, sinTheta: 1 / (1 + 1 / gap), stabilityTrust: 0.8 });
      const meanVector = spectral.mean.length === d ? spectral.mean : input.source.stateVector;
      const covarianceH = spectral.covariance.length ? spectral.covariance : covariance([new Array(d).fill(1e-6)]);
      const interval = spectral.interval.length ? spectral.interval.map(item => ({ mean: item.mean, low: item.low, high: item.high })) : meanVector.map(m => ({ mean: m, low: m - 1e-3, high: m + 1e-3 }));
      return {
        id: options.idFactory.forecastEnvelopeId({ source: input.source.id, horizon: input.horizon, meanVector }),
        sourceStateId: input.source.id,
        horizon: input.horizon,
        mean: meanVector.map(clamp01),
        covariance: covarianceH,
        interval,
        audit: {
          modelOrder: spectral.model.order,
          aic: spectral.model.aic,
          unstable: spectral.unstable,
          gapPenalty: spectral.gapPenalty,
          sgwShrink: spectral.sgwShrink,
          residualRows: spectral.model.residuals.length,
          method: "VAR-by-AIC + Wold covariance + SGW Davis-Kahan shrink"
        },
        createdAt: input.createdAt
      };
    }
  };
}

function validationPlanFromProgram(program: ProgramGraph): InventionConstruct["validationPlan"] {
  const expectedFiles = program.files.map(file => file.path);
  return [
    { command: program.build, commandSource: commandSourceId(program.build), expectedFiles },
    { command: program.test, commandSource: commandSourceId(program.test), expectedFiles }
  ];
}

function commandSourceId(command: { command: string }): string {
  return command.command === "source-derived" ? "program.validation.command.source_derived" : "program.validation.command.observed";
}

function noveltyFromIds(surface: string, evidenceIds: readonly string[], priorIds: readonly string[]): number {
  const evidenceMass = Math.min(1, evidenceIds.length / 8);
  const priorMass = Math.min(1, priorIds.length / 8);
  const surfaceMass = Math.min(1, surfaceUnits(surface).length / 32);
  return clamp01(0.55 * surfaceMass + 0.28 * (1 - evidenceMass) + 0.17 * priorMass);
}

function surfaceUnits(text: string): string[] {
  const out: string[] = [];
  let current = "";
  for (const char of text.normalize("NFKC")) {
    if (isSurfaceUnitChar(char)) {
      current += char;
      continue;
    }
    if (current) {
      out.push(current);
      current = "";
    }
  }
  if (current) out.push(current);
  return out;
}

function isSurfaceUnitChar(char: string): boolean {
  const cp = char.codePointAt(0) ?? 0;
  return cp >= 48 && cp <= 57 || cp >= 65 && cp <= 90 || cp >= 97 && cp <= 122 || cp > 127 && char.trim() !== "";
}

function stableId(prefix: string, payload: unknown): string {
  return `${prefix}_${hashText(JSON.stringify(payload)).slice(0, 24)}`;
}

function hashText(text: string): string {
  let h1 = 2166136261;
  let h2 = 16777619;
  for (let i = 0; i < text.length; i++) {
    const cp = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ cp, 16777619);
    h2 = Math.imul(h2 + cp, 1099511627);
  }
  return `${(h1 >>> 0).toString(16).padStart(8, "0")}${(h2 >>> 0).toString(16).padStart(8, "0")}`;
}
