// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { admitCandidatesForAuthority } from "../request-authority.js";
import type { CandidateField, CandidateSurface } from "../candidate-contract.js";
import type { EvidenceId } from "../types.js";

function candidate(input: {
  id: string;
  obligations: number;
  evidenceCount?: number;
  missedRequirementIds?: string[];
  kind?: CandidateSurface["kind"];
  support?: number;
  faithfulness?: number;
}): CandidateSurface {
  const evidenceCount = input.evidenceCount ?? 2;
  return {
    id: input.id,
    kind: input.kind ?? "proof-answer",
    answer: input.id,
    force: "inferred",
    evidenceIds: Array.from({ length: evidenceCount }, (_, index) => `evidence_${input.id}_${index}` as EvidenceId),
    scores: {
      support: input.support ?? 0.54,
      contradiction: 0,
      faithfulness: input.faithfulness ?? 0.44,
      alphaPressure: 0.55,
      actionability: 0.8,
      evidenceCoverage: 0.01,
      novelty: 0,
      realizability: 0.8
    },
    satisfiedRequirementIds: [],
    missedRequirementIds: input.missedRequirementIds ?? [],
    boundaries: [`underdetermined-obligations:${input.obligations}`],
    audit: {}
  };
}

function field(candidates: CandidateSurface[]): CandidateField {
  const mass = candidates.length ? 1 / candidates.length : 0;
  return {
    candidates,
    surfaceMass: candidates.map(row => ({ candidateId: row.id, mass, reason: "fixture" })),
    audit: {},
    scoreTrace: []
  };
}

describe("factual candidate proof admission", () => {
  it("keeps a source-grounded answer with only a residual proof obligation", () => {
    const result = admitCandidatesForAuthority(field([candidate({ id: "lincoln-like", obligations: 1 })]), "factual");
    expect(result.candidates.map(row => row.id)).toEqual(["lincoln-like"]);
    expect(result.surfaceMass).toHaveLength(1);
    expect(result.surfaceMass[0]?.mass).toBe(1);
  });

  it("rejects a factual answer when unresolved obligations overwhelm its evidence", () => {
    const good = candidate({ id: "good", obligations: 1 });
    const bad = candidate({ id: "apollo-like", obligations: 9 });
    const result = admitCandidatesForAuthority(field([good, bad]), "factual");
    expect(result.candidates.map(row => row.id)).toEqual(["good"]);
    expect(result.surfaceMass.map(row => row.candidateId)).toEqual(["good"]);
    expect(result.surfaceMass[0]?.mass).toBe(1);
  });

  it("rejects graph and zero-support synthesis siblings instead of routing around a failed factual proof", () => {
    const proof = candidate({ id: "apollo-proof", obligations: 9 });
    const graph = candidate({ id: "apollo-graph", obligations: 9, kind: "graph-inference", support: 0.46, faithfulness: 0.40 });
    const synthesis = candidate({ id: "apollo-synthesis", obligations: 0, kind: "reasoned-synthesis", support: 0, faithfulness: 0 });
    const result = admitCandidatesForAuthority(field([proof, graph, synthesis]), "factual");
    expect(result.candidates).toEqual([]);
    expect(result.surfaceMass).toEqual([]);
  });

  it("rejects a factual proof candidate that explicitly missed a required output", () => {
    const result = admitCandidatesForAuthority(
      field([candidate({ id: "missing-slot", obligations: 0, missedRequirementIds: ["slot.requested_relation"] })]),
      "factual"
    );
    expect(result.candidates).toEqual([]);
    expect(result.surfaceMass).toEqual([]);
  });

  it("does not apply factual proof rejection to non-factual authority", () => {
    const bad = candidate({ id: "reasoned-underdetermined", obligations: 34 });
    const result = admitCandidatesForAuthority(field([bad]), "reasoned");
    expect(result.candidates.map(row => row.id)).toEqual(["reasoned-underdetermined"]);
  });
});
