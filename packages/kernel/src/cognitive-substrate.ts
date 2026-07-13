import type { EpistemicForce, JsonValue } from "./types.js";

export interface TypedEvent {
  id: string;
  typeId: string;
  timestamp: number;
  payload: JsonValue;
}

export interface TemporalTypedGraphNode {
  id: string;
  typeId: string;
  timestamp: number;
}

export interface TemporalTypedGraphEdge {
  id: string;
  source: string;
  target: string;
  relationId: string;
  timestamp: number;
  weight: number;
  evidenceIds: string[];
}

export interface TemporalTypedGraph {
  nodes: TemporalTypedGraphNode[];
  edges: TemporalTypedGraphEdge[];
}

export interface TransitionRule {
  id: string;
  relationId: string;
  weight: number;
  scope: string;
}

export interface CompressionSummary {
  rank: number;
  factorCount: number;
  note: string;
}

export interface BoundedInference {
  depth: number;
  bounded: boolean;
  reason: string;
}

export interface GuardFlags {
  requireEvidence: boolean;
  blockCertifiedFact: boolean;
  allowInference: boolean;
  allowCreative: boolean;
  exposeContradiction: boolean;
}

export interface TypedAnswerAction {
  kind: "answer" | "action";
  answer: string;
  force: EpistemicForce;
  guardFlags: GuardFlags;
  substrate: {
    support: number;
    recency: number;
    sourceQuality: number;
    pathStrength: number;
    contradictionMass: number;
    connectivity: number;
    spectralConnectivity: number;
    compression: CompressionSummary;
    inference: BoundedInference;
  };
  score: number;
}

export interface CognitiveSubstrate {
  events: TypedEvent[];
  graph: TemporalTypedGraph;
  transitionRules: TransitionRule[];
  spectralConnectivity: number;
  compression: CompressionSummary;
  inference: BoundedInference;
  answer: TypedAnswerAction;
}

export const defaultGuardFlags: GuardFlags = {
  requireEvidence: true,
  blockCertifiedFact: true,
  allowInference: true,
  allowCreative: false,
  exposeContradiction: true
};

export function buildCognitiveSubstrate(input: {
  answer: string;
  force: EpistemicForce;
  support: number;
  recency: number;
  sourceQuality: number;
  pathStrength: number;
  contradictionMass: number;
  connectivity: number;
  events: TypedEvent[];
  graph: TemporalTypedGraph;
  rules: TransitionRule[];
  spectralConnectivity: number;
  compression: CompressionSummary;
  inference: BoundedInference;
  guardFlags?: Partial<GuardFlags>;
}): CognitiveSubstrate {
  const guardFlags = { ...defaultGuardFlags, ...input.guardFlags };
  const supportScore = clamp01(input.support);
  const recencyScore = clamp01(input.recency);
  const sourceScore = clamp01(input.sourceQuality);
  const pathScore = clamp01(input.pathStrength);
  const contradictionPenalty = clamp01(input.contradictionMass);
  const connectivityScore = clamp01(input.connectivity);
  const compressionScore = input.compression.factorCount > 0 ? clamp01(input.compression.rank / input.compression.factorCount) : 0.5;
  const inferenceScore = input.inference.bounded ? 0.74 : 0.56;
  const rawScore =
    0.28 * supportScore +
    0.16 * recencyScore +
    0.14 * sourceScore +
    0.18 * pathScore +
    0.12 * connectivityScore +
    0.07 * compressionScore +
    0.05 * inferenceScore -
    0.15 * contradictionPenalty;

  const score = clamp01(rawScore + (guardFlags.requireEvidence ? 0.04 : 0) - (guardFlags.blockCertifiedFact ? 0.02 : 0));
  const kind: TypedAnswerAction["kind"] = input.force === "invented" || guardFlags.allowCreative ? "action" : "answer";

  const answer: TypedAnswerAction = {
    kind,
    answer: input.answer,
    force: input.force,
    guardFlags,
    substrate: {
      support: supportScore,
      recency: recencyScore,
      sourceQuality: sourceScore,
      pathStrength: pathScore,
      contradictionMass: contradictionPenalty,
      connectivity: connectivityScore,
      spectralConnectivity: clamp01(input.spectralConnectivity),
      compression: input.compression,
      inference: input.inference
    },
    score
  };

  return {
    events: input.events,
    graph: input.graph,
    transitionRules: input.rules,
    spectralConnectivity: clamp01(input.spectralConnectivity),
    compression: input.compression,
    inference: input.inference,
    answer
  };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
