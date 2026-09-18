// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  RELATION_PROMOTION_MIN_INDEPENDENT_SOURCES,
  compileRelationPromotionModel,
  relationObservationsFromCandidates,
  relationPromotionCanScore
} from "../relation-promotion.js";
import { canonicalTemporalCoordinates } from "../canonical-temporal.js";
import type { StructuredSemanticCandidate } from "../structured-semantic-candidate.js";
import type { EvidenceId, SourceId, SourceVersionId } from "../types.js";

// Reading every prior observation costs the whole table, and the live ingest paid it once per block: one source
// family, 172k observations re-read and all 171,836 seeds re-decided, for a verdict fixed before the read began.
// Throughput fell from 576 to 85 sources an hour as the table grew.
//
// The claim under test is that skipping that read below the independence threshold changes NO verdict. It is not
// a judgement call: a seed's independent-source count counts FAMILIES, so it cannot exceed the number of
// families in the data, and below the threshold two unconditional reasons make every seed a refusal.

/** Candidates that share one source family, as a single-corpus ingest produces. */
function candidatesInFamilies(count: number, families: readonly string[]): StructuredSemanticCandidate[] {
  return Array.from({ length: count }, (_, index) => {
    const first = index % 2 === 0;
    // Family must not track the seed alternation, or each seed only ever sees half the families.
    const family = families[Math.floor(index / 2) % families.length]!;
    return {
      schema: "scce.semantic_candidate.v2",
      id: `candidate.${family}.${index}`,
      kind: first ? "link" as const : "date" as const,
      channel: "source_declared_structured",
      relationSeedId: first ? "relation_seed.first" : "relation_seed.second",
      sourceId: `source.${index}` as SourceId,
      sourceVersionId: `version.${index}` as SourceVersionId,
      participants: (first ? ["anchor_surface", "target_ref"] : ["date_surface", "time_context"])
        .map((valueKind, port) => ({
          portId: `port.${port}`,
          value: `${valueKind}.${index}`,
          valueKind,
          realization: "observed" as const
        })),
      qualifiers: {},
      evidenceIds: [`evidence.${index}` as EvidenceId],
      temporalCoordinates: canonicalTemporalCoordinates({ observedTime: index }),
      support: 1,
      provenance: {
        exactEvidenceIds: [`evidence.${index}` as EvidenceId],
        extractionChannel: "source_declared_structured",
        anchors: [],
        assumptions: [],
        transformations: [],
        alternativeInterpretations: [],
        // This is what sourceFamilyFor reads, and it is why a single corpus is a single family.
        sourceIndependence: {
          independentSourceCount: 1,
          dependencyGroupIds: [family],
          estimate: 1
        },
        producer: { modelId: "fixture", snapshotId: "fixture.snapshot" },
        admissionState: "proposed",
        normalizationContractId: "fixture.normalization",
        participantIdentityIds: []
      }
    };
  });
}

const verdictOf = (model: ReturnType<typeof compileRelationPromotionModel>) =>
  new Map(model.decisions.map(decision => [
    decision.relationSeedId,
    { promoted: decision.promoted, reasons: [...decision.reasons].sort() }
  ]));

describe("prior observations are read only when they can change a verdict", () => {
  it("cannot score below the independence threshold, and can at it", () => {
    for (let families = 0; families < RELATION_PROMOTION_MIN_INDEPENDENT_SOURCES; families++) {
      expect(relationPromotionCanScore(families)).toBe(false);
    }
    expect(relationPromotionCanScore(RELATION_PROMOTION_MIN_INDEPENDENT_SOURCES)).toBe(true);
    expect(relationPromotionCanScore(RELATION_PROMOTION_MIN_INDEPENDENT_SOURCES + 10)).toBe(true);
  });

  it("gives the same verdict for a one-family corpus whether priors are loaded or not", () => {
    const family = "wikimedia:wikipedia";
    const batch = candidatesInFamilies(24, [family]);
    // What the store holds from every earlier block: the same single family, many more rows.
    const priors = relationObservationsFromCandidates(candidatesInFamilies(400, [family]));
    expect(new Set(priors.map(row => row.sourceFamilyId)).size).toBe(1);
    expect(relationPromotionCanScore(1)).toBe(false);

    const withPriors = compileRelationPromotionModel({ candidates: batch, priorObservations: priors });
    const withoutPriors = compileRelationPromotionModel({ candidates: batch });

    const loaded = verdictOf(withPriors);
    const skipped = verdictOf(withoutPriors);
    // Every seed this block is responsible for gets an identical verdict either way.
    for (const [seedId, verdict] of skipped) {
      expect(loaded.get(seedId), `seed ${seedId} missing when priors were loaded`).toEqual(verdict);
    }
    // And nothing promotes either way, which is what makes the read pointless rather than merely expensive.
    expect(withPriors.decisions.some(decision => decision.promoted)).toBe(false);
    expect(withoutPriors.decisions.some(decision => decision.promoted)).toBe(false);
    for (const decision of withoutPriors.decisions) {
      expect(decision.reasons).toContain("insufficient_independent_sources");
      expect(decision.reasons).toContain("missing_source_family_disjoint_holdout");
    }
  });

  it("still needs priors once the corpus spans enough families", () => {
    // Four families is where the gate becomes satisfiable, so a caller must keep reading from here on.
    const families = ["wikimedia:wikipedia", "gutenberg:books", "oss:docs", "oss:code"];
    const batch = candidatesInFamilies(4, [families[0]!]);
    const priors = relationObservationsFromCandidates(candidatesInFamilies(64, families));
    expect(new Set(priors.map(row => row.sourceFamilyId)).size).toBe(4);
    expect(relationPromotionCanScore(4)).toBe(true);

    // Here the priors genuinely change what is known: without them the batch spans one family and is refused,
    // with them a seed can reach the independent-source count the gate asks for.
    const withoutPriors = compileRelationPromotionModel({ candidates: batch });
    const withPriors = compileRelationPromotionModel({ candidates: batch, priorObservations: priors });
    const seed = withoutPriors.decisions[0]!.relationSeedId;
    expect(withoutPriors.decisions.find(d => d.relationSeedId === seed)!.reasons)
      .toContain("insufficient_independent_sources");
    expect(withPriors.decisions.find(d => d.relationSeedId === seed)!.reasons)
      .not.toContain("insufficient_independent_sources");
  });
});
