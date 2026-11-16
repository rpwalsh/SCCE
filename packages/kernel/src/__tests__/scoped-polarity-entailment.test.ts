// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it, vi } from "vitest";
import { createSemanticEntailmentEngine } from "../entailment.js";
import { createSemanticGraphEntailment } from "../semantic-graph.js";
import { createSemanticProofSystem, polarityFromSurface, propositionNodeRepresentation } from "../semantic-proof-system.js";
import { PROOF_COUNTEREXAMPLE_REASON } from "../semantic-codes.js";
import { createProofCalculus } from "../proof-calculus.js";
import { createClock, createHasher, featureSet } from "../primitives.js";
import { createIdFactory } from "../ids.js";
import { jsonRecord } from "../kernel-answer-primitives.js";
import type { Claim, EvidenceSpan, FieldState, GraphNode, JsonValue } from "../types.js";
import type { ProofClaim } from "../semantic-proof-engine.js";

const hasher = createHasher();
function ids() { return createIdFactory({ hasher, clock: createClock({ fixedTime: 1 }), deterministicReplay: true }); }
function field(): FieldState {
  const matrix = { nodes: [], values: [] };
  return { requestFeatures: [], seeds: [], active: [], ppf: [], causalMass: [], alphaTrace: { alpha: 0.5,
    thresholds: { virtual: 0.2, visible: 0.4, bonded: 0.6, structural: 0.8 }, relations: [], adjacency: matrix,
    laplacian: matrix, normalizedLaplacian: matrix, surfaces: { pressure: 0, drift: 0, contradiction: 0, bond: 0, risk: 0, actionability: 0 },
    contradictionMass: 0, bondedLeakage: 0 } };
}
function span(id: string, text: string): EvidenceSpan {
  const sourceVersionId = `version.${id}`, size = [...text].length;
  return { id: `evidence.${id}`, sourceId: `source.${id}`, sourceVersionId, chunkId: `chunk.${id}`, contentHash: hasher.digestHex(text),
    mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(text), charStart: 0, charEnd: size, text, textPreview: text,
    status: "promoted", alpha: 1, observedAt: 1, features: featureSet(text, 512), languageHints: {}, scriptHints: {},
    trustVector: { forceClass: "direct_evidence" }, provenance: { uri: `fixture://polarity/${id}`, sourceVersionId,
      byteRange: [0, Buffer.byteLength(text)], charRange: [0, size] } } as unknown as EvidenceSpan;
}
function claim(text: string): Claim { return { id: "claim.fixture", text, normalized: text, features: featureSet(text, 512), polarity: 1 } as Claim; }
const carrier = (subject: string, negative: boolean) => ({ id: `record.${subject}`, subjectId: subject, subjectSurface: subject,
  relationId: "relation.formal.assertion", objectId: "formal.truth", objectSurface: "true",
  polarityId: negative ? "polarity.negative" : "polarity.positive", modalityId: "modality.asserted" });
function formal(text: string, evidenceSubject: string, evidenceNegative: boolean, claimNegative = false) {
  const row = span("formal", `${evidenceNegative ? "!" : ""}${evidenceSubject}`);
  row.provenance = { ...(row.provenance as Record<string, JsonValue>), proofEvidence: carrier(evidenceSubject, evidenceNegative) };
  const proofClaim: ProofClaim = { id: "claim.P", subject: { id: "P", surface: "P" }, relationId: "relation.formal.assertion",
    object: { id: "formal.truth", surface: "true" }, polarityId: claimNegative ? "polarity.negative" : "polarity.positive",
    modalityId: "modality.asserted", requiredSourceBinding: true };
  const engine = createSemanticEntailmentEngine({ idFactory: ids(), hasher });
  const result = engine.check({ text, evidence: [row], nodes: [], field: field(), createdAt: 1, proofClaims: [proofClaim] });
  return { engine, result, gate: jsonRecord(result.proof.scores).semanticProofEngine as unknown as { verdict: string; contradictions: unknown[] } };
}

it("does not charge the selected Alice claim for unrelated retained narrative em-dashes", () => {
  const question = "What is the name of Alice's cat?";
  const selected = [span("alice.cat", "(Dinah was the cat.)"),
    span("alice.narrative", "baby — the fire-irons. axis — ” “. i — ” “.")];
  const structural = createSemanticGraphEntailment({ idFactory: ids(), hasher }).check({ claim: claim(question), evidence: selected, nodes: [], field: field() });
  expect(structural.evidenceGraphs.some(graph => graph.nodes.some(node => node.role === "negation"))).toBe(true);
  expect(structural.contradiction).toBe(0);
  expect(structural.evidenceGraphs.flatMap(graph => graph.edges).every(edge => edge.contradiction === 0)).toBe(true);
  expect((structural.audit as Record<string, JsonValue>).polarity).toMatchObject({ measurement: "unmeasured_structural_shape" });
});

it.each(["—", "−", "-", "!"])("does not turn unrelated punctuation %s into numeric evidence against the claim", punctuation => {
  const source = span("punctuation", `Dinah was the cat. unrelated ${punctuation} passage.`);
  const engine = createSemanticEntailmentEngine({ idFactory: ids(), hasher });
  const result = engine.check({ text: "Dinah was the cat.", evidence: [source], nodes: [], field: field(), createdAt: 1 });
  expect(result.claim.polarity).toBe(1);
  expect(engine.semanticProofFor(result).result.counterexamples.filter(item => item.reason === PROOF_COUNTEREXAMPLE_REASON.POLARITY)).toEqual([]);
  expect((jsonRecord(result.proof.scores).structuralEntailment as Record<string, JsonValue>).contradiction).toBe(0);
  expect(result.rawContradiction).toBe(0);
});

it("retains genuine same-proposition P versus !P polarity contradiction through the real entailment boundary", () => {
  const { result, gate } = formal("P", "P", true);
  expect(gate.verdict).toBe("contradicted");
  expect(gate.contradictions).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "polarity" })]));
  expect(result.rawContradiction).toBeGreaterThan(0);
  expect(result.truthState).toBe("truth.contradicted");
});

it("does not let unrelated !Q refute P", () => {
  const { result, gate } = formal("P", "Q", true);
  expect(gate.verdict).not.toBe("contradicted");
  expect(result.rawContradiction).toBe(0);
  expect(result.truthState).not.toBe("truth.certified");
});

it("keeps the same source-owned negated proposition consistent with itself", () => {
  const { result, gate } = formal("!P", "P", true, true);
  expect(result.claim.polarity).toBe(-1);
  expect(gate.verdict).toBe("certified");
  expect(result.rawContradiction).toBe(0);
});

it("uses the single owned semantic proof once and never accepts another engine's or caller's result as a receipt", () => {
  const semanticProofSystem = createSemanticProofSystem({ hasher }), prove = vi.spyOn(semanticProofSystem, "prove");
  const engine = createSemanticEntailmentEngine({ idFactory: ids(), hasher, semanticProofSystem });
  const row = span("proof.once", "P");
  const result = engine.check({ text: "P", evidence: [row], nodes: [], semanticNodes: [], field: field(), createdAt: 1 });
  expect(prove).toHaveBeenCalledTimes(1);
  expect(engine.semanticProofFor(result).result).toBe(prove.mock.results[0]!.value);
  expect(Object.keys(result)).not.toContain("semanticProof");
  expect(() => engine.semanticProofFor({ ...result })).toThrow(/owned/u);
  expect(() => createSemanticEntailmentEngine({ idFactory: ids(), hasher }).semanticProofFor(result)).toThrow(/owned/u);
});

it("keeps explicit negative calculus claims unmeasured without a scoped witness instead of silently upgrading them", () => {
  const negative = { ...claim("P"), polarity: -1 };
  const result = createProofCalculus({ hasher }).evaluate({ claim: negative, evidence: [span("unmeasured", "P")], nodes: [], field: field() });
  expect(result.boundaries).toContain("proof.polarity.unmeasured"); expect(result.force).toBe("unknown");
});

it.each(["learned_language_prior", "quarantined", "asserted"])("does not let a %s opposite-polarity source mint factual counterevidence", kind => {
  const positive = span("current.positive", "reactor alpha reports pressure 42."), negative = span("untrusted.negative", "!reactor alpha reports pressure 42.");
  if (kind === "quarantined") negative.status = "quarantined";
  else if (kind === "learned_language_prior") negative.trustVector = { forceClass: kind };
  else negative.provenance = { ...(negative.provenance as Record<string, JsonValue>), epistemicState: "asserted" };
  const engine = createSemanticEntailmentEngine({ idFactory: ids(), hasher });
  const baseline = engine.check({ text: positive.text, evidence: [positive], nodes: [], field: field(), createdAt: 1 });
  const result = engine.check({ text: positive.text, evidence: [positive, negative], nodes: [], field: field(), createdAt: 1 });
  expect(result.rawContradiction).toBe(baseline.rawContradiction);
  expect(result.evidenceIds).not.toContain(negative.id);
});

it.each(["!P", "¬P", "P != Q", "P ≠ Q"])("retains explicit formal polarity %s through the shared parser", text => {
  expect(polarityFromSurface(text, [])).toBe(-1);
  expect(polarityFromSurface("P!", [])).toBe(1);
});


const ordinaryClaim = "reactor alpha reports pressure 42.";

it("carries an actual same-proposition ordinary-atom polarity witness through the single real entailment proof", () => {
  const row = span("ordinary.negative", `!${ordinaryClaim}`);
  const engine = createSemanticEntailmentEngine({ idFactory: ids(), hasher });
  const result = engine.check({ text: ordinaryClaim, evidence: [row], nodes: [], field: field(), createdAt: 1 });
  const shared = engine.semanticProofFor(result).result;
  const witness = shared.counterexamples.find(item => item.reason === PROOF_COUNTEREXAMPLE_REASON.POLARITY);
  expect(witness).toBeDefined();
  expect(witness!.evidenceIds).toEqual([row.id]);
  expect(shared.evidenceAtoms.find(atom => atom.id === witness!.evidenceAtomId)?.certifiesFactualProof).toBe(true);
  expect(shared.claimAtoms.some(atom => atom.id === witness!.claimAtomId)).toBe(true);
  expect(result.rawContradiction).toBeGreaterThanOrEqual(witness!.contradiction);
  expect(result.semanticVerdict).toBe("contradicted");
  expect(result.truthState).toBe("truth.contradicted");
  expect(result.force).toBe("unknown");
});

it.each([
  ["entity", "!reactor omega reports pressure 42."],
  ["relation", "!reactor alpha measures pressure 42."],
  ["time", "!reactor alpha reports pressure 42 on 2027-01-01."]
])("keeps a different ordinary-atom %s as an unmet obligation rather than polarity counterevidence", (_kind, text) => {
  const engine = createSemanticEntailmentEngine({ idFactory: ids(), hasher });
  const result = engine.check({ text: ordinaryClaim, evidence: [span("ordinary.other", text)], nodes: [], field: field(), createdAt: 1 });
  const shared = engine.semanticProofFor(result).result;
  expect(shared.counterexamples.filter(item => item.reason === PROOF_COUNTEREXAMPLE_REASON.POLARITY)).toEqual([]);
  expect(shared.contradiction).toBe(0);
  expect(shared.obligations.length).toBeGreaterThan(0);
  expect(result.rawContradiction).toBe(0);
  expect(result.truthState).not.toBe("truth.certified");
});

it.each(["learned_language_prior", "quarantined", "asserted"])("selects the weaker admitted ordinary-atom witness before a stronger %s candidate", kind => {
  const system = createSemanticProofSystem({ hasher });
  const admitted = span("weaker.admitted", `(!${ordinaryClaim})`);
  const ineligible = span("stronger.ineligible", `!${ordinaryClaim}`);
  if (kind === "quarantined") ineligible.status = "quarantined";
  else if (kind === "learned_language_prior") ineligible.trustVector = { forceClass: kind };
  else ineligible.provenance = { ...(ineligible.provenance as Record<string, JsonValue>), epistemicState: "asserted" };
  const claimAtom = system.atomizeClaim(ordinaryClaim)[0]!;
  const [stronger, weaker] = system.atomizeEvidence([ineligible, admitted]);
  expect(system.unify(claimAtom, stronger!).contradiction).toBeGreaterThan(system.unify(claimAtom, weaker!).contradiction);
  const result = system.prove({ claimText: ordinaryClaim, evidence: [ineligible, admitted], nodes: [] });
  const witnesses = result.counterexamples.filter(item => result.claimAtoms.some(atom => atom.id === item.claimAtomId));
  expect(witnesses).toEqual([expect.objectContaining({ reason: PROOF_COUNTEREXAMPLE_REASON.POLARITY, evidenceIds: [admitted.id] })]);
});

it.each(["quarantined", "missing exact provenance"])("requires current exact admitted source owners for mutual-source polarity reports: %s", invalid => {
  const system = createSemanticProofSystem({ hasher });
  const positive = span("mutual.positive", ordinaryClaim);
  const negative = span("mutual.negative", `!${ordinaryClaim}`);
  for (const row of [positive, negative]) row.provenance = { ...(row.provenance as Record<string, JsonValue>), epistemicState: "asserted" };
  expect(system.prove({ claimText: ordinaryClaim, evidence: [positive, negative], nodes: [] }).mutualSourceContradiction).toBe(true);
  if (invalid === "quarantined") negative.status = "quarantined";
  else negative.provenance = { uri: "fixture://missing-version-and-range", epistemicState: "asserted" };
  const result = system.prove({ claimText: ordinaryClaim, evidence: [positive, negative], nodes: [] });
  expect(result.mutualSourceContradiction).toBe(false);
  expect(result.counterexamples).toEqual([]);
});

it("does not bypass proposition identity when opposite polarity has no matched roles and a different display reason", () => {
  const system = createSemanticProofSystem({ hasher });
  const row = span("unary.graph", "!reactor.");
  const text = "reactor reactor reactor.";
  const atom = system.atomizeClaim(text)[0]!;
  const node = { id: "node.unary", evidenceIds: [row.id], features: [], alpha: row.alpha,
    representation: propositionNodeRepresentation({ ...atom, roles: [], constraints: [], polarity: -1,
      sourceText: row.text, proofClass: "direct_evidence" }) } as unknown as GraphNode;
  const represented = system.atomizeGraph([node], [row])[0]!;
  const pair = system.unify(atom, represented);
  expect(pair.polarity).toBe(0);
  expect(pair.roles).toBe(0);
  expect(pair.contradiction).toBeGreaterThan(0);
  const result = system.prove({ claimText: text, evidence: [row], nodes: [node] });
  expect(result.counterexamples).toEqual([]);
  expect(result.contradiction).toBe(0);
});
