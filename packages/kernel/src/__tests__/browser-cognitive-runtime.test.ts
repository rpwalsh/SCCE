// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { createPortableCognitiveRuntime } from "../browser-cognitive-runtime.js";

describe("portable cognitive runtime", () => {
  it("learns exact source identity and releases only proof-owned evidence text", () => {
    const runtime = createPortableCognitiveRuntime();
    const bytes = new TextEncoder().encode("The Meridian Observatory opened in 1912. It houses a brass telescope.");
    const source = runtime.learnSource({
      namespace: "test",
      canonicalUri: "urn:test:meridian",
      mediaType: "text/plain",
      sourceBytes: bytes,
      observedAt: 100,
      title: "Meridian Observatory"
    });
    expect(source.sourceBytes).not.toBe(bytes);
    expect(source.evidence.text).toBe(new TextDecoder().decode(bytes));
    expect(source.evidence.byteEnd).toBe(bytes.byteLength);
    expect(source.languageProfile.sourceVersionId).toBe(source.source.sourceVersionId);
    const answer = runtime.answer({ requestText: "When did the Meridian Observatory open?", sources: [source] });
    expect(answer).toMatchObject({
      status: "resolved",
      answer: "The Meridian Observatory opened in 1912."
    });
    expect(answer.proof?.grounding).toBe("high");
    expect(answer.evidenceIds).toEqual([source.evidence.id]);
    expect(answer.proofExcerpts).toEqual([{ text: "The Meridian Observatory opened in 1912.", evidenceId: source.evidence.id }]);
  });

  it("keeps content identities stable and rejects altered restored bytes", () => {
    const runtime = createPortableCognitiveRuntime();
    const input = {
      namespace: "test", canonicalUri: "urn:test:stable", mediaType: "text/plain",
      sourceBytes: new TextEncoder().encode("Stable exact source."), observedAt: 5
    };
    const left = runtime.learnSource(input);
    const right = runtime.learnSource(input);
    expect(right.source.sourceVersionId).toBe(left.source.sourceVersionId);
    expect(right.evidence.id).toBe(left.evidence.id);
    const changed = { ...left, sourceBytes: new TextEncoder().encode("Changed exact source.") };
    expect(() => runtime.verifySource(changed)).toThrow(/identity|length|bytes/u);
  });

  it("returns explicit evidence unavailability instead of fabricating an answer", () => {
    const runtime = createPortableCognitiveRuntime();
    expect(runtime.answer({ requestText: "What is the orbital period?", sources: [] })).toEqual({
      status: "evidence-unavailable", answer: "", evidenceIds: [], proofExcerpts: [], proof: null
    });
  });
});
