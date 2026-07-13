import type { Claim, EvidenceId, EvidenceSpan, FieldState, GraphNode, Hasher, JsonValue, NodeId, RelationId } from "./types.js";
import type { IdFactory } from "./ids.js";
import { clamp01, featureSet, mean, stableVector, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";
import { assessStabilityAdjustedSupport, davisKahanSinTheta, hoeffdingLcb } from "./causal-math.js";

export type SemanticRole = "entity" | "predicate" | "modifier" | "quantity" | "time" | "location" | "negation" | "unknown";
export type StructuralEntailmentVerdict = "entailed" | "contradicted" | "unknown" | "underdetermined";

export interface PropositionNode {
  id: string;
  role: SemanticRole;
  text: string;
  normalized: string;
  features: string[];
  sourceEvidenceId?: EvidenceId;
  graphNodeId?: NodeId;
  alpha: number;
  metadata: JsonValue;
}

export interface PropositionEdge {
  id: string;
  source: string;
  relationId: RelationId;
  relation: string;
  target: string;
  support: number;
  contradiction: number;
  evidenceIds: EvidenceId[];
  metadata: JsonValue;
}

export interface PropositionGraph {
  id: string;
  nodes: PropositionNode[];
  edges: PropositionEdge[];
  source: "claim" | "evidence";
  textHash: string;
  metadata: JsonValue;
}

export interface StructuralMapping {
  claimNodeId: string;
  evidenceNodeId?: string;
  evidenceGraphId?: string;
  roleCompatible: boolean;
  lexical: number;
  vector: number;
  graphMass: number;
  score: number;
}

export interface StructuralEntailmentResult {
  verdict: StructuralEntailmentVerdict;
  structuralCoverage: number;
  causalMass: number;
  faithfulnessLCB: number;
  contradiction: number;
  stability: number;
  mappings: StructuralMapping[];
  claimGraph: PropositionGraph;
  evidenceGraphs: PropositionGraph[];
  proofPaths: Array<{ claimEdgeId: string; evidencePath: string[]; support: number; contradiction: number; evidenceIds: EvidenceId[] }>;
  missingEdges: string[];
  audit: JsonValue;
}

export function createSemanticGraphEntailment(options: { idFactory: IdFactory; hasher: Hasher }) {
  return {
    buildClaimGraph(claim: Claim): PropositionGraph {
      return propositionGraphFromText({ text: claim.text, source: "claim", evidence: undefined, idFactory: options.idFactory, hasher: options.hasher });
    },

    buildEvidenceGraph(span: EvidenceSpan): PropositionGraph {
      return propositionGraphFromText({ text: span.text, source: "evidence", evidence: span, idFactory: options.idFactory, hasher: options.hasher });
    },

    check(input: { claim: Claim; evidence: EvidenceSpan[]; nodes: GraphNode[]; field: FieldState }): StructuralEntailmentResult {
      const claimGraph = propositionGraphFromText({ text: input.claim.text, source: "claim", evidence: undefined, idFactory: options.idFactory, hasher: options.hasher });
      const evidenceGraphs = input.evidence.map(span => propositionGraphFromText({ text: span.text, source: "evidence", evidence: span, idFactory: options.idFactory, hasher: options.hasher }));
      const fieldMass = new Map(input.field.ppf.map(row => [String(row.nodeId), row.mass]));
      const mappings = claimGraph.nodes.map(claimNode => bestNodeMapping(claimNode, evidenceGraphs, input.nodes, fieldMass, options.hasher));
      const proofPaths = claimGraph.edges.map(edge => proveEdge(edge, mappings, evidenceGraphs)).filter((path): path is NonNullable<typeof path> => Boolean(path));
      const missingEdges = claimGraph.edges.filter(edge => !proofPaths.some(path => path.claimEdgeId === edge.id)).map(edge => edge.id);
      const structuralCoverage = claimGraph.edges.length
        ? proofPaths.filter(path => path.support >= 0.2 && path.contradiction <= 0.35).length / claimGraph.edges.length
        : mean(mappings.map(mapping => mapping.score));
      const causalMass = mean(mappings.map(mapping => mapping.graphMass));
      const faithfulness = mappings.map(mapping => mapping.score).concat(proofPaths.map(path => path.support));
      const faithfulnessLCB = hoeffdingLcb(faithfulness, 0.05);
      const contradiction = clamp01(mean(proofPaths.map(path => path.contradiction)) + contradictionFromPolarity(claimGraph, evidenceGraphs));
      const dk = davisKahanSinTheta({ base: input.field.alphaTrace.normalizedLaplacian.values, perturbed: input.field.alphaTrace.laplacian.values, priorGap: Math.max(1e-6, input.field.alphaTrace.surfaces.bond) });
      const supportAssessment = assessStabilityAdjustedSupport({ supportSamples: faithfulness, projectedSupport: causalMass, sinTheta: dk.sinTheta });
      const stability = clamp01(1 - dk.sinTheta);
      const sampledSupportLcb = Math.max(faithfulnessLCB, supportAssessment.sampledSupportLcb);
      const verdict = verdictFrom({ structuralCoverage, causalMass: supportAssessment.stabilityAdjustedSupport, faithfulnessLCB: sampledSupportLcb, contradiction, stability, missingEdges: missingEdges.length });
      return {
        verdict,
        structuralCoverage,
        causalMass,
        faithfulnessLCB: sampledSupportLcb,
        contradiction,
        stability,
        mappings,
        claimGraph,
        evidenceGraphs,
        proofPaths,
        missingEdges,
        audit: toJsonValue({
          verdict,
          structuralCoverage,
          causalMass,
          faithfulnessLCB: sampledSupportLcb,
          contradiction,
          stability,
          mappings: mappings.slice(0, 64),
          proofPaths: proofPaths.slice(0, 64),
          missingEdges,
          supportAssessment: supportAssessment.details
        })
      };
    }
  };
}

function propositionGraphFromText(input: { text: string; source: "claim" | "evidence"; evidence?: EvidenceSpan; idFactory: IdFactory; hasher: Hasher }): PropositionGraph {
  const symbols = symbolizeData(input.text).slice(0, 512);
  const units = chunkUnits(symbols);
  const nodes = units.map((unit, index) => {
    const role = roleOf(unit, index);
    const normalized = unit.join(" ");
    const features = featureSet(normalized, 128);
    return {
      id: input.idFactory.semanticId(`prop_${input.source}_node`, { role, normalized, evidenceId: input.evidence?.id ?? null, index }),
      role,
      text: unit.join(" "),
      normalized,
      features,
      sourceEvidenceId: input.evidence?.id,
      alpha: input.evidence?.alpha ?? 1,
      metadata: toJsonValue({ symbolStart: index, symbolCount: unit.length })
    };
  });
  const edges: PropositionEdge[] = [];
  for (let i = 0; i < nodes.length - 1; i++) {
    const source = nodes[i]!;
    const target = nodes[i + 1]!;
    const relation = relationFor(source, target);
    const relationId = input.idFactory.relationId({ semanticRelation: relation, sourceRole: source.role, targetRole: target.role });
    edges.push({
      id: input.idFactory.semanticId(`prop_${input.source}_edge`, { source: source.id, relation, target: target.id, evidenceId: input.evidence?.id ?? null }),
      source: source.id,
      relation,
      relationId,
      target: target.id,
      support: input.evidence?.alpha ?? 1,
      contradiction: source.role === "negation" || target.role === "negation" ? 0.35 : 0,
      evidenceIds: input.evidence ? [input.evidence.id] : [],
      metadata: toJsonValue({ sourceRole: source.role, targetRole: target.role })
    });
  }
  return {
    id: input.idFactory.semanticId(`proposition_graph_${input.source}`, { textHash: input.hasher.digestHex(input.text), evidenceId: input.evidence?.id ?? null }),
    nodes,
    edges,
    source: input.source,
    textHash: input.hasher.digestHex(input.text),
    metadata: toJsonValue({ evidenceId: input.evidence?.id ?? null, symbols: symbols.length })
  };
}

function bestNodeMapping(claimNode: PropositionNode, evidenceGraphs: PropositionGraph[], graphNodes: GraphNode[], fieldMass: Map<string, number>, hasher: Hasher): StructuralMapping {
  let best: StructuralMapping = { claimNodeId: claimNode.id, roleCompatible: false, lexical: 0, vector: 0, graphMass: 0, score: 0 };
  for (const graph of evidenceGraphs) {
    for (const evidenceNode of graph.nodes) {
      const roleCompatible = rolesCompatible(claimNode.role, evidenceNode.role);
      const lexical = weightedJaccard(claimNode.features, evidenceNode.features);
      const vector = cosine01(stableVector(claimNode.features, hasher, 96), stableVector(evidenceNode.features, hasher, 96));
      const graphMass = graphMassForEvidence(evidenceNode.sourceEvidenceId, graphNodes, fieldMass);
      const score = clamp01((roleCompatible ? 0.24 : 0.06) + 0.34 * lexical + 0.24 * vector + 0.18 * graphMass);
      if (score > best.score) best = { claimNodeId: claimNode.id, evidenceNodeId: evidenceNode.id, evidenceGraphId: graph.id, roleCompatible, lexical, vector, graphMass, score };
    }
  }
  return best;
}

function proveEdge(edge: PropositionEdge, mappings: StructuralMapping[], evidenceGraphs: PropositionGraph[]) {
  const source = mappings.find(mapping => mapping.claimNodeId === edge.source);
  const target = mappings.find(mapping => mapping.claimNodeId === edge.target);
  if (!source?.evidenceNodeId || !target?.evidenceNodeId) return undefined;
  const graph = evidenceGraphs.find(candidate => candidate.id === source.evidenceGraphId || candidate.id === target.evidenceGraphId);
  if (!graph) return undefined;
  const path = shortestCompatiblePath(graph, source.evidenceNodeId, target.evidenceNodeId, edge.relation);
  if (!path) return undefined;
  const support = clamp01(mean([source.score, target.score, ...path.edges.map(item => item.support)]));
  const contradiction = clamp01(mean(path.edges.map(item => item.contradiction)));
  return { claimEdgeId: edge.id, evidencePath: path.nodeIds, support, contradiction, evidenceIds: [...new Set(path.edges.flatMap(item => item.evidenceIds))] };
}

function shortestCompatiblePath(graph: PropositionGraph, source: string, target: string, relation: string): { nodeIds: string[]; edges: PropositionEdge[] } | undefined {
  const queue: Array<{ nodeIds: string[]; edges: PropositionEdge[] }> = [{ nodeIds: [source], edges: [] }];
  const seen = new Set([source]);
  while (queue.length) {
    const item = queue.shift()!;
    const current = item.nodeIds[item.nodeIds.length - 1]!;
    if (current === target) return item;
    if (item.edges.length >= 4) continue;
    for (const edge of graph.edges.filter(candidate => candidate.source === current || candidate.target === current)) {
      const next = edge.source === current ? edge.target : edge.source;
      if (seen.has(next)) continue;
      const compatible = relationCompatible(relation, edge.relation);
      const penalty = compatible ? 0 : 0.35;
      seen.add(next);
      queue.push({ nodeIds: [...item.nodeIds, next], edges: [...item.edges, { ...edge, support: edge.support * (compatible ? 1 : 0.55), contradiction: clamp01(edge.contradiction + penalty) }] });
    }
  }
  return undefined;
}

function chunkUnits(symbols: string[]): string[][] {
  const out: string[][] = [];
  let current: string[] = [];
  for (const symbol of symbols) {
    if (/^[,.;:!?]$/u.test(symbol)) {
      if (current.length) out.push(current);
      current = [];
      continue;
    }
    current.push(symbol);
    if (current.length >= 4 || boundarySymbol(symbol)) {
      out.push(current);
      current = [];
    }
  }
  if (current.length) out.push(current);
  return out.slice(0, 96);
}

function roleOf(unit: readonly string[], index: number): SemanticRole {
  const text = unit.join(" ");
  const shape = symbolShape(text);
  if (unit.some(symbol => /^(?:[¬!]|[-−—])+$|^[¬!]/u.test(symbol))) return "negation";
  if (unit.some(symbol => /^\p{Sc}?[\p{Number}]+(?:[.,:/_-][\p{Number}]+)*(?:[%‰])?$/u.test(symbol))) return "quantity";
  if (unit.some(symbol => /^(?:\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?|[+-]?\d+(?:\.\d+)?,[+-]?\d+(?:\.\d+)?)$/u.test(symbol))) return "time";
  if (unit.some(symbol => /^[@#][\p{Letter}\p{Number}_-]+$/u.test(symbol) || /^[+-]?\d+(?:\.\d+)?,[+-]?\d+(?:\.\d+)?$/u.test(symbol))) return "location";
  if (unit.some(symbol => /[=<>±≈∈∉∴∵→↦⇒⇐⇔∧∨⊕⊗∑∏∂∫]/u.test(symbol))) return "predicate";
  if (index > 0 && /L{3,}(?:P?L{2,})?/u.test(shape) && unit.length <= 3) return "predicate";
  if (index === 0) return "entity";
  if (text.length < 3 || /\p{Mark}/u.test(text)) return "modifier";
  return "entity";
}

function relationFor(source: PropositionNode, target: PropositionNode): string {
  if (source.role === "negation" || target.role === "negation") return "negates";
  if (source.role === "predicate" && target.role === "entity") return "acts_on";
  if (source.role === "entity" && target.role === "predicate") return "has_predicate";
  if (target.role === "time") return "temporal_scope";
  if (target.role === "location") return "spatial_scope";
  if (target.role === "quantity") return "quantifies";
  return "associates";
}

function rolesCompatible(left: SemanticRole, right: SemanticRole): boolean {
  return left === right || left === "unknown" || right === "unknown" || (left === "entity" && right === "modifier") || (left === "modifier" && right === "entity");
}

function relationCompatible(left: string, right: string): boolean {
  if (left === right) return true;
  if (left === "associates" || right === "associates") return true;
  if ((left === "has_predicate" && right === "acts_on") || (left === "acts_on" && right === "has_predicate")) return true;
  return false;
}

function graphMassForEvidence(evidenceId: EvidenceId | undefined, nodes: GraphNode[], fieldMass: Map<string, number>): number {
  if (!evidenceId) return 0;
  return mean(nodes.filter(node => node.evidenceIds.includes(evidenceId)).map(node => fieldMass.get(String(node.id)) ?? node.alpha * 0.2));
}

function contradictionFromPolarity(claimGraph: PropositionGraph, evidenceGraphs: PropositionGraph[]): number {
  const claimNeg = claimGraph.nodes.some(node => node.role === "negation");
  const evidenceNeg = evidenceGraphs.some(graph => graph.nodes.some(node => node.role === "negation"));
  return claimNeg === evidenceNeg ? 0 : 0.28;
}

function verdictFrom(input: { structuralCoverage: number; causalMass: number; faithfulnessLCB: number; contradiction: number; stability: number; missingEdges: number }): StructuralEntailmentVerdict {
  if (input.contradiction >= 0.55 && input.structuralCoverage >= 0.35) return "contradicted";
  if (input.structuralCoverage >= 0.7 && input.causalMass >= 0.08 && input.faithfulnessLCB >= 0.2 && input.contradiction <= 0.35 && input.stability >= 0.45) return "entailed";
  if (input.structuralCoverage >= 0.35 || input.faithfulnessLCB >= 0.14) return "underdetermined";
  return "unknown";
}

function boundarySymbol(symbol: string): boolean {
  return /^[;:|/\\()[\]{}]$/u.test(symbol) || /[→⇒⇔∴∵]/u.test(symbol);
}

function cosine01(a: readonly number[], b: readonly number[]): number {
  let dot = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? clamp01((dot / Math.sqrt(aa * bb) + 1) / 2) : 0;
}

function symbolShape(text: string): string {
  return [...text].map(char => /\p{Letter}/u.test(char) ? "L" : /\p{Number}/u.test(char) ? "N" : /\p{Punctuation}/u.test(char) ? "P" : /\p{Symbol}/u.test(char) ? "S" : "O").join("");
}
