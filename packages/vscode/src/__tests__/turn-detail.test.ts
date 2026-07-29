import { describe, expect, it } from "vitest";
import type { TurnAnswer } from "../client.js";
import { sourceTitle, turnDetail, turnSources } from "../turn-detail.js";

describe("turnSources", () => {
  it("offers real evidence as a citation without requiring it", () => {
    const answer: TurnAnswer = {
      answer: "Ada Lovelace wrote notes on the Analytical Engine.",
      evidence: [{
        id: "evidence:1",
        sourceId: "source:ada",
        textPreview: "Ada Lovelace was a mathematician who wrote extensive notes...",
        provenance: { title: "Ada Lovelace" }
      }]
    };

    expect(turnSources(answer)).toEqual([{
      id: "evidence:1",
      title: "Ada Lovelace",
      preview: "Ada Lovelace was a mathematician who wrote extensive notes..."
    }]);
  });

  it("returns an empty list when no evidence backs the answer, not an error", () => {
    const answer: TurnAnswer = { answer: "A fictional two-sentence story about a purple pump." };
    expect(turnSources(answer)).toEqual([]);
    expect(turnSources({})).toEqual([]);
  });

  it("caps the offered sources at 12 without dropping the rest of the answer", () => {
    const answer: TurnAnswer = {
      evidence: Array.from({ length: 20 }, (_, index) => ({ id: `evidence:${index}`, sourceId: `source:${index}` }))
    };
    expect(turnSources(answer)).toHaveLength(12);
  });
});

describe("sourceTitle", () => {
  it("prefers a real title from provenance over the bare source id", () => {
    expect(sourceTitle({ sourceId: "source:1", provenance: { title: "Ada Lovelace" } })).toBe("Ada Lovelace");
  });

  it("falls back through provenance uri fields before the source id", () => {
    expect(sourceTitle({ sourceId: "source:1", provenance: { sourceUri: "fixture://wiki/Ada" } })).toBe("fixture://wiki/Ada");
    expect(sourceTitle({ sourceId: "source:1", provenance: {} })).toBe("source:1");
    expect(sourceTitle({ sourceId: "source:1", provenance: undefined })).toBe("source:1");
  });

  it("never throws on a malformed provenance shape", () => {
    expect(sourceTitle({ sourceId: "source:1", provenance: "not-an-object" })).toBe("source:1");
    expect(sourceTitle({ sourceId: "source:1", provenance: ["array", "not", "record"] })).toBe("source:1");
  });
});

describe("turnDetail", () => {
  it("includes sources alongside the existing proof/event detail", () => {
    const answer: TurnAnswer = {
      dialogue: { conversationId: "conversation:1" },
      entailment: { proof: { id: "proof:1" } },
      events: [{ typeId: "OwnerAsked", id: "event:1" }],
      evidence: [{ id: "evidence:1", sourceId: "source:1", textPreview: "Real evidence text.", provenance: {} }]
    };

    expect(turnDetail(answer)).toEqual({
      conversationId: "conversation:1",
      proof: { id: "proof:1" },
      events: [{ typeId: "OwnerAsked", id: "event:1" }],
      sources: [{ id: "evidence:1", title: "source:1", preview: "Real evidence text." }]
    });
  });

  it("keeps sources empty for an answer with no evidence, never fabricating a citation", () => {
    const answer: TurnAnswer = { events: [] };
    expect(turnDetail(answer)).toMatchObject({ sources: [] });
  });
});
