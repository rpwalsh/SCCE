// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createTypedIngestProjector,
  proseRelations,
  toJsonValue,
  type EvidenceSpan,
  type SourceId,
  type SourceVersionId
} from "../index.js";

describe("prose relation channel", () => {
  const clock = createClock({ fixedTime: 100, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "prose-relation-channel" });

  function evidenceFor(uri: string, text: string, sourceId: SourceId, sourceVersionId: SourceVersionId): EvidenceSpan {
    const contentHash = ids.contentHash(text);
    const byteEnd = Buffer.byteLength(text);
    return {
      id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd, spanHash: contentHash }),
      sourceId,
      sourceVersionId,
      chunkId: ids.chunkId({ sourceVersionId, byteStart: 0, byteEnd, chunkHash: contentHash }),
      contentHash,
      mediaType: "text/plain",
      byteStart: 0,
      byteEnd,
      charStart: 0,
      charEnd: [...text].length,
      text,
      textPreview: text,
      languageHints: {},
      scriptHints: {},
      trustVector: { trust: 1 },
      provenance: toJsonValue({ uri }),
      features: [],
      status: "promoted",
      alpha: 1,
      observedAt: 100
    };
  }

  function project(text: string) {
    const sourceId = "source.prose" as SourceId;
    const sourceVersionId = "version.prose" as SourceVersionId;
    const evidence = evidenceFor("fixture://prose", text, sourceId, sourceVersionId);
    return createTypedIngestProjector({ idFactory: ids, hasher }).project({
      sourceId,
      sourceVersionId,
      uri: "fixture://prose",
      mediaType: "text/plain",
      text,
      metadata: toJsonValue({}),
      evidence: [evidence],
      observedAt: 100
    });
  }

  it("reads a measurement relation out of a sentence without naming a word of the language", () => {
    const relations = proseRelations("The compound Xylor-7 decomposes at 417 degrees Celsius.");

    expect(relations).toHaveLength(1);
    expect(relations[0]!.subject.surface).toBe("Xylor-7");
    expect(relations[0]!.object.surface).toBe("417 degrees");
    expect(relations[0]!.object.role).toBe("value");
    expect(relations[0]!.predicateSurface).toBe("decomposes at");
  });

  it("takes a number's own digits, not the sentence punctuation that follows them", () => {
    const relations = proseRelations("Alice Renner became chief executive of Halvern Dynamics in 2019.");

    expect(relations.map(relation => relation.object.surface)).not.toContain("2019.");
  });

  it("refuses a predicate with no lexical content, because a comma between two names is a list", () => {
    // A range and a list both put two arguments beside each other with only punctuation between them. Admitting
    // those was measured to be the only thing that recurred across enough independent sources to promote.
    expect(proseRelations("Delegates included Marda Feln, Alice Renner and Jon Halvik.")
      .map(relation => relation.predicateSurface)).not.toContain(",");
    expect(proseRelations("The Ostry tunnel operated 1997-2001 without incident.")
      .every(relation => relation.predicateSurface.trim().length > 0)).toBe(true);
  });

  it("does not join two arguments across a clause boundary", () => {
    const relations = proseRelations("Marda Feln retired. Alice Renner took over.");

    expect(relations.some(relation =>
      relation.subject.surface === "Marda Feln" && relation.object.surface === "Alice Renner")).toBe(false);
  });

  it("reaches the weak_free_surface channel as opaque induced relations through typed ingestion", () => {
    const projection = project("The compound Xylor-7 decomposes at 417 degrees Celsius.");
    const induced = projection.semanticCandidates.filter(candidate => candidate.kind === "opaque_induced_relation");

    expect(induced.length).toBeGreaterThan(0);
    expect(induced.every(candidate => candidate.channel === "weak_free_surface")).toBe(true);
    expect(induced[0]!.participants.map(participant => participant.value)).toEqual(["Xylor-7", "417 degrees"]);
  });

  it("declares what kind of thing each argument is, so the promotion model has a signature that varies", () => {
    const projection = project("The compound Xylor-7 decomposes at 417 degrees Celsius.");
    const induced = projection.semanticCandidates.filter(candidate => candidate.kind === "opaque_induced_relation");

    expect(induced[0]!.participants.map(participant => participant.valueKind))
      .toEqual(["observable.entity", "observable.value"]);
  });

  it("gives relations with different predicates different identities", () => {
    // One relation seed per relation, not one per argument shape: promotion judges a seed, so collapsing every
    // arity-2 prose relation into one seed made the gate rule on all of them together.
    const projection = project([
      "The compound Xylor-7 decomposes at 417 degrees Celsius.",
      "Marda Feln was born in the city of Halvik."
    ].join(" "));
    const seeds = new Set(projection.semanticCandidates
      .filter(candidate => candidate.kind === "opaque_induced_relation")
      .map(candidate => candidate.relationSeedId));

    expect(seeds.size).toBe(2);
  });

  it("carries the sentence as an anchor so a promoted node can be read back as a proposition", () => {
    const projection = project("The compound Xylor-7 decomposes at 417 degrees Celsius.");
    const induced = projection.semanticCandidates.filter(candidate => candidate.kind === "opaque_induced_relation");
    const anchors = induced[0]!.provenance.anchors.map(anchor => JSON.stringify(anchor));

    expect(anchors.some(anchor => anchor.includes("Xylor-7 decomposes at 417 degrees Celsius."))).toBe(true);
  });

  it("leaves an ingestor's own declared relations alone", () => {
    const sourceId = "source.declared" as SourceId;
    const sourceVersionId = "version.declared" as SourceVersionId;
    const text = "The compound Xylor-7 decomposes at 417 degrees Celsius.";
    const evidence = evidenceFor("fixture://declared", text, sourceId, sourceVersionId);
    const projection = createTypedIngestProjector({ idFactory: ids, hasher }).project({
      sourceId,
      sourceVersionId,
      uri: "fixture://declared",
      mediaType: "text/plain",
      text,
      metadata: toJsonValue({
        weakFreeSurfaceRelations: [{
          participants: [{ value: "declared-left" }, { value: "declared-right" }],
          structure: { arity: 2 },
          support: 0.2
        }]
      }),
      evidence: [evidence],
      observedAt: 100
    });
    const induced = projection.semanticCandidates.filter(candidate => candidate.kind === "opaque_induced_relation");

    expect(induced).toHaveLength(1);
    expect(induced[0]!.participants.map(participant => participant.value))
      .toEqual(["declared-left", "declared-right"]);
  });
});
