import { describe, expect, it } from "vitest";
import {
  aggregateProofSemiring,
  aggregateSourceDependentEvidence,
  type EvidenceSpan,
  type EvidenceWitness
} from "../index.js";

describe("proof calculus semiring aggregation", () => {
  it("aggregates support, contradiction mass, and temporal validity separately", () => {
    const first = witness("evidence:first", {
      independenceGroup: "dep.publisher-a",
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
      independenceGroup: "dep.publisher-b",
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
      independenceGroup: "dep.publisher-c",
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
    expect(summary.evidenceMass.supportMass).toBeGreaterThan(0);
    expect(summary.evidenceMass.contradictionMass).toBeGreaterThan(0);
    expect(summary.evidenceMass.uncertaintyMass).toBeGreaterThan(0);
    expect(summary.evidenceMass.independentGroupCount).toBe(2);
    expect(summary.temporalIntersection).toEqual({ validFrom: 160, validTo: 220, supported: true });
  });

  it("does not fabricate temporal certainty when spans have no validity intervals", () => {
    const summary = aggregateProofSemiring({ supporting: [witness("evidence:no-time", {})] });

    expect(summary.temporalIntersection).toBeUndefined();
    expect(summary.pathCount).toBe(1);
  });

  it("does not count repeated spans from one dependence group as independent corroboration", () => {
    const first = witness("evidence:dependent-a", { independenceGroup: "dep.shared" });
    const duplicate = witness("evidence:dependent-b", { independenceGroup: "dep.shared" });
    const independent = witness("evidence:independent", { independenceGroup: "dep.independent" });

    const single = aggregateSourceDependentEvidence({ supporting: [first] });
    const repeated = aggregateSourceDependentEvidence({ supporting: [first, duplicate] });
    const corroborated = aggregateSourceDependentEvidence({ supporting: [first, independent] });
    const singleSemiring = aggregateProofSemiring({ supporting: [first] });
    const repeatedSemiring = aggregateProofSemiring({ supporting: [first, duplicate] });

    expect(repeated.supportMass).toBeCloseTo(single.supportMass, 12);
    expect(repeated.independentGroupCount).toBe(1);
    expect(repeated.groups[0]?.evidenceIds).toHaveLength(2);
    expect(repeatedSemiring.pathCount).toBe(1);
    expect(repeatedSemiring.sumProductSupport).toBeCloseTo(singleSemiring.sumProductSupport, 12);
    expect(corroborated.supportMass).toBeGreaterThan(repeated.supportMass);
    expect(corroborated.independentGroupCount).toBe(2);
  });

  it("keeps support, contradiction, and uncertainty as separate source-weighted masses", () => {
    const support = witness("evidence:support", {
      independenceGroup: "dep.support",
      support: 0.8,
      contradiction: 0
    });
    const contradiction = witness("evidence:contradiction", {
      independenceGroup: "dep.contradiction",
      support: 0.2,
      contradiction: 0.75
    });

    const mass = aggregateSourceDependentEvidence({
      supporting: [support],
      contradictions: [contradiction]
    });
    const normalizer = mass.supportMass + mass.contradictionMass + mass.uncertaintyMass;

    expect(mass.supportMass).toBeGreaterThan(0);
    expect(mass.contradictionMass).toBeGreaterThan(0);
    expect(mass.uncertaintyMass).toBeGreaterThan(0);
    expect(mass.belief).toBeCloseTo(mass.supportMass / normalizer, 12);
    expect(mass.plausibility).toBeCloseTo((mass.supportMass + mass.uncertaintyMass) / normalizer, 12);
    expect(mass.contradictionRatio).toBeCloseTo(mass.contradictionMass / normalizer, 12);
  });

  it("turns scalar-only trust and exact-source fidelity into uncertainty rather than external-truth support", () => {
    const scalarOnly = witness("evidence:scalar", {
      trustVector: {
        trust: 1,
        sourceTrust: 1,
        sourceFidelity: 1,
        sourceAttribution: 1,
        externalTruth: "supported"
      }
    });

    const mass = aggregateSourceDependentEvidence({ supporting: [scalarOnly] });

    expect(mass.sourceVectorCoverage).toBe(0);
    expect(mass.unresolvedEvidenceCount).toBe(1);
    expect(mass.supportMass).toBe(0);
    expect(mass.contradictionMass).toBe(0);
    expect(mass.uncertaintyMass).toBeCloseTo(1, 12);
    expect(mass.belief).toBe(0);
    expect(mass.plausibility).toBe(1);
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
  independenceGroup: string;
  trustVector: EvidenceSpan["trustVector"];
}>): EvidenceWitness {
  const span = {
    id,
    sourceVersionId: `source-version:${id}`,
    trustVector: overrides.trustVector ?? {
      sourceTrust: {
        identity: 0.92,
        integrity: 0.9,
        parserReliability: 0.88,
        directness: 0.86,
        authority: 0.84,
        freshness: 0.82,
        independenceGroup: overrides.independenceGroup ?? `dep:${id}`,
        accessScope: "scope.fixture",
        licenseStatus: "allowed"
      },
      structuralConfidence: 0.9
    },
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
