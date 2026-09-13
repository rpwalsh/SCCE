// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evidenceForRequest } from "../local-evidence-runtime.js";
import { clearCorpusIdentitySignals, primeCorpusIdentitySignals } from "../corpus-identity.js";
import type { EvidenceId, EvidenceSpan, SourceVersionId } from "../types.js";

/**
 * A source whose identity is its title holds one subject per document; a book holds the subject on a thousand
 * chunks and the relation on ten. Relevance ranking cannot tell those ten apart, so the chunk the mouth could
 * have spoken from was discarded two stages before the mouth ever saw it: 24 admitted Moby-Dick chunks ranked to
 * two interior passages of dialogue and the turn spoke nothing (live 2026-09-13).
 */
describe("evidence ranking by answerhood", () => {
  const request = "Who is the captain of the Pequod in Moby-Dick?";
  const closedClass = new Set(["who", "is", "the", "of", "in", "and", "a", "to", "that", "it", "was", "he"]);

  beforeEach(() => {
    primeCorpusIdentitySignals({
      closedClass,
      identities: new Set(["moby dick"]),
      spread: new Map([["captain", 900], ["pequod", 1], ["moby-dick", 2]]),
      concentration: 8
    });
  });
  afterEach(() => clearCorpusIdentitySignals());

  // Both chunks are the same book and both name the subject and the relation. Only one binds them in a sentence;
  // the other spreads them across a page of dialogue, which is what makes it the harder case.
  const interior = span({
    id: "evidence:moby:interior",
    alpha: 0.95,
    text: "“Is this the Pequod?” said I. “Aye,” he answered, and turned away. The wind had gone round to the "
      + "east. Nothing stirred upon the wharf. The captain was below, and the captain would not be disturbed."
  });
  const binding = span({
    id: "evidence:moby:binding",
    alpha: 0.5,
    text: "There was a certain lofty bearing about him. Captain Ahab of the Pequod stood upon his quarter-deck, "
      + "and the crew waited. He said nothing more that day."
  });

  it("ranks the chunk whose sentence binds the request's relation to its subject above a chunk that only repeats both", () => {
    const pool = [interior, binding];
    // As it was: no learned closed class, so nothing tells the relation from the request's scaffolding and the
    // pool is ordered by relevance alone. Kept in the test so the fix cannot be removed quietly.
    const byRelevance = evidenceForRequest(request, pool);
    expect(String(byRelevance[0]?.id)).toBe("evidence:moby:interior");

    const byAnswerhood = evidenceForRequest(request, pool, new Set(), new Set(), new Set(), closedClass);
    expect(String(byAnswerhood[0]?.id)).toBe("evidence:moby:binding");
    expect(byAnswerhood).toHaveLength(2);
  });

  it("leaves the order alone when the answerhood test does not discriminate", () => {
    // Neither chunk answers: ordering falls through to relevance exactly as before, and nothing is dropped.
    const silent = [
      span({ id: "evidence:moby:sea", alpha: 0.95, text: "The Pequod sailed on. The sea was grey and the sky was greyer." }),
      span({ id: "evidence:moby:mast", alpha: 0.5, text: "The Pequod carried three masts. Nothing more was said of her." })
    ];
    expect(evidenceForRequest(request, silent, new Set(), new Set(), new Set(), closedClass).map(item => String(item.id)))
      .toEqual(evidenceForRequest(request, silent).map(item => String(item.id)));
  });
});

function span(input: { id: string; alpha: number; text: string }): EvidenceSpan {
  return {
    id: input.id as EvidenceId,
    sourceVersionId: `${input.id}:v1` as SourceVersionId,
    text: input.text,
    textPreview: input.text,
    status: "promoted",
    alpha: input.alpha,
    charStart: 176542,
    features: [],
    provenance: {
      uri: `fixture://${input.id}`,
      title: "Moby Dick",
      sourceVersionId: `${input.id}:v1`,
      byteRange: [0, input.text.length],
      charRange: [176542, 176542 + input.text.length],
      metadata: { title: "Moby Dick" }
    }
  } as unknown as EvidenceSpan;
}
