import type { EvidenceId, EvidenceSpan, FieldState, GraphNode, Hasher, JsonValue, NodeId } from "./types.js";
import type {
  SemanticAtom,
  SemanticAtomPolarity,
  SemanticConstraint,
  SemanticProofVerdict,
  SemanticQuantity,
  SemanticRoleBinding,
  SemanticTemporalScope
} from "./semantic-proof-types.js";
import { clamp01, cosineSimilarity, createHasher, featureSet, stableVector, symbolizeData, toJsonValue, weightedJaccard } from "./primitives.js";
import { evaluateSemanticTransforms } from "./semantic-transform-registry.js";
import { evidenceProofBoundary, graphNodePriorClass, isLearnedPriorClass } from "./proof-boundary.js";
import {
  PROOF_COUNTEREXAMPLE_REASON,
  PROOF_GRAPH_KIND,
  PROOF_GRAPH_RELATION,
  PROOF_OBLIGATION_KIND,
  PROOF_RULE,
  SEMANTIC_CONSTRAINT,
  SEMANTIC_MODALITY,
  SEMANTIC_OPERATOR,
  SEMANTIC_ROLE,
  SEMANTIC_SOURCE,
  SEMANTIC_SUBJECT,
  SEMANTIC_TEMPORAL_GRANULARITY,
  SEMANTIC_VERDICT
} from "./semantic-codes.js";

export type {
  SemanticAtom,
  SemanticAtomPolarity,
  SemanticConstraint,
  SemanticConstraintKind,
  SemanticProofVerdict,
  SemanticQuantity,
  SemanticRoleBinding,
  SemanticTemporalScope
} from "./semantic-proof-types.js";

export interface SemanticUnification {
  leftAtomId: string;
  rightAtomId: string;
  predicate: number;
  roles: number;
  constraints: number;
  polarity: number;
  alpha: number;
  support: number;
  contradiction: number;
  missingRoles: string[];
  violatedConstraints: string[];
  transformIds: string[];
  transformSupport: number;
  transformContradiction: number;
  transformObligations: string[];
  evidenceIds: EvidenceId[];
  factualProofEligible: boolean;
  rightProofClass: string;
  audit: JsonValue;
}

export interface ProofObligation {
  id: string;
  atomId: string;
  kind: string;
  description: string;
  weight: number;
  evidenceIds: EvidenceId[];
}

export interface ProofCounterexample {
  id: string;
  claimAtomId: string;
  evidenceAtomId: string;
  reason: string;
  contradiction: number;
  evidenceIds: EvidenceId[];
}

export interface SemanticProofStep {
  id: string;
  rule: string;
  premises: string[];
  conclusion: string;
  support: number;
  contradiction: number;
  evidenceIds: EvidenceId[];
  audit: JsonValue;
}

export interface SemanticProofResult {
  id: string;
  verdict: SemanticProofVerdict;
  claimAtoms: SemanticAtom[];
  evidenceAtoms: SemanticAtom[];
  graphAtoms: SemanticAtom[];
  support: number;
  contradiction: number;
  coverage: number;
  faithfulnessLcb: number;
  obligations: ProofObligation[];
  counterexamples: ProofCounterexample[];
  steps: SemanticProofStep[];
  graph: {
    nodes: Array<{ id: string; kind: string; label: string; metadata: JsonValue }>;
    edges: Array<{ source: string; target: string; relation: string; weight: number; evidenceIds: EvidenceId[] }>;
  };
  replay: JsonValue;
}

export interface SemanticProofSearchInput {
  claimText: string;
  evidence: EvidenceSpan[];
  nodes?: GraphNode[];
  field?: FieldState;
  maxAtoms?: number;
}

export function createSemanticProofSystem(options: { hasher?: Hasher; dimensions?: number; maxEvidenceAtoms?: number } = {}) {
  const hasher = options.hasher ?? createHasher();
  const dimensions = Math.max(16, Math.min(256, Math.floor(options.dimensions ?? 64)));
  const maxEvidenceAtoms = Math.max(16, Math.floor(options.maxEvidenceAtoms ?? 4096));

  return {
    atomizeClaim(text: string): SemanticAtom[] {
      return atomizeText({ text, source: SEMANTIC_SOURCE.CLAIM, hasher, dimensions, maxAtoms: 128 });
    },

    atomizeEvidence(evidence: readonly EvidenceSpan[]): SemanticAtom[] {
      const atoms: SemanticAtom[] = [];
      for (const span of evidence) {
        const boundary = evidenceProofBoundary(span);
        atoms.push(
          ...atomizeText({
            text: span.text,
            source: SEMANTIC_SOURCE.EVIDENCE,
            hasher,
            dimensions,
            maxAtoms: Math.max(1, Math.min(128, maxEvidenceAtoms - atoms.length)),
            evidenceIds: [span.id],
            alpha: span.alpha,
            proofClass: boundary.forceClass,
            certifiesFactualProof: boundary.certifiesFactualProof,
            proofBoundaryReason: boundary.reason
          })
        );
        if (atoms.length >= maxEvidenceAtoms) break;
      }
      return atoms;
    },

    atomizeGraph(nodes: readonly GraphNode[] = []): SemanticAtom[] {
      return atomizeGraphNodes(nodes, hasher, dimensions);
    },

    unify(left: SemanticAtom, right: SemanticAtom): SemanticUnification {
      return unifyAtoms(left, right);
    },

    prove(input: SemanticProofSearchInput): SemanticProofResult {
      const claimAtoms = atomizeText({
        text: input.claimText,
        source: SEMANTIC_SOURCE.CLAIM,
        hasher,
        dimensions,
        maxAtoms: Math.max(1, input.maxAtoms ?? 96)
      });
      const evidenceAtoms = this.atomizeEvidence(input.evidence).slice(0, maxEvidenceAtoms);
      const graphAtoms = atomizeGraphNodes(input.nodes ?? [], hasher, dimensions).slice(0, 2048);
      const activeAtoms = applyFieldMass([...evidenceAtoms, ...graphAtoms], input.field);
      const allSupportAtoms = activeAtoms.length ? activeAtoms : [...evidenceAtoms, ...graphAtoms];
      const search = searchProof({ claimAtoms, supportAtoms: allSupportAtoms, hasher });
      const graph = proofGraphFrom(search, claimAtoms, evidenceAtoms, graphAtoms);
      const replay = toJsonValue({
        claimHash: hasher.digestHex(input.claimText),
        claimAtomIds: claimAtoms.map(atom => atom.id),
        evidenceAtomIds: evidenceAtoms.map(atom => atom.id),
        graphAtomIds: graphAtoms.map(atom => atom.id),
        selectedSteps: search.steps.map(step => step.id),
        obligations: search.obligations.map(item => item.id),
        counterexamples: search.counterexamples.map(item => item.id),
        admission: search.admission,
        scores: {
          support: search.support,
          contradiction: search.contradiction,
          coverage: search.coverage,
          faithfulnessLcb: search.faithfulnessLcb
        }
      });
      return {
        id: `semantic_proof_${hasher.digestHex(JSON.stringify(replay)).slice(0, 32)}`,
        verdict: verdictFrom(search.support, search.contradiction, search.coverage, search.faithfulnessLcb, search.admission),
        claimAtoms,
        evidenceAtoms,
        graphAtoms,
        support: search.support,
        contradiction: search.contradiction,
        coverage: search.coverage,
        faithfulnessLcb: search.faithfulnessLcb,
        obligations: search.obligations,
        counterexamples: search.counterexamples,
        steps: search.steps,
        graph,
        replay
      };
    }
  };
}

export function atomizeText(input: {
  text: string;
  source: SemanticAtom["source"];
  hasher?: Hasher;
  dimensions?: number;
  maxAtoms?: number;
  evidenceIds?: EvidenceId[];
  alpha?: number;
  proofClass?: string;
  certifiesFactualProof?: boolean;
  proofBoundaryReason?: string;
}): SemanticAtom[] {
  const hasher = input.hasher ?? createHasher();
  const dimensions = Math.max(16, Math.floor(input.dimensions ?? 64));
  const sentences = splitSemanticSentences(input.text).slice(0, input.maxAtoms ?? 256);
  const atoms: SemanticAtom[] = [];
  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex++) {
    const sentence = sentences[sentenceIndex]!;
    const symbols = symbolizeData(sentence);
    if (symbols.length === 0) continue;
    const predicateSymbol = selectPredicate(symbols);
    const roles = deriveRoles(symbols, predicateSymbol.index, input.evidenceIds);
    const constraints = deriveConstraints(sentence, symbols, hasher, input.evidenceIds ?? []);
    const predicateFeatures = buildPredicateFeatures(predicateSymbol.symbol, symbols, predicateSymbol.index);
    const polarity = polarityFromSurface(sentence, symbols);
    const alpha = clamp01((input.alpha ?? 0.5) * (0.65 + Math.min(0.35, symbols.length / 80)));
    const vector = stableVector([...predicateFeatures, ...roles.flatMap(role => role.features), ...constraints.map(c => `${c.kind}:${c.subject}:${c.operator}:${JSON.stringify(c.value)}`)], hasher, dimensions);
    const id = semanticAtomId(hasher, {
      source: input.source,
      sentenceIndex,
      predicate: predicateSymbol.symbol,
      roles: roles.map(role => [role.name, role.normalized]),
      constraints: constraints.map(c => [c.kind, c.subject, c.operator, c.value]),
      polarity,
      evidenceIds: input.evidenceIds ?? []
    });
    atoms.push({
      id,
      predicate: predicateSymbol.symbol,
      predicateFeatures,
      roles,
      constraints,
      polarity,
      alpha,
      modality: modalityFromSurface(sentence, symbols, input.source),
      source: input.source,
      sourceText: sentence,
      evidenceIds: input.evidenceIds ?? [],
      nodeIds: [],
      vector,
      proofClass: input.proofClass ?? "none",
      certifiesFactualProof: Boolean(input.certifiesFactualProof),
      proofBoundaryReason: input.proofBoundaryReason
    });
  }
  return atoms;
}

function atomizeGraphNodes(nodes: readonly GraphNode[], hasher: Hasher, dimensions: number): SemanticAtom[] {
  const atoms: SemanticAtom[] = [];
  for (const node of nodes) {
    const text = graphNodeText(node);
    if (!text) continue;
    const proofClass = graphNodePriorClass(node);
    const derived = atomizeText({
      text,
      source: SEMANTIC_SOURCE.GRAPH,
      hasher,
      dimensions,
      maxAtoms: 16,
      evidenceIds: node.evidenceIds,
      alpha: node.alpha,
      proofClass,
      certifiesFactualProof: node.evidenceIds.length > 0 && !isLearnedPriorClass(proofClass),
      proofBoundaryReason: isLearnedPriorClass(proofClass) ? `proof-boundary.graph-prior-not-evidence:${proofClass}` : "proof-boundary.graph-exact-evidence-refs"
    });
    for (const atom of derived) {
      atoms.push({
        ...atom,
        nodeIds: [node.id],
        id: semanticAtomId(hasher, { graphNode: node.id, atom: atom.id })
      });
    }
  }
  return atoms;
}

function graphNodeText(node: GraphNode): string {
  const rep = node.representation;
  if (typeof rep === "string") return rep;
  if (!rep || typeof rep !== "object" || Array.isArray(rep)) return node.features.join(" ");
  const record = rep as Record<string, JsonValue>;
  const parts: string[] = [];
  for (const key of ["label", "text", "name", "predicate", "value", "summary"]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) parts.push(value);
  }
  if (parts.length === 0) parts.push(...node.features.slice(0, 64).map(feature => feature.replace(/^[^:]+:/, "")));
  return parts.join(" ");
}

interface ProofSearchIntermediate {
  support: number;
  contradiction: number;
  coverage: number;
  faithfulnessLcb: number;
  admission: {
    admitted: boolean;
    supportCeiling: number;
    reasons: string[];
    certifiedUnificationIds: string[];
  };
  obligations: ProofObligation[];
  counterexamples: ProofCounterexample[];
  steps: SemanticProofStep[];
  unifications: SemanticUnification[];
}

function searchProof(input: { claimAtoms: SemanticAtom[]; supportAtoms: SemanticAtom[]; hasher: Hasher }): ProofSearchIntermediate {
  const unifications: SemanticUnification[] = [];
  const obligations: ProofObligation[] = [];
  const counterexamples: ProofCounterexample[] = [];
  const steps: SemanticProofStep[] = [];
  const bestPerClaim = new Map<string, SemanticUnification>();
  for (const claim of input.claimAtoms) {
    let best: SemanticUnification | undefined;
    let strongestCounterexample: SemanticUnification | undefined;
    for (const candidate of input.supportAtoms) {
      const unified = unifyAtoms(claim, candidate);
      unifications.push(unified);
      if (!best || unified.support > best.support) best = unified;
      if (unified.contradiction > (strongestCounterexample?.contradiction ?? 0)) strongestCounterexample = unified;
    }
    if (best && best.support > 0.12) {
      bestPerClaim.set(claim.id, best);
      steps.push({
        id: `step_${input.hasher.digestHex(`direct:${claim.id}:${best.rightAtomId}`).slice(0, 24)}`,
        rule: PROOF_RULE.DIRECT,
        premises: [claim.id, best.rightAtomId],
        conclusion: claim.id,
        support: best.support,
        contradiction: best.contradiction,
        evidenceIds: best.evidenceIds,
        audit: best.audit
      });
      if (best.missingRoles.length > 0 || best.violatedConstraints.length > 0) {
        steps.push({
          id: `step_${input.hasher.digestHex(`constraint:${claim.id}:${best.rightAtomId}`).slice(0, 24)}`,
          rule: PROOF_RULE.CONSTRAINT,
          premises: [best.rightAtomId],
          conclusion: claim.id,
          support: Math.max(0, best.constraints - best.violatedConstraints.length * 0.12),
          contradiction: best.violatedConstraints.length ? Math.min(1, best.violatedConstraints.length * 0.18) : 0,
          evidenceIds: best.evidenceIds,
          audit: toJsonValue({ missingRoles: best.missingRoles, violatedConstraints: best.violatedConstraints })
        });
      }
    }
    if (!best || !certifyingUnification(best)) {
      const obligation = obligationForClaim(claim, best, input.hasher);
      obligations.push(obligation);
      steps.push({
        id: `step_${input.hasher.digestHex(`obligation:${obligation.id}`).slice(0, 24)}`,
        rule: PROOF_RULE.OBLIGATION,
        premises: [claim.id],
        conclusion: obligation.id,
        support: Math.max(0, best?.support ?? 0),
        contradiction: best?.contradiction ?? 0,
        evidenceIds: obligation.evidenceIds,
        audit: toJsonValue(obligation)
      });
    }
    if (strongestCounterexample && strongestCounterexample.contradiction > 0.42) {
      counterexamples.push({
        id: `counterexample_${input.hasher.digestHex(`${claim.id}:${strongestCounterexample.rightAtomId}`).slice(0, 24)}`,
        claimAtomId: claim.id,
        evidenceAtomId: strongestCounterexample.rightAtomId,
        reason: contradictionReason(strongestCounterexample),
        contradiction: strongestCounterexample.contradiction,
        evidenceIds: strongestCounterexample.evidenceIds
      });
      steps.push({
        id: `step_${input.hasher.digestHex(`contradiction:${claim.id}:${strongestCounterexample.rightAtomId}`).slice(0, 24)}`,
        rule: PROOF_RULE.CONTRADICTION,
        premises: [claim.id, strongestCounterexample.rightAtomId],
        conclusion: claim.id,
        support: strongestCounterexample.support,
        contradiction: strongestCounterexample.contradiction,
        evidenceIds: strongestCounterexample.evidenceIds,
        audit: strongestCounterexample.audit
      });
    }
  }
  const selected = [...bestPerClaim.values()];
  const admission = proofSearchAdmission(input.claimAtoms, selected, obligations, counterexamples);
  const rawSupport = selected.length ? selected.reduce((sum, item) => sum + item.support, 0) / selected.length : 0;
  const support = Math.min(rawSupport, admission.supportCeiling);
  const contradiction = counterexamples.length
    ? Math.max(...counterexamples.map(item => item.contradiction))
    : selected.length
      ? Math.max(...selected.map(item => item.contradiction))
      : 0;
  const certified = selected.filter(certifyingUnification);
  const coverage = input.claimAtoms.length ? certified.length / input.claimAtoms.length : 0;
  const supportVariance = selected.length ? selected.reduce((sum, item) => sum + (item.support - support) ** 2, 0) / selected.length : 0;
  const faithfulnessLcb = clamp01(support - Math.sqrt(supportVariance + 0.02) - contradiction * 0.35 - obligations.length * 0.03);
  if (selected.length > 0) {
    steps.push({
      id: `step_${input.hasher.digestHex(`alpha:${selected.map(item => item.rightAtomId).join("|")}`).slice(0, 24)}`,
      rule: PROOF_RULE.ALPHA,
      premises: selected.map(item => item.rightAtomId),
      conclusion: PROOF_RULE.ALPHA,
      support: clamp01(selected.reduce((sum, item) => sum + item.alpha * item.support, 0) / selected.length),
      contradiction,
      evidenceIds: [...new Set(selected.flatMap(item => item.evidenceIds))],
      audit: toJsonValue({ selected: selected.map(item => ({ left: item.leftAtomId, right: item.rightAtomId, alpha: item.alpha, support: item.support, certifying: certifyingUnification(item) })), admission, rawSupport })
    });
  }
  return { support, contradiction, coverage, faithfulnessLcb, admission, obligations, counterexamples, steps, unifications };
}

function certifyingUnification(unification: SemanticUnification): boolean {
  return unification.evidenceIds.length > 0 &&
    unification.factualProofEligible &&
    unification.polarity === 1 &&
    unification.predicate >= 0.5 &&
    unification.roles >= 0.45 &&
    unification.constraints >= 0.68 &&
    unification.missingRoles.length === 0 &&
    unification.violatedConstraints.length === 0 &&
    unification.transformObligations.length === 0 &&
    unification.contradiction <= 0.22;
}

function proofSearchAdmission(
  claimAtoms: readonly SemanticAtom[],
  selected: readonly SemanticUnification[],
  obligations: readonly ProofObligation[],
  counterexamples: readonly ProofCounterexample[]
): ProofSearchIntermediate["admission"] {
  const certified = selected.filter(certifyingUnification);
  const reasons: string[] = [];
  if (!claimAtoms.length) reasons.push("semantic-proof.no-claim-atoms");
  if (!selected.length) reasons.push("semantic-proof.no-supporting-unification");
  if (counterexamples.length) reasons.push(`semantic-proof.counterexamples:${counterexamples.length}`);
  if (obligations.length) reasons.push(`semantic-proof.open-obligations:${obligations.length}`);
  if (selected.some(item => item.evidenceIds.length > 0 && !item.factualProofEligible)) reasons.push("semantic-proof.prior-not-direct-evidence");
  if (certified.length < claimAtoms.length) reasons.push(`semantic-proof.uncertified-claim-atoms:${Math.max(0, claimAtoms.length - certified.length)}`);
  let supportCeiling = 1;
  if (!selected.length) supportCeiling = Math.min(supportCeiling, 0.18);
  if (counterexamples.length) supportCeiling = Math.min(supportCeiling, 0.32);
  if (obligations.length) supportCeiling = Math.min(supportCeiling, 0.54);
  if (certified.length < claimAtoms.length) supportCeiling = Math.min(supportCeiling, 0.58);
  return {
    admitted: reasons.length === 0,
    supportCeiling: clamp01(supportCeiling),
    reasons,
    certifiedUnificationIds: certified.map(item => `${item.leftAtomId}:${item.rightAtomId}`)
  };
}

function unifyAtoms(left: SemanticAtom, right: SemanticAtom): SemanticUnification {
  const predicate = predicateSimilarity(left, right);
  const roleMatch = roleSimilarity(left.roles, right.roles);
  const constraintMatch = constraintSimilarity(left.constraints, right.constraints);
  const polarity = left.polarity === right.polarity ? 1 : 0;
  const transforms = evaluateSemanticTransforms({ claim: left, evidence: right, predicateScore: predicate, roleScore: roleMatch.score, constraintScore: constraintMatch.score, polarityScore: polarity });
  const alpha = clamp01(0.5 * right.alpha + 0.5 * cosineSimilarity(left.vector, right.vector));
  const agreement = clamp01(0.34 * predicate + 0.32 * roleMatch.score + 0.16 * constraintMatch.score + 0.1 * polarity + 0.08 * transforms.supportBoost);
  const contradiction = clamp01(contradictionScore(left, right, predicate, roleMatch.score, constraintMatch.violations.length) + transforms.contradictionBoost);
  const support = clamp01(agreement * (0.45 + 0.55 * alpha) * (1 - contradiction * 0.62));
  return {
    leftAtomId: left.id,
    rightAtomId: right.id,
    predicate,
    roles: roleMatch.score,
    constraints: constraintMatch.score,
    polarity,
    alpha,
    support,
    contradiction,
    missingRoles: roleMatch.missing,
    violatedConstraints: [...constraintMatch.violations, ...transforms.obligations],
    transformIds: transforms.transformIds,
    transformSupport: transforms.supportBoost,
    transformContradiction: transforms.contradictionBoost,
    transformObligations: transforms.obligations,
    evidenceIds: [...new Set([...left.evidenceIds, ...right.evidenceIds])],
    factualProofEligible: right.certifiesFactualProof,
    rightProofClass: right.proofClass,
    audit: toJsonValue({
      leftPredicate: left.predicate,
      rightPredicate: right.predicate,
      rightProofClass: right.proofClass,
      factualProofEligible: right.certifiesFactualProof,
      predicate,
      rolePairs: roleMatch.pairs,
      constraintPairs: constraintMatch.pairs,
      polarity,
      alpha,
      support,
      contradiction,
      transforms: transforms.audit
    })
  };
}

function predicateSimilarity(left: SemanticAtom, right: SemanticAtom): number {
  const lexical = left.predicate === right.predicate ? 1 : normalizedEditSimilarity(left.predicate, right.predicate);
  const feature = weightedJaccard(left.predicateFeatures, right.predicateFeatures);
  const vector = clamp01((cosineSimilarity(left.vector, right.vector) + 1) / 2);
  return clamp01(0.45 * lexical + 0.35 * feature + 0.2 * vector);
}

function roleSimilarity(left: readonly SemanticRoleBinding[], right: readonly SemanticRoleBinding[]): {
  score: number;
  missing: string[];
  pairs: Array<{ left: string; right: string; score: number }>;
} {
  if (left.length === 0 && right.length === 0) return { score: 1, missing: [], pairs: [] };
  if (left.length === 0 || right.length === 0) return { score: 0, missing: left.map(role => role.name), pairs: [] };
  const used = new Set<number>();
  const pairs: Array<{ left: string; right: string; score: number }> = [];
  const missing: string[] = [];
  let weighted = 0;
  let total = 0;
  for (const l of left) {
    let bestIndex = -1;
    let bestScore = -1;
    for (let i = 0; i < right.length; i++) {
      if (used.has(i)) continue;
      const r = right[i]!;
      const typeBoost = l.type === r.type ? 0.12 : 0;
      const nameBoost = l.name === r.name ? 0.1 : l.name.slice(0, 3) === r.name.slice(0, 3) ? 0.04 : 0;
      const lexical = l.normalized === r.normalized ? 1 : normalizedEditSimilarity(l.normalized, r.normalized);
      const features = weightedJaccard(l.features, r.features);
      const score = clamp01(0.48 * lexical + 0.3 * features + typeBoost + nameBoost);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    total += l.weight;
    if (bestIndex >= 0 && bestScore >= 0.18) {
      used.add(bestIndex);
      const r = right[bestIndex]!;
      pairs.push({ left: `${l.name}:${l.normalized}`, right: `${r.name}:${r.normalized}`, score: bestScore });
      weighted += l.weight * bestScore;
    } else {
      missing.push(`${l.name}:${l.normalized}`);
    }
  }
  return { score: total > 0 ? clamp01(weighted / total) : 0, missing, pairs };
}

function constraintSimilarity(left: readonly SemanticConstraint[], right: readonly SemanticConstraint[]): {
  score: number;
  violations: string[];
  pairs: Array<{ left: string; right: string; score: number }>;
} {
  if (left.length === 0) return { score: 1, violations: [], pairs: [] };
  if (right.length === 0) return { score: 0.35, violations: left.map(item => item.id), pairs: [] };
  const pairs: Array<{ left: string; right: string; score: number }> = [];
  const violations: string[] = [];
  let score = 0;
  let total = 0;
  for (const l of left) {
    const compatible = right
      .filter(r => r.kind === l.kind || r.subject === l.subject)
      .map(r => ({ r, score: compareConstraints(l, r) }))
      .sort((a, b) => b.score - a.score)[0];
    total += l.confidence;
    if (!compatible) {
      score += l.confidence * 0.25;
      continue;
    }
    pairs.push({ left: l.id, right: compatible.r.id, score: compatible.score });
    if (compatible.score < 0.18) violations.push(`${l.id}:${compatible.r.id}`);
    score += l.confidence * compatible.score;
  }
  return { score: total > 0 ? clamp01(score / total) : 1, violations, pairs };
}

function compareConstraints(left: SemanticConstraint, right: SemanticConstraint): number {
  if (left.kind !== right.kind && left.subject !== right.subject) return 0;
  if (isQuantityConstraint(left) && isQuantityConstraint(right)) return compareQuantityConstraint(left, right);
  if (isTemporalConstraint(left) && isTemporalConstraint(right)) return compareTemporalConstraint(left, right);
  if (left.operator === SEMANTIC_OPERATOR.NEQ || right.operator === SEMANTIC_OPERATOR.NEQ) {
    return JSON.stringify(left.value) === JSON.stringify(right.value) ? 0 : 0.8;
  }
  const exact = JSON.stringify(left.value) === JSON.stringify(right.value) ? 1 : 0;
  const subject = left.subject === right.subject ? 0.2 : 0;
  const op = left.operator === right.operator ? 0.2 : left.operator === SEMANTIC_OPERATOR.COMPATIBLE || right.operator === SEMANTIC_OPERATOR.COMPATIBLE ? 0.1 : 0;
  const lexical = normalizedEditSimilarity(JSON.stringify(left.value), JSON.stringify(right.value)) * 0.6;
  return clamp01(Math.max(exact, lexical + subject + op));
}

function compareQuantityConstraint(left: SemanticConstraint, right: SemanticConstraint): number {
  const l = quantityFromJson(left.value);
  const r = quantityFromJson(right.value);
  if (!l || !r) return 0.35;
  if (l.unit && r.unit && normalizeUnit(l.unit) !== normalizeUnit(r.unit)) return 0.05;
  const lLower = l.lower ?? l.value;
  const lUpper = l.upper ?? l.value;
  const rLower = r.lower ?? r.value;
  const rUpper = r.upper ?? r.value;
  const overlap = Math.max(0, Math.min(lUpper, rUpper) - Math.max(lLower, rLower));
  const span = Math.max(Math.max(lUpper, rUpper) - Math.min(lLower, rLower), Math.abs(l.value), Math.abs(r.value), 1);
  const close = 1 - Math.min(1, Math.abs(l.value - r.value) / span);
  return clamp01(0.55 * (overlap > 0 ? overlap / span : 0) + 0.45 * close);
}

function compareTemporalConstraint(left: SemanticConstraint, right: SemanticConstraint): number {
  const l = temporalFromJson(left.value);
  const r = temporalFromJson(right.value);
  if (!l || !r) return 0.35;
  const lLower = l.lower ?? l.instant ?? 0;
  const lUpper = l.upper ?? l.instant ?? lLower;
  const rLower = r.lower ?? r.instant ?? 0;
  const rUpper = r.upper ?? r.instant ?? rLower;
  const overlap = Math.max(0, Math.min(lUpper, rUpper) - Math.max(lLower, rLower));
  const span = Math.max(1, Math.max(lUpper, rUpper) - Math.min(lLower, rLower));
  const granularity = l.granularity === r.granularity ? 0.2 : 0;
  return clamp01((overlap > 0 ? overlap / span : 0) * 0.8 + granularity);
}

function isQuantityConstraint(constraint: SemanticConstraint): boolean {
  return constraint.kind === SEMANTIC_CONSTRAINT.QUANTITY || quantityFromJson(constraint.value) !== undefined;
}

function isTemporalConstraint(constraint: SemanticConstraint): boolean {
  return constraint.kind === SEMANTIC_CONSTRAINT.TEMPORAL || temporalFromJson(constraint.value) !== undefined;
}

function contradictionScore(left: SemanticAtom, right: SemanticAtom, predicate: number, roles: number, violatedConstraints: number): number {
  const comparable = predicate * 0.6 + roles * 0.4;
  const polarityConflict = left.polarity !== right.polarity ? comparable : 0;
  const hardConstraint = Math.min(1, violatedConstraints * 0.22) * comparable;
  const quantityConflict = quantityContradiction(left.constraints, right.constraints) * comparable;
  const temporalConflict = temporalContradiction(left.constraints, right.constraints) * comparable;
  return clamp01(Math.max(polarityConflict, hardConstraint, quantityConflict, temporalConflict));
}

function quantityContradiction(left: readonly SemanticConstraint[], right: readonly SemanticConstraint[]): number {
  let score = 0;
  for (const l of left.filter(isQuantityConstraint)) {
    for (const r of right.filter(isQuantityConstraint)) {
      const ql = quantityFromJson(l.value);
      const qr = quantityFromJson(r.value);
      if (!ql || !qr) continue;
      if (ql.unit && qr.unit && normalizeUnit(ql.unit) !== normalizeUnit(qr.unit)) continue;
      const lLow = ql.lower ?? ql.value;
      const lHigh = ql.upper ?? ql.value;
      const rLow = qr.lower ?? qr.value;
      const rHigh = qr.upper ?? qr.value;
      const disjoint = lHigh < rLow || rHigh < lLow;
      const exclusiveEquality = (l.operator === SEMANTIC_OPERATOR.NEQ || r.operator === SEMANTIC_OPERATOR.NEQ) && Math.abs(ql.value - qr.value) <= Number.EPSILON;
      if (disjoint || exclusiveEquality) score = Math.max(score, 0.75);
    }
  }
  return score;
}

function temporalContradiction(left: readonly SemanticConstraint[], right: readonly SemanticConstraint[]): number {
  let score = 0;
  for (const l of left.filter(isTemporalConstraint)) {
    for (const r of right.filter(isTemporalConstraint)) {
      const tl = temporalFromJson(l.value);
      const tr = temporalFromJson(r.value);
      if (!tl || !tr) continue;
      const lLow = tl.lower ?? tl.instant;
      const lHigh = tl.upper ?? tl.instant;
      const rLow = tr.lower ?? tr.instant;
      const rHigh = tr.upper ?? tr.instant;
      if (lLow === undefined || lHigh === undefined || rLow === undefined || rHigh === undefined) continue;
      if (lHigh < rLow || rHigh < lLow) score = Math.max(score, 0.55);
    }
  }
  return score;
}

function proofGraphFrom(search: ProofSearchIntermediate, claimAtoms: SemanticAtom[], evidenceAtoms: SemanticAtom[], graphAtoms: SemanticAtom[]): SemanticProofResult["graph"] {
  const nodes = [
    ...claimAtoms.map(atom => ({ id: atom.id, kind: PROOF_GRAPH_KIND.CLAIM_ATOM, label: atom.predicate, metadata: atomMetadata(atom) })),
    ...evidenceAtoms.map(atom => ({ id: atom.id, kind: PROOF_GRAPH_KIND.EVIDENCE_ATOM, label: atom.predicate, metadata: atomMetadata(atom) })),
    ...graphAtoms.map(atom => ({ id: atom.id, kind: PROOF_GRAPH_KIND.GRAPH_ATOM, label: atom.predicate, metadata: atomMetadata(atom) })),
    ...search.obligations.map(item => ({ id: item.id, kind: PROOF_GRAPH_KIND.OBLIGATION, label: item.kind, metadata: toJsonValue(item) })),
    ...search.counterexamples.map(item => ({ id: item.id, kind: PROOF_GRAPH_KIND.COUNTEREXAMPLE, label: item.reason, metadata: toJsonValue(item) })),
    ...search.steps.map(step => ({ id: step.id, kind: PROOF_GRAPH_KIND.PROOF_STEP, label: step.rule, metadata: step.audit }))
  ];
  const edges: SemanticProofResult["graph"]["edges"] = [];
  for (const step of search.steps) {
    for (const premise of step.premises) {
      edges.push({ source: premise, target: step.id, relation: PROOF_GRAPH_RELATION.PREMISE, weight: step.support, evidenceIds: step.evidenceIds });
    }
    edges.push({ source: step.id, target: step.conclusion, relation: step.contradiction > step.support ? PROOF_GRAPH_RELATION.SCREENS : PROOF_GRAPH_RELATION.SUPPORTS, weight: step.contradiction > step.support ? step.contradiction : step.support, evidenceIds: step.evidenceIds });
  }
  for (const item of search.counterexamples) {
    edges.push({ source: item.evidenceAtomId, target: item.claimAtomId, relation: PROOF_GRAPH_RELATION.CONTRADICTS, weight: item.contradiction, evidenceIds: item.evidenceIds });
  }
  return { nodes, edges };
}

function atomMetadata(atom: SemanticAtom): JsonValue {
  return toJsonValue({
    predicate: atom.predicate,
    roles: atom.roles.map(role => ({ name: role.name, value: role.value, type: role.type, weight: role.weight })),
    constraints: atom.constraints.map(constraint => ({ kind: constraint.kind, subject: constraint.subject, operator: constraint.operator, value: constraint.value, confidence: constraint.confidence })),
    polarity: atom.polarity,
    alpha: atom.alpha,
    source: atom.source,
    evidenceIds: atom.evidenceIds,
    nodeIds: atom.nodeIds,
    proofClass: atom.proofClass,
    certifiesFactualProof: atom.certifiesFactualProof,
    proofBoundaryReason: atom.proofBoundaryReason ?? null
  });
}

function obligationForClaim(claim: SemanticAtom, best: SemanticUnification | undefined, hasher: Hasher): ProofObligation {
  const missingRoles = best?.missingRoles ?? claim.roles.map(role => `${role.name}:${role.normalized}`);
  const kind: ProofObligation["kind"] = !best ? PROOF_OBLIGATION_KIND.PREDICATE : missingRoles.length ? PROOF_OBLIGATION_KIND.ROLE : best.violatedConstraints.length ? PROOF_OBLIGATION_KIND.CONSTRAINT : PROOF_OBLIGATION_KIND.SOURCE;
  const description = !best
    ? `${PROOF_OBLIGATION_KIND.PREDICATE}:${claim.predicate}`
    : missingRoles.length
      ? `${PROOF_OBLIGATION_KIND.ROLE}:${missingRoles[0]}`
      : best.violatedConstraints.length
        ? `${PROOF_OBLIGATION_KIND.CONSTRAINT}:${best.violatedConstraints[0]}`
        : `${PROOF_OBLIGATION_KIND.SOURCE}:${claim.predicate}`;
  return {
    id: `obligation_${hasher.digestHex(`${claim.id}:${description}`).slice(0, 24)}`,
    atomId: claim.id,
    kind,
    description,
    weight: clamp01(1 - (best?.support ?? 0)),
    evidenceIds: best?.evidenceIds ?? []
  };
}

function contradictionReason(unification: SemanticUnification): string {
  if (unification.polarity === 0 && unification.predicate > 0.45 && unification.roles > 0.35) return PROOF_COUNTEREXAMPLE_REASON.POLARITY;
  if (unification.violatedConstraints.length > 0) return `${PROOF_COUNTEREXAMPLE_REASON.CONSTRAINT}:${unification.violatedConstraints.slice(0, 3).join(",")}`;
  return PROOF_COUNTEREXAMPLE_REASON.ALPHA_INCOMPATIBLE;
}

function verdictFrom(support: number, contradiction: number, coverage: number, faithfulnessLcb: number, admission: ProofSearchIntermediate["admission"]): SemanticProofVerdict {
  if (contradiction >= 0.55 && contradiction > support * 0.9) return SEMANTIC_VERDICT.CONTRADICTED;
  if (admission.admitted && support >= 0.76 && coverage >= 0.72 && faithfulnessLcb >= 0.45) return SEMANTIC_VERDICT.ENTAILED;
  if (support >= 0.42 && coverage >= 0.35) return SEMANTIC_VERDICT.PARTIAL;
  return SEMANTIC_VERDICT.UNDERDETERMINED;
}

function applyFieldMass(atoms: SemanticAtom[], field: FieldState | undefined): SemanticAtom[] {
  if (!field) return atoms;
  const massByNode = new Map<string, number>();
  for (const item of field.ppf) massByNode.set(String(item.nodeId), Math.max(massByNode.get(String(item.nodeId)) ?? 0, item.mass));
  for (const item of field.active) massByNode.set(String(item.nodeId), Math.max(massByNode.get(String(item.nodeId)) ?? 0, item.activation));
  if (massByNode.size === 0) return atoms;
  return atoms.map(atom => {
    const nodeMass = atom.nodeIds.reduce((max, id) => Math.max(max, massByNode.get(String(id)) ?? 0), 0);
    return nodeMass > 0 ? { ...atom, alpha: clamp01(0.65 * atom.alpha + 0.35 * nodeMass) } : atom;
  });
}

function splitSemanticSentences(text: string): string[] {
  const cleaned = text.replace(/\u0000/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return [];
  const segments: string[] = [];
  let start = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const c = cleaned[i]!;
    const next = cleaned[i + 1] ?? "";
    if ((c === "." || c === "!" || c === "?" || c === ";" || c === "\n") && (next === " " || next === "")) {
      const segment = cleaned.slice(start, i + 1).trim();
      if (segment) segments.push(segment);
      start = i + 1;
    }
  }
  const tail = cleaned.slice(start).trim();
  if (tail) segments.push(tail);
  if (segments.length > 0) return segments;
  const symbols = symbolizeData(cleaned);
  const out: string[] = [];
  for (let i = 0; i < symbols.length; i += 32) out.push(symbols.slice(i, i + 32).join(" "));
  return out;
}

function selectPredicate(symbols: readonly string[]): { symbol: string; index: number } {
  let best = { symbol: symbols[0] ?? "unit", index: 0, score: -Infinity };
  const counts = new Map<string, number>();
  for (const symbol of symbols) counts.set(symbol, (counts.get(symbol) ?? 0) + 1);
  for (let i = 0; i < symbols.length; i++) {
    const symbol = symbols[i]!;
    if (!semanticSymbol(symbol)) continue;
    const lengthScore = Math.min(1, symbol.length / 12);
    const rarity = 1 / Math.max(1, counts.get(symbol) ?? 1);
    const center = 1 - Math.abs(i - (symbols.length - 1) / 2) / Math.max(1, symbols.length);
    const symbolicWeight = /[=<>:+*/\\-]/.test(symbol) ? 0.18 : 0;
    const score = 0.38 * lengthScore + 0.32 * rarity + 0.22 * center + symbolicWeight;
    if (score > best.score) best = { symbol, index: i, score };
  }
  return { symbol: best.symbol, index: best.index };
}

function deriveRoles(symbols: readonly string[], predicateIndex: number, evidenceIds: EvidenceId[] | undefined): SemanticRoleBinding[] {
  const left = symbols.slice(Math.max(0, predicateIndex - 10), predicateIndex).filter(semanticSymbol);
  const right = symbols.slice(predicateIndex + 1, Math.min(symbols.length, predicateIndex + 11)).filter(semanticSymbol);
  const quantities = symbols.map((symbol, index) => ({ symbol, index, quantity: parseQuantitySymbol(symbol, symbols[index + 1]) })).filter(item => item.quantity);
  const roles: SemanticRoleBinding[] = [];
  if (left.length > 0) roles.push(roleBinding("arg0", compactRoleValue(left), SEMANTIC_ROLE.ENTITY, evidenceIds, 0.38));
  if (right.length > 0) roles.push(roleBinding("arg1", compactRoleValue(right), SEMANTIC_ROLE.ENTITY, evidenceIds, 0.38));
  for (let i = 0; i < Math.min(4, quantities.length); i++) {
    const item = quantities[i]!;
    roles.push(roleBinding(`q${i}`, item.symbol, SEMANTIC_ROLE.QUANTITY, evidenceIds, 0.14));
  }
  if (roles.length === 0) roles.push(roleBinding("span", symbols.filter(semanticSymbol).slice(0, 12).join(" "), SEMANTIC_ROLE.SPAN, evidenceIds, 1));
  return roles;
}

function roleBinding(name: string, value: string, type: SemanticRoleBinding["type"], evidenceIds: EvidenceId[] | undefined, weight: number): SemanticRoleBinding {
  const normalized = symbolizeData(value).join(" ");
  return {
    name,
    value,
    normalized,
    type,
    features: featureSet(value, 128),
    weight,
    evidenceId: evidenceIds?.[0]
  };
}

function compactRoleValue(symbols: readonly string[]): string {
  if (symbols.length <= 8) return symbols.join(" ");
  const scored = symbols
    .map((symbol, index) => ({ symbol, score: Math.min(1, symbol.length / 12) + index / symbols.length * 0.2 }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .sort((a, b) => symbols.indexOf(a.symbol) - symbols.indexOf(b.symbol));
  return scored.map(item => item.symbol).join(" ");
}

function deriveConstraints(sentence: string, symbols: readonly string[], hasher: Hasher, evidenceIds: EvidenceId[]): SemanticConstraint[] {
  const constraints: SemanticConstraint[] = [];
  for (let i = 0; i < symbols.length; i++) {
    const quantity = parseQuantitySymbol(symbols[i]!, symbols[i + 1]);
    if (quantity) {
      constraints.push({
        id: `constraint_${hasher.digestHex(`q:${sentence}:${i}:${symbols[i]}`).slice(0, 20)}`,
        kind: SEMANTIC_CONSTRAINT.QUANTITY,
        subject: `q${constraints.filter(c => c.kind === SEMANTIC_CONSTRAINT.QUANTITY).length}`,
        operator: SEMANTIC_OPERATOR.COMPATIBLE,
        value: toJsonValue(quantity),
        confidence: 0.72,
        evidenceIds
      });
    }
    const temporal = parseTemporalSymbol(symbols[i]!);
    if (temporal) {
      constraints.push({
        id: `constraint_${hasher.digestHex(`t:${sentence}:${i}:${symbols[i]}`).slice(0, 20)}`,
        kind: SEMANTIC_CONSTRAINT.TEMPORAL,
        subject: SEMANTIC_SUBJECT.TIME,
        operator: SEMANTIC_OPERATOR.OVERLAPS,
        value: toJsonValue(temporal),
        confidence: 0.68,
        evidenceIds
      });
    }
  }
  if (/[?]/.test(sentence)) {
    constraints.push({
      id: `constraint_${hasher.digestHex(`m:${sentence}`).slice(0, 20)}`,
      kind: SEMANTIC_CONSTRAINT.MODALITY,
      subject: SEMANTIC_SUBJECT.UTTERANCE,
      operator: SEMANTIC_OPERATOR.COMPATIBLE,
      value: SEMANTIC_MODALITY.POSSIBLE,
      confidence: 0.5,
      evidenceIds
    });
  }
  return constraints;
}

function buildPredicateFeatures(predicate: string, symbols: readonly string[], index: number): string[] {
  const window = symbols.slice(Math.max(0, index - 3), Math.min(symbols.length, index + 4));
  return [
    ...featureSet(predicate, 64),
    ...featureSet(window.join(" "), 128).map(feature => `ctx:${feature}`),
    `len:${Math.min(20, predicate.length)}`,
    `pos:${Math.round((index / Math.max(1, symbols.length - 1)) * 10)}`
  ];
}

function polarityFromSurface(sentence: string, symbols: readonly string[]): SemanticAtomPolarity {
  if (symbols.some(symbol => /^(?:!|-)$/u.test(symbol) || /^(?:!=)$/u.test(symbol))) return -1;
  if (/(?:!=|<>|!|\/=)/u.test(sentence)) return -1;
  return 1;
}

function modalityFromSurface(sentence: string, symbols: readonly string[], source: SemanticAtom["source"]): SemanticAtom["modality"] {
  if (source === SEMANTIC_SOURCE.GRAPH) return SEMANTIC_MODALITY.DERIVED;
  if (/[?]/.test(sentence)) return SEMANTIC_MODALITY.POSSIBLE;
  if (symbols.some(symbol => symbol.endsWith("!"))) return SEMANTIC_MODALITY.REQUIRED;
  return source === SEMANTIC_SOURCE.EVIDENCE ? SEMANTIC_MODALITY.OBSERVED : SEMANTIC_MODALITY.ASSERTED;
}

function semanticAtomId(hasher: Hasher, payload: unknown): string {
  return `atom_${hasher.digestHex(JSON.stringify(payload)).slice(0, 32)}`;
}

function semanticSymbol(symbol: string): boolean {
  return symbol.length > 0 && !/^\s+$/.test(symbol) && !/^[.,;:!?()[\]{}"']+$/.test(symbol);
}

function parseQuantitySymbol(symbol: string, next: string | undefined): SemanticQuantity | undefined {
  const cleaned = symbol.replace(/,/g, "");
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?%?$/i.test(cleaned)) return undefined;
  const percent = cleaned.endsWith("%");
  const value = Number.parseFloat(percent ? cleaned.slice(0, -1) : cleaned);
  if (!Number.isFinite(value)) return undefined;
  const unit = percent ? "%" : next && /^[A-Za-z][A-Za-z0-9/_-]{0,12}$/.test(next) ? next : undefined;
  return { value, unit, lower: value, upper: value, inclusiveLower: true, inclusiveUpper: true };
}

function parseTemporalSymbol(symbol: string): SemanticTemporalScope | undefined {
  const normalized = symbol.replace(/[.,]$/g, "");
  const iso = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(normalized);
  if (!iso) return undefined;
  const year = Number.parseInt(iso[1]!, 10);
  const month = iso[2] ? Number.parseInt(iso[2], 10) : 1;
  const day = iso[3] ? Number.parseInt(iso[3], 10) : 1;
  if (year < 1000 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const lower = Date.UTC(year, month - 1, day);
  const granularity: SemanticTemporalScope["granularity"] = iso[3] ? SEMANTIC_TEMPORAL_GRANULARITY.DAY : iso[2] ? SEMANTIC_TEMPORAL_GRANULARITY.MONTH : SEMANTIC_TEMPORAL_GRANULARITY.YEAR;
  const upper = granularity === SEMANTIC_TEMPORAL_GRANULARITY.DAY
    ? lower + 86_400_000
    : granularity === SEMANTIC_TEMPORAL_GRANULARITY.MONTH
      ? Date.UTC(year, month, 1)
      : Date.UTC(year + 1, 0, 1);
  return { lower, upper, instant: granularity === SEMANTIC_TEMPORAL_GRANULARITY.DAY ? lower : undefined, granularity };
}

function quantityFromJson(value: JsonValue): (SemanticQuantity & { operator?: string }) | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  const raw = record.value;
  if (typeof raw !== "number") return undefined;
  return {
    value: raw,
    unit: typeof record.unit === "string" ? record.unit : undefined,
    lower: typeof record.lower === "number" ? record.lower : raw,
    upper: typeof record.upper === "number" ? record.upper : raw,
    inclusiveLower: typeof record.inclusiveLower === "boolean" ? record.inclusiveLower : true,
    inclusiveUpper: typeof record.inclusiveUpper === "boolean" ? record.inclusiveUpper : true
  };
}

function temporalFromJson(value: JsonValue): SemanticTemporalScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  return {
    lower: typeof record.lower === "number" ? record.lower : undefined,
    upper: typeof record.upper === "number" ? record.upper : undefined,
    instant: typeof record.instant === "number" ? record.instant : undefined,
    granularity: typeof record.granularity === "string" ? record.granularity : SEMANTIC_TEMPORAL_GRANULARITY.UNKNOWN
  };
}

function normalizeUnit(unit: string): string {
  return unit.trim().toLowerCase().replace(/s$/u, "");
}

function normalizedEditSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const a = left.slice(0, 80);
  const b = right.slice(0, 80);
  const prev = new Array<number>(b.length + 1);
  const curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min((prev[j] ?? 0) + 1, (curr[j - 1] ?? 0) + 1, (prev[j - 1] ?? 0) + cost);
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j] ?? 0;
  }
  const distance = prev[b.length] ?? Math.max(a.length, b.length);
  return clamp01(1 - distance / Math.max(a.length, b.length, 1));
}
