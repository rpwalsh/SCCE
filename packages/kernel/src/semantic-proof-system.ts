// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
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
import { evaluateSemanticTransforms, semanticTransformRules } from "./semantic-transform-registry.js";
import { evidenceProofBoundary, graphNodePriorClass, isLearnedPriorClass } from "./proof-boundary.js";
import {
  compileRelationHypothesisModel,
  inferRelationHypotheses
} from "./relation-hypothesis.js";
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
  /** How far these two atoms are about the same proposition at all, before asking whether they agree. */
  correspondence: number;
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
  /** Two admitted sources, neither a learned prior, that refute each other. Distinct from claim-versus-evidence. */
  mutualSourceContradiction: boolean;
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
    atomizeClaim(text: string, grounding: readonly EvidenceSpan[] = []): SemanticAtom[] {
      return atomizeText({
        text,
        source: SEMANTIC_SOURCE.CLAIM,
        hasher,
        dimensions,
        maxAtoms: 128,
        groundingSurfaces: grounding.map(span => span.text)
      });
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
        maxAtoms: Math.max(1, input.maxAtoms ?? 96),
        // The claim is checked against this evidence, so this evidence is what can have grounded it.
        groundingSurfaces: input.evidence.map(span => span.text)
      });
      const evidenceAtoms = this.atomizeEvidence(input.evidence).slice(0, maxEvidenceAtoms);
      const graphAtoms = atomizeGraphNodes(input.nodes ?? [], hasher, dimensions).slice(0, 2048);
      const activeAtoms = applyFieldMass([...evidenceAtoms, ...graphAtoms], input.field);
      const allSupportAtoms = activeAtoms.length ? activeAtoms : [...evidenceAtoms, ...graphAtoms];
      // What counts as one source, for the purpose of two of them disagreeing.
      //
      // For a document it is the source version: two spans of one article are one source, and an article that
      // states a figure in its lede and another in a table is not a corpus in disagreement. For evidence the owner
      // asserted this session it is the span, because each turn is its own assertion -- the whole session shares
      // one source version by construction, and keying on that made two separate statements look like one source
      // and hid exactly the disagreement worth reporting.
      const independenceByEvidence = new Map<string, string>();
      for (const span of input.evidence) {
        const id = String(span.id);
        independenceByEvidence.set(id, id.startsWith(SESSION_EVIDENCE_ID_PREFIX) ? id : String(span.sourceVersionId));
      }
      const search = searchProof({ claimAtoms, supportAtoms: allSupportAtoms, hasher, independenceByEvidence });
      const graph = proofGraphFrom(search, claimAtoms, evidenceAtoms, graphAtoms);
      const replay = toJsonValue({
        claimHash: hasher.digestHex(input.claimText),
        // The transform registry this verdict was reached under. The record already names which transforms fired;
        // it did not say what the rule set was, so adding, removing or editing a rule changed replayed verdicts
        // silently and a proof id derived from this record stayed stable while its meaning moved.
        transformRegistry: transformRegistryFingerprint(hasher),
        claimAtomIds: claimAtoms.map(atom => atom.id),
        evidenceAtomIds: evidenceAtoms.map(atom => atom.id),
        graphAtomIds: graphAtoms.map(atom => atom.id),
        selectedSteps: search.steps.map(step => step.id),
        obligations: search.obligations.map(item => item.id),
        counterexamples: search.counterexamples.map(item => item.id),
        admission: search.admission,
        scores: {
          mutualSourceContradiction: search.mutualSourceContradiction,
        support: search.support,
          contradiction: search.contradiction,
          coverage: search.coverage,
          faithfulnessLcb: search.faithfulnessLcb
        }
      });
      return {
        id: `semantic_proof_${hasher.digestHex(JSON.stringify(replay)).slice(0, 32)}`,
        verdict: verdictFrom(search.support, search.contradiction, search.coverage, search.faithfulnessLcb, search.admission, search.mutualSourceContradiction),
        mutualSourceContradiction: search.mutualSourceContradiction,
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

/** Identity of the semantic transform rule set: its size and the ordered rule ids, hashed. Pure. */
function transformRegistryFingerprint(hasher: Hasher): { rules: number; digest: string } {
  const rules = semanticTransformRules();
  return {
    rules: rules.length,
    digest: hasher.digestHex(rules.map(rule => `${rule.id}:${rule.kind}`).join("|")).slice(0, 32)
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
  /** Source surfaces a claim may be grounded in, which decides its modality. Ignored for evidence and graph atoms. */
  groundingSurfaces?: readonly string[];
}): SemanticAtom[] {
  const hasher = input.hasher ?? createHasher();
  const dimensions = Math.max(16, Math.floor(input.dimensions ?? 64));
  const sentences = splitSemanticSentences(input.text).slice(0, input.maxAtoms ?? 256);
  const sentenceSymbols = sentences.map(sentence => symbolizeData(sentence));
  const relationModel = compileRelationHypothesisModel({
    observations: sentenceSymbols.map((symbols, sentenceIndex) => ({
      sourceId: `${input.source}:${sentenceIndex}`,
      symbols,
      evidenceIds: input.evidenceIds
    })),
    hasher
  });
  const atoms: SemanticAtom[] = [];
  for (let sentenceIndex = 0; sentenceIndex < sentences.length; sentenceIndex++) {
    const sentence = sentences[sentenceIndex]!;
    const symbols = sentenceSymbols[sentenceIndex] ?? [];
    if (symbols.length === 0) continue;
    const predicateHypotheses = inferRelationHypotheses({
      symbols,
      model: relationModel,
      candidate: semanticSymbol
    });
    const predicateSymbol = predicateHypotheses[0];
    if (!predicateSymbol) continue;
    const roles = deriveRoles(symbols, predicateSymbol.index, input.evidenceIds);
    const constraints = deriveConstraints(sentence, symbols, hasher, input.evidenceIds ?? []);
    const predicateFeatures = buildPredicateFeatures(predicateSymbol.surface, symbols, predicateSymbol.index);
    const polarity = polarityFromSurface(sentence, symbols);
    const grounded = sentenceGroundedInSurfaces(sentence, input.groundingSurfaces);
    const alpha = clamp01((input.alpha ?? 0.5) * (0.65 + Math.min(0.35, symbols.length / 80)));
    const vector = stableVector([...predicateFeatures, ...roles.flatMap(role => role.features), ...constraints.map(c => `${c.kind}:${c.subject}:${c.operator}:${JSON.stringify(c.value)}`)], hasher, dimensions);
    const id = semanticAtomId(hasher, {
      source: input.source,
      sentenceIndex,
      predicate: predicateSymbol.surface,
      roles: roles.map(role => [role.name, role.normalized]),
      constraints: constraints.map(c => [c.kind, c.subject, c.operator, c.value]),
      polarity,
      evidenceIds: input.evidenceIds ?? []
    });
    atoms.push({
      id,
      predicate: predicateSymbol.surface,
      predicateHypotheses,
      predicateFeatures,
      roles,
      constraints,
      polarity,
      alpha,
      modality: modalityFromSurface(sentence, symbols, input.source, grounded),
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
    // A node that already carries a proposition is read back as that proposition. Re-deriving one from the node's
    // text would make the stored predicate, roles and constraints advisory, and the answer would then depend on
    // whichever relation model happened to be in hand at read time rather than on what was established at write.
    const stored = propositionAtomFromNode(node, hasher, dimensions);
    if (stored) {
      atoms.push(stored);
      continue;
    }
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
  mutualSourceContradiction: boolean;
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

function searchProof(input: { claimAtoms: SemanticAtom[]; supportAtoms: SemanticAtom[]; hasher: Hasher; independenceByEvidence?: ReadonlyMap<string, string> }): ProofSearchIntermediate {
  const unifications: SemanticUnification[] = [];
  const obligations: ProofObligation[] = [];
  const counterexamples: ProofCounterexample[] = [];
  const steps: SemanticProofStep[] = [];
  const bestPerClaim = new Map<string, SemanticUnification>();
  const refutingAtomIds = new Set(input.supportAtoms.filter(atom => hasPredicateSubstance(atom.predicate)).map(atom => atom.id));
  for (const claim of input.claimAtoms) {
    // Support and refutation are chosen over the same candidates, and they used to be chosen independently: the
    // best supporting atom by support, the strongest counterexample by contradiction, with nothing requiring the
    // two to be about the same proposition. A candidate that disagrees about something the claim never asserted
    // could therefore carry the proof state of a claim it has no bearing on. What holds them in one correspondence
    // class is that contradiction is bounded by correspondence in unifyAtoms, so an atom about another proposition
    // cannot reach the threshold however strongly it disagrees about its own subject.
    let best: SemanticUnification | undefined;
    const claimUnifications: SemanticUnification[] = [];
    for (const candidate of input.supportAtoms) {
      const unified = unifyAtoms(claim, candidate);
      unifications.push(unified);
      claimUnifications.push(unified);
      if (!best || unified.support > best.support) best = unified;
    }
    let strongestCounterexample: SemanticUnification | undefined;
    // Only atoms that state a relation can refute one. Calibration over 708 labelled pairs put every single residual
    // false positive in the same class: unscrubbed table markup, which atomizes with a punctuation predicate and
    // whose long token runs disagree at 0.47-0.58, inside the band where real disagreements live. Excluding them is
    // what makes the two classes separable, and the threshold below is read off that separation.
    if (hasPredicateSubstance(claim.predicate)) {
      for (const unified of claimUnifications) {
        if (!refutingAtomIds.has(unified.rightAtomId)) continue;
        if (unified.contradiction > (strongestCounterexample?.contradiction ?? 0)) strongestCounterexample = unified;
      }
    }
    if (best && best.support > PROOF_DIRECT_SUPPORT_THRESHOLD) {
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
      if (best.missingRoles.length > 0 || best.violatedConstraints.length > 0 || best.transformObligations.length > 0) {
        steps.push({
          id: `step_${input.hasher.digestHex(`constraint:${claim.id}:${best.rightAtomId}`).slice(0, 24)}`,
          rule: PROOF_RULE.CONSTRAINT,
          premises: [best.rightAtomId],
          conclusion: claim.id,
          support: Math.max(0, best.constraints - openObligationCount(best) * 0.12),
          contradiction: best.violatedConstraints.length ? Math.min(1, best.violatedConstraints.length * 0.18) : 0,
          evidenceIds: best.evidenceIds,
          audit: toJsonValue({ missingRoles: best.missingRoles, violatedConstraints: best.violatedConstraints, transformObligations: best.transformObligations })
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
    if (strongestCounterexample && strongestCounterexample.contradiction > PROOF_CONTRADICTION_THRESHOLD) {
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
  // Scored BEFORE the mutual-source pass appends to the same list. "Do these sources disagree with each other" is a
  // different question from "does the evidence refute this claim", and folding the first into the second let a
  // disagreement between two admitted sources set the claim's own contradiction mass -- measured on "Who was Charles
  // Babbage?": the claim's own strongest counterexample was under threshold, eight mutual pairs were not, and their
  // 0.569 maximum became the claim's, which blocked a source excerpt that nothing in the corpus contradicted. The
  // mutual finding keeps its own channel (mutualSourceContradiction) and its own answer plan; it is reported, never
  // charged to the claim.
  const contradiction = counterexamples.length
    ? Math.max(...counterexamples.map(item => item.contradiction))
    : selected.length
      ? Math.max(...selected.map(item => item.contradiction))
      : 0;
  const mutualSourceContradiction = collectMutuallyContradictorySupport(input.supportAtoms, input.hasher, counterexamples, steps, unifications, input.independenceByEvidence);
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
  return { mutualSourceContradiction, support, contradiction, coverage, faithfulnessLcb, admission, obligations, counterexamples, steps, unifications };
}

/** Everything left open on a unification: constraints it violated, plus inferences it has not licensed. Pure. */
function openObligationCount(unification: SemanticUnification): number {
  return unification.violatedConstraints.length + unification.transformObligations.length;
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
  const correspondence = correspondenceScore(predicate, roleMatch.score);
  // Disagreement, then aboutness, multiplied once. A refutation therefore never exceeds the correspondence it
  // rests on, so an atom about another proposition cannot become this claim's counterexample however strongly it
  // disagrees about its own subject. Measured before this: contradiction ran up to 0.11 over correspondence.
  const disagreement = clamp01(contradictionScore(left, right, constraintMatch.violations.length) + transforms.contradictionBoost);
  const contradiction = clamp01(disagreement * correspondence);
  const support = clamp01(agreement * (0.45 + 0.55 * alpha) * (1 - contradiction * 0.62));
  return {
    leftAtomId: left.id,
    rightAtomId: right.id,
    correspondence,
    predicate,
    roles: roleMatch.score,
    constraints: constraintMatch.score,
    polarity,
    alpha,
    support,
    contradiction,
    missingRoles: roleMatch.missing,
    // Constraint violations only. An obligation is not a violation: a violation says the evidence positively
    // conflicts with the claim, an obligation says the inference has not been shown to be licensed. Merging them
    // made every consumer that asks "which constraints were violated" answer with modality obligations too, so a
    // counterexample raised by an epistemic gap was reported as a constraint conflict and certification checked
    // the same fact twice. transformObligations carries them, and the callers that want both now say so.
    violatedConstraints: [...constraintMatch.violations],
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
  const posterior = relationPosteriorSimilarity(left, right);
  const feature = weightedJaccard(left.predicateFeatures, right.predicateFeatures);
  const vector = clamp01((cosineSimilarity(left.vector, right.vector) + 1) / 2);
  return clamp01(0.35 * posterior + 0.25 * lexical + 0.25 * feature + 0.15 * vector);
}

function relationPosteriorSimilarity(left: SemanticAtom, right: SemanticAtom): number {
  const leftRows = left.predicateHypotheses?.length
    ? left.predicateHypotheses
    : [{ surface: left.predicate, posterior: 1 }];
  const rightRows = right.predicateHypotheses?.length
    ? right.predicateHypotheses
    : [{ surface: right.predicate, posterior: 1 }];
  let score = 0;
  for (const leftRow of leftRows) {
    for (const rightRow of rightRows) {
      const similarity = leftRow.surface === rightRow.surface
        ? 1
        : normalizedEditSimilarity(leftRow.surface, rightRow.surface);
      score += leftRow.posterior * rightRow.posterior * similarity;
    }
  }
  return clamp01(score);
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

/** How far two atoms are about the same proposition: the predicate they name, and the roles they fill. Pure. */
function correspondenceScore(predicate: number, roles: number): number {
  return predicate * 0.6 + roles * 0.4;
}

/**
 * How far two atoms disagree, on its own scale, before any question of whether they are about the same thing.
 *
 * Each term used to be multiplied by correspondence here and the transform boost added afterwards, so two
 * individually bounded quantities could sum past the bound and a pair could be scored as refuting each other
 * harder than they corresponded at all. Disagreement and aboutness are now separate, and unifyAtoms multiplies
 * once, which makes "a refutation never exceeds its correspondence" hold by construction rather than by luck.
 */
function contradictionScore(left: SemanticAtom, right: SemanticAtom, violatedConstraints: number): number {
  const polarityConflict = left.polarity !== right.polarity ? 1 : 0;
  const hardConstraint = Math.min(1, violatedConstraints * 0.22);
  const quantityConflict = quantityContradiction(left.constraints, right.constraints);
  const temporalConflict = temporalContradiction(left.constraints, right.constraints);
  return clamp01(Math.max(polarityConflict, hardConstraint, quantityConflict, temporalConflict));
}

function quantityContradiction(left: readonly SemanticConstraint[], right: readonly SemanticConstraint[]): number {
  let score = 0;
  for (const l of left.filter(isQuantityConstraint)) {
    for (const r of right.filter(isQuantityConstraint)) {
      // Two quantities disagree only if they measure the same thing, and the subject is what records that.
      // Comparing every quantity against every other made a sentence contradict itself: "commissioned on 11 April
      // 1988" carries 11 and 1988, they are disjoint, and the pair scored 0.75 -- so the claim contradicted the
      // very source it was read out of, on every factual turn carrying more than one number. Unit alone could not
      // separate them because the guard below only skips when BOTH sides name a unit, and a bare year names none.
      if (l.subject !== r.subject) continue;
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
    predicateHypotheses: atom.predicateHypotheses ?? [],
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
  // A modality gap is an unmet source obligation, not a violated constraint, and the kind has to say which.
  const kind: ProofObligation["kind"] = !best
    ? PROOF_OBLIGATION_KIND.PREDICATE
    : missingRoles.length
      ? PROOF_OBLIGATION_KIND.ROLE
      : best.violatedConstraints.length
        ? PROOF_OBLIGATION_KIND.CONSTRAINT
        : PROOF_OBLIGATION_KIND.SOURCE;
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

/** Evidence the owner asserted in this session: each span is its own assertion, not part of one document. */
const SESSION_EVIDENCE_ID_PREFIX = "evidence_session_";

/** Support atoms compared per predicate stay bounded; a source set larger than this is truncated, never scanned whole. */
const MUTUAL_CONTRADICTION_GROUP_LIMIT = 12;

/** Total pairs compared across all predicates in one proof, so the turn budget cannot be spent here. */
const MUTUAL_CONTRADICTION_PAIR_LIMIT = 96;

/**
 * Two admitted sources that disagree with each other, which claim-versus-source comparison cannot see.
 *
 * searchProof unifies each claim atom against the support atoms and records the strongest disagreement it finds.
 * That answers "does the evidence refute this claim" and cannot answer "do these sources refute each other", and
 * the second is the question a reader has when two filings name different years for the same appointment. It is
 * not reachable by the first: measured on that pair, the claim is the cleaned answer excerpt and unifies with the
 * prefixed source sentences at 0.27, under the threshold, while the two sources unify with each other at 0.52 and
 * disagree on the year. So the turn stated the earlier filing as fact and the disagreement was never surfaced.
 *
 * Only atoms sharing a predicate are compared -- two propositions about different relations holding different
 * values are not in conflict -- and only atoms resting on different evidence, so a source cannot contradict its
 * own restatement. Both bounds above are hard, because this is the one place in the proof whose cost is quadratic
 * in the size of the admitted evidence.
 */
/**
 * Whether a predicate names a relation at all, rather than being surviving punctuation.
 *
 * Exported so the calibration harness admits exactly what the proof admits: a rule the harness restates in its own
 * words is a rule that can drift away from the one being measured.
 */
export function hasPredicateSubstance(predicate: string): boolean {
  return /[\p{Letter}\p{Number}]/u.test(predicate);
}

function collectMutuallyContradictorySupport(
  supportAtoms: readonly SemanticAtom[],
  hasher: Hasher,
  counterexamples: ProofCounterexample[],
  steps: SemanticProofStep[],
  unifications: SemanticUnification[],
  independenceByEvidence?: ReadonlyMap<string, string>
): boolean {
  let found = false;
  const byPredicate = new Map<string, SemanticAtom[]>();
  for (const atom of supportAtoms) {
    if (!atom.predicate) continue;
    // A predicate carrying no letter or number is not a relation, it is punctuation that survived ingestion. Measured
    // on the live corpus: unscrubbed wikitext table rows atomize with predicate "|", every such atom lands in that one
    // group, and their sorted token runs disagree pairwise at 0.42-0.57 -- eight mutual "contradictions" between two
    // articles that contradict nothing. Character classes, not a word list, so this holds in any script.
    if (!hasPredicateSubstance(atom.predicate)) continue;
    const group = byPredicate.get(atom.predicate);
    if (group) { if (group.length < MUTUAL_CONTRADICTION_GROUP_LIMIT) group.push(atom); }
    else byPredicate.set(atom.predicate, [atom]);
  }
  let pairs = 0;
  for (const group of byPredicate.values()) {
    if (group.length < 2) continue;
    for (let left = 0; left < group.length; left++) {
      for (let right = left + 1; right < group.length; right++) {
        if (pairs >= MUTUAL_CONTRADICTION_PAIR_LIMIT) return found;
        pairs += 1;
        const first = group[left]!;
        const second = group[right]!;
        if (!fromDifferentSources(first, second, independenceByEvidence)) continue;
        // Sources, not priors. A learned prior disagreeing with a source is not two sources disagreeing, and must
        // not stop the turn asserting what its evidence says. Certification is deliberately not the test: session
        // evidence the owner stated this turn is uncertified by construction, and two owner statements that
        // disagree are exactly the case worth reporting.
        if (isLearnedPriorClass(first.proofClass) || isLearnedPriorClass(second.proofClass)) continue;
        const unified = unifyAtoms(first, second);
        unifications.push(unified);
        // Two sources disagree only if they are speaking about the same proposition. Without this a source could
        // be reported as refuting another that it merely fails to resemble.
        if (unified.correspondence <= 0) continue;
        if (!(unified.contradiction > PROOF_CONTRADICTION_THRESHOLD)) continue;
        const evidenceIds = [...new Set([...first.evidenceIds, ...second.evidenceIds])];
        found = true;
        counterexamples.push({
          id: `counterexample_${hasher.digestHex(`mutual:${first.id}:${second.id}`).slice(0, 24)}`,
          claimAtomId: first.id,
          evidenceAtomId: second.id,
          reason: contradictionReason(unified),
          contradiction: unified.contradiction,
          evidenceIds
        });
        steps.push({
          id: `step_${hasher.digestHex(`mutual-contradiction:${first.id}:${second.id}`).slice(0, 24)}`,
          rule: PROOF_RULE.CONTRADICTION,
          premises: [first.id, second.id],
          conclusion: second.id,
          support: unified.support,
          contradiction: unified.contradiction,
          evidenceIds,
          audit: toJsonValue({ mutualSupportContradiction: true, predicate: first.predicate })
        });
      }
    }
  }
  return found;
}

/**
 * Whether two atoms rest on genuinely different documents.
 *
 * Two spans of one article carry different evidence ids and are not two sources: an article that states a figure
 * in its lede and a different one in a table is not a corpus in disagreement, and treating it as one would refuse
 * to answer from any document that mentions two numbers. Source version is the identity that decides this, and
 * evidence identity is only the fallback for atoms whose spans were not passed in.
 */
function fromDifferentSources(
  left: SemanticAtom,
  right: SemanticAtom,
  independenceByEvidence?: ReadonlyMap<string, string>
): boolean {
  if (!left.evidenceIds.length || !right.evidenceIds.length) return false;
  if (independenceByEvidence?.size) {
    const leftKeys = new Set(left.evidenceIds.map(id => independenceByEvidence.get(String(id))).filter(Boolean));
    const rightKeys = right.evidenceIds.map(id => independenceByEvidence.get(String(id))).filter(Boolean);
    if (leftKeys.size && rightKeys.length) return !rightKeys.some(key => leftKeys.has(key));
  }
  const seen = new Set(left.evidenceIds.map(String));
  return !right.evidenceIds.some(id => seen.has(String(id)));
}

function contradictionReason(unification: SemanticUnification): string {
  if (unification.polarity === 0 && unification.predicate > 0.45 && unification.roles > 0.35) return PROOF_COUNTEREXAMPLE_REASON.POLARITY;
  if (unification.violatedConstraints.length > 0) return `${PROOF_COUNTEREXAMPLE_REASON.CONSTRAINT}:${unification.violatedConstraints.slice(0, 3).join(",")}`;
  // An outstanding obligation is not a constraint conflict, and reporting it as one sent a reader looking for a
  // disagreement between values that does not exist.
  if (unification.transformObligations.length > 0) return `${PROOF_COUNTEREXAMPLE_REASON.ALPHA_INCOMPATIBLE}:${unification.transformObligations.slice(0, 3).join(",")}`;
  return PROOF_COUNTEREXAMPLE_REASON.ALPHA_INCOMPATIBLE;
}

/**
 * The verdict, with one rule that does not go through a threshold.
 *
 * The contradiction bound below answers "is the claim refuted by the evidence", and is calibrated for that. Two
 * certified sources refuting each other is a different fact about the corpus, and a stronger one: it does not
 * depend on how well the claim happens to unify with either of them, and it leaves the turn no ground to assert
 * either side. Measured on two filings naming different years for one appointment, that disagreement scores 0.52
 * -- under a bound written for claim-versus-evidence -- so the turn asserted the earlier filing as fact and the
 * reader never learned the sources disagreed. Reporting that is the product's reason for existing.
 */
function verdictFrom(support: number, contradiction: number, coverage: number, faithfulnessLcb: number, admission: ProofSearchIntermediate["admission"], mutualSourceContradiction = false): SemanticProofVerdict {
  if (mutualSourceContradiction) return SEMANTIC_VERDICT.CONTRADICTED;
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
    // A number that names what it measures is a measurement, not a year. Reading both from one token made
    // "3412 metres" the year 3412 as well, and the sentence then held two disjoint intervals and contradicted
    // itself. Only a bare number can be a year.
    const temporal = quantity?.unit ? undefined : parseTemporalSymbol(symbols[i]!);
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

/**
 * Whether the sentence asserts its proposition or denies it.
 *
 * A bare exclamation mark used to count as a denial, so every emphatic sentence was read as negated -- and
 * modalityFromSurface reads the same character as REQUIRED, so one mark meant both "required" and "not" at once
 * and any emphatic claim took a polarity conflict against its own source. polarityConflict is the largest term in
 * contradictionScore, so that conflict alone drove disagreement to 1 and the contradiction to the full
 * correspondence of the pair: measured at 0.66 between "the reactor must be commissioned on 11 April 1988!" and
 * the sentence it was written from.
 *
 * What remains are the inequality operators, which deny in any notation, and "!" where it prefixes what it
 * negates rather than closing a sentence.
 */
function polarityFromSurface(sentence: string, symbols: readonly string[]): SemanticAtomPolarity {
  void symbols;
  if (/(?:!=|<>|\/=)/u.test(sentence)) return -1;
  if (/![\p{Letter}\p{Number}_(]/u.test(sentence)) return -1;
  return 1;
}

/**
 * The epistemic status of a proposition, which is not the same thing as which side of a proof it sits on.
 *
 * A claim read out of a source has been observed, exactly as the source has. Minting it ASSERTED because its
 * `source` field is not EVIDENCE ranked every claim above its own evidence, so modalityCompatibility raised an
 * obligation and charged contradiction on every factual turn in the product -- and since unifyAtoms scales
 * contradiction by predicate and role similarity, the closer a source matched the claim the more contradictory it
 * scored. Measured on one turn: the answer's own source reached 0.63 while unrelated bigram atoms sat at 0.24, so
 * the turn was ruled contradicted and reported insufficient support over a correct, cited answer.
 *
 * The ladder is unchanged and still does its work. A question stays POSSIBLE however well the evidence matches it,
 * an emphatic claim stays REQUIRED and still owes an obligation against merely observed evidence, and a claim no
 * source states stays ASSERTED -- the system asserting it on its own authority is precisely what that means.
 */
function modalityFromSurface(
  sentence: string,
  symbols: readonly string[],
  source: SemanticAtom["source"],
  groundedInEvidence = false
): SemanticAtom["modality"] {
  if (source === SEMANTIC_SOURCE.GRAPH) return SEMANTIC_MODALITY.DERIVED;
  if (/[?]/.test(sentence)) return SEMANTIC_MODALITY.POSSIBLE;
  if (symbols.some(symbol => symbol.endsWith("!"))) return SEMANTIC_MODALITY.REQUIRED;
  if (source === SEMANTIC_SOURCE.EVIDENCE) return SEMANTIC_MODALITY.OBSERVED;
  return groundedInEvidence ? SEMANTIC_MODALITY.OBSERVED : SEMANTIC_MODALITY.ASSERTED;
}

/** Whether a source surface states this sentence, compared on its own words rather than on punctuation. Pure. */
function sentenceGroundedInSurfaces(sentence: string, surfaces: readonly string[] | undefined): boolean {
  if (!surfaces?.length) return false;
  const wanted = groundingKey(sentence);
  if (!wanted) return false;
  return surfaces.some(surface => groundingKey(surface).includes(wanted));
}

/** A surface reduced to its lexical symbols, so quoting differences and spacing do not decide provenance. Pure. */
function groundingKey(text: string): string {
  return symbolizeData(text)
    .filter(symbol => [...symbol].some(char => /[\p{Letter}\p{Number}]/u.test(char)))
    .join(" ");
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

/**
 * A temporal scope, or nothing when the value does not carry one.
 *
 * This returned a scope for ANY object, so isTemporalConstraint matched every constraint and quantities were
 * compared as instants: "commissioned on 11 April 1988" carries 11 and 1988, read as two time intervals they are
 * disjoint, and the sentence contradicted itself at 0.55. A quantity is not a time, and the two temporal markers
 * -- a granularity or an instant -- are what tell them apart.
 */
function temporalFromJson(value: JsonValue): SemanticTemporalScope | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, JsonValue>;
  if (typeof record.granularity !== "string" && typeof record.instant !== "number") return undefined;
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

/** Identifies a graph node whose representation IS a proposition rather than a surface to be parsed. */
/**
 * The unification contradiction mass at which a counterexample is admitted as one.
 *
 * Calibrated, not chosen. `tools/proof-calibration/calibrate.mjs` scores 14 constructed minimal pairs (two sentences
 * identical but for one asserted date, measurement or count -- the label is carried by the construction) against 476
 * non-contradictions: restatements, the same predicate over different subjects, different predicates over one
 * subject, and real sentence pairs drawn from inside single corpus documents. Under the same admission rule the
 * proof uses, the two classes separate completely -- AUROC 1.0, every non-contradiction at or below 0.4452, every
 * real disagreement at or above 0.4780 -- so any cut in [0.4452, 0.4780) is exact on that set. 0.46 sits near the
 * centre of that gap, which is the placement that survives the most movement in either class.
 *
 * The previous value, 0.42, was inherited unmeasured from the initial source release and lies INSIDE the
 * non-contradiction distribution: it cost 3 false conflicts on ordinary prose at no gain in recall, and a false
 * conflict here suppresses a correct answer rather than merely adding noise -- measured on "Who was Charles
 * Babbage?", where fabricated conflicts blocked a source excerpt nothing in the corpus contradicted.
 *
 * Rerun the harness after any change to unifyAtoms; a scoring change moves the distributions and this cut with them.
 */
export const PROOF_CONTRADICTION_THRESHOLD = 0.46;

/**
 * The unification support at which an atom is admitted as DIRECT evidence for a claim.
 *
 * Calibrated by the same harness. 12 facts each stated two ways give the positives (one proposition, reworded);
 * every cross-pairing of those same sentences gives 132 negatives sharing no subject, predicate or value -- built
 * from one table so the two classes are identical in shape and length and cannot be separated on surface form. They
 * separate completely: AUROC 1.0, every unrelated pair at or below 0.2521, every restatement at or above 0.3068.
 *
 * The previous value, 0.12, sits far below the entire negative distribution: measured FPR 1.00, so every unrelated
 * fact in the admitted evidence was accepted as direct support for the claim. That is not a loose gate, it is no
 * gate. 0.28 centres the separating window.
 */
export const PROOF_DIRECT_SUPPORT_THRESHOLD = 0.28;

export const PROPOSITION_GRAPH_NODE_SCHEMA = "scce.proposition_node.v1" as const;

/**
 * The representation a graph node carries so that a proposition survives persistence as a proposition.
 *
 * atomizeText already derives predicate, bound roles and typed constraints from a sentence, and the proof search
 * already contradicts atoms; both ran only at turn time, so every proposition the engine compiled was discarded
 * when the turn ended. Writing the atom itself -- not a sentence to be re-read -- is what lets it cross into the
 * graph and come back the same proposition. `text` stays alongside so citation and retrieval still have the
 * source surface, and so a reader that predates this schema degrades to parsing it rather than to nothing.
 */
export function propositionNodeRepresentation(atom: SemanticAtom): JsonValue {
  return toJsonValue({
    schema: PROPOSITION_GRAPH_NODE_SCHEMA,
    predicate: atom.predicate,
    predicateFeatures: atom.predicateFeatures,
    roles: atom.roles as unknown as JsonValue,
    constraints: atom.constraints as unknown as JsonValue,
    polarity: atom.polarity,
    modality: atom.modality,
    alpha: atom.alpha,
    proofClass: atom.proofClass,
    certifiesFactualProof: atom.certifiesFactualProof,
    proofBoundaryReason: atom.proofBoundaryReason ?? null,
    text: atom.sourceText
  });
}

/** The proposition a node carries, rehydrated, or undefined when the node carries a surface instead. Pure. */
function propositionAtomFromNode(node: GraphNode, hasher: Hasher, dimensions: number): SemanticAtom | undefined {
  const representation = node.representation;
  if (!representation || typeof representation !== "object" || Array.isArray(representation)) return undefined;
  const record = representation as Record<string, JsonValue>;
  if (record.schema !== PROPOSITION_GRAPH_NODE_SCHEMA) return undefined;
  const predicate = typeof record.predicate === "string" ? record.predicate : "";
  if (!predicate) return undefined;
  const roles = (Array.isArray(record.roles) ? record.roles : []) as unknown as SemanticRoleBinding[];
  const constraints = (Array.isArray(record.constraints) ? record.constraints : []) as unknown as SemanticConstraint[];
  const predicateFeatures = Array.isArray(record.predicateFeatures)
    ? record.predicateFeatures.filter((feature): feature is string => typeof feature === "string")
    : [];
  const sourceText = typeof record.text === "string" ? record.text : "";
  const polarity: SemanticAtomPolarity = record.polarity === -1 ? -1 : 1;
  // The same vector the atom had when it was written: stableVector is deterministic in these features, so it is
  // recomputed rather than stored, and a node cannot carry a vector that disagrees with its own proposition.
  const vector = stableVector([
    ...predicateFeatures,
    ...roles.flatMap(role => role.features),
    ...constraints.map(constraint =>
      `${constraint.kind}:${constraint.subject}:${constraint.operator}:${JSON.stringify(constraint.value)}`)
  ], hasher, dimensions);
  const proofClass = typeof record.proofClass === "string" ? record.proofClass : "none";
  return {
    id: semanticAtomId(hasher, {
      graphNode: node.id,
      predicate,
      roles: roles.map(role => [role.name, role.normalized]),
      constraints: constraints.map(constraint =>
        [constraint.kind, constraint.subject, constraint.operator, constraint.value]),
      polarity,
      evidenceIds: node.evidenceIds
    }),
    predicate,
    predicateFeatures,
    roles,
    constraints,
    polarity,
    alpha: typeof record.alpha === "number" ? clamp01(record.alpha) : node.alpha,
    modality: typeof record.modality === "string" ? record.modality : SEMANTIC_SOURCE.GRAPH,
    source: SEMANTIC_SOURCE.GRAPH,
    sourceText,
    evidenceIds: node.evidenceIds,
    nodeIds: [node.id],
    vector,
    proofClass,
    certifiesFactualProof: record.certifiesFactualProof === true,
    ...(typeof record.proofBoundaryReason === "string" ? { proofBoundaryReason: record.proofBoundaryReason } : {})
  };
}
