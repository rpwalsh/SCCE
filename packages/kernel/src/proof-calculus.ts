import type { Claim, EpistemicForce, EvidenceId, EvidenceSpan, FieldState, GraphNode, Hasher, JsonValue, ProofGraphEdge, ProofGraphNode } from "./types.js";
import { clamp01, featureSet, mean, stableVector, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";
import { assessStabilityAdjustedSupport, causalMinimumCoverCoding, hoeffdingLcb } from "./causal-math.js";
import { kirchhoffBalance, maxFlowMinCut, settlePottsConsistency } from "./equation-operators.js";
import {
  aggregateSourceDependentEvidence,
  assessEvidenceSourceVector,
  type SourceDependentEvidenceMass
} from "./evidence-mass.js";

export interface EvidenceWitness {
  span: EvidenceSpan;
  support: number;
  contradiction: number;
  faithfulness: number;
  coverage: number;
  vector: number;
  field: number;
  provenance: number;
  transformations: ProofTransform[];
  intervals: { low: number; mean: number; high: number };
}

export interface ProofSemiringSummary {
  maxProductSupport: number;
  sumProductSupport: number;
  minPlusRisk: number;
  maxMinContradiction: number;
  netAdmissibility: number;
  pathCount: number;
  evidenceMass: SourceDependentEvidenceMass;
  temporalIntersection?: { validFrom: number; validTo?: number; supported: boolean };
}

export interface ProofTransform {
  id: string;
  label: string;
  input: string;
  output: string;
  confidence: number;
}

export interface ProofCalculusResult {
  support: number;
  contradiction: number;
  faithfulnessLcb: number;
  force: EpistemicForce;
  witnesses: EvidenceWitness[];
  contradictions: EvidenceWitness[];
  boundaries: string[];
  transformIds: string[];
  proofGraph: { nodes: ProofGraphNode[]; edges: ProofGraphEdge[] };
  scores: Record<string, unknown>;
  evidenceIds: EvidenceId[];
}

export function createProofCalculus(options: { hasher: Hasher }) {
  return {
    evaluate(input: { claim: Claim; evidence: EvidenceSpan[]; nodes: GraphNode[]; field: FieldState }): ProofCalculusResult {
      const nodeMass = new Map(input.field.ppf.map(item => [String(item.nodeId), item.mass]));
      const witnesses = input.evidence.map(span => witness(input.claim, span, input.nodes, nodeMass, options.hasher)).sort((a, b) => b.support - a.support).slice(0, 16);
      const supportCandidates = witnesses.filter(item => item.support > 0.08);
      const contradictionCandidates = witnesses.filter(item => item.contradiction > 0.12);
      const supporting = supportCandidates.filter(item => item.provenance > 0);
      const contradictions = contradictionCandidates.filter(item => item.provenance > 0);
      const semiring = aggregateProofSemiring({
        supporting: supportCandidates,
        contradictions: contradictionCandidates
      });
      const weightedSupport = clamp01(semiring.evidenceMass.belief * 0.7 + input.field.alphaTrace.surfaces.pressure * 0.18 + mean(input.field.causalMass.slice(0, 8).map(item => item.mass)) * 0.12);
      const preliminarySupport = clamp01(Math.max(weightedSupport, semiring.netAdmissibility * 0.9));
      const weightedContradiction = clamp01(semiring.evidenceMass.contradictionRatio + input.field.alphaTrace.contradictionMass * 0.45 + input.field.alphaTrace.surfaces.risk * 0.1);
      const preliminaryContradiction = clamp01(Math.max(weightedContradiction, semiring.maxMinContradiction));
      const faithfulnessLcb = hoeffdingLcb(supporting.map(item => item.faithfulness), 0.05);
      const cover = causalMinimumCoverCoding({ claimFeatures: input.claim.features, evidence: supporting.map(item => item.span), maxEvidence: 8 });
      const preliminaryGraph = graph(input.claim, supporting, contradictions, input.field, []);
      const proofOperators = proofOperatorSummary(preliminaryGraph, String(input.claim.id));
      const support = clamp01(preliminarySupport * 0.84 + proofOperators.flow.normalizedFlowRatio * 0.16);
      const contradiction = clamp01(Math.max(
        preliminaryContradiction,
        proofOperators.consistency.contradictionPressure * 0.42,
        proofOperators.kirchhoff.totalImbalance * 0.18
      ));
      const supportAssessment = assessStabilityAdjustedSupport({
        supportSamples: supporting.map(item => item.faithfulness),
        projectedSupport: support,
        sinTheta: input.field.alphaTrace.surfaces.drift
      });
      const force = forceFrom(
        supportAssessment.stabilityAdjustedSupport,
        contradiction,
        Math.max(faithfulnessLcb, supportAssessment.sampledSupportLcb),
        semiring.evidenceMass.independentGroupCount,
        input.field.alphaTrace.bondedLeakage
      );
      const boundaries = [
        ...boundaryReasons({
          force,
          support,
          contradiction,
          faithfulnessLcb,
          evidenceCount: supporting.length,
          candidateEvidenceCount: new Set([...supportCandidates, ...contradictionCandidates].map(item => String(item.span.id))).size,
          independentGroupCount: semiring.evidenceMass.independentGroupCount,
          sourceVectorCoverage: semiring.evidenceMass.sourceVectorCoverage,
          leakage: input.field.alphaTrace.bondedLeakage,
          supportAssessmentAccepted: supportAssessment.accepted,
          cover: cover.coverage
        }),
        ...operatorBoundaryReasons(proofOperators)
      ];
      const proofGraph = graph(input.claim, supporting, contradictions, input.field, boundaries);
      const transformIds = [...new Set([
        ...supporting.flatMap(item => item.transformations.map(t => t.id)),
        "alpha-field",
        "personalized-perron-frobenius",
        "hoeffding-lcb",
        "stability-adjusted-support-assessment",
        "causal-minimum-cover"
      ])];
      return {
        support,
        contradiction,
        faithfulnessLcb,
        force,
        witnesses: supporting,
        contradictions,
        boundaries,
        transformIds,
        proofGraph,
        scores: {
          witnesses: witnesses.map(item => ({
            evidenceId: item.span.id,
            support: item.support,
            contradiction: item.contradiction,
            faithfulness: item.faithfulness,
            coverage: item.coverage,
            vector: item.vector,
            field: item.field,
            provenance: item.provenance,
            intervals: item.intervals,
            transforms: item.transformations.map(t => t.id)
          })),
          semiring,
          proofOperators,
          supportAssessment,
          causalMinimumCover: cover.audit,
          alphaSurfaces: input.field.alphaTrace.surfaces,
          bondedLeakage: input.field.alphaTrace.bondedLeakage
        },
        evidenceIds: supporting.map(item => item.span.id)
      };
    }
  };
}

function proofOperatorSummary(proofGraph: { nodes: ProofGraphNode[]; edges: ProofGraphEdge[] }, claimId: string) {
  const nodeIds = proofGraph.nodes.map(node => node.id);
  const supportEdges = proofGraph.edges.filter(edge => edge.relation === "supports");
  const sourceId = "proof.operator.source";
  const maxFlow = maxFlowMinCut({
    nodes: [sourceId, ...nodeIds],
    edges: [
      ...proofGraph.nodes
        .filter(node => node.kind === "evidence")
        .map(node => ({ source: sourceId, target: node.id, capacity: 1, id: `source:${node.id}` })),
      ...supportEdges.map((edge, index) => ({ source: edge.source, target: edge.target, capacity: clamp01(edge.weight), id: `support:${index}` }))
    ],
    source: sourceId,
    sink: claimId
  });
  const kirchhoff = kirchhoffBalance({
    nodes: nodeIds,
    flows: proofGraph.edges.map(edge => ({ source: edge.source, target: edge.target, amount: clamp01(edge.weight) }))
  });
  const consistency = settlePottsConsistency({
    nodes: nodeIds,
    edges: proofGraph.edges.map(edge => ({
      source: edge.source,
      target: edge.target,
      coupling: clamp01(edge.weight),
      oppose: edge.relation === "contradicts"
    })),
    stateCount: 2,
    iterations: 12
  });
  return { flow: maxFlow, kirchhoff, consistency };
}

function operatorBoundaryReasons(input: ReturnType<typeof proofOperatorSummary>): string[] {
  const reasons: string[] = [];
  if (input.flow.unmetFlowRatio > 0.62) reasons.push("proof.operator.flow_shortfall");
  if (input.kirchhoff.totalImbalance > 0.72) reasons.push("proof.operator.conservation_pressure");
  if (input.consistency.contradictionPressure > 0.32) reasons.push("proof.operator.consistency_pressure");
  return reasons;
}

function witness(claim: Claim, span: EvidenceSpan, nodes: GraphNode[], nodeMass: Map<string, number>, hasher: Hasher): EvidenceWitness {
  const transforms = transformations(claim, span);
  const coverage = directionalCoverage(claim.features, span.features);
  const vector = Math.max(0, stableDot(claim.features, span.features, hasher));
  const supportNodes = nodes.filter(node => node.evidenceIds.includes(span.id));
  const field = mean(supportNodes.map(node => nodeMass.get(String(node.id)) ?? 0));
  const faithfulness = faithfulnessWindows(claim, span);
  const contradiction = contradictionScore(claim, span);
  const provenance = provenanceScore(span);
  const transformScore = mean(transforms.map(transform => transform.confidence));
  const support = clamp01(0.22 * coverage + 0.15 * vector + 0.18 * field + 0.2 * faithfulness + 0.15 * provenance + 0.1 * transformScore - 0.4 * contradiction);
  const radius = Math.sqrt(Math.log(20) / (2 * Math.max(1, transforms.length + supportNodes.length + 1)));
  return {
    span,
    support,
    contradiction,
    faithfulness,
    coverage,
    vector,
    field,
    provenance,
    transformations: transforms,
    intervals: { low: clamp01(support - radius), mean: support, high: clamp01(support + radius) }
  };
}

export function aggregateProofSemiring(input: {
  supporting: readonly EvidenceWitness[];
  contradictions?: readonly EvidenceWitness[];
}): ProofSemiringSummary {
  const evidenceMass = aggregateSourceDependentEvidence(input);
  const sourcePathByGroup = new Map<string, number>();
  for (const item of input.supporting) {
    const source = assessEvidenceSourceVector(item.span);
    if (!source.independenceGroup) continue;
    const path = pathProductSupport(item);
    if (path <= 0) continue;
    sourcePathByGroup.set(
      source.independenceGroup,
      Math.max(sourcePathByGroup.get(source.independenceGroup) ?? 0, path)
    );
  }
  const paths = [...sourcePathByGroup.values()];
  const maxProductSupport = paths.length ? Math.max(...paths) : 0;
  const sumProductSupport = paths.length ? clamp01(1 - paths.reduce((product, value) => product * (1 - clamp01(value)), 1)) : 0;
  const allContradictions = [...input.supporting, ...(input.contradictions ?? [])].filter(item => item.provenance > 0);
  const maxMinContradiction = allContradictions.length
    ? clamp01(Math.max(...allContradictions.map(item => Math.min(clamp01(item.contradiction), Math.max(clamp01(item.support), clamp01(item.provenance), 0.01)))))
    : 0;
  const sourceWeightedSupporting = input.supporting.filter(item => item.provenance > 0);
  const minPlusRisk = sourceWeightedSupporting.length
    ? Math.min(...sourceWeightedSupporting.map(item => -Math.log(Math.max(1e-12, pathProductSupport(item))) + clamp01(item.contradiction) + (1 - clamp01(item.faithfulness))))
    : Number.POSITIVE_INFINITY;
  const temporalIntersection = temporalIntersectionFor(sourceWeightedSupporting.map(item => item.span));
  return {
    maxProductSupport,
    sumProductSupport,
    minPlusRisk,
    maxMinContradiction,
    netAdmissibility: clamp01(evidenceMass.belief - evidenceMass.contradictionRatio),
    pathCount: paths.length,
    evidenceMass,
    ...(temporalIntersection ? { temporalIntersection } : {})
  };
}

function pathProductSupport(witness: EvidenceWitness): number {
  if (witness.provenance <= 0) return 0;
  const transform = witness.transformations.length ? Math.max(...witness.transformations.map(item => clamp01(item.confidence))) : 1;
  const factors = [
    witness.coverage,
    witness.vector,
    witness.faithfulness,
    witness.provenance,
    transform
  ].map(clamp01).filter(value => value > 0);
  if (witness.field > 0) factors.push(clamp01(witness.field));
  return clamp01(factors.reduce((product, value) => product * value, 1));
}

function temporalIntersectionFor(spans: readonly EvidenceSpan[]): ProofSemiringSummary["temporalIntersection"] {
  const intervals = spans.map(temporalValidityInterval).filter((item): item is { validFrom: number; validTo?: number } => Boolean(item));
  if (!intervals.length || intervals.length !== spans.length) return undefined;
  const validFrom = Math.max(...intervals.map(item => item.validFrom));
  const boundedEnds = intervals.map(item => item.validTo).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const validTo = boundedEnds.length ? Math.min(...boundedEnds) : undefined;
  const supported = validTo === undefined || validFrom <= validTo;
  return validTo === undefined ? { validFrom, supported } : { validFrom, validTo, supported };
}

function temporalValidityInterval(span: EvidenceSpan): { validFrom: number; validTo?: number } | undefined {
  const provenance = span.provenance;
  if (!provenance || typeof provenance !== "object" || Array.isArray(provenance)) return undefined;
  const record = provenance as Record<string, JsonValue>;
  const validFrom = firstFiniteNumber(record.validFrom, record.tStart, record.timeStart, record.valid_start);
  const validTo = firstFiniteNumber(record.validTo, record.tEnd, record.timeEnd, record.valid_end);
  if (validFrom === undefined && validTo === undefined) return undefined;
  return { validFrom: validFrom ?? Number.NEGATIVE_INFINITY, ...(validTo === undefined ? {} : { validTo }) };
}

function firstFiniteNumber(...values: readonly (JsonValue | undefined)[]): number | undefined {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim()) {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) return parsed;
      const numeric = Number(value);
      if (Number.isFinite(numeric)) return numeric;
    }
  }
  return undefined;
}

function transformations(claim: Claim, span: EvidenceSpan): ProofTransform[] {
  const claimSymbols = symbolizeData(claim.normalized);
  const spanSymbols = symbolizeData(span.text);
  const transforms: ProofTransform[] = [
    { id: "claim-normalize", label: "Claim normalization", input: claim.text, output: claim.normalized, confidence: claim.normalized ? 0.9 : 0.2 },
    { id: "evidence-window", label: "Best evidence window", input: span.textPreview, output: bestWindow(claim, span), confidence: faithfulnessWindows(claim, span) },
    { id: "directional-coverage", label: "Directional coverage", input: claimSymbols.join(" "), output: spanSymbols.filter(symbol => claimSymbols.includes(symbol)).join(" "), confidence: directionalCoverage(claim.features, span.features) }
  ];
  if (claim.polarity !== polarityOf(span.text)) transforms.push({ id: "polarity-conflict", label: "Polarity conflict", input: claim.text, output: span.textPreview, confidence: contradictionScore(claim, span) });
  return transforms;
}

function graph(claim: Claim, supporting: EvidenceWitness[], contradictions: EvidenceWitness[], field: FieldState, boundaries: string[]): { nodes: ProofGraphNode[]; edges: ProofGraphEdge[] } {
  const nodes: ProofGraphNode[] = [{ id: String(claim.id), kind: "claim", label: claim.text.slice(0, 140), metadata: { polarity: claim.polarity, normalized: claim.normalized } }];
  const edges: ProofGraphEdge[] = [];
  for (const item of supporting) {
    const evidenceNode = `evidence:${item.span.id}`;
    nodes.push({ id: evidenceNode, kind: "evidence", label: item.span.textPreview, metadata: { sourceVersionId: item.span.sourceVersionId, support: item.support, faithfulness: item.faithfulness, intervals: item.intervals } });
    edges.push({ source: evidenceNode, target: String(claim.id), relation: "supports", weight: item.support, evidenceIds: [item.span.id] });
    for (const transform of item.transformations) {
      const transformNode = `transform:${transform.id}:${item.span.id}`;
      nodes.push({ id: transformNode, kind: "transform", label: transform.label, metadata: toJsonValue(transform) });
      edges.push({ source: evidenceNode, target: transformNode, relation: "transforms", weight: transform.confidence, evidenceIds: [item.span.id] });
      edges.push({ source: transformNode, target: String(claim.id), relation: "supports", weight: transform.confidence * item.support, evidenceIds: [item.span.id] });
    }
  }
  for (const item of contradictions) {
    const node = `contradiction:${item.span.id}`;
    nodes.push({ id: node, kind: "contradiction", label: item.span.textPreview, metadata: { contradiction: item.contradiction, intervals: item.intervals } });
    edges.push({ source: node, target: String(claim.id), relation: "contradicts", weight: item.contradiction, evidenceIds: [item.span.id] });
  }
  nodes.push({ id: "field:alpha", kind: "field", label: "alpha field support and contradiction surfaces", metadata: field.alphaTrace.surfaces });
  edges.push({ source: "field:alpha", target: String(claim.id), relation: "bounds", weight: field.alphaTrace.surfaces.pressure, evidenceIds: supporting.map(item => item.span.id) });
  for (const reason of boundaries) {
    const id = `boundary:${reason}`;
    nodes.push({ id, kind: "boundary", label: reason, metadata: {} });
    edges.push({ source: id, target: String(claim.id), relation: "bounds", weight: 1, evidenceIds: [] });
  }
  return { nodes: dedupeNodes(nodes), edges };
}

function directionalCoverage(claimFeatures: string[], evidenceFeatures: string[]): number {
  const evidence = new Set(evidenceFeatures);
  const claimSymbols = claimFeatures.filter(f => f.startsWith("sym:"));
  if (claimSymbols.length === 0) return 0;
  return claimSymbols.filter(feature => evidence.has(feature)).length / claimSymbols.length;
}

function stableDot(a: string[], b: string[], hasher: Hasher): number {
  const va = stableVector(a, hasher, 96);
  const vb = stableVector(b, hasher, 96);
  return va.reduce((sum, value, i) => sum + value * (vb[i] ?? 0), 0);
}

function faithfulnessWindows(claim: Claim, span: EvidenceSpan): number {
  const symbols = symbolizeData(span.text);
  const windows: string[][] = [];
  const size = Math.max(24, Math.ceil(symbols.length / 6));
  for (let i = 0; i < symbols.length; i += size) windows.push(symbols.slice(i, i + size));
  const scores = windows.map(window => weightedJaccard(claim.features, featureSet(window.join(" "), 512)));
  return scores.length ? Math.max(...scores) : 0;
}

function bestWindow(claim: Claim, span: EvidenceSpan): string {
  const symbols = symbolizeData(span.text);
  const size = Math.max(24, Math.ceil(symbols.length / 6));
  let best = "";
  let score = -1;
  for (let i = 0; i < symbols.length; i += size) {
    const window = symbols.slice(i, i + size).join(" ");
    const s = weightedJaccard(claim.features, featureSet(window, 512));
    if (s > score) {
      score = s;
      best = window;
    }
  }
  return best.slice(0, 500);
}

function provenanceScore(span: EvidenceSpan): number {
  return assessEvidenceSourceVector(span).sourceWeight;
}

function contradictionScore(claim: Claim, span: EvidenceSpan): number {
  const overlap = directionalCoverage(claim.features, span.features);
  const polarity = polarityOf(span.text);
  return claim.polarity !== polarity && overlap > 0.12 ? clamp01(overlap) : 0;
}

function polarityOf(text: string): number {
  const symbols = symbolizeData(text);
  const explicitSymbolNegation = symbols.some(symbol => /^(?:[¬!]|[-−—])+$|^[¬!]/u.test(symbol));
  const operatorNegation = /(?:!=|≠|∉|⊄|⊅|¬|⊬|⊭)/u.test(text);
  return explicitSymbolNegation || operatorNegation ? -1 : 1;
}

function forceFrom(support: number, contradiction: number, lcb: number, independentGroupCount: number, leakage: number): EpistemicForce {
  if (contradiction > 0.45 || leakage > 0.72) return "unknown";
  if (support >= 0.82 && lcb >= 0.62 && independentGroupCount >= 2) return "proved";
  if (support >= 0.62 && lcb >= 0.36) return "observed";
  if (support >= 0.34) return "inferred";
  if (support >= 0.12) return "conjectured";
  return "invented";
}

function boundaryReasons(input: {
  force: EpistemicForce;
  support: number;
  contradiction: number;
  faithfulnessLcb: number;
  evidenceCount: number;
  candidateEvidenceCount: number;
  independentGroupCount: number;
  sourceVectorCoverage: number;
  leakage: number;
  supportAssessmentAccepted: boolean;
  cover: number;
}): string[] {
  const out: string[] = [];
  if (input.evidenceCount === 0) out.push("no-promoted-evidence");
  if (input.candidateEvidenceCount > 0 && input.sourceVectorCoverage < 1) out.push("incomplete-source-trust-vector");
  if (input.evidenceCount > 1 && input.independentGroupCount < 2) out.push("source-dependence-not-corroboration");
  if (input.faithfulnessLcb < 0.2) out.push("low-hoeffding-faithfulness-lcb");
  if (!input.supportAssessmentAccepted) out.push("stability-adjusted-support-rejected");
  if (input.cover < 0.5) out.push("causal-minimum-cover-incomplete");
  if (input.contradiction > 0.2) out.push("contradiction-pressure");
  if (input.force === "invented") out.push("creative-or-structural-invention-not-proof");
  if (input.support < 0.12) out.push("low-causal-mass");
  if (input.leakage > 0.5) out.push("bonded-leakage");
  return out;
}

function dedupeNodes(nodes: ProofGraphNode[]): ProofGraphNode[] {
  const seen = new Set<string>();
  const out: ProofGraphNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}
