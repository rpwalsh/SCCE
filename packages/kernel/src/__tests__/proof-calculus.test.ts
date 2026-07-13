import { describe, expect, it } from "vitest";
import { aggregateProofSemiring, type EvidenceWitness, type EvidenceSpan } from "../index.js";

describe("proof calculus semiring aggregation", () => {
  it("aggregates support, contradiction mass, and temporal validity separately", () => {
    const first = witness("evidence:first", {
      support: 0.82,
      contradiction: 0.05,
      coverage: 0.9,
      vector: 0.8,
      faithfulness: 0.86,
      provenance: 0.92,
      transform: 0.88,
      validFrom: 100,
      validTo: 220
    });
    const second = witness("evidence:second", {
      support: 0.54,
      contradiction: 0.08,
      coverage: 0.66,
      vector: 0.7,
      faithfulness: 0.72,
      provenance: 0.74,
      transform: 0.81,
      validFrom: 160,
      validTo: 260
    });
    const contradiction = witness("evidence:contra", {
      support: 0.3,
      contradiction: 0.62,
      coverage: 0.5,
      vector: 0.44,
      faithfulness: 0.5,
      provenance: 0.8,
      transform: 0.5
    });

    const summary = aggregateProofSemiring({ supporting: [first, second], contradictions: [contradiction] });

    expect(summary.pathCount).toBe(2);
    expect(summary.sumProductSupport).toBeGreaterThan(summary.maxProductSupport);
    expect(summary.maxMinContradiction).toBeGreaterThan(0.6);
    expect(summary.netAdmissibility).toBeLessThan(summary.sumProductSupport);
    expect(summary.minPlusRisk).toBeGreaterThan(0);
    expect(summary.temporalIntersection).toEqual({ validFrom: 160, validTo: 220, supported: true });
  });

  it("does not fabricate temporal certainty when spans have no validity intervals", () => {
    const summary = aggregateProofSemiring({ supporting: [witness("evidence:no-time", {})] });

    expect(summary.temporalIntersection).toBeUndefined();
    expect(summary.pathCount).toBe(1);
  });
});

function witness(id: string, overrides: Partial<{
  support: number;
  contradiction: number;
  coverage: number;
  vector: number;
  field: number;
  faithfulness: number;
  provenance: number;
  transform: number;
  validFrom: number;
  validTo: number;
}>): EvidenceWitness {
  const span = {
    id,
    provenance: {
      ...(overrides.validFrom === undefined ? {} : { validFrom: overrides.validFrom }),
      ...(overrides.validTo === undefined ? {} : { validTo: overrides.validTo })
    }
  } as unknown as EvidenceSpan;
  return {
    span,
    support: overrides.support ?? 0.6,
    contradiction: overrides.contradiction ?? 0,
    coverage: overrides.coverage ?? 0.7,
    vector: overrides.vector ?? 0.7,
    field: overrides.field ?? 0,
    faithfulness: overrides.faithfulness ?? 0.75,
    provenance: overrides.provenance ?? 0.75,
    transformations: [{ id: `${id}:transform`, label: "fixture", input: "", output: "", confidence: overrides.transform ?? 0.8 }],
    intervals: { low: 0.4, mean: overrides.support ?? 0.6, high: 0.8 }
  };
}
