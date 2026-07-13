import type { CapabilityPlan, ConstructGraph, EmissionGraph, EpisodeId, FieldState, Hasher, IngestResult, JsonValue, SemanticEntailmentResult, TrainResult, TurnResult, ValidationGraph } from "./types.js";
import { clamp01, createHasher, mean, toJsonValue } from "./primitives.js";
import type { AlphaPersistenceRecord, AlphaReuseDecision } from "./alpha-field-persistence.js";
import type { ConstructAssembly } from "./construct-substrate.js";
import type { CounterfactualWorld } from "./counterfactual-cognition.js";
import type { HybridRetrievalResult } from "./semantic-memory-index.js";
import type { SafetyRailDecision } from "./safety-rail-engine.js";
import type { ToolCognitionPlan } from "./tool-cognition.js";
import type { TrainingPlan } from "./training-orchestrator.js";

export type RuntimeStageKind =
  | "receive"
  | "safety"
  | "retrieve"
  | "field"
  | "alpha_cache"
  | "entail"
  | "construct"
  | "tool_plan"
  | "counterfactual"
  | "validate"
  | "emit"
  | "learn"
  | "persist"
  | "inspect";

export interface RuntimeStageNode {
  id: string;
  kind: RuntimeStageKind;
  label: string;
  inputs: string[];
  outputs: string[];
  required: boolean;
  mutates: boolean;
  risk: number;
  status: "pending" | "ready" | "running" | "succeeded" | "failed" | "skipped";
  audit: JsonValue;
}

export interface RuntimeStageEdge {
  source: string;
  target: string;
  relation: "precedes" | "requires" | "feeds" | "gates" | "persists";
  weight: number;
}

export interface RuntimeExecutionDag {
  id: string;
  episodeId: EpisodeId;
  stages: RuntimeStageNode[];
  edges: RuntimeStageEdge[];
  criticalPath: string[];
  mutationBoundary: string[];
  replayBoundary: string[];
  audit: JsonValue;
}

export interface RuntimeOrchestrationState {
  dag: RuntimeExecutionDag;
  safety?: SafetyRailDecision;
  retrieval?: HybridRetrievalResult;
  field?: FieldState;
  alphaRecord?: AlphaPersistenceRecord;
  alphaReuse?: AlphaReuseDecision;
  entailment?: SemanticEntailmentResult;
  construct?: ConstructGraph;
  assembly?: ConstructAssembly;
  toolPlan?: ToolCognitionPlan;
  capabilityPlans?: CapabilityPlan[];
  counterfactual?: CounterfactualWorld;
  validation?: ValidationGraph;
  emission?: EmissionGraph;
  training?: TrainingPlan;
  ingest?: IngestResult;
  train?: TrainResult;
  turn?: TurnResult;
}

export interface RuntimeReadiness {
  ready: boolean;
  missing: string[];
  warnings: string[];
  risk: number;
  audit: JsonValue;
}

export function createRuntimeOrchestrator(options: { hasher?: Hasher } = {}) {
  const hasher = options.hasher ?? createHasher();
  return {
    dag(input: { episodeId: EpisodeId; mode: "turn" | "ingest" | "train" | "inspect"; mutating: boolean; requestedTools?: boolean }): RuntimeExecutionDag {
      return buildDag(input, hasher);
    },

    readiness(state: RuntimeOrchestrationState): RuntimeReadiness {
      return readinessFor(state);
    },

    advance(input: { state: RuntimeOrchestrationState; completedStage: RuntimeStageKind; payload?: unknown; failed?: string }): RuntimeOrchestrationState {
      return advanceState(input, hasher);
    },

    summarize(state: RuntimeOrchestrationState): JsonValue {
      return summarizeState(state);
    }
  };
}

function buildDag(input: { episodeId: EpisodeId; mode: "turn" | "ingest" | "train" | "inspect"; mutating: boolean; requestedTools?: boolean }, hasher: Hasher): RuntimeExecutionDag {
  const stages: RuntimeStageNode[] = [];
  const add = (kind: RuntimeStageKind, label: string, inputs: string[], outputs: string[], required: boolean, mutates: boolean, risk: number) => {
    stages.push({
      id: `stage:${kind}`,
      kind,
      label,
      inputs,
      outputs,
      required,
      mutates,
      risk: clamp01(risk),
      status: kind === "receive" ? "ready" : "pending",
      audit: toJsonValue({ inputs, outputs, required, mutates })
    });
  };
  add("receive", "receive owner input and create episode", ["OwnerInput"], ["EpisodeId", "OwnerAsked"], true, false, 0.05);
  add("safety", "evaluate safety rails and mutation constraints", ["OwnerInput", "PolicyProfile"], ["SafetyRailDecision"], true, false, 0.18);
  if (input.mode === "inspect") {
    add("inspect", "read inspection target and replay durable events", ["InspectionTarget"], ["InspectionResult"], true, false, 0.08);
    add("persist", "append inspection event", ["InspectionResult"], ["ScceEvent"], false, true, 0.12);
  } else if (input.mode === "ingest") {
    add("retrieve", "read source bytes through bounded ingestion planner", ["IngestInput"], ["SourceVersion", "EvidenceSpan"], true, true, 0.34);
    add("field", "seed graph and alpha surfaces from evidence", ["EvidenceSpan"], ["GraphSnapshot", "FieldState"], true, true, 0.22);
    add("learn", "derive language and graph learning candidates", ["EvidenceSpan", "GraphSnapshot"], ["ModelDelta"], false, true, 0.28);
    add("persist", "commit source versions, evidence, graph, and events", ["SourceVersion", "EvidenceSpan", "GraphSnapshot"], ["IngestResult"], true, true, 0.42);
  } else if (input.mode === "train") {
    add("retrieve", "select promoted evidence and recent proof obligations", ["TrainInput", "ModelState"], ["TrainingCorpus"], true, false, 0.18);
    add("learn", "run training orchestrator and model promotion", ["TrainingCorpus"], ["TrainingPlan", "TrainingCheckpoint"], true, true, 0.36);
    add("persist", "commit model checkpoint and training events", ["TrainingCheckpoint"], ["TrainResult"], true, true, 0.38);
  } else {
    add("retrieve", "hybrid retrieve evidence and graph candidates", ["OwnerInput", "ModelState"], ["HybridRetrievalResult"], true, false, 0.18);
    add("field", "activate alpha field and personalized PPF", ["HybridRetrievalResult", "GraphSnapshot"], ["FieldState"], true, false, 0.2);
    add("alpha_cache", "reuse or persist alpha trace and PPF cache", ["FieldState", "GraphFingerprint"], ["AlphaPersistenceRecord"], false, true, 0.24);
    add("entail", "build semantic proof, obligations, and counterexamples", ["OwnerInput", "EvidenceSpan", "FieldState"], ["SemanticEntailmentResult"], true, false, 0.24);
    add("construct", "build construct graph and architecture substrate", ["SemanticEntailmentResult"], ["ConstructGraph", "ConstructAssembly"], true, false, 0.26);
    if (input.requestedTools) add("tool_plan", "plan governed capabilities and approvals", ["ConstructGraph", "PolicyProfile"], ["ToolCognitionPlan"], false, true, 0.46);
    add("counterfactual", "simulate intervention and causal alternatives when useful", ["GraphSnapshot", "ConstructGraph"], ["CounterfactualWorld"], false, false, 0.2);
    add("validate", "validate construct, safety, proof, and artifacts", ["ConstructGraph", "SafetyRailDecision"], ["ValidationGraph"], true, false, 0.28);
    add("emit", "emit evidence-grounded answer and releasable artifacts", ["ValidationGraph", "SemanticEntailmentResult"], ["EmissionGraph"], true, false, 0.18);
    add("learn", "prepare learning curriculum from obligations", ["SemanticEntailmentResult", "EmissionGraph"], ["TrainingPlan"], false, true, 0.24);
    add("persist", "commit turn events, proof, construct, validation, emission", ["EmissionGraph", "TrainingPlan"], ["TurnResult"], true, true, 0.4);
  }
  const edges = edgesFor(stages, input);
  const criticalPath = criticalPathFor(stages, edges);
  const mutationBoundary = stages.filter(stage => stage.mutates).map(stage => stage.id);
  const replayBoundary = stages.filter(stage => stage.required || stage.mutates).map(stage => stage.id);
  return {
    id: `runtime_dag_${hasher.digestHex(JSON.stringify({ episodeId: input.episodeId, stages: stages.map(s => s.kind), edges })).slice(0, 32)}`,
    episodeId: input.episodeId,
    stages,
    edges,
    criticalPath,
    mutationBoundary,
    replayBoundary,
    audit: toJsonValue({ mode: input.mode, mutating: input.mutating, requestedTools: input.requestedTools, criticalPath, mutationBoundary, replayBoundary })
  };
}

function edgesFor(stages: readonly RuntimeStageNode[], input: { mode: string; requestedTools?: boolean }): RuntimeStageEdge[] {
  const has = (kind: RuntimeStageKind) => stages.some(stage => stage.kind === kind);
  const edge = (source: RuntimeStageKind, target: RuntimeStageKind, relation: RuntimeStageEdge["relation"], weight: number): RuntimeStageEdge | undefined =>
    has(source) && has(target) ? { source: `stage:${source}`, target: `stage:${target}`, relation, weight } : undefined;
  const edges = [
    edge("receive", "safety", "precedes", 1),
    edge("safety", "retrieve", "gates", 0.95),
    edge("retrieve", "field", "feeds", 0.9),
    edge("field", "alpha_cache", "feeds", 0.82),
    edge("field", "entail", "feeds", 0.9),
    edge("alpha_cache", "entail", "feeds", 0.7),
    edge("entail", "construct", "feeds", 0.95),
    edge("construct", "tool_plan", "feeds", 0.78),
    edge("construct", "counterfactual", "feeds", 0.48),
    edge("safety", "validate", "gates", 0.88),
    edge("construct", "validate", "feeds", 0.9),
    edge("tool_plan", "validate", "gates", input.requestedTools ? 0.9 : 0.4),
    edge("validate", "emit", "gates", 0.95),
    edge("emit", "learn", "feeds", 0.6),
    edge("emit", "persist", "persists", 1),
    edge("learn", "persist", "persists", 0.7),
    edge("inspect", "persist", "persists", 0.4),
    edge("learn", "persist", "persists", 0.85),
    edge("field", "persist", "persists", input.mode === "ingest" ? 0.88 : 0.4),
    edge("retrieve", "persist", "persists", input.mode === "ingest" ? 0.92 : 0.35)
  ].filter((item): item is RuntimeStageEdge => Boolean(item));
  return dedupeEdges(edges);
}

function criticalPathFor(stages: readonly RuntimeStageNode[], edges: readonly RuntimeStageEdge[]): string[] {
  const required = new Set(stages.filter(stage => stage.required).map(stage => stage.id));
  const outgoing = new Map<string, RuntimeStageEdge[]>();
  for (const edge of edges) {
    const bucket = outgoing.get(edge.source) ?? [];
    bucket.push(edge);
    outgoing.set(edge.source, bucket);
  }
  const path = ["stage:receive"];
  let current = "stage:receive";
  const seen = new Set<string>(path);
  while (outgoing.has(current)) {
    const next = (outgoing.get(current) ?? [])
      .filter(edge => required.has(edge.target) && !seen.has(edge.target))
      .sort((a, b) => b.weight - a.weight)[0];
    if (!next) break;
    path.push(next.target);
    seen.add(next.target);
    current = next.target;
  }
  return path;
}

function readinessFor(state: RuntimeOrchestrationState): RuntimeReadiness {
  const missing: string[] = [];
  const warnings: string[] = [];
  const stageByKind = new Map(state.dag.stages.map(stage => [stage.kind, stage]));
  const needs = (kind: RuntimeStageKind, present: boolean, label: string) => {
    const stage = stageByKind.get(kind);
    if (stage?.required && !present) missing.push(label);
    else if (!present && stage) warnings.push(label);
  };
  needs("safety", Boolean(state.safety), "safety decision");
  needs("retrieve", Boolean(state.retrieval || state.ingest || state.training), "retrieval or ingestion result");
  needs("field", Boolean(state.field || state.ingest), "field state");
  needs("entail", Boolean(state.entailment), "semantic entailment");
  needs("construct", Boolean(state.construct || state.assembly), "construct graph");
  needs("validate", Boolean(state.validation), "validation graph");
  needs("emit", Boolean(state.emission), "emission graph");
  const failedStages = state.dag.stages.filter(stage => stage.status === "failed");
  for (const stage of failedStages) missing.push(`failed stage ${stage.kind}`);
  const risk = clamp01(mean(state.dag.stages.map(stage => stage.risk)) + missing.length * 0.08 + warnings.length * 0.03 + (state.safety?.risk ?? 0) * 0.24);
  return {
    ready: missing.length === 0,
    missing,
    warnings,
    risk,
    audit: toJsonValue({ missing, warnings, risk, stages: state.dag.stages.map(stage => ({ kind: stage.kind, status: stage.status })) })
  };
}

function advanceState(input: { state: RuntimeOrchestrationState; completedStage: RuntimeStageKind; payload?: unknown; failed?: string }, hasher: Hasher): RuntimeOrchestrationState {
  const stages = input.state.dag.stages.map(stage => {
    if (stage.kind === input.completedStage) return { ...stage, status: input.failed ? "failed" as const : "succeeded" as const, audit: toJsonValue({ ...asRecord(stage.audit), completedPayload: payloadSummary(input.payload), failed: input.failed ?? null }) };
    if (stage.status === "pending" && predecessorsSucceeded(stage.id, input.state.dag.edges, input.state.dag.stages, input.completedStage, Boolean(input.failed))) return { ...stage, status: "ready" as const };
    return stage;
  });
  return {
    ...input.state,
    dag: {
      ...input.state.dag,
      id: `runtime_dag_${hasher.digestHex(JSON.stringify({ prior: input.state.dag.id, completed: input.completedStage, failed: input.failed, statuses: stages.map(s => [s.kind, s.status]) })).slice(0, 32)}`,
      stages
    }
  };
}

function predecessorsSucceeded(stageId: string, edges: readonly RuntimeStageEdge[], stages: readonly RuntimeStageNode[], completed: RuntimeStageKind, failed: boolean): boolean {
  if (failed) return false;
  const incoming = edges.filter(edge => edge.target === stageId && (edge.relation === "requires" || edge.relation === "gates" || edge.relation === "precedes"));
  if (incoming.length === 0) return false;
  const status = new Map(stages.map(stage => [stage.id, stage.kind === completed ? "succeeded" : stage.status]));
  return incoming.every(edge => status.get(edge.source) === "succeeded");
}

function summarizeState(state: RuntimeOrchestrationState): JsonValue {
  return toJsonValue({
    dag: { id: state.dag.id, episodeId: state.dag.episodeId, stages: state.dag.stages.map(stage => ({ kind: stage.kind, status: stage.status, risk: stage.risk })) },
    safety: state.safety ? { level: state.safety.level, risk: state.safety.risk, allowed: state.safety.allowed } : null,
    retrieval: state.retrieval ? { candidates: state.retrieval.candidates.length, evidence: state.retrieval.selectedEvidenceIds.length, nodes: state.retrieval.selectedNodeIds.length } : null,
    field: state.field ? { active: state.field.active.length, ppf: state.field.ppf.length, contradictionMass: state.field.alphaTrace.contradictionMass } : null,
    alphaReuse: state.alphaReuse ? { reuse: state.alphaReuse.reuse, score: state.alphaReuse.score } : null,
    entailment: state.entailment ? { force: state.entailment.force, support: state.entailment.support, contradiction: state.entailment.contradiction } : null,
    construct: state.construct ? { id: state.construct.id, artifacts: state.construct.artifacts.length } : null,
    toolPlan: state.toolPlan ? { plans: state.toolPlan.capabilityPlans.length, approvals: state.toolPlan.approvals.length } : null,
    validation: state.validation ? { passed: state.validation.passed, checks: state.validation.checks.length } : null,
    emission: state.emission ? { id: state.emission.id, artifacts: state.emission.artifacts.length } : null,
    training: state.training ? { id: state.training.id, curriculum: state.training.curriculum.length, distillation: state.training.distillation.length } : null
  });
}

function dedupeEdges(edges: RuntimeStageEdge[]): RuntimeStageEdge[] {
  const map = new Map<string, RuntimeStageEdge>();
  for (const edge of edges) {
    const key = `${edge.source}:${edge.target}:${edge.relation}`;
    const existing = map.get(key);
    if (!existing || edge.weight > existing.weight) map.set(key, edge);
  }
  return [...map.values()];
}

function payloadSummary(payload: unknown): JsonValue {
  if (payload === undefined) return null;
  if (payload === null || typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean") return payload;
  if (Array.isArray(payload)) return { arrayLength: payload.length };
  if (typeof payload === "object") return { keys: Object.keys(payload as Record<string, unknown>).slice(0, 32) };
  return String(payload);
}

function asRecord(value: JsonValue): Record<string, JsonValue> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, JsonValue> : {};
}
