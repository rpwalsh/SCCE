// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { describe, expect, it } from "vitest";
import { structuredSemanticCandidates } from "../structured-semantic-candidate.js";
import type { EvidenceId, JsonValue, SourceId, SourceVersionId } from "../types.js";

const ids = ["evidence.a", "evidence.b", "evidence.c"] as EvidenceId[];
const evidence = [
  { id: ids[0]!, text: "Anarchism is a political philosophy and movement." },
  { id: ids[1]!, text: "It developed alongside the Paris Commune of 1871." },
  { id: ids[2]!, text: "Later movements diverged from that origin." }
];

function linkCandidates(links: JsonValue, withEvidence: boolean) {
  return structuredSemanticCandidates({
    sourceId: "source.fixture" as SourceId,
    sourceVersionId: "version.fixture" as SourceVersionId,
    metadata: { links },
    observations: [],
    evidenceIds: ids,
    ...(withEvidence ? { evidence } : {}),
    observedAt: 1
  }).filter(candidate => candidate.kind === "link");
}

describe("a link candidate cites the span that carries its label", () => {
  it("binds to the span whose text contains the label", () => {
    const [link] = linkCandidates([{ target: "Paris Commune", label: "Paris Commune" }], true);
    expect(link).toBeDefined();
    expect(link!.evidenceIds).toEqual([ids[1]]);
  });

  it("falls back to the whole page when no span carries the label", () => {
    const [link] = linkCandidates([{ target: "Mikhail Bakunin", label: "Bakunin" }], true);
    expect([...link!.evidenceIds].sort()).toEqual([...ids].sort());
  });

  it("keeps the page-wide binding when spans are not supplied", () => {
    const [link] = linkCandidates([{ target: "Paris Commune", label: "Paris Commune" }], false);
    expect([...link!.evidenceIds].sort()).toEqual([...ids].sort());
  });
});
