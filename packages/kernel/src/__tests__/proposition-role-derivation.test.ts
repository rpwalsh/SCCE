// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import {
  createClock,
  createHasher,
  createIdFactory,
  createSemanticProofSystem,
  createSourceGraphBuilder,
  PROPOSITION_GRAPH_NODE_SCHEMA,
  toJsonValue,
  type EvidenceSpan,
  type GraphNode,
  type LanguageProfile,
  type SourceVersionId
} from "../index.js";
import { featureSet, symbolizeData } from "../primitives.js";

describe("a stored proposition role carries its value, not its derivations", () => {
  const clock = createClock({ fixedTime: 100, stepMs: 1 });
  const hasher = createHasher();
  const ids = createIdFactory({ clock, hasher, deterministicReplay: true, namespace: "proposition-roles" });
  const builder = createSourceGraphBuilder({ idFactory: ids });
  const proof = createSemanticProofSystem({ hasher });
  const languageProfile = { id: "language.test", scripts: [{ script: "Latn", mass: 1 }] } as unknown as LanguageProfile;

  function spanFor(uri: string, text: string, sourceVersionId: SourceVersionId): EvidenceSpan {
    const contentHash = ids.contentHash(text);
    const byteEnd = Buffer.byteLength(text);
    return {
      id: ids.evidenceId({ sourceVersionId, byteStart: 0, byteEnd, spanHash: contentHash }),
      sourceId: ids.sourceId("proposition-roles", uri),
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

  const text = "Most of the Democratic sheriffs preside over urban counties, and the 2004 census counted 417 of them.";
  const nodes = builder.build({
    sourceVersionId: "version.roles" as SourceVersionId,
    uri: "fixture://roles",
    mediaType: "text/plain",
    languageProfile,
    evidence: [spanFor("fixture://roles", text, "version.roles" as SourceVersionId)],
    observedAt: 100
  }).nodes.filter(node => (node.representation as Record<string, unknown>)?.schema === PROPOSITION_GRAPH_NODE_SCHEMA);

  function storedRoles(node: GraphNode): Array<Record<string, unknown>> {
    return (node.representation as Record<string, unknown>).roles as Array<Record<string, unknown>>;
  }

  it("persists each role without its feature set or normalized form", () => {
    expect(nodes.length).toBeGreaterThan(0);
    const roles = nodes.flatMap(storedRoles);
    expect(roles.length).toBeGreaterThan(0);
    for (const role of roles) {
      expect(typeof role.value).toBe("string");
      expect(role).not.toHaveProperty("features");
      expect(role).not.toHaveProperty("normalized");
    }
  });

  it("rehydrates the identical derivations from the value", () => {
    const atoms = proof.atomizeGraph(nodes);
    expect(atoms.length).toBeGreaterThan(0);
    for (const atom of atoms) {
      expect(atom.roles.length).toBeGreaterThan(0);
      for (const role of atom.roles) {
        expect(role.features).toEqual(featureSet(role.value, 128));
        expect(role.normalized).toBe(symbolizeData(role.value).join(" "));
      }
    }
  });

  it("yields the same atoms as a node written in the older shape with the derivations inline", () => {
    const legacy = nodes.map(node => ({
      ...node,
      representation: toJsonValue({
        ...(node.representation as Record<string, unknown>),
        roles: storedRoles(node).map(role => ({
          ...role,
          normalized: symbolizeData(String(role.value)).join(" "),
          features: featureSet(String(role.value), 128)
        }))
      })
    }));
    expect(proof.atomizeGraph(legacy)).toEqual(proof.atomizeGraph(nodes));
  });
});
