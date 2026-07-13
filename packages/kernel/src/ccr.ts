import type { EvidenceSpan, FieldState, GraphEdge, GraphNode, JsonValue, SemanticEntailmentResult } from "./types.js";
import { clamp01, featureSet, mean, toJsonValue, weightedJaccard } from "./primitives.js";
import { assessStabilityAdjustedSupport, causalMinimumCoverCoding, chernoffInformation, davisKahanSinTheta, mediatorPathRedundancyPruning, subspaceDriftEntropy } from "./causal-math.js";

export interface CcrInput {
  text: string;
  evidence: EvidenceSpan[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  field: FieldState;
  entailment: SemanticEntailmentResult;
}

export interface CcrLayer1Recall {
  candidates: Array<{ evidenceId: string; score: number; reason: string }>;
  queryFeatures: string[];
  audit: JsonValue;
}

export interface CcrLayer2CausalFilter {
  survivors: Array<{ evidenceId: string; score: number; causalMass: number; supportAssessmentAccepted: boolean }>;
  prunedEdges: number;
  davisKahan: ReturnType<typeof davisKahanSinTheta>;
  chernoff: ReturnType<typeof chernoffInformation>;
  sde: ReturnType<typeof subspaceDriftEntropy>;
  minimumCover: ReturnType<typeof causalMinimumCoverCoding>;
  audit: JsonValue;
}

export interface CcrLayer3Composition {
  sentences: Array<{ text: string; evidenceIds: string[]; lcb: number; accepted: boolean }>;
  answer: string;
  abstentions: string[];
  audit: JsonValue;
}

export interface CcrResult {
  l1: CcrLayer1Recall;
  l2: CcrLayer2CausalFilter;
  l3: CcrLayer3Composition;
  accepted: boolean;
  audit: JsonValue;
}

export function createCcrEngine() {
  return {
    run(input: CcrInput): CcrResult {
      const l1 = broadRecall(input);
      const l2 = causalFilter(input, l1);
      const l3 = extractiveCompose(input, l2);
      const accepted = l3.sentences.some(sentence => sentence.accepted) && input.entailment.force !== "invented";
      return { l1, l2, l3, accepted, audit: toJsonValue({ l1: l1.audit, l2: l2.audit, l3: l3.audit, accepted }) };
    }
  };
}

function broadRecall(input: CcrInput): CcrLayer1Recall {
  const queryFeatures = featureSet(input.text, 512);
  const candidates = input.evidence
    .map(span => {
      const lexical = weightedJaccard(queryFeatures, span.features);
      const alpha = span.alpha;
      const recency = Math.exp(-Math.max(0, Date.now() - span.observedAt) / (1000 * 60 * 60 * 24 * 180));
      const score = clamp01(0.55 * lexical + 0.3 * alpha + 0.15 * recency);
      return { evidenceId: String(span.id), score, reason: `lexical=${lexical.toFixed(3)} alpha=${alpha.toFixed(3)} recency=${recency.toFixed(3)}` };
    })
    .filter(item => item.score > 0.03)
    .sort((a, b) => b.score - a.score)
    .slice(0, 80);
  return { candidates, queryFeatures, audit: toJsonValue({ candidates: candidates.length, top: candidates.slice(0, 16), queryFeatures: queryFeatures.slice(0, 64) }) };
}

function causalFilter(input: CcrInput, l1: CcrLayer1Recall): CcrLayer2CausalFilter {
  const recalled = new Set(l1.candidates.map(candidate => candidate.evidenceId));
  const recallEvidence = input.evidence.filter(span => recalled.has(String(span.id)));
  const redundancyPruning = mediatorPathRedundancyPruning({ nodes: input.nodes, edges: input.edges });
  const base = input.field.alphaTrace.normalizedLaplacian.values;
  const perturbed = input.field.alphaTrace.laplacian.values;
  const dk = davisKahanSinTheta({ base, perturbed, priorGap: Math.max(1e-6, input.field.alphaTrace.surfaces.bond) });
  const mass = input.field.ppf.map(item => item.mass);
  const teleport = input.field.seeds.map(seed => seed.weight);
  const chernoff = chernoffInformation(mass, teleport.length === mass.length ? teleport : mass);
  const sde = subspaceDriftEntropy({ previous: teleport.length === mass.length ? teleport : mass, current: mass });
  const cover = causalMinimumCoverCoding({ claimFeatures: input.entailment.claim.features, evidence: recallEvidence, maxEvidence: 10 });
  const causalByEvidence = new Map<string, number>();
  for (const node of input.nodes) {
    const nodeMass = input.field.causalMass.find(item => item.nodeId === node.id)?.mass ?? 0;
    for (const evidenceId of node.evidenceIds) causalByEvidence.set(String(evidenceId), Math.max(causalByEvidence.get(String(evidenceId)) ?? 0, nodeMass));
  }
  const survivors = recallEvidence
    .map(span => {
      const causalMass = causalByEvidence.get(String(span.id)) ?? 0;
      const supportAssessment = assessStabilityAdjustedSupport({
        supportSamples: [weightedJaccard(input.entailment.claim.features, span.features)],
        projectedSupport: causalMass,
        sinTheta: dk.sinTheta
      });
      return {
        evidenceId: String(span.id),
        score: clamp01(0.55 * (l1.candidates.find(c => c.evidenceId === String(span.id))?.score ?? 0) + 0.3 * causalMass + 0.15 * (supportAssessment.accepted ? 1 : 0)),
        causalMass,
        supportAssessmentAccepted: supportAssessment.accepted
      };
    })
    .filter(item => item.score > 0.05)
    .sort((a, b) => b.score - a.score);
  return {
    survivors,
    prunedEdges: redundancyPruning.prunedEdges.length,
    davisKahan: dk,
    chernoff,
    sde,
    minimumCover: cover,
    audit: toJsonValue({ survivors: survivors.slice(0, 32), mediatorPathRedundancyPrunedEdges: redundancyPruning.prunedEdges.length, davisKahan: dk, chernoff, sde, minimumCover: cover.audit })
  };
}

function extractiveCompose(input: CcrInput, l2: CcrLayer2CausalFilter): CcrLayer3Composition {
  const survivorIds = new Set(l2.survivors.map(item => item.evidenceId));
  const selected = input.evidence.filter(span => survivorIds.has(String(span.id))).slice(0, 6);
  const sentences = selected.flatMap(span => extractSentences(span.textPreview || span.text).slice(0, 2).map(text => {
    const lcb = assessStabilityAdjustedSupport({
      supportSamples: [weightedJaccard(input.entailment.claim.features, featureSet(text, 256))],
      projectedSupport: l2.survivors.find(item => item.evidenceId === String(span.id))?.causalMass ?? 0,
      sinTheta: l2.davisKahan.sinTheta
    }).sampledSupportLcb;
    return { text, evidenceIds: [String(span.id)], lcb, accepted: lcb >= 0.2 && input.entailment.contradiction < 0.35 };
  }));
  const accepted = sentences.filter(sentence => sentence.accepted);
  const abstentions: string[] = [];
  if (!accepted.length) abstentions.push("low-sampled-support-lcb");
  if (!l2.davisKahan.stable) abstentions.push(l2.davisKahan.reason);
  if (l2.sde.adversarialPlateau) abstentions.push(l2.sde.reason);
  const answer = accepted.length
    ? accepted.map(sentence => sentence.text).join("\n")
    : `CCR abstains from extractive composition: ${abstentions.join(", ") || "no accepted sentences"}.`;
  return { sentences, answer, abstentions, audit: toJsonValue({ sentences: sentences.length, accepted: accepted.length, abstentions, meanLcb: mean(sentences.map(sentence => sentence.lcb)) }) };
}

function extractSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map(sentence => sentence.trim()).filter(Boolean).slice(0, 20);
}
