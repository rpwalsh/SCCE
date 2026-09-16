// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createHasher } from "../primitives.js";
import {
  admitConversationalActBinding,
  conversationalActBindingId,
  conversationalActBindingRecordId,
  CONVERSATIONAL_ACT_BINDING_SCHEMA
} from "../conversational-act-binding.js";
import { induceConversationalActConstructionTrainingSets } from "../conversational-construction-induction.js";
import { compileLanguageConstructionPattern, type DurableLanguageConstructionBundle } from "../language-construction-memory.js";
import { induceSourceBoundConstructionTrainingSets } from "../graph-surface-alignment.js";
import { RUN_TRANSCRIPT_CORPUS, TRANSCRIPT_CORPUS, transcriptEvidence } from "./dialogue-transcript-corpus-fixture.js";
import { unicodeLexicalSegments } from "../unicode-segmentation.js";
import type { RequestCommunicativeActClassification } from "../request-communicative-act.js";

const hasher = createHasher();

interface InducedRow { bundle: DurableLanguageConstructionBundle; actId: string; profileId: string }

function inducedRows(): InducedRow[] {
  const { documents, evidence } = transcriptEvidence(TRANSCRIPT_CORPUS, hasher);
  return induceConversationalActConstructionTrainingSets({ documents, hasher }).sets.flatMap(set => {
    const compiled = compileLanguageConstructionPattern({
      bindingId: set.bindingId, profileId: set.profileId, observations: set.observations, evidence, hasher, updatedAt: 1
    });
    return compiled.status === "compiled"
      ? [{ bundle: compiled.bundle, actId: String(set.actId), profileId: set.profileId }]
      : [];
  });
}

describe("a dialogue corpus induces conversational constructions of its own", () => {
  it("keys them by the act-derived binding and gives them the slot count the corpus supports", () => {
    const { documents, evidence } = transcriptEvidence(TRANSCRIPT_CORPUS, hasher);
    const report = induceConversationalActConstructionTrainingSets({ documents, hasher });
    expect(report.spansRead).toBe(documents.length);
    expect(report.sets.length).toBeGreaterThan(0);

    for (const set of report.sets) {
      // The key is act-derived, so a relation-keyed bundle can never be relabelled as one of these.
      expect(set.bindingId).toBe(conversationalActBindingId(hasher, set.profileId, set.actId));
      expect(set.bindingId.startsWith("language.source_relation.")).toBe(false);
      expect(set.observations.every(observation => observation.roles.length === 1)).toBe(true);
    }

    const bundles = inducedRows().map(row => row.bundle);
    expect(bundles.length).toBe(report.sets.length);
    const oneSlot = bundles.flatMap(bundle => bundle.constructions.filter(item => item.roleOccurrences.length === 1));
    expect(oneSlot.length).toBeGreaterThan(0);
    // Every literal the frame keeps is a verbatim region of the corpus, and the slot is where the corpus varied.
    for (const construction of oneSlot) {
      const literals = construction.sequence.filter(part => part.kind === "literal");
      expect(literals.length).toBeGreaterThan(0);
      expect(literals.every(part => part.kind === "literal" && part.surface.length > 0)).toBe(true);
      expect(construction.roleOccurrences.every(item => item.realization === "spoken")).toBe(true);
    }
    // Each bundle is attested across several transcripts, which is what the lane's literal-invariance floor measures.
    expect(bundles.every(bundle => bundle.sourceVersionIds.length > 1)).toBe(true);
  });

  it("is the only lane that produces a one-slot construction from this corpus", () => {
    const { documents, evidence } = transcriptEvidence(TRANSCRIPT_CORPUS, hasher);
    const profileId = documents[0]!.profileId;
    const relationSets = induceSourceBoundConstructionTrainingSets({ evidence, profileId, hasher });
    // The relation lane's own key shape, and never a single slot: this is what left the conversation lane empty.
    expect(relationSets.every(set => set.bindingId.startsWith("language.source_relation."))).toBe(true);
    const relationBundles = relationSets.flatMap(set => {
      const result = compileLanguageConstructionPattern({
        bindingId: set.bindingId, profileId, observations: set.observations, evidence, hasher, updatedAt: 1
      });
      return result.status === "compiled" ? [result.bundle] : [];
    });
    expect(relationBundles.flatMap(bundle => bundle.constructions).every(item => item.roleOccurrences.length > 1)).toBe(true);
  });

  it("binds one content span of a one-turn conversation, which is what the lane had no frame for", () => {
    const rows = inducedRows();
    expect(rows.length).toBeGreaterThan(0);
    const turn = { turnId: "turn.01", turnIndex: 0, surface: "the pump feed reads high" };
    const span = { surface: "pump feed reads high", startCodePoint: 4, endCodePoint: 24 };
    expect([...turn.surface].slice(span.startCodePoint, span.endCodePoint).join("")).toBe(span.surface);

    let admitted = 0;
    for (const row of rows) {
      for (const construction of row.bundle.constructions) {
        // The refusal this whole lane stalled on: three relation slots against one conversational span.
        if (construction.roleOccurrences.length !== 1) continue;
        const classification: RequestCommunicativeActClassification = {
          schema: "scce.request_communicative_act_classification.v1",
          status: "active",
          actId: row.actId,
          matchedPatternIds: ["feature.01"],
          logOddsOverNeutral: 1.4,
          classIds: [row.actId, "actshape.neutral"]
        };
        const fillers = [{ slotIndex: 0, surface: span.surface, sourceTurnId: turn.turnId, startCodePoint: span.startCodePoint, endCodePoint: span.endCodePoint }];
        const base = {
          actId: row.actId,
          bindingId: conversationalActBindingId(hasher, construction.profileKey, row.actId),
          profileKey: construction.profileKey,
          conversationId: "conversation.fixture",
          turnId: turn.turnId,
          turnIndex: turn.turnIndex,
          fillers
        };
        const admission = admitConversationalActBinding({
          binding: { schema: CONVERSATIONAL_ACT_BINDING_SCHEMA, id: conversationalActBindingRecordId(hasher, base), ...base },
          classification,
          conversationTurns: [turn],
          // The scoped population the floor is measured over; the induced bundle spans every transcript it recurred in.
          literalInvariance: { independentSourceFamilies: row.bundle.sourceVersionIds.length, observedDistribution: [1, 1, 1, row.bundle.sourceVersionIds.length] },
          hasher
        });
        expect(admission.status).toBe("admissible");
        if (admission.status !== "admissible") continue;
        expect(admission.move.externallyFactual).toBe(false);
        expect(admission.move.evidenceIds).toEqual([]);
        expect(admission.move.relationIds).toEqual([]);
        expect(admission.move.authorityClassId).toBe("authority.conversation_bound");
        admitted += 1;
      }
    }
    expect(admitted).toBeGreaterThan(0);
  });
});

describe("a frame is what recurred, however many units the corpus exchanged inside it", () => {
  it("induces moves whose form outlives a one-unit slot, from a corpus that only ever varies a run", () => {
    const { documents, evidence } = transcriptEvidence(RUN_TRANSCRIPT_CORPUS, hasher);
    const report = induceConversationalActConstructionTrainingSets({ documents, hasher });
    // Every reply differs from its neighbours in two units at once, so a one-unit slot aligns nothing here.
    expect(report.sets.length).toBeGreaterThan(0);
    expect(report.literalFormFloor).toBeGreaterThanOrEqual(2);
    expect(report.bodiedFrames).toBeGreaterThan(0);

    let oneSlot = 0;
    for (const set of report.sets) {
      const compiled = compileLanguageConstructionPattern({
        bindingId: set.bindingId, profileId: set.profileId, observations: set.observations, evidence, hasher, updatedAt: 1
      });
      expect(compiled.status).toBe("compiled");
      if (compiled.status !== "compiled") continue;
      for (const construction of compiled.bundle.constructions) {
        if (construction.roleOccurrences.length !== 1) continue;
        const literalUnits = construction.sequence
          .filter(part => part.kind === "literal")
          .reduce((total, part) => total + unicodeLexicalSegments(part.kind === "literal" ? part.surface : "").length, 0);
        // The starvation this replaces: two-symbol frames the orphan-fragment gate correctly refuses.
        expect(literalUnits).toBeGreaterThanOrEqual(report.literalFormFloor);
        expect(literalUnits).toBeGreaterThanOrEqual(3);
        oneSlot += 1;
      }
    }
    expect(oneSlot).toBeGreaterThan(0);
  });
});
