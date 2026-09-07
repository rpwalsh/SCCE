// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createSemanticProofSystem,
  createSourceGraphBuilder,
  PROOF_CONTRADICTION_THRESHOLD,
  PROPOSITION_GRAPH_NODE_SCHEMA,
  toJsonValue,
  type EvidenceSpan,
  type GraphNode,
  type LanguageProfile,
  type SourceVersionId
} from "../index.js";

// The seam this pins: atomizeText and the contradiction search over its atoms were both complete and both ran only
// while a turn was in flight, so no proposition ever reached the graph. Two sources disagreeing about one measured
// value is the smallest thing that cannot be answered without propositions surviving that boundary.
describe("propositions cross the graph boundary", () => {
  const clock = createClock({ fixedTime: 100, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "proposition-graph" });
  const builder = createSourceGraphBuilder({ idFactory: ids });
  const proof = createSemanticProofSystem({ hasher });
  const languageProfile = { id: "language.test", scripts: [{ script: "Latn", mass: 1 }] } as unknown as LanguageProfile;

  function spanFor(uri: string, text: string, sourceVersionId: SourceVersionId): EvidenceSpan {
    const contentHash = ids.contentHash(text);
    const byteEnd = Buffer.byteLength(text);
    return {
      id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd, spanHash: contentHash }),
      sourceId: ids.sourceId("proposition-graph", uri),
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
      alpha: 0.9,
      observedAt: 100
    };
  }

  function graphFor(uri: string, text: string, sourceVersionId: string): GraphNode[] {
    return builder.build({
      sourceVersionId: sourceVersionId as SourceVersionId,
      uri,
      mediaType: "text/plain",
      languageProfile,
      evidence: [spanFor(uri, text, sourceVersionId as SourceVersionId)],
      observedAt: 100
    }).nodes;
  }

  function propositionNodes(nodes: readonly GraphNode[]): GraphNode[] {
    return nodes.filter(node => {
      const representation = node.representation;
      return Boolean(representation)
        && typeof representation === "object"
        && !Array.isArray(representation)
        && (representation as Record<string, unknown>).schema === PROPOSITION_GRAPH_NODE_SCHEMA;
    });
  }

  const labA = graphFor("fixture://lab-a", "Xylor-7 decomposes at 417 degrees Celsius.", "version.lab-a");
  const labB = graphFor("fixture://lab-b", "Xylor-7 decomposes at 431 degrees Celsius.", "version.lab-b");
  const stored = [...propositionNodes(labA), ...propositionNodes(labB)];

  it("writes a proposition-bearing graph object for each stated proposition", () => {
    expect(stored).toHaveLength(2);
    expect(stored.every(node => node.evidenceIds.length === 1)).toBe(true);
  });

  it("stores the measured value as a constraint, not as a sentence to be re-read", () => {
    const values = stored.flatMap(node =>
      ((node.representation as Record<string, unknown>).constraints as Array<{ value: { value?: number } }>)
        .map(constraint => constraint.value?.value));

    expect(values).toContain(417);
    expect(values).toContain(431);
  });

  it("recovers each proposition through atomizeGraph, bound to its node and its evidence", () => {
    const atoms = proof.atomizeGraph(stored);

    expect(atoms).toHaveLength(2);
    expect(atoms.every(atom => atom.nodeIds.length === 1)).toBe(true);
    expect(atoms.every(atom => atom.evidenceIds.length === 1)).toBe(true);
    expect(new Set(atoms.map(atom => atom.id)).size).toBe(2);
  });

  it("derives the contradiction between the two recovered propositions above the proof threshold", () => {
    const atoms = proof.atomizeGraph(stored);
    const unified = proof.unify(atoms[0]!, atoms[1]!);

    expect(unified.contradiction).toBeGreaterThan(PROOF_CONTRADICTION_THRESHOLD);
  });

  // Not an answer-generation test: retrieval, selection and realization are the end-to-end benchmark's job.
  // This pins that the proof stage reaches "contradicted" from stored propositions and keeps both sources.
  it("proves the claim is contradicted and carries both source evidences", () => {
    const result = proof.prove({
      claimText: "Xylor-7 decomposes at 417 degrees Celsius.",
      evidence: [],
      nodes: stored
    });

    expect(result.contradiction).toBeGreaterThan(PROOF_CONTRADICTION_THRESHOLD);
    expect(result.counterexamples.length).toBeGreaterThan(0);
    expect(new Set(result.graphAtoms.flatMap(atom => atom.evidenceIds.map(String))).size).toBe(2);
  });

  it("reads a stored proposition back rather than re-parsing its own surface", () => {
    // The stored predicate must be what the atom reports. Re-deriving it at read time would make the answer depend
    // on whichever relation model was in hand rather than on what was established when the proposition was written.
    const [node] = stored;
    const [atom] = proof.atomizeGraph([node!]);

    expect(atom!.predicate).toBe((node!.representation as Record<string, unknown>).predicate);
    expect(atom!.nodeIds).toEqual([node!.id]);
  });

  it("still parses a node that carries only a surface, so nothing that predates the schema goes dark", () => {
    const surfaceOnly: GraphNode = {
      ...stored[0]!,
      id: ids.nodeId(["surface-only", "xylor"]),
      representation: toJsonValue({ text: "Xylor-7 decomposes at 417 degrees Celsius." })
    };
    const atoms = proof.atomizeGraph([surfaceOnly]);

    expect(atoms.length).toBeGreaterThan(0);
  });
});
