// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import type { ProofClaim, SemanticProofResult } from "./semantic-proof-engine.js";
import type { EvidenceSpan, GraphNode, Hyperedge, JsonValue } from "./types.js";
import { corpusIdentityUnits } from "./corpus-identity.js";
import { stripOuterPriorSeparators } from "./kernel-answer-primitives.js";
import { requestUnitSharesStem } from "./local-evidence-runtime.js";
import { graphNodeSurface } from "./semantic-proof-adapter.js";

export type TypedProofScopeStatus = "active" | "bypassed_not_applicable";

export interface TypedProofScope {
  status: TypedProofScopeStatus;
  reason: string;
  typedRelations: Hyperedge[];
  proofClaims: ProofClaim[];
  scopedHyperedges: number;
}

type ObservedPair = { subject: Hyperedge["participantPorts"][number]; object: Hyperedge["participantPorts"][number] };

/** Claims from the answer's own hyperedges whose participants the answer text states, records from other admitted spans that bear on them. */
export function typedProofScope(input: {
  hyperedges: readonly Hyperedge[];
  admittedEvidence: readonly EvidenceSpan[];
  claimEvidenceIds: readonly EvidenceSpan["id"][];
  claimText: string;
  nodes: readonly GraphNode[];
}): TypedProofScope {
  const admittedIds = new Set(input.admittedEvidence.map(span => String(span.id)));
  const claimIds = new Set(input.claimEvidenceIds.map(String).filter(id => admittedIds.has(id)));
  const scoped = input.hyperedges.filter(edge => observedPair(edge) && edge.evidenceIds.some(id => admittedIds.has(String(id))));
  if (!scoped.length) return bypassed("no_typed_hyperedge_for_admitted_evidence", 0);
  const nodeById = new Map(input.nodes.map(node => [String(node.id), node]));
  const answerUnits = identityUnits(input.claimText);
  const stated = (port: Hyperedge["participantPorts"][number]) => {
    const units = identityUnits(graphNodeSurface(nodeById.get(String(port.nodeId))) ?? "");
    return units.length > 0 && units.every(unit => answerUnits.some(answerUnit => requestUnitSharesStem(unit, answerUnit)));
  };
  const claimEdges = scoped.filter(edge => edge.evidenceIds.some(id => claimIds.has(String(id)))
    && edge.participantPorts.filter(port => port.realization === "observed" && port.nodeId !== null).every(stated));
  if (!claimEdges.length) return bypassed("no_typed_hyperedge_for_claim_evidence", scoped.length);
  const proofClaims = claimEdges.map(claimFromHyperedge);
  const typedRelations = scoped.flatMap(edge => {
    const evidenceIds = edge.evidenceIds.filter(id => admittedIds.has(String(id)) && !claimIds.has(String(id)));
    if (!evidenceIds.length || !claimEdges.some(claimEdge => bearsOnClaim(claimEdge, edge))) return [];
    return [{ ...edge, evidenceIds }];
  });
  if (!typedRelations.length) return bypassed("no_independent_typed_record_for_claim", scoped.length);
  return { status: "active", reason: "typed_claims_checked_against_independent_evidence", typedRelations, proofClaims, scopedHyperedges: scoped.length };
}

/** Typed obligations and verdict reasons the structured proof gate evaluated, for the proof stage trace. */
export function typedProofTrace(scope: TypedProofScope, gate: JsonValue | undefined): Record<string, JsonValue> {
  const base: Record<string, JsonValue> = { status: scope.status, reason: scope.reason, scopedHyperedges: scope.scopedHyperedges, claims: scope.proofClaims.length, records: scope.typedRelations.length };
  if (scope.status !== "active") return base;
  const result = gate && typeof gate === "object" && !Array.isArray(gate) ? gate as unknown as Partial<SemanticProofResult> : undefined;
  const tally = new Map<string, { kind: string; passed: boolean; reason: string; count: number }>();
  for (const obligation of result?.obligations ?? []) {
    const key = `${obligation.kind}${obligation.passed}${obligation.reason ?? ""}`;
    const row = tally.get(key) ?? { kind: obligation.kind, passed: obligation.passed, reason: obligation.reason ?? "", count: 0 };
    row.count += 1;
    tally.set(key, row);
  }
  const reasons = [...new Set([
    ...[...tally.values()].filter(row => !row.passed).map(row => row.reason),
    ...(result?.contradictions ?? []).map(item => item.reason),
    ...(result?.rejectedEvidence ?? []).map(item => item.reason)
  ].filter(Boolean))];
  return {
    ...base,
    verdict: result?.verdict ?? null,
    proofPath: typeof result?.trace?.proofPath === "string" ? result.trace.proofPath : null,
    obligations: [...tally.values()],
    contradictions: (result?.contradictions ?? []).map(item => ({ kind: item.kind, reason: item.reason })),
    reasons
  };
}

function identityUnits(text: string): string[] {
  return corpusIdentityUnits(text).map(stripOuterPriorSeparators).filter(Boolean);
}

function bypassed(reason: string, scopedHyperedges: number): TypedProofScope {
  return { status: "bypassed_not_applicable", reason, typedRelations: [], proofClaims: [], scopedHyperedges };
}

// Same port choice as typedRelationsToProofRecords, so claims and records compare like for like.
function observedPair(edge: Hyperedge): ObservedPair | undefined {
  const observed = edge.participantPorts.filter(port => port.realization === "observed" && port.nodeId !== null);
  return observed.length >= 2 ? { subject: observed[0]!, object: observed[1]! } : undefined;
}

function claimFromHyperedge(edge: Hyperedge): ProofClaim {
  const pair = observedPair(edge)!;
  return {
    id: `proof.claim.hyperedge.${String(edge.id)}`,
    subject: { id: String(pair.subject.nodeId), kindId: pair.subject.valueKind, roleId: pair.subject.roleId },
    relationId: String(edge.relationId),
    object: { id: String(pair.object.nodeId), kindId: pair.object.valueKind, roleId: pair.object.roleId }
  };
}

function bearsOnClaim(claimEdge: Hyperedge, edge: Hyperedge): boolean {
  const claim = observedPair(claimEdge)!;
  const record = observedPair(edge)!;
  const same = String(claim.subject.nodeId) === String(record.subject.nodeId) && String(claim.object.nodeId) === String(record.object.nodeId);
  const reversed = String(claim.subject.nodeId) === String(record.object.nodeId) && String(claim.object.nodeId) === String(record.subject.nodeId);
  return (same && String(claimEdge.relationId) === String(edge.relationId)) || reversed;
}
