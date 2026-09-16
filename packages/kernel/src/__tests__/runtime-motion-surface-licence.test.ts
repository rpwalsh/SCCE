// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { runtimeMotionCandidateField, type RuntimeReplanMotion } from "../runtime-motion.js";
import { createHasher } from "../primitives.js";
import { jsonRecord } from "../kernel-answer-primitives.js";
import type { CandidateField } from "../candidate-contract.js";

const hasher = createHasher();

// Verbatim from .scce/traces/2026-09-13T11-19-57-208Z-trace_mtzq2fbs_bnnwxb.jsonl turn 0004 (admitted=0, evRefs=0).
const RECORDED_SURFACE = "No grounded source in the ingested corpus for: boiling point.";
const RECORDED_REQUEST = "What is the boiling point of tungsten?";
// The lead the deleted operator message bundle put in front of the focus. Whatever supplies the lead, the
// composer sees it as a lead; this drives that channel with the words the recorded turn actually spoke.
const RECORDED_LEAD = "No grounded source in the ingested corpus for";

describe("a runtime-motion surface emits only units the turn holds", () => {
  it("refuses the recorded tungsten surface: nothing the turn held licensed its claim about the corpus", () => {
    const result = field({
      requestText: RECORDED_REQUEST,
      focusAnchors: [RECORDED_LEAD]
    });
    const continuation = result.candidates.find(candidate => candidate.kind === "dialogue-continuation");
    expect(continuation).toBeUndefined();
    const refused = jsonRecord(jsonRecord(result.audit).runtimeMotionSurfaceRefused);
    expect(refused.schema).toBe("scce.runtime_motion.surface_licence_audit.v1");
    const refusedUnits = (refused.refusedUnits as string[]).map(unit => unit.toLocaleLowerCase());
    for (const unlicensed of ["grounded", "source", "ingested", "corpus"]) {
      expect(refusedUnits).toContain(unlicensed);
    }
  });

  it("never composes the recorded string, whatever the lead channel hands it", () => {
    for (const anchors of [[RECORDED_LEAD], [RECORDED_SURFACE], [RECORDED_LEAD, "boiling point"]]) {
      const result = field({ requestText: RECORDED_REQUEST, focusAnchors: anchors });
      for (const candidate of result.candidates) {
        expect(candidate.answer).not.toBe(RECORDED_SURFACE);
        const emitted = candidate.answer.toLocaleLowerCase();
        for (const unlicensed of ["grounded", "ingested", "corpus"]) expect(emitted).not.toContain(unlicensed);
      }
    }
  });

  it("still emits a focus surface whose units come from the request and a typed slot value", () => {
    const result = field({
      requestText: "What controls Pump Alpha?",
      unresolvedSlots: ["controller"]
    });
    const continuation = result.candidates.find(candidate => candidate.kind === "dialogue-continuation");
    expect(continuation?.answer).toBeTruthy();
    const emitted = (continuation?.answer ?? "").toLocaleLowerCase();
    expect(emitted).toContain("pump alpha");
    expect(emitted).toContain("controller");
    const licence = surfaceLicenceAudit(continuation?.audit);
    expect(licence.admittedComponentCount).toBe(licence.componentCount);
    expect(licence.refusedUnits).toEqual([]);
    expect(licence.authorityIds).toContain("commitment.authority.typed_slot");
  });

  it("still emits a carried conversational focus whose units come from a prior turn's span", () => {
    const result = field({
      // A follow-up naming nothing of its own: the carried subject is licensed by the turn that said it.
      requestText: "What about its boiling point?",
      focusAnchors: ["tungsten"],
      conversationTurns: [{ turnId: "turn.user.1", turnIndex: 0, surface: "Tell me about tungsten." }]
    });
    const continuation = result.candidates.find(candidate => candidate.kind === "dialogue-continuation");
    expect(continuation?.answer.toLocaleLowerCase()).toContain("tungsten");
    const licence = surfaceLicenceAudit(continuation?.audit);
    expect(licence.refusedUnits).toEqual([]);
    expect(licence.authorityIds).toContain("commitment.authority.conversation_span");
  });

  it("refuses the same carried focus when no turn of the conversation ever said it", () => {
    const result = field({ requestText: "What about its boiling point?", focusAnchors: ["tungsten"] });
    expect(result.candidates.find(candidate => candidate.kind === "dialogue-continuation")).toBeUndefined();
  });

  it("licenses a unit admitted evidence carries", () => {
    const result = field({
      requestText: "What about its boiling point?",
      focusAnchors: ["tungsten"],
      evidenceTexts: [{ id: "evidence.metals.1", text: "Tungsten has the highest melting point of the metals." }]
    });
    const continuation = result.candidates.find(candidate => candidate.kind === "dialogue-continuation");
    expect(continuation?.answer.toLocaleLowerCase()).toContain("tungsten");
    expect(surfaceLicenceAudit(continuation?.audit).authorityIds).toContain("commitment.authority.documentary");
  });
});

function surfaceLicenceAudit(audit: unknown) {
  const licence = jsonRecord(jsonRecord(jsonRecord(audit as never).surfaceBasis).licenceAudit);
  return {
    componentCount: Number(licence.componentCount),
    admittedComponentCount: Number(licence.admittedComponentCount),
    refusedUnits: (licence.refusedUnits ?? []) as string[],
    authorityIds: (licence.authorityIds ?? []) as string[]
  };
}

function field(input: {
  requestText: string;
  focusAnchors?: readonly string[];
  unresolvedSlots?: readonly string[];
  conversationTurns?: readonly { turnId: string; turnIndex: number; surface: string }[];
  evidenceTexts?: readonly { id: string; text: string }[];
}): CandidateField {
  return runtimeMotionCandidateField({
    base: { candidates: [], surfaceMass: [], audit: {}, scoreTrace: [] },
    requestText: input.requestText,
    authority: "factual",
    motion: motion(),
    ...(input.focusAnchors ? { focusAnchors: input.focusAnchors } : {}),
    ...(input.unresolvedSlots ? { unresolvedSlots: input.unresolvedSlots } : {}),
    ...(input.conversationTurns ? { conversationTurns: input.conversationTurns } : {}),
    ...(input.evidenceTexts ? { evidenceTexts: input.evidenceTexts } : {}),
    hasher
  });
}

function motion(): RuntimeReplanMotion {
  return {
    schema: "scce.runtime_motion.learn_hydrate_replan.v1",
    motionId: "motion.learn_hydrate_replan",
    guardId: "guard:licence",
    attempt: 1,
    trigger: "coherence_support_failure",
    requestedAuthority: "factual",
    parentEpisodeId: "episode:licence",
    queryHash: "hash:licence",
    connectorConfigured: false,
    status: "unavailable",
    searchResultCount: 0,
    fetchedSourceCount: 0,
    ingestedSourceCount: 0,
    ingestedEvidenceCount: 0,
    sourceUris: [],
    sourceSurfaces: [],
    failures: [],
    priorRejectedHypotheses: []
  };
}
