import type { Claim, ConstructGraph, EvidenceSpan, FieldState, GraphNode, Hasher, SemanticEntailmentResult } from "./types.js";
import type { IdFactory } from "./ids.js";
import { featureSet, toJsonValue, symbolizeData } from "./primitives.js";
import { createProofCalculus } from "./proof-calculus.js";
import { createSemanticGraphEntailment } from "./semantic-graph.js";
import { evaluateSemanticObligations } from "./semantic-obligations.js";
import { evidenceProofBoundary } from "./proof-boundary.js";
import { constructToProofClaims, evidenceToProofRecords, type SupportedProofObservation } from "./semantic-proof-adapter.js";
import { proveClaim, type ProofClaim, type ProofEvidenceRecord, type ProofForceClass, type SemanticProofResult } from "./semantic-proof-engine.js";
import { truthStateFromProofVerdict } from "./truth-contract.js";
import { CALIBRATION_IDS, CALIBRATION_TASK_CLASS_IDS, calibrateRuntimeScore, type CalibrationModelSet } from "./calibration-spine.js";

const VALIDATOR_VERSION = "scce3-obligation-structural-alpha-causal-entailment-v4";

export function createSemanticEntailmentEngine(options: { idFactory: IdFactory; hasher: Hasher }) {
  const calculus = createProofCalculus({ hasher: options.hasher });
  const structural = createSemanticGraphEntailment(options);
  return {
    check(input: {
      text: string;
      evidence: EvidenceSpan[];
      nodes: GraphNode[];
      field: FieldState;
      createdAt: number;
      construct?: ConstructGraph;
      typedObservations?: SupportedProofObservation[];
      proofClaims?: ProofClaim[];
      proofEvidence?: ProofEvidenceRecord[];
      sourceExcerpts?: Array<{ text: string; evidenceId: EvidenceSpan["id"] }>;
      calibrationModels?: CalibrationModelSet;
    }): SemanticEntailmentResult {
      const claim = claimFrom(input.text, options.idFactory);
      const proofBoundaries = input.evidence.map(evidenceProofBoundary);
      const certifyingEvidenceIds = new Set(proofBoundaries.filter(item => item.certifiesFactualProof).map(item => item.evidenceId));
      const certifyingEvidence = input.evidence.filter(span => certifyingEvidenceIds.has(String(span.id)));
      const excludedProofEvidence = proofBoundaries.filter(item => !item.certifiesFactualProof);
      const result = calculus.evaluate({ claim, evidence: certifyingEvidence, nodes: input.nodes, field: input.field });
      const structuralResult = structural.check({ claim, evidence: certifyingEvidence, nodes: input.nodes, field: input.field });
      const obligations = evaluateSemanticObligations({ claim, evidence: input.evidence, nodes: input.nodes, field: input.field, hasher: options.hasher });
      const proofGate = structuredProofGate({
        requestClaim: claim,
        evidence: input.evidence,
        nodes: input.nodes,
        construct: input.construct,
        typedObservations: input.typedObservations,
        proofClaims: input.proofClaims,
        proofEvidence: input.proofEvidence,
        hasher: options.hasher
      })
        ?? exactTextProofGate({ claim, evidence: input.evidence, hasher: options.hasher })
        ?? sourceExcerptProofGate({ claim, evidence: input.evidence, excerpts: input.sourceExcerpts, hasher: options.hasher });
      const semanticVerdict = verdictWithProofGate(obligations.verdict, proofGate);
      const truthState = proofGate ? proofGate.truthState : truthStateFromProofVerdict("insufficient_evidence");
      const structuralSupport = structuralResult.structuralCoverage * 0.34 + structuralResult.causalMass * 0.27 + structuralResult.faithfulnessLCB * 0.21 + structuralResult.stability * 0.18;
      const rawSupport = proofGateSupport(proofGate, proofSupportFromObligations(semanticVerdict, obligations.support, structuralSupport, result.support));
      const rawContradiction = Math.max(result.contradiction, structuralResult.contradiction, obligations.contradiction, proofGate?.verdict === "contradicted" ? 0.72 : 0);
      const supportCalibration = calibrateRuntimeScore({
        raw: rawSupport,
        calibrationId: CALIBRATION_IDS.proofSupport,
        taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
        modelSet: input.calibrationModels,
        meaning: "calibrated proof support",
        provenance: ["entailment.ts:check"],
        inputs: ["obligations.support", "structuralSupport", "calculusSupport", "proofGate"]
      });
      const contradictionAvoidanceCalibration = calibrateRuntimeScore({
        raw: 1 - rawContradiction,
        calibrationId: CALIBRATION_IDS.proofContradiction,
        taskClass: CALIBRATION_TASK_CLASS_IDS.sourceBoundQa,
        modelSet: input.calibrationModels,
        meaning: "calibrated contradiction avoidance",
        provenance: ["entailment.ts:check"],
        inputs: ["obligations.contradiction", "structuralContradiction", "calculusContradiction", "proofGate"]
      });
      const support = supportCalibration.value;
      const contradiction = 1 - contradictionAvoidanceCalibration.value;
      const faithfulnessLcb = Math.max(result.faithfulnessLcb, structuralResult.faithfulnessLCB, obligations.faithfulnessLcb);
      const force = forceFromSemantic(semanticVerdict, structuralResult.verdict, result.force, support, contradiction, faithfulnessLcb, obligations.scores.stability);
      const structuralEvidenceIds = [...new Set(structuralResult.proofPaths.flatMap(path => path.evidenceIds))];
      const certifiedGateEvidenceIds = certifiedGateEvidenceSpanIds(proofGate);
      const gatedEvidenceIds = certifiedGateEvidenceIds ? input.evidence.filter(span => certifiedGateEvidenceIds.has(String(span.id))).map(span => span.id) : undefined;
      const evidenceIds = gatedEvidenceIds ?? [...new Set([...result.evidenceIds, ...structuralEvidenceIds, ...obligations.evidenceIds])];
      const transformIds = [...new Set([...result.transformIds, "structural-proposition-graph", "alpha-causal-entailment", "typed-proof-obligations", ...obligations.transforms.map(item => item.id)])];
      const proofId = options.idFactory.proofId({ claimId: claim.id, evidenceIds, transforms: transformIds, validatorVersion: VALIDATOR_VERSION });
      const confidence = {
        verdict: semanticVerdict,
        support,
        contradiction,
        faithfulnessLcb,
        supportingEvidence: evidenceIds.length,
        sourceVersions: obligations.sourceVersionIds.map(String),
        structuralCoverage: obligations.scores.structuralCoverage,
        roleCoverage: obligations.scores.roleCoverage,
        relationCompatibility: obligations.scores.relationCompatibility,
        transformationSupport: obligations.scores.transformationSupport,
        causalMass: obligations.scores.causalMass,
        stability: obligations.scores.stability,
        satisfiedObligations: obligations.obligations.filter(item => item.required && item.status === "satisfied").length,
        requiredObligations: obligations.obligations.filter(item => item.required).length
      } satisfies SemanticEntailmentResult["confidence"];
      return {
        claim,
        verdict: semanticVerdict,
        semanticVerdict,
        truthState,
        force,
        support,
        contradiction,
        faithfulnessLcb,
        confidence,
        scores: obligations.scores,
        obligations: obligations.obligations,
        mappings: obligations.mappings,
        transforms: obligations.transforms,
        counterexamples: obligations.counterexamples,
        missing: obligations.missing,
        proof: {
          id: proofId,
          claimId: claim.id,
          verdict: force,
          confidence: toJsonValue({ ...confidence, structuralVerdict: structuralResult.verdict, calculusForce: result.force, structuralSupport, proofBoundary: { certifyingEvidence: certifyingEvidence.length, excludedProofEvidence }, semanticProofEngine: proofGate }),
          proofGraph: {
            nodes: [
              ...result.proofGraph.nodes,
              { id: structuralResult.claimGraph.id, kind: "claim", label: "structural claim graph", metadata: structuralResult.claimGraph as unknown as import("./types.js").JsonValue },
              ...structuralResult.evidenceGraphs.map(graph => ({ id: graph.id, kind: "evidence" as const, label: "structural evidence graph", metadata: graph as unknown as import("./types.js").JsonValue })),
              ...obligations.proofGraph.nodes
            ],
            edges: [
              ...result.proofGraph.edges,
              ...structuralResult.proofPaths.map(path => ({ source: path.evidencePath[0] ?? structuralResult.claimGraph.id, target: structuralResult.claimGraph.id, relation: "supports" as const, weight: path.support, evidenceIds: path.evidenceIds })),
              ...obligations.proofGraph.edges
            ]
          },
          evidenceIds,
          transformIds,
          scores: { ...result.scores, structuralEntailment: structuralResult.audit, semanticObligations: obligations.audit, semanticScores: toJsonValue(obligations.scores), mappings: toJsonValue(obligations.mappings), transforms: toJsonValue(obligations.transforms), counterexamples: toJsonValue(obligations.counterexamples), missing: toJsonValue(obligations.missing), proofBoundary: toJsonValue({ certifyingEvidence: certifyingEvidence.length, excludedProofEvidence }), semanticProofEngine: proofGate ? toJsonValue(proofGate) : null, calibration: toJsonValue({ support: supportCalibration, contradictionAvoidance: contradictionAvoidanceCalibration }) },
          validatorVersion: VALIDATOR_VERSION,
          createdAt: input.createdAt
        },
        evidenceIds,
        boundaries: [...new Set([...result.boundaries, ...obligations.boundaries, ...excludedProofEvidence.map(item => item.reason), ...proofGateBoundaries(proofGate), ...structuralResult.missingEdges.map(edge => `missing-structural-edge:${edge}`), ...(structuralResult.verdict === "contradicted" ? ["structural-contradiction"] : [])])]
      };
    }
  };
}

function proofSupportFromObligations(semanticVerdict: string, obligationSupport: number, structuralSupport: number, calculusSupport: number): number {
  if (semanticVerdict === "contradicted") return Math.min(0.24, obligationSupport);
  if (semanticVerdict === "entailed") return Math.max(obligationSupport, Math.min(0.12 + structuralSupport * 0.32 + calculusSupport * 0.18, obligationSupport + 0.14));
  if (semanticVerdict === "underdetermined") return Math.min(0.54, 0.76 * obligationSupport + 0.16 * structuralSupport + 0.08 * calculusSupport);
  return Math.min(0.28, 0.82 * obligationSupport + 0.12 * structuralSupport + 0.06 * calculusSupport);
}

function forceFromSemantic(semanticVerdict: string, structuralVerdict: string, prior: SemanticEntailmentResult["force"], support: number, contradiction: number, faithfulnessLcb: number, stability: number): SemanticEntailmentResult["force"] {
  if (semanticVerdict === "contradicted" || structuralVerdict === "contradicted" || contradiction > 0.52) return "unknown";
  if (semanticVerdict === "entailed" && structuralVerdict === "entailed" && support >= 0.78 && faithfulnessLcb >= 0.42 && stability >= 0.55) return "proved";
  if (semanticVerdict === "entailed" && support >= 0.56) return "observed";
  if ((semanticVerdict === "underdetermined" || structuralVerdict === "underdetermined") && support >= 0.34) return "inferred";
  return prior === "invented" || prior === "conjectured" ? prior : "unknown";
}

function exactTextProofGate(input: { claim: Claim; evidence: EvidenceSpan[]; hasher: Hasher }): SemanticProofResult | undefined {
  const claimTextId = textIdentity(input.claim.normalized, input.hasher);
  const exactEvidence = input.evidence.filter(span => textIdentity(normalizedText(span.text || span.textPreview), input.hasher) === claimTextId);
  if (!exactEvidence.length) return undefined;
  const candidateEvidence: ProofEvidenceRecord[] = exactEvidence.map(span => {
    const boundary = evidenceProofBoundary(span);
    const forceClass = proofForceClassFromBoundary(boundary.forceClass);
    const textId = textIdentity(normalizedText(span.text || span.textPreview), input.hasher);
    const certifyingDirectSpan = forceClass === "direct_evidence" && boundary.certifiesFactualProof;
    return {
      id: String(span.id),
      forceClass,
      sourceVersionId: String(span.sourceVersionId),
      evidenceSpanId: certifyingDirectSpan ? String(span.id) : undefined,
      subject: { id: "proof.atom.claim_text", kindId: "proof.atom.text" },
      relationId: "relation.test.has_value",
      object: { id: textId, kindId: "proof.atom.text" },
      polarityId: input.claim.polarity < 0 ? "polarity.negative" : "polarity.positive",
      modalityId: "modality.asserted"
    };
  });
  return proveClaim({
    claim: {
      id: String(input.claim.id),
      subject: { id: "proof.atom.claim_text", kindId: "proof.atom.text" },
      relationId: "relation.test.has_value",
      object: { id: claimTextId, kindId: "proof.atom.text" },
      polarityId: input.claim.polarity < 0 ? "polarity.negative" : "polarity.positive",
      modalityId: "modality.asserted",
      requiredSourceBinding: true
    },
    candidateEvidence
  });
}

function sourceExcerptProofGate(input: {
  claim: Claim;
  evidence: EvidenceSpan[];
  excerpts?: Array<{ text: string; evidenceId: EvidenceSpan["id"] }>;
  hasher: Hasher;
}): SemanticProofResult | undefined {
  if (!input.excerpts?.length) return undefined;
  const normalizedExcerpts = input.excerpts.map(excerpt => normalizedText(excerpt.text)).filter(Boolean);
  if (!normalizedExcerpts.length || normalizedText(normalizedExcerpts.join(" ")) !== input.claim.normalized) return undefined;
  const evidenceById = new Map(input.evidence.map(span => [String(span.id), span]));
  const verified = new Map<string, EvidenceSpan>();
  for (const excerpt of input.excerpts) {
    const span = evidenceById.get(String(excerpt.evidenceId));
    if (!span || !evidenceProofBoundary(span).certifiesFactualProof) return undefined;
    const excerptText = normalizedText(excerpt.text);
    if (!excerptText || !normalizedText(span.text || span.textPreview).includes(excerptText)) return undefined;
    verified.set(String(span.id), span);
  }
  const claimTextId = textIdentity(input.claim.normalized, input.hasher);
  const candidateEvidence: ProofEvidenceRecord[] = [...verified.values()].map(span => ({
    id: String(span.id),
    forceClass: "direct_evidence",
    sourceVersionId: String(span.sourceVersionId),
    evidenceSpanId: String(span.id),
    subject: { id: "proof.atom.claim_text", kindId: "proof.atom.text" },
    relationId: "relation.test.has_value",
    object: { id: claimTextId, kindId: "proof.atom.text" },
    polarityId: input.claim.polarity < 0 ? "polarity.negative" : "polarity.positive",
    modalityId: "modality.asserted"
  }));
  return proveClaim({
    claim: {
      id: String(input.claim.id),
      subject: { id: "proof.atom.claim_text", kindId: "proof.atom.text" },
      relationId: "relation.test.has_value",
      object: { id: claimTextId, kindId: "proof.atom.text" },
      polarityId: input.claim.polarity < 0 ? "polarity.negative" : "polarity.positive",
      modalityId: "modality.asserted",
      requiredSourceBinding: true
    },
    candidateEvidence
  });
}

function structuredProofGate(input: {
  requestClaim: Claim;
  evidence: EvidenceSpan[];
  nodes: GraphNode[];
  construct?: ConstructGraph;
  typedObservations?: SupportedProofObservation[];
  proofClaims?: ProofClaim[];
  proofEvidence?: ProofEvidenceRecord[];
  hasher: Hasher;
}): SemanticProofResult | undefined {
  const candidateEvidence = dedupeProofEvidence([
    ...(input.proofEvidence ?? []),
    ...evidenceToProofRecords({ evidence: input.evidence, nodes: input.nodes, observations: input.typedObservations ?? [] })
  ]);
  if (!candidateEvidence.length) return undefined;
  const claims = dedupeProofClaims([
    ...(input.proofClaims ?? []),
    ...(input.construct ? constructToProofClaims({ construct: input.construct }) : [])
  ]);
  if (!claims.length) return undefined;
  const results = claims.map(proofClaim => ({
    claim: proofClaim,
    result: proveClaim({ claim: proofClaim, candidateEvidence }),
    proposalScore: structuredClaimProposalScore(input.requestClaim, proofClaim, candidateEvidence, input.hasher)
  }));
  const selected = rankProofResults(results)[0];
  return selected ? withStructuredEvidenceBindings(selected.result, candidateEvidence, selected.claim, selected.proposalScore) : undefined;
}

function rankProofResults(results: ReadonlyArray<{ claim: ProofClaim; result: SemanticProofResult; proposalScore: number }>): Array<{ claim: ProofClaim; result: SemanticProofResult; proposalScore: number }> {
  return [...results].sort((left, right) =>
    proofRank(right.result) - proofRank(left.result) ||
    right.proposalScore - left.proposalScore ||
    right.result.certifiedEvidenceIds.length - left.result.certifiedEvidenceIds.length ||
    left.claim.id.localeCompare(right.claim.id)
  );
}

function proofRank(result: SemanticProofResult): number {
  if (result.verdict === "contradicted") return 60;
  if (result.verdict === "certified") return 50;
  if (result.verdict === "ambiguous") return 40;
  if (result.verdict === "source_bound_only") return 30;
  if (result.verdict === "unsupported_prior_only") return 20;
  return 10;
}

function structuredClaimProposalScore(requestClaim: Claim, proofClaim: ProofClaim, records: readonly ProofEvidenceRecord[], hasher: Hasher): number {
  const requestFeatures = requestClaim.features.length ? requestClaim.features : featureSet(requestClaim.text, 128);
  const claimFeatures = proofClaimFeatures(proofClaim, hasher);
  const evidenceFeatures = records.flatMap(record => proofRecordFeatures(record, hasher)).slice(0, 128);
  const featureScore = jaccard(requestFeatures, [...claimFeatures, ...evidenceFeatures]);
  const numericScore = proofClaim.quantity && requestContainsNumber(requestClaim.text, proofClaim.quantity.value) ? 0.25 : 0;
  const dateScore = proofClaim.dateTime && requestClaim.text.includes(proofClaim.dateTime.value) ? 0.25 : 0;
  return Math.min(1, featureScore + numericScore + dateScore);
}

function proofClaimFeatures(claim: ProofClaim, hasher: Hasher): string[] {
  void hasher;
  return [
    claim.subject.id,
    claim.subject.kindId,
    claim.subject.surface,
    claim.relationId,
    claim.object.id,
    claim.object.kindId,
    claim.object.surface,
    claim.quantity ? String(claim.quantity.value) : undefined,
    claim.quantity?.unitId,
    claim.dateTime?.value,
    claim.polarityId,
    claim.modalityId
  ].flatMap(value => value ? featureSet(value, 32).slice(0, 12) : []);
}

function proofRecordFeatures(record: ProofEvidenceRecord, hasher: Hasher): string[] {
  void hasher;
  return [
    record.subject.id,
    record.subject.kindId,
    record.subject.surface,
    record.relationId,
    record.object.id,
    record.object.kindId,
    record.object.surface,
    record.quantity ? String(record.quantity.value) : undefined,
    record.quantity?.unitId,
    record.dateTime?.value,
    record.polarityId,
    record.modalityId
  ].flatMap(value => value ? featureSet(value, 32).slice(0, 12) : []);
}

function dedupeProofClaims(claims: readonly ProofClaim[]): ProofClaim[] {
  const seen = new Map<string, ProofClaim>();
  for (const claim of claims) if (!seen.has(claim.id)) seen.set(claim.id, claim);
  return [...seen.values()];
}

function dedupeProofEvidence(records: readonly ProofEvidenceRecord[]): ProofEvidenceRecord[] {
  const seen = new Map<string, ProofEvidenceRecord>();
  for (const record of records) if (!seen.has(record.id)) seen.set(record.id, record);
  return [...seen.values()];
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left);
  const b = new Set(right);
  if (!a.size || !b.size) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / Math.max(1, a.size + b.size - intersection);
}

function requestContainsNumber(text: string, value: number): boolean {
  const needle = String(value);
  return text.includes(needle);
}

function verdictWithProofGate(current: SemanticEntailmentResult["semanticVerdict"], gate: SemanticProofResult | undefined): SemanticEntailmentResult["semanticVerdict"] {
  if (!gate) return current;
  if (gate.verdict === "certified") return "entailed";
  if (gate.verdict === "contradicted") return "contradicted";
  if (gate.verdict === "insufficient_evidence" || gate.verdict === "unsupported_prior_only" || gate.verdict === "source_bound_only" || gate.verdict === "ambiguous") return "underdetermined";
  return current;
}

function proofGateSupport(gate: SemanticProofResult | undefined, support: number): number {
  if (!gate) return support;
  if (gate.verdict === "certified") return Math.max(support, 0.86);
  if (gate.verdict === "contradicted") return Math.min(support, 0.18);
  if (gate.verdict === "source_bound_only" || gate.verdict === "unsupported_prior_only") return Math.min(support, 0.28);
  if (gate.verdict === "ambiguous") return Math.min(support, 0.48);
  return Math.min(support, 0.34);
}

function proofGateBoundaries(gate: SemanticProofResult | undefined): string[] {
  if (!gate) return [];
  return [
    `semantic-proof-engine:${gate.verdict}`,
    ...gate.rejectedEvidence.slice(0, 12).map(item => `semantic-proof-engine.rejected:${item.reason}`),
    ...gate.contradictions.slice(0, 12).map(item => `semantic-proof-engine.contradiction:${item.kind}:${item.reason}`)
  ];
}

function certifiedGateEvidenceSpanIds(gate: SemanticProofResult | undefined): Set<string> | undefined {
  if (!gate || gate.verdict !== "certified") return undefined;
  const out = new Set(gate.certifiedEvidenceIds);
  const certified = new Set(gate.certifiedEvidenceIds);
  const bindings = unknownArray((gate.trace as Record<string, unknown>).structuredEvidenceBindings);
  for (const item of bindings) {
    const record = unknownRecord(item);
    const recordId = stringUnknown(record?.recordId);
    const evidenceSpanId = stringUnknown(record?.evidenceSpanId);
    if (recordId && evidenceSpanId && certified.has(recordId)) out.add(evidenceSpanId);
  }
  return out;
}

function withStructuredEvidenceBindings(result: SemanticProofResult, evidence: readonly ProofEvidenceRecord[], claim: ProofClaim, proposalScore: number): SemanticProofResult {
  return {
    ...result,
    trace: {
      ...result.trace,
      proofPath: "structured_runtime",
      structuredClaimId: claim.id,
      structuredProposalScore: proposalScore,
      structuredEvidenceBindings: evidence.map(record => ({
        recordId: record.id,
        evidenceSpanId: record.evidenceSpanId,
        sourceVersionId: record.sourceVersionId,
        forceClass: record.forceClass
      }))
    }
  };
}

function proofForceClassFromBoundary(value: string): ProofForceClass {
  if (value === "direct_evidence" || value === "profile_excerpt_evidence" || value === "learned_language_prior" || value === "learned_concept_prior" || value === "learned_program_prior" || value === "unknown_prior") return value;
  return "unknown_prior";
}

function unknownRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringUnknown(value: unknown): string | undefined {
  return typeof value === "string" && value.length ? value : undefined;
}

function normalizedText(text: string): string {
  return symbolizeData(text).join(" ");
}

function textIdentity(text: string, hasher: Hasher): string {
  return `proof.text.${hasher.digestHex(text).slice(0, 32)}`;
}

function claimFrom(text: string, idFactory: IdFactory): Claim {
  const normalized = symbolizeData(text).join(" ");
  const features = featureSet(text, 512);
  const polarity = polarityOf(text);
  return { id: idFactory.claimId({ normalized, polarity, features: features.slice(0, 96) }), text, normalized, features, polarity };
}

function polarityOf(text: string): number {
  const symbols = symbolizeData(text);
  const explicitsymbolNegation = symbols.some(symbol => /^(?:[¬!]|[-−—])+$|^[¬!]/u.test(symbol));
  const operatorNegation = /(?:!=|≠|∉|⊄|⊅|¬|⊬|⊭)/u.test(text);
  return explicitsymbolNegation || operatorNegation ? -1 : 1;
}
