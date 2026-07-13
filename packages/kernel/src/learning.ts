import type { EvidenceSpan, GraphSlice, JsonValue, LanguageProfile, ModelState, TrainInput } from "./types.js";
import type { QuarantineSource } from "./storage.js";
import { clamp01, featureSet, mean, toJsonValue, weightedJaccard } from "./primitives.js";

export interface LearningPlan {
  goals: LearningGoalPlan[];
  promotion: PromotionPlan;
  language: LanguageLearningPlan;
  graph: GraphLearningPlan;
  programPatterns: JsonValue[];
  policyPatch: JsonValue;
  audit: JsonValue;
}

export interface LearningGoalPlan {
  goal: string;
  priority: number;
  evidenceCoverage: number;
  graphCoverage: number;
  actions: string[];
}

export interface PromotionPlan {
  pending: number;
  promoteSourceVersionIds: string[];
  rejectSourceVersionIds: string[];
  reasons: Array<{ sourceVersionId: string; action: "promote" | "reject" | "hold"; score: number; reason: string }>;
}

export interface LanguageLearningPlan {
  profiles: number;
  scripts: Array<{ script: string; mass: number; profiles: number }>;
  lowCoverageScripts: string[];
  actions: string[];
}

export interface GraphLearningPlan {
  nodes: number;
  edges: number;
  hyperedges: number;
  meanAlpha: number;
  sparseAreas: string[];
  actions: string[];
}

export function createLearningController() {
  return {
    plan(input: { config: TrainInput["config"]; model: ModelState; graph: GraphSlice; pending: QuarantineSource[]; profiles: LanguageProfile[]; candidateEvidence?: EvidenceSpan[] }): LearningPlan {
      const goals = planGoals(input.config.learningGoals ?? input.model.learningGoals, input.graph, input.candidateEvidence ?? []);
      const promotion = planPromotion(input.pending, input.config.promotion?.minTrust ?? 0.5, input.config.promotion?.namespaces ?? []);
      const language = planLanguage(input.profiles);
      const graph = planGraph(input.graph);
      const programPatterns = [...(input.model.learnedProgramPatterns ?? []), ...(input.config.programPatterns ?? [])].slice(-256);
      const policyPatch = toJsonValue(input.config.policy ?? {});
      return {
        goals,
        promotion,
        language,
        graph,
        programPatterns,
        policyPatch,
        audit: toJsonValue({ goals, promotion, language, graph, programPatterns: programPatterns.length, policyPatch })
      };
    },

    updateModel(model: ModelState, plan: LearningPlan, profiles: LanguageProfile[]): ModelState {
      return {
        ...model,
        learningGoals: [...new Set([...model.learningGoals, ...plan.goals.map(goal => goal.goal)])],
        learnedProgramPatterns: plan.programPatterns,
        languageProfiles: profiles,
        trainingSteps: model.trainingSteps + 1
      };
    }
  };
}

function planGoals(goals: readonly string[], graph: GraphSlice, evidence: readonly EvidenceSpan[]): LearningGoalPlan[] {
  const graphFeatures = [...new Set(graph.nodes.flatMap(node => node.features.slice(0, 100)))];
  return goals.map(goal => {
    const features = featureSet(goal, 128);
    const evidenceCoverage = evidence.length ? Math.max(...evidence.map(span => weightedJaccard(features, span.features))) : 0;
    const graphCoverage = graphFeatures.length ? weightedJaccard(features, graphFeatures) : 0;
    const priority = clamp01(0.45 * (1 - evidenceCoverage) + 0.35 * (1 - graphCoverage) + 0.2 * (goal.length > 0 ? 1 : 0));
    const actions = [
      evidenceCoverage < 0.25 ? "ingest more source evidence" : "reuse promoted evidence",
      graphCoverage < 0.2 ? "materialize missing graph symbols" : "connect goal to weighted feature sketches",
      priority > 0.65 ? "schedule high-priority learning turn" : "monitor"
    ];
    return { goal, priority, evidenceCoverage, graphCoverage, actions };
  }).sort((a, b) => b.priority - a.priority);
}

function planPromotion(pending: readonly QuarantineSource[], minTrust: number, namespaces: readonly string[]): PromotionPlan {
  const reasons = pending.map(source => {
    const trust = trustScore(source.trustVector);
    const namespaceOk = namespaces.length === 0 || namespaces.some(ns => String(source.uri).startsWith(ns) || String(source.sourceId).includes(ns));
    const permissionOk = permissionScore(source.permissionVector) > 0.45;
    const score = clamp01(0.55 * trust + 0.3 * (namespaceOk ? 1 : 0.4) + 0.15 * (permissionOk ? 1 : 0));
    const action: PromotionPlan["reasons"][number]["action"] = score >= minTrust && permissionOk ? "promote" : score < 0.25 ? "reject" : "hold";
    const reason = action === "promote" ? "trust and permission threshold met" : action === "reject" ? "trust score below rejection floor" : "held for more evidence or explicit namespace";
    return { sourceVersionId: String(source.sourceVersionId), action, score, reason };
  });
  return {
    pending: pending.length,
    promoteSourceVersionIds: reasons.filter(item => item.action === "promote").map(item => item.sourceVersionId),
    rejectSourceVersionIds: reasons.filter(item => item.action === "reject").map(item => item.sourceVersionId),
    reasons
  };
}

function planLanguage(profiles: readonly LanguageProfile[]): LanguageLearningPlan {
  const masses = new Map<string, { mass: number; profiles: number }>();
  for (const profile of profiles) {
    for (const script of profile.scripts) {
      const current = masses.get(script.script) ?? { mass: 0, profiles: 0 };
      current.mass += script.mass;
      current.profiles++;
      masses.set(script.script, current);
    }
  }
  const scripts = [...masses.entries()].map(([script, value]) => ({ script, mass: value.mass / Math.max(1, value.profiles), profiles: value.profiles })).sort((a, b) => b.mass - a.mass);
  const lowCoverageScripts = scripts.filter(script => script.profiles < 2 || script.mass < 0.2).map(script => script.script);
  const actions = [
    lowCoverageScripts.length ? `acquire more samples for ${lowCoverageScripts.slice(0, 5).join(", ")}` : "script coverage sufficient for current corpus",
    profiles.length < 5 ? "ingest additional multilingual corpus" : "refresh language profiles after next ingest"
  ];
  return { profiles: profiles.length, scripts, lowCoverageScripts, actions };
}

function planGraph(graph: GraphSlice): GraphLearningPlan {
  const meanAlpha = mean(graph.nodes.map(node => node.alpha));
  const typeCounts = new Map<string, number>();
  for (const node of graph.nodes) {
    const type = String((node.metadata as { type?: string }).type ?? node.typeId);
    typeCounts.set(type, (typeCounts.get(type) ?? 0) + 1);
  }
  const sparseAreas = [...typeCounts.entries()].filter(([, count]) => count < 3).map(([type]) => type);
  const actions = [
    graph.hyperedges.length < Math.max(1, graph.nodes.length / 12) ? "increase higher-order evidence hyperedges" : "hyperedge density acceptable",
    meanAlpha < 0.35 ? "promote stronger evidence before relying on graph inference" : "alpha field has usable pressure",
    sparseAreas.length ? `sparse node types: ${sparseAreas.slice(0, 8).join(", ")}` : "node type coverage balanced"
  ];
  return { nodes: graph.nodes.length, edges: graph.edges.length, hyperedges: graph.hyperedges.length, meanAlpha, sparseAreas, actions };
}

function trustScore(value: JsonValue): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0.5;
  const record = value as Record<string, JsonValue>;
  if (typeof record.trust === "number") return record.trust;
  if (typeof record.risk === "number") return 1 - record.risk;
  if (typeof record.sourceTrust === "number") return record.sourceTrust;
  return 0.55;
}

function permissionScore(value: JsonValue): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0.5;
  const record = value as Record<string, JsonValue>;
  if (record.disposition === "promote") return 1;
  if (record.disposition === "reject") return 0;
  if (Array.isArray(record.safetyRails) && record.safetyRails.length) return 0.55;
  return 0.65;
}
