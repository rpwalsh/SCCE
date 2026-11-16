// SCCE. Copyright (c) 2026 Ryan P. Walsh. All rights reserved.
// Proprietary: made available for inspection only. No license granted except by separate written agreement. See LICENSE.
import { expect, it } from "vitest";
import { adoptAdmittedDurableGraphSlice } from "../production-turn-runtime.js";
import { evidenceProofBoundary } from "../proof-boundary.js";
import { sourceBodyAnswersRequest, sourceIdentityAdmissibleEvidenceForRequest } from "../local-evidence-runtime.js";
import type { RuntimeGraphSliceValue } from "../runtime-graph-cache.js";
import type { EvidenceSpan } from "../types.js";

function span(id: string, title: string, text: string): EvidenceSpan {
  const sourceVersionId = `source_version.${id}`;
  return { id: `evidence_span.${id}`, sourceId: `source.${id}`, sourceVersionId, chunkId: `chunk.${id}`,
    contentHash: `sha256_${id}`, mediaType: "text/plain", byteStart: 0, byteEnd: Buffer.byteLength(text), charStart: 0, charEnd: [...text].length,
    text, textPreview: text, languageHints: {}, scriptHints: {}, status: "promoted", alpha: 1, observedAt: 1,
    features: [], trustVector: { forceClass: "direct_evidence" },
    provenance: { title, uri: `fixture://retained/${id}`, sourceVersionId, byteRange: [0, Buffer.byteLength(text)], charRange: [0, [...text].length] }
  } as unknown as EvidenceSpan;
}
function slice(evidence: EvidenceSpan[], semanticFrameBoundEvidenceIds: string[] = []): RuntimeGraphSliceValue {
  return { evidence, semanticFrameBoundEvidenceIds, graph: { nodes: [], edges: [], hyperedges: [], bounded: true,
    query: { evidenceIds: evidence.map(row => row.id), radius: 0, limitNodes: 0, limitEdges: 0 } } };
}
const policy = { sourceCodeEvidenceAllowed: false, sourceCodeEvidenceRequired: false };
const closed = new Set(["when", "did", "cuándo", "the", "a"]);

it.each([
  { id: "dolly", request: "When did Virgin Australia start operating?", title: "dialogue-00001",
    text: "When did Virgin Australia start operating? Virgin Australia commenced services on 31 August 2000 as Virgin Blue." },
  { id: "es", request: "¿Cuándo empezó Aerolínea Nube?", title: "registro-00817",
    text: "¿Cuándo empezó Aerolínea Nube? Aerolínea Nube comenzó sus servicios el 18 de mayo de 2007." }
])("adopts current $id content/semantic-bound evidence despite unrelated resident material and opaque source title", ({ id, request, title, text }) => {
  const unrelated = span("resident", "City Centre", "Buildings provided improved housing conditions. The city centre had fallen into disrepair.");
  const owned = span(id, title, text);
  expect(sourceBodyAnswersRequest(owned, request, closed)).toBe(false);
  const proofBefore = evidenceProofBoundary(owned), resident = slice([unrelated]);
  for (const bound of [[], [String(owned.id)]]) {
    const durable = slice([owned], bound);
    expect(sourceIdentityAdmissibleEvidenceForRequest(request, durable.evidence, new Set(bound), closed).evidence).toEqual([owned]);
    const result = adoptAdmittedDurableGraphSlice({ resident, durable, requestText: request, closedClassWords: closed, evidenceAccessPolicy: policy });
    expect(result).toMatchObject({ adopted: true, residentCount: 1, durableCount: 1, durableAdmitted: 1 });
    expect(result.slice.evidence).toEqual([owned]);
    expect(result.slice.evidence[0]).toBe(owned);
    expect(evidenceProofBoundary(result.slice.evidence[0]!)).toEqual(proofBefore);
  }
});

it("retains valid resident evidence when a durable lookup fails or carries no source-admitted evidence", () => {
  const requestText = "When did Virgin Australia start operating?";
  const owned = span("valid", "Virgin Australia", "Virgin Australia commenced services in 2000."), resident = slice([owned], [String(owned.id)]);
  const unrelated = span("unadmitted", "City Centre", "Gardens and balconies improved housing.");
  for (const durable of [undefined, slice([]), slice([unrelated], ["evidence_span.other_owner"])]) {
    const result = adoptAdmittedDurableGraphSlice({ resident, durable, requestText, closedClassWords: closed, evidenceAccessPolicy: policy });
    expect(result.adopted).toBe(false); expect(result.durableAdmitted).toBe(0);
    expect(result.residentAdmitted).toBe(1); expect(result.slice).toBe(resident);
  }
});

it("enforces the exact allowed source-version owner before adopting even a semantic-bound durable result", () => {
  const requestText = "When did Virgin Australia start operating?";
  const owned = span("valid", "Virgin Australia", "Virgin Australia commenced services in 2000."), resident = slice([owned], [String(owned.id)]);
  const wrongOwner = span("wrong_owner", "dialogue-00001", "Virgin Australia commenced services on 31 August 2000.");
  const result = adoptAdmittedDurableGraphSlice({ resident, durable: slice([wrongOwner], [String(wrongOwner.id)]), requestText,
    closedClassWords: closed, evidenceAccessPolicy: policy, sourceVersionAllowlist: [String(owned.sourceVersionId)] });
  expect(result).toMatchObject({ adopted: false, residentAdmitted: 1, durableCount: 1, durableAdmitted: 0 });
  expect(result.slice).toBe(resident);
});

it("preserves promoted-content, control-corpus and code-access admission despite semantic-frame membership", () => {
  const requestText = "When did Virgin Australia start operating?";
  const owned = span("valid", "Virgin Australia", "Virgin Australia commenced services in 2000."), resident = slice([owned], [String(owned.id)]);
  const control = span("control", "dialogue-00001", requestText);
  const rejected = [
    { ...span("quarantined", "dialogue-00001", requestText), status: "quarantined" },
    { ...span("prior", "dialogue-00001", requestText), trustVector: { forceClass: "learned_language_prior" } },
    { ...control, provenance: { ...(control.provenance as Record<string, import("../types.js").JsonValue>), controlCorpus: "request-control" } },
    { ...span("code", "program", "export function unrelated() { return 0; }"), mediaType: "text/typescript" }
  ] as EvidenceSpan[];
  for (const row of rejected) {
    const result = adoptAdmittedDurableGraphSlice({ resident, durable: slice([row], [String(row.id)]), requestText,
      closedClassWords: closed, evidenceAccessPolicy: policy });
    expect(result.adopted).toBe(false); expect(result.durableAdmitted).toBe(0); expect(result.slice).toBe(resident);
  }
});
