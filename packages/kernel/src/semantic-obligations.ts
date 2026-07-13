import type {
  Claim,
  EvidenceId,
  EvidenceSpan,
  FieldState,
  GraphNode,
  Hasher,
  JsonValue,
  ProofGraphEdge,
  ProofGraphNode,
  SemanticCounterexampleTrace,
  SemanticEntailmentScores,
  SemanticObligationKind,
  SemanticObligationRecord,
  SemanticObligationStatus,
  SemanticEntailmentVerdict,
  SemanticMissingObligationTrace,
  SemanticProofMapping,
  SemanticTransformTrace,
  SourceVersionId
} from "./types.js";
import { clamp01, featureSet, mean, stableVector, toJsonValue, symbolizeData, weightedJaccard } from "./primitives.js";
import { hoeffdingLcb } from "./causal-math.js";
import { evidenceProofBoundary } from "./proof-boundary.js";

export interface SemanticObligationEvaluation {
  verdict: SemanticEntailmentVerdict;
  scores: SemanticEntailmentScores;
  obligations: SemanticObligationRecord[];
  evidenceIds: EvidenceId[];
  sourceVersionIds: SourceVersionId[];
  proofGraph: { nodes: ProofGraphNode[]; edges: ProofGraphEdge[] };
  mappings: SemanticProofMapping[];
  transforms: SemanticTransformTrace[];
  counterexamples: SemanticCounterexampleTrace[];
  missing: SemanticMissingObligationTrace[];
  support: number;
  contradiction: number;
  faithfulnessLcb: number;
  boundaries: string[];
  audit: JsonValue;
}

interface SemanticItem {
  kind: SemanticObligationKind;
  value: string;
  normalized: string;
  features: string[];
  span?: EvidenceSpan;
  byteRange?: [number, number];
  contextFeatures: string[];
}

interface EvidenceMatch {
  item?: SemanticItem;
  span?: EvidenceSpan;
  support: number;
  contradiction: number;
  status: SemanticObligationStatus;
  reason: string;
}

interface ProofAdmission {
  admitted: boolean;
  supportCeiling: number;
  reasons: string[];
  inadmissibleObligationIds: string[];
  admissibleEvidenceIds: EvidenceId[];
}

export function evaluateSemanticObligations(input: {
  claim: Claim;
  evidence: EvidenceSpan[];
  nodes: GraphNode[];
  field: FieldState;
  hasher: Hasher;
}): SemanticObligationEvaluation {
  const evidenceBoundaries = input.evidence.map(evidenceProofBoundary);
  const certifyingEvidenceIdSet = new Set(evidenceBoundaries.filter(item => item.certifiesFactualProof).map(item => item.evidenceId));
  const certifyingEvidence = input.evidence.filter(span => certifyingEvidenceIdSet.has(String(span.id)));
  const excludedEvidence = evidenceBoundaries.filter(item => !item.certifiesFactualProof);
  const claimItems = extractSemanticItems(input.claim.text, "claim", undefined).filter(item => item.kind !== "source_version");
  const evidenceItems = certifyingEvidence.flatMap(span => extractSemanticItems(span.text || span.textPreview, "evidence", span));
  const evidenceByKind = groupByKind(evidenceItems);
  const fieldMassByEvidence = fieldMass(input.nodes, input.field);
  const obligations: SemanticObligationRecord[] = [];
  for (const item of materialClaimItems(input.claim, claimItems)) {
    const match = matchItem(item, evidenceByKind.get(item.kind) ?? [], certifyingEvidence, fieldMassByEvidence, input.hasher);
    obligations.push(obligationRecord(item, match));
  }
  obligations.push(...sourceVersionObligations(certifyingEvidence, input.evidence.length, excludedEvidence));
  obligations.push(...transformObligations(input.claim, certifyingEvidence, input.hasher));
  obligations.push(...roleObligations(input.claim, certifyingEvidence, input.hasher));

  const required = obligations.filter(item => item.required);
  const satisfied = required.filter(item => item.status === "satisfied");
  const contradicted = required.filter(item => item.status === "contradicted");
  const missingRequired = required.filter(item => item.status === "missing");
  const underdetermined = required.filter(item => item.status === "underdetermined");
  const evidenceIds = [...new Set(obligations.flatMap(item => item.evidenceIds))];
  const sourceVersionIds = [...new Set(obligations.flatMap(item => item.sourceVersionIds))];
  const structuralCoverage = required.length ? satisfied.length / required.length : input.evidence.length ? 0.35 : 0;
  const roleCoverage = coverageForKind(required, "role");
  const relationCompatibility = relationCompatibilityScore(input.claim, input.evidence, input.hasher);
  const transformationSupport = coverageForKind(required, "transform");
  const causalMass = clamp01(mean([
    ...evidenceIds.map(id => fieldMassByEvidence.get(String(id)) ?? 0),
    ...input.field.causalMass.slice(0, 16).map(item => item.mass)
  ]));
  const contradiction = clamp01(mean(contradicted.map(item => item.contradiction)) + contradictionPressure(required, input.field));
  const stability = clamp01(1 - input.field.alphaTrace.surfaces.drift * 0.55 - input.field.alphaTrace.bondedLeakage * 0.25 - contradiction * 0.2);
  const faithfulnessLCB = hoeffdingLcb(satisfied.map(item => item.support), 0.05);
  const scores: SemanticEntailmentScores = {
    structuralCoverage,
    roleCoverage,
    relationCompatibility,
    transformationSupport,
    causalMass,
    faithfulnessLCB,
    contradiction,
    stability
  };
  const admission = proofAdmission({ required, evidenceCount: input.evidence.length, certifyingEvidenceCount: certifyingEvidence.length, excludedEvidenceCount: excludedEvidence.length, scores });
  const rawSupport = clamp01(
    0.26 * structuralCoverage +
    0.18 * roleCoverage +
    0.18 * relationCompatibility +
    0.13 * transformationSupport +
    0.15 * causalMass +
    0.1 * faithfulnessLCB -
    0.28 * contradiction
  );
  const support = Math.min(rawSupport, admission.supportCeiling);
  const verdict = semanticVerdict({ required, structuralCoverage, roleCoverage, relationCompatibility, transformationSupport, causalMass, faithfulnessLCB, contradiction, stability, admission });
  const mappings = obligationMappings(obligations);
  const transforms = transformTraces(obligations);
  const counterexamples = counterexampleTraces(obligations, input.field);
  const missing = missingTraces(obligations);
  const boundaries = boundaryReasons({ required, contradicted, missing: missingRequired, underdetermined, scores, evidenceIds, admission });
  const proofGraph = enrichProofGraph(obligationGraph(input.claim, obligations), mappings, transforms, counterexamples);
  return {
    verdict,
    scores,
    obligations,
    evidenceIds,
    sourceVersionIds,
    proofGraph,
    mappings,
    transforms,
    counterexamples,
    missing,
    support,
    contradiction,
    faithfulnessLcb: faithfulnessLCB,
    boundaries,
    audit: toJsonValue({
      verdict,
      scores,
      required: required.length,
      satisfied: satisfied.length,
      contradicted: contradicted.length,
      missing: missingRequired.length,
      underdetermined: underdetermined.length,
      mappings: mappings.length,
      transforms: transforms.length,
      counterexamples: counterexamples.length,
      evidenceIds: evidenceIds.map(String),
      sourceVersionIds: sourceVersionIds.map(String),
      proofAdmission: admission,
      rawSupport,
      obligationKinds: countBy(obligations.map(item => item.kind)),
      proofBoundary: {
        certifyingEvidenceCount: certifyingEvidence.length,
        excludedEvidenceCount: excludedEvidence.length,
        forceClasses: countBy(evidenceBoundaries.map(item => item.forceClass)),
        excluded: excludedEvidence.slice(0, 64)
      }
    })
  };
}

function materialClaimItems(claim: Claim, extracted: SemanticItem[]): SemanticItem[] {
  const material = [...extracted];
  if (!material.some(item => item.kind === "predicate")) material.push({
    kind: "predicate",
    value: claim.normalized.slice(0, 280),
    normalized: claim.normalized,
    features: claim.features.slice(0, 256),
    contextFeatures: claim.features.slice(0, 128)
  });
  if (claim.polarity < 0 && !material.some(item => item.kind === "negation")) material.push({
    kind: "negation",
    value: "operator-negation",
    normalized: "operator-negation",
    features: ["operator:negation"],
    contextFeatures: claim.features.slice(0, 128)
  });
  return dedupeItems(material).slice(0, 80);
}

function extractSemanticItems(text: string, source: "claim" | "evidence", span?: EvidenceSpan): SemanticItem[] {
  const items: SemanticItem[] = [];
  const symbols = symbolizeData(text);
  const tokenFeatures = featureSet(text, 512);
  const add = (kind: SemanticObligationKind, value: string, contextText: string, byteRange?: [number, number]) => {
    const normalized = normalizeValue(value);
    if (!normalized) return;
    items.push({
      kind,
      value,
      normalized,
      features: itemFeatures(kind, value),
      span,
      byteRange,
      contextFeatures: featureSet(contextText, 192)
    });
  };
  for (const match of matchAll(text, /(?:\b|^)(?:[A-Z][\p{Letter}\p{Mark}\p{Number}_-]{1,}(?:\s+[A-Z][\p{Letter}\p{Mark}\p{Number}_-]{1,}){0,5}|[A-Z]{2,}[\p{Letter}\p{Number}_-]*)(?:\b|$)/gu)) {
    add("entity", match.value, contextWindow(text, match.index, match.value.length), [match.index, match.index + match.value.length]);
  }
  for (const match of matchAll(text, /(?:^|[^\p{Letter}\p{Number}_])(\p{Sc}?[+-]?\d+(?:[.,:/_-]\d+)*(?:[%‰])?)(?=$|[^\p{Letter}\p{Number}_])/gu, 1)) {
    add("quantity", match.value, contextWindow(text, match.index, match.value.length), [match.index, match.index + match.value.length]);
  }
  for (const match of matchAll(text, /(?:^|[^\p{Letter}\p{Number}_])(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?|[+-]?\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4})(?=$|[^\p{Letter}\p{Number}_])/gu, 1)) {
    add("temporal", match.value, contextWindow(text, match.index, match.value.length), [match.index, match.index + match.value.length]);
  }
  for (const match of matchAll(text, /(?:[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$.]*|[A-Za-z_$][A-Za-z0-9_$]*\([^)]{0,80}\)|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+|[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|py|rs|cs|java|go|cpp|h|hpp|yml|yaml))/gu)) {
    add("symbol", match.value, contextWindow(text, match.index, match.value.length), [match.index, match.index + match.value.length]);
  }
  for (const match of matchAll(text, /(?:!=|≠|¬|!|⊬|⊭|∉|⊄|⊅|<=|>=|=>|->|::|=|<|>)/gu)) {
    const kind: SemanticObligationKind = /(?:!=|≠|¬|!|⊬|⊭|∉|⊄|⊅)/u.test(match.value) ? "negation" : "predicate";
    add(kind, match.value, contextWindow(text, match.index, match.value.length), [match.index, match.index + match.value.length]);
  }
  for (let i = 0; i < symbols.length - 2; i++) {
    const window = symbols.slice(i, i + 3);
    const shape = window.map(tokenShape).join("|");
    const hassymbolOrNumber = window.some(symbol => /[\p{Number}=<>!./:_-]/u.test(symbol));
    if (source === "claim" && (hassymbolOrNumber || i < 10)) add("role", `${shape}:${window.join(" ")}`, window.join(" "));
  }
  for (const symbol of symbols.slice(0, 96)) {
    if (/^[\p{Letter}\p{Number}_-]{4,}$/u.test(symbol) && !/^\d+$/u.test(symbol)) add("predicate", symbol, text);
  }
  return dedupeItems(items.filter(item => source === "claim" || item.kind !== "role"));
}

function matchItem(item: SemanticItem, candidates: readonly SemanticItem[], evidence: readonly EvidenceSpan[], fieldMassByEvidence: Map<string, number>, hasher: Hasher): EvidenceMatch {
  if (!evidence.length) return { status: "missing", support: 0, contradiction: 0, reason: "no-evidence" };
  const exact = candidates.filter(candidate => candidate.normalized === item.normalized);
  if (exact.length) {
    const best = rankedMatch(item, exact, fieldMassByEvidence, hasher)[0]!;
    return { item: best.candidate, span: best.candidate.span, status: "satisfied", support: best.support, contradiction: 0, reason: "exact-material-match" };
  }
  if (item.kind === "quantity" || item.kind === "temporal" || item.kind === "symbol") {
    const counter = contradictoryConstraint(item, candidates, fieldMassByEvidence, hasher);
    if (counter) return counter;
  }
  if (item.kind === "entity") {
    const counter = contradictoryEntity(item, candidates, fieldMassByEvidence, hasher);
    if (counter) return counter;
  }
  const ranked = rankedMatch(item, candidates, fieldMassByEvidence, hasher);
  const best = ranked[0];
  if (!best) return { status: item.kind === "predicate" || item.kind === "role" ? "underdetermined" : "missing", support: 0, contradiction: 0, reason: "no-kind-compatible-evidence" };
  if (best.support >= strictThreshold(item.kind)) return { item: best.candidate, span: best.candidate.span, status: "satisfied", support: best.support, contradiction: best.contradiction, reason: "graph-and-context-compatible" };
  if (best.support >= looseThreshold(item.kind)) return { item: best.candidate, span: best.candidate.span, status: "underdetermined", support: best.support, contradiction: best.contradiction, reason: "candidate-mapping-below-proof-threshold" };
  return { item: best.candidate, span: best.candidate.span, status: "missing", support: best.support, contradiction: best.contradiction, reason: "material-obligation-not-supported" };
}

function rankedMatch(item: SemanticItem, candidates: readonly SemanticItem[], fieldMassByEvidence: Map<string, number>, hasher: Hasher): Array<{ candidate: SemanticItem; support: number; contradiction: number }> {
  return candidates
    .map(candidate => {
      const lexical = weightedJaccard(item.features, candidate.features);
      const context = weightedJaccard(item.contextFeatures, candidate.contextFeatures);
      const vector = cosine01(stableVector(item.features, hasher, 96), stableVector(candidate.features, hasher, 96));
      const mass = candidate.span ? fieldMassByEvidence.get(String(candidate.span.id)) ?? candidate.span.alpha * 0.25 : 0;
      const support = clamp01(0.34 * lexical + 0.25 * context + 0.21 * vector + 0.2 * mass);
      const contradiction = candidate.kind === item.kind ? 0 : 0.18;
      return { candidate, support, contradiction };
    })
    .sort((a, b) => b.support - a.support);
}

function contradictoryConstraint(item: SemanticItem, candidates: readonly SemanticItem[], fieldMassByEvidence: Map<string, number>, hasher: Hasher): EvidenceMatch | undefined {
  const ranked = rankedMatch(item, candidates, fieldMassByEvidence, hasher);
  const nearContext = ranked.find(match => match.support >= 0.28 && match.candidate.normalized !== item.normalized);
  if (!nearContext) return undefined;
  const leftFamily = constraintFamily(item.normalized);
  const rightFamily = new Set(constraintFamily(nearContext.candidate.normalized));
  const sameConstraintFamily = leftFamily.some(value => rightFamily.has(value));
  if (!sameConstraintFamily && (item.kind === "quantity" || item.kind === "temporal")) return undefined;
  return {
    item: nearContext.candidate,
    span: nearContext.candidate.span,
    status: "contradicted",
    support: nearContext.support,
    contradiction: clamp01(0.55 + nearContext.support * 0.4),
    reason: `${item.kind}-constraint-conflict`
  };
}

function contradictoryEntity(item: SemanticItem, candidates: readonly SemanticItem[], fieldMassByEvidence: Map<string, number>, hasher: Hasher): EvidenceMatch | undefined {
  const ranked = rankedMatch(item, candidates, fieldMassByEvidence, hasher);
  const nearContext = ranked.find(match => match.support >= 0.46 && match.candidate.normalized !== item.normalized);
  if (!nearContext) return undefined;
  const sameShape = shapeSimilarity(tokenShape(item.normalized), tokenShape(nearContext.candidate.normalized)) >= 0.7;
  const contextCompatible = weightedJaccard(item.contextFeatures, nearContext.candidate.contextFeatures) >= 0.3;
  if (!sameShape && !contextCompatible) return undefined;
  return {
    item: nearContext.candidate,
    span: nearContext.candidate.span,
    status: "contradicted",
    support: nearContext.support,
    contradiction: clamp01(0.48 + nearContext.support * 0.42),
    reason: "entity-reference-conflict"
  };
}

function obligationRecord(item: SemanticItem, match: EvidenceMatch): SemanticObligationRecord {
  const evidenceIds = match.span ? [match.span.id] : [];
  const sourceVersionIds = match.span ? [match.span.sourceVersionId] : [];
  return {
    id: `obligation:${item.kind}:${hash32(`${item.normalized}:${match.status}:${evidenceIds.join("|")}`).toString(16)}`,
    kind: item.kind,
    status: match.status,
    claimText: item.value.slice(0, 400),
    evidenceIds,
    sourceVersionIds,
    support: clamp01(match.support),
    contradiction: clamp01(match.contradiction),
    required: requiredKind(item.kind),
    reason: match.reason,
    metadata: toJsonValue({
      normalized: item.normalized,
      matched: match.item ? { value: match.item.value.slice(0, 400), kind: match.item.kind, normalized: match.item.normalized, byteRange: match.item.byteRange ?? null } : null,
      contextHash: hash32(item.contextFeatures.join("|")).toString(16)
    })
  };
}

function sourceVersionObligations(evidence: readonly EvidenceSpan[], originalEvidenceCount: number, excludedEvidence: readonly ReturnType<typeof evidenceProofBoundary>[]): SemanticObligationRecord[] {
  const byVersion = new Map<string, EvidenceSpan[]>();
  for (const span of evidence) {
    const key = String(span.sourceVersionId);
    byVersion.set(key, [...(byVersion.get(key) ?? []), span]);
  }
  if (!byVersion.size && originalEvidenceCount > 0) {
    return [{
      id: `obligation:source_version:${hash32(`no-certifying:${originalEvidenceCount}:${excludedEvidence.map(item => item.forceClass).join("|")}`).toString(16)}`,
      kind: "source_version",
      status: "underdetermined",
      claimText: "no certifying direct evidence source version",
      evidenceIds: [],
      sourceVersionIds: [],
      support: 0,
      contradiction: 0,
      required: true,
      reason: "proof-boundary.no-certifying-direct-evidence",
      metadata: toJsonValue({ originalEvidenceCount, excludedEvidence: excludedEvidence.slice(0, 64) })
    }];
  }
  return [...byVersion.entries()].slice(0, 24).map(([version, spans]) => ({
    id: `obligation:source_version:${hash32(version).toString(16)}`,
    kind: "source_version",
    status: "satisfied",
    claimText: version,
    evidenceIds: spans.map(span => span.id),
    sourceVersionIds: [spans[0]!.sourceVersionId],
    support: clamp01(mean(spans.map(span => span.alpha))),
    contradiction: 0,
    required: true,
    reason: "evidence-bound-to-source-version",
    metadata: toJsonValue({ sourceVersionId: version, evidenceCount: spans.length })
  }));
}

function transformObligations(claim: Claim, evidence: readonly EvidenceSpan[], hasher: Hasher): SemanticObligationRecord[] {
  const claimFeatures = claim.features.length ? claim.features : featureSet(claim.text, 512);
  const ranked = evidence
    .map(span => {
      const lexical = weightedJaccard(claimFeatures, span.features);
      const vector = cosine01(stableVector(claimFeatures, hasher, 96), stableVector(span.features, hasher, 96));
      const support = clamp01(0.45 * lexical + 0.35 * vector + 0.2 * span.alpha);
      return { span, support };
    })
    .sort((a, b) => b.support - a.support)
    .slice(0, 3);
  if (!ranked.length) return [{
    id: `obligation:transform:${hash32(claim.normalized).toString(16)}`,
    kind: "transform",
    status: "missing",
    claimText: claim.text.slice(0, 400),
    evidenceIds: [],
    sourceVersionIds: [],
    support: 0,
    contradiction: 0,
    required: true,
    reason: "no-transform-support",
    metadata: toJsonValue({ claimHash: hash32(claim.normalized).toString(16) })
  }];
  const best = ranked[0]!;
  const preservation = materialPreservation(claim.text, best.span.text || best.span.textPreview);
  const status: SemanticObligationStatus =
    best.support >= 0.34 && preservation.blockingMissing.length === 0 ? "satisfied" :
    best.support >= 0.16 || preservation.preserved.length > 0 ? "underdetermined" :
    "missing";
  return [{
    id: `obligation:transform:${hash32(`${claim.normalized}:${best.span.id}`).toString(16)}`,
    kind: "transform",
    status,
    claimText: claim.text.slice(0, 400),
    evidenceIds: [best.span.id],
    sourceVersionIds: [best.span.sourceVersionId],
    support: best.support,
    contradiction: 0,
    required: true,
    reason: status === "satisfied" ? "registered-identity-or-preserving-paraphrase-transform" : "transform-path-failed-preservation-or-support",
    metadata: toJsonValue({
      transformRegistry: preservation.blockingMissing.length === 0 ? "identity-or-preserving-paraphrase" : "unresolved",
      preservation,
      candidates: ranked.map(item => ({ evidenceId: item.span.id, support: item.support }))
    })
  }];
}

function roleObligations(claim: Claim, evidence: readonly EvidenceSpan[], hasher: Hasher): SemanticObligationRecord[] {
  const claimRoles = roleSignature(claim.text);
  if (!claimRoles.length) return [];
  const evidenceRoles = evidence.map(span => ({ span, roles: roleSignature(span.text || span.textPreview) }));
  return claimRoles.slice(0, 16).map(role => {
    const candidates = evidenceRoles
      .map(item => {
        const fit = item.roles.length ? Math.max(...item.roles.map(candidate => roleFit(role, candidate, hasher))) : 0;
        return { span: item.span, fit };
      })
      .sort((a, b) => b.fit - a.fit);
    const best = candidates[0];
    const status: SemanticObligationStatus = !best ? "missing" : best.fit >= 0.48 ? "satisfied" : best.fit >= 0.22 ? "underdetermined" : "missing";
    return {
      id: `obligation:role:${hash32(`${role.id}:${best?.span.id ?? "none"}`).toString(16)}`,
      kind: "role",
      status,
      claimText: role.text,
      evidenceIds: best ? [best.span.id] : [],
      sourceVersionIds: best ? [best.span.sourceVersionId] : [],
      support: best?.fit ?? 0,
      contradiction: 0,
      required: true,
      reason: status === "satisfied" ? "role-topology-mapped" : status === "underdetermined" ? "weak-role-topology-map" : "role-topology-missing",
      metadata: toJsonValue({ role, candidateCount: candidates.length })
    };
  });
}

function roleSignature(text: string): Array<{ id: string; shape: string; text: string; features: string[] }> {
  const symbols = symbolizeData(text).slice(0, 160);
  const roles: Array<{ id: string; shape: string; text: string; features: string[] }> = [];
  for (let i = 0; i < symbols.length; i += 4) {
    const window = symbols.slice(i, i + 4);
    if (!window.length) continue;
    const shape = window.map(tokenShape).join("|");
    const value = window.join(" ");
    roles.push({ id: `${i}:${shape}`, shape, text: value, features: featureSet(value, 96) });
  }
  return roles;
}

function roleFit(left: { shape: string; features: string[] }, right: { shape: string; features: string[] }, hasher: Hasher): number {
  const shape = shapeSimilarity(left.shape, right.shape);
  const lexical = weightedJaccard(left.features, right.features);
  const vector = cosine01(stableVector(left.features, hasher, 64), stableVector(right.features, hasher, 64));
  return clamp01(0.45 * shape + 0.25 * lexical + 0.3 * vector);
}

function relationCompatibilityScore(claim: Claim, evidence: readonly EvidenceSpan[], hasher: Hasher): number {
  if (!evidence.length) return 0;
  const claimRoles = roleSignature(claim.text);
  if (!claimRoles.length) return 0;
  const scores = evidence.slice(0, 12).map(span => {
    const roles = roleSignature(span.text || span.textPreview);
    const perRole = claimRoles.slice(0, 24).map(role => roles.length ? Math.max(...roles.map(candidate => roleFit(role, candidate, hasher))) : 0);
    return mean(perRole) * clamp01(0.45 + span.alpha * 0.55);
  });
  return clamp01(Math.max(...scores));
}

function obligationGraph(claim: Claim, obligations: readonly SemanticObligationRecord[]): { nodes: ProofGraphNode[]; edges: ProofGraphEdge[] } {
  const claimId = String(claim.id);
  const nodes: ProofGraphNode[] = [
    { id: claimId, kind: "claim", label: claim.text.slice(0, 160), metadata: toJsonValue({ polarity: claim.polarity, normalized: claim.normalized }) }
  ];
  const edges: ProofGraphEdge[] = [];
  for (const obligation of obligations) {
    const obligationId = obligation.id;
    nodes.push({ id: obligationId, kind: "obligation", label: `${obligation.kind}:${obligation.status}`, metadata: obligation as unknown as JsonValue });
    edges.push({ source: obligationId, target: claimId, relation: "requires", weight: obligation.required ? 1 : 0.35, evidenceIds: obligation.evidenceIds });
    if (obligation.evidenceIds.length) {
      for (const evidenceId of obligation.evidenceIds) {
        const evidenceNode = `evidence:${String(evidenceId)}`;
        nodes.push({ id: evidenceNode, kind: "evidence", label: String(evidenceId), metadata: toJsonValue({ sourceVersionIds: obligation.sourceVersionIds.map(String) }) });
        edges.push({
          source: evidenceNode,
          target: obligationId,
          relation: obligation.status === "contradicted" ? "contradicts" : obligation.status === "satisfied" ? "satisfies" : "maps_to",
          weight: obligation.status === "contradicted" ? obligation.contradiction : obligation.support,
          evidenceIds: [evidenceId]
        });
      }
    } else {
      edges.push({ source: obligationId, target: claimId, relation: "missing", weight: 1, evidenceIds: [] });
    }
  }
  return { nodes: dedupeNodes(nodes), edges };
}

function obligationMappings(obligations: readonly SemanticObligationRecord[]): SemanticProofMapping[] {
  return obligations.map(obligation => ({
    id: `mapping:${hash32(`${obligation.id}:${obligation.status}:${obligation.evidenceIds.map(String).join("|")}`).toString(16)}`,
    obligationId: obligation.id,
    kind: obligation.kind,
    status: obligation.status,
    claimText: obligation.claimText,
    relation: relationForObligation(obligation),
    evidenceIds: obligation.evidenceIds,
    sourceVersionIds: obligation.sourceVersionIds,
    support: obligation.support,
    contradiction: obligation.contradiction,
    audit: toJsonValue({ reason: obligation.reason, metadata: obligation.metadata })
  }));
}

function transformTraces(obligations: readonly SemanticObligationRecord[]): SemanticTransformTrace[] {
  return obligations
    .filter(obligation => obligation.kind === "transform" || obligation.reason.includes("transform") || obligation.reason.includes("exact-material-match"))
    .map(obligation => ({
      id: `transform:${hash32(`${obligation.id}:${obligation.reason}`).toString(16)}`,
      transformKind: transformKindFor(obligation),
      source: obligation.claimText,
      target: targetTextFromMetadata(obligation.metadata),
      registered: obligation.status === "satisfied" && (obligation.reason.includes("registered") || obligation.reason.includes("exact")),
      support: obligation.support,
      evidenceIds: obligation.evidenceIds,
      sourceVersionIds: obligation.sourceVersionIds,
      audit: toJsonValue({ obligationId: obligation.id, reason: obligation.reason, status: obligation.status, metadata: obligation.metadata })
    }));
}

function counterexampleTraces(obligations: readonly SemanticObligationRecord[], field: FieldState): SemanticCounterexampleTrace[] {
  const explicit = obligations
    .filter(obligation => obligation.status === "contradicted")
    .map(obligation => ({
      id: `counterexample:${hash32(`${obligation.id}:${obligation.reason}`).toString(16)}`,
      kind: obligation.kind,
      claimText: obligation.claimText,
      evidenceIds: obligation.evidenceIds,
      sourceVersionIds: obligation.sourceVersionIds,
      contradiction: obligation.contradiction,
      reason: obligation.reason,
      audit: toJsonValue({ obligationId: obligation.id, metadata: obligation.metadata })
    }));
  if (field.alphaTrace.surfaces.contradiction <= 0.42 && field.alphaTrace.contradictionMass <= 0.42) return explicit;
  return [
    ...explicit,
    {
      id: `counterexample:alpha:${hash32(JSON.stringify(field.alphaTrace.surfaces)).toString(16)}`,
      kind: "alpha_contradiction",
      claimText: "alpha-field contradiction pressure",
      evidenceIds: [],
      sourceVersionIds: [],
      contradiction: clamp01(Math.max(field.alphaTrace.surfaces.contradiction, field.alphaTrace.contradictionMass)),
      reason: "alpha-field-contradiction-pressure",
      audit: toJsonValue({ surfaces: field.alphaTrace.surfaces, contradictionMass: field.alphaTrace.contradictionMass })
    }
  ];
}

function missingTraces(obligations: readonly SemanticObligationRecord[]): SemanticMissingObligationTrace[] {
  return obligations
    .filter(obligation => obligation.status === "missing" || obligation.status === "underdetermined")
    .map(obligation => ({
      id: `missing:${hash32(`${obligation.id}:${obligation.status}`).toString(16)}`,
      obligationId: obligation.id,
      kind: obligation.kind,
      claimText: obligation.claimText,
      required: obligation.required,
      reason: obligation.reason,
      evidenceIds: obligation.evidenceIds,
      sourceVersionIds: obligation.sourceVersionIds,
      audit: toJsonValue({ status: obligation.status, metadata: obligation.metadata })
    }));
}

function enrichProofGraph(
  graph: { nodes: ProofGraphNode[]; edges: ProofGraphEdge[] },
  mappings: readonly SemanticProofMapping[],
  transforms: readonly SemanticTransformTrace[],
  counterexamples: readonly SemanticCounterexampleTrace[]
): { nodes: ProofGraphNode[]; edges: ProofGraphEdge[] } {
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];
  for (const mapping of mappings) {
    nodes.push({ id: mapping.id, kind: "mapping", label: `${mapping.kind}:${mapping.relation}:${mapping.status}`, metadata: mapping as unknown as JsonValue });
    edges.push({ source: mapping.id, target: mapping.obligationId, relation: mapping.status === "contradicted" ? "contradicts" : mapping.status === "missing" ? "missing" : "maps_to", weight: mapping.status === "contradicted" ? mapping.contradiction : mapping.support, evidenceIds: mapping.evidenceIds });
  }
  for (const transform of transforms) {
    nodes.push({ id: transform.id, kind: "transform", label: `${transform.transformKind}:${transform.registered ? "registered" : "unregistered"}`, metadata: transform as unknown as JsonValue });
    for (const evidenceId of transform.evidenceIds) edges.push({ source: `evidence:${String(evidenceId)}`, target: transform.id, relation: "transforms", weight: transform.support, evidenceIds: [evidenceId] });
  }
  for (const counterexample of counterexamples) {
    nodes.push({ id: counterexample.id, kind: "counterexample", label: `${counterexample.kind}:${counterexample.reason}`, metadata: counterexample as unknown as JsonValue });
    for (const evidenceId of counterexample.evidenceIds) edges.push({ source: `evidence:${String(evidenceId)}`, target: counterexample.id, relation: "contradicts", weight: counterexample.contradiction, evidenceIds: [evidenceId] });
  }
  return { nodes: dedupeNodes(nodes), edges };
}

function semanticVerdict(input: {
  required: readonly SemanticObligationRecord[];
  structuralCoverage: number;
  roleCoverage: number;
  relationCompatibility: number;
  transformationSupport: number;
  causalMass: number;
  faithfulnessLCB: number;
  contradiction: number;
  stability: number;
  admission: ProofAdmission;
}): SemanticEntailmentVerdict {
  if (!input.required.length) return "unknown";
  if (input.contradiction >= 0.42 || input.required.some(item => item.status === "contradicted" && item.contradiction >= 0.48)) return "contradicted";
  const requiredCritical = input.required.filter(item => criticalKind(item.kind));
  const missingCritical = requiredCritical.filter(item => item.status === "missing" || item.status === "underdetermined").length;
  if (missingCritical > 0) return "underdetermined";
  if (!input.admission.admitted) return input.admission.supportCeiling >= 0.18 ? "underdetermined" : "unknown";
  const transformOk = input.required.filter(item => item.kind === "transform").every(item => item.status === "satisfied");
  const roleOk = input.roleCoverage >= 0.42 && input.required.filter(item => item.kind === "role").every(item => item.status !== "missing");
  const predicateOk = input.required.filter(item => item.kind === "predicate").filter(item => item.status === "satisfied").length >= Math.min(3, Math.max(1, input.required.filter(item => item.kind === "predicate").length));
  if (
    transformOk &&
    roleOk &&
    predicateOk &&
    input.structuralCoverage >= 0.72 &&
    input.relationCompatibility >= 0.34 &&
    input.transformationSupport >= 0.34 &&
    input.faithfulnessLCB >= 0.18 &&
    input.stability >= 0.42
  ) return "entailed";
  if (input.structuralCoverage >= 0.25 || input.relationCompatibility >= 0.28 || input.causalMass >= 0.05) return "underdetermined";
  return "unknown";
}

function boundaryReasons(input: {
  required: readonly SemanticObligationRecord[];
  contradicted: readonly SemanticObligationRecord[];
  missing: readonly SemanticObligationRecord[];
  underdetermined: readonly SemanticObligationRecord[];
  scores: SemanticEntailmentScores;
  evidenceIds: readonly EvidenceId[];
  admission: ProofAdmission;
}): string[] {
  const out: string[] = [];
  if (!input.evidenceIds.length) out.push("no-exact-evidence-version");
  out.push(...input.admission.reasons);
  for (const item of input.contradicted.slice(0, 8)) out.push(`contradicted-${item.kind}:${hash32(item.claimText).toString(16)}`);
  for (const item of input.missing.filter(item => criticalKind(item.kind)).slice(0, 8)) out.push(`missing-${item.kind}:${hash32(item.claimText).toString(16)}`);
  if (input.underdetermined.length) out.push(`underdetermined-obligations:${input.underdetermined.length}`);
  if (input.scores.relationCompatibility < 0.25) out.push("relation-compatibility-low");
  if (input.scores.faithfulnessLCB < 0.12) out.push("faithfulness-lcb-low");
  return out;
}

function proofAdmission(input: { required: readonly SemanticObligationRecord[]; evidenceCount: number; certifyingEvidenceCount: number; excludedEvidenceCount: number; scores: SemanticEntailmentScores }): ProofAdmission {
  const reasons: string[] = [];
  if (!input.required.length) reasons.push("proof-admission.no-required-obligations");
  if (input.evidenceCount === 0) reasons.push("proof-admission.no-evidence");
  if (input.evidenceCount > 0 && input.certifyingEvidenceCount === 0) reasons.push("proof-admission.no-certifying-direct-evidence");
  if (input.excludedEvidenceCount > 0) reasons.push(`proof-admission.excluded-prior-evidence:${input.excludedEvidenceCount}`);
  const sourceOk = input.required.some(item => item.kind === "source_version" && item.status === "satisfied" && item.evidenceIds.length > 0);
  if (!sourceOk) reasons.push("proof-admission.no-source-version-witness");
  const transformOk = input.required.filter(item => item.kind === "transform").every(proofCertifyingObligation);
  if (!transformOk) reasons.push("proof-admission.transform-not-certified");
  const critical = input.required.filter(item => criticalKind(item.kind));
  const missingCritical = critical.filter(item => item.status === "missing" || item.status === "underdetermined");
  const contradictedCritical = critical.filter(item => item.status === "contradicted");
  const inadmissible = critical.filter(item => item.status === "satisfied" && !proofCertifyingObligation(item));
  if (missingCritical.length) reasons.push(`proof-admission.critical-missing:${missingCritical.length}`);
  if (contradictedCritical.length) reasons.push(`proof-admission.critical-contradicted:${contradictedCritical.length}`);
  if (inadmissible.length) reasons.push(`proof-admission.critical-similarity-only:${inadmissible.length}`);
  if (input.scores.faithfulnessLCB < 0.12) reasons.push("proof-admission.faithfulness-lcb-low");
  if (input.scores.stability < 0.3) reasons.push("proof-admission.alpha-stability-low");

  let supportCeiling = 1;
  if (!sourceOk || input.evidenceCount === 0 || input.certifyingEvidenceCount === 0) supportCeiling = Math.min(supportCeiling, 0.24);
  if (contradictedCritical.length) supportCeiling = Math.min(supportCeiling, 0.18);
  if (missingCritical.length) supportCeiling = Math.min(supportCeiling, 0.46);
  if (inadmissible.length) supportCeiling = Math.min(supportCeiling, 0.58);
  if (!transformOk) supportCeiling = Math.min(supportCeiling, 0.54);
  if (input.scores.faithfulnessLCB < 0.12) supportCeiling = Math.min(supportCeiling, 0.64);
  if (input.scores.stability < 0.3) supportCeiling = Math.min(supportCeiling, 0.62);

  const admissibleEvidenceIds = [...new Set(input.required.filter(proofCertifyingObligation).flatMap(item => item.evidenceIds))];
  const blockingReasons = reasons.filter(reason => reason !== "proof-admission.faithfulness-lcb-low" && reason !== "proof-admission.alpha-stability-low" && !reason.startsWith("proof-admission.excluded-prior-evidence:"));
  return {
    admitted: blockingReasons.length === 0,
    supportCeiling: clamp01(supportCeiling),
    reasons,
    inadmissibleObligationIds: inadmissible.map(item => item.id),
    admissibleEvidenceIds
  };
}

function proofCertifyingObligation(obligation: SemanticObligationRecord): boolean {
  if (obligation.status !== "satisfied" || obligation.evidenceIds.length === 0) return false;
  if (obligation.kind === "source_version") return obligation.reason === "evidence-bound-to-source-version";
  if (obligation.kind === "transform") return obligation.reason === "registered-identity-or-preserving-paraphrase-transform";
  if (obligation.kind === "role") return obligation.reason === "role-topology-mapped";
  if (obligation.reason === "exact-material-match") return true;
  if (obligation.kind === "predicate" && obligation.reason === "graph-and-context-compatible") return obligation.support >= 0.72;
  return false;
}

function fieldMass(nodes: readonly GraphNode[], field: FieldState): Map<string, number> {
  const nodeMass = new Map<string, number>();
  for (const row of field.ppf) nodeMass.set(String(row.nodeId), Math.max(nodeMass.get(String(row.nodeId)) ?? 0, row.mass));
  for (const row of field.active) nodeMass.set(String(row.nodeId), Math.max(nodeMass.get(String(row.nodeId)) ?? 0, row.activation));
  const byEvidence = new Map<string, number>();
  for (const node of nodes) {
    const mass = Math.max(nodeMass.get(String(node.id)) ?? 0, node.alpha * 0.15);
    for (const evidenceId of node.evidenceIds) byEvidence.set(String(evidenceId), Math.max(byEvidence.get(String(evidenceId)) ?? 0, mass));
  }
  return byEvidence;
}

function groupByKind(items: readonly SemanticItem[]): Map<SemanticObligationKind, SemanticItem[]> {
  const out = new Map<SemanticObligationKind, SemanticItem[]>();
  for (const item of items) out.set(item.kind, [...(out.get(item.kind) ?? []), item]);
  return out;
}

function coverageForKind(obligations: readonly SemanticObligationRecord[], kind: SemanticObligationKind): number {
  const items = obligations.filter(item => item.kind === kind);
  if (!items.length) return obligations.length ? 0.5 : 0;
  return items.filter(item => item.status === "satisfied").length / items.length;
}

function contradictionPressure(obligations: readonly SemanticObligationRecord[], field: FieldState): number {
  const explicit = obligations.filter(item => item.status === "contradicted").length / Math.max(1, obligations.length);
  return clamp01(0.48 * explicit + 0.32 * field.alphaTrace.surfaces.contradiction + 0.2 * field.alphaTrace.contradictionMass);
}

function requiredKind(kind: SemanticObligationKind): boolean {
  return kind === "entity" ||
    kind === "predicate" ||
    kind === "role" ||
    kind === "quantity" ||
    kind === "temporal" ||
    kind === "symbol" ||
    kind === "negation" ||
    kind === "source_version" ||
    kind === "transform";
}

function criticalKind(kind: SemanticObligationKind): boolean {
  return kind === "entity" || kind === "quantity" || kind === "temporal" || kind === "symbol" || kind === "negation" || kind === "source_version";
}

function relationForObligation(obligation: SemanticObligationRecord): SemanticProofMapping["relation"] {
  if (!obligation.evidenceIds.length) return "missing";
  if (obligation.kind === "transform") return "transform";
  if (obligation.kind === "role") return "role_path";
  if (obligation.kind === "quantity" || obligation.kind === "temporal" || obligation.kind === "symbol" || obligation.kind === "negation") return "constraint";
  if (obligation.reason.includes("exact")) return "exact";
  return "candidate";
}

function transformKindFor(obligation: SemanticObligationRecord): SemanticTransformTrace["transformKind"] {
  if (obligation.status !== "satisfied") return "unresolved";
  if (obligation.reason.includes("exact")) return "identity";
  if (obligation.kind === "quantity" || obligation.kind === "temporal" || obligation.kind === "symbol") return "constraint_preservation";
  if (obligation.kind === "role") return "role_path";
  return "supported_paraphrase";
}

function targetTextFromMetadata(metadata: JsonValue): string | undefined {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;
  const matched = (metadata as Record<string, JsonValue>).matched;
  if (!matched || typeof matched !== "object" || Array.isArray(matched)) return undefined;
  const value = (matched as Record<string, JsonValue>).value;
  return typeof value === "string" ? value : undefined;
}

function materialPreservation(source: string, target: string): { preserved: string[]; missing: string[]; blockingMissing: string[]; score: number } {
  const material = protectedTerms(source);
  if (!material.length) return { preserved: [], missing: [], blockingMissing: [], score: 1 };
  const targetNorm = normalizeValue(target);
  const preserved = material.filter(term => targetNorm.includes(normalizeValue(term)));
  const missing = material.filter(term => !preserved.includes(term));
  const blockingMissing = missing.filter(term => /[\p{Number}_.:/-]|[A-Z]{2,}/u.test(term));
  return { preserved, missing, blockingMissing, score: clamp01(preserved.length / material.length) };
}

function protectedTerms(text: string): string[] {
  const terms = [
    ...(text.match(/\p{Sc}?[+-]?\d+(?:[.,:/_-]\d+)*(?:[%‰])?/gu) ?? []),
    ...(text.match(/\d{4}[-/.]\d{1,2}[-/.]\d{1,2}|\d{1,2}:\d{2}(?::\d{2})?/gu) ?? []),
    ...(text.match(/[A-Za-z_$][A-Za-z0-9_$]*\.[A-Za-z_$][A-Za-z0-9_$.]*|[A-Za-z0-9_.-]+\/[A-Za-z0-9_.\/-]+|[A-Za-z0-9_-]+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|sql|py|rs|cs|java|go|cpp|h|hpp|yml|yaml)/gu) ?? []),
    ...(text.match(/[A-Z]{2,}[\p{Letter}\p{Number}_-]*/gu) ?? [])
  ];
  return [...new Set(terms.map(term => term.trim()).filter(Boolean))].slice(0, 96);
}

function strictThreshold(kind: SemanticObligationKind): number {
  if (kind === "quantity" || kind === "temporal" || kind === "symbol" || kind === "negation") return 0.62;
  if (kind === "entity") return 0.54;
  if (kind === "role") return 0.48;
  return 0.38;
}

function looseThreshold(kind: SemanticObligationKind): number {
  if (kind === "quantity" || kind === "temporal" || kind === "symbol" || kind === "negation") return 0.32;
  if (kind === "entity") return 0.26;
  return 0.18;
}

function itemFeatures(kind: SemanticObligationKind, value: string): string[] {
  const normalized = normalizeValue(value);
  const structural = [
    `kind:${kind}`,
    `shape:${tokenShape(value)}`,
    `norm:${normalized}`,
    ...constraintFamily(normalized).map(item => `constraint:${item}`)
  ];
  return [...new Set([...featureSet(value, 96), ...structural])];
}

function constraintFamily(value: string): string[] {
  return value
    .replace(/[0-9]+/gu, "N")
    .split(/[^a-zA-Z\p{Letter}N_.:/-]+/u)
    .filter(Boolean)
    .slice(0, 12);
}

function normalizeValue(value: string): string {
  return symbolizeData(value).join(" ").replace(/\s+/g, " ").trim();
}

function contextWindow(text: string, index: number, length: number): string {
  const start = Math.max(0, index - 160);
  const end = Math.min(text.length, index + length + 160);
  return text.slice(start, end);
}

function tokenShape(text: string): string {
  return [...text].map(char => /\p{Letter}/u.test(char) ? "L" : /\p{Number}/u.test(char) ? "N" : /\p{Punctuation}/u.test(char) ? "P" : /\p{Symbol}/u.test(char) ? "S" : "O").join("");
}

function shapeSimilarity(left: string, right: string): number {
  const n = Math.max(left.length, right.length);
  if (!n) return 1;
  let same = 0;
  for (let i = 0; i < n; i++) if (left[i] === right[i]) same++;
  return same / n;
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

function matchAll(text: string, regex: RegExp, group = 0): Array<{ value: string; index: number }> {
  const out: Array<{ value: string; index: number }> = [];
  for (const match of text.matchAll(regex)) {
    const value = match[group];
    if (!value) continue;
    const fullIndex = match.index ?? 0;
    const valueIndex = group === 0 ? fullIndex : fullIndex + String(match[0]).indexOf(value);
    out.push({ value, index: Math.max(0, valueIndex) });
  }
  return out;
}

function dedupeItems(items: readonly SemanticItem[]): SemanticItem[] {
  const seen = new Set<string>();
  const out: SemanticItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.normalized}:${item.span?.id ?? "claim"}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function dedupeNodes(nodes: readonly ProofGraphNode[]): ProofGraphNode[] {
  const seen = new Set<string>();
  const out: ProofGraphNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function countBy(values: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const value of values) out[value] = (out[value] ?? 0) + 1;
  return out;
}

function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}
